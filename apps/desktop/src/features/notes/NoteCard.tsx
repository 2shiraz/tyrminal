// The note of one host or group (P-30), shown and edited in place. It is its own vault record, so
// it is saved on its own ("Save note"), apart from the host or group form around it.
import type { HostNote, Note, NoteFormat, SettingsTarget } from "@tyrminal/contracts";
import { useEffect, useId, useState } from "react";

import { ErrorNotice, Segmented, TextArea } from "../../components/ui/controls";
import { IconPencil, IconPlus } from "../../components/ui/icons";
import { notes as notesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import { NoteView } from "./NoteView";

/** Bytes, as the vault counts them (64 KiB). */
const MAX_NOTE_BYTES = 64 * 1024;

export function NoteCard({
  target,
  onDirty,
}: {
  /** A host also shows its groups' notes, read-only, under its own. */
  target: SettingsTarget;
  /** Whether there are unsaved note edits (for the owner's unsaved-changes guard). */
  onDirty?: (dirty: boolean) => void;
}) {
  const titleId = useId();
  const [note, setNote] = useState<Note | null | undefined>(undefined);
  const [inherited, setInherited] = useState<HostNote[]>([]);
  const [draft, setDraft] = useState<{ text: string; format: NoteFormat } | null>(null);
  const { pending, error, run, clearError } = useAction();
  const key = target.kind === "host" ? target.hostId : target.groupId;

  useEffect(() => {
    let alive = true;
    setNote(undefined);
    setDraft(null);
    onDirty?.(false);
    setInherited([]);
    notesApi.get(target).then(
      (value) => alive && setNote(value),
      () => alive && setNote(null),
    );
    if (target.kind === "host") {
      notesApi.forHost(target.hostId).then(
        (list) => alive && setInherited(list.filter((n) => n.origin.kind === "group")),
        () => undefined,
      );
    }
    return () => {
      alive = false;
    };
    // The target is identified by its id.
  }, [target.kind, key]);

  const isDirty = (d: typeof draft) => d !== null && (d.text !== (note?.text ?? "") || d.format !== (note?.format ?? "markdown"));
  const dirty = isDirty(draft);
  // Reported from the edit itself, not after render, so an Escape right after typing still finds
  // the change and the panel asks before discarding it.
  const edit = (next: typeof draft) => {
    setDraft(next);
    onDirty?.(isDirty(next));
  };
  const tooLong = draft !== null && new TextEncoder().encode(draft.text).length > MAX_NOTE_BYTES;

  async function save(text: string, format: NoteFormat) {
    const saved = await run(() => notesApi.set(target, text.trim() ? { text, format } : null));
    if (saved !== undefined) {
      setNote(saved);
      setDraft(null);
      onDirty?.(false);
    }
  }

  return (
    <section className="host-section note-card" role="group" aria-labelledby={titleId}>
      <div className="note-card-head">
        <h3 id={titleId} className="host-section-title">
          {msg.notes.title}
        </h3>
        {draft === null && note !== undefined && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => edit({ text: note?.text ?? "", format: note?.format ?? "markdown" })}>
            {note ? <IconPencil size={14} /> : <IconPlus size={14} />}
            {note ? msg.notes.edit : msg.notes.add}
          </button>
        )}
      </div>

      {draft === null ? (
        note ? (
          <NoteView text={note.text} format={note.format} />
        ) : (
          note === null && inherited.length === 0 && <p className="hint">{msg.notes.empty}</p>
        )
      ) : (
        <div className="stack-sm">
          <Segmented
            label={msg.notes.format}
            value={draft.format}
            onChange={(format) => edit({ ...draft, format })}
            options={[
              { value: "markdown", label: msg.notes.markdown },
              { value: "plain", label: msg.notes.plain },
            ]}
          />
          <TextArea
            label={msg.notes.label}
            value={draft.text}
            onChange={(text) => {
              clearError();
              edit({ ...draft, text });
            }}
            hint={msg.notes.hint}
            rows={8}
            autoFocus
          />
          {tooLong && <p className="field-error">{msg.notes.tooLong}</p>}
          <ErrorNotice error={error} />
          <div className="row-flex" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
            {note && (
              <button type="button" className="btn btn-sm btn-danger" disabled={pending} onClick={() => void save("", draft.format)}>
                {msg.notes.remove}
              </button>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                clearError();
                edit(null);
              }}
            >
              {msg.common.cancel}
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || tooLong || pending} onClick={() => void save(draft.text, draft.format)}>
              {pending ? msg.common.working : msg.notes.save}
            </button>
          </div>
        </div>
      )}

      {inherited.map((entry) =>
        entry.origin.kind === "group" ? (
          <div key={entry.origin.groupId} className="note-inherited">
            <span className="hint">{msg.notes.fromGroup(entry.origin.name)}</span>
            <NoteView text={entry.note.text} format={entry.note.format} />
          </div>
        ) : null,
      )}
    </section>
  );
}
