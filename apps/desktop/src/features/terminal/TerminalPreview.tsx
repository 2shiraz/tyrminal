import type { TerminalPreferences } from "@tyrminal/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { isPanelResizing, onPanelResizeEnd } from "../../lib/resizing";
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
  const [ready, setReady] = useState(false);

  // The latest preferences, for a terminal created after the first paint.
  const latest = useRef(prefs);
  latest.current = prefs;

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let t: Terminal | null = null;
    let observer: ResizeObserver | null = null;
    // Creating the emulator measures fonts and takes tens of milliseconds: do it after Settings
    // has painted (the next frame, then a task), so opening Settings is never held up by it.
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        const prefsNow = latest.current;
        const created = new Terminal({ ...terminalOptions(prefsNow), disableStdin: true, cursorBlink: false, scrollback: 0 });
        const f = new FitAddon();
        created.loadAddon(f);
        created.loadAddon(new UnicodeGraphemesAddon());
        created.unicode.activeVersion = "15-graphemes";
        created.open(container);
        t = created;
        term.current = created;
        fit.current = f;
        setReady(true);
        void fontsReady(prefsNow).then(() => {
          f.fit();
          created.write(SAMPLE);
        });
        // Not on every frame of a panel drag: once when it ends.
        observer = new ResizeObserver(() => {
          if (!isPanelResizing()) f.fit();
        });
        observer.observe(container);
      }, 0);
    });
    const offResizeEnd = onPanelResizeEnd(() => fit.current?.fit());
    return () => {
      offResizeEnd();
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      observer?.disconnect();
      t?.dispose();
      term.current = null;
    };
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
  }, [prefs, ready]);

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
