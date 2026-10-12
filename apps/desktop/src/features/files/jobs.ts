// Transfer-queue jobs shared by the Files panel and the SFTP tab: each one starts a transfer in
// the core with the user's conflict choice. Nothing here replaces a file by itself: the queue
// asks first ("ask"), then calls again with Replace or Keep both.
import type { RemoteEntry } from "@tyrminal/contracts";

import { files as filesApi } from "../../lib/ipc";
import type { TransferJob } from "./useTransferQueue";

/** A picked file or folder (by token), or a name inside a chosen local folder, to a server folder. */
export function uploadJob(sessionId: string, token: string, dir: string, name: string, folder: boolean, path: string[] | null, onDone?: () => void): TransferJob {
  return {
    name,
    direction: "upload",
    folder,
    remote: true,
    ...(onDone ? { onDone } : {}),
    start: (choice, onEvent) => filesApi.upload(sessionId, token, dir, choice, onEvent, path),
  };
}

/** A server file or folder into a folder on this computer (picked, or inside a chosen folder). */
export function downloadJob(sessionId: string, dir: string, entry: RemoteEntry, token: string, path: string[] | null, onDone?: () => void): TransferJob {
  return {
    name: entry.name,
    direction: "download",
    folder: entry.kind === "dir",
    remote: false,
    ...(onDone ? { onDone } : {}),
    start: (choice, onEvent) => filesApi.download(sessionId, dir, entry.name, token, choice, onEvent, path),
  };
}

/**
 * A file or folder from one server folder to another, streamed through the app. The same
 * session and folder on both ends is a duplicate, which always keeps both.
 */
export function copyJob(srcSession: string, srcDir: string, entry: RemoteEntry, dstSession: string, dstDir: string, onDone?: () => void): TransferJob {
  const duplicate = srcSession === dstSession && srcDir === dstDir;
  return {
    name: entry.name,
    direction: "copy",
    folder: entry.kind === "dir",
    remote: true,
    ...(onDone ? { onDone } : {}),
    start: (choice, onEvent) => filesApi.copy(srcSession, srcDir, entry.name, dstSession, dstDir, duplicate ? "keep_both" : choice, onEvent),
  };
}
