import type { DiscoveredService, DiscoveryNetwork, DiscoveryStatus } from "@tyrminal/contracts";
import { useEffect, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, Notice } from "../../components/ui/controls";
import { IconNetwork, IconPlus } from "../../components/ui/icons";
import { discovery } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgDiscovery } from "../../lib/messages-discovery";
import { useAction } from "../../lib/useAsync";

const POLL_MS = 1000;

/**
 * LAN discovery (HST-14): the user picks a network and presses Start; the core then listens for
 * SSH announcements for a fixed time. Results are only listed (as text); "Add host" hands one to
 * the normal host editor. Closing the dialog stops listening.
 */
export function DiscoveryDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (service: DiscoveredService) => void }) {
  const [networks, setNetworks] = useState<DiscoveryNetwork[] | null>(null);
  const [network, setNetwork] = useState("");
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const { pending, error, run } = useAction();
  const started = useRef(false);

  useEffect(() => {
    void run(() => discovery.networks()).then((list) => {
      if (!list) return;
      setNetworks(list);
      setNetwork((current) => current || (list[0]?.id ?? ""));
    });
  }, [run]);

  // While listening, the found list and the time left refresh once a second.
  const running = status?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      discovery
        .status()
        .then(setStatus)
        .catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  // Leaving the dialog stops a browse that is still listening.
  useEffect(
    () => () => {
      if (started.current) void discovery.stop().catch(() => undefined);
    },
    [],
  );

  async function start() {
    if (!network || pending) return;
    const result = await run(() => discovery.start(network));
    if (result) {
      started.current = true;
      setStatus(result);
    }
  }

  async function stop() {
    const result = await run(() => discovery.stop());
    if (result) setStatus(result);
  }

  const found = status?.found ?? [];
  return (
    <Dialog title={msgDiscovery.title} icon={<IconNetwork size={18} />} onDismiss={onClose} wide>
      <div className="stack">
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msgDiscovery.intro}
        </p>
        {networks && networks.length === 0 && <Notice tone="info">{msgDiscovery.noNetworks}</Notice>}
        {networks && networks.length > 0 && (
          <div className="row-flex" style={{ alignItems: "flex-end" }}>
            <label className="field" style={{ flex: 1 }}>
              <span className="label">{msgDiscovery.network}</span>
              <select className="select" value={network} disabled={running} onChange={(event) => setNetwork(event.target.value)} data-autofocus>
                {networks.map((n) => (
                  <option key={n.id} value={n.id}>
                    {msgDiscovery.networkOption(n.id, n.addresses)}
                  </option>
                ))}
              </select>
            </label>
            {running ? (
              <button type="button" className="btn" onClick={() => void stop()} disabled={pending}>
                {msgDiscovery.stop}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={!network || pending}>
                {msgDiscovery.start}
              </button>
            )}
          </div>
        )}
        <ErrorNotice error={error} />
        <p role="status" className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {status === null ? msgDiscovery.idle : running ? msgDiscovery.listening(status.secondsLeft) : msgDiscovery.finished(found.length)}
        </p>
        {found.length > 0 && (
          <>
            <Notice tone="warning">{msgDiscovery.untrusted}</Notice>
            <ul className="list" aria-label={msgDiscovery.results}>
              {found.map((service) => (
                <li key={`${service.name}|${service.host}|${service.port}`}>
                  <div className="row-main">
                    <span className="row-title">{service.name}</span>
                    <span className="row-sub mono">{msgDiscovery.destination(service.host, service.addresses[0], service.port)}</span>
                  </div>
                  <div className="row-actions">
                    <button type="button" className="btn btn-sm" aria-label={msgDiscovery.addLabel(service.name)} onClick={() => onAdd(service)}>
                      <IconPlus size={13} />
                      {msgDiscovery.add}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {status?.truncated && <Notice tone="info">{msgDiscovery.truncated}</Notice>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.close}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
