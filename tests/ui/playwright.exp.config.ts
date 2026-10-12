// Afterglow (experimental UI, branch only): the same role-based UI specs, run against the
// experimental build (TYRMINAL_UI=experimental, served from apps/desktop/dist-exp). Visual baselines
// live in __screenshots__/afterglow/, so main's baselines never change. Afterglow-only specs are
// named *.exp.ts, which main's config never matches.
//   node scripts/exp/ui.mjs            build the exp bundle, then run every spec against it
import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

const port = Number(process.env.TYR_UI_EXP_PORT ?? 4329);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`TYR_UI_EXP_PORT must be a port number from 1024 to 65535, got ${process.env.TYR_UI_EXP_PORT}`);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  ...base,
  testMatch: [/.*\.spec\.ts/, /.*\.exp\.ts/],
  reporter: [["list"], ["html", { open: "never", outputFolder: "../../docs/reports/raw/ui-report-exp" }]],
  outputDir: "../../docs/reports/raw/ui-results-exp",
  snapshotPathTemplate: "{testDir}/__screenshots__/afterglow/{arg}{ext}",
  use: { ...base.use, baseURL },
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: "../../apps/desktop",
    env: { TYRMINAL_UI: "experimental" },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
