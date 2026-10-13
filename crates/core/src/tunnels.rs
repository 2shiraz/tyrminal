//! Port forwarding rules and the forwards running on sessions (spec Phase 07).
//!
//! A saved rule belongs to a host. It runs on a connected SSH session to that host, over that
//! session's verified connection, so the host key was checked and the user authenticated exactly
//! as for the terminal. A forward never outlives its session: when the session ends for any
//! reason (closed, lost, vault locked, window closed) its forwards stop and their listeners close.
//!
//! Exposure (spec Phase 07, §9.3 "Tunnels"): a listener other machines could reach needs `allow_external` on the rule,
//! which the UI sets only after a separate confirmation. The SSH adapter enforces the same rule
//! again when it binds, so a rule that bypassed this validation still could not bind externally.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tyrminal_contracts::limits::{MAX_ACTIVE_TUNNELS, MAX_CHAIN_HOPS, MAX_ENDED_TUNNELS, MAX_TUNNEL_CONNECTIONS};
use tyrminal_contracts::{
    ActiveTunnel, ErrorCode, IpcError, ProxyInput, ProxySummary, ProxyType, TunnelInput, TunnelKind, TunnelState,
    TunnelSummary,
};
use tyrminal_ssh::{
    BindScope, DynamicForward, ForwardEnd, ForwardError, ForwardHandle, LocalForward, RemoteForward, StatsSnapshot,
    VerifiedConnection, local_bind_addr, local_bind_scope, remote_bind_scope,
};
use tyrminal_ssh::{ProxyError, ProxyKind, ProxySpec};
use tyrminal_vault::Id;
use zeroize::Zeroizing;

use crate::error::{err, invalid, not_found};
use crate::records::{StoredProxy, TunnelRecord};
use crate::sessions::{Sessions, random_token};

/// Tunnel ids of quick forwards (P-24) start with this; they are not saved rules.
const QUICK_PREFIX: &str = "port:";
use crate::validate;

// ---------- rules ----------

pub(crate) fn summary(id: String, record: &TunnelRecord, host_label: Option<String>) -> TunnelSummary {
    TunnelSummary {
        id,
        name: record.name.clone(),
        host_id: record.host_id.clone(),
        host_label,
        kind: record.kind,
        bind_host: record.bind_host.clone(),
        bind_port: record.bind_port,
        dest_host: record.dest_host.clone(),
        dest_port: record.dest_port,
        allow_external: record.allow_external,
        auto_start: record.auto_start,
        updated_at: record.updated_at,
    }
}

pub(crate) fn copy_name(name: &str) -> String {
    let copy = format!("{name} (copy)");
    if validate::label(&copy).is_ok() { copy } else { name.to_owned() }
}

fn needs_approval() -> IpcError {
    invalid("This listener would be reachable from other computers. Confirm that exposure to save it.")
}

/// Validates a rule as the user entered it and returns what is stored. Loopback listeners never
/// carry an approval flag, so an approval cannot linger on a rule that does not need it.
pub(crate) fn normalize(input: &TunnelInput) -> Result<TunnelRecord, IpcError> {
    let name = validate::label(&input.name)?;
    let host_id = validate::id_text(&validate::id(&input.host_id)?);
    let bind_host = input.bind_host.trim();
    let (bind_host, external) = match input.kind {
        TunnelKind::Local | TunnelKind::Dynamic => {
            let bind_host = if bind_host.is_empty() { "127.0.0.1" } else { bind_host };
            let addr = local_bind_addr(bind_host)
                .map_err(|_| invalid("The listen address must be an IP address such as 127.0.0.1, or localhost."))?;
            let shown =
                if bind_host.eq_ignore_ascii_case("localhost") { "localhost".to_owned() } else { addr.to_string() };
            (shown, local_bind_scope(addr) == BindScope::External)
        }
        TunnelKind::Remote => {
            // Empty means the server's loopback, like OpenSSH's default for -R.
            let bind_host = if bind_host.is_empty() { "localhost" } else { bind_host };
            let shown = match bind_host {
                "*" => "*".to_owned(),
                other => validate::address(other)
                    .map_err(|_| invalid("The server listen address must be a host name, an IP address or *."))?,
            };
            let external = remote_bind_scope(&shown) == BindScope::External;
            (shown, external)
        }
    };
    if external && !input.allow_external {
        return Err(needs_approval());
    }
    let (dest_host, dest_port) = match input.kind {
        TunnelKind::Dynamic => (String::new(), 0),
        TunnelKind::Local | TunnelKind::Remote => {
            let host = validate::address(&input.dest_host)
                .map_err(|_| invalid("Enter the destination as a host name or an IP address."))?;
            if input.dest_port == 0 {
                return Err(invalid("Enter the destination port (1-65535)."));
            }
            (host, input.dest_port)
        }
    };
    Ok(TunnelRecord {
        name,
        host_id,
        kind: input.kind,
        bind_host,
        bind_port: input.bind_port,
        dest_host,
        dest_port,
        allow_external: external,
        auto_start: input.auto_start,
        updated_at: 0,
    })
}

// ---------- proxies ----------

/// How long reaching a proxy, and its handshake, may take.
const PROXY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub(crate) fn proxy_summary(proxy: &StoredProxy) -> ProxySummary {
    ProxySummary {
        kind: proxy.kind,
        host: proxy.host.clone(),
        port: proxy.port,
        username: proxy.username.clone(),
        password_stored: proxy.password.is_some(),
    }
}

pub(crate) fn proxy_spec(proxy: &StoredProxy) -> ProxySpec {
    let credentials = if proxy.username.is_empty() {
        None
    } else {
        let password = proxy.password.as_ref().map(|p| Zeroizing::new(p.as_str().to_owned())).unwrap_or_default();
        Some((proxy.username.clone(), password))
    };
    ProxySpec {
        kind: match proxy.kind {
            ProxyType::Http => ProxyKind::Http,
            ProxyType::Socks5 => ProxyKind::Socks5,
        },
        host: proxy.host.clone(),
        port: proxy.port,
        credentials,
        timeout: PROXY_TIMEOUT,
    }
}

/// Validates proxy settings. A `None` password keeps the stored one (same user name only), so
/// the renderer never needs to hold it; an empty user name means no authentication.
pub(crate) fn normalize_proxy(input: &ProxyInput, existing: Option<&StoredProxy>) -> Result<StoredProxy, IpcError> {
    let host =
        validate::address(&input.host).map_err(|_| invalid("Enter the proxy as a host name or an IP address."))?;
    if input.port == 0 {
        return Err(invalid("Enter the proxy's port (1-65535)."));
    }
    let username = input.username.trim().to_owned();
    if username.len() > 255 || username.contains(':') || username.chars().any(char::is_control) {
        return Err(invalid("The proxy user name must be at most 255 bytes, without colons or control characters."));
    }
    let password = if username.is_empty() {
        None
    } else {
        match &input.password {
            Some(p) if p.is_empty() => None,
            Some(p) => {
                validate::secret(p)?;
                if p.len() > 255 {
                    return Err(invalid("The proxy password must be at most 255 bytes."));
                }
                Some(Zeroizing::new(p.clone()))
            }
            None => existing
                .filter(|e| e.username == username)
                .and_then(|e| e.password.as_ref())
                .map(|p| Zeroizing::new(p.as_str().to_owned())),
        }
    };
    Ok(StoredProxy { kind: input.kind, host, port: input.port, username, password })
}

/// User-facing errors for a proxy failure; never proxy-supplied text.
pub(crate) fn proxy_error(e: ProxyError) -> IpcError {
    match e {
        ProxyError::Unreachable => err(ErrorCode::Unreachable, "The proxy could not be reached."),
        ProxyError::Timeout => err(ErrorCode::Timeout, "The proxy did not answer in time."),
        ProxyError::AuthRequired => err(ErrorCode::AuthFailed, "The proxy requires a user name and password."),
        ProxyError::AuthRejected => err(ErrorCode::AuthFailed, "The proxy did not accept the user name and password."),
        ProxyError::Refused => err(ErrorCode::Unreachable, "The proxy refused the connection to the server."),
        ProxyError::Protocol => {
            err(ErrorCode::ProtocolError, "The proxy answered with something that is not a proxy response.")
        }
        ProxyError::Invalid => invalid("The proxy settings are not valid."),
    }
}

// ---------- jump host chains ----------

/// The jump hosts a connection to `start` goes through, first hop first (`start` excluded).
/// `jump_of` reports the jump host recorded on a host. Loops, chains longer than
/// `MAX_CHAIN_HOPS` hosts and missing hosts are refused, so a saved chain always ends.
pub(crate) fn chain(
    start: &Id,
    mut jump_of: impl FnMut(&Id) -> Result<Option<Id>, IpcError>,
) -> Result<Vec<Id>, IpcError> {
    let mut hops: Vec<Id> = Vec::new();
    let mut current = *start;
    while let Some(next) = jump_of(&current)? {
        if next == *start || hops.contains(&next) {
            return Err(invalid("These jump hosts would form a loop. Choose a different jump host."));
        }
        hops.push(next);
        if hops.len() + 1 > MAX_CHAIN_HOPS {
            return Err(invalid("A connection can go through at most 7 jump hosts."));
        }
        current = next;
    }
    hops.reverse();
    Ok(hops)
}

// ---------- running forwards ----------

struct Run {
    owner: String,
    session_id: String,
    generation: u32,
    tunnel_id: String,
    record: TunnelRecord,
    bound_port: u16,
    /// `None` once ended; `last` keeps the final counters.
    handle: Option<ForwardHandle>,
    last: StatsSnapshot,
    state: TunnelState,
    error: Option<IpcError>,
    /// Order of creation, to keep the newest ended runs.
    seq: u64,
}

impl Run {
    /// Moves an ended forward to its final state and releases it.
    fn settle(&mut self) {
        let Some(handle) = &self.handle else { return };
        self.last = handle.stats();
        let Some(end) = handle.ended() else { return };
        self.state = match end {
            ForwardEnd::Stopped if self.state == TunnelState::Running => TunnelState::Stopped,
            ForwardEnd::Stopped => self.state,
            ForwardEnd::ConnectionLost => TunnelState::SessionEnded,
            ForwardEnd::ListenerFailed => {
                self.error = Some(err(ErrorCode::IoError, "The listener stopped unexpectedly."));
                TunnelState::Failed
            }
        };
        self.handle = None;
    }

    fn view(&self, run_id: &str) -> ActiveTunnel {
        ActiveTunnel {
            run_id: run_id.to_owned(),
            tunnel_id: self.tunnel_id.clone(),
            session_id: self.session_id.clone(),
            name: self.record.name.clone(),
            kind: self.record.kind,
            bind_host: self.record.bind_host.clone(),
            bound_port: self.bound_port,
            dest_host: self.record.dest_host.clone(),
            dest_port: self.record.dest_port,
            state: self.state,
            active_connections: if self.handle.is_some() { self.last.active } else { 0 },
            total_connections: self.last.accepted,
            refused_connections: self.last.refused,
            failed_connections: self.last.failed,
            bytes_out: self.last.bytes_out,
            bytes_in: self.last.bytes_in,
            error: self.error.clone(),
        }
    }
}

/// The forwards started in this process, running and recently ended.
#[derive(Default)]
pub(crate) struct TunnelRuns {
    runs: Mutex<HashMap<String, Run>>,
    seq: std::sync::atomic::AtomicU64,
}

impl TunnelRuns {
    fn runs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Run>> {
        self.runs.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// Stops every forward of a session that ended and waits until their listeners are closed.
    /// Called by the session supervisor on every way a session can end.
    /// Gives a session's forwards, running or ended, to the window it moved to.
    pub(crate) fn reassign(&self, session_id: &str, owner: &str) {
        for run in self.runs().values_mut().filter(|r| r.session_id == session_id) {
            owner.clone_into(&mut run.owner);
        }
    }

    pub(crate) async fn session_ended(&self, session_id: &str) {
        let handles: Vec<(String, ForwardHandle)> = {
            let mut runs = self.runs();
            runs.iter_mut()
                .filter(|(_, r)| r.session_id == session_id)
                .filter_map(|(id, r)| Some((id.clone(), r.handle.take()?)))
                .collect()
        };
        for (_, handle) in &handles {
            handle.stop().await;
        }
        let mut runs = self.runs();
        for (id, handle) in handles {
            if let Some(run) = runs.get_mut(&id) {
                run.last = handle.stats();
                if run.state == TunnelState::Running {
                    run.state = TunnelState::SessionEnded;
                }
            }
        }
    }

    /// Drops ended runs beyond the kept number and every run from an older vault generation.
    fn prune(runs: &mut HashMap<String, Run>, generation: u32) {
        runs.retain(|_, r| r.generation == generation || r.handle.is_some());
        let mut ended: Vec<(u64, String)> =
            runs.iter().filter(|(_, r)| r.handle.is_none()).map(|(id, r)| (r.seq, id.clone())).collect();
        if ended.len() > MAX_ENDED_TUNNELS {
            ended.sort();
            for (_, id) in ended.iter().take(ended.len() - MAX_ENDED_TUNNELS) {
                runs.remove(id);
            }
        }
    }
}

fn forward_error(e: ForwardError) -> IpcError {
    match e {
        ForwardError::ExternalBindNotApproved => needs_approval(),
        ForwardError::InvalidAddress => invalid("The tunnel's addresses are not valid."),
        ForwardError::BindFailed => err(
            ErrorCode::InUse,
            "The listen port could not be opened. It may be in use, or need administrator rights.",
        ),
        ForwardError::Denied => err(ErrorCode::ChannelDenied, "The server does not allow this port forwarding."),
        ForwardError::NotAuthenticated => err(ErrorCode::InvalidInput, "This works in a connected SSH session only."),
        ForwardError::Disconnected => err(ErrorCode::Disconnected, "The connection was lost."),
        ForwardError::Timeout => err(ErrorCode::Timeout, "The server did not answer in time."),
    }
}

/// Starts one rule's forward on `conn`.
async fn start_forward(conn: &Arc<VerifiedConnection>, rule: &TunnelRecord) -> Result<ForwardHandle, IpcError> {
    let max_connections = MAX_TUNNEL_CONNECTIONS;
    let result = match rule.kind {
        TunnelKind::Local => {
            let spec = LocalForward {
                bind_host: rule.bind_host.clone(),
                bind_port: rule.bind_port,
                dest_host: rule.dest_host.clone(),
                dest_port: rule.dest_port,
                approve_external: rule.allow_external,
                max_connections,
            };
            tyrminal_ssh::start_local(conn, &spec).await
        }
        TunnelKind::Remote => {
            let spec = RemoteForward {
                remote_host: if rule.bind_host == "*" { String::new() } else { rule.bind_host.clone() },
                remote_port: rule.bind_port,
                dest_host: rule.dest_host.clone(),
                dest_port: rule.dest_port,
                approve_external: rule.allow_external,
                max_connections,
            };
            tyrminal_ssh::start_remote(conn, &spec).await
        }
        TunnelKind::Dynamic => {
            let spec = DynamicForward {
                bind_host: rule.bind_host.clone(),
                bind_port: rule.bind_port,
                approve_external: rule.allow_external,
                max_connections,
            };
            tyrminal_ssh::start_dynamic(conn, &spec).await
        }
    };
    result.map_err(forward_error)
}

fn run_denied() -> IpcError {
    err(ErrorCode::AccessDenied, "That tunnel is not available to this window.")
}

impl Sessions {
    /// Starts a saved rule on a connected SSH session the caller owns. The rule must belong to
    /// the session's host, and may not already run on that session.
    pub async fn start_tunnel(&self, owner: &str, session_id: &str, tunnel_id: &str) -> Result<ActiveTunnel, IpcError> {
        let (entry, conn) = self.connection(owner, session_id)?;
        let tunnel_id = validate::id_text(&validate::id(tunnel_id)?);
        let rule = self.vault().tunnel_rule(entry.generation, &tunnel_id).await?;
        if entry.host_id.as_deref() != Some(rule.host_id.as_str()) {
            return Err(invalid("That tunnel belongs to a different host than this session."));
        }
        self.start_run(owner, session_id, entry.generation, tunnel_id, rule, &conn).await
    }

    async fn start_run(
        &self,
        owner: &str,
        session_id: &str,
        generation: u32,
        tunnel_id: String,
        rule: TunnelRecord,
        conn: &Arc<VerifiedConnection>,
    ) -> Result<ActiveTunnel, IpcError> {
        {
            let mut runs = self.tunnel_runs.runs();
            for run in runs.values_mut() {
                run.settle();
            }
            if runs.values().any(|r| r.handle.is_some() && r.session_id == session_id && r.tunnel_id == tunnel_id) {
                return Err(err(ErrorCode::Conflict, "That tunnel is already running on this session."));
            }
            if runs.values().filter(|r| r.handle.is_some()).count() >= MAX_ACTIVE_TUNNELS {
                return Err(err(ErrorCode::LimitExceeded, "Too many tunnels are running. Stop one and try again."));
            }
        }
        let handle = start_forward(conn, &rule).await?;
        let run_id = random_token()?;
        let run = Run {
            owner: owner.to_owned(),
            session_id: session_id.to_owned(),
            generation,
            tunnel_id,
            bound_port: handle.bound().port(),
            last: handle.stats(),
            handle: Some(handle),
            record: rule,
            state: TunnelState::Running,
            error: None,
            seq: self.tunnel_runs.next_seq(),
        };
        let view = run.view(&run_id);
        {
            let mut runs = self.tunnel_runs.runs();
            // The session may have moved to another window while the forward was starting.
            let mut run = run;
            if let Some(current) = self.session_owner(session_id) {
                run.owner = current;
            }
            runs.insert(run_id, run);
            TunnelRuns::prune(&mut runs, self.vault().generation());
        }
        // The session may have ended while the forward was starting; its cleanup has run, so
        // stop this one too rather than leave a listener without a session.
        if self.session_owner(session_id).is_none() {
            self.tunnel_runs.session_ended(session_id).await;
        }
        Ok(view)
    }

    /// Forwards a port the session's output named (P-24), after the user accepted the
    /// suggestion. Only a port suggested for this session is accepted. The destination is always
    /// the server's loopback at that port; the listener binds to 127.0.0.1 on the same port when
    /// it is free, otherwise on a free port. It runs as any forward does and ends with the session.
    pub async fn quick_forward(&self, owner: &str, session_id: &str, port: u16) -> Result<ActiveTunnel, IpcError> {
        let (entry, conn) = self.connection(owner, session_id)?;
        if !self.suggested.contains(session_id, port) {
            return Err(invalid("That port was not offered for this session."));
        }
        let record = |bind_port| TunnelRecord {
            name: format!("Port {port}"),
            host_id: entry.host_id.clone().unwrap_or_default(),
            kind: TunnelKind::Local,
            bind_host: "127.0.0.1".to_owned(),
            bind_port,
            dest_host: "127.0.0.1".to_owned(),
            dest_port: port,
            allow_external: false,
            auto_start: false,
            updated_at: 0,
        };
        let tunnel_id = format!("{QUICK_PREFIX}{port}");
        match self.start_run(owner, session_id, entry.generation, tunnel_id.clone(), record(port), &conn).await {
            Err(e) if e.code == ErrorCode::InUse => {
                self.start_run(owner, session_id, entry.generation, tunnel_id, record(0), &conn).await
            }
            other => other,
        }
    }

    /// The address to open in a browser for a running quick forward: built here from the bound
    /// port, never taken from output.
    pub fn quick_forward_url(&self, owner: &str, run_id: &str) -> Result<String, IpcError> {
        let mut runs = self.tunnel_runs.runs();
        let run = runs.get_mut(run_id).filter(|r| r.owner == owner).ok_or_else(run_denied)?;
        run.settle();
        if !run.tunnel_id.starts_with(QUICK_PREFIX) || run.handle.is_none() {
            return Err(run_denied());
        }
        Ok(format!("http://127.0.0.1:{}/", run.bound_port))
    }

    /// Starts the host's auto-start rules on a session that just connected. A rule that fails
    /// is listed as failed with its reason; it does not affect the session or the other rules.
    pub(crate) async fn start_auto_tunnels(
        &self,
        owner: &str,
        session_id: &str,
        host_id: &str,
        generation: u32,
        conn: &Arc<VerifiedConnection>,
    ) {
        let Ok(rules) = self.vault().auto_start_tunnels(generation, host_id).await else { return };
        for (tunnel_id, rule) in rules {
            if let Err(error) =
                self.start_run(owner, session_id, generation, tunnel_id.clone(), rule.clone(), conn).await
            {
                let Ok(run_id) = random_token() else { return };
                let owner = self.session_owner(session_id).unwrap_or_else(|| owner.to_owned());
                let mut runs = self.tunnel_runs.runs();
                let seq = self.tunnel_runs.next_seq();
                runs.insert(
                    run_id,
                    Run {
                        owner,
                        session_id: session_id.to_owned(),
                        generation,
                        tunnel_id,
                        record: rule,
                        bound_port: 0,
                        handle: None,
                        last: StatsSnapshot::default(),
                        state: TunnelState::Failed,
                        error: Some(error),
                        seq,
                    },
                );
                TunnelRuns::prune(&mut runs, generation);
            }
        }
    }

    /// Stops a running forward the caller started. Its listener is closed when this returns.
    pub async fn stop_tunnel(&self, owner: &str, run_id: &str) -> Result<(), IpcError> {
        let handle = {
            let mut runs = self.tunnel_runs.runs();
            let run = runs.get_mut(run_id).filter(|r| r.owner == owner).ok_or_else(run_denied)?;
            run.settle();
            let Some(handle) = run.handle.take() else {
                return Err(not_found("That tunnel is not running."));
            };
            run.state = TunnelState::Stopped;
            handle
        };
        handle.stop().await;
        let mut runs = self.tunnel_runs.runs();
        if let Some(run) = runs.get_mut(run_id) {
            run.last = handle.stats();
        }
        Ok(())
    }

    /// The caller's forwards: running ones with live counters, then recently ended ones.
    pub fn active_tunnels(&self, owner: &str) -> Vec<ActiveTunnel> {
        let generation = self.vault().generation();
        let mut runs = self.tunnel_runs.runs();
        for run in runs.values_mut() {
            run.settle();
        }
        TunnelRuns::prune(&mut runs, generation);
        let mut list: Vec<(bool, u64, ActiveTunnel)> = runs
            .iter()
            .filter(|(_, r)| r.owner == owner && r.generation == generation)
            .map(|(id, r)| (r.handle.is_none(), u64::MAX - r.seq, r.view(id)))
            .collect();
        list.sort_by_key(|entry| (entry.0, entry.1));
        list.into_iter().map(|(_, _, view)| view).collect()
    }

    /// Forgets the caller's ended forwards.
    pub fn clear_ended_tunnels(&self, owner: &str) {
        let mut runs = self.tunnel_runs.runs();
        for run in runs.values_mut() {
            run.settle();
        }
        runs.retain(|_, r| r.owner != owner || r.handle.is_some());
    }

    /// Stops every forward a window started (the window closed).
    pub fn stop_tunnels_for_owner(&self, owner: &str) {
        // Dropping a handle stops its forward.
        self.tunnel_runs.runs().retain(|_, r| r.owner != owner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: TunnelKind, bind_host: &str) -> TunnelInput {
        TunnelInput {
            id: None,
            name: "db".into(),
            host_id: "00112233445566778899aabbccddeeff".into(),
            kind,
            bind_host: bind_host.into(),
            bind_port: 5432,
            dest_host: "db.internal".into(),
            dest_port: 5432,
            allow_external: false,
            auto_start: false,
        }
    }

    #[test]
    fn loopback_rules_save_without_approval_and_never_carry_one() {
        for (kind, host, stored) in [
            (TunnelKind::Local, "", "127.0.0.1"),
            (TunnelKind::Local, "localhost", "localhost"),
            (TunnelKind::Local, "[::1]", "::1"),
            (TunnelKind::Dynamic, "127.0.0.2", "127.0.0.2"),
            (TunnelKind::Remote, "", "localhost"),
            (TunnelKind::Remote, "127.0.0.1", "127.0.0.1"),
        ] {
            let mut i = input(kind, host);
            i.allow_external = true;
            let record = normalize(&i).unwrap();
            assert_eq!(record.bind_host, stored, "{kind:?} {host:?}");
            assert!(!record.allow_external, "{kind:?} {host:?}: a loopback rule records no approval");
        }
    }

    #[test]
    fn exposed_listeners_need_explicit_approval() {
        for (kind, host) in [
            (TunnelKind::Local, "0.0.0.0"),
            (TunnelKind::Local, "::"),
            (TunnelKind::Local, "192.168.1.5"),
            (TunnelKind::Dynamic, "0.0.0.0"),
            (TunnelKind::Remote, "*"),
            (TunnelKind::Remote, "0.0.0.0"),
            (TunnelKind::Remote, "gateway.example"),
        ] {
            let refused = normalize(&input(kind, host)).err().expect("refused without approval");
            assert_eq!(refused.code, ErrorCode::InvalidInput, "{kind:?} {host}");
            let mut approved = input(kind, host);
            approved.allow_external = true;
            assert!(normalize(&approved).unwrap().allow_external, "{kind:?} {host}");
        }
    }

    #[test]
    fn malformed_rules_are_refused() {
        // A local listen address must be an IP literal, so no name can resolve past the policy.
        assert!(normalize(&input(TunnelKind::Local, "my-laptop.lan")).is_err());
        assert!(normalize(&input(TunnelKind::Local, "127.0.0.1; rm -rf /")).is_err());
        assert!(normalize(&input(TunnelKind::Remote, "a b")).is_err());
        let mut bad = input(TunnelKind::Local, "");
        bad.dest_host = "http://db/".into();
        assert!(normalize(&bad).is_err());
        let mut bad = input(TunnelKind::Remote, "");
        bad.dest_port = 0;
        assert!(normalize(&bad).is_err());
        let mut bad = input(TunnelKind::Local, "");
        bad.host_id = "../../etc".into();
        assert!(normalize(&bad).is_err());
        let mut bad = input(TunnelKind::Local, "");
        bad.name = "\u{1b}[31mred".into();
        assert!(normalize(&bad).is_err());
    }

    #[test]
    fn chains_run_first_hop_first_and_refuse_loops_length_and_gaps() {
        let id = |n: u8| -> Id { [n; 16] };
        let links = |pairs: &'static [(u8, u8)]| {
            move |host: &Id| -> Result<Option<Id>, IpcError> {
                Ok(pairs.iter().find(|(from, _)| id(*from) == *host).map(|(_, to)| id(*to)))
            }
        };
        assert_eq!(chain(&id(1), links(&[])).unwrap(), Vec::<Id>::new());
        // 1 → via 2 → via 3: connect to 3, then 2, then 1.
        assert_eq!(chain(&id(1), links(&[(1, 2), (2, 3)])).unwrap(), vec![id(3), id(2)]);
        assert!(chain(&id(1), links(&[(1, 1)])).is_err(), "a host cannot be its own jump host");
        assert!(chain(&id(1), links(&[(1, 2), (2, 1)])).is_err());
        assert!(chain(&id(1), links(&[(1, 2), (2, 3), (3, 2)])).is_err());
        // Eight hosts in all is the limit (seven jump hosts).
        let ok: &'static [(u8, u8)] = &[(1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 7), (7, 8)];
        assert_eq!(chain(&id(1), links(ok)).unwrap().len(), 7);
        let long: &'static [(u8, u8)] = &[(1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 7), (7, 8), (8, 9)];
        assert!(chain(&id(1), links(long)).is_err());
        // A missing host anywhere in the chain fails the whole chain.
        let gap = |host: &Id| -> Result<Option<Id>, IpcError> {
            if *host == id(1) { Ok(Some(id(2))) } else { Err(not_found("gone")) }
        };
        assert_eq!(chain(&id(1), gap).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn dynamic_rules_have_no_destination() {
        let record = normalize(&input(TunnelKind::Dynamic, "")).unwrap();
        assert_eq!((record.dest_host.as_str(), record.dest_port), ("", 0));
    }
}
