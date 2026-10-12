import type { HostSummary } from "@tyrminal/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { tunnels as tunnelsApi } from "../../lib/ipc";
import { msgB } from "../../lib/messages-b";

/**
 * A host's advanced connection settings in the host editor. They are saved with their own
 * command: for an existing host before its basics (so a jump-host loop is refused before
 * anything changes), for a new host right after it is created.
 */
export function useHostAdvanced(hostId: string | null) {
  const [jumpHostId, setJumpHostId] = useState<string | null>(null);
  const loaded = useRef<string | null>(null);
  const [ready, setReady] = useState(hostId === null);

  useEffect(() => {
    if (hostId === null) return;
    let alive = true;
    void tunnelsApi.connection(hostId).then(
      (connection) => {
        if (!alive) return;
        loaded.current = connection.jumpHostId;
        setJumpHostId(connection.jumpHostId);
        setReady(true);
      },
      () => alive && setReady(true),
    );
    return () => {
      alive = false;
    };
  }, [hostId]);

  const changed = jumpHostId !== loaded.current;
  /** Saves the settings for an existing host (before its basics). */
  const saveBefore = useCallback(async () => {
    if (hostId !== null && changed) await tunnelsApi.setConnection(hostId, { jumpHostId });
  }, [hostId, changed, jumpHostId]);
  /** Saves the settings of a host that was just created. */
  const saveAfter = useCallback(
    async (savedId: string) => {
      if (hostId === null && jumpHostId !== null) await tunnelsApi.setConnection(savedId, { jumpHostId });
    },
    [hostId, jumpHostId],
  );
  return { jumpHostId, setJumpHostId, ready, saveBefore, saveAfter };
}

export function HostAdvancedSection({
  host,
  state,
}: {
  host: HostSummary | null;
  state: ReturnType<typeof useHostAdvanced>;
}) {
  const { hosts } = useVaultData();
  const options = (hosts.value ?? []).filter((h) => h.id !== host?.id);
  const jump = options.find((h) => h.id === state.jumpHostId);
  return (
    <details className="advanced" open={state.jumpHostId !== null ? true : undefined}>
      <summary>{msgB.advanced.title}</summary>
      <div className="stack-sm" style={{ paddingTop: "var(--space-3)" }}>
        <label className="field">
          <span className="label">{msgB.advanced.jumpHost}</span>
          <select
            className="select"
            aria-label={msgB.advanced.jumpHost}
            value={state.jumpHostId ?? ""}
            disabled={!state.ready}
            onChange={(event) => state.setJumpHostId(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">{msgB.advanced.direct}</option>
            {options.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
            {state.jumpHostId !== null && !jump && <option value={state.jumpHostId}>{msgB.advanced.missingJump}</option>}
          </select>
          <span className="hint">{jump ? msgB.advanced.via(jump.label) : msgB.advanced.jumpHint}</span>
        </label>
      </div>
    </details>
  );
}
