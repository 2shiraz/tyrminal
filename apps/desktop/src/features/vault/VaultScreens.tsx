import { type FormEvent, useMemo, useState } from "react";

import { BrandMark } from "../../components/layout/Sidebar";
import { ErrorNotice, Notice, SecretField, TextField } from "../../components/ui/controls";
import { IconCopy, IconLock, IconShieldCheck } from "../../components/ui/icons";
import { vault } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";

function Brand() {
  return (
    <div className="brand" style={{ padding: 0, margin: 0 }}>
      <BrandMark size={30} />
      <span className="brand-name" style={{ fontSize: "var(--text-lg)" }}>
        {msg.app.name}
      </span>
    </div>
  );
}

/**
 * A rough guide only (length and character variety); the KDF, not this meter, protects the
 * vault. It never blocks a passphrase that meets the minimum length.
 */
export function passphraseScore(value: string): 0 | 1 | 2 | 3 | 4 {
  if (value.length === 0) return 0;
  if (value.length < 8) return 1;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(value)).length;
  const words = value.trim().split(/\s+/).length;
  if (value.length >= 20 || (value.length >= 16 && (classes >= 3 || words >= 4))) return 4;
  if (value.length >= 12 || classes >= 3) return 3;
  return 2;
}

/** First launch: create the local vault, then make sure the recovery key was actually saved. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const { pending, error, run } = useAction();

  const tooShort = passphrase.length > 0 && passphrase.length < 8;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = passphrase.length >= 8 && confirm === passphrase;
  const score = passphraseScore(passphrase);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || pending) return;
    const issued = await run(() => vault.create(passphrase));
    if (issued) {
      // The typed passphrase is no longer needed in this component.
      setPassphrase("");
      setConfirm("");
      setRecoveryKey(issued.recoveryKey);
    }
  }

  if (recoveryKey) {
    return (
      <RecoveryKeyStep
        recoveryKey={recoveryKey}
        onDone={() => {
          setRecoveryKey(null);
          onDone();
        }}
      />
    );
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit} aria-busy={pending}>
        <div className="auth-head">
          <Brand />
          <h1>{msg.onboarding.title}</h1>
          <p>{msg.onboarding.intro}</p>
        </div>
        <div className="stack-sm">
          <SecretField
            label={msg.onboarding.passphrase}
            value={passphrase}
            onChange={setPassphrase}
            hint={msg.onboarding.passphraseHint}
            error={tooShort ? msg.onboarding.tooShort : undefined}
            autoFocus
            maxLength={1024}
          />
          <div className="strength" data-score={score} aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <SecretField
          label={msg.onboarding.confirm}
          value={confirm}
          onChange={setConfirm}
          error={mismatch ? msg.onboarding.mismatch : undefined}
          maxLength={1024}
        />
        <Notice tone="warning">{msg.onboarding.noRecovery}</Notice>
        <ErrorNotice error={error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!ready || pending}>
          {pending ? (
            <>
              <span className="spinner" aria-hidden="true" />
              {msg.onboarding.creating}
            </>
          ) : (
            msg.onboarding.create
          )}
        </button>
        <div className="auth-foot">
          <IconShieldCheck size={14} />
          {msg.unlock.localOnly}
        </div>
      </form>
    </div>
  );
}

/** Shows the recovery key once and requires typing one group back before continuing. */
export function RecoveryKeyStep({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const groups = useMemo(() => recoveryKey.split("-"), [recoveryKey]);
  // Ask for a group from the middle so glancing at the start or end is not enough.
  const challenge = useMemo(() => 2 + Math.floor(Math.random() * Math.max(1, groups.length - 4)), [groups.length]);
  const [answer, setAnswer] = useState("");
  const [wrong, setWrong] = useState(false);
  const [copied, setCopied] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = answer.trim().toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
    if (normalized === groups[challenge]) onDone();
    else setWrong(true);
  }

  return (
    <div className="auth-screen">
      <form className="auth-card auth-card-wide" onSubmit={submit}>
        <div className="auth-head">
          <Brand />
          <h1>{msg.onboarding.recoveryTitle}</h1>
          <p>{msg.onboarding.recoveryIntro}</p>
        </div>
        <div className="recovery-key" aria-label={msg.unlock.recoveryKey}>
          {groups.map((group, index) => (
            // Fixed positions of one key.
            <span key={`${index}-${group}`}>{group} </span>
          ))}
        </div>
        <div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              // The user's own explicit copy of a secret they must store elsewhere.
              void navigator.clipboard.writeText(recoveryKey).then(() => setCopied(true)).catch(() => undefined);
            }}
          >
            <IconCopy size={14} />
            <span aria-live="polite">{copied ? msg.common.copied : msg.common.copy}</span>
          </button>
        </div>
        <TextField
          label={msg.onboarding.recoveryVerify(challenge + 1)}
          value={answer}
          onChange={(value) => {
            setAnswer(value);
            setWrong(false);
          }}
          error={wrong ? msg.onboarding.recoveryWrong : undefined}
          maxLength={8}
          autoComplete="off"
          className="input mono"
        />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={answer.trim().length === 0}>
          {msg.onboarding.recoveryDone}
        </button>
      </form>
    </div>
  );
}

export function Unlock({ busy }: { busy: boolean }) {
  const [mode, setMode] = useState<"passphrase" | "recovery">("passphrase");
  const [secret, setSecret] = useState("");
  const { pending, error, run, clearError } = useAction();
  const working = pending || busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!secret || working) return;
    const value = secret;
    setSecret("");
    await run(() => (mode === "passphrase" ? vault.unlock(value) : vault.unlockWithRecoveryKey(value)));
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit} aria-busy={working}>
        <div className="auth-head">
          <Brand />
          <h1>{msg.unlock.title}</h1>
          <p>{msg.unlock.localOnly}</p>
        </div>
        {mode === "passphrase" ? (
          <SecretField label={msg.unlock.passphrase} value={secret} onChange={setSecret} autoFocus maxLength={1024} />
        ) : (
          <TextField
            label={msg.unlock.recoveryKey}
            value={secret}
            onChange={setSecret}
            hint={msg.unlock.recoveryHint}
            autoFocus
            maxLength={256}
            autoComplete="off"
            className="input mono"
          />
        )}
        <ErrorNotice error={error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!secret || working}>
          {working ? (
            <>
              <span className="spinner" aria-hidden="true" />
              {msg.unlock.unlocking}
            </>
          ) : (
            <>
              <IconLock size={16} />
              {msg.unlock.unlock}
            </>
          )}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={() => {
            setMode(mode === "passphrase" ? "recovery" : "passphrase");
            setSecret("");
            clearError();
          }}
        >
          {mode === "passphrase" ? msg.unlock.useRecovery : msg.unlock.usePassphrase}
        </button>
      </form>
    </div>
  );
}
