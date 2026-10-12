// The connection side panel's notes (P-30): the focused session's host note and its groups'.
// A code block can be pasted into that session, always through the paste review.
import type { HostNote } from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { EmptyState, ErrorNotice, IconButton, SkeletonRows } from "../../components/ui/controls";
import { IconFile, IconPanelRightClose } from "../../components/ui/icons";
import { type AppError, notes as notesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { NoteView } from "./NoteView";
import { useExit } from "../../lib/exitGhost";

export function NotesPanel({
  host,
  onPaste,
  onClose,
}: {
  /** The saved host of the focused session, or null for a local terminal. */
  host: { id: string; label: string } | null;
  /** Present while the focused session is connected. */
  onPaste: ((text: string) => void) | undefined;
  onClose: () => void;
}) {
  const [list, setList] = useState<HostNote[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const hostId = host?.id ?? null;
  useEffect(() => {
    let alive = true;
    setList(null);
    setError(null);
    if (!hostId) return;
    notesApi.forHost(hostId).then(
      (value) => alive && setList(value),
      (e: AppError) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [hostId]);

  // Closing, the panel fades and drifts back toward its edge (lib/exitGhost).
  const exitRef = useExit<HTMLElement>({ transform: "translateX(4px)" });
  return (
    <aside
      ref={exitRef}
      className="side-panel"
      aria-label={msg.notes.hostTitle}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !(event.target as HTMLElement).closest("dialog")) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="panel-head">
        <h2>{msg.notes.hostTitle}</h2>
        <IconButton label={msg.notes.panelClose} onClick={onClose}>
          <IconPanelRightClose size={16} />
        </IconButton>
      </div>
      <div className="panel-body stack">
        {!host && <EmptyState icon={<IconFile size={24} />} title={msg.notes.hostTitle} body={msg.notes.panelNoHost} />}
        {host && <ErrorNotice error={error} />}
        {host && list === null && !error && <SkeletonRows count={2} />}
        {host && list?.length === 0 && <EmptyState icon={<IconFile size={24} />} title={host.label} body={msg.notes.panelEmpty} />}
        {list?.map((entry) => (
          <section key={entry.origin.kind === "group" ? entry.origin.groupId : "host"} className="note-card">
            <h3 className="host-section-title">{entry.origin.kind === "group" ? msg.notes.fromGroup(entry.origin.name) : host?.label}</h3>
            <NoteView text={entry.note.text} format={entry.note.format} onPaste={onPaste} />
          </section>
        ))}
      </div>
    </aside>
  );
}
