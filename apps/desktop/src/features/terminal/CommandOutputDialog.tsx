import { useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/Toasts";
import { IconCopy, IconDownload, IconScrollText } from "../../components/ui/icons";
import { terminalOutput } from "../../lib/ipc";
import { msgOutput } from "../../lib/messages-output";
import type { PaneHandle } from "./TerminalView";

/**
 * Copy or save one command's output (P-29). The list comes from the shell integration's command
 * marks; without them it is never offered. The output excludes the prompt and the command line.
 * Saving always goes through the system save dialog.
 */
export function CommandOutputDialog({ handle, label, onClose }: { handle: PaneHandle; label: string; onClose: () => void }) {
  const notify = useToast();
  const [commands] = useState(() => handle.commands());
  const [busy, setBusy] = useState(false);

  async function copy(id: number) {
    const text = handle.commandOutput(id);
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      notify("success", msgOutput.copied);
    } catch (error) {
      notify("danger", (error as Error).message);
    }
  }

  async function save(id: number) {
    const text = handle.commandOutput(id);
    if (text === null || busy) return;
    setBusy(true);
    try {
      const file = await terminalOutput.save(text);
      if (file) notify("success", msgOutput.saved(file));
    } catch (error) {
      notify("danger", (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={`${msgOutput.outputTitle} · ${label}`} icon={<IconScrollText size={18} />} wide onDismiss={onClose}>
      <div className="stack-sm">
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          {msgOutput.outputIntro}
        </p>
        {commands.length === 0 ? (
          <p className="hint">{msgOutput.outputNone}</p>
        ) : (
          <ul className="list command-list" data-testid="command-list">
            {commands.map((c) => {
              const name = c.command ?? msgOutput.outputUnread;
              const usable = c.finished && c.available;
              return (
                <li key={c.id} data-exit={c.exitStatus ?? undefined}>
                  <div className="row-main">
                    <span className="row-title mono">{name}</span>
                    <span className="row-sub">{!c.finished ? msgOutput.outputRunning : !c.available ? msgOutput.outputGone : msgOutput.outputExit(c.exitStatus)}</span>
                  </div>
                  <div className="row-flex" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-sm" disabled={!usable} aria-label={msgOutput.copyOf(name)} onClick={() => void copy(c.id)}>
                      <IconCopy size={14} />
                      {msgOutput.copy}
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!usable || busy} aria-label={msgOutput.saveOf(name)} onClick={() => void save(c.id)}>
                      <IconDownload size={14} />
                      {msgOutput.save}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
