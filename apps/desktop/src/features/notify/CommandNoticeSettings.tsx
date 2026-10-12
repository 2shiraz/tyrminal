import type { CommandNotifications } from "@tyrminal/contracts";

import { SettingRow, Switch } from "../../components/ui/controls";
import { msgN } from "../../lib/messages-notify";

/** Settings for command-finished notifications (P-23). */
export function CommandNoticeSettings({ value, onChange }: { value: CommandNotifications; onChange: (value: CommandNotifications) => void }) {
  return (
    <>
      <Switch id="command-notifications" label={msgN.settingTitle} hint={msgN.settingHint} checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
      {value.enabled && (
        <SettingRow label={msgN.minSeconds} id="command-notifications-min">
          <span className="row-flex">
            <input
              className="input input-sm"
              type="number"
              min={1}
              max={86400}
              style={{ width: "6em" }}
              aria-label={`${msgN.minSeconds} (${msgN.seconds})`}
              value={value.minSeconds}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n) && n >= 1 && n <= 86400) onChange({ ...value, minSeconds: n });
              }}
            />
            {msgN.seconds}
          </span>
        </SettingRow>
      )}
    </>
  );
}
