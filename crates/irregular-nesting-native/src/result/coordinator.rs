//! `computeIrregularNesting`/`coordinateIntrinsicSharedArchive`: piece
//! preparation, the intrinsic shared-archive invocation (direct + real
//! periodic-family runner), the scheduler cold-start (including the
//! production-always-on interleaved canonical-grid checkpoint quantum),
//! the real `capacity::mode` capacity-fallback invocation, focused
//! reconstruction, and the Compact Short Side profile block.
//!
//! TS source: `computeIrregularNesting.ts:364-1240`. See `result::mod`'s top
//! doc for this module's exact scope (archive-eligible path only).
//!
//! # Resolved seam: `capacity::mode`'s top-level orchestration
//!
//! `capacity::mode` now carries the full, real `run_intrinsic_capacity_mode`/
//! `run_intrinsic_capacity_scheduler_cold_quantum` orchestration (previously
//! a `capacity_mode_runner: &mut dyn IntrinsicCapacityModeRunner` seam
//! defaulting to `UnimplementedCapacityModeRunner`, per `result::mod`'s
//! former "Known gap" section). Per that section's own prescribed
//! reconciliation path, this module now calls `capacity::mode`'s real
//! functions directly (no injected trait object) -- both call sites where
//! the seam previously lived are reachable at points in this coordinator's
//! control flow where `geometry_cache` is not concurrently borrowed by
//! anything else, so no indirection is needed.
//!
//! # A note on this file's own mutable-resource plumbing
//!
//! Every genuinely mutable resource this coordinator threads
//! (`event_sink`, `geometry_cache`, `free_material_cache`, the
//! cooperative-cancellation `control`) is passed as an independent
//! top-level parameter, never as a field nested inside
//! another struct that is itself passed by `&mut` reference. This follows
//! the exact precedent `archive::shared`'s own `SharedArchiveControl` doc
//! comment documents (and `capacity::search`'s `CapacitySearchControl`,
//! `archive::periodic_family`'s `PortfolioControl` repeat): reborrowing an
//! `&mut`/`Option<&mut dyn Trait>` field repeatedly across sequential call
//! sites, when that field lives behind a *second* `&mut` reference (a struct
//! reached through another reference), hits a known rustc limitation
//! (E0499/E0502 "cannot borrow more than once") even though each reborrow's
//! actual live range is trivially disjoint. Keeping each mutable resource a
//! plain top-level local/parameter sidesteps it entirely.
//! [`CoordinateIntrinsicSharedArchiveInput`] therefore carries **only**
//! shared (`&`) fields.

use std::sync::Arc;
use std::time::Instant;

use rayon::prelude::*;

use crate::archive::shared::{
    make_intrinsic_shared_archive_endpoint, retain_ranked_shared_archive,
    run_intrinsic_shared_archive_portfolio, select_fitting_shared_archive,
    select_intrinsic_shared_archive_winner, IntrinsicPeriodicFamilyPortfolioForcedOptions,
    IntrinsicPeriodicFamilyPortfolioRunner, IntrinsicSharedArchiveEndpoint,
    IntrinsicSharedArchivePortfolioOptions, MakeIntrinsicSharedArchiveEndpointInput,
    SharedArchiveError, SharedArchivePhase,
};
use crate::archive::{periodic_family, reconstruction};
use crate::boundary::parallel::with_job_pool;
use crate::caches::GeometryCacheStore;
use crate::capacity::mode::{
    run_intrinsic_capacity_mode, run_intrinsic_capacity_scheduler_cold_quantum,
    IntrinsicCapacityRouting, IntrinsicCapacityTrace, LaneCoordinatorQuantumOutcome,
    LaneCoordinatorQuantumPhase, LaneCoordinatorQuantumProducerRole, RunIntrinsicCapacityModeInput,
    RunIntrinsicCapacitySchedulerColdQuantumInput,
};
use crate::capacity::prefixes::IntrinsicCapacityPrefixSource;
use crate::capacity::preflight::{
    preflight_intrinsic_complete_capacity, IntrinsicCapacityError, IntrinsicCapacityPreflightError,
    IntrinsicCapacityPreflightOutcome, IntrinsicCapacityProvenImpossibleReason,
};
use crate::capacity::search::{CapacitySearchError, IntrinsicCapacitySearchStatus};
use crate::domain::{
    CollisionGeometry, CollisionGeometryDiagnostic, ImportedPiece, IrregularNestingSettings,
    IrregularPreparedPiece, IrregularPriorityOrderKey, IrregularTransformCandidate, PieceId,
    SheetSpec,
};
use crate::geometry::collision_builder::{build_piece, BuildCollisionGeometryInput};
use crate::nfp_ifp::{
    NfpIfpAbortReason, NfpIfpCheckpointPhase, NfpIfpControl, NfpIfpControlAbortError,
};
use crate::search::layout_scorer::FreeMaterialCache;
use crate::search::sort_pieces::{sort_pieces_for_nesting, PreparedPiece as SortedPreparedPiece};
use crate::search::strict_decoder::IntrinsicStrictDecoderFailure;
use crate::transforms::generator::{generate_transforms, GenerateTransformsInput};

use super::materialize::{
    materialize_intrinsic_short_side_profile_result, materialize_shared_archive_result,
    MaterializeIntrinsicShortSideProfileResultInput, MaterializeSharedArchiveResultInput,
    MaterializedDecode, ShortSideProfileSelection,
};
use super::progress::{emit_shared_archive_progress, IrregularComputeEventSink};
use super::{
    geometry_input_error_from_generator, is_intrinsic_shared_archive_eligible, HistoryMode,
    IntrinsicAnytimeSchedulerCancellationReason, IntrinsicAnytimeSchedulerCohort,
    IntrinsicAnytimeSchedulerColdStartStatus, IntrinsicAnytimeSchedulerOutcome,
    IntrinsicAnytimeSchedulerProducerRole, IntrinsicAnytimeSchedulerQuantum,
    IntrinsicAnytimeSchedulerTrace, IntrinsicFocusedCompleteReconstructionOutputInfluence,
    IntrinsicFocusedCompleteReconstructionStatus, IntrinsicFocusedCompleteReconstructionTrace,
    IrregularComputeError, IrregularComputeErrorType, IrregularComputeResult,
    IrregularNoValidResultError, IrregularPortfolioError, IrregularPortfolioErrorCategory,
    IrregularPortfolioPhase, NestingRequest, INTRINSIC_ANYTIME_SCHEDULER_TRACE_VERSION,
    INTRINSIC_FOCUSED_COMPLETE_RECONSTRUCTION_TRACE_VERSION,
};

// ===========================================================================
// `ComputeIrregularNestingOptions` (`computeIrregularNesting.ts:117-182`).
// See `result::mod`'s top doc, "Deliberately not ported", for which fields
// are intentionally absent.
// ===========================================================================

/// TS: `ComputeIrregularNestingOptions`, limited to the fields
/// `nesting.worker.ts` (the sole production caller) ever sets, plus
/// `focusedCompleteReconstructionControlArm` (read unconditionally on the
/// archive path even though production never disables it).
pub struct ComputeIrregularNestingOptions<'a> {
    pub event_sink: Option<&'a mut dyn IrregularComputeEventSink>,
    /// Native cancellation reason observed at the existing cooperative
    /// checkpoints. `None` keeps the checkpoint live; `Some` preserves whether
    /// worker control requested cancellation or deadline expiry.
    pub cancellation_reason: Option<&'a mut dyn FnMut() -> Option<NfpIfpAbortReason>>,
    /// TS: `options?.focusedCompleteReconstructionControlArm !== 'disable'`.
    /// `true` unless explicitly disabled.
    pub focused_complete_reconstruction_enabled: bool,
}

impl Default for ComputeIrregularNestingOptions<'_> {
    fn default() -> Self {
        Self {
            event_sink: None,
            cancellation_reason: None,
            focused_complete_reconstruction_enabled: true,
        }
    }
}

// ===========================================================================
// Real periodic-family-portfolio runner (resolves `archive::shared`'s
// documented seam: `archive::periodic_family` is fully ported now).
// ===========================================================================

/// TS: the coordinator's own `runIntrinsicPeriodicFamilyPortfolio` call
/// (`computeIrregularNesting.ts:641-725`'s periodic phase, wired through
/// `archive::shared::run_intrinsic_shared_archive_portfolio`'s
/// `periodic_runner` parameter). Real, non-stub implementation of
/// `archive::shared::IntrinsicPeriodicFamilyPortfolioRunner`.
///
/// Carries no `geometry_cache` field: per
/// `IntrinsicPeriodicFamilyPortfolioRunner::run`'s own doc comment, the one
/// job-wide `GeometryCacheStore` is threaded in as a call parameter
/// instead, exactly matching TS's single job-ambient `GeometryCacheService`
/// instance (`cache-concurrency-design.md` §2) -- see this module's top doc
/// for why every genuinely mutable resource this coordinator threads is a
/// plain top-level parameter, never a struct field.
pub struct RealIntrinsicPeriodicFamilyPortfolioRunner<'a> {
    pub settings: &'a IrregularNestingSettings,
}

impl IntrinsicPeriodicFamilyPortfolioRunner for RealIntrinsicPeriodicFamilyPortfolioRunner<'_> {
    fn run(
        &mut self,
        sheet: &SheetSpec,
        pieces: &[Arc<IrregularPreparedPiece>],
        forced: IntrinsicPeriodicFamilyPortfolioForcedOptions<'_>,
        geometry_cache: &mut GeometryCacheStore,
    ) -> Result<crate::archive::shared::IntrinsicPeriodicFamilyPortfolioResult, SharedArchiveError>
    {
        // TS: `runIntrinsicSharedArchivePortfolio`'s periodic call
        // (`:196-203,717-724`) -- the coordinator's own `periodic` options
        // literal plus the four forced fields
        // `IntrinsicPeriodicFamilyPortfolioForcedOptions` carries.
        let owned_pieces: Vec<IrregularPreparedPiece> =
            pieces.iter().map(|piece| (**piece).clone()).collect();
        let options = periodic_family::IntrinsicPeriodicFamilyPortfolioOptions {
            maximum_catalog_runtime_ms: 30_000.0,
            maximum_cells_per_family_role: 16,
            maximum_crops_per_cell: 4,
            maximum_continuation_runtime_ms: 30_000.0,
            maximum_continuation_candidate_evaluations: Some(
                forced.maximum_continuation_candidate_evaluations,
            ),
            maximum_continuation_count: forced.maximum_continuation_count as usize,
            maximum_total_runtime_ms: 240_000.0,
            capture_phase_timings: false,
            basis_source_key: None,
            capture_source_survival_audit: forced.capture_source_survival_audit,
            capture_source_audit_replay_envelope: false,
            admit_source_audit_witnesses: forced.admit_source_audit_witnesses,
            source_audit_replay_envelope: None,
            expected_source_audit_replay_digest: None,
            source_audit_scope: periodic_family::IntrinsicPeriodicSourceAuditScope::P2AxisUnion,
            control: forced.control,
            timing_now: None,
        };
        let result = periodic_family::run_intrinsic_periodic_family_portfolio(
            sheet,
            &owned_pieces,
            options,
            self.settings,
            geometry_cache,
        )
        .map_err(periodic_portfolio_error_to_shared_archive_error)?;

        Ok(project_periodic_family_result(result))
    }
}

fn periodic_portfolio_error_to_shared_archive_error(
    error: periodic_family::IntrinsicPeriodicPortfolioError,
) -> SharedArchiveError {
    use periodic_family::IntrinsicPeriodicPortfolioError as Src;
    match error {
        Src::Decoder(inner) => IntrinsicStrictDecoderFailure::Decoder(inner),
        Src::Geometry(inner) => IntrinsicStrictDecoderFailure::Geometry(inner),
        Src::Abort(inner) => IntrinsicStrictDecoderFailure::Abort(inner),
    }
}

/// Projects the real, full `archive::periodic_family::IntrinsicPeriodicFamilyPortfolioResult`
/// onto `archive::shared`'s minimal seam type -- see `archive::shared`'s own
/// top doc for exactly which fields that seam type carries and why.
fn project_periodic_family_result(
    result: periodic_family::IntrinsicPeriodicFamilyPortfolioResult,
) -> crate::archive::shared::IntrinsicPeriodicFamilyPortfolioResult {
    use crate::archive::shared as seam;

    let families = result
        .catalog
        .families
        .iter()
        .map(|family| seam::IntrinsicPeriodicFamilyCatalogCoverage {
            cell_coverage_complete: family.cell_coverage_complete,
            source_audit_cells_present: family.source_audit_cells.is_some(),
        })
        .collect();

    let runs: Vec<seam::IntrinsicPeriodicContinuationResult> = result
        .runs
        .iter()
        .map(|run| seam::IntrinsicPeriodicContinuationResult {
            continuation: seam::IntrinsicPeriodicContinuationRef {
                role: periodic_role_str(run.continuation.role).to_string(),
                source_id: run.continuation.source_id.clone(),
            },
            status: project_continuation_status(run.status),
            constructed: run.constructed.clone(),
            reason: run.reason.clone(),
            runtime_ms: run.runtime_ms,
        })
        .collect();

    seam::IntrinsicPeriodicFamilyPortfolioResult {
        catalog: seam::IntrinsicPeriodicCatalogCoverage {
            runtime_coverage_complete: result.catalog.runtime_coverage_complete,
            family_coverage_complete: result.catalog.family_coverage_complete,
            families,
        },
        continuation_count: result.continuations.len() as f64,
        continuation_coverage_complete: result.continuation_coverage_complete,
        continuation_budget_settlement_complete: Some(
            result.continuation_budget_settlement_complete,
        ),
        runs,
    }
}

fn periodic_role_str(role: crate::archive::periodic_cells::IntrinsicPeriodicRole) -> &'static str {
    use crate::archive::periodic_cells::IntrinsicPeriodicRole as Role;
    match role {
        Role::P1 => "P1",
        Role::P2 => "P2",
    }
}

fn project_continuation_status(
    status: periodic_family::IntrinsicPeriodicContinuationStatus,
) -> crate::archive::shared::IntrinsicPeriodicContinuationStatus {
    use crate::archive::shared::IntrinsicPeriodicContinuationStatus as Seam;
    use periodic_family::IntrinsicPeriodicContinuationStatus as Src;
    match status {
        Src::Completed => Seam::Completed,
        Src::Incomplete => Seam::Incomplete,
        Src::InfeasibleFinalSheet => Seam::InfeasibleFinalSheet,
        Src::Invalid => Seam::Invalid,
        Src::Deadline => Seam::Deadline,
        Src::GlobalDeadline => Seam::GlobalDeadline,
        Src::EvaluationCap => Seam::EvaluationCap,
    }
}

// ===========================================================================
// `computeIrregularNesting` (`computeIrregularNesting.ts:364-451`).
// ===========================================================================

/// The pure per-piece result [`compute_prepared_piece`] produces --
/// everything [`compute_irregular_nesting`]'s serial reduction needs to
/// publish one `IrregularPreparedPiece` (`source`/`allow_mirror` are
/// threaded through separately from `collision_geometry`/`transforms`
/// because the original serial loop computes/uses them at different
/// points, not because they have independent lifetimes here).
struct PreparedPieceComputation {
    source: ImportedPiece,
    allow_mirror: bool,
    collision_geometry: CollisionGeometry,
    transforms: Vec<IrregularTransformCandidate>,
}

/// TS: `computeIrregularNesting.ts:389-431`, the per-piece body of the
/// piece-preparation loop: `findSourcePiece`, then
/// `CollisionGeometryBuilder.buildPiece`, then
/// `TransformGenerator.generateTransforms`. Pure given `(prepared, request,
/// settings)`: reads no mutable shared state and writes none (this crate's
/// Clipper2 port carries no process-global mutable state -- see
/// `clipper::engine::Clipper64::open_paths_enabled`'s doc for why per-call
/// instances stay independent even under concurrent invocation). This is
/// `PAR-GEOM-01` in `docs/planning/rust-irregular-backend/parallelism-inventory.md`
/// §3.1; [`compute_irregular_nesting`] is the ordinal-indexed parallel
/// dispatch + serial reduction site.
fn compute_prepared_piece(
    prepared: &SortedPreparedPiece,
    request: &NestingRequest,
    settings: &IrregularNestingSettings,
) -> Result<PreparedPieceComputation, IrregularComputeErrorType> {
    let source = find_source_piece(
        &prepared.source_piece_id,
        &prepared.id,
        &request.source_pieces,
    )
    .ok_or_else(|| {
        IrregularComputeErrorType::Compute(IrregularComputeError {
            prepared_piece_id: prepared.id.clone(),
            source_piece_id: prepared.source_piece_id.clone(),
            message: format!(
                "No imported source geometry was found for prepared piece {}.",
                prepared.id.as_str()
            ),
        })
    })?
    .clone();

    let collision_geometry = build_piece(
        &BuildCollisionGeometryInput {
            piece: source.clone(),
            total_padding_mm: request.padding,
        },
        &settings.geometry,
    )
    .map_err(|error| {
        IrregularComputeErrorType::GeometryInput(geometry_input_error_from_generator(&error))
    })?;

    let allow_rotation = request.options.allow_global_rotation && prepared.allow_rotation;
    let allow_mirror = request.options.allow_global_mirror.unwrap_or(true) && prepared.allow_mirror;
    let transforms = generate_transforms(&GenerateTransformsInput {
        geometry: collision_geometry.clone(),
        allow_rotation,
        allow_mirror,
        geometry_settings: settings.geometry.clone(),
        settings: settings.optimizer.clone(),
    })
    .map_err(|error| {
        IrregularComputeErrorType::GeometryInput(geometry_input_error_from_generator(&error))
    })?;

    Ok(PreparedPieceComputation {
        source,
        allow_mirror,
        collision_geometry,
        transforms,
    })
}

/// TS: `computeIrregularNesting.ts:364-451`. Prepares every piece's
/// collision geometry and transform set in stable sorted order, then
/// delegates to [`coordinate_intrinsic_shared_archive`].
pub fn compute_irregular_nesting(
    request: &NestingRequest,
    settings: &IrregularNestingSettings,
    options: &mut ComputeIrregularNestingOptions<'_>,
    geometry_cache: &mut GeometryCacheStore,
    free_material_cache: &mut FreeMaterialCache,
) -> Result<IrregularComputeResult, IrregularComputeErrorType> {
    let sorted_pieces = sort_pieces_for_nesting(&request.pieces);

    // PAR-GEOM-01 (parallelism-inventory.md §3.1): dispatch every prepared
    // piece's pure collision-geometry/transform computation across this
    // job's Rayon pool, ordinal-indexed by `sorted_pieces`'s own position
    // (`par_iter().map(...).collect()` preserves input order in its output
    // `Vec` regardless of completion order -- this *is* the ordinal
    // scheme, not merely convenient). No cache/mutable-shared-state
    // interaction happens inside `compute_prepared_piece`, so no
    // publish-ordering hazard exists here (contrast with PAR-NFP-01/
    // PAR-CACHE-01, which do touch `geometry_cache` and are not
    // parallelized by this call).
    let per_piece_results: Vec<Result<PreparedPieceComputation, IrregularComputeErrorType>> =
        with_job_pool(|| {
            sorted_pieces
                .par_iter()
                .map(|prepared| compute_prepared_piece(prepared, request, settings))
                .collect()
        });

    let mut prepared_pieces: Vec<Arc<IrregularPreparedPiece>> =
        Vec::with_capacity(sorted_pieces.len());
    let mut diagnostics: Vec<CollisionGeometryDiagnostic> = Vec::new();

    // Serial reduction, strictly in original `sorted_pieces` order: the
    // first ordinal whose computation failed is the error `?` returns here
    // -- the exact same "first sequentially-encountered failure in program
    // order" identity the original serial loop produced (PAR-XCUT-02),
    // never "whichever Rayon worker finished first." Every prepared piece
    // published into `prepared_pieces`/`diagnostics` before that ordinal is
    // identical byte-for-byte to the original serial loop's output; any
    // piece *after* the failing ordinal may still have been computed by
    // some other worker, but its result is simply never published, exactly
    // like every other compute-then-publish site in this crate.
    for (prepared, computation) in sorted_pieces.iter().zip(per_piece_results) {
        let PreparedPieceComputation {
            source,
            allow_mirror,
            collision_geometry,
            transforms,
        } = computation?;

        diagnostics.extend(collision_geometry.diagnostics.clone());

        prepared_pieces.push(Arc::new(IrregularPreparedPiece {
            piece_id: Some(prepared.id.clone()),
            interchangeability_key: Some(
                prepared
                    .interchangeability_key
                    .clone()
                    .unwrap_or_else(|| prepared.id.as_str().to_string()),
            ),
            source,
            allow_mirror,
            collision_geometry,
            transforms,
            priority_order_key: Some(IrregularPriorityOrderKey {
                long_side_mm: prepared.padded_bounds.longest_edge,
                area_mm2: prepared.padded_bounds.area,
                imbalance_mm: prepared.padded_bounds.imbalance,
            }),
        }));
    }

    let sorted_piece_ids: Vec<PieceId> =
        sorted_pieces.iter().map(|piece| piece.id.clone()).collect();

    let input = CoordinateIntrinsicSharedArchiveInput {
        request,
        settings,
        prepared_pieces: &prepared_pieces,
        diagnostics: &diagnostics,
        sorted_piece_ids: &sorted_piece_ids,
    };

    // See this module's top doc: every mutable resource is hoisted into a
    // plain top-level local here (never left nested inside `options`) before
    // being threaded through the coordinator. `event_sink` is a plain
    // `&mut dyn Trait` (never `Option`-wrapped downstream, see this
    // module's top doc); `NullEventSink` stands in for TS's `options ===
    // undefined`/`options?.emitPortfolioProgress === undefined`.
    let mut null_sink = super::progress::NullEventSink;
    let event_sink: &mut dyn IrregularComputeEventSink = match options.event_sink.take() {
        Some(sink) => sink,
        None => &mut null_sink,
    };
    let cancellation_reason = options.cancellation_reason.take();
    let focused_complete_reconstruction_enabled = options.focused_complete_reconstruction_enabled;

    coordinate_intrinsic_shared_archive(
        &input,
        event_sink,
        cancellation_reason,
        focused_complete_reconstruction_enabled,
        geometry_cache,
        free_material_cache,
    )
}

/// TS: `computeIrregularNesting.ts:1906-1920` `findSourcePiece`.
fn find_source_piece<'a>(
    source_piece_id: &PieceId,
    prepared_piece_id: &PieceId,
    source_pieces: &'a [ImportedPiece],
) -> Option<&'a ImportedPiece> {
    if let Some(direct) = source_pieces
        .iter()
        .find(|source| &source.id == source_piece_id || &source.id == prepared_piece_id)
    {
        return Some(direct);
    }

    let base_id = strip_copy_suffix(source_piece_id.as_str());
    let prepared_base_id = strip_copy_suffix(prepared_piece_id.as_str());
    source_pieces
        .iter()
        .find(|source| source.id.as_str() == base_id || source.id.as_str() == prepared_base_id)
}

/// TS: `/-copy-\d+$/` stripped via `.replace(...)`.
fn strip_copy_suffix(id: &str) -> &str {
    if let Some(dash_copy) = id.rfind("-copy-") {
        let suffix = &id[dash_copy + "-copy-".len()..];
        if !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()) {
            return &id[..dash_copy];
        }
    }
    id
}

// ===========================================================================
// `coordinateIntrinsicSharedArchive` (`computeIrregularNesting.ts:474-1240`).
// ===========================================================================

/// Purely shared (`&`) coordinator inputs -- see this module's top doc for
/// why no mutable resource is ever a field here.
struct CoordinateIntrinsicSharedArchiveInput<'a> {
    request: &'a NestingRequest,
    settings: &'a IrregularNestingSettings,
    prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    diagnostics: &'a [CollisionGeometryDiagnostic],
    sorted_piece_ids: &'a [PieceId],
}

#[allow(clippy::too_many_arguments)]
fn coordinate_intrinsic_shared_archive(
    input: &CoordinateIntrinsicSharedArchiveInput<'_>,
    event_sink: &mut dyn IrregularComputeEventSink,
    cancellation_reason: Option<&mut dyn FnMut() -> Option<NfpIfpAbortReason>>,
    focused_complete_reconstruction_enabled: bool,
    geometry_cache: &mut GeometryCacheStore,
    free_material_cache: &mut FreeMaterialCache,
) -> Result<IrregularComputeResult, IrregularComputeErrorType> {
    // TS: `archiveEnabled = isIntrinsicSharedArchiveEligible(input.settings)`
    // (`:483`). Per `result::mod`'s top doc (R1/R2), a non-eligible request
    // is a routing error at this native entry point, not a fallback into
    // the legacy TS-only branch.
    if !is_intrinsic_shared_archive_eligible(input.settings) {
        return Err(IrregularComputeErrorType::Portfolio(IrregularPortfolioError {
            operation: "computeIrregularNesting".to_string(),
            category: IrregularPortfolioErrorCategory::Search,
            message: "this native entry point only implements the archive-eligible Compact/Compact Short Side path; the request's settings are not archive-eligible (legacy windowed-beam/GA routing stays TypeScript-only).".to_string(),
        }));
    }

    let short_side_profile_requested = input.settings.optimizer.intrinsic_objective_profile_id
        == crate::domain::IntrinsicObjectiveProfileId::ShortSide;
    let mut archive_diagnostics: Vec<CollisionGeometryDiagnostic> = Vec::new();
    // TS: `selected.capacityTrace` (`:1221` `...(selected.capacityTrace ===
    // undefined ? {} : {capacityTrace: selected.capacityTrace})`) --
    // populated from `capacity.trace` at both `materializeIntrinsicCapacityResult`
    // call sites below (`:1311`), never left `None` once a capacity endpoint
    // settles the result. Declared `mut` (not a TS-mirroring `let` typo) so
    // both call sites can actually set it.
    let mut capacity_trace: Option<IntrinsicCapacityTrace> = None;
    let mut intrinsic_anytime_scheduler_trace: Option<IntrinsicAnytimeSchedulerTrace> = None;
    let mut focused_complete_reconstruction_trace: Option<
        IntrinsicFocusedCompleteReconstructionTrace,
    > = None;

    emit_shared_archive_progress(
        &mut *event_sink,
        IrregularPortfolioPhase::SharedArchive,
        None,
        0.0,
    );

    /* A concrete (`Sized`), non-trait-object control wraps the optional native
     * cancellation-reason callback. Every call site below builds a fresh,
     * short-lived `&mut dyn NfpIfpControl` via `control_dyn` instead of storing
     * one long-lived trait-object reborrow (see this module's top doc).
     */
    let mut control = cancellation_reason.map(cancellation_control);

    let preflight_started_at = Instant::now();
    let preflight = preflight_intrinsic_complete_capacity(
        &input.request.sheet,
        &owned_prepared_pieces(input.prepared_pieces),
        &input.settings.geometry,
        geometry_cache,
        control_dyn(&mut control),
    )
    .map_err(map_preflight_error)?;
    let preflight_runtime_ms =
        crate::js_number::js_math::max(0.0, preflight_started_at.elapsed().as_secs_f64() * 1000.0);

    let selected: MaterializedDecode;
    // TS: `settledCompleteArchiveForShortSideObserver` (`:496-505`) -- starts
    // as the empty array assigned unconditionally right after the
    // `archiveEnabled` check, and is only ever reassigned to the real
    // sheetless archive inside the "inconclusive preflight" branch below
    // (`:938`). The proven-impossible branch deliberately leaves it empty:
    // per `capacity-core.md` §1, the Short Side observer still runs (this
    // coordinator falls through to the shared Short Side profile block
    // below, exactly like TS's own `if`/`else` -- neither arm returns
    // early), but with zero archive endpoints to observe.
    let mut settled_complete_archive_for_short_side_observer: Vec<IntrinsicSharedArchiveEndpoint> =
        Vec::new();

    if let IntrinsicCapacityPreflightOutcome::ProvenImpossible { .. } = &preflight {
        if focused_complete_reconstruction_enabled {
            focused_complete_reconstruction_trace = Some(IntrinsicFocusedCompleteReconstructionTrace {
                version: INTRINSIC_FOCUSED_COMPLETE_RECONSTRUCTION_TRACE_VERSION,
                status: IntrinsicFocusedCompleteReconstructionStatus::SkippedPreflightProvenImpossible,
                source_canonical_geometry_hash: None,
                candidate_canonical_geometry_hash: None,
                selected_canonical_geometry_hash: None,
                consumed_candidate_evaluations: 0.0,
                candidate_evaluation_accounting_complete: true,
                runtime_ms: 0.0,
                output_influence: IntrinsicFocusedCompleteReconstructionOutputInfluence::None,
                failure_reason: None,
            });
        }
        let capacity = run_intrinsic_capacity_mode(
            RunIntrinsicCapacityModeInput {
                sheet: &input.request.sheet,
                prepared_pieces: input.prepared_pieces,
                routing: IntrinsicCapacityRouting::PreflightProvenImpossible,
                preflight: &preflight,
                prefix_sources: &[],
                capture_cohesion_shadow: false,
                scheduled_cold_start: None,
                admit_warm_prefix_endpoints: false,
                coordinate_protected_lanes: false,
                preflight_runtime_ms: Some(preflight_runtime_ms),
                complete_archive_runtime_ms: None,
                retention_mode: Some(
                    crate::capacity::search::IntrinsicCapacityRetentionMode::CohesionFrontier,
                ),
            },
            control_dyn(&mut control),
            input.settings,
            geometry_cache,
            None,
        )
        .map_err(map_capacity_search_error)?;
        selected = materialize_capacity_result(input, &capacity, free_material_cache)?;
        archive_diagnostics.extend(intrinsic_capacity_diagnostics(&preflight, &capacity));
        capacity_trace = Some(capacity.trace.clone());
        emit_shared_archive_progress(
            &mut *event_sink,
            IrregularPortfolioPhase::Completed,
            Some(selected.portfolio.score.clone()),
            0.0,
        );
        // TS: falls through to the shared post-`if`/`else` code (the Short
        // Side profile block, then `assemble_result`) -- no early return
        // here. See this function's `settled_complete_archive_for_short_side_observer`
        // doc comment above.
    } else {
        // TS: `schedulerEnabled = true` (`:604`) -- the scheduler cold-start
        // always runs on this branch in production. Errors propagate as a hard
        // coordinator failure (TS: `yield* ...runIntrinsicCapacitySchedulerColdQuantum(...)`),
        // never silently swallowed into `None`.
        let mut scheduled_cold_start = Some(
            run_intrinsic_capacity_scheduler_cold_quantum(
                RunIntrinsicCapacitySchedulerColdQuantumInput {
                    sheet: &input.request.sheet,
                    prepared_pieces: input.prepared_pieces,
                    checkpoint: None,
                    maximum_depth_boundaries: None,
                    retention_mode: Some(
                        crate::capacity::search::IntrinsicCapacityRetentionMode::CohesionFrontier,
                    ),
                },
                control_dyn(&mut control),
                input.settings,
                geometry_cache,
                None,
            )
            .map_err(map_capacity_search_error)?,
        );
        let mut scheduled_cold_checkpoint_reused = false;

        if let Some(cold_start) = &scheduled_cold_start {
            intrinsic_anytime_scheduler_trace = Some(IntrinsicAnytimeSchedulerTrace {
                version: INTRINSIC_ANYTIME_SCHEDULER_TRACE_VERSION,
                cold_quantum_depths:
                    crate::capacity::mode::INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS,
                cold_start_status: cold_search_status(cold_start),
                cold_start_completed_depths: cold_start.trace.completed_depths,
                cold_start_consumed_placement_evaluations: cold_start
                    .trace
                    .consumed_placement_evaluations,
                cold_checkpoint_reused: false,
                warm_prefix_endpoints_admitted: false,
                cancellation_reason: None,
                quanta: vec![IntrinsicAnytimeSchedulerQuantum {
                    ordinal: 0,
                    cohort: IntrinsicAnytimeSchedulerCohort::Partial,
                    producer_role: IntrinsicAnytimeSchedulerProducerRole::CapacityCold,
                    outcome: match cold_search_status(cold_start) {
                        IntrinsicAnytimeSchedulerColdStartStatus::Paused => {
                            IntrinsicAnytimeSchedulerOutcome::Checkpointed
                        }
                        IntrinsicAnytimeSchedulerColdStartStatus::Settled => {
                            IntrinsicAnytimeSchedulerOutcome::Settled
                        }
                    },
                }],
            });
        }

        // `run_intrinsic_shared_archive_portfolio` reborrows the coordinator's
        // single job-wide `geometry_cache` for both the direct phase and (via
        // `periodic_runner.run`'s own `geometry_cache` parameter -- see
        // `IntrinsicPeriodicFamilyPortfolioRunner`'s doc comment) the periodic
        // phase, and the interleaved scheduler-resume closure below reborrows
        // that exact same store too. All three phases share one
        // `GeometryCacheStore`, matching TS's single job-ambient
        // `GeometryCacheService` instance exactly (`cache-concurrency-design.md`
        // §2) -- never a phase-private `GeometryCacheStore::new()`, which
        // would silently diverge from TS's cache hit/miss sequence for
        // numerically-tied candidates (`differential-e2e-report.md` Finding N1).
        let mut periodic_runner = RealIntrinsicPeriodicFamilyPortfolioRunner {
            settings: input.settings,
        };
        // TS: `onPhaseCompleted: () => emitSharedArchiveProgress(input, 'shared_archive',
        // undefined, ...)` (`computeIrregularNesting.ts:710-716`) -- fires once
        // after the direct phase and once after the periodic phase, both still
        // reporting phase `'shared_archive'` (the phase name does not change;
        // only the elapsed-time payload would, and that field is diagnostic-only
        // per `worker-coordination.md` §7). Captured here (not stored earlier)
        // so `event_sink`'s reborrow only needs to live for this one call.
        let mut on_phase_completed =
            |_phase: SharedArchivePhase| -> Result<(), SharedArchiveError> {
                emit_shared_archive_progress(
                    &mut *event_sink,
                    IrregularPortfolioPhase::SharedArchive,
                    None,
                    0.0,
                );
                Ok(())
            };
        // TS: `onDirectConstructed: (role, state) => { prefixSources.push({ role, state }) }`
        // (`:707-709`) -- captures every committed, uncapped, complete direct
        // constructor state for later `capacity::mode` prefix reuse.
        let mut prefix_sources: Vec<IntrinsicCapacityPrefixSource> = Vec::new();
        let mut on_direct_constructed =
            |role: crate::archive::shared::IntrinsicSharedArchiveDirectRole,
             state: &Arc<crate::search::beam_state::IrregularBeamState>| {
                prefix_sources.push(IntrinsicCapacityPrefixSource {
                    role: role.as_str().to_string(),
                    state: Arc::clone(state),
                });
            };
        // TS: `canonicalGridCompletedPieceQuantum: 1` + `onCanonicalGridCheckpointed`
        // (`:647-705`) -- production's always-on interleaved scheduler: every
        // time the canonical-grid direct constructor pauses after one more
        // completed piece boundary, the coordinator (a) records one
        // `legacy-complete`/`checkpointed` quantum, then (b) if the protected
        // cold lane is still paused with a checkpoint, resumes it by exactly one
        // depth boundary (never a cold restart) and records the resulting
        // `capacity-cold`/`partial` quantum. This is the scheduler's own
        // chronology, independent of and prior to `capacity::mode`'s lane
        // coordinator. TS threads the same `control`/`isCancelled` observation
        // (and the same single job-ambient `GeometryCacheService` instance --
        // `cache-concurrency-design.md` §2) into this nested resume
        // (`computeIrregularNesting.ts:679`, `...(control === undefined ? {}
        // : { control })`); this closure now does too, via the reborrows
        // `archive::shared`'s `OnCanonicalGridCheckpointed` callback type
        // hands it as its second and third parameters (see that type's own
        // doc comment for why they must arrive as callback parameters rather
        // than direct closure captures of this function's own `control`/
        // `geometry_cache` locals -- both are simultaneously reborrowed for
        // the entire duration of the `run_intrinsic_shared_archive_portfolio`
        // call below).
        let mut on_canonical_grid_checkpointed =
            |_checkpoint: &crate::search::strict_decoder::IntrinsicStrictDirectCheckpoint,
             checkpoint_control: Option<&mut dyn NfpIfpControl>,
             checkpoint_geometry_cache: &mut GeometryCacheStore|
             -> Result<(), SharedArchiveError> {
                if let Some(trace) = intrinsic_anytime_scheduler_trace.as_mut() {
                    trace.quanta.push(IntrinsicAnytimeSchedulerQuantum {
                        ordinal: trace.quanta.len(),
                        cohort: IntrinsicAnytimeSchedulerCohort::Complete,
                        producer_role: IntrinsicAnytimeSchedulerProducerRole::LegacyComplete,
                        outcome: IntrinsicAnytimeSchedulerOutcome::Checkpointed,
                    });
                }
                let resumable = matches!(
                    &scheduled_cold_start,
                    Some(search) if search.status == IntrinsicCapacitySearchStatus::Paused
                        && search.checkpoint.is_some()
                );
                if !resumable {
                    return Ok(());
                }
                let checkpoint = scheduled_cold_start
                    .as_ref()
                    .and_then(|search| search.checkpoint.clone())
                    .expect("checked Some+checkpoint above");
                let resumed = run_intrinsic_capacity_scheduler_cold_quantum(
            RunIntrinsicCapacitySchedulerColdQuantumInput {
                sheet: &input.request.sheet,
                prepared_pieces: input.prepared_pieces,
                checkpoint: Some(checkpoint),
                maximum_depth_boundaries: Some(1.0),
                retention_mode: Some(
                    crate::capacity::search::IntrinsicCapacityRetentionMode::CohesionFrontier,
                ),
            },
            checkpoint_control,
            input.settings,
            checkpoint_geometry_cache,
            None,
        )
        .map_err(capacity_search_error_to_shared_archive_error)?;
                scheduled_cold_checkpoint_reused = true;
                if let Some(trace) = intrinsic_anytime_scheduler_trace.as_mut() {
                    trace.quanta.push(IntrinsicAnytimeSchedulerQuantum {
                        ordinal: trace.quanta.len(),
                        cohort: IntrinsicAnytimeSchedulerCohort::Partial,
                        producer_role: IntrinsicAnytimeSchedulerProducerRole::CapacityCold,
                        outcome: match resumed.status {
                            IntrinsicCapacitySearchStatus::Paused => {
                                IntrinsicAnytimeSchedulerOutcome::Checkpointed
                            }
                            IntrinsicCapacitySearchStatus::Settled => {
                                IntrinsicAnytimeSchedulerOutcome::Settled
                            }
                        },
                    });
                }
                scheduled_cold_start = Some(resumed);
                Ok(())
            };
        let mut portfolio_options = IntrinsicSharedArchivePortfolioOptions {
            maximum_direct_runtime_ms: Some(35_000.0),
            include_source_audit_witnesses: Some(true),
            canonical_grid_completed_piece_quantum: Some(1.0),
            on_canonical_grid_checkpointed: Some(&mut on_canonical_grid_checkpointed),
            on_phase_completed: Some(&mut on_phase_completed),
            on_direct_constructed: Some(&mut on_direct_constructed),
            ..Default::default()
        };
        let archive_started_at = Instant::now();
        let archive = run_intrinsic_shared_archive_portfolio(
            &input.request.sheet,
            input.prepared_pieces,
            &mut portfolio_options,
            control_dyn(&mut control),
            &mut periodic_runner,
            input.settings,
            geometry_cache,
        )
        .map_err(map_shared_archive_error)?;
        let complete_archive_runtime_ms = crate::js_number::js_math::max(
            0.0,
            archive_started_at.elapsed().as_secs_f64() * 1000.0,
        );

        if !crate::archive::shared::intrinsic_shared_archive_production_valid(&archive) {
            return Err(IrregularComputeErrorType::Portfolio(IrregularPortfolioError {
            operation: "intrinsicSharedArchive".to_string(),
            category: IrregularPortfolioErrorCategory::Search,
            message: format!(
                "intrinsic shared archive did not complete its production coverage contract; direct={}; catalog-runtime={}; catalog-family={}; periodic-selection={}",
                archive
                    .direct_runs
                    .iter()
                    .map(|run| format!("{}:{:?}", run.role, run.status))
                    .collect::<Vec<_>>()
                    .join(","),
                archive.periodic_portfolio.catalog.runtime_coverage_complete,
                archive.periodic_portfolio.catalog.family_coverage_complete,
                archive.periodic_selection_valid,
            ),
        }));
        }

        if let Some(trace) = intrinsic_anytime_scheduler_trace.as_mut() {
            trace.quanta.push(IntrinsicAnytimeSchedulerQuantum {
                ordinal: trace.quanta.len(),
                cohort: IntrinsicAnytimeSchedulerCohort::Complete,
                producer_role: IntrinsicAnytimeSchedulerProducerRole::LegacyComplete,
                outcome: IntrinsicAnytimeSchedulerOutcome::Settled,
            });
        }

        let protected_sheetless_archive = retain_ranked_shared_archive(&archive.sheetless_archive);
        let protected_sheetless_winner =
            select_intrinsic_shared_archive_winner(&protected_sheetless_archive);
        let protected_fitting_winner = select_intrinsic_shared_archive_winner(
            &select_fitting_shared_archive(&protected_sheetless_archive),
        );

        let mut focused_reconstruction_endpoints: Vec<IntrinsicSharedArchiveEndpoint> = Vec::new();
        if focused_complete_reconstruction_enabled {
            match (&protected_sheetless_winner, &protected_fitting_winner) {
                (Some(sheetless_winner), Some(_fitting_winner)) => {
                    let reconstruction_seed = reconstruction::IntrinsicReconstructionSeed {
                        role: reconstruction::IntrinsicReconstructionSeedRole::SettledProtected,
                        canonical_geometry_hash: sheetless_winner
                            .sheetless_canonical_geometry_hash
                            .clone(),
                        placed_collision_geometries: sheetless_winner
                            .placed_collision_geometries
                            .clone(),
                        step_trace: Vec::new(),
                        metrics: sheetless_winner.metrics.clone(),
                    };
                    let baseline_seeds = [reconstruction_seed];
                    let reconstruction_outcome = reconstruction::run_intrinsic_reconstruction_portfolio(
                    reconstruction::RunIntrinsicReconstructionPortfolioInput {
                        all_prepared_pieces: input.prepared_pieces,
                        baseline_seeds: &baseline_seeds,
                        maximum_runtime_ms_per_decode: Some(15_000.0),
                        maximum_total_runtime_ms: Some(15_000.0),
                        role_family: Some(
                            reconstruction::IntrinsicReconstructionRoleFamily::EndpointQ90RightToLeft,
                        ),
                        maximum_candidate_evaluations_per_decode: Some(12_000.0),
                        maximum_total_candidate_evaluations: Some(12_000.0),
                        control: control_dyn(&mut control),
                        timing_now: None,
                    },
                    input.settings,
                    geometry_cache,
                );

                    match reconstruction_outcome {
                        Err(reconstruction::IntrinsicReconstructionPortfolioFailure::Strict(
                            IntrinsicStrictDecoderFailure::Abort(abort),
                        )) => {
                            return Err(IrregularComputeErrorType::NfpIfpControlAbort(abort));
                        }
                        Err(failure) => {
                            focused_complete_reconstruction_trace =
                            Some(IntrinsicFocusedCompleteReconstructionTrace {
                                version: INTRINSIC_FOCUSED_COMPLETE_RECONSTRUCTION_TRACE_VERSION,
                                status: IntrinsicFocusedCompleteReconstructionStatus::FailedProtectedFallback,
                                source_canonical_geometry_hash: Some(
                                    sheetless_winner.sheetless_canonical_geometry_hash.clone(),
                                ),
                                candidate_canonical_geometry_hash: None,
                                selected_canonical_geometry_hash: None,
                                consumed_candidate_evaluations: 0.0,
                                candidate_evaluation_accounting_complete: false,
                                runtime_ms: 0.0,
                                output_influence: IntrinsicFocusedCompleteReconstructionOutputInfluence::None,
                                failure_reason: Some(reconstruction_failure_message(&failure)),
                            });
                        }
                        Ok(reconstruction) => {
                            let focused_run = reconstruction.runs.iter().find(|run| {
                            run.role
                                == reconstruction::IntrinsicReconstructionRole::EndpointQ90RightToLeft
                        });
                            if let Some(run) = focused_run {
                                if run.status
                                    == reconstruction::IntrinsicReconstructionRunStatus::Completed
                                    && run.metrics.is_some()
                                {
                                    let placement_order: Vec<PieceId> = run
                                        .placed_collision_geometries
                                        .iter()
                                        .map(|placed| {
                                            placed.placement.piece_id.clone().unwrap_or_else(|| {
                                                placed.placement.source_piece_id.clone()
                                            })
                                        })
                                        .collect();
                                    let state =
                                        crate::search::beam_state::IrregularBeamState::from_input(
                                            crate::search::beam_state::IrregularBeamStateInput {
                                                remaining_prepared_pieces: Vec::new(),
                                                placed_collision_geometries: run
                                                    .placed_collision_geometries
                                                    .clone(),
                                                unplaced_piece_ids: Some(Vec::new()),
                                                unplaced_source_piece_ids: None,
                                                placement_order,
                                                parent: None,
                                                placed_collision_index: None,
                                            },
                                        );
                                    if let Some(endpoint) = make_intrinsic_shared_archive_endpoint(
                                        MakeIntrinsicSharedArchiveEndpointInput {
                                            sheet: &input.request.sheet,
                                            role: "reconstruction-endpoint-q90-right-to-left"
                                                .to_string(),
                                            source_id: run.source_endpoint_hash.clone(),
                                            state,
                                            runtime_ms: Some(run.runtime_ms),
                                        },
                                    ) {
                                        focused_reconstruction_endpoints.push(endpoint);
                                    }
                                }
                            }
                            focused_complete_reconstruction_trace =
                            Some(IntrinsicFocusedCompleteReconstructionTrace {
                                version: INTRINSIC_FOCUSED_COMPLETE_RECONSTRUCTION_TRACE_VERSION,
                                status: focused_run
                                    .map(|run| reconstruction_status(run.status))
                                    .unwrap_or(
                                        IntrinsicFocusedCompleteReconstructionStatus::Incomplete,
                                    ),
                                source_canonical_geometry_hash: Some(
                                    sheetless_winner.sheetless_canonical_geometry_hash.clone(),
                                ),
                                candidate_canonical_geometry_hash: focused_reconstruction_endpoints
                                    .first()
                                    .map(|endpoint| {
                                        endpoint.sheetless_canonical_geometry_hash.clone()
                                    }),
                                selected_canonical_geometry_hash: None,
                                consumed_candidate_evaluations: reconstruction
                                    .consumed_candidate_evaluations,
                                candidate_evaluation_accounting_complete: reconstruction
                                    .candidate_evaluation_accounting_complete,
                                runtime_ms: reconstruction.runtime_ms,
                                output_influence:
                                    IntrinsicFocusedCompleteReconstructionOutputInfluence::None,
                                failure_reason: None,
                            });
                        }
                    }
                }
                _ => {
                    focused_complete_reconstruction_trace = Some(IntrinsicFocusedCompleteReconstructionTrace {
                    version: INTRINSIC_FOCUSED_COMPLETE_RECONSTRUCTION_TRACE_VERSION,
                    status: IntrinsicFocusedCompleteReconstructionStatus::SkippedNoFittingProtectedEndpoint,
                    source_canonical_geometry_hash: protected_sheetless_winner
                        .as_ref()
                        .map(|winner| winner.sheetless_canonical_geometry_hash.clone()),
                    candidate_canonical_geometry_hash: None,
                    selected_canonical_geometry_hash: None,
                    consumed_candidate_evaluations: 0.0,
                    candidate_evaluation_accounting_complete: true,
                    runtime_ms: 0.0,
                    output_influence: IntrinsicFocusedCompleteReconstructionOutputInfluence::None,
                    failure_reason: None,
                });
                }
            }
        }

        let sheetless_archive = retain_ranked_shared_archive(
            &protected_sheetless_archive
                .iter()
                .cloned()
                .chain(focused_reconstruction_endpoints.iter().cloned())
                .collect::<Vec<_>>(),
        );
        settled_complete_archive_for_short_side_observer = sheetless_archive.clone();
        let winner = select_intrinsic_shared_archive_winner(&select_fitting_shared_archive(
            &sheetless_archive,
        ));

        if let Some(trace) = focused_complete_reconstruction_trace.as_mut() {
            trace.selected_canonical_geometry_hash = winner
                .as_ref()
                .map(|winner| winner.sheetless_canonical_geometry_hash.clone());
            trace.output_influence = match &winner {
                None => IntrinsicFocusedCompleteReconstructionOutputInfluence::None,
                Some(winner) => {
                    if focused_reconstruction_endpoints.iter().any(|endpoint| {
                        endpoint.sheetless_canonical_geometry_hash
                            == winner.sheetless_canonical_geometry_hash
                    }) {
                        IntrinsicFocusedCompleteReconstructionOutputInfluence::Selected
                    } else {
                        IntrinsicFocusedCompleteReconstructionOutputInfluence::ProtectedFallback
                    }
                }
            };
        }

        match winner {
            None => {
                // TS: `...(scheduledColdStart === undefined ? {} : {scheduledColdStart,
                // captureWarmPrefixTelemetry: true, admitWarmPrefixEndpoints: true,
                // coordinateProtectedLanes: true})` (`:969-976`) -- all three
                // gated on `scheduledColdStart`'s presence together.
                let scheduled_cold_start_present = scheduled_cold_start.is_some();
                let capacity = run_intrinsic_capacity_mode(
                RunIntrinsicCapacityModeInput {
                    sheet: &input.request.sheet,
                    prepared_pieces: input.prepared_pieces,
                    routing: IntrinsicCapacityRouting::BoundedCompleteArchiveMiss,
                    preflight: &preflight,
                    prefix_sources: &prefix_sources,
                    capture_cohesion_shadow: false,
                    scheduled_cold_start,
                    admit_warm_prefix_endpoints: scheduled_cold_start_present,
                    coordinate_protected_lanes: scheduled_cold_start_present,
                    preflight_runtime_ms: Some(preflight_runtime_ms),
                    complete_archive_runtime_ms: Some(complete_archive_runtime_ms),
                    retention_mode: Some(
                        crate::capacity::search::IntrinsicCapacityRetentionMode::CohesionFrontier,
                    ),
                },
                control_dyn(&mut control),
                input.settings,
                geometry_cache,
                None,
            )
            .map_err(map_capacity_search_error)?;
                if let Some(trace) = intrinsic_anytime_scheduler_trace.as_mut() {
                    // TS: `:979-1006` -- append the lane coordinator's own
                    // resume/settlement quanta (filtered) onto the scheduler
                    // trace, immediately after whatever quanta the interleaved
                    // canonical-grid checkpoint chronology already produced.
                    let capacity_resume_ordinal = trace.quanta.len();
                    let empty_quanta: &[crate::capacity::mode::IntrinsicCapacityLaneCoordinatorQuantum] =
                    &[];
                    let lane_quanta = capacity
                        .trace
                        .lane_coordinator
                        .as_ref()
                        .map(|lane_coordinator| lane_coordinator.quanta.as_slice())
                        .unwrap_or(empty_quanta);
                    let capacity_quanta: Vec<IntrinsicAnytimeSchedulerQuantum> = lane_quanta
                    .iter()
                    .filter(|quantum| {
                        (quantum.producer_role == LaneCoordinatorQuantumProducerRole::CapacityCold
                            && quantum.phase == LaneCoordinatorQuantumPhase::Resume)
                            || ((quantum.producer_role
                                == LaneCoordinatorQuantumProducerRole::CapacityWarmPrefix
                                || quantum.producer_role
                                    == LaneCoordinatorQuantumProducerRole::CapacityQualityWarmPrefix)
                                && (quantum.phase == LaneCoordinatorQuantumPhase::Initial
                                    || quantum.phase == LaneCoordinatorQuantumPhase::Censor
                                    || quantum.outcome == LaneCoordinatorQuantumOutcome::Settled))
                    })
                    .enumerate()
                    .map(|(index, quantum)| IntrinsicAnytimeSchedulerQuantum {
                        ordinal: capacity_resume_ordinal + index,
                        cohort: IntrinsicAnytimeSchedulerCohort::Partial,
                        producer_role: lane_coordinator_producer_role_to_scheduler(
                            quantum.producer_role,
                        ),
                        outcome: lane_coordinator_outcome_to_scheduler(quantum.outcome),
                    })
                    .collect();
                    trace.cold_checkpoint_reused = scheduled_cold_checkpoint_reused;
                    trace.warm_prefix_endpoints_admitted =
                        capacity.trace.warm_prefix_endpoints_admitted;
                    trace.cancellation_reason =
                        Some(IntrinsicAnytimeSchedulerCancellationReason::CompleteCohortMiss);
                    trace.quanta.extend(capacity_quanta);
                }
                selected = materialize_capacity_result(input, &capacity, free_material_cache)?;
                archive_diagnostics.extend(intrinsic_capacity_diagnostics(&preflight, &capacity));
                capacity_trace = Some(capacity.trace.clone());
                emit_shared_archive_progress(
                    &mut *event_sink,
                    IrregularPortfolioPhase::Completed,
                    Some(selected.portfolio.score.clone()),
                    0.0,
                );
            }
            Some(winner) => {
                // TS: `:1017-1038` -- the trailing cold-cancellation quantum
                // only fires when the scheduler actually resumed the protected
                // cold lane at least once (`scheduledColdCheckpointReused`) and
                // it is still paused; `cancellationReason` itself is only set
                // when the scheduler ran at all (`scheduledColdStart !==
                // undefined`), not merely when it happened to already settle.
                if let Some(trace) = intrinsic_anytime_scheduler_trace.as_mut() {
                    trace.cancellation_reason = if scheduled_cold_start.is_none() {
                        None
                    } else {
                        Some(IntrinsicAnytimeSchedulerCancellationReason::CompleteEndpointFitted)
                    };
                    let should_cancel_cold = scheduled_cold_checkpoint_reused
                        && matches!(
                            &scheduled_cold_start,
                            Some(search) if search.status == IntrinsicCapacitySearchStatus::Paused
                        );
                    if should_cancel_cold {
                        trace.quanta.push(IntrinsicAnytimeSchedulerQuantum {
                            ordinal: trace.quanta.len(),
                            cohort: IntrinsicAnytimeSchedulerCohort::Partial,
                            producer_role: IntrinsicAnytimeSchedulerProducerRole::CapacityCold,
                            outcome: IntrinsicAnytimeSchedulerOutcome::Cancelled,
                        });
                    }
                }
                selected = materialize_shared_archive_result(
                    &MaterializeSharedArchiveResultInput {
                        sorted_piece_ids: input.sorted_piece_ids,
                        beam_width: input.settings.optimizer.beam_width,
                        history_mode: input.request.options.history_mode,
                        prepared_pieces: input.prepared_pieces,
                        sheet: input.request.sheet.clone(),
                    },
                    &winner,
                    input.settings,
                    free_material_cache,
                )?;
                archive_diagnostics.push(crate::result::materialize::shared_archive_diagnostic(
                    "completed",
                    format!(
                        "shared archive selected {} from {} exact endpoints",
                        winner.role,
                        sheetless_archive.len()
                    ),
                ));
                archive_diagnostics.push(CollisionGeometryDiagnostic {
                code: "capacity_preflight_inconclusive".to_string(),
                message:
                    "proof-only capacity preflight was inconclusive; complete mode ran unchanged"
                        .to_string(),
                piece_id: None,
            });
                archive_diagnostics.push(CollisionGeometryDiagnostic {
                code: "complete_archive_fitted".to_string(),
                message: match &scheduled_cold_start {
                    None => format!(
                        "complete endpoint {} fits the requested sheet; capacity mode did not run",
                        winner.sheetless_canonical_geometry_hash
                    ),
                    Some(search) => format!(
                        "complete endpoint {} fits the requested sheet; scheduled capacity prework {}",
                        winner.sheetless_canonical_geometry_hash,
                        if search.status == IntrinsicCapacitySearchStatus::Paused {
                            "was cancelled at its checkpoint"
                        } else {
                            "had already settled as observer-only work"
                        }
                    ),
                },
                piece_id: None,
            });
                emit_shared_archive_progress(
                    &mut *event_sink,
                    IrregularPortfolioPhase::Completed,
                    Some(selected.portfolio.score.clone()),
                    0.0,
                );
            }
        }
    }

    // Short Side profile block (`computeIrregularNesting.ts:1071-1203`).
    if short_side_profile_requested {
        return run_short_side_profile_block(RunShortSideProfileBlockInput {
            input,
            selected,
            settled_complete_archive: settled_complete_archive_for_short_side_observer,
            archive_diagnostics,
            intrinsic_anytime_scheduler_trace,
            focused_complete_reconstruction_trace,
            capacity_trace,
            event_sink,
            geometry_cache,
            free_material_cache,
        });
    }

    Ok(assemble_result(
        input,
        selected,
        archive_diagnostics,
        capacity_trace,
        intrinsic_anytime_scheduler_trace,
        focused_complete_reconstruction_trace,
        None,
        None,
        event_sink,
    ))
}

fn owned_prepared_pieces(pieces: &[Arc<IrregularPreparedPiece>]) -> Vec<IrregularPreparedPiece> {
    pieces.iter().map(|piece| (**piece).clone()).collect()
}

/// Concrete (`Sized`), non-trait-object wrapper around the optional native
/// cancellation-reason closure. See this module's top doc.
struct CancellationControl<'a> {
    cancellation_reason: &'a mut (dyn FnMut() -> Option<NfpIfpAbortReason> + 'a),
}

impl NfpIfpControl for CancellationControl<'_> {
    fn checkpoint(&mut self, _phase: NfpIfpCheckpointPhase) -> Result<(), NfpIfpControlAbortError> {
        let Some(reason) = (self.cancellation_reason)() else {
            return Ok(());
        };
        Err(NfpIfpControlAbortError {
            reason,
            message: match reason {
                NfpIfpAbortReason::Cancelled => "intrinsic shared archive was cancelled",
                NfpIfpAbortReason::Deadline => "intrinsic shared archive reached its deadline",
            }
            .to_string(),
        })
    }
}

fn cancellation_control<'a>(
    cancellation_reason: &'a mut (dyn FnMut() -> Option<NfpIfpAbortReason> + 'a),
) -> CancellationControl<'a> {
    CancellationControl {
        cancellation_reason,
    }
}

/// Builds a fresh, short-lived `&mut dyn NfpIfpControl` from the concrete
/// `Option<CancellationControl>` local each call site needs one -- see this
/// module's top doc for why this is a function (not a stored value).
fn control_dyn<'a>(
    control: &'a mut Option<CancellationControl<'_>>,
) -> Option<&'a mut dyn NfpIfpControl> {
    control
        .as_mut()
        .map(|control| control as &mut dyn NfpIfpControl)
}

fn map_preflight_error(error: IntrinsicCapacityPreflightError) -> IrregularComputeErrorType {
    match error {
        IntrinsicCapacityPreflightError::Capacity(inner) => map_capacity_error(inner),
        IntrinsicCapacityPreflightError::Geometry(inner) => {
            IrregularComputeErrorType::GeometryInput(inner)
        }
        IntrinsicCapacityPreflightError::Abort(inner) => {
            IrregularComputeErrorType::NfpIfpControlAbort(inner)
        }
    }
}

fn map_capacity_error(error: IntrinsicCapacityError) -> IrregularComputeErrorType {
    IrregularComputeErrorType::Portfolio(IrregularPortfolioError {
        operation: error.operation,
        category: IrregularPortfolioErrorCategory::Search,
        message: error.message,
    })
}

/// TS: `mapIntrinsicCapacityError` (`computeIrregularNesting.ts:1242-1252`).
/// `capacity::mode::run_intrinsic_capacity_mode`/
/// `run_intrinsic_capacity_scheduler_cold_quantum` return
/// `CapacitySearchError` (the same three-arm shape TS's
/// `IntrinsicCapacityModeError` union collapses to once the unreachable
/// `IrregularNestingNotImplementedError` arm is dropped, per this crate's
/// established "GREEN reused module never returns it" convention): only the
/// `Capacity` arm is TS's own `IntrinsicCapacityError` (mapped to
/// `IrregularPortfolioError` category `'search'`); `Geometry`/`Abort` are
/// already full `IrregularComputeErrorType` members in TS and pass through
/// unchanged (`mapIntrinsicCapacityError`'s own `else` branch).
fn map_capacity_search_error(error: CapacitySearchError) -> IrregularComputeErrorType {
    match error {
        CapacitySearchError::Capacity(inner) => map_capacity_error(inner),
        CapacitySearchError::Geometry(inner) => IrregularComputeErrorType::GeometryInput(inner),
        CapacitySearchError::Abort(inner) => IrregularComputeErrorType::NfpIfpControlAbort(inner),
    }
}

fn map_shared_archive_error(error: SharedArchiveError) -> IrregularComputeErrorType {
    match error {
        IntrinsicStrictDecoderFailure::Decoder(inner) => {
            IrregularComputeErrorType::Portfolio(IrregularPortfolioError {
                operation: inner.operation,
                category: IrregularPortfolioErrorCategory::Search,
                message: inner.message,
            })
        }
        IntrinsicStrictDecoderFailure::Geometry(inner) => {
            IrregularComputeErrorType::GeometryInput(inner)
        }
        IntrinsicStrictDecoderFailure::Abort(inner) => {
            IrregularComputeErrorType::NfpIfpControlAbort(inner)
        }
    }
}

fn reconstruction_failure_message(
    failure: &reconstruction::IntrinsicReconstructionPortfolioFailure,
) -> String {
    match failure {
        reconstruction::IntrinsicReconstructionPortfolioFailure::Portfolio(inner) => {
            format!("IntrinsicReconstructionPortfolioError: {}", inner.message)
        }
        reconstruction::IntrinsicReconstructionPortfolioFailure::Strict(inner) => match inner {
            IntrinsicStrictDecoderFailure::Decoder(inner) => {
                format!("IntrinsicStrictDecoderError: {}", inner.message)
            }
            IntrinsicStrictDecoderFailure::Geometry(inner) => {
                format!("IrregularGeometryInputError: {}", inner.message)
            }
            IntrinsicStrictDecoderFailure::Abort(inner) => {
                format!("IrregularNfpIfpControlAbortError: {}", inner.message)
            }
        },
    }
}

fn reconstruction_status(
    status: reconstruction::IntrinsicReconstructionRunStatus,
) -> IntrinsicFocusedCompleteReconstructionStatus {
    use reconstruction::IntrinsicReconstructionRunStatus as Src;
    match status {
        Src::Completed => IntrinsicFocusedCompleteReconstructionStatus::Completed,
        Src::Deadline => IntrinsicFocusedCompleteReconstructionStatus::Deadline,
        Src::EvaluationCap => IntrinsicFocusedCompleteReconstructionStatus::EvaluationCap,
        Src::DuplicateOrder => IntrinsicFocusedCompleteReconstructionStatus::DuplicateOrder,
        Src::Incomplete => IntrinsicFocusedCompleteReconstructionStatus::Incomplete,
    }
}

fn cold_search_status(
    result: &crate::capacity::search::IntrinsicCapacitySearchResult,
) -> IntrinsicAnytimeSchedulerColdStartStatus {
    match result.status {
        crate::capacity::search::IntrinsicCapacitySearchStatus::Paused => {
            IntrinsicAnytimeSchedulerColdStartStatus::Paused
        }
        _ => IntrinsicAnytimeSchedulerColdStartStatus::Settled,
    }
}

fn capacity_endpoint_origin_str(
    origin: crate::capacity::endpoint::IntrinsicCapacityEndpointOrigin,
) -> &'static str {
    use crate::capacity::endpoint::IntrinsicCapacityEndpointOrigin as Origin;
    match origin {
        Origin::ColdSearch => "cold-search",
        Origin::PrefixIncumbent => "prefix-incumbent",
        Origin::WarmPrefixContinuation => "warm-prefix-continuation",
    }
}

fn materialize_capacity_result(
    input: &CoordinateIntrinsicSharedArchiveInput<'_>,
    capacity: &crate::capacity::mode::IntrinsicCapacityModeResult,
    free_material_cache: &mut FreeMaterialCache,
) -> Result<MaterializedDecode, IrregularComputeErrorType> {
    let endpoint = &capacity.endpoint;
    let placed_collision_geometries = endpoint.placed_collision_geometries.clone();
    let placement_order = endpoint.placed_prepared_ids.clone();
    let state = crate::search::beam_state::IrregularBeamState::from_input(
        crate::search::beam_state::IrregularBeamStateInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometries: placed_collision_geometries.clone(),
            unplaced_piece_ids: Some(endpoint.unplaced_prepared_ids.clone()),
            unplaced_source_piece_ids: None,
            placement_order,
            parent: None,
            placed_collision_index: None,
        },
    );
    let score = crate::search::layout_scorer::score_state(
        &crate::search::layout_scorer::ScoreIrregularLayoutInput {
            sheet: input.request.sheet.clone(),
            state: crate::result::materialize::layout_scorer_view(&state),
        },
        input.settings,
        free_material_cache,
    )
    .map_err(IrregularComputeErrorType::from)?;

    let state_snapshots = if input.request.options.history_mode == HistoryMode::Off {
        Vec::new()
    } else {
        super::progress::selected_layout_reveal_snapshots(
            input.prepared_pieces,
            &placed_collision_geometries,
            &endpoint.unplaced_prepared_ids,
        )
    };

    let portfolio = super::IrregularPortfolioResult {
        status: super::IrregularPortfolioStatus::Completed,
        termination_reason: super::IrregularPortfolioTerminationReason::CapacitySubsetSettled,
        source: super::IrregularSearchSource::SharedArchive,
        placements: placed_collision_geometries
            .iter()
            .map(|placed| placed.placement.clone())
            .collect(),
        unplaced_piece_ids: endpoint.unplaced_prepared_ids.clone(),
        score: crate::result::materialize::layout_score_summary(
            &score,
            Some(endpoint.metrics.enclosed_cavity_count),
        ),
        diagnostics: vec![CollisionGeometryDiagnostic {
            code: "capacity_subset_settled".to_string(),
            message: format!(
                "intrinsic-capacity-v1 settled {} placed; {} unplaced; origin {}; q{}; hash {}",
                endpoint.metrics.placed_count,
                endpoint.unplaced_prepared_ids.len(),
                capacity_endpoint_origin_str(endpoint.origin),
                endpoint.selected_rotation_deg,
                endpoint.canonical_geometry_hash
            ),
            piece_id: None,
        }],
    };

    Ok(MaterializedDecode {
        placed_collision_geometries,
        score,
        unplaced_piece_ids: endpoint.unplaced_prepared_ids.clone(),
        diagnostics: Vec::new(),
        sorted_piece_ids: input.sorted_piece_ids.to_vec(),
        state_snapshots,
        beam_width: input.settings.optimizer.beam_width,
        portfolio,
        finalization_metrics: super::IrregularFinalizationMetrics {
            reconstruction_elapsed_ms: 0.0,
            final_score_elapsed_ms: 0.0,
        },
    })
}

fn intrinsic_capacity_diagnostics(
    preflight: &IntrinsicCapacityPreflightOutcome,
    capacity: &crate::capacity::mode::IntrinsicCapacityModeResult,
) -> Vec<CollisionGeometryDiagnostic> {
    let mut diagnostics = Vec::new();
    match preflight {
        IntrinsicCapacityPreflightOutcome::ProvenImpossible {
            reason,
            measurements,
        } => {
            diagnostics.push(CollisionGeometryDiagnostic {
                code: "capacity_preflight_proven_impossible".to_string(),
                // TS: `intrinsicCapacityDiagnostics`'s joined-string literal
                // (`computeIrregularNesting.ts:1331-1341`) -- three
                // semicolon-joined segments, plus a fourth `piece {pieceId}`
                // segment appended only for the singleton-transform-set
                // reason (never for the minimum-collision-area reason).
                message: {
                    let mut message = format!(
                        "reason {}; minimum-doubled-collision-area-grid2 {}; sheet-doubled-area-grid2 {}",
                        reason.as_str(),
                        measurements.minimum_doubled_collision_area_sum_grid2,
                        measurements.sheet_doubled_area_grid2
                    );
                    if let IntrinsicCapacityProvenImpossibleReason::SingletonTransformSetDoesNotFit {
                        piece_id,
                    } = reason
                    {
                        message.push_str(&format!("; piece {}", piece_id.0));
                    }
                    message
                },
                piece_id: None,
            });
        }
        IntrinsicCapacityPreflightOutcome::Inconclusive { .. } => {
            diagnostics.push(CollisionGeometryDiagnostic {
                code: "capacity_preflight_inconclusive".to_string(),
                message:
                    "proof-only capacity preflight was inconclusive; complete mode ran unchanged"
                        .to_string(),
                piece_id: None,
            });
            diagnostics.push(CollisionGeometryDiagnostic {
                code: "bounded_complete_archive_miss".to_string(),
                message: "valid, uncensored bounded complete archive produced no fitting endpoint; this is a bounded-search outcome, not an impossibility proof".to_string(),
                piece_id: None,
            });
        }
    }
    let trace = &capacity.trace;
    diagnostics.push(CollisionGeometryDiagnostic {
        code: "capacity_subset_settled".to_string(),
        message: format!(
            "settlement {}; placed {}; unplaced {}; origin {}; evaluations {}/{}; pruned-count {}; pruned-material {}; prefixes {}/{}; hash {}",
            trace.cold_search.settlement.as_str(),
            trace.selected.objective.placed_count,
            trace.selected.unplaced_count,
            capacity_endpoint_origin_str(trace.selected.objective.origin),
            trace.cold_search.consumed_placement_evaluations,
            trace.cold_search.placement_evaluation_cap,
            trace.cold_search.pruned_by_attainable_count,
            trace.cold_search.pruned_by_attainable_material,
            trace.prefixes.fitting_count,
            trace.prefixes.captured_count,
            trace.selected.objective.canonical_geometry_hash,
        ),
        piece_id: None,
    });
    diagnostics
}

fn capacity_search_error_to_shared_archive_error(error: CapacitySearchError) -> SharedArchiveError {
    match error {
        CapacitySearchError::Capacity(inner) => IntrinsicStrictDecoderFailure::Decoder(
            crate::search::strict_decoder::IntrinsicStrictDecoderError {
                operation: inner.operation,
                message: inner.message,
            },
        ),
        CapacitySearchError::Geometry(inner) => IntrinsicStrictDecoderFailure::Geometry(inner),
        CapacitySearchError::Abort(inner) => IntrinsicStrictDecoderFailure::Abort(inner),
    }
}

fn lane_coordinator_producer_role_to_scheduler(
    role: LaneCoordinatorQuantumProducerRole,
) -> IntrinsicAnytimeSchedulerProducerRole {
    match role {
        LaneCoordinatorQuantumProducerRole::CapacityCold => {
            IntrinsicAnytimeSchedulerProducerRole::CapacityCold
        }
        LaneCoordinatorQuantumProducerRole::CapacityQualityWarmPrefix => {
            IntrinsicAnytimeSchedulerProducerRole::CapacityQualityWarmPrefix
        }
        LaneCoordinatorQuantumProducerRole::CapacityWarmPrefix => {
            IntrinsicAnytimeSchedulerProducerRole::CapacityWarmPrefix
        }
    }
}

fn lane_coordinator_outcome_to_scheduler(
    outcome: LaneCoordinatorQuantumOutcome,
) -> IntrinsicAnytimeSchedulerOutcome {
    match outcome {
        LaneCoordinatorQuantumOutcome::Checkpointed => {
            IntrinsicAnytimeSchedulerOutcome::Checkpointed
        }
        LaneCoordinatorQuantumOutcome::Settled => IntrinsicAnytimeSchedulerOutcome::Settled,
        LaneCoordinatorQuantumOutcome::Censored => IntrinsicAnytimeSchedulerOutcome::Censored,
    }
}

#[allow(clippy::too_many_arguments)]
fn assemble_result(
    input: &CoordinateIntrinsicSharedArchiveInput<'_>,
    selected: MaterializedDecode,
    archive_diagnostics: Vec<CollisionGeometryDiagnostic>,
    capacity_trace: Option<IntrinsicCapacityTrace>,
    intrinsic_anytime_scheduler_trace: Option<IntrinsicAnytimeSchedulerTrace>,
    focused_complete_reconstruction_trace: Option<IntrinsicFocusedCompleteReconstructionTrace>,
    intrinsic_short_side_observer_trace: Option<
        crate::short_side::observer::IntrinsicShortSideObserverTrace,
    >,
    intrinsic_short_side_pair_fold_trace: Option<
        crate::short_side::pair_fold::IntrinsicShortSidePairFoldTrace,
    >,
    event_sink: &mut dyn IrregularComputeEventSink,
) -> IrregularComputeResult {
    for snapshot in &selected.state_snapshots {
        event_sink.emit_state_snapshot(snapshot, input.settings.optimizer.beam_width);
    }

    IrregularComputeResult {
        placed_collision_geometries: selected.placed_collision_geometries,
        score: selected.score.clone(),
        unplaced_piece_ids: selected.unplaced_piece_ids,
        diagnostics: input
            .diagnostics
            .iter()
            .cloned()
            .chain(
                selected
                    .score
                    .free_material_snapshot
                    .diagnostics
                    .iter()
                    .cloned(),
            )
            .chain(archive_diagnostics)
            .collect(),
        sorted_piece_ids: selected.sorted_piece_ids,
        state_snapshots: selected.state_snapshots,
        beam_width: input.settings.optimizer.beam_width,
        portfolio: selected.portfolio,
        capacity_trace,
        intrinsic_anytime_scheduler_trace,
        focused_complete_reconstruction_trace,
        intrinsic_short_side_observer_trace,
        intrinsic_short_side_pair_fold_trace,
    }
}

// ===========================================================================
// Short Side profile block (`computeIrregularNesting.ts:1071-1203`).
// ===========================================================================

struct RunShortSideProfileBlockInput<'a, 'sink> {
    input: &'a CoordinateIntrinsicSharedArchiveInput<'a>,
    selected: MaterializedDecode,
    settled_complete_archive: Vec<IntrinsicSharedArchiveEndpoint>,
    archive_diagnostics: Vec<CollisionGeometryDiagnostic>,
    intrinsic_anytime_scheduler_trace: Option<IntrinsicAnytimeSchedulerTrace>,
    focused_complete_reconstruction_trace: Option<IntrinsicFocusedCompleteReconstructionTrace>,
    capacity_trace: Option<IntrinsicCapacityTrace>,
    event_sink: &'sink mut dyn IrregularComputeEventSink,
    geometry_cache: &'a mut GeometryCacheStore,
    free_material_cache: &'a mut FreeMaterialCache,
}

fn run_short_side_profile_block(
    block: RunShortSideProfileBlockInput<'_, '_>,
) -> Result<IrregularComputeResult, IrregularComputeErrorType> {
    let RunShortSideProfileBlockInput {
        input,
        mut selected,
        settled_complete_archive,
        mut archive_diagnostics,
        intrinsic_anytime_scheduler_trace,
        focused_complete_reconstruction_trace,
        // TS: `capacityTrace` in the final result comes from `selected.capacityTrace`
        // (`computeIrregularNesting.ts:1221`, a field the *materialize*
        // function populates -- unlike `intrinsicAnytimeSchedulerTrace`/
        // `focusedCompleteReconstructionTrace`, which are independent
        // coordinator-level `let`s). `materializeIntrinsicShortSideProfileResult`
        // never sets it, so once this block's own pair-fold construction
        // successfully replaces `selected`, any capacity trace an earlier
        // capacity-mode call in *this same run* produced must be dropped --
        // mutable so the success arm below can clear it.
        mut capacity_trace,
        event_sink,
        geometry_cache,
        free_material_cache,
    } = block;

    emit_shared_archive_progress(
        &mut *event_sink,
        IrregularPortfolioPhase::ShortSideProfile,
        Some(selected.portfolio.score.clone()),
        0.0,
    );

    let observer_endpoints: Vec<crate::short_side::observer::IntrinsicSharedArchiveEndpoint> =
        settled_complete_archive
            .iter()
            .map(project_endpoint_for_observer)
            .collect();
    let observer_trace = crate::short_side::observer::observe_intrinsic_short_side_orientations(
        crate::short_side::observer::ObserveIntrinsicShortSideOrientationsInput {
            sheet: &input.request.sheet,
            endpoints: &observer_endpoints,
            production_placed_collision_geometries: Some(&selected.placed_collision_geometries),
            now: None,
        },
    );

    let mut short_side_selected = false;
    let mut intrinsic_short_side_pair_fold_trace = None;

    // TS: `intrinsicShortSideObserverTrace.productionShortAxisSpanMm !==
    // undefined && ... && productionEnvelopeAreaGrid2 !== undefined`
    // (`:1128-1140`) -- all six terms present or none consumed. Matched as
    // one tuple (rather than six `.is_some()` checks followed by six
    // `.expect(...)` calls) so the compiler proves each unwrap total at the
    // pattern-match site itself.
    let production_short_side_terms = (
        observer_trace.production_short_axis_span_mm,
        observer_trace.production_maximum_side_mm,
        observer_trace.production_envelope_area_mm2,
        observer_trace.production_short_axis_span_grid,
        observer_trace.production_maximum_side_grid,
        observer_trace.production_envelope_area_grid2.clone(),
    );
    if let (
        Some(production_short_axis_span_mm),
        Some(production_maximum_side_mm),
        Some(production_envelope_area_mm2),
        Some(production_short_axis_span_grid),
        Some(production_maximum_side_grid),
        Some(production_envelope_area_grid2),
    ) = production_short_side_terms
    {
        let directional_target_ids: std::collections::HashSet<PieceId> = selected
            .placed_collision_geometries
            .iter()
            .map(|placed| {
                placed
                    .placement
                    .piece_id
                    .clone()
                    .unwrap_or_else(|| placed.placement.source_piece_id.clone())
            })
            .collect();
        let directional_prepared_pieces: Vec<Arc<IrregularPreparedPiece>> = input
            .prepared_pieces
            .iter()
            .filter(|piece| {
                let id = piece
                    .piece_id
                    .clone()
                    .unwrap_or_else(|| piece.source.id.clone());
                directional_target_ids.contains(&id)
            })
            .cloned()
            .collect();

        let pair_fold_outcome =
            crate::short_side::pair_fold::observe_intrinsic_short_side_pair_fold(
                crate::short_side::pair_fold::IntrinsicShortSidePairFoldInput {
                    sheet: &input.request.sheet,
                    prepared_pieces: &directional_prepared_pieces,
                    settings: input.settings,
                    production_short_axis_span_mm,
                    production_maximum_side_mm,
                    production_envelope_area_mm2,
                    production_short_axis_span_grid,
                    production_maximum_side_grid,
                    production_envelope_area_grid2,
                    runtime_control: None,
                },
                geometry_cache,
            );

        if pair_fold_outcome.trace.status
            == crate::short_side::pair_fold::IntrinsicShortSidePairFoldStatus::Accepted
        {
            if let Some(placed_collision_geometries) =
                pair_fold_outcome.placed_collision_geometries.clone()
            {
                selected = materialize_intrinsic_short_side_profile_result(
                    MaterializeIntrinsicShortSideProfileResultInput {
                        sorted_piece_ids: input.sorted_piece_ids,
                        beam_width: input.settings.optimizer.beam_width,
                        history_mode: input.request.options.history_mode,
                        prepared_pieces: input.prepared_pieces,
                        sheet: input.request.sheet.clone(),
                        placed_collision_geometries,
                        selection: pair_fold_outcome
                            .trace
                            .construction_kind
                            .map(ShortSideProfileSelection::Construction)
                            .unwrap_or(ShortSideProfileSelection::Construction(
                                crate::short_side::pair_fold::IntrinsicShortSideConstructionKind::PairFold,
                            )),
                        canonical_geometry_hash: pair_fold_outcome.trace.canonical_geometry_hash.clone(),
                    },
                    input.settings,
                    free_material_cache,
                )?;
                // See this function's `capacity_trace` doc comment above:
                // this new `selected` never carries a capacity trace.
                capacity_trace = None;
                let mut measured = pair_fold_outcome.trace.clone();
                measured.output_influence =
                    crate::short_side::observer::ShortSideOutputInfluence::Selected;
                intrinsic_short_side_pair_fold_trace =
                    Some(crate::short_side::pair_fold::with_measured_trace(measured));
                archive_diagnostics.push(
                    crate::result::materialize::intrinsic_short_side_profile_diagnostic(
                        "selected",
                        format!(
                            "selected admitted {} construction {}",
                            pair_fold_outcome
                                .trace
                                .construction_kind
                                .map(|kind| kind.as_str())
                                .unwrap_or("terminal"),
                            pair_fold_outcome
                                .trace
                                .canonical_geometry_hash
                                .clone()
                                .unwrap_or_else(|| "without-canonical-hash".to_string())
                        ),
                    ),
                );
                short_side_selected = true;
            }
        } else {
            intrinsic_short_side_pair_fold_trace = Some(pair_fold_outcome.trace);
        }
    }

    if !short_side_selected {
        return Err(IrregularComputeErrorType::NoValidResult(IrregularNoValidResultError {
            operation: "intrinsicShortSide".to_string(),
            message: format!(
                "directional Short Side construction invariant failed (archive={:?}, terminal={:?})",
                observer_trace.status,
                intrinsic_short_side_pair_fold_trace.as_ref().map(|trace| trace.status)
            ),
        }));
    }

    Ok(assemble_result(
        input,
        selected,
        archive_diagnostics,
        capacity_trace,
        intrinsic_anytime_scheduler_trace,
        focused_complete_reconstruction_trace,
        Some(observer_trace),
        intrinsic_short_side_pair_fold_trace,
        event_sink,
    ))
}

fn project_endpoint_for_observer(
    endpoint: &IntrinsicSharedArchiveEndpoint,
) -> crate::short_side::observer::IntrinsicSharedArchiveEndpoint {
    crate::short_side::observer::IntrinsicSharedArchiveEndpoint {
        role: endpoint.role.clone(),
        source_id: endpoint.source_id.clone(),
        sheetless_canonical_geometry_hash: endpoint.sheetless_canonical_geometry_hash.clone(),
        placed_collision_geometries: endpoint.placed_collision_geometries.clone(),
        metrics: endpoint.metrics.clone(),
        certificate: endpoint.certificate.clone(),
    }
}
