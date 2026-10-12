import type { SessionEvent } from "@tyrminal/contracts";
import { useEffect, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Dialog } from "../../components/ui/Dialog";
import { IconKeyRound } from "../../components/ui/icons";
import { sessions } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { TrustDialog } from "../sftp/SftpPane";
import { AuthDialog } from "../terminal/AuthDialog";
import { DeployKeyDialog } from "./DeployKeyDialog";

type Trust = Extract<SessionEvent, { type: "trust_prompt" }>;
type Auth = Extract<SessionEvent, { type: "auth_prompt" }>;

/**
 * Installs a Keychain key on a server that does not accept it yet: choose the server (unless it
 * is given), sign in to it once with its password (the normal host-key check and password
 * prompt, never automatic), then the usual preview and install. The connection is files-only
 * and is closed when the dialog closes.
 */
export function InstallKeyDialog({ hostId: givenHost, keyId, onClose }: { hostId?: string | undefined; keyId?: string | undefined; onClose: () => void }) {
  const { hosts, keys } = useVaultData();
  const sshHosts = (hosts.value ?? []).filter((h) => h.protocol.type === "ssh");
  const [hostId, setHostId] = useState(givenHost ?? "");
  const [phase, setPhase] = useState<"choose" | "signing_in" | "connected">("choose");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [trust, setTrust] = useState<Trust | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const session = useRef<string | null>(null);
  const attempt = useRef(0);

  // The install connection never outlives the dialog.
  useEffect(
    () => () => {
      attempt.current += 1;
      if (session.current) void sessions.close(session.current).catch(() => undefined);
    },
    [],
  );

  const host = sshHosts.find((h) => h.id === hostId) ?? null;
  const key = keyId ? (keys.value ?? []).find((k) => k.id === keyId) : undefined;

  function signIn() {
    if (!hostId) return;
    const mine = ++attempt.current;
    setFailure(null);
    setPhase("signing_in");
    const onEvent = (event: SessionEvent) => {
      if (mine !== attempt.current) return;
      switch (event.type) {
        case "trust_prompt":
          setTrust(event);
          break;
        case "auth_prompt":
          setAuth(event);
          break;
        case "state":
          if (event.state === "connected") setPhase("connected");
          break;
        case "closed":
          session.current = null;
          setSessionId(null);
          setTrust(null);
          setAuth(null);
          setPhase("choose");
          if (event.error) setFailure({ message: event.error.message });
          break;
        default:
          break;
      }
    };
    sessions
      .openForKeyInstall(hostId, onEvent)
      .then((opened) => {
        if (mine !== attempt.current) {
          void sessions.close(opened.sessionId).catch(() => undefined);
          return;
        }
        session.current = opened.sessionId;
        setSessionId(opened.sessionId);
      })
      .catch((error: Error) => {
        if (mine !== attempt.current) return;
        setPhase("choose");
        setFailure({ message: error.message });
      });
  }

  if (phase === "connected" && sessionId) {
    return <DeployKeyDialog sessionId={sessionId} host={host} keys={keys.value ?? []} initialKeyId={keyId} onClose={onClose} onHostChanged={() => void hosts.reload()} />;
  }

  return (
    <>
      <Dialog title={key ? msgD.installKey.titleFor(key.label) : msgD.installKey.title} icon={<IconKeyRound size={18} />} onDismiss={onClose}>
        <div className="stack">
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msgD.installKey.body(host?.label ?? msg.deploy.thisServer)}
          </p>
          {!givenHost &&
            (sshHosts.length === 0 ? (
              <p className="muted">{msgD.installKey.noHosts}</p>
            ) : (
              <label className="field">
                <span className="label">{msgD.installKey.host}</span>
                <select className="select" value={hostId} onChange={(e) => setHostId(e.target.value)} disabled={phase !== "choose"} data-autofocus>
                  <option value="" disabled>
                    {msgD.installKey.hostChoose}
                  </option>
                  {sshHosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label} ({h.username}@{h.address})
                    </option>
                  ))}
                </select>
              </label>
            ))}
          {failure && (
            <div className="notice notice-danger" role="alert">
              <span>
                {msgD.installKey.failed} {failure.message}
              </span>
            </div>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose} data-autofocus={givenHost ? true : undefined}>
              {msgD.installKey.cancel}
            </button>
            <button type="button" className="btn btn-primary" disabled={!hostId || phase !== "choose"} onClick={signIn}>
              {phase === "signing_in" ? msgD.installKey.signingIn : failure ? msgD.installKey.retry : msgD.installKey.signIn}
            </button>
          </div>
        </div>
      </Dialog>
      {trust && (
        <TrustDialog
          trust={trust}
          onAnswer={(decision) => {
            const promptId = trust.promptId;
            setTrust(null);
            if (session.current) void sessions.answerTrust(session.current, promptId, decision).catch(() => undefined);
          }}
        />
      )}
      {auth && !trust && (
        <AuthDialog
          key={auth.promptId}
          prompt={auth}
          banner={null}
          onAnswer={(secret) => {
            const promptId = auth.promptId;
            setAuth(null);
            if (session.current) void sessions.answerAuth(session.current, promptId, secret).catch(() => undefined);
          }}
        />
      )}
    </>
  );
}
