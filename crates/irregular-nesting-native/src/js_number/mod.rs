//! JS `Number` semantics primitives.
//!
//! This module is the shared foundation every canonical-key, cache-key, and
//! checkpoint-hash builder in the rest of the crate must route through for any
//! operation the TypeScript reference performs with JavaScript `Number`
//! semantics rather than Rust `f64` defaults. Per
//! `docs/planning/rust-irregular-backend/js-semantics-audit.md` (this module's
//! governing source document; cited throughout as "the audit"), the divergences
//! between JS `Number`/`Math` semantics and Rust `f64` defaults are numerous,
//! silent, and feed cache keys, canonical-JSON checkpoint hashes, and the
//! beam-state dedup identity — see the audit's §7/§12 severity ranking (findings
//! #2, #4, #5, #6 are all owned by this module).
//!
//! Submodules:
//! - [`js_math`] — `Math.round`/`trunc`/`sign`/`floor`/`ceil`/`min`/`max`
//!   equivalents, each documented against its JS divergence.
//!
//! This module intentionally does not depend on any other module in this
//! crate; every function here is a pure, side-effect-free `f64`/`&str`
//! transform, matching the audit's §13 "safe Rayon candidate" classification
//! for the whole cluster (no comparator, encoder, or numeric helper here
//! mutates shared state, observes a cache, or checks a deadline).

pub mod js_math;

use std::cmp::Ordering;

/// `Number.MAX_SAFE_INTEGER` (`2^53 - 1`), the exact boundary
/// `Number.isSafeInteger` checks against.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Reproduces ECMAScript `Number::toString` (radix 10) — i.e. the same
/// conversion `String(value)`, template-literal interpolation `` `${value}` ``,
/// and `JSON.stringify`'s number branch (modulo `JSON.stringify`'s own
/// non-finite → `null` special case, which callers must apply themselves, see
/// below) all perform. Spec: ECMA-262 `Number::toString`
/// (<https://tc39.es/ecma262/#sec-numeric-types-number-tostring>) — a
/// shortest-decimal-string-that-round-trips algorithm with a specific
/// exponential-notation switchover at magnitude `>= 1e21` or `< 1e-6`.
///
/// Backed by `ryu_js::Buffer::format`, the ECMAScript-flavored fork of the
/// Ryū algorithm (as opposed to the plain `ryu` crate, which reproduces
/// Rust/Java float formatting, a different algorithm — see the audit's §7.1,
/// which names this exact crate class and requires byte-for-byte verification
/// against V8 output before trusting it, not just its README). That
/// verification was performed manually against Node v24 (`String(value)`) for
/// the full hazard set the audit calls out — `-0`, the `1e21`/`1e-7`/`1e-6`
/// exponent-threshold boundaries, `Number.MAX_VALUE`/`Number.MIN_VALUE`
/// magnitudes, the `Number.MAX_SAFE_INTEGER` boundary, and ordinary
/// non-integer mm/mm² fixture-scale values — with zero divergence, and is
/// re-verified byte-for-byte by the `tests/js_number_vectors.rs` differential
/// vector suite generated from the real TS runtime (R14).
///
/// Special cases, matching ECMA-262 exactly (verified above, not assumed):
/// - `NaN` → `"NaN"`
/// - `+Infinity` → `"Infinity"`, `-Infinity` → `"-Infinity"`
/// - `-0.0` → `"0"` (no sign — `ryu_js` already folds this per the ECMAScript
///   spec it targets, so callers do **not** need to pre-fold `-0` before
///   calling this function)
///
/// TS call sites this function must reproduce exactly (all feed a key, cache
/// identity, or hash input per the audit's §7.1 "confirmed call sites" list):
/// - `canonicalNumber`'s finite-non-zero fallthrough `String(value)`
///   (`src/workers/algorithm/irregular/irregularBeamState.ts:849`) — the
///   caller (owned by the `search` module) still needs its own `NaN`/`-0`/
///   `±Infinity` branches ahead of this call, since `canonicalNumber` renders
///   those three cases as the bare tokens `"NaN"`/`"0"`/`"+Infinity"`/
///   `"-Infinity"`, not this function's `"NaN"`/`"0"`/`"Infinity"`/
///   `"-Infinity"` (note the `"+Infinity"` vs `"Infinity"` divergence for the
///   positive-infinity case specifically — this function must **not** be
///   substituted for the whole of `canonicalNumber`, only for its
///   finite-non-zero-value fallthrough branch).
/// - `numberKey` (`src/workers/irregular/geometryCacheKeys.ts:158-160`,
///   `src/workers/irregular/core/geometryCacheIdentity.ts:139-141`,
///   `src/workers/irregular/core/nfpCacheKey.ts:104-106`) — three
///   independently hand-written copies of
///   `Object.is(value, -0) ? '0' : String(value)`. Because this function
///   already folds `-0.0` to `"0"` exactly like `Object.is(value, -0) ? '0' :
///   ...` does, `number_to_js_string` is a drop-in, unconditional replacement
///   for the entire `numberKey` body (proved for every `f64` input: the only
///   two branches of `numberKey` are "value is -0 → `'0'`" and "otherwise →
///   `String(value)`", and `String(-0)` in JS is itself already `"0"`, so the
///   `Object.is` branch is provably redundant with plain `String(value)` —
///   see [`fold_negative_zero_key`] below, which exists only to make this
///   provenance explicit at each of those three call sites without silently
///   dropping the `Object.is` special case from the ported code's visible
///   structure).
pub fn number_to_js_string(value: f64) -> String {
    let mut buffer = ryu_js::Buffer::new();
    buffer.format(value).to_string()
}

/// `Object.is(value, -0) ? '0' : String(value)`, reproduced literally
/// (`fn numberKey`, `src/workers/irregular/geometryCacheKeys.ts:158-160`,
/// `src/workers/irregular/core/geometryCacheIdentity.ts:139-141`,
/// `src/workers/irregular/core/nfpCacheKey.ts:104-106`).
///
/// Delegates to [`number_to_js_string`], which already folds `-0.0` to
/// `"0"` per ECMA-262 `Number::toString` — this wrapper exists purely so
/// each of the three `numberKey` port sites can cite this exact function by
/// name instead of re-deriving the equivalence proof documented on
/// [`number_to_js_string`] inline at every call site.
pub fn fold_negative_zero_key(value: f64) -> String {
    number_to_js_string(value)
}

/// `Number.isSafeInteger(value)` — `true` iff `value` is finite, has no
/// fractional part, and its magnitude does not exceed `2^53 - 1`
/// (`Number.MAX_SAFE_INTEGER`). Does not coerce (mirrors the strict,
/// non-coercing `Number.` form the audit's §7.4 confirms is the only variant
/// live in this cluster — never the coercing bare-global `isFinite`/`isNaN`).
///
/// TS: `isCanonicalGridCoordinate` (`src/workers/irregular/canonicalGridMath.ts:8-10`)
/// and 292 other sites cross-referenced by the audit's §7.4; this is the
/// gate `canonicalGridCross`/`canonicalGridCrossSign` (`canonicalGridMath.ts`)
/// require before treating a coordinate as exact.
pub fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER
}

/// The `value === 0 ? 0 : value` signed-zero fold idiom — folds `-0.0` to
/// `+0.0` and leaves every other value (including `NaN`, `+0.0`, and every
/// non-zero finite/infinite value) unchanged.
///
/// TS sites using the `=== 0` spelling of this idiom:
/// `src/workers/algorithm/irregular/intrinsicTransformSeparator.ts:1038-1039`
/// (`rawX === 0 ? 0 : rawX`, `rawY === 0 ? 0 : rawY`),
/// `src/workers/irregular/canonicalLayoutGeometry.ts:100-101`
/// (`x === 0 ? 0 : x`, `y === 0 ? 0 : y`).
///
/// TS sites using the `Object.is(value, -0)` spelling of the same fold (the
/// audit's §7.5 confirms all 18 independently hand-written copies fold in
/// the identical direction, `-0 → 0`, never the reverse, so both spellings
/// are provably the same function — `x === 0` is `true` for both `+0` and
/// `-0` and `false` for every other value including `NaN`, while
/// `Object.is(x, -0)` is `true` only for `-0`; since both idioms return the
/// *input value itself* on the non-matching branch, and the input value on
/// that branch is never `-0` in the `Object.is` spelling and can only be
/// `+0` or a non-zero value in the `=== 0` spelling, the two idioms compute
/// identical results for every `f64`): `intrinsicStrictFamilyPortfolio.ts:452`,
/// `intrinsicExactProjection.ts:1024`, `convexSatPenetration.ts:89`,
/// `core/ifpBoundsCore.ts:130`, `core/transformCollisionGeometryCore.ts:181`,
/// `irregularBeamState.ts:497,846,855`, `intrinsicTransformSeparator.ts:1544`,
/// `freeMaterialService.ts:488`, `transformGenerator.ts:432`,
/// `intrinsicStrictDecoder.ts:1761`, `core/nfpBoundaryCore.ts:87`,
/// `nfpIfpService.ts:1291`, `intrinsicQueueBeamDiscriminator.ts:4771`.
///
/// Rust translation per the migration prompt §8.1/audit §7.5: `f64::to_bits()`
/// equality or `is_sign_negative() && value == 0.0` is the correct test for
/// `Object.is(value, -0)` — **never** `value == -0.0`, which is `true` for
/// every zero (positive or negative) under IEEE 754 comparison, exactly like
/// JS `===`, and would make the fold a no-op if used as the guard instead of
/// the sign-aware test below.
pub fn fold_negative_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

/// Compares two strings the way JavaScript's `<`/`>` operators (and every
/// bare `.sort()`/`.toSorted()` call with no comparator, per the audit's
/// §5.2 item 3) do: by **UTF-16 code unit** sequence, not by UTF-8 byte
/// sequence and not by Unicode scalar value.
///
/// TS: `compareStrings` (`src/workers/algorithm/irregular/intrinsicCapacitySearch.ts:2233-2237`)
/// and `compareCanonicalKeys`
/// (`src/workers/algorithm/irregular/irregularBeamState.ts:867-871`) — both
/// textually identical `first < second ? -1 : first > second ? 1 : 0` bodies,
/// independently written per file (not a shared TS utility; per the audit's
/// §6 item 1, safe to unify into this one Rust helper without changing
/// observable behavior, since there is no file-specific variation among the
/// code-unit comparators). This is the primitive every plain-`<`/bare-sort
/// call site in the audit's §5.2 item 1/item 3 inventory must route through.
///
/// For pure-BMP (non-surrogate-pair) content this agrees with Rust's default
/// `str`/`&str` `Ord` (UTF-8 byte order, which agrees with code-point order,
/// which agrees with UTF-16 code-unit order below `U+10000`). It diverges for
/// supplementary-plane characters: a lone leading surrogate sorts between
/// `U+D800` and `U+DBFF` under UTF-16 code-unit order — i.e. numerically
/// *before* every BMP character in `U+E000..=U+FFFF` — even though the actual
/// supplementary code point that surrogate pair encodes is `>= U+10000`,
/// numerically *after* those same BMP characters under code-point/byte order.
/// Concretely: `"\u{10000}" < "\u{E000}"` is `true` in JavaScript (first
/// UTF-16 unit `0xD800 < 0xE000`) but Rust's `str::cmp` would say
/// `"\u{10000}" > "\u{E000}"` (code point `0x10000 > 0xE000`) — verified
/// against Node v24 and reproduced as a differential vector
/// (`tests/vectors/js-number.json`). This function must be used
/// unconditionally at every JS `<`/`>`/bare-sort string-comparison call site
/// a future module ports, per the audit's §5.2 item 1 "prove it per input
/// domain or use the UTF-16 comparison unconditionally for safety" guidance —
/// piece IDs/labels observed in fixtures are ASCII-only today (see
/// `tests/fixtures/irregularSheetInvariance/mixed61-request.json` and the
/// `pieceId` literals across `tests/unit/`), where code-unit and UTF-8-byte
/// order coincide, but the audit's §15 item 5 leaves open whether a
/// user-supplied label could ever carry non-BMP content, so this function
/// remains the mandatory primitive rather than plain `str::cmp` project-wide.
///
/// # ASCII fast path (2026-07-30, migration prompt §21 optimization
/// discipline)
///
/// When *both* inputs are pure ASCII, `first.as_bytes().cmp(second.as_bytes())`
/// (effectively `str`'s own `Ord`, a `memcmp`-backed byte comparison) is
/// mathematically identical to `first.encode_utf16().cmp(second.encode_utf16())`:
/// every ASCII scalar value encodes to exactly one UTF-8 byte *and* exactly
/// one UTF-16 code unit carrying the same numeric value (0..=127), so the two
/// comparisons inspect the same sequence of numbers in the same order: any
/// position where they first differ orders identically, and the length-based
/// tie-break for one string being a strict prefix of the other (`Ordering`'s
/// own iterator/slice comparison rule: "exhausted first" is `Less`) is
/// applied identically by both `[u8]`'s and `Iterator<Item = u16>`'s `Ord`
/// impls. This is a proof for *every* pair of ASCII strings, not an
/// empirical fact about today's observed-ASCII fixtures — the doc above's
/// "remains the mandatory primitive rather than plain `str::cmp`
/// project-wide" concern (an unproven guess about hypothetical future
/// non-ASCII input) is fully preserved: the general, always-correct
/// `encode_utf16().cmp()` path below is untouched and still runs for any
/// input containing non-ASCII content, so this crate's actual comparison
/// *semantics* for 100% of inputs (not just ASCII ones) are unchanged; only
/// the ASCII branch's implementation strategy is faster.
pub fn cmp_js_code_units(first: &str, second: &str) -> Ordering {
    if first.is_ascii() && second.is_ascii() {
        first.as_bytes().cmp(second.as_bytes())
    } else {
        first.encode_utf16().cmp(second.encode_utf16())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_to_js_string_handles_special_values() {
        assert_eq!(number_to_js_string(f64::NAN), "NaN");
        assert_eq!(number_to_js_string(f64::INFINITY), "Infinity");
        assert_eq!(number_to_js_string(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(number_to_js_string(0.0), "0");
        assert_eq!(number_to_js_string(-0.0), "0");
        assert_eq!(number_to_js_string(1.0), "1");
        assert_eq!(number_to_js_string(-1.0), "-1");
        assert_eq!(number_to_js_string(0.1), "0.1");
        assert_eq!(number_to_js_string(1e21), "1e+21");
        assert_eq!(number_to_js_string(1e-7), "1e-7");
        assert_eq!(number_to_js_string(1e-6), "0.000001");
        assert_eq!(number_to_js_string(622.202), "622.202");
        assert_eq!(number_to_js_string(391605.850174), "391605.850174");
    }

    #[test]
    fn fold_negative_zero_key_matches_number_to_js_string() {
        for value in [
            0.0,
            -0.0,
            1.5,
            -1.5,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            assert_eq!(fold_negative_zero_key(value), number_to_js_string(value));
        }
    }

    #[test]
    fn is_safe_integer_matches_boundary() {
        assert!(is_safe_integer(MAX_SAFE_INTEGER));
        assert!(!is_safe_integer(MAX_SAFE_INTEGER + 1.0));
        assert!(is_safe_integer(-MAX_SAFE_INTEGER));
        assert!(!is_safe_integer(-(MAX_SAFE_INTEGER + 1.0)));
        assert!(is_safe_integer(-0.0));
        assert!(is_safe_integer(0.0));
        assert!(!is_safe_integer(0.5));
        assert!(!is_safe_integer(f64::NAN));
        assert!(!is_safe_integer(f64::INFINITY));
        assert!(!is_safe_integer(f64::NEG_INFINITY));
    }

    #[test]
    fn fold_negative_zero_folds_only_negative_zero() {
        assert!(fold_negative_zero(-0.0).is_sign_positive());
        assert!(fold_negative_zero(0.0).is_sign_positive());
        assert_eq!(fold_negative_zero(1.5), 1.5);
        assert_eq!(fold_negative_zero(-1.5), -1.5);
        assert!(fold_negative_zero(f64::NAN).is_nan());
    }

    #[test]
    fn cmp_js_code_units_matches_ascii_byte_order() {
        assert_eq!(cmp_js_code_units("a", "b"), Ordering::Less);
        assert_eq!(cmp_js_code_units("b", "a"), Ordering::Greater);
        assert_eq!(cmp_js_code_units("a", "a"), Ordering::Equal);
        assert_eq!(cmp_js_code_units("copy-1", "copy-10"), Ordering::Less);
    }

    #[test]
    fn cmp_js_code_units_diverges_from_code_point_order_for_supplementary_plane() {
        // U+10000 encodes as the UTF-16 surrogate pair (0xD800, 0xDC00); its
        // leading code unit 0xD800 is less than U+E000's single code unit
        // 0xE000, so JS code-unit order ranks it first even though its actual
        // code point (0x10000) is numerically greater than 0xE000. Verified
        // against Node v24: `String.fromCodePoint(0x10000) < String.fromCodePoint(0xE000)`
        // is `true`.
        let supplementary = "\u{10000}";
        let bmp_private_use = "\u{E000}";
        assert_eq!(
            cmp_js_code_units(supplementary, bmp_private_use),
            Ordering::Less
        );
        // Confirm Rust's default byte-order `str::cmp` would get this backwards,
        // which is exactly the divergence this function exists to avoid.
        assert_eq!(supplementary.cmp(bmp_private_use), Ordering::Greater);
    }
}
