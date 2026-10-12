import type { SnippetSummary } from "@tyrminal/contracts";
import { useMemo, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Dialog } from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useToast } from "../../components/ui/Toasts";
import { EmptyState, IconButton, SkeletonRows } from "../../components/ui/controls";
import {
  IconChevronRight,
  IconClipboardPaste,
  IconCopy,
  IconEllipsis,
  IconFolder,
  IconPencil,
  IconPlay,
  IconPlus,
  IconScrollText,
  IconSearch,
  IconTrash2,
} from "../../components/ui/icons";
import { snippets as snippetsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useFlip } from "../../lib/motion";
import { msgD } from "../../lib/messages-d";
import { msgRuns } from "../../lib/messages-runs";
import { MultiRunDialog } from "./MultiRunDialog";
import { MoveSnippetDialog, RenameFolderDialog } from "./OrganizeDialogs";
import { SnippetEditor } from "./SnippetEditor";

export interface SnippetTarget {
  label: string;
  identity: string;
}

/** Groups snippets by folder path, top level first, then folders alphabetically. */
export function groupByFolder(list: SnippetSummary[]): [string, SnippetSummary[]][] {
  const groups = new Map<string, SnippetSummary[]>();
  for (const snippet of list) {
    const bucket = groups.get(snippet.folder) ?? [];
    bucket.push(snippet);
    groups.set(snippet.folder, bucket);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}

/** The first non-empty line of a snippet, for its one-line preview. */
function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

function lines(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

/**
 * The snippet library: search, folders, create/edit/duplicate/delete and, when a target exists,
 * Paste and Run. Used by the side panel (compact) and the Snippets page.
 */
export function SnippetLibrary({
  target,
  onSend,
  compact,
}: {
  /** The terminal the user is looking at, or null when there is none (actions disabled). */
  target: SnippetTarget | null;
  onSend?: (snippet: SnippetSummary, mode: "paste" | "run") => void;
  compact: boolean;
}) {
  const { snippets } = useVaultData();
  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef);
  const notify = useToast();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ snippet: SnippetSummary | null; initial?: Partial<SnippetSummary> } | null>(null);
  const [deleting, setDeleting] = useState<SnippetSummary | null>(null);
  const [menu, setMenu] = useState<{ snippet: SnippetSummary; anchor: HTMLElement } | null>(null);
  const [runMany, setRunMany] = useState<{ snippet: SnippetSummary; allOpen: boolean } | null>(null);
  const [moving, setMoving] = useState<{ snippet: SnippetSummary; copy: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const all = snippets.value ?? [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((s) => `${s.name} ${s.folder} ${s.text}`.toLowerCase().includes(needle));
  }, [all, query]);
  const groups = groupByFolder(filtered);
  const folders = useMemo(() => [...new Set(all.map((s) => s.folder).filter(Boolean))].sort(), [all]);
  const canSend = target !== null && onSend !== undefined;

  async function remove(snippet: SnippetSummary) {
    try {
      await snippetsApi.remove(snippet.id);
      void snippets.reload();
    } catch (error) {
      notify("danger", (error as Error).message);
    }
  }

  return (
    <div className="stack-sm">
      <div className="row-flex">
        <div className="input-with-icon" style={{ flex: 1 }}>
          <IconSearch size={15} />
          <input
            className="input"
            type="search"
            placeholder={msg.snippets.search}
            aria-label={msg.snippets.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {compact ? (
          <IconButton label={msg.snippets.add} onClick={() => setEditing({ snippet: null })}>
            <IconPlus size={16} />
          </IconButton>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ snippet: null })}>
            <IconPlus size={16} />
            {msg.snippets.add}
          </button>
        )}
      </div>

      {snippets.value === null && !snippets.error && <SkeletonRows count={3} height={64} />}

      {snippets.value && all.length === 0 && (
        <EmptyState icon={<IconScrollText size={26} />} title={msg.snippets.emptyTitle} body={msg.snippets.emptyBody} headingLevel={3}>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ snippet: null })}>
            <IconPlus size={16} />
            {msg.snippets.add}
          </button>
        </EmptyState>
      )}

      {all.length > 0 && filtered.length === 0 && (
        <p className="muted" style={{ fontSize: "var(--text-sm)", padding: "var(--space-3)" }}>
          {msg.snippets.noMatch}
        </p>
      )}

      <div className="snippet-list" role="list" aria-label={msg.snippets.title} data-testid="snippet-list" data-compact={compact || undefined} ref={listRef}>
        {groups.map(([folder, items]) => {
          const open = !collapsed.has(folder) || query !== "";
          return (
            <div key={folder || "-"} className="folder" role="listitem">
              <div className="folder-row">
              <button
                type="button"
                className="folder-head"
                aria-expanded={open}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(folder)) next.delete(folder);
                    else next.add(folder);
                    return next;
                  })
                }
              >
                <IconChevronRight size={14} className="chevron" />
                <IconFolder size={14} />
                <span className="truncate">{folder || msg.snippets.topLevel}</span>
                <span className="box-count">{items.length}</span>
              </button>
              {folder !== "" && !compact && (
                <IconButton size="sm" label={msgD.organize.renameFolder} onClick={() => setRenaming(folder)}>
                  <IconPencil size={13} />
                </IconButton>
              )}
              {/* The top level cannot be renamed: hold the button's place so the counts line up. */}
              {folder === "" && !compact && <span className="folder-row-spacer" aria-hidden="true" />}
              </div>
              {open && (
                <ul aria-label={folder || msg.snippets.topLevel}>
                  {items.map((snippet) => (
                    <li
                      key={snippet.id}
                      className="snippet"
                      data-snippet={snippet.name}
                      data-flip-key={snippet.id}
                      onDoubleClick={(event) => {
                        // Double-click runs, as Run does; not from the buttons inside the row.
                        if (!canSend || (event.target as HTMLElement).closest("button")) return;
                        onSend?.(snippet, "run");
                      }}
                    >
                      <div className="snippet-main">
                        <span className="snippet-name">
                          <span className="truncate">{snippet.name}</span>
                          {lines(snippet.text) > 1 && <span className="badge">{msg.snippets.lines(lines(snippet.text))}</span>}
                        </span>
                        {/* The command as plain text, exactly as it will be sent; the first line here. */}
                        <span className="snippet-code" title={snippet.text}>
                          {firstLine(snippet.text)}
                        </span>
                      </div>
                      <div className="snippet-actions">
                        {!compact && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={!canSend}
                            aria-label={msg.snippets.pasteTo(snippet.name)}
                            onClick={() => onSend?.(snippet, "paste")}
                          >
                            <IconClipboardPaste size={13} />
                            {msg.snippets.paste}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm btn-primary snippet-run"
                          disabled={!canSend}
                          aria-label={msg.snippets.runIn(snippet.name)}
                          onClick={() => onSend?.(snippet, "run")}
                        >
                          <IconPlay size={13} />
                          {msg.snippets.run}
                        </button>
                        <IconButton
                          size="sm"
                          label={msg.snippets.more(snippet.name)}
                          aria-haspopup="menu"
                          onClick={(event) => setMenu({ snippet, anchor: event.currentTarget })}
                        >
                          <IconEllipsis size={15} />
                        </IconButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {menu && (
        <Menu
          label={msg.snippets.more(menu.snippet.name)}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={[
            ...(compact
              ? [
                  {
                    label: msg.snippets.pasteTo(menu.snippet.name),
                    icon: <IconClipboardPaste size={15} />,
                    disabled: !canSend,
                    onSelect: () => onSend?.(menu.snippet, "paste"),
                  },
                  "separator" as const,
                ]
              : []),
            { label: msgD.runs.runOnHosts, icon: <IconPlay size={15} />, onSelect: () => setRunMany({ snippet: menu.snippet, allOpen: false }) },
            { label: msgRuns.runAllOpen, icon: <IconPlay size={15} />, onSelect: () => setRunMany({ snippet: menu.snippet, allOpen: true }) },
            "separator",
            { label: msg.snippets.edit, icon: <IconPencil size={15} />, onSelect: () => setEditing({ snippet: menu.snippet }) },
            {
              label: msg.snippets.duplicate,
              icon: <IconCopy size={15} />,
              onSelect: () =>
                setEditing({
                  snippet: null,
                  initial: { name: `${menu.snippet.name} ${msg.snippets.copySuffix}`, folder: menu.snippet.folder, text: menu.snippet.text },
                }),
            },
            { label: msgD.organize.moveTo, icon: <IconFolder size={15} />, onSelect: () => setMoving({ snippet: menu.snippet, copy: false }) },
            { label: msgD.organize.copyTo, icon: <IconCopy size={15} />, onSelect: () => setMoving({ snippet: menu.snippet, copy: true }) },
            "separator",
            { label: msg.snippets.delete, icon: <IconTrash2 size={15} />, tone: "danger", onSelect: () => setDeleting(menu.snippet) },
          ]}
        />
      )}

      {runMany && <MultiRunDialog snippet={runMany.snippet} allOpen={runMany.allOpen} onClose={() => setRunMany(null)} />}

      {moving && (
        <MoveSnippetDialog
          snippet={moving.snippet}
          copy={moving.copy}
          folders={folders}
          onClose={() => setMoving(null)}
          onDone={(folder) => {
            notify("success", moving.copy ? msgD.organize.copied(folder) : msgD.organize.moved(folder));
            setMoving(null);
            void snippets.reload();
          }}
        />
      )}

      {renaming !== null && (
        <RenameFolderDialog
          folder={renaming}
          onClose={() => setRenaming(null)}
          onDone={(count) => {
            notify("success", msgD.organize.renamed(count));
            setRenaming(null);
            void snippets.reload();
          }}
        />
      )}

      {editing && (
        <SnippetEditor
          snippet={editing.snippet}
          initial={editing.initial}
          folders={folders}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void snippets.reload();
          }}
        />
      )}

      {deleting && (
        <Dialog title={msg.snippets.deleteTitle(deleting.name)} role="alertdialog" icon={<IconTrash2 size={18} />} tone="danger" onDismiss={() => setDeleting(null)}>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msg.snippets.deleteBody}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDeleting(null)} autoFocus data-autofocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                const target = deleting;
                setDeleting(null);
                void remove(target);
              }}
            >
              {msg.common.delete}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function TargetIndicator({ target }: { target: SnippetTarget | null }) {
  return (
    <div className="panel-target" data-ready={target !== null} role="status" aria-label={msg.snippets.target}>
      {target ? (
        <>
          <span className="status-dot" data-tone="ok" aria-hidden="true" />
          <span className="truncate">
            {msg.snippets.targetIs(target.label)} <span className="faint mono">· {target.identity}</span>
          </span>
        </>
      ) : (
        <span>{msg.snippets.targetNone}</span>
      )}
    </div>
  );
}
