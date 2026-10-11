import type { KnownHostSummary } from "@tyrminal/contracts";
import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, Notice, SecretField } from "../../components/ui/controls";
import { knownHosts as knownHostsApi, vault } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction, useLoaded } from "../../lib/useAsync";
import { RecoveryKeyStep } from "../vault/VaultScreens";

export function KnownHostsView() {
  const list = useLoaded(knownHostsApi.list);
  const [removing, setRemoving] = useState<KnownHostSummary | null>(null);

  return (
    <section className="panel-view" aria-labelledby="known-title">
      <div className="view-header">
        <h1 id="known-title">{msg.knownHosts.title}</h1>
      </div>
      <p className="muted" style={{ marginBottom: "var(--space-4)" }}>
        {msg.knownHosts.intro}
      </p>
      <ErrorNotice error={list.error} />
      {list.value?.length === 0 && (
        <div className="empty">
          <h2>{msg.knownHosts.emptyTitle}</h2>
          <p>{msg.knownHosts.emptyBody}</p>
        </div>
      )}
      <ul className="list">
        {(list.value ?? []).map((entry) => (
          <li key={entry.id} className="row">
            <div className="row-main">
              <span className="row-title">{msg.knownHosts.endpoint(entry.host, entry.port)}</span>
              <span className="row-sub mono selectable">
                {entry.algorithm} · {entry.fingerprint}
              </span>
              <span className="row-sub">{new Date(entry.addedAt * 1000).toLocaleString()}</span>
            </div>
            <button type="button" className="btn btn-danger" onClick={() => setRemoving(entry)}>
              {msg.knownHosts.remove}
            </button>
          </li>
        ))}
      </ul>
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
    </section>
  );
}

function RemoveTrustDialog({ entry, onClose, onDone }: { entry: KnownHostSummary; onClose: () => void; onDone: () => void }) {
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
    <Dialog title={msg.knownHosts.removeTitle(entry.host, entry.port)} role="alertdialog" onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <Notice tone="warning" icon="!">
          {msg.knownHosts.removeBody}
        </Notice>
        <div className="field">
          <label htmlFor="trust-reason">{msg.knownHosts.reason}</label>
          <textarea
            id="trust-reason"
            className="textarea"
            style={{ fontFamily: "var(--font-ui)" }}
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            autoFocus
          />
          <span className="hint">{msg.knownHosts.reasonHint}</span>
        </div>
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-danger" disabled={reason.trim().length < 3 || pending}>
            {msg.knownHosts.remove}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function SettingsView() {
  const [dialog, setDialog] = useState<"passphrase" | "recovery" | null>(null);
  const [changed, setChanged] = useState(false);

  return (
    <section className="panel-view" aria-labelledby="settings-title">
      <div className="view-header">
        <h1 id="settings-title">{msg.settings.title}</h1>
      </div>
      <div className="stack" style={{ maxWidth: 640 }}>
        <Notice tone="warning" icon="!">
          <strong>{msg.settings.status}.</strong> {msg.settings.statusBody}
        </Notice>

        <div className="stack-sm">
          <h2>{msg.settings.security}</h2>
          <p className="muted">{msg.settings.autoLock}</p>
          {changed && (
            <div role="status">
              <Notice tone="success" icon="✓">
                {msg.settings.changed}
              </Notice>
            </div>
          )}
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={() => setDialog("passphrase")}>
              {msg.settings.changePassphrase}
            </button>
            <button type="button" className="btn" onClick={() => setDialog("recovery")}>
              {msg.settings.rotateRecovery}
            </button>
          </div>
        </div>

        <div className="stack-sm">
          <h2>{msg.settings.privacy}</h2>
          <p className="muted">{msg.settings.privacyBody}</p>
        </div>
      </div>

      {dialog === "passphrase" && (
        <ChangePassphraseDialog
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setChanged(true);
          }}
        />
      )}
      {dialog === "recovery" && <RotateRecoveryDialog onClose={() => setDialog(null)} />}
    </section>
  );
}

function ChangePassphraseDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const { pending, error, run } = useAction();
  const ready = current !== "" && next.length >= 8 && next === confirm;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(async () => {
      await vault.changePassphrase(current, next);
      return true;
    });
    setCurrent("");
    if (ok) {
      setNext("");
      setConfirm("");
      onDone();
    }
  }

  return (
    <Dialog title={msg.settings.changePassphrase} onDismiss={onClose}>
      <form className="stack" onSubmit={submit} aria-busy={pending}>
        <p className="muted">{msg.settings.changeBody}</p>
        <SecretField label={msg.settings.current} value={current} onChange={setCurrent} autoFocus maxLength={1024} />
        <SecretField
          label={msg.settings.next}
          value={next}
          onChange={setNext}
          hint={msg.onboarding.passphraseHint}
          error={next !== "" && next.length < 8 ? msg.onboarding.tooShort : undefined}
          maxLength={1024}
        />
        <SecretField
          label={msg.onboarding.confirm}
          value={confirm}
          onChange={setConfirm}
          error={confirm !== "" && confirm !== next ? msg.onboarding.mismatch : undefined}
          maxLength={1024}
        />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready || pending}>
            {pending ? msg.common.working : msg.settings.changePassphrase}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RotateRecoveryDialog({ onClose }: { onClose: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const { pending, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = passphrase;
    setPassphrase("");
    const result = await run(() => vault.rotateRecoveryKey(value));
    if (result) setIssued(result.recoveryKey);
  }

  if (issued) {
    // Full-screen step, the same one used at vault creation, including the typed confirmation.
    return (
      <div style={{ position: "fixed", inset: 0, background: "var(--canvas)", zIndex: 10 }}>
        <RecoveryKeyStep recoveryKey={issued} onDone={onClose} />
      </div>
    );
  }

  return (
    <Dialog title={msg.settings.rotateRecovery} onDismiss={onClose}>
      <form className="stack" onSubmit={submit} aria-busy={pending}>
        <p className="muted">{msg.settings.rotateBody}</p>
        <SecretField label={msg.settings.current} value={passphrase} onChange={setPassphrase} autoFocus maxLength={1024} />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={passphrase === "" || pending}>
            {pending ? msg.common.working : msg.settings.rotateRecovery}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
