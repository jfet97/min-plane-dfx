//! `computeIrregularNesting`/`coordinateIntrinsicSharedArchive`: piece
//! preparation, the intrinsic shared-archive invocation (direct + real
//! periodic-family runner), the scheduler cold-start, focused
//! reconstruction, and the Compact Short Side profile block.
//!
//! TS source: `computeIrregularNesting.ts:364-1240`. See `result::mod`'s top
//! doc for this module's exact scope (archive-eligible path only; the
//! not-yet-ported `capacity::mode` orchestration is behind
//! [`IntrinsicCapacityModeRunner`]).
//!
//! # A note on this file's own mutable-resource plumbing
//!
//! Every genuinely mutable resource this coordinator threads
//! (`event_sink`, `geometry_cache`, `free_material_cache`,
//! `capacity_mode_runner`, the cooperative-cancellation `control`) is passed
//! as an independent top-level parameter, never as a field nested inside
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

use crate::archive::shared::{
    make_intrinsic_shared_archive_endpoint, retain_ranked_shared_archive,
    run_intrinsic_shared_archive_portfolio, select_fitting_shared_archive,
    select_intrinsic_shared_archive_winner, IntrinsicPeriodicFamilyPortfolioForcedOptions,
    IntrinsicPeriodicFamilyPortfolioRunner, IntrinsicSharedArchiveEndpoint,
    IntrinsicSharedArchivePortfolioOptions, MakeIntrinsicSharedArchiveEndpointInput,
    SharedArchiveError, SharedArchivePhase,
};
use crate::archive::{periodic_family, reconstruction};
use crate::caches::GeometryCacheStore;
use crate::capacity::preflight::{
    preflight_intrinsic_complete_capacity, IntrinsicCapacityError, IntrinsicCapacityPreflightError,
    IntrinsicCapacityPreflightOutcome,
};
use crate::domain::{
    CollisionGeometryDiagnostic, ImportedPiece, IrregularNestingSettings, IrregularPreparedPiece,
    IrregularPriorityOrderKey, PieceId, SheetSpec,
};
use crate::geometry::collision_builder::{build_piece, BuildCollisionGeometryInput};
use crate::nfp_ifp::{
    NfpIfpAbortReason, NfpIfpCheckpointPhase, NfpIfpControl, NfpIfpControlAbortError,
};
use crate::search::layout_scorer::FreeMaterialCache;
use crate::search::sort_pieces::sort_pieces_for_nesting;
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
    /// TS: `options?.isCancelled` -- inert in production (`worker-coordination.md`
    /// §10) but a real, load-bearing seam for test/script harnesses.
    pub is_cancelled: Option<&'a mut dyn FnMut() -> bool>,
    /// TS: `options?.focusedCompleteReconstructionControlArm !== 'disable'`.
    /// `true` unless explicitly disabled.
    pub focused_complete_reconstruction_enabled: bool,
}

impl Default for ComputeIrregularNestingOptions<'_> {
    fn default() -> Self {
        Self {
            event_sink: None,
            is_cancelled: None,
            focused_complete_reconstruction_enabled: true,
        }
    }
}

// ===========================================================================
// Seam: `IntrinsicCapacityModeRunner` (see `result::mod`'s top doc, "Known
// gap: `capacity::mode`'s top-level orchestration is not yet ported").
// ===========================================================================

/// Minimal projection of TS `IntrinsicCapacityRouting`
/// (`intrinsicCapacityMode.ts`) -- the two values
/// `coordinateIntrinsicSharedArchive` ever passes as `routing`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacityRouting {
    PreflightProvenImpossible,
    BoundedCompleteArchiveMiss,
}

/// Minimal seam projection of TS `IntrinsicCapacityTrace`
/// (`intrinsicCapacityMode.ts:175-197`), restricted to the fields this
/// coordinator's own diagnostics/scheduler-trace assembly reads
/// (`intrinsicCapacityDiagnostics`, `:1324-1376`, and the
/// `capacity.trace.laneCoordinator?.quanta`/`warmPrefixEndpointsAdmitted`
/// reads at `:979-1007`). See `result::mod`'s top doc for why this is a
/// minimal projection rather than the full trace shape: the real trace's
/// many other fields (`prefixes`, `cohesionShadow`, `qualityWarmPrefix`,
/// ...) belong to the not-yet-ported orchestration that would produce them.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicCapacityTrace {
    pub cold_search_settlement: String,
    pub cold_search_consumed_placement_evaluations: f64,
    pub cold_search_placement_evaluation_cap: f64,
    pub cold_search_pruned_by_attainable_count: f64,
    pub cold_search_pruned_by_attainable_material: f64,
    pub selected_placed_count: f64,
    pub selected_unplaced_count: f64,
    pub selected_origin: String,
    pub selected_canonical_geometry_hash: String,
    pub prefixes_fitting_count: f64,
    pub prefixes_captured_count: f64,
    pub warm_prefix_endpoints_admitted: bool,
}

/// TS: `IntrinsicCapacityModeResult` (`intrinsicCapacityMode.ts:329-333`),
/// restricted to what this coordinator consumes.
pub struct IntrinsicCapacityModeSeamResult {
    pub endpoint: crate::capacity::endpoint::IntrinsicCapacityEndpoint,
    pub trace: IntrinsicCapacityTrace,
}

/// Seam standing in for the not-yet-ported `runIntrinsicCapacityMode`. See
/// this module's top doc and `result::mod`'s "Known gap" section.
pub trait IntrinsicCapacityModeRunner {
    fn run_capacity_mode(
        &mut self,
        sheet: &SheetSpec,
        prepared_pieces: &[Arc<IrregularPreparedPiece>],
        routing: IntrinsicCapacityRouting,
        preflight: &IntrinsicCapacityPreflightOutcome,
    ) -> Result<IntrinsicCapacityModeSeamResult, IntrinsicCapacityError>;
}

/// Default [`IntrinsicCapacityModeRunner`]: reports a typed, honest "not yet
/// ported" error rather than fabricating a capacity-mode result. See
/// `result::mod`'s top doc for the reconciliation path once
/// `capacity::mode` grows the real orchestration.
#[derive(Default)]
pub struct UnimplementedCapacityModeRunner;

impl IntrinsicCapacityModeRunner for UnimplementedCapacityModeRunner {
    fn run_capacity_mode(
        &mut self,
        _sheet: &SheetSpec,
        _prepared_pieces: &[Arc<IrregularPreparedPiece>],
        _routing: IntrinsicCapacityRouting,
        _preflight: &IntrinsicCapacityPreflightOutcome,
    ) -> Result<IntrinsicCapacityModeSeamResult, IntrinsicCapacityError> {
        Err(IntrinsicCapacityError {
            operation: "runIntrinsicCapacityMode".to_string(),
            message: "capacity::mode's top-level orchestration (runIntrinsicCapacityMode) is not yet ported to Rust; this coordinator branch cannot produce a real result until that lands.".to_string(),
        })
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
pub struct RealIntrinsicPeriodicFamilyPortfolioRunner<'a> {
    pub settings: &'a IrregularNestingSettings,
    pub geometry_cache: &'a mut GeometryCacheStore,
}

impl IntrinsicPeriodicFamilyPortfolioRunner for RealIntrinsicPeriodicFamilyPortfolioRunner<'_> {
    fn run(
        &mut self,
        sheet: &SheetSpec,
        pieces: &[Arc<IrregularPreparedPiece>],
        forced: IntrinsicPeriodicFamilyPortfolioForcedOptions<'_>,
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
            self.geometry_cache,
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
    let mut prepared_pieces: Vec<Arc<IrregularPreparedPiece>> =
        Vec::with_capacity(sorted_pieces.len());
    let mut diagnostics: Vec<CollisionGeometryDiagnostic> = Vec::new();

    for prepared in &sorted_pieces {
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
        let allow_mirror =
            request.options.allow_global_mirror.unwrap_or(true) && prepared.allow_mirror;
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
    let is_cancelled = options.is_cancelled.take();
    let focused_complete_reconstruction_enabled = options.focused_complete_reconstruction_enabled;
    let mut unimplemented_capacity_runner = UnimplementedCapacityModeRunner;

    coordinate_intrinsic_shared_archive(
        &input,
        event_sink,
        is_cancelled,
        focused_complete_reconstruction_enabled,
        geometry_cache,
        free_material_cache,
        &mut unimplemented_capacity_runner,
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
    is_cancelled: Option<&mut dyn FnMut() -> bool>,
    focused_complete_reconstruction_enabled: bool,
    geometry_cache: &mut GeometryCacheStore,
    free_material_cache: &mut FreeMaterialCache,
    capacity_mode_runner: &mut dyn IntrinsicCapacityModeRunner,
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

    // TS: `control` (`:512-525`) -- a checkpoint closure that fails with
    // `cancelled` when `isCancelled()` returns true, or `None` when no
    // `isCancelled` callback was supplied (mirroring every downstream
    // `...(control === undefined ? {} : {control})` spread). Kept as a
    // concrete (`Sized`), non-trait-object local; every call site below
    // builds its own short-lived `&mut dyn NfpIfpControl` fresh via
    // `.as_mut().map(...)` rather than storing one long-lived trait-object
    // reborrow (see this module's top doc).
    let mut control = is_cancelled.map(cancellation_control);

    let preflight = preflight_intrinsic_complete_capacity(
        &input.request.sheet,
        &owned_prepared_pieces(input.prepared_pieces),
        &input.settings.geometry,
        geometry_cache,
        control_dyn(&mut control),
    )
    .map_err(map_preflight_error)?;

    let selected: MaterializedDecode;

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
        let capacity = capacity_mode_runner
            .run_capacity_mode(
                &input.request.sheet,
                input.prepared_pieces,
                IntrinsicCapacityRouting::PreflightProvenImpossible,
                &preflight,
            )
            .map_err(map_capacity_error)?;
        selected = materialize_capacity_result(input, &capacity, free_material_cache)?;
        archive_diagnostics.extend(intrinsic_capacity_diagnostics(&preflight, &capacity));
        emit_shared_archive_progress(
            &mut *event_sink,
            IrregularPortfolioPhase::Completed,
            Some(selected.portfolio.score.clone()),
            0.0,
        );

        return Ok(assemble_result(
            input,
            selected,
            archive_diagnostics,
            capacity_trace,
            intrinsic_anytime_scheduler_trace,
            focused_complete_reconstruction_trace,
            None,
            None,
            event_sink,
        ));
    }

    // TS: `schedulerEnabled = true` (`:604`) -- the scheduler cold-start
    // always runs on this branch in production.
    let owned_pieces_for_material_areas = owned_prepared_pieces(input.prepared_pieces);
    let material_areas = crate::capacity::material::intrinsic_capacity_material_areas(
        &owned_pieces_for_material_areas,
    );
    let scheduled_cold_start = match material_areas {
        crate::capacity::material::IntrinsicCapacityMaterialAreas::Complete {
            areas_by_piece_id,
        } => {
            let mut cavity_cache =
                crate::capacity::endpoint::IntrinsicCapacityCavityCache::default();
            let depths = crate::capacity::mode::INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS
                .min((input.prepared_pieces.len() as f64).max(1.0));
            crate::capacity::search::run_intrinsic_capacity_cold_search(
                crate::capacity::search::RunIntrinsicCapacityColdSearchInput {
                    sheet: &input.request.sheet,
                    prepared_pieces: input.prepared_pieces,
                    material_areas_by_piece_id: &areas_by_piece_id,
                    cavity_cache: &mut cavity_cache,
                    incumbent: None,
                    control: control_dyn(&mut control),
                    capture_phase_timings: false,
                    checkpoint: None,
                    maximum_depth_boundaries: Some(depths),
                    warm_prefix_seed: None,
                    scheduler_deficit: Some(1.0),
                    retention_mode: None,
                    settings: input.settings,
                    geometry_cache,
                    timing_now: None,
                },
            )
            .ok()
        }
        crate::capacity::material::IntrinsicCapacityMaterialAreas::Invalid { .. } => None,
    };

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

    // `run_intrinsic_shared_archive_portfolio` takes both `periodic_runner`
    // (which must independently own a `&mut GeometryCacheStore` for its own
    // `.run()` call, per `archive::shared`'s fixed trait signature) and a
    // top-level `geometry_cache: &mut GeometryCacheStore` parameter for its
    // own direct-phase work -- two simultaneous exclusive borrows of the
    // *same* store are therefore structurally required by that signature.
    // Since the coordinator's outer `geometry_cache` is already borrowed
    // for the direct-phase parameter below, the periodic runner is given
    // its own private, freshly-allocated `GeometryCacheStore` instead of
    // sharing the coordinator's. Both stores compute byte-identical
    // results for any given input (the cache is a pure memoization layer,
    // not a correctness input); this only forgoes cross-phase cache-hit
    // reuse between the direct and periodic phases, a performance
    // difference, never an observable-output difference.
    let mut periodic_geometry_cache = GeometryCacheStore::new();
    let mut periodic_runner = RealIntrinsicPeriodicFamilyPortfolioRunner {
        settings: input.settings,
        geometry_cache: &mut periodic_geometry_cache,
    };
    // TS: `onPhaseCompleted: () => emitSharedArchiveProgress(input, 'shared_archive',
    // undefined, ...)` (`computeIrregularNesting.ts:710-716`) -- fires once
    // after the direct phase and once after the periodic phase, both still
    // reporting phase `'shared_archive'` (the phase name does not change;
    // only the elapsed-time payload would, and that field is diagnostic-only
    // per `worker-coordination.md` §7). Captured here (not stored earlier)
    // so `event_sink`'s reborrow only needs to live for this one call.
    let mut on_phase_completed = |_phase: SharedArchivePhase| -> Result<(), SharedArchiveError> {
        emit_shared_archive_progress(
            &mut *event_sink,
            IrregularPortfolioPhase::SharedArchive,
            None,
            0.0,
        );
        Ok(())
    };
    let mut portfolio_options = IntrinsicSharedArchivePortfolioOptions {
        maximum_direct_runtime_ms: Some(35_000.0),
        include_source_audit_witnesses: Some(true),
        on_phase_completed: Some(&mut on_phase_completed),
        ..Default::default()
    };
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
                    )) if abort.reason == NfpIfpAbortReason::Cancelled => {
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
    let settled_complete_archive_for_short_side_observer = sheetless_archive.clone();
    let winner =
        select_intrinsic_shared_archive_winner(&select_fitting_shared_archive(&sheetless_archive));

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
            let capacity = capacity_mode_runner
                .run_capacity_mode(
                    &input.request.sheet,
                    input.prepared_pieces,
                    IntrinsicCapacityRouting::BoundedCompleteArchiveMiss,
                    &preflight,
                )
                .map_err(map_capacity_error)?;
            if let Some(trace) = intrinsic_anytime_scheduler_trace.as_mut() {
                trace.warm_prefix_endpoints_admitted =
                    capacity.trace.warm_prefix_endpoints_admitted;
                trace.cancellation_reason =
                    Some(IntrinsicAnytimeSchedulerCancellationReason::CompleteCohortMiss);
            }
            selected = materialize_capacity_result(input, &capacity, free_material_cache)?;
            archive_diagnostics.extend(intrinsic_capacity_diagnostics(&preflight, &capacity));
            emit_shared_archive_progress(
                &mut *event_sink,
                IrregularPortfolioPhase::Completed,
                Some(selected.portfolio.score.clone()),
                0.0,
            );
        }
        Some(winner) => {
            if let Some(trace) = intrinsic_anytime_scheduler_trace.as_mut() {
                trace.cancellation_reason =
                    Some(IntrinsicAnytimeSchedulerCancellationReason::CompleteEndpointFitted);
                if scheduled_cold_start.is_some() {
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
                message: format!(
                    "complete endpoint {} fits the requested sheet",
                    winner.sheetless_canonical_geometry_hash
                ),
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

/// Concrete (`Sized`), non-trait-object wrapper around the optional
/// `isCancelled` closure. See this module's top doc.
struct CancellationControl<'a> {
    is_cancelled: &'a mut (dyn FnMut() -> bool + 'a),
}

impl NfpIfpControl for CancellationControl<'_> {
    fn checkpoint(&mut self, _phase: NfpIfpCheckpointPhase) -> Result<(), NfpIfpControlAbortError> {
        if (self.is_cancelled)() {
            Err(NfpIfpControlAbortError {
                reason: NfpIfpAbortReason::Cancelled,
                message: "intrinsic shared archive was cancelled".to_string(),
            })
        } else {
            Ok(())
        }
    }
}

fn cancellation_control<'a>(
    is_cancelled: &'a mut (dyn FnMut() -> bool + 'a),
) -> CancellationControl<'a> {
    CancellationControl { is_cancelled }
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
    capacity: &IntrinsicCapacityModeSeamResult,
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
                "intrinsic-capacity-v1 settled {} placed; {} unplaced; origin {}; hash {}",
                endpoint.metrics.placed_count,
                endpoint.unplaced_prepared_ids.len(),
                capacity_endpoint_origin_str(endpoint.origin),
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
    capacity: &IntrinsicCapacityModeSeamResult,
) -> Vec<CollisionGeometryDiagnostic> {
    let mut diagnostics = Vec::new();
    match preflight {
        IntrinsicCapacityPreflightOutcome::ProvenImpossible {
            reason,
            measurements,
        } => {
            diagnostics.push(CollisionGeometryDiagnostic {
                code: "capacity_preflight_proven_impossible".to_string(),
                message: format!(
                    "reason {:?}; minimum-doubled-collision-area-grid2 {}; sheet-doubled-area-grid2 {}",
                    reason,
                    measurements.minimum_doubled_collision_area_sum_grid2,
                    measurements.sheet_doubled_area_grid2
                ),
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
            trace.cold_search_settlement,
            trace.selected_placed_count,
            trace.selected_unplaced_count,
            trace.selected_origin,
            trace.cold_search_consumed_placement_evaluations,
            trace.cold_search_placement_evaluation_cap,
            trace.cold_search_pruned_by_attainable_count,
            trace.cold_search_pruned_by_attainable_material,
            trace.prefixes_fitting_count,
            trace.prefixes_captured_count,
            trace.selected_canonical_geometry_hash,
        ),
        piece_id: None,
    });
    diagnostics
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
        capacity_trace,
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
