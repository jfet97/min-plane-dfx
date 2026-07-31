//! Materializes one settled archive/capacity/Short-Side endpoint into the
//! common `IrregularComputeResult` shape, plus the small pure helpers
//! (`layoutScoreSummary`, the contact-metric preservation functions, portfolio
//! placement transform resolution) `computeIrregularNesting.ts`'s
//! materialization call sites all share.
//!
//! TS source: `computeIrregularNesting.ts:1469-1580` (`MaterializedDecode`,
//! `materializeSharedArchiveResult`),`:1582-1656`
//! (`materializeIntrinsicShortSideProfileResult`), `:1699-1798`
//! (`layoutScoreSummary`/`layoutScoreSummaryFields`/`sharedArchiveDiagnostic`/
//! `intrinsicShortSideProfileDiagnostic`/`preservePortfolioContactMetrics`/
//! `preserveSharedArchiveExactMetrics`), `:1868-1904`
//! (`resolvePortfolioPlacementTransform`/`isQuarterTurnEquivalent`/
//! `normalizeRotationDegrees`). `materializeIntrinsicCapacityResult`
//! (`:1254-1321`) is ported as `result::coordinator::materialize_capacity_result`
//! instead of living in this file (it needs the `capacity::mode`
//! orchestration `coordinator` already owns calling directly -- see that
//! module's own top doc, "Resolved: `capacity::mode`'s top-level
//! orchestration"). `materializeProductionResult`/`reconstructPlacedGeometry`
//! (the legacy non-archive path) are **not** ported anywhere -- out of this
//! migration's scope per `result::mod`'s top doc.

use std::sync::Arc;

use crate::domain::{
    CollisionGeometryDiagnostic, IrregularLayoutScoreSummary, IrregularPlacedPiece, PieceId,
};
use crate::search::beam_state::IrregularBeamState;
use crate::search::layout_scorer::{
    IrregularCollisionBounds, IrregularLayoutScore, LayoutScorerBeamStateView,
};

use super::progress::selected_layout_reveal_snapshots;
use super::{
    HistoryMode, IrregularFinalizationMetrics, IrregularPortfolioResult, IrregularPortfolioStatus,
    IrregularPortfolioTerminationReason, IrregularSearchSource, IrregularStateSnapshot,
};

/// Projects a real, fully-derived [`IrregularBeamState`] onto
/// `search::layout_scorer`'s minimal
/// [`LayoutScorerBeamStateView`] seam type.
///
/// TS constructs `new IrregularBeamState({...})` (a raw flat construction,
/// no `derivedMetadata` symbol key) at every one of this cluster's
/// materialization call sites, which triggers `deriveMetadata()` to compute
/// `translatedCollisionBounds`/`sharedCollisionBoundaryLengthMm`/
/// `canonicalOccupiedGeometryKey`/etc. from the flat `placedCollisionGeometries`
/// array before the state is ever passed to `layoutScorer.scoreState` --
/// `scoreDerivedState` (`irregularLayoutScorer.ts:224-326`) reads those
/// derived fields directly and fails closed
/// (`IrregularLayoutScoringError`, `"placed collision polygons must
/// produce finite bounds."`) if they are absent. This helper reproduces
/// that same "construct the real state, then read its already-derived
/// fields" flow -- callers must never hand-build a
/// [`LayoutScorerBeamStateView`] with placeholder `None`s for these fields.
pub fn layout_scorer_view(state: &IrregularBeamState) -> LayoutScorerBeamStateView {
    LayoutScorerBeamStateView {
        placed_collision_geometries: state.placed_collision_geometries.clone(),
        translated_collision_bounds: state.translated_collision_bounds.map(|bounds| {
            IrregularCollisionBounds {
                min_x: bounds.min_x,
                min_y: bounds.min_y,
                max_x: bounds.max_x,
                max_y: bounds.max_y,
                width: bounds.width,
                height: bounds.height,
            }
        }),
        shared_collision_boundary_length_mm: state.shared_collision_boundary_length_mm,
        shared_collision_boundary_contact_units: state.shared_collision_boundary_contact_units,
        near_complete_structural_contact_count: state.near_complete_structural_contact_count,
        dominant_near_complete_structural_contact_count: state
            .dominant_near_complete_structural_contact_count,
        canonical_occupied_geometry_key: state.canonical_occupied_geometry_key.clone(),
        placement_order: state.placement_order.clone(),
        unplaced_source_piece_ids: state.unplaced_source_piece_ids.clone(),
        // TS threads no explicit parent chain into any of these raw
        // constructions either (a brand-new `IrregularBeamState` here has
        // no TS-side `parent` reference to project); omitting it only
        // forgoes `computeSnapshotWithParentFallback`'s incremental
        // free-material reuse optimization, never changes the computed
        // score.
        parent: None,
    }
}

/// TS: `computeIrregularNesting.ts:1469-1471` `MaterializedDecode`
/// (`IrregularComputeResult & {finalizationMetrics}`, restricted to the
/// fields the archive-eligible path ever populates -- `capacityTrace`
/// belongs to the not-yet-ported capacity-mode branch and is threaded in by
/// `coordinator`, not here).
/// No `PartialEq`: carries [`IrregularStateSnapshot`], which does not derive
/// it.
#[derive(Clone, Debug)]
pub struct MaterializedDecode {
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub score: IrregularLayoutScore,
    pub unplaced_piece_ids: Vec<PieceId>,
    pub diagnostics: Vec<CollisionGeometryDiagnostic>,
    pub sorted_piece_ids: Vec<PieceId>,
    pub state_snapshots: Vec<IrregularStateSnapshot>,
    pub beam_width: f64,
    pub portfolio: IrregularPortfolioResult,
    pub finalization_metrics: IrregularFinalizationMetrics,
}

// ===========================================================================
// `layoutScoreSummary`/`layoutScoreSummaryFields`
// (`computeIrregularNesting.ts:1699-1727`).
// ===========================================================================

/// TS: `computeIrregularNesting.ts:1709-1727` `layoutScoreSummaryFields`.
pub fn layout_score_summary_fields(score: &IrregularLayoutScore) -> IrregularLayoutScoreSummary {
    IrregularLayoutScoreSummary {
        unplaced_count: score.unplaced_count,
        shared_collision_boundary_length_mm: Some(score.shared_collision_boundary_length_mm),
        shared_collision_boundary_contact_units: Some(
            score.shared_collision_boundary_contact_units,
        ),
        shared_collision_boundary_contact_band: Some(score.shared_collision_boundary_contact_band),
        near_complete_structural_contact_count: Some(score.near_complete_structural_contact_count),
        dominant_near_complete_structural_contact_count: Some(
            score.dominant_near_complete_structural_contact_count,
        ),
        largest_net_free_material_region_area_mm2: score.largest_net_free_material_region_area_mm2,
        free_material_region_count: score.free_material_region_count,
        free_material_hole_count: score.free_material_hole_count,
        canonical_enclosed_cavity_count: None,
        free_material_sliver_metric: score.free_material_sliver_metric,
        collision_bounds_worst_normalized_sheet_consumption: score
            .collision_bounds_worst_normalized_sheet_consumption,
        collision_bounds_normalized_span_sum: score.collision_bounds_normalized_span_sum,
        collision_bounds_area_mm2: score.collision_bounds_area_mm2,
        collision_bounds_span_mm: score.collision_bounds_span_mm,
    }
}

/// TS: `computeIrregularNesting.ts:1699-1707` `layoutScoreSummary`.
/// `canonical_enclosed_cavity_count` is genuinely omitted (not
/// `Some`-with-a-sentinel) when the caller passes `None`, matching TS's
/// conditional-spread `...(canonicalEnclosedCavityCount === undefined ? {} :
/// {canonicalEnclosedCavityCount})` exactly -- see `worker-coordination.md`
/// §3.4 for why this asymmetry (present on the Compact winner, always absent
/// on the Short-Side materialized result) is intentional, not a gap.
pub fn layout_score_summary(
    score: &IrregularLayoutScore,
    canonical_enclosed_cavity_count: Option<f64>,
) -> IrregularLayoutScoreSummary {
    IrregularLayoutScoreSummary {
        canonical_enclosed_cavity_count,
        ..layout_score_summary_fields(score)
    }
}

/// TS: `computeIrregularNesting.ts:1729-1737` `sharedArchiveDiagnostic`.
pub fn shared_archive_diagnostic(status: &str, message: String) -> CollisionGeometryDiagnostic {
    CollisionGeometryDiagnostic {
        code: format!("intrinsic_shared_archive_{status}"),
        message,
        piece_id: None,
    }
}

/// TS: `computeIrregularNesting.ts:1740-1748` `intrinsicShortSideProfileDiagnostic`.
/// TS's `status` parameter type is the single literal `'selected'`; this
/// port keeps the same "always `selected`" call-site contract as a plain
/// `&str` parameter rather than a one-variant enum, since every real call
/// site already passes the literal string.
pub fn intrinsic_short_side_profile_diagnostic(
    status: &str,
    message: String,
) -> CollisionGeometryDiagnostic {
    CollisionGeometryDiagnostic {
        code: format!("intrinsic_short_side_{status}"),
        message,
        piece_id: None,
    }
}

/// TS: `computeIrregularNesting.ts:1786-1799` `preserveSharedArchiveExactMetrics`.
/// Preserves canonical-grid topology and contact metrics from the selected
/// archive endpoint onto the publicly-reconstructed score.
pub fn preserve_shared_archive_exact_metrics(
    reconstructed: IrregularLayoutScore,
    endpoint: &crate::archive::shared::IntrinsicSharedArchiveEndpoint,
) -> IrregularLayoutScore {
    IrregularLayoutScore {
        shared_collision_boundary_length_mm: endpoint.metrics.shared_boundary_length_mm,
        shared_collision_boundary_contact_units: endpoint.metrics.contact_units,
        shared_collision_boundary_contact_band: endpoint.metrics.contact_units.floor(),
        near_complete_structural_contact_count: endpoint.metrics.total_structural_contacts,
        dominant_near_complete_structural_contact_count: endpoint
            .metrics
            .dominant_structural_contacts,
        occupied_hull_waste_ratio: endpoint.metrics.occupied_hull_waste_ratio,
        ..reconstructed
    }
}

// ===========================================================================
// `materializeSharedArchiveResult` (`computeIrregularNesting.ts:1524-1580`).
// ===========================================================================

/// Everything `materialize_shared_archive_result` needs beyond the endpoint
/// itself, mirroring `IrregularSearchCoordinatorInput`'s fields this
/// function actually reads (`coordinator` owns constructing this from the
/// real `IrregularSearchCoordinatorInput`).
pub struct MaterializeSharedArchiveResultInput<'a> {
    pub sorted_piece_ids: &'a [PieceId],
    pub beam_width: f64,
    pub history_mode: HistoryMode,
    pub prepared_pieces: &'a [Arc<crate::domain::IrregularPreparedPiece>],
    pub sheet: crate::domain::SheetSpec,
}

/// TS: `computeIrregularNesting.ts:1524-1580` `materializeSharedArchiveResult`.
/// `input.options?.onFinalizationMetrics` is never set in production (see
/// `result::mod`'s top doc, "Deliberately not ported"), so this port always
/// takes the `0`/no-timing branch rather than threading a benchmark-only
/// timing hook through the coordinator.
pub fn materialize_shared_archive_result(
    input: &MaterializeSharedArchiveResultInput<'_>,
    endpoint: &crate::archive::shared::IntrinsicSharedArchiveEndpoint,
    settings: &crate::domain::IrregularNestingSettings,
    free_material_cache: &mut crate::search::layout_scorer::FreeMaterialCache,
) -> Result<MaterializedDecode, super::IrregularComputeErrorType> {
    let placed_collision_geometries = endpoint
        .requested_sheet_fit
        .selected_placed_collision_geometries
        .clone();
    let placement_order: Vec<PieceId> = placed_collision_geometries
        .iter()
        .map(placed_piece_id)
        .collect();

    let state =
        IrregularBeamState::from_input(crate::search::beam_state::IrregularBeamStateInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometries: placed_collision_geometries.clone(),
            unplaced_piece_ids: Some(Vec::new()),
            unplaced_source_piece_ids: None,
            placement_order,
            parent: None,
            placed_collision_index: None,
        });
    let reconstructed_score = crate::search::layout_scorer::score_state(
        &crate::search::layout_scorer::ScoreIrregularLayoutInput {
            sheet: input.sheet.clone(),
            state: layout_scorer_view(&state),
        },
        settings,
        free_material_cache,
    )
    .map_err(super::IrregularComputeErrorType::from)?;
    let score = preserve_shared_archive_exact_metrics(reconstructed_score, endpoint);

    let state_snapshots = if input.history_mode == HistoryMode::Off {
        Vec::new()
    } else {
        selected_layout_reveal_snapshots(input.prepared_pieces, &placed_collision_geometries, &[])
    };

    let portfolio = IrregularPortfolioResult {
        status: IrregularPortfolioStatus::Completed,
        termination_reason: IrregularPortfolioTerminationReason::SharedArchiveCompleted,
        source: IrregularSearchSource::SharedArchive,
        placements: placed_collision_geometries
            .iter()
            .map(|placed| placed.placement.clone())
            .collect(),
        unplaced_piece_ids: Vec::new(),
        score: layout_score_summary(&score, Some(endpoint.metrics.enclosed_cavity_count)),
        diagnostics: vec![shared_archive_diagnostic(
            "selected",
            format!(
                "selected exact shared-archive role {} ({})",
                endpoint.role, endpoint.sheetless_canonical_geometry_hash
            ),
        )],
    };

    Ok(MaterializedDecode {
        placed_collision_geometries,
        score,
        unplaced_piece_ids: Vec::new(),
        diagnostics: Vec::new(),
        sorted_piece_ids: input.sorted_piece_ids.to_vec(),
        state_snapshots,
        beam_width: input.beam_width,
        portfolio,
        finalization_metrics: IrregularFinalizationMetrics {
            reconstruction_elapsed_ms: 0.0,
            final_score_elapsed_ms: 0.0,
        },
    })
}

fn placed_piece_id(placed: &Arc<IrregularPlacedPiece>) -> PieceId {
    placed
        .placement
        .piece_id
        .clone()
        .unwrap_or_else(|| placed.placement.source_piece_id.clone())
}

// ===========================================================================
// `materializeIntrinsicShortSideProfileResult`
// (`computeIrregularNesting.ts:1582-1656`).
// ===========================================================================

/// TS: `computeIrregularNesting.ts:1583-1587` input shape.
pub struct MaterializeIntrinsicShortSideProfileResultInput<'a> {
    pub sorted_piece_ids: &'a [PieceId],
    pub beam_width: f64,
    pub history_mode: HistoryMode,
    pub prepared_pieces: &'a [Arc<crate::domain::IrregularPreparedPiece>],
    pub sheet: crate::domain::SheetSpec,
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    /// TS: `'archive-endpoint' | IntrinsicShortSideConstructionKind`.
    pub selection: ShortSideProfileSelection,
    pub canonical_geometry_hash: Option<String>,
}

/// TS: `computeIrregularNesting.ts:1586` selection union.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShortSideProfileSelection {
    ArchiveEndpoint,
    Construction(crate::short_side::pair_fold::IntrinsicShortSideConstructionKind),
}

/// TS: `computeIrregularNesting.ts:1582-1656`
/// `materializeIntrinsicShortSideProfileResult`. Materializes one
/// already-admitted Short Side layout through the normal result path.
pub fn materialize_intrinsic_short_side_profile_result(
    input: MaterializeIntrinsicShortSideProfileResultInput<'_>,
    settings: &crate::domain::IrregularNestingSettings,
    free_material_cache: &mut crate::search::layout_scorer::FreeMaterialCache,
) -> Result<MaterializedDecode, super::IrregularComputeErrorType> {
    let placed_ids: std::collections::HashSet<PieceId> = input
        .placed_collision_geometries
        .iter()
        .map(placed_piece_id)
        .collect();
    let unplaced_piece_ids: Vec<PieceId> = input
        .prepared_pieces
        .iter()
        .map(|piece| {
            piece
                .piece_id
                .clone()
                .unwrap_or_else(|| piece.source.id.clone())
        })
        .filter(|id| !placed_ids.contains(id))
        .collect();

    let placement_order: Vec<PieceId> = input
        .placed_collision_geometries
        .iter()
        .map(placed_piece_id)
        .collect();
    let state =
        IrregularBeamState::from_input(crate::search::beam_state::IrregularBeamStateInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometries: input.placed_collision_geometries.clone(),
            unplaced_piece_ids: Some(unplaced_piece_ids.clone()),
            unplaced_source_piece_ids: None,
            placement_order,
            parent: None,
            placed_collision_index: None,
        });
    let score = crate::search::layout_scorer::score_state(
        &crate::search::layout_scorer::ScoreIrregularLayoutInput {
            sheet: input.sheet,
            state: layout_scorer_view(&state),
        },
        settings,
        free_material_cache,
    )
    .map_err(super::IrregularComputeErrorType::from)?;

    let state_snapshots = if input.history_mode == HistoryMode::Off {
        Vec::new()
    } else {
        selected_layout_reveal_snapshots(
            input.prepared_pieces,
            &input.placed_collision_geometries,
            &unplaced_piece_ids,
        )
    };

    let selection_description = match input.selection {
        ShortSideProfileSelection::ArchiveEndpoint => "settled archive endpoint".to_string(),
        ShortSideProfileSelection::Construction(kind) => {
            format!("terminal {} construction", kind.as_str())
        }
    };
    let hash_suffix = input
        .canonical_geometry_hash
        .as_ref()
        .map(|hash| format!(" ({hash})"))
        .unwrap_or_default();

    let portfolio = IrregularPortfolioResult {
        status: IrregularPortfolioStatus::Completed,
        termination_reason: IrregularPortfolioTerminationReason::SharedArchiveCompleted,
        source: IrregularSearchSource::SharedArchive,
        placements: input
            .placed_collision_geometries
            .iter()
            .map(|placed| placed.placement.clone())
            .collect(),
        unplaced_piece_ids: unplaced_piece_ids.clone(),
        score: layout_score_summary(&score, None),
        diagnostics: vec![intrinsic_short_side_profile_diagnostic(
            "selected",
            format!("selected {selection_description}{hash_suffix}"),
        )],
    };

    Ok(MaterializedDecode {
        placed_collision_geometries: input.placed_collision_geometries,
        score,
        unplaced_piece_ids,
        diagnostics: Vec::new(),
        sorted_piece_ids: input.sorted_piece_ids.to_vec(),
        state_snapshots,
        beam_width: input.beam_width,
        portfolio,
        finalization_metrics: IrregularFinalizationMetrics {
            reconstruction_elapsed_ms: 0.0,
            final_score_elapsed_ms: 0.0,
        },
    })
}

// ===========================================================================
// `resolvePortfolioPlacementTransform`/`isQuarterTurnEquivalent`/
// `normalizeRotationDegrees` (`computeIrregularNesting.ts:1868-1904`). Only
// reachable from the legacy non-archive `reconstructPlacedGeometry` path in
// TS (not ported here per this crate's R1/R2 scope), but ported anyway: it
// is small, pure, exported by the TS module (`worker-coordination.md` §6
// singles it out as this cluster's one nontrivial epsilon comparator), and
// worth differential coverage independent of which caller eventually needs
// it.
// ===========================================================================

/// TS: `computeIrregularNesting.ts:1868-1892` `resolvePortfolioPlacementTransform`.
pub fn resolve_portfolio_placement_transform(
    transforms: &[crate::domain::IrregularTransformCandidate],
    rotation_deg: f64,
    mirrored: bool,
) -> Option<crate::domain::IrregularTransformCandidate> {
    let mut same_mirror: Vec<&crate::domain::IrregularTransformCandidate> = transforms
        .iter()
        .filter(|candidate| candidate.mirrored == mirrored)
        .collect();
    same_mirror.sort_by(|first, second| {
        first
            .index
            .partial_cmp(&second.index)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    if let Some(exact) = same_mirror
        .iter()
        .find(|candidate| candidate.rotation_deg == rotation_deg)
    {
        return Some(**exact);
    }

    let quarter_turn_base = same_mirror
        .iter()
        .find(|candidate| is_quarter_turn_equivalent(candidate.rotation_deg, rotation_deg))?;

    Some(crate::domain::IrregularTransformCandidate {
        index: quarter_turn_base.index,
        rotation_deg,
        mirrored,
        reason: quarter_turn_base.reason,
    })
}

/// TS: `computeIrregularNesting.ts:1894-1899` `isQuarterTurnEquivalent`.
fn is_quarter_turn_equivalent(first_rotation_deg: f64, second_rotation_deg: f64) -> bool {
    let normalized_difference =
        normalize_rotation_degrees(second_rotation_deg - first_rotation_deg);
    [0.0_f64, 90.0, 180.0, 270.0]
        .iter()
        .any(|quarter_turn_deg| (normalized_difference - quarter_turn_deg).abs() <= 1e-9)
}

/// TS: `computeIrregularNesting.ts:1901-1904` `normalizeRotationDegrees`. A
/// single `%` then a conditional add -- **not** `((deg % 360) + 360) % 360`
/// -- matching the TS source's exact `-0` handling (see
/// `worker-coordination.md` §6).
fn normalize_rotation_degrees(rotation_deg: f64) -> f64 {
    let remainder = rotation_deg % 360.0;
    if remainder < 0.0 {
        remainder + 360.0
    } else {
        remainder
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{IrregularTransformCandidate, IrregularTransformReason};

    fn candidate(index: f64, rotation_deg: f64, mirrored: bool) -> IrregularTransformCandidate {
        IrregularTransformCandidate {
            index,
            rotation_deg,
            mirrored,
            reason: IrregularTransformReason::Orthogonal,
        }
    }

    #[test]
    fn resolves_exact_rotation_match_first() {
        let transforms = vec![candidate(0.0, 0.0, false), candidate(1.0, 90.0, false)];
        let resolved = resolve_portfolio_placement_transform(&transforms, 90.0, false).unwrap();
        assert_eq!(resolved.index, 1.0);
        assert_eq!(resolved.rotation_deg, 90.0);
    }

    #[test]
    fn resolves_quarter_turn_equivalent_when_no_exact_match() {
        let transforms = vec![candidate(0.0, 0.0, false)];
        // 450 degrees normalizes to 90, a quarter turn away from the only
        // prepared candidate (0 degrees).
        let resolved = resolve_portfolio_placement_transform(&transforms, 450.0, false).unwrap();
        assert_eq!(resolved.index, 0.0);
        assert_eq!(resolved.rotation_deg, 450.0);
    }

    #[test]
    fn returns_none_when_no_candidate_matches_mirror_or_quarter_turn() {
        let transforms = vec![candidate(0.0, 0.0, false)];
        assert!(resolve_portfolio_placement_transform(&transforms, 45.0, false).is_none());
        assert!(resolve_portfolio_placement_transform(&transforms, 0.0, true).is_none());
    }

    #[test]
    fn normalize_rotation_degrees_matches_ts_single_modulo_semantics() {
        assert_eq!(normalize_rotation_degrees(-90.0), 270.0);
        assert_eq!(normalize_rotation_degrees(0.0), 0.0);
        assert_eq!(normalize_rotation_degrees(450.0), 90.0);
    }
}
