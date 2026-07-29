//! Prepared-piece, placement, and placed-piece trusted carriers.
//!
//! TS source: `src/shared/irregular/domain.ts:468-783`.

use serde::{Deserialize, Serialize};

use super::collision::{
    CollisionGeometry, CollisionGeometryDiagnostic, TransformedCollisionGeometry,
};
use super::geometry::IrregularPoint;
use super::ids::PieceId;
use super::source::ImportedPiece;
use super::transform::{IrregularTransform, IrregularTransformCandidate};

/// TS: `domain.ts:476-490` `class IrregularPriorityOrderKey`. Priority key
/// retained from the user-owned prepared rectangle ordering.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularPriorityOrderKey {
    pub long_side_mm: f64,
    pub area_mm2: f64,
    pub imbalance_mm: f64,
}

/// TS: `domain.ts:644-676` `class IrregularPreparedPiece`. A source piece
/// paired with its prepared collision geometry and transforms.
///
/// `pieceId`, `interchangeabilityKey`, and `priorityOrderKey` are each
/// independently `hasOwnProperty`-gated in the TS constructor
/// (`domain.ts:662-674`) — true own-property omission, not
/// `undefined`-valued presence. See `collision.rs`'s doc comment for the
/// full **[UNDEFINED-OMIT]** rationale this module reuses; `Option::None`
/// plus `#[serde(skip_serializing_if = "Option::is_none")]` is the
/// equivalent used here for test-vector IO.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularPreparedPiece {
    /// TS: `domain.ts:632` — prepared or copied identity; legacy payloads
    /// fall back to `source.id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub piece_id: Option<PieceId>,
    /// TS: `domain.ts:634` — search-equivalence class shared only by
    /// interchangeable prepared copies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interchangeability_key: Option<String>,
    pub source: ImportedPiece,
    pub allow_mirror: bool,
    pub collision_geometry: CollisionGeometry,
    pub transforms: Vec<IrregularTransformCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority_order_key: Option<IrregularPriorityOrderKey>,
}

/// TS: `domain.ts:683-715` `class IrregularPlacement`.
///
/// A prepared piece transform retained as part of a final irregular
/// placement. Its translation positions `placementReference` after
/// mirror-then-rotation around that same source-space point
/// (`domain.ts:679-682`).
///
/// `pieceId` and `placementReference` are each independently
/// `hasOwnProperty`-gated (`domain.ts:706-712`) — see
/// [`IrregularPreparedPiece`]'s doc comment for the omission convention this
/// reuses.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularPlacement {
    /// TS: `domain.ts:685` — prepared or copied piece identity; new results
    /// must always emit this id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub piece_id: Option<PieceId>,
    /// TS: `domain.ts:687` — original imported piece identity retained for
    /// source-geometry lookup.
    pub source_piece_id: PieceId,
    /// TS: `domain.ts:689` — source-space pivot for the transform; new
    /// worker results always emit it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement_reference: Option<IrregularPoint>,
    pub transform: IrregularTransform,
}

/// TS: `domain.ts:725-736` `class IrregularPlacedPiece`.
///
/// A placed piece with the transformed collision geometry used for
/// legality. Trusted internal search artifact, plain for the same reason as
/// [`TransformedCollisionGeometry`](super::collision::TransformedCollisionGeometry):
/// the worker result exposes only its `placement`; replay data carrying the
/// complete structural shape validates instead against the separate
/// `IrregularPlacedPieceSchema` (`domain.ts:754-757`), a validation-boundary
/// concern not ported here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularPlacedPiece {
    pub placement: IrregularPlacement,
    pub collision_geometry: TransformedCollisionGeometry,
}

/// TS: `domain.ts:766-783` `class IrregularPlacementCandidate`.
///
/// A candidate placement point plus its transform and diagnostics. Trusted
/// internal search artifact: candidate generation emits one per legal grid
/// point and nothing outside the worker consumes it (`domain.ts:759-765`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularPlacementCandidate {
    pub piece_id: PieceId,
    pub transform: IrregularTransformCandidate,
    pub point: IrregularPoint,
    pub diagnostics: Vec<CollisionGeometryDiagnostic>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::geometry::{IrregularBounds, IrregularPolygon};
    use crate::domain::ids::SourceFileId;
    use crate::domain::source::{DxfGeometryEntityType, DxfGeometrySummary, Rect};
    use crate::domain::transform::IrregularTransformReason;

    fn sample_imported_piece() -> ImportedPiece {
        ImportedPiece {
            id: PieceId::new("piece-1"),
            source_file_id: SourceFileId::new("file-1"),
            source_layer: None,
            label: "test piece".to_string(),
            real_bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 60.0,
            },
            geometry: DxfGeometrySummary {
                entity_type: DxfGeometryEntityType::PresetShape,
                closed: true,
                segments: vec![],
            },
            warnings: vec![],
        }
    }

    fn sample_collision_geometry() -> CollisionGeometry {
        let square = IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(10.0, 0.0),
            IrregularPoint::new(10.0, 10.0),
            IrregularPoint::new(0.0, 10.0),
        ]);
        CollisionGeometry {
            source_piece_id: PieceId::new("piece-1"),
            source_bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
            sampled_points: vec![],
            convex_hull: square.clone(),
            collision_polygon: square,
            placement_reference: IrregularPoint::new(0.0, 0.0),
            diagnostics: vec![],
        }
    }

    #[test]
    fn irregular_prepared_piece_omits_absent_optional_fields() {
        let prepared = IrregularPreparedPiece {
            piece_id: None,
            interchangeability_key: None,
            source: sample_imported_piece(),
            allow_mirror: true,
            collision_geometry: sample_collision_geometry(),
            transforms: vec![],
            priority_order_key: None,
        };
        let json = serde_json::to_string(&prepared).expect("prepared piece serializes");
        assert!(!json.contains("pieceId"));
        assert!(!json.contains("interchangeabilityKey"));
        assert!(!json.contains("priorityOrderKey"));
        let decoded: IrregularPreparedPiece =
            serde_json::from_str(&json).expect("prepared piece deserializes");
        assert_eq!(decoded, prepared);
    }

    #[test]
    fn irregular_prepared_piece_round_trips_with_all_optional_fields_present() {
        let prepared = IrregularPreparedPiece {
            piece_id: Some(PieceId::new("prepared-1")),
            interchangeability_key: Some("family-a".to_string()),
            source: sample_imported_piece(),
            allow_mirror: false,
            collision_geometry: sample_collision_geometry(),
            transforms: vec![IrregularTransformCandidate {
                index: 0.0,
                rotation_deg: 0.0,
                mirrored: false,
                reason: IrregularTransformReason::Orthogonal,
            }],
            priority_order_key: Some(IrregularPriorityOrderKey {
                long_side_mm: 100.0,
                area_mm2: 6000.0,
                imbalance_mm: 40.0,
            }),
        };
        let json = serde_json::to_string(&prepared).expect("prepared piece serializes");
        let decoded: IrregularPreparedPiece =
            serde_json::from_str(&json).expect("prepared piece deserializes");
        assert_eq!(decoded, prepared);
    }

    #[test]
    fn irregular_placement_omits_absent_piece_id_and_placement_reference() {
        let placement = IrregularPlacement {
            piece_id: None,
            source_piece_id: PieceId::new("piece-1"),
            placement_reference: None,
            transform: IrregularTransform {
                translate_x: 0.0,
                translate_y: 0.0,
                rotation_deg: 0.0,
                mirrored: false,
            },
        };
        let json = serde_json::to_string(&placement).expect("placement serializes");
        assert_eq!(
            json,
            r#"{"sourcePieceId":"piece-1","transform":{"translateX":0.0,"translateY":0.0,"rotationDeg":0.0,"mirrored":false}}"#
        );
        let decoded: IrregularPlacement =
            serde_json::from_str(&json).expect("placement deserializes");
        assert_eq!(decoded, placement);
    }

    #[test]
    fn irregular_placed_piece_round_trips_through_json() {
        let placed = IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: Some(PieceId::new("prepared-1")),
                source_piece_id: PieceId::new("piece-1"),
                placement_reference: Some(IrregularPoint::new(1.0, 2.0)),
                transform: IrregularTransform {
                    translate_x: 10.0,
                    translate_y: 20.0,
                    rotation_deg: 90.0,
                    mirrored: true,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new("piece-1"),
                transform: IrregularTransformCandidate {
                    index: 1.0,
                    rotation_deg: 90.0,
                    mirrored: true,
                    reason: IrregularTransformReason::Configured,
                },
                polygon: IrregularPolygon::new(vec![IrregularPoint::new(0.0, 0.0)]),
                bounds: IrregularBounds::new(0.0, 0.0, 1.0, 1.0),
            },
        };
        let json = serde_json::to_string(&placed).expect("placed piece serializes");
        let decoded: IrregularPlacedPiece =
            serde_json::from_str(&json).expect("placed piece deserializes");
        assert_eq!(decoded, placed);
    }

    #[test]
    fn irregular_placement_candidate_round_trips_through_json() {
        let candidate = IrregularPlacementCandidate {
            piece_id: PieceId::new("piece-1"),
            transform: IrregularTransformCandidate {
                index: 2.0,
                rotation_deg: 180.0,
                mirrored: false,
                reason: IrregularTransformReason::EdgeAlignment,
            },
            point: IrregularPoint::new(5.0, 5.0),
            diagnostics: vec![CollisionGeometryDiagnostic {
                code: "note".to_string(),
                message: "m".to_string(),
                piece_id: None,
            }],
        };
        let json = serde_json::to_string(&candidate).expect("candidate serializes");
        let decoded: IrregularPlacementCandidate =
            serde_json::from_str(&json).expect("candidate deserializes");
        assert_eq!(decoded, candidate);
    }
}
