//! Telling the application when the operating system locks the screen, so the vault can lock with
//! it (spec Phase 02, P-10). Signals can only cause a lock, never prevent or delay one, so a
//! spurious signal costs the user an unlock and nothing else.
//!
//! Linux: the screensaver's `ActiveChanged(true)` on the session bus (freedesktop and GNOME
//! names) and logind's `Lock` signal for sessions on the system bus. Each bus is watched on its own
//! thread with zbus's blocking API. macOS (`com.apple.screenIsLocked`) and Windows
//! (`WM_WTSSESSION_CHANGE` / `WTS_SESSION_LOCK`) use native APIs in `tyrminal-os-hooks`, the one
//! crate allowed `unsafe` (ADR 0007). On macOS `watch` must run on the main thread.

use std::sync::Arc;

/// What the watcher could attach to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenLockSupport {
    /// At least one source of lock signals is being watched.
    Watching,
    /// No source could be attached on this platform or session.
    Unavailable,
}

pub type OnLock = Arc<dyn Fn() + Send + Sync>;

/// Starts watching for screen locks; `on_lock` runs on a watcher thread each time one happens.
pub fn watch(on_lock: OnLock) -> ScreenLockSupport {
    imp::watch(on_lock)
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{OnLock, ScreenLockSupport};

    /// (interface, member) pairs that mean "the screen is now locked".
    const SESSION_SIGNALS: [&str; 2] = ["org.freedesktop.ScreenSaver", "org.gnome.ScreenSaver"];

    fn listen(
        conn: zbus::blocking::Connection,
        interface: &'static str,
        member: &'static str,
        needs_true: bool,
        on_lock: OnLock,
    ) -> bool {
        let Ok(builder) = zbus::MatchRule::builder().msg_type(zbus::message::Type::Signal).interface(interface) else {
            return false;
        };
        let Ok(builder) = builder.member(member) else { return false };
        let Ok(iter) = zbus::blocking::MessageIterator::for_match_rule(builder.build(), &conn, Some(16)) else {
            return false;
        };
        std::thread::Builder::new()
            .name(format!("screen-lock {member}"))
            .spawn(move || {
                for msg in iter.flatten() {
                    let locked = !needs_true || msg.body().deserialize::<bool>().unwrap_or(false);
                    if locked {
                        on_lock();
                    }
                }
            })
            .is_ok()
    }

    pub(super) fn watch(on_lock: OnLock) -> ScreenLockSupport {
        let mut any = false;
        if let Ok(session) = zbus::blocking::Connection::session() {
            for interface in SESSION_SIGNALS {
                any |= listen(session.clone(), interface, "ActiveChanged", true, on_lock.clone());
            }
        }
        if let Ok(system) = zbus::blocking::Connection::system() {
            any |= listen(system, "org.freedesktop.login1.Session", "Lock", false, on_lock);
        }
        if any { ScreenLockSupport::Watching } else { ScreenLockSupport::Unavailable }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::{OnLock, ScreenLockSupport};

    pub(super) fn watch(on_lock: OnLock) -> ScreenLockSupport {
        if tyrminal_os_hooks::watch_screen_lock(on_lock) {
            ScreenLockSupport::Watching
        } else {
            ScreenLockSupport::Unavailable
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};

    /// Needs a session bus (CI runs the Linux suites under `dbus-run-session`).
    #[test]
    #[ignore = "requires a D-Bus session bus"]
    fn a_screensaver_activation_signal_locks_and_deactivation_does_not() {
        let count = Arc::new(AtomicU32::new(0));
        let seen = Arc::clone(&count);
        assert_eq!(
            watch(Arc::new(move || {
                seen.fetch_add(1, Ordering::SeqCst);
            })),
            ScreenLockSupport::Watching
        );
        let bus = zbus::blocking::Connection::session().expect("session bus");
        let wait = |n: u32| {
            let start = Instant::now();
            while count.load(Ordering::SeqCst) < n && start.elapsed() < Duration::from_secs(5) {
                std::thread::sleep(Duration::from_millis(20));
            }
            count.load(Ordering::SeqCst)
        };
        // Deactivation (unlock) never triggers anything.
        bus.emit_signal(
            None::<&str>,
            "/org/freedesktop/ScreenSaver",
            "org.freedesktop.ScreenSaver",
            "ActiveChanged",
            &false,
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(count.load(Ordering::SeqCst), 0);
        bus.emit_signal(
            None::<&str>,
            "/org/freedesktop/ScreenSaver",
            "org.freedesktop.ScreenSaver",
            "ActiveChanged",
            &true,
        )
        .unwrap();
        assert_eq!(wait(1), 1);
        bus.emit_signal(None::<&str>, "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver", "ActiveChanged", &true)
            .unwrap();
        assert_eq!(wait(2), 2);
    }
}
