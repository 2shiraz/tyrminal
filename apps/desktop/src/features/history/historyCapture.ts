// Feeds command history from shell-integration marks (AUT-01). The command is the text the shell
// showed between its prompt-end and command-start marks (OSC 133 B and C, see
// autocomplete/shellContext.ts), so input typed while a command runs, such as a password at a
// `sudo` prompt, is never captured, and keystrokes are never recorded. While history is off,
// nothing leaves the page. The native side validates every line again and keeps it encrypted.

import { history } from "../../lib/ipc";
import { shellContexts } from "../autocomplete/shellContext";

/** How long the history setting is trusted before it is read again. */
const SETTING_TTL_MS = 5000;

let cached: { on: Promise<boolean>; at: number } | null = null;

/** Whether history is on (cached briefly). */
export function historyOn(): Promise<boolean> {
  if (!cached || performance.now() - cached.at > SETTING_TTL_MS) {
    cached = { on: history.settings().then((s) => s.enabled, () => false), at: performance.now() };
  }
  return cached.on;
}

/** Forgets the cached setting (called after it is changed). */
export function historySettingChanged(): void {
  cached = null;
}

let installed: (() => void) | null = null;

/** Starts following command marks of every session. Idempotent; returns the uninstall. */
export function installHistoryCapture(): () => void {
  if (!installed) {
    const off = shellContexts.onMark((mark) => {
      if (mark.kind !== "command_start" || !mark.command) return;
      const { sessionId, command } = mark;
      // A line typed with a leading space is not remembered (the shell's "ignorespace"), and a
      // multi-line command is not offered (the native side would refuse it anyway).
      if (mark.leadingSpace || command.includes("\n")) return;
      void historyOn()
        .then((on) => (on ? history.add(sessionId, command) : undefined))
        .catch(() => undefined);
    });
    installed = () => {
      off();
      installed = null;
    };
  }
  return installed;
}
