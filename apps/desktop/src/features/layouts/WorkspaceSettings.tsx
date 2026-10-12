import type { KeyBindingPreference, WorkspacePreferences } from "@tyrminal/contracts";
import { useEffect, useRef, useState } from "react";

import { usePreferences } from "../../app/preferences";
import { BuiltinKinds } from "../highlight/BuiltinKinds";
import { HighlightRules } from "../highlight/HighlightRules";
import { MouseSettings } from "../mouse/MouseSettings";
import { Keys, Switch } from "../../components/ui/controls";
import { IconPencil, IconRefreshCw, IconX } from "../../components/ui/icons";
import { msgC } from "../../lib/messages-c";
import { isMac, keyLabels } from "../../lib/platform";
import {
  type ActionId,
  type Binding,
  bindingFromEvent,
  bindingProblem,
  bindings,
  defaultBindings,
  isUnbound,
  keyCaps,
  sameBinding,
  setRecordingShortcut,
  toPreference,
} from "../../lib/shortcuts";

export const WORKSPACE_DEFAULTS: WorkspacePreferences = {
  // On by default, every kind included (TRM-07): only plain output is ever recolored.
  highlight: {
    enabled: true,
    ipAddresses: true,
    keywords: [],
    numbers: true,
    urls: true,
    macAddresses: true,
    dates: true,
    quoted: true,
    paths: true,
    hex: true,
    levels: true,
  },
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
        {isMac ? (
          <Switch
            label={msgC.keys.optionAsMeta}
            hint={msgC.keys.optionAsMetaHint}
            checked={ws.optionAsMeta}
            onChange={(optionAsMeta) => setWs((w) => ({ ...w, optionAsMeta }))}
          />
        ) : (
          <p className="faint" style={{ fontSize: "var(--text-sm)" }}>
            {msgC.keys.altAsMeta}
          </p>
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
            <BuiltinKinds highlight={ws.highlight} onChange={(change) => setWs((w) => ({ ...w, highlight: { ...w.highlight, ...change } }))} />
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

// Every action has a group; one added later without a group is listed under "Other".
const GROUPS: [group: string, actions: ActionId[]][] = [
  [
    "tabs",
    [
      "newLocal",
      "closePane",
      "nextTab",
      "prevTab",
      "goToTab1",
      "goToTab2",
      "goToTab3",
      "goToTab4",
      "goToTab5",
      "goToTab6",
      "goToTab7",
      "goToTab8",
      "goToLastTab",
      "reopenClosedTab",
      "renameTab",
      "splitRight",
      "splitDown",
      "focusLeft",
      "focusRight",
      "focusUp",
      "focusDown",
      "nextPane",
      "prevPane",
      "toggleFocusLayout",
      "movePaneLeft",
      "movePaneRight",
      "movePaneUp",
      "movePaneDown",
    ],
  ],
  ["terminal", ["find", "searchSessions", "copy", "paste", "zoomIn", "zoomOut", "zoomReset", "suggest", "previousCommand", "nextCommand", "insertPassword"]],
  ["files", ["toggleFiles"]],
  ["snippets", ["toggleSnippets"]],
  ["navigation", ["palette", "toggleSidebar", "focusTerminal", "focusSidebar", "settings", "lock"]],
];

function grouped(actions: ActionId[]): [string, ActionId[]][] {
  const known = new Set(GROUPS.flatMap(([, a]) => a));
  const rest = actions.filter((a) => !known.has(a));
  const groups = GROUPS.map(([g, list]) => [g, list.filter((a) => actions.includes(a))] as [string, ActionId[]]);
  return rest.length > 0 ? [...groups, ["other", rest]] : groups;
}

/** The overrides with `action` set to `binding` (an override equal to the default is dropped). */
function assign(list: KeyBindingPreference[], action: ActionId, binding: Binding): KeyBindingPreference[] {
  const rest = list.filter((o) => o.action !== action);
  return sameBinding(binding, defaultBindings[action]) ? rest : [...rest, toPreference(action, binding)];
}

// Asked from the command palette: the section scrolls into view and its search takes focus.
let showRequested = false;
export function requestShortcutsSection(): void {
  showRequested = true;
}

function ShortcutList({ overrides, onChange }: { overrides: KeyBindingPreference[]; onChange: (list: KeyBindingPreference[]) => void }) {
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [problem, setProblem] = useState<{ action: ActionId; text: string; swap?: { other: ActionId; candidate: Binding } } | null>(null);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const actions = Object.keys(defaultBindings) as ActionId[];
  const label = (a: ActionId) => msgC.keys.actions[a] ?? a;
  const capsText = (b: Binding) => (isUnbound(b) ? msgC.keys.none : `${keyCaps(b).join(" ")} ${keyCaps(b).join("+")}`);

  useEffect(() => {
    if (!showRequested) return;
    showRequested = false;
    document.getElementById("settings-shortcuts")?.scrollIntoView({ block: "start" });
    search.current?.focus();
  }, []);

  const set = (action: ActionId, binding: Binding | "default") =>
    onChange(binding === "default" ? overrides.filter((o) => o.action !== action) : assign(overrides, action, binding));

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
      if (issue?.kind === "conflict") {
        // Offer to swap: this action takes the chord, the other one takes this action's current one.
        setProblem({ action: recording, text: msgC.keys.conflict(label(issue.other)), swap: { other: issue.other, candidate } });
        setRecording(null);
        return;
      }
      if (issue) {
        const text =
          issue.kind === "terminal"
            ? msgC.keys.terminalKey
            : issue.kind === "key"
              ? msgC.keys.keyNotBindable
              : msgC.keys.reserved(msgC.keys.reasons[issue.reason] ?? issue.reason);
        setProblem({ action: recording, text });
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

  const swap = (action: ActionId, other: ActionId, candidate: Binding) => {
    onChange(assign(assign(overrides, action, candidate), other, bindings[action]));
    setProblem(null);
  };

  const q = query.trim().toLowerCase();
  const tabNumbersVisible = !q || msgC.keys.tabNumbers.toLowerCase().includes(q);
  const visible = (a: ActionId) => !q || label(a).toLowerCase().includes(q) || capsText(bindings[a]).toLowerCase().includes(q);
  const groups = grouped(actions)
    .map(([g, list]) => [g, list.filter(visible)] as [string, ActionId[]])
    .filter(([g, list]) => list.length > 0 || (g === "tabs" && tabNumbersVisible));


  return (
    <div className="stack-xs">
      <input
        ref={search}
        className="input"
        type="search"
        aria-label={msgC.keys.search}
        placeholder={msgC.keys.search}
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div aria-label={msgC.keys.listLabel} role="group">
        {groups.length === 0 && !tabNumbersVisible && <p className="faint">{msgC.keys.noMatch}</p>}
        {groups.map(([group, list]) => (
          <section key={group} className="shortcut-group" aria-labelledby={`shortcut-group-${group}`}>
            <h3 id={`shortcut-group-${group}`}>{msgC.keys.groups[group] ?? group}</h3>
            <ul className="shortcut-list" aria-labelledby={`shortcut-group-${group}`}>
              {list.map((action) => {
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
                          <span className="visually-hidden">{isUnbound(bindings[action]) ? msgC.keys.none : keyCaps(bindings[action]).join("+")}</span>
                        </>
                      )}
                    </span>
                    <span className="shortcut-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={msgC.keys.change(label(action))}
                        onClick={() => {
                          setProblem(null);
                          setRecording(action);
                        }}
                      >
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
                        {problem.swap && (
                          <span className="row-flex" style={{ gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
                            <button type="button" className="btn btn-sm" onClick={() => problem.swap && swap(action, problem.swap.other, problem.swap.candidate)}>
                              {msgC.keys.swap(label(problem.swap.other))}
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setProblem(null)}>
                              {msgC.keys.cancel}
                            </button>
                          </span>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
              {group === "tabs" && tabNumbersVisible && (
                <li data-action="tabNumber">
                  <span className="shortcut-name">{msgC.keys.tabNumbers}</span>
                  <span className="shortcut-keys">
                    <Keys caps={[isMac ? keyLabels.mod : keyLabels.alt, "1–9"]} />
                  </span>
                  <span className="shortcut-actions faint">{msgC.keys.fixed}</span>
                </li>
              )}
            </ul>
          </section>
        ))}
      </div>
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
