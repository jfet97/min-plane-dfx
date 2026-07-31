//! Collision-geometry preparation: source flatten -> convex hull ->
//! normalize -> conservative padded offset -> re-normalize to the
//! placement-origin convention, plus the Clipper2 integer-grid offset
//! adapter that padding step is built on.
//!
//! TS source (this task's three assigned files, each ported completely):
//! - `src/workers/irregular/collisionGeometryBuilder.ts` (259 lines) —
//!   [`build_piece`] and its private helpers.
//! - `src/workers/irregular/clipper2OffsetAdapter.ts` (233 lines) —
//!   [`clipper2_offset_adapter_compute`] and its private helpers.
//! - `src/workers/irregular/convexPolygonOffset.ts` (64 lines) —
//!   [`convex_polygon_offset_compute`] and its private helpers.
//!
//! Governing characterization document (read in full before porting, per
//! task instruction):
//! `docs/planning/rust-irregular-backend/characterization/collision-prep.md`.
//!
//! # Scope note: `geometryKernel.ts` is inlined, not a separate module
//!
//! `collisionGeometryBuilder.ts:70,73,79-82` calls three `GeometryKernel`
//! operations (`flattenSourceGeometry`, `convexHull`, `offsetConvexPolygon`)
//! through Effect dependency injection. `geometryKernel.ts` itself is not one
//! of this task's three assigned files, and this crate has no separate
//! `geometry_kernel` module reserved for it (confirmed by this task's file
//! ownership list). Per collision-prep.md §2 ("Callees") and §1's table,
//! `GeometryKernel`'s three operations used here are:
//! - `convexHull` — `Effect.succeed(ConvexHull.compute(points))`, a bare
//!   passthrough to [`super::convex::compute_convex_hull`] (already this
//!   crate's GREEN port of `convexHull.ts`/`core/convexHullCore.ts`) with no
//!   additional logic of its own. Called directly here, no glue needed.
//! - `flattenSourceGeometry` — real algorithm (`makePointsStore`'s exact-key
//!   dedup, the `sampledSourceCurves` per-curve gate, and the
//!   line/arc `Match` dispatch into `ArcFlattening`/`EllipseFlattening`),
//!   reproduced below as [`flatten_source_geometry`] since it is
//!   `collisionGeometryBuilder.ts:70`'s direct, inseparable callee and has no
//!   home of its own in this crate.
//! - `offsetConvexPolygon` — real algorithm (`computeCollisionOffsetMm`'s
//!   `totalPaddingMm / 2 + clearanceSafetyMarginMm` derivation, finite-check,
//!   then a call into `ConvexPolygonOffset.compute`), reproduced below as
//!   [`offset_convex_polygon`] for the same reason. Its `decodeOffsetConvexPolygonInput`
//!   companion (`geometryKernel.ts:246-258`, a bare `Schema.decodeUnknownExit`
//!   re-validation of `totalPaddingMm`/`polygon` against `OffsetConvexPolygonInput`)
//!   is **not** reproduced here — see "Deliberately not reproduced" below.
//!
//! # Deliberately not reproduced: the `OffsetConvexPolygonInput` schema decode
//!
//! `geometryKernel.ts:246-258`'s `decodeOffsetConvexPolygonInput` re-validates
//! `totalPaddingMm`/`polygon` against the shared `OffsetConvexPolygonInput`
//! schema (`NonNegativeFiniteMillimeters` + `IrregularPolygonSchema`) on every
//! `offsetConvexPolygon` call, ahead of `computeCollisionOffsetMm`. This crate
//! follows the same precedent `transforms::generator`'s module doc already
//! established for the structurally identical `GenerateTransformsInput`
//! schema decode: a pure Rust-typed algorithm function trusts its
//! already-typed argument, and the schema-boundary validation itself is a
//! Stage-1 N-API/JSON-deserialization-boundary concern, not this pure
//! function's. Concretely, this means [`offset_convex_polygon`]/[`build_piece`]
//! do **not** reject a negative `total_padding_mm` the way the live TS
//! service does (`operation: 'offsetConvexPolygon'`, `message: 'offset input
//! must satisfy the shared offset geometry schema.'`) — a caller must ensure
//! `total_padding_mm >= 0` before calling, exactly as `transforms::generator`
//! requires its caller to ensure `GenerateTransformsInput`'s numeric
//! refinements. `computeCollisionOffsetMm`'s own explicit finiteness check
//! (`geometryKernel.ts:234-240`) *is* reproduced (see [`offset_convex_polygon`]),
//! since that is the algorithm's own logic, not a schema-boundary artifact.
//!
//! # `transforms::flattening` reuse (a pre-existing wiring gap this task closed)
//!
//! `ArcFlattening.samplePoints`/`sampleBulgePoints`/`EllipseFlattening.samplePoints`
//! are already fully ported at `crate::transforms::flattening` (`arc`/`ellipse`
//! submodules), per this crate's "GREEN modules to reuse, never duplicate"
//! rule. That module's own doc comment ("Module visibility note") documents
//! that `src/transforms/mod.rs` declared `mod flattening;` privately and was
//! "ready... once a later wiring task makes this submodule (or a re-export of
//! it) public." This task **is** that later wiring task: `src/transforms/mod.rs`
//! now declares `pub(crate) mod flattening;` (a one-line, additive visibility
//! change; no logic in `flattening.rs` itself was touched) so
//! [`flatten_source_geometry`] below can call it directly instead of
//! duplicating its ~450 lines of ported arc/ellipse sampling logic.
//!
//! # `IrregularGeometryInputError` reuse
//!
//! This crate's one `IrregularGeometryInputError` type (mirroring
//! `services.ts:42-45`'s `Data.TaggedError`) is already declared at
//! `crate::transforms::generator::IrregularGeometryInputError` (a fully `pub`
//! struct with `pub` fields, reachable with no further edits since
//! `transforms::generator` is already `pub mod generator;`). Reused here
//! rather than redeclaring a second, structurally-identical type, per this
//! crate's "whichever module owns a shape should import it, not redeclare it"
//! convention (`domain/mod.rs`'s module doc, citing `effect-boundary.md` §14
//! item 3). `IrregularNestingNotImplementedError` (`services.ts:34-40`) has no
//! equivalent here: it is only ever raised by `CollisionGeometryBuilder.Unimplemented`
//! and `GeometryKernel.Unimplemented`, both DI test-double layers with zero
//! production callers (collision-prep.md §1, "Not on the production path"),
//! so neither `.Unimplemented`/`.Live` layer wiring nor `buildPieces`'s
//! `concurrency: 1` batch shape (also zero production callers, same section)
//! is ported — only the live, single-piece `buildPiece` algorithm is.
//!
//! # `clipper2OffsetPolicy.ts` constant ownership
//!
//! `canonical_grid::offset_policy` (a different task) ports only
//! `toGridMm`/`fromGrid` from `clipper2OffsetPolicy.ts`, per that module's own
//! doc comment: "the rest of that file's policy constants and
//! `conservativeOffsetMm` belong to the Clipper2 offset module" — i.e. this
//! one. The `CLIPPER2_OFFSET_*` constants and [`conservative_offset_mm`]
//! below are this file's own, matching that ownership split exactly.

use std::collections::HashSet;

use crate::canonical_grid::{from_grid, to_grid_mm};
use crate::clipper::core::{self, Path64, Point64};
use crate::clipper::offset::{ClipperOffset, EndType, JoinType};
use crate::domain::{
    CollisionGeometry, CollisionGeometryDiagnostic, DxfGeometrySegment, FlattenedGeometry,
    ImportedPiece, IrregularBounds, IrregularGeometrySettings, IrregularPoint, IrregularPolygon,
};
use crate::geometry::convex::{self, StrictConvexBoundaryValidation};
use crate::js_number;
use crate::js_number::js_math;
use crate::transforms::flattening::{arc, ellipse};
use crate::transforms::generator::IrregularGeometryInputError;

// ============================================================================
// clipper2OffsetPolicy.ts's non-toGridMm/fromGrid constants (owned here, see
// module doc's "constant ownership" section).
// ============================================================================

/// TS: `clipper2OffsetPolicy.ts:11` `CLIPPER2_OFFSET_POLICY.scale`. Only used
/// here to derive the scaled `arcTolerance` argument to `inflatePaths`
/// (`clipper2OffsetAdapter.ts:72`); the grid quantization itself is owned by
/// [`to_grid_mm`]/[`from_grid`].
const CLIPPER2_OFFSET_SCALE: f64 = 1000.0;
/// TS: `clipper2OffsetPolicy.ts:14` `conservativeOffsetAllowanceMm`.
const CONSERVATIVE_OFFSET_ALLOWANCE_MM: f64 = 0.002;
/// TS: `clipper2OffsetPolicy.ts:16` `miterLimit`.
const CLIPPER2_MITER_LIMIT: f64 = 10.0;
/// TS: `clipper2OffsetPolicy.ts:18` `futureRoundJoinArcToleranceMm`.
const FUTURE_ROUND_JOIN_ARC_TOLERANCE_MM: f64 = 0.01;
/// TS: `clipper2OffsetPolicy.ts:21` `maxScaledCoordinate`.
const MAX_SCALED_COORDINATE: f64 = 1_000_000_000.0;

/// TS: `clipper2OffsetPolicy.ts:36-38` `conservativeOffsetMm`. Adds the fixed
/// allowance required to preserve the requested real-valued collision
/// envelope after nearest-grid coordinate and offset rounding (derivation:
/// collision-prep.md §7, "The `0.002mm` conservative offset allowance").
fn conservative_offset_mm(distance_mm: f64) -> f64 {
    distance_mm + CONSERVATIVE_OFFSET_ALLOWANCE_MM
}

// ============================================================================
// clipper2OffsetAdapter.ts
// ============================================================================

/// TS: `clipper2OffsetAdapter.ts:41-103` `compute` (`Clipper2OffsetAdapter.compute`).
/// Applies the policy boundary: robustly validates the source, quantizes
/// once, guards scaled coordinates, calls Miter/Polygon inflation, and
/// validates the single derived path before dequantizing it. Returns exactly
/// one finite, simple, convex, CCW polygon whose vertex order starts at the
/// stable lowest-then-leftmost vertex.
pub fn clipper2_offset_adapter_compute(
    polygon: &IrregularPolygon,
    distance_mm: f64,
) -> Result<IrregularPolygon, IrregularGeometryInputError> {
    // TS: `clipper2OffsetAdapter.ts:44-48`.
    let winding = match convex::validate_strict_boundary(&polygon.points) {
        StrictConvexBoundaryValidation::Invalid { message } => {
            return Err(fail_offset_invalid_input(message));
        }
        StrictConvexBoundaryValidation::Valid { winding } => winding,
    };

    let mut canonical_points = polygon.points.clone();
    if winding != 1 {
        canonical_points.reverse();
    }

    // TS: `clipper2OffsetAdapter.ts:49-53`.
    let integer_path = to_integer_path(&canonical_points).map_err(fail_offset_invalid_input)?;
    if let Some(message) = validate_path(&integer_path, "quantized input") {
        return Err(fail_offset_invalid_input(message));
    }

    // TS: `clipper2OffsetAdapter.ts:55-62`.
    let scaled_offset = to_grid_mm(conservative_offset_mm(distance_mm)).ok_or_else(|| {
        fail_offset_invalid_input(
            "distanceMm cannot be represented by the Clipper2 integer grid.".to_string(),
        )
    })?;
    if let Some(message) = validate_coordinate_guard(&integer_path, scaled_offset) {
        return Err(fail_offset_invalid_input(message));
    }

    // TS: `clipper2OffsetAdapter.ts:64-76` (`inflatePaths`, per `Clipper.ts:104-110`:
    // `new ClipperOffset(miterLimit, arcTolerance); co.addPaths(paths, joinType,
    // endType); co.execute(delta, solution)`).
    let arc_tolerance = FUTURE_ROUND_JOIN_ARC_TOLERANCE_MM * CLIPPER2_OFFSET_SCALE;
    let mut clipper_offset = ClipperOffset::new(CLIPPER2_MITER_LIMIT, arc_tolerance, false, false);
    clipper_offset.add_paths(
        std::slice::from_ref(&integer_path),
        JoinType::Miter,
        EndType::Polygon,
    );
    let offset_paths = clipper_offset
        .execute(scaled_offset)
        .map_err(|error| fail_offset_invalid_input(clipper_failure_message(&error)))?;

    // TS: `clipper2OffsetAdapter.ts:78-87`.
    if offset_paths.len() != 1 {
        return Err(fail_offset_invalid_input(format!(
            "Clipper2 offset must return exactly one path; received {}.",
            offset_paths.len()
        )));
    }
    let offset_path = &offset_paths[0];

    // TS: `clipper2OffsetAdapter.ts:89-96`.
    if let Some(message) = validate_path(offset_path, "Clipper2 offset result") {
        return Err(fail_offset_invalid_input(message));
    }
    if !core::is_positive(offset_path) {
        return Err(fail_offset_invalid_input(
            "Clipper2 offset result must use counter-clockwise winding.".to_string(),
        ));
    }
    if let Some(message) = validate_output_coordinates(offset_path) {
        return Err(fail_offset_invalid_input(message));
    }

    // TS: `clipper2OffsetAdapter.ts:98-102`.
    let rotated = rotate_to_stable_start(offset_path, |p: &Point64| p.y, |p: &Point64| p.x);
    Ok(IrregularPolygon::new(to_irregular_points(&rotated)))
}

/// TS: `clipper2OffsetAdapter.ts:110-139` `toIntegerPath`. Converts real
/// points to safe integer grid points without hidden library rounding.
/// Suppresses only *adjacent* duplicates (a linear scan against the single
/// immediately-preceding pushed point, unlike [`validate_path`]'s global
/// uniqueness set), then explicitly drops a closing duplicate if the first
/// and last surviving points coincide — including the degenerate case of a
/// single surviving point, where "first" and "last" are the same element and
/// therefore always compare equal, collapsing a one-point path to empty
/// (reproduced exactly, not special-cased away).
fn to_integer_path(points: &[IrregularPoint]) -> Result<Path64, String> {
    let mut path: Path64 = Vec::new();
    for (index, point) in points.iter().enumerate() {
        let x = to_grid_mm(point.x);
        let y = to_grid_mm(point.y);
        let (x, y) = match (x, y) {
            (Some(x), Some(y)) => (x, y),
            _ => {
                return Err(format!(
                    "polygon vertex {index} cannot be represented by the Clipper2 integer grid."
                ));
            }
        };
        if let Some(previous) = path.last() {
            if previous.x == x && previous.y == y {
                continue;
            }
        }
        path.push(Point64::new(x, y, 0.0));
    }

    if let (Some(first), Some(last)) = (path.first().copied(), path.last().copied()) {
        if first.x == last.x && first.y == last.y {
            path.pop();
        }
    }

    Ok(path)
}

/// TS: `clipper2OffsetAdapter.ts:142-166` `validatePath`. Rejects duplicate,
/// non-convex, non-simple, zero-area, or unsafe integer paths.
fn validate_path(path: &Path64, label: &str) -> Option<String> {
    if path.len() < 3 {
        return Some(format!(
            "{label} must contain at least three unique vertices."
        ));
    }

    // TS's `` `${point.x}:${point.y}` `` string key, over already-quantized
    // safe integers: an `(i64, i64)` tuple key induces the identical
    // equivalence classes (a safe-integer `f64` casts to `i64` exactly, and
    // `-0.0 as i64 == 0i64` reproduces the same `-0`/`0` string collision JS
    // template coercion would produce here) without needing string
    // allocation — see collision-prep.md §8 for the JS-key equivalence
    // argument this relies on.
    let mut unique_points: HashSet<(i64, i64)> = HashSet::with_capacity(path.len());
    for point in path {
        if !js_number::is_safe_integer(point.x) || !js_number::is_safe_integer(point.y) {
            return Some(format!(
                "{label} contains a non-finite or unsafe integer coordinate."
            ));
        }
        let key = (point.x as i64, point.y as i64);
        if !unique_points.insert(key) {
            return Some(format!(
                "{label} must contain at least three unique vertices."
            ));
        }
    }

    let points = to_irregular_points(path);
    if let StrictConvexBoundaryValidation::Invalid { message } =
        convex::validate_strict_boundary(&points)
    {
        return Some(format!("{label} {message}"));
    }

    let signed_area = core::area(path);
    if !signed_area.is_finite() || signed_area == 0.0 {
        return Some(format!("{label} must have a finite non-zero area."));
    }

    None
}

/// TS: `clipper2OffsetAdapter.ts:169-181` `validateCoordinateGuard`. Enforces
/// the planned coordinate headroom before Clipper2 receives the path.
fn validate_coordinate_guard(path: &Path64, scaled_offset: f64) -> Option<String> {
    let offset_headroom = 2.0 * scaled_offset.abs();
    for point in path {
        if point.x.abs() + offset_headroom > MAX_SCALED_COORDINATE
            || point.y.abs() + offset_headroom > MAX_SCALED_COORDINATE
        {
            return Some(
                "polygon coordinates plus twice the scaled offset exceed the Clipper2 coordinate guard."
                    .to_string(),
            );
        }
    }
    None
}

/// TS: `clipper2OffsetAdapter.ts:184-197` `validateOutputCoordinates`.
/// Rejects malformed or out-of-range coordinates returned by the external
/// library.
fn validate_output_coordinates(path: &Path64) -> Option<String> {
    for point in path {
        if !js_number::is_safe_integer(point.x)
            || !js_number::is_safe_integer(point.y)
            || point.x.abs() > MAX_SCALED_COORDINATE
            || point.y.abs() > MAX_SCALED_COORDINATE
        {
            return Some(
                "Clipper2 offset result contains a coordinate outside the scaled coordinate guard."
                    .to_string(),
            );
        }
    }
    None
}

/// TS: `clipper2OffsetAdapter.ts:200-202` `toIrregularPoints`. Converts
/// integer path coordinates back to domain points without re-rounding.
fn to_irregular_points(path: &[Point64]) -> Vec<IrregularPoint> {
    path.iter()
        .map(|point| IrregularPoint::new(from_grid(point.x), from_grid(point.y)))
        .collect()
}

/// TS: `clipper2OffsetAdapter.ts:205-217` and `convexPolygonOffset.ts:42-54`
/// (two structurally-identical `rotateToStableStart` copies — see
/// collision-prep.md §5/§12, "worth collapsing into one shared Rust helper...
/// since both loops are byte-for-byte the same algorithm"). Gives the result
/// a stable lowest-then-leftmost starting vertex: strict `<` throughout, so
/// on an exact tie the earliest-index point wins (first-seen-wins; rotates
/// the array, never reverses it).
fn rotate_to_stable_start<T: Copy>(
    points: &[T],
    y: impl Fn(&T) -> f64,
    x: impl Fn(&T) -> f64,
) -> Vec<T> {
    let mut start_index = 0usize;
    for index in 1..points.len() {
        let candidate = &points[index];
        let current = &points[start_index];
        if y(candidate) < y(current) || (y(candidate) == y(current) && x(candidate) < x(current)) {
            start_index = index;
        }
    }
    let mut rotated = Vec::with_capacity(points.len());
    rotated.extend_from_slice(&points[start_index..]);
    rotated.extend_from_slice(&points[..start_index]);
    rotated
}

/// TS: `clipper2OffsetAdapter.ts:220-223` `clipperFailureMessage`. Preserves
/// external-library failure context in the typed domain error message.
///
/// **Deviation from byte-exact TS parity** (documented, not silent): TS's
/// `error instanceof Error ? \`Clipper2 offset failed: ${error.message}\` : ...`
/// formats the real `clipper2-ts` npm package's thrown `Error#message`
/// string. This crate's Clipper2 port (`clipper::offset::ClipperOffset::execute`)
/// returns a typed `ClipperError` instead of throwing, with no equivalent
/// human-readable message string, so this formats the typed error's `Debug`
/// representation instead. This boundary is effectively unreachable for any
/// input that already passed [`validate_coordinate_guard`] above (the guard
/// exists specifically to keep every coordinate `inflatePaths` receives
/// within the safe-integer envelope `ClipperError`'s guards enforce), so no
/// production input is expected to exercise this exact message text either
/// in TS or here.
fn clipper_failure_message(error: &crate::clipper::offset::ClipperError) -> String {
    format!("Clipper2 offset failed: {error:?}")
}

/// TS: `clipper2OffsetAdapter.ts:226-233` and `convexPolygonOffset.ts:57-64`
/// (two independently-defined `failInvalidInput` closures with the identical
/// `operation: 'offsetConvexPolygon'` string — collision-prep.md §11/§12
/// confirms this is harmless duplication, safe to consolidate since output is
/// identical either way).
fn fail_offset_invalid_input(message: impl Into<String>) -> IrregularGeometryInputError {
    IrregularGeometryInputError {
        operation: "offsetConvexPolygon".to_string(),
        message: message.into(),
    }
}

// ============================================================================
// convexPolygonOffset.ts
// ============================================================================

/// TS: `convexPolygonOffset.ts:18-28` `compute` (`ConvexPolygonOffset.compute`).
/// Validates the real-valued convex input before it crosses into integer
/// geometry, then restores the caller's original winding after
/// [`clipper2_offset_adapter_compute`]'s forced CCW computation.
pub fn convex_polygon_offset_compute(
    polygon: &IrregularPolygon,
    distance_mm: f64,
) -> Result<IrregularPolygon, IrregularGeometryInputError> {
    let winding = match convex::validate_strict_boundary(&polygon.points) {
        StrictConvexBoundaryValidation::Invalid { message } => {
            return Err(fail_offset_invalid_input(message));
        }
        StrictConvexBoundaryValidation::Valid { winding } => winding,
    };

    let offset_polygon = clipper2_offset_adapter_compute(polygon, distance_mm)?;
    Ok(restore_input_winding(offset_polygon, winding))
}

/// TS: `convexPolygonOffset.ts:31-39` `restoreInputWinding`. Restores the
/// caller's clockwise winding after the adapter's CCW computation.
fn restore_input_winding(
    polygon: IrregularPolygon,
    winding: convex::ConvexPolygonWinding,
) -> IrregularPolygon {
    if winding == 1 {
        return polygon;
    }

    let mut reversed_points = polygon.points;
    reversed_points.reverse();
    let rotated = rotate_to_stable_start(
        &reversed_points,
        |p: &IrregularPoint| p.y,
        |p: &IrregularPoint| p.x,
    );
    IrregularPolygon::new(rotated)
}

// ============================================================================
// geometryKernel.ts's offsetConvexPolygon glue (see module doc's scope note)
// ============================================================================

/// TS: `geometryKernel.ts:171-178` (`offsetConvexPolygon`'s live
/// implementation body) `.pipe(Effect.flatMap(computeCollisionOffsetMm))` and
/// `geometryKernel.ts:230-243` `computeCollisionOffsetMm`. Combines the
/// caller's total padding with the configured clearance safety margin into
/// the derived offset distance, then delegates to
/// [`convex_polygon_offset_compute`]. See module doc's "Deliberately not
/// reproduced" section for why the `OffsetConvexPolygonInput` schema-decode
/// step ahead of this is not ported here.
fn offset_convex_polygon(
    polygon: &IrregularPolygon,
    total_padding_mm: f64,
    geometry_settings: &IrregularGeometrySettings,
) -> Result<IrregularPolygon, IrregularGeometryInputError> {
    let distance_mm = total_padding_mm / 2.0 + geometry_settings.clearance_safety_margin_mm;
    if !distance_mm.is_finite() {
        return Err(IrregularGeometryInputError {
            operation: "offsetConvexPolygon".to_string(),
            message:
                "totalPaddingMm plus clearanceSafetyMarginMm must produce a finite offset distance."
                    .to_string(),
        });
    }

    convex_polygon_offset_compute(polygon, distance_mm)
}

// ============================================================================
// geometryKernel.ts's flattenSourceGeometry glue (see module doc's scope note)
// ============================================================================

/// TS: `geometryKernel.ts:96-169` `flattenSourceGeometry`/`makePointsStore`.
/// The sole caller-equivalent of `ArcFlattening`/`EllipseFlattening`
/// (`transforms::flattening::arc`/`ellipse`, see module doc's "reuse"
/// section). Dedupes across **all** of a piece's segments by exact `(x, y)`
/// coordinate identity (first-seen order preserved), and samples each
/// distinct `sourceCurve.sourceId` at most once regardless of how many line
/// segments reference it.
fn flatten_source_geometry(
    piece: &ImportedPiece,
    geometry_settings: &IrregularGeometrySettings,
) -> FlattenedGeometry {
    let mut points: Vec<IrregularPoint> = Vec::new();
    let mut seen_point_keys: HashSet<String> = HashSet::new();
    let mut sampled_source_curves: HashSet<String> = HashSet::new();

    for segment in &piece.geometry.segments {
        match segment {
            DxfGeometrySegment::Line(line) => {
                if let Some(source_curve) = &line.source_curve {
                    if sampled_source_curves.contains(&source_curve.source_id) {
                        continue;
                    }
                    sampled_source_curves.insert(source_curve.source_id.clone());
                    for point in ellipse::sample_points(
                        source_curve,
                        geometry_settings.flattening_sag_tolerance_mm,
                    ) {
                        push_sampled_point(&mut points, &mut seen_point_keys, point.x, point.y);
                    }
                    continue;
                }

                if let Some(bulge) = line.bulge {
                    if bulge != 0.0 {
                        for point in arc::sample_bulge_points(
                            line,
                            geometry_settings.flattening_sag_tolerance_mm,
                        ) {
                            push_sampled_point(&mut points, &mut seen_point_keys, point.x, point.y);
                        }
                        continue;
                    }
                }

                push_sampled_point(&mut points, &mut seen_point_keys, line.x1, line.y1);
                push_sampled_point(&mut points, &mut seen_point_keys, line.x2, line.y2);
            }
            DxfGeometrySegment::Arc(segment_arc) => {
                for point in
                    arc::sample_points(*segment_arc, geometry_settings.flattening_sag_tolerance_mm)
                {
                    push_sampled_point(&mut points, &mut seen_point_keys, point.x, point.y);
                }
            }
        }
    }

    FlattenedGeometry {
        source_piece_id: piece.id.clone(),
        sampled_points: points,
        diagnostics: Vec::new(),
    }
}

/// TS: `geometryKernel.ts:96-112` `makePointsStore`'s `.push(x, y)`. The
/// dedup key is JS's `` `${x}:${y}` `` template-literal number coercion
/// (exact, not rounded/quantized); reproduced here via
/// [`js_number::number_to_js_string`] (already this crate's GREEN port of
/// that exact coercion, including its `-0 -> "0"` fold) rather than a bare
/// `format!("{x}:{y}")`, to induce the identical equivalence classes — see
/// collision-prep.md §8/§12 ("Template-literal number coercion as a dedup
/// key").
fn push_sampled_point(
    points: &mut Vec<IrregularPoint>,
    seen: &mut HashSet<String>,
    x: f64,
    y: f64,
) {
    let key = format!(
        "{}:{}",
        js_number::number_to_js_string(x),
        js_number::number_to_js_string(y)
    );
    if seen.contains(&key) {
        return;
    }
    seen.insert(key);
    points.push(IrregularPoint::new(x, y));
}

// ============================================================================
// collisionGeometryBuilder.ts
// ============================================================================

/// TS: `services.ts:95-98` `BuildCollisionGeometryInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct BuildCollisionGeometryInput {
    pub piece: ImportedPiece,
    pub total_padding_mm: f64,
}

struct NormalizedHull {
    source_bounds: IrregularBounds,
    convex_hull: IrregularPolygon,
}

struct NormalizedCollisionGeometry {
    convex_hull: IrregularPolygon,
    collision_polygon: IrregularPolygon,
    placement_reference: IrregularPoint,
}

/// TS: `collisionGeometryBuilder.ts:59-100` `buildPiece` (the pure algorithm
/// body of `CollisionGeometryBuilder.Make`'s live implementation). Builds one
/// piece's conservative, padded, convex collision polygon from imported
/// source geometry: flatten -> convex hull -> normalize -> offset ->
/// re-normalize to the placement-origin convention.
pub fn build_piece(
    input: &BuildCollisionGeometryInput,
    geometry_settings: &IrregularGeometrySettings,
) -> Result<CollisionGeometry, IrregularGeometryInputError> {
    let piece = &input.piece;

    // an open path has no enclosed material, so it cannot safely define a collision area
    if !piece.geometry.closed {
        return Err(fail_invalid_source_geometry(
            piece,
            "source geometry must be a closed outline before collision geometry can be built.",
        ));
    }

    // flattening keeps the original source coordinates for debug and export traceability
    let flattened = flatten_source_geometry(piece, geometry_settings);

    // the hull removes concave detail conservatively before placement geometry is created
    let source_hull = convex::compute_convex_hull(&flattened.sampled_points);

    // translate source coordinates before offsetting so the offset math stays near the local origin
    let normalized_hull = normalize_hull(piece, &source_hull)?;

    // the configured safety margin and the caller's total padding derive the final offset distance
    let collision_polygon = offset_convex_polygon(
        &normalized_hull.convex_hull,
        input.total_padding_mm,
        geometry_settings,
    )?;

    // the collision bounds minimum is the placement origin used by NFPs, IFPs, and placements
    let normalized_collision =
        normalize_collision_geometry(piece, &normalized_hull, &collision_polygon)?;

    let mut diagnostics = flattened.diagnostics;
    diagnostics.extend(import_warning_diagnostics(piece));

    Ok(CollisionGeometry {
        source_piece_id: piece.id.clone(),
        source_bounds: normalized_hull.source_bounds,
        sampled_points: flattened.sampled_points,
        convex_hull: normalized_collision.convex_hull,
        collision_polygon: normalized_collision.collision_polygon,
        placement_reference: normalized_collision.placement_reference,
        diagnostics,
    })
}

/// TS: `collisionGeometryBuilder.ts:129-164` `normalizeHull`. Computes source
/// hull bounds and expresses the hull relative to its own bounds minimum so
/// the subsequent offset calculation uses small local coordinates.
fn normalize_hull(
    piece: &ImportedPiece,
    source_hull: &IrregularPolygon,
) -> Result<NormalizedHull, IrregularGeometryInputError> {
    if source_hull.points.len() < 3 {
        return Err(fail_invalid_source_geometry(
            piece,
            "source geometry must contain at least three non-collinear points.",
        ));
    }

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    for point in &source_hull.points {
        if !point.x.is_finite() || !point.y.is_finite() {
            return Err(fail_invalid_source_geometry(
                piece,
                "source geometry points must have finite coordinates.",
            ));
        }

        min_x = js_math::min(min_x, point.x);
        min_y = js_math::min(min_y, point.y);
        max_x = js_math::max(max_x, point.x);
        max_y = js_math::max(max_y, point.y);
    }

    Ok(NormalizedHull {
        source_bounds: IrregularBounds::new(min_x, min_y, max_x, max_y),
        convex_hull: IrregularPolygon::new(
            source_hull
                .points
                .iter()
                .map(|point| IrregularPoint::new(point.x - min_x, point.y - min_y))
                .collect(),
        ),
    })
}

/// TS: `collisionGeometryBuilder.ts:174-194` `normalizeCollisionGeometry`.
/// Re-bases the hull and collision polygon to the collision polygon's
/// lower-left bound corner, which is the single placement point convention
/// for v2. The source-space placement reference records that padded bound
/// corner before rebasing; it may lie outside cut material because padding is
/// included.
fn normalize_collision_geometry(
    piece: &ImportedPiece,
    normalized_hull: &NormalizedHull,
    collision_polygon: &IrregularPolygon,
) -> Result<NormalizedCollisionGeometry, IrregularGeometryInputError> {
    // TS: `collisionGeometryBuilder.ts:196-215` `boundsForPolygon` is
    // behaviorally identical to `convexBounds.ts:8-32` `boundsForPoints`
    // (same running-min/max-from-first-point algorithm; `boundsForPolygon`'s
    // own final `IrregularBounds` construction has no extra `min<=max` guard,
    // but by construction the running min/max it computes already satisfies
    // that invariant, so `boundsForPoints`'s `makeBounds` guard is a
    // provable no-op here) — reused directly via
    // [`convex::bounds_for_points`] rather than redeclared, per this crate's
    // GREEN-module-reuse convention.
    let collision_bounds =
        convex::bounds_for_points(&collision_polygon.points).ok_or_else(|| {
            fail_invalid_source_geometry(
                piece,
                "collision polygon must contain at least one finite vertex.",
            )
        })?;

    let translate_x = -collision_bounds.min_x;
    let translate_y = -collision_bounds.min_y;

    Ok(NormalizedCollisionGeometry {
        convex_hull: translate_polygon(&normalized_hull.convex_hull, translate_x, translate_y),
        collision_polygon: translate_polygon(collision_polygon, translate_x, translate_y),
        placement_reference: IrregularPoint::new(
            normalized_hull.source_bounds.min_x + collision_bounds.min_x,
            normalized_hull.source_bounds.min_y + collision_bounds.min_y,
        ),
    })
}

/// TS: `collisionGeometryBuilder.ts:217-227` `translatePolygon`.
fn translate_polygon(
    polygon: &IrregularPolygon,
    translate_x: f64,
    translate_y: f64,
) -> IrregularPolygon {
    IrregularPolygon::new(
        polygon
            .points
            .iter()
            .map(|point| IrregularPoint::new(point.x + translate_x, point.y + translate_y))
            .collect(),
    )
}

/// TS: `collisionGeometryBuilder.ts:229-238` `importWarningDiagnostics`.
/// `pieceId` is always supplied (never omitted) at this call site.
fn import_warning_diagnostics(piece: &ImportedPiece) -> Vec<CollisionGeometryDiagnostic> {
    piece
        .warnings
        .iter()
        .map(|warning| CollisionGeometryDiagnostic {
            code: warning.code.clone(),
            message: warning.message.clone(),
            piece_id: Some(piece.id.clone()),
        })
        .collect()
}

/// TS: `collisionGeometryBuilder.ts:240-248` `failInvalidSourceGeometry`.
/// Always prefixes the message with the source piece's id.
fn fail_invalid_source_geometry(
    piece: &ImportedPiece,
    message: &str,
) -> IrregularGeometryInputError {
    IrregularGeometryInputError {
        operation: "buildCollisionGeometry".to_string(),
        message: format!("{}: {}", piece.id, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        DxfGeometrySummary, DxfLineSegment, ImportWarning, PieceId, Rect, SourceFileId,
    };

    fn point(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    fn line(x1: f64, y1: f64, x2: f64, y2: f64) -> DxfGeometrySegment {
        DxfGeometrySegment::Line(DxfLineSegment {
            x1,
            y1,
            x2,
            y2,
            bulge: None,
            source_curve: None,
        })
    }

    /// TS test fixture: `tests/unit/collisionGeometryBuilder.test.ts:24-46`
    /// `rectanglePiece`.
    fn rectangle_piece(id: &str, closed: bool, warnings: Vec<ImportWarning>) -> ImportedPiece {
        ImportedPiece {
            id: PieceId::new(id),
            source_file_id: SourceFileId::new("test-source"),
            source_layer: None,
            label: "Offset rectangle".to_string(),
            real_bounds: Rect {
                x: 10.0,
                y: 20.0,
                width: 4.0,
                height: 3.0,
            },
            geometry: DxfGeometrySummary {
                entity_type: crate::domain::DxfGeometryEntityType::Lwpolyline,
                closed,
                segments: vec![
                    line(10.0, 20.0, 14.0, 20.0),
                    line(14.0, 20.0, 14.0, 23.0),
                    line(14.0, 23.0, 10.0, 23.0),
                    line(10.0, 23.0, 10.0, 20.0),
                ],
            },
            warnings,
        }
    }

    fn default_geometry_settings() -> IrregularGeometrySettings {
        IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "test".to_string(),
            geometry_backend_version: "0".to_string(),
        }
    }

    /// Hand-verified worked example, pinned against the real TS test:
    /// `tests/unit/collisionGeometryBuilder.test.ts:114-157`
    /// ("preserves source samples while producing a normalized padded
    /// collision polygon").
    #[test]
    fn build_piece_matches_the_ts_worked_example_with_a_warning_diagnostic() {
        let warning = ImportWarning {
            code: "source_note".to_string(),
            message: "The source outline was grouped from multiple DXF entities.".to_string(),
            entity_type: None,
            entity_handle: None,
        };
        let input = BuildCollisionGeometryInput {
            piece: rectangle_piece("offset-rectangle", true, vec![warning]),
            total_padding_mm: 2.0,
        };

        let geometry = build_piece(&input, &default_geometry_settings())
            .expect("valid closed rectangle piece must build successfully");

        assert_eq!(
            geometry.source_bounds,
            IrregularBounds::new(10.0, 20.0, 14.0, 23.0)
        );
        assert_eq!(geometry.placement_reference, point(8.748, 18.748));
        assert_eq!(
            geometry.sampled_points,
            vec![
                point(10.0, 20.0),
                point(14.0, 20.0),
                point(14.0, 23.0),
                point(10.0, 23.0),
            ]
        );
        assert_eq!(
            geometry.convex_hull.points,
            vec![
                point(1.252, 1.252),
                point(5.252, 1.252),
                point(5.252, 4.252),
                point(1.252, 4.252),
            ]
        );
        assert_eq!(
            geometry.collision_polygon.points,
            vec![
                point(0.0, 0.0),
                point(6.504, 0.0),
                point(6.504, 5.504),
                point(0.0, 5.504),
            ]
        );
        assert_eq!(
            geometry.diagnostics,
            vec![CollisionGeometryDiagnostic {
                code: "source_note".to_string(),
                message: "The source outline was grouped from multiple DXF entities.".to_string(),
                piece_id: Some(PieceId::new("offset-rectangle")),
            }]
        );
    }

    /// TS test: `tests/unit/collisionGeometryBuilder.test.ts:159-178` ("uses
    /// the geometry settings service when deriving the collision offset").
    #[test]
    fn build_piece_derives_offset_from_the_supplied_geometry_settings() {
        let settings = IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.5,
            geometry_backend_id: "test-geometry-backend".to_string(),
            geometry_backend_version: "settings-proof".to_string(),
        };
        let input = BuildCollisionGeometryInput {
            piece: rectangle_piece("offset-rectangle", true, vec![]),
            total_padding_mm: 2.0,
        };

        let geometry =
            build_piece(&input, &settings).expect("valid closed rectangle piece must build");

        assert_eq!(
            geometry.collision_polygon.points,
            vec![
                point(0.0, 0.0),
                point(7.004, 0.0),
                point(7.004, 6.004),
                point(0.0, 6.004),
            ]
        );
    }

    /// TS test: `tests/unit/collisionGeometryBuilder.test.ts:199-218`
    /// ("rejects an open source path instead of pretending it encloses
    /// material").
    #[test]
    fn build_piece_rejects_an_open_source_path() {
        let input = BuildCollisionGeometryInput {
            piece: rectangle_piece("offset-rectangle", false, vec![]),
            total_padding_mm: 2.0,
        };

        let error = build_piece(&input, &default_geometry_settings())
            .expect_err("an open path must not build a collision polygon");

        assert_eq!(error.operation, "buildCollisionGeometry");
        assert_eq!(
            error.message,
            "offset-rectangle: source geometry must be a closed outline before collision geometry can be built."
        );
    }

    #[test]
    fn build_piece_rejects_a_degenerate_two_point_hull() {
        let piece = ImportedPiece {
            id: PieceId::new("degenerate"),
            source_file_id: SourceFileId::new("test-source"),
            source_layer: None,
            label: "Degenerate".to_string(),
            real_bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 0.0,
            },
            geometry: DxfGeometrySummary {
                entity_type: crate::domain::DxfGeometryEntityType::Line,
                closed: true,
                segments: vec![line(0.0, 0.0, 10.0, 0.0)],
            },
            warnings: vec![],
        };
        let input = BuildCollisionGeometryInput {
            piece,
            total_padding_mm: 0.0,
        };

        let error = build_piece(&input, &default_geometry_settings())
            .expect_err("a two-point hull must be rejected before offsetting");

        assert_eq!(error.operation, "buildCollisionGeometry");
        assert_eq!(
            error.message,
            "degenerate: source geometry must contain at least three non-collinear points."
        );
    }

    #[test]
    fn build_piece_rejects_an_offset_that_exceeds_the_coordinate_guard() {
        let input = BuildCollisionGeometryInput {
            piece: rectangle_piece("huge-padding", true, vec![]),
            total_padding_mm: 1e15,
        };

        let error = build_piece(&input, &default_geometry_settings())
            .expect_err("an astronomically large padding must exceed the coordinate guard");

        assert_eq!(error.operation, "offsetConvexPolygon");
    }

    #[test]
    fn clipper2_offset_adapter_compute_offsets_a_ccw_square_outward() {
        let square = IrregularPolygon::new(vec![
            point(0.0, 0.0),
            point(10.0, 0.0),
            point(10.0, 10.0),
            point(0.0, 10.0),
        ]);
        // `distance_mm = 1.0` grows by the fixed `0.002mm` conservative
        // allowance inside `compute` (see [`conservative_offset_mm`]), so the
        // realized offset is `1.002`, not `1.0`.
        let result = clipper2_offset_adapter_compute(&square, 1.0).expect("valid convex offset");
        assert_eq!(
            result.points,
            vec![
                point(-1.002, -1.002),
                point(11.002, -1.002),
                point(11.002, 11.002),
                point(-1.002, 11.002),
            ]
        );
    }

    #[test]
    fn clipper2_offset_adapter_compute_rejects_a_non_convex_input() {
        let dart = IrregularPolygon::new(vec![
            point(0.0, 0.0),
            point(10.0, 0.0),
            point(5.0, 3.0),
            point(10.0, 10.0),
            point(0.0, 10.0),
        ]);
        let error = clipper2_offset_adapter_compute(&dart, 1.0).expect_err("non-convex must fail");
        assert_eq!(error.operation, "offsetConvexPolygon");
    }

    #[test]
    fn convex_polygon_offset_compute_restores_clockwise_input_winding() {
        let mut cw_square = vec![
            point(0.0, 0.0),
            point(10.0, 0.0),
            point(10.0, 10.0),
            point(0.0, 10.0),
        ];
        cw_square.reverse();
        let polygon = IrregularPolygon::new(cw_square);

        let result =
            convex_polygon_offset_compute(&polygon, 1.0).expect("valid clockwise convex offset");

        // CCW adapter output rotated back into CW order via `restoreInputWinding`;
        // see the sibling `clipper2_offset_adapter_compute` test for why the
        // realized offset is `1.002`, not `1.0`.
        assert_eq!(
            result.points,
            vec![
                point(-1.002, -1.002),
                point(-1.002, 11.002),
                point(11.002, 11.002),
                point(11.002, -1.002),
            ]
        );
    }

    #[test]
    fn to_integer_path_collapses_a_single_surviving_point_to_empty() {
        // Every input point quantizes to the identical grid coordinate, so
        // adjacent-dedup collapses to one point, and the first===last
        // closing-duplicate check then pops that sole point too (see this
        // function's doc comment).
        let points = vec![point(0.0, 0.0), point(0.0000001, 0.0000001)];
        let path = to_integer_path(&points).expect("no unsafe-integer rejection here");
        assert!(path.is_empty());
    }

    #[test]
    fn conservative_offset_mm_adds_the_fixed_allowance() {
        assert_eq!(conservative_offset_mm(1.25), 1.252);
    }

    #[test]
    fn flatten_source_geometry_dedupes_shared_endpoints_across_segments() {
        let piece = rectangle_piece("dedup-check", true, vec![]);
        let flattened = flatten_source_geometry(&piece, &default_geometry_settings());
        // Four segments sharing endpoints (a closed rectangle) collapse to
        // exactly the four distinct corner points, in first-seen order.
        assert_eq!(
            flattened.sampled_points,
            vec![
                point(10.0, 20.0),
                point(14.0, 20.0),
                point(14.0, 23.0),
                point(10.0, 23.0),
            ]
        );
        assert!(flattened.diagnostics.is_empty());
    }
}
