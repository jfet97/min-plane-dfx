//! Periodic-family continuation selection and execution: turns each
//! catalog cell into finite crops, Pareto-selects and dedups continuations
//! across families, runs each through the unchanged strict decoder in
//! `pure-growth` mode, and ranks the completed results into a shared
//! archive.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts`
//! (1482 lines), ported in full per
//! `docs/planning/rust-irregular-backend/characterization/periodic.md` (this
//! module's primary governing source, shared with `periodic_cells`; every
//! section is load-bearing, especially §4/§5 items 11-15 documenting this
//! file's own intricate `Map`/array mutation and ordering chronology).
//!
//! # Reused (GREEN) modules — never duplicated here
//!
//! - `archive::periodic_cells::{enumerate_intrinsic_periodic_cells,
//!   enumerate_intrinsic_periodic_cell_crops,
//!   compare_intrinsic_periodic_seed_envelope_area_first,
//!   non_dominated_intrinsic_periodic_seeds, rank_intrinsic_periodic_seeds,
//!   select_intrinsic_periodic_seed_front, IntrinsicPeriodicCatalog,
//!   IntrinsicPeriodicBasisProvenance, IntrinsicPeriodicSeed, ...}` — the
//!   sibling catalog/crop/seed-ranking module this file only ever calls.
//! - `search::strict_decoder::{construct_intrinsic_strict_state,
//!   finalize_intrinsic_strict_state, rank_intrinsic_strict_completed_layouts,
//!   intrinsic_strict_phase_coverage_complete, ...}` — the unchanged strict
//!   decoder and archive ranking.
//! - `search::strict_family::group_intrinsic_collision_families` — family
//!   discovery (`intrinsicStrictFamilyPortfolio.js` import in TS).
//! - `canonical_grid::layout::{assert_canonical_grid_legal_layout,
//!   canonical_collision_layout_identity, measure_canonical_layout_envelope,
//!   measure_canonical_layout_topology}` — canonical identity/topology/
//!   envelope measurement for source-audit replay reconstruction.
//! - `checkpoints::canonical_json::{JsValue, intrinsic_periodic_canonical_json,
//!   locale_compare_keys}` — ruling R5's fourth canonical-JSON encoder
//!   (`intrinsicPeriodicFamilyPortfolio.ts`'s own bespoke `canonicalJson`,
//!   `localeCompare` key sort, no bigint branch) plus every
//!   `.localeCompare()` call site.
//! - `geometry::hash::sha256_hex` — the `createHash('sha256').update(...)
//!   .digest('hex')` digest primitive.
//! - `js_number::{js_math, number_to_js_string}` — every bare
//!   default-comparator sort/`Math.min`/`Math.max` call site.
//! - `nfp_ifp::{NfpIfpAbortReason, NfpIfpCheckpointPhase, NfpIfpControl,
//!   NfpIfpControlAbortError}` — the cooperative cancellation/deadline
//!   signal this file only ever forwards or classifies, never constructs.
//!
//! # A seam this file introduces (documented, not silently invented)
//!
//! - **`timing_now: Option<&'a TimingNowFn>`** is a Rust-only injectable
//!   clock seam, following the exact precedent
//!   `archive::reconstruction`'s own top-doc documents: the TS function has
//!   no such seam (it calls the real global `performance.now()` directly and
//!   does not pass a `timingNow` field into its own
//!   `constructIntrinsicStrictState` calls either, so that callee falls back
//!   to the same real global clock in production) — this port threads one
//!   injected clock through both this file's own portfolio-level wall-clock
//!   checks and the `construct_intrinsic_strict_state` calls it makes,
//!   behaviorally identical to production's single shared clock while
//!   making deadline/global-deadline branches deterministically testable.
//!   `periodic_cells`'s own `maximumRuntimeMs` catalog/crop-enumeration
//!   deadline checks are untouched (that file has no seam either, matching
//!   its own TS source) — only this file's layer gains one.
//!
//! # `PortfolioControl`: a concrete, `Sized` `NfpIfpControl` wrapper
//!
//! Every call site that needs `Option<&mut dyn NfpIfpControl>` **by value**
//! inside a loop (`ConstructIntrinsicStrictStateInput::control`,
//! `enumerate_intrinsic_periodic_cell_crops`'s `control` parameter,
//! `PeriodicRunContext::control`) reborrows the single concrete
//! [`PortfolioControl`] local (`Some(&mut control)`) rather than repeatedly
//! reborrowing the original `Option<&mut dyn NfpIfpControl>` itself — the
//! latter hits a known rustc limitation reborrowing `&mut dyn Trait` across
//! sequential loop iterations (observed as real compile failures elsewhere
//! in this crate). This is the identical, already-proven pattern
//! `archive::reconstruction::ReconstructionControl` establishes; see that
//! type's own doc comment for the full rationale. `PortfolioControl::checkpoint`
//! is a no-op success when its own `inner` is `None`, exactly mirroring TS's
//! `control?.checkpoint(...) ?? Effect.void` — so passing `Some(&mut
//! control)` everywhere is unconditionally correct regardless of whether a
//! real control was supplied, with no conditional-spread logic needed at any
//! call site.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::archive::periodic_cells::{
    compare_intrinsic_periodic_seed_envelope_area_first, enumerate_intrinsic_periodic_cell_crops,
    enumerate_intrinsic_periodic_cells, non_dominated_intrinsic_periodic_seeds,
    rank_intrinsic_periodic_seeds, select_intrinsic_periodic_seed_front, IntrinsicPeriodicAxis,
    IntrinsicPeriodicBasisProvenance, IntrinsicPeriodicBasisSourceKind, IntrinsicPeriodicCatalog,
    IntrinsicPeriodicCatalogOptions, IntrinsicPeriodicCell, IntrinsicPeriodicCropProvenance,
    IntrinsicPeriodicError, IntrinsicPeriodicExactEnvelope, IntrinsicPeriodicRole,
    IntrinsicPeriodicSeed, PeriodicRunContext,
};
use crate::caches::GeometryCacheStore;
use crate::canonical_grid::layout::{
    assert_canonical_grid_legal_layout, canonical_collision_layout_identity,
    measure_canonical_layout_envelope, measure_canonical_layout_topology,
};
use crate::checkpoints::canonical_json::{
    intrinsic_periodic_canonical_json, locale_compare_keys, JsValue,
};
use crate::domain::{
    IrregularNestingSettings, IrregularPlacedPiece, IrregularPlacement, IrregularPreparedPiece,
    IrregularTransform, PieceId, SheetSpec,
};
use crate::geometry::hash::sha256_hex;
use crate::js_number::js_math;
use crate::nfp_ifp::{
    NfpIfpAbortReason, NfpIfpCheckpointPhase, NfpIfpControl, NfpIfpControlAbortError,
};
use crate::search::strict_decoder::{
    construct_intrinsic_strict_state, finalize_intrinsic_strict_state,
    intrinsic_strict_phase_coverage_complete, rank_intrinsic_strict_completed_layouts,
    ConstructIntrinsicStrictStateInput, IntrinsicStrictCandidateMode,
    IntrinsicStrictCandidateStatePhaseTimings, IntrinsicStrictComparatorMode,
    IntrinsicStrictCompletedMetrics, IntrinsicStrictConstructResult, IntrinsicStrictDecodeResult,
    IntrinsicStrictDecodeStatus, IntrinsicStrictDecoderError, IntrinsicStrictDecoderFailure,
    StatePlacementPhaseTimingsDisplay, TruncationReason,
};
use crate::search::strict_family::group_intrinsic_collision_families;
use crate::validation::placement::IrregularGeometryInputError;

// ===========================================================================
// `timingNow` seam (Rust-only addition; see module doc).
// ===========================================================================

pub type TimingNowFn = dyn Fn() -> f64;

static PROCESS_START: LazyLock<Instant> = LazyLock::new(Instant::now);

fn default_timing_now() -> f64 {
    PROCESS_START.elapsed().as_secs_f64() * 1000.0
}

// ===========================================================================
// `PortfolioControl` (see module doc).
// ===========================================================================

struct PortfolioControl<'a> {
    inner: Option<&'a mut dyn NfpIfpControl>,
}

impl NfpIfpControl for PortfolioControl<'_> {
    fn checkpoint(&mut self, phase: NfpIfpCheckpointPhase) -> Result<(), NfpIfpControlAbortError> {
        match self.inner.as_deref_mut() {
            None => Ok(()),
            Some(control) => control.checkpoint(phase),
        }
    }
}

fn checkpoint(control: &mut PortfolioControl<'_>) -> Result<(), NfpIfpControlAbortError> {
    control.checkpoint(NfpIfpCheckpointPhase::CandidatePoints)
}

// ===========================================================================
// A minimal insertion-order-preserving map mirroring JS `Map` semantics
// (own copy; see `periodic_cells`'s identically-named private type, which
// cannot be imported across the module-privacy boundary).
// ===========================================================================

struct OrderedMap<T> {
    order: Vec<String>,
    index: HashMap<String, usize>,
    values: Vec<T>,
}

impl<T> OrderedMap<T> {
    fn new() -> Self {
        Self {
            order: Vec::new(),
            index: HashMap::new(),
            values: Vec::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&T> {
        self.index.get(key).map(|&index| &self.values[index])
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut T> {
        match self.index.get(key) {
            Some(&index) => Some(&mut self.values[index]),
            None => None,
        }
    }

    fn set(&mut self, key: String, value: T) {
        if let Some(&index) = self.index.get(&key) {
            self.values[index] = value;
        } else {
            self.index.insert(key.clone(), self.values.len());
            self.order.push(key);
            self.values.push(value);
        }
    }

    fn get_or_insert_with(&mut self, key: &str, make: impl FnOnce() -> T) -> &mut T {
        if !self.index.contains_key(key) {
            self.set(key.to_string(), make());
        }
        self.get_mut(key).expect("just inserted")
    }
}

impl<T: Clone> OrderedMap<T> {
    fn entries(&self) -> Vec<(String, T)> {
        self.order
            .iter()
            .map(|key| (key.clone(), self.get(key).expect("key present").clone()))
            .collect()
    }
}

// ===========================================================================
// `preparedPieceId`/`placementPieceId` (own copies; see `periodic_cells`'s
// `prepared_piece_id`, not importable across the privacy boundary).
// ===========================================================================

fn prepared_piece_id(piece: &IrregularPreparedPiece) -> PieceId {
    piece
        .piece_id
        .clone()
        .unwrap_or_else(|| piece.source.id.clone())
}

fn placement_piece_id(placement: &IrregularPlacement) -> PieceId {
    placement
        .piece_id
        .clone()
        .unwrap_or_else(|| placement.source_piece_id.clone())
}

// ===========================================================================
// Error taxonomy. `PortfolioError = IntrinsicStrictDecoderError |
// IrregularNestingNotImplementedError | IrregularGeometryInputError |
// IrregularNfpIfpControlAbortError` (`PORTFOLIO:220-224`), minus the DI-only
// second arm -- see `periodic_cells`'s own module doc for the established
// convention this follows.
// ===========================================================================

#[derive(Clone, Debug, PartialEq)]
pub enum IntrinsicPeriodicPortfolioError {
    Decoder(IntrinsicStrictDecoderError),
    Geometry(IrregularGeometryInputError),
    Abort(NfpIfpControlAbortError),
}

impl From<IntrinsicPeriodicError> for IntrinsicPeriodicPortfolioError {
    fn from(value: IntrinsicPeriodicError) -> Self {
        match value {
            IntrinsicPeriodicError::Geometry(g) => Self::Geometry(g),
            IntrinsicPeriodicError::Abort(a) => Self::Abort(a),
        }
    }
}

impl From<IntrinsicStrictDecoderFailure> for IntrinsicPeriodicPortfolioError {
    fn from(value: IntrinsicStrictDecoderFailure) -> Self {
        match value {
            IntrinsicStrictDecoderFailure::Decoder(d) => Self::Decoder(d),
            IntrinsicStrictDecoderFailure::Geometry(g) => Self::Geometry(g),
            IntrinsicStrictDecoderFailure::Abort(a) => Self::Abort(a),
        }
    }
}

impl From<IrregularGeometryInputError> for IntrinsicPeriodicPortfolioError {
    fn from(value: IrregularGeometryInputError) -> Self {
        Self::Geometry(value)
    }
}

impl From<IntrinsicStrictDecoderError> for IntrinsicPeriodicPortfolioError {
    fn from(value: IntrinsicStrictDecoderError) -> Self {
        Self::Decoder(value)
    }
}

impl From<NfpIfpControlAbortError> for IntrinsicPeriodicPortfolioError {
    fn from(value: NfpIfpControlAbortError) -> Self {
        Self::Abort(value)
    }
}

/// TS `_tag` of whichever error variant `constructed.error` carries
/// (`PORTFOLIO:349`, `constructed.error._tag`) -- used verbatim as the
/// `IntrinsicPeriodicContinuationResult::reason` string.
fn strict_failure_tag(error: &IntrinsicStrictDecoderFailure) -> &'static str {
    match error {
        IntrinsicStrictDecoderFailure::Decoder(_) => "IntrinsicStrictDecoderError",
        IntrinsicStrictDecoderFailure::Geometry(_) => "IrregularGeometryInputError",
        IntrinsicStrictDecoderFailure::Abort(_) => "IrregularNfpIfpControlAbortError",
    }
}

// ===========================================================================
// Public output types (`PORTFOLIO:48-224`).
// ===========================================================================

/// TS: `PORTFOLIO:48-55` `IntrinsicPeriodicContinuation`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicPeriodicContinuation {
    pub source_id: String,
    pub role: IntrinsicPeriodicRole,
    pub family_key: String,
    pub cell_key: String,
    pub basis_source_key: Option<String>,
    pub seed: IntrinsicPeriodicSeed,
}

/// TS: `PORTFOLIO:157-168` `IntrinsicStrictDecodeResult['status']`, plus this
/// file's four extra soft statuses (`PORTFOLIO:59-64`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntrinsicPeriodicContinuationStatus {
    Completed,
    Incomplete,
    InfeasibleFinalSheet,
    Invalid,
    Deadline,
    GlobalDeadline,
    EvaluationCap,
}

fn map_decode_status(status: IntrinsicStrictDecodeStatus) -> IntrinsicPeriodicContinuationStatus {
    match status {
        IntrinsicStrictDecodeStatus::Completed => IntrinsicPeriodicContinuationStatus::Completed,
        IntrinsicStrictDecodeStatus::Incomplete => IntrinsicPeriodicContinuationStatus::Incomplete,
        IntrinsicStrictDecodeStatus::InfeasibleFinalSheet => {
            IntrinsicPeriodicContinuationStatus::InfeasibleFinalSheet
        }
    }
}

/// TS: `PORTFOLIO:57-69` `IntrinsicPeriodicContinuationResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicPeriodicContinuationResult {
    pub continuation: IntrinsicPeriodicContinuation,
    pub status: IntrinsicPeriodicContinuationStatus,
    pub result: Option<IntrinsicStrictDecodeResult>,
    pub constructed: Option<IntrinsicStrictConstructResult>,
    pub reason: Option<String>,
    pub runtime_ms: f64,
}

/// TS: `PORTFOLIO:73` `IntrinsicPeriodicContinuationOmission['reason']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntrinsicPeriodicContinuationOmissionReason {
    InsufficientSeed,
    DuplicateCanonicalSeed,
    ContinuationCap,
}

/// TS: `PORTFOLIO:71-74` `IntrinsicPeriodicContinuationOmission`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicPeriodicContinuationOmission {
    pub source_id: String,
    pub reason: IntrinsicPeriodicContinuationOmissionReason,
}

/// TS: `PORTFOLIO:77-87` `IntrinsicPeriodicSourceCropSurvival`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicSourceCropSurvival {
    pub role: IntrinsicPeriodicRole,
    pub source_key: String,
    pub source_kind: IntrinsicPeriodicBasisSourceKind,
    pub retained_cell_count: f64,
    pub direct_valid_crop_count_before_front: f64,
    pub direct_valid_crop_count: f64,
    pub crop_front_count: f64,
    pub unique_seed_count: f64,
    pub selected_continuation_count: f64,
}

/// Mutable accumulator mirroring the TS `sourceCropSurvival` map entry shape
/// (`PORTFOLIO:649-667`); converted to the immutable, `pub`
/// [`IntrinsicPeriodicSourceCropSurvival`] only when read out.
#[derive(Clone, Debug)]
struct SourceCropSurvivalAccum {
    role: IntrinsicPeriodicRole,
    source_key: String,
    source_kind: IntrinsicPeriodicBasisSourceKind,
    retained_cell_count: f64,
    direct_valid_crop_count_before_front: f64,
    direct_valid_crop_count: f64,
    crop_front_count: f64,
    unique_seed_count: f64,
    selected_continuation_count: f64,
}

impl From<&SourceCropSurvivalAccum> for IntrinsicPeriodicSourceCropSurvival {
    fn from(value: &SourceCropSurvivalAccum) -> Self {
        Self {
            role: value.role,
            source_key: value.source_key.clone(),
            source_kind: value.source_kind,
            retained_cell_count: value.retained_cell_count,
            direct_valid_crop_count_before_front: value.direct_valid_crop_count_before_front,
            direct_valid_crop_count: value.direct_valid_crop_count,
            crop_front_count: value.crop_front_count,
            unique_seed_count: value.unique_seed_count,
            selected_continuation_count: value.selected_continuation_count,
        }
    }
}

/// TS: `PORTFOLIO:99-110` the `Pick<IntrinsicPeriodicSeed, ...>` inline type.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicSourceAuditWitnessSeed {
    pub canonical_key: String,
    pub component_count: f64,
    pub isolated_piece_count: f64,
    pub largest_component_size: f64,
    pub maximum_side_mm: f64,
    pub envelope_area_mm2: f64,
    pub envelope_span_mm: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_envelope: Option<IntrinsicPeriodicExactEnvelope>,
    pub crop: IntrinsicPeriodicCropProvenance,
}

fn source_audit_witness_seed(
    seed: &IntrinsicPeriodicSeed,
) -> IntrinsicPeriodicSourceAuditWitnessSeed {
    IntrinsicPeriodicSourceAuditWitnessSeed {
        canonical_key: seed.canonical_key.clone(),
        component_count: seed.component_count,
        isolated_piece_count: seed.isolated_piece_count,
        largest_component_size: seed.largest_component_size,
        maximum_side_mm: seed.maximum_side_mm,
        envelope_area_mm2: seed.envelope_area_mm2,
        envelope_span_mm: seed.envelope_span_mm,
        exact_envelope: seed.exact_envelope.clone(),
        crop: seed.crop,
    }
}

/// TS: `PORTFOLIO:90-111` `IntrinsicPeriodicSourceAuditWitness`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicSourceAuditWitness {
    pub role: IntrinsicPeriodicRole,
    pub family_key: String,
    pub source_key: String,
    pub source_kind: IntrinsicPeriodicBasisSourceKind,
    pub cell_key: String,
    pub basis_provenance: IntrinsicPeriodicBasisProvenance,
    pub placements: Vec<IrregularPlacedPiece>,
    pub seed: IntrinsicPeriodicSourceAuditWitnessSeed,
}

/// TS: `PORTFOLIO:113-117` `IntrinsicPeriodicSourceAuditReplay`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicSourceAuditReplay {
    pub witnesses: Vec<IntrinsicPeriodicSourceAuditWitness>,
    pub non_dominated_crop_count: f64,
    pub source_crop_survival: Vec<IntrinsicPeriodicSourceCropSurvival>,
}

/// TS: `PORTFOLIO:119` `IntrinsicPeriodicSourceAuditScope`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntrinsicPeriodicSourceAuditScope {
    #[default]
    All,
    P2AxisUnion,
}

/// TS: `PORTFOLIO:121-130` `IntrinsicPeriodicSourceAuditReplayEnvelope`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicSourceAuditReplayEnvelope {
    pub format_version: f64,
    pub algorithm_version: String,
    pub scope: IntrinsicPeriodicSourceAuditScope,
    pub basis_source_key: Option<String>,
    pub prepared_input_digest: String,
    pub eligible_source_domain_digest: String,
    pub replay_digest: String,
    pub replay: IntrinsicPeriodicSourceAuditReplay,
}

pub const REPLAY_FORMAT_VERSION: f64 = 3.0;
pub const REPLAY_ALGORITHM_VERSION: &str = "intrinsic-periodic-source-audit-v3";

/// TS: `PORTFOLIO:506-525` `MutableCandidateStatePhaseTimings`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct MutableCandidateStatePhaseTimings {
    placement_object_ms: f64,
    state_placement_ms: f64,
    state_placement: StatePlacement,
    bottom_left_anchoring_ms: f64,
    envelope_scoring_ms: f64,
    gap_classification_ms: f64,
    score_bookkeeping_ms: f64,
    candidate_selection_ms: f64,
    bookkeeping_ms: f64,
    coverage_complete: bool,
    total_ms: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct StatePlacement {
    canonical_entry_key_ms: f64,
    spatial_index_ms: f64,
    contact_measurement_ms: f64,
    state_assembly_ms: f64,
    bookkeeping_ms: f64,
    total_ms: f64,
}

fn empty_candidate_state_phase_timings() -> MutableCandidateStatePhaseTimings {
    MutableCandidateStatePhaseTimings {
        placement_object_ms: 0.0,
        state_placement_ms: 0.0,
        state_placement: StatePlacement {
            canonical_entry_key_ms: 0.0,
            spatial_index_ms: 0.0,
            contact_measurement_ms: 0.0,
            state_assembly_ms: 0.0,
            bookkeeping_ms: 0.0,
            total_ms: 0.0,
        },
        bottom_left_anchoring_ms: 0.0,
        envelope_scoring_ms: 0.0,
        gap_classification_ms: 0.0,
        score_bookkeeping_ms: 0.0,
        candidate_selection_ms: 0.0,
        bookkeeping_ms: 0.0,
        coverage_complete: true,
        total_ms: 0.0,
    }
}

fn add_candidate_state_phase_timings(
    target: &mut MutableCandidateStatePhaseTimings,
    source: &IntrinsicStrictCandidateStatePhaseTimings,
) {
    target.placement_object_ms += source.placement_object_ms;
    target.state_placement_ms += source.state_placement_ms;
    target.state_placement.canonical_entry_key_ms += source.state_placement.canonical_entry_key_ms;
    target.state_placement.spatial_index_ms += source.state_placement.spatial_index_ms;
    target.state_placement.contact_measurement_ms += source.state_placement.contact_measurement_ms;
    target.state_placement.state_assembly_ms += source.state_placement.state_assembly_ms;
    target.state_placement.bookkeeping_ms += source.state_placement.bookkeeping_ms;
    target.state_placement.total_ms += source.state_placement.total_ms;
    target.bottom_left_anchoring_ms += source.bottom_left_anchoring_ms;
    target.envelope_scoring_ms += source.envelope_scoring_ms;
    target.gap_classification_ms += source.gap_classification_ms;
    target.score_bookkeeping_ms += source.score_bookkeeping_ms;
    target.candidate_selection_ms += source.candidate_selection_ms;
    target.bookkeeping_ms += source.bookkeeping_ms;
    target.coverage_complete = target.coverage_complete && source.coverage_complete;
    target.total_ms += source.total_ms;
}

fn freeze_candidate_state_phase_timings(
    timings: &MutableCandidateStatePhaseTimings,
) -> IntrinsicStrictCandidateStatePhaseTimings {
    IntrinsicStrictCandidateStatePhaseTimings {
        placement_object_ms: timings.placement_object_ms,
        state_placement_ms: timings.state_placement_ms,
        state_placement: StatePlacementPhaseTimingsDisplay {
            canonical_entry_key_ms: timings.state_placement.canonical_entry_key_ms,
            spatial_index_ms: timings.state_placement.spatial_index_ms,
            contact_measurement_ms: timings.state_placement.contact_measurement_ms,
            state_assembly_ms: timings.state_placement.state_assembly_ms,
            bookkeeping_ms: timings.state_placement.bookkeeping_ms,
            total_ms: timings.state_placement.total_ms,
        },
        bottom_left_anchoring_ms: timings.bottom_left_anchoring_ms,
        envelope_scoring_ms: timings.envelope_scoring_ms,
        gap_classification_ms: timings.gap_classification_ms,
        score_bookkeeping_ms: timings.score_bookkeeping_ms,
        candidate_selection_ms: timings.candidate_selection_ms,
        bookkeeping_ms: timings.bookkeeping_ms,
        coverage_complete: timings.coverage_complete,
        total_ms: timings.total_ms,
    }
}

/// TS: `PORTFOLIO:153-168` `IntrinsicPeriodicPortfolioPhaseTimings['selection']`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicPeriodicSelectionPhaseTimings {
    pub source_audit_crop_enumeration_ms: f64,
    pub retained_crop_enumeration_ms: f64,
    pub crop_front_selection_ms: f64,
    pub source_audit_logical_crop_attempt_count: f64,
    pub source_audit_physical_crop_attempt_count: f64,
    pub source_audit_unique_canonical_cell_count: f64,
    pub source_audit_canonical_cell_replay_count: f64,
    pub source_audit_replay_witness_count: f64,
    pub bookkeeping_ms: f64,
    pub coverage_complete: bool,
    pub total_ms: f64,
}

/// TS: `PORTFOLIO:170-180` `IntrinsicPeriodicPortfolioPhaseTimings['construction']`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicPeriodicConstructionPhaseTimings {
    pub candidate_generation_ms: f64,
    pub candidate_state_scoring_ms: f64,
    pub candidate_state_scoring: IntrinsicStrictCandidateStatePhaseTimings,
    pub bookkeeping_ms: f64,
    pub measured_run_count: f64,
    pub expected_run_count: f64,
    pub coverage_complete: bool,
    pub total_ms: f64,
}

/// TS: `PORTFOLIO:153-186` `IntrinsicPeriodicPortfolioPhaseTimings`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicPeriodicPortfolioPhaseTimings {
    pub catalog_ms: f64,
    pub selection_ms: f64,
    pub selection: IntrinsicPeriodicSelectionPhaseTimings,
    pub execution_ordering_ms: f64,
    pub construction_ms: f64,
    pub construction: IntrinsicPeriodicConstructionPhaseTimings,
    pub finalization_ms: f64,
    pub archive_ranking_ms: f64,
    pub bookkeeping_ms: f64,
    pub coverage_complete: bool,
    pub total_ms: f64,
}

/// TS: `PORTFOLIO:188-218` `IntrinsicPeriodicFamilyPortfolioOptions`.
pub struct IntrinsicPeriodicFamilyPortfolioOptions<'a> {
    pub maximum_catalog_runtime_ms: f64,
    pub maximum_cells_per_family_role: usize,
    pub maximum_crops_per_cell: usize,
    pub maximum_continuation_runtime_ms: f64,
    pub maximum_continuation_candidate_evaluations: Option<f64>,
    pub maximum_continuation_count: usize,
    pub maximum_total_runtime_ms: f64,
    pub capture_phase_timings: bool,
    pub basis_source_key: Option<String>,
    pub capture_source_survival_audit: bool,
    pub capture_source_audit_replay_envelope: bool,
    pub admit_source_audit_witnesses: bool,
    pub source_audit_replay_envelope: Option<IntrinsicPeriodicSourceAuditReplayEnvelope>,
    pub expected_source_audit_replay_digest: Option<String>,
    pub source_audit_scope: IntrinsicPeriodicSourceAuditScope,
    pub control: Option<&'a mut dyn NfpIfpControl>,
    pub timing_now: Option<&'a TimingNowFn>,
}

impl Default for IntrinsicPeriodicFamilyPortfolioOptions<'_> {
    fn default() -> Self {
        Self {
            maximum_catalog_runtime_ms: 15_000.0,
            maximum_cells_per_family_role: 16,
            maximum_crops_per_cell: 4,
            maximum_continuation_runtime_ms: 25_000.0,
            maximum_continuation_candidate_evaluations: None,
            maximum_continuation_count: 8,
            maximum_total_runtime_ms: 240_000.0,
            capture_phase_timings: false,
            basis_source_key: None,
            capture_source_survival_audit: false,
            capture_source_audit_replay_envelope: false,
            admit_source_audit_witnesses: false,
            source_audit_replay_envelope: None,
            expected_source_audit_replay_digest: None,
            source_audit_scope: IntrinsicPeriodicSourceAuditScope::All,
            control: None,
            timing_now: None,
        }
    }
}

/// TS: `PORTFOLIO:132-151` `IntrinsicPeriodicFamilyPortfolioResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicPeriodicFamilyPortfolioResult {
    pub catalog: IntrinsicPeriodicCatalog,
    pub continuations: Vec<IntrinsicPeriodicContinuation>,
    pub continuation_omissions: Vec<IntrinsicPeriodicContinuationOmission>,
    pub continuation_coverage_complete: bool,
    pub continuation_execution_coverage_complete: bool,
    pub continuation_budget_settlement_complete: bool,
    pub source_crop_survival: Vec<IntrinsicPeriodicSourceCropSurvival>,
    pub source_audit_witnesses: Vec<IntrinsicPeriodicSourceAuditWitness>,
    pub source_audit_non_dominated_crop_count: f64,
    pub source_audit_replay_accepted: bool,
    pub source_audit_replay_validation_crop_attempt_count: f64,
    pub source_audit_replay_rejection_reason: Option<String>,
    pub source_audit_replay_envelope: Option<IntrinsicPeriodicSourceAuditReplayEnvelope>,
    pub runs: Vec<IntrinsicPeriodicContinuationResult>,
    pub archive: Vec<IntrinsicStrictCompletedMetrics>,
    pub winner: Option<IntrinsicPeriodicContinuationResult>,
    pub phase_timings: Option<IntrinsicPeriodicPortfolioPhaseTimings>,
    pub runtime_ms: f64,
}

// ===========================================================================
// `orderPeriodicContinuationsForExecution` / `continuationsForExecution`
// (`PORTFOLIO:582-601`).
// ===========================================================================

/// TS: `orderPeriodicContinuationsForExecution` (`PORTFOLIO:582-591`).
pub fn order_periodic_continuations_for_execution(
    continuations: &[IntrinsicPeriodicContinuation],
) -> Vec<IntrinsicPeriodicContinuation> {
    let mut ordered: Vec<IntrinsicPeriodicContinuation> = continuations.to_vec();
    ordered.sort_by(|first, second| {
        compare_intrinsic_periodic_seed_envelope_area_first(&first.seed, &second.seed)
            .then_with(|| {
                let diff = second.seed.placements.len() as f64 - first.seed.placements.len() as f64;
                if diff < 0.0 {
                    Ordering::Less
                } else if diff > 0.0 {
                    Ordering::Greater
                } else {
                    Ordering::Equal
                }
            })
            .then_with(|| locale_compare_keys(&first.source_id, &second.source_id))
    });
    ordered
}

/// TS: `continuationsForExecution` (`PORTFOLIO:594-601`).
pub fn continuations_for_execution(
    continuations: Vec<IntrinsicPeriodicContinuation>,
    maximum_candidate_evaluation_count: Option<f64>,
) -> Vec<IntrinsicPeriodicContinuation> {
    match maximum_candidate_evaluation_count {
        None => continuations,
        Some(_) => order_periodic_continuations_for_execution(&continuations),
    }
}

/// TS: `phaseResidualCoverageComplete` (`PORTFOLIO:604-606`).
pub fn phase_residual_coverage_complete(total_ms: f64, residual_ms: f64) -> bool {
    total_ms >= 0.0 && residual_ms >= 0.0 && residual_ms <= total_ms * 0.01
}

// ===========================================================================
// `completeBasisProvenance` / `sourceAuditCellIncluded` (`PORTFOLIO:963-982`).
// ===========================================================================

/// TS: `completeBasisProvenance` (`PORTFOLIO:963-973`).
fn complete_basis_provenance(
    provenance: &IntrinsicPeriodicBasisProvenance,
) -> IntrinsicPeriodicBasisProvenance {
    if provenance.source_kind != IntrinsicPeriodicBasisSourceKind::AxisUnion
        || provenance.axis.is_some()
    {
        return provenance.clone();
    }
    let axis = if provenance.source_key.starts_with("x:") {
        Some(IntrinsicPeriodicAxis::X)
    } else if provenance.source_key.starts_with("y:") {
        Some(IntrinsicPeriodicAxis::Y)
    } else {
        None
    };
    match axis {
        None => provenance.clone(),
        Some(axis) => {
            let mut updated = provenance.clone();
            updated.axis = Some(axis);
            updated
        }
    }
}

/// TS: `sourceAuditCellIncluded` (`PORTFOLIO:975-982`).
fn source_audit_cell_included(
    cell: &IntrinsicPeriodicCell,
    scope: IntrinsicPeriodicSourceAuditScope,
) -> bool {
    scope == IntrinsicPeriodicSourceAuditScope::All
        || (cell.role == IntrinsicPeriodicRole::P2
            && cell
                .basis_provenance
                .as_ref()
                .map(|provenance| {
                    provenance.source_kind == IntrinsicPeriodicBasisSourceKind::AxisUnion
                })
                .unwrap_or(false))
}

// ===========================================================================
// `canonicalJson`-based digests (`PORTFOLIO:984-1293`).
// ===========================================================================

/// See `capacity::search::json_value_to_js_value`'s own doc comment (this
/// module's own private, structurally-identical copy: `serde_json` reuse for
/// this file's whole-domain-class digest fields).
fn json_value_to_js_value(value: &serde_json::Value) -> JsValue {
    match value {
        serde_json::Value::Null => JsValue::Null,
        serde_json::Value::Bool(b) => JsValue::Bool(*b),
        serde_json::Value::Number(n) => JsValue::Num(
            n.as_f64()
                .expect("JSON numbers from domain structs are always finite"),
        ),
        serde_json::Value::String(s) => JsValue::Str(s.clone()),
        serde_json::Value::Array(items) => {
            JsValue::Arr(items.iter().map(json_value_to_js_value).collect())
        }
        serde_json::Value::Object(fields) => JsValue::Obj(
            fields
                .iter()
                .map(|(k, v)| (k.clone(), json_value_to_js_value(v)))
                .collect(),
        ),
    }
}

/// TS: `canonicalJson` (`PORTFOLIO:1285-1293`), applied to any `Serialize`
/// Rust value via a `serde_json::Value` bridge (see [`json_value_to_js_value`]).
fn canonical_json_of<T: Serialize>(value: &T) -> String {
    let json_value = serde_json::to_value(value).expect("domain structs always serialize");
    intrinsic_periodic_canonical_json(&json_value_to_js_value(&json_value))
        .expect("a concrete serialized struct is never JsValue::Undefined")
}

/// TS: `sha256` (`PORTFOLIO:1281-1283`).
fn sha256(value: &str) -> String {
    sha256_hex(value)
}

fn source_audit_prepared_input_digest(pieces: &[IrregularPreparedPiece]) -> String {
    sha256(&canonical_json_of(&pieces.to_vec()))
}

/// TS: `EligibleSourceDomainEntry` (`PORTFOLIO:984-990`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EligibleSourceDomainEntry {
    family_key: String,
    role: IntrinsicPeriodicRole,
    source_key: String,
    source_kind: IntrinsicPeriodicBasisSourceKind,
    cell_key: String,
}

/// TS: `eligibleSourceDomainEntries` (`PORTFOLIO:1221-1248`).
fn eligible_source_domain_entries(
    catalog: &IntrinsicPeriodicCatalog,
    scope: IntrinsicPeriodicSourceAuditScope,
    basis_source_key: Option<&str>,
) -> Vec<EligibleSourceDomainEntry> {
    let mut entries: Vec<EligibleSourceDomainEntry> = Vec::new();
    for family in &catalog.families {
        let cells = family.source_audit_cells.as_ref().unwrap_or(&family.cells);
        for cell in cells {
            let Some(provenance) = cell.basis_provenance.as_ref() else {
                continue;
            };
            if !source_audit_cell_included(cell, scope) {
                continue;
            }
            if let Some(basis_source_key) = basis_source_key {
                if provenance.source_key != basis_source_key {
                    continue;
                }
            }
            entries.push(EligibleSourceDomainEntry {
                family_key: family.family_key.clone(),
                role: cell.role,
                source_key: provenance.source_key.clone(),
                source_kind: provenance.source_kind,
                cell_key: cell.canonical_key.clone(),
            });
        }
    }
    entries.sort_by(|first, second| {
        locale_compare_keys(
            &eligible_source_domain_entry_key(first),
            &eligible_source_domain_entry_key(second),
        )
    });
    entries
}

/// TS: `eligibleSourceDomainEntryKey` (`PORTFOLIO:1250-1258`). Plain
/// `JSON.stringify` over a fixed-shape string tuple (not `canonicalJson`).
fn eligible_source_domain_entry_key(entry: &EligibleSourceDomainEntry) -> String {
    serde_json::to_string(&[
        entry.family_key.as_str(),
        entry.role.as_str(),
        entry.source_key.as_str(),
        entry.source_kind.as_str(),
        entry.cell_key.as_str(),
    ])
    .expect("string array always serializes")
}

/// TS: `sourceAuditSurvivalKey` (`PORTFOLIO:1260-1266`).
fn source_audit_survival_key(
    role: IntrinsicPeriodicRole,
    source_key: &str,
    source_kind: IntrinsicPeriodicBasisSourceKind,
) -> String {
    serde_json::to_string(&[role.as_str(), source_key, source_kind.as_str()])
        .expect("string array always serializes")
}

/// TS: `sourceAuditSurvivalCountsValid` (`PORTFOLIO:1268-1279`).
fn source_audit_survival_counts_valid(survival: &IntrinsicPeriodicSourceCropSurvival) -> bool {
    [
        survival.retained_cell_count,
        survival.direct_valid_crop_count_before_front,
        survival.direct_valid_crop_count,
        survival.crop_front_count,
        survival.unique_seed_count,
        survival.selected_continuation_count,
    ]
    .iter()
    .all(|&value| crate::js_number::is_safe_integer(value) && value >= 0.0)
}

fn source_audit_eligible_domain_digest(
    catalog: &IntrinsicPeriodicCatalog,
    scope: IntrinsicPeriodicSourceAuditScope,
    basis_source_key: Option<&str>,
) -> String {
    sha256(&canonical_json_of(&eligible_source_domain_entries(
        catalog,
        scope,
        basis_source_key,
    )))
}

fn source_audit_replay_digest(replay: &IntrinsicPeriodicSourceAuditReplay) -> String {
    sha256(&canonical_json_of(replay))
}

/// TS: `makeSourceAuditReplayEnvelope` (`PORTFOLIO:992-1009`).
fn make_source_audit_replay_envelope(
    catalog: &IntrinsicPeriodicCatalog,
    pieces: &[IrregularPreparedPiece],
    scope: IntrinsicPeriodicSourceAuditScope,
    basis_source_key: Option<&str>,
    replay: IntrinsicPeriodicSourceAuditReplay,
) -> IntrinsicPeriodicSourceAuditReplayEnvelope {
    IntrinsicPeriodicSourceAuditReplayEnvelope {
        format_version: REPLAY_FORMAT_VERSION,
        algorithm_version: REPLAY_ALGORITHM_VERSION.to_string(),
        scope,
        basis_source_key: basis_source_key.map(|value| value.to_string()),
        prepared_input_digest: source_audit_prepared_input_digest(pieces),
        eligible_source_domain_digest: source_audit_eligible_domain_digest(
            catalog,
            scope,
            basis_source_key,
        ),
        replay_digest: source_audit_replay_digest(&replay),
        replay,
    }
}

// ===========================================================================
// Source-audit replay reconstruction/validation (`PORTFOLIO:1295-1432`).
// ===========================================================================

fn invalid_replay(message: &str) -> IrregularGeometryInputError {
    IrregularGeometryInputError {
        operation: "intrinsicPeriodicSourceAuditReplay".to_string(),
        message: message.to_string(),
    }
}

/// TS: `placedEnvelopeBounds` (`PORTFOLIO:1366-1382`).
fn placed_envelope_bounds(placed: &[IrregularPlacedPiece]) -> (f64, f64) {
    let points: Vec<(f64, f64)> = placed
        .iter()
        .flat_map(|item| {
            item.collision_geometry.polygon.points.iter().map(|point| {
                (
                    point.x + item.placement.transform.translate_x,
                    point.y + item.placement.transform.translate_y,
                )
            })
        })
        .collect();
    let xs: Vec<f64> = points.iter().map(|(x, _)| *x).collect();
    let ys: Vec<f64> = points.iter().map(|(_, y)| *y).collect();
    (
        js_math::max_all(&xs) - js_math::min_all(&xs),
        js_math::max_all(&ys) - js_math::min_all(&ys),
    )
}

/// TS: `canonicalSheetlessLegal` (`PORTFOLIO:1384-1423`).
fn canonical_sheetless_legal(placed: &[IrregularPlacedPiece]) -> bool {
    let points: Vec<(f64, f64)> = placed
        .iter()
        .flat_map(|item| {
            item.collision_geometry.polygon.points.iter().map(|point| {
                (
                    point.x + item.placement.transform.translate_x,
                    point.y + item.placement.transform.translate_y,
                )
            })
        })
        .collect();
    if points.is_empty() {
        return false;
    }
    let xs: Vec<f64> = points.iter().map(|(x, _)| *x).collect();
    let ys: Vec<f64> = points.iter().map(|(_, y)| *y).collect();
    let min_x = js_math::min_all(&xs);
    let min_y = js_math::min_all(&ys);
    let max_x = js_math::max_all(&xs);
    let max_y = js_math::max_all(&ys);
    let normalized: Vec<IrregularPlacedPiece> = placed
        .iter()
        .map(|item| IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: item.placement.piece_id.clone(),
                source_piece_id: item.placement.source_piece_id.clone(),
                placement_reference: item.placement.placement_reference,
                transform: IrregularTransform {
                    translate_x: item.placement.transform.translate_x - min_x,
                    translate_y: item.placement.transform.translate_y - min_y,
                    rotation_deg: item.placement.transform.rotation_deg,
                    mirrored: item.placement.transform.mirrored,
                },
            },
            collision_geometry: item.collision_geometry.clone(),
        })
        .collect();
    let sheet = SheetSpec {
        width: js_math::ceil(max_x - min_x) + 1.0,
        height: js_math::ceil(max_y - min_y) + 1.0,
        label: "source-audit replay validation".to_string(),
    };
    assert_canonical_grid_legal_layout(&sheet, &normalized)
}

/// TS: `validateAndReconstructSourceAuditWitness` (`PORTFOLIO:1295-1364`).
fn validate_and_reconstruct_source_audit_witness(
    witness: &IntrinsicPeriodicSourceAuditWitness,
    family_members: &[IrregularPreparedPiece],
) -> Result<IntrinsicPeriodicSeed, IrregularGeometryInputError> {
    if witness.source_key != witness.basis_provenance.source_key
        || witness.source_kind != witness.basis_provenance.source_kind
    {
        return Err(invalid_replay(
            "source-audit replay provenance does not match its seed",
        ));
    }
    let family_ids: HashSet<PieceId> = family_members.iter().map(prepared_piece_id).collect();
    let mut placed_ids: HashSet<PieceId> = HashSet::new();
    for placed in &witness.placements {
        let piece_id = placement_piece_id(&placed.placement);
        if !family_ids.contains(&piece_id) || placed_ids.contains(&piece_id) {
            return Err(invalid_replay(
                "source-audit replay contains an unknown or duplicate piece",
            ));
        }
        placed_ids.insert(piece_id);
    }
    if !canonical_sheetless_legal(&witness.placements) {
        return Err(invalid_replay(
            "source-audit replay is not canonically sheetless legal",
        ));
    }
    let canonical_key = canonical_collision_layout_identity(&witness.placements);
    let canonical_key = match canonical_key {
        Some(key) if key == witness.seed.canonical_key => key,
        _ => {
            return Err(invalid_replay(
                "source-audit replay canonical identity mismatch",
            ))
        }
    };
    let topology = measure_canonical_layout_topology(&witness.placements);
    match &topology {
        Some(topology)
            if topology.positive_contact_component_count == witness.seed.component_count
                && topology.isolated_piece_count == witness.seed.isolated_piece_count
                && topology.largest_positive_contact_component_size
                    == witness.seed.largest_component_size => {}
        _ => return Err(invalid_replay("source-audit replay topology mismatch")),
    }
    let (width, height) = placed_envelope_bounds(&witness.placements);
    let envelope = measure_canonical_layout_envelope(&witness.placements);
    let envelope_matches = match (envelope, witness.seed.exact_envelope.as_ref()) {
        (Some(envelope), Some(exact)) => {
            envelope.maximum_side_grid == exact.maximum_side_grid
                && envelope.envelope_area_grid2 == exact.area_grid2
                && envelope.span_grid == exact.span_grid
        }
        _ => {
            js_math::max(width, height) == witness.seed.maximum_side_mm
                && width * height == witness.seed.envelope_area_mm2
                && width + height == witness.seed.envelope_span_mm
        }
    };
    if !envelope_matches {
        return Err(invalid_replay(
            "source-audit replay envelope metric mismatch",
        ));
    }
    let remaining_family_members: Vec<IrregularPreparedPiece> = family_members
        .iter()
        .filter(|piece| !placed_ids.contains(&prepared_piece_id(piece)))
        .cloned()
        .collect();
    Ok(IntrinsicPeriodicSeed {
        role: witness.role,
        cell_key: witness.cell_key.clone(),
        placements: witness.placements.clone(),
        remaining_family_members,
        component_count: witness.seed.component_count,
        isolated_piece_count: witness.seed.isolated_piece_count,
        largest_component_size: witness.seed.largest_component_size,
        maximum_side_mm: witness.seed.maximum_side_mm,
        envelope_area_mm2: witness.seed.envelope_area_mm2,
        envelope_span_mm: witness.seed.envelope_span_mm,
        exact_envelope: witness.seed.exact_envelope.clone(),
        crop: witness.seed.crop,
        canonical_key,
    })
}

/// TS: `replayRejected` (`PORTFOLIO:1196-1201`).
struct ValidateReplayOutcome {
    replay: Option<IntrinsicPeriodicSourceAuditReplay>,
    rejection_reason: Option<String>,
    validation_crop_attempt_count: f64,
}

fn replay_rejected(reason: &str) -> ValidateReplayOutcome {
    ValidateReplayOutcome {
        replay: None,
        rejection_reason: Some(reason.to_string()),
        validation_crop_attempt_count: 0.0,
    }
}

/// TS: `validateSourceAuditReplayEnvelope` (`PORTFOLIO:1011-1178`). Error
/// channel is just `IrregularNfpIfpControlAbortError` -- every other
/// failure inside this function is converted into a `ValidateReplayOutcome`
/// rejection rather than propagated (TS's own `Effect.matchEffect`).
#[allow(clippy::too_many_arguments)]
fn validate_source_audit_replay_envelope(
    catalog: &IntrinsicPeriodicCatalog,
    pieces: &[IrregularPreparedPiece],
    scope: IntrinsicPeriodicSourceAuditScope,
    basis_source_key: Option<&str>,
    expected_replay_digest: Option<&str>,
    envelope: Option<&IntrinsicPeriodicSourceAuditReplayEnvelope>,
    control: &mut PortfolioControl<'_>,
) -> Result<ValidateReplayOutcome, NfpIfpControlAbortError> {
    let Some(envelope) = envelope else {
        return Ok(ValidateReplayOutcome {
            replay: None,
            rejection_reason: None,
            validation_crop_attempt_count: 0.0,
        });
    };
    let Some(expected_replay_digest) = expected_replay_digest else {
        return Ok(replay_rejected("expected-replay-digest"));
    };
    if envelope.format_version != REPLAY_FORMAT_VERSION {
        return Ok(replay_rejected("format-version"));
    }
    if envelope.algorithm_version != REPLAY_ALGORITHM_VERSION {
        return Ok(replay_rejected("algorithm-version"));
    }
    if envelope.scope != scope {
        return Ok(replay_rejected("scope"));
    }
    if envelope.basis_source_key.as_deref() != basis_source_key {
        return Ok(replay_rejected("basis-source"));
    }
    if envelope.prepared_input_digest != source_audit_prepared_input_digest(pieces) {
        return Ok(replay_rejected("prepared-input"));
    }
    if envelope.eligible_source_domain_digest
        != source_audit_eligible_domain_digest(catalog, scope, basis_source_key)
    {
        return Ok(replay_rejected("eligible-source-domain"));
    }
    if envelope.replay_digest != source_audit_replay_digest(&envelope.replay) {
        return Ok(replay_rejected("replay-digest"));
    }
    if envelope.replay_digest != expected_replay_digest {
        return Ok(replay_rejected("expected-replay-digest"));
    }
    if envelope.replay.witnesses.len() > 16 {
        return Ok(replay_rejected("witness-cap"));
    }

    let eligible_entries = eligible_source_domain_entries(catalog, scope, basis_source_key);
    let eligible_witnesses: HashSet<String> = eligible_entries
        .iter()
        .map(eligible_source_domain_entry_key)
        .collect();
    let eligible_survival: HashSet<String> = eligible_entries
        .iter()
        .map(|entry| source_audit_survival_key(entry.role, &entry.source_key, entry.source_kind))
        .collect();
    if !crate::js_number::is_safe_integer(envelope.replay.non_dominated_crop_count)
        || envelope.replay.non_dominated_crop_count < 0.0
        || envelope.replay.source_crop_survival.len() > eligible_survival.len()
    {
        return Ok(replay_rejected("non-dominated-count"));
    }
    let mut seen_survival: HashSet<String> = HashSet::new();
    for survival in &envelope.replay.source_crop_survival {
        let key =
            source_audit_survival_key(survival.role, &survival.source_key, survival.source_kind);
        if !eligible_survival.contains(&key)
            || seen_survival.contains(&key)
            || !source_audit_survival_counts_valid(survival)
        {
            return Ok(replay_rejected("source-survival"));
        }
        seen_survival.insert(key);
    }

    let family_members: HashMap<String, Vec<IrregularPreparedPiece>> =
        group_intrinsic_collision_families(pieces)
            .into_iter()
            .map(|family| (family.key, family.members))
            .collect();
    let mut eligible_cells: HashMap<String, &IntrinsicPeriodicCell> = HashMap::new();
    for family in &catalog.families {
        let cells = family.source_audit_cells.as_ref().unwrap_or(&family.cells);
        for cell in cells {
            let Some(provenance) = cell.basis_provenance.as_ref() else {
                continue;
            };
            if !source_audit_cell_included(cell, scope) {
                continue;
            }
            if let Some(basis_source_key) = basis_source_key {
                if provenance.source_key != basis_source_key {
                    continue;
                }
            }
            let key = eligible_source_domain_entry_key(&EligibleSourceDomainEntry {
                family_key: family.family_key.clone(),
                role: cell.role,
                source_key: provenance.source_key.clone(),
                source_kind: provenance.source_kind,
                cell_key: cell.canonical_key.clone(),
            });
            eligible_cells.insert(key, cell);
        }
    }

    let mut reconstructed_crops: HashMap<String, Vec<IntrinsicPeriodicSeed>> = HashMap::new();
    let mut validation_crop_attempt_count = 0.0_f64;
    let mut validated_witnesses: Vec<IntrinsicPeriodicSourceAuditWitness> = Vec::new();
    let mut seen_witnesses: HashSet<String> = HashSet::new();
    for witness in &envelope.replay.witnesses {
        let witness_key = eligible_source_domain_entry_key(&EligibleSourceDomainEntry {
            family_key: witness.family_key.clone(),
            role: witness.role,
            source_key: witness.source_key.clone(),
            source_kind: witness.source_kind,
            cell_key: witness.cell_key.clone(),
        });
        if !eligible_witnesses.contains(&witness_key)
            || seen_witnesses.contains(&witness.seed.canonical_key)
        {
            return Ok(replay_rejected("witness-domain"));
        }
        seen_witnesses.insert(witness.seed.canonical_key.clone());
        let Some(members) = family_members.get(&witness.family_key) else {
            return Ok(replay_rejected("witness-family"));
        };
        let Some(&current_cell) = eligible_cells.get(&witness_key) else {
            return Ok(replay_rejected("witness-cell"));
        };
        if !reconstructed_crops.contains_key(&witness_key) {
            let mut attempt_count = 0.0_f64;
            let mut control_opt: Option<&mut dyn NfpIfpControl> = Some(control);
            let crops = match enumerate_intrinsic_periodic_cell_crops(
                current_cell,
                members,
                &mut || attempt_count += 1.0,
                &mut control_opt,
            ) {
                Ok(crops) => crops,
                Err(IntrinsicPeriodicError::Abort(abort)) => return Err(abort),
                Err(IntrinsicPeriodicError::Geometry(_)) => {
                    return Ok(replay_rejected("witness-crop-reconstruction"))
                }
            };
            validation_crop_attempt_count += attempt_count;
            reconstructed_crops.insert(witness_key.clone(), crops);
        }
        let current_crops = reconstructed_crops
            .get(&witness_key)
            .expect("just inserted");
        let regenerated_seed = current_crops.iter().find(|seed| {
            seed.canonical_key == witness.seed.canonical_key
                && canonical_json_of(&seed.crop) == canonical_json_of(&witness.seed.crop)
        });
        let Some(regenerated_seed) = regenerated_seed else {
            return Ok(replay_rejected("witness-crop"));
        };
        if canonical_json_of(&regenerated_seed.placements) != canonical_json_of(&witness.placements)
            || canonical_json_of(&source_audit_witness_seed(regenerated_seed))
                != canonical_json_of(&witness.seed)
        {
            return Ok(replay_rejected("witness-regenerated-seed"));
        }
        let Some(current_provenance) = current_cell.basis_provenance.as_ref() else {
            return Ok(replay_rejected("witness-provenance"));
        };
        let validated_witness = IntrinsicPeriodicSourceAuditWitness {
            role: current_cell.role,
            family_key: witness.family_key.clone(),
            source_key: current_provenance.source_key.clone(),
            source_kind: current_provenance.source_kind,
            cell_key: current_cell.canonical_key.clone(),
            basis_provenance: current_provenance.clone(),
            placements: regenerated_seed.placements.clone(),
            seed: source_audit_witness_seed(regenerated_seed),
        };
        let valid =
            validate_and_reconstruct_source_audit_witness(&validated_witness, members).is_ok();
        if !valid {
            return Ok(replay_rejected("witness-validation"));
        }
        validated_witnesses.push(validated_witness);
    }
    Ok(ValidateReplayOutcome {
        replay: Some(IntrinsicPeriodicSourceAuditReplay {
            witnesses: validated_witnesses,
            non_dominated_crop_count: envelope.replay.non_dominated_crop_count,
            source_crop_survival: envelope.replay.source_crop_survival.clone(),
        }),
        rejection_reason: None,
        validation_crop_attempt_count,
    })
}

// ===========================================================================
// Continuation identity/ordering helpers (`PORTFOLIO:1434-1472`).
// ===========================================================================

/// TS: `periodicSourceCellKey` (`PORTFOLIO:1434-1436`).
fn periodic_source_cell_key(cell: &IntrinsicPeriodicCell) -> String {
    format!(
        "{}:{}:{}",
        cell.role.as_str(),
        cell.basis_provenance
            .as_ref()
            .map(|p| p.source_key.as_str())
            .unwrap_or("unprovenanced"),
        cell.canonical_key
    )
}

/// TS: `rankContinuations` (`PORTFOLIO:1438-1452`).
fn rank_continuations(
    continuations: Vec<IntrinsicPeriodicContinuation>,
) -> Vec<IntrinsicPeriodicContinuation> {
    let seeds: Vec<IntrinsicPeriodicSeed> = continuations.iter().map(|c| c.seed.clone()).collect();
    let ranked_seeds = rank_intrinsic_periodic_seeds(seeds);
    let mut ranks: HashMap<String, usize> = HashMap::new();
    for (index, seed) in ranked_seeds.iter().enumerate() {
        ranks.entry(seed.canonical_key.clone()).or_insert(index);
    }
    let mut ordered = continuations;
    ordered.sort_by(|first, second| {
        let first_rank = ranks
            .get(&first.seed.canonical_key)
            .copied()
            .unwrap_or(usize::MAX);
        let second_rank = ranks
            .get(&second.seed.canonical_key)
            .copied()
            .unwrap_or(usize::MAX);
        first_rank
            .cmp(&second_rank)
            .then_with(|| locale_compare_keys(&first.source_id, &second.source_id))
    });
    ordered
}

/// TS: `periodicContinuationFutureKey` (`PORTFOLIO:1454-1462`).
fn periodic_continuation_future_key(
    pieces: &[IrregularPreparedPiece],
    seed: &IntrinsicPeriodicSeed,
) -> String {
    let remaining_order: Vec<String> = remaining_after_seed(pieces, seed)
        .iter()
        .map(|piece| prepared_piece_id(piece).0)
        .collect();
    format!(
        "{{\"geometry\":{},\"remainingOrder\":{}}}",
        serde_json::to_string(&seed.canonical_key).expect("string always serializes"),
        serde_json::to_string(&remaining_order).expect("string array always serializes"),
    )
}

/// TS: `preferPeriodicContinuation` (`PORTFOLIO:1464-1472`).
fn prefer_periodic_continuation<'a>(
    first: &'a IntrinsicPeriodicContinuation,
    second: &'a IntrinsicPeriodicContinuation,
) -> &'a IntrinsicPeriodicContinuation {
    let first_is_witness = first.source_id.starts_with("raw-witness:");
    let second_is_witness = second.source_id.starts_with("raw-witness:");
    if first_is_witness != second_is_witness {
        return if first_is_witness { second } else { first };
    }
    if locale_compare_keys(&first.source_id, &second.source_id) != Ordering::Greater {
        first
    } else {
        second
    }
}

/// TS: `remainingAfterSeed` (`PORTFOLIO:1474-1482`).
fn remaining_after_seed(
    pieces: &[IrregularPreparedPiece],
    seed: &IntrinsicPeriodicSeed,
) -> Vec<IrregularPreparedPiece> {
    let frozen: HashSet<PieceId> = seed
        .placements
        .iter()
        .map(|placed| placement_piece_id(&placed.placement))
        .collect();
    pieces
        .iter()
        .filter(|piece| !frozen.contains(&prepared_piece_id(piece)))
        .cloned()
        .collect()
}

// ===========================================================================
// `selectIntrinsicPeriodicContinuations` (`PORTFOLIO:608-961`).
// ===========================================================================

struct SelectionOutcome {
    continuations: Vec<IntrinsicPeriodicContinuation>,
    omissions: Vec<IntrinsicPeriodicContinuationOmission>,
    coverage_complete: bool,
    source_crop_survival: Vec<IntrinsicPeriodicSourceCropSurvival>,
    source_audit_witnesses: Vec<IntrinsicPeriodicSourceAuditWitness>,
    source_audit_non_dominated_crop_count: f64,
    phase_timings: Option<IntrinsicPeriodicSelectionPhaseTimings>,
}

#[derive(Clone)]
struct SourceAuditWitnessRecord {
    family_key: String,
    basis_provenance: IntrinsicPeriodicBasisProvenance,
    source_key: String,
    source_kind: IntrinsicPeriodicBasisSourceKind,
    seed: IntrinsicPeriodicSeed,
}

#[allow(clippy::too_many_arguments)]
fn select_intrinsic_periodic_continuations(
    catalog: &IntrinsicPeriodicCatalog,
    pieces: &[IrregularPreparedPiece],
    maximum_continuation_count: usize,
    maximum_crops_per_cell: usize,
    basis_source_key: Option<&str>,
    capture_source_survival_audit: bool,
    admit_source_audit_witnesses: bool,
    capture_phase_timings: bool,
    source_audit_replay: Option<&IntrinsicPeriodicSourceAuditReplay>,
    source_audit_scope: IntrinsicPeriodicSourceAuditScope,
    control: &mut PortfolioControl<'_>,
) -> Result<SelectionOutcome, IntrinsicPeriodicError> {
    checkpoint(control)?;
    let selection_started_at = if capture_phase_timings {
        default_timing_now()
    } else {
        0.0
    };
    let mut source_audit_crop_enumeration_ms = 0.0_f64;
    let mut retained_crop_enumeration_ms = 0.0_f64;
    let mut crop_front_selection_ms = 0.0_f64;
    let mut source_audit_logical_crop_attempt_count = 0.0_f64;
    let mut source_audit_physical_crop_attempt_count = 0.0_f64;
    let mut source_audit_unique_canonical_cell_count = 0.0_f64;
    let mut source_audit_canonical_cell_replay_count = 0.0_f64;
    let mut source_audit_replay_witness_count = 0.0_f64;

    let family_members: HashMap<String, Vec<IrregularPreparedPiece>> =
        group_intrinsic_collision_families(pieces)
            .into_iter()
            .map(|family| (family.key, family.members))
            .collect();
    let mut per_family: OrderedMap<Vec<IntrinsicPeriodicContinuation>> = OrderedMap::new();
    let mut seen_ordinary_futures: HashSet<String> = HashSet::new();
    let mut omissions: Vec<IntrinsicPeriodicContinuationOmission> = Vec::new();
    let mut source_crop_survival: OrderedMap<SourceCropSurvivalAccum> = OrderedMap::new();
    let mut source_audit_witnesses: OrderedMap<SourceAuditWitnessRecord> = OrderedMap::new();

    for family in &catalog.families {
        checkpoint(control)?;
        let Some(members) = family_members.get(&family.family_key) else {
            continue;
        };
        let mut continuations: Vec<IntrinsicPeriodicContinuation> = Vec::new();
        let mut direct_valid_crops_by_cell: HashMap<String, Vec<IntrinsicPeriodicSeed>> =
            HashMap::new();
        let mut direct_valid_crops_by_canonical_cell: HashMap<
            String,
            (Vec<IntrinsicPeriodicSeed>, f64),
        > = HashMap::new();

        // TS: `enumerateCrops` closure (`PORTFOLIO:708-746`), inlined as a
        // local helper here to avoid capturing multiple independent `&mut`
        // accumulators in a Rust closure.
        macro_rules! enumerate_crops {
            ($cell:expr, $phase_is_source_audit:expr) => {{
                let cell: &IntrinsicPeriodicCell = $cell;
                match direct_valid_crops_by_canonical_cell.get(&cell.canonical_key) {
                    Some((crops, attempt_count)) => {
                        if $phase_is_source_audit {
                            source_audit_logical_crop_attempt_count += *attempt_count;
                            source_audit_canonical_cell_replay_count += 1.0;
                        }
                        Ok(crops.clone())
                    }
                    None => {
                        let mut attempt_count = 0.0_f64;
                        let enumeration_started_at = if capture_phase_timings {
                            default_timing_now()
                        } else {
                            0.0
                        };
                        let mut control_opt: Option<&mut dyn NfpIfpControl> = Some(control);
                        let crops_result = enumerate_intrinsic_periodic_cell_crops(
                            cell,
                            members,
                            &mut || attempt_count += 1.0,
                            &mut control_opt,
                        );
                        match crops_result {
                            Ok(crops) => {
                                if capture_phase_timings {
                                    let elapsed = default_timing_now() - enumeration_started_at;
                                    if $phase_is_source_audit {
                                        source_audit_crop_enumeration_ms += elapsed;
                                    } else {
                                        retained_crop_enumeration_ms += elapsed;
                                    }
                                }
                                direct_valid_crops_by_canonical_cell.insert(
                                    cell.canonical_key.clone(),
                                    (crops.clone(), attempt_count),
                                );
                                if $phase_is_source_audit {
                                    source_audit_logical_crop_attempt_count += attempt_count;
                                    source_audit_physical_crop_attempt_count += attempt_count;
                                    source_audit_unique_canonical_cell_count += 1.0;
                                }
                                Ok(crops)
                            }
                            Err(error) => Err(error),
                        }
                    }
                }
            }};
        }

        if capture_source_survival_audit && source_audit_replay.is_none() {
            let default_cells = family.source_audit_cells.as_ref().unwrap_or(&family.cells);
            for cell in default_cells {
                checkpoint(control)?;
                if let Some(basis_source_key) = basis_source_key {
                    if cell
                        .basis_provenance
                        .as_ref()
                        .map(|p| p.source_key.as_str())
                        != Some(basis_source_key)
                    {
                        continue;
                    }
                }
                if !source_audit_cell_included(cell, source_audit_scope) {
                    continue;
                }
                let audit_key = cell
                    .basis_provenance
                    .as_ref()
                    .map(|provenance| format!("{}:{}", cell.role.as_str(), provenance.source_key));
                if let Some(audit_key) = &audit_key {
                    source_crop_survival.get_or_insert_with(audit_key, || {
                        SourceCropSurvivalAccum {
                            role: cell.role,
                            source_key: cell.basis_provenance.as_ref().unwrap().source_key.clone(),
                            source_kind: cell.basis_provenance.as_ref().unwrap().source_kind,
                            retained_cell_count: 0.0,
                            direct_valid_crop_count_before_front: 0.0,
                            direct_valid_crop_count: 0.0,
                            crop_front_count: 0.0,
                            unique_seed_count: 0.0,
                            selected_continuation_count: 0.0,
                        }
                    });
                }
                let direct_valid_crops = enumerate_crops!(cell, true)?;
                if let Some(audit_key) = &audit_key {
                    if let Some(accum) = source_crop_survival.get_mut(audit_key) {
                        accum.direct_valid_crop_count_before_front +=
                            direct_valid_crops.len() as f64;
                    }
                }
                if let Some(provenance) = cell.basis_provenance.as_ref() {
                    for seed in &direct_valid_crops {
                        let future_key = periodic_continuation_future_key(pieces, seed);
                        let replace = match source_audit_witnesses.get(&future_key) {
                            None => true,
                            Some(current) => provenance.source_key < current.source_key,
                        };
                        if replace {
                            source_audit_witnesses.set(
                                future_key,
                                SourceAuditWitnessRecord {
                                    family_key: family.family_key.clone(),
                                    basis_provenance: provenance.clone(),
                                    source_key: provenance.source_key.clone(),
                                    source_kind: provenance.source_kind,
                                    seed: seed.clone(),
                                },
                            );
                        }
                    }
                }
                direct_valid_crops_by_cell
                    .insert(periodic_source_cell_key(cell), direct_valid_crops);
            }
        }

        for cell in &family.cells {
            checkpoint(control)?;
            if let Some(basis_source_key) = basis_source_key {
                if cell
                    .basis_provenance
                    .as_ref()
                    .map(|p| p.source_key.as_str())
                    != Some(basis_source_key)
                {
                    continue;
                }
            }
            let audit_key = cell
                .basis_provenance
                .as_ref()
                .map(|provenance| format!("{}:{}", cell.role.as_str(), provenance.source_key));
            if let Some(audit_key) = &audit_key {
                source_crop_survival.get_or_insert_with(audit_key, || SourceCropSurvivalAccum {
                    role: cell.role,
                    source_key: cell.basis_provenance.as_ref().unwrap().source_key.clone(),
                    source_kind: cell.basis_provenance.as_ref().unwrap().source_kind,
                    retained_cell_count: 0.0,
                    direct_valid_crop_count_before_front: 0.0,
                    direct_valid_crop_count: 0.0,
                    crop_front_count: 0.0,
                    unique_seed_count: 0.0,
                    selected_continuation_count: 0.0,
                });
                if let Some(accum) = source_crop_survival.get_mut(audit_key) {
                    accum.retained_cell_count += 1.0;
                }
            }
            let direct_valid_crops =
                match direct_valid_crops_by_cell.get(&periodic_source_cell_key(cell)) {
                    Some(crops) => crops.clone(),
                    None => enumerate_crops!(cell, false)?,
                };
            let crop_front_started_at = if capture_phase_timings {
                default_timing_now()
            } else {
                0.0
            };
            let crops = select_intrinsic_periodic_seed_front(
                direct_valid_crops.clone(),
                maximum_crops_per_cell,
            );
            if capture_phase_timings {
                crop_front_selection_ms += default_timing_now() - crop_front_started_at;
            }
            if let Some(audit_key) = &audit_key {
                if let Some(accum) = source_crop_survival.get_mut(audit_key) {
                    accum.direct_valid_crop_count += direct_valid_crops.len() as f64;
                    accum.crop_front_count += crops.len() as f64;
                }
            }
            for (crop_index, seed) in crops.into_iter().enumerate() {
                let source_id = format!(
                    "{}:{}:{}:{}",
                    family.family_key,
                    cell.role.as_str(),
                    cell.canonical_key,
                    crop_index
                );
                if seed.placements.len() < 4 {
                    omissions.push(IntrinsicPeriodicContinuationOmission {
                        source_id,
                        reason: IntrinsicPeriodicContinuationOmissionReason::InsufficientSeed,
                    });
                    continue;
                }
                let future_key = periodic_continuation_future_key(pieces, &seed);
                if seen_ordinary_futures.contains(&future_key) {
                    omissions.push(IntrinsicPeriodicContinuationOmission {
                        source_id,
                        reason: IntrinsicPeriodicContinuationOmissionReason::DuplicateCanonicalSeed,
                    });
                    continue;
                }
                seen_ordinary_futures.insert(future_key);
                if let Some(audit_key) = &audit_key {
                    if let Some(accum) = source_crop_survival.get_mut(audit_key) {
                        accum.unique_seed_count += 1.0;
                    }
                }
                continuations.push(IntrinsicPeriodicContinuation {
                    source_id,
                    role: cell.role,
                    family_key: family.family_key.clone(),
                    cell_key: cell.canonical_key.clone(),
                    basis_source_key: cell.basis_provenance.as_ref().map(|p| p.source_key.clone()),
                    seed,
                });
            }
        }
        per_family.set(family.family_key.clone(), continuations);
    }

    if capture_source_survival_audit {
        if let Some(source_audit_replay) = source_audit_replay {
            for witness in &source_audit_replay.witnesses {
                checkpoint(control)?;
                if let Some(basis_source_key) = basis_source_key {
                    if witness.source_key != basis_source_key {
                        continue;
                    }
                }
                let Some(members) = family_members.get(&witness.family_key) else {
                    continue;
                };
                let seed = validate_and_reconstruct_source_audit_witness(witness, members)?;
                source_audit_replay_witness_count += 1.0;
                source_audit_witnesses.set(
                    periodic_continuation_future_key(pieces, &seed),
                    SourceAuditWitnessRecord {
                        family_key: witness.family_key.clone(),
                        basis_provenance: witness.basis_provenance.clone(),
                        source_key: witness.source_key.clone(),
                        source_kind: witness.source_kind,
                        seed,
                    },
                );
            }
        }
    }

    let witness_seeds: Vec<IntrinsicPeriodicSeed> = source_audit_witnesses
        .entries()
        .into_iter()
        .map(|(_, record)| record.seed)
        .collect();
    let raw_audit_front = non_dominated_intrinsic_periodic_seeds(witness_seeds);

    let witness_continuations: Vec<IntrinsicPeriodicContinuation> = if !admit_source_audit_witnesses
    {
        Vec::new()
    } else {
        let mut result = Vec::new();
        for seed in rank_intrinsic_periodic_seeds(raw_audit_front.clone())
            .into_iter()
            .take(16)
        {
            let future_key = periodic_continuation_future_key(pieces, &seed);
            let Some(source) = source_audit_witnesses.get(&future_key) else {
                continue;
            };
            let source_id = format!(
                "raw-witness:{}:{}:{}",
                seed.role.as_str(),
                source.source_key,
                seed.canonical_key
            );
            if seed.placements.len() < 4 {
                omissions.push(IntrinsicPeriodicContinuationOmission {
                    source_id,
                    reason: IntrinsicPeriodicContinuationOmissionReason::InsufficientSeed,
                });
                continue;
            }
            result.push(IntrinsicPeriodicContinuation {
                source_id,
                role: seed.role,
                family_key: source.family_key.clone(),
                cell_key: seed.cell_key.clone(),
                basis_source_key: Some(source.source_key.clone()),
                seed,
            });
        }
        result
    };
    for continuation in witness_continuations {
        let family_key = continuation.family_key.clone();
        per_family
            .get_or_insert_with(&family_key, Vec::new)
            .push(continuation);
    }

    // TS: `preferredByFuture` (`PORTFOLIO:865-877`). Reference identity in
    // TS is reproduced here via `sourceId` equality: every continuation's
    // `sourceId` is unique within one portfolio run by construction (it
    // embeds either the unique `(familyKey, role, canonicalKey, cropIndex)`
    // tuple or the unique `raw-witness:(role, sourceKey, canonicalKey)`
    // tuple), so `sourceId` equality is a faithful stand-in for the TS `===`
    // object-identity check.
    let mut preferred_by_future: HashMap<String, IntrinsicPeriodicContinuation> = HashMap::new();
    for continuation in per_family.entries().into_iter().flat_map(|(_, list)| list) {
        let future_key = periodic_continuation_future_key(pieces, &continuation.seed);
        match preferred_by_future.get(&future_key) {
            None => {
                preferred_by_future.insert(future_key, continuation);
            }
            Some(current) => {
                let preferred = prefer_periodic_continuation(current, &continuation).clone();
                let duplicate_source_id = if preferred.source_id == current.source_id {
                    continuation.source_id.clone()
                } else {
                    current.source_id.clone()
                };
                preferred_by_future.insert(future_key, preferred);
                omissions.push(IntrinsicPeriodicContinuationOmission {
                    source_id: duplicate_source_id,
                    reason: IntrinsicPeriodicContinuationOmissionReason::DuplicateCanonicalSeed,
                });
            }
        }
    }

    let mut family_entries = per_family.entries();
    family_entries.sort_by(|(first, _), (second, _)| locale_compare_keys(first, second));
    let ranked_per_family: Vec<Vec<IntrinsicPeriodicContinuation>> = family_entries
        .into_iter()
        .map(|(_, continuations)| {
            let filtered: Vec<IntrinsicPeriodicContinuation> = continuations
                .into_iter()
                .filter(|continuation| {
                    let future_key = periodic_continuation_future_key(pieces, &continuation.seed);
                    preferred_by_future
                        .get(&future_key)
                        .map(|preferred| preferred.source_id == continuation.source_id)
                        .unwrap_or(false)
                })
                .collect();
            rank_continuations(filtered)
        })
        .collect();
    let reserved: Vec<IntrinsicPeriodicContinuation> = ranked_per_family
        .iter()
        .flat_map(|continuations| continuations.iter().take(1).cloned())
        .collect();
    let fill_input: Vec<IntrinsicPeriodicContinuation> = ranked_per_family
        .iter()
        .flat_map(|continuations| continuations.iter().skip(1).cloned())
        .collect();
    let fill = rank_continuations(fill_input);
    let mut all: Vec<IntrinsicPeriodicContinuation> = reserved;
    all.extend(fill);
    let selected: Vec<IntrinsicPeriodicContinuation> = all
        .iter()
        .take(maximum_continuation_count)
        .cloned()
        .collect();
    for continuation in &selected {
        let Some(source_key) = continuation.basis_source_key.as_ref() else {
            continue;
        };
        let key = format!("{}:{}", continuation.role.as_str(), source_key);
        if let Some(accum) = source_crop_survival.get_mut(&key) {
            accum.selected_continuation_count += 1.0;
        }
    }
    for continuation in all.iter().skip(maximum_continuation_count) {
        omissions.push(IntrinsicPeriodicContinuationOmission {
            source_id: continuation.source_id.clone(),
            reason: IntrinsicPeriodicContinuationOmissionReason::ContinuationCap,
        });
    }

    let mut source_crop_survival_result: Vec<IntrinsicPeriodicSourceCropSurvival> =
        match source_audit_replay {
            Some(replay) => replay.source_crop_survival.clone(),
            None => source_crop_survival
                .entries()
                .iter()
                .map(|(_, accum)| accum.into())
                .collect(),
        };
    source_crop_survival_result.sort_by(|first, second| {
        locale_compare_keys(first.role.as_str(), second.role.as_str())
            .then_with(|| locale_compare_keys(&first.source_key, &second.source_key))
    });

    let source_audit_witness_result: Vec<IntrinsicPeriodicSourceAuditWitness> =
        rank_intrinsic_periodic_seeds(raw_audit_front.clone())
            .into_iter()
            .take(16)
            .filter_map(|seed| {
                let future_key = periodic_continuation_future_key(pieces, &seed);
                let source = source_audit_witnesses.get(&future_key)?;
                Some(IntrinsicPeriodicSourceAuditWitness {
                    role: seed.role,
                    family_key: source.family_key.clone(),
                    source_key: source.source_key.clone(),
                    source_kind: source.source_kind,
                    cell_key: seed.cell_key.clone(),
                    basis_provenance: complete_basis_provenance(&source.basis_provenance),
                    placements: seed.placements.clone(),
                    seed: source_audit_witness_seed(&seed),
                })
            })
            .collect();

    let phase_timings = if capture_phase_timings {
        let total_ms = default_timing_now() - selection_started_at;
        let measured_ms = source_audit_crop_enumeration_ms
            + retained_crop_enumeration_ms
            + crop_front_selection_ms;
        let bookkeeping_ms = js_math::max(0.0, total_ms - measured_ms);
        Some(IntrinsicPeriodicSelectionPhaseTimings {
            source_audit_crop_enumeration_ms,
            retained_crop_enumeration_ms,
            crop_front_selection_ms,
            source_audit_logical_crop_attempt_count,
            source_audit_physical_crop_attempt_count,
            source_audit_unique_canonical_cell_count,
            source_audit_canonical_cell_replay_count,
            source_audit_replay_witness_count,
            bookkeeping_ms,
            coverage_complete: phase_residual_coverage_complete(total_ms, bookkeeping_ms),
            total_ms,
        })
    } else {
        None
    };

    Ok(SelectionOutcome {
        coverage_complete: all.len() <= maximum_continuation_count,
        continuations: selected,
        omissions,
        source_crop_survival: source_crop_survival_result,
        source_audit_witnesses: source_audit_witness_result,
        source_audit_non_dominated_crop_count: source_audit_replay
            .map(|replay| replay.non_dominated_crop_count)
            .unwrap_or(raw_audit_front.len() as f64),
        phase_timings,
    })
}

// ===========================================================================
// `runIntrinsicPeriodicFamilyPortfolio` (`PORTFOLIO:227-503`).
// ===========================================================================

/// TS: `runIntrinsicPeriodicFamilyPortfolio` (`PORTFOLIO:227-503`). Runs
/// independent repeated-family P1/P2 seeds through the unchanged strict
/// decoder and archive.
pub fn run_intrinsic_periodic_family_portfolio(
    archive_sheet: &SheetSpec,
    pieces: &[IrregularPreparedPiece],
    mut options: IntrinsicPeriodicFamilyPortfolioOptions<'_>,
    settings: &IrregularNestingSettings,
    geometry_cache: &mut GeometryCacheStore,
) -> Result<IntrinsicPeriodicFamilyPortfolioResult, IntrinsicPeriodicPortfolioError> {
    let default_timing_now_ref: &TimingNowFn = &default_timing_now;
    let timing_now: &TimingNowFn = options.timing_now.unwrap_or(default_timing_now_ref);
    let started_at = timing_now();

    let maximum_catalog_runtime_ms = options.maximum_catalog_runtime_ms;
    let maximum_cells_per_family_role = options.maximum_cells_per_family_role;
    let maximum_crops_per_cell = options.maximum_crops_per_cell;
    let maximum_continuation_runtime_ms = options.maximum_continuation_runtime_ms;
    let maximum_continuation_candidate_evaluations =
        options.maximum_continuation_candidate_evaluations;
    let capture_phase_timings = options.capture_phase_timings;
    let maximum_continuation_count = options.maximum_continuation_count;
    let maximum_total_runtime_ms = options.maximum_total_runtime_ms;

    let mut control = PortfolioControl {
        inner: options.control.take(),
    };

    let catalog_started_at = if capture_phase_timings {
        timing_now()
    } else {
        0.0
    };
    let catalog_options = IntrinsicPeriodicCatalogOptions {
        maximum_runtime_ms: maximum_catalog_runtime_ms,
        maximum_family_count: 8,
        maximum_transforms_per_family: 16,
        maximum_pairs_per_family: 120,
        maximum_cells_per_family_role,
        capture_source_survival_audit: options.capture_source_survival_audit,
    };
    let mut catalog_control_opt: Option<&mut dyn NfpIfpControl> = Some(&mut control);
    let mut ctx = PeriodicRunContext {
        settings,
        geometry_cache,
        control: catalog_control_opt.take(),
    };
    let catalog = enumerate_intrinsic_periodic_cells(pieces, &catalog_options, &mut ctx)?;
    let catalog_ms = if capture_phase_timings {
        timing_now() - catalog_started_at
    } else {
        0.0
    };

    let source_audit_scope = options.source_audit_scope;
    let replay_probe_started_at = timing_now();
    let source_audit_replay_resolution = validate_source_audit_replay_envelope(
        &catalog,
        pieces,
        source_audit_scope,
        options.basis_source_key.as_deref(),
        options.expected_source_audit_replay_digest.as_deref(),
        options.source_audit_replay_envelope.as_ref(),
        &mut control,
    )
    .map_err(IntrinsicPeriodicPortfolioError::from)?;
    let source_audit_replay = source_audit_replay_resolution.replay;
    let replay_probe_excluded_ms =
        if options.source_audit_replay_envelope.is_some() && source_audit_replay.is_none() {
            timing_now() - replay_probe_started_at
        } else {
            0.0
        };

    let selected = select_intrinsic_periodic_continuations(
        &catalog,
        pieces,
        maximum_continuation_count,
        maximum_crops_per_cell,
        options.basis_source_key.as_deref(),
        options.capture_source_survival_audit,
        options.capture_source_survival_audit && options.admit_source_audit_witnesses,
        capture_phase_timings,
        source_audit_replay.as_ref(),
        source_audit_scope,
        &mut control,
    )
    .map_err(IntrinsicPeriodicPortfolioError::from)?;
    let selection_ms = selected
        .phase_timings
        .as_ref()
        .map(|t| t.total_ms)
        .unwrap_or(0.0);
    let ordering_started_at = if capture_phase_timings {
        timing_now()
    } else {
        0.0
    };
    let continuations = continuations_for_execution(
        selected.continuations,
        maximum_continuation_candidate_evaluations,
    );
    let execution_ordering_ms = if capture_phase_timings {
        timing_now() - ordering_started_at
    } else {
        0.0
    };

    let mut runs: Vec<IntrinsicPeriodicContinuationResult> = Vec::new();
    let mut construction_ms = 0.0_f64;
    let mut construction_candidate_generation_ms = 0.0_f64;
    let mut construction_candidate_state_scoring_ms = 0.0_f64;
    let mut construction_candidate_state_scoring = empty_candidate_state_phase_timings();
    let mut construction_measured_run_count = 0.0_f64;
    let mut construction_run_coverage_complete = true;
    let mut finalization_ms = 0.0_f64;

    for continuation in &continuations {
        let remaining_ms =
            maximum_total_runtime_ms - (timing_now() - started_at - replay_probe_excluded_ms);
        if remaining_ms <= 0.0 {
            runs.push(IntrinsicPeriodicContinuationResult {
                continuation: continuation.clone(),
                status: IntrinsicPeriodicContinuationStatus::GlobalDeadline,
                result: None,
                constructed: None,
                reason: Some(
                    "global periodic portfolio runtime exhausted before continuation".to_string(),
                ),
                runtime_ms: 0.0,
            });
            continue;
        }
        let started_continuation_at = timing_now();
        let all_prepared: Vec<Arc<IrregularPreparedPiece>> =
            pieces.iter().cloned().map(Arc::new).collect();
        let remaining_prepared: Vec<Arc<IrregularPreparedPiece>> =
            remaining_after_seed(pieces, &continuation.seed)
                .into_iter()
                .map(Arc::new)
                .collect();
        let frozen_placed: Vec<Arc<IrregularPlacedPiece>> = continuation
            .seed
            .placements
            .iter()
            .cloned()
            .map(Arc::new)
            .collect();
        let construct_input = ConstructIntrinsicStrictStateInput {
            all_prepared_pieces: &all_prepared,
            remaining_prepared_pieces: &remaining_prepared,
            frozen_placed: &frozen_placed,
            candidate_mode: IntrinsicStrictCandidateMode::Comparator(
                IntrinsicStrictComparatorMode::PureGrowth,
            ),
            maximum_runtime_ms: Some(js_math::min(maximum_continuation_runtime_ms, remaining_ms)),
            maximum_candidate_evaluation_count: maximum_continuation_candidate_evaluations,
            capture_candidate_evaluation_count: false,
            capture_phase_timings,
            timing_now: None,
            producer_role: None,
            checkpoint: None,
            maximum_completed_piece_boundaries: None,
            control: Some(&mut control),
        };
        let constructed =
            match construct_intrinsic_strict_state(construct_input, settings, geometry_cache) {
                Ok(constructed) => constructed,
                Err(IntrinsicStrictDecoderFailure::Abort(abort))
                    if abort.reason == NfpIfpAbortReason::Cancelled =>
                {
                    return Err(IntrinsicPeriodicPortfolioError::Abort(abort));
                }
                Err(error) => {
                    let runtime_ms = timing_now() - started_continuation_at;
                    if capture_phase_timings {
                        construction_ms += runtime_ms;
                    }
                    let status = match &error {
                        IntrinsicStrictDecoderFailure::Abort(_) => {
                            IntrinsicPeriodicContinuationStatus::Deadline
                        }
                        _ => IntrinsicPeriodicContinuationStatus::Invalid,
                    };
                    runs.push(IntrinsicPeriodicContinuationResult {
                        continuation: continuation.clone(),
                        status,
                        result: None,
                        constructed: None,
                        reason: Some(strict_failure_tag(&error).to_string()),
                        runtime_ms,
                    });
                    continue;
                }
            };
        let runtime_ms = timing_now() - started_continuation_at;
        if capture_phase_timings {
            construction_ms += runtime_ms;
        }
        if capture_phase_timings {
            match constructed.phase_timings.as_ref() {
                None => construction_run_coverage_complete = false,
                Some(timing) => {
                    construction_measured_run_count += 1.0;
                    construction_candidate_generation_ms += timing.candidate_generation_ms;
                    construction_candidate_state_scoring_ms += timing.candidate_state_scoring_ms;
                    add_candidate_state_phase_timings(
                        &mut construction_candidate_state_scoring,
                        &timing.candidate_state_scoring,
                    );
                    construction_run_coverage_complete =
                        construction_run_coverage_complete && timing.coverage_complete;
                }
            }
        }
        if constructed.truncation_reason == Some(TruncationReason::MaximumCandidateEvaluations) {
            runs.push(IntrinsicPeriodicContinuationResult {
                continuation: continuation.clone(),
                status: IntrinsicPeriodicContinuationStatus::EvaluationCap,
                result: None,
                constructed: Some(constructed),
                reason: Some("maximum-candidate-evaluations".to_string()),
                runtime_ms,
            });
            continue;
        }
        let finalization_started_at = if capture_phase_timings {
            timing_now()
        } else {
            0.0
        };
        let result =
            finalize_intrinsic_strict_state(archive_sheet, constructed.clone(), runtime_ms)
                .map_err(IntrinsicPeriodicPortfolioError::from)?;
        if capture_phase_timings {
            finalization_ms += timing_now() - finalization_started_at;
        }
        runs.push(IntrinsicPeriodicContinuationResult {
            continuation: continuation.clone(),
            status: map_decode_status(result.status),
            result: Some(result),
            constructed: Some(constructed),
            reason: None,
            runtime_ms,
        });
    }

    let archive_started_at = if capture_phase_timings {
        timing_now()
    } else {
        0.0
    };
    let completed_metrics: Vec<IntrinsicStrictCompletedMetrics> = runs
        .iter()
        .filter_map(|run| {
            run.result
                .as_ref()
                .and_then(|result| result.metrics.clone())
        })
        .collect();
    let archive = rank_intrinsic_strict_completed_layouts(&completed_metrics);
    let archive_ranking_ms = if capture_phase_timings {
        timing_now() - archive_started_at
    } else {
        0.0
    };
    let winning_hash = archive
        .first()
        .map(|entry| entry.canonical_geometry_hash.clone());
    let winner = winning_hash.and_then(|hash| {
        runs.iter()
            .find(|run| {
                run.result
                    .as_ref()
                    .and_then(|r| r.metrics.as_ref())
                    .map(|m| &m.canonical_geometry_hash)
                    == Some(&hash)
            })
            .cloned()
    });

    let phase_timings = if capture_phase_timings {
        if let Some(selection_timings) = selected.phase_timings {
            let total_ms = timing_now() - started_at;
            let measured_phase_ms = catalog_ms
                + selection_ms
                + execution_ordering_ms
                + construction_ms
                + finalization_ms
                + archive_ranking_ms;
            let bookkeeping_ms = js_math::max(0.0, total_ms - measured_phase_ms);
            let construction_bookkeeping_ms = js_math::max(
                0.0,
                construction_ms
                    - construction_candidate_generation_ms
                    - construction_candidate_state_scoring_ms,
            );
            let construction_coverage_complete = construction_run_coverage_complete
                && construction_measured_run_count == continuations.len() as f64
                && intrinsic_strict_phase_coverage_complete(
                    construction_ms,
                    construction_bookkeeping_ms,
                );
            let construction = IntrinsicPeriodicConstructionPhaseTimings {
                candidate_generation_ms: construction_candidate_generation_ms,
                candidate_state_scoring_ms: construction_candidate_state_scoring_ms,
                candidate_state_scoring: freeze_candidate_state_phase_timings(
                    &construction_candidate_state_scoring,
                ),
                bookkeeping_ms: construction_bookkeeping_ms,
                measured_run_count: construction_measured_run_count,
                expected_run_count: continuations.len() as f64,
                coverage_complete: construction_coverage_complete,
                total_ms: construction_ms,
            };
            Some(IntrinsicPeriodicPortfolioPhaseTimings {
                catalog_ms,
                selection_ms,
                selection: selection_timings,
                execution_ordering_ms,
                construction_ms,
                construction,
                finalization_ms,
                archive_ranking_ms,
                bookkeeping_ms,
                coverage_complete: phase_residual_coverage_complete(total_ms, bookkeeping_ms)
                    && selection_timings.coverage_complete
                    && construction_coverage_complete,
                total_ms,
            })
        } else {
            None
        }
    } else {
        None
    };

    let continuation_execution_coverage_complete = runs.iter().all(|run| {
        !matches!(
            run.status,
            IntrinsicPeriodicContinuationStatus::Invalid
                | IntrinsicPeriodicContinuationStatus::Deadline
                | IntrinsicPeriodicContinuationStatus::GlobalDeadline
                | IntrinsicPeriodicContinuationStatus::EvaluationCap
        )
    });
    let continuation_budget_settlement_complete = runs.iter().all(|run| {
        !matches!(
            run.status,
            IntrinsicPeriodicContinuationStatus::Invalid
                | IntrinsicPeriodicContinuationStatus::Deadline
                | IntrinsicPeriodicContinuationStatus::GlobalDeadline
        )
    });

    let source_audit_replay_envelope = if options.capture_source_audit_replay_envelope {
        Some(make_source_audit_replay_envelope(
            &catalog,
            pieces,
            source_audit_scope,
            options.basis_source_key.as_deref(),
            IntrinsicPeriodicSourceAuditReplay {
                witnesses: selected.source_audit_witnesses.clone(),
                non_dominated_crop_count: selected.source_audit_non_dominated_crop_count,
                source_crop_survival: selected.source_crop_survival.clone(),
            },
        ))
    } else {
        None
    };

    let runtime_ms = phase_timings
        .as_ref()
        .map(|t| t.total_ms)
        .unwrap_or_else(|| timing_now() - started_at);

    Ok(IntrinsicPeriodicFamilyPortfolioResult {
        catalog,
        continuations,
        continuation_omissions: selected.omissions,
        continuation_coverage_complete: selected.coverage_complete,
        continuation_execution_coverage_complete,
        continuation_budget_settlement_complete,
        source_crop_survival: selected.source_crop_survival,
        source_audit_witnesses: selected.source_audit_witnesses,
        source_audit_non_dominated_crop_count: selected.source_audit_non_dominated_crop_count,
        source_audit_replay_accepted: source_audit_replay.is_some(),
        source_audit_replay_validation_crop_attempt_count: source_audit_replay_resolution
            .validation_crop_attempt_count,
        source_audit_replay_rejection_reason: source_audit_replay_resolution.rejection_reason,
        source_audit_replay_envelope,
        runs,
        archive,
        winner,
        phase_timings,
        runtime_ms,
    })
}
