// Highlight patterns (TRM-07): user regular expressions limited to a subset whose backtracking
// stays bounded. The same rules are enforced natively (crates/core/src/highlight.rs) before
// preferences are stored. Matching runs in a worker under a time limit (see runner.ts).

/** Mirrors `tyrminal_contracts::limits`. */
export const MAX_HIGHLIGHT_PATTERNS = 8;
export const MAX_PATTERN_LEN = 128;
export const MAX_PATTERN_UNBOUNDED = 3;
export const MAX_PATTERN_REPEAT = 256;

const DECEPTIVE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩​-‏﻿]/;

/** Returns why `pattern` cannot be used, or null when it can. */
export function checkPattern(pattern: string): string | null {
  const chars = [...pattern];
  if (chars.length === 0 || chars.length > MAX_PATTERN_LEN) return "A highlight pattern must be 1 to 128 characters.";
  if (DECEPTIVE.test(pattern)) return "The pattern contains control or invisible characters.";
  const repeatedGroup = "A group cannot be repeated in a highlight pattern; repeat a character or a [set] instead.";
  let inClass = false;
  let depth = 0;
  let unbounded = 0;
  let afterGroup = false;
  for (let i = 0; i < chars.length; ) {
    const c = chars[i] as string;
    if (c === "\\") {
      const next = chars[i + 1];
      if (next === undefined) return "The pattern ends with a lone \\.";
      if (!inClass && /^[1-9k]$/.test(next)) return "Backreferences are not supported in highlight patterns.";
      i += 2;
      afterGroup = false;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i += 1;
      continue;
    }
    if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      if (chars[i + 1] === "?") {
        if (chars[i + 2] !== ":") return "Lookahead, lookbehind and named groups are not supported in highlight patterns.";
        i += 2;
      }
      depth += 1;
    } else if (c === ")") {
      if (depth === 0) return "The pattern has an unmatched ).";
      depth -= 1;
      i += 1;
      afterGroup = true;
      continue;
    } else if (c === "*" || c === "+") {
      if (afterGroup) return repeatedGroup;
      unbounded += 1;
    } else if (c === "{") {
      if (afterGroup) return repeatedGroup;
      const end = chars.indexOf("}", i);
      const body = end < 0 ? null : /^(\d{1,4})(,(\d{1,4})?)?$/.exec(chars.slice(i + 1, end).join(""));
      if (!body) return "Write a literal { as \\{. A count is {n}, {n,} or {n,m}.";
      const low = Number(body[1]);
      const high = body[2] === undefined ? low : body[3] === undefined ? null : Number(body[3]);
      if (low > MAX_PATTERN_REPEAT || (high !== null && (high > MAX_PATTERN_REPEAT || high < low))) {
        return "A repetition count in a highlight pattern can be 256 at most.";
      }
      if (high === null) unbounded += 1;
      i = end + 1;
      afterGroup = false;
      continue;
    } else if (c === "}") {
      return "Write a literal } as \\}.";
    }
    afterGroup = false;
    i += 1;
  }
  if (inClass) return "The pattern has an unclosed [.";
  if (depth !== 0) return "The pattern has an unclosed (.";
  if (unbounded > MAX_PATTERN_UNBOUNDED) return "A highlight pattern can repeat without limit (*, +) three times at most.";
  let re: RegExp;
  try {
    re = new RegExp(pattern, "u");
  } catch {
    return "This is not a valid regular expression.";
  }
  if (re.test("")) return "The pattern matches empty text; it must match at least one character.";
  return null;
}

export interface PatternRule {
  /** Position in the user's rule list (earlier rules win where matches overlap). */
  rank: number;
  text: string;
  caseSensitive: boolean;
}

export function compilePattern(rule: PatternRule): RegExp {
  return new RegExp(rule.text, rule.caseSensitive ? "gu" : "giu");
}

/** Identity of a pattern for the "too slow" list. */
export const patternKey = (rule: { text: string; caseSensitive: boolean }) => `${rule.caseSensitive ? "1" : "0"}:${rule.text}`;
