import { useEffect, useRef, useState } from "react";

import { visibleName } from "../sftp/model";
import { msgFiles } from "./messages";

export interface Crumb {
  label: string;
  onGo: () => void;
}

/**
 * Where a file list is: breadcrumbs, the last one the folder shown. When the location can be
 * typed (a server path), clicking the free space after the crumbs, the crumbs' empty end or
 * Ctrl+L (the owner bumps `editRequest`) turns it into a text field: Enter goes there, Escape
 * or leaving the field puts the crumbs back.
 */
export function PathBar({
  crumbs,
  opening,
  busy,
  editable,
  editRequest = 0,
}: {
  crumbs: Crumb[];
  /** A folder being opened from a row: shown as a pending crumb so the click visibly registered. */
  opening?: string | null;
  busy?: boolean;
  editable?: { value: string; onSubmit: (path: string) => void } | null;
  editRequest?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const seen = useRef(editRequest);

  const start = () => {
    if (!editable) return;
    setText(editable.value);
    setEditing(true);
  };

  useEffect(() => {
    if (editRequest === seen.current) return;
    seen.current = editRequest;
    start();
    // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request starts editing.
  }, [editRequest]);

  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  if (editing && editable) {
    return (
      <form
        className="pathbar pathbar-editing"
        onSubmit={(event) => {
          event.preventDefault();
          const path = text.trim();
          setEditing(false);
          if (path && path !== editable.value) editable.onSubmit(path);
        }}
      >
        <input
          ref={input}
          name="remote-path"
          className="pathbar-input mono"
          aria-label={msgFiles.path}
          title={msgFiles.pathHint}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
            }
          }}
          onBlur={() => setEditing(false)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </form>
    );
  }

  return (
    <div className="pathbar" data-loading={busy || undefined}>
      <nav className="pathbar-crumbs" aria-label={msgFiles.pathCrumbs} aria-busy={busy || undefined}>
        <ol>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1 && !opening;
            const label = visibleName(crumb.label);
            return (
              // Positions identify the crumbs: the same name can appear twice in a path.
              <li key={`${index}-${crumb.label}`}>
                {last ? (
                  <span aria-current="location" className="pathbar-crumb pathbar-current" title={label}>
                    {label}
                  </span>
                ) : (
                  <button type="button" className="pathbar-crumb" onClick={crumb.onGo} title={label}>
                    {label}
                  </button>
                )}
              </li>
            );
          })}
          {opening && (
            <li className="pathbar-pending" aria-hidden="true">
              <span className="pathbar-crumb pathbar-current">
                <span className="spinner spinner-xs" /> {visibleName(opening)}
              </span>
            </li>
          )}
        </ol>
      </nav>
      {editable && <button type="button" className="pathbar-edit" aria-label={msgFiles.pathEdit} title={msgFiles.pathEdit} onClick={start} />}
    </div>
  );
}
