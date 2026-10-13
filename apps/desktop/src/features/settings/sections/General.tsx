import type { Preferences, TerminalPreferences } from "@tyrminal/contracts";
import { Suspense, lazy, useEffect, useState } from "react";

import { DEFAULT_PREFERENCES, usePreferences } from "../../../app/preferences";
import { ErrorNotice, RangeField, Segmented, SettingRow, SkeletonBlock, Switch } from "../../../components/ui/controls";
import { IconMonitor, IconMoon, IconSun, IconTrash2, IconTriangleAlert } from "../../../components/ui/icons";
import { preferences as preferencesApi } from "../../../lib/ipc";
import { msg } from "../../../lib/messages";
import { useAction } from "../../../lib/useAsync";
import { CommandNoticeSettings } from "../../notify/CommandNoticeSettings";
import { SCHEMES, type TerminalScheme, lowContrastColors } from "../../terminal/schemes";
import { msgSettings } from "../messages";
import { SettingsGroup } from "../SettingsGroup";
import { INTERFACE_SCALES } from "../../../app/interfaceScale";
import { APP_THEMES, appThemeById } from "../../../app/themes";

// The preview pulls in the terminal emulator; load it only when the Terminal section opens.
const TerminalPreview = lazy(() => import("../../terminal/TerminalPreview").then((m) => ({ default: m.TerminalPreview })));

export function AppearanceSection() {
  const { prefs, update, resolvedTheme } = usePreferences();
  return (
    <>
      <SettingsGroup title={msgSettings.theme}>
        <div className="theme-picker" id="colour-theme">
          <div className="setting-label">
            <span>{msgSettings.colourTheme}</span>
          </div>
          <ThemeList value={appThemeById(prefs.palette).id} mode={resolvedTheme} onChange={(palette) => update((p) => ({ ...p, palette }))} />
        </div>
        <SettingRow label={msgSettings.themeMode} hint={msgSettings.themeModeHint} id="theme">
          <Segmented
            label={msgSettings.themeMode}
            value={prefs.theme}
            onChange={(theme) => update((p) => ({ ...p, theme }))}
            options={[
              { value: "system", label: msg.settings.themeSystem, icon: <IconMonitor size={14} /> },
              { value: "light", label: msg.settings.themeLight, icon: <IconSun size={14} /> },
              { value: "dark", label: msg.settings.themeDark, icon: <IconMoon size={14} /> },
            ]}
          />
        </SettingRow>
        <SettingRow label={msgSettings.interfaceSize} hint={msgSettings.interfaceSizeHint} id="interface-size">
          <select
            className="select"
            aria-label={msgSettings.interfaceSize}
            value={prefs.interfaceScale ? String(prefs.interfaceScale) : "auto"}
            onChange={(event) => {
              const value = event.target.value;
              update((p) => ({ ...p, interfaceScale: value === "auto" ? null : Number(value) }));
            }}
          >
            <option value="auto">{msgSettings.interfaceSizeAuto}</option>
            {INTERFACE_SCALES.map((scale) => (
              <option key={scale} value={String(scale)}>{`${scale}%`}</option>
            ))}
          </select>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title={msgSettings.motion}>
        <Switch
          id="reduce-motion"
          label={msg.settings.reduceMotion}
          hint={msg.settings.reduceMotionHint}
          checked={prefs.reduceMotion}
          onChange={(reduceMotion) => update((p) => ({ ...p, reduceMotion }))}
        />
      </SettingsGroup>
    </>
  );
}

/** "Reset section" for Terminal: every terminal setting back to its default. */
export function resetTerminal(update: ReturnType<typeof usePreferences>["update"]) {
  update((p) => ({ ...p, terminal: DEFAULT_PREFERENCES.terminal }));
}

export function TerminalSection() {
  const { prefs, update } = usePreferences();
  const setTerminal = (patch: Partial<TerminalPreferences>) => update((p: Preferences) => ({ ...p, terminal: { ...p.terminal, ...patch } }));
  const t = prefs.terminal;
  const [shells, setShells] = useState<string[] | null>(null);
  useEffect(() => {
    preferencesApi
      .shells()
      .then(setShells)
      .catch(() => setShells([]));
  }, []);

  return (
    <>
      <div className="settings-scheme">
        <SettingsGroup title={msgSettings.colourScheme} className="settings-scheme-list">
          <SchemeList value={t.scheme} onChange={(scheme) => setTerminal({ scheme })} />
        </SettingsGroup>
        <SettingsGroup title={msgSettings.preview} className="settings-scheme-preview">
          {/* A picture of the settings, not a terminal: nothing inside can take focus. */}
          <div inert>
            <Suspense fallback={<SkeletonBlock className="terminal-preview" />}>
              <TerminalPreview prefs={t} />
            </Suspense>
          </div>
        </SettingsGroup>
      </div>

      <SettingsGroup title={msgSettings.text}>
        <SettingRow label={msg.settings.font} id="font">
          <select className="select" aria-label={msg.settings.font} value={t.fontFamily} onChange={(event) => setTerminal({ fontFamily: event.target.value })}>
            <option value="jetbrains-mono">{msg.settings.fontBundled}</option>
            <option value="system">{msg.settings.fontSystem}</option>
          </select>
        </SettingRow>
        <SettingRow label={msg.settings.fontSize} id="font-size">
          <RangeField label={msg.settings.fontSize} value={t.fontSize} min={9} max={24} step={1} format={(v) => `${v}px`} onChange={(fontSize) => setTerminal({ fontSize })} />
        </SettingRow>
        <SettingRow label={msg.settings.lineHeight} id="line-height">
          <RangeField label={msg.settings.lineHeight} value={t.lineHeight} min={1} max={1.8} step={0.05} format={(v) => v.toFixed(2)} onChange={(lineHeight) => setTerminal({ lineHeight })} />
        </SettingRow>
        <SettingRow label={msg.settings.letterSpacing} id="letter-spacing">
          <RangeField
            label={msg.settings.letterSpacing}
            value={t.letterSpacing}
            min={-1}
            max={3}
            step={0.5}
            format={(v) => `${v}px`}
            onChange={(letterSpacing) => setTerminal({ letterSpacing })}
          />
        </SettingRow>
        <SettingRow label={msg.settings.padding} id="padding">
          <RangeField label={msg.settings.padding} value={t.padding} min={0} max={24} step={2} format={(v) => `${v}px`} onChange={(padding) => setTerminal({ padding })} />
        </SettingRow>
        <Switch id="ligatures" label={msg.settings.ligatures} hint={msg.settings.ligaturesHint} checked={t.ligatures} onChange={(ligatures) => setTerminal({ ligatures })} />
      </SettingsGroup>

      <SettingsGroup title={msgSettings.cursor}>
        <SettingRow label={msg.settings.cursor} id="cursor-style">
          <Segmented
            label={msg.settings.cursor}
            value={t.cursorStyle}
            onChange={(cursorStyle) => setTerminal({ cursorStyle })}
            options={[
              { value: "block", label: msg.settings.cursorBlock },
              { value: "bar", label: msg.settings.cursorBar },
              { value: "underline", label: msg.settings.cursorUnderline },
            ]}
          />
        </SettingRow>
        <Switch id="cursor-blink" label={msg.settings.cursorBlink} checked={t.cursorBlink} onChange={(cursorBlink) => setTerminal({ cursorBlink })} />
      </SettingsGroup>

      <SettingsGroup title={msgSettings.behaviour}>
        <SettingRow label={msg.settings.scrollback} hint={msg.settings.scrollbackHint} id="scrollback">
          <select className="select" aria-label={msg.settings.scrollback} value={String(t.scrollback)} onChange={(event) => setTerminal({ scrollback: Number(event.target.value) })}>
            {[1000, 5000, 10000, 25000, 50000, 100000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </SettingRow>
        <Switch
          id="renderer"
          label={msg.settings.renderer}
          hint={msg.settings.rendererHint}
          checked={t.renderer === "auto"}
          onChange={(on) => setTerminal({ renderer: on ? "auto" : "compatibility" })}
        />
        <Switch
          id="confirm-paste"
          label={msg.settings.confirmPaste}
          hint={msg.settings.confirmPasteHint}
          checked={t.confirmMultilinePaste}
          onChange={(confirmMultilinePaste) => setTerminal({ confirmMultilinePaste })}
        />
        <Switch
          id="confirm-open"
          label={msg.settings.confirmOpen}
          hint={msg.settings.confirmOpenHint}
          checked={prefs.confirmMultiOpen !== false}
          onChange={(confirmMultiOpen) => update((p) => ({ ...p, confirmMultiOpen }))}
        />
        <Switch
          id="confirm-production-open"
          label={msg.settings.confirmProductionOpen}
          hint={msg.settings.confirmProductionOpenHint}
          checked={prefs.confirmProductionOpen !== false}
          onChange={(confirmProductionOpen) => update((p) => ({ ...p, confirmProductionOpen }))}
        />
        <Switch
          id="confirm-run"
          label={msg.settings.confirmRun}
          hint={msg.settings.confirmRunHint}
          checked={prefs.confirmSnippetRun !== false}
          onChange={(confirmSnippetRun) => update((p) => ({ ...p, confirmSnippetRun }))}
        />
        <Switch id="copy-on-select" label={msg.settings.copyOnSelect} checked={t.copyOnSelect} onChange={(copyOnSelect) => setTerminal({ copyOnSelect })} />
        {/* terminal notifications (P-23) */}
        <CommandNoticeSettings
          value={prefs.commandNotifications ?? { enabled: true, minSeconds: 10 }}
          onChange={(commandNotifications) => update((p) => ({ ...p, commandNotifications }))}
        />
      </SettingsGroup>

      <SettingsGroup title={msgSettings.localShellAndEditors}>
        <SettingRow label={msg.settings.localShell} hint={msg.settings.localShellHint} id="local-shell">
          <select
            className="select"
            aria-label={msg.settings.localShell}
            value={prefs.localShell ?? ""}
            onChange={(event) => update((p) => ({ ...p, localShell: event.target.value === "" ? null : event.target.value }))}
          >
            <option value="">{msg.settings.localShellDefault}</option>
            {(shells ?? []).map((shell) => (
              <option key={shell} value={shell}>
                {shell}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={msg.settings.editors} hint={msg.settings.editorsHint} id="editors">
          <EditorChoices
            apps={prefs.editorApps ?? []}
            onRemove={(ext) => update((p) => ({ ...p, editorApps: (p.editorApps ?? []).filter((e) => e.extension !== ext) }))}
            onAdded={(next) => update(() => next)}
          />
        </SettingRow>
      </SettingsGroup>
    </>
  );
}

/**
 * Application themes as a radio group of small previews, drawn in the mode now in use. Arrow keys
 * move the choice, as in any radio group; the choice applies at once.
 */
function ThemeList({ value, mode, onChange }: { value: string; mode: "light" | "dark"; onChange: (id: string) => void }) {
  const index = Math.max(0, APP_THEMES.findIndex((t) => t.id === value));
  function onKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? APP_THEMES.length - 1 : (index + delta + APP_THEMES.length) % APP_THEMES.length;
    const theme = APP_THEMES[next];
    if (!theme) return;
    onChange(theme.id);
    const list = event.currentTarget;
    window.requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-theme-id="${theme.id}"]`)?.focus());
  }
  return (
    <div className="theme-list" role="radiogroup" aria-label={msgSettings.colourTheme} data-setting="palette" onKeyDown={onKey}>
      {APP_THEMES.map((theme) => {
        const checked = theme.id === value;
        const c = theme[mode];
        return (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={theme.name}
            tabIndex={checked ? 0 : -1}
            data-theme-id={theme.id}
            className="theme-card"
            onClick={() => onChange(theme.id)}
          >
            {/* A miniature of the window: frame, canvas, a box of rows and the accent. */}
            <span className="theme-preview" aria-hidden="true" style={{ background: c.canvas }}>
              <span className="theme-preview-frame" style={{ background: c.frame }}>
                <span style={{ background: c.accent }} />
                <span style={{ background: c.text }} />
                <span style={{ background: c.text }} />
              </span>
              <span className="theme-preview-box" style={{ background: c.surface }}>
                <span style={{ background: c.text }} />
                <span style={{ background: c.text }} />
                <span style={{ background: c.accent }} />
              </span>
            </span>
            <span className="theme-card-name">{theme.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The scheme's own colours as a strip: background, then the six ANSI hues and the text colour. */
function Swatch({ scheme }: { scheme: TerminalScheme }) {
  const colours = [scheme.background, scheme.red, scheme.green, scheme.yellow, scheme.blue, scheme.magenta, scheme.cyan, scheme.foreground];
  return (
    <span className="scheme-swatch" aria-hidden="true">
      {colours.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed order of colours.
        <span key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

/**
 * Colour schemes as a radio list (28 px rows: name, a strip of its colours, the low-contrast
 * warning). Arrow keys move the choice, as in any radio group; the choice applies at once.
 */
function SchemeList({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const index = Math.max(0, SCHEMES.findIndex((s) => s.id === value));
  function onKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? SCHEMES.length - 1 : (index + delta + SCHEMES.length) % SCHEMES.length;
    const scheme = SCHEMES[next];
    if (!scheme) return;
    onChange(scheme.id);
    const list = event.currentTarget;
    window.requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-scheme="${scheme.id}"]`)?.focus());
  }
  return (
    <div className="scheme-list" role="radiogroup" aria-label={msg.settings.scheme} data-setting="scheme" onKeyDown={onKey}>
      {SCHEMES.map((scheme) => {
        const low = lowContrastColors(scheme);
        const checked = scheme.id === value;
        return (
          <button
            key={scheme.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-scheme={scheme.id}
            className="scheme-row"
            onClick={() => onChange(scheme.id)}
          >
            <span className="scheme-radio" aria-hidden="true" />
            <span className="scheme-row-name">{scheme.name}</span>
            <span className="scheme-kind" aria-hidden="true">
              {scheme.kind === "dark" ? <IconMoon size={12} /> : <IconSun size={12} />}
            </span>
            <Swatch scheme={scheme} />
            {low.length > 0 ? (
              <span className="scheme-warn" role="img" aria-label={msg.settings.lowContrast(low.join(", "))} data-tooltip={msg.settings.lowContrast(low.join(", "))}>
                <IconTriangleAlert size={13} />
              </span>
            ) : (
              <span className="scheme-warn" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function EditorChoices({
  apps,
  onRemove,
  onAdded,
}: {
  apps: { extension: string; app: string }[];
  onRemove: (extension: string) => void;
  onAdded: (prefs: Preferences) => void;
}) {
  const [ext, setExt] = useState("");
  const { pending, error, run } = useAction();
  const valid = /^\.?[A-Za-z0-9]{1,16}$/.test(ext.trim());
  return (
    <div className="stack-sm">
      {apps.length === 0 ? (
        <span className="muted">{msg.settings.editorNone}</span>
      ) : (
        <ul className="editor-choices" aria-label={msg.settings.editors}>
          {apps.map((e) => (
            <li key={e.extension}>
              <span className="mono">.{e.extension}</span>
              <span className="muted" title={e.app}>
                {e.app.split(/[\\/]/).pop()}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={msg.settings.editorRemove(e.extension)} onClick={() => onRemove(e.extension)}>
                <IconTrash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="editor-add">
        <input className="input mono" aria-label={msg.settings.editorExtension} placeholder="conf" value={ext} onChange={(event) => setExt(event.target.value)} />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!valid || pending}
          onClick={async () => {
            const next = await run(() => preferencesApi.pickEditor(ext.trim()));
            if (next) {
              onAdded(next);
              setExt("");
            }
          }}
        >
          {msg.settings.editorAdd}
        </button>
      </div>
      <ErrorNotice error={error} />
    </div>
  );
}
