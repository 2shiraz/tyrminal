import { useEffect, useRef, useState } from "react";

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
/** Matches listed before "More…" is offered, and how many more each press adds. */
export const PAGE = 500;
/** Rows read from one terminal per step. */
const CHUNK_ROWS = 2000;
/** Time one step may take before it yields to the page (typing stays responsive). */
const STEP_MS = 8;

interface SearchView {
  results: { tab: SearchTab; panes: PaneResult[] }[];
  total: number;
  running: boolean;
  /** Stopped at the limit with terminals or rows still to search. */
  capped: boolean;
}

const EMPTY_VIEW: SearchView = { results: [], total: 0, running: false, capped: false };

interface SearchJob {
  query: string;
  caseSensitive: boolean;
  /** Where each terminal's search stands, in tab order. */
  cursors: { tabId: number; paneId: number; row: number }[];
  /** The terminal being searched. */
  index: number;
  limit: number;
  found: Map<number, ScrollbackMatch[]>;
  total: number;
  cancelled: boolean;
  timer: number;
}

/**
 * Runs a search in small steps on the page's own timers: each step reads at most CHUNK_ROWS rows
 * of one terminal and yields after STEP_MS, so typing never waits on a large scrollback. It stops
 * at the job's limit until "More…" raises it. Everything stays in memory; nothing is logged.
 */
function run(job: SearchJob, setView: (view: SearchView) => void, tabsRef: { current: SearchTab[] }) {
  const publish = (running: boolean, capped: boolean) => {
    const results = tabsRef.current
      .map((tab) => ({
        tab,
        panes: tab.panes.flatMap((p): PaneResult[] => {
          const matches = job.found.get(p.paneId);
          return matches?.length ? [{ paneId: p.paneId, label: p.label, matches, truncated: false }] : [];
        }),
      }))
      .filter((t) => t.panes.length > 0);
    setView({ results, total: job.total, running, capped });
  };
  const step = () => {
    if (job.cancelled) return;
    const started = performance.now();
    while (job.index < job.cursors.length && performance.now() - started < STEP_MS) {
      if (job.total >= job.limit) {
        publish(false, true);
        return;
      }
      const cursor = job.cursors[job.index] as SearchJob["cursors"][number];
      const handle = tabsRef.current.find((t) => t.tabId === cursor.tabId)?.panes.find((p) => p.paneId === cursor.paneId)?.handle;
      if (!handle) {
        job.index += 1;
        continue;
      }
      const result = handle.searchScrollback(job.query, job.caseSensitive, { from: cursor.row, rows: CHUNK_ROWS, max: job.limit - job.total });
      if (result.matches.length > 0) {
        job.found.set(cursor.paneId, [...(job.found.get(cursor.paneId) ?? []), ...result.matches]);
        job.total += result.matches.length;
      }
      cursor.row = result.next;
      if (result.next >= result.length) job.index += 1;
    }
    const done = job.index >= job.cursors.length;
    publish(!done, false);
    if (!done) job.timer = window.setTimeout(step, 0);
  };
  step();
}

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
  const [view, setView] = useState<SearchView>(EMPTY_VIEW);
  const job = useRef<SearchJob | null>(null);
  // The panes as they are now; a running search reads them through this, so a re-render of the
  // shell never restarts it.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Search after typing pauses, so large scrollbacks are not scanned on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled({ query, caseSensitive }), 150);
    return () => window.clearTimeout(timer);
  }, [query, caseSensitive]);

  // A new query starts a new search; the old one stops at its next step.
  useEffect(() => {
    if (job.current) job.current.cancelled = true;
    job.current = null;
    if (!settled.query) {
      setView(EMPTY_VIEW);
      return;
    }
    const next: SearchJob = {
      query: settled.query,
      caseSensitive: settled.caseSensitive,
      cursors: tabsRef.current.flatMap((tab) => tab.panes.map((pane) => ({ tabId: tab.tabId, paneId: pane.paneId, row: 0 }))),
      index: 0,
      limit: PAGE,
      found: new Map(),
      total: 0,
      cancelled: false,
      timer: 0,
    };
    job.current = next;
    setView({ ...EMPTY_VIEW, running: true });
    run(next, setView, tabsRef);
    return () => {
      next.cancelled = true;
      window.clearTimeout(next.timer);
    };
  }, [settled]);

  const results = view.results;
  const total = view.total;
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
          {!settled.query
            ? msgOutput.searchEmpty
            : total === 0
              ? view.running
                ? msgOutput.searchSearching
                : msgOutput.searchNone
              : msgOutput.searchSummary(total, results.length)}
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
                </div>
              ))}
            </section>
          ))}
        </div>
        {view.capped && (
          <div className="row-flex" style={{ gap: "var(--space-3)", alignItems: "center" }}>
            <span className="hint">{msgOutput.searchCapped(total)}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const current = job.current;
                if (!current || current.cancelled) return;
                current.limit += PAGE;
                setView((v) => ({ ...v, capped: false, running: true }));
                run(current, setView, tabsRef);
              }}
            >
              {msgOutput.searchMore}
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
