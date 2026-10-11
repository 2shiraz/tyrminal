//! Strict big-endian reader and Crockford base32. Encodings only; no cryptography.

use crate::VaultError;

/// Bounds-checked cursor over untrusted bytes. Every read is checked; nothing panics.
pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    pub(crate) fn take(&mut self, n: usize) -> Result<&'a [u8], VaultError> {
        let end = self.pos.checked_add(n).ok_or(VaultError::MalformedHeader)?;
        let slice = self
            .bytes
            .get(self.pos..end)
            .ok_or(VaultError::MalformedHeader)?;
        self.pos = end;
        Ok(slice)
    }

    pub(crate) fn array<const N: usize>(&mut self) -> Result<[u8; N], VaultError> {
        self.take(N)?
            .try_into()
            .map_err(|_| VaultError::MalformedHeader)
    }

    pub(crate) fn u8(&mut self) -> Result<u8, VaultError> {
        Ok(self.array::<1>()?[0])
    }

    pub(crate) fn u16(&mut self) -> Result<u16, VaultError> {
        Ok(u16::from_be_bytes(self.array()?))
    }

    pub(crate) fn u32(&mut self) -> Result<u32, VaultError> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    pub(crate) fn position(&self) -> usize {
        self.pos
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.pos == self.bytes.len()
    }
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Crockford base32, most significant bits first, final group zero-padded.
pub(crate) fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &b in bytes {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(CROCKFORD[((acc >> bits) & 31) as usize] as char);
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(CROCKFORD[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Decodes exactly `N` bytes. Rejects wrong lengths, foreign characters and non-zero trailing bits.
pub(crate) fn base32_decode<const N: usize>(symbols: &[u8]) -> Option<[u8; N]> {
    if symbols.len() != (N * 8).div_ceil(5) {
        return None;
    }
    let mut out = [0u8; N];
    let mut filled = 0usize;
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &s in symbols {
        let value = CROCKFORD.iter().position(|&c| c == s)? as u32;
        acc = (acc << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if filled == N {
                return None;
            }
            out[filled] = ((acc >> bits) & 0xff) as u8;
            filled += 1;
            acc &= (1 << bits) - 1;
        }
    }
    (filled == N && acc == 0).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_round_trips_and_rejects_bad_input() {
        let data: [u8; 34] = core::array::from_fn(|i| (i as u8).wrapping_mul(37).wrapping_add(11));
        let text = base32_encode(&data);
        assert_eq!(text.len(), 55);
        assert_eq!(base32_decode::<34>(text.as_bytes()), Some(data));
        assert_eq!(base32_decode::<34>(&text.as_bytes()[..54]), None);
        let mut bad = text.clone().into_bytes();
        bad[3] = b'U'; // not in the Crockford alphabet
        assert_eq!(base32_decode::<34>(&bad), None);
        // Non-zero trailing bits must be rejected so each key has one canonical text form.
        let mut trailing = text.into_bytes();
        let last = trailing.len() - 1;
        trailing[last] = b'Z';
        assert_eq!(base32_decode::<34>(&trailing), None);
    }

    #[test]
    fn reader_never_reads_past_the_end() {
        let mut r = Reader::new(&[1, 2, 3]);
        assert_eq!(r.u16().unwrap(), 0x0102);
        assert!(r.u16().is_err());
        assert_eq!(r.u8().unwrap(), 3);
        assert!(r.is_empty());
        assert!(r.take(usize::MAX).is_err());
    }
}
