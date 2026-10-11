use rusqlite::{Connection, TransactionBehavior};

use crate::StorageError;

/// `PRAGMA application_id` marking a Tyrminal vault database ("TYRV").
pub const APPLICATION_ID: i32 = 0x5459_5256;

const MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_vault.sql")];

/// The schema version this build reads and writes.
pub const LATEST_SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

fn user_version(conn: &Connection) -> Result<u32, StorageError> {
    let v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    u32::try_from(v).map_err(|_| StorageError::Corrupt)
}

/// Brings the schema to [`LATEST_SCHEMA_VERSION`], applying at most `target` migrations in total.
///
/// Each step runs in its own `IMMEDIATE` transaction together with its `user_version` bump, so an
/// interruption leaves the database at a whole version, never in between (INV-16). A database
/// from a newer build is refused untouched, and a foreign SQLite file is refused untouched.
pub(crate) fn migrate_to(conn: &mut Connection, target: u32) -> Result<(), StorageError> {
    let app_id: i32 = conn.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let current = user_version(conn)?;
    let table_count: i64 = conn.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get(0))?;

    if app_id == 0 && current == 0 && table_count == 0 {
        // Brand-new file: claim it.
        conn.pragma_update(None, "application_id", APPLICATION_ID)?;
    } else if app_id != APPLICATION_ID {
        return Err(StorageError::NotAVault);
    }
    if current > LATEST_SCHEMA_VERSION {
        return Err(StorageError::NewerSchema);
    }

    for (index, sql) in MIGRATIONS.iter().enumerate().take(target as usize).skip(current as usize) {
        let version = index as u32 + 1;
        let mut apply = || -> Result<(), rusqlite::Error> {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", version)?;
            tx.commit()
        };
        apply().map_err(|e| match StorageError::from(e) {
            StorageError::Full => StorageError::Full,
            _ => StorageError::Migration,
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_is_claimed_and_migrated() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, LATEST_SCHEMA_VERSION).unwrap();
        assert_eq!(user_version(&conn).unwrap(), LATEST_SCHEMA_VERSION);
        let app_id: i32 = conn.pragma_query_value(None, "application_id", |r| r.get(0)).unwrap();
        assert_eq!(app_id, APPLICATION_ID);
        // Idempotent.
        migrate_to(&mut conn, LATEST_SCHEMA_VERSION).unwrap();
    }

    #[test]
    fn a_newer_schema_is_refused_without_modification() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, LATEST_SCHEMA_VERSION).unwrap();
        conn.pragma_update(None, "user_version", LATEST_SCHEMA_VERSION + 1).unwrap();
        assert_eq!(migrate_to(&mut conn, LATEST_SCHEMA_VERSION), Err(StorageError::NewerSchema));
        assert_eq!(user_version(&conn).unwrap(), LATEST_SCHEMA_VERSION + 1);
    }

    #[test]
    fn a_foreign_sqlite_database_is_refused_without_modification() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE someone_elses (x)").unwrap();
        assert_eq!(migrate_to(&mut conn, LATEST_SCHEMA_VERSION), Err(StorageError::NotAVault));
        let tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get(0)).unwrap();
        assert_eq!(tables, 1);
        let app_id: i32 = conn.pragma_query_value(None, "application_id", |r| r.get(0)).unwrap();
        assert_eq!(app_id, 0);
    }
}
