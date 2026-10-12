// Runs highlight patterns over the visible rows, off the main thread. Before each rule it reports
// which one it is on, so a rule that runs past the time limit can be named and switched off when
// the page terminates this worker. Receives only the rows' text; keeps nothing between requests
// except compiled patterns.

import { type PatternRule, compilePattern, patternKey } from "./patterns";

export interface PatternRequest {
  seq: number;
  rules: PatternRule[];
  lines: string[];
}

/** [line index, start, end, rank] */
export type PatternMatch = [number, number, number, number];

export type PatternReply = { seq: number; rule: number } | { seq: number; done: true; matches: PatternMatch[] };

const MAX_PER_LINE = 64;
const post = (reply: PatternReply) => (self as unknown as { postMessage(message: unknown): void }).postMessage(reply);
const cache = new Map<string, RegExp>();

self.onmessage = (event: MessageEvent<PatternRequest>) => {
  const { seq, rules, lines } = event.data;
  const matches: PatternMatch[] = [];
  for (const rule of rules) {
    post({ seq, rule: rule.rank });
    const key = patternKey(rule);
    let re = cache.get(key);
    if (!re) {
      re = compilePattern(rule);
      if (cache.size > 64) cache.clear();
      cache.set(key, re);
    }
    lines.forEach((line, index) => {
      let found = 0;
      for (const m of line.matchAll(re)) {
        if (m[0].length === 0) continue;
        matches.push([index, m.index, m.index + m[0].length, rule.rank]);
        found += 1;
        if (found >= MAX_PER_LINE) break;
      }
    });
  }
  post({ seq, done: true, matches });
};
