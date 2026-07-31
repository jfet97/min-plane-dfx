//! The complete-cohort exact archive: runs the three "direct" sheetless
//! constructors (`canonical-grid`, `legacy-absolute-envelope`,
//! `open-pocket-first`) plus the periodic-family continuation portfolio,
//! deduplicates their completed layouts by canonical geometry hash, ranks
//! the survivors, and selects one intrinsic winner.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.ts`
//! (725 lines), ported here in full per
//! `docs/planning/rust-irregular-backend/characterization/shared-archive.md`
//! (this module's primary governing source -- every section is load-bearing)
//! and `characterization/capacity-search.md` for the lane-coordinator
//! interplay this cluster feeds. **This is the central Compact/Compact Short
//! Side production authority**: the three direct roles run serially in
//! exact order via `search::strict_decoder`; archive admission
//! (complete/exact/legal/uncensored via `canonical_grid` layout legality and
//! identity), `retain_ranked_shared_archive`/`select_intrinsic_shared_archive_winner`
//! comparators, and the anytime scheduler's checkpoint-interleaving
//! chronology are all owned here (`shared-archive.md` §1).
//!
//! # Reused (GREEN) modules -- never duplicated here
//!
//! - `archive::anytime::{retain_intrinsic_anytime_archive_namespace,
//!   IntrinsicAnytimeArchiveNamespace, IntrinsicAnytimeArchiveNamespacePolicy}`
//!   -- this cluster's own sibling file, the generic dedup/rank storage
//!   primitive `retain_ranked_shared_archive` builds on.
//! - `search::strict_decoder::{construct_intrinsic_strict_state,
//!   evaluate_intrinsic_strict_certificate,
//!   measure_intrinsic_sheetless_completed_layout,
//!   rank_intrinsic_strict_completed_layouts,
//!   select_intrinsic_strict_completed_pareto_front,
//!   IntrinsicStrictCandidateMode, IntrinsicStrictComparatorMode,
//!   IntrinsicStrictCertificate, IntrinsicStrictCompletedMetrics,
//!   IntrinsicStrictConstructResult, IntrinsicStrictDirectCheckpoint,
//!   IntrinsicStrictDecoderFailure, ConstructIntrinsicStrictStateInput,
//!   TerminalRotationDeg, TruncationReason}` -- the strict/direct decoder
//!   this cluster drives for every direct role and reuses for terminal
//!   layout measurement/certification/ranking; never reimplemented here.
//! - `canonical_grid::layout::{assert_canonical_grid_legal_layout,
//!   canonical_collision_layout_identity}` -- real-sheet legality and
//!   rotation/translation-invariant canonical identity.
//! - `geometry::hash::sha256_hex` -- the one hash site in this cluster
//!   (`requestedSheetFit`'s `canonicalGeometryHash`).
//! - `checkpoints::canonical_json::locale_compare_keys` -- every
//!   `.localeCompare()` call site in the TS source
//!   (`compareIntrinsicSharedArchiveWinner`'s hash tie-break,
//!   `requestedSheetFit`'s q0/q90 hash-first tie-break) routes through this.
//! - `search::beam_state::{IrregularBeamState, IrregularQuarterTurnDegrees,
//!   TimingNowFn}` -- the Arc-wrapped immutable placement-state class this
//!   file only ever reads/extends, never reimplements.
//! - `nfp_ifp::{NfpIfpControl, NfpIfpControlAbortError, NfpIfpAbortReason}`
//!   -- the same cooperative cancellation/deadline seam
//!   `construct_intrinsic_strict_state` already threads through.
//! - `domain::{SheetSpec, IrregularPlacedPiece, IrregularPreparedPiece,
//!   PieceId, IrregularNestingSettings}`, `caches::GeometryCacheStore` --
//!   consumed exactly as `search::strict_decoder` already consumes them
//!   (same explicit `settings`/`geometry_cache` seam parameters, mirroring
//!   the TS `Effect` dependencies `GeometryKernel | GeometrySettings |
//!   NfpIfpService`; see `search::strict_decoder`'s own top doc for why Rust
//!   makes these explicit rather than ambient).
//!
//! # `IntrinsicSharedArchiveDirectRole` -- this module is now authoritative
//!
//! `capacity::prefixes` (a sibling, independently-owned file) already
//! carries a **provisional** copy of `IntrinsicSharedArchiveDirectRole` /
//! `INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES`, explicitly documented in that
//! module's own top doc ("Seam: `IntrinsicSharedArchiveDirectRole`
//! (provisional)") as needing reconciliation once this file was ported.
//! [`IntrinsicSharedArchiveDirectRole`] here is now the **authoritative**
//! definition (same three variants, same `as_str()` strings, same
//! array-literal order, byte-for-byte identical to `capacity::prefixes`'s
//! provisional copy). File ownership forbids this task from editing
//! `capacity::prefixes` itself (a sibling cluster's file) to replace its
//! copy with a `pub use` of this one, so that reconciliation is left as an
//! explicit **note for the orchestrator**: `capacity/prefixes.rs`'s own
//! `IntrinsicSharedArchiveDirectRole` (and its `INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES`
//! const) should be deleted and replaced with `pub use
//! crate::archive::shared::{IntrinsicSharedArchiveDirectRole,
//! INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES};` in a follow-up edit to that
//! file. The two copies are currently structurally identical, so no
//! behavior differs today regardless of which copy any given caller uses.
//!
//! # Seam: the periodic-family-portfolio sibling module (not yet ported)
//!
//! TS imports `runIntrinsicPeriodicFamilyPortfolio` and its result/option
//! types from `intrinsicPeriodicFamilyPortfolio.ts`, a sibling module
//! (`archive::periodic_family` in this crate) that is not yet ported and is
//! outside this task's file-ownership scope (it is still the one-line
//! `Reserved for the Stage 2 port` stub at the time of this writing). Per
//! this task's established "seam type" pattern (e.g. `capacity::prefixes`'s
//! provisional `IntrinsicSharedArchiveDirectRole` above, or
//! `search::layout_scorer`'s `LayoutScorerBeamStateView`), this module
//! defines the minimal subset of periodic-family-portfolio types its own
//! logic actually reads --
//! [`IntrinsicPeriodicCatalogCoverage`]/[`IntrinsicPeriodicFamilyCatalogCoverage`]
//! (only the two catalog fields `intrinsic_shared_periodic_catalog_coverage_valid`
//! branches on), [`IntrinsicPeriodicContinuationResult`]/[`IntrinsicPeriodicContinuationRef`]
//! (only the fields `normalize_periodic_run` reads -- notably *not*
//! `result: IntrinsicStrictDecodeResult | undefined`, which
//! `normalizePeriodicRun` never reads), and
//! [`IntrinsicPeriodicFamilyPortfolioResult`] (a restricted projection: this
//! cluster only ever reads `catalog`, `runs`, `continuations.length`,
//! `continuationCoverageComplete`, and `continuationBudgetSettlementComplete`
//! from the real TS result -- the many other fields on the real
//! `IntrinsicPeriodicFamilyPortfolioResult` type, e.g. `sourceAuditWitnesses`,
//! `phaseTimings`, belong entirely to that sibling cluster and are omitted
//! here, not silently dropped from behavior this file is responsible for).
//!
//! Because `runIntrinsicPeriodicFamilyPortfolio` itself does not exist yet
//! in Rust, [`run_intrinsic_shared_archive_portfolio`] (the top-level
//! function that TS calls it from) takes the periodic phase as an injected
//! [`IntrinsicPeriodicFamilyPortfolioRunner`] trait object rather than
//! calling a concrete function -- the same "Rust has no ambient DI, so
//! callers construct/own the dependency explicitly" pattern
//! `search::strict_decoder`'s own top doc already establishes for its
//! `geometry_cache`/`settings` parameters, extended here from a sibling
//! *type* seam to a sibling *function* seam because the callee itself does
//! not exist yet. Once `archive::periodic_family` is ported, the
//! orchestrator should: (a) delete this module's periodic seam types, (b)
//! import the real ones, and (c) either keep the trait-injection seam (it
//! costs nothing once a concrete implementation exists) or replace call
//! sites with a direct call -- a decision left to whoever completes that
//! reconciliation, since both are behavior-preserving.
//!
//! [`run_intrinsic_shared_archive_direct_portfolio`] itself has **no**
//! dependency on the periodic seam at all (TS: `runIntrinsicSharedArchiveDirectPortfolio`
//! never touches periodic types) and is fully, independently portable and
//! testable today against real production geometry.
//!
//! # Deliberately not ported
//!
//! - `IntrinsicCapacityError` from the TS `SharedArchiveError` union
//!   (`:106-112`) -- confirmed structurally unreachable from this cluster's
//!   actual callees (`shared-archive.md` §11/§15 item 3: neither
//!   `constructIntrinsicStrictState`'s nor `runIntrinsicPeriodicFamilyPortfolio`'s
//!   declared error channels include it; it is imported and named in the TS
//!   union purely for type-signature breadth). Dropped here exactly as
//!   `search::strict_decoder` already drops the structurally-analogous
//!   `IrregularNestingNotImplementedError` from its own error union (see
//!   that module's own "Deliberately not ported" doc section for the
//!   precedent this follows). [`SharedArchiveError`] is therefore a plain
//!   alias for `search::strict_decoder::IntrinsicStrictDecoderFailure`
//!   (`Decoder | Geometry | Abort`) rather than a new enum -- both this
//!   cluster's own callee and the periodic-family callee reduce to the same
//!   three-arm union, so no new type is needed.
//! - `IrregularNestingNotImplementedError` -- same precedent as above; zero
//!   reachable production callers, no Rust DI-unimplemented-layer stub
//!   exists to raise it.
//! - A TS-source `timingNow` seam for this file's own `performance.now()`
//!   reads (`:262`, `:329`) -- unlike `intrinsicCapacitySearch.ts` (ruling
//!   R13, an additive test-only seam already applied to that specific TS
//!   file), `intrinsicSharedArchivePortfolio.ts` was **not** given such a
//!   seam and this task's file ownership does not extend to editing TS
//!   source. Per characterization §7, both TS reads are non-deterministic,
//!   diagnostic-only wall-clock measurements (`IntrinsicSharedArchiveRun::runtime_ms`
//!   on the failure branch) that never affect control flow for any input
//!   small enough to complete well inside `maximumDirectRuntimeMs` -- this
//!   port measures elapsed time with its own private monotonic clock
//!   (mirroring `search::beam_state`'s and `search::strict_decoder`'s own
//!   independent private per-file clocks, both already documented as
//!   acceptable non-duplication) and this file's own differential vectors
//!   never assert `runtime_ms` byte-exactly, only structurally (finite,
//!   `>= 0`).

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Instant;
use std::{cmp::Ordering, sync::Arc};

use num_bigint::BigInt;

use crate::caches::GeometryCacheStore;
use crate::canonical_grid::layout::{
    assert_canonical_grid_legal_layout, canonical_collision_layout_identity,
};
use crate::checkpoints::canonical_json::locale_compare_keys;
use crate::domain::{
    IrregularNestingSettings, IrregularPlacedPiece, IrregularPreparedPiece, SheetSpec,
};
use crate::geometry::hash::sha256_hex;
use crate::js_number::js_math;
use crate::nfp_ifp::{
    NfpIfpAbortReason, NfpIfpCheckpointPhase, NfpIfpControl, NfpIfpControlAbortError,
};
use crate::search::beam_state::{IrregularBeamState, IrregularQuarterTurnDegrees};
use crate::search::strict_decoder::{
    construct_intrinsic_strict_state, evaluate_intrinsic_strict_certificate,
    measure_intrinsic_sheetless_completed_layout, rank_intrinsic_strict_completed_layouts,
    select_intrinsic_strict_completed_pareto_front, ConstructIntrinsicStrictStateInput,
    IntrinsicStrictCandidateMode, IntrinsicStrictCertificate, IntrinsicStrictComparatorMode,
    IntrinsicStrictCompletedMetrics, IntrinsicStrictConstructResult, IntrinsicStrictDecoderFailure,
    IntrinsicStrictDirectCheckpoint, TerminalRotationDeg, TruncationReason,
};

use super::anytime::{
    retain_intrinsic_anytime_archive_namespace, IntrinsicAnytimeArchiveNamespace,
    IntrinsicAnytimeArchiveNamespacePolicy,
};

// ===========================================================================
// Direct roles (`:41-50`)
// ===========================================================================

/// TS: `intrinsicSharedArchivePortfolio.ts:49-50` `IntrinsicSharedArchiveDirectRole`.
/// See this module's top doc, "`IntrinsicSharedArchiveDirectRole` -- this
/// module is now authoritative".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IntrinsicSharedArchiveDirectRole {
    CanonicalGrid,
    LegacyAbsoluteEnvelope,
    OpenPocketFirst,
}

impl IntrinsicSharedArchiveDirectRole {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicSharedArchiveDirectRole::CanonicalGrid => "canonical-grid",
            IntrinsicSharedArchiveDirectRole::LegacyAbsoluteEnvelope => "legacy-absolute-envelope",
            IntrinsicSharedArchiveDirectRole::OpenPocketFirst => "open-pocket-first",
        }
    }
}

/// TS: `intrinsicSharedArchivePortfolio.ts:41-45`
/// `INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES`. Fixed array-literal order --
/// determines direct-role construction order, the sole scheduler
/// checkpoint-interleaving driver (`canonical-grid` is always first), and
/// "first producer ownership" in duplicate resolution
/// (`shared-archive.md` §5 items 1/4).
pub const INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES: [IntrinsicSharedArchiveDirectRole; 3] = [
    IntrinsicSharedArchiveDirectRole::CanonicalGrid,
    IntrinsicSharedArchiveDirectRole::LegacyAbsoluteEnvelope,
    IntrinsicSharedArchiveDirectRole::OpenPocketFirst,
];

/// TS: `intrinsicSharedArchivePortfolio.ts:46` `INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT`.
pub const INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT: f64 = 8.0;
/// TS: `intrinsicSharedArchivePortfolio.ts:47` `INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP`.
pub const INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP: f64 = 19_862.0;

// ===========================================================================
// Error alias (see this module's top doc, "Deliberately not ported")
// ===========================================================================

/// TS: `intrinsicSharedArchivePortfolio.ts:106-112` `SharedArchiveError`,
/// minus the unreachable `IntrinsicCapacityError`/`IrregularNestingNotImplementedError`
/// arms (see this module's top doc).
pub type SharedArchiveError = IntrinsicStrictDecoderFailure;

fn shared_archive_error_message(error: &SharedArchiveError) -> String {
    match error {
        IntrinsicStrictDecoderFailure::Decoder(inner) => inner.message.clone(),
        IntrinsicStrictDecoderFailure::Geometry(inner) => inner.message.clone(),
        IntrinsicStrictDecoderFailure::Abort(inner) => inner.message.clone(),
    }
}

// ===========================================================================
// `SharedArchiveControl` -- a concrete (`Sized`) pass-through wrapper around
// the caller-supplied `Option<&mut dyn NfpIfpControl>`, mirroring
// `capacity::search::CapacitySearchControl` and
// `search::strict_decoder::DeadlineControl`. A bare
// `Option<&mut dyn NfpIfpControl>` cannot be reborrowed repeatedly across
// sequential loop iterations for an unsized trait-object target (confirmed
// by direct compiler experimentation during this port: `attempt_direct_construct`'s
// own internal construction of `ConstructIntrinsicStrictStateInput<'a>` --
// whose single lifetime parameter is shared, invariantly, across both its
// `pieces` field and its `control` field -- requires an explicit unified
// `'a` for the function to be well-formed at all, and that requirement then
// propagates to every call site as an implied bound that a second,
// independent reborrow of the *raw* `Option<&mut dyn NfpIfpControl>` cannot
// satisfy across loop iterations). `None` inner => an always-`Ok` no-op
// checkpoint, behaviorally identical to TS's `options.control === undefined`
// skip-when-absent guard.
// ===========================================================================

struct SharedArchiveControl<'a> {
    inner: Option<&'a mut dyn NfpIfpControl>,
}

impl NfpIfpControl for SharedArchiveControl<'_> {
    fn checkpoint(&mut self, phase: NfpIfpCheckpointPhase) -> Result<(), NfpIfpControlAbortError> {
        match self.inner.as_deref_mut() {
            None => Ok(()),
            Some(control) => control.checkpoint(phase),
        }
    }
}

// ===========================================================================
// Result/run/endpoint types (`:52-104`)
// ===========================================================================

/// TS: `intrinsicSharedArchivePortfolio.ts:52-58` `IntrinsicSharedArchiveRunStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicSharedArchiveRunStatus {
    Completed,
    EvaluationCap,
    Deadline,
    GlobalDeadline,
    Invalid,
    Incomplete,
}

/// TS: `intrinsicSharedArchivePortfolio.ts:68-71` `IntrinsicSharedArchiveOrientationFit`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicSharedArchiveOrientationFit {
    pub fits: bool,
    pub canonical_geometry_hash: Option<String>,
}

/// TS: `intrinsicSharedArchivePortfolio.ts:60-66` `IntrinsicSharedArchiveSheetFit`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicSharedArchiveSheetFit {
    pub q0: IntrinsicSharedArchiveOrientationFit,
    pub q90: IntrinsicSharedArchiveOrientationFit,
    pub selected_rotation_deg: Option<TerminalRotationDeg>,
    pub selected_canonical_geometry_hash: Option<String>,
    pub selected_placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
}

/// TS: `intrinsicSharedArchivePortfolio.ts:73-82` `IntrinsicSharedArchiveEndpoint`.
#[derive(Clone, Debug)]
pub struct IntrinsicSharedArchiveEndpoint {
    pub role: String,
    pub source_id: Option<String>,
    pub sheetless_canonical_geometry_identity: String,
    pub sheetless_canonical_geometry_hash: String,
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub metrics: IntrinsicStrictCompletedMetrics,
    pub certificate: IntrinsicStrictCertificate,
    pub requested_sheet_fit: IntrinsicSharedArchiveSheetFit,
}

/// TS: `intrinsicSharedArchivePortfolio.ts:84-93` `IntrinsicSharedArchiveRun`.
#[derive(Clone, Debug)]
pub struct IntrinsicSharedArchiveRun {
    pub role: String,
    pub source_id: Option<String>,
    pub status: IntrinsicSharedArchiveRunStatus,
    pub requested_candidate_evaluations: Option<f64>,
    pub consumed_candidate_evaluations: Option<f64>,
    pub reason: Option<String>,
    pub endpoint: Option<IntrinsicSharedArchiveEndpoint>,
    pub runtime_ms: f64,
}

// ===========================================================================
// Periodic-family-portfolio seam types (see this module's top doc, "Seam:
// the periodic-family-portfolio sibling module (not yet ported)")
// ===========================================================================

/// Seam (provisional): mirrors `intrinsicPeriodicCells.ts:180-199`
/// `IntrinsicPeriodicFamilyCatalog`, restricted to the two fields
/// [`intrinsic_shared_periodic_catalog_coverage_valid`] reads.
#[derive(Clone, Debug)]
pub struct IntrinsicPeriodicFamilyCatalogCoverage {
    pub cell_coverage_complete: bool,
    /// TS: `sourceAuditCells !== undefined`.
    pub source_audit_cells_present: bool,
}

/// Seam (provisional): mirrors `intrinsicPeriodicCells.ts:139-148`
/// `IntrinsicPeriodicCatalog`, restricted to the fields this cluster reads
/// (`intrinsicSharedArchiveProductionValid`/`intrinsicSharedPeriodicCatalogCoverageValid`,
/// `:522-552`).
#[derive(Clone, Debug)]
pub struct IntrinsicPeriodicCatalogCoverage {
    pub runtime_coverage_complete: bool,
    pub family_coverage_complete: bool,
    pub families: Vec<IntrinsicPeriodicFamilyCatalogCoverage>,
}

/// Seam (provisional): mirrors `intrinsicPeriodicFamilyPortfolio.ts:48-55`
/// `IntrinsicPeriodicContinuation`, restricted to the two fields
/// `normalizePeriodicRun` reads (`role`, `sourceId`).
#[derive(Clone, Debug)]
pub struct IntrinsicPeriodicContinuationRef {
    /// TS: `'P1' | 'P2'`, opaque to this cluster (only interpolated into a
    /// `periodic-${role}` role string).
    pub role: String,
    pub source_id: String,
}

/// TS: `intrinsicPeriodicFamilyPortfolio.ts:59-64`, the status union
/// `IntrinsicPeriodicContinuationResult['status']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicPeriodicContinuationStatus {
    Completed,
    Incomplete,
    InfeasibleFinalSheet,
    Invalid,
    Deadline,
    GlobalDeadline,
    EvaluationCap,
}

fn periodic_status_str(status: IntrinsicPeriodicContinuationStatus) -> &'static str {
    match status {
        IntrinsicPeriodicContinuationStatus::Completed => "completed",
        IntrinsicPeriodicContinuationStatus::Incomplete => "incomplete",
        IntrinsicPeriodicContinuationStatus::InfeasibleFinalSheet => "infeasible-final-sheet",
        IntrinsicPeriodicContinuationStatus::Invalid => "invalid",
        IntrinsicPeriodicContinuationStatus::Deadline => "deadline",
        IntrinsicPeriodicContinuationStatus::GlobalDeadline => "global-deadline",
        IntrinsicPeriodicContinuationStatus::EvaluationCap => "evaluation-cap",
    }
}

/// Seam (provisional): mirrors `intrinsicPeriodicFamilyPortfolio.ts:57-69`
/// `IntrinsicPeriodicContinuationResult`, restricted to the fields
/// `normalizePeriodicRun` reads (`:639-670`) -- notably *not* `result:
/// IntrinsicStrictDecodeResult | undefined`, which that function never
/// reads.
#[derive(Clone, Debug)]
pub struct IntrinsicPeriodicContinuationResult {
    pub continuation: IntrinsicPeriodicContinuationRef,
    pub status: IntrinsicPeriodicContinuationStatus,
    pub constructed: Option<IntrinsicStrictConstructResult>,
    pub reason: Option<String>,
    pub runtime_ms: f64,
}

/// Seam (provisional): a restricted projection of
/// `intrinsicPeriodicFamilyPortfolio.ts:132-151`
/// `IntrinsicPeriodicFamilyPortfolioResult`, carrying only the fields this
/// cluster's own logic reads (`runIntrinsicSharedArchivePortfolio:206-222`,
/// `intrinsicSharedArchiveProductionValid:528-534`). See this module's top
/// doc for what is intentionally omitted and why.
#[derive(Clone, Debug)]
pub struct IntrinsicPeriodicFamilyPortfolioResult {
    pub catalog: IntrinsicPeriodicCatalogCoverage,
    /// TS: `continuations.length`.
    pub continuation_count: f64,
    pub continuation_coverage_complete: bool,
    /// TS: `continuationBudgetSettlementComplete === true` (a real optional
    /// boolean, tolerant of `undefined`).
    pub continuation_budget_settlement_complete: Option<bool>,
    pub runs: Vec<IntrinsicPeriodicContinuationResult>,
}

/// TS: `intrinsicSharedArchivePortfolio.ts:95-104`
/// `IntrinsicSharedArchivePortfolioResult`.
#[derive(Clone, Debug)]
pub struct IntrinsicSharedArchivePortfolioResult {
    pub direct_runs: Vec<IntrinsicSharedArchiveRun>,
    pub periodic_runs: Vec<IntrinsicSharedArchiveRun>,
    pub periodic_portfolio: IntrinsicPeriodicFamilyPortfolioResult,
    pub sheetless_archive: Vec<IntrinsicSharedArchiveEndpoint>,
    pub archive: Vec<IntrinsicSharedArchiveEndpoint>,
    pub winner: Option<IntrinsicSharedArchiveEndpoint>,
    pub periodic_selection_valid: bool,
    pub experiment_valid: bool,
}

/// TS: `intrinsicSharedArchivePortfolio.ts:128` `options.onPhaseCompleted`'s
/// `'direct' | 'periodic'` phase discriminant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharedArchivePhase {
    Direct,
    Periodic,
}

/// TS: `intrinsicSharedArchivePortfolio.ts:113-152`
/// `IntrinsicSharedArchivePortfolioOptions`. See this module's top doc,
/// "Structural-closures-as-a-policy-object seam" (borrowed from
/// `archive::anytime`'s own doc) for why every TS closure field becomes an
/// explicit `&mut dyn FnMut`/`&mut dyn NfpIfpControl` field here.
///
/// `run_intrinsic_shared_archive_direct_portfolio` reads only
/// `direct_candidate_evaluation_caps`, `maximum_direct_runtime_ms`,
/// `canonical_grid_completed_piece_quantum`, `on_canonical_grid_checkpointed`,
/// `on_direct_constructed` (TS: `Pick<..., ...>`, `:244-252`, minus
/// `control` -- see below); `on_phase_completed`/`include_source_audit_witnesses`
/// are read only by [`run_intrinsic_shared_archive_portfolio`] itself.
///
/// `control` (TS: `options.control?: IrregularNfpIfpControl`) is
/// deliberately **not** a field of this struct, unlike every other TS
/// option. Both functions below take it as a separate, explicit, owned
/// `Option<&mut dyn NfpIfpControl>` parameter instead (mirroring
/// `capacity::preflight::preflight_intrinsic_complete_capacity`'s own
/// proven-working `mut control: Option<&mut dyn NfpIfpControl>` parameter,
/// repeatedly reborrowed via `.as_deref_mut()`/`&mut control` inside a
/// loop). Threading it through *this* struct's own `'a`-unified field list
/// instead hits a known rustc limitation: reborrowing a `&'a mut dyn Trait`
/// field of a struct that is itself behind another `&mut` reference, across
/// multiple loop iterations, cannot be proven non-overlapping even though
/// each reborrow's actual live range is trivially disjoint (confirmed by
/// direct compiler experimentation during this port -- `rustc` reports
/// E0499 "cannot borrow ... as mutable more than once" pinned at the
/// `options.control`/`&mut options.control` projection specifically, not at
/// any of this struct's other, sibling `&mut dyn FnMut` fields, which do
/// not have this problem because they are each read at most once per loop
/// *body*, never re-derived from the same struct field across nested
/// resume iterations the way `control` is). Elevating `control` to a bare
/// parameter -- exactly the shape `nfp_ifp::service`'s own `NfpIfpControl`
/// callers already use everywhere else in this crate -- sidesteps the
/// limitation entirely.
///
/// The callback itself additionally receives a fresh reborrow of that same
/// `control` (`Option<&mut dyn NfpIfpControl>`), passed as its second
/// argument at the one call site below (inside
/// [`run_intrinsic_shared_archive_direct_portfolio`]'s loop) rather than
/// captured by the closure at its definition point. TS threads the
/// identical `control`/`isCancelled` observation into its own nested
/// `runIntrinsicCapacitySchedulerColdQuantum` resume call inside
/// `onCanonicalGridCheckpointed` (`computeIrregularNesting.ts:679`,
/// `...(control === undefined ? {} : { control })`); a caller whose own
/// closure needs to forward this reborrow into a *further* nested call (as
/// `result::coordinator`'s `on_canonical_grid_checkpointed` does, into
/// `run_intrinsic_capacity_scheduler_cold_quantum`) could not instead
/// capture the coordinator-level `control` local directly at closure
/// definition time: that same local is *simultaneously* reborrowed for the
/// entire duration of the outer `run_intrinsic_shared_archive_portfolio`
/// call the closure is passed into (the same E0499-style hazard this
/// module's `SharedArchiveControl` doc comment documents, one level up).
/// Passing the reborrow in as a callback *parameter* instead -- taken from
/// the still-live, not-otherwise-borrowed-at-that-point `control` local
/// inside this function's own loop body (the prior `attempt_direct_construct`
/// call's borrow of it has already ended by the time the checkpoint fires) --
/// sidesteps that entirely, exactly mirroring `capacity::mode`'s
/// `reborrow_control` pattern.
/// The callback also receives a fresh reborrow of
/// [`run_intrinsic_shared_archive_direct_portfolio`]'s own `geometry_cache`
/// parameter as its third argument, for exactly the same reason and via the
/// exact same mechanism as the `control` reborrow this doc comment already
/// documents above (see `cache-concurrency-design.md` §2: TS's
/// `runIntrinsicCapacitySchedulerColdQuantum` reads the same single
/// job-ambient `GeometryCacheService` instance everywhere, never a
/// phase-private cache -- a caller whose own nested resume needs a
/// `GeometryCacheStore` must reborrow this same one, not allocate a private
/// `GeometryCacheStore::new()`, or it silently diverges from TS's cache
/// hit/miss sequence for numerically-tied candidates
/// (`differential-e2e-report.md` Finding N1)).
pub type OnCanonicalGridCheckpointed<'a> = &'a mut dyn FnMut(
    &IntrinsicStrictDirectCheckpoint,
    Option<&mut dyn NfpIfpControl>,
    &mut GeometryCacheStore,
) -> Result<(), SharedArchiveError>;

pub type OnDirectConstructed<'a> =
    &'a mut dyn FnMut(IntrinsicSharedArchiveDirectRole, &Arc<IrregularBeamState>);

#[derive(Default)]
pub struct IntrinsicSharedArchivePortfolioOptions<'a> {
    pub direct_candidate_evaluation_caps: Option<HashMap<IntrinsicSharedArchiveDirectRole, f64>>,
    pub maximum_direct_runtime_ms: Option<f64>,
    /// Opt-in canonical-grid pause quantum; other direct roles remain unchanged.
    pub canonical_grid_completed_piece_quantum: Option<f64>,
    pub on_canonical_grid_checkpointed: Option<OnCanonicalGridCheckpointed<'a>>,
    pub on_phase_completed:
        Option<&'a mut dyn FnMut(SharedArchivePhase) -> Result<(), SharedArchiveError>>,
    /// TS: `onDirectConstructed?: (role, state) => void` -- read-only
    /// observation of one committed, uncapped, complete direct constructor
    /// state after its construction returned; synchronous, no error channel.
    pub on_direct_constructed: Option<OnDirectConstructed<'a>>,
    /// TS: defaults to `true` at `:165` when omitted.
    pub include_source_audit_witnesses: Option<bool>,
}

// ===========================================================================
// Private monotonic clock (see this module's top doc, "Deliberately not
// ported" -- the missing TS-source `timingNow` seam).
// ===========================================================================

static PROCESS_START: LazyLock<Instant> = LazyLock::new(Instant::now);

fn now_ms() -> f64 {
    PROCESS_START.elapsed().as_secs_f64() * 1000.0
}

// ===========================================================================
// `runIntrinsicSharedArchiveDirectPortfolio` (`:241-352`)
// ===========================================================================

fn direct_candidate_mode(role: IntrinsicSharedArchiveDirectRole) -> IntrinsicStrictCandidateMode {
    match role {
        IntrinsicSharedArchiveDirectRole::CanonicalGrid => {
            IntrinsicStrictCandidateMode::Comparator(IntrinsicStrictComparatorMode::PureGrowth)
        }
        IntrinsicSharedArchiveDirectRole::LegacyAbsoluteEnvelope => {
            IntrinsicStrictCandidateMode::Comparator(
                IntrinsicStrictComparatorMode::LegacyAbsoluteEnvelope,
            )
        }
        IntrinsicSharedArchiveDirectRole::OpenPocketFirst => {
            IntrinsicStrictCandidateMode::GapContained
        }
    }
}

/// One `constructIntrinsicStrictState` attempt (`intrinsicSharedArchivePortfolio.ts:277-297`),
/// factored into its own function so each loop iteration in
/// [`run_intrinsic_shared_archive_direct_portfolio`] can call it with a
/// fresh, independently-inferred reborrow. `pieces` and `control` share one
/// explicit lifetime `'a` because `ConstructIntrinsicStrictStateInput<'a>`
/// (constructed in this function's own body) requires it for internal
/// well-formedness regardless of caller -- see this module's `SharedArchiveControl`
/// doc comment for the full rationale and for why callers must reborrow a
/// concrete [`SharedArchiveControl`] wrapper (not the raw
/// `Option<&mut dyn NfpIfpControl>`) to satisfy this across loop iterations.
#[allow(clippy::too_many_arguments)]
fn attempt_direct_construct<'a>(
    pieces: &'a [Arc<IrregularPreparedPiece>],
    role: IntrinsicSharedArchiveDirectRole,
    maximum_direct_runtime_ms: f64,
    requested_candidate_evaluations: Option<f64>,
    checkpoint: Option<IntrinsicStrictDirectCheckpoint>,
    maximum_completed_piece_boundaries: Option<f64>,
    control: Option<&'a mut dyn NfpIfpControl>,
    settings: &IrregularNestingSettings,
    geometry_cache: &mut GeometryCacheStore,
) -> Result<IntrinsicStrictConstructResult, SharedArchiveError> {
    construct_intrinsic_strict_state(
        ConstructIntrinsicStrictStateInput {
            all_prepared_pieces: pieces,
            remaining_prepared_pieces: pieces,
            frozen_placed: &[],
            candidate_mode: direct_candidate_mode(role),
            maximum_runtime_ms: Some(maximum_direct_runtime_ms),
            maximum_candidate_evaluation_count: requested_candidate_evaluations,
            capture_candidate_evaluation_count: true,
            capture_phase_timings: false,
            timing_now: None,
            producer_role: Some(role.as_str().to_string()),
            checkpoint,
            maximum_completed_piece_boundaries,
            control,
        },
        settings,
        geometry_cache,
    )
}

/// TS: `runIntrinsicSharedArchiveDirectPortfolio` (`:241-352`). Runs the
/// three direct roles alone so their exact completion counts can be
/// calibrated. See this module's top doc: has no dependency on the periodic
/// seam and is fully portable/testable today.
pub fn run_intrinsic_shared_archive_direct_portfolio(
    sheet: &SheetSpec,
    pieces: &[Arc<IrregularPreparedPiece>],
    options: &mut IntrinsicSharedArchivePortfolioOptions<'_>,
    // See `IntrinsicSharedArchivePortfolioOptions`'s own doc for why
    // `control` is a bare parameter, not a field of `options`.
    control: Option<&mut dyn NfpIfpControl>,
    settings: &IrregularNestingSettings,
    geometry_cache: &mut GeometryCacheStore,
) -> Result<Vec<IntrinsicSharedArchiveRun>, SharedArchiveError> {
    let maximum_direct_runtime_ms = options.maximum_direct_runtime_ms.unwrap_or(600_000.0);
    let mut runs: Vec<IntrinsicSharedArchiveRun> = Vec::new();
    // See `SharedArchiveControl`'s own doc comment: wrapped once here so
    // each loop iteration below can reborrow the concrete wrapper
    // (`Some(&mut control)`) instead of re-reborrowing the raw
    // `Option<&mut dyn NfpIfpControl>`.
    let mut control = SharedArchiveControl { inner: control };

    for role in INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES {
        let started_at = now_ms();
        let requested_candidate_evaluations = options
            .direct_candidate_evaluation_caps
            .as_ref()
            .and_then(|caps| caps.get(&role).copied());
        let mut checkpoint: Option<IntrinsicStrictDirectCheckpoint> = None;
        let mut outcome: Result<IntrinsicStrictConstructResult, SharedArchiveError>;

        loop {
            let maximum_completed_piece_boundaries =
                if role == IntrinsicSharedArchiveDirectRole::CanonicalGrid {
                    options.canonical_grid_completed_piece_quantum
                } else {
                    None
                };
            outcome = attempt_direct_construct(
                pieces,
                role,
                maximum_direct_runtime_ms,
                requested_candidate_evaluations,
                checkpoint.clone(),
                maximum_completed_piece_boundaries,
                Some(&mut control),
                settings,
                geometry_cache,
            );
            let next_checkpoint = match &outcome {
                Ok(constructed) => constructed.checkpoint.clone(),
                Err(_) => None,
            };
            if next_checkpoint.is_none() {
                break;
            }
            checkpoint = next_checkpoint;
            if let Some(callback) = options.on_canonical_grid_checkpointed.as_deref_mut() {
                // `attempt_direct_construct`'s own borrow of `control` and
                // `geometry_cache` above has already ended (the call
                // returned), so both are free to be reborrowed again here
                // and handed to the callback -- see
                // `OnCanonicalGridCheckpointed`'s own doc comment for why
                // these are passed as callback parameters rather than
                // captured by the closure itself.
                callback(
                    checkpoint.as_ref().expect("checkpoint just set"),
                    Some(&mut control),
                    geometry_cache,
                )?;
            }
        }

        match outcome {
            Err(error) => {
                if let IntrinsicStrictDecoderFailure::Abort(abort) = &error {
                    if abort.reason == NfpIfpAbortReason::Cancelled {
                        return Err(error);
                    }
                }
                let status = match &error {
                    IntrinsicStrictDecoderFailure::Abort(_) => {
                        IntrinsicSharedArchiveRunStatus::Deadline
                    }
                    _ => IntrinsicSharedArchiveRunStatus::Invalid,
                };
                let reason = shared_archive_error_message(&error);
                runs.push(IntrinsicSharedArchiveRun {
                    role: role.as_str().to_string(),
                    source_id: None,
                    status,
                    requested_candidate_evaluations,
                    consumed_candidate_evaluations: None,
                    reason: Some(reason),
                    endpoint: None,
                    runtime_ms: js_math::max(0.0, now_ms() - started_at),
                });
                continue;
            }
            Ok(constructed) => {
                if constructed.truncation_reason.is_none()
                    && constructed.state.remaining_prepared_pieces.is_empty()
                    && constructed.state.unplaced_piece_ids.is_empty()
                {
                    if let Some(callback) = options.on_direct_constructed.as_deref_mut() {
                        callback(role, &constructed.state);
                    }
                }
                runs.push(normalize_intrinsic_shared_archive_constructed_run(
                    NormalizeIntrinsicSharedArchiveConstructedRunInput {
                        sheet: sheet.clone(),
                        role: role.as_str().to_string(),
                        source_id: None,
                        requested_candidate_evaluations,
                        constructed,
                    },
                ));
            }
        }
    }
    Ok(runs)
}

// ===========================================================================
// `retainRankedSharedArchive` (`:355-380`)
// ===========================================================================

/// TS: `retainRankedSharedArchive` (`:355-380`). Canonically deduplicates
/// complete endpoints and applies the strict terminal rank.
pub fn retain_ranked_shared_archive(
    endpoints: &[IntrinsicSharedArchiveEndpoint],
) -> Vec<IntrinsicSharedArchiveEndpoint> {
    let mut identity = |endpoint: &IntrinsicSharedArchiveEndpoint| {
        Some(endpoint.sheetless_canonical_geometry_hash.clone())
    };
    let mut validate = |endpoint: &IntrinsicSharedArchiveEndpoint| {
        endpoint.sheetless_canonical_geometry_hash == endpoint.metrics.canonical_geometry_hash
    };
    let mut select_duplicate =
        |first: &IntrinsicSharedArchiveEndpoint, _second: &IntrinsicSharedArchiveEndpoint| {
            first.clone()
        };
    let mut rank =
        |unique: Vec<IntrinsicSharedArchiveEndpoint>| -> Vec<IntrinsicSharedArchiveEndpoint> {
            let mut ranked_by_hash: HashMap<String, IntrinsicSharedArchiveEndpoint> =
                HashMap::new();
            for endpoint in &unique {
                ranked_by_hash.insert(
                    endpoint.sheetless_canonical_geometry_hash.clone(),
                    endpoint.clone(),
                );
            }
            let metrics: Vec<IntrinsicStrictCompletedMetrics> = unique
                .iter()
                .map(|endpoint| endpoint.metrics.clone())
                .collect();
            rank_intrinsic_strict_completed_layouts(&metrics)
                .into_iter()
                .filter_map(|metrics| {
                    ranked_by_hash
                        .get(&metrics.canonical_geometry_hash)
                        .cloned()
                })
                .collect()
        };
    retain_intrinsic_anytime_archive_namespace(IntrinsicAnytimeArchiveNamespacePolicy {
        namespace: IntrinsicAnytimeArchiveNamespace::Complete,
        endpoints,
        identity: &mut identity,
        validate: &mut validate,
        select_duplicate: &mut select_duplicate,
        rank: &mut rank,
    })
}

/// TS: `selectFittingSharedArchive` (`:383-389`). Keeps sheetless rank order
/// while removing endpoints that do not fit the requested sheet.
pub fn select_fitting_shared_archive(
    sheetless_archive: &[IntrinsicSharedArchiveEndpoint],
) -> Vec<IntrinsicSharedArchiveEndpoint> {
    sheetless_archive
        .iter()
        .filter(|endpoint| endpoint.requested_sheet_fit.selected_rotation_deg.is_some())
        .cloned()
        .collect()
}

// ===========================================================================
// Winner comparators (`:407-473`)
// ===========================================================================

fn parse_bigint(value: &str) -> BigInt {
    value
        .parse()
        .expect("decimal doubled-area/deficit strings are always valid BigInt literals")
}

fn compare_f64(first: f64, second: f64) -> Ordering {
    first.partial_cmp(&second).unwrap_or(Ordering::Equal)
}

/// TS: `compareCertificateDeficit` (`:424-441`).
fn compare_certificate_deficit(
    first: &IntrinsicSharedArchiveEndpoint,
    second: &IntrinsicSharedArchiveEndpoint,
) -> Ordering {
    match (
        &first.certificate.exact_relative_deficit_numerator,
        &first.certificate.exact_relative_deficit_denominator,
        &second.certificate.exact_relative_deficit_numerator,
        &second.certificate.exact_relative_deficit_denominator,
    ) {
        (Some(first_num), Some(first_den), Some(second_num), Some(second_den)) => {
            let left = parse_bigint(first_num) * parse_bigint(second_den);
            let right = parse_bigint(second_num) * parse_bigint(first_den);
            left.cmp(&right)
        }
        _ => compare_f64(
            first.certificate.relative_deficit_sum,
            second.certificate.relative_deficit_sum,
        ),
    }
}

/// TS: `compareLargestHullGap` (`:443-456`).
fn compare_largest_hull_gap(
    first: &IntrinsicSharedArchiveEndpoint,
    second: &IntrinsicSharedArchiveEndpoint,
) -> Ordering {
    match (&first.metrics.exact, &second.metrics.exact) {
        (Some(first_exact), Some(second_exact)) => {
            let left = parse_bigint(&first_exact.largest_occupied_hull_gap_doubled_area_grid2)
                * parse_bigint(&second_exact.occupied_hull_doubled_area_grid2);
            let right = parse_bigint(&second_exact.largest_occupied_hull_gap_doubled_area_grid2)
                * parse_bigint(&first_exact.occupied_hull_doubled_area_grid2);
            left.cmp(&right)
        }
        _ => compare_f64(
            first.metrics.largest_occupied_hull_gap_ratio,
            second.metrics.largest_occupied_hull_gap_ratio,
        ),
    }
}

/// TS: `compareEnvelope` (`:458-473`).
fn compare_envelope(
    first: &IntrinsicSharedArchiveEndpoint,
    second: &IntrinsicSharedArchiveEndpoint,
) -> Ordering {
    match (&first.metrics.exact, &second.metrics.exact) {
        (Some(first_exact), Some(second_exact)) => parse_bigint(&first_exact.envelope_area_grid2)
            .cmp(&parse_bigint(&second_exact.envelope_area_grid2))
            .then_with(|| {
                compare_f64(
                    first_exact.envelope_maximum_side_grid,
                    second_exact.envelope_maximum_side_grid,
                )
            })
            .then_with(|| {
                compare_f64(
                    first_exact.envelope_span_grid,
                    second_exact.envelope_span_grid,
                )
            }),
        _ => compare_f64(
            first.metrics.envelope_area_mm2,
            second.metrics.envelope_area_mm2,
        )
        .then_with(|| {
            compare_f64(
                first.metrics.envelope_maximum_side_mm,
                second.metrics.envelope_maximum_side_mm,
            )
        })
        .then_with(|| {
            compare_f64(
                first.metrics.envelope_span_mm,
                second.metrics.envelope_span_mm,
            )
        }),
    }
}

/// TS: `compareIntrinsicSharedArchiveWinner` (`:407-418`).
fn compare_intrinsic_shared_archive_winner(
    first: &IntrinsicSharedArchiveEndpoint,
    second: &IntrinsicSharedArchiveEndpoint,
) -> Ordering {
    compare_certificate_deficit(first, second)
        .then_with(|| {
            compare_f64(
                first.metrics.enclosed_cavity_count,
                second.metrics.enclosed_cavity_count,
            )
        })
        .then_with(|| compare_largest_hull_gap(first, second))
        .then_with(|| compare_envelope(first, second))
        .then_with(|| {
            locale_compare_keys(
                &first.sheetless_canonical_geometry_hash,
                &second.sheetless_canonical_geometry_hash,
            )
        })
}

/// TS: `selectIntrinsicSharedArchiveWinner` (`:392-405`). Selects one
/// cohesive winner without allowing contact to veto geometric dominance.
pub fn select_intrinsic_shared_archive_winner(
    archive: &[IntrinsicSharedArchiveEndpoint],
) -> Option<IntrinsicSharedArchiveEndpoint> {
    let metrics: Vec<IntrinsicStrictCompletedMetrics> = archive
        .iter()
        .map(|endpoint| endpoint.metrics.clone())
        .collect();
    let front = select_intrinsic_strict_completed_pareto_front(&metrics);
    let geometric_front_hashes: HashSet<String> = front
        .into_iter()
        .map(|metrics| metrics.canonical_geometry_hash)
        .collect();
    let mut filtered: Vec<IntrinsicSharedArchiveEndpoint> = archive
        .iter()
        .filter(|endpoint| {
            geometric_front_hashes.contains(&endpoint.sheetless_canonical_geometry_hash)
        })
        .cloned()
        .collect();
    filtered.sort_by(compare_intrinsic_shared_archive_winner);
    filtered.into_iter().next()
}

// ===========================================================================
// Validity predicates (`:476-552`)
// ===========================================================================

/// TS: `intrinsicSharedPeriodicSelectionValid`'s input object (`:477-483`).
pub struct IntrinsicSharedPeriodicSelectionValidInput {
    pub catalog_runtime_coverage_complete: bool,
    pub continuation_coverage_complete: bool,
    pub selected_continuation_count: f64,
    pub run_count: f64,
    pub budget_settlement_complete: bool,
}

/// TS: `intrinsicSharedPeriodicSelectionValid` (`:476-494`). Requires
/// uncensored selection and deterministic settlement of every selected
/// source.
pub fn intrinsic_shared_periodic_selection_valid(
    input: &IntrinsicSharedPeriodicSelectionValidInput,
) -> bool {
    input.catalog_runtime_coverage_complete
        && input.selected_continuation_count <= INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT
        && input.run_count == input.selected_continuation_count
        && (input.continuation_coverage_complete
            || input.selected_continuation_count
                == INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT)
        && input.budget_settlement_complete
}

/// TS: `intrinsicSharedArchiveExperimentValid` (`:497-519`). Requires direct
/// completion; only periodic continuations may settle at their fixed cap.
pub fn intrinsic_shared_archive_experiment_valid(
    direct_runs: &[IntrinsicSharedArchiveRun],
    periodic_runs: &[IntrinsicSharedArchiveRun],
    periodic_selection_valid: bool,
) -> bool {
    periodic_selection_valid
        && direct_runs.iter().all(|run| {
            run.status == IntrinsicSharedArchiveRunStatus::Completed
                && run.requested_candidate_evaluations.is_some()
                && run.requested_candidate_evaluations == run.consumed_candidate_evaluations
        })
        && periodic_runs.iter().all(|run| {
            matches!(
                run.status,
                IntrinsicSharedArchiveRunStatus::Completed
                    | IntrinsicSharedArchiveRunStatus::EvaluationCap
            )
        })
}

/// TS: `intrinsicSharedPeriodicCatalogCoverageValid` (`:542-552`). Rejects
/// runtime censoring while allowing fully executed deterministic
/// family/front caps.
pub fn intrinsic_shared_periodic_catalog_coverage_valid(
    catalog: &IntrinsicPeriodicCatalogCoverage,
) -> bool {
    catalog.runtime_coverage_complete
        && (!catalog.families.is_empty() || catalog.family_coverage_complete)
        && catalog
            .families
            .iter()
            .all(|family| family.cell_coverage_complete || family.source_audit_cells_present)
}

/// TS: `intrinsicSharedArchiveProductionValid` (`:522-539`). Requires every
/// uncapped direct role and every applicable periodic source to settle
/// cleanly. This is the predicate that gates the entire Compact/Compact
/// Short Side nesting job (`shared-archive.md` §11).
pub fn intrinsic_shared_archive_production_valid(
    result: &IntrinsicSharedArchivePortfolioResult,
) -> bool {
    let direct_valid = result.direct_runs.iter().all(|run| {
        run.status == IntrinsicSharedArchiveRunStatus::Completed && run.endpoint.is_some()
    });
    let catalog = &result.periodic_portfolio.catalog;
    let has_periodic_families = !catalog.families.is_empty();
    let catalog_coverage_valid = intrinsic_shared_periodic_catalog_coverage_valid(catalog);
    direct_valid
        && catalog_coverage_valid
        && (!has_periodic_families || result.periodic_selection_valid)
        && result.periodic_runs.iter().all(|run| {
            matches!(
                run.status,
                IntrinsicSharedArchiveRunStatus::Completed
                    | IntrinsicSharedArchiveRunStatus::EvaluationCap
            )
        })
}

// ===========================================================================
// `normalizeIntrinsicSharedArchiveConstructedRun` (`:560-609`)
// ===========================================================================

/// TS: `normalizeIntrinsicSharedArchiveConstructedRun`'s input object (`:560-565`).
pub struct NormalizeIntrinsicSharedArchiveConstructedRunInput {
    pub sheet: SheetSpec,
    pub role: String,
    pub source_id: Option<String>,
    pub requested_candidate_evaluations: Option<f64>,
    pub constructed: IntrinsicStrictConstructResult,
}

/// TS: `normalizeIntrinsicSharedArchiveConstructedRun` (`:560-609`).
pub fn normalize_intrinsic_shared_archive_constructed_run(
    input: NormalizeIntrinsicSharedArchiveConstructedRunInput,
) -> IntrinsicSharedArchiveRun {
    let consumed_candidate_evaluations =
        Some(input.constructed.candidate_evaluation_count.unwrap_or(0.0));
    if input.constructed.truncation_reason == Some(TruncationReason::MaximumCandidateEvaluations) {
        return IntrinsicSharedArchiveRun {
            role: input.role,
            source_id: input.source_id,
            status: IntrinsicSharedArchiveRunStatus::EvaluationCap,
            requested_candidate_evaluations: input.requested_candidate_evaluations,
            consumed_candidate_evaluations,
            reason: Some("maximum-candidate-evaluations".to_string()),
            endpoint: None,
            runtime_ms: input.constructed.runtime_ms,
        };
    }
    let endpoint =
        make_intrinsic_shared_archive_endpoint(MakeIntrinsicSharedArchiveEndpointInput {
            sheet: &input.sheet,
            role: input.role.clone(),
            source_id: input.source_id.clone(),
            state: Arc::clone(&input.constructed.state),
            runtime_ms: Some(input.constructed.runtime_ms),
        });
    match endpoint {
        None => IntrinsicSharedArchiveRun {
            role: input.role,
            source_id: input.source_id,
            status: IntrinsicSharedArchiveRunStatus::Incomplete,
            requested_candidate_evaluations: input.requested_candidate_evaluations,
            consumed_candidate_evaluations,
            reason: Some(
                "construction did not produce one complete canonical-exact endpoint".to_string(),
            ),
            endpoint: None,
            runtime_ms: input.constructed.runtime_ms,
        },
        Some(endpoint) => IntrinsicSharedArchiveRun {
            role: input.role,
            source_id: input.source_id,
            status: IntrinsicSharedArchiveRunStatus::Completed,
            requested_candidate_evaluations: input.requested_candidate_evaluations,
            consumed_candidate_evaluations,
            reason: None,
            endpoint: Some(endpoint),
            runtime_ms: input.constructed.runtime_ms,
        },
    }
}

// ===========================================================================
// `makeIntrinsicSharedArchiveEndpoint` (`:612-637`)
// ===========================================================================

/// TS: `makeIntrinsicSharedArchiveEndpoint`'s input object (`:612-617`).
pub struct MakeIntrinsicSharedArchiveEndpointInput<'a> {
    pub sheet: &'a SheetSpec,
    pub role: String,
    pub source_id: Option<String>,
    pub state: Arc<IrregularBeamState>,
    pub runtime_ms: Option<f64>,
}

/// TS: `makeIntrinsicSharedArchiveEndpoint` (`:612-637`). Adapts any
/// complete exact layout into the common sheetless archive boundary.
pub fn make_intrinsic_shared_archive_endpoint(
    input: MakeIntrinsicSharedArchiveEndpointInput<'_>,
) -> Option<IntrinsicSharedArchiveEndpoint> {
    if !input.state.remaining_prepared_pieces.is_empty()
        || !input.state.unplaced_piece_ids.is_empty()
    {
        return None;
    }
    let measured = measure_intrinsic_sheetless_completed_layout(
        &input.state,
        input.runtime_ms.unwrap_or(0.0),
    )?;
    Some(IntrinsicSharedArchiveEndpoint {
        role: input.role,
        source_id: input.source_id,
        sheetless_canonical_geometry_identity: measured.canonical_geometry_identity,
        sheetless_canonical_geometry_hash: measured.canonical_geometry_hash,
        placed_collision_geometries: measured.placed_collision_geometries,
        certificate: evaluate_intrinsic_strict_certificate(&measured.metrics),
        requested_sheet_fit: requested_sheet_fit(input.sheet, &input.state),
        metrics: measured.metrics,
    })
}

// ===========================================================================
// `normalizePeriodicRun` (`:639-670`)
// ===========================================================================

fn normalize_periodic_run(
    sheet: &SheetSpec,
    run: &IntrinsicPeriodicContinuationResult,
    requested_candidate_evaluations: Option<f64>,
) -> IntrinsicSharedArchiveRun {
    let role = format!("periodic-{}", run.continuation.role);
    if let Some(constructed) = &run.constructed {
        return normalize_intrinsic_shared_archive_constructed_run(
            NormalizeIntrinsicSharedArchiveConstructedRunInput {
                sheet: sheet.clone(),
                role,
                source_id: Some(run.continuation.source_id.clone()),
                requested_candidate_evaluations,
                constructed: constructed.clone(),
            },
        );
    }
    let status = match run.status {
        IntrinsicPeriodicContinuationStatus::GlobalDeadline => {
            IntrinsicSharedArchiveRunStatus::GlobalDeadline
        }
        IntrinsicPeriodicContinuationStatus::Deadline => IntrinsicSharedArchiveRunStatus::Deadline,
        IntrinsicPeriodicContinuationStatus::EvaluationCap => {
            IntrinsicSharedArchiveRunStatus::EvaluationCap
        }
        _ => IntrinsicSharedArchiveRunStatus::Invalid,
    };
    IntrinsicSharedArchiveRun {
        role,
        source_id: Some(run.continuation.source_id.clone()),
        status,
        requested_candidate_evaluations,
        consumed_candidate_evaluations: None,
        reason: Some(
            run.reason
                .clone()
                .unwrap_or_else(|| periodic_status_str(run.status).to_string()),
        ),
        endpoint: None,
        runtime_ms: run.runtime_ms,
    }
}

// ===========================================================================
// `requestedSheetFit` (`:672-725`)
// ===========================================================================

struct OrientationFitInternal {
    rotation_deg: TerminalRotationDeg,
    fits: bool,
    canonical_geometry_hash: Option<String>,
    placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
}

fn rotation_deg_ordinal(rotation_deg: TerminalRotationDeg) -> f64 {
    match rotation_deg {
        TerminalRotationDeg::Zero => 0.0,
        TerminalRotationDeg::Ninety => 90.0,
    }
}

fn fit_orientation(
    sheet: &SheetSpec,
    state: &Arc<IrregularBeamState>,
    rotation_deg: TerminalRotationDeg,
) -> OrientationFitInternal {
    let quarter_turn = match rotation_deg {
        TerminalRotationDeg::Zero => IrregularQuarterTurnDegrees::Zero,
        TerminalRotationDeg::Ninety => IrregularQuarterTurnDegrees::Ninety,
    };
    let empty = || OrientationFitInternal {
        rotation_deg,
        fits: false,
        canonical_geometry_hash: None,
        placed_collision_geometries: Vec::new(),
    };
    let Some(oriented) = Arc::clone(state).with_quarter_turn_bottom_left(quarter_turn) else {
        return empty();
    };
    let placed_owned: Vec<IrregularPlacedPiece> = oriented
        .placed_collision_geometries
        .iter()
        .map(|placed| (**placed).clone())
        .collect();
    if !assert_canonical_grid_legal_layout(sheet, &placed_owned) {
        return empty();
    }
    let Some(identity) = canonical_collision_layout_identity(&placed_owned) else {
        return empty();
    };
    OrientationFitInternal {
        rotation_deg,
        fits: true,
        canonical_geometry_hash: Some(sha256_hex(&identity)),
        placed_collision_geometries: oriented.placed_collision_geometries.clone(),
    }
}

/// TS: `requestedSheetFit` (`:672-725`). Pure function of `(sheet, state)`,
/// no persisted state. Computes `fit(0)` and `fit(90)` unconditionally, both,
/// always.
fn requested_sheet_fit(
    sheet: &SheetSpec,
    state: &Arc<IrregularBeamState>,
) -> IntrinsicSharedArchiveSheetFit {
    let q0 = fit_orientation(sheet, state, TerminalRotationDeg::Zero);
    let q90 = fit_orientation(sheet, state, TerminalRotationDeg::Ninety);

    let mut candidates: Vec<&OrientationFitInternal> = Vec::with_capacity(2);
    if q0.fits && q0.canonical_geometry_hash.is_some() {
        candidates.push(&q0);
    }
    if q90.fits && q90.canonical_geometry_hash.is_some() {
        candidates.push(&q90);
    }
    // TS: `.toSorted((a, b) => a.canonicalGeometryHash.localeCompare(b...)
    // || a.rotationDeg - b.rotationDeg)[0]` -- literal hash-first,
    // rotation-second comparator (see `shared-archive.md` §6's "derived
    // rule" discussion for why the literal two-key form, not the simplified
    // "prefer 0 whenever it fits" shortcut, must ship).
    candidates.sort_by(|first, second| {
        locale_compare_keys(
            first.canonical_geometry_hash.as_deref().unwrap_or(""),
            second.canonical_geometry_hash.as_deref().unwrap_or(""),
        )
        .then_with(|| {
            compare_f64(
                rotation_deg_ordinal(first.rotation_deg),
                rotation_deg_ordinal(second.rotation_deg),
            )
        })
    });
    let selected = candidates.first().copied();

    IntrinsicSharedArchiveSheetFit {
        q0: IntrinsicSharedArchiveOrientationFit {
            fits: q0.fits,
            canonical_geometry_hash: q0.canonical_geometry_hash.clone(),
        },
        q90: IntrinsicSharedArchiveOrientationFit {
            fits: q90.fits,
            canonical_geometry_hash: q90.canonical_geometry_hash.clone(),
        },
        selected_rotation_deg: selected.map(|found| found.rotation_deg),
        selected_canonical_geometry_hash: selected
            .and_then(|found| found.canonical_geometry_hash.clone()),
        selected_placed_collision_geometries: selected
            .map(|found| found.placed_collision_geometries.clone())
            .unwrap_or_default(),
    }
}

// ===========================================================================
// `runIntrinsicSharedArchivePortfolio` (`:155-238`) -- see this module's top
// doc, "Seam: the periodic-family-portfolio sibling module (not yet
// ported)".
// ===========================================================================

/// TS: `runIntrinsicPeriodicFamilyPortfolio`'s forced-option subset
/// (`:196-203`): the four fields this cluster unconditionally overrides on
/// every periodic call (caller-supplied `options.periodic` cannot change
/// them -- enforced at the TS type level by an `Omit`, `:145-151`), plus the
/// same `control` seam threaded into the direct phase.
pub struct IntrinsicPeriodicFamilyPortfolioForcedOptions<'a> {
    pub maximum_continuation_candidate_evaluations: f64,
    pub maximum_continuation_count: f64,
    pub capture_source_survival_audit: bool,
    pub admit_source_audit_witnesses: bool,
    pub control: Option<&'a mut dyn NfpIfpControl>,
}

/// Seam trait standing in for the not-yet-ported
/// `runIntrinsicPeriodicFamilyPortfolio`. See this module's top doc.
///
/// `geometry_cache` is an explicit method parameter, not a field an
/// implementor captures ahead of time (e.g. at construction). TS's
/// `runIntrinsicPeriodicFamilyPortfolio` reads the *same* single
/// job-ambient `GeometryCacheService` instance the direct phase does
/// (`nesting.worker.ts`'s `NfpIfpServiceLive`/`geometryCacheStoreLive.ts`
/// provide exactly one instance per job, per `cache-concurrency-design.md`
/// §2) -- a Rust implementor that instead captured its own
/// separately-`GeometryCacheStore::new()`d cache at construction would
/// silently diverge from that (two independent memoization tables can
/// return different cache hit/miss sequences for numerically-tied
/// candidates, which is exactly `differential-e2e-report.md`'s Finding N1).
/// Taking it as a call parameter here lets [`run_intrinsic_shared_archive_portfolio`]
/// hand the runner a fresh reborrow of its own single `geometry_cache`
/// parameter, taken *after* the direct phase's own borrow of that same
/// local has already ended (function calls, not overlapping struct-field
/// captures) -- the same reborrow-as-a-parameter pattern this module's
/// `OnCanonicalGridCheckpointed` doc comment documents for `control`.
pub trait IntrinsicPeriodicFamilyPortfolioRunner {
    fn run(
        &mut self,
        sheet: &SheetSpec,
        pieces: &[Arc<IrregularPreparedPiece>],
        forced: IntrinsicPeriodicFamilyPortfolioForcedOptions<'_>,
        geometry_cache: &mut GeometryCacheStore,
    ) -> Result<IntrinsicPeriodicFamilyPortfolioResult, SharedArchiveError>;
}

/// TS: `runIntrinsicSharedArchivePortfolio` (`:155-238`). Runs the smallest
/// protected, pocket-first, and periodic archive matrix.
#[allow(clippy::too_many_arguments)]
pub fn run_intrinsic_shared_archive_portfolio(
    sheet: &SheetSpec,
    pieces: &[Arc<IrregularPreparedPiece>],
    options: &mut IntrinsicSharedArchivePortfolioOptions<'_>,
    // See `IntrinsicSharedArchivePortfolioOptions`'s own doc for why
    // `control` is a bare parameter, not a field of `options`. TS threads
    // the same `options.control` into both the direct and periodic phases;
    // here that becomes "reborrow the same wrapped local for each phase"
    // (this module's top doc, "Seam: `SharedArchiveControl`").
    control: Option<&mut dyn NfpIfpControl>,
    periodic_runner: &mut dyn IntrinsicPeriodicFamilyPortfolioRunner,
    settings: &IrregularNestingSettings,
    geometry_cache: &mut GeometryCacheStore,
) -> Result<IntrinsicSharedArchivePortfolioResult, SharedArchiveError> {
    let include_source_audit_witnesses = options.include_source_audit_witnesses.unwrap_or(true);
    let mut control = SharedArchiveControl { inner: control };

    let direct_runs = run_intrinsic_shared_archive_direct_portfolio(
        sheet,
        pieces,
        options,
        Some(&mut control),
        settings,
        geometry_cache,
    )?;
    if let Some(callback) = options.on_phase_completed.as_deref_mut() {
        callback(SharedArchivePhase::Direct)?;
    }

    // `run_intrinsic_shared_archive_direct_portfolio`'s own borrow of
    // `geometry_cache` above has already ended (that call returned), so it
    // is free to be reborrowed again here for the periodic phase -- see
    // `IntrinsicPeriodicFamilyPortfolioRunner`'s own doc comment for why
    // this is a call parameter rather than a field the runner captured
    // ahead of time.
    let periodic_portfolio = periodic_runner.run(
        sheet,
        pieces,
        IntrinsicPeriodicFamilyPortfolioForcedOptions {
            maximum_continuation_candidate_evaluations:
                INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP,
            maximum_continuation_count: INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT,
            capture_source_survival_audit: include_source_audit_witnesses,
            admit_source_audit_witnesses: include_source_audit_witnesses,
            control: Some(&mut control),
        },
        geometry_cache,
    )?;
    if let Some(callback) = options.on_phase_completed.as_deref_mut() {
        callback(SharedArchivePhase::Periodic)?;
    }

    let periodic_runs: Vec<IntrinsicSharedArchiveRun> = periodic_portfolio
        .runs
        .iter()
        .map(|run| {
            normalize_periodic_run(
                sheet,
                run,
                Some(INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP),
            )
        })
        .collect();

    let endpoints: Vec<IntrinsicSharedArchiveEndpoint> = direct_runs
        .iter()
        .chain(periodic_runs.iter())
        .filter_map(|run| run.endpoint.clone())
        .collect();

    let sheetless_archive = retain_ranked_shared_archive(&endpoints);
    let archive = select_fitting_shared_archive(&sheetless_archive);
    let winner = select_intrinsic_shared_archive_winner(&archive);
    let periodic_selection_valid =
        intrinsic_shared_periodic_selection_valid(&IntrinsicSharedPeriodicSelectionValidInput {
            catalog_runtime_coverage_complete: periodic_portfolio.catalog.runtime_coverage_complete,
            continuation_coverage_complete: periodic_portfolio.continuation_coverage_complete,
            selected_continuation_count: periodic_portfolio.continuation_count,
            run_count: periodic_portfolio.runs.len() as f64,
            budget_settlement_complete: periodic_portfolio.continuation_budget_settlement_complete
                == Some(true),
        });
    let experiment_valid = intrinsic_shared_archive_experiment_valid(
        &direct_runs,
        &periodic_runs,
        periodic_selection_valid,
    );

    Ok(IntrinsicSharedArchivePortfolioResult {
        direct_runs,
        periodic_runs,
        periodic_portfolio,
        sheetless_archive,
        archive,
        winner,
        periodic_selection_valid,
        experiment_valid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ImportedPiece;
    use crate::domain::{
        CollisionGeometry, DxfGeometryEntityType, DxfGeometrySummary, IrregularBounds,
        IrregularPlacement, IrregularPoint, IrregularPolygon, IrregularTransform,
        IrregularTransformCandidate, IrregularTransformReason, PieceId, Rect, SourceFileId,
        TransformedCollisionGeometry,
    };
    use crate::search::beam_state::{IrregularBeamStateInput, WithPlacementInput};
    use crate::search::strict_decoder::IntrinsicStrictCompletedMetricsExact;

    fn square(side: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(side, 0.0),
            IrregularPoint::new(side, side),
            IrregularPoint::new(0.0, side),
        ])
    }

    fn placed_piece(id: &str, x: f64, y: f64, side: f64) -> Arc<IrregularPlacedPiece> {
        let polygon = square(side);
        Arc::new(IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: Some(PieceId::new(id)),
                source_piece_id: PieceId::new(id),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x: x,
                    translate_y: y,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new(id),
                transform: IrregularTransformCandidate {
                    index: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                    reason: IrregularTransformReason::Orthogonal,
                },
                polygon: polygon.clone(),
                bounds: IrregularBounds::new(x, y, x + side, y + side),
            },
        })
    }

    fn sheet(width: f64, height: f64) -> SheetSpec {
        SheetSpec {
            width,
            height,
            label: "test-sheet".to_string(),
        }
    }

    fn base_metrics(hash: &str) -> IntrinsicStrictCompletedMetrics {
        IntrinsicStrictCompletedMetrics {
            envelope_maximum_side_mm: 10.0,
            envelope_area_mm2: 100.0,
            envelope_span_mm: 14.14,
            enclosed_cavity_count: 0.0,
            total_enclosed_cavity_area_mm2: 0.0,
            largest_occupied_hull_gap_ratio: 0.0,
            isolated_piece_count: 0.0,
            positive_contact_component_count: 1.0,
            largest_positive_contact_component_size: 1.0,
            largest_positive_contact_component_ratio: 1.0,
            occupied_area_outside_largest_contact_component_mm2: 0.0,
            occupied_hull_waste_ratio: 0.0,
            total_structural_contacts: 0.0,
            dominant_structural_contacts: 0.0,
            contact_units: 0.0,
            shared_boundary_length_mm: 0.0,
            canonical_geometry_hash: hash.to_string(),
            runtime_ms: 0.0,
            exact: None,
        }
    }

    fn exact_metrics(
        hash: &str,
        envelope_area_grid2: &str,
        cavity_count: f64,
        hull_gap_grid2: &str,
        hull_grid2: &str,
    ) -> IntrinsicStrictCompletedMetrics {
        let mut metrics = base_metrics(hash);
        metrics.enclosed_cavity_count = cavity_count;
        metrics.exact = Some(IntrinsicStrictCompletedMetricsExact {
            envelope_maximum_side_grid: 10_000.0,
            envelope_area_grid2: envelope_area_grid2.to_string(),
            envelope_span_grid: 14_140.0,
            total_enclosed_cavity_doubled_area_grid2: "0".to_string(),
            largest_occupied_hull_gap_doubled_area_grid2: hull_gap_grid2.to_string(),
            occupied_hull_doubled_area_grid2: hull_grid2.to_string(),
            occupied_hull_waste_doubled_area_grid2: "0".to_string(),
            largest_positive_contact_component_size: 1.0,
            placed_piece_count: 1.0,
            occupied_outside_largest_contact_component_doubled_area_grid2: "0".to_string(),
        });
        metrics
    }

    fn certificate(passing: bool) -> IntrinsicStrictCertificate {
        IntrinsicStrictCertificate {
            passes: passing,
            violated_floors: Vec::new(),
            relative_deficit_sum: if passing { 0.0 } else { 0.5 },
            exact_relative_deficit_numerator: None,
            exact_relative_deficit_denominator: None,
        }
    }

    fn endpoint(
        role: &str,
        metrics: IntrinsicStrictCompletedMetrics,
        fits: bool,
    ) -> IntrinsicSharedArchiveEndpoint {
        let hash = metrics.canonical_geometry_hash.clone();
        IntrinsicSharedArchiveEndpoint {
            role: role.to_string(),
            source_id: None,
            sheetless_canonical_geometry_identity: format!("identity-{hash}"),
            sheetless_canonical_geometry_hash: hash,
            placed_collision_geometries: Vec::new(),
            certificate: certificate(true),
            requested_sheet_fit: IntrinsicSharedArchiveSheetFit {
                q0: IntrinsicSharedArchiveOrientationFit {
                    fits,
                    canonical_geometry_hash: None,
                },
                q90: IntrinsicSharedArchiveOrientationFit {
                    fits: false,
                    canonical_geometry_hash: None,
                },
                selected_rotation_deg: if fits {
                    Some(TerminalRotationDeg::Zero)
                } else {
                    None
                },
                selected_canonical_geometry_hash: None,
                selected_placed_collision_geometries: Vec::new(),
            },
            metrics,
        }
    }

    // -----------------------------------------------------------------
    // TS: tests/unit/intrinsicSharedArchivePortfolio.test.ts:63-76 --
    // "dedup-by-hash-keeps-role-of-first-encounter".
    // -----------------------------------------------------------------
    #[test]
    fn retain_ranked_shared_archive_dedup_keeps_role_of_first_encounter() {
        let metrics_a = base_metrics("hash-a");
        let first = endpoint("canonical-grid", metrics_a.clone(), true);
        let duplicate = endpoint("legacy-absolute-envelope", metrics_a, true);
        let retained = retain_ranked_shared_archive(&[first, duplicate]);
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].role, "canonical-grid");
    }

    #[test]
    fn retain_ranked_shared_archive_rejects_hash_mismatch() {
        let mut mismatched = endpoint("canonical-grid", base_metrics("hash-a"), true);
        mismatched.sheetless_canonical_geometry_hash = "different-hash".to_string();
        let retained = retain_ranked_shared_archive(&[mismatched]);
        assert!(retained.is_empty());
    }

    // -----------------------------------------------------------------
    // TS: tests/unit/intrinsicSharedArchivePortfolio.test.ts:149-173 --
    // "does not let a cohesion certificate rescue geometrically dominated
    // geometry".
    // -----------------------------------------------------------------
    #[test]
    fn winner_selection_does_not_let_certificate_rescue_geometrically_dominated_layout() {
        // "small" strictly dominates "large" on both compactness axes
        // (smaller envelope area, no worse cavity count) -- large's
        // passing certificate must not rescue it.
        let small_metrics = exact_metrics("small-hash", "100", 0.0, "0", "1000");
        let large_metrics = exact_metrics("large-hash", "400", 0.0, "0", "1000");
        let mut small = endpoint("canonical-grid", small_metrics, true);
        small.certificate = certificate(true);
        let mut large = endpoint("legacy-absolute-envelope", large_metrics, true);
        large.certificate = certificate(true);

        let winner = select_intrinsic_shared_archive_winner(&[small.clone(), large]);
        assert_eq!(
            winner.map(|w| w.sheetless_canonical_geometry_hash),
            Some(small.sheetless_canonical_geometry_hash)
        );
    }

    #[test]
    fn winner_selection_prefers_lower_certificate_deficit_among_pareto_front() {
        // Neither dominates the other (small envelope but more cavities);
        // both survive the Pareto front, so the certificate-deficit
        // comparator decides.
        let compact_metrics = exact_metrics("compact-hash", "100", 2.0, "0", "1000");
        let spread_metrics = exact_metrics("spread-hash", "400", 0.0, "0", "1000");
        let mut compact = endpoint("canonical-grid", compact_metrics, true);
        compact.certificate = certificate(false);
        let mut spread = endpoint("legacy-absolute-envelope", spread_metrics, true);
        spread.certificate = certificate(true);

        let winner = select_intrinsic_shared_archive_winner(&[compact, spread.clone()]);
        assert_eq!(
            winner.map(|w| w.sheetless_canonical_geometry_hash),
            Some(spread.sheetless_canonical_geometry_hash)
        );
    }

    // -----------------------------------------------------------------
    // TS: tests/unit/intrinsicSharedArchivePortfolio.test.ts:175-220 --
    // normalizeIntrinsicSharedArchiveConstructedRun evaluation-cap and
    // incomplete-endpoint exclusion.
    // -----------------------------------------------------------------
    fn empty_beam_state() -> Arc<IrregularBeamState> {
        IrregularBeamState::from_input(IrregularBeamStateInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometries: Vec::new(),
            unplaced_piece_ids: None,
            unplaced_source_piece_ids: None,
            placement_order: Vec::new(),
            parent: None,
            placed_collision_index: None,
        })
    }

    fn construct_result(
        state: Arc<IrregularBeamState>,
        truncation_reason: Option<TruncationReason>,
    ) -> IntrinsicStrictConstructResult {
        IntrinsicStrictConstructResult {
            state,
            step_trace: Vec::new(),
            gap_fill_evidence: Vec::new(),
            candidate_evaluation_count: Some(5.0),
            truncation_reason,
            pause_reason: None,
            checkpoint: None,
            phase_timings: None,
            runtime_ms: 12.0,
        }
    }

    #[test]
    fn normalize_constructed_run_reports_evaluation_cap_with_no_endpoint() {
        let run = normalize_intrinsic_shared_archive_constructed_run(
            NormalizeIntrinsicSharedArchiveConstructedRunInput {
                sheet: sheet(100.0, 100.0),
                role: "canonical-grid".to_string(),
                source_id: None,
                requested_candidate_evaluations: Some(5.0),
                constructed: construct_result(
                    empty_beam_state(),
                    Some(TruncationReason::MaximumCandidateEvaluations),
                ),
            },
        );
        assert_eq!(run.status, IntrinsicSharedArchiveRunStatus::EvaluationCap);
        assert!(run.endpoint.is_none());
        assert_eq!(run.consumed_candidate_evaluations, Some(5.0));
    }

    #[test]
    fn normalize_constructed_run_reports_incomplete_when_pieces_remain_unplaced() {
        let piece = Arc::new(IrregularPreparedPiece {
            piece_id: Some(PieceId::new("remaining")),
            interchangeability_key: None,
            source: ImportedPiece {
                id: PieceId::new("remaining"),
                source_file_id: SourceFileId::new("source-remaining"),
                source_layer: None,
                label: "remaining".to_string(),
                real_bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                },
                geometry: DxfGeometrySummary {
                    entity_type: DxfGeometryEntityType::PresetShape,
                    closed: true,
                    segments: Vec::new(),
                },
                warnings: Vec::new(),
            },
            allow_mirror: false,
            collision_geometry: CollisionGeometry {
                source_piece_id: PieceId::new("remaining"),
                source_bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
                sampled_points: square(10.0).points,
                convex_hull: square(10.0),
                collision_polygon: square(10.0),
                placement_reference: IrregularPoint::new(0.0, 0.0),
                diagnostics: Vec::new(),
            },
            transforms: Vec::new(),
            priority_order_key: None,
        });
        let state = IrregularBeamState::from_input(IrregularBeamStateInput {
            remaining_prepared_pieces: vec![piece],
            placed_collision_geometries: Vec::new(),
            unplaced_piece_ids: None,
            unplaced_source_piece_ids: None,
            placement_order: Vec::new(),
            parent: None,
            placed_collision_index: None,
        });
        let run = normalize_intrinsic_shared_archive_constructed_run(
            NormalizeIntrinsicSharedArchiveConstructedRunInput {
                sheet: sheet(100.0, 100.0),
                role: "canonical-grid".to_string(),
                source_id: None,
                requested_candidate_evaluations: None,
                constructed: construct_result(state, None),
            },
        );
        assert_eq!(run.status, IntrinsicSharedArchiveRunStatus::Incomplete);
        assert!(run.endpoint.is_none());
    }

    #[test]
    fn normalize_constructed_run_reports_completed_for_an_exact_sheetless_layout() {
        let placed = placed_piece("solo", 0.0, 0.0, 10.0);
        let state = Arc::clone(&empty_beam_state()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: placed,
            placement_order_piece_id: PieceId::new("solo"),
            on_phase_timings: None,
            timing_now: None,
        });
        let run = normalize_intrinsic_shared_archive_constructed_run(
            NormalizeIntrinsicSharedArchiveConstructedRunInput {
                sheet: sheet(100.0, 100.0),
                role: "open-pocket-first".to_string(),
                source_id: None,
                requested_candidate_evaluations: None,
                constructed: construct_result(state, None),
            },
        );
        assert_eq!(run.status, IntrinsicSharedArchiveRunStatus::Completed);
        assert!(run.endpoint.is_some());
        let endpoint = run.endpoint.unwrap();
        assert!(endpoint.requested_sheet_fit.selected_rotation_deg.is_some());
    }

    // -----------------------------------------------------------------
    // requestedSheetFit: q0 is preferred whenever it legally fits.
    // -----------------------------------------------------------------
    #[test]
    fn requested_sheet_fit_selects_q0_when_it_fits() {
        let placed = placed_piece("solo", 0.0, 0.0, 10.0);
        let state = Arc::clone(&empty_beam_state()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: placed,
            placement_order_piece_id: PieceId::new("solo"),
            on_phase_timings: None,
            timing_now: None,
        });
        let fit = requested_sheet_fit(&sheet(100.0, 100.0), &state);
        assert!(fit.q0.fits);
        assert_eq!(fit.selected_rotation_deg, Some(TerminalRotationDeg::Zero));
        assert!(fit.selected_canonical_geometry_hash.is_some());
        assert_eq!(
            fit.q0.canonical_geometry_hash,
            fit.q90.canonical_geometry_hash
        );
    }

    #[test]
    fn requested_sheet_fit_reports_no_fit_when_sheet_too_small() {
        let placed = placed_piece("solo", 0.0, 0.0, 10.0);
        let state = Arc::clone(&empty_beam_state()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: placed,
            placement_order_piece_id: PieceId::new("solo"),
            on_phase_timings: None,
            timing_now: None,
        });
        let fit = requested_sheet_fit(&sheet(1.0, 1.0), &state);
        assert!(!fit.q0.fits);
        assert!(!fit.q90.fits);
        assert!(fit.selected_rotation_deg.is_none());
        assert!(fit.selected_placed_collision_geometries.is_empty());
    }

    // -----------------------------------------------------------------
    // TS: tests/unit/intrinsicSharedArchivePortfolio.test.ts:222-276 --
    // intrinsicSharedPeriodicSelectionValid, six cases.
    // -----------------------------------------------------------------
    fn valid_selection_input() -> IntrinsicSharedPeriodicSelectionValidInput {
        IntrinsicSharedPeriodicSelectionValidInput {
            catalog_runtime_coverage_complete: true,
            continuation_coverage_complete: true,
            selected_continuation_count: 3.0,
            run_count: 3.0,
            budget_settlement_complete: true,
        }
    }

    #[test]
    fn periodic_selection_valid_accepts_the_fully_covered_case() {
        assert!(intrinsic_shared_periodic_selection_valid(
            &valid_selection_input()
        ));
    }

    #[test]
    fn periodic_selection_valid_rejects_incomplete_catalog_runtime_coverage() {
        let mut input = valid_selection_input();
        input.catalog_runtime_coverage_complete = false;
        assert!(!intrinsic_shared_periodic_selection_valid(&input));
    }

    #[test]
    fn periodic_selection_valid_rejects_over_cap_selection_count() {
        let mut input = valid_selection_input();
        input.selected_continuation_count = 9.0;
        input.run_count = 9.0;
        assert!(!intrinsic_shared_periodic_selection_valid(&input));
    }

    #[test]
    fn periodic_selection_valid_rejects_run_count_mismatch() {
        let mut input = valid_selection_input();
        input.run_count = 2.0;
        assert!(!intrinsic_shared_periodic_selection_valid(&input));
    }

    #[test]
    fn periodic_selection_valid_accepts_incomplete_continuation_coverage_at_the_cap() {
        let mut input = valid_selection_input();
        input.continuation_coverage_complete = false;
        input.selected_continuation_count = INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT;
        input.run_count = INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT;
        assert!(intrinsic_shared_periodic_selection_valid(&input));
    }

    #[test]
    fn periodic_selection_valid_rejects_incomplete_continuation_coverage_below_the_cap() {
        let mut input = valid_selection_input();
        input.continuation_coverage_complete = false;
        assert!(!intrinsic_shared_periodic_selection_valid(&input));
    }

    #[test]
    fn periodic_selection_valid_rejects_incomplete_budget_settlement() {
        let mut input = valid_selection_input();
        input.budget_settlement_complete = false;
        assert!(!intrinsic_shared_periodic_selection_valid(&input));
    }

    // -----------------------------------------------------------------
    // TS: tests/unit/intrinsicSharedArchivePortfolio.test.ts:278-336 --
    // intrinsicSharedArchiveExperimentValid, three cases.
    // -----------------------------------------------------------------
    fn completed_direct_run(requested: f64, consumed: f64) -> IntrinsicSharedArchiveRun {
        IntrinsicSharedArchiveRun {
            role: "canonical-grid".to_string(),
            source_id: None,
            status: IntrinsicSharedArchiveRunStatus::Completed,
            requested_candidate_evaluations: Some(requested),
            consumed_candidate_evaluations: Some(consumed),
            reason: None,
            endpoint: None,
            runtime_ms: 0.0,
        }
    }

    #[test]
    fn experiment_valid_accepts_matched_requested_and_consumed_counts() {
        let direct = vec![completed_direct_run(10.0, 10.0)];
        let periodic = vec![];
        assert!(intrinsic_shared_archive_experiment_valid(
            &direct, &periodic, true
        ));
    }

    #[test]
    fn experiment_valid_rejects_when_requested_is_never_set() {
        let mut run = completed_direct_run(10.0, 10.0);
        run.requested_candidate_evaluations = None;
        assert!(!intrinsic_shared_archive_experiment_valid(
            &[run],
            &[],
            true
        ));
    }

    #[test]
    fn experiment_valid_rejects_a_non_completed_periodic_run() {
        let direct = vec![completed_direct_run(10.0, 10.0)];
        let periodic = vec![IntrinsicSharedArchiveRun {
            role: "periodic-P1".to_string(),
            source_id: Some("source".to_string()),
            status: IntrinsicSharedArchiveRunStatus::Invalid,
            requested_candidate_evaluations: None,
            consumed_candidate_evaluations: None,
            reason: None,
            endpoint: None,
            runtime_ms: 0.0,
        }];
        assert!(!intrinsic_shared_archive_experiment_valid(
            &direct, &periodic, true
        ));
    }

    // -----------------------------------------------------------------
    // TS: tests/unit/intrinsicSharedArchivePortfolio.test.ts:338-392 --
    // intrinsicSharedPeriodicCatalogCoverageValid, two cases.
    // -----------------------------------------------------------------
    #[test]
    fn catalog_coverage_valid_accepts_full_coverage_with_families() {
        let catalog = IntrinsicPeriodicCatalogCoverage {
            runtime_coverage_complete: true,
            family_coverage_complete: true,
            families: vec![IntrinsicPeriodicFamilyCatalogCoverage {
                cell_coverage_complete: true,
                source_audit_cells_present: false,
            }],
        };
        assert!(intrinsic_shared_periodic_catalog_coverage_valid(&catalog));
    }

    #[test]
    fn catalog_coverage_valid_rejects_incomplete_runtime_coverage() {
        let catalog = IntrinsicPeriodicCatalogCoverage {
            runtime_coverage_complete: false,
            family_coverage_complete: true,
            families: Vec::new(),
        };
        assert!(!intrinsic_shared_periodic_catalog_coverage_valid(&catalog));
    }

    #[test]
    fn catalog_coverage_valid_accepts_a_family_with_incomplete_cells_when_audited() {
        let catalog = IntrinsicPeriodicCatalogCoverage {
            runtime_coverage_complete: true,
            family_coverage_complete: false,
            families: vec![IntrinsicPeriodicFamilyCatalogCoverage {
                cell_coverage_complete: false,
                source_audit_cells_present: true,
            }],
        };
        assert!(intrinsic_shared_periodic_catalog_coverage_valid(&catalog));
    }
}
