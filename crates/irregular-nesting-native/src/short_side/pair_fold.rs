//! Terminal Short Side directional constructions: exact pair-fold, exact
//! multi-row shelf, and the contact-strip promotion contract between them.
//!
//! TS source:
//! `src/workers/algorithm/irregular/intrinsicShortSidePairFoldObserver.ts`
//! (1677 lines), ported here in full. Read together with
//! `docs/planning/rust-irregular-backend/characterization/short-side.md`
//! before touching this file, in particular:
//!
//! - **Finding 2** (§15): `evaluate_intrinsic_short_side_contact_strip_promotion`'s
//!   no-regression contract is stored only as trace evidence
//!   (`contactStripPromotion`) and never gates selection.
//!   `select_directional_incumbent`/`compare_directional_topology` are the
//!   *only* selection authority.
//! - **Finding 3** (§15): the area-cost bound and every fill/depth/
//!   projection/cavity/density term computed in `finalize_outcome` are
//!   evidence only. `exact_target_identity` (exact legality already proven
//!   by the time `finalize_outcome` runs, plus the complete target
//!   piece-ID set with no duplicates/misses) is the entire acceptance rule.
//! - §5 item 5 / §12: the `stripOutcome === contactStripOutcome`
//!   reference-identity quirk this file's `selected_strip_trace` selection
//!   must reproduce exactly -- see [`IncumbentChoice`]'s doc comment.
//!
//! # Reused (GREEN) modules -- never duplicated here
//!
//! - `canonical_grid::layout::{assert_canonical_grid_legal_layout,
//!   canonical_collision_layout_identity, measure_canonical_layout_contacts,
//!   measure_canonical_layout_topology_exact, placed_collision_world_grid_path}`.
//! - `canonical_grid::{to_grid_mm, from_grid}`, `clipper::core::{bigint_to_number,
//!   f64_to_bigint}`.
//! - `search::beam_state::{IrregularBeamState, IrregularBeamStateInput}`.
//! - `checkpoints::canonical_json::locale_compare_keys`.
//! - `geometry::hash::sha256_hex`, `js_number::{js_math, is_safe_integer}`.
//! - `short_side::axes::{intrinsic_short_side_axes, ShortSideAxisDimension,
//!   ShortSideRotationDeg}`.
//! - `short_side::observer::intrinsic_short_side_envelope_area_cost_within_production_bound`
//!   (TS: `import { intrinsicShortSideEnvelopeAreaCostWithinProductionBound }
//!   from './intrinsicShortSideObserver.js'`).
//! - `short_side::contact_strip::*` -- the full contact-strip lane this file
//!   calls three-to-five times per request.
//! - `short_side::json::{ShortSideJsonValue, byte_length}`.
//!
//! # Seams (documented, established pattern)
//!
//! - `geometry_cache: &mut GeometryCacheStore` is an explicit function
//!   parameter, mirroring the TS `Effect` dependency `GeometryKernel |
//!   NfpIfpService` -- the same seam `contact_strip` and
//!   `search::strict_decoder` already establish.
//! - No real OS RSS sampler default -- see `contact_strip`'s top doc,
//!   "Seams", for the identical rationale; this file's own
//!   [`default_current_rss_bytes`] also always returns `0.0`.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::Arc;

use num_bigint::BigInt;

use crate::caches::{
    resolve_transformed_collision_geometry, GeometryCacheStore, TransformCollisionGeometryKeyInput,
};
use crate::canonical_grid::layout::{
    assert_canonical_grid_legal_layout, canonical_collision_layout_identity,
    measure_canonical_layout_contacts, measure_canonical_layout_topology_exact,
    placed_collision_world_grid_path,
};
use crate::canonical_grid::{from_grid, to_grid_mm};
use crate::checkpoints::canonical_json::locale_compare_keys;
use crate::clipper::core::{bigint_to_number, f64_to_bigint};
use crate::domain::{
    IrregularNestingSettings, IrregularPlacedPiece, IrregularPlacement, IrregularPreparedPiece,
    IrregularTransform, IrregularTransformCandidate, PieceId, SheetSpec,
    TransformedCollisionGeometry,
};
use crate::geometry::hash::sha256_hex;
use crate::js_number::{is_safe_integer, js_math};
use crate::search::beam_state::{IrregularBeamState, IrregularBeamStateInput};
use crate::validation::placement::IrregularGeometryInputError;

use super::axes::{intrinsic_short_side_axes, ShortSideAxisDimension, ShortSideRotationDeg};
use super::contact_strip::{
    construct_intrinsic_short_side_contact_strip, ConstructIntrinsicShortSideContactStripInput,
    IntrinsicShortSideContactStripOrderPolicy, IntrinsicShortSideContactStripRuntimeControl,
    IntrinsicShortSideContactStripSelectionPolicy, IntrinsicShortSideContactStripStatus,
    IntrinsicShortSideContactStripTrace, INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_BACKTRACKS,
    INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_CANDIDATE_EVALUATIONS,
    INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES,
    INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS,
};
use super::json::{byte_length, ShortSideJsonValue};
use super::observer::intrinsic_short_side_envelope_area_cost_within_production_bound;

// ===========================================================================
// Constants (`intrinsicShortSidePairFoldObserver.ts:35-40`)
// ===========================================================================

pub const INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION: &str =
    "intrinsic-short-side-terminal-observer-v6";
pub const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RUNTIME_MS: f64 = 30_000.0;
pub const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RSS_DELTA_BYTES: f64 = 512.0 * 1_048_576.0;
pub const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_TRACE_BYTES: f64 = 1_048_576.0;
pub const INTRINSIC_SHORT_SIDE_ORDER_CONTINUATION_MAX_PIECES: usize = 8;

fn compare_f64(first: f64, second: f64) -> Ordering {
    first.partial_cmp(&second).unwrap_or(Ordering::Equal)
}

fn cloned_placed(placed: &[Arc<IrregularPlacedPiece>]) -> Vec<IrregularPlacedPiece> {
    placed.iter().map(|p| (**p).clone()).collect()
}

fn prepared_piece_id(piece: &IrregularPreparedPiece) -> PieceId {
    piece
        .piece_id
        .clone()
        .unwrap_or_else(|| piece.source.id.clone())
}

fn placed_piece_id(placed: &IrregularPlacedPiece) -> PieceId {
    placed
        .placement
        .piece_id
        .clone()
        .unwrap_or_else(|| placed.placement.source_piece_id.clone())
}

fn default_timing_now() -> f64 {
    static PROCESS_START: std::sync::LazyLock<std::time::Instant> =
        std::sync::LazyLock::new(std::time::Instant::now);
    PROCESS_START.elapsed().as_secs_f64() * 1000.0
}

/// See `contact_strip`'s top doc, "Seams" -- identical rationale.
fn default_current_rss_bytes() -> f64 {
    0.0
}

// ===========================================================================
// Status/kind enums (`:50-59,149-152`)
// ===========================================================================

/// TS: `intrinsicShortSidePairFoldObserver.ts:50-59`
/// `IntrinsicShortSidePairFoldStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicShortSidePairFoldStatus {
    Accepted,
    SkippedSquareSheet,
    NoPair,
    NoFittingPair,
    RejectedAdmission,
    Deadline,
    MemoryCap,
    TraceCap,
    FailedProtectedFallback,
}

impl IntrinsicShortSidePairFoldStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicShortSidePairFoldStatus::Accepted => "accepted",
            IntrinsicShortSidePairFoldStatus::SkippedSquareSheet => "skipped-square-sheet",
            IntrinsicShortSidePairFoldStatus::NoPair => "no-pair",
            IntrinsicShortSidePairFoldStatus::NoFittingPair => "no-fitting-pair",
            IntrinsicShortSidePairFoldStatus::RejectedAdmission => "rejected-admission",
            IntrinsicShortSidePairFoldStatus::Deadline => "deadline",
            IntrinsicShortSidePairFoldStatus::MemoryCap => "memory-cap",
            IntrinsicShortSidePairFoldStatus::TraceCap => "trace-cap",
            IntrinsicShortSidePairFoldStatus::FailedProtectedFallback => {
                "failed-protected-fallback"
            }
        }
    }
}

/// Local `'deadline' | 'memory-cap'` closed set -- independent from
/// `contact_strip`'s own copy, matching the TS source's own two
/// textually-independent inline return-type unions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BoundedStatus {
    Deadline,
    MemoryCap,
}

impl BoundedStatus {
    fn as_str(self) -> &'static str {
        match self {
            BoundedStatus::Deadline => "deadline",
            BoundedStatus::MemoryCap => "memory-cap",
        }
    }

    fn to_status(self) -> IntrinsicShortSidePairFoldStatus {
        match self {
            BoundedStatus::Deadline => IntrinsicShortSidePairFoldStatus::Deadline,
            BoundedStatus::MemoryCap => IntrinsicShortSidePairFoldStatus::MemoryCap,
        }
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:149-152`
/// `IntrinsicShortSideConstructionKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicShortSideConstructionKind {
    PairFold,
    MultiRowShelf,
    ContactStrip,
}

impl IntrinsicShortSideConstructionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicShortSideConstructionKind::PairFold => "pair-fold",
            IntrinsicShortSideConstructionKind::MultiRowShelf => "multi-row-shelf",
            IntrinsicShortSideConstructionKind::ContactStrip => "contact-strip",
        }
    }
}

// ===========================================================================
// Admission, interlocking, promotion, and trace types (`:61-190`)
// ===========================================================================

/// TS: `intrinsicShortSidePairFoldObserver.ts:61-75`
/// `IntrinsicShortSidePairFoldAdmission`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicShortSidePairFoldAdmission {
    pub exact_legal: bool,
    pub all_pieces_placed: bool,
    pub fill_ratio: f64,
    pub depth_within_production_maximum_side: bool,
    pub projection_coverage_ratio: f64,
    pub projection_component_count: f64,
    pub enclosed_cavity_count: Option<f64>,
    pub collision_envelope_density: f64,
    pub short_axis_span_gain_factor: f64,
    pub envelope_area_cost_factor: f64,
    pub directionally_efficient: bool,
    pub envelope_area_cost_within_production_bound: bool,
    pub accepted: bool,
}

impl IntrinsicShortSidePairFoldAdmission {
    // `to_json` mirrors this cluster's other trace-payload `to_json(&self)`
    // methods (most of which are on non-`Copy` types) for a uniform call
    // shape across this file; taking `&self` here despite `Copy` is
    // intentional consistency, not an oversight.
    #[allow(clippy::wrong_self_convention)]
    fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            ("exactLegal", ShortSideJsonValue::Bool(self.exact_legal)),
            (
                "allPiecesPlaced",
                ShortSideJsonValue::Bool(self.all_pieces_placed),
            ),
            ("fillRatio", ShortSideJsonValue::Num(self.fill_ratio)),
            (
                "depthWithinProductionMaximumSide",
                ShortSideJsonValue::Bool(self.depth_within_production_maximum_side),
            ),
            (
                "projectionCoverageRatio",
                ShortSideJsonValue::Num(self.projection_coverage_ratio),
            ),
            (
                "projectionComponentCount",
                ShortSideJsonValue::Num(self.projection_component_count),
            ),
            (
                "enclosedCavityCount",
                ShortSideJsonValue::opt_num(self.enclosed_cavity_count),
            ),
            (
                "collisionEnvelopeDensity",
                ShortSideJsonValue::Num(self.collision_envelope_density),
            ),
            (
                "shortAxisSpanGainFactor",
                ShortSideJsonValue::Num(self.short_axis_span_gain_factor),
            ),
            (
                "envelopeAreaCostFactor",
                ShortSideJsonValue::Num(self.envelope_area_cost_factor),
            ),
            (
                "directionallyEfficient",
                ShortSideJsonValue::Bool(self.directionally_efficient),
            ),
            (
                "envelopeAreaCostWithinProductionBound",
                ShortSideJsonValue::Bool(self.envelope_area_cost_within_production_bound),
            ),
            ("accepted", ShortSideJsonValue::Bool(self.accepted)),
        ])
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:83-86`
/// `IntrinsicShortSideEnvelopeAreaCostVeto`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideEnvelopeAreaCostVeto {
    pub construction_kind: IntrinsicShortSideConstructionKind,
    pub admission: IntrinsicShortSidePairFoldAdmission,
}

impl IntrinsicShortSideEnvelopeAreaCostVeto {
    fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            (
                "constructionKind",
                ShortSideJsonValue::str(self.construction_kind.as_str()),
            ),
            ("admission", self.admission.to_json()),
        ])
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:96-104`
/// `IntrinsicShortSideInterlockingMetrics`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideInterlockingMetrics {
    pub largest_occupied_hull_gap_ratio: f64,
    pub largest_occupied_hull_gap_doubled_area_grid2: String,
    pub occupied_hull_doubled_area_grid2: String,
    pub isolated_piece_count: f64,
    pub positive_contact_component_count: f64,
    pub largest_positive_contact_component_size: f64,
    pub shared_boundary_length_mm: f64,
}

impl IntrinsicShortSideInterlockingMetrics {
    fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            (
                "largestOccupiedHullGapRatio",
                ShortSideJsonValue::Num(self.largest_occupied_hull_gap_ratio),
            ),
            (
                "largestOccupiedHullGapDoubledAreaGrid2",
                ShortSideJsonValue::str(self.largest_occupied_hull_gap_doubled_area_grid2.clone()),
            ),
            (
                "occupiedHullDoubledAreaGrid2",
                ShortSideJsonValue::str(self.occupied_hull_doubled_area_grid2.clone()),
            ),
            (
                "isolatedPieceCount",
                ShortSideJsonValue::Num(self.isolated_piece_count),
            ),
            (
                "positiveContactComponentCount",
                ShortSideJsonValue::Num(self.positive_contact_component_count),
            ),
            (
                "largestPositiveContactComponentSize",
                ShortSideJsonValue::Num(self.largest_positive_contact_component_size),
            ),
            (
                "sharedBoundaryLengthMm",
                ShortSideJsonValue::Num(self.shared_boundary_length_mm),
            ),
        ])
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:155-167`
/// `IntrinsicShortSideConstructionSummary`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideConstructionSummary {
    pub used_short_axis_span_mm: Option<f64>,
    pub used_long_axis_depth_mm: Option<f64>,
    pub envelope_area_mm2: Option<f64>,
    pub used_short_axis_span_grid: Option<f64>,
    pub used_long_axis_depth_grid: Option<f64>,
    pub envelope_area_grid2: Option<String>,
    pub collision_material_doubled_area_grid2: Option<String>,
    pub admission: Option<IntrinsicShortSidePairFoldAdmission>,
    pub interlocking: Option<IntrinsicShortSideInterlockingMetrics>,
    pub status: IntrinsicShortSidePairFoldStatus,
    pub failure_reason: Option<String>,
}

impl IntrinsicShortSideConstructionSummary {
    fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            (
                "usedShortAxisSpanMm",
                ShortSideJsonValue::opt_num(self.used_short_axis_span_mm),
            ),
            (
                "usedLongAxisDepthMm",
                ShortSideJsonValue::opt_num(self.used_long_axis_depth_mm),
            ),
            (
                "envelopeAreaMm2",
                ShortSideJsonValue::opt_num(self.envelope_area_mm2),
            ),
            (
                "usedShortAxisSpanGrid",
                ShortSideJsonValue::opt_num(self.used_short_axis_span_grid),
            ),
            (
                "usedLongAxisDepthGrid",
                ShortSideJsonValue::opt_num(self.used_long_axis_depth_grid),
            ),
            (
                "envelopeAreaGrid2",
                ShortSideJsonValue::opt_str(self.envelope_area_grid2.as_deref()),
            ),
            (
                "collisionMaterialDoubledAreaGrid2",
                ShortSideJsonValue::opt_str(self.collision_material_doubled_area_grid2.as_deref()),
            ),
            (
                "admission",
                match &self.admission {
                    Some(admission) => admission.to_json(),
                    None => ShortSideJsonValue::Undefined,
                },
            ),
            (
                "interlocking",
                match &self.interlocking {
                    Some(interlocking) => interlocking.to_json(),
                    None => ShortSideJsonValue::Undefined,
                },
            ),
            ("status", ShortSideJsonValue::str(self.status.as_str())),
            (
                "failureReason",
                ShortSideJsonValue::opt_str(self.failure_reason.as_deref()),
            ),
        ])
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:170-185`
/// `IntrinsicShortSideContactStripPromotion`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideContactStripPromotion {
    pub incumbent_construction_kind: Option<IntrinsicShortSideConstructionKind>,
    pub contact_strip_summary: Option<IntrinsicShortSideConstructionSummary>,
    pub contact_strip_admitted: bool,
    pub fill_not_regressed: Option<bool>,
    pub envelope_area_not_regressed: Option<bool>,
    pub depth_not_regressed: Option<bool>,
    pub density_not_regressed: Option<bool>,
    pub hull_gap_not_regressed: Option<bool>,
    pub isolated_pieces_not_regressed: Option<bool>,
    pub positive_contact_components_not_regressed: Option<bool>,
    pub largest_contact_component_not_regressed: Option<bool>,
    pub strictly_improved: Option<bool>,
    pub promoted: bool,
}

fn opt_bool_json(value: Option<bool>) -> ShortSideJsonValue {
    match value {
        Some(value) => ShortSideJsonValue::Bool(value),
        None => ShortSideJsonValue::Undefined,
    }
}

impl IntrinsicShortSideContactStripPromotion {
    fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            (
                "incumbentConstructionKind",
                match self.incumbent_construction_kind {
                    Some(kind) => ShortSideJsonValue::str(kind.as_str()),
                    None => ShortSideJsonValue::Undefined,
                },
            ),
            (
                "contactStripSummary",
                match &self.contact_strip_summary {
                    Some(summary) => summary.to_json(),
                    None => ShortSideJsonValue::Undefined,
                },
            ),
            (
                "contactStripAdmitted",
                ShortSideJsonValue::Bool(self.contact_strip_admitted),
            ),
            ("fillNotRegressed", opt_bool_json(self.fill_not_regressed)),
            (
                "envelopeAreaNotRegressed",
                opt_bool_json(self.envelope_area_not_regressed),
            ),
            ("depthNotRegressed", opt_bool_json(self.depth_not_regressed)),
            (
                "densityNotRegressed",
                opt_bool_json(self.density_not_regressed),
            ),
            (
                "hullGapNotRegressed",
                opt_bool_json(self.hull_gap_not_regressed),
            ),
            (
                "isolatedPiecesNotRegressed",
                opt_bool_json(self.isolated_pieces_not_regressed),
            ),
            (
                "positiveContactComponentsNotRegressed",
                opt_bool_json(self.positive_contact_components_not_regressed),
            ),
            (
                "largestContactComponentNotRegressed",
                opt_bool_json(self.largest_contact_component_not_regressed),
            ),
            ("strictlyImproved", opt_bool_json(self.strictly_improved)),
            ("promoted", ShortSideJsonValue::Bool(self.promoted)),
        ])
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:106-147`
/// `IntrinsicShortSidePairFoldTrace`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSidePairFoldTrace {
    pub version: &'static str,
    pub status: IntrinsicShortSidePairFoldStatus,
    pub output_influence: super::observer::ShortSideOutputInfluence,
    pub execution_model: &'static str,
    pub requested_short_axis_mm: f64,
    pub requested_long_axis_mm: f64,
    pub prescribed_rotation_deg: Option<ShortSideRotationDeg>,
    pub production_short_axis_span_mm: f64,
    pub production_maximum_side_mm: f64,
    pub production_envelope_area_mm2: f64,
    pub production_short_axis_span_grid: f64,
    pub production_maximum_side_grid: f64,
    pub production_envelope_area_grid2: String,
    pub transform_evaluations: f64,
    pub expected_pair_count: f64,
    pub evaluated_pair_count: f64,
    pub construction_kind: Option<IntrinsicShortSideConstructionKind>,
    pub row_count: f64,
    pub selected_bottom_piece_id: Option<PieceId>,
    pub selected_upper_piece_id: Option<PieceId>,
    pub placed_count: f64,
    pub used_short_axis_span_mm: Option<f64>,
    pub used_long_axis_depth_mm: Option<f64>,
    pub envelope_area_mm2: Option<f64>,
    pub used_short_axis_span_grid: Option<f64>,
    pub used_long_axis_depth_grid: Option<f64>,
    pub envelope_area_grid2: Option<String>,
    pub collision_material_doubled_area_grid2: Option<String>,
    pub canonical_geometry_hash: Option<String>,
    pub admission: Option<IntrinsicShortSidePairFoldAdmission>,
    pub interlocking: Option<IntrinsicShortSideInterlockingMetrics>,
    pub envelope_area_cost_veto_observed: bool,
    pub envelope_area_cost_vetoes: Vec<IntrinsicShortSideEnvelopeAreaCostVeto>,
    pub contact_strip: Option<IntrinsicShortSideContactStripTrace>,
    pub contact_strip_lanes: Vec<IntrinsicShortSideContactStripTrace>,
    pub contact_strip_promotion: Option<IntrinsicShortSideContactStripPromotion>,
    pub runtime_ms: f64,
    pub peak_rss_delta_bytes: f64,
    pub serialized_trace_bytes: f64,
    pub failure_reason: Option<String>,
}

impl IntrinsicShortSidePairFoldTrace {
    fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            ("version", ShortSideJsonValue::str(self.version)),
            ("status", ShortSideJsonValue::str(self.status.as_str())),
            (
                "outputInfluence",
                ShortSideJsonValue::str(self.output_influence.as_str()),
            ),
            (
                "executionModel",
                ShortSideJsonValue::str(self.execution_model),
            ),
            (
                "requestedShortAxisMm",
                ShortSideJsonValue::Num(self.requested_short_axis_mm),
            ),
            (
                "requestedLongAxisMm",
                ShortSideJsonValue::Num(self.requested_long_axis_mm),
            ),
            (
                "prescribedRotationDeg",
                ShortSideJsonValue::opt_num(
                    self.prescribed_rotation_deg.map(|r| r.as_degrees_f64()),
                ),
            ),
            (
                "productionShortAxisSpanMm",
                ShortSideJsonValue::Num(self.production_short_axis_span_mm),
            ),
            (
                "productionMaximumSideMm",
                ShortSideJsonValue::Num(self.production_maximum_side_mm),
            ),
            (
                "productionEnvelopeAreaMm2",
                ShortSideJsonValue::Num(self.production_envelope_area_mm2),
            ),
            (
                "productionShortAxisSpanGrid",
                ShortSideJsonValue::Num(self.production_short_axis_span_grid),
            ),
            (
                "productionMaximumSideGrid",
                ShortSideJsonValue::Num(self.production_maximum_side_grid),
            ),
            (
                "productionEnvelopeAreaGrid2",
                ShortSideJsonValue::str(self.production_envelope_area_grid2.clone()),
            ),
            (
                "transformEvaluations",
                ShortSideJsonValue::Num(self.transform_evaluations),
            ),
            (
                "expectedPairCount",
                ShortSideJsonValue::Num(self.expected_pair_count),
            ),
            (
                "evaluatedPairCount",
                ShortSideJsonValue::Num(self.evaluated_pair_count),
            ),
            (
                "constructionKind",
                match self.construction_kind {
                    Some(kind) => ShortSideJsonValue::str(kind.as_str()),
                    None => ShortSideJsonValue::Undefined,
                },
            ),
            ("rowCount", ShortSideJsonValue::Num(self.row_count)),
            (
                "selectedBottomPieceId",
                ShortSideJsonValue::opt_str(
                    self.selected_bottom_piece_id.as_ref().map(|id| id.as_str()),
                ),
            ),
            (
                "selectedUpperPieceId",
                ShortSideJsonValue::opt_str(
                    self.selected_upper_piece_id.as_ref().map(|id| id.as_str()),
                ),
            ),
            ("placedCount", ShortSideJsonValue::Num(self.placed_count)),
            (
                "usedShortAxisSpanMm",
                ShortSideJsonValue::opt_num(self.used_short_axis_span_mm),
            ),
            (
                "usedLongAxisDepthMm",
                ShortSideJsonValue::opt_num(self.used_long_axis_depth_mm),
            ),
            (
                "envelopeAreaMm2",
                ShortSideJsonValue::opt_num(self.envelope_area_mm2),
            ),
            (
                "usedShortAxisSpanGrid",
                ShortSideJsonValue::opt_num(self.used_short_axis_span_grid),
            ),
            (
                "usedLongAxisDepthGrid",
                ShortSideJsonValue::opt_num(self.used_long_axis_depth_grid),
            ),
            (
                "envelopeAreaGrid2",
                ShortSideJsonValue::opt_str(self.envelope_area_grid2.as_deref()),
            ),
            (
                "collisionMaterialDoubledAreaGrid2",
                ShortSideJsonValue::opt_str(self.collision_material_doubled_area_grid2.as_deref()),
            ),
            (
                "canonicalGeometryHash",
                ShortSideJsonValue::opt_str(self.canonical_geometry_hash.as_deref()),
            ),
            (
                "admission",
                match &self.admission {
                    Some(admission) => admission.to_json(),
                    None => ShortSideJsonValue::Undefined,
                },
            ),
            (
                "interlocking",
                match &self.interlocking {
                    Some(interlocking) => interlocking.to_json(),
                    None => ShortSideJsonValue::Undefined,
                },
            ),
            (
                "envelopeAreaCostVetoObserved",
                ShortSideJsonValue::Bool(self.envelope_area_cost_veto_observed),
            ),
            (
                "envelopeAreaCostVetoes",
                ShortSideJsonValue::Arr(
                    self.envelope_area_cost_vetoes
                        .iter()
                        .map(|veto| veto.to_json())
                        .collect(),
                ),
            ),
            (
                "contactStrip",
                match &self.contact_strip {
                    Some(trace) => trace.to_json(),
                    None => ShortSideJsonValue::Undefined,
                },
            ),
            (
                "contactStripLanes",
                ShortSideJsonValue::Arr(
                    self.contact_strip_lanes
                        .iter()
                        .map(|trace| trace.to_json())
                        .collect(),
                ),
            ),
            (
                "contactStripPromotion",
                match &self.contact_strip_promotion {
                    Some(promotion) => promotion.to_json(),
                    None => ShortSideJsonValue::Undefined,
                },
            ),
            ("runtimeMs", ShortSideJsonValue::Num(self.runtime_ms)),
            (
                "peakRssDeltaBytes",
                ShortSideJsonValue::Num(self.peak_rss_delta_bytes),
            ),
            (
                "serializedTraceBytes",
                ShortSideJsonValue::Num(self.serialized_trace_bytes),
            ),
            (
                "failureReason",
                ShortSideJsonValue::opt_str(self.failure_reason.as_deref()),
            ),
        ])
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:187-190`
/// `IntrinsicShortSidePairFoldOutcome`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSidePairFoldOutcome {
    pub trace: IntrinsicShortSidePairFoldTrace,
    pub placed_collision_geometries: Option<Vec<Arc<IrregularPlacedPiece>>>,
}

// ===========================================================================
// Runtime control and `ObserverRuntime` (`:42-48,192-206`)
// ===========================================================================

/// TS: `intrinsicShortSidePairFoldObserver.ts:42-48`
/// `IntrinsicShortSidePairFoldRuntimeControl`.
#[derive(Default)]
pub struct IntrinsicShortSidePairFoldRuntimeControl<'a> {
    pub maximum_runtime_ms: Option<f64>,
    pub maximum_rss_delta_bytes: Option<f64>,
    pub maximum_trace_bytes: Option<f64>,
    pub now: Option<&'a dyn Fn() -> f64>,
    pub current_rss_bytes: Option<&'a dyn Fn() -> f64>,
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:192-206` `ObserverRuntime`.
///
/// `peak_rss_bytes` is a [`std::cell::Cell`] (not a plain field) because the
/// per-lane `currentRssBytes` closures passed to the contact-strip lanes
/// (`:544-548` etc.) must mutate it as a side effect of being called *while
/// only holding a shared `&ObserverRuntime`* (the callee's own
/// `current_rss_bytes: Option<&'a dyn Fn() -> f64>` seam takes `Fn`, not
/// `FnMut`) -- see this module's top doc, "Closure-captured mutable state".
struct ObserverRuntime<'a> {
    started_at: f64,
    starting_rss_bytes: f64,
    peak_rss_bytes: std::cell::Cell<f64>,
    transform_evaluations: f64,
    expected_pair_count: f64,
    evaluated_pair_count: f64,
    envelope_area_cost_veto_observed: bool,
    envelope_area_cost_vetoes: Vec<IntrinsicShortSideEnvelopeAreaCostVeto>,
    maximum_runtime_ms: f64,
    maximum_rss_delta_bytes: f64,
    maximum_trace_bytes: f64,
    now: &'a dyn Fn() -> f64,
    current_rss_bytes: &'a dyn Fn() -> f64,
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1574-1579` (`boundedStatus`).
fn bounded_status(runtime: &ObserverRuntime<'_>) -> Option<BoundedStatus> {
    if (runtime.now)() - runtime.started_at > runtime.maximum_runtime_ms {
        return Some(BoundedStatus::Deadline);
    }
    if sample_rss(runtime) > runtime.maximum_rss_delta_bytes {
        Some(BoundedStatus::MemoryCap)
    } else {
        None
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1581-1584` (`sampleRss`).
fn sample_rss(runtime: &ObserverRuntime<'_>) -> f64 {
    let current = (runtime.current_rss_bytes)();
    runtime
        .peak_rss_bytes
        .set(js_math::max(runtime.peak_rss_bytes.get(), current));
    js_math::max(
        0.0,
        runtime.peak_rss_bytes.get() - runtime.starting_rss_bytes,
    )
}

fn transform_collision_geometry(
    geometry: &crate::domain::CollisionGeometry,
    transform: &IrregularTransformCandidate,
    settings: &crate::domain::IrregularGeometrySettings,
    cache: &mut GeometryCacheStore,
) -> Result<TransformedCollisionGeometry, IrregularGeometryInputError> {
    let key_input = TransformCollisionGeometryKeyInput {
        geometry,
        transform,
    };
    resolve_transformed_collision_geometry(&key_input, settings, cache, |computed| computed)
        .map(|success| success.value)
        .map_err(|message| IrregularGeometryInputError {
            operation: "transformCollisionGeometry".to_string(),
            message,
        })
}

// ===========================================================================
// Selected-transform / selected-pair / shelf plumbing (`:208-229,1050-1175`)
// ===========================================================================

#[derive(Clone)]
struct SelectedTransform {
    piece: Arc<IrregularPreparedPiece>,
    piece_id: PieceId,
    geometry: TransformedCollisionGeometry,
    width_grid: f64,
    height_grid: f64,
    min_x_grid: f64,
    min_y_grid: f64,
}

struct SelectedPair {
    bottom_index: usize,
    upper_index: usize,
    /// TS: `SelectedPair.widthGrid` (`:218-224`) -- computed and stored on
    /// every candidate (feeding `envelopeAreaGrid2`'s product below) but
    /// never read back off the winning `selectedPair` by any TS call site
    /// (`constructPairLayout`/`compareSelectedPairs` only read
    /// `bottomIndex`/`upperIndex`/`depthGrid`/`envelopeAreaGrid2`). Kept for
    /// exact structural fidelity with the TS type.
    #[allow(dead_code)]
    width_grid: f64,
    depth_grid: f64,
    envelope_area_grid2: BigInt,
}

struct ShelfLayout {
    placed: Vec<Arc<IrregularPlacedPiece>>,
    row_count: f64,
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1050-1058`
/// (`compareSelectedTransforms`).
fn compare_selected_transforms(first: &SelectedTransform, second: &SelectedTransform) -> Ordering {
    compare_f64(first.width_grid, second.width_grid)
        .then_with(|| compare_f64(first.height_grid, second.height_grid))
        .then_with(|| {
            compare_f64(
                first.geometry.transform.index,
                second.geometry.transform.index,
            )
        })
        .then_with(|| {
            compare_f64(
                first.geometry.transform.rotation_deg,
                second.geometry.transform.rotation_deg,
            )
        })
        .then_with(|| {
            first
                .geometry
                .transform
                .mirrored
                .cmp(&second.geometry.transform.mirrored)
        })
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1060-1068`
/// (`compareShelfTransforms`).
fn compare_shelf_transforms(first: &SelectedTransform, second: &SelectedTransform) -> Ordering {
    compare_f64(first.height_grid, second.height_grid)
        .then_with(|| compare_f64(second.width_grid, first.width_grid))
        .then_with(|| {
            compare_f64(
                first.geometry.transform.index,
                second.geometry.transform.index,
            )
        })
        .then_with(|| {
            compare_f64(
                first.geometry.transform.rotation_deg,
                second.geometry.transform.rotation_deg,
            )
        })
        .then_with(|| {
            first
                .geometry
                .transform
                .mirrored
                .cmp(&second.geometry.transform.mirrored)
        })
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1070-1087`
/// (`compareSelectedPairs`).
fn compare_selected_pairs(
    first: &SelectedPair,
    second: &SelectedPair,
    selected_transforms: &[SelectedTransform],
) -> Ordering {
    if first.envelope_area_grid2 != second.envelope_area_grid2 {
        return if first.envelope_area_grid2 < second.envelope_area_grid2 {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let first_bottom = selected_transforms[first.bottom_index].piece_id.as_str();
    let second_bottom = selected_transforms[second.bottom_index].piece_id.as_str();
    let first_upper = selected_transforms[first.upper_index].piece_id.as_str();
    let second_upper = selected_transforms[second.upper_index].piece_id.as_str();
    compare_f64(first.depth_grid, second.depth_grid)
        .then_with(|| locale_compare_keys(first_bottom, second_bottom))
        .then_with(|| locale_compare_keys(first_upper, second_upper))
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1089-1115`
/// (`constructPairLayout`).
fn construct_pair_layout(
    selected_transforms: &[SelectedTransform],
    selected_pair: &SelectedPair,
    requested_short_axis_grid: f64,
) -> Option<Vec<Arc<IrregularPlacedPiece>>> {
    let mut cursor_grid = 0.0_f64;
    let mut placed: Vec<Arc<IrregularPlacedPiece>> = Vec::new();
    for index in 0..selected_transforms.len() {
        if index == selected_pair.upper_index {
            continue;
        }
        let selected = &selected_transforms[index];
        if index == selected_pair.bottom_index {
            let upper = &selected_transforms[selected_pair.upper_index];
            placed.push(Arc::new(create_placed_piece(selected, cursor_grid, 0.0)));
            placed.push(Arc::new(create_placed_piece(
                upper,
                cursor_grid,
                selected.height_grid,
            )));
            cursor_grid += js_math::max(selected.width_grid, upper.width_grid);
            continue;
        }
        if cursor_grid + selected.width_grid > requested_short_axis_grid {
            return None;
        }
        placed.push(Arc::new(create_placed_piece(selected, cursor_grid, 0.0)));
        cursor_grid += selected.width_grid;
    }
    Some(placed)
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1117-1148`
/// (`constructNextFitShelf`).
fn construct_next_fit_shelf(
    selected_transforms: &[SelectedTransform],
    requested_short_axis_grid: f64,
    requested_long_axis_grid: f64,
) -> Option<ShelfLayout> {
    let mut cursor_grid = 0.0_f64;
    let mut row_start_grid = 0.0_f64;
    let mut row_height_grid = 0.0_f64;
    let mut row_count = if selected_transforms.is_empty() {
        0.0
    } else {
        1.0
    };
    let mut placed: Vec<Arc<IrregularPlacedPiece>> = Vec::new();
    for selected in selected_transforms {
        if selected.width_grid > requested_short_axis_grid
            || selected.height_grid > requested_long_axis_grid
        {
            return None;
        }
        if cursor_grid > 0.0 && cursor_grid + selected.width_grid > requested_short_axis_grid {
            row_start_grid += row_height_grid;
            cursor_grid = 0.0;
            row_height_grid = 0.0;
            row_count += 1.0;
        }
        if row_start_grid + selected.height_grid > requested_long_axis_grid {
            return None;
        }
        placed.push(Arc::new(create_placed_piece(
            selected,
            cursor_grid,
            row_start_grid,
        )));
        cursor_grid += selected.width_grid;
        row_height_grid = js_math::max(row_height_grid, selected.height_grid);
    }
    Some(ShelfLayout { placed, row_count })
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1150-1175`
/// (`createPlacedPiece`).
fn create_placed_piece(
    selected: &SelectedTransform,
    cursor_grid: f64,
    vertical_offset_grid: f64,
) -> IrregularPlacedPiece {
    IrregularPlacedPiece {
        placement: IrregularPlacement {
            piece_id: selected.piece.piece_id.clone(),
            source_piece_id: selected.piece.source.id.clone(),
            placement_reference: Some(selected.piece.collision_geometry.placement_reference),
            transform: IrregularTransform {
                translate_x: from_grid(cursor_grid - selected.min_x_grid),
                translate_y: from_grid(vertical_offset_grid - selected.min_y_grid),
                rotation_deg: selected.geometry.transform.rotation_deg,
                mirrored: selected.geometry.transform.mirrored,
            },
        },
        collision_geometry: selected.geometry.clone(),
    }
}

// ===========================================================================
// `directionalFillTier` / `compareDirectionalTopology` (`:813-867`)
// ===========================================================================

/// TS: `intrinsicShortSidePairFoldObserver.ts:813-827` (`directionalFillTier`).
fn directional_fill_tier(short_axis_span_grid: f64, requested_short_axis_grid: f64) -> u8 {
    if BigInt::from(100) * f64_to_bigint(short_axis_span_grid)
        >= BigInt::from(99) * f64_to_bigint(requested_short_axis_grid)
    {
        return 2;
    }
    if BigInt::from(5) * f64_to_bigint(short_axis_span_grid)
        >= BigInt::from(4) * f64_to_bigint(requested_short_axis_grid)
    {
        1
    } else {
        0
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:829-867`
/// (`compareDirectionalTopology`).
fn compare_directional_topology(
    first: &IntrinsicShortSidePairFoldOutcome,
    second: &IntrinsicShortSidePairFoldOutcome,
) -> Ordering {
    let first_cavities = first.trace.admission.and_then(|a| a.enclosed_cavity_count);
    let second_cavities = second.trace.admission.and_then(|a| a.enclosed_cavity_count);
    match (first_cavities, second_cavities) {
        (Some(f), Some(s)) => {
            if f != s {
                return compare_f64(f, s);
            }
        }
        (None, None) => {}
        (None, Some(_)) => return Ordering::Greater,
        (Some(_), None) => return Ordering::Less,
    }
    let (first_interlocking, second_interlocking) =
        match (&first.trace.interlocking, &second.trace.interlocking) {
            (Some(f), Some(s)) => (f, s),
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Greater,
            (Some(_), None) => return Ordering::Less,
        };
    let first_gap: BigInt = first_interlocking
        .largest_occupied_hull_gap_doubled_area_grid2
        .parse()
        .expect("interlocking hull-gap doubled area is always a valid decimal bigint string");
    let first_hull: BigInt = first_interlocking
        .occupied_hull_doubled_area_grid2
        .parse()
        .expect("interlocking hull doubled area is always a valid decimal bigint string");
    let second_gap: BigInt = second_interlocking
        .largest_occupied_hull_gap_doubled_area_grid2
        .parse()
        .expect("interlocking hull-gap doubled area is always a valid decimal bigint string");
    let second_hull: BigInt = second_interlocking
        .occupied_hull_doubled_area_grid2
        .parse()
        .expect("interlocking hull doubled area is always a valid decimal bigint string");
    let first_scaled_gap = &first_gap * &second_hull;
    let second_scaled_gap = &second_gap * &first_hull;
    if first_scaled_gap != second_scaled_gap {
        return if first_scaled_gap < second_scaled_gap {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    compare_f64(
        first_interlocking.isolated_piece_count,
        second_interlocking.isolated_piece_count,
    )
    .then_with(|| {
        compare_f64(
            first_interlocking.positive_contact_component_count,
            second_interlocking.positive_contact_component_count,
        )
    })
    .then_with(|| {
        compare_f64(
            second_interlocking.largest_positive_contact_component_size,
            first_interlocking.largest_positive_contact_component_size,
        )
    })
}

// ===========================================================================
// `exactPromotionMetrics` / `selectDirectionalIncumbent` (`:765-801,1016-1048`)
// ===========================================================================

struct ExactPromotionMetrics {
    short_axis_span_grid: f64,
    requested_short_axis_grid: f64,
    long_axis_depth_grid: f64,
    envelope_area_grid2: BigInt,
    material_doubled_area_grid2: BigInt,
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1016-1048`
/// (`exactPromotionMetrics`).
fn exact_promotion_metrics(
    outcome: &IntrinsicShortSidePairFoldOutcome,
) -> Option<ExactPromotionMetrics> {
    let short_axis_span_grid = outcome.trace.used_short_axis_span_grid?;
    let requested_short_axis_grid = to_grid_mm(outcome.trace.requested_short_axis_mm)?;
    let long_axis_depth_grid = outcome.trace.used_long_axis_depth_grid?;
    let envelope_area_grid2 = outcome.trace.envelope_area_grid2.as_deref()?;
    let material_doubled_area_grid2 = outcome
        .trace
        .collision_material_doubled_area_grid2
        .as_deref()?;
    Some(ExactPromotionMetrics {
        short_axis_span_grid,
        requested_short_axis_grid,
        long_axis_depth_grid,
        envelope_area_grid2: envelope_area_grid2
            .parse()
            .expect("envelope area grid2 is always a valid decimal bigint string"),
        material_doubled_area_grid2: material_doubled_area_grid2.parse().expect(
            "collision material doubled area grid2 is always a valid decimal bigint string",
        ),
    })
}

/// Which side [`select_directional_incumbent_choice`] chose.
///
/// TS's `selectDirectionalIncumbent` always returns one of its two input
/// *references* (or `undefined`) -- never a freshly constructed object. This
/// enum is the exact Rust equivalent of that reference identity, and is the
/// mechanism that reproduces the genuinely load-bearing
/// `stripOutcome === contactStripOutcome` quirk at
/// `intrinsicShortSidePairFoldObserver.ts:636-637,711`: when **neither**
/// side is `undefined === undefined` in JS is `true`, so
/// `selectedStripTrace` is set to the **second** (contact/continuation)
/// side's trace even when *neither* construction succeeded. This crate
/// reproduces that exact rule as "use the second side's trace unless the
/// first side was the explicit winner" -- see every call site of this
/// function in [`construct_pair_fold`] for the concrete reproduction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IncumbentChoice {
    First,
    Second,
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:765-801`
/// (`selectDirectionalIncumbent`), split into the reference-identity choice
/// ([`IncumbentChoice`]) this crate needs to reproduce
/// `stripOutcome === contactStripOutcome`-style checks, plus [`select_directional_incumbent`]
/// below which resolves that choice into an owned, cloned outcome for
/// call sites that only need the winning value.
fn select_directional_incumbent_choice(
    first: Option<&IntrinsicShortSidePairFoldOutcome>,
    second: Option<&IntrinsicShortSidePairFoldOutcome>,
) -> Option<IncumbentChoice> {
    let first_accepted = matches!(
        first.map(|o| o.trace.status),
        Some(IntrinsicShortSidePairFoldStatus::Accepted)
    );
    if !first_accepted {
        return if matches!(
            second.map(|o| o.trace.status),
            Some(IntrinsicShortSidePairFoldStatus::Accepted)
        ) {
            Some(IncumbentChoice::Second)
        } else {
            None
        };
    }
    let second_accepted = matches!(
        second.map(|o| o.trace.status),
        Some(IntrinsicShortSidePairFoldStatus::Accepted)
    );
    if !second_accepted {
        return Some(IncumbentChoice::First);
    }
    let first = first.expect("checked accepted above");
    let second = second.expect("checked accepted above");
    let first_exact = exact_promotion_metrics(first);
    let second_exact = exact_promotion_metrics(second);
    let (first_exact, second_exact) = match (first_exact, second_exact) {
        (None, None) => return Some(IncumbentChoice::First),
        (None, Some(_)) => return Some(IncumbentChoice::Second),
        (Some(_), None) => return Some(IncumbentChoice::First),
        (Some(f), Some(s)) => (f, s),
    };
    let first_fill_tier = directional_fill_tier(
        first_exact.short_axis_span_grid,
        first_exact.requested_short_axis_grid,
    );
    let second_fill_tier = directional_fill_tier(
        second_exact.short_axis_span_grid,
        second_exact.requested_short_axis_grid,
    );
    if first_fill_tier != second_fill_tier {
        return Some(if first_fill_tier > second_fill_tier {
            IncumbentChoice::First
        } else {
            IncumbentChoice::Second
        });
    }
    if first_fill_tier < 2 && first_exact.short_axis_span_grid != second_exact.short_axis_span_grid
    {
        return Some(
            if first_exact.short_axis_span_grid > second_exact.short_axis_span_grid {
                IncumbentChoice::First
            } else {
                IncumbentChoice::Second
            },
        );
    }
    if first_exact.envelope_area_grid2 != second_exact.envelope_area_grid2 {
        return Some(
            if first_exact.envelope_area_grid2 < second_exact.envelope_area_grid2 {
                IncumbentChoice::First
            } else {
                IncumbentChoice::Second
            },
        );
    }
    if first_exact.long_axis_depth_grid != second_exact.long_axis_depth_grid {
        return Some(
            if first_exact.long_axis_depth_grid < second_exact.long_axis_depth_grid {
                IncumbentChoice::First
            } else {
                IncumbentChoice::Second
            },
        );
    }
    let topology_order = compare_directional_topology(first, second);
    if topology_order != Ordering::Equal {
        return Some(if topology_order == Ordering::Less {
            IncumbentChoice::First
        } else {
            IncumbentChoice::Second
        });
    }
    let first_hash = first
        .trace
        .canonical_geometry_hash
        .clone()
        .unwrap_or_default();
    let second_hash = second
        .trace
        .canonical_geometry_hash
        .clone()
        .unwrap_or_default();
    Some(
        if locale_compare_keys(&first_hash, &second_hash) != Ordering::Greater {
            IncumbentChoice::First
        } else {
            IncumbentChoice::Second
        },
    )
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:765-801`
/// (`selectDirectionalIncumbent`), for call sites that only need the
/// resolved value (not the reference-identity choice). Clones the winning
/// side.
fn select_directional_incumbent(
    first: Option<&IntrinsicShortSidePairFoldOutcome>,
    second: Option<&IntrinsicShortSidePairFoldOutcome>,
) -> Option<IntrinsicShortSidePairFoldOutcome> {
    match select_directional_incumbent_choice(first, second)? {
        IncumbentChoice::First => first.cloned(),
        IncumbentChoice::Second => second.cloned(),
    }
}

// ===========================================================================
// `sortByPieceId` (`:803-811`)
// ===========================================================================

/// TS: `intrinsicShortSidePairFoldObserver.ts:803-811` (`sortByPieceId`).
/// Plain JS-string `<`/`>` comparison (UTF-16 code-unit order, **not**
/// `localeCompare`) -- reproduced with `str::cmp`, not
/// `locale_compare_keys` (piece IDs are ASCII in every production/fixture
/// case, so ordinal and code-unit order coincide; see `short-side.md` §12).
fn sort_by_piece_id(pieces: &[Arc<IrregularPreparedPiece>]) -> Vec<Arc<IrregularPreparedPiece>> {
    let mut sorted: Vec<Arc<IrregularPreparedPiece>> = pieces.to_vec();
    sorted.sort_by(|first, second| {
        prepared_piece_id(first)
            .as_str()
            .cmp(prepared_piece_id(second).as_str())
    });
    sorted
}

// ===========================================================================
// `evaluateIntrinsicShortSideContactStripPromotion` (`:878-1014`)
// ===========================================================================

/// TS: `intrinsicShortSidePairFoldObserver.ts:878-1014`
/// (`evaluateIntrinsicShortSideContactStripPromotion`). See this module's
/// top doc, "Finding 2": this result is stored only as trace evidence and
/// never gates selection.
fn evaluate_intrinsic_short_side_contact_strip_promotion(
    incumbent: Option<&IntrinsicShortSidePairFoldOutcome>,
    strip: Option<&IntrinsicShortSidePairFoldOutcome>,
    strip_trace: &IntrinsicShortSideContactStripTrace,
) -> IntrinsicShortSideContactStripPromotion {
    let contact_strip_summary = strip.map(|strip| IntrinsicShortSideConstructionSummary {
        used_short_axis_span_mm: strip.trace.used_short_axis_span_mm,
        used_long_axis_depth_mm: strip.trace.used_long_axis_depth_mm,
        envelope_area_mm2: strip.trace.envelope_area_mm2,
        used_short_axis_span_grid: strip.trace.used_short_axis_span_grid,
        used_long_axis_depth_grid: strip.trace.used_long_axis_depth_grid,
        envelope_area_grid2: strip.trace.envelope_area_grid2.clone(),
        collision_material_doubled_area_grid2: strip
            .trace
            .collision_material_doubled_area_grid2
            .clone(),
        admission: strip.trace.admission,
        interlocking: strip.trace.interlocking.clone(),
        status: strip.trace.status,
        failure_reason: strip.trace.failure_reason.clone(),
    });
    let unmeasured = IntrinsicShortSideContactStripPromotion {
        incumbent_construction_kind: incumbent.and_then(|o| o.trace.construction_kind),
        contact_strip_summary: contact_strip_summary.clone(),
        contact_strip_admitted: false,
        fill_not_regressed: None,
        envelope_area_not_regressed: None,
        depth_not_regressed: None,
        density_not_regressed: None,
        hull_gap_not_regressed: None,
        isolated_pieces_not_regressed: None,
        positive_contact_components_not_regressed: None,
        largest_contact_component_not_regressed: None,
        strictly_improved: None,
        promoted: false,
    };
    if strip_trace.status != IntrinsicShortSideContactStripStatus::Constructed || strip.is_none() {
        return unmeasured;
    }
    let strip = strip.expect("checked above");
    let contact_strip_admitted = strip.trace.status == IntrinsicShortSidePairFoldStatus::Accepted;
    let Some(incumbent) = incumbent else {
        return IntrinsicShortSideContactStripPromotion {
            contact_strip_admitted,
            ..unmeasured
        };
    };
    let strip_admission = strip.trace.admission;
    let strip_interlocking = strip.trace.interlocking.clone();
    let incumbent_admission = incumbent.trace.admission;
    let incumbent_interlocking = incumbent.trace.interlocking.clone();
    let strip_exact = exact_promotion_metrics(strip);
    let incumbent_exact = exact_promotion_metrics(incumbent);

    let (Some(_strip_admission), Some(strip_interlocking), Some(strip_exact)) =
        (strip_admission, strip_interlocking, strip_exact)
    else {
        return IntrinsicShortSideContactStripPromotion {
            contact_strip_admitted,
            ..unmeasured
        };
    };
    let (Some(_incumbent_admission), Some(incumbent_interlocking), Some(incumbent_exact)) =
        (incumbent_admission, incumbent_interlocking, incumbent_exact)
    else {
        return IntrinsicShortSideContactStripPromotion {
            contact_strip_admitted,
            fill_not_regressed: Some(true),
            envelope_area_not_regressed: Some(true),
            depth_not_regressed: Some(true),
            density_not_regressed: Some(true),
            hull_gap_not_regressed: Some(true),
            isolated_pieces_not_regressed: Some(true),
            positive_contact_components_not_regressed: Some(true),
            largest_contact_component_not_regressed: Some(true),
            strictly_improved: Some(true),
            promoted: contact_strip_admitted,
            ..unmeasured
        };
    };

    let fill_not_regressed =
        strip_exact.short_axis_span_grid >= incumbent_exact.short_axis_span_grid;
    let envelope_area_not_regressed =
        strip_exact.envelope_area_grid2 <= incumbent_exact.envelope_area_grid2;
    let depth_not_regressed =
        strip_exact.long_axis_depth_grid <= incumbent_exact.long_axis_depth_grid;
    let density_not_regressed = &strip_exact.material_doubled_area_grid2
        * &incumbent_exact.envelope_area_grid2
        >= &incumbent_exact.material_doubled_area_grid2 * &strip_exact.envelope_area_grid2;
    let strip_gap: BigInt = strip_interlocking
        .largest_occupied_hull_gap_doubled_area_grid2
        .parse()
        .expect("hull-gap doubled area is always a valid decimal bigint string");
    let incumbent_hull: BigInt = incumbent_interlocking
        .occupied_hull_doubled_area_grid2
        .parse()
        .expect("hull doubled area is always a valid decimal bigint string");
    let incumbent_gap: BigInt = incumbent_interlocking
        .largest_occupied_hull_gap_doubled_area_grid2
        .parse()
        .expect("hull-gap doubled area is always a valid decimal bigint string");
    let strip_hull: BigInt = strip_interlocking
        .occupied_hull_doubled_area_grid2
        .parse()
        .expect("hull doubled area is always a valid decimal bigint string");
    let hull_gap_not_regressed = &strip_gap * &incumbent_hull <= &incumbent_gap * &strip_hull;
    let isolated_pieces_not_regressed =
        strip_interlocking.isolated_piece_count <= incumbent_interlocking.isolated_piece_count;
    let positive_contact_components_not_regressed = strip_interlocking
        .positive_contact_component_count
        <= incumbent_interlocking.positive_contact_component_count;
    let largest_contact_component_not_regressed = strip_interlocking
        .largest_positive_contact_component_size
        >= incumbent_interlocking.largest_positive_contact_component_size;
    let strictly_improved = strip_exact.short_axis_span_grid > incumbent_exact.short_axis_span_grid
        || strip_exact.envelope_area_grid2 < incumbent_exact.envelope_area_grid2
        || strip_exact.long_axis_depth_grid < incumbent_exact.long_axis_depth_grid
        || &strip_exact.material_doubled_area_grid2 * &incumbent_exact.envelope_area_grid2
            > &incumbent_exact.material_doubled_area_grid2 * &strip_exact.envelope_area_grid2
        || &strip_gap * &incumbent_hull < &incumbent_gap * &strip_hull
        || strip_interlocking.isolated_piece_count < incumbent_interlocking.isolated_piece_count
        || strip_interlocking.positive_contact_component_count
            < incumbent_interlocking.positive_contact_component_count
        || strip_interlocking.largest_positive_contact_component_size
            > incumbent_interlocking.largest_positive_contact_component_size;

    IntrinsicShortSideContactStripPromotion {
        incumbent_construction_kind: incumbent.trace.construction_kind,
        contact_strip_summary,
        contact_strip_admitted,
        fill_not_regressed: Some(fill_not_regressed),
        envelope_area_not_regressed: Some(envelope_area_not_regressed),
        depth_not_regressed: Some(depth_not_regressed),
        density_not_regressed: Some(density_not_regressed),
        hull_gap_not_regressed: Some(hull_gap_not_regressed),
        isolated_pieces_not_regressed: Some(isolated_pieces_not_regressed),
        positive_contact_components_not_regressed: Some(positive_contact_components_not_regressed),
        largest_contact_component_not_regressed: Some(largest_contact_component_not_regressed),
        strictly_improved: Some(strictly_improved),
        promoted: contact_strip_admitted
            && fill_not_regressed
            && envelope_area_not_regressed
            && depth_not_regressed
            && density_not_regressed
            && hull_gap_not_regressed
            && isolated_pieces_not_regressed
            && positive_contact_components_not_regressed
            && largest_contact_component_not_regressed
            && strictly_improved,
    }
}

// ===========================================================================
// `physicalDimensions` / `collisionMaterialArea` / `shortAxisProjectionMetrics`
// (`:1470-1572`)
// ===========================================================================

struct PhysicalDimensions {
    short_axis_mm: f64,
    long_axis_mm: f64,
    requested_short_axis_mm: f64,
    requested_long_axis_mm: f64,
    short_axis_grid: f64,
    long_axis_grid: f64,
    requested_short_axis_grid: f64,
    /// TS: `physicalDimensions`'s returned `requestedLongAxisGrid`
    /// (`:1470-1511`) -- computed but never read back off the returned
    /// `dimensions` object by `finalizeOutcome` (`:1271-1468`) or any other
    /// TS call site. Kept for exact structural fidelity with the TS type.
    #[allow(dead_code)]
    requested_long_axis_grid: f64,
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1470-1511`
/// (`physicalDimensions`). No safe-integer validation on `widthGrid`/
/// `heightGrid` -- unlike `observer::canonical_dimensions`, this TS function
/// has none, and this port must not add any.
fn physical_dimensions(
    placed: &[IrregularPlacedPiece],
    sheet: &SheetSpec,
) -> Option<PhysicalDimensions> {
    let points: Vec<crate::canonical_grid::CanonicalGridPoint> = placed
        .iter()
        .flat_map(|entry| placed_collision_world_grid_path(entry).unwrap_or_default())
        .collect();
    if points.is_empty() {
        return None;
    }
    let xs: Vec<f64> = points.iter().map(|p| p.x).collect();
    let ys: Vec<f64> = points.iter().map(|p| p.y).collect();
    let width_grid = js_math::max_all(&xs) - js_math::min_all(&xs);
    let height_grid = js_math::max_all(&ys) - js_math::min_all(&ys);
    let requested_short_axis_mm = js_math::min(sheet.width, sheet.height);
    let requested_long_axis_mm = js_math::max(sheet.width, sheet.height);
    let requested_short_axis_grid = to_grid_mm(requested_short_axis_mm)?;
    let requested_long_axis_grid = to_grid_mm(requested_long_axis_mm)?;
    let axes = intrinsic_short_side_axes(sheet);
    let short_axis_grid = if axes.short_axis == ShortSideAxisDimension::Width {
        width_grid
    } else {
        height_grid
    };
    let long_axis_grid = if axes.long_axis == ShortSideAxisDimension::Width {
        width_grid
    } else {
        height_grid
    };
    Some(PhysicalDimensions {
        short_axis_mm: from_grid(short_axis_grid),
        long_axis_mm: from_grid(long_axis_grid),
        requested_short_axis_mm,
        requested_long_axis_mm,
        short_axis_grid,
        long_axis_grid,
        requested_short_axis_grid,
        requested_long_axis_grid,
    })
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1513-1530`
/// (`collisionMaterialArea`). Exact BigInt shoelace sum, never converted to
/// `Number` until final display.
fn collision_material_area(placed: &[IrregularPlacedPiece]) -> Option<BigInt> {
    let mut doubled_area_grid2 = BigInt::from(0);
    for entry in placed {
        let path = placed_collision_world_grid_path(entry)?;
        let mut signed = BigInt::from(0);
        for index in 0..path.len() {
            let point = path[index];
            let next = path[(index + 1) % path.len()];
            signed += f64_to_bigint(point.x) * f64_to_bigint(next.y)
                - f64_to_bigint(next.x) * f64_to_bigint(point.y);
        }
        doubled_area_grid2 += if signed < BigInt::from(0) {
            -signed
        } else {
            signed
        };
    }
    Some(doubled_area_grid2)
}

struct ShortAxisProjectionMetrics {
    coverage_ratio: f64,
    component_count: f64,
    covered_grid: f64,
    span_grid: f64,
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1532-1572`
/// (`shortAxisProjectionMetrics`).
fn short_axis_projection_metrics(
    placed: &[IrregularPlacedPiece],
    sheet: &SheetSpec,
) -> ShortAxisProjectionMetrics {
    let short_axis = intrinsic_short_side_axes(sheet).short_axis;
    let mut intervals: Vec<(f64, f64)> = placed
        .iter()
        .flat_map(|entry| {
            let path = placed_collision_world_grid_path(entry).unwrap_or_default();
            if path.is_empty() {
                return Vec::new();
            }
            let values: Vec<f64> = path
                .iter()
                .map(|point| {
                    if short_axis == ShortSideAxisDimension::Width {
                        point.x
                    } else {
                        point.y
                    }
                })
                .collect();
            vec![(js_math::min_all(&values), js_math::max_all(&values))]
        })
        .collect();
    intervals.sort_by(|first, second| compare_f64(first.0, second.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for interval in intervals {
        match merged.last_mut() {
            Some(last) if interval.0 <= last.1 => {
                last.1 = js_math::max(last.1, interval.1);
            }
            _ => merged.push(interval),
        }
    }
    let (Some(&first), Some(&last)) = (merged.first(), merged.last()) else {
        return ShortAxisProjectionMetrics {
            coverage_ratio: 0.0,
            component_count: 0.0,
            covered_grid: 0.0,
            span_grid: 0.0,
        };
    };
    let span = last.1 - first.0;
    let covered: f64 = merged.iter().map(|interval| interval.1 - interval.0).sum();
    ShortAxisProjectionMetrics {
        coverage_ratio: if span <= 0.0 { 1.0 } else { covered / span },
        component_count: merged.len() as f64,
        covered_grid: covered,
        span_grid: span,
    }
}

// ===========================================================================
// `withMeasuredIntrinsicShortSidePairFoldTrace` (`:1654-1676`)
// ===========================================================================

/// TS: `intrinsicShortSidePairFoldObserver.ts:1654-1665`
/// (`withMeasuredIntrinsicShortSidePairFoldTrace`). Two-pass, not
/// fixpoint-iterated -- see `short-side.md` §8.1.
pub fn with_measured_trace(
    trace: IntrinsicShortSidePairFoldTrace,
) -> IntrinsicShortSidePairFoldTrace {
    let first_measurement = byte_length(&trace.to_json()) as f64;
    let measured = IntrinsicShortSidePairFoldTrace {
        serialized_trace_bytes: first_measurement,
        ..trace
    };
    let final_measurement = byte_length(&measured.to_json()) as f64;
    IntrinsicShortSidePairFoldTrace {
        serialized_trace_bytes: final_measurement,
        ..measured
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1671-1676`
/// (`selectedOutputTraceSize`).
fn selected_output_trace_size(trace: &IntrinsicShortSidePairFoldTrace) -> f64 {
    let selected = IntrinsicShortSidePairFoldTrace {
        output_influence: super::observer::ShortSideOutputInfluence::Selected,
        ..trace.clone()
    };
    with_measured_trace(selected).serialized_trace_bytes
}

// ===========================================================================
// `finalizeOutcome` / `finalizePlacedLayout` (`:1177-1468`)
// ===========================================================================

/// TS: `intrinsicShortSidePairFoldObserver.ts:240-251` /
/// `:306-317` (`observeIntrinsicShortSidePairFold`'s input, reused verbatim
/// as `TerminalObserverInput` -- one Rust type serves both roles, since
/// nothing structurally distinguishes them here).
pub struct IntrinsicShortSidePairFoldInput<'a> {
    pub sheet: &'a SheetSpec,
    pub prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    pub settings: &'a IrregularNestingSettings,
    pub production_short_axis_span_mm: f64,
    pub production_maximum_side_mm: f64,
    pub production_envelope_area_mm2: f64,
    pub production_short_axis_span_grid: f64,
    pub production_maximum_side_grid: f64,
    pub production_envelope_area_grid2: String,
    pub runtime_control: Option<IntrinsicShortSidePairFoldRuntimeControl<'a>>,
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1586-1652` (`failedOutcome`).
/// Every default-valued TS parameter (`transformEvaluations`,
/// `expectedPairCount`, `evaluatedPairCount`) is, at every real call site,
/// passed the exact current `runtime` field value the default itself would
/// read -- see this function's own doc for why this Rust port always reads
/// `runtime` directly instead of threading redundant override parameters.
fn failed_outcome(
    input: &IntrinsicShortSidePairFoldInput<'_>,
    runtime: &ObserverRuntime<'_>,
    status: IntrinsicShortSidePairFoldStatus,
    failure_reason: String,
    placed_count: f64,
    selected_bottom_piece_id: Option<PieceId>,
    selected_upper_piece_id: Option<PieceId>,
) -> IntrinsicShortSidePairFoldOutcome {
    let axes = intrinsic_short_side_axes(input.sheet);
    IntrinsicShortSidePairFoldOutcome {
        trace: with_measured_trace(IntrinsicShortSidePairFoldTrace {
            version: INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION,
            status,
            output_influence: super::observer::ShortSideOutputInfluence::None,
            execution_model: "single-process-sequential",
            requested_short_axis_mm: axes.short_axis_mm,
            requested_long_axis_mm: axes.long_axis_mm,
            prescribed_rotation_deg: Some(axes.normalized_to_physical_rotation_deg),
            production_short_axis_span_mm: input.production_short_axis_span_mm,
            production_maximum_side_mm: input.production_maximum_side_mm,
            production_envelope_area_mm2: input.production_envelope_area_mm2,
            production_short_axis_span_grid: input.production_short_axis_span_grid,
            production_maximum_side_grid: input.production_maximum_side_grid,
            production_envelope_area_grid2: input.production_envelope_area_grid2.clone(),
            transform_evaluations: runtime.transform_evaluations,
            expected_pair_count: runtime.expected_pair_count,
            evaluated_pair_count: runtime.evaluated_pair_count,
            construction_kind: None,
            row_count: 0.0,
            selected_bottom_piece_id,
            selected_upper_piece_id,
            placed_count,
            used_short_axis_span_mm: None,
            used_long_axis_depth_mm: None,
            envelope_area_mm2: None,
            used_short_axis_span_grid: None,
            used_long_axis_depth_grid: None,
            envelope_area_grid2: None,
            collision_material_doubled_area_grid2: None,
            canonical_geometry_hash: None,
            admission: None,
            interlocking: None,
            envelope_area_cost_veto_observed: runtime.envelope_area_cost_veto_observed,
            envelope_area_cost_vetoes: runtime.envelope_area_cost_vetoes.clone(),
            contact_strip: None,
            contact_strip_lanes: Vec::new(),
            contact_strip_promotion: None,
            runtime_ms: js_math::max(0.0, (runtime.now)() - runtime.started_at),
            peak_rss_delta_bytes: sample_rss(runtime),
            serialized_trace_bytes: 0.0,
            failure_reason: Some(failure_reason),
        }),
        placed_collision_geometries: None,
    }
}

struct FinalizeOutcomeInput<'a> {
    input: &'a IntrinsicShortSidePairFoldInput<'a>,
    state: &'a IrregularBeamState,
    prescribed_rotation_deg: ShortSideRotationDeg,
    construction_kind: IntrinsicShortSideConstructionKind,
    row_count: f64,
    selected_bottom_piece_id: Option<PieceId>,
    selected_upper_piece_id: Option<PieceId>,
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1271-1468` (`finalizeOutcome`).
/// See this module's top doc, "Finding 3": `exact_target_identity` is the
/// entire acceptance rule; every fill/depth/projection/cavity/density/
/// area-cost term below is evidence only.
fn finalize_outcome(
    params: FinalizeOutcomeInput<'_>,
    runtime: &mut ObserverRuntime<'_>,
) -> IntrinsicShortSidePairFoldOutcome {
    let placed = &params.state.placed_collision_geometries;
    let placed_owned = cloned_placed(placed);
    let dimensions = physical_dimensions(&placed_owned, params.input.sheet);
    let topology_exact = measure_canonical_layout_topology_exact(&placed_owned);
    let contacts = measure_canonical_layout_contacts(&placed_owned);
    let material = collision_material_area(&placed_owned);
    let identity = canonical_collision_layout_identity(&placed_owned);
    let (
        Some(dimensions),
        Some(topology_exact),
        Some(contacts),
        Some(material_doubled_area_grid2),
        Some(identity),
    ) = (dimensions, topology_exact, contacts, material, identity)
    else {
        return failed_outcome(
            params.input,
            runtime,
            IntrinsicShortSidePairFoldStatus::FailedProtectedFallback,
            "exact terminal construction metrics could not be materialized.".to_string(),
            placed.len() as f64,
            params.selected_bottom_piece_id,
            params.selected_upper_piece_id,
        );
    };
    let topology = topology_exact.topology;
    let envelope_area_grid2 =
        f64_to_bigint(dimensions.short_axis_grid) * f64_to_bigint(dimensions.long_axis_grid);
    let envelope_area_mm2 = bigint_to_number(&envelope_area_grid2) / 1_000_000.0;
    let fill_ratio = dimensions.short_axis_grid / dimensions.requested_short_axis_grid;
    let density = if envelope_area_grid2 <= BigInt::from(0) {
        0.0
    } else {
        bigint_to_number(&material_doubled_area_grid2)
            / (2.0 * bigint_to_number(&envelope_area_grid2))
    };
    let projection = short_axis_projection_metrics(&placed_owned, params.input.sheet);
    let production_short_axis_span_grid = params.input.production_short_axis_span_grid;
    let production_maximum_side_grid = params.input.production_maximum_side_grid;
    let production_envelope_area_grid2: BigInt = params
        .input
        .production_envelope_area_grid2
        .parse()
        .expect("productionEnvelopeAreaGrid2 is always a valid decimal bigint string");
    if !is_safe_integer(production_short_axis_span_grid)
        || !is_safe_integer(production_maximum_side_grid)
        || production_short_axis_span_grid <= 0.0
        || production_envelope_area_grid2 <= BigInt::from(0)
    {
        return failed_outcome(
            params.input,
            runtime,
            IntrinsicShortSidePairFoldStatus::FailedProtectedFallback,
            "production comparison metrics must fit the canonical grid.".to_string(),
            placed.len() as f64,
            params.selected_bottom_piece_id,
            params.selected_upper_piece_id,
        );
    }
    let short_axis_span_gain_factor = dimensions.short_axis_grid / production_short_axis_span_grid;
    let envelope_area_cost_factor =
        bigint_to_number(&envelope_area_grid2) / bigint_to_number(&production_envelope_area_grid2);
    let depth_within_production_maximum_side =
        dimensions.long_axis_grid <= production_maximum_side_grid;
    let directionally_efficient = f64_to_bigint(dimensions.short_axis_grid)
        * &production_envelope_area_grid2
        >= f64_to_bigint(production_short_axis_span_grid) * &envelope_area_grid2;
    let expected_piece_ids: Vec<PieceId> = params
        .input
        .prepared_pieces
        .iter()
        .map(|p| prepared_piece_id(p))
        .collect();
    let placed_piece_ids: Vec<PieceId> = placed.iter().map(|p| placed_piece_id(p)).collect();
    let expected_set: HashSet<&PieceId> = expected_piece_ids.iter().collect();
    let placed_set: HashSet<&PieceId> = placed_piece_ids.iter().collect();
    let exact_target_identity = expected_set.len() == expected_piece_ids.len()
        && placed_set.len() == placed_piece_ids.len()
        && placed_piece_ids.len() == expected_piece_ids.len()
        && expected_piece_ids.iter().all(|id| placed_set.contains(id));
    let envelope_area_cost_within_production_bound =
        intrinsic_short_side_envelope_area_cost_within_production_bound(
            &envelope_area_grid2,
            &production_envelope_area_grid2,
        );
    let admitted_besides_area_cost = exact_target_identity
        && BigInt::from(5) * f64_to_bigint(dimensions.short_axis_grid)
            >= BigInt::from(4) * f64_to_bigint(dimensions.requested_short_axis_grid)
        && depth_within_production_maximum_side
        && (projection.span_grid <= 0.0
            || BigInt::from(100) * f64_to_bigint(projection.covered_grid)
                >= BigInt::from(99) * f64_to_bigint(projection.span_grid))
        && projection.component_count == 1.0
        && topology.enclosed_cavity_count == 0.0
        && material_doubled_area_grid2 >= envelope_area_grid2
        && directionally_efficient;
    let admission = IntrinsicShortSidePairFoldAdmission {
        exact_legal: true,
        all_pieces_placed: exact_target_identity,
        fill_ratio,
        depth_within_production_maximum_side,
        projection_coverage_ratio: projection.coverage_ratio,
        projection_component_count: projection.component_count,
        enclosed_cavity_count: Some(topology.enclosed_cavity_count),
        collision_envelope_density: density,
        short_axis_span_gain_factor,
        envelope_area_cost_factor,
        directionally_efficient,
        envelope_area_cost_within_production_bound,
        accepted: false,
    };
    let accepted = exact_target_identity;
    let measured_admission = IntrinsicShortSidePairFoldAdmission {
        accepted,
        ..admission
    };
    if !envelope_area_cost_within_production_bound && admitted_besides_area_cost {
        runtime.envelope_area_cost_veto_observed = true;
        runtime
            .envelope_area_cost_vetoes
            .push(IntrinsicShortSideEnvelopeAreaCostVeto {
                construction_kind: params.construction_kind,
                admission: measured_admission,
            });
    }
    let interlocking = IntrinsicShortSideInterlockingMetrics {
        largest_occupied_hull_gap_ratio: topology.largest_occupied_hull_gap_ratio,
        largest_occupied_hull_gap_doubled_area_grid2: topology_exact
            .exact_hull_gap_doubled_area_grid2,
        occupied_hull_doubled_area_grid2: topology_exact.exact_hull_doubled_area_grid2,
        isolated_piece_count: topology.isolated_piece_count,
        positive_contact_component_count: topology.positive_contact_component_count,
        largest_positive_contact_component_size: topology.largest_positive_contact_component_size,
        shared_boundary_length_mm: contacts.shared_boundary_length_mm,
    };
    let raw_trace = IntrinsicShortSidePairFoldTrace {
        version: INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION,
        status: if accepted {
            IntrinsicShortSidePairFoldStatus::Accepted
        } else {
            IntrinsicShortSidePairFoldStatus::RejectedAdmission
        },
        output_influence: super::observer::ShortSideOutputInfluence::None,
        execution_model: "single-process-sequential",
        requested_short_axis_mm: dimensions.requested_short_axis_mm,
        requested_long_axis_mm: dimensions.requested_long_axis_mm,
        prescribed_rotation_deg: Some(params.prescribed_rotation_deg),
        production_short_axis_span_mm: params.input.production_short_axis_span_mm,
        production_maximum_side_mm: params.input.production_maximum_side_mm,
        production_envelope_area_mm2: params.input.production_envelope_area_mm2,
        production_short_axis_span_grid: params.input.production_short_axis_span_grid,
        production_maximum_side_grid: params.input.production_maximum_side_grid,
        production_envelope_area_grid2: params.input.production_envelope_area_grid2.clone(),
        transform_evaluations: runtime.transform_evaluations,
        expected_pair_count: runtime.expected_pair_count,
        evaluated_pair_count: runtime.evaluated_pair_count,
        construction_kind: Some(params.construction_kind),
        row_count: params.row_count,
        selected_bottom_piece_id: params.selected_bottom_piece_id,
        selected_upper_piece_id: params.selected_upper_piece_id,
        placed_count: placed.len() as f64,
        used_short_axis_span_mm: Some(dimensions.short_axis_mm),
        used_long_axis_depth_mm: Some(dimensions.long_axis_mm),
        envelope_area_mm2: Some(envelope_area_mm2),
        used_short_axis_span_grid: Some(dimensions.short_axis_grid),
        used_long_axis_depth_grid: Some(dimensions.long_axis_grid),
        envelope_area_grid2: Some(envelope_area_grid2.to_string()),
        collision_material_doubled_area_grid2: Some(material_doubled_area_grid2.to_string()),
        canonical_geometry_hash: Some(sha256_hex(&identity)),
        admission: Some(measured_admission),
        interlocking: Some(interlocking),
        envelope_area_cost_veto_observed: runtime.envelope_area_cost_veto_observed,
        envelope_area_cost_vetoes: runtime.envelope_area_cost_vetoes.clone(),
        contact_strip: None,
        contact_strip_lanes: Vec::new(),
        contact_strip_promotion: None,
        runtime_ms: js_math::max(0.0, (runtime.now)() - runtime.started_at),
        peak_rss_delta_bytes: sample_rss(runtime),
        serialized_trace_bytes: 0.0,
        failure_reason: if accepted {
            None
        } else {
            Some("the exact terminal construction failed one or more admission gates.".to_string())
        },
    };
    IntrinsicShortSidePairFoldOutcome {
        trace: with_measured_trace(raw_trace),
        placed_collision_geometries: if accepted { Some(placed.clone()) } else { None },
    }
}

struct FinalizePlacedLayoutInput<'a> {
    input: &'a IntrinsicShortSidePairFoldInput<'a>,
    placed: Vec<Arc<IrregularPlacedPiece>>,
    construction_kind: IntrinsicShortSideConstructionKind,
    row_count: f64,
    selected_bottom_piece_id: Option<PieceId>,
    selected_upper_piece_id: Option<PieceId>,
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:1177-1269`
/// (`finalizePlacedLayout`).
fn finalize_placed_layout(
    params: FinalizePlacedLayoutInput<'_>,
    runtime: &mut ObserverRuntime<'_>,
) -> IntrinsicShortSidePairFoldOutcome {
    if let Some(bounded) = bounded_status(runtime) {
        return failed_outcome(
            params.input,
            runtime,
            bounded.to_status(),
            format!("{} reached before exact finalization.", bounded.as_str()),
            params.placed.len() as f64,
            params.selected_bottom_piece_id,
            params.selected_upper_piece_id,
        );
    }
    let normalized_state = IrregularBeamState::from_input(IrregularBeamStateInput {
        remaining_prepared_pieces: Vec::new(),
        placed_collision_geometries: params.placed,
        unplaced_piece_ids: None,
        unplaced_source_piece_ids: None,
        placement_order: params
            .input
            .prepared_pieces
            .iter()
            .map(|p| prepared_piece_id(p))
            .collect(),
        parent: None,
        placed_collision_index: None,
    });
    let placed_count_for_failure = normalized_state.placed_collision_geometries.len() as f64;
    let prescribed_rotation_deg =
        intrinsic_short_side_axes(params.input.sheet).normalized_to_physical_rotation_deg;
    let physical_state =
        normalized_state.with_quarter_turn_bottom_left(prescribed_rotation_deg.as_quarter_turn());
    let legal_physical_state = physical_state.filter(|state| {
        assert_canonical_grid_legal_layout(
            params.input.sheet,
            &cloned_placed(&state.placed_collision_geometries),
        )
    });
    let Some(physical_state) = legal_physical_state else {
        return failed_outcome(
            params.input,
            runtime,
            IntrinsicShortSidePairFoldStatus::FailedProtectedFallback,
            "the prescribed physical terminal orientation failed exact legality.".to_string(),
            placed_count_for_failure,
            params.selected_bottom_piece_id,
            params.selected_upper_piece_id,
        );
    };
    let outcome = finalize_outcome(
        FinalizeOutcomeInput {
            input: params.input,
            state: &physical_state,
            prescribed_rotation_deg,
            construction_kind: params.construction_kind,
            row_count: params.row_count,
            selected_bottom_piece_id: params.selected_bottom_piece_id.clone(),
            selected_upper_piece_id: params.selected_upper_piece_id.clone(),
        },
        runtime,
    );
    if let Some(bounded) = bounded_status(runtime) {
        return failed_outcome(
            params.input,
            runtime,
            bounded.to_status(),
            format!("{} reached after exact finalization.", bounded.as_str()),
            placed_count_for_failure,
            params.selected_bottom_piece_id,
            params.selected_upper_piece_id,
        );
    }
    if selected_output_trace_size(&outcome.trace) > runtime.maximum_trace_bytes {
        return failed_outcome(
            params.input,
            runtime,
            IntrinsicShortSidePairFoldStatus::TraceCap,
            "stabilized terminal short-side trace exceeds its byte cap.".to_string(),
            placed_count_for_failure,
            params.selected_bottom_piece_id,
            params.selected_upper_piece_id,
        );
    }
    outcome
}

// ===========================================================================
// `constructPairFold` (`:319-763`)
// ===========================================================================

/// Composes one contact-strip runtime control sharing this observer's clock
/// and RSS-peak-tracking side effect, and budget-composed-downward caps
/// (`intrinsicShortSidePairFoldObserver.ts:535-542` etc).
fn strip_runtime_control<'a>(
    runtime: &'a ObserverRuntime<'a>,
    maximum_candidate_evaluations: Option<f64>,
    maximum_backtracks: Option<f64>,
) -> IntrinsicShortSideContactStripRuntimeControl<'a> {
    let outer_runtime_remaining_ms = js_math::max(
        0.0,
        runtime.maximum_runtime_ms - ((runtime.now)() - runtime.started_at),
    );
    let outer_rss_remaining_bytes =
        js_math::max(0.0, runtime.maximum_rss_delta_bytes - sample_rss(runtime));
    IntrinsicShortSideContactStripRuntimeControl {
        maximum_runtime_ms: Some(js_math::min(
            INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS,
            outer_runtime_remaining_ms,
        )),
        maximum_rss_delta_bytes: Some(js_math::min(
            INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES,
            outer_rss_remaining_bytes,
        )),
        maximum_candidate_evaluations,
        maximum_backtracks,
        now: Some(runtime.now),
        // Boxed: this closure is a fresh temporary constructed on every
        // call, capturing `runtime` by reference -- see
        // `IntrinsicShortSideContactStripRuntimeControl::current_rss_bytes`'s
        // own doc comment for why a plain `&'a dyn Fn() -> f64` cannot
        // borrow it.
        current_rss_bytes: Some(Box::new(move || sample_rss_side_effect(runtime))),
    }
}

/// The wrapped `currentRssBytes` closure body
/// (`intrinsicShortSidePairFoldObserver.ts:544-548` etc): samples the outer
/// observer's own RSS source and folds it into `runtime.peak_rss_bytes` as a
/// side effect, then returns the sampled value.
fn sample_rss_side_effect(runtime: &ObserverRuntime<'_>) -> f64 {
    let current = (runtime.current_rss_bytes)();
    runtime
        .peak_rss_bytes
        .set(js_math::max(runtime.peak_rss_bytes.get(), current));
    current
}

// TS: `intrinsicShortSidePairFoldObserver.ts:525-529` -- the strip sheet
// literal never actually reads `input.sheet` (only `requestedShortAxisMm`
// and `axes.longAxisMm`), so `sheet` is intentionally unused here too; kept
// as a parameter (prefixed `_`) so every call site still reads naturally as
// "the strip derived from this sheet's short/long axes".
fn strip_sheet(_sheet: &SheetSpec, requested_short_axis_mm: f64, long_axis_mm: f64) -> SheetSpec {
    SheetSpec {
        width: requested_short_axis_mm,
        height: long_axis_mm,
        label: format!("short-side-strip-{requested_short_axis_mm}x{long_axis_mm}"),
    }
}

/// TS: `intrinsicShortSidePairFoldObserver.ts:319-763` (`constructPairFold`).
fn construct_pair_fold(
    input: &IntrinsicShortSidePairFoldInput<'_>,
    runtime: &mut ObserverRuntime<'_>,
    geometry_cache: &mut GeometryCacheStore,
) -> Result<IntrinsicShortSidePairFoldOutcome, IrregularGeometryInputError> {
    let axes = intrinsic_short_side_axes(input.sheet);
    let requested_short_axis_mm = axes.short_axis_mm;
    let Some(requested_short_axis_grid) = to_grid_mm(requested_short_axis_mm) else {
        return Ok(failed_outcome(
            input,
            runtime,
            IntrinsicShortSidePairFoldStatus::FailedProtectedFallback,
            "requested sheet axes must fit the canonical grid.".to_string(),
            0.0,
            None,
            None,
        ));
    };
    let Some(requested_long_axis_grid) = to_grid_mm(axes.long_axis_mm) else {
        return Ok(failed_outcome(
            input,
            runtime,
            IntrinsicShortSidePairFoldStatus::FailedProtectedFallback,
            "requested sheet axes must fit the canonical grid.".to_string(),
            0.0,
            None,
            None,
        ));
    };

    let mut selected_transforms: Vec<SelectedTransform> = Vec::new();
    let mut shelf_transforms: Vec<SelectedTransform> = Vec::new();
    for piece in input.prepared_pieces {
        let mut selected: Option<SelectedTransform> = None;
        let mut shelf_selected: Option<SelectedTransform> = None;
        for transform in &piece.transforms {
            runtime.transform_evaluations += 1.0;
            let geometry = transform_collision_geometry(
                &piece.collision_geometry,
                transform,
                &input.settings.geometry,
                geometry_cache,
            )?;
            if let Some(bounded) = bounded_status(runtime) {
                return Ok(failed_outcome(
                    input,
                    runtime,
                    bounded.to_status(),
                    format!(
                        "{} reached after {} transform evaluations.",
                        bounded.as_str(),
                        runtime.transform_evaluations
                    ),
                    0.0,
                    None,
                    None,
                ));
            }
            let (Some(min_x_grid), Some(min_y_grid), Some(max_x_grid), Some(max_y_grid)) = (
                to_grid_mm(geometry.bounds.min_x),
                to_grid_mm(geometry.bounds.min_y),
                to_grid_mm(geometry.bounds.max_x),
                to_grid_mm(geometry.bounds.max_y),
            ) else {
                continue;
            };
            let candidate = SelectedTransform {
                piece: Arc::clone(piece),
                piece_id: prepared_piece_id(piece),
                geometry,
                width_grid: max_x_grid - min_x_grid,
                height_grid: max_y_grid - min_y_grid,
                min_x_grid,
                min_y_grid,
            };
            if candidate.width_grid <= 0.0 || candidate.height_grid <= 0.0 {
                continue;
            }
            if selected.is_none()
                || compare_selected_transforms(
                    &candidate,
                    selected.as_ref().expect("checked above"),
                ) == Ordering::Less
            {
                selected = Some(candidate.clone());
            }
            if shelf_selected.is_none()
                || compare_shelf_transforms(
                    &candidate,
                    shelf_selected.as_ref().expect("checked above"),
                ) == Ordering::Less
            {
                shelf_selected = Some(candidate);
            }
        }
        let (Some(selected), Some(shelf_selected)) = (selected, shelf_selected) else {
            return Ok(failed_outcome(
                input,
                runtime,
                IntrinsicShortSidePairFoldStatus::FailedProtectedFallback,
                format!(
                    "piece {} has no valid pair-fold transform.",
                    prepared_piece_id(piece).as_str()
                ),
                0.0,
                None,
                None,
            ));
        };
        selected_transforms.push(selected);
        shelf_transforms.push(shelf_selected);
    }

    runtime.expected_pair_count =
        selected_transforms.len() as f64 * (selected_transforms.len() as f64 - 1.0) / 2.0;
    let total_width_grid: f64 = selected_transforms.iter().map(|s| s.width_grid).sum();
    let mut selected_pair: Option<SelectedPair> = None;
    for bottom_index in 0..selected_transforms.len().saturating_sub(1) {
        let bottom = &selected_transforms[bottom_index];
        for upper_index in (bottom_index + 1)..selected_transforms.len() {
            let upper = &selected_transforms[upper_index];
            if let Some(bounded) = bounded_status(runtime) {
                return Ok(failed_outcome(
                    input,
                    runtime,
                    bounded.to_status(),
                    format!(
                        "{} reached after {} pair evaluations.",
                        bounded.as_str(),
                        runtime.evaluated_pair_count
                    ),
                    0.0,
                    None,
                    None,
                ));
            }
            let width_grid = total_width_grid - bottom.width_grid - upper.width_grid
                + js_math::max(bottom.width_grid, upper.width_grid);
            let other_maximum_height_grid = selected_transforms.iter().enumerate().fold(
                0.0_f64,
                |maximum, (index, selected)| {
                    if index == bottom_index || index == upper_index {
                        maximum
                    } else {
                        js_math::max(maximum, selected.height_grid)
                    }
                },
            );
            let depth_grid = js_math::max(
                bottom.height_grid + upper.height_grid,
                other_maximum_height_grid,
            );
            runtime.evaluated_pair_count += 1.0;
            if let Some(bounded) = bounded_status(runtime) {
                return Ok(failed_outcome(
                    input,
                    runtime,
                    bounded.to_status(),
                    format!(
                        "{} reached after {} pair evaluations.",
                        bounded.as_str(),
                        runtime.evaluated_pair_count
                    ),
                    0.0,
                    None,
                    None,
                ));
            }
            if width_grid > requested_short_axis_grid || depth_grid > requested_long_axis_grid {
                continue;
            }
            let candidate = SelectedPair {
                bottom_index,
                upper_index,
                width_grid,
                depth_grid,
                envelope_area_grid2: f64_to_bigint(width_grid) * f64_to_bigint(depth_grid),
            };
            let replace = match &selected_pair {
                None => true,
                Some(current) => {
                    compare_selected_pairs(&candidate, current, &selected_transforms)
                        == Ordering::Less
                }
            };
            if replace {
                selected_pair = Some(candidate);
            }
        }
    }

    let mut pair_outcome: Option<IntrinsicShortSidePairFoldOutcome> = None;
    if let Some(selected_pair) = &selected_pair {
        let pair_placed = construct_pair_layout(
            &selected_transforms,
            selected_pair,
            requested_short_axis_grid,
        );
        let Some(pair_placed) = pair_placed else {
            return Ok(failed_outcome(
                input,
                runtime,
                IntrinsicShortSidePairFoldStatus::FailedProtectedFallback,
                "selected pair accounting exceeded the requested short axis.".to_string(),
                0.0,
                None,
                None,
            ));
        };
        pair_outcome = Some(finalize_placed_layout(
            FinalizePlacedLayoutInput {
                input,
                placed: pair_placed,
                construction_kind: IntrinsicShortSideConstructionKind::PairFold,
                row_count: 1.0,
                selected_bottom_piece_id: Some(
                    selected_transforms[selected_pair.bottom_index]
                        .piece_id
                        .clone(),
                ),
                selected_upper_piece_id: Some(
                    selected_transforms[selected_pair.upper_index]
                        .piece_id
                        .clone(),
                ),
            },
            runtime,
        ));
    }

    let shelf = construct_next_fit_shelf(
        &shelf_transforms,
        requested_short_axis_grid,
        requested_long_axis_grid,
    );
    let shelf_outcome = shelf.map(|shelf| {
        finalize_placed_layout(
            FinalizePlacedLayoutInput {
                input,
                placed: shelf.placed,
                construction_kind: IntrinsicShortSideConstructionKind::MultiRowShelf,
                row_count: shelf.row_count,
                selected_bottom_piece_id: None,
                selected_upper_piece_id: None,
            },
            runtime,
        )
    });
    let incumbent = select_directional_incumbent(pair_outcome.as_ref(), shelf_outcome.as_ref());

    let depth_strip = construct_intrinsic_short_side_contact_strip(
        ConstructIntrinsicShortSideContactStripInput {
            strip_sheet: &strip_sheet(input.sheet, requested_short_axis_mm, axes.long_axis_mm),
            prepared_pieces: input.prepared_pieces,
            settings: input.settings,
            selection_policy: Some(IntrinsicShortSideContactStripSelectionPolicy::DepthFirst),
            order_policy: Some(IntrinsicShortSideContactStripOrderPolicy::Prepared),
            runtime_control: Some(strip_runtime_control(runtime, None, None)),
        },
        geometry_cache,
        None,
    );
    if let Some(bounded) = bounded_status(runtime) {
        return Ok(failed_outcome(
            input,
            runtime,
            bounded.to_status(),
            format!(
                "{} reached during depth-first contact-strip construction.",
                bounded.as_str()
            ),
            0.0,
            None,
            None,
        ));
    }
    let depth_strip_outcome = depth_strip
        .placed_collision_geometries
        .clone()
        .map(|placed| {
            finalize_placed_layout(
                FinalizePlacedLayoutInput {
                    input,
                    placed,
                    construction_kind: IntrinsicShortSideConstructionKind::ContactStrip,
                    row_count: 0.0,
                    selected_bottom_piece_id: None,
                    selected_upper_piece_id: None,
                },
                runtime,
            )
        });

    let contact_strip = construct_intrinsic_short_side_contact_strip(
        ConstructIntrinsicShortSideContactStripInput {
            strip_sheet: &strip_sheet(input.sheet, requested_short_axis_mm, axes.long_axis_mm),
            prepared_pieces: input.prepared_pieces,
            settings: input.settings,
            selection_policy: Some(IntrinsicShortSideContactStripSelectionPolicy::ContactFirst),
            order_policy: Some(IntrinsicShortSideContactStripOrderPolicy::Prepared),
            runtime_control: Some(strip_runtime_control(
                runtime,
                Some(INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_CANDIDATE_EVALUATIONS),
                Some(INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_BACKTRACKS),
            )),
        },
        geometry_cache,
        None,
    );
    if let Some(bounded) = bounded_status(runtime) {
        return Ok(failed_outcome(
            input,
            runtime,
            bounded.to_status(),
            format!(
                "{} reached during contact-first strip construction.",
                bounded.as_str()
            ),
            0.0,
            None,
            None,
        ));
    }
    let contact_strip_outcome = contact_strip
        .placed_collision_geometries
        .clone()
        .map(|placed| {
            finalize_placed_layout(
                FinalizePlacedLayoutInput {
                    input,
                    placed,
                    construction_kind: IntrinsicShortSideConstructionKind::ContactStrip,
                    row_count: 0.0,
                    selected_bottom_piece_id: None,
                    selected_upper_piece_id: None,
                },
                runtime,
            )
        });

    let strip_choice = select_directional_incumbent_choice(
        depth_strip_outcome.as_ref(),
        contact_strip_outcome.as_ref(),
    );
    let mut strip_outcome: Option<IntrinsicShortSidePairFoldOutcome> = match strip_choice {
        Some(IncumbentChoice::First) => depth_strip_outcome.clone(),
        Some(IncumbentChoice::Second) => contact_strip_outcome.clone(),
        None => None,
    };
    // TS `:636-637`: `stripOutcome === contactStripOutcome ? contactStrip.trace :
    // depthStrip.trace` -- see `IncumbentChoice`'s doc for why "not First"
    // (covering both `Second` and `None`) reproduces this exactly, including
    // the `undefined === undefined` quirk when *neither* strip succeeded.
    let mut selected_strip_trace = if strip_choice == Some(IncumbentChoice::First) {
        depth_strip.trace.clone()
    } else {
        contact_strip.trace.clone()
    };
    let mut contact_strip_lanes: Vec<IntrinsicShortSideContactStripTrace> =
        vec![depth_strip.trace.clone(), contact_strip.trace.clone()];

    if incumbent.is_none()
        && strip_outcome.is_none()
        && input.prepared_pieces.len() <= INTRINSIC_SHORT_SIDE_ORDER_CONTINUATION_MAX_PIECES
    {
        let reversed: Vec<Arc<IrregularPreparedPiece>> =
            input.prepared_pieces.iter().rev().cloned().collect();
        let ascending = sort_by_piece_id(input.prepared_pieces);
        let continuations: [(
            IntrinsicShortSideContactStripOrderPolicy,
            &[Arc<IrregularPreparedPiece>],
        ); 2] = [
            (
                IntrinsicShortSideContactStripOrderPolicy::Reverse,
                &reversed,
            ),
            (
                IntrinsicShortSideContactStripOrderPolicy::PieceIdAscending,
                &ascending,
            ),
        ];
        for (order_policy, continuation_pieces) in continuations {
            let continued_strip = construct_intrinsic_short_side_contact_strip(
                ConstructIntrinsicShortSideContactStripInput {
                    strip_sheet: &strip_sheet(
                        input.sheet,
                        requested_short_axis_mm,
                        axes.long_axis_mm,
                    ),
                    prepared_pieces: continuation_pieces,
                    settings: input.settings,
                    selection_policy: Some(
                        IntrinsicShortSideContactStripSelectionPolicy::DepthFirst,
                    ),
                    order_policy: Some(order_policy),
                    runtime_control: Some(strip_runtime_control(runtime, None, None)),
                },
                geometry_cache,
                None,
            );
            contact_strip_lanes.push(continued_strip.trace.clone());
            if let Some(bounded) = bounded_status(runtime) {
                return Ok(failed_outcome(
                    input,
                    runtime,
                    bounded.to_status(),
                    format!(
                        "{} reached during {} contact-strip continuation.",
                        bounded.as_str(),
                        order_policy.as_str()
                    ),
                    0.0,
                    None,
                    None,
                ));
            }
            let Some(continued_placed) = continued_strip.placed_collision_geometries.clone() else {
                continue;
            };
            let continued_outcome = finalize_placed_layout(
                FinalizePlacedLayoutInput {
                    input,
                    placed: continued_placed,
                    construction_kind: IntrinsicShortSideConstructionKind::ContactStrip,
                    row_count: 0.0,
                    selected_bottom_piece_id: None,
                    selected_upper_piece_id: None,
                },
                runtime,
            );
            let continuation_choice = select_directional_incumbent_choice(
                strip_outcome.as_ref(),
                Some(&continued_outcome),
            );
            strip_outcome = match continuation_choice {
                Some(IncumbentChoice::First) => strip_outcome,
                Some(IncumbentChoice::Second) => Some(continued_outcome.clone()),
                None => None,
            };
            if continuation_choice != Some(IncumbentChoice::First) {
                selected_strip_trace = continued_strip.trace.clone();
            }
            if continuation_choice.is_some() {
                break;
            }
        }
    }

    let promotion = evaluate_intrinsic_short_side_contact_strip_promotion(
        incumbent.as_ref(),
        strip_outcome.as_ref(),
        &selected_strip_trace,
    );
    let selected = select_directional_incumbent(incumbent.as_ref(), strip_outcome.as_ref())
        .unwrap_or_else(|| {
            failed_outcome(
                input,
                runtime,
                IntrinsicShortSidePairFoldStatus::NoFittingPair,
                "no exact directional construction fit both requested sheet axes.".to_string(),
                0.0,
                None,
                None,
            )
        });
    let trace = with_measured_trace(IntrinsicShortSidePairFoldTrace {
        envelope_area_cost_veto_observed: runtime.envelope_area_cost_veto_observed,
        envelope_area_cost_vetoes: runtime.envelope_area_cost_vetoes.clone(),
        contact_strip: Some(selected_strip_trace),
        contact_strip_lanes,
        contact_strip_promotion: Some(promotion),
        peak_rss_delta_bytes: sample_rss(runtime),
        runtime_ms: js_math::max(0.0, (runtime.now)() - runtime.started_at),
        serialized_trace_bytes: 0.0,
        ..selected.trace
    });
    if selected_output_trace_size(&trace) > runtime.maximum_trace_bytes {
        return Ok(failed_outcome(
            input,
            runtime,
            IntrinsicShortSidePairFoldStatus::TraceCap,
            "composite terminal short-side trace exceeds its byte cap.".to_string(),
            0.0,
            None,
            None,
        ));
    }
    Ok(IntrinsicShortSidePairFoldOutcome {
        trace,
        placed_collision_geometries: selected.placed_collision_geometries,
    })
}

// ===========================================================================
// Public entry point (`:240-304`)
// ===========================================================================

/// TS: `intrinsicShortSidePairFoldObserver.ts:240-304`
/// (`observeIntrinsicShortSidePairFold`). See this module's top doc for the
/// `geometry_cache` seam. Discharges the one possible error
/// (`IrregularGeometryInputError`, from this file's own direct
/// `transformCollisionGeometry` calls) into a `failed-protected-fallback`
/// outcome, matching the TS `Effect`'s `never` error channel exactly
/// (`IrregularNestingNotImplementedError` is dropped from this union per the
/// established convention -- see `search::strict_decoder`'s own doc comment
/// for "Deliberately not ported").
pub fn observe_intrinsic_short_side_pair_fold(
    input: IntrinsicShortSidePairFoldInput<'_>,
    geometry_cache: &mut GeometryCacheStore,
) -> IntrinsicShortSidePairFoldOutcome {
    let default_now_ref: &dyn Fn() -> f64 = &default_timing_now;
    let default_rss_ref: &dyn Fn() -> f64 = &default_current_rss_bytes;
    let now = input
        .runtime_control
        .as_ref()
        .and_then(|control| control.now)
        .unwrap_or(default_now_ref);
    let current_rss_bytes = input
        .runtime_control
        .as_ref()
        .and_then(|control| control.current_rss_bytes)
        .unwrap_or(default_rss_ref);
    let starting_rss_bytes = current_rss_bytes();
    let mut runtime = ObserverRuntime {
        started_at: now(),
        starting_rss_bytes,
        peak_rss_bytes: std::cell::Cell::new(starting_rss_bytes),
        transform_evaluations: 0.0,
        expected_pair_count: 0.0,
        evaluated_pair_count: 0.0,
        envelope_area_cost_veto_observed: false,
        envelope_area_cost_vetoes: Vec::new(),
        maximum_runtime_ms: input
            .runtime_control
            .as_ref()
            .and_then(|control| control.maximum_runtime_ms)
            .unwrap_or(INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RUNTIME_MS),
        maximum_rss_delta_bytes: input
            .runtime_control
            .as_ref()
            .and_then(|control| control.maximum_rss_delta_bytes)
            .unwrap_or(INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RSS_DELTA_BYTES),
        maximum_trace_bytes: input
            .runtime_control
            .as_ref()
            .and_then(|control| control.maximum_trace_bytes)
            .unwrap_or(INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_TRACE_BYTES),
        now,
        current_rss_bytes,
    };
    match construct_pair_fold(&input, &mut runtime, geometry_cache) {
        Ok(outcome) => outcome,
        Err(error) => failed_outcome(
            &input,
            &runtime,
            IntrinsicShortSidePairFoldStatus::FailedProtectedFallback,
            error.message,
            0.0,
            None,
            None,
        ),
    }
}
