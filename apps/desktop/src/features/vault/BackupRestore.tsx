import type { BackupCredentialKind, BackupFile, BackupPreview } from "@tyrminal/contracts";
import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/Toasts";
import { ErrorNotice, Notice, SecretField, Segmented, Switch, relativeTime } from "../../components/ui/controls";
import { IconCircleCheck, IconDownload, IconFolderOpen, IconUpload } from "../../components/ui/icons";
import { backup } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";

/** Saves a backup of the unlocked vault through the native save dialog. */
export function ExportBackupButton() {
  const notify = useToast();
  const { pending, error, run } = useAction();
  return (
    <div className="stack-sm">
      <div>
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={async () => {
            const name = await run(() => backup.export());
            if (name) notify("success", msg.backup.exported(name));
          }}
        >
          <IconDownload size={15} />
          {msg.backup.export}
        </button>
      </div>
      <ErrorNotice error={error} />
    </div>
  );
}

/**
 * Restore in three steps: pick a file (native dialog), check it with its passphrase or recovery
 * key (full validation, nothing written), then restore. Replacing an existing vault needs an
 * explicit switch. A restored vault is locked; the app returns to the unlock screen by itself.
 */
export function RestoreBackupDialog({ vaultExists, onClose, onRestored }: { vaultExists: boolean; onClose: () => void; onRestored: () => void }) {
  const [file, setFile] = useState<BackupFile | null>(null);
  const [kind, setKind] = useState<BackupCredentialKind>("passphrase");
  const [secret, setSecret] = useState("");
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [replace, setReplace] = useState(false);
  const { pending, error, run } = useAction();

  function reset() {
    setPreview(null);
    setReplace(false);
  }

  async function choose() {
    const picked = await run(() => backup.choose());
    if (picked) {
      setFile(picked);
      reset();
    }
  }

  async function check(event: FormEvent) {
    event.preventDefault();
    if (!file || secret === "" || pending) return;
    const result = await run(() => backup.preview(kind, secret));
    if (result) setPreview(result);
  }

  async function restore() {
    if (!preview || pending || (vaultExists && !replace)) return;
    const done = await run(() => backup.restore(kind, secret, vaultExists));
    if (done) {
      setSecret("");
      onRestored();
    }
  }

  return (
    <Dialog title={msg.backup.dialogTitle} icon={<IconUpload size={18} />} onDismiss={onClose} wide>
      <form className="stack" onSubmit={check}>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msg.backup.body}
        </p>
        <div className="row-flex" style={{ flexWrap: "wrap" }}>
          <button type="button" className="btn" onClick={choose} disabled={pending} data-autofocus>
            <IconFolderOpen size={15} />
            {msg.backup.choose}
          </button>
          {file && (
            <span className="mono selectable" data-testid="backup-file">
              {msg.backup.chosen(file.fileName, Math.max(1, Math.round(file.size / 1024)))}
            </span>
          )}
        </div>
        {file && (
          <>
            <Segmented
              label={msg.backup.kind}
              value={kind}
              onChange={(value) => {
                // A passphrase typed for the other kind must not linger in the field.
                setKind(value);
                setSecret("");
                reset();
              }}
              options={[
                { value: "passphrase", label: msg.backup.passphrase },
                { value: "recovery_key", label: msg.backup.recoveryKey },
              ]}
            />
            <SecretField
              label={kind === "passphrase" ? msg.backup.secretPassphrase : msg.backup.secretRecovery}
              value={secret}
              onChange={(value) => {
                setSecret(value);
                reset();
              }}
              maxLength={1024}
            />
          </>
        )}
        {preview && (
          <div role="status" className="stack-sm" data-testid="backup-preview">
            <Notice tone="success">
              <IconCircleCheck size={15} /> <strong>{msg.backup.previewTitle}.</strong>{" "}
              {msg.backup.previewBody(relativeTime(preview.createdAt))}
            </Notice>
            <p className="tabular">{msg.backup.previewCounts(preview.hosts, preview.keys, preview.knownHosts, preview.snippets)}</p>
            {vaultExists && <Switch label={msg.backup.replaceLabel} hint={msg.backup.replaceHint} checked={replace} onChange={setReplace} />}
          </div>
        )}
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          {preview ? (
            <button
              type="button"
              className={vaultExists ? "btn btn-danger" : "btn btn-primary"}
              disabled={pending || (vaultExists && !replace)}
              onClick={restore}
            >
              {pending ? msg.backup.restoring : msg.backup.restoreAction}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={!file || secret === "" || pending}>
              {pending ? msg.backup.checking : msg.backup.check}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
