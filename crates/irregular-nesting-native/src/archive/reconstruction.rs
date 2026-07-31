//! Bounded, deterministic re-decode harness over one protected sheetless
//! endpoint.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.ts`
//! (604 lines), ported in full per
//! `docs/planning/rust-irregular-backend/characterization/reconstruction.md`
//! (this module's governing source; every section is load-bearing). That
//! document's §1.1 "Production liveness" note is important context but does
//! not change scope here: every exported function is ported bit-for-bit,
//! including the two dead-on-production-path pieces
//! (`retain_intrinsic_reconstruction_archive`'s `.archive`/`.winner`
//! plumbing, and the `'order'`/`'archive'` `IntrinsicReconstructionPortfolioError`
//! operation variants that are declared but never constructed) — both are
//! directly unit-tested in TS and the migration prompt treats existing
//! tests as immutable (R3).
//!
//! # Reused (GREEN) modules -- never duplicated here
//!
//! - `search::strict_decoder::{construct_intrinsic_strict_state,
//!   measure_intrinsic_sheetless_completed_layout,
//!   rank_intrinsic_strict_completed_layouts,
//!   select_intrinsic_strict_completed_pareto_front,
//!   IntrinsicStrictCandidateMode, IntrinsicStrictComparatorMode,
//!   IntrinsicStrictCompletedMetrics, IntrinsicStrictDecoderFailure,
//!   IntrinsicStrictConstructResult, ConstructIntrinsicStrictStateInput,
//!   TruncationReason}` -- the strict sheetless constructor and its
//!   completed-layout measurement/ranking helpers this file only ever calls,
//!   never reimplements.
//! - `canonical_grid::layout::placed_collision_world_grid_path` -- the
//!   authoritative placed-collision world-grid path (with its own signed-zero
//!   fold), used unmodified by `build_canonical_endpoint_orders`.
//! - `canonical_grid::to_grid_mm` -- the float<->grid quantization authority
//!   `intrinsic_prepared_piece_class_key` requires.
//! - `checkpoints::canonical_json::locale_compare_keys` -- every
//!   `.localeCompare()` call site in the original file (`buildCanonicalEndpointOrders`'s
//!   piece-id tie-break, `intrinsicPreparedPieceClassKey`'s transform-order
//!   tie-break) routes through this.
//! - `js_number::{cmp_js_code_units, number_to_js_string}` -- the plain
//!   default-sort (not `localeCompare`) UTF-16 code-unit comparator
//!   `canonicalPointRing` uses, and the `${value}`-equivalent numeric
//!   stringification every grid-integer interpolation in this file uses.
//! - `nfp_ifp::{NfpIfpAbortReason, NfpIfpControl, NfpIfpControlAbortError}`
//!   -- the cooperative cancellation/deadline signal this file only ever
//!   forwards or downgrades, never constructs.
//!
//! # A seam this file introduces (documented, not silently invented)
//!
//! - **`settings: &IrregularNestingSettings` / `geometry_cache: &mut
//!   GeometryCacheStore`** are explicit function parameters on
//!   [`run_intrinsic_reconstruction_portfolio`], mirroring the TS `Effect`
//!   dependencies `constructIntrinsicStrictState` resolves via `yield*`
//!   (`GeometryKernel | GeometrySettings | NfpIfpService`) -- the same
//!   pattern `search::strict_decoder::construct_intrinsic_strict_state`
//!   itself already establishes for this crate.
//! - **`timing_now: Option<&TimingNowFn>`** is a Rust-only injectable clock
//!   seam (mirroring `capacity::search`'s own top-doc precedent: "Rust-only
//!   addition: an injectable `timing_now` clock seam"). The TS function has
//!   no such seam (it calls the real global `performance.now()` directly,
//!   `:139,195,221,248,284,293`, and does **not** pass a `timingNow` field
//!   into its own `constructIntrinsicStrictState` calls either, so that
//!   callee falls back to its own default, which in production is the exact
//!   same global clock object) -- this port threads one injected clock
//!   through both the portfolio-level wall-clock checks and the
//!   `construct_intrinsic_strict_state` calls it makes, which is
//!   behaviorally identical to production's "one shared real clock" shape
//!   while making the whole call chain deterministic for differential
//!   testing.
//!
//! # Where the admission/comparison rule that consumes this module's output
//! # actually lives
//!
//! Per characterization §2.4: the special-focus admission rule ("focused
//! reconstruction may replace the protected leader") is **not** implemented
//! in this file in TS, and must not be implemented here either -- it lives
//! at the orchestrator/caller layer (TS: `computeIrregularNesting.ts:880-937`),
//! which reads exactly one named run out of `.runs` by role and re-ranks it
//! against the already-ranked protected archive via the shared-archive
//! ranking authority (`archive::shared`, external to this file). This module
//! only ever produces candidate endpoints; it must never gain its own
//! admission/comparison logic.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use crate::caches::GeometryCacheStore;
use crate::canonical_grid::layout::placed_collision_world_grid_path;
use crate::canonical_grid::to_grid_mm;
use crate::checkpoints::canonical_json::locale_compare_keys;
use crate::domain::{
    IrregularNestingSettings, IrregularPlacedPiece, IrregularPreparedPiece,
    IrregularTransformCandidate, IrregularTransformReason, PieceId,
};
use crate::js_number::{cmp_js_code_units, number_to_js_string};
use crate::nfp_ifp::{NfpIfpAbortReason, NfpIfpControl, NfpIfpControlAbortError};
use crate::search::beam_state::TimingNowFn;
use crate::search::strict_decoder::{
    construct_intrinsic_strict_state, measure_intrinsic_sheetless_completed_layout,
    rank_intrinsic_strict_completed_layouts, select_intrinsic_strict_completed_pareto_front,
    ConstructIntrinsicStrictStateInput, IntrinsicStrictCandidateMode,
    IntrinsicStrictComparatorMode, IntrinsicStrictCompletedMetrics, IntrinsicStrictDecoderFailure,
    IntrinsicStrictGapFillEvidence, IntrinsicStrictStepTrace, TruncationReason,
};

// ===========================================================================
// Constants (`intrinsicReconstructionPortfolio.ts:26-43`)
// ===========================================================================

/// TS: `intrinsicReconstructionPortfolio.ts:26`.
pub const INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY: i64 = 8;

/// TS: `intrinsicReconstructionPortfolio.ts:28-43` `INTRINSIC_RECONSTRUCTION_ROLES`
/// (a 14-entry tuple). Modeled as an explicit enum (the established
/// convention throughout this crate for closed TS string-literal unions);
/// [`INTRINSIC_RECONSTRUCTION_ROLES`] below fixes the canonical iteration
/// order the TS `as const` tuple declares, even though (per characterization
/// §5.3) nothing in this file itself iterates it for output today -- it is
/// the authoritative role-name vocabulary/order a differential vector suite
/// must match verbatim.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IntrinsicReconstructionRole {
    CanonicalGrid,
    LegacyAbsoluteEnvelope,
    SettledProtected,
    ReversedPriority,
    EndpointQ0LeftToRight,
    EndpointQ0RightToLeft,
    EndpointQ90LeftToRight,
    EndpointQ90RightToLeft,
    OpenPocketFirst,
    ReversedPriorityOpenPocketFirst,
    EndpointQ0LeftToRightOpenPocketFirst,
    EndpointQ0RightToLeftOpenPocketFirst,
    EndpointQ90LeftToRightOpenPocketFirst,
    EndpointQ90RightToLeftOpenPocketFirst,
}

pub const INTRINSIC_RECONSTRUCTION_ROLES: [IntrinsicReconstructionRole; 14] = [
    IntrinsicReconstructionRole::CanonicalGrid,
    IntrinsicReconstructionRole::LegacyAbsoluteEnvelope,
    IntrinsicReconstructionRole::SettledProtected,
    IntrinsicReconstructionRole::ReversedPriority,
    IntrinsicReconstructionRole::EndpointQ0LeftToRight,
    IntrinsicReconstructionRole::EndpointQ0RightToLeft,
    IntrinsicReconstructionRole::EndpointQ90LeftToRight,
    IntrinsicReconstructionRole::EndpointQ90RightToLeft,
    IntrinsicReconstructionRole::OpenPocketFirst,
    IntrinsicReconstructionRole::ReversedPriorityOpenPocketFirst,
    IntrinsicReconstructionRole::EndpointQ0LeftToRightOpenPocketFirst,
    IntrinsicReconstructionRole::EndpointQ0RightToLeftOpenPocketFirst,
    IntrinsicReconstructionRole::EndpointQ90LeftToRightOpenPocketFirst,
    IntrinsicReconstructionRole::EndpointQ90RightToLeftOpenPocketFirst,
];

impl IntrinsicReconstructionRole {
    /// TS role string literal, verbatim.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CanonicalGrid => "canonical-grid",
            Self::LegacyAbsoluteEnvelope => "legacy-absolute-envelope",
            Self::SettledProtected => "settled-protected",
            Self::ReversedPriority => "reversed-priority",
            Self::EndpointQ0LeftToRight => "endpoint-q0-left-to-right",
            Self::EndpointQ0RightToLeft => "endpoint-q0-right-to-left",
            Self::EndpointQ90LeftToRight => "endpoint-q90-left-to-right",
            Self::EndpointQ90RightToLeft => "endpoint-q90-right-to-left",
            Self::OpenPocketFirst => "open-pocket-first",
            Self::ReversedPriorityOpenPocketFirst => "reversed-priority-open-pocket-first",
            Self::EndpointQ0LeftToRightOpenPocketFirst => {
                "endpoint-q0-left-to-right-open-pocket-first"
            }
            Self::EndpointQ0RightToLeftOpenPocketFirst => {
                "endpoint-q0-right-to-left-open-pocket-first"
            }
            Self::EndpointQ90LeftToRightOpenPocketFirst => {
                "endpoint-q90-left-to-right-open-pocket-first"
            }
            Self::EndpointQ90RightToLeftOpenPocketFirst => {
                "endpoint-q90-right-to-left-open-pocket-first"
            }
        }
    }
}

/// TS: `intrinsicReconstructionPortfolio.ts:47-51` `IntrinsicReconstructionRoleFamily`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicReconstructionRoleFamily {
    All,
    PureGrowth,
    GapContained,
    EndpointQ90RightToLeft,
}

/// TS: `intrinsicReconstructionPortfolio.ts:53-57`'s narrower `role` union on
/// `IntrinsicReconstructionSeed` -- only three of the fourteen
/// [`IntrinsicReconstructionRole`] variants are ever valid seed roles.
/// Modeled as a distinct type (rather than accepting the full role enum at
/// this boundary) so a Rust caller cannot construct a seed with, say,
/// `ReversedPriority`, exactly as the TS type system forbids it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicReconstructionSeedRole {
    CanonicalGrid,
    LegacyAbsoluteEnvelope,
    SettledProtected,
}

impl IntrinsicReconstructionSeedRole {
    pub const fn to_role(self) -> IntrinsicReconstructionRole {
        match self {
            Self::CanonicalGrid => IntrinsicReconstructionRole::CanonicalGrid,
            Self::LegacyAbsoluteEnvelope => IntrinsicReconstructionRole::LegacyAbsoluteEnvelope,
            Self::SettledProtected => IntrinsicReconstructionRole::SettledProtected,
        }
    }
}

/// TS: `intrinsicReconstructionPortfolio.ts:53-62` `IntrinsicReconstructionSeed`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicReconstructionSeed {
    pub role: IntrinsicReconstructionSeedRole,
    pub canonical_geometry_hash: String,
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub step_trace: Vec<IntrinsicStrictStepTrace>,
    pub metrics: IntrinsicStrictCompletedMetrics,
}

/// TS: `intrinsicReconstructionPortfolio.ts:70-75`'s `status` union.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicReconstructionRunStatus {
    Completed,
    Deadline,
    EvaluationCap,
    DuplicateOrder,
    Incomplete,
}

impl IntrinsicReconstructionRunStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Deadline => "deadline",
            Self::EvaluationCap => "evaluation-cap",
            Self::DuplicateOrder => "duplicate-order",
            Self::Incomplete => "incomplete",
        }
    }
}

/// TS: `intrinsicReconstructionPortfolio.ts:64-84` `IntrinsicReconstructionRun`.
/// Every field is always present (mirroring the TS type's own "no optional
/// fields" shape, characterization §3.2): a `'deadline'` run always carries
/// `metrics: None`/`placed_collision_geometries: Vec::new()`, never a
/// missing field.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicReconstructionRun {
    pub role: IntrinsicReconstructionRole,
    pub source_endpoint_hash: Option<String>,
    pub candidate_mode: IntrinsicStrictCandidateMode,
    pub piece_ids: Vec<PieceId>,
    pub effective_order_key: String,
    pub status: IntrinsicReconstructionRunStatus,
    pub duplicate_of: Option<IntrinsicReconstructionRole>,
    pub requested_candidate_evaluations: Option<f64>,
    pub consumed_candidate_evaluations: Option<f64>,
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub step_trace: Vec<IntrinsicStrictStepTrace>,
    pub gap_fill_evidence: Vec<IntrinsicStrictGapFillEvidence>,
    pub metrics: Option<IntrinsicStrictCompletedMetrics>,
    pub runtime_ms: f64,
}

/// TS: `IntrinsicReconstructionRun & { metrics: IntrinsicStrictCompletedMetrics }`
/// (`intrinsicReconstructionPortfolio.ts:88-93`) -- the archive/winner
/// refinement narrowing `metrics` from optional to guaranteed-present. Rust
/// has no intersection types; this wrapper models the same refinement
/// explicitly rather than re-widening `metrics` back to `Option` at this
/// boundary.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicReconstructionArchiveRun {
    pub run: IntrinsicReconstructionRun,
    pub metrics: IntrinsicStrictCompletedMetrics,
}

/// TS: `intrinsicReconstructionPortfolio.ts:86-97` `IntrinsicReconstructionPortfolioResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicReconstructionPortfolioResult {
    pub runs: Vec<IntrinsicReconstructionRun>,
    pub archive: Vec<IntrinsicReconstructionArchiveRun>,
    pub winner: Option<IntrinsicReconstructionArchiveRun>,
    pub runtime_ms: f64,
    pub consumed_candidate_evaluations: f64,
    pub candidate_evaluation_accounting_complete: bool,
}

/// TS: `intrinsicReconstructionPortfolio.ts:99-104` `IntrinsicReconstructionPortfolioError`
/// (`Data.TaggedError`). Only ever constructed with `operation: Seed`
/// (characterization §11.1); `Order`/`Archive` are declared-but-dead TS enum
/// members, preserved here for type completeness per that same section.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicReconstructionPortfolioOperation {
    Seed,
    Order,
    Archive,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicReconstructionPortfolioError {
    pub operation: IntrinsicReconstructionPortfolioOperation,
    pub message: String,
}

/// TS: `PortfolioError` (`intrinsicReconstructionPortfolio.ts:106-112`),
/// minus `IrregularNestingNotImplementedError` -- dropped per the same
/// established convention `search::strict_decoder`'s own
/// `IntrinsicStrictDecoderFailure` already documents ("this DI-unimplemented
/// -layer error has zero production callers reachable from this cluster").
#[derive(Clone, Debug, PartialEq)]
pub enum IntrinsicReconstructionPortfolioFailure {
    Portfolio(IntrinsicReconstructionPortfolioError),
    Strict(IntrinsicStrictDecoderFailure),
}

impl From<IntrinsicStrictDecoderFailure> for IntrinsicReconstructionPortfolioFailure {
    fn from(value: IntrinsicStrictDecoderFailure) -> Self {
        Self::Strict(value)
    }
}

/// TS: `DecodeSpec` (`intrinsicReconstructionPortfolio.ts:113-118`, a
/// module-private interface, exported here since
/// `buildIntrinsicReconstructionSpecs`/`intrinsicReconstructionSpecMatchesFamily`
/// are both directly unit-tested in TS against it). `role` is typed in TS as
/// `Exclude<IntrinsicReconstructionRole, 'canonical-grid' |
/// 'legacy-absolute-envelope'>`; this port uses the full
/// [`IntrinsicReconstructionRole`] enum instead (those two variants are
/// simply never constructed by [`build_intrinsic_reconstruction_specs`]),
/// matching this crate's established "seam type against domain shapes"
/// convention rather than introducing a second, narrower role enum.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodeSpec {
    pub role: IntrinsicReconstructionRole,
    pub source_endpoint_hash: Option<String>,
    pub candidate_mode: IntrinsicStrictCandidateMode,
    pub pieces: Vec<Arc<IrregularPreparedPiece>>,
}

// ===========================================================================
// The `timingNow` seam (Rust-only addition -- see this module's top doc).
// ===========================================================================

static PROCESS_START: LazyLock<Instant> = LazyLock::new(Instant::now);

fn default_timing_now() -> f64 {
    PROCESS_START.elapsed().as_secs_f64() * 1000.0
}

// ===========================================================================
// Seam: `ReconstructionControl` -- a tiny concrete (`Sized`) local wrapper
// around the caller-supplied `Option<&mut dyn NfpIfpControl>`, exactly
// mirroring `search::strict_decoder`'s own `DeadlineControl`/
// `capacity::search`'s own `CapacitySearchControl` (see either module's own
// doc comment): a caller-supplied `Option<&mut dyn NfpIfpControl>` cannot be
// reborrowed repeatedly across this file's own `for spec in &specs` loop
// for an unsized trait-object target (a known rustc limitation, documented
// at length on `nfp_ifp::service::nfp_checkpoint`'s own doc comment); this
// wrapper's `None` inner is an always-`Ok` no-op checkpoint, behaviorally
// identical to TS's `input.control === undefined ? {} : { control:
// input.control }` skip-when-absent guard, so a plain `&mut control`
// reborrow at this file's one call site works.
// ===========================================================================

/* Records only an abort returned by the caller-supplied control. This keeps
 * externally requested deadlines terminal while preserving the strict decoder's
 * own per-decode deadline as a protected reconstruction fallback.
 */
struct ReconstructionControl<'a> {
    inner: Option<&'a mut dyn NfpIfpControl>,
    external_abort_reason: Option<NfpIfpAbortReason>,
}

impl NfpIfpControl for ReconstructionControl<'_> {
    fn checkpoint(
        &mut self,
        phase: crate::nfp_ifp::NfpIfpCheckpointPhase,
    ) -> Result<(), NfpIfpControlAbortError> {
        match self.inner.as_deref_mut() {
            None => Ok(()),
            Some(control) => match control.checkpoint(phase) {
                Ok(()) => Ok(()),
                Err(abort) => {
                    self.external_abort_reason = Some(abort.reason);
                    Err(abort)
                }
            },
        }
    }
}

// ===========================================================================
// `preparedPieceId`/`placedPieceId` (`:597-603`)
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

fn transform_reason_str(reason: IrregularTransformReason) -> &'static str {
    match reason {
        IrregularTransformReason::Orthogonal => "orthogonal",
        IrregularTransformReason::EdgeAlignment => "edge_alignment",
        IrregularTransformReason::Configured => "configured",
    }
}

/// TS: `candidateModeKey` (`:540-542`).
fn candidate_mode_key(mode: IntrinsicStrictCandidateMode) -> &'static str {
    match mode {
        IntrinsicStrictCandidateMode::Comparator(IntrinsicStrictComparatorMode::PureGrowth) => {
            "pure-growth"
        }
        IntrinsicStrictCandidateMode::Comparator(
            IntrinsicStrictComparatorMode::LegacyAbsoluteEnvelope,
        ) => "legacy-absolute-envelope",
        IntrinsicStrictCandidateMode::Comparator(IntrinsicStrictComparatorMode::ContactBand) => {
            "contact-band"
        }
        IntrinsicStrictCandidateMode::GapContained => "gap-contained",
    }
}

// ===========================================================================
// `intrinsicReconstructionEffectiveOrderKey` / `intrinsicPreparedPieceClassKey`
// (`:544-595`)
// ===========================================================================

/// TS: `intrinsicReconstructionEffectiveOrderKey` (`:545-549`). Pipe-`|`
/// separated; **not** the same join separator as the unrelated reuse of
/// `intrinsicPreparedPieceClassKey` inside `intrinsicQueueBeamDiscriminator.ts`
/// (space-joined there) -- see characterization §8.1. Do not unify.
pub fn intrinsic_reconstruction_effective_order_key(
    pieces: &[Arc<IrregularPreparedPiece>],
) -> String {
    pieces
        .iter()
        .map(|piece| intrinsic_prepared_piece_class_key(piece))
        .collect::<Vec<_>>()
        .join("|")
}

/// TS: `intrinsicPreparedPieceClassKey` (`:551-582`).
pub fn intrinsic_prepared_piece_class_key(piece: &IrregularPreparedPiece) -> String {
    let raw_points: Vec<(Option<f64>, Option<f64>)> = piece
        .collision_geometry
        .collision_polygon
        .points
        .iter()
        .map(|point| (to_grid_mm(point.x), to_grid_mm(point.y)))
        .collect();
    if raw_points.iter().any(|(x, y)| x.is_none() || y.is_none()) {
        return format!("piece:{}", prepared_piece_id(piece).as_str());
    }
    let grid_points: Vec<(f64, f64)> = raw_points
        .into_iter()
        .map(|(x, y)| (x.unwrap_or(0.0), y.unwrap_or(0.0)))
        .collect();
    let minimum_x = grid_points
        .iter()
        .map(|(x, _)| *x)
        .fold(f64::INFINITY, f64::min);
    let minimum_y = grid_points
        .iter()
        .map(|(_, y)| *y)
        .fold(f64::INFINITY, f64::min);
    let normalized: Vec<(f64, f64)> = grid_points
        .iter()
        .map(|(x, y)| (x - minimum_x, y - minimum_y))
        .collect();
    let reference_x = to_grid_mm(piece.collision_geometry.placement_reference.x);
    let reference_y = to_grid_mm(piece.collision_geometry.placement_reference.y);
    let (reference_x, reference_y) = match (reference_x, reference_y) {
        (Some(x), Some(y)) => (x, y),
        _ => return format!("piece:{}", prepared_piece_id(piece).as_str()),
    };
    let mut transforms: Vec<&IrregularTransformCandidate> = piece.transforms.iter().collect();
    transforms.sort_by(|first, second| {
        first
            .index
            .partial_cmp(&second.index)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                first
                    .rotation_deg
                    .partial_cmp(&second.rotation_deg)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| (first.mirrored as i32).cmp(&(second.mirrored as i32)))
            .then_with(|| {
                locale_compare_keys(
                    transform_reason_str(first.reason),
                    transform_reason_str(second.reason),
                )
            })
    });
    let transforms_joined = transforms
        .iter()
        .map(|transform| {
            format!(
                "{}:{}:{}:{}",
                number_to_js_string(transform.index),
                number_to_js_string(transform.rotation_deg),
                i32::from(transform.mirrored),
                transform_reason_str(transform.reason)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{}@{},{}:{}:{}",
        canonical_point_ring(&normalized),
        number_to_js_string(reference_x - minimum_x),
        number_to_js_string(reference_y - minimum_y),
        i32::from(piece.allow_mirror),
        transforms_joined
    )
}

/// TS: `canonicalPointRing` (`:584-595`). Default (UTF-16 code-unit) sort,
/// deliberately **not** `locale_compare_keys` -- see characterization §5.1
/// and this file's top doc.
fn canonical_point_ring(points: &[(f64, f64)]) -> String {
    if points.is_empty() {
        return String::new();
    }
    let reversed: Vec<(f64, f64)> = points.iter().rev().copied().collect();
    let mut variants: Vec<String> = Vec::with_capacity(points.len() * 2);
    for sequence in [points, reversed.as_slice()] {
        for offset in 0..sequence.len() {
            let mut rotated: Vec<(f64, f64)> = sequence[offset..].to_vec();
            rotated.extend_from_slice(&sequence[..offset]);
            variants.push(
                rotated
                    .iter()
                    .map(|(x, y)| {
                        format!("{},{}", number_to_js_string(*x), number_to_js_string(*y))
                    })
                    .collect::<Vec<_>>()
                    .join(";"),
            );
        }
    }
    variants.sort_by(|first, second| cmp_js_code_units(first, second));
    variants.into_iter().next().unwrap_or_default()
}

// ===========================================================================
// `buildCanonicalEndpointOrders` (`:355-424`)
// ===========================================================================

/// TS: `buildCanonicalEndpointOrders`'s return-element shape (`:358-364`).
#[derive(Clone, Debug, PartialEq)]
pub struct CanonicalEndpointOrder {
    pub role: IntrinsicReconstructionRole,
    pub pieces: Vec<Arc<IrregularPreparedPiece>>,
}

/// TS: `buildCanonicalEndpointOrders` (`:355-424`).
pub fn build_canonical_endpoint_orders(
    pieces: &[Arc<IrregularPreparedPiece>],
    placed: &[Arc<IrregularPlacedPiece>],
) -> Vec<CanonicalEndpointOrder> {
    let mut positions: HashMap<PieceId, (f64, f64)> = HashMap::new();
    for placement in placed {
        let path = match placed_collision_world_grid_path(placement) {
            Some(path) => path,
            None => continue,
        };
        let first = match path.first() {
            Some(point) => *point,
            None => continue,
        };
        let mut min_x = first.x;
        let mut min_y = first.y;
        let mut max_x = first.x;
        let mut max_y = first.y;
        for point in &path[1..] {
            min_x = min_x.min(point.x);
            min_y = min_y.min(point.y);
            max_x = max_x.max(point.x);
            max_y = max_y.max(point.y);
        }
        positions.insert(placed_piece_id(placement), (min_x + max_x, min_y + max_y));
    }

    let order = |primary_of: fn(f64, f64) -> f64| -> Vec<Arc<IrregularPreparedPiece>> {
        let mut ordered: Vec<Arc<IrregularPreparedPiece>> = pieces.to_vec();
        ordered.sort_by(|first, second| {
            let first_id = prepared_piece_id(first);
            let second_id = prepared_piece_id(second);
            match (positions.get(&first_id), positions.get(&second_id)) {
                (Some(&(first_x, first_y)), Some(&(second_x, second_y))) => {
                    primary_of(first_x, first_y)
                        .partial_cmp(&primary_of(second_x, second_y))
                        .unwrap_or(Ordering::Equal)
                        .then_with(|| first_y.partial_cmp(&second_y).unwrap_or(Ordering::Equal))
                        .then_with(|| first_x.partial_cmp(&second_x).unwrap_or(Ordering::Equal))
                        .then_with(|| locale_compare_keys(first_id.as_str(), second_id.as_str()))
                }
                _ => locale_compare_keys(first_id.as_str(), second_id.as_str()),
            }
        });
        ordered
    };

    vec![
        CanonicalEndpointOrder {
            role: IntrinsicReconstructionRole::EndpointQ0LeftToRight,
            pieces: order(|doubled_x, _doubled_y| doubled_x),
        },
        CanonicalEndpointOrder {
            role: IntrinsicReconstructionRole::EndpointQ0RightToLeft,
            pieces: order(|doubled_x, _doubled_y| -doubled_x),
        },
        CanonicalEndpointOrder {
            role: IntrinsicReconstructionRole::EndpointQ90LeftToRight,
            pieces: order(|_doubled_x, doubled_y| -doubled_y),
        },
        CanonicalEndpointOrder {
            role: IntrinsicReconstructionRole::EndpointQ90RightToLeft,
            pieces: order(|_doubled_x, doubled_y| doubled_y),
        },
    ]
}

fn open_pocket_first_role(role: IntrinsicReconstructionRole) -> IntrinsicReconstructionRole {
    match role {
        IntrinsicReconstructionRole::EndpointQ0LeftToRight => {
            IntrinsicReconstructionRole::EndpointQ0LeftToRightOpenPocketFirst
        }
        IntrinsicReconstructionRole::EndpointQ0RightToLeft => {
            IntrinsicReconstructionRole::EndpointQ0RightToLeftOpenPocketFirst
        }
        IntrinsicReconstructionRole::EndpointQ90LeftToRight => {
            IntrinsicReconstructionRole::EndpointQ90LeftToRightOpenPocketFirst
        }
        IntrinsicReconstructionRole::EndpointQ90RightToLeft => {
            IntrinsicReconstructionRole::EndpointQ90RightToLeftOpenPocketFirst
        }
        // `build_canonical_endpoint_orders` only ever returns the four
        // endpoint roles above; every other variant is unreachable here.
        other => other,
    }
}

// ===========================================================================
// `buildIntrinsicReconstructionSpecs` / `intrinsicReconstructionSpecMatchesFamily`
// (`:301-352`)
// ===========================================================================

/// TS: `buildIntrinsicReconstructionSpecs` (`:301-339`). Return order is the
/// canonical spec-processing order (characterization §5.3): `reversed-priority`,
/// the four `endpointOrders` (q0-ltr, q0-rtl, q90-ltr, q90-rtl),
/// `open-pocket-first`, `reversed-priority-open-pocket-first`, then the four
/// `gapContainedEndpointOrders` in the same q0/q90 order.
pub fn build_intrinsic_reconstruction_specs(
    pieces: &[Arc<IrregularPreparedPiece>],
    endpoint: &IntrinsicReconstructionSeed,
) -> Vec<DecodeSpec> {
    let endpoint_orders =
        build_canonical_endpoint_orders(pieces, &endpoint.placed_collision_geometries);
    let mut specs: Vec<DecodeSpec> = Vec::with_capacity(4 + endpoint_orders.len() * 2 + 2);

    specs.push(DecodeSpec {
        role: IntrinsicReconstructionRole::ReversedPriority,
        source_endpoint_hash: None,
        candidate_mode: IntrinsicStrictCandidateMode::Comparator(
            IntrinsicStrictComparatorMode::PureGrowth,
        ),
        pieces: pieces.iter().rev().cloned().collect(),
    });
    for order in &endpoint_orders {
        specs.push(DecodeSpec {
            role: order.role,
            source_endpoint_hash: Some(endpoint.canonical_geometry_hash.clone()),
            candidate_mode: IntrinsicStrictCandidateMode::Comparator(
                IntrinsicStrictComparatorMode::PureGrowth,
            ),
            pieces: order.pieces.clone(),
        });
    }
    specs.push(DecodeSpec {
        role: IntrinsicReconstructionRole::OpenPocketFirst,
        source_endpoint_hash: None,
        candidate_mode: IntrinsicStrictCandidateMode::GapContained,
        pieces: pieces.to_vec(),
    });
    specs.push(DecodeSpec {
        role: IntrinsicReconstructionRole::ReversedPriorityOpenPocketFirst,
        source_endpoint_hash: None,
        candidate_mode: IntrinsicStrictCandidateMode::GapContained,
        pieces: pieces.iter().rev().cloned().collect(),
    });
    for order in &endpoint_orders {
        specs.push(DecodeSpec {
            role: open_pocket_first_role(order.role),
            source_endpoint_hash: Some(endpoint.canonical_geometry_hash.clone()),
            candidate_mode: IntrinsicStrictCandidateMode::GapContained,
            pieces: order.pieces.clone(),
        });
    }
    specs
}

/// TS: `intrinsicReconstructionSpecMatchesFamily` (`:342-352`).
pub fn intrinsic_reconstruction_spec_matches_family(
    spec: &DecodeSpec,
    family: IntrinsicReconstructionRoleFamily,
) -> bool {
    match family {
        IntrinsicReconstructionRoleFamily::All => true,
        IntrinsicReconstructionRoleFamily::EndpointQ90RightToLeft => {
            spec.role == IntrinsicReconstructionRole::EndpointQ90RightToLeft
        }
        IntrinsicReconstructionRoleFamily::GapContained => {
            matches!(
                spec.candidate_mode,
                IntrinsicStrictCandidateMode::GapContained
            )
        }
        IntrinsicReconstructionRoleFamily::PureGrowth => !matches!(
            spec.candidate_mode,
            IntrinsicStrictCandidateMode::GapContained
        ),
    }
}

// ===========================================================================
// `retainIntrinsicReconstructionArchive` (`:427-473`)
// ===========================================================================

/// TS: `retainIntrinsicReconstructionArchive` (`:427-473`). `capacity` is
/// `i64` (not `usize`) to preserve the exact `Math.max(0, capacity)` bound
/// TS applies -- a Rust caller can pass a negative value and observe the
/// same "bounded to zero" behavior as TS, rather than that case being
/// unrepresentable/panicking. No default parameter (TS: `=
/// INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY`) -- Rust has no default
/// arguments; every caller (including
/// [`run_intrinsic_reconstruction_portfolio`] itself) passes
/// [`INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY`] explicitly.
///
/// **Characterization §6.4**: `protected_seeds` recognizes only
/// `CanonicalGrid`/`LegacyAbsoluteEnvelope` -- `SettledProtected` (the role
/// production actually seeds) is deliberately **not** in this protected
/// set. Preserve verbatim; do not "fix" this to also include
/// `SettledProtected`.
pub fn retain_intrinsic_reconstruction_archive(
    runs: &[IntrinsicReconstructionRun],
    capacity: i64,
) -> Vec<IntrinsicReconstructionArchiveRun> {
    let complete: Vec<&IntrinsicReconstructionRun> = runs
        .iter()
        .filter(|run| {
            run.status == IntrinsicReconstructionRunStatus::Completed && run.metrics.is_some()
        })
        .collect();

    // First-write-wins by `canonicalGeometryHash`, iterated in `runs` order
    // (characterization §5.2's `unique` map -- the opposite overwrite
    // discipline from `orderOwners` in the main loop below).
    let mut unique: HashMap<String, IntrinsicReconstructionArchiveRun> = HashMap::new();
    let mut unique_order: Vec<String> = Vec::new();
    for run in &complete {
        let metrics = run
            .metrics
            .clone()
            .expect("filtered to runs with metrics present");
        let hash = metrics.canonical_geometry_hash.clone();
        unique.entry(hash.clone()).or_insert_with(|| {
            unique_order.push(hash);
            IntrinsicReconstructionArchiveRun {
                run: (*run).clone(),
                metrics,
            }
        });
    }
    let unique_runs: Vec<IntrinsicReconstructionArchiveRun> = unique_order
        .iter()
        .map(|hash| {
            unique
                .get(hash)
                .cloned()
                .expect("hash present in unique map by construction")
        })
        .collect();

    let unique_metrics: Vec<IntrinsicStrictCompletedMetrics> =
        unique_runs.iter().map(|run| run.metrics.clone()).collect();
    let ranked_metrics = select_intrinsic_strict_completed_pareto_front(&unique_metrics);
    let ranked_runs: Vec<IntrinsicReconstructionArchiveRun> = ranked_metrics
        .into_iter()
        .filter_map(|metrics| unique.get(&metrics.canonical_geometry_hash).cloned())
        .collect();

    let bounded_capacity = capacity.max(0) as usize;
    let protected_seeds: Vec<&IntrinsicReconstructionArchiveRun> = unique_runs
        .iter()
        .filter(|run| {
            matches!(
                run.run.role,
                IntrinsicReconstructionRole::CanonicalGrid
                    | IntrinsicReconstructionRole::LegacyAbsoluteEnvelope
            )
        })
        .collect();

    let mut selected: Vec<IntrinsicReconstructionArchiveRun> = Vec::new();
    {
        let mut append = |run: &IntrinsicReconstructionArchiveRun| {
            if selected.len() < bounded_capacity
                && !selected.iter().any(|entry| {
                    entry.metrics.canonical_geometry_hash == run.metrics.canonical_geometry_hash
                })
            {
                selected.push(run.clone());
            }
        };
        if let Some(frontier_leader) = ranked_runs.first() {
            append(frontier_leader);
        }
        for seed in &protected_seeds {
            append(seed);
        }
        for run in &ranked_runs {
            append(run);
        }
    }
    selected
}

// ===========================================================================
// `baselineSeedRuns` / `selectReconstructionEndpoint` (`:475-509`)
// ===========================================================================

/// TS: `baselineSeedRuns` (`:475-501`).
fn baseline_seed_runs(
    seeds: &[IntrinsicReconstructionSeed],
    pieces: &[Arc<IrregularPreparedPiece>],
) -> Vec<IntrinsicReconstructionRun> {
    let piece_ids: Vec<PieceId> = pieces
        .iter()
        .map(|piece| prepared_piece_id(piece))
        .collect();
    let effective_order_key = intrinsic_reconstruction_effective_order_key(pieces);
    seeds
        .iter()
        .map(|seed| {
            let candidate_mode = match seed.role {
                IntrinsicReconstructionSeedRole::CanonicalGrid => {
                    IntrinsicStrictCandidateMode::Comparator(
                        IntrinsicStrictComparatorMode::PureGrowth,
                    )
                }
                IntrinsicReconstructionSeedRole::LegacyAbsoluteEnvelope => {
                    IntrinsicStrictCandidateMode::Comparator(
                        IntrinsicStrictComparatorMode::LegacyAbsoluteEnvelope,
                    )
                }
                IntrinsicReconstructionSeedRole::SettledProtected => {
                    IntrinsicStrictCandidateMode::Comparator(
                        IntrinsicStrictComparatorMode::PureGrowth,
                    )
                }
            };
            IntrinsicReconstructionRun {
                role: seed.role.to_role(),
                source_endpoint_hash: None,
                candidate_mode,
                piece_ids: piece_ids.clone(),
                effective_order_key: effective_order_key.clone(),
                status: IntrinsicReconstructionRunStatus::Completed,
                duplicate_of: None,
                requested_candidate_evaluations: Some(0.0),
                consumed_candidate_evaluations: Some(0.0),
                placed_collision_geometries: seed.placed_collision_geometries.clone(),
                step_trace: seed.step_trace.clone(),
                gap_fill_evidence: Vec::new(),
                metrics: Some(seed.metrics.clone()),
                runtime_ms: seed.metrics.runtime_ms,
            }
        })
        .collect()
}

/// TS: `selectReconstructionEndpoint` (`:503-509`).
fn select_reconstruction_endpoint(
    seeds: &[IntrinsicReconstructionSeed],
) -> Option<&IntrinsicReconstructionSeed> {
    let metrics: Vec<IntrinsicStrictCompletedMetrics> =
        seeds.iter().map(|seed| seed.metrics.clone()).collect();
    let ranked = rank_intrinsic_strict_completed_layouts(&metrics);
    let winning_hash = ranked.first()?.canonical_geometry_hash.clone();
    seeds
        .iter()
        .find(|seed| seed.canonical_geometry_hash == winning_hash)
}

/// TS: `deadlineRun` (`:511-531`).
fn deadline_run(
    spec: &DecodeSpec,
    requested_candidate_evaluations: Option<f64>,
) -> IntrinsicReconstructionRun {
    IntrinsicReconstructionRun {
        role: spec.role,
        source_endpoint_hash: spec.source_endpoint_hash.clone(),
        candidate_mode: spec.candidate_mode,
        piece_ids: spec
            .pieces
            .iter()
            .map(|piece| prepared_piece_id(piece))
            .collect(),
        effective_order_key: intrinsic_reconstruction_effective_order_key(&spec.pieces),
        status: IntrinsicReconstructionRunStatus::Deadline,
        duplicate_of: None,
        requested_candidate_evaluations,
        consumed_candidate_evaluations: None,
        placed_collision_geometries: Vec::new(),
        step_trace: Vec::new(),
        gap_fill_evidence: Vec::new(),
        metrics: None,
        runtime_ms: 0.0,
    }
}

/// TS: `evaluationCapRun` (`:533-538`).
fn evaluation_cap_run(spec: &DecodeSpec) -> IntrinsicReconstructionRun {
    IntrinsicReconstructionRun {
        status: IntrinsicReconstructionRunStatus::EvaluationCap,
        ..deadline_run(spec, None)
    }
}

// ===========================================================================
// `runIntrinsicReconstructionPortfolio` (`:124-298`)
// ===========================================================================

/// TS: `runIntrinsicReconstructionPortfolio`'s input object
/// (`intrinsicReconstructionPortfolio.ts:124-137`). See this module's top
/// doc for the `timing_now`/`settings`/`geometry_cache` seam notes.
pub struct RunIntrinsicReconstructionPortfolioInput<'a> {
    pub all_prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    pub baseline_seeds: &'a [IntrinsicReconstructionSeed],
    pub maximum_runtime_ms_per_decode: Option<f64>,
    pub maximum_total_runtime_ms: Option<f64>,
    pub role_family: Option<IntrinsicReconstructionRoleFamily>,
    pub maximum_candidate_evaluations_per_decode: Option<f64>,
    pub maximum_total_candidate_evaluations: Option<f64>,
    pub control: Option<&'a mut dyn NfpIfpControl>,
    pub timing_now: Option<&'a TimingNowFn>,
}

/// TS: `runIntrinsicReconstructionPortfolio` (`:124-298`). See
/// characterization §4.1 for the exact per-spec mutation chronology this
/// function reproduces step-by-step (registration before deadline/cap
/// checks, `candidateEvaluationAccountingComplete` only ever set `false` on
/// the two deadline branches, etc.) -- do not reorder any of the numbered
/// steps in that section.
pub fn run_intrinsic_reconstruction_portfolio(
    input: RunIntrinsicReconstructionPortfolioInput<'_>,
    settings: &IrregularNestingSettings,
    geometry_cache: &mut GeometryCacheStore,
) -> Result<IntrinsicReconstructionPortfolioResult, IntrinsicReconstructionPortfolioFailure> {
    let default_timing_now_ref: &TimingNowFn = &default_timing_now;
    let timing_now: &TimingNowFn = input.timing_now.unwrap_or(default_timing_now_ref);
    let started_at = timing_now();

    let maximum_runtime_ms_per_decode = input.maximum_runtime_ms_per_decode.unwrap_or(120_000.0);
    let maximum_total_runtime_ms = input.maximum_total_runtime_ms.unwrap_or(300_000.0);
    let role_family = input
        .role_family
        .unwrap_or(IntrinsicReconstructionRoleFamily::All);
    let maximum_candidate_evaluations_per_decode = input.maximum_candidate_evaluations_per_decode;
    let maximum_total_candidate_evaluations = input.maximum_total_candidate_evaluations;
    let mut consumed_candidate_evaluations: f64 = 0.0;
    let mut candidate_evaluation_accounting_complete = true;

    let seed_runs = baseline_seed_runs(input.baseline_seeds, input.all_prepared_pieces);
    let endpoint = match select_reconstruction_endpoint(input.baseline_seeds) {
        Some(endpoint) => endpoint,
        None => {
            return Err(IntrinsicReconstructionPortfolioFailure::Portfolio(
                IntrinsicReconstructionPortfolioError {
                    operation: IntrinsicReconstructionPortfolioOperation::Seed,
                    message: "the reconstruction portfolio requires one complete exact baseline endpoint."
                        .to_string(),
                },
            ));
        }
    };

    let specs: Vec<DecodeSpec> =
        build_intrinsic_reconstruction_specs(input.all_prepared_pieces, endpoint)
            .into_iter()
            .filter(|spec| intrinsic_reconstruction_spec_matches_family(spec, role_family))
            .collect();

    let mut runs: Vec<IntrinsicReconstructionRun> = seed_runs.clone();
    let mut order_owners: HashMap<String, IntrinsicReconstructionRole> = HashMap::new();
    for run in &seed_runs {
        order_owners.insert(
            format!(
                "{}:{}",
                candidate_mode_key(run.candidate_mode),
                intrinsic_reconstruction_effective_order_key(input.all_prepared_pieces)
            ),
            run.role,
        );
    }

    let mut control = ReconstructionControl {
        inner: input.control,
        external_abort_reason: None,
    };

    for spec in &specs {
        let order_key = intrinsic_reconstruction_effective_order_key(&spec.pieces);
        let owner_key = format!("{}:{}", candidate_mode_key(spec.candidate_mode), order_key);
        if let Some(&duplicate_of) = order_owners.get(&owner_key) {
            runs.push(IntrinsicReconstructionRun {
                role: spec.role,
                source_endpoint_hash: spec.source_endpoint_hash.clone(),
                candidate_mode: spec.candidate_mode,
                piece_ids: spec
                    .pieces
                    .iter()
                    .map(|piece| prepared_piece_id(piece))
                    .collect(),
                effective_order_key: order_key,
                status: IntrinsicReconstructionRunStatus::DuplicateOrder,
                duplicate_of: Some(duplicate_of),
                requested_candidate_evaluations: Some(0.0),
                consumed_candidate_evaluations: Some(0.0),
                placed_collision_geometries: Vec::new(),
                step_trace: Vec::new(),
                gap_fill_evidence: Vec::new(),
                metrics: None,
                runtime_ms: 0.0,
            });
            continue;
        }
        order_owners.insert(owner_key, spec.role);

        let remaining_total_ms = maximum_total_runtime_ms - (timing_now() - started_at);
        if remaining_total_ms <= 0.0 {
            runs.push(deadline_run(spec, None));
            candidate_evaluation_accounting_complete = false;
            continue;
        }

        let remaining_candidate_evaluations = maximum_total_candidate_evaluations
            .map(|maximum| maximum - consumed_candidate_evaluations);
        if let Some(remaining) = remaining_candidate_evaluations {
            if remaining <= 0.0 {
                runs.push(evaluation_cap_run(spec));
                continue;
            }
        }

        let requested_candidate_evaluations = match maximum_candidate_evaluations_per_decode {
            None => remaining_candidate_evaluations,
            Some(per_decode) => match remaining_candidate_evaluations {
                None => Some(per_decode),
                Some(remaining) => Some(per_decode.min(remaining)),
            },
        };

        let decode_started_at = timing_now();
        let construct_input = ConstructIntrinsicStrictStateInput {
            all_prepared_pieces: &spec.pieces,
            remaining_prepared_pieces: &spec.pieces,
            frozen_placed: &[],
            candidate_mode: spec.candidate_mode,
            maximum_runtime_ms: Some(maximum_runtime_ms_per_decode.min(remaining_total_ms)),
            maximum_candidate_evaluation_count: requested_candidate_evaluations,
            capture_candidate_evaluation_count: true,
            capture_phase_timings: false,
            timing_now: Some(timing_now),
            producer_role: None,
            checkpoint: None,
            maximum_completed_piece_boundaries: None,
            control: Some(&mut control),
        };

        let constructed =
            match construct_intrinsic_strict_state(construct_input, settings, geometry_cache) {
                Ok(constructed) => Some(constructed),
                Err(IntrinsicStrictDecoderFailure::Abort(abort)) => {
                    if control.external_abort_reason == Some(abort.reason) {
                        return Err(IntrinsicReconstructionPortfolioFailure::Strict(
                            IntrinsicStrictDecoderFailure::Abort(abort),
                        ));
                    }
                    None
                }
                Err(other) => return Err(IntrinsicReconstructionPortfolioFailure::Strict(other)),
            };

        let constructed = match constructed {
            Some(constructed) => constructed,
            None => {
                candidate_evaluation_accounting_complete = false;
                let mut run = deadline_run(spec, requested_candidate_evaluations);
                run.runtime_ms = timing_now() - decode_started_at;
                runs.push(run);
                continue;
            }
        };

        let consumed_by_decode = constructed.candidate_evaluation_count.unwrap_or(0.0);
        consumed_candidate_evaluations += consumed_by_decode;

        if constructed.truncation_reason == Some(TruncationReason::MaximumCandidateEvaluations) {
            runs.push(IntrinsicReconstructionRun {
                requested_candidate_evaluations,
                consumed_candidate_evaluations: Some(consumed_by_decode),
                runtime_ms: timing_now() - decode_started_at,
                ..evaluation_cap_run(spec)
            });
            continue;
        }

        let measured = measure_intrinsic_sheetless_completed_layout(
            &constructed.state,
            constructed.runtime_ms,
        );
        runs.push(IntrinsicReconstructionRun {
            role: spec.role,
            source_endpoint_hash: spec.source_endpoint_hash.clone(),
            candidate_mode: spec.candidate_mode,
            piece_ids: spec
                .pieces
                .iter()
                .map(|piece| prepared_piece_id(piece))
                .collect(),
            effective_order_key: order_key,
            status: if measured.is_none() {
                IntrinsicReconstructionRunStatus::Incomplete
            } else {
                IntrinsicReconstructionRunStatus::Completed
            },
            duplicate_of: None,
            requested_candidate_evaluations,
            consumed_candidate_evaluations: Some(consumed_by_decode),
            placed_collision_geometries: measured
                .as_ref()
                .map(|layout| layout.placed_collision_geometries.clone())
                .unwrap_or_default(),
            step_trace: constructed.step_trace,
            gap_fill_evidence: constructed.gap_fill_evidence,
            metrics: measured.map(|layout| layout.metrics),
            runtime_ms: timing_now() - decode_started_at,
        });
    }

    let archive =
        retain_intrinsic_reconstruction_archive(&runs, INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY);
    let winner = archive.first().cloned();
    Ok(IntrinsicReconstructionPortfolioResult {
        runs,
        archive,
        winner,
        runtime_ms: timing_now() - started_at,
        consumed_candidate_evaluations,
        candidate_evaluation_accounting_complete,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        default_irregular_placement_policy_ids, CollisionGeometry, DxfGeometryEntityType,
        DxfGeometrySummary, ImportedPiece, IntrinsicObjectiveProfileId, IrregularBounds,
        IrregularGeometrySettings, IrregularOptimizerSettings, IrregularPlacement,
        IrregularPlacementPolicyId, IrregularPoint, IrregularPolygon, IrregularTransform, Rect,
        SourceFileId, TransformedCollisionGeometry,
    };

    fn point(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    /// Mirrors `search::layout_scorer`'s own identically-named test-only
    /// helper (no `Default` impl exists for `IrregularNestingSettings`, per
    /// that module's own doc comment on the deliberate "always-resolved,
    /// never `Option`" design).
    fn settings() -> IrregularNestingSettings {
        IrregularNestingSettings {
            geometry: IrregularGeometrySettings {
                flattening_sag_tolerance_mm: 0.25,
                clearance_safety_margin_mm: 0.25,
                geometry_backend_id: "irregular-convex-v2-default".to_string(),
                geometry_backend_version: "0".to_string(),
            },
            optimizer: IrregularOptimizerSettings {
                order_window: 4.0,
                beam_width: 8.0,
                local_candidate_fanout: 4.0,
                local_repair_budget: 0.0,
                intrinsic_shared_archive_enabled: true,
                intrinsic_objective_profile_id: IntrinsicObjectiveProfileId::Compact,
                transform_cap: 8.0,
                transform_minimum_edge_length_mm: 1.0,
                transform_angle_deduplication_tolerance_deg: 0.01,
                configured_rotation_enabled: true,
                edge_alignment_enabled: true,
                configured_rotation_deg: vec![],
                ga_enabled: false,
                baseline_only: true,
                ga_population: 12.0,
                ga_generation_budget: 2.0,
                ga_evaluation_budget: 24.0,
                ga_time_budget_ms: 15000.0,
                ga_seed: "default".to_string(),
                priority_order_mutation_enabled: true,
                transform_preference_mutation_enabled: true,
                placement_policy_mutation_enabled: true,
                placement_policy_id: IrregularPlacementPolicyId::BalancedCompactness,
                placement_policy_ids: default_irregular_placement_policy_ids(),
            },
        }
    }

    fn piece_with_size(id: &str, width: f64, height: f64) -> Arc<IrregularPreparedPiece> {
        let points = vec![
            point(0.0, 0.0),
            point(width, 0.0),
            point(width, height),
            point(0.0, height),
        ];
        let polygon = IrregularPolygon::new(points.clone());
        let piece_id = PieceId::new(id);
        Arc::new(IrregularPreparedPiece {
            piece_id: Some(piece_id.clone()),
            interchangeability_key: None,
            source: ImportedPiece {
                id: piece_id.clone(),
                source_file_id: SourceFileId::new(format!("source-{id}")),
                source_layer: None,
                label: id.to_string(),
                real_bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width,
                    height,
                },
                geometry: DxfGeometrySummary {
                    entity_type: DxfGeometryEntityType::PresetShape,
                    closed: true,
                    segments: vec![],
                },
                warnings: vec![],
            },
            allow_mirror: false,
            collision_geometry: CollisionGeometry {
                source_piece_id: piece_id.clone(),
                source_bounds: IrregularBounds::new(0.0, 0.0, width, height),
                sampled_points: points,
                convex_hull: polygon.clone(),
                collision_polygon: polygon,
                placement_reference: point(0.0, 0.0),
                diagnostics: vec![],
            },
            transforms: vec![IrregularTransformCandidate {
                index: 0.0,
                rotation_deg: 0.0,
                mirrored: false,
                reason: IrregularTransformReason::Configured,
            }],
            priority_order_key: None,
        })
    }

    fn piece(id: &str) -> Arc<IrregularPreparedPiece> {
        piece_with_size(id, 2.0, 2.0)
    }

    fn place(prepared: &Arc<IrregularPreparedPiece>, x: f64, y: f64) -> Arc<IrregularPlacedPiece> {
        let transform = prepared.transforms[0];
        Arc::new(IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: prepared.piece_id.clone(),
                source_piece_id: prepared.source.id.clone(),
                placement_reference: Some(prepared.collision_geometry.placement_reference),
                transform: IrregularTransform {
                    translate_x: x,
                    translate_y: y,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: prepared.source.id.clone(),
                transform,
                polygon: prepared.collision_geometry.collision_polygon.clone(),
                bounds: prepared.collision_geometry.source_bounds,
            },
        })
    }

    fn sample_metrics(hash: &str, maximum_side: f64) -> IntrinsicStrictCompletedMetrics {
        IntrinsicStrictCompletedMetrics {
            envelope_maximum_side_mm: maximum_side,
            envelope_area_mm2: maximum_side * maximum_side,
            envelope_span_mm: maximum_side * 2.0,
            enclosed_cavity_count: 0.0,
            total_enclosed_cavity_area_mm2: 0.0,
            largest_occupied_hull_gap_ratio: 0.0,
            isolated_piece_count: 0.0,
            positive_contact_component_count: 1.0,
            largest_positive_contact_component_size: 3.0,
            largest_positive_contact_component_ratio: 1.0,
            occupied_area_outside_largest_contact_component_mm2: 0.0,
            occupied_hull_waste_ratio: 0.0,
            total_structural_contacts: 2.0,
            dominant_structural_contacts: 2.0,
            contact_units: 2.0,
            shared_boundary_length_mm: 4.0,
            canonical_geometry_hash: hash.to_string(),
            runtime_ms: 1.0,
            exact: None,
        }
    }

    fn sample_run(
        hash: &str,
        maximum_side: f64,
        role: IntrinsicReconstructionRole,
    ) -> IntrinsicReconstructionRun {
        IntrinsicReconstructionRun {
            role,
            source_endpoint_hash: None,
            candidate_mode: IntrinsicStrictCandidateMode::Comparator(
                IntrinsicStrictComparatorMode::PureGrowth,
            ),
            piece_ids: vec![],
            effective_order_key: String::new(),
            status: IntrinsicReconstructionRunStatus::Completed,
            duplicate_of: None,
            requested_candidate_evaluations: None,
            consumed_candidate_evaluations: None,
            placed_collision_geometries: vec![],
            step_trace: vec![],
            gap_fill_evidence: vec![],
            metrics: Some(sample_metrics(hash, maximum_side)),
            runtime_ms: 1.0,
        }
    }

    #[test]
    fn derives_paired_q0_q90_traversal_orders_from_exact_endpoint_geometry() {
        let first = piece("first");
        let second = piece("second");
        let third = piece("third");
        let placed = vec![
            place(&first, 0.0, 0.0),
            place(&second, 10.0, 20.0),
            place(&third, 20.0, 10.0),
        ];
        let orders = build_canonical_endpoint_orders(
            &[first.clone(), second.clone(), third.clone()],
            &placed,
        );

        let ids_for = |role: IntrinsicReconstructionRole| -> Vec<PieceId> {
            orders
                .iter()
                .find(|order| order.role == role)
                .expect("role present")
                .pieces
                .iter()
                .map(|piece| prepared_piece_id(piece))
                .collect()
        };

        assert_eq!(
            ids_for(IntrinsicReconstructionRole::EndpointQ0LeftToRight),
            vec![
                PieceId::new("first"),
                PieceId::new("second"),
                PieceId::new("third")
            ]
        );
        assert_eq!(
            ids_for(IntrinsicReconstructionRole::EndpointQ0RightToLeft),
            vec![
                PieceId::new("third"),
                PieceId::new("second"),
                PieceId::new("first")
            ]
        );
        assert_eq!(
            ids_for(IntrinsicReconstructionRole::EndpointQ90LeftToRight),
            vec![
                PieceId::new("second"),
                PieceId::new("third"),
                PieceId::new("first")
            ]
        );
        assert_eq!(
            ids_for(IntrinsicReconstructionRole::EndpointQ90RightToLeft),
            vec![
                PieceId::new("first"),
                PieceId::new("third"),
                PieceId::new("second")
            ]
        );
    }

    #[test]
    fn stacks_every_geometry_derived_order_with_gap_contained_placement() {
        let first = piece("first");
        let second = piece_with_size("second", 3.0, 2.0);
        let endpoint = IntrinsicReconstructionSeed {
            role: IntrinsicReconstructionSeedRole::CanonicalGrid,
            canonical_geometry_hash: "endpoint".to_string(),
            placed_collision_geometries: vec![place(&first, 0.0, 0.0), place(&second, 2.0, 0.0)],
            step_trace: vec![],
            metrics: sample_metrics("endpoint", 5.0),
        };
        let specs =
            build_intrinsic_reconstruction_specs(&[first.clone(), second.clone()], &endpoint);
        let roles: Vec<IntrinsicReconstructionRole> = specs.iter().map(|spec| spec.role).collect();

        assert_eq!(
            roles,
            vec![
                IntrinsicReconstructionRole::ReversedPriority,
                IntrinsicReconstructionRole::EndpointQ0LeftToRight,
                IntrinsicReconstructionRole::EndpointQ0RightToLeft,
                IntrinsicReconstructionRole::EndpointQ90LeftToRight,
                IntrinsicReconstructionRole::EndpointQ90RightToLeft,
                IntrinsicReconstructionRole::OpenPocketFirst,
                IntrinsicReconstructionRole::ReversedPriorityOpenPocketFirst,
                IntrinsicReconstructionRole::EndpointQ0LeftToRightOpenPocketFirst,
                IntrinsicReconstructionRole::EndpointQ0RightToLeftOpenPocketFirst,
                IntrinsicReconstructionRole::EndpointQ90LeftToRightOpenPocketFirst,
                IntrinsicReconstructionRole::EndpointQ90RightToLeftOpenPocketFirst,
            ]
        );
        assert_eq!(INTRINSIC_RECONSTRUCTION_ROLES.len(), 14);
        let gap_contained_count = specs
            .iter()
            .filter(|spec| {
                matches!(
                    spec.candidate_mode,
                    IntrinsicStrictCandidateMode::GapContained
                )
            })
            .count();
        assert_eq!(gap_contained_count, 6);
    }

    #[test]
    fn selects_role_families_without_changing_reconstruction_order() {
        let first = piece("first");
        let second = piece_with_size("second", 3.0, 2.0);
        let endpoint = IntrinsicReconstructionSeed {
            role: IntrinsicReconstructionSeedRole::CanonicalGrid,
            canonical_geometry_hash: "endpoint".to_string(),
            placed_collision_geometries: vec![place(&first, 0.0, 0.0), place(&second, 2.0, 0.0)],
            step_trace: vec![],
            metrics: sample_metrics("endpoint", 5.0),
        };
        let specs =
            build_intrinsic_reconstruction_specs(&[first.clone(), second.clone()], &endpoint);

        let pure_growth_count = specs
            .iter()
            .filter(|spec| {
                intrinsic_reconstruction_spec_matches_family(
                    spec,
                    IntrinsicReconstructionRoleFamily::PureGrowth,
                )
            })
            .count();
        assert_eq!(pure_growth_count, 5);
        let gap_contained_count = specs
            .iter()
            .filter(|spec| {
                intrinsic_reconstruction_spec_matches_family(
                    spec,
                    IntrinsicReconstructionRoleFamily::GapContained,
                )
            })
            .count();
        assert_eq!(gap_contained_count, 6);
        let all_count = specs
            .iter()
            .filter(|spec| {
                intrinsic_reconstruction_spec_matches_family(
                    spec,
                    IntrinsicReconstructionRoleFamily::All,
                )
            })
            .count();
        assert_eq!(all_count, specs.len());
        let focused: Vec<&DecodeSpec> = specs
            .iter()
            .filter(|spec| {
                intrinsic_reconstruction_spec_matches_family(
                    spec,
                    IntrinsicReconstructionRoleFamily::EndpointQ90RightToLeft,
                )
            })
            .collect();
        assert_eq!(focused.len(), 1);
        assert_eq!(
            focused[0].role,
            IntrinsicReconstructionRole::EndpointQ90RightToLeft
        );
    }

    #[test]
    fn deduplicates_effective_orders_of_interchangeable_geometry_without_collapsing_distinct_shapes(
    ) {
        let first = piece("first");
        let second = piece("second");
        let rectangle = piece_with_size("rectangle", 3.0, 2.0);

        assert_eq!(
            intrinsic_reconstruction_effective_order_key(&[first.clone(), second.clone()]),
            intrinsic_reconstruction_effective_order_key(&[second.clone(), first.clone()])
        );
        assert_ne!(
            intrinsic_reconstruction_effective_order_key(&[first.clone(), rectangle.clone()]),
            intrinsic_reconstruction_effective_order_key(&[rectangle, first])
        );
    }

    #[test]
    fn deduplicates_canonical_identities_and_removes_dominated_non_baselines() {
        let runs = vec![
            sample_run(
                "larger",
                20.0,
                IntrinsicReconstructionRole::ReversedPriority,
            ),
            sample_run(
                "smaller",
                10.0,
                IntrinsicReconstructionRole::ReversedPriority,
            ),
            sample_run(
                "smaller",
                10.0,
                IntrinsicReconstructionRole::ReversedPriority,
            ),
        ];
        let retained = retain_intrinsic_reconstruction_archive(
            &runs,
            INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY,
        );
        let hashes: Vec<&str> = retained
            .iter()
            .map(|run| run.metrics.canonical_geometry_hash.as_str())
            .collect();
        assert_eq!(hashes, vec!["smaller"]);
    }

    #[test]
    fn reserves_both_distinct_baseline_geometries_before_archive_truncation() {
        let runs = vec![
            sample_run(
                "canonical-seed",
                20.0,
                IntrinsicReconstructionRole::CanonicalGrid,
            ),
            sample_run(
                "legacy-seed",
                18.0,
                IntrinsicReconstructionRole::LegacyAbsoluteEnvelope,
            ),
            sample_run(
                "frontier-leader",
                10.0,
                IntrinsicReconstructionRole::ReversedPriority,
            ),
        ];
        let retained = retain_intrinsic_reconstruction_archive(&runs, 3);
        let hashes: Vec<&str> = retained
            .iter()
            .map(|run| run.metrics.canonical_geometry_hash.as_str())
            .collect();
        assert_eq!(
            hashes,
            vec!["frontier-leader", "canonical-seed", "legacy-seed"]
        );
    }

    #[test]
    fn reports_exact_bounded_terminals() {
        let first = piece_with_size("first", 2.0, 2.0);
        let second = piece_with_size("second", 3.0, 2.0);
        let third = piece_with_size("third", 4.0, 2.0);
        let pieces = vec![first.clone(), second.clone(), third.clone()];
        let seed = IntrinsicReconstructionSeed {
            role: IntrinsicReconstructionSeedRole::SettledProtected,
            canonical_geometry_hash: "protected".to_string(),
            placed_collision_geometries: vec![
                place(&first, 0.0, 0.0),
                place(&second, 10.0, 20.0),
                place(&third, 20.0, 10.0),
            ],
            step_trace: vec![],
            metrics: sample_metrics("protected", 30.0),
        };

        let settings = settings();
        let mut cache = GeometryCacheStore::new();
        let deadline = run_intrinsic_reconstruction_portfolio(
            RunIntrinsicReconstructionPortfolioInput {
                all_prepared_pieces: &pieces,
                baseline_seeds: std::slice::from_ref(&seed),
                maximum_runtime_ms_per_decode: None,
                maximum_total_runtime_ms: Some(0.0),
                role_family: Some(IntrinsicReconstructionRoleFamily::EndpointQ90RightToLeft),
                maximum_candidate_evaluations_per_decode: None,
                maximum_total_candidate_evaluations: None,
                control: None,
                timing_now: None,
            },
            &settings,
            &mut cache,
        )
        .expect("deadline case does not fail the whole call");
        let focused = deadline
            .runs
            .iter()
            .find(|run| run.role == IntrinsicReconstructionRole::EndpointQ90RightToLeft)
            .expect("focused role present");
        assert_eq!(focused.status, IntrinsicReconstructionRunStatus::Deadline);
        assert!(!deadline.candidate_evaluation_accounting_complete);

        let mut cache = GeometryCacheStore::new();
        let per_decode_deadline = run_intrinsic_reconstruction_portfolio(
            RunIntrinsicReconstructionPortfolioInput {
                all_prepared_pieces: &pieces,
                baseline_seeds: std::slice::from_ref(&seed),
                maximum_runtime_ms_per_decode: Some(0.0),
                maximum_total_runtime_ms: None,
                role_family: Some(IntrinsicReconstructionRoleFamily::EndpointQ90RightToLeft),
                maximum_candidate_evaluations_per_decode: None,
                maximum_total_candidate_evaluations: None,
                control: None,
                timing_now: None,
            },
            &settings,
            &mut cache,
        )
        .expect("per-decode deadline remains a protected fallback");
        let focused = per_decode_deadline
            .runs
            .iter()
            .find(|run| run.role == IntrinsicReconstructionRole::EndpointQ90RightToLeft)
            .expect("focused role present");
        assert_eq!(focused.status, IntrinsicReconstructionRunStatus::Deadline);
        assert!(!per_decode_deadline.candidate_evaluation_accounting_complete);

        let mut cache = GeometryCacheStore::new();
        let capped = run_intrinsic_reconstruction_portfolio(
            RunIntrinsicReconstructionPortfolioInput {
                all_prepared_pieces: &pieces,
                baseline_seeds: std::slice::from_ref(&seed),
                maximum_runtime_ms_per_decode: None,
                maximum_total_runtime_ms: None,
                role_family: Some(IntrinsicReconstructionRoleFamily::EndpointQ90RightToLeft),
                maximum_candidate_evaluations_per_decode: Some(1.0),
                maximum_total_candidate_evaluations: Some(1.0),
                control: None,
                timing_now: None,
            },
            &settings,
            &mut cache,
        )
        .expect("capped case does not fail the whole call");
        let focused = capped
            .runs
            .iter()
            .find(|run| run.role == IntrinsicReconstructionRole::EndpointQ90RightToLeft)
            .expect("focused role present");
        assert_eq!(
            focused.status,
            IntrinsicReconstructionRunStatus::EvaluationCap
        );
        assert_eq!(capped.consumed_candidate_evaluations, 1.0);
        assert!(capped.candidate_evaluation_accounting_complete);
    }

    #[test]
    fn propagates_external_cancellation_reasons() {
        struct AbortControl {
            reason: NfpIfpAbortReason,
        }
        impl NfpIfpControl for AbortControl {
            fn checkpoint(
                &mut self,
                _phase: crate::nfp_ifp::NfpIfpCheckpointPhase,
            ) -> Result<(), NfpIfpControlAbortError> {
                Err(NfpIfpControlAbortError {
                    reason: self.reason,
                    message: "external cancellation".to_string(),
                })
            }
        }

        let first = piece_with_size("first", 2.0, 2.0);
        let second = piece_with_size("second", 3.0, 2.0);
        let third = piece_with_size("third", 4.0, 2.0);
        let pieces = vec![first.clone(), second.clone(), third.clone()];
        let seed = IntrinsicReconstructionSeed {
            role: IntrinsicReconstructionSeedRole::SettledProtected,
            canonical_geometry_hash: "protected".to_string(),
            placed_collision_geometries: vec![
                place(&first, 0.0, 0.0),
                place(&second, 10.0, 20.0),
                place(&third, 20.0, 10.0),
            ],
            step_trace: vec![],
            metrics: sample_metrics("protected", 30.0),
        };
        let settings = settings();

        for reason in [NfpIfpAbortReason::Cancelled, NfpIfpAbortReason::Deadline] {
            let mut cache = GeometryCacheStore::new();
            let mut control = AbortControl { reason };
            let result = run_intrinsic_reconstruction_portfolio(
                RunIntrinsicReconstructionPortfolioInput {
                    all_prepared_pieces: &pieces,
                    baseline_seeds: std::slice::from_ref(&seed),
                    maximum_runtime_ms_per_decode: None,
                    maximum_total_runtime_ms: None,
                    role_family: Some(IntrinsicReconstructionRoleFamily::EndpointQ90RightToLeft),
                    maximum_candidate_evaluations_per_decode: None,
                    maximum_total_candidate_evaluations: None,
                    control: Some(&mut control),
                    timing_now: None,
                },
                &settings,
                &mut cache,
            );
            match result {
                Err(IntrinsicReconstructionPortfolioFailure::Strict(
                    IntrinsicStrictDecoderFailure::Abort(abort),
                )) => {
                    assert_eq!(abort.reason, reason);
                }
                other => panic!("expected a propagated external abort, got {other:?}"),
            }
        }
    }
}
