// Task-owned SSH lab with two modes:
//
//   docker (default where a Docker daemon is reachable): pinned OpenSSH containers.
//   local  (TYRMINAL_LAB_MODE=local, or --local): the host's own OpenSSH sshd, one process per
//          server, bound to loopback on random ports, with host keys, client keys, a password and
//          an sshd_config generated for this run. Used on CI runners without Linux containers
//          (macOS, Windows). It needs root/Administrator to run sshd for dedicated lab accounts
//          (tyrlab, tyrlabnofwd, tyrlabnosess), which it creates; refuse unless
//          TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES=1, so a developer machine is never changed by accident.
//
// Both modes publish only on loopback with random ports and credentials generated for this run.
// `down` removes only resources this lab created: containers labelled tyrminal.lab=1, sshd
// processes listed in .run/pids, the lab accounts, and the lab's own .run directory.
//
//   node scripts/lab.mjs up [--local] | down | status
//
// The lab description is written to tests/ssh-lab/.run/lab.json (git-ignored). Tests read it via
// TYRMINAL_LAB or that default path. Each server entry names either a `container` (docker) or a
// `logFile` (local) holding the sshd VERBOSE log that tests inspect for authentication activity.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const labDir = join(root, "tests", "ssh-lab");
const runDir = join(labDir, ".run");
const LABEL = "tyrminal.lab=1";
const IMAGE = "tyrminal-lab-sshd:alpine3.22-openssh10.0p1";
const SERVERS = ["a", "b"];
const isWindows = process.platform === "win32";
const LOCAL_USERS = { user: "tyrlab", noForwardUser: "tyrlabnofwd", noSessionUser: "tyrlabnosess" };
const DOCKER_USERS = { user: "tyr", noForwardUser: "noforward", noSessionUser: "nosession" };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

function keygen(type, file, { bits, passphrase = "", comment }) {
  const args = ["-q", "-t", type, "-f", file, "-N", passphrase, "-C", comment];
  if (bits) args.push("-b", String(bits));
  run("ssh-keygen", args);
  chmodSync(file, 0o600);
}

function fingerprint(pubFile) {
  return run("ssh-keygen", ["-lf", pubFile, "-E", "sha256"]).split(" ")[1];
}

function waitForBanner(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const retry = () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`sshd on port ${port} did not become ready`));
        else setTimeout(attempt, 150);
      };
      socket.setTimeout(1_000, retry);
      socket.once("error", retry);
      socket.once("data", (d) => {
        socket.destroy();
        if (d.toString().startsWith("SSH-2.0-")) resolve();
        else retry();
      });
    };
    attempt();
  });
}


// ---------- shared ----------

/** Client keys and the password. All are generated here and exist only for this lab run. */
function generateClientMaterial() {
  const keyPassphrase = randomBytes(18).toString("base64url");
  const client = join(runDir, "client");
  keygen("ed25519", join(client, "id_ed25519"), { comment: "tyrminal-lab-ed25519" });
  keygen("ed25519", join(client, "id_ed25519_enc"), { comment: "tyrminal-lab-ed25519-enc", passphrase: keyPassphrase });
  keygen("rsa", join(client, "id_rsa"), { comment: "tyrminal-lab-rsa", bits: 3072 });
  keygen("ecdsa", join(client, "id_ecdsa"), { comment: "tyrminal-lab-ecdsa", bits: 256 });
  // Deliberately not authorized on any server: used for "key rejected" cases.
  keygen("ed25519", join(client, "id_ed25519_unauthorized"), { comment: "tyrminal-lab-unauthorized" });
  const authorized = ["id_ed25519", "id_ed25519_enc", "id_rsa", "id_ecdsa"]
    .map((k) => readFileSync(join(client, `${k}.pub`), "utf8").trim())
    .join("\n");
  return {
    authorized,
    password: `Lab-${randomBytes(18).toString("base64url")}-9`,
    keys: {
      ed25519: join(client, "id_ed25519"),
      ed25519Encrypted: join(client, "id_ed25519_enc"),
      ed25519EncryptedPassphrase: keyPassphrase,
      rsa: join(client, "id_rsa"),
      ecdsa: join(client, "id_ecdsa"),
      unauthorized: join(client, "id_ed25519_unauthorized"),
    },
  };
}

function serverHostKeys(name) {
  const inDir = join(runDir, `server-${name}`);
  mkdirSync(join(inDir, "hostkeys"), { recursive: true, mode: 0o700 });
  keygen("ed25519", join(inDir, "hostkeys", "ssh_host_ed25519_key"), { comment: `lab-${name}` });
  keygen("rsa", join(inDir, "hostkeys", "ssh_host_rsa_key"), { comment: `lab-${name}`, bits: 3072 });
  return inDir;
}

function describeServer(name, inDir, port, extra) {
  return {
    ...extra,
    host: "127.0.0.1",
    port,
    hostKeyEd25519: readFileSync(join(inDir, "hostkeys", "ssh_host_ed25519_key.pub"), "utf8").trim().split(" ").slice(0, 2).join(" "),
    hostKeyEd25519Fingerprint: fingerprint(join(inDir, "hostkeys", "ssh_host_ed25519_key.pub")),
    hostKeyRsaFingerprint: fingerprint(join(inDir, "hostkeys", "ssh_host_rsa_key.pub")),
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function writeLab(lab) {
  writeFileSync(join(runDir, "lab.json"), `${JSON.stringify(lab, null, 2)}\n`, { mode: 0o600 });
  for (const [name, s] of Object.entries(lab.servers)) {
    console.log(`lab server ${name}: 127.0.0.1:${s.port} ${s.hostKeyEd25519Fingerprint}`);
  }
  console.log(`lab up (${lab.mode}, ${lab.serverVersion}): ${join(runDir, "lab.json")}`);
}

// ---------- docker mode ----------

function dockerAvailable() {
  return run("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFail: true }) !== "";
}

function dockerDown() {
  const ids = run("docker", ["ps", "-aq", "--filter", `label=${LABEL}`], { allowFail: true });
  if (ids) run("docker", ["rm", "-f", ...ids.split("\n")]);
}

async function dockerUp() {
  if (!dockerAvailable()) {
    throw new Error("BLOCKED: Docker daemon is not reachable; use TYRMINAL_LAB_MODE=local for the container-free lab.");
  }
  run("docker", [
    "build", "-q", "-t", IMAGE,
    "--build-arg", `REGISTRY=${process.env.TYRMINAL_LAB_REGISTRY ?? "docker.io/library"}`,
    labDir,
  ]);
  const material = generateClientMaterial();
  const lab = {
    createdAt: new Date().toISOString(),
    mode: "docker",
    image: IMAGE,
    serverVersion: "OpenSSH 10.0p1 (Alpine 3.22, openssh-server=10.0_p1-r10)",
    ...DOCKER_USERS,
    password: material.password,
    keys: material.keys,
    servers: {},
  };
  for (const name of SERVERS) {
    const inDir = serverHostKeys(name);
    writeFileSync(join(inDir, "authorized_keys"), `${material.authorized}\n`, { mode: 0o644 });
    writeFileSync(join(inDir, "password"), material.password, { mode: 0o600 });
    const container = `tyrminal-lab-${name}`;
    run("docker", [
      "run", "-d", "--name", container, "--label", LABEL,
      "-p", "127.0.0.1::22",
      "-v", `${inDir}:/lab-in:ro`,
      "--memory", "256m", "--pids-limit", "512",
      IMAGE,
    ]);
    const port = Number(run("docker", ["port", container, "22/tcp"]).split("\n")[0].split(":").pop());
    await waitForBanner(port);
    lab.servers[name] = describeServer(name, inDir, port, { container });
  }
  writeLab(lab);
}

// ---------- local mode ----------

const isRoot = () => !isWindows && userInfo().uid === 0;

/** Runs a command with root rights: directly when root, else through non-interactive sudo. */
function privileged(cmd, args, opts = {}) {
  if (isWindows || isRoot()) return run(cmd, args, opts);
  return run("sudo", ["-n", cmd, ...args], opts);
}

function powershell(script, opts = {}) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], opts);
}

function findSshd() {
  const candidates = isWindows
    ? [process.env.TYRMINAL_LAB_SSHD, "C:\\Windows\\System32\\OpenSSH\\sshd.exe", "C:\\Program Files\\OpenSSH\\sshd.exe", "C:\\Program Files\\OpenSSH-Win64\\sshd.exe"]
    : [process.env.TYRMINAL_LAB_SSHD, "/usr/sbin/sshd", "/usr/local/sbin/sshd", "/opt/homebrew/sbin/sshd"];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error("BLOCKED: no OpenSSH sshd found for the local lab (set TYRMINAL_LAB_SSHD).");
  return found;
}

/** "OpenSSH_9.6p1 Ubuntu-3ubuntu13.19, OpenSSL ..." from `sshd -V` (prints to stderr). */
function sshdVersion(sshd) {
  const r = spawnSync(sshd, ["-V"], { encoding: "utf8" });
  const text = `${r.stdout}${r.stderr}`;
  const m = /OpenSSH_for_Windows_[\w.]+|OpenSSH_[\w.]+[^,\n]*/.exec(text);
  return m ? m[0].trim() : "unknown OpenSSH";
}

function versionAtLeast(version, major, minor) {
  const m = /OpenSSH(?:_for_Windows)?_(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
}

function localUserExists(name) {
  if (isWindows) return powershell(`if (Get-LocalUser -Name '${name}' -ErrorAction SilentlyContinue) { 'yes' }`, { allowFail: true }) === "yes";
  return spawnSync("id", ["-u", name]).status === 0;
}

/** Creates (or resets) a lab account. The password is read from a file, never passed in argv. */
function ensureLocalUser(name, passwordFile) {
  if (isWindows) {
    powershell(
      `$p = (Get-Content -Raw -LiteralPath '${passwordFile}').Trim() | ConvertTo-SecureString -AsPlainText -Force; ` +
        `if (Get-LocalUser -Name '${name}' -ErrorAction SilentlyContinue) { Set-LocalUser -Name '${name}' -Password $p } ` +
        `else { New-LocalUser -Name '${name}' -Password $p -PasswordNeverExpires -AccountNeverExpires -Description 'Tyrminal SSH lab (disposable)' | Out-Null }`,
    );
    return;
  }
  const password = readFileSync(passwordFile, "utf8");
  if (process.platform === "darwin") {
    if (!localUserExists(name)) {
      // dsimport reads the record, including the password, from a file.
      const uid = 4600 + Object.values(LOCAL_USERS).indexOf(name);
      const record = join(runDir, `user-${name}.dsimport`);
      writeFileSync(
        record,
        `0x0A 0x5C 0x3A 0x2C dsRecTypeStandard:Users 7 dsAttrTypeStandard:RecordName dsAttrTypeStandard:Password dsAttrTypeStandard:UniqueID dsAttrTypeStandard:PrimaryGroupID dsAttrTypeStandard:NFSHomeDirectory dsAttrTypeStandard:UserShell dsAttrTypeStandard:RealName\n` +
          `${name}:${password}:${uid}:20:/Users/${name}:/bin/sh:Tyrminal SSH lab\n`,
        { mode: 0o600 },
      );
      privileged("dsimport", [record, "/Local/Default", "O"]);
      rmSync(record);
      privileged("mkdir", ["-p", `/Users/${name}`]);
      privileged("chown", [`${uid}:20`, `/Users/${name}`]);
    }
    return;
  }
  if (!localUserExists(name)) privileged("useradd", ["--create-home", "--shell", "/bin/sh", "--comment", "Tyrminal SSH lab", name]);
  const r = spawnSync(isRoot() ? "chpasswd" : "sudo", isRoot() ? [] : ["-n", "chpasswd"], { input: `${name}:${password}\n`, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`chpasswd failed for ${name}: ${r.stderr}`);
}

function removeLocalUser(name) {
  if (!localUserExists(name)) return;
  if (isWindows) powershell(`Remove-LocalUser -Name '${name}'`, { allowFail: true });
  else if (process.platform === "darwin") {
    privileged("dscl", [".", "-delete", `/Users/${name}`], { allowFail: true });
    privileged("rm", ["-rf", `/Users/${name}`], { allowFail: true });
  } else privileged("userdel", ["--remove", name], { allowFail: true });
}

const toConfigPath = (p) => (isWindows ? p.replaceAll("\\", "/") : p);

function sshdConfig({ port, inDir, version }) {
  const lines = [
    "# Tyrminal local lab sshd (generated per run by scripts/lab.mjs). Never use outside tests.",
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    "ListenAddress ::1",
    `HostKey ${toConfigPath(join(inDir, "hostkeys", "ssh_host_ed25519_key"))}`,
    `HostKey ${toConfigPath(join(inDir, "hostkeys", "ssh_host_rsa_key"))}`,
    "PermitRootLogin no",
    `AllowUsers ${Object.values(LOCAL_USERS).join(" ")}`,
    "PasswordAuthentication yes",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    `AuthorizedKeysFile ${toConfigPath(join(inDir, "authorized_keys"))}`,
    // Lab only: the generated files live in the checkout, owned by the CI user rather than the
    // lab accounts, so the ownership walk would refuse them. Never copy this to a real server.
    "StrictModes no",
    "MaxAuthTries 6",
    "MaxStartups 200:30:400",
    "MaxSessions 64",
    "LoginGraceTime 30",
    "AllowTcpForwarding yes",
    "GatewayPorts no",
    "X11Forwarding no",
    "AllowAgentForwarding no",
    "PermitUserEnvironment no",
    "AcceptEnv TYR_*",
    "PrintMotd no",
    "Subsystem sftp internal-sftp",
    "LogLevel VERBOSE",
  ];
  if (!isWindows) lines.push(`UsePAM ${process.platform === "darwin" ? "yes" : "no"}`);
  // Lab only, as in the container image: all clients share one source address and the suite
  // deliberately fails authentication. The option exists from OpenSSH 9.8.
  if (versionAtLeast(version, 9, 8)) lines.push("PerSourcePenalties no");
  lines.push(
    `Match User ${LOCAL_USERS.noForwardUser}`,
    "    AllowTcpForwarding no",
    "    PermitOpen none",
    `Match User ${LOCAL_USERS.noSessionUser}`,
    "    MaxSessions 0",
  );
  return `${lines.join("\n")}\n`;
}

function localDown() {
  const pidsFile = join(runDir, "pids.json");
  if (existsSync(pidsFile)) {
    for (const pid of JSON.parse(readFileSync(pidsFile, "utf8"))) privileged("kill", [String(pid)], { allowFail: true });
  }
  const servicesFile = join(runDir, "services.json");
  if (existsSync(servicesFile)) {
    for (const service of JSON.parse(readFileSync(servicesFile, "utf8"))) {
      run("sc.exe", ["stop", service], { allowFail: true });
      run("sc.exe", ["delete", service], { allowFail: true });
    }
  }
  const usersFile = join(runDir, "users.json");
  if (existsSync(usersFile)) for (const name of JSON.parse(readFileSync(usersFile, "utf8"))) removeLocalUser(name);
}

/**
 * Win32-OpenSSH needs SYSTEM rights to log a user on with a public key (S4U), so on Windows each
 * lab server runs as a temporary demand-start service, and the lab files are restricted to SYSTEM
 * and Administrators as sshd requires for host keys.
 */
function startWindowsService(name, sshd, config, logFile) {
  const service = `tyrminal-lab-${name}`;
  run("sc.exe", ["create", service, `binPath=`, `"${sshd}" -f "${config}" -E "${logFile}"`, "start=", "demand"]);
  run("sc.exe", ["start", service]);
  return service;
}

function restrictWindowsAcl(path) {
  run("icacls", [path, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/T", "/Q"]);
}

async function localUp() {
  if (process.env.TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES !== "1") {
    throw new Error(
      "The local lab creates disposable accounts and runs sshd with root/Administrator rights.\n" +
        "Set TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES=1 to allow it (CI runners and disposable machines only).",
    );
  }
  const sshd = findSshd();
  const version = sshdVersion(sshd);
  const material = generateClientMaterial();
  const passwordFile = join(runDir, "password");
  writeFileSync(passwordFile, material.password, { mode: 0o600 });
  writeFileSync(join(runDir, "users.json"), JSON.stringify(Object.values(LOCAL_USERS)));
  for (const name of Object.values(LOCAL_USERS)) ensureLocalUser(name, passwordFile);
  if (process.platform === "linux") privileged("mkdir", ["-p", "/run/sshd"]);
  // Directories on the path to the lab files must be traversable by sshd's per-user checks.
  if (!isWindows) chmodSync(runDir, 0o711);

  const lab = {
    createdAt: new Date().toISOString(),
    mode: "local",
    serverVersion: version,
    ...LOCAL_USERS,
    password: material.password,
    keys: material.keys,
    servers: {},
  };
  const pids = [];
  const services = [];
  for (const name of SERVERS) {
    const inDir = serverHostKeys(name);
    if (!isWindows) chmodSync(inDir, 0o711);
    writeFileSync(join(inDir, "authorized_keys"), `${material.authorized}\n`, { mode: 0o644 });
    const port = await freePort();
    const config = join(inDir, "sshd_config");
    writeFileSync(config, sshdConfig({ port, inDir, version }), { mode: 0o644 });
    const logFile = join(inDir, "sshd.log");
    writeFileSync(logFile, "", { mode: 0o644 });
    if (isWindows) {
      restrictWindowsAcl(join(inDir, "hostkeys"));
      run(sshd, ["-t", "-f", config]);
      services.push(startWindowsService(name, sshd, config, logFile));
      writeFileSync(join(runDir, "services.json"), JSON.stringify(services));
      await waitForBanner(port);
      lab.servers[name] = describeServer(name, inDir, port, { logFile, service: services.at(-1) });
      continue;
    }
    privileged(sshd, ["-t", "-f", config]);
    // -D keeps sshd in the foreground of a detached child so its PID is known.
    const args = ["-D", "-f", config, "-E", logFile];
    const child = isRoot() ? spawn(sshd, args, { detached: true, stdio: "ignore" }) : spawn("sudo", ["-n", sshd, ...args], { detached: true, stdio: "ignore" });
    child.unref();
    await waitForBanner(port);
    const pid = isRoot()
      ? child.pid
      : Number(run("pgrep", ["-f", `${sshd} -D -f ${config}`]).split("\n").map(Number).sort((x, y) => y - x)[0]);
    pids.push(pid);
    writeFileSync(join(runDir, "pids.json"), JSON.stringify(pids));
    lab.servers[name] = describeServer(name, inDir, port, { logFile, pid });
  }
  writeLab(lab);
}

// ---------- commands ----------

function wantsLocal() {
  if (process.argv.includes("--local")) return true;
  if (process.env.TYRMINAL_LAB_MODE) return process.env.TYRMINAL_LAB_MODE === "local";
  return false;
}

function down() {
  localDown();
  if (dockerAvailable()) dockerDown();
  rmSync(runDir, { recursive: true, force: true });
  console.log("lab down");
}

async function up() {
  down();
  mkdirSync(join(runDir, "client"), { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  if (wantsLocal()) await localUp();
  else await dockerUp();
}

function status() {
  const file = join(runDir, "lab.json");
  if (!existsSync(file)) {
    console.log("lab is not running (no lab.json)");
    process.exit(1);
  }
  const lab = JSON.parse(readFileSync(file, "utf8"));
  for (const [name, s] of Object.entries(lab.servers)) {
    const state = s.container
      ? run("docker", ["inspect", "-f", "{{.State.Status}}", s.container], { allowFail: true }) || "missing"
      : s.service ?? `pid ${s.pid}`;
    console.log(`${name}: 127.0.0.1:${s.port} ${lab.mode} ${state}`);
  }
}

const command = process.argv[2];
try {
  if (command === "up") await up();
  else if (command === "down") down();
  else if (command === "status") status();
  else {
    console.error("usage: lab.mjs up [--local] | down | status");
    process.exit(2);
  }
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}
