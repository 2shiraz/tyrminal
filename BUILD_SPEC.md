# LocalSSH — Autonomous Engineering Build Prompt

Version: 1.0  
Prepared: October 12, 2026  
Product: an open-source, local-first SSH application with optional encrypted cloud synchronization  
Primary targets: Windows and macOS  
Later targets: Android and iOS/iPadOS

## 0. How to use this document

Give this entire file to the coding agent in the project repository. It is self-contained: the feature appendix is included, so no previous chat is required.

**Instruction to the implementation agent:** You are the lead implementer and tester for this project. Build working software, maintain the repository, run the available tests, fix failures, and keep progressing through the phases below. Start by inspecting the environment and repository. Do not stop after writing a plan, generating a mockup, scaffolding directories, or completing only the happy path.

This document defines product requirements and engineering defaults. It does not override your actual system/developer instructions, repository access controls, tool permissions, or later explicit instructions from the owner. Respect existing repository instructions and preserve unrelated work.

The owner wants a modern, fast, secure and attractive alternative in the same product category as Termius. Build original branding, UI assets and implementation. Treat the included Termius research as a capability reference, not proof of our capabilities, compatibility or security.

### 0.1 Autonomous execution contract

1. Inspect existing files, branch status, package managers, available SDKs and instructions before editing. Never overwrite an existing application with a new scaffold.
2. Use the architecture below unless evidence from a technical spike requires a documented change. Resolve ordinary implementation details yourself.
3. Maintain a work queue with dependencies, acceptance criteria, risk and evidence. Work in small, complete vertical slices.
4. After every meaningful slice: run relevant checks, repair failures, update status and continue to the next unblocked task.
5. Do not ask the owner to approve routine local edits, tests, refactors, package installation already permitted by the environment, or reversible implementation choices.
6. Use generated keys, local containers and disposable data for development. Do not access real servers, discover networks, use personal SSH files, or contact third parties without explicit authorization.
7. Do not publish, deploy to production, send invitations/email, create billable resources, push to external repositories, sign releases with production keys, or modify real server authorization merely because this prompt exists. Prepare concrete local deliverables first. Follow any separate authorization already provided.
8. If an SDK, device, signing identity, network resource or secret is unavailable, mark the exact dependent check BLOCKED. Continue independent work. A blocked native test is not a passing test.
9. If a dependency cannot safely support a feature, provide a narrow disabled feature flag and a specific blocker with evidence. Do not silently remove the requirement or fake a working interface.
10. Never weaken host verification, encryption, validation, test assertions or capability controls to make a demo/test pass.
11. Preserve a resumable checkpoint before context limits: current commit, completed checks, outstanding failures, blockers and next commands. Resume from that checkpoint.
12. Finish with evidence: executable artifacts, instructions, actual test results, performance measurements, threat-model updates and accurately stated limitations.

### 0.2 Definition of progress and completion

Use these feature states: NOT_STARTED, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, VERIFIED, BLOCKED, DEFERRED_BY_SCOPE.

A feature is VERIFIED only when its required implementation and tests pass on its declared platforms. A screenshot, mock backend, passing TypeScript check, or a successful build alone cannot verify an SSH workflow.

A phase can be implementation-complete while native validation is blocked. It cannot be gate-complete until required evidence exists. Later independent phases may proceed while blocked gates remain visible.

Do not call the product production-secure or independently audited based on your own tests. Produce a security-review packet. Independent review is a public stable-release gate for vault cryptography, synchronization authorization and live session sharing; it does not prevent continued implementation and local testing.

## 1. Product contract and scope

### 1.1 Non-negotiable requirements

- All application and sync-server source code is available under an OSI-approved license.
- Default provisional license: Apache-2.0 for original code; preserve all dependency notices. Record this assumption before any public publication. Do not copy incompatible code.
- Local use requires no account, subscription, internet connection to a vendor, activation check, online entitlement or recurring license validation.
- SSH connects directly from the user's device to the configured destination or user-selected jump/proxy chain.
- Cloud sync is optional and disabled on first launch. An unavailable sync service cannot block local unlock or local SSH connections.
- No hosted backend, analytics, AI, updater polling, remote fonts or crash upload runs in default local mode. Network activity needed for a user-requested SSH connection is allowed.
- Keep all core features free of license-based restrictions. Accounts exist for synchronization and collaboration, not entitlement checks.
- Windows and macOS receive the first usable release candidates. Reuse core logic on mobile later without pretending desktop APIs work on phones.
- Security is continuous work in every phase. A small trusted code surface is more valuable than a large unfinished feature surface.
- Performance is measured on release builds, with declared hardware and datasets. Never present target budgets as measured results.
- The interface is modern, creative, appealing and simple. Advanced features use progressive disclosure.

### 1.2 Delivery tracks

| Track | Outcome |
|---|---|
| A — local desktop | Secure vault, real SSH, host/key management, terminal workspaces, SFTP, tunnels, snippets, local history/logs, import/export, signed-release preparation |
| B — optional personal sync | Self-hostable encrypted synchronization, recovery, conflicts, devices and account lifecycle |
| C — advanced desktop/team | Shared vaults, collaboration, cloud inventory, optional AI and advanced authentication/protocols |
| D — mobile | Android and iOS adaptations after desktop foundations and mobile feasibility checks |
| E — extensions | Requested/unverified competitor features considered separately; no automatic claim of feature parity |

Default behavior is to implement Tracks A–D in phase order as far as the available environment permits. Track E is a maintained backlog, not a reason to delay core delivery indefinitely.

Do not implement paid subscriptions, payment processing, pricing tiers or marketing infrastructure merely because they appear in the competitor inventory. Enterprise support contracts and compliance attestations are business processes, not features an agent can manufacture.

### 1.3 Initial application defaults

| Setting | Default |
|---|---|
| Mode | Local only |
| Sync / AI / telemetry / crash upload | Off |
| Update checking | Manual; optional automatic checks require opt-in |
| Session recording and persistent command history | Off, separately configurable |
| Agent forwarding | Off per host |
| Startup snippets | Off until explicitly enabled |
| Command broadcast | Off; never silently restored |
| Live sharing | Off; never silently restored |
| Port-forward listeners | Loopback only |
| Weak SSH compatibility | Off; explicit per-host exception if implemented |
| Clipboard writes from terminal escape sequences | Denied until session-scoped user approval |
| URLs from terminal | User click plus validated scheme/confirmation policy |
| Remote file editing | Explicit editor choice and explicit upload-on-change policy |
| Vault idle lock | Five minutes of user inactivity; configurable |
| OS lock/suspend | Lock vault and disconnect by default |
| Resume | Remain locked; reconnect requires unlocked vault and user action |
| Cloud credentials and hardware keys | Never silently included in exports or sync |

## 2. Architecture and technology decisions

### 2.1 Default stack

| Layer | Choice | Reason / responsibility |
|---|---|---|
| App shell | Tauri 2, current supported stable release | Shared desktop/mobile shell; native integration |
| Core | Rust, stable toolchain pinned after spike | SSH, secrets, storage, validation, jobs and sync |
| Desktop UI | React + TypeScript strict mode + Vite | Functional components, typed IPC and maintainable UI |
| Styling | CSS custom properties + CSS modules; small accessible component layer | Original design without a heavy runtime styling system |
| Terminal | @xterm/xterm with selectively approved official addons | Terminal emulation and rendering |
| Async I/O | Tokio with bounded tasks/channels | Connections and cancellable background jobs |
| SSH | russh candidate behind an adapter | Must pass interoperability and security review |
| SFTP | russh-sftp candidate behind an adapter | Shared SSH transport; validate supported extensions |
| Local terminal | portable-pty candidate behind a platform adapter | Unix PTYs and Windows ConPTY |
| Local database | SQLite through Rust; rusqlite on a dedicated worker | Transactional local data without browser DB privileges |
| Vault crypto | Established Rust crypto libraries; scheme defined below | Never implement cipher/KDF primitives yourself |
| Sync service | Rust + Axum + PostgreSQL + SQLx | Small self-hostable API, authorization and opaque blob storage |
| Account auth | Standards-based external OIDC provider | Authorization Code + PKCE; no homemade password-login protocol |
| Local sync development | Docker Compose with PostgreSQL and a local OIDC provider | Reproducible without paid cloud services |
| UI tests | Vitest + Testing Library; Playwright for browser UI flows | Fast component and renderer tests |
| Native tests | WebdriverIO Tauri integration, platform runners | Real packaged-app IPC/native workflows |
| Core tests | cargo test, property tests, fuzz targets and benchmarks | Security, state-machine and performance evidence |

These are defaults to validate, not an assertion that every named crate supports all desired SSH algorithms or mobile APIs. In Phase 1, record compatible versions, licenses, recent maintenance, advisories, platform support, test coverage and known limitations. Prefer stable versions; commit lockfiles. Do not use floating latest dependencies in repeatable builds.

TypeScript is for explicit interfaces and correctness. Use functional React, plain data and small functions. Avoid class hierarchies, unnecessary decorators, complex generic frameworks and a separate Node backend.

Do not add Next.js, SSR, Electron, a local HTTP terminal server, Kubernetes, Redis or a microservice fleet to the client. Introduce infrastructure only for a measured need and an ADR.

### 2.2 Native expectations

Tauri provides native integration around a system WebView. It does not turn React widgets into platform-native controls. Use native dialogs, menus, notifications, key storage and keyboard conventions where they help. Validate WebView2 on Windows and WKWebView on macOS separately.

Keep SSH/vault/sync code independent of Tauri and React. Mobile plugins should implement narrow Swift/Kotlin adapters for key storage, lifecycle, biometrics and file access. Do not fork business rules by platform.

### 2.3 Trust boundaries and allowed dependencies

- UI renders display models and requests intent through typed IPC.
- Tauri command adapters validate requests, check window capabilities and dispatch core services.
- Core services own vault state, authorization, SSH sessions, file handles, jobs and secrets.
- Platform adapters own OS-specific keychain, PTY and filesystem details.
- The sync service receives authenticated metadata and encrypted records, never plaintext vault data.
- A collaboration relay, if enabled, must not become the default transport for ordinary SSH sessions.
- External AI receives only user-approved context through a separate optional adapter.

Dependency direction: UI → IPC contract → application services → domain/storage/crypto/transport ports. Platform adapters implement ports. Domain code must not import Tauri, React, Axum or platform UI frameworks.

Use opaque backend handles rather than raw filesystem paths or secret values for ongoing actions. A handle must be bound to its owning window/session, resource scope, expiry and vault generation. Random identifiers alone are not authorization.

### 2.4 Renderer compromise limits

The terminal renderer necessarily handles terminal output and user keystrokes. A compromised renderer can affect active sessions; Rust does not magically prevent that. Minimize frontend dependencies, never load remote scripts, restrict IPC and keep unrelated rich content out of the terminal scripting context.

Private keys, vault keys, OIDC refresh tokens and provider credentials stay in Rust/OS storage. Password entry may transiently cross the UI boundary; use dedicated short-lived forms and immediately clear them. Never claim JavaScript memory can be reliably zeroized.

## 3. Repository structure and responsibilities

Use a monorepo. Create files when their phase requires them; do not fill the repository with empty stubs. Paths below are the target organization. Each directory's README describes its public boundary. A small feature can share a file until separation improves clarity.

### 3.1 Root and documentation

| Path | Purpose |
|---|---|
| README.md | Product, local quickstart, supported platforms, screenshots and honest status |
| AGENTS.md | Condensed execution rules, commands and continuation procedure from this prompt |
| BUILD_SPEC.md | This document preserved as the implementation baseline |
| LICENSE | Chosen license for original source |
| NOTICE | Required third-party attribution |
| SECURITY.md | Security reporting process; no invented contact addresses |
| CONTRIBUTING.md | Setup, tests, contribution and review expectations |
| CODE_OF_CONDUCT.md | Project participation policy |
| CHANGELOG.md | User-visible changes and migration notes |
| Cargo.toml / Cargo.lock | Rust workspace and reproducible dependency graph |
| rust-toolchain.toml | Exact stable toolchain and required targets/components |
| package.json / pnpm-lock.yaml / pnpm-workspace.yaml | UI/tooling workspace with pinned package manager |
| tsconfig.base.json | Strict shared TypeScript settings |
| .editorconfig / .gitattributes / .gitignore | Formatting, line endings and generated/secret exclusions |
| .env.example | Non-secret development configuration names and safe examples |
| deny.toml | Dependency license/source/advisory policy |
| docs/architecture.md | Components, ownership, data flow and platform matrix |
| docs/threat-model.md | Assets, attackers, trust boundaries and mitigations |
| docs/security-invariants.md | Named invariants linked to automated tests |
| docs/crypto-format.md | Exact versioned vault/envelope format, vectors and review status |
| docs/sync-protocol.md | Authentication, encrypted records, conflicts, replay and recovery |
| docs/data-model.md | Entities, revisions, deletion semantics and migrations |
| docs/ipc-contract.md | Commands, events, permissions and bounds |
| docs/design-system.md | Tokens, layouts, interaction and accessibility rules |
| docs/performance.md | Budgets, workloads, hardware, measurements and exceptions |
| docs/testing.md | Test layers, native coverage and reproducible commands |
| docs/feature-matrix.csv | One row per catalogue ID, scope, status, platform, tests and phase |
| docs/decisions/NNNN-topic.md | Short architecture decision records with alternatives and evidence |
| docs/progress.md | Current phase, exact next task and continuation checkpoint |
| docs/blockers.md | Concrete external blockers and remaining unblocked work |
| docs/release-checklist.md | Distribution, signing, security and compatibility gates |
| docs/self-hosting.md | Sync service setup, backup, upgrade and recovery |
| docs/privacy.md | Actual data flows and opt-in controls |
| docs/user-guide.md | Host setup, trust prompts, keys, files, vaults and troubleshooting |
| docs/reviews/security-review.md | Review findings, severity, disposition and evidence |
| docs/reports/phase-NN.md | Commands, exit codes, tests, screenshots and phase verdict |
| docs/reports/final-status.md | Scope achieved, unresolved gaps and artifact locations |

### 3.2 Desktop frontend

Prefix: apps/desktop/

| Path | Purpose |
|---|---|
| package.json / vite.config.ts / index.html | Build entry and local asset policy |
| src/main.tsx | React bootstrap only |
| src/app/App.tsx | Top-level composition and error boundary |
| src/app/AppShell.tsx | Navigation, workspace region and status surfaces |
| src/app/routes.ts | Typed internal routes; no remote browser navigation |
| src/app/providers.tsx | Minimal application providers |
| src/app/lifecycle.ts | Subscribe/unsubscribe to native state transitions |
| src/components/ui/ | Accessible buttons, dialogs, menus, inputs, toasts and focus primitives |
| src/components/layout/ | Sidebar, tab strip, split containers and responsive shell |
| src/features/hosts/ | Inventory, editor, groups, tags, inherited-setting previews |
| src/features/vault/ | Create/unlock/lock, recovery, export and sync opt-in screens |
| src/features/credentials/ | Key/identity lists and transient authentication prompts |
| src/features/terminal/TerminalView.tsx | Own one terminal instance and dispose it correctly |
| src/features/terminal/TerminalController.ts | Imperative terminal I/O; outside React state |
| src/features/terminal/terminalPolicy.ts | Link/clipboard/paste UI policy, backed by native checks |
| src/features/terminal/useTerminalSession.ts | Lifecycle binding, not transcript storage |
| src/features/workspaces/ | Pane tree, focus, templates and explicit broadcast controls |
| src/features/files/ | Dual-pane SFTP browser, transfer queue and edit conflict UI |
| src/features/tunnels/ | Rule editor, listener scope and active tunnel controls |
| src/features/snippets/ | Script library, target preview and execution results |
| src/features/history/ | Opt-in command history and local search |
| src/features/logs/ | Recording state, playback/search, retention and export |
| src/features/sync/ | Endpoint setup, devices, progress and conflicts |
| src/features/teams/ | Vault membership and role management |
| src/features/sharing/ | Session-sharing consent, participants and control transfer |
| src/features/integrations/ | Provider configuration and import preview |
| src/features/ai/ | Optional context preview, provider settings and command review |
| src/features/settings/ | Appearance, shortcuts, privacy, compatibility and updates |
| src/lib/ipc.ts | Sole typed invoke wrapper; error conversion and cancellation |
| src/lib/errors.ts | Safe user-facing error mapping |
| src/lib/shortcuts.ts | Platform keyboard mapping and conflict resolution |
| src/lib/redaction.ts | Display/report redaction; not a substitute for native policy |
| src/state/uiStore.ts | Non-secret view state only |
| src/styles/tokens.css | Color, type, spacing, radius and motion tokens |
| src/styles/global.css | Resets, accessibility and platform defaults |
| src/test/setup.ts | Component fixtures and deterministic test setup |
| src/test/mocks/ | Clearly test-only IPC adapters |
| public/ | Bundled original icons and licensed local assets; no remote fonts |

Within each feature directory use components, small hooks, schema/view-model helpers and adjacent meaningful tests. Add an index only for the intended public exports. Avoid global cross-feature imports into private internals.

### 3.3 Tauri adapter

Prefix: apps/desktop/src-tauri/

| Path | Purpose |
|---|---|
| Cargo.toml / build.rs | Native application package and generated permission setup |
| tauri.conf.json | App identity, bundled resources, strict production CSP and updater policy |
| capabilities/main.json | Explicit capabilities for the trusted main application window |
| capabilities/terminal.json | Narrow permissions for detached terminal windows, if used |
| permissions/ | Explicit custom-command permission declarations |
| src/main.rs | Desktop entry point |
| src/lib.rs | Tauri setup shared with mobile entry |
| src/state.rs | Managed service handles; no monolithic business logic |
| src/commands/hosts.rs | Validated host inventory commands |
| src/commands/vault.rs | Vault lifecycle and transient secret submission |
| src/commands/sessions.rs | Open/write/resize/close and bounded I/O registration |
| src/commands/files.rs | File selection handles and transfer intents |
| src/commands/settings.rs | Validated non-secret preferences |
| src/commands/sync.rs | Opt-in sync/account/device intents |
| src/events.rs | Versioned safe event serialization |
| src/security.rs | Caller/window authorization and handle ownership checks |
| src/lifecycle.rs | OS lock, suspend, exit, crash cleanup and single-instance handling |
| src/test_support.rs | Test-only hooks; excluded from release builds |
| icons/ | Original platform icon assets |
| gen/ | Tool-generated mobile projects; follow generated-file ownership rules |

Adding a command to an invoke handler is not sufficient authorization. Explicitly register command permissions, verify capabilities on the pinned Tauri version, and enforce resource-level checks inside Rust.

### 3.4 Rust crates

Every crate has Cargo.toml, src/lib.rs, tests/ for integration cases and a boundary README.

| Crate / important modules | Responsibility |
|---|---|
| crates/domain: ids.rs, hosts.rs, groups.rs, credentials.rs, policy.rs, errors.rs | Pure domain types, invariants, inheritance and safe errors |
| crates/contracts: commands.rs, events.rs, dto.rs, limits.rs, export.rs | Versioned IPC DTOs, bounded inputs and generated TypeScript schema |
| crates/core: app.rs, sessions.rs, jobs.rs, permissions.rs, lifecycle.rs | Application services, job cancellation and vault/session orchestration |
| crates/vault: state.rs, keys.rs, envelope.rs, kdf.rs, backup.rs, recovery.rs | Vault lifecycle and reviewed crypto composition |
| crates/storage: db.rs, repositories.rs, migrations.rs, snapshot.rs | Dedicated SQLite worker, transactions and atomic migration/backup |
| crates/ssh: client.rs, host_trust.rs, auth.rs, channels.rs, jump.rs, proxy.rs | SSH adapter; explicit server identity verification before authentication |
| crates/ssh: agent.rs, certificates.rs, algorithms.rs, reconnect.rs | Agent policies, certificate validation, negotiation and retry state |
| crates/pty: process.rs, resize.rs, platform.rs | Local shell with structured argv, PTY/ConPTY and lifecycle ownership |
| crates/sftp: browser.rs, transfer.rs, paths.rs, edit.rs, conflicts.rs | Bounded transfers, path safety and external editing |
| crates/tunnels: manager.rs, local.rs, remote.rs, socks.rs | Tunnel listeners, scope and cleanup |
| crates/automation: snippets.rs, environment.rs, history.rs, shell_integration.rs | Explicit scripts, history and supported shell context |
| crates/session-log: recorder.rs, format.rs, retention.rs, export.rs | Encrypted bounded recording and safe playback data |
| crates/import-export: openssh.rs, csv.rs, putty.rs, migrations.rs | Bounded previewable migration; never execute imported directives |
| crates/platform: keystore.rs, paths.rs, dialogs.rs, biometric.rs, locks.rs | OS service interfaces |
| crates/platform/src/windows.rs, macos.rs, android.rs, ios.rs | Narrow target-specific implementations |
| crates/sync: client.rs, outbox.rs, protocol.rs, conflicts.rs, devices.rs | Optional encrypted synchronization |
| crates/sharing: membership.rs, key_distribution.rs, session_control.rs | Reviewed team authorization and live-sharing state |
| crates/integrations: aws.rs, digitalocean.rs, azure.rs, reconcile.rs | Optional local provider discovery adapters |
| crates/ai: provider.rs, context.rs, policy.rs | Optional AI adapters, approved context and response validation |
| crates/diagnostics: metrics.rs, redact.rs, report.rs | Local bounded non-secret diagnostics and opt-in report generation |

Consolidate tiny crates when justified by compile-time/maintenance evidence. Keep security ownership boundaries even if modules are co-located. First-party unsafe Rust is forbidden by default; isolate unavoidable platform FFI with documented safety invariants and targeted tests.

### 3.5 Sync service, mobile and test infrastructure

| Path | Purpose |
|---|---|
| services/sync-server/src/main.rs | Service entry and shutdown |
| services/sync-server/src/config.rs | Strict environment configuration; reject unsafe production defaults |
| services/sync-server/src/auth.rs | OIDC/JWT issuer, audience, expiry and algorithm validation |
| services/sync-server/src/authorization.rs | Per-user/vault/device/membership authorization |
| services/sync-server/src/routes/ | Health, vault, blob, change-feed, device and membership endpoints |
| services/sync-server/src/repository.rs | Parameterized database operations |
| services/sync-server/src/limits.rs | Quotas, request sizes, rate limits and timeouts |
| services/sync-server/src/audit.rs | Minimal non-secret security event records |
| services/sync-server/migrations/ | Versioned PostgreSQL migrations |
| services/sync-server/tests/ | Tenant isolation, auth, quota, replay and concurrency tests |
| deploy/compose.dev.yml | Local OIDC/PostgreSQL/service environment bound to loopback |
| deploy/compose.production.example.yml | Hardened reference deployment; no automatic public deployment |
| deploy/Dockerfile | Pinned multistage non-root server build |
| deploy/oidc/ | Development realm/client setup with test-only identities |
| apps/mobile/ | Mobile UI adaptations and build documentation, sharing core/packages |
| apps/mobile/plugins/ | Minimal Swift/Kotlin bridges and native tests |
| packages/contracts/ | Generated TypeScript types; never hand-edit generated output |
| packages/ui/ | Shared tokens/components only when desktop/mobile reuse is real |
| tests/fixtures/ | Synthetic data and clearly labeled test keys; no production secrets |
| tests/ssh-lab/ | Pinned OpenSSH images/configs, jump host and restricted-user fixtures |
| tests/integration/ | End-to-end core workflows against real local servers |
| tests/native/ | Packaged application tests on supported native runners |
| tests/ui/ | Browser UI, accessibility and visual regression tests |
| tests/security/ | Adversarial cases linked to security invariants |
| tests/performance/ | Fixed workloads and result parsers |
| fuzz/ | Crypto/import/IPC/path/protocol parser fuzz targets |
| scripts/dev.mjs | Cross-platform developer launcher |
| scripts/verify.mjs | Required verification entry point and evidence collection |
| scripts/lab.mjs | Create/stop isolated test lab and clean task-owned resources |
| scripts/check-release.mjs | Check release feature set, signatures and absence of test hooks |
| scripts/generate-contracts.mjs | Deterministic Rust-to-TypeScript contract generation |
| .github/workflows/ci.yml | Fast validation and core tests |
| .github/workflows/native.yml | Windows/macOS build and native E2E |
| .github/workflows/security.yml | Dependency, secrets, SAST and fuzz jobs |
| .github/workflows/release.yml | Restricted manual release-artifact/signing workflow |
| .github/dependabot.yml | Controlled dependency update proposals |
| .github/CODEOWNERS | Required ownership/review boundaries for crypto, SSH, IPC, sync and release workflows |
| crates/storage/migrations/0001_vault.sql | Initial local schema storing encrypted record payloads |
| crates/storage/migrations/0002_outbox.sql | Transactional local sync queue, added with Phase 10 |
| services/sync-server/migrations/0001_metadata.sql | Initial account/device/vault authorization and opaque-record schema |

The mobile directory may be a separate thin Tauri shell if current tooling requires it. Record that choice; do not duplicate Rust services or create a second crypto format.


## 4. Security specification

### 4.1 Threat model

Protect private keys, passwords, host inventory, usernames, command history, terminal output, files, provider credentials, identity tokens, vault keys, backups and signing keys.

Model at least:
- A malicious SSH/SFTP server or network intermediary.
- A stolen device or copied vault/database.
- A compromised renderer or frontend dependency.
- A malicious import file, terminal escape sequence, filename or link.
- An untrusted sync-service operator and stolen server database.
- A removed team member or unauthorized device.
- A malicious local process racing file operations.
- A compromised update endpoint or CI dependency.
- Excessive output, reconnect storms and resource-exhaustion inputs.

State limits explicitly: an already compromised OS, administrator/root access, a malicious authorized recipient retaining plaintext, and a compromised unlocked renderer cannot be fully defeated by vault encryption. Offline copies already obtained cannot be remotely erased with certainty.

### 4.2 Named security invariants

Implement these as acceptance requirements and link each to tests:

| ID | Invariant |
|---|---|
| INV-01 | No account/vendor request is necessary for local operation |
| INV-02 | No credential or signing operation is sent before destination host trust succeeds |
| INV-03 | Changed host keys fail closed; no silent replacement or automatic retry accepting them |
| INV-04 | Stored sensitive record contents never enter plaintext SQLite pages, WAL, temp files or diagnostic logs |
| INV-05 | Production builds expose no test server, debug IPC, test auth or mock secret store |
| INV-06 | Renderer commands require correct window permissions and resource ownership |
| INV-07 | Locking invalidates handles and stops new secret-backed work; race conditions cannot bypass lock |
| INV-08 | Remote output never becomes executable HTML/JavaScript or an implicit local action |
| INV-09 | Sync and AI are opt-in; disabling them cancels work and prevents new related traffic |
| INV-10 | Sync authorization applies to every object, tenant, device and mutation |
| INV-11 | Ciphertext tampering or unsupported format versions fail without partial application |
| INV-12 | Queues, parsers, files, histories and logs have enforced resource limits |
| INV-13 | Untrusted strings never become local shell syntax outside an explicitly chosen terminal action |
| INV-14 | Updates require trusted artifact verification; invalid/replayed metadata cannot silently downgrade |
| INV-15 | Revocation prevents future authorized access while documenting previously obtained-data limits |
| INV-16 | Backups and schema migrations are atomic, recoverable and tested against interruption |
| INV-17 | Feature availability is honest; mocks and blocked checks cannot count as verified behavior |
| INV-18 | No secret is leaked through errors, panic messages, traces, analytics, screenshots or test artifacts |

### 4.3 Vault encryption and key lifecycle

Default storage design: SQLite stores encrypted sensitive record payloads, not plaintext host/credential columns. Keep only the minimum documented operational metadata clear, such as random IDs, format versions and queue state. Names, addresses, usernames, tags, snippet contents, environment values and log contents are sensitive. Document the leakage of record count, size, type if retained, and modification timing.

Create an in-memory search index only after unlock. Do not persist a plaintext FTS index. If performance later requires SQLCipher or another encrypted database, prove platform packaging and migration behavior in an ADR before replacing the storage design.

**Initial cryptographic profile to formalize before coding:**
- Generate a random 256-bit vault data-encryption key with the OS-backed CSPRNG.
- Encrypt record payloads using a maintained XChaCha20-Poly1305 implementation with a fresh random 192-bit nonce for each encryption under a key.
- Use authenticated associated data containing a fixed domain label, format version, vault ID, record ID, record kind and revision. Specify exact canonical encoding and byte order.
- Never concatenate ambiguous strings or use ordinary JSON serialization as an implicit canonical signature format.
- Derive the passphrase key using Argon2id with a per-vault random salt of at least 128 bits and a versioned parameter profile.
- Initial desktop profile: 64 MiB memory, 3 iterations, parallelism 1, 32-byte output. Benchmark unlock and increase cost where appropriate. This is a project baseline, not a universal security guarantee.
- KDF input must have documented lower AND upper resource bounds. A malicious file must not force unlimited memory/CPU. Serialize unlock attempts to prevent concurrent KDF exhaustion.
- Do not silently downgrade KDF strength on slower devices. A compatibility change requires a recorded format policy and tests.
- Wrap the vault key with authenticated encryption under the derived key. Changing the passphrase rewraps the key atomically rather than re-encrypting every record.
- Unlock rejects wrong passphrases and modified headers without returning decrypted fragments.
- Separate purpose-specific keys for records, backups, logs and synchronization authentication using a maintained KDF implementation with domain-separated contexts. Specify the hierarchy and migration procedure.
- Use established authenticated-stream/container machinery for large encrypted logs/backups. Do not design an ad hoc chunk cipher. Bind chunk order, file identity, final length and completion so truncation/reordering is detectable.

This is a starting profile for the application format, not a security-reviewed protocol. Before implementation, write docs/crypto-format.md with complete field layouts, limits, key hierarchy, state transitions, algorithms, recovery rules, version negotiation and independent test vectors. Verify library APIs and current security guidance. A prior library audit does not audit our composition.

**Secret handling:**
- Secret types do not implement revealing Debug/Display. Avoid accidental Clone and serialization.
- Use zeroize/secrecy-style types where supported. Minimize lifetime and copies.
- Attempt memory locking where practical, but report OS limitations; do not promise secrets never touch swap.
- Clear UI fields, native temporary buffers, cached decrypted records and search indexes on lock.
- Never put secrets in argv, environment variables, URLs, query strings, localStorage, browser IndexedDB, crash attachments or tracing spans.
- If a subprocess needs sensitive input, use supported private pipes/handles or platform credential facilities.
- Do not expose decrypted keys or generic decrypt operations through IPC.
- Secret storage unavailable → ask for passphrase again or explain failure. Never fall back to plaintext storage.
- Quick unlock is optional. OS credential APIs and real access-control policies must protect the stored wrapping material; a cosmetic biometric prompt is not key protection.
- Distinguish biometric-gated vault unlocking from hardware-backed SSH signing. They are different capabilities.

**Recovery and destruction:**
- Offer a high-entropy recovery key generated locally. Require a verification step before declaring recovery configured.
- Cloud account reset must not silently recover/decrypt a vault without an explicitly designed recovery mechanism.
- Explain that loss of all unlock/recovery methods means loss of encrypted data.
- Backup export must use a separate encrypted portable format and include all required metadata, migration version and integrity checks.
- Restore previews the destination and never overwrites a working vault before validation succeeds.
- Export cannot include device-bound private keys; report excluded items.
- Erasing data removes active files/keys according to platform capabilities, but do not claim guaranteed physical erasure from SSDs, snapshots or backups.
- Logout from sync must not delete unsynced local vault data. Local deletion is a separate explicit destructive action.

### 4.4 Vault and session state machines

Vault states: UNINITIALIZED → LOCKED → UNLOCKING → UNLOCKED → LOCKING → LOCKED; include recoverable error states. Only one unlock/migration transaction owns a vault at a time.

Session states: IDLE → RESOLVING → CONNECTING → VERIFYING_HOST → AUTHENTICATING → OPENING_CHANNEL → CONNECTED → RECONNECT_WAIT or CLOSING → CLOSED/FAILED.

Use generation counters/cancellation tokens. After lock, an older async callback cannot publish decrypted data or create a new session. Lock must cancel pending secret prompts, sync decrypts, file edits and key generation.

Default lock policy closes SSH/local sessions, transfers, tunnels and sharing after bounded cleanup. Warn before an interactive manual lock if it will interrupt work. OS lock/suspend must not wait indefinitely for a prompt. The UI describes the behavior.

An optional later “keep connections while screen locked” mode needs a separate threat-model decision. It cannot claim all session secrets were erased while retaining active encrypted transports.

### 4.5 Host trust and SSH policy

- Verify the presented server key before password/key authentication.
- The first-use dialog shows hostname, resolved address when available, port, algorithm, fingerprint and the specific jump-chain hop.
- Support cancel, trust once, and persist trust; do not treat clicking Connect as implicit first-use trust.
- Changed-key handling blocks the connection, displays old/new fingerprints and requires an explicit replace-trust flow with a reason.
- Match trust against canonical hostname/port rules. Test IPv6, aliases, IDNA, non-default ports, SSH config aliases and hashed known-host entries if supported.
- Validate every hop in a bastion chain, not just the final server.
- For host certificates, validate trusted CA, principals, validity, critical options and supported revocation behavior. Do not accept “signed” as sufficient.
- Modern algorithms by default; record the exact supported negotiation list after library validation.
- Legacy exceptions are per-host, visible, time-bounded where practical and never enabled by retry fallback.
- Post-quantum/hybrid algorithms are used only if the selected library and server support the standardized/implemented combination. Do not implement novel SSH algorithms.
- Client keys and certificates require correct parsing, bounds and passphrase handling. Do not advertise FIDO2/TPM/Secure Enclave support until real hardware tests pass.
- Built-in and system SSH agents are separate adapters. Agent forwarding is off by default and scoped to the approved host/chain.
- A malicious remote server must not obtain arbitrary signing through an unrestricted agent proxy. Use available destination/confirmation restrictions and explain limits.
- Never auto-submit stored passwords solely because terminal text resembles a sudo/password prompt. Offer an explicit user action; banners can spoof prompts.
- Reconnect with capped exponential backoff plus jitter. Cancel on lock/close, changed host key, credential failure or policy denial. Do not replay typed commands automatically.

### 4.6 IPC, WebView and local process policy

- Bundle all executable UI assets. No remote HTML, scripts, fonts, ads or arbitrary web browsing in privileged windows.
- Define a production CSP from actual build requirements. No broad wildcard origins, remote scripts, unsafe-eval or disabling CSP to silence errors.
- Document any narrowly necessary style/worker sources; keep dev-server allowances out of production.
- Treat the Tauri isolation pattern as defense-in-depth. Validate its benefit/compatibility in Phase 1; never substitute it for native validation.
- Use an explicit enabled-capability list. Audit custom commands and plugin permissions for each window.
- No generic renderer-accessible filesystem, shell, HTTP, process spawning, database query or unrestricted open-URL command.
- Password prompts, file grants and connection handles have bounded lifetime and must belong to the active authorized window.
- All IPC payloads have schema validation, maximum lengths, enum allowlists and safe errors.
- Plaintext secrets cross IPC only for explicit transient entry; never through broadcast events.
- Terminal byte streams use session-owned bounded channels. A detached window cannot subscribe to another window's stream.
- Native dialogs mint scoped file handles. Normalize paths and use safe platform APIs against symlink/reparse-point races.
- Spawn only an explicitly selected local shell/editor with structured arguments. Do not concatenate imported text into shell commands.
- Test builds may expose test automation interfaces only behind an explicit non-default build feature, bound to loopback with per-run credentials. Production compilation must exclude those plugins/features entirely.
- Do not run the application or test terminal service as root/Administrator.

### 4.7 Terminal content and command execution

Remote terminal bytes, titles, links, filenames, history and AI responses are untrusted data.

- Feed terminal output only into the terminal parser; render titles and labels as text.
- Disable unnecessary parser addons and escape-sequence actions.
- Bound OSC/DCS payloads and link lengths; exercise malformed and incomplete sequences in tests.
- OSC 52 clipboard writes are disabled by default; never allow remote clipboard reads. Expose a per-session consent option.
- Validate link schemes; default allowlist http/https. Deny javascript, data, file and application command schemes. Use the OS browser, not a privileged in-app view.
- Require a direct user action to open a link. Show the actual destination and resist deceptive/truncated labels.
- Large/multiline paste gets a preview when risky. Enable bracketed paste when supported. Do not claim heuristic command detection proves safety.
- Broadcast mode has a persistent banner, target count and target identities. It is off after restart/reconnect. Support stopping it immediately.
- Startup snippets are opt-in and scoped. Workspace restoration must not silently execute previously saved destructive commands.
- Environment values are sensitive; show inheritance and override origin. SSH SendEnv requires server support.
- Shell integration is opt-in and versioned. Review the exact installed script, avoid unsafe eval, and do not edit shell startup files without explicit user action.
- Do not execute AI-generated commands or snippet parameter substitutions automatically.
- Record raw terminal output as sensitive if recording is enabled; “password prompt detection” is not a reliable redaction system.

### 4.8 Files, imports and external editors

- Transfer data in bounded chunks, with cancellation and backpressure. Never load whole large files into memory.
- Define collision policy: ask, overwrite or keep both; do not silently overwrite by default.
- Use temporary destination names and atomic rename where the server/filesystem supports it. Document weaker guarantees otherwise.
- Distinguish cancellation, completed transfer, interrupted transfer and unverified resume.
- Resolve remote-to-remote copying through the client unless a separately tested server-side capability exists.
- Treat remote paths as remote bytes/strings, not local filesystem paths. Handle non-UTF-8 names without lossy collisions where supported.
- Prevent downloads escaping the user-selected directory via absolute paths, traversal, symlinks, Windows drive/UNC prefixes or reparse points.
- Test reserved Windows filenames, case collisions, Unicode normalization, long paths, spaces, leading hyphens and control characters.
- Do not follow remote symlinks recursively by default; detect cycles and traversal limits.
- Remote chmod/delete/rename operations show the actual target and rely on server permissions. Never emulate server authorization in UI alone.
- External editor sessions use private temporary directories and safe argv. Track initial remote size/mtime and a hash when feasible.
- Before re-upload, detect remote changes; show conflict options. Never overwrite merely because a filesystem watcher fired.
- Clean temporary files on close/startup within the app-owned area. Warn that external editors may create their own backups.
- CSV/XML/JSON import has file, record, field, nesting and time limits. Disable XML external entities. Preview changes before committing.
- OpenSSH import never executes ProxyCommand, LocalCommand, Match exec or arbitrary Include paths. Import supported declarative settings; show unsupported directives.
- Provider/import actions never scan arbitrary networks. LAN discovery, if implemented, requires a user-selected scope and explicit start.
- Native default SFTP directory, safe basic file CRUD and permission editing are product enhancements, regardless of competitor support.

### 4.9 Logging and privacy

Separate operational diagnostics from user-enabled session recordings.

Diagnostics contain only bounded event codes, durations, counts and generated non-secret identifiers. Avoid hostnames, IPs, usernames, paths, command text, record payloads and provider responses by default.

Persistent command history, session recording, cloud log synchronization and diagnostic upload each have separate settings. Turning off recording stops future capture; deletion of existing logs is a separate action. Do not inherit destructive competitor behavior.

Provide retention limits, size caps, explicit deletion, encrypted export and an honest storage indicator. Log viewing uses the safe terminal renderer with active escape actions disabled. A replay must not open links, alter clipboard or execute commands.

Trace redaction is allowlist-based. Test with unique canary secrets across successful and failing workflows, panics, HTTP errors, support bundles and screenshots. Disable sensitive screenshots/video in authentication tests and shared CI artifacts.

## 5. Optional synchronization and collaboration

### 5.1 Service boundaries

Personal sync does not proxy SSH. The service stores encrypted record envelopes and the minimum metadata needed for ownership, revisioning, device authorization and quota enforcement. The operator may still observe IPs, account identifiers, timing, sizes and membership metadata; document this leakage.

Keep the client fully functional when the service is absent, slow, offline or malicious. No service startup is needed to launch the local app.

Use a maintained OIDC provider with native Authorization Code + PKCE and the system browser. For desktop use a standards-compliant callback mechanism; bind loopback listeners to loopback, verify state, use ephemeral ports and short expiry. For mobile use properly registered verified links where possible. Do not embed a client secret or run login pages inside the privileged WebView.

The server verifies issuer, audience, authorized algorithms, signature, expiry and subject. Account identity keys are the issuer/subject pair, not mutable email. Refresh credentials stay in OS-backed storage. Vault unlock/recovery is independent from OIDC login.

### 5.2 Personal sync protocol requirements

Before coding, specify and test:
- Vault ownership, opaque random record IDs, encrypted payload schema and authenticated format versions.
- Local outbox transactions committed atomically with local edits.
- Idempotency keys and compare-and-swap revisions; retries cannot duplicate mutations.
- A bounded change feed/cursor, tombstones and compaction rules.
- Deterministic conflict preservation. Do not silently last-write-win passwords, keys, host trust, membership or startup scripts.
- Explicit conflict UI with local/remote values only after client decryption; never send plaintext conflict resolution to the server.
- Deletion versus offline edits, device clock skew, repeated delivery and partial batches.
- Password rewrap, vault-key rotation and multi-device migration without mixing key generations.
- Device enrollment through a high-entropy recovery method or approval from an existing trusted device. Do not trust a server-supplied replacement device key without verification.
- Authenticated device identities and reviewed device-key wrapping/signing machinery; use established libraries/protocols and document the exact scheme.
- Persisted client checkpoints to detect replay/rollback against known state. A brand-new device with no trusted checkpoint cannot generally prove global freshness against a malicious server; describe the limit.
- Server omission, withholding and denial of service are not solved by encryption.
- Recovery procedures for lost devices, lost accounts, compromised devices and old offline clients.
- No crypto key or recovery secret in URLs, logs, analytics, invitations or email.

The cryptographic record container does not itself authenticate team membership or prove authorization. Apply both authenticated envelopes and server-side access control, plus client verification of trusted membership/device changes.

### 5.3 Suggested server API surface

Use a versioned /v1 API and generated OpenAPI schemas. These are semantic endpoints, not permission shortcuts.

| Endpoint family | Responsibility |
|---|---|
| /health/live and /health/ready | Minimal status; no secrets or dependency credentials |
| /me | Authenticated account metadata |
| /devices | Enroll/list/revoke approved devices |
| /vaults | Create/list authorized vault metadata |
| /vaults/{id}/changes | Bounded authenticated encrypted change feed |
| /vaults/{id}/mutations | Transactional idempotent mutation batches |
| /vaults/{id}/blobs | Bounded encrypted log/backup chunks |
| /vaults/{id}/members | Authorized membership changes |
| /sessions/share | Explicit ephemeral collaboration session setup |
| /sessions/{id}/control | Authenticated controller handoff and revocation |

Require authorization on every object and nested route. Test guessed IDs, stale roles, revoked devices, cross-tenant joins, oversized requests, cursor tampering and race conditions. IDs are never security boundaries.

Set body/record/batch limits, database timeouts, connection caps, request concurrency limits, rate limits and storage quotas. Parameterize SQL. No shell commands in request handlers.

Self-hosted endpoint changes require explicit user selection. Never follow redirects carrying auth tokens to a different origin. TLS verification stays on; local HTTP is permitted only for explicit development/loopback profiles. Validate endpoint URLs and block accidental metadata-service access without preventing explicitly configured private self-hosted endpoints.

### 5.4 Shared vaults and teams

Implement after personal sync passes adversarial tests.

- Separate roles for ownership, membership administration, editing vault metadata and using connections.
- Explain that possessing a reusable SSH private key/password can enable access outside this app. UI “viewer” roles cannot make that key read-only on the server.
- New membership requires authenticated approval and verified recipient key material.
- Membership changes are versioned and authenticated. Race-test removal versus offline writes and concurrent invitations.
- Remove future access and rotate keys for future data as defined by the protocol. Do not claim to revoke already downloaded plaintext.
- Key rotation after removal cannot retroactively conceal history the member already decrypted.
- Do not silently fall back to server-readable encryption for convenience.
- Team audit events record who changed access and when; distinguish them from terminal output recordings.
- MFA enforcement delegates to trusted identity-provider policy/claims with documented verification.
- SAML integration should normally be mediated by the chosen identity provider. Avoid implementing a custom SAML parser.
- Do not claim SOC 2 or similar compliance merely because audit logging exists.

### 5.5 Live terminal sharing

Keep it behind an experimental flag until security review and native tests pass.

Use a vetted end-to-end encrypted transport/protocol rather than inventing a WebSocket encryption scheme. A relay can route opaque traffic but cannot authenticate participants merely by possession of a guessable session ID.

Requirements: explicit owner start, selected session, authenticated participants, expiring invite, one active controller, owner revoke/stop, visible sharing state, reconnect reauthorization, sequence/replay checks, size/rate limits and bounded buffers.

The owner remains the SSH endpoint. Guests receive only the shared stream and explicitly granted input authority, never SSH keys. A viewer must not be able to inject input through resize, clipboard, terminal control or alternate message types.

Stop sharing on vault lock, owner disconnect, expiry or revocation. Control transfer uses an explicit epoch/token so two participants cannot retain simultaneous write authority. Document what authentication prompts and secret output participants can see; provide a pause/stop path, not a false guarantee of automatic redaction.

## 6. Performance and resource engineering

### 6.1 Initial measurable budgets

These are project targets, not claims about Tauri or any library. Establish baseline hardware in Phase 1: a contemporary 4-core/16-GB/SSD Windows device and an Apple Silicon Mac. Record exact CPU, RAM, OS, WebView and build mode. Maintain separate hardware-specific baselines.

| Metric | Initial target / workload |
|---|---|
| Cold launch to usable locked/home UI | p95 ≤ 2 seconds over at least 20 runs, excluding first installation |
| Warm launch | p95 ≤ 1 second |
| Idle app CPU | Mean < 1% of one logical core over 60 seconds, after settling |
| Idle application process-tree memory | ≤ 200 MiB target; include attributable WebView processes and state methodology |
| Ten connected idle terminals | ≤ 500 MiB target with default bounded scrollback |
| Input-to-local-echo/render overhead | p95 < 30 ms in a local deterministic fixture, separate network RTT |
| Interactive frame delivery | Aim for 60 FPS on a 60-Hz display; avoid >50-ms main-thread tasks during typing |
| Host search | p95 < 100 ms on 10,000 unlocked synthetic records |
| Inventory scrolling | Virtualized and responsive with 10,000 records |
| Terminal stream | Sustain a 5-MiB/s synthetic stream for 60 seconds with bounded queues |
| SFTP transfer | Aim for ≥70% of reference OpenSSH SFTP throughput on the same fixture/settings |
| Large-file memory | A 2-GiB transfer adds ≤64 MiB application-owned buffering |
| Cancellation | User-visible cancellation within 250 ms; transport teardown may have a bounded timeout |
| Unlock | Aim for 250–750 ms KDF on baseline desktop hardware; preserve security floor |
| Leak/soak check | No monotonic retained-resource growth after 100 connect/close cycles and a 2-hour soak |
| Frontend initial JS | Target ≤500 KiB compressed; load terminal/advanced modules when needed |
| Desktop distributable | Target ≤40 MiB compressed excluding externally installed WebView runtime; measure per platform |

Explain missed budgets using profiles. Do not weaken crypto, drop terminal bytes or remove validation to achieve a number. If a baseline is infeasible, record evidence and a justified revised budget, preserving the original target in history.

### 6.2 Required implementation techniques

- One Rust async runtime per process unless a dependency requires otherwise.
- Bounded task creation and channels; define capacity and cancellation ownership.
- Never use an unbounded queue for terminal output, file chunks, logs, sync or events.
- Terminal I/O bypasses React state. Keep an imperative terminal controller with stable identity.
- Batch byte output by bounded byte count/time window; use terminal write completion/backpressure before acknowledging more data.
- Prefer efficient native channel/binary transfer APIs where supported. Benchmark the actual Tauri encoding path; do not assume zero-copy.
- If backpressure cannot propagate to a transport, suspend/terminate with a clear error rather than silently dropping bytes.
- Default scrollback: 5,000 lines with a practical memory ceiling; allow bounded configuration.
- Background terminal rendering can be throttled; parsing/order correctness must remain intact.
- Dispose terminals, addons, listeners, resize observers, workers, handles and timers exactly once.
- Debounce resize and propagate final dimensions; never recreate the SSH session on a React rerender.
- Virtualize host lists, file tables and long histories. Memoize expensive selectors only when measurements justify it.
- Keep database work on a dedicated worker; do not block the UI or Tokio reactor with synchronous SQLite/KDF operations.
- Batch related writes transactionally; avoid per-keystroke database writes.
- Use pagination for server APIs and directory views, bounded concurrent transfers and cancellation tokens.
- Avoid a separate polling loop per host. Coalesce health/status tasks and backoff idle work.
- Use latest-request-wins semantics for search without allowing stale results to overwrite current state.
- Lazy-load optional AI, provider, team and mobile-specific modules.
- Tune release profiles with benchmarks; evaluate thin LTO, symbol splitting and dependency features. Do not use binary packers as a default optimization.
- Keep debug symbols privately for crash diagnosis; never distribute secret-bearing dumps.

Start limits in a central limits module: 16 visible panes, 32 concurrent connections, 4 transfers, 4 simultaneous connects, 64-KiB terminal write batches and a 1-MiB per-session queued-output ceiling. These are initial application defaults to benchmark, not protocol maxima. Add explicit bounded settings where needed.

## 7. Design language and interaction specification

### 7.1 Visual direction

Working product name: LocalSSH. Treat name, icon and reverse-domain package identifier as provisional until publication. Do not imitate Termius artwork or layouts pixel-for-pixel.

Use a quiet, precise workspace aesthetic: neutral surfaces, clear hierarchy, excellent typography, modest corner radii, restrained accents and purposeful micro-interactions. The terminal is the primary work surface. Avoid decorative dashboards, oversized hero areas, gradients behind terminal text, glass effects that reduce contrast and constant animation.

Support light, dark and system themes. Use system UI fonts; bundle only licensed assets. Terminal font starts with a tested local/bundled monospace fallback. Font loading must not contact a third party.

Suggested starting tokens, to validate for contrast:
- Dark canvas #0B1016, panel #121A24, elevated surface #1B2634, primary text #E8EDF3.
- Light canvas #F5F7FA, panel #FFFFFF, primary text #152131.
- Accent #2563EB on light surfaces; use a lighter accessible variant on dark surfaces.
- Status colors for success/warning/error with icons and text, never color alone.
- Spacing scale 4/8/12/16/24/32; control radius 8; panel radius 12.
- Desktop controls about 32–36 px high where accessible; mobile touch targets at least 44×44 CSS px with platform adjustment.
- UI text around 13–15 px, terminal default around 14 px with zoom.
- Motion 120–180 ms for small state changes; honor reduced motion.
- Terminal colors independently configurable from the application theme.

Meet WCAG 2.2 AA as a design/test goal. Check text contrast, focus rings, accessible names, keyboard traps, zoom and high-contrast modes. Terminal screen-reader behavior needs real assistive-technology testing; automated axe checks are insufficient.

### 7.2 Layout and navigation

Desktop shell:
- Resizable left navigation/inventory panel.
- Main tab/workspace region.
- Optional contextual right inspector.
- Compact connection/status surface showing target identity, trust/recording/sharing/broadcast state when relevant.
- Command palette for navigation and user-approved actions.
- A minimal home view: connect/search, recent hosts and locally stored workspaces. No required account upsell.

Primary destinations: Hosts, Workspaces, Files, Snippets, Tunnels, Keychain, Logs, Settings. Group advanced destinations logically as the product grows rather than showing every feature from first launch.

Use native window controls and platform-specific menus/shortcuts. macOS uses Cmd conventions; Windows uses Ctrl conventions. Respect terminal Ctrl+C as interrupt when no text-selection action takes precedence. Expose shortcut preferences and resolve collisions with remote apps.

### 7.3 Required screens and states

Implement complete empty/loading/success/error/permission-denied/locked/offline states for:
1. First launch and local vault creation.
2. Unlock and recovery.
3. Empty host inventory and first connection.
4. Host/group editor with inherited versus overridden values.
5. First-use and changed host-key decisions.
6. Transient password/passphrase/keyboard-interactive authentication.
7. Terminal tab and split workspace.
8. Broadcast target review and active broadcast indicator.
9. SFTP browsing, conflict dialog, queue and editor workflow.
10. Tunnel setup, non-loopback warning and active listeners.
11. Key creation/import, hardware-key presence and credential association.
12. Snippet editing, paste/run preview and multi-host result summaries.
13. Optional history and session-log recording/retention.
14. Backup export and restore preview.
15. Optional sync onboarding, endpoint/account connection and device enrollment.
16. Sync conflicts, offline pending work and revocation.
17. Team role changes and live-sharing control.
18. Optional provider imports and AI context review.
19. Settings, diagnostics and signed update availability.

Host editors have a simple primary section and an Advanced expander. Show the effective destination, username, authentication method and chain before connecting. Hidden inherited settings must be discoverable.

Do not place passwords into fake placeholder values. A saved secret is represented as “stored credential” with replace/remove actions. Keep destructive data deletion distinct from unlinking a cloud account.

### 7.4 Error and accessibility behavior

Every error says what failed, whether data is safe, and a practical next action. Give a copyable redacted diagnostic ID. Avoid raw Rust/SQL/HTTP errors in normal UI.

No endless spinners: timeouts transition to an actionable state. Cancellation works without restarting the app. Preserve unsaved editor changes across recoverable errors.

Support keyboard-only flows, logical focus order, focus restoration after dialogs, visible focus, labeled icons, screen-reader status announcements and 200% zoom. Make small motion optional. Test IME composition, CJK, dead keys, emoji, combining marks, RTL labels and long translated strings.

Do not add localization initially by sprinkling string concatenation. Use centralized message IDs and interpolation so additional languages can be added later. English is the initial implementation language.


## 8. Phased implementation plan and acceptance gates

Apply the security/performance/design requirements throughout. Each phase ends with docs/reports/phase-NN.md containing implementation changes, executed commands and exit codes, relevant test IDs, measured results, screenshots using synthetic data, known gaps and verdict.

Do not wait for the owner between passing phases. If a required environment is absent, continue independent implementation and keep the blocked gate open.

### Phase 00 — Repository discovery and execution baseline

**Build:** Inspect repository/instructions, preserve user changes, detect installed Rust/Node/pnpm/OS SDKs/Docker and available native runners. Copy this prompt to BUILD_SPEC.md. Create AGENTS.md, architecture/threat-model outlines, progress tracking and the complete feature matrix. Choose provisional naming and record the license assumption.

**Decide:** Current supported OS versions, architectures and distribution channels based on current upstream support. Initial targets: Windows x64 and macOS Apple Silicon; add Intel macOS only if the selected upstream/runtime still supports it and a runner is available. Do not invent a supported-version matrix.

**Test:** Environment doctor verifies tool versions and filesystem permissions without reading user secrets. Establish a synthetic SSH lab reachable only by authorized local test clients.

**Gate:** Reproducible commands, feature ownership, risk register and explicit unavailable-environment list exist. No implementation feature is marked verified yet.

### Phase 01 — Technical feasibility spikes

**Build:** Minimal real Tauri window; one xterm terminal; Rust-to-renderer binary/chunk stream; one SSH session to disposable OpenSSH; local PTY/ConPTY proof; OS-secret-store proof; SQLite encrypted-record proof. Evaluate current mobile compilation/plugin compatibility early.

**Test:** Host-key mismatch rejection, password and Ed25519 authentication, terminal resize, large-output backpressure, native file dialog, lock cleanup, and production build with test hooks absent. Verify macOS native test tooling on the actual pinned versions.

**Measure:** App startup, idle memory/CPU and terminal stream overhead on available platforms.

**Gate:** ADRs name exact dependency versions and limitations. If russh lacks a required authentication capability, evaluate a maintained adapter/backend alternative; never disable verification as a workaround. Keep mobile/advanced limitations visible.

### Phase 02 — Application foundation and encrypted local vault

**Build:** Design tokens, accessible shell, local onboarding/unlock/lock, typed IPC, Rust services, SQLite worker, encrypted records, OS quick-unlock adapter, backup/restore and migration framework. No account UI required to use the app.

**Security:** Complete crypto-format specification and known-answer vectors. Bind records to vault/record/revision context. Implement bounded KDF parsing, secret-free errors and lock-generation invalidation.

**Test:** Wrong passphrase, header/ciphertext tampering, swapped records, unsupported versions, interrupted rewrap/migration/restore, unavailable keychain, disk full, concurrent unlock and lock-during-write. Search raw DB/WAL/temp/logs for canary plaintext.

**Gate:** Create → store → lock → reopen → recover → backup → restore works against real persisted files. Fresh local mode makes no vendor network requests.

### Phase 03 — Secure SSH vertical slice

**Build:** Add host, verify server identity, authenticate, open interactive shell, resize, copy/paste safely, disconnect and reconnect. Support Ed25519 and password authentication first; add supported RSA/ECDSA without weak-algorithm defaults.

**Security:** Distinct trust/auth/channel states; no credentials before trust. Timeouts, cancellation, bounded buffers, safe title/link handling and sanitized connection errors.

**Test:** Two differently keyed servers using the same endpoint, wrong password, encrypted key, unknown key, non-default port, IPv6, denied channel, disconnect during authentication, zero-length reads, malformed output and reconnect cancellation.

**Gate:** Real native application connects to a real disposable server and executes a harmless fixture command. Changed keys block before credentials are sent. A mock connection does not pass.

### Phase 04 — Host inventory, identities and essential migration

**Build:** Nested groups, tags, search, duplication, bulk actions, effective inherited settings, reusable identities, key import/generation and explicit public-key deployment. Add OpenSSH/CSV import preview and encrypted full-vault export.

**Security:** Import is declarative, bounded and non-executing. Key deployment previews authorized_keys changes, preserves unrelated entries and uses server permissions. Do not store imported private material in diagnostic artifacts.

**Test:** Group cycles, dangling references, inheritance overrides, 10,000-host search, encrypted key passphrases, malformed keys, duplicate entries, CSV injection strings and blocked executable SSH-config directives.

**Gate:** Inheritance is deterministic, imports are transactional, failed imports leave existing data unchanged, and search performance is measured.

### Phase 05 — Terminal polish and workspaces

**Build:** Tab lifecycle, split/focus modes, pane resizing/reordering, search, configurable terminal appearance, shortcuts, recent connections, command palette, local terminals, reusable layout templates and explicit broadcast mode.

**Security:** Template restore reconnects only by an explicit user action; command re-execution gets a separate preview. Broadcast state never silently persists across restart/reconnect. Detached windows receive scoped permissions.

**Test:** Vim/nano/tmux-like full-screen fixtures, Ctrl+C interrupt, clipboard-selection shortcuts, bracketed paste, IME/Unicode, high DPI, WebGL failure/fallback, detach/close races, 16 panes and cross-window stream access denial.

**Gate:** Usable keyboard-only workflow, correct session cleanup and measured input/stream latency. Saved layouts are not advertised as remote-process persistence.

### Phase 06 — SFTP and external file editing

**Build:** Two-pane browser, local/remote endpoints, file/folder upload/download, remote-to-remote streaming, hidden files, path entry, basic create/rename/delete/permissions, default remote directory, transfer queue and external editor workflow.

**Security:** Scoped file grants, traversal/symlink protections, private temp files, bounded buffering, conflict detection and no shell interpolation for file operations.

**Test:** 2-GiB file integrity, many small files, interrupted transfer, cancellation, disk full, permission denied, stale directory entry, overwrite conflict, editor autosave, server-side concurrent edits, strange filenames and path escape attacks.

**Gate:** Byte-for-byte transfer integrity with bounded memory. Resume remains disabled unless partial-state verification is implemented and tested. No invisible data loss on conflicts.

### Phase 07 — Tunnels, advanced connections and authentication

**Build:** Local/remote/dynamic forwarding, lifecycle/status, loopback defaults, jump chains and authenticated proxies. Add serial and Mosh adapters only after compatibility spikes. Telnet is explicitly optional legacy functionality with a plaintext warning.

**Advanced credentials:** SSH certificates, hardware-backed keys, platform signing and agent adapters as supported. Distinguish each platform's actual algorithms and APIs. A software key protected by a biometric unlock is not a hardware-generated non-exportable SSH key.

**Security:** Verify every jump hop; protect SOCKS listeners; agent forwarding off; destination-scoped approvals; resource limits and cancellation; weak protocol modes never automatic.

**Test:** Bastion identity change, proxy auth rejection, denied forwarding, bind failure, IPv4/IPv6 listener exposure, external bind approval, reconnect cleanup, serial disconnect, Mosh roaming/loss fixtures where available, real hardware presence/cancel/PIN behavior.

**Gate:** Core tunnel/jump/proxy workflows pass. Unsupported advanced adapters remain accurately blocked/experimental and hidden from normal stable UI.

### Phase 08 — Snippets, shell integration, history and logs

**Build:** Snippet folders, multiline commands, paste/run actions, target selection, startup scripts, environment inheritance, supported shell integration and non-AI autocomplete. Add optional encrypted command history and session recording with search, bookmarks, retention and export.

**Security:** No automatic password injection from prompt text. Recording/history remain separate opt-ins. Never log raw keystrokes as diagnostics. Playback disables active escape actions.

**Test:** Snippet target review, partial multi-host failure, cancellation, startup script opt-in, unsupported shell fallback, server AcceptEnv rejection, sensitive-output canaries, retention, corrupted/truncated logs and safe playback.

**Gate:** Normal terminal use works with autocomplete/integration/logging disabled. Disabling recording preserves old logs unless deletion is separately requested.

### Phase 09 — First local desktop release candidate

**Build:** Finish all required local UI states, settings, user guide, import/export/restore, installer configuration, upgrade migrations, uninstall policy, local diagnostics and manual signed-update flow.

**Security:** Audit IPC allowlists/CSP, dependency graph, test-feature removal, filesystem permissions, release binary contents and update verification. Independent vault/security review packet is ready.

**Test:** Native Windows/macOS workflows, clean install, first-run offline use, upgrade from earlier fixture schema, failed migration recovery, OS lock/sleep/resume, multi-window close, high DPI, installer removal preserving user data by default, update tampering and downgrade attempts.

**Gate:** Produce local release candidates and a known-issues list. Missing production signing identities block official signing/public release, not local packaging. Stable publication still requires the declared review and authorization gates.

### Phase 10 — Optional personal encrypted sync

**Build:** Self-hostable server, local development OIDC, explicit opt-in onboarding, endpoint configuration, encrypted records/outbox, device enrollment, recovery, conflict UI and sync status. Add a second-device test application profile.

**Security:** Complete sync-protocol review, tenant/object authorization, token protection, metadata disclosure, replay/rollback limitations and device-key validation. No plaintext vault endpoint.

**Test:** Two devices offline-editing the same record, lost replies, duplicate requests, expired token, revoked device, wrong tenant, malicious envelopes, tombstone/edit races, clock skew, interrupted key rotation, server rollback against a saved checkpoint, service outage and server-database plaintext inspection.

**Gate:** A fresh second device restores through the documented trusted recovery/enrollment flow. Server outage does not block local use. Disable-sync halts traffic and preserves local data.

### Phase 11 — Teams, shared vaults and collaboration

**Build:** Team membership, multiple vaults, roles, authenticated key distribution, owner transfer and minimal audit events. Add live terminal sharing behind an experimental flag, with one controller and owner stop.

**Security:** Review key rotation/removal semantics, offline-member limits and identity-provider MFA evidence. Implement trusted membership changes and explicit participant authentication. No viewer-to-controller bypass.

**Test:** Cross-tenant access, revoked member with an old token, cached/offline records, concurrent role changes, invitation replay, wrong recipient keys, stolen/reused session invite, control epoch races and stop-sharing during reconnect.

**Gate:** Team sharing and live collaboration have separate evidence/review verdicts. A passing shared-vault test does not verify live-terminal transport.

### Phase 12 — Cloud discovery and broader migration

**Build:** AWS EC2/Lightsail, DigitalOcean and Azure inventory adapters; read-only credentials, scoped regions/subscriptions, import preview and reconciliation. Add PuTTY/MobaXterm/SecureCRT importers where formats can be implemented correctly.

**Security:** Provider credentials remain local by default. No implicit metadata-service/ambient credential discovery. Reject redirects leaking tokens. Reconciliation preserves manual overrides and previews removals.

**Test:** Paginated/rate-limited APIs, token expiry, deleted/renamed instances, public/private IP changes, duplicate imports, malformed/encrypted exports, canceled import and offline operation. Unit/mock provider fixtures precede any explicitly authorized real-provider testing.

**Gate:** No live cloud account is required for core tests. Untested provider integration is labeled accordingly. Never scrape secrets from unrelated cloud tooling.

### Phase 13 — Optional AI assistance

**Build:** Provider interface supporting an explicit user-selected remote/BYOK endpoint and an optional local provider. Features: command drafting, snippet drafting and selected-output explanation. Non-AI autocomplete remains fully functional.

**Security:** AI is off by default. Show the exact context being sent; exclude vault secrets and private-key material. Server text and model output cannot authorize tools or commands. Protect API keys in OS-backed storage. Do not grant an unrestricted shell agent.

**Test:** Prompt injection in server output, malicious model commands/links, long responses, provider errors, canceled requests, secret canaries, revoked consent and all-network-disabled mode.

**Gate:** Model output is always reviewable/editable and requires explicit execution. Command heuristics are described as assistance, not proof of safety.

### Phase 14 — Android and iOS/iPadOS

**Build:** Reuse Rust core/contracts; implement mobile navigation, extra keyboard, gesture cursor movement, external keyboards, tablet layouts, file picker/share sheet, lifecycle, keystore/biometrics and per-platform capabilities. Add mobile sync and recording only with parity tests.

**Security:** Validate app sandbox/file grants, screenshots/app-switcher behavior where supported, deep links, backup exclusions, device-bound keys and OS suspend behavior. Request no location permission merely to evade background restrictions.

**Test:** Real-device key storage/biometrics, rotate/resume, soft keyboard overlays, hardware keyboard, CJK/IME, airplane mode, network roaming, background suspension, process death, share-sheet file handling, recovery and cross-platform vault compatibility.

**Gate:** Android/iOS builds are tested separately. Simulator tests do not prove hardware-backed key security. iOS development/signing needs the appropriate macOS/Xcode environment. Clearly document features that the OS cannot support, such as unrestricted local desktop shells or guaranteed indefinite background SSH.

### Phase 15 — Final hardening and maintenance readiness

**Build:** Complete documentation, feature matrix, release notes, migration fixtures, reproducible build instructions, support-bundle controls and update-key rotation procedures.

**Test:** Full declared platform matrix, two-hour soak, 100-cycle resource leak test, dependency/advisory scan, fuzz corpus, malicious-server regression pack, accessibility review, performance comparison and disaster recovery.

**Gate:** Every included stable feature is VERIFIED on declared platforms; unavailable advanced features are explicitly blocked/deferred and not advertised. No unresolved exploitable high/critical security finding in stable scope. Independent review status, signing status and actual benchmark results are stated truthfully.

Continue maintenance work with dependency upgrades, regression tests, release verification and advisory response. Do not silently widen capabilities or introduce new data flows in routine updates.

## 9. Test architecture, fixtures and required evidence

### 9.1 Test layers

| Layer | What it establishes |
|---|---|
| Pure unit tests | Domain rules, inheritance, parsing, state transitions and error mapping |
| Property tests | Round trips, canonicalization, bounds, conflict invariants and invalid-input rejection |
| Known-answer crypto tests | Interoperability and tamper rejection beyond same-library encrypt/decrypt |
| Integration tests | Real SQLite, OS adapters, SSH/SFTP server and service/database behavior |
| Browser component/E2E | Layout, accessibility, keyboard flows and renderer logic |
| Native packaged-app E2E | Actual Tauri IPC, dialogs, lifecycle and native transport behavior |
| Fault injection | Interrupted writes, network loss, disk full, slow readers and crashed processes |
| Fuzzing | Untrusted parsers, crypto envelopes, paths, IPC and stream framing |
| Security tests | Explicit negative authorization, trust and data-exfiltration cases |
| Benchmarks/soaks | Throughput, responsiveness, memory/resource stability and cleanup |
| Manual/native-device checks | Biometrics, screen readers, mobile lifecycle and platform-specific behavior |

Use browser mocks only for UI tests. At least one integrated workflow for each stable feature must exercise its real backend. A frontend simulated terminal is not the product.

The current Tauri documentation supports WebdriverIO's embedded integration on macOS as well as Windows/Linux. Validate pinned tooling in Phase 1. Use native drivers where appropriate. If tooling fails, report the exact gap; do not relabel browser tests as native coverage. Any embedded automation server is test-only and must not exist in release artifacts. [T02]

### 9.2 SSH and network lab

Use isolated, task-owned containers/processes, loopback-published random ports, disposable keys and no production credentials.

Fixtures include:
- Normal OpenSSH password/public-key server.
- Server with a different host key at the same endpoint.
- Encrypted-key client fixture and constrained authorized_keys.
- Jump host plus internal-only destination.
- SFTP server with permission errors, symlinks and unusual filenames.
- Forwarding-permitted and forwarding-denied users.
- Authentication-banner/keyboard-interactive fixture.
- Slow/disconnecting server and output-flood producer.
- Certificate-enabled server where supported.
- A safe remote process used to prove that reconnect does not preserve arbitrary processes by itself.

Use a network fault proxy for latency, loss, disconnects and bandwidth caps. Keep deterministic seeds and do not require internet to run the core suite after dependencies/images are installed.

Generate test credentials per run or use unmistakably public test keys in fixtures. Never reuse fixtures in production. Test lab teardown deletes only its own containers, volumes, files and processes.

### 9.3 Mandatory adversarial cases

| Test family | Required failure cases |
|---|---|
| Host trust | Unknown key cancel, changed key, wrong hop, wrong certificate principal, expired certificate |
| Credentials | Wrong passphrase, malformed key, excessive KDF params, agent refusal, fake password prompt |
| Vault | Bit flips, header swap, record swap, wrong vault binding, nonce misuse prevention, unknown version |
| Local persistence | Plaintext canaries in DB/WAL/temp/logs, crash during transaction, failed backup/restore |
| IPC | Wrong window, revoked handle, stale vault generation, oversized payload, unauthorized command |
| Terminal | HTML/script-like output, malicious titles, OSC clipboard, deceptive URLs, long/incomplete sequences |
| Local process | Shell metacharacters in host/editor/path settings, untrusted executable selection |
| SFTP | Traversal, symlink race, reparse points, collisions, disk full, editor overwrite race |
| Tunnels | Non-loopback binding without approval, listener leak, denied remote bind, excessive connections |
| Automation | Wrong targets, stale broadcast state, unapproved startup snippet, injected parameter |
| Sync | Wrong tenant, guessed ID, stale token, invalid device, replay, conflict, truncation, key-version mix |
| Sharing | Viewer input injection, invite reuse, two controllers, revoked member reconnect |
| AI | Output-based prompt injection, unauthorized tool execution, secret leakage and consent revocation |
| Updates | Wrong key, modified artifact, mismatched version, downgrade, interrupted install |
| Lifecycle | OS lock, suspend, crash, shutdown, close-during-connect, unlock callback arriving after lock |
| Resource limits | Output flood, file size extremes, import nesting, reconnect storms and request floods |

### 9.4 Performance methodology

Use release binaries, fixed synthetic datasets and recorded versions. Exclude initial compilation/installation from launch timings, but measure first-run setup separately.

Report distributions rather than a single fastest run. Preserve raw measurements and distinguish cold/warm caches. Measure the application process tree and explain shared-WebView attribution. Compare transfer throughput against a reference client with the same algorithms, network and files.

The terminal benchmark checks byte/order correctness as well as speed. The soak checks task counts, handles, threads, memory and sockets after cleanup. A memory increase alone is not automatically a leak; investigate retained allocations and repeated cycles.

### 9.5 Verification commands to implement

Create cross-platform scripts so contributors do not need to remember platform-specific chains. These are required project interfaces; implement them before documenting them as working.

| Command | Behavior |
|---|---|
| pnpm doctor | Toolchain/SDK availability and actionable setup report |
| pnpm dev | Launch local desktop app without cloud dependencies |
| pnpm verify:fast | Formatting checks, lint, typecheck, contracts, unit tests |
| pnpm test:integration | Real core/database/SSH-lab workflows |
| pnpm test:ui | Browser UI and accessibility checks |
| pnpm test:native | Packaged native E2E for current supported host |
| pnpm test:security | Named negative tests and release-policy checks |
| pnpm test:performance | Fixed benchmark workloads and comparison report |
| pnpm test:soak | Long-running stability/resource workload |
| pnpm test:sync | Local OIDC/server/database/two-client sync suite |
| pnpm test:mobile | Available Android/iOS native tests with explicit skips/blockers |
| pnpm verify:release | Complete platform-specific release gate and artifact inspection |
| pnpm build:desktop | Release application/installer for current target |
| pnpm lab:up / pnpm lab:down | Safe creation/teardown of task-owned fixtures |
| pnpm docs:check | Broken internal links, feature IDs and command/document consistency |

Underlying checks include cargo fmt --check, cargo clippy with project-approved lint settings, cargo test, TypeScript strict checks, lint, dependency advisories, license checks and secret scanning. Add cargo-fuzz/property-test tooling where supported. Use exact pinned versions rather than installation commands that unpredictably fetch latest during CI.

Do not use --all-features for production verification if it enables debug/test/experimental features. Test relevant combinations explicitly and inspect the release feature graph.

### 9.6 Coverage and test quality

Security-critical branches require explicit cases for both allowed and denied behavior. Use mutation testing on authorization/state-machine logic where practical.

Initial target: ≥90% branch coverage for first-party vault authorization/state transitions and ≥80% for core domain code, where tooling can measure it accurately. Coverage is supporting evidence, not a substitute for adversarial tests. Do not add meaningless assertions or test generated code to inflate numbers.

Avoid snapshot-only verification. Use visual snapshots for layout changes, alongside behavioral assertions. Keep fixtures deterministic. Do not fix flakes by adding unbounded sleeps or retries; wait on explicit state and investigate races.

### 9.7 CI and release workflow security

- Fast checks on each change; heavier integration/native/security checks on appropriate protected workflows.
- Windows and macOS runners build and test natively; Linux can run server/core jobs.
- Pin actions by immutable revision and dependencies by lockfile/digest where practical.
- CI tokens have minimal permissions. Fork PRs receive no production secrets.
- Do not run untrusted PR code with privileged pull_request_target workflows.
- Signing jobs are separate, protected and explicitly invoked after required checks.
- Produce SBOMs and provenance/checksum artifacts. Verify dependency license compatibility.
- Scan built artifacts as well as source for test hooks, debug endpoints, credentials and unexpected bundled assets.
- Updater verification keys belong in clients; signing private keys never belong in the repository, client or test fixtures.
- Use platform code signing/notarization plus updater artifact signatures; these solve different problems.
- Enable signed-version enforcement if supported by the pinned updater release, and test version/artifact mismatch. A valid signature alone must not permit silent rollback. [T03]
- Keep production update URLs absent/disabled until an authorized endpoint and trust root exist.
- Test updates using a clearly separate development key and channel that production builds do not trust.
- Do not automatically publish artifacts or app-store submissions merely because CI can build them.

## 10. Data model and correctness contracts

### 10.1 Core entities

| Entity | Required conceptual fields |
|---|---|
| Vault | ID, kind, format version, key version, unlock metadata, local/sync state |
| Host | ID, label, endpoint/port/protocol, group, tags, credential references, overrides |
| Group | ID, parent, label, inheritable settings; acyclic hierarchy |
| Identity | ID, username and references to encrypted authentication material |
| Key reference | Algorithm, public fingerprint, origin, exportability, native key handle or encrypted material |
| Known host | Canonical endpoint/hop identity, accepted key/CA, trust source, timestamp |
| Workspace | ID, pane tree, host references, tab labels and safe restoration preferences |
| Snippet | ID, name, text, package, explicit execution/startup policy |
| Tunnel rule | ID, type, host reference, bind/destination, approval state |
| Session | Ephemeral ID, owner window, vault generation, lifecycle, handles and policy |
| Transfer job | ID, endpoints, file grants, progress, cancellation and conflict state |
| Log | ID, session/host reference, encrypted chunks, retention/bookmark metadata |
| Sync outbox | Mutation ID, encrypted payload reference, base revision, retry/cancellation state |
| Device | ID, trusted public identity, status and enrollment/revocation metadata |
| Membership | Vault/account/device authorization, role, revision and key generation |

Conceptual fields are encrypted unless the threat model explicitly approves them as operational metadata. Do not blindly translate the table into plaintext SQL columns.

### 10.2 State and migration rules

- Stable opaque IDs; timestamps are not uniqueness or authorization.
- Explicit schema version and forward-compatibility rejection.
- Foreign-key/reference integrity and acyclic groups; no invisible dangling credentials.
- Deleting a referenced identity prompts for reassignment or explicit removal, never fallback to a different secret.
- Record edits are atomic and emit one versioned event after commit.
- Group inheritance has deterministic precedence, documented unset versus empty semantics and cycle detection.
- Database migrations have preflight validation, recoverable backup/checkpoint and transaction boundaries.
- A newer-format vault is not silently opened by an older client.
- Tombstones distinguish deletion from missing data.
- Active session settings are snapshots; editing a host does not silently retarget an existing session.
- Imported or synced host-trust changes require special review; they are not ordinary invisible settings updates.
- Secret replacement does not keep plaintext undo history.

### 10.3 IPC contract

Every command declares: name, version, caller capability, request schema, bounds, resource scope, vault-unlock requirement, cancellation behavior, response DTO and error codes.

Prefer commands such as host_list, host_save, session_open, session_write, session_resize, session_close, vault_unlock, vault_lock, transfer_start and transfer_cancel. Avoid execute_anything, read_any_file, query_database and decrypt_secret APIs.

Responses contain safe display metadata and opaque handles, not secret-bearing domain objects. Errors use stable codes such as VAULT_LOCKED, HOST_KEY_CHANGED, AUTH_FAILED, ACCESS_DENIED, CONFLICT, CANCELLED, LIMIT_EXCEEDED and IO_ERROR with redacted messages.

Generate client types from authoritative Rust contracts and fail CI on uncommitted drift. TypeScript types do not replace native runtime validation.

## 11. Agent workflow and final deliverables

### 11.1 Daily/iteration loop

1. Read AGENTS.md, docs/progress.md, feature matrix and relevant ADRs.
2. Select the next unblocked vertical slice.
3. Write/update acceptance and negative cases before implementing sensitive behavior.
4. Implement the smallest coherent change.
5. Run relevant unit/integration/native checks; fix failures.
6. Inspect UI using synthetic data when visual behavior changed.
7. Measure performance if the change touches terminal I/O, persistence, rendering or large data.
8. Update feature status, phase report and next task.
9. Make small local commits if repository policy permits; do not include secrets/generated test outputs.
10. Continue automatically.

If blocked, record the exact command/error, missing prerequisite, impact and safe independent work remaining. Avoid vague “needs testing.” Never claim Windows/macOS/mobile support based only on cross-compilation.

### 11.2 Required final handoff

- Runnable source repository with reproducible setup and pinned dependencies.
- Windows/macOS build artifacts where actual runners permit them.
- Mobile artifacts and actual device/simulator test status where available.
- Local self-hostable sync development environment and deployment guide.
- Complete feature matrix retaining all reference IDs and product additions.
- Unit, integration, native, security and performance reports with exact executed commands.
- Threat model, crypto/sync specifications, review findings and unresolved risks.
- Backup/recovery and migration instructions verified against fixtures.
- User guide, design-system notes, screenshots with synthetic data and keyboard reference.
- SBOM/license notices and release-signing/update instructions.
- Clear distinction between implemented, verified, blocked, experimental and out-of-scope features.

### 11.3 Final response format from the implementation agent

Report: what works; how to run it; what was actually tested on each platform; measured performance; artifacts; remaining blockers; review/signing/publication status; and the exact next action.

Do not end with “everything is secure,” “all platforms supported,” or “all tests pass” unless each statement has scoped evidence. Do not ask the owner what to do next while unblocked authorized implementation remains.

**Begin now with Phase 00, then continue to Phase 01 and subsequent unblocked phases.**


## 12. Completeness register and scope decisions

The following appendix retains every one of the 249 research IDs. It is a requirements seed, not an implementation claim. D/R describe competitor evidence only: D = currently documented, R = release-note-derived. Every entry begins NOT_STARTED in our feature matrix unless an existing repository already provides verified evidence.

Expand combined entries into implementation subtasks while retaining their parent ID. Use these CSV columns:

id, title, reference_evidence, source_ids, our_scope, phase, platforms, implementation_paths, test_ids, status, blocker, verified_commit, verified_at

Do not delete research entries to improve completion percentages. Separate the stable-scope completion metric from total research coverage. The scope overrides below take precedence over reproducing competitor behavior.

Public multi-device SSH identity (VID entries) is an optional later extension: explicitly opt in to publishing public keys, avoid exposing private inventory, authenticate device additions, protect publication from substitution, and provide server-side authorized_keys update guidance. Removing a device from the directory does not revoke previously installed public keys. Do not automatically overwrite server authorized_keys or pipe remote scripts into a shell.

App/network discovery, hardware integration and OS-specific visual effects require platform validation. “Native look” does not require adopting every visual effect from a competitor. No location tracking is required.

### 12.1 Complete capability mapping

| Reference ID | Evidence | Capability | Phase / disposition | Reference |
|---|---|---|---|---|
| CON-01 | D | SSH sessions — Saved hostname/IP, port and username. | 03/07 | [S03] |
| CON-02 | D | Password authentication — Interactive or saved credentials. | 03/07 | [S03] |
| CON-03 | D | Private-key authentication — Passphrase-protected keys. | 03/07 | [S03] |
| CON-04 | D | Mosh — Server installation required; command and UDP-range settings. | 07 — Mosh feasibility/compatibility gate. | [S03] |
| CON-05 | D | Telnet — Legacy plaintext protocol. | 07 optional — Legacy plaintext protocol; explicit enable only. | [S03] |
| CON-06 | D | Serial connections — Baud, data bits, stop bits, parity, flow control. | 03/07 | [S03] |
| CON-07 | D | Mobile serial adapters — Supported iOS hardware; Android OTG documented separately. | 14 — Hardware/OS dependent; real adapter tests required. | [S03], [S35] |
| CON-08 | D | Local terminal — Desktop shell/path selection; distribution restrictions apply. | 03/07 | [S03] |
| CON-09 | D | Jump hosts — Multiple SSH hops and reusable host chains. | 03/07 | [S03] |
| CON-10 | D | Network proxies — Authenticated HTTP and SOCKS5. | 03/07 | [S03] |
| CON-11 | D | SSH agent forwarding — Termius's built-in agent; not the system agent. | 03/07 | [S03] |
| CON-12 | D | One-action connection — Open saved hosts without re-entering settings. | 03/07 | [S03] |
| CON-13 | D | Automatic SSH reconnect — Reconnect within the existing terminal tab. | 03/07 | [S44] |
| CON-14 | R | Interactive authentication — OTP/challenge prompts and server authentication banners. | 03/07 | [S33] |
| CON-15 | R | Connection diagnostics — Verbose connection/debug output. | 03/07 | [S33] |
| HST-01 | D | Protocol-specific host settings — SSH, Mosh, SFTP and Telnet configurations. | 04 | [S01] |
| HST-02 | D | Named host records — Readable labels alongside network addresses. | 04 | [S01] |
| HST-03 | D | Nested groups — Organize infrastructure hierarchically. | 04 | [S04] |
| HST-04 | D | Inherited connection settings — Group defaults with host-level overrides. | 04 | [S04] |
| HST-05 | D | Inherited workflow settings — Startup snippets, chains, proxies, environment and appearance. | 04 | [S04] |
| HST-06 | D | Group-wide connection — Open every host in a group. | 04 | [S04] |
| HST-07 | D | Tags — Independent labels across group boundaries. | 04 | [S04] |
| HST-08 | D | Tag filtering — Combine multiple tags as AND conditions. | 04 | [S04] |
| HST-09 | D | Inventory search — Find hosts and tags. | 04 | [S04] |
| HST-10 | D | Bulk movement — Move selected hosts between groups. | 04 | [S04] |
| HST-11 | D | Descendant visibility — Parent groups include nested hosts. | 04 | [S04] |
| HST-12 | R | Host duplication — Copy an existing configuration. | 04 | [S35] |
| HST-13 | R | Inventory presentation — Sorting, multi-selection, host tiles and OS icons. | 04 | [S33] |
| HST-14 | R | LAN discovery — Android network/service discovery. | 04 | [S35] |
| TRM-01 | D | Multiple terminal tabs — Switch among concurrent connections. | 05 | [S43] |
| TRM-02 | R | Tab management — Rename, reorder, duplicate and detach into windows. | 05 | [S33] |
| TRM-03 | R | Terminal search — Search session output. | 05 | [S33] |
| TRM-04 | R | Scrollback and zoom — Review output and resize text. | 05 | [S33] |
| TRM-05 | R | Character encodings — UTF-8 and additional legacy encodings. | 05 | [S33] |
| TRM-06 | R | Terminal emulation choices — Including Linux and VT100 modes. | 05 | [S33] |
| TRM-07 | R | Output highlighting — Keywords and IP addresses. | 05 | [S33] |
| TRM-08 | R | Keyboard customization — Shortcuts, Option/Alt and mouse mappings. | 05 | [S33] |
| TRM-09 | R | Clickable terminal links — OSC 8 hyperlinks. | 05 | [S34] |
| TRM-10 | R | Terminal clipboard integration — OSC 52 support. | 05 | [S34] |
| TRM-11 | R | Unicode input — CJK input fixes/support. | 05 | [S34] |
| TRM-12 | R | Mouse interaction — Terminal mouse-click handling. | 05 | [S35] |
| TRM-13 | R | True-color output — Android release-note evidence. | 05 | [S35] |
| TRM-14 | D | Connection side panel — Access history, snippets and appearance controls. | 05 | [S01] |
| WSP-01 | D | Multi-session workspace — Two or more remote/local sessions. | 05 | [S07] |
| WSP-02 | D | Split layout — Up to 16 terminal panes. | 05 | [S07] |
| WSP-03 | D | Focus layout — One main terminal with session sidebar. | 05 | [S07] |
| WSP-04 | D | Resizable panes — Drag dividers. | 05 | [S07] |
| WSP-05 | D | Reorder sessions — Move panes and tabs. | 05 | [S07] |
| WSP-06 | D | Command broadcasting — Send input to active workspace terminals. | 05 | [S07] |
| WSP-07 | D | Broadcast indicator — Identify the primary input terminal. | 05 | [S07] |
| WSP-08 | D | Named templates — Save reusable session arrangements. | 05 | [S07] |
| WSP-09 | D | Restore layout — Connections, tab names and pane positions. | 05 | [S07] |
| WSP-10 | D | Restore shell context — Directory/command state requires shell integration. | 05 | [S07] |
| WSP-11 | D | Explicit template saving — Unsaved-change indicator. | 05 | [S07] |
| WSP-12 | D | Session status indicators — Unread output, input needed, errors. | 05 | [S07] |
| WSP-13 | D | Workspace shortcuts — Configurable keyboard actions. | 05 | [S07] |
| AUT-01 | D | History suggestions — Reuse previous shell commands. | 08/13 | [S10] |
| AUT-02 | D | Path completion — Suggest remote files/directories. | 08/13 | [S10] |
| AUT-03 | D | Command/argument suggestions — Built-in command knowledge and descriptions. | 08/13 | [S10] |
| AUT-04 | D | Snippet suggestions — Match saved snippet names/content. | 08/13 | [S08] |
| AUT-05 | D | Credential suggestions — Identity passwords at appropriate prompts. | 08 changed — User-invoked credential insertion; no spoofable prompt-based auto-submit. | [S10] |
| AUT-06 | D | Shell-context awareness — Track prompt, current directory and command. | 08/13 | [S10] |
| AUT-07 | D | Supported shell integration — Local Bash/Zsh; remote Bash with compatible OpenSSH. | 08/13 | [S10] |
| AUT-08 | D | Natural-language commands — Describe an action to generate shell commands. | 08/13 | [S01] |
| AUT-09 | D | AI snippet drafting — Generate a snippet from instructions. | 08/13 | [S08] |
| AUT-10 | D | Mobile AI prompt widget — Selected-output context, editable commands and prompt history. | 08/13 | [S12] |
| AUT-11 | D | Voice command drafting — Mobile dictation input. | 08/13 | [S12] |
| AUT-12 | R | Pause autocomplete — Temporary/session controls. | 08/13 | [S33] |
| AUT-13 | R | CLI-agent launcher templates — Launch tools such as Claude/Gemini/OpenCode; not embedded agents. | 13 optional — Only explicit user-configured external CLI launchers; no bundled subscriptions. | [S34] |
| SNP-01 | D | Named multiline snippets — Reusable command sequences. | 08 | [S08] |
| SNP-02 | D | Snippet packages — Group scripts in folders. | 08 | [S08] |
| SNP-03 | D | Terminal-side editing — Create/edit without leaving the session. | 08 | [S08] |
| SNP-04 | D | Run or paste — Execute immediately or insert for review. | 08 | [S08] |
| SNP-05 | D | Multi-host execution — Launch scripts across chosen hosts. | 08 | [S08] |
| SNP-06 | D | Saved execution targets — Reuse host selections. | 08 | [S08] |
| SNP-07 | D | Existing-session execution — Run across open sessions. | 08 | [S08] |
| SNP-08 | D | Startup scripts — Per-host defaults inherited from groups. | 08 | [S08] |
| SNP-09 | D | Snippet sharing — Store in personal/team vaults. | 08 | [S08] |
| SNP-10 | D | Snippet organization — Move/copy snippets and packages. | 08 | [S08] |
| SNP-11 | D | Host environment variables — Per-host name/value pairs. | 08 | [S09] |
| SNP-12 | D | Inherited environment variables — Group defaults with host overrides. | 08 | [S09] |
| SNP-13 | D | SSH variable delivery — Requires server AcceptEnv configuration. | 08 | [S09] |
| SNP-14 | D | Environment-aware scripts — Reference available variables from snippets. | 08 | [S09] |
| FIL-01 | D | SFTP browser — Desktop and mobile. | 06 | [S05] |
| FIL-02 | D | Two-pane file manager — Desktop; local or remote endpoints. | 06 | [S05] |
| FIL-03 | D | Upload/download — Files and folders. | 06 | [S05] |
| FIL-04 | D | Remote-to-remote copying — Through the client workflow. | 06 | [S05] |
| FIL-05 | D | Drag-and-drop transfer — Between panes or from the desktop. | 06 | [S05] |
| FIL-06 | D | Transfer destination selection — Context-menu copying. | 06 | [S05] |
| FIL-07 | D | Directory navigation — Refresh, hidden files, desktop path entry. | 06 | [S05] |
| FIL-08 | D | Transfer monitoring — Progress, failures, conflict handling. | 06 | [S05] |
| FIL-09 | D | Name conflicts — Replace or retain both copies. | 06 | [S05] |
| FIL-10 | D | Terminal/SFTP switching — Reuse the selected host. | 06 | [S05] |
| FIL-11 | D | Desktop external editing — Download, edit, detect changes, re-upload. | 06 | [S05] |
| FIL-12 | D | Editor associations — Choose editors by file type. | 06 | [S05] |
| FIL-13 | D | Mobile file tabs — Multiple SFTP locations. | 06 | [S05] |
| FIL-14 | D | iOS editing — Open downloaded files externally; manually upload changes. | 06 | [S05] |
| FIL-15 | D | Android editing — Terminal editor commands or local download/edit. | 06 | [S05] |
| FIL-16 | D | iOS Files integration — Drag/drop files between apps/windows. | 06 | [S05] |
| FIL-17 | R | Mobile previews — Including iOS audio/video. | 06 | [S34] |
| FIL-18 | D | Terminal attachment upload — Paste/drop a file; insert remote path. | 06 | [S12] |
| FWD-01 | D | Local forwarding — Local listener to remote destination. | 07 | [S06] |
| FWD-02 | D | Remote forwarding — Remote listener to reachable destination. | 07 | [S06] |
| FWD-03 | D | Dynamic forwarding — SOCKS proxy over SSH. | 07 | [S06] |
| FWD-04 | D | Saved forwarding rules — Names, hosts, destinations and ports. | 07 | [S06] |
| FWD-05 | D | Forwarding rule lifecycle — Start, stop and inspect active rules. | 07 | [S06] |
| FWD-06 | D | Configuration wizard — Guided setup or compact form. | 07 | [S06] |
| FWD-07 | R | Listener bind configuration — Address-selection controls. | 07 | [S34] |
| FWD-08 | R | Rule duplication — Copy existing tunnel settings. | 07 | [S33] |
| FWD-09 | R | Chained/proxied tunnels — iOS release-note evidence. | 07 | [S34] |
| KEY-01 | D | Key import — File or pasted text; validate format. | 04/07 | [S13] |
| KEY-02 | D | Key generation — Ed25519, ECDSA, RSA and ML-DSA. | 04/07 — Only validated algorithms; ML-DSA requires actual library/server compatibility. | [S13] |
| KEY-03 | D | Private-key passphrases — Unlock and optionally remember. | 04/07 | [S13] |
| KEY-04 | D | Key labels — Reusable key records. | 04/07 | [S13] |
| KEY-05 | D | Public-key deployment — Install authorized_keys; configurable path/file. | 04/07 | [S13] |
| KEY-06 | D | Attach deployed key — Associate with host authentication. | 04/07 | [S13] |
| KEY-07 | D | SSH certificates — Import certificates paired with private keys. | 04/07 | [S13] |
| KEY-08 | D | FIDO2 keys — Hardware-backed SSH authentication; compatible devices required. | 04/07 | [S13] |
| KEY-09 | D | Security-key policies — PIN and user-presence settings. | 04/07 | [S13] |
| KEY-10 | R | Resident security keys — Import support recorded on desktop. | 04/07 | [S33] |
| KEY-11 | D | Device-bound keys — Windows TPM/Hello, Apple Secure Enclave, Android Keystore. | 07/14 — Prove hardware signing per platform; do not conflate with vault unlock. | [S13] |
| KEY-12 | D | Biometric authentication — Platform-supported biometric approval. | 02/07/14 — Separate biometric unlock and SSH signing. | [S13] |
| KEY-13 | D | Non-exportable device keys — Remain on their originating device. | 07/14 — Hardware keys cannot be exported or synced. | [S13] |
| KEY-14 | R | Additional key formats — PuTTY PPK v3. | 04/07 | [S33] |
| KEY-15 | D | Reusable identities — Label, username, password, key/certificate references. | 04/07 | [S14] |
| KEY-16 | D | Shared identity updates — Referenced hosts/groups inherit credential changes. | 04/07 | [S14] |
| KEY-17 | D | Identity selection — Choose credentials from accessible vaults. | 04/07 | [S14] |
| KEY-18 | D | Privilege-prompt assistance — Identity password autofill for sudo prompts. | 04/07 | [S14] |
| VID-01 | D | Public SSH identity — One handle represents multiple device public keys. | 11 extension | [S20] |
| VID-02 | D | Public-key publication — Retrieve keys using the identity URL. | 11 extension | [S20] |
| VID-03 | D | Device enrollment — Add device-specific keys. | 11 extension | [S21] |
| VID-04 | D | Hardware-key enrollment — Include compatible FIDO2 keys. | 11 extension | [S21] |
| VID-05 | D | Automatic key choice — Use the current device's matching key. | 11 extension | [S21] |
| VID-06 | D | Server installation — Manual copy or URL-based retrieval. | 11 extension | [S21] |
| VID-07 | D | Algorithm selection — Choose compatible published key variants. | 11 extension | [S21] |
| VID-08 | D | Device removal — Remove a device from identity management. | 11 extension | [S21] |
| VID-09 | D | Key rotation — Replace/re-enroll device keys. | 11 extension | [S21] |
| VID-10 | D | Identity deletion — Remove the published identity. | 11 extension | [S21] |
| VID-11 | D | Private-key locality — Private material stays on devices. | 11 extension | [S22] |
| VID-12 | D | Signed public-key identity — Documented integrity design; verifier UX needs validation. | 11 extension | [S22] |
| VLT-01 | D | Local vault — Free local storage mode. | 02/10/11 | [S02] |
| VLT-02 | D | Logged-out operation — Local use supported; onboarding still promotes account creation. | 02/10/11 | [S40] |
| VLT-03 | D | Personal cloud vault — Sync personal connection data. | 02/10/11 | [S16] |
| VLT-04 | D | Cross-device sync — Desktop and mobile. | 02/10/11 | [S16] |
| VLT-05 | D | Shared default vault — Team-accessible connection data. | 02/10/11 | [S16] |
| VLT-06 | D | Multiple team vaults — Separate access boundaries. | 02/10/11 | [S16] |
| VLT-07 | D | Vault-contained records — Hosts, groups, credentials, snippets, tunnels, known hosts. | 02/10/11 | [S01] |
| VLT-08 | D | Offline cached data — Use locally available encrypted vault contents. | 02/10/11 | [S26] |
| VLT-09 | D | End-to-end encryption — Personal and shared vault encryption. | 02/10/11 | [S26] |
| VLT-10 | D | Separate vault keys — Independent keys for shared vaults. | 02/10/11 | [S26] |
| VLT-11 | D | Credential-sync opt-out — Keep personal keys/passwords local while other data syncs. | 10 changed — Per-vault/credential sync scope; logout preserves local data. | [S15] |
| VLT-12 | D | Personal credentials for shared hosts — Avoid sharing the same authentication secret. | 02/10/11 | [S15] |
| VLT-13 | D | Copy/move vault records — Move entries with related dependencies. | 02/10/11 | [S17] |
| VLT-14 | D | Vault renaming — Rename custom team vaults. | 02/10/11 | [S17] |
| COL-01 | D | Team invitations — Invite, accept, then grant data access. | 11 | [S18] |
| COL-02 | D | Team membership management — Add/remove members; change team name. | 11 | [S18] |
| COL-03 | D | Ownership transfer — Assign another team owner. | 11 | [S18] |
| COL-04 | D | Enforced account MFA — Team policy and compliance visibility. | 11 | [S18] |
| COL-05 | D | Per-vault membership — Grant and revoke vault access. | 11 | [S17] |
| COL-06 | D | Vault access roles — View or edit stored configuration. | 11 | [S17] |
| COL-07 | D | Shared credential option — Distribute credentials through encrypted vaults. | 11 | [S17] |
| COL-08 | D | Live terminal sharing — Teammates observe terminal output. | 11 | [S43] |
| COL-09 | D | Shared terminal control — Collaborative command entry. | 11 | [S43] |
| COL-10 | D | Single active controller — Control changes between participants. | 11 | [S45] |
| COL-11 | R | Participant visibility — Presence list and control-transfer interface. | 11 | [S33] |
| COL-12 | R | Session sharing lifecycle — Stop sharing; disconnect guests. | 11 | [S33] |
| LOG-01 | D | Session recording — SSH, local terminal, serial and Telnet; excludes Mosh. | 08/11 | [S11] |
| LOG-02 | D | Latest-session retention — Latest log per host. | 08/11 | [S11] |
| LOG-03 | D | Bookmark retention — Keep selected sessions beyond rotation. | 08/11 | [S11] |
| LOG-04 | D | Log comments — Annotate bookmarked sessions. | 08/11 | [S11] |
| LOG-05 | D | Log organization — Date/bookmark ordering and vault filtering. | 08/11 | [S11] |
| LOG-06 | D | Log viewing — Open in a desktop tab/workspace. | 08/11 | [S11] |
| LOG-07 | R | Log search — Desktop release-note evidence. | 08/11 | [S33] |
| LOG-08 | D | Encrypted log sync — Across devices. | 08/11 | [S11] |
| LOG-09 | D | Mobile recording — Records/syncs; viewing currently requires desktop. | 14 changed — Mobile viewing is desirable if safely implemented; competitor limit is not ours. | [S11] |
| LOG-10 | D | Per-vault logging switch — Disabling also deletes existing logs. | 08 changed — Stop recording and delete existing logs are separate actions. | [S11] |
| LOG-11 | D | Shared team logs — Latest session per host per member. | 08/11 | [S19] |
| LOG-12 | D | Role-aware annotations — Editors annotate; viewers read. | 08/11 | [S19] |
| LOG-13 | D | Owner attribution — Multiplayer logs belong to session owner. | 08/11 | [S19] |
| LOG-14 | D | Enterprise retention option — Custom retention advertised; configuration details unverified. | 08/11 changed — Configurable retention without a paid entitlement. | [S02] |
| IMP-01 | D | OpenSSH configuration import — Select hosts, keys and known-host records. | 04/12 | [S32] |
| IMP-02 | D | Jump-host conversion — Supported config chains; ProxyCommand ignored. | 04/12 | [S32] |
| IMP-03 | D | CSV host import — Groups, tags, protocols, ports and credentials. | 04/12 | [S32] |
| IMP-04 | D | PuTTY migration — Sessions, tunnels and keys; registry/.reg workflows. | 04/12 | [S32] |
| IMP-05 | D | MobaXterm migration — Session/folder/tunnel configuration, including encrypted exports. | 04/12 | [S32] |
| IMP-06 | D | SecureCRT migration — Host/group/credential XML, including encrypted exports. | 04/12 | [S32] |
| IMP-07 | D | AWS discovery — EC2 and Lightsail. | 04/12 | [S23] |
| IMP-08 | D | AWS import settings — Region, address type, DNS labels and tags. | 04/12 | [S23] |
| IMP-09 | D | DigitalOcean discovery — Droplets; public IP with private fallback. | 04/12 | [S24] |
| IMP-10 | D | Azure discovery — Virtual machines with public IPs. | 04/12 | [S25] |
| IMP-11 | D | Inventory reconciliation — Cloud additions/changes/removals update groups. | 04/12 | [S23], [S24], [S25] |
| IMP-12 | D | Integration credentials — Read-only access; stored on configuring device. | 04/12 | [S23], [S24], [S25] |
| IMP-13 | D | Integration targeting — Attach provider inventory to selected groups. | 04/12 | [S04] |
| SEC-01 | R | Known-host management — Saved fingerprints and changed-key handling. | 02–15 | [S33] |
| SEC-02 | R | Readable fingerprints — SHA-256 fingerprint display. | 02–15 | [S33] |
| SEC-03 | R | Known-host conversion — Create host entries from trusted records. | 02–15 | [S33] |
| SEC-04 | D | Encrypted local cache — Encrypted vault records stored on device. | 02–15 | [S26] |
| SEC-05 | D | OS secret-store integration — Platform key storage; documented fallback warrants review. | 02–15 | [S26] |
| SEC-06 | D | Password-protected vault keys — Encryption password protects access to vault material. | 02–15 | [S26] |
| SEC-07 | D | Password-authenticated login — Documented modified SRP exchange. | 02–15 | [S26] |
| SEC-08 | D | Hybrid post-quantum SSH — ML-KEM/X25519 with compatible servers. | 02–15 | [S27] |
| SEC-09 | D | Additional PQ algorithms — ML-KEM variants and ML-DSA signatures. | 02–15 | [S27] |
| SEC-10 | D | Compatibility controls — Disable PQ features when necessary. | 02–15 | [S27] |
| SEC-11 | D | Compromised-password detection — Breach check using a hash-prefix lookup. | 02–15 | [S41] |
| SEC-12 | R | Mobile app locking — iOS PIN; Android PIN/pattern/fingerprint. | 02–15 | [S34], [S35] |
| SEC-13 | R | App-switcher privacy — iOS content blur. | 02–15 | [S34] |
| SEC-14 | D | Activity auditing — Team activity auditing described by vendor. | 02–15 | [S28] |
| SEC-15 | D | Security assurance materials — SOC 2 Type II report access; organizational process. | Process — Prepare evidence/report handling; do not claim external certification. | [S28] |
| ACC-01 | D | Account profile — Name, email and encryption-password changes. | 10/11 | [S29] |
| ACC-02 | D | Two-factor authentication — Authenticator/Authy options; IdP-specific rules. | 10/11 | [S29] |
| ACC-03 | D | Federated account login — Apple/Google sign-in references. | 10/11 | [S29] |
| ACC-04 | D | Device inventory — Device sessions and last activity. | 10/11 | [S29] |
| ACC-05 | D | Remote sign-out — One device or all; needs connectivity. | 10/11 | [S29] |
| ACC-06 | D | Account deletion — Restoration window documented. | 10/11 | [S29] |
| ACC-07 | D | Email preferences — Activity summaries, frequency and timezone. | 10/11 | [S29] |
| ACC-08 | D | SAML-based SSO — Organization identity-provider integration. | 10/11 | [S30] |
| ACC-09 | D | Provider configuration — WorkOS-supported IdPs and custom configuration. | 10/11 | [S30] |
| ACC-10 | D | SSO rollout controls — Test/hybrid access, enforcement and domain configuration. | 10/11 | [S30] |
| ACC-11 | D | Separate vault unlock — SSO authentication still requires encryption password. | 10/11 | [S30] |
| ACC-12 | D | Consolidated team billing — Seat-based subscription administration. | Excluded — No subscription/consolidated billing implementation. | [S31] |
| ACC-13 | D | Billing records — Invoices, receipts, business/tax details. | Excluded — No payment invoices or tax processing. | [S31] |
| ACC-14 | D | Subscription lifecycle — Monthly/annual, upgrades and cancellation. | Excluded — No paid subscription lifecycle. | [S31] |
| ACC-15 | D | Enterprise service options — Custom billing, support, onboarding and SLA. | Process — Support/SLA/onboarding are operational choices, not paid feature gates. | [S02] |
| ACC-16 | D | Education access — GitHub student eligibility workflow. | Excluded — No education entitlement needed for a fully free product. | [S29] |
| MOB-01 | D | Extra keyboard row — Ctrl, Esc, Tab, arrows and function keys. | 14 | [S12] |
| MOB-02 | D | Keyboard customization — Reorder button groups. | 14 | [S12] |
| MOB-03 | D | Touch cursor control — Arrow gestures and trackpad behavior. | 14 | [S12] |
| MOB-04 | D | Gesture text controls — Double-tap Tab and pinch font sizing. | 14 | [S12] |
| MOB-05 | D | Selection and clipboard — Touch selection, copy/paste. | 14 | [S12] |
| MOB-06 | D | Hardware keyboards — Bluetooth/USB, modifier remapping and repeat settings. | 14 | [S12] |
| MOB-07 | D | Volume-button shortcuts — Map physical volume controls. | 14 | [S12] |
| MOB-08 | D | Per-host appearance — Theme, font and size. | 14 | [S12] |
| MOB-09 | D | History actions — Run, paste or save as snippet. | 14 | [S12] |
| MOB-10 | D | Keyboard visibility — Hide onscreen keyboard when appropriate. | 14 | [S12] |
| MOB-11 | D | iPad multitasking — Work with multiple terminal windows. | 14 | [S47] |
| MOB-12 | R | Adaptive navigation — Phone navigation and tablet tab layouts. | 14 | [S34] |
| MOB-13 | R | Live Activities — iOS connection/tunnel status. | 14 | [S34] |
| MOB-14 | R | Terminal font presets — Nerd-font glyph support. | 14 | [S34] |
| MOB-15 | R | Accessibility navigation — iOS full-keyboard access. | 14 | [S34] |
| MOB-16 | R | Additional gestures — Android shake/volume shortcuts. | 14 | [S35] |
| MOB-17 | R | Application themes — Android light/dark/black variants. | 14 | [S35] |
| MOB-18 | D | Connection location history — Optional iOS tracking; background-use implications. | Excluded — No location tracking to prolong background execution. | [S39] |
| UX-01 | D | Desktop distribution — Windows, macOS and Linux. | 05/09/14 | [S45] |
| UX-02 | D | Mobile distribution — Android, iOS and iPadOS. | 05/09/14 | [S45] |
| UX-03 | R | Command palette — Quick actions and host/tab search. | 05/09/14 | [S33] |
| UX-04 | D | Recent connections — Quick reopening from the new-tab screen. | 05/09/14 | [S07] |
| UX-05 | R | Update controls — User-triggered desktop updating. | 05/09/14 | [S33] |
| UX-06 | D | In-app feature areas — Hosts, vaults, keychain, tunnels, snippets, known hosts, logs. | 05/09/14 | [S45] |
| UX-07 | D | Commercial-use free tier — Starter permits commercial use. | License — License must permit commercial use; no entitlement service. | [S02] |


### 12.2 Requested/unverified competitor features

These are Track E backlog entries. Do not assert that Termius ships them, and do not add them to the initial stable release without an ADR, security assessment and tests.

| ID | Capability | Disposition |
|---|---|---|
| Q-01 | RDP | Later protocol adapter; separate security/UX scope |
| Q-02 | X11 forwarding | Later; assess local display exposure |
| Q-03 | Arbitrary ProxyCommand | Excluded initially; imported commands must not run |
| Q-04 | System SSH agent | Optional Phase 07 adapter with explicit authorization |
| Q-05 | Google Cloud inventory | Later provider using the Phase 12 adapter contract |
| Q-06 | Kubernetes connections | Later; cluster credentials and command execution need separate policy |
| Q-07 | SSH compression controls | Later if library-supported and benchmarked |
| Q-08 | Custom font import | Later; validate font handling/license and fallback |
| Q-09 | User-created themes | Later data-only theme format; no executable CSS/JS plugins |
| Q-10 | Regex highlighting | Later with bounded/safe matching; prevent regex denial of service |
| Q-11 | Parameterized snippets | Later typed input/preview; never claim shell escaping is universal |
| Q-12 | Scheduled snippets | Excluded initially; background execution needs separate consent model |
| Q-13 | Synced shell initialization/aliases | Later; never automatically install executable remote configuration |
| Q-14 | JIT short-lived certificates | Later integration with an established SSH CA |
| Q-15 | PAM/CyberArk integrations | Later enterprise adapters with real integration evidence |
| Q-16 | New-device alerts | Phase 10 local/in-app alerts; outbound email requires configured consent |
| Q-17 | One-time host sharing | Later; distinguish shared metadata from irrevocably disclosed credentials |
| Q-18 | More importers/localization/Jira | Separate backlog items; no unrelated issue-tracker dependency |
| Q-19 | Multiple accounts | Later; strict separate profiles and credential boundaries |
| Q-20 | Ask-for-help workflow | Later layer over verified Phase 11 sharing |
| Q-21 | API bridge/Ansible/host registration | Availability ambiguous; our public automation API requires separate auth design |
| Q-22 | Vanta/approved domains | Vanta later; domain controls through trusted identity configuration |
| Q-23 | Full vault export/restore | Required for our product in Phase 02/04 regardless of competitor evidence |
| Q-24 | Advanced file management | CRUD/permissions/default directory in Phase 06; resume/checksum/folder sync separately gated |
| Q-25 | FTP/FTPS/SCP/VNC/browser SSH | Not baseline scope; no browser terminal gateway by default |
| Q-26 | Plugin SDK/task hooks | Excluded initially; arbitrary plugins expand the trusted code base |

Reference requests: [S36], [S37]. Pricing ambiguity for bridge/Ansible/Vanta: [S02]. Treat the request boards as potentially stale.

### 12.3 Historical capabilities

| ID | Historical item | Our decision |
|---|---|---|
| H-01 | MultiKey | Do not reproduce a retired identity model; consider the scoped VID extension |
| H-02 | Archived Termius CLI | Optional future local CLI; never assume that project is maintained |
| H-03 | Port knocking | Excluded initially; later only with a justified use case |
| H-04 | SOCKS4 | Use SOCKS5 baseline; no automatic downgrade |
| H-05 | Apple Shortcuts snippet actions | Later mobile integration; explicit app unlock and execution policy |

References: [S33], [S34], [S35], [S42].

### 12.4 Required product additions carried forward

| ID | Addition | Phase |
|---|---|---|
| P-01 | Account-free first launch | 02 |
| P-02 | Explicit cloud opt-in | 10 |
| P-03 | Open-source sync server | 10 |
| P-04 | Self-hosted endpoint | 10 |
| P-05 | Per-vault synchronization scope | 10 |
| P-06 | Pending/error/conflict synchronization visibility | 10 |
| P-07 | Encrypted backup and restore | 02 |
| P-08 | Explicit recovery model | 02/10 |
| P-09 | Trusted device enrollment | 10 |
| P-10 | Vault locking and optional platform quick unlock | 02 |
| P-11 | Safe failure when OS secret storage is unavailable | 02 |
| P-12 | Strict host-key verification | 03 |
| P-13 | Broadcast target review | 05 |
| P-14 | Paste/snippet review | 05/08 |
| P-15 | Terminal escape permissions | 03/05 |
| P-16 | Private logs with separate retention/export/deletion | 08 |
| P-17 | Optional AI with context/consent controls | 13 |
| P-18 | Explicit sharing boundaries | 11 |
| P-19 | Signed delivery and dependency transparency | 09/15 |
| P-20 | Accessibility | Every UI phase |
| P-21 | Versioned portable data formats | 02/04/10 |
| P-22 | Separate privacy/diagnostics consent | 02/09 |
| P-23 | Command-finished notifications for background sessions | 05 |
| P-24 | Quick port forward from detected listening ports | 06 |
| P-25 | Paste safety: hidden control characters and named target | 05 |
| P-26 | Production host guardrails | 04/05 |
| P-27 | Security review of keys, sign-in methods, certificates and known hosts | 04 |
| P-28 | Search across all open sessions | 05 |
| P-29 | Save or copy one command's output | 05 |
| P-30 | Encrypted host and group notes | 04 |
| P-31 | tmux and screen session awareness | 05 |
| P-32 | Server at a glance: uptime, load, memory and disk | 05 |
| P-33 | Container shells on the connected host | 05 |

P-23 to P-33 were added at the owner's request on 2026-10-12 ([docs/decisions/0011-owner-feature-additions.md](docs/decisions/0010-owner-feature-additions.md)).

## 13. Additional hardening details and decision rules

- Centralize initial input limits: 256-byte display labels, 1-MiB imported key/snippet payloads, 64-KiB terminal input chunks, 1-MiB encrypted sync records and 4-MiB mutation request bodies. Use chunked APIs for larger content. Validate protocol-specific endpoint limits separately; do not truncate identifiers or secrets to fit a limit.
- Bound imports to 50 MiB and 100,000 records per job initially, with streaming parsing, preview and cancellation. Bound nesting depth and archive expansion independently. Any limit change needs a measured workload and abuse test.
- Store a versioned allowlisted KDF profile rather than honoring arbitrary file-supplied cost values. Initial supported profile is the stated 64-MiB/3-iteration/parallelism-1 baseline; additional stronger profiles require benchmarks and explicit compatibility tests.
- Distinguish application-controlled outbound traffic from OS/WebView maintenance. Network tests must identify the responsible process and endpoint; do not promise control over unrelated operating-system traffic.
- Apply restrictive OS permissions to app data, vaults, backup staging and temporary files: user-only Unix permissions and equivalent Windows ACLs. Do not assume Unix chmod secures Windows data.
- Use platform application-data directories, never repository cwd or a shared temp directory for persistent secrets.
- Verify atomic-write and durability assumptions: flush required data/metadata, rename safely, preserve a recoverable previous state and exercise forced termination.
- A writable filesystem/keystore failure must not produce a plaintext fallback.
- Avoid pretending compression guarantees privacy: bound decompression, cap declared lengths and reject expansion bombs in imports, backups, sync and recordings.
- Remote file previews must not execute active HTML/SVG/scripts or contact embedded remote resources. Prefer text/hex previews or explicitly launching a selected external viewer with clear context.
- Sensitive operations use confirmation windows bound to the actual resource/revision. A stale approval cannot authorize a changed target.
- Deep-link handlers accept only documented routes with bounded parameters. No terminal execution, secret retrieval or host trust changes through a link. Authentication callbacks validate their pending request state.
- User-selected private/LAN SSH destinations are legitimate functionality. Preventing accidental network access is about explicit intent and scope, not banning all private addresses.
- Do not equate “no telemetry” with “no network”: requested SSH/SFTP/tunnels, enabled sync and approved AI each have distinct network purposes shown in privacy settings.
- Retry only idempotent operations automatically. Command execution, file overwrite, membership change and credential deployment need operation-specific replay safeguards.
- On unsupported hardware/OS operations, explain the limitation and preserve data. Never emulate hardware-backed signing with a software key while retaining the same security label.
- Test Unicode display deception in host labels and command targets. Show canonical destination information in trust and high-risk execution dialogs.
- Do not overengineer a generic plugin or workflow language before shipping local SSH. Extract abstractions from actual repeated implementations.
- Profile before introducing caches. Every cache has an owner, byte/entry limit, invalidation policy and lock behavior.
- Use feature flags for experimental scope, not hidden license restrictions. Release packaging must make enabled flags inspectable.
- No public stable release while a required security test fails or a material crypto/authorization review is unresolved. Continue fixing and preparing local artifacts autonomously.

## 14. Primary technical references

Re-check relevant official documentation and advisories when pinning/upgrading dependencies. The build prompt's numeric budgets and product policies are our requirements, not claims made by these sources.

- [T01] [Tauri capabilities](https://v2.tauri.app/security/capabilities/) and [runtime authority](https://v2.tauri.app/security/runtime-authority/) — IPC/window boundaries.
- [T02] [Tauri native WebDriver testing](https://v2.tauri.app/develop/tests/webdriver/) — current platform/test integration.
- [T03] [Tauri updater](https://v2.tauri.app/plugin/updater/) and [CLI release notes](https://v2.tauri.app/release/%40tauri-apps/cli/) — signing/version-verification behavior.
- [T04] [xterm.js security guidance](https://xtermjs.org/docs/guides/security/) — renderer and terminal-content threats.
- [T05] [russh client handler](https://docs.rs/russh/latest/russh/client/trait.Handler.html) — server-key trust callback.
- [T06] [russh-sftp](https://docs.rs/russh-sftp/latest/russh_sftp/) — SFTP adapter capabilities.
- [T07] [portable-pty](https://docs.rs/crate/portable-pty/latest) — native PTY interface.
- [T08] [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252) — OAuth for native apps.
- [T09] [XChaCha20-Poly1305 guidance](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction) — primitive properties, not approval of our vault protocol.
- [T10] [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — KDF guidance; local vault threat model still needs its own tuning.
- [T11] [RustCrypto AEAD implementations](https://github.com/RustCrypto/AEADs) — inspect the selected crate/version and audit scope.
- [T12] [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) — platform SDK and mobile build requirements.

## 15. Competitor research references

Research baseline: Termius public documentation/product pages/release notes, October 11, 2026. Reconfirm any feature needed for interoperability; do not copy proprietary implementation or assume identical platform support.

- [S01] [Product overview](https://docs.termius.com/getting-started/what-is-termius)
- [S02] [Pricing and plan comparison](https://www.termius.com/pricing)
- [S03] [Server connections](https://docs.termius.com/organize-and-connect-to-hosts/connecting-to-a-server)
- [S04] [Groups and tags](https://docs.termius.com/organize-and-connect-to-hosts/groups-and-tags)
- [S05] [SFTP](https://docs.termius.com/organize-and-connect-to-hosts/managing-files-with-sftp)
- [S06] [Port forwarding](https://docs.termius.com/organize-and-connect-to-hosts/port-forwarding-and-tunneling)
- [S07] [Workspaces](https://docs.termius.com/terminal/workspaces)
- [S08] [Snippets](https://docs.termius.com/terminal/snippets)
- [S09] [Environment variables](https://docs.termius.com/terminal/environment-variables)
- [S10] [Autocomplete and shell integration](https://docs.termius.com/terminal/autocomplete-and-shell-integration)
- [S11] [Session logs](https://docs.termius.com/organize-and-connect-to-hosts/session-logs)
- [S12] [Mobile terminal](https://docs.termius.com/terminal/mobile-terminal)
- [S13] [SSH keys and certificates](https://docs.termius.com/keychain/ssh-keys-and-certificates)
- [S14] [Identities](https://docs.termius.com/keychain/identities)
- [S15] [Credential sync controls](https://docs.termius.com/keychain/sync-of-keys-and-passwords)
- [S16] [Vault concepts](https://docs.termius.com/getting-started/learn-about-vaults)
- [S17] [Team vaults](https://docs.termius.com/team-collaboration/team-vaults)
- [S18] [Team management](https://docs.termius.com/team-collaboration/team-management)
- [S19] [Team session logs](https://docs.termius.com/team-collaboration/team-session-logs)
- [S20] [SSH ID overview](https://docs.termius.com/ssh-id-passkeys-for-ssh/what-is-ssh-id)
- [S21] [SSH ID setup](https://docs.termius.com/ssh-id-passkeys-for-ssh/setup-and-usage)
- [S22] [SSH ID security](https://docs.termius.com/ssh-id-passkeys-for-ssh/ssh-id-security)
- [S23] [AWS integration](https://docs.termius.com/integrations/aws)
- [S24] [DigitalOcean integration](https://docs.termius.com/integrations/digitalocean)
- [S25] [Azure integration](https://docs.termius.com/integrations/microsoft-azure)
- [S26] [Encryption overview](https://docs.termius.com/security/encryption-overview)
- [S27] [Post-quantum cryptography](https://docs.termius.com/security/post-quantum-cryptography)
- [S28] [Compliance](https://docs.termius.com/security/compliance)
- [S29] [Account management](https://docs.termius.com/administration/account-management)
- [S30] [SAML SSO](https://docs.termius.com/administration/saml-sso)
- [S31] [Billing and plans](https://docs.termius.com/administration/billing-and-plans)
- [S32] [Import hosts](https://docs.termius.com/getting-started/import-existing-hosts)
- [S33] [Desktop release notes](https://docs.termius.com/changelog/desktop)
- [S34] [iOS release notes](https://docs.termius.com/changelog/ios)
- [S35] [Android release notes](https://docs.termius.com/changelog/android)
- [S36] [Public feature requests](https://ideas.termius.com/)
- [S37] [Team feature requests](https://ideas.teams.termius.com/)
- [S38] [Default SFTP path FAQ](https://docs.termius.com/help-center/faq/how-to-set-a-default-sftp-path)
- [S39] [iOS background sessions FAQ](https://docs.termius.com/help-center/faq/how-can-i-keep-termius-sessions-alive-in-the-background-on-ios-ipados)
- [S40] [Local use and account FAQ](https://docs.termius.com/help-center/faq/why-am-i-required-to-create-an-account)
- [S41] [Leaked-password detection FAQ](https://docs.termius.com/help-center/faq/how-does-termius-detect-a-leaked-encryption-password)
- [S42] [Archived Termius CLI](https://github.com/termius/termius-cli)
- [S43] [Windows product page](https://termius.com/free-ssh-client-for-windows)
- [S44] [Automatic reconnect](https://termius.com/blog/stay-connected-with-auto-reconnect)
- [S45] [Termius homepage](https://termius.com/)
- [S46] [Android product page](https://www.termius.com/free-ssh-client-for-android)
- [S47] [iPad product page](https://termius.com/free-ssh-client-for-ipad)

End of build prompt. Execute from Section 0 and Phase 00; retain this document and the feature IDs throughout implementation.

