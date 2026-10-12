import type { EffectiveEnvVar, EnvVar, SettingsTarget } from "@tyrminal/contracts";
import { type FormEvent, useEffect, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, IconButton } from "../../components/ui/controls";
import { IconPlus, IconSlidersHorizontal, IconX } from "../../components/ui/icons";
import { environment } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgD } from "../../lib/messages-d";
import { msgEnv } from "../../lib/messages-env";
import { useAction } from "../../lib/useAsync";
import { StartupSection, useStartup } from "./StartupSection";

/**
 * Environment variables of a host or group (SNP-11/12). For a host, the variables it inherits
 * are listed with their group, and marked when the host overrides them. Startup snippets
 * (SNP-08) are set here too and saved with their own command.
 */
export function EnvironmentDialog({
  target,
  name,
  onClose,
  onDone,
}: {
  target: SettingsTarget;
  name: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<EnvVar[] | null>(null);
  const [inherited, setInherited] = useState<EffectiveEnvVar[]>([]);
  const load = useAction();
  const save = useAction();
  const startupState = useStartup(target);

  useEffect(() => {
    let live = true;
    void load.run(() => environment.get(target)).then((vars) => {
      if (live && vars) setRows(vars);
    });
    if (target.kind === "host") {
      void environment
        .effective(target.hostId)
        .then((list) => live && setInherited(list.filter((v) => v.origin.kind === "group")))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // The target is fixed for the life of the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (index: number, change: Partial<EnvVar>) =>
    setRows((current) => (current ?? []).map((row, i) => (i === index ? { ...row, ...change } : row)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const vars = (rows ?? []).filter((r) => r.name.trim() || r.value);
    const saved = await save.run(async () => {
      const result = await environment.set(target, vars);
      await startupState.save();
      return result;
    });
    if (saved) onDone();
  }

  const own = new Set((rows ?? []).map((r) => r.name.trim()));
  return (
    <Dialog title={msgD.env.title(name)} icon={<IconSlidersHorizontal size={18} />} wide onDismiss={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">{msgD.env.body}</p>
        <p className="hint">{msgD.env.sensitive}</p>
        <ErrorNotice error={load.error} />
        {inherited.length > 0 && (
          <div className="stack-xs" data-testid="env-inherited">
            <span className="label">{msgD.env.inherited}</span>
            <ul className="env-inherited">
              {inherited.map((v) => (
                <li key={v.name} className={own.has(v.name) ? "env-overridden" : undefined}>
                  <span className="mono">{v.name}</span>
                  <span className="faint">{v.origin.kind === "group" ? msgD.env.fromGroup(v.origin.name) : ""}</span>
                  {own.has(v.name) && <span className="badge">{msgD.env.overridden}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {rows && rows.length === 0 && <p className="muted">{msgD.env.none}</p>}
        {rows && rows.length > 0 && (
          <div className="env-rows" role="group" aria-label={msgD.env.title(name)}>
            {rows.map((row, index) => (
              // Rows have no stable id until saved; the index is their identity while editing.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <div className="env-row" key={index}>
                <input
                  className="input mono"
                  aria-label={`${msgD.env.name} ${index + 1}`}
                  placeholder={msgD.env.name}
                  value={row.name}
                  maxLength={64}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => update(index, { name: e.target.value })}
                />
                <input
                  className="input mono"
                  aria-label={`${msgD.env.value} ${index + 1}`}
                  placeholder={msgD.env.value}
                  value={row.value}
                  maxLength={4096}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => update(index, { value: e.target.value })}
                />
                <IconButton size="sm" label={msgD.env.remove(row.name)} onClick={() => setRows((current) => (current ?? []).filter((_, i) => i !== index))}>
                  <IconX size={14} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        <div>
          <button type="button" className="btn btn-sm" disabled={rows === null || rows.length >= 64} onClick={() => setRows((current) => [...(current ?? []), { name: "", value: "" }])}>
            <IconPlus size={14} />
            {msgD.env.add}
          </button>
        </div>
        <StartupSection target={target} state={startupState} />
        <ErrorNotice error={save.error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} data-autofocus>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.pending || rows === null || !startupState.valid}>
            {save.pending ? msg.common.working : msgEnv.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
