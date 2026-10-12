import type { KnownHostSummary } from "@tyrminal/contracts";
import { type FormEvent, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Dialog } from "../../components/ui/Dialog";
import { useWindowedList } from "../../components/ui/useWindowedList";
import { EmptyState, ErrorNotice, Notice, SkeletonRows, TextArea, relativeAge } from "../../components/ui/controls";
import { IconFingerprint, IconPlus, IconShieldAlert, IconTrash2 } from "../../components/ui/icons";
import { knownHosts as knownHostsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction, useLoaded } from "../../lib/useAsync";
import { HostEditor } from "../hosts/HostEditor";
import { useFlip } from "../../lib/motion";

export function KnownHostsView() {
  const list = useLoaded(knownHostsApi.list);
  const [removing, setRemoving] = useState<KnownHostSummary | null>(null);
  // Rows rise in on arrival and close up when one is removed (lib/motion.ts).
  const listRef = useRef<HTMLUListElement>(null);
  useFlip(listRef);
  // Creating a host from a trusted record (SEC-03): the key is already trusted, so the first
  // connection goes straight to sign-in.
  const { hosts: savedHosts, keys: keyList } = useVaultData();
  const [creating, setCreating] = useState<KnownHostSummary | null>(null);
  const hasHost = (entry: KnownHostSummary) =>
    (savedHosts.value ?? []).some((h) => h.address.toLowerCase() === entry.host.toLowerCase() && h.port === entry.port);
  const entries = list.value ?? [];
  // Long lists are windowed: only the rows near the visible part are in the DOM.
  const rows = useWindowedList<HTMLUListElement>(entries.length, 72, listRef);

  return (
    <div className="page">
      <section className="page-inner" aria-labelledby="known-title">
        <div className="page-header">
          <div className="page-title">
            <h1 id="known-title">{msg.knownHosts.title}</h1>
            <p>{msg.knownHosts.intro}</p>
          </div>
        </div>
        <ErrorNotice error={list.error} />
        {list.value === null && !list.error && <SkeletonRows count={2} />}
        {list.value?.length === 0 && <EmptyState icon={<IconFingerprint size={28} />} title={msg.knownHosts.emptyTitle} body={msg.knownHosts.emptyBody} />}
        {(list.value?.length ?? 0) > 0 && (
          <section className="section" aria-labelledby="known-list-title">
            <div className="section-head">
              <h2 id="known-list-title">{msg.knownHosts.listTitle}</h2>
              <span className="box-count">{entries.length}</span>
            </div>
            <ul className="list" ref={listRef} style={rows.style} data-windowed={rows.windowed || undefined}>
              {entries.slice(rows.start, rows.end).map((entry, i) => (
                // A windowed list's rows come and go as it scrolls: no FLIP keys, so none of them animates in.
                <li key={entry.id} data-window-item {...(rows.windowed ? { "aria-setsize": entries.length, "aria-posinset": rows.start + i + 1 } : { "data-flip-key": entry.id })}>
                  <span className="tile-icon" aria-hidden="true">
                    <IconFingerprint size={17} />
                  </span>
                  <div className="row-main">
                    <span className="row-title">{msg.knownHosts.endpoint(entry.host, entry.port)}</span>
                    <span className="row-sub mono selectable">
                      {entry.algorithm} · {entry.fingerprint}
                    </span>
                    <span className="row-sub">
                      <time dateTime={new Date(entry.addedAt * 1000).toISOString()} title={new Date(entry.addedAt * 1000).toLocaleString()}>
                        {msg.knownHosts.trusted(relativeAge(entry.addedAt))}
                      </time>
                    </span>
                  </div>
                  {savedHosts.value && !hasHost(entry) && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setCreating(entry)}
                      aria-label={msg.knownHosts.createHostFor(msg.knownHosts.endpoint(entry.host, entry.port))}
                    >
                      <IconPlus size={14} aria-hidden="true" />
                      {msg.knownHosts.createHost}
                    </button>
                  )}
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => setRemoving(entry)}>
                    {msg.knownHosts.remove}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </section>
      {creating && (
        <HostEditor
          host={null}
          initial={{ address: creating.host, port: creating.port, username: "" }}
          keys={keyList.value ?? []}
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null);
            void savedHosts.reload();
          }}
        />
      )}
      {removing && (
        <RemoveTrustDialog
          entry={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            void list.reload();
          }}
        />
      )}
    </div>
  );
}

export function RemoveTrustDialog({
  entry,
  onClose,
  onDone,
}: {
  entry: Pick<KnownHostSummary, "id" | "host" | "port">;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const { pending, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(async () => {
      await knownHostsApi.remove(entry.id, reason);
      return true;
    });
    if (ok) onDone();
  }

  return (
    <Dialog title={msg.knownHosts.removeTitle(entry.host, entry.port)} role="alertdialog" icon={<IconShieldAlert size={18} />} tone="danger" onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <Notice tone="warning">{msg.knownHosts.removeBody}</Notice>
        <TextArea label={msg.knownHosts.reason} value={reason} onChange={setReason} hint={msg.knownHosts.reasonHint} rows={3} maxLength={500} autoFocus mono={false} />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-danger-solid" disabled={reason.trim().length < 3 || pending}>
            <IconTrash2 size={15} />
            {msg.knownHosts.remove}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export { SettingsView } from "./SettingsShell";
export type { Section } from "./settingsIndex";
