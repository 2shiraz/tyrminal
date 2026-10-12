import type { HistoryEntry } from "@tyrminal/contracts";
import { useMemo, useState } from "react";

import { useToast } from "../../components/ui/Toasts";
import { ErrorNotice, IconButton, Switch } from "../../components/ui/controls";
import { IconChevronLeft, IconSearch, IconTrash2 } from "../../components/ui/icons";
import { history } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgH } from "../../lib/messages-history";
import { useLoaded } from "../../lib/useAsync";
import { historySettingChanged } from "./historyCapture";

/** The history switch, every remembered command with a delete button, and "clear all". */
export function HistoryManager({ onBack }: { onBack: () => void }) {
  const notify = useToast();
  const settings = useLoaded(history.settings);
  const entries = useLoaded(history.list);
  const [filter, setFilter] = useState("");
  const [confirming, setConfirming] = useState(false);
  const fail = (error: unknown) => notify("danger", (error as Error).message);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = entries.value ?? [];
    return q ? all.filter((e) => e.command.toLowerCase().includes(q)) : all;
  }, [entries.value, filter]);

  async function toggle(enabled: boolean) {
    try {
      await history.setSettings({ enabled });
      historySettingChanged();
      void settings.reload();
    } catch (error) {
      fail(error);
    }
  }

  async function forget(entry: HistoryEntry) {
    try {
      await history.remove(entry.hostId, entry.command);
      void entries.reload();
    } catch (error) {
      fail(error);
    }
  }

  async function clearAll() {
    setConfirming(false);
    try {
      notify("success", msgH.cleared(await history.clear()));
      void entries.reload();
    } catch (error) {
      fail(error);
    }
  }

  const where = (e: HistoryEntry) => (e.hostId === null ? msgH.local : (e.hostLabel ?? msgH.deletedHost));

  return (
    <div className="stack" data-testid="history-manager">
      <div>
        <button type="button" className="btn btn-sm" onClick={onBack}>
          <IconChevronLeft size={15} />
          {msgH.back}
        </button>
      </div>
      <ErrorNotice error={settings.error ?? entries.error} />
      {settings.value && (
        <Switch label={msgH.enabled} hint={msgH.enabledHint} checked={settings.value.enabled} onChange={(on) => void toggle(on)} />
      )}
      {settings.value && !settings.value.enabled && <p className="hint">{msgH.offNote}</p>}
      <div className="input-with-icon">
        <IconSearch size={15} />
        <input className="input" aria-label={msgH.filter} placeholder={msgH.filter} value={filter} spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {entries.value && entries.value.length === 0 && <p className="muted">{msgH.empty}</p>}
      {entries.value && entries.value.length > 0 && shown.length === 0 && <p className="muted">{msgH.noneMatch}</p>}
      {shown.length > 0 && (
        <ul className="list history-list" aria-label={msgH.title}>
          {shown.map((e) => (
            <li key={`${e.hostId ?? ""}\u0000${e.command}`}>
              <div className="row-main">
                {/* Shown as text only; never run from here. */}
                <span className="row-title mono selectable truncate">{e.command}</span>
                <span className="row-sub">
                  {where(e)} · {new Date(e.lastUsed * 1000).toLocaleString()} · {msgH.uses(e.uses)}
                </span>
              </div>
              <IconButton size="sm" label={msgH.remove(e.command)} onClick={() => void forget(e)}>
                <IconTrash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        {confirming ? (
          <div className="notice notice-danger" role="alertdialog" aria-label={msgH.clearTitle}>
            <div className="stack-xs">
              <strong>{msgH.clearTitle}</strong>
              <span>{msgH.clearBody}</span>
              <div className="row-actions">
                <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)} autoFocus>
                  {msg.common.cancel}
                </button>
                <button type="button" className="btn btn-sm btn-danger-solid" onClick={() => void clearAll()}>
                  {msg.common.delete}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-sm btn-danger" disabled={!entries.value?.length} onClick={() => setConfirming(true)}>
            {msgH.clear}
          </button>
        )}
      </div>
    </div>
  );
}
