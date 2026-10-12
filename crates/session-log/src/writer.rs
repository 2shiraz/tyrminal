//! Appending a recording (docs/crypto-format.md §11.3).

use std::io::Write;

use aead_stream::EncryptorBE32;
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::{KeyInit, Payload};
use zeroize::Zeroizing;

use crate::format::{
    EVENT_HEADER_LEN, EndReason, Event, FLAG_LAST, FLAG_NEXT, FRAME_HEADER_LEN, HEADER_LEN, Header, LogIdentity,
    MAX_CHUNK_PAYLOAD, NONCE_PREFIX_LEN, PAD_BLOCK, TAG_LEN, framed_len,
};
use crate::{LogError, file_key};

/// The smallest size limit a recording accepts: the header, the start and end chunks.
pub const MIN_LOG_LIMIT: u64 = (HEADER_LEN + 2 * (FRAME_HEADER_LEN + PAD_BLOCK + TAG_LEN)) as u64;
/// Room kept free for the final chunk, so a recording that reaches its limit still ends cleanly.
const END_RESERVE: u64 = (FRAME_HEADER_LEN + PAD_BLOCK + TAG_LEN) as u64;
/// Largest output piece in one event, so every event fits in one chunk.
const MAX_OUTPUT_PIECE: usize = MAX_CHUNK_PAYLOAD - EVENT_HEADER_LEN;

/// Whether recording continues after a write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteStatus {
    Recording,
    /// The size limit was reached: the recording has been ended and further output is not kept.
    LimitReached,
}

/// Writes one recording to `out`. Events are buffered and written as encrypted chunks when
/// [`flush`](Self::flush) is called or a chunk is full; [`finish`](Self::finish) writes the final
/// chunk. A writer dropped without `finish` leaves a recording that reads as incomplete.
pub struct LogWriter<W: Write> {
    out: W,
    encryptor: Option<EncryptorBE32<XChaCha20Poly1305>>,
    header: [u8; HEADER_LEN],
    pending: Zeroizing<Vec<u8>>,
    written: u64,
    limit: u64,
}

impl<W: Write> std::fmt::Debug for LogWriter<W> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LogWriter")
            .field("written", &self.written)
            .field("limit", &self.limit)
            .field("finished", &self.encryptor.is_none())
            .finish_non_exhaustive()
    }
}

impl<W: Write> LogWriter<W> {
    /// Starts a recording: writes the header and the first chunk (the start event), so even a
    /// recording that is never finished shows when it began and at what size.
    pub fn start(
        logs_key: &[u8; 32],
        identity: LogIdentity,
        started_unix_ms: u64,
        cols: u16,
        rows: u16,
        limit: u64,
        out: W,
    ) -> Result<Self, LogError> {
        if limit < MIN_LOG_LIMIT {
            return Err(LogError::LimitTooSmall);
        }
        let mut nonce_prefix = [0u8; NONCE_PREFIX_LEN];
        getrandom::fill(&mut nonce_prefix).map_err(|_| LogError::Randomness)?;
        let header = Header { identity, nonce_prefix }.encode();
        let key = file_key(logs_key, &identity.log_id)?;
        let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| LogError::Internal)?;
        let encryptor = EncryptorBE32::from_aead(cipher, &nonce_prefix.into());
        let mut writer =
            Self { out, encryptor: Some(encryptor), header, pending: Zeroizing::new(Vec::new()), written: 0, limit };
        writer.out.write_all(&header).map_err(|_| LogError::Io)?;
        writer.written = HEADER_LEN as u64;
        Event::Start { started_unix_ms, cols, rows }.encode_into(&mut writer.pending);
        writer.flush()?;
        Ok(writer)
    }

    /// What has been written so far.
    pub fn get_ref(&self) -> &W {
        &self.out
    }

    /// Gives back `out` without finishing: what it holds then reads as an incomplete recording.
    pub fn into_inner(self) -> W {
        self.out
    }

    /// Bytes written to `out` so far.
    pub fn written(&self) -> u64 {
        self.written
    }

    /// Whether [`finish`](Self::finish) has run (or the size limit ended the recording).
    pub fn is_finished(&self) -> bool {
        self.encryptor.is_none()
    }

    /// Records terminal output. Empty output records nothing.
    pub fn output(&mut self, at_ms: u32, data: &[u8]) -> Result<WriteStatus, LogError> {
        for piece in data.chunks(MAX_OUTPUT_PIECE) {
            if self.push(Event::Output { at_ms, data: piece.to_vec() })? == WriteStatus::LimitReached {
                return Ok(WriteStatus::LimitReached);
            }
        }
        Ok(WriteStatus::Recording)
    }

    /// Records a terminal size change.
    pub fn resize(&mut self, at_ms: u32, cols: u16, rows: u16) -> Result<WriteStatus, LogError> {
        self.push(Event::Resize { at_ms, cols, rows })
    }

    fn push(&mut self, event: Event) -> Result<WriteStatus, LogError> {
        if self.encryptor.is_none() {
            return Err(LogError::Finished);
        }
        if self.pending.len() + event.encoded_len() > MAX_CHUNK_PAYLOAD {
            self.flush()?;
        }
        // Would this event, once flushed, leave too little room for the final chunk?
        let after = self.written + chunk_size(self.pending.len() + event.encoded_len()) + END_RESERVE;
        if after > self.limit {
            let at_ms = match &event {
                Event::Output { at_ms, .. } | Event::Resize { at_ms, .. } => *at_ms,
                _ => 0,
            };
            self.finish_inner(at_ms, EndReason::SizeLimit)?;
            return Ok(WriteStatus::LimitReached);
        }
        let mut encoded = Zeroizing::new(Vec::with_capacity(event.encoded_len()));
        event.encode_into(&mut encoded);
        drop(event);
        self.pending.extend_from_slice(&encoded);
        Ok(WriteStatus::Recording)
    }

    /// Encrypts and writes what is buffered as one chunk, then flushes `out`. A no-op when
    /// nothing is buffered.
    pub fn flush(&mut self) -> Result<(), LogError> {
        if self.pending.is_empty() {
            return self.out.flush().map_err(|_| LogError::Io);
        }
        let framed = frame(&self.pending);
        let encryptor = self.encryptor.as_mut().ok_or(LogError::Finished)?;
        let ciphertext =
            encryptor.encrypt_next(Payload { msg: &framed, aad: &self.header }).map_err(|_| LogError::Internal)?;
        self.pending.clear();
        self.write_frame(FLAG_NEXT, &ciphertext)?;
        self.out.flush().map_err(|_| LogError::Io)
    }

    /// Ends the recording: writes what is buffered and the end event as the final chunk.
    pub fn finish(mut self, at_ms: u32, reason: EndReason) -> Result<W, LogError> {
        self.finish_inner(at_ms, reason)?;
        Ok(self.out)
    }

    fn finish_inner(&mut self, at_ms: u32, reason: EndReason) -> Result<(), LogError> {
        let encryptor = self.encryptor.take().ok_or(LogError::Finished)?;
        let end = Event::End { at_ms, reason };
        if self.pending.len() + end.encoded_len() > MAX_CHUNK_PAYLOAD {
            // Put the encryptor back for one more ordinary chunk first.
            self.encryptor = Some(encryptor);
            self.flush()?;
            return self.finish_inner(at_ms, reason);
        }
        end.encode_into(&mut self.pending);
        let framed = frame(&self.pending);
        let ciphertext =
            encryptor.encrypt_last(Payload { msg: &framed, aad: &self.header }).map_err(|_| LogError::Internal)?;
        self.pending.clear();
        self.write_frame(FLAG_LAST, &ciphertext)?;
        self.out.flush().map_err(|_| LogError::Io)
    }

    fn write_frame(&mut self, flag: u8, ciphertext: &[u8]) -> Result<(), LogError> {
        let len = u32::try_from(ciphertext.len()).map_err(|_| LogError::Internal)?;
        let mut frame_header = [0u8; FRAME_HEADER_LEN];
        frame_header[0] = flag;
        frame_header[1..].copy_from_slice(&len.to_be_bytes());
        self.out.write_all(&frame_header).map_err(|_| LogError::Io)?;
        self.out.write_all(ciphertext).map_err(|_| LogError::Io)?;
        self.written += (FRAME_HEADER_LEN + ciphertext.len()) as u64;
        Ok(())
    }
}

/// On-disk size of a chunk holding `payload_len` bytes of events.
fn chunk_size(payload_len: usize) -> u64 {
    (FRAME_HEADER_LEN + framed_len(payload_len) + TAG_LEN) as u64
}

/// payload_len(4) || payload || zero padding to a multiple of [`PAD_BLOCK`].
fn frame(payload: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut framed = Zeroizing::new(Vec::with_capacity(framed_len(payload.len())));
    framed.extend_from_slice(&u32::try_from(payload.len()).unwrap_or(u32::MAX).to_be_bytes());
    framed.extend_from_slice(payload);
    framed.resize(framed_len(payload.len()), 0);
    framed
}
