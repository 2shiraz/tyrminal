// Paste safety rules (P-25, ADR 0011) as pure functions: no browser page. Written before the
// implementation; the UI behavior is covered in paste-safety.spec.ts.
import { expect, test } from "@playwright/test";

import {
  BRACKET_END,
  checkPaste,
  hiddenCharacters,
  removeBracketEnd,
  visibleSegments,
} from "../../apps/desktop/src/features/terminal/pasteSafety";

const ALL = { multiline: true, trailingNewline: true };
const RELAXED = { multiline: false, trailingNewline: false };

test("a plain one-line paste without a newline goes straight through", () => {
  expect(checkPaste("ls -la", ALL)).toEqual({ review: false, reasons: [], hidden: [], bracketEnd: false });
});

test("several lines, a large paste, and one line ending in a newline are reviewed", () => {
  expect(checkPaste("a\nb", ALL).reasons).toContain("multiline");
  expect(checkPaste("x".repeat(5000), ALL).reasons).toContain("large");
  for (const runs of ["rm -rf ./build\n", "rm -rf ./build\r", "rm -rf ./build\r\n"]) {
    const check = checkPaste(runs, ALL);
    expect(check.review, JSON.stringify(runs)).toBe(true);
    expect(check.reasons).toContain("trailing_newline");
  }
});

test("lowered checks skip line and newline reviews, never the hidden-character warning", () => {
  expect(checkPaste("a\nb\n", RELAXED).review).toBe(false);
  for (const sneaky of ["ls\u001b[2J", "ls\u0007", "ls\u009b", "echo ‮safe", "rm⁦ -rf", "a​b", "x﻿", "a‍c", "\u007f"]) {
    const check = checkPaste(sneaky, RELAXED);
    expect(check.review, JSON.stringify(sneaky)).toBe(true);
    expect(check.reasons).toContain("hidden");
    expect(check.hidden.length).toBeGreaterThan(0);
  }
  // Tabs and line breaks are ordinary text, not hidden characters.
  expect(hiddenCharacters("a\tb\nc\r\n")).toEqual([]);
});

test("every class of hidden character is found and named", () => {
  const found = hiddenCharacters("\u0000\u001b\u0080\u009f‪‮⁦⁩​‍﻿\u007f");
  expect(found.map((h) => h.label)).toEqual([
    "␀",
    "␛",
    "<U+0080>",
    "<U+009F>",
    "<U+202A>",
    "<U+202E>",
    "<U+2066>",
    "<U+2069>",
    "<U+200B>",
    "<U+200D>",
    "<U+FEFF>",
    "␡",
  ]);
});

test("a bracketed-paste end marker is detected in 7-bit and 8-bit forms and never survives removal", () => {
  expect(BRACKET_END).toBe("\u001b[201~");
  for (const evil of ["safe\u001b[201~rm -rf ~\r", "safe\u009b201~rm -rf ~\r", "\u001b[201~\u001b[201~x"]) {
    const check = checkPaste(evil, RELAXED);
    expect(check.bracketEnd, JSON.stringify(evil)).toBe(true);
    expect(check.review).toBe(true);
    expect(check.reasons).toContain("bracket_end");
    const cleaned = removeBracketEnd(evil);
    expect(cleaned).not.toContain("201~");
    expect(checkPaste(cleaned, RELAXED).bracketEnd).toBe(false);
  }
  // Removal cannot be undone by overlapping pieces that join into a new marker.
  const nested = "\u001b[20\u001b[201~1~";
  expect(checkPaste(removeBracketEnd(nested), RELAXED).bracketEnd).toBe(false);
  expect(removeBracketEnd("no marker")).toBe("no marker");
});

test("the review shows the exact text with hidden characters made visible", () => {
  const segments = visibleSegments("a\u001b[31mb‮c");
  expect(segments.map((s) => s.text).join("")).toBe("a␛[31mb<U+202E>c");
  expect(segments.filter((s) => s.hidden).map((s) => s.text)).toEqual(["␛", "<U+202E>"]);
});
