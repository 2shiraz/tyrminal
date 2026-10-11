# Tyrminal

An open-source, local-first SSH client for Windows and macOS, with optional end-to-end encrypted sync
planned. No account, subscription or vendor connection is needed for local use.

> **Status: early development, not security reviewed. Do not store credentials you cannot
> rotate.** On macOS (Apple Silicon) the app can create an encrypted local vault, manage hosts and
> keys, and open SSH and local terminal sessions with strict host-key verification. Windows is a
> target but nothing has been built or tested there yet. See [docs/progress.md](docs/progress.md)
> for exactly what exists and [docs/blockers.md](docs/blockers.md) for what cannot be verified.

## Develop

Requirements: Rust (pinned in `rust-toolchain.toml`), Node 24+, pnpm 11, Docker for the SSH test lab.

```sh
pnpm install
pnpm doctor          # what this machine can build and test
pnpm dev             # run the desktop app in development
pnpm verify:fast     # format, lint, types, unit/property/known-answer tests
pnpm lab:up          # disposable OpenSSH servers on loopback for integration tests
pnpm test:integration && pnpm test:security
pnpm build:e2e && pnpm test:native   # drive the real application end to end
```

## Documentation

- [BUILD_SPEC.md](BUILD_SPEC.md): the implementation baseline
- [AGENTS.md](AGENTS.md): working rules and resume procedure
- [docs/architecture.md](docs/architecture.md), [docs/threat-model.md](docs/threat-model.md),
  [docs/crypto-format.md](docs/crypto-format.md)
- [docs/feature-matrix.csv](docs/feature-matrix.csv): every catalogue ID and its honest status

## License

Apache-2.0 (provisional, see [docs/decisions/0001-name-license-identifiers.md](docs/decisions/0001-name-license-identifiers.md)).
