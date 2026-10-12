// Reads highlight decorations back as text: for the terminal row containing `needle`, every
// decoration on that row as [tone, the characters under it], left to right.

import type { Page } from "@playwright/test";

export function marksOnRow(page: Page, needle: string): Promise<[string, string][] | null> {
  return page.evaluate((n) => {
    const host = document.querySelector(".pane:not([hidden]) .terminal-host, .terminal-pane:not([hidden]) .terminal-host");
    const rows = [...(host?.querySelectorAll(".xterm-rows > div") ?? [])] as HTMLElement[];
    const row = rows.find((r) => r.textContent?.replaceAll(" ", " ").includes(n));
    if (!row) return null;
    const box = row.getBoundingClientRect();
    // Left edge of every character of the row.
    const xs: { x: number; ch: string }[] = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length; i += 1) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + 1);
        xs.push({ x: r.getBoundingClientRect().left, ch: text[i] === " " ? " " : (text[i] as string) });
      }
    }
    const marks = [...(host?.querySelectorAll(".term-highlight") ?? [])] as HTMLElement[];
    return marks
      .map((m) => ({ m, r: m.getBoundingClientRect() }))
      .filter(({ r }) => Math.abs(r.top - box.top) < box.height / 2)
      .sort((a, b) => a.r.left - b.r.left)
      .map(({ m, r }) => [m.dataset.tone ?? "", xs.filter((c) => c.x >= r.left - 0.5 && c.x < r.right - 0.5).map((c) => c.ch).join("")] as [string, string]);
  }, needle);
}
