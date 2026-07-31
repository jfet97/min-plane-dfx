//! TS counterpart: src/workers/irregular/geometryCacheStore.ts and src/workers/irregular/geometryCacheStoreLive.ts (shared geometry cache keys, storage, and identity).
//!
//! Full geometry-cache layer for the irregular-nesting algorithm, per
//! `docs/planning/rust-irregular-backend/cache-concurrency-design.md`
//! (governing Stage-0 design document for this cluster) §1-2. This module
//! owns every cache **key** constructor for all four TS namespaces plus the
//! one physical backing store shared by three of them, and additionally
//! owns the transformed-collision-geometry namespace's full resolver — see
//! `transform_collision_geometry`'s module doc for why that one resolver
//! (and only that one) lives here rather than in `nfp_ifp`.
//!
//! Stage 2 scope (this task): single-threaded correctness only. Per the
//! design doc's own confirmation, `store::GeometryCacheStore`'s backing
//! structure is never iterated in production (`Map.get`/`.set`/`.delete`
//! only), so a plain `HashMap` is used — no insertion-ordered shadow
//! structure is needed for this module (contrast with TS `Map`s elsewhere in
//! this crate whose iteration order *is* observable). No `Arc`/lock/atomic
//! appears anywhere in this module; that is deliberately deferred to
//! Stage 3/4 per the design doc's own Rayon-integration section, not an
//! oversight of this stage.
//!
//! Submodules, one per TS source file this module ports:
//! - [`store`] — `core/geometryCacheStore.ts` (key type alias + byte-exact
//!   `serializeGeometryCacheKey`) and `geometryCacheStoreLive.ts`
//!   (`GeometryCacheStore`, the `Map`-backed implementation with wired-in
//!   telemetry recording).
//! - [`telemetry`] — the non-semantic diagnostic counters required by
//!   `cache-concurrency-design.md` §6, copied field-for-field from that
//!   document.
//! - [`nfp_cache_key`] — `core/nfpCacheKey.ts` (pairwise relative-NFP
//!   identity, namespace `pairwise-nfp-relative-v3`), including the
//!   rotation/winding-invariant ordered-coordinate fingerprint
//!   (`canonical_polygon_digest`) this task names explicitly.
//! - [`geometry_cache_identity`] — `core/geometryCacheIdentity.ts`
//!   (transformed-collision-geometry identity, namespace
//!   `transform-collision-v1`; rectangular-IFP identity, namespace
//!   `sheet-ifp-v1`).
//! - [`legal_candidate_memo`] — `geometryCacheKeys.ts`'s
//!   `legalPlacementCandidateMemoKey` (namespace
//!   `legal-placement-candidates-v1`), including its sheet-label omission
//!   oddity (`nfp-ifp.md` §15 item 5). Only the key constructor is ported
//!   here per this task's scope — the memo's own per-search-invocation
//!   table and resolver sequence belong to `nfp_ifp` (see that module's own
//!   doc comment).
//! - [`transform_collision_geometry`] — `core/transformCollisionGeometryCore.ts`'s
//!   full resolver (`resolveTransformedCollisionGeometry`), pure compute
//!   step (`computeTransformedCollisionGeometry`), and trusted-ring
//!   revalidation (`isValidCachedTransformedCollisionGeometry`). See that
//!   module's doc comment for the cross-module ownership note explaining why
//!   this one resolver is ported here rather than in `nfp_ifp`.

pub mod geometry_cache_identity;
pub mod legal_candidate_memo;
pub mod nfp_cache_key;
pub mod store;
pub mod telemetry;
pub mod transform_collision_geometry;

pub use geometry_cache_identity::{
    make_inner_fit_bounds_cache_key, make_transform_collision_geometry_cache_key, same_transform,
    InnerFitBoundsKeyInput, TransformCollisionGeometryKeyInput, IFP_GEOMETRY_CACHE_NAMESPACE,
    TRANSFORM_GEOMETRY_CACHE_NAMESPACE,
};
pub use legal_candidate_memo::{
    legal_placement_candidate_memo_key, CandidateDomain, LegalPlacementCandidateMemoKeyInput,
    NfpCandidatePruningMode, PlacedPieceKeyInput, SheetDimensions, LEGAL_CANDIDATE_MEMO_NAMESPACE,
};
pub use nfp_cache_key::{
    canonical_polygon_digest, make_pairwise_nfp_cache_key, NfpConstructionAlgorithm,
    PairwiseNfpKeyInput, DEFAULT_NFP_CONSTRUCTION_ALGORITHM, NFP_CONSTRUCTION_ALGORITHMS,
    NFP_GEOMETRY_CACHE_NAMESPACE,
};
pub use store::{
    charge_ifp_bounds, charge_nfp_polygon, charge_transformed_collision_geometry,
    serialize_geometry_cache_key, GeometryCacheKey, GeometryCacheProbe, GeometryCacheStore,
};
pub use telemetry::{CacheNamespaceTelemetry, CacheTelemetrySnapshot};
pub use transform_collision_geometry::{
    compute_transformed_collision_geometry, is_valid_cached_transformed_collision_geometry,
    resolve_transformed_collision_geometry, TransformCollisionResult, TransformCollisionSuccess,
    TransformedCollisionGeometryLike,
};
