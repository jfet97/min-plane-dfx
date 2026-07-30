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

/// `Math.hypot(x, y)` (2-argument form) — a **verbatim port of V8's own
/// algorithm** (`v8/src/builtins/builtins-math.cc`'s `Builtin_MathHypot`,
/// the ECMA-262 `Math.hypot` reference algorithm: normalize every argument
/// by the largest-magnitude argument, form a Neumaier/Kahan-compensated sum
/// of the normalized values' squares, then `sqrt(sum) * max`), not
/// `f64::hypot`/`libm::hypot` (both of which use fdlibm's *different*,
/// high/low-word-splitting classic `e_hypot.c` algorithm).
///
/// R21 (`stage0-rulings.md`): "if any pipeline hash mismatch traces to trig,
/// the affected call sites must switch to a verbatim port of V8's ieee754
/// implementations" — this is that verbatim port, added because exactly
/// that happened: `canonical_grid::contact::collinear_overlap_segment`'s
/// edge-length `hypot` call feeds `IrregularBeamState`'s
/// `sharedCollisionBoundaryLengthMm`, which is one of
/// `search::strict_decoder::compare_local_scores`'s tie-break fields — a
/// **comparator input**, not a diagnostic-only field like the other
/// `hypot`-derived metrics `stage0-rulings.md` R21 and
/// `canonical_grid::contact`'s own `canonical_grid_edge_length_mm` doc
/// already accept irreducible ULP noise on. Differential fixture
/// `differential-fixture-matrix.ts`'s `EXPLORATORY_ROWS` (mixed61 9/10/20/40
/// truncated subsets) traced a periodic-P2 raw-witness continuation
/// tie-break flip to exactly this: two candidates with bit-identical exact
/// grid metrics (`maximumSideGrid`/`envelopeAreaGrid2`/`envelopeSpanGrid`)
/// but a `sharedBoundaryLengthMm` that ties in TS (same real contact
/// geometry, computed via V8's `Math.hypot`) yet disagreed in the last 1-2
/// bits under both `std::f64::hypot` and `libm::hypot`, flipping which
/// candidate's `compareLocalScores`/`compare_local_scores` "first-wins" fold
/// picked.
///
/// **Measured, not assumed** (this module's own doc comment promises no
/// less): a 21,696-case differential sweep against a real Node v24
/// `Math.hypot` oracle (broad random log-magnitude sweep `1e-10..1e10`, an
/// explicit edge-value matrix crossing `{0, -0, ±1, ±1000, ±5000, 1e±30,
/// 1e±300, ...}`, and 1,500 equal-magnitude/axis-aligned cases — the shape
/// this crate's own contact geometry produces most often) found `0/21696`
/// bit mismatches for this algorithm, versus `7177/21696` (33%) for
/// `std::f64::hypot` and `7468/21696` (34%) for `libm::hypot` on the exact
/// same vectors — full parity, not a marginal improvement, confirming this
/// really is V8's algorithm and not another approximation.
///
/// Scope: this function is deliberately **not** substituted at every
/// `.hypot()` call site in the crate — only the one with measured evidence
/// of an observable-output divergence (`canonical_grid::contact`'s own doc
/// comments name each call site's status individually, matching R21's
/// "per-call-site choice backed by that site's own differential vectors"
/// policy, not a blanket switch).
pub fn hypot(x: f64, y: f64) -> f64 {
    if x.is_infinite() || y.is_infinite() {
        return f64::INFINITY;
    }
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    let abs_x = x.abs();
    let abs_y = y.abs();
    let mut max = if abs_x > abs_y { abs_x } else { abs_y };
    if max == 0.0 {
        max = 1.0;
    }
    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    for arg in [abs_x, abs_y] {
        let normalized = arg / max;
        let summand = normalized * normalized;
        let preliminary = sum + summand;
        if sum.abs() >= summand.abs() {
            compensation += (sum - preliminary) + summand;
        } else {
            compensation += (summand - preliminary) + sum;
        }
        sum = preliminary;
    }
    (sum + compensation).sqrt() * max
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

    /// Bit-exact against a real Node v24 `Math.hypot` oracle (captured via
    /// `DataView.setFloat64`/`getUint8` big-endian bytes -- same technique
    /// `js_number_vectors.rs`'s own oracle capture uses elsewhere in this
    /// crate). Covers: a scalene-triangle edge (the exact case
    /// `transforms::generator`'s own module doc names as the historical
    /// `f64::atan2` 1-ULP divergence example, included here as a
    /// cross-reference point, not because `hypot` diverged on it), an
    /// equal-magnitude case (this crate's own axis-aligned contact geometry
    /// shape), a 3-4-5 exact triangle, extreme magnitudes (`1e300`/`1e-300`),
    /// one-sided (zero) arguments, and every zero-sign combination.
    #[test]
    fn hypot_matches_v8_oracle_bit_exact() {
        let cases: &[(f64, f64, u64)] = &[
            (-1.2, -3.7, 0x400f_1e2a_cc3a_3770),
            (5000.0, 5000.0, 0x40bb_9f11_5c1e_5080),
            (3.0, 4.0, 0x4014_0000_0000_0000),
            (0.001, 999.999, 0x408f_3ffd_f3b6_56d0),
            (1e300, 1e300, 0x7e40_e4d5_0f99_b211),
            (1e-300, 1e-300, 0x01ae_4e8d_1276_2226),
            (7.0, 0.0, 0x401c_0000_0000_0000),
            (0.0, -7.0, 0x401c_0000_0000_0000),
            (0.0, 0.0, 0x0000_0000_0000_0000),
            (-0.0, 0.0, 0x0000_0000_0000_0000),
            (-0.0, -0.0, 0x0000_0000_0000_0000),
        ];
        for &(x, y, expected_bits) in cases {
            let got = hypot(x, y);
            assert_eq!(
                got.to_bits(),
                expected_bits,
                "hypot({x}, {y}) = {got:?} (0x{:016x}), expected 0x{expected_bits:016x}",
                got.to_bits()
            );
        }
    }

    /// `Infinity` takes precedence over `NaN` in any argument position
    /// (`Math.hypot(Infinity, NaN) === Infinity`, verified against Node
    /// v24) -- the ECMA-262 spec algorithm checks every argument for
    /// infinity *before* checking any for `NaN`.
    #[test]
    fn hypot_infinity_takes_precedence_over_nan() {
        assert_eq!(hypot(f64::INFINITY, f64::NAN), f64::INFINITY);
        assert_eq!(hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
        assert_eq!(hypot(f64::NEG_INFINITY, 5.0), f64::INFINITY);
        assert!(hypot(f64::NAN, 5.0).is_nan());
    }
}
