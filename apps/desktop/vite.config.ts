import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri serves the built assets from disk; the dev server is loopback-only and fixed-port so the
// development CSP allowance can be exact.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: { target: "es2022", sourcemap: false, outDir: "dist", emptyOutDir: true },
});
