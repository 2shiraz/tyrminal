# Tyrminal

An open-source, local-first SSH client for Windows and macOS, with optional end-to-end encrypted sync
planned. No account, subscription or vendor connection is needed for local use.

> **Status: early development. Not usable as an application yet, not security reviewed, do not
> store real credentials in it.** See [docs/progress.md](docs/progress.md) for exactly what exists
> and [docs/blockers.md](docs/blockers.md) for what cannot be verified on the current machine.

## Develop

Requirements: Rust (pinned in `rust-toolchain.toml`), Node 24+, pnpm 11, Docker for the SSH test lab.

```sh
pnpm doctor          # what this machine can build and test
cargo test           # unit, property and known-answer tests
pnpm lab:up          # disposable OpenSSH servers on loopback for integration tests
pnpm lab:down
```

## Documentation

- [BUILD_SPEC.md](BUILD_SPEC.md): the implementation baseline
- [AGENTS.md](AGENTS.md): working rules and resume procedure
- [docs/architecture.md](docs/architecture.md), [docs/threat-model.md](docs/threat-model.md),
  [docs/crypto-format.md](docs/crypto-format.md)
- [docs/feature-matrix.csv](docs/feature-matrix.csv): every catalogue ID and its honest status

## License

Apache-2.0 (provisional, see [docs/decisions/0001-name-license-identifiers.md](docs/decisions/0001-name-license-identifiers.md)).
