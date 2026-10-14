import type { Preferences } from "@tyrminal/contracts";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { schemeById } from "../features/terminal/schemes";
import { DEFAULT_APP_THEME, appThemeById } from "./themes";
import { diagnostics, preferences as prefsApi } from "../lib/ipc";
import { useInterfaceScale } from "./interfaceScale";

const DEFAULTS: Preferences = {
  theme: "system",
  palette: DEFAULT_APP_THEME,
  reduceMotion: false,
  localShell: null,
  editorApps: [],
  diagnostics: false,
  commandNotifications: { enabled: true, minSeconds: 10 },
  // compromised-password check (SEC-11): off until the user turns it on; the core supplies the address.
  passwordCheck: { enabled: false, endpoint: "" },
  productionTag: "prod",
  noPortSuggestions: false,
  interfaceScale: null,
  confirmMultiOpen: true,
  confirmProductionOpen: true,
  confirmSnippetRun: true,
  autoLockMinutes: 5,
  terminal: {
    scheme: "tyrminal-night",
    fontFamily: "jetbrains-mono",
    fontSize: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorStyle: "block",
    cursorBlink: true,
    padding: 12,
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

  useEffect(() => diagnostics.setEnabled(prefs.diagnostics), [prefs.diagnostics]);

  useInterfaceScale(prefs.interfaceScale);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.reduceMotion = String(prefs.reduceMotion);
    // The default theme is the plain :root tokens; the others are selected by data-palette.
    const palette = appThemeById(prefs.palette).id;
    if (palette === DEFAULT_APP_THEME) delete root.dataset.palette;
    else root.dataset.palette = palette;
  }, [resolvedTheme, prefs.reduceMotion, prefs.palette]);

  // The chrome around a terminal (its tab, the status bar) takes the terminal scheme's colours.
  useEffect(() => {
    const scheme = schemeById(prefs.terminal.scheme);
    const style = document.documentElement.style;
    style.setProperty("--scheme-bg", scheme.background);
    style.setProperty("--scheme-fg", scheme.foreground);
    style.setProperty("--scheme-green", scheme.green);
    style.setProperty("--scheme-yellow", scheme.yellow);
    style.setProperty("--scheme-red", scheme.red);
  }, [prefs.terminal.scheme]);

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
