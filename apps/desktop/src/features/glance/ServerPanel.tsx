import type { DiskUse, MultiplexerSession, ServerGlance } from "@tyrminal/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { ErrorNotice, IconButton, Switch } from "../../components/ui/controls";
import { IconPanelRightClose } from "../../components/ui/icons";
import { type AppError, glance, toAppError } from "../../lib/ipc";
import { msgG } from "../../lib/messages-glance";
import { MultiplexerSection } from "../multiplexers/MultiplexerSection";
import { formatSize } from "../sftp/model";

/** The SSH session the panel reads; Telnet, serial and local sessions never get here. */
export interface GlanceTarget {
  sessionId: string;
  /** The saved host, when the session was opened for one (the on/off setting is per host). */
  hostId: string | null;
  label: string;
}

/** How often the panel asks while it is open; the core also refuses to ask the server sooner. */
export const GLANCE_REFRESH_MS = 5_000;

/** Server at a glance (P-32): uptime, load, memory and disk use, refreshed only while open. */
export function ServerPanel({
  target,
  onClose,
  onAttach,
}: {
  target: GlanceTarget | null;
  onClose: () => void;
  /** tmux and screen session awareness (P-31): types a chosen session's attach command. */
  onAttach?: ((session: MultiplexerSession) => void) | undefined;
}) {
  const ref = useRef<HTMLElement>(null);
  const [value, setValue] = useState<ServerGlance | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [round, setRound] = useState(0);
  const sessionId = target?.sessionId ?? null;
  const hostId = target?.hostId ?? null;

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);

  // Reads now and then every 5 s, for as long as the panel shows this session. Closing the panel,
  // switching sessions or the session ending stops it; a lock unmounts the whole app.
  useEffect(() => {
    setValue(null);
    setError(null);
    if (!sessionId) return;
    let live = true;
    let timer: number | undefined;
    const read = async () => {
      try {
        const result = await glance.get(sessionId);
        if (!live) return;
        setValue(result);
        setError(null);
        timer = window.setTimeout(() => void read(), GLANCE_REFRESH_MS);
      } catch (e) {
        // The session closed or the vault locked: no further reads.
        if (live) setError(toAppError(e));
      }
    };
    void read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [sessionId, round]);

  useEffect(() => {
    setEnabled(null);
    if (!hostId) return;
    let live = true;
    glance.hostEnabled(hostId).then(
      (on) => live && setEnabled(on),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [hostId]);

  const toggle = useCallback(
    async (on: boolean) => {
      if (!hostId) return;
      try {
        setEnabled(await glance.setHostEnabled(hostId, on));
        setRound((r) => r + 1);
      } catch (e) {
        setError(toAppError(e));
      }
    },
    [hostId],
  );

  return (
    <aside
      ref={ref}
      className="side-panel"
      aria-label={msgG.panel}
      data-panel-kind="server"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="panel-head">
        <h2>{msgG.panel}</h2>
        <IconButton label={msgG.close} onClick={onClose}>
          <IconPanelRightClose size={16} />
        </IconButton>
      </div>
      <div className="panel-body glance">
        {!target ? (
          <p className="muted">{msgG.noSession}</p>
        ) : (
          <>
            <p className="glance-target truncate">{target.label}</p>
            <ErrorNotice error={error} />
            {!error && <GlanceValues value={value} />}
            {hostId && enabled !== null && (
              <Switch label={msgG.enabled} hint={msgG.enabledHint} checked={enabled} onChange={(on) => void toggle(on)} />
            )}
            {/* tmux and screen session awareness (P-31) */}
            {onAttach && <MultiplexerSection sessionId={target.sessionId} onAttach={onAttach} />}
          </>
        )}
      </div>
    </aside>
  );
}

function GlanceValues({ value }: { value: ServerGlance | null }) {
  if (!value) return null;
  if (value.kind === "off") return <p className="muted">{msgG.off}</p>;
  if (value.kind === "notAvailable") {
    return <p className="muted" data-glance="unavailable">{msgG[value.reason]}</p>;
  }
  const { uptimeSeconds, load, memory, disks } = value.stats;
  return (
    <dl className="glance-values" aria-live="off">
      <dt>{msgG.uptime}</dt>
      <dd data-glance="uptime">{uptimeSeconds == null ? msgG.unavailable : formatUptime(uptimeSeconds)}</dd>
      <dt title={msgG.loadHint}>{msgG.load}</dt>
      <dd data-glance="load" className="mono">
        {load == null ? msgG.unavailable : load.map((v) => v.toFixed(2)).join("  ")}
      </dd>
      <dt>{msgG.memory}</dt>
      <dd data-glance="memory">
        {memory == null ? (
          msgG.unavailable
        ) : (
          <Usage used={memory.totalKib - memory.availableKib} total={memory.totalKib} label={msgG.memory} />
        )}
      </dd>
      <dt>{msgG.disks}</dt>
      <dd data-glance="disks">{disks == null ? msgG.unavailable : <Disks disks={disks} />}</dd>
    </dl>
  );
}

function Disks({ disks }: { disks: DiskUse[] }) {
  if (disks.length === 0) return <span className="muted">{msgG.noDisks}</span>;
  return (
    <ul className="glance-disks">
      {disks.map((d) => (
        <li key={d.mount}>
          {/* The mount point comes from the server and is shown as plain text. */}
          <span className="mono truncate">{d.mount}</span>
          <Usage used={d.usedKib} total={d.totalKib} label={d.mount} />
        </li>
      ))}
    </ul>
  );
}

function Usage({ used, total, label }: { used: number; total: number; label: string }) {
  return (
    <span className="glance-usage">
      <meter min={0} max={total} value={used} high={total * 0.9} aria-label={label} />
      <span className="muted">{msgG.used(formatSize(used * 1024), formatSize(total * 1024))}</span>
    </span>
  );
}

export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return msgG.days(days, hours % 24);
  if (hours > 0) return msgG.hours(hours, minutes % 60);
  return msgG.minutes(minutes);
}
