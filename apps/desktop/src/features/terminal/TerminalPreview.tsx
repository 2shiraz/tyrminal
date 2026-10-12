import type { TerminalPreferences } from "@tyrminal/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import { fontsReady, terminalOptions } from "./TerminalController";
import { schemeById } from "./schemes";
import { ligatureRanges } from "./terminalPolicy";

// A fixed, local sample. Nothing here comes from a session; it exercises colors, bold, box
// drawing, powerline glyphs, wide characters and (when enabled) ligatures.
const E = "\u001b[";
const SAMPLE = [
  `${E}1;38;5;75m tyr ${E}0m${E}38;5;75;48;5;236m${E}0m${E}48;5;236m ~/projects/api ${E}0m${E}38;5;236m${E}0m ${E}32mmain${E}0m ${E}2m +2 ~1${E}0m`,
  `${E}1m$${E}0m git log --oneline -3`,
  `${E}33ma1f3c2e${E}0m ${E}36m(HEAD -> main)${E}0m Handle => and != correctly`,
  `${E}33m9d02b71${E}0m Bump deps ${E}2m(2 hours ago)${E}0m`,
  `┌──────────┬─────────┐  ${E}31m●${E}0m red ${E}32m●${E}0m green ${E}33m●${E}0m yellow`,
  `│ ${E}1mprocess${E}0m  │ ${E}34m4.2 GiB${E}0m │  ${E}34m●${E}0m blue ${E}35m●${E}0m magenta ${E}36m●${E}0m cyan`,
  `└──────────┴─────────┘  ▁▂▃▄▅▆▇█  日本語 ✓ 🚀`,
  `${E}1m$${E}0m ${E}7m ${E}0m`,
].join("\r\n");

/** Live preview of the terminal preferences. Never connected to anything. */
export function TerminalPreview({ prefs }: { prefs: TerminalPreferences }) {
  const ref = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const t = new Terminal({ ...terminalOptions(prefs), disableStdin: true, cursorBlink: false, scrollback: 0 });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new UnicodeGraphemesAddon());
    t.unicode.activeVersion = "15-graphemes";
    t.open(container);
    term.current = t;
    fit.current = f;
    void fontsReady(prefs).then(() => {
      f.fit();
      t.write(SAMPLE);
    });
    const observer = new ResizeObserver(() => f.fit());
    observer.observe(container);
    return () => {
      observer.disconnect();
      t.dispose();
      term.current = null;
    };
    // Created once; preference changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    const options = terminalOptions(prefs);
    for (const key of ["theme", "fontFamily", "fontSize", "lineHeight", "letterSpacing", "cursorStyle"] as const) {
      (t.options as Record<string, unknown>)[key] = options[key];
    }
    const joiner = prefs.ligatures ? t.registerCharacterJoiner(ligatureRanges) : null;
    void fontsReady(prefs).then(() => fit.current?.fit());
    t.refresh(0, t.rows - 1);
    return () => {
      if (joiner !== null) t.deregisterCharacterJoiner(joiner);
    };
  }, [prefs]);

  const scheme = schemeById(prefs.scheme);
  return (
    <div
      className="terminal-preview"
      style={{ background: scheme.background, padding: prefs.padding }}
      aria-hidden="true"
      data-testid="terminal-preview"
    >
      <div ref={ref} style={{ height: "100%" }} />
    </div>
  );
}
