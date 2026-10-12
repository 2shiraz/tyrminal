import type { HostConnectionInput, HostSummary, ProxySummary, ProxyType } from "@tyrminal/contracts";
import { useCallback, useEffect, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Notice, SecretField, TextField } from "../../components/ui/controls";
import { tunnels as tunnelsApi } from "../../lib/ipc";
import { msgB } from "../../lib/messages-b";
import { parsePort } from "./rules";

type ProxyChoice = "none" | ProxyType;

interface Loaded {
  jumpHostId: string | null;
  proxy: ProxySummary | null;
}

/**
 * A host's advanced connection settings in the host editor (jump host, proxy). They are saved
 * with their own command: for an existing host before its basics (so a jump-host loop is refused
 * before anything changes), for a new host right after it is created. The proxy password is
 * write-only: an empty field keeps the stored one.
 */
export function useHostAdvanced(hostId: string | null) {
  const [loaded, setLoaded] = useState<Loaded>({ jumpHostId: null, proxy: null });
  const [ready, setReady] = useState(hostId === null);
  const [jumpHostId, setJumpHostId] = useState<string | null>(null);
  const [proxyKind, setProxyKind] = useState<ProxyChoice>("none");
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState("");
  const [proxyUser, setProxyUser] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");

  useEffect(() => {
    if (hostId === null) return;
    let alive = true;
    void tunnelsApi.connection(hostId).then(
      (connection) => {
        if (!alive) return;
        setLoaded({ jumpHostId: connection.jumpHostId, proxy: connection.proxy });
        setJumpHostId(connection.jumpHostId);
        if (connection.proxy) {
          setProxyKind(connection.proxy.kind);
          setProxyHost(connection.proxy.host);
          setProxyPort(String(connection.proxy.port));
          setProxyUser(connection.proxy.username);
        }
        setReady(true);
      },
      () => alive && setReady(true),
    );
    return () => {
      alive = false;
    };
  }, [hostId]);

  const port = parsePort(proxyPort, false);
  const proxyValid = proxyKind === "none" || (proxyHost.trim() !== "" && port !== null);
  const passwordStored = loaded.proxy?.passwordStored === true && loaded.proxy.username === proxyUser.trim();

  const input = useCallback(
    (): HostConnectionInput => ({
      jumpHostId,
      proxy:
        proxyKind === "none"
          ? null
          : {
              kind: proxyKind,
              host: proxyHost,
              port: port ?? 0,
              username: proxyUser,
              password: proxyPassword.length > 0 ? proxyPassword : null,
            },
    }),
    [jumpHostId, proxyKind, proxyHost, port, proxyUser, proxyPassword],
  );

  const changed =
    jumpHostId !== loaded.jumpHostId ||
    proxyPassword.length > 0 ||
    (proxyKind === "none") !== (loaded.proxy === null) ||
    (loaded.proxy !== null &&
      (proxyKind !== loaded.proxy.kind ||
        proxyHost !== loaded.proxy.host ||
        port !== loaded.proxy.port ||
        proxyUser.trim() !== loaded.proxy.username));

  /** Saves the settings for an existing host (before its basics). */
  const saveBefore = useCallback(async () => {
    if (hostId !== null && changed) await tunnelsApi.setConnection(hostId, input());
    setProxyPassword("");
  }, [hostId, changed, input]);
  /** Saves the settings of a host that was just created. */
  const saveAfter = useCallback(
    async (savedId: string) => {
      if (hostId === null && changed) await tunnelsApi.setConnection(savedId, input());
      setProxyPassword("");
    },
    [hostId, changed, input],
  );

  return {
    ready,
    valid: proxyValid,
    changed,
    jumpHostId,
    setJumpHostId,
    proxy: { kind: proxyKind, host: proxyHost, port: proxyPort, user: proxyUser, password: proxyPassword, passwordStored },
    setProxyKind,
    setProxyHost,
    setProxyPort,
    setProxyUser,
    setProxyPassword,
    saveBefore,
    saveAfter,
  };
}

const PROXY_CHOICES: ProxyChoice[] = ["none", "http", "socks5"];

/** `embedded`: the fields only, for a container that brings its own disclosure (the host panel's "Show more"). */
export function HostAdvancedSection({
  host,
  state,
  embedded = false,
}: {
  host: HostSummary | null;
  state: ReturnType<typeof useHostAdvanced>;
  embedded?: boolean;
}) {
  const { hosts } = useVaultData();
  const options = (hosts.value ?? []).filter((h) => h.id !== host?.id);
  const jump = options.find((h) => h.id === state.jumpHostId);
  const p = state.proxy;
  const configured = state.jumpHostId !== null || p.kind !== "none";
  const fields = (
      <div className="stack-sm" style={embedded ? undefined : { paddingTop: "var(--space-3)" }}>
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

        <label className="field">
          <span className="label">{msgB.advanced.proxy}</span>
          <select
            className="select"
            aria-label={msgB.advanced.proxy}
            value={p.kind}
            disabled={!state.ready}
            onChange={(event) => state.setProxyKind(event.target.value as ProxyChoice)}
          >
            {PROXY_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {msgB.advanced.proxyKinds[choice]}
              </option>
            ))}
          </select>
          <span className="hint">{state.jumpHostId !== null ? msgB.advanced.proxyWithJump : msgB.advanced.proxyHint}</span>
        </label>

        {p.kind !== "none" && (
          <>
            <div className="split" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
              <TextField label={msgB.advanced.proxyHost} value={p.host} onChange={state.setProxyHost} maxLength={253} />
              <TextField
                label={msgB.advanced.proxyPort}
                value={p.port}
                onChange={state.setProxyPort}
                inputMode="numeric"
                placeholder={p.kind === "http" ? "3128" : "1080"}
                error={p.port.trim() !== "" && parsePort(p.port, false) === null ? msgB.tunnels.invalidPort : undefined}
                maxLength={5}
              />
            </div>
            <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
              <TextField label={msgB.advanced.proxyUser} value={p.user} onChange={state.setProxyUser} hint={msgB.advanced.proxyUserHint} maxLength={255} />
              {p.user.trim() !== "" && (
                <SecretField
                  label={msgB.advanced.proxyPassword}
                  value={p.password}
                  onChange={state.setProxyPassword}
                  hint={p.passwordStored ? msgB.advanced.proxyPasswordKeep : undefined}
                  maxLength={255}
                />
              )}
            </div>
            {p.kind === "http" && p.user.trim() !== "" && <Notice tone="warning">{msgB.advanced.httpCleartext}</Notice>}
          </>
        )}
      </div>
  );
  if (embedded) return fields;
  return (
    <details className="advanced" open={configured ? true : undefined}>
      <summary>{msgB.advanced.title}</summary>
      {fields}
    </details>
  );
}
