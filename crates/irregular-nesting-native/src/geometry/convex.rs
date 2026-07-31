//! Convex-hull construction, axis-aligned bounds helpers, and strict-convex
//! simple-ring boundary validation.
//!
//! TS counterparts (read in full to build this module):
//! - `src/workers/irregular/convexHull.ts` (18 lines) — thin domain-object
//!   wrapper `ConvexHull.compute`.
//! - `src/workers/irregular/core/convexHullCore.ts` (41 lines) — the pure
//!   structural monotone-chain hull algorithm, `computeConvexHull`.
//! - `src/workers/irregular/convexBounds.ts` (102 lines) — `boundsForPoints`,
//!   `translatePolygonWithBounds`, `areDisjoint`.
//! - `src/workers/irregular/convexPolygonValidation.ts` (314 lines) — the
//!   strict-convex, simple-ring, finite-coordinate boundary validator
//!   `ConvexPolygonValidation.validateStrictBoundary`.
//!
//! Grounding context also read: `docs/planning/rust-irregular-backend/
//! characterization/validation-spatial.md` (this cluster's Stage 0
//! characterization) and `docs/planning/rust-irregular-backend/
//! stage0-rulings.md`.
//!
//! # Type unification
//!
//! `internalGeometry.ts`'s `InternalPoint`/`InternalBounds`/`InternalPolygon`
//! structural types and `domain.ts`'s `IrregularPoint`/`IrregularBounds`/
//! `IrregularPolygon` classes are, per `crate::domain`'s module doc comment,
//! ported as the *same* Rust types (`crate::domain::IrregularPoint` etc.) —
//! no separate `Internal*` structs exist in this crate. This module always
//! names them by their `crate::domain` names even when documenting the
//! `Internal*`-typed TS source function signature they port.
//!
//! `convexBounds.ts`'s `InternalPolygonWithBounds` has no existing
//! `crate::domain` counterpart (that module's scope excludes it), so
//! [`IrregularPolygonWithBounds`] is declared locally in this file.
//!
//! # Error-shape scope note
//!
//! Per `validation-spatial.md` §11, none of the four files ported here ever
//! construct `services.ts`'s `IrregularGeometryInputError` (`operation:
//! string, message: string`) themselves. Three of the four communicate
//! failure purely as data: `validateStrictBoundary` returns a `{ message:
//! string }` sentinel (ported below as
//! [`StrictConvexBoundaryValidation::Invalid`]), while `boundsForPoints` and
//! `translatePolygonWithBounds` return `undefined` (ported as `None`). It is
//! `placementValidation.ts` (a different, out-of-scope cluster file) that
//! later promotes a `{ message }` sentinel from `validateStrictBoundary` into
//! a thrown `IrregularGeometryInputError`, always hardcoding `operation:
//! 'validatePlacement'` regardless of which internal check failed — so the
//! `operation` half of that error's shape carries no information this
//! module's callers need to reproduce; only the `message` string is this
//! module's concern.

use crate::domain::{IrregularBounds, IrregularPoint, IrregularPolygon};
use crate::geometry::predicates;
use crate::js_number::js_math;

// ---------------------------------------------------------------------------
// Convex hull (convexHull.ts / core/convexHullCore.ts)
// ---------------------------------------------------------------------------

/// TS source: `core/convexHullCore.ts:5-16` (`computeConvexHull`), thinly
/// wrapped for domain objects by `convexHull.ts:15-18` (`ConvexHull.compute`
/// / ``function compute``). Because this crate does not separately model
/// `InternalPoint`/`InternalPolygon` from `IrregularPoint`/`IrregularPolygon`
/// (see module doc comment), a single function here plays both TS roles:
/// `convexHull.ts`'s wrapper does nothing but call `computeConvexHull` and
/// re-wrap the result in `new IrregularPolygon({ points: hull.points })`,
/// which is a no-op once the point/polygon types are already unified.
///
/// Wraps a finite point cloud in its smallest convex polygon using the
/// monotone chain algorithm. The input order is irrelevant: points are
/// sorted by `x` then `y` first, duplicate coordinates are removed exactly,
/// and the result follows the deterministic counter-clockwise boundary
/// convention (per `convexHull.ts:9-13`'s docstring).
///
/// Performs no finiteness validation of its own — matching
/// `core/convexHullCore.ts` exactly (no `Number.isFinite` guard anywhere in
/// the TS source); every current caller guarantees finite input before
/// calling (see `validation-spatial.md` §2's discussion of
/// `computeConvexHull`'s callers).
pub fn compute_convex_hull(points: &[IrregularPoint]) -> IrregularPolygon {
    // TS source: `core/convexHullCore.ts:6-9`.
    //
    // `left.x !== right.x ? left.x - right.x : left.y - right.y`. JS strict
    // inequality (`!==`) treats `-0` and `0` as equal, matching Rust's `f64`
    // `!=` operator exactly, so branching on `left.x != right.x` here (rather
    // than `left.x.total_cmp(&right.x) != Ordering::Equal`, which would treat
    // signed zero as distinct) reproduces the TS branch condition precisely.
    // `Array.prototype.sort` has been spec-guaranteed stable since ES2019;
    // `[T]::sort_by` is likewise stable, so tie order (irrelevant here, since
    // no field beyond `x`/`y` is observable on a point) matches regardless.
    let mut sorted_points: Vec<IrregularPoint> = points.to_vec();
    sorted_points.sort_by(|left, right| {
        if left.x != right.x {
            left.x
                .partial_cmp(&right.x)
                .expect("hull input coordinates are caller-guaranteed finite")
        } else {
            left.y
                .partial_cmp(&right.y)
                .expect("hull input coordinates are caller-guaranteed finite")
        }
    });

    let unique_points = deduplicate_sorted_points(&sorted_points);
    // TS source: `core/convexHullCore.ts:11`.
    if unique_points.len() <= 2 {
        return IrregularPolygon::new(unique_points);
    }

    // TS source: `core/convexHullCore.ts:13-15`.
    let lower_hull = build_hull_half(&unique_points);
    let reversed_points: Vec<IrregularPoint> = unique_points.iter().rev().copied().collect();
    let upper_hull = build_hull_half(&reversed_points);

    // `lowerHull.slice(0, -1)` / `upperHull.slice(0, -1)`: both halves always
    // contain at least one point (`buildHullHalf` pushes every input point at
    // least once), so `len() - 1` never underflows here; still write it via
    // the non-panicking form to keep this file's arithmetic checked
    // end-to-end rather than relying on that invariant silently.
    let lower_prefix_len = lower_hull.len().saturating_sub(1);
    let upper_prefix_len = upper_hull.len().saturating_sub(1);
    let mut hull_points = Vec::with_capacity(lower_prefix_len + upper_prefix_len);
    hull_points.extend_from_slice(&lower_hull[..lower_prefix_len]);
    hull_points.extend_from_slice(&upper_hull[..upper_prefix_len]);
    IrregularPolygon::new(hull_points)
}

/// TS source: `core/convexHullCore.ts:18-26` (`deduplicateSortedPoints`).
fn deduplicate_sorted_points(points: &[IrregularPoint]) -> Vec<IrregularPoint> {
    let mut unique_points: Vec<IrregularPoint> = Vec::with_capacity(points.len());
    for &point in points {
        // TS: `uniquePoints.at(-1)`; `previousPoint?.x === point.x &&
        // previousPoint.y === point.y`. JS `===` on `number` treats `-0`
        // and `0` as equal, matching Rust's `f64` `==` here exactly.
        if let Some(previous_point) = unique_points.last() {
            if previous_point.x == point.x && previous_point.y == point.y {
                continue;
            }
        }
        unique_points.push(point);
    }
    unique_points
}

/// TS source: `core/convexHullCore.ts:28-41` (`buildHullHalf`).
fn build_hull_half(points: &[IrregularPoint]) -> Vec<IrregularPoint> {
    let mut hull: Vec<IrregularPoint> = Vec::new();
    for &point in points {
        while hull.len() >= 2 {
            // TS: `hull.at(-2)`/`hull.at(-1)`, guarded by `if (previousPoint
            // === undefined || lastPoint === undefined) break` — unreachable
            // given the `hull.length >= 2` loop condition (both indices are
            // always in bounds), so this Rust port has no equivalent guard to
            // express; see the same pattern already established in
            // `canonical_grid::math::canonical_grid_convex_hull`.
            let previous_point = hull[hull.len() - 2];
            let last_point = hull[hull.len() - 1];
            if orientation_of(previous_point, last_point, point) > 0 {
                break;
            }
            hull.pop();
        }
        hull.push(point);
    }
    hull
}

// ---------------------------------------------------------------------------
// Bounds (convexBounds.ts)
// ---------------------------------------------------------------------------

/// TS source: `convexBounds.ts:34-73` (`translatePolygonWithBounds`)'s return
/// shape, `InternalPolygonWithBounds` (`internalGeometry.ts:16-19`). Not
/// re-exported from `crate::domain` (out of that module's scope), so it is
/// declared locally here.
#[derive(Clone, Debug, PartialEq)]
pub struct IrregularPolygonWithBounds {
    pub polygon: IrregularPolygon,
    pub bounds: IrregularBounds,
}

/// TS source: `convexBounds.ts:8-32` (`boundsForPoints`).
///
/// Computes the tightest axis-aligned bounds containing every point, or
/// `None` if the point list is empty or any coordinate is non-finite —
/// mirroring TS's `undefined` return in both cases exactly (`convexBounds.ts:11-13,22-24`).
pub fn bounds_for_points(points: &[IrregularPoint]) -> Option<IrregularBounds> {
    let first_point = points.first()?;
    if !first_point.x.is_finite() || !first_point.y.is_finite() {
        return None;
    }

    let mut min_x = first_point.x;
    let mut min_y = first_point.y;
    let mut max_x = first_point.x;
    let mut max_y = first_point.y;

    for point in &points[1..] {
        if !point.x.is_finite() || !point.y.is_finite() {
            return None;
        }
        // TS: `Math.min`/`Math.max`. Rust's `f64::min`/`f64::max` do **not**
        // reliably match JS's signed-zero tie-break (`Math.min(+0,-0) ===
        // -0`, `Math.max(+0,-0) === +0`): `f64::min`/`f64::max` delegate to
        // LLVM's `minnum`/`maxnum` intrinsics, whose choice of which zero to
        // return when the two operands are `+0.0`/`-0.0` is documented as
        // unspecified and has been observed to differ between debug and
        // release builds for this exact crate. `js_number::js_math::min`/
        // `max` reproduce ECMA-262 `Math.min`/`Math.max` exactly (see that
        // module's doc comments); every `Math.min`/`Math.max` call site in
        // this crate must route through them, never through the bare `f64`
        // method.
        min_x = js_math::min(min_x, point.x);
        min_y = js_math::min(min_y, point.y);
        max_x = js_math::max(max_x, point.x);
        max_y = js_math::max(max_y, point.y);
    }

    make_bounds(min_x, min_y, max_x, max_y)
}

/// TS source: `convexBounds.ts:34-73` (`translatePolygonWithBounds`).
///
/// Translates every vertex of `polygon` by `translation` and returns the
/// translated ring together with its bounds, or `None` if `polygon` is empty,
/// any translated coordinate is non-finite, or the resulting bounds are
/// degenerate per [`make_bounds`] — mirroring TS's `undefined` returns at
/// `convexBounds.ts:39,43,57,67` exactly.
pub fn translate_polygon_with_bounds(
    polygon: &IrregularPolygon,
    translation: IrregularPoint,
) -> Option<IrregularPolygonWithBounds> {
    let first_point = polygon.points.first()?;

    let first_x = first_point.x + translation.x;
    let first_y = first_point.y + translation.y;
    if !first_x.is_finite() || !first_y.is_finite() {
        return None;
    }

    let mut translated_points: Vec<IrregularPoint> = Vec::with_capacity(polygon.points.len());
    translated_points.push(IrregularPoint::new(first_x, first_y));
    let mut min_x = first_x;
    let mut min_y = first_y;
    let mut max_x = first_x;
    let mut max_y = first_y;

    for point in &polygon.points[1..] {
        let x = point.x + translation.x;
        let y = point.y + translation.y;
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        translated_points.push(IrregularPoint::new(x, y));
        // See `bounds_for_points`'s doc comment for why `Math.min`/`Math.max`
        // must route through `js_math::min`/`max`, not `f64::min`/`f64::max`.
        min_x = js_math::min(min_x, x);
        min_y = js_math::min(min_y, y);
        max_x = js_math::max(max_x, x);
        max_y = js_math::max(max_y, y);
    }

    let bounds = make_bounds(min_x, min_y, max_x, max_y)?;

    Some(IrregularPolygonWithBounds {
        polygon: IrregularPolygon::new(translated_points),
        bounds,
    })
}

/// TS source: `convexBounds.ts:75-82` (`areDisjoint`).
///
/// A strict-separation broad-phase test: `true` only when the two bounds
/// boxes do not touch or overlap on at least one axis (strict `<`, so
/// exactly-touching boxes are *not* disjoint).
pub fn are_disjoint(first: &IrregularBounds, second: &IrregularBounds) -> bool {
    first.max_x < second.min_x
        || second.max_x < first.min_x
        || first.max_y < second.min_y
        || second.max_y < first.min_y
}

/// TS source: `convexBounds.ts:84-102` (`makeBounds`).
fn make_bounds(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Option<IrregularBounds> {
    if !min_x.is_finite()
        || !min_y.is_finite()
        || !max_x.is_finite()
        || !max_y.is_finite()
        || min_x > max_x
        || min_y > max_y
    {
        return None;
    }
    Some(IrregularBounds::new(min_x, min_y, max_x, max_y))
}

// ---------------------------------------------------------------------------
// Strict-convex boundary validation (convexPolygonValidation.ts)
// ---------------------------------------------------------------------------

/// TS source: `convexPolygonValidation.ts:13` (`ConvexPolygonWinding`).
/// Winding sign shared by every non-collinear turn in a validated y-up ring:
/// `1` is counter-clockwise, `-1` is clockwise. Never `0` — a validated ring
/// always has a determined, non-zero, consistent winding. Kept as a plain
/// `i32` (not a two-variant enum) to match this crate's existing convention
/// for the same `-1 | 1 | 0`-shaped TS union in
/// `geometry::predicates::Orientation`.
pub type ConvexPolygonWinding = i32;

/// TS source: `convexPolygonValidation.ts:15-33`
/// (`StrictConvexBoundaryValidation`, the union of `ValidStrictConvexBoundary`
/// and `InvalidStrictConvexBoundary`). See the module doc comment's
/// "Error-shape scope note" for why this carries only `message`, not the full
/// `IrregularGeometryInputError { operation, message }` shape.
#[derive(Clone, Debug, PartialEq)]
pub enum StrictConvexBoundaryValidation {
    /// TS: `{ readonly winding: ConvexPolygonWinding }`.
    Valid { winding: ConvexPolygonWinding },
    /// TS: `{ readonly message: string }`.
    Invalid { message: String },
}

impl StrictConvexBoundaryValidation {
    /// Convenience accessor mirroring the TS callers' `'winding' in result`
    /// discriminant test.
    pub fn winding(&self) -> Option<ConvexPolygonWinding> {
        match self {
            StrictConvexBoundaryValidation::Valid { winding } => Some(*winding),
            StrictConvexBoundaryValidation::Invalid { .. } => None,
        }
    }

    /// Convenience accessor mirroring the TS callers' `'message' in result`
    /// discriminant test.
    pub fn message(&self) -> Option<&str> {
        match self {
            StrictConvexBoundaryValidation::Valid { .. } => None,
            StrictConvexBoundaryValidation::Invalid { message } => Some(message.as_str()),
        }
    }
}

fn invalid(message: impl Into<String>) -> StrictConvexBoundaryValidation {
    StrictConvexBoundaryValidation::Invalid {
        message: message.into(),
    }
}

/// One directed edge of the ordered, implicitly closed input ring.
///
/// TS source: `convexPolygonValidation.ts:23-27` (`BoundaryEdge`).
#[derive(Clone, Copy, Debug)]
struct BoundaryEdge {
    start: IrregularPoint,
    end: IrregularPoint,
}

/// TS source: `convexPolygonValidation.ts:60-116` (`validateStrictBoundary`).
///
/// Validates the geometric invariant shared by every v2 collision polygon: at
/// least three finite vertices that form a simple ring and turn consistently
/// around a strictly convex boundary.
///
/// `points` are ordered vertices in the app's DXF y-up coordinate system; the
/// final edge from the last point to the first is implicit. Returns
/// `Valid { winding }` for a valid ring, where the sign is shared by every
/// turn, or `Invalid { message }` describing the rejected invariant.
///
/// Diagnostic precedence (checked in this exact order, first failure wins,
/// per `validation-spatial.md` §6): (1) vertex count `< 3`; (2) any
/// non-finite coordinate; (3) any repeated adjacent vertex (exact equality,
/// no tolerance); (4) simple-ring self-intersection (guarded linear-topology
/// decision or the quadratic edge sweep — see [`supports_linear_topology_decision`]);
/// (5) turn-scan failures (collinear vertex / inconsistent winding); (6) zero
/// total winding. Note the TS source's own comment at
/// `convexPolygonValidation.ts:96` ("the turn scan runs first, but crossing
/// diagnostics still take precedence"): `scanTurns` is *computed* before the
/// self-intersection check in program order, but its failure message is only
/// *returned* after the self-intersection check has already passed, so a ring
/// that both self-intersects and has an inconsistent-winding turn always
/// reports the self-intersection message, never the turn message — pinned by
/// `tests/unit/convexPolygonValidationTopology.test.ts:337-350`.
pub fn validate_strict_boundary(points: &[IrregularPoint]) -> StrictConvexBoundaryValidation {
    // TS: `convexPolygonValidation.ts:63-65`.
    if points.len() < 3 {
        return invalid("polygon must contain at least three vertices.");
    }

    // TS: `convexPolygonValidation.ts:67-78`. The TS loop also checks `point
    // === undefined`, unreachable here for an in-bounds Rust slice index (a
    // `noUncheckedIndexedAccess`-only artifact of the TS type system, not a
    // real runtime branch); see the module doc comment's type-unification
    // section for the general convention.
    for point in points {
        if !point.x.is_finite() || !point.y.is_finite() {
            return invalid("polygon coordinates must be finite.");
        }
    }

    // TS: `convexPolygonValidation.ts:80-94`.
    let len = points.len();
    let mut edges: Vec<BoundaryEdge> = Vec::with_capacity(len);
    for index in 0..len {
        let start = points[index];
        let end = points[(index + 1) % len];
        if start.x == end.x && start.y == end.y {
            return invalid("polygon must not repeat adjacent vertices.");
        }
        edges.push(BoundaryEdge { start, end });
    }

    // TS: `convexPolygonValidation.ts:96-97` — "the turn scan runs first, but
    // crossing diagnostics still take precedence."
    let turn_scan = scan_turns(points);

    // TS: `convexPolygonValidation.ts:99-104`.
    let self_intersects =
        if turn_scan.failure.is_none() && supports_linear_topology_decision(points) {
            !completes_one_revolution(&edges)
        } else {
            has_self_intersection(&edges)
        };
    if self_intersects {
        return invalid("polygon must form a simple ring without self-intersections.");
    }

    // TS: `convexPolygonValidation.ts:109`.
    if let Some(failure) = turn_scan.failure {
        return invalid(failure);
    }

    // TS: `convexPolygonValidation.ts:111-115`.
    match turn_scan.winding {
        Some(winding) => StrictConvexBoundaryValidation::Valid { winding },
        None => invalid("polygon must have a non-zero area."),
    }
}

/// IEEE-754 safety envelope for the linear topology shortcut.
///
/// TS source: `convexPolygonValidation.ts:126-127`
/// (`MIN_LINEAR_TOPOLOGY_NON_ZERO_COORDINATE = 2 ** -450`,
/// `MAX_LINEAR_TOPOLOGY_COORDINATE = 2 ** 500`). Both bounds are exactly
/// representable normal `f64` values (`2^-450` is well above the subnormal
/// boundary `2^-1074`; `2^500` is well below overflow at `2^1024`), so they
/// are constructed here from their exact IEEE-754 bit patterns (biased
/// exponent, zero mantissa) rather than via a floating-point power function,
/// to make the exactness auditable independent of `f64::powi`'s own
/// correctness and to allow evaluation in a `const` context.
const MIN_LINEAR_TOPOLOGY_NON_ZERO_COORDINATE: f64 = f64::from_bits((1023u64 - 450) << 52);
const MAX_LINEAR_TOPOLOGY_COORDINATE: f64 = f64::from_bits((1023u64 + 500) << 52);

/// TS source: `convexPolygonValidation.ts:129-141` (`supportsLinearTopologyDecision`).
fn supports_linear_topology_decision(points: &[IrregularPoint]) -> bool {
    points.iter().all(|point| {
        coordinate_supports_linear_topology(point.x) && coordinate_supports_linear_topology(point.y)
    })
}

/// TS source: `convexPolygonValidation.ts:143-150` (`coordinateSupportsLinearTopology`).
fn coordinate_supports_linear_topology(value: f64) -> bool {
    let magnitude = value.abs();
    magnitude == 0.0
        || (MIN_LINEAR_TOPOLOGY_NON_ZERO_COORDINATE..=MAX_LINEAR_TOPOLOGY_COORDINATE)
            .contains(&magnitude)
}

/// TS source: `convexPolygonValidation.ts:152-155` (`TurnScan`).
struct TurnScan {
    winding: Option<ConvexPolygonWinding>,
    failure: Option<String>,
}

/// TS source: `convexPolygonValidation.ts:161-188` (`scanTurns`).
///
/// Walks the corners in input order and stops at the first one that fails,
/// reporting the message the caller would have returned there.
fn scan_turns(points: &[IrregularPoint]) -> TurnScan {
    let mut winding: Option<ConvexPolygonWinding> = None;
    let len = points.len();
    for index in 0..len {
        // TS: `(index - 1 + points.length) % points.length`; rewritten with
        // an equivalent unsigned-safe form since Rust's `%` on `usize` cannot
        // take the TS expression's (never-actually-negative, but
        // signed-typed) intermediate directly. `index + len - 1` never
        // underflows here since `len >= 3` (checked by the caller before
        // `scanTurns` is ever reached) and `index < len`.
        let previous = points[(index + len - 1) % len];
        let current = points[index];
        let next = points[(index + 1) % len];

        // robust orientation keeps the winding decision independent of
        // rounded determinants (TS comment, `convexPolygonValidation.ts:172`).
        let turn = orientation_of(previous, current, next);
        if turn == 0 {
            return TurnScan {
                winding,
                failure: Some("polygon must not contain collinear vertices.".to_string()),
            };
        }

        match winding {
            None => winding = Some(turn),
            Some(established_winding) if turn != established_winding => {
                return TurnScan {
                    winding,
                    failure: Some(
                        "polygon must be strictly convex with one consistent winding.".to_string(),
                    ),
                };
            }
            Some(_) => {}
        }
    }
    TurnScan {
        winding,
        failure: None,
    }
}

/// TS source: `convexPolygonValidation.ts:204-216` (`completesOneRevolution`).
///
/// Decides the simple-ring question for a ring whose corners all turn the
/// same non-zero way, by counting how often the edge direction stops
/// pointing downwards; a simple (non-star) ring completes exactly one such
/// revolution.
fn completes_one_revolution(edges: &[BoundaryEdge]) -> bool {
    let mut revolutions: i32 = 0;
    let len = edges.len();
    for index in 0..len {
        let edge = &edges[index];
        let next_edge = &edges[(index + 1) % len];
        let points_downwards = edge.end.y < edge.start.y;
        let next_points_downwards = next_edge.end.y < next_edge.start.y;
        if points_downwards && !next_points_downwards {
            revolutions += 1;
        }
    }
    revolutions == 1
}

/// TS source: `convexPolygonValidation.ts:229-249` (`hasSelfIntersection`).
///
/// Tests whether non-adjacent edges of an ordered cyclic ring intersect.
/// Adjacent edges are skipped because their shared endpoint is required by
/// the ring topology; the turn and adjacent-vertex checks validate that
/// connection separately.
fn has_self_intersection(edges: &[BoundaryEdge]) -> bool {
    let len = edges.len();
    for (first_edge_index, first_edge) in edges.iter().enumerate() {
        for (second_edge_index, second_edge) in edges.iter().enumerate().skip(first_edge_index + 1)
        {
            if are_adjacent_edges(first_edge_index, second_edge_index, len) {
                continue;
            }
            if segments_intersect(first_edge, second_edge) {
                return true;
            }
        }
    }
    false
}

/// TS source: `convexPolygonValidation.ts:259-268` (`areAdjacentEdges`).
fn are_adjacent_edges(
    first_edge_index: usize,
    second_edge_index: usize,
    edge_count: usize,
) -> bool {
    second_edge_index == first_edge_index + 1
        || (first_edge_index == 0 && second_edge_index == edge_count - 1)
}

/// TS source: `convexPolygonValidation.ts:282-296` (`segmentsIntersect`).
///
/// Classifies two finite line segments using robust orientations. Returns
/// `true` for a proper crossing or any endpoint/collinear overlap; this
/// treats touching as an intersection, which is required for a simple ring.
fn segments_intersect(first: &BoundaryEdge, second: &BoundaryEdge) -> bool {
    let first_start_turn = orientation_of(first.start, first.end, second.start);
    let first_end_turn = orientation_of(first.start, first.end, second.end);
    let second_start_turn = orientation_of(second.start, second.end, first.start);
    let second_end_turn = orientation_of(second.start, second.end, first.end);

    // robust orientation identifies collinearity; coordinate bounds decide
    // whether the collinear point is actually on the finite segment (TS
    // comment, `convexPolygonValidation.ts:288-289`).
    if first_start_turn == 0 && point_is_on_segment(second.start, first) {
        return true;
    }
    if first_end_turn == 0 && point_is_on_segment(second.end, first) {
        return true;
    }
    if second_start_turn == 0 && point_is_on_segment(first.start, second) {
        return true;
    }
    if second_end_turn == 0 && point_is_on_segment(first.end, second) {
        return true;
    }

    first_start_turn != first_end_turn && second_start_turn != second_end_turn
}

/// TS source: `convexPolygonValidation.ts:307-314` (`pointIsOnSegment`).
///
/// Checks whether a collinear point lies within a segment's closed bounds
/// (inclusive on both ends, preserving the simple-ring rule that endpoint
/// touches count as intersections).
fn point_is_on_segment(point: IrregularPoint, segment: &BoundaryEdge) -> bool {
    // TS: `Math.min`/`Math.max` — see `bounds_for_points`'s doc comment for
    // why this must route through `js_math::min`/`max`, not `f64::min`/`max`.
    // (A signed-zero divergence here would only ever flip an inclusive-bound
    // comparison at exactly `x`/`y == 0.0`, but the crate-wide rule is to
    // route every `Math.min`/`Math.max` call site through the shared helper
    // unconditionally rather than argue per-callsite that a divergence is
    // provably unobservable.)
    point.x >= js_math::min(segment.start.x, segment.end.x)
        && point.x <= js_math::max(segment.start.x, segment.end.x)
        && point.y >= js_math::min(segment.start.y, segment.end.y)
        && point.y <= js_math::max(segment.start.y, segment.end.y)
}

/// Shared helper: applies `geometry::predicates::orientation` to three
/// [`IrregularPoint`]s. TS source: every call site of
/// `GeometryPredicates.orientation` in `core/convexHullCore.ts` and
/// `convexPolygonValidation.ts`.
fn orientation_of(origin: IrregularPoint, first: IrregularPoint, second: IrregularPoint) -> i32 {
    predicates::orientation(origin.x, origin.y, first.x, first.y, second.x, second.y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    // -----------------------------------------------------------------
    // compute_convex_hull
    // -----------------------------------------------------------------

    #[test]
    fn hull_of_empty_input_is_empty() {
        let hull = compute_convex_hull(&[]);
        assert_eq!(hull.points, Vec::<IrregularPoint>::new());
    }

    #[test]
    fn hull_of_one_point_is_that_point() {
        let hull = compute_convex_hull(&[p(3.0, 4.0)]);
        assert_eq!(hull.points, vec![p(3.0, 4.0)]);
    }

    #[test]
    fn hull_of_two_points_is_sorted_pair() {
        let hull = compute_convex_hull(&[p(5.0, 0.0), p(1.0, 2.0)]);
        assert_eq!(hull.points, vec![p(1.0, 2.0), p(5.0, 0.0)]);
    }

    #[test]
    fn hull_deduplicates_exact_coordinate_repeats() {
        let hull = compute_convex_hull(&[p(0.0, 0.0), p(0.0, 0.0), p(1.0, 1.0), p(1.0, 1.0)]);
        assert_eq!(hull.points, vec![p(0.0, 0.0), p(1.0, 1.0)]);
    }

    #[test]
    fn hull_of_square_is_ccw_from_bottom_left() {
        // A unit square with an interior point that must be discarded.
        let points = [
            p(0.0, 0.0),
            p(10.0, 0.0),
            p(10.0, 10.0),
            p(0.0, 10.0),
            p(5.0, 5.0),
        ];
        let hull = compute_convex_hull(&points);
        assert_eq!(
            hull.points,
            vec![p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)]
        );
    }

    #[test]
    fn hull_drops_collinear_points_on_an_edge() {
        let points = [
            p(0.0, 0.0),
            p(5.0, 0.0),
            p(10.0, 0.0),
            p(10.0, 10.0),
            p(0.0, 10.0),
        ];
        let hull = compute_convex_hull(&points);
        assert_eq!(
            hull.points,
            vec![p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)]
        );
    }

    #[test]
    fn hull_of_collinear_points_only_is_the_two_extremes() {
        let points = [p(0.0, 0.0), p(1.0, 1.0), p(2.0, 2.0), p(3.0, 3.0)];
        let hull = compute_convex_hull(&points);
        assert_eq!(hull.points, vec![p(0.0, 0.0), p(3.0, 3.0)]);
    }

    #[test]
    fn hull_sort_treats_negative_zero_and_zero_x_as_equal() {
        // Same x under strict equality (`-0 === 0`); ties break on y.
        let points = [p(-0.0, 1.0), p(0.0, -1.0)];
        let hull = compute_convex_hull(&points);
        assert_eq!(hull.points, vec![p(0.0, -1.0), p(-0.0, 1.0)]);
    }

    // -----------------------------------------------------------------
    // bounds_for_points
    // -----------------------------------------------------------------

    #[test]
    fn bounds_for_points_empty_is_none() {
        assert_eq!(bounds_for_points(&[]), None);
    }

    #[test]
    fn bounds_for_points_single_point_is_degenerate_bounds() {
        let bounds = bounds_for_points(&[p(3.0, -4.0)]).expect("finite single point");
        assert_eq!(bounds, IrregularBounds::new(3.0, -4.0, 3.0, -4.0));
    }

    #[test]
    fn bounds_for_points_rejects_non_finite_first_point() {
        assert_eq!(bounds_for_points(&[p(f64::NAN, 0.0)]), None);
        assert_eq!(bounds_for_points(&[p(0.0, f64::INFINITY)]), None);
    }

    #[test]
    fn bounds_for_points_rejects_non_finite_later_point() {
        assert_eq!(bounds_for_points(&[p(0.0, 0.0), p(f64::NAN, 0.0)]), None);
    }

    #[test]
    fn bounds_for_points_computes_tight_box() {
        let bounds =
            bounds_for_points(&[p(2.0, -3.0), p(-1.0, 5.0), p(4.0, 1.0)]).expect("finite points");
        assert_eq!(bounds, IrregularBounds::new(-1.0, -3.0, 4.0, 5.0));
    }

    // -----------------------------------------------------------------
    // translate_polygon_with_bounds
    // -----------------------------------------------------------------

    #[test]
    fn translate_polygon_with_bounds_empty_polygon_is_none() {
        let polygon = IrregularPolygon::new(vec![]);
        assert_eq!(translate_polygon_with_bounds(&polygon, p(1.0, 1.0)), None);
    }

    #[test]
    fn translate_polygon_with_bounds_rejects_non_finite_translation() {
        let polygon = IrregularPolygon::new(vec![p(0.0, 0.0), p(1.0, 1.0)]);
        assert_eq!(
            translate_polygon_with_bounds(&polygon, p(f64::INFINITY, 0.0)),
            None
        );
    }

    #[test]
    fn translate_polygon_with_bounds_translates_and_rebounds() {
        let polygon =
            IrregularPolygon::new(vec![p(0.0, 0.0), p(2.0, 0.0), p(2.0, 2.0), p(0.0, 2.0)]);
        let result =
            translate_polygon_with_bounds(&polygon, p(10.0, -5.0)).expect("finite translation");
        assert_eq!(
            result.polygon.points,
            vec![p(10.0, -5.0), p(12.0, -5.0), p(12.0, -3.0), p(10.0, -3.0)]
        );
        assert_eq!(result.bounds, IrregularBounds::new(10.0, -5.0, 12.0, -3.0));
    }

    // -----------------------------------------------------------------
    // are_disjoint
    // -----------------------------------------------------------------

    #[test]
    fn are_disjoint_true_when_strictly_separated_on_x() {
        let a = IrregularBounds::new(0.0, 0.0, 1.0, 1.0);
        let b = IrregularBounds::new(2.0, 0.0, 3.0, 1.0);
        assert!(are_disjoint(&a, &b));
        assert!(are_disjoint(&b, &a));
    }

    #[test]
    fn are_disjoint_false_when_exactly_touching() {
        let a = IrregularBounds::new(0.0, 0.0, 1.0, 1.0);
        let b = IrregularBounds::new(1.0, 0.0, 2.0, 1.0);
        assert!(!are_disjoint(&a, &b));
    }

    #[test]
    fn are_disjoint_false_when_overlapping() {
        let a = IrregularBounds::new(0.0, 0.0, 2.0, 2.0);
        let b = IrregularBounds::new(1.0, 1.0, 3.0, 3.0);
        assert!(!are_disjoint(&a, &b));
    }

    // -----------------------------------------------------------------
    // validate_strict_boundary
    // -----------------------------------------------------------------

    fn square() -> Vec<IrregularPoint> {
        vec![p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)]
    }

    #[test]
    fn rejects_fewer_than_three_vertices() {
        let result = validate_strict_boundary(&[p(0.0, 0.0), p(1.0, 1.0)]);
        assert_eq!(
            result,
            invalid("polygon must contain at least three vertices.")
        );
    }

    #[test]
    fn rejects_non_finite_coordinate() {
        let mut points = square();
        points[1] = p(f64::NAN, 0.0);
        let result = validate_strict_boundary(&points);
        assert_eq!(result, invalid("polygon coordinates must be finite."));
    }

    #[test]
    fn rejects_repeated_adjacent_vertex() {
        let points = vec![p(0.0, 0.0), p(0.0, 0.0), p(10.0, 10.0)];
        let result = validate_strict_boundary(&points);
        assert_eq!(
            result,
            invalid("polygon must not repeat adjacent vertices.")
        );
    }

    #[test]
    fn rejects_collinear_vertex() {
        let points = vec![
            p(0.0, 0.0),
            p(5.0, 0.0),
            p(10.0, 0.0),
            p(10.0, 10.0),
            p(0.0, 10.0),
        ];
        let result = validate_strict_boundary(&points);
        assert_eq!(
            result,
            invalid("polygon must not contain collinear vertices.")
        );
    }

    #[test]
    fn rejects_inconsistent_winding() {
        // A non-convex "dart"/arrow shape: consistent CCW turns except one.
        let points = vec![
            p(0.0, 0.0),
            p(10.0, 0.0),
            p(5.0, 3.0),
            p(10.0, 10.0),
            p(0.0, 10.0),
        ];
        let result = validate_strict_boundary(&points);
        assert_eq!(
            result,
            invalid("polygon must be strictly convex with one consistent winding.")
        );
    }

    #[test]
    fn accepts_ccw_square_with_positive_winding() {
        let result = validate_strict_boundary(&square());
        assert_eq!(result, StrictConvexBoundaryValidation::Valid { winding: 1 });
    }

    #[test]
    fn accepts_cw_square_with_negative_winding() {
        let mut points = square();
        points.reverse();
        let result = validate_strict_boundary(&points);
        assert_eq!(
            result,
            StrictConvexBoundaryValidation::Valid { winding: -1 }
        );
    }

    #[test]
    fn rejects_self_intersecting_bowtie_ahead_of_its_turn_failure() {
        // Exact fixture from
        // `tests/unit/convexPolygonValidationTopology.test.ts:339-352`
        // ("reports a crossing ahead of the turn failure it also has"): a
        // bowtie crosses itself and is not convex; the crossing message wins.
        let points = vec![p(0.0, 0.0), p(10.0, 10.0), p(10.0, 0.0), p(0.0, 10.0)];
        let result = validate_strict_boundary(&points);
        assert_eq!(
            result,
            invalid("polygon must form a simple ring without self-intersections.")
        );
    }

    #[test]
    fn linear_topology_envelope_bounds_are_exact_powers_of_two() {
        assert_eq!(MIN_LINEAR_TOPOLOGY_NON_ZERO_COORDINATE, 2f64.powi(-450));
        assert_eq!(MAX_LINEAR_TOPOLOGY_COORDINATE, 2f64.powi(500));
    }

    #[test]
    fn coordinate_supports_linear_topology_admits_zero() {
        assert!(coordinate_supports_linear_topology(0.0));
        assert!(coordinate_supports_linear_topology(-0.0));
    }

    #[test]
    fn coordinate_supports_linear_topology_boundary_inclusive() {
        assert!(coordinate_supports_linear_topology(
            MIN_LINEAR_TOPOLOGY_NON_ZERO_COORDINATE
        ));
        assert!(coordinate_supports_linear_topology(
            MAX_LINEAR_TOPOLOGY_COORDINATE
        ));
    }

    #[test]
    fn coordinate_supports_linear_topology_rejects_outside_envelope() {
        assert!(!coordinate_supports_linear_topology(
            MIN_LINEAR_TOPOLOGY_NON_ZERO_COORDINATE / 2.0
        ));
        assert!(!coordinate_supports_linear_topology(
            MAX_LINEAR_TOPOLOGY_COORDINATE * 2.0
        ));
    }

    #[test]
    fn validates_a_ring_with_coordinates_outside_the_linear_topology_envelope() {
        // Forces the quadratic `hasSelfIntersection` fallback path (envelope
        // guard fails) rather than `completesOneRevolution`, and must still
        // agree the simple square is valid.
        let huge = MAX_LINEAR_TOPOLOGY_COORDINATE * 4.0;
        let points = vec![p(0.0, 0.0), p(huge, 0.0), p(huge, huge), p(0.0, huge)];
        let result = validate_strict_boundary(&points);
        assert_eq!(result, StrictConvexBoundaryValidation::Valid { winding: 1 });
    }

    #[test]
    fn strict_convex_boundary_validation_accessors() {
        let valid = StrictConvexBoundaryValidation::Valid { winding: 1 };
        assert_eq!(valid.winding(), Some(1));
        assert_eq!(valid.message(), None);

        let bad = invalid("x");
        assert_eq!(bad.winding(), None);
        assert_eq!(bad.message(), Some("x"));
    }
}
