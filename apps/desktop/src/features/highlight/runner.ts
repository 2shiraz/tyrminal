// One worker for highlight patterns, shared by every terminal of the window. A request that does
// not finish within the time limit terminates the worker (a running regular expression cannot be
// interrupted any other way); the rule it was on is switched off until the user changes the
// rules, and listeners are told. If no worker can be started, patterns are not applied: matching
// is never moved onto the main thread.

import type { PatternRule } from "./patterns";
import { patternKey } from "./patterns";
import type { PatternMatch, PatternReply, PatternRequest } from "./patterns.worker";

export const PATTERN_TIME_LIMIT_MS = 250;

export type PatternOutcome = { kind: "ok"; matches: PatternMatch[] } | { kind: "slow"; rule: PatternRule } | { kind: "unavailable" };

interface Job {
  rules: PatternRule[];
  lines: string[];
  resolve: (outcome: PatternOutcome) => void;
}

const slow = new Set<string>();
const slowListeners = new Set<(rule: PatternRule) => void>();
let worker: Worker | null = null;
let unavailable = false;
let seq = 0;
let current: (Job & { seq: number; rank: number; timer: number }) | null = null;
/** At most one waiting job per owner (a terminal); a newer one replaces it. */
const waiting = new Map<object, Job>();

/** Patterns switched off in this window because they ran too long. */
export function isSlowPattern(rule: { text: string; caseSensitive: boolean }): boolean {
  return slow.has(patternKey(rule));
}

/** Changing the rules gives every pattern another chance. */
export function forgetSlowPatterns(): void {
  slow.clear();
}

export function onSlowPattern(listener: (rule: PatternRule) => void): () => void {
  slowListeners.add(listener);
  return () => slowListeners.delete(listener);
}

function ensureWorker(): Worker | null {
  if (worker || unavailable) return worker;
  try {
    worker = new Worker(new URL("./patterns.worker.ts", import.meta.url), { type: "module", name: "highlight-patterns" });
  } catch {
    unavailable = true;
    return null;
  }
  worker.onmessage = (event: MessageEvent<PatternReply>) => {
    const reply = event.data;
    if (!current || reply.seq !== current.seq) return;
    if ("done" in reply) {
      finish({ kind: "ok", matches: reply.matches });
    } else {
      current.rank = reply.rule;
    }
  };
  worker.onerror = () => {
    // A worker that cannot load (for example blocked by the platform) never comes back.
    unavailable = true;
    worker?.terminate();
    worker = null;
    finish({ kind: "unavailable" });
    for (const job of waiting.values()) job.resolve({ kind: "unavailable" });
    waiting.clear();
  };
  return worker;
}

function finish(outcome: PatternOutcome): void {
  if (!current) return;
  window.clearTimeout(current.timer);
  const done = current;
  current = null;
  done.resolve(outcome);
  next();
}

function next(): void {
  if (current) return;
  const first = waiting.entries().next();
  if (first.done) return;
  const [owner, job] = first.value;
  waiting.delete(owner);
  const rules = job.rules.filter((r) => !isSlowPattern(r));
  if (rules.length === 0) {
    job.resolve({ kind: "ok", matches: [] });
    next();
    return;
  }
  const w = ensureWorker();
  if (!w) {
    job.resolve({ kind: "unavailable" });
    next();
    return;
  }
  seq += 1;
  const timer = window.setTimeout(() => {
    if (!current) return;
    const rule = current.rules.find((r) => r.rank === current?.rank) ?? (current.rules[0] as PatternRule);
    slow.add(patternKey(rule));
    worker?.terminate();
    worker = null;
    for (const listener of slowListeners) listener(rule);
    finish({ kind: "slow", rule });
  }, PATTERN_TIME_LIMIT_MS);
  current = { ...job, rules, seq, rank: rules[0]?.rank ?? 0, timer };
  w.postMessage({ seq, rules, lines: job.lines } satisfies PatternRequest);
}

/** Matches `rules` in `lines` for `owner`; an older waiting request of the same owner is dropped. */
export function runPatterns(owner: object, rules: PatternRule[], lines: string[]): Promise<PatternOutcome> {
  if (unavailable) return Promise.resolve({ kind: "unavailable" });
  return new Promise((resolve) => {
    waiting.get(owner)?.resolve({ kind: "ok", matches: [] });
    waiting.set(owner, { rules, lines, resolve });
    next();
  });
}
