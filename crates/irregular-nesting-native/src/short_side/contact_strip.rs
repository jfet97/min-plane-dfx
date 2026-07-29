//! Exact contact-driven directional layout construction inside one requested
//! short-axis strip.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicShortSideContactStrip.ts`
//! (845 lines), ported here in full. Read together with
//! `docs/planning/rust-irregular-backend/characterization/short-side.md`
//! §6.10-§6.12 (the exact contact tuple -- this file's special focus) and
//! §10.3 (the four cooperative bounds, including the mislabeled-`reason`
//! quirk in the deadline/memory-cap-to-`NfpIfpControlAbortError` bridge)
//! before touching this file.
//!
//! The strip is expressed in normalized directional coordinates: `x` is the
//! requested short axis and `y` is the requested long axis, so filling the
//! short edge means spreading along `x` and compactness means minimizing
//! `y`. Each prepared piece is visited in prepared order (the caller
//! supplies that order via `input.prepared_pieces` -- `order_policy` is a
//! **trace label only**, never re-derived here, matching TS exactly). The
//! protected depth-first lane uses the shallowest exact candidate. The
//! bounded contact-first lane retains the depth-first decision as a
//! checkpoint, prefers stronger exact contact, and resumes the most recent
//! saved prefix if the contact choice reaches a dead end. Candidates come
//! from the same exact NFP/IFP generator production Compact uses, so every
//! placement is contact-anchored and canonically legal. There is no
//! reordering, concurrent execution, or restart from empty.
//!
//! # Reused (GREEN) modules -- never duplicated here
//!
//! - `canonical_grid::contact::{has_positive_canonical_grid_boundary_contact,
//!   measure_canonical_grid_boundary_overlap_axis_units,
//!   CanonicalGridBoundaryOverlapAxisUnitsResult}` -- the exact contact tuple
//!   this file's special focus depends on, including the one cancellation
//!   hook preserved verbatim.
//! - `canonical_grid::layout::placed_collision_world_grid_path`,
//!   `canonical_grid::to_grid_mm`.
//! - `caches::{GeometryCacheStore, resolve_transformed_collision_geometry,
//!   CandidateDomain, NfpCandidatePruningMode, TransformCollisionGeometryKeyInput,
//!   DEFAULT_NFP_CONSTRUCTION_ALGORITHM}`.
//! - `nfp_ifp::{generate_placement_candidates, GeneratePlacementCandidatesInput,
//!   NfpIfpAbortReason, NfpIfpControl, NfpIfpControlAbortError, NfpIfpError}`.
//! - `validation::spatial_index::{PlacedCollisionSpatialIndex,
//!   make_empty_placed_collision_spatial_index}`.
//! - `validation::placement::IrregularGeometryInputError`.
//!
//! # Seams (documented, established pattern)
//!
//! - `geometry_cache: &mut GeometryCacheStore` is an explicit function
//!   parameter, mirroring the TS `Effect` dependency `GeometryKernel |
//!   NfpIfpService` this file's `yield*` calls resolve -- the same seam
//!   `search::strict_decoder::construct_intrinsic_strict_state` already
//!   establishes for this crate.
//! - `tie_evidence_sink` is threaded as its own function parameter rather
//!   than embedded in [`IntrinsicShortSideContactStripRuntimeControl`]: a
//!   `&mut dyn FnMut` reborrowed once per piece cannot share a struct with
//!   the control's other `&dyn Fn` clock seams without fighting the borrow
//!   checker for no behavioral benefit -- the same class of accommodation
//!   `nfp_ifp::service::nfp_checkpoint`'s own doc comment documents for
//!   `dyn Trait` reborrowing.
//! - No per-search-invocation [`crate::nfp_ifp::LegalCandidateMemo`] is ever
//!   passed to [`generate_placement_candidates`] here: the TS source never
//!   constructs an `IrregularNfpIfpCandidateMemoScope` for this file's
//!   `generatePlacementCandidates` call (confirmed by grep over
//!   `intrinsicShortSideContactStrip.ts`), which the TS memo layer resolves
//!   as a complete bypass (`services.ts`/`nfpIfpService.ts:606-695`, "`memo
//!   === undefined` bypasses entirely"). This port always passes `memo:
//!   None` to match exactly.
//! - No real OS RSS sampler is wired as the seam's default: this crate adds
//!   no process-memory-query dependency (Cargo.toml is outside this task's
//!   file-ownership scope). [`default_current_rss_bytes`] always returns
//!   `0.0`, so the memory-cap bound never self-trips under the default --
//!   callers that need a live RSS-based bound (or deterministic differential
//!   vectors exercising it) must inject `current_rss_bytes` explicitly,
//!   exactly like the deadline clock seam.

use std::sync::Arc;

use num_bigint::BigInt;

use crate::caches::{
    resolve_transformed_collision_geometry, CandidateDomain, GeometryCacheStore,
    NfpCandidatePruningMode, TransformCollisionGeometryKeyInput,
    DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
};
use crate::canonical_grid::contact::{
    has_positive_canonical_grid_boundary_contact,
    measure_canonical_grid_boundary_overlap_axis_units,
    CanonicalGridBoundaryOverlapAxisUnitsResult,
};
use crate::canonical_grid::layout::placed_collision_world_grid_path;
use crate::canonical_grid::to_grid_mm;
use crate::domain::{
    IrregularNestingSettings, IrregularPlacedPiece, IrregularPlacement, IrregularPreparedPiece,
    IrregularTransform, IrregularTransformCandidate, PieceId, SheetSpec,
    TransformedCollisionGeometry,
};
use crate::js_number::js_math;
use crate::nfp_ifp::{
    generate_placement_candidates, GeneratePlacementCandidatesInput, NfpIfpAbortReason,
    NfpIfpCheckpointPhase, NfpIfpControlAbortError, NfpIfpError,
};
use crate::validation::placement::IrregularGeometryInputError;
use crate::validation::spatial_index::{
    make_empty_placed_collision_spatial_index, PlacedCollisionSpatialIndex,
};
use std::cmp::Ordering;

use super::json::ShortSideJsonValue;

// ===========================================================================
// Constants (`intrinsicShortSideContactStrip.ts:29-35`)
// ===========================================================================

pub const INTRINSIC_SHORT_SIDE_CONTACT_STRIP_VERSION: &str =
    "intrinsic-short-side-contact-strip-v3";
pub const INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS: f64 = 20_000.0;
pub const INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES: f64 = 256.0 * 1_048_576.0;
pub const INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_CANDIDATE_EVALUATIONS: f64 = 2_000.0;
pub const INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_BACKTRACKS: f64 = 4.0;

fn compare_f64(first: f64, second: f64) -> Ordering {
    first.partial_cmp(&second).unwrap_or(Ordering::Equal)
}

// ===========================================================================
// Status/policy enums (`intrinsicShortSideContactStrip.ts:37-71`)
// ===========================================================================

/// TS: `intrinsicShortSideContactStrip.ts:37-43`
/// `IntrinsicShortSideContactStripStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicShortSideContactStripStatus {
    Constructed,
    NoLegalPlacement,
    Deadline,
    MemoryCap,
    EvaluationCap,
    FailedProtectedFallback,
}

impl IntrinsicShortSideContactStripStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicShortSideContactStripStatus::Constructed => "constructed",
            IntrinsicShortSideContactStripStatus::NoLegalPlacement => "no-legal-placement",
            IntrinsicShortSideContactStripStatus::Deadline => "deadline",
            IntrinsicShortSideContactStripStatus::MemoryCap => "memory-cap",
            IntrinsicShortSideContactStripStatus::EvaluationCap => "evaluation-cap",
            IntrinsicShortSideContactStripStatus::FailedProtectedFallback => {
                "failed-protected-fallback"
            }
        }
    }
}

/// TS: `intrinsicShortSideContactStrip.ts:64-66`
/// `IntrinsicShortSideContactStripSelectionPolicy`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicShortSideContactStripSelectionPolicy {
    DepthFirst,
    ContactFirst,
}

impl IntrinsicShortSideContactStripSelectionPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicShortSideContactStripSelectionPolicy::DepthFirst => "depth-first",
            IntrinsicShortSideContactStripSelectionPolicy::ContactFirst => "contact-first",
        }
    }
}

/// TS: `intrinsicShortSideContactStrip.ts:68-71`
/// `IntrinsicShortSideContactStripOrderPolicy`. Trace label only -- the
/// actual piece order always comes from `input.prepared_pieces` itself
/// (see this module's top doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicShortSideContactStripOrderPolicy {
    Prepared,
    Reverse,
    PieceIdAscending,
}

impl IntrinsicShortSideContactStripOrderPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicShortSideContactStripOrderPolicy::Prepared => "prepared",
            IntrinsicShortSideContactStripOrderPolicy::Reverse => "reverse",
            IntrinsicShortSideContactStripOrderPolicy::PieceIdAscending => "piece-id-ascending",
        }
    }
}

/// Local `'deadline' | 'memory-cap'` closed set -- this file declares its own
/// copy rather than sharing one with `pair_fold`, matching the TS source's
/// own two textually-independent inline return-type unions.
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

    fn to_status(self) -> IntrinsicShortSideContactStripStatus {
        match self {
            BoundedStatus::Deadline => IntrinsicShortSideContactStripStatus::Deadline,
            BoundedStatus::MemoryCap => IntrinsicShortSideContactStripStatus::MemoryCap,
        }
    }
}

// ===========================================================================
// Trace and outcome types (`:45-115`)
// ===========================================================================

/// TS: `intrinsicShortSideContactStrip.ts:45-62`
/// `IntrinsicShortSideContactStripTrace`. No `serializedTraceBytes` field --
/// unlike `observer`/`pair_fold`, this trace is never self-measured in TS.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideContactStripTrace {
    pub version: &'static str,
    pub status: IntrinsicShortSideContactStripStatus,
    pub execution_model: &'static str,
    pub selection_policy: IntrinsicShortSideContactStripSelectionPolicy,
    pub order_policy: IntrinsicShortSideContactStripOrderPolicy,
    pub strip_short_axis_mm: f64,
    pub strip_long_axis_mm: f64,
    pub transform_evaluations: f64,
    pub candidate_evaluations: f64,
    pub backtrack_count: f64,
    pub reused_prefix_placements: f64,
    pub placed_count: f64,
    pub requested_count: f64,
    pub runtime_ms: f64,
    pub peak_rss_delta_bytes: f64,
    pub failure_reason: Option<String>,
}

impl IntrinsicShortSideContactStripTrace {
    /// Plain `JSON.stringify`-shaped object literal, exact TS field order
    /// (`intrinsicShortSideContactStrip.ts:45-62`). Used only by
    /// `short_side::pair_fold`'s composite trace self-measurement -- this
    /// trace is never measured standalone (see this struct's own doc).
    pub fn to_json(&self) -> ShortSideJsonValue {
        ShortSideJsonValue::Obj(vec![
            ("version", ShortSideJsonValue::str(self.version)),
            ("status", ShortSideJsonValue::str(self.status.as_str())),
            (
                "executionModel",
                ShortSideJsonValue::str(self.execution_model),
            ),
            (
                "selectionPolicy",
                ShortSideJsonValue::str(self.selection_policy.as_str()),
            ),
            (
                "orderPolicy",
                ShortSideJsonValue::str(self.order_policy.as_str()),
            ),
            (
                "stripShortAxisMm",
                ShortSideJsonValue::Num(self.strip_short_axis_mm),
            ),
            (
                "stripLongAxisMm",
                ShortSideJsonValue::Num(self.strip_long_axis_mm),
            ),
            (
                "transformEvaluations",
                ShortSideJsonValue::Num(self.transform_evaluations),
            ),
            (
                "candidateEvaluations",
                ShortSideJsonValue::Num(self.candidate_evaluations),
            ),
            (
                "backtrackCount",
                ShortSideJsonValue::Num(self.backtrack_count),
            ),
            (
                "reusedPrefixPlacements",
                ShortSideJsonValue::Num(self.reused_prefix_placements),
            ),
            ("placedCount", ShortSideJsonValue::Num(self.placed_count)),
            (
                "requestedCount",
                ShortSideJsonValue::Num(self.requested_count),
            ),
            ("runtimeMs", ShortSideJsonValue::Num(self.runtime_ms)),
            (
                "peakRssDeltaBytes",
                ShortSideJsonValue::Num(self.peak_rss_delta_bytes),
            ),
            (
                "failureReason",
                ShortSideJsonValue::opt_str(self.failure_reason.as_deref()),
            ),
        ])
    }
}

/// TS: `intrinsicShortSideContactStrip.ts:73-76`
/// `IntrinsicShortSideContactStripOutcome`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideContactStripOutcome {
    pub trace: IntrinsicShortSideContactStripTrace,
    pub placed_collision_geometries: Option<Vec<Arc<IrregularPlacedPiece>>>,
}

/// TS: `intrinsicShortSideContactStrip.ts:98-115`
/// `IntrinsicShortSideContactStripTieEvidence`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideContactStripTieEvidence {
    pub piece_index: f64,
    pub tied_count: f64,
    pub winner_score: Option<String>,
    pub best_alternative_score: Option<String>,
    pub winner_max_corner_shared_by_all_tied: bool,
    pub selection_changed: bool,
    pub scores: Vec<IntrinsicShortSideContactStripTieScoreEntry>,
}

/// TS: `intrinsicShortSideContactStrip.ts:105-114`'s inline `scores` element
/// type.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicShortSideContactStripTieScoreEntry {
    pub transform_index: f64,
    pub rotation_deg: f64,
    pub mirrored: bool,
    pub translation_short_axis_grid: f64,
    pub translation_long_axis_grid: f64,
    pub max_short_axis_grid: f64,
    pub max_long_axis_grid: f64,
    pub contact_axis_units: Option<String>,
}

// ===========================================================================
// Runtime control input (`:79-87`)
// ===========================================================================

/// TS: `intrinsicShortSideContactStrip.ts:79-87`
/// `IntrinsicShortSideContactStripRuntimeControl`. `tie_evidence_sink` is
/// deliberately not a field here -- see this module's top doc, "Seams".
#[derive(Default)]
pub struct IntrinsicShortSideContactStripRuntimeControl<'a> {
    pub maximum_runtime_ms: Option<f64>,
    pub maximum_rss_delta_bytes: Option<f64>,
    pub maximum_candidate_evaluations: Option<f64>,
    pub maximum_backtracks: Option<f64>,
    pub now: Option<&'a dyn Fn() -> f64>,
    /// Boxed (not a plain `&'a dyn Fn() -> f64` reference) because
    /// `short_side::pair_fold::strip_runtime_control` must synthesize a
    /// fresh closure per contact-strip lane that captures the outer
    /// observer's own `ObserverRuntime` by reference and folds every sample
    /// into its `peak_rss_bytes` `Cell` as a side effect (TS:
    /// `currentRssBytes: () => {...}` closures created fresh per lane,
    /// `intrinsicShortSidePairFoldObserver.ts:544-548` etc.) -- a plain
    /// `&'a dyn Fn() -> f64` cannot borrow a closure temporary constructed
    /// and returned from that helper function, since nothing outlives the
    /// call to hold it. See that function's own doc comment.
    pub current_rss_bytes: Option<Box<dyn Fn() -> f64 + 'a>>,
}

struct StripRuntime<'a> {
    started_at: f64,
    starting_rss_bytes: f64,
    peak_rss_bytes: f64,
    transform_evaluations: f64,
    candidate_evaluations: f64,
    placed_count: f64,
    backtrack_count: f64,
    reused_prefix_placements: f64,
    maximum_runtime_ms: f64,
    maximum_rss_delta_bytes: f64,
    maximum_candidate_evaluations: f64,
    maximum_backtracks: f64,
    now: &'a dyn Fn() -> f64,
    current_rss_bytes: &'a dyn Fn() -> f64,
}

fn default_timing_now() -> f64 {
    static PROCESS_START: std::sync::LazyLock<std::time::Instant> =
        std::sync::LazyLock::new(std::time::Instant::now);
    PROCESS_START.elapsed().as_secs_f64() * 1000.0
}

/// See this module's top doc, "Seams", for why this always returns `0.0`.
fn default_current_rss_bytes() -> f64 {
    0.0
}

/// TS: `intrinsicShortSideContactStrip.ts:801-804` (`boundedStatus`).
fn bounded_status(runtime: &mut StripRuntime<'_>) -> Option<BoundedStatus> {
    if (runtime.now)() - runtime.started_at > runtime.maximum_runtime_ms {
        return Some(BoundedStatus::Deadline);
    }
    if sample_rss(runtime) > runtime.maximum_rss_delta_bytes {
        Some(BoundedStatus::MemoryCap)
    } else {
        None
    }
}

/// TS: `intrinsicShortSideContactStrip.ts:806-808` (`sampleRss`).
fn sample_rss(runtime: &mut StripRuntime<'_>) -> f64 {
    runtime.peak_rss_bytes = js_math::max(runtime.peak_rss_bytes, (runtime.current_rss_bytes)());
    js_math::max(0.0, runtime.peak_rss_bytes - runtime.starting_rss_bytes)
}

// ===========================================================================
// Anchored candidates and the exact contact tuple (`:134-147,449-723`)
// ===========================================================================

/// TS: `intrinsicShortSideContactStrip.ts:135-147` `AnchoredCandidate`.
#[derive(Clone, Debug, PartialEq)]
struct AnchoredCandidate {
    candidate_point_x: f64,
    candidate_point_y: f64,
    moving: TransformedCollisionGeometry,
    anchor_long_axis_grid: f64,
    anchor_short_axis_grid: f64,
    translation_long_axis_grid: f64,
    translation_short_axis_grid: f64,
    max_long_axis_grid: f64,
    max_short_axis_grid: f64,
    transform_index: f64,
    rotation_deg: f64,
    mirrored: bool,
}

/// TS: `intrinsicShortSideContactStrip.ts:149-154`
/// `ContactDecisionCheckpoint`.
struct ContactDecisionCheckpoint {
    piece_index: usize,
    placed_before: Vec<Arc<IrregularPlacedPiece>>,
    collision_index_before: PlacedCollisionSpatialIndex,
    baseline_piece: Arc<IrregularPlacedPiece>,
}

/// TS: `intrinsicShortSideContactStrip.ts:456-489` (`anchorCandidate`).
///
/// The anchor is the minimum corner of the placed collision bounds rather
/// than the candidate translation, so the comparison is independent of each
/// piece's placement-reference convention.
fn anchor_candidate(
    candidate_point_x: f64,
    candidate_point_y: f64,
    moving: &TransformedCollisionGeometry,
) -> Option<AnchoredCandidate> {
    let anchor_short_axis_grid = to_grid_mm(moving.bounds.min_x + candidate_point_x)?;
    let anchor_long_axis_grid = to_grid_mm(moving.bounds.min_y + candidate_point_y)?;
    let translation_short_axis_grid = to_grid_mm(candidate_point_x)?;
    let translation_long_axis_grid = to_grid_mm(candidate_point_y)?;
    let max_short_axis_grid = to_grid_mm(moving.bounds.max_x + candidate_point_x)?;
    let max_long_axis_grid = to_grid_mm(moving.bounds.max_y + candidate_point_y)?;
    Some(AnchoredCandidate {
        candidate_point_x,
        candidate_point_y,
        moving: moving.clone(),
        anchor_long_axis_grid,
        anchor_short_axis_grid,
        translation_long_axis_grid,
        translation_short_axis_grid,
        max_long_axis_grid,
        max_short_axis_grid,
        transform_index: moving.transform.index,
        rotation_deg: moving.transform.rotation_deg,
        mirrored: moving.transform.mirrored,
    })
}

/// TS: `intrinsicShortSideContactStrip.ts:518-530`
/// (`compareAnchoredCandidates`). The directional bottom-left contract for
/// contact-strip candidate selection.
fn compare_anchored_candidates(first: &AnchoredCandidate, second: &AnchoredCandidate) -> Ordering {
    compare_f64(first.max_long_axis_grid, second.max_long_axis_grid)
        .then_with(|| compare_f64(first.anchor_long_axis_grid, second.anchor_long_axis_grid))
        .then_with(|| compare_f64(first.anchor_short_axis_grid, second.anchor_short_axis_grid))
        .then_with(|| compare_f64(first.max_short_axis_grid, second.max_short_axis_grid))
        .then_with(|| {
            compare_f64(
                first.translation_short_axis_grid,
                second.translation_short_axis_grid,
            )
        })
        .then_with(|| {
            compare_f64(
                first.translation_long_axis_grid,
                second.translation_long_axis_grid,
            )
        })
        .then_with(|| compare_f64(first.transform_index, second.transform_index))
        .then_with(|| compare_f64(first.rotation_deg, second.rotation_deg))
        .then_with(|| first.mirrored.cmp(&second.mirrored))
}

/// TS: `intrinsicShortSideContactStrip.ts:501-504` `ContactScore`.
#[derive(Clone, Debug, PartialEq)]
struct ContactScore {
    positive_contact_count: f64,
    axis_units: BigInt,
}

/// TS: `intrinsicShortSideContactStrip.ts:708-717` (`compareContactScores`).
fn compare_contact_scores(first: &ContactScore, second: &ContactScore) -> Ordering {
    if first.positive_contact_count != second.positive_contact_count {
        return compare_f64(first.positive_contact_count, second.positive_contact_count);
    }
    first.axis_units.cmp(&second.axis_units)
}

/// TS: `intrinsicShortSideContactStrip.ts:719-723` (`serializeContactScore`).
fn serialize_contact_score(score: Option<&ContactScore>) -> Option<String> {
    score.map(|score| format!("{}:{}", score.positive_contact_count, score.axis_units))
}

/// TS: `intrinsicShortSideContactStrip.ts:656-706`
/// (`candidateContactAxisUnits`). Measures exact positive contact against
/// the placed pieces -- **this is the exact Short Side contact tuple** (see
/// this module's top doc and `short-side.md` §6.12): diagonal and
/// axis-aligned contacts both contribute to `positive_contact_count`, while
/// `axis_units` sums only the axis-aligned portion of those contacts, per
/// placed-piece-pair (a diagonal contact against one placed piece zeroes
/// only that one placed piece's contribution to `axis_units`, not the whole
/// candidate's score).
fn candidate_contact_axis_units(
    anchored: &AnchoredCandidate,
    placed: &[Arc<IrregularPlacedPiece>],
    piece: &IrregularPreparedPiece,
    runtime: &mut StripRuntime<'_>,
) -> (Option<ContactScore>, Option<BoundedStatus>) {
    let placed_piece = IrregularPlacedPiece {
        placement: make_strip_placement(piece, anchored),
        collision_geometry: anchored.moving.clone(),
    };
    let Some(world_path) = placed_collision_world_grid_path(&placed_piece) else {
        return (None, None);
    };
    let mut positive_contact_count = 0.0_f64;
    let mut axis_units = BigInt::from(0);
    for placed_piece_entry in placed {
        if let Some(bounded) = bounded_status(runtime) {
            return (None, Some(bounded));
        }
        let Some(placed_world_path) = placed_collision_world_grid_path(placed_piece_entry) else {
            return (None, None);
        };
        let Some(has_positive_contact) =
            has_positive_canonical_grid_boundary_contact(&world_path, &placed_world_path)
        else {
            return (None, None);
        };
        if has_positive_contact {
            positive_contact_count += 1.0;
        }
        let mut bounded_during_scan: Option<BoundedStatus> = None;
        let overlap = {
            let mut checked = || -> bool {
                match bounded_status(runtime) {
                    None => true,
                    Some(bounded) => {
                        bounded_during_scan = Some(bounded);
                        false
                    }
                }
            };
            measure_canonical_grid_boundary_overlap_axis_units(
                &world_path,
                &placed_world_path,
                Some(&mut checked),
            )
        };
        match overlap {
            CanonicalGridBoundaryOverlapAxisUnitsResult::Aborted => {
                return (None, bounded_during_scan);
            }
            CanonicalGridBoundaryOverlapAxisUnitsResult::Undecidable => continue,
            CanonicalGridBoundaryOverlapAxisUnitsResult::Measured { score } => {
                axis_units += score;
            }
        }
    }
    (
        Some(ContactScore {
            positive_contact_count,
            axis_units,
        }),
        None,
    )
}

// ===========================================================================
// `selectContactAwareWinner` (`:532-654`)
// ===========================================================================

struct ContactAwareSelection {
    winner: AnchoredCandidate,
    baseline_winner: AnchoredCandidate,
    tied_count: usize,
    tied: Vec<AnchoredCandidate>,
    winner_score: Option<ContactScore>,
    baseline_score: Option<ContactScore>,
    selection_changed: bool,
}

enum ContactAwareSelectionResult {
    // Boxed: `ContactAwareSelection` is far larger than `Bounded`'s payload
    // (`clippy::large_enum_variant`); boxing keeps every `ContactAwareSelectionResult`
    // value itself small regardless of which variant it holds.
    Selection(Box<ContactAwareSelection>),
    Bounded(BoundedStatus),
    None,
}

/// TS: `intrinsicShortSideContactStrip.ts:542-654`
/// (`selectContactAwareWinner`).
///
/// Orders candidates by the directional bottom-left contract via
/// [`compare_anchored_candidates`]. The depth-first policy limits contact
/// comparison to candidates sharing the shallowest maximum long-axis extent.
/// The contact-first policy compares every legal candidate by exact
/// positive-contact count, exact axis-overlap units, then the deterministic
/// depth/anchor order. Reference identity of TS's `challenger === baseline`
/// check (`:607`) is reproduced here via index identity into `candidates`
/// (each element of that slice corresponds to exactly one distinct pushed
/// TS object -- see this function's own inline note).
fn select_contact_aware_winner(
    candidates: &[AnchoredCandidate],
    placed: &[Arc<IrregularPlacedPiece>],
    piece: &IrregularPreparedPiece,
    selection_policy: IntrinsicShortSideContactStripSelectionPolicy,
    runtime: &mut StripRuntime<'_>,
) -> ContactAwareSelectionResult {
    let mut baseline_index: Option<usize> = None;
    for (index, anchored) in candidates.iter().enumerate() {
        if let Some(bounded) = bounded_status(runtime) {
            return ContactAwareSelectionResult::Bounded(bounded);
        }
        let replace = match baseline_index {
            None => true,
            Some(current) => {
                compare_anchored_candidates(anchored, &candidates[current]) == Ordering::Less
            }
        };
        if replace {
            baseline_index = Some(index);
        }
    }
    let Some(baseline_index) = baseline_index else {
        return ContactAwareSelectionResult::None;
    };

    let mut tied_indices: Vec<usize> = Vec::new();
    for (index, anchored) in candidates.iter().enumerate() {
        if let Some(bounded) = bounded_status(runtime) {
            return ContactAwareSelectionResult::Bounded(bounded);
        }
        if selection_policy == IntrinsicShortSideContactStripSelectionPolicy::ContactFirst
            || anchored.max_long_axis_grid == candidates[baseline_index].max_long_axis_grid
        {
            tied_indices.push(index);
        }
    }
    let tied: Vec<AnchoredCandidate> = tied_indices
        .iter()
        .map(|&index| candidates[index].clone())
        .collect();
    let baseline = candidates[baseline_index].clone();
    if tied.len() < 2 {
        return ContactAwareSelectionResult::Selection(Box::new(ContactAwareSelection {
            winner: baseline.clone(),
            baseline_winner: baseline,
            tied_count: tied.len(),
            tied,
            winner_score: None,
            baseline_score: None,
            selection_changed: false,
        }));
    }

    let (baseline_score, bounded) = candidate_contact_axis_units(&baseline, placed, piece, runtime);
    if let Some(bounded) = bounded {
        return ContactAwareSelectionResult::Bounded(bounded);
    }
    let Some(baseline_score) = baseline_score else {
        return ContactAwareSelectionResult::Selection(Box::new(ContactAwareSelection {
            winner: baseline.clone(),
            baseline_winner: baseline,
            tied_count: tied.len(),
            tied,
            winner_score: None,
            baseline_score: None,
            selection_changed: false,
        }));
    };

    let mut winner_index = baseline_index;
    let mut winner_score = baseline_score.clone();
    for &challenger_index in &tied_indices {
        if let Some(bounded) = bounded_status(runtime) {
            return ContactAwareSelectionResult::Bounded(bounded);
        }
        if challenger_index == baseline_index {
            continue;
        }
        let challenger = &candidates[challenger_index];
        if selection_policy == IntrinsicShortSideContactStripSelectionPolicy::DepthFirst
            && challenger.max_long_axis_grid > baseline.max_long_axis_grid
        {
            continue;
        }
        let (challenger_score, bounded) =
            candidate_contact_axis_units(challenger, placed, piece, runtime);
        if let Some(bounded) = bounded {
            return ContactAwareSelectionResult::Bounded(bounded);
        }
        let Some(challenger_score) = challenger_score else {
            return ContactAwareSelectionResult::Selection(Box::new(ContactAwareSelection {
                winner: baseline.clone(),
                baseline_winner: baseline,
                tied_count: tied.len(),
                tied,
                winner_score: Some(baseline_score.clone()),
                baseline_score: Some(baseline_score),
                selection_changed: false,
            }));
        };
        let score_order = compare_contact_scores(&challenger_score, &winner_score);
        if score_order == Ordering::Greater
            || (score_order == Ordering::Equal
                && compare_anchored_candidates(challenger, &candidates[winner_index])
                    == Ordering::Less)
        {
            winner_index = challenger_index;
            winner_score = challenger_score;
        }
    }
    ContactAwareSelectionResult::Selection(Box::new(ContactAwareSelection {
        winner: candidates[winner_index].clone(),
        baseline_winner: baseline,
        tied_count: tied.len(),
        tied,
        winner_score: Some(winner_score),
        baseline_score: Some(baseline_score),
        selection_changed: winner_index != baseline_index,
    }))
}

/// TS: `intrinsicShortSideContactStrip.ts:725-780` (`measureTieEvidence`).
fn measure_tie_evidence(
    piece_index: f64,
    selection: &ContactAwareSelection,
    placed: &[Arc<IrregularPlacedPiece>],
    piece: &IrregularPreparedPiece,
    runtime: &mut StripRuntime<'_>,
) -> IntrinsicShortSideContactStripTieEvidence {
    let winner_key = (
        selection.winner.transform_index,
        selection.winner.rotation_deg,
        selection.winner.mirrored,
        selection.winner.translation_short_axis_grid,
        selection.winner.translation_long_axis_grid,
    );
    let baseline_key = (
        selection.baseline_winner.transform_index,
        selection.baseline_winner.rotation_deg,
        selection.baseline_winner.mirrored,
        selection.baseline_winner.translation_short_axis_grid,
        selection.baseline_winner.translation_long_axis_grid,
    );
    let anchored_key = |anchored: &AnchoredCandidate| {
        (
            anchored.transform_index,
            anchored.rotation_deg,
            anchored.mirrored,
            anchored.translation_short_axis_grid,
            anchored.translation_long_axis_grid,
        )
    };

    let scored: Vec<(AnchoredCandidate, Option<ContactScore>)> = selection
        .tied
        .iter()
        .map(|anchored| {
            let key = anchored_key(anchored);
            if key == winner_key {
                (anchored.clone(), selection.winner_score.clone())
            } else if key == baseline_key {
                (anchored.clone(), selection.baseline_score.clone())
            } else {
                let (score, bounded) =
                    candidate_contact_axis_units(anchored, placed, piece, runtime);
                (
                    anchored.clone(),
                    if bounded.is_none() { score } else { None },
                )
            }
        })
        .collect();

    let mut best_alternative_score: Option<ContactScore> = None;
    for (anchored, score) in &scored {
        if anchored_key(anchored) == winner_key {
            continue;
        }
        if let Some(score) = score {
            best_alternative_score = match &best_alternative_score {
                None => Some(score.clone()),
                Some(maximum) => {
                    if compare_contact_scores(score, maximum) == Ordering::Greater {
                        Some(score.clone())
                    } else {
                        Some(maximum.clone())
                    }
                }
            };
        }
    }

    let winner_max_corner_shared_by_all_tied = selection.tied.iter().all(|anchored| {
        anchored.max_long_axis_grid == selection.baseline_winner.max_long_axis_grid
            && anchored.max_short_axis_grid == selection.baseline_winner.max_short_axis_grid
    });

    IntrinsicShortSideContactStripTieEvidence {
        piece_index,
        tied_count: selection.tied_count as f64,
        winner_score: serialize_contact_score(selection.winner_score.as_ref()),
        best_alternative_score: serialize_contact_score(best_alternative_score.as_ref()),
        winner_max_corner_shared_by_all_tied,
        selection_changed: selection.selection_changed,
        scores: scored
            .into_iter()
            .map(
                |(anchored, score)| IntrinsicShortSideContactStripTieScoreEntry {
                    transform_index: anchored.transform_index,
                    rotation_deg: anchored.rotation_deg,
                    mirrored: anchored.mirrored,
                    translation_short_axis_grid: anchored.translation_short_axis_grid,
                    translation_long_axis_grid: anchored.translation_long_axis_grid,
                    max_short_axis_grid: anchored.max_short_axis_grid,
                    max_long_axis_grid: anchored.max_long_axis_grid,
                    contact_axis_units: serialize_contact_score(score.as_ref()),
                },
            )
            .collect(),
    }
}

/// TS: `intrinsicShortSideContactStrip.ts:782-799` (`makeStripPlacement`).
fn make_strip_placement(
    piece: &IrregularPreparedPiece,
    anchored: &AnchoredCandidate,
) -> IrregularPlacement {
    IrregularPlacement {
        piece_id: piece.piece_id.clone(),
        source_piece_id: piece.source.id.clone(),
        placement_reference: Some(piece.collision_geometry.placement_reference),
        transform: IrregularTransform {
            translate_x: anchored.candidate_point_x,
            translate_y: anchored.candidate_point_y,
            rotation_deg: anchored.rotation_deg,
            mirrored: anchored.mirrored,
        },
    }
}

fn prepared_piece_id(piece: &IrregularPreparedPiece) -> PieceId {
    piece
        .piece_id
        .clone()
        .unwrap_or_else(|| piece.source.id.clone())
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
// `constructStrip` (`:232-447`)
// ===========================================================================

/// TS: `intrinsicShortSideContactStrip.ts:171-177` input (the resolved
/// `selectionPolicy`/`orderPolicy` defaults are applied by
/// [`construct_intrinsic_short_side_contact_strip`] before this struct is
/// built, matching TS's `input.selectionPolicy ?? 'depth-first'` /
/// `input.orderPolicy ?? 'prepared'` call-site defaulting).
struct ConstructStripInput<'a> {
    strip_sheet: &'a SheetSpec,
    prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    settings: &'a IrregularNestingSettings,
    selection_policy: IntrinsicShortSideContactStripSelectionPolicy,
    order_policy: IntrinsicShortSideContactStripOrderPolicy,
}

fn construct_strip(
    input: &ConstructStripInput<'_>,
    runtime: &mut StripRuntime<'_>,
    geometry_cache: &mut GeometryCacheStore,
    mut tie_evidence_sink: Option<&mut dyn FnMut(IntrinsicShortSideContactStripTieEvidence)>,
) -> Result<IntrinsicShortSideContactStripOutcome, NfpIfpError> {
    let mut placed: Vec<Arc<IrregularPlacedPiece>> = Vec::new();
    let mut placed_collision_index: PlacedCollisionSpatialIndex =
        make_empty_placed_collision_spatial_index(None);
    let mut checkpoints: Vec<ContactDecisionCheckpoint> = Vec::new();

    let mut piece_index: usize = 0;
    while piece_index < input.prepared_pieces.len() {
        let piece = Arc::clone(&input.prepared_pieces[piece_index]);
        if let Some(bounded) = bounded_status(runtime) {
            return Ok(failed_outcome(
                input,
                runtime,
                bounded.to_status(),
                format!(
                    "{} reached after {} contact placements.",
                    bounded.as_str(),
                    placed.len()
                ),
                placed.len() as f64,
            ));
        }
        let mut anchored_candidates: Vec<AnchoredCandidate> = Vec::new();
        for transform in &piece.transforms {
            runtime.transform_evaluations += 1.0;
            let moving = transform_collision_geometry(
                &piece.collision_geometry,
                transform,
                &input.settings.geometry,
                geometry_cache,
            )
            .map_err(NfpIfpError::Geometry)?;
            let generate_input = GeneratePlacementCandidatesInput {
                sheet: input.strip_sheet,
                placed: &placed,
                placed_collision_index: Some(&placed_collision_index),
                moving: &moving,
                settings: input.settings,
                candidate_domain: CandidateDomain::Sheet,
                want_provenance: false,
            };
            let candidates = {
                let mut control =
                    |phase: NfpIfpCheckpointPhase| -> Result<(), NfpIfpControlAbortError> {
                        match bounded_status(runtime) {
                            None => Ok(()),
                            Some(bounded) => Err(NfpIfpControlAbortError {
                                reason: if bounded == BoundedStatus::Deadline {
                                    NfpIfpAbortReason::Deadline
                                } else {
                                    NfpIfpAbortReason::Cancelled
                                },
                                message: format!(
                                    "{} reached during contact-strip {}.",
                                    bounded.as_str(),
                                    phase.as_str()
                                ),
                            }),
                        }
                    };
                generate_placement_candidates(
                    &generate_input,
                    geometry_cache,
                    DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
                    NfpCandidatePruningMode::Indexed,
                    None,
                    None,
                    Some(&mut control),
                )?
                .candidates
            };
            if let Some(bounded) = bounded_status(runtime) {
                return Ok(failed_outcome(
                    input,
                    runtime,
                    bounded.to_status(),
                    format!(
                        "{} reached after contact candidate generation.",
                        bounded.as_str()
                    ),
                    placed.len() as f64,
                ));
            }
            for candidate in &candidates {
                runtime.candidate_evaluations += 1.0;
                if runtime.candidate_evaluations > runtime.maximum_candidate_evaluations {
                    return Ok(failed_outcome(
                        input,
                        runtime,
                        IntrinsicShortSideContactStripStatus::EvaluationCap,
                        format!(
                            "evaluation-cap reached after {} contact candidate anchors.",
                            runtime.candidate_evaluations - 1.0
                        ),
                        placed.len() as f64,
                    ));
                }
                if let Some(bounded) = bounded_status(runtime) {
                    return Ok(failed_outcome(
                        input,
                        runtime,
                        bounded.to_status(),
                        format!(
                            "{} reached after {} contact candidate anchors.",
                            bounded.as_str(),
                            runtime.candidate_evaluations
                        ),
                        placed.len() as f64,
                    ));
                }
                if let Some(anchored) =
                    anchor_candidate(candidate.point.x, candidate.point.y, &moving)
                {
                    anchored_candidates.push(anchored);
                }
            }
        }

        let selection_result = select_contact_aware_winner(
            &anchored_candidates,
            &placed,
            &piece,
            input.selection_policy,
            runtime,
        );
        match selection_result {
            ContactAwareSelectionResult::Bounded(bounded) => {
                return Ok(failed_outcome(
                    input,
                    runtime,
                    bounded.to_status(),
                    format!(
                        "{} reached during contact-aware tie selection.",
                        bounded.as_str()
                    ),
                    placed.len() as f64,
                ));
            }
            ContactAwareSelectionResult::None => {
                let checkpoint = if input.selection_policy
                    == IntrinsicShortSideContactStripSelectionPolicy::ContactFirst
                {
                    checkpoints.pop()
                } else {
                    None
                };
                if let Some(checkpoint) = checkpoint {
                    if runtime.backtrack_count >= runtime.maximum_backtracks {
                        return Ok(failed_outcome(
                            input,
                            runtime,
                            IntrinsicShortSideContactStripStatus::EvaluationCap,
                            format!(
                                "backtrack cap reached after {} resumable contact decisions.",
                                runtime.backtrack_count
                            ),
                            placed.len() as f64,
                        ));
                    }
                    let mut resumed = checkpoint.placed_before.clone();
                    resumed.push(Arc::clone(&checkpoint.baseline_piece));
                    let reused_prefix_len = checkpoint.placed_before.len() as f64;
                    placed_collision_index = checkpoint
                        .collision_index_before
                        .add(Arc::clone(&checkpoint.baseline_piece));
                    placed = resumed;
                    runtime.backtrack_count += 1.0;
                    runtime.reused_prefix_placements += reused_prefix_len;
                    runtime.placed_count = placed.len() as f64;
                    piece_index = checkpoint.piece_index + 1;
                    continue;
                }
                return Ok(failed_outcome(
                    input,
                    runtime,
                    IntrinsicShortSideContactStripStatus::NoLegalPlacement,
                    format!(
                        "piece {} has no legal contact placement inside the requested short-axis strip.",
                        prepared_piece_id(&piece).as_str()
                    ),
                    placed.len() as f64,
                ));
            }
            ContactAwareSelectionResult::Selection(selection) => {
                if selection.tied_count >= 2 {
                    if let Some(sink) = tie_evidence_sink.as_deref_mut() {
                        let evidence = measure_tie_evidence(
                            placed.len() as f64,
                            &selection,
                            &placed,
                            &piece,
                            runtime,
                        );
                        sink(evidence);
                    }
                }
                let placed_piece = Arc::new(IrregularPlacedPiece {
                    placement: make_strip_placement(&piece, &selection.winner),
                    collision_geometry: selection.winner.moving.clone(),
                });
                if selection.selection_changed {
                    checkpoints.push(ContactDecisionCheckpoint {
                        piece_index,
                        placed_before: placed.clone(),
                        collision_index_before: placed_collision_index.clone(),
                        baseline_piece: Arc::new(IrregularPlacedPiece {
                            placement: make_strip_placement(&piece, &selection.baseline_winner),
                            collision_geometry: selection.baseline_winner.moving.clone(),
                        }),
                    });
                }
                placed.push(Arc::clone(&placed_piece));
                runtime.placed_count = placed.len() as f64;
                placed_collision_index = placed_collision_index.add(placed_piece);
                piece_index += 1;
            }
        }
    }

    if let Some(bounded) = bounded_status(runtime) {
        return Ok(failed_outcome(
            input,
            runtime,
            bounded.to_status(),
            format!(
                "{} reached after completing {} contact placements.",
                bounded.as_str(),
                placed.len()
            ),
            placed.len() as f64,
        ));
    }
    Ok(IntrinsicShortSideContactStripOutcome {
        trace: IntrinsicShortSideContactStripTrace {
            version: INTRINSIC_SHORT_SIDE_CONTACT_STRIP_VERSION,
            status: IntrinsicShortSideContactStripStatus::Constructed,
            execution_model: "single-process-sequential",
            selection_policy: input.selection_policy,
            order_policy: input.order_policy,
            strip_short_axis_mm: input.strip_sheet.width,
            strip_long_axis_mm: input.strip_sheet.height,
            transform_evaluations: runtime.transform_evaluations,
            candidate_evaluations: runtime.candidate_evaluations,
            backtrack_count: runtime.backtrack_count,
            reused_prefix_placements: runtime.reused_prefix_placements,
            placed_count: placed.len() as f64,
            requested_count: input.prepared_pieces.len() as f64,
            runtime_ms: js_math::max(0.0, (runtime.now)() - runtime.started_at),
            peak_rss_delta_bytes: sample_rss(runtime),
            failure_reason: None,
        },
        placed_collision_geometries: Some(placed),
    })
}

/// TS: `intrinsicShortSideContactStrip.ts:811-844` (`failedOutcome`).
fn failed_outcome(
    input: &ConstructStripInput<'_>,
    runtime: &mut StripRuntime<'_>,
    status: IntrinsicShortSideContactStripStatus,
    failure_reason: String,
    placed_count: f64,
) -> IntrinsicShortSideContactStripOutcome {
    IntrinsicShortSideContactStripOutcome {
        trace: IntrinsicShortSideContactStripTrace {
            version: INTRINSIC_SHORT_SIDE_CONTACT_STRIP_VERSION,
            status,
            execution_model: "single-process-sequential",
            selection_policy: input.selection_policy,
            order_policy: input.order_policy,
            strip_short_axis_mm: input.strip_sheet.width,
            strip_long_axis_mm: input.strip_sheet.height,
            transform_evaluations: runtime.transform_evaluations,
            candidate_evaluations: runtime.candidate_evaluations,
            backtrack_count: runtime.backtrack_count,
            reused_prefix_placements: runtime.reused_prefix_placements,
            placed_count,
            requested_count: input.prepared_pieces.len() as f64,
            runtime_ms: js_math::max(0.0, (runtime.now)() - runtime.started_at),
            peak_rss_delta_bytes: sample_rss(runtime),
            failure_reason: Some(failure_reason),
        },
        placed_collision_geometries: None,
    }
}

// ===========================================================================
// Public entry point (`:171-230`)
// ===========================================================================

/// TS: `intrinsicShortSideContactStrip.ts:171-177` input.
pub struct ConstructIntrinsicShortSideContactStripInput<'a> {
    pub strip_sheet: &'a SheetSpec,
    pub prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    pub settings: &'a IrregularNestingSettings,
    pub selection_policy: Option<IntrinsicShortSideContactStripSelectionPolicy>,
    pub order_policy: Option<IntrinsicShortSideContactStripOrderPolicy>,
    pub runtime_control: Option<IntrinsicShortSideContactStripRuntimeControl<'a>>,
}

/// TS: `intrinsicShortSideContactStrip.ts:171-230`
/// (`constructIntrinsicShortSideContactStrip`). See this module's top doc
/// for the `geometry_cache`/`tie_evidence_sink` seams.
pub fn construct_intrinsic_short_side_contact_strip(
    input: ConstructIntrinsicShortSideContactStripInput<'_>,
    geometry_cache: &mut GeometryCacheStore,
    tie_evidence_sink: Option<&mut dyn FnMut(IntrinsicShortSideContactStripTieEvidence)>,
) -> IntrinsicShortSideContactStripOutcome {
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
        .and_then(|control| control.current_rss_bytes.as_deref())
        .unwrap_or(default_rss_ref);
    let starting_rss_bytes = current_rss_bytes();
    let mut runtime = StripRuntime {
        started_at: now(),
        starting_rss_bytes,
        peak_rss_bytes: starting_rss_bytes,
        transform_evaluations: 0.0,
        candidate_evaluations: 0.0,
        placed_count: 0.0,
        backtrack_count: 0.0,
        reused_prefix_placements: 0.0,
        maximum_runtime_ms: input
            .runtime_control
            .as_ref()
            .and_then(|control| control.maximum_runtime_ms)
            .unwrap_or(INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS),
        maximum_rss_delta_bytes: input
            .runtime_control
            .as_ref()
            .and_then(|control| control.maximum_rss_delta_bytes)
            .unwrap_or(INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES),
        maximum_candidate_evaluations: input
            .runtime_control
            .as_ref()
            .and_then(|control| control.maximum_candidate_evaluations)
            .unwrap_or(f64::INFINITY),
        maximum_backtracks: input
            .runtime_control
            .as_ref()
            .and_then(|control| control.maximum_backtracks)
            .unwrap_or(f64::INFINITY),
        now,
        current_rss_bytes,
    };

    let construct_input = ConstructStripInput {
        strip_sheet: input.strip_sheet,
        prepared_pieces: input.prepared_pieces,
        settings: input.settings,
        selection_policy: input
            .selection_policy
            .unwrap_or(IntrinsicShortSideContactStripSelectionPolicy::DepthFirst),
        order_policy: input
            .order_policy
            .unwrap_or(IntrinsicShortSideContactStripOrderPolicy::Prepared),
    };

    match construct_strip(
        &construct_input,
        &mut runtime,
        geometry_cache,
        tie_evidence_sink,
    ) {
        Ok(outcome) => outcome,
        Err(NfpIfpError::Abort(error)) => {
            let bounded = bounded_status(&mut runtime).unwrap_or(BoundedStatus::Deadline);
            let placed_count = runtime.placed_count;
            failed_outcome(
                &construct_input,
                &mut runtime,
                bounded.to_status(),
                error.message,
                placed_count,
            )
        }
        Err(NfpIfpError::Geometry(error)) => failed_outcome(
            &construct_input,
            &mut runtime,
            IntrinsicShortSideContactStripStatus::FailedProtectedFallback,
            error.message,
            0.0,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contact_score_ordering_prefers_higher_contact_count_then_axis_units() {
        let low = ContactScore {
            positive_contact_count: 1.0,
            axis_units: BigInt::from(1000),
        };
        let high_count = ContactScore {
            positive_contact_count: 2.0,
            axis_units: BigInt::from(0),
        };
        assert_eq!(compare_contact_scores(&high_count, &low), Ordering::Greater);

        let higher_axis_units = ContactScore {
            positive_contact_count: 1.0,
            axis_units: BigInt::from(2000),
        };
        assert_eq!(
            compare_contact_scores(&higher_axis_units, &low),
            Ordering::Greater
        );
    }

    #[test]
    fn serialize_contact_score_matches_positive_count_colon_axis_units() {
        let score = ContactScore {
            positive_contact_count: 2.0,
            axis_units: BigInt::from(1500),
        };
        assert_eq!(
            serialize_contact_score(Some(&score)),
            Some("2:1500".to_string())
        );
        assert_eq!(serialize_contact_score(None), None);
    }
}
