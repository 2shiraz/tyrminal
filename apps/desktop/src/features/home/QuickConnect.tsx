import type { HostSummary } from "@tyrminal/contracts";
import { useMemo, useState } from "react";

import { useVaultData } from "../../app/vaultData";
import { useToast } from "../../components/ui/Toasts";
import { Keys, Shortcut } from "../../components/ui/controls";
import { IconCornerDownLeft, IconPlus, IconSearch, IconServer } from "../../components/ui/icons";
import { hosts as hostsApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";

/** `user@host[:port]` typed into quick connect. Only shape is checked here; the core validates. */
export function parseDestination(text: string): { username: string; address: string; port: number } | null {
  const m = /^([^\s@]+)@(\[[0-9a-fA-F:.]+\]|[^\s:@/]+)(?::(\d{1,5}))?$/.exec(text.trim());
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : 22;
  if (port < 1 || port > 65535) return null;
  return { username: m[1] as string, address: (m[2] as string).replace(/^\[|\]$/g, ""), port };
}

/**
 * The search field at the top of Home: matching saved hosts, or a new `user@host:port`, which is
 * saved first and then goes through the normal connect flow (trust and sign-in prompts unchanged).
 */
export function QuickConnect({
  onConnect,
  onSaveFailed,
}: {
  onConnect: (host: HostSummary) => void;
  /** Saving the typed destination failed: open the host editor with it filled in. */
  onSaveFailed: (prefill: { username: string; address: string; port: number }) => void;
}) {
  const { hosts } = useVaultData();
  const notify = useToast();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const all = hosts.value ?? [];

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return all.filter((h) => `${h.label} ${h.username}@${h.address}`.toLowerCase().includes(needle)).slice(0, 6);
  }, [all, query]);
  const parsed = parseDestination(query);
  const options = [...matches.map((h) => ({ kind: "host" as const, host: h })), ...(parsed ? [{ kind: "new" as const }] : [])];

  async function connect(index: number) {
    const option = options[index];
    if (!option) return;
    if (option.kind === "host") {
      setQuery("");
      onConnect(option.host);
      return;
    }
    if (!parsed) return;
    // Saving first keeps every connection tied to a vault record (trust, recents, snippets).
    try {
      const saved = await hostsApi.save({
        id: null,
        label: parsed.address,
        address: parsed.address,
        port: parsed.port,
        username: parsed.username,
        groupId: null,
        tags: [],
        protocol: { type: "ssh" },
        terminal: { encoding: "utf8", term: "xterm256color", pasteSkipMultiline: false, pasteSkipTrailingNewline: false },
        forwardAgent: false,
        production: false,
        auth: { kind: "ask_password" },
      });
      setQuery("");
      void hosts.reload();
      onConnect(saved);
    } catch (error) {
      notify("danger", (error as Error).message);
      onSaveFailed(parsed);
    }
  }

  return (
    <div className="quick-wrap">
      <div className="quick-connect">
        <IconSearch size={16} />
        <input
          aria-label={msg.home.quickLabel}
          placeholder={msg.home.quickPlaceholder}
          value={query}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls="quick-results"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((s) => Math.min(options.length - 1, s + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((s) => Math.max(0, s - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              void connect(selected);
            } else if (event.key === "Escape") {
              setQuery("");
            }
          }}
        />
        {query ? <Keys caps={["↩"]} /> : <Shortcut action="palette" />}
      </div>
      {options.length > 0 && (
        <div className="quick-results box" id="quick-results" role="listbox" aria-label={msg.home.quickLabel}>
          {options.map((option, index) => (
            <div
              key={option.kind === "host" ? option.host.id : "new"}
              role="option"
              aria-selected={index === selected}
              className="quick-option"
              onMouseMove={() => setSelected(index)}
              onClick={() => {
                setSelected(index);
                void connect(index);
              }}
            >
              {option.kind === "host" ? (
                <>
                  <IconServer size={14} className="faint" />
                  <span className="truncate">{option.host.label}</span>
                  <span className="quick-option-detail mono">{msg.hosts.destination(option.host.username, option.host.address, option.host.port)}</span>
                </>
              ) : (
                <>
                  <IconPlus size={14} className="faint" />
                  <span className="truncate">{msg.home.quickNew(query.trim())}</span>
                  <span className="quick-option-detail">
                    <IconCornerDownLeft size={12} />
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
