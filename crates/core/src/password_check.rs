//! Compromised-password check (SEC-11) with a hash-prefix range query (k-anonymity).
//!
//! For each distinct stored password the core computes its SHA-1 hash and gives a range source
//! only the first five hexadecimal characters ([`HashPrefix`]). The source returns every known
//! hash suffix with that prefix and a count; the comparison happens here, on this device. The
//! password, its full hash and its suffix never leave the core.
//!
//! The check is off by default and runs only on an explicit request with the preference on.
//! The range source is pluggable: this build has none that reaches the network (an HTTPS client
//! in the release graph waits on an owner decision), and tests use a stub server on loopback.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use sha1::{Digest, Sha1};
use tyrminal_contracts::{
    ErrorCode, IpcError, PasswordCheckItem, PasswordCheckPreferences, PasswordCheckReport, PasswordCheckStatus,
    StoredPasswordKind,
};
use zeroize::Zeroizing;

use crate::error::{err, invalid};

/// Longest endpoint accepted, in bytes.
const MAX_ENDPOINT_LEN: usize = 512;
/// Largest range response read. Real responses are tens of kilobytes; padding keeps them under
/// about 1,000 lines of 40 bytes, so 1 MiB is generous and still bounded.
pub const MAX_RANGE_RESPONSE: usize = 1024 * 1024;
/// Lines accepted in one range response.
const MAX_RANGE_LINES: usize = 20_000;

/// The only part of a password's hash that is ever handed to a range source: five upper-case
/// hexadecimal characters. Built only from a hash, so it cannot carry anything else.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct HashPrefix(String);

impl HashPrefix {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl core::fmt::Debug for HashPrefix {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // A prefix is not secret (it is what gets sent), but keep it out of casual logs anyway.
        f.write_str("HashPrefix(..)")
    }
}

/// Upper-case hex SHA-1 of `password`, split into the 5-character prefix and 35-character suffix.
fn split_hash(password: &str) -> (HashPrefix, Zeroizing<String>) {
    let digest = Sha1::digest(password.as_bytes());
    let mut hex = Zeroizing::new(String::with_capacity(40));
    for byte in digest.iter() {
        use core::fmt::Write;
        let _ = write!(hex, "{byte:02X}");
    }
    (HashPrefix(hex[..5].to_owned()), Zeroizing::new(hex[5..].to_owned()))
}

/// Why a range lookup failed. Fixed sentences only: a failure never names a password.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeError {
    /// This build cannot reach a range endpoint.
    Unavailable,
    /// The endpoint could not be reached or answered with an error.
    Unreachable,
    /// The answer was not a range response (or was too large).
    Malformed,
}

/// Something that answers range queries. Production code passes the build's source; tests pass
/// a client for a stub server.
pub trait RangeSource: Send + Sync {
    /// Whether this source can make requests at all.
    fn available(&self) -> bool;
    /// The raw response body for `prefix` (with padding requested where the protocol allows).
    fn fetch<'a>(
        &'a self,
        endpoint: &'a str,
        prefix: &'a HashPrefix,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, RangeError>> + Send + 'a>>;
}

/// The range source of this build: none. Making the request needs an HTTPS client in the release
/// dependency graph, which `scripts/check-release.mjs` forbids until the owner decides.
#[derive(Debug)]
pub struct NoRangeSource;

pub const UNAVAILABLE_REASON: &str = "This build cannot contact a password-check service yet: it has no HTTPS client. The setting is kept for when it does.";

impl RangeSource for NoRangeSource {
    fn available(&self) -> bool {
        false
    }
    fn fetch<'a>(
        &'a self,
        _endpoint: &'a str,
        _prefix: &'a HashPrefix,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, RangeError>> + Send + 'a>> {
        Box::pin(async { Err(RangeError::Unavailable) })
    }
}

/// Checks a user-supplied endpoint: `https://host[:port]/path/` with no credentials, query,
/// fragment, whitespace or control characters. Returns it with a trailing `/`.
pub fn validate_endpoint(text: &str) -> Result<String, IpcError> {
    let bad =
        || invalid("The password-check address must be an https:// address without a user name, query or fragment.");
    if text.len() > MAX_ENDPOINT_LEN || text.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(bad());
    }
    let rest = text.strip_prefix("https://").ok_or_else(bad)?;
    let (authority, _path) = rest.split_once('/').unwrap_or((rest, ""));
    if authority.is_empty()
        || authority.contains('@')
        || authority.starts_with(':')
        || text.contains(['?', '#', '\\'])
        || !authority.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    {
        return Err(bad());
    }
    let mut out = text.to_owned();
    if !out.ends_with('/') {
        out.push('/');
    }
    Ok(out)
}

/// Finds `suffix` in a range response and returns its count (0: not present). Lines are
/// `SUFFIX:COUNT` with optional CR; entries with count 0 are padding and never match. Anything
/// else fails the lookup: a garbled answer is never read as "not found".
pub fn count_in_range(body: &[u8], suffix: &str) -> Result<u64, RangeError> {
    if body.len() > MAX_RANGE_RESPONSE {
        return Err(RangeError::Malformed);
    }
    let text = std::str::from_utf8(body).map_err(|_| RangeError::Malformed)?;
    let mut found = 0u64;
    for (index, line) in text.split('\n').enumerate() {
        if index >= MAX_RANGE_LINES {
            return Err(RangeError::Malformed);
        }
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        let (candidate, count) = line.split_once(':').ok_or(RangeError::Malformed)?;
        if candidate.len() != 35 || !candidate.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(RangeError::Malformed);
        }
        if count.is_empty() || count.len() > 20 || !count.bytes().all(|b| b.is_ascii_digit()) {
            return Err(RangeError::Malformed);
        }
        let count: u64 = count.parse().map_err(|_| RangeError::Malformed)?;
        if count > 0 && candidate.eq_ignore_ascii_case(suffix) {
            found = found.max(count);
        }
    }
    Ok(found)
}

/// A stored password to check, with where it lives.
pub(crate) struct StoredSecret {
    pub kind: StoredPasswordKind,
    pub label: String,
    pub secret: Zeroizing<String>,
}

fn range_error(e: RangeError) -> IpcError {
    match e {
        RangeError::Unavailable => err(ErrorCode::Unreachable, UNAVAILABLE_REASON),
        RangeError::Unreachable => {
            err(ErrorCode::Unreachable, "The password-check service could not be reached. Nothing was changed.")
        }
        RangeError::Malformed => err(
            ErrorCode::ProtocolError,
            "The password-check service sent an answer that is not a range response. Nothing was concluded.",
        ),
    }
}

/// What the settings page shows.
pub(crate) fn status(
    prefs: &PasswordCheckPreferences,
    source: &dyn RangeSource,
    secrets: &[StoredSecret],
) -> PasswordCheckStatus {
    let distinct: std::collections::HashSet<&str> = secrets.iter().map(|s| s.secret.as_str()).collect();
    PasswordCheckStatus {
        enabled: prefs.enabled,
        endpoint: prefs.endpoint.clone(),
        available: source.available(),
        unavailable_reason: (!source.available()).then(|| UNAVAILABLE_REASON.to_owned()),
        stored_passwords: u32::try_from(distinct.len()).unwrap_or(u32::MAX),
    }
}

/// Looks up every stored password, one request per distinct prefix. Refused unless the user
/// turned the check on. Any failed lookup fails the whole check (no partial "all clear").
pub(crate) async fn run(
    prefs: &PasswordCheckPreferences,
    source: &dyn RangeSource,
    secrets: Vec<StoredSecret>,
) -> Result<PasswordCheckReport, IpcError> {
    if !prefs.enabled {
        return Err(err(
            ErrorCode::InvalidInput,
            "Turn on the compromised-password check first. It is off until you do.",
        ));
    }
    let endpoint = validate_endpoint(&prefs.endpoint)?;
    if !source.available() {
        return Err(range_error(RangeError::Unavailable));
    }
    let hashed: Vec<(StoredSecret, HashPrefix, Zeroizing<String>)> = secrets
        .into_iter()
        .map(|s| {
            let (prefix, suffix) = split_hash(&s.secret);
            (s, prefix, suffix)
        })
        .collect();
    let mut bodies: HashMap<HashPrefix, Vec<u8>> = HashMap::new();
    for (_, prefix, _) in &hashed {
        if !bodies.contains_key(prefix) {
            let body = source.fetch(&endpoint, prefix).await.map_err(range_error)?;
            bodies.insert(prefix.clone(), body);
        }
    }
    let mut items = Vec::with_capacity(hashed.len());
    for (stored, prefix, suffix) in &hashed {
        let body = bodies.get(prefix).map_or(&[][..], Vec::as_slice);
        let breach_count = count_in_range(body, suffix).map_err(range_error)?;
        items.push(PasswordCheckItem { kind: stored.kind, label: stored.label.clone(), breach_count });
    }
    items.sort_by(|a, b| b.breach_count.cmp(&a.breach_count).then_with(|| a.label.cmp(&b.label)));
    Ok(PasswordCheckReport { items, requests: u32::try_from(bodies.len()).unwrap_or(u32::MAX) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_five_character_upper_hex_prefix_is_derived_for_sending() {
        // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 (well-known test vector).
        let (prefix, suffix) = split_hash("password");
        assert_eq!(prefix.as_str(), "5BAA6");
        assert_eq!(suffix.as_str(), "1E4C9B93F3F0682250B6CF8331B7EE68FD8");
        assert_eq!(format!("{prefix:?}"), "HashPrefix(..)");
        let (other, _) = split_hash("correct horse battery staple");
        assert_eq!(other.as_str().len(), 5);
        assert!(other.as_str().bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_lowercase()));
    }

    #[test]
    fn range_responses_are_parsed_strictly_and_padding_never_matches() {
        let suffix = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";
        let body = format!(
            "0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n{suffix}:10434004\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0\r\n"
        );
        assert_eq!(count_in_range(body.as_bytes(), suffix), Ok(10_434_004));
        // Case-insensitive; a trailing newline is fine.
        assert_eq!(count_in_range(format!("{}:3\n", suffix.to_lowercase()).as_bytes(), suffix), Ok(3));
        // Padding entries (count 0) for our own suffix are not a match.
        assert_eq!(count_in_range(format!("{suffix}:0\r\n").as_bytes(), suffix), Ok(0));
        assert_eq!(count_in_range(b"", suffix), Ok(0));

        for bad in [
            &b"<html>rate limited</html>"[..],
            b"1E4C9B93F3F0682250B6CF8331B7EE68FD8",
            b"1E4C9B93F3F0682250B6CF8331B7EE68FD:1",
            b"1E4C9B93F3F0682250B6CF8331B7EE68FD8X:1",
            b"1E4C9B93F3F0682250B6CF8331B7EE68FD8:-1",
            b"1E4C9B93F3F0682250B6CF8331B7EE68FD8:1e9",
            b"1E4C9B93F3F0682250B6CF8331B7EE68FD8:99999999999999999999999",
            b"ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ:1",
            b"\xff\xfe",
        ] {
            assert_eq!(count_in_range(bad, suffix), Err(RangeError::Malformed), "{:?}", String::from_utf8_lossy(bad));
        }
        let oversized = vec![b'A'; MAX_RANGE_RESPONSE + 1];
        assert_eq!(count_in_range(&oversized, suffix), Err(RangeError::Malformed));
        let too_many_lines = "\n".repeat(MAX_RANGE_LINES + 1);
        assert_eq!(count_in_range(too_many_lines.as_bytes(), suffix), Err(RangeError::Malformed));
    }

    #[test]
    fn endpoints_are_https_without_credentials_query_or_fragment() {
        assert_eq!(
            validate_endpoint("https://api.pwnedpasswords.com/range/").unwrap(),
            "https://api.pwnedpasswords.com/range/"
        );
        assert_eq!(
            validate_endpoint("https://mirror.example:8443/range").unwrap(),
            "https://mirror.example:8443/range/"
        );
        assert_eq!(validate_endpoint("https://[::1]/r/").unwrap(), "https://[::1]/r/");
        for bad in [
            "http://api.pwnedpasswords.com/range/",
            "https://user:pass@mirror.example/range/",
            "https://mirror.example/range/?x=1",
            "https://mirror.example/range/#x",
            "https:///range/",
            "https://mirror example/",
            "https://mirror.example/ra\nnge/",
            "https://evil.example\\@good.example/",
            "ftp://mirror.example/",
            "javascript:alert(1)",
            "",
        ] {
            assert!(validate_endpoint(bad).is_err(), "{bad:?}");
        }
        assert!(validate_endpoint(&format!("https://a.example/{}", "x".repeat(MAX_ENDPOINT_LEN))).is_err());
    }
}
