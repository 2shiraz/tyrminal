# Draft upstream issue: RSA signatures padded to whole 64-bit words

Status: **draft, not filed**. Tyrminal works around this in its own adapter
(`crates/ssh/src/rsa_sign.rs`, PR #64). The text below is for whoever decides to report it.
Nothing here has been posted anywhere.

Where to file: RustCrypto/RSA, since the encoding comes from there. RustCrypto/SSH (`ssh-key`)
could also normalise the length when it builds an `rsa-sha2-*` signature.

---

## `pkcs1v15::Signature` encodes to more bytes than the modulus for key sizes that are not a multiple of 64 bits

**Versions:**
- `rsa` 0.10.0-rc.18, and also rc.19 (the latest at the time of writing)
- `ssh-key` 0.7.0-rc.11
- `russh` 0.64.1
- `crypto-bigint`: whichever version those pull in

**What happens:** for an RSA key whose modulus is not a whole number of 64-bit limbs, for example 4000 or 4048 bits, `Signature::to_bytes()` / `to_vec()` / `Box<[u8]>::from(signature)` return `BoxedUint::to_be_bytes()`. That value is padded to the limb width:
- a 4048-bit key (506-byte modulus) gives a 512-byte signature;
- a 4000-bit key (500 bytes) gives 504 bytes.

The value itself is correct; only the leading zero bytes are extra.

**Why it matters:** RFC 8017 §8.2.1 says the signature is an octet string of length k, the modulus length in octets. RFC 8332 §3 requires the same for SSH `rsa-sha2-256` and `rsa-sha2-512`. OpenSSH rejects a signature longer than the modulus. Through `ssh-key`'s `Signer<Signature> for (&RsaKeypair, Option<HashAlg>)`, which copies `data.to_vec()` into the SSH signature, every SSH client built on these crates fails to authenticate with such keys. The server logs show the key being found and then the signature being refused:

```
Accepted key RSA SHA256:… found at …/authorized_keys:1
Failed publickey for … ssh2: RSA SHA256:…
```

Keys of 2048, 3072 and 4096 bits are unaffected, because their modulus is a whole number of limbs.

**Minimal reproduction** (no network needed):

```rust
use rsa::{RsaPrivateKey, pkcs1v15::SigningKey, signature::{Signer, SignatureEncoding}};
use sha2::Sha256;

let key = RsaPrivateKey::new(&mut rand::rng(), 2000).unwrap(); // any size % 64 != 0
let k = key.size(); // 250
let sig = SigningKey::<Sha256>::new(key).sign(b"message");
assert_eq!(sig.to_vec().len(), k); // fails: 256 != 250
```

With OpenSSH: generate a key with `ssh-keygen -t rsa -b 4048`, authorise it, and sign in with any client built on `russh` 0.64 and `ssh-key` 0.7.0-rc. The server refuses the signature.

**Expected:** the encoded signature is exactly k bytes, left-padded with zeros when the value has fewer significant bytes. `rsa` already has `uint_to_be_pad(input, padded_len)` for this, and its `TryFrom<&[u8]>` accepts both forms.

**Workaround we use:** sign through the SSH library's external-signer path, then strip leading zero bytes beyond k, left-pad to k, and check the length before encoding the SSH signature blob.
