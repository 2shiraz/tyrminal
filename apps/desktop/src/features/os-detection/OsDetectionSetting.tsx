// OS auto-detection on/off (Settings → Privacy → Connections). Stored in the vault next to what
// was detected, so turning it off also forgets every detected OS.

import { useEffect, useState } from "react";

import { Switch } from "../../components/ui/controls";
import { osDetection } from "../../lib/ipc";
import { msgOs } from "../../lib/messages-os-detection";

export function OsDetectionSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    osDetection.enabled().then(
      (on) => live && setEnabled(on),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  if (enabled === null) return null;
  return (
    <Switch
      id="os-detection"
      label={msgOs.setting}
      hint={msgOs.hint}
      checked={enabled}
      onChange={(on) => {
        setEnabled(on);
        osDetection.setEnabled(on).then(setEnabled, () => setEnabled(!on));
      }}
    />
  );
}
