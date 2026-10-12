// Command-finished notifications (P-23). A command's start and end come only from the shell
// integration's marks (validated in features/autocomplete/shellContext.ts); output is never
// inspected. When a command that ran at least the configured time finishes in a tab the user is
// not looking at, the native side shows a notification built from the tab title, exit status and
// duration, and the tab is marked until it is shown. Returning to the window soon after a
// notification shows that tab (desktop notifications cannot report the click to the app).

import type { CommandNotifications } from "@tyrminal/contracts";
import { useEffect, useRef } from "react";

import { shellContexts } from "../autocomplete/shellContext";
import { notices } from "../../lib/ipc";

export interface FinishedTab {
  tabId: number;
  title: string;
  /** The tab is in front and the window has focus. */
  inView: boolean;
}

/** How long after a notification a return to the window still means "show me that tab". */
const RETURN_WINDOW_MS = 120_000;

export function useCommandFinished(
  prefs: CommandNotifications,
  tabOf: (sessionId: string) => FinishedTab | null,
  onFinished: (tabId: number, exitStatus: number | null, notice: string) => void,
  showTab: (tabId: number) => void,
): void {
  const started = useRef(new Map<string, number>());
  const latest = useRef({ prefs, tabOf, onFinished, showTab });
  latest.current = { prefs, tabOf, onFinished, showTab };
  const pending = useRef<{ tabId: number; at: number } | null>(null);

  useEffect(
    () =>
      shellContexts.onMark((mark) => {
        if (mark.kind === "command_start") {
          started.current.set(mark.sessionId, Date.now());
          return;
        }
        if (mark.kind !== "command_end") return;
        const start = started.current.get(mark.sessionId);
        started.current.delete(mark.sessionId);
        const { prefs: p, tabOf: find, onFinished: done } = latest.current;
        if (start === undefined || !p.enabled) return;
        const duration = Date.now() - start;
        if (duration < p.minSeconds * 1000) return;
        const tab = find(mark.sessionId);
        if (!tab || tab.inView) return;
        void notices.commandFinished(tab.title, mark.exitStatus, duration).then(
          (notice) => {
            pending.current = { tabId: tab.tabId, at: Date.now() };
            done(tab.tabId, mark.exitStatus, `${notice.title}: ${notice.body}`);
          },
          () => undefined,
        );
      }),
    [],
  );

  useEffect(() => {
    const onFocus = () => {
      const p = pending.current;
      pending.current = null;
      if (p && Date.now() - p.at <= RETURN_WINDOW_MS) latest.current.showTab(p.tabId);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
