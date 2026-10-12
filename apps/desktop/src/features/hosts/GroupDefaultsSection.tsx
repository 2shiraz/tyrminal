import type { GroupDefaults, GroupDefaultsInput, HostOs, ProxyType } from "@tyrminal/contracts";
import { useCallback, useEffect, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Notice, SecretField, TextField } from "../../components/ui/controls";
import { groupDefaults as groupDefaultsApi } from "../../lib/ipc";
import { msgB } from "../../lib/messages-b";
import { osNames } from "../../lib/messages-d";
import { msgAutosave } from "../../lib/messages-autosave";
import { msgDefaults } from "../../lib/messages-defaults";
import { routeSummary } from "../tunnels/HostAdvanced";
import { parsePort } from "../tunnels/rules";
import { validAddress } from "./fieldRules";
import { DropSecretNotice, type LiveProxySecret, LiveSecretField } from "./LiveSecret";

type ProxyChoice = "none" | ProxyType;
const PROXY_CHOICES: ProxyChoice[] = ["none", "http", "socks5"];

/**
 * A group's defaults for its hosts' route (jump host and proxy) and icon (HST-05), edited in the
 * group editor and saved with their own command: for an existing group before its basics (a
 * route that would make a loop is refused before anything changes), for a new group right after
 * it is created. The proxy password is write-only.
 */
export function useGroupDefaults(groupId: string | null) {
  const [loaded, setLoaded] = useState<GroupDefaults | null>(null);
  const [ready, setReady] = useState(groupId === null);
  const [jumpHostId, setJumpHostId] = useState<string | null>(null);
  const [proxyKind, setProxyKind] = useState<ProxyChoice>("none");
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState("");
  const [proxyUser, setProxyUser] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [os, setOs] = useState<HostOs | null>(null);

  useEffect(() => {
    if (groupId === null) return;
    let alive = true;
    void groupDefaultsApi.get(groupId).then(
      (d) => {
        if (!alive) return;
        setLoaded(d);
        setJumpHostId(d.jumpHostId);
        setOs(d.os);
        if (d.proxy) {
          setProxyKind(d.proxy.kind);
          setProxyHost(d.proxy.host);
          setProxyPort(String(d.proxy.port));
          setProxyUser(d.proxy.username);
        }
        setReady(true);
      },
      () => alive && setReady(true),
    );
    return () => {
      alive = false;
    };
  }, [groupId]);

  const port = parsePort(proxyPort, false);
  const valid = proxyKind === "none" || (validAddress(proxyHost) && port !== null);
  const input = useCallback(
    (): GroupDefaultsInput => ({
      jumpHostId,
      os,
      proxy:
        proxyKind === "none"
          ? null
          : { kind: proxyKind, host: proxyHost, port: port ?? 0, username: proxyUser, password: proxyPassword.length > 0 ? proxyPassword : null },
    }),
    [jumpHostId, os, proxyKind, proxyHost, port, proxyUser, proxyPassword],
  );
  const lp = loaded?.proxy ?? null;
  /** The route (jump host and proxy) differs from the stored one, a typed proxy password aside. */
  const routeChanged =
    jumpHostId !== (loaded?.jumpHostId ?? null) ||
    (proxyKind === "none") !== (lp === null) ||
    (lp !== null && (proxyKind !== lp.kind || proxyHost !== lp.host || port !== lp.port || proxyUser.trim() !== lp.username));
  const osChanged = os !== (loaded?.os ?? null);
  const changed = routeChanged || osChanged || proxyPassword.length > 0;
  /** Saving the route as it stands would drop the stored proxy password. */
  const dropsPassword = lp?.passwordStored === true && (proxyKind === "none" || proxyUser.trim() !== lp.username);
  /**
   * Autosave: the defaults to write, with this editor's route only when `route` (else the stored
   * one, whose proxy password the core keeps), and a proxy password only when one is being set.
   */
  const inputFor = useCallback(
    (route: boolean, password?: string): GroupDefaultsInput => {
      if (!route) {
        return {
          os,
          jumpHostId: loaded?.jumpHostId ?? null,
          proxy: lp === null ? null : { kind: lp.kind, host: lp.host, port: lp.port, username: lp.username, password: null },
        };
      }
      return {
        jumpHostId,
        os,
        proxy: proxyKind === "none" ? null : { kind: proxyKind, host: proxyHost, port: port ?? 0, username: proxyUser, password: password ?? null },
      };
    },
    [os, loaded, lp, jumpHostId, proxyKind, proxyHost, port, proxyUser],
  );
  /** Undo: puts the fields back to stored defaults (the next autosave writes them). */
  const restore = useCallback((d: GroupDefaults | null) => {
    setJumpHostId(d?.jumpHostId ?? null);
    setOs(d?.os ?? null);
    setProxyKind(d?.proxy?.kind ?? "none");
    setProxyHost(d?.proxy?.host ?? "");
    setProxyPort(d?.proxy ? String(d.proxy.port) : "");
    setProxyUser(d?.proxy?.username ?? "");
  }, []);

  const saveBefore = useCallback(async () => {
    if (groupId !== null && changed) setLoaded(await groupDefaultsApi.set(groupId, input()));
    setProxyPassword("");
  }, [groupId, changed, input]);
  const saveAfter = useCallback(
    async (savedId: string) => {
      if (groupId === null && changed) await groupDefaultsApi.set(savedId, input());
      setProxyPassword("");
    },
    [groupId, changed, input],
  );

  return {
    ready,
    valid,
    loaded,
    setLoaded,
    routeChanged,
    osChanged,
    dropsPassword,
    inputFor,
    restore,
    proxyHostInvalid: proxyKind !== "none" && !validAddress(proxyHost),
    jumpHostId,
    setJumpHostId,
    os,
    setOs,
    proxy: { kind: proxyKind, host: proxyHost, port: proxyPort, user: proxyUser, password: proxyPassword, passwordStored: lp?.passwordStored === true && lp.username === proxyUser.trim() },
    setProxyKind,
    setProxyHost,
    setProxyPort,
    setProxyUser,
    setProxyPassword,
    saveBefore,
    saveAfter,
  };
}

export function GroupDefaultsSection({ state, live }: { state: ReturnType<typeof useGroupDefaults>; live?: LiveProxySecret | undefined }) {
  const { hosts } = useVaultData();
  const options = hosts.value ?? [];
  const labelOf = (id: string) => options.find((h) => h.id === id)?.label ?? msgB.advanced.missingJump;
  const p = state.proxy;
  const inheritedRoute = state.loaded?.inheritedRoute ?? null;
  const inheritedOs = state.loaded?.inheritedOs ?? null;
  const configured = state.jumpHostId !== null || p.kind !== "none" || state.os !== null;
  return (
    <details className="advanced" open={configured ? true : undefined} data-testid="group-defaults">
      <summary>{msgDefaults.section}</summary>
      <div className="stack-sm" style={{ paddingTop: "var(--space-3)" }}>
        <p className="hint">{msgDefaults.sectionHint}</p>
        {inheritedRoute && inheritedRoute.origin.kind === "group" && state.jumpHostId === null && p.kind === "none" && (
          <p className="hint">{msgDefaults.inheritedRoute(inheritedRoute.origin.name, routeSummary(inheritedRoute, labelOf))}</p>
        )}
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
            {state.jumpHostId !== null && !options.some((h) => h.id === state.jumpHostId) && <option value={state.jumpHostId}>{msgB.advanced.missingJump}</option>}
          </select>
          <span className="hint">{state.jumpHostId ? msgB.advanced.via(labelOf(state.jumpHostId)) : msgB.advanced.jumpHint}</span>
        </label>
        <label className="field">
          <span className="label">{msgB.advanced.proxy}</span>
          <select className="select" aria-label={msgB.advanced.proxy} value={p.kind} disabled={!state.ready} onChange={(event) => state.setProxyKind(event.target.value as ProxyChoice)}>
            {PROXY_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {msgB.advanced.proxyKinds[choice]}
              </option>
            ))}
          </select>
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
                error={p.port.trim() !== "" && parsePort(p.port, false) === null ? msgB.tunnels.invalidPort : undefined}
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
        {live && state.routeChanged && !state.valid && <p className="hint">{msgAutosave.routeHeld}</p>}
        {live && state.routeChanged && state.valid && state.dropsPassword && (
          <DropSecretNotice text={msgAutosave.removesProxyPassword} action={msgAutosave.removeProxyPassword} onRemove={live.remove} />
        )}
        <label className="field">
          <span className="label">{msgDefaults.os}</span>
          <select className="select" aria-label={msgDefaults.os} value={state.os ?? ""} disabled={!state.ready} onChange={(event) => state.setOs(event.target.value === "" ? null : (event.target.value as HostOs))}>
            <option value="">{msgDefaults.osNone}</option>
            {(Object.keys(osNames) as HostOs[]).map((key) => (
              <option key={key} value={key}>
                {osNames[key]}
              </option>
            ))}
          </select>
          {state.os === null && inheritedOs && inheritedOs[1].kind === "group" && (
            <span className="hint">{msgDefaults.inheritedOs(inheritedOs[1].name, osNames[inheritedOs[0]])}</span>
          )}
        </label>
      </div>
    </details>
  );
}
