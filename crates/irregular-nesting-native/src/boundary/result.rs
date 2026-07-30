//! Result DTO: `serde::Serialize` projection of `IrregularComputeResult`
//! (`result::coordinator::compute_irregular_nesting`'s return value) onto
//! the exact wire JSON shape TypeScript consumes, with
//! `native-boundary.md` §8's undefined-omission semantics preserved exactly
//! (`skip_serializing_if` on every optional field).
//!
//! # Reuse, not a second copy
//!
//! Every nested shape this crate already ported with a matching wire
//! encoding (`IrregularPlacedPiece`, `CollisionGeometryDiagnostic`,
//! `IrregularLayoutScoreSummary`, `FreeMaterialSnapshot`, `PieceId`, ...)
//! serializes directly through its own existing `serde::Serialize` impl.
//! This module declares new DTO structs only for the handful of
//! `result`/`search::layout_scorer`-owned types that do not derive
//! `Serialize` at all (they were ported for internal/differential-vector use
//! only, per those modules' own "serde is for test-vector IO" convention)
//! plus the small number of hand-mapped string-literal enums where a naive
//! `#[serde(rename_all = ...)]` would not reproduce the real, narrower TS
//! wire strings a Rust-side placeholder variant does not literally spell out
//! (see `project_portfolio_status`/`project_termination_reason`/
//! `project_search_source` below).
//!
//! # Five optional trace fields: full field-for-field wire projections
//!
//! `capacity_trace`, `intrinsic_anytime_scheduler_trace`,
//! `focused_complete_reconstruction_trace`,
//! `intrinsic_short_side_observer_trace`, and
//! `intrinsic_short_side_pair_fold_trace` are each present/absent on the
//! wire with **exact** parity to `native-boundary.md` §8.1's presence table
//! (verified against `result::coordinator`'s own control flow), and each
//! present trace now serializes as the real, full field-for-field wire
//! shape rather than an opaque `{"raw": "<Rust Debug repr>"}` placeholder:
//!
//! - `intrinsic_anytime_scheduler_trace`/`focused_complete_reconstruction_trace`
//!   -- `result::mod`'s own [`crate::result::IntrinsicAnytimeSchedulerTrace`]/
//!   [`crate::result::IntrinsicFocusedCompleteReconstructionTrace`] now
//!   derive `Serialize` directly (camelCase, `skip_serializing_if` on every
//!   `| undefined` TS field), with every nested string-literal enum given a
//!   hand-written `Serialize` delegating to its own `as_str()` -- these two
//!   traces carry no `BigInt` fields, so no custom numeric encoding is
//!   needed.
//! - `intrinsic_short_side_observer_trace`/`intrinsic_short_side_pair_fold_trace`
//!   -- reused, not re-derived: `short_side::observer`/`short_side::pair_fold`
//!   already build each trace's exact TS object-literal shape (verified
//!   field names and insertion order) as a [`crate::short_side::json::ShortSideJsonValue`]
//!   for their own `JSON.stringify` self-measurement
//!   (`serializedTraceBytes`); [`crate::short_side::json::to_serde_json`]
//!   converts that already-correct value tree into the wire
//!   [`serde_json::Value`] directly, so this cluster's wire shape can never
//!   drift from its own byte-measurement shape.
//! - `capacity_trace` -- every nested type in this tower
//!   (`capacity::{preflight,endpoint,search,mode}`,
//!   `canonical_grid::layout::{CanonicalLayoutTopology,CanonicalLayoutTopologyExact}`)
//!   now derives (or hand-implements, for the `IntrinsicCapacityPreflightOutcome`
//!   discriminated union and every kebab-case string-literal enum) `Serialize`
//!   directly on the domain struct itself, camelCase, with
//!   `#[serde(serialize_with = "capacity::serialize_bigint_decimal_string")]`
//!   on every real `num_bigint::BigInt` field (`placedDoubledMaterialAreaGrid2`
//!   and the four `IntrinsicCapacityPreflightMeasurements` pressure/area
//!   fields) -- see that function's own doc comment for the decimal-string
//!   wire contract the TS adapter (`nativeIrregularBackend.ts`) reconstructs
//!   as `BigInt(<string>)`.
//!
//! Every one of these Serialize impls was written against the real TS field
//! names/literal strings in `computeIrregularNesting.ts`/
//! `intrinsicCapacityMode.ts`/`intrinsicCapacitySearch.ts`/
//! `intrinsicCapacityPreflight.ts`/`intrinsicCapacityEndpoint.ts`/
//! `intrinsicShortSideObserver.ts`/`intrinsicShortSidePairFoldObserver.ts`
//! (read directly, not guessed), with **field order deliberately not**
//! required to match TS's own key-insertion order except for the two Short
//! Side traces (reused verbatim from their own byte-measurement shape) --
//! JSON object key order carries no semantics for the TS adapter's plain
//! property-access reconstruction, so only field *names*/*presence*/*types*
//! are asserted below and by the differential harness's field-for-field
//! comparison.
//!
//! # Non-semantic timing/byte-count fields
//!
//! Every `*RuntimeMs`/`*Ms`/`elapsedMs`/`serializedTraceBytes`/
//! `peakRssDeltaBytes` field across these five traces is a wall-clock or
//! wall-clock-derived measurement (the differential harness's
//! `TIMING_ONLY_TRACE_FIELD_NAMES` list enumerates every one by name) --
//! real, present on the wire exactly like every other field, but compared
//! presence-only (never by value) between the two backends, since the two
//! processes' wall-clock measurements are never expected to agree bit-for-bit.

use std::sync::Arc;

use serde::Serialize;

use crate::domain::{
    CollisionGeometryDiagnostic, IrregularLayoutScoreSummary, IrregularPlacedPiece,
    IrregularPreparedPiece, PieceId,
};
use crate::result::{
    IrregularComputeResult, IrregularPortfolioPhase, IrregularPortfolioProgress,
    IrregularPortfolioResult, IrregularPortfolioStatus, IrregularPortfolioTerminationReason,
    IrregularSearchSource, IrregularStateSnapshot, IrregularStateSnapshotSource,
};
use crate::search::layout_scorer::IrregularLayoutScore;

// ===========================================================================
// Full internal score (`native-boundary.md` §8.2: the full object, not the
// summary -- `occupied_hull_waste_ratio` must stay present).
// ===========================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIrregularLayoutScore {
    pub unplaced_count: f64,
    pub shared_collision_boundary_length_mm: f64,
    pub shared_collision_boundary_contact_units: f64,
    pub shared_collision_boundary_contact_band: f64,
    pub near_complete_structural_contact_count: f64,
    pub dominant_near_complete_structural_contact_count: f64,
    pub largest_net_free_material_region_area_mm2: f64,
    pub free_material_region_count: f64,
    pub free_material_hole_count: f64,
    pub free_material_sliver_metric: f64,
    pub collision_bounds_worst_normalized_sheet_consumption: f64,
    pub collision_bounds_normalized_span_sum: f64,
    pub collision_bounds_area_mm2: f64,
    pub collision_bounds_span_mm: f64,
    pub occupied_hull_waste_ratio: f64,
    pub collision_bounds_bottom_mm: f64,
    pub collision_bounds_left_mm: f64,
    pub free_material_snapshot: crate::domain::FreeMaterialSnapshot,
    pub placement_order: Vec<PieceId>,
    pub unplaced_source_piece_ids: Vec<PieceId>,
}

impl From<&IrregularLayoutScore> for NativeIrregularLayoutScore {
    fn from(score: &IrregularLayoutScore) -> Self {
        NativeIrregularLayoutScore {
            unplaced_count: score.unplaced_count,
            shared_collision_boundary_length_mm: score.shared_collision_boundary_length_mm,
            shared_collision_boundary_contact_units: score.shared_collision_boundary_contact_units,
            shared_collision_boundary_contact_band: score.shared_collision_boundary_contact_band,
            near_complete_structural_contact_count: score.near_complete_structural_contact_count,
            dominant_near_complete_structural_contact_count: score
                .dominant_near_complete_structural_contact_count,
            largest_net_free_material_region_area_mm2: score
                .largest_net_free_material_region_area_mm2,
            free_material_region_count: score.free_material_region_count,
            free_material_hole_count: score.free_material_hole_count,
            free_material_sliver_metric: score.free_material_sliver_metric,
            collision_bounds_worst_normalized_sheet_consumption: score
                .collision_bounds_worst_normalized_sheet_consumption,
            collision_bounds_normalized_span_sum: score.collision_bounds_normalized_span_sum,
            collision_bounds_area_mm2: score.collision_bounds_area_mm2,
            collision_bounds_span_mm: score.collision_bounds_span_mm,
            occupied_hull_waste_ratio: score.occupied_hull_waste_ratio,
            collision_bounds_bottom_mm: score.collision_bounds_bottom_mm,
            collision_bounds_left_mm: score.collision_bounds_left_mm,
            free_material_snapshot: score.free_material_snapshot.clone(),
            placement_order: score.placement_order.clone(),
            unplaced_source_piece_ids: score.unplaced_source_piece_ids.clone(),
        }
    }
}

// ===========================================================================
// Portfolio result/progress -- hand-mapped string literals (see module doc).
// ===========================================================================

/// TS: `domain.ts:105-110` `IrregularPortfolioStatus`. This ported cluster's
/// archive path only ever constructs `'completed'`
/// (`result::IrregularPortfolioStatus`'s own doc comment); the other two
/// Rust placeholder variants (`Partial`/`Failed`) exist only for
/// exhaustiveness and are never actually reachable here, so their wire
/// string is chosen for plausibility, not verified against a real call
/// site -- update this mapping if a future change makes them reachable.
fn project_portfolio_status(status: IrregularPortfolioStatus) -> &'static str {
    match status {
        IrregularPortfolioStatus::Completed => "completed",
        IrregularPortfolioStatus::Partial => "budget-expired",
        IrregularPortfolioStatus::Failed => "no-valid-result",
    }
}

/// TS: `domain.ts:116-125` `IrregularPortfolioTerminationReason`. Both
/// variants below are verified against a real
/// `coordinateIntrinsicSharedArchive` construction site (see
/// `result::IrregularPortfolioTerminationReason`'s own doc comment).
fn project_termination_reason(reason: IrregularPortfolioTerminationReason) -> &'static str {
    match reason {
        IrregularPortfolioTerminationReason::CapacitySubsetSettled => "capacity_subset_settled",
        IrregularPortfolioTerminationReason::SharedArchiveCompleted => "shared_archive_completed",
    }
}

/// TS: `domain.ts:39` `IrregularSearchSource`. This ported cluster's archive
/// path only ever constructs `'shared-archive'`.
fn project_search_source(source: IrregularSearchSource) -> &'static str {
    match source {
        IrregularSearchSource::SharedArchive => "shared-archive",
    }
}

/// TS: `domain.ts:24-33` `IrregularPortfolioPhase`. Every variant below is
/// verified against `emitSharedArchiveProgress`'s three real construction
/// sites (`result::IrregularPortfolioPhase`'s own doc comment).
fn project_portfolio_phase(phase: IrregularPortfolioPhase) -> &'static str {
    match phase {
        IrregularPortfolioPhase::SharedArchive => "shared_archive",
        IrregularPortfolioPhase::ShortSideProfile => "short_side_profile",
        IrregularPortfolioPhase::Completed => "completed",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIrregularPortfolioResult {
    pub status: &'static str,
    pub termination_reason: &'static str,
    pub source: &'static str,
    pub placements: Vec<crate::domain::IrregularPlacement>,
    pub unplaced_piece_ids: Vec<PieceId>,
    pub score: IrregularLayoutScoreSummary,
    pub diagnostics: Vec<CollisionGeometryDiagnostic>,
}

impl From<&IrregularPortfolioResult> for NativeIrregularPortfolioResult {
    fn from(portfolio: &IrregularPortfolioResult) -> Self {
        NativeIrregularPortfolioResult {
            status: project_portfolio_status(portfolio.status),
            termination_reason: project_termination_reason(portfolio.termination_reason),
            source: project_search_source(portfolio.source),
            placements: portfolio.placements.clone(),
            unplaced_piece_ids: portfolio.unplaced_piece_ids.clone(),
            score: portfolio.score.clone(),
            diagnostics: portfolio.diagnostics.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIrregularPortfolioProgress {
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub best_score: Option<IrregularLayoutScoreSummary>,
    pub elapsed_ms: f64,
}

impl From<&IrregularPortfolioProgress> for NativeIrregularPortfolioProgress {
    fn from(progress: &IrregularPortfolioProgress) -> Self {
        NativeIrregularPortfolioProgress {
            phase: project_portfolio_phase(progress.phase),
            best_score: progress.best_score.clone(),
            elapsed_ms: progress.elapsed_ms,
        }
    }
}

// ===========================================================================
// State snapshots. Simplified relative to native-boundary.md §10.2's full
// "already-assembled history-frame record" design (title/strategyLabel/
// beamWidthForFrame/createdAt remain TypeScript adapter concerns). This DTO
// carries the complete beam-state data needed to reconstruct exact history
// frames, including each full remaining prepared piece. Stream ordinals are
// owned solely by `boundary::events` and are never retained result data.
// ===========================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStateSnapshot {
    pub step_index: f64,
    pub beam_rank: f64,
    pub candidate_count: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    pub placements: Vec<Arc<IrregularPlacedPiece>>,
    pub remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>>,
    pub unplaced_piece_ids: Vec<PieceId>,
}

pub fn project_state_snapshot(snapshot: &IrregularStateSnapshot) -> NativeStateSnapshot {
    NativeStateSnapshot {
        step_index: snapshot.step_index,
        beam_rank: snapshot.beam_rank,
        candidate_count: snapshot.candidate_count,
        source: snapshot.source.map(|source| match source {
            IrregularStateSnapshotSource::Beam => "beam",
            IrregularStateSnapshotSource::SharedArchive => "shared-archive",
        }),
        placements: snapshot.state.placed_collision_geometries.clone(),
        remaining_prepared_pieces: snapshot.state.remaining_prepared_pieces.clone(),
        unplaced_piece_ids: snapshot.state.unplaced_piece_ids.clone(),
    }
}

// ===========================================================================
// The five trace fields (see module doc). `capacity_trace`/
// `intrinsic_anytime_scheduler_trace`/`focused_complete_reconstruction_trace`
// carry their own real, `Serialize`-deriving trace type directly (cloned;
// each is a `capacity::mode`/`result::mod`-owned struct verified against the
// real TS field names). The two Short Side traces go through
// `short_side::json::to_serde_json` over each trace's own already-correct
// `ShortSideJsonValue` shape (see module doc).
// ===========================================================================

// ===========================================================================
// The full result.
// ===========================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIrregularComputeResult {
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub score: NativeIrregularLayoutScore,
    pub unplaced_piece_ids: Vec<PieceId>,
    pub diagnostics: Vec<CollisionGeometryDiagnostic>,
    pub sorted_piece_ids: Vec<PieceId>,
    pub state_snapshots: Vec<NativeStateSnapshot>,
    pub beam_width: f64,
    pub portfolio: NativeIrregularPortfolioResult,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity_trace: Option<crate::capacity::mode::IntrinsicCapacityTrace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intrinsic_anytime_scheduler_trace: Option<crate::result::IntrinsicAnytimeSchedulerTrace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_complete_reconstruction_trace:
        Option<crate::result::IntrinsicFocusedCompleteReconstructionTrace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intrinsic_short_side_observer_trace: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intrinsic_short_side_pair_fold_trace: Option<serde_json::Value>,
}

pub fn project_result(result: &IrregularComputeResult) -> NativeIrregularComputeResult {
    let state_snapshots = result
        .state_snapshots
        .iter()
        .map(project_state_snapshot)
        .collect();

    NativeIrregularComputeResult {
        placed_collision_geometries: result.placed_collision_geometries.clone(),
        score: NativeIrregularLayoutScore::from(&result.score),
        unplaced_piece_ids: result.unplaced_piece_ids.clone(),
        diagnostics: result.diagnostics.clone(),
        sorted_piece_ids: result.sorted_piece_ids.clone(),
        state_snapshots,
        beam_width: result.beam_width,
        portfolio: NativeIrregularPortfolioResult::from(&result.portfolio),
        capacity_trace: result.capacity_trace.clone(),
        intrinsic_anytime_scheduler_trace: result.intrinsic_anytime_scheduler_trace.clone(),
        focused_complete_reconstruction_trace: result.focused_complete_reconstruction_trace.clone(),
        intrinsic_short_side_observer_trace: result
            .intrinsic_short_side_observer_trace
            .as_ref()
            .map(|trace| crate::short_side::json::to_serde_json(&trace.to_json())),
        intrinsic_short_side_pair_fold_trace: result
            .intrinsic_short_side_pair_fold_trace
            .as_ref()
            .map(|trace| crate::short_side::json::to_serde_json(&trace.to_json())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portfolio_status_maps_completed_to_the_real_ts_literal() {
        assert_eq!(
            project_portfolio_status(IrregularPortfolioStatus::Completed),
            "completed"
        );
    }

    #[test]
    fn termination_reason_maps_both_reachable_variants() {
        assert_eq!(
            project_termination_reason(IrregularPortfolioTerminationReason::CapacitySubsetSettled),
            "capacity_subset_settled"
        );
        assert_eq!(
            project_termination_reason(IrregularPortfolioTerminationReason::SharedArchiveCompleted),
            "shared_archive_completed"
        );
    }

    #[test]
    fn search_source_maps_to_kebab_case() {
        assert_eq!(
            project_search_source(IrregularSearchSource::SharedArchive),
            "shared-archive"
        );
    }

    #[test]
    fn portfolio_phase_maps_every_variant() {
        assert_eq!(
            project_portfolio_phase(IrregularPortfolioPhase::SharedArchive),
            "shared_archive"
        );
        assert_eq!(
            project_portfolio_phase(IrregularPortfolioPhase::ShortSideProfile),
            "short_side_profile"
        );
        assert_eq!(
            project_portfolio_phase(IrregularPortfolioPhase::Completed),
            "completed"
        );
    }

    // =======================================================================
    // Five trace fields: field-for-field wire shape.
    // =======================================================================

    #[test]
    fn anytime_scheduler_trace_is_camel_case_and_omits_absent_cancellation_reason() {
        use crate::result::{
            IntrinsicAnytimeSchedulerCohort, IntrinsicAnytimeSchedulerColdStartStatus,
            IntrinsicAnytimeSchedulerOutcome, IntrinsicAnytimeSchedulerProducerRole,
            IntrinsicAnytimeSchedulerQuantum, IntrinsicAnytimeSchedulerTrace,
        };
        let trace = IntrinsicAnytimeSchedulerTrace {
            version: "intrinsic-anytime-scheduler-v1",
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
        let json = serde_json::to_value(&trace).unwrap();
        assert_eq!(json["coldStartStatus"], serde_json::json!("settled"));
        assert_eq!(
            json["quanta"][0]["producerRole"],
            serde_json::json!("capacity-cold")
        );
        assert_eq!(json["quanta"][1]["outcome"], serde_json::json!("settled"));
        assert!(json.get("cancellationReason").is_none());
    }

    #[test]
    fn focused_complete_reconstruction_trace_omits_undefined_hash_fields() {
        use crate::result::{
            IntrinsicFocusedCompleteReconstructionOutputInfluence,
            IntrinsicFocusedCompleteReconstructionStatus,
            IntrinsicFocusedCompleteReconstructionTrace,
        };
        let trace = IntrinsicFocusedCompleteReconstructionTrace {
            version: "intrinsic-focused-complete-reconstruction-v1",
            status: IntrinsicFocusedCompleteReconstructionStatus::SkippedPreflightProvenImpossible,
            source_canonical_geometry_hash: None,
            candidate_canonical_geometry_hash: None,
            selected_canonical_geometry_hash: None,
            consumed_candidate_evaluations: 0.0,
            candidate_evaluation_accounting_complete: true,
            runtime_ms: 0.0,
            output_influence: IntrinsicFocusedCompleteReconstructionOutputInfluence::None,
            failure_reason: None,
        };
        let json = serde_json::to_value(&trace).unwrap();
        assert_eq!(
            json["status"],
            serde_json::json!("skipped-preflight-proven-impossible")
        );
        assert_eq!(json["outputInfluence"], serde_json::json!("none"));
        assert!(json.get("sourceCanonicalGeometryHash").is_none());
        assert!(json.get("failureReason").is_none());
    }

    #[test]
    fn capacity_trace_encodes_bigint_fields_as_decimal_strings_and_flattens_selected() {
        use crate::capacity::endpoint::{
            IntrinsicCapacityEndpointOrigin, IntrinsicCapacityObjective,
        };
        use crate::capacity::mode::{
            IntrinsicCapacityPrefixTrace, IntrinsicCapacityRouting,
            IntrinsicCapacitySelectionTrace, IntrinsicCapacityTrace,
        };
        use crate::capacity::preflight::{
            IntrinsicCapacityPreflightMeasurements, IntrinsicCapacityPreflightOutcome,
            IntrinsicCapacityProvenImpossibleReason,
        };
        use crate::capacity::search::{IntrinsicCapacitySearchTrace, IntrinsicCapacitySettlement};
        use crate::domain::PieceId;
        use num_bigint::BigInt;

        let objective = IntrinsicCapacityObjective {
            placed_count: 2.0,
            placed_doubled_material_area_grid2: BigInt::from(123_456_789_012_345_i64),
            enclosed_cavity_count: 0.0,
            total_enclosed_cavity_area_mm2: 0.0,
            total_enclosed_cavity_doubled_area_grid2: "0".to_string(),
            envelope_maximum_side_mm: 100.0,
            envelope_area_mm2: 200.0,
            envelope_span_mm: 100.0,
            envelope_maximum_side_grid: 1000.0,
            envelope_area_grid2: "2000".to_string(),
            envelope_span_grid: 1000.0,
            canonical_geometry_hash: "abc".to_string(),
            origin: IntrinsicCapacityEndpointOrigin::ColdSearch,
            prefix_depth: None,
            source_role: None,
        };
        let trace = IntrinsicCapacityTrace {
            routing: IntrinsicCapacityRouting::BoundedCompleteArchiveMiss,
            preflight: IntrinsicCapacityPreflightOutcome::ProvenImpossible {
                reason: IntrinsicCapacityProvenImpossibleReason::SingletonTransformSetDoesNotFit {
                    piece_id: PieceId::new("p1".to_string()),
                },
                measurements: IntrinsicCapacityPreflightMeasurements {
                    piece_count: 1.0,
                    sheet_width_grid: 10.0,
                    sheet_height_grid: 10.0,
                    sheet_doubled_area_grid2: BigInt::from(200),
                    minimum_doubled_collision_area_sum_grid2: BigInt::from(50),
                    minimum_collision_area_pressure_ppm: BigInt::from(1),
                    maximum_singleton_span_pressure_ppm: BigInt::from(2),
                    singleton_infeasible_piece_ids: vec![PieceId::new("p1".to_string())],
                },
            },
            prefixes: IntrinsicCapacityPrefixTrace {
                captured_count: 0.0,
                fitting_count: 0.0,
                rejected_count: 0.0,
                terminalized_count: 0.0,
                descriptors: vec![],
            },
            prefix_incumbent: None,
            cold_search: IntrinsicCapacitySearchTrace {
                beam_width: 16.0,
                local_legal_placement_fanout: 3.0,
                placement_evaluation_cap: 50_000.0,
                placement_evaluation_quota_per_depth: 4_096.0,
                consumed_placement_evaluations: 0.0,
                auxiliary_placement_evaluations: 0.0,
                pruned_by_attainable_count: 0.0,
                pruned_by_attainable_material: 0.0,
                deduplicated_successors: 0.0,
                fit_rejected_candidates: 0.0,
                invalid_candidates: 0.0,
                endpoint_fit_rejections: 0.0,
                completed_depths: 0.0,
                depth_quota_exhaustions: 0.0,
                piece_count: 1.0,
                settlement: IntrinsicCapacitySettlement::Exhausted,
                topology_retention_depths: None,
            },
            warm_prefix_lanes: None,
            warm_prefix_endpoints_admitted: false,
            cohesion_shadow: None,
            quality_warm_prefix: None,
            lane_coordinator: None,
            selected: IntrinsicCapacitySelectionTrace {
                objective: objective.clone(),
                unplaced_count: 0.0,
                placed_material_area_mm2: 500.0,
                selected_rotation_deg: 0.0,
            },
            preflight_runtime_ms: None,
            complete_archive_runtime_ms: None,
            prefix_terminalization_ms: 0.0,
            cold_search_ms: 0.0,
            runtime_ms: 0.0,
        };

        let json = serde_json::to_value(&trace).unwrap();
        assert_eq!(
            json["routing"],
            serde_json::json!("bounded-complete-archive-miss")
        );
        assert_eq!(
            json["preflight"]["kind"],
            serde_json::json!("proven_impossible")
        );
        assert_eq!(
            json["preflight"]["reason"],
            serde_json::json!("singleton-transform-set-does-not-fit")
        );
        assert_eq!(json["preflight"]["pieceId"], serde_json::json!("p1"));
        assert_eq!(
            json["preflight"]["measurements"]["sheetDoubledAreaGrid2"],
            serde_json::json!("200")
        );
        // Flattened `selected`: objective fields live at the top level, not
        // nested under an `objective` key, mirroring TS's real spread shape.
        assert_eq!(
            json["selected"]["placedDoubledMaterialAreaGrid2"],
            serde_json::json!("123456789012345")
        );
        assert_eq!(json["selected"]["unplacedCount"], serde_json::json!(0.0));
        assert!(json["selected"].get("objective").is_none());
        // Absent optionals omitted, never null.
        assert!(json.get("prefixIncumbent").is_none());
        assert!(json.get("warmPrefixLanes").is_none());
        assert!(json.get("preflightRuntimeMs").is_none());
    }

    #[test]
    fn short_side_observer_trace_reuses_its_own_to_json_shape() {
        use crate::short_side::axes::ShortSideAxisDimension;
        use crate::short_side::observer::{
            IntrinsicShortSideObserverStatus, IntrinsicShortSideObserverTrace,
            ShortSideOutputInfluence,
        };
        let trace = IntrinsicShortSideObserverTrace {
            version: "intrinsic-short-side-observer-v6",
            status: IntrinsicShortSideObserverStatus::SkippedNoSettledCompleteEndpoints,
            output_influence: ShortSideOutputInfluence::None,
            requested_sheet_width_mm: 2000.0,
            requested_sheet_height_mm: 2700.0,
            requested_long_axis_mm: 2700.0,
            requested_short_axis_mm: 2000.0,
            requested_long_axis: ShortSideAxisDimension::Height,
            production_short_axis_span_mm: None,
            production_maximum_side_mm: None,
            production_envelope_area_mm2: None,
            production_short_axis_span_grid: None,
            production_maximum_side_grid: None,
            production_envelope_area_grid2: None,
            settled_endpoint_count: 0.0,
            evaluated_orientation_count: 0.0,
            cavity_hull_guard_eligible_endpoint_count: 0.0,
            geometric_pareto_eligible_endpoint_count: 0.0,
            placement_evaluations: 0.0,
            candidate_evaluations: 0.0,
            runtime_ms: 0.0,
            runtime_budget_exceeded: false,
            serialized_trace_bytes: 0.0,
            endpoints: vec![],
            ranked_canonical_geometry_hashes: vec![],
            directional_admission_terms: None,
            observer_winner_canonical_geometry_hash: None,
            observer_winner_rotation_deg: None,
        };
        let json = crate::short_side::json::to_serde_json(&trace.to_json());
        assert_eq!(
            json["status"],
            serde_json::json!("skipped-no-settled-complete-endpoints")
        );
        assert_eq!(json["requestedLongAxis"], serde_json::json!("height"));
        assert!(json.get("productionShortAxisSpanMm").is_none());
        assert_eq!(json["endpoints"], serde_json::json!([]));
    }
}
