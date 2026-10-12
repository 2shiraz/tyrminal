import { useCallback, useSyncExternalStore } from "react";

/**
 * State that outlives the component showing it, kept per key (a session id, or a pane of the
 * SFTP tab). Tabs mount and unmount their side panel; what the user was looking at stays here
 * until the session ends and `forget` drops it. Memory only: nothing is ever saved.
 */
export class KeyedMemory<T> {
  private readonly values = new Map<string, T>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly initial: () => T) {}

  get(key: string): T {
    let value = this.values.get(key);
    if (value === undefined) {
      value = this.initial();
      this.values.set(key, value);
    }
    return value;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  update(key: string, change: (value: T) => T): void {
    this.values.set(key, change(this.get(key)));
    for (const listener of this.listeners) listener();
  }

  /** Drops every key not in `keep` (sessions that ended). */
  retain(keep: ReadonlySet<string>): void {
    let changed = false;
    for (const key of this.values.keys()) {
      if (!keep.has(key)) {
        this.values.delete(key);
        changed = true;
      }
    }
    if (changed) for (const listener of this.listeners) listener();
  }

  forget(key: string): void {
    if (this.values.delete(key)) for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** The remembered value for `key` (or `fallback` without a key) and a way to change it. */
export function useMemory<T>(store: KeyedMemory<T>, key: string | null, fallback: T): [T, (change: (value: T) => T) => void] {
  const value = useSyncExternalStore(store.subscribe, () => (key === null ? fallback : store.get(key)));
  const update = useCallback(
    (change: (value: T) => T) => {
      if (key !== null) store.update(key, change);
    },
    [store, key],
  );
  return [value, update];
}
