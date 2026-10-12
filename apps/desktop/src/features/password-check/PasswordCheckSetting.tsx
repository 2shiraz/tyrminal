// Compromised-password check (SEC-11) in Settings → Password check. Off by default; the text says
// exactly what leaves the computer before the user can turn it on. Runs only on request.

import type { PasswordCheckPreferences, PasswordCheckReport, PasswordCheckStatus } from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { usePreferences } from "../../app/preferences";
import { ErrorNotice, Notice, Switch, TextField } from "../../components/ui/controls";
import { passwordCheck, preferences as preferencesApi } from "../../lib/ipc";
import { msgPC } from "../../lib/messages-password-check";
import { useAction } from "../../lib/useAsync";

/** Mirrors the core's check (crates/core/src/password_check.rs) for immediate feedback only. */
function endpointLooksValid(text: string): boolean {
  if (!/^https:\/\/[A-Za-z0-9.\-:[\]]+(\/[^\s?#\\]*)?$/.test(text)) return false;
  return !text.slice(8).split("/")[0]?.includes("@");
}

export function PasswordCheckSetting() {
  const { prefs, update } = usePreferences();
  const settings = prefs.passwordCheck;
  const [status, setStatus] = useState<PasswordCheckStatus | null>(null);
  const [draft, setDraft] = useState(settings.endpoint);
  const [report, setReport] = useState<PasswordCheckReport | null>(null);
  const load = useAction();
  const check = useAction();
  const save = useAction();

  const reload = () =>
    void load.run(() => passwordCheck.status()).then((s) => {
      if (s) setStatus(s);
    });
  useEffect(reload, []);

  /** Saves at once (not with the debounced preference writes), so the core, which enforces the
   * opt-in, has the new value before a check can be started; the run button follows its status. */
  async function persist(next: PasswordCheckPreferences) {
    setReport(null);
    update((p) => ({ ...p, passwordCheck: next }));
    await save.run(() => preferencesApi.set({ ...prefs, passwordCheck: next }));
    reload();
  }

  useEffect(() => setDraft(settings.endpoint), [settings.endpoint]);

  const draftValid = endpointLooksValid(draft);
  const available = status?.available ?? false;
  const found = report?.items.filter((i) => i.breachCount > 0).length ?? 0;

  return (
    <div className="stack-sm" data-testid="password-check">
      <Notice tone="info">{msgPC.whatIsSent}</Notice>
      <Switch
        id="password-check"
        label={msgPC.enable}
        hint={msgPC.enableHint}
        checked={settings.enabled}
        onChange={(enabled) => void persist({ ...settings, enabled })}
      />
      <div className="row-flex" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <TextField
            label={msgPC.endpoint}
            value={draft}
            onChange={setDraft}
            maxLength={512}
            hint={msgPC.endpointHint}
            error={draft !== "" && !draftValid ? msgPC.endpointInvalid : undefined}
          />
        </div>
        <button
          type="button"
          className="btn"
          disabled={!draftValid || draft === settings.endpoint}
          onClick={() => void persist({ ...settings, endpoint: draft })}
        >
          {msgPC.useEndpoint}
        </button>
      </div>
      {status && !available && (
        <Notice tone="warning">
          <strong>{msgPC.unavailable}.</strong> {status.unavailableReason}
        </Notice>
      )}
      {status && <p className="muted" style={{ fontSize: "var(--text-sm)" }}>{msgPC.stored(status.storedPasswords)}</p>}
      <div>
        <button
          type="button"
          className="btn"
          disabled={!status?.enabled || !available || check.pending || save.pending}
          onClick={async () => {
            const result = await check.run(() => passwordCheck.run());
            if (result) setReport(result);
          }}
        >
          {check.pending ? msgPC.checking : msgPC.run}
        </button>
      </div>
      <ErrorNotice error={save.error ?? load.error ?? check.error} />
      {report && (
        <div role="status" className="stack-sm">
          <p>{msgPC.summary(found, report.items.length, report.requests)}</p>
          <ul className="list" aria-label={msgPC.title}>
            {report.items.map((item, index) => (
              <li key={`${item.kind}-${item.label}-${index}`}>
                <div className="row-main">
                  <span className="row-title">{item.label}</span>
                  <span className="row-sub">
                    {msgPC.kind(item.kind)} · {item.breachCount > 0 ? msgPC.found(item.breachCount) : msgPC.notFound}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
