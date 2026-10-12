// Pure policy checks for the terminal module (no page, no backend).
import { expect, test } from "@playwright/test";

import { RECONNECT_MAX_ATTEMPTS, reconnectDelayMs, shouldAutoReconnect } from "../../apps/desktop/src/features/terminal/terminalPolicy";

test("reconnect backoff doubles from 1 s, caps at 30 s, and jitters by at most 20%", () => {
  const mid = () => 0.5;
  expect([1, 2, 3, 4, 5, 6, 7, 30].map((n) => reconnectDelayMs(n, mid))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  expect(reconnectDelayMs(1, () => 0)).toBe(800);
  expect(reconnectDelayMs(1, () => 1)).toBe(1200);
  expect(reconnectDelayMs(6, () => 1)).toBe(36000);
  expect(reconnectDelayMs(0, mid)).toBe(1000);
  for (let i = 0; i < 200; i += 1) {
    const d = reconnectDelayMs(3);
    expect(d).toBeGreaterThanOrEqual(3200);
    expect(d).toBeLessThanOrEqual(4800);
  }
  expect(RECONNECT_MAX_ATTEMPTS).toBe(6);
});

test("only dropped SSH sessions that had connected are retried automatically", () => {
  for (const code of ["DISCONNECTED", "TIMEOUT", "UNREACHABLE"]) expect(shouldAutoReconnect("ssh", true, code)).toBe(true);
  for (const code of ["AUTH_FAILED", "HOST_KEY_CHANGED", "HOST_KEY_REJECTED", "CANCELLED", "VAULT_LOCKED", "ACCESS_DENIED"]) {
    expect(shouldAutoReconnect("ssh", true, code)).toBe(false);
  }
  expect(shouldAutoReconnect("ssh", true, null)).toBe(false);
  expect(shouldAutoReconnect("ssh", false, "DISCONNECTED")).toBe(false);
  expect(shouldAutoReconnect("local", true, "DISCONNECTED")).toBe(false);
});
