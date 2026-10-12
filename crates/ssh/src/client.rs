use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::watch;
use zeroize::Zeroizing;

use crate::algorithms;
use crate::auth::{
    AuthOutcome, ClientKey, KbdPrompt, KbdRound, MAX_KBD_PROMPTS, MAX_KBD_ROUNDS, MAX_SERVER_TEXT, sanitize_server_text,
};
use crate::channels::{ExecOutput, PtyRequest, ShellReader, ShellWriter, clamp_dimension};
use crate::host_trust::{Endpoint, HostKeyRequest, HostKeyVerifier, PresentedHostKey, RejectReason, TrustVerdict};
use crate::{SshError, Stage};

/// Connection parameters. Contains no secret.
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    pub endpoint: Endpoint,
    /// Limit for DNS resolution and for the TCP connect, each.
    pub connect_timeout: Duration,
    /// Limit for protocol progress during key exchange. Time spent inside the host-key verifier
    /// (for example waiting on a trust dialog) is excluded; the verifier owns that timeout.
    pub handshake_timeout: Duration,
    /// Limit for each authentication round trip and channel request.
    pub request_timeout: Duration,
    pub keepalive_interval: Option<Duration>,
    /// Post-quantum key exchange: preferred unless the host says otherwise.
    pub key_exchange: crate::algorithms::KeyExchangePolicy,
}

impl ConnectOptions {
    pub fn new(endpoint: Endpoint) -> Self {
        Self {
            endpoint,
            connect_timeout: Duration::from_secs(10),
            handshake_timeout: Duration::from_secs(15),
            request_timeout: Duration::from_secs(20),
            keepalive_interval: Some(Duration::from_secs(30)),
            key_exchange: crate::algorithms::KeyExchangePolicy::default(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    KeyExchange,
    Verifying,
    Verified,
}

#[derive(Default)]
struct TrustRecord {
    verdict: Option<TrustVerdict>,
    accepted: Option<PresentedHostKey>,
    /// Untrusted pre-authentication banner text, bounded.
    banner: Option<String>,
    /// What the last key exchange settled on (updated on every re-key).
    negotiated: Option<Negotiated>,
}

/// The algorithms a connection actually uses, from the completed key exchange. Every value is
/// one this client offered (see `algorithms.rs`), so none of it is server-controlled text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Negotiated {
    pub kex: String,
    pub host_key: String,
    pub cipher: String,
    /// Empty for AEAD ciphers, whose integrity is built in.
    pub mac: String,
    pub strict_kex: bool,
}

const MAX_BANNER_LEN: usize = 8 * 1024;

struct Handler<V> {
    endpoint: Endpoint,
    resolved: Option<SocketAddr>,
    verifier: V,
    record: Arc<Mutex<TrustRecord>>,
    phase: watch::Sender<Phase>,
}

impl<V> Handler<V> {
    fn with_record<T>(&self, f: impl FnOnce(&mut TrustRecord) -> T) -> T {
        // A poisoned lock only means another thread panicked while holding it; the data is plain.
        let mut guard = self.record.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut guard)
    }
}

impl<V: HostKeyVerifier> Handler<V> {
    async fn check_key(&mut self, server_key: &PublicKeyOrCertificate) -> bool {
        let presented = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => PresentedHostKey::from_public_key(key),
            // Never accepted merely for being signed; certificate validation is a later phase.
            PublicKeyOrCertificate::Certificate(_) => {
                self.with_record(|r| r.verdict = Some(TrustVerdict::Reject(RejectReason::CertificateUnsupported)));
                return false;
            }
        };
        let Some(presented) = presented else {
            self.with_record(|r| r.verdict = Some(TrustVerdict::Reject(RejectReason::NotTrusted)));
            return false;
        };

        // Re-keying: the key must be exactly the one accepted for this connection. No new prompt.
        if let Some(accepted) = self.with_record(|r| r.accepted.clone()) {
            let same = accepted == presented;
            if !same {
                self.with_record(|r| r.verdict = Some(TrustVerdict::Reject(RejectReason::ChangedDuringSession)));
            }
            return same;
        }

        let negotiated = self.with_record(|r| r.negotiated.clone());
        let request =
            HostKeyRequest { endpoint: self.endpoint.clone(), resolved: self.resolved, key: presented, negotiated };
        let _ = self.phase.send(Phase::Verifying);
        let verdict = self.verifier.verify(&request).await;
        let _ = self.phase.send(Phase::Verified);
        self.with_record(|r| {
            r.verdict = Some(verdict);
            if verdict == TrustVerdict::Accept {
                r.accepted = Some(request.key);
            }
        });
        verdict == TrustVerdict::Accept
    }

    fn store_banner(&self, banner: &str) {
        let mut end = banner.len().min(MAX_BANNER_LEN);
        while !banner.is_char_boundary(end) {
            end -= 1;
        }
        self.with_record(|r| r.banner = Some(banner[..end].to_owned()));
    }

    fn store_negotiated(&self, names: &russh::Names) {
        let aead = names.cipher.as_ref().contains("gcm") || names.cipher.as_ref().contains("poly1305");
        let negotiated = Negotiated {
            kex: names.kex.as_ref().to_owned(),
            host_key: names.key.as_str().to_owned(),
            cipher: names.cipher.as_ref().to_owned(),
            mac: if aead { String::new() } else { names.client_mac.as_ref().to_owned() },
            strict_kex: names.strict_kex(),
        };
        self.with_record(|r| r.negotiated = Some(negotiated));
    }
}

fn config(options: &ConnectOptions) -> Arc<client::Config> {
    Arc::new(client::Config {
        preferred: algorithms::preferred(options.key_exchange),
        keepalive_interval: options.keepalive_interval,
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    })
}

/// A transport whose server identity has been accepted by the caller's verifier.
///
/// This is the only type with authentication methods (INV-02). It holds no credential.
pub struct VerifiedConnection {
    pub(crate) handle: Handle<ErasedHandler>,
    host_key: PresentedHostKey,
    record: Arc<Mutex<TrustRecord>>,
    pub(crate) request_timeout: Duration,
    authenticated: bool,
    // agent B: tunnels and history
    /// Server-side listeners this connection asked for (`forward.rs`).
    pub(crate) routes: Arc<crate::forward::Routes>,
    /// Agent forwarding for this connection (off unless `forward_agent` was called).
    agent: AgentSlot,
}

impl core::fmt::Debug for VerifiedConnection {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("VerifiedConnection")
            .field("host_key", &self.host_key.fingerprint)
            .field("authenticated", &self.authenticated)
            .finish_non_exhaustive()
    }
}

/// Type-erased handler so `VerifiedConnection` is not generic over the verifier.
pub(crate) struct ErasedHandler(Box<dyn ErasedCheck>, Arc<crate::forward::Routes>, AgentSlot);

/// The agent offered to this connection's server, if the user turned forwarding on (CON-11).
pub(crate) type AgentSlot = Arc<Mutex<Option<crate::agent::ForwardedAgent>>>;

trait ErasedCheck: Send {
    fn check<'a>(
        &'a mut self,
        key: &'a PublicKeyOrCertificate,
    ) -> std::pin::Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
    fn banner(&mut self, banner: &str);
    fn negotiated(&mut self, names: &russh::Names);
}

impl<V: HostKeyVerifier> ErasedCheck for Handler<V> {
    fn check<'a>(
        &'a mut self,
        key: &'a PublicKeyOrCertificate,
    ) -> std::pin::Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(self.check_key(key))
    }

    fn banner(&mut self, banner: &str) {
        self.store_banner(banner);
    }

    fn negotiated(&mut self, names: &russh::Names) {
        self.store_negotiated(names);
    }
}

impl client::Handler for ErasedHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        Ok(self.0.check(server_key).await)
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut client::Session) -> Result<(), Self::Error> {
        self.0.banner(banner);
        Ok(())
    }

    async fn kex_done(
        &mut self,
        _shared_secret: Option<&[u8]>,
        names: &russh::Names,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.0.negotiated(names);
        Ok(())
    }

    // agent B: tunnels and history
    // russh accepts every server-opened channel by default. Only `forwarded-tcpip` channels for a
    // port this connection asked the server to forward are accepted; everything else (agent,
    // X11, session, direct-tcpip, stream-local) is refused, so a server cannot open channels
    // the user never enabled.

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if self.1.deliver(connected_port, channel) {
            reply.accept().await;
        } else {
            reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
        }
        Ok(())
    }

    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        _socket_path: &str,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
        Ok(())
    }

    // Agent channels are accepted only on a connection the user turned forwarding on for.
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let agent = self.2.lock().unwrap_or_else(|p| p.into_inner()).clone();
        match agent {
            Some(agent) => {
                reply.accept().await;
                tokio::spawn(crate::agent::serve(channel.into_stream(), agent));
            }
            None => reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await,
        }
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
        Ok(())
    }

    async fn server_channel_open_session(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
        Ok(())
    }

    async fn server_channel_open_direct_tcpip(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
        Ok(())
    }
}

/// Resolves, connects over TCP, performs key exchange and has `verifier` decide on the server's
/// host key. Returns only after the verifier accepted. No credential is involved at any point.
pub async fn connect<V: HostKeyVerifier>(
    options: &ConnectOptions,
    mut verifier: V,
) -> Result<VerifiedConnection, SshError> {
    let (host, port) = (options.endpoint.host.trim().to_owned(), options.endpoint.port);
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&host).to_owned();
    if host.is_empty() || host.len() > 253 || port == 0 {
        return Err(SshError::Resolve);
    }

    let addrs: Vec<SocketAddr> =
        match tokio::time::timeout(options.connect_timeout, tokio::net::lookup_host((host.as_str(), port))).await {
            Err(_) => return Err(SshError::Timeout(Stage::Resolving)),
            Ok(Err(_)) => return Err(SshError::Resolve),
            Ok(Ok(addrs)) => addrs.take(8).collect(),
        };
    if addrs.is_empty() {
        return Err(SshError::Resolve);
    }
    verifier.connecting();

    let mut last = SshError::Unreachable;
    for addr in addrs {
        match tokio::time::timeout(options.connect_timeout, TcpStream::connect(addr)).await {
            Err(_) => last = SshError::Timeout(Stage::Connecting),
            Ok(Err(_)) => last = SshError::Unreachable,
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return connect_stream(options, stream, Some(addr), verifier).await;
            }
        }
    }
    Err(last)
}

/// Like [`connect`], over an already established byte stream (a jump-host channel, a proxy, or a
/// test harness). The same verification guarantee applies.
pub async fn connect_stream<V, S>(
    options: &ConnectOptions,
    stream: S,
    resolved: Option<SocketAddr>,
    verifier: V,
) -> Result<VerifiedConnection, SshError>
where
    V: HostKeyVerifier,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let record = Arc::new(Mutex::new(TrustRecord::default()));
    let (phase_tx, mut phase_rx) = watch::channel(Phase::KeyExchange);
    let handler = Handler {
        endpoint: options.endpoint.clone(),
        resolved,
        verifier,
        record: Arc::clone(&record),
        phase: phase_tx,
    };

    let routes = Arc::new(crate::forward::Routes::default());
    let agent: AgentSlot = Arc::new(Mutex::new(None));
    let handshake = client::connect_stream(
        config(options),
        stream,
        ErasedHandler(Box::new(handler), Arc::clone(&routes), Arc::clone(&agent)),
    );
    tokio::pin!(handshake);

    // The handshake deadline restarts on each phase change and is suspended while the verifier
    // (possibly a human) is deciding.
    let result = loop {
        let phase = *phase_rx.borrow_and_update();
        tokio::select! {
            result = &mut handshake => break result,
            changed = phase_rx.changed() => if changed.is_err() {
                // Handler dropped: the handshake future is about to resolve; let it.
                break (&mut handshake).await;
            },
            () = tokio::time::sleep(options.handshake_timeout), if phase != Phase::Verifying => {
                let stage = if phase == Phase::KeyExchange { Stage::KeyExchange } else { Stage::VerifyingHost };
                return Err(SshError::Timeout(stage));
            }
        }
    };

    let (verdict, accepted) = {
        let guard = record.lock().unwrap_or_else(|p| p.into_inner());
        (guard.verdict, guard.accepted.clone())
    };
    match (result, verdict, accepted) {
        (Ok(handle), Some(TrustVerdict::Accept), Some(host_key)) => Ok(VerifiedConnection {
            handle,
            host_key,
            record,
            request_timeout: options.request_timeout,
            authenticated: false,
            routes,
            agent,
        }),
        // A handle without a recorded acceptance must never be usable.
        (Ok(handle), _, _) => {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
            Err(SshError::Internal)
        }
        (Err(_), Some(TrustVerdict::Reject(reason)), _) => Err(SshError::HostKey(reason)),
        (Err(err), _, _) => Err(SshError::from_russh(&err, Stage::KeyExchange)),
    }
}

impl VerifiedConnection {
    /// The host key the verifier accepted for this connection.
    pub fn host_key(&self) -> &PresentedHostKey {
        &self.host_key
    }

    /// Pre-authentication banner sent by the server, if any. Untrusted text: render as plain text.
    pub fn banner(&self) -> Option<String> {
        self.record.lock().unwrap_or_else(|p| p.into_inner()).banner.clone()
    }

    /// The algorithms the last key exchange settled on.
    pub fn negotiated(&self) -> Option<Negotiated> {
        self.record.lock().unwrap_or_else(|p| p.into_inner()).negotiated.clone()
    }

    pub fn is_authenticated(&self) -> bool {
        self.authenticated
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    async fn bounded<T>(
        &self,
        stage: Stage,
        fut: impl Future<Output = Result<T, russh::Error>>,
    ) -> Result<T, SshError> {
        match tokio::time::timeout(self.request_timeout, fut).await {
            Err(_) => Err(SshError::Timeout(stage)),
            Ok(Err(err)) => Err(SshError::from_russh(&err, stage)),
            Ok(Ok(value)) => Ok(value),
        }
    }

    fn outcome(&mut self, result: russh::client::AuthResult) -> Result<AuthOutcome, SshError> {
        match result {
            russh::client::AuthResult::Success => {
                self.authenticated = true;
                Ok(AuthOutcome::Success)
            }
            // russh reports a connection that died while waiting for the reply as a failure with
            // no remaining methods. That is a transport error, not a rejected credential, and must
            // not be shown to the user as "wrong password".
            russh::client::AuthResult::Failure { remaining_methods, .. }
                if remaining_methods.is_empty() && self.handle.is_closed() =>
            {
                Err(SshError::Disconnected(Stage::Authenticating))
            }
            russh::client::AuthResult::Failure { remaining_methods, partial_success } => Ok(AuthOutcome::Failure {
                remaining_methods: remaining_methods.iter().map(|m| <&str>::from(m).to_owned()).collect(),
                partial_success,
            }),
        }
    }

    /// Password authentication. The password is copied once into the SSH library, which does not
    /// zeroize it; this is a documented limit of the current backend.
    pub async fn authenticate_password(
        &mut self,
        username: &str,
        password: Zeroizing<String>,
    ) -> Result<AuthOutcome, SshError> {
        let timeout = self.request_timeout;
        let fut = self.handle.authenticate_password(username, password.as_str());
        let result = match tokio::time::timeout(timeout, fut).await {
            Err(_) => return Err(SshError::Timeout(Stage::Authenticating)),
            Ok(Err(err)) => return Err(SshError::from_russh(&err, Stage::Authenticating)),
            Ok(Ok(result)) => result,
        };
        self.outcome(result)
    }

    /// Public-key authentication. RSA keys use the strongest SHA-2 signature the server announced;
    /// SHA-1 `ssh-rsa` signatures are never produced.
    /// The SHA-2 hash an RSA key signs with on this connection (`None` for other keys).
    async fn rsa_hash(&self, key: &ClientKey) -> Result<Option<russh::keys::HashAlg>, SshError> {
        if !key.is_rsa() {
            return Ok(None);
        }
        let best = self.bounded(Stage::Authenticating, self.handle.best_supported_rsa_hash()).await?;
        // `Some(None)` means the server only does SHA-1 ssh-rsa; refuse rather than downgrade.
        match best {
            Some(Some(hash)) => Ok(Some(hash)),
            Some(None) => Err(SshError::NoCommonAlgorithm),
            None => Ok(Some(russh::keys::HashAlg::Sha256)),
        }
    }

    /// The signature algorithm `key` signs with here: `rsa-sha2-512` or `rsa-sha2-256` for an RSA
    /// key (SHA-1 is never used), otherwise the key's own algorithm. Public information only.
    pub async fn key_signature_algorithm(&self, key: &ClientKey) -> Result<String, SshError> {
        Ok(match self.rsa_hash(key).await? {
            Some(russh::keys::HashAlg::Sha512) => "rsa-sha2-512".to_owned(),
            Some(_) => "rsa-sha2-256".to_owned(),
            None => key.algorithm(),
        })
    }

    pub async fn authenticate_key(&mut self, username: &str, key: &ClientKey) -> Result<AuthOutcome, SshError> {
        let hash = self.rsa_hash(key).await?;
        let with_alg = PrivateKeyWithHashAlg::new(Arc::new(key.private_key().clone()), hash);
        let timeout = self.request_timeout;
        let fut = self.handle.authenticate_publickey(username, with_alg);
        let result = match tokio::time::timeout(timeout, fut).await {
            Err(_) => return Err(SshError::Timeout(Stage::Authenticating)),
            Ok(Err(err)) => return Err(SshError::from_russh(&err, Stage::Authenticating)),
            Ok(Ok(result)) => result,
        };
        self.outcome(result)
    }

    /// Public-key authentication with an OpenSSH user certificate for `key`
    /// (`<type>-cert-v01@openssh.com <base64> [comment]`). The server decides whether it trusts
    /// the certificate's CA, principals and validity; a certificate for a different key is
    /// refused here without contacting the server.
    pub async fn authenticate_key_with_certificate(
        &mut self,
        username: &str,
        key: &ClientKey,
        certificate: &str,
    ) -> Result<AuthOutcome, SshError> {
        let cert = russh::keys::Certificate::from_openssh(certificate.trim()).map_err(|_| SshError::Protocol)?;
        if cert.public_key() != key.private_key().public_key().key_data() {
            return Err(SshError::Protocol);
        }
        let timeout = self.request_timeout;
        let fut = self.handle.authenticate_openssh_cert(username, Arc::new(key.private_key().clone()), cert);
        let result = match tokio::time::timeout(timeout, fut).await {
            Err(_) => return Err(SshError::Timeout(Stage::Authenticating)),
            Ok(Err(err)) => return Err(SshError::from_russh(&err, Stage::Authenticating)),
            Ok(Ok(result)) => result,
        };
        self.outcome(result)
    }

    /// Asks the server which methods it accepts, with an SSH "none" request. A server that lets
    /// the user in without credentials returns `Success`.
    pub async fn auth_methods(&mut self, username: &str) -> Result<AuthOutcome, SshError> {
        let limit = self.request_timeout;
        let result = within(limit, Stage::Authenticating, self.handle.authenticate_none(username)).await?;
        self.outcome(result)
    }

    /// Keyboard-interactive authentication (RFC 4256). `respond` is called once per round that
    /// has prompts, with sanitized server text, and returns one answer per prompt or `None` to
    /// cancel. Rounds without prompts are answered with no responses and never reach `respond`.
    /// The number of rounds and prompts is bounded. Answers are copied once into the SSH library,
    /// which does not zeroize them; the same documented limit as passwords.
    pub async fn authenticate_keyboard_interactive<F, Fut>(
        &mut self,
        username: &str,
        mut respond: F,
    ) -> Result<AuthOutcome, SshError>
    where
        F: FnMut(KbdRound) -> Fut,
        Fut: Future<Output = Option<Vec<Zeroizing<String>>>>,
    {
        use russh::client::KeyboardInteractiveAuthResponse as R;
        let limit = self.request_timeout;
        let started = self.handle.authenticate_keyboard_interactive_start(username, None::<String>);
        let mut reply = within(limit, Stage::Authenticating, started).await?;
        let mut round = 0;
        loop {
            match reply {
                R::Success => {
                    self.authenticated = true;
                    return Ok(AuthOutcome::Success);
                }
                R::Failure { remaining_methods, partial_success } => {
                    return self.outcome(russh::client::AuthResult::Failure { remaining_methods, partial_success });
                }
                R::InfoRequest { name, instructions, prompts } => {
                    round += 1;
                    if round > MAX_KBD_ROUNDS || prompts.len() > MAX_KBD_PROMPTS {
                        return Err(SshError::LimitExceeded);
                    }
                    let answers: Vec<String> = if prompts.is_empty() {
                        Vec::new()
                    } else {
                        let request = KbdRound {
                            round,
                            name: sanitize_server_text(&name, MAX_SERVER_TEXT),
                            instructions: sanitize_server_text(&instructions, MAX_SERVER_TEXT),
                            prompts: prompts
                                .iter()
                                .map(|p| KbdPrompt {
                                    text: sanitize_server_text(&p.prompt, MAX_SERVER_TEXT),
                                    echo: p.echo,
                                })
                                .collect(),
                        };
                        let expected = request.prompts.len();
                        let answers = respond(request).await.ok_or(SshError::Cancelled)?;
                        if answers.len() != expected {
                            return Err(SshError::Internal);
                        }
                        answers.iter().map(|a| a.as_str().to_owned()).collect()
                    };
                    let next = self.handle.authenticate_keyboard_interactive_respond(answers);
                    reply = within(limit, Stage::Authenticating, next).await?;
                }
            }
        }
    }

    /// Opens an interactive shell with a PTY.
    /// Offers `agent` to this server from the next shell on (agent forwarding, CON-11).
    pub fn forward_agent(&self, agent: crate::agent::ForwardedAgent) {
        *self.agent.lock().unwrap_or_else(|p| p.into_inner()) = Some(agent);
    }

    pub async fn open_shell(&self, pty: &PtyRequest) -> Result<(ShellReader, ShellWriter), SshError> {
        self.open_shell_with_env(pty, &[]).await.map(|(reader, writer, _)| (reader, writer))
    }

    /// Opens an interactive shell with a PTY after requesting environment variables (SSH `env`
    /// requests, which the server accepts only for names its `AcceptEnv` allows). Returns the
    /// names the server refused; they are not set.
    pub async fn open_shell_with_env(
        &self,
        pty: &PtyRequest,
        env: &[(String, Zeroizing<String>)],
    ) -> Result<(ShellReader, ShellWriter, Vec<String>), SshError> {
        if !self.authenticated {
            return Err(SshError::NotAuthenticated);
        }
        let mut channel = self.bounded(Stage::OpeningChannel, self.handle.channel_open_session()).await?;
        let rejected = self.request_env(&mut channel, env).await?;
        let term: String = pty.term.chars().filter(|c| c.is_ascii_graphic()).take(64).collect();
        let term = if term.is_empty() { "xterm-256color".to_owned() } else { term };
        self.bounded(
            Stage::OpeningChannel,
            channel.request_pty(true, &term, clamp_dimension(pty.cols), clamp_dimension(pty.rows), 0, 0, &[]),
        )
        .await?;
        self.await_reply(&mut channel).await?;
        if self.agent.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
            // `auth-agent-req@openssh.com`; a server that refuses simply has no agent.
            let _ = self.bounded(Stage::OpeningChannel, channel.agent_forward(false)).await;
        }
        self.bounded(Stage::OpeningChannel, channel.request_shell(true)).await?;
        self.await_reply(&mut channel).await?;
        let (read, write) = channel.split();
        Ok((ShellReader { read, ended: false }, ShellWriter { write }, rejected))
    }

    /// Sends one `env` request per variable and waits for each reply. A refused variable is
    /// collected, not an error: the caller reports it.
    async fn request_env(
        &self,
        channel: &mut russh::Channel<client::Msg>,
        env: &[(String, Zeroizing<String>)],
    ) -> Result<Vec<String>, SshError> {
        let mut rejected = Vec::new();
        for (name, value) in env {
            self.bounded(Stage::OpeningChannel, channel.set_env(true, name.as_str(), value.as_str())).await?;
            match self.await_reply(channel).await {
                Ok(()) => {}
                Err(SshError::RequestDenied) => rejected.push(name.clone()),
                Err(other) => return Err(other),
            }
        }
        Ok(rejected)
    }

    /// Runs one command without a PTY and streams its output through the same bounded,
    /// backpressured reader as a shell. `command` is interpreted by the remote user's shell;
    /// callers must not build it from untrusted text.
    pub async fn open_command(&self, command: &str) -> Result<(ShellReader, ShellWriter), SshError> {
        self.open_command_with_env(command, &[]).await.map(|(reader, writer, _)| (reader, writer))
    }

    /// [`Self::open_command`] after requesting environment variables; returns the refused names.
    pub async fn open_command_with_env(
        &self,
        command: &str,
        env: &[(String, Zeroizing<String>)],
    ) -> Result<(ShellReader, ShellWriter, Vec<String>), SshError> {
        if !self.authenticated {
            return Err(SshError::NotAuthenticated);
        }
        let mut channel = self.bounded(Stage::OpeningChannel, self.handle.channel_open_session()).await?;
        let rejected = self.request_env(&mut channel, env).await?;
        self.bounded(Stage::OpeningChannel, channel.exec(true, command)).await?;
        self.await_reply(&mut channel).await?;
        let (read, write) = channel.split();
        Ok((ShellReader { read, ended: false }, ShellWriter { write }, rejected))
    }

    /// Opens the SFTP subsystem on a new channel of this connection.
    pub async fn open_sftp(&self) -> Result<crate::Sftp, SshError> {
        if !self.authenticated {
            return Err(SshError::NotAuthenticated);
        }
        let mut channel = self.bounded(Stage::OpeningChannel, self.handle.channel_open_session()).await?;
        self.bounded(Stage::OpeningChannel, channel.request_subsystem(true, "sftp")).await?;
        self.await_reply(&mut channel).await?;
        let start = crate::Sftp::start(channel.into_stream());
        match tokio::time::timeout(self.request_timeout, start).await {
            Err(_) => Err(SshError::Timeout(Stage::OpeningChannel)),
            Ok(Err(_)) => Err(SshError::RequestDenied),
            Ok(Ok(sftp)) => Ok(sftp),
        }
    }

    async fn await_reply(&self, channel: &mut russh::Channel<client::Msg>) -> Result<(), SshError> {
        let wait = async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Success) => return Ok(()),
                    Some(ChannelMsg::Failure) => return Err(SshError::RequestDenied),
                    Some(ChannelMsg::Close) | None => {
                        return Err(SshError::Disconnected(Stage::OpeningChannel));
                    }
                    Some(_) => {}
                }
            }
        };
        tokio::time::timeout(self.request_timeout, wait).await.map_err(|_| SshError::Timeout(Stage::OpeningChannel))?
    }

    /// Runs one command without a PTY and collects bounded output. `command` is sent to the
    /// remote user's shell by the server; callers must not build it from untrusted text.
    pub async fn exec(&self, command: &str, max_output: usize, limit: Duration) -> Result<ExecOutput, SshError> {
        if !self.authenticated {
            return Err(SshError::NotAuthenticated);
        }
        let mut channel = self.bounded(Stage::OpeningChannel, self.handle.channel_open_session()).await?;
        self.bounded(Stage::OpeningChannel, channel.exec(true, command)).await?;
        let collect = async {
            let mut out = ExecOutput { stdout: Vec::new(), stderr: Vec::new(), exit_status: None };
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Failure => return Err(SshError::RequestDenied),
                    ChannelMsg::Data { data } => out.stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => out.stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => out.exit_status = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
                if out.stdout.len() + out.stderr.len() > max_output {
                    let _ = channel.close().await;
                    return Err(SshError::LimitExceeded);
                }
            }
            Ok(out)
        };
        tokio::time::timeout(limit, collect).await.map_err(|_| SshError::Timeout(Stage::Connected))?
    }

    /// Politely disconnects. Dropping the connection also closes it.
    pub async fn disconnect(self) {
        let _ =
            tokio::time::timeout(Duration::from_secs(2), self.handle.disconnect(Disconnect::ByApplication, "", "en"))
                .await;
    }
}

/// Bounds one request/response exchange with the server.
async fn within<T>(
    limit: Duration,
    stage: Stage,
    fut: impl Future<Output = Result<T, russh::Error>>,
) -> Result<T, SshError> {
    match tokio::time::timeout(limit, fut).await {
        Err(_) => Err(SshError::Timeout(stage)),
        Ok(Err(err)) => Err(SshError::from_russh(&err, stage)),
        Ok(Ok(value)) => Ok(value),
    }
}
