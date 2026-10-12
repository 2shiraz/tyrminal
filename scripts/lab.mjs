// Task-owned SSH lab with two modes:
//
//   docker (default where a Docker daemon is reachable): pinned OpenSSH containers.
//   wsl    (Windows, TYRMINAL_LAB_MODE=wsl): runs the local mode inside a WSL distribution
//          (TYRMINAL_LAB_WSL_DISTRO, default Debian-12), so Windows clients are tested against
//          the same Linux OpenSSH server, PAM and full-screen applications as elsewhere. WSL 1
//          shares the Windows loopback interface; lab.json records Windows paths.
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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** Full-screen applications the terminal tests drive on the lab server. */
const TUI_APPS = ["vim", "nano", "tmux", "htop", "mc"];
const DOCKER_USERS = { user: "tyr", noForwardUser: "noforward", noSessionUser: "nosession" };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) {
    // A missing binary (e.g. no Docker on a container-free host) is "failed", not fatal, when allowed.
    if (opts.allowFail) return "";
    throw new Error(`${cmd}: ${r.error.message}`);
  }
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

/**
 * Resolves once something on `port` sends an SSH identification string. Every way an attempt can
 * end (error, timeout, a close without data — Docker's port proxy accepts before sshd is up) leads
 * to exactly one retry, so the wait always settles.
 */
function waitForBanner(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      let done = false;
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = (ok) => {
        if (done) return;
        done = true;
        socket.destroy();
        if (ok) resolve();
        else if (Date.now() > deadline) reject(new Error(`sshd on port ${port} did not become ready`));
        else setTimeout(attempt, 150);
      };
      socket.setTimeout(1_000, () => finish(false));
      socket.once("error", () => finish(false));
      socket.once("close", () => finish(false));
      socket.once("data", (d) => finish(d.toString().startsWith("SSH-2.0-")));
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
  // User certificates (KEY-07). The key itself is in no authorized_keys file: only a certificate
  // from the trusted lab CA lets it sign in. Principals cover the container and local lab users.
  keygen("ed25519", join(client, "user_ca"), { comment: "tyrminal-lab-user-ca" });
  keygen("ed25519", join(client, "untrusted_ca"), { comment: "tyrminal-lab-untrusted-ca" });
  keygen("ed25519", join(client, "id_ed25519_certified"), { comment: "tyrminal-lab-certified" });
  const certify = (ca, out, principals, validity) => {
    copyFileSync(join(client, "id_ed25519_certified.pub"), join(client, `${out}.pub`));
    run("ssh-keygen", ["-q", "-s", join(client, ca), "-I", out, "-n", principals, "-V", validity, join(client, `${out}.pub`)]);
    return join(client, `${out}-cert.pub`);
  };
  const principals = [...new Set([...Object.values(DOCKER_USERS), ...Object.values(LOCAL_USERS)])].filter((u) => typeof u === "string" && !u.includes("/")).join(",");
  const certificates = {
    valid: certify("user_ca", "cert_valid", principals, "-5m:+1d"),
    expired: certify("user_ca", "cert_expired", principals, "20000101:20000102"),
    wrongPrincipal: certify("user_ca", "cert_wrong_principal", "someone-else", "-5m:+1d"),
    untrustedCa: certify("untrusted_ca", "cert_untrusted_ca", principals, "-5m:+1d"),
  };
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
      certified: join(client, "id_ed25519_certified"),
    },
    certificates,
    trustedUserCa: readFileSync(join(client, "user_ca.pub"), "utf8").trim(),
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

/** Inside WSL for a Windows client: absolute lab paths are rewritten to Windows paths. */
function forHost(value) {
  if (process.env.TYRMINAL_LAB_WINDOWS_PATHS !== "1") return value;
  if (typeof value === "string" && value.startsWith("/") && existsSync(value)) return run("wslpath", ["-w", value]);
  if (Array.isArray(value)) return value.map(forHost);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forHost(v)]));
  return value;
}

function writeLab(lab) {
  // Only files the client side opens are translated; server-side program paths stay as they are.
  const out = { ...lab, keys: forHost(lab.keys), servers: forHost(lab.servers) };
  writeFileSync(join(runDir, "lab.json"), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
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
    // The operating system the lab servers run (process.platform naming).
    serverOs: "linux",
    serverVersion: "OpenSSH 10.0p1 (Alpine 3.22, openssh-server=10.0_p1-r10)",
    ...DOCKER_USERS,
    password: material.password,
    keys: material.keys,
    certificates: material.certificates,
    servers: {},
  };
  // Windows OpenSSH has no PAM, so it cannot serve keyboard-interactive; tests that need the
  // "kbd" server report BLOCKED there.
  for (const name of isWindows ? SERVERS : [...SERVERS, "kbd"]) {
    const inDir = serverHostKeys(name);
    writeFileSync(join(inDir, "authorized_keys"), `${material.authorized}\n`, { mode: 0o644 });
    writeFileSync(join(inDir, "trusted_user_ca"), `${material.trustedUserCa}\n`, { mode: 0o644 });
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
  lab.apps = Object.fromEntries(TUI_APPS.map((a) => [a, true]));
  lab.appPaths = Object.fromEntries(TUI_APPS.map((a) => [a, `/usr/bin/${a}`]));
  lab.colorsScript = "tyr-colors";
  lab.serverPackages = run("docker", ["exec", "tyrminal-lab-a", "apk", "info", "-v", ...TUI_APPS]).split("\n").filter(Boolean);
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
    // When Remote Login is limited to listed users, macOS admits only members of this group
    // (checked in PAM's account phase); a lab account outside it is disconnected after auth.
    if (run("dscl", [".", "-read", "/Groups/com.apple.access_ssh"], { allowFail: true })) {
      privileged("dseditgroup", ["-o", "edit", "-a", name, "-t", "user", "com.apple.access_ssh"]);
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
    privileged("dseditgroup", ["-o", "edit", "-d", name, "-t", "user", "com.apple.access_ssh"], { allowFail: true });
    privileged("dscl", [".", "-delete", `/Users/${name}`], { allowFail: true });
    privileged("rm", ["-rf", `/Users/${name}`], { allowFail: true });
  } else privileged("userdel", ["--remove", name], { allowFail: true });
}

const toConfigPath = (p) => (isWindows ? p.replaceAll("\\", "/") : p);

function sshdConfig({ port, inDir, authFile, caFile, version, kbdOnly = false }) {
  const lines = [
    "# Tyrminal local lab sshd (generated per run by scripts/lab.mjs). Never use outside tests.",
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    "ListenAddress ::1",
    `HostKey ${toConfigPath(join(inDir, "hostkeys", "ssh_host_ed25519_key"))}`,
    `HostKey ${toConfigPath(join(inDir, "hostkeys", "ssh_host_rsa_key"))}`,
    "PermitRootLogin no",
    `AllowUsers ${Object.values(LOCAL_USERS).join(" ")}`,
    // The "kbd" server takes keyboard-interactive only (answered through PAM), like servers that
    // use one-time codes; the others take passwords and keys.
    `PasswordAuthentication ${kbdOnly ? "no" : "yes"}`,
    `KbdInteractiveAuthentication ${kbdOnly ? "yes" : "no"}`,
    `PubkeyAuthentication ${kbdOnly ? "no" : "yes"}`,
    // The lab's own file, and the user's own one, so a key the app installs (KEY deploy) is the
    // key that then signs in.
    `AuthorizedKeysFile ${toConfigPath(authFile ?? join(inDir, "authorized_keys"))} .ssh/authorized_keys`,
    `TrustedUserCAKeys ${toConfigPath(caFile ?? join(inDir, "trusted_user_ca"))}`,
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
    "AllowAgentForwarding yes",
    "PermitUserEnvironment no",
    "AcceptEnv TYR_*",
    "PrintMotd no",
    "Subsystem sftp internal-sftp",
    "LogLevel VERBOSE",
  ];
  if (!isWindows) lines.push(`UsePAM ${process.platform === "darwin" || kbdOnly ? "yes" : "no"}`);
  // macOS: sessions get the compiled-in PATH; add Homebrew so the lab applications are found.
  if (process.platform === "darwin") lines.push("SetEnv PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
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
  const authDirFile = join(runDir, "authdir");
  if (existsSync(authDirFile)) {
    const dir = readFileSync(authDirFile, "utf8").trim();
    if (/^\/tmp\/tyrminal-lab-[A-Za-z0-9]+$/.test(dir)) rmSync(dir, { recursive: true, force: true });
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
  // Win32-OpenSSH loads a host key only if SYSTEM or Administrators owns it. Change the owner
  // first, while this (admin) process still has an entry on the files.
  run("icacls", [path, "/setowner", "*S-1-5-32-544", "/T", "/Q"]);
  run("icacls", [path, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/T", "/Q"]);
}

/**
 * sshd reads authorized_keys as the lab account, which cannot traverse a CI user's home
 * directory (mode 750 on GitHub's Linux runners). Unix labs keep those files in a directory
 * under /tmp that every account can traverse; `down` removes it.
 */
function authorizedKeysDir() {
  if (isWindows) return null;
  const dir = mkdtempSync("/tmp/tyrminal-lab-");
  chmodSync(dir, 0o755);
  writeFileSync(join(runDir, "authdir"), dir);
  return dir;
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
  // WSL cannot set a login uid, and Ubuntu's sshd PAM stack requires it, which would end every
  // PAM session (the keyboard-interactive server). Only inside WSL, make that one module optional.
  if (process.platform === "linux" && /microsoft/i.test(readFileSync("/proc/version", "utf8"))) {
    const pam = "/etc/pam.d/sshd";
    if (existsSync(pam)) {
      writeFileSync(pam, readFileSync(pam, "utf8").replace(/^session\s+required\s+pam_loginuid\.so/m, "session    optional     pam_loginuid.so"));
    }
  }
  // Directories on the path to the lab files must be traversable by sshd's per-user checks.
  if (!isWindows) chmodSync(runDir, 0o711);

  // The lab server is this machine: which full-screen applications it can offer.
  // Absolute paths are recorded and used by the tests: a login shell may build its own PATH
  // (macOS path_helper puts /usr/bin first), which would run a different program than detected.
  const which = (app) => {
    const r = isWindows ? spawnSync("bash", ["-lc", `command -v ${app}`], { encoding: "utf8" }) : spawnSync("sh", ["-c", `command -v ${app}`], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() || null : null;
  };
  const appPaths = Object.fromEntries(TUI_APPS.map((a) => [a, which(a)]));
  const apps = Object.fromEntries(TUI_APPS.map((a) => [a, appPaths[a] !== null]));
  const versions = TUI_APPS.filter((a) => apps[a]).map((a) => {
    const flag = a === "tmux" ? "-V" : "--version";
    const r = spawnSync(isWindows ? "bash" : "sh", [isWindows ? "-lc" : "-c", `${appPaths[a]} ${flag} 2>&1 | head -n 1`], { encoding: "utf8" });
    return `${a}: ${(r.stdout || "").trim()}`;
  });
  // The colors fixture must be readable by the lab accounts, so it goes to a shared location.
  const colorsTarget = isWindows ? null : "/usr/local/bin/tyr-colors";
  if (colorsTarget) privileged("install", ["-m", "0755", join(labDir, "tyr-colors.sh"), colorsTarget]);

  const lab = {
    createdAt: new Date().toISOString(),
    mode: "local",
    // The lab server is this machine (WSL's Linux on Windows CI): process.platform naming.
    serverOs: process.platform,
    apps,
    appPaths,
    serverPackages: versions,
    colorsScript: colorsTarget ? "tyr-colors" : null,
    serverVersion: version,
    ...LOCAL_USERS,
    password: material.password,
    keys: material.keys,
    certificates: material.certificates,
    servers: {},
  };
  const pids = [];
  const services = [];
  const authDir = authorizedKeysDir();
  // Windows OpenSSH has no PAM, so it cannot serve keyboard-interactive; tests that need the
  // "kbd" server report BLOCKED there.
  for (const name of isWindows ? SERVERS : [...SERVERS, "kbd"]) {
    const inDir = serverHostKeys(name);
    if (!isWindows) chmodSync(inDir, 0o711);
    writeFileSync(join(inDir, "authorized_keys"), `${material.authorized}\n`, { mode: 0o644 });
    writeFileSync(join(inDir, "trusted_user_ca"), `${material.trustedUserCa}\n`, { mode: 0o644 });
    let authFile = null;
    let caFile = null;
    if (authDir) {
      mkdirSync(join(authDir, name), { mode: 0o755 });
      chmodSync(join(authDir, name), 0o755);
      authFile = join(authDir, name, "authorized_keys");
      writeFileSync(authFile, `${material.authorized}\n`, { mode: 0o644 });
      chmodSync(authFile, 0o644);
      caFile = join(authDir, name, "trusted_user_ca");
      writeFileSync(caFile, `${material.trustedUserCa}\n`, { mode: 0o644 });
      chmodSync(caFile, 0o644);
    }
    const port = await freePort();
    const config = join(inDir, "sshd_config");
    writeFileSync(config, sshdConfig({ port, inDir, authFile, caFile, version, kbdOnly: name === "kbd" }), { mode: 0o644 });
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

/** Windows host, WSL lab: run this same script inside the distribution, as root, in local mode. */
function delegateToWsl() {
  if (process.env.TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES !== "1") {
    throw new Error("The WSL lab creates accounts and runs sshd in the WSL distribution. Set TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES=1 (CI runners only).");
  }
  const distro = process.env.TYRMINAL_LAB_WSL_DISTRO || "Debian-12";
  const self = run("wsl.exe", ["-d", distro, "-u", "root", "--", "wslpath", "-a", fileURLToPath(import.meta.url).replaceAll("\\", "/")]);
  // Inside the distribution: the official Node build at /opt/node when it is installed (CI;
  // Debian's packaged node does not execute under WSL 1), otherwise `node` from PATH. Checked
  // here rather than passed through the environment, because Git Bash rewrites POSIX-looking
  // environment values into Windows paths.
  const officialNode = "/opt/node/bin/node";
  const node = spawnSync("wsl.exe", ["-d", distro, "-u", "root", "-e", "test", "-x", officialNode]).status === 0 ? officialNode : "node";
  // -e runs the program directly, without a login shell re-parsing the arguments.
  const r = spawnSync(
    "wsl.exe",
    ["-d", distro, "-u", "root", "-e", "env", "TYRMINAL_LAB_MODE=local", "TYRMINAL_LAB_ALLOW_SYSTEM_CHANGES=1", "TYRMINAL_LAB_WINDOWS_PATHS=1", node, self, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}

if (isWindows && process.env.TYRMINAL_LAB_MODE === "wsl") delegateToWsl();

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
