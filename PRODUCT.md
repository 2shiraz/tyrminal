# Tyrminal

<!-- impeccable:product-schema 1 -->

## Platform

web

The interface runs in a Tauri desktop WebView. This is an existing React/TypeScript application with a Rust core, not a hosted website. Windows and macOS are primary targets; Linux also has CI coverage. Mobile is not implemented.

## Users

Developers, DevOps engineers, system administrators, students, and occasional SSH users. Their primary job is to find a destination, connect with explicit trust, and work in a responsive terminal.

## Product Purpose

A local-first SSH application with an encrypted local vault, local shells, terminal workspaces, and contextual file management. Local use needs no account or vendor connection.

## Capabilities and Constraints

Implemented surfaces include hosts/groups/favorites/imports, keys/identities/known hosts, SSH and local sessions, Telnet/serial, tabs/splits/layouts, SFTP/transfers, tunnels/jump hosts/proxies, snippets, command history/recordings, notes, and settings. Implementation is not platform verification: docs/feature-matrix.csv owns evidence.

Sync, team accounts, live sharing, AI, and mobile are future scope. Do not add dead navigation or imply these are available. Cryptography has not been independently reviewed; no stable-release security claim is authorized.

## Operating Context

Long desktop working sessions, keyboard-first navigation, system window controls, high-DPI text, and potentially high-volume terminal output. Synthetic fixtures and disposable local data only during development.

## Brand Commitments

Tyrminal; concise, specific, sentence-case language. The owner's redesign specification pins Quiet Precision. Preserve product facts, native affordances, existing saved preferences, SSH trust, encryption, permissions, and terminal semantics.

## Evidence on Hand

BUILD_SPEC.md, docs/progress.md, docs/feature-matrix.csv, existing browser and native suites, bundled OFL terminal fonts, generated Lucide icons. Redesign evidence lives under docs/redesign/. No real server credentials or production data may be used.

## Product Principles

- Local operation is complete without an account.
- Trust decisions remain explicit and readable.
- The terminal receives the space and never moves for decoration.
- Settings and advanced actions disclose progressively.
- Verification claims cite actual platforms and test results.

## Accessibility & Inclusion

WCAG 2.2 AA goals, keyboard access, meaningful labels, safe dialog focus, contrast measurement, OS/in-app reduced motion, high contrast, long Unicode names, and user text scaling. No claim of full compliance without manual assistive-technology review.
