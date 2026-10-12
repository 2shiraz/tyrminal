import type { RemoteEntry } from "@tyrminal/contracts";
import { type DragEvent, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { IconArrowUpDown, IconChevronDown, IconEllipsis, IconFile, IconFolder, IconLink2 } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { relativeTime } from "../../components/ui/controls";
import { useWindowedList } from "../../components/ui/useWindowedList";
import { type Sort, type SortKey, formatModified, formatSize, modeString, visibleName } from "../sftp/model";
import { msgFiles } from "./messages";
import { NO_SELECTION, type Selection, TYPE_AHEAD_MS, clickSelect, keySelect, pressFeedback, single, toggleKey, typeAhead } from "./selection";

export type Column = "name" | "modified" | "size" | "mode";

/** Keys the table turns into actions its owner carries out. */
export type TableKey = "up" | "back" | "forward" | "rename" | "delete" | "copyOther" | "editPath";

/** Where a menu opens: at the pointer, or under a row (keyboard). */
export type MenuAt = { x: number; y: number } | HTMLElement;

const SORTABLE: Partial<Record<Column, SortKey>> = { name: "name", modified: "modified", size: "size" };

function EntryIcon({ entry }: { entry: RemoteEntry }) {
  if (entry.kind === "dir") return <IconFolder size={15} />;
  if (entry.kind === "symlink") return <IconLink2 size={15} />;
  return <IconFile size={15} />;
}

/** The part of a name to select when renaming: all of a folder, a file without its extension. */
function stemEnd(entry: RemoteEntry): number {
  const dot = entry.name.lastIndexOf(".");
  return entry.kind === "dir" || dot <= 0 ? entry.name.length : dot;
}

/**
 * A folder's contents as a table, shared by the Files panel and both panes of the SFTP tab.
 * Folders first, then the chosen sort. Click, Shift and Ctrl/Cmd select; the keyboard moves
 * (arrows, Home/End, Shift extends, Space toggles), types ahead to a name, opens (Enter), goes up
 * (Backspace, Alt+Up), renames in place (F2), deletes (Delete) and opens the row menu
 * (Shift+F10 or the menu key). Right-click opens the same menu at the pointer.
 * Long folders are windowed: only the rows near the visible part are in the DOM, two aria-hidden
 * spacer rows hold the height of the rest, and the grid reports its full size (aria-rowcount and
 * aria-rowindex, the header being row 1). The keyboard scrolls its target row in before focusing it.
 */
export function FileTable({
  label,
  entries,
  columns,
  sort,
  onSort,
  selection,
  onSelection,
  opening = null,
  busy = false,
  inactive = false,
  renaming = null,
  onRename,
  onRenameEnd,
  onActivate,
  onMenu,
  onBackgroundMenu,
  onKey,
  canDrag,
  onDragStart,
  empty,
}: {
  label: string;
  entries: RemoteEntry[];
  columns: Column[];
  sort?: Sort;
  onSort?: (key: SortKey) => void;
  selection: Selection;
  onSelection: (next: Selection) => void;
  opening?: string | null;
  busy?: boolean;
  /** Another pane has focus: the selection shows in grey, as in Finder. */
  inactive?: boolean;
  /** The entry being renamed in place. */
  renaming?: string | null;
  /** Renames; resolves to an error message to show (the field stays), or null when done. */
  onRename?: (entry: RemoteEntry, name: string) => Promise<string | null>;
  onRenameEnd?: () => void;
  onActivate: (entry: RemoteEntry) => void;
  onMenu?: (entries: RemoteEntry[], at: MenuAt) => void;
  onBackgroundMenu?: (at: MenuAt) => void;
  onKey?: (key: TableKey) => void;
  canDrag?: (entry: RemoteEntry) => boolean;
  onDragStart?: (event: DragEvent, entry: RemoteEntry, selected: boolean) => void;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
}) {
  const order = entries.map((e) => e.name);
  const tableRef = useRef<HTMLTableElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const rows = useWindowedList<HTMLTableSectionElement>(entries.length, 30, bodyRef);
  const shown = rows.windowed ? entries.slice(rows.start, rows.end) : entries;
  // The row Tab lands on: the cursor, else the first row; a windowed list without it in the DOM uses
  // the first rendered row, so the table stays reachable.
  const roving = (() => {
    const name = selection.cursor ?? order[0];
    return rows.windowed && !shown.some((e) => e.name === name) ? shown[0]?.name : name;
  })();
  const typed = useRef({ text: "", at: 0 });
  /** The keyboard was in this table and has not been moved elsewhere on purpose. */
  const hadFocus = useRef(false);
  const picked = (names: string[]) => entries.filter((e) => names.includes(e.name));

  // Opening a folder replaces the focused row; the keyboard stays in the table (on the selected
  // row, else the first one, else the table itself) instead of falling back to the page.
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table || !hadFocus.current || (document.activeElement && document.activeElement !== document.body)) return;
    const target = selection.cursor ?? selection.names[0] ?? order[0];
    (target ? table.querySelector<HTMLElement>(`tr[data-name="${CSS.escape(target)}"] .ft-name`) : null)?.focus() ?? table.focus();
  });

  /** Moves keyboard focus to a row's name (after React has drawn the new selection). */
  const focusRow = (name: string | null) => {
    if (!name) return;
    rows.scrollToIndex(order.indexOf(name));
    window.requestAnimationFrame(() => tableRef.current?.querySelector<HTMLButtonElement>(`tr[data-name="${CSS.escape(name)}"] .ft-name`)?.focus());
  };

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("input, thead")) return;
    const mod = toggleKey(event);
    // The row the keyboard is on: the selection's cursor, else the focused row. The cursor comes
    // first because type-ahead moves it at once but moves focus a frame later: Enter typed right
    // after a name must open that name, not the row focused before it.
    const focusedName = target.closest<HTMLElement>("tbody tr")?.dataset.name;
    const cursorEntry =
      entries.find((e) => e.name === selection.cursor) ?? entries.find((e) => e.name === (focusedName ?? selection.names[0]));
    const act = (key: TableKey) => {
      event.preventDefault();
      onKey?.(key);
    };

    if (event.key === "Enter" && !mod) {
      if (cursorEntry) {
        event.preventDefault();
        onActivate(cursorEntry);
      }
      return;
    }
    if (event.key === "F2") return act("rename");
    if (event.key === "Delete" || (mod && event.key === "Backspace")) return act("delete");
    if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) return act("up");
    if (event.altKey && event.key === "ArrowLeft") return act("back");
    if (event.altKey && event.key === "ArrowRight") return act("forward");
    if (event.key === "F5") return act("copyOther");
    if (mod && event.key.toLowerCase() === "l") return act("editPath");
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      onSelection({ names: [...order], anchor: order[0] ?? null, cursor: selection.cursor ?? order[0] ?? null });
      return;
    }
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      event.preventDefault();
      const chosen = picked(selection.names);
      const row = cursorEntry ? tableRef.current?.querySelector<HTMLElement>(`tr[data-name="${CSS.escape(cursorEntry.name)}"]`) : null;
      if (chosen.length > 0 && row) onMenu?.(chosen, row);
      else if (tableRef.current) onBackgroundMenu?.(tableRef.current);
      return;
    }
    if (event.key === "Escape" && selection.names.length > 0) {
      // First Escape clears the selection; the next one reaches the owner (closing a panel).
      event.preventDefault();
      event.stopPropagation();
      onSelection({ ...NO_SELECTION, cursor: selection.cursor });
      return;
    }

    // Type-ahead: printable characters jump to the first matching name.
    const searching = event.timeStamp - typed.current.at < TYPE_AHEAD_MS && typed.current.text !== "";
    if (event.key.length === 1 && !mod && !event.altKey && !event.metaKey && !(event.key === " " && !searching)) {
      const text = searching ? typed.current.text + event.key : event.key;
      typed.current = { text, at: event.timeStamp };
      const name = typeAhead(order, selection.cursor, text);
      event.preventDefault();
      if (name) {
        onSelection(single(name));
        focusRow(name);
      }
      return;
    }

    const next = keySelect(selection, order, event.key, event.shiftKey);
    if (!next) return;
    event.preventDefault();
    onSelection(next);
    focusRow(next.cursor);
  }

  return (
    <div
      className="ft"
      data-inactive={inactive || undefined}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest("tbody tr, input")) return;
        event.preventDefault();
        onSelection(NO_SELECTION);
        onBackgroundMenu?.({ x: event.clientX, y: event.clientY });
      }}
      onClick={(event) => {
        // A click on the free space below the rows clears the selection.
        if (event.target === event.currentTarget) onSelection(NO_SELECTION);
      }}
    >
      <table
        ref={tableRef}
        className="ft-table"
        role="grid"
        tabIndex={-1}
        aria-multiselectable="true"
        aria-label={label}
        aria-busy={busy || undefined}
        aria-rowcount={rows.windowed ? entries.length + 1 : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => {
          hadFocus.current = true;
        }}
        onBlur={(event) => {
          // Focus moved somewhere else on purpose; a row that disappeared has no related target.
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) hadFocus.current = false;
        }}
      >
        <thead>
          <tr aria-rowindex={rows.windowed ? 1 : undefined}>
            {columns.map((column) => {
              const key = SORTABLE[column];
              const title = msgFiles.columns[column];
              return (
                <th
                  key={column}
                  scope="col"
                  className={`ft-col-${column}`}
                  aria-sort={key && sort ? (sort.key === key ? (sort.ascending ? "ascending" : "descending") : "none") : undefined}
                >
                  {key && sort && onSort ? (
                    <button type="button" className="ft-sort" aria-label={msgFiles.sortBy(title)} onClick={() => onSort(key)}>
                      {title}
                      {sort.key === key ? (
                        <IconChevronDown size={12} className={sort.ascending ? "" : "ft-sort-desc"} />
                      ) : (
                        <IconArrowUpDown size={12} className="ft-sort-idle" />
                      )}
                    </button>
                  ) : (
                    <span className="ft-head">{title}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {rows.before > 0 && (
            <tr className="ft-spacer" aria-hidden="true">
              <td colSpan={columns.length} style={{ height: rows.before }} />
            </tr>
          )}
          {shown.map((entry, i) => {
            const isSelected = selection.names.includes(entry.name);
            const isOpening = opening === entry.name;
            const name = visibleName(entry.name);
            // The full name, permissions and exact date, also where a narrow list has no room for them.
            const details = [name, modeString(entry), entry.modified != null ? formatModified(entry.modified) : null].filter(Boolean).join("\n");
            const draggable = canDrag?.(entry) ?? false;
            return (
              <tr
                key={entry.name}
                data-window-item
                aria-rowindex={rows.windowed ? rows.start + i + 2 : undefined}
                aria-selected={isSelected}
                className={isSelected ? "is-selected" : undefined}
                data-name={entry.name}
                data-kind={entry.kind}
                data-loading={isOpening || undefined}
                draggable={draggable && renaming !== entry.name}
                onPointerDown={(event) => pressFeedback(event.currentTarget)}
                onDragStart={(event) => onDragStart?.(event, entry, isSelected)}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("input, .ft-more")) return;
                  onSelection(clickSelect(selection, order, entry.name, { toggle: toggleKey(event), extend: event.shiftKey }));
                }}
                onDoubleClick={(event) => {
                  if (!(event.target as HTMLElement).closest("input, .ft-more")) onActivate(entry);
                }}
                onContextMenu={(event) => {
                  if ((event.target as HTMLElement).closest("input")) return;
                  event.preventDefault();
                  // Right-click on an unselected row selects it alone, as in Finder.
                  const names = isSelected ? selection.names : [entry.name];
                  if (!isSelected) onSelection(single(entry.name));
                  onMenu?.(picked(names), { x: event.clientX, y: event.clientY });
                }}
              >
                {columns.map((column) => {
                  switch (column) {
                    case "name":
                      return (
                        <td key={column} className="ft-col-name">
                          {renaming === entry.name && onRename ? (
                            <RenameField entry={entry} onRename={onRename} onEnd={() => onRenameEnd?.()} onFocusRow={() => focusRow(entry.name)} />
                          ) : (
                            <div className="ft-cell-name">
                              <button
                                type="button"
                                className="ft-name"
                                aria-label={entry.kind === "dir" ? msg.files.open(entry.name) : msg.files.select(entry.name)}
                                tabIndex={roving === entry.name ? 0 : -1}
                              >
                                <span className={`ft-icon ft-icon-${entry.kind}`} aria-hidden="true">
                                  {isOpening ? <span className="spinner spinner-xs" /> : <EntryIcon entry={entry} />}
                                </span>
                                <span className="ft-name-text" title={details}>
                                  {name}
                                </span>
                              </button>
                              {onMenu && (
                                <button
                                  type="button"
                                  className="ft-more"
                                  tabIndex={-1}
                                  aria-label={msgFiles.rowMenu(entry.name)}
                                  onClick={(event) => {
                                    const names = isSelected ? selection.names : [entry.name];
                                    if (!isSelected) onSelection(single(entry.name));
                                    onMenu(picked(names), event.currentTarget);
                                  }}
                                >
                                  <IconEllipsis size={14} />
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      );
                    case "modified":
                      return (
                        <td key={column} className="ft-col-modified" title={formatModified(entry.modified)}>
                          {entry.modified == null ? "" : relativeTime(entry.modified)}
                        </td>
                      );
                    case "size":
                      return (
                        <td key={column} className="ft-col-size">
                          {entry.kind === "dir" ? "" : formatSize(entry.size)}
                        </td>
                      );
                    case "mode":
                      return (
                        <td key={column} className="ft-col-mode mono">
                          {modeString(entry)}
                        </td>
                      );
                  }
                })}
              </tr>
            );
          })}
          {rows.after > 0 && (
            <tr className="ft-spacer" aria-hidden="true">
              <td colSpan={columns.length} style={{ height: rows.after }} />
            </tr>
          )}
        </tbody>
      </table>
      {entries.length === 0 && empty}
    </div>
  );
}

function RenameField({
  entry,
  onRename,
  onEnd,
  onFocusRow,
}: {
  entry: RemoteEntry;
  onRename: (entry: RemoteEntry, name: string) => Promise<string | null>;
  onEnd: () => void;
  onFocusRow: () => void;
}) {
  const [text, setText] = useState(entry.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.setSelectionRange(0, stemEnd(entry));
  }, [entry]);

  // A refused name keeps the field (focused again once it is enabled) with the reason under it.
  useEffect(() => {
    if (error && !pending) input.current?.focus();
  }, [error, pending]);

  async function commit(refocus: boolean) {
    if (busy.current) return;
    const name = text.trim();
    if (name === "" || name === entry.name) {
      onEnd();
      if (refocus) onFocusRow();
      return;
    }
    busy.current = true;
    setPending(true);
    const problem = await onRename(entry, name);
    busy.current = false;
    setPending(false);
    if (problem) setError(problem);
    else {
      onEnd();
      if (refocus) onFocusRow();
    }
  }

  return (
    <div className="ft-rename">
      <span className={`ft-icon ft-icon-${entry.kind}`} aria-hidden="true">
        <EntryIcon entry={entry} />
      </span>
      <input
        ref={input}
        className="ft-rename-input"
        aria-label={msgFiles.renameField(entry.name)}
        aria-invalid={error ? true : undefined}
        title={msgFiles.renameHint}
        value={text}
        disabled={pending}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            void commit(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onEnd();
            onFocusRow();
          }
        }}
        onBlur={() => {
          // Leaving the field keeps a valid new name (as in Finder); a refused one is dropped.
          if (!error) void commit(false);
          else onEnd();
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      {error && (
        <span className="ft-rename-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
