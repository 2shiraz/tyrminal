import type { EffectiveEnvVar, EnvVar, SettingsTarget } from "@tyrminal/contracts";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice, IconButton } from "../../components/ui/controls";
import { IconPlus, IconSlidersHorizontal, IconX } from "../../components/ui/icons";
import { AutosaveStatus, type SaveResult, handleUndoKey, useAutosave } from "../../lib/autosave";
import { environment, toAppError } from "../../lib/ipc";
import { msgAutosave } from "../../lib/messages-autosave";
import { msgD } from "../../lib/messages-d";
import { useAction } from "../../lib/useAsync";
import { validEnvName, validEnvValue } from "./fieldRules";
import { StartupSection, useStartup } from "./StartupSection";

/** The rows to store, or `null` while any row is invalid (the list is saved as one unit). */
export function envDraft(rows: EnvVar[]): EnvVar[] | null {
  const vars = rows.filter((r) => r.name.trim() || r.value).map((r) => ({ name: r.name.trim(), value: r.value }));
  const names = new Set(vars.map((v) => v.name));
  const valid = vars.length <= 64 && names.size === vars.length && vars.every((v) => validEnvName(v.name) && validEnvValue(v.value));
  return valid ? vars : null;
}

/**
 * Environment variables of a host or group (SNP-11/12). For a host, the variables it inherits
 * are listed with their group, and marked when the host overrides them. Startup snippets
 * (SNP-08) are set here too and saved with their own command. Both save as you go (400 ms after
 * the last change, or on blur), each list once all of it is valid, and each write can be undone.
 */
export function EnvironmentDialog({
  target,
  name,
  onClose,
}: {
  target: SettingsTarget;
  name: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<EnvVar[] | null>(null);
  const [inherited, setInherited] = useState<EffectiveEnvVar[]>([]);
  const load = useAction();
  const startupState = useStartup(target);
  const stored = useRef<EnvVar[] | null>(null);
  const latest = useRef({ rows, startupState });
  latest.current = { rows, startupState };
  // The startup list as last written: a write queued behind another can run before React
  // re-renders, while the list still looks changed; this keeps it from being written twice.
  const startupWritten = useRef<string | null>(null);
  const [, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    void load.run(() => environment.get(target)).then((vars) => {
      if (live && vars) {
        stored.current = vars;
        setRows(vars);
      }
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

  function plan() {
    const { rows: current, startupState: st } = latest.current;
    const vars = current === null || stored.current === null ? null : envDraft(current);
    const varsChanged = vars !== null && JSON.stringify(vars) !== JSON.stringify(envDraft(stored.current ?? []));
    const startupChanged = st.changed && st.valid && JSON.stringify(st.value) !== startupWritten.current;
    return { vars, varsChanged, startupChanged, startup: st.value };
  }

  async function write(): Promise<SaveResult> {
    const p = plan();
    if (!p.varsChanged && !p.startupChanged) return undefined;
    const prevVars = stored.current ?? [];
    const prevStartup = latest.current.startupState.loaded;
    if (p.varsChanged && p.vars) stored.current = await environment.set(target, p.vars);
    if (p.startupChanged) {
      await latest.current.startupState.save();
      startupWritten.current = JSON.stringify(p.startup);
    }
    setVersion((v) => v + 1);
    return () => {
      if (p.varsChanged) setRows(prevVars);
      if (p.startupChanged) latest.current.startupState.restore(prevStartup);
    };
  }

  const p = plan();
  const pending = p.varsChanged || p.startupChanged ? JSON.stringify([p.varsChanged ? p.vars : null, p.startupChanged ? p.startup : null]) : null;
  const autosave = useAutosave({ pending, save: write });
  const invalid = rows !== null && envDraft(rows) === null;

  async function close() {
    if (await autosave.flush()) onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void autosave.flush();
  }

  const own = new Set((rows ?? []).map((r) => r.name.trim()));
  return (
    <Dialog
      title={msgD.env.title(name)}
      icon={<IconSlidersHorizontal size={18} />}
      wide
      onDismiss={() => void close()}
      aside={<AutosaveStatus autosave={autosave} testId="env-status" />}
    >
      <form
        className="stack"
        onSubmit={submit}
        onBlur={() => void autosave.flush()}
        onKeyDown={(event: KeyboardEvent) => handleUndoKey(event, autosave, pending !== null)}
        noValidate
      >
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
                  aria-invalid={row.name.trim() !== "" && !validEnvName(row.name) ? true : undefined}
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
        {invalid && (
          <p className="field-error" role="alert">
            {msgAutosave.envName} {msgAutosave.envHeld}
          </p>
        )}
        <StartupSection target={target} state={startupState} />
        <ErrorNotice error={autosave.state === "error" && autosave.error ? toAppError(autosave.error) : null} />
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={() => void close()} data-autofocus>
            {msgAutosave.done}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
