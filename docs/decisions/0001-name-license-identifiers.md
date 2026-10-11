# 0001 — Name, license and identifiers

Status: accepted (provisional until first publication) · Date: 2026-10-12

## Decision

- **Product name:** Tyrminal, chosen by the owner. BUILD_SPEC.md keeps its original "LocalSSH" wording
  because it is preserved verbatim as the baseline.
- **License:** Apache-2.0 for original code. This is the spec's provisional default and an
  *assumption*: the owner has not separately confirmed it. It must be confirmed before anything is
  published. Dependencies must be compatible (enforced through `deny.toml` once cargo-deny is installed).
- **Bundle identifier:** `app.tyrminal.desktop`. Provisional. No domain ownership has been verified, so
  this must be revisited before signing or store submission.
- **Rust crate prefix:** `tyrminal-` (for example `tyrminal-vault`). Crates are not published.
- **On-disk format labels:** domain-separation strings use the prefix `tyrminal.` and are part of the
  versioned formats in `docs/crypto-format.md`. Renaming the product later must not change them.

## Alternatives considered

- Keeping "LocalSSH" in identifiers: rejected, the owner supplied a name.
- GPL/AGPL: not chosen; the spec default is Apache-2.0 and the product must allow commercial use (UX-07).
  The sync server could arguably be AGPL; left as an open question for the owner before publication.

## Consequences

No trademark, domain or app-store name availability check has been done. Treat the name, icon and
identifier as changeable until publication.
