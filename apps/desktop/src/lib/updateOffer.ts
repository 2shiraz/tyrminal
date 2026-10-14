// The newer release an update check found, shared by Settings (which shows and installs it) and
// the status strip (which points to it). Nothing here checks or installs: see lib/ipc `updates`.
import type { UpdateOffer } from "@tyrminal/contracts";
import { useSyncExternalStore } from "react";

let offer: UpdateOffer | null = null;
const listeners = new Set<() => void>();

export function setUpdateOffer(next: UpdateOffer | null): void {
  offer = next;
  for (const listener of listeners) listener();
}

export function useUpdateOffer(): UpdateOffer | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => offer,
  );
}
