//! A minimal SSH agent for agent forwarding (CON-11), answering on channels the server opens.
//!
//! Forwarding is off unless the user turned it on for the host. When on, the server (and anyone
//! with root on it) can ask this agent to sign with the forwarded key for as long as the session
//! lasts; that is what agent forwarding is. To keep that power as small as possible:
//! - only one key is offered: the key this host signs in with;
//! - only "list keys" and "sign" are answered. Adding, removing, locking or anything else gets a
//!   failure reply, so a server can never change what the agent holds;
//! - RSA signatures use SHA-2 only (a SHA-1 `ssh-rsa` request is refused);
//! - every signature is reported to the session (`on_sign`), so the user sees each use.

use std::sync::Arc;

use russh::keys::ssh_key::Signature;
use russh::keys::ssh_key::private::KeypairData;
use russh::keys::{HashAlg, PrivateKey};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const SSH_AGENT_FAILURE: u8 = 5;
const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
const SSH_AGENT_SIGN_RESPONSE: u8 = 14;
const SSH_AGENT_RSA_SHA2_256: u32 = 2;
const SSH_AGENT_RSA_SHA2_512: u32 = 4;

/// Largest request read (a sign request carries a session identifier and a small payload).
const MAX_FRAME: usize = 256 * 1024;

/// What the agent offers on a connection.
#[derive(Clone)]
pub struct ForwardedAgent {
    key: Arc<PrivateKey>,
    on_sign: Arc<dyn Fn() + Send + Sync>,
}

impl core::fmt::Debug for ForwardedAgent {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ForwardedAgent").field("algorithm", &self.key.algorithm().as_str()).finish_non_exhaustive()
    }
}

impl ForwardedAgent {
    pub fn new(key: &crate::ClientKey, on_sign: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self { key: Arc::new(key.private_key().clone()), on_sign }
    }

    fn public_blob(&self) -> Option<Vec<u8>> {
        self.key.public_key().to_bytes().ok()
    }

    /// Answers one request.
    fn respond(&self, request: &[u8]) -> Vec<u8> {
        let failure = vec![SSH_AGENT_FAILURE];
        let Some((&kind, body)) = request.split_first() else { return failure };
        match kind {
            SSH_AGENTC_REQUEST_IDENTITIES => {
                let Some(blob) = self.public_blob() else { return failure };
                let mut out = vec![SSH_AGENT_IDENTITIES_ANSWER];
                out.extend_from_slice(&1u32.to_be_bytes());
                put_string(&mut out, &blob);
                put_string(&mut out, b"tyrminal forwarded key");
                out
            }
            SSH_AGENTC_SIGN_REQUEST => {
                let mut r = Reader(body);
                let (Some(blob), Some(data), Some(flags)) = (r.string(), r.string(), r.u32()) else { return failure };
                if Some(blob) != self.public_blob().as_deref() {
                    return failure;
                }
                let Some(signature) = self.sign(data, flags) else { return failure };
                let Ok(encoded) = russh::keys::ssh_encoding::Encode::encode_vec(&signature) else { return failure };
                (self.on_sign)();
                let mut out = vec![SSH_AGENT_SIGN_RESPONSE];
                put_string(&mut out, &encoded);
                out
            }
            _ => failure,
        }
    }

    fn sign(&self, data: &[u8], flags: u32) -> Option<Signature> {
        use russh::keys::signature::Signer;
        match self.key.key_data() {
            KeypairData::Rsa(rsa) => {
                let hash = if flags & SSH_AGENT_RSA_SHA2_512 != 0 {
                    HashAlg::Sha512
                } else if flags & SSH_AGENT_RSA_SHA2_256 != 0 {
                    HashAlg::Sha256
                } else {
                    // Plain `ssh-rsa` means SHA-1: refused.
                    return None;
                };
                (rsa, Some(hash)).try_sign(data).ok()
            }
            _ => self.key.as_ref().try_sign(data).ok(),
        }
    }
}

fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(bytes);
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn u32(&mut self) -> Option<u32> {
        let (head, rest) = self.0.split_first_chunk::<4>()?;
        self.0 = rest;
        Some(u32::from_be_bytes(*head))
    }

    fn string(&mut self) -> Option<&'a [u8]> {
        let len = usize::try_from(self.u32()?).ok()?;
        if len > self.0.len() {
            return None;
        }
        let (s, rest) = self.0.split_at(len);
        self.0 = rest;
        Some(s)
    }
}

/// Serves agent requests on one forwarded channel until it closes or misbehaves.
pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, agent: ForwardedAgent) {
    loop {
        let mut len = [0u8; 4];
        if stream.read_exact(&mut len).await.is_err() {
            return;
        }
        let len = u32::from_be_bytes(len) as usize;
        if len == 0 || len > MAX_FRAME {
            return;
        }
        let mut request = vec![0u8; len];
        if stream.read_exact(&mut request).await.is_err() {
            return;
        }
        let reply = agent.respond(&request);
        let mut framed = Vec::with_capacity(reply.len() + 4);
        put_string(&mut framed, &reply);
        if stream.write_all(&framed).await.is_err() || stream.flush().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn agent(counter: &Arc<AtomicUsize>) -> ForwardedAgent {
        let key = crate::ClientKey::generate_ed25519().unwrap();
        let c = Arc::clone(counter);
        ForwardedAgent::new(
            &key,
            Arc::new(move || {
                c.fetch_add(1, Ordering::SeqCst);
            }),
        )
    }

    fn sign_request(blob: &[u8], data: &[u8], flags: u32) -> Vec<u8> {
        let mut r = vec![SSH_AGENTC_SIGN_REQUEST];
        put_string(&mut r, blob);
        put_string(&mut r, data);
        r.extend_from_slice(&flags.to_be_bytes());
        r
    }

    #[test]
    fn lists_one_key_and_signs_only_with_it() {
        let used = Arc::new(AtomicUsize::new(0));
        let a = agent(&used);
        let list = a.respond(&[SSH_AGENTC_REQUEST_IDENTITIES]);
        assert_eq!(list[0], SSH_AGENT_IDENTITIES_ANSWER);
        assert_eq!(&list[1..5], &1u32.to_be_bytes());
        let blob = a.public_blob().unwrap();
        let signed = a.respond(&sign_request(&blob, b"session data", 0));
        assert_eq!(signed[0], SSH_AGENT_SIGN_RESPONSE);
        assert_eq!(used.load(Ordering::SeqCst), 1, "every signature is reported");
        // The signature verifies against the key.
        let mut r = Reader(&signed[1..]);
        let sig_bytes = r.string().unwrap();
        let sig = <Signature as russh::keys::ssh_encoding::Decode>::decode(&mut &sig_bytes[..]).unwrap();
        use russh::keys::signature::Verifier;
        Verifier::<Signature>::verify(a.key.public_key().key_data(), b"session data", &sig).unwrap();
        // Another key's blob is refused and not reported.
        let other = crate::ClientKey::generate_ed25519().unwrap();
        let other_blob = other.private_key().public_key().to_bytes().unwrap();
        assert_eq!(a.respond(&sign_request(&other_blob, b"x", 0)), [SSH_AGENT_FAILURE]);
        assert_eq!(used.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn anything_but_list_and_sign_is_refused() {
        let a = agent(&Arc::new(AtomicUsize::new(0)));
        // Add identity (17), remove all (19), lock (22), extension (27), garbage, empty.
        for request in [vec![17u8, 0, 0, 0, 1, b'x'], vec![19], vec![22, 0, 0, 0, 0], vec![27], vec![200, 1, 2], vec![]]
        {
            assert_eq!(a.respond(&request), [SSH_AGENT_FAILURE], "{request:?}");
        }
        // Truncated sign request.
        assert_eq!(a.respond(&[SSH_AGENTC_SIGN_REQUEST, 0, 0, 0, 9, 1]), [SSH_AGENT_FAILURE]);
    }
}
