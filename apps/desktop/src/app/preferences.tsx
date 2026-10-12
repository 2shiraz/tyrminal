import type { Preferences } from "@tyrminal/contracts";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { preferences as prefsApi } from "../lib/ipc";

const DEFAULTS: Preferences = {
  theme: "system",
  reduceMotion: false,
  terminal: {
    scheme: "tyrminal-night",
    fontFamily: "jetbrains-mono",
    fontSize: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorStyle: "block",
    cursorBlink: true,
    padding: 10,
    scrollback: 5000,
    ligatures: false,
    renderer: "auto",
    confirmMultilinePaste: true,
    copyOnSelect: false,
  },
};

export const DEFAULT_PREFERENCES = DEFAULTS;

interface PreferencesContextValue {
  prefs: Preferences;
  /** The theme actually shown after resolving "system". */
  resolvedTheme: "light" | "dark";
  /** Applies a change immediately and persists it (natively validated). */
  update: (change: (current: Preferences) => Preferences) => void;
  saveError: boolean;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);
  const [system, setSystem] = useState(systemTheme);
  const [saveError, setSaveError] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    prefsApi
      .get()
      .then((loaded) => {
        if (active) setPrefs(loaded);
      })
      // Preferences never block startup; defaults stay in effect.
      .catch(() => undefined);
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setSystem(systemTheme());
    media.addEventListener("change", onChange);
    return () => {
      active = false;
      media.removeEventListener("change", onChange);
    };
  }, []);

  const resolvedTheme = prefs.theme === "system" ? system : prefs.theme;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.reduceMotion = String(prefs.reduceMotion);
  }, [resolvedTheme, prefs.reduceMotion]);

  const update = useCallback((change: (current: Preferences) => Preferences) => {
    setPrefs((current) => {
      const next = change(current);
      // Coalesce rapid changes (sliders) into one write.
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        prefsApi
          .set(next)
          .then((stored) => {
            setSaveError(false);
            // Adopt the natively clamped values only if they differ (avoids a render loop).
            setPrefs((latest) => (JSON.stringify(latest) === JSON.stringify(next) ? stored : latest));
          })
          .catch(() => setSaveError(true));
      }, 250);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, resolvedTheme, update, saveError }), [prefs, resolvedTheme, update, saveError]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences outside PreferencesProvider");
  return value;
}
