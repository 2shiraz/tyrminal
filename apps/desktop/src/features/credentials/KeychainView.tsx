import type { KeySummary } from "@tyrminal/contracts";
import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorNotice, IconButton, SecretField, SkeletonRows, Switch, TextArea, TextField } from "../../components/ui/controls";
import { IconCheck, IconCopy, IconFileCode, IconKeyRound, IconPlus, IconTrash2 } from "../../components/ui/icons";
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
    <div className="page">
      <section className="page-inner" aria-labelledby="keys-title" style={{ maxWidth: 900 }}>
        <div className="page-header">
          <div className="page-title">
            <h1 id="keys-title">{msg.keys.title}</h1>
            <p>{msg.keys.emptyBody}</p>
          </div>
          <button type="button" className="btn" onClick={() => setDialog("import")}>
            <IconFileCode size={16} />
            {msg.keys.import}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setDialog("generate")}>
            <IconPlus size={16} />
            {msg.keys.generate}
          </button>
        </div>
        <ErrorNotice error={keys.error ?? remove.error} />
        {keys.value === null && !keys.error && <SkeletonRows count={2} />}

        {keys.value && total === 0 && (
          <EmptyState icon={<IconKeyRound size={28} />} title={msg.keys.emptyTitle} body={msg.keys.emptyBody}>
            <button type="button" className="btn btn-primary" onClick={() => setDialog("generate")}>
              <IconPlus size={16} />
              {msg.keys.generate}
            </button>
            <button type="button" className="btn" onClick={() => setDialog("import")}>
              {msg.keys.import}
            </button>
          </EmptyState>
        )}

        {total > 0 && (
          <ul className="list">
            {(keys.value ?? []).map((key) => (
              <li key={key.id}>
                <span className="tile-icon" aria-hidden="true">
                  <IconKeyRound size={17} />
                </span>
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
                <button type="button" className="btn btn-sm" onClick={() => void copyPublicKey(key)}>
                  {copied === key.id ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  <span aria-live="polite">{copied === key.id ? msg.common.copied : msg.keys.copyPublic}</span>
                </button>
                <IconButton size="sm" label={`${msg.common.delete} ${key.label}`} onClick={() => setDeleting(key)}>
                  <IconTrash2 size={15} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog === "generate" && <GenerateKeyDialog onClose={() => setDialog(null)} onDone={closeAndReload} />}
      {dialog === "import" && <ImportKeyDialog onClose={() => setDialog(null)} onDone={closeAndReload} />}

      {deleting && (
        <Dialog title={msg.keys.deleteTitle(deleting.label)} role="alertdialog" icon={<IconTrash2 size={18} />} tone="danger" onDismiss={() => setDeleting(null)}>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msg.keys.deleteBody}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDeleting(null)} autoFocus data-autofocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
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
    </div>
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
    <Dialog title={msg.keys.generateTitle} icon={<IconKeyRound size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msg.keys.generateBody}
        </p>
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
    <Dialog title={msg.keys.importTitle} icon={<IconFileCode size={18} />} wide onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msg.keys.importBody}
        </p>
        <TextField label={msg.keys.label} value={label} onChange={setLabel} autoFocus maxLength={256} />
        <TextArea label={msg.keys.privateKey} value={privateKey} onChange={setPrivateKey} rows={7} />
        <SecretField label={msg.keys.passphrase} value={passphrase} onChange={setPassphrase} hint={msg.keys.passphraseHint} maxLength={1024} />
        {passphrase !== "" && <Switch label={msg.keys.remember} checked={remember} onChange={setRemember} />}
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
