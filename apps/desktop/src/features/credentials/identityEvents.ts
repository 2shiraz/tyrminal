// Notifies views that show identities (hosts, keychain) that identities or their uses changed.
// In-page only: the native side sends no change events for vault records.
const listeners = new Set<() => void>();

export const identityEvents = {
  changed: () => {
    for (const fn of listeners) fn();
  },
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
