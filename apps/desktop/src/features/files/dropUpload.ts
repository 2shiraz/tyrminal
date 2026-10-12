// Uploads of files dropped from the desktop (FIL-05 on the files panel, FIL-18 on a terminal).
// The webview gives the page a dropped file's content but never its path, so the content is sent
// to the core in ordered pieces; the core writes it to a temporary name and renames it into place
// only when every byte arrived.
import type { ConflictChoice, StreamUpload } from "@tyrminal/contracts";

import { files as filesApi, toAppError } from "../../lib/ipc";
import type { TransferJob } from "./useTransferQueue";

/** Size of each piece sent to the core (the core accepts at most 4 MiB). */
export const DROP_CHUNK = 1024 * 1024;

export interface StreamOptions {
  /** Called with the bytes sent so far after each piece. */
  onProgress?: (done: number) => void;
  /** Checked before each piece; `true` stops the upload and removes the partial file. */
  shouldStop?: () => boolean;
}

/** Starts an upload; throws the core's error (for example CONFLICT) before anything is sent. */
export function beginUpload(sessionId: string, dir: string, file: File, choice: ConflictChoice): Promise<StreamUpload> {
  return filesApi.uploadBegin(sessionId, dir, file.name, file.size, choice);
}

/**
 * Sends a started upload's content and completes it. Resolves `false` when stopped by
 * `shouldStop`; any failure removes the partial file and is rethrown.
 */
export async function sendUpload(started: StreamUpload, file: File, options: StreamOptions = {}): Promise<boolean> {
  let offset = 0;
  try {
    while (offset < file.size) {
      if (options.shouldStop?.()) {
        await filesApi.uploadAbort(started.uploadId);
        return false;
      }
      const piece = new Uint8Array(await file.slice(offset, offset + DROP_CHUNK).arrayBuffer());
      if (piece.length === 0) break;
      await filesApi.uploadChunk(started.uploadId, offset, piece);
      offset += piece.length;
      options.onProgress?.(offset);
    }
    await filesApi.uploadFinish(started.uploadId);
    return true;
  } catch (caught) {
    const error = toAppError(caught);
    await filesApi.uploadAbort(started.uploadId).catch(() => undefined);
    throw error;
  }
}

/** Dropped-file uploads asked to stop (checked before their next piece). */
const stops = new Set<string>();

/**
 * A file dropped from the desktop onto a server folder, as a transfer-queue job: it asks before
 * replacing like any upload, reports progress per piece and stops between pieces when cancelled.
 */
export function droppedFileJob(sessionId: string, dir: string, file: File, onDone?: () => void): TransferJob {
  return {
    name: file.name,
    direction: "upload",
    folder: false,
    remote: true,
    ...(onDone ? { onDone } : {}),
    cancel: (transferId) => stops.add(transferId),
    start: async (choice, onEvent) => {
      const started = await beginUpload(sessionId, dir, file, choice);
      const transferId = `drop-${started.uploadId}`;
      void sendUpload(started, file, { onProgress: (done) => onEvent({ type: "progress", done }), shouldStop: () => stops.delete(transferId) }).then(
        (completed) => onEvent(completed ? { type: "done", bytes: file.size, files: 1, skipped: 0 } : { type: "cancelled" }),
        (caught) => {
          const e = toAppError(caught);
          onEvent({ type: "failed", error: { code: e.code, message: e.message } });
        },
      );
      return { transferId, name: started.name, direction: "upload", total: file.size };
    },
  };
}

/** Files dropped from the desktop; a dropped folder arrives as an empty "file" and is named. */
export function droppedFiles(data: DataTransfer): { files: File[]; folders: string[] } {
  const items = Array.from(data.items ?? []);
  const files: File[] = [];
  const folders: string[] = [];
  Array.from(data.files).forEach((file, i) => {
    if (items[i]?.webkitGetAsEntry?.()?.isDirectory) folders.push(file.name);
    else files.push(file);
  });
  return { files, folders };
}

/**
 * Uploads a file dropped on an SSH terminal into the session's login folder, keeping both if
 * the name is taken, and returns the path it has on the server.
 */
export async function uploadToSession(sessionId: string, file: File, options: StreamOptions = {}): Promise<string> {
  const home = (await filesApi.list(sessionId, null)).path;
  const started = await beginUpload(sessionId, home, file, "keep_both");
  await sendUpload(started, file, options);
  return `${home.replace(/\/+$/, "")}/${started.name}`;
}

/** Quotes a path for a POSIX shell, so inserting it can never run anything by itself. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}
