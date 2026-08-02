//! Transformed-collision-geometry cache **resolver** and **trusted-ring
//! revalidation** — ported from
//! `src/workers/irregular/core/transformCollisionGeometryCore.ts`'s
//! `resolveTransformedCollisionGeometry`, `computeTransformedCollisionGeometry`,
//! and `isValidCachedTransformedCollisionGeometry`.
//!
//! # Cross-module ownership note (read before touching this file)
//!
//! `docs/planning/rust-irregular-backend/semantic-mapping.md` maps
//! `transformCollisionGeometryCore.ts`'s full cache/key/resolver surface to
//! `core::geometry::nfp_ifp::transform_collision_geometry_core` (the
//! `nfp_ifp` cluster), and `transforms::rotate`'s own module doc repeats
//! that assignment for the pure point-math slice it ported instead
//! (`transforms/mod.rs`: "that TS file's full cache/key/resolver surface
//! belongs to the `nfp_ifp` cluster"). **This task's assignment explicitly
//! overrides that for this one resolver**: the task brief names
//! `transformCollisionGeometryCore.ts` as a source to port in full under
//! `caches/` ("cache key construction + resolver + trusted-ring
//! revalidation + ordered-coordinate fingerprint"), and this resolver's
//! *only* dependencies are `store::GeometryCacheStore`,
//! `geometry_cache_identity`'s key builder, `geometry::convex`, and
//! `transforms::rotate` — no NFP/IFP-specific concept enters it at all,
//! unlike the other two namespaces' resolvers (`nfpBoundaryCore.ts`,
//! `ifpBoundsCore.ts`), which do depend on NFP/IFP construction algorithms
//! and correctly stay out of this module's scope. **Whoever ports the
//! `nfp_ifp` cluster must not re-implement this resolver a second time** —
//! this module (`caches::transform_collision_geometry`) is the single
//! authoritative Rust port of it; the orchestrator should reconcile the
//! semantic-mapping.md row for this one file rather than let two
//! independent implementations exist.
//!
//! # Point-transform math reuse
//!
//! The per-vertex rotate/mirror/snap math (`transformPoint`,
//! `normalizeRotationDegrees`, `snapPointToCollisionGrid`) is **not**
//! duplicated here — `compute_transformed_collision_geometry` below calls
//! `transforms::rotate::{normalize_rotation_degrees, transform_point}`
//! directly (an already-vector-verified port, see that module's own
//! trig-parity doc comment) rather than re-deriving the trig. This module
//! only re-implements `snapPointToCollisionGrid` itself (composing the
//! already-ported `canonical_grid::{to_grid_mm, from_grid}` primitives),
//! because `compute_transformed_collision_geometry` needs the intermediate
//! "is the transformed point finite" check *between* `transformPoint` and
//! the grid-snap step to select the correct one of two distinct TS failure
//! messages (`transformCollisionGeometryCore.ts:81-90`) — `transforms::rotate`'s
//! own `transform_and_snap_point` convenience composition collapses both
//! failure causes into one `None`, which loses that message distinction.

use crate::canonical_grid::{from_grid, to_grid_mm};
use crate::domain::{
    IrregularBounds, IrregularGeometrySettings, IrregularPoint, IrregularPolygon,
    IrregularTransformCandidate, PieceId, TransformedCollisionGeometry,
};
use crate::geometry::convex::{
    bounds_for_points, validate_strict_boundary, StrictConvexBoundaryValidation,
};
use crate::js_number::fold_negative_zero;
use crate::transforms::rotate::{normalize_rotation_degrees, transform_point};

use super::geometry_cache_identity::{
    make_transform_collision_geometry_cache_key, same_transform,
    TransformCollisionGeometryKeyInput, TRANSFORM_GEOMETRY_CACHE_NAMESPACE,
};
use super::store::{charge_transformed_collision_geometry, GeometryCacheKey, GeometryCacheStore};

/// TS: `transformCollisionGeometryCore.ts:18-25`
/// `CoreTransformCollisionSuccess<TPieceId, TTransform>`.
#[derive(Clone, Debug, PartialEq)]
pub struct TransformCollisionSuccess<TValue> {
    pub value: TValue,
    pub key: GeometryCacheKey,
}

/// TS: `transformCollisionGeometryCore.ts:32-35`
/// `CoreTransformCollisionResult<TPieceId, TTransform>`. Modeled as a plain
/// `Result` (this crate's convention for the TS `{ok:true,...} |
/// {ok:false,...}` shape) carrying the bare TS failure `message` string —
/// `transformCollisionGeometryCore.ts`'s own `CoreTransformCollisionFailure`
/// is `{ ok: false, message: string }`, nothing richer.
pub type TransformCollisionResult<TValue> = Result<TransformCollisionSuccess<TValue>, String>;

/// Anything a `materialize` hook may store in the cache for this namespace.
///
/// TS's `resolveTransformedCollisionGeometry` is generic over a
/// `materialize` closure so different call sites can wrap the computed
/// geometry in different domain-class instances (production's
/// `toDomainTransformedCollisionGeometry`, `transformCollisionGeometry.ts:35-48`) —
/// TS's structural typing lets any object shape with these four fields
/// satisfy `isValidCachedTransformedCollisionGeometry`'s checks regardless
/// of its concrete class. This trait is the Rust equivalent seam: any
/// materialized value type implements it by exposing the same four fields,
/// so [`is_valid_cached_transformed_collision_geometry`] can revalidate a
/// cached value without knowing its concrete materialized type, matching
/// TS's duck-typed validity check exactly rather than fixing `TValue` to
/// exactly [`TransformedCollisionGeometry`] and losing the generality the
/// TS resolver's own signature carries.
pub trait TransformedCollisionGeometryLike {
    fn source_piece_id(&self) -> &PieceId;
    fn transform(&self) -> &IrregularTransformCandidate;
    fn polygon(&self) -> &IrregularPolygon;
    fn bounds(&self) -> &IrregularBounds;
}

impl TransformedCollisionGeometryLike for TransformedCollisionGeometry {
    fn source_piece_id(&self) -> &PieceId {
        &self.source_piece_id
    }
    fn transform(&self) -> &IrregularTransformCandidate {
        &self.transform
    }
    fn polygon(&self) -> &IrregularPolygon {
        &self.polygon
    }
    fn bounds(&self) -> &IrregularBounds {
        &self.bounds
    }
}

/// TS: `transformCollisionGeometryCore.ts:37-63`
/// (`resolveTransformedCollisionGeometry`).
///
/// **Exact TS access sequence** (design doc §1.2, `geometry-caches.md` §9.3):
/// 1. Build key — no pre-key validation for this namespace, unlike NFP/IFP;
///    the first cache action is always the `get`.
/// 2. `cache.get(key)`.
/// 3. `isValidCachedTransformedCollisionGeometry(cached, input)`:
///    - **Hit**: return the cached value directly. No `set`. Critically: no
///      call to `materialize()` on a hit — matching TS's `toBe` (not just
///      `toEqual`) test that a repeated resolution returns the identical
///      published value rather than a freshly re-wrapped one.
///    - **Stale**: `cache.remove(key)` strictly before compute, `materialize`,
///      `cache.set`.
///    - **Miss**: compute, materialize, `cache.set` — no `remove`.
/// 4. Compute failure (any of `compute_transformed_collision_geometry`'s
///    four failure sites): return failure; the cache is never written. This
///    happens *after* the single required `get` — the TS file's own doc
///    comment at `transformCollisionGeometryCore.ts:37` names this
///    "key/get-before-validation ordering".
pub fn resolve_transformed_collision_geometry<TValue, F>(
    input: &TransformCollisionGeometryKeyInput<'_>,
    settings: &IrregularGeometrySettings,
    cache: &mut GeometryCacheStore,
    materialize: F,
) -> TransformCollisionResult<TValue>
where
    TValue: TransformedCollisionGeometryLike + Clone + Send + 'static,
    F: FnOnce(TransformedCollisionGeometry) -> TValue,
{
    let key = make_transform_collision_geometry_cache_key(input, settings);
    let cached: Option<TValue> = cache.get(&key);

    if is_valid_cached_transformed_collision_geometry(cached.as_ref(), input) {
        cache.record_hit(TRANSFORM_GEOMETRY_CACHE_NAMESPACE);
        let value = cached.expect("validity check above requires Some");
        return Ok(TransformCollisionSuccess { value, key });
    }

    if cached.is_some() {
        cache.record_stale_detection(TRANSFORM_GEOMETRY_CACHE_NAMESPACE);
        cache.remove(&key);
    }
    // Absence (a genuine miss) was already recorded by `cache.get` above
    // (see `store::GeometryCacheStore::get`'s doc comment) -- nothing more
    // to record here for that branch.

    let computed = compute_transformed_collision_geometry(input)?;
    let value = materialize(computed);
    let _admitted = cache.set(
        &key,
        value.clone(),
        charge_transformed_collision_geometry(&value),
    );
    Ok(TransformCollisionSuccess { value, key })
}

/// TS: `transformCollisionGeometryCore.ts:66-113`
/// (`computeTransformedCollisionGeometry`).
///
/// Four distinct failure sites, in order (`transformCollisionGeometryCore.ts:75,82,88-90,96`):
/// source-boundary invalid; non-finite transformed coordinate;
/// canonical-grid-overflow snap failure; transformed-boundary invalid. A
/// fifth (`:100-101`, empty transformed-bounds) is preserved for literal
/// parity even though it is unreachable once the transformed-boundary check
/// above it has already required `>= 3` finite vertices.
pub fn compute_transformed_collision_geometry(
    input: &TransformCollisionGeometryKeyInput<'_>,
) -> Result<TransformedCollisionGeometry, String> {
    let boundary = validate_strict_boundary(&input.geometry.collision_polygon.points);
    if let StrictConvexBoundaryValidation::Invalid { message } = boundary {
        return Err(message);
    }

    let rotation_deg = normalize_rotation_degrees(input.transform.rotation_deg);
    let mut transformed_points: Vec<IrregularPoint> =
        Vec::with_capacity(input.geometry.collision_polygon.points.len());
    for point in &input.geometry.collision_polygon.points {
        let transformed_point = transform_point(*point, input.transform.mirrored, rotation_deg);
        if !transformed_point.x.is_finite() || !transformed_point.y.is_finite() {
            return Err("transform must produce finite collision polygon coordinates.".to_string());
        }

        let snapped_point = snap_point_to_collision_grid(transformed_point);
        match snapped_point {
            Some(point) => transformed_points.push(point),
            None => return Err(
                "transformed collision polygon coordinates must fit the canonical collision grid."
                    .to_string(),
            ),
        }
    }

    let transformed_boundary = validate_strict_boundary(&transformed_points);
    if let StrictConvexBoundaryValidation::Invalid { message } = transformed_boundary {
        return Err(format!("transformed collision {message}"));
    }

    let transformed_bounds = match bounds_for_points(&transformed_points) {
        Some(bounds) => bounds,
        None => {
            return Err(
                "collision polygon must contain at least one transformable vertex.".to_string(),
            )
        }
    };

    Ok(TransformedCollisionGeometry {
        source_piece_id: input.geometry.source_piece_id.clone(),
        transform: *input.transform,
        polygon: IrregularPolygon::new(transformed_points),
        bounds: transformed_bounds,
    })
}

/// TS: `transformCollisionGeometryCore.ts:115-137`
/// (`isValidCachedTransformedCollisionGeometry`).
pub fn is_valid_cached_transformed_collision_geometry<T: TransformedCollisionGeometryLike>(
    value: Option<&T>,
    input: &TransformCollisionGeometryKeyInput<'_>,
) -> bool {
    let Some(value) = value else {
        return false;
    };
    if value.source_piece_id() != &input.geometry.source_piece_id {
        return false;
    }
    if !same_transform(value.transform(), input.transform) {
        return false;
    }
    if value.polygon().points.len() < 3 {
        return false;
    }
    if matches!(
        validate_strict_boundary(&value.polygon().points),
        StrictConvexBoundaryValidation::Invalid { .. }
    ) {
        return false;
    }
    let Some(computed_bounds) = bounds_for_points(&value.polygon().points) else {
        return false;
    };
    let bounds = value.bounds();
    bounds.min_x == computed_bounds.min_x
        && bounds.min_y == computed_bounds.min_y
        && bounds.max_x == computed_bounds.max_x
        && bounds.max_y == computed_bounds.max_y
}

/// TS: `transformCollisionGeometryCore.ts:139-144` (`snapPointToCollisionGrid`).
/// See this module's top-level doc for why this composes the grid
/// primitives directly instead of reusing `transforms::rotate::transform_and_snap_point`.
fn snap_point_to_collision_grid(point: IrregularPoint) -> Option<IrregularPoint> {
    let x = to_grid_mm(point.x)?;
    let y = to_grid_mm(point.y)?;
    Some(IrregularPoint::new(
        fold_negative_zero(from_grid(x)),
        fold_negative_zero(from_grid(y)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CollisionGeometry, IrregularTransformReason, PieceId};

    fn square(side: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(side, 0.0),
            IrregularPoint::new(side, side),
            IrregularPoint::new(0.0, side),
        ])
    }

    fn sample_geometry() -> CollisionGeometry {
        let polygon = square(4.0);
        CollisionGeometry {
            source_piece_id: PieceId::new("piece-1"),
            source_bounds: IrregularBounds::new(0.0, 0.0, 4.0, 4.0),
            sampled_points: vec![],
            convex_hull: polygon.clone(),
            collision_polygon: polygon,
            placement_reference: IrregularPoint::new(0.0, 0.0),
            diagnostics: vec![],
        }
    }

    fn transform(rotation_deg: f64, mirrored: bool) -> IrregularTransformCandidate {
        IrregularTransformCandidate {
            index: 0.0,
            rotation_deg,
            mirrored,
            reason: IrregularTransformReason::Orthogonal,
        }
    }

    #[test]
    fn compute_rejects_a_non_convex_source_boundary() {
        let mut geometry = sample_geometry();
        geometry.collision_polygon = IrregularPolygon::new(vec![IrregularPoint::new(0.0, 0.0)]);
        let transform = transform(0.0, false);
        let input = TransformCollisionGeometryKeyInput {
            geometry: &geometry,
            transform: &transform,
        };
        let result = compute_transformed_collision_geometry(&input);
        assert_eq!(
            result.unwrap_err(),
            "polygon must contain at least three vertices."
        );
    }

    #[test]
    fn compute_applies_a_quarter_turn_rotation_and_reports_finite_bounds() {
        let geometry = sample_geometry();
        let transform = transform(90.0, false);
        let input = TransformCollisionGeometryKeyInput {
            geometry: &geometry,
            transform: &transform,
        };
        let result = compute_transformed_collision_geometry(&input).expect("rotation succeeds");
        assert_eq!(result.source_piece_id, PieceId::new("piece-1"));
        assert_eq!(result.bounds, IrregularBounds::new(-4.0, 0.0, 0.0, 4.0));
    }

    #[test]
    fn compute_folds_negative_zero_in_transformed_coordinates() {
        // Mirroring x=0 negates to -0, which must fold back to +0 at
        // rotation 0 (matches `transformPoint`'s own fold behavior).
        let mut geometry = sample_geometry();
        geometry.collision_polygon = IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(4.0, 0.0),
            IrregularPoint::new(4.0, 4.0),
            IrregularPoint::new(0.0, 4.0),
        ]);
        let transform = transform(0.0, true);
        let input = TransformCollisionGeometryKeyInput {
            geometry: &geometry,
            transform: &transform,
        };
        let result = compute_transformed_collision_geometry(&input).expect("mirror succeeds");
        let first = result.polygon.points[0];
        assert_eq!(first.x.to_bits(), 0.0_f64.to_bits());
    }

    fn settings() -> IrregularGeometrySettings {
        IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "irregular-convex-v2-default".to_string(),
            geometry_backend_version: "0".to_string(),
        }
    }

    #[test]
    fn resolver_computes_and_stores_on_a_miss_then_hits_without_recomputing() {
        let geometry = sample_geometry();
        let transform_candidate = transform(90.0, false);
        let settings = settings();
        let mut cache = GeometryCacheStore::new();

        let mut materialize_calls = 0u32;
        let input = TransformCollisionGeometryKeyInput {
            geometry: &geometry,
            transform: &transform_candidate,
        };
        let first =
            resolve_transformed_collision_geometry(&input, &settings, &mut cache, |computed| {
                materialize_calls += 1;
                computed
            })
            .expect("first resolution succeeds");
        assert_eq!(materialize_calls, 1);
        let namespace_counters = cache
            .telemetry()
            .namespace(TRANSFORM_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(namespace_counters.lookups, 1);
        assert_eq!(namespace_counters.misses, 1);
        assert_eq!(namespace_counters.stores, 1);

        let input = TransformCollisionGeometryKeyInput {
            geometry: &geometry,
            transform: &transform_candidate,
        };
        let second =
            resolve_transformed_collision_geometry(&input, &settings, &mut cache, |computed| {
                materialize_calls += 1;
                computed
            })
            .expect("second resolution is a cache hit");
        // materialize() must not run again on a hit.
        assert_eq!(materialize_calls, 1);
        assert_eq!(first.value, second.value);
        let namespace_counters = cache
            .telemetry()
            .namespace(TRANSFORM_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(namespace_counters.lookups, 2);
        assert_eq!(namespace_counters.hits, 1);
        assert_eq!(namespace_counters.stores, 1);
    }

    #[test]
    fn resolver_never_writes_the_cache_when_compute_fails() {
        let mut geometry = sample_geometry();
        geometry.collision_polygon = IrregularPolygon::new(vec![IrregularPoint::new(0.0, 0.0)]);
        let transform_candidate = transform(0.0, false);
        let settings = settings();
        let mut cache = GeometryCacheStore::new();
        let input = TransformCollisionGeometryKeyInput {
            geometry: &geometry,
            transform: &transform_candidate,
        };
        let result =
            resolve_transformed_collision_geometry(&input, &settings, &mut cache, |computed| {
                computed
            });
        assert!(result.is_err());
        let namespace_counters = cache
            .telemetry()
            .namespace(TRANSFORM_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(namespace_counters.lookups, 1);
        assert_eq!(namespace_counters.misses, 1);
        assert_eq!(namespace_counters.stores, 0);
    }

    #[test]
    fn resolver_evicts_and_recomputes_a_stale_entry_whose_transform_no_longer_matches() {
        let geometry = sample_geometry();
        let original_transform = transform(0.0, false);
        let settings = settings();
        let mut cache = GeometryCacheStore::new();
        let key_input = TransformCollisionGeometryKeyInput {
            geometry: &geometry,
            transform: &original_transform,
        };
        // Publish a value directly under the key this input would build,
        // but with a transform that no longer matches `original_transform`
        // -- simulating a stale cached artifact (design doc's exact stale
        // scenario: `sameTransform` fails, so a fresh lookup must evict).
        let key = make_transform_collision_geometry_cache_key(&key_input, &settings);
        let stale_value = TransformedCollisionGeometry {
            source_piece_id: PieceId::new("piece-1"),
            transform: transform(180.0, false),
            polygon: square(4.0),
            bounds: IrregularBounds::new(0.0, 0.0, 4.0, 4.0),
        };
        let stale_charge = charge_transformed_collision_geometry(&stale_value);
        assert!(cache.set(&key, stale_value, stale_charge));

        let mut materialize_calls = 0u32;
        let result =
            resolve_transformed_collision_geometry(&key_input, &settings, &mut cache, |computed| {
                materialize_calls += 1;
                computed
            })
            .expect("recompute succeeds after stale eviction");
        assert_eq!(materialize_calls, 1);
        assert_eq!(result.value.transform, original_transform);
        let namespace_counters = cache
            .telemetry()
            .namespace(TRANSFORM_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(namespace_counters.stale_detections, 1);
        assert_eq!(namespace_counters.stale_removals, 1);
        assert_eq!(namespace_counters.stores, 2);
    }
}
