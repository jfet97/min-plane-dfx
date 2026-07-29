//! Transformed-collision-geometry and rectangular-IFP cache identity —
//! ported from `src/workers/irregular/core/geometryCacheIdentity.ts`.
//!
//! Namespaces `transform-collision-v1` (design doc §1.2) and `sheet-ifp-v1`
//! (design doc §1.3). `boundsForPoints`/`isInternalPolygon` are **not**
//! re-ported here: `boundsForPoints` is already a byte-exact port at
//! `geometry::convex::bounds_for_points` (reused directly below —
//! `geometryCacheIdentity.ts:64-84` and `convexBounds.ts:8-32` are the same
//! function, confirmed by direct comparison), and `isInternalPolygon`
//! (`geometryCacheIdentity.ts:143-146`, a runtime shape guard needed only
//! because TS values arriving from an untyped cache lookup are `unknown`)
//! has no Rust equivalent to port: this crate's cache store already
//! recovers static typing via `downcast_ref` (see `store.rs`'s module doc),
//! so "is this really a polygon-shaped object" is enforced by the type
//! system instead of a runtime predicate.

use crate::domain::{
    CollisionGeometry, IrregularGeometrySettings, IrregularTransformCandidate,
    IrregularTransformReason, SheetSpec, TransformedCollisionGeometry,
};
use crate::js_number::fold_negative_zero_key;

use super::nfp_cache_key::{geometry_settings_parts, point_digest};
use super::store::GeometryCacheKey;

/// TS: `geometryCacheIdentity.ts:13` `TRANSFORM_GEOMETRY_CACHE_NAMESPACE`.
pub const TRANSFORM_GEOMETRY_CACHE_NAMESPACE: &str = "transform-collision-v1";

/// TS: `geometryCacheIdentity.ts:14` `IFP_GEOMETRY_CACHE_NAMESPACE`.
pub const IFP_GEOMETRY_CACHE_NAMESPACE: &str = "sheet-ifp-v1";

/// TS: `geometryCacheIdentity.ts:16-22` `TransformCollisionGeometryKeyInput`.
///
/// Concretized to this crate's single `domain::CollisionGeometry`/
/// `domain::IrregularTransformCandidate` shapes rather than reproducing TS's
/// `<TPieceId, TTransform>` generics — see `transform_collision_geometry.rs`'s
/// module doc for why this port fixes the generic parameters instead of
/// reproducing them (no second concrete instantiation exists anywhere in
/// this crate to generalize over yet).
pub struct TransformCollisionGeometryKeyInput<'a> {
    pub geometry: &'a CollisionGeometry,
    pub transform: &'a IrregularTransformCandidate,
}

/// TS: `geometryCacheIdentity.ts:24-31` `InnerFitBoundsKeyInput`.
pub struct InnerFitBoundsKeyInput<'a> {
    pub sheet: &'a SheetSpec,
    pub moving: &'a TransformedCollisionGeometry,
}

/// TS: `geometryCacheIdentity.ts:34-48` (`makeTransformCollisionGeometryCacheKey`).
pub fn make_transform_collision_geometry_cache_key(
    input: &TransformCollisionGeometryKeyInput<'_>,
    settings: &IrregularGeometrySettings,
) -> GeometryCacheKey {
    let mut parts = Vec::with_capacity(9);
    parts.push(collision_geometry_digest(input.geometry));
    parts.push(transform_digest(input.transform));
    parts.extend(geometry_settings_parts(settings));
    parts.push("placement-reference=local-lower-left".to_string());
    parts.push("transform-operation=mirror-y-then-ccw-rotate".to_string());
    GeometryCacheKey::new(TRANSFORM_GEOMETRY_CACHE_NAMESPACE, parts)
}

/// TS: `geometryCacheIdentity.ts:51-62` (`makeInnerFitBoundsCacheKey`).
///
/// Note the sheet identity here **includes** `label`
/// (`sheet=<w>,<h>,<label>`) — unlike `legal_candidate_memo`'s sheet
/// identity, which intentionally omits it (see that module's doc comment
/// and `nfp-ifp.md` §15 item 5; this asymmetry is preserved verbatim, not
/// "fixed" into consistency).
pub fn make_inner_fit_bounds_cache_key(input: &InnerFitBoundsKeyInput<'_>) -> GeometryCacheKey {
    let parts = vec![
        format!(
            "sheet={},{},{}",
            fold_negative_zero_key(input.sheet.width),
            fold_negative_zero_key(input.sheet.height),
            input.sheet.label
        ),
        format!("moving-piece={}", input.moving.source_piece_id),
        format!(
            "moving-transform={}",
            transform_digest(&input.moving.transform)
        ),
        format!(
            "moving-polygon={}",
            polygon_digest(&input.moving.polygon.points)
        ),
        "ifp-operation=rectangular-sheet-vertex-bounds".to_string(),
    ];
    GeometryCacheKey::new(IFP_GEOMETRY_CACHE_NAMESPACE, parts)
}

/// TS: `geometryCacheIdentity.ts:86-96` (`sameTransform`).
///
/// Cross-namespace hazard (design doc §1.6, `js_number`'s module doc
/// implicitly, and this crate's own `transforms::rotate` doc comment): uses
/// the **raw, unnormalized** `rotation_deg` — `0.0` and `360.0` are
/// different keys/different cache validity even though
/// `transforms::rotate::normalize_rotation_degrees` treats them as the
/// identical geometric transform elsewhere. Do not "fix" this into
/// normalizing first.
pub fn same_transform(
    first: &IrregularTransformCandidate,
    second: &IrregularTransformCandidate,
) -> bool {
    first.index == second.index
        && first.rotation_deg == second.rotation_deg
        && first.mirrored == second.mirrored
        && first.reason == second.reason
}

/// TS: `geometryCacheIdentity.ts:108-116` (`collisionGeometryDigest`).
///
/// Folds `sourcePieceId`, `sourceBounds`, `placementReference`,
/// `convexHull.points`, `collisionPolygon.points` — **not** `sampledPoints`
/// (design doc §1.2; `sampledPoints` genuinely never enters this digest).
fn collision_geometry_digest(geometry: &CollisionGeometry) -> String {
    [
        format!("source={}", geometry.source_piece_id),
        format!("source-bounds={}", bounds_digest(&geometry.source_bounds)),
        format!(
            "placement-reference={}",
            point_digest(geometry.placement_reference)
        ),
        format!("hull={}", polygon_digest(&geometry.convex_hull.points)),
        format!(
            "collision={}",
            polygon_digest(&geometry.collision_polygon.points)
        ),
    ]
    .join(";")
}

/// TS: `geometryCacheIdentity.ts:118-120` (`polygonDigest`).
fn polygon_digest(points: &[crate::domain::IrregularPoint]) -> String {
    points
        .iter()
        .map(|point| point_digest(*point))
        .collect::<Vec<_>>()
        .join(";")
}

/// TS: `geometryCacheIdentity.ts:126-128` (`boundsDigest`).
fn bounds_digest(bounds: &crate::domain::IrregularBounds) -> String {
    [bounds.min_x, bounds.min_y, bounds.max_x, bounds.max_y]
        .into_iter()
        .map(fold_negative_zero_key)
        .collect::<Vec<_>>()
        .join(",")
}

/// TS: `geometryCacheIdentity.ts:130-137` (`transformDigest`). Textually
/// identical to `nfp_cache_key`'s own `transformDigest` copy (design doc
/// §1.6: three independently hand-written TS copies of the same function) —
/// this port keeps one shared body, invoked from both key builders, rather
/// than reproducing the TS triplication (same reasoning as
/// `geometry_settings_parts`'s doc comment).
fn transform_digest(transform: &IrregularTransformCandidate) -> String {
    format!(
        "index={},rotation={},mirrored={},reason={}",
        fold_negative_zero_key(transform.index),
        fold_negative_zero_key(transform.rotation_deg),
        u8::from(transform.mirrored),
        transform_reason_str(transform.reason)
    )
}

/// The exact TS string literal for one `IrregularTransformReason` variant
/// (`domain.ts:14-21` `Schema.Literals(['orthogonal', 'edge_alignment',
/// 'configured'])`), used by every `transformDigest` copy across this
/// cluster (`nfpCacheKey.ts:95`, `geometryCacheIdentity.ts:135`). Matches
/// `domain::transform::IrregularTransformReason`'s own
/// `#[serde(rename_all = "snake_case")]` mapping exactly — asserted by this
/// module's own test below so the two representations cannot silently
/// diverge.
pub(super) fn transform_reason_str(reason: IrregularTransformReason) -> &'static str {
    match reason {
        IrregularTransformReason::Orthogonal => "orthogonal",
        IrregularTransformReason::EdgeAlignment => "edge_alignment",
        IrregularTransformReason::Configured => "configured",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{IrregularBounds, IrregularPoint, IrregularPolygon, PieceId};

    fn sample_geometry() -> CollisionGeometry {
        let polygon = IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(4.0, 0.0),
            IrregularPoint::new(4.0, 3.0),
            IrregularPoint::new(0.0, 3.0),
        ]);
        CollisionGeometry {
            source_piece_id: PieceId::new("key-piece"),
            source_bounds: IrregularBounds::new(0.0, 0.0, 4.0, 3.0),
            sampled_points: vec![],
            convex_hull: polygon.clone(),
            collision_polygon: polygon,
            placement_reference: IrregularPoint::new(0.0, 0.0),
            diagnostics: vec![],
        }
    }

    #[test]
    fn transform_reason_str_matches_the_serde_snake_case_mapping() {
        for (reason, expected) in [
            (IrregularTransformReason::Orthogonal, "orthogonal"),
            (IrregularTransformReason::EdgeAlignment, "edge_alignment"),
            (IrregularTransformReason::Configured, "configured"),
        ] {
            assert_eq!(transform_reason_str(reason), expected);
            let serialized = serde_json::to_string(&reason).unwrap();
            assert_eq!(serialized, format!("\"{expected}\""));
        }
    }

    #[test]
    fn same_transform_requires_exact_unnormalized_rotation_equality() {
        let base = IrregularTransformCandidate {
            index: 0.0,
            rotation_deg: 0.0,
            mirrored: false,
            reason: IrregularTransformReason::Orthogonal,
        };
        let same = IrregularTransformCandidate { ..base };
        assert!(same_transform(&base, &same));

        let full_turn = IrregularTransformCandidate {
            rotation_deg: 360.0,
            ..base
        };
        // 0 and 360 are the same geometric rotation but NOT the same
        // sameTransform() identity -- the raw value is compared, unnormalized.
        assert!(!same_transform(&base, &full_turn));
    }

    #[test]
    fn make_transform_collision_geometry_cache_key_matches_the_golden_bytes() {
        let settings = IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "irregular-convex-v2-default".to_string(),
            geometry_backend_version: "0".to_string(),
        };
        let transform = IrregularTransformCandidate {
            index: 7.0,
            rotation_deg: 90.0,
            mirrored: true,
            reason: IrregularTransformReason::Configured,
        };
        let geometry = sample_geometry();
        let input = TransformCollisionGeometryKeyInput {
            geometry: &geometry,
            transform: &transform,
        };
        let key = make_transform_collision_geometry_cache_key(&input, &settings);
        assert_eq!(key.namespace, TRANSFORM_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(
            key.parts,
            vec![
                "source=key-piece;source-bounds=0,0,4,3;placement-reference=0,0;hull=0,0;4,0;4,3;0,3;collision=0,0;4,0;4,3;0,3".to_string(),
                "index=7,rotation=90,mirrored=1,reason=configured".to_string(),
                "flattening-sag=0.25".to_string(),
                "clearance-margin=0.25".to_string(),
                "backend=irregular-convex-v2-default".to_string(),
                "backend-version=0".to_string(),
                "offset-policy=clipper2-offset-v3-sharp-miter-scale-1000".to_string(),
                "placement-reference=local-lower-left".to_string(),
                "transform-operation=mirror-y-then-ccw-rotate".to_string(),
            ]
        );
    }

    #[test]
    fn make_inner_fit_bounds_cache_key_matches_the_golden_bytes() {
        let sheet = SheetSpec {
            width: 20.0,
            height: 15.0,
            label: "key sheet".to_string(),
        };
        let moving = TransformedCollisionGeometry {
            source_piece_id: PieceId::new("key-piece"),
            transform: IrregularTransformCandidate {
                index: 7.0,
                rotation_deg: 90.0,
                mirrored: true,
                reason: IrregularTransformReason::Configured,
            },
            polygon: IrregularPolygon::new(vec![
                IrregularPoint::new(0.0, 0.0),
                IrregularPoint::new(4.0, 0.0),
                IrregularPoint::new(4.0, 3.0),
                IrregularPoint::new(0.0, 3.0),
            ]),
            bounds: IrregularBounds::new(0.0, 0.0, 4.0, 3.0),
        };
        let input = InnerFitBoundsKeyInput {
            sheet: &sheet,
            moving: &moving,
        };
        let key = make_inner_fit_bounds_cache_key(&input);
        assert_eq!(key.namespace, IFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(
            key.parts,
            vec![
                "sheet=20,15,key sheet".to_string(),
                "moving-piece=key-piece".to_string(),
                "moving-transform=index=7,rotation=90,mirrored=1,reason=configured".to_string(),
                "moving-polygon=0,0;4,0;4,3;0,3".to_string(),
                "ifp-operation=rectangular-sheet-vertex-bounds".to_string(),
            ]
        );
    }
}
