// Test helpers for connection states the mock backend does not produce on its own: they hold a
// connection at a step with the page clock and deliver real SessionEvent shapes
// (packages/contracts) on the newest session's own channel, as the core would.
import type { Page } from "@playwright/test";

type Event = Record<string, unknown> & { type: string };

export async function emitSessionEvent(page: Page, event: Event) {
  await page.evaluate((e) => {
    const w = window as unknown as {
      __mockState: { sessions: Map<string, { events: { id: number; index?: number } }> };
      __TAURI_INTERNALS__: { callbacks: Map<number, (payload: unknown) => void> };
    };
    const session = [...w.__mockState.sessions.values()].at(-1);
    if (!session) throw new Error("no session is open");
    const callback = w.__TAURI_INTERNALS__.callbacks.get(session.events.id);
    if (!callback) throw new Error("the session's event channel is not registered");
    session.events.index = (session.events.index ?? 0) + 1;
    callback({ index: session.events.index - 1, message: e });
  }, event);
}

/**
 * Pauses the page clock, clicks `connect`, and advances until the session is open. The mock then
 * reports connecting, verifying_host, authenticating and opening_channel 10, 25, 40 and 55 ms later.
 */
export async function connectHeld(page: Page, connect: () => Promise<void>) {
  await page.clock.pauseAt(new Date("2026-10-11T12:00:05Z"));
  await connect();
  for (let i = 0; i < 500; i += 1) {
    if (await page.evaluate(() => (window as unknown as { __mockState: { sessions: Map<string, unknown> } }).__mockState.sessions.size > 0)) return;
    await page.clock.runFor(2);
  }
  throw new Error("the session did not open");
}

export const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __mockCalls: { cmd: string; args: unknown }[] }).__mockCalls.filter((x) => x.cmd === c), cmd);
