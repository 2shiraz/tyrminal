//! Fault injection (Phase 02 gate, INV-16): a writer process is killed at random moments while it
//! swaps the vault header and writes multi-record batches. After every kill the database must
//! open, pass SQLite's integrity check, and show each write entirely or not at all.
//!
//! The writer is this test binary re-executed with `TYRMINAL_FAULT_WRITER` set, so the kill hits a
//! real separate process (SIGKILL on Unix, TerminateProcess on Windows), not a dropped future.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use tempfile::TempDir;
use tyrminal_storage::{Database, RecordRow, WriteCondition};

const HEADER_A: &[u8] = &[0xA1; 300];
const HEADER_B: &[u8] = &[0xB2; 300];
const BATCH: u8 = 12;

fn row(id: u8, revision: u64) -> RecordRow {
    RecordRow {
        record_id: [id; 16],
        kind: 1,
        revision,
        key_version: 1,
        nonce: [revision as u8; 24],
        // Big enough that a batch spans several database pages.
        ciphertext: vec![revision as u8; 16 * 1024],
        deleted: false,
    }
}

/// Child side: swap the header and rewrite a whole batch, forever, until killed.
#[tokio::test]
async fn fault_writer_child() {
    let Some(path) = std::env::var_os("TYRMINAL_FAULT_WRITER") else { return };
    let db = Database::open(Path::new(&path)).unwrap();
    let mut header = db.read_header().await.unwrap().unwrap();
    loop {
        let next = if header == HEADER_A { HEADER_B } else { HEADER_A };
        db.replace_header(header.clone(), next.to_vec()).await.unwrap();
        header = next.to_vec();
        let current = db.get_record([0; 16]).await.unwrap().unwrap().revision;
        let batch = (0..BATCH)
            .map(|id| (row(id, current + 1), WriteCondition::Replace { expected_revision: current }))
            .collect();
        db.put_records(batch).await.unwrap();
        // Tell the parent that writes are flowing (first iteration only matters).
        println!("tick");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn killing_the_writer_never_leaves_a_partial_write() {
    if std::env::var_os("TYRMINAL_FAULT_WRITER").is_some() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("vault.db");
    {
        let db = Database::open(&path).unwrap();
        db.init_header(HEADER_A.to_vec()).await.unwrap();
        db.put_records((0..BATCH).map(|id| (row(id, 1), WriteCondition::Create)).collect()).await.unwrap();
    }

    let exe = std::env::current_exe().unwrap();
    let mut last_revision = 1;
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    for round in 0..12 {
        let mut child = Command::new(&exe)
            .args(["--exact", "fault_writer_child", "--nocapture", "--test-threads=1"])
            .env("TYRMINAL_FAULT_WRITER", &path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // A different moment each round (deterministic xorshift, 150–650 ms after start).
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        tokio::time::sleep(Duration::from_millis(150 + seed % 500)).await;
        child.kill().unwrap();
        child.wait().unwrap();

        let db = Database::open(&path).unwrap();
        db.integrity_check().await.unwrap_or_else(|e| panic!("round {round}: integrity check failed: {e:?}"));
        let header = db.read_header().await.unwrap().unwrap();
        assert!(header == HEADER_A || header == HEADER_B, "round {round}: a mixed header is on disk");
        let rows = db.list_records().await.unwrap();
        assert_eq!(rows.len(), BATCH as usize, "round {round}");
        let revision = rows[0].revision;
        for r in &rows {
            assert_eq!(r.revision, revision, "round {round}: a batch was applied partially");
            assert_eq!(r.ciphertext, vec![revision as u8; 16 * 1024], "round {round}: a row is torn");
        }
        // The writer really was writing when it was killed (otherwise this test proves nothing).
        assert!(revision > last_revision, "round {round}: no write happened before the kill");
        last_revision = revision;
    }
}
