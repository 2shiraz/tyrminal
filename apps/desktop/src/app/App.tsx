import type { VaultStatus } from "@tyrminal/contracts";
import { Component, type ReactNode, useCallback, useEffect, useState } from "react";

import { ErrorNotice } from "../components/ui/controls";
import { Onboarding, Unlock } from "../features/vault/VaultScreens";
import { type AppError, toAppError, vault } from "../lib/ipc";
import { msg } from "../lib/messages";
import { AppShell } from "./AppShell";

/** Vault idle lock: five minutes without keyboard or pointer activity (BUILD_SPEC §1.3). */
const IDLE_LOCK_MS = 5 * 60 * 1000;

function useIdleLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer = window.setTimeout(lock, IDLE_LOCK_MS);
    function lock() {
      void vault.lock().catch(() => undefined);
    }
    function reset() {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, IDLE_LOCK_MS);
    }
    const events = ["keydown", "pointerdown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, reset, { capture: true, passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, reset, { capture: true });
    };
  }, [enabled]);
}

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  // While the recovery key from vault creation is on screen, stay on onboarding even though the
  // vault is already unlocked underneath.
  const [onboarding, setOnboarding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await vault.status();
      setStatus(next);
      setError(null);
      if (next.state === "uninitialized") setOnboarding(true);
    } catch (caught) {
      setError(toAppError(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return vault.onStatus(setStatus);
  }, [refresh]);

  const unlocked = status?.state === "unlocked" && !onboarding;
  useIdleLock(unlocked);

  if (error) {
    return (
      <div className="center-screen">
        <div className="card" role="alert">
          <h1>{msg.app.startupFailed}</h1>
          <ErrorNotice error={error} />
          <button type="button" className="btn btn-primary" onClick={() => void refresh()}>
            {msg.app.retry}
          </button>
        </div>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="center-screen" role="status">
        <p className="muted">{msg.app.loading}</p>
      </div>
    );
  }
  if (onboarding) return <Onboarding onDone={() => setOnboarding(false)} />;
  if (status.state === "unlocked") {
    // Keyed by generation: every lock/unlock cycle starts from a clean tree, so nothing rendered
    // from the previous unlocked period (lists, dialogs, terminals) can survive a lock.
    return <AppShell key={status.generation} />;
  }
  return <Unlock busy={status.state === "unlocking"} />;
}

/** Last-resort boundary: a rendering bug shows a recoverable message, not a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center-screen">
        <div className="card" role="alert">
          <h1>{msg.app.startupFailed}</h1>
          <p className="muted">{msg.terminal.safe}</p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {msg.app.retry}
          </button>
        </div>
      </div>
    );
  }
}
