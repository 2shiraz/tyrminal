//! Security review (P-27, ADR 0011): reads facts the vault already holds and reports weak keys,
//! password sign-in, expiring certificates and stale or RSA-only known hosts. It runs on the
//! device only, changes nothing, and never sees a secret: the vault hands it public facts.

use std::collections::{BTreeMap, BTreeSet};

use tyrminal_contracts::{CERTIFICATE_WARNING_SECS, MIN_RSA_BITS, SecurityFinding, SecurityReview};

/// A key in the keychain, without its private part.
pub(crate) struct KeyFacts {
    pub id: String,
    pub label: String,
    pub algorithm: String,
    /// The OpenSSH public-key line (`<algorithm> <base64>`).
    pub public_key: String,
    pub passphrase_protected: bool,
    /// The passphrase is stored in the vault with the key.
    pub passphrase_stored: bool,
}

/// A user certificate attached to a key. `valid_before` is `u64::MAX` when it never expires.
pub(crate) struct CertificateFacts {
    pub key_id: String,
    pub valid_before: u64,
}

/// How a host signs in, as a connection would resolve it (identity, own setting, group).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SignIn {
    Key(String),
    StoredPassword,
    AskPassword,
}

pub(crate) struct HostFacts {
    pub id: String,
    pub label: String,
    /// Only SSH hosts are reviewed: Telnet and serial have no keys, host keys or SSH sign-in.
    pub ssh: bool,
    /// Canonical host (as trust is recorded) and effective port.
    pub endpoint: (String, u16),
    pub sign_in: SignIn,
}

pub(crate) struct KnownHostFacts {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
}

pub(crate) fn review(
    keys: &[KeyFacts],
    certificates: &[CertificateFacts],
    hosts: &[HostFacts],
    known_hosts: &[KnownHostFacts],
    now: u64,
) -> SecurityReview {
    let ssh_hosts: Vec<&HostFacts> = hosts.iter().filter(|h| h.ssh).collect();
    let mut used_by: BTreeMap<&str, u32> = BTreeMap::new();
    for host in &ssh_hosts {
        if let SignIn::Key(key_id) = &host.sign_in {
            *used_by.entry(key_id.as_str()).or_default() += 1;
        }
    }
    let labels: BTreeMap<&str, &str> = keys.iter().map(|k| (k.id.as_str(), k.label.as_str())).collect();

    let mut findings = Vec::new();
    for key in keys {
        let (key_id, label, used_by) =
            (key.id.clone(), key.label.clone(), used_by.get(key.id.as_str()).copied().unwrap_or(0));
        if key.algorithm == "ssh-dss" {
            findings.push(SecurityFinding::DsaKey { key_id: key_id.clone(), label: label.clone(), used_by });
        } else if key.algorithm == "ssh-rsa"
            && let Some(bits) = tyrminal_ssh::rsa_public_key_bits(&key.public_key)
            && bits < MIN_RSA_BITS
        {
            findings.push(SecurityFinding::ShortRsaKey { key_id: key_id.clone(), label: label.clone(), bits, used_by });
        }
        if !key.passphrase_protected || key.passphrase_stored {
            let passphrase_stored = key.passphrase_protected;
            findings.push(SecurityFinding::KeyWithoutPassphrase { key_id, label, passphrase_stored, used_by });
        }
    }
    for host in &ssh_hosts {
        let stored = match host.sign_in {
            SignIn::Key(_) => continue,
            SignIn::StoredPassword => true,
            SignIn::AskPassword => false,
        };
        findings.push(SecurityFinding::PasswordSignIn { host_id: host.id.clone(), label: host.label.clone(), stored });
    }
    for cert in certificates {
        let label = labels.get(cert.key_id.as_str()).map_or_else(String::new, |l| (*l).to_owned());
        let (key_id, valid_before) = (cert.key_id.clone(), cert.valid_before);
        if valid_before <= now {
            findings.push(SecurityFinding::CertificateExpired { key_id, label, valid_before });
        } else if valid_before - now <= CERTIFICATE_WARNING_SECS {
            findings.push(SecurityFinding::CertificateExpiring { key_id, label, valid_before });
        }
    }
    let used_endpoints: BTreeSet<(&str, u16)> =
        ssh_hosts.iter().map(|h| (h.endpoint.0.as_str(), h.endpoint.1)).collect();
    // Endpoints that have at least one trusted key other than `ssh-rsa`.
    let stronger: BTreeSet<(&str, u16)> =
        known_hosts.iter().filter(|k| k.algorithm != "ssh-rsa").map(|k| (k.host.as_str(), k.port)).collect();
    for known in known_hosts {
        let endpoint = (known.host.as_str(), known.port);
        if !used_endpoints.contains(&endpoint) {
            findings.push(SecurityFinding::UnusedKnownHost {
                known_host_id: known.id.clone(),
                host: known.host.clone(),
                port: known.port,
                algorithm: known.algorithm.clone(),
                fingerprint: known.fingerprint.clone(),
            });
        }
        if known.algorithm == "ssh-rsa" && !stronger.contains(&endpoint) {
            findings.push(SecurityFinding::SshRsaOnlyKnownHost {
                known_host_id: known.id.clone(),
                host: known.host.clone(),
                port: known.port,
                fingerprint: known.fingerprint.clone(),
            });
        }
    }
    // Most serious first; within a severity, grouped by kind (declaration order) then by name.
    findings.sort_by_cached_key(|f| (f.severity(), kind_rank(f), sort_name(f)));

    SecurityReview {
        findings,
        keys: count(keys.len()),
        hosts: count(ssh_hosts.len()),
        certificates: count(certificates.len()),
        known_hosts: count(known_hosts.len()),
        reviewed_at: now,
    }
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn kind_rank(f: &SecurityFinding) -> u8 {
    match f {
        SecurityFinding::DsaKey { .. } => 0,
        SecurityFinding::ShortRsaKey { .. } => 1,
        SecurityFinding::CertificateExpired { .. } => 2,
        SecurityFinding::CertificateExpiring { .. } => 3,
        SecurityFinding::PasswordSignIn { .. } => 4,
        SecurityFinding::KeyWithoutPassphrase { .. } => 5,
        SecurityFinding::UnusedKnownHost { .. } => 6,
        SecurityFinding::SshRsaOnlyKnownHost { .. } => 7,
    }
}

fn sort_name(f: &SecurityFinding) -> (String, u16) {
    match f {
        SecurityFinding::DsaKey { label, .. }
        | SecurityFinding::ShortRsaKey { label, .. }
        | SecurityFinding::KeyWithoutPassphrase { label, .. }
        | SecurityFinding::PasswordSignIn { label, .. }
        | SecurityFinding::CertificateExpired { label, .. }
        | SecurityFinding::CertificateExpiring { label, .. } => (label.to_lowercase(), 0),
        SecurityFinding::UnusedKnownHost { host, port, .. }
        | SecurityFinding::SshRsaOnlyKnownHost { host, port, .. } => (host.clone(), *port),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use tyrminal_contracts::FindingSeverity;

    use super::*;

    const RSA_1024: &str = include_str!("../../../tests/fixtures/review/rsa1024.pub");
    const RSA_2048: &str = include_str!("../../../tests/fixtures/review/rsa2048.pub");
    const RSA_3072: &str = include_str!("../../../tests/fixtures/review/rsa3072.pub");
    const DSA: &str = include_str!("../../../tests/fixtures/review/dsa.pub");
    const NOW: u64 = 1_800_000_000;
    const DAY: u64 = 24 * 60 * 60;

    fn key(id: &str, line: &str, protected: bool) -> KeyFacts {
        KeyFacts {
            id: id.into(),
            label: format!("{id} key"),
            algorithm: line.split_whitespace().next().unwrap().into(),
            public_key: line.trim().into(),
            passphrase_protected: protected,
            passphrase_stored: false,
        }
    }

    fn host(id: &str, address: &str, port: u16, sign_in: SignIn) -> HostFacts {
        HostFacts { id: id.into(), label: id.into(), ssh: true, endpoint: (address.into(), port), sign_in }
    }

    fn known(id: &str, host: &str, port: u16, algorithm: &str) -> KnownHostFacts {
        KnownHostFacts {
            id: id.into(),
            host: host.into(),
            port,
            algorithm: algorithm.into(),
            fingerprint: format!("SHA256:{id}"),
        }
    }

    #[test]
    fn rsa_sizes_come_from_the_public_key() {
        assert_eq!(tyrminal_ssh::rsa_public_key_bits(RSA_1024), Some(1024));
        assert_eq!(tyrminal_ssh::rsa_public_key_bits(RSA_2048), Some(2048));
        assert_eq!(tyrminal_ssh::rsa_public_key_bits(RSA_3072), Some(3072));
        assert_eq!(tyrminal_ssh::rsa_public_key_bits(DSA), None);
        assert_eq!(tyrminal_ssh::rsa_public_key_bits("ssh-rsa not-base64"), None);
    }

    #[test]
    fn weak_and_unprotected_keys_are_reported_with_the_hosts_that_use_them() {
        let keys = [
            key("dsa", DSA, true),
            key("rsa1024", RSA_1024, true),
            key("rsa2048", RSA_2048, true),
            key("rsa3072", RSA_3072, true),
            key("plain", RSA_3072, false),
            KeyFacts { passphrase_stored: true, ..key("remembered", RSA_3072, true) },
        ];
        let hosts = [
            host("a", "a.example", 22, SignIn::Key("rsa2048".into())),
            host("b", "b.example", 22, SignIn::Key("rsa2048".into())),
            // A Telnet host never counts as using a key.
            HostFacts { ssh: false, ..host("t", "t.example", 23, SignIn::Key("dsa".into())) },
        ];
        let review = review(&keys, &[], &hosts, &[], NOW);
        assert_eq!(
            review.findings,
            vec![
                SecurityFinding::DsaKey { key_id: "dsa".into(), label: "dsa key".into(), used_by: 0 },
                SecurityFinding::ShortRsaKey {
                    key_id: "rsa1024".into(),
                    label: "rsa1024 key".into(),
                    bits: 1024,
                    used_by: 0
                },
                SecurityFinding::ShortRsaKey {
                    key_id: "rsa2048".into(),
                    label: "rsa2048 key".into(),
                    bits: 2048,
                    used_by: 2
                },
                SecurityFinding::KeyWithoutPassphrase {
                    key_id: "plain".into(),
                    label: "plain key".into(),
                    passphrase_stored: false,
                    used_by: 0
                },
                SecurityFinding::KeyWithoutPassphrase {
                    key_id: "remembered".into(),
                    label: "remembered key".into(),
                    passphrase_stored: true,
                    used_by: 0
                },
            ]
        );
        assert_eq!(review.findings[1].severity(), FindingSeverity::High);
        assert_eq!(review.findings[2].severity(), FindingSeverity::Medium);
        assert_eq!((review.keys, review.hosts), (6, 2));
    }

    #[test]
    fn password_sign_in_is_reported_only_for_ssh_hosts() {
        let hosts = [
            host("stored", "s.example", 22, SignIn::StoredPassword),
            host("asked", "a.example", 22, SignIn::AskPassword),
            host("keyed", "k.example", 22, SignIn::Key("k".into())),
            HostFacts { ssh: false, ..host("telnet", "t.example", 23, SignIn::AskPassword) },
        ];
        let review = review(&[], &[], &hosts, &[], NOW);
        assert_eq!(
            review.findings,
            vec![
                SecurityFinding::PasswordSignIn { host_id: "asked".into(), label: "asked".into(), stored: false },
                SecurityFinding::PasswordSignIn { host_id: "stored".into(), label: "stored".into(), stored: true },
            ]
        );
    }

    #[test]
    fn certificates_are_reported_when_expired_or_within_thirty_days() {
        let keys = [key("k1", RSA_3072, true), key("k2", RSA_3072, true), key("k3", RSA_3072, true)];
        let certs = [
            CertificateFacts { key_id: "k1".into(), valid_before: NOW },
            CertificateFacts { key_id: "k2".into(), valid_before: NOW + 30 * DAY },
            CertificateFacts { key_id: "k3".into(), valid_before: NOW + 30 * DAY + 1 },
            CertificateFacts { key_id: "gone".into(), valid_before: u64::MAX },
        ];
        let review = review(&keys, &certs, &[], &[], NOW);
        assert_eq!(
            review.findings,
            vec![
                SecurityFinding::CertificateExpired { key_id: "k1".into(), label: "k1 key".into(), valid_before: NOW },
                SecurityFinding::CertificateExpiring {
                    key_id: "k2".into(),
                    label: "k2 key".into(),
                    valid_before: NOW + 30 * DAY
                },
            ]
        );
        assert_eq!(review.certificates, 4);
    }

    #[test]
    fn known_hosts_are_reported_when_unused_or_ssh_rsa_only() {
        let hosts = [
            host("web", "web.example", 22, SignIn::Key("k".into())),
            host("db", "db.example", 2222, SignIn::Key("k".into())),
        ];
        let known = [
            known("web-ed", "web.example", 22, "ssh-ed25519"),
            // Another key type next to it: not "only ssh-rsa".
            known("web-rsa", "web.example", 22, "ssh-rsa"),
            known("db-rsa", "db.example", 2222, "ssh-rsa"),
            // An ECDSA key next to it: not RSA-only.
            known("db-ecdsa", "db.example", 2222, "ecdsa-sha2-nistp256"),
            known("old-rsa", "old.example", 22, "ssh-rsa"),
            // Same address, other port: not the host's endpoint.
            known("web-2222", "web.example", 2222, "ssh-ed25519"),
        ];
        let review = review(&[], &[], &hosts, &known, NOW);
        let ids: Vec<(&str, &str)> = review
            .findings
            .iter()
            .map(|f| match f {
                SecurityFinding::SshRsaOnlyKnownHost { known_host_id, .. } => ("rsa-only", known_host_id.as_str()),
                SecurityFinding::UnusedKnownHost { known_host_id, .. } => ("unused", known_host_id.as_str()),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(ids, vec![("unused", "old-rsa"), ("unused", "web-2222"), ("rsa-only", "old-rsa")]);
        assert_eq!(review.known_hosts, 6);
    }

    #[test]
    fn findings_carry_no_secret_and_serialize_as_the_renderer_expects() {
        let review = review(
            &[key("plain", RSA_3072, false)],
            &[],
            &[host("h", "h.example", 22, SignIn::StoredPassword)],
            &[],
            NOW,
        );
        let json = serde_json::to_string(&review).unwrap();
        assert!(json.contains(r#"{"kind":"password_sign_in","hostId":"h","label":"h","stored":true}"#), "{json}");
        assert!(json.contains(r#""kind":"key_without_passphrase","keyId":"plain""#), "{json}");
        assert!(json.contains(r#""reviewedAt":1800000000"#), "{json}");
        // Only public facts go in: the public key line is not even repeated.
        assert!(!json.contains("AAAA"), "{json}");
    }
}
