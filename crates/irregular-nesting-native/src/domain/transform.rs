//! Placement transform and finite transform-candidate trusted carriers.
//!
//! TS source: `src/shared/irregular/domain.ts:14-21,216-273`.

use serde::{Deserialize, Serialize};

/// TS: `domain.ts:14-21` `IrregularTransformReason` —
/// `Schema.Literals(['orthogonal', 'edge_alignment', 'configured'])`.
/// Explains why a transform candidate was included in the finite transform
/// set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IrregularTransformReason {
    Orthogonal,
    EdgeAlignment,
    Configured,
}

/// TS: `domain.ts:224-241` `class IrregularTransform`. A finite translation,
/// rotation, and mirror transform for a placed piece.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularTransform {
    pub translate_x: f64,
    pub translate_y: f64,
    pub rotation_deg: f64,
    pub mirrored: bool,
}

/// TS: `domain.ts:243-247` doc comment: rotation values are intentionally
/// *not* range-limited by the schema — the worker canonicalizes periodic
/// values such as `-90` and `450` without changing their geometry. This
/// trusted carrier stores whatever finite `rotationDeg` it is given
/// unmodified; canonicalization is a separate, later concern (owned by the
/// `transforms` module, not this one).
///
/// `domain.ts:256-273` `class IrregularTransformCandidate`. `index` is
/// `NonNegativeFiniteInteger` (`domain.ts:249`, i.e.
/// `Schema.Int.check(isGreaterThanOrEqualTo(0))`) — an integer-valued JS
/// `number`, mirrored here as `f64` rather than a narrower Rust integer type.
/// This follows the convention already established by
/// `canonical_grid::CanonicalGridPoint`'s doc comment ("Both fields are plain
/// `f64` (TS `number`), mirroring the TS type exactly"): every JS `number`
/// field in this domain layer is `f64` regardless of the schema's own
/// integer/non-negative refinements, since those refinements are checked
/// only at the TS decode boundary (not re-validated by this trusted
/// carrier), and a narrower Rust type could silently diverge on
/// out-of-range input instead of mirroring JS's actual runtime
/// representation. Callers that use `index` as an array/Vec index convert it
/// explicitly (e.g. `candidate.index as usize`) at the point of use.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularTransformCandidate {
    pub index: f64,
    pub rotation_deg: f64,
    pub mirrored: bool,
    pub reason: IrregularTransformReason,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn irregular_transform_reason_serializes_to_ts_literal_strings() {
        assert_eq!(
            serde_json::to_string(&IrregularTransformReason::Orthogonal).unwrap(),
            "\"orthogonal\""
        );
        assert_eq!(
            serde_json::to_string(&IrregularTransformReason::EdgeAlignment).unwrap(),
            "\"edge_alignment\""
        );
        assert_eq!(
            serde_json::to_string(&IrregularTransformReason::Configured).unwrap(),
            "\"configured\""
        );
    }

    #[test]
    fn irregular_transform_candidate_round_trips_with_out_of_range_rotation() {
        // domain.ts:243-247: rotation is intentionally not range-limited.
        let candidate = IrregularTransformCandidate {
            index: 3.0,
            rotation_deg: 450.0,
            mirrored: true,
            reason: IrregularTransformReason::EdgeAlignment,
        };
        let json = serde_json::to_string(&candidate).expect("candidate serializes");
        let decoded: IrregularTransformCandidate =
            serde_json::from_str(&json).expect("candidate deserializes");
        assert_eq!(decoded, candidate);
    }

    #[test]
    fn irregular_transform_field_order_matches_ts_declaration_order() {
        let transform = IrregularTransform {
            translate_x: 1.0,
            translate_y: 2.0,
            rotation_deg: 90.0,
            mirrored: false,
        };
        let json = serde_json::to_string(&transform).unwrap();
        assert_eq!(
            json,
            r#"{"translateX":1.0,"translateY":2.0,"rotationDeg":90.0,"mirrored":false}"#
        );
    }
}
