// Shared helpers for the perf project (*perf.spec.ts): order statistics and the report line.
import { test } from "@playwright/test";

export function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** Nearest-rank percentile (p in 0..1) of `values`. */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank] as number;
}

/** Prints a measurement and attaches it to the test report. */
export function report(line: string) {
  test.info().annotations.push({ type: "perf", description: line });
  console.log(`[perf] ${line}`);
}

export const fmt = (values: number[]) => values.map((v) => v.toFixed(0)).join(", ");
