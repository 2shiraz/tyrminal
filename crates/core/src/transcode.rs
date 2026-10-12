//! Legacy character encodings (TRM-05). The renderer only ever handles UTF-8: output from a
//! host that uses another encoding is converted here, in order and across reads (a character
//! split between two reads is completed by the next), and typed text is converted back.

use encoding_rs::{Decoder, Encoder, Encoding};
use tyrminal_contracts::TerminalEncoding;

pub(crate) struct Transcoder {
    decoder: Decoder,
    encoder: Encoder,
}

fn encoding(e: TerminalEncoding) -> &'static Encoding {
    match e {
        TerminalEncoding::Utf8 => encoding_rs::UTF_8,
        // The WHATWG standard maps ISO-8859-1 to windows-1252, a superset for printable text.
        TerminalEncoding::Iso8859_1 | TerminalEncoding::Windows1252 => encoding_rs::WINDOWS_1252,
        TerminalEncoding::Iso8859_15 => encoding_rs::ISO_8859_15,
        TerminalEncoding::Koi8R => encoding_rs::KOI8_R,
        TerminalEncoding::ShiftJis => encoding_rs::SHIFT_JIS,
        TerminalEncoding::EucJp => encoding_rs::EUC_JP,
        TerminalEncoding::EucKr => encoding_rs::EUC_KR,
        TerminalEncoding::Gbk => encoding_rs::GBK,
        TerminalEncoding::Gb18030 => encoding_rs::GB18030,
        TerminalEncoding::Big5 => encoding_rs::BIG5,
    }
}

impl Transcoder {
    /// `None` for UTF-8, which needs no conversion.
    pub(crate) fn new(e: TerminalEncoding) -> Option<Self> {
        if e == TerminalEncoding::Utf8 {
            return None;
        }
        let enc = encoding(e);
        Some(Self { decoder: enc.new_decoder_without_bom_handling(), encoder: enc.new_encoder() })
    }

    /// Server bytes to UTF-8. Invalid sequences become U+FFFD; an incomplete trailing
    /// character waits for the next read.
    pub(crate) fn decode(&mut self, input: &[u8]) -> Vec<u8> {
        let mut out =
            String::with_capacity(self.decoder.max_utf8_buffer_length(input.len()).unwrap_or(input.len() * 3));
        let (_, _, _) = self.decoder.decode_to_string(input, &mut out, false);
        out.into_bytes()
    }

    /// Typed UTF-8 to the host's encoding; unrepresentable characters become `?` (never an
    /// HTML entity, which a shell would run as text).
    pub(crate) fn encode(&mut self, input: &[u8]) -> Vec<u8> {
        let text = String::from_utf8_lossy(input);
        let mut out = Vec::with_capacity(text.len() * 2 + 8);
        for ch in text.chars() {
            let mut buf = [0u8; 4];
            let piece = ch.encode_utf8(&mut buf);
            let mut encoded = Vec::with_capacity(8);
            encoded.resize(self.encoder.max_buffer_length_from_utf8_without_replacement(piece.len()).unwrap_or(8), 0);
            let (result, _, written) = self.encoder.encode_from_utf8_without_replacement(piece, &mut encoded, false);
            match result {
                encoding_rs::EncoderResult::InputEmpty => out.extend_from_slice(&encoded[..written]),
                _ => out.push(b'?'),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_needs_no_conversion() {
        assert!(Transcoder::new(TerminalEncoding::Utf8).is_none());
    }

    #[test]
    fn latin_and_cyrillic_round_trip() {
        let mut t = Transcoder::new(TerminalEncoding::Iso8859_15).unwrap();
        assert_eq!(t.decode(&[b'c', 0xE9, 0xA4]), "cé€".as_bytes());
        assert_eq!(t.encode("cé€".as_bytes()), [b'c', 0xE9, 0xA4]);
        let mut k = Transcoder::new(TerminalEncoding::Koi8R).unwrap();
        assert_eq!(k.decode(&[0xF0, 0xD2, 0xC9]), "При".as_bytes());
        assert_eq!(k.encode("При".as_bytes()), [0xF0, 0xD2, 0xC9]);
    }

    #[test]
    fn a_character_split_across_reads_is_completed_and_escapes_pass_through() {
        let mut t = Transcoder::new(TerminalEncoding::ShiftJis).unwrap();
        // "日本" in Shift_JIS is 93 FA 96 7B; split in the middle of the first character.
        let mut out = t.decode(&[0x1B, b'[', b'1', b'm', 0x93]);
        out.extend(t.decode(&[0xFA, 0x96, 0x7B]));
        assert_eq!(out, "\u{1b}[1m日本".as_bytes());
        assert_eq!(t.encode("日本".as_bytes()), [0x93, 0xFA, 0x96, 0x7B]);
    }

    #[test]
    fn unrepresentable_input_becomes_a_question_mark_never_an_entity() {
        let mut t = Transcoder::new(TerminalEncoding::Windows1252).unwrap();
        assert_eq!(t.encode("a日b".as_bytes()), b"a?b");
        let mut k = Transcoder::new(TerminalEncoding::EucKr).unwrap();
        assert_eq!(k.encode("ok😀".as_bytes()), b"ok?");
    }
}
