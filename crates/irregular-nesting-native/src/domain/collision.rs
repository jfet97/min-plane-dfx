//! Collision-geometry diagnostics and the collision-geometry trusted
//! carriers derived from one imported source piece.
//!
//! TS source: `src/shared/irregular/domain.ts:500-628`.

use serde::{Deserialize, Serialize};

use super::geometry::{IrregularBounds, IrregularPoint, IrregularPolygon};
use super::ids::PieceId;
use super::transform::IrregularTransformCandidate;

/// TS: `domain.ts:508-524` `class CollisionGeometryDiagnostic`. A
/// diagnostic attached to an irregular geometry or portfolio artifact.
///
/// `pieceId` is `hasOwnProperty`-gated in the TS constructor
/// (`domain.ts:520-522`: `if (Object.prototype.hasOwnProperty.call(fields,
/// 'pieceId')) { this.pieceId = fields.pieceId }`) — a true own-property
/// omission, not an `undefined`-valued key. Per
/// `docs/planning/rust-irregular-backend/semantic-mapping.md` §2.3
/// **[UNDEFINED-OMIT]**, `Option::None` plus
/// `#[serde(skip_serializing_if = "Option::is_none")]` is this crate's
/// equivalent for test-vector IO; note that `serde`'s serialization here is
/// for test-vector round-tripping only, not the crate's semantic/canonical
/// encoding (owned by `checkpoints::canonical_json` and friends), per this
/// module's top-level doc.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollisionGeometryDiagnostic {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub piece_id: Option<PieceId>,
}

/// TS: `domain.ts:526-548` `class FlattenedGeometry`. Flattened source
/// samples and diagnostics before hull and offset derivation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlattenedGeometry {
    pub source_piece_id: PieceId,
    pub sampled_points: Vec<IrregularPoint>,
    pub diagnostics: Vec<CollisionGeometryDiagnostic>,
}

/// TS: `domain.ts:554-598` `class CollisionGeometry`. Conservative collision
/// geometry derived from one imported source piece. Polygons are local to
/// the stored padded placement reference (`domain.ts:552-553`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollisionGeometry {
    /// TS: `domain.ts:556` — source piece that produced this derived
    /// collision artifact.
    pub source_piece_id: PieceId,
    /// TS: `domain.ts:558` — unpadded convex-hull bounds in original source
    /// coordinates.
    pub source_bounds: IrregularBounds,
    /// TS: `domain.ts:560` — flattened source points kept in original
    /// source coordinates for diagnostics.
    pub sampled_points: Vec<IrregularPoint>,
    /// TS: `domain.ts:562` — convex hull rebased to the collision polygon's
    /// placement origin.
    pub convex_hull: IrregularPolygon,
    /// TS: `domain.ts:564` — padded collision polygon whose lower-left
    /// bounds corner is local `(0, 0)`.
    pub collision_polygon: IrregularPolygon,
    /// TS: `domain.ts:566` — source-space coordinate of the padded
    /// collision bounds corner used as placement origin.
    pub placement_reference: IrregularPoint,
    /// TS: `domain.ts:568` — import and geometry diagnostics carried with
    /// this derived artifact.
    pub diagnostics: Vec<CollisionGeometryDiagnostic>,
}

/// TS: `domain.ts:611-628` `class TransformedCollisionGeometry`.
///
/// A transformed local collision polygon and its derived finite bounds.
/// This is a trusted internal search artifact produced by the geometry
/// kernel from already-decoded input (`domain.ts:600-610`): the class itself
/// is never used as boundary validation. Replay data carrying the same
/// structural shape validates instead against the separate
/// `TransformedCollisionGeometrySchema` (`domain.ts:746-751`), which is a
/// validation-boundary concern and is not ported by this module — see this
/// file's top-level doc.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformedCollisionGeometry {
    pub source_piece_id: PieceId,
    pub transform: IrregularTransformCandidate,
    pub polygon: IrregularPolygon,
    pub bounds: IrregularBounds,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::transform::IrregularTransformReason;

    fn sample_polygon() -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(10.0, 0.0),
            IrregularPoint::new(10.0, 10.0),
            IrregularPoint::new(0.0, 10.0),
        ])
    }

    #[test]
    fn collision_geometry_diagnostic_omits_absent_piece_id() {
        let diagnostic = CollisionGeometryDiagnostic {
            code: "warn".to_string(),
            message: "m".to_string(),
            piece_id: None,
        };
        let json = serde_json::to_string(&diagnostic).unwrap();
        assert_eq!(json, r#"{"code":"warn","message":"m"}"#);

        let with_piece = CollisionGeometryDiagnostic {
            piece_id: Some(PieceId::new("piece-1")),
            ..diagnostic
        };
        let json = serde_json::to_string(&with_piece).unwrap();
        assert!(json.contains(r#""pieceId":"piece-1""#));
        let decoded: CollisionGeometryDiagnostic = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, with_piece);
    }

    #[test]
    fn collision_geometry_round_trips_through_json() {
        let geometry = CollisionGeometry {
            source_piece_id: PieceId::new("piece-1"),
            source_bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
            sampled_points: vec![IrregularPoint::new(0.0, 0.0)],
            convex_hull: sample_polygon(),
            collision_polygon: sample_polygon(),
            placement_reference: IrregularPoint::new(0.0, 0.0),
            diagnostics: vec![],
        };
        let json = serde_json::to_string(&geometry).expect("collision geometry serializes");
        let decoded: CollisionGeometry =
            serde_json::from_str(&json).expect("collision geometry deserializes");
        assert_eq!(decoded, geometry);
    }

    #[test]
    fn transformed_collision_geometry_round_trips_through_json() {
        let transformed = TransformedCollisionGeometry {
            source_piece_id: PieceId::new("piece-1"),
            transform: IrregularTransformCandidate {
                index: 0.0,
                rotation_deg: 0.0,
                mirrored: false,
                reason: IrregularTransformReason::Orthogonal,
            },
            polygon: sample_polygon(),
            bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
        };
        let json = serde_json::to_string(&transformed).expect("transformed geometry serializes");
        let decoded: TransformedCollisionGeometry =
            serde_json::from_str(&json).expect("transformed geometry deserializes");
        assert_eq!(decoded, transformed);
    }
}
