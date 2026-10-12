import type { KnownHostSummary, Preferences, TerminalPreferences } from "@tyrminal/contracts";
import { type FormEvent, Suspense, lazy, useEffect, useState } from "react";

import { DEFAULT_PREFERENCES, usePreferences } from "../../app/preferences";
import { Dialog } from "../../components/ui/Dialog";
import {
  EmptyState,
  ErrorNotice,
  Notice,
  RangeField,
  Segmented,
  SecretField,
  SettingRow,
  SkeletonRows,
  Switch,
  TextArea,
  relativeTime,
} from "../../components/ui/controls";
import { IconFingerprint, IconMonitor, IconPlus, IconMoon, IconShieldAlert, IconSun, IconTrash2 } from "../../components/ui/icons";
import { diagnostics, hosts as hostsApi, keys as keysApi, knownHosts as knownHostsApi, links as linksApi, preferences as preferencesApi, vault } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction, useLoaded } from "../../lib/useAsync";
import { SchemePreview } from "../terminal/SchemePreview";
import { SCHEMES, lowContrastColors } from "../terminal/schemes";
import { HostEditor } from "../hosts/HostEditor";
import { ExportBackupButton, RestoreBackupDialog } from "../vault/BackupRestore";
import { RecoveryKeyStep } from "../vault/VaultScreens";
// compromised-password check (SEC-11)
import { PasswordCheckSetting } from "../password-check/PasswordCheckSetting";
import { AboutSection } from "./AboutSection";
import { WorkspaceSettings } from "../layouts/WorkspaceSettings"; // agent C: workspaces
import { msgC } from "../../lib/messages-c";

// The preview pulls in the terminal emulator; load it only when Settings opens.
const TerminalPreview = lazy(() => import("../terminal/TerminalPreview").then((m) => ({ default: m.TerminalPreview })));

export function KnownHostsView() {
  const list = useLoaded(knownHostsApi.list);
  const [removing, setRemoving] = useState<KnownHostSummary | null>(null);
  // Creating a host from a trusted record (SEC-03): the key is already trusted, so the first
  // connection goes straight to sign-in.
  const savedHosts = useLoaded(hostsApi.list);
  const keyList = useLoaded(keysApi.list);
  const [creating, setCreating] = useState<KnownHostSummary | null>(null);
  const hasHost = (entry: KnownHostSummary) =>
    (savedHosts.value ?? []).some((h) => h.address.toLowerCase() === entry.host.toLowerCase() && h.port === entry.port);

  return (
    <div className="page">
      <section className="page-inner" aria-labelledby="known-title" style={{ maxWidth: 900 }}>
        <div className="page-header">
          <div className="page-title">
            <h1 id="known-title">{msg.knownHosts.title}</h1>
            <p>{msg.knownHosts.intro}</p>
          </div>
        </div>
        <ErrorNotice error={list.error} />
        {list.value === null && !list.error && <SkeletonRows count={2} />}
        {list.value?.length === 0 && <EmptyState icon={<IconFingerprint size={28} />} title={msg.knownHosts.emptyTitle} body={msg.knownHosts.emptyBody} />}
        {(list.value?.length ?? 0) > 0 && (
          <ul className="list">
            {(list.value ?? []).map((entry) => (
              <li key={entry.id}>
                <span className="tile-icon" aria-hidden="true">
                  <IconFingerprint size={17} />
                </span>
                <div className="row-main">
                  <span className="row-title">{msg.knownHosts.endpoint(entry.host, entry.port)}</span>
                  <span className="row-sub mono selectable">
                    {entry.algorithm} · {entry.fingerprint}
                  </span>
                  <span className="row-sub">{relativeTime(entry.addedAt)}</span>
                </div>
                {savedHosts.value && !hasHost(entry) && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setCreating(entry)}
                    aria-label={msg.knownHosts.createHostFor(msg.knownHosts.endpoint(entry.host, entry.port))}
                  >
                    <IconPlus size={14} aria-hidden="true" />
                    {msg.knownHosts.createHost}
                  </button>
                )}
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setRemoving(entry)}>
                  {msg.knownHosts.remove}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {creating && (
        <HostEditor
          host={null}
          initial={{ address: creating.host, port: creating.port, username: "" }}
          keys={keyList.value ?? []}
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null);
            void savedHosts.reload();
          }}
        />
      )}
      {removing && (
        <RemoveTrustDialog
          entry={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            void list.reload();
          }}
        />
      )}
    </div>
  );
}

function RemoveTrustDialog({ entry, onClose, onDone }: { entry: KnownHostSummary; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const { pending, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(async () => {
      await knownHostsApi.remove(entry.id, reason);
      return true;
    });
    if (ok) onDone();
  }

  return (
    <Dialog title={msg.knownHosts.removeTitle(entry.host, entry.port)} role="alertdialog" icon={<IconShieldAlert size={18} />} tone="danger" onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <Notice tone="warning">{msg.knownHosts.removeBody}</Notice>
        <TextArea label={msg.knownHosts.reason} value={reason} onChange={setReason} hint={msg.knownHosts.reasonHint} rows={3} maxLength={500} autoFocus mono={false} />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-danger-solid" disabled={reason.trim().length < 3 || pending}>
            <IconTrash2 size={15} />
            {msg.knownHosts.remove}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export type Section = "appearance" | "terminal" | "shortcuts" | "security" | "backup" | "privacy" | "about";

export function SettingsView({ initialSection }: { initialSection?: Section | undefined } = {}) {
  const { prefs, update, saveError } = usePreferences();
  const [section, setSection] = useState<Section>(initialSection ?? "appearance");
  useEffect(() => {
    if (initialSection) document.getElementById(`settings-${initialSection}`)?.scrollIntoView({ block: "start" });
  }, [initialSection]);
  const [dialog, setDialog] = useState<"passphrase" | "recovery" | "restore" | "quick" | null>(null);
  const [changed, setChanged] = useState(false);
  const [quickKey, setQuickKey] = useState(0);
  const setTerminal = (patch: Partial<TerminalPreferences>) => update((p: Preferences) => ({ ...p, terminal: { ...p.terminal, ...patch } }));
  const t = prefs.terminal;
  const [shells, setShells] = useState<string[] | null>(null);
  useEffect(() => {
    preferencesApi
      .shells()
      .then(setShells)
      .catch(() => setShells([]));
  }, []);

  const sections: { id: Section; label: string }[] = [
    { id: "appearance", label: msg.settings.appearance },
    { id: "terminal", label: msg.settings.terminal },
    { id: "shortcuts", label: msgC.keys.title },
    { id: "security", label: msg.settings.security },
    { id: "backup", label: msg.backup.title },
    { id: "privacy", label: msg.settings.privacy },
    { id: "about", label: msg.about.title },
  ];

  return (
    <div className="page">
      <section className="page-inner" aria-labelledby="settings-title">
        <div className="page-header">
          <h1 id="settings-title">{msg.settings.title}</h1>
        </div>
        {saveError && <Notice tone="danger">{msg.settings.saveFailed}</Notice>}
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={msg.settings.title}>
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className="nav-item"
                aria-current={section === s.id ? "page" : undefined}
                onClick={() => {
                  setSection(s.id);
                  document.getElementById(`settings-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="stack" style={{ gap: "var(--space-5)" }}>
            <section id="settings-appearance" className="settings-section" aria-labelledby="settings-appearance-title">
              <header>
                <h2 id="settings-appearance-title">{msg.settings.appearance}</h2>
                <p>{msg.settings.appearanceBody}</p>
              </header>
              <SettingRow label={msg.settings.theme}>
                <Segmented
                  label={msg.settings.theme}
                  value={prefs.theme}
                  onChange={(theme) => update((p) => ({ ...p, theme }))}
                  options={[
                    { value: "system", label: msg.settings.themeSystem, icon: <IconMonitor size={14} /> },
                    { value: "light", label: msg.settings.themeLight, icon: <IconSun size={14} /> },
                    { value: "dark", label: msg.settings.themeDark, icon: <IconMoon size={14} /> },
                  ]}
                />
              </SettingRow>
              <Switch
                label={msg.settings.reduceMotion}
                hint={msg.settings.reduceMotionHint}
                checked={prefs.reduceMotion}
                onChange={(reduceMotion) => update((p) => ({ ...p, reduceMotion }))}
              />
            </section>

            <section id="settings-terminal" className="settings-section" aria-labelledby="settings-terminal-title">
              <header>
                <h2 id="settings-terminal-title">{msg.settings.terminal}</h2>
                <p>{msg.settings.terminalBody}</p>
              </header>
              {/* A picture of the settings, not a terminal: nothing inside can take focus. */}
              <div inert>
                <Suspense fallback={<div className="terminal-preview skeleton" />}>
                  <TerminalPreview prefs={t} />
                </Suspense>
              </div>

              <div className="stack-sm">
                <span className="label" id="scheme-label">
                  {msg.settings.scheme}
                </span>
                <div className="scheme-grid" role="radiogroup" aria-labelledby="scheme-label">
                  {SCHEMES.map((scheme) => {
                    const low = lowContrastColors(scheme);
                    return (
                      <button
                        key={scheme.id}
                        type="button"
                        role="radio"
                        aria-checked={t.scheme === scheme.id}
                        className="scheme-card"
                        onClick={() => setTerminal({ scheme: scheme.id })}
                        data-tooltip={low.length ? msg.settings.lowContrast(low.join(", ")) : undefined}
                      >
                        <SchemePreview scheme={scheme} />
                        <span className="scheme-name">
                          <span className="truncate">{scheme.name}</span>
                          <span className="faint" style={{ fontWeight: 400 }}>
                            {scheme.kind === "dark" ? <IconMoon size={12} /> : <IconSun size={12} />}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <SettingRow label={msg.settings.localShell} hint={msg.settings.localShellHint}>
                <select
                  className="select"
                  aria-label={msg.settings.localShell}
                  value={prefs.localShell ?? ""}
                  onChange={(event) => update((p) => ({ ...p, localShell: event.target.value === "" ? null : event.target.value }))}
                >
                  <option value="">{msg.settings.localShellDefault}</option>
                  {(shells ?? []).map((shell) => (
                    <option key={shell} value={shell}>
                      {shell}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <SettingRow label={msg.settings.editors} hint={msg.settings.editorsHint}>
                <EditorChoices
                  apps={prefs.editorApps ?? []}
                  onRemove={(ext) => update((p) => ({ ...p, editorApps: (p.editorApps ?? []).filter((e) => e.extension !== ext) }))}
                  onAdded={(next) => update(() => next)}
                />
              </SettingRow>
              <SettingRow label={msg.settings.font}>
                <select
                  className="select"
                  aria-label={msg.settings.font}
                  value={t.fontFamily}
                  onChange={(event) => setTerminal({ fontFamily: event.target.value })}
                >
                  <option value="jetbrains-mono">{msg.settings.fontBundled}</option>
                  <option value="system">{msg.settings.fontSystem}</option>
                </select>
              </SettingRow>
              <SettingRow label={msg.settings.fontSize}>
                <RangeField label={msg.settings.fontSize} value={t.fontSize} min={9} max={24} step={1} format={(v) => `${v}px`} onChange={(fontSize) => setTerminal({ fontSize })} />
              </SettingRow>
              <SettingRow label={msg.settings.lineHeight}>
                <RangeField
                  label={msg.settings.lineHeight}
                  value={t.lineHeight}
                  min={1}
                  max={1.8}
                  step={0.05}
                  format={(v) => v.toFixed(2)}
                  onChange={(lineHeight) => setTerminal({ lineHeight })}
                />
              </SettingRow>
              <SettingRow label={msg.settings.letterSpacing}>
                <RangeField
                  label={msg.settings.letterSpacing}
                  value={t.letterSpacing}
                  min={-1}
                  max={3}
                  step={0.5}
                  format={(v) => `${v}px`}
                  onChange={(letterSpacing) => setTerminal({ letterSpacing })}
                />
              </SettingRow>
              <SettingRow label={msg.settings.padding}>
                <RangeField label={msg.settings.padding} value={t.padding} min={0} max={24} step={2} format={(v) => `${v}px`} onChange={(padding) => setTerminal({ padding })} />
              </SettingRow>
              <SettingRow label={msg.settings.cursor}>
                <Segmented
                  label={msg.settings.cursor}
                  value={t.cursorStyle}
                  onChange={(cursorStyle) => setTerminal({ cursorStyle })}
                  options={[
                    { value: "block", label: msg.settings.cursorBlock },
                    { value: "bar", label: msg.settings.cursorBar },
                    { value: "underline", label: msg.settings.cursorUnderline },
                  ]}
                />
              </SettingRow>
              <SettingRow label={msg.settings.scrollback} hint={msg.settings.scrollbackHint}>
                <select
                  className="select"
                  aria-label={msg.settings.scrollback}
                  value={String(t.scrollback)}
                  onChange={(event) => setTerminal({ scrollback: Number(event.target.value) })}
                >
                  {[1000, 5000, 10000, 25000, 50000, 100000].map((n) => (
                    <option key={n} value={n}>
                      {n.toLocaleString()}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <div>
                <Switch label={msg.settings.cursorBlink} checked={t.cursorBlink} onChange={(cursorBlink) => setTerminal({ cursorBlink })} />
                <Switch label={msg.settings.ligatures} hint={msg.settings.ligaturesHint} checked={t.ligatures} onChange={(ligatures) => setTerminal({ ligatures })} />
                <Switch
                  label={msg.settings.renderer}
                  hint={msg.settings.rendererHint}
                  checked={t.renderer === "auto"}
                  onChange={(on) => setTerminal({ renderer: on ? "auto" : "compatibility" })}
                />
                <Switch
                  label={msg.settings.confirmPaste}
                  hint={msg.settings.confirmPasteHint}
                  checked={t.confirmMultilinePaste}
                  onChange={(confirmMultilinePaste) => setTerminal({ confirmMultilinePaste })}
                />
                <Switch label={msg.settings.copyOnSelect} checked={t.copyOnSelect} onChange={(copyOnSelect) => setTerminal({ copyOnSelect })} />
              </div>
              <div>
                <button type="button" className="btn btn-ghost" onClick={() => update((p) => ({ ...p, terminal: DEFAULT_PREFERENCES.terminal }))}>
                  {msg.settings.reset}
                </button>
              </div>
            </section>

            <WorkspaceSettings />

            <section id="settings-security" className="settings-section" aria-labelledby="settings-security-title">
              <header>
                <h2 id="settings-security-title">{msg.settings.security}</h2>
                <p>{msg.settings.autoLock}</p>
              </header>
              {changed && (
                <div role="status">
                  <Notice tone="success">{msg.settings.changed}</Notice>
                </div>
              )}
              <div className="row-flex" style={{ flexWrap: "wrap" }}>
                <button type="button" className="btn" onClick={() => setDialog("passphrase")}>
                  {msg.settings.changePassphrase}
                </button>
                <button type="button" className="btn" onClick={() => setDialog("recovery")}>
                  {msg.settings.rotateRecovery}
                </button>
              </div>
              <QuickUnlockSetting key={quickKey} onEnable={() => setDialog("quick")} />
              {/* compromised-password check (SEC-11) */}
              <PasswordCheckSetting />
            </section>

            <section id="settings-backup" className="settings-section" aria-labelledby="settings-backup-title">
              <header>
                <h2 id="settings-backup-title">{msg.backup.title}</h2>
                <p>{msg.backup.body}</p>
              </header>
              <div className="row-flex" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
                <ExportBackupButton />
                <button type="button" className="btn" onClick={() => setDialog("restore")}>
                  {msg.backup.restore}
                </button>
              </div>
            </section>

            <section id="settings-privacy" className="settings-section" aria-labelledby="settings-privacy-title">
              <header>
                <h2 id="settings-privacy-title">{msg.settings.privacy}</h2>
                <p>{msg.settings.privacyBody}</p>
              </header>
              <DiagnosticsSetting enabled={prefs.diagnostics} onChange={(diagnostics) => update((p) => ({ ...p, diagnostics }))} />
              <div className="settings-row">
                <div>
                  <h3>{msg.settings.updates}</h3>
                  <p className="muted">{msg.settings.updatesBody(__APP_VERSION__)}</p>
                </div>
                <button type="button" className="btn" onClick={() => void linksApi.open(msg.settings.releasesUrl).catch(() => undefined)}>
                  {msg.settings.updatesOpen}
                </button>
              </div>
              <Notice tone="warning">
                <strong>{msg.settings.status}.</strong> {msg.settings.statusBody}
              </Notice>
            </section>

            <AboutSection />
          </div>
        </div>
      </section>

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
      {/* After a restore the vault locks and the app shows the unlock screen on its own. */}
      {dialog === "restore" && <RestoreBackupDialog vaultExists onClose={() => setDialog(null)} onRestored={() => setDialog(null)} />}
    </div>
  );
}

/** P-22: local diagnostics, off by default; a report is only ever saved on request. */
function DiagnosticsSetting({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [count, setCount] = useState(diagnostics.count);
  const { pending, error, run } = useAction();
  useEffect(() => {
    const timer = window.setInterval(() => setCount(diagnostics.count()), 2000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="settings-row">
      <div>
        <Switch label={msg.settings.diagnostics} checked={enabled} onChange={(checked) => onChange(checked)} />
        <p className="muted">{msg.settings.diagnosticsHint}</p>
        {enabled && <p className="muted">{msg.settings.diagnosticsCount(count)}</p>}
        <ErrorNotice error={error} />
        {saved && <Notice tone="success">{msg.settings.diagnosticsSaved(saved)}</Notice>}
      </div>
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={async () => {
          setSaved(null);
          const name = await run(() => diagnostics.saveReport());
          if (name) setSaved(name);
        }}
      >
        {msg.settings.diagnosticsSave}
      </button>
    </div>
  );
}

/** Quick unlock state for this device, with the switch to turn it on (via a dialog) or off. */
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
    <div className="stack-sm" data-testid="quick-unlock">
      <h3 style={{ fontSize: "var(--text-md)" }}>{msg.quickUnlock.title}</h3>
      <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
        {msg.quickUnlock.body}
      </p>
      {enabled !== null && <p role="status">{enabled ? msg.quickUnlock.on : msg.quickUnlock.off}</p>}
      <div>
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
      </div>
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

function EditorChoices({
  apps,
  onRemove,
  onAdded,
}: {
  apps: { extension: string; app: string }[];
  onRemove: (extension: string) => void;
  onAdded: (prefs: Preferences) => void;
}) {
  const [ext, setExt] = useState("");
  const { pending, error, run } = useAction();
  const valid = /^\.?[A-Za-z0-9]{1,16}$/.test(ext.trim());
  return (
    <div className="stack-sm">
      {apps.length === 0 ? (
        <span className="muted">{msg.settings.editorNone}</span>
      ) : (
        <ul className="editor-choices" aria-label={msg.settings.editors}>
          {apps.map((e) => (
            <li key={e.extension}>
              <span className="mono">.{e.extension}</span>
              <span className="muted" title={e.app}>
                {e.app.split(/[\\/]/).pop()}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={msg.settings.editorRemove(e.extension)} onClick={() => onRemove(e.extension)}>
                <IconTrash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="editor-add">
        <input className="input mono" aria-label={msg.settings.editorExtension} placeholder="conf" value={ext} onChange={(event) => setExt(event.target.value)} />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!valid || pending}
          onClick={async () => {
            const next = await run(() => preferencesApi.pickEditor(ext.trim()));
            if (next) {
              onAdded(next);
              setExt("");
            }
          }}
        >
          {msg.settings.editorAdd}
        </button>
      </div>
      <ErrorNotice error={error} />
    </div>
  );
}
