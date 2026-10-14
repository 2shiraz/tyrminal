import type { UpdateProgress, UpdateStatus } from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { usePreferences } from "../../app/preferences";
import { ErrorNotice, SettingRow, Switch } from "../../components/ui/controls";
import { links as linksApi, updates } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { setUpdateOffer, useUpdateOffer } from "../../lib/updateOffer";
import { useAction } from "../../lib/useAsync";
import { msgSettings } from "./messages";

/**
 * Updates (UX-05, ADR 0013): the version, Check now, the release found and Install, and the
 * opt-in daily check. A build without the updater offers the releases page instead.
 */
export function UpdatesSetting() {
  const { prefs, update } = usePreferences();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const offer = useUpdateOffer();
  const check = useAction();
  const install = useAction();

  useEffect(() => {
    void updates
      .status()
      .then(setStatus)
      .catch(() => setStatus({ availableInBuild: false, currentVersion: __APP_VERSION__ }));
  }, []);
  useEffect(() => updates.onProgress(setProgress), []);

  if (status && !status.availableInBuild) {
    return (
      <SettingRow label={msgSettings.updates} hint={msgSettings.updatesNotInBuild} id="updates" variant="link">
        <button type="button" className="btn" onClick={() => void linksApi.open(msg.settings.releasesUrl).catch(() => undefined)}>
          {msg.settings.updatesOpen}
        </button>
      </SettingRow>
    );
  }
  if (!status) return null;

  const checkNow = async () => {
    const found = await check.run(() => updates.check());
    if (found !== undefined) {
      setUpdateOffer(found);
      setChecked(true);
    }
  };
  const result = offer ? msgSettings.updatesFound(offer.version) : checked ? msgSettings.updatesLatest : null;

  return (
    <>
      <SettingRow label={msgSettings.updatesVersion} hint={result ?? undefined} id="updates" variant="action">
        <div className="row-flex" style={{ alignItems: "center", gap: "var(--space-3)" }}>
          <span className="muted mono">{status.currentVersion}</span>
          <button type="button" className="btn" disabled={check.pending || install.pending} onClick={() => void checkNow()}>
            {check.pending ? msgSettings.updatesChecking : msgSettings.updatesCheck}
          </button>
        </div>
      </SettingRow>
      {offer && (
        <div className="settings-block update-offer" data-testid="update-offer">
          {offer.notes && (
            <details>
              <summary>{msgSettings.updatesNotes}</summary>
              {/* Plain text from the release feed, shortened natively; never rendered as markup. */}
              <p className="update-notes">{offer.notes}</p>
            </details>
          )}
          <p className="hint">{install.pending ? (progress ? msgSettings.updatesProgress(progress.downloaded, progress.total) : msgSettings.updatesInstalling) : msgSettings.updatesInstallHint}</p>
          <div>
            <button type="button" className="btn btn-primary" disabled={install.pending} onClick={() => void install.run(() => updates.install())}>
              {install.pending ? msgSettings.updatesInstalling : msgSettings.updatesInstall(offer.version)}
            </button>
          </div>
        </div>
      )}
      {(check.error || install.error) && (
        <div className="settings-block">
          <ErrorNotice error={install.error ?? check.error} />
        </div>
      )}
      <Switch
        id="check-updates"
        label={msgSettings.updatesAuto}
        hint={msgSettings.updatesAutoHint}
        checked={prefs.checkUpdates === true}
        onChange={(checkUpdates) => update((p) => ({ ...p, checkUpdates }))}
      />
    </>
  );
}
