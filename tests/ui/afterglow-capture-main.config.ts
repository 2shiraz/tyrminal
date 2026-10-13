// The same captures (afterglow-capture.ts) against main's build, for the owner's side-by-side
// comparison in docs/experimental/afterglow-review.md. Writes docs/design/afterglow/main/.
//   pnpm --filter @tyrminal/desktop build && cd tests/ui && npx playwright test -c afterglow-capture-main.config.ts
import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

process.env.AFTERGLOW_OUT ??= new URL("../../docs/design/afterglow/main", import.meta.url).pathname;

export default defineConfig({
  ...base,
  testMatch: /afterglow-capture\.ts$/,
  reporter: "line",
  outputDir: "../../docs/reports/raw/afterglow-capture-main",
  projects: [{ name: "capture", use: { browserName: "chromium", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 } }],
});
