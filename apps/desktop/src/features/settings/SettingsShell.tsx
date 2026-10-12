import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { usePreferences } from "../../app/preferences";
import { Notice } from "../../components/ui/controls";
import { IconSearch } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { msgC } from "../../lib/messages-c";
import { msgPC } from "../../lib/messages-password-check";
import { msgSR } from "../../lib/messages-security-review";
import { HighlightSettings, ShortcutsSettings } from "../layouts/WorkspaceSettings";
import { PasswordCheckSetting } from "../password-check/PasswordCheckSetting";
import { SecurityReviewSection } from "../security-review/SecurityReviewSection";
import { AboutSection } from "./AboutSection";
import { msgSettings } from "./messages";
import { BackupSection, PrivacySection } from "./sections/Data";
import { AppearanceSection, TerminalSection, resetTerminal } from "./sections/General";
import { VaultSection } from "./sections/Security";
import { type IndexEntry, type NavGroup, SECTIONS, type Section, onSectionRequest, searchSettings, takeRequestedSection } from "./settingsIndex";
import "./settings.css";
import { useGlide } from "../../lib/useGlide";

const DESCRIPTIONS: Record<Section, string> = {
  appearance: msgSettings.descriptions.appearance,
  terminal: msgSettings.descriptions.terminal,
  shortcuts: msgC.keys.body,
  highlight: msgC.highlight.body,
  security: msgSettings.descriptions.security,
  review: msgSR.body,
  password: msgPC.body,
  backup: msgSettings.descriptions.backup,
  privacy: msgSettings.descriptions.privacy,
  about: msg.about.body,
};

/** Focuses a setting row found by search: its control, or the row itself when it has none. */
function focusSetting(id: string) {
  const row = document.querySelector<HTMLElement>(`[data-setting="${id}"]`);
  if (!row) return;
  const control = row.matches("input, select, button, textarea")
    ? row
    : row.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, button, [role="radio"][tabindex="0"], [tabindex="0"]');
  if (control) {
    control.focus({ preventScroll: true });
  } else {
    row.tabIndex = -1;
    row.focus({ preventScroll: true });
  }
  (control ?? row).scrollIntoView({ block: "nearest" });
}

/**
 * Settings: a nav pane (search, then the sections by group) beside the one section it shows.
 * Every setting applies and saves on change; a failed save shows under the section strip.
 */
export function SettingsView({
  initialSection,
  onOpenKeychain = () => undefined,
}: { initialSection?: Section | undefined; onOpenKeychain?: () => void } = {}) {
  const { saveError, update } = usePreferences();
  const [section, setSection] = useState<Section>(() => takeRequestedSection() ?? initialSection ?? "appearance");
  const [query, setQuery] = useState("");
  // A row to focus once its section has rendered (set by search).
  const [pending, setPending] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  // The current section marker glides to the clicked item (lib/useGlide).
  useGlide(navRef);

  useEffect(() => onSectionRequest(setSection), []);
  useEffect(() => {
    if (!pending) return;
    focusSetting(pending);
    setPending(null);
  }, [pending, section]);

  const results = searchSettings(query);
  const searching = query.trim() !== "";
  const matchingSections = new Set(results.map((r) => r.section));
  const visible = searching ? SECTIONS.filter((s) => matchingSections.has(s.id)) : SECTIONS;

  function open(entry: IndexEntry) {
    setQuery("");
    setSection(entry.section);
    setPending(entry.id);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    } else if (event.key === "Enter" && results[0]) {
      event.preventDefault();
      open(results[0]);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      document.querySelector<HTMLElement>(".settings-results button")?.focus();
    }
  }

  // Up/Down move between nav items (roving tabindex); Home/End go to the ends.
  function onNavKey(event: KeyboardEvent<HTMLElement>) {
    const items = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>(".settings-nav-item") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to =
      event.key === "ArrowDown" ? Math.min(at + 1, items.length - 1) : event.key === "ArrowUp" ? Math.max(at - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    items[to]?.focus();
  }

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  const groups = Object.keys(msgSettings.groups) as NavGroup[];
  // The roving tab stop: the current section, or the first shown one while search hides it.
  const tabStop = visible.some((s) => s.id === section) ? section : visible[0]?.id;

  let body: ReactNode;
  switch (section) {
    case "appearance":
      body = <AppearanceSection />;
      break;
    case "terminal":
      body = <TerminalSection />;
      break;
    case "shortcuts":
      body = <ShortcutsSettings />;
      break;
    case "highlight":
      body = <HighlightSettings />;
      break;
    case "security":
      body = <VaultSection />;
      break;
    case "review":
      body = <SecurityReviewSection onOpenKeychain={onOpenKeychain} />;
      break;
    case "password":
      body = <PasswordCheckSetting />;
      break;
    case "backup":
      body = <BackupSection />;
      break;
    case "privacy":
      body = <PrivacySection />;
      break;
    case "about":
      body = <AboutSection />;
      break;
  }

  return (
    <div className="settings-page">
      <h1 className="visually-hidden">{msg.settings.title}</h1>
      <div className="settings-panes">
        <nav className="settings-nav" aria-label={msgSettings.nav} ref={navRef} onKeyDown={onNavKey}>
          <div className="settings-search">
            <IconSearch size={14} aria-hidden />
            <input
              type="search"
              aria-label={msgSettings.search}
              placeholder={msgSettings.searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              spellCheck={false}
            />
          </div>
          {groups.map((group) => {
            const items = visible.filter((s) => s.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="settings-nav-group" role="group" aria-labelledby={`settings-nav-${group}`}>
                <div className="box-strip settings-nav-label" id={`settings-nav-${group}`}>
                  {msgSettings.groups[group]}
                </div>
                {items.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="settings-nav-item"
                    aria-current={section === s.id ? "page" : undefined}
                    tabIndex={s.id === tabStop ? 0 : -1}
                    onClick={() => {
                      setQuery("");
                      setSection(s.id);
                    }}
                  >
                    <span className="truncate">{s.label}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        {searching ? (
          <section className="settings-section settings-results-pane" aria-labelledby="settings-results-title">
            <div className="box-strip settings-section-strip">
              <div>
                <h2 id="settings-results-title">{msgSettings.search}</h2>
                <p aria-live="polite">{results.length > 0 ? msgSettings.results(results.length) : msgSettings.noMatch(query.trim())}</p>
              </div>
            </div>
            {results.length > 0 && (
              <ul className="box settings-results" aria-labelledby="settings-results-title">
                {results.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => open(r)}>
                      <span className="faint">{msgSettings.resultPath(SECTIONS.find((s) => s.id === r.section)?.label ?? "", r.group)} / </span>
                      <span>{r.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <section
            key={section}
            id={`settings-${section}`}
            className="settings-section"
            aria-labelledby={`settings-${section}-title`}
          >
            <div className="box-strip settings-section-strip">
              <div>
                <h2 id={`settings-${section}-title`}>{current.label}</h2>
                <p>{DESCRIPTIONS[section]}</p>
              </div>
              {section === "terminal" && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => resetTerminal(update)}>
                  {msgSettings.resetSection}
                </button>
              )}
            </div>
            {saveError && <Notice tone="danger">{msg.settings.saveFailed}</Notice>}
            <div className="settings-section-body">{body}</div>
          </section>
        )}
      </div>
    </div>
  );
}
