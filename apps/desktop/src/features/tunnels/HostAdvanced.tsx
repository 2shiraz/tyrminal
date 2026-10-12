import type { HostConnectionInput, HostSummary, InheritedRoute, ProxySummary, ProxyType } from "@tyrminal/contracts";
import { useCallback, useEffect, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Notice, SecretField, TextField } from "../../components/ui/controls";
import { groupDefaults as groupDefaultsApi, tunnels as tunnelsApi } from "../../lib/ipc";
import { msgB } from "../../lib/messages-b";
import { msgAutosave } from "../../lib/messages-autosave";
import { msgDefaults } from "../../lib/messages-defaults";
import { validAddress } from "../hosts/fieldRules";
import { DropSecretNotice, type LiveProxySecret, LiveSecretField } from "../hosts/LiveSecret";
import { parsePort } from "./rules";

type ProxyChoice = "none" | ProxyType;

export interface Loaded {
  jumpHostId: string | null;
  proxy: ProxySummary | null;
  /** HST-05: the host uses its group's route instead of its own. */
  inherit: boolean;
}

/**
 * A host's advanced connection settings in the host editor (jump host, proxy). They are saved
 * with their own command: for an existing host before its basics (so a jump-host loop is refused
 * before anything changes), for a new host right after it is created. The proxy password is
 * write-only: an empty field keeps the stored one. When the host's group (`groupId`, as chosen in
 * the editor) has a route, the host can use it instead of its own (HST-05).
 */
export function useHostAdvanced(hostId: string | null, groupId: string | null = null) {
  const [loaded, setLoaded] = useState<Loaded>({ jumpHostId: null, proxy: null, inherit: true });
  const [inherit, setInherit] = useState(true);
  const [groupRoute, setGroupRoute] = useState<InheritedRoute | null>(null);
  const { groups } = useVaultData();
  const groupName = (groups.value ?? []).find((g) => g.id === groupId)?.name ?? "";
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
        setLoaded({ jumpHostId: connection.jumpHostId, proxy: connection.proxy, inherit: !connection.own });
        setInherit(!connection.own);
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

  // The route the chosen group would give this host: the group's own, else its parents'.
  useEffect(() => {
    if (groupId === null) {
      setGroupRoute(null);
      return;
    }
    let alive = true;
    void groupDefaultsApi.get(groupId).then(
      (d) => {
        if (!alive) return;
        const own = d.jumpHostId !== null || d.proxy !== null;
        setGroupRoute(own ? { jumpHostId: d.jumpHostId, proxy: d.proxy, origin: { kind: "group", groupId, name: groupName } } : d.inheritedRoute);
      },
      () => alive && setGroupRoute(null),
    );
    return () => {
      alive = false;
    };
  }, [groupId, groupName]);

  const port = parsePort(proxyPort, false);
  const usesGroup = inherit && groupRoute !== null;
  const proxyValid = usesGroup || proxyKind === "none" || (validAddress(proxyHost) && port !== null);
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
      inherit: usesGroup,
    }),
    [jumpHostId, proxyKind, proxyHost, port, proxyUser, proxyPassword, usesGroup],
  );

  /** The route differs from the stored one (a typed proxy password aside). */
  const routeChanged =
    usesGroup !== (loaded.inherit && groupRoute !== null) ||
    (!usesGroup &&
      (jumpHostId !== loaded.jumpHostId ||
        (proxyKind === "none") !== (loaded.proxy === null) ||
        (loaded.proxy !== null &&
          (proxyKind !== loaded.proxy.kind || proxyHost !== loaded.proxy.host || port !== loaded.proxy.port || proxyUser.trim() !== loaded.proxy.username))));
  const changed = routeChanged || (!usesGroup && proxyPassword.length > 0);
  /** Saving the route as it stands would drop the stored proxy password (the core keeps it only for the same proxy user). */
  const dropsPassword =
    loaded.proxy?.passwordStored === true &&
    (usesGroup || proxyKind === "none" || proxyUser.trim() !== loaded.proxy.username);

  /** Autosave: the route was written as `written` (with a proxy password when `withPassword`). */
  const markStored = useCallback(
    (written: HostConnectionInput, withPassword: boolean) => {
      setLoaded((before) => {
        const keep = before.proxy?.passwordStored === true && written.proxy !== null && !written.inherit && before.proxy.username === written.proxy.username.trim();
        return {
          jumpHostId: written.inherit ? null : written.jumpHostId,
          inherit: written.inherit,
          proxy:
            written.inherit || written.proxy === null
              ? null
              : {
                  kind: written.proxy.kind,
                  host: written.proxy.host,
                  port: written.proxy.port,
                  username: written.proxy.username.trim(),
                  passwordStored: written.proxy.username.trim() !== "" && (withPassword || keep),
                },
        };
      });
      if (withPassword) setProxyPassword("");
    },
    [],
  );
  /** Undo: puts the fields back to a stored route (the next autosave writes it). */
  const restore = useCallback((route: Loaded) => {
    setInherit(route.inherit);
    setJumpHostId(route.jumpHostId);
    setProxyKind(route.proxy?.kind ?? "none");
    setProxyHost(route.proxy?.host ?? "");
    setProxyPort(route.proxy ? String(route.proxy.port) : "");
    setProxyUser(route.proxy?.username ?? "");
  }, []);

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
    routeChanged,
    dropsPassword,
    loaded,
    input,
    markStored,
    restore,
    proxyHostInvalid: !usesGroup && proxyKind !== "none" && !validAddress(proxyHost),
    inherit: usesGroup,
    setInherit,
    groupRoute,
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

/** A route in words: "through bastion", "SOCKS5 proxy p.example", "directly". */
export function routeSummary(route: { jumpHostId: string | null; proxy: ProxySummary | null }, labelOf: (id: string) => string): string {
  const parts: string[] = [];
  if (route.jumpHostId) parts.push(msgDefaults.routeVia(labelOf(route.jumpHostId)));
  if (route.proxy) parts.push(msgDefaults.routeProxy(msgB.advanced.proxyKinds[route.proxy.kind], route.proxy.host));
  return parts.length > 0 ? parts.join(", ") : msgDefaults.routeDirect;
}

/** `embedded`: the fields only, for a container that brings its own disclosure (the host panel's "Show more"). */
export function HostAdvancedSection({
  host,
  state,
  embedded = false,
  live,
}: {
  host: HostSummary | null;
  state: ReturnType<typeof useHostAdvanced>;
  embedded?: boolean;
  /** Autosaving editors: the proxy password is set on its own, and a change that drops it waits for a decision. */
  live?: LiveProxySecret | undefined;
}) {
  const { hosts } = useVaultData();
  const options = (hosts.value ?? []).filter((h) => h.id !== host?.id);
  const jump = options.find((h) => h.id === state.jumpHostId);
  const p = state.proxy;
  const configured = state.jumpHostId !== null || p.kind !== "none" || state.groupRoute !== null;
  const labelOf = (id: string) => (hosts.value ?? []).find((h) => h.id === id)?.label ?? msgB.advanced.missingJump;
  const route = state.groupRoute;
  const fields = (
      <div className="stack-sm" style={embedded ? undefined : { paddingTop: "var(--space-3)" }}>
        {/* HST-05: the group's route, or one of this host's own. */}
        {route && (
          <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }} disabled={!state.ready}>
            <label className="choice">
              <input type="radio" name="route" checked={state.inherit} onChange={() => state.setInherit(true)} />
              <span className="choice-body">
                <span className="choice-title">{msgDefaults.routeInherit}</span>
                <span className="hint" data-testid="route-inherited">
                  {msgDefaults.routeInheritFrom(route.origin.kind === "group" ? route.origin.name : "", routeSummary(route, labelOf))}
                </span>
              </span>
            </label>
            <label className="choice">
              <input type="radio" name="route" checked={!state.inherit} onChange={() => state.setInherit(false)} />
              <span className="choice-body">
                <span className="choice-title">{msgDefaults.routeOwn}</span>
              </span>
            </label>
          </fieldset>
        )}
        {!state.inherit && (
          <>
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
              <TextField
                label={msgB.advanced.proxyHost}
                value={p.host}
                onChange={state.setProxyHost}
                maxLength={253}
                error={live && state.proxyHostInvalid && state.routeChanged ? msgAutosave.proxyHost : undefined}
              />
              <TextField
                label={msgB.advanced.proxyPort}
                value={p.port}
                onChange={state.setProxyPort}
                inputMode="numeric"
                placeholder={p.kind === "http" ? "3128" : "1080"}
                error={(p.port.trim() !== "" || (live && state.routeChanged)) && parsePort(p.port, false) === null ? msgB.tunnels.invalidPort : undefined}
                maxLength={5}
              />
            </div>
            <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
              <TextField label={msgB.advanced.proxyUser} value={p.user} onChange={state.setProxyUser} hint={msgB.advanced.proxyUserHint} maxLength={255} />
              {p.user.trim() !== "" &&
                (live ? (
                  <LiveSecretField
                    label={msgB.advanced.proxyPassword}
                    value={p.password}
                    onChange={state.setProxyPassword}
                    stored={p.passwordStored}
                    maxLength={255}
                    canSet={live.canSet}
                    onSet={live.set}
                    setLabel={msgAutosave.setProxyPassword}
                  />
                ) : (
                  <SecretField
                    label={msgB.advanced.proxyPassword}
                    value={p.password}
                    onChange={state.setProxyPassword}
                    hint={p.passwordStored ? msgB.advanced.proxyPasswordKeep : undefined}
                    maxLength={255}
                  />
                ))}
            </div>
            {p.kind === "http" && p.user.trim() !== "" && <Notice tone="warning">{msgB.advanced.httpCleartext}</Notice>}
          </>
        )}
          </>
        )}
        {live && state.routeChanged && !state.valid && <p className="hint">{msgAutosave.routeHeld}</p>}
        {live && state.routeChanged && state.valid && state.dropsPassword && (
          <DropSecretNotice text={msgAutosave.removesProxyPassword} action={msgAutosave.removeProxyPassword} onRemove={live.remove} />
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
