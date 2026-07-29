//! TS counterpart: src/workers/irregular/nfpIfpService.ts, src/workers/irregular/core/nfpBoundaryCore.ts, and src/workers/irregular/core/ifpBoundsCore.ts (NFP/IFP generation and validation).
//!
//! The hot path: per `docs/planning/rust-irregular-backend/characterization/nfp-ifp.md`
//! §1, this cluster is 19% of Mixed-61 CPU. Read that document (all 15
//! sections) and `docs/planning/rust-irregular-backend/cache-concurrency-design.md`
//! §1.1/§1.3/§1.4/§4 before touching this module tree — they are this
//! module's specification for cache access sequencing, candidate ordering,
//! and cancellation-observation placement, not merely background.
//!
//! Submodules, one per TS source file (plus one integration seam):
//! - [`boundary_core`] — full port of `core/nfpBoundaryCore.ts`: relative-NFP
//!   construction (both `'vertex-pair-hull'` production and
//!   `'linear-edge-merge'` differential-oracle algorithms), cache resolution
//!   (`resolveNfpBoundary`), and post-retrieval fixed-piece translation.
//! - [`ifp_bounds`] — full port of `core/ifpBoundsCore.ts`: rectangular IFP
//!   bounds construction, cache resolution, and the `'invalid'`/`'infeasible'`
//!   failure-kind split.
//! - [`candidates`] — full port of `nfpIfpService.ts`'s
//!   `generatePlacementCandidatesUncached` and every helper it uses
//!   (`BoundsIndex`, segment intersection, antiparallel-edge support points,
//!   `canonicalPlacementPointAlternatives`, candidate-point ordering,
//!   provenance accounting).
//! - [`service`] — cooperative-cancellation control
//!   ([`service::NfpIfpControl`]), the public `computeNfp`/`computeIfpBounds`
//!   entry points, error taxonomy, and the per-search-invocation
//!   legal-candidate memo ([`service::LegalCandidateMemo`],
//!   [`service::generate_placement_candidates`]).
//! - [`telemetry`] — full port of `nfpIfpTelemetry.ts`'s memo and checkpoint
//!   counters (the cache-namespace counter half already lives in
//!   `caches::CacheTelemetrySnapshot`, imported not duplicated — see that
//!   module's own doc comment).
//!
//! # Reuse discipline
//!
//! This module tree never re-implements: cache key construction, the
//! backing store, or its telemetry (`caches::*`); convex-hull construction,
//! bounds arithmetic, or strict-boundary validation (`geometry::convex::*`);
//! the orientation predicate (`geometry::predicates::orientation`); exact
//! placement legality (`validation::placement::assess_placement`); the
//! placed-collision spatial index (`validation::spatial_index::*`); grid
//! quantization (`canonical_grid::{to_grid_mm, from_grid}`); or any
//! `js_number` primitive. Every one of those is imported directly.

pub mod boundary_core;
pub mod candidates;
pub mod ifp_bounds;
pub mod service;
pub mod telemetry;

pub use boundary_core::{
    canonicalize_translated_convex_ring, compute_relative_nfp_boundary,
    compute_relative_nfp_boundary_linear, compute_relative_nfp_boundary_reference,
    is_valid_cached_nfp_boundary, resolve_nfp_boundary, CoreNfpBoundaryConstructionResult,
    CoreNfpInput, CoreNfpResult, CoreNfpSuccess,
};
pub use candidates::{
    canonical_placement_point_alternatives, generate_placement_candidates_uncached,
    CanonicalCandidatePoint, GeneratePlacementCandidatesInput, GeneratePlacementCandidatesOutcome,
    NfpIfpCandidateProvenance, NfpIfpCandidateSource, NfpIfpLegalCandidateSource,
    ProvenanceEvaluation, RawBySource, SourceMaskCount,
};
pub use ifp_bounds::{
    compute_ifp_bounds as compute_ifp_bounds_core, is_valid_cached_ifp_bounds, resolve_ifp_bounds,
    CoreIfpBoundsFailure, CoreIfpBoundsFailureKind, CoreIfpBoundsResult, CoreIfpBoundsSuccess,
};
pub use service::{
    compute_ifp_bounds, compute_nfp, generate_placement_candidates, invalid_geometry,
    nfp_checkpoint, ComputeIfpBoundsError, ComputeIfpBoundsInput, ComputeNfpInput,
    IrregularGeometryInfeasibleError, LegalCandidateMemo, NfpIfpAbortReason, NfpIfpControl,
    NfpIfpControlAbortError, NfpIfpError,
};
pub use telemetry::{
    CheckpointOutcome, MemoRequestOutcome, NfpIfpCheckpointCounters, NfpIfpCheckpointPhase,
    NfpIfpMemoCounters, NfpIfpTelemetry,
};
