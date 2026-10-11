use std::path::{Path, PathBuf};
use std::thread;

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use tokio::sync::{mpsc, oneshot};

use crate::migrations::{self, LATEST_SCHEMA_VERSION};
use crate::{RecordRow, StorageError, WriteCondition};

type Job = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

/// Pending jobs allowed in the worker queue before callers wait (INV-12).
const QUEUE_CAPACITY: usize = 64;
/// Upper bound on rows returned by one listing call.
const MAX_LIST_ROWS: usize = 100_000;

/// Handle to the storage worker. Cheap to clone. The worker thread exits and the connection is
/// closed (checkpointing the WAL) when the last handle is dropped.
#[derive(Clone)]
pub struct Database {
    jobs: mpsc::Sender<Job>,
    path: PathBuf,
}

impl core::fmt::Debug for Database {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Database")
    }
}

/// Creates the database file with owner-only permissions *before* SQLite opens it, so the file,
/// and the WAL/SHM files SQLite derives from it, are never readable by other users.
#[cfg(unix)]
fn precreate_private(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Tighten a pre-existing file rather than trusting whatever mode it has.
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        }
        Err(e) => Err(e),
    }
}

/// Windows: the file inherits the ACL of its directory. The application places the vault under
/// the per-user application-data directory; an explicit owner-only ACL is not yet applied and
/// this path is unverified (blocker B-01).
#[cfg(not(unix))]
fn precreate_private(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn configure(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // FULL: a committed vault write survives power loss, at the cost of an fsync per commit.
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "trusted_schema", "OFF")?;
    // No temp files on disk; freed pages are overwritten.
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "secure_delete", "ON")?;
    conn.pragma_update(None, "cell_size_check", "ON")?;
    Ok(())
}

fn row_from(r: &rusqlite::Row<'_>) -> Result<RecordRow, rusqlite::Error> {
    let bad = |i: usize| rusqlite::Error::InvalidColumnType(i, "length".into(), rusqlite::types::Type::Blob);
    let id: Vec<u8> = r.get(0)?;
    let nonce: Vec<u8> = r.get(4)?;
    Ok(RecordRow {
        record_id: id.try_into().map_err(|_| bad(0))?,
        kind: r.get(1)?,
        revision: r.get::<_, i64>(2)? as u64,
        key_version: r.get(3)?,
        nonce: nonce.try_into().map_err(|_| bad(4))?,
        ciphertext: r.get(5)?,
        deleted: r.get(6)?,
    })
}

const COLUMNS: &str = "record_id, kind, revision, key_version, nonce, ciphertext, deleted";

impl Database {
    /// Opens (creating if necessary) the vault database at `path` and migrates it to the current
    /// schema. Blocking; call from a blocking context at startup.
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        Self::open_at_version(path, LATEST_SCHEMA_VERSION)
    }

    /// Opens the database migrated only up to `version`. Used to build upgrade fixtures.
    #[doc(hidden)]
    pub fn open_at_version(path: &Path, version: u32) -> Result<Self, StorageError> {
        // Resolve the directory once, then refuse a symlink as the final component: SQLite's
        // NOFOLLOW rejects a symlink anywhere in the path, and system temp/home directories are
        // legitimately reached through symlinks (for example /var on macOS).
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let file_name = path.file_name().ok_or(StorageError::Open)?;
        let path = &parent.canonicalize().map_err(|_| StorageError::Open)?.join(file_name);
        if path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(StorageError::Open);
        }
        precreate_private(path).map_err(|_| StorageError::Open)?;
        let flags =
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let mut conn = Connection::open_with_flags(path, flags).map_err(|_| StorageError::Open)?;
        configure(&conn).map_err(|e| match StorageError::from(e) {
            StorageError::Corrupt => StorageError::NotAVault,
            other => other,
        })?;
        migrations::migrate_to(&mut conn, version)?;

        let (jobs, mut queue) = mpsc::channel::<Job>(QUEUE_CAPACITY);
        thread::Builder::new()
            .name("tyrminal-storage".into())
            .spawn(move || {
                while let Some(job) = queue.blocking_recv() {
                    job(&mut conn);
                }
                // Fold the WAL back into the main file on clean shutdown.
                let _ = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE");
            })
            .map_err(|_| StorageError::Open)?;
        Ok(Self { jobs, path: path.to_owned() })
    }

    /// Location of the main database file (for backup tooling and tests).
    pub fn path(&self) -> &Path {
        &self.path
    }

    async fn call<T, F>(&self, f: F) -> Result<T, StorageError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
    {
        let (reply, result) = oneshot::channel();
        let job: Job = Box::new(move |conn| {
            let _ = reply.send(f(conn));
        });
        self.jobs.send(job).await.map_err(|_| StorageError::Closed)?;
        result.await.map_err(|_| StorageError::Closed)?
    }

    /// The stored vault header bytes, or `None` when no vault has been created here.
    pub async fn read_header(&self) -> Result<Option<Vec<u8>>, StorageError> {
        self.call(|conn| {
            Ok(conn.query_row("SELECT header FROM vault_header WHERE id = 1", [], |r| r.get(0)).optional()?)
        })
        .await
    }

    /// Stores the first header. Fails with `AlreadyInitialized` rather than overwrite a vault.
    pub async fn init_header(&self, header: Vec<u8>) -> Result<(), StorageError> {
        self.call(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let exists: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM vault_header)", [], |r| r.get(0))?;
            let has_records: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM records)", [], |r| r.get(0))?;
            if exists || has_records {
                return Err(StorageError::AlreadyInitialized);
            }
            tx.execute("INSERT INTO vault_header (id, header) VALUES (1, ?1)", params![header])?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    /// Atomically swaps the header (passphrase change, recovery rotation, device slots), only if
    /// the stored header is still `expected`. Either the old or the new header is on disk, never
    /// a mixture (INV-16).
    pub async fn replace_header(&self, expected: Vec<u8>, new: Vec<u8>) -> Result<(), StorageError> {
        self.call(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let changed =
                tx.execute("UPDATE vault_header SET header = ?2 WHERE id = 1 AND header = ?1", params![expected, new])?;
            if changed != 1 {
                return Err(StorageError::Conflict);
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    /// Writes one record under an optimistic-concurrency condition.
    pub async fn put_record(&self, row: RecordRow, condition: WriteCondition) -> Result<(), StorageError> {
        self.put_records(vec![(row, condition)]).await
    }

    /// Writes several records in one transaction: all are stored or none is.
    pub async fn put_records(&self, rows: Vec<(RecordRow, WriteCondition)>) -> Result<(), StorageError> {
        self.call(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            for (row, condition) in &rows {
                write_record_in(&tx, row, *condition)?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn get_record(&self, record_id: [u8; 16]) -> Result<Option<RecordRow>, StorageError> {
        self.call(move |conn| {
            Ok(conn
                .query_row(&format!("SELECT {COLUMNS} FROM records WHERE record_id = ?1"), params![record_id], row_from)
                .optional()?)
        })
        .await
    }

    /// All rows, tombstones included, ordered by id. Bounded by `MAX_LIST_ROWS`.
    pub async fn list_records(&self) -> Result<Vec<RecordRow>, StorageError> {
        self.call(|conn| {
            let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM records ORDER BY record_id LIMIT ?1"))?;
            let rows = stmt.query_map(params![MAX_LIST_ROWS as i64], row_from)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
    }

    /// Runs SQLite's integrity check. `Ok(())` means the file structure is sound.
    pub async fn integrity_check(&self) -> Result<(), StorageError> {
        self.call(|conn| {
            let result: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if result == "ok" { Ok(()) } else { Err(StorageError::Corrupt) }
        })
        .await
    }

    /// Writes a consistent copy of the whole database to `destination` (which must not exist).
    /// The copy contains the same ciphertext; it is not a portable backup format by itself.
    pub async fn snapshot_to(&self, destination: PathBuf) -> Result<(), StorageError> {
        self.call(move |conn| {
            let parent = destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
            let file_name = destination.file_name().ok_or(StorageError::Open)?;
            let destination = parent.canonicalize().map_err(|_| StorageError::Open)?.join(file_name);
            if destination.symlink_metadata().is_ok() {
                return Err(StorageError::AlreadyInitialized);
            }
            // An empty owner-only file first: VACUUM INTO accepts an empty target and keeps its
            // permissions, so the copy is never readable by other users, even briefly.
            precreate_private(&destination).map_err(|_| StorageError::Open)?;
            let target = destination.to_str().ok_or(StorageError::Open)?;
            if let Err(err) = conn.execute("VACUUM INTO ?1", params![target]) {
                let _ = std::fs::remove_file(&destination);
                return Err(err.into());
            }
            Ok(())
        })
        .await
    }

    /// Flushes the WAL into the main file. Used before measuring or copying files in tests.
    pub async fn checkpoint(&self) -> Result<(), StorageError> {
        self.call(|conn| {
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
            Ok(())
        })
        .await
    }
}

/// Single-row write inside an already open transaction.
fn write_record_in(
    tx: &rusqlite::Transaction<'_>,
    row: &RecordRow,
    condition: WriteCondition,
) -> Result<(), StorageError> {
    let revision = i64::try_from(row.revision).map_err(|_| StorageError::Constraint)?;
    let stored: Option<i64> = tx
        .query_row("SELECT revision FROM records WHERE record_id = ?1", params![row.record_id], |r| r.get(0))
        .optional()?;
    match (condition, stored) {
        (WriteCondition::Create, None) if row.revision == 1 => {
            tx.execute(
                &format!("INSERT INTO records ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"),
                params![row.record_id, row.kind, revision, row.key_version, row.nonce, row.ciphertext, row.deleted],
            )?;
            Ok(())
        }
        (WriteCondition::Create, None) => Err(StorageError::Constraint),
        (WriteCondition::Create, Some(_)) => Err(StorageError::Conflict),
        (WriteCondition::Replace { .. }, None) => Err(StorageError::NotFound),
        (WriteCondition::Replace { expected_revision }, Some(current)) => {
            if current as u64 != expected_revision {
                return Err(StorageError::Conflict);
            }
            if row.revision != expected_revision + 1 {
                return Err(StorageError::Constraint);
            }
            tx.execute(
                "UPDATE records SET kind = ?2, revision = ?3, key_version = ?4, nonce = ?5, ciphertext = ?6, \
                 deleted = ?7 WHERE record_id = ?1",
                params![row.record_id, row.kind, revision, row.key_version, row.nonce, row.ciphertext, row.deleted],
            )?;
            Ok(())
        }
    }
}
