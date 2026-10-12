//! Storage tests against real files on disk (BUILD_SPEC §9.3 "Local persistence", INV-16).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;

use tempfile::TempDir;
use tyrminal_storage::{Database, LATEST_SCHEMA_VERSION, RecordRow, StorageError, WriteCondition};

fn row(id: u8, revision: u64, fill: u8) -> RecordRow {
    RecordRow {
        record_id: [id; 16],
        kind: 1,
        revision,
        key_version: 1,
        nonce: [fill; 24],
        ciphertext: vec![fill; 272],
        deleted: false,
    }
}

fn open(dir: &TempDir) -> Database {
    Database::open(&dir.path().join("vault.db")).expect("open")
}

#[tokio::test]
async fn header_is_created_once_and_swapped_only_from_the_expected_value() {
    let dir = TempDir::new().unwrap();
    let db = open(&dir);
    assert_eq!(db.read_header().await.unwrap(), None);
    db.init_header(vec![1; 300]).await.unwrap();
    assert_eq!(db.init_header(vec![2; 300]).await, Err(StorageError::AlreadyInitialized));
    assert_eq!(db.read_header().await.unwrap(), Some(vec![1; 300]));

    // Compare-and-swap: a stale writer loses and the header is untouched.
    assert_eq!(db.replace_header(vec![9; 300], vec![3; 300]).await, Err(StorageError::Conflict));
    assert_eq!(db.read_header().await.unwrap(), Some(vec![1; 300]));
    db.replace_header(vec![1; 300], vec![3; 300]).await.unwrap();
    assert_eq!(db.read_header().await.unwrap(), Some(vec![3; 300]));

    // Oversized and empty headers violate the schema.
    assert_eq!(db.replace_header(vec![3; 300], vec![0; 5000]).await, Err(StorageError::Constraint));
    assert_eq!(db.replace_header(vec![3; 300], vec![]).await, Err(StorageError::Constraint));
    assert_eq!(db.read_header().await.unwrap(), Some(vec![3; 300]));
}

#[tokio::test]
async fn records_use_optimistic_concurrency_with_strictly_increasing_revisions() {
    let dir = TempDir::new().unwrap();
    let db = open(&dir);
    db.put_record(row(1, 1, 0xA1), WriteCondition::Create).await.unwrap();
    assert_eq!(db.put_record(row(1, 1, 0xA2), WriteCondition::Create).await, Err(StorageError::Conflict));
    assert_eq!(db.put_record(row(2, 2, 0xA2), WriteCondition::Create).await, Err(StorageError::Constraint));

    db.put_record(row(1, 2, 0xB1), WriteCondition::Replace { expected_revision: 1 }).await.unwrap();
    // Stale base revision.
    assert_eq!(
        db.put_record(row(1, 2, 0xB2), WriteCondition::Replace { expected_revision: 1 }).await,
        Err(StorageError::Conflict)
    );
    // Revision must advance by exactly one: no skipping, no rollback through this API.
    for bad in [2, 4, 1] {
        assert_eq!(
            db.put_record(row(1, bad, 0xB3), WriteCondition::Replace { expected_revision: 2 }).await,
            Err(StorageError::Constraint)
        );
    }
    assert_eq!(
        db.put_record(row(7, 2, 0xB4), WriteCondition::Replace { expected_revision: 1 }).await,
        Err(StorageError::NotFound)
    );
    assert_eq!(db.get_record([1; 16]).await.unwrap(), Some(row(1, 2, 0xB1)));
    assert_eq!(db.get_record([9; 16]).await.unwrap(), None);
}

#[tokio::test]
async fn a_batch_is_all_or_nothing() {
    let dir = TempDir::new().unwrap();
    let db = open(&dir);
    db.put_record(row(1, 1, 0x01), WriteCondition::Create).await.unwrap();
    let batch = vec![
        (row(2, 1, 0x02), WriteCondition::Create),
        (row(1, 2, 0x11), WriteCondition::Replace { expected_revision: 1 }),
        (row(3, 1, 0x03), WriteCondition::Create),
        (row(1, 9, 0x99), WriteCondition::Replace { expected_revision: 5 }), // fails
    ];
    assert_eq!(db.put_records(batch).await, Err(StorageError::Conflict));
    assert_eq!(db.list_records().await.unwrap(), vec![row(1, 1, 0x01)], "nothing from the failed batch persisted");

    let batch = vec![
        (row(2, 1, 0x02), WriteCondition::Create),
        (row(1, 2, 0x11), WriteCondition::Replace { expected_revision: 1 }),
    ];
    db.put_records(batch).await.unwrap();
    assert_eq!(db.list_records().await.unwrap(), vec![row(1, 2, 0x11), row(2, 1, 0x02)]);
}

#[tokio::test]
async fn schema_constraints_reject_malformed_rows() {
    let dir = TempDir::new().unwrap();
    let db = open(&dir);
    let mut short = row(1, 1, 0x01);
    short.ciphertext.truncate(271);
    assert_eq!(db.put_record(short, WriteCondition::Create).await, Err(StorageError::Constraint));
    let mut huge = row(1, 1, 0x01);
    huge.ciphertext = vec![0; 1_048_849];
    assert_eq!(db.put_record(huge, WriteCondition::Create).await, Err(StorageError::Constraint));
    let mut zero_key = row(1, 1, 0x01);
    zero_key.key_version = 0;
    assert_eq!(db.put_record(zero_key, WriteCondition::Create).await, Err(StorageError::Constraint));
    assert!(db.list_records().await.unwrap().is_empty());
}

#[tokio::test]
async fn data_survives_close_and_reopen() {
    let dir = TempDir::new().unwrap();
    {
        let db = open(&dir);
        db.init_header(vec![7; 309]).await.unwrap();
        db.put_record(row(5, 1, 0x55), WriteCondition::Create).await.unwrap();
    }
    let db = open(&dir);
    assert_eq!(db.read_header().await.unwrap(), Some(vec![7; 309]));
    assert_eq!(db.list_records().await.unwrap(), vec![row(5, 1, 0x55)]);
    db.integrity_check().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn database_wal_and_snapshot_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new().unwrap();
    let db = open(&dir);
    db.init_header(vec![7; 309]).await.unwrap();
    db.put_record(row(5, 1, 0x55), WriteCondition::Create).await.unwrap();
    let snapshot = dir.path().join("snapshot.db");
    db.snapshot_to(snapshot.clone()).await.unwrap();

    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    let mut checked = 0;
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let path = entry.unwrap().path();
        assert_eq!(mode(&path), 0o600, "{} must be owner-only", path.display());
        checked += 1;
    }
    assert!(checked >= 3, "expected the database, its WAL/SHM and the snapshot, saw {checked} files");

    // An existing over-permissive file is tightened on open rather than trusted.
    drop(db);
    let main = dir.path().join("vault.db");
    std::fs::set_permissions(&main, std::fs::Permissions::from_mode(0o644)).unwrap();
    let _db = open(&dir);
    assert_eq!(mode(&main), 0o600);
}

#[tokio::test]
async fn snapshot_is_a_consistent_openable_copy_and_never_overwrites() {
    let dir = TempDir::new().unwrap();
    let db = open(&dir);
    db.init_header(vec![7; 309]).await.unwrap();
    for i in 1..=50 {
        db.put_record(row(i, 1, i), WriteCondition::Create).await.unwrap();
    }
    let snapshot = dir.path().join("copy.db");
    db.snapshot_to(snapshot.clone()).await.unwrap();
    assert_eq!(db.snapshot_to(snapshot.clone()).await, Err(StorageError::AlreadyInitialized));

    // Later writes to the live database do not appear in the snapshot.
    db.put_record(row(99, 1, 9), WriteCondition::Create).await.unwrap();
    let copy = Database::open(&snapshot).unwrap();
    assert_eq!(copy.list_records().await.unwrap().len(), 50);
    assert_eq!(copy.read_header().await.unwrap(), Some(vec![7; 309]));
    copy.integrity_check().await.unwrap();
}

#[tokio::test]
async fn foreign_newer_and_garbage_files_are_refused_and_left_untouched() {
    let dir = TempDir::new().unwrap();

    // Not SQLite at all.
    let garbage = dir.path().join("garbage.db");
    std::fs::write(&garbage, b"this is definitely not a database, just some text padding....").unwrap();
    let before = std::fs::read(&garbage).unwrap();
    assert!(matches!(Database::open(&garbage).err(), Some(StorageError::NotAVault | StorageError::Corrupt)));
    assert_eq!(std::fs::read(&garbage).unwrap(), before);

    // A valid SQLite database that belongs to something else.
    let foreign = dir.path().join("foreign.db");
    {
        let conn = rusqlite_open(&foreign);
        conn.execute_batch("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep me');").unwrap();
    }
    assert_eq!(Database::open(&foreign).err(), Some(StorageError::NotAVault));
    let conn = rusqlite_open(&foreign);
    let body: String = conn.query_row("SELECT body FROM notes", [], |r| r.get(0)).unwrap();
    assert_eq!(body, "keep me");
    drop(conn);

    // A vault written by a newer build.
    let newer = dir.path().join("newer.db");
    drop(Database::open(&newer).unwrap());
    {
        let conn = rusqlite_open(&newer);
        conn.pragma_update(None, "user_version", LATEST_SCHEMA_VERSION + 1).unwrap();
    }
    assert_eq!(Database::open(&newer).err(), Some(StorageError::NewerSchema));
    let conn = rusqlite_open(&newer);
    let v: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    assert_eq!(v, LATEST_SCHEMA_VERSION + 1, "a refused database must not be downgraded");
}

#[tokio::test]
async fn a_symlinked_database_path_is_not_followed() {
    #[cfg(unix)]
    {
        let dir = TempDir::new().unwrap();
        let real = dir.path().join("real.db");
        drop(Database::open(&real).unwrap());
        let link = dir.path().join("link.db");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(Database::open(&link).err(), Some(StorageError::Open));
    }
}

#[tokio::test]
async fn many_concurrent_callers_are_served_through_the_bounded_queue() {
    let dir = TempDir::new().unwrap();
    let db = open(&dir);
    let mut tasks = Vec::new();
    for i in 0..200u8 {
        let db = db.clone();
        tasks.push(tokio::spawn(async move { db.put_record(row(i, 1, i), WriteCondition::Create).await }));
    }
    for t in tasks {
        t.await.unwrap().unwrap();
    }
    assert_eq!(db.list_records().await.unwrap().len(), 200);
}

fn rusqlite_open(path: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(path).unwrap()
}

#[tokio::test]
async fn replacing_the_vault_is_atomic_and_guarded_by_the_expected_header() {
    let dir = TempDir::new().unwrap();
    let db = open(&dir);
    db.init_header(b"old header".to_vec()).await.unwrap();
    db.put_record(row(1, 1, 1), WriteCondition::Create).await.unwrap();

    // A stale expectation changes nothing.
    let stale = db.replace_vault(Some(b"other".to_vec()), b"new header".to_vec(), vec![row(2, 5, 2)]).await;
    assert_eq!(stale.unwrap_err(), StorageError::Conflict);
    // A failure part-way (duplicate id) rolls everything back.
    let broken =
        db.replace_vault(Some(b"old header".to_vec()), b"new header".to_vec(), vec![row(2, 5, 2), row(2, 6, 3)]).await;
    assert!(broken.is_err());
    assert_eq!(db.read_header().await.unwrap().unwrap(), b"old header");
    assert_eq!(db.list_records().await.unwrap(), vec![row(1, 1, 1)]);

    // Success: the old records are gone, the new ones keep their revisions.
    db.replace_vault(Some(b"old header".to_vec()), b"new header".to_vec(), vec![row(2, 5, 2), row(3, 9, 3)])
        .await
        .unwrap();
    assert_eq!(db.read_header().await.unwrap().unwrap(), b"new header");
    assert_eq!(db.list_records().await.unwrap(), vec![row(2, 5, 2), row(3, 9, 3)]);

    // Into an empty database (restore on a fresh install).
    let dir2 = TempDir::new().unwrap();
    let fresh = open(&dir2);
    fresh.replace_vault(None, b"h".to_vec(), vec![row(4, 1, 4)]).await.unwrap();
    assert_eq!(fresh.list_records().await.unwrap(), vec![row(4, 1, 4)]);
}
