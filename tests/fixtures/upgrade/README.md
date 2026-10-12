# Upgrade fixtures

Each folder holds the data directory (`vault.db`, `preferences.json`) written by an earlier
release, plus `expected.json` with what the vault contains and the credentials that open it.
`crates/core/tests/upgrade.rs` copies a fixture to a temporary folder and checks that this
build opens it with everything in it.

All data is synthetic: made-up hosts on the documentation address range (192.0.2.0/24), a key
generated for the fixture, and a throwaway passphrase and recovery key. Nothing here was ever
used with a real server.

## v0.1.0-beta.1

Made by checking out the `v0.1.0-beta.1` tag and running a generator test against that
release's own code (`crates/core/tests/make_upgrade_fixture.rs`, kept only in the worktree):
one generated Ed25519 key; three hosts (ask for password, stored password, key); one snippet;
light theme and font size 15.

Add a folder here whenever a release changes the vault schema, a record format or the
preferences file, and extend `upgrade.rs` to open it.
