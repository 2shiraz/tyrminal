#!/usr/bin/env node
// Task-owned SSH lab: pinned OpenSSH containers published on loopback with random ports and
// credentials generated for this run. `down` removes only resources labelled tyrminal.lab=1 and the
// lab's own .run directory.
//
//   node scripts/lab.mjs up | down | status
//
// Lab description is written to tests/ssh-lab/.run/lab.json (git-ignored). Tests read it via
// TYRMINAL_LAB or that default path.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function down() {
  const ids = run("docker", ["ps", "-aq", "--filter", `label=${LABEL}`], { allowFail: true });
  if (ids) run("docker", ["rm", "-f", ...ids.split("\n")]);
  rmSync(runDir, { recursive: true, force: true });
  console.log("lab down");
}

async function up() {
  if (run("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFail: true }) === "") {
    throw new Error("BLOCKED: Docker daemon is not reachable; the pinned OpenSSH lab cannot start.");
  }
  down();
  mkdirSync(join(runDir, "client"), { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);

  run("docker", ["build", "-q", "-t", IMAGE, labDir]);

  // Client keys. All are generated here and exist only for this lab run.
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
  const password = randomBytes(18).toString("base64url");

  const lab = {
    createdAt: new Date().toISOString(),
    image: IMAGE,
    user: "tyr",
    noForwardUser: "noforward",
    password,
    keys: {
      ed25519: join(client, "id_ed25519"),
      ed25519Encrypted: join(client, "id_ed25519_enc"),
      ed25519EncryptedPassphrase: keyPassphrase,
      rsa: join(client, "id_rsa"),
      ecdsa: join(client, "id_ecdsa"),
      unauthorized: join(client, "id_ed25519_unauthorized"),
    },
    servers: {},
  };

  for (const name of SERVERS) {
    const inDir = join(runDir, `server-${name}`);
    mkdirSync(join(inDir, "hostkeys"), { recursive: true, mode: 0o700 });
    keygen("ed25519", join(inDir, "hostkeys", "ssh_host_ed25519_key"), { comment: `lab-${name}` });
    keygen("rsa", join(inDir, "hostkeys", "ssh_host_rsa_key"), { comment: `lab-${name}`, bits: 3072 });
    writeFileSync(join(inDir, "authorized_keys"), `${authorized}\n`, { mode: 0o644 });
    writeFileSync(join(inDir, "password"), password, { mode: 0o600 });

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
    lab.servers[name] = {
      container,
      host: "127.0.0.1",
      port,
      hostKeyEd25519: readFileSync(join(inDir, "hostkeys", "ssh_host_ed25519_key.pub"), "utf8").trim().split(" ").slice(0, 2).join(" "),
      hostKeyEd25519Fingerprint: fingerprint(join(inDir, "hostkeys", "ssh_host_ed25519_key.pub")),
      hostKeyRsaFingerprint: fingerprint(join(inDir, "hostkeys", "ssh_host_rsa_key.pub")),
    };
  }

  writeFileSync(join(runDir, "lab.json"), `${JSON.stringify(lab, null, 2)}\n`, { mode: 0o600 });
  for (const [name, s] of Object.entries(lab.servers)) {
    console.log(`lab server ${name}: 127.0.0.1:${s.port} ${s.hostKeyEd25519Fingerprint}`);
  }
  console.log(`lab up: ${join(runDir, "lab.json")}`);
}

function status() {
  const file = join(runDir, "lab.json");
  if (!existsSync(file)) {
    console.log("lab is not running (no lab.json)");
    process.exit(1);
  }
  const lab = JSON.parse(readFileSync(file, "utf8"));
  for (const [name, s] of Object.entries(lab.servers)) {
    const state = run("docker", ["inspect", "-f", "{{.State.Status}}", s.container], { allowFail: true }) || "missing";
    console.log(`${name}: 127.0.0.1:${s.port} ${state}`);
  }
}

const command = process.argv[2];
try {
  if (command === "up") await up();
  else if (command === "down") down();
  else if (command === "status") status();
  else {
    console.error("usage: lab.mjs up|down|status");
    process.exit(2);
  }
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}
