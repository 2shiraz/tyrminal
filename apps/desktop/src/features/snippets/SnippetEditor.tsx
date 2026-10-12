import type { SnippetSummary } from "@tyrminal/contracts";
import { type FormEvent, useId, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, TextArea, TextField } from "../../components/ui/controls";
import { IconScrollText } from "../../components/ui/icons";
import { snippets as snippetsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";

export function SnippetEditor({
  snippet,
  initial,
  folders,
  onClose,
  onSaved,
}: {
  snippet: SnippetSummary | null;
  initial?: Partial<SnippetSummary> | undefined;
  folders: string[];
  onClose: () => void;
  onSaved: (saved: SnippetSummary) => void;
}) {
  const source = snippet ?? initial;
  const [name, setName] = useState(source?.name ?? "");
  const [folder, setFolder] = useState(source?.folder ?? "");
  const [text, setText] = useState(source?.text ?? "");
  const { pending, error, run } = useAction();
  const listId = useId();
  const ready = name.trim() !== "" && text.trim() !== "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || pending) return;
    const saved = await run(() => snippetsApi.save({ id: snippet?.id ?? null, name, folder, text }));
    if (saved) onSaved(saved);
  }

  return (
    <Dialog title={snippet ? msg.snippets.editorEdit : msg.snippets.editorNew} icon={<IconScrollText size={18} />} wide onDismiss={onClose}>
      <form className="stack" onSubmit={submit} aria-busy={pending}>
        <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
          <TextField label={msg.snippets.name} value={name} onChange={setName} autoFocus maxLength={256} />
          <TextField label={msg.snippets.folder} value={folder} onChange={setFolder} hint={msg.snippets.folderHint} maxLength={256} list={listId} />
          <datalist id={listId}>
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
        <TextArea label={msg.snippets.text} value={text} onChange={setText} hint={msg.snippets.textHint} rows={8} maxLength={64 * 1024} />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready || pending}>
            {pending ? msg.common.working : msg.common.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
