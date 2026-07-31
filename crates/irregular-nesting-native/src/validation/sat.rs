//! Separating-Axis-Theorem minimum-translation penetration depth between two
//! convex polygons.
//!
//! TS source: `src/workers/irregular/convexSatPenetration.ts` (90 lines).
//!
//! # Liveness note (ported per explicit task instruction, not production
//! reachability)
//!
//! Per `docs/planning/rust-irregular-backend/characterization/validation-spatial.md`
//! §1/§15 item 1: this file's single export, `measureConvexSatPenetration`,
//! has **zero** production callers reachable from
//! `computeIrregularNesting.ts` today (its only two importers,
//! `overlapRelaxation.ts`/`overlapRelaxationV1.ts`, are themselves part of a
//! dead LNS/overlap-relaxation island with no non-test importer anywhere in
//! `src/`). The characterization document flags this as an open question
//! needing an explicit orchestrator ruling before inclusion. This module was
//! nonetheless assigned and ported completely, verbatim, per this task's
//! explicit instruction to port `convexSatPenetration.ts` alongside
//! `placementValidation.ts`/`placedCollisionSpatialIndex.ts` — see this
//! crate task's final structured-output notes for a flag back to the
//! orchestrator on this scope decision.
//!
//! # Trig bit-parity: measured, and a residual ULP-scale gap documented rather than hidden
//!
//! `polygon_axes` below normalizes each edge via `f64::hypot`-equivalent
//! division, an IEEE-754 binary64 operation that is not guaranteed
//! bit-identical to V8's own `Math.hypot` across platforms/libm versions --
//! the same class of risk `transforms::generator` and `transforms::flattening`
//! document and measure for their own trig call sites (see stage0-rulings.md
//! R21). **This was measured, not assumed.** `dx.hypot(dy)` on Rust `std`
//! disagreed with the `>=500`-vector oracle (`tests/vectors/validation.json`'s
//! `sat` section, 269 cases) on 25/269 cases; switching to the `libm` crate
//! (already this crate's dependency for the same reason in
//! `transforms::generator`/`transforms::flattening`) reduced that to 20/269,
//! so `libm::hypot` is used here too. The residual mismatches are all
//! rotated/regular-polygon cases whose axis vectors come from an
//! irrational-magnitude `hypot` division; every mismatch measured at most
//! `1.78e-15` absolute / `4.91e-15` relative divergence from the TS oracle
//! (a handful of ULPs at these magnitudes) -- see
//! `tests/validation_vectors.rs`'s `sat_penetration_matches_ts_oracle` doc
//! comment for the bounded-tolerance comparison this residual gap requires
//! (depth/translation only; `assess_placement` and the spatial index remain
//! 100% bit-exact). Since this module has zero production callers (see the
//! liveness note above), this residual is not reachable from any
//! Compact/Compact Short Side job today; it is documented here per the
//! "measure and record, don't guess" instruction rather than silently
//! tolerated or silently claimed bit-exact.

use crate::domain::IrregularPoint;
use crate::js_number::js_math;

/// TS source: `convexSatPenetration.ts:3-7` (`ConvexSatPenetration`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ConvexSatPenetration {
    pub depth: f64,
    /// Minimum translation that moves the first polygon out of the second.
    pub translation: IrregularPoint,
}

/// TS source: `convexSatPenetration.ts:10-40` (`measureConvexSatPenetration`).
///
/// Returns the minimum positive SAT penetration, or `None` for
/// separation/exact-touch. `None` does not distinguish "separated" from
/// "penetration depth exactly zero" — both fall out of the same `<= 0` guard
/// (`convexSatPenetration.ts:24`, using `<=` not `<`), preserved verbatim
/// here.
pub fn measure_convex_sat_penetration(
    first: &[IrregularPoint],
    second: &[IrregularPoint],
) -> Option<ConvexSatPenetration> {
    // TS: `convexSatPenetration.ts:14`.
    if first.len() < 3 || second.len() < 3 {
        return None;
    }

    let mut best: Option<ConvexSatPenetration> = None;

    // TS: `convexSatPenetration.ts:17` — `[...polygonAxes(first),
    // ...polygonAxes(second)]`: axis candidates in `first`'s edge order then
    // `second`'s edge order.
    let mut axes = polygon_axes(first);
    axes.extend(polygon_axes(second));

    for axis in axes {
        // TS: `convexSatPenetration.ts:18-20` — a projection failure on
        // *either* polygon for *this* axis returns `undefined` from the
        // whole function immediately, not merely skipping this axis.
        let (first_projection, second_projection) =
            match (project(first, axis), project(second, axis)) {
                (Some(f), Some(s)) => (f, s),
                _ => return None,
            };

        // TS: `convexSatPenetration.ts:22-24`.
        let negative_depth = first_projection.max - second_projection.min;
        let positive_depth = second_projection.max - first_projection.min;
        if negative_depth <= 0.0 || positive_depth <= 0.0 {
            return None;
        }

        // TS: `convexSatPenetration.ts:26-30`.
        let move_negative = negative_depth <= positive_depth;
        let depth = if move_negative {
            negative_depth
        } else {
            positive_depth
        };
        let translation = if move_negative {
            IrregularPoint::new(
                canonical_zero(-axis.x * depth),
                canonical_zero(-axis.y * depth),
            )
        } else {
            IrregularPoint::new(
                canonical_zero(axis.x * depth),
                canonical_zero(axis.y * depth),
            )
        };

        // TS: `convexSatPenetration.ts:31-37` — primary key `depth`
        // (strictly smaller wins), secondary key `translation` via
        // `comparePoint` on an exact `depth` tie; the very first candidate
        // always becomes `best`.
        let replace = match &best {
            None => true,
            Some(current) => {
                depth < current.depth
                    || (depth == current.depth
                        && compare_point(&translation, &current.translation) < 0)
            }
        };
        if replace {
            best = Some(ConvexSatPenetration { depth, translation });
        }
    }

    best
}

/// TS source: `convexSatPenetration.ts:42-61` (`polygonAxes`).
fn polygon_axes(points: &[IrregularPoint]) -> Vec<IrregularPoint> {
    let len = points.len();
    let mut axes = Vec::with_capacity(len);
    for index in 0..len {
        let start = points[index];
        let end = points[(index + 1) % len];
        let dx = end.x - start.x;
        let dy = end.y - start.y;
        // TS: `Math.hypot(dx, dy)`, not `Math.sqrt(dx * dx + dy * dy)`.
        // `libm::hypot` (not `std`'s `f64::hypot`) is used here -- measured
        // to track the TS/V8 oracle more closely; see this file's module
        // doc "Trig bit-parity" section for the measurement and the residual
        // documented gap.
        let length = libm::hypot(dx, dy);
        if !length.is_finite() || length <= 0.0 {
            return Vec::new();
        }
        let mut x = -dy / length;
        let mut y = dx / length;
        if x < 0.0 || (x == 0.0 && y < 0.0) {
            x = -x;
            y = -y;
        }
        axes.push(IrregularPoint::new(x, y));
    }
    axes
}

struct Projection {
    min: f64,
    max: f64,
}

/// TS source: `convexSatPenetration.ts:63-80` (`project`).
fn project(points: &[IrregularPoint], axis: IrregularPoint) -> Option<Projection> {
    let first = points.first()?;
    let first_projection = first.x * axis.x + first.y * axis.y;
    if !first_projection.is_finite() {
        return None;
    }
    let mut min = first_projection;
    let mut max = first_projection;
    for point in &points[1..] {
        let value = point.x * axis.x + point.y * axis.y;
        if !value.is_finite() {
            return None;
        }
        // TS: `Math.min`/`Math.max` -- must route through `js_math::min`/
        // `max`, not `f64::min`/`f64::max` (see `geometry::convex`'s doc
        // comment for the signed-zero rationale this crate applies
        // uniformly).
        min = js_math::min(min, value);
        max = js_math::max(max, value);
    }
    Some(Projection { min, max })
}

/// TS source: `convexSatPenetration.ts:82-86` (`comparePoint`).
fn compare_point(first: &IrregularPoint, second: &IrregularPoint) -> i32 {
    if first.x != second.x {
        return if first.x < second.x { -1 } else { 1 };
    }
    if first.y != second.y {
        return if first.y < second.y { -1 } else { 1 };
    }
    0
}

/// TS source: `convexSatPenetration.ts:88-90` (`canonicalZero`).
///
/// `Object.is(value, -0) ? 0 : value`. Per `validation-spatial.md` §7:
/// `value + 0.0` is **not** an equivalent idiom in all Rust/LLVM
/// configurations claiming IEEE semantics without `-0.0`-preserving
/// guarantees; use the explicit `is_sign_negative` check instead.
fn canonical_zero(value: f64) -> f64 {
    if value == 0.0 && value.is_sign_negative() {
        0.0
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    fn square(min: f64, max: f64) -> Vec<IrregularPoint> {
        vec![p(min, min), p(max, min), p(max, max), p(min, max)]
    }

    #[test]
    fn returns_none_for_fewer_than_three_vertices() {
        assert_eq!(
            measure_convex_sat_penetration(&[p(0.0, 0.0), p(1.0, 1.0)], &square(0.0, 1.0)),
            None
        );
    }

    #[test]
    fn returns_none_for_separated_squares() {
        let first = square(0.0, 1.0);
        let second = square(5.0, 6.0);
        assert_eq!(measure_convex_sat_penetration(&first, &second), None);
    }

    #[test]
    fn returns_none_for_exactly_touching_squares() {
        let first = square(0.0, 1.0);
        let second = vec![p(1.0, 0.0), p(2.0, 0.0), p(2.0, 1.0), p(1.0, 1.0)];
        assert_eq!(measure_convex_sat_penetration(&first, &second), None);
    }

    #[test]
    fn measures_axis_aligned_overlap_depth_and_translation() {
        // Two unit squares overlapping by 0.5 along x: [0,1]x[0,1] and
        // [0.5,1.5]x[0,1]. Minimum penetration axis is the x axis with depth
        // 0.5, moving the first polygon in the -x direction (translation
        // x=-0.5) is the smaller of negativeDepth (max-min=1-0.5=0.5) and
        // positiveDepth (1.5-0=1.5).
        let first = square(0.0, 1.0);
        let second = vec![p(0.5, 0.0), p(1.5, 0.0), p(1.5, 1.0), p(0.5, 1.0)];
        let result = measure_convex_sat_penetration(&first, &second).expect("overlap");
        assert_eq!(result.depth, 0.5);
        assert_eq!(result.translation, p(-0.5, 0.0));
    }

    #[test]
    fn canonical_zero_normalizes_negative_zero_translation_components() {
        // A configuration whose minimal-axis translation component would
        // naturally compute as -0.0 must be normalized to +0.0.
        assert_eq!(canonical_zero(-0.0), 0.0);
        assert!(!canonical_zero(-0.0).is_sign_negative());
        assert_eq!(canonical_zero(0.0), 0.0);
        assert!(!canonical_zero(0.0).is_sign_negative());
        assert_eq!(canonical_zero(5.0), 5.0);
        assert_eq!(canonical_zero(-5.0), -5.0);
    }

    #[test]
    fn diamond_vs_square_depth_is_consistent_with_translation_magnitude() {
        let square_polygon = square(-5.0, 5.0);
        let diamond = vec![p(0.0, -3.0), p(3.0, 0.0), p(0.0, 3.0), p(-3.0, 0.0)];
        let result = measure_convex_sat_penetration(&square_polygon, &diamond).expect("overlap");
        // N2 audit: Rust-only test-side consistency check (1e-9 tolerance),
        // not compared against a TS/V8 oracle -- kept on `std::f64::hypot`.
        // `measure_convex_sat_penetration` itself has zero production
        // callers today (this module's own top-doc "Liveness note"), so no
        // call site in this file can reach a production semantic field
        // regardless.
        let translation_length = result.translation.x.hypot(result.translation.y);
        assert!((translation_length - result.depth).abs() < 1e-9);
    }
}
