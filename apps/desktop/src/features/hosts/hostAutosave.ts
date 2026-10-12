// Autosave for the Host details panel. What is written is the "draft": every field that is valid
// now, and the stored value of every field that is not (a new host takes the form's starting
// values instead, and exists only once its address is valid). The jump host and proxy are one
// unit, written only when all of it is valid, in the existing order: before the basics for an
// existing host (a jump-host loop is refused before anything changes), right after creation for a
// new one. Secrets never enter the draft or the autosave key; they are written only by an explicit
// action, and a change that would drop a stored secret waits until the user removes it on purpose.
import type { HostAuthInput, HostConnectionInput, HostInput, HostSummary } from "@tyrminal/contracts";
import { useRef, useState } from "react";

import { type SaveResult, useAutosave } from "../../lib/autosave";
import { hosts as hostsApi, identities as identitiesApi, tunnels as tunnelsApi } from "../../lib/ipc";
import { identityEvents } from "../credentials/IdentitiesSection";
import { parseTags, validAddress, validLabel, validPort, validTags, validUsername } from "./fieldRules";
import type { HostFields, HostForm, LiveHost } from "./hostForm";

interface DraftContext {
  /** The host's own sign-in is a stored password. */
  passwordStored: boolean;
  /** A password is being set with this write. */
  settingPassword?: boolean;
  /** The user chose to remove the stored password. */
  releasePassword?: boolean;
}

/** Whether the sign-in or protocol change in `fields` would drop the host's stored password. */
export function dropsStoredPassword(fields: HostFields, passwordStored: boolean): boolean {
  return passwordStored && (fields.authKind !== "stored_password" || fields.protocol !== "ssh");
}

/**
 * The record to store: valid fields from `fields`, the rest from `stored` (or `base` for a host
 * not created yet). `null` while a new host has no valid address. Pure, for tests and the panel.
 */
export function hostDraft(fields: HostFields, base: HostFields, stored: HostFields | null, ctx: DraftContext): HostFields | null {
  const serial = fields.protocol === "serial";
  const keyValid = serial ? fields.serial.path.trim() !== "" : validAddress(fields.address);
  if (stored === null && !keyValid) return null;
  const from = stored ?? base;
  const d: HostFields = { ...from };
  d.groupId = fields.groupId;
  d.terminal = fields.terminal;
  d.forwardAgent = fields.forwardAgent;
  d.identityId = fields.identityId;
  // Protocol (and a serial host's device, its address).
  if (!serial || fields.serial.path.trim() !== "") {
    d.protocol = fields.protocol;
    d.serial = fields.serial;
  }
  if (validAddress(fields.address)) d.address = fields.address;
  if (validLabel(fields.label)) d.label = fields.label;
  else if (stored === null) d.label = serial ? fields.serial.path.trim() : fields.address.trim();
  if (validPort(fields.port, d.groupId !== null || d.protocol === "telnet")) d.port = fields.port;
  if (validUsername(fields.username)) d.username = fields.username;
  if (validTags(fields.tags)) d.tags = fields.tags;
  const authValid =
    (fields.authKind === "key" && fields.keyId !== "") ||
    (fields.authKind === "inherit" && d.groupId !== null) ||
    fields.authKind === "ask_password" ||
    (fields.authKind === "stored_password" && (ctx.passwordStored || ctx.settingPassword === true));
  if (authValid) {
    d.authKind = fields.authKind;
    d.keyId = fields.keyId;
  }
  // Leaving a stored password removes it: held (sign-in and protocol stay as stored) until the
  // user removes it on purpose, or sets a new one.
  if (!ctx.releasePassword && !ctx.settingPassword && dropsStoredPassword(d, ctx.passwordStored)) {
    d.authKind = from.authKind;
    d.keyId = from.keyId;
    d.protocol = from.protocol;
    d.serial = from.serial;
  }
  return d;
}

/** The command input for a draft; `password` only when one is being set on purpose. */
export function hostInput(d: HostFields, id: string | null, password?: string): HostInput {
  const tags = parseTags(d.tags);
  const port = d.port === "" ? null : Number(d.port);
  if (d.protocol !== "ssh") {
    return {
      id,
      label: d.label,
      address: d.protocol === "serial" ? d.serial.path : d.address,
      port: d.protocol === "serial" ? null : port,
      username: "",
      auth: { kind: "ask_password" },
      groupId: d.groupId,
      tags,
      protocol: d.protocol === "serial" ? { type: "serial", settings: d.serial } : { type: "telnet" },
      terminal: d.terminal,
      forwardAgent: false,
    };
  }
  const auth: HostAuthInput =
    d.authKind === "key"
      ? { kind: "key", keyId: d.keyId }
      : d.authKind === "stored_password"
        ? { kind: "stored_password", password: password ?? null }
        : d.authKind === "inherit"
          ? { kind: "inherit" }
          : { kind: "ask_password" };
  return {
    id,
    label: d.label,
    address: d.address,
    port,
    username: d.username,
    auth,
    groupId: d.groupId,
    tags,
    protocol: { type: "ssh" },
    terminal: d.terminal,
    forwardAgent: d.forwardAgent && d.authKind === "key",
  };
}

/** The route as autosave writes it: never a proxy password unless one is being set. */
function routeInput(input: HostConnectionInput, proxyPassword?: string): HostConnectionInput {
  return { ...input, proxy: input.proxy === null ? null : { ...input.proxy, password: proxyPassword ?? null } };
}

function withoutPassword(fields: HostForm["fields"]): HostFields {
  const { password: _secret, ...rest } = fields;
  return rest;
}

interface WriteOptions {
  password?: string;
  proxyPassword?: string;
  releasePassword?: boolean;
  releaseProxy?: boolean;
  /** Create a prefilled new host the user has not edited (Connect). */
  force?: boolean;
}

export function useHostAutosave(form: HostForm, { host, onSaved }: { host: HostSummary | null; onSaved: (saved: HostSummary) => void }) {
  const formRef = useRef(form);
  formRef.current = form;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const idRef = useRef<string | null>(host?.id ?? null);
  const latest = useRef<HostSummary | null>(host);
  const stored = useRef<HostFields | null>(host ? form.start : null);
  const [passwordStored, setPasswordStored] = useState(host?.auth.kind === "stored_password" && !host.inherited.auth);
  const passwordStoredRef = useRef(passwordStored);
  passwordStoredRef.current = passwordStored;
  // The route as last written (no secret). A write queued behind another can run before React
  // re-renders, while the route still looks changed; this keeps it from being written twice.
  const routeWritten = useRef<string | null>(null);
  // Re-render after a write so the pending key is computed against the new stored record.
  const [, setVersion] = useState(0);

  const fields = withoutPassword(form.fields);
  const isNew = idRef.current === null;
  const touched = !isNew || JSON.stringify(fields) !== JSON.stringify(form.start) || form.advanced.routeChanged;

  /** What one write would do now, without doing it. */
  function plan(options: WriteOptions = {}) {
    const f = formRef.current;
    const current = withoutPassword(f.fields);
    const draft = hostDraft(current, f.start, stored.current, {
      passwordStored: passwordStoredRef.current,
      settingPassword: options.password !== undefined,
      releasePassword: options.releasePassword === true,
    });
    if (draft === null) return null;
    const id = idRef.current;
    const adv = f.advanced;
    const ssh = draft.protocol === "ssh";
    const routeOk = ssh && adv.ready && adv.valid && (!adv.dropsPassword || options.releaseProxy === true || options.proxyPassword !== undefined);
    const routeKey = JSON.stringify(routeInput(adv.input()));
    const explicit = options.proxyPassword !== undefined || options.releaseProxy === true;
    const routeDue = explicit || (adv.routeChanged && routeKey !== routeWritten.current);
    let route = routeOk && routeDue ? routeInput(adv.input(), options.proxyPassword) : null;
    let routeKeyWritten = routeKey;
    // The route is incomplete: key exchange and port suggestions still save, with the stored route.
    if (route === null && ssh && adv.ready && !explicit && adv.settingsChanged) {
      const settings = adv.settingsInput();
      routeKeyWritten = JSON.stringify(settings);
      if (routeKeyWritten !== routeWritten.current) route = settings;
    }
    const before = stored.current ? JSON.stringify(hostInput(stored.current, id)) : null;
    const basics = hostInput(draft, id, options.password);
    const basicsChanged = id === null || options.password !== undefined || JSON.stringify(hostInput(draft, id)) !== before;
    const identityChanged = ssh && f.identity !== undefined && draft.identityId !== (stored.current ?? f.start).identityId;
    return { draft, route, routeKey: routeKeyWritten, basics, basicsChanged, identityChanged };
  }

  async function write(options: WriteOptions = {}): Promise<SaveResult> {
    const p = plan(options);
    if (p === null || (idRef.current === null && !options.force && !touched)) return undefined;
    if (!p.basicsChanged && !p.route && !p.identityChanged) return undefined;
    const f = formRef.current;
    const prev = stored.current;
    const prevRoute = f.advanced.loaded;
    const created = idRef.current === null;
    // Existing host: the route first (one unit), so a refused route changes nothing else.
    if (!created && p.route) {
      await tunnelsApi.setConnection(idRef.current as string, p.route);
      routeWritten.current = p.routeKey;
      f.advanced.markStored(p.route, options.proxyPassword !== undefined);
    }
    if (p.basicsChanged) {
      const saved = await hostsApi.save(p.basics);
      idRef.current = saved.id;
      latest.current = saved;
      stored.current = { ...p.draft, identityId: (prev ?? f.start).identityId };
      const nowStored = p.draft.protocol === "ssh" && p.draft.authKind === "stored_password";
      passwordStoredRef.current = nowStored;
      setPasswordStored(nowStored);
      onSavedRef.current(saved);
    }
    if (created && p.route) {
      await tunnelsApi.setConnection(idRef.current as string, p.route);
      routeWritten.current = p.routeKey;
      f.advanced.markStored(p.route, options.proxyPassword !== undefined);
    }
    if (p.identityChanged) {
      await identitiesApi.assign({ kind: "host", hostId: idRef.current as string }, p.draft.identityId || null);
      identityEvents.changed();
    }
    stored.current = p.draft;
    setVersion((v) => v + 1);
    if (prev === null) return null;
    return () => {
      formRef.current.restore(prev);
      if (p.route) formRef.current.advanced.restore(prevRoute);
    };
  }

  // The autosave key: what would be written, never a secret. `null` when nothing is waiting.
  const p = plan();
  const pending =
    p === null || (isNew && !touched) || (!p.basicsChanged && !p.route && !p.identityChanged)
      ? null
      : JSON.stringify([p.basicsChanged ? p.basics : null, p.identityChanged ? p.draft.identityId : null, p.route]);
  const autosave = useAutosave({ pending, save: () => write() });

  // A secret can be set once the host exists or can be created (a valid address).
  const canCreate = idRef.current !== null || hostDraft(fields, form.start, null, { passwordStored: false }) !== null;
  const live: LiveHost = {
    passwordStored,
    canSet: canCreate,
    isNew,
    dropsPassword: dropsStoredPassword(fields, passwordStored),
    setPassword: () => {
      const password = formRef.current.fields.password;
      if (password === "") return;
      void autosave.commit(async () => {
        try {
          await write({ password, force: true });
        } finally {
          // Cleared after every attempt, as before: the field never holds a sent secret.
          formRef.current.set.setPassword("");
        }
      });
    },
    removePassword: () => void autosave.commit(async () => void (await write({ releasePassword: true }))),
    proxy: {
      canSet: canCreate && form.fields.protocol === "ssh" && form.advanced.valid,
      set: () => {
        const proxyPassword = formRef.current.advanced.proxy.password;
        if (proxyPassword === "") return;
        void autosave.commit(async () => {
          try {
            await write({ proxyPassword, force: true });
          } finally {
            formRef.current.advanced.setProxyPassword("");
          }
        });
      },
      remove: () => void autosave.commit(async () => void (await write({ releaseProxy: true }))),
    },
  };

  /** Writes whatever is waiting (and creates a prefilled host); resolves to the stored host, if any. */
  async function flushForConnect(): Promise<HostSummary | null> {
    const ok = idRef.current === null ? await autosave.commit(async () => void (await write({ force: true }))) : await autosave.flush();
    return ok ? latest.current : null;
  }

  /** A password or proxy password typed but not set. */
  const typedSecret = form.fields.password !== "" || form.advanced.proxy.password !== "";

  return { autosave, live, pending, typedSecret, flushForConnect, latest };
}
