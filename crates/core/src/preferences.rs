//! Non-secret preferences (theme, terminal appearance), stored as plain JSON next to the vault so
//! the lock screen can apply them. Nothing here is sensitive; everything is still validated and
//! clamped natively, because the renderer is not a trust boundary.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tyrminal_contracts::limits::MAX_SCROLLBACK_LINES;
use tyrminal_contracts::{ErrorCode, IpcError, Preferences};

use crate::error::{err, invalid};

/// Largest preferences file read back; anything bigger is ignored and defaults are used.
const MAX_FILE_LEN: u64 = 64 * 1024;

#[derive(Debug)]
pub struct PreferencesStore {
    path: PathBuf,
    current: Mutex<Preferences>,
}

fn io_error() -> IpcError {
    err(ErrorCode::IoError, "Your preferences could not be saved. Nothing else was affected.")
}

fn finite_in(value: f32, min: f32, max: f32) -> Result<f32, IpcError> {
    if value.is_finite() { Ok(value.clamp(min, max)) } else { Err(invalid("A preference value is not a number.")) }
}

/// Validates and clamps a preferences document.
pub fn sanitize(mut prefs: Preferences) -> Result<Preferences, IpcError> {
    let t = &mut prefs.terminal;
    let id_ok = |s: &str| {
        !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    if !id_ok(&t.scheme) {
        return Err(invalid("That color scheme is not known."));
    }
    if !id_ok(&prefs.palette) {
        return Err(invalid("That color theme is not known."));
    }
    if !matches!(t.font_family.as_str(), "jetbrains-mono" | "system") {
        return Err(invalid("That font is not available."));
    }
    t.font_size = finite_in(t.font_size, 8.0, 32.0)?;
    t.line_height = finite_in(t.line_height, 1.0, 2.0)?;
    t.letter_spacing = finite_in(t.letter_spacing, -2.0, 4.0)?;
    t.padding = t.padding.min(32);
    t.scrollback = t.scrollback.min(MAX_SCROLLBACK_LINES);
    if prefs.interface_scale.is_some_and(|s| !tyrminal_contracts::INTERFACE_SCALES.contains(&s)) {
        return Err(invalid("That interface size is not one of the choices."));
    }
    // terminal notifications (P-23): between one second and a day.
    if !(1..=86_400).contains(&prefs.command_notifications.min_seconds) {
        return Err(invalid("A command must run between 1 second and 24 hours to notify."));
    }
    if let Some(shell) = &prefs.local_shell {
        let listed = tyrminal_pty::available_shells();
        if !listed.iter().any(|p| p.to_str() == Some(shell.as_str())) {
            return Err(invalid("That shell is not one of the shells installed on this computer."));
        }
    }
    if prefs.editor_apps.len() > MAX_EDITOR_APPS {
        return Err(invalid("Too many editor choices."));
    }
    for e in &prefs.editor_apps {
        if !extension_ok(&e.extension) || !Path::new(&e.app).is_absolute() {
            return Err(invalid("An editor choice is not valid."));
        }
    }
    // compromised-password check (SEC-11)
    prefs.password_check.endpoint = crate::password_check::validate_endpoint(&prefs.password_check.endpoint)?;
    // agent C: workspaces
    prefs.workspace = prefs.workspace.map(crate::layouts::sanitize_workspace).transpose()?;
    // The production tag follows the rules of host tags; empty turns the tag rule off.
    prefs.production_tag = crate::validate::tags(std::slice::from_ref(&prefs.production_tag))
        .map_err(|_| invalid("Use a production tag like those on hosts: 32 bytes at most, no commas."))?
        .pop()
        .unwrap_or_default();
    if let Some(tyrminal_contracts::HostsViewPreferences {
        filter: tyrminal_contracts::HostsFilter::Group { id },
        ..
    }) = &prefs.hosts_view
    {
        crate::validate::id(id)?;
    }
    if let Some(w) = &mut prefs.panel_widths {
        clamp_panel_widths(w);
    }
    Ok(prefs)
}

/// Width ranges of the resizable panels, in CSS pixels; the UI uses the same ranges
/// (apps/desktop/src/components/ui/ResizeHandle.tsx) and clamps further to the window.
pub const PANEL_WIDTH_RANGES: [(&str, u16, u16); 6] = [
    ("sidebar", 180, 360),
    ("sidePanel", 260, 640),
    ("files", 320, 800),
    ("filesTwoPane", 560, 1400),
    ("hostPanel", 340, 720),
    ("sftpSplit", 280, 4000),
];

fn clamp_panel_widths(w: &mut tyrminal_contracts::PanelWidths) {
    let fields =
        [&mut w.sidebar, &mut w.side_panel, &mut w.files, &mut w.files_two_pane, &mut w.host_panel, &mut w.sftp_split];
    for (field, (_, min, max)) in fields.into_iter().zip(PANEL_WIDTH_RANGES) {
        if let Some(v) = field {
            *v = (*v).clamp(min, max);
        }
    }
}

/// Editor choices kept at most.
const MAX_EDITOR_APPS: usize = 64;

/// A file extension as used for editor choices: 1–16 lower-case letters or digits.
pub fn extension_ok(ext: &str) -> bool {
    (1..=16).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// The extension of a file name for editor lookup (`None` for names without one).
pub fn extension_of(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    (!stem.is_empty() && extension_ok(&ext)).then_some(ext)
}

impl PreferencesStore {
    /// Loads `path`. A missing, oversized or unreadable file yields defaults: preferences never
    /// block startup.
    pub fn open(path: &Path) -> Self {
        let loaded = std::fs::metadata(path)
            .ok()
            .filter(|m| m.is_file() && m.len() <= MAX_FILE_LEN)
            .and_then(|_| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Preferences>(&bytes).ok())
            .and_then(|prefs| sanitize(prefs).ok())
            .unwrap_or_default();
        Self { path: path.to_owned(), current: Mutex::new(loaded) }
    }

    pub fn get(&self) -> Preferences {
        self.current.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Stores preferences from the renderer. Editor choices can be kept or removed here but never
    /// added or changed: an application that runs downloaded files is chosen only natively.
    pub fn set(&self, mut prefs: Preferences) -> Result<Preferences, IpcError> {
        let current = self.get().editor_apps;
        if prefs.editor_apps.iter().any(|e| !current.contains(e)) {
            return Err(invalid("Editors are added with the app picker only."));
        }
        prefs.editor_apps.dedup();
        self.store(prefs)
    }

    /// Adds (or replaces) the editor for `extension` with an application the user picked in a
    /// native dialog. Called by the adapter only.
    pub fn add_editor_app(&self, extension: &str, app: &Path) -> Result<Preferences, IpcError> {
        let extension = extension.trim_start_matches('.').to_ascii_lowercase();
        if !extension_ok(&extension) {
            return Err(invalid("Use a file extension of letters and digits, like conf or yml."));
        }
        let app = app.to_str().ok_or_else(|| invalid("That application path cannot be used."))?.to_owned();
        let mut prefs = self.get();
        prefs.editor_apps.retain(|e| e.extension != extension);
        prefs.editor_apps.push(tyrminal_contracts::EditorApp { extension, app });
        self.store(prefs)
    }

    /// The editor chosen for a file name, if any.
    pub fn editor_for(&self, file_name: &str) -> Option<std::path::PathBuf> {
        let ext = extension_of(file_name)?;
        self.get().editor_apps.into_iter().find(|e| e.extension == ext).map(|e| e.app.into())
    }

    /// Validates, writes atomically (temporary file, then rename) and returns what was stored.
    fn store(&self, prefs: Preferences) -> Result<Preferences, IpcError> {
        let prefs = sanitize(prefs)?;
        let json = serde_json::to_vec_pretty(&prefs).map_err(|_| io_error())?;
        let tmp = self.path.with_extension("json.tmp");
        write_owner_only(&tmp, &json).map_err(|_| io_error())?;
        std::fs::rename(&tmp, &self.path).map_err(|_| {
            let _ = std::fs::remove_file(&tmp);
            io_error()
        })?;
        *self.current.lock().unwrap_or_else(|p| p.into_inner()) = prefs.clone();
        Ok(prefs)
    }
}

fn write_owner_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_notifications_are_on_by_default_and_bounded() {
        let old: Preferences = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert!(old.command_notifications.enabled);
        assert_eq!(old.command_notifications.min_seconds, 10);
        for bad in [0, 86_401] {
            let mut p = Preferences::default();
            p.command_notifications.min_seconds = bad;
            assert!(sanitize(p).is_err(), "{bad}");
        }
    }

    #[test]
    fn editors_are_added_natively_only_and_can_be_removed() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = PreferencesStore::open(&dir.path().join("preferences.json"));
        let app = dir.path().join("Editor");
        let added = store.add_editor_app(".YML", &app).unwrap();
        assert_eq!(added.editor_apps.len(), 1);
        assert_eq!(added.editor_apps[0].extension, "yml");
        assert_eq!(store.editor_for("deploy.YML").as_deref(), Some(app.as_path()));
        assert_eq!(store.editor_for("Makefile"), None);
        // The renderer cannot add or change an editor ...
        let mut forged = store.get();
        forged.editor_apps.push(tyrminal_contracts::EditorApp { extension: "sh".into(), app: "/bin/sh".into() });
        assert!(store.set(forged).is_err());
        let mut changed = store.get();
        changed.editor_apps[0].app = "/bin/sh".into();
        assert!(store.set(changed).is_err());
        // ... but it can remove one.
        let mut removed = store.get();
        removed.editor_apps.clear();
        assert!(store.set(removed).unwrap().editor_apps.is_empty());
        assert!(store.add_editor_app("a.b", &app).is_err());
        assert_eq!(extension_of(".bashrc"), None);
        assert_eq!(extension_of("x.Conf").as_deref(), Some("conf"));
    }

    #[test]
    fn the_local_shell_must_be_an_installed_one() {
        let mut prefs = Preferences { local_shell: Some("/tmp/not-a-shell".into()), ..Preferences::default() };
        assert!(sanitize(prefs.clone()).is_err());
        if let Some(listed) = tyrminal_pty::available_shells().first() {
            prefs.local_shell = Some(listed.to_string_lossy().into_owned());
            assert!(sanitize(prefs).is_ok());
        }
        assert!(sanitize(Preferences::default()).is_ok(), "no choice means the login shell");
    }

    #[test]
    fn the_interface_size_is_automatic_by_default_and_only_a_listed_choice() {
        assert_eq!(Preferences::default().interface_scale, None, "automatic");
        let with = |scale| sanitize(Preferences { interface_scale: Some(scale), ..Preferences::default() });
        for scale in tyrminal_contracts::INTERFACE_SCALES {
            assert_eq!(with(scale).unwrap().interface_scale, Some(scale));
        }
        for scale in [0, 50, 99, 120, 151, 1000] {
            assert!(with(scale).is_err(), "{scale}");
        }
    }

    #[test]
    fn the_color_theme_is_an_id_and_older_files_get_the_default() {
        assert_eq!(Preferences::default().palette, tyrminal_contracts::DEFAULT_PALETTE);
        let with = |id: &str| sanitize(Preferences { palette: id.into(), ..Preferences::default() });
        for id in ["cobalt", "verdigris", "fjord", "graphite", "contrast", "a-theme-from-a-newer-version"] {
            assert_eq!(with(id).unwrap().palette, id);
        }
        let too_long = "a".repeat(41);
        for id in ["", "Cobalt", "co balt", "../cobalt", "cobalt;", "<script>", too_long.as_str()] {
            assert!(with(id).is_err(), "{id:?}");
        }
        // A file written before the setting existed has no such field.
        let mut older = serde_json::to_value(Preferences::default()).unwrap();
        older.as_object_mut().unwrap().remove("palette");
        let read: Preferences = serde_json::from_value(older).unwrap();
        assert_eq!(read.palette, tyrminal_contracts::DEFAULT_PALETTE);
    }

    #[test]
    fn the_production_tag_follows_host_tag_rules_and_can_be_off() {
        assert_eq!(Preferences::default().production_tag, "prod");
        let with = |tag: &str| sanitize(Preferences { production_tag: tag.into(), ..Preferences::default() });
        assert_eq!(with("  live ").unwrap().production_tag, "live");
        assert_eq!(with("").unwrap().production_tag, "", "empty turns the tag rule off");
        assert_eq!(with("   ").unwrap().production_tag, "");
        for bad in ["a,b", "pro\u{202e}d", "x\ny", &"t".repeat(33)] {
            assert!(with(bad).is_err(), "{bad:?}");
        }
        // Older preference files without the field keep the default.
        let old: Preferences = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(old.production_tag, "prod");
    }

    #[test]
    fn values_are_clamped_and_unknown_choices_rejected() {
        let mut prefs = Preferences::default();
        prefs.terminal.font_size = 400.0;
        prefs.terminal.line_height = 0.1;
        prefs.terminal.scrollback = u32::MAX;
        prefs.terminal.padding = 900;
        let clean = sanitize(prefs).unwrap();
        assert!((clean.terminal.font_size - 32.0).abs() < f32::EPSILON);
        assert!((clean.terminal.line_height - 1.0).abs() < f32::EPSILON);
        assert_eq!(clean.terminal.scrollback, MAX_SCROLLBACK_LINES);
        assert_eq!(clean.terminal.padding, 32);

        for bad_scheme in ["", "Has Caps", "../x", &"a".repeat(41)] {
            let mut p = Preferences::default();
            p.terminal.scheme = bad_scheme.into();
            assert!(sanitize(p).is_err(), "{bad_scheme:?}");
        }
        let mut p = Preferences::default();
        p.terminal.font_family = "url(https://evil)".into();
        assert!(sanitize(p).is_err());
        let mut p = Preferences::default();
        p.terminal.font_size = f32::NAN;
        assert!(sanitize(p).is_err());
    }

    #[test]
    fn store_round_trips_and_survives_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        std::fs::write(&path, b"{ not json").unwrap();
        let store = PreferencesStore::open(&path);
        assert_eq!(store.get(), Preferences::default());

        let mut prefs = Preferences { theme: tyrminal_contracts::ThemePreference::Light, ..Preferences::default() };
        prefs.terminal.scheme = "solarized-light".into();
        store.set(prefs.clone()).unwrap();
        assert_eq!(PreferencesStore::open(&path).get(), prefs);
        assert!(!path.with_extension("json.tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn the_hosts_view_survives_a_restart_and_a_group_filter_must_be_an_id() {
        use tyrminal_contracts::{HostsFilter, HostsLayout, HostsSort, HostsViewPreferences};
        // Hosts opens as a list until the user picks cards.
        assert_eq!(HostsViewPreferences::default().layout, HostsLayout::List);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        let store = PreferencesStore::open(&path);
        let view = HostsViewPreferences {
            layout: HostsLayout::List,
            sort: HostsSort::Address,
            filter: HostsFilter::Group { id: "0123456789abcdef0123456789abcdef".into() },
            connect_hint_uses: 2,
        };
        store.set(Preferences { hosts_view: Some(view.clone()), ..Preferences::default() }).unwrap();
        assert_eq!(PreferencesStore::open(&path).get().hosts_view, Some(view));

        let bad = HostsViewPreferences { filter: HostsFilter::Group { id: "../x".into() }, ..Default::default() };
        assert!(store.set(Preferences { hosts_view: Some(bad), ..Preferences::default() }).is_err());
        // Files from before the setting existed read as the default view.
        std::fs::write(&path, br#"{"theme":"dark"}"#).unwrap();
        assert_eq!(PreferencesStore::open(&path).get().hosts_view, None);
    }

    #[test]
    fn panel_widths_survive_a_restart_are_clamped_and_only_known_panels_are_kept() {
        use tyrminal_contracts::PanelWidths;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        let store = PreferencesStore::open(&path);
        let widths = PanelWidths { side_panel: Some(400), host_panel: Some(500), ..PanelWidths::default() };
        store.set(Preferences { panel_widths: Some(widths), ..Preferences::default() }).unwrap();
        assert_eq!(PreferencesStore::open(&path).get().panel_widths, Some(widths));

        // Out of range: clamped to each panel's own range.
        let wild = PanelWidths {
            sidebar: Some(0),
            side_panel: Some(u16::MAX),
            files: Some(1),
            files_two_pane: Some(9000),
            host_panel: Some(10),
            sftp_split: Some(u16::MAX),
        };
        let stored = store.set(Preferences { panel_widths: Some(wild), ..Preferences::default() }).unwrap();
        assert_eq!(
            stored.panel_widths,
            Some(PanelWidths {
                sidebar: Some(180),
                side_panel: Some(640),
                files: Some(320),
                files_two_pane: Some(1400),
                host_panel: Some(340),
                sftp_split: Some(4000),
            })
        );

        // Unknown panel names are dropped; a width that is not a 16-bit number is rejected.
        let read: Preferences = serde_json::from_str(r#"{"panelWidths":{"sidePanel":300,"evil":5}}"#).unwrap();
        assert_eq!(read.panel_widths, Some(PanelWidths { side_panel: Some(300), ..PanelWidths::default() }));
        assert!(serde_json::to_string(&read).unwrap().contains(r#""panelWidths":{"sidePanel":300}"#));
        assert!(serde_json::from_str::<Preferences>(r#"{"panelWidths":{"sidePanel":-1}}"#).is_err());
        assert!(serde_json::from_str::<Preferences>(r#"{"panelWidths":{"sidePanel":70000}}"#).is_err());

        // Files from before the setting existed read as default widths.
        std::fs::write(&path, br#"{"theme":"dark"}"#).unwrap();
        assert_eq!(PreferencesStore::open(&path).get().panel_widths, None);
    }
}
