# 0006 — Agent D: inventory presentation, importers, keys and snippets

Status: accepted (agent D, 2026-10-12). Living record: later slices append sections.

## Record kinds

Agent D's vault record kinds start at **200** (agent B uses 100+, the original kinds are 1–6), so
parallel branches never assign the same number.

| Kind | Record | Notes |
|---|---|---|
| 200 | `HostAppearanceRecord` (host id, OS) | One per host; deleted with the host and copied with it in the same transaction. Kept apart from `HostRecord` so host fields wait for agent B's (work-split ordering). |

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
