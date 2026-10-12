import type { HighlightKeyword, HighlightTone } from "@tyrminal/contracts";
import { useEffect, useId, useReducer, useState } from "react";

import { Notice, SettingRow } from "../../components/ui/controls";
import { IconTrash2 } from "../../components/ui/icons";
import { msgC } from "../../lib/messages-c";
import { msgI } from "../../lib/messages-input";
import { MAX_HIGHLIGHT_PATTERNS, MAX_PATTERN_LEN, checkPattern } from "./patterns";
import { forgetSlowPatterns, isSlowPattern, onSlowPattern } from "./runner";

const TONES: HighlightTone[] = ["danger", "warning", "success", "info"];
const MAX_RULES = 32;
const MAX_WORD_LEN = 64;

/** Highlight rules: literal words and bounded regular expressions (TRM-07). */
export function HighlightRules({ words, onChange }: { words: HighlightKeyword[]; onChange: (words: HighlightKeyword[]) => void }) {
  const [draft, setDraft] = useState("");
  const [asPattern, setAsPattern] = useState(false);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const errorId = useId();
  // A pattern switched off while this page is open shows as such.
  useEffect(() => onSlowPattern(() => rerender()), []);

  const patterns = words.filter((w) => w.pattern).length;
  const text = asPattern ? draft : draft.trim();
  const problem = !text
    ? null
    : words.some((w) => w.text === text && w.pattern === asPattern)
      ? msgI.highlight.duplicate
      : asPattern
        ? patterns >= MAX_HIGHLIGHT_PATTERNS
          ? msgI.highlight.patternLimit
          : checkPattern(text)
        : null;
  const change = (next: HighlightKeyword[]) => {
    forgetSlowPatterns();
    onChange(next);
  };
  const add = () => {
    if (!text || problem || words.length >= MAX_RULES || (!asPattern && text.length > MAX_WORD_LEN)) return;
    change([...words, { text, tone: asPattern ? "info" : "danger", caseSensitive: false, pattern: asPattern }]);
    setDraft("");
  };
  return (
    <SettingRow label={msgC.highlight.words}>
      <div className="stack-xs">
        <ul className="highlight-words">
          {words.map((w, i) => {
            const name = w.pattern ? msgI.highlight.patternSample(w.text) : w.text;
            return (
              <li key={`${w.pattern ? "p" : "w"}:${w.text}`} data-pattern={w.pattern || undefined}>
                <span className="highlight-sample mono" data-tone={w.tone}>
                  {name}
                </span>
                {w.pattern && isSlowPattern(w) && (
                  <span className="faint" role="status" style={{ fontSize: "var(--text-sm)" }}>
                    {msgI.highlight.slow}
                  </span>
                )}
                <select
                  className="input input-sm"
                  aria-label={msgC.highlight.tone(name)}
                  value={w.tone}
                  onChange={(e) => change(words.map((x, j) => (j === i ? { ...x, tone: e.target.value as HighlightTone } : x)))}
                >
                  {TONES.map((t) => (
                    <option key={t} value={t}>
                      {msgC.highlight.tones[t]}
                    </option>
                  ))}
                </select>
                <label className="row-flex" style={{ gap: "var(--space-1)", fontSize: "var(--text-sm)" }}>
                  <input
                    type="checkbox"
                    aria-label={msgC.highlight.caseSensitive(name)}
                    checked={w.caseSensitive}
                    onChange={(e) => change(words.map((x, j) => (j === i ? { ...x, caseSensitive: e.target.checked } : x)))}
                  />
                  Aa
                </label>
                <button type="button" className="btn btn-ghost btn-sm" aria-label={msgC.highlight.remove(name)} onClick={() => change(words.filter((_, j) => j !== i))}>
                  <IconTrash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="row-flex">
          <select className="input input-sm" aria-label={msgI.highlight.kind} value={asPattern ? "pattern" : "word"} onChange={(e) => setAsPattern(e.target.value === "pattern")}>
            <option value="word">{msgI.highlight.word}</option>
            <option value="pattern">{msgI.highlight.pattern}</option>
          </select>
          <input
            className="input mono"
            aria-label={asPattern ? msgI.highlight.patternLabel : msgC.highlight.wordLabel}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? errorId : undefined}
            value={draft}
            maxLength={asPattern ? MAX_PATTERN_LEN : MAX_WORD_LEN}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn" onClick={add} disabled={text === "" || problem !== null || words.length >= MAX_RULES}>
            {msgC.highlight.add}
          </button>
        </div>
        {problem && (
          <p id={errorId} role="alert" className="field-error" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
            {problem}
          </p>
        )}
        {asPattern && (
          <p className="faint" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
            {msgI.highlight.patternHint}
          </p>
        )}
        {words.length >= MAX_RULES && <Notice tone="info">32 / 32</Notice>}
      </div>
    </SettingRow>
  );
}
