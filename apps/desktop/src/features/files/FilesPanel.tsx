import type { RemoteEntry, RemoteListing, TransferDirection, TransferEvent, TransferStarted } from "@tyrminal/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, IconButton, Notice, Shortcut, Switch, TextField } from "../../components/ui/controls";
import {
  IconDownload,
  IconEye,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconFolderUp,
  IconHardDrive,
  IconLink2,
  IconPanelRightClose,
  IconPencil,
  IconRefreshCw,
  IconSlidersHorizontal,
  IconTrash2,
  IconUpload,
  IconX,
} from "../../components/ui/icons";
import { AppError, files as filesApi, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";

export interface FilesTarget {
  sessionId: string;
  label: string;
}

interface Transfer {
  id: string;
  name: string;
  direction: TransferDirection;
  total: number | null;
  done: number;
  state: "running" | "done" | "cancelled" | "failed";
  error?: string;
  /** Files copied and links/special files skipped (folders only). */
  files?: number;
  skipped?: number;
  /** Remote folder the transfer touches (refreshed when an upload finishes there). */
  dir: string;
}

type Prompt =
  | { kind: "mkdir" }
  | { kind: "rename"; entry: RemoteEntry }
  | { kind: "chmod"; entry: RemoteEntry }
  | { kind: "delete"; entry: RemoteEntry }
  | { kind: "replace"; name: string; remote: boolean; retry: () => void };

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function modeText(mode: number | null): string {
  if (mode == null) return "";
  return mode.toString(8).padStart(3, "0");
}

/** Shows server-supplied names safely: control characters become visible escapes. */
function visibleName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters.
  return name.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function EntryIcon({ entry }: { entry: RemoteEntry }) {
  if (entry.kind === "dir") return <IconFolder size={15} />;
  if (entry.kind === "symlink") return <IconLink2 size={15} />;
  return <IconFile size={15} />;
}

/**
 * Remote file browser for the focused SSH session. Every action is explicit; transfers never
 * replace an existing file without asking, and show their progress until they end.
 */
export function FilesPanel({ target, onClose }: { target: FilesTarget | null; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [pathText, setPathText] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const { pending, error, run } = useAction();
  const sessionId = target?.sessionId ?? null;
  const listingRef = useRef<RemoteListing | null>(null);
  listingRef.current = listing;

  const load = useCallback(
    async (path: string | null) => {
      if (!sessionId) return;
      const result = await run(() => filesApi.list(sessionId, path));
      if (result) {
        // Refreshing the same folder keeps the selection while the entry is still there.
        const same = listingRef.current?.path === result.path;
        setListing(result);
        setPathText(result.path);
        setSelected((name) => (same && result.entries.some((e) => e.name === name) ? name : null));
      }
    },
    [sessionId, run],
  );

  // A different session starts at its login folder (a new listing also clears any error).
  useEffect(() => {
    setListing(null);
    setSelected(null);
    if (sessionId) void load(null);
  }, [sessionId, load]);

  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input[name="remote-path"]')?.focus();
  }, []);

  const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith("."));
  const current = listing?.path ?? null;
  const selection = entries.find((e) => e.name === selected) ?? null;

  function track(started: TransferStarted, dir: string) {
    setTransfers((list) => [
      ...list,
      { id: started.transferId, name: started.name, direction: started.direction, total: started.total, done: 0, state: "running", dir },
    ]);
  }

  function apply(transferId: string, dir: string, upload: boolean, event: TransferEvent) {
    setTransfers((list) =>
      list.map((t) => {
        if (t.id !== transferId) return t;
        switch (event.type) {
          case "progress":
            return { ...t, done: event.done };
          case "done":
            return { ...t, done: event.bytes, state: "done", files: event.files, skipped: event.skipped };
          case "cancelled":
            return { ...t, state: "cancelled" };
          case "failed":
            return { ...t, state: "failed", error: event.error.message };
        }
      }),
    );
    // An upload changes the folder it went to; a download changes nothing on the server.
    if (event.type === "done" && upload && listingRef.current?.path === dir) void load(dir);
  }

  /**
   * Events can arrive before the call that started the transfer returns its id (a small file
   * may even finish first); they are held until the transfer is listed, then applied in order.
   */
  function listener(dir: string, upload: boolean) {
    let bound: string | null = null;
    const early: TransferEvent[] = [];
    return {
      onEvent: (event: TransferEvent) => {
        if (bound) apply(bound, dir, upload, event);
        else early.push(event);
      },
      bind: (started: TransferStarted) => {
        track(started, dir);
        bound = started.transferId;
        for (const event of early.splice(0)) apply(started.transferId, dir, upload, event);
      },
    };
  }

  async function startUpload(token: string, name: string, dir: string, overwrite: boolean, folder = false) {
    if (!sessionId) return;
    const events = listener(dir, true);
    try {
      events.bind(await filesApi.upload(sessionId, token, dir, overwrite, events.onEvent));
    } catch (caught) {
      const e = toAppError(caught);
      // Folders are never merged into an existing one, so a folder conflict is just reported.
      if (e.code === "CONFLICT" && !overwrite && !folder) {
        setPrompt({ kind: "replace", name, remote: true, retry: () => void startUpload(token, name, dir, true) });
      } else {
        failNow(name, "upload", dir, e);
      }
    }
  }

  async function startDownload(entry: RemoteEntry, dir: string, token: string, overwrite: boolean) {
    if (!sessionId) return;
    const events = listener(dir, false);
    try {
      events.bind(await filesApi.download(sessionId, dir, entry.name, token, overwrite, events.onEvent));
    } catch (caught) {
      const e = toAppError(caught);
      if (e.code === "CONFLICT" && !overwrite && entry.kind !== "dir") {
        setPrompt({ kind: "replace", name: entry.name, remote: false, retry: () => void startDownload(entry, dir, token, true) });
      } else {
        failNow(entry.name, "download", dir, e);
      }
    }
  }

  /** A transfer refused before it started still shows up in the list, with the reason. */
  function failNow(name: string, direction: TransferDirection, dir: string, e: AppError) {
    setTransfers((list) => [
      ...list,
      { id: `refused-${Date.now()}-${list.length}`, name, direction, total: null, done: 0, state: "failed", error: e.message, dir },
    ]);
  }

  async function upload() {
    if (!current) return;
    const picks = await run(() => filesApi.pickUpload());
    for (const pick of picks ?? []) await startUpload(pick.token, pick.name, current, false);
  }

  async function uploadFolder() {
    if (!current) return;
    const pick = await run(() => filesApi.pickUploadFolder());
    if (pick) await startUpload(pick.token, pick.name, current, false, true);
  }

  /** Downloads the folder being shown, with everything in it. */
  async function downloadFolder() {
    if (!listing?.parent) return;
    const name = listing.path.slice(listing.path.lastIndexOf("/") + 1);
    const folder = await run(() => filesApi.pickFolder());
    if (folder) {
      const entry: RemoteEntry = { name, kind: "dir", size: null, permissions: null, modified: null };
      await startDownload(entry, listing.parent, folder.token, false);
    }
  }

  async function download() {
    if (!current || !selection) return;
    const folder = await run(() => filesApi.pickFolder());
    if (folder) await startDownload(selection, current, folder.token, false);
  }

  function activate(entry: RemoteEntry) {
    if (!current) return;
    if (entry.kind === "dir" || entry.kind === "symlink") {
      const next = `${current.replace(/\/+$/, "")}/${entry.name}`;
      void load(next);
    } else {
      setSelected(entry.name);
    }
  }

  return (
    <aside
      ref={ref}
      className="side-panel side-panel-wide"
      aria-label={msg.files.panel}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !(event.target as HTMLElement).closest("dialog")) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="panel-head">
        <h2>{msg.files.panel}</h2>
        <Shortcut action="toggleFiles" />
        <IconButton label={msg.files.close} onClick={onClose}>
          <IconPanelRightClose size={16} />
        </IconButton>
      </div>

      {!target ? (
        <div className="panel-body">
          <Notice tone="info">{msg.files.noSession}</Notice>
        </div>
      ) : (
        <>
          <div className="files-bar">
            <span className="muted files-target" role="status" aria-label="Target">
              <IconHardDrive size={13} /> {msg.files.on(target.label)}
            </span>
            <form
              className="files-path"
              onSubmit={(event) => {
                event.preventDefault();
                const path = pathText.trim();
                if (path) void load(path);
              }}
            >
              <IconButton label={msg.files.up} onClick={() => listing?.parent && void load(listing.parent)} disabled={!listing?.parent || pending}>
                <span aria-hidden="true">↑</span>
              </IconButton>
              <input
                name="remote-path"
                className="input mono"
                aria-label={msg.files.path}
                value={pathText}
                onChange={(event) => setPathText(event.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <IconButton label={msg.files.refresh} onClick={() => current && void load(current)} disabled={!current || pending}>
                <IconRefreshCw size={15} />
              </IconButton>
            </form>
            <div className="files-actions">
              <button type="button" className="btn btn-sm" onClick={() => void upload()} disabled={!current || pending}>
                <IconUpload size={14} /> {msg.files.upload}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void uploadFolder()} disabled={!current || pending}>
                <IconFolderUp size={14} /> {msg.files.uploadFolder}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void downloadFolder()} disabled={!listing?.parent || pending}>
                <IconDownload size={14} /> {msg.files.downloadFolder}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setPrompt({ kind: "mkdir" })} disabled={!current || pending}>
                <IconFolderPlus size={14} /> {msg.files.newFolder}
              </button>
              <span className="spacer" />
              <Switch label={msg.files.showHidden} checked={showHidden} onChange={setShowHidden} />
            </div>
            {selection && (
              <div className="files-actions" aria-label={selection.name}>
                {selection.kind === "file" && (
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void download()} disabled={pending}>
                    <IconDownload size={14} /> {msg.files.download}
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => setPrompt({ kind: "rename", entry: selection })}>
                  <IconPencil size={14} /> {msg.files.rename}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setPrompt({ kind: "chmod", entry: selection })}>
                  <IconSlidersHorizontal size={14} /> {msg.files.permissions}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setPrompt({ kind: "delete", entry: selection })}>
                  <IconTrash2 size={14} /> {msg.files.delete}
                </button>
              </div>
            )}
          </div>

          <div className="panel-body files-body">
            <ErrorNotice error={error} />
            {listing?.truncated && <Notice tone="warning">{msg.files.truncated(listing.entries.length)}</Notice>}
            {listing && entries.length === 0 && <p className="muted">{msg.files.empty}</p>}
            {listing && entries.length > 0 && (
              <ul className="files-list" aria-label={msg.files.listLabel(listing.path)}>
                {entries.map((entry) => (
                  <li key={entry.name} data-selected={entry.name === selected || undefined}>
                    <button
                      type="button"
                      className="files-row"
                      aria-label={entry.kind === "dir" ? msg.files.open(entry.name) : msg.files.select(entry.name)}
                      aria-pressed={entry.kind === "dir" ? undefined : entry.name === selected}
                      onClick={() => (entry.kind === "dir" ? activate(entry) : setSelected(entry.name === selected ? null : entry.name))}
                      onDoubleClick={() => activate(entry)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && entry.kind === "symlink") {
                          event.preventDefault();
                          activate(entry);
                        }
                      }}
                    >
                      <span className={`files-icon files-icon-${entry.kind}`}>
                        <EntryIcon entry={entry} />
                      </span>
                      <span className="files-name">{visibleName(entry.name)}</span>
                      <span className="files-meta mono">{entry.kind === "dir" ? "" : formatSize(entry.size)}</span>
                      <span className="files-meta mono" title={msg.files.permissions}>
                        {modeText(entry.permissions)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {transfers.length > 0 && (
            <section className="files-transfers" aria-label={msg.files.transfers}>
              <div className="files-transfers-head">
                <h3>{msg.files.transfers}</h3>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setTransfers((list) => list.filter((t) => t.state === "running"))}
                  disabled={!transfers.some((t) => t.state !== "running")}
                >
                  {msg.files.clearDone}
                </button>
              </div>
              <ul>
                {transfers.map((t) => (
                  <li key={t.id} className="files-transfer" data-state={t.state}>
                    <span className="files-transfer-icon">{t.direction === "upload" ? <IconUpload size={13} /> : <IconDownload size={13} />}</span>
                    <span className="files-name">{visibleName(t.name)}</span>
                    <span className="files-meta" data-testid="transfer-state">
                      {t.state === "running"
                        ? msg.files.progress(formatSize(t.done), t.total == null ? null : formatSize(t.total))
                        : t.state === "done"
                          ? msg.files.doneSummary(t.files ?? 1, t.skipped ?? 0)
                          : t.state === "cancelled"
                            ? msg.files.cancelled
                            : `${msg.files.failed}: ${t.error ?? ""}`}
                    </span>
                    {t.state === "running" && (
                      <>
                        <progress max={t.total ?? undefined} value={t.total ? t.done : undefined} aria-label={t.name} />
                        <IconButton label={msg.files.cancelTransfer(t.name)} onClick={() => void filesApi.cancel(t.id).catch(() => undefined)}>
                          <IconX size={14} />
                        </IconButton>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {prompt && target && current && (
        <FilesPrompt
          prompt={prompt}
          sessionId={target.sessionId}
          dir={current}
          onDone={(changed) => {
            setPrompt(null);
            if (changed) void load(current);
          }}
        />
      )}
    </aside>
  );
}

function FilesPrompt({
  prompt,
  sessionId,
  dir,
  onDone,
}: {
  prompt: Prompt;
  sessionId: string;
  dir: string;
  onDone: (changed: boolean) => void;
}) {
  const initial =
    prompt.kind === "rename" ? prompt.entry.name : prompt.kind === "chmod" ? modeText(prompt.entry.permissions) : "";
  const [text, setText] = useState(initial);
  const { pending, error, run } = useAction();
  const [invalid, setInvalid] = useState<string | null>(null);

  async function submit() {
    setInvalid(null);
    let ok: unknown;
    switch (prompt.kind) {
      case "mkdir":
        ok = await run(() => filesApi.mkdir(sessionId, dir, text.trim()).then(() => true));
        break;
      case "rename":
        ok = await run(() => filesApi.rename(sessionId, dir, prompt.entry.name, text.trim()).then(() => true));
        break;
      case "chmod": {
        if (!/^[0-7]{3,4}$/.test(text.trim())) {
          setInvalid(msg.files.modeInvalid);
          return;
        }
        const mode = Number.parseInt(text.trim(), 8);
        ok = await run(() => filesApi.chmod(sessionId, dir, prompt.entry.name, mode).then(() => true));
        break;
      }
      case "delete":
        ok = await run(() => filesApi.remove(sessionId, dir, prompt.entry.name).then(() => true));
        break;
      case "replace":
        prompt.retry();
        onDone(false);
        return;
    }
    if (ok) onDone(true);
  }

  if (prompt.kind === "delete" || prompt.kind === "replace") {
    const title = prompt.kind === "delete" ? msg.files.deleteTitle(prompt.entry.name) : msg.files.replaceTitle(prompt.name);
    const body = prompt.kind === "delete" ? msg.files.deleteBody : prompt.remote ? msg.files.replaceRemote : msg.files.replaceLocal;
    return (
      <Dialog title={title} role="alertdialog" tone="danger" icon={<IconTrash2 size={18} />} onDismiss={() => onDone(false)}>
        <div className="stack">
          <p>{body}</p>
          <ErrorNotice error={error} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => onDone(false)} data-autofocus>
              {msg.common.cancel}
            </button>
            <button type="button" className="btn btn-danger-solid" onClick={() => void submit()} disabled={pending}>
              {prompt.kind === "delete" ? msg.files.delete : msg.files.replace}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  const title =
    prompt.kind === "mkdir"
      ? msg.files.newFolderTitle
      : prompt.kind === "rename"
        ? msg.files.renameTitle(prompt.entry.name)
        : msg.files.permissionsTitle(prompt.entry.name);
  return (
    <Dialog title={title} icon={prompt.kind === "chmod" ? <IconEye size={18} /> : <IconFolderPlus size={18} />} onDismiss={() => onDone(false)}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={prompt.kind === "chmod" ? msg.files.mode : msg.files.name}
          hint={prompt.kind === "chmod" ? msg.files.modeHint : msg.files.nameHint}
          value={text}
          onChange={setText}
          error={invalid ?? undefined}
          autoFocus
          className="mono"
        />
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => onDone(false)}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={pending || text.trim() === ""}>
            {prompt.kind === "mkdir" ? msg.files.create : msg.files.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
