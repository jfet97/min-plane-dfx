//! Exact translated-polygon legality check (sheet-bounds + positive-area
//! overlap) for one candidate placement against a set of already-placed
//! pieces.
//!
//! TS source: `src/workers/irregular/placementValidation.ts` (430 lines).
//! Read in full together with
//! `docs/planning/rust-irregular-backend/characterization/validation-spatial.md`
//! before writing this module -- in particular §6's 7-stage
//! `polygonsHavePositiveAreaOverlap` short-circuit sequence and §9's exact
//! access-sequence requirements, both of which this module preserves
//! stage-for-stage / step-for-step.
//!
//! # `Arc<IrregularPlacedPiece>` threading
//!
//! Per `validation-spatial.md` §12 hazard 2 (documented at length in
//! `spatial_index`'s module doc): `PlacedCollisionSpatialIndex::matches`
//! needs JS reference-identity semantics, ported here as `Arc::ptr_eq`. So
//! that `input.placed` and the values passed to `spatial_index.matches()`
//! are provably the same references (mirroring the TS invariant "`input.placed`
//! and the index are both loop-invariant... this is a caller invariant"),
//! this module's [`AssessPlacementInput::placed`] is `&[Arc<IrregularPlacedPiece>]`
//! throughout, not a plain owned slice -- callers are expected to construct
//! each placed piece once behind an `Arc` and thread the same `Arc` into
//! both the index and every `assess_placement` call, exactly where TS
//! preserves the same object reference today.
//!
//! # `enforce_sheet_bounds` stays a separate parameter
//!
//! Per stage0-rulings.md's resolution of `validation-spatial.md` §3's open
//! item: `sheet: Option<&SheetSpec>` plus a separate `enforce_sheet_bounds:
//! bool` parameter is the ruled-equivalent translation of TS's
//! `ValidatePlacementInput | Omit<ValidatePlacementInput, 'sheet'>` union
//! plus its own boolean parameter -- the two must never be collapsed into
//! one flag.

use std::sync::Arc;

use crate::domain::{
    IrregularBounds, IrregularPlacedPiece, IrregularPoint, IrregularPolygon, SheetSpec,
    TransformedCollisionGeometry,
};
use crate::geometry::convex::{
    are_disjoint, translate_polygon_with_bounds, validate_strict_boundary, ConvexPolygonWinding,
    StrictConvexBoundaryValidation,
};
use crate::geometry::predicates;
use crate::js_number::js_math;
use crate::validation::spatial_index::{PlacedCollisionSpatialIndex, PlacedCollisionValidation};

/// TS source: `services.ts:42-45` (`IrregularGeometryInputError`, a
/// `Data.TaggedError` with fields `operation: string, message: string`). The
/// Effect `_tag` discriminant has no Rust equivalent needed: this crate's
/// error carriers are not routed back through Effect.
///
/// This is an intentional, independent copy of the structurally-identical
/// type already ported (not exported outside its own module) at
/// `transforms::generator::IrregularGeometryInputError` -- see that module's
/// own doc comment: "[`convexPolygonValidation.ts`'s port there] is
/// intentionally **not** `pub`... Full ownership of `ConvexPolygonValidation`
/// belongs to the `validation-spatial` characterization cluster... this
/// module's copy is intentionally not pub outside `crate::transforms` so it
/// cannot become a second competing public implementation. ... Whoever ports
/// the `validation-spatial` cluster should consolidate both copies." This
/// module *is* that promised consolidation point going forward for any new
/// caller; `transforms::generator`'s private copy is left untouched here per
/// this task's file-ownership rule (that file is out of scope for this
/// task).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IrregularGeometryInputError {
    pub operation: String,
    pub message: String,
}

/// TS source: `placementValidation.ts:70-73` (`PlacementAssessment`).
#[derive(Clone, Debug, PartialEq)]
pub struct PlacementAssessment {
    pub legal: bool,
    pub message: String,
}

/// TS source: `placementValidation.ts:70-73`'s return union
/// (`PlacementAssessment | { readonly failure: IrregularGeometryInputError }`).
#[derive(Clone, Debug, PartialEq)]
pub enum AssessPlacementOutcome {
    Assessment(PlacementAssessment),
    Failure(IrregularGeometryInputError),
}

/// TS source: `services.ts:206-213` (`ValidatePlacementInput`), threaded
/// through `assessPlacement`'s `input: ValidatePlacementInput |
/// Omit<ValidatePlacementInput, 'sheet'>` parameter.
///
/// `candidate` is modeled as a bare [`IrregularPoint`] rather than the full
/// `IrregularPlacementCandidate` domain type: per `validation-spatial.md`
/// §3, `assessPlacement` reads only `candidate.point.x`/`.y` -- in
/// production `candidate` is actually a `CanonicalCandidatePoint` carrying
/// extra fields this function never reads, which is safe under TS structural
/// typing and, per that same section, "a Rust port using an exact `struct
/// Point { x: f64, y: f64 }` parameter type... is equally safe as long as
/// the caller supplies the same `x`/`y`."
pub struct AssessPlacementInput<'a> {
    pub sheet: Option<&'a SheetSpec>,
    pub placed: &'a [Arc<IrregularPlacedPiece>],
    pub placed_collision_index: Option<&'a PlacedCollisionSpatialIndex>,
    pub moving: &'a TransformedCollisionGeometry,
    pub candidate_point: IrregularPoint,
}

struct ValidatedPolygonWithBounds {
    polygon: IrregularPolygon,
    bounds: IrregularBounds,
    winding: ConvexPolygonWinding,
}

/// TS source: `placementValidation.ts:70-144` (`assessPlacement`).
///
/// Pure exact placement assessment; never suspends, matching the TS
/// docstring's stated rationale for keeping this a plain synchronous
/// function rather than an `Effect`-returning one (`placementValidation.ts:61-69`).
///
/// Preserves the exact access sequence from `validation-spatial.md` §9:
/// (1) translate+validate the moving polygon first, short-circuiting before
/// the spatial index is even consulted on failure; (2) test
/// `spatialIndex.matches(input.placed)`, using the indexed `query()` branch
/// only when it holds, else the brute-force per-`placed`-piece branch in
/// caller-array order; (3) only once the placed-polygon list is fully
/// assembled, run the sheet-bounds check (if `enforce_sheet_bounds` and
/// `sheet` is present), then the 7-stage positive-area-overlap sequence
/// (§6) per placed polygon in that assembled order, returning on the first
/// positive-area overlap found.
pub fn assess_placement(
    input: &AssessPlacementInput<'_>,
    enforce_sheet_bounds: bool,
) -> AssessPlacementOutcome {
    // TS: `placementValidation.ts:74-81`.
    let moving_polygon = match translate_and_validate_polygon(
        &input.moving.polygon,
        input.candidate_point,
        "moving",
    ) {
        Err(message) => return AssessPlacementOutcome::Failure(invalid_geometry_failure(message)),
        Ok(polygon) => polygon,
    };

    let mut placed_polygons: Vec<ValidatedPolygonWithBounds> = Vec::new();

    // TS: `placementValidation.ts:85-89`.
    let indexed_entries = input
        .placed_collision_index
        .filter(|spatial_index| spatial_index.matches(input.placed))
        .map(|spatial_index| spatial_index.query(Some(&moving_polygon.bounds)));

    match indexed_entries {
        // TS: `placementValidation.ts:90-103`.
        Some(entries) => {
            for entry in entries {
                match entry.validation {
                    PlacedCollisionValidation::Invalid { message } => {
                        return AssessPlacementOutcome::Failure(invalid_geometry_failure(message));
                    }
                    PlacedCollisionValidation::Valid(valid) => {
                        placed_polygons.push(ValidatedPolygonWithBounds {
                            polygon: valid.polygon_with_bounds.polygon,
                            bounds: valid.polygon_with_bounds.bounds,
                            winding: valid.winding,
                        });
                    }
                }
            }
        }
        // TS: `placementValidation.ts:104-119`.
        None => {
            for placed in input.placed {
                let translation = IrregularPoint::new(
                    placed.placement.transform.translate_x,
                    placed.placement.transform.translate_y,
                );
                match translate_and_validate_polygon(
                    &placed.collision_geometry.polygon,
                    translation,
                    "placed",
                ) {
                    Err(message) => {
                        return AssessPlacementOutcome::Failure(invalid_geometry_failure(message));
                    }
                    Ok(polygon) => placed_polygons.push(polygon),
                }
            }
        }
    }

    // TS: `placementValidation.ts:122-128`.
    if enforce_sheet_bounds {
        if let Some(sheet) = input.sheet {
            if !is_inside_sheet(&moving_polygon.polygon.points, sheet.width, sheet.height) {
                return AssessPlacementOutcome::Assessment(PlacementAssessment {
                    legal: false,
                    message: "moving polygon must remain inside the sheet.".to_string(),
                });
            }
        }
    }

    // TS: `placementValidation.ts:130-141`.
    for placed_polygon in &placed_polygons {
        match polygons_have_positive_area_overlap(&moving_polygon, placed_polygon) {
            Err(message) => {
                return AssessPlacementOutcome::Failure(invalid_geometry_failure(message))
            }
            Ok(true) => {
                return AssessPlacementOutcome::Assessment(PlacementAssessment {
                    legal: false,
                    message:
                        "moving polygon has positive-area overlap with placed collision geometry."
                            .to_string(),
                });
            }
            Ok(false) => {}
        }
    }

    // TS: `placementValidation.ts:143`.
    AssessPlacementOutcome::Assessment(PlacementAssessment {
        legal: true,
        message: String::new(),
    })
}

/// TS source: `placementValidation.ts:35-37` (`check`, `enforceSheetBounds=true`).
/// The TS `Effect.Effect<boolean, IrregularGeometryInputError>` wrapper is
/// represented as a plain `Result`, since this crate's non-N-API core has no
/// `Effect` runtime (`assessPlacement`'s own docstring: "wrapping it in
/// `Effect` cost one effect construction and one fiber step per point for no
/// benefit").
pub fn check(input: &AssessPlacementInput<'_>) -> Result<bool, IrregularGeometryInputError> {
    match assess_placement(input, true) {
        AssessPlacementOutcome::Assessment(assessment) => Ok(assessment.legal),
        AssessPlacementOutcome::Failure(err) => Err(err),
    }
}

/// TS source: `placementValidation.ts:40-44` (`checkSheetless`,
/// `enforceSheetBounds=false`). Callers should pass `sheet: None` on
/// `input`, mirroring the TS `Omit<ValidatePlacementInput, 'sheet'>` input
/// shape, though `enforce_sheet_bounds=false` alone already makes `sheet`'s
/// value irrelevant to the result (see [`assess_placement`]'s sheet-bounds
/// step, which short-circuits on `enforce_sheet_bounds` before ever reading
/// `sheet`).
pub fn check_sheetless(
    input: &AssessPlacementInput<'_>,
) -> Result<bool, IrregularGeometryInputError> {
    match assess_placement(input, false) {
        AssessPlacementOutcome::Assessment(assessment) => Ok(assessment.legal),
        AssessPlacementOutcome::Failure(err) => Err(err),
    }
}

/// TS source: `placementValidation.ts:51-59` (`validate`). Preserves the
/// strict assertion boundary used by the geometry-kernel service: an illegal
/// candidate becomes an `Err` here (unlike [`check`], which reports it as
/// `Ok(false)`).
pub fn validate(input: &AssessPlacementInput<'_>) -> Result<(), IrregularGeometryInputError> {
    match assess_placement(input, true) {
        AssessPlacementOutcome::Assessment(assessment) => {
            if assessment.legal {
                Ok(())
            } else {
                // TS: `placementValidation.ts:56` / `:425-430`
                // (`failInvalidGeometry`), whose sole call site hardcodes
                // `operation: 'validatePlacement'`.
                Err(IrregularGeometryInputError {
                    operation: "validatePlacement".to_string(),
                    message: assessment.message,
                })
            }
        }
        AssessPlacementOutcome::Failure(err) => Err(err),
    }
}

/// TS source: `placementValidation.ts:157-162` (`invalidGeometryFailure`).
/// `operation` is always the fixed literal `'validatePlacement'`, never
/// derived from which internal check actually failed (`validation-spatial.md`
/// §11).
fn invalid_geometry_failure(message: String) -> IrregularGeometryInputError {
    IrregularGeometryInputError {
        operation: "validatePlacement".to_string(),
        message,
    }
}

/// TS source: `placementValidation.ts:164-172` (`isInsideSheet`).
fn is_inside_sheet(points: &[IrregularPoint], sheet_width: f64, sheet_height: f64) -> bool {
    points.iter().all(|point| {
        point.x >= 0.0 && point.x <= sheet_width && point.y >= 0.0 && point.y <= sheet_height
    })
}

/// TS source: `placementValidation.ts:191-234` (`polygonsHavePositiveAreaOverlap`).
///
/// The 7-stage ordered short-circuit sequence from `validation-spatial.md`
/// §6, preserved stage-for-stage: (1) `areDisjoint` broad-phase bounds check;
/// (2)/(3) any strict-interior vertex of either polygon in the other; (4) any
/// proper boundary crossing; (5) either polygon's equal-weight-vertex-average
/// interior point strictly inside the other; (6) any positive-length
/// collinear boundary overlap on the same winding side; (7) otherwise, `true`
/// only if every point of `first` lies on `second`'s boundary and vice versa
/// (coincident rings).
fn polygons_have_positive_area_overlap(
    first: &ValidatedPolygonWithBounds,
    second: &ValidatedPolygonWithBounds,
) -> Result<bool, String> {
    // (1)
    if are_disjoint(&first.bounds, &second.bounds) {
        return Ok(false);
    }

    // (2)
    for point in &first.polygon.points {
        if is_strictly_inside(*point, &second.polygon, second.winding) {
            return Ok(true);
        }
    }
    // (3)
    for point in &second.polygon.points {
        if is_strictly_inside(*point, &first.polygon, first.winding) {
            return Ok(true);
        }
    }

    // (4)
    if boundaries_have_proper_crossing(&first.polygon, &second.polygon)? {
        return Ok(true);
    }

    // (5)
    let first_interior_point = strict_convex_interior_point(&first.polygon)?;
    let second_interior_point = strict_convex_interior_point(&second.polygon)?;
    if is_strictly_inside(first_interior_point, &second.polygon, second.winding)
        || is_strictly_inside(second_interior_point, &first.polygon, first.winding)
    {
        return Ok(true);
    }

    // (6)
    if boundaries_have_positive_collinear_overlap(&first.polygon, &second.polygon, first.winding)? {
        return Ok(true);
    }

    // (7) -- comment at `placementValidation.ts:228-230`: "with strict convex
    // rings, positive overlap without a strict vertex or a proper crossing
    // can only be coincident boundaries." Shared boundary contact alone
    // remains legal because it does not satisfy this condition.
    let first_on_second = first
        .polygon
        .points
        .iter()
        .all(|point| is_on_boundary(*point, &second.polygon));
    let second_on_first = second
        .polygon
        .points
        .iter()
        .all(|point| is_on_boundary(*point, &first.polygon));
    Ok(first_on_second && second_on_first)
}

/// TS source: `placementValidation.ts:236-252` (`translateAndValidatePolygon`).
fn translate_and_validate_polygon(
    polygon: &IrregularPolygon,
    translation: IrregularPoint,
    label: &str,
) -> Result<ValidatedPolygonWithBounds, String> {
    let translated = translate_polygon_with_bounds(polygon, translation)
        .ok_or_else(|| format!("{label} translation must produce finite polygon coordinates."))?;

    match validate_strict_boundary(&translated.polygon.points) {
        StrictConvexBoundaryValidation::Invalid { message } => Err(message),
        StrictConvexBoundaryValidation::Valid { winding } => Ok(ValidatedPolygonWithBounds {
            polygon: translated.polygon,
            bounds: translated.bounds,
            winding,
        }),
    }
}

/// TS source: `placementValidation.ts:254-283` (`strictConvexInteriorPoint`).
///
/// Computes the equal-weight vertex average, a strictly interior convex
/// combination for a strict convex ring. Per `validation-spatial.md` §11,
/// this function's three finiteness checks are defensive but not fully
/// unreachable in principle (unlike some other branches in this cluster):
/// `validateStrictBoundary` only requires `Number.isFinite`, not a bounded
/// magnitude envelope, so extreme-magnitude valid polygons could in
/// principle still overflow this weighted sum. Ported verbatim, including
/// the redundant-looking per-component and post-accumulation checks.
fn strict_convex_interior_point(polygon: &IrregularPolygon) -> Result<IrregularPoint, String> {
    let weight = 1.0 / polygon.points.len() as f64;
    if !weight.is_finite() {
        return Err(
            "polygon interior-point arithmetic must produce finite coordinates.".to_string(),
        );
    }

    let mut x = 0.0_f64;
    let mut y = 0.0_f64;
    for point in &polygon.points {
        let weighted_x = point.x * weight;
        let weighted_y = point.y * weight;
        if !weighted_x.is_finite() || !weighted_y.is_finite() {
            return Err(
                "polygon interior-point arithmetic must produce finite coordinates.".to_string(),
            );
        }

        x += weighted_x;
        y += weighted_y;
        if !x.is_finite() || !y.is_finite() {
            return Err(
                "polygon interior-point arithmetic must produce finite coordinates.".to_string(),
            );
        }
    }

    Ok(IrregularPoint::new(x, y))
}

/// TS source: `placementValidation.ts:285-318`
/// (`boundariesHavePositiveCollinearOverlap`). Per `validation-spatial.md`
/// §11, the `second_interior_point` lookup failure branch is provably
/// unreachable given upstream invariants (a strictly-convex `second` cannot
/// have every vertex collinear with an external line for `>= 3` vertices),
/// but is kept exactly as written -- "document what IS," not what is
/// provably reachable.
fn boundaries_have_positive_collinear_overlap(
    first: &IrregularPolygon,
    second: &IrregularPolygon,
    first_winding: ConvexPolygonWinding,
) -> Result<bool, String> {
    for first_edge in polygon_edges(first) {
        for second_edge in polygon_edges(second) {
            if orientation_of(first_edge.start, first_edge.end, second_edge.start) != 0
                || orientation_of(first_edge.start, first_edge.end, second_edge.end) != 0
            {
                continue;
            }

            if !segments_have_positive_length_overlap(&first_edge, &second_edge) {
                continue;
            }

            let second_interior_point = second
                .points
                .iter()
                .find(|point| orientation_of(first_edge.start, first_edge.end, **point) != 0);
            let second_interior_point =
                match second_interior_point {
                    None => return Err(
                        "polygon interior side arithmetic must produce a finite classification."
                            .to_string(),
                    ),
                    Some(point) => *point,
                };

            let second_interior_side =
                orientation_of(first_edge.start, first_edge.end, second_interior_point);
            if second_interior_side == first_winding {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

/// TS source: `placementValidation.ts:320-330`
/// (`segmentsHavePositiveLengthOverlap`).
fn segments_have_positive_length_overlap(first: &PolygonEdge, second: &PolygonEdge) -> bool {
    let use_x = (first.end.x - first.start.x).abs() >= (first.end.y - first.start.y).abs();
    let (first_start, first_end) = if use_x {
        (first.start.x, first.end.x)
    } else {
        (first.start.y, first.end.y)
    };
    let (second_start, second_end) = if use_x {
        (second.start.x, second.end.x)
    } else {
        (second.start.y, second.end.y)
    };
    // TS: `Math.max`/`Math.min` -- routed through `js_math` per this crate's
    // uniform-signed-zero convention (see `geometry::convex`'s doc comment).
    js_math::max(
        js_math::min(first_start, first_end),
        js_math::min(second_start, second_end),
    ) < js_math::min(
        js_math::max(first_start, first_end),
        js_math::max(second_start, second_end),
    )
}

/// TS source: `placementValidation.ts:332-375` (`boundariesHaveProperCrossing`).
///
/// Per `validation-spatial.md` §11: the TS declared return type includes a
/// `GeometryFailure` arm, but this function's body never actually
/// constructs one -- ported here as `Result<bool, String>` (mechanically
/// mirroring the TS declared shape, including its `'message' in crossing'`
/// check-and-propagate call-site pattern) even though the `Err` arm is
/// genuinely unreachable, per the migration prompt's instruction to
/// reproduce the source's oddities rather than simplify around a proof of
/// unreachability.
fn boundaries_have_proper_crossing(
    first: &IrregularPolygon,
    second: &IrregularPolygon,
) -> Result<bool, String> {
    for first_edge in polygon_edges(first) {
        for second_edge in polygon_edges(second) {
            let first_start_turn =
                orientation_of(first_edge.start, first_edge.end, second_edge.start);
            let first_end_turn = orientation_of(first_edge.start, first_edge.end, second_edge.end);
            let second_start_turn =
                orientation_of(second_edge.start, second_edge.end, first_edge.start);
            let second_end_turn =
                orientation_of(second_edge.start, second_edge.end, first_edge.end);

            if first_start_turn == 0
                || first_end_turn == 0
                || second_start_turn == 0
                || second_end_turn == 0
            {
                continue;
            }

            if first_start_turn != first_end_turn && second_start_turn != second_end_turn {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

/// One directed edge of an ordered, implicitly-closed polygon ring.
///
/// TS source: `placementValidation.ts:377-380` (`PolygonEdge`).
#[derive(Clone, Copy)]
struct PolygonEdge {
    start: IrregularPoint,
    end: IrregularPoint,
}

/// TS source: `placementValidation.ts:382-390` (`polygonEdges`).
fn polygon_edges(polygon: &IrregularPolygon) -> Vec<PolygonEdge> {
    let len = polygon.points.len();
    let mut edges = Vec::with_capacity(len);
    for index in 0..len {
        let start = polygon.points[index];
        let end = polygon.points[(index + 1) % len];
        edges.push(PolygonEdge { start, end });
    }
    edges
}

/// TS source: `placementValidation.ts:392-402` (`isStrictlyInside`).
fn is_strictly_inside(
    point: IrregularPoint,
    polygon: &IrregularPolygon,
    winding: ConvexPolygonWinding,
) -> bool {
    for edge in polygon_edges(polygon) {
        let turn = orientation_of(edge.start, edge.end, point);
        if turn == 0 || turn != winding {
            return false;
        }
    }
    true
}

/// TS source: `placementValidation.ts:404-414` (`isOnBoundary`).
fn is_on_boundary(point: IrregularPoint, polygon: &IrregularPolygon) -> bool {
    for edge in polygon_edges(polygon) {
        if orientation_of(edge.start, edge.end, point) == 0 && point_is_on_segment(point, &edge) {
            return true;
        }
    }
    false
}

/// TS source: `placementValidation.ts:416-423` (`pointIsOnSegment`).
///
/// Byte-identical duplicate logic to `geometry::convex`'s private
/// `point_is_on_segment` -- matching the TS source's own duplication
/// (`validation-spatial.md` §12 hazard 7: "`pointIsOnSegment` exists twice,
/// verbatim, in `placementValidation.ts:416-423` and
/// `convexPolygonValidation.ts:307-314`... None of this is a bug"). Kept as
/// an independent local copy rather than importing `geometry::convex`'s
/// private version (which is intentionally not `pub`, mirroring
/// `transforms::boundary_check`'s established precedent of not creating a
/// second competing public implementation out of a file this task does not
/// own).
fn point_is_on_segment(point: IrregularPoint, edge: &PolygonEdge) -> bool {
    point.x >= js_math::min(edge.start.x, edge.end.x)
        && point.x <= js_math::max(edge.start.x, edge.end.x)
        && point.y >= js_math::min(edge.start.y, edge.end.y)
        && point.y <= js_math::max(edge.start.y, edge.end.y)
}

/// Shared helper applying `geometry::predicates::orientation` to three
/// [`IrregularPoint`]s.
fn orientation_of(origin: IrregularPoint, first: IrregularPoint, second: IrregularPoint) -> i32 {
    predicates::orientation(origin.x, origin.y, first.x, first.y, second.x, second.y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        IrregularPlacement, IrregularTransform, IrregularTransformCandidate,
        IrregularTransformReason, PieceId,
    };
    use crate::validation::spatial_index::make_placed_collision_spatial_index;

    fn p(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    fn square_ring(min: f64, max: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![p(min, min), p(max, min), p(max, max), p(min, max)])
    }

    fn moving_geometry(polygon: IrregularPolygon) -> TransformedCollisionGeometry {
        TransformedCollisionGeometry {
            source_piece_id: PieceId::new("moving"),
            transform: IrregularTransformCandidate {
                index: 0.0,
                rotation_deg: 0.0,
                mirrored: false,
                reason: IrregularTransformReason::Orthogonal,
            },
            polygon,
            bounds: IrregularBounds::new(0.0, 0.0, 1.0, 1.0),
        }
    }

    fn placed_piece(
        polygon: IrregularPolygon,
        translate_x: f64,
        translate_y: f64,
    ) -> Arc<IrregularPlacedPiece> {
        Arc::new(IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: None,
                source_piece_id: PieceId::new("placed"),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x,
                    translate_y,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new("placed"),
                transform: IrregularTransformCandidate {
                    index: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                    reason: IrregularTransformReason::Orthogonal,
                },
                polygon,
                bounds: IrregularBounds::new(0.0, 0.0, 1.0, 1.0),
            },
        })
    }

    fn sheet(width: f64, height: f64) -> SheetSpec {
        SheetSpec {
            width,
            height,
            label: "test sheet".to_string(),
        }
    }

    #[test]
    fn legal_placement_with_no_placed_pieces() {
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let sheet_spec = sheet(100.0, 100.0);
        let input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        match assess_placement(&input, true) {
            AssessPlacementOutcome::Assessment(assessment) => {
                assert!(assessment.legal);
                assert_eq!(assessment.message, "");
            }
            AssessPlacementOutcome::Failure(err) => panic!("unexpected failure: {err:?}"),
        }
    }

    #[test]
    fn exact_edge_touching_is_legal() {
        // Moving square [0,2]x[0,2] placed at origin; placed square [2,4]x[0,2]
        // touches at x=2 exactly -- boundaries are closed, so this is legal.
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let placed = placed_piece(square_ring(0.0, 2.0), 2.0, 0.0);
        let sheet_spec = sheet(100.0, 100.0);
        let input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[placed],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        match assess_placement(&input, true) {
            AssessPlacementOutcome::Assessment(assessment) => assert!(assessment.legal),
            AssessPlacementOutcome::Failure(err) => panic!("unexpected failure: {err:?}"),
        }
    }

    #[test]
    fn positive_area_overlap_is_illegal() {
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let placed = placed_piece(square_ring(0.0, 2.0), 1.0, 0.0); // overlaps by half
        let sheet_spec = sheet(100.0, 100.0);
        let input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[placed],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        match assess_placement(&input, true) {
            AssessPlacementOutcome::Assessment(assessment) => {
                assert!(!assessment.legal);
                assert_eq!(
                    assessment.message,
                    "moving polygon has positive-area overlap with placed collision geometry."
                );
            }
            AssessPlacementOutcome::Failure(err) => panic!("unexpected failure: {err:?}"),
        }
    }

    #[test]
    fn outside_sheet_bounds_is_illegal_only_when_enforced() {
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let sheet_spec = sheet(1.0, 1.0); // moving polygon extends past this sheet
        let input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        match assess_placement(&input, true) {
            AssessPlacementOutcome::Assessment(assessment) => {
                assert!(!assessment.legal);
                assert_eq!(
                    assessment.message,
                    "moving polygon must remain inside the sheet."
                );
            }
            AssessPlacementOutcome::Failure(err) => panic!("unexpected failure: {err:?}"),
        }

        // Sheetless: the same out-of-bounds placement is legal, since the
        // sheet-bounds step is skipped entirely.
        match assess_placement(&input, false) {
            AssessPlacementOutcome::Assessment(assessment) => assert!(assessment.legal),
            AssessPlacementOutcome::Failure(err) => panic!("unexpected failure: {err:?}"),
        }
    }

    #[test]
    fn non_finite_translation_is_a_geometry_failure() {
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let sheet_spec = sheet(100.0, 100.0);
        let input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(f64::INFINITY, 0.0),
        };
        match assess_placement(&input, true) {
            AssessPlacementOutcome::Failure(err) => {
                assert_eq!(err.operation, "validatePlacement");
                assert_eq!(
                    err.message,
                    "moving translation must produce finite polygon coordinates."
                );
            }
            AssessPlacementOutcome::Assessment(_) => panic!("expected a geometry failure"),
        }
    }

    #[test]
    fn indexed_and_brute_force_branches_agree_for_overlap() {
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let placed = placed_piece(square_ring(0.0, 2.0), 1.0, 0.0);
        let sheet_spec = sheet(100.0, 100.0);

        // Brute-force branch (no index).
        let brute_input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[Arc::clone(&placed)],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        let brute_legal = match assess_placement(&brute_input, true) {
            AssessPlacementOutcome::Assessment(assessment) => assessment.legal,
            AssessPlacementOutcome::Failure(err) => panic!("unexpected failure: {err:?}"),
        };

        // Indexed branch.
        let index = make_placed_collision_spatial_index(&[Arc::clone(&placed)], Some(4.0));
        let indexed_input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[Arc::clone(&placed)],
            placed_collision_index: Some(&index),
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        let indexed_legal = match assess_placement(&indexed_input, true) {
            AssessPlacementOutcome::Assessment(assessment) => assessment.legal,
            AssessPlacementOutcome::Failure(err) => panic!("unexpected failure: {err:?}"),
        };

        assert_eq!(brute_legal, indexed_legal);
        assert!(!brute_legal);
    }

    #[test]
    fn stale_index_falls_back_to_brute_force() {
        // An index built over a *different* set of placed pieces (by
        // reference) must not be trusted; `matches()` returns false and
        // `assess_placement` falls back to the brute-force branch, which
        // still correctly detects the overlap against the real `input.placed`.
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let placed = placed_piece(square_ring(0.0, 2.0), 1.0, 0.0);
        let unrelated = placed_piece(square_ring(50.0, 52.0), 0.0, 0.0);
        let stale_index = make_placed_collision_spatial_index(&[Arc::clone(&unrelated)], Some(4.0));
        let sheet_spec = sheet(100.0, 100.0);

        let input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[Arc::clone(&placed)],
            placed_collision_index: Some(&stale_index),
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        match assess_placement(&input, true) {
            AssessPlacementOutcome::Assessment(assessment) => assert!(!assessment.legal),
            AssessPlacementOutcome::Failure(err) => panic!("unexpected failure: {err:?}"),
        }
    }

    #[test]
    fn check_returns_ok_false_for_illegal_placement() {
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let placed = placed_piece(square_ring(0.0, 2.0), 1.0, 0.0);
        let sheet_spec = sheet(100.0, 100.0);
        let input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[placed],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        assert_eq!(check(&input), Ok(false));
    }

    #[test]
    fn validate_returns_err_for_illegal_placement_with_hardcoded_operation() {
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let placed = placed_piece(square_ring(0.0, 2.0), 1.0, 0.0);
        let sheet_spec = sheet(100.0, 100.0);
        let input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[placed],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        let result = validate(&input);
        assert_eq!(
            result,
            Err(IrregularGeometryInputError {
                operation: "validatePlacement".to_string(),
                message: "moving polygon has positive-area overlap with placed collision geometry."
                    .to_string(),
            })
        );
    }

    #[test]
    fn check_sheetless_ignores_sheet_bounds() {
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let input = AssessPlacementInput {
            sheet: None,
            placed: &[],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(1000.0, 1000.0), // far outside any reasonable sheet
        };
        assert_eq!(check_sheetless(&input), Ok(true));
    }

    #[test]
    fn diamond_inscribed_in_square_overlaps() {
        // A diamond fully inside a square: no vertex of the square is inside
        // the diamond and vice versa may or may not hold depending on scale;
        // pick a diamond whose vertices touch the square's edge midpoints so
        // neither polygon's vertices are strictly inside the other, forcing
        // the crossing/interior-point stages to detect the overlap.
        let square_polygon = square_ring(0.0, 4.0);
        let diamond =
            IrregularPolygon::new(vec![p(2.0, 0.5), p(3.5, 2.0), p(2.0, 3.5), p(0.5, 2.0)]);
        let moving = moving_geometry(diamond);
        let placed = placed_piece(square_polygon, 0.0, 0.0);
        let sheet_spec = sheet(100.0, 100.0);
        let input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[placed],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        match assess_placement(&input, true) {
            AssessPlacementOutcome::Assessment(assessment) => assert!(!assessment.legal),
            AssessPlacementOutcome::Failure(err) => panic!("unexpected failure: {err:?}"),
        }
    }

    #[test]
    fn coincident_rings_overlap() {
        let moving = moving_geometry(square_ring(0.0, 2.0));
        let placed = placed_piece(square_ring(0.0, 2.0), 0.0, 0.0);
        let sheet_spec = sheet(100.0, 100.0);
        let input = AssessPlacementInput {
            sheet: Some(&sheet_spec),
            placed: &[placed],
            placed_collision_index: None,
            moving: &moving,
            candidate_point: p(0.0, 0.0),
        };
        match assess_placement(&input, true) {
            AssessPlacementOutcome::Assessment(assessment) => assert!(!assessment.legal),
            AssessPlacementOutcome::Failure(err) => panic!("unexpected failure: {err:?}"),
        }
    }
}
