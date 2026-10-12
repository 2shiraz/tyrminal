import type { HighlightPreferences } from "@tyrminal/contracts";
import { type ReactNode, useId, useMemo } from "react";

import { usePreferences } from "../../app/preferences";
import { msgI } from "../../lib/messages-input";
import { schemeById } from "../terminal/schemes";
import { compileRules, resolveOverlaps } from "../terminal/highlight";
import type { BuiltinRule, TokenKind } from "./builtins";
import { highlightPalette } from "./palette";

type Kind = BuiltinRule["pref"];
const KINDS: { key: Kind; tone: TokenKind }[] = [
  { key: "levels", tone: "danger" },
  { key: "ipAddresses", tone: "address" },
  { key: "macAddresses", tone: "address" },
  { key: "numbers", tone: "number" },
  { key: "urls", tone: "url" },
  { key: "dates", tone: "date" },
  { key: "quoted", tone: "string" },
  { key: "paths", tone: "path" },
  { key: "hex", tone: "hex" },
];

/** The built-in token kinds with a sample in the scheme's colors, and a preview of real matching. */
export function BuiltinKinds({ highlight, onChange }: { highlight: HighlightPreferences; onChange: (change: Partial<HighlightPreferences>) => void }) {
  const { prefs } = usePreferences();
  const scheme = schemeById(prefs.terminal.scheme);
  const palette = highlightPalette(scheme);
  const hintId = useId();
  const preview = useMemo(() => {
    const match = compileRules(highlight);
    return msgI.highlight.previewLines.map((line) => ({ line, marks: match ? resolveOverlaps(match(line)) : [] }));
  }, [highlight]);

  return (
    <div className="stack-sm">
      <fieldset className="highlight-kinds" aria-describedby={hintId}>
        <legend className="label">{msgI.highlight.kindsLabel}</legend>
        {KINDS.map(({ key, tone }) => (
          <label key={key} className="highlight-kind">
            <input type="checkbox" checked={highlight[key] !== false} onChange={(e) => onChange({ [key]: e.target.checked })} />
            <span className="highlight-kind-name">{msgI.highlight.kinds[key].label}</span>
            <span className="highlight-kind-sample mono" style={{ background: scheme.background, color: palette[tone] }} aria-hidden="true">
              {key === "levels"
                ? (["danger", "warning", "success"] as const).map((level, i) => (
                    <span key={level} style={{ color: palette[level] }}>
                      {i > 0 ? " " : ""}
                      {msgI.highlight.kinds.levels.sample.split(/\s+/)[i]}
                    </span>
                  ))
                : msgI.highlight.kinds[key].sample}
            </span>
          </label>
        ))}
      </fieldset>
      <p id={hintId} className="faint" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
        {msgI.highlight.kindsHint}
      </p>
      <figure className="highlight-preview mono" style={{ background: scheme.background, color: scheme.foreground }} aria-label={msgI.highlight.preview}>
        {preview.map(({ line, marks }) => (
          <div key={line}>
            {marks.reduce<{ at: number; parts: ReactNode[] }>(
              (acc, m, i) => {
                acc.parts.push(line.slice(acc.at, m.start));
                acc.parts.push(
                  <span key={i} data-tone={m.tone} style={{ color: palette[m.tone] }}>
                    {line.slice(m.start, m.end)}
                  </span>,
                );
                acc.at = m.end;
                return acc;
              },
              { at: 0, parts: [] },
            ).parts}
            {line.slice(marks.at(-1)?.end ?? 0)}
          </div>
        ))}
      </figure>
    </div>
  );
}
