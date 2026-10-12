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
      localShell: null,
      editorApps: [],
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
      protocol: { type: "ssh" },
      terminal: { encoding: "utf8", term: "xterm256color" },
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
    files_copy: (a) => {
      if (!state.sessions.has(a.srcSession) || !state.sessions.has(a.dstSession)) fsErr("ACCESS_DENIED", "That session is not available to this window.");
      const node = fs.get(childPath(a.srcDir, a.name));
      const target = childPath(a.dstDir, a.name);
      if (fs.has(target) && a.choice === "ask") fsErr("CONFLICT", "Something with that name is already there.");
      const finalName = fs.has(target) && a.choice === "keep_both" ? a.name.replace(/(\.[^.]+)?$/, " (1)$1") : a.name;
      const transferId = id(9000 + nextTransfer++);
      channelSend(a.events, { type: "progress", done: Math.floor((node.size ?? 0) / 2) });
      window.__mockTransfers.set(transferId, {
        finish: () => channelSend(a.events, { type: "done", bytes: node.size ?? 0, files: 1, skipped: 0 }),
        cancel: () => channelSend(a.events, { type: "cancelled" }),
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
      const path = a.path ?? "/home/deploy";
      const node = fs.get(path.replace(/(.)\/+$/, "$1"));
      if (!node) fsErr("NOT_FOUND", "That file or folder does not exist on the server.");
      if (node.kind !== "dir") fsErr("IO_ERROR", "The server could not do that.");
      const dir = path.replace(/(.)\/+$/, "$1");
      const entries = children(dir)
        .map((p) => ({ name: p.slice(p.lastIndexOf("/") + 1), ...fs.get(p) }))
        .sort((x, y) => (x.kind === "dir") === (y.kind === "dir") ? x.name.localeCompare(y.name) : x.kind === "dir" ? -1 : 1);
      const parent = dir === "/" ? null : dir.slice(0, dir.lastIndexOf("/")) || "/";
      return { path: dir, parent, entries, truncated: false };
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
        protocol: a.host.protocol ?? { type: "ssh" },
        terminal: a.host.terminal ?? { encoding: "utf8", term: "xterm256color" },
        // Serial hosts have no port; Telnet defaults to 23.
        ...(a.host.protocol?.type === "telnet" && a.host.port === null ? { port: 23 } : {}),
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
          protocol: { type: "ssh" },
          terminal: { encoding: "utf8", term: "xterm256color" },
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
