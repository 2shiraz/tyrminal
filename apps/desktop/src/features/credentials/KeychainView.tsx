import type { KeySummary } from "@tyrminal/contracts";
import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, SecretField, TextField } from "../../components/ui/controls";
import { keys as keysApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction, useLoaded } from "../../lib/useAsync";

export function KeychainView() {
  const keys = useLoaded(keysApi.list);
  const [dialog, setDialog] = useState<"generate" | "import" | null>(null);
  const [deleting, setDeleting] = useState<KeySummary | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const remove = useAction();

  async function copyPublicKey(key: KeySummary) {
    // A user-initiated copy of public data. Terminal-initiated clipboard writes stay disabled.
    await navigator.clipboard.writeText(key.publicKey).catch(() => undefined);
    setCopied(key.id);
    window.setTimeout(() => setCopied((current) => (current === key.id ? null : current)), 1500);
  }

  const total = keys.value?.length ?? 0;
  const closeAndReload = () => {
    setDialog(null);
    void keys.reload();
  };

  return (
    <section className="panel-view" aria-labelledby="keys-title">
      <div className="view-header">
        <h1 id="keys-title">{msg.keys.title}</h1>
        <button type="button" className="btn" onClick={() => setDialog("import")}>
          {msg.keys.import}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setDialog("generate")}>
          {msg.keys.generate}
        </button>
      </div>
      <ErrorNotice error={keys.error ?? remove.error} />

      {keys.value && total === 0 && (
        <div className="empty">
          <h2>{msg.keys.emptyTitle}</h2>
          <p>{msg.keys.emptyBody}</p>
        </div>
      )}

      <ul className="list">
        {(keys.value ?? []).map((key) => (
          <li key={key.id} className="row">
            <div className="row-main">
              <span className="row-title">{key.label}</span>
              <span className="row-sub mono selectable">
                {key.algorithm} · {key.fingerprint}
              </span>
              <span className="row-sub">
                {key.usedBy > 0 ? msg.keys.usedBy(key.usedBy) : msg.keys.unused}
                {key.passphraseProtected && ` · ${key.passphraseStored ? msg.keys.protectedStored : msg.keys.protected}`}
              </span>
            </div>
            <button type="button" className="btn" onClick={() => void copyPublicKey(key)}>
              <span aria-live="polite">{copied === key.id ? msg.common.copied : msg.keys.copyPublic}</span>
            </button>
            <button type="button" className="btn btn-danger" onClick={() => setDeleting(key)}>
              {msg.common.delete}
            </button>
          </li>
        ))}
      </ul>

      {dialog === "generate" && <GenerateKeyDialog onClose={() => setDialog(null)} onDone={closeAndReload} />}
      {dialog === "import" && <ImportKeyDialog onClose={() => setDialog(null)} onDone={closeAndReload} />}

      {deleting && (
        <Dialog title={msg.keys.deleteTitle(deleting.label)} role="alertdialog" onDismiss={() => setDeleting(null)}>
          <p className="muted">{msg.keys.deleteBody}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDeleting(null)} autoFocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                const target = deleting;
                setDeleting(null);
                await remove.run(() => keysApi.remove(target.id));
                void keys.reload();
              }}
            >
              {msg.common.delete}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function GenerateKeyDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const { pending, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await run(() => keysApi.generate(label))) onDone();
  }

  return (
    <Dialog title={msg.keys.generateTitle} onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">{msg.keys.generateBody}</p>
        <TextField label={msg.keys.label} value={label} onChange={setLabel} autoFocus maxLength={256} />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={label.trim() === "" || pending}>
            {pending ? msg.common.working : msg.keys.generate}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ImportKeyDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(false);
  const { pending, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const imported = await run(() =>
      keysApi.import({ label, privateKey, passphrase: passphrase === "" ? null : passphrase, rememberPassphrase: remember }),
    );
    if (imported) {
      setPrivateKey("");
      setPassphrase("");
      onDone();
    }
  }

  return (
    <Dialog title={msg.keys.importTitle} onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">{msg.keys.importBody}</p>
        <TextField label={msg.keys.label} value={label} onChange={setLabel} autoFocus maxLength={256} />
        <div className="field">
          <label htmlFor="import-private-key">{msg.keys.privateKey}</label>
          <textarea
            id="import-private-key"
            className="textarea"
            rows={7}
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          />
        </div>
        <SecretField label={msg.keys.passphrase} value={passphrase} onChange={setPassphrase} hint={msg.keys.passphraseHint} maxLength={1024} />
        {passphrase !== "" && (
          <label className="check-row">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            <span>{msg.keys.remember}</span>
          </label>
        )}
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={label.trim() === "" || privateKey.trim() === "" || pending}>
            {pending ? msg.common.working : msg.keys.import}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
