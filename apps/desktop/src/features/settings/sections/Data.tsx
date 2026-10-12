import { useEffect, useState } from "react";

import { usePreferences } from "../../../app/preferences";
import { ErrorNotice, Notice, SettingRow, Switch, relativeTime } from "../../../components/ui/controls";
import { backup, diagnostics, links as linksApi } from "../../../lib/ipc";
import { msg } from "../../../lib/messages";
import { msgB } from "../../../lib/messages-b";
import { useAction } from "../../../lib/useAsync";
import { ExportBackupButton, RestoreBackupDialog } from "../../vault/BackupRestore";
import { msgSettings } from "../messages";
import { SettingsGroup } from "../SettingsGroup";

export function BackupSection() {
  const [restoring, setRestoring] = useState(false);
  // When this vault was last exported; `undefined` until known.
  const [lastExport, setLastExport] = useState<number | null | undefined>(undefined);
  const loadLastExport = () =>
    void backup
      .status()
      .then((s) => setLastExport(s.lastExportAt))
      .catch(() => undefined);
  useEffect(loadLastExport, []);
  return (
    <>
      <SettingsGroup title={msgSettings.backupGroup} hint={msg.backup.body}>
        <SettingRow label={msgSettings.exportRow} hint={msgSettings.exportHint} id="export" variant="action">
          <div className="row-flex" style={{ alignItems: "center", gap: "var(--space-3)" }}>
            {lastExport !== undefined && (
              <span className="muted" data-testid="last-export">
                {lastExport === null ? msg.backup.neverExported : msg.backup.lastExported(relativeTime(lastExport))}
              </span>
            )}
            <ExportBackupButton onExported={loadLastExport} />
          </div>
        </SettingRow>
        <SettingRow label={msgSettings.restoreRow} hint={msgSettings.restoreHint} id="restore" variant="action">
          <button type="button" className="btn" onClick={() => setRestoring(true)}>
            {msg.backup.restore}
          </button>
        </SettingRow>
      </SettingsGroup>
      {/* After a restore the vault locks and the app shows the unlock screen on its own. */}
      {restoring && <RestoreBackupDialog vaultExists onClose={() => setRestoring(false)} onRestored={() => setRestoring(false)} />}
    </>
  );
}

export function PrivacySection() {
  const { prefs, update } = usePreferences();
  return (
    <>
      <SettingsGroup title={msgSettings.diagnostics}>
        <DiagnosticsSetting enabled={prefs.diagnostics} onChange={(diagnostics) => update((p) => ({ ...p, diagnostics }))} />
      </SettingsGroup>
      {/* Quick port forwards (P-24) */}
      <SettingsGroup title={msgSettings.connections}>
        <Switch
          id="port-suggestions"
          label={msgB.quick.setting}
          hint={msgB.quick.settingHint}
          checked={!prefs.noPortSuggestions}
          onChange={(on) => update((p) => ({ ...p, noPortSuggestions: !on }))}
        />
      </SettingsGroup>
      <SettingsGroup title={msgSettings.updates}>
        <SettingRow label={msg.settings.updates} hint={msg.settings.updatesBody(__APP_VERSION__)} id="updates" variant="link">
          <button type="button" className="btn" onClick={() => void linksApi.open(msg.settings.releasesUrl).catch(() => undefined)}>
            {msg.settings.updatesOpen}
          </button>
        </SettingRow>
      </SettingsGroup>
    </>
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
    <>
      <Switch id="diagnostics" label={msg.settings.diagnostics} hint={msg.settings.diagnosticsHint} checked={enabled} onChange={(checked) => onChange(checked)} />
      <SettingRow label={msgSettings.reportRow} hint={enabled ? msg.settings.diagnosticsCount(count) : undefined} variant="action">
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
      </SettingRow>
      <ErrorNotice error={error} />
      {saved && <Notice tone="success">{msg.settings.diagnosticsSaved(saved)}</Notice>}
    </>
  );
}

