// Autosave for record editors (host details, group editor, environment). A change is written
// 400 ms after the last edit, or at once on blur, Enter or close; one write runs at a time, in
// order. Each write can be undone for 10 s (Cmd/Ctrl+Z or "Undo" in the status), which puts the
// previous record back exactly. Secrets never pass through the automatic path: their owners write
// them with an explicit action (`commit`), which also ends undo, since a secret cannot be put back.
import { useCallback, useEffect, useRef, useState } from "react";

import { isMac } from "./platform";
import { msgAutosave } from "./messages-autosave";

export const AUTOSAVE_DELAY_MS = 400;
export const UNDO_WINDOW_MS = 10_000;
/** How long "Saved" stays before it fades out. */
const SAVED_VISIBLE_MS = 2_000;

export type AutosaveState = "idle" | "saving" | "saved" | "undone" | "error";

/**
 * What a save resolves to: `undefined` when nothing needed writing, `null` when something was
 * written that has no previous record to return to (a record created), else a function that puts
 * the previous record back into the form (the following autosave then writes it).
 */
export type SaveResult = (() => void) | null | undefined;

interface UndoEntry {
  restore: () => void;
  at: number;
}

export function useAutosave({
  pending,
  save,
  delay = AUTOSAVE_DELAY_MS,
}: {
  /** A key for what is waiting to be written (never a secret), or `null` when all valid edits are stored. */
  pending: string | null;
  save: () => Promise<SaveResult>;
  delay?: number;
}) {
  const [state, setState] = useState<AutosaveState>("idle");
  const [error, setError] = useState<unknown>(null);
  const [canUndo, setCanUndo] = useState(false);
  // Bumped on every finished save so the "Saved" fade restarts.
  const [tick, setTick] = useState(0);
  const saveRef = useRef(save);
  saveRef.current = save;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedKey = useRef<string | null>(null);
  const undoing = useRef(false);
  const entries = useRef<UndoEntry[]>([]);
  const alive = useRef(true);

  const refreshUndo = useCallback(() => {
    const now = Date.now();
    entries.current = entries.current.filter((e) => now - e.at < UNDO_WINDOW_MS);
    if (alive.current) setCanUndo(entries.current.length > 0);
  }, []);

  /** Runs `task` after every write already queued; resolves to whether it succeeded. */
  const enqueue = useCallback((task: () => Promise<void>) => {
    const run = chain.current.then(task).then(
      () => true,
      (caught: unknown) => {
        if (alive.current) {
          setError(caught);
          setState("error");
        }
        return false;
      },
    );
    chain.current = run;
    return run;
  }, []);

  /** Writes what is waiting now. `asUndo`: the write puts back an earlier record (no new undo step). */
  const flush = useCallback((asUndo = false): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    return enqueue(async () => {
      const key = pendingRef.current;
      if (key === null) return;
      if (alive.current) setState("saving");
      try {
        const result = await saveRef.current();
        failedKey.current = null;
        if (result !== undefined && !asUndo && result !== null) entries.current.push({ restore: result, at: Date.now() });
        refreshUndo();
        if (alive.current) {
          setError(null);
          setState(asUndo ? "undone" : "saved");
          setTick((t) => t + 1);
        }
      } catch (caught) {
        // Not retried on its own: the next edit or "Retry" tries again.
        failedKey.current = key;
        throw caught;
      }
    });
  }, [enqueue, refreshUndo]);

  // Debounce: the last edit starts the clock again. A failed key waits for Retry or a new edit.
  useEffect(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending === null) {
      undoing.current = false;
      return;
    }
    if (pending === failedKey.current) return;
    if (undoing.current) {
      undoing.current = false;
      void flush(true);
      return;
    }
    timer.current = setTimeout(() => void flush(), delay);
  }, [pending, delay, flush]);

  // "Saved" fades, then the status is empty again.
  useEffect(() => {
    if (state !== "saved" && state !== "undone") return;
    const t = setTimeout(() => setState((s) => (s === "saved" || s === "undone" ? "idle" : s)), SAVED_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [state, tick]);

  // Undo expires 10 s after the newest write it would revert.
  useEffect(() => {
    if (!canUndo) return;
    const newest = entries.current.at(-1);
    if (!newest) return;
    const t = setTimeout(refreshUndo, Math.max(0, newest.at + UNDO_WINDOW_MS - Date.now()));
    return () => clearTimeout(t);
  }, [canUndo, tick, refreshUndo]);

  // Closing the editor writes what is still waiting; the write finishes after the form is gone.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pendingRef.current !== null && pendingRef.current !== failedKey.current) void flush();
    };
  }, [flush]);

  const undo = useCallback(() => {
    refreshUndo();
    const entry = entries.current.pop();
    if (!entry) return false;
    setCanUndo(entries.current.length > 0);
    undoing.current = true;
    entry.restore();
    return true;
  }, [refreshUndo]);

  const retry = useCallback(() => {
    failedKey.current = null;
    void flush().then((ok) => {
      if (ok && pendingRef.current === null && alive.current) setState((s) => (s === "error" ? "idle" : s));
    });
  }, [flush]);

  /** An explicit write (a secret, or a change that removes one): queued in order, and it ends undo. */
  const commit = useCallback(
    (task: () => Promise<void>) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (alive.current) setState("saving");
      return enqueue(async () => {
        await task();
        entries.current = [];
        failedKey.current = null;
        if (alive.current) {
          setCanUndo(false);
          setError(null);
          setState("saved");
          setTick((t) => t + 1);
        }
      });
    },
    [enqueue],
  );

  return { state, error, canUndo, undo, retry, flush, commit, tick };
}

export type Autosave = ReturnType<typeof useAutosave>;

/** Cmd+Z on macOS, Ctrl+Z elsewhere (not with Shift: that is redo). */
export function isUndoKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  return event.key.toLowerCase() === "z" && !event.shiftKey && !event.altKey && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

/**
 * Handles Cmd/Ctrl+Z inside an autosaving editor: a text field with an edit not yet written keeps
 * its own undo; otherwise the last autosave is undone.
 */
export function handleUndoKey(event: React.KeyboardEvent, autosave: Autosave, typing: boolean) {
  if (!isUndoKey(event) || event.defaultPrevented) return;
  const target = event.target as HTMLElement;
  const textField = target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !["checkbox", "radio"].includes(target.type));
  if (textField && typing) return;
  // Outside that case the editor owns the shortcut: the browser's own undo would replay an old
  // keystroke in a field that is no longer focused, after the 10 s window too.
  event.preventDefault();
  if (autosave.canUndo) autosave.undo();
}

/** "Saving…", "Saved" (fading), "Couldn't save – Retry", and "Undo" while the last write can be undone. */
export function AutosaveStatus({ autosave, testId }: { autosave: Autosave; testId?: string }) {
  const { state, canUndo, tick } = autosave;
  const text =
    state === "saving" ? msgAutosave.saving : state === "saved" ? msgAutosave.saved : state === "undone" ? msgAutosave.undone : state === "error" ? msgAutosave.failed : "";
  return (
    <div className="autosave-status" data-state={state}>
      <span key={tick} className="autosave-text" role="status" data-testid={testId}>
        {text}
      </span>
      {state === "error" && (
        <button type="button" className="btn btn-ghost btn-sm autosave-action" onClick={autosave.retry}>
          {msgAutosave.retry}
        </button>
      )}
      {canUndo && state !== "error" && state !== "saving" && (
        <button type="button" className="btn btn-ghost btn-sm autosave-action" aria-label={msgAutosave.undoLabel} onClick={autosave.undo}>
          {msgAutosave.undo}
        </button>
      )}
    </div>
  );
}
