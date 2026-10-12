import type { HostSummary, KeySummary } from "@tyrminal/contracts";
import { useMemo, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { type Workspace, panesOf } from "../../app/workspace";
import { Dialog } from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { Avatar, EmptyState, ErrorNotice, IconButton, Segmented, SkeletonRows, relativeTime } from "../../components/ui/controls";
import {
  IconCopy,
  IconEllipsis,
  IconKeyRound,
  IconLayoutGrid,
  IconList,
  IconLock,
  IconPencil,
  IconPlay,
  IconPlus,
  IconSearch,
  IconServer,
  IconTextCursorInput,
  IconTrash2,
} from "../../components/ui/icons";
import { hosts as hostsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { useAction } from "../../lib/useAsync";
import { HostEditor } from "./HostEditor";

export function authSummary(host: HostSummary, keys: KeySummary[]): string {
  switch (host.auth.kind) {
    case "ask_password":
      return msg.hosts.authAsk;
    case "stored_password":
      return msg.hosts.authStored;
    case "key": {
      const keyId = host.auth.keyId;
      const key = keys.find((k) => k.id === keyId);
      return key ? msg.hosts.authKey(key.label) : msg.hosts.authKeyMissing;
    }
  }
}

function AuthBadge({ host, keys }: { host: HostSummary; keys: KeySummary[] }) {
  const Icon = host.auth.kind === "key" ? IconKeyRound : host.auth.kind === "stored_password" ? IconLock : IconTextCursorInput;
  const tone = host.auth.kind === "key" && !keys.some((k) => host.auth.kind === "key" && k.id === host.auth.keyId) ? "badge-danger" : "";
  return (
    <span className={`badge ${tone}`}>
      <Icon size={12} />
      {authSummary(host, keys)}
    </span>
  );
}

type Layout = "grid" | "list";
type Sort = "name" | "recent";

export function HostsView({ ws, onConnect }: { ws: Workspace; onConnect: (host: HostSummary) => void }) {
  const { hosts, keys, recent } = useVaultData();
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<Layout>("grid");
  const [sort, setSort] = useState<Sort>("name");
  const [editing, setEditing] = useState<{ host: HostSummary | null; initial?: HostSummary } | null>(null);
  const [deleting, setDeleting] = useState<HostSummary | null>(null);
  const [menu, setMenu] = useState<{ host: HostSummary; anchor: HTMLElement } | null>(null);
  const remove = useAction();
  const keyList = keys.value ?? [];

  // Hosts with an open session, from the user's own tabs (no probing of servers).
  const connected = useMemo(() => {
    const ids = new Set<string>();
    for (const tab of ws.tabs) {
      for (const id of panesOf(tab.layout)) {
        const pane = ws.panes[id];
        if (pane?.target.kind === "ssh" && pane.indicator === "ok") ids.add(pane.target.hostId);
      }
    }
    return ids;
  }, [ws]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = [...(hosts.value ?? [])];
    if (sort === "recent") all.sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0));
    if (!needle) return all;
    return all.filter((h) => `${h.label} ${h.address} ${h.username}`.toLowerCase().includes(needle));
  }, [hosts.value, query, sort]);

  const total = hosts.value?.length ?? 0;
  const reload = () => {
    void hosts.reload();
    void recent.reload();
    void keys.reload();
  };

  const actions = (host: HostSummary, anchor: HTMLElement) => setMenu({ host, anchor });

  return (
    <div className="page">
      <section className="page-inner" aria-labelledby="hosts-title">
        <div className="page-header">
          <div className="page-title">
            <h1 id="hosts-title">{msg.hosts.title}</h1>
            {total > 0 && <p>{msg.hosts.subtitle(total)}</p>}
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ host: null })}>
            <IconPlus size={16} />
            {msg.hosts.add}
          </button>
        </div>

        {total > 0 && (
          <div className="toolbar">
            <div className="input-with-icon">
              <IconSearch size={15} />
              <input
                className="input"
                type="search"
                placeholder={msg.common.search}
                aria-label={msg.hosts.searchLabel}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <span className="spacer" />
            <Segmented<Sort>
              label={msg.hosts.sort}
              value={sort}
              onChange={setSort}
              options={[
                { value: "name", label: msg.hosts.sortName },
                { value: "recent", label: msg.hosts.sortRecent },
              ]}
            />
            <Segmented<Layout>
              label={msg.hosts.view}
              value={layout}
              onChange={setLayout}
              options={[
                { value: "grid", label: msg.hosts.viewGrid, icon: <IconLayoutGrid size={14} /> },
                { value: "list", label: msg.hosts.viewList, icon: <IconList size={14} /> },
              ]}
            />
          </div>
        )}

        <ErrorNotice error={hosts.error ?? remove.error} />

        {hosts.value === null && !hosts.error && <SkeletonRows count={4} height={64} />}

        {hosts.value && total === 0 && (
          <EmptyState icon={<IconServer size={28} />} title={msg.hosts.emptyTitle} body={msg.hosts.emptyBody}>
            <button type="button" className="btn btn-primary" onClick={() => setEditing({ host: null })}>
              <IconPlus size={16} />
              {msg.hosts.add}
            </button>
          </EmptyState>
        )}

        {total > 0 && filtered.length === 0 && <p className="muted">{msg.hosts.noMatch}</p>}

        {layout === "grid" ? (
          <ul className="tile-grid host-grid" aria-label={msg.hosts.title} data-testid="host-list">
            {filtered.map((host) => {
              const isConnected = connected.has(host.id);
              return (
                <li key={host.id}>
                  <article
                    className="host-card"
                    data-connected={isConnected}
                    aria-label={host.label}
                    onDoubleClick={() => onConnect(host)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      actions(host, event.currentTarget);
                    }}
                  >
                    <Avatar label={host.label} />
                    <div className="host-card-main">
                      <span className="host-card-title">
                        <span className="truncate">{host.label}</span>
                      </span>
                      <span className="host-card-dest truncate">{msg.hosts.destination(host.username, host.address, host.port)}</span>
                    </div>
                    <div className="host-card-meta">
                      <div className="host-card-badges">
                      <AuthBadge host={host} keys={keyList} />
                      {isConnected ? (
                        <span className="badge badge-success">
                          <span className="status-dot" data-tone="ok" aria-hidden="true" />
                          {msg.hosts.connectedNow}
                        </span>
                      ) : (
                        <span className="badge">
                          {host.lastConnectedAt ? msg.hosts.lastConnected(relativeTime(host.lastConnectedAt)) : msg.hosts.neverConnected}
                        </span>
                      )}
                      </div>
                      <button type="button" className="btn btn-primary btn-sm" aria-label={msg.hosts.connectTo(host.label)} onClick={() => onConnect(host)}>
                        <IconPlay size={13} />
                        {msg.hosts.connect}
                      </button>
                    </div>
                    <div className="host-card-actions">
                      <IconButton size="sm" label={msg.hosts.more(host.label)} aria-haspopup="menu" onClick={(event) => actions(host, event.currentTarget)}>
                        <IconEllipsis size={16} />
                      </IconButton>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="list" aria-label={msg.hosts.title} data-testid="host-list">
            {filtered.map((host) => (
              <li key={host.id}>
                <Avatar label={host.label} />
                <div className="row-main">
                  <span className="row-title">{host.label}</span>
                  <span className="row-sub">
                    {msg.hosts.destination(host.username, host.address, host.port)} · {authSummary(host, keyList)}
                  </span>
                </div>
                {connected.has(host.id) && (
                  <span className="badge badge-success">
                    <span className="status-dot" data-tone="ok" aria-hidden="true" />
                    {msg.hosts.connectedNow}
                  </span>
                )}
                <div className="row-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onConnect(host)}>
                    <IconPlay size={13} />
                    {msg.hosts.connect}
                  </button>
                  <IconButton size="sm" label={msg.hosts.more(host.label)} aria-haspopup="menu" onClick={(event) => actions(host, event.currentTarget)}>
                    <IconEllipsis size={16} />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {menu && (
        <Menu
          label={msg.hosts.more(menu.host.label)}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={[
            { label: msg.hosts.connect, icon: <IconPlay size={15} />, onSelect: () => onConnect(menu.host) },
            { label: msg.common.edit, icon: <IconPencil size={15} />, onSelect: () => setEditing({ host: menu.host }) },
            {
              label: msg.hosts.duplicate,
              icon: <IconCopy size={15} />,
              onSelect: () => setEditing({ host: null, initial: { ...menu.host, label: `${menu.host.label} ${msg.hosts.copySuffix}` } }),
            },
            "separator",
            { label: msg.common.delete, icon: <IconTrash2 size={15} />, tone: "danger", onSelect: () => setDeleting(menu.host) },
          ]}
        />
      )}

      {editing && (
        <HostEditor
          host={editing.host}
          initial={editing.initial}
          keys={keyList}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}

      {deleting && (
        <Dialog title={msg.hosts.deleteTitle(deleting.label)} role="alertdialog" icon={<IconTrash2 size={18} />} tone="danger" onDismiss={() => setDeleting(null)}>
          <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
            {msg.hosts.deleteBody}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setDeleting(null)} autoFocus data-autofocus>
              {msg.common.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              disabled={remove.pending}
              onClick={async () => {
                const target = deleting;
                setDeleting(null);
                await remove.run(() => hostsApi.remove(target.id));
                reload();
              }}
            >
              {msg.common.delete}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
