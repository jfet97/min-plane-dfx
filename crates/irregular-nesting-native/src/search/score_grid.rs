//! Canonical millimeter/scalar rounding grid for irregular score-derived
//! numeric values, plus a couple of small `effect` `Order` primitives shared
//! by this module's sibling scorer files (`placement_scorer`, `layout_scorer`).
//!
//! TS source: `src/workers/algorithm/irregular/irregularScoreGrid.ts` (42
//! lines, no imports -- a pure leaf module). Read together with
//! `docs/planning/rust-irregular-backend/characterization/search-scoring.md`
//! §7.1/§7.2 before touching this file: the round-half-away-from-zero rule
//! implemented here (`Math.floor(abs(x) * scale + 0.5)` then reapplying
//! `Math.sign(x)`, **not** `Math.round`) is load-bearing for
//! `placement_scorer`/`layout_scorer`'s canonicalized score fields and for
//! `search::beam_state`'s canonical-key coordinate quantization (a different,
//! concurrently-ported module that reuses this exact grid -- per
//! `search-scoring.md` §7.2, "the score-canonicalization grid and the
//! canonical-key coordinate grid are the same module and the same constant"
//! even though `irregularScoreGrid.ts`'s own name/doc-comments frame it as
//! being about scoring specifically).
//!
//! # Shared `Order.Number` primitive
//!
//! Both sibling TS files build every comparator from `effect`'s
//! `Order.Number`/`Order.String`/`Order.Boolean`/`Order.Array`/
//! `Order.combineAll`/`Order.flip` (see `search-scoring.md` §6's primitives
//! recap, read verbatim from `effect@4.0.0-beta.89`'s `Order.ts`).
//! `crate::js_number` already provides the `Order.String` equivalent
//! (`cmp_js_code_units`), and `bool`'s derived `Ord` already matches
//! `Order.Boolean` (`false < true`) with no wrapper needed, but no
//! `Order.Number` equivalent exists yet in a module this task is allowed to
//! touch (`js_number` is out of this task's file-ownership scope -- see this
//! crate's task instructions). [`cmp_number`] is colocated here rather than
//! duplicated independently in both sibling files, since this module is
//! already their one shared dependency (mirroring how both TS files already
//! import the single shared `effect` `Order.Number` primitive from one
//! place rather than each redefining it).

use std::cmp::Ordering;

use crate::js_number::{is_safe_integer, js_math};

/// TS: `irregularScoreGrid.ts:1` `IRREGULAR_SCORE_GRID_STEP_MM = 0.001`.
pub const IRREGULAR_SCORE_GRID_STEP_MM: f64 = 0.001;
/// TS: `irregularScoreGrid.ts:3` `IRREGULAR_SCORE_SCALAR_STEP = 0.000001`.
pub const IRREGULAR_SCORE_SCALAR_STEP: f64 = 0.000001;

/// TS: `irregularScoreGrid.ts:6` `IRREGULAR_SCORE_GRID_SCALE = 1 /
/// IRREGULAR_SCORE_GRID_STEP_MM`. Written as the literal `1000.0` rather than
/// computing `1.0 / IRREGULAR_SCORE_GRID_STEP_MM`: both evaluate to the same
/// nearest-`f64` for this particular constant, but a literal removes any
/// doubt for a value every caller of this module depends on being byte-exact.
const IRREGULAR_SCORE_GRID_SCALE: f64 = 1000.0;
/// TS: `irregularScoreGrid.ts:7` `IRREGULAR_SCORE_SCALAR_SCALE = 1 /
/// IRREGULAR_SCORE_SCALAR_STEP`. See [`IRREGULAR_SCORE_GRID_SCALE`]'s doc for
/// why this is a literal, not a computed reciprocal.
const IRREGULAR_SCORE_SCALAR_SCALE: f64 = 1_000_000.0;

/// TS: `irregularScoreGrid.ts:15-18` `canonicalizeIrregularScoreMillimeters`.
///
/// Canonicalizes one finite millimeter value to the explicit irregular score
/// grid using nearest rounding with ties away from zero, then converts the
/// resulting exact integer grid-unit count back to millimeter scale. Returns
/// `None` for the same conditions
/// [`canonicalize_irregular_score_millimeter_units`] does (see that
/// function's doc).
pub fn canonicalize_irregular_score_millimeters(value_mm: f64) -> Option<f64> {
    canonicalize_irregular_score_millimeter_units(value_mm)
        .map(|grid_units| grid_units / IRREGULAR_SCORE_GRID_SCALE)
}

/// TS: `irregularScoreGrid.ts:21-30` `canonicalizeIrregularScoreMillimeterUnits`.
///
/// Converts one finite millimeter value to an exact integer score-grid
/// identity: `sign(x) * floor(abs(x) * 1000 + 0.5)`, i.e.
/// round-half-**away-from-zero** at the fixed 0.001 mm grid -- **not**
/// `Math.round`'s round-half-toward-`+∞` convention (`js_math::round` is the
/// wrong primitive here; see `js_math::sign`'s own doc comment for the exact
/// rationale this function's `sign`/`floor` composition depends on, including
/// the `Math.sign(0) === 0` / `Math.sign(-0) === -0` sign-of-zero
/// preservation `f64::signum()` does **not** replicate).
///
/// Returns `None` when `value_mm` is non-finite, when the scaled magnitude
/// overflows to a non-finite value, or when the rounded grid value exceeds
/// `Number.MAX_SAFE_INTEGER` (`js_number::is_safe_integer`).
pub fn canonicalize_irregular_score_millimeter_units(value_mm: f64) -> Option<f64> {
    if !value_mm.is_finite() {
        return None;
    }
    let scaled_absolute_value = value_mm.abs() * IRREGULAR_SCORE_GRID_SCALE;
    if !scaled_absolute_value.is_finite() {
        return None;
    }
    let rounded_absolute_value = js_math::floor(scaled_absolute_value + 0.5);
    let grid_value = js_math::sign(value_mm) * rounded_absolute_value;
    if is_safe_integer(grid_value) {
        Some(grid_value)
    } else {
        None
    }
}

/// TS: `irregularScoreGrid.ts:33-41` `canonicalizeIrregularScoreScalar`.
///
/// Identical algorithm to [`canonicalize_irregular_score_millimeter_units`]
/// at a different scale (`IRREGULAR_SCORE_SCALAR_STEP`, six decimal digits),
/// used for dimensionless values. Unlike the millimeter-units variant, there
/// is no "return raw grid units" sibling -- this always divides back to the
/// original scale before returning, matching `irregularScoreGrid.ts:41`'s
/// single combined `undefined`/`gridValue / IRREGULAR_SCORE_SCALAR_SCALE`
/// return expression.
pub fn canonicalize_irregular_score_scalar(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    let scaled_absolute_value = value.abs() * IRREGULAR_SCORE_SCALAR_SCALE;
    if !scaled_absolute_value.is_finite() {
        return None;
    }
    let rounded_absolute_value = js_math::floor(scaled_absolute_value + 0.5);
    let grid_value = js_math::sign(value) * rounded_absolute_value;
    if is_safe_integer(grid_value) {
        Some(grid_value / IRREGULAR_SCORE_SCALAR_SCALE)
    } else {
        None
    }
}

/// `effect`'s `Order.Number` (`Order.ts:177-182`, wrapped by `Order.make`'s
/// `self === that` shortcut at `Order.ts:111-115`, whose only observable
/// effect versus the raw unwrapped body is that equal non-NaN operands take
/// the shortcut path instead of falling through to `self < that ? -1 : 1` --
/// provably the same result either way, see `search-scoring.md` §6's
/// primitives recap): every `NaN` compares equal to every other `NaN` and
/// sorts before every non-NaN value; `+0` and `-0` compare equal. Rust's
/// `f64::partial_cmp` returns `None` for any `NaN` operand (not usable as a
/// total order) and `f64::total_cmp` distinguishes negative/positive `NaN`
/// payloads and treats `-0.0 < 0.0` (both wrong for this port) -- see
/// `search-scoring.md` §12 item 6.
pub(crate) fn cmp_number(a: f64, b: f64) -> Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => {
            if a < b {
                Ordering::Less
            } else if a > b {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn millimeter_units_round_half_away_from_zero() {
        // 0.0015 mm * 1000 = 1.5 -> floor(1.5+0.5) = 2, not Math.round's 2
        // either here, but the *negative* halfway case tells them apart:
        // Math.round(-1.5) would be -1 (toward +inf); this algorithm gives -2.
        assert_eq!(
            canonicalize_irregular_score_millimeter_units(0.0015),
            Some(2.0)
        );
        assert_eq!(
            canonicalize_irregular_score_millimeter_units(-0.0015),
            Some(-2.0)
        );
        assert_eq!(
            canonicalize_irregular_score_millimeter_units(0.0005),
            Some(1.0)
        );
        assert_eq!(
            canonicalize_irregular_score_millimeter_units(-0.0005),
            Some(-1.0)
        );
    }

    #[test]
    fn millimeter_units_preserve_sign_of_zero() {
        let positive = canonicalize_irregular_score_millimeter_units(0.0).unwrap();
        let negative = canonicalize_irregular_score_millimeter_units(-0.0).unwrap();
        assert_eq!(positive.to_bits(), 0.0_f64.to_bits());
        assert_eq!(negative.to_bits(), (-0.0_f64).to_bits());
    }

    #[test]
    fn millimeter_units_reject_non_finite_and_overflow() {
        assert_eq!(
            canonicalize_irregular_score_millimeter_units(f64::NAN),
            None
        );
        assert_eq!(
            canonicalize_irregular_score_millimeter_units(f64::INFINITY),
            None
        );
        // Just past Number.MAX_SAFE_INTEGER / 1000 once scaled and rounded.
        assert_eq!(canonicalize_irregular_score_millimeter_units(1.0e18), None);
    }

    #[test]
    fn millimeters_divide_grid_units_back_to_mm_scale() {
        assert_eq!(
            canonicalize_irregular_score_millimeters(1.2345),
            Some(1.235)
        );
        assert_eq!(canonicalize_irregular_score_millimeters(f64::NAN), None);
    }

    #[test]
    fn scalar_uses_six_decimal_digit_grid() {
        assert_eq!(
            canonicalize_irregular_score_scalar(0.1234565),
            Some(0.123457)
        );
        assert_eq!(canonicalize_irregular_score_scalar(f64::INFINITY), None);
    }

    #[test]
    fn cmp_number_treats_all_nan_as_mutually_equal_and_least() {
        assert_eq!(cmp_number(f64::NAN, f64::NAN), Ordering::Equal);
        assert_eq!(cmp_number(f64::NAN, 0.0), Ordering::Less);
        assert_eq!(cmp_number(0.0, f64::NAN), Ordering::Greater);
        assert_eq!(cmp_number(0.0, -0.0), Ordering::Equal);
        assert_eq!(cmp_number(1.0, 2.0), Ordering::Less);
        assert_eq!(cmp_number(2.0, 1.0), Ordering::Greater);
    }
}
