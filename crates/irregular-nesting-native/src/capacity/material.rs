//! Prepared-piece identity resolution and exact bigint material-area
//! accounting for the intrinsic capacity tower.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicCapacityMaterial.ts`
//! (72 lines), ported here in full. Read together with
//! `docs/planning/rust-irregular-backend/characterization/capacity-core.md`
//! before touching this file -- in particular §4/§5/§7/§13 for this file's
//! exact bigint arithmetic and fail-fast, first-invalid-piece-in-prepared-order
//! semantics.
//!
//! # Reused (GREEN) primitives -- never duplicated here
//!
//! - `canonical_grid::to_grid_mm` -- the same millimeter-to-canonical-grid
//!   quantization TS imports from `clipper2OffsetPolicy.ts`.
//! - `clipper::core::{f64_to_bigint, bigint_to_number}` -- the same
//!   integer-valued-`f64`-to-`BigInt`/`BigInt`-to-`Number` round trips this
//!   file's TS counterpart performs implicitly via `BigInt(gridValue)` /
//!   `Number(doubledAreaGrid2)`.
//!
//! # Not the same function as `canonical_grid::canonical_grid_absolute_doubled_area`
//!
//! [`exact_doubled_polygon_area_grid2`] looks superficially like
//! `canonical_grid::canonical_grid_absolute_doubled_area` (both are exact
//! bigint shoelace-formula magnitudes), but the two differ in degenerate-input
//! semantics and are never the same function in TS either (`intrinsicCapacityMaterial.ts`
//! does not import `canonicalGridMath.ts`): this function treats fewer than 3
//! points, or an exactly-zero doubled magnitude, as **invalid** (`None`) --
//! "never a legitimate zero" per this file's own TS doc comment
//! (`intrinsicCapacityMaterial.ts:15`) -- whereas
//! `canonical_grid_absolute_doubled_area` treats both cases as a legitimate
//! `Some(0)` (used for genuinely empty hull-gap-style regions elsewhere). Do
//! not "simplify" this into a call to that function.

use std::collections::HashMap;

use num_bigint::BigInt;

use crate::canonical_grid::to_grid_mm;
use crate::clipper::core::{bigint_to_number, f64_to_bigint};
use crate::domain::{IrregularPoint, IrregularPreparedPiece, PieceId};

/// TS: `intrinsicCapacityMaterial.ts:6` `DOUBLED_GRID2_PER_MM2 = 2_000_000`.
const DOUBLED_GRID2_PER_MM2: f64 = 2_000_000.0;

/// TS: `intrinsicCapacityMaterial.ts:9-11` `intrinsicCapacityPreparedPieceId`.
/// Resolves the immutable prepared identity used by capacity accounting:
/// `piece.pieceId ?? piece.source.id`. Per `capacity-core.md` §3, this
/// function is insensitive to TS's own-property-absent-vs-`undefined`
/// distinction on `pieceId` -- `Option::None` covers both.
pub fn intrinsic_capacity_prepared_piece_id(piece: &IrregularPreparedPiece) -> PieceId {
    piece
        .piece_id
        .clone()
        .unwrap_or_else(|| piece.source.id.clone())
}

/// TS: `intrinsicCapacityMaterial.ts:17-37` `exactDoubledPolygonAreaGrid2`.
/// Exact doubled polygon area on the canonical integer grid. `None` means the
/// ring cannot be represented exactly (fewer than 3 points, a coordinate that
/// does not fit the canonical grid, or an exactly-zero doubled area) --
/// never a legitimate zero-by-default.
///
/// Because this is exact `BigInt` arithmetic, the shoelace-term summation
/// order is mathematically irrelevant (associative, commutative, lossless) --
/// see `capacity-core.md` §7/§13 for why this is a genuine (rare) case where
/// reduction order does not matter, unlike an equivalent floating-point
/// shoelace sum would.
pub fn exact_doubled_polygon_area_grid2(points: &[IrregularPoint]) -> Option<BigInt> {
    if points.len() < 3 {
        return None;
    }
    let mut grid_points: Vec<(BigInt, BigInt)> = Vec::with_capacity(points.len());
    for point in points {
        let grid_x = to_grid_mm(point.x)?;
        let grid_y = to_grid_mm(point.y)?;
        grid_points.push((f64_to_bigint(grid_x), f64_to_bigint(grid_y)));
    }

    let mut doubled = BigInt::from(0);
    for index in 0..grid_points.len() {
        let (first_x, first_y) = &grid_points[index];
        let (second_x, second_y) = &grid_points[(index + 1) % grid_points.len()];
        doubled += first_x * second_y - second_x * first_y;
    }
    let magnitude = if doubled < BigInt::from(0) {
        -doubled
    } else {
        doubled
    };
    if magnitude > BigInt::from(0) {
        Some(magnitude)
    } else {
        None
    }
}

/// TS: `intrinsicCapacityMaterial.ts:44-48` `preparedPieceDoubledMaterialAreaGrid2`.
/// Exact doubled unpadded material area of one prepared piece. The unpadded
/// convex hull is the engine-wide material authority for convex irregular
/// pieces; padding never counts as placed material.
pub fn prepared_piece_doubled_material_area_grid2(
    piece: &IrregularPreparedPiece,
) -> Option<BigInt> {
    exact_doubled_polygon_area_grid2(&piece.collision_geometry.convex_hull.points)
}

/// TS: `intrinsicCapacityMaterial.ts:51-66` `IntrinsicCapacityMaterialAreas`
/// (the discriminated-union result type) collapsed into this enum -- there is
/// no partial/complete map on failure, the whole computation is fail-fast.
#[derive(Clone, Debug, PartialEq)]
pub enum IntrinsicCapacityMaterialAreas {
    Complete {
        areas_by_piece_id: HashMap<PieceId, BigInt>,
    },
    Invalid {
        piece_id: PieceId,
    },
}

/// TS: `intrinsicCapacityMaterial.ts:51-66` `intrinsicCapacityMaterialAreas`.
/// Builds the exact per-piece material map or reports the first invalid (or
/// first duplicate-id) piece **in prepared order** -- fail-fast, not "any"
/// invalid piece (`capacity-core.md` §5/§13's parallelism note: a Rayon port
/// of this loop must still resolve the reported id by stable prepared index,
/// never by whichever thread detects a failure first).
pub fn intrinsic_capacity_material_areas(
    pieces: &[IrregularPreparedPiece],
) -> IntrinsicCapacityMaterialAreas {
    let mut areas_by_piece_id: HashMap<PieceId, BigInt> = HashMap::new();
    for piece in pieces {
        let piece_id = intrinsic_capacity_prepared_piece_id(piece);
        let doubled_area_grid2 = prepared_piece_doubled_material_area_grid2(piece);
        match doubled_area_grid2 {
            None => return IntrinsicCapacityMaterialAreas::Invalid { piece_id },
            Some(_) if areas_by_piece_id.contains_key(&piece_id) => {
                return IntrinsicCapacityMaterialAreas::Invalid { piece_id }
            }
            Some(area) => {
                areas_by_piece_id.insert(piece_id, area);
            }
        }
    }
    IntrinsicCapacityMaterialAreas::Complete { areas_by_piece_id }
}

/// TS: `intrinsicCapacityMaterial.ts:69-71` `doubledGrid2ToMm2`. Converts one
/// exact doubled grid-squared area to display square millimeters. This is
/// the one lossy conversion in this file (`Number(bigint)` rounds to the
/// nearest representable `f64` once the bigint exceeds `2^53`, realistically
/// unreachable for physical sheet/piece areas but not re-guarded here,
/// matching the TS source exactly) -- display/diagnostic-only, never fed
/// back into any exact comparator.
pub fn doubled_grid2_to_mm2(doubled_area_grid2: &BigInt) -> f64 {
    bigint_to_number(doubled_area_grid2) / DOUBLED_GRID2_PER_MM2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        CollisionGeometry, IrregularBounds, IrregularPolygon, IrregularPreparedPiece, PieceId,
    };
    use crate::domain::{
        DxfGeometryEntityType, DxfGeometrySummary, ImportedPiece, Rect, SourceFileId,
    };

    fn square(side: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(side, 0.0),
            IrregularPoint::new(side, side),
            IrregularPoint::new(0.0, side),
        ])
    }

    fn imported(id: &str) -> ImportedPiece {
        ImportedPiece {
            id: PieceId::new(id),
            source_file_id: SourceFileId::new(format!("source-{id}")),
            source_layer: None,
            label: id.to_string(),
            real_bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            geometry: DxfGeometrySummary {
                entity_type: DxfGeometryEntityType::PresetShape,
                closed: true,
                segments: vec![],
            },
            warnings: vec![],
        }
    }

    fn prepared(id: &str, side: f64) -> IrregularPreparedPiece {
        let shape = square(side);
        IrregularPreparedPiece {
            piece_id: Some(PieceId::new(id)),
            interchangeability_key: None,
            source: imported(id),
            allow_mirror: false,
            collision_geometry: CollisionGeometry {
                source_piece_id: PieceId::new(id),
                source_bounds: IrregularBounds::new(0.0, 0.0, side, side),
                sampled_points: shape.points.clone(),
                convex_hull: shape.clone(),
                collision_polygon: shape,
                placement_reference: IrregularPoint::new(0.0, 0.0),
                diagnostics: vec![],
            },
            transforms: vec![],
            priority_order_key: None,
        }
    }

    #[test]
    fn prepared_piece_id_falls_back_to_source_id() {
        let mut piece = prepared("piece-1", 10.0);
        piece.piece_id = None;
        assert_eq!(
            intrinsic_capacity_prepared_piece_id(&piece),
            PieceId::new("piece-1")
        );
    }

    #[test]
    fn exact_doubled_polygon_area_grid2_computes_a_60mm_square_exactly() {
        let area = exact_doubled_polygon_area_grid2(&square(60.0).points).expect("valid area");
        // Doubled area on the 0.001mm grid: 2 * 60_000 * 60_000.
        assert_eq!(
            area,
            BigInt::from(2) * BigInt::from(60_000) * BigInt::from(60_000)
        );
    }

    #[test]
    fn exact_doubled_polygon_area_grid2_rejects_degenerate_rings() {
        assert_eq!(
            exact_doubled_polygon_area_grid2(&[
                IrregularPoint::new(0.0, 0.0),
                IrregularPoint::new(1.0, 1.0)
            ]),
            None
        );
        // Collinear points: zero area is treated as invalid, never a
        // legitimate zero.
        assert_eq!(
            exact_doubled_polygon_area_grid2(&[
                IrregularPoint::new(0.0, 0.0),
                IrregularPoint::new(1.0, 0.0),
                IrregularPoint::new(2.0, 0.0)
            ]),
            None
        );
    }

    #[test]
    fn material_areas_reports_first_invalid_piece_in_prepared_order() {
        let good = prepared("good", 10.0);
        let mut bad = prepared("bad", 10.0);
        bad.collision_geometry.convex_hull = IrregularPolygon::new(vec![]);
        let pieces = vec![good, bad];
        let result = intrinsic_capacity_material_areas(&pieces);
        assert_eq!(
            result,
            IntrinsicCapacityMaterialAreas::Invalid {
                piece_id: PieceId::new("bad")
            }
        );
    }

    #[test]
    fn material_areas_reports_duplicate_ids_as_invalid() {
        let pieces = vec![prepared("dup", 10.0), prepared("dup", 20.0)];
        let result = intrinsic_capacity_material_areas(&pieces);
        assert_eq!(
            result,
            IntrinsicCapacityMaterialAreas::Invalid {
                piece_id: PieceId::new("dup")
            }
        );
    }

    #[test]
    fn material_areas_complete_map_uses_convex_hull_not_collision_polygon() {
        let mut piece = prepared("piece", 10.0);
        // Collision polygon (padded) differs from the convex hull (material
        // authority) -- only the hull area must be reported.
        piece.collision_geometry.collision_polygon = square(20.0);
        let pieces = vec![piece];
        let result = intrinsic_capacity_material_areas(&pieces);
        match result {
            IntrinsicCapacityMaterialAreas::Complete { areas_by_piece_id } => {
                let area = areas_by_piece_id.get(&PieceId::new("piece")).unwrap();
                assert_eq!(
                    *area,
                    BigInt::from(2) * BigInt::from(10_000) * BigInt::from(10_000)
                );
            }
            other => panic!("expected complete result, got {other:?}"),
        }
    }

    #[test]
    fn doubled_grid2_to_mm2_converts_exactly_for_small_areas() {
        let doubled = BigInt::from(2) * BigInt::from(60_000) * BigInt::from(60_000);
        assert_eq!(doubled_grid2_to_mm2(&doubled), 3_600.0);
    }
}
