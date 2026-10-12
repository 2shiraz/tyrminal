//! Telnet (CON-05, RFC 854/855). A legacy, unencrypted protocol: everything, including
//! passwords typed at the server's login prompt, crosses the network in plain text. The UI says
//! so before every connection; nothing here stores or sends credentials by itself.
//!
//! [`Codec`] is the whole protocol: it removes option negotiation from the server's bytes and
//! answers it, and escapes what the user types. Only the options a terminal needs are agreed to
//! (echo and suppress-go-ahead from the server; window size and terminal type from us); every
//! other request is refused, as the RFC requires, so the server cannot switch on anything else.

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

const TTYPE_SEND: u8 = 1;
const TTYPE_IS: u8 = 0;

/// Longest subnegotiation kept; longer ones are discarded (a misbehaving server cannot make
/// the client buffer without bound).
const MAX_SUBNEGOTIATION: usize = 64;

const TERMINAL_TYPE: &[u8] = b"XTERM-256COLOR";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Data,
    Iac,
    Command(u8),
    Sub,
    SubIac,
}

#[derive(Debug)]
pub(crate) struct Codec {
    state: State,
    sub: Vec<u8>,
    naws: bool,
    size: (u16, u16),
    /// Options already answered, so a repeated request gets no second reply.
    answered: [bool; 256],
}

impl Codec {
    pub(crate) fn new(cols: u16, rows: u16) -> Self {
        Self { state: State::Data, sub: Vec::new(), naws: false, size: (cols, rows), answered: [false; 256] }
    }

    /// Splits bytes from the server into terminal output and replies to send back.
    pub(crate) fn receive(&mut self, input: &[u8], output: &mut Vec<u8>, reply: &mut Vec<u8>) {
        for &b in input {
            self.state = match (self.state, b) {
                (State::Data, IAC) => State::Iac,
                (State::Data, _) => {
                    output.push(b);
                    State::Data
                }
                (State::Iac, IAC) => {
                    output.push(IAC);
                    State::Data
                }
                (State::Iac, DO | DONT | WILL | WONT) => State::Command(b),
                (State::Iac, SB) => {
                    self.sub.clear();
                    State::Sub
                }
                // NOP, go-ahead, data mark and the like carry nothing for a terminal.
                (State::Iac, _) => State::Data,
                (State::Command(command), option) => {
                    self.negotiate(command, option, reply);
                    State::Data
                }
                (State::Sub, IAC) => State::SubIac,
                (State::Sub, _) => {
                    if self.sub.len() < MAX_SUBNEGOTIATION {
                        self.sub.push(b);
                    }
                    State::Sub
                }
                (State::SubIac, SE) => {
                    self.subnegotiation(reply);
                    State::Data
                }
                (State::SubIac, IAC) => {
                    if self.sub.len() < MAX_SUBNEGOTIATION {
                        self.sub.push(IAC);
                    }
                    State::Sub
                }
                (State::SubIac, _) => State::Sub,
            };
        }
    }

    fn negotiate(&mut self, command: u8, option: u8, reply: &mut Vec<u8>) {
        match (command, option) {
            // The server echoes and needs no go-ahead: what a character terminal expects.
            (WILL, OPT_ECHO | OPT_SGA) => self.answer_once(DO, option, reply),
            (DO, OPT_SGA) => self.answer_once(WILL, option, reply),
            (DO, OPT_TTYPE) => self.answer_once(WILL, option, reply),
            (DO, OPT_NAWS) => {
                if !self.naws {
                    self.naws = true;
                    reply.extend_from_slice(&[IAC, WILL, OPT_NAWS]);
                }
                self.push_size(reply);
            }
            (DONT, OPT_NAWS) => {
                if self.naws {
                    self.naws = false;
                    reply.extend_from_slice(&[IAC, WONT, OPT_NAWS]);
                }
            }
            // Everything else is refused (and a refusal is acknowledged only once per option).
            (WILL, _) => self.answer_once(DONT, option, reply),
            (DO, _) => self.answer_once(WONT, option, reply),
            _ => {}
        }
    }

    fn answer_once(&mut self, command: u8, option: u8, reply: &mut Vec<u8>) {
        // Answering the same request twice can make two implementations loop forever.
        let slot = usize::from(option);
        if !self.answered[slot] {
            self.answered[slot] = true;
            reply.extend_from_slice(&[IAC, command, option]);
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        if self.sub.as_slice() == [OPT_TTYPE, TTYPE_SEND] {
            reply.extend_from_slice(&[IAC, SB, OPT_TTYPE, TTYPE_IS]);
            reply.extend_from_slice(TERMINAL_TYPE);
            reply.extend_from_slice(&[IAC, SE]);
        }
    }

    /// The window size changed; returns what to send (nothing unless the server asked for it).
    pub(crate) fn resize(&mut self, cols: u16, rows: u16) -> Vec<u8> {
        self.size = (cols, rows);
        let mut out = Vec::new();
        if self.naws {
            self.push_size(&mut out);
        }
        out
    }

    fn push_size(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&[IAC, SB, OPT_NAWS]);
        for byte in self.size.0.to_be_bytes().into_iter().chain(self.size.1.to_be_bytes()) {
            out.push(byte);
            // A 255 inside a subnegotiation is doubled like anywhere else.
            if byte == IAC {
                out.push(IAC);
            }
        }
        out.extend_from_slice(&[IAC, SE]);
    }
}

/// What the user typed, as Telnet sends it: IAC doubled, and a bare CR followed by NUL.
pub(crate) fn encode_input(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 4);
    let mut iter = data.iter().peekable();
    while let Some(&b) = iter.next() {
        match b {
            IAC => out.extend_from_slice(&[IAC, IAC]),
            b'\r' if iter.peek() != Some(&&b'\n') => out.extend_from_slice(b"\r\0"),
            _ => out.push(b),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(codec: &mut Codec, input: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let (mut out, mut reply) = (Vec::new(), Vec::new());
        codec.receive(input, &mut out, &mut reply);
        (out, reply)
    }

    #[test]
    fn negotiation_is_removed_from_output_and_answered() {
        let mut c = Codec::new(100, 30);
        let (out, reply) = feed(&mut c, &[b'h', IAC, WILL, OPT_ECHO, b'i', IAC, DO, OPT_NAWS, IAC, DO, OPT_TTYPE]);
        assert_eq!(out, b"hi");
        assert_eq!(
            reply,
            [IAC, DO, OPT_ECHO, IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 100, 0, 30, IAC, SE, IAC, WILL, OPT_TTYPE]
        );
        let (_, reply) = feed(&mut c, &[IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
        assert_eq!(&reply[..4], &[IAC, SB, OPT_TTYPE, TTYPE_IS]);
        assert!(reply.ends_with(b"XTERM-256COLOR\xff\xf0"));
        assert_eq!(c.resize(120, 40), [IAC, SB, OPT_NAWS, 0, 120, 0, 40, IAC, SE]);
    }

    #[test]
    fn anything_else_is_refused_once_and_split_sequences_work() {
        let mut c = Codec::new(80, 24);
        // Linemode (34), environment (39), X display (35), binary (0): all refused.
        let (out, reply) = feed(&mut c, &[IAC, DO, 34, IAC, WILL, 0, IAC, DO, 39, IAC, DO, 35]);
        assert!(out.is_empty());
        assert_eq!(reply, [IAC, WONT, 34, IAC, DONT, 0, IAC, WONT, 39, IAC, WONT, 35]);
        let (_, again) = feed(&mut c, &[IAC, DO, 34]);
        assert!(again.is_empty(), "a repeated request is not answered again");
        // A sequence split across reads, and a literal 255 in the data.
        let (out1, _) = feed(&mut c, &[b'a', IAC]);
        let (out2, _) = feed(&mut c, &[IAC, b'b', IAC]);
        let (out3, reply) = feed(&mut c, &[WILL, OPT_SGA]);
        assert_eq!([out1, out2, out3].concat(), [b'a', IAC, b'b']);
        assert_eq!(reply, [IAC, DO, OPT_SGA]);
    }

    #[test]
    fn subnegotiations_are_bounded_and_window_sizes_escape_255() {
        let mut c = Codec::new(80, 24);
        let mut flood = vec![IAC, SB, OPT_TTYPE];
        flood.extend(std::iter::repeat_n(b'x', 10_000));
        flood.extend_from_slice(&[IAC, SE, b'k']);
        let (out, reply) = feed(&mut c, &flood);
        assert_eq!(out, b"k");
        assert!(reply.is_empty());
        assert!(c.sub.len() <= MAX_SUBNEGOTIATION);
        feed(&mut c, &[IAC, DO, OPT_NAWS]);
        assert_eq!(c.resize(255, 24), [IAC, SB, OPT_NAWS, 0, IAC, IAC, 0, 24, IAC, SE]);
    }

    #[test]
    fn input_doubles_iac_and_sends_cr_as_cr_nul() {
        assert_eq!(encode_input(b"ls\r"), b"ls\r\0");
        assert_eq!(encode_input(b"a\r\nb"), b"a\r\nb");
        assert_eq!(encode_input(&[b'x', IAC, b'y']), [b'x', IAC, IAC, b'y']);
    }
}
