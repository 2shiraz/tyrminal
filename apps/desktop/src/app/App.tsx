import type { VaultStatus } from "@tyrminal/contracts";
import { Component, type ReactNode, useCallback, useEffect, useState } from "react";

import { ToastProvider } from "../components/ui/Toasts";
import { ErrorNotice } from "../components/ui/controls";
import { Onboarding, Unlock } from "../features/vault/VaultScreens";
import { type AppError, toAppError, vault } from "../lib/ipc";
import { msg } from "../lib/messages";
import { clearQuick } from "../lib/quickConnect";
import { AppShell } from "./AppShell";
import { PreferencesProvider } from "./preferences";

/** How often, at most, input activity is reported to the native idle-lock timer. */
const ACTIVITY_REPORT_INTERVAL_MS = 5_000;

/**
 * Reports keyboard and pointer activity to the core, which owns the idle-lock timer (five
 * minutes by default). The renderer only postpones the lock; it cannot prevent the core from
 * locking when reports stop, for example because the renderer hung.
 */
function useActivityReports(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    function report() {
      const now = Date.now();
      if (now - last < ACTIVITY_REPORT_INTERVAL_MS) return;
      last = now;
      void vault.noteActivity().catch(() => undefined);
    }
    const events = ["keydown", "pointerdown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, report, { capture: true, passive: true });
    return () => {
      for (const name of events) window.removeEventListener(name, report, { capture: true });
    };
  }, [enabled]);
}

export function App() {
  return (
    <PreferencesProvider>
      <Root />
    </PreferencesProvider>
  );
}

function Root() {
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
  // quick connect: an unsaved connection's details never outlive the unlocked period.
  useEffect(() => {
    if (!unlocked) clearQuick();
  }, [unlocked]);
  useActivityReports(unlocked);

  if (error) {
    return (
      <div className="auth-screen">
        <div className="auth-card" role="alert">
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
      <div className="auth-screen" role="status">
        <div className="row-flex muted">
          <span className="spinner" aria-hidden="true" />
          {msg.app.loading}
        </div>
      </div>
    );
  }
  // A status event can arrive before the first status request returns; an uninitialized vault
  // always means onboarding, never the unlock screen.
  if (onboarding || status.state === "uninitialized") return <Onboarding onDone={() => setOnboarding(false)} />;
  if (status.state === "unlocked") {
    // Keyed by generation: every lock/unlock cycle starts from a clean tree, so nothing rendered
    // from the previous unlocked period (lists, dialogs, terminals) can survive a lock.
    // Toasts live inside the same keyed tree: they can name hosts and snippets, so a lock removes
    // them, and a late notification from the previous period's async work goes nowhere.
    return (
      <ToastProvider key={status.generation}>
        <AppShell />
      </ToastProvider>
    );
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
      <div className="auth-screen">
        <div className="auth-card" role="alert">
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
