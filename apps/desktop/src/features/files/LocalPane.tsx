import type { LocalListing, RemoteEntry } from "@tyrminal/contracts";
import { useCallback, useMemo, useState } from "react";

import { ErrorNotice, IconButton } from "../../components/ui/controls";
import { IconFolderOpen, IconFolderUp, IconHardDrive, IconRefreshCw } from "../../components/ui/icons";
import { files as filesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import { visibleEntries } from "../sftp/model";
import { FileTable } from "./FileTable";
import { PathBar } from "./PathBar";
import { NO_SELECTION, single } from "./selection";

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
  showHidden,
}: {
  /** What the pane shows; the owner keeps it, so it survives the pane being unmounted. */
  listing: LocalListing | null;
  /** A new listing (the selection is cleared with it). */
  onListing: (listing: LocalListing) => void;
  selected: string | null;
  onSelect: (entry: RemoteEntry | null) => void;
  onDropRemote: (name: string) => void;
  showHidden: boolean;
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
  const entries = useMemo(() => (listing ? visibleEntries(listing.entries, showHidden, "", { key: "name", ascending: true }) : []), [listing, showHidden]);
  const selection = selected ? single(selected) : NO_SELECTION;

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
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        setDropping(false);
        const raw = event.dataTransfer.getData(DRAG_TYPE);
        if (!raw) return;
        event.preventDefault();
        const data = JSON.parse(raw) as { side: string; name: string };
        if (data.side === "remote") onDropRemote(data.name);
      }}
    >
      <div className="fp-nav">
        <IconButton size="sm" label={msg.files.localUp} onClick={() => listing && void load(listing.token, listing.path.slice(0, -1))} disabled={!listing || listing.path.length === 0}>
          <IconFolderUp size={15} />
        </IconButton>
        {listing ? (
          <PathBar
            crumbs={[listing.rootName, ...listing.path].map((label, i) => ({ label, onGo: () => void load(listing.token, listing.path.slice(0, i)) }))}
            busy={pending}
          />
        ) : (
          <span className="fp-local-none">{msg.files.localNone}</span>
        )}
        <IconButton size="sm" label={listing ? msg.files.localChange : msg.files.localChoose} onClick={() => void choose()} disabled={pending}>
          <IconFolderOpen size={15} />
        </IconButton>
        {listing && (
          <IconButton size="sm" data-tooltip-side="bottom-end" label={msg.files.localRefresh} onClick={() => void load(listing.token, listing.path)} disabled={pending}>
            <IconRefreshCw size={14} />
          </IconButton>
        )}
      </div>
      <div className="fp-body">
        <ErrorNotice error={error} />
        {listing ? (
          <FileTable
            label={msg.files.localListLabel(where)}
            entries={entries}
            columns={["name", "size"]}
            selection={selection}
            onSelection={(next) => {
              const name = next.cursor && next.names.includes(next.cursor) ? next.cursor : (next.names[0] ?? null);
              onSelect(name ? (entries.find((e) => e.name === name) ?? null) : null);
            }}
            onActivate={(entry) => {
              if (entry.kind === "dir") void load(listing.token, [...listing.path, entry.name]);
              else onSelect(entry);
            }}
            onKey={(key) => {
              if (key === "up" && listing.path.length > 0) void load(listing.token, listing.path.slice(0, -1));
            }}
            canDrag={(entry) => entry.kind === "file" || entry.kind === "dir"}
            onDragStart={(event, entry) => event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ side: "local", name: entry.name }))}
            empty={<p className="ft-state">{msg.files.empty}</p>}
          />
        ) : (
          <div className="ft-state">
            <IconHardDrive size={24} />
            <span>{msg.files.localNone}</span>
            <button type="button" className="btn btn-sm" onClick={() => void choose()} disabled={pending}>
              <IconFolderOpen size={14} /> {msg.files.localChoose}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
