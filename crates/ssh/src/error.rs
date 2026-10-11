use thiserror::Error;

use crate::RejectReason;

/// Where in the connection lifecycle something happened (BUILD_SPEC §4.4 session states).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Resolving,
    Connecting,
    KeyExchange,
    VerifyingHost,
    Authenticating,
    OpeningChannel,
    Connected,
}

/// SSH failures with fixed, secret-free messages (INV-18). Remote-supplied text is never embedded:
/// server banners and disconnect messages are untrusted and are surfaced separately as data.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SshError {
    #[error("the host name could not be resolved")]
    Resolve,
    #[error("the destination refused or dropped the connection")]
    Unreachable,
    #[error("the operation timed out")]
    Timeout(Stage),
    /// The verifier did not accept the server's host key. No credential was sent.
    #[error("the server's host key was not trusted")]
    HostKey(RejectReason),
    #[error("the client and server share no acceptable algorithms")]
    NoCommonAlgorithm,
    #[error("the server closed the connection")]
    Disconnected(Stage),
    #[error("the server refused to open the channel")]
    ChannelDenied,
    #[error("the server refused the request")]
    RequestDenied,
    #[error("the connection is not authenticated")]
    NotAuthenticated,
    #[error("the output exceeded the configured limit")]
    LimitExceeded,
    #[error("the SSH protocol exchange failed")]
    Protocol,
    #[error("an internal invariant was violated")]
    Internal,
}

impl SshError {
    /// Stable machine-readable code for the IPC layer.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Resolve => "RESOLVE_FAILED",
            Self::Unreachable => "UNREACHABLE",
            Self::Timeout(_) => "TIMEOUT",
            Self::HostKey(RejectReason::Changed) => "HOST_KEY_CHANGED",
            Self::HostKey(_) => "HOST_KEY_REJECTED",
            Self::NoCommonAlgorithm => "NO_COMMON_ALGORITHM",
            Self::Disconnected(_) => "DISCONNECTED",
            Self::ChannelDenied => "CHANNEL_DENIED",
            Self::RequestDenied => "REQUEST_DENIED",
            Self::NotAuthenticated => "AUTH_REQUIRED",
            Self::LimitExceeded => "LIMIT_EXCEEDED",
            Self::Protocol => "PROTOCOL_ERROR",
            Self::Internal => "INTERNAL",
        }
    }

    pub(crate) fn from_russh(err: &russh::Error, stage: Stage) -> Self {
        use russh::Error as E;
        match err {
            E::NoCommonAlgo { .. } => Self::NoCommonAlgorithm,
            E::ChannelOpenFailure(_) => Self::ChannelDenied,
            E::NotAuthenticated => Self::NotAuthenticated,
            E::ConnectionTimeout | E::KeepaliveTimeout | E::InactivityTimeout => Self::Timeout(stage),
            E::Disconnect | E::HUP | E::SendError | E::IO(_) => Self::Disconnected(stage),
            _ => Self::Protocol,
        }
    }
}
