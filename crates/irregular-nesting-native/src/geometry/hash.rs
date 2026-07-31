//! Rust port of the SHA-256 hex digest helper used throughout the
//! `src/workers/algorithm/irregular/*.ts` family to build stable identity
//! hashes.
//!
//! TS call sites all follow the same shape,
//! `createHash('sha256').update(<string>).digest('hex')`, e.g.:
//!   - `src/workers/algorithm/irregular/intrinsicQueueBeamDiscriminator.ts:2436-2437,2442`
//!   - `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts:1811,1842`
//!   - `src/workers/algorithm/irregular/intrinsicCapacityEndpoint.ts:195,244-246`
//!   - `src/workers/algorithm/irregular/intrinsicCapacitySearch.ts:1506-1507,1583-1584`
//!   - `src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts:1282`
//!   - `src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.ts:699`
//!   - `src/workers/algorithm/irregular/intrinsicShortSideObserver.ts:744`
//!   - `src/workers/algorithm/irregular/intrinsicShortSidePairFoldObserver.ts:1448`
//!   - `src/workers/algorithm/irregular/intrinsicStrictFamilyPortfolio.ts:234`
//!   - `src/workers/algorithm/irregular/intrinsicTransformSeparator.ts:204`
//!     (same digest, additionally prefixed with the literal `"sha256:"` by the
//!     caller -- that prefixing is the caller's responsibility, not this
//!     function's).
//!
//! Node's `crypto.Hash.update(str)` with no encoding argument treats `str` as
//! UTF-8 (`node:crypto` default `input_encoding` for a JS string is
//! `'utf8'`), and `.digest('hex')` renders the 32-byte SHA-256 digest as 64
//! lowercase hex characters, zero-padded per byte. [`sha256_hex`] reproduces
//! exactly that: UTF-8 encode, SHA-256, lowercase hex.

use sha2::{Digest, Sha256};

/// TS source: the `createHash('sha256').update(<string>).digest('hex')`
/// pattern repeated at the call sites listed in the module doc comment above.
///
/// Hashes the UTF-8 bytes of `input` with SHA-256 and returns the digest as a
/// 64-character lowercase hex string, byte-for-byte matching
/// `createHash('sha256').update(input).digest('hex')` in Node for any `input`.
///
/// A Rust `&str` is always well-formed UTF-8 by construction, so this covers
/// every value this function can be called with. Node's own conversion is
/// only equivalent to this for well-formed JS strings: a JS string containing
/// an unpaired UTF-16 surrogate (impossible to represent as a Rust `&str`)
/// gets each lone surrogate replaced with U+FFFD before hashing (verified
/// empirically: `createHash('sha256').update('a\uD800b').digest('hex')`
/// hashes the bytes of `"a�b"`, not a WTF-8 encoding of the surrogate).
/// Every call site listed above only ever hashes well-formed canonical-JSON /
/// joined-identity strings, so this never arises in practice; any future
/// N-API boundary that accepts raw untrusted JS strings is responsible for
/// deciding how to convert them to a Rust `String` (and thus how to handle
/// lone surrogates) before calling this function -- that conversion is not
/// this function's concern.
pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_empty_string_to_known_sha256_digest() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hashes_abc_to_known_sha256_digest() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn digest_is_64_lowercase_hex_characters() {
        let digest = sha256_hex("some canonical identity string");
        assert_eq!(digest.len(), 64);
        assert!(digest
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn hashes_utf8_multibyte_input_correctly() {
        // "café" — the 'é' is a 2-byte UTF-8 sequence; this pins that the
        // implementation hashes UTF-8 bytes, not UTF-16 code units or Latin-1.
        let digest = sha256_hex("café");
        assert_eq!(digest.len(), 64);
        // Known SHA-256("café") in UTF-8 (verified with `printf 'café' | sha256sum`).
        assert_eq!(
            digest,
            "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e"
        );
    }
}
