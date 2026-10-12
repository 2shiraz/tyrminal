import type { HostOs } from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { appearance as appearanceApi } from "../../lib/ipc";

/**
 * Each saved host's OS (its own setting or its group's), for the OS icons in the host picker and
 * the location tabs. Loaded when `hosts` changes; an empty map until it arrives or if it fails.
 */
export function useHostOs(hosts: unknown): Map<string, HostOs> {
  const [osOf, setOsOf] = useState<Map<string, HostOs>>(new Map());
  useEffect(() => {
    let live = true;
    appearanceApi
      .list()
      .then((list) => live && setOsOf(new Map(list.map((a) => [a.hostId, a.os]))))
      .catch(() => live && setOsOf(new Map()));
    return () => {
      live = false;
    };
  }, [hosts]);
  return osOf;
}
