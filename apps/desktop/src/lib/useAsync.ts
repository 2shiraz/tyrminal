import { useCallback, useEffect, useRef, useState } from "react";

import { type AppError, toAppError } from "./ipc";

/** Runs one async action at a time and tracks its pending/error state. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      if (alive.current) setError(toAppError(caught));
      return undefined;
    } finally {
      if (alive.current) setPending(false);
    }
  }, []);

  return { pending, error, run, clearError: () => setError(null) };
}

/** Loads a value and exposes a reload function. A newer request always wins over an older one. */
export function useLoaded<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const sequence = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const next = await loader.current();
      if (mine === sequence.current) {
        setValue(next);
        setError(null);
      }
    } catch (caught) {
      if (mine === sequence.current) setError(toAppError(caught));
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      sequence.current += 1;
    };
  }, [reload]);

  return { value, error, reload };
}
