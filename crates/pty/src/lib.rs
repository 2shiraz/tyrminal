//! Local terminal processes over a PTY (Unix) or ConPTY (Windows) via `portable-pty`.
//!
//! - The program and its arguments are a structured argv. Nothing is ever joined into a shell
//!   command line here (INV-13).
//! - Output flows through a bounded channel. When the consumer stops reading, the reader thread
//!   blocks, the kernel PTY buffer fills and the child process blocks: nothing is dropped and
//!   memory stays bounded (INV-12).
//! - The child is killed when the terminal is dropped.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use thiserror::Error;
use tokio::sync::mpsc;

/// Bytes read from the PTY per chunk.
const READ_CHUNK: usize = 16 * 1024;
/// Output chunks buffered before the reader thread blocks (≈1 MiB with `READ_CHUNK`).
const OUTPUT_QUEUE: usize = 64;
/// Pending input writes before `write` waits.
const INPUT_QUEUE: usize = 64;
/// Largest single input write accepted (BUILD_SPEC §13: 64 KiB terminal input chunks).
pub const MAX_INPUT_CHUNK: usize = 64 * 1024;
const MAX_DIMENSION: u16 = 1000;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum PtyError {
    #[error("the shell program is not an absolute path to an existing file")]
    InvalidProgram,
    #[error("the working directory does not exist")]
    InvalidWorkingDirectory,
    #[error("the pseudo-terminal could not be created")]
    OpenFailed,
    #[error("the program could not be started")]
    SpawnFailed,
    #[error("the terminal process has ended")]
    Closed,
    #[error("the input chunk exceeds the size limit")]
    InputTooLarge,
    #[error("the terminal operation failed")]
    Io,
}

/// What to run. `program` must be an absolute path; arguments are passed verbatim as argv.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Extra environment variables. The child otherwise inherits this process's environment,
    /// which by project rule never contains secrets.
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

impl ShellSpec {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), args: Vec::new(), cwd: None, env: Vec::new(), cols: 80, rows: 24 }
    }
}

/// The user's login shell when it is a usable absolute path, otherwise a platform default.
/// The `SHELL` value is only ever used as a program path, never interpreted.
pub fn default_shell() -> PathBuf {
    #[cfg(unix)]
    {
        let from_env = std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_absolute() && p.is_file());
        from_env
            .or_else(|| ["/bin/zsh", "/bin/bash", "/bin/sh"].iter().map(PathBuf::from).find(|p| p.is_file()))
            .unwrap_or_else(|| PathBuf::from("/bin/sh"))
    }
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let powershell = root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        if powershell.is_file() { powershell } else { root.join(r"System32\cmd.exe") }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// Raw output bytes. Untrusted when the local shell runs remote-controlled programs.
    Output(Vec<u8>),
    /// The process ended. `None` when no exit code is available (killed by a signal).
    Exit(Option<u32>),
}

/// How long the reader must sit in one `read` call, after the child exited, to count as drained.
const DRAIN_QUIET: std::time::Duration = std::time::Duration::from_millis(15);
const DRAIN_POLL: std::time::Duration = std::time::Duration::from_millis(3);

/// Shared view of what the reader thread is doing, for the drain decision at process exit.
#[derive(Default)]
struct ReadProgress {
    /// `Some(since)` while the reader is inside `read`; `None` while it handles or forwards data.
    reading_since: Mutex<Option<std::time::Instant>>,
    finished: std::sync::atomic::AtomicBool,
}

impl ReadProgress {
    fn set(&self, value: Option<std::time::Instant>) {
        *self.reading_since.lock().unwrap_or_else(|p| p.into_inner()) = value;
    }
    fn enter_read(&self) {
        self.set(Some(std::time::Instant::now()));
    }
    fn leave_read(&self) {
        self.set(None);
    }
    fn finish(&self) {
        self.finished.store(true, std::sync::atomic::Ordering::Release);
    }
    /// True once the reader has stopped, or has waited quietly in `read` long enough that the
    /// terminal's output queue must be empty. A reader stuck forwarding to a slow consumer is
    /// *not* drained, so backpressure never causes the slave to close early.
    fn drained(&self) -> bool {
        if self.finished.load(std::sync::atomic::Ordering::Acquire) {
            return true;
        }
        let since = *self.reading_since.lock().unwrap_or_else(|p| p.into_inner());
        since.is_some_and(|start| start.elapsed() >= DRAIN_QUIET)
    }
}

fn clamp(v: u16) -> u16 {
    v.clamp(1, MAX_DIMENSION)
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: clamp(rows), cols: clamp(cols), pixel_width: 0, pixel_height: 0 }
}

/// Receiving side of a local terminal.
#[derive(Debug)]
pub struct PtyReader {
    events: mpsc::Receiver<PtyEvent>,
}

impl PtyReader {
    /// Next event; `None` after `Exit` has been delivered.
    pub async fn next(&mut self) -> Option<PtyEvent> {
        self.events.recv().await
    }
}

/// Control side of a local terminal. Dropping it kills the process.
pub struct PtyHandle {
    input: mpsc::Sender<Vec<u8>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    desired: Mutex<(u16, u16)>,
    pid: Option<u32>,
}

impl core::fmt::Debug for PtyHandle {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("PtyHandle").field("pid", &self.pid).finish_non_exhaustive()
    }
}

impl PtyHandle {
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Queues input for the process. Waits when the process is not reading.
    pub async fn write(&self, data: &[u8]) -> Result<(), PtyError> {
        if data.len() > MAX_INPUT_CHUNK {
            return Err(PtyError::InputTooLarge);
        }
        if data.is_empty() {
            return Ok(());
        }
        self.input.send(data.to_vec()).await.map_err(|_| PtyError::Closed)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        let wanted = size(cols, rows);
        *self.desired.lock().map_err(|_| PtyError::Io)? = (wanted.cols, wanted.rows);
        let master = self.master.lock().map_err(|_| PtyError::Io)?;
        master.resize(wanted).map_err(|_| PtyError::Io)
    }

    /// Re-applies the last requested size if the terminal no longer has it. Returns whether a
    /// correction was needed.
    ///
    /// Why this exists: GNU readline (the macOS `/bin/sh`) reads the window size and writes the
    /// same value back when it prepares the terminal. A resize that lands between those two
    /// calls is overwritten with the old size, and the kernel then reports stale dimensions to
    /// every program. Measured at about 1 in 150 resizes issued right as a command finishes;
    /// zsh and dash do not do this. Callers should invoke this shortly after a resize settles.
    pub fn ensure_size(&self) -> Result<bool, PtyError> {
        let (cols, rows) = *self.desired.lock().map_err(|_| PtyError::Io)?;
        let master = self.master.lock().map_err(|_| PtyError::Io)?;
        let actual = master.get_size().map_err(|_| PtyError::Io)?;
        if actual.cols == cols && actual.rows == rows {
            return Ok(false);
        }
        master.resize(size(cols, rows)).map_err(|_| PtyError::Io)?;
        Ok(true)
    }

    /// Terminates the process. Safe to call more than once.
    pub fn kill(&self) {
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        self.kill();
    }
}

fn validate(spec: &ShellSpec) -> Result<(), PtyError> {
    if !spec.program.is_absolute() || !spec.program.is_file() {
        return Err(PtyError::InvalidProgram);
    }
    if let Some(cwd) = &spec.cwd
        && !(cwd.is_absolute() && Path::new(cwd).is_dir())
    {
        return Err(PtyError::InvalidWorkingDirectory);
    }
    Ok(())
}

/// Starts `spec` attached to a new pseudo-terminal.
pub fn spawn(spec: &ShellSpec) -> Result<(PtyReader, PtyHandle), PtyError> {
    validate(spec)?;
    let pair = native_pty_system().openpty(size(spec.cols, spec.rows)).map_err(|_| PtyError::OpenFailed)?;

    let mut command = CommandBuilder::new(spec.program.as_os_str());
    command.args(spec.args.iter());
    command.env("TERM", "xterm-256color");
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    if let Some(cwd) = &spec.cwd {
        command.cwd(cwd);
    }

    let mut child = pair.slave.spawn_command(command).map_err(|_| PtyError::SpawnFailed)?;
    let slave = pair.slave;

    let pid = child.process_id();
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|_| PtyError::OpenFailed)?;
    let mut writer = pair.master.take_writer().map_err(|_| PtyError::OpenFailed)?;

    let (event_tx, events) = mpsc::channel::<PtyEvent>(OUTPUT_QUEUE);
    let (input, mut input_rx) = mpsc::channel::<Vec<u8>>(INPUT_QUEUE);
    let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<u32>>();
    let progress = Arc::new(ReadProgress::default());

    // Waiter: owns our copy of the slave side and closes it only after the child has exited AND
    // the reader has drained what the child wrote.
    //
    // Why: when the last slave descriptor closes, macOS discards output the master has not read
    // yet. A short-lived program (`echo`, a failing command) can exit before the reader thread
    // has consumed its final bytes; closing our slave copy right after spawn made the child's
    // exit that last close and lost the tail of its output (observed roughly 1 run in 40).
    // With the slave held here the reader blocks instead of seeing EOF, so "drained" is detected
    // as the reader sitting inside one `read` call for `DRAIN_QUIET` with the child already gone.
    let waiter_progress = Arc::clone(&progress);
    thread::Builder::new()
        .name("tyrminal-pty-wait".into())
        .spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            while !waiter_progress.drained() {
                thread::sleep(DRAIN_POLL);
            }
            drop(slave);
            let _ = exit_tx.send(code);
        })
        .map_err(|_| PtyError::SpawnFailed)?;

    thread::Builder::new()
        .name("tyrminal-pty-read".into())
        .spawn(move || {
            let mut buffer = vec![0u8; READ_CHUNK];
            loop {
                progress.enter_read();
                let result = reader.read(&mut buffer);
                progress.leave_read();
                match result {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // Blocks while the consumer is behind: this is the backpressure point.
                        if event_tx.blocking_send(PtyEvent::Output(buffer[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            progress.finish();
            let code = exit_rx.recv().ok().flatten();
            let _ = event_tx.blocking_send(PtyEvent::Exit(code));
        })
        .map_err(|_| PtyError::SpawnFailed)?;

    thread::Builder::new()
        .name("tyrminal-pty-write".into())
        .spawn(move || {
            while let Some(chunk) = input_rx.blocking_recv() {
                if writer.write_all(&chunk).and_then(|()| writer.flush()).is_err() {
                    break;
                }
            }
        })
        .map_err(|_| PtyError::SpawnFailed)?;

    Ok((
        PtyReader { events },
        PtyHandle {
            input,
            master: Arc::new(Mutex::new(pair.master)),
            killer: Mutex::new(killer),
            desired: Mutex::new((clamp(spec.cols), clamp(spec.rows))),
            pid,
        },
    ))
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::time::Duration;

    use super::*;

    async fn read_until(reader: &mut PtyReader, needle: &str) -> String {
        let mut text = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !text.contains(needle) {
            match tokio::time::timeout_at(deadline, reader.next()).await {
                Ok(Some(PtyEvent::Output(bytes))) => text.push_str(&String::from_utf8_lossy(&bytes)),
                Ok(Some(PtyEvent::Exit(code))) => panic!("exited ({code:?}) before {needle:?}: {text:?}"),
                Ok(None) => panic!("closed before {needle:?}: {text:?}"),
                Err(_) => panic!("timed out waiting for {needle:?}: {text:?}"),
            }
        }
        text
    }

    async fn drain_to_exit(reader: &mut PtyReader) -> (Vec<u8>, Option<u32>) {
        let mut out = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(30), reader.next()).await.expect("no hang") {
                Some(PtyEvent::Output(bytes)) => out.extend_from_slice(&bytes),
                Some(PtyEvent::Exit(code)) => return (out, code),
                None => panic!("channel closed without an Exit event"),
            }
        }
    }

    /// Asks the shell for the terminal size until it reports `expected`, reconciling in between
    /// exactly as the application does (see `PtyHandle::ensure_size`). Bounded: 20 attempts.
    async fn await_size(reader: &mut PtyReader, handle: &PtyHandle, expected: &str) {
        for attempt in 0..20 {
            // The typed command contains `$((40+2))`, so only real output contains `-42`.
            let command = format!("echo \"probe{attempt}=$(stty size)=end{attempt}-$((40+2))\"\n");
            handle.write(command.as_bytes()).await.unwrap();
            let text = read_until(reader, &format!("=end{attempt}-42")).await;
            if text.contains(&format!("probe{attempt}={expected}=end{attempt}-42")) {
                return;
            }
            handle.ensure_size().unwrap();
        }
        panic!("terminal never reported size {expected}");
    }

    fn sh() -> ShellSpec {
        let mut spec = ShellSpec::new("/bin/sh");
        // A quiet, predictable prompt and no user startup files.
        spec.env = vec![("PS1".into(), "$ ".into()), ("ENV".into(), String::new())];
        spec
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shell_runs_commands_resizes_and_reports_its_exit_code() {
        let (mut reader, handle) = spawn(&sh()).unwrap();
        assert!(handle.pid().is_some());
        handle.write(b"echo local-$((40+2)); echo TERM=$TERM; stty size\n").await.unwrap();
        let text = read_until(&mut reader, "24 80").await;
        assert!(text.contains("local-42") && text.contains("TERM=xterm-256color"), "{text:?}");

        handle.resize(120, 40).unwrap();
        await_size(&mut reader, &handle, "40 120").await;

        handle.write(b"exit 9\n").await.unwrap();
        assert_eq!(drain_to_exit(&mut reader).await.1, Some(9));
        assert_eq!(reader.next().await, None, "nothing follows Exit");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn arguments_are_argv_not_shell_syntax() {
        let marker = std::env::temp_dir().join(format!("tyrminal-pty-injection-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let hostile = format!("$(touch {0}); touch {0} & `touch {0}` | x > {0}", marker.display());
        let mut spec = ShellSpec::new("/bin/echo");
        spec.args = vec![hostile.clone(), "--".into(), "-n".into()];
        let (mut reader, _handle) = spawn(&spec).unwrap();
        let (out, code) = drain_to_exit(&mut reader).await;
        assert_eq!(code, Some(0));
        assert!(String::from_utf8_lossy(&out).contains(&hostile), "printed verbatim");
        assert!(!marker.exists(), "argument text was executed as shell syntax");
    }

    /// Regression test for output lost at process exit (see the waiter thread in `spawn`).
    /// Each process prints a known payload and exits immediately; every byte must arrive.
    #[tokio::test(flavor = "multi_thread")]
    async fn short_lived_processes_never_lose_their_final_output() {
        let payload = "tail-".to_owned() + &"0123456789abcdef".repeat(180); // ~2.9 KiB, one line
        let mut tasks = Vec::new();
        for worker in 0..8 {
            let payload = payload.clone();
            tasks.push(tokio::spawn(async move {
                for round in 0..40 {
                    let mut spec = ShellSpec::new("/bin/echo");
                    spec.args = vec![payload.clone()];
                    let (mut reader, _handle) = spawn(&spec).unwrap();
                    let (out, code) = drain_to_exit(&mut reader).await;
                    assert_eq!(code, Some(0));
                    let text = String::from_utf8_lossy(&out);
                    assert!(
                        text.contains(&payload),
                        "worker {worker} round {round}: got {} of {} bytes",
                        out.len(),
                        payload.len()
                    );
                }
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn invalid_programs_and_directories_are_rejected_before_spawning() {
        for program in ["sh", "./sh", "/definitely/not/here", "/tmp", ""] {
            assert_eq!(spawn(&ShellSpec::new(program)).err(), Some(PtyError::InvalidProgram), "{program:?}");
        }
        let mut spec = sh();
        spec.cwd = Some("/definitely/not/a/dir".into());
        assert_eq!(spawn(&spec).err(), Some(PtyError::InvalidWorkingDirectory));
        spec.cwd = Some("relative/dir".into());
        assert_eq!(spawn(&spec).err(), Some(PtyError::InvalidWorkingDirectory));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn working_directory_and_extra_environment_are_applied() {
        let mut spec = ShellSpec::new("/bin/sh");
        spec.args = vec!["-c".into(), "pwd; printf '%s\\n' \"$TYR_FIXTURE\"".into()];
        spec.cwd = Some(std::fs::canonicalize(std::env::temp_dir()).unwrap());
        spec.env = vec![("TYR_FIXTURE".into(), "value with spaces; $(not run)".into())];
        let (mut reader, _handle) = spawn(&spec).unwrap();
        let (out, code) = drain_to_exit(&mut reader).await;
        let text = String::from_utf8_lossy(&out);
        assert_eq!(code, Some(0));
        assert!(text.contains(&*spec.cwd.as_ref().unwrap().to_string_lossy()), "{text:?}");
        assert!(text.contains("value with spaces; $(not run)"), "{text:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn kill_and_drop_terminate_the_process() {
        let mut spec = ShellSpec::new("/bin/sleep");
        spec.args = vec!["600".into()];
        let (mut reader, handle) = spawn(&spec).unwrap();
        handle.kill();
        handle.kill(); // idempotent
        let (_, code) = drain_to_exit(&mut reader).await;
        assert_ne!(code, Some(0));
        assert_eq!(handle.write(b"x").await.err(), None, "queued writes after exit are discarded, not an error path");

        let (mut reader, handle) = spawn(&spec).unwrap();
        let pid = handle.pid().unwrap();
        drop(handle);
        let (_, code) = drain_to_exit(&mut reader).await;
        assert_ne!(code, Some(0));
        // The pid no longer names a live child of ours.
        let alive = std::process::Command::new("/bin/kill").args(["-0", &pid.to_string()]).status().unwrap().success();
        assert!(!alive, "process {pid} survived the handle being dropped");
    }

    /// A fast producer with a consumer that stops reading: every line must still arrive in order.
    #[tokio::test(flavor = "multi_thread")]
    async fn output_survives_a_stalled_consumer_without_loss_or_reordering() {
        const LAST: u64 = 400_000;
        let mut spec = ShellSpec::new("/usr/bin/seq");
        spec.args = vec!["1".into(), LAST.to_string()];
        let (mut reader, _handle) = spawn(&spec).unwrap();
        let mut expected = 1u64;
        let mut partial = String::new();
        let mut stalled = false;
        let mut total = 0usize;
        let code = loop {
            match tokio::time::timeout(Duration::from_secs(60), reader.next()).await.expect("no hang") {
                Some(PtyEvent::Output(bytes)) => {
                    total += bytes.len();
                    partial.push_str(std::str::from_utf8(&bytes).unwrap());
                    while let Some(nl) = partial.find('\n') {
                        let line: u64 = partial[..nl].trim_end_matches('\r').parse().unwrap();
                        assert_eq!(line, expected, "output lost or reordered");
                        expected += 1;
                        partial.drain(..=nl);
                    }
                    if !stalled && total > 200_000 {
                        stalled = true;
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                    }
                }
                Some(PtyEvent::Exit(code)) => break code,
                None => panic!("closed early"),
            }
        };
        assert!(stalled);
        assert_eq!(code, Some(0));
        assert_eq!(expected, LAST + 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn oversized_input_is_refused_and_dimensions_are_clamped() {
        let mut spec = sh();
        spec.cols = 0;
        spec.rows = u16::MAX;
        let (mut reader, handle) = spawn(&spec).unwrap();
        assert_eq!(handle.write(&vec![b'a'; MAX_INPUT_CHUNK + 1]).await, Err(PtyError::InputTooLarge));
        handle.write(b"stty size; echo sized-$((40+2))\n").await.unwrap();
        let text = read_until(&mut reader, "sized-42").await;
        assert!(text.contains("1000 1"), "{text:?}");
        handle.resize(u16::MAX, 0).unwrap();
        await_size(&mut reader, &handle, "1 1000").await;
        assert!(!handle.ensure_size().unwrap(), "size is already correct, nothing to reconcile");
    }

    #[test]
    fn default_shell_is_an_existing_absolute_path() {
        let shell = default_shell();
        assert!(shell.is_absolute() && shell.is_file(), "{}", shell.display());
    }
}
