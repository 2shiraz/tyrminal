//! Telnet and serial hosts (CON-05, CON-06, HST-01), through the same session API as SSH.
//! The Telnet server is a real TCP server in this test speaking RFC 854 negotiation; the serial
//! "device" is one end of a pseudo-terminal pair made by `socat` (no hardware needed).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tyrminal_core::contracts::{HostAuthInput, HostInput, HostProtocol, SerialSettings, SessionEvent, SessionState};
use tyrminal_core::{Core, SessionSink};

const WINDOW: &str = "main";
const WAIT: Duration = Duration::from_secs(10);
const IAC: u8 = 255;

enum Message {
    Output(Vec<u8>),
    Event(SessionEvent),
}

struct Sink(mpsc::UnboundedSender<Message>);

impl SessionSink for Sink {
    fn output(&self, data: Vec<u8>) -> bool {
        self.0.send(Message::Output(data)).is_ok()
    }
    fn event(&self, event: SessionEvent) -> bool {
        self.0.send(Message::Event(event)).is_ok()
    }
}

async fn core() -> (TempDir, Core) {
    let dir = TempDir::new().unwrap();
    let core = Core::open(&dir.path().join("vault.db")).unwrap();
    core.vault.create("correct horse battery staple".into()).await.unwrap();
    (dir, core)
}

async fn host(core: &Core, address: &str, port: Option<u16>, protocol: HostProtocol) -> String {
    let input = HostInput {
        id: None,
        label: "legacy".into(),
        address: address.into(),
        port,
        username: String::new(),
        auth: HostAuthInput::AskPassword,
        group_id: None,
        tags: Vec::new(),
        protocol,
        terminal: Default::default(),
    };
    core.vault.save_host(input).await.unwrap().id
}

/// Collects output until `needle` appears, acknowledging it like a renderer.
async fn output_until(
    core: &Core,
    session: &str,
    rx: &mut mpsc::UnboundedReceiver<Message>,
    needle: &[u8],
) -> Vec<SessionEvent> {
    let mut text = Vec::new();
    let mut events = Vec::new();
    let deadline = tokio::time::Instant::now() + WAIT;
    while !text.windows(needle.len()).any(|w| w == needle) {
        match tokio::time::timeout_at(deadline, rx.recv()).await.expect("timed out").expect("closed") {
            Message::Output(bytes) => {
                // The session may already have ended (the server hung up after this output).
                let _ = core.sessions.ack(WINDOW, session, bytes.len() as u32).await;
                text.extend_from_slice(&bytes);
            }
            Message::Event(event) => events.push(event),
        }
    }
    events
}

async fn read_exactly(stream: &mut tokio::net::TcpStream, want: &[u8]) {
    let mut got = Vec::new();
    let deadline = tokio::time::Instant::now() + WAIT;
    while !got.windows(want.len()).any(|w| w == want) {
        let mut buf = [0u8; 256];
        let n = tokio::time::timeout_at(deadline, stream.read(&mut buf)).await.expect("timed out").unwrap();
        assert!(n > 0, "client closed early; got {got:?}");
        got.extend_from_slice(&buf[..n]);
    }
}

#[tokio::test]
async fn a_telnet_host_warns_negotiates_and_carries_the_terminal() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        // Ask for the window size, offer to echo, and ask for something a client must refuse.
        s.write_all(&[IAC, 253, 31, IAC, 251, 1, IAC, 253, 39]).await.unwrap();
        // Window size 100x30, echo accepted, NEW-ENVIRON refused.
        read_exactly(&mut s, &[IAC, 250, 31, 0, 100, 0, 30, IAC, 240]).await;
        s.write_all(b"login: ").await.unwrap();
        // Enter is CR NUL; a 0xFF the user sends is doubled.
        read_exactly(&mut s, &[b'g', b'u', b'e', b's', b't', IAC, IAC, b'\r', 0]).await;
        s.write_all(&[b'w', b'e', b'l', b'c', b'o', b'm', b'e', IAC, IAC, b'\r', b'\n']).await.unwrap();
        // A resize is reported while the session runs.
        read_exactly(&mut s, &[IAC, 250, 31, 0, 120, 0, 40, IAC, 240]).await;
        s.write_all(b"bye\r\n").await.unwrap();
    });

    let (_dir, core) = core().await;
    let id = host(&core, "127.0.0.1", Some(port), HostProtocol::Telnet).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = core.sessions.open_ssh(WINDOW, &id, 100, 30, Arc::new(Sink(tx))).await.unwrap().session_id;
    let events = output_until(&core, &session, &mut rx, b"login: ").await;
    let SessionEvent::Banner { text } = &events[0] else {
        panic!("the first thing shown must be the warning: {events:?}")
    };
    assert!(text.contains("not encrypted"));
    assert!(events.contains(&SessionEvent::State { state: SessionState::Connected }));

    core.sessions.write(WINDOW, &session, [b'g', b'u', b'e', b's', b't', IAC, b'\r'].to_vec()).await.unwrap();
    output_until(&core, &session, &mut rx, &[b'w', b'e', b'l', b'c', b'o', b'm', b'e', IAC, b'\r']).await;
    core.sessions.resize(WINDOW, &session, 120, 40).await.unwrap();
    let mut events = output_until(&core, &session, &mut rx, b"bye").await;
    server.await.unwrap();
    // The server hung up: the session ends.
    while !events.iter().any(|e| matches!(e, SessionEvent::Closed { .. })) {
        if let Message::Event(event) = tokio::time::timeout(WAIT, rx.recv()).await.unwrap().unwrap() {
            events.push(event);
        }
    }
    assert_eq!(core.sessions.count(), 0);
}

#[tokio::test]
async fn telnet_defaults_to_port_23_and_an_unreachable_server_fails_cleanly() {
    let (_dir, core) = core().await;
    // Port 23 on loopback is closed on CI runners and here: the attempt fails without hanging.
    let id = host(&core, "127.0.0.1", None, HostProtocol::Telnet).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    core.sessions.open_ssh(WINDOW, &id, 80, 24, Arc::new(Sink(tx))).await.unwrap();
    loop {
        if let Message::Event(SessionEvent::Closed { error, .. }) =
            tokio::time::timeout(Duration::from_secs(20), rx.recv()).await.unwrap().unwrap()
        {
            assert!(error.is_some());
            break;
        }
    }
}

#[tokio::test]
async fn serial_settings_are_checked_when_saved_and_when_opened() {
    let (_dir, core) = core().await;
    let serial = |path: &str, baud| HostProtocol::Serial {
        settings: SerialSettings { path: path.into(), baud, ..SerialSettings::default() },
    };
    let bad = HostInput {
        id: None,
        label: "console".into(),
        address: "console".into(),
        port: None,
        username: String::new(),
        auth: HostAuthInput::AskPassword,
        group_id: None,
        tags: Vec::new(),
        protocol: serial("/dev/ttyUSB0", 0),
        terminal: Default::default(),
    };
    assert!(core.vault.save_host(bad).await.is_err(), "a zero baud rate is refused at save");
    // A file that is not a device is never opened as a port.
    let file = tempfile::NamedTempFile::new().unwrap();
    let id = host(&core, "console", None, serial(file.path().to_str().unwrap(), 9600)).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    core.sessions.open_ssh(WINDOW, &id, 80, 24, Arc::new(Sink(tx))).await.unwrap();
    loop {
        if let Message::Event(SessionEvent::Closed { error, .. }) =
            tokio::time::timeout(WAIT, rx.recv()).await.unwrap().unwrap()
        {
            assert!(error.unwrap().message.contains("not a serial port"));
            break;
        }
    }
}

/// Needs `socat` (CI installs it); the runner reports this test BLOCKED otherwise.
#[tokio::test]
#[ignore = "needs socat for a pseudo-terminal pair"]
#[cfg(unix)]
async fn a_serial_host_carries_bytes_both_ways() {
    let dir = TempDir::new().unwrap();
    let (a, b) = (dir.path().join("dev-a"), dir.path().join("dev-b"));
    let mut socat = std::process::Command::new("socat")
        .arg(format!("pty,raw,echo=0,link={}", a.display()))
        .arg(format!("pty,raw,echo=0,link={}", b.display()))
        .spawn()
        .expect("socat must be installed");
    for _ in 0..50 {
        if a.exists() && b.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (_vault_dir, core) = core().await;
    let device = std::fs::canonicalize(&a).unwrap();
    let settings = SerialSettings { path: device.to_str().unwrap().into(), baud: 115_200, ..SerialSettings::default() };
    let id = host(&core, "console", None, HostProtocol::Serial { settings }).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = core.sessions.open_ssh(WINDOW, &id, 80, 24, Arc::new(Sink(tx))).await.unwrap().session_id;
    // The other end plays the device: it answers what the terminal sends.
    let peer = std::fs::canonicalize(&b).unwrap();
    let device_side = tokio::task::spawn_blocking(move || {
        use std::io::{Read, Write};
        let mut f = std::fs::OpenOptions::new().read(true).write(true).open(peer).unwrap();
        let mut buf = [0u8; 64];
        let mut got = Vec::new();
        while !got.ends_with(b"AT\r") {
            let n = f.read(&mut buf).unwrap();
            got.extend_from_slice(&buf[..n]);
        }
        f.write_all(b"OK\r\n").unwrap();
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    core.sessions.write(WINDOW, &session, b"AT\r".to_vec()).await.unwrap();
    output_until(&core, &session, &mut rx, b"OK").await;
    device_side.await.unwrap();
    core.sessions.close(WINDOW, &session).unwrap();
    let _ = socat.kill();
    let _ = socat.wait();
}

#[tokio::test]
async fn a_host_encoding_and_terminal_type_apply_both_ways() {
    use tyrminal_core::contracts::{HostTerminal, TerminalEncoding, TerminalType};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        // Ask for the terminal type, then send KOI8-R text.
        s.write_all(&[IAC, 253, 24]).await.unwrap();
        read_exactly(&mut s, &[IAC, 251, 24]).await;
        s.write_all(&[IAC, 250, 24, 1, IAC, 240]).await.unwrap();
        read_exactly(&mut s, b"\xff\xfa\x18\x00VT100\xff\xf0").await;
        s.write_all(&[0xF0, 0xD2, 0xC9, 0xD7, 0xC5, 0xD4, b'\r', b'\n']).await.unwrap(); // "Привет"
        // What the user types reaches the server in KOI8-R.
        read_exactly(&mut s, &[0xE4, 0xC1, b'\r', 0]).await; // "Да"
        s.write_all(b"ok\r\n").await.unwrap();
    });
    let (_dir, core) = core().await;
    let input = HostInput {
        id: None,
        label: "old box".into(),
        address: "127.0.0.1".into(),
        port: Some(port),
        username: String::new(),
        auth: HostAuthInput::AskPassword,
        group_id: None,
        tags: Vec::new(),
        protocol: HostProtocol::Telnet,
        terminal: HostTerminal { encoding: TerminalEncoding::Koi8R, term: TerminalType::Vt100 },
    };
    let saved = core.vault.save_host(input).await.unwrap();
    assert_eq!(saved.terminal.encoding, TerminalEncoding::Koi8R);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = core.sessions.open_ssh(WINDOW, &saved.id, 80, 24, Arc::new(Sink(tx))).await.unwrap().session_id;
    output_until(&core, &session, &mut rx, "Привет".as_bytes()).await;
    core.sessions.write(WINDOW, &session, "Да\r".as_bytes().to_vec()).await.unwrap();
    output_until(&core, &session, &mut rx, b"ok").await;
    server.await.unwrap();
}
