import type { EffectiveStartup, SettingsTarget } from "@tyrminal/contracts";
import { useCallback, useEffect, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { IconButton } from "../../components/ui/controls";
import { IconChevronUp, IconX } from "../../components/ui/icons";
import { MAX_STARTUP_SNIPPETS } from "../../lib/environment";
import { startup as startupApi } from "../../lib/ipc";
import { msgEnv } from "../../lib/messages-env";

type Mode = "inherit" | "none" | "list";

/**
 * The startup snippets of a host or group (SNP-08), edited in the environment dialog and saved
 * with their own command. `null` inherits the nearest group's list, `[]` runs nothing.
 */
export function useStartup(target: SettingsTarget) {
  const [loaded, setLoaded] = useState<string[] | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>("inherit");
  const [list, setList] = useState<string[]>([]);
  const [effective, setEffective] = useState<EffectiveStartup | null>(null);
  const hostId = target.kind === "host" ? target.hostId : null;

  useEffect(() => {
    let live = true;
    void startupApi.get(target).then(
      (ids) => {
        if (!live) return;
        setLoaded(ids);
        setMode(ids === null ? "inherit" : ids.length === 0 ? "none" : "list");
        setList(ids ?? []);
        setReady(true);
      },
      () => live && setReady(true),
    );
    if (hostId) {
      void startupApi.effective(hostId).then(
        (e) => live && setEffective(e),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
    // The target is fixed for the life of the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = mode === "inherit" ? null : mode === "none" ? [] : list;
  const changed = ready && JSON.stringify(value) !== JSON.stringify(loaded);
  const save = useCallback(async () => {
    if (changed) setLoaded(await startupApi.set(target, value));
  }, [changed, target, value]);

  // What "inherit" currently means for a host: the group the list comes from, if any.
  const inheritedFrom = effective?.origin?.kind === "group" ? effective.origin.name : null;
  /** Undo: puts the choice back to a stored list (the next autosave writes it). */
  const restore = useCallback((ids: string[] | null) => {
    setMode(ids === null ? "inherit" : ids.length === 0 ? "none" : "list");
    setList(ids ?? []);
  }, []);
  return { ready, mode, setMode, list, setList, save, loaded, changed, value, restore, inheritedFrom, valid: mode !== "list" || list.length <= MAX_STARTUP_SNIPPETS };
}

export function StartupSection({ target, state }: { target: SettingsTarget; state: ReturnType<typeof useStartup> }) {
  const { snippets } = useVaultData();
  const all = snippets.value ?? [];
  const nameOf = (id: string) => all.find((s) => s.id === id)?.name ?? null;
  const available = all.filter((s) => !state.list.includes(s.id));
  const radio = `startup-${target.kind}`;
  return (
    <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }} disabled={!state.ready} data-testid="startup-section">
      <legend className="label" style={{ marginBottom: 2 }}>
        {msgEnv.startup}
      </legend>
      <p className="hint">{msgEnv.startupHint}</p>
      <label className="choice">
        <input type="radio" name={radio} checked={state.mode === "inherit"} onChange={() => state.setMode("inherit")} />
        <span className="choice-body">
          <span className="choice-title">{msgEnv.startupInherit}</span>
          <span className="hint">{target.kind === "host" ? msgEnv.startupInheritFrom(state.inheritedFrom) : msgEnv.startupInheritTop}</span>
        </span>
      </label>
      <label className="choice">
        <input type="radio" name={radio} checked={state.mode === "none"} onChange={() => state.setMode("none")} />
        <span className="choice-body">
          <span className="choice-title">{msgEnv.startupNone}</span>
        </span>
      </label>
      <label className="choice">
        <input type="radio" name={radio} checked={state.mode === "list"} onChange={() => state.setMode("list")} />
        <span className="choice-body">
          <span className="choice-title">{msgEnv.startupList}</span>
        </span>
      </label>
      {state.mode === "list" && (
        <div className="stack-xs">
          {state.list.length > 0 && (
            <ol className="startup-list" aria-label={msgEnv.startup}>
              {state.list.map((id, index) => {
                const name = nameOf(id) ?? msgEnv.startupMissing;
                return (
                  <li key={id}>
                    <span>{name}</span>
                    <IconButton
                      size="sm"
                      label={msgEnv.startupUp(name)}
                      disabled={index === 0}
                      onClick={() => state.setList((list) => list.map((x, i) => (i === index - 1 ? id : i === index ? (list[index - 1] ?? x) : x)))}
                    >
                      <IconChevronUp size={14} />
                    </IconButton>
                    <IconButton size="sm" label={msgEnv.startupRemove(name)} onClick={() => state.setList((list) => list.filter((x) => x !== id))}>
                      <IconX size={14} />
                    </IconButton>
                  </li>
                );
              })}
            </ol>
          )}
          {all.length === 0 ? (
            <p className="hint">{msgEnv.noSnippets}</p>
          ) : (
            <select
              className="select"
              aria-label={msgEnv.startupPick}
              value=""
              disabled={state.list.length >= MAX_STARTUP_SNIPPETS || available.length === 0}
              onChange={(event) => {
                const id = event.target.value;
                if (id) state.setList((list) => [...list, id]);
              }}
            >
              <option value="">{state.list.length >= MAX_STARTUP_SNIPPETS ? msgEnv.startupTooMany : msgEnv.startupPick}</option>
              {available.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.folder ? `${s.folder}/${s.name}` : s.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </fieldset>
  );
}
