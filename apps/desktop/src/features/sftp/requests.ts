// "Open in SFTP" requests (from a host's menu, Host details, the palette or a session's Files
// panel). The shell opens or focuses an SFTP tab and leaves the request here; the tab in front
// takes it and shows that host in its right pane.
import type { Source } from "./SftpPane";

export interface SftpRequest {
  source: Extract<Source, { kind: "host" }>;
  /** A server folder to open (a session's current folder). */
  path: string | null;
}

let pending: SftpRequest[] = [];
const listeners = new Set<() => void>();

export const sftpRequests = {
  push(request: SftpRequest) {
    pending = [...pending, request];
    for (const l of listeners) l();
  },
  /** Takes everything waiting (the tab in front calls this). */
  take(): SftpRequest[] {
    const all = pending;
    pending = [];
    return all;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
