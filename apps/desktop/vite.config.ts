import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The version shown in Settings is the one the app is built and bundled with.
import tauriConfig from "./src-tauri/tauri.conf.json" with { type: "json" };

// Tauri serves the built assets from disk; the dev server is loopback-only and fixed-port so the
// development CSP allowance can be exact.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(tauriConfig.version) },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: { target: "es2022", sourcemap: false, outDir: "dist", emptyOutDir: true },
});
