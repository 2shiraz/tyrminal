import type { HostOs, HostSummary } from "@tyrminal/contracts";
import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { IconPlay, IconServer } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgD, osNames } from "../../lib/messages-d";
import { msgProduction } from "../../lib/messages-production";
import { OS_CHOICES } from "./OsIcon";
import { ProductionConfirm } from "./ProductionConfirm";
import { useIsProduction } from "./production";

/**
 * Reviews the hosts a group-wide (or multi-selection) connection would open before anything
 * connects. Refuses rather than silently opening only some when there is no room for all.
 */
export function ConnectAllDialog({
  hosts,
  groupName,
  free,
  onClose,
  onConfirm,
}: {
  hosts: HostSummary[];
  /** The group being opened, or null for a selection. */
  groupName: string | null;
  /** How many more sessions can be open now. */
  free: number;
  onClose: () => void;
  onConfirm: (hosts: HostSummary[]) => void;
}) {
  const tooMany = hosts.length > free;
  const ready = hosts.length > 0 && !tooMany;
  const isProduction = useIsProduction();
  const production = hosts.filter(isProduction);
  const [confirming, setConfirming] = useState(false);
  return (
    <Dialog title={msgD.inventory.connectAllTitle(hosts.length)} icon={<IconPlay size={18} />} onDismiss={onClose}>
      <div className="stack">
        {hosts.length === 0 ? (
          <p className="muted">{msgD.inventory.connectAllNone}</p>
        ) : (
          <>
            <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {groupName ? msgD.inventory.connectAllGroupBody(groupName) : msgD.inventory.connectAllSelectionBody}
            </p>
            <ul className="list connect-all-list" aria-label={msgD.inventory.connectAllTitle(hosts.length)} data-testid="connect-all-list">
              {hosts.map((host) => (
                <li key={host.id}>
                  <IconServer size={14} />
                  <div className="row-main">
                    <span className="row-title">{host.label}</span>
                    <span className="row-sub">{msg.hosts.destination(host.username, host.address, host.port)}</span>
                  </div>
                  {isProduction(host) && <span className="badge badge-production">{msgProduction.label}</span>}
                </li>
              ))}
            </ul>
            <p className="muted" style={{ fontSize: "var(--text-xs)" }}>
              {msgD.inventory.connectAllNote}
            </p>
          </>
        )}
        {tooMany && (
          <p className="notice notice-danger" role="alert">
            {msgD.inventory.connectAllTooMany(free)}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} autoFocus={!ready} data-autofocus={!ready || undefined}>
            {msg.common.cancel}
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready}
            onClick={() => (production.length > 0 ? setConfirming(true) : onConfirm(hosts))}
            data-autofocus={ready || undefined}
          >
            <IconPlay size={14} />
            {msgD.inventory.connectAllConfirm(hosts.length)}
          </button>
        </div>
      </div>
      {confirming && (
        <ProductionConfirm
          title={msgProduction.connectTitle}
          body={msgProduction.connectBody}
          confirmLabel={msgProduction.connectConfirm}
          hosts={production.map((h) => h.label)}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onConfirm(hosts);
          }}
        />
      )}
    </Dialog>
  );
}

/** Picks the OS (icon) for one or more hosts; "Not set" clears it. */
export function SetOsDialog({
  count,
  initial,
  onClose,
  onApply,
}: {
  count: number;
  initial: HostOs | null;
  onClose: () => void;
  onApply: (os: HostOs | null) => void;
}) {
  const [os, setOs] = useState<string>(initial ?? "");
  function submit(event: FormEvent) {
    event.preventDefault();
    onApply(os === "" ? null : (os as HostOs));
  }
  return (
    <Dialog title={msgD.inventory.setOsTitle(count)} icon={<IconServer size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span className="label">{msgD.inventory.os}</span>
          <select className="select" value={os} onChange={(event) => setOs(event.target.value)} data-autofocus>
            <option value="">{msgD.inventory.osUnset}</option>
            {OS_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {osNames[choice]}
              </option>
            ))}
          </select>
          <span className="hint">{msgD.inventory.setOsHelp}</span>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary">
            {msg.common.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
