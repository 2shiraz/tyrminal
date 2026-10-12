import type { KeyCertificate, KeyKind, KeySummary } from "@tyrminal/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorNotice, IconButton, Notice, SecretField, SkeletonRows, Switch, TextArea, TextField } from "../../components/ui/controls";
import { IconCheck, IconCopy, IconFileCode, IconFolderOpen, IconKeyRound, IconPlus, IconShieldCheck, IconTrash2 } from "../../components/ui/icons";
import { keys as keysApi, keysD } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { useVaultData } from "../../app/vaultData";
import { useAction } from "../../lib/useAsync";

export function KeychainView() {
  // The shared list, so host views see a new or deleted key immediately.
  const { keys, hosts } = useVaultData();
  const [dialog, setDialog] = useState<"generate" | "import" | null>(null);
  const [deleting, setDeleting] = useState<KeySummary | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const remove = useAction();
  const [certificates, setCertificates] = useState<Map<string, KeyCertificate>>(new Map());
  const [certifying, setCertifying] = useState<KeySummary | null>(null);

  // Certificates are separate records; reload them with the key list.
  useEffect(() => {
    if (!keys.value) return;
    let live = true;
    keysD
      .certificates()
      .then((list) => {
        if (live) setCertificates(new Map(list.map((c) => [c.keyId, c])));
      })
      .catch(() => {
        if (live) setCertificates(new Map());
      });
    return () => {
      live = false;
    };
  }, [keys.value]);

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
    void hosts.reload();
  };

  return (
    <div className="page">
      <section className="page-inner" aria-labelledby="keys-title" style={{ maxWidth: 900 }}>
        <div className="page-header">
          <div className="page-title">
            <h1 id="keys-title">{msg.keys.title}</h1>
            <p>{msgD.keys.emptyBody}</p>
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
          <EmptyState icon={<IconKeyRound size={28} />} title={msg.keys.emptyTitle} body={msgD.keys.emptyBody}>
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
                  {certificates.has(key.id) && <CertificateLine certificate={certificates.get(key.id) as KeyCertificate} />}
                </div>
                <button type="button" className="btn btn-sm" onClick={() => setCertifying(key)}>
                  <IconShieldCheck size={14} />
                  {certificates.has(key.id) ? msgD.keys.certificate : msgD.keys.addCertificate}
                </button>
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

      {certifying && (
        <CertificateDialog
          keySummary={certifying}
          current={certificates.get(certifying.id) ?? null}
          onClose={() => setCertifying(null)}
          onDone={() => {
            setCertifying(null);
            void keys.reload();
          }}
        />
      )}

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
                void hosts.reload();
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
  const [kind, setKind] = useState<KeyKind>("ed25519");
  const { pending, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await run(() => (kind === "ed25519" ? keysApi.generate(label) : keysD.generate(label, kind)))) onDone();
  }

  return (
    <Dialog title={msg.keys.generateTitle} icon={<IconKeyRound size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msgD.keys.generateBody}
        </p>
        <TextField label={msg.keys.label} value={label} onChange={setLabel} autoFocus maxLength={256} />
        <label className="field">
          <span className="label">{msgD.keys.kind}</span>
          <select className="select" value={kind} onChange={(event) => setKind(event.target.value as KeyKind)}>
            {(Object.keys(msgD.keys.kinds) as KeyKind[]).map((k) => (
              <option key={k} value={k}>
                {msgD.keys.kinds[k]}
              </option>
            ))}
          </select>
          {kind.startsWith("rsa") && <span className="hint">{msgD.keys.rsaSlow}</span>}
        </label>
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
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { pending, error, run } = useAction();

  async function chosen(picked: File | undefined) {
    setFileProblem(null);
    if (!picked) return;
    if (picked.size > MAX_KEY_FILE_BYTES) {
      setFileProblem(msgD.keys.fileTooLarge);
      return;
    }
    setPrivateKey(await picked.text());
    if (label.trim() === "") setLabel(picked.name.replace(/\.(ppk|pem|key)$/i, ""));
  }

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
          {msgD.keys.importBody}
        </p>
        <TextField label={msg.keys.label} value={label} onChange={setLabel} autoFocus maxLength={256} />
        <TextArea label={msg.keys.privateKey} value={privateKey} onChange={setPrivateKey} rows={7} />
        <div className="row-flex">
          <button type="button" className="btn btn-sm" onClick={() => file.current?.click()}>
            <IconFolderOpen size={14} />
            {msgD.keys.chooseFile}
          </button>
          <input
            ref={file}
            type="file"
            hidden
            aria-label={msgD.keys.chooseFile}
            onChange={(event) => {
              void chosen(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
        {fileProblem && <Notice tone="warning">{fileProblem}</Notice>}
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

const MAX_KEY_FILE_BYTES = 1024 * 1024;

function CertificateLine({ certificate }: { certificate: KeyCertificate }) {
  const expiry =
    certificate.validBefore === null ? msgD.keys.certificateNoExpiry : msgD.keys.certificateExpires(new Date(certificate.validBefore * 1000).toLocaleString());
  return (
    <span className="row-sub" data-testid="key-certificate">
      <span className="badge">
        <IconShieldCheck size={12} />
        {msgD.keys.certificateBadge(certificate.principals)}
      </span>{" "}
      {expiry}
    </span>
  );
}

/** Attach, replace or remove the OpenSSH user certificate of one key. */
function CertificateDialog({
  keySummary,
  current,
  onClose,
  onDone,
}: {
  keySummary: KeySummary;
  current: KeyCertificate | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { pending, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await run(() => keysD.attachCertificate(keySummary.id, text))) onDone();
  }

  return (
    <Dialog title={msgD.keys.certificateFor(keySummary.label)} icon={<IconShieldCheck size={18} />} wide onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msgD.keys.certificateBody}
        </p>
        {current && (
          <div className="stack-xs">
            <CertificateLine certificate={current} />
            <span className="hint mono selectable">
              {current.algorithm} · CA {current.caFingerprint} · {current.certKeyId}
            </span>
          </div>
        )}
        <TextArea label={msgD.keys.certificateText} value={text} onChange={setText} rows={4} />
        <div className="row-flex">
          <button type="button" className="btn btn-sm" onClick={() => file.current?.click()}>
            <IconFolderOpen size={14} />
            {msgD.keys.chooseCertificate}
          </button>
          <input
            ref={file}
            type="file"
            hidden
            aria-label={msgD.keys.chooseCertificate}
            onChange={async (event) => {
              const picked = event.target.files?.[0];
              event.target.value = "";
              setFileProblem(null);
              if (!picked) return;
              if (picked.size > MAX_KEY_FILE_BYTES) setFileProblem(msgD.keys.fileTooLarge);
              else setText(await picked.text());
            }}
          />
        </div>
        {fileProblem && <Notice tone="warning">{fileProblem}</Notice>}
        <p className="hint">{msgD.keys.certificateUseNote}</p>
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          {current && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={pending}
              onClick={async () => {
                if (await run(async () => {
                  await keysD.removeCertificate(keySummary.id);
                  return true;
                }))
                  onDone();
              }}
            >
              {msgD.keys.removeCertificate}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={text.trim() === "" || pending}>
            {pending ? msg.common.working : current ? msgD.keys.replaceCertificate : msgD.keys.addCertificate}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
