// Uploads of files dropped from the desktop (FIL-05 on the files panel, FIL-18 on a terminal).
// The webview gives the page a dropped file's content but never its path, so the content is sent
// to the core in ordered pieces; the core writes it to a temporary name and renames it into place
// only when every byte arrived.
import type { ConflictChoice, StreamUpload } from "@tyrminal/contracts";

import { files as filesApi, toAppError } from "../../lib/ipc";

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
