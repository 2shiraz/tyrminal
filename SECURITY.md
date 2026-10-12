# Security policy

Tyrminal is pre-release software. It has **not been independently security reviewed**, and no
release is labelled stable or production-secure.

## Reporting a vulnerability

> **Contact: not yet decided (open question for the maintainer).** Until a private reporting
> channel is published here, please do not post exploit details in public issues. Open a public
> issue that says only that you have a security report and how to reach you, and the maintainer
> will arrange a private channel. If GitHub private vulnerability reporting is enabled for this
> repository, use it.

Please include the version or commit, platform, a description of the impact, and steps to
reproduce with synthetic data. Never send real credentials, keys or server addresses.

## Scope

In scope: the vault format and its implementation (`crates/vault`, `docs/crypto-format.md`), host
key verification, session isolation between windows, IPC validation, secret handling in logs and
events, the release build's capabilities and CSP, and supply-chain configuration.

The security invariants the code is held to are in `docs/security-invariants.md`, and the threat
model is in `docs/threat-model.md`.

## Supported versions

Only the latest pre-release receives fixes. There is no automatic updater; check the releases
page for new versions.
