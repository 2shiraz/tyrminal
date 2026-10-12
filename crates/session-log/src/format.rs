//! Header, chunk framing and event encoding (docs/crypto-format.md §11).

use crate::LogError;

pub const MAGIC: &[u8; 8] = b"TYRSLOG\0";
pub const FORMAT_VERSION: u16 = 1;
/// STREAM-BE32 over XChaCha20-Poly1305 leaves 24 − 5 = 19 bytes of nonce prefix.
pub(crate) const NONCE_PREFIX_LEN: usize = 19;
/// magic(8) || version(2) || vault_id(16) || log_id(16) || key_version(4) || nonce_prefix(19)
pub const HEADER_LEN: usize = 8 + 2 + 16 + 16 + 4 + NONCE_PREFIX_LEN;
pub(crate) const FILE_KEY_LABEL: &[u8] = b"tyrminal.log.v1.file";

/// Chunk plaintexts are padded to a multiple of this, so a file's size shows only how much was
/// printed, rounded up, per flush.
pub const PAD_BLOCK: usize = 1024;
/// Upper bound for the events in one chunk.
pub const MAX_CHUNK_PAYLOAD: usize = 64 * 1024;
pub(crate) const TAG_LEN: usize = 16;
/// flags(1) || ciphertext_len(4)
pub(crate) const FRAME_HEADER_LEN: usize = 5;
pub(crate) const FLAG_NEXT: u8 = 0;
pub(crate) const FLAG_LAST: u8 = 1;
/// kind(1) || at_ms(4) || len(4)
pub(crate) const EVENT_HEADER_LEN: usize = 9;

/// The largest framed chunk plaintext: length prefix, payload, padding.
pub(crate) const fn framed_len(payload_len: usize) -> usize {
    (4 + payload_len).div_ceil(PAD_BLOCK) * PAD_BLOCK
}
pub(crate) const MAX_CIPHERTEXT_LEN: usize = framed_len(MAX_CHUNK_PAYLOAD) + TAG_LEN;

/// What a recording belongs to. The reader refuses a file whose header names anything else, so
/// one log's file cannot stand in for another's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogIdentity {
    pub vault_id: [u8; 16],
    pub log_id: [u8; 16],
    pub key_version: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Header {
    pub identity: LogIdentity,
    pub nonce_prefix: [u8; NONCE_PREFIX_LEN],
}

impl Header {
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        let mut at = 0;
        for part in [
            &MAGIC[..],
            &FORMAT_VERSION.to_be_bytes(),
            &self.identity.vault_id,
            &self.identity.log_id,
            &self.identity.key_version.to_be_bytes(),
            &self.nonce_prefix,
        ] {
            out[at..at + part.len()].copy_from_slice(part);
            at += part.len();
        }
        out
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, LogError> {
        let header = bytes.get(..HEADER_LEN).ok_or(LogError::NotALog)?;
        if &header[..8] != MAGIC {
            return Err(LogError::NotALog);
        }
        if u16::from_be_bytes([header[8], header[9]]) != FORMAT_VERSION {
            return Err(LogError::UnsupportedVersion);
        }
        let take = |from: usize, to: usize| header[from..to].to_vec();
        let array16 = |v: Vec<u8>| -> [u8; 16] { v.try_into().unwrap_or([0; 16]) };
        Ok(Self {
            identity: LogIdentity {
                vault_id: array16(take(10, 26)),
                log_id: array16(take(26, 42)),
                key_version: u32::from_be_bytes([header[42], header[43], header[44], header[45]]),
            },
            nonce_prefix: take(46, HEADER_LEN).try_into().map_err(|_| LogError::Internal)?,
        })
    }
}

/// Why a recording ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    /// The session closed.
    Closed,
    /// The recording reached its size limit; the session went on unrecorded.
    SizeLimit,
    /// The vault was locked.
    Locked,
    /// The user stopped recording.
    Stopped,
}

impl EndReason {
    fn code(self) -> u8 {
        match self {
            Self::Closed => 0,
            Self::SizeLimit => 1,
            Self::Locked => 2,
            Self::Stopped => 3,
        }
    }

    fn from_code(code: u8) -> Option<Self> {
        Some(match code {
            0 => Self::Closed,
            1 => Self::SizeLimit,
            2 => Self::Locked,
            3 => Self::Stopped,
            _ => return None,
        })
    }
}

/// One entry of a recording. `at_ms` counts milliseconds from the start of the recording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Always the first event.
    Start {
        started_unix_ms: u64,
        cols: u16,
        rows: u16,
    },
    /// Bytes the terminal printed (untrusted: render with active escape actions disabled).
    Output {
        at_ms: u32,
        data: Vec<u8>,
    },
    Resize {
        at_ms: u32,
        cols: u16,
        rows: u16,
    },
    /// Always the last event of a complete recording.
    End {
        at_ms: u32,
        reason: EndReason,
    },
}

const KIND_START: u8 = 1;
const KIND_OUTPUT: u8 = 2;
const KIND_RESIZE: u8 = 3;
const KIND_END: u8 = 4;

impl Event {
    pub(crate) fn encoded_len(&self) -> usize {
        EVENT_HEADER_LEN
            + match self {
                Self::Start { .. } => 12,
                Self::Output { data, .. } => data.len(),
                Self::Resize { .. } => 4,
                Self::End { .. } => 1,
            }
    }

    pub(crate) fn encode_into(&self, out: &mut Vec<u8>) {
        let (kind, at_ms) = match self {
            Self::Start { .. } => (KIND_START, 0),
            Self::Output { at_ms, .. } => (KIND_OUTPUT, *at_ms),
            Self::Resize { at_ms, .. } => (KIND_RESIZE, *at_ms),
            Self::End { at_ms, .. } => (KIND_END, *at_ms),
        };
        let body_len = u32::try_from(self.encoded_len() - EVENT_HEADER_LEN).unwrap_or(u32::MAX);
        out.push(kind);
        out.extend_from_slice(&at_ms.to_be_bytes());
        out.extend_from_slice(&body_len.to_be_bytes());
        match self {
            Self::Start { started_unix_ms, cols, rows } => {
                out.extend_from_slice(&started_unix_ms.to_be_bytes());
                out.extend_from_slice(&cols.to_be_bytes());
                out.extend_from_slice(&rows.to_be_bytes());
            }
            Self::Output { data, .. } => out.extend_from_slice(data),
            Self::Resize { cols, rows, .. } => {
                out.extend_from_slice(&cols.to_be_bytes());
                out.extend_from_slice(&rows.to_be_bytes());
            }
            Self::End { reason, .. } => out.push(reason.code()),
        }
    }

    /// Decodes every event in one chunk's payload. `None` means the payload is malformed.
    pub(crate) fn decode_all(mut payload: &[u8]) -> Option<Vec<Self>> {
        let mut events = Vec::new();
        while !payload.is_empty() {
            let header = payload.get(..EVENT_HEADER_LEN)?;
            let kind = header[0];
            let at_ms = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
            let len = usize::try_from(u32::from_be_bytes([header[5], header[6], header[7], header[8]])).ok()?;
            let body = payload.get(EVENT_HEADER_LEN..EVENT_HEADER_LEN.checked_add(len)?)?;
            let u16_at = |i: usize| u16::from_be_bytes([body[i], body[i + 1]]);
            events.push(match (kind, len) {
                (KIND_START, 12) if at_ms == 0 => Self::Start {
                    started_unix_ms: u64::from_be_bytes(body[..8].try_into().ok()?),
                    cols: u16_at(8),
                    rows: u16_at(10),
                },
                (KIND_OUTPUT, _) => Self::Output { at_ms, data: body.to_vec() },
                (KIND_RESIZE, 4) => Self::Resize { at_ms, cols: u16_at(0), rows: u16_at(2) },
                (KIND_END, 1) => Self::End { at_ms, reason: EndReason::from_code(body[0])? },
                _ => return None,
            });
            payload = &payload[EVENT_HEADER_LEN + len..];
        }
        Some(events)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trips_and_rejects_foreign_or_newer_files() {
        let header = Header {
            identity: LogIdentity { vault_id: [1; 16], log_id: [2; 16], key_version: 7 },
            nonce_prefix: [3; NONCE_PREFIX_LEN],
        };
        let bytes = header.encode();
        assert_eq!(Header::parse(&bytes), Ok(header));
        assert_eq!(Header::parse(&bytes[..HEADER_LEN - 1]), Err(LogError::NotALog));
        let mut other = bytes;
        other[0] = b'X';
        assert_eq!(Header::parse(&other), Err(LogError::NotALog));
        let mut newer = bytes;
        newer[9] = 2;
        assert_eq!(Header::parse(&newer), Err(LogError::UnsupportedVersion));
    }

    #[test]
    fn events_round_trip_and_malformed_payloads_are_refused() {
        let events = vec![
            Event::Start { started_unix_ms: 1_700_000_000_000, cols: 80, rows: 24 },
            Event::Output { at_ms: 5, data: b"hello\r\n".to_vec() },
            Event::Resize { at_ms: 9, cols: 120, rows: 40 },
            Event::Output { at_ms: 10, data: Vec::new() },
            Event::End { at_ms: 11, reason: EndReason::Stopped },
        ];
        let mut payload = Vec::new();
        for event in &events {
            event.encode_into(&mut payload);
        }
        assert_eq!(payload.len(), events.iter().map(Event::encoded_len).sum::<usize>());
        assert_eq!(Event::decode_all(&payload), Some(events));
        assert_eq!(Event::decode_all(&payload[..payload.len() - 1]), None, "a cut event");
        assert_eq!(Event::decode_all(&[9, 0, 0, 0, 0, 0, 0, 0, 0]), None, "an unknown kind");
        assert_eq!(Event::decode_all(&[KIND_END, 0, 0, 0, 0, 0, 0, 0, 1, 9]), None, "an unknown end reason");
    }
}
