// Transfer list shared by the Files panel and the SFTP tab: what one row holds, how a core event
// changes it, and the transfer rate. Pure functions; the owner keeps the list.

import type { TransferDirection, TransferEvent, TransferStarted } from "@tyrminal/contracts";

export interface Transfer {
  id: string;
  name: string;
  direction: TransferDirection;
  total: number | null;
  done: number;
  state: "running" | "done" | "cancelled" | "failed";
  error?: string;
  /** Files copied and links/special files skipped (folders only). */
  files?: number;
  skipped?: number;
  /** Bytes per second, smoothed; null until two progress reports have arrived. */
  rate: number | null;
  /** When the last progress report arrived (performance.now()), for the rate; 0 before the first. */
  at: number;
}

/** How much the latest sample counts in the smoothed rate. */
const SMOOTHING = 0.3;

export function started(s: TransferStarted): Transfer {
  return { id: s.transferId, name: s.name, direction: s.direction, total: s.total, done: 0, state: "running", rate: null, at: 0 };
}

let refusals = 0;

/** A transfer refused before it started: listed with the reason, like any other failure. */
export function refused(name: string, direction: TransferDirection, error: string): Transfer {
  refusals += 1;
  return { id: `refused-${refusals}`, name, direction, total: null, done: 0, state: "failed", error, rate: null, at: 0 };
}

export function applyEvent<T extends Transfer>(t: T, event: TransferEvent, now = performance.now()): T {
  switch (event.type) {
    case "progress": {
      // The first report is the baseline: the rate needs two reports (a start time would count
      // bytes sent before the transfer was listed).
      if (t.at === 0) return { ...t, done: event.done, at: now };
      const seconds = (now - t.at) / 1000;
      if (seconds <= 0 || event.done < t.done) return { ...t, done: event.done };
      const sample = (event.done - t.done) / seconds;
      return { ...t, done: event.done, at: now, rate: t.rate == null ? sample : t.rate + SMOOTHING * (sample - t.rate) };
    }
    case "done":
      return { ...t, done: event.bytes, state: "done", files: event.files, skipped: event.skipped, rate: null };
    case "cancelled":
      return { ...t, state: "cancelled", rate: null };
    case "failed":
      return { ...t, state: "failed", error: event.error.message, rate: null };
  }
}

/** Running transfers taken together, for the drawer's summary line and bar. */
export function totals(list: Transfer[]): { running: number; failed: number; done: number; total: number | null } {
  const running = list.filter((t) => t.state === "running");
  const known = running.every((t) => t.total != null);
  return {
    running: running.length,
    failed: list.filter((t) => t.state === "failed").length,
    done: running.reduce((sum, t) => sum + t.done, 0),
    total: known ? running.reduce((sum, t) => sum + (t.total ?? 0), 0) : null,
  };
}
