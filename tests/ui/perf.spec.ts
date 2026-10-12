// Perceived performance (docs/design/interaction-polish.md, section 1): click-to-paint for the
// most common actions, measured in the page against the UI test mock. The clock starts on the real
// (trusted) pointerdown in a capture-phase listener; frames are then polled until the expected
// change is in the DOM, and the clock stops at the next animation frame, after that change painted.
// Each action is repeated and the median must stay within 100 ms. UI evidence only.
import { type Page, expect, test } from "@playwright/test";

import { openApp } from "./fixtures";

const RUNS = 7;
const BUDGET_MS = 100;

/** What "done" looks like: an element matching `selector` (and containing `text`) that is rendered. */
interface Done {
  selector: string;
  text?: string;
}

interface Sample {
  /** Pointer down to the frame after the change painted. */
  paint: number;
  /** Main-thread time inside the pointerdown and click handlers (React's render and commit). */
  work: number;
}

/** Arms the in-page timer, runs `act` (a real pointer action), and returns click-to-paint in ms. */
async function clickToPaint(page: Page, act: () => Promise<void>, done: Done): Promise<Sample> {
  await page.evaluate((d) => {
    const w = window as unknown as { __perf: Promise<Sample> };
    w.__perf = new Promise<Sample>((resolve) => {
      let work = 0;
      let entered = 0;
      const enter = (event: Event) => {
        if (event.isTrusted) entered = performance.now();
      };
      const leave = (event: Event) => {
        if (event.isTrusted && entered) work += performance.now() - entered;
        entered = 0;
      };
      const kinds = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const;
      for (const k of kinds) {
        window.addEventListener(k, enter, true);
        window.addEventListener(k, leave, false);
      }
      const onDown = (event: PointerEvent) => {
        if (!event.isTrusted) return;
        window.removeEventListener("pointerdown", onDown, true);
        const started = performance.now();
        const present = () =>
          [...document.querySelectorAll<HTMLElement>(d.selector)].some(
            (el) => el.getClientRects().length > 0 && (d.text === undefined || (el.textContent ?? "").includes(d.text)),
          );
        const poll = () => {
          if (present())
            requestAnimationFrame(() => {
              for (const k of kinds) {
                window.removeEventListener(k, enter, true);
                window.removeEventListener(k, leave, false);
              }
              resolve({ paint: performance.now() - started, work });
            });
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      };
      window.addEventListener("pointerdown", onDown, true);
    });
  }, done);
  await act();
  return page.evaluate(() => (window as unknown as { __perf: Promise<Sample> }).__perf);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** Runs one action RUNS times (after a warm-up), records the median and checks the budget. */
async function measure(page: Page, name: string, once: (i: number) => Promise<Sample>, reset: (i: number) => Promise<void>) {
  // Warm-up: the first run pays for lazy chunks and first layout.
  await once(-1);
  await reset(-1);
  const samples: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    samples.push(await once(i));
    await reset(i);
  }
  const m = median(samples.map((s) => s.paint));
  const w = median(samples.map((s) => s.work));
  const line = `${name}: median ${m.toFixed(1)} ms click-to-paint, ${w.toFixed(1)} ms handler work (runs: ${samples.map((s) => s.paint.toFixed(0)).join(", ")})`;
  test.info().annotations.push({ type: "perf", description: line });
  console.log(`[perf] ${line}`);
  expect(m, `${name} click-to-paint median`).toBeLessThanOrEqual(BUDGET_MS);
}

const nav = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name });

async function openHosts(page: Page) {
  await nav(page, /^Hosts/).click();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
}

async function connectFromPalette(page: Page, host: string) {
  await page.keyboard.press("Control+Shift+K");
  await page.getByRole("combobox", { name: /Type a command/ }).fill(host);
  await page.keyboard.press("Enter");
  await expect(page.locator(".statusbar").getByRole("status")).toHaveText(/Connected/, { timeout: 15_000 });
}

// Since #110 a click on a host selects it at once and opens its details only after the
// double-click window (300 ms, so a double-click can connect instead). The immediate response is
// the selection, so that is what is timed; the details then follow by design.
test("perf: selecting a host shows at once, within budget", async ({ page }) => {
  await openApp(page, { realClock: true });
  await openHosts(page);
  const list = page.getByTestId("host-list");
  const names = ["edge-cache", "api-gateway"];
  await measure(
    page,
    "select host",
    (i) => {
      const name = names[Math.abs(i) % 2] as string;
      return clickToPaint(page, () => list.getByRole("button", { name, exact: true }).click(), {
        selector: "[data-testid='host-list'] [data-selected]",
      });
    },
    async () => {
      // The details panel opens after the double-click window; Escape closes it, and Escape in
      // the list clears the selection, so the next click selects from nothing.
      await page.waitForTimeout(400);
      for (let n = 0; n < 3 && (await list.locator("[data-selected]").count()) > 0; n++) {
        await list.locator("[data-selected] .host-open").first().focus();
        await page.keyboard.press("Escape");
      }
      await expect(list.locator("[data-selected]")).toHaveCount(0);
    },
  );
});

test("perf: switching between two terminal tabs is within budget", async ({ page }) => {
  await openApp(page, { realClock: true });
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+T");
  const tabs = page.getByRole("tablist", { name: "Open sessions" }).locator(".tab:not(.tab-page)");
  await expect(tabs).toHaveCount(2);
  const labels = ["api-gateway", "Local terminal"];
  await measure(
    page,
    "switch tab",
    (i) => {
      const label = labels[Math.abs(i) % 2] as string;
      return clickToPaint(page, () => page.getByRole("tab", { name: new RegExp(label) }).click(), {
        selector: ".tab[aria-selected='true']",
        text: label,
      });
    },
    async () => undefined,
  );
});

test("perf: open settings is within budget", async ({ page }) => {
  await openApp(page, { realClock: true });
  await measure(
    page,
    "open settings",
    () => clickToPaint(page, () => nav(page, /^Settings/).click(), { selector: "main h1", text: "Settings" }),
    async () => {
      await nav(page, /^Hosts/).click();
      await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toHaveCount(0);
    },
  );
});

test("perf: open the palette from the sidebar is within budget", async ({ page }) => {
  await openApp(page, { realClock: true });
  await measure(
    page,
    "open palette",
    () => clickToPaint(page, () => page.locator(".sidebar-search").click(), { selector: "[role='combobox']" }),
    async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("combobox", { name: /Type a command/ })).toHaveCount(0);
    },
  );
});

test("perf: expanding a group in the hosts view is within budget", async ({ page }) => {
  await openApp(page, { realClock: true });
  await openHosts(page);
  const bar = page.getByTestId("group-bar");
  await measure(
    page,
    "expand group",
    () =>
      clickToPaint(page, () => bar.getByRole("button", { name: "Production", exact: true }).click(), {
        selector: "[data-testid='breadcrumb'] [aria-current='page']",
        text: "Production",
      }),
    async () => {
      await page.getByTestId("breadcrumb").getByRole("button", { name: "Hosts" }).click();
      await expect(page.getByTestId("breadcrumb")).toHaveCount(0);
    },
  );
});

test("perf: selecting a file in the files panel is within budget", async ({ page }) => {
  await openApp(page, { realClock: true });
  await connectFromPalette(page, "api-gateway");
  await page.keyboard.press("Control+Shift+O");
  const panel = page.getByRole("complementary", { name: "Files" });
  const list = panel.getByRole("grid", { name: /^Contents of \// });
  await expect(list).toBeVisible();
  const names = ["README.md", "deploy.sh"];
  await measure(
    page,
    "select a file",
    (i) => {
      const name = names[Math.abs(i) % 2] as string;
      return clickToPaint(page, () => list.getByRole("row", { name: new RegExp(name.replace(".", "\\.")) }).click(), {
        selector: `.ft-table tr.is-selected[data-name='${name}']`,
      });
    },
    async () => undefined,
  );
});
