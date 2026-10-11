// Launches the real application (an e2e build) against a throwaway data directory and connects
// to its embedded WebDriver server on a random loopback port chosen for this run.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Session, waitForServer } from "./webdriver.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binaryName = process.platform === "win32" ? "tyrminal.exe" : "tyrminal";
export const appBinary = process.env.TYRMINAL_E2E_BINARY ?? join(root, "target", "e2e", "debug", binaryName);
export const artifactDir = join(root, "docs", "reports", "raw", "native");

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

export function loadLab() {
  const file = process.env.TYRMINAL_LAB ?? join(root, "tests", "ssh-lab", ".run", "lab.json");
  if (!existsSync(file)) throw new Error(`SSH lab is not running (${file}). Run \`pnpm lab:up\` first.`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** A TCP forwarder with a switchable backend: one endpoint that can present either lab server. */
export async function startForwarder(targetPort) {
  const state = { target: targetPort };
  const sockets = new Set();
  const server = net.createServer((inbound) => {
    const outbound = net.connect({ host: "127.0.0.1", port: state.target });
    for (const socket of [inbound, outbound]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    }
    inbound.pipe(outbound).pipe(inbound);
    inbound.on("close", () => outbound.destroy());
    outbound.on("close", () => inbound.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    retarget(port) {
      state.target = port;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

export class App {
  constructor(child, session, dataDir, port) {
    this.child = child;
    this.session = session;
    this.dataDir = dataDir;
    this.port = port;
  }

  /** Starts the application. Reuses `dataDir` when given (to test restarts), else a fresh one. */
  static async launch({ dataDir } = {}) {
    if (!existsSync(appBinary)) {
      throw new Error(`BLOCKED: e2e application binary not found at ${appBinary}. Run \`pnpm build:e2e\`.`);
    }
    const dir = dataDir ?? mkdtempSync(join(tmpdir(), "tyrminal-e2e-"));
    const port = await freePort();
    const child = spawn(appBinary, [], {
      env: { ...process.env, TYRMINAL_DATA_DIR: dir, TAURI_WEBDRIVER_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    try {
      await waitForServer(port);
    } catch (error) {
      child.kill("SIGKILL");
      throw new Error(`${error.message}\napplication output:\n${output}`);
    }
    const session = await Session.create(port);
    try {
      await session.waitForDocument();
    } catch (error) {
      child.kill("SIGKILL");
      throw new Error(`${error.message}\napplication output:\n${output}`);
    }
    const app = new App(child, session, dir, port);
    app.output = () => output;
    return app;
  }

  /** Saves a PNG of the WebView under docs/reports/raw/native (git-ignored). Synthetic data only. */
  async screenshot(name) {
    mkdirSync(artifactDir, { recursive: true });
    const file = join(artifactDir, `${name}.png`);
    writeFileSync(file, await this.session.screenshot());
    return file;
  }

  async quit({ keepData = false } = {}) {
    await this.session.close();
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
    if (!keepData) rmSync(this.dataDir, { recursive: true, force: true });
  }
}
