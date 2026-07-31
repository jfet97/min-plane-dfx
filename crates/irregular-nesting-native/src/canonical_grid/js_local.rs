//! Small, private ECMAScript-`Number`/`Math` semantics helpers needed by this
//! module only.
//!
//! The shared `crate::js_number` module (ECMAScript number-to-string,
//! `Math.*` equivalents, signed-zero folds, safe-integer checks) is being
//! written concurrently by another module of this migration; per the
//! migration prompt this module does not depend on it and instead carries
//! its own minimal, locally-scoped equivalents. Each helper below is marked
//! `TODO(js_number)`: once the shared module lands, these should be replaced
//! by calls into it (a pure refactor, not a behavior change).

use num_bigint::BigInt;

/// TODO(js_number): mirrors ECMAScript `Number.isSafeInteger`.
/// TS source: `src/workers/irregular/canonicalGridMath.ts:8-10`
/// (`isCanonicalGridCoordinate`, itself a thin wrapper over
/// `Number.isSafeInteger`).
pub(crate) fn is_safe_integer(value: f64) -> bool {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0; // 2^53 - 1
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER
}

/// TODO(js_number): mirrors ECMAScript `Number.isFinite` (unlike the global
/// `isFinite`, this does not coerce non-numbers, which is moot here since the
/// input is already an `f64`; kept as a named helper purely for call-site
/// readability/parity with the TS source).
/// TS source: `src/workers/irregular/clipper2OffsetPolicy.ts:45,48` and
/// `src/workers/irregular/canonicalGridMath.ts:200` (`Number.isFinite`).
pub(crate) fn is_finite(value: f64) -> bool {
    value.is_finite()
}

/// TODO(js_number): mirrors ECMAScript `Math.sign`, in particular its
/// signed-zero passthrough (`Math.sign(-0) === -0`, `Math.sign(0) === 0`)
/// and `NaN` propagation, neither of which match Rust's `f64::signum`
/// (which returns `+-1.0` even for zero and never returns `NaN`).
/// TS source: `src/workers/irregular/clipper2OffsetPolicy.ts:51` (`Math.sign`).
pub(crate) fn math_sign(value: f64) -> f64 {
    if value.is_nan() {
        return f64::NAN;
    }
    if value == 0.0 {
        return value; // preserves the sign bit of +0/-0 exactly, as `Math.sign` does
    }
    if value > 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// TODO(js_number): mirrors ECMAScript `Math.min`'s two-argument signed-zero
/// tie-break (`Math.min(-0, +0) === Math.min(+0, -0) === -0`), which Rust's
/// `f64::min` does not guarantee (LLVM's `minnum` intrinsic leaves the
/// zero-vs-zero case unspecified).
/// TS source: `src/workers/irregular/canonicalGridMath.ts:181,183`
/// (`Math.min` calls inside `canonicalGridPointOnSegment`).
pub(crate) fn math_min(first: f64, second: f64) -> f64 {
    if first.is_nan() || second.is_nan() {
        return f64::NAN;
    }
    if first == 0.0 && second == 0.0 {
        return if first.is_sign_negative() || second.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if first < second {
        first
    } else {
        second
    }
}

/// TODO(js_number): mirrors ECMAScript `Math.max`'s two-argument signed-zero
/// tie-break (`Math.max(-0, +0) === Math.max(+0, -0) === +0`); see
/// [`math_min`] for the corresponding rationale.
/// TS source: `src/workers/irregular/canonicalGridMath.ts:182,184`
/// (`Math.max` calls inside `canonicalGridPointOnSegment`).
pub(crate) fn math_max(first: f64, second: f64) -> f64 {
    if first.is_nan() || second.is_nan() {
        return f64::NAN;
    }
    if first == 0.0 && second == 0.0 {
        return if first.is_sign_negative() && second.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if first > second {
        first
    } else {
        second
    }
}

/// TODO(js_number): mirrors ECMAScript `Number::toString` (the algorithm
/// implemented by `ryu-js`), used here to build the same `${x},${y}` template
/// literal key `canonicalGridConvexHull`'s de-duplicating `Map` uses.
/// TS source: `src/workers/irregular/canonicalGridMath.ts:140`
/// (`` `${point.x},${point.y}` `` inside `canonicalGridConvexHull`).
pub(crate) fn number_to_js_string(value: f64) -> String {
    let mut buffer = ryu_js::Buffer::new();
    buffer.format(value).to_string()
}

/// TODO(js_number): mirrors ECMAScript's `Number(bigint)` conversion (the
/// `BigInt::toNumber` abstract operation), which the spec defines as "the
/// Number value for the MV", i.e. round-to-nearest with ties-to-even applied
/// to the bigint's exact mathematical value (`Infinity`/`-Infinity` when the
/// magnitude exceeds the largest finite `f64`). Rust's decimal-string-to-`f64`
/// parser (`str::parse::<f64>`) is documented as correctly rounded, so
/// round-tripping through the bigint's exact base-10 `Display` reproduces
/// that conversion bit-for-bit for every magnitude.
/// TS source: `src/workers/irregular/canonicalGridMath.ts:199`
/// (`Number(doubledAreaGrid2)` inside `doubledGridAreaToMm2`).
pub(crate) fn bigint_to_number(value: &BigInt) -> f64 {
    value
        .to_string()
        .parse::<f64>()
        .expect("a BigInt's decimal Display always parses as a (possibly infinite) f64")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_safe_integer_matches_max_safe_integer_boundary() {
        assert!(is_safe_integer(9_007_199_254_740_991.0));
        assert!(!is_safe_integer(9_007_199_254_740_992.0));
        assert!(is_safe_integer(-9_007_199_254_740_991.0));
        assert!(!is_safe_integer(-9_007_199_254_740_992.0));
        assert!(is_safe_integer(0.0));
        assert!(is_safe_integer(-0.0));
        assert!(!is_safe_integer(0.5));
        assert!(!is_safe_integer(f64::NAN));
        assert!(!is_safe_integer(f64::INFINITY));
    }

    #[test]
    fn math_sign_preserves_signed_zero_and_propagates_nan() {
        assert_eq!(math_sign(0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(math_sign(-0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(math_sign(5.0), 1.0);
        assert_eq!(math_sign(-5.0), -1.0);
        assert!(math_sign(f64::NAN).is_nan());
    }

    #[test]
    fn math_min_max_break_zero_ties_like_ecmascript() {
        assert_eq!(math_min(0.0, -0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(math_min(-0.0, 0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(math_max(0.0, -0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(math_max(-0.0, 0.0).to_bits(), 0.0f64.to_bits());
        assert!(math_min(f64::NAN, 1.0).is_nan());
        assert!(math_max(1.0, f64::NAN).is_nan());
    }

    #[test]
    fn number_to_js_string_matches_ecmascript_special_cases() {
        assert_eq!(number_to_js_string(0.0), "0");
        assert_eq!(number_to_js_string(-0.0), "0");
        assert_eq!(number_to_js_string(f64::NAN), "NaN");
        assert_eq!(number_to_js_string(f64::INFINITY), "Infinity");
        assert_eq!(number_to_js_string(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(number_to_js_string(1e21), "1e+21");
    }

    #[test]
    fn bigint_to_number_overflows_to_infinity_like_number_of_bigint() {
        let huge: BigInt = "9".repeat(400).parse().expect("valid decimal literal");
        assert!(bigint_to_number(&huge).is_infinite());
        assert!(bigint_to_number(&(-huge)).is_infinite());
        assert_eq!(bigint_to_number(&BigInt::from(0)), 0.0);
    }
}
