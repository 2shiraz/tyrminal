import type { ActiveTunnel } from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { usePreferences } from "../../app/preferences";
import { useToast } from "../../components/ui/Toasts";
import { quickForward } from "../../lib/ipc";
import { msgB } from "../../lib/messages-b";

/**
 * Quick port forward (P-24): a program on the server said it listens on a port. The suggestion
 * comes from untrusted output, so it is only an offer; nothing is forwarded until the user accepts.
 * The forward always goes to the server's loopback at that port, and "Open in browser" opens only
 * the address the app builds for the local listener.
 */
export function QuickForwardBar({
  sessionId,
  hostId,
  ports,
  connected,
  onDone,
}: {
  sessionId: string | null;
  hostId: string | null;
  /** Ports suggested for this session, oldest first. */
  ports: number[];
  connected: boolean;
  /** The user dealt with a suggestion (accepted, dismissed or turned them off). */
  onDone: (port: number | "all") => void;
}) {
  const { prefs } = usePreferences();
  const notify = useToast();
  const [forwards, setForwards] = useState<ActiveTunnel[]>([]);
  const [busy, setBusy] = useState(false);

  // Forwards end with the session.
  useEffect(() => {
    if (!connected) setForwards([]);
  }, [connected]);

  const port = ports[0];
  const offer = connected && !prefs.noPortSuggestions && port !== undefined && sessionId !== null;
  if (!offer && forwards.length === 0) return null;

  const fail = (error: unknown) => notify("danger", (error as { message?: string }).message ?? msgB.quick.failed);

  async function accept() {
    if (sessionId === null || port === undefined) return;
    setBusy(true);
    try {
      const run = await quickForward.start(sessionId, port);
      setForwards((list) => [...list, run]);
      onDone(port);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function muteHost() {
    if (hostId === null) return;
    try {
      await quickForward.setForHost(hostId, false);
      notify("info", msgB.quick.mutedHost);
      onDone("all");
    } catch (error) {
      fail(error);
    }
  }

  return (
    <div className="quick-forward" role="region" aria-label={msgB.quick.region}>
      {offer && (
        <div className="quick-forward-row" data-testid="quick-forward-offer">
          <span>{msgB.quick.offer(port)}</span>
          <span className="quick-forward-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void accept()}>
              {msgB.quick.forward}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onDone(port)}>
              {msgB.quick.notNow}
            </button>
            {hostId !== null && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void muteHost()}>
                {msgB.quick.muteHost}
              </button>
            )}
          </span>
        </div>
      )}
      {forwards.map((run) => (
        <div key={run.runId} className="quick-forward-row" data-testid="quick-forward-active">
          <span>{msgB.quick.active(run.destPort, run.boundPort)}</span>
          <span className="quick-forward-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                void quickForward
                  .open(run.runId)
                  .then((url) => notify("info", msgB.quick.opened(url)))
                  .catch(fail)
              }
            >
              {msgB.quick.open}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                void quickForward
                  .stop(run.runId)
                  .then(() => setForwards((list) => list.filter((r) => r.runId !== run.runId)))
                  .catch(fail)
              }
            >
              {msgB.quick.stop}
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
