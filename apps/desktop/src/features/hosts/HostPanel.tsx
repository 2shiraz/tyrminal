// Host details: a side panel on the Hosts view for adding and editing a host while the list stays
// usable. Every valid change is saved as it is made (hostAutosave.ts): the header says "Saving…"
// and "Saved", and the last changes can be undone for 10 s. Secrets are set with their own button;
// leaving with a typed, unset one asks first (the owner's guard).
import type { GroupSummary, HostOs, HostSummary, IdentitySummary, KeySummary } from "@tyrminal/contracts";
import { type FormEvent, type KeyboardEvent, type MutableRefObject, useEffect, useId, useRef, useState } from "react";

import { Menu } from "../../components/ui/Menu";
import { ErrorNotice, IconButton } from "../../components/ui/controls";
import {
  IconArrowLeftRight,
  IconCopy,
  IconEllipsis,
  IconPanelRightClose,
  IconPlay,
  IconSlidersHorizontal,
  IconStar,
  IconTrash2,
} from "../../components/ui/icons";
import { AutosaveStatus, handleUndoKey } from "../../lib/autosave";
import { toAppError } from "../../lib/ipc";
import { msgSftp } from "../sftp/messages";
import { msg } from "../../lib/messages";
import type { Unsaved } from "../../lib/messages-autosave";
import { msgD } from "../../lib/messages-d";
import { useHostAutosave } from "./hostAutosave";
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
  unsavedRef,
  onRequestClose,
  onSaved,
  onConnect,
  onOpenSftp,
  onDuplicate,
  onFavourite,
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
  /** Mirrors what is not autosaved (a typed, unset password; note edits), for the owner's guard. */
  unsavedRef: MutableRefObject<Unsaved>;
  /** Escape or the collapse button: the owner asks before discarding a typed password. */
  onRequestClose: () => void;
  /** After every write of the host itself (the first one creates it). */
  onSaved: (saved: HostSummary) => void;
  onConnect: (host: HostSummary) => void;
  /** Open in SFTP (SSH hosts). */
  onOpenSftp?: ((host: HostSummary) => void) | undefined;
  onDuplicate: (host: HostSummary) => void;
  /** Stars or unstars the host. */
  onFavourite: (host: HostSummary) => void;
  onCopyAddress: (host: HostSummary) => void;
  onDelete: (host: HostSummary) => void;
  onEnvironment: (host: HostSummary) => void;
}) {
  const host = target.kind === "edit" ? target.host : null;
  const initial = target.kind === "new" ? target.initial : undefined;
  const form = useHostForm({ host, initial, keys, groups, defaultGroupId, identity });
  const { autosave, live, pending, typedSecret, flushForConnect } = useHostAutosave(form, { host, onSaved });
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [connecting, setConnecting] = useState(false);
  // An unsaved note counts too: closing asks first instead of dropping it.
  const [noteDirty, setNoteDirty] = useState(false);
  unsavedRef.current = { password: typedSecret, note: noteDirty };

  // A serial host has no address field to start in: focus goes to the panel's heading so it stays
  // inside the panel.
  const focusHeading = host?.protocol.type === "serial";
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
    // On mount only: the panel is remounted for every host.
  }, []);

  const groupId = form.fields.groupId;
  const location = msgD.hostPanel.location(groupId ? groupPath(groups, groupId) : null);

  // Enter in a field saves at once (a password field sets its password instead).
  function submit(event: FormEvent) {
    event.preventDefault();
    void autosave.flush();
  }

  async function connect() {
    setConnecting(true);
    const saved = await flushForConnect();
    setConnecting(false);
    if (saved) onConnect(saved);
  }

  function onKeyDown(event: KeyboardEvent) {
    handleUndoKey(event, autosave, pending !== null);
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // A dialog or menu opened from the panel handles its own Escape.
    if ((event.target as HTMLElement).closest("dialog, [role='menu']")) return;
    event.preventDefault();
    onRequestClose();
  }

  const created = host !== null || !live.isNew;
  return (
    <aside
      className="host-panel"
      aria-labelledby={titleId}
      data-testid="host-panel"
      // For tests driving the real app: whether every valid change is stored.
      data-created={created}
      data-autosave={autosave.state === "error" ? "error" : pending !== null || autosave.state === "saving" ? "pending" : "clean"}
      onKeyDown={onKeyDown}
    >
      <header className="host-panel-head">
        <div className="host-panel-heading">
          <h2 id={titleId} ref={heading} tabIndex={-1}>
            {created ? msgD.hostPanel.title : msgD.hostPanel.newTitle}
          </h2>
          <span className="host-panel-location" data-testid="host-panel-location">
            {location}
          </span>
        </div>
        <AutosaveStatus autosave={autosave} testId="host-panel-status" />
        {host && (
          <IconButton size="sm" label={msgD.hostPanel.menu} aria-haspopup="menu" aria-expanded={menu !== null} onClick={(event) => setMenu(event.currentTarget)}>
            <IconEllipsis size={16} />
          </IconButton>
        )}
        <IconButton size="sm" label={msgD.hostPanel.close} onClick={onRequestClose}>
          <IconPanelRightClose size={16} />
        </IconButton>
      </header>

      <form
        className="host-panel-form"
        onSubmit={submit}
        // Leaving a field saves it at once.
        onBlur={() => void autosave.flush()}
        aria-busy={autosave.state === "saving"}
        noValidate
      >
        <div className="host-panel-body">
          <HostFormCards
            form={{ ...form, live }}
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
          <ErrorNotice error={autosave.state === "error" && autosave.error ? toAppError(autosave.error) : null} />
          {host && <NoteCard target={{ kind: "host", hostId: host.id }} onDirty={setNoteDirty} />}
        </div>

        <footer className="host-panel-foot">
          <button
            type="button"
            className="btn btn-primary btn-block host-panel-connect"
            disabled={connecting || !live.canSet}
            onClick={() => void connect()}
          >
            <IconPlay size={14} />
            {msgD.hostPanel.connect}
          </button>
        </footer>
      </form>

      {menu && host && (
        <Menu
          label={msgD.hostPanel.menu}
          anchor={menu}
          onClose={() => setMenu(null)}
          items={[
            ...(onOpenSftp && host.protocol.type === "ssh" ? [{ label: msgSftp.openIn, icon: <IconArrowLeftRight size={15} />, onSelect: () => onOpenSftp(host) }] : []),
            {
              label: host.favourite ? msg.hosts.unfavourite : msg.hosts.favourite,
              icon: <IconStar size={15} fill={host.favourite ? "currentColor" : "none"} />,
              onSelect: () => onFavourite(host),
            },
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
