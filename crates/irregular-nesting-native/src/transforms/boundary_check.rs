//! Scoped local port of `src/workers/irregular/convexPolygonValidation.ts`'s
//! `ConvexPolygonValidation.validateStrictBoundary` (full TS file:
//! `convexPolygonValidation.ts:1-314`), needed as a precondition check by
//! `super::generator::generate_transforms` (`transformGenerator.ts:76-79`).
//!
//! See `super`'s module doc for why this lives here privately rather than as
//! a crate-public `crate::validation` export, and why the guarded
//! "linear ring topology" fast path is intentionally omitted in favor of
//! always running the reference `O(n^2)` sweep.

use crate::domain::IrregularPoint;
use crate::geometry::predicates::orientation;
use crate::js_number::js_math;

/// TS: `convexPolygonValidation.ts:9-13` `ConvexPolygonWinding` (`-1 | 1`).
pub type Winding = i32;

/// TS: `convexPolygonValidation.ts:29-32`/`34` — the validator's result: a
/// valid ring reports `winding`, an invalid one reports only `message`.
pub enum BoundaryValidation {
    // `winding` is kept for structural parity with the TS return shape (other,
    // not-yet-ported `ConvexPolygonValidation.validateStrictBoundary` call
    // sites, e.g. `placementValidation.ts`/`placedCollisionSpatialIndex.ts`,
    // do consume it) even though `generator::generate_transforms`'s own call
    // site discards it exactly like `transformGenerator.ts:76-79` does
    // (`if ('message' in validation)` never reads `validation.winding`).
    #[allow(dead_code)]
    Valid {
        winding: Winding,
    },
    Invalid {
        message: String,
    },
}

/// One directed edge of the ordered, implicitly closed input ring.
/// TS: `convexPolygonValidation.ts:23-27` `BoundaryEdge`.
type BoundaryEdge = (IrregularPoint, IrregularPoint);

/// TS: `convexPolygonValidation.ts:60-118` `validateStrictBoundary`.
pub(crate) fn validate_strict_boundary(points: &[IrregularPoint]) -> BoundaryValidation {
    if points.len() < 3 {
        return BoundaryValidation::Invalid {
            message: "polygon must contain at least three vertices.".to_string(),
        };
    }

    for point in points {
        if !point.x.is_finite() || !point.y.is_finite() {
            return BoundaryValidation::Invalid {
                message: "polygon coordinates must be finite.".to_string(),
            };
        }
    }

    let n = points.len();
    let mut edges: Vec<BoundaryEdge> = Vec::with_capacity(n);
    for index in 0..n {
        let start = points[index];
        let end = points[(index + 1) % n];
        if start.x == end.x && start.y == end.y {
            return BoundaryValidation::Invalid {
                message: "polygon must not repeat adjacent vertices.".to_string(),
            };
        }
        edges.push((start, end));
    }

    // TS: `convexPolygonValidation.ts:97-104`. The real production code
    // guards `hasSelfIntersection` behind a linear-topology fast path; this
    // port always takes the reference `O(n^2)` branch (see module doc for
    // why that is behaviorally exact, not an approximation).
    let turn_scan = scan_turns(points);
    let self_intersects = has_self_intersection(&edges);
    if self_intersects {
        return BoundaryValidation::Invalid {
            message: "polygon must form a simple ring without self-intersections.".to_string(),
        };
    }

    if let Some(message) = turn_scan.failure {
        return BoundaryValidation::Invalid { message };
    }

    match turn_scan.winding {
        Some(winding) => BoundaryValidation::Valid { winding },
        None => BoundaryValidation::Invalid {
            message: "polygon must have a non-zero area.".to_string(),
        },
    }
}

struct TurnScan {
    winding: Option<Winding>,
    failure: Option<String>,
}

/// TS: `convexPolygonValidation.ts:159-188` `scanTurns`.
fn scan_turns(points: &[IrregularPoint]) -> TurnScan {
    let n = points.len();
    let mut winding: Option<Winding> = None;
    for index in 0..n {
        let previous = points[(index + n - 1) % n];
        let current = points[index];
        let next = points[(index + 1) % n];

        let turn = orientation(previous.x, previous.y, current.x, current.y, next.x, next.y);
        if turn == 0 {
            return TurnScan {
                winding,
                failure: Some("polygon must not contain collinear vertices.".to_string()),
            };
        }

        match winding {
            None => winding = Some(turn),
            Some(existing) if turn != existing => {
                return TurnScan {
                    winding,
                    failure: Some(
                        "polygon must be strictly convex with one consistent winding.".to_string(),
                    ),
                };
            }
            _ => {}
        }
    }
    TurnScan {
        winding,
        failure: None,
    }
}

/// TS: `convexPolygonValidation.ts:219-238` `hasSelfIntersection` — the
/// reference quadratic non-adjacent-edge sweep (see module doc: this port
/// always uses this branch, never the guarded linear-topology shortcut).
fn has_self_intersection(edges: &[BoundaryEdge]) -> bool {
    let n = edges.len();
    for first_index in 0..n {
        for second_index in (first_index + 1)..n {
            if are_adjacent_edges(first_index, second_index, n) {
                continue;
            }
            if segments_intersect(edges[first_index], edges[second_index]) {
                return true;
            }
        }
    }
    false
}

/// TS: `convexPolygonValidation.ts:247-256` `areAdjacentEdges`.
fn are_adjacent_edges(
    first_edge_index: usize,
    second_edge_index: usize,
    edge_count: usize,
) -> bool {
    second_edge_index == first_edge_index + 1
        || (first_edge_index == 0 && second_edge_index == edge_count - 1)
}

/// TS: `convexPolygonValidation.ts:271-283` `segmentsIntersect`.
fn segments_intersect(first: BoundaryEdge, second: BoundaryEdge) -> bool {
    let (first_start, first_end) = first;
    let (second_start, second_end) = second;

    let first_start_turn = orientation(
        first_start.x,
        first_start.y,
        first_end.x,
        first_end.y,
        second_start.x,
        second_start.y,
    );
    let first_end_turn = orientation(
        first_start.x,
        first_start.y,
        first_end.x,
        first_end.y,
        second_end.x,
        second_end.y,
    );
    let second_start_turn = orientation(
        second_start.x,
        second_start.y,
        second_end.x,
        second_end.y,
        first_start.x,
        first_start.y,
    );
    let second_end_turn = orientation(
        second_start.x,
        second_start.y,
        second_end.x,
        second_end.y,
        first_end.x,
        first_end.y,
    );

    if first_start_turn == 0 && point_is_on_segment(second_start, first) {
        return true;
    }
    if first_end_turn == 0 && point_is_on_segment(second_end, first) {
        return true;
    }
    if second_start_turn == 0 && point_is_on_segment(first_start, second) {
        return true;
    }
    if second_end_turn == 0 && point_is_on_segment(first_end, second) {
        return true;
    }

    first_start_turn != first_end_turn && second_start_turn != second_end_turn
}

/// TS: `convexPolygonValidation.ts:296-303` `pointIsOnSegment`.
fn point_is_on_segment(point: IrregularPoint, segment: BoundaryEdge) -> bool {
    let (start, end) = segment;
    point.x >= js_math::min(start.x, end.x)
        && point.x <= js_math::max(start.x, end.x)
        && point.y >= js_math::min(start.y, end.y)
        && point.y <= js_math::max(start.y, end.y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    #[test]
    fn accepts_a_ccw_square() {
        let points = [p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)];
        match validate_strict_boundary(&points) {
            BoundaryValidation::Valid { winding } => assert_eq!(winding, 1),
            BoundaryValidation::Invalid { message } => panic!("expected valid, got {message}"),
        }
    }

    #[test]
    fn accepts_a_cw_square_with_opposite_winding() {
        let points = [p(0.0, 0.0), p(0.0, 4.0), p(4.0, 4.0), p(4.0, 0.0)];
        match validate_strict_boundary(&points) {
            BoundaryValidation::Valid { winding } => assert_eq!(winding, -1),
            BoundaryValidation::Invalid { message } => panic!("expected valid, got {message}"),
        }
    }

    #[test]
    fn rejects_fewer_than_three_vertices() {
        let points = [p(0.0, 0.0), p(1.0, 0.0)];
        match validate_strict_boundary(&points) {
            BoundaryValidation::Invalid { message } => {
                assert_eq!(message, "polygon must contain at least three vertices.");
            }
            BoundaryValidation::Valid { .. } => panic!("expected invalid"),
        }
    }

    #[test]
    fn rejects_collinear_vertices() {
        let points = [p(0.0, 0.0), p(1.0, 0.0), p(2.0, 0.0)];
        match validate_strict_boundary(&points) {
            BoundaryValidation::Invalid { message } => {
                assert_eq!(message, "polygon must not contain collinear vertices.");
            }
            BoundaryValidation::Valid { .. } => panic!("expected invalid"),
        }
    }

    #[test]
    fn rejects_a_non_convex_star() {
        // A five-point star: alternating turn signs.
        let points = [
            p(0.0, 4.0),
            p(1.0, 1.0),
            p(4.0, 0.0),
            p(1.0, -1.0),
            p(0.0, -4.0),
            p(-1.0, -1.0),
            p(-4.0, 0.0),
            p(-1.0, 1.0),
        ];
        match validate_strict_boundary(&points) {
            BoundaryValidation::Invalid { .. } => {}
            BoundaryValidation::Valid { .. } => panic!("expected invalid non-convex boundary"),
        }
    }

    #[test]
    fn rejects_non_finite_coordinates() {
        let points = [p(0.0, 0.0), p(f64::NAN, 0.0), p(1.0, 1.0)];
        match validate_strict_boundary(&points) {
            BoundaryValidation::Invalid { message } => {
                assert_eq!(message, "polygon coordinates must be finite.");
            }
            BoundaryValidation::Valid { .. } => panic!("expected invalid"),
        }
    }

    #[test]
    fn rejects_repeated_adjacent_vertices() {
        let points = [p(0.0, 0.0), p(0.0, 0.0), p(1.0, 1.0)];
        match validate_strict_boundary(&points) {
            BoundaryValidation::Invalid { message } => {
                assert_eq!(message, "polygon must not repeat adjacent vertices.");
            }
            BoundaryValidation::Valid { .. } => panic!("expected invalid"),
        }
    }
}
