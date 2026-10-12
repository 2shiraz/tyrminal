import type { LocalListing, RemoteEntry } from "@tyrminal/contracts";
import { useCallback, useState } from "react";

import { ErrorNotice, IconButton } from "../../components/ui/controls";
import { IconFile, IconFolder, IconFolderOpen, IconLink2, IconRefreshCw } from "../../components/ui/icons";
import { files as filesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";

/** Where the local pane is: a folder the user chose (by token) and names below it. */
export interface LocalLocation {
  token: string;
  path: string[];
}

/** Drag payload between the two panes. */
export const DRAG_TYPE = "application/x-tyrminal-file";

/**
 * The local side of the two-pane view. It browses only inside a folder the user chose in the
 * native dialog; the native side refuses names that would leave it and never follows links.
 */
export function LocalPane({
  listing,
  onListing,
  selected,
  onSelect,
  onDropRemote,
}: {
  /** What the pane shows; the owner keeps it, so it survives the pane being unmounted. */
  listing: LocalListing | null;
  /** A new listing (the selection is cleared with it). */
  onListing: (listing: LocalListing) => void;
  selected: string | null;
  onSelect: (entry: RemoteEntry | null) => void;
  onDropRemote: (name: string) => void;
}) {
  const [dropping, setDropping] = useState(false);
  const { pending, error, run } = useAction();

  const load = useCallback(
    async (token: string, path: string[]) => {
      const result = await run(() => filesApi.localList(token, path));
      if (result) onListing(result);
    },
    [run, onListing],
  );

  async function choose() {
    const pick = await run(() => filesApi.pickFolder());
    if (pick) await load(pick.token, []);
  }

  const where = listing ? [listing.rootName, ...listing.path].join(" / ") : "";

  return (
    <section
      className="files-local"
      aria-label={msg.files.local}
      data-drop={dropping || undefined}
      onDragOver={(event) => {
        if (listing && event.dataTransfer.types.includes(DRAG_TYPE)) {
          event.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        setDropping(false);
        const raw = event.dataTransfer.getData(DRAG_TYPE);
        if (!raw) return;
        event.preventDefault();
        const data = JSON.parse(raw) as { side: string; name: string };
        if (data.side === "remote") onDropRemote(data.name);
      }}
    >
      <div className="files-local-head">
        <span className="files-local-where" title={where}>
          {listing ? where : msg.files.localNone}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => void choose()} disabled={pending}>
          <IconFolderOpen size={14} /> {listing ? msg.files.localChange : msg.files.localChoose}
        </button>
        {listing && (
          <>
            <IconButton label={msg.files.localUp} onClick={() => void load(listing.token, listing.path.slice(0, -1))} disabled={listing.path.length === 0}>
              <span aria-hidden="true">↑</span>
            </IconButton>
            <IconButton label={msg.files.localRefresh} onClick={() => void load(listing.token, listing.path)}>
              <IconRefreshCw size={15} />
            </IconButton>
          </>
        )}
      </div>
      <ErrorNotice error={error} />
      {listing && (
        <ul className="files-list" aria-label={msg.files.localListLabel(where)}>
          {listing.entries.map((entry) => (
            <li key={entry.name} data-selected={entry.name === selected || undefined}>
              <button
                type="button"
                className="files-row"
                draggable={entry.kind === "file" || entry.kind === "dir"}
                onDragStart={(event) => event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ side: "local", name: entry.name }))}
                aria-label={entry.kind === "dir" ? msg.files.open(entry.name) : msg.files.select(entry.name)}
                aria-pressed={entry.name === selected}
                onClick={() => onSelect(entry.name === selected ? null : entry)}
                onDoubleClick={() => entry.kind === "dir" && void load(listing.token, [...listing.path, entry.name])}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && entry.kind === "dir") {
                    event.preventDefault();
                    void load(listing.token, [...listing.path, entry.name]);
                  }
                }}
              >
                <span className={`files-icon files-icon-${entry.kind}`}>
                  {entry.kind === "dir" ? <IconFolder size={15} /> : entry.kind === "symlink" ? <IconLink2 size={15} /> : <IconFile size={15} />}
                </span>
                <span className="files-name">{entry.name}</span>
                <span className="files-meta mono">{entry.size == null ? "" : formatBytes(entry.size)}</span>
                <span className="files-meta mono" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
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
