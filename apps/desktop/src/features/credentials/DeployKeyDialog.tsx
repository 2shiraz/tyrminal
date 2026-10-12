import type { HostSummary, KeyDeployPreview, KeySummary } from "@tyrminal/contracts";
import { useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, Notice } from "../../components/ui/controls";
import { IconKeyRound } from "../../components/ui/icons";
import { hosts as hostsApi, keys as keysApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";

/**
 * Installs a public key on the server of a connected SSH session: choose a key, see what the
 * server's authorized_keys holds and the exact line that would be appended, then install. The
 * core does the work over the session's verified connection; nothing is run automatically.
 * Afterwards the host can be switched to sign in with that key.
 */
export function DeployKeyDialog({
  sessionId,
  host,
  keys,
  onClose,
  onHostChanged,
}: {
  sessionId: string;
  host: HostSummary | null;
  keys: KeySummary[];
  onClose: () => void;
  onHostChanged: () => void;
}) {
  const [keyId, setKeyId] = useState(keys[0]?.id ?? "");
  const [preview, setPreview] = useState<KeyDeployPreview | null>(null);
  const [installed, setInstalled] = useState(false);
  const [switched, setSwitched] = useState(false);
  const { pending, error, run } = useAction();

  async function check() {
    setPreview(null);
    setInstalled(false);
    const result = await run(() => keysApi.deployPreview(sessionId, keyId));
    if (result) setPreview(result);
  }

  async function install() {
    const result = await run(() => keysApi.deploy(sessionId, keyId));
    if (result) {
      setPreview(result);
      setInstalled(true);
    }
  }

  async function useForHost() {
    if (!host) return;
    const saved = await run(() =>
      hostsApi.save({
        id: host.id,
        label: host.label,
        address: host.address,
        port: host.inherited.port ? null : host.port,
        username: host.inherited.username ? "" : host.username,
        auth: { kind: "key", keyId },
        groupId: host.groupId,
        tags: host.tags,
      }),
    );
    if (saved) {
      setSwitched(true);
      onHostChanged();
    }
  }

  return (
    <Dialog title={msg.deploy.title} icon={<IconKeyRound size={18} />} onDismiss={onClose} wide>
      <div className="stack">
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msg.deploy.body(host?.label ?? msg.deploy.thisServer)}
        </p>
        {keys.length === 0 ? (
          <Notice tone="info">{msg.deploy.noKeys}</Notice>
        ) : (
          <label className="field">
            <span className="label">{msg.deploy.key}</span>
            <select
              className="select"
              value={keyId}
              onChange={(event) => {
                setKeyId(event.target.value);
                setPreview(null);
                setInstalled(false);
                setSwitched(false);
              }}
              data-autofocus
            >
              {keys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.label} ({key.algorithm})
                </option>
              ))}
            </select>
          </label>
        )}

        {preview && (
          <div className="stack-sm" data-testid="deploy-preview">
            {installed ? (
              <Notice tone="success">{msg.deploy.done(preview.path)}</Notice>
            ) : preview.alreadyPresent ? (
              <Notice tone="info">{msg.deploy.present(preview.path)}</Notice>
            ) : (
              <Notice tone="info">{msg.deploy.willAppend(preview.path, preview.existingKeys)}</Notice>
            )}
            <code className="mono selectable deploy-line">{preview.line}</code>
          </div>
        )}

        {installed && host && host.auth.kind !== "key" && !switched && (
          <Notice tone="info">
            {msg.deploy.switchPrompt(host.label)}{" "}
            <button type="button" className="btn btn-sm" onClick={useForHost} disabled={pending}>
              {msg.deploy.switch}
            </button>
          </Notice>
        )}
        {switched && <Notice tone="success">{msg.deploy.switched(host?.label ?? "")}</Notice>}

        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {installed ? msg.common.close : msg.common.cancel}
          </button>
          {!preview || (!installed && preview.alreadyPresent) ? (
            <button type="button" className="btn btn-primary" onClick={check} disabled={!keyId || pending}>
              {pending ? msg.common.working : msg.deploy.check}
            </button>
          ) : (
            !installed && (
              <button type="button" className="btn btn-primary" onClick={install} disabled={pending}>
                {pending ? msg.common.working : msg.deploy.install}
              </button>
            )
          )}
        </div>
      </div>
    </Dialog>
  );
}
