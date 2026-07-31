//! Rectangular inner-fit-bounds (IFP) construction and resolution.
//!
//! TS source: `src/workers/irregular/core/ifpBoundsCore.ts` (131 lines),
//! read in full. Namespace `sheet-ifp-v1` (`cache-concurrency-design.md`
//! §1.3, `nfp-ifp.md` §9.B).
//!
//! # Reuse
//!
//! Cache key construction, the store, and its telemetry hooks are owned by
//! `caches` (imported, never re-implemented):
//! [`crate::caches::GeometryCacheStore`],
//! [`crate::caches::make_inner_fit_bounds_cache_key`],
//! [`crate::caches::InnerFitBoundsKeyInput`],
//! [`crate::caches::IFP_GEOMETRY_CACHE_NAMESPACE`]. `boundsForPoints` is
//! owned by `geometry::convex` (imported, never re-implemented).

use crate::caches::{
    charge_ifp_bounds, make_inner_fit_bounds_cache_key, GeometryCacheKey, GeometryCacheStore,
    InnerFitBoundsKeyInput, IFP_GEOMETRY_CACHE_NAMESPACE,
};
use crate::domain::{IrregularBounds, IrregularIfpBounds};
use crate::geometry::convex::{
    bounds_for_points, validate_strict_boundary, StrictConvexBoundaryValidation,
};
use crate::js_number::fold_negative_zero;

/// TS: `ifpBoundsCore.ts:14` (`CoreIfpBoundsFailureKind`). The
/// `'invalid'`/`'infeasible'` split is a load-bearing production contract
/// (`nfp-ifp.md` §11): `'invalid'` fails the whole candidate-generation call,
/// `'infeasible'` is silently swallowed into an empty candidate list on the
/// internal fast path. Do not collapse these into one variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoreIfpBoundsFailureKind {
    Invalid,
    Infeasible,
}

/// TS: `ifpBoundsCore.ts:25-29` (`CoreIfpBoundsFailure`).
#[derive(Clone, Debug, PartialEq)]
pub struct CoreIfpBoundsFailure {
    pub kind: CoreIfpBoundsFailureKind,
    pub message: String,
}

/// TS: `ifpBoundsCore.ts:16-23` (`CoreIfpBoundsSuccess`).
#[derive(Clone, Debug, PartialEq)]
pub struct CoreIfpBoundsSuccess {
    pub value: IrregularIfpBounds,
    pub key: GeometryCacheKey,
}

pub type CoreIfpBoundsResult = Result<CoreIfpBoundsSuccess, CoreIfpBoundsFailure>;

/// TS: `ifpBoundsCore.ts:37-59` (`resolveIfpBounds`). Resolves rectangular
/// IFP bounds while preserving validation-before-cache ordering.
///
/// **Exact TS access sequence** (`cache-concurrency-design.md` §1.3,
/// `nfp-ifp.md` §9.B), preserved step-for-step:
/// 1. Validate the moving polygon — fail before any key/cache access; zero
///    cache actions on failure.
/// 2. Build key.
/// 3. `cache.get(key)` — exactly one `get`.
/// 4. `isValidCachedIfpBounds(cached, input)`: re-derives bounds from the
///    **live** input polygon, never from anything cached. Valid hit returns
///    directly; stale evicts strictly before recompute; miss recomputes
///    with no `remove`.
/// 5. Recompute failure (either kind) returns immediately without a `set`.
/// 6. Recompute success publishes.
pub fn resolve_ifp_bounds(
    input: &InnerFitBoundsKeyInput<'_>,
    cache: &mut GeometryCacheStore,
) -> CoreIfpBoundsResult {
    if let StrictConvexBoundaryValidation::Invalid { message } =
        validate_strict_boundary(&input.moving.polygon.points)
    {
        return Err(invalid(message));
    }

    let key = make_inner_fit_bounds_cache_key(input);
    let cached: Option<IrregularIfpBounds> = cache.get(&key);

    if is_valid_cached_ifp_bounds(cached.as_ref(), input) {
        cache.record_hit(IFP_GEOMETRY_CACHE_NAMESPACE);
        let value = cached.expect("validity check above requires Some");
        return Ok(CoreIfpBoundsSuccess { value, key });
    }

    if cached.is_some() {
        cache.record_stale_detection(IFP_GEOMETRY_CACHE_NAMESPACE);
        cache.remove(&key);
    }

    let computed = compute_ifp_bounds(input)?;
    let _admitted = cache.set(&key, computed.clone(), charge_ifp_bounds(&computed));
    Ok(CoreIfpBoundsSuccess {
        value: computed,
        key,
    })
}

/// TS: `ifpBoundsCore.ts:61-98` (`computeIfpBounds`).
pub fn compute_ifp_bounds(
    input: &InnerFitBoundsKeyInput<'_>,
) -> Result<IrregularIfpBounds, CoreIfpBoundsFailure> {
    if let StrictConvexBoundaryValidation::Invalid { message } =
        validate_strict_boundary(&input.moving.polygon.points)
    {
        return Err(invalid(message));
    }

    let polygon_bounds = bounds_for_points(&input.moving.polygon.points)
        .ok_or_else(|| invalid("moving polygon bounds must be finite.".to_string()))?;

    let min_x = fold_negative_zero(-polygon_bounds.min_x);
    let min_y = fold_negative_zero(-polygon_bounds.min_y);
    let max_x = fold_negative_zero(input.sheet.width - polygon_bounds.max_x);
    let max_y = fold_negative_zero(input.sheet.height - polygon_bounds.max_y);
    if !min_x.is_finite() || !min_y.is_finite() || !max_x.is_finite() || !max_y.is_finite() {
        return Err(invalid(
            "IFP arithmetic must produce finite bounds.".to_string(),
        ));
    }
    if min_x > max_x || min_y > max_y {
        return Err(CoreIfpBoundsFailure {
            kind: CoreIfpBoundsFailureKind::Infeasible,
            message: "moving polygon cannot fit inside the sheet.".to_string(),
        });
    }

    Ok(IrregularIfpBounds {
        sheet: input.sheet.clone(),
        moving_piece_id: input.moving.source_piece_id.clone(),
        bounds: IrregularBounds::new(min_x, min_y, max_x, max_y),
    })
}

/// TS: `ifpBoundsCore.ts:100-123` (`isValidCachedIfpBounds`).
pub fn is_valid_cached_ifp_bounds(
    value: Option<&IrregularIfpBounds>,
    input: &InnerFitBoundsKeyInput<'_>,
) -> bool {
    let Some(value) = value else {
        return false;
    };
    let Some(moving_bounds) = bounds_for_points(&input.moving.polygon.points) else {
        return false;
    };
    value.moving_piece_id == input.moving.source_piece_id
        && value.sheet.width == input.sheet.width
        && value.sheet.height == input.sheet.height
        && value.bounds.min_x == -moving_bounds.min_x
        && value.bounds.min_y == -moving_bounds.min_y
        && value.bounds.max_x == input.sheet.width - moving_bounds.max_x
        && value.bounds.max_y == input.sheet.height - moving_bounds.max_y
        && [
            value.bounds.min_x,
            value.bounds.min_y,
            value.bounds.max_x,
            value.bounds.max_y,
        ]
        .iter()
        .all(|value| value.is_finite())
}

/// TS: `ifpBoundsCore.ts:125-127` (`invalid`).
fn invalid(message: impl Into<String>) -> CoreIfpBoundsFailure {
    CoreIfpBoundsFailure {
        kind: CoreIfpBoundsFailureKind::Invalid,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caches::GeometryCacheStore;
    use crate::domain::{
        IrregularPoint, IrregularPolygon, IrregularTransformCandidate, IrregularTransformReason,
        PieceId, SheetSpec, TransformedCollisionGeometry,
    };

    fn p(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    fn square(min: f64, max: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![p(min, min), p(max, min), p(max, max), p(min, max)])
    }

    fn moving(polygon: IrregularPolygon) -> TransformedCollisionGeometry {
        TransformedCollisionGeometry {
            source_piece_id: PieceId::new("moving-piece"),
            transform: IrregularTransformCandidate {
                index: 0.0,
                rotation_deg: 0.0,
                mirrored: false,
                reason: IrregularTransformReason::Orthogonal,
            },
            polygon,
            bounds: IrregularBounds::new(0.0, 0.0, 4.0, 4.0),
        }
    }

    fn sheet(width: f64, height: f64) -> SheetSpec {
        SheetSpec {
            width,
            height,
            label: "test sheet".to_string(),
        }
    }

    #[test]
    fn compute_ifp_bounds_produces_the_translation_rectangle() {
        let sheet_spec = sheet(20.0, 15.0);
        let moving_geometry = moving(square(0.0, 4.0));
        let input = InnerFitBoundsKeyInput {
            sheet: &sheet_spec,
            moving: &moving_geometry,
        };
        let bounds = compute_ifp_bounds(&input).expect("feasible IFP");
        assert_eq!(bounds.bounds, IrregularBounds::new(0.0, 0.0, 16.0, 11.0));
    }

    #[test]
    fn compute_ifp_bounds_is_infeasible_when_the_piece_cannot_fit() {
        let sheet_spec = sheet(2.0, 2.0);
        let moving_geometry = moving(square(0.0, 4.0));
        let input = InnerFitBoundsKeyInput {
            sheet: &sheet_spec,
            moving: &moving_geometry,
        };
        let failure = compute_ifp_bounds(&input).expect_err("infeasible IFP");
        assert_eq!(failure.kind, CoreIfpBoundsFailureKind::Infeasible);
    }

    #[test]
    fn compute_ifp_bounds_is_invalid_for_a_degenerate_moving_polygon() {
        let sheet_spec = sheet(20.0, 15.0);
        let moving_geometry = moving(IrregularPolygon::new(vec![p(0.0, 0.0)]));
        let input = InnerFitBoundsKeyInput {
            sheet: &sheet_spec,
            moving: &moving_geometry,
        };
        let failure = compute_ifp_bounds(&input).expect_err("invalid IFP");
        assert_eq!(failure.kind, CoreIfpBoundsFailureKind::Invalid);
    }

    #[test]
    fn resolve_ifp_bounds_caches_on_miss_and_hits_on_the_second_call() {
        let sheet_spec = sheet(20.0, 15.0);
        let moving_geometry = moving(square(0.0, 4.0));
        let mut cache = GeometryCacheStore::new();
        let input = InnerFitBoundsKeyInput {
            sheet: &sheet_spec,
            moving: &moving_geometry,
        };

        let first = resolve_ifp_bounds(&input, &mut cache).expect("first resolution succeeds");
        let counters = cache.telemetry().namespace(IFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(counters.lookups, 1);
        assert_eq!(counters.misses, 1);
        assert_eq!(counters.stores, 1);

        let second = resolve_ifp_bounds(&input, &mut cache).expect("second resolution is a hit");
        let counters = cache.telemetry().namespace(IFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(counters.lookups, 2);
        assert_eq!(counters.hits, 1);
        assert_eq!(counters.stores, 1);
        assert_eq!(first.value, second.value);
    }

    #[test]
    fn resolve_ifp_bounds_zero_cache_actions_on_pre_key_validation_failure() {
        let sheet_spec = sheet(20.0, 15.0);
        let moving_geometry = moving(IrregularPolygon::new(vec![p(0.0, 0.0)]));
        let mut cache = GeometryCacheStore::new();
        let input = InnerFitBoundsKeyInput {
            sheet: &sheet_spec,
            moving: &moving_geometry,
        };
        let result = resolve_ifp_bounds(&input, &mut cache);
        assert!(result.is_err());
        let counters = cache.telemetry().namespace(IFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(counters.lookups, 0);
    }

    #[test]
    fn resolve_ifp_bounds_never_trusts_a_stale_cached_rectangle_over_the_live_polygon() {
        let sheet_spec = sheet(20.0, 15.0);
        let moving_geometry = moving(square(0.0, 4.0));
        let mut cache = GeometryCacheStore::new();
        let input = InnerFitBoundsKeyInput {
            sheet: &sheet_spec,
            moving: &moving_geometry,
        };
        let key = make_inner_fit_bounds_cache_key(&input);
        // Publish a stale value under the correct key (as if the moving
        // polygon had previously been a different shape).
        let stale_value = IrregularIfpBounds {
            sheet: sheet_spec.clone(),
            moving_piece_id: PieceId::new("moving-piece"),
            bounds: IrregularBounds::new(-100.0, -100.0, 100.0, 100.0),
        };
        assert!(cache.set(&key, stale_value.clone(), charge_ifp_bounds(&stale_value)));

        let result = resolve_ifp_bounds(&input, &mut cache).expect("recompute succeeds");
        assert_eq!(
            result.value.bounds,
            IrregularBounds::new(0.0, 0.0, 16.0, 11.0)
        );
        let counters = cache.telemetry().namespace(IFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(counters.stale_detections, 1);
        assert_eq!(counters.stale_removals, 1);
    }
}
