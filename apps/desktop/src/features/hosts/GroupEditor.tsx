// The group editor. Like the Host details panel it saves as you go: every valid field 400 ms after
// the last change or at once on blur, each write undoable for 10 s. A new group is created on its
// first valid name. The route defaults (jump host and proxy) are one unit, written once all of it
// is valid: before the group's basics for an existing group (a loop is refused before anything
// changes), right after creation for a new one. A proxy password is set only with its button.
import type { GroupDefaults, GroupInput, GroupSummary, KeySummary } from "@tyrminal/contracts";
import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, Switch, TextField } from "../../components/ui/controls";
import { IconFolder } from "../../components/ui/icons";
import { AutosaveStatus, type SaveResult, handleUndoKey, useAutosave } from "../../lib/autosave";
import { groupDefaults as groupDefaultsApi, groups as groupsApi, toAppError } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { discardWording, msgAutosave } from "../../lib/messages-autosave";
import { msgProduction } from "../../lib/messages-production";
import { validGroupName, validPort, validUsername } from "./fieldRules";
import { NoteCard } from "../notes/NoteCard";
import { GroupDefaultsSection, useGroupDefaults } from "./GroupDefaultsSection";
import { groupPath } from "./HostEditor";

interface GroupFields {
  name: string;
  parent: string | null;
  username: string;
  port: string;
  keyId: string;
  production: boolean;
}

/** Valid fields from `fields`, the rest from `stored`; `null` while a new group has no valid name. */
export function groupDraft(fields: GroupFields, stored: GroupFields | null): GroupFields | null {
  if (stored === null && !validGroupName(fields.name)) return null;
  const from = stored ?? fields;
  return {
    name: validGroupName(fields.name) ? fields.name : from.name,
    parent: fields.parent,
    username: validUsername(fields.username.trim()) ? fields.username : from.username,
    port: validPort(fields.port, true) ? fields.port : stored ? stored.port : "",
    keyId: fields.keyId,
    production: fields.production,
  };
}

function groupInput(d: GroupFields, id: string | null): GroupInput {
  return {
    id,
    name: d.name.trim(),
    parentId: d.parent,
    username: d.username.trim() === "" ? null : d.username.trim(),
    port: d.port === "" ? null : Number(d.port),
    keyId: d.keyId === "" ? null : d.keyId,
    production: d.production,
  };
}

interface WriteOptions {
  proxyPassword?: string;
  releaseProxy?: boolean;
}

import { descendantsOf } from "./groupTree";

export { descendantsOf };

export function GroupEditor({
  group,
  parentId,
  groups,
  keys,
  onClose,
  onSaved,
}: {
  group: GroupSummary | null;
  /** Parent preselected for a new group. */
  parentId?: string | null;
  groups: GroupSummary[];
  keys: KeySummary[];
  /** `created`: the group this editor created, if any. */
  onClose: (created: GroupSummary | null) => void;
  /** After every write of the group itself (the first one creates it). */
  onSaved: (saved: GroupSummary) => void;
}) {
  const [start] = useState<GroupFields>(() => ({
    name: group?.name ?? "",
    parent: group ? group.parentId : (parentId ?? null),
    username: group?.username ?? "",
    port: group?.port ? String(group.port) : "",
    keyId: group?.keyId ?? "",
    production: group?.production ?? false,
  }));
  const [name, setName] = useState(start.name);
  const [parent, setParent] = useState<string | null>(start.parent);
  const [username, setUsername] = useState(start.username);
  const [port, setPort] = useState(start.port);
  const [keyId, setKeyId] = useState(start.keyId);
  const [production, setProduction] = useState(start.production);
  // Leaving with what is not autosaved (a typed proxy password, note edits) asks first.
  const [confirming, setConfirming] = useState<NonNullable<ReturnType<typeof discardWording>> | null>(null);
  const [noteDirty, setNoteDirty] = useState(false);
  const defaults = useGroupDefaults(group?.id ?? null);
  const fields: GroupFields = { name, parent, username, port, keyId, production };
  const idRef = useRef<string | null>(group?.id ?? null);
  const created = useRef<GroupSummary | null>(null);
  const stored = useRef<GroupFields | null>(group ? start : null);
  const live = useRef({ fields, defaults });
  live.current = { fields, defaults };
  // The defaults as last written (no secret): a write queued behind another can run before React
  // re-renders, while they still look changed; this keeps them from being written twice.
  const defaultsWritten = useRef<string | null>(null);
  const [, setVersion] = useState(0);

  const excluded = group ? descendantsOf(groups, group.id) : new Set<string>();
  const nameError = name.trim() === "" ? (idRef.current ? msgAutosave.groupName : undefined) : validGroupName(name) ? undefined : msgAutosave.groupName;
  const portError = validPort(port, true) ? undefined : "1–65535";
  const userError = validUsername(username.trim()) ? undefined : msgAutosave.username;

  function plan(options: WriteOptions = {}) {
    const { fields: f, defaults: d } = live.current;
    const draft = groupDraft(f, stored.current);
    if (draft === null) return null;
    const id = idRef.current;
    const basicsChanged = id === null || JSON.stringify(groupInput(draft, id)) !== JSON.stringify(groupInput(stored.current as GroupFields, id));
    // The route is one unit: this editor's, once valid (and not dropping a stored password unless asked).
    const routeOk = d.ready && d.valid && (!d.dropsPassword || options.releaseProxy === true || options.proxyPassword !== undefined);
    const routeWrite = routeOk && (d.routeChanged || options.proxyPassword !== undefined);
    const defaultsKey = JSON.stringify(d.inputFor(routeWrite));
    const explicit = options.proxyPassword !== undefined || options.releaseProxy === true;
    const defaultsChanged = d.ready && (routeWrite || d.osChanged) && (explicit || defaultsKey !== defaultsWritten.current);
    return { draft, basicsChanged, defaultsChanged, defaultsKey, defaultsInput: d.inputFor(routeWrite, options.proxyPassword) };
  }

  async function write(options: WriteOptions = {}): Promise<SaveResult> {
    const p = plan(options);
    if (p === null || (!p.basicsChanged && !p.defaultsChanged)) return undefined;
    const d = live.current.defaults;
    const prev = stored.current;
    const prevDefaults: GroupDefaults | null = d.loaded;
    const isNew = idRef.current === null;
    if (!isNew && p.defaultsChanged) {
      d.setLoaded(await groupDefaultsApi.set(idRef.current as string, p.defaultsInput));
      defaultsWritten.current = p.defaultsKey;
    }
    if (p.basicsChanged) {
      const saved = await groupsApi.save(groupInput(p.draft, idRef.current));
      idRef.current = saved.id;
      if (isNew) created.current = saved;
      stored.current = p.draft;
      onSaved(saved);
    }
    if (isNew && p.defaultsChanged) {
      d.setLoaded(await groupDefaultsApi.set(idRef.current as string, p.defaultsInput));
      defaultsWritten.current = p.defaultsKey;
    }
    if (options.proxyPassword !== undefined) d.setProxyPassword("");
    stored.current = p.draft;
    setVersion((v) => v + 1);
    if (prev === null) return null;
    return () => {
      setName(prev.name);
      setParent(prev.parent);
      setUsername(prev.username);
      setPort(prev.port);
      setKeyId(prev.keyId);
      setProduction(prev.production);
      if (p.defaultsChanged) live.current.defaults.restore(prevDefaults);
    };
  }

  const p = plan();
  const pending = p === null || (!p.basicsChanged && !p.defaultsChanged) ? null : JSON.stringify([groupInput(p.draft, idRef.current), p.defaultsChanged ? p.defaultsInput : null]);
  const autosave = useAutosave({ pending, save: () => write() });
  const exists = idRef.current !== null || groupDraft(fields, null) !== null;
  const typedSecret = defaults.proxy.password !== "";

  async function close() {
    const wording = discardWording({ password: typedSecret, note: noteDirty });
    if (wording) {
      setConfirming(wording);
      return;
    }
    const ok = await autosave.flush();
    if (ok) onClose(created.current);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void autosave.flush();
  }

  return (
    <Dialog
      title={idRef.current || group ? msg.hosts.editGroup : msg.hosts.newGroup}
      icon={<IconFolder size={18} />}
      onDismiss={() => void close()}
      aside={<AutosaveStatus autosave={autosave} testId="group-editor-status" />}
    >
      <form
        className="stack"
        onSubmit={submit}
        onBlur={() => void autosave.flush()}
        onKeyDown={(event: KeyboardEvent) => handleUndoKey(event, autosave, pending !== null)}
        aria-busy={autosave.state === "saving"}
        noValidate
      >
        <TextField
          label={msg.hosts.groupName}
          value={name}
          onChange={setName}
          autoFocus
          maxLength={256}
          error={nameError}
        />
        <label className="field">
          <span className="label">{msg.hosts.groupParent}</span>
          <select className="select" value={parent ?? ""} onChange={(event) => setParent(event.target.value || null)}>
            <option value="">{msg.hosts.groupTopLevel}</option>
            {groups
              .filter((g) => !excluded.has(g.id))
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {groupPath(groups, g.id)}
                </option>
              ))}
          </select>
        </label>
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 2 }}>
            {msg.hosts.groupDefaults}
          </legend>
          <p className="hint">{msg.hosts.groupDefaultsHint}</p>
          <div className="split">
            <TextField label={msg.hosts.username} value={username} onChange={setUsername} maxLength={255} error={userError} />
            <TextField label={msg.hosts.port} value={port} onChange={setPort} inputMode="numeric" maxLength={5} error={portError} />
          </div>
          <label className="field">
            <span className="label">{msg.hosts.groupKey}</span>
            <select className="select" value={keyId} onChange={(event) => setKeyId(event.target.value)}>
              <option value="">{msg.hosts.groupKeyNone}</option>
              {keys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.label} ({key.algorithm})
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <GroupDefaultsSection
          state={defaults}
          live={{
            canSet: exists && defaults.valid,
            set: () => {
              const proxyPassword = live.current.defaults.proxy.password;
              if (proxyPassword === "") return;
              void autosave.commit(async () => {
                try {
                  await write({ proxyPassword });
                } finally {
                  live.current.defaults.setProxyPassword("");
                }
              });
            },
            remove: () => void autosave.commit(async () => void (await write({ releaseProxy: true }))),
          }}
        />
        <Switch label={msgProduction.groupSwitch} hint={msgProduction.groupHint} checked={production} onChange={setProduction} />
        {exists && idRef.current !== null && <NoteCard target={{ kind: "group", groupId: idRef.current }} onDirty={setNoteDirty} />}
        <ErrorNotice error={autosave.state === "error" && autosave.error ? toAppError(autosave.error) : null} />
        <div className="dialog-actions">
          {idRef.current === null && <p className="hint dialog-actions-hint">{msgAutosave.newGroupHint}</p>}
          <button type="button" className="btn btn-primary" onClick={() => void close()}>
            {msgAutosave.done}
          </button>
        </div>
      </form>
      {confirming && (
        <Dialog title={confirming.title} role="alertdialog" tone="warning" onDismiss={() => setConfirming(null)}>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {confirming.body}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setConfirming(null)} autoFocus data-autofocus>
              {msgAutosave.keepEditing}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                setConfirming(null);
                defaults.setProxyPassword("");
                void autosave.flush().then((ok) => ok && onClose(created.current));
              }}
            >
              {confirming.action}
            </button>
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}
