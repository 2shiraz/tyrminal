//! Native screen-lock notifications for macOS and Windows (ADR 0007).
//!
//! This is the only crate in the workspace allowed to contain `unsafe`, and only in the two
//! platform modules below, each a single call sequence into a documented OS API. The callback
//! can only cause the vault to lock; nothing from the OS reaches any other code path.

use std::sync::Arc;

pub type OnLock = Arc<dyn Fn() + Send + Sync>;

/// Starts delivering screen-lock events to `on_lock`. Returns whether a native source is attached
/// (always `false` on platforms without one here; Linux uses D-Bus in `tyrminal-platform`).
/// On macOS this must be called on the main thread (its run loop delivers the notification).
pub fn watch_screen_lock(on_lock: OnLock) -> bool {
    imp::watch(on_lock)
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod imp {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSString};

    use super::OnLock;

    pub(super) fn watch(on_lock: OnLock) -> bool {
        let center = NSDistributedNotificationCenter::defaultCenter();
        let name = NSString::from_str("com.apple.screenIsLocked");
        let block = RcBlock::new(move |_note: NonNull<NSNotification>| on_lock());
        // SAFETY: `name` is a valid NSString; `obj` and `queue` are nil (any sender, delivered on
        // the posting thread's run loop, which is the main thread here). The block only calls a
        // `Send + Sync` closure and captures nothing else, as the API requires of the block.
        let observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(&name), None, None, &block) };
        // The observer stays registered for the life of the process.
        std::mem::forget(observer);
        true
    }
}

#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
mod imp {
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::RemoteDesktop::{NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG, RegisterClassW,
        TranslateMessage, WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_SESSION_LOCK,
    };

    use super::OnLock;

    static CALLBACK: OnceLock<OnLock> = OnceLock::new();

    unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_WTSSESSION_CHANGE && wparam == WTS_SESSION_LOCK as WPARAM {
            if let Some(callback) = CALLBACK.get() {
                callback();
            }
            return 0;
        }
        // SAFETY: forwarding the unmodified arguments the system passed to this window procedure.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    pub(super) fn watch(on_lock: OnLock) -> bool {
        if CALLBACK.set(on_lock).is_err() {
            return true;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let spawned = std::thread::Builder::new().name("screen-lock".into()).spawn(move || {
            let class: Vec<u16> = "TyrminalScreenLock\0".encode_utf16().collect();
            // SAFETY: a null module name returns this executable's handle; no other invariants.
            let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            // SAFETY: `wc` is fully initialised and `class` outlives the registration (it lives
            // as long as this thread, which runs the message loop until the process exits).
            if unsafe { RegisterClassW(&wc) } == 0 {
                let _ = tx.send(false);
                return;
            }
            // SAFETY: creates a message-only window (parent HWND_MESSAGE) of the class registered
            // above; every pointer argument is either null or points to `class`.
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    class.as_ptr(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                )
            };
            if hwnd.is_null() {
                let _ = tx.send(false);
                return;
            }
            // SAFETY: `hwnd` is the valid window created above, owned by this thread.
            let registered = unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) } != 0;
            let _ = tx.send(registered);
            if !registered {
                return;
            }
            // SAFETY: `MSG` is plain data; zeroed is a valid initial value for GetMessageW to fill.
            let mut msg: MSG = unsafe { std::mem::zeroed() };
            // SAFETY: standard message loop for the window owned by this thread.
            while unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) } > 0 {
                // SAFETY: `msg` was filled by GetMessageW above.
                unsafe {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });
        spawned.is_ok() && rx.recv().unwrap_or(false)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::OnLock;

    pub(super) fn watch(_on_lock: OnLock) -> bool {
        false
    }
}
