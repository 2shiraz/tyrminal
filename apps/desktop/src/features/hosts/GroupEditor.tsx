import type { GroupSummary, KeySummary } from "@tyrminal/contracts";
import { type FormEvent, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, TextField } from "../../components/ui/controls";
import { IconFolder } from "../../components/ui/icons";
import { groups as groupsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import { groupPath } from "./HostEditor";

/** Ids of `id` and every group nested under it (a group cannot move into these). */
export function descendantsOf(groups: GroupSummary[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) {
      if (g.parentId && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
    }
  }
  return out;
}

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
  onClose: () => void;
  onSaved: (saved: GroupSummary) => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [parent, setParent] = useState<string | null>(group ? group.parentId : (parentId ?? null));
  const [username, setUsername] = useState(group?.username ?? "");
  const [port, setPort] = useState(group?.port ? String(group.port) : "");
  const [keyId, setKeyId] = useState(group?.keyId ?? "");
  const { pending, error, run } = useAction();

  const excluded = group ? descendantsOf(groups, group.id) : new Set<string>();
  const portNumber = port === "" ? null : Number(port);
  const portValid = portNumber === null || (Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535);
  const ready = name.trim() !== "" && !name.includes("/") && portValid;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || pending) return;
    const saved = await run(() =>
      groupsApi.save({
        id: group?.id ?? null,
        name: name.trim(),
        parentId: parent,
        username: username.trim() === "" ? null : username.trim(),
        port: portNumber,
        keyId: keyId === "" ? null : keyId,
      }),
    );
    if (saved) onSaved(saved);
  }

  return (
    <Dialog title={group ? msg.hosts.editGroup : msg.hosts.newGroup} icon={<IconFolder size={18} />} onDismiss={onClose}>
      <form className="stack" onSubmit={submit} aria-busy={pending}>
        <TextField
          label={msg.hosts.groupName}
          value={name}
          onChange={setName}
          autoFocus
          maxLength={256}
          error={name.includes("/") ? "“/” is not allowed" : undefined}
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
            <TextField label={msg.hosts.username} value={username} onChange={setUsername} maxLength={255} />
            <TextField
              label={msg.hosts.port}
              value={port}
              onChange={setPort}
              inputMode="numeric"
              maxLength={5}
              error={!portValid ? "1–65535" : undefined}
            />
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
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready || pending}>
            {pending ? msg.common.working : msg.common.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
