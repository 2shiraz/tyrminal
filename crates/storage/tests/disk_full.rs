//! Disk-full fault injection (Phase 02 gate, INV-16): a writer process runs under a file-size
//! limit (`ulimit -f`, with SIGXFSZ ignored so the kernel returns EFBIG instead of killing it)
//! and keeps writing multi-record batches until the storage refuses. The refusal must be an
//! error, not a panic or a torn write; afterwards, without the limit, the database must pass
//! SQLite's integrity check, show every batch entirely or not at all, and accept writes again.
//!
//! Unix only: Windows has no per-process file-size limit. The same SQLite error path is reached
//! there by a full volume, which CI cannot create without administrator rights.

#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use tyrminal_storage::{Database, RecordRow, StorageError, WriteCondition};

const BATCH: u8 = 12;

fn row(id: u8, revision: u64) -> RecordRow {
    RecordRow {
        record_id: [id; 16],
        kind: 1,
        revision,
        key_version: 1,
        nonce: [revision as u8; 24],
        ciphertext: vec![revision as u8; 16 * 1024],
        deleted: false,
    }
}

async fn write_batch(db: &Database) -> Result<u64, StorageError> {
    let current = db.get_record([0; 16]).await?.expect("record 0").revision;
    let batch =
        (0..BATCH).map(|id| (row(id, current + 1), WriteCondition::Replace { expected_revision: current })).collect();
    db.put_records(batch).await?;
    Ok(current + 1)
}

/// Child side: write until the storage refuses, then report how it refused.
#[tokio::test]
async fn disk_full_writer_child() {
    let Some(path) = std::env::var_os("TYRMINAL_DISK_FULL_WRITER") else { return };
    let db = Database::open(Path::new(&path)).unwrap();
    for _ in 0..10_000 {
        if let Err(error) = write_batch(&db).await {
            // The handle still answers reads after the refusal.
            let rows = db.list_records().await.unwrap();
            assert_eq!(rows.len(), BATCH as usize);
            println!("REFUSED {error:?}");
            return;
        }
    }
    println!("NEVER-REFUSED");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_disk_refuses_the_write_and_leaves_the_vault_consistent() {
    if std::env::var_os("TYRMINAL_DISK_FULL_WRITER").is_some() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("vault.db");
    {
        let db = Database::open(&path).unwrap();
        db.init_header(vec![0xA1; 300]).await.unwrap();
        db.put_records((0..BATCH).map(|id| (row(id, 1), WriteCondition::Create)).collect()).await.unwrap();
    }

    // Room for a few batches beyond what is on disk now, in 512-byte blocks (bash counts
    // 1024-byte blocks, which only doubles the room).
    let blocks = 4096;
    let exe = std::env::current_exe().unwrap();
    let output = Command::new("/bin/sh")
        .arg("-c")
        .arg(format!(r#"trap '' XFSZ; ulimit -f {blocks} && exec "$0" --exact disk_full_writer_child --nocapture --test-threads=1"#))
        .arg(&exe)
        .env("TYRMINAL_DISK_FULL_WRITER", &path)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "writer failed: {stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    assert!(stdout.contains("REFUSED"), "the size limit never stopped a write: {stdout}");
    assert!(
        stdout.contains("REFUSED Full") || stdout.contains("REFUSED Io"),
        "a full disk is reported as Full or Io: {stdout}"
    );

    let db = Database::open(&path).unwrap();
    db.integrity_check().await.unwrap();
    let rows = db.list_records().await.unwrap();
    assert_eq!(rows.len(), BATCH as usize);
    let revision = rows[0].revision;
    assert!(revision > 1, "some batches were written before the disk filled");
    for r in &rows {
        assert_eq!(r.revision, revision, "a batch was applied partially");
        assert_eq!(r.ciphertext, vec![revision as u8; 16 * 1024], "a row is torn");
    }
    // With space again, writing works.
    assert_eq!(write_batch(&db).await.unwrap(), revision + 1);
}
