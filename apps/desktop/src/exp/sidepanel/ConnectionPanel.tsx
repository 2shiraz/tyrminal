// Afterglow's terminal side panel (experimental UI, branch only; plan §6 moment 7, theme cards):
// main's ConnectionPanel, unchanged, plus a grid of scheme cards in its Appearance section, each a
// tiny static ANSI sample drawn in DOM (not a terminal). A click chooses the scheme exactly as
// main's select does (the same preference); the chosen card's check springs in. Main's select stays
// below, labelled, as the keyboard and assistive-technology control, so the cards are a pointer
// shortcut only (hidden from assistive technology, out of the tab order). Swapped in for
// features/sidepanel/ConnectionPanel.tsx by vite.exp.mjs; same exports and props.
//
// Not done: previewing a scheme on hover. Main applies a scheme by saving the preference, so a
// hover preview would write preferences while the pointer merely passes over a card.
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { usePreferences } from "../../app/preferences";
import { ConnectionPanel as MainConnectionPanel } from "../../features/sidepanel/ConnectionPanel";
import { SCHEMES, type TerminalScheme } from "../terminal/schemes";
import { msg } from "../../lib/messages";
import { IconCheck } from "../../components/ui/icons";

export type { PanelSection } from "../../features/sidepanel/ConnectionPanel";

function Sample({ scheme }: { scheme: TerminalScheme }) {
  return (
    <span className="theme-sample" style={{ background: scheme.background, color: scheme.foreground }}>
      <span>
        <span style={{ color: scheme.green }}>ops</span>
        <span style={{ color: scheme.brightBlack }}>@</span>
        <span style={{ color: scheme.blue }}>web-01</span>
        <span>:~$ ls</span>
      </span>
      <span>
        <span style={{ color: scheme.blue }}>app </span>
        <span style={{ color: scheme.cyan }}>logs </span>
        <span style={{ color: scheme.yellow }}>run.sh</span>
      </span>
      <span className="theme-swatches" aria-hidden="true">
        {[scheme.red, scheme.green, scheme.yellow, scheme.blue, scheme.magenta, scheme.cyan].map((c) => (
          <span key={c} style={{ background: c }} />
        ))}
        <span className="theme-cursor" style={{ background: scheme.cursor }} />
      </span>
    </span>
  );
}

function ThemeCards({ host }: { host: HTMLElement }) {
  const { prefs, update } = usePreferences();
  const current = prefs.terminal.scheme;
  return createPortal(
    <div className="theme-cards" aria-hidden="true">
      {SCHEMES.map((scheme) => (
        <button
          key={scheme.id}
          type="button"
          tabIndex={-1}
          className="theme-card"
          data-current={scheme.id === current || undefined}
          title={scheme.name}
          onClick={() => update((p) => ({ ...p, terminal: { ...p.terminal, scheme: scheme.id } }))}
        >
          <Sample scheme={scheme} />
          <span className="theme-card-name truncate">{scheme.name}</span>
          {scheme.id === current && (
            <span className="theme-check">
              <IconCheck size={11} />
            </span>
          )}
        </button>
      ))}
    </div>,
    host,
  );
}

export function ConnectionPanel(props: ComponentProps<typeof MainConnectionPanel>) {
  const root = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  // Find main's scheme select whenever the Appearance section is shown, and give the cards a home
  // just before its row.
  useEffect(() => {
    const panel = root.current;
    if (!panel || props.section !== "appearance") {
      setHost(null);
      return;
    }
    const place = () => {
      const select = panel.querySelector<HTMLSelectElement>(`select[aria-label="${CSS.escape(msg.settings.scheme)}"]`);
      const row = select?.closest<HTMLElement>(".setting-row");
      if (!row) return false;
      let slot = row.previousElementSibling as HTMLElement | null;
      if (!slot?.classList.contains("theme-cards-slot")) {
        slot = document.createElement("div");
        slot.className = "theme-cards-slot";
        row.before(slot);
      }
      setHost(slot);
      return true;
    };
    if (place()) return;
    const watch = new MutationObserver(() => {
      if (place()) watch.disconnect();
    });
    watch.observe(panel, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [props.section]);

  return (
    <div ref={root} className="ag-side-panel">
      <MainConnectionPanel {...props} />
      {host && host.isConnected && <ThemeCards host={host} />}
    </div>
  );
}
