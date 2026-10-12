import type { HostSummary, TunnelKind, TunnelSummary } from "@tyrminal/contracts";
import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, Notice, Segmented, Switch, TextField } from "../../components/ui/controls";
import { IconRoute, IconShieldAlert } from "../../components/ui/icons";
import { tunnels as tunnelsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { endpoint, msgB } from "../../lib/messages-b";
import { useAction } from "../../lib/useAsync";
import { defaultListen, isExposed, parsePort } from "./rules";

const KINDS: TunnelKind[] = ["local", "remote", "dynamic"];

/**
 * Create or edit a forwarding rule. A listener that other computers could reach is saved only
 * after a separate confirmation that names the exposure; the native side refuses it otherwise.
 */
export function TunnelEditor({
  tunnel,
  hosts,
  initialHostId,
  onClose,
  onSaved,
}: {
  tunnel: TunnelSummary | null;
  hosts: HostSummary[];
  initialHostId?: string | undefined;
  onClose: () => void;
  onSaved: (saved: TunnelSummary) => void;
}) {
  const [name, setName] = useState(tunnel?.name ?? "");
  const [hostId, setHostId] = useState(tunnel?.hostId ?? initialHostId ?? hosts[0]?.id ?? "");
  const [kind, setKind] = useState<TunnelKind>(tunnel?.kind ?? "local");
  const [bindHost, setBindHost] = useState(tunnel?.bindHost ?? "");
  const [bindPort, setBindPort] = useState(tunnel && tunnel.bindPort !== 0 ? String(tunnel.bindPort) : "");
  const [destHost, setDestHost] = useState(tunnel?.destHost ?? "");
  const [destPort, setDestPort] = useState(tunnel && tunnel.destPort !== 0 ? String(tunnel.destPort) : "");
  const [autoStart, setAutoStart] = useState(tunnel?.autoStart ?? false);
  const [confirming, setConfirming] = useState(false);
  const { pending, error, run } = useAction();

  const needsDest = kind !== "dynamic";
  const listenPort = parsePort(bindPort, true);
  const targetPort = parsePort(destPort, false);
  const exposed = isExposed(kind, bindHost);
  // An approval recorded on the rule carries over only while the address is unchanged.
  const alreadyApproved = tunnel !== null && tunnel.allowExternal && tunnel.kind === kind && tunnel.bindHost === bindHost.trim();
  const ready =
    name.trim() !== "" && hostId !== "" && listenPort !== null && (!needsDest || (destHost.trim() !== "" && targetPort !== null));

  async function save(allowExternal: boolean) {
    const saved = await run(() =>
      tunnelsApi.save({
        id: tunnel?.id ?? null,
        name,
        hostId,
        kind,
        bindHost,
        bindPort: listenPort ?? 0,
        destHost: needsDest ? destHost : "",
        destPort: needsDest ? (targetPort ?? 0) : 0,
        allowExternal,
        autoStart,
      }),
    );
    if (saved) onSaved(saved);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || pending) return;
    if (exposed && !alreadyApproved) {
      setConfirming(true);
      return;
    }
    void save(exposed);
  }

  const listenShown = endpoint(bindHost.trim() || defaultListen(kind), listenPort ? listenPort : msgB.tunnels.autoPort);

  return (
    <>
      <Dialog title={tunnel ? msgB.tunnels.editorEdit : msgB.tunnels.editorNew} icon={<IconRoute size={18} />} wide onDismiss={onClose}>
        <form className="stack" onSubmit={submit} aria-busy={pending}>
          {hosts.length === 0 && <Notice tone="info">{msgB.tunnels.noHosts}</Notice>}
          <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            <TextField label={msgB.tunnels.name} value={name} onChange={setName} autoFocus maxLength={256} />
            <label className="field">
              <span className="label">{msgB.tunnels.host}</span>
              <select className="select" value={hostId} onChange={(event) => setHostId(event.target.value)} aria-label={msgB.tunnels.host}>
                {hostId === "" && <option value="">{msgB.tunnels.chooseHost}</option>}
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.label}
                  </option>
                ))}
                {tunnel && !hosts.some((h) => h.id === tunnel.hostId) && <option value={tunnel.hostId}>{msgB.tunnels.hostMissing}</option>}
              </select>
            </label>
          </div>

          <div className="stack-xs">
            <Segmented
              label={msgB.tunnels.kind}
              value={kind}
              options={KINDS.map((k) => ({ value: k, label: msgB.tunnels.kinds[k] }))}
              onChange={setKind}
            />
            <p className="hint" data-testid="kind-help">
              {msgB.tunnels.kindHelp[kind]}
            </p>
          </div>

          <div className="split" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
            <TextField
              label={msgB.tunnels.listenAddress}
              value={bindHost}
              onChange={setBindHost}
              placeholder={defaultListen(kind)}
              hint={kind === "remote" ? msgB.tunnels.listenAddressRemoteHint : msgB.tunnels.listenAddressLocalHint}
              maxLength={253}
            />
            <TextField
              label={msgB.tunnels.listenPort}
              value={bindPort}
              onChange={setBindPort}
              inputMode="numeric"
              placeholder={msgB.tunnels.autoPort}
              hint={msgB.tunnels.listenPortHint}
              error={listenPort === null ? msgB.tunnels.invalidListenPort : undefined}
              maxLength={5}
            />
          </div>

          {needsDest && (
            <div className="split" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
              <TextField
                label={msgB.tunnels.destHost}
                value={destHost}
                onChange={setDestHost}
                placeholder="localhost"
                hint={kind === "remote" ? msgB.tunnels.destHostRemoteHint : msgB.tunnels.destHostLocalHint}
                maxLength={253}
              />
              <TextField
                label={msgB.tunnels.destPort}
                value={destPort}
                onChange={setDestPort}
                inputMode="numeric"
                error={destPort.trim() !== "" && targetPort === null ? msgB.tunnels.invalidPort : undefined}
                maxLength={5}
              />
            </div>
          )}

          {kind === "dynamic" && <p className="hint">{msgB.tunnels.socksNote}</p>}
          {exposed && alreadyApproved && <Notice tone="warning">{msgB.tunnels.exposeApproved}</Notice>}

          <Switch label={msgB.tunnels.autoStart} hint={msgB.tunnels.autoStartHint} checked={autoStart} onChange={setAutoStart} />
          <ErrorNotice error={error} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              {msg.common.cancel}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!ready || pending}>
              {pending ? msg.common.working : msg.common.save}
            </button>
          </div>
        </form>
      </Dialog>

      {confirming && (
        <Dialog title={msgB.tunnels.exposeTitle} role="alertdialog" icon={<IconShieldAlert size={18} />} tone="danger" onDismiss={() => setConfirming(false)}>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {kind === "remote" ? msgB.tunnels.exposeRemoteBody(listenShown) : msgB.tunnels.exposeBody(listenShown)}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setConfirming(false)} autoFocus data-autofocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                setConfirming(false);
                void save(true);
              }}
            >
              {msgB.tunnels.exposeConfirm}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
