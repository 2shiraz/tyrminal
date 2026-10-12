// Browser UI tests: the production frontend build served by `vite preview`, driven in Chromium,
// with the test-only mock backend (mock-backend.js). These cover layout, keyboard flows,
// accessibility behavior and visual regressions. They never count as native verification.
import { defineConfig } from "@playwright/test";

// TYR_UI_PORT lets parallel runs (several worktrees on one machine) each serve their own build:
// with a shared port, `reuseExistingServer` would silently test another checkout's frontend.
const port = Number(process.env.TYR_UI_PORT ?? 4319);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`TYR_UI_PORT must be a port number from 1024 to 65535, got ${process.env.TYR_UI_PORT}`);

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../../docs/reports/raw/ui-report" }]],
  outputDir: "../../docs/reports/raw/ui-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.004, threshold: 0.15, animations: "disabled", caret: "hide", scale: "css" },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1360, height: 860 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    timezoneId: "UTC",
    locale: "en-US",
    launchOptions: {
      // Software GL so the WebGL renderer path is exercised the same way on every machine.
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--font-render-hinting=none"],
    },
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" }, testIgnore: /perf\.spec\.ts/ },
    // Click-to-paint timings (perf.spec.ts) run last and alone, so other workers do not skew them.
    // On its own: `npx playwright test -c playwright.config.ts --project=perf --no-deps`.
    // Rasterization runs on the CPU here: GPU raster on SwiftShader (an emulated GPU) costs 100-250 ms
    // per full repaint in this container, which times the emulator, not the application. A real
    // WebView rasterizes on a GPU, or on the CPU when it has none.
    {
      name: "perf",
      testMatch: /perf\.spec\.ts/,
      dependencies: ["chromium"],
      workers: 1,
      use: {
        browserName: "chromium",
        launchOptions: {
          args: ["--disable-gpu-rasterization", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--font-render-hinting=none"],
        },
      },
    },
  ],
  webServer: {
    // vite directly, not through pnpm: the pinned test container has no network for pnpm's self-install.
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: "../../apps/desktop",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
