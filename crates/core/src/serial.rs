//! Serial connections (CON-06): a terminal on a serial device (USB adapters, console ports).
//!
//! Only character devices (Unix) or `COMn` ports (Windows) are opened, so a stored path cannot
//! point the terminal at an ordinary file. The port is driven by one blocking reader thread that
//! hands bytes to the session task; writes go through the same port handle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;
use tyrminal_contracts::{ErrorCode, IpcError, SerialFlowControl, SerialParity, SerialSettings};

use crate::error::{err, invalid};

/// Highest line speed accepted (common USB adapters go to 4 Mbit/s).
const MAX_BAUD: u32 = 4_000_000;

/// Checks settings before anything is opened (the device must exist and be a port).
pub(crate) fn validate(settings: &SerialSettings) -> Result<(), IpcError> {
    validate_line(settings)?;
    if !path_ok(&settings.path) {
        return Err(invalid("That is not a serial port on this computer."));
    }
    Ok(())
}

/// Checks the stored shape of settings (a host can be saved while its adapter is unplugged).
pub(crate) fn validate_line(settings: &SerialSettings) -> Result<(), IpcError> {
    if settings.path.trim().is_empty() || settings.path.len() > 256 || settings.path.contains('\0') {
        return Err(invalid("Choose the serial port."));
    }
    if settings.baud == 0 || settings.baud > MAX_BAUD {
        return Err(invalid("Choose a speed between 1 and 4,000,000 baud."));
    }
    if !(5..=8).contains(&settings.data_bits) {
        return Err(invalid("Data bits must be 5, 6, 7 or 8."));
    }
    if !matches!(settings.stop_bits, 1 | 2) {
        return Err(invalid("Stop bits must be 1 or 2."));
    }
    Ok(())
}

#[cfg(unix)]
fn path_ok(path: &str) -> bool {
    use std::os::unix::fs::FileTypeExt;
    path.starts_with('/') && path.len() <= 256 && std::fs::metadata(path).is_ok_and(|m| m.file_type().is_char_device())
}

#[cfg(windows)]
fn path_ok(path: &str) -> bool {
    let name = path.strip_prefix(r"\\.\").unwrap_or(path);
    name.len() <= 6
        && name.get(..3).is_some_and(|p| p.eq_ignore_ascii_case("COM"))
        && name.len() > 3
        && name[3..].bytes().all(|b| b.is_ascii_digit())
}

/// Serial ports the system reports, for the host editor.
pub fn available_ports() -> Vec<String> {
    serialport::available_ports().map(|ports| ports.into_iter().map(|p| p.port_name).collect()).unwrap_or_default()
}

pub(crate) enum SerialEvent {
    Data(Vec<u8>),
    Lost,
}

pub(crate) struct SerialLink {
    pub(crate) events: mpsc::Receiver<SerialEvent>,
    port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    stop: Arc<AtomicBool>,
}

impl Drop for SerialLink {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn open_error() -> IpcError {
    err(ErrorCode::IoError, "The serial port could not be opened. Check that it is connected and not in use.")
}

/// The speed to program into the port. macOS sets it with an ioctl that pseudo-terminals
/// (`/dev/ttysNNN`, as made by `socat` or device simulators) reject with ENOTTY, so opening one
/// would always fail; they have no line speed, so none is set. Real ports keep the chosen speed.
fn line_speed(settings: &SerialSettings) -> u32 {
    if cfg!(target_os = "macos") && is_macos_pty(&settings.path) { 0 } else { settings.baud }
}

fn is_macos_pty(path: &str) -> bool {
    path.strip_prefix("/dev/ttys").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

pub(crate) fn open(settings: &SerialSettings) -> Result<SerialLink, IpcError> {
    validate(settings)?;
    let port = serialport::new(&settings.path, line_speed(settings))
        .data_bits(match settings.data_bits {
            5 => serialport::DataBits::Five,
            6 => serialport::DataBits::Six,
            7 => serialport::DataBits::Seven,
            _ => serialport::DataBits::Eight,
        })
        .parity(match settings.parity {
            SerialParity::None => serialport::Parity::None,
            SerialParity::Odd => serialport::Parity::Odd,
            SerialParity::Even => serialport::Parity::Even,
        })
        .stop_bits(if settings.stop_bits == 2 { serialport::StopBits::Two } else { serialport::StopBits::One })
        .flow_control(match settings.flow_control {
            SerialFlowControl::None => serialport::FlowControl::None,
            SerialFlowControl::Software => serialport::FlowControl::Software,
            SerialFlowControl::Hardware => serialport::FlowControl::Hardware,
        })
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|_| open_error())?;
    let mut reader = port.try_clone().map_err(|_| open_error())?;
    let (tx, events) = mpsc::channel(16);
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = Arc::clone(&stop);
    std::thread::Builder::new()
        .name("tyrminal-serial".into())
        .spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            while !stopped.load(Ordering::Relaxed) {
                match reader.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => {
                        if tx.blocking_send(SerialEvent::Data(buf[..n].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(e)
                        if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => {
                        let _ = tx.blocking_send(SerialEvent::Lost);
                        return;
                    }
                }
            }
        })
        .map_err(|_| open_error())?;
    Ok(SerialLink { events, port: Arc::new(Mutex::new(port)), stop })
}

impl SerialLink {
    pub(crate) async fn write(&self, data: &[u8]) -> bool {
        let port = Arc::clone(&self.port);
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || {
            let mut port = port.lock().unwrap_or_else(|p| p.into_inner());
            std::io::Write::write_all(&mut *port, &data).and_then(|()| std::io::Write::flush(&mut *port)).is_ok()
        })
        .await
        .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_numbered_macos_pseudo_terminals_skip_the_line_speed() {
        for pty in ["/dev/ttys000", "/dev/ttys012"] {
            assert!(is_macos_pty(pty), "{pty}");
        }
        for real in [
            "/dev/ttys",
            "/dev/ttysa",
            "/dev/tty.usbserial-1410",
            "/dev/cu.usbmodem1",
            "/dev/ttyS0",
            "/dev/ttys0/x",
            "COM3",
        ] {
            assert!(!is_macos_pty(real), "{real}");
        }
    }

    fn settings(path: &str) -> SerialSettings {
        SerialSettings { path: path.into(), ..SerialSettings::default() }
    }

    #[test]
    fn line_settings_and_paths_are_checked_before_opening() {
        assert!(validate(&settings("/definitely/not/a/port")).is_err());
        #[cfg(unix)]
        {
            // An ordinary file is never opened as a port, even if it exists.
            let file = tempfile::NamedTempFile::new().unwrap();
            assert!(validate(&settings(file.path().to_str().unwrap())).is_err());
            assert!(validate(&settings("/etc/passwd")).is_err());
        }
        // A real port name on each platform: a character device on Unix, a COM name on Windows.
        let s = settings(if cfg!(unix) { "/dev/null" } else { "COM3" });
        assert!(validate(&s).is_ok());
        for bad in [
            SerialSettings { baud: 0, ..s.clone() },
            SerialSettings { baud: MAX_BAUD + 1, ..s.clone() },
            SerialSettings { data_bits: 9, ..s.clone() },
            SerialSettings { stop_bits: 3, ..s.clone() },
        ] {
            assert!(validate(&bad).is_err(), "{bad:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_ports_are_com_names_only() {
        assert!(path_ok("COM3") && path_ok(r"\\.\COM12"));
        assert!(!path_ok("C:\\Windows\\win.ini") && !path_ok("COM") && !path_ok("COMX"));
    }
}
