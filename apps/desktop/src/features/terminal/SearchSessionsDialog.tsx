import { useEffect, useMemo, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { IconSearch } from "../../components/ui/icons";
import { msgOutput } from "../../lib/messages-output";
import type { PaneHandle } from "./TerminalView";
import { MAX_QUERY, type ScrollbackMatch } from "./scrollbackSearch";

export interface SearchTab {
  tabId: number;
  title: string;
  panes: { paneId: number; label: string; handle: PaneHandle }[];
}

interface PaneResult {
  paneId: number;
  label: string;
  matches: ScrollbackMatch[];
  truncated: boolean;
}

/**
 * Search across all open sessions (P-28). It reads each terminal's scrollback in memory through
 * its pane handle; the query is never stored, sent or logged. Choosing a match focuses its tab
 * and pane and scrolls to it.
 */
export function SearchSessionsDialog({
  tabs,
  onReveal,
  onClose,
}: {
  tabs: SearchTab[];
  onReveal: (paneId: number, match: ScrollbackMatch) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [settled, setSettled] = useState({ query: "", caseSensitive: false });

  // Search after typing pauses, so large scrollbacks are not scanned on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled({ query, caseSensitive }), 150);
    return () => window.clearTimeout(timer);
  }, [query, caseSensitive]);

  const results = useMemo(() => {
    if (!settled.query) return [];
    return tabs
      .map((tab) => ({
        tab,
        panes: tab.panes
          .map((p): PaneResult => ({ paneId: p.paneId, label: p.label, ...p.handle.searchScrollback(settled.query, settled.caseSensitive) }))
          .filter((p) => p.matches.length > 0),
      }))
      .filter((t) => t.panes.length > 0);
  }, [tabs, settled]);

  const total = results.reduce((n, t) => n + t.panes.reduce((m, p) => m + p.matches.length, 0), 0);
  return (
    <Dialog title={msgOutput.searchTitle} icon={<IconSearch size={18} />} wide onDismiss={onClose}>
      <div className="stack-sm">
        <div className="row-flex" style={{ gap: "var(--space-3)", alignItems: "center" }}>
          <input
            className="input"
            type="search"
            aria-label={msgOutput.searchLabel}
            placeholder={msgOutput.searchLabel}
            value={query}
            maxLength={MAX_QUERY}
            autoFocus
            data-autofocus
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            style={{ flex: 1 }}
          />
          <label className="row-flex" style={{ gap: 6, whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />
            {msgOutput.caseSensitive}
          </label>
        </div>
        <p className="hint">{msgOutput.searchHint}</p>
        <p role="status" className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {!settled.query ? msgOutput.searchEmpty : total === 0 ? msgOutput.searchNone : msgOutput.searchSummary(total, results.length)}
        </p>
        <div className="search-results" data-testid="search-results">
          {results.map(({ tab, panes }) => (
            <section key={tab.tabId} aria-label={tab.title}>
              <h3 className="label">{tab.title}</h3>
              {panes.map((pane) => (
                <div key={pane.paneId} className="stack-xs">
                  {tab.panes.length > 1 && <span className="faint">{pane.label}</span>}
                  <ul className="search-matches">
                    {pane.matches.map((m) => (
                      <li key={`${m.row}:${m.col}`}>
                        <button type="button" className="search-match mono" onClick={() => onReveal(pane.paneId, m)}>
                          {m.preview.slice(0, m.at)}
                          <mark>{m.preview.slice(m.at, m.at + m.length)}</mark>
                          {m.preview.slice(m.at + m.length)}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {pane.truncated && <p className="hint">{msgOutput.searchTruncated}</p>}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
