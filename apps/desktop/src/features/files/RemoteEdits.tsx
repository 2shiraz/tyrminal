import type { EditStatus, RemoteEntry } from "@tyrminal/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, IconButton } from "../../components/ui/controls";
import { IconPencil, IconTriangleAlert, IconUpload, IconX } from "../../components/ui/icons";
import { files as filesApi, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import { visibleName } from "../sftp/model";

/** A remote file open in an editor on this computer; `saved` once its changes went back up. */
export type Edit = EditStatus & { saved?: boolean | undefined };

/**
 * The files open in editors: send a changed one back to the server, or stop editing it. While a
 * save is on its way the row says so and its button is off, so a second press cannot upload the
 * file again.
 */
export function EditsSection({ edits, onSave, onClose }: { edits: Edit[]; onSave: (edit: Edit) => Promise<void> | void; onClose: (edit: Edit) => void }) {
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const busy = useRef(new Set<string>());
  const save = (edit: Edit) => {
    // The ref answers a second press in the same frame, before the disabled state has rendered.
    if (busy.current.has(edit.editId)) return;
    busy.current.add(edit.editId);
    setSaving(new Set(busy.current));
    void Promise.resolve(onSave(edit))
      .catch(() => undefined)
      .finally(() => {
        busy.current.delete(edit.editId);
        setSaving(new Set(busy.current));
      });
  };
  if (edits.length === 0) return null;
  return (
    <section className="xfer fp-edits" aria-label={msg.files.editing} data-open>
      <div className="xfer-head">
        <span className="xfer-toggle">
          <span className="xfer-title">{msg.files.editing}</span>
        </span>
      </div>
      <ul className="xfer-list">
        {edits.map((e) => (
          <li key={e.editId} className="xfer-row" data-state={saving.has(e.editId) ? "saving" : e.changed ? "changed" : "clean"} aria-busy={saving.has(e.editId) || undefined}>
            <span className="xfer-icon" aria-hidden="true">
              <IconPencil size={14} />
            </span>
            <span className="xfer-name">{visibleName(e.name)}</span>
            <span className="xfer-end">
              <button type="button" className="btn btn-sm btn-primary" disabled={!e.changed || saving.has(e.editId)} onClick={() => save(e)} aria-label={msg.files.editSave(e.name)}>
                <IconUpload size={13} />
              </button>
              <IconButton size="sm" label={msg.files.editClose(e.name)} onClick={() => onClose(e)}>
                <IconX size={13} />
              </IconButton>
            </span>
            <span className="xfer-detail" data-testid="edit-state">
              {saving.has(e.editId) ? msg.files.editSaving : e.changed ? msg.files.editChanged : e.saved ? msg.files.editSaved : msg.files.editUnchanged}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The file changed on the server while it was open here: nothing is replaced without a yes. */
export function EditConflictDialog({ edit, onOverwrite, onDismiss }: { edit: EditStatus; onOverwrite: () => void; onDismiss: () => void }) {
  return (
    <Dialog title={msg.files.editConflictTitle(edit.name)} role="alertdialog" tone="danger" icon={<IconTriangleAlert size={18} />} onDismiss={onDismiss}>
      <div className="stack">
        <p>{msg.files.editConflictBody}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onDismiss} data-autofocus>
            {msg.common.cancel}
          </button>
          <button
            type="button"
            className="btn btn-danger-solid"
            onClick={() => {
              onOverwrite();
              onDismiss();
            }}
          >
            {msg.files.editOverwrite}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Open-in-editor for a pane that keeps no memory of its own (a location of the SFTP tab). The
 * local copies are watched while the pane is mounted; nothing uploads by itself, and the edits end
 * with the connection they were opened on.
 */
export function useRemoteEdits(sessionId: string | null, onSaved: () => void): { open: (entry: RemoteEntry, dir: string) => void; section: ReactNode; dialog: ReactNode } {
  const [edits, setEdits] = useState<Edit[]>([]);
  const [conflict, setConflict] = useState<EditStatus | null>(null);
  const { error, run } = useAction();
  const open = useRef<string[]>([]);
  open.current = edits.map((e) => e.editId);

  // A new connection, or none: the previous connection's edits are closed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the session changes or the pane goes away.
  useEffect(() => {
    return () => {
      for (const id of open.current) void filesApi.editClose(id).catch(() => undefined);
      setEdits([]);
    };
  }, [sessionId]);

  const editIds = edits.map((e) => e.editId).join(",");
  useEffect(() => {
    if (!editIds) return;
    const timer = window.setInterval(() => {
      for (const id of editIds.split(",")) {
        filesApi
          .editStatus(id)
          .then((status) => setEdits((list) => list.map((e) => (e.editId === id ? { ...status, saved: status.changed ? false : e.saved } : e))))
          .catch(() => setEdits((list) => list.filter((e) => e.editId !== id)));
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [editIds]);

  async function save(edit: EditStatus, overwrite: boolean) {
    try {
      const status = await filesApi.editSave(edit.editId, overwrite);
      setEdits((list) => list.map((e) => (e.editId === edit.editId ? { ...status, saved: true } : e)));
      onSaved();
    } catch (caught) {
      const e = toAppError(caught);
      if (e.code === "CONFLICT" && !overwrite) setConflict(edit);
      else void run(() => Promise.reject(e));
    }
  }

  async function close(edit: Edit) {
    if (edit.changed && !window.confirm(msg.files.editCloseUnsaved)) return;
    await filesApi.editClose(edit.editId).catch(() => undefined);
    setEdits((list) => list.filter((e) => e.editId !== edit.editId));
  }

  return {
    open: (entry, dir) => {
      if (!sessionId) return;
      void run(() => filesApi.editOpen(sessionId, dir, entry.name)).then((opened) => {
        if (opened) setEdits((list) => [...list, opened]);
      });
    },
    section: (
      <>
        <ErrorNotice error={error} />
        <EditsSection edits={edits} onSave={(e) => save(e, false)} onClose={(e) => void close(e)} />
      </>
    ),
    dialog: conflict ? <EditConflictDialog edit={conflict} onOverwrite={() => void save(conflict, true)} onDismiss={() => setConflict(null)} /> : null,
  };
}
