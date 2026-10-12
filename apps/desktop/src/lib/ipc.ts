// The only module that talks to the native side. Everything else imports from here, which keeps
// the IPC surface reviewable in one place and gives UI tests a single seam to replace.
//
// Types come from the generated Rust contract. They describe the wire format for the UI's
// convenience; the native side validates every request again.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BackupCredentialKind,
  BackupFile,
  BackupPreview,
  BulkHostChange,
  ConflictChoice,
  EditStatus,
  ErrorCode,
  GroupInput,
  GroupSummary,
  HostInput,
  HostSummary,
  ImportFormat,
  ImportHost,
  ImportPreview,
  IpcError,
  KeyDeployPreview,
  KeyImportInput,
  KeySummary,
  KnownHostSummary,
  LocalListing,
  LocalPick,
  Preferences,
  RecoveryKeyIssued,
  RemoteListing,
  SessionEvent,
  SessionOpened,
  SnippetInput,
  SnippetSendMode,
  SnippetSummary,
  TransferEvent,
  TransferStarted,
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
  /** Whether this device can unlock without the passphrase (OS secret store). */
  quickUnlockStatus: () => call<boolean>("vault_quick_unlock_status"),
  enableQuickUnlock: (passphrase: string) => call<void>("vault_quick_unlock_enable", { passphrase }),
  disableQuickUnlock: () => call<void>("vault_quick_unlock_disable"),
  unlockWithDevice: () => call<void>("vault_unlock_device"),
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
  /** Every term must match: words, `tag:name`, `group:path`. */
  search: (query: string) => call<HostSummary[]>("host_search", { query }),
  /** A full copy (credentials included), never connected. */
  duplicate: (id: string) => call<HostSummary>("host_duplicate", { id }),
  /** One change to many hosts, all or nothing; resolves to how many changed. */
  bulk: (ids: string[], change: BulkHostChange) => call<number>("host_bulk", { ids, change }),
};

export const groups = {
  list: () => call<GroupSummary[]>("group_list"),
  save: (group: GroupInput) => call<GroupSummary>("group_save", { group }),
  remove: (id: string) => call<void>("group_delete", { id }),
};

export const importer = {
  /** `text` is the content of a file the user chose; nothing is written. */
  preview: (format: ImportFormat, text: string) => call<ImportPreview>("import_preview", { format, text }),
  run: (hosts: ImportHost[], intoGroup: string | null) => call<number>("import_hosts", { hosts, intoGroup }),
};

export const keys = {
  list: () => call<KeySummary[]>("key_list"),
  import: (key: KeyImportInput) => call<KeySummary>("key_import", { key }),
  generate: (label: string) => call<KeySummary>("key_generate", { label }),
  remove: (id: string) => call<void>("key_delete", { id }),
  /** Over a connected SSH session this window owns; nothing is written. */
  deployPreview: (sessionId: string, keyId: string) => call<KeyDeployPreview>("key_deploy_preview", { sessionId, keyId }),
  /** Appends the key to the server's authorized keys (an explicit user action). */
  deploy: (sessionId: string, keyId: string) => call<KeyDeployPreview>("key_deploy", { sessionId, keyId }),
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

function transferChannel(onEvent: (event: TransferEvent) => void) {
  const events = new Channel<TransferEvent>();
  events.onmessage = onEvent;
  return events;
}

/**
 * Remote files over SFTP on a connected session. Local files and folders are chosen in native
 * dialogs and referred to by token; the page never sees or supplies a local path.
 */
export const files = {
  list: (sessionId: string, path: string | null) => call<RemoteListing>("files_list", { sessionId, path }),
  mkdir: (sessionId: string, dir: string, name: string) => call<void>("files_mkdir", { sessionId, dir, name }),
  rename: (sessionId: string, dir: string, from: string, to: string) => call<void>("files_rename", { sessionId, dir, from, to }),
  remove: (sessionId: string, dir: string, name: string) => call<void>("files_remove", { sessionId, dir, name }),
  chmod: (sessionId: string, dir: string, name: string, mode: number) => call<void>("files_chmod", { sessionId, dir, name, mode }),
  /** Native file picker; empty if cancelled. */
  pickUpload: () => call<LocalPick[]>("files_pick_upload"),
  /** Native folder picker for a download destination; null if cancelled. */
  pickFolder: () => call<LocalPick | null>("files_pick_folder"),
  /** Native folder picker for a folder to upload; null if cancelled. */
  pickUploadFolder: () => call<LocalPick | null>("files_pick_upload_folder"),
  /** `path`: an item inside a chosen folder (two-pane view); null for the chosen item itself. */
  upload: (sessionId: string, token: string, dir: string, choice: ConflictChoice, onEvent: (event: TransferEvent) => void, path: string[] | null = null) =>
    call<TransferStarted>("files_upload", { sessionId, token, dir, choice, path, events: transferChannel(onEvent) }),
  /** `path`: a folder inside the chosen one to download into (two-pane view). */
  download: (
    sessionId: string,
    dir: string,
    name: string,
    token: string,
    choice: ConflictChoice,
    onEvent: (event: TransferEvent) => void,
    path: string[] | null = null,
  ) => call<TransferStarted>("files_download", { sessionId, dir, name, token, choice, path, events: transferChannel(onEvent) }),
  /** Copies a file or folder from one session's server to another's (streams through the app). */
  copy: (
    srcSession: string,
    srcDir: string,
    name: string,
    dstSession: string,
    dstDir: string,
    choice: ConflictChoice,
    onEvent: (event: TransferEvent) => void,
  ) => call<TransferStarted>("files_copy", { srcSession, srcDir, name, dstSession, dstDir, choice, events: transferChannel(onEvent) }),
  /** Lists a folder inside a local folder the user chose. */
  localList: (token: string, path: string[]) => call<LocalListing>("files_local_list", { token, path }),
  cancel: (transferId: string) => call<void>("files_cancel", { transferId }),
  /** Opens a remote file in the default local application; nothing is uploaded until save. */
  editOpen: (sessionId: string, dir: string, name: string) => call<EditStatus>("files_edit_open", { sessionId, dir, name }),
  editStatus: (editId: string) => call<EditStatus>("files_edit_status", { editId }),
  /** Uploads the local copy; refused with CONFLICT if the server's copy changed, unless overwrite. */
  editSave: (editId: string, overwrite: boolean) => call<EditStatus>("files_edit_save", { editId, overwrite }),
  editClose: (editId: string) => call<void>("files_edit_close", { editId }),
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
  /** Installed shells that can be chosen for local terminals. */
  shells: () => call<string[]>("terminal_choices"),
  /** Chooses (natively) the app that edits remote files with `extension`; null if cancelled. */
  pickEditor: (extension: string) => call<Preferences | null>("editor_pick_app", { extension }),
};

export const links = {
  /** Opens an http(s) link in the OS browser after the user confirmed it. Validated natively. */
  open: (url: string) => call<void>("link_open", { url }),
};

/** Portable backups. Files are picked in native dialogs; paths and bytes never reach the page. */
export const backup = {
  /** Saves a backup of the unlocked vault; resolves to the file name, or null if cancelled. */
  export: () => call<string | null>("backup_export"),
  /** Picks a backup file to restore; null if cancelled. */
  choose: () => call<BackupFile | null>("backup_choose"),
  /** Fully validates the chosen backup with its secret and reports what it holds. */
  preview: (kind: BackupCredentialKind, secret: string) => call<BackupPreview>("backup_preview", { kind, secret }),
  /** Replaces this device's vault with the chosen backup and locks it. */
  restore: (kind: BackupCredentialKind, secret: string, replaceExisting: boolean) =>
    call<BackupPreview>("backup_restore", { kind, secret, replaceExisting }),
};


// agent B: tunnels and history
type TunnelSummaryDto = import("@tyrminal/contracts").TunnelSummary;
type TunnelInputDto = import("@tyrminal/contracts").TunnelInput;
type ActiveTunnelDto = import("@tyrminal/contracts").ActiveTunnel;
type HostConnectionDto = import("@tyrminal/contracts").HostConnection;
type HostConnectionInputDto = import("@tyrminal/contracts").HostConnectionInput;
type ChainHopDto = import("@tyrminal/contracts").ChainHop;

/** Port forwarding. Rules are vault records; forwards run on a connected session of this window. */
export const tunnels = {
  list: () => call<TunnelSummaryDto[]>("tunnel_list"),
  save: (tunnel: TunnelInputDto) => call<TunnelSummaryDto>("tunnel_save", { tunnel }),
  duplicate: (id: string) => call<TunnelSummaryDto>("tunnel_duplicate", { id }),
  remove: (id: string) => call<void>("tunnel_delete", { id }),
  /** Starts a saved rule on a connected SSH session to the rule's host. */
  start: (sessionId: string, tunnelId: string) => call<ActiveTunnelDto>("tunnel_start", { sessionId, tunnelId }),
  stop: (runId: string) => call<void>("tunnel_stop", { runId }),
  /** This window's running and recently ended forwards with live counters. */
  active: () => call<ActiveTunnelDto[]>("tunnel_active"),
  clearEnded: () => call<void>("tunnel_clear_ended"),
  /** A host's jump host and other advanced connection settings. */
  connection: (hostId: string) => call<HostConnectionDto>("host_connection_get", { hostId }),
  setConnection: (hostId: string, connection: HostConnectionInputDto) =>
    call<ChainHopDto[]>("host_connection_set", { hostId, connection }),
  /** The hosts a connection goes through, first hop first, the host itself last. */
  chain: (hostId: string) => call<ChainHopDto[]>("host_chain", { hostId }),
};

// agent D: inventory and snippets

/** Presentation settings of hosts (the OS icon), apart from their connection settings. */
export const appearance = {
  list: () => call<import("@tyrminal/contracts").HostAppearance[]>("host_appearance_list"),
  /** Sets or clears (`null`) the OS of several hosts, all or nothing; resolves to how many changed. */
  setOs: (ids: string[], os: import("@tyrminal/contracts").HostOs | null) => call<number>("host_set_os", { ids, os }),
};

/** Hosts for trusted known-host records that no host uses yet; import them with `importer.run`. */
export const knownHostImport = {
  preview: () => call<ImportPreview>("import_known_hosts_preview"),
};

/** Key types beyond Ed25519, and OpenSSH user certificates for keys in the keychain. */
export const keysD = {
  generate: (label: string, kind: import("@tyrminal/contracts").KeyKind) => call<KeySummary>("key_generate", { label, kind }),
  certificates: () => call<import("@tyrminal/contracts").KeyCertificate[]>("key_certificate_list"),
  attachCertificate: (keyId: string, certificate: string) =>
    call<import("@tyrminal/contracts").KeyCertificate>("key_certificate_attach", { keyId, certificate }),
  removeCertificate: (keyId: string) => call<void>("key_certificate_remove", { keyId }),
  /** Native file dialog; the key stays on the native side. `null` if cancelled. */
  pickFile: () => call<import("@tyrminal/contracts").PickedKeyFile | null>("key_import_pick_file"),
  importPicked: (label: string, passphrase: string | null, rememberPassphrase: boolean) =>
    call<KeySummary>("key_import_picked", { label, passphrase, rememberPassphrase }),
  clearPicked: () => call<void>("key_import_pick_clear"),
};

/** Snippet runs without a terminal, saved host selections and snippet organization. */
export const snippetsD = {
  exec: (snippetId: string, sessionId: string, runId: string) =>
    call<import("@tyrminal/contracts").SnippetExecResult>("snippet_exec", { snippetId, sessionId, runId }),
  cancel: (runId: string) => call<void>("snippet_exec_cancel", { runId }),
  targets: () => call<import("@tyrminal/contracts").ExecutionTarget[]>("execution_target_list"),
  saveTarget: (target: import("@tyrminal/contracts").ExecutionTargetInput) =>
    call<import("@tyrminal/contracts").ExecutionTarget>("execution_target_save", { target }),
  deleteTarget: (id: string) => call<void>("execution_target_delete", { id }),
  move: (ids: string[], folder: string, copy: boolean) => call<SnippetSummary[]>("snippet_move", { ids, folder, copy }),
  renameFolder: (from: string, to: string) => call<number>("snippet_folder_rename", { from, to }),
};

/** Trust keys from an OpenSSH known_hosts file after a preview (text of a file the user picked). */
export const knownHostsFile = {
  preview: (text: string) => call<import("@tyrminal/contracts").KnownHostImportPreview>("known_hosts_import_preview", { text }),
  run: (entries: import("@tyrminal/contracts").KnownHostImportEntry[]) => call<number>("known_hosts_import", { entries }),
};

/** Opt-in shell integration: status, and install/remove only on the user's explicit action. */
export const promptMarks = {
  status: (target: import("@tyrminal/contracts").IntegrationTarget) =>
    call<import("@tyrminal/contracts").IntegrationStatus>("prompt_marks_status", { target }),
  install: (target: import("@tyrminal/contracts").IntegrationTarget) =>
    call<import("@tyrminal/contracts").IntegrationStatus>("prompt_marks_install", { target }),
  remove: (target: import("@tyrminal/contracts").IntegrationTarget) =>
    call<import("@tyrminal/contracts").IntegrationStatus>("prompt_marks_remove", { target }),
};

/** Reusable identities and which hosts and groups use them. Passwords are write-only. */
export const identities = {
  list: () => call<import("@tyrminal/contracts").IdentitySummary[]>("identity_list"),
  save: (identity: import("@tyrminal/contracts").IdentityInput) =>
    call<import("@tyrminal/contracts").IdentitySummary>("identity_save", { identity }),
  /** Resolves to how many hosts and groups were using it. */
  remove: (id: string) => call<number>("identity_delete", { id }),
  assignments: () => call<import("@tyrminal/contracts").IdentityAssignment[]>("identity_assignments"),
  assign: (target: import("@tyrminal/contracts").SettingsTarget, identityId: string | null) =>
    call<import("@tyrminal/contracts").IdentityAssignment>("identity_assign", { target, identityId }),
};
