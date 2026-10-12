//! Opening a recording for playback (docs/crypto-format.md §11.4).

use aead_stream::DecryptorBE32;
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::{KeyInit, Payload};
use zeroize::Zeroizing;

use crate::format::{
    EndReason, Event, FLAG_LAST, FLAG_NEXT, FRAME_HEADER_LEN, HEADER_LEN, Header, LogIdentity, MAX_CIPHERTEXT_LEN,
    PAD_BLOCK, TAG_LEN,
};
use crate::{LogError, file_key};

/// The largest file the reader opens.
pub const MAX_LOG_LEN: u64 = 512 * 1024 * 1024;

/// How much of a recording could be authenticated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completeness {
    /// Every chunk authenticated and the recording ended normally.
    Complete(EndReason),
    /// The file stops before its final chunk, as when the application was closed or crashed while
    /// recording. Everything shown was authenticated.
    Incomplete,
    /// A chunk failed authentication or was malformed, or data follows the final chunk. Only the
    /// events before that point are returned; nothing after it is trusted.
    Damaged,
}

/// An opened recording. Every event in it was authenticated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Playback {
    pub started_unix_ms: u64,
    pub cols: u16,
    pub rows: u16,
    /// Everything after the start event, in order (including the end event of a complete one).
    pub events: Vec<Event>,
    pub completeness: Completeness,
}

/// Opens the recording `bytes`, which must belong to `expected`.
///
/// Fails outright when the file is not a recording, is another log's, or not even its first chunk
/// authenticates. Otherwise returns every event up to the first problem, with
/// [`Completeness`] saying how far it got.
pub fn read_log(logs_key: &[u8; 32], expected: &LogIdentity, bytes: &[u8]) -> Result<Playback, LogError> {
    if bytes.len() as u64 > MAX_LOG_LEN {
        return Err(LogError::TooLarge);
    }
    let header = Header::parse(bytes)?;
    if header.identity != *expected {
        return Err(LogError::WrongLog);
    }
    let aad = &bytes[..HEADER_LEN];
    let key = file_key(logs_key, &expected.log_id)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| LogError::Internal)?;
    let mut decryptor = Some(DecryptorBE32::from_aead(cipher, &header.nonce_prefix.into()));

    let mut rest = &bytes[HEADER_LEN..];
    let mut events: Vec<Event> = Vec::new();
    let mut start: Option<(u64, u16, u16)> = None;
    let completeness = loop {
        if rest.is_empty() {
            break Completeness::Incomplete;
        }
        let Some(decryptor_now) = decryptor.as_mut() else {
            // Bytes after the final chunk.
            break Completeness::Damaged;
        };
        let Some(frame_header) = rest.get(..FRAME_HEADER_LEN) else {
            // A frame header cut short: an interrupted write.
            break Completeness::Incomplete;
        };
        let flag = frame_header[0];
        let len = u32::from_be_bytes([frame_header[1], frame_header[2], frame_header[3], frame_header[4]]) as usize;
        if !(flag == FLAG_NEXT || flag == FLAG_LAST) || !(PAD_BLOCK + TAG_LEN..=MAX_CIPHERTEXT_LEN).contains(&len) {
            break Completeness::Damaged;
        }
        let Some(ciphertext) = rest.get(FRAME_HEADER_LEN..FRAME_HEADER_LEN + len) else {
            break Completeness::Incomplete;
        };
        rest = &rest[FRAME_HEADER_LEN + len..];
        let payload = Payload { msg: ciphertext, aad };
        let opened = if flag == FLAG_LAST {
            decryptor.take().and_then(|d| d.decrypt_last(payload).ok())
        } else {
            decryptor_now.decrypt_next(payload).ok()
        };
        let Some(framed) = opened.map(Zeroizing::new) else {
            if start.is_none() {
                return Err(LogError::Unreadable);
            }
            break Completeness::Damaged;
        };
        let Some(chunk_events) = unframe(&framed).and_then(Event::decode_all) else {
            break Completeness::Damaged;
        };
        let mut chunk_events = chunk_events.into_iter();
        if start.is_none() {
            match chunk_events.next() {
                Some(Event::Start { started_unix_ms, cols, rows }) => start = Some((started_unix_ms, cols, rows)),
                _ => return Err(LogError::Unreadable),
            }
        }
        let mut ended = None;
        let mut bad = false;
        for event in chunk_events {
            match event {
                Event::Start { .. } => bad = true,
                Event::End { reason, .. } => ended = Some(reason),
                _ if ended.is_some() => bad = true,
                _ => {}
            }
            if bad {
                break;
            }
            events.push(event);
        }
        // An end event belongs in the final chunk, and the final chunk must have one.
        match (bad, ended, flag == FLAG_LAST) {
            (false, None, false) => continue,
            (false, Some(reason), true) if rest.is_empty() => break Completeness::Complete(reason),
            _ => break Completeness::Damaged,
        }
    };
    let (started_unix_ms, cols, rows) = start.ok_or(LogError::Unreadable)?;
    Ok(Playback { started_unix_ms, cols, rows, events, completeness })
}

/// Strips the length prefix and checks the padding is all zero.
fn unframe(framed: &[u8]) -> Option<&[u8]> {
    if !framed.len().is_multiple_of(PAD_BLOCK) {
        return None;
    }
    let len = u32::from_be_bytes(framed.get(..4)?.try_into().ok()?) as usize;
    let payload = framed.get(4..4usize.checked_add(len)?)?;
    framed[4 + len..].iter().all(|&b| b == 0).then_some(payload)
}
