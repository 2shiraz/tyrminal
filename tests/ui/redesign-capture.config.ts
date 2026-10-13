// Reproducible before/after evidence, isolated from regression snapshots and other runs.
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: /redesign-capture\.ts$/,
  workers: 2,
  reporter: [["list"], ["json", { outputFile: "../../docs/redesign/capture-results.json" }]],
  outputDir: "../../docs/redesign/capture-results",
  use: {
    ...base.use,
    launchOptions: { ...base.use?.launchOptions, ...(process.env.TYR_BROWSER_EXECUTABLE ? { executablePath: process.env.TYR_BROWSER_EXECUTABLE } : {}) },
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1360, height: 860 } } },
    { name: "minimum", use: { browserName: "chromium", viewport: { width: 820, height: 620 } } },
    { name: "wide", use: { browserName: "chromium", viewport: { width: 1920, height: 1080 } } },
  ],
  webServer: { ...base.webServer, reuseExistingServer: false },
});
