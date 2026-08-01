//! Pairwise relative-NFP construction, resolution, and translation.
//!
//! TS source: `src/workers/irregular/core/nfpBoundaryCore.ts` (509 lines),
//! read in full. Namespace `pairwise-nfp-relative-v3`
//! (`cache-concurrency-design.md` §1.1, `nfp-ifp.md` §9.A).
//!
//! # `validatedRings` WeakMap fingerprint memo — not ported
//!
//! TS's module-level `validatedRings` (`nfpBoundaryCore.ts:31-37`) is a
//! transparent, process-lifetime, object-identity-keyed cache around
//! `ConvexPolygonValidation.validateStrictBoundary` that always returns
//! exactly what a direct call would return (`cache-concurrency-design.md`
//! §1.5, `nfp-ifp.md` §4/§12 point 5: "provably transparent... Rust's
//! ownership model does not have the mutable-aliased-array iterator/index
//! divergence hazard this memo defends against... do not port this memo as
//! a shared/concurrent cache primitive"). Every call site below that would
//! have gone through TS's `validateStrictBoundaryOnce` instead calls
//! [`crate::geometry::convex::validate_strict_boundary`] directly — the
//! outcome (deterministic validation per ring content) is identical; only
//! the JS-process-lifetime memoization is omitted, per the design doc's
//! explicit disposition.
//!
//! # Reuse
//!
//! Cache key construction, the store, and its telemetry hooks are owned by
//! `caches` (imported, never re-implemented): [`crate::caches::GeometryCacheStore`],
//! [`crate::caches::make_pairwise_nfp_cache_key`],
//! [`crate::caches::PairwiseNfpKeyInput`],
//! [`crate::caches::NfpConstructionAlgorithm`],
//! [`crate::caches::NFP_GEOMETRY_CACHE_NAMESPACE`]. Convex-hull construction
//! and strict-boundary validation are owned by `geometry::convex` (imported,
//! never re-implemented).

use std::collections::HashSet;

use crate::caches::{
    charge_nfp_polygon, make_pairwise_nfp_cache_key, serialize_geometry_cache_key,
    GeometryCacheKey, GeometryCacheStore, NfpConstructionAlgorithm, PairwiseNfpKeyInput,
    NFP_GEOMETRY_CACHE_NAMESPACE,
};
use crate::domain::{
    IrregularGeometrySettings, IrregularPlacedPiece, IrregularPoint, IrregularPolygon,
    TransformedCollisionGeometry,
};
use crate::geometry::convex::{
    compute_convex_hull, validate_strict_boundary, ConvexPolygonWinding,
    StrictConvexBoundaryValidation,
};
use crate::geometry::predicates;
use crate::js_number::js_math;

const ORIGIN: IrregularPoint = IrregularPoint { x: 0.0, y: 0.0 };

/// TS: `nfpBoundaryCore.ts:90-108` (`CoreNfpInput`).
///
/// TS's nested `fixed.collisionGeometry`/`fixed.placement.transform` shape
/// is exactly `crate::domain::IrregularPlacedPiece`'s own field layout
/// (`placement.transform.{translate_x,translate_y}`,
/// `collision_geometry.{polygon,transform}`), and TS's `moving` shape is
/// exactly `crate::domain::TransformedCollisionGeometry`'s layout — this
/// port reuses those trusted domain carriers directly rather than declaring
/// a second, structurally-identical pair of structs (this crate's
/// established convention; see `caches::nfp_cache_key::PairwiseNfpKeyInput`'s
/// doc comment for the same reasoning).
pub struct CoreNfpInput<'a> {
    pub fixed: &'a IrregularPlacedPiece,
    pub moving: &'a TransformedCollisionGeometry,
    pub settings: &'a IrregularGeometrySettings,
}

/// TS: `nfpBoundaryCore.ts:110-114` (`CoreNfpSuccess`).
#[derive(Clone, Debug, PartialEq)]
pub struct CoreNfpSuccess {
    pub boundary: IrregularPolygon,
    pub key: GeometryCacheKey,
}

/// TS: `nfpBoundaryCore.ts:116-119`/`:121-122` (`CoreNfpFailure`,
/// `CoreNfpResult`, `CoreNfpBoundaryConstructionResult`). Modeled as a plain
/// `Result` carrying the bare TS failure `message` string, matching this
/// crate's established convention for the TS `{ok:true,...} | {ok:false,
/// message}` shape (see `caches::transform_collision_geometry::TransformCollisionResult`'s
/// doc comment).
pub type CoreNfpResult = Result<CoreNfpSuccess, String>;
pub type CoreNfpBoundaryConstructionResult = Result<IrregularPolygon, String>;

/// TS: `nfpBoundaryCore.ts:125-167` (`resolveNfpBoundary`). Resolves one
/// relative NFP through a synchronous store and translates it into sheet
/// space.
///
/// **Exact TS access sequence** (`cache-concurrency-design.md` §1.1,
/// `nfp-ifp.md` §9.A), preserved step-for-step:
/// 1. Validate fixed ring — fail before any key/cache action.
/// 2. Validate moving ring — same short-circuit.
/// 3. Build key.
/// 4. `cache.get(key)` — exactly one `get` regardless of outcome.
/// 5. `isValidCachedNfpBoundary(cached)`: valid hit uses it directly (no
///    recompute, no `set`); stale (`cached` was `Some` but invalid) evicts
///    strictly before recompute; miss recomputes with no `remove`.
/// 6. Recompute failure returns immediately; **the cache is never written**.
/// 7. Recompute success publishes — publish-on-recompute-success is
///    unconditional on the *relative* computation succeeding, not on the
///    whole call succeeding.
/// 8. `translateNfpBoundary` runs unconditionally after the cache decision,
///    on every call, hit or miss, and never touches the cache. A
///    translation failure here does **not** roll back the already-published
///    relative-boundary cache entry from step 7 — the shared relative NFP
///    stays valid for other fixed placements of the same
///    canonically-equivalent geometry even though *this* call returns
///    failure.
pub fn resolve_nfp_boundary(
    input: &CoreNfpInput<'_>,
    cache: &mut GeometryCacheStore,
    construction_algorithm: NfpConstructionAlgorithm,
) -> CoreNfpResult {
    if let StrictConvexBoundaryValidation::Invalid { message } =
        validate_strict_boundary(&input.fixed.collision_geometry.polygon.points)
    {
        return Err(message);
    }
    if let StrictConvexBoundaryValidation::Invalid { message } =
        validate_strict_boundary(&input.moving.polygon.points)
    {
        return Err(message);
    }

    let key_input = PairwiseNfpKeyInput {
        fixed_polygon: &input.fixed.collision_geometry.polygon.points,
        moving_polygon: &input.moving.polygon.points,
        fixed_transform: &input.fixed.collision_geometry.transform,
        moving_transform: &input.moving.transform,
        settings: input.settings,
    };
    let key = make_pairwise_nfp_cache_key(&key_input, construction_algorithm);

    let cached: Option<IrregularPolygon> = cache.get(&key);
    let relative_boundary: IrregularPolygon = if is_valid_cached_nfp_boundary(cached.as_ref()) {
        cache.record_hit(NFP_GEOMETRY_CACHE_NAMESPACE);
        cached.expect("validity check above requires Some")
    } else {
        if cached.is_some() {
            cache.record_stale_detection(NFP_GEOMETRY_CACHE_NAMESPACE);
            cache.remove(&key);
        }
        let computed = compute_relative_nfp_boundary(
            &input.fixed.collision_geometry.polygon.points,
            &input.moving.polygon.points,
            construction_algorithm,
        )?;
        let _admitted = cache.set(&key, computed.clone(), charge_nfp_polygon(&computed));
        computed
    };

    let translated = translate_nfp_boundary(input, &relative_boundary)?;
    Ok(CoreNfpSuccess {
        boundary: translated,
        key,
    })
}

/// `PAR-CACHE-01`/`PAR-NFP-01`
/// (`docs/planning/rust-irregular-backend/parallelism-inventory.md` §3.2-3.3,
/// `cache-concurrency-design.md` §7). A compute-then-publish pre-pass for
/// the per-placed-piece NFP resolution loop
/// (`nfp_ifp::candidates::generate_placement_candidates_uncached`'s
/// `for placed in input.placed` loop): walks `placed` once, serially, in
/// its original order, to determine the exact deduplicated set of
/// pairwise-NFP cache keys that loop's later, **unmodified** calls to
/// [`resolve_nfp_boundary`] would find missing -- then dispatches the pure
/// [`compute_relative_nfp_boundary`] computation for that deduplicated set
/// across this job's Rayon pool (`boundary::parallel::with_job_pool`), and
/// publishes every successfully-computed result into `cache` serially, in
/// the exact order each key was first encountered.
///
/// **No cache mutation from worker threads.** Every `cache` read
/// (`GeometryCacheStore::get`) and write (`GeometryCacheStore::set`) in
/// this function happens on the calling (serial) thread, strictly before or
/// strictly after the parallel `map` -- worker closures receive only plain
/// point slices and return plain `Option<IrregularPolygon>` values, never a
/// cache reference. This satisfies `cache-concurrency-design.md` §7's
/// "compute-then-publish" requirement without requiring the concurrent-safe
/// cache architecture Stage 3 left as a `NEEDS-MEASUREMENT` open question
/// (`parallelism-inventory.md` PAR-CACHE-03) -- this function never lets two
/// threads race the same cache key at all.
///
/// **A precompute failure is silently discarded, never surfaced as an
/// error.** If [`compute_relative_nfp_boundary`] fails for some key in the
/// deduplicated batch, this function simply does not publish anything for
/// that key -- it does not attempt to reproduce
/// [`resolve_nfp_boundary`]'s exact ring-validation error message/ordering
/// here. The **immediately-following, completely unmodified** per-placed
/// loop independently re-validates rings and re-attempts computation for
/// any key this pass could not resolve, in its own original per-piece
/// order, and therefore still produces the exact same
/// first-sequentially-encountered error [`resolve_nfp_boundary`] would have
/// raised had this pre-pass never run (`PAR-XCUT-02`). A successful
/// precompute always publishes a value bit-identical to what that same
/// per-piece loop's own call to [`resolve_nfp_boundary`] would have
/// computed and published (same key-construction function, same pure
/// compute function, same inputs) -- so the loop finds a cache **hit**
/// instead of triggering its own recompute for those keys, with the
/// *value* returned being identical either way. Cache-telemetry
/// hit/miss/stale-detection *counts* may differ slightly from a fully
/// serial run as a result; per `cache-concurrency-design.md` §7 and this
/// crate's diagnostics-sidecar convention, that telemetry is
/// non-authoritative and never hashed, so this is not a parity concern.
///
/// **No cancellation-checkpoint observation of its own (ruling R19).** This
/// function never calls `nfp_checkpoint`/consults `NfpIfpControl` -- the
/// existing `PlacedNfp`-phase checkpoints inside the real, unmodified
/// per-placed loop remain the sole cancellation-observation boundary for
/// this whole batch, exactly as before this pre-pass existed. If the job is
/// cancelled during this pre-pass's parallel dispatch, the pre-pass still
/// runs to completion and may publish extra (but still correct) cache
/// entries; the real loop's very next checkpoint call aborts the whole
/// `generate_placement_candidates_uncached` call before any of those
/// entries are used to produce output -- no partial result is ever
/// observable (migration-prompt §15).
pub fn precompute_missing_relative_nfp_boundaries(
    placed: &[std::sync::Arc<IrregularPlacedPiece>],
    moving: &TransformedCollisionGeometry,
    settings: &IrregularGeometrySettings,
    cache: &mut GeometryCacheStore,
    construction_algorithm: NfpConstructionAlgorithm,
) {
    if let StrictConvexBoundaryValidation::Invalid { .. } =
        validate_strict_boundary(&moving.polygon.points)
    {
        // Every iteration of the real loop validates `moving` too (it is
        // the same `moving` argument on every iteration); if that
        // validation would fail, every iteration fails before ever
        // touching the cache, so there is nothing this pre-pass could
        // usefully precompute.
        return;
    }

    // Phase 1 (serial): the exact deduplicated set of missing keys, in
    // first-encounter order -- `parallelism-inventory.md`'s "ordinal =
    // position in the deduplicated key list assembled before dispatch"
    // (PAR-CACHE-01's stable-index scheme).
    let mut seen_keys: HashSet<String> = HashSet::new();
    let mut misses: Vec<(GeometryCacheKey, Vec<IrregularPoint>)> = Vec::new();
    for placed_piece in placed {
        if let StrictConvexBoundaryValidation::Invalid { .. } =
            validate_strict_boundary(&placed_piece.collision_geometry.polygon.points)
        {
            continue;
        }
        let key_input = PairwiseNfpKeyInput {
            fixed_polygon: &placed_piece.collision_geometry.polygon.points,
            moving_polygon: &moving.polygon.points,
            fixed_transform: &placed_piece.collision_geometry.transform,
            moving_transform: &moving.transform,
            settings,
        };
        let key = make_pairwise_nfp_cache_key(&key_input, construction_algorithm);
        if !seen_keys.insert(serialize_geometry_cache_key(&key)) {
            continue;
        }
        if matches!(
            cache.probe_valid::<IrregularPolygon>(&key, |cached| {
                is_valid_cached_nfp_boundary(Some(cached))
            }),
            crate::caches::GeometryCacheProbe::HotValid
        ) {
            continue;
        }
        misses.push((key, placed_piece.collision_geometry.polygon.points.clone()));
    }

    if misses.is_empty() {
        return;
    }

    // Phase 2 (parallel): pure compute only -- no `cache` reference reaches
    // any worker closure. `map_slice_with_job_pool` degrades to ordinary
    // serial iteration when no job pool is installed (never Rayon's ambient
    // global pool) and preserves `misses`'s first-encounter order either
    // way.
    let moving_points = &moving.polygon.points;
    let computed: Vec<Option<IrregularPolygon>> =
        crate::boundary::parallel::map_slice_with_job_pool(&misses, |(_, fixed_points)| {
            compute_relative_nfp_boundary(fixed_points, moving_points, construction_algorithm).ok()
        });

    // Phase 3 (serial): publish successes only, strictly in the order their
    // keys were first encountered in Phase 1.
    for ((key, _), boundary) in misses.into_iter().zip(computed) {
        if let Some(boundary) = boundary {
            let charge = charge_nfp_polygon(&boundary);
            let _admitted = cache.set(&key, boundary, charge);
        }
    }
}

/// TS: `nfpBoundaryCore.ts:169-177` (`computeRelativeNfpBoundary`).
pub fn compute_relative_nfp_boundary(
    fixed_points: &[IrregularPoint],
    moving_points: &[IrregularPoint],
    construction_algorithm: NfpConstructionAlgorithm,
) -> CoreNfpBoundaryConstructionResult {
    match construction_algorithm {
        NfpConstructionAlgorithm::LinearEdgeMerge => {
            compute_relative_nfp_boundary_linear(fixed_points, moving_points)
        }
        NfpConstructionAlgorithm::VertexPairHull => {
            compute_relative_nfp_boundary_reference(fixed_points, moving_points)
        }
    }
}

/// TS: `nfpBoundaryCore.ts:179-247` (`canonicalizeTranslatedConvexRing`).
/// Removes exact cyclic repeats and redundant collinear vertices in linear
/// time via a doubly-linked-list peel over `points`' indices.
///
/// Several TS `=== undefined` guards on this function's internally derived
/// index arrays are omitted here: `previousIndexes`/`nextIndexes` are built
/// as a `usize` array the same length as `points` via modulo arithmetic, so
/// every index they ever produce is always in-bounds by construction — the
/// TS guards exist only to satisfy `noUncheckedIndexedAccess`, not because
/// the branch is ever reachable (this crate's established convention; see
/// `geometry::convex::build_hull_half`'s own comment on the identical
/// pattern).
pub fn canonicalize_translated_convex_ring(
    points: &[IrregularPoint],
) -> CoreNfpBoundaryConstructionResult {
    let len = points.len();
    if len < 3 {
        return Err("polygon must contain at least three vertices.".to_string());
    }

    let mut previous_indexes: Vec<usize> = (0..len).map(|index| (index + len - 1) % len).collect();
    let mut next_indexes: Vec<usize> = (0..len).map(|index| (index + 1) % len).collect();
    let mut active: Vec<bool> = vec![true; len];
    let mut pending_indexes: Vec<usize> = (0..len).collect();
    let mut active_count = len;

    let mut pending_cursor = 0usize;
    while pending_cursor < pending_indexes.len() {
        let current_index = pending_indexes[pending_cursor];
        pending_cursor += 1;
        if !active[current_index] {
            continue;
        }
        if active_count < 3 {
            return Err("polygon must contain at least three vertices.".to_string());
        }

        let previous_index = previous_indexes[current_index];
        let next_index = next_indexes[current_index];
        let previous_point = points[previous_index];
        let current_point = points[current_index];
        let next_point = points[next_index];

        let repeated =
            points_equal(previous_point, current_point) || points_equal(current_point, next_point);
        let collinear = orientation_of(previous_point, current_point, next_point) == 0
            && point_is_between(previous_point, current_point, next_point);
        if !repeated && !collinear {
            continue;
        }

        active[current_index] = false;
        active_count -= 1;
        if active_count < 3 {
            return Err("polygon must contain at least three vertices.".to_string());
        }
        next_indexes[previous_index] = next_index;
        previous_indexes[next_index] = previous_index;
        pending_indexes.push(previous_index);
        pending_indexes.push(next_index);
    }

    let first_active_index = match active.iter().position(|&is_active| is_active) {
        Some(index) if active_count >= 3 => index,
        _ => return Err("polygon must contain at least three vertices.".to_string()),
    };

    let mut canonical_points: Vec<IrregularPoint> = Vec::with_capacity(active_count);
    let mut current_index = first_active_index;
    loop {
        canonical_points.push(points[current_index]);
        current_index = next_indexes[current_index];
        if current_index == first_active_index {
            break;
        }
    }

    if canonical_points.len() != active_count {
        return Err("polygon points must form a closed boundary.".to_string());
    }

    match validate_strict_boundary(&canonical_points) {
        StrictConvexBoundaryValidation::Invalid { message } => Err(message),
        StrictConvexBoundaryValidation::Valid { .. } => Ok(IrregularPolygon::new(
            rotate_to_stable_start(&canonical_points),
        )),
    }
}

/// TS: `nfpBoundaryCore.ts:249-253` (`isValidCachedNfpBoundary`). `value`
/// is already statically typed by the cache's `downcast_ref` (see
/// `caches::store`'s module doc), so the TS runtime `typeof`/`null`/
/// `Array.isArray` shape guards have no Rust equivalent to preserve — only
/// the point-count and re-validation checks remain.
pub fn is_valid_cached_nfp_boundary(value: Option<&IrregularPolygon>) -> bool {
    let Some(value) = value else {
        return false;
    };
    if value.points.len() < 3 {
        return false;
    }
    !matches!(
        validate_strict_boundary(&value.points),
        StrictConvexBoundaryValidation::Invalid { .. }
    )
}

/// TS: `nfpBoundaryCore.ts:255-276` (`computeRelativeNfpBoundaryReference`).
/// The pairwise vertex-sum hull construction; production default
/// (`NfpConstructionAlgorithm::VertexPairHull`).
pub fn compute_relative_nfp_boundary_reference(
    fixed_points: &[IrregularPoint],
    moving_points: &[IrregularPoint],
) -> CoreNfpBoundaryConstructionResult {
    validate_relative_nfp_inputs(fixed_points, moving_points)?;

    let negated_moving_points: Vec<IrregularPoint> = moving_points
        .iter()
        .map(|point| IrregularPoint::new(-point.x, -point.y))
        .collect();
    let mut minkowski_points: Vec<IrregularPoint> =
        Vec::with_capacity(fixed_points.len() * negated_moving_points.len());
    for &fixed_point in fixed_points {
        for &moving_point in &negated_moving_points {
            minkowski_points.push(sum_points(fixed_point, moving_point, "Minkowski sum")?);
        }
    }

    let boundary = compute_convex_hull(&minkowski_points);
    match validate_strict_boundary(&boundary.points) {
        StrictConvexBoundaryValidation::Invalid { message } => Err(message),
        StrictConvexBoundaryValidation::Valid { .. } => Ok(IrregularPolygon::new(
            rotate_to_stable_start(&boundary.points),
        )),
    }
}

/// TS: `nfpBoundaryCore.ts:278-358` (`computeRelativeNfpBoundaryLinear`).
/// The explicit edge-direction-merge construction. Not selected by any
/// production caller (`nfp-ifp.md` §1), but a real, tested,
/// differential-oracle code path that must round-trip through this key
/// builder exactly like the production algorithm.
pub fn compute_relative_nfp_boundary_linear(
    fixed_points: &[IrregularPoint],
    moving_points: &[IrregularPoint],
) -> CoreNfpBoundaryConstructionResult {
    let validated = validate_relative_nfp_inputs(fixed_points, moving_points)?;

    let fixed_boundary = counter_clockwise_stable_points(fixed_points, validated.fixed_winding);
    let negated_moving_points: Vec<IrregularPoint> = moving_points
        .iter()
        .map(|point| IrregularPoint::new(-point.x, -point.y))
        .collect();
    let moving_boundary =
        counter_clockwise_stable_points(&negated_moving_points, validated.moving_winding);
    let fixed_edges = edge_vectors(&fixed_boundary)?;
    let moving_edges = edge_vectors(&moving_boundary)?;

    // `fixed_boundary`/`moving_boundary` each have >= 3 points (already
    // validated above), so index `0` and every `% .len()` access below are
    // always in-bounds; the TS `=== undefined` guards on these have no
    // reachable Rust counterpart (see this module's `canonicalize_translated_convex_ring`
    // doc comment for the same convention).
    let initial_fixed_point = fixed_boundary[0];
    let initial_moving_point = moving_boundary[0];
    let initial_sum = sum_points(initial_fixed_point, initial_moving_point, "Minkowski sum")?;

    let mut fixed_edge_index = 0usize;
    let mut moving_edge_index = 0usize;
    let mut boundary_points: Vec<IrregularPoint> = vec![initial_sum];
    while fixed_edge_index < fixed_edges.len() || moving_edge_index < moving_edges.len() {
        if fixed_edge_index < fixed_edges.len() && moving_edge_index < moving_edges.len() {
            let fixed_edge = fixed_edges[fixed_edge_index];
            let moving_edge = moving_edges[moving_edge_index];
            let direction_order = compare_edge_directions(fixed_edge, moving_edge);
            if direction_order <= 0 {
                fixed_edge_index += 1;
            }
            if direction_order >= 0 {
                moving_edge_index += 1;
            }
        } else if fixed_edge_index < fixed_edges.len() {
            fixed_edge_index += 1;
        } else {
            moving_edge_index += 1;
        }

        let next_fixed_point = fixed_boundary[fixed_edge_index % fixed_boundary.len()];
        let next_moving_point = moving_boundary[moving_edge_index % moving_boundary.len()];
        let next_sum = sum_points(next_fixed_point, next_moving_point, "Minkowski sum")?;
        if fixed_edge_index < fixed_edges.len() || moving_edge_index < moving_edges.len() {
            boundary_points.push(next_sum);
        }
    }

    if let Ok(canonical_boundary) = canonicalize_translated_convex_ring(&boundary_points) {
        if let StrictConvexBoundaryValidation::Valid { winding } =
            validate_strict_boundary(&canonical_boundary.points)
        {
            let counter_clockwise_points = if winding == 1 {
                canonical_boundary.points
            } else {
                let mut reversed = canonical_boundary.points.clone();
                reversed.reverse();
                reversed
            };
            return Ok(IrregularPolygon::new(rotate_to_stable_start(
                &counter_clockwise_points,
            )));
        }
    }

    let boundary = compute_convex_hull(&boundary_points);
    match validate_strict_boundary(&boundary.points) {
        StrictConvexBoundaryValidation::Invalid { message } => Err(message),
        StrictConvexBoundaryValidation::Valid { winding } => {
            let counter_clockwise_points = if winding == 1 {
                boundary.points
            } else {
                let mut reversed = boundary.points.clone();
                reversed.reverse();
                reversed
            };
            Ok(IrregularPolygon::new(rotate_to_stable_start(
                &counter_clockwise_points,
            )))
        }
    }
}

/// TS: `nfpBoundaryCore.ts:360-364` (`ValidatedRelativeNfpInputs`).
struct ValidatedRelativeNfpInputs {
    fixed_winding: ConvexPolygonWinding,
    moving_winding: ConvexPolygonWinding,
}

/// TS: `nfpBoundaryCore.ts:366-384` (`validateRelativeNfpInputs`).
fn validate_relative_nfp_inputs(
    fixed_points: &[IrregularPoint],
    moving_points: &[IrregularPoint],
) -> Result<ValidatedRelativeNfpInputs, String> {
    if let Some(message) = finite_points_message(fixed_points) {
        return Err(message);
    }
    if let Some(message) = finite_points_message(moving_points) {
        return Err(message);
    }

    let fixed_winding = match validate_strict_boundary(fixed_points) {
        StrictConvexBoundaryValidation::Invalid { message } => return Err(message),
        StrictConvexBoundaryValidation::Valid { winding } => winding,
    };
    let moving_winding = match validate_strict_boundary(moving_points) {
        StrictConvexBoundaryValidation::Invalid { message } => return Err(message),
        StrictConvexBoundaryValidation::Valid { winding } => winding,
    };
    Ok(ValidatedRelativeNfpInputs {
        fixed_winding,
        moving_winding,
    })
}

/// TS: `nfpBoundaryCore.ts:386-390` (`finitePointsMessage`).
fn finite_points_message(points: &[IrregularPoint]) -> Option<String> {
    if points
        .iter()
        .all(|point| point.x.is_finite() && point.y.is_finite())
    {
        None
    } else {
        Some("polygon coordinates must be finite.".to_string())
    }
}

/// TS: `nfpBoundaryCore.ts:392-398` (`counterClockwiseStablePoints`).
fn counter_clockwise_stable_points(
    points: &[IrregularPoint],
    winding: ConvexPolygonWinding,
) -> Vec<IrregularPoint> {
    let mut ordered: Vec<IrregularPoint> = points.to_vec();
    if winding != 1 {
        ordered.reverse();
    }
    rotate_to_stable_start(&ordered)
}

/// TS: `nfpBoundaryCore.ts:400-418` (`edgeVectors`). The TS
/// `start === undefined || end === undefined` guard is unreachable here: both
/// indices are always `< points.len()` by construction (see this module's
/// index-guard convention note on `canonicalize_translated_convex_ring`).
fn edge_vectors(points: &[IrregularPoint]) -> Result<Vec<IrregularPoint>, String> {
    let len = points.len();
    let mut vectors = Vec::with_capacity(len);
    for index in 0..len {
        let start = points[index];
        let end = points[(index + 1) % len];
        let x = end.x - start.x;
        let y = end.y - start.y;
        if !x.is_finite() || !y.is_finite() {
            return Err("Minkowski edge arithmetic must produce finite vectors.".to_string());
        }
        vectors.push(IrregularPoint::new(x, y));
    }
    Ok(vectors)
}

/// TS: `nfpBoundaryCore.ts:420-429` (`compareEdgeDirections`).
fn compare_edge_directions(first_edge: IrregularPoint, second_edge: IrregularPoint) -> i32 {
    let first_half = edge_direction_half(first_edge);
    let second_half = edge_direction_half(second_edge);
    if first_half != second_half {
        return if first_half < second_half { -1 } else { 1 };
    }

    let direction_turn = orientation_of(ORIGIN, first_edge, second_edge);
    if direction_turn > 0 {
        -1
    } else if direction_turn < 0 {
        1
    } else {
        0
    }
}

/// TS: `nfpBoundaryCore.ts:431-433` (`edgeDirectionHalf`).
fn edge_direction_half(edge: IrregularPoint) -> i32 {
    if edge.y > 0.0 || (edge.y == 0.0 && edge.x >= 0.0) {
        0
    } else {
        1
    }
}

/// TS: `nfpBoundaryCore.ts:435-446` (`sumPoints`).
fn sum_points(
    first_point: IrregularPoint,
    second_point: IrregularPoint,
    operation: &str,
) -> Result<IrregularPoint, String> {
    let x = first_point.x + second_point.x;
    let y = first_point.y + second_point.y;
    if !x.is_finite() || !y.is_finite() {
        return Err(format!("{operation} must produce finite coordinates."));
    }
    Ok(IrregularPoint::new(x, y))
}

/// TS: `nfpBoundaryCore.ts:448-450` (`pointsEqual`).
fn points_equal(first_point: IrregularPoint, second_point: IrregularPoint) -> bool {
    first_point.x == second_point.x && first_point.y == second_point.y
}

/// TS: `nfpBoundaryCore.ts:452-463` (`pointIsBetween`).
fn point_is_between(
    first_point: IrregularPoint,
    point: IrregularPoint,
    second_point: IrregularPoint,
) -> bool {
    point.x >= js_math::min(first_point.x, second_point.x)
        && point.x <= js_math::max(first_point.x, second_point.x)
        && point.y >= js_math::min(first_point.y, second_point.y)
        && point.y <= js_math::max(first_point.y, second_point.y)
}

/// TS: `nfpBoundaryCore.ts:465-482` (`translateNfpBoundary`).
fn translate_nfp_boundary(
    input: &CoreNfpInput<'_>,
    relative_boundary: &IrregularPolygon,
) -> CoreNfpBoundaryConstructionResult {
    let mut translated_points: Vec<IrregularPoint> =
        Vec::with_capacity(relative_boundary.points.len());
    for point in &relative_boundary.points {
        let x = point.x + input.fixed.placement.transform.translate_x;
        let y = point.y + input.fixed.placement.transform.translate_y;
        if !x.is_finite() || !y.is_finite() {
            return Err("fixed translation must produce finite coordinates.".to_string());
        }
        translated_points.push(IrregularPoint::new(x, y));
    }

    match canonicalize_translated_convex_ring(&translated_points) {
        Ok(boundary) => Ok(boundary),
        Err(_) => canonicalize_translated_convex_ring_with_hull_fallback(&translated_points),
    }
}

/// TS: `nfpBoundaryCore.ts:484-492`
/// (`canonicalizeTranslatedConvexRingWithHullFallback`).
fn canonicalize_translated_convex_ring_with_hull_fallback(
    points: &[IrregularPoint],
) -> CoreNfpBoundaryConstructionResult {
    let boundary = compute_convex_hull(points);
    match validate_strict_boundary(&boundary.points) {
        StrictConvexBoundaryValidation::Invalid { message } => Err(message),
        StrictConvexBoundaryValidation::Valid { .. } => Ok(IrregularPolygon::new(
            rotate_to_stable_start(&boundary.points),
        )),
    }
}

/// TS: `nfpBoundaryCore.ts:494-505` (`rotateToStableStart`). Rotates a ring
/// so it starts at the point with the smallest `(y, x)` (first occurrence on
/// ties, since the comparison is strict `<`) — the canonical starting-vertex
/// rule applied after every NFP boundary construction path in this module.
pub fn rotate_to_stable_start(points: &[IrregularPoint]) -> Vec<IrregularPoint> {
    let mut start_index = 0usize;
    for index in 1..points.len() {
        let candidate = points[index];
        let current = points[start_index];
        if candidate.y < current.y || (candidate.y == current.y && candidate.x < current.x) {
            start_index = index;
        }
    }
    let mut rotated = Vec::with_capacity(points.len());
    rotated.extend_from_slice(&points[start_index..]);
    rotated.extend_from_slice(&points[..start_index]);
    rotated
}

/// Shared helper: applies `geometry::predicates::orientation` to three
/// [`IrregularPoint`]s. TS source: every call site of
/// `GeometryPredicates.orientation` in `nfpBoundaryCore.ts`.
fn orientation_of(origin: IrregularPoint, first: IrregularPoint, second: IrregularPoint) -> i32 {
    predicates::orientation(origin.x, origin.y, first.x, first.y, second.x, second.y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caches::GeometryCacheStore;
    use crate::domain::{
        IrregularBounds, IrregularPlacement, IrregularTransform, IrregularTransformCandidate,
        IrregularTransformReason, PieceId,
    };

    fn p(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    fn square(min: f64, max: f64) -> Vec<IrregularPoint> {
        vec![p(min, min), p(max, min), p(max, max), p(min, max)]
    }

    fn settings() -> IrregularGeometrySettings {
        IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "irregular-convex-v2-default".to_string(),
            geometry_backend_version: "0".to_string(),
        }
    }

    fn transform_candidate() -> IrregularTransformCandidate {
        IrregularTransformCandidate {
            index: 0.0,
            rotation_deg: 0.0,
            mirrored: false,
            reason: IrregularTransformReason::Orthogonal,
        }
    }

    fn fixed_piece(
        polygon: Vec<IrregularPoint>,
        translate_x: f64,
        translate_y: f64,
    ) -> IrregularPlacedPiece {
        IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: None,
                source_piece_id: PieceId::new("fixed"),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x,
                    translate_y,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new("fixed"),
                transform: transform_candidate(),
                polygon: IrregularPolygon::new(polygon.clone()),
                bounds: IrregularBounds::new(0.0, 0.0, 4.0, 4.0),
            },
        }
    }

    fn moving_geometry(polygon: Vec<IrregularPoint>) -> TransformedCollisionGeometry {
        TransformedCollisionGeometry {
            source_piece_id: PieceId::new("moving"),
            transform: transform_candidate(),
            polygon: IrregularPolygon::new(polygon),
            bounds: IrregularBounds::new(0.0, 0.0, 2.0, 2.0),
        }
    }

    #[test]
    fn compute_relative_nfp_boundary_reference_matches_minkowski_sum_of_squares() {
        let fixed = square(0.0, 4.0);
        let moving = square(0.0, 2.0);
        let boundary =
            compute_relative_nfp_boundary_reference(&fixed, &moving).expect("valid square NFP");
        // Fixed [0,4]^2 minus moving [0,2]^2 (Minkowski difference) is [-2,4]^2.
        assert_eq!(boundary.points.len(), 4);
        let winding = validate_strict_boundary(&boundary.points).winding();
        assert_eq!(winding, Some(1));
    }

    #[test]
    fn compute_relative_nfp_boundary_reference_and_linear_agree_on_a_simple_case() {
        let fixed = square(0.0, 4.0);
        let moving = square(0.0, 2.0);
        let reference =
            compute_relative_nfp_boundary_reference(&fixed, &moving).expect("reference ok");
        let linear = compute_relative_nfp_boundary_linear(&fixed, &moving).expect("linear ok");
        assert_eq!(reference.points, linear.points);
    }

    #[test]
    fn is_valid_cached_nfp_boundary_rejects_too_few_points() {
        let bad = IrregularPolygon::new(vec![p(0.0, 0.0), p(1.0, 0.0)]);
        assert!(!is_valid_cached_nfp_boundary(Some(&bad)));
        assert!(!is_valid_cached_nfp_boundary(None));
    }

    #[test]
    fn resolve_nfp_boundary_caches_the_relative_boundary_and_translates_on_every_call() {
        let fixed = fixed_piece(square(0.0, 4.0), 10.0, 20.0);
        let moving = moving_geometry(square(0.0, 2.0));
        let settings = settings();
        let mut cache = GeometryCacheStore::new();

        let input = CoreNfpInput {
            fixed: &fixed,
            moving: &moving,
            settings: &settings,
        };
        let first =
            resolve_nfp_boundary(&input, &mut cache, NfpConstructionAlgorithm::VertexPairHull)
                .expect("first resolution succeeds");
        let counters = cache.telemetry().namespace(NFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(counters.lookups, 1);
        assert_eq!(counters.misses, 1);
        assert_eq!(counters.stores, 1);

        // Translated boundary must reflect the fixed piece's placement.
        for point in &first.boundary.points {
            assert!(point.x >= 10.0 - 2.0 - 1e-9);
        }

        let second =
            resolve_nfp_boundary(&input, &mut cache, NfpConstructionAlgorithm::VertexPairHull)
                .expect("second resolution is a cache hit");
        let counters = cache.telemetry().namespace(NFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(counters.lookups, 2);
        assert_eq!(counters.hits, 1);
        assert_eq!(counters.stores, 1);
        assert_eq!(first.boundary.points, second.boundary.points);
    }

    #[test]
    fn hot_prepass_borrows_the_cached_nfp_before_the_normal_resolver_clones_once() {
        let fixed = std::sync::Arc::new(fixed_piece(square(0.0, 4.0), 10.0, 20.0));
        let moving = moving_geometry(square(0.0, 2.0));
        let settings = settings();
        let mut cache = GeometryCacheStore::new();
        let input = CoreNfpInput {
            fixed: &fixed,
            moving: &moving,
            settings: &settings,
        };

        resolve_nfp_boundary(&input, &mut cache, NfpConstructionAlgorithm::VertexPairHull)
            .expect("cold resolution seeds the cache");
        precompute_missing_relative_nfp_boundaries(
            &[std::sync::Arc::clone(&fixed)],
            &moving,
            &settings,
            &mut cache,
            NfpConstructionAlgorithm::VertexPairHull,
        );
        resolve_nfp_boundary(&input, &mut cache, NfpConstructionAlgorithm::VertexPairHull)
            .expect("normal resolver serves the hot candidate");

        let counters = cache.telemetry().namespace(NFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(
            counters.cloning_hits, 1,
            "the prepass must not clone the hot value before resolution"
        );
        assert_eq!(counters.stale_detections, 0);
    }

    #[test]
    fn stale_prepass_probe_removes_the_entry_before_stable_republication() {
        let fixed = std::sync::Arc::new(fixed_piece(square(0.0, 4.0), 10.0, 20.0));
        let moving = moving_geometry(square(0.0, 2.0));
        let settings = settings();
        let mut cache = GeometryCacheStore::new();
        let input = CoreNfpInput {
            fixed: &fixed,
            moving: &moving,
            settings: &settings,
        };
        let cold =
            resolve_nfp_boundary(&input, &mut cache, NfpConstructionAlgorithm::VertexPairHull)
                .expect("cold resolution seeds the cache");
        let invalid = IrregularPolygon::new(vec![p(0.0, 0.0), p(1.0, 1.0)]);
        assert!(cache.set(&cold.key, invalid.clone(), charge_nfp_polygon(&invalid)));

        precompute_missing_relative_nfp_boundaries(
            &[std::sync::Arc::clone(&fixed)],
            &moving,
            &settings,
            &mut cache,
            NfpConstructionAlgorithm::VertexPairHull,
        );
        let resolved =
            resolve_nfp_boundary(&input, &mut cache, NfpConstructionAlgorithm::VertexPairHull)
                .expect("the prepass republishes the valid boundary");

        assert_eq!(resolved.boundary.points, cold.boundary.points);
        let counters = cache.telemetry().namespace(NFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(counters.stale_detections, 1);
        assert_eq!(counters.stale_removals, 1);
        assert_eq!(counters.entries, 1);
        assert_eq!(counters.cloning_hits, 1);
    }

    #[test]
    fn resolve_nfp_boundary_shares_the_relative_cache_entry_across_canonically_equivalent_copies() {
        // Two fixed pieces with the same local collision-polygon shape (a
        // rotated-start-vertex, same-winding copy) and the same transform
        // candidate must hit the same relative-NFP cache entry, then each
        // translate it by its own placement.
        let shape_a = square(0.0, 4.0);
        let shape_b = vec![p(4.0, 4.0), p(0.0, 4.0), p(0.0, 0.0), p(4.0, 0.0)];
        let fixed_a = fixed_piece(shape_a, 0.0, 0.0);
        let fixed_b = fixed_piece(shape_b, 100.0, 0.0);
        let moving = moving_geometry(square(0.0, 2.0));
        let settings = settings();
        let mut cache = GeometryCacheStore::new();

        let input_a = CoreNfpInput {
            fixed: &fixed_a,
            moving: &moving,
            settings: &settings,
        };
        let result_a = resolve_nfp_boundary(
            &input_a,
            &mut cache,
            NfpConstructionAlgorithm::VertexPairHull,
        )
        .expect("first fixed piece resolves");

        let input_b = CoreNfpInput {
            fixed: &fixed_b,
            moving: &moving,
            settings: &settings,
        };
        let result_b = resolve_nfp_boundary(
            &input_b,
            &mut cache,
            NfpConstructionAlgorithm::VertexPairHull,
        )
        .expect("second fixed piece resolves");

        // Only one relative-NFP store despite two distinct fixed pieces.
        let counters = cache.telemetry().namespace(NFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(counters.stores, 1);
        assert_eq!(counters.hits, 1);

        // Translated boundaries differ by exactly the fixed-piece translation delta.
        for (a, b) in result_a
            .boundary
            .points
            .iter()
            .zip(result_b.boundary.points.iter())
        {
            assert!((b.x - a.x - 100.0).abs() < 1e-9);
            assert!((b.y - a.y).abs() < 1e-9);
        }
    }

    #[test]
    fn resolve_nfp_boundary_fails_before_any_cache_action_on_invalid_fixed_ring() {
        let fixed = fixed_piece(vec![p(0.0, 0.0), p(1.0, 1.0)], 0.0, 0.0);
        let moving = moving_geometry(square(0.0, 2.0));
        let settings = settings();
        let mut cache = GeometryCacheStore::new();
        let input = CoreNfpInput {
            fixed: &fixed,
            moving: &moving,
            settings: &settings,
        };
        let result =
            resolve_nfp_boundary(&input, &mut cache, NfpConstructionAlgorithm::VertexPairHull);
        assert!(result.is_err());
        let counters = cache.telemetry().namespace(NFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(counters.lookups, 0);
    }

    #[test]
    fn canonicalize_translated_convex_ring_drops_collinear_and_repeated_vertices() {
        let points = vec![
            p(0.0, 0.0),
            p(0.0, 0.0), // exact repeat
            p(2.0, 0.0),
            p(4.0, 0.0), // collinear with (2,0)-(6,0)? not quite -- keep simple
            p(4.0, 4.0),
            p(0.0, 4.0),
        ];
        let result = canonicalize_translated_convex_ring(&points).expect("canonicalizes");
        // The exact duplicate at index 1 must be gone; result must still be a
        // valid strict convex boundary.
        assert!(matches!(
            validate_strict_boundary(&result.points),
            StrictConvexBoundaryValidation::Valid { .. }
        ));
    }

    #[test]
    fn rotate_to_stable_start_picks_the_smallest_y_then_x_vertex() {
        // Smallest y is 0.0, shared by (0,0) and (1,0); the x tiebreak picks (0,0).
        let points = vec![p(1.0, 1.0), p(1.0, 0.0), p(0.0, 0.0), p(0.0, 1.0)];
        let rotated = rotate_to_stable_start(&points);
        assert_eq!(rotated[0], p(0.0, 0.0));
    }
}
