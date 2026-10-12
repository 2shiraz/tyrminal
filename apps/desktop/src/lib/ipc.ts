// The only module that talks to the native side. Everything else imports from here, which keeps
// the IPC surface reviewable in one place and gives UI tests a single seam to replace.
//
// Types come from the generated Rust contract. They describe the wire format for the UI's
// convenience; the native side validates every request again.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ErrorCode,
  HostInput,
  HostSummary,
  IpcError,
  KeyImportInput,
  KeySummary,
  KnownHostSummary,
  Preferences,
  RecoveryKeyIssued,
  SessionEvent,
  SessionOpened,
  SnippetInput,
  SnippetSendMode,
  SnippetSummary,
  TrustDecision,
  VaultStatus,
} from "@tyrminal/contracts";

/** An error from the native side: a stable code plus a safe, fixed message. */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(error: IpcError) {
    super(error.message);
    this.name = "AppError";
    this.code = error.code;
  }
}

function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IpcError).code === "string" &&
    typeof (value as IpcError).message === "string"
  );
}

/** Converts anything thrown by `invoke` into an `AppError` without leaking raw internals to the UI. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isIpcError(error)) return new AppError(error);
  return new AppError({ code: "INTERNAL", message: "Something went wrong inside Tyrminal. Your data has not been changed." });
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toAppError(error);
  }
}

export const vault = {
  status: () => call<VaultStatus>("vault_status"),
  create: (passphrase: string) => call<RecoveryKeyIssued>("vault_create", { passphrase }),
  unlock: (passphrase: string) => call<void>("vault_unlock", { passphrase }),
  unlockWithRecoveryKey: (recoveryKey: string) => call<void>("vault_unlock_recovery", { recoveryKey }),
  lock: () => call<void>("vault_lock"),
  /** Tells the native idle-lock timer that the user is active. */
  noteActivity: () => call<void>("vault_activity"),
  changePassphrase: (current: string, next: string) => call<void>("vault_change_passphrase", { current, new: next }),
  rotateRecoveryKey: (passphrase: string) => call<RecoveryKeyIssued>("vault_rotate_recovery_key", { passphrase }),
  /** Subscribes to vault state changes pushed by the native side. Returns an unsubscribe function. */
  onStatus(handler: (status: VaultStatus) => void): () => void {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<VaultStatus>("vault-status", (event) => {
      if (active) handler(event.payload);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  },
};

export const hosts = {
  list: () => call<HostSummary[]>("host_list"),
  /** Hosts with a recorded connection, most recent first. */
  recent: () => call<HostSummary[]>("host_recent"),
  save: (host: HostInput) => call<HostSummary>("host_save", { host }),
  remove: (id: string) => call<void>("host_delete", { id }),
};

export const keys = {
  list: () => call<KeySummary[]>("key_list"),
  import: (key: KeyImportInput) => call<KeySummary>("key_import", { key }),
  generate: (label: string) => call<KeySummary>("key_generate", { label }),
  remove: (id: string) => call<void>("key_delete", { id }),
};

export const knownHosts = {
  list: () => call<KnownHostSummary[]>("known_host_list"),
  remove: (id: string, reason: string) => call<void>("known_host_remove", { id, reason }),
};

export type OutputHandler = (bytes: Uint8Array) => void;
export type EventHandler = (event: SessionEvent) => void;

function channels(onOutput: OutputHandler, onEvent: EventHandler) {
  const output = new Channel<ArrayBuffer | number[]>();
  output.onmessage = (message) => {
    onOutput(message instanceof ArrayBuffer ? new Uint8Array(message) : Uint8Array.from(message));
  };
  const events = new Channel<SessionEvent>();
  events.onmessage = onEvent;
  return { output, events };
}

export const sessions = {
  openSsh: (hostId: string, cols: number, rows: number, onOutput: OutputHandler, onEvent: EventHandler) =>
    call<SessionOpened>("session_open_ssh", { hostId, cols, rows, ...channels(onOutput, onEvent) }),
  openLocal: (cols: number, rows: number, onOutput: OutputHandler, onEvent: EventHandler) =>
    call<SessionOpened>("session_open_local", { cols, rows, ...channels(onOutput, onEvent) }),
  /** Sends terminal input as a raw byte body; the session id travels in a header. */
  async write(sessionId: string, bytes: Uint8Array): Promise<void> {
    try {
      await invoke("session_write", bytes, { headers: { "x-session": sessionId } });
    } catch (error) {
      throw toAppError(error);
    }
  },
  resize: (sessionId: string, cols: number, rows: number) => call<void>("session_resize", { sessionId, cols, rows }),
  ack: (sessionId: string, bytes: number) => call<void>("session_ack", { sessionId, bytes }),
  close: (sessionId: string) => call<void>("session_close", { sessionId }),
  answerTrust: (sessionId: string, promptId: string, decision: TrustDecision) =>
    call<void>("session_trust_answer", { sessionId, promptId, decision }),
  /** `secret: null` dismisses the prompt. */
  answerAuth: (sessionId: string, promptId: string, secret: string | null) =>
    call<void>("session_auth_answer", { sessionId, promptId, secret }),
};

export const snippets = {
  list: () => call<SnippetSummary[]>("snippet_list"),
  save: (snippet: SnippetInput) => call<SnippetSummary>("snippet_save", { snippet }),
  remove: (id: string) => call<void>("snippet_delete", { id }),
  /**
   * Sends a saved snippet to a session this window owns. The native side reads the text from the
   * vault; `bracketed` reports whether the terminal has bracketed-paste mode on.
   */
  send: (snippetId: string, sessionId: string, mode: SnippetSendMode, bracketed: boolean) =>
    call<void>("snippet_send", { snippetId, sessionId, mode, bracketed }),
};

export const preferences = {
  get: () => call<Preferences>("prefs_get"),
  /** Stores preferences; returns them as validated and clamped by the native side. */
  set: (prefs: Preferences) => call<Preferences>("prefs_set", { prefs }),
};

export const links = {
  /** Opens an http(s) link in the OS browser after the user confirmed it. Validated natively. */
  open: (url: string) => call<void>("link_open", { url }),
};
