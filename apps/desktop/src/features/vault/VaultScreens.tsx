import { type FormEvent, useMemo, useState } from "react";

import { ErrorNotice, Notice, SecretField, TextField } from "../../components/ui/controls";
import { vault } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        &gt;_
      </span>
      <strong>{msg.app.name}</strong>
    </div>
  );
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
    <div className="center-screen">
      <form className="card" onSubmit={submit} aria-busy={pending}>
        <Brand />
        <div className="stack-sm">
          <h1>{msg.onboarding.title}</h1>
          <p className="muted">{msg.onboarding.intro}</p>
        </div>
        <SecretField
          label={msg.onboarding.passphrase}
          value={passphrase}
          onChange={setPassphrase}
          hint={msg.onboarding.passphraseHint}
          error={tooShort ? msg.onboarding.tooShort : undefined}
          autoFocus
          maxLength={1024}
        />
        <SecretField
          label={msg.onboarding.confirm}
          value={confirm}
          onChange={setConfirm}
          error={mismatch ? msg.onboarding.mismatch : undefined}
          maxLength={1024}
        />
        <Notice tone="warning" icon="!">
          {msg.onboarding.noRecovery}
        </Notice>
        <ErrorNotice error={error} />
        <button type="submit" className="btn btn-primary" disabled={!ready || pending}>
          {pending ? msg.onboarding.creating : msg.onboarding.create}
        </button>
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

  function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = answer.trim().toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
    if (normalized === groups[challenge]) onDone();
    else setWrong(true);
  }

  return (
    <div className="center-screen">
      <form className="card" onSubmit={submit}>
        <Brand />
        <div className="stack-sm">
          <h1>{msg.onboarding.recoveryTitle}</h1>
          <p className="muted">{msg.onboarding.recoveryIntro}</p>
        </div>
        <div className="recovery-key" aria-label={msg.unlock.recoveryKey}>
          {groups.join(" ")}
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
        <button type="submit" className="btn btn-primary" disabled={answer.trim().length === 0}>
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
    <div className="center-screen">
      <form className="card" onSubmit={submit} aria-busy={working}>
        <Brand />
        <div className="stack-sm">
          <h1>{msg.unlock.title}</h1>
          <p className="muted">{msg.unlock.localOnly}</p>
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
        <button type="submit" className="btn btn-primary" disabled={!secret || working}>
          {working ? msg.unlock.unlocking : msg.unlock.unlock}
        </button>
        <button
          type="button"
          className="btn btn-quiet"
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
