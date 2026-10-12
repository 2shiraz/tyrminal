// UI-TEST ONLY. A stand-in for the native side, injected into the page by Playwright before the
// application loads. It replaces window.__TAURI_INTERNALS__ with an in-memory backend holding
// synthetic data, so layout, keyboard flows and visual regressions can be tested in a browser.
// It never runs in the application, never moves a feature to VERIFIED, and is excluded from the
// build (it lives outside apps/desktop/src). Native behavior is tested in tests/native.

/* eslint-disable no-undef */
export function installMockBackend(options) {
  const scenario = options.scenario ?? "unlocked";
  const now = Math.floor(Date.UTC(2026, 9, 11, 12, 0, 0) / 1000);
  const callbacks = new Map();
  let nextCallback = 1;
  const listeners = new Map();
  let nextListener = 1;
  const calls = [];

  const id = (n) => n.toString(16).padStart(32, "0");
  const state = {
    vault: { state: scenario === "onboarding" ? "uninitialized" : scenario === "locked" ? "locked" : "unlocked", generation: 0 },
    prefs: {
      theme: options.theme ?? "dark",
      reduceMotion: true,
      terminal: {
        scheme: options.scheme ?? "tyrminal-night",
        fontFamily: "jetbrains-mono",
        fontSize: 14,
        lineHeight: 1.2,
        letterSpacing: 0,
        cursorStyle: "block",
        cursorBlink: false,
        padding: 10,
        scrollback: 5000,
        ligatures: false,
        renderer: options.renderer ?? "auto",
        confirmMultilinePaste: true,
        copyOnSelect: false,
      },
    },
    keys: [],
    hosts: [],
    groups: [],
    snippets: [],
    knownHosts: [],
    sessions: new Map(),
    nextSession: 1,
  };

  if (scenario !== "empty" && scenario !== "onboarding") {
    state.keys = [
      { id: id(1), label: "Deploy key", algorithm: "ssh-ed25519", fingerprint: "SHA256:3vQ0t1d7m5yY2q2y7c3n0Nq8bC8rS6mXfY1rC4b2h0A", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeSyntheticKeyForUiTests deploy-key", passphraseProtected: false, passphraseStored: false, usedBy: 3 },
      { id: id(2), label: "Legacy RSA", algorithm: "rsa-sha2-512", fingerprint: "SHA256:Q9n2p5yW1t0yX7uYb3dR8kP4mZ2cF6hJ1sL0vN8qA4E", publicKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABFakeSyntheticRsa legacy-rsa", passphraseProtected: true, passphraseStored: true, usedBy: 0 },
    ];
    const host = (n, label, address, username, port, auth, last, groupId = null, tags = []) => ({
      id: id(100 + n),
      label,
      address,
      port,
      username,
      auth,
      inherited: { username: false, port: false, auth: false },
      groupId,
      tags,
      lastConnectedAt: last,
    });
    state.groups = [
      { id: id(500), name: "Production", parentId: null, username: null, port: null, keyId: id(1) },
      { id: id(501), name: "Databases", parentId: id(500), username: "postgres", port: null, keyId: null },
      { id: id(502), name: "Lab", parentId: null, username: null, port: null, keyId: null },
    ];
    state.hosts = [
      host(1, "api-gateway", "10.20.0.11", "deploy", 22, { kind: "key", keyId: id(1) }, now - 600, id(500), ["prod", "web"]),
      host(2, "build-runner-03", "ci3.lab.example", "builder", 2222, { kind: "key", keyId: id(1) }, now - 3600 * 5, null, ["ci"]),
      host(3, "db-primary", "db1.internal.example", "postgres", 22, { kind: "ask_password" }, now - 86400 * 2, id(501), ["prod"]),
      host(4, "edge-cache", "203.0.113.24", "ops", 22, { kind: "stored_password" }, null),
      host(5, "Home lab", "192.168.1.40", "pi", 22, { kind: "key", keyId: id(1) }, now - 86400 * 9, id(502)),
      host(6, "staging-web", "stg.example.net", "www", 22, { kind: "ask_password" }, null),
    ];
    const snippet = (n, name, folder, text) => ({ id: id(200 + n), name, folder, text, updatedAt: now - n * 3000 });
    state.snippets = [
      snippet(1, "Disk usage", "", "df -h"),
      snippet(2, "Tail app log", "Ops", "journalctl -u app -f --since '10 min ago'"),
      snippet(3, "Restart service", "Ops", "sudo systemctl restart app\nsystemctl status app --no-pager"),
      snippet(4, "Deploy to staging", "Deploy/Staging", "git pull --ff-only\nmake build\n./scripts/deploy.sh staging"),
      snippet(5, "Top memory users", "Ops", "ps aux --sort=-%mem | head -n 15"),
    ];
    state.knownHosts = [
      { id: id(300), host: "10.20.0.11", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:k3J9vT0yQ2uX5rB8nM1cP4sD7fG0hL3wZ6qE9tY2iA8", addedAt: now - 86400 * 30 },
      { id: id(301), host: "ci3.lab.example", port: 2222, algorithm: "ecdsa-sha2-nistp256", fingerprint: "SHA256:Z0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3a4", addedAt: now - 86400 * 4 },
    ];
  }

  function emit(event, payload) {
    for (const [, l] of listeners) if (l.event === event) callbacks.get(l.handler)?.({ event, id: 0, payload });
  }

  function channelSend(channel, message) {
    const cb = callbacks.get(channel.id);
    if (!cb) return;
    channel.index = (channel.index ?? 0) + 1;
    cb({ index: channel.index - 1, message });
  }

  const E = "\u001b[";
  const prompt = (s) => `${E}1;38;5;75m${s.user}@${s.host}${E}0m:${E}34m~${E}0m$ `;
  const banner = (s) =>
    [
      `${E}2mWelcome to Ubuntu 24.04.1 LTS (synthetic UI test session)${E}0m`,
      "",
      `${E}1m System load:${E}0m 0.08   ${E}1mMemory:${E}0m 31%   ${E}1mDisk:${E}0m 42% of 78G`,
      "",
      `${prompt(s)}ls --color`,
      `${E}1;34mapp${E}0m  ${E}1;34mconfig${E}0m  ${E}32mdeploy.sh${E}0m  README.md  ${E}1;36mlogs${E}0m`,
      `${prompt(s)}git log --oneline -3`,
      `${E}33ma1f3c2e${E}0m ${E}36m(HEAD -> main, origin/main)${E}0m Handle reconnect backoff`,
      `${E}33m9d02b71${E}0m Bump dependencies`,
      `${E}33m4c8e910${E}0m Docs: https://example.com/runbook/deploy`,
      `${prompt(s)}`,
    ].join("\r\n");

  function openSession(args, kind) {
    const sessionId = `${state.nextSession++}`.padStart(32, "a");
    const host = kind === "ssh" ? state.hosts.find((h) => h.id === args.hostId) : null;
    const s = { id: sessionId, output: args.output, events: args.events, user: host?.username ?? "tyr", host: host?.label ?? "laptop", line: "" };
    state.sessions.set(sessionId, s);
    const trustPrompt = kind === "ssh" && options.trustPromptFor === host?.label;
    const blocked = kind === "ssh" && options.hostKeyChangedFor === host?.label;
    const steps =
      kind === "ssh"
        ? trustPrompt || blocked
          ? ["connecting", "verifying_host"]
          : ["connecting", "verifying_host", "authenticating", "opening_channel", "connected"]
        : ["connected"];
    let delay = 10;
    for (const step of steps) {
      if (step === "connected" && kind === "ssh") setTimeout(() => channelSend(s.events, NEGOTIATED), delay);
      setTimeout(() => channelSend(s.events, { type: "state", state: step }), delay);
      delay += 15;
    }
    if (kind === "ssh" && options.hostKeyChangedFor === host?.label) {
      setTimeout(() => {
        channelSend(s.events, {
          type: "host_key_changed",
          host: host.address,
          port: host.port,
          algorithm: "ssh-ed25519",
          presentedFingerprint: "SHA256:kyaNXVx1Uds2NONuEOTWsUwOsEBQnhhSOOg1h8P/Eng",
          trustedFingerprints: ["SHA256:71J6v69vG05S8WYY7SBu9DjPz+twOC7FCitOMa8XCzM"],
        });
        channelSend(s.events, { type: "state", state: "failed" });
        channelSend(s.events, {
          type: "closed",
          error: { code: "HOST_KEY_CHANGED", message: "The server's identity has changed. The connection was blocked." },
          exitStatus: null,
        });
      }, 40);
      return { sessionId };
    }
    if (trustPrompt) {
      setTimeout(
        () =>
          channelSend(s.events, {
            type: "trust_prompt",
            promptId: "p1",
            host: host.address,
            port: host.port,
            resolvedAddress: "198.51.100.7",
            algorithm: "ssh-ed25519",
            fingerprint: "SHA256:k3J9vT0yQ2uX5rB8nM1cP4sD7fG0hL3wZ6qE9tY2iA8",
          }),
        30,
      );
      return { sessionId };
    }
    setTimeout(() => channelSend(s.output, new TextEncoder().encode(banner(s)).buffer), delay + 10);
    return { sessionId };
  }

  const NEGOTIATED = {
    type: "negotiated",
    kex: "mlkem768x25519-sha256",
    hostKey: "ssh-ed25519",
    cipher: "chacha20-poly1305@openssh.com",
    mac: "",
    strictKex: true,
  };

  function write(sessionId, bytes) {
    const s = state.sessions.get(sessionId);
    if (!s) throw { code: "ACCESS_DENIED", message: "That session is not available to this window." };
    const text = new TextDecoder().decode(bytes);
    let out = "";
    for (const ch of text) {
      if (ch === "\r") {
        out += `\r\n${s.line === "" ? "" : `${s.line}: synthetic output\r\n`}${prompt(s)}`;
        s.line = "";
      } else if (ch === "\u007f") {
        if (s.line) {
          s.line = s.line.slice(0, -1);
          out += "\b \b";
        }
      } else if (ch >= " ") {
        s.line += ch;
        out += ch;
      }
    }
    if (out) channelSend(s.output, new TextEncoder().encode(out).buffer);
  }

  function groupDefaults(groupId) {
    const out = { username: null, port: null, keyId: null };
    let current = state.groups.find((g) => g.id === groupId);
    for (let d = 0; current && d < 16; d += 1) {
      out.username ??= current.username;
      out.port ??= current.port;
      out.keyId ??= current.keyId;
      current = state.groups.find((g) => g.id === current.parentId);
    }
    return out;
  }
  function groupPathOf(groupId) {
    const names = [];
    let current = state.groups.find((g) => g.id === groupId);
    for (let d = 0; current && d < 16; d += 1) {
      names.unshift(current.name);
      current = state.groups.find((g) => g.id === current.parentId);
    }
    return names.join("/");
  }

  const handlers = {
    "plugin:event|listen": (a) => {
      const lid = nextListener++;
      listeners.set(lid, { event: a.event, handler: a.handler });
      // Race seen on Windows: a status event reaches the page before the first status request
      // returns.
      if (options.statusEventFirst && a.event === "vault-status") setTimeout(() => emit("vault-status", state.vault), 0);
      return lid;
    },
    "plugin:event|unlisten": (a) => {
      listeners.delete(a.eventId);
    },
    backup_export: () => "tyrminal-backup-2026-10-11.tyrbackup",
    backup_choose: () => ({ fileName: "tyrminal-backup-2026-10-11.tyrbackup", size: 48213 }),
    backup_preview: (a) => {
      if (a.secret !== "correct horse battery") throw { code: "WRONG_CREDENTIAL", message: "That did not open the backup. Nothing was restored." };
      return { createdAt: 1760140800, hosts: state.hosts.length, keys: 2, knownHosts: 3, snippets: 5 };
    },
    backup_restore: (a) => {
      if (a.secret !== "correct horse battery") throw { code: "WRONG_CREDENTIAL", message: "That did not open the backup. Nothing was restored." };
      state.vault = { state: "locked", generation: state.vault.generation + 1 };
      state.sessions.clear();
      setTimeout(() => emit("vault-status", state.vault), 10);
      return { createdAt: 1760140800, hosts: state.hosts.length, keys: 2, knownHosts: 3, snippets: 5 };
    },
    prefs_get: () => structuredClone(state.prefs),
    prefs_set: (a) => {
      state.prefs = structuredClone(a.prefs);
      return structuredClone(state.prefs);
    },
    vault_status: () =>
      options.statusEventFirst ? new Promise((resolve) => setTimeout(() => resolve({ ...state.vault }), 1500)) : { ...state.vault },
    vault_quick_unlock_status: () => state.quickUnlock === true,
    vault_quick_unlock_enable: (a) => {
      if (a.passphrase !== "correct horse") throw { code: "WRONG_CREDENTIAL", message: "That did not unlock the vault. Nothing was changed." };
      state.quickUnlock = true;
      return null;
    },
    vault_quick_unlock_disable: () => {
      state.quickUnlock = false;
      return null;
    },
    vault_unlock_device: () => {
      if (!state.quickUnlock) throw { code: "WRONG_CREDENTIAL", message: "Quick unlock is not set up on this device. Use your passphrase." };
      state.vault = { state: "unlocked", generation: state.vault.generation };
      emit("vault-status", state.vault);
      return null;
    },
    vault_activity: () => null,
    vault_create: () => {
      state.vault = { state: "unlocked", generation: state.vault.generation };
      emit("vault-status", state.vault);
      return { recoveryKey: "7K2MD-Q9XW4-R3T8P-H6VNC-2BJ5L-M8S4D-F1G7K-P3Q9R-W2E6T-Y5U8I-A4S7D" }; // gitleaks:allow (synthetic UI-mock value, not a vault key)
    },
    vault_unlock: (a) => {
      if (a.passphrase !== "correct horse") throw { code: "WRONG_CREDENTIAL", message: "That did not unlock the vault. Nothing was changed." };
      state.vault = { state: "unlocked", generation: state.vault.generation };
      emit("vault-status", state.vault);
      return null;
    },
    vault_lock: () => {
      state.vault = { state: "locked", generation: state.vault.generation + 1 };
      for (const s of state.sessions.values()) channelSend(s.events, { type: "closed", error: { code: "VAULT_LOCKED", message: "The vault was locked, so this session was closed." }, exitStatus: null });
      state.sessions.clear();
      emit("vault-status", state.vault);
      return null;
    },
    host_list: () => structuredClone(state.hosts),
    host_recent: () => structuredClone(state.hosts.filter((h) => h.lastConnectedAt).sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)),
    host_save: (a) => {
      const existing = state.hosts.find((h) => h.id === a.host.id);
      const defaults = groupDefaults(a.host.groupId);
      const inherited = { username: a.host.username === "", port: a.host.port === null, auth: a.host.auth.kind === "inherit" };
      const auth = inherited.auth
        ? defaults.keyId
          ? { kind: "key", keyId: defaults.keyId }
          : { kind: "ask_password" }
        : a.host.auth.kind === "stored_password"
          ? { kind: "stored_password" }
          : a.host.auth;
      const saved = {
        ...a.host,
        id: existing?.id ?? id(400 + state.hosts.length),
        username: inherited.username ? (defaults.username ?? "") : a.host.username,
        port: inherited.port ? (defaults.port ?? 22) : a.host.port,
        auth,
        inherited,
        tags: [...new Set(a.host.tags.map((t) => t.trim()).filter(Boolean))].sort(),
        lastConnectedAt: existing?.lastConnectedAt ?? null,
      };
      state.hosts = existing ? state.hosts.map((h) => (h.id === saved.id ? saved : h)) : [...state.hosts, saved];
      return saved;
    },
    host_delete: (a) => {
      state.hosts = state.hosts.filter((h) => h.id !== a.id);
    },
    host_search: (a) => {
      const terms = a.query.toLowerCase().split(/\s+/).filter(Boolean);
      return structuredClone(
        state.hosts.filter((h) => {
          const path = groupPathOf(h.groupId).toLowerCase();
          return terms.every((t) =>
            t.startsWith("tag:")
              ? h.tags.some((tag) => tag.toLowerCase() === t.slice(4))
              : t.startsWith("group:")
                ? path.includes(t.slice(6))
                : `${h.label} ${h.address} ${h.username} ${h.tags.join(" ")} ${path}`.toLowerCase().includes(t),
          );
        }),
      );
    },
    host_duplicate: (a) => {
      const source = state.hosts.find((h) => h.id === a.id);
      const copy = { ...structuredClone(source), id: id(450 + state.hosts.length), label: `${source.label} (copy)`, lastConnectedAt: null };
      state.hosts = [...state.hosts, copy];
      return copy;
    },
    host_bulk: (a) => {
      const ids = new Set(a.ids);
      if (a.change.kind === "delete") state.hosts = state.hosts.filter((h) => !ids.has(h.id));
      else
        state.hosts = state.hosts.map((h) => {
          if (!ids.has(h.id)) return h;
          if (a.change.kind === "move_to_group") return { ...h, groupId: a.change.groupId };
          if (a.change.kind === "add_tag") return { ...h, tags: [...new Set([...h.tags, a.change.tag])].sort() };
          return { ...h, tags: h.tags.filter((t) => t.toLowerCase() !== a.change.tag.toLowerCase()) };
        });
      return a.ids.length;
    },
    group_list: () => structuredClone(state.groups),
    group_save: (a) => {
      const existing = state.groups.find((g) => g.id === a.group.id);
      const saved = { ...a.group, id: existing?.id ?? id(600 + state.groups.length) };
      state.groups = existing ? state.groups.map((g) => (g.id === saved.id ? saved : g)) : [...state.groups, saved];
      return saved;
    },
    group_delete: (a) => {
      if (state.hosts.some((h) => h.groupId === a.id) || state.groups.some((g) => g.parentId === a.id)) {
        throw { code: "IN_USE", message: "The group is not empty. Move its hosts and subgroups first." };
      }
      state.groups = state.groups.filter((g) => g.id !== a.id);
    },
    import_preview: (a) => {
      // A tiny stand-in for the core parser: one host per "Host <name>" line, ProxyCommand skipped.
      const hosts = [];
      const skipped = [];
      a.text.split("\n").forEach((line, i) => {
        const [key, value] = line.trim().split(/\s+/);
        if (key?.toLowerCase() === "host" && value)
          hosts.push({ label: value, address: value, port: 22, username: "", group: "", tags: [], notes: [] });
        if (key?.toLowerCase() === "proxycommand")
          skipped.push({ line: i + 1, text: line.trim(), reason: "runs a command; not imported (commands from imported files are never run)" });
      });
      return { hosts, skipped, duplicates: hosts.filter((h) => state.hosts.some((x) => x.label === h.label)).map((h) => h.label) };
    },
    import_hosts: (a) => {
      for (const h of a.hosts) {
        state.hosts.push({
          id: id(700 + state.hosts.length),
          label: h.label,
          address: h.address,
          port: h.port,
          username: h.username,
          auth: { kind: "ask_password" },
          inherited: { username: h.username === "", port: false, auth: false },
          groupId: a.intoGroup,
          tags: h.tags,
          lastConnectedAt: null,
        });
      }
      return a.hosts.length;
    },
    key_list: () => structuredClone(state.keys),
    known_host_list: () => structuredClone(state.knownHosts),
    snippet_list: () => structuredClone(state.snippets),
    snippet_save: (a) => {
      const existing = state.snippets.find((s) => s.id === a.snippet.id);
      const saved = { ...a.snippet, id: existing?.id ?? id(500 + state.snippets.length), folder: a.snippet.folder.trim().replace(/^\/+|\/+$/g, ""), updatedAt: now };
      state.snippets = existing ? state.snippets.map((s) => (s.id === saved.id ? saved : s)) : [...state.snippets, saved];
      return saved;
    },
    snippet_delete: (a) => {
      state.snippets = state.snippets.filter((s) => s.id !== a.id);
    },
    snippet_send: (a) => {
      const s = state.snippets.find((x) => x.id === a.snippetId);
      const text = s.text.replace(/\n$/, "").replaceAll("\n", "\r");
      write(a.sessionId, new TextEncoder().encode(a.mode === "run" ? `${text}\r` : text));
    },
    session_open_ssh: (a) => openSession(a, "ssh"),
    session_open_local: (a) => openSession(a, "local"),
    session_write: (a, o) => write(o.headers["x-session"], a),
    session_resize: () => null,
    session_ack: () => null,
    session_close: (a) => {
      state.sessions.delete(a.sessionId);
    },
    session_trust_answer: (a) => {
      const s = state.sessions.get(a.sessionId);
      if (s && a.decision !== "cancel") {
        channelSend(s.events, NEGOTIATED);
        channelSend(s.events, { type: "state", state: "connected" });
        channelSend(s.output, new TextEncoder().encode(banner(s)).buffer);
      }
    },
    link_open: (a) => {
      if (!/^https?:\/\//.test(a.url)) throw { code: "INVALID_INPUT", message: "Only web links (http and https) can be opened." };
      window.__mockOpenedLinks.push(a.url);
    },
  };

  /** Writes raw terminal output (escape sequences included) to the most recent session. */
  window.__mockOutput = (text) => {
    const last = [...state.sessions.values()].at(-1);
    if (last) channelSend(last.output, new TextEncoder().encode(text).buffer);
  };
  /** Ends the newest session as a network drop (or with another error code). */
  window.__mockDrop = (code = "DISCONNECTED") => {
    const last = [...state.sessions.values()].at(-1);
    if (!last) return;
    state.sessions.delete(last.id);
    channelSend(last.events, { type: "state", state: "failed" });
    channelSend(last.events, { type: "closed", error: { code, message: "The server closed the connection." }, exitStatus: null });
  };
  window.__mockCalls = calls;
  window.__mockOpenedLinks = [];
  window.__mockState = state;
  window.__mockEmit = emit;

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(callback, once = false) {
      const cid = nextCallback++;
      callbacks.set(cid, (payload) => {
        if (once) callbacks.delete(cid);
        return callback(payload);
      });
      return cid;
    },
    unregisterCallback(cid) {
      callbacks.delete(cid);
    },
    runCallback(cid, payload) {
      callbacks.get(cid)?.(payload);
    },
    callbacks,
    async invoke(cmd, args = {}, opts = {}) {
      calls.push({ cmd, args: cmd === "session_write" ? "<bytes>" : args });
      const handler = handlers[cmd];
      if (!handler) throw { code: "INTERNAL", message: `mock: unhandled ${cmd}` };
      return handler(args, opts);
    },
    convertFileSrc: (path) => path,
  };
}
