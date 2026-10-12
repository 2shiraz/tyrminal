import type { RemoteListing, SnippetSummary } from "@tyrminal/contracts";
import { type KeyboardEvent, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useVaultData } from "../../app/vaultData";
import { Dialog } from "../../components/ui/Dialog";
import { IconFile, IconFolder, IconScrollText, IconSearch, IconSlidersHorizontal, IconSquareTerminal } from "../../components/ui/icons";
import { environment, files } from "../../lib/ipc";
import { msgD } from "../../lib/messages-d";
import { pause } from "./pause";
import { shellContexts } from "./shellContext";
import { type PathSuggestion, isPathQuery, matchCommands, matchPaths, matchSnippets, splitPathQuery } from "./suggest";

type Item =
  | { kind: "snippet"; key: string; snippet: SnippetSummary }
  | { kind: "command"; key: string; name: string; description: string }
  | { kind: "path"; key: string; path: PathSuggestion }
  | { kind: "variable"; key: string; name: string };

const lines = (text: string) => text.replace(/\n$/, "").split("\n").length;

/**
 * Suggestions for the focused SSH terminal (AUT-02/03/04/12): saved snippets, built-in commands
 * and the server's files. A choice is inserted on the command line, never run; a multi-line
 * snippet goes to the snippet review instead of being typed.
 */
export function SuggestDialog({
  sessionId,
  hostId,
  onInsert,
  onSnippet,
  onIntegration,
  onClose,
}: {
  sessionId: string;
  /** The session's saved host, whose environment variables are offered after `$`. */
  hostId: string | null;
  onInsert: (text: string) => void;
  onSnippet: (snippet: SnippetSummary) => void;
  /** Opens the shell integration setup for this session. */
  onIntegration: () => void;
  onClose: () => void;
}) {
  const { snippets } = useVaultData();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [home, setHome] = useState<string | null>(null);
  const [listing, setListing] = useState<{ dir: string; result: RemoteListing | null } | null>(null);
  const [pausedState, setPausedState] = useState(() => pause.state(sessionId));
  // Names of the host's environment variables (SNP-14); values are not loaded here.
  const [variables, setVariables] = useState<string[]>([]);
  useEffect(() => {
    if (!hostId) return;
    let live = true;
    environment
      .effective(hostId)
      .then((list) => live && setVariables(list.map((v) => v.name)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [hostId]);
  // With shell integration, the shell's own folder anchors relative paths (AUT-06).
  const context = useSyncExternalStore(shellContexts.subscribe, () => shellContexts.get(sessionId));
  const cwd = context?.cwd ?? null;

  // The login folder anchors ~ and relative paths.
  useEffect(() => {
    let live = true;
    files
      .list(sessionId, null)
      .then((l) => live && setHome(l.path))
      .catch(() => live && setHome(null));
    return () => {
      live = false;
    };
  }, [sessionId]);

  const pathQuery = isPathQuery(query) && home !== null ? splitPathQuery(query, home, cwd ?? home) : null;
  useEffect(() => {
    if (!pathQuery) return;
    const dir = pathQuery.dir;
    if (listing?.dir === dir) return;
    let live = true;
    const timer = window.setTimeout(() => {
      files
        .list(sessionId, dir)
        .then((result) => live && setListing({ dir, result }))
        .catch(() => live && setListing({ dir, result: null }));
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [pathQuery?.dir, sessionId, listing?.dir]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (query.startsWith("$")) {
      const prefix = query.slice(1).replace(/^\{/, "").toLowerCase();
      for (const name of variables.filter((n) => n.toLowerCase().startsWith(prefix))) out.push({ kind: "variable", key: `v:${name}`, name });
    }
    if (pathQuery && listing?.dir === pathQuery.dir && listing.result) {
      for (const p of matchPaths(pathQuery.shown, pathQuery.prefix, listing.result.entries)) out.push({ kind: "path", key: `p:${p.label}`, path: p });
    }
    for (const c of matchCommands(query)) out.push({ kind: "command", key: `c:${c.name}`, ...c });
    for (const s of matchSnippets(query, snippets.value ?? [])) out.push({ kind: "snippet", key: `s:${s.id}`, snippet: s });
    return out;
  }, [query, snippets.value, pathQuery?.dir, pathQuery?.prefix, pathQuery?.shown, listing, variables]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === "snippet") {
      if (lines(item.snippet.text) > 1) onSnippet(item.snippet);
      else onInsert(item.snippet.text.replace(/\n$/, ""));
    } else if (item.kind === "command") onInsert(`${item.name} `);
    else if (item.kind === "variable") onInsert(`"$${item.name}"`);
    else if (!item.path.unsafe) onInsert(item.path.insert);
  };

  function onKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(items[active]);
    }
  }

  if (pausedState) {
    return (
      <Dialog title={msgD.suggest.paused} icon={<IconSearch size={18} />} onDismiss={onClose}>
        <p className="muted">{pausedState === "session" ? msgD.suggest.pausedSession : msgD.suggest.pausedAll}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msgD.runs.done}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-autofocus
            onClick={() => {
              pause.resume(sessionId);
              setPausedState(null);
            }}
          >
            {msgD.suggest.resume}
          </button>
        </div>
      </Dialog>
    );
  }

  const groups: [string, Item["kind"]][] = [
    [msgD.env.suggestions, "variable"],
    [msgD.suggest.paths, "path"],
    [msgD.suggest.commands, "command"],
    [msgD.suggest.snippets, "snippet"],
  ];
  return (
    <Dialog title={msgD.suggest.title} icon={<IconSearch size={18} />} wide onDismiss={onClose}>
      <div className="stack">
        {context && (cwd || context.command) && (
          <div className="suggest-context faint" data-testid="shell-context" aria-label={msgD.suggest.context}>
            {cwd && (
              <span>
                {msgD.suggest.folder}: <span className="mono">{cwd}</span>
              </span>
            )}
            {context.command && (
              <span>
                {msgD.suggest.lastCommand}: <span className="mono">{context.command}</span>
                {context.exitStatus !== null && ` (${msgD.suggest.exit(context.exitStatus)})`}
              </span>
            )}
          </div>
        )}
        <div className="input-with-icon">
          <IconSearch size={15} />
          <input
            className="input"
            aria-label={msgD.suggest.input}
            placeholder={msgD.suggest.input}
            value={query}
            data-autofocus
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        {pathQuery && listing?.dir === pathQuery.dir && listing.result === null && <p className="hint">{msgD.suggest.pathsUnavailable}</p>}
        {items.length === 0 && <p className="muted">{msgD.suggest.none}</p>}
        <div role="listbox" aria-label={msgD.suggest.title} className="suggest-list" data-testid="suggestions">
          {groups.map(([title, kind]) => {
            const group = items.filter((i) => i.kind === kind);
            if (group.length === 0) return null;
            return (
              <div key={kind} role="group" aria-label={title}>
                <div className="suggest-group">{title}</div>
                {group.map((item) => {
                  const index = items.indexOf(item);
                  const unsafe = item.kind === "path" && item.path.unsafe;
                  return (
                    <div
                      key={item.key}
                      role="option"
                      aria-selected={index === active}
                      aria-disabled={unsafe || undefined}
                      className="suggest-item"
                      data-kind={item.kind}
                      onMouseMove={() => index !== active && setActive(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(item)}
                    >
                      {item.kind === "snippet" && (
                        <>
                          <IconScrollText size={14} />
                          <span className="truncate">{item.snippet.name}</span>
                          <span className="faint mono truncate">
                            {lines(item.snippet.text) > 1 ? msgD.suggest.multiline(lines(item.snippet.text)) : item.snippet.text}
                          </span>
                        </>
                      )}
                      {item.kind === "variable" && (
                        <>
                          <IconSlidersHorizontal size={14} />
                          <span className="mono">${item.name}</span>
                        </>
                      )}
                      {item.kind === "command" && (
                        <>
                          <IconSquareTerminal size={14} />
                          <span className="mono">{item.name}</span>
                          <span className="faint truncate">{item.description}</span>
                        </>
                      )}
                      {item.kind === "path" && (
                        <>
                          {item.path.dir ? <IconFolder size={14} /> : <IconFile size={14} />}
                          {/* Remote names are shown as text; control characters are escaped for display. */}
                          <span className="mono truncate">{JSON.stringify(item.path.label).slice(1, -1)}</span>
                          {unsafe && <span className="faint">{msgD.suggest.unsafeName}</span>}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {pathQuery && <p className="hint">{cwd ? msgD.suggest.pathsFromFolder(cwd) : msgD.suggest.pathsNote}</p>}
        <p className="hint">{msgD.suggest.hint}</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-sm" onClick={onIntegration}>
            {msgD.suggest.integration}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              pause.session(sessionId);
              onClose();
            }}
          >
            {msgD.suggest.pauseSession}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              pause.all(15);
              onClose();
            }}
          >
            {msgD.suggest.pauseAll}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
