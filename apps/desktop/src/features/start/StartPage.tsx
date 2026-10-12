import type { HostOs, HostSummary } from "@tyrminal/contracts";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { Avatar, Shortcut } from "../../components/ui/controls";
import { IconArrowLeftRight, IconPlug, IconSearch, IconServer, IconTerminal } from "../../components/ui/icons";
import { appearance as appearanceApi, hosts as hostsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { msgStart } from "../../lib/messages-start";
import { type QuickTarget, formatTarget, parseAddress } from "../../lib/quickConnect";
import { OsIcon } from "../hosts/OsIcon";
import "./start.css";

const RECENT = 8;
const MATCHES = 6;

/**
 * The new-tab page ("+" in the tab strip), like a browser's: a connect box, the things a tab can
 * open, and recent connections. Picking one turns this same tab into that session; nothing is
 * opened before. Escape on an untouched page closes the tab.
 */
export function StartPage({
  interactive,
  hostIdentity,
  onHost,
  onQuick,
  onLocal,
  onSftp,
  onHosts,
  onSerial,
  onClose,
}: {
  /** The pane is in front and focused: the connect box takes focus. */
  interactive: boolean;
  hostIdentity: (host: HostSummary) => string;
  onHost: (host: HostSummary) => void;
  /** An address that matches no saved host: quick connect in this tab. */
  onQuick: (target: QuickTarget) => void;
  onLocal: () => void;
  onSftp: () => void;
  onHosts: () => void;
  /** A new serial host (serial devices are saved as hosts). */
  onSerial: () => void;
  onClose: () => void;
}) {
  const { recent } = useVaultData();
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<{ query: string; found: HostSummary[] } | null>(null);
  const [osOf, setOsOf] = useState<Map<string, HostOs>>(new Map());

  const text = query.trim();
  // The core's host search, as on Hosts; debounced so typing an address doesn't search each key.
  useEffect(() => {
    if (!text) {
      setSearched(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      hostsApi.search(text).then(
        (found) => live && setSearched({ query: text, found }),
        () => live && setSearched({ query: text, found: [] }),
      );
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [text]);

  useEffect(() => {
    let live = true;
    appearanceApi.list().then(
      (list) => live && setOsOf(new Map(list.map((a) => [a.hostId, a.os]))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const answered = searched !== null && searched.query === text;
  const matches = answered ? searched.found.slice(0, MATCHES) : [];
  // An address is offered once the search for this exact text found no host (as on Hosts).
  const quick = answered && matches.length === 0 ? parseAddress(text) : null;
  const recents = useMemo(() => (recent.value ?? []).slice(0, RECENT), [recent.value]);

  function connect() {
    const first = matches[0];
    if (first) onHost(first);
    else if (quick) onQuick(quick);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && !event.defaultPrevented && query === "") {
      event.preventDefault();
      onClose();
    }
  }

  const mark = (host: HostSummary) => (osOf.has(host.id) ? <OsIcon os={osOf.get(host.id) as HostOs} size="sm" /> : <Avatar label={host.label} size="sm" />);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere on the page closes it.
    <section className="start-page" aria-labelledby="start-heading" onKeyDown={onKeyDown}>
      <div className="start-inner">
        <h2 id="start-heading" className="visually-hidden">
          {msgStart.heading}
        </h2>
        <form
          className="start-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <div className="input-with-icon">
            <IconSearch size={16} />
            <input
              className="input"
              type="search"
              aria-label={msgStart.searchLabel}
              placeholder={msgStart.searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Escape clears the box first; on an empty box it closes the page (above).
                if (event.key === "Escape" && query !== "") {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              autoFocus={interactive}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={!matches[0] && !quick}>
            {msgStart.connect}
          </button>
        </form>

        {text && answered && (
          <div className="start-results">
            {matches.length > 0 ? (
              <ul className="start-list" aria-label={msgStart.matches}>
                {matches.map((host) => (
                  <li key={host.id}>
                    <button type="button" className="start-row" onClick={() => onHost(host)}>
                      {mark(host)}
                      <span className="truncate">{host.label}</span>
                      <span className="faint mono truncate">{hostIdentity(host)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : quick ? (
              <button type="button" className="start-row start-quick" onClick={() => onQuick(quick)}>
                <span className="avatar avatar-sm" aria-hidden="true">
                  <IconServer size={14} />
                </span>
                <span className="truncate">{msgStart.quick(formatTarget(quick))}</span>
              </button>
            ) : (
              <p className="muted">{msgStart.noMatch}</p>
            )}
          </div>
        )}

        <div className="start-actions" role="group" aria-label={msgStart.actions}>
          <button type="button" className="start-tile" onClick={onLocal}>
            <IconTerminal size={18} />
            <span>{msgStart.local}</span>
            <Shortcut action="newLocal" />
          </button>
          <button type="button" className="start-tile" onClick={onSftp}>
            <IconArrowLeftRight size={18} />
            <span>{msgStart.sftp}</span>
          </button>
          <button type="button" className="start-tile" onClick={onSerial} title={msgStart.serialHint}>
            <IconPlug size={18} />
            <span>{msgStart.serial}</span>
          </button>
          <button type="button" className="start-tile" onClick={onHosts}>
            <IconServer size={18} />
            <span>{msgStart.hosts}</span>
          </button>
        </div>

        <div className="start-recent">
          <h3 className="eyebrow">{msgStart.recent}</h3>
          {recents.length === 0 ? (
            <p className="muted">{msgStart.noRecent}</p>
          ) : (
            <ul className="start-list" aria-label={msgStart.recent}>
              {recents.map((host) => (
                <li key={host.id}>
                  <button type="button" className="start-row" onClick={() => onHost(host)} title={msg.hosts.connect}>
                    {mark(host)}
                    <span className="truncate">{host.label}</span>
                    <span className="faint mono truncate">{hostIdentity(host)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
