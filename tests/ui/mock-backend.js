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
      palette: options.palette ?? "cobalt",
      reduceMotion: true,
      localShell: null,
      editorApps: [],
      commandNotifications: { enabled: true, minSeconds: 10 },
      // compromised-password check (SEC-11)
      passwordCheck: { enabled: false, endpoint: "https://api.pwnedpasswords.com/range/" },
      productionTag: options.productionTag ?? "prod",
      interfaceScale: null,
      ...(options.hostsLayout === null ? {} : { hostsView: { layout: options.hostsLayout ?? "grid", sort: "name", filter: { kind: "all" }, connectHintUses: 0 } }),
      terminal: {
        scheme: options.scheme ?? "tyrminal-night",
        fontFamily: "jetbrains-mono",
        fontSize: 14,
        lineHeight: 1.2,
        letterSpacing: 0,
        cursorStyle: "block",
        cursorBlink: false,
        padding: 12,
        scrollback: options.scrollback ?? 5000,
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
    notes: {},
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
      protocol: { type: "ssh" },
      terminal: { encoding: "utf8", term: "xterm256color", pasteSkipMultiline: false, pasteSkipTrailingNewline: false },
      forwardAgent: false,
      production: null,
      favourite: false,
    });
    state.groups = [
      { id: id(500), name: "Production", parentId: null, username: null, port: null, keyId: id(1), production: false },
      { id: id(501), name: "Databases", parentId: id(500), username: "postgres", port: null, keyId: null, production: false },
      { id: id(502), name: "Lab", parentId: null, username: null, port: null, keyId: null, production: false },
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
    // P-30: notes by host label or group name ("host:api-gateway", "group:Production").
    for (const [key, note] of Object.entries(options.notes ?? {})) {
      const [kind, name] = key.split(":");
      const target = kind === "host" ? state.hosts.find((h) => h.label === name) : state.groups.find((g) => g.name === name);
      if (target) state.notes[`${kind}:${target.id}`] = { format: "markdown", updatedAt: 1760184000, ...note };
    }
    // security review (P-27): an old DSA key, a 2048-bit RSA key and an RSA-only trusted key for
    // a host that is no longer in the inventory.
    if (options.reviewFixtures) {
      state.keys.push(
        { id: id(3), label: "Old DSA", algorithm: "ssh-dss", fingerprint: "SHA256:dsaSyntheticFingerprintForUiTests0000000000", publicKey: "ssh-dss AAAAB3NzaC1kc3MFakeSynthetic old-dsa", passphraseProtected: true, passphraseStored: false, usedBy: 0, bits: 1024 },
        { id: id(4), label: "Laptop RSA", algorithm: "ssh-rsa", fingerprint: "SHA256:rsaSyntheticFingerprintForUiTests0000000000", publicKey: "ssh-rsa AAAAB3NzaC1yc2EFakeSynthetic laptop-rsa", passphraseProtected: true, passphraseStored: false, usedBy: 0, bits: 2048 },
      );
      state.knownHosts.push({ id: id(303), host: "retired.example", port: 22, algorithm: "ssh-rsa", fingerprint: "SHA256:retiredRsaSyntheticFingerprint000000000000", addedAt: now - 86400 * 90 });
    }
    // A large vault for the windowed Hosts list (windowing tests): hosts in no group.
    for (let n = 0; n < (options.extraHosts ?? 0); n++) {
      const label = `bulk-host-${String(n + 1).padStart(3, "0")}`;
      state.hosts.push({ ...host(0, label, `10.99.${Math.floor(n / 250)}.${(n % 250) + 1}`, "ops", 22, { kind: "ask_password" }, null), id: id(10_000 + n) });
    }
    // A large set of trusted servers for the windowed Known hosts list (windowing tests).
    for (let n = 0; n < (options.extraKnownHosts ?? 0); n++) {
      state.knownHosts.push({ id: id(20_000 + n), host: `bulk-${String(n + 1).padStart(3, "0")}.example`, port: 22, algorithm: "ssh-ed25519", fingerprint: `SHA256:bulk${n}`, addedAt: now - 86400 });
    }
    // The host whose key "changed" was trusted with this key; removing that trust (Known hosts, or
    // Replace the trusted key on the warning) makes the next connection a first-time trust prompt.
    const changedHost = options.hostKeyChangedFor ? state.hosts.find((h) => h.label === options.hostKeyChangedFor) : null;
    if (changedHost) {
      state.knownHosts.push({ id: id(304), host: changedHost.address, port: changedHost.port, algorithm: "ssh-ed25519", fingerprint: "SHA256:71J6v69vG05S8WYY7SBu9DjPz+twOC7FCitOMa8XCzM", addedAt: now - 86400 * 60 });
    }
    if (options.orphanKnownHost) {
      state.knownHosts.push({ id: id(302), host: "198.51.100.7", port: 2200, algorithm: "ssh-ed25519", fingerprint: "SHA256:q1W2e3R4t5Y6u7I8o9P0a1S2d3F4g5H6j7K8l9Z0x1C", addedAt: now - 86400 });
    }
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
    // "files": a files-only connection (SFTP tab): SSH trust and sign-in, no terminal output.
    // "exec": a run-only connection for snippet runs (SNP-05): the same, with exec channels only.
    const exec = kind === "exec";
    const files = kind === "files" || exec;
    if (files) kind = "ssh";
    // quick connect: an unsaved address stands in for a host (no id; nothing is stored).
    const quickHost = args.input ? { id: null, label: args.input.address, username: args.input.username || "tyr", protocol: { type: args.input.protocol } } : null;
    const host = kind === "ssh" ? (quickHost ?? state.hosts.find((h) => h.id === args.hostId)) : null;
    const s = { id: sessionId, hostId: host?.id ?? null, output: args.output, events: args.events, user: host?.username ?? "tyr", host: host?.label ?? "laptop", line: "", files, exec };
    if (files && !exec) window.__mockFileSessions.push({ sessionId, host: host?.label });
    state.sessions.set(sessionId, s);
    // Like the core: a Telnet session starts with a notice from Tyrminal (not a server banner).
    if (host?.protocol?.type === "telnet")
      setTimeout(() => channelSend(args.events, { type: "notice", text: "Telnet is not encrypted: anything you type here, including passwords, can be read by others on the network." }), 5);
    const keyChangedFor = kind === "ssh" && options.hostKeyChangedFor === host?.label;
    const stillTrusted = keyChangedFor && state.knownHosts.some((k) => k.host === host.address && k.port === host.port);
    const blocked = keyChangedFor && stillTrusted;
    const trustPrompt = kind === "ssh" && (options.trustPromptFor === host?.label || (keyChangedFor && !stillTrusted));
    const passwordPrompt = kind === "ssh" && options.passwordPromptFor === host?.label;
    const keyRejected = kind === "ssh" && options.keyRejectedFor === host?.label && host.auth.kind === "key" && !state.deployed?.has(host.auth.keyId);
    const steps =
      kind === "ssh"
        ? trustPrompt || blocked || passwordPrompt || keyRejected
          ? ["connecting", "verifying_host"]
          : ["connecting", "verifying_host", "authenticating", "opening_channel", "connected"]
        : ["connected"];
    let delay = 10;
    for (const step of steps) {
      if (step === "connected" && kind === "ssh") {
        // Like the core: only an SSH connection reports what it negotiated (not Telnet or serial).
        if (host?.protocol?.type !== "telnet" && host?.protocol?.type !== "serial") setTimeout(() => channelSend(s.events, NEGOTIATED), delay);
        // Startup snippets are typed once the shell is open (SNP-08).
        setTimeout(() => window.__mockRunStartup?.(s, host), delay + 40);
      }
      // Environment variables of the host: the mock server's AcceptEnv allows TYR_* only.
      if (step === "opening_channel" && host) {
        const sent = (window.__mockEnvOf?.(host.id) ?? []).map((v) => v.name);
        if (sent.length) setTimeout(() => channelSend(s.events, { type: "environment", sent, rejected: sent.filter((n) => !n.startsWith("TYR_")) }), delay);
      }
      setTimeout(() => channelSend(s.events, { type: "state", state: step }), delay);
      delay += 15;
    }
    // The server refuses the host's key until it has been installed (key_deploy).
    if (keyRejected) {
      const key = state.keys.find((k) => k.id === host.auth.keyId);
      setTimeout(() => {
        channelSend(s.events, { type: "state", state: "authenticating", hop: null });
        channelSend(s.events, { type: "key_rejected", keyId: key.id, label: key.label, hop: null });
        state.sessions.delete(sessionId);
        channelSend(s.events, { type: "state", state: "failed", hop: null });
        channelSend(s.events, {
          type: "closed",
          error: { code: "AUTH_FAILED", message: `The server did not accept the key "${key.label}". Its public key may not be installed on this server.` },
          exitStatus: null,
        });
      }, 40);
      return { sessionId };
    }
    if (blocked) {
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
            // agent B: tunnels and history
            hop: options.trustPromptHop ?? null,
          }),
        30,
      );
      return { sessionId };
    }
    if (passwordPrompt && exec && args.interactive === false) {
      // Like the core: nothing is asked; the host is skipped as needing sign-in.
      setTimeout(() => {
        state.sessions.delete(sessionId);
        channelSend(s.events, { type: "state", state: "failed" });
        channelSend(s.events, {
          type: "closed",
          error: { code: "NEEDS_SIGN_IN", message: "This host needs a sign-in answer (no saved password or key), so it was skipped." },
          exitStatus: null,
        });
      }, 30);
      return { sessionId };
    }
    if (passwordPrompt) {
      setTimeout(
        () =>
          channelSend(s.events, {
            type: "auth_prompt",
            promptId: "a1",
            kind: "password",
            username: host.username,
            attempt: 1,
            maxAttempts: 3,
            message: null,
            echo: false,
            hop: null,
          }),
        30,
      );
      return { sessionId };
    }
    if (!files) setTimeout(() => channelSend(s.output, new TextEncoder().encode(banner(s)).buffer), delay + 10);
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
    // Everything the UI sent to any session, so a test can wait for a terminal reply to arrive.
    window.__mockReceived = (window.__mockReceived ?? "") + text;
    // terminal input: the same per session, in order (IME, broadcast exclusion tests).
    (window.__mockInputBySession ??= {})[sessionId] = (window.__mockInputBySession[sessionId] ?? "") + text;
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
  /** A host as the core reports it: its own production flag, else any group above it (P-26). */
  function hostView(h) {
    let fromGroup = false;
    let g = state.groups.find((x) => x.id === h.groupId);
    for (let d = 0; g && d < 16; d += 1) {
      if (g.production) fromGroup = true;
      g = state.groups.find((x) => x.id === g.parentId);
    }
    const production = state.ownProduction?.has(h.id) ? "host" : fromGroup ? "group" : null;
    return { ...structuredClone(h), production };
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

  // A small synthetic remote filesystem for the files panel.
  const fs = new Map();
  const addNode = (path, kind, size = null, permissions = kind === "dir" ? 0o755 : 0o644) =>
    fs.set(path, { kind, size: kind === "dir" ? null : size, permissions, modified: now - 3600 });
  addNode("/", "dir");
  addNode("/home", "dir");
  addNode("/home/deploy", "dir");
  addNode("/home/deploy/app", "dir");
  addNode("/home/deploy/app/config.yml", "file", 812);
  addNode("/home/deploy/logs", "dir");
  addNode("/home/deploy/.bashrc", "file", 3771);
  addNode("/home/deploy/deploy.sh", "file", 1290, 0o755);
  addNode("/home/deploy/README.md", "file", 5120);
  addNode("/home/deploy/backup.tar.gz", "file", 734003200);
  const fsErr = (code, message) => {
    throw { code, message };
  };
  const childPath = (dir, name) => {
    if (!name || name === "." || name === ".." || name.includes("/")) fsErr("INVALID_INPUT", "That name cannot be used on the server.");
    return `${dir.replace(/\/+$/, "")}/${name}`;
  };
  const children = (dir) =>
    [...fs.keys()].filter((p) => p !== dir && p.startsWith(dir === "/" ? "/" : `${dir}/`) && !p.slice(dir === "/" ? 1 : dir.length + 1).includes("/"));
  const localPicks = new Map();
  let nextTransfer = 1;
  window.__mockLocalFiles = new Set();
  window.__mockFs = fs;
  const streams = new Map();
  window.__mockDropped = [];
  window.__mockReports = [];
  window.__mockTransfers = new Map();
  /** Completes a running mock transfer (tests drive progress explicitly). */
  window.__mockFinishTransfer = (transferId) => window.__mockTransfers.get(transferId)?.finish();

  const edits = new Map();
  /** Marks an open edit's local copy changed, or the server copy changed (conflict on save). */
  window.__mockEditLocalChange = (name) => {
    for (const e of edits.values()) if (e.name === name) e.changed = true;
  };
  window.__mockEditServerChange = (name) => {
    for (const e of edits.values()) if (e.name === name) e.serverChanged = true;
  };

  // The local side of the two-pane view: a chosen folder with a synthetic tree.
  const localTree = new Map([
    ["", [{ name: "photos", kind: "dir" }, { name: "deploy.tar.gz", kind: "file", size: 40960 }, { name: "notes.md", kind: "file", size: 512 }]],
    ["photos", [{ name: "beach.jpg", kind: "file", size: 204800 }]],
  ]);
  const localEntries = (path) =>
    (localTree.get(path.join("/")) ?? []).map((e) => ({ name: e.name, kind: e.kind, size: e.size ?? null, permissions: null, modified: null }));

  const handlers = {
    // server at a glance
    ...(() => {
      // Values as the core would parse them; a test can replace them with window.__mockGlance.
      const offHosts = new Set();
      const sample = {
        kind: "available",
        stats: {
          uptimeSeconds: 93_784,
          load: [0.15, 0.3, 0.45],
          memory: { totalKib: 2_048_000, availableKib: 512_000 },
          disks: [
            { mount: "/", totalKib: 61_202_244, usedKib: 21_893_584, availableKib: 36_167_700 },
            { mount: "/srv/<b>data</b>", totalKib: 1_000_000, usedKib: 250_000, availableKib: 750_000 },
          ],
        },
      };
      return {
        glance_get: (a) => {
          const s = state.sessions.get(a.sessionId);
          if (!s) throw { code: "ACCESS_DENIED", message: "That session is not available to this window." };
          const host = state.hosts.find((h) => h.label === s.host);
          if (!host || host.protocol?.type === "telnet" || host.protocol?.type === "serial")
            throw { code: "INVALID_INPUT", message: "This works in a connected SSH session only." };
          if (offHosts.has(host.id)) return { kind: "off" };
          return window.__mockGlance ?? sample;
        },
        // tmux and screen session awareness (P-31): what the core would return for the lab-like
        // server (names already cleaned; attach commands only for strict names).
        multiplexer_list: (a) => {
          const s = state.sessions.get(a.sessionId);
          if (!s) throw { code: "ACCESS_DENIED", message: "That session is not available to this window." };
          const host = state.hosts.find((h) => h.label === s.host);
          if (!host || host.protocol?.type === "telnet" || host.protocol?.type === "serial")
            throw { code: "INVALID_INPUT", message: "This works in a connected SSH session only." };
          (window.__mockMultiplexerCalls ??= []).push(a.sessionId);
          return (
            window.__mockMultiplexers ?? {
              state: "listed",
              tmuxInstalled: true,
              screenInstalled: true,
              sessions: [
                { kind: "tmux", name: "work", attached: false, windows: 3, createdAt: 1760000000, attachCommand: "tmux attach-session -t '=work'" },
                { kind: "tmux", name: "<img src=x onerror=alert(1)>; rm -rf ~", attached: true, windows: 1, createdAt: 1760000100, attachCommand: null },
                { kind: "screen", name: "4242.build", attached: false, windows: null, createdAt: null, attachCommand: "screen -r '4242.build'" },
              ],
              truncated: false,
            }
          );
        },
        glance_host_get: (a) => !offHosts.has(a.hostId),
        glance_host_set: (a) => {
          if (a.enabled) offHosts.delete(a.hostId);
          else offHosts.add(a.hostId);
          return a.enabled;
        },
      };
    })(),
    // agent C: workspaces
    layout_list: () => (state.layouts ?? []).slice().sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase())),
    layout_save: (a) => {
      state.layouts ??= [];
      const panes = a.layout.tabs.reduce((n, t) => n + t.panes.length, 0);
      if (panes > 16) throw { code: "INVALID_INPUT", message: "A layout holds at most 16 panes." };
      for (const t of a.layout.tabs)
        for (const p of t.panes)
          if (p.kind === "ssh" && !state.hosts.some((h) => h.id === p.hostId)) throw { code: "NOT_FOUND", message: "A host in this layout no longer exists." };
      const existing = state.layouts.find((l) => l.id === a.layout.id);
      if (a.layout.id && !existing) throw { code: "NOT_FOUND", message: "That layout no longer exists." };
      const saved = { id: existing?.id ?? id(900 + state.layouts.length), name: a.layout.name.trim(), tabs: a.layout.tabs, updatedAt: now };
      state.layouts = existing ? state.layouts.map((l) => (l.id === saved.id ? saved : l)) : [...state.layouts, saved];
      return saved;
    },
    layout_delete: (a) => {
      state.layouts = (state.layouts ?? []).filter((l) => l.id !== a.id);
    },
    // Detach: the main window hands sessions to a new window. The mock records the request; a
    // page opened as a detached window (options.detached) receives that tab and attaches.
    window_detach: (a) => {
      window.__mockDetached = a.tab;
      return "detached-0000000000000001";
    },
    window_detach_take: () => {
      const tab = options.detached;
      if (!tab) throw { code: "NOT_FOUND", message: "The tab for this window is no longer available." };
      options.detached = null;
      return tab;
    },
    session_attach: (a) => {
      if (!/^token-/.test(a.token)) throw { code: "ACCESS_DENIED", message: "That session is not available to this window." };
      return openSession({ ...a }, "local").sessionId;
    },
    // command history
    ...(() => {
      // Remembered commands per host, as the native side keeps them (opt-in, prefix then substring).
      const settings = { enabled: false };
      const scopes = new Map();
      const scopeOf = (sessionId) => {
        const s = state.sessions.get(sessionId);
        if (!s) throw { code: "ACCESS_DENIED", message: "That session is not available to this window." };
        return state.hosts.find((h) => h.label === s.host)?.id ?? null;
      };
      return {
        history_settings_get: () => ({ ...settings }),
        history_settings_set: (a) => Object.assign(settings, a.settings) && { ...settings },
        history_add: (a) => {
          const scope = scopeOf(a.sessionId);
          if (!settings.enabled || a.command.startsWith(" ") || /[\u0000-\u001f]/.test(a.command)) return;
          const list = scopes.get(scope) ?? [];
          const old = list.find((e) => e.command === a.command);
          const entry = { command: a.command, lastUsed: now + list.length + 1, uses: (old?.uses ?? 0) + 1 };
          scopes.set(scope, [...list.filter((e) => e.command !== a.command), entry]);
        },
        history_suggest: (a) => {
          const scope = scopeOf(a.sessionId);
          if (!settings.enabled) return [];
          const recent = [...(scopes.get(scope) ?? [])].reverse().map((e) => e.command);
          if (!a.query.trim()) return recent.slice(0, 8);
          const q = a.query.toLowerCase();
          const starts = recent.filter((c) => c.startsWith(a.query));
          return [...starts, ...recent.filter((c) => !starts.includes(c) && c.toLowerCase().includes(q))].slice(0, 8);
        },
        history_list: () =>
          [...scopes.entries()]
            .flatMap(([hostId, list]) => list.map((e) => ({ hostId, hostLabel: state.hosts.find((h) => h.id === hostId)?.label ?? null, ...e })))
            .sort((x, y) => y.lastUsed - x.lastUsed),
        history_delete: (a) => {
          const list = scopes.get(a.hostId) ?? [];
          if (!list.some((e) => e.command === a.command)) throw { code: "NOT_FOUND", message: "That command is no longer remembered." };
          scopes.set(a.hostId, list.filter((e) => e.command !== a.command));
        },
        history_clear: () => {
          const n = [...scopes.values()].reduce((t, l) => t + l.length, 0);
          scopes.clear();
          return n;
        },
      };
    })(),
    // agent B: tunnels and history
    ...(() => {
      // Synthetic rules and runs. Exposure is checked the way the native side does it, so the
      // approval dialog is exercised; nothing here binds a socket.
      const rules = [];
      const runs = new Map();
      const jumps = new Map();
      const proxies = new Map();
      const keyExchanges = new Map();
      window.__mockKeyExchanges = keyExchanges;
      window.__mockJumps = jumps;
      window.__mockProxies = proxies;
      let nextRule = 1;
      let nextRun = 1;
      const loopback = (h) => /^(localhost|::1|\[::1\]|127\.\d+\.\d+\.\d+)$/i.test(h.trim());
      const exposed = (t) => t.bindHost.trim() !== "" && (t.bindHost.trim() === "*" || !loopback(t.bindHost));
      const hostLabel = (hostId) => state.hosts.find((h) => h.id === hostId)?.label ?? null;
      const summary = (t) => ({ ...t, hostLabel: hostLabel(t.hostId) });
      const view = (r) => ({ ...r.view });
      window.__mockTunnelRuns = runs;
      return {
        tunnel_list: () => rules.map(summary),
        tunnel_save: (a) => {
          const t = a.tunnel;
          if (!t.name.trim()) throw { code: "INVALID_INPUT", message: "Enter a name." };
          if (exposed(t) && !t.allowExternal) {
            throw { code: "INVALID_INPUT", message: "This listener would be reachable from other computers. Confirm that exposure to save it." };
          }
          const bindHost = t.bindHost.trim() || (t.kind === "remote" ? "localhost" : "127.0.0.1");
          const saved = { ...t, id: t.id ?? id(800 + nextRule++), bindHost, allowExternal: exposed(t), updatedAt: now };
          delete saved.hostLabel;
          const at = rules.findIndex((r) => r.id === saved.id);
          if (at >= 0) rules[at] = saved;
          else rules.push(saved);
          return summary(saved);
        },
        tunnel_duplicate: (a) => {
          const source = rules.find((r) => r.id === a.id);
          if (!source) throw { code: "NOT_FOUND", message: "That tunnel no longer exists." };
          const copy = { ...source, id: id(800 + nextRule++), name: `${source.name} (copy)`, autoStart: false };
          rules.push(copy);
          return summary(copy);
        },
        tunnel_delete: (a) => {
          const at = rules.findIndex((r) => r.id === a.id);
          if (at >= 0) rules.splice(at, 1);
        },
        tunnel_start: (a) => {
          const session = state.sessions.get(a.sessionId);
          const rule = rules.find((r) => r.id === a.tunnelId);
          if (!session) throw { code: "ACCESS_DENIED", message: "That session is not available to this window." };
          if (!rule) throw { code: "NOT_FOUND", message: "That tunnel no longer exists." };
          if (hostLabel(rule.hostId) !== session.host) throw { code: "INVALID_INPUT", message: "That tunnel belongs to a different host than this session." };
          if ([...runs.values()].some((r) => r.view.state === "running" && r.view.tunnelId === rule.id && r.view.sessionId === a.sessionId)) {
            throw { code: "CONFLICT", message: "That tunnel is already running on this session." };
          }
          if (rule.bindPort === 8080) {
            throw { code: "IN_USE", message: "The listen port could not be opened. It may be in use, or need administrator rights." };
          }
          const runId = `${nextRun++}`.padStart(32, "c");
          const run = {
            view: {
              runId,
              tunnelId: rule.id,
              sessionId: a.sessionId,
              name: rule.name,
              kind: rule.kind,
              bindHost: rule.bindHost,
              boundPort: rule.bindPort || 40000 + nextRun,
              destHost: rule.destHost,
              destPort: rule.destPort,
              state: "running",
              activeConnections: 0,
              totalConnections: 0,
              refusedConnections: 0,
              failedConnections: 0,
              bytesOut: 0,
              bytesIn: 0,
              error: null,
            },
          };
          runs.set(runId, run);
          return view(run);
        },
        // Quick port forwards (P-24): only ports suggested to the session are accepted, as natively.
        quick_forward_start: (a) => {
          const session = state.sessions.get(a.sessionId);
          if (!session) throw { code: "ACCESS_DENIED", message: "That session is not available to this window." };
          if (!(window.__mockSuggested.get(a.sessionId) ?? new Set()).has(a.port)) {
            throw { code: "INVALID_INPUT", message: "That port was not offered for this session." };
          }
          const runId = `${nextRun++}`.padStart(32, "c");
          const run = {
            view: {
              runId,
              tunnelId: `port:${a.port}`,
              sessionId: a.sessionId,
              name: `Port ${a.port}`,
              kind: "local",
              bindHost: "127.0.0.1",
              boundPort: a.port,
              destHost: "127.0.0.1",
              destPort: a.port,
              state: "running",
              activeConnections: 0,
              totalConnections: 0,
              refusedConnections: 0,
              failedConnections: 0,
              bytesOut: 0,
              bytesIn: 0,
              error: null,
            },
          };
          runs.set(runId, run);
          return view(run);
        },
        quick_forward_open: (a) => {
          const run = runs.get(a.runId);
          if (!run || run.view.state !== "running" || !run.view.tunnelId.startsWith("port:")) {
            throw { code: "ACCESS_DENIED", message: "That tunnel is not available to this window." };
          }
          const url = `http://127.0.0.1:${run.view.boundPort}/`;
          window.__mockOpenedQuick.push(url);
          return url;
        },
        host_port_suggestions_set: (a) => {
          window.__mockPortSuggestionsOff[a.enabled ? "delete" : "add"](a.hostId);
        },
        tunnel_stop: (a) => {
          const run = runs.get(a.runId);
          if (!run || run.view.state !== "running") throw { code: "NOT_FOUND", message: "That tunnel is not running." };
          run.view.state = "stopped";
          run.view.activeConnections = 0;
        },
        tunnel_active: () => {
          for (const run of runs.values()) {
            if (run.view.state === "running" && !state.sessions.has(run.view.sessionId)) {
              run.view.state = "session_ended";
              run.view.activeConnections = 0;
            }
          }
          return [...runs.values()].map(view).sort((x, y) => (x.state === "running" ? 0 : 1) - (y.state === "running" ? 0 : 1));
        },
        tunnel_clear_ended: () => {
          for (const [key, run] of runs) if (run.view.state !== "running") runs.delete(key);
        },
        host_connection_get: (a) => {
          const own = window.__mockOwnRoute.has(a.hostId) || jumps.has(a.hostId) || proxies.has(a.hostId);
          return {
            jumpHostId: jumps.get(a.hostId) ?? null,
            proxy: proxies.get(a.hostId) ?? null,
            own,
            inherited: window.__mockInheritedRoute(a.hostId),
            keyExchange: keyExchanges.get(a.hostId) ?? "prefer_post_quantum",
            noPortSuggestions: window.__mockPortSuggestionsOff.has(a.hostId),
          };
        },
        host_connection_set: (a) => {
          if (!["prefer_post_quantum", "require_post_quantum", "classic"].includes(a.connection.keyExchange ?? "prefer_post_quantum")) {
            throw { code: "INVALID_INPUT", message: "Unknown key exchange setting." };
          }
          keyExchanges.set(a.hostId, a.connection.keyExchange ?? "prefer_post_quantum");
          window.__mockPortSuggestionsOff[a.connection.noPortSuggestions ? "add" : "delete"](a.hostId);
          // HST-05: inheriting drops the host's own route.
          if (a.connection.inherit) {
            jumps.delete(a.hostId);
            proxies.delete(a.hostId);
            window.__mockOwnRoute.delete(a.hostId);
            return [];
          }
          window.__mockOwnRoute.add(a.hostId);
          // Loops are refused as natively; the chain is returned first hop first.
          const next = a.connection.jumpHostId;
          for (let at = next, n = 0; at; at = jumps.get(at), n += 1) {
            if (at === a.hostId || n > 8) throw { code: "INVALID_INPUT", message: "These jump hosts would form a loop. Choose a different jump host." };
          }
          if (next) jumps.set(a.hostId, next);
          else jumps.delete(a.hostId);
          const p = a.connection.proxy;
          if (p) {
            const before = proxies.get(a.hostId);
            const keep = p.password === null && before?.passwordStored && before.username === p.username.trim();
            proxies.set(a.hostId, { kind: p.kind, host: p.host, port: p.port, username: p.username.trim(), passwordStored: p.username.trim() !== "" && (keep || !!p.password) });
          } else proxies.delete(a.hostId);
          const chain = [];
          for (let at = a.hostId; at; at = jumps.get(at)) chain.unshift(at);
          return chain.map((hostId) => {
            const h = state.hosts.find((x) => x.id === hostId);
            return { hostId, label: h?.label ?? "", address: h?.address ?? "", port: h?.port ?? 22 };
          });
        },
      };
    })(),
    // Session recordings
    ...(() => {
      // Synthetic recordings. Nothing is encrypted here: the format and its verification are
      // tested natively (crates/session-log, crates/core/tests/history.rs).
      const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
      const fail = (code, message) => {
        throw { code, message };
      };
      let settings = { enabled: false, keepPerHost: 5, maxLogMib: 64 };
      const base = Date.parse("2026-10-11T09:00:00Z");
      const hostId = (label) => state.hosts.find((h) => h.label === label)?.id ?? null;
      const hostile =
        "deploy@staging-web:~$ cat notes\r\n" +
        "\u001b]8;;https://attacker.example/\u0007open the runbook\u001b]8;;\u0007\r\n" +
        "\u001b]52;c;cHduZWQ=\u0007\u001b]0;not your title\u0007" +
        "rollout finished: 12 pods ready\r\ndeploy@staging-web:~$ ";
      const logs = options.recordings
        ? [
            {
              id: "a1".repeat(16),
              title: "staging-web",
              hostId: hostId("staging-web"),
              kind: "ssh",
              startedAt: base + 2 * 3600_000,
              endedAt: base + 2 * 3600_000 + 754_000,
              sizeBytes: 18_432,
              state: "complete",
              bookmarked: true,
              comment: "Rollout of 2.4 — pods restarted twice",
              frames: [
                { type: "output", atMs: 0, data: b64("Welcome to Ubuntu 24.04.1 LTS\r\n") },
                { type: "resize", atMs: 300, cols: 100, rows: 30 },
                { type: "output", atMs: 900, data: b64(hostile) },
              ],
            },
            {
              id: "b2".repeat(16),
              title: "api-gateway",
              hostId: hostId("api-gateway"),
              kind: "ssh",
              startedAt: base + 3600_000,
              endedAt: null,
              sizeBytes: 4_096,
              state: "incomplete",
              bookmarked: false,
              comment: "",
              frames: [{ type: "output", atMs: 0, data: b64("deploy@api-gateway:~$ uptime\r\n 09:12 up 41 days\r\n") }],
            },
            {
              id: "c3".repeat(16),
              title: "Local terminal",
              hostId: null,
              kind: "local",
              startedAt: base,
              endedAt: base + 61_000,
              sizeBytes: 2_048,
              state: "damaged",
              bookmarked: false,
              comment: "",
              frames: [{ type: "output", atMs: 0, data: b64("~ % make test\r\nok\r\n") }],
            },
          ]
        : [];
      window.__mockRecordings = logs;
      const summary = ({ frames, ...log }) => ({ ...log });
      const find = (id) => logs.find((l) => l.id === id) ?? fail("NOT_FOUND", "That recording no longer exists.");
      return {
        recording_settings_get: () => ({ ...settings }),
        recording_settings_set: (a) => {
          const next = a.settings;
          if (!(next.keepPerHost >= 1 && next.keepPerHost <= 100)) fail("INVALID_INPUT", "Keep between 1 and 100 recordings per host.");
          if (!(next.maxLogMib >= 1 && next.maxLogMib <= 512)) fail("INVALID_INPUT", "A recording's size limit must be between 1 and 512 MiB.");
          // Saving takes a moment natively (an encrypted vault write); quick successive changes
          // must not overwrite one another.
          return new Promise((resolve) =>
            setTimeout(() => {
              settings = { ...next };
              resolve({ ...settings });
            }, 150),
          );
        },
        session_log_list: () => [...logs].sort((x, y) => y.startedAt - x.startedAt).map(summary),
        session_log_storage: () => ({ count: logs.length, totalBytes: logs.reduce((n, l) => n + l.sizeBytes, 0) }),
        session_log_bookmark: (a) => {
          const log = find(a.id);
          const comment = a.comment.trim();
          if (comment.length > 2000) fail("INVALID_INPUT", "A comment can be at most 2,000 characters.");
          Object.assign(log, { bookmarked: a.bookmarked, comment });
          return summary(log);
        },
        session_log_delete: (a) => {
          const log = find(a.id);
          if (log.state === "recording") fail("INVALID_INPUT", "This session is still being recorded. Close it first.");
          logs.splice(logs.indexOf(log), 1);
        },
        session_log_delete_all: () => {
          const gone = logs.filter((l) => l.state !== "recording");
          for (const log of gone) logs.splice(logs.indexOf(log), 1);
          return gone.length;
        },
        session_log_open: (a) => {
          const log = find(a.id);
          if (log.state === "unreadable") fail("NOT_FOUND", "This recording's file is missing or cannot be read.");
          return { log: summary(log), cols: 80, rows: 24, frames: log.frames, truncated: false };
        },
      };
    })(),
    files_copy: (a) => {
      if (!state.sessions.has(a.srcSession) || !state.sessions.has(a.dstSession)) fsErr("ACCESS_DENIED", "That session is not available to this window.");
      const node = fs.get(childPath(a.srcDir, a.name));
      const target = childPath(a.dstDir, a.name);
      if (fs.has(target) && a.choice === "ask") fsErr("CONFLICT", "Something with that name is already there.");
      const finalName = fs.has(target) && a.choice === "keep_both" ? a.name.replace(/(\.[^.]+)?$/, " (1)$1") : a.name;
      const transferId = id(9000 + nextTransfer++);
      channelSend(a.events, { type: "progress", done: Math.floor((node.size ?? 0) / 2) });
      window.__mockTransfers.set(transferId, {
        finish: () => {
          if (!fs.has(childPath(a.dstDir, finalName))) addNode(childPath(a.dstDir, finalName), node.kind, node.size ?? null);
          channelSend(a.events, { type: "done", bytes: node.size ?? 0, files: 1, skipped: 0 });
        },
        cancel: () => channelSend(a.events, { type: "cancelled" }),
        progress: (done) => channelSend(a.events, { type: "progress", done }),
        fail: (message) => channelSend(a.events, { type: "failed", error: { code: "IO_ERROR", message } }),
      });
      return { transferId, name: finalName, direction: "copy", total: node.size };
    },
    // Dropped-file uploads: content arrives in ordered pieces; only a complete one appears.
    files_upload_begin: (a) => {
      const target = childPath(a.dir, a.name);
      if (fs.has(target) && a.choice === "ask") fsErr("CONFLICT", "Something with that name is already there.");
      const name = fs.has(target) && a.choice === "keep_both" ? a.name.replace(/(\.[^.]+)?$/, " (1)$1") : a.name;
      const uploadId = id(9500 + nextTransfer++);
      streams.set(uploadId, { dir: a.dir, name, size: a.size, written: 0 });
      return { uploadId, name };
    },
    files_upload_chunk: (a, o) => {
      const s = streams.get(o.headers["x-upload"]);
      if (!s) fsErr("ACCESS_DENIED", "That upload is not running in this window.");
      if (Number(o.headers["x-offset"]) !== s.written) fsErr("INVALID_INPUT", "The upload arrived out of order and was stopped.");
      s.written += a.length ?? a.byteLength ?? 0;
      window.__mockDropped.push({ name: s.name, bytes: a.length ?? a.byteLength });
    },
    files_upload_finish: (a) => {
      const s = streams.get(a.uploadId);
      streams.delete(a.uploadId);
      if (!s || s.written !== s.size) fsErr("INVALID_INPUT", "The upload ended before all of the file arrived.");
      addNode(childPath(s.dir, s.name), "file", s.size, 0o644);
      return s.name;
    },
    files_upload_abort: (a) => {
      streams.delete(a.uploadId);
    },
    // P-29: the system save dialog is not shown in UI tests; the text is kept for assertions.
    terminal_output_save: (a) => {
      window.__mockSavedOutput = a.text;
      return "command-output.txt";
    },
    diagnostics_report: (a) => {
      window.__mockReports.push(a.entries);
      return "tyrminal-diagnostics-2026-10-12.txt";
    },
    serial_ports: () => ["/dev/ttyUSB0", "/dev/ttyACM0"],
    terminal_choices: () => ["/bin/bash", "/bin/zsh", "/usr/bin/fish"],
    editor_pick_app: (a) => {
      const extension = a.extension.replace(/^\./, "").toLowerCase();
      state.prefs = {
        ...state.prefs,
        editorApps: [...state.prefs.editorApps.filter((e) => e.extension !== extension), { extension, app: "/Applications/Text Editor.app" }],
      };
      return structuredClone(state.prefs);
    },
    files_local_list: (a) => {
      if (!localPicks.has(a.token)) fsErr("ACCESS_DENIED", "Choose the file or folder again.");
      if (a.path.some((n) => n === ".." || n.includes("/"))) fsErr("ACCESS_DENIED", "That is outside the folder you chose.");
      return { token: a.token, rootName: "Projects", path: a.path, entries: localEntries(a.path), truncated: false };
    },
    // Changes inside the chosen local folder (the SFTP tab's local pane).
    files_local_mkdir: (a) => {
      if (!localPicks.has(a.token)) fsErr("ACCESS_DENIED", "Choose the file or folder again.");
      if (!a.name || a.name.includes("/") || a.name === "..") fsErr("INVALID_INPUT", "That name cannot be used on this computer.");
      const key = a.path.join("/");
      const list = localTree.get(key) ?? [];
      if (list.some((e) => e.name === a.name)) fsErr("CONFLICT", "Something with that name is already there.");
      list.push({ name: a.name, kind: "dir" });
      localTree.set(key, list);
      localTree.set(key ? `${key}/${a.name}` : a.name, []);
    },
    files_local_rename: (a) => {
      const list = localTree.get(a.path.join("/")) ?? [];
      if (list.some((e) => e.name === a.to)) fsErr("CONFLICT", "Something with that name is already there.");
      const entry = list.find((e) => e.name === a.from);
      if (!entry) fsErr("NOT_FOUND", "The local file or folder is no longer there.");
      entry.name = a.to;
    },
    files_local_remove: (a) => {
      const key = a.path.join("/");
      const list = localTree.get(key) ?? [];
      const sub = key ? `${key}/${a.name}` : a.name;
      if ((localTree.get(sub) ?? []).length > 0) fsErr("IO_ERROR", "Only an empty folder can be deleted.");
      localTree.set(key, list.filter((e) => e.name !== a.name));
      localTree.delete(sub);
    },
    files_local_chmod: () => null,
    files_edit_open: (a) => {
      const node = fs.get(childPath(a.dir, a.name));
      if (!node || node.kind !== "file") fsErr("INVALID_INPUT", "Only files can be opened for editing.");
      const editId = id(7000 + edits.size);
      edits.set(editId, { editId, name: a.name, changed: false, serverChanged: false });
      return { editId, name: a.name, changed: false };
    },
    files_edit_status: (a) => {
      const e = edits.get(a.editId);
      if (!e) fsErr("ACCESS_DENIED", "That file is not open for editing in this window.");
      return { editId: e.editId, name: e.name, changed: e.changed };
    },
    files_edit_save: (a) => {
      const e = edits.get(a.editId);
      if (e.serverChanged && !a.overwrite) fsErr("CONFLICT", "The file changed on the server since you opened it.");
      e.changed = false;
      e.serverChanged = false;
      return { editId: e.editId, name: e.name, changed: false };
    },
    files_edit_close: (a) => {
      edits.delete(a.editId);
    },
    files_list: (a) => {
      // Tests make the next listings fail to see the error state and its retry.
      if ((window.__mockListFail ?? 0) > 0) {
        window.__mockListFail -= 1;
        fsErr("ACCESS_DENIED", "The server refused to list this folder.");
      }
      const path = a.path ?? "/home/deploy";
      const node = fs.get(path.replace(/(.)\/+$/, "$1"));
      if (!node) fsErr("NOT_FOUND", "That file or folder does not exist on the server.");
      if (node.kind !== "dir") fsErr("IO_ERROR", "The server could not do that.");
      const dir = path.replace(/(.)\/+$/, "$1");
      const entries = children(dir)
        .map((p) => ({ name: p.slice(p.lastIndexOf("/") + 1), ...fs.get(p) }))
        .sort((x, y) => (x.kind === "dir") === (y.kind === "dir") ? x.name.localeCompare(y.name) : x.kind === "dir" ? -1 : 1);
      const parent = dir === "/" ? null : dir.slice(0, dir.lastIndexOf("/")) || "/";
      const listing = { path: dir, parent, entries, truncated: false };
      // Tests set a delay to see the loading state of a folder being opened.
      const delay = window.__mockListDelay ?? 0;
      return delay > 0 ? new Promise((resolve) => setTimeout(() => resolve(listing), delay)) : listing;
    },
    files_mkdir: (a) => {
      const p = childPath(a.dir, a.name);
      if (fs.has(p)) fsErr("IO_ERROR", "The server could not do that. The name may exist already, the folder may not be empty, or its disk may be full.");
      addNode(p, "dir");
    },
    files_rename: (a) => {
      const from = childPath(a.dir, a.from);
      const to = childPath(a.dir, a.to);
      if (fs.has(to)) fsErr("CONFLICT", "Something with that name is already there.");
      for (const [p, node] of [...fs]) {
        if (p === from || p.startsWith(`${from}/`)) {
          fs.delete(p);
          fs.set(to + p.slice(from.length), node);
        }
      }
    },
    files_remove: (a) => {
      const p = childPath(a.dir, a.name);
      if (fs.get(p)?.kind === "dir" && children(p).length > 0)
        fsErr("IO_ERROR", "The server could not do that. The name may exist already, the folder may not be empty, or its disk may be full.");
      fs.delete(p);
    },
    files_chmod: (a) => {
      const node = fs.get(childPath(a.dir, a.name));
      node.permissions = a.mode;
    },
    files_pick_upload: () => {
      const picks = (window.__mockUploadPicks ?? [{ name: "notes.txt", size: 2048 }]).map((p, i) => ({ token: `up-${nextTransfer}-${i}`, ...p }));
      for (const p of picks) localPicks.set(p.token, p);
      return picks;
    },
    files_pick_upload_folder: () => {
      const pick = { token: `upf-${nextTransfer}`, name: "site", size: null, folder: { files: 3, bytes: 6144, skipped: 1 } };
      localPicks.set(pick.token, pick);
      return { token: pick.token, name: pick.name, size: null };
    },
    files_pick_folder: () => {
      const pick = { token: `dl-${nextTransfer}`, name: "Downloads", size: null };
      localPicks.set(pick.token, pick);
      return pick;
    },
    files_upload: (a) => {
      let pick = localPicks.get(a.token);
      if (pick && a.path && a.path.length > 0) {
        const name = a.path[a.path.length - 1];
        const entry = (localTree.get(a.path.slice(0, -1).join("/")) ?? []).find((e) => e.name === name);
        pick = entry?.kind === "dir" ? { name, size: null, folder: { files: 1, bytes: 204800, skipped: 0 } } : { name, size: entry?.size ?? 0 };
      }
      if (!pick) fsErr("ACCESS_DENIED", "Choose the file or folder again.");
      let finalName = pick.name;
      if (a.choice === "keep_both") {
        for (let n = 1; fs.has(childPath(a.dir, finalName)); n += 1) {
          const dot = pick.name.lastIndexOf(".");
          finalName = dot > 0 ? `${pick.name.slice(0, dot)} (${n})${pick.name.slice(dot)}` : `${pick.name} (${n})`;
        }
      }
      const target = childPath(a.dir, finalName);
      if (fs.has(target) && (a.choice !== "replace" || pick.folder)) fsErr("CONFLICT", "Something with that name is already there.");
      const transferId = id(9000 + nextTransfer++);
      const total = pick.folder ? pick.folder.bytes : pick.size;
      channelSend(a.events, { type: "progress", done: Math.floor(total / 2) });
      window.__mockTransfers.set(transferId, {
        finish: () => {
          if (pick.folder) addNode(target, "dir");
          else addNode(target, "file", pick.size);
          channelSend(a.events, { type: "done", bytes: total, files: pick.folder?.files ?? 1, skipped: pick.folder?.skipped ?? 0 });
        },
        cancel: () => channelSend(a.events, { type: "cancelled" }),
        progress: (done) => channelSend(a.events, { type: "progress", done }),
        fail: (message) => channelSend(a.events, { type: "failed", error: { code: "IO_ERROR", message } }),
      });
      return { transferId, name: finalName, direction: "upload", total };
    },
    files_download: (a) => {
      if (!localPicks.has(a.token)) fsErr("ACCESS_DENIED", "Choose the file or folder again.");
      const path = childPath(a.dir, a.name);
      const node = fs.get(path);
      const isDir = node.kind === "dir";
      if (window.__mockLocalFiles.has(a.name) && a.choice !== "keep_both" && (a.choice !== "replace" || isDir))
        fsErr("CONFLICT", "Something with that name is already there.");
      const inside = isDir ? [...fs.keys()].filter((p) => p.startsWith(`${path}/`) && fs.get(p).kind === "file") : [];
      const size = isDir ? inside.reduce((n, p) => n + fs.get(p).size, 0) : node.size;
      const transferId = id(9000 + nextTransfer++);
      channelSend(a.events, { type: "progress", done: Math.floor(size / 4) });
      window.__mockTransfers.set(transferId, {
        finish: () => {
          window.__mockLocalFiles.add(a.name);
          if (a.path) {
            const key = a.path.join("/");
            const list = localTree.get(key) ?? [];
            if (!list.some((e) => e.name === a.name)) list.push({ name: a.name, kind: isDir ? "dir" : "file", size: isDir ? null : size });
            localTree.set(key, list);
          }
          channelSend(a.events, { type: "done", bytes: size, files: isDir ? inside.length : 1, skipped: 0 });
        },
        cancel: () => channelSend(a.events, { type: "cancelled" }),
        progress: (done) => channelSend(a.events, { type: "progress", done }),
        fail: (message) => channelSend(a.events, { type: "failed", error: { code: "IO_ERROR", message } }),
      });
      return { transferId, name: a.name, direction: "download", total: size };
    },
    files_cancel: (a) => {
      window.__mockTransfers.get(a.transferId)?.cancel();
      window.__mockTransfers.delete(a.transferId);
    },
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
    backup_export: () => {
      state.lastBackupAt = Math.floor(Date.now() / 1000);
      return "tyrminal-backup-2026-10-11.tyrbackup";
    },
    // The native web view zoom, emulated with CSS zoom so layout (and terminal fit) follow it.
    ui_zoom_set: (a) => {
      if (!(a.scale >= 0.5 && a.scale <= 2)) throw { code: "INVALID_INPUT", message: "That interface size is not allowed." };
      window.__mockZoom = [...(window.__mockZoom ?? []), a.scale];
      document.documentElement.style.zoom = String(a.scale);
    },
    backup_status: () => ({ lastExportAt: state.lastBackupAt ?? null }),
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
    // terminal notifications (P-23): mirrors the native text; records what was asked.
    notify_command_finished: (a) => {
      (window.__mockNotices ??= []).push(structuredClone(a));
      const s = Math.round(a.durationMs / 1000);
      const took = s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
      const body = a.exitStatus === 0 ? `Command finished successfully after ${took}.` : a.exitStatus === null ? `Command finished after ${took}.` : `Command failed with exit status ${a.exitStatus} after ${took}.`;
      return { title: a.tabTitle.trim() || "Tyrminal", body, shown: true };
    },
    prefs_get: () => {
      // Like the preferences file, what was saved survives a reload of the page.
      try {
        const saved = sessionStorage.getItem("tyrminal-mock-prefs");
        if (saved) state.prefs = JSON.parse(saved);
      } catch {}
      return structuredClone(state.prefs);
    },
    prefs_set: (a) => {
      state.prefs = structuredClone(a.prefs);
      try {
        sessionStorage.setItem("tyrminal-mock-prefs", JSON.stringify(state.prefs));
      } catch {}
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
    host_list: () => state.hosts.map(hostView),
    host_recent: () => state.hosts.filter((h) => h.lastConnectedAt).sort((a, b) => b.lastConnectedAt - a.lastConnectedAt).map(hostView),
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
        protocol: a.host.protocol ?? { type: "ssh" },
        terminal: a.host.terminal ?? { encoding: "utf8", term: "xterm256color", pasteSkipMultiline: false, pasteSkipTrailingNewline: false },
        forwardAgent: a.host.forwardAgent ?? false,
        // The host's own flag is kept in ownProduction; the record carries what summaries show.
        production: null,
        // Starring is its own command; editing keeps it.
        favourite: existing?.favourite ?? false,
        // Serial hosts have no port; Telnet defaults to 23.
        ...(a.host.protocol?.type === "telnet" && a.host.port === null ? { port: 23 } : {}),
      };
      state.hosts = existing ? state.hosts.map((h) => (h.id === saved.id ? saved : h)) : [...state.hosts, saved];
      state.ownProduction ??= new Set();
      if (a.host.production) state.ownProduction.add(saved.id);
      else state.ownProduction.delete(saved.id);
      return hostView(saved);
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
    host_favourite_set: (a) => {
      const host = state.hosts.find((h) => h.id === a.id);
      if (!host) throw { code: "NOT_FOUND", message: "That host no longer exists." };
      host.favourite = a.favourite;
      return hostView(host);
    },
    host_duplicate: (a) => {
      const source = state.hosts.find((h) => h.id === a.id);
      const copy = { ...structuredClone(source), id: id(450 + state.hosts.length), label: `${source.label} (copy)`, lastConnectedAt: null, favourite: false };
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
    key_deploy_preview: (a) => {
      const key = state.keys.find((k) => k.id === a.keyId);
      return { path: "~/.ssh/authorized_keys", existingKeys: 2, alreadyPresent: Boolean(state.deployed?.has(a.keyId)), line: key.publicKey };
    },
    key_deploy: (a) => {
      state.deployed ??= new Set();
      state.deployed.add(a.keyId);
      const key = state.keys.find((k) => k.id === a.keyId);
      return { path: "~/.ssh/authorized_keys", existingKeys: 3, alreadyPresent: true, line: key.publicKey };
    },
    group_list: () => structuredClone(state.groups),
    group_save: (a) => {
      const existing = state.groups.find((g) => g.id === a.group.id);
      const saved = { ...a.group, production: a.group.production ?? false, id: existing?.id ?? id(600 + state.groups.length) };
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
      // A tiny stand-in for the core parser: one host per "Host <name>" line, ProxyCommand
      // ignored and noted, a single-hop ProxyJump to another host of the file kept as jumpVia.
      const hosts = [];
      const skipped = [];
      a.text.split("\n").forEach((line, i) => {
        const [key, value] = line.trim().split(/\s+/);
        const last = hosts.at(-1);
        if (key?.toLowerCase() === "host" && value)
          hosts.push({ label: value, address: value, port: 22, username: "", group: "", tags: [], notes: [], jumpVia: null, jump: null });
        if (key?.toLowerCase() === "proxycommand") {
          skipped.push({ line: i + 1, text: line.trim(), reason: "runs a command; ignored (commands from imported files are never run)" });
          last?.notes.push("Its ProxyCommand was ignored (commands from imported files are never run).");
        }
        if (key?.toLowerCase() === "proxyjump" && last) last.jump = value;
      });
      for (const h of hosts) {
        if (h.jump && hosts.some((x) => x.label === h.jump)) {
          h.jumpVia = h.jump;
          h.notes.push(`Goes through the jump host ${h.jump} (from ProxyJump).`);
        }
        delete h.jump;
      }
      return { hosts, skipped, duplicates: hosts.filter((h) => state.hosts.some((x) => x.label === h.label)).map((h) => h.label) };
    },
    import_hosts: (a) => {
      const firstId = 700 + state.hosts.length;
      const ids = new Map(a.hosts.map((h, i) => [h.label, id(firstId + i)]));
      for (const h of a.hosts) {
        if (h.jumpVia) window.__mockJumps.set(ids.get(h.label), ids.get(h.jumpVia));
        state.hosts.push({
          id: ids.get(h.label),
          label: h.label,
          address: h.address,
          port: h.port,
          username: h.username,
          auth: { kind: "ask_password" },
          inherited: { username: h.username === "", port: false, auth: false },
          groupId: a.intoGroup,
          tags: h.tags,
          lastConnectedAt: null,
          protocol: { type: "ssh" },
          terminal: { encoding: "utf8", term: "xterm256color", pasteSkipMultiline: false, pasteSkipTrailingNewline: false },
          forwardAgent: false,
          favourite: false,
        });
      }
      return a.hosts.length;
    },
    key_list: () => structuredClone(state.keys),
    known_host_list: () => structuredClone(state.knownHosts),
    known_host_remove: (a) => {
      if (String(a.reason ?? "").trim().length < 3) throw { code: "INVALID_INPUT", message: "Say why you are removing this key." };
      state.knownHosts = state.knownHosts.filter((k) => k.id !== a.id);
    },
    // security review (P-27): the same rules as crates/core/src/security_review.rs, over mock state.
    security_review: () => {
      const reviewedAt = Math.floor(Date.now() / 1000);
      const ssh = state.hosts.filter((h) => (h.protocol?.type ?? "ssh") === "ssh");
      const usedBy = (keyId) => ssh.filter((h) => h.auth.kind === "key" && h.auth.keyId === keyId).length;
      const findings = [];
      for (const k of state.keys) {
        if (k.algorithm === "ssh-dss") findings.push({ kind: "dsa_key", keyId: k.id, label: k.label, usedBy: usedBy(k.id) });
        else if (k.algorithm === "ssh-rsa" && (k.bits ?? 3072) < 3072) findings.push({ kind: "short_rsa_key", keyId: k.id, label: k.label, bits: k.bits, usedBy: usedBy(k.id) });
        if (!k.passphraseProtected || k.passphraseStored)
          findings.push({ kind: "key_without_passphrase", keyId: k.id, label: k.label, passphraseStored: k.passphraseProtected, usedBy: usedBy(k.id) });
      }
      for (const h of ssh) {
        if (h.auth.kind !== "key") findings.push({ kind: "password_sign_in", hostId: h.id, label: h.label, stored: h.auth.kind === "stored_password" });
      }
      for (const c of Object.values(state.certificates ?? {})) {
        const label = state.keys.find((k) => k.id === c.keyId)?.label ?? "";
        if (c.validBefore !== null && c.validBefore <= reviewedAt) findings.push({ kind: "certificate_expired", keyId: c.keyId, label, validBefore: c.validBefore });
        else if (c.validBefore !== null && c.validBefore - reviewedAt <= 30 * 86400)
          findings.push({ kind: "certificate_expiring", keyId: c.keyId, label, validBefore: c.validBefore });
      }
      const used = new Set(ssh.map((h) => `${h.address.toLowerCase()}:${h.port}`));
      const stronger = new Set(state.knownHosts.filter((k) => k.algorithm !== "ssh-rsa").map((k) => `${k.host}:${k.port}`));
      for (const k of state.knownHosts) {
        const endpoint = `${k.host}:${k.port}`;
        if (!used.has(endpoint))
          findings.push({ kind: "unused_known_host", knownHostId: k.id, host: k.host, port: k.port, algorithm: k.algorithm, fingerprint: k.fingerprint });
        if (k.algorithm === "ssh-rsa" && !stronger.has(endpoint))
          findings.push({ kind: "ssh_rsa_only_known_host", knownHostId: k.id, host: k.host, port: k.port, fingerprint: k.fingerprint });
      }
      const rank = ["dsa_key", "short_rsa_key", "certificate_expired", "certificate_expiring", "password_sign_in", "key_without_passphrase", "unused_known_host", "ssh_rsa_only_known_host"];
      const severity = (f) =>
        f.kind === "dsa_key" || f.kind === "certificate_expired" || (f.kind === "short_rsa_key" && f.bits < 2048)
          ? 0
          : ["short_rsa_key", "password_sign_in", "certificate_expiring"].includes(f.kind)
            ? 1
            : 2;
      const name = (f) => (f.label ?? f.host).toLowerCase();
      findings.sort((a, b) => severity(a) - severity(b) || rank.indexOf(a.kind) - rank.indexOf(b.kind) || name(a).localeCompare(name(b)));
      return { findings, keys: state.keys.length, hosts: ssh.length, certificates: Object.keys(state.certificates ?? {}).length, knownHosts: state.knownHosts.length, reviewedAt };
    },
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
    // quick connect: validated like the core (address shape, port, user for SSH).
    session_open_quick: (a) => {
      const { input } = a;
      if (!/^\[?[A-Za-z0-9._:-]+\]?$/.test(input.address) || input.address.includes("@")) throw { code: "INVALID_INPUT", message: "The address must be a host name or an IP address, without a scheme, user or path." };
      if (!(input.port >= 1 && input.port <= 65535)) throw { code: "INVALID_INPUT", message: "The port must be between 1 and 65535." };
      if (input.protocol === "ssh" && !input.username && input.auth.kind !== "identity") throw { code: "INVALID_INPUT", message: "Enter the user name." };
      return openSession(a, "ssh");
    },
    session_open_local: (a) => openSession(a, "local"),
    session_open_files: (a) => openSession(a, "files"),
    // Signs in with a typed password, whatever the host uses (to install a key).
    session_open_key_install: (a) => {
      const host = state.hosts.find((h) => h.id === a.hostId);
      const sessionId = `${state.nextSession++}`.padStart(32, "a");
      state.sessions.set(sessionId, { id: sessionId, output: null, events: a.events, user: host.username, host: host.label, line: "", files: true });
      setTimeout(() => {
        channelSend(a.events, { type: "state", state: "authenticating", hop: null });
        channelSend(a.events, { type: "auth_prompt", promptId: "k1", kind: "password", username: host.username, attempt: 1, maxAttempts: 3, message: null, echo: false, hop: null });
      }, 20);
      return { sessionId };
    },
    session_open_exec: (a) => openSession(a, "exec"),
    session_auth_answer: (a) => {
      const s = state.sessions.get(a.sessionId);
      if (!s) return;
      if (a.secret === null) {
        state.sessions.delete(s.id);
        channelSend(s.events, { type: "state", state: "failed" });
        channelSend(s.events, { type: "closed", error: { code: "CANCELLED", message: "The connection was cancelled." }, exitStatus: null });
        return;
      }
      channelSend(s.events, NEGOTIATED);
      channelSend(s.events, { type: "state", state: "connected" });
      if (s.output) channelSend(s.output, new TextEncoder().encode(banner(s)).buffer);
    },
    session_write: (a, o) => write(o.headers["x-session"], a),
    // P-33: containers on the host of an SSH session. Tests replace the list via __mockContainers.
    containers_list: (a) => {
      if (!state.sessions.has(a.sessionId)) throw { code: "ACCESS_DENIED", message: "That session is not available to this window." };
      return (
        window.__mockContainers ?? {
          engine: "docker",
          containers: [
            { id: "4f1c2b3a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a", name: "web", image: "nginx:1.27", status: "Up 3 hours" },
            { id: "0a1b2c3d4e5f", name: "<img src=x onerror=window.__pwned=1>", image: "evil/<b>bold</b>", status: "Up 5 minutes" },
          ],
          problem: null,
          skipped: 1,
        }
      );
    },
    container_session_open: (a) => {
      if (!state.sessions.has(a.sessionId)) throw { code: "ACCESS_DENIED", message: "That session is not available to this window." };
      // Like the core: anything that is not a container ID is refused before a session exists.
      if (!/^[0-9a-f]{12,64}$/.test(a.containerId)) throw { code: "INVALID_INPUT", message: "That is not a container ID." };
      return openSession(a, "local");
    },
    session_diagnostics: () => {
      // terminal input: tests can replace the lines or make the request fail.
      if (window.__mockDiagnosticsError) throw { code: "NOT_FOUND", message: "No details are kept for that session any more." };
      return window.__mockDiagnostics ?? ["     0.002s  connecting to 192.0.2.10:22 directly", "     0.120s  key exchange mlkem768x25519-sha256, host key ssh-ed25519, cipher chacha20-poly1305@openssh.com, strict kex on", "     0.380s  signed in", "     0.410s  shell opened (xterm-256color, 100x30)"];
    },
    session_resize: () => null,
    session_ack: () => null,
    session_close: (a) => {
      state.sessions.delete(a.sessionId);
      // Runs on a closed connection stop, as in the core.
      for (const [runId, run] of state.runs ?? []) if (run.sessionId === a.sessionId) run.stop("The session was closed, so the run stopped.");
    },
    session_trust_answer: (a) => {
      const s = state.sessions.get(a.sessionId);
      if (s && a.decision !== "cancel") {
        channelSend(s.events, NEGOTIATED);
        channelSend(s.events, { type: "state", state: "connected" });
        if (s.output) channelSend(s.output, new TextEncoder().encode(banner(s)).buffer);
        const host = state.hosts.find((h) => h.label === s.host);
        if (host && !s.files) setTimeout(() => window.__mockRunStartup?.(s, host), 30);
      }
    },
    // compromised-password check (SEC-11): unavailable like the real build unless a test says so.
    password_check_status: () => ({
      enabled: state.prefs.passwordCheck.enabled,
      endpoint: state.prefs.passwordCheck.endpoint,
      available: Boolean(options.passwordCheckAvailable),
      unavailableReason: options.passwordCheckAvailable
        ? null
        : "This build cannot contact a password-check service yet: it has no HTTPS client. The setting is kept for when it does.",
      storedPasswords: state.hosts.filter((h) => h.auth.kind === "stored_password").length,
    }),
    password_check_run: () => {
      if (!state.prefs.passwordCheck.enabled) throw { code: "INVALID_INPUT", message: "Turn on the compromised-password check first. It is off until you do." };
      if (!options.passwordCheckAvailable)
        throw { code: "UNREACHABLE", message: "This build cannot contact a password-check service yet: it has no HTTPS client. The setting is kept for when it does." };
      return {
        items: [
          { kind: "host", label: "edge-cache", breachCount: 10434004 },
          { kind: "identity", label: "Ops", breachCount: 0 },
        ],
        requests: 2,
      };
    },
    // privilege prompts (KEY-18)
    session_identity: (a) => {
      const s = state.sessions.get(a.sessionId);
      if (!s) throw { code: "ACCESS_DENIED", message: "That session is not available to this window." };
      if (!s.hostId) return null;
      const effective = identityAssignment({ kind: "host", hostId: s.hostId }).effectiveIdentityId;
      const identity = identityState.list.find((i) => i.id === effective);
      return identity ? { identityId: identity.id, label: identity.label, hasPassword: identity.password !== null } : null;
    },
    session_insert_identity_password: (a) => {
      const current = handlers.session_identity({ sessionId: a.sessionId });
      if (!current || current.identityId !== a.identityId)
        throw { code: "CONFLICT", message: "The identity of this host changed. Check which identity it uses and try again." };
      const password = identityState.list.find((i) => i.id === a.identityId)?.password;
      if (!password) throw { code: "INVALID_INPUT", message: "This identity has no stored password." };
      // Typed by the "core": the renderer never receives the password, and no Enter is added.
      write(a.sessionId, new TextEncoder().encode(password));
    },
    app_info: () => ({
      commit: "1a2b3c4",
      buildDate: "2026-10-12",
      os: "linux",
      arch: "x86_64",
      tauriVersion: "2.12.1",
      webviewVersion: "2.50.1",
    }),
    // LAN discovery: synthetic announcements (documentation addresses), never a real network.
    discovery_networks: () => options.discoveryNetworks ?? [{ id: "en0", addresses: ["192.0.2.20", "fe80::1"] }],
    discovery_start: (a) => {
      if (!(options.discoveryNetworks ?? [{ id: "en0" }]).some((n) => n.id === a.networkId)) {
        throw { code: "INVALID_INPUT", message: "That network is not available. Choose one from the list." };
      }
      state.discovery = { running: true, secondsLeft: 30, found: [], truncated: false };
      return { ...state.discovery };
    },
    discovery_status: () => {
      const d = state.discovery ?? { running: false, secondsLeft: 0, found: [], truncated: false };
      if (d.running) {
        d.secondsLeft = Math.max(0, d.secondsLeft - 1);
        d.found = [
          { name: "Build server", host: "build.local", addresses: ["192.0.2.30"], port: 22 },
          { name: "<img src=x onerror=alert(1)>", host: "nas.local", addresses: ["192.0.2.40", "2001:db8::40"], port: 2222 },
        ];
      }
      return { ...d };
    },
    discovery_stop: () => {
      if (state.discovery) Object.assign(state.discovery, { running: false, secondsLeft: 0 });
      return { ...(state.discovery ?? { running: false, secondsLeft: 0, found: [], truncated: false }) };
    },
    // P-30: notes, keyed "host:<id>" / "group:<id>"; seeded only by a test (options.notes).
    note_get: (a) => {
      const key = a.target.kind === "host" ? `host:${a.target.hostId}` : `group:${a.target.groupId}`;
      return state.notes[key] ? { ...state.notes[key] } : null;
    },
    note_set: (a) => {
      const key = a.target.kind === "host" ? `host:${a.target.hostId}` : `group:${a.target.groupId}`;
      if (!a.note || !a.note.text.trim()) {
        delete state.notes[key];
        return null;
      }
      state.notes[key] = { text: a.note.text.replace(/\r\n?/g, "\n"), format: a.note.format, updatedAt: 1760184000 };
      return { ...state.notes[key] };
    },
    note_for_host: (a) => {
      const h = state.hosts.find((x) => x.id === a.hostId);
      if (!h) throw { code: "NOT_FOUND", message: "That host no longer exists." };
      const out = state.notes[`host:${h.id}`] ? [{ note: { ...state.notes[`host:${h.id}`] }, origin: { kind: "host" } }] : [];
      for (let g = state.groups.find((x) => x.id === h.groupId); g; g = state.groups.find((x) => x.id === g.parentId)) {
        if (state.notes[`group:${g.id}`]) out.push({ note: { ...state.notes[`group:${g.id}`] }, origin: { kind: "group", groupId: g.id, name: g.name } });
      }
      return out;
    },
    link_open: (a) => {
      if (!/^https?:\/\//.test(a.url)) throw { code: "INVALID_INPUT", message: "Only web links (http and https) can be opened." };
      window.__mockOpenedLinks.push(a.url);
    },
    // agent D: inventory and snippets
    host_appearance_list: () => {
      const own = Object.entries(state.os ?? {}).map(([hostId, os]) => ({ hostId, os, inherited: false }));
      for (const h of state.hosts) {
        if (state.os?.[h.id]) continue;
        for (let g = state.groups.find((x) => x.id === h.groupId); g; g = state.groups.find((x) => x.id === g.parentId)) {
          const os = groupDefaultsState.get(g.id)?.os;
          if (os) {
            own.push({ hostId: h.id, os, inherited: true });
            break;
          }
        }
      }
      // OS auto-detection: what the server reported, when nobody chose an OS for the host.
      for (const [hostId, os] of Object.entries(state.detectedOs ?? {})) {
        if (!own.some((a) => a.hostId === hostId)) own.push({ hostId, os, inherited: false, detected: true });
      }
      return own;
    },
    os_detection_get: () => state.osDetection !== false,
    os_detection_set: (a) => {
      state.osDetection = a.enabled;
      if (!a.enabled) state.detectedOs = {};
      return a.enabled;
    },
    group_defaults_get: (a) => groupDefaultsView(a.groupId),
    group_defaults_set: (a) => {
      const d = a.defaults;
      if (d.jumpHostId && !state.hosts.some((h) => h.id === d.jumpHostId)) throw { code: "NOT_FOUND", message: "That jump host no longer exists. Choose another." };
      const before = groupDefaultsState.get(a.groupId)?.proxy;
      const proxy = d.proxy
        ? { kind: d.proxy.kind, host: d.proxy.host, port: d.proxy.port, username: d.proxy.username.trim(), passwordStored: d.proxy.username.trim() !== "" && (!!d.proxy.password || (d.proxy.password === null && !!before?.passwordStored)) }
        : null;
      groupDefaultsState.set(a.groupId, { jumpHostId: d.jumpHostId, proxy, os: d.os });
      return groupDefaultsView(a.groupId);
    },
    host_set_os: (a) => {
      state.os ??= {};
      for (const hostId of a.ids) {
        if (!state.hosts.some((h) => h.id === hostId)) throw { code: "NOT_FOUND", message: "A selected host no longer exists." };
      }
      for (const hostId of a.ids) {
        if (a.os === null) delete state.os[hostId];
        else state.os[hostId] = a.os;
      }
      return a.ids.length;
    },
    key_generate: (a) => {
      const algorithms = { ed25519: "ssh-ed25519", ecdsa_p256: "ecdsa-sha2-nistp256", ecdsa_p384: "ecdsa-sha2-nistp384", ecdsa_p521: "ecdsa-sha2-nistp521", rsa3072: "ssh-rsa", rsa4096: "ssh-rsa" };
      const algorithm = algorithms[a.kind ?? "ed25519"];
      const key = { id: id(800 + state.keys.length), label: a.label, algorithm, fingerprint: `SHA256:synthetic${state.keys.length}`, publicKey: `${algorithm} AAAASynthetic ${a.label}`, passphraseProtected: false, passphraseStored: false, usedBy: 0 };
      state.keys = [...state.keys, key];
      return key;
    },
    key_import: (a) => {
      if (a.key.privateKey.startsWith("PuTTY-User-Key-File-3") && !a.key.passphrase) throw { code: "KEY_INVALID", message: "This private key is encrypted. Enter its passphrase to import it." };
      const key = { id: id(850 + state.keys.length), label: a.key.label, algorithm: "ecdsa-sha2-nistp256", fingerprint: "SHA256:imported", publicKey: `ecdsa-sha2-nistp256 AAAAImported ${a.key.label}`, passphraseProtected: Boolean(a.key.passphrase), passphraseStored: a.key.rememberPassphrase, usedBy: 0 };
      state.keys = [...state.keys, key];
      return key;
    },
    // The native dialog: the mock "picks" a synthetic encrypted PuTTY key and keeps its text here.
    key_import_pick_file: () => {
      state.pickedKey = { fileName: "work.ppk", passphraseProtected: true };
      return structuredClone(state.pickedKey);
    },
    key_import_picked: (a) => {
      if (!state.pickedKey) throw { code: "KEY_INVALID", message: "Choose the key file again." };
      if (state.pickedKey.passphraseProtected && !a.passphrase) throw { code: "KEY_INVALID", message: "This private key is encrypted. Enter its passphrase to import it." };
      const key = { id: id(870 + state.keys.length), label: a.label, algorithm: "ecdsa-sha2-nistp256", fingerprint: "SHA256:picked", publicKey: `ecdsa-sha2-nistp256 AAAAPicked ${a.label}`, passphraseProtected: true, passphraseStored: a.rememberPassphrase, usedBy: 0 };
      state.keys = [...state.keys, key];
      state.pickedKey = null;
      return key;
    },
    key_import_pick_clear: () => {
      state.pickedKey = null;
    },
    key_certificate_list: () => Object.values(state.certificates ?? {}),
    key_certificate_attach: (a) => {
      if (!a.certificate.includes("-cert-v01@openssh.com")) throw { code: "KEY_INVALID", message: "That is not a valid OpenSSH certificate, or its signature does not check out." };
      state.certificates ??= {};
      const cert = { keyId: a.keyId, algorithm: a.certificate.split(" ")[0], certKeyId: "synthetic-user", principals: ["tyr"], validAfter: now - 60, validBefore: null, caFingerprint: "SHA256:syntheticCA" };
      state.certificates[a.keyId] = cert;
      return cert;
    },
    key_certificate_remove: (a) => {
      delete state.certificates?.[a.keyId];
    },
    snippet_exec: (a) =>
      new Promise((resolve, reject) => {
        const session = state.sessions.get(a.sessionId);
        if (!session) return reject({ code: "ACCESS_DENIED", message: "That session is not available." });
        state.runs ??= new Map();
        const finish = () => {
          state.runs.delete(a.runId);
          // A stand-in for real hosts: "staging-web" fails, "build-runner-03" hangs until cancelled.
          if (session.host === "staging-web") resolve({ exitStatus: 2, exitSignal: null, stdout: "", stderr: "permission denied\n", truncated: false, envRejected: ["LEGACY_MODE"] });
          else resolve({ exitStatus: 0, exitSignal: null, stdout: `ran on ${session.host}\n`, stderr: "", truncated: false, envRejected: [] });
        };
        if (session.host === "build-runner-03") {
          const stop = (message = "The run was cancelled.") => {
            state.runs.delete(a.runId);
            reject({ code: "CANCELLED", message });
          };
          state.runs.set(a.runId, Object.assign(stop, { sessionId: a.sessionId, stop }));
        }
        else setTimeout(finish, 50);
      }),
    snippet_exec_cancel: (a) => {
      state.runs?.get(a.runId)?.();
      state.runs?.delete(a.runId);
    },
    execution_target_list: () => structuredClone(state.targets ?? []),
    execution_target_save: (a) => {
      state.targets ??= [];
      const saved = { id: id(900 + state.targets.length), name: a.target.name, hostIds: [...new Set(a.target.hostIds)], groupIds: [...new Set(a.target.groupIds ?? [])], missing: 0 };
      state.targets.push(saved);
      return saved;
    },
    execution_target_delete: (a) => {
      state.targets = (state.targets ?? []).filter((t) => t.id !== a.id);
    },
    snippet_move: (a) => {
      const folder = a.folder.trim().replace(/^\/+|\/+$/g, "");
      const out = [];
      for (const sid of a.ids) {
        const source = state.snippets.find((x) => x.id === sid);
        if (a.copy) {
          const copy = { ...source, id: id(950 + state.snippets.length), folder };
          state.snippets.push(copy);
          out.push(copy);
        } else {
          source.folder = folder;
          out.push(source);
        }
      }
      return structuredClone(out);
    },
    snippet_folder_rename: (a) => {
      let n = 0;
      for (const sn of state.snippets) {
        if (sn.folder === a.from || sn.folder.startsWith(`${a.from}/`)) {
          sn.folder = a.to + sn.folder.slice(a.from.length);
          n++;
        }
      }
      return n;
    },
    // A small stand-in for the core known_hosts parser: plain "host type key" lines only.
    known_hosts_import_preview: (a) => {
      const entries = [];
      const skipped = [];
      a.text.split("\n").forEach((line, i) => {
        const t = line.trim();
        if (!t || t.startsWith("#")) return;
        if (t.startsWith("|")) return skipped.push({ line: i + 1, text: t.slice(0, 40), reason: "hashed host name: which host it is for cannot be known" });
        const [host, algorithm, key] = t.split(/\s+/);
        const conflict = state.knownHosts.some((k) => k.host === host && k.port === 22 && k.algorithm === algorithm);
        entries.push({ host, port: 22, algorithm, fingerprint: `SHA256:${key.slice(-12)}`, publicKey: `${algorithm} ${key}`, status: conflict ? "conflict" : "new" });
      });
      return { entries, skipped };
    },
    known_hosts_import: (a) => {
      for (const e of a.entries) state.knownHosts.push({ id: id(980 + state.knownHosts.length), host: e.host, port: e.port, algorithm: e.algorithm, fingerprint: e.fingerprint, addedAt: now });
      return a.entries.length;
    },
    import_known_hosts_preview: () => {
      const used = new Set(state.hosts.map((h) => `${h.address}:${h.port}`));
      const hosts = state.knownHosts
        .filter((k) => !used.has(`${k.host}:${k.port}`))
        .map((k) => ({ label: k.port === 22 ? k.host : `${k.host}:${k.port}`, address: k.host, port: k.port, username: "", group: "", tags: [], notes: [`Trusted ${k.algorithm} key ${k.fingerprint}`] }));
      return { hosts, skipped: [], duplicates: [] };
    },
    env_get: (a) => envState.get(envKey(a.target)) ?? [],
    env_set: (a) => {
      for (const v of a.vars) if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v.name)) throw { code: "INVALID_INPUT", message: "Variable names use letters, digits and _, and do not start with a digit." };
      if (a.vars.length) envState.set(envKey(a.target), a.vars);
      else envState.delete(envKey(a.target));
      return a.vars;
    },
    env_effective: (a) => window.__mockEnvOf(a.hostId, true),
    startup_get: (a) => structuredClone(startupState.get(envKey(a.target)) ?? null),
    startup_set: (a) => {
      const ids = a.snippetIds;
      if (ids && (ids.length > 16 || new Set(ids).size !== ids.length)) throw { code: "INVALID_INPUT", message: "Choose 16 startup snippets at most, each once." };
      for (const sid of ids ?? []) {
        if (!state.snippets.some((x) => x.id === sid)) throw { code: "NOT_FOUND", message: "A startup snippet no longer exists. Choose the snippets again." };
      }
      if (ids === null) startupState.delete(envKey(a.target));
      else startupState.set(envKey(a.target), [...ids]);
      return ids;
    },
    startup_effective: (a) => {
      const { ids, origin } = startupOf(a.hostId);
      return { snippets: ids.map((snippetId) => ({ snippetId, name: state.snippets.find((x) => x.id === snippetId)?.name ?? null })), origin };
    },
    identity_list: () =>
      identityState.list.map((i) => ({
        id: i.id,
        label: i.label,
        username: i.username,
        hasPassword: i.password !== null,
        keyId: i.keyId,
        usedBy: [...identityState.uses.values()].filter((u) => u === i.id).length,
      })),
    identity_save: (a) => {
      const input = a.identity;
      if (!input.label.trim()) throw { code: "INVALID_INPUT", message: "Enter a name." };
      const existing = identityState.list.find((i) => i.id === input.id);
      const password = input.password.kind === "set" ? input.password.value : input.password.kind === "clear" ? null : (existing?.password ?? null);
      const record = { id: existing?.id ?? id(1100 + identityState.list.length), label: input.label, username: input.username, password, keyId: input.keyId };
      if (existing) Object.assign(existing, record);
      else identityState.list.push(record);
      return handlers.identity_list().find((i) => i.id === record.id);
    },
    identity_delete: (a) => {
      // identity deletion (spec §10.2): refused while in use unless the caller chooses.
      const users = [...identityState.uses].filter(([, v]) => v === a.id).map(([k]) => k);
      if (users.length > 0 && !a.references)
        throw { code: "IN_USE", message: "Hosts or groups use this identity. Choose another identity for them or remove it from them." };
      const replacement = a.references?.kind === "reassign" ? a.references.identityId : null;
      identityState.list = identityState.list.filter((i) => i.id !== a.id);
      for (const k of users) {
        if (replacement) identityState.uses.set(k, replacement);
        else identityState.uses.delete(k);
      }
      return users.length;
    },
    // identity deletion (spec §10.2)
    identity_usage: (a) => {
      const uses = [];
      for (const g of state.groups)
        if (identityState.uses.get(`group:${g.id}`) === a.id) uses.push({ target: { kind: "group", groupId: g.id }, label: g.name, direct: true, afterRemoval: null });
      for (const h of state.hosts) {
        const target = { kind: "host", hostId: h.id };
        const now = identityAssignment(target);
        if (now.effectiveIdentityId !== a.id) continue;
        // What the host uses without it: the same resolution with the identity's uses removed.
        const saved = new Map(identityState.uses);
        for (const [k, v] of saved) if (v === a.id) identityState.uses.delete(k);
        const next = identityAssignment(target).effectiveIdentityId;
        identityState.uses = saved;
        const other = identityState.list.find((i) => i.id === next);
        const key = h.auth.kind === "key" ? state.keys.find((k) => k.id === h.auth.keyId) : null;
        const afterRemoval = other
          ? { kind: "identity", identityId: other.id, label: other.label }
          : key
            ? { kind: "key", keyId: key.id, label: key.label }
            : h.auth.kind === "stored_password"
              ? { kind: "stored_password" }
              : { kind: "ask_password" };
        uses.push({ target, label: h.label, direct: now.origin?.kind === "host", afterRemoval });
      }
      return uses.sort((x, y) => x.label.toLowerCase().localeCompare(y.label.toLowerCase()));
    },
    identity_assignments: () => [
      ...state.hosts.map((h) => identityAssignment({ kind: "host", hostId: h.id })),
      ...state.groups.map((g) => identityAssignment({ kind: "group", groupId: g.id })),
    ],
    identity_assign: (a) => {
      const key = a.target.kind === "host" ? `host:${a.target.hostId}` : `group:${a.target.groupId}`;
      if (a.identityId) identityState.uses.set(key, a.identityId);
      else identityState.uses.delete(key);
      return identityAssignment(a.target);
    },
    prompt_marks_status: (a) => integrationStatus(a.target),
    prompt_marks_install: (a) => {
      integration.set(integrationKey(a.target), 1);
      return integrationStatus(a.target);
    },
    prompt_marks_remove: (a) => {
      integration.delete(integrationKey(a.target));
      return integrationStatus(a.target);
    },
  };

  /** Writes raw terminal output (escape sequences included) to the most recent session. */
  window.__mockOutput = (text) => {
    const last = [...state.sessions.values()].at(-1);
    if (last) channelSend(last.output, new TextEncoder().encode(text).buffer);
  };
  // agent C: workspaces — raw output bytes (legacy encodings) to the most recent session.
  window.__mockOutputBytes = (bytes) => {
    const last = [...state.sessions.values()].at(-1);
    if (last) channelSend(last.output, Uint8Array.from(bytes).buffer);
  };
  /** Quick port forwards (P-24): the newest session's output named `port`, as the core reports it. */
  window.__mockSuggested = new Map();
  window.__mockOpenedQuick = [];
  window.__mockPortSuggestionsOff = new Set();
  window.__mockSuggestPort = (port) => {
    const last = [...state.sessions.values()].at(-1);
    if (!last) return;
    if (!window.__mockSuggested.has(last.id)) window.__mockSuggested.set(last.id, new Set());
    window.__mockSuggested.get(last.id).add(port);
    channelSend(last.events, { type: "port_suggestion", port });
  };
  /** Ends the running LAN discovery as if its time ran out. */
  window.__mockDiscoveryFinish = () => {
    if (state.discovery) Object.assign(state.discovery, { running: false, secondsLeft: 0 });
  };
  /** Ends the newest session as a network drop (or with another error code). */
  window.__mockDrop = (code = "DISCONNECTED") => {
    const last = [...state.sessions.values()].at(-1);
    if (!last) return;
    state.sessions.delete(last.id);
    channelSend(last.events, { type: "state", state: "failed" });
    channelSend(last.events, { type: "closed", error: { code, message: "The server closed the connection." }, exitStatus: null });
  };
  // terminal input: drop the n-th open session (creation order), not only the newest.
  window.__mockDropAt = (index) => {
    const s = [...state.sessions.values()][index];
    if (!s) return;
    state.sessions.delete(s.id);
    channelSend(s.events, { type: "state", state: "failed" });
    channelSend(s.events, { type: "closed", error: { code: "DISCONNECTED", message: "The server closed the connection." }, exitStatus: null });
  };
  // agent D: inventory and snippets
  window.__mockAddFile = (path) => addNode(path, "file", 10);
  /** Environment variables in the mock, per target; hosts get their group chain's, outermost first. */
  const envState = new Map();
  // HST-05: group route and icon defaults; hosts that set their own route.
  const groupDefaultsState = new Map();
  window.__mockOwnRoute = new Set();
  const groupRoute = (groupId) => {
    const d = groupDefaultsState.get(groupId);
    return d && (d.jumpHostId || d.proxy) ? d : null;
  };
  window.__mockInheritedRoute = (hostId) => {
    const host = state.hosts.find((h) => h.id === hostId);
    for (let g = state.groups.find((x) => x.id === host?.groupId); g; g = state.groups.find((x) => x.id === g.parentId)) {
      const r = groupRoute(g.id);
      if (r) return { jumpHostId: r.jumpHostId === hostId ? null : r.jumpHostId, proxy: r.proxy, origin: { kind: "group", groupId: g.id, name: g.name } };
    }
    return null;
  };
  function groupDefaultsView(groupId) {
    const own = groupDefaultsState.get(groupId) ?? { jumpHostId: null, proxy: null, os: null };
    let inheritedRoute = null;
    let inheritedOs = null;
    const group = state.groups.find((g) => g.id === groupId);
    for (let g = state.groups.find((x) => x.id === group?.parentId); g; g = state.groups.find((x) => x.id === g.parentId)) {
      const origin = { kind: "group", groupId: g.id, name: g.name };
      const r = groupRoute(g.id);
      if (!inheritedRoute && r) inheritedRoute = { jumpHostId: r.jumpHostId, proxy: r.proxy, origin };
      const os = groupDefaultsState.get(g.id)?.os;
      if (!inheritedOs && os) inheritedOs = [os, origin];
    }
    return { jumpHostId: own.jumpHostId, proxy: own.proxy, os: own.os, inheritedRoute, inheritedOs };
  }
  // Startup snippet lists by `host:<id>` / `group:<id>` (absent: inherit).
  const startupState = new Map();
  function startupOf(hostId) {
    const own = startupState.get(`host:${hostId}`);
    if (own) return { ids: own, origin: { kind: "host" } };
    const host = state.hosts.find((h) => h.id === hostId);
    for (let g = state.groups.find((x) => x.id === host?.groupId); g; g = state.groups.find((x) => x.id === g.parentId)) {
      const list = startupState.get(`group:${g.id}`);
      if (list) return { ids: list, origin: { kind: "group", groupId: g.id, name: g.name } };
    }
    return { ids: [], origin: null };
  }
  window.__mockRunStartup = (s, host) => {
    if (!host) return;
    for (const sid of startupOf(host.id).ids) {
      const snippet = state.snippets.find((x) => x.id === sid);
      if (snippet) write(s.id, new TextEncoder().encode(`${snippet.text.replace(/\n$/, "").replaceAll("\n", "\r")}\r`));
    }
  };
  function envKey(target) {
    return target.kind === "host" ? `host:${target.hostId}` : `group:${target.groupId}`;
  }
  window.__mockEnvOf = (hostId, withOrigin = false) => {
    const host = state.hosts.find((h) => h.id === hostId);
    const chain = [];
    let group = state.groups.find((g) => g.id === host?.groupId);
    while (group) {
      chain.unshift(group);
      group = state.groups.find((g) => g.id === group.parentId);
    }
    const out = new Map();
    for (const g of chain) for (const v of envState.get(`group:${g.id}`) ?? []) out.set(v.name, { ...v, origin: { kind: "group", groupId: g.id, name: g.name } });
    for (const v of envState.get(`host:${hostId}`) ?? []) out.set(v.name, { ...v, origin: { kind: "host" } });
    return [...out.values()].map((v) => (withOrigin ? v : { name: v.name, value: v.value }));
  };
  /** Identities in the mock: the list (passwords kept here only) and which target uses which. */
  // quick connect: a test can seed identities (options.identities).
  const identityState = { list: options.identities ?? [], uses: new Map() };
  function identityAssignment(target) {
    const own = identityState.uses.get(target.kind === "host" ? `host:${target.hostId}` : `group:${target.groupId}`) ?? null;
    if (target.kind === "group") return { target, identityId: own, effectiveIdentityId: own, origin: own ? { kind: "host" } : null };
    if (own) return { target, identityId: own, effectiveIdentityId: own, origin: { kind: "host" } };
    let group = state.groups.find((g) => g.id === state.hosts.find((h) => h.id === target.hostId)?.groupId);
    while (group) {
      const fromGroup = identityState.uses.get(`group:${group.id}`);
      if (fromGroup) return { target, identityId: null, effectiveIdentityId: fromGroup, origin: { kind: "group", groupId: group.id, name: group.name } };
      group = state.groups.find((g) => g.id === group.parentId);
    }
    return { target, identityId: null, effectiveIdentityId: null, origin: null };
  }
  /** Shell integration in the mock: per target, installed or not (the block text is fixed). */
  const integration = new Map();
  function integrationKey(target) {
    return target.kind === "session" ? "server" : `local:${target.shell}`;
  }
  function integrationStatus(target) {
    const shell = target.kind === "session" ? "bash" : target.shell;
    const path = shell === "zsh" ? "~/.zshrc" : "~/.bashrc";
    return {
      shell,
      path,
      fileExists: true,
      version: 1,
      installedVersion: integration.get(integrationKey(target)) ?? null,
      script: `# >>> tyrminal shell integration v1 >>>\n# (${shell} script)\n# <<< tyrminal shell integration <<<\n`,
      backupPath: `${path}.tyrminal-backup`,
      loginShell: target.kind === "session" ? "sh" : null,
    };
  }
  // terminal notifications: output to the n-th open session (creation order).
  window.__mockOutputAt = (index, text) => {
    const s = [...state.sessions.values()][index];
    if (s) channelSend(s.output, new TextEncoder().encode(text).buffer);
  };
  window.__mockCalls = calls;
  window.__mockFileSessions = window.__mockFileSessions ?? [];
  window.__mockOpenedLinks = [];
  window.__mockState = state;
  window.__mockEmit = emit;

  let serial = Promise.resolve();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  window.__TAURI_INTERNALS__ = {
    // agent C: workspaces — a page can play a detached window (options.windowLabel).
    metadata: {
      currentWindow: { label: options.windowLabel ?? "main" },
      currentWebview: { windowLabel: options.windowLabel ?? "main", label: options.windowLabel ?? "main" },
    },
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
      // Tests can make the next N calls of a command fail (autosave's "Couldn't save – Retry").
      if (window.__mockFailNext?.[cmd] > 0) {
        window.__mockFailNext[cmd] -= 1;
        throw { code: "INTERNAL", message: "The vault could not be written." };
      }
      const handler = handlers[cmd];
      if (!handler) throw { code: "INTERNAL", message: `mock: unhandled ${cmd}` };
      // Tests can make the next call of a command fail (window.__mockFailNext[cmd] = error), or
      // answer late (window.__mockDelay[cmd] = ms), to see rollbacks and loading states.
      const failure = window.__mockFailNext?.[cmd];
      if (failure) {
        delete window.__mockFailNext[cmd];
        if (window.__mockDelay?.[cmd]) await new Promise((r) => setTimeout(r, window.__mockDelay[cmd]));
        throw failure;
      }
      if (window.__mockDelay?.[cmd]) await new Promise((r) => setTimeout(r, window.__mockDelay[cmd]));
      // A vault that serves one request at a time (the core holds one lock per vault call):
      // perf specs see what each extra call on the startup path costs.
      if (options.ipcSerialMs && !cmd.startsWith("plugin:")) {
        const turn = serial.then(() => new Promise((r) => setTimeout(r, options.ipcSerialMs)));
        serial = turn;
        await turn;
      }
      return handler(args, opts);
    },
    convertFileSrc: (path) => path,
  };
}
