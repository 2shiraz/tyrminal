// Screenshots of the static prototype into docs/design/after/, at the UI tests' viewport.
//   node docs/design/prototype/shoot.mjs [screen ...]
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, "../../../tests/ui/package.json"))("@playwright/test");
const out = join(here, "../after");
mkdirSync(out, { recursive: true });

const all = ["home", "hosts", "empty", "terminal", "palette", "trust", "settings", "toast", "unlock",
  "onboarding", "onboarding-recovery", "unlock-quick", "unlock-wrong", "first-run", "empty-keychain", "empty-snippets",
  "connect", "connect-trust", "connect-hop", "connect-auth", "connect-changed", "connect-failed", "connect-reconnecting"];
const screens = process.argv.length > 2 ? process.argv.slice(2) : all;
const variants = [
  ["dark", null],
  ["light", null],
];
const extras = [
  ["hosts", "dark", "fjord"],
  ["hosts", "light", "fjord"],
  ["hosts", "dark", "contrast"],
  ["hosts", "light", "contrast"],
  ["terminal", "dark", "fjord"],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
const shoot = async (screen, theme, palette, suffix = "") => {
  const url = pathToFileURL(join(here, "index.html"));
  url.search = new URLSearchParams({ screen, theme, ...(palette ? { palette } : {}), ...(suffix ? { blurred: "1" } : {}) }).toString();
  await page.goto(url.href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const name = `${palette ? `${palette}-` : ""}${theme}-${screen}${suffix}.png`;
  await page.screenshot({ path: join(out, name) });
  console.log(name);
};
for (const screen of screens) for (const [theme] of variants) await shoot(screen, theme);
if (process.argv.length <= 2) {
  for (const [screen, theme, palette] of extras) await shoot(screen, theme, palette);
  await shoot("hosts", "dark", null, "-window-blurred");
}
await browser.close();
