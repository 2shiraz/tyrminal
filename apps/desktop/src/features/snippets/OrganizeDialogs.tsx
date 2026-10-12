import type { SnippetSummary } from "@tyrminal/contracts";
import { type FormEvent, useId, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, TextField } from "../../components/ui/controls";
import { IconCopy, IconFolder } from "../../components/ui/icons";
import { snippetsD } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { useAction } from "../../lib/useAsync";

/** Moves or copies one snippet into a folder (existing or new). */
export function MoveSnippetDialog({
  snippet,
  copy,
  folders,
  onClose,
  onDone,
}: {
  snippet: SnippetSummary;
  copy: boolean;
  folders: string[];
  onClose: () => void;
  onDone: (folder: string) => void;
}) {
  const [folder, setFolder] = useState(snippet.folder);
  const list = useId();
  const { pending, error, run } = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const done = await run(() => snippetsD.move([snippet.id], folder, copy));
    if (done) onDone(done[0]?.folder ?? folder.trim());
  }
  return (
    <Dialog title={copy ? msgD.organize.copyTitle(snippet.name) : msgD.organize.moveTitle(snippet.name)} icon={copy ? <IconCopy size={18} /> : <IconFolder size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span className="label">{msgD.organize.folder}</span>
          <input className="input" list={list} value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={256} data-autofocus />
          <datalist id={list}>
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <span className="hint">{msgD.organize.folderHint}</span>
        </label>
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {copy ? msgD.organize.copyTo.replace("…", "") : msgD.organize.moveTo.replace("…", "")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Renames a folder; its subfolders move along. */
export function RenameFolderDialog({ folder, onClose, onDone }: { folder: string; onClose: () => void; onDone: (count: number) => void }) {
  const [name, setName] = useState(folder);
  const { pending, error, run } = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const count = await run(() => snippetsD.renameFolder(folder, name));
    if (count !== undefined && count !== null) onDone(count);
  }
  return (
    <Dialog title={msgD.organize.renameTitle(folder)} icon={<IconFolder size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <TextField label={msgD.organize.folder} value={name} onChange={setName} hint={msgD.organize.renameHint} autoFocus maxLength={256} />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={pending || name.trim() === "" || name.trim() === folder}>
            {msg.common.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
