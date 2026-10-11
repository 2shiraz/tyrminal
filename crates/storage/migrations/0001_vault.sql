-- Schema version 1. Rows are opaque to SQLite: every sensitive value lives inside `ciphertext`
-- (see docs/crypto-format.md). Cleartext columns are limited to what docs/crypto-format.md §7 lists.

CREATE TABLE vault_header (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    header BLOB NOT NULL CHECK (length(header) BETWEEN 1 AND 4096)
) STRICT;

CREATE TABLE records (
    record_id   BLOB    NOT NULL PRIMARY KEY CHECK (length(record_id) = 16),
    kind        INTEGER NOT NULL CHECK (kind BETWEEN 0 AND 65535),
    revision    INTEGER NOT NULL CHECK (revision >= 1),
    key_version INTEGER NOT NULL CHECK (key_version >= 1),
    nonce       BLOB    NOT NULL CHECK (length(nonce) = 24),
    ciphertext  BLOB    NOT NULL CHECK (length(ciphertext) BETWEEN 272 AND 1048848),
    -- Index hint only. The authoritative tombstone marker is inside the ciphertext.
    deleted     INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
) STRICT, WITHOUT ROWID;

CREATE INDEX records_live_by_kind ON records (kind) WHERE deleted = 0;
