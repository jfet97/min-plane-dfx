//! Exact BigInt/Number dual-path canonical-grid primitives.
//!
//! TS source: `src/workers/irregular/canonicalGridMath.ts` (whole file, 201
//! lines as characterized in
//! `docs/planning/rust-irregular-backend/characterization/canonical-grid.md`).
//! Every exported TS function is ported here, including
//! [`canonical_grid_point_on_segment`] which has no production caller (R3:
//! faithful port of reachable-but-odd/unreachable code, preserved for unit-
//! test parity — see `stage0-rulings.md` R3).

use std::cmp::Ordering;

use num_bigint::BigInt;

use super::js_local::{
    bigint_to_number, is_finite, is_safe_integer, math_max, math_min, number_to_js_string,
};

/// TS source: `canonicalGridMath.ts:3-6` (`CanonicalGridPoint`).
///
/// Both fields are plain `f64` (TS `number`), mirroring the TS type exactly:
/// there is no compile-time guarantee either coordinate is an integer, let
/// alone a safe integer — every function below re-checks that explicitly,
/// exactly as the TS source does, rather than encoding it in the type.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CanonicalGridPoint {
    pub x: f64,
    pub y: f64,
}

impl CanonicalGridPoint {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// A `Path64`-compatible ring: `clipper2-ts`'s `Path64` is a
/// `ReadonlyArray<{x:number,y:number}>`-compatible type used interchangeably
/// with `CanonicalGridPoint[]` throughout the TS cluster (see
/// `canonical-grid.md` §3); this crate models both as `Vec<CanonicalGridPoint>`
/// (the optional `z` field `Point64` carries is never read by this file).
pub type CanonicalGridPath = Vec<CanonicalGridPoint>;

/// TS source: `canonicalGridMath.ts:8-10` (`isCanonicalGridCoordinate`).
fn is_canonical_grid_coordinate(value: f64) -> bool {
    is_safe_integer(value)
}

/// TS source: `canonicalGridMath.ts:12-14` (`compareBigInts`).
pub fn canonical_grid_compare_bigints(first: &BigInt, second: &BigInt) -> i32 {
    match first.cmp(second) {
        Ordering::Equal => 0,
        Ordering::Less => -1,
        Ordering::Greater => 1,
    }
}

/// TS source: `canonicalGridMath.ts:16-27` (`compareCanonicalGridRatios`).
///
/// Cross-multiplies the two ratios' numerators and denominators as exact
/// `BigInt`s. Per `stage0-rulings.md` R6 this must stay `BigInt` (not a fixed
/// checked-integer width): the cross-multiplication squares magnitudes that
/// exceed even `i128` at the canonical grid's literal safe-integer admission
/// bound.
pub fn canonical_grid_compare_ratios(
    first_numerator: &BigInt,
    first_denominator: &BigInt,
    second_numerator: &BigInt,
    second_denominator: &BigInt,
) -> Option<i32> {
    let zero = BigInt::from(0);
    if *first_denominator <= zero || *second_denominator <= zero {
        return None;
    }
    let left = first_numerator * second_denominator;
    let right = second_numerator * first_denominator;
    Some(canonical_grid_compare_bigints(&left, &right))
}

/// A safe-integer-valued `f64` converted to the `BigInt` it exactly denotes,
/// mirroring the implicit `BigInt(value)` conversions in the TS source
/// (`canonicalGridMath.ts:45-46,128`). Callers must have already verified
/// `is_canonical_grid_coordinate(value)`; the safe-integer bound
/// (`+-(2^53-1)`) is far inside `i64`'s range, so this truncating cast is
/// exact and cannot lose precision.
fn safe_integer_to_bigint(value: f64) -> BigInt {
    BigInt::from(value as i64)
}

/// TS source: `canonicalGridMath.ts:29-48` (`canonicalGridCross`).
pub fn canonical_grid_cross(
    origin: CanonicalGridPoint,
    first: CanonicalGridPoint,
    second: CanonicalGridPoint,
) -> Option<BigInt> {
    if !is_canonical_grid_coordinate(origin.x)
        || !is_canonical_grid_coordinate(origin.y)
        || !is_canonical_grid_coordinate(first.x)
        || !is_canonical_grid_coordinate(first.y)
        || !is_canonical_grid_coordinate(second.x)
        || !is_canonical_grid_coordinate(second.y)
    {
        return None;
    }
    let origin_x = safe_integer_to_bigint(origin.x);
    let origin_y = safe_integer_to_bigint(origin.y);
    let first_x = safe_integer_to_bigint(first.x);
    let first_y = safe_integer_to_bigint(first.y);
    let second_x = safe_integer_to_bigint(second.x);
    let second_y = safe_integer_to_bigint(second.y);
    Some(
        (&first_x - &origin_x) * (&second_y - &origin_y)
            - (&first_y - &origin_y) * (&second_x - &origin_x),
    )
}

/// Largest coordinate magnitude for which the cross product is exact in
/// `f64`.
///
/// TS source: `canonicalGridMath.ts:63`
/// (`CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT = 2 ** 25 - 1`).
///
/// With every coordinate bounded by `L`, each difference is at most `2L`,
/// each product at most `4L^2`, and their difference at most `8L^2`.
/// Choosing `L = 2^25 - 1` gives `8L^2 = 2^53 - 2^29 + 8`, strictly below
/// `Number.MAX_SAFE_INTEGER`, so no intermediate value can round.
pub const CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT: f64 = 33_554_431.0; // 2^25 - 1

/// TS source: `canonicalGridMath.ts:65-70` (`withinExactNumberCrossLimit`).
fn within_exact_number_cross_limit(point: CanonicalGridPoint) -> bool {
    point.x.abs() <= CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT
        && point.y.abs() <= CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT
}

/// Exact orientation sign of `origin -> first -> second`.
///
/// TS source: `canonicalGridMath.ts:82-109` (`canonicalGridCrossSign`).
///
/// Every caller needs only the sign, and `BigInt` allocation for that answer
/// dominated the canonical grid predicates. Inside the bound proved by
/// [`CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT`] the sign is computed in `f64`
/// with no rounding possible (bound check strictly *before* the
/// multiplication, exactly as the TS source orders it); outside it the exact
/// `BigInt` value still decides. Returns `-1`, `0`, or `1`, or `None` for any
/// non-safe-integer coordinate (mirrors TS `undefined`).
pub fn canonical_grid_cross_sign(
    origin: CanonicalGridPoint,
    first: CanonicalGridPoint,
    second: CanonicalGridPoint,
) -> Option<i32> {
    if !is_canonical_grid_coordinate(origin.x)
        || !is_canonical_grid_coordinate(origin.y)
        || !is_canonical_grid_coordinate(first.x)
        || !is_canonical_grid_coordinate(first.y)
        || !is_canonical_grid_coordinate(second.x)
        || !is_canonical_grid_coordinate(second.y)
    {
        return None;
    }
    if within_exact_number_cross_limit(origin)
        && within_exact_number_cross_limit(first)
        && within_exact_number_cross_limit(second)
    {
        let cross = (first.x - origin.x) * (second.y - origin.y)
            - (first.y - origin.y) * (second.x - origin.x);
        return Some(if cross == 0.0 {
            0
        } else if cross < 0.0 {
            -1
        } else {
            1
        });
    }
    let exact = canonical_grid_cross(origin, first, second)?;
    let zero = BigInt::from(0);
    Some(if exact == zero {
        0
    } else if exact < zero {
        -1
    } else {
        1
    })
}

/// TS source: `canonicalGridMath.ts:111-131` (`canonicalGridSignedDoubledArea`).
pub fn canonical_grid_signed_doubled_area(path: &[CanonicalGridPoint]) -> Option<BigInt> {
    if path.len() < 3 {
        return Some(BigInt::from(0));
    }
    let mut doubled_area = BigInt::from(0);
    for index in 0..path.len() {
        let first = path[index];
        let second = path[(index + 1) % path.len()];
        if !is_canonical_grid_coordinate(first.x)
            || !is_canonical_grid_coordinate(first.y)
            || !is_canonical_grid_coordinate(second.x)
            || !is_canonical_grid_coordinate(second.y)
        {
            return None;
        }
        let first_x = safe_integer_to_bigint(first.x);
        let first_y = safe_integer_to_bigint(first.y);
        let second_x = safe_integer_to_bigint(second.x);
        let second_y = safe_integer_to_bigint(second.y);
        doubled_area += &first_x * &second_y - &second_x * &first_y;
    }
    Some(doubled_area)
}

/// TS source: `canonicalGridMath.ts:133-136` (`canonicalGridAbsoluteDoubledArea`).
pub fn canonical_grid_absolute_doubled_area(path: &[CanonicalGridPoint]) -> Option<BigInt> {
    let signed = canonical_grid_signed_doubled_area(path)?;
    Some(if signed < BigInt::from(0) {
        -signed
    } else {
        signed
    })
}

/// TS source: `canonicalGridMath.ts:141` (the sort comparator inside
/// `canonicalGridConvexHull`: `` (first, second) => first.x - second.x ||
/// first.y - second.y ``).
///
/// JS `||` picks the left operand when it is *truthy*: any non-zero,
/// non-`NaN` number (this notably excludes `-0`, which is falsy). This
/// mirrors that exactly, including its `NaN` fallback (`.toSorted` is a
/// stable sort, matched here by Rust's stable `sort_by`; a `NaN`-valued
/// comparator result is unreachable for any input that later passes the
/// safe-integer coordinate check, since `NaN` is never a safe integer).
fn hull_sort_key(first: CanonicalGridPoint, second: CanonicalGridPoint) -> f64 {
    let dx = first.x - second.x;
    let dx_is_truthy = dx != 0.0 && !dx.is_nan();
    if dx_is_truthy {
        dx
    } else {
        first.y - second.y
    }
}

fn hull_sort_ordering(first: CanonicalGridPoint, second: CanonicalGridPoint) -> Ordering {
    let key = hull_sort_key(first, second);
    if key.is_nan() {
        Ordering::Equal
    } else if key < 0.0 {
        Ordering::Less
    } else if key > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// TS source: `canonicalGridMath.ts:138-171` (`canonicalGridConvexHull`).
///
/// Standard monotone-chain (Andrew's) convex hull, matching the TS
/// implementation's exact de-duplication (a `Map` keyed by the same
/// `${x},${y}` template-literal string this function builds, which keeps the
/// *first* insertion position but the *last* written value — observable when
/// two distinct-by-sign-of-zero points, e.g. `{x:0,y:0}` and `{x:-0,y:0}`,
/// collide to the same rendered key), sort order (stable, `x` then `y`), and
/// tie-break (`turn > 0` breaks, ties pop).
pub fn canonical_grid_convex_hull(points: &[CanonicalGridPoint]) -> Option<CanonicalGridPath> {
    let mut unique: CanonicalGridPath = Vec::new();
    let mut key_index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for point in points {
        let key = format!(
            "{},{}",
            number_to_js_string(point.x),
            number_to_js_string(point.y)
        );
        match key_index.get(&key) {
            Some(&index) => unique[index] = *point,
            None => {
                key_index.insert(key, unique.len());
                unique.push(*point);
            }
        }
    }
    unique.sort_by(|first, second| hull_sort_ordering(*first, *second));

    if unique.iter().any(|point| {
        !is_canonical_grid_coordinate(point.x) || !is_canonical_grid_coordinate(point.y)
    }) {
        return None;
    }
    if unique.len() <= 1 {
        return Some(unique);
    }

    let build_half = |ordered: &[CanonicalGridPoint]| -> Option<CanonicalGridPath> {
        let mut half: CanonicalGridPath = Vec::new();
        for point in ordered {
            while half.len() >= 2 {
                // TS source: `canonicalGridMath.ts:154-156` guards
                // `half.at(-2)`/`half.at(-1)` against `undefined`, which is
                // unreachable given the `half.length >= 2` loop condition
                // above (both indices are always in bounds); no equivalent
                // guard is expressible (or needed) against a fixed-length
                // `Vec` slice in Rust.
                let origin = half[half.len() - 2];
                let first = half[half.len() - 1];
                let turn = canonical_grid_cross_sign(origin, first, *point)?;
                if turn > 0 {
                    break;
                }
                half.pop();
            }
            half.push(*point);
        }
        Some(half)
    };

    let lower = build_half(&unique)?;
    let reversed: CanonicalGridPath = unique.iter().rev().copied().collect();
    let upper = build_half(&reversed)?;

    let mut result = Vec::with_capacity(lower.len() - 1 + upper.len() - 1);
    result.extend_from_slice(&lower[..lower.len() - 1]);
    result.extend_from_slice(&upper[..upper.len() - 1]);
    Some(result)
}

/// TS source: `canonicalGridMath.ts:173-186` (`canonicalGridPointOnSegment`).
///
/// R3 (`stage0-rulings.md`): this function has no production `src/` caller
/// (confirmed by `canonical-grid.md` §2), but is ported verbatim anyway to
/// keep unit-test parity possible.
pub fn canonical_grid_point_on_segment(
    point: CanonicalGridPoint,
    start: CanonicalGridPoint,
    end: CanonicalGridPoint,
) -> bool {
    let cross = canonical_grid_cross_sign(start, end, point);
    cross == Some(0)
        && point.x >= math_min(start.x, end.x)
        && point.x <= math_max(start.x, end.x)
        && point.y >= math_min(start.y, end.y)
        && point.y <= math_max(start.y, end.y)
}

/// TS source: `canonicalGridMath.ts:188-191` (`canonicalGridCounterClockwise`).
pub fn canonical_grid_counter_clockwise(path: &[CanonicalGridPoint]) -> Option<CanonicalGridPath> {
    let signed = canonical_grid_signed_doubled_area(path)?;
    Some(if signed >= BigInt::from(0) {
        path.to_vec()
    } else {
        path.iter().rev().copied().collect()
    })
}

/// TS source: `canonicalGridMath.ts:193-196` (`canonicalGridClockwise`).
pub fn canonical_grid_clockwise(path: &[CanonicalGridPoint]) -> Option<CanonicalGridPath> {
    let signed = canonical_grid_signed_doubled_area(path)?;
    Some(if signed <= BigInt::from(0) {
        path.to_vec()
    } else {
        path.iter().rev().copied().collect()
    })
}

/// TS source: `canonicalGridMath.ts:198-201` (`doubledGridAreaToMm2`).
///
/// `Number.isFinite`-undefined-on-overflow contract preserved verbatim (R3):
/// only a `doubledAreaGrid2` whose magnitude is large enough to overflow
/// `f64` (post `Number(...)` conversion and `/2_000_000` division) to
/// `+-Infinity` returns `None`; every other input, however extreme, returns
/// `Some`.
pub fn doubled_grid_area_to_mm2(doubled_area_grid2: &BigInt) -> Option<f64> {
    let area_mm2 = bigint_to_number(doubled_area_grid2) / 2_000_000.0;
    if is_finite(area_mm2) {
        Some(area_mm2)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // These cover the `NaN`/`+-Infinity` coordinate branches, which the
    // JSON differential-vector suite (`tests/canonical_grid_vectors.rs`,
    // generated from `scripts/rust-parity/dump-canonical-grid.ts`)
    // deliberately does not exercise directly: `JSON.stringify` cannot
    // represent non-finite numbers, and the production TS callers never
    // encounter them either (every production coordinate is admission-
    // guarded upstream). The equivalent non-finite/fractional/over-bound
    // "invalid coordinate" branches *are* covered differentially via
    // JSON-safe finite substitutes (see `crossVectors`' invalid-coordinate
    // entries); these tests exist only to prove the `f64::NAN`/`f64::INFINITY`
    // literal cases specifically take the same `None` path.

    #[test]
    fn cross_sign_rejects_non_finite_coordinates() {
        let valid = CanonicalGridPoint::new(1.0, 1.0);
        assert_eq!(
            canonical_grid_cross_sign(CanonicalGridPoint::new(f64::NAN, 0.0), valid, valid),
            None
        );
        assert_eq!(
            canonical_grid_cross_sign(CanonicalGridPoint::new(f64::INFINITY, 0.0), valid, valid),
            None
        );
        assert_eq!(
            canonical_grid_cross_sign(
                CanonicalGridPoint::new(f64::NEG_INFINITY, 0.0),
                valid,
                valid
            ),
            None
        );
        assert_eq!(
            canonical_grid_cross_sign(valid, valid, CanonicalGridPoint::new(0.5, 0.0)),
            None
        );
    }

    #[test]
    fn cross_rejects_non_finite_coordinates() {
        let valid = CanonicalGridPoint::new(1.0, 1.0);
        assert_eq!(
            canonical_grid_cross(CanonicalGridPoint::new(f64::NAN, 0.0), valid, valid),
            None
        );
    }

    #[test]
    fn signed_doubled_area_short_circuits_before_validating_coordinates() {
        // TS source: `canonicalGridMath.ts:112` (`if (path.length < 3) return 0n`)
        // runs *before* any coordinate is checked, so a length-0/1/2 path of
        // garbage coordinates still returns `Some(0)`, not `None`.
        assert_eq!(
            canonical_grid_signed_doubled_area(&[]),
            Some(BigInt::from(0))
        );
        assert_eq!(
            canonical_grid_signed_doubled_area(&[CanonicalGridPoint::new(f64::NAN, f64::INFINITY)]),
            Some(BigInt::from(0))
        );
        let two = [
            CanonicalGridPoint::new(f64::NAN, 0.0),
            CanonicalGridPoint::new(0.5, f64::NEG_INFINITY),
        ];
        assert_eq!(
            canonical_grid_signed_doubled_area(&two),
            Some(BigInt::from(0))
        );
    }

    #[test]
    fn signed_doubled_area_rejects_non_finite_coordinates_once_length_reaches_three() {
        let path = [
            CanonicalGridPoint::new(0.0, 0.0),
            CanonicalGridPoint::new(f64::NAN, 0.0),
            CanonicalGridPoint::new(1.0, 1.0),
        ];
        assert_eq!(canonical_grid_signed_doubled_area(&path), None);
    }

    #[test]
    fn convex_hull_rejects_non_finite_coordinates() {
        let points = [
            CanonicalGridPoint::new(0.0, 0.0),
            CanonicalGridPoint::new(f64::INFINITY, 0.0),
            CanonicalGridPoint::new(1.0, 1.0),
        ];
        assert_eq!(canonical_grid_convex_hull(&points), None);
    }

    #[test]
    fn convex_hull_of_empty_and_singleton_is_identity() {
        assert_eq!(canonical_grid_convex_hull(&[]), Some(vec![]));
        let one = [CanonicalGridPoint::new(3.0, 4.0)];
        assert_eq!(canonical_grid_convex_hull(&one), Some(vec![one[0]]));
    }

    #[test]
    fn point_on_segment_returns_false_not_none_for_non_finite_coordinates() {
        // `canonicalGridPointOnSegment` (canonicalGridMath.ts:173-186) has no
        // `undefined` return path at all: an undecidable cross sign simply
        // fails the `cross === 0` equality check.
        let valid = CanonicalGridPoint::new(0.0, 0.0);
        assert!(!canonical_grid_point_on_segment(
            CanonicalGridPoint::new(f64::NAN, 0.0),
            valid,
            CanonicalGridPoint::new(10.0, 0.0)
        ));
    }

    #[test]
    fn doubled_grid_area_to_mm2_is_none_only_on_overflow() {
        assert_eq!(doubled_grid_area_to_mm2(&BigInt::from(0)), Some(0.0));
        let huge = "9"
            .repeat(400)
            .parse::<BigInt>()
            .expect("valid decimal literal");
        assert_eq!(doubled_grid_area_to_mm2(&huge), None);
        assert_eq!(doubled_grid_area_to_mm2(&(-huge)), None);
    }

    #[test]
    fn hull_sort_key_treats_negative_zero_difference_as_falsy_like_js() {
        // `first.x - second.x` can be exactly `-0.0` when both coordinates
        // are equal; JS treats `-0` as falsy just like `+0`, so the
        // comparator must still fall through to the `y` term.
        let a = CanonicalGridPoint::new(0.0, 5.0);
        let b = CanonicalGridPoint::new(0.0, 3.0);
        assert_eq!(hull_sort_key(a, b), 2.0);
    }
}
