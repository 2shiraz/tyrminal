// Afterglow design captures (afterglow-capture.ts): key screens of the experimental build in both
// themes at 1440p (1280×720 CSS pixels at 2×), written to docs/design/afterglow/. Asserts nothing.
//   cd tests/ui && npx playwright test -c afterglow-capture.config.ts
import { defineConfig } from "@playwright/test";

import exp from "./playwright.exp.config";

export default defineConfig({
  ...exp,
  testMatch: /afterglow-capture\.ts$/,
  reporter: "line",
  outputDir: "../../docs/reports/raw/afterglow-capture",
  projects: [{ name: "capture", use: { browserName: "chromium", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 } }],
});
