import type { HostSummary } from "@tyrminal/contracts";
import { createContext, useContext } from "react";

/** A connected SSH session in this window, as the snippet run dialog needs it. */
export interface OpenSshSession {
  hostId: string;
  sessionId: string;
}

export interface SnippetRunHost {
  /** Connected SSH sessions of this window right now (read on demand, never cached). */
  sessions: () => OpenSshSession[];
  /** Opens a session to a host in a new tab, through the normal connect path. */
  connect: (host: HostSummary) => void;
}

const none: SnippetRunHost = { sessions: () => [], connect: () => undefined };

/** Provided by the app shell; the default has no sessions, so runs are offered but skip every host. */
export const SnippetRunContext = createContext<SnippetRunHost>(none);

export const useSnippetRunHost = () => useContext(SnippetRunContext);
