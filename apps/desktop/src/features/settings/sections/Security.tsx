import { type FormEvent, useEffect, useState } from "react";

import { usePreferences } from "../../../app/preferences";
import { Dialog } from "../../../components/ui/Dialog";
import { ErrorNotice, Notice, SecretField, SettingRow } from "../../../components/ui/controls";
import { IconFingerprint } from "../../../components/ui/icons";
import { vault } from "../../../lib/ipc";
import { msg } from "../../../lib/messages";
import { msgProduction } from "../../../lib/messages-production";
import { useAction } from "../../../lib/useAsync";
import { RecoveryKeyStep } from "../../vault/VaultScreens";
import { msgSettings } from "../messages";
import { SettingsGroup } from "../SettingsGroup";

/** Vault and unlock: passphrase, recovery key and quick unlock on this device. */
/** The vault's lock times, as the core accepts them (crates/contracts limits::AUTO_LOCK_MINUTES). */
const AUTO_LOCK_MINUTES = [1, 5, 15, 30, 60, 240, 480] as const;
const DEFAULT_AUTO_LOCK_MINUTES = 5;

export function VaultSection() {
  const { prefs, update } = usePreferences();
  const [dialog, setDialog] = useState<"passphrase" | "recovery" | "quick" | null>(null);
  const [changed, setChanged] = useState(false);
  const [quickKey, setQuickKey] = useState(0);
  return (
    <>
      {changed && (
        <div role="status">
          <Notice tone="success">{msg.settings.changed}</Notice>
        </div>
      )}
      <SettingsGroup title={msgSettings.locking}>
        <SettingRow label={msgSettings.autoLock} hint={msgSettings.autoLockHint} id="auto-lock">
          <select
            className="select"
            aria-label={msgSettings.autoLock}
            value={String(prefs.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES)}
            onChange={(event) => update((p) => ({ ...p, autoLockMinutes: Number(event.target.value) }))}
          >
            {AUTO_LOCK_MINUTES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {msgSettings.autoLockChoice(minutes)}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title={msgSettings.passphrase}>
        <SettingRow label={msgSettings.passphraseRow} hint={msgSettings.passphraseHint} id="passphrase" variant="action">
          <button type="button" className="btn" onClick={() => setDialog("passphrase")}>
            {msg.settings.changePassphrase}
          </button>
        </SettingRow>
        <SettingRow label={msgSettings.recoveryRow} hint={msgSettings.recoveryHint} id="recovery-key" variant="action">
          <button type="button" className="btn" onClick={() => setDialog("recovery")}>
            {msg.settings.rotateRecovery}
          </button>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title={msgSettings.quickUnlock}>
        <QuickUnlockSetting key={quickKey} onEnable={() => setDialog("quick")} />
      </SettingsGroup>
      <SettingsGroup title={msgSettings.production}>
        <ProductionTagSetting value={prefs.productionTag} onCommit={(productionTag) => update((p) => ({ ...p, productionTag }))} />
      </SettingsGroup>

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
      {dialog === "quick" && (
        <EnableQuickUnlockDialog
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setQuickKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}

/** Quick unlock state for this device, with the button to turn it on (via a dialog) or off. */
function QuickUnlockSetting({ onEnable }: { onEnable: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const { pending, error, run } = useAction();
  useEffect(() => {
    let alive = true;
    vault.quickUnlockStatus().then(
      (on) => alive && setEnabled(on),
      () => alive && setEnabled(false),
    );
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div data-testid="quick-unlock">
      <SettingRow
        label={msg.quickUnlock.title}
        id="quick-unlock"
        variant="action"
        hint={
          <>
            {msg.quickUnlock.body}
            {enabled !== null && (
              <span role="status" className="setting-status">
                {" "}
                {enabled ? msg.quickUnlock.on : msg.quickUnlock.off}
              </span>
            )}
          </>
        }
      >
        {enabled ? (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={async () => {
              const done = await run(async () => {
                await vault.disableQuickUnlock();
                return true;
              });
              if (done) setEnabled(false);
            }}
          >
            {msg.quickUnlock.disable}
          </button>
        ) : (
          <button type="button" className="btn" disabled={enabled === null} onClick={onEnable}>
            <IconFingerprint size={15} />
            {msg.quickUnlock.enable}
          </button>
        )}
      </SettingRow>
      <ErrorNotice error={error} />
    </div>
  );
}

function EnableQuickUnlockDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const { pending, error, run } = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!passphrase || pending) return;
    const value = passphrase;
    setPassphrase("");
    const ok = await run(async () => {
      await vault.enableQuickUnlock(value);
      return true;
    });
    if (ok) onDone();
  }
  return (
    <Dialog title={msg.quickUnlock.confirmTitle} icon={<IconFingerprint size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit} aria-busy={pending}>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msg.quickUnlock.body} {msg.quickUnlock.confirmBody}
        </p>
        <SecretField label={msg.settings.current} value={passphrase} onChange={setPassphrase} autoFocus maxLength={1024} />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!passphrase || pending}>
            {pending ? msg.common.working : msg.quickUnlock.confirm}
          </button>
        </div>
      </form>
    </Dialog>
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
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msg.settings.changeBody}
        </p>
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
      <div style={{ position: "fixed", inset: 0, zIndex: 50 }}>
        <RecoveryKeyStep recoveryKey={issued} onDone={onClose} />
      </div>
    );
  }

  return (
    <Dialog title={msg.settings.rotateRecovery} onDismiss={onClose}>
      <form className="stack" onSubmit={submit} aria-busy={pending}>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msg.settings.rotateBody}
        </p>
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


/** The tag that marks production hosts (P-26); saved when the field is left or Enter is pressed. */
function ProductionTagSetting({ value, onCommit }: { value: string; onCommit: (tag: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const tag = text.trim();
    if (tag !== value) onCommit(tag);
  };
  return (
    <SettingRow label={msgProduction.settingTag} hint={msgProduction.settingTagHint} id="production-tag">
      <input
        className="input"
        aria-label={msgProduction.settingTag}
        value={text}
        maxLength={32}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </SettingRow>
  );
}
