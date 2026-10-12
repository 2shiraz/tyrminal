import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The version shown in the app is the one it is built and bundled with.
import tauriConfig from "./src-tauri/tauri.conf.json" with { type: "json" };

// Installers carry a plain `major.minor.patch` version (MSI accepts nothing else), so a
// pre-release build names its tag here instead (the release workflow sets it, e.g. v0.1.0-beta.2).
// A tag that does not belong to the bundled version fails the build rather than mislabel it.
function displayVersion(): string {
  // Node's `process`, typed locally: this config is checked with the browser types only.
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const tag = env.TYRMINAL_RELEASE_TAG?.trim();
  if (!tag) return tauriConfig.version;
  const match = /^v?(\d+\.\d+\.\d+)(-(?:alpha|beta|rc)\.\d+)?$/.exec(tag);
  if (!match || match[1] !== tauriConfig.version) {
    throw new Error(`TYRMINAL_RELEASE_TAG ${tag} does not match the bundled version ${tauriConfig.version}`);
  }
  return `${match[1]}${match[2] ?? ""}`;
}

// Tauri serves the built assets from disk; the dev server is loopback-only and fixed-port so the
// development CSP allowance can be exact.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(displayVersion()) },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: { target: "es2022", sourcemap: false, outDir: "dist", emptyOutDir: true },
});
