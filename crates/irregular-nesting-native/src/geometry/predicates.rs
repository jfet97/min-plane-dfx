//! Rust port of the exact-sign orientation predicate consumed from the JS
//! `robust-predicates@3.0.3` package (`node_modules/robust-predicates`).
//!
//! ## Task A: caller audit (ruling R9 precondition)
//!
//! `grep -rn "robust-predicates" src/workers/` finds exactly one import site
//! under the migrated tree: `src/workers/irregular/geometryPredicates.ts:1`
//! (`import { orient2d } from 'robust-predicates'`). No other export of the
//! package (`orient2dfast`, `orient3d`, `incircle`, `insphere`) is imported
//! anywhere under `src/workers/`. (`src/main/services/DxfImportService.ts` also
//! imports `robust-predicates`, but that file is outside `src/workers/` and
//! outside this migration's boundary, so it is not part of this audit.)
//!
//! `orient2d`'s single call site is `geometryPredicates.ts:21-28`, inside
//! `orientation` (`GeometryPredicates.orientation`). That function immediately
//! collapses the raw `f64` return value with three sign/zero comparisons
//! (`robustResult > 0`, `robustResult < 0`, else) and returns only one of the
//! three literals `-1 | 0 | 1` (the `Orientation` type,
//! `geometryPredicates.ts:4`) -- see `geometryPredicates.ts:32-34. The raw
//! magnitude of `orient2d`'s return value is never stored, never compared to
//! anything but the literal `0`, and never used in arithmetic.
//!
//! Every downstream caller of `GeometryPredicates.orientation` was also
//! audited and consumes only that `-1 | 0 | 1` result via `!== 0`, `=== 0`, or
//! direct comparison against `-1`/`1`/`0` -- again sign/zero-test only, never
//! magnitude:
//!   - `src/workers/irregular/convexPolygonContact.ts:283-284`
//!   - `src/workers/irregular/placementValidation.ts:293-294,302,308,338,343,348,353,398,407`
//!   - `src/workers/irregular/nfpIfpService.ts:870,1090-1093,1273`
//!   - `src/workers/irregular/convexPolygonValidation.ts:173,283-286`
//!
//! Conclusion: only predicate SIGNS/zero-tests are consumed anywhere in
//! `src/workers/`, satisfying ruling R9's precondition for using the `robust`
//! crate (a Shewchuk port whose adaptive exact sign is implementation-
//! independent) rather than a verbatim translation of
//! `robust-predicates@3.0.3`'s JS source.
//!
//! ## Sign-convention mapping (verified against package source, not assumed)
//!
//! JS `orient2d(ax, ay, bx, by, cx, cy)`
//! (`node_modules/robust-predicates/esm/orient2d.js:171-180`) computes, in its
//! fast (non-adaptive) path,
//! `det = (ay - cy) * (bx - cx) - (ax - cx) * (by - cy)`,
//! and falls back to `-orient2dadapt(ax, ay, bx, by, cx, cy, detsum)`
//! (note the leading `-`) for the exact adaptive-precision path
//! (`orient2d.js:179`); `orient2dadapt` itself
//! (`orient2d.js:13-169`) computes the exact expansion of
//! `acx * bcy - acy * bcx` where `acx = ax - cx`, `bcy = by - cy`, `acy = ay -
//! cy`, `bcx = bx - cx` -- i.e. `(ax - cx) * (by - cy) - (ay - cy) * (bx -
//! cx)`, matching the fast path's `-det` up to sign, so both paths agree.
//!
//! The `robust` crate's `orient2d(pa, pb, pc)`
//! (v1.2.0, `src/lib.rs:77-108`) computes, with the same point-to-argument
//! grouping (`pa = (ax, ay)`, `pb = (bx, by)`, `pc = (cx, cy)`),
//! `det = (pa.x - pc.x) * (pb.y - pc.y) - (pa.y - pc.y) * (pb.x - pc.x)`
//! = `(ax - cx) * (by - cy) - (ay - cy) * (bx - cx)` for both its fast and
//! adaptive paths (`src/lib.rs:91-93,110+`).
//!
//! These are algebraically exact negations of each other for every input:
//! `robust::orient2d(pa, pb, pc) == -orient2d_js(ax, ay, bx, by, cx, cy)`.
//! Because both crates are independent, line-for-line transcripts of the same
//! Shewchuk exact-expansion algorithm (same intermediate two-product /
//! two-sum decomposition, same `estimate` compression to a single `f64`), the
//! negation holds bit-for-bit, not just in exact real arithmetic -- confirmed
//! empirically by the differential vectors in `tests/vectors/predicates.json`
//! / `tests/predicates_vectors.rs`, which include exactly-collinear integer
//! triples, near-collinear perturbations at the adaptive-precision boundary,
//! and fixture-derived coordinates.
//!
//! [`orient2d`] below negates the `robust` crate's result to reproduce the JS
//! `robust-predicates` package's own convention exactly, for parity with any
//! call site that consumes the raw package export. [`orientation`] below
//! reproduces `geometryPredicates.ts`'s `orientation` -- the actual production
//! entry point -- verbatim, including its own additional sign flip.

use robust::{orient2d as robust_orient2d, Coord};

/// TS source: `node_modules/robust-predicates/esm/orient2d.js:171-184`
/// (`orient2d`, `orient2dfast`; both share the y-down sign convention).
///
/// Bit-exact port of the JS `robust-predicates@3.0.3` package's `orient2d`
/// export: same argument order (`ax, ay, bx, by, cx, cy`) and the same y-down
/// screen-space sign convention (see the module doc comment for the exact
/// derivation of the sign flip relative to the `robust` crate's own
/// `orient2d`, which uses the standard CCW-positive convention).
///
/// Returns a value that is:
/// - positive when `c` lies to the right of the directed line `a -> b` (in
///   y-down screen coordinates),
/// - negative when `c` lies to the left,
/// - exactly `0.0` when `a`, `b`, `c` are exactly collinear.
///
/// Only the *sign* of this result is meaningful to any caller in this crate
/// per the Task A audit above; the magnitude is not part of any contract.
pub fn orient2d(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 {
    -robust_orient2d(
        Coord { x: ax, y: ay },
        Coord { x: bx, y: by },
        Coord { x: cx, y: cy },
    )
}

/// TS source: `src/workers/irregular/geometryPredicates.ts:4` (`Orientation`).
pub type Orientation = i32;

/// TS source: `src/workers/irregular/geometryPredicates.ts:16-35`
/// (`orientation`, via `GeometryPredicates.orientation`).
///
/// Classifies the turn from `origin -> first` toward `origin -> second`.
/// `1` means a left / counter-clockwise turn in this app's Y-up DXF
/// coordinates, `-1` means right, `0` means the three points are collinear.
///
/// Ported verbatim from the TS: the TS computes the raw JS `orient2d` result
/// (`geometryPredicates.ts:21-28`) and then negates its sign
/// (`robustResult > 0` -> `-1`, `robustResult < 0` -> `1`, else `0`,
/// `geometryPredicates.ts:32-34`) to flip from `orient2d`'s y-down convention
/// to this app's y-up convention. The two sign flips (`orient2d`'s own
/// negation relative to the standard CCW convention, composed with this
/// function's negation back) algebraically cancel, so this is equivalent to
/// the sign of `robust::orient2d` directly with no further negation -- but the
/// two-step form matching the TS control flow is kept explicit below (rather
/// than only writing the simplified one-liner) so this stays line-auditable
/// against `geometryPredicates.ts`.
///
/// Points are passed as flat `(x, y)` pairs rather than a shared `Point`
/// struct: no `Point`/`InternalPoint` type has been ported into this crate
/// yet (see `src/geometry/mod.rs`); callers that later port
/// `internalGeometry.ts`'s `InternalPoint` should adapt at the call site.
pub fn orientation(
    origin_x: f64,
    origin_y: f64,
    first_x: f64,
    first_y: f64,
    second_x: f64,
    second_y: f64,
) -> Orientation {
    let robust_result = orient2d(origin_x, origin_y, first_x, first_y, second_x, second_y);
    if robust_result > 0.0 {
        -1
    } else if robust_result < 0.0 {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collinear_points_are_zero() {
        assert_eq!(orient2d(0.0, 0.0, 1.0, 0.0, 2.0, 0.0), 0.0);
        assert_eq!(orientation(0.0, 0.0, 1.0, 0.0, 2.0, 0.0), 0);
    }

    #[test]
    fn matches_js_sign_convention_for_a_simple_left_turn() {
        // origin=(0,0), first=(1,0), second=(0,1): in y-up coordinates this is a
        // left / counter-clockwise turn, so `orientation` must be 1.
        assert_eq!(orientation(0.0, 0.0, 1.0, 0.0, 0.0, 1.0), 1);
        // The raw JS-convention `orient2d` (y-down positive-right) must have the
        // opposite sign from `orientation` for the same non-collinear triple.
        let raw = orient2d(0.0, 0.0, 1.0, 0.0, 0.0, 1.0);
        assert!(raw < 0.0);
    }

    #[test]
    fn matches_js_sign_convention_for_a_simple_right_turn() {
        assert_eq!(orientation(0.0, 0.0, 1.0, 0.0, 0.0, -1.0), -1);
        let raw = orient2d(0.0, 0.0, 1.0, 0.0, 0.0, -1.0);
        assert!(raw > 0.0);
    }

    #[test]
    fn orientation_equals_sign_of_robust_orient2d_directly() {
        // Algebraic identity documented above: the double negation cancels, so
        // `orientation`'s sign matches `robust::orient2d`'s sign directly (not
        // negated), for a battery of non-collinear triples.
        let cases: [[f64; 6]; 4] = [
            [0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0, 0.0, 0.0, -1.0],
            [-3.5, 2.25, 4.0, -1.0, 10.0, 10.0],
            [1e10, -1e10, -1e10, 1e10, 0.0, 0.0],
        ];
        for [ox, oy, fx, fy, sx, sy] in cases {
            let expected = robust_orient2d(
                Coord { x: ox, y: oy },
                Coord { x: fx, y: fy },
                Coord { x: sx, y: sy },
            );
            let expected_sign = if expected > 0.0 {
                1
            } else if expected < 0.0 {
                -1
            } else {
                0
            };
            assert_eq!(orientation(ox, oy, fx, fy, sx, sy), expected_sign);
        }
    }
}
