import type { ActiveTunnel, HostSummary, TunnelSummary } from "@tyrminal/contracts";
import { useCallback, useEffect, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Dialog } from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useToast } from "../../components/ui/Toasts";
import { BoxEmpty, ErrorNotice, IconButton, SkeletonRows } from "../../components/ui/controls";
import { IconCopy, IconEllipsis, IconPencil, IconPlay, IconPlus, IconRoute, IconTrash2, IconUnplug } from "../../components/ui/icons";
import { tunnels as tunnelsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { endpoint, msgB } from "../../lib/messages-b";
import { useLoaded } from "../../lib/useAsync";
import { TunnelEditor } from "./TunnelEditor";
import { defaultListen } from "./rules";

/** A connected SSH session of this window, as the shell knows it. */
export interface ConnectedSession {
  sessionId: string;
  hostId: string;
  label: string;
}

/** How often the active list refreshes while the page is open. */
const POLL_MS = 1000;

function listenOf(t: { kind: TunnelSummary["kind"]; bindHost: string }, port: number | string) {
  return endpoint(t.bindHost || defaultListen(t.kind), port);
}

function ruleMapping(t: TunnelSummary): string {
  const listen = listenOf(t, t.bindPort || msgB.tunnels.autoPort);
  return msgB.tunnels.mapping(t.kind, listen, endpoint(t.destHost, t.destPort));
}

function runMapping(r: ActiveTunnel): string {
  const listen = listenOf(r, r.boundPort || msgB.tunnels.autoPort);
  return msgB.tunnels.mapping(r.kind, listen, endpoint(r.destHost, r.destPort));
}

/** The Tunnels page: saved forwarding rules, and the forwards running on this window's sessions. */
export function TunnelsView({ sessions, onConnect }: { sessions: ConnectedSession[]; onConnect: (host: HostSummary) => void }) {
  const { hosts } = useVaultData();
  const rules = useLoaded(tunnelsApi.list);
  const active = useLoaded(tunnelsApi.active);
  const notify = useToast();
  const [editing, setEditing] = useState<{ tunnel: TunnelSummary | null } | null>(null);
  const [deleting, setDeleting] = useState<TunnelSummary | null>(null);
  const [menu, setMenu] = useState<{ tunnel: TunnelSummary; anchor: HTMLElement } | null>(null);
  const reloadActive = active.reload;

  useEffect(() => {
    const timer = window.setInterval(() => void reloadActive(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [reloadActive]);

  const fail = useCallback((error: unknown) => notify("danger", (error as Error).message), [notify]);

  async function start(rule: TunnelSummary, session: ConnectedSession) {
    try {
      const run = await tunnelsApi.start(session.sessionId, rule.id);
      notify("success", msgB.tunnels.started(rule.name, listenOf(run, run.boundPort)));
      void reloadActive();
    } catch (error) {
      fail(error);
    }
  }

  async function stop(run: ActiveTunnel) {
    try {
      await tunnelsApi.stop(run.runId);
      notify("info", msgB.tunnels.stopped(run.name));
      void reloadActive();
    } catch (error) {
      fail(error);
    }
  }

  async function duplicate(rule: TunnelSummary) {
    try {
      await tunnelsApi.duplicate(rule.id);
      void rules.reload();
    } catch (error) {
      fail(error);
    }
  }

  async function remove(rule: TunnelSummary) {
    try {
      await tunnelsApi.remove(rule.id);
      void rules.reload();
    } catch (error) {
      fail(error);
    }
  }

  const runs = active.value ?? [];
  const running = runs.filter((r) => r.state === "running");
  const ended = runs.filter((r) => r.state !== "running");
  const all = rules.value ?? [];
  const hostList = hosts.value ?? [];

  return (
    <div className="page">
      <section className="page-inner stack" aria-labelledby="tunnels-title">
        <div className="page-header">
          <div className="page-title">
            <h1 id="tunnels-title">{msgB.tunnels.title}</h1>
            <p>{msgB.tunnels.subtitle}</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ tunnel: null })}>
            <IconPlus size={16} />
            {msgB.tunnels.add}
          </button>
        </div>

        <section className="section" aria-labelledby="tunnels-active">
          <div className="section-head">
            <h2 id="tunnels-active">{msgB.tunnels.running}</h2>
            <span className="spacer" />
            {ended.length > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void tunnelsApi.clearEnded().then(() => reloadActive(), fail)}
              >
                {msgB.tunnels.clearEnded}
              </button>
            )}
          </div>
          {runs.length === 0 ? (
            <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {msgB.tunnels.activeEmpty}
            </p>
          ) : (
            <ul className="list" aria-label={msgB.tunnels.running} data-testid="tunnel-runs">
              {[...running, ...ended].map((run) => (
                <li key={run.runId} data-run={run.name} data-state={run.state}>
                  <span className="tile-icon" aria-hidden="true">
                    <IconRoute size={17} />
                  </span>
                  <div className="row-main">
                    <span className="row-title">
                      {run.name} <span className="badge">{msgB.tunnels.kinds[run.kind]}</span>{" "}
                      <span className={run.state === "running" ? "badge badge-success" : run.state === "failed" ? "badge badge-danger" : "badge"}>
                        {msgB.tunnels.states[run.state]}
                      </span>
                    </span>
                    <span className="row-sub mono selectable">{runMapping(run)}</span>
                    {run.error ? (
                      <span className="row-sub" role="note">
                        {run.error.message}
                      </span>
                    ) : (
                      <span className="row-sub">
                        {msgB.tunnels.counters(run.activeConnections, run.totalConnections, run.bytesOut, run.bytesIn)}
                        {run.refusedConnections > 0 && ` · ${msgB.tunnels.refused(run.refusedConnections)}`}
                        {run.failedConnections > 0 && ` · ${msgB.tunnels.failedConnections(run.failedConnections)}`}
                      </span>
                    )}
                  </div>
                  {run.state === "running" && (
                    <button type="button" className="btn btn-sm" aria-label={msgB.tunnels.stopNamed(run.name)} onClick={() => void stop(run)}>
                      <IconUnplug size={13} />
                      {msgB.tunnels.stop}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="section" aria-labelledby="tunnels-saved">
          <div className="section-head">
            <h2 id="tunnels-saved">{msgB.tunnels.saved}</h2>
          </div>
          <ErrorNotice error={rules.error} />
          {rules.value === null && !rules.error && <SkeletonRows count={2} />}
          {rules.value && all.length === 0 && (
            // The page header has the one "New tunnel" button.
            <BoxEmpty title={msgB.tunnels.emptyTitle}>{msgB.tunnels.emptyBody}</BoxEmpty>
          )}
          {all.length > 0 && (
            <ul className="list" aria-label={msgB.tunnels.saved} data-testid="tunnel-rules">
              {all.map((rule) => {
                const host = hostList.find((h) => h.id === rule.hostId);
                const targets = sessions.filter((s) => s.hostId === rule.hostId);
                const isRunning = running.some((r) => r.tunnelId === rule.id && targets.some((t) => t.sessionId === r.sessionId));
                const target = targets[0];
                return (
                  <li key={rule.id} data-rule={rule.name}>
                    <span className="tile-icon" aria-hidden="true">
                      <IconRoute size={17} />
                    </span>
                    <div className="row-main">
                      <span className="row-title">
                        {rule.name} <span className="badge">{msgB.tunnels.kinds[rule.kind]}</span>
                        {rule.autoStart && <span className="badge badge-accent"> {msgB.tunnels.autoBadge}</span>}
                        {rule.allowExternal && <span className="badge badge-warning"> {msgB.tunnels.exposedBadge}</span>}
                      </span>
                      <span className="row-sub mono selectable">{ruleMapping(rule)}</span>
                      <span className="row-sub">
                        {rule.hostLabel ?? msgB.tunnels.hostMissing}
                        {targets.length > 0 && ` · ${msgB.tunnels.sessionsFor(targets.length)}`}
                      </span>
                    </div>
                    <div className="row-actions">
                      {target ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={isRunning}
                          aria-label={msgB.tunnels.startOn(rule.name, target.label)}
                          onClick={() => void start(rule, target)}
                        >
                          <IconPlay size={13} />
                          {msgB.tunnels.start}
                        </button>
                      ) : host ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          title={msgB.tunnels.connectFirst(host.label)}
                          onClick={() => onConnect(host)}
                        >
                          {msgB.tunnels.connect}
                        </button>
                      ) : null}
                      <IconButton
                        size="sm"
                        label={msgB.tunnels.more(rule.name)}
                        aria-haspopup="menu"
                        onClick={(event) => setMenu({ tunnel: rule, anchor: event.currentTarget })}
                      >
                        <IconEllipsis size={15} />
                      </IconButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </section>

      {menu && (
        <Menu
          label={msgB.tunnels.more(menu.tunnel.name)}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={[
            { label: msgB.tunnels.edit, icon: <IconPencil size={15} />, onSelect: () => setEditing({ tunnel: menu.tunnel }) },
            { label: msgB.tunnels.duplicate, icon: <IconCopy size={15} />, onSelect: () => void duplicate(menu.tunnel) },
            "separator",
            { label: msgB.tunnels.delete, icon: <IconTrash2 size={15} />, tone: "danger", onSelect: () => setDeleting(menu.tunnel) },
          ]}
        />
      )}

      {editing && (
        <TunnelEditor
          tunnel={editing.tunnel}
          hosts={hostList}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void rules.reload();
          }}
        />
      )}

      {deleting && (
        <Dialog title={msgB.tunnels.deleteTitle(deleting.name)} role="alertdialog" icon={<IconTrash2 size={18} />} tone="danger" onDismiss={() => setDeleting(null)}>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msgB.tunnels.deleteBody}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDeleting(null)} autoFocus data-autofocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                const target = deleting;
                setDeleting(null);
                void remove(target);
              }}
            >
              {msg.common.delete}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
