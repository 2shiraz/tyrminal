// Design captures (design-capture.ts) with the UI tests' browser, viewport and server. Not a test
// suite: it writes screenshots for docs/design/ and asserts nothing about appearance.
import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

export default defineConfig({ ...base, testMatch: /design-capture\.ts$/, reporter: "line", outputDir: "../../docs/reports/raw/design-capture" });
