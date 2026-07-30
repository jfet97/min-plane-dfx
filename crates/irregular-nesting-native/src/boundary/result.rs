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
//! # Deferred: five optional trace fields' internal field shape
//!
//! `capacity_trace`, `intrinsic_anytime_scheduler_trace`,
//! `focused_complete_reconstruction_trace`,
//! `intrinsic_short_side_observer_trace`, and
//! `intrinsic_short_side_pair_fold_trace` are each present/absent on the
//! wire with **exact** parity to `native-boundary.md` §8.1's presence table
//! (verified against `result::coordinator`'s own control flow, not
//! guessed) -- but internally, each present trace serializes as an opaque
//! `{"raw": "<Rust Debug repr>"}` object rather than the full field-for-field
//! projection native-boundary.md's design sketches. Reproducing every one of
//! those five traces' nested field names against their *exact* TS wire
//! spelling (many nested enums, several `BigInt`-valued fields requiring a
//! custom decimal-string encoding) is exactly the "TS-to-Rust semantic
//! mapping table" work `native-boundary.md` §17 itself defers to a separate
//! deliverable, not something this document's own design fixes. Getting a
//! presence/absence bit right but a nested field's wire spelling silently
//! wrong would be a worse outcome than an honestly-opaque placeholder;
//! narrowing the scope here rather than guessing is the same seam-with-a-doc-
//! comment convention this crate already uses elsewhere (see
//! `capacity::prefixes`'s `IntrinsicSharedArchiveDirectRole` copy,
//! `archive::shared`'s periodic-family-portfolio seam, both cited in this
//! crate's own known-TODO list). Follow-up: port each trace's field-for-field
//! `Serialize` mirror the same way `domain::*`/`search::layout_scorer` did,
//! verifying every nested literal string against `computeIrregularNesting.ts`/
//! `intrinsicCapacityMode.ts`/`intrinsicShortSideObserver.ts` source directly.

use std::sync::Arc;

use serde::Serialize;

use crate::domain::{
    CollisionGeometryDiagnostic, IrregularLayoutScoreSummary, IrregularPlacedPiece, PieceId,
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
// beamWidthForFrame/createdAt require porting `makeIrregularHistoryFrame`/
// `irregularStrategyRunId`, `irregularWorkerOutput.ts:30-82`, a separate,
// not-yet-ported unit) -- this DTO carries the real, exact placements/
// unplaced-ids/step/rank/source data every consumer of a snapshot actually
// needs to reconstruct or forward a frame, plus the ordinal every streamed
// event on this boundary carries.
// ===========================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStateSnapshot {
    pub ordinal: u64,
    pub step_index: f64,
    pub beam_rank: f64,
    pub candidate_count: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    pub placements: Vec<Arc<IrregularPlacedPiece>>,
    pub unplaced_piece_ids: Vec<PieceId>,
}

pub fn project_state_snapshot(
    snapshot: &IrregularStateSnapshot,
    ordinal: u64,
) -> NativeStateSnapshot {
    NativeStateSnapshot {
        ordinal,
        step_index: snapshot.step_index,
        beam_rank: snapshot.beam_rank,
        candidate_count: snapshot.candidate_count,
        source: snapshot.source.map(|source| match source {
            IrregularStateSnapshotSource::Beam => "beam",
            IrregularStateSnapshotSource::SharedArchive => "shared-archive",
        }),
        placements: snapshot.state.placed_collision_geometries.clone(),
        unplaced_piece_ids: snapshot.state.unplaced_piece_ids.clone(),
    }
}

// ===========================================================================
// Opaque trace projection (see module doc, "Deferred").
// ===========================================================================

fn project_opaque_trace<T: std::fmt::Debug>(trace: &T) -> serde_json::Value {
    serde_json::json!({ "raw": format!("{trace:?}") })
}

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
    pub capacity_trace: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intrinsic_anytime_scheduler_trace: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_complete_reconstruction_trace: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intrinsic_short_side_observer_trace: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intrinsic_short_side_pair_fold_trace: Option<serde_json::Value>,
}

pub fn project_result(result: &IrregularComputeResult) -> NativeIrregularComputeResult {
    let state_snapshots = result
        .state_snapshots
        .iter()
        .enumerate()
        .map(|(ordinal, snapshot)| project_state_snapshot(snapshot, ordinal as u64))
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
        capacity_trace: result.capacity_trace.as_ref().map(project_opaque_trace),
        intrinsic_anytime_scheduler_trace: result
            .intrinsic_anytime_scheduler_trace
            .as_ref()
            .map(project_opaque_trace),
        focused_complete_reconstruction_trace: result
            .focused_complete_reconstruction_trace
            .as_ref()
            .map(project_opaque_trace),
        intrinsic_short_side_observer_trace: result
            .intrinsic_short_side_observer_trace
            .as_ref()
            .map(project_opaque_trace),
        intrinsic_short_side_pair_fold_trace: result
            .intrinsic_short_side_pair_fold_trace
            .as_ref()
            .map(project_opaque_trace),
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

    #[test]
    fn opaque_trace_projection_carries_a_raw_debug_string() {
        #[derive(Debug)]
        #[allow(dead_code)]
        struct Sample {
            value: u32,
        }
        let projected = project_opaque_trace(&Sample { value: 7 });
        assert!(projected["raw"].as_str().unwrap().contains('7'));
    }
}
