//! The E1 strict/direct decoder: one deterministic, sheet-independent
//! constructive placement pass over an ordered piece list, followed by
//! terminal q0/q90 real-sheet legality.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts`
//! (2,364 lines), ported in full per
//! `docs/planning/rust-irregular-backend/characterization/strict-decoder-gap-family.md`
//! (this module's primary governing source; every section is load-bearing,
//! not merely background) and
//! `docs/planning/rust-irregular-backend/characterization/checkpoint-encoding.md`
//! §2/§3.2/§8.2/§8.3 (the `IntrinsicStrictDirectCheckpoint` hash-preimage
//! contract).
//!
//! # Reused (GREEN) modules -- never duplicated here
//!
//! - `checkpoints::canonical_json::{intrinsic_strict_canonical_json, JsValue,
//!   locale_compare_keys}` -- Encoder B, already a byte-exact port of
//!   `intrinsicStrictCanonicalJson` (`intrinsicStrictDecoder.ts:1257-1277`)
//!   and its `localeCompare`-equivalent key sort. Every `.localeCompare()`
//!   call site in the original file (`compareLocalScores`,
//!   `compareLegacyAbsoluteEnvelopeCandidates`, `compareContactBandCandidates`,
//!   the gap-region tie-break inside `scoreCandidate`, `selectTerminalOrientation`,
//!   `rankIntrinsicStrictParetoPartition`, `orderIntrinsicStrictParetoFront`)
//!   routes through `locale_compare_keys`.
//! - `geometry::hash::sha256_hex` -- the `createHash('sha256').update(...).digest('hex')`
//!   idiom used for `requestFingerprint`, `integrityHash`, and every terminal
//!   `canonicalGeometryHash`.
//! - `canonical_grid::{math, layout, offset_policy}` -- `to_grid_mm`/`from_grid`,
//!   `canonical_grid_convex_hull`/`canonical_grid_counter_clockwise`/
//!   `canonical_grid_clockwise`/`canonical_grid_absolute_doubled_area`/
//!   `canonical_grid_signed_doubled_area`/`canonical_grid_point_on_segment`/
//!   `canonical_grid_compare_bigints`/`doubled_grid_area_to_mm2`, and
//!   `assert_canonical_grid_legal_layout`/`canonical_collision_layout_identity`/
//!   `measure_canonical_enclosed_cavities`/`measure_canonical_layout_contacts`/
//!   `measure_canonical_layout_envelope`/`measure_canonical_layout_topology_exact`/
//!   `analyze_canonical_layout_structure`.
//! - `search::gap_regions::{CanonicalIntrinsicGapRegion,
//!   CanonicalIntrinsicGapRegionKind, CanonicalIntrinsicGapRegionAabb,
//!   derive_canonical_intrinsic_gap_regions, candidate_contained_in_intrinsic_gap}`
//!   -- the sibling module's byte-exact port of `intrinsicGapRegions.ts`
//!   (both exported functions, called from this file at the same two TS call
//!   sites: `intrinsicStrictDecoder.ts:568` before the transform loop, and
//!   `:760` after a gap-fill placement for evidence bookkeeping; see this
//!   module's own top-level rustdoc for why it is a separate file).
//! - `search::beam_state::{IrregularBeamState, IrregularBeamStateInput,
//!   WithPlacementInput, WithUnplacedPieceInput, IrregularQuarterTurnDegrees,
//!   IrregularCollisionBounds, IrregularBeamStatePlacementPhaseTimings,
//!   TimingNowFn}` -- the Arc-wrapped immutable placement-state class this
//!   file only ever *extends*, never reimplements.
//! - `nfp_ifp::{generate_placement_candidates, LegalCandidateMemo,
//!   NfpIfpControl, NfpIfpControlAbortError, NfpIfpAbortReason, NfpIfpError}`
//!   and `caches::{GeometryCacheStore, resolve_transformed_collision_geometry,
//!   TransformCollisionGeometryKeyInput, CandidateDomain,
//!   NfpCandidatePruningMode, DEFAULT_NFP_CONSTRUCTION_ALGORITHM}` -- the
//!   candidate-generation and transformed-collision-geometry cache surface.
//! - `validation::placement::IrregularGeometryInputError` -- the same type
//!   `nfp_ifp::service` already imports from this module, reused here for
//!   call-site consistency rather than the structurally-identical
//!   `transforms::generator::IrregularGeometryInputError`.
//!
//! # Two seams this file introduces (documented, not silently invented)
//!
//! - **`geometry_cache: &mut GeometryCacheStore` / `settings:
//!   &IrregularNestingSettings`** are explicit function parameters on
//!   [`construct_intrinsic_strict_state`], mirroring the TS `Effect`
//!   dependencies `GeometryKernel | GeometrySettings | NfpIfpService` that
//!   `intrinsicStrictDecoder.ts` resolves via `yield*`. Rust has no ambient
//!   dependency-injection layer, so callers construct/own these explicitly --
//!   the same "seam type against domain/beam_state shapes" pattern
//!   `layout_scorer`'s `LayoutScorerBeamStateView` already establishes.
//! - `intrinsicGapRegions.ts` itself is ported in `search::gap_regions`
//!   (a sibling file, separately owned) rather than duplicated here. That
//!   module now has a complete, independently tested implementation
//!   (`CanonicalIntrinsicGapRegion` + both exported functions + every
//!   private helper), so this file imports it directly instead of embedding
//!   its own copy -- never touching `gap_regions.rs` itself, only consuming
//!   its public API, per the file-ownership rule's stated exception for
//!   "where a sibling tower's type is needed."
//!
//! # Deliberately not ported
//!
//! - `IrregularNestingNotImplementedError` -- per the established convention
//!   in `search::layout_scorer`/`geometry::collision_builder`'s own doc
//!   comments, this DI-unimplemented-layer error has zero production callers
//!   reachable from this cluster and no Rust equivalent DI stub exists; it is
//!   dropped from [`IntrinsicStrictDecoderFailure`] exactly as those sibling
//!   modules already drop it from their own error unions.
//! - `IntrinsicStrictFeatureContactObserver` (`featureContactObserver`) --
//!   the TS source's own doc comment proves this is "Observer-only F0 trace
//!   records... emitted before scoring changes no behavior" (`:239-240`).
//!   Every callback fires with data this module already computes internally
//!   and cannot influence any accepted outcome, evaluation count, or
//!   checkpoint byte. Omitted per the migration prompt's "unless you can
//!   prove it is completely unobservable" bar, which the TS source itself
//!   satisfies via that doc comment.
//! - `NfpIfpCandidateProvenance` plumbing (`onCandidateProvenance`) -- only
//!   ever populated when a `featureContactObserver` is attached (see above);
//!   with that observer removed, `want_provenance` is always `false` and no
//!   provenance value is ever read by this cluster's own code.

use std::cmp::Ordering;
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

use crate::caches::{
    resolve_transformed_collision_geometry, CandidateDomain, GeometryCacheStore,
    NfpCandidatePruningMode, TransformCollisionGeometryKeyInput,
    DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
};
use crate::canonical_grid::layout::{
    analyze_canonical_layout_structure, assert_canonical_grid_legal_layout,
    canonical_collision_layout_identity, measure_canonical_enclosed_cavities,
    measure_canonical_layout_contacts, measure_canonical_layout_envelope,
    measure_canonical_layout_topology_exact,
};
use crate::canonical_grid::{doubled_grid_area_to_mm2, from_grid, to_grid_mm};
use crate::checkpoints::canonical_json::{
    intrinsic_strict_canonical_json, locale_compare_keys, JsValue,
};
use crate::domain::{
    IrregularNestingSettings, IrregularPlacedPiece, IrregularPlacement,
    IrregularPlacementCandidate, IrregularPoint, IrregularPreparedPiece, IrregularTransform,
    IrregularTransformCandidate, IrregularTransformReason, PieceId, SheetSpec,
    TransformedCollisionGeometry,
};
use crate::geometry::hash::sha256_hex;
use crate::js_number::{cmp_js_code_units, fold_negative_zero, js_math, number_to_js_string};
use crate::nfp_ifp::{
    generate_placement_candidates, GeneratePlacementCandidatesInput, LegalCandidateMemo,
    NfpIfpAbortReason, NfpIfpControl, NfpIfpControlAbortError, NfpIfpError,
};
use crate::validation::placement::IrregularGeometryInputError;

use super::beam_state::{
    IrregularBeamState, IrregularBeamStateInput, IrregularBeamStatePlacementPhaseTimings,
    IrregularCollisionBounds, IrregularQuarterTurnDegrees, TimingNowFn, WithPlacementInput,
    WithUnplacedPieceInput,
};

use super::gap_regions::{
    candidate_contained_in_intrinsic_gap, derive_canonical_intrinsic_gap_regions,
    CanonicalIntrinsicGapRegion,
};

// ===========================================================================
// Constants (`intrinsicStrictDecoder.ts:46-65,182-183,1348-1349`)
// ===========================================================================

/// TS: `intrinsicStrictDecoder.ts:46-51` `INTRINSIC_COORDINATE_DOMAIN`.
/// Placeholder sheet for candidate generation in the deferred sheetless
/// domain. A function (not a `const`) because `SheetSpec` owns a heap
/// `String` label.
pub fn intrinsic_coordinate_domain() -> SheetSpec {
    SheetSpec {
        width: 1.0,
        height: 1.0,
        label: "intrinsic-sheetless-coordinate-domain".to_string(),
    }
}

/// TS: `intrinsicStrictDecoder.ts:60-65` `INTRINSIC_STRICT_COHESION_FLOORS`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicStrictCohesionFloors {
    pub maximum_enclosed_cavity_count: f64,
    pub maximum_isolated_piece_count: f64,
    pub minimum_largest_positive_contact_component_ratio: f64,
    pub maximum_largest_occupied_hull_gap_ratio: f64,
}

pub const INTRINSIC_STRICT_COHESION_FLOORS: IntrinsicStrictCohesionFloors =
    IntrinsicStrictCohesionFloors {
        maximum_enclosed_cavity_count: 2.0,
        maximum_isolated_piece_count: 2.0,
        minimum_largest_positive_contact_component_ratio: 0.8,
        maximum_largest_occupied_hull_gap_ratio: 0.15,
    };

/// TS: `intrinsicStrictDecoder.ts:182-183`.
pub const INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION: &str =
    "intrinsic-strict-direct-checkpoint-v1";

/// TS: `intrinsicStrictDecoder.ts:1348`.
pub const INTRINSIC_STRICT_PHASE_INSTRUMENTATION_ALLOWANCE_MS: f64 = 0.05;
/// TS: `intrinsicStrictDecoder.ts:1349`.
pub const INTRINSIC_STRICT_PHASE_MAXIMUM_RELAXED_RESIDUAL_RATIO: f64 = 0.05;

// ===========================================================================
// The `timingNow` seam (`intrinsicStrictDecoder.ts:412`, mirroring
// `search::beam_state`'s own private default).
// ===========================================================================

static PROCESS_START: LazyLock<Instant> = LazyLock::new(Instant::now);

/// TS: `input.timingNow ?? performance.now.bind(performance)`
/// (`intrinsicStrictDecoder.ts:412`). A separate process-relative monotonic
/// clock from `search::beam_state`'s own private default (that one is not
/// `pub`), but behaviorally equivalent: both approximate `performance.now()`
/// and feed only diagnostic (never correctness-affecting) timing fields.
fn default_timing_now() -> f64 {
    PROCESS_START.elapsed().as_secs_f64() * 1000.0
}

// ===========================================================================
// Error taxonomy (`intrinsicStrictDecoder.ts:67-70`, characterization §11)
// ===========================================================================

/// TS: `intrinsicStrictDecoder.ts:67-70` `IntrinsicStrictDecoderError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntrinsicStrictDecoderError {
    pub operation: String,
    pub message: String,
}

/// The `constructIntrinsicStrictState` Effect error channel,
/// `IntrinsicStrictDecoderError | IrregularNestingNotImplementedError |
/// IrregularGeometryInputError | IrregularNfpIfpControlAbortError`
/// (`intrinsicStrictDecoder.ts:404-409`), minus the DI-only third arm --
/// see this module's top-level doc, "Deliberately not ported".
#[derive(Clone, Debug, PartialEq)]
pub enum IntrinsicStrictDecoderFailure {
    Decoder(IntrinsicStrictDecoderError),
    Geometry(IrregularGeometryInputError),
    Abort(NfpIfpControlAbortError),
}

impl From<IntrinsicStrictDecoderError> for IntrinsicStrictDecoderFailure {
    fn from(value: IntrinsicStrictDecoderError) -> Self {
        IntrinsicStrictDecoderFailure::Decoder(value)
    }
}

fn decoder_error(operation: &str, message: impl Into<String>) -> IntrinsicStrictDecoderFailure {
    IntrinsicStrictDecoderFailure::Decoder(IntrinsicStrictDecoderError {
        operation: operation.to_string(),
        message: message.into(),
    })
}

// ===========================================================================
// `transformCandidateOrder` (`intrinsicStrictDecoder.ts:53-58`)
// ===========================================================================

/// `Order.Number`: `NaN` sorts less than every non-`NaN` value and equals
/// another `NaN` (`intrinsicStrictDecoder.ts` characterization §6.1).
fn js_order_number(a: f64, b: f64) -> Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.partial_cmp(&b).unwrap_or(Ordering::Equal),
    }
}

fn transform_reason_str(reason: IrregularTransformReason) -> &'static str {
    match reason {
        IrregularTransformReason::Orthogonal => "orthogonal",
        IrregularTransformReason::EdgeAlignment => "edge_alignment",
        IrregularTransformReason::Configured => "configured",
    }
}

/// TS: `transformCandidateOrder` (`intrinsicStrictDecoder.ts:53-58`).
/// `Order.combineAll([index asc, rotationDeg asc, mirrored asc(false<true),
/// reason asc(ordinal string)])`.
pub fn transform_candidate_order(
    a: &IrregularTransformCandidate,
    b: &IrregularTransformCandidate,
) -> Ordering {
    js_order_number(a.index, b.index)
        .then_with(|| js_order_number(a.rotation_deg, b.rotation_deg))
        .then_with(|| a.mirrored.cmp(&b.mirrored))
        .then_with(|| {
            cmp_js_code_units(
                transform_reason_str(a.reason),
                transform_reason_str(b.reason),
            )
        })
}

// ===========================================================================
// `canonicalLinearMetric`/`canonicalAreaMetric` (`:1692-1699`)
// ===========================================================================

/// TS: `canonicalLinearMetric` (`intrinsicStrictDecoder.ts:1692-1693`).
pub fn canonical_linear_metric(value_mm: f64) -> f64 {
    js_math::round(value_mm * 1_000.0)
}

/// TS: `canonicalAreaMetric` (`intrinsicStrictDecoder.ts:1697-1698`).
pub fn canonical_area_metric(value_mm2: f64) -> f64 {
    js_math::round(value_mm2 * 1_000_000.0)
}

fn desc_cmp(a: f64, b: f64) -> Ordering {
    b.partial_cmp(&a).unwrap_or(Ordering::Equal)
}

fn asc_cmp(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

fn parse_bigint(value: &str) -> BigInt {
    value
        .parse()
        .expect("decimal doubled-area strings are always valid BigInt literals")
}

fn compare_bigint_decimal_strings(a: &str, b: &str) -> Ordering {
    parse_bigint(a).cmp(&parse_bigint(b))
}

// ===========================================================================
// Local score types (`:80-107`)
// ===========================================================================

/// TS: `intrinsicStrictDecoder.ts:86-90` the `exact` sub-object of
/// `IntrinsicStrictLocalScore`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicStrictLocalScoreExact {
    pub maximum_side_grid: f64,
    /// BigInt-as-decimal-string (`canonicalGridMath.md`/R6).
    pub envelope_area_grid2: String,
    pub envelope_span_grid: f64,
}

/// TS: `intrinsicStrictDecoder.ts:80-91` `IntrinsicStrictLocalScore`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicStrictLocalScore {
    pub maximum_side_mm: f64,
    pub envelope_area_mm2: f64,
    pub envelope_span_mm: f64,
    pub shared_boundary_length_mm: f64,
    pub canonical_combined_geometry_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact: Option<IntrinsicStrictLocalScoreExact>,
}

/// TS: `intrinsicStrictDecoder.ts:93-101` `IntrinsicStrictCandidateMode`.
/// Modeled as an explicit enum (checkpoint-encoding.md risk 7 /
/// characterization §3.1): TS tests this discriminated union with `typeof
/// input.candidateMode === 'object'`, not a tag field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicStrictComparatorMode {
    PureGrowth,
    LegacyAbsoluteEnvelope,
    ContactBand,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicStrictCandidateMode {
    Comparator(IntrinsicStrictComparatorMode),
    GapContained,
}

/// TS: `intrinsicStrictDecoder.ts:102-106` `IntrinsicStrictFamilyWinner`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicStrictFamilyWinner {
    pub score: IntrinsicStrictLocalScore,
    pub moving_collision_area_mm2: f64,
    pub moving_collision_doubled_area_grid2: Option<String>,
}

// ===========================================================================
// Completed-layout metrics and certificate (`:108-155`)
// ===========================================================================

/// TS: `intrinsicStrictDecoder.ts:128-139` the `exact` sub-object of
/// `IntrinsicStrictCompletedMetrics`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicStrictCompletedMetricsExact {
    pub envelope_maximum_side_grid: f64,
    pub envelope_area_grid2: String,
    pub envelope_span_grid: f64,
    pub total_enclosed_cavity_doubled_area_grid2: String,
    pub largest_occupied_hull_gap_doubled_area_grid2: String,
    pub occupied_hull_doubled_area_grid2: String,
    pub occupied_hull_waste_doubled_area_grid2: String,
    pub largest_positive_contact_component_size: f64,
    pub placed_piece_count: f64,
    pub occupied_outside_largest_contact_component_doubled_area_grid2: String,
}

/// TS: `intrinsicStrictDecoder.ts:108-140` `IntrinsicStrictCompletedMetrics`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicStrictCompletedMetrics {
    pub envelope_maximum_side_mm: f64,
    pub envelope_area_mm2: f64,
    pub envelope_span_mm: f64,
    pub enclosed_cavity_count: f64,
    pub total_enclosed_cavity_area_mm2: f64,
    pub largest_occupied_hull_gap_ratio: f64,
    pub isolated_piece_count: f64,
    pub positive_contact_component_count: f64,
    pub largest_positive_contact_component_size: f64,
    pub largest_positive_contact_component_ratio: f64,
    pub occupied_area_outside_largest_contact_component_mm2: f64,
    pub occupied_hull_waste_ratio: f64,
    pub total_structural_contacts: f64,
    pub dominant_structural_contacts: f64,
    pub contact_units: f64,
    pub shared_boundary_length_mm: f64,
    pub canonical_geometry_hash: String,
    pub runtime_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact: Option<IntrinsicStrictCompletedMetricsExact>,
}

/// TS: `intrinsicStrictDecoder.ts:142-147` `IntrinsicSheetlessCompletedLayout`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicSheetlessCompletedLayout {
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub canonical_geometry_identity: String,
    pub canonical_geometry_hash: String,
    pub metrics: IntrinsicStrictCompletedMetrics,
}

/// TS: `intrinsicStrictDecoder.ts:151` `keyof typeof
/// INTRINSIC_STRICT_COHESION_FLOORS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntrinsicStrictCohesionFloor {
    MaximumEnclosedCavityCount,
    MaximumIsolatedPieceCount,
    MinimumLargestPositiveContactComponentRatio,
    MaximumLargestOccupiedHullGapRatio,
}

/// TS: `intrinsicStrictDecoder.ts:149-155` `IntrinsicStrictCertificate`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicStrictCertificate {
    pub passes: bool,
    pub violated_floors: Vec<IntrinsicStrictCohesionFloor>,
    pub relative_deficit_sum: f64,
    pub exact_relative_deficit_numerator: Option<String>,
    pub exact_relative_deficit_denominator: Option<String>,
}

/// TS: `intrinsicStrictDecoder.ts:158` `'completed' | 'incomplete' |
/// 'infeasible-final-sheet'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicStrictDecodeStatus {
    Completed,
    Incomplete,
    InfeasibleFinalSheet,
}

/// TS: `intrinsicStrictDecoder.ts:162` `0 | 90`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalRotationDeg {
    Zero,
    Ninety,
}

/// TS: `intrinsicStrictDecoder.ts:157-168` `IntrinsicStrictDecodeResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicStrictDecodeResult {
    pub status: IntrinsicStrictDecodeStatus,
    pub placements: Vec<IrregularPlacement>,
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub unplaced_piece_ids: Vec<PieceId>,
    pub terminal_rotation_deg: Option<TerminalRotationDeg>,
    pub canonical_geometry_hash: Option<String>,
    pub metrics: Option<IntrinsicStrictCompletedMetrics>,
    pub certificate: Option<IntrinsicStrictCertificate>,
    pub step_trace: Vec<IntrinsicStrictStepTrace>,
    pub runtime_ms: f64,
}

// ===========================================================================
// Step trace / gap-fill evidence / phase timings (`:72-91,199-237`)
// ===========================================================================

/// TS: `intrinsicStrictDecoder.ts:72-78` `IntrinsicStrictStepTrace`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicStrictStepTrace {
    pub piece_id: PieceId,
    pub candidate_count: f64,
    pub transform_family_count: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_transform_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_score: Option<IntrinsicStrictLocalScore>,
}

/// TS: `intrinsicStrictDecoder.ts:228-237` `IntrinsicStrictGapFillEvidence`.
/// `shared_boundary_length_mm` can genuinely be `NaN`; the two envelope-delta
/// fields can genuinely be `+Infinity` -- both intentional, load-bearing
/// production values (characterization §8.1 hazard 2). `serde_json` renders
/// non-finite `f64` as JSON `null` (empirically verified against this
/// crate's pinned `serde_json` version), matching V8's `JSON.stringify`
/// exactly -- see this module's top-level doc for the verification note.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicStrictGapFillEvidence {
    pub piece_id: PieceId,
    pub region_key: String,
    pub region_area_before_mm2: f64,
    pub region_area_after_mm2: f64,
    pub envelope_maximum_side_delta_mm: f64,
    pub envelope_area_delta_mm2: f64,
    pub shared_boundary_length_mm: f64,
    pub non_inert: bool,
}

/// TS: `intrinsicStrictDecoder.ts:300-313` `MutableCandidateStatePhaseTimings`
/// (also, snapshotted, `IntrinsicStrictDirectPhaseLedger.candidateState`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateStatePhaseTimings {
    pub placement_object_ms: f64,
    pub state_placement_ms: f64,
    pub state_placement_canonical_entry_key_ms: f64,
    pub state_placement_spatial_index_ms: f64,
    pub state_placement_contact_measurement_ms: f64,
    pub state_placement_state_assembly_ms: f64,
    pub state_placement_bookkeeping_ms: f64,
    pub bottom_left_anchoring_ms: f64,
    pub envelope_scoring_ms: f64,
    pub gap_classification_ms: f64,
    pub candidate_selection_ms: f64,
    pub total_ms: f64,
}

/// TS: `intrinsicStrictDecoder.ts:199-203` `IntrinsicStrictDirectPhaseLedger`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicStrictDirectPhaseLedger {
    pub candidate_generation_ms: f64,
    pub candidate_state_scoring_ms: f64,
    pub candidate_state: CandidateStatePhaseTimings,
}

fn intrinsic_strict_direct_phase_ledger_valid(ledger: &IntrinsicStrictDirectPhaseLedger) -> bool {
    let state = &ledger.candidate_state;
    [
        ledger.candidate_generation_ms,
        ledger.candidate_state_scoring_ms,
        state.placement_object_ms,
        state.state_placement_ms,
        state.state_placement_canonical_entry_key_ms,
        state.state_placement_spatial_index_ms,
        state.state_placement_contact_measurement_ms,
        state.state_placement_state_assembly_ms,
        state.state_placement_bookkeeping_ms,
        state.bottom_left_anchoring_ms,
        state.envelope_scoring_ms,
        state.gap_classification_ms,
        state.candidate_selection_ms,
        state.total_ms,
    ]
    .iter()
    .all(|value| value.is_finite() && *value >= 0.0)
}

/// TS: `intrinsicStrictDecoder.ts:214-226` `IntrinsicStrictCandidateStatePhaseTimings`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StatePlacementPhaseTimingsDisplay {
    pub canonical_entry_key_ms: f64,
    pub spatial_index_ms: f64,
    pub contact_measurement_ms: f64,
    pub state_assembly_ms: f64,
    pub bookkeeping_ms: f64,
    pub total_ms: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicStrictCandidateStatePhaseTimings {
    pub placement_object_ms: f64,
    pub state_placement_ms: f64,
    pub state_placement: StatePlacementPhaseTimingsDisplay,
    pub bottom_left_anchoring_ms: f64,
    pub envelope_scoring_ms: f64,
    pub gap_classification_ms: f64,
    pub score_bookkeeping_ms: f64,
    pub candidate_selection_ms: f64,
    pub bookkeeping_ms: f64,
    pub coverage_complete: bool,
    pub total_ms: f64,
}

/// TS: `intrinsicStrictDecoder.ts:205-212` `IntrinsicStrictConstructPhaseTimings`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicStrictConstructPhaseTimings {
    pub candidate_generation_ms: f64,
    pub candidate_state_scoring_ms: f64,
    pub candidate_state_scoring: IntrinsicStrictCandidateStatePhaseTimings,
    pub bookkeeping_ms: f64,
    pub coverage_complete: bool,
    pub total_ms: f64,
}

/// TS: `intrinsicStrictPhaseCoverageComplete` (`:1351-1363`).
pub fn intrinsic_strict_phase_coverage_complete(total_ms: f64, bookkeeping_ms: f64) -> bool {
    total_ms >= 0.0
        && bookkeeping_ms >= 0.0
        && (bookkeeping_ms <= total_ms * 0.01
            || (bookkeeping_ms <= INTRINSIC_STRICT_PHASE_INSTRUMENTATION_ALLOWANCE_MS
                && bookkeeping_ms
                    <= total_ms * INTRINSIC_STRICT_PHASE_MAXIMUM_RELAXED_RESIDUAL_RATIO))
}

/// TS: `makeConstructPhaseTimings` (`:1279-1336`).
fn make_construct_phase_timings(
    total_ms: f64,
    candidate_generation_ms: f64,
    candidate_state_scoring_ms: f64,
    candidate_state: &CandidateStatePhaseTimings,
) -> IntrinsicStrictConstructPhaseTimings {
    let state_placement = StatePlacementPhaseTimingsDisplay {
        canonical_entry_key_ms: candidate_state.state_placement_canonical_entry_key_ms,
        spatial_index_ms: candidate_state.state_placement_spatial_index_ms,
        contact_measurement_ms: candidate_state.state_placement_contact_measurement_ms,
        state_assembly_ms: candidate_state.state_placement_state_assembly_ms,
        bookkeeping_ms: candidate_state.state_placement_bookkeeping_ms,
        total_ms: candidate_state.state_placement_ms,
    };
    let candidate_state_measured_ms = candidate_state.placement_object_ms
        + candidate_state.state_placement_ms
        + candidate_state.bottom_left_anchoring_ms
        + candidate_state.envelope_scoring_ms
        + candidate_state.gap_classification_ms;
    let score_bookkeeping_ms =
        js_math::max(0.0, candidate_state.total_ms - candidate_state_measured_ms);
    let measured_candidate_state_scoring_ms =
        candidate_state.total_ms + candidate_state.candidate_selection_ms;
    let candidate_state_bookkeeping_ms = js_math::max(
        0.0,
        candidate_state_scoring_ms - measured_candidate_state_scoring_ms,
    );
    let candidate_state_scoring = IntrinsicStrictCandidateStatePhaseTimings {
        placement_object_ms: candidate_state.placement_object_ms,
        state_placement_ms: candidate_state.state_placement_ms,
        state_placement,
        bottom_left_anchoring_ms: candidate_state.bottom_left_anchoring_ms,
        envelope_scoring_ms: candidate_state.envelope_scoring_ms,
        gap_classification_ms: candidate_state.gap_classification_ms,
        score_bookkeeping_ms,
        candidate_selection_ms: candidate_state.candidate_selection_ms,
        bookkeeping_ms: candidate_state_bookkeeping_ms,
        coverage_complete: intrinsic_strict_phase_coverage_complete(
            candidate_state_scoring_ms,
            candidate_state_bookkeeping_ms,
        ),
        total_ms: candidate_state_scoring_ms,
    };
    let measured_ms = candidate_generation_ms + candidate_state_scoring_ms;
    let bookkeeping_ms = js_math::max(0.0, total_ms - measured_ms);
    let coverage_complete = [
        total_ms,
        candidate_generation_ms,
        candidate_state_scoring_ms,
        bookkeeping_ms,
    ]
    .iter()
    .all(|value| value.is_finite() && *value >= 0.0)
        && intrinsic_strict_phase_coverage_complete(total_ms, bookkeeping_ms);
    IntrinsicStrictConstructPhaseTimings {
        candidate_generation_ms,
        candidate_state_scoring_ms,
        candidate_state_scoring,
        bookkeeping_ms,
        coverage_complete,
        total_ms,
    }
}

// ===========================================================================
// Direct checkpoint (`:170-197`, checkpoint-encoding.md §2/§3.2)
// ===========================================================================

/// TS: `intrinsicStrictDecoder.ts:170-180` `IntrinsicStrictConstructResult`.
///
/// `PartialEq` is implemented manually (not derived) because
/// `IrregularBeamState` (a sibling "hot core" tower's type, never edited
/// here) does not itself implement `PartialEq` -- per that tower's own
/// documented convention (`search::layout_scorer`'s and `beam_state`'s own
/// doc comments), state identity is `Arc::ptr_eq`, matching the TS source's
/// own use of object-identity (`!==`) for `IrregularBeamState` comparisons
/// (e.g. the Pareto-front dedup at `intrinsicStrictDecoder.ts:2274-2279`,
/// see the characterization doc §6.7), never structural/value equality.
#[derive(Clone, Debug)]
pub struct IntrinsicStrictConstructResult {
    pub state: Arc<IrregularBeamState>,
    pub step_trace: Vec<IntrinsicStrictStepTrace>,
    pub gap_fill_evidence: Vec<IntrinsicStrictGapFillEvidence>,
    pub candidate_evaluation_count: Option<f64>,
    pub truncation_reason: Option<TruncationReason>,
    pub pause_reason: Option<PauseReason>,
    pub checkpoint: Option<IntrinsicStrictDirectCheckpoint>,
    pub phase_timings: Option<IntrinsicStrictConstructPhaseTimings>,
    pub runtime_ms: f64,
}

impl PartialEq for IntrinsicStrictConstructResult {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
            && self.step_trace == other.step_trace
            && self.gap_fill_evidence == other.gap_fill_evidence
            && self.candidate_evaluation_count == other.candidate_evaluation_count
            && self.truncation_reason == other.truncation_reason
            && self.pause_reason == other.pause_reason
            && self.checkpoint == other.checkpoint
            && self.phase_timings == other.phase_timings
            && self.runtime_ms == other.runtime_ms
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TruncationReason {
    MaximumCandidateEvaluations,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseReason {
    CompletedPieceBoundary,
}

/// TS: `intrinsicStrictDecoder.ts:185-197` `IntrinsicStrictDirectCheckpoint`.
///
/// `PartialEq` is implemented manually; see
/// [`IntrinsicStrictConstructResult`]'s doc comment for why `state` compares
/// via `Arc::ptr_eq`.
#[derive(Clone, Debug)]
pub struct IntrinsicStrictDirectCheckpoint {
    pub version: String,
    pub producer_role: String,
    pub request_fingerprint: String,
    pub integrity_hash: String,
    pub state: Arc<IrregularBeamState>,
    pub next_piece_index: f64,
    pub step_trace: Vec<IntrinsicStrictStepTrace>,
    pub gap_fill_evidence: Vec<IntrinsicStrictGapFillEvidence>,
    pub candidate_evaluation_count: f64,
    pub active_runtime_ms: f64,
    pub phase_ledger: Option<IntrinsicStrictDirectPhaseLedger>,
}

impl PartialEq for IntrinsicStrictDirectCheckpoint {
    fn eq(&self, other: &Self) -> bool {
        self.version == other.version
            && self.producer_role == other.producer_role
            && self.request_fingerprint == other.request_fingerprint
            && self.integrity_hash == other.integrity_hash
            && Arc::ptr_eq(&self.state, &other.state)
            && self.next_piece_index == other.next_piece_index
            && self.step_trace == other.step_trace
            && self.gap_fill_evidence == other.gap_fill_evidence
            && self.candidate_evaluation_count == other.candidate_evaluation_count
            && self.active_runtime_ms == other.active_runtime_ms
            && self.phase_ledger == other.phase_ledger
    }
}

/// TS: `intrinsicStrictDecoder.ts:272-288` `ConstructIntrinsicStrictStateInput`.
pub struct ConstructIntrinsicStrictStateInput<'a> {
    pub all_prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    pub remaining_prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    pub frozen_placed: &'a [Arc<IrregularPlacedPiece>],
    pub candidate_mode: IntrinsicStrictCandidateMode,
    pub maximum_runtime_ms: Option<f64>,
    pub maximum_candidate_evaluation_count: Option<f64>,
    pub capture_candidate_evaluation_count: bool,
    pub capture_phase_timings: bool,
    pub timing_now: Option<&'a TimingNowFn>,
    pub producer_role: Option<String>,
    pub checkpoint: Option<IntrinsicStrictDirectCheckpoint>,
    pub maximum_completed_piece_boundaries: Option<f64>,
    pub control: Option<&'a mut dyn NfpIfpControl>,
}

// ===========================================================================
// `ScoredCandidate` (`:290-298`)
// ===========================================================================

/// `PartialEq` is implemented manually; see
/// [`IntrinsicStrictConstructResult`]'s doc comment for why `state` compares
/// via `Arc::ptr_eq`.
#[derive(Clone, Debug)]
struct ScoredCandidate {
    state: Arc<IrregularBeamState>,
    score: IntrinsicStrictLocalScore,
    transform_family: String,
    candidate: IrregularPlacementCandidate,
    moving_collision_area_mm2: f64,
    moving_collision_doubled_area_grid2: String,
    containing_gap: Option<CanonicalIntrinsicGapRegion>,
}

impl PartialEq for ScoredCandidate {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
            && self.score == other.score
            && self.transform_family == other.transform_family
            && self.candidate == other.candidate
            && self.moving_collision_area_mm2 == other.moving_collision_area_mm2
            && self.moving_collision_doubled_area_grid2 == other.moving_collision_doubled_area_grid2
            && self.containing_gap == other.containing_gap
    }
}

impl ScoredCandidate {
    fn as_family_winner(&self) -> IntrinsicStrictFamilyWinner {
        IntrinsicStrictFamilyWinner {
            score: self.score.clone(),
            moving_collision_area_mm2: self.moving_collision_area_mm2,
            moving_collision_doubled_area_grid2: Some(
                self.moving_collision_doubled_area_grid2.clone(),
            ),
        }
    }
}

// ===========================================================================
// `preparedPieceId`/`placedPieceId` (`:1386-1393`)
// ===========================================================================

fn prepared_piece_id(piece: &IrregularPreparedPiece) -> PieceId {
    piece
        .piece_id
        .clone()
        .unwrap_or_else(|| piece.source.id.clone())
}

fn placed_piece_id(piece: &IrregularPlacedPiece) -> PieceId {
    piece
        .placement
        .piece_id
        .clone()
        .unwrap_or_else(|| piece.placement.source_piece_id.clone())
}

// ===========================================================================
// `canonicalCollisionArea` (`:1701-1739`)
// ===========================================================================

fn canonical_collision_area(moving: &TransformedCollisionGeometry) -> Option<(f64, String)> {
    let points = &moving.polygon.points;
    if points.is_empty() {
        return None;
    }
    let mut doubled_area = BigInt::from(0);
    for index in 0..points.len() {
        let first = points[index];
        let second = points[(index + 1) % points.len()];
        let first_x = to_grid_mm(first.x)?;
        let first_y = to_grid_mm(first.y)?;
        let second_x = to_grid_mm(second.x)?;
        let second_y = to_grid_mm(second.y)?;
        doubled_area += BigInt::from(first_x as i64) * BigInt::from(second_y as i64)
            - BigInt::from(second_x as i64) * BigInt::from(first_y as i64);
    }
    let absolute_doubled_area = if doubled_area < BigInt::from(0) {
        -doubled_area
    } else {
        doubled_area
    };
    let area_mm2 = doubled_grid_area_to_mm2(&absolute_doubled_area)?;
    if area_mm2 > 0.0 {
        Some((area_mm2, absolute_doubled_area.to_string()))
    } else {
        None
    }
}

// ===========================================================================
// `originAnchorCandidates` (`:1742-1756`)
// ===========================================================================

/// TS: `originAnchorCandidates` (`intrinsicStrictDecoder.ts:1742-1756`).
pub fn origin_anchor_candidates(
    moving: &TransformedCollisionGeometry,
) -> Vec<IrregularPlacementCandidate> {
    let grid_x = to_grid_mm(-moving.bounds.min_x);
    let grid_y = to_grid_mm(-moving.bounds.min_y);
    match (grid_x, grid_y) {
        (Some(grid_x), Some(grid_y)) => vec![IrregularPlacementCandidate {
            piece_id: moving.source_piece_id.clone(),
            transform: moving.transform,
            point: IrregularPoint::new(from_grid(grid_x), from_grid(grid_y)),
            diagnostics: Vec::new(),
        }],
        _ => Vec::new(),
    }
}

// ===========================================================================
// `transformFamilyKey` / `makePlacement` (`:1758-1781`)
// ===========================================================================

fn transform_family_key(transform: &IrregularTransformCandidate) -> String {
    let remainder = transform.rotation_deg % 360.0;
    let rotation_deg = if remainder < 0.0 {
        remainder + 360.0
    } else {
        remainder
    };
    let rotation_deg = fold_negative_zero(rotation_deg);
    format!(
        "{}:{}",
        number_to_js_string(rotation_deg),
        if transform.mirrored { 1 } else { 0 }
    )
}

fn make_placement(
    piece: &IrregularPreparedPiece,
    candidate: &IrregularPlacementCandidate,
) -> IrregularPlacement {
    IrregularPlacement {
        piece_id: piece.piece_id.clone(),
        source_piece_id: piece.source.id.clone(),
        placement_reference: Some(piece.collision_geometry.placement_reference),
        transform: IrregularTransform {
            translate_x: candidate.point.x,
            translate_y: candidate.point.y,
            rotation_deg: candidate.transform.rotation_deg,
            mirrored: candidate.transform.mirrored,
        },
    }
}

// ===========================================================================
// `measureIntrinsicStrictEnvelopeFromState` (`:1500-1534`)
// ===========================================================================

struct MeasuredEnvelope {
    maximum_side_mm: f64,
    envelope_area_mm2: f64,
    envelope_span_mm: f64,
    exact: IntrinsicStrictLocalScoreExact,
}

fn measure_intrinsic_strict_envelope_from_state(
    state: &IrregularBeamState,
) -> Option<MeasuredEnvelope> {
    let bounds = state.translated_collision_bounds?;
    let width_grid = to_grid_mm(bounds.width)?;
    let height_grid = to_grid_mm(bounds.height)?;
    if width_grid < 0.0 || height_grid < 0.0 {
        return None;
    }
    let width_mm = from_grid(width_grid);
    let height_mm = from_grid(height_grid);
    let maximum_side_mm = js_math::max(width_mm, height_mm);
    let envelope_area_mm2 = width_mm * height_mm;
    let envelope_span_mm = width_mm + height_mm;
    let maximum_side_grid = js_math::max(width_grid, height_grid);
    let envelope_area_grid2 =
        (BigInt::from(width_grid as i64) * BigInt::from(height_grid as i64)).to_string();
    let envelope_span_grid = width_grid + height_grid;
    let all_finite = [
        maximum_side_mm,
        envelope_area_mm2,
        envelope_span_mm,
        maximum_side_grid,
        envelope_span_grid,
    ]
    .iter()
    .all(|value| value.is_finite());
    if all_finite {
        Some(MeasuredEnvelope {
            maximum_side_mm,
            envelope_area_mm2,
            envelope_span_mm,
            exact: IntrinsicStrictLocalScoreExact {
                maximum_side_grid,
                envelope_area_grid2,
                envelope_span_grid,
            },
        })
    } else {
        None
    }
}

/// TS: `measureIntrinsicStrictCanonicalEnvelope` (`intrinsicStrictDecoder.ts:315-328`).
pub fn measure_intrinsic_strict_canonical_envelope(
    placed: &[IrregularPlacedPiece],
) -> Option<(f64, f64, f64)> {
    let envelope = measure_canonical_layout_envelope(placed)?;
    Some((
        envelope.maximum_side_mm,
        envelope.area_mm2,
        envelope.span_mm,
    ))
}

// ===========================================================================
// `scoreCandidate` (`:1394-1498`)
// ===========================================================================

#[allow(clippy::too_many_arguments)]
fn score_candidate(
    state: &Arc<IrregularBeamState>,
    piece: &IrregularPreparedPiece,
    moving: &TransformedCollisionGeometry,
    candidate: &IrregularPlacementCandidate,
    remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>>,
    transform_family: &str,
    moving_collision_area_mm2: f64,
    moving_collision_doubled_area_grid2: &str,
    gap_regions: Option<&[CanonicalIntrinsicGapRegion]>,
    mut phase_timings: Option<&mut CandidateStatePhaseTimings>,
    timing_now: &TimingNowFn,
) -> Option<ScoredCandidate> {
    let has_timings = phase_timings.is_some();
    let started_at = if has_timings { timing_now() } else { 0.0 };

    let result = score_candidate_body(
        state,
        piece,
        moving,
        candidate,
        remaining_prepared_pieces,
        transform_family,
        moving_collision_area_mm2,
        moving_collision_doubled_area_grid2,
        gap_regions,
        reborrow_phase_timings(&mut phase_timings),
        timing_now,
    );

    if let Some(pt) = reborrow_phase_timings(&mut phase_timings) {
        pt.total_ms += timing_now() - started_at;
    }
    result
}

/// Reborrows `*opt` for one statement's lifetime, letting the caller keep
/// using `opt` afterward. `Option::as_deref_mut()` would do the same thing
/// here (the `&mut CandidateStatePhaseTimings` payload's `Deref::Target` is
/// itself `CandidateStatePhaseTimings`), but clippy's
/// `needless_option_as_deref` flags that spelling as a no-op deref even
/// though the reborrow is genuinely needed across the many mutation points
/// inside [`score_candidate_body`] (mirroring `scoreCandidate`'s repeated
/// `if (input.phaseTimings)` checks, `intrinsicStrictDecoder.ts:1416` et al.)
/// -- this equivalent hand-written form avoids the lint without changing
/// behavior.
fn reborrow_phase_timings<'a>(
    opt: &'a mut Option<&mut CandidateStatePhaseTimings>,
) -> Option<&'a mut CandidateStatePhaseTimings> {
    match opt.as_mut() {
        Some(pt) => Some(&mut **pt),
        None => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn score_candidate_body(
    state: &Arc<IrregularBeamState>,
    piece: &IrregularPreparedPiece,
    moving: &TransformedCollisionGeometry,
    candidate: &IrregularPlacementCandidate,
    remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>>,
    transform_family: &str,
    moving_collision_area_mm2: f64,
    moving_collision_doubled_area_grid2: &str,
    gap_regions: Option<&[CanonicalIntrinsicGapRegion]>,
    mut phase_timings: Option<&mut CandidateStatePhaseTimings>,
    timing_now: &TimingNowFn,
) -> Option<ScoredCandidate> {
    let has_timings = phase_timings.is_some();

    let placement_started_at = if has_timings { timing_now() } else { 0.0 };
    let placement = make_placement(piece, candidate);
    let placed = Arc::new(IrregularPlacedPiece {
        placement,
        collision_geometry: moving.clone(),
    });
    if let Some(pt) = reborrow_phase_timings(&mut phase_timings) {
        pt.placement_object_ms += timing_now() - placement_started_at;
    }

    let state_placement_started_at = if has_timings { timing_now() } else { 0.0 };
    let placement_order_piece_id = prepared_piece_id(piece);
    let mut collected_state_placement_timings: Option<IrregularBeamStatePlacementPhaseTimings> =
        None;
    let placed_state = if has_timings {
        let mut cb = |timings: IrregularBeamStatePlacementPhaseTimings| {
            collected_state_placement_timings = Some(timings);
        };
        Arc::clone(state).with_placement(WithPlacementInput {
            remaining_prepared_pieces,
            placed_collision_geometry: placed,
            placement_order_piece_id,
            on_phase_timings: Some(&mut cb),
            timing_now: Some(timing_now),
        })
    } else {
        Arc::clone(state).with_placement(WithPlacementInput {
            remaining_prepared_pieces,
            placed_collision_geometry: placed,
            placement_order_piece_id,
            on_phase_timings: None,
            timing_now: None,
        })
    };
    if let (Some(pt), Some(timings)) = (
        reborrow_phase_timings(&mut phase_timings),
        collected_state_placement_timings,
    ) {
        pt.state_placement_canonical_entry_key_ms += timings.canonical_entry_key_ms;
        pt.state_placement_spatial_index_ms += timings.spatial_index_ms;
        pt.state_placement_contact_measurement_ms += timings.contact_measurement_ms;
        pt.state_placement_state_assembly_ms += timings.state_assembly_ms;
        pt.state_placement_bookkeeping_ms += timings.bookkeeping_ms;
    }
    if let Some(pt) = reborrow_phase_timings(&mut phase_timings) {
        pt.state_placement_ms += timing_now() - state_placement_started_at;
    }

    let anchoring_started_at = if has_timings { timing_now() } else { 0.0 };
    let canonical_combined_geometry_key =
        placed_state.bottom_left_anchored_canonical_occupied_geometry_key();
    if let Some(pt) = reborrow_phase_timings(&mut phase_timings) {
        pt.bottom_left_anchoring_ms += timing_now() - anchoring_started_at;
    }
    let canonical_combined_geometry_key = canonical_combined_geometry_key?;

    let envelope_started_at = if has_timings { timing_now() } else { 0.0 };
    let envelope = measure_intrinsic_strict_envelope_from_state(&placed_state);
    if let Some(pt) = reborrow_phase_timings(&mut phase_timings) {
        pt.envelope_scoring_ms += timing_now() - envelope_started_at;
    }
    let envelope = envelope?;

    let shared_boundary_length_mm = placed_state.shared_collision_boundary_length_mm?;
    if ![
        envelope.maximum_side_mm,
        envelope.envelope_area_mm2,
        envelope.envelope_span_mm,
        shared_boundary_length_mm,
    ]
    .iter()
    .all(|value| value.is_finite())
    {
        return None;
    }

    let gap_started_at = if has_timings { timing_now() } else { 0.0 };
    let containing_gap = gap_regions.and_then(|regions| {
        let mut contained: Vec<&CanonicalIntrinsicGapRegion> = regions
            .iter()
            .filter(|region| candidate_contained_in_intrinsic_gap(moving, candidate.point, region))
            .collect();
        contained.sort_by(|first, second| {
            asc_cmp(first.area_mm2, second.area_mm2)
                .then_with(|| locale_compare_keys(&first.canonical_key, &second.canonical_key))
        });
        contained.first().map(|region| (*region).clone())
    });
    if let Some(pt) = reborrow_phase_timings(&mut phase_timings) {
        pt.gap_classification_ms += timing_now() - gap_started_at;
    }

    Some(ScoredCandidate {
        state: placed_state,
        transform_family: transform_family.to_string(),
        candidate: candidate.clone(),
        moving_collision_area_mm2,
        moving_collision_doubled_area_grid2: moving_collision_doubled_area_grid2.to_string(),
        containing_gap,
        score: IntrinsicStrictLocalScore {
            maximum_side_mm: envelope.maximum_side_mm,
            envelope_area_mm2: envelope.envelope_area_mm2,
            envelope_span_mm: envelope.envelope_span_mm,
            shared_boundary_length_mm,
            canonical_combined_geometry_key,
            exact: Some(envelope.exact),
        },
    })
}

// ===========================================================================
// Comparators (`:1548-1699`)
// ===========================================================================

#[derive(Clone, Copy)]
enum ExactEnvelopeMode {
    MaximumSideFirst,
    AreaFirst,
}

fn compare_exact_local_envelopes(
    first: &IntrinsicStrictLocalScore,
    second: &IntrinsicStrictLocalScore,
    mode: ExactEnvelopeMode,
) -> Option<Ordering> {
    let (fe, se) = match (&first.exact, &second.exact) {
        (Some(a), Some(b)) => (a, b),
        _ => return None,
    };
    let side_cmp = asc_cmp(fe.maximum_side_grid, se.maximum_side_grid);
    let area_cmp = compare_bigint_decimal_strings(&fe.envelope_area_grid2, &se.envelope_area_grid2);
    let span_cmp = asc_cmp(fe.envelope_span_grid, se.envelope_span_grid);
    Some(match mode {
        ExactEnvelopeMode::MaximumSideFirst => side_cmp.then(area_cmp).then(span_cmp),
        ExactEnvelopeMode::AreaFirst => area_cmp.then(side_cmp).then(span_cmp),
    })
}

/// TS: `compareLocalScores` (`intrinsicStrictDecoder.ts:1653-1670`).
fn compare_local_scores(
    first: &IntrinsicStrictLocalScore,
    second: &IntrinsicStrictLocalScore,
) -> Ordering {
    let primary = compare_exact_local_envelopes(first, second, ExactEnvelopeMode::MaximumSideFirst)
        .unwrap_or_else(|| {
            asc_cmp(
                canonical_linear_metric(first.maximum_side_mm),
                canonical_linear_metric(second.maximum_side_mm),
            )
            .then_with(|| {
                asc_cmp(
                    canonical_area_metric(first.envelope_area_mm2),
                    canonical_area_metric(second.envelope_area_mm2),
                )
            })
            .then_with(|| {
                asc_cmp(
                    canonical_linear_metric(first.envelope_span_mm),
                    canonical_linear_metric(second.envelope_span_mm),
                )
            })
        });
    primary
        .then_with(|| {
            desc_cmp(
                first.shared_boundary_length_mm,
                second.shared_boundary_length_mm,
            )
        })
        .then_with(|| {
            locale_compare_keys(
                &first.canonical_combined_geometry_key,
                &second.canonical_combined_geometry_key,
            )
        })
}

/// TS: `compareLegacyAbsoluteEnvelopeCandidates` (`:1612-1632`).
fn compare_legacy_absolute_envelope_candidates(
    first: &IntrinsicStrictFamilyWinner,
    second: &IntrinsicStrictFamilyWinner,
) -> Ordering {
    let exact =
        compare_exact_local_envelopes(&first.score, &second.score, ExactEnvelopeMode::AreaFirst);
    let primary = match exact {
        Some(ordering) if ordering != Ordering::Equal => ordering,
        _ => exact.unwrap_or_else(|| {
            asc_cmp(
                canonical_area_metric(first.score.envelope_area_mm2),
                canonical_area_metric(second.score.envelope_area_mm2),
            )
            .then_with(|| {
                asc_cmp(
                    canonical_linear_metric(first.score.maximum_side_mm),
                    canonical_linear_metric(second.score.maximum_side_mm),
                )
            })
            .then_with(|| {
                asc_cmp(
                    canonical_linear_metric(first.score.envelope_span_mm),
                    canonical_linear_metric(second.score.envelope_span_mm),
                )
            })
        }),
    };
    primary
        .then_with(|| {
            desc_cmp(
                first.score.shared_boundary_length_mm,
                second.score.shared_boundary_length_mm,
            )
        })
        .then_with(|| {
            locale_compare_keys(
                &first.score.canonical_combined_geometry_key,
                &second.score.canonical_combined_geometry_key,
            )
        })
}

/// TS: `compareContactBandCandidates` (`:1634-1651`).
fn compare_contact_band_candidates(
    first: &IntrinsicStrictFamilyWinner,
    second: &IntrinsicStrictFamilyWinner,
) -> Ordering {
    let exact =
        compare_exact_local_envelopes(&first.score, &second.score, ExactEnvelopeMode::AreaFirst);
    desc_cmp(
        first.score.shared_boundary_length_mm,
        second.score.shared_boundary_length_mm,
    )
    .then_with(|| {
        exact.unwrap_or_else(|| {
            asc_cmp(
                canonical_area_metric(first.score.envelope_area_mm2),
                canonical_area_metric(second.score.envelope_area_mm2),
            )
            .then_with(|| {
                asc_cmp(
                    canonical_linear_metric(first.score.envelope_span_mm),
                    canonical_linear_metric(second.score.envelope_span_mm),
                )
            })
        })
    })
    .then_with(|| {
        locale_compare_keys(
            &first.score.canonical_combined_geometry_key,
            &second.score.canonical_combined_geometry_key,
        )
    })
}

/// TS: `compareGapContainedCandidates` (`:1548-1560`).
fn compare_gap_contained_candidates(first: &ScoredCandidate, second: &ScoredCandidate) -> Ordering {
    let first_gap = first
        .containing_gap
        .as_ref()
        .expect("caller filters to gap-contained candidates");
    let second_gap = second
        .containing_gap
        .as_ref()
        .expect("caller filters to gap-contained candidates");
    compare_bigint_decimal_strings(
        &first_gap.doubled_area_grid2,
        &second_gap.doubled_area_grid2,
    )
    .then_with(|| {
        desc_cmp(
            first.score.shared_boundary_length_mm,
            second.score.shared_boundary_length_mm,
        )
    })
    .then_with(|| compare_local_scores(&first.score, &second.score))
}

/// TS: `selectIntrinsicStrictFamilyWinner` (`intrinsicStrictDecoder.ts:1563-1609`).
///
/// Specialized to `&[ScoredCandidate]` rather than TS's generic `<T extends
/// IntrinsicStrictFamilyWinner>`: per `strict-decoder-gap-family.md` §2.1,
/// the only reachable external caller of the generic export
/// (`intrinsicQueueBeamDiscriminator.ts:3142`) is itself dead in production
/// and outside this cluster's file scope; both call sites inside this file
/// (`familyWinners: ScoredCandidate[]` and the combined
/// gap-contained-plus-family-winner list) pass `ScoredCandidate`-shaped data.
fn select_intrinsic_strict_family_winner(
    candidates: &[ScoredCandidate],
    comparator_mode: IntrinsicStrictComparatorMode,
) -> Option<&ScoredCandidate> {
    if comparator_mode == IntrinsicStrictComparatorMode::LegacyAbsoluteEnvelope {
        return candidates.iter().min_by(|a, b| {
            compare_legacy_absolute_envelope_candidates(
                &a.as_family_winner(),
                &b.as_family_winner(),
            )
        });
    }

    let mut pure_leader: Option<&ScoredCandidate> = None;
    for candidate in candidates {
        pure_leader = match pure_leader {
            None => Some(candidate),
            Some(best) if compare_local_scores(&candidate.score, &best.score) == Ordering::Less => {
                Some(candidate)
            }
            Some(best) => Some(best),
        };
    }
    let pure_leader = pure_leader?;
    if comparator_mode == IntrinsicStrictComparatorMode::PureGrowth {
        return Some(pure_leader);
    }

    let leader_exact = pure_leader.score.exact.as_ref();
    let within_band: Vec<&ScoredCandidate> = candidates
        .iter()
        .filter(|candidate| {
            let candidate_exact = candidate.score.exact.as_ref();
            match (candidate_exact, leader_exact) {
                (Some(candidate_exact), Some(leader_exact)) => {
                    let moving_doubled_area =
                        parse_bigint(&candidate.moving_collision_doubled_area_grid2);
                    candidate_exact.maximum_side_grid == leader_exact.maximum_side_grid
                        && BigInt::from(100) * parse_bigint(&candidate_exact.envelope_area_grid2)
                            <= BigInt::from(100) * parse_bigint(&leader_exact.envelope_area_grid2)
                                + moving_doubled_area
                }
                _ => {
                    canonical_linear_metric(candidate.score.maximum_side_mm)
                        == canonical_linear_metric(pure_leader.score.maximum_side_mm)
                        && canonical_area_metric(candidate.score.envelope_area_mm2)
                            <= canonical_area_metric(
                                pure_leader.score.envelope_area_mm2
                                    + 0.02 * candidate.moving_collision_area_mm2,
                            )
                }
            }
        })
        .collect();

    within_band.into_iter().min_by(|a, b| {
        compare_contact_band_candidates(&a.as_family_winner(), &b.as_family_winner())
    })
}

/// TS: `selectGapContainedWinner` (`:1536-1546`).
fn select_gap_contained_winner(candidates: &[ScoredCandidate]) -> Option<&ScoredCandidate> {
    let contained: Vec<&ScoredCandidate> = candidates
        .iter()
        .filter(|candidate| candidate.containing_gap.is_some())
        .collect();
    let best_contained = contained
        .into_iter()
        .min_by(|a, b| compare_gap_contained_candidates(a, b));
    match best_contained {
        Some(winner) => Some(winner),
        None => select_intrinsic_strict_family_winner(
            candidates,
            IntrinsicStrictComparatorMode::PureGrowth,
        ),
    }
}

// ===========================================================================
// `validateSeedPartition` (`:1365-1384`)
// ===========================================================================

fn unique_count(ids: &[PieceId]) -> usize {
    let set: std::collections::HashSet<&PieceId> = ids.iter().collect();
    set.len()
}

fn sorted_ordinal(ids: &[PieceId]) -> Vec<PieceId> {
    let mut sorted = ids.to_vec();
    sorted.sort_by(|a, b| cmp_js_code_units(a.as_str(), b.as_str()));
    sorted
}

fn validate_seed_partition(input: &ConstructIntrinsicStrictStateInput<'_>) -> Option<String> {
    let all_ids: Vec<PieceId> = input
        .all_prepared_pieces
        .iter()
        .map(|p| prepared_piece_id(p))
        .collect();
    let remaining_ids: Vec<PieceId> = input
        .remaining_prepared_pieces
        .iter()
        .map(|p| prepared_piece_id(p))
        .collect();
    let frozen_ids: Vec<PieceId> = input
        .frozen_placed
        .iter()
        .map(|p| placed_piece_id(p))
        .collect();
    if unique_count(&all_ids) != all_ids.len() {
        return Some("all prepared piece ids must be unique.".to_string());
    }
    if unique_count(&remaining_ids) != remaining_ids.len() {
        return Some("remaining piece ids must be unique.".to_string());
    }
    if unique_count(&frozen_ids) != frozen_ids.len() {
        return Some("frozen placement ids must be unique.".to_string());
    }
    let mut partition_ids = remaining_ids;
    partition_ids.extend(frozen_ids);
    if unique_count(&partition_ids) != partition_ids.len() {
        return Some("frozen and remaining piece ids must be disjoint.".to_string());
    }
    if partition_ids.len() != all_ids.len()
        || sorted_ordinal(&partition_ids) != sorted_ordinal(&all_ids)
    {
        return Some(
            "frozen and remaining piece ids must exactly partition all prepared pieces."
                .to_string(),
        );
    }
    None
}

fn same_piece_ids(first: &[PieceId], second: &[PieceId]) -> bool {
    first.len() == second.len() && first.iter().zip(second.iter()).all(|(a, b)| a == b)
}

fn same_piece_id_set(first: &[PieceId], second: &[PieceId]) -> bool {
    sorted_ordinal(first) == sorted_ordinal(second)
}

// ===========================================================================
// Checkpoint hash-preimage builders (`:1021-1277`, checkpoint-encoding.md §8)
// ===========================================================================

fn serde_js_value<T: Serialize>(value: &T) -> JsValue {
    let json = serde_json::to_value(value).expect("hash-preimage payload always serializes");
    serde_json_to_js_value(&json)
}

fn serde_json_to_js_value(value: &serde_json::Value) -> JsValue {
    match value {
        serde_json::Value::Null => JsValue::Null,
        serde_json::Value::Bool(b) => JsValue::Bool(*b),
        serde_json::Value::Number(n) => JsValue::Num(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(s) => JsValue::Str(s.clone()),
        serde_json::Value::Array(items) => {
            JsValue::Arr(items.iter().map(serde_json_to_js_value).collect())
        }
        serde_json::Value::Object(fields) => JsValue::Obj(
            fields
                .iter()
                .map(|(k, v)| (k.clone(), serde_json_to_js_value(v)))
                .collect(),
        ),
    }
}

fn optional_num_js_value(value: Option<f64>) -> JsValue {
    value.map(JsValue::Num).unwrap_or(JsValue::Undefined)
}

fn translated_collision_bounds_js_value(bounds: Option<IrregularCollisionBounds>) -> JsValue {
    match bounds {
        None => JsValue::Undefined,
        Some(b) => JsValue::Obj(vec![
            ("minX".to_string(), JsValue::Num(b.min_x)),
            ("minY".to_string(), JsValue::Num(b.min_y)),
            ("maxX".to_string(), JsValue::Num(b.max_x)),
            ("maxY".to_string(), JsValue::Num(b.max_y)),
            ("width".to_string(), JsValue::Num(b.width)),
            ("height".to_string(), JsValue::Num(b.height)),
        ]),
    }
}

fn cloned_placed(placed: &[Arc<IrregularPlacedPiece>]) -> Vec<IrregularPlacedPiece> {
    placed.iter().map(|p| (**p).clone()).collect()
}

/// TS: `intrinsicStrictDirectRequestFingerprint` (`:1021-1056`).
#[allow(clippy::too_many_arguments)]
fn intrinsic_strict_direct_request_fingerprint(
    all_prepared_pieces: &[Arc<IrregularPreparedPiece>],
    remaining_prepared_pieces: &[Arc<IrregularPreparedPiece>],
    frozen_placed: &[Arc<IrregularPlacedPiece>],
    candidate_mode: IntrinsicStrictCandidateMode,
    settings: &IrregularNestingSettings,
    producer_role: &str,
    maximum_runtime_ms: f64,
    maximum_candidate_evaluation_count: Option<f64>,
    capture_phase_timings: bool,
) -> String {
    let candidate_mode_js = match candidate_mode {
        IntrinsicStrictCandidateMode::Comparator(IntrinsicStrictComparatorMode::PureGrowth) => {
            JsValue::Str("pure-growth".to_string())
        }
        IntrinsicStrictCandidateMode::Comparator(
            IntrinsicStrictComparatorMode::LegacyAbsoluteEnvelope,
        ) => JsValue::Str("legacy-absolute-envelope".to_string()),
        IntrinsicStrictCandidateMode::Comparator(IntrinsicStrictComparatorMode::ContactBand) => {
            JsValue::Str("contact-band".to_string())
        }
        IntrinsicStrictCandidateMode::GapContained => JsValue::Obj(vec![(
            "kind".to_string(),
            JsValue::Str("gap-contained".to_string()),
        )]),
    };
    let all_prepared_pieces_js = JsValue::Arr(
        all_prepared_pieces
            .iter()
            .map(|piece| {
                JsValue::Obj(vec![
                    (
                        "pieceId".to_string(),
                        JsValue::Str(prepared_piece_id(piece).as_str().to_string()),
                    ),
                    (
                        "collisionGeometry".to_string(),
                        serde_js_value(&piece.collision_geometry),
                    ),
                    ("transforms".to_string(), serde_js_value(&piece.transforms)),
                ])
            })
            .collect(),
    );
    let remaining_prepared_ids_js = JsValue::Arr(
        remaining_prepared_pieces
            .iter()
            .map(|piece| JsValue::Str(prepared_piece_id(piece).as_str().to_string()))
            .collect(),
    );
    let frozen_placement_order_js = JsValue::Arr(
        frozen_placed
            .iter()
            .map(|piece| JsValue::Str(placed_piece_id(piece).as_str().to_string()))
            .collect(),
    );
    let frozen_geometry_identity =
        canonical_collision_layout_identity(&cloned_placed(frozen_placed)).unwrap_or_default();

    let value = JsValue::Obj(vec![
        (
            "version".to_string(),
            JsValue::Str(INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION.to_string()),
        ),
        (
            "producerRole".to_string(),
            JsValue::Str(producer_role.to_string()),
        ),
        ("candidateMode".to_string(), candidate_mode_js),
        ("settings".to_string(), serde_js_value(settings)),
        (
            "settlement".to_string(),
            JsValue::Obj(vec![
                (
                    "maximumRuntimeMs".to_string(),
                    JsValue::Num(maximum_runtime_ms),
                ),
                (
                    "maximumCandidateEvaluationCount".to_string(),
                    optional_num_js_value(maximum_candidate_evaluation_count),
                ),
                (
                    "capturePhaseTimings".to_string(),
                    JsValue::Bool(capture_phase_timings),
                ),
            ]),
        ),
        ("allPreparedPieces".to_string(), all_prepared_pieces_js),
        (
            "remainingPreparedIds".to_string(),
            remaining_prepared_ids_js,
        ),
        (
            "frozenPlacementOrder".to_string(),
            frozen_placement_order_js,
        ),
        (
            "frozenGeometryIdentity".to_string(),
            JsValue::Str(frozen_geometry_identity),
        ),
    ]);
    let encoded = intrinsic_strict_canonical_json(&value).expect("top-level object always encodes");
    sha256_hex(&encoded)
}

/// TS: `collectIntrinsicStrictDirectStateLineage` (`:1080-1111`).
fn collect_intrinsic_strict_direct_state_lineage(
    state: &Arc<IrregularBeamState>,
    expected_state_count: usize,
) -> Option<Vec<JsValue>> {
    let mut lineage: Vec<JsValue> = Vec::new();
    let mut visited: Vec<*const IrregularBeamState> = Vec::new();
    let mut cursor: Option<Arc<IrregularBeamState>> = Some(Arc::clone(state));
    while let Some(current) = cursor {
        let ptr = Arc::as_ptr(&current);
        if visited.contains(&ptr) || lineage.len() >= expected_state_count {
            return None;
        }
        visited.push(ptr);
        let placed_clone = cloned_placed(&current.placed_collision_geometries);
        let entry = JsValue::Obj(vec![
            (
                "pendingIds".to_string(),
                JsValue::Arr(
                    current
                        .remaining_prepared_pieces
                        .iter()
                        .map(|p| JsValue::Str(prepared_piece_id(p).as_str().to_string()))
                        .collect(),
                ),
            ),
            (
                "placedIds".to_string(),
                JsValue::Arr(
                    current
                        .placed_collision_geometries
                        .iter()
                        .map(|p| JsValue::Str(placed_piece_id(p).as_str().to_string()))
                        .collect(),
                ),
            ),
            (
                "unplacedIds".to_string(),
                JsValue::Arr(
                    current
                        .unplaced_piece_ids
                        .iter()
                        .map(|id| JsValue::Str(id.as_str().to_string()))
                        .collect(),
                ),
            ),
            (
                "placementOrder".to_string(),
                JsValue::Arr(
                    current
                        .placement_order
                        .iter()
                        .map(|id| JsValue::Str(id.as_str().to_string()))
                        .collect(),
                ),
            ),
            (
                "canonicalGeometryIdentity".to_string(),
                JsValue::Str(
                    canonical_collision_layout_identity(&placed_clone).unwrap_or_default(),
                ),
            ),
            (
                "canonicalOccupiedGeometryKey".to_string(),
                JsValue::Str(current.canonical_occupied_geometry_key.clone()),
            ),
            (
                "translatedCollisionBounds".to_string(),
                translated_collision_bounds_js_value(current.translated_collision_bounds),
            ),
            (
                "sharedCollisionBoundaryLengthMm".to_string(),
                optional_num_js_value(current.shared_collision_boundary_length_mm),
            ),
            (
                "sharedCollisionBoundaryContactUnits".to_string(),
                optional_num_js_value(current.shared_collision_boundary_contact_units),
            ),
            (
                "nearCompleteStructuralContactCount".to_string(),
                optional_num_js_value(current.near_complete_structural_contact_count),
            ),
            (
                "dominantNearCompleteStructuralContactCount".to_string(),
                optional_num_js_value(current.dominant_near_complete_structural_contact_count),
            ),
            (
                "continuationMetadataIdentity".to_string(),
                JsValue::Str(current.continuation_metadata_identity()),
            ),
        ]);
        lineage.push(entry);
        cursor = current.parent.clone();
    }
    if lineage.len() == expected_state_count {
        Some(lineage)
    } else {
        None
    }
}

/// TS: `intrinsicStrictDirectCheckpointIntegrityHash` (`:1058-1078`).
#[allow(clippy::too_many_arguments)]
fn intrinsic_strict_direct_checkpoint_integrity_hash(
    version: &str,
    producer_role: &str,
    request_fingerprint: &str,
    state_lineage: Vec<JsValue>,
    next_piece_index: f64,
    step_trace: &[IntrinsicStrictStepTrace],
    gap_fill_evidence: &[IntrinsicStrictGapFillEvidence],
    candidate_evaluation_count: f64,
    active_runtime_ms: f64,
    phase_ledger: &Option<IntrinsicStrictDirectPhaseLedger>,
) -> String {
    let value = JsValue::Obj(vec![
        ("version".to_string(), JsValue::Str(version.to_string())),
        (
            "producerRole".to_string(),
            JsValue::Str(producer_role.to_string()),
        ),
        (
            "requestFingerprint".to_string(),
            JsValue::Str(request_fingerprint.to_string()),
        ),
        ("stateLineage".to_string(), JsValue::Arr(state_lineage)),
        ("nextPieceIndex".to_string(), JsValue::Num(next_piece_index)),
        (
            "stepTrace".to_string(),
            serde_js_value(&step_trace.to_vec()),
        ),
        (
            "gapFillEvidence".to_string(),
            serde_js_value(&gap_fill_evidence.to_vec()),
        ),
        (
            "candidateEvaluationCount".to_string(),
            JsValue::Num(candidate_evaluation_count),
        ),
        (
            "activeRuntimeMs".to_string(),
            JsValue::Num(active_runtime_ms),
        ),
        (
            "phaseLedger".to_string(),
            phase_ledger
                .as_ref()
                .map(serde_js_value)
                .unwrap_or(JsValue::Undefined),
        ),
    ]);
    let encoded = intrinsic_strict_canonical_json(&value).expect("top-level object always encodes");
    sha256_hex(&encoded)
}

/// TS: `makeIntrinsicStrictDirectCheckpoint` (`:868-905`).
///
/// # Panics
///
/// Panics if the about-to-be-checkpointed state's own lineage cannot be
/// collected. TS's counterpart is a genuine synchronous `throw` inside an
/// `Effect.gen` body (characterization §11.1): "the one place in this
/// cluster where a genuine invariant violation is signaled by a different
/// mechanism (throw/defect) than the rest of the file's typed-error
/// convention" -- Effect captures it as an unrecoverable defect, not a typed
/// recoverable error. A panic here is the exact Rust equivalent, matching
/// that doc's explicit guidance: "it should behave like a panic-equivalent
/// contained at the job boundary... not like a normal `Result::Err`."
#[allow(clippy::too_many_arguments)]
fn make_intrinsic_strict_direct_checkpoint(
    producer_role: &str,
    request_fingerprint: &str,
    state: Arc<IrregularBeamState>,
    next_piece_index: f64,
    step_trace: Vec<IntrinsicStrictStepTrace>,
    gap_fill_evidence: Vec<IntrinsicStrictGapFillEvidence>,
    candidate_evaluation_count: f64,
    active_runtime_ms: f64,
    phase_ledger: Option<IntrinsicStrictDirectPhaseLedger>,
) -> IntrinsicStrictDirectCheckpoint {
    let state_lineage =
        collect_intrinsic_strict_direct_state_lineage(&state, (next_piece_index as usize) + 1)
            .unwrap_or_else(|| panic!("committed direct checkpoint lineage is invalid."));
    let integrity_hash = intrinsic_strict_direct_checkpoint_integrity_hash(
        INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION,
        producer_role,
        request_fingerprint,
        state_lineage,
        next_piece_index,
        &step_trace,
        &gap_fill_evidence,
        candidate_evaluation_count,
        active_runtime_ms,
        &phase_ledger,
    );
    IntrinsicStrictDirectCheckpoint {
        version: INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION.to_string(),
        producer_role: producer_role.to_string(),
        request_fingerprint: request_fingerprint.to_string(),
        integrity_hash,
        state,
        next_piece_index,
        step_trace,
        gap_fill_evidence,
        candidate_evaluation_count,
        active_runtime_ms,
        phase_ledger,
    }
}

/// TS: `validateIntrinsicStrictDirectState` (`:1183-1223`).
fn validate_intrinsic_strict_direct_state(state: &Arc<IrregularBeamState>) -> Option<String> {
    let placed_ids: Vec<PieceId> = state
        .placed_collision_geometries
        .iter()
        .map(|p| placed_piece_id(p))
        .collect();
    if !same_piece_ids(&placed_ids, &state.placement_order) {
        return Some(
            "direct checkpoint placed geometry IDs do not match placement order.".to_string(),
        );
    }
    if !state.placed_collision_geometries.is_empty() {
        let sheet = intrinsic_bounds_sheet(state);
        let placed = cloned_placed(&state.placed_collision_geometries);
        if !assert_canonical_grid_legal_layout(&sheet, &placed) {
            return Some("direct checkpoint lineage contains a non-canonical layout.".to_string());
        }
    }
    let recomputed = IrregularBeamState::from_input(IrregularBeamStateInput {
        remaining_prepared_pieces: state.remaining_prepared_pieces.clone(),
        placed_collision_geometries: state.placed_collision_geometries.clone(),
        unplaced_piece_ids: Some(state.unplaced_piece_ids.clone()),
        unplaced_source_piece_ids: None,
        placement_order: state.placement_order.clone(),
        parent: state.parent.clone(),
        placed_collision_index: None,
    });
    if recomputed.canonical_occupied_geometry_key != state.canonical_occupied_geometry_key {
        return Some("direct checkpoint canonical occupied identity is inconsistent.".to_string());
    }
    if recomputed.canonical_entry_continuation_identity()
        != state.canonical_entry_continuation_identity()
    {
        return Some("direct checkpoint canonical-entry cache is inconsistent.".to_string());
    }
    if recomputed.placed_collision_index.continuation_identity()
        != state.placed_collision_index.continuation_identity()
    {
        return Some("direct checkpoint spatial-index cache is inconsistent.".to_string());
    }
    if !state
        .placed_collision_index
        .matches(&state.placed_collision_geometries)
    {
        return Some(
            "direct checkpoint spatial index does not own the placed geometry.".to_string(),
        );
    }
    None
}

/// TS: `validateIntrinsicStrictDirectCheckpointLineage` (`:1113-1181`).
fn validate_intrinsic_strict_direct_checkpoint_lineage(
    checkpoint: &IntrinsicStrictDirectCheckpoint,
    remaining_prepared_pieces: &[Arc<IrregularPreparedPiece>],
    frozen_placed: &[Arc<IrregularPlacedPiece>],
) -> Option<String> {
    let prepared_ids: Vec<PieceId> = remaining_prepared_pieces
        .iter()
        .map(|p| prepared_piece_id(p))
        .collect();
    let frozen_ids: Vec<PieceId> = frozen_placed.iter().map(|p| placed_piece_id(p)).collect();
    let mut state: Option<Arc<IrregularBeamState>> = Some(Arc::clone(&checkpoint.state));

    let mut depth = checkpoint.next_piece_index as i64;
    while depth > 0 {
        let current = state?;
        if let Some(error) = validate_intrinsic_strict_direct_state(&current) {
            return Some(error);
        }
        let pending: Vec<PieceId> = current
            .remaining_prepared_pieces
            .iter()
            .map(|p| prepared_piece_id(p))
            .collect();
        if pending != prepared_ids[(depth as usize)..] {
            return Some(
                "direct checkpoint lineage pending order does not match its depth.".to_string(),
            );
        }
        let mut expected_consumed_ids = frozen_ids.clone();
        expected_consumed_ids.extend(prepared_ids[..(depth as usize)].iter().cloned());
        let mut accounted_ids: Vec<PieceId> = current
            .placed_collision_geometries
            .iter()
            .map(|p| placed_piece_id(p))
            .collect();
        accounted_ids.extend(current.unplaced_piece_ids.iter().cloned());
        if !same_piece_id_set(&accounted_ids, &expected_consumed_ids) {
            return Some(
                "direct checkpoint state does not exactly account for the consumed prefix."
                    .to_string(),
            );
        }
        let parent = match &current.parent {
            Some(parent) => Arc::clone(parent),
            None => {
                return Some(
                    "direct checkpoint parent lineage ends before the consumed prefix.".to_string(),
                )
            }
        };
        let piece_id = &prepared_ids[(depth as usize) - 1];
        let placed_delta =
            current.placement_order.len() as i64 - parent.placement_order.len() as i64;
        let unplaced_delta =
            current.unplaced_piece_ids.len() as i64 - parent.unplaced_piece_ids.len() as i64;
        let placed_transition = placed_delta == 1
            && unplaced_delta == 0
            && current.placement_order.last() == Some(piece_id);
        let unplaced_transition = placed_delta == 0
            && unplaced_delta == 1
            && current.unplaced_piece_ids.last() == Some(piece_id);
        if !placed_transition && !unplaced_transition {
            return Some(
                "direct checkpoint parent lineage has an invalid consumed-piece transition."
                    .to_string(),
            );
        }
        state = Some(parent);
        depth -= 1;
    }

    let state = match state {
        Some(state) => state,
        None => {
            return Some("direct checkpoint parent lineage has no frozen-seed root.".to_string())
        }
    };
    if let Some(error) = validate_intrinsic_strict_direct_state(&state) {
        return Some(error);
    }
    let anchored_frozen = IrregularBeamState::from_input(IrregularBeamStateInput {
        remaining_prepared_pieces: remaining_prepared_pieces.to_vec(),
        placed_collision_geometries: frozen_placed.to_vec(),
        unplaced_piece_ids: None,
        unplaced_source_piece_ids: None,
        placement_order: frozen_ids.clone(),
        parent: None,
        placed_collision_index: None,
    })
    .with_bottom_left_anchored();
    let state_pending: Vec<PieceId> = state
        .remaining_prepared_pieces
        .iter()
        .map(|p| prepared_piece_id(p))
        .collect();
    let valid_root = match anchored_frozen {
        Some(anchored_frozen) => {
            state.parent.is_none()
                && state.unplaced_piece_ids.is_empty()
                && same_piece_ids(&state_pending, &prepared_ids)
                && same_piece_ids(&state.placement_order, &frozen_ids)
                && state.canonical_occupied_geometry_key
                    == anchored_frozen.canonical_occupied_geometry_key
        }
        None => false,
    };
    if !valid_root {
        return Some(
            "direct checkpoint parent lineage does not terminate at the frozen seed.".to_string(),
        );
    }
    None
}

/// TS: `validateIntrinsicStrictDirectCheckpoint` (`:907-1019`).
struct ValidateCheckpointInput<'a> {
    checkpoint: &'a Option<IntrinsicStrictDirectCheckpoint>,
    request_fingerprint: Option<&'a str>,
    producer_role: &'a str,
    remaining_prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    frozen_placed: &'a [Arc<IrregularPlacedPiece>],
    capture_phase_timings: bool,
}

fn validate_intrinsic_strict_direct_checkpoint(
    input: ValidateCheckpointInput<'_>,
) -> Option<String> {
    let checkpoint = input.checkpoint.as_ref()?;
    let request_fingerprint = input.request_fingerprint?;
    if checkpoint.version != INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION {
        return Some(format!(
            "unsupported direct checkpoint version {}.",
            checkpoint.version
        ));
    }
    if checkpoint.producer_role != input.producer_role
        || checkpoint.request_fingerprint != request_fingerprint
    {
        return Some(
            "direct checkpoint producer or request fingerprint does not match.".to_string(),
        );
    }
    let next_piece_index = checkpoint.next_piece_index;
    if !crate::js_number::is_safe_integer(next_piece_index)
        || next_piece_index <= 0.0
        || next_piece_index >= input.remaining_prepared_pieces.len() as f64
        || checkpoint.step_trace.len() as f64 != next_piece_index
        || checkpoint.state.remaining_prepared_pieces.len() as f64
            != input.remaining_prepared_pieces.len() as f64 - next_piece_index
    {
        return Some(
            "direct checkpoint is not positioned at a valid committed piece boundary.".to_string(),
        );
    }
    let state_lineage = collect_intrinsic_strict_direct_state_lineage(
        &checkpoint.state,
        (next_piece_index as usize) + 1,
    );
    let state_lineage = match state_lineage {
        Some(lineage) => lineage,
        None => {
            return Some(
                "direct checkpoint parent lineage is cyclic or has an invalid length.".to_string(),
            )
        }
    };
    let expected_integrity_hash = intrinsic_strict_direct_checkpoint_integrity_hash(
        &checkpoint.version,
        &checkpoint.producer_role,
        &checkpoint.request_fingerprint,
        state_lineage,
        checkpoint.next_piece_index,
        &checkpoint.step_trace,
        &checkpoint.gap_fill_evidence,
        checkpoint.candidate_evaluation_count,
        checkpoint.active_runtime_ms,
        &checkpoint.phase_ledger,
    );
    if checkpoint.integrity_hash != expected_integrity_hash {
        return Some(
            "direct checkpoint integrity hash does not match its retained state.".to_string(),
        );
    }
    let expected_pending_ids: Vec<PieceId> = input
        .remaining_prepared_pieces
        .iter()
        .skip(next_piece_index as usize)
        .map(|p| prepared_piece_id(p))
        .collect();
    let checkpoint_pending_ids: Vec<PieceId> = checkpoint
        .state
        .remaining_prepared_pieces
        .iter()
        .map(|p| prepared_piece_id(p))
        .collect();
    if expected_pending_ids != checkpoint_pending_ids {
        return Some(
            "direct checkpoint pending suffix does not match the prepared order.".to_string(),
        );
    }
    if let Some(error) = validate_intrinsic_strict_direct_checkpoint_lineage(
        checkpoint,
        input.remaining_prepared_pieces,
        input.frozen_placed,
    ) {
        return Some(error);
    }
    let trace_mismatch = checkpoint
        .step_trace
        .iter()
        .enumerate()
        .any(|(index, trace)| {
            let prepared_piece = input.remaining_prepared_pieces.get(index);
            match prepared_piece {
                None => true,
                Some(prepared_piece) => {
                    trace.piece_id != prepared_piece_id(prepared_piece)
                        || !crate::js_number::is_safe_integer(trace.candidate_count)
                        || trace.candidate_count < 0.0
                }
            }
        });
    if trace_mismatch {
        return Some(
            "direct checkpoint trace does not match the consumed prepared prefix.".to_string(),
        );
    }
    let traced_candidate_evaluations: f64 = checkpoint
        .step_trace
        .iter()
        .map(|trace| trace.candidate_count)
        .sum();
    if !crate::js_number::is_safe_integer(checkpoint.candidate_evaluation_count)
        || checkpoint.candidate_evaluation_count < 0.0
        || checkpoint.candidate_evaluation_count != traced_candidate_evaluations
        || !checkpoint.active_runtime_ms.is_finite()
        || checkpoint.active_runtime_ms < 0.0
    {
        return Some("direct checkpoint budget ledger is invalid.".to_string());
    }
    let phase_ledger_policy_ok = checkpoint.phase_ledger.is_some() == input.capture_phase_timings
        && checkpoint
            .phase_ledger
            .as_ref()
            .map(intrinsic_strict_direct_phase_ledger_valid)
            .unwrap_or(true);
    if !phase_ledger_policy_ok {
        return Some("direct checkpoint phase-accounting policy or ledger is invalid.".to_string());
    }
    None
}

// ===========================================================================
// `intrinsicBoundsSheet` / `isCanonicalSheetlessStateLegal` (`:1936-1954`)
// ===========================================================================

fn intrinsic_bounds_sheet(state: &IrregularBeamState) -> SheetSpec {
    let bounds = state.translated_collision_bounds;
    let max_x = bounds.map(|b| b.max_x).unwrap_or(0.0);
    let max_y = bounds.map(|b| b.max_y).unwrap_or(0.0);
    SheetSpec {
        width: js_math::max(1.0, max_x.ceil()),
        height: js_math::max(1.0, max_y.ceil()),
        label: "intrinsic-completed-layout-bounds".to_string(),
    }
}

// ===========================================================================
// Terminal orientation / completed layout / metrics (`:1783-1954`)
// ===========================================================================

struct TerminalOrientation {
    state: Arc<IrregularBeamState>,
    rotation_deg: TerminalRotationDeg,
    canonical_hash: String,
}

/// TS: `selectTerminalOrientation` (`:1783-1820`).
fn select_terminal_orientation(
    state: &Arc<IrregularBeamState>,
    sheet: &SheetSpec,
) -> Option<TerminalOrientation> {
    let mut legal: Vec<TerminalOrientation> = Vec::new();
    for rotation in [
        IrregularQuarterTurnDegrees::Zero,
        IrregularQuarterTurnDegrees::Ninety,
    ] {
        let oriented = Arc::clone(state).with_quarter_turn_bottom_left(rotation);
        let oriented = match oriented {
            Some(oriented) => oriented,
            None => continue,
        };
        let placed = cloned_placed(&oriented.placed_collision_geometries);
        if !assert_canonical_grid_legal_layout(sheet, &placed) {
            continue;
        }
        if let Some(canonical_identity) = canonical_collision_layout_identity(&placed) {
            legal.push(TerminalOrientation {
                state: oriented,
                rotation_deg: if rotation == IrregularQuarterTurnDegrees::Zero {
                    TerminalRotationDeg::Zero
                } else {
                    TerminalRotationDeg::Ninety
                },
                canonical_hash: sha256_hex(&canonical_identity),
            });
        }
    }
    legal.sort_by(|first, second| {
        locale_compare_keys(&first.canonical_hash, &second.canonical_hash).then_with(|| {
            let first_deg = if first.rotation_deg == TerminalRotationDeg::Zero {
                0.0
            } else {
                90.0
            };
            let second_deg = if second.rotation_deg == TerminalRotationDeg::Zero {
                0.0
            } else {
                90.0
            };
            asc_cmp(first_deg, second_deg)
        })
    });
    legal.into_iter().next()
}

/// TS: `isCanonicalSheetlessStateLegal` (`intrinsicStrictDecoder.ts:1945-1954`).
/// Its **only** TS call site (`:676`) lives inside the
/// `candidateProvenance !== undefined` branch, which is only ever taken when
/// a `featureContactObserver` is attached -- deliberately not ported (see
/// this module's top-level "Deliberately not ported" section). Kept (not
/// deleted) as a faithful, independently testable port of the function
/// itself, per the migration prompt's bar for proving a branch is truly
/// unobservable before dropping it; `#[allow(dead_code)]` documents that this
/// specific unreachability is intentional, not an oversight.
#[allow(dead_code)]
fn is_canonical_sheetless_state_legal(state: &Arc<IrregularBeamState>) -> bool {
    match Arc::clone(state).with_bottom_left_anchored() {
        None => false,
        Some(anchored) => {
            let sheet = intrinsic_bounds_sheet(&anchored);
            let placed = cloned_placed(&anchored.placed_collision_geometries);
            assert_canonical_grid_legal_layout(&sheet, &placed)
        }
    }
}

/// TS: `completedMetrics` (`:1854-1934`).
fn completed_metrics(
    state: &Arc<IrregularBeamState>,
    canonical_geometry_hash: &str,
    runtime_ms: f64,
) -> Option<IntrinsicStrictCompletedMetrics> {
    let placed = cloned_placed(&state.placed_collision_geometries);
    let topology_exact = measure_canonical_layout_topology_exact(&placed)?;
    let cavities = measure_canonical_enclosed_cavities(&placed)?;
    let sheet = intrinsic_bounds_sheet(state);
    let structure = analyze_canonical_layout_structure(&sheet, &placed)?;
    let contacts = measure_canonical_layout_contacts(&placed)?;
    let envelope = measure_canonical_layout_envelope(&placed)?;

    let topology = topology_exact.topology;
    let largest_component: std::collections::HashSet<&PieceId> = structure
        .positive_contact_components
        .first()
        .into_iter()
        .flatten()
        .collect();
    let mut occupied_outside_largest_doubled_area = BigInt::from(0);
    for piece in &structure.pieces {
        if !largest_component.contains(&piece.piece_id) {
            occupied_outside_largest_doubled_area += parse_bigint(&piece.doubled_area_grid2);
        }
    }
    let occupied_area_outside_largest_contact_component_mm2 =
        doubled_grid_area_to_mm2(&occupied_outside_largest_doubled_area).unwrap_or(f64::NAN);
    let occupied_hull_doubled_area = parse_bigint(&envelope.hull_doubled_area_grid2);
    let occupied_doubled_area = parse_bigint(&envelope.occupied_doubled_area_grid2);

    let metrics = IntrinsicStrictCompletedMetrics {
        envelope_maximum_side_mm: envelope.maximum_side_mm,
        envelope_area_mm2: envelope.area_mm2,
        envelope_span_mm: envelope.span_mm,
        enclosed_cavity_count: cavities.count,
        total_enclosed_cavity_area_mm2: cavities.total_area_mm2,
        largest_occupied_hull_gap_ratio: topology.largest_occupied_hull_gap_ratio,
        isolated_piece_count: topology.isolated_piece_count,
        positive_contact_component_count: topology.positive_contact_component_count,
        largest_positive_contact_component_size: topology.largest_positive_contact_component_size,
        largest_positive_contact_component_ratio: topology.largest_positive_contact_component_ratio,
        occupied_area_outside_largest_contact_component_mm2,
        occupied_hull_waste_ratio: envelope.occupied_hull_waste_ratio,
        total_structural_contacts: contacts.total_structural_contacts,
        dominant_structural_contacts: contacts.dominant_structural_contacts,
        contact_units: contacts.contact_units,
        shared_boundary_length_mm: contacts.shared_boundary_length_mm,
        canonical_geometry_hash: canonical_geometry_hash.to_string(),
        runtime_ms,
        exact: Some(IntrinsicStrictCompletedMetricsExact {
            envelope_maximum_side_grid: envelope.maximum_side_grid,
            envelope_area_grid2: envelope.envelope_area_grid2.clone(),
            envelope_span_grid: envelope.span_grid,
            total_enclosed_cavity_doubled_area_grid2: cavities.total_doubled_area_grid2.clone(),
            largest_occupied_hull_gap_doubled_area_grid2: topology_exact
                .exact_hull_gap_doubled_area_grid2
                .clone(),
            occupied_hull_doubled_area_grid2: topology_exact.exact_hull_doubled_area_grid2.clone(),
            occupied_hull_waste_doubled_area_grid2: (&occupied_hull_doubled_area
                - &occupied_doubled_area)
                .to_string(),
            largest_positive_contact_component_size: topology
                .largest_positive_contact_component_size,
            placed_piece_count: state.placed_collision_geometries.len() as f64,
            occupied_outside_largest_contact_component_doubled_area_grid2:
                occupied_outside_largest_doubled_area.to_string(),
        }),
    };

    let all_finite = [
        metrics.envelope_maximum_side_mm,
        metrics.envelope_area_mm2,
        metrics.envelope_span_mm,
        metrics.enclosed_cavity_count,
        metrics.total_enclosed_cavity_area_mm2,
        metrics.largest_occupied_hull_gap_ratio,
        metrics.isolated_piece_count,
        metrics.positive_contact_component_count,
        metrics.largest_positive_contact_component_size,
        metrics.largest_positive_contact_component_ratio,
        metrics.occupied_area_outside_largest_contact_component_mm2,
        metrics.occupied_hull_waste_ratio,
        metrics.total_structural_contacts,
        metrics.dominant_structural_contacts,
        metrics.contact_units,
        metrics.shared_boundary_length_mm,
        metrics.runtime_ms,
    ]
    .iter()
    .all(|value| value.is_finite())
        && !metrics.canonical_geometry_hash.is_empty();
    if all_finite {
        Some(metrics)
    } else {
        None
    }
}

/// TS: `measureIntrinsicSheetlessCompletedLayout` (`:1823-1852`).
pub fn measure_intrinsic_sheetless_completed_layout(
    state: &Arc<IrregularBeamState>,
    runtime_ms: f64,
) -> Option<IntrinsicSheetlessCompletedLayout> {
    let anchored = Arc::clone(state).with_bottom_left_anchored()?;
    if !anchored.unplaced_piece_ids.is_empty() {
        return None;
    }
    let sheet = intrinsic_bounds_sheet(&anchored);
    let placed = cloned_placed(&anchored.placed_collision_geometries);
    if !assert_canonical_grid_legal_layout(&sheet, &placed) {
        return None;
    }
    let canonical_geometry_identity = canonical_collision_layout_identity(&placed)?;
    let canonical_geometry_hash = sha256_hex(&canonical_geometry_identity);
    let metrics = completed_metrics(&anchored, &canonical_geometry_hash, runtime_ms)?;
    Some(IntrinsicSheetlessCompletedLayout {
        placed_collision_geometries: anchored.placed_collision_geometries.clone(),
        canonical_geometry_identity,
        canonical_geometry_hash,
        metrics,
    })
}

// ===========================================================================
// Cohesion certificate (`:1956-2090`)
// ===========================================================================

#[derive(Clone, Debug, PartialEq)]
struct ExactFraction {
    numerator: BigInt,
    denominator: BigInt,
}

fn bigint_abs(value: BigInt) -> BigInt {
    if value < BigInt::from(0) {
        -value
    } else {
        value
    }
}

fn greatest_common_divisor(first: BigInt, second: BigInt) -> BigInt {
    let mut left = bigint_abs(first);
    let mut right = bigint_abs(second);
    while right != BigInt::from(0) {
        let remainder = &left % &right;
        left = right;
        right = remainder;
    }
    left
}

fn normalized_fraction(numerator: BigInt, denominator: BigInt) -> ExactFraction {
    if denominator <= BigInt::from(0) {
        return ExactFraction {
            numerator: BigInt::from(0),
            denominator: BigInt::from(1),
        };
    }
    let divisor = greatest_common_divisor(numerator.clone(), denominator.clone());
    let divisor = if divisor == BigInt::from(0) {
        BigInt::from(1)
    } else {
        divisor
    };
    ExactFraction {
        numerator: &numerator / &divisor,
        denominator: &denominator / &divisor,
    }
}

fn add_fractions(first: &ExactFraction, second: &ExactFraction) -> ExactFraction {
    normalized_fraction(
        &first.numerator * &second.denominator + &second.numerator * &first.denominator,
        &first.denominator * &second.denominator,
    )
}

fn capped_deficit(numerator: BigInt, denominator: BigInt) -> ExactFraction {
    if numerator <= BigInt::from(0) {
        return ExactFraction {
            numerator: BigInt::from(0),
            denominator: BigInt::from(1),
        };
    }
    if numerator >= denominator {
        ExactFraction {
            numerator: BigInt::from(1),
            denominator: BigInt::from(1),
        }
    } else {
        normalized_fraction(numerator, denominator)
    }
}

/// TS: `exactStrictRelativeDeficit` (`:2059-2090`).
fn exact_strict_relative_deficit(
    metrics: &IntrinsicStrictCompletedMetrics,
) -> Option<ExactFraction> {
    let exact = metrics.exact.as_ref()?;
    let mut total = ExactFraction {
        numerator: BigInt::from(0),
        denominator: BigInt::from(1),
    };
    if metrics.enclosed_cavity_count > 2.0 {
        total = add_fractions(
            &total,
            &capped_deficit(
                BigInt::from((metrics.enclosed_cavity_count - 2.0) as i64),
                BigInt::from(2),
            ),
        );
    }
    if metrics.isolated_piece_count > 2.0 {
        total = add_fractions(
            &total,
            &capped_deficit(
                BigInt::from((metrics.isolated_piece_count - 2.0) as i64),
                BigInt::from(2),
            ),
        );
    }
    let placed_count = BigInt::from(exact.placed_piece_count as i64);
    let largest_component = BigInt::from(exact.largest_positive_contact_component_size as i64);
    if BigInt::from(5) * &largest_component < BigInt::from(4) * &placed_count {
        total = add_fractions(
            &total,
            &capped_deficit(
                BigInt::from(4) * &placed_count - BigInt::from(5) * &largest_component,
                BigInt::from(4) * &placed_count,
            ),
        );
    }
    let hull = parse_bigint(&exact.occupied_hull_doubled_area_grid2);
    let hull_gap = parse_bigint(&exact.largest_occupied_hull_gap_doubled_area_grid2);
    if BigInt::from(20) * &hull_gap > BigInt::from(3) * &hull {
        total = add_fractions(
            &total,
            &capped_deficit(
                BigInt::from(20) * &hull_gap - BigInt::from(3) * &hull,
                BigInt::from(3) * &hull,
            ),
        );
    }
    Some(total)
}

/// TS: `evaluateIntrinsicStrictCertificate` (`:1956-2018`).
pub fn evaluate_intrinsic_strict_certificate(
    metrics: &IntrinsicStrictCompletedMetrics,
) -> IntrinsicStrictCertificate {
    let floors = &INTRINSIC_STRICT_COHESION_FLOORS;
    let mut violations = Vec::new();
    let mut relative_deficit_sum = 0.0_f64;

    if metrics.enclosed_cavity_count > floors.maximum_enclosed_cavity_count {
        violations.push(IntrinsicStrictCohesionFloor::MaximumEnclosedCavityCount);
        relative_deficit_sum += js_math::min(
            1.0,
            (metrics.enclosed_cavity_count - floors.maximum_enclosed_cavity_count)
                / js_math::max(1.0, floors.maximum_enclosed_cavity_count),
        );
    }
    if metrics.isolated_piece_count > floors.maximum_isolated_piece_count {
        violations.push(IntrinsicStrictCohesionFloor::MaximumIsolatedPieceCount);
        relative_deficit_sum += js_math::min(
            1.0,
            (metrics.isolated_piece_count - floors.maximum_isolated_piece_count)
                / js_math::max(1.0, floors.maximum_isolated_piece_count),
        );
    }
    let largest_component_below_floor = match &metrics.exact {
        None => {
            metrics.largest_positive_contact_component_ratio
                < floors.minimum_largest_positive_contact_component_ratio
        }
        Some(exact) => {
            BigInt::from(5) * BigInt::from(exact.largest_positive_contact_component_size as i64)
                < BigInt::from(4) * BigInt::from(exact.placed_piece_count as i64)
        }
    };
    if largest_component_below_floor {
        violations.push(IntrinsicStrictCohesionFloor::MinimumLargestPositiveContactComponentRatio);
        relative_deficit_sum += js_math::min(
            1.0,
            (floors.minimum_largest_positive_contact_component_ratio
                - metrics.largest_positive_contact_component_ratio)
                / floors.minimum_largest_positive_contact_component_ratio,
        );
    }
    let largest_hull_gap_above_floor = match &metrics.exact {
        None => {
            metrics.largest_occupied_hull_gap_ratio > floors.maximum_largest_occupied_hull_gap_ratio
        }
        Some(exact) => {
            BigInt::from(20) * parse_bigint(&exact.largest_occupied_hull_gap_doubled_area_grid2)
                > BigInt::from(3) * parse_bigint(&exact.occupied_hull_doubled_area_grid2)
        }
    };
    if largest_hull_gap_above_floor {
        violations.push(IntrinsicStrictCohesionFloor::MaximumLargestOccupiedHullGapRatio);
        relative_deficit_sum += js_math::min(
            1.0,
            (metrics.largest_occupied_hull_gap_ratio
                - floors.maximum_largest_occupied_hull_gap_ratio)
                / floors.maximum_largest_occupied_hull_gap_ratio,
        );
    }

    let exact_relative_deficit = exact_strict_relative_deficit(metrics);
    IntrinsicStrictCertificate {
        passes: violations.is_empty(),
        violated_floors: violations,
        relative_deficit_sum,
        exact_relative_deficit_numerator: exact_relative_deficit
            .as_ref()
            .map(|f| f.numerator.to_string()),
        exact_relative_deficit_denominator: exact_relative_deficit
            .as_ref()
            .map(|f| f.denominator.to_string()),
    }
}

// ===========================================================================
// Pareto dominance and ranking (`:2092-2343`)
// ===========================================================================

fn compare_exact_ratio(
    first_numerator: &BigInt,
    first_denominator: &BigInt,
    second_numerator: &BigInt,
    second_denominator: &BigInt,
) -> Ordering {
    if *first_denominator <= BigInt::from(0) || *second_denominator <= BigInt::from(0) {
        return first_numerator.cmp(second_numerator);
    }
    (first_numerator * second_denominator).cmp(&(second_numerator * first_denominator))
}

/// TS: `compareIntrinsicStrictCompactness` (`:2120-2142`).
fn compare_intrinsic_strict_compactness(
    first: &IntrinsicStrictCompletedMetrics,
    second: &IntrinsicStrictCompletedMetrics,
) -> Ordering {
    match (&first.exact, &second.exact) {
        (Some(fe), Some(se)) => {
            asc_cmp(fe.envelope_maximum_side_grid, se.envelope_maximum_side_grid)
                .then_with(|| {
                    compare_bigint_decimal_strings(&fe.envelope_area_grid2, &se.envelope_area_grid2)
                })
                .then_with(|| asc_cmp(fe.envelope_span_grid, se.envelope_span_grid))
        }
        _ => asc_cmp(
            canonical_linear_metric(first.envelope_maximum_side_mm),
            canonical_linear_metric(second.envelope_maximum_side_mm),
        )
        .then_with(|| {
            asc_cmp(
                canonical_area_metric(first.envelope_area_mm2),
                canonical_area_metric(second.envelope_area_mm2),
            )
        })
        .then_with(|| {
            asc_cmp(
                canonical_linear_metric(first.envelope_span_mm),
                canonical_linear_metric(second.envelope_span_mm),
            )
        }),
    }
}

/// TS: `compareIntrinsicStrictVoidTopology` (`:2144-2176`).
fn compare_intrinsic_strict_void_topology(
    first: &IntrinsicStrictCompletedMetrics,
    second: &IntrinsicStrictCompletedMetrics,
) -> Ordering {
    let cavity_cmp = asc_cmp(first.enclosed_cavity_count, second.enclosed_cavity_count);
    if cavity_cmp != Ordering::Equal {
        return cavity_cmp;
    }
    match (&first.exact, &second.exact) {
        (Some(fe), Some(se)) => compare_bigint_decimal_strings(
            &fe.total_enclosed_cavity_doubled_area_grid2,
            &se.total_enclosed_cavity_doubled_area_grid2,
        )
        .then_with(|| {
            compare_exact_ratio(
                &parse_bigint(&fe.largest_occupied_hull_gap_doubled_area_grid2),
                &parse_bigint(&fe.occupied_hull_doubled_area_grid2),
                &parse_bigint(&se.largest_occupied_hull_gap_doubled_area_grid2),
                &parse_bigint(&se.occupied_hull_doubled_area_grid2),
            )
        })
        .then_with(|| {
            compare_exact_ratio(
                &parse_bigint(&fe.occupied_hull_waste_doubled_area_grid2),
                &parse_bigint(&fe.occupied_hull_doubled_area_grid2),
                &parse_bigint(&se.occupied_hull_waste_doubled_area_grid2),
                &parse_bigint(&se.occupied_hull_doubled_area_grid2),
            )
        }),
        _ => asc_cmp(
            canonical_area_metric(first.total_enclosed_cavity_area_mm2),
            canonical_area_metric(second.total_enclosed_cavity_area_mm2),
        )
        .then_with(|| {
            asc_cmp(
                first.largest_occupied_hull_gap_ratio,
                second.largest_occupied_hull_gap_ratio,
            )
        })
        .then_with(|| {
            asc_cmp(
                first.occupied_hull_waste_ratio,
                second.occupied_hull_waste_ratio,
            )
        }),
    }
}

/// TS: `compareIntrinsicStrictContact` (`:2178-2216`).
fn compare_intrinsic_strict_contact(
    first: &IntrinsicStrictCompletedMetrics,
    second: &IntrinsicStrictCompletedMetrics,
) -> Ordering {
    let discrete = asc_cmp(first.isolated_piece_count, second.isolated_piece_count)
        .then_with(|| {
            asc_cmp(
                first.positive_contact_component_count,
                second.positive_contact_component_count,
            )
        })
        .then_with(|| {
            desc_cmp(
                first.largest_positive_contact_component_size,
                second.largest_positive_contact_component_size,
            )
        });
    let mid = if discrete != Ordering::Equal {
        discrete
    } else {
        match (&first.exact, &second.exact) {
            (Some(fe), Some(se)) => {
                let ratio_cmp = compare_exact_ratio(
                    &parse_bigint(&se.largest_positive_contact_component_size.to_string()),
                    &BigInt::from(se.placed_piece_count as i64),
                    &parse_bigint(&fe.largest_positive_contact_component_size.to_string()),
                    &BigInt::from(fe.placed_piece_count as i64),
                );
                if ratio_cmp != Ordering::Equal {
                    ratio_cmp
                } else {
                    compare_bigint_decimal_strings(
                        &fe.occupied_outside_largest_contact_component_doubled_area_grid2,
                        &se.occupied_outside_largest_contact_component_doubled_area_grid2,
                    )
                }
            }
            _ => desc_cmp(
                first.largest_positive_contact_component_ratio,
                second.largest_positive_contact_component_ratio,
            )
            .then_with(|| {
                asc_cmp(
                    canonical_area_metric(
                        first.occupied_area_outside_largest_contact_component_mm2,
                    ),
                    canonical_area_metric(
                        second.occupied_area_outside_largest_contact_component_mm2,
                    ),
                )
            }),
        }
    };
    if mid != Ordering::Equal {
        return mid;
    }
    desc_cmp(
        first.total_structural_contacts,
        second.total_structural_contacts,
    )
    .then_with(|| {
        desc_cmp(
            first.dominant_structural_contacts,
            second.dominant_structural_contacts,
        )
    })
    .then_with(|| desc_cmp(first.contact_units, second.contact_units))
    .then_with(|| {
        desc_cmp(
            canonical_linear_metric(first.shared_boundary_length_mm),
            canonical_linear_metric(second.shared_boundary_length_mm),
        )
    })
}

/// TS: `compareIntrinsicStrictCompletedLayoutDominance` (`:2248-2261`).
pub fn compare_intrinsic_strict_completed_layout_dominance(
    first: &IntrinsicStrictCompletedMetrics,
    second: &IntrinsicStrictCompletedMetrics,
) -> Ordering {
    let mut first_better = false;
    let mut second_better = false;
    for objective in [
        compare_intrinsic_strict_compactness,
        compare_intrinsic_strict_void_topology,
    ] {
        let comparison = objective(first, second);
        first_better |= comparison == Ordering::Less;
        second_better |= comparison == Ordering::Greater;
        if first_better && second_better {
            return Ordering::Equal;
        }
    }
    if first_better {
        Ordering::Less
    } else if second_better {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// TS: `intrinsicStrictCompletedLayoutDominates` (`:2263-2268`).
pub fn intrinsic_strict_completed_layout_dominates(
    first: &IntrinsicStrictCompletedMetrics,
    second: &IntrinsicStrictCompletedMetrics,
) -> bool {
    compare_intrinsic_strict_completed_layout_dominance(first, second) == Ordering::Less
}

/// TS: `orderIntrinsicStrictParetoFront` (`:2321-2343`).
fn order_intrinsic_strict_pareto_front(
    frontier: Vec<IntrinsicStrictCompletedMetrics>,
) -> Vec<IntrinsicStrictCompletedMetrics> {
    let objectives: [fn(
        &IntrinsicStrictCompletedMetrics,
        &IntrinsicStrictCompletedMetrics,
    ) -> Ordering; 3] = [
        compare_intrinsic_strict_compactness,
        compare_intrinsic_strict_void_topology,
        compare_intrinsic_strict_contact,
    ];
    let mut remaining = frontier;
    let mut ordered: Vec<IntrinsicStrictCompletedMetrics> = Vec::new();
    while !remaining.is_empty() {
        let mut selected_any = false;
        for objective in objectives {
            if remaining.is_empty() {
                break;
            }
            let mut best_index = 0usize;
            for index in 1..remaining.len() {
                let ordering =
                    objective(&remaining[index], &remaining[best_index]).then_with(|| {
                        locale_compare_keys(
                            &remaining[index].canonical_geometry_hash,
                            &remaining[best_index].canonical_geometry_hash,
                        )
                    });
                if ordering == Ordering::Less {
                    best_index = index;
                }
            }
            let selected = remaining.remove(best_index);
            ordered.push(selected);
            selected_any = true;
        }
        if !selected_any {
            break;
        }
    }
    ordered
}

/// TS: `selectIntrinsicStrictCompletedParetoFront` (`:2271-2281`).
pub fn select_intrinsic_strict_completed_pareto_front(
    layouts: &[IntrinsicStrictCompletedMetrics],
) -> Vec<IntrinsicStrictCompletedMetrics> {
    let frontier: Vec<IntrinsicStrictCompletedMetrics> = layouts
        .iter()
        .enumerate()
        .filter(|(index, candidate)| {
            !layouts.iter().enumerate().any(|(other_index, other)| {
                other_index != *index
                    && intrinsic_strict_completed_layout_dominates(other, candidate)
            })
        })
        .map(|(_, candidate)| candidate.clone())
        .collect();
    order_intrinsic_strict_pareto_front(frontier)
}

/// TS: `rankIntrinsicStrictParetoPartition` (`:2290-2319`).
fn rank_intrinsic_strict_pareto_partition(
    layouts: &[IntrinsicStrictCompletedMetrics],
) -> Vec<IntrinsicStrictCompletedMetrics> {
    let mut remaining: Vec<IntrinsicStrictCompletedMetrics> = layouts.to_vec();
    let mut ranked: Vec<IntrinsicStrictCompletedMetrics> = Vec::new();
    while !remaining.is_empty() {
        let frontier_indices: Vec<usize> = (0..remaining.len())
            .filter(|&index| {
                !(0..remaining.len()).any(|other_index| {
                    other_index != index
                        && intrinsic_strict_completed_layout_dominates(
                            &remaining[other_index],
                            &remaining[index],
                        )
                })
            })
            .collect();
        if frontier_indices.is_empty() {
            let mut fallback = remaining.clone();
            fallback.sort_by(|first, second| {
                locale_compare_keys(
                    &first.canonical_geometry_hash,
                    &second.canonical_geometry_hash,
                )
            });
            ranked.extend(fallback);
            return ranked;
        }
        let frontier: Vec<IntrinsicStrictCompletedMetrics> = frontier_indices
            .iter()
            .map(|&index| remaining[index].clone())
            .collect();
        ranked.extend(order_intrinsic_strict_pareto_front(frontier));
        let frontier_index_set: std::collections::HashSet<usize> =
            frontier_indices.into_iter().collect();
        let mut next_remaining = Vec::with_capacity(remaining.len());
        for (index, candidate) in remaining.into_iter().enumerate() {
            if !frontier_index_set.contains(&index) {
                next_remaining.push(candidate);
            }
        }
        remaining = next_remaining;
    }
    ranked
}

/// TS: `rankIntrinsicStrictCompletedLayouts` (`:2284-2288`).
pub fn rank_intrinsic_strict_completed_layouts(
    layouts: &[IntrinsicStrictCompletedMetrics],
) -> Vec<IntrinsicStrictCompletedMetrics> {
    rank_intrinsic_strict_pareto_partition(layouts)
}

// ===========================================================================
// `makeResult` (`:2345-2363`)
// ===========================================================================

fn make_result(
    status: IntrinsicStrictDecodeStatus,
    state: &Arc<IrregularBeamState>,
    step_trace: Vec<IntrinsicStrictStepTrace>,
    runtime_ms: f64,
) -> IntrinsicStrictDecodeResult {
    IntrinsicStrictDecodeResult {
        status,
        placements: state
            .placed_collision_geometries
            .iter()
            .map(|p| p.placement.clone())
            .collect(),
        placed_collision_geometries: state.placed_collision_geometries.clone(),
        unplaced_piece_ids: state.unplaced_piece_ids.clone(),
        terminal_rotation_deg: None,
        canonical_geometry_hash: None,
        metrics: None,
        certificate: None,
        step_trace,
        runtime_ms,
    }
}

// ===========================================================================
// `finalizeIntrinsicStrictState` / `decodeIntrinsicStrictPriorityOrder`
// (`:331-398`)
// ===========================================================================

/// TS: `finalizeIntrinsicStrictState` (`intrinsicStrictDecoder.ts:366-398`).
pub fn finalize_intrinsic_strict_state(
    final_sheet: &SheetSpec,
    constructed: IntrinsicStrictConstructResult,
    runtime_ms: f64,
) -> Result<IntrinsicStrictDecodeResult, IntrinsicStrictDecoderError> {
    let state = constructed.state;
    let step_trace = constructed.step_trace;
    if !state.unplaced_piece_ids.is_empty() {
        return Ok(make_result(
            IntrinsicStrictDecodeStatus::Incomplete,
            &state,
            step_trace,
            runtime_ms,
        ));
    }
    let terminal = match select_terminal_orientation(&state, final_sheet) {
        Some(terminal) => terminal,
        None => {
            return Ok(make_result(
                IntrinsicStrictDecodeStatus::InfeasibleFinalSheet,
                &state,
                step_trace,
                runtime_ms,
            ))
        }
    };
    let measured = measure_intrinsic_sheetless_completed_layout(&terminal.state, runtime_ms);
    let measured = match measured {
        Some(measured) => measured,
        None => {
            return Err(IntrinsicStrictDecoderError {
                operation: "completedMetrics".to_string(),
                message: "completed canonical layout metrics must remain finite and exact."
                    .to_string(),
            })
        }
    };
    let certificate = evaluate_intrinsic_strict_certificate(&measured.metrics);
    let mut result = make_result(
        IntrinsicStrictDecodeStatus::Completed,
        &terminal.state,
        step_trace,
        runtime_ms,
    );
    result.terminal_rotation_deg = Some(terminal.rotation_deg);
    result.canonical_geometry_hash = Some(terminal.canonical_hash);
    result.metrics = Some(measured.metrics);
    result.certificate = Some(certificate);
    Ok(result)
}

// ===========================================================================
// The deadline-composing `NfpIfpControl` wrapper (`:472-488`, characterization
// §10 item 1).
// ===========================================================================

struct DeadlineControl<'a> {
    outer: Option<&'a mut dyn NfpIfpControl>,
    previous_active_runtime_ms: f64,
    started_at: f64,
    maximum_runtime_ms: f64,
    timing_now: &'a TimingNowFn,
}

impl NfpIfpControl for DeadlineControl<'_> {
    fn checkpoint(
        &mut self,
        phase: crate::nfp_ifp::telemetry::NfpIfpCheckpointPhase,
    ) -> Result<(), NfpIfpControlAbortError> {
        if let Some(outer) = self.outer.as_deref_mut() {
            outer.checkpoint(phase)?;
        }
        if self.previous_active_runtime_ms + (self.timing_now)() - self.started_at
            >= self.maximum_runtime_ms
        {
            return Err(NfpIfpControlAbortError {
                reason: NfpIfpAbortReason::Deadline,
                message: format!(
                    "intrinsic strict decode exceeded {} ms.",
                    self.maximum_runtime_ms
                ),
            });
        }
        Ok(())
    }
}

fn nfp_ifp_error_to_failure(error: NfpIfpError) -> IntrinsicStrictDecoderFailure {
    match error {
        NfpIfpError::Geometry(g) => IntrinsicStrictDecoderFailure::Geometry(g),
        NfpIfpError::Abort(a) => IntrinsicStrictDecoderFailure::Abort(a),
    }
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
// `constructIntrinsicStrictState` (`:401-866`)
// ===========================================================================

enum TransformStepOutcome {
    Fail(IntrinsicStrictDecoderFailure),
    Skip,
    Ready {
        moving: TransformedCollisionGeometry,
        moving_collision_area_mm2: f64,
        moving_collision_doubled_area_grid2: String,
        legal_candidates: Vec<IrregularPlacementCandidate>,
    },
}

/// TS: `constructIntrinsicStrictState` (`intrinsicStrictDecoder.ts:401-866`).
/// See this module's top-level doc for the `geometry_cache`/`settings` seam
/// and the F0-observer/`IrregularNestingNotImplementedError` omissions.
pub fn construct_intrinsic_strict_state(
    mut input: ConstructIntrinsicStrictStateInput<'_>,
    settings: &IrregularNestingSettings,
    geometry_cache: &mut GeometryCacheStore,
) -> Result<IntrinsicStrictConstructResult, IntrinsicStrictDecoderFailure> {
    let default_timing_now_ref: &TimingNowFn = &default_timing_now;
    let timing_now: &TimingNowFn = input.timing_now.unwrap_or(default_timing_now_ref);
    let started_at = timing_now();

    let maximum_runtime_ms = input.maximum_runtime_ms.unwrap_or(120_000.0);
    let maximum_candidate_evaluation_count = input
        .maximum_candidate_evaluation_count
        .map(|value| js_math::max(1.0, js_math::floor(value)));
    let maximum_completed_piece_boundaries = input
        .maximum_completed_piece_boundaries
        .map(|value| js_math::max(1.0, js_math::floor(value)));
    let capture_candidate_evaluation_count = input.capture_candidate_evaluation_count
        || maximum_candidate_evaluation_count.is_some()
        || maximum_completed_piece_boundaries.is_some()
        || input.checkpoint.is_some();
    let checkpointing_enabled =
        maximum_completed_piece_boundaries.is_some() || input.checkpoint.is_some();
    let capture_phase_timings = input.capture_phase_timings;

    if let Some(message) = validate_seed_partition(&input) {
        return Err(decoder_error("seedPartition", message));
    }

    let producer_role = input
        .producer_role
        .clone()
        .unwrap_or_else(|| "intrinsic-strict".to_string());
    let request_fingerprint = if checkpointing_enabled {
        Some(intrinsic_strict_direct_request_fingerprint(
            input.all_prepared_pieces,
            input.remaining_prepared_pieces,
            input.frozen_placed,
            input.candidate_mode,
            settings,
            &producer_role,
            maximum_runtime_ms,
            maximum_candidate_evaluation_count,
            capture_phase_timings,
        ))
    } else {
        None
    };

    if let Some(message) = validate_intrinsic_strict_direct_checkpoint(ValidateCheckpointInput {
        checkpoint: &input.checkpoint,
        request_fingerprint: request_fingerprint.as_deref(),
        producer_role: &producer_role,
        remaining_prepared_pieces: input.remaining_prepared_pieces,
        frozen_placed: input.frozen_placed,
        capture_phase_timings,
    }) {
        return Err(decoder_error("directCheckpoint", message));
    }

    let previous_active_runtime_ms = input
        .checkpoint
        .as_ref()
        .map(|c| c.active_runtime_ms)
        .unwrap_or(0.0);
    let mut memo = LegalCandidateMemo::new();

    let mut state: Arc<IrregularBeamState> =
        match input.checkpoint.as_ref().map(|c| Arc::clone(&c.state)) {
            Some(state) => state,
            None => {
                let seed = IrregularBeamState::from_input(IrregularBeamStateInput {
                    remaining_prepared_pieces: input.remaining_prepared_pieces.to_vec(),
                    placed_collision_geometries: input.frozen_placed.to_vec(),
                    unplaced_piece_ids: None,
                    unplaced_source_piece_ids: None,
                    placement_order: input
                        .frozen_placed
                        .iter()
                        .map(|p| placed_piece_id(p))
                        .collect(),
                    parent: None,
                    placed_collision_index: None,
                });
                match seed.with_bottom_left_anchored() {
                    Some(state) => state,
                    None => return Err(decoder_error(
                        "frozenPlaced",
                        "frozen seed placements must form one exact canonical sheetless layout.",
                    )),
                }
            }
        };
    if !state.placed_collision_geometries.is_empty() {
        let sheet = intrinsic_bounds_sheet(&state);
        let placed = cloned_placed(&state.placed_collision_geometries);
        if !assert_canonical_grid_legal_layout(&sheet, &placed) {
            return Err(decoder_error(
                "frozenPlaced",
                "frozen seed placements must form one exact canonical sheetless layout.",
            ));
        }
    }

    let mut step_trace: Vec<IntrinsicStrictStepTrace> = input
        .checkpoint
        .as_ref()
        .map(|c| c.step_trace.clone())
        .unwrap_or_default();
    let mut gap_fill_evidence: Vec<IntrinsicStrictGapFillEvidence> = input
        .checkpoint
        .as_ref()
        .map(|c| c.gap_fill_evidence.clone())
        .unwrap_or_default();
    let mut candidate_evaluation_count = input
        .checkpoint
        .as_ref()
        .map(|c| c.candidate_evaluation_count)
        .unwrap_or(0.0);
    let mut truncation_reason: Option<TruncationReason> = None;
    let mut pause_reason: Option<PauseReason> = None;
    let mut candidate_generation_ms = input
        .checkpoint
        .as_ref()
        .and_then(|c| c.phase_ledger.as_ref())
        .map(|l| l.candidate_generation_ms)
        .unwrap_or(0.0);
    let mut candidate_state_scoring_ms = input
        .checkpoint
        .as_ref()
        .and_then(|c| c.phase_ledger.as_ref())
        .map(|l| l.candidate_state_scoring_ms)
        .unwrap_or(0.0);
    let mut candidate_state_phase_timings: CandidateStatePhaseTimings = input
        .checkpoint
        .as_ref()
        .and_then(|c| c.phase_ledger.as_ref())
        .map(|l| l.candidate_state)
        .unwrap_or_default();
    let mut completed_piece_boundaries = 0.0_f64;
    let first_piece_index = input
        .checkpoint
        .as_ref()
        .map(|c| c.next_piece_index)
        .unwrap_or(0.0) as usize;

    let outer_control = input.control.take();
    let mut control = DeadlineControl {
        outer: outer_control,
        previous_active_runtime_ms,
        started_at,
        maximum_runtime_ms,
        timing_now,
    };

    'piece_loop: for piece_index in first_piece_index..input.remaining_prepared_pieces.len() {
        let piece = &input.remaining_prepared_pieces[piece_index];
        let piece_id = prepared_piece_id(piece);
        let remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>> =
            input.remaining_prepared_pieces[(piece_index + 1)..].to_vec();
        let mut candidates_by_family: Vec<(String, ScoredCandidate)> = Vec::new();
        let mut contained_candidates_by_family: Vec<(String, ScoredCandidate)> = Vec::new();
        let gap_regions: Option<Vec<CanonicalIntrinsicGapRegion>> = if matches!(
            input.candidate_mode,
            IntrinsicStrictCandidateMode::GapContained
        ) {
            derive_canonical_intrinsic_gap_regions(&cloned_placed(
                &state.placed_collision_geometries,
            ))
        } else {
            None
        };
        let mut candidate_count = 0.0_f64;

        let mut sorted_transforms: Vec<IrregularTransformCandidate> = piece.transforms.clone();
        sorted_transforms.sort_by(transform_candidate_order);

        for transform in &sorted_transforms {
            let candidate_generation_started_at = if capture_phase_timings {
                timing_now()
            } else {
                0.0
            };
            let outcome = (|| -> TransformStepOutcome {
                if let Err(abort) = control
                    .checkpoint(crate::nfp_ifp::telemetry::NfpIfpCheckpointPhase::CandidatePoints)
                {
                    return TransformStepOutcome::Fail(IntrinsicStrictDecoderFailure::Abort(abort));
                }
                let moving = match transform_collision_geometry(
                    &piece.collision_geometry,
                    transform,
                    &settings.geometry,
                    geometry_cache,
                ) {
                    Ok(moving) => moving,
                    Err(e) => {
                        return TransformStepOutcome::Fail(IntrinsicStrictDecoderFailure::Geometry(
                            e,
                        ))
                    }
                };
                let moving_collision_area = match canonical_collision_area(&moving) {
                    Some(value) => value,
                    None => return TransformStepOutcome::Skip,
                };
                let legal_candidates = if state.placed_collision_geometries.is_empty() {
                    origin_anchor_candidates(&moving)
                } else {
                    let sheet = intrinsic_coordinate_domain();
                    let gp_input = GeneratePlacementCandidatesInput {
                        sheet: &sheet,
                        placed: &state.placed_collision_geometries,
                        placed_collision_index: Some(&state.placed_collision_index),
                        moving: &moving,
                        settings,
                        candidate_domain: CandidateDomain::SheetlessNfp,
                        want_provenance: false,
                    };
                    match generate_placement_candidates(
                        &gp_input,
                        geometry_cache,
                        DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
                        NfpCandidatePruningMode::Indexed,
                        Some(&mut memo),
                        None,
                        Some(&mut control),
                    ) {
                        Ok(outcome) => outcome.candidates,
                        Err(e) => return TransformStepOutcome::Fail(nfp_ifp_error_to_failure(e)),
                    }
                };
                TransformStepOutcome::Ready {
                    moving,
                    moving_collision_area_mm2: moving_collision_area.0,
                    moving_collision_doubled_area_grid2: moving_collision_area.1,
                    legal_candidates,
                }
            })();
            if capture_phase_timings {
                candidate_generation_ms += timing_now() - candidate_generation_started_at;
            }

            let (
                moving,
                moving_collision_area_mm2,
                moving_collision_doubled_area_grid2,
                legal_candidates,
            ) = match outcome {
                TransformStepOutcome::Fail(e) => return Err(e),
                TransformStepOutcome::Skip => continue,
                TransformStepOutcome::Ready {
                    moving,
                    moving_collision_area_mm2,
                    moving_collision_doubled_area_grid2,
                    legal_candidates,
                } => (
                    moving,
                    moving_collision_area_mm2,
                    moving_collision_doubled_area_grid2,
                    legal_candidates,
                ),
            };

            candidate_count += legal_candidates.len() as f64;
            let family = transform_family_key(transform);
            let candidate_state_scoring_started_at = if capture_phase_timings {
                timing_now()
            } else {
                0.0
            };

            for candidate in &legal_candidates {
                if let Some(cap) = maximum_candidate_evaluation_count {
                    if candidate_evaluation_count >= cap {
                        truncation_reason = Some(TruncationReason::MaximumCandidateEvaluations);
                        if capture_phase_timings {
                            candidate_state_scoring_ms +=
                                timing_now() - candidate_state_scoring_started_at;
                        }
                        break 'piece_loop;
                    }
                }
                if capture_candidate_evaluation_count {
                    candidate_evaluation_count += 1.0;
                }
                let scored = score_candidate(
                    &state,
                    piece,
                    &moving,
                    candidate,
                    remaining_prepared_pieces.clone(),
                    &family,
                    moving_collision_area_mm2,
                    &moving_collision_doubled_area_grid2,
                    gap_regions.as_deref(),
                    if capture_phase_timings {
                        Some(&mut candidate_state_phase_timings)
                    } else {
                        None
                    },
                    timing_now,
                );
                let scored = match scored {
                    Some(scored) => scored,
                    None => continue,
                };
                let candidate_selection_started_at = if capture_phase_timings {
                    timing_now()
                } else {
                    0.0
                };
                let incumbent = candidates_by_family
                    .iter()
                    .position(|(key, _)| key == &family);
                let should_replace = match incumbent {
                    None => true,
                    Some(index) => {
                        compare_local_scores(&scored.score, &candidates_by_family[index].1.score)
                            == Ordering::Less
                    }
                };
                if should_replace {
                    match incumbent {
                        Some(index) => candidates_by_family[index].1 = scored.clone(),
                        None => candidates_by_family.push((family.clone(), scored.clone())),
                    }
                }
                if scored.containing_gap.is_some() {
                    let contained_incumbent = contained_candidates_by_family
                        .iter()
                        .position(|(key, _)| key == &family);
                    let should_replace_contained = match contained_incumbent {
                        None => true,
                        Some(index) => {
                            compare_gap_contained_candidates(
                                &scored,
                                &contained_candidates_by_family[index].1,
                            ) == Ordering::Less
                        }
                    };
                    if should_replace_contained {
                        match contained_incumbent {
                            Some(index) => contained_candidates_by_family[index].1 = scored.clone(),
                            None => contained_candidates_by_family
                                .push((family.clone(), scored.clone())),
                        }
                    }
                }
                if capture_phase_timings {
                    candidate_state_phase_timings.candidate_selection_ms +=
                        timing_now() - candidate_selection_started_at;
                }
            }
            if capture_phase_timings {
                candidate_state_scoring_ms += timing_now() - candidate_state_scoring_started_at;
            }
        }

        let family_winners: Vec<ScoredCandidate> =
            candidates_by_family.into_iter().map(|(_, c)| c).collect();
        let unanchored_selected: Option<ScoredCandidate> = if matches!(
            input.candidate_mode,
            IntrinsicStrictCandidateMode::GapContained
        ) {
            let mut combined: Vec<ScoredCandidate> = contained_candidates_by_family
                .into_iter()
                .map(|(_, c)| c)
                .collect();
            combined.extend(family_winners.iter().cloned());
            select_gap_contained_winner(&combined).cloned()
        } else {
            let comparator_mode = match input.candidate_mode {
                IntrinsicStrictCandidateMode::Comparator(mode) => mode,
                IntrinsicStrictCandidateMode::GapContained => unreachable!(),
            };
            select_intrinsic_strict_family_winner(&family_winners, comparator_mode).cloned()
        };

        let retained_state_anchoring_started_at = if capture_phase_timings {
            timing_now()
        } else {
            0.0
        };
        let selected_state = unanchored_selected
            .as_ref()
            .and_then(|selected| Arc::clone(&selected.state).with_bottom_left_anchored());
        if capture_phase_timings {
            let retained_state_anchoring_ms = timing_now() - retained_state_anchoring_started_at;
            candidate_state_scoring_ms += retained_state_anchoring_ms;
            candidate_state_phase_timings.bottom_left_anchoring_ms += retained_state_anchoring_ms;
            candidate_state_phase_timings.total_ms += retained_state_anchoring_ms;
        }
        let selected: Option<ScoredCandidate> = match (unanchored_selected, selected_state) {
            (Some(mut selected), Some(state)) => {
                selected.state = state;
                Some(selected)
            }
            _ => None,
        };

        step_trace.push(IntrinsicStrictStepTrace {
            piece_id: piece_id.clone(),
            candidate_count,
            transform_family_count: family_winners.len() as f64,
            selected_transform_family: selected.as_ref().map(|s| s.transform_family.clone()),
            selected_score: selected.as_ref().map(|s| s.score.clone()),
        });

        if let Some(selected) = &selected {
            if let Some(containing_gap) = &selected.containing_gap {
                let before_bounds = state.translated_collision_bounds;
                let after_bounds = selected.state.translated_collision_bounds;
                let recomputed_gap_regions = derive_canonical_intrinsic_gap_regions(
                    &cloned_placed(&selected.state.placed_collision_geometries),
                );
                let total_gap_area_before_mm2 = gap_regions
                    .as_ref()
                    .map(|regions| regions.iter().map(|r| r.area_mm2).sum::<f64>())
                    .unwrap_or(f64::NAN);
                let total_gap_area_after_mm2 = recomputed_gap_regions
                    .as_ref()
                    .map(|regions| regions.iter().map(|r| r.area_mm2).sum::<f64>())
                    .unwrap_or(f64::NAN);
                let region_area_after_mm2 = js_math::max(
                    0.0,
                    containing_gap.area_mm2
                        - (total_gap_area_before_mm2 - total_gap_area_after_mm2),
                );
                let envelope_maximum_side_delta_mm = match (before_bounds, after_bounds) {
                    (Some(before), Some(after)) => {
                        js_math::max(after.width, after.height)
                            - js_math::max(before.width, before.height)
                    }
                    _ => f64::INFINITY,
                };
                let envelope_area_delta_mm2 = match (before_bounds, after_bounds) {
                    (Some(before), Some(after)) => {
                        after.width * after.height - before.width * before.height
                    }
                    _ => f64::INFINITY,
                };
                let before_shared_boundary_length_mm =
                    state.shared_collision_boundary_length_mm.unwrap_or(0.0);
                let after_shared_boundary_length_mm = selected
                    .state
                    .shared_collision_boundary_length_mm
                    .unwrap_or(0.0);
                let inserted_shared_boundary_length_mm =
                    if after_shared_boundary_length_mm >= before_shared_boundary_length_mm {
                        after_shared_boundary_length_mm - before_shared_boundary_length_mm
                    } else {
                        f64::NAN
                    };
                gap_fill_evidence.push(IntrinsicStrictGapFillEvidence {
                    piece_id: piece_id.clone(),
                    region_key: containing_gap.canonical_key.clone(),
                    region_area_before_mm2: containing_gap.area_mm2,
                    region_area_after_mm2,
                    envelope_maximum_side_delta_mm,
                    envelope_area_delta_mm2,
                    shared_boundary_length_mm: inserted_shared_boundary_length_mm,
                    non_inert: inserted_shared_boundary_length_mm > 0.0
                        && envelope_maximum_side_delta_mm == 0.0
                        && envelope_area_delta_mm2 == 0.0
                        && region_area_after_mm2 < containing_gap.area_mm2,
                });
            }
        }

        state = match selected {
            Some(selected) => selected.state,
            None => Arc::clone(&state).with_unplaced_piece(WithUnplacedPieceInput {
                remaining_prepared_pieces,
                unplaced_piece_id: piece_id,
            }),
        };
        completed_piece_boundaries += 1.0;
        if let Some(cap) = maximum_completed_piece_boundaries {
            if completed_piece_boundaries >= cap
                && piece_index + 1 < input.remaining_prepared_pieces.len()
            {
                pause_reason = Some(PauseReason::CompletedPieceBoundary);
                break;
            }
        }
    }

    let runtime_ms = previous_active_runtime_ms + js_math::max(0.0, timing_now() - started_at);
    let next_piece_index = first_piece_index as f64 + completed_piece_boundaries;
    let phase_ledger = if capture_phase_timings {
        Some(IntrinsicStrictDirectPhaseLedger {
            candidate_generation_ms,
            candidate_state_scoring_ms,
            candidate_state: candidate_state_phase_timings,
        })
    } else {
        None
    };
    let checkpoint = if pause_reason == Some(PauseReason::CompletedPieceBoundary) {
        request_fingerprint.as_ref().map(|request_fingerprint| {
            make_intrinsic_strict_direct_checkpoint(
                &producer_role,
                request_fingerprint,
                Arc::clone(&state),
                next_piece_index,
                step_trace.clone(),
                gap_fill_evidence.clone(),
                candidate_evaluation_count,
                runtime_ms,
                phase_ledger,
            )
        })
    } else {
        None
    };
    let phase_timings = if capture_phase_timings {
        Some(make_construct_phase_timings(
            runtime_ms,
            candidate_generation_ms,
            candidate_state_scoring_ms,
            &candidate_state_phase_timings,
        ))
    } else {
        None
    };

    Ok(IntrinsicStrictConstructResult {
        state,
        step_trace,
        gap_fill_evidence,
        candidate_evaluation_count: if capture_candidate_evaluation_count {
            Some(candidate_evaluation_count)
        } else {
            None
        },
        truncation_reason: if capture_candidate_evaluation_count {
            truncation_reason
        } else {
            None
        },
        pause_reason,
        checkpoint,
        phase_timings,
        runtime_ms,
    })
}

/// TS: `decodeIntrinsicStrictPriorityOrder` (`intrinsicStrictDecoder.ts:331-363`).
pub struct DecodeIntrinsicStrictPriorityOrderOptions {
    pub maximum_runtime_ms: Option<f64>,
    pub comparator_mode: Option<IntrinsicStrictComparatorMode>,
}

pub fn decode_intrinsic_strict_priority_order(
    final_sheet: &SheetSpec,
    pieces: &[Arc<IrregularPreparedPiece>],
    options: DecodeIntrinsicStrictPriorityOrderOptions,
    settings: &IrregularNestingSettings,
    geometry_cache: &mut GeometryCacheStore,
) -> Result<IntrinsicStrictDecodeResult, IntrinsicStrictDecoderFailure> {
    let started_at = default_timing_now();
    let maximum_runtime_ms = options.maximum_runtime_ms.unwrap_or(120_000.0);
    let comparator_mode = options
        .comparator_mode
        .unwrap_or(IntrinsicStrictComparatorMode::PureGrowth);
    let constructed = construct_intrinsic_strict_state(
        ConstructIntrinsicStrictStateInput {
            all_prepared_pieces: pieces,
            remaining_prepared_pieces: pieces,
            frozen_placed: &[],
            candidate_mode: IntrinsicStrictCandidateMode::Comparator(comparator_mode),
            maximum_runtime_ms: Some(maximum_runtime_ms),
            maximum_candidate_evaluation_count: None,
            capture_candidate_evaluation_count: false,
            capture_phase_timings: false,
            timing_now: None,
            producer_role: None,
            checkpoint: None,
            maximum_completed_piece_boundaries: None,
            control: None,
        },
        settings,
        geometry_cache,
    )?;
    let runtime_ms = js_math::max(0.0, default_timing_now() - started_at);
    finalize_intrinsic_strict_state(final_sheet, constructed, runtime_ms)
        .map_err(IntrinsicStrictDecoderFailure::Decoder)
}
