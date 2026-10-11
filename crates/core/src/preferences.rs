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
    if !matches!(t.font_family.as_str(), "jetbrains-mono" | "system") {
        return Err(invalid("That font is not available."));
    }
    t.font_size = finite_in(t.font_size, 8.0, 32.0)?;
    t.line_height = finite_in(t.line_height, 1.0, 2.0)?;
    t.letter_spacing = finite_in(t.letter_spacing, -2.0, 4.0)?;
    t.padding = t.padding.min(32);
    t.scrollback = t.scrollback.min(MAX_SCROLLBACK_LINES);
    Ok(prefs)
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

    /// Validates, writes atomically (temporary file, then rename) and returns what was stored.
    pub fn set(&self, prefs: Preferences) -> Result<Preferences, IpcError> {
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

        let mut prefs = Preferences::default();
        prefs.theme = tyrminal_contracts::ThemePreference::Light;
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
}
