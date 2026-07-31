//! `Math.*` equivalents that diverge from Rust `f64` built-ins.
//!
//! Per `docs/planning/rust-irregular-backend/js-semantics-audit.md` §7.3 (744
//! `Math.*` call sites found across the cluster; this module implements the
//! general-purpose primitives every one of those sites must be checked
//! against — not a per-call-site enumeration, which is out of this module's
//! scope and left to whichever module ports each specific call site).
//!
//! `Math.floor`/`Math.ceil`/`Math.trunc` are bit-exact with Rust's
//! `f64::floor`/`f64::ceil`/`f64::trunc` (verified against Node v24 for
//! `NaN`/`±Infinity`/`±0`/halfway values — both are IEEE 754 "round toward
//! −∞"/"round toward +∞"/"round toward zero" with no JS-specific deviation).
//! [`floor`], [`ceil`], and [`trunc`] below are therefore thin one-line
//! delegations to the `f64` methods, kept only so every `Math.*` equivalent
//! this crate needs shares one `js_math::*` call surface — a caller porting a
//! TS `Math.floor(...)` call site should never need to remember "this one is
//! safe to call the Rust method directly, unlike `Math.round`"; routing
//! everything through this module uniformly removes that judgment call.
//! `Math.round`, `Math.sign`, `Math.max`, and `Math.min` have real behavioral
//! divergences from their apparently-equivalent Rust built-ins and are
//! implemented with actual logic below.

/// `Math.round(x)` — reproduces ECMA-262 `Math.round`
/// (<https://tc39.es/ecma262/#sec-math.round>) exactly: **round half toward
/// positive infinity**, not Rust's `f64::round()` (round half **away from
/// zero**). Concretely: `Math.round(-0.5) === -0` and `Math.round(-2.5) ===
/// -2` (not `-3`), whereas Rust's `(-2.5_f64).round() == -3.0`.
///
/// Implementation note: this is deliberately **not** the common
/// `(x + 0.5).floor()` shortcut. That shortcut double-rounds for `x` near the
/// top of the safe-integer range — verified by differential testing against
/// Node v24 across halves and near-halves at magnitudes up to
/// `Number.MAX_SAFE_INTEGER`: `(x + 0.5).floor()` disagrees with
/// `Math.round(x)` at `x = 4_503_599_627_370_497.0`
/// (`Math.round` → itself, unchanged, since it is already integral;
/// `(x + 0.5).floor()` → `x + 1.0`, because `x + 0.5` itself rounds up to the
/// next representable `f64` before `.floor()` ever runs) and at
/// `x = Number.MAX_SAFE_INTEGER` (`9_007_199_254_740_991.0`), with the mirror
/// image failing for the corresponding negative values. This implementation
/// instead computes `x.floor()` and the *exact* fractional remainder
/// `x - x.floor()` (exact per Sterbenz's lemma: `x` and `x.floor()` are
/// always within a factor of two of each other for finite `x`, so the
/// subtraction has no rounding error), then compares that remainder to `0.5`
/// directly — matching ECMA-262's literal 5-step algorithm (NaN/±0/±Infinity
/// passthrough; `(0, 0.5)` → `+0`; `[-0.5, 0)` → `-0`; otherwise the closest
/// integral value, ties resolved toward the larger of the two candidates).
///
/// TS call sites requiring this exact convention (round half toward `+∞`,
/// the "direct `Math.round`" family per the audit's §7.3 item 1 — **not**
/// the opposite, round-half-away-from-zero convention some other sites
/// hand-roll via `Math.sign(x) * Math.floor(Math.abs(x) + 0.5)`, which is a
/// different, independently live rounding convention owned by
/// `irregularScoreGrid.ts` and out of this function's scope, see the module
/// doc above and the audit's §7.3 item 2):
/// `canonicalLinearMetric`/`canonicalAreaMetric`
/// (`src/workers/algorithm/irregular/intrinsicStrictDecoder.ts:1692-1693,1697-1698`,
/// `Math.round(valueMm * 1_000)`/`Math.round(valueMm2 * 1_000_000)` — the
/// exact "floating millimeters to canonical grid" conversion the migration
/// prompt §8.1 calls out by name), plus
/// `intrinsicTransformSeparator.ts:503-504,536-537,721-722,729-730,934-935`,
/// `intrinsicSqueezeDisruptSeparate.ts:3086-3089`,
/// `overlapRelaxationV1.ts:1267,1271`, `overlapRelaxation.ts:787`.
pub fn round(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 || x.is_infinite() {
        return x;
    }
    if x > 0.0 && x < 0.5 {
        return 0.0;
    }
    if (-0.5..0.0).contains(&x) {
        return -0.0;
    }
    let floor = x.floor();
    let remainder = x - floor;
    if remainder < 0.5 {
        floor
    } else {
        // remainder >= 0.5: both the exact-halfway tie (resolved toward the
        // larger candidate, per ECMA-262 step 5) and the "closer to the next
        // integer up" case take this branch.
        floor + 1.0
    }
}

/// `Math.trunc(x)` — reproduces ECMA-262 `Math.trunc`
/// (<https://tc39.es/ecma262/#sec-math.trunc>): round toward zero, dropping
/// the fractional part. Bit-exact with Rust's `f64::trunc()` (verified
/// against Node v24 across `NaN`/`±Infinity`/`±0`/fractional/halfway values —
/// see the module doc). A thin delegation kept only for a single consistent
/// `js_math::*` call surface, not because of any behavioral divergence.
pub fn trunc(x: f64) -> f64 {
    x.trunc()
}

/// `Math.floor(x)` — reproduces ECMA-262 `Math.floor`
/// (<https://tc39.es/ecma262/#sec-math.floor>): round toward negative
/// infinity. Bit-exact with Rust's `f64::floor()` (verified against Node v24;
/// see the module doc). A thin delegation kept only for a single consistent
/// `js_math::*` call surface, not because of any behavioral divergence.
pub fn floor(x: f64) -> f64 {
    x.floor()
}

/// `Math.ceil(x)` — reproduces ECMA-262 `Math.ceil`
/// (<https://tc39.es/ecma262/#sec-math.ceil>): round toward positive
/// infinity. Bit-exact with Rust's `f64::ceil()` (verified against Node v24;
/// see the module doc). A thin delegation kept only for a single consistent
/// `js_math::*` call surface, not because of any behavioral divergence.
pub fn ceil(x: f64) -> f64 {
    x.ceil()
}

/// `Math.sign(x)` — reproduces ECMA-262 `Math.sign`
/// (<https://tc39.es/ecma262/#sec-math.sign>): `NaN` → `NaN`; `+0`/`-0` →
/// itself unchanged (**sign preserved**); positive → `1.0`; negative →
/// `-1.0`. Rust's `f64::signum()` is **not** equivalent: its documentation
/// states it returns `1.0` for `+0.0` and `-1.0` for `-0.0` — i.e. it never
/// returns a zero of either sign, diverging from `Math.sign` at exactly the
/// zero inputs.
///
/// TS: the `Math.sign(value) * Math.floor(Math.abs(value) * scale + 0.5)`
/// round-half-away-from-zero idiom
/// (`src/workers/algorithm/irregular/irregularScoreGrid.ts:21-30,33-41`,
/// `canonicalizeIrregularScoreMillimeterUnits`/`canonicalizeIrregularScoreScalar`)
/// relies specifically on `Math.sign(0) === 0`/`Math.sign(-0) === -0` to
/// preserve the *sign* of an already-zero-magnitude input through the
/// multiplication (`0 * anything === 0`, `-0 * positive === -0`) — a Rust
/// port using `f64::signum()` here would silently turn every zero-sign input
/// into `+1.0`/`-1.0` and corrupt the result. Per the audit's §7.3 item 2,
/// this is the single most likely "helpful simplification" mistake in a
/// mechanical port of this formula, since `.round()` a maintainer might be
/// tempted to substitute for the whole hand-rolled expression already
/// implements the *rounding* half of the intended behavior correctly by
/// coincidence, masking the dropped sign-of-zero handling in code review.
pub fn sign(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x == 0.0 {
        return x;
    }
    if x > 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// `Math.max(a, b)` — reproduces ECMA-262 `Math.max`
/// (<https://tc39.es/ecma262/#sec-math.max>): propagates `NaN` (if either
/// operand is `NaN`, the result is `NaN`) and treats `+0` as greater than
/// `-0` (`Math.max(+0, -0) === +0`). Rust's `f64::max` method **ignores**
/// `NaN` ("if one of the arguments is NaN, then the other argument is
/// returned" — the opposite policy) and its zero-sign behavior is not
/// specified by its documentation, so neither divergence is safe to assume
/// away by translating `Math.max(a, b)` to `a.max(b)` directly.
///
/// TS: 397 call sites cross-cluster per the audit's §7.3 item 3/§12 item 5;
/// not individually enumerated here (each porting module is responsible for
/// routing its own `Math.max` call sites through this function rather than
/// `f64::max`).
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_positive() || b.is_sign_positive() {
            0.0
        } else {
            -0.0
        };
    }
    if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)` — the `Math.max` mirror: propagates `NaN`, and treats
/// `-0` as less than `+0` (`Math.min(+0, -0) === -0`). See [`max`]'s doc for
/// the full divergence rationale from Rust's `f64::min`.
///
/// TS: 188 call sites cross-cluster per the audit's §7.3 item 3/§12 item 5.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() || b.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(...values)` over an arbitrary-arity list, folding pairwise
/// through [`max`] (which already propagates `NaN` from any position — once
/// any fold step observes a `NaN` operand, every subsequent step keeps
/// propagating it, so `NaN` at any input position, not just the first,
/// correctly poisons the whole reduction). Empty input matches
/// `Math.max()`'s spec-defined result of `-Infinity`
/// (<https://tc39.es/ecma262/#sec-math.max>, the identity element for an
/// empty argument list).
///
/// TS: spread call sites such as
/// `Math.max(...points.map(({ x }) => x))`
/// (`src/workers/algorithm/irregular/intrinsicComponentInterfaceClosure.ts:394-395`),
/// mirrored across several other files per the audit's raw `Math.max(...`
/// sweep.
pub fn max_all(values: &[f64]) -> f64 {
    values.iter().copied().fold(f64::NEG_INFINITY, max)
}

/// `Math.min(...values)` — the [`max_all`] mirror; empty input matches
/// `Math.min()`'s spec-defined result of `+Infinity`.
///
/// TS: e.g. `Math.min(...gridPoints.map(({ x }) => x))`
/// (`src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.ts:560-561`).
pub fn min_all(values: &[f64]) -> f64 {
    values.iter().copied().fold(f64::INFINITY, min)
}

/// Two-argument Euclidean norm used by semantic geometry and scoring paths.
///
/// Final geometry, quality, and deterministic output are authoritative. The
/// committed Node/V8 corpus remains diagnostic characterization of bounded
/// binary64 differences from JavaScript.
pub fn hypot(x: f64, y: f64) -> f64 {
    x.hypot(y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trunc_floor_ceil_preserve_negative_zero_and_special_values() {
        assert_eq!(trunc(-0.5).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(floor(-0.0).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(ceil(-0.5).to_bits(), (-0.0_f64).to_bits());
        assert!(trunc(f64::NAN).is_nan());
        assert_eq!(floor(f64::INFINITY), f64::INFINITY);
        assert_eq!(ceil(f64::NEG_INFINITY), f64::NEG_INFINITY);
        assert_eq!(trunc(2.9), 2.0);
        assert_eq!(floor(2.9), 2.0);
        assert_eq!(ceil(2.1), 3.0);
    }

    #[test]
    fn round_matches_js_half_toward_positive_infinity() {
        assert_eq!(round(0.5), 1.0);
        assert_eq!(round(-0.5).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(1.4), 1.0);
        assert_eq!(round(1.6), 2.0);
        assert_eq!(round(-1.4), -1.0);
        assert_eq!(round(-1.6), -2.0);
        assert!(round(f64::NAN).is_nan());
        assert_eq!(round(f64::INFINITY), f64::INFINITY);
        assert_eq!(round(f64::NEG_INFINITY), f64::NEG_INFINITY);
        assert_eq!(round(0.0).to_bits(), 0.0_f64.to_bits());
        assert_eq!(round(-0.0).to_bits(), (-0.0_f64).to_bits());
    }

    #[test]
    fn round_does_not_double_round_near_safe_integer_boundary() {
        // Regression case for the rejected `(x + 0.5).floor()` shortcut,
        // which double-rounds at this exact value (see the function doc).
        let x = 4_503_599_627_370_497.0_f64;
        assert_eq!(round(x), x);
        assert_eq!(round(9_007_199_254_740_991.0_f64), 9_007_199_254_740_991.0);
        assert_eq!(
            round(-9_007_199_254_740_991.0_f64),
            -9_007_199_254_740_991.0
        );
    }

    #[test]
    fn sign_preserves_zero_sign_unlike_signum() {
        assert_eq!(sign(0.0).to_bits(), 0.0_f64.to_bits());
        assert_eq!(sign(-0.0).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(sign(5.0), 1.0);
        assert_eq!(sign(-5.0), -1.0);
        assert!(sign(f64::NAN).is_nan());
        // Documents the divergence this function exists to avoid.
        assert_eq!(0.0_f64.signum(), 1.0);
        assert_eq!((-0.0_f64).signum(), -1.0);
    }

    #[test]
    fn max_min_propagate_nan() {
        assert!(max(1.0, f64::NAN).is_nan());
        assert!(max(f64::NAN, 1.0).is_nan());
        assert!(min(1.0, f64::NAN).is_nan());
        assert!(min(f64::NAN, 1.0).is_nan());
        // Documents the divergence: Rust's f64::max/min ignore NaN.
        assert_eq!(1.0_f64.max(f64::NAN), 1.0);
    }

    #[test]
    fn max_min_zero_sign_tie_break() {
        assert_eq!(max(0.0, -0.0).to_bits(), 0.0_f64.to_bits());
        assert_eq!(max(-0.0, 0.0).to_bits(), 0.0_f64.to_bits());
        assert_eq!(min(0.0, -0.0).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(min(-0.0, 0.0).to_bits(), (-0.0_f64).to_bits());
    }

    #[test]
    fn max_all_min_all_match_empty_and_nan_semantics() {
        assert_eq!(max_all(&[]), f64::NEG_INFINITY);
        assert_eq!(min_all(&[]), f64::INFINITY);
        assert_eq!(max_all(&[1.0, 5.0, 3.0]), 5.0);
        assert_eq!(min_all(&[1.0, 5.0, 3.0]), 1.0);
        assert!(max_all(&[1.0, f64::NAN, 3.0]).is_nan());
        assert!(min_all(&[1.0, f64::NAN, 3.0]).is_nan());
    }

    #[test]
    fn hypot_delegates_to_standard_rounding_and_handles_extremes() {
        let cases = [
            (1.0_f64, std::f64::consts::SQRT_2),
            (f64::MAX, f64::MIN_POSITIVE),
            (1e308, 1e-308),
            (1e-300, 1e-300),
            (-3.0, 4.0),
            (4.0, -3.0),
        ];

        for (x, y) in cases {
            assert_eq!(hypot(x, y).to_bits(), x.hypot(y).to_bits());
            assert_eq!(hypot(x, y).to_bits(), hypot(y, x).to_bits());
        }
    }

    /// Rust's standard `f64::hypot` returns infinity when either argument is
    /// infinite, including when the other argument is `NaN`.
    #[test]
    fn hypot_infinity_takes_precedence_over_nan() {
        assert_eq!(hypot(f64::INFINITY, f64::NAN), f64::INFINITY);
        assert_eq!(hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
        assert_eq!(hypot(f64::NEG_INFINITY, 5.0), f64::INFINITY);
        assert!(hypot(f64::NAN, 5.0).is_nan());
    }
}
