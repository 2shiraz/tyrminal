// The boxes on Home (docs/design/revamp.md §5.2). Each is a section labelled by its strip heading,
// filled with rows from data the app already has. Nothing here connects, runs or sends without the
// existing flows: connecting goes through the trust and sign-in prompts, snippets through the run
// review, and the security review is local and read-only.
import type { ActiveTunnel, HostSummary, SecurityFinding, SecurityReview, SnippetSummary, TunnelSummary } from "@tyrminal/contracts";
import { type ReactNode, useEffect, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { type Workspace, tabStatus, tabTitle } from "../../app/workspace";
import { Box } from "../../components/ui/Box";
import { BoxEmpty, relativeTime } from "../../components/ui/controls";
import { IconPlay, IconServer, IconX } from "../../components/ui/icons";
import { backup as backupApi, securityReview as reviewApi, tunnels as tunnelsApi, vault as vaultApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgC } from "../../lib/messages-c";
import { severityOf } from "../security-review/SecurityReviewSection";
import type { PaneStatus } from "../terminal/TerminalView";
import { ExportBackupButton } from "../vault/BackupRestore";

const ROWS = 8;

export function SessionsBox({
  ws,
  statuses,
  onSelectTab,
  onNewTab,
}: {
  ws: Workspace;
  statuses: Record<number, PaneStatus>;
  onSelectTab: (id: number) => void;
  onNewTab: () => void;
}) {
  return (
    <Box
      title={msg.home.sessions}
      count={ws.tabs.length}
      flush
      actions={
        <button type="button" className="btn btn-ghost btn-sm" onClick={onNewTab}>
          {msg.home.newTab}
        </button>
      }
    >
      <ul className="home-rows" aria-label={msg.home.open}>
        {ws.tabs.map((tab) => {
          const pane = ws.panes[tab.focused];
          const status = pane ? statuses[pane.id] : undefined;
          const summary = tabStatus(ws, tab);
          return (
            <li key={tab.id}>
              <button type="button" className="home-row" onClick={() => onSelectTab(tab.id)}>
                <span className="status-dot" data-tone={summary.indicator} data-unread={summary.unread || undefined} aria-hidden="true" />
                <span className="home-row-title truncate">
                  {tabTitle(ws, tab)}
                  <span className="visually-hidden">{msgC.status.describe(summary)}</span>
                </span>
                <span className="home-row-detail mono truncate">{pane?.identity}</span>
                <span className="home-row-meta">{status?.cols ? `${status.cols}×${status.rows}` : ""}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Box>
  );
}

/**
 * Saved hosts, most recently used first. A click selects a row and a double-click connects; the
 * Connect button in each row is the keyboard and assistive-technology path.
 */
/** The hosts table shared by the hosts and favourites boxes. */
function HostRows({ rows, onConnect }: { rows: HostSummary[]; onConnect: (host: HostSummary) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="box-scroll">
      <table className="dt home-hosts">
        <thead>
          <tr>
            <th scope="col">{msg.home.colName}</th>
            <th scope="col">{msg.home.colAddress}</th>
            <th scope="col">{msg.home.colSignIn}</th>
            <th scope="col">{msg.home.colWhen}</th>
            <th scope="col">
              <span className="visually-hidden">{msg.home.connect}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((host) => (
            <tr key={host.id} className={selected === host.id ? "is-selected" : undefined} onClick={() => setSelected(host.id)} onDoubleClick={() => onConnect(host)}>
              <td>
                <span className="home-host">
                  <IconServer size={14} className="faint" />
                  <span className="truncate">{host.label}</span>
                </span>
              </td>
              <td className="mono muted">{msg.hosts.destination(host.username, host.address, host.port)}</td>
              <td className="muted">{msg.home.signIn[host.auth.kind]}</td>
              <td className="muted">{host.lastConnectedAt ? relativeTime(host.lastConnectedAt) : msg.home.never}</td>
              <td className="dt-action">
                <button type="button" className="btn btn-ghost btn-sm" aria-label={msg.hosts.connectTo(host.label)} onClick={() => onConnect(host)}>
                  {msg.home.connect}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Starred hosts, by name. Shown only when there are any. */
export function FavouritesBox({ onConnect }: { onConnect: (host: HostSummary) => void }) {
  const { hosts } = useVaultData();
  const rows = (hosts.value ?? []).filter((h) => h.favourite).sort((a, b) => a.label.localeCompare(b.label));
  if (rows.length === 0) return null;
  return (
    <Box title={msg.home.favourites} count={rows.length} flush>
      <HostRows rows={rows} onConnect={onConnect} />
    </Box>
  );
}

export function HostsBox({ onConnect, onAllHosts }: { onConnect: (host: HostSummary) => void; onAllHosts: () => void }) {
  const { hosts } = useVaultData();
  const all = hosts.value ?? [];
  const rows = [...all].sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0) || a.label.localeCompare(b.label)).slice(0, ROWS);
  return (
    <Box
      title={msg.home.hosts}
      count={all.length}
      flush
      actions={
        <button type="button" className="btn btn-ghost btn-sm" onClick={onAllHosts}>
          {msg.home.allHosts}
        </button>
      }
    >
      {rows.length === 0 ? <BoxEmpty>{msg.home.recentEmpty}</BoxEmpty> : <HostRows rows={rows} onConnect={onConnect} />}
    </Box>
  );
}

export function SnippetsBox({ canRun, onRun, onLibrary }: { canRun: boolean; onRun: (snippet: SnippetSummary) => void; onLibrary: () => void }) {
  const { snippets } = useVaultData();
  const list = [...(snippets.value ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  if (list.length === 0) return null;
  return (
    <Box
      title={msg.home.snippets}
      count={snippets.value?.length}
      flush
      actions={
        <button type="button" className="btn btn-ghost btn-sm" onClick={onLibrary}>
          {msg.home.library}
        </button>
      }
    >
      <ul className="home-rows" aria-label={msg.home.snippets}>
        {list.map((snippet) => (
          <li key={snippet.id} className="home-row" data-static="">
            <span className="home-row-title truncate">{snippet.name}</span>
            <span className="home-row-detail mono truncate">{snippet.text.split("\n")[0]}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={msg.home.runInNamed(snippet.name)}
              disabled={!canRun}
              data-tooltip={canRun ? undefined : msg.home.runNeedsSession}
              onClick={() => onRun(snippet)}
            >
              <IconPlay size={13} />
              {msg.home.runIn}
            </button>
          </li>
        ))}
      </ul>
    </Box>
  );
}

export function VaultBox({ onLock }: { onLock: () => void }) {
  const { hosts, keys, snippets } = useVaultData();
  const [quick, setQuick] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    vaultApi
      .quickUnlockStatus()
      .then((on) => live && setQuick(on))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  // When this vault was last backed up; `undefined` until known.
  const [lastBackup, setLastBackup] = useState<number | null | undefined>(undefined);
  const loadBackup = () =>
    void backupApi
      .status()
      .then((s) => setLastBackup(s.lastExportAt))
      .catch(() => undefined);
  useEffect(loadBackup, []);
  const counts = msg.home.counts(hosts.value?.length ?? 0, keys.value?.length ?? 0, snippets.value?.length ?? 0);
  return (
    <Box title={msg.home.vault} flush>
      <div className="home-facts">
        <p>
          <span>{msg.home.unlocked}</span>
          {quick !== null && <span className="muted">{quick ? msg.home.quickUnlockOn : msg.home.quickUnlockOff}</span>}
        </p>
        <p className="muted">
          {counts.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </p>
        {lastBackup !== undefined && (
          <p className="muted" data-testid="home-last-backup">
            {lastBackup === null ? msg.home.neverBackedUp : msg.home.lastBackup(relativeTime(lastBackup))}
          </p>
        )}
      </div>
      <div className="home-box-foot">
        <button type="button" className="btn btn-sm" onClick={onLock}>
          {msg.home.lockNow}
        </button>
        <ExportBackupButton onExported={loadBackup} />
      </div>
    </Box>
  );
}

interface ReviewRow {
  kind: SecurityFinding["kind"];
  count: number;
  tone: "danger" | "warning" | "note";
}

/** Counted sentences per finding kind, most serious first. */
function summarise(review: SecurityReview): ReviewRow[] {
  const rows = new Map<SecurityFinding["kind"], ReviewRow>();
  for (const finding of review.findings) {
    const severity = severityOf(finding);
    const tone = severity === "high" ? "danger" : severity === "medium" ? "warning" : "note";
    const row = rows.get(finding.kind) ?? { kind: finding.kind, count: 0, tone };
    row.count += 1;
    rows.set(finding.kind, row);
  }
  const rank = { danger: 0, warning: 1, note: 2 };
  return [...rows.values()].sort((a, b) => rank[a.tone] - rank[b.tone]);
}

const REVIEW_KEY = "home.securityReview";

/**
 * The local security review, run once per unlock after Home has painted and kept for the rest of the
 * unlock. It reads labels and counts only; the password check (the one networked check) is never
 * run from here.
 */
export function ReviewBox({ onOpen }: { onOpen: () => void }) {
  const { memo } = useVaultData();
  const [review, setReview] = useState<SecurityReview | null>(() => (memo.get(REVIEW_KEY) as SecurityReview | undefined) ?? null);
  useEffect(() => {
    if (review) return;
    let live = true;
    const run = () =>
      reviewApi
        .run()
        .then((result) => {
          memo.set(REVIEW_KEY, result);
          if (live) setReview(result);
        })
        .catch(() => undefined);
    const idle = window.requestIdleCallback ? window.requestIdleCallback(run, { timeout: 1500 }) : window.setTimeout(run, 200);
    return () => {
      live = false;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, [memo, review]);
  const rows = review ? summarise(review) : [];
  return (
    <Box
      title={msg.home.review}
      count={review ? review.findings.length : undefined}
      flush
      actions={
        <button type="button" className="btn btn-ghost btn-sm" onClick={onOpen}>
          {msg.home.reviewOpen}
        </button>
      }
    >
      {!review ? (
        <BoxEmpty>{msg.home.reviewChecking}</BoxEmpty>
      ) : rows.length === 0 ? (
        <BoxEmpty>{msg.home.reviewClean(review.keys, review.hosts)}</BoxEmpty>
      ) : (
        <ul className="home-rows home-findings">
          {rows.slice(0, 3).map((row) => (
            <li key={row.kind} className="home-row" data-static="" data-tone={row.tone}>
              {msg.home.reviewKinds[row.kind]?.(row.count)}
            </li>
          ))}
        </ul>
      )}
      {review && <p className="home-box-note">{msg.home.reviewChecked(relativeTime(review.reviewedAt))}</p>}
    </Box>
  );
}

function endpoint(host: string, port: number) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function ForwardsBox({ onTunnels }: { onTunnels: () => void }) {
  const [saved, setSaved] = useState<TunnelSummary[] | null>(null);
  const [active, setActive] = useState<ActiveTunnel[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([tunnelsApi.list(), tunnelsApi.active()])
      .then(([list, running]) => {
        if (!live) return;
        setSaved(list);
        setActive(running.filter((t) => t.state === "running"));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [version]);
  if (!saved || saved.length === 0) return null;
  const auto = saved.filter((t) => t.autoStart).length;
  return (
    <Box
      title={msg.home.forwards}
      count={active.length}
      flush
      actions={
        <button type="button" className="btn btn-ghost btn-sm" onClick={onTunnels}>
          {msg.home.tunnels}
        </button>
      }
    >
      {active.length > 0 && (
        <ul className="home-rows" aria-label={msg.home.forwards}>
          {active.map((t) => (
            <li key={t.runId} className="home-row" data-static="">
              <span className="status-dot" data-tone="ok" aria-hidden="true" />
              <span className="home-row-title truncate">{t.name}</span>
              <span className="home-row-detail mono truncate">
                {t.kind === "dynamic" ? `${endpoint(t.bindHost, t.boundPort)} ${msg.home.forwardSocks}` : msg.home.forwardRoute(endpoint(t.bindHost, t.boundPort), endpoint(t.destHost, t.destPort))}
              </span>
              <span className="home-row-meta">{msg.home.forwardConnections(t.activeConnections)}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                aria-label={msg.home.stopForward(t.name)}
                data-tooltip={msg.home.stopForward(t.name)}
                onClick={() => void tunnelsApi.stop(t.runId).finally(() => setVersion((v) => v + 1))}
              >
                <IconX size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="home-box-note">{msg.home.forwardsSaved(saved.length, auto)}</p>
    </Box>
  );
}

export function GetStartedBox({ rows }: { rows: { key: string; title: string; body: string; icon: ReactNode; onClick: () => void }[] }) {
  return (
    <Box title={msg.home.getStarted}>
      <ul className="home-rows">
        {rows.map((row) => (
          <li key={row.key}>
            <button type="button" className="home-row home-start" onClick={row.onClick}>
              <span className="home-start-icon" aria-hidden="true">
                {row.icon}
              </span>
              <span className="home-row-title">{row.title}</span>
              <span className="home-row-detail truncate">{row.body}</span>
            </button>
          </li>
        ))}
      </ul>
    </Box>
  );
}
