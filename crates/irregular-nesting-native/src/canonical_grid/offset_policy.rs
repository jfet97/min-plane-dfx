//! The float <-> canonical-grid quantization authority.
//!
//! TS source: `src/workers/irregular/clipper2OffsetPolicy.ts`. Only the
//! grid/mm conversion functions (`toGridMm`/`fromGrid`) are ported here, per
//! this module's assignment; the rest of that file's policy constants and
//! `conservativeOffsetMm` belong to the Clipper2 offset module, out of scope
//! here.

use super::js_local::{is_finite, math_sign};

/// TS source: `clipper2OffsetPolicy.ts:11` (`CLIPPER2_OFFSET_POLICY.scale`).
const CLIPPER2_OFFSET_SCALE: f64 = 1000.0;

/// Quantizes millimeters to the adapter grid using nearest rounding with ties
/// away from zero. `None` means the value cannot be represented safely.
///
/// TS source: `clipper2OffsetPolicy.ts:44-53` (`toGridMm`).
pub fn to_grid_mm(value_mm: f64) -> Option<f64> {
    if !is_finite(value_mm) {
        return None;
    }

    // `Math.abs`/`Math.floor` are bit-exact IEEE-754 operations shared by
    // both `f64` and JS `number`; no local helper is needed for either (see
    // `math_sign` below for the one JS `Math.*` primitive here that *does*
    // need one).
    let scaled_absolute_value = value_mm.abs() * CLIPPER2_OFFSET_SCALE;
    if !is_finite(scaled_absolute_value) {
        return None;
    }

    let rounded_absolute_value = (scaled_absolute_value + 0.5).floor();
    let grid_value = math_sign(value_mm) * rounded_absolute_value;
    if super::js_local::is_safe_integer(grid_value) {
        Some(grid_value)
    } else {
        None
    }
}

/// Dequantizes one Clipper2 integer coordinate without applying another
/// rounding pass.
///
/// TS source: `clipper2OffsetPolicy.ts:56-58` (`fromGrid`).
pub fn from_grid(value: f64) -> f64 {
    value / CLIPPER2_OFFSET_SCALE
}

#[cfg(test)]
mod tests {
    use super::*;

    // `NaN`/`+-Infinity` inputs, not representable in the JSON differential
    // vectors (see `tests/canonical_grid_vectors.rs`'s `toGridMmSpecialVectors`
    // for the JSON-tagged equivalents actually exercised against the real TS
    // function); these confirm the same branches taking `f64` literals
    // directly.

    #[test]
    fn to_grid_mm_rejects_non_finite_input() {
        assert_eq!(to_grid_mm(f64::NAN), None);
        assert_eq!(to_grid_mm(f64::INFINITY), None);
        assert_eq!(to_grid_mm(f64::NEG_INFINITY), None);
    }

    #[test]
    fn to_grid_mm_preserves_negative_zero() {
        let result = to_grid_mm(-0.0).expect("negative zero is representable");
        assert_eq!(result.to_bits(), (-0.0f64).to_bits());
    }

    #[test]
    fn to_grid_mm_rounds_ties_away_from_zero() {
        assert_eq!(to_grid_mm(0.0005), Some(1.0));
        assert_eq!(to_grid_mm(-0.0005), Some(-1.0));
    }

    #[test]
    fn from_grid_is_exact_division_by_scale() {
        assert_eq!(from_grid(1000.0), 1.0);
        assert_eq!(from_grid(-1000.0), -1.0);
        assert_eq!(from_grid(0.0).to_bits(), 0.0f64.to_bits());
    }
}
