//! Tyrminal SSH adapter over `russh`.
//!
//! The central guarantee (INV-02, INV-03): a credential or signature can only be sent on a
//! [`VerifiedConnection`], and the only way to obtain one is [`connect`], which returns it strictly
//! after the caller's [`HostKeyVerifier`] accepted the server's key. There is no API that
//! authenticates on an unverified transport and no retry path that skips verification.
//!
//! This crate knows nothing about the vault, storage, Tauri or the UI.

mod agent;
mod algorithms;
mod auth;
mod channels;
mod client;
mod error;
mod host_trust;
mod sftp;
// agent B: tunnels and history
mod forward;
mod jump;
mod proxy;

pub use agent::ForwardedAgent;
pub use algorithms::{KeyExchangePolicy, POST_QUANTUM_KEX, negotiation_summary};
pub use auth::{
    AuthOutcome, ClientKey, KbdPrompt, KbdRound, KeyError, MAX_KBD_PROMPTS, MAX_KBD_ROUNDS, MAX_SERVER_TEXT,
    sanitize_server_text,
};
pub use channels::{ExecOutput, PtyRequest, ShellEvent, ShellReader, ShellWriter};
pub use client::{ConnectOptions, Negotiated, VerifiedConnection, connect, connect_stream};
pub use error::{SshError, Stage};
pub use host_trust::{
    Endpoint, HostKeyRequest, HostKeyVerifier, KnownHost, PresentedHostKey, RejectReason, TrustStatus, TrustVerdict,
    canonical_host, evaluate,
};
pub use sftp::{FileError, RemoteAttrs, RemoteDirEntry, RemoteKind, RemoteReader, RemoteWriter, SFTP_CHUNK, Sftp};
// agent B: tunnels and history
pub use forward::{
    BindScope, DynamicForward, FORWARD_HANDSHAKE_TIMEOUT, ForwardEnd, ForwardError, ForwardHandle, ForwardStats,
    LocalForward, RemoteForward, SocksRefusal, SocksTarget, StatsSnapshot, local_bind_addr, local_bind_scope,
    remote_bind_scope, socks5_accept, start_dynamic, start_local, start_remote,
};
pub use jump::HopStream;
pub use proxy::{ProxyError, ProxyKind, ProxySpec, connect_via_proxy};
// agent D: key formats and certificates
pub use auth::{CertificateInfo, KeyKind, check_user_certificate, host_key_from_openssh, rsa_public_key_bits};
