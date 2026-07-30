//! The irregular-nesting coordinator: request preparation, the intrinsic
//! shared-archive/capacity/reconstruction/Short-Side orchestration, and
//! final `IrregularComputeResult` materialization.
//!
//! TS source: `src/workers/algorithm/irregular/computeIrregularNesting.ts`
//! (1920 lines), read in full, together with
//! `docs/planning/rust-irregular-backend/characterization/worker-coordination.md`
//! (this module's primary governing source) and this repo's
//! `docs/planning/rust-irregular-backend/architecture.md` coordinator
//! section.
//!
//! # Scope: the archive-eligible path only (R1/R2)
//!
//! Per the migration rulings, only the **Compact** and **Compact Short
//! Side** production profiles are ported here -- i.e. exactly the branch of
//! `coordinateIntrinsicSharedArchive` reached when
//! `isIntrinsicSharedArchiveEligible(settings)` is `true`
//! (`computeIrregularNesting.ts:483-1064`). The legacy windowed-beam/GA
//! branch (`:1065-1069`, `runSingleSheetPortfolio` /
//! `materializeProductionResult` / `reconstructPlacedGeometry`) is
//! confirmed dead for both target profiles by
//! `worker-coordination.md` §1 ("Not exercised by Compact or Compact Short
//! Side production traffic... Do not port this branch as part of
//! 'Compact'") and stays TypeScript-only. [`coordinator::compute_irregular_nesting`]
//! returns a typed [`IrregularComputeErrorType::Portfolio`] routing error
//! (operation `"computeIrregularNesting"`) when a request reaches this
//! native entry point without archive eligibility, rather than silently
//! emulating the legacy path.
//!
//! # Resolved: `capacity::mode`'s top-level orchestration
//!
//! `capacity::mode.rs` now carries the full `runIntrinsicCapacityMode` /
//! `runProtectedCapacityLaneCoordinator` / `runIntrinsicCapacityCohesionShadow`
//! / `runIntrinsicCapacitySchedulerColdQuantum` orchestration
//! (`intrinsicCapacityMode.ts`, 1430 lines), against the real
//! `capacity::search`/`capacity::prefixes` APIs (both fully ported). Per the
//! reconciliation this section previously prescribed once that orchestration
//! landed: [`coordinator`] calls `capacity::mode::run_intrinsic_capacity_mode`/
//! `run_intrinsic_capacity_scheduler_cold_quantum` directly (no injected
//! trait object) at both call sites (`preflight.kind === 'proven_impossible'`,
//! and "no fitting shared-archive winner") -- both are reachable at points
//! in the coordinator's own control flow where `geometry_cache` is not
//! concurrently borrowed by anything else, so direct calls need no seam.
//!
//! # Resolved seam: `archive::shared`'s periodic-family-portfolio runner
//!
//! `archive::shared`'s own top doc ("Seam: the periodic-family-portfolio
//! sibling module (not yet ported)") anticipated exactly this reconciliation:
//! `archive::periodic_family` is fully ported now
//! (`run_intrinsic_periodic_family_portfolio`), so [`coordinator::RealIntrinsicPeriodicFamilyPortfolioRunner`]
//! is a real, non-stub implementation of `archive::shared::IntrinsicPeriodicFamilyPortfolioRunner`
//! that calls it directly -- this replaces the seam's previous
//! not-yet-ported placeholder with the production implementation.
//!
//! # Deliberately not ported
//!
//! - `emitDecisionTrace`/decision-trace NDJSON emission -- confirmed dead
//!   for Compact/Compact Short Side by `worker-coordination.md` §1: the only
//!   call site that forwards it is inside `runSingleSheetPortfolio`, the
//!   legacy non-archive branch this module does not port. Implementing it
//!   here would be new, untested behavior, not a port of existing behavior.
//! - `maxHistoryEvents`-driven truncation -- confirmed dead everywhere under
//!   `src/workers`/`src/main` by the same document (§3.1); this module must
//!   not invent truncation logic the TS baseline does not have.
//! - Every benchmark-only `ComputeIrregularNestingOptions` field never set
//!   by `nesting.worker.ts` in production (`onPortfolioPhase`,
//!   `onPortfolioMetrics`, `onFinalizationMetrics`,
//!   `capacityControlArm`, `captureCapacity*Telemetry`,
//!   `captureExperimentalPlaceDeferCompleteShadow`,
//!   `intrinsicCapacityRetentionShadow`, `onPreparedPieces`,
//!   `onCapacity*Lane`, `captureIntrinsicShortSideObserver`,
//!   `onIntrinsicShortSideObserver*`, `captureIntrinsicShortSidePairFoldObserver`,
//!   `onIntrinsicShortSidePairFoldObserverWinner`) -- `worker-coordination.md`
//!   §1 confirms these are test/script-only surfaces, not production
//!   behavior. This port's [`coordinator::ComputeIrregularNestingOptions`]
//!   only carries the three fields production actually sets
//!   (`emitStateSnapshot`, `emitPortfolioProgress`, `isCancelled` -- the
//!   latter unused by production today, per §10, but ported since it is a
//!   real, cheap, load-bearing seam for test/script harnesses) plus
//!   `focusedCompleteReconstructionControlArm`, which is read unconditionally
//!   on the archive-eligible path (`:487`) even though production never sets
//!   it to `'disable'`.

pub mod coordinator;
pub mod materialize;
pub mod progress;

use std::sync::Arc;

use crate::domain::{
    ImportedPiece, IrregularLayoutScoreSummary, IrregularNestingSettings, IrregularPlacedPiece,
    PieceId, SheetSpec,
};
use crate::nfp_ifp::{NfpIfpAbortReason, NfpIfpControlAbortError};
use crate::search::beam_state::IrregularBeamState;
use crate::search::layout_scorer::{IrregularLayoutScorerError, IrregularLayoutScoringError};
use crate::search::placement_scorer::IrregularPlacementScoringError;
use crate::search::sort_pieces::PreparedPiece;
use crate::validation::placement::IrregularGeometryInputError;

// ===========================================================================
// Request/options (`src/shared/domain/nesting.ts:143-152`, the coordinator's
// own inbound-request seam -- `domain::mod`'s own doc confirms result/
// protocol classes are this module's to define, not `crate::domain`'s).
// ===========================================================================

/// TS: `nesting.ts:107-117` `NestingOptions`, limited to the fields this
/// cluster's coordinator actually reads (`workerMode`/`timeoutMs`/
/// `maxHistoryEvents` are read elsewhere, per this module's top doc,
/// "Deliberately not ported").
#[derive(Clone, Debug, PartialEq)]
pub struct NestingOptions {
    pub allow_global_rotation: bool,
    /// TS: `options.allowGlobalMirror ?? true` (`:407`) -- `None` mirrors
    /// the TS field being absent (defaults `true` at the one read site).
    pub allow_global_mirror: Option<bool>,
    pub history_mode: HistoryMode,
    /// TS: `request.options.irregularSettings ?? GeometrySettings.Make`
    /// (`nesting.worker.ts:375`) -- the fallback default itself is resolved
    /// by whoever wires `GeometrySettings` (out of this module's scope);
    /// `None` here mirrors the field being genuinely absent on the request.
    pub irregular_settings: Option<IrregularNestingSettings>,
}

/// TS: `nesting.ts:105` `HistoryMode` (`'stream' | 'final' | 'off'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryMode {
    Stream,
    Final,
    Off,
}

/// TS: `nesting.ts:143-152` `NestingRequest`, limited to the fields this
/// cluster's coordinator reads (`version`/`jobId`/`strategyRunId` belong to
/// the protocol/output-adapter layer, out of this module's scope per its top
/// doc).
#[derive(Clone, Debug, PartialEq)]
pub struct NestingRequest {
    pub sheet: SheetSpec,
    pub padding: f64,
    pub pieces: Vec<PreparedPiece>,
    /// TS: `sourcePieces?: ImportedPiece[]` -- optional; a missing/empty
    /// array behaves identically (`findSourcePiece` finds nothing either
    /// way), so this is a plain `Vec` rather than `Option<Vec<_>>`.
    pub source_pieces: Vec<ImportedPiece>,
    pub options: NestingOptions,
}

// ===========================================================================
// Coordinator-visible state carriers (`computeIrregularNesting.ts:101-127`).
// ===========================================================================

/// TS: `computeIrregularNesting.ts:102-108` `IrregularStateSnapshot`.
///
/// No `PartialEq`: `search::beam_state::IrregularBeamState` does not derive
/// it (immutable search state compared by canonical key, never by structural
/// equality), so this carrier follows suit.
#[derive(Clone, Debug)]
pub struct IrregularStateSnapshot {
    pub step_index: f64,
    pub beam_rank: f64,
    pub candidate_count: f64,
    pub source: Option<IrregularStateSnapshotSource>,
    pub state: Arc<IrregularBeamState>,
}

/// TS: `computeIrregularNesting.ts:106` `'beam' | 'shared-archive'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IrregularStateSnapshotSource {
    Beam,
    SharedArchive,
}

/// TS: `computeIrregularNesting.ts:111-114` `IrregularFinalizationMetrics`.
/// Benchmark-only; never gates control flow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IrregularFinalizationMetrics {
    pub reconstruction_elapsed_ms: f64,
    pub final_score_elapsed_ms: f64,
}

// ===========================================================================
// Portfolio result/progress (`src/shared/irregular/domain.ts`'s
// coordinator-facing classes -- see this module's top doc for why these are
// defined here rather than in `crate::domain`).
// ===========================================================================

/// TS: `domain.ts` `IrregularPortfolioStatus` (`'completed' | 'partial' |
/// 'failed'`), limited to the two variants this cluster's archive path ever
/// constructs (`'completed'` at every call site in
/// `coordinateIntrinsicSharedArchive`); the third is retained for type
/// completeness/exhaustiveness parity with the TS union.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IrregularPortfolioStatus {
    Completed,
    Partial,
    Failed,
}

/// TS: `domain.ts` `IrregularPortfolioTerminationReason`, limited to the
/// three literal values this cluster's archive path actually constructs:
/// `'capacity_subset_settled'`
/// (`materializeIntrinsicCapacityResult`/`:1284`), `'shared_archive_completed'`
/// (`materializeSharedArchiveResult`/`:1550`,
/// `materializeIntrinsicShortSideProfileResult`/`:1626`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IrregularPortfolioTerminationReason {
    CapacitySubsetSettled,
    SharedArchiveCompleted,
}

/// TS: `domain.ts` `IrregularSearchSource` (`'beam' | 'shared-archive'`),
/// limited to the one variant this cluster's archive path ever constructs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IrregularSearchSource {
    SharedArchive,
}

/// TS: `computeIrregularNesting.ts` `new IrregularPortfolioResult({...})`
/// call sites (`:1282-1301`, `:1548-1561`, `:1624-1637`) -- the fields this
/// cluster's archive path actually populates.
#[derive(Clone, Debug, PartialEq)]
pub struct IrregularPortfolioResult {
    pub status: IrregularPortfolioStatus,
    pub termination_reason: IrregularPortfolioTerminationReason,
    pub source: IrregularSearchSource,
    pub placements: Vec<crate::domain::IrregularPlacement>,
    pub unplaced_piece_ids: Vec<PieceId>,
    pub score: IrregularLayoutScoreSummary,
    pub diagnostics: Vec<crate::domain::CollisionGeometryDiagnostic>,
}

/// TS: `domain.ts` `IrregularPortfolioPhase`, limited to the three literal
/// values `emitSharedArchiveProgress` (`computeIrregularNesting.ts:1443-1458`)
/// ever constructs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IrregularPortfolioPhase {
    SharedArchive,
    ShortSideProfile,
    Completed,
}

/// TS: `computeIrregularNesting.ts:1449-1455` `new IrregularPortfolioProgress({...})`.
#[derive(Clone, Debug, PartialEq)]
pub struct IrregularPortfolioProgress {
    pub phase: IrregularPortfolioPhase,
    pub best_score: Option<IrregularLayoutScoreSummary>,
    pub elapsed_ms: f64,
    /// TS: `portfolioProgressForDecodeRole` (`:1460-1467`) -- only ever
    /// applied on the legacy non-archive path (not ported here), so this is
    /// always `None` for every progress event this module emits. Retained
    /// as a field (rather than omitted entirely) so [`IrregularPortfolioProgress`]
    /// stays a faithful projection of the real TS class shape.
    pub decode_role: Option<&'static str>,
}

// ===========================================================================
// `IrregularComputeResult` (`computeIrregularNesting.ts:329-352`).
// ===========================================================================

/// TS: `computeIrregularNesting.ts:329-352` `IrregularComputeResult`. See
/// this module's top doc for the optional-field presence semantics (each
/// documented per-field below, matching `worker-coordination.md` §3.3's
/// table exactly) and [`coordinator`] for the assembly call site
/// (`:1208-1238`).
/// No `PartialEq`: carries [`IrregularStateSnapshot`], which does not derive
/// it (see that type's doc comment).
#[derive(Clone, Debug)]
pub struct IrregularComputeResult {
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub score: crate::search::layout_scorer::IrregularLayoutScore,
    pub unplaced_piece_ids: Vec<PieceId>,
    pub diagnostics: Vec<crate::domain::CollisionGeometryDiagnostic>,
    pub sorted_piece_ids: Vec<PieceId>,
    pub state_snapshots: Vec<IrregularStateSnapshot>,
    pub beam_width: f64,
    pub portfolio: IrregularPortfolioResult,
    /// Present only when intrinsic capacity mode settled this result.
    pub capacity_trace: Option<crate::capacity::mode::IntrinsicCapacityTrace>,
    /// Present only when the scheduler cold-start ran (every archive-branch
    /// run that reaches the non-`proven_impossible` preflight outcome).
    pub intrinsic_anytime_scheduler_trace: Option<IntrinsicAnytimeSchedulerTrace>,
    /// Present only when the focused complete reconstruction experiment ran
    /// (`focusedCompleteReconstructionEnabled`, true unless explicitly
    /// disabled -- production never disables it).
    pub focused_complete_reconstruction_trace: Option<IntrinsicFocusedCompleteReconstructionTrace>,
    /// Present only when the Short Side observer block ran.
    pub intrinsic_short_side_observer_trace:
        Option<crate::short_side::observer::IntrinsicShortSideObserverTrace>,
    /// Present only when the Short Side pair-fold observer ran inside that
    /// block.
    pub intrinsic_short_side_pair_fold_trace:
        Option<crate::short_side::pair_fold::IntrinsicShortSidePairFoldTrace>,
}

// ===========================================================================
// `IntrinsicFocusedCompleteReconstructionTrace`
// (`computeIrregularNesting.ts:185-204`).
// ===========================================================================

/// TS: `computeIrregularNesting.ts:187-195` status union.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicFocusedCompleteReconstructionStatus {
    Completed,
    DuplicateOrder,
    EvaluationCap,
    Deadline,
    Incomplete,
    FailedProtectedFallback,
    SkippedPreflightProvenImpossible,
    SkippedNoFittingProtectedEndpoint,
}

impl IntrinsicFocusedCompleteReconstructionStatus {
    /// TS: `computeIrregularNesting.ts:187-195` literal union. Any
    /// TS-facing string must use this, not `{:?}`.
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicFocusedCompleteReconstructionStatus::Completed => "completed",
            IntrinsicFocusedCompleteReconstructionStatus::DuplicateOrder => "duplicate-order",
            IntrinsicFocusedCompleteReconstructionStatus::EvaluationCap => "evaluation-cap",
            IntrinsicFocusedCompleteReconstructionStatus::Deadline => "deadline",
            IntrinsicFocusedCompleteReconstructionStatus::Incomplete => "incomplete",
            IntrinsicFocusedCompleteReconstructionStatus::FailedProtectedFallback => {
                "failed-protected-fallback"
            }
            IntrinsicFocusedCompleteReconstructionStatus::SkippedPreflightProvenImpossible => {
                "skipped-preflight-proven-impossible"
            }
            IntrinsicFocusedCompleteReconstructionStatus::SkippedNoFittingProtectedEndpoint => {
                "skipped-no-fitting-protected-endpoint"
            }
        }
    }
}

impl serde::Serialize for IntrinsicFocusedCompleteReconstructionStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `computeIrregularNesting.ts:202` `outputInfluence`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicFocusedCompleteReconstructionOutputInfluence {
    Selected,
    ProtectedFallback,
    None,
}

impl IntrinsicFocusedCompleteReconstructionOutputInfluence {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicFocusedCompleteReconstructionOutputInfluence::Selected => "selected",
            IntrinsicFocusedCompleteReconstructionOutputInfluence::ProtectedFallback => {
                "protected-fallback"
            }
            IntrinsicFocusedCompleteReconstructionOutputInfluence::None => "none",
        }
    }
}

impl serde::Serialize for IntrinsicFocusedCompleteReconstructionOutputInfluence {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `computeIrregularNesting.ts:185-204` `IntrinsicFocusedCompleteReconstructionTrace`.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicFocusedCompleteReconstructionTrace {
    pub version: &'static str,
    pub status: IntrinsicFocusedCompleteReconstructionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_canonical_geometry_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_canonical_geometry_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_canonical_geometry_hash: Option<String>,
    pub consumed_candidate_evaluations: f64,
    pub candidate_evaluation_accounting_complete: bool,
    pub runtime_ms: f64,
    pub output_influence: IntrinsicFocusedCompleteReconstructionOutputInfluence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

pub const INTRINSIC_FOCUSED_COMPLETE_RECONSTRUCTION_TRACE_VERSION: &str =
    "intrinsic-focused-complete-reconstruction-v1";

// ===========================================================================
// `IntrinsicAnytimeSchedulerTrace` (`computeIrregularNesting.ts:206-326`).
// Fully self-contained: no dependency on the missing `capacity::mode`
// orchestration, so this is a complete, faithful, differentially-testable
// port.
// ===========================================================================

/// TS: `computeIrregularNesting.ts:217` `cohort`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeSchedulerCohort {
    Partial,
    Complete,
    ExperimentalComplete,
}

impl IntrinsicAnytimeSchedulerCohort {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicAnytimeSchedulerCohort::Partial => "partial",
            IntrinsicAnytimeSchedulerCohort::Complete => "complete",
            IntrinsicAnytimeSchedulerCohort::ExperimentalComplete => "experimental-complete",
        }
    }
}

impl serde::Serialize for IntrinsicAnytimeSchedulerCohort {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `computeIrregularNesting.ts:218-223` `producerRole`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeSchedulerProducerRole {
    CapacityCold,
    CapacityQualityWarmPrefix,
    LegacyComplete,
    CapacityWarmPrefix,
    ExperimentalPlaceDeferComplete,
}

impl IntrinsicAnytimeSchedulerProducerRole {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicAnytimeSchedulerProducerRole::CapacityCold => "capacity-cold",
            IntrinsicAnytimeSchedulerProducerRole::CapacityQualityWarmPrefix => {
                "capacity-quality-warm-prefix"
            }
            IntrinsicAnytimeSchedulerProducerRole::LegacyComplete => "legacy-complete",
            IntrinsicAnytimeSchedulerProducerRole::CapacityWarmPrefix => "capacity-warm-prefix",
            IntrinsicAnytimeSchedulerProducerRole::ExperimentalPlaceDeferComplete => {
                "experimental-place-defer-complete"
            }
        }
    }
}

impl serde::Serialize for IntrinsicAnytimeSchedulerProducerRole {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `computeIrregularNesting.ts:224` `outcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeSchedulerOutcome {
    Checkpointed,
    Settled,
    Cancelled,
    Censored,
}

impl IntrinsicAnytimeSchedulerOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicAnytimeSchedulerOutcome::Checkpointed => "checkpointed",
            IntrinsicAnytimeSchedulerOutcome::Settled => "settled",
            IntrinsicAnytimeSchedulerOutcome::Cancelled => "cancelled",
            IntrinsicAnytimeSchedulerOutcome::Censored => "censored",
        }
    }
}

impl serde::Serialize for IntrinsicAnytimeSchedulerOutcome {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `computeIrregularNesting.ts:215-225` one `quanta` entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicAnytimeSchedulerQuantum {
    pub ordinal: usize,
    pub cohort: IntrinsicAnytimeSchedulerCohort,
    pub producer_role: IntrinsicAnytimeSchedulerProducerRole,
    pub outcome: IntrinsicAnytimeSchedulerOutcome,
}

/// TS: `computeIrregularNesting.ts:214` `coldStartStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeSchedulerColdStartStatus {
    Paused,
    Settled,
}

impl IntrinsicAnytimeSchedulerColdStartStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicAnytimeSchedulerColdStartStatus::Paused => "paused",
            IntrinsicAnytimeSchedulerColdStartStatus::Settled => "settled",
        }
    }
}

impl serde::Serialize for IntrinsicAnytimeSchedulerColdStartStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `computeIrregularNesting.ts:214` `cancellationReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeSchedulerCancellationReason {
    CompleteEndpointFitted,
    CompleteCohortMiss,
}

impl IntrinsicAnytimeSchedulerCancellationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicAnytimeSchedulerCancellationReason::CompleteEndpointFitted => {
                "complete-endpoint-fitted"
            }
            IntrinsicAnytimeSchedulerCancellationReason::CompleteCohortMiss => {
                "complete-cohort-miss"
            }
        }
    }
}

impl serde::Serialize for IntrinsicAnytimeSchedulerCancellationReason {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `computeIrregularNesting.ts:206-226` `IntrinsicAnytimeSchedulerTrace`.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicAnytimeSchedulerTrace {
    pub version: &'static str,
    pub cold_quantum_depths: f64,
    pub cold_start_status: IntrinsicAnytimeSchedulerColdStartStatus,
    pub cold_start_completed_depths: f64,
    pub cold_start_consumed_placement_evaluations: f64,
    pub cold_checkpoint_reused: bool,
    pub warm_prefix_endpoints_admitted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancellation_reason: Option<IntrinsicAnytimeSchedulerCancellationReason>,
    pub quanta: Vec<IntrinsicAnytimeSchedulerQuantum>,
}

pub const INTRINSIC_ANYTIME_SCHEDULER_TRACE_VERSION: &str = "intrinsic-anytime-scheduler-v1";

/// TS: `computeIrregularNesting.ts:229-326` `intrinsicAnytimeSchedulerTraceValid`.
/// Verifies scheduler chronology and legal producer-state transitions. A
/// direct, mechanical port -- see the TS source's own inline comments (fully
/// reproduced in this function's structure) for why each check exists.
pub fn intrinsic_anytime_scheduler_trace_valid(trace: &IntrinsicAnytimeSchedulerTrace) -> bool {
    use IntrinsicAnytimeSchedulerCancellationReason as Reason;
    use IntrinsicAnytimeSchedulerCohort as Cohort;
    use IntrinsicAnytimeSchedulerOutcome as Outcome;
    use IntrinsicAnytimeSchedulerProducerRole as Role;

    let quanta = &trace.quanta;
    if quanta.len() < 2 || quanta.iter().enumerate().any(|(i, q)| q.ordinal != i) {
        return false;
    }
    let first = &quanta[0];
    if first.producer_role != Role::CapacityCold {
        return false;
    }
    let expected_first_outcome = match trace.cold_start_status {
        IntrinsicAnytimeSchedulerColdStartStatus::Paused => Outcome::Checkpointed,
        IntrinsicAnytimeSchedulerColdStartStatus::Settled => Outcome::Settled,
    };
    if first.outcome != expected_first_outcome {
        return false;
    }

    let complete_indexes: Vec<usize> = quanta
        .iter()
        .enumerate()
        .filter(|(_, q)| q.producer_role == Role::LegacyComplete)
        .map(|(i, _)| i)
        .collect();
    if complete_indexes.is_empty() {
        return false;
    }
    let complete_index = *complete_indexes.last().expect("non-empty checked above");
    let complete_count = complete_indexes.len();
    if complete_indexes
        .iter()
        .enumerate()
        .any(|(ordinal, &index)| {
            let expected = if ordinal == complete_count - 1 {
                Outcome::Settled
            } else {
                Outcome::Checkpointed
            };
            quanta[index].outcome != expected
        })
    {
        return false;
    }

    let experimental_indexes: Vec<usize> = quanta
        .iter()
        .enumerate()
        .filter(|(_, q)| q.producer_role == Role::ExperimentalPlaceDeferComplete)
        .map(|(i, _)| i)
        .collect();
    if experimental_indexes.len() > 1
        || experimental_indexes
            .iter()
            .any(|&index| index <= complete_index)
    {
        return false;
    }

    let later_partial: Vec<(usize, &IntrinsicAnytimeSchedulerQuantum)> = quanta
        .iter()
        .enumerate()
        .filter(|(index, q)| *index > complete_index && q.cohort == Cohort::Partial)
        .collect();
    let later_cold: Vec<&IntrinsicAnytimeSchedulerQuantum> = later_partial
        .iter()
        .filter(|(_, q)| q.producer_role == Role::CapacityCold)
        .map(|(_, q)| *q)
        .collect();
    let later_warm: Vec<&IntrinsicAnytimeSchedulerQuantum> = later_partial
        .iter()
        .filter(|(_, q)| {
            q.producer_role == Role::CapacityWarmPrefix
                || q.producer_role == Role::CapacityQualityWarmPrefix
        })
        .map(|(_, q)| *q)
        .collect();
    let cold_settled_before_complete = quanta.iter().enumerate().any(|(index, q)| {
        index < complete_index
            && q.producer_role == Role::CapacityCold
            && q.outcome == Outcome::Settled
    });
    let first_later_partial_index = quanta
        .iter()
        .enumerate()
        .find(|(index, q)| *index > complete_index && q.cohort == Cohort::Partial)
        .map(|(index, _)| index);
    if experimental_indexes
        .iter()
        .any(|&index| first_later_partial_index.is_some_and(|first_index| index >= first_index))
    {
        return false;
    }

    match trace.cancellation_reason {
        Some(Reason::CompleteCohortMiss) => {
            if later_partial
                .iter()
                .any(|(_, q)| q.outcome == Outcome::Cancelled)
            {
                return false;
            }
            if trace.cold_start_status == IntrinsicAnytimeSchedulerColdStartStatus::Paused
                && !cold_settled_before_complete
                && !later_cold
                    .iter()
                    .any(|q| q.outcome == Outcome::Settled || q.outcome == Outcome::Censored)
            {
                return false;
            }
            let warm_checkpoints = later_warm
                .iter()
                .filter(|q| q.outcome == Outcome::Checkpointed)
                .count();
            let warm_terminals = later_warm
                .iter()
                .filter(|q| q.outcome == Outcome::Settled || q.outcome == Outcome::Censored)
                .count();
            warm_terminals >= warm_checkpoints
        }
        Some(Reason::CompleteEndpointFitted) => {
            if cold_settled_before_complete {
                later_cold.is_empty() && later_warm.is_empty()
            } else {
                trace.cold_start_status == IntrinsicAnytimeSchedulerColdStartStatus::Paused
                    && later_cold.len() == 1
                    && later_cold[0].outcome == Outcome::Cancelled
                    && later_warm.is_empty()
            }
        }
        None => {
            later_partial.is_empty()
                && (trace.cold_start_status == IntrinsicAnytimeSchedulerColdStartStatus::Settled
                    || cold_settled_before_complete)
        }
    }
}

// ===========================================================================
// Error taxonomy (`computeIrregularNesting.ts:354-362`,
// `worker-coordination.md` §11).
// ===========================================================================

/// TS: `computeIrregularNesting.ts:95-99` `IrregularComputeError`. Reports
/// that a prepared piece has no imported geometry available to the worker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IrregularComputeError {
    pub prepared_piece_id: PieceId,
    pub source_piece_id: PieceId,
    pub message: String,
}

/// TS: `services.ts:...` `IrregularNestingNotImplementedError`. Zero
/// reachable production callers on this cluster's own path (per this
/// module's top doc), preserved only for [`IrregularComputeErrorType`]'s
/// exhaustiveness parity with the real 8-member TS union.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IrregularNestingNotImplementedError {
    pub service: String,
    pub operation: String,
    pub message: String,
}

/// TS: `services.ts:...` `IrregularNoValidResultError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IrregularNoValidResultError {
    pub operation: String,
    pub message: String,
}

/// TS: `computeIrregularNesting.ts` `IrregularPortfolioError` category
/// (`'geometry' | 'scoring' | 'search'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IrregularPortfolioErrorCategory {
    Geometry,
    Scoring,
    Search,
}

/// TS: `services.ts:...` `IrregularPortfolioError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IrregularPortfolioError {
    pub operation: String,
    pub category: IrregularPortfolioErrorCategory,
    pub message: String,
}

/// TS: `computeIrregularNesting.ts:354-362` `IrregularComputeErrorType`, the
/// closed 8-tag union. Every arm matches `worker-coordination.md` §11's
/// mapping table (`AppErrorCode`/context fields reproduced verbatim in each
/// arm's doc comment) so a future N-API boundary layer can build
/// `toIrregularWorkerFailure`'s equivalent by exhaustively matching this
/// enum.
#[derive(Clone, Debug, PartialEq)]
pub enum IrregularComputeErrorType {
    /// `AppErrorCode: irregular_source_geometry_missing`, context
    /// `{preparedPieceId, sourcePieceId}`.
    Compute(IrregularComputeError),
    /// `AppErrorCode: irregular_geometry_invalid`, context `{operation}`.
    GeometryInput(IrregularGeometryInputError),
    /// `AppErrorCode: worker_cancelled` (reason `cancelled`) or
    /// `worker_timeout` (reason `deadline`), context `{reason}`.
    NfpIfpControlAbort(NfpIfpControlAbortError),
    /// `AppErrorCode: irregular_no_valid_result`, context `{operation}`.
    NoValidResult(IrregularNoValidResultError),
    /// `AppErrorCode: not_implemented`, context `{service, operation}`.
    NotImplemented(IrregularNestingNotImplementedError),
    /// `AppErrorCode: irregular_geometry_invalid` (category `geometry`) or
    /// `irregular_scoring_error` (category `scoring`/`search`), context
    /// `{operation, category}`.
    Portfolio(IrregularPortfolioError),
    /// `AppErrorCode: irregular_scoring_error`, context `{operation}`.
    PlacementScoring(IrregularPlacementScoringError),
    /// `AppErrorCode: irregular_scoring_error`, context `{operation}`.
    LayoutScoring(IrregularLayoutScoringError),
}

/// TS `AppErrorCode` string this error would map to via
/// `toIrregularWorkerFailure` (`worker-coordination.md` §11's table). Kept
/// here (not just documented) so a future N-API/protocol layer has one
/// authoritative, testable mapping rather than re-deriving the table.
pub fn irregular_compute_error_app_code(error: &IrregularComputeErrorType) -> &'static str {
    match error {
        IrregularComputeErrorType::Compute(_) => "irregular_source_geometry_missing",
        IrregularComputeErrorType::GeometryInput(_) => "irregular_geometry_invalid",
        IrregularComputeErrorType::NfpIfpControlAbort(inner) => match inner.reason {
            NfpIfpAbortReason::Cancelled => "worker_cancelled",
            NfpIfpAbortReason::Deadline => "worker_timeout",
        },
        IrregularComputeErrorType::NoValidResult(_) => "irregular_no_valid_result",
        IrregularComputeErrorType::NotImplemented(_) => "not_implemented",
        IrregularComputeErrorType::Portfolio(inner) => match inner.category {
            IrregularPortfolioErrorCategory::Geometry => "irregular_geometry_invalid",
            IrregularPortfolioErrorCategory::Scoring | IrregularPortfolioErrorCategory::Search => {
                "irregular_scoring_error"
            }
        },
        IrregularComputeErrorType::PlacementScoring(_) => "irregular_scoring_error",
        IrregularComputeErrorType::LayoutScoring(_) => "irregular_scoring_error",
    }
}

impl From<IrregularLayoutScorerError> for IrregularComputeErrorType {
    fn from(value: IrregularLayoutScorerError) -> Self {
        match value {
            IrregularLayoutScorerError::Scoring(inner) => {
                IrregularComputeErrorType::LayoutScoring(inner)
            }
            IrregularLayoutScorerError::GeometryInput(inner) => {
                IrregularComputeErrorType::GeometryInput(geometry_input_error_from_generator(
                    &inner,
                ))
            }
        }
    }
}

/// Bridges `transforms::generator::IrregularGeometryInputError` /
/// `geometry::collision_builder`'s identically-shaped local error type onto
/// this crate's canonical `validation::placement::IrregularGeometryInputError`
/// (the copy `search::strict_decoder`/`archive::shared` already treat as
/// authoritative, per `validation::placement`'s own doc comment: "this
/// module *is* that promised consolidation point"). Both copies are
/// structurally identical (`{operation, message}`); no crate-wide `From`
/// impl exists yet (each copy is independently file-owned), so this
/// coordinator-local conversion is the seam.
pub fn geometry_input_error_from_generator(
    error: &crate::transforms::generator::IrregularGeometryInputError,
) -> IrregularGeometryInputError {
    IrregularGeometryInputError {
        operation: error.operation.clone(),
        message: error.message.clone(),
    }
}

// ===========================================================================
// Archive eligibility gate (`src/shared/irregular/executionMode.ts`).
// ===========================================================================

/// TS: `executionMode.ts` `IntrinsicSharedArchiveIneligibilityReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicSharedArchiveIneligibilityReason {
    ArchiveDisabled,
    GaActive,
    ShortSideFill,
}

/// TS: `executionMode.ts` `IntrinsicSharedArchiveEligibility`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicSharedArchiveEligibility {
    Eligible,
    Ineligible(IntrinsicSharedArchiveIneligibilityReason),
}

impl IntrinsicSharedArchiveEligibility {
    pub fn eligible(self) -> bool {
        matches!(self, IntrinsicSharedArchiveEligibility::Eligible)
    }
}

/// TS: `executionMode.ts:16-32` `intrinsicSharedArchiveEligibility`. Reports
/// whether optimizer settings select the production Compact shared archive.
pub fn intrinsic_shared_archive_eligibility(
    optimizer: &crate::domain::IrregularOptimizerSettings,
) -> IntrinsicSharedArchiveEligibility {
    use crate::domain::IrregularPlacementPolicyId;

    if !optimizer.intrinsic_shared_archive_enabled {
        return IntrinsicSharedArchiveEligibility::Ineligible(
            IntrinsicSharedArchiveIneligibilityReason::ArchiveDisabled,
        );
    }
    if optimizer.placement_policy_id == IrregularPlacementPolicyId::ShortSideFill {
        return IntrinsicSharedArchiveEligibility::Ineligible(
            IntrinsicSharedArchiveIneligibilityReason::ShortSideFill,
        );
    }

    // TS: `optimizer.gaGenerationBudget ?? 4`/`optimizer.gaEvaluationBudget ?? 128`
    // (`executionMode.ts:26-28`) -- both fields are non-optional, always-defined
    // `f64`s on this crate's trusted `IrregularOptimizerSettings` (see
    // `domain::settings`'s own doc: `Schema.withConstructorDefault`/
    // `withDecodingDefaultKey` fields never end up genuinely absent on a real
    // trusted instance), so the `??` fallback can never trigger here and is
    // omitted rather than faked with a `4.0`/`128.0` literal that could
    // silently diverge from the real defaults exported by `domain::settings`.
    let ga_disabled = !optimizer.ga_enabled
        || optimizer.baseline_only
        || optimizer.ga_time_budget_ms == 0.0
        || optimizer.ga_generation_budget == 0.0
        || optimizer.ga_evaluation_budget == 0.0;
    if !ga_disabled {
        return IntrinsicSharedArchiveEligibility::Ineligible(
            IntrinsicSharedArchiveIneligibilityReason::GaActive,
        );
    }

    IntrinsicSharedArchiveEligibility::Eligible
}

/// TS: `computeIrregularNesting.ts:1695-1697` `isIntrinsicSharedArchiveEligible`.
pub fn is_intrinsic_shared_archive_eligible(settings: &IrregularNestingSettings) -> bool {
    intrinsic_shared_archive_eligibility(&settings.optimizer).eligible()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anytime_scheduler_trace_valid_requires_two_quanta_and_capacity_cold_first() {
        let base = IntrinsicAnytimeSchedulerTrace {
            version: INTRINSIC_ANYTIME_SCHEDULER_TRACE_VERSION,
            cold_quantum_depths: 4.0,
            cold_start_status: IntrinsicAnytimeSchedulerColdStartStatus::Settled,
            cold_start_completed_depths: 4.0,
            cold_start_consumed_placement_evaluations: 10.0,
            cold_checkpoint_reused: false,
            warm_prefix_endpoints_admitted: false,
            cancellation_reason: None,
            quanta: vec![
                IntrinsicAnytimeSchedulerQuantum {
                    ordinal: 0,
                    cohort: IntrinsicAnytimeSchedulerCohort::Partial,
                    producer_role: IntrinsicAnytimeSchedulerProducerRole::CapacityCold,
                    outcome: IntrinsicAnytimeSchedulerOutcome::Settled,
                },
                IntrinsicAnytimeSchedulerQuantum {
                    ordinal: 1,
                    cohort: IntrinsicAnytimeSchedulerCohort::Complete,
                    producer_role: IntrinsicAnytimeSchedulerProducerRole::LegacyComplete,
                    outcome: IntrinsicAnytimeSchedulerOutcome::Settled,
                },
            ],
        };
        assert!(intrinsic_anytime_scheduler_trace_valid(&base));

        let mut too_short = base.clone();
        too_short.quanta.truncate(1);
        assert!(!intrinsic_anytime_scheduler_trace_valid(&too_short));

        let mut no_complete = base.clone();
        no_complete.quanta[1].producer_role = IntrinsicAnytimeSchedulerProducerRole::CapacityCold;
        assert!(!intrinsic_anytime_scheduler_trace_valid(&no_complete));
    }

    #[test]
    fn anytime_scheduler_trace_valid_complete_endpoint_fitted_requires_cancelled_cold() {
        let mut trace = IntrinsicAnytimeSchedulerTrace {
            version: INTRINSIC_ANYTIME_SCHEDULER_TRACE_VERSION,
            cold_quantum_depths: 4.0,
            cold_start_status: IntrinsicAnytimeSchedulerColdStartStatus::Paused,
            cold_start_completed_depths: 1.0,
            cold_start_consumed_placement_evaluations: 3.0,
            cold_checkpoint_reused: false,
            warm_prefix_endpoints_admitted: false,
            cancellation_reason: Some(
                IntrinsicAnytimeSchedulerCancellationReason::CompleteEndpointFitted,
            ),
            quanta: vec![
                IntrinsicAnytimeSchedulerQuantum {
                    ordinal: 0,
                    cohort: IntrinsicAnytimeSchedulerCohort::Partial,
                    producer_role: IntrinsicAnytimeSchedulerProducerRole::CapacityCold,
                    outcome: IntrinsicAnytimeSchedulerOutcome::Checkpointed,
                },
                IntrinsicAnytimeSchedulerQuantum {
                    ordinal: 1,
                    cohort: IntrinsicAnytimeSchedulerCohort::Complete,
                    producer_role: IntrinsicAnytimeSchedulerProducerRole::LegacyComplete,
                    outcome: IntrinsicAnytimeSchedulerOutcome::Settled,
                },
                IntrinsicAnytimeSchedulerQuantum {
                    ordinal: 2,
                    cohort: IntrinsicAnytimeSchedulerCohort::Partial,
                    producer_role: IntrinsicAnytimeSchedulerProducerRole::CapacityCold,
                    outcome: IntrinsicAnytimeSchedulerOutcome::Cancelled,
                },
            ],
        };
        assert!(intrinsic_anytime_scheduler_trace_valid(&trace));

        // Wrong outcome on the trailing cancellation quantum invalidates.
        trace.quanta[2].outcome = IntrinsicAnytimeSchedulerOutcome::Settled;
        assert!(!intrinsic_anytime_scheduler_trace_valid(&trace));
    }

    #[test]
    fn archive_eligibility_matches_production_compact_defaults() {
        use crate::domain::{IrregularOptimizerSettings, IrregularPlacementPolicyId};

        let mut optimizer = production_like_optimizer_settings();
        assert_eq!(
            intrinsic_shared_archive_eligibility(&optimizer),
            IntrinsicSharedArchiveEligibility::Eligible
        );

        optimizer.intrinsic_shared_archive_enabled = false;
        assert_eq!(
            intrinsic_shared_archive_eligibility(&optimizer),
            IntrinsicSharedArchiveEligibility::Ineligible(
                IntrinsicSharedArchiveIneligibilityReason::ArchiveDisabled
            )
        );

        let mut short_side_fill = production_like_optimizer_settings();
        short_side_fill.placement_policy_id = IrregularPlacementPolicyId::ShortSideFill;
        assert_eq!(
            intrinsic_shared_archive_eligibility(&short_side_fill),
            IntrinsicSharedArchiveEligibility::Ineligible(
                IntrinsicSharedArchiveIneligibilityReason::ShortSideFill
            )
        );

        let mut ga_active = production_like_optimizer_settings();
        ga_active.ga_enabled = true;
        ga_active.baseline_only = false;
        ga_active.ga_time_budget_ms = 1000.0;
        ga_active.ga_generation_budget = 2.0;
        ga_active.ga_evaluation_budget = 24.0;
        assert_eq!(
            intrinsic_shared_archive_eligibility(&ga_active),
            IntrinsicSharedArchiveEligibility::Ineligible(
                IntrinsicSharedArchiveIneligibilityReason::GaActive
            )
        );

        fn production_like_optimizer_settings() -> IrregularOptimizerSettings {
            IrregularOptimizerSettings {
                order_window: 8.0,
                beam_width: 8.0,
                local_candidate_fanout: 4.0,
                local_repair_budget: 0.0,
                intrinsic_shared_archive_enabled: true,
                intrinsic_objective_profile_id: crate::domain::IntrinsicObjectiveProfileId::Compact,
                transform_cap: 24.0,
                transform_minimum_edge_length_mm: 1.0,
                transform_angle_deduplication_tolerance_deg: 0.01,
                configured_rotation_enabled: true,
                edge_alignment_enabled: true,
                configured_rotation_deg: Vec::new(),
                ga_enabled: false,
                baseline_only: true,
                ga_population: 16.0,
                ga_generation_budget: 2.0,
                ga_evaluation_budget: 24.0,
                ga_time_budget_ms: 0.0,
                ga_seed: "seed".to_string(),
                priority_order_mutation_enabled: true,
                transform_preference_mutation_enabled: true,
                placement_policy_mutation_enabled: true,
                placement_policy_id: IrregularPlacementPolicyId::BalancedCompactness,
                placement_policy_ids: crate::domain::default_irregular_placement_policy_ids(),
            }
        }
    }
}
