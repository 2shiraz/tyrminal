// Host details: a side panel on the Hosts view for adding and editing a host while the list stays
// usable. Changes are saved explicitly (Save, Enter, or "Save and connect"); closing with unsaved
// changes asks first (the owner's guard), and Cancel discards them on purpose.
import type { GroupSummary, HostOs, HostSummary, IdentitySummary, KeySummary } from "@tyrminal/contracts";
import { type FormEvent, type KeyboardEvent, type MutableRefObject, useEffect, useId, useRef, useState } from "react";

import { Menu } from "../../components/ui/Menu";
import { ErrorNotice, IconButton } from "../../components/ui/controls";
import { IconCopy, IconEllipsis, IconPanelRightClose, IconPlay, IconSlidersHorizontal, IconTrash2 } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { NoteCard } from "../notes/NoteCard";
import { HostFormCards, type HostFormOptions, groupPath, useHostForm } from "./hostForm";

export type PanelTarget = { kind: "new"; initial?: HostFormOptions["initial"] } | { kind: "edit"; host: HostSummary };

export function HostPanel({
  target,
  keys,
  groups,
  defaultGroupId,
  os,
  identity,
  justSaved,
  dirtyRef,
  onRequestClose,
  onCancel,
  onSaved,
  onConnect,
  onDuplicate,
  onCopyAddress,
  onDelete,
  onEnvironment,
}: {
  target: PanelTarget;
  keys: KeySummary[];
  groups: GroupSummary[];
  defaultGroupId: string | null;
  os: HostOs | null;
  identity: { list: IdentitySummary[]; current: string | null } | undefined;
  /** The panel was just remounted after a save: say so until the next edit. */
  justSaved: boolean;
  /** Mirrors whether the form has unsaved changes, for the owner's guard. */
  dirtyRef: MutableRefObject<boolean>;
  /** Escape or the collapse button: the owner asks before discarding unsaved changes. */
  onRequestClose: () => void;
  /** Cancel: discard on purpose. */
  onCancel: () => void;
  onSaved: (saved: HostSummary) => void;
  onConnect: (host: HostSummary) => void;
  onDuplicate: (host: HostSummary) => void;
  onCopyAddress: (host: HostSummary) => void;
  onDelete: (host: HostSummary) => void;
  onEnvironment: (host: HostSummary) => void;
}) {
  const host = target.kind === "edit" ? target.host : null;
  const initial = target.kind === "new" ? target.initial : undefined;
  const form = useHostForm({ host, initial, keys, groups, defaultGroupId, identity });
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  // An unsaved note counts as an unsaved change for the close guard too.
  const [noteDirty, setNoteDirty] = useState(false);
  dirtyRef.current = form.dirty || noteDirty;

  // After a save the panel is rebuilt from the saved host, and a serial host has no address field
  // to start in: focus goes to the panel's heading so it stays inside the panel.
  const focusHeading = justSaved || host?.protocol.type === "serial";
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
    // On mount only: the panel is remounted for every host and after every save.
  }, []);

  const groupId = form.fields.groupId;
  const location = msgD.hostPanel.location(groupId ? groupPath(groups, groupId) : null);
  const needsSave = host === null || form.dirty;
  const status =
    needsSave && !form.ready && form.missing.length > 0
      ? msgD.hostPanel.needs(form.missing)
      : form.dirty
        ? msgD.hostPanel.unsaved
        : justSaved
          ? msgD.hostPanel.saved
          : "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!needsSave) return;
    const saved = await form.save();
    if (saved) onSaved(saved);
  }

  async function connect() {
    if (!needsSave && host) {
      onConnect(host);
      return;
    }
    const saved = await form.save();
    if (saved) {
      onSaved(saved);
      onConnect(saved);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // A dialog or menu opened from the panel handles its own Escape.
    if ((event.target as HTMLElement).closest("dialog, [role='menu']")) return;
    event.preventDefault();
    onRequestClose();
  }

  return (
    <aside className="host-panel" aria-labelledby={titleId} data-testid="host-panel" onKeyDown={onKeyDown}>
      <header className="host-panel-head">
        <div className="host-panel-heading">
          <h2 id={titleId} ref={heading} tabIndex={-1}>
            {host ? msgD.hostPanel.title : msgD.hostPanel.newTitle}
          </h2>
          <span className="host-panel-location" data-testid="host-panel-location">
            {location}
          </span>
        </div>
        {host && (
          <IconButton size="sm" label={msgD.hostPanel.menu} aria-haspopup="menu" aria-expanded={menu !== null} onClick={(event) => setMenu(event.currentTarget)}>
            <IconEllipsis size={16} />
          </IconButton>
        )}
        <IconButton size="sm" label={msgD.hostPanel.close} onClick={onRequestClose}>
          <IconPanelRightClose size={16} />
        </IconButton>
      </header>

      <form className="host-panel-form" onSubmit={submit} aria-busy={form.pending} noValidate>
        <div className="host-panel-body">
          <HostFormCards
            form={form}
            os={os}
            autoFocus={!focusHeading}
            extra={
              host && (
                <button type="button" className="btn btn-sm" onClick={() => onEnvironment(host)}>
                  <IconSlidersHorizontal size={14} />
                  {msgD.hostPanel.environment}
                </button>
              )
            }
          />
          <ErrorNotice error={form.error} />
          {host && <NoteCard target={{ kind: "host", hostId: host.id }} onDirty={setNoteDirty} />}
        </div>

        <footer className="host-panel-foot">
          <p className="host-panel-status" role="status" data-testid="host-panel-status">
            {status}
          </p>
          <div className="host-panel-actions">
            <button type="button" className="btn" onClick={onCancel}>
              {msg.common.cancel}
            </button>
            <button type="submit" className="btn" disabled={!needsSave || !form.ready || form.pending}>
              {form.pending ? msg.common.working : msg.common.save}
            </button>
          </div>
          <button type="button" className="btn btn-primary btn-block host-panel-connect" disabled={form.pending || (needsSave && !form.ready)} onClick={() => void connect()}>
            <IconPlay size={14} />
            {needsSave ? msgD.hostPanel.saveConnect : msgD.hostPanel.connect}
          </button>
        </footer>
      </form>

      {menu && host && (
        <Menu
          label={msgD.hostPanel.menu}
          anchor={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: msg.hosts.duplicate, icon: <IconCopy size={15} />, onSelect: () => onDuplicate(host) },
            { label: msgD.hostPanel.copyAddress, icon: <IconCopy size={15} />, onSelect: () => onCopyAddress(host) },
            "separator",
            { label: msg.common.delete, icon: <IconTrash2 size={15} />, tone: "danger", onSelect: () => onDelete(host) },
          ]}
        />
      )}
    </aside>
  );
}
