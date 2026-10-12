import type { HostSummary, RemoteEntry, SessionEvent, SessionState } from "@tyrminal/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import type { MenuEntry } from "../../components/ui/Menu";
import { BoxEmpty, ErrorNotice } from "../../components/ui/controls";
import {
  IconFolderOpen,
  IconHardDrive,
  IconRefreshCw,
  IconSearch,
  IconShieldAlert,
  IconShieldCheck,
  IconTriangleAlert,
  IconUnplug,
} from "../../components/ui/icons";
import { files as filesApi, sessions, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import { FILE_DRAG, type FileDrag, FilePane, type PaneBackend, type PaneView, emptyView, localBackend, remoteBackend } from "../files/FilePane";
import { AuthDialog, Fingerprint } from "../terminal/TerminalView";
import { HopNotice } from "../tunnels/HopNotice";
import { msgFiles } from "../files/messages";
import { OsIcon } from "../hosts/OsIcon";
import { useHostOs } from "./hostOs";
import { msgSftp } from "./messages";
import type { Endpoint, Loc } from "./model";

export type Side = "left" | "right";

export type Source = { kind: "none" } | { kind: "local" } | { kind: "host"; hostId: string; label: string };

type Trust = Extract<SessionEvent, { type: "trust_prompt" }>;
type Auth = Extract<SessionEvent, { type: "auth_prompt" }>;
type Changed = Extract<SessionEvent, { type: "host_key_changed" }>;

interface Connection {
  sessionId: string | null;
  state: SessionState | "starting";
  trust: Trust | null;
  auth: Auth | null;
  changed: Changed | null;
  banner: string | null;
  error: { code: string; message: string } | null;
}

/** How a pane is doing, for the tab's indicator. */
export type PaneHealth = "idle" | "busy" | "ok" | "bad" | "attention";

/** What the tab offers a pane for moving items (it runs the transfer queue). */
export interface PaneTransfers {
  /** "Copy to <the other pane>", or null while the other pane shows nothing. */
  copyLabel: string | null;
  copy: (entries: RemoteEntry[]) => void;
  /** Items dragged here from the other pane. */
  dropFrom: (entries: RemoteEntry[]) => void;
  /** Files dropped here from the desktop (a server pane only). */
  dropFiles: (files: DataTransfer) => void;
  download: (entries: RemoteEntry[]) => void;
  upload: () => void;
  uploadFolder: () => void;
  duplicate: (entries: RemoteEntry[]) => void;
}

/** What a location tab shows about its location. */
export interface LocationStatus {
  label: string;
  kind: Source["kind"];
  /** The saved host shown, so Open in SFTP finds a location already on it. */
  hostId: string | null;
  health: PaneHealth;
}

/**
 * One location of an SFTP pane: this computer (a folder the user chose) or a saved host over a
 * files-only connection, browsed with the same pane as the Files panel. It stays mounted while
 * another location of the pane is shown, so switching back neither reconnects nor lists again.
 * The connection belongs to this location; it is closed when the location changes source, is
 * closed, or the tab closes.
 */
export function SftpLocation({
  paneId,
  initial,
  startPath = null,
  hosts,
  visible,
  shown,
  active,
  refreshKey,
  transfers,
  goRequest = null,
  onEndpoint,
  onStatus,
  onOpenKnownHosts,
}: {
  /** Names the pane in drag payloads (stays with the pane when the panes swap sides). */
  paneId: string;
  initial: Source;
  /** A server folder to open first (Open in SFTP from a session's Files panel). */
  startPath?: string | null;
  /** This location is the one its pane shows. */
  shown: boolean;
  /** Goes to a server folder each time `seq` changes (Open in SFTP on a location already open). */
  goRequest?: { path: string; seq: number } | null;
  /** Saved SSH hosts, for the picker. */
  hosts: HostSummary[];
  /** Prompts appear only while the tab is in front. */
  visible: boolean;
  /** The pane has the keyboard (or was used last); the other pane's selection turns grey. */
  active: boolean;
  /** Bumped by the tab when a transfer into this pane's folder finished. */
  refreshKey: number;
  transfers: PaneTransfers;
  onEndpoint: (endpoint: Endpoint | null) => void;
  onStatus: (status: LocationStatus) => void;
  onOpenKnownHosts: () => void;
}) {
  const [source, setSource] = useState<Source>(initial);
  const [conn, setConn] = useState<Connection | null>(null);
  const [root, setRoot] = useState<(Loc & { kind: "local" }) | null>(null);
  const [view, setView] = useState<PaneView>(emptyView);
  const { pending, error, run, clearError } = useAction();
  const sessionRef = useRef<string | null>(null);
  const attempt = useRef(0);

  // ---------- connection ----------

  const closeSession = useCallback(() => {
    const id = sessionRef.current;
    sessionRef.current = null;
    if (id) void sessions.close(id).catch(() => undefined);
  }, []);

  // The connection lives as long as this pane shows its host.
  useEffect(() => closeSession, [closeSession]);

  const connect = useCallback(
    (hostId: string) => {
      closeSession();
      const mine = ++attempt.current;
      setView(emptyView());
      clearError();
      setConn({ sessionId: null, state: "starting", trust: null, auth: null, changed: null, banner: null, error: null });
      const patch = (change: Partial<Connection>) => {
        if (mine === attempt.current) setConn((c) => (c ? { ...c, ...change } : c));
      };
      const onEvent = (event: SessionEvent) => {
        if (mine !== attempt.current) return;
        switch (event.type) {
          case "state":
            patch({ state: event.state });
            break;
          case "trust_prompt":
            patch({ trust: event });
            break;
          case "auth_prompt":
            patch({ auth: event });
            break;
          case "host_key_changed":
            patch({ changed: event });
            break;
          case "banner":
            patch({ banner: event.text });
            break;
          case "closed":
            sessionRef.current = null;
            setConn((c) =>
              c && mine === attempt.current
                ? { ...c, sessionId: null, state: event.error ? "failed" : "closed", trust: null, auth: null, error: event.error }
                : c,
            );
            setView(emptyView());
            break;
          default:
            break;
        }
      };
      sessions
        .openFiles(hostId, onEvent)
        .then((opened) => {
          if (mine !== attempt.current) {
            void sessions.close(opened.sessionId).catch(() => undefined);
            return;
          }
          sessionRef.current = opened.sessionId;
          setConn((c) => (c ? { ...c, sessionId: opened.sessionId } : c));
        })
        .catch((caught) => {
          const e = toAppError(caught);
          patch({ state: "failed", error: { code: e.code, message: e.message } });
        });
    },
    [closeSession, clearError],
  );

  function choose(next: Source) {
    attempt.current += 1;
    closeSession();
    setConn(null);
    setRoot(null);
    setView(emptyView());
    clearError();
    setSource(next);
    if (next.kind === "host") connect(next.hostId);
  }

  // A host given at the start connects at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the first source.
  useEffect(() => {
    if (initial.kind === "host") connect(initial.hostId);
  }, []);

  async function chooseLocalFolder() {
    const pick = await run(() => filesApi.pickFolder());
    if (!pick) return;
    const listing = await run(() => filesApi.localList(pick.token, []));
    if (listing) {
      setRoot({ kind: "local", token: listing.token, rootName: listing.rootName, path: [] });
      setView(emptyView());
    }
  }

  // ---------- what the pane browses, and what the tab sees ----------

  const connected = source.kind === "host" && conn?.sessionId && conn.state === "connected" ? conn.sessionId : null;
  const backend: PaneBackend | null = useMemo(() => {
    if (source.kind === "host") return connected ? remoteBackend(connected, source.label) : null;
    if (source.kind === "local") return root ? localBackend(root) : null;
    return null;
  }, [source, connected, root]);

  const folder = view.folder;
  const endpoint: Endpoint | null = useMemo(() => {
    if (!folder || !backend) return null;
    if (folder.loc.kind === "local") return { kind: "local", token: folder.loc.token, rootName: folder.loc.rootName, path: folder.loc.path };
    if (source.kind === "host" && connected) return { kind: "remote", sessionId: connected, label: source.label, path: folder.loc.path };
    return null;
  }, [folder, backend, source, connected]);

  useEffect(() => onEndpoint(endpoint), [endpoint, onEndpoint]);

  const health: PaneHealth =
    source.kind !== "host" || !conn
      ? "idle"
      : conn.trust || conn.auth
        ? "attention"
        : conn.state === "connected"
          ? "ok"
          : conn.state === "failed"
            ? "bad"
            : conn.state === "closed"
              ? "idle"
              : "busy";

  const sshHosts = hosts.filter((h) => h.protocol.type === "ssh");
  const menuExtras: MenuEntry[] = [
    ...(source.kind === "local" ? [{ label: msgSftp.localChange, icon: <IconFolderOpen size={15} />, onSelect: () => void chooseLocalFolder() }] : []),
    ...(source.kind === "host" && conn?.sessionId ? [{ label: msgSftp.closeConnection, icon: <IconUnplug size={15} />, onSelect: () => choose({ kind: "none" }) }] : []),
  ];
  const sourceLabel = source.kind === "local" ? msgSftp.thisComputer : source.kind === "host" ? source.label : msgSftp.newLocation;
  const hostId = source.kind === "host" ? source.hostId : null;
  useEffect(() => onStatus({ label: sourceLabel, kind: source.kind, hostId, health }), [sourceLabel, source.kind, hostId, health, onStatus]);
  const remote = backend?.kind === "remote";
  const where = endpoint ? (endpoint.kind === "local" ? msgSftp.thisComputer : endpoint.label) : "";

  // ---------- render ----------

  const placeholder = (
    <div className="sftp-body">
      <ErrorNotice error={error} />
      {source.kind === "none" && <HostPicker hosts={sshHosts} onLocal={() => choose({ kind: "local" })} onHost={(h) => choose({ kind: "host", hostId: h.id, label: h.label })} />}
      {source.kind === "local" && (
        // Laid out as the host picker beside it: the same padding, a box with a strip head, its
        // sentence and action left-aligned, so two empty panes line up.
        <div className="sftp-picker-body">
          <p className="sftp-picker-note">{msgSftp.localBody}</p>
          <section className="section" aria-labelledby={`sftp-${paneId}-local-title`}>
            <div className="section-head">
              <IconHardDrive size={14} aria-hidden="true" />
              <h2 id={`sftp-${paneId}-local-title`}>{msgSftp.localTitle}</h2>
            </div>
            <BoxEmpty
              action={
                <button type="button" className="btn btn-primary" onClick={() => void chooseLocalFolder()} disabled={pending}>
                  <IconFolderOpen size={15} /> {msgSftp.localChoose}
                </button>
              }
            >
              {msgSftp.localNone}
            </BoxEmpty>
          </section>
        </div>
      )}
      {source.kind === "host" && conn && (
        <ConnectionState label={source.label} conn={conn} onReconnect={() => connect(source.hostId)} onOther={() => choose({ kind: "none" })} onOpenKnownHosts={onOpenKnownHosts} />
      )}
    </div>
  );

  return (
    <div className="sftp-location" hidden={!shown}>
      <FilePane
        id={paneId}
        label={source.kind === "host" ? msgFiles.serverPane(source.label) : source.kind === "local" ? msgFiles.serverPane(msgSftp.thisComputerLower) : msgSftp.connectTitle}
        backend={backend}
        view={view}
        setView={setView}
        start={source.kind === "local" ? root : startPath ? { kind: "remote", path: startPath } : null}
        goRequest={goRequest ? { loc: { kind: "remote", path: goRequest.path }, seq: goRequest.seq } : null}
        inactive={!active}
        refreshKey={refreshKey}
        placeholder={placeholder}
        menuExtras={menuExtras}
        onDownload={remote ? (entries) => transfers.download(entries) : undefined}
        onUpload={remote ? () => transfers.upload() : undefined}
        onUploadFolder={remote ? () => transfers.uploadFolder() : undefined}
        onDuplicate={remote ? (entries) => transfers.duplicate(entries) : undefined}
        copyOther={transfers.copyLabel ? { label: transfers.copyLabel, run: (entries) => transfers.copy(entries) } : null}
        drop={{
          accepts: (types) => types.includes(FILE_DRAG) || (remote && types.includes("Files")),
          onDrop: (data) => {
            const raw = data.getData(FILE_DRAG);
            if (raw) {
              const dragged = JSON.parse(raw) as FileDrag;
              if (dragged.pane !== paneId) transfers.dropFrom(dragged.entries);
            } else if (remote) transfers.dropFiles(data);
          },
          hint: msgSftp.dropHere(where),
        }}
        emptyHint={transfers.copyLabel ? msgSftp.emptyDrop : undefined}
      />


      {visible && conn?.trust && (
        <TrustDialog
          trust={conn.trust}
          onAnswer={(decision) => {
            const id = conn.sessionId ?? sessionRef.current;
            const promptId = conn.trust?.promptId;
            setConn((c) => (c ? { ...c, trust: null } : c));
            if (id && promptId) void sessions.answerTrust(id, promptId, decision).catch(() => undefined);
          }}
        />
      )}
      {visible && conn?.auth && !conn.trust && (
        <AuthDialog
          key={conn.auth.promptId}
          prompt={conn.auth}
          banner={conn.banner}
          onAnswer={(secret) => {
            const id = conn.sessionId ?? sessionRef.current;
            const promptId = conn.auth?.promptId;
            setConn((c) => (c ? { ...c, auth: null } : c));
            if (id && promptId) void sessions.answerAuth(id, promptId, secret).catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}

function HostPicker({ hosts, onLocal, onHost }: { hosts: HostSummary[]; onLocal: () => void; onHost: (host: HostSummary) => void }) {
  const [query, setQuery] = useState("");
  const osOf = useHostOs(hosts);
  const needle = query.trim().toLowerCase();
  const shown = hosts.filter((h) => !needle || h.label.toLowerCase().includes(needle) || h.address.toLowerCase().includes(needle));
  return (
    <div className="sftp-picker">
      {/* A note, then boxes with a strip head, as the local pane beside it and the Hosts page. */}
      <div className="sftp-picker-body">
        <p className="sftp-picker-note">{msgSftp.connectBody}</p>
        <div className="sftp-picker-list" role="group" aria-label={msgSftp.selectHost}>
          <section className="section" aria-labelledby="sftp-picker-local">
            <div className="section-head">
              <h2 id="sftp-picker-local">{msgSftp.thisComputer}</h2>
            </div>
            <ul className="list">
              <li>
                <button type="button" className="sftp-host" onClick={onLocal}>
                  <span className="os-icon os-icon-sm sftp-host-local" aria-hidden="true">
                    <IconHardDrive size={15} />
                  </span>
                  <span className="sftp-host-name">{msgSftp.thisComputer}</span>
                </button>
              </li>
            </ul>
          </section>
          <section className="section" aria-labelledby="sftp-picker-hosts">
            <div className="section-head">
              <h2 id="sftp-picker-hosts">{msgSftp.connectTitle}</h2>
              <span className="box-count">{shown.length}</span>
              <label className="sftp-picker-search">
                <IconSearch size={13} aria-hidden="true" />
                <input type="search" aria-label={msgSftp.searchHosts} placeholder={msgSftp.searchHosts} value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
            </div>
            {hosts.length === 0 ? (
              <BoxEmpty>{msgSftp.noHosts}</BoxEmpty>
            ) : shown.length === 0 ? (
              <BoxEmpty>{msgSftp.noHostMatch(query.trim())}</BoxEmpty>
            ) : (
              <ul className="list">
                {shown.map((h) => (
                  <li key={h.id}>
                    <button type="button" className="sftp-host" onClick={() => onHost(h)}>
                      {/* Decorative here: the row's name is the host's. */}
                      <span className="sftp-host-os" aria-hidden="true">
                        <OsIcon os={osOf.get(h.id) ?? null} size="sm" />
                      </span>
                      <span className="sftp-host-name">{h.label}</span>
                      <span className="sftp-host-dest mono">{msg.hosts.destination(h.username, h.address, h.port)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ConnectionState({
  label,
  conn,
  onReconnect,
  onOther,
  onOpenKnownHosts,
}: {
  label: string;
  conn: Connection;
  onReconnect: () => void;
  onOther: () => void;
  onOpenKnownHosts: () => void;
}) {
  if (conn.state !== "failed" && conn.state !== "closed") {
    const step = conn.state === "starting" ? msgSftp.state.connecting : (msgSftp.state[conn.state] ?? "");
    return (
      <div className="sftp-status" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>
          {msgSftp.connecting(label)}
          <span className="faint"> · {step}</span>
        </span>
      </div>
    );
  }
  if (conn.changed) {
    return (
      <div className="sftp-card" role="alert">
        <div className="dialog-head">
          <span className="dialog-icon" data-tone="danger" aria-hidden="true">
            <IconShieldAlert size={18} />
          </span>
          <h3>{msgSftp.changedTitle}</h3>
        </div>
        <HopNotice hop={conn.changed.hop} />
        <p>{msgSftp.changedBody}</p>
        <div className="stack-xs">
          <span className="label">{msg.terminal.changedPresented}</span>
          <Fingerprint value={conn.changed.presentedFingerprint} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onOther}>
            {msgSftp.otherHost}
          </button>
          <button type="button" className="btn btn-primary" onClick={onOpenKnownHosts}>
            {msgSftp.openKnownHosts}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="sftp-card" role={conn.error ? "alert" : "status"}>
      <div className="dialog-head">
        <span className="dialog-icon" data-tone={conn.error ? "warning" : "accent"} aria-hidden="true">
          <IconTriangleAlert size={18} />
        </span>
        <h3>{conn.error ? msgSftp.failedTitle : msgSftp.endedTitle}</h3>
      </div>
      {conn.error && <p>{conn.error.message}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onOther}>
          {msgSftp.otherHost}
        </button>
        <button type="button" className="btn btn-primary" onClick={onReconnect}>
          <IconRefreshCw size={15} /> {msgSftp.reconnect}
        </button>
      </div>
    </div>
  );
}

/** Host-key decision for a new server. The safe choice has initial focus. */
export function TrustDialog({ trust, onAnswer }: { trust: Trust; onAnswer: (decision: "cancel" | "once" | "always") => void }) {
  return (
    <Dialog title={msg.terminal.trustTitle} role="alertdialog" icon={<IconShieldCheck size={18} />} onDismiss={() => onAnswer("cancel")}>
      <HopNotice hop={trust.hop} />
      <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
        {msg.terminal.trustIntro}
      </p>
      <dl className="kv">
        <dt>{msg.terminal.host}</dt>
        <dd>
          {trust.host} : {trust.port}
        </dd>
        {trust.resolvedAddress && trust.resolvedAddress !== trust.host && (
          <>
            <dt>{msg.terminal.resolved}</dt>
            <dd>{trust.resolvedAddress}</dd>
          </>
        )}
        <dt>{msg.terminal.algorithm}</dt>
        <dd>{trust.algorithm}</dd>
      </dl>
      <div className="stack-xs">
        <span className="label">{msg.terminal.fingerprint}</span>
        <Fingerprint value={trust.fingerprint} />
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => onAnswer("cancel")} autoFocus data-autofocus>
          {msg.terminal.trustCancel}
        </button>
        <button type="button" className="btn" onClick={() => onAnswer("once")}>
          {msg.terminal.trustOnce}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => onAnswer("always")}>
          {msg.terminal.trustAlways}
        </button>
      </div>
    </Dialog>
  );
}

