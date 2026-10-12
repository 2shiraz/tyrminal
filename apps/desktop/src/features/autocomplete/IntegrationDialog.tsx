import type { IntegrationShell, IntegrationStatus, IntegrationTarget } from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice } from "../../components/ui/controls";
import { IconCircleCheck, IconSquareTerminal, IconTriangleAlert } from "../../components/ui/icons";
import { promptMarks } from "../../lib/ipc";
import { msgD } from "../../lib/messages-d";
import { isMac } from "../../lib/platform";
import { useAction } from "../../lib/useAsync";

/**
 * Opt-in shell integration (AUT-07) for the focused terminal: the server's Bash for an SSH
 * session, or Bash/Zsh on this computer for a local terminal. The exact block is shown before
 * anything is written, and only the Install button writes it.
 */
export function IntegrationDialog({
  target,
  onClose,
}: {
  target: { kind: "ssh"; sessionId: string } | { kind: "local" };
  onClose: () => void;
}) {
  const [shell, setShell] = useState<IntegrationShell>(isMac ? "zsh" : "bash");
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [done, setDone] = useState<"installed" | "removed" | null>(null);
  const load = useAction();
  const change = useAction();
  const request: IntegrationTarget =
    target.kind === "ssh" ? { kind: "session", sessionId: target.sessionId } : { kind: "local", shell };
  const key = JSON.stringify(request);

  useEffect(() => {
    let live = true;
    setStatus(null);
    void load.run(() => promptMarks.status(JSON.parse(key) as IntegrationTarget)).then((s) => {
      if (live && s) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, [key, load.run]);

  async function apply(action: "install" | "remove") {
    setDone(null);
    const next = await change.run(() => (action === "install" ? promptMarks.install(request) : promptMarks.remove(request)));
    if (next) {
      setStatus(next);
      setDone(action === "install" ? "installed" : "removed");
    }
  }

  const installed = status?.installedVersion ?? null;
  const current = status !== null && installed === status.version;
  return (
    <Dialog title={msgD.integration.title} icon={<IconSquareTerminal size={18} />} wide onDismiss={onClose}>
      <div className="stack">
        <p className="muted">{msgD.integration.intro}</p>
        <div className="row-flex integration-target">
          <strong>{target.kind === "ssh" ? msgD.integration.server : msgD.integration.computer}</strong>
          {target.kind === "local" && (
            <label className="integration-shell">
              <span className="label">{msgD.integration.shell}</span>
              <select className="input" value={shell} onChange={(e) => setShell(e.target.value as IntegrationShell)}>
                <option value="bash">Bash</option>
                <option value="zsh">Zsh</option>
              </select>
            </label>
          )}
        </div>
        <ErrorNotice error={load.error} />
        {status && (
          <>
            <p data-testid="integration-status">
              {msgD.integration.where(status.path)} ·{" "}
              {installed === null
                ? msgD.integration.notInstalled
                : current
                  ? msgD.integration.installed(installed)
                  : msgD.integration.outdated(installed, status.version)}
            </p>
            {status.loginShell && status.loginShell !== "bash" && (
              <div className="notice notice-warning" role="note">
                <IconTriangleAlert size={16} />
                <span>{msgD.integration.loginShell(status.loginShell)}</span>
              </div>
            )}
            {target.kind === "local" && status.shell === "bash" && <p className="hint">{msgD.integration.localBash}</p>}
            <p className="hint">{status.fileExists ? msgD.integration.backup(status.backupPath) : msgD.integration.noFile}</p>
            <label className="field">
              <span className="label">{msgD.integration.script}</span>
              <pre className="integration-script mono" aria-label={msgD.integration.script} tabIndex={0}>
                {status.script}
              </pre>
            </label>
          </>
        )}
        <ErrorNotice error={change.error} />
        {done && (
          <div className="notice notice-success" role="status">
            <IconCircleCheck size={16} />
            <span>{done === "installed" ? msgD.integration.done : msgD.integration.removed}</span>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} data-autofocus>
            {msgD.integration.close}
          </button>
          {installed !== null && (
            <button type="button" className="btn btn-danger" disabled={change.pending} onClick={() => void apply("remove")}>
              {msgD.integration.remove}
            </button>
          )}
          {status && !current && (
            <button type="button" className="btn btn-primary" disabled={change.pending} onClick={() => void apply("install")}>
              {installed === null ? msgD.integration.install : msgD.integration.update}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
