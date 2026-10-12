// Browser UI tests: the production frontend build served by `vite preview`, driven in Chromium,
// with the test-only mock backend (mock-backend.js). These cover layout, keyboard flows,
// accessibility behavior and visual regressions. They never count as native verification.
import { defineConfig } from "@playwright/test";

const port = 4319;

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
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `pnpm --filter @tyrminal/desktop exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
