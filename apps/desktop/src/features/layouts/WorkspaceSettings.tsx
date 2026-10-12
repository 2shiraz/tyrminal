import type { KeyBindingPreference, WorkspacePreferences } from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { usePreferences } from "../../app/preferences";
import { HighlightRules } from "../highlight/HighlightRules";
import { MouseSettings } from "../mouse/MouseSettings";
import { Keys, Switch } from "../../components/ui/controls";
import { IconPencil, IconRefreshCw, IconX } from "../../components/ui/icons";
import { msgC } from "../../lib/messages-c";
import { isMac } from "../../lib/platform";
import {
  type ActionId,
  type Binding,
  bindingFromEvent,
  bindingProblem,
  bindings,
  defaultBindings,
  keyCaps,
  setRecordingShortcut,
  toPreference,
} from "../../lib/shortcuts";

export const WORKSPACE_DEFAULTS: WorkspacePreferences = {
  highlight: { enabled: false, ipAddresses: true, keywords: [] },
  bindings: [],
  optionAsMeta: isMac,
  rightClickSelectsWord: isMac,
  rightClickPaste: false,
  middleClickPaste: false,
};

export function workspacePrefs(value: WorkspacePreferences | undefined): WorkspacePreferences {
  return value ?? WORKSPACE_DEFAULTS;
}

/** Shortcuts, Option/Alt and mouse, and output highlighting (agent C's settings). */
export function WorkspaceSettings() {
  const { prefs, update } = usePreferences();
  const ws = workspacePrefs(prefs.workspace);
  const setWs = (change: (w: WorkspacePreferences) => WorkspacePreferences) =>
    update((p) => ({ ...p, workspace: change(workspacePrefs(p.workspace)) }));

  return (
    <>
      <section id="settings-shortcuts" className="settings-section" aria-labelledby="settings-shortcuts-title">
        <header>
          <h2 id="settings-shortcuts-title">{msgC.keys.title}</h2>
          <p>{msgC.keys.body}</p>
        </header>
        <ShortcutList
          overrides={ws.bindings}
          onChange={(list) => setWs((w) => ({ ...w, bindings: list }))}
        />
        {isMac && (
          <Switch
            label={msgC.keys.optionAsMeta}
            hint={msgC.keys.optionAsMetaHint}
            checked={ws.optionAsMeta}
            onChange={(optionAsMeta) => setWs((w) => ({ ...w, optionAsMeta }))}
          />
        )}
        <MouseSettings ws={ws} onChange={(change) => setWs((w) => ({ ...w, ...change }))} />
      </section>

      <section id="settings-highlight" className="settings-section" aria-labelledby="settings-highlight-title">
        <header>
          <h2 id="settings-highlight-title">{msgC.highlight.title}</h2>
          <p>{msgC.highlight.body}</p>
        </header>
        <Switch
          label={msgC.highlight.enabled}
          checked={ws.highlight.enabled}
          onChange={(enabled) => setWs((w) => ({ ...w, highlight: { ...w.highlight, enabled } }))}
        />
        {ws.highlight.enabled && (
          <>
            <Switch
              label={msgC.highlight.ipAddresses}
              hint={msgC.highlight.ipHint}
              checked={ws.highlight.ipAddresses}
              onChange={(ipAddresses) => setWs((w) => ({ ...w, highlight: { ...w.highlight, ipAddresses } }))}
            />
            <HighlightRules
              words={ws.highlight.keywords}
              onChange={(keywords) => setWs((w) => ({ ...w, highlight: { ...w.highlight, keywords } }))}
            />
            <p className="faint" style={{ fontSize: "var(--text-sm)" }}>
              {msgC.highlight.stored}
            </p>
          </>
        )}
      </section>
    </>
  );
}

function ShortcutList({ overrides, onChange }: { overrides: KeyBindingPreference[]; onChange: (list: KeyBindingPreference[]) => void }) {
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [problem, setProblem] = useState<{ action: ActionId; text: string } | null>(null);
  const actions = Object.keys(defaultBindings) as ActionId[];
  const label = (a: ActionId) => msgC.keys.actions[a] ?? a;

  const set = (action: ActionId, binding: Binding | "default") => {
    const rest = overrides.filter((o) => o.action !== action);
    onChange(binding === "default" ? rest : [...rest, toPreference(action, binding)]);
  };

  useEffect(() => {
    if (!recording) return;
    setRecordingShortcut(true);
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      const candidate = bindingFromEvent(event);
      if (!candidate) return;
      const issue = bindingProblem(recording, candidate);
      if (issue) {
        setProblem({ action: recording, text: issue.kind === "terminal" ? msgC.keys.terminalKey : msgC.keys.conflict(label(issue.other as ActionId)) });
        return;
      }
      setProblem(null);
      set(recording, candidate);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setRecordingShortcut(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  return (
    <div className="stack-xs">
      <ul className="shortcut-list" aria-label={msgC.keys.listLabel}>
        {actions.map((action) => {
          const custom = overrides.some((o) => o.action === action);
          return (
            <li key={action} data-action={action}>
              <span className="shortcut-name">{label(action)}</span>
              <span className="shortcut-keys" aria-live={recording === action ? "polite" : undefined}>
                {recording === action ? (
                  <span className="faint">{msgC.keys.recording}</span>
                ) : (
                  <>
                    <Keys caps={keyCaps(bindings[action])} />
                    <span className="visually-hidden">{bindings[action].key === "" ? msgC.keys.none : keyCaps(bindings[action]).join("+")}</span>
                  </>
                )}
              </span>
              <span className="shortcut-actions">
                <button type="button" className="btn btn-ghost btn-sm" aria-label={msgC.keys.change(label(action))} onClick={() => setRecording(action)}>
                  <IconPencil size={14} />
                </button>
                <button type="button" className="btn btn-ghost btn-sm" aria-label={msgC.keys.remove(label(action))} onClick={() => set(action, { key: "" })}>
                  <IconX size={14} />
                </button>
                {custom && (
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={msgC.keys.reset(label(action))} onClick={() => set(action, "default")}>
                    <IconRefreshCw size={14} />
                  </button>
                )}
              </span>
              {problem?.action === action && (
                <span className="shortcut-problem" role="alert">
                  {problem.text}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {overrides.length > 0 && (
        <div>
          <button type="button" className="btn btn-sm" onClick={() => onChange([])}>
            {msgC.keys.resetAll}
          </button>
        </div>
      )}
    </div>
  );
}
