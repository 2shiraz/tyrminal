# 0006 — Agent D: inventory presentation, importers, keys and snippets

Status: accepted (agent D, 2026-10-12). Living record: later slices append sections.

## Record kinds

Agent D's vault record kinds start at **200** (agent B uses 100+, the original kinds are 1–6), so
parallel branches never assign the same number.

| Kind | Record | Notes |
|---|---|---|
| 200 | `HostAppearanceRecord` (host id, OS) | One per host; deleted with the host and copied with it in the same transaction. Kept apart from `HostRecord` so host fields wait for agent B's (work-split ordering). |
| 202 | `ExecutionTargetRecord` (name, host ids) | Saved host selections for snippet runs; ids of deleted hosts are skipped and counted on read. |
| 201 | `KeyCertificateRecord` (key id, certificate line, parsed fields) | One per key; deleted with the key in the same transaction. Public data, still encrypted like every record. |

## Dependencies

| Crate | Version | License | Used by | Reason |
|---|---|---|---|---|
| `quick-xml` | 0.42.0, `default-features = false` | MIT | `tyrminal-core` (`importers.rs`) | SecureCRT exports its sessions as XML. Already in the lockfile through `plist` → `tauri-utils`, so no new code is downloaded. It never resolves DTDs or external entities; on top of that the importer refuses any document with a DOCTYPE, accepts only the five predefined entities and character references, and bounds nesting (64) and element count (1,000,000) within the 1 MiB import limit. |

## Importers (IMP-04, IMP-05, IMP-06)

- **Input:** the text of a file the user picked in the import dialog. The page decodes UTF-16
  (byte-order mark, as `regedit` writes `.reg` files) or UTF-8 and sends text; the core validates
  every value as if typed into the host editor. Preview first, then one transaction.
- **PuTTY:** `.reg` exports of `HKCU\Software\SimonTatham\PuTTY\Sessions` (both
  `Windows Registry Editor Version 5.00` and `REGEDIT4`). We do not read the live registry: the
  Windows-only API path would need platform FFI (an ADR of its own) and a `.reg` file the user
  exports is reviewable. SSH sessions become hosts; telnet/serial/raw/rlogin sessions and
  `Default Settings` are listed as left out. `PublicKeyFile`, `PortForwardings` and proxies are
  reported per host, not imported (keys are imported in the keychain; tunnels and jump hosts are
  agent B's).
- **MobaXterm:** `MobaXterm.ini` or `.mxtsessions` exports: `[Bookmarks*]` sections, `SubRep`
  folders become groups, SSH (type 0) and SFTP (type 6) sessions become hosts. `[Passwords]` and
  `[Credentials]` are never read beyond noting that they exist.
- **SecureCRT:** "Export Settings" XML (`<key name="Sessions">` tree; folders become groups) or one
  session `.ini`. SSH2 sessions import; SSH1 is refused as insecure; other protocols are listed.
- **Encrypted exports:** both MobaXterm and SecureCRT can protect saved passwords with a master
  password. We import no saved passwords at all, encrypted or not, so no decryption is
  implemented; the preview says a password was not imported. Hosts ask for it on first use.

## Known-host conversion (SEC-03)

Hosts are offered only for records the user already trusted on a real connection ("trust
always"), and only when no host has that address and effective port. The preview shows the
trusted algorithm and fingerprint; importing reuses the same transactional `import_hosts`.
Hashed `known_hosts` entries do not exist in the vault (records store the host name), so there
is nothing to un-hash.

## Cloud discovery (IMP-07..IMP-13)

AWS, DigitalOcean and Azure discovery need those providers' APIs and real accounts. Agents must
not contact third parties, so these rows are BLOCKED until the owner authorizes a provider
sandbox. Nothing is stubbed in the UI.

## Keys (KEY-01, KEY-02, KEY-07, KEY-14) — slice 3

- **Generation:** Ed25519 (default), ECDSA P-256/P-384/P-521 and RSA 3072/4096 through `ssh-key`
  (already a dependency via russh). RSA runs on a blocking thread. No DSA, no RSA below 3072.
- **ML-DSA keys: BLOCKED.** There is no SSH standard for ML-DSA user keys, OpenSSH does not
  accept them, and neither russh nor ssh-key implements them. We do not invent SSH algorithms
  (spec §4.5).
- **PuTTY PPK v2/v3:** decoded by `ssh-key`'s `ppk` feature (already enabled). A PPK v3 file names
  its own Argon2 parameters and the library applies them unchecked, so `auth.rs` reads the header
  first and refuses more than 256 MiB of memory, 64 passes or 16 lanes before any work is done
  (PuTTY's defaults are 8 MiB, ~20 passes, 1 lane). Encryption is detected from the header, so an
  encrypted PPK asks for its passphrase like an encrypted OpenSSH key. The original text is
  stored, so the bound applies again at every decode.
- **Certificates:** an OpenSSH user certificate is attached to a key after checking that its CA
  signature verifies, it is a user (not host) certificate, it certifies exactly that key's public
  half and it has not expired. The check uses the stored public key, so an encrypted key needs no
  passphrase. CA trust and principals are the server's decision and are only displayed.
  **Using** the certificate to sign in needs a change on the connection path (vault
  `connection_plan`, `sessions.rs`), which agent B owns and is changing for jump hosts; it lands
  after B merges, with a lab CA (`TrustedUserCAKeys`) test.
- **Hardware keys (KEY-08..13): BLOCKED** — no FIDO2 device or platform key store is available to
  test, and the spec forbids advertising them untested.

## Algorithms (SEC-08..10)

- `mlkem768x25519-sha256` is first in the offer (`crates/ssh/src/algorithms.rs`); servers without
  it (OpenSSH < 9.9) negotiate `curve25519-sha256`. The lab test asserts the PQ exchange for
  OpenSSH ≥ 9.9 and the Curve25519 fallback otherwise. The sandbox lab is OpenSSH 9.6; the Docker
  lab (10.0p1) could not be built here because its image build has no trusted route to the Alpine
  mirror, so the PQ branch runs where that lab runs (CI).
- **SEC-09: BLOCKED** — russh 0.64 has no `sntrup761x25519-sha512`, no `mlkem1024nistp384-sha384`
  and no ML-DSA.
- **SEC-10:** a per-host switch that removes the PQ exchange from the offer is a host setting on
  the connection path; it follows agent B's merge. Disabling PQ never adds weaker algorithms: the
  remaining list is the same modern one.

## Snippet runs (SNP-05/06/07/10) — slice 4

- A run uses an exec channel on a session the window already owns and has connected, never a new
  connection: host trust and sign-in stay in the normal interactive path with its prompts.
- No PTY is requested, so `sudo`/`su` cannot prompt and fail instead; nothing is typed into a
  prompt for the user (spec: no automatic password injection).
- The snippet text is the exec command (the account's login shell runs it). It is the user's own
  saved text, read from the vault under the session's generation; nothing is interpolated.
- Output is untrusted: kept up to 64 KiB per stream, control characters and bidi overrides
  removed, shown as plain text. A run stops after 30 minutes or 64 MiB read; it can be cancelled
  by its window only. At most 64 runs at once; the dialog runs 8 hosts in parallel.
