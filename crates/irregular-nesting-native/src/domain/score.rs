//! Whole-layout score summary.
//!
//! TS source: `src/shared/irregular/domain.ts:900-925`.

use serde::{Deserialize, Serialize};

/// TS: `domain.ts:901-925` `class IrregularLayoutScoreSummary`. Named
/// whole-layout criteria retained for an irregular result or progress
/// update.
///
/// This is a `Schema.Class`, and each field below marked "optional" uses
/// plain `Schema.optional(...)` with **no** default
/// (`Schema.optionalKey`/`withConstructorDefault`/`withDecodingDefaultKey`
/// are not used here, unlike `settings.rs`'s fields). Effect's generated
/// `Schema.Class` constructor/decoder for a bare `Schema.optional` field only
/// assigns the resulting instance's property when the input actually
/// supplies one — true own-property omission when absent, the same
/// **[UNDEFINED-OMIT]** convention documented in `collision.rs` and
/// `piece.rs`. Each such field is `Option<f64>`/`Option<u32>`-shaped here
/// (concretely `Option<f64>`, per this module's number-fidelity convention)
/// with `#[serde(skip_serializing_if = "Option::is_none")]`, reflecting that
/// older persisted results/progress updates saved before the corresponding
/// scoring criterion existed decode with that field entirely absent, not
/// `null`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularLayoutScoreSummary {
    /// TS: `domain.ts:904` `NonNegativeFiniteInteger` — required.
    pub unplaced_count: f64,
    /// TS: `domain.ts:906` — optional for backward-compatible decoding of
    /// results saved before contact scoring.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_collision_boundary_length_mm: Option<f64>,
    /// TS: `domain.ts:908` — optional for results saved before
    /// scale-normalized contact scoring.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_collision_boundary_contact_units: Option<f64>,
    /// TS: `domain.ts:910` — optional whole-contact band used by the
    /// whole-layout comparator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_collision_boundary_contact_band: Option<f64>,
    /// TS: `domain.ts:912` — optional for results saved before
    /// structural-contact classification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_complete_structural_contact_count: Option<f64>,
    /// TS: `domain.ts:914` — optional for results saved before repeated
    /// structural-contact classification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dominant_near_complete_structural_contact_count: Option<f64>,
    /// TS: `domain.ts:915` `NonNegativeFiniteNumber` — required.
    pub largest_net_free_material_region_area_mm2: f64,
    /// TS: `domain.ts:916` `NonNegativeFiniteInteger` — required.
    pub free_material_region_count: f64,
    /// TS: `domain.ts:917` `NonNegativeFiniteInteger` — required.
    pub free_material_hole_count: f64,
    /// TS: `domain.ts:919` — sheet-independent occupied-union cavities,
    /// when measured by an exact archive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_enclosed_cavity_count: Option<f64>,
    /// TS: `domain.ts:920` `NonNegativeFiniteNumber` — required.
    pub free_material_sliver_metric: f64,
    /// TS: `domain.ts:921` `NonNegativeFiniteNumber` — required.
    pub collision_bounds_worst_normalized_sheet_consumption: f64,
    /// TS: `domain.ts:922` `NonNegativeFiniteNumber` — required.
    pub collision_bounds_normalized_span_sum: f64,
    /// TS: `domain.ts:923` `NonNegativeFiniteNumber` — required.
    pub collision_bounds_area_mm2: f64,
    /// TS: `domain.ts:924` `NonNegativeFiniteNumber` — required.
    pub collision_bounds_span_mm: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_score() -> IrregularLayoutScoreSummary {
        IrregularLayoutScoreSummary {
            unplaced_count: 0.0,
            shared_collision_boundary_length_mm: None,
            shared_collision_boundary_contact_units: None,
            shared_collision_boundary_contact_band: None,
            near_complete_structural_contact_count: None,
            dominant_near_complete_structural_contact_count: None,
            largest_net_free_material_region_area_mm2: 1234.5,
            free_material_region_count: 2.0,
            free_material_hole_count: 0.0,
            canonical_enclosed_cavity_count: None,
            free_material_sliver_metric: 0.0,
            collision_bounds_worst_normalized_sheet_consumption: 0.5,
            collision_bounds_normalized_span_sum: 1.5,
            collision_bounds_area_mm2: 20000.0,
            collision_bounds_span_mm: 300.0,
        }
    }

    #[test]
    fn score_summary_omits_all_absent_optional_fields() {
        let score = minimal_score();
        let json = serde_json::to_string(&score).expect("score serializes");
        assert!(!json.contains("sharedCollisionBoundaryLengthMm"));
        assert!(!json.contains("sharedCollisionBoundaryContactUnits"));
        assert!(!json.contains("sharedCollisionBoundaryContactBand"));
        assert!(!json.contains("nearCompleteStructuralContactCount"));
        assert!(!json.contains("dominantNearCompleteStructuralContactCount"));
        assert!(!json.contains("canonicalEnclosedCavityCount"));
        let decoded: IrregularLayoutScoreSummary =
            serde_json::from_str(&json).expect("score deserializes");
        assert_eq!(decoded, score);
    }

    #[test]
    fn score_summary_round_trips_with_every_optional_field_present() {
        let score = IrregularLayoutScoreSummary {
            shared_collision_boundary_length_mm: Some(10.0),
            shared_collision_boundary_contact_units: Some(2.0),
            shared_collision_boundary_contact_band: Some(1.0),
            near_complete_structural_contact_count: Some(3.0),
            dominant_near_complete_structural_contact_count: Some(1.0),
            canonical_enclosed_cavity_count: Some(0.0),
            ..minimal_score()
        };
        let json = serde_json::to_string(&score).expect("score serializes");
        let decoded: IrregularLayoutScoreSummary =
            serde_json::from_str(&json).expect("score deserializes");
        assert_eq!(decoded, score);
    }
}
