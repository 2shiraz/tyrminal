import type { HostSummary } from "@tyrminal/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { IconButton } from "../../components/ui/controls";
import { IconArrowLeftRight, IconHardDrive, IconPlus, IconX } from "../../components/ui/icons";
import { OsIcon } from "../hosts/OsIcon";
import { useHostOs } from "./hostOs";
import { msgSftp } from "./messages";
import type { Endpoint } from "./model";
import { type LocationStatus, type PaneHealth, type PaneTransfers, SftpLocation, type Side, type Source } from "./SftpLocation";

export { TrustDialog } from "./SftpLocation";
export type { PaneHealth, PaneTransfers, Side, Source } from "./SftpLocation";

/** Locations one pane keeps open at most. */
import { MAX_LOCATIONS } from "./limits";

export { MAX_LOCATIONS };

/** Asks a pane to show a location: an open one with that host, else a new one. */
export interface LocationRequest {
  source: Source;
  path: string | null;
  seq: number;
}

const NO_REQUESTS: readonly LocationRequest[] = [];

interface Location {
  id: number;
  initial: Source;
  startPath: string | null;
  go: { path: string; seq: number } | null;
}

const RANK: PaneHealth[] = ["idle", "ok", "busy", "bad", "attention"];

/**
 * One side of the SFTP tab: a row of location tabs (this computer or saved hosts, several open at
 * once) above the location shown. Every location keeps its own connection, folder and history
 * while another one is shown; "+" adds one (up to eight) and × closes one with its connection.
 */
export function SftpPane({
  paneId,
  side,
  initial,
  hosts,
  visible,
  active,
  refreshKey,
  transfers,
  requests = NO_REQUESTS,
  onFocusIn,
  onEndpoint,
  onHealth,
  onFull,
  onOpenKnownHosts,
}: {
  /** Stays with the pane when the panes swap sides (drag payloads name it). */
  paneId: string;
  side: Side;
  initial: Source;
  hosts: HostSummary[];
  visible: boolean;
  active: boolean;
  refreshKey: number;
  transfers: PaneTransfers;
  /** Open in SFTP, oldest first: show each host (focusing a location already on it). */
  requests?: readonly LocationRequest[];
  onFocusIn: () => void;
  /** The shown location's folder, for copying to and from the other pane. */
  onEndpoint: (endpoint: Endpoint | null) => void;
  onHealth: (health: PaneHealth) => void;
  /** A request could not open another location (eight already). */
  onFull: () => void;
  onOpenKnownHosts: () => void;
}) {
  const sideLabel = side === "left" ? msgSftp.left : msgSftp.right;
  const nextId = useRef(1);
  const [locations, setLocations] = useState<Location[]>(() => [{ id: nextId.current++, initial, startPath: null, go: null }]);
  const [shown, setShown] = useState(1);
  const [status, setStatus] = useState<Record<number, LocationStatus>>({});
  const osOf = useHostOs(hosts);
  const [endpoints, setEndpoints] = useState<Record<number, Endpoint | null>>({});
  const tabRefs = useRef(new Map<number, HTMLButtonElement>());
  /** Per-location refresh counters: a finished transfer refreshes the location shown only. */
  const [bumps, setBumps] = useState<Record<number, number>>({});
  const seenRefresh = useRef(refreshKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new refresh goes to the location shown then.
  useEffect(() => {
    if (refreshKey === seenRefresh.current) return;
    seenRefresh.current = refreshKey;
    setBumps((b) => ({ ...b, [shown]: (b[shown] ?? 0) + 1 }));
  }, [refreshKey]);

  const add = useCallback(
    (source: Source, startPath: string | null = null, replacing: number | null = null) => {
      if (replacing === null && locations.length >= MAX_LOCATIONS) return false;
      const id = nextId.current++;
      setLocations((list) => [...list.filter((l) => l.id !== replacing), { id, initial: source, startPath, go: null }]);
      setShown(id);
      return true;
    },
    [locations.length],
  );

  function close(id: number) {
    const index = locations.findIndex((l) => l.id === id);
    const rest = locations.filter((l) => l.id !== id);
    // The last location closes into an empty one with the picker; a pane is never empty.
    const next = rest.length > 0 ? rest : [{ id: nextId.current++, initial: { kind: "none" } as Source, startPath: null, go: null }];
    setLocations(next);
    setStatus(({ [id]: _, ...others }) => others);
    setEndpoints(({ [id]: _, ...others }) => others);
    if (shown === id) setShown((next[Math.min(index, next.length - 1)] as Location).id);
  }

  // Open in SFTP: a location already on that host is shown (and goes to the folder), else a new one.
  const seen = useRef(0);
  // One request per render, so each sees the locations the one before it opened (several hosts
  // opened at once each get a location).
  // biome-ignore lint/correctness/useExhaustiveDependencies: each request is handled once.
  useEffect(() => {
    const request = requests.find((r) => r.seq > seen.current);
    if (!request) return;
    seen.current = request.seq;
    const { source, path } = request;
    const open = source.kind === "host" ? locations.find((l) => status[l.id]?.hostId === source.hostId) : undefined;
    if (open) {
      setShown(open.id);
      if (path) setLocations((list) => list.map((l) => (l.id === open.id ? { ...l, go: { path, seq: request.seq } } : l)));
    } else {
      // An empty location (still on the host picker) is used rather than left beside the new one.
      const empty = locations.find((l) => (status[l.id]?.kind ?? l.initial.kind) === "none");
      if (!add(source, path, empty?.id ?? null)) onFull();
    }
  }, [requests, locations]);

  const shownEndpoint = endpoints[shown] ?? null;
  useEffect(() => onEndpoint(shownEndpoint), [shownEndpoint, onEndpoint]);
  const health = RANK[Math.max(...locations.map((l) => RANK.indexOf(status[l.id]?.health ?? "idle")))] ?? "idle";
  useEffect(() => onHealth(health), [health, onHealth]);

  // Stable callbacks per location, so a location does not report again on every render.
  const callbacks = useRef(new Map<number, { endpoint: (e: Endpoint | null) => void; status: (s: LocationStatus) => void }>());
  const callbacksFor = (id: number) => {
    let c = callbacks.current.get(id);
    if (!c) {
      c = {
        endpoint: (e) => setEndpoints((all) => (all[id] === e ? all : { ...all, [id]: e })),
        status: (s) =>
          setStatus((all) => {
            const old = all[id];
            return old && old.label === s.label && old.kind === s.kind && old.health === s.health && old.hostId === s.hostId ? all : { ...all, [id]: s };
          }),
      };
      callbacks.current.set(id, c);
    }
    return c;
  };

  /** Left/Right move between location tabs (the tab row is one stop for Tab, as tabs are). */
  function onTabKey(event: React.KeyboardEvent, index: number) {
    const here = locations[index];
    if ((event.key === "Delete" || event.key === "Backspace") && here) {
      event.preventDefault();
      const next = locations[index + 1] ?? locations[index - 1];
      close(here.id);
      if (next) window.requestAnimationFrame(() => tabRefs.current.get(next.id)?.focus());
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const last = locations.length - 1;
    const to = event.key === "Home" ? 0 : event.key === "End" ? last : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : index === last ? 0 : index + 1;
    const target = locations[to];
    if (!target) return;
    setShown(target.id);
    tabRefs.current.get(target.id)?.focus();
  }

  return (
    <section className="sftp-pane" aria-label={sideLabel} data-active={active || undefined} onFocus={onFocusIn} onPointerDown={onFocusIn}>
      <div className="sftp-locations">
        <div className="sftp-tabs" role="tablist" aria-label={msgSftp.locations(sideLabel)}>
          {locations.map((l, index) => {
            const s = status[l.id];
            const label = s?.label ?? msgSftp.newLocation;
            const tone = s?.kind === "host" ? (s.health === "ok" ? "ok" : s.health === "bad" ? "bad" : s.health === "attention" ? "attention" : s.health === "busy" ? "busy" : null) : null;
            const selected = l.id === shown;
            return (
              <div key={l.id} className="sftp-tab" role="presentation" data-selected={selected || undefined}>
                <button
                  ref={(el) => {
                    if (el) tabRefs.current.set(l.id, el);
                    else tabRefs.current.delete(l.id);
                  }}
                  type="button"
                  role="tab"
                  id={`sftp-${paneId}-tab-${l.id}`}
                  aria-selected={selected}
                  aria-controls={`sftp-${paneId}-loc-${l.id}`}
                  aria-keyshortcuts="Delete"
                  aria-description={msgSftp.closeHint}
                  tabIndex={selected ? 0 : -1}
                  className="sftp-tab-main"
                  onClick={() => setShown(l.id)}
                  onKeyDown={(e) => onTabKey(e, index)}
                >
                  <span className="sftp-tab-icon" data-kind={s?.kind ?? "none"} aria-hidden="true">
                    {s?.kind === "host" ? <OsIcon os={(s.hostId && osOf.get(s.hostId)) || null} size="sm" /> : s?.kind === "local" ? <IconHardDrive size={13} /> : <IconArrowLeftRight size={13} />}
                  </span>
                  <span className="sftp-tab-label">{label}</span>
                  {tone && <span className="status-dot" data-tone={tone} role="img" aria-label={msgSftp.health[tone]} />}
                </button>
                {/* A tab list holds tabs only: the × is for the pointer; the keyboard closes with Delete. */}
                <button type="button" className="sftp-tab-close" aria-hidden="true" tabIndex={-1} title={msgSftp.closeLocation(label)} onClick={() => close(l.id)}>
                  <IconX size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <IconButton
          size="sm"
          className="sftp-tab-add"
          data-tooltip-side="bottom-end"
          label={locations.length >= MAX_LOCATIONS ? msgSftp.locationsFull(MAX_LOCATIONS) : msgSftp.addLocation}
          disabled={locations.length >= MAX_LOCATIONS}
          onClick={() => add({ kind: "none" })}
        >
          <IconPlus size={14} />
        </IconButton>
      </div>

      {locations.map((l) => (
        <div key={l.id} id={`sftp-${paneId}-loc-${l.id}`} role="tabpanel" aria-labelledby={`sftp-${paneId}-tab-${l.id}`} className="sftp-location-panel" hidden={l.id !== shown}>
          <SftpLocation
            paneId={paneId}
            initial={l.initial}
            startPath={l.startPath}
            hosts={hosts}
            visible={visible}
            shown={l.id === shown}
            active={active}
            refreshKey={bumps[l.id] ?? 0}
            transfers={transfers}
            goRequest={l.go}
            onEndpoint={callbacksFor(l.id).endpoint}
            onStatus={callbacksFor(l.id).status}
            onOpenKnownHosts={onOpenKnownHosts}
          />
        </div>
      ))}
    </section>
  );
}
