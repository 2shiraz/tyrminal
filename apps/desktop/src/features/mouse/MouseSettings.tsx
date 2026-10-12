import type { WorkspacePreferences } from "@tyrminal/contracts";

import { Segmented, SettingRow, Switch } from "../../components/ui/controls";
import { msgI } from "../../lib/messages-input";

type RightClick = "selectWord" | "paste" | "nothing";

/** Mouse mappings (TRM-08): right click and middle click in a terminal. */
export function MouseSettings({ ws, onChange }: { ws: WorkspacePreferences; onChange: (change: Partial<WorkspacePreferences>) => void }) {
  const right: RightClick = ws.rightClickPaste ? "paste" : ws.rightClickSelectsWord ? "selectWord" : "nothing";
  return (
    <>
      <SettingRow label={msgI.mouse.rightClick} hint={msgI.mouse.rightClickHint}>
        <Segmented<RightClick>
          label={msgI.mouse.rightClick}
          value={right}
          onChange={(value) => onChange({ rightClickSelectsWord: value === "selectWord", rightClickPaste: value === "paste" })}
          options={[
            { value: "selectWord", label: msgI.mouse.selectWord },
            { value: "paste", label: msgI.mouse.paste },
            { value: "nothing", label: msgI.mouse.nothing },
          ]}
        />
      </SettingRow>
      <Switch
        label={msgI.mouse.middleClick}
        hint={msgI.mouse.middleClickHint}
        checked={ws.middleClickPaste ?? false}
        onChange={(middleClickPaste) => onChange({ middleClickPaste })}
      />
    </>
  );
}
