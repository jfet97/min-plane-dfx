//! Stage-1 archive observer: evaluates settled complete endpoints without
//! constructing placements or candidates.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicShortSideObserver.ts`
//! (775 lines), ported here in full. Read together with
//! `docs/planning/rust-irregular-backend/characterization/short-side.md`
//! before touching this file.
//!
//! # Finding 1 (short-side.md §15) -- this module's ranked winner is telemetry only
//!
//! `observe_intrinsic_short_side_orientations` always returns
//! `output_influence: ShortSideOutputInfluence::None` on every return path.
//! Its ranked/Pareto/admission logic must still be byte-exact (its
//! `production_short_axis_span_mm`/`..._grid` outputs feed
//! `pair_fold::observe_intrinsic_short_side_pair_fold`'s admission-evidence
//! computation), but **no caller may ever let this module's ranked winner
//! become the selected Short Side geometry** -- doing so would be a
//! regression, not a fix, even though it looks like "dead code come alive."
//!
//! # Reused (GREEN) modules -- never duplicated here
//!
//! - `search::strict_decoder::{IntrinsicStrictCompletedMetrics,
//!   IntrinsicStrictCompletedMetricsExact, IntrinsicStrictCertificate,
//!   IntrinsicStrictCohesionFloor, INTRINSIC_STRICT_COHESION_FLOORS,
//!   intrinsic_strict_completed_layout_dominates}` -- the exact completed-
//!   layout metrics/certificate/dominance shapes this cluster's Pareto
//!   filter and cavity-hull guard depend on.
//! - `canonical_grid::layout::{assert_canonical_grid_legal_layout,
//!   canonical_collision_layout_identity, placed_collision_world_grid_path}`.
//! - `canonical_grid::{to_grid_mm, from_grid, canonical_grid_compare_bigints,
//!   canonical_grid_compare_ratios}`.
//! - `search::beam_state::{IrregularBeamState, IrregularBeamStateInput,
//!   IrregularQuarterTurnDegrees}`.
//! - `checkpoints::canonical_json::locale_compare_keys` -- `.localeCompare`
//!   parity for every hash/id comparison in this file.
//! - `geometry::hash::sha256_hex`, `js_number::{js_math, is_safe_integer}`.
//! - `short_side::axes::{intrinsic_short_side_axes, IntrinsicShortSideAxes,
//!   ShortSideAxisDimension, ShortSideRotationDeg}`.
//! - `short_side::json::{ShortSideJsonValue, byte_length}` -- this cluster's
//!   own plain-`JSON.stringify` byte-measurement infra (see that module's
//!   doc for why it is not a duplicate of `checkpoints::canonical_json`).
//!
//! # Seam: `IntrinsicSharedArchiveEndpoint` (provisional)
//!
//! TS imports `IntrinsicSharedArchiveEndpoint` from
//! `intrinsicSharedArchivePortfolio.ts`, a sibling module not yet ported
//! (`archive::shared` is a Stage-2 reservation stub) and outside this task's
//! file-ownership scope. Per this task's established "seam type" pattern
//! (e.g. `capacity::prefixes`'s `IntrinsicSharedArchiveDirectRole`),
//! [`IntrinsicSharedArchiveEndpoint`] is defined locally here, limited to
//! the exact fields this cluster's three files actually read
//! (`role`, `sourceId`, `sheetlessCanonicalGeometryHash`,
//! `placedCollisionGeometries`, `metrics`, `certificate`) -- confirmed by a
//! full read of `intrinsicSharedArchivePortfolio.ts:73-82`'s
//! `IntrinsicSharedArchiveEndpoint` interface. `sheetlessCanonicalGeometryIdentity`
//! and `requestedSheetFit` are declared on the TS interface but never read
//! anywhere in this cluster's three files (confirmed by grep), so they are
//! omitted here rather than guessed at. Whoever ports `archive::shared` must
//! reconcile this into the single real definition rather than let two
//! independent copies drift.

use std::sync::Arc;

use num_bigint::BigInt;

use crate::canonical_grid::layout::{
    assert_canonical_grid_legal_layout, canonical_collision_layout_identity,
    placed_collision_world_grid_path,
};
use crate::canonical_grid::{
    canonical_grid_compare_bigints, canonical_grid_compare_ratios, from_grid, to_grid_mm,
};
use crate::checkpoints::canonical_json::locale_compare_keys;
use crate::clipper::core::{bigint_to_number, f64_to_bigint};
use crate::domain::{IrregularPlacedPiece, PieceId, SheetSpec};
use crate::geometry::hash::sha256_hex;
use crate::js_number::js_math;
use crate::search::beam_state::{IrregularBeamState, IrregularBeamStateInput};
use crate::search::strict_decoder::{
    intrinsic_strict_completed_layout_dominates, IntrinsicStrictCertificate,
    IntrinsicStrictCompletedMetrics, INTRINSIC_STRICT_COHESION_FLOORS,
};
use std::cmp::Ordering;

use super::axes::{
    intrinsic_short_side_axes, IntrinsicShortSideAxes, ShortSideAxisDimension, ShortSideRotationDeg,
};
use super::json::{byte_length, ShortSideJsonValue};

// ===========================================================================
// Seam: `IntrinsicSharedArchiveEndpoint` (see this module's top doc).
// ===========================================================================

/// TS: `intrinsicSharedArchivePortfolio.ts:73-82`
/// `IntrinsicSharedArchiveEndpoint` -- limited to the fields this cluster
/// reads. See this module's top doc, "Seam: `IntrinsicSharedArchiveEndpoint`
/// (provisional)".
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicSharedArchiveEndpoint {
    pub role: String,
    pub source_id: Option<String>,
    pub sheetless_canonical_geometry_hash: String,
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub metrics: IntrinsicStrictCompletedMetrics,
    pub certificate: IntrinsicStrictCertificate,
}

// ===========================================================================
// Constants (`intrinsicShortSideObserver.ts:29-35`)
// ===========================================================================

pub const INTRINSIC_SHORT_SIDE_OBSERVER_VERSION: &str = "intrinsic-short-side-observer-v6";
pub const INTRINSIC_SHORT_SIDE_OBSERVER_MAX_RUNTIME_MS: f64 = 250.0;
pub const INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES: usize = 1_048_576;

/// TS: `intrinsicShortSideObserver.ts:44-52`
/// (`intrinsicShortSideEnvelopeAreaCostWithinProductionBound`).
///
/// A directional sibling may spend at most one third extra envelope area
/// over the production Compact layout (equivalently, with every piece
/// placed it may sacrifice at most one quarter of the production
/// collision-envelope density) to buy requested-short-edge fill. Compared
/// exactly via `BigInt` cross-multiplication; float area ratios remain
/// display telemetry.
pub fn intrinsic_short_side_envelope_area_cost_within_production_bound(
    candidate_envelope_area_grid2: &BigInt,
    production_envelope_area_grid2: &BigInt,
) -> bool {
    BigInt::from(3) * candidate_envelope_area_grid2
        <= BigInt::from(4) * production_envelope_area_grid2
}

fn compare_f64(first: f64, second: f64) -> Ordering {
    first.partial_cmp(&second).unwrap_or(Ordering::Equal)
}

fn ordering_from_i32(value: i32) -> Ordering {
    if value < 0 {
        Ordering::Less
    } else if value > 0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

fn cloned_placed(placed: &[Arc<IrregularPlacedPiece>]) -> Vec<IrregularPlacedPiece> {
    placed.iter().map(|p| (**p).clone()).collect()
}

fn placed_piece_id(placed: &IrregularPlacedPiece) -> PieceId {
    placed
        .placement
        .piece_id
        .clone()
        .unwrap_or_else(|| placed.placement.source_piece_id.clone())
}

// ===========================================================================
// Output types (`intrinsicShortSideObserver.ts:54-137`)
// ===========================================================================

/// TS: `intrinsicShortSideObserver.ts:54` `IntrinsicShortSideObserverRotation
/// = 0 | 90` -- the same closed type as [`ShortSideRotationDeg`], reused
/// directly rather than re-declared.
pub type IntrinsicShortSideObserverRotation = ShortSideRotationDeg;

/// TS: `intrinsicShortSideObserver.ts:55-62`
/// `IntrinsicShortSideObserverStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicShortSideObserverStatus {
    Observed,
    ObservedNoLegalOrientation,
    ObservedNoGuardEligibleEndpoint,
    ObservedNoDirectionalImprovement,
    SkippedNoSettledCompleteEndpoints,
    RuntimeBudgetExceeded,
    TraceBudgetExceeded,
}

impl IntrinsicShortSideObserverStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicShortSideObserverStatus::Observed => "observed",
            IntrinsicShortSideObserverStatus::ObservedNoLegalOrientation => {
                "observed-no-legal-orientation"
            }
            IntrinsicShortSideObserverStatus::ObservedNoGuardEligibleEndpoint => {
                "observed-no-guard-eligible-endpoint"
            }
            IntrinsicShortSideObserverStatus::ObservedNoDirectionalImprovement => {
                "observed-no-directional-improvement"
            }
            IntrinsicShortSideObserverStatus::SkippedNoSettledCompleteEndpoints => {
                "skipped-no-settled-complete-endpoints"
            }
            IntrinsicShortSideObserverStatus::RuntimeBudgetExceeded => "runtime-budget-exceeded",
            IntrinsicShortSideObserverStatus::TraceBudgetExceeded => "trace-budget-exceeded",
        }
    }
}

/// TS: `intrinsicShortSideObserver.ts:111` `outputInfluence: 'none' |
/// 'selected'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShortSideOutputInfluence {
    None,
    Selected,
}

impl ShortSideOutputInfluence {
    pub fn as_str(self) -> &'static str {
        match self {
            ShortSideOutputInfluence::None => "none",
            ShortSideOutputInfluence::Selected => "selected",
        }
    }
}

/// TS: `intrinsicShortSideObserver.ts:92`
/// `ReadonlyArray<number | string>` (`comparisonTuple`).
#[derive(Clone, Debug, PartialEq)]
pub enum ComparisonTupleEntry {
    Num(f64),
    Str(String),
}

impl ComparisonTupleEntry {
    fn to_json(&self) -> ShortSideJsonValue {
        match self {
            ComparisonTupleEntry::Num(value) => ShortSideJsonValue::Num(*value),
            ComparisonTupleEntry::Str(value) => ShortSideJsonValue::str(value.clone()),
        }
    }
}

/// TS: `intrinsicShortSideObserver.ts:64-93`
/// `IntrinsicShortSideOrientationObservation`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideOrientationObservation {
    pub rotation_deg: IntrinsicShortSideObserverRotation,
    pub exact_legal: bool,
    pub canonical_geometry_hash: Option<String>,
    pub used_width_mm: Option<f64>,
    pub used_height_mm: Option<f64>,
    pub requested_long_axis_used_span_mm: Option<f64>,
    pub requested_short_axis_shortfall_mm: Option<f64>,
    pub requested_long_axis_used_span_grid: Option<f64>,
    pub requested_short_axis_shortfall_grid: Option<f64>,
    pub cavity_count: f64,
    pub hull_gap_ratio: f64,
    pub hull_gap_doubled_area_grid2: Option<String>,
    pub occupied_hull_doubled_area_grid2: Option<String>,
    pub cohesion_passes: bool,
    pub cohesion_deficit: f64,
    pub cohesion_deficit_numerator: Option<String>,
    pub cohesion_deficit_denominator: Option<String>,
    pub intrinsic_envelope_area_mm2: f64,
    pub intrinsic_envelope_maximum_side_mm: f64,
    pub intrinsic_envelope_span_mm: f64,
    pub intrinsic_envelope_area_grid2: Option<String>,
    pub intrinsic_envelope_maximum_side_grid: Option<f64>,
    pub intrinsic_envelope_span_grid: Option<f64>,
    pub dominant_structural_contacts: f64,
    pub total_structural_contacts: f64,
    pub contact_units: f64,
    pub shared_boundary_length_mm: f64,
    pub comparison_tuple: Vec<ComparisonTupleEntry>,
}

impl IntrinsicShortSideOrientationObservation {
    fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            (
                "rotationDeg",
                ShortSideJsonValue::Num(self.rotation_deg.as_degrees_f64()),
            ),
            ("exactLegal", ShortSideJsonValue::Bool(self.exact_legal)),
            (
                "canonicalGeometryHash",
                ShortSideJsonValue::opt_str(self.canonical_geometry_hash.as_deref()),
            ),
            (
                "usedWidthMm",
                ShortSideJsonValue::opt_num(self.used_width_mm),
            ),
            (
                "usedHeightMm",
                ShortSideJsonValue::opt_num(self.used_height_mm),
            ),
            (
                "requestedLongAxisUsedSpanMm",
                ShortSideJsonValue::opt_num(self.requested_long_axis_used_span_mm),
            ),
            (
                "requestedShortAxisShortfallMm",
                ShortSideJsonValue::opt_num(self.requested_short_axis_shortfall_mm),
            ),
            (
                "requestedLongAxisUsedSpanGrid",
                ShortSideJsonValue::opt_num(self.requested_long_axis_used_span_grid),
            ),
            (
                "requestedShortAxisShortfallGrid",
                ShortSideJsonValue::opt_num(self.requested_short_axis_shortfall_grid),
            ),
            ("cavityCount", ShortSideJsonValue::Num(self.cavity_count)),
            ("hullGapRatio", ShortSideJsonValue::Num(self.hull_gap_ratio)),
            (
                "hullGapDoubledAreaGrid2",
                ShortSideJsonValue::opt_str(self.hull_gap_doubled_area_grid2.as_deref()),
            ),
            (
                "occupiedHullDoubledAreaGrid2",
                ShortSideJsonValue::opt_str(self.occupied_hull_doubled_area_grid2.as_deref()),
            ),
            (
                "cohesionPasses",
                ShortSideJsonValue::Bool(self.cohesion_passes),
            ),
            (
                "cohesionDeficit",
                ShortSideJsonValue::Num(self.cohesion_deficit),
            ),
            (
                "cohesionDeficitNumerator",
                ShortSideJsonValue::opt_str(self.cohesion_deficit_numerator.as_deref()),
            ),
            (
                "cohesionDeficitDenominator",
                ShortSideJsonValue::opt_str(self.cohesion_deficit_denominator.as_deref()),
            ),
            (
                "intrinsicEnvelopeAreaMm2",
                ShortSideJsonValue::Num(self.intrinsic_envelope_area_mm2),
            ),
            (
                "intrinsicEnvelopeMaximumSideMm",
                ShortSideJsonValue::Num(self.intrinsic_envelope_maximum_side_mm),
            ),
            (
                "intrinsicEnvelopeSpanMm",
                ShortSideJsonValue::Num(self.intrinsic_envelope_span_mm),
            ),
            (
                "intrinsicEnvelopeAreaGrid2",
                ShortSideJsonValue::opt_str(self.intrinsic_envelope_area_grid2.as_deref()),
            ),
            (
                "intrinsicEnvelopeMaximumSideGrid",
                ShortSideJsonValue::opt_num(self.intrinsic_envelope_maximum_side_grid),
            ),
            (
                "intrinsicEnvelopeSpanGrid",
                ShortSideJsonValue::opt_num(self.intrinsic_envelope_span_grid),
            ),
            (
                "dominantStructuralContacts",
                ShortSideJsonValue::Num(self.dominant_structural_contacts),
            ),
            (
                "totalStructuralContacts",
                ShortSideJsonValue::Num(self.total_structural_contacts),
            ),
            ("contactUnits", ShortSideJsonValue::Num(self.contact_units)),
            (
                "sharedBoundaryLengthMm",
                ShortSideJsonValue::Num(self.shared_boundary_length_mm),
            ),
            (
                "comparisonTuple",
                ShortSideJsonValue::Arr(
                    self.comparison_tuple.iter().map(|e| e.to_json()).collect(),
                ),
            ),
        ])
    }
}

/// TS: `intrinsicShortSideObserver.ts:95-106`
/// `IntrinsicShortSideEndpointObservation`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideEndpointObservation {
    pub archive_index: usize,
    pub role: String,
    pub source_id: Option<String>,
    pub canonical_geometry_hash: String,
    pub q0: IntrinsicShortSideOrientationObservation,
    pub q90: IntrinsicShortSideOrientationObservation,
    pub selected_rotation_deg: IntrinsicShortSideObserverRotation,
    pub selected: IntrinsicShortSideOrientationObservation,
    pub cavity_hull_guard_eligible: bool,
    pub geometric_pareto_eligible: bool,
}

impl IntrinsicShortSideEndpointObservation {
    fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            (
                "archiveIndex",
                ShortSideJsonValue::Num(self.archive_index as f64),
            ),
            ("role", ShortSideJsonValue::str(self.role.clone())),
            (
                "sourceId",
                ShortSideJsonValue::opt_str(self.source_id.as_deref()),
            ),
            (
                "canonicalGeometryHash",
                ShortSideJsonValue::str(self.canonical_geometry_hash.clone()),
            ),
            ("q0", self.q0.to_json()),
            ("q90", self.q90.to_json()),
            (
                "selectedRotationDeg",
                ShortSideJsonValue::Num(self.selected_rotation_deg.as_degrees_f64()),
            ),
            ("selected", self.selected.to_json()),
            (
                "cavityHullGuardEligible",
                ShortSideJsonValue::Bool(self.cavity_hull_guard_eligible),
            ),
            (
                "geometricParetoEligible",
                ShortSideJsonValue::Bool(self.geometric_pareto_eligible),
            ),
        ])
    }
}

/// TS: `intrinsicShortSideObserver.ts:560-566`
/// `IntrinsicShortSideDirectionalAdmissionTerms`. Exact per-term breakdown
/// of the guarded directional admission decision.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicShortSideDirectionalAdmissionTerms {
    pub short_edge_fill_admitted: bool,
    pub shortfall_halved: bool,
    pub depth_within_production_maximum_side: bool,
    pub envelope_area_cost_within_production_bound: bool,
}

impl IntrinsicShortSideDirectionalAdmissionTerms {
    // `to_json` mirrors this cluster's other trace-payload `to_json(&self)`
    // methods (most of which are on non-`Copy` types) for a uniform call
    // shape across this file; taking `&self` here despite `Copy` is
    // intentional consistency, not an oversight.
    #[allow(clippy::wrong_self_convention)]
    fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            (
                "shortEdgeFillAdmitted",
                ShortSideJsonValue::Bool(self.short_edge_fill_admitted),
            ),
            (
                "shortfallHalved",
                ShortSideJsonValue::Bool(self.shortfall_halved),
            ),
            (
                "depthWithinProductionMaximumSide",
                ShortSideJsonValue::Bool(self.depth_within_production_maximum_side),
            ),
            (
                "envelopeAreaCostWithinProductionBound",
                ShortSideJsonValue::Bool(self.envelope_area_cost_within_production_bound),
            ),
        ])
    }
}

/// TS: `intrinsicShortSideObserver.ts:108-137`
/// `IntrinsicShortSideObserverTrace`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideObserverTrace {
    pub version: &'static str,
    pub status: IntrinsicShortSideObserverStatus,
    pub output_influence: ShortSideOutputInfluence,
    pub requested_sheet_width_mm: f64,
    pub requested_sheet_height_mm: f64,
    pub requested_long_axis_mm: f64,
    pub requested_short_axis_mm: f64,
    pub requested_long_axis: ShortSideAxisDimension,
    pub production_short_axis_span_mm: Option<f64>,
    pub production_maximum_side_mm: Option<f64>,
    pub production_envelope_area_mm2: Option<f64>,
    pub production_short_axis_span_grid: Option<f64>,
    pub production_maximum_side_grid: Option<f64>,
    pub production_envelope_area_grid2: Option<String>,
    pub settled_endpoint_count: f64,
    pub evaluated_orientation_count: f64,
    pub cavity_hull_guard_eligible_endpoint_count: f64,
    pub geometric_pareto_eligible_endpoint_count: f64,
    /// TS: `readonly placementEvaluations: 0` -- always the literal `0`.
    pub placement_evaluations: f64,
    /// TS: `readonly candidateEvaluations: 0` -- always the literal `0`.
    pub candidate_evaluations: f64,
    pub runtime_ms: f64,
    pub runtime_budget_exceeded: bool,
    pub serialized_trace_bytes: f64,
    pub endpoints: Vec<IntrinsicShortSideEndpointObservation>,
    pub ranked_canonical_geometry_hashes: Vec<String>,
    pub directional_admission_terms: Option<IntrinsicShortSideDirectionalAdmissionTerms>,
    pub observer_winner_canonical_geometry_hash: Option<String>,
    pub observer_winner_rotation_deg: Option<IntrinsicShortSideObserverRotation>,
}

impl IntrinsicShortSideObserverTrace {
    /// TS: the object literal built at `intrinsicShortSideObserver.ts:217-263`
    /// -- exact key insertion order, used by [`with_measured_trace`] for
    /// byte-exact `JSON.stringify` self-measurement, and reused as-is by
    /// `boundary::result::project_result` (via
    /// `short_side::json::to_serde_json`) as this trace's wire projection --
    /// see `boundary::result`'s own module doc, "Five optional trace fields:
    /// full field-for-field wire projections" (reuse, not a parallel DTO).
    pub(crate) fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            ("version", ShortSideJsonValue::str(self.version)),
            ("status", ShortSideJsonValue::str(self.status.as_str())),
            (
                "outputInfluence",
                ShortSideJsonValue::str(self.output_influence.as_str()),
            ),
            (
                "requestedSheetWidthMm",
                ShortSideJsonValue::Num(self.requested_sheet_width_mm),
            ),
            (
                "requestedSheetHeightMm",
                ShortSideJsonValue::Num(self.requested_sheet_height_mm),
            ),
            (
                "requestedLongAxisMm",
                ShortSideJsonValue::Num(self.requested_long_axis_mm),
            ),
            (
                "requestedShortAxisMm",
                ShortSideJsonValue::Num(self.requested_short_axis_mm),
            ),
            (
                "requestedLongAxis",
                ShortSideJsonValue::str(self.requested_long_axis.as_str()),
            ),
            (
                "productionShortAxisSpanMm",
                ShortSideJsonValue::opt_num(self.production_short_axis_span_mm),
            ),
            (
                "productionMaximumSideMm",
                ShortSideJsonValue::opt_num(self.production_maximum_side_mm),
            ),
            (
                "productionEnvelopeAreaMm2",
                ShortSideJsonValue::opt_num(self.production_envelope_area_mm2),
            ),
            (
                "productionShortAxisSpanGrid",
                ShortSideJsonValue::opt_num(self.production_short_axis_span_grid),
            ),
            (
                "productionMaximumSideGrid",
                ShortSideJsonValue::opt_num(self.production_maximum_side_grid),
            ),
            (
                "productionEnvelopeAreaGrid2",
                ShortSideJsonValue::opt_str(self.production_envelope_area_grid2.as_deref()),
            ),
            (
                "settledEndpointCount",
                ShortSideJsonValue::Num(self.settled_endpoint_count),
            ),
            (
                "evaluatedOrientationCount",
                ShortSideJsonValue::Num(self.evaluated_orientation_count),
            ),
            (
                "cavityHullGuardEligibleEndpointCount",
                ShortSideJsonValue::Num(self.cavity_hull_guard_eligible_endpoint_count),
            ),
            (
                "geometricParetoEligibleEndpointCount",
                ShortSideJsonValue::Num(self.geometric_pareto_eligible_endpoint_count),
            ),
            (
                "placementEvaluations",
                ShortSideJsonValue::Num(self.placement_evaluations),
            ),
            (
                "candidateEvaluations",
                ShortSideJsonValue::Num(self.candidate_evaluations),
            ),
            ("runtimeMs", ShortSideJsonValue::Num(self.runtime_ms)),
            (
                "runtimeBudgetExceeded",
                ShortSideJsonValue::Bool(self.runtime_budget_exceeded),
            ),
            (
                "serializedTraceBytes",
                ShortSideJsonValue::Num(self.serialized_trace_bytes),
            ),
            (
                "endpoints",
                ShortSideJsonValue::Arr(self.endpoints.iter().map(|e| e.to_json()).collect()),
            ),
            (
                "rankedCanonicalGeometryHashes",
                ShortSideJsonValue::Arr(
                    self.ranked_canonical_geometry_hashes
                        .iter()
                        .map(|hash| ShortSideJsonValue::str(hash.clone()))
                        .collect(),
                ),
            ),
            (
                "directionalAdmissionTerms",
                match &self.directional_admission_terms {
                    Some(terms) => terms.to_json(),
                    None => ShortSideJsonValue::Undefined,
                },
            ),
            (
                "observerWinnerCanonicalGeometryHash",
                ShortSideJsonValue::opt_str(
                    self.observer_winner_canonical_geometry_hash.as_deref(),
                ),
            ),
            (
                "observerWinnerRotationDeg",
                ShortSideJsonValue::opt_num(
                    self.observer_winner_rotation_deg
                        .map(|r| r.as_degrees_f64()),
                ),
            ),
        ])
    }
}

// ===========================================================================
// The `timingNow` injectable clock seam (`intrinsicShortSideObserver.ts:146`).
// ===========================================================================

/// See `search::beam_state::TimingNowFn`'s doc for why this crate re-declares
/// an independent seam per production TS `performance.now()` call site
/// rather than sharing one global type.
pub type ObserverTimingNowFn = dyn Fn() -> f64;

static PROCESS_START: std::sync::LazyLock<std::time::Instant> =
    std::sync::LazyLock::new(std::time::Instant::now);

fn default_timing_now() -> f64 {
    PROCESS_START.elapsed().as_secs_f64() * 1000.0
}

// ===========================================================================
// `observeIntrinsicShortSideOrientations` (`:140-279`)
// ===========================================================================

/// TS: `intrinsicShortSideObserver.ts:140-145` input.
pub struct ObserveIntrinsicShortSideOrientationsInput<'a> {
    pub sheet: &'a SheetSpec,
    pub endpoints: &'a [IntrinsicSharedArchiveEndpoint],
    /// TS: `input.productionPlacedCollisionGeometries ??
    /// input.endpoints[0]?.placedCollisionGeometries ?? []`
    /// (`:155-159`) -- production always supplies this, so the fallback is
    /// applied by [`observe_intrinsic_short_side_orientations`] itself
    /// exactly like the TS default expression, not by the caller.
    pub production_placed_collision_geometries: Option<&'a [Arc<IrregularPlacedPiece>]>,
    pub now: Option<&'a ObserverTimingNowFn>,
}

/// TS: `intrinsicShortSideObserver.ts:140-279`
/// (`observeIntrinsicShortSideOrientations`). Evaluates settled complete
/// endpoints without constructing placements or candidates.
pub fn observe_intrinsic_short_side_orientations(
    input: ObserveIntrinsicShortSideOrientationsInput<'_>,
) -> IntrinsicShortSideObserverTrace {
    let default_now_ref: &ObserverTimingNowFn = &default_timing_now;
    let now = input.now.unwrap_or(default_now_ref);
    let started_at = now();
    let axes = intrinsic_short_side_axes(input.sheet);
    let requested_long_axis = axes.long_axis;
    let requested_long_axis_mm = axes.long_axis_mm;
    let requested_short_axis_mm = axes.short_axis_mm;
    let requested_short_axis_grid = to_grid_mm(requested_short_axis_mm);

    let fallback_production_placed: Vec<Arc<IrregularPlacedPiece>> = input
        .production_placed_collision_geometries
        .map(|slice| slice.to_vec())
        .unwrap_or_else(|| {
            input
                .endpoints
                .first()
                .map(|endpoint| endpoint.placed_collision_geometries.clone())
                .unwrap_or_default()
        });
    let production_reference = directional_reference(DirectionalReferenceInput {
        sheet: input.sheet,
        placed_collision_geometries: &fallback_production_placed,
        axes: &axes,
    });

    let observed_endpoints: Vec<IntrinsicShortSideEndpointObservation> = input
        .endpoints
        .iter()
        .enumerate()
        .map(|(archive_index, endpoint)| {
            observe_endpoint(ObserveEndpointInput {
                sheet: input.sheet,
                endpoint,
                archive_index,
                requested_long_axis,
                requested_short_axis_mm,
            })
        })
        .collect();
    let legal_endpoint_count = observed_endpoints
        .iter()
        .filter(|endpoint| endpoint.selected.exact_legal)
        .count();
    // TS builds `guardEligibleEndpoints` by filtering `legalEndpoints`
    // (`:171`), but `cavityHullGuardEligible` itself re-checks
    // `selected.exactLegal` as its own first condition (`:331`), so
    // filtering the complete `observedEndpoints` list here produces the
    // exact same set/count -- this avoids holding a chain of `Vec<&T>`
    // borrows of `observed_endpoints` across the later `into_iter()` move
    // below.
    let guard_eligible_indexes: Vec<usize> = observed_endpoints
        .iter()
        .enumerate()
        .filter(|(_, endpoint)| cavity_hull_guard_eligible(endpoint))
        .map(|(index, _)| index)
        .collect();
    // `observed_endpoints[i].archive_index == i` always (built via
    // `.enumerate()` over `input.endpoints` in the same order, `:161-169`),
    // so a plain `usize` index doubles as the TS `archiveIndex`.
    let geometric_pareto_indexes: std::collections::HashSet<usize> = guard_eligible_indexes
        .iter()
        .copied()
        .filter(|&candidate_index| {
            let candidate_source = &input.endpoints[candidate_index];
            !guard_eligible_indexes.iter().any(|&other_index| {
                let other_source = &input.endpoints[other_index];
                other_index != candidate_index
                    && intrinsic_strict_completed_layout_dominates(
                        &other_source.metrics,
                        &candidate_source.metrics,
                    )
            })
        })
        .collect();
    let guard_eligible_endpoint_count = guard_eligible_indexes.len();
    let geometric_pareto_endpoint_count = geometric_pareto_indexes.len();

    let endpoints: Vec<IntrinsicShortSideEndpointObservation> = observed_endpoints
        .into_iter()
        .enumerate()
        .map(|(index, endpoint)| {
            let cavity_hull_guard_eligible = cavity_hull_guard_eligible(&endpoint);
            let geometric_pareto_eligible = geometric_pareto_indexes.contains(&index);
            IntrinsicShortSideEndpointObservation {
                cavity_hull_guard_eligible,
                geometric_pareto_eligible,
                ..endpoint
            }
        })
        .collect();

    // Scoped so the `Vec<&IntrinsicShortSideEndpointObservation>` borrow of
    // `endpoints` ends before `endpoints` itself is moved into the trace
    // struct below.
    let (
        ranked_canonical_geometry_hashes,
        winner_canonical_geometry_hash,
        winner_rotation_deg,
        directional_admission_terms,
    ) = {
        let mut ranked: Vec<&IntrinsicShortSideEndpointObservation> = endpoints
            .iter()
            .filter(|endpoint| endpoint.geometric_pareto_eligible)
            .collect();
        ranked.sort_by(|first, second| compare_endpoint_observations(first, second));
        let ranked_winner = ranked.first().copied();

        let directional_admission_terms = match (ranked_winner, production_reference.as_ref()) {
            (Some(winner), Some(production)) => directional_improvement_terms(
                &winner.selected,
                production,
                requested_short_axis_grid,
            ),
            _ => None,
        };
        let winner = match directional_admission_terms {
            Some(terms)
                if terms.short_edge_fill_admitted
                    && terms.shortfall_halved
                    && terms.depth_within_production_maximum_side
                    && terms.envelope_area_cost_within_production_bound =>
            {
                ranked_winner
            }
            _ => None,
        };
        (
            ranked
                .iter()
                .map(|endpoint| endpoint.canonical_geometry_hash.clone())
                .collect::<Vec<String>>(),
            winner.map(|endpoint| endpoint.canonical_geometry_hash.clone()),
            winner.map(|endpoint| endpoint.selected_rotation_deg),
            directional_admission_terms,
        )
    };

    let status = if endpoints.is_empty() {
        IntrinsicShortSideObserverStatus::SkippedNoSettledCompleteEndpoints
    } else if legal_endpoint_count == 0 {
        IntrinsicShortSideObserverStatus::ObservedNoLegalOrientation
    } else if guard_eligible_endpoint_count == 0 {
        IntrinsicShortSideObserverStatus::ObservedNoGuardEligibleEndpoint
    } else if winner_canonical_geometry_hash.is_none() {
        IntrinsicShortSideObserverStatus::ObservedNoDirectionalImprovement
    } else {
        IntrinsicShortSideObserverStatus::Observed
    };

    let observed = IntrinsicShortSideObserverTrace {
        version: INTRINSIC_SHORT_SIDE_OBSERVER_VERSION,
        status,
        output_influence: ShortSideOutputInfluence::None,
        requested_sheet_width_mm: input.sheet.width,
        requested_sheet_height_mm: input.sheet.height,
        requested_long_axis_mm,
        requested_short_axis_mm,
        requested_long_axis,
        production_short_axis_span_mm: production_reference
            .as_ref()
            .map(|r| r.used_short_axis_span_mm),
        production_maximum_side_mm: production_reference.as_ref().map(|r| r.maximum_side_mm),
        production_envelope_area_mm2: production_reference.as_ref().map(|r| r.envelope_area_mm2),
        production_short_axis_span_grid: production_reference
            .as_ref()
            .map(|r| r.used_short_axis_span_grid),
        production_maximum_side_grid: production_reference.as_ref().map(|r| r.maximum_side_grid),
        production_envelope_area_grid2: production_reference
            .as_ref()
            .map(|r| r.envelope_area_grid2.to_string()),
        settled_endpoint_count: endpoints.len() as f64,
        evaluated_orientation_count: endpoints.len() as f64 * 2.0,
        cavity_hull_guard_eligible_endpoint_count: guard_eligible_endpoint_count as f64,
        geometric_pareto_eligible_endpoint_count: geometric_pareto_endpoint_count as f64,
        placement_evaluations: 0.0,
        candidate_evaluations: 0.0,
        runtime_ms: 0.0,
        runtime_budget_exceeded: false,
        serialized_trace_bytes: 0.0,
        ranked_canonical_geometry_hashes,
        endpoints,
        directional_admission_terms,
        observer_winner_canonical_geometry_hash: winner_canonical_geometry_hash,
        observer_winner_rotation_deg: winner_rotation_deg,
    };
    let measured = with_measured_trace(IntrinsicShortSideObserverTrace {
        runtime_ms: js_math::max(0.0, now() - started_at),
        ..observed
    });
    if measured.runtime_ms > INTRINSIC_SHORT_SIDE_OBSERVER_MAX_RUNTIME_MS {
        return censored_trace(
            measured,
            IntrinsicShortSideObserverStatus::RuntimeBudgetExceeded,
            true,
        );
    }
    let selected_size = byte_length(
        &IntrinsicShortSideObserverTrace {
            output_influence: ShortSideOutputInfluence::Selected,
            ..measured.clone()
        }
        .to_json(),
    );
    if selected_size <= INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES {
        return measured;
    }
    censored_trace(
        measured,
        IntrinsicShortSideObserverStatus::TraceBudgetExceeded,
        false,
    )
}

struct ObserveEndpointInput<'a> {
    sheet: &'a SheetSpec,
    endpoint: &'a IntrinsicSharedArchiveEndpoint,
    archive_index: usize,
    requested_long_axis: ShortSideAxisDimension,
    requested_short_axis_mm: f64,
}

/// TS: `intrinsicShortSideObserver.ts:281-323` (`observeEndpoint`).
fn observe_endpoint(input: ObserveEndpointInput<'_>) -> IntrinsicShortSideEndpointObservation {
    let state = IrregularBeamState::from_input(IrregularBeamStateInput {
        remaining_prepared_pieces: Vec::new(),
        placed_collision_geometries: input.endpoint.placed_collision_geometries.clone(),
        unplaced_piece_ids: Some(Vec::new()),
        unplaced_source_piece_ids: None,
        placement_order: input
            .endpoint
            .placed_collision_geometries
            .iter()
            .map(|p| placed_piece_id(p))
            .collect(),
        parent: None,
        placed_collision_index: None,
    });
    let q0 = observe_orientation(ObserveOrientationInput {
        sheet: input.sheet,
        endpoint: input.endpoint,
        state: &state,
        rotation_deg: ShortSideRotationDeg::Zero,
        requested_long_axis: input.requested_long_axis,
        requested_short_axis_mm: input.requested_short_axis_mm,
    });
    let q90 = observe_orientation(ObserveOrientationInput {
        sheet: input.sheet,
        endpoint: input.endpoint,
        state: &state,
        rotation_deg: ShortSideRotationDeg::Ninety,
        requested_long_axis: input.requested_long_axis,
        requested_short_axis_mm: input.requested_short_axis_mm,
    });
    let selected = if compare_orientation_observations(&q0, &q90) != Ordering::Greater {
        q0.clone()
    } else {
        q90.clone()
    };
    IntrinsicShortSideEndpointObservation {
        archive_index: input.archive_index,
        role: input.endpoint.role.clone(),
        source_id: input.endpoint.source_id.clone(),
        canonical_geometry_hash: input.endpoint.sheetless_canonical_geometry_hash.clone(),
        selected_rotation_deg: selected.rotation_deg,
        q0,
        q90,
        selected,
        cavity_hull_guard_eligible: false,
        geometric_pareto_eligible: false,
    }
}

/// TS: `intrinsicShortSideObserver.ts:325-338` (`cavityHullGuardEligible`).
fn cavity_hull_guard_eligible(endpoint: &IntrinsicShortSideEndpointObservation) -> bool {
    let Some(gap_area) = endpoint.selected.hull_gap_doubled_area_grid2.as_deref() else {
        return false;
    };
    let Some(hull_area) = endpoint
        .selected
        .occupied_hull_doubled_area_grid2
        .as_deref()
    else {
        return false;
    };
    let Ok(gap_area) = gap_area.parse::<BigInt>() else {
        return false;
    };
    let Ok(hull_area) = hull_area.parse::<BigInt>() else {
        return false;
    };
    endpoint.selected.exact_legal
        && endpoint.selected.cavity_count
            <= INTRINSIC_STRICT_COHESION_FLOORS.maximum_enclosed_cavity_count
        && BigInt::from(20) * gap_area <= BigInt::from(3) * hull_area
}

struct ObserveOrientationInput<'a> {
    sheet: &'a SheetSpec,
    endpoint: &'a IntrinsicSharedArchiveEndpoint,
    state: &'a Arc<IrregularBeamState>,
    rotation_deg: ShortSideRotationDeg,
    requested_long_axis: ShortSideAxisDimension,
    requested_short_axis_mm: f64,
}

/// TS: `intrinsicShortSideObserver.ts:340-444` (`observeOrientation`).
fn observe_orientation(
    input: ObserveOrientationInput<'_>,
) -> IntrinsicShortSideOrientationObservation {
    let oriented =
        Arc::clone(input.state).with_quarter_turn_bottom_left(input.rotation_deg.as_quarter_turn());
    let exact_legal = match &oriented {
        Some(oriented) => assert_canonical_grid_legal_layout(
            input.sheet,
            &cloned_placed(&oriented.placed_collision_geometries),
        ),
        None => false,
    };
    let dimensions = oriented
        .as_ref()
        .and_then(|oriented| canonical_dimensions(&oriented.placed_collision_geometries));
    let canonical_geometry_hash = oriented.as_ref().and_then(|oriented| {
        hash_canonical_identity(canonical_collision_layout_identity(&cloned_placed(
            &oriented.placed_collision_geometries,
        )))
    });
    let used_long_axis_span_mm = dimensions.map(|d| match input.requested_long_axis {
        ShortSideAxisDimension::Width => d.width_mm,
        ShortSideAxisDimension::Height => d.height_mm,
    });
    let used_short_axis_span_mm = dimensions.map(|d| match input.requested_long_axis {
        ShortSideAxisDimension::Width => d.height_mm,
        ShortSideAxisDimension::Height => d.width_mm,
    });
    let used_long_axis_span_grid = dimensions.map(|d| match input.requested_long_axis {
        ShortSideAxisDimension::Width => d.width_grid,
        ShortSideAxisDimension::Height => d.height_grid,
    });
    let used_short_axis_span_grid = dimensions.map(|d| match input.requested_long_axis {
        ShortSideAxisDimension::Width => d.height_grid,
        ShortSideAxisDimension::Height => d.width_grid,
    });
    let requested_short_axis_grid = to_grid_mm(input.requested_short_axis_mm);
    let requested_short_axis_shortfall_mm =
        used_short_axis_span_mm.map(|used| input.requested_short_axis_mm - used);
    let requested_short_axis_shortfall_grid =
        match (used_short_axis_span_grid, requested_short_axis_grid) {
            (Some(used), Some(requested)) => Some(requested - used),
            _ => None,
        };
    let metrics = &input.endpoint.metrics;
    let tuple = comparison_tuple(ComparisonTupleInput {
        exact_legal,
        requested_long_axis_used_span_mm: used_long_axis_span_mm,
        cavity_count: metrics.enclosed_cavity_count,
        hull_gap_ratio: metrics.largest_occupied_hull_gap_ratio,
        cohesion_passes: input.endpoint.certificate.passes,
        cohesion_deficit: input.endpoint.certificate.relative_deficit_sum,
        requested_short_axis_shortfall_mm,
        intrinsic_envelope_area_mm2: metrics.envelope_area_mm2,
        intrinsic_envelope_maximum_side_mm: metrics.envelope_maximum_side_mm,
        intrinsic_envelope_span_mm: metrics.envelope_span_mm,
        dominant_structural_contacts: metrics.dominant_structural_contacts,
        total_structural_contacts: metrics.total_structural_contacts,
        contact_units: metrics.contact_units,
        shared_boundary_length_mm: metrics.shared_boundary_length_mm,
        canonical_geometry_hash: canonical_geometry_hash.clone(),
    });
    IntrinsicShortSideOrientationObservation {
        rotation_deg: input.rotation_deg,
        exact_legal,
        canonical_geometry_hash,
        used_width_mm: dimensions.map(|d| d.width_mm),
        used_height_mm: dimensions.map(|d| d.height_mm),
        requested_long_axis_used_span_mm: used_long_axis_span_mm,
        requested_short_axis_shortfall_mm,
        requested_long_axis_used_span_grid: used_long_axis_span_grid,
        requested_short_axis_shortfall_grid,
        cavity_count: metrics.enclosed_cavity_count,
        hull_gap_ratio: metrics.largest_occupied_hull_gap_ratio,
        hull_gap_doubled_area_grid2: metrics
            .exact
            .as_ref()
            .map(|e| e.largest_occupied_hull_gap_doubled_area_grid2.clone()),
        occupied_hull_doubled_area_grid2: metrics
            .exact
            .as_ref()
            .map(|e| e.occupied_hull_doubled_area_grid2.clone()),
        cohesion_passes: input.endpoint.certificate.passes,
        cohesion_deficit: input.endpoint.certificate.relative_deficit_sum,
        cohesion_deficit_numerator: input
            .endpoint
            .certificate
            .exact_relative_deficit_numerator
            .clone(),
        cohesion_deficit_denominator: input
            .endpoint
            .certificate
            .exact_relative_deficit_denominator
            .clone(),
        intrinsic_envelope_area_mm2: metrics.envelope_area_mm2,
        intrinsic_envelope_maximum_side_mm: metrics.envelope_maximum_side_mm,
        intrinsic_envelope_span_mm: metrics.envelope_span_mm,
        intrinsic_envelope_area_grid2: metrics
            .exact
            .as_ref()
            .map(|e| e.envelope_area_grid2.clone()),
        intrinsic_envelope_maximum_side_grid: metrics
            .exact
            .as_ref()
            .map(|e| e.envelope_maximum_side_grid),
        intrinsic_envelope_span_grid: metrics.exact.as_ref().map(|e| e.envelope_span_grid),
        dominant_structural_contacts: metrics.dominant_structural_contacts,
        total_structural_contacts: metrics.total_structural_contacts,
        contact_units: metrics.contact_units,
        shared_boundary_length_mm: metrics.shared_boundary_length_mm,
        comparison_tuple: tuple,
    }
}

struct ComparisonTupleInput {
    exact_legal: bool,
    requested_long_axis_used_span_mm: Option<f64>,
    cavity_count: f64,
    hull_gap_ratio: f64,
    cohesion_passes: bool,
    cohesion_deficit: f64,
    requested_short_axis_shortfall_mm: Option<f64>,
    intrinsic_envelope_area_mm2: f64,
    intrinsic_envelope_maximum_side_mm: f64,
    intrinsic_envelope_span_mm: f64,
    dominant_structural_contacts: f64,
    total_structural_contacts: f64,
    contact_units: f64,
    shared_boundary_length_mm: f64,
    canonical_geometry_hash: Option<String>,
}

/// TS: `intrinsicShortSideObserver.ts:446-480` (`comparisonTuple`).
/// Diagnostic-only display tuple; mirrors most of `compareOrientationObservations`'s
/// ordering intent but is not identical in field composition -- not
/// authoritative for any comparator, telemetry only.
fn comparison_tuple(input: ComparisonTupleInput) -> Vec<ComparisonTupleEntry> {
    vec![
        ComparisonTupleEntry::Num(if input.exact_legal { 0.0 } else { 1.0 }),
        ComparisonTupleEntry::Num(
            input
                .requested_short_axis_shortfall_mm
                .unwrap_or(f64::INFINITY),
        ),
        ComparisonTupleEntry::Num(
            input
                .requested_long_axis_used_span_mm
                .unwrap_or(f64::INFINITY),
        ),
        ComparisonTupleEntry::Num(input.cavity_count),
        ComparisonTupleEntry::Num(input.hull_gap_ratio),
        ComparisonTupleEntry::Num(if input.cohesion_passes { 0.0 } else { 1.0 }),
        ComparisonTupleEntry::Num(input.cohesion_deficit),
        ComparisonTupleEntry::Num(input.intrinsic_envelope_area_mm2),
        ComparisonTupleEntry::Num(input.intrinsic_envelope_maximum_side_mm),
        ComparisonTupleEntry::Num(input.intrinsic_envelope_span_mm),
        ComparisonTupleEntry::Num(-input.dominant_structural_contacts),
        ComparisonTupleEntry::Num(-input.total_structural_contacts),
        ComparisonTupleEntry::Num(-input.contact_units),
        ComparisonTupleEntry::Num(-input.shared_boundary_length_mm),
        ComparisonTupleEntry::Str(
            input
                .canonical_geometry_hash
                .unwrap_or_else(|| "\u{ffff}".to_string()),
        ),
    ]
}

/// TS: `intrinsicShortSideObserver.ts:482-491` `DirectionalReference`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct DirectionalReference {
    used_short_axis_span_mm: f64,
    used_long_axis_span_mm: f64,
    maximum_side_mm: f64,
    envelope_area_mm2: f64,
    used_short_axis_span_grid: f64,
    used_long_axis_span_grid: f64,
    maximum_side_grid: f64,
}

/// Paired with its own `envelope_area_grid2` since [`BigInt`] is not `Copy`.
#[derive(Clone, Debug, PartialEq)]
struct DirectionalReferenceCandidate {
    reference: DirectionalReference,
    envelope_area_grid2: BigInt,
}

struct DirectionalReferenceInput<'a> {
    sheet: &'a SheetSpec,
    placed_collision_geometries: &'a [Arc<IrregularPlacedPiece>],
    axes: &'a IntrinsicShortSideAxes,
}

/// TS: `intrinsicShortSideObserver.ts:493-558` (`directionalReference`).
fn directional_reference(
    input: DirectionalReferenceInput<'_>,
) -> Option<DirectionalReferenceWithArea> {
    if input.placed_collision_geometries.is_empty() {
        return None;
    }
    let short_axis_is_height = input.axes.short_axis == ShortSideAxisDimension::Height;
    let state = IrregularBeamState::from_input(IrregularBeamStateInput {
        remaining_prepared_pieces: Vec::new(),
        placed_collision_geometries: input.placed_collision_geometries.to_vec(),
        unplaced_piece_ids: None,
        unplaced_source_piece_ids: None,
        placement_order: input
            .placed_collision_geometries
            .iter()
            .map(|p| placed_piece_id(p))
            .collect(),
        parent: None,
        placed_collision_index: None,
    });

    let mut candidates: Vec<DirectionalReferenceCandidate> = Vec::new();
    for rotation_deg in [ShortSideRotationDeg::Zero, ShortSideRotationDeg::Ninety] {
        let Some(oriented) =
            Arc::clone(&state).with_quarter_turn_bottom_left(rotation_deg.as_quarter_turn())
        else {
            continue;
        };
        if !assert_canonical_grid_legal_layout(
            input.sheet,
            &cloned_placed(&oriented.placed_collision_geometries),
        ) {
            continue;
        }
        let Some(dimensions) = canonical_dimensions(&oriented.placed_collision_geometries) else {
            continue;
        };
        let used_short_axis_span_mm = if short_axis_is_height {
            dimensions.height_mm
        } else {
            dimensions.width_mm
        };
        let used_long_axis_span_mm = if short_axis_is_height {
            dimensions.width_mm
        } else {
            dimensions.height_mm
        };
        let used_short_axis_span_grid = if short_axis_is_height {
            dimensions.height_grid
        } else {
            dimensions.width_grid
        };
        let used_long_axis_span_grid = if short_axis_is_height {
            dimensions.width_grid
        } else {
            dimensions.height_grid
        };
        let maximum_side_grid = js_math::max(dimensions.width_grid, dimensions.height_grid);
        let envelope_area_grid2 =
            f64_to_bigint(dimensions.width_grid) * f64_to_bigint(dimensions.height_grid);
        candidates.push(DirectionalReferenceCandidate {
            reference: DirectionalReference {
                used_short_axis_span_mm,
                used_long_axis_span_mm,
                maximum_side_mm: js_math::max(dimensions.width_mm, dimensions.height_mm),
                maximum_side_grid,
                // TS: `Number(envelopeAreaGrid2) / 1_000_000` -- a plain,
                // unguarded conversion (unlike `doubled_grid_area_to_mm2`,
                // which additionally checks finiteness for a *doubled* area
                // input; this call site's TS source has no such guard).
                envelope_area_mm2: bigint_to_number(&envelope_area_grid2) / 1_000_000.0,
                used_short_axis_span_grid,
                used_long_axis_span_grid,
            },
            envelope_area_grid2,
        });
    }

    // TS: `orientations.toSorted((first, second) =>
    // second.usedShortAxisSpanGrid - first.usedShortAxisSpanGrid ||
    // first.usedLongAxisSpanGrid - second.usedLongAxisSpanGrid)[0]`. At most
    // two candidates (q0, q90 in that literal order); a stable sort over two
    // elements is equivalent to "replace only on a strictly-better
    // candidate," which this reduce reproduces exactly.
    let mut best: Option<DirectionalReferenceCandidate> = None;
    for candidate in candidates {
        best = match best {
            None => Some(candidate),
            Some(current) => {
                let order = compare_f64(
                    candidate.reference.used_short_axis_span_grid,
                    current.reference.used_short_axis_span_grid,
                )
                .reverse()
                .then_with(|| {
                    compare_f64(
                        candidate.reference.used_long_axis_span_grid,
                        current.reference.used_long_axis_span_grid,
                    )
                });
                if order == Ordering::Less {
                    Some(candidate)
                } else {
                    Some(current)
                }
            }
        };
    }
    best.map(|candidate| DirectionalReferenceWithArea {
        reference: candidate.reference,
        envelope_area_grid2: candidate.envelope_area_grid2,
    })
}

/// [`DirectionalReference`] plus its exact `BigInt` envelope area -- kept as
/// a separate carrier since the base struct is `Copy` and `BigInt` is not.
#[derive(Clone, Debug, PartialEq)]
struct DirectionalReferenceWithArea {
    reference: DirectionalReference,
    envelope_area_grid2: BigInt,
}

impl std::ops::Deref for DirectionalReferenceWithArea {
    type Target = DirectionalReference;
    fn deref(&self) -> &DirectionalReference {
        &self.reference
    }
}

/// TS: `intrinsicShortSideObserver.ts:568-606` (`directionalImprovementTerms`).
fn directional_improvement_terms(
    candidate: &IntrinsicShortSideOrientationObservation,
    production: &DirectionalReferenceWithArea,
    requested_short_axis_grid: Option<f64>,
) -> Option<IntrinsicShortSideDirectionalAdmissionTerms> {
    let candidate_shortfall = candidate.requested_short_axis_shortfall_grid?;
    let candidate_depth = candidate.requested_long_axis_used_span_grid?;
    let requested_short_axis_grid = requested_short_axis_grid?;
    if requested_short_axis_grid <= 0.0 {
        return None;
    }
    let candidate_short_axis_span_grid = requested_short_axis_grid - candidate_shortfall;
    let production_shortfall = js_math::max(
        0.0,
        requested_short_axis_grid - production.used_short_axis_span_grid,
    );
    Some(IntrinsicShortSideDirectionalAdmissionTerms {
        short_edge_fill_admitted: BigInt::from(5) * f64_to_bigint(candidate_short_axis_span_grid)
            >= BigInt::from(4) * f64_to_bigint(requested_short_axis_grid),
        shortfall_halved: BigInt::from(2) * f64_to_bigint(candidate_shortfall)
            <= f64_to_bigint(production_shortfall),
        depth_within_production_maximum_side: candidate_depth <= production.maximum_side_grid,
        envelope_area_cost_within_production_bound:
            intrinsic_short_side_envelope_area_cost_within_production_bound(
                &(f64_to_bigint(candidate_short_axis_span_grid) * f64_to_bigint(candidate_depth)),
                &production.envelope_area_grid2,
            ),
    })
}

/// TS: `intrinsicShortSideObserver.ts:608-617` (`compareEndpointObservations`).
fn compare_endpoint_observations(
    first: &IntrinsicShortSideEndpointObservation,
    second: &IntrinsicShortSideEndpointObservation,
) -> Ordering {
    compare_orientation_observations(&first.selected, &second.selected)
        .then_with(|| {
            locale_compare_keys(
                &first.canonical_geometry_hash,
                &second.canonical_geometry_hash,
            )
        })
        .then_with(|| first.archive_index.cmp(&second.archive_index))
}

/// TS: `intrinsicShortSideObserver.ts:619-668` (`compareOrientationObservations`).
fn compare_orientation_observations(
    first: &IntrinsicShortSideOrientationObservation,
    second: &IntrinsicShortSideOrientationObservation,
) -> Ordering {
    let exact_dimension_comparison = (!first.exact_legal)
        .cmp(&!second.exact_legal)
        .then_with(|| {
            compare_optional_grid(
                first.requested_short_axis_shortfall_grid,
                second.requested_short_axis_shortfall_grid,
            )
        })
        .then_with(|| {
            compare_optional_grid(
                first.requested_long_axis_used_span_grid,
                second.requested_long_axis_used_span_grid,
            )
        });
    if exact_dimension_comparison != Ordering::Equal {
        return exact_dimension_comparison;
    }
    compare_f64(first.cavity_count, second.cavity_count)
        .then_with(|| {
            compare_optional_exact_ratio(
                first.hull_gap_doubled_area_grid2.as_deref(),
                first.occupied_hull_doubled_area_grid2.as_deref(),
                second.hull_gap_doubled_area_grid2.as_deref(),
                second.occupied_hull_doubled_area_grid2.as_deref(),
            )
        })
        .then_with(|| (!first.cohesion_passes).cmp(&!second.cohesion_passes))
        .then_with(|| {
            compare_optional_exact_ratio(
                first.cohesion_deficit_numerator.as_deref(),
                first.cohesion_deficit_denominator.as_deref(),
                second.cohesion_deficit_numerator.as_deref(),
                second.cohesion_deficit_denominator.as_deref(),
            )
        })
        .then_with(|| {
            compare_optional_bigint_strings(
                first.intrinsic_envelope_area_grid2.as_deref(),
                second.intrinsic_envelope_area_grid2.as_deref(),
            )
        })
        .then_with(|| {
            compare_optional_grid(
                first.intrinsic_envelope_maximum_side_grid,
                second.intrinsic_envelope_maximum_side_grid,
            )
        })
        .then_with(|| {
            compare_optional_grid(
                first.intrinsic_envelope_span_grid,
                second.intrinsic_envelope_span_grid,
            )
        })
        .then_with(|| {
            compare_f64(
                second.dominant_structural_contacts,
                first.dominant_structural_contacts,
            )
        })
        .then_with(|| {
            compare_f64(
                second.total_structural_contacts,
                first.total_structural_contacts,
            )
        })
        .then_with(|| {
            locale_compare_keys(
                first
                    .canonical_geometry_hash
                    .as_deref()
                    .unwrap_or("\u{ffff}"),
                second
                    .canonical_geometry_hash
                    .as_deref()
                    .unwrap_or("\u{ffff}"),
            )
        })
        .then_with(|| {
            compare_f64(
                first.rotation_deg.as_degrees_f64(),
                second.rotation_deg.as_degrees_f64(),
            )
        })
}

/// TS: `intrinsicShortSideObserver.ts:670-691` (`compareOptionalExactRatio`).
fn compare_optional_exact_ratio(
    first_numerator: Option<&str>,
    first_denominator: Option<&str>,
    second_numerator: Option<&str>,
    second_denominator: Option<&str>,
) -> Ordering {
    let first_defined = first_numerator.is_some() && first_denominator.is_some();
    let second_defined = second_numerator.is_some() && second_denominator.is_some();
    if !first_defined || !second_defined {
        return if first_defined == second_defined {
            Ordering::Equal
        } else if first_defined {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let parse = |value: &str| {
        value.parse::<BigInt>().expect(
            "exact grid ratio numerator/denominator strings are always valid decimal bigints",
        )
    };
    let first_numerator = parse(first_numerator.expect("checked above"));
    let first_denominator = parse(first_denominator.expect("checked above"));
    let second_numerator = parse(second_numerator.expect("checked above"));
    let second_denominator = parse(second_denominator.expect("checked above"));
    canonical_grid_compare_ratios(
        &first_numerator,
        &first_denominator,
        &second_numerator,
        &second_denominator,
    )
    .map(ordering_from_i32)
    .unwrap_or(Ordering::Equal)
}

/// TS: `intrinsicShortSideObserver.ts:693-700` (`compareOptionalBigIntStrings`).
fn compare_optional_bigint_strings(first: Option<&str>, second: Option<&str>) -> Ordering {
    match (first, second) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(first), Some(second)) => {
            let first = first
                .parse::<BigInt>()
                .expect("exact grid bigint strings always parse");
            let second = second
                .parse::<BigInt>()
                .expect("exact grid bigint strings always parse");
            ordering_from_i32(canonical_grid_compare_bigints(&first, &second))
        }
    }
}

/// TS: `intrinsicShortSideObserver.ts:702-709` (`compareOptionalGrid`).
fn compare_optional_grid(first: Option<f64>, second: Option<f64>) -> Ordering {
    match (first, second) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(first), Some(second)) => compare_f64(first, second),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct CanonicalDimensions {
    width_mm: f64,
    height_mm: f64,
    width_grid: f64,
    height_grid: f64,
}

/// TS: `intrinsicShortSideObserver.ts:711-741` (`canonicalDimensions`).
fn canonical_dimensions(placed: &[Arc<IrregularPlacedPiece>]) -> Option<CanonicalDimensions> {
    let points: Vec<crate::canonical_grid::CanonicalGridPoint> = placed
        .iter()
        .flat_map(|entry| placed_collision_world_grid_path(entry).unwrap_or_default())
        .collect();
    if points.is_empty() {
        return None;
    }
    let xs: Vec<f64> = points.iter().map(|p| p.x).collect();
    let ys: Vec<f64> = points.iter().map(|p| p.y).collect();
    let min_x = js_math::min_all(&xs);
    let min_y = js_math::min_all(&ys);
    let max_x = js_math::max_all(&xs);
    let max_y = js_math::max_all(&ys);
    let width_grid = max_x - min_x;
    let height_grid = max_y - min_y;
    if ![min_x, min_y, max_x, max_y, width_grid, height_grid]
        .iter()
        .all(|value| crate::js_number::is_safe_integer(*value))
        || width_grid < 0.0
        || height_grid < 0.0
    {
        return None;
    }
    let width_mm = from_grid(width_grid);
    let height_mm = from_grid(height_grid);
    if width_mm.is_finite() && height_mm.is_finite() {
        Some(CanonicalDimensions {
            width_mm,
            height_mm,
            width_grid,
            height_grid,
        })
    } else {
        None
    }
}

/// TS: `intrinsicShortSideObserver.ts:743-745` (`hashCanonicalIdentity`).
fn hash_canonical_identity(identity: Option<String>) -> Option<String> {
    identity.map(|identity| sha256_hex(&identity))
}

/// TS: `intrinsicShortSideObserver.ts:747-754`
/// (`withMeasuredIntrinsicShortSideObserverTrace`). Two-pass, not
/// fixpoint-iterated -- see `short-side.md` §8.1 for why this must stay a
/// two-pass measurement.
pub fn with_measured_trace(
    trace: IntrinsicShortSideObserverTrace,
) -> IntrinsicShortSideObserverTrace {
    let first_measurement = byte_length(&trace.to_json()) as f64;
    let measured = IntrinsicShortSideObserverTrace {
        serialized_trace_bytes: first_measurement,
        ..trace
    };
    let final_measurement = byte_length(&measured.to_json()) as f64;
    IntrinsicShortSideObserverTrace {
        serialized_trace_bytes: final_measurement,
        ..measured
    }
}

/// TS: `intrinsicShortSideObserver.ts:756-771` (`censoredTrace`).
fn censored_trace(
    trace: IntrinsicShortSideObserverTrace,
    status: IntrinsicShortSideObserverStatus,
    runtime_budget_exceeded: bool,
) -> IntrinsicShortSideObserverTrace {
    with_measured_trace(IntrinsicShortSideObserverTrace {
        status,
        runtime_budget_exceeded,
        endpoints: Vec::new(),
        ranked_canonical_geometry_hashes: Vec::new(),
        observer_winner_canonical_geometry_hash: None,
        observer_winner_rotation_deg: None,
        serialized_trace_bytes: 0.0,
        ..trace
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(width: f64, height: f64) -> SheetSpec {
        SheetSpec {
            width,
            height,
            label: "test".to_string(),
        }
    }

    #[test]
    fn no_endpoints_skips_with_the_documented_status() {
        let trace =
            observe_intrinsic_short_side_orientations(ObserveIntrinsicShortSideOrientationsInput {
                sheet: &sheet(600.0, 400.0),
                endpoints: &[],
                production_placed_collision_geometries: None,
                now: Some(&|| 0.0),
            });
        assert_eq!(
            trace.status,
            IntrinsicShortSideObserverStatus::SkippedNoSettledCompleteEndpoints
        );
        assert_eq!(trace.output_influence, ShortSideOutputInfluence::None);
        assert!(trace.endpoints.is_empty());
        assert!(trace.serialized_trace_bytes > 0.0);
    }
}
