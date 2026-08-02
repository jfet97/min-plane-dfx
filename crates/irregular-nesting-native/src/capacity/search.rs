//! The empty-start intrinsic capacity search `intrinsic-capacity-v1`: a
//! depth-synchronized cold beam search producing the best-known exact
//! **partial** (subset) placement when a sheet cannot hold every prepared
//! piece, plus its resumable anytime-checkpoint encode/validate/hash
//! machinery.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicCapacitySearch.ts`
//! (2273 lines), ported here in full. Read together with
//! `docs/planning/rust-irregular-backend/characterization/capacity-search.md`
//! (the whole document) and
//! `docs/planning/rust-irregular-backend/characterization/checkpoint-encoding.md`
//! §8 (the four canonical-JSON encoders, and specifically §8.4's "curated
//! projection, not the raw stored object" warning) before touching this
//! file.
//!
//! # Reused (GREEN) modules -- never duplicated here
//!
//! - `canonical_grid::layout::measure_canonical_layout_topology_exact` --
//!   `measureCanonicalLayoutTopologyExact`, the production-default
//!   `'cohesion-frontier'` retention mode's topology authority
//!   (capacity-search.md §15 item 1: this is load-bearing for every
//!   production capacity result, not a shadow-only mode).
//! - `caches::resolve_transformed_collision_geometry` -- the same cached
//!   transformed-collision-geometry resolver TS's
//!   `GeometryKernel.transformCollisionGeometry` calls.
//! - `nfp_ifp::{generate_placement_candidates, LegalCandidateMemo,
//!   NfpIfpControl}` -- the full NFP/IFP candidate-generation service and
//!   its cooperative-cancellation seam.
//! - `search::beam_state::IrregularBeamState` (all canonical keys,
//!   `.with_placement`/`.with_unplaced_piece`, the timing seam) -- the
//!   Arc-wrapped immutable partial-layout state machine.
//! - `search::strict_decoder::{origin_anchor_candidates,
//!   transform_candidate_order, intrinsic_coordinate_domain}` -- the exact
//!   candidate-generation seed and transform-ordering contract this cluster
//!   consumes verbatim.
//! - `search::placement_scorer::score_candidate` -- the contact-successor
//!   role's `sharedCollisionBoundaryLengthMm` measurement.
//! - `checkpoints::canonical_json::{intrinsic_capacity_canonical_json,
//!   JsValue}` -- Encoder A, this checkpoint's own integrity-hash/
//!   request-fingerprint preimage builder (ordinal key sort).
//! - `capacity::{endpoint, material, preflight}` -- this cluster's sibling
//!   capacity-core modules, used exactly as already ported.
//!
//! # `serde_json` reuse for the request-fingerprint's whole-domain-class fields
//!
//! `intrinsicCapacityRequestFingerprint` hashes `sheet`/`preparedPieces`
//! as **whole, unprojected domain-class instances**
//! (checkpoint-encoding.md §8.6), which walks whichever own-enumerable keys
//! `IrregularPreparedPiece`/`SheetSpec` happen to expose -- flagged as an
//! open verification risk in `capacity-search.md` §15 item 2. This port
//! resolves that risk by reuse rather than hand-rolled re-derivation:
//! `domain::piece`/`domain::sheet`'s own `#[derive(Serialize)]` impls
//! (`#[serde(rename_all = "camelCase")]` plus
//! `#[serde(skip_serializing_if = "Option::is_none")]` on every field TS
//! independently `hasOwnProperty`-gates) already reproduce the exact same
//! conditional-key-presence contract those domain modules' own doc comments
//! establish. [`json_value_to_js_value`] converts the resulting
//! `serde_json::Value` into this cluster's own [`JsValue`] tree (re-deriving
//! every number as `f64` and feeding it back through
//! [`crate::js_number::number_to_js_string`] via `intrinsic_capacity_canonical_json`'s
//! own number branch, rather than trusting `serde_json`'s own float
//! formatting, which does not reproduce ECMAScript `Number::toString`'s
//! exponential-notation thresholds) -- byte-exact and single-source-of-truth
//! with the domain layer's own already-vetted field-presence semantics,
//! instead of a second, independently-drifting hand-written projector.
//!
//! # Seam: `CapacitySearchControl`
//!
//! TS threads `input.control?: IrregularNfpIfpControl` directly into both
//! the standalone `'candidate-points'` checkpoint call (once per beam-entry
//! x transform pair) and into `generatePlacementCandidates`. A caller-
//! supplied `Option<&mut dyn NfpIfpControl>` cannot be reborrowed repeatedly
//! across sequential loop iterations for an unsized trait-object target
//! (documented at length on `nfp_ifp::service::nfp_checkpoint`'s own doc
//! comment); [`CapacitySearchControl`] is a tiny concrete (`Sized`) local
//! wrapper implementing [`NfpIfpControl`] itself (`None` inner => an
//! always-`Ok` no-op checkpoint, behaviorally identical to TS's
//! `if (input.control !== undefined)` skip-when-absent guard, since a
//! skipped call and a no-op-Ok call are observably identical here), so a
//! plain `&mut control` reborrow at each of this cluster's two call sites
//! works exactly like `search::strict_decoder`'s own `DeadlineControl`
//! wrapper for the same reason.
//!
//! # Rust-only addition: an injectable `timing_now` clock seam
//!
//! `checkpoint-encoding.md` §10.2 documents this file's TS counterpart as
//! the one checkpoint producer with **no** injectable clock seam at all (20
//! bare `performance.now()` call sites) -- explicitly flagged as a gap for a
//! Rust port intending deterministic `IntrinsicCapacitySearchPhaseTimings`
//! differential parity (the checkpoint itself has no timing field, so this
//! gap never desynchronizes checkpoint bytes, only the separate
//! `phaseTimings` diagnostic). [`RunIntrinsicCapacityColdSearchInput::timing_now`]
//! adds that seam Rust-side (mirroring `search::strict_decoder`'s own
//! independently-declared `timingNow`/`default_timing_now` pair, per that
//! module's doc: "a second, unrelated seam instance ... not a shared
//! threading"), defaulting to a process-relative monotonic clock when
//! omitted. The TS side of this seam is added separately per this task's
//! sanctioned R13 edit to `intrinsicCapacitySearch.ts` itself.

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use num_bigint::BigInt;
use serde::{Serialize, Serializer};

use crate::caches::{
    resolve_transformed_collision_geometry, CandidateDomain, GeometryCacheStore,
    NfpCandidatePruningMode, TransformCollisionGeometryKeyInput,
    DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
};
use crate::canonical_grid::layout::{
    measure_canonical_layout_topology_exact, CanonicalLayoutTopology, CanonicalLayoutTopologyExact,
};
use crate::canonical_grid::to_grid_mm;
use crate::checkpoints::canonical_json::{intrinsic_capacity_canonical_json, JsValue};
use crate::clipper::core::f64_to_bigint;
use crate::domain::{
    CollisionGeometry, IrregularNestingSettings, IrregularPlacedPiece, IrregularPlacement,
    IrregularPlacementCandidate, IrregularPreparedPiece, IrregularTransform,
    IrregularTransformCandidate, PieceId, SheetSpec, TransformedCollisionGeometry,
};
use crate::geometry::hash::sha256_hex;
use crate::js_number::{cmp_js_code_units, is_safe_integer, js_math, number_to_js_string};
use crate::nfp_ifp::{
    generate_placement_candidates, GeneratePlacementCandidatesInput, LegalCandidateMemo,
    NfpIfpCheckpointPhase, NfpIfpControl, NfpIfpControlAbortError, NfpIfpError,
};
use crate::search::beam_state::{
    IrregularBeamState, IrregularBeamStateInput, IrregularCollisionBounds, TimingNowFn,
    WithPlacementInput, WithUnplacedPieceInput,
};
use crate::search::placement_scorer::{score_candidate, ScoreIrregularPlacementCandidateInput};
use crate::search::strict_decoder::{
    intrinsic_coordinate_domain, origin_anchor_candidates, transform_candidate_order,
};
use crate::validation::placement::IrregularGeometryInputError;

use super::endpoint::{
    compare_intrinsic_capacity_endpoints, intrinsic_capacity_span_fits_sheet,
    intrinsic_capacity_state_grid_span, materialize_intrinsic_capacity_endpoint,
    measure_intrinsic_capacity_cavities, IntrinsicCapacityCavityCache,
    IntrinsicCapacityCavityMetrics, IntrinsicCapacityEndpoint, IntrinsicCapacityEndpointOrigin,
    IntrinsicCapacityGridSpan, MaterializeIntrinsicCapacityEndpointInput,
};
use super::material::intrinsic_capacity_prepared_piece_id;
use super::preflight::IntrinsicCapacityError;

// ===========================================================================
// Fixed bounds and version constants (`intrinsicCapacitySearch.ts:53-61`).
// ===========================================================================

/// TS: `intrinsicCapacitySearch.ts:54-59` `INTRINSIC_CAPACITY_V1_BOUNDS`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicCapacityV1Bounds {
    pub cold_beam_width: f64,
    pub local_legal_placement_fanout: f64,
    pub minimum_placement_evaluation_cap: f64,
    pub placement_evaluation_quota_per_depth: f64,
}

/// Fixed first-version bounds of the empty-start intrinsic capacity search.
pub const INTRINSIC_CAPACITY_V1_BOUNDS: IntrinsicCapacityV1Bounds = IntrinsicCapacityV1Bounds {
    cold_beam_width: 16.0,
    local_legal_placement_fanout: 3.0,
    minimum_placement_evaluation_cap: 50_000.0,
    placement_evaluation_quota_per_depth: 4_096.0,
};

/// TS: `intrinsicCapacitySearch.ts:61` `INTRINSIC_ANYTIME_CHECKPOINT_VERSION`.
/// See this module's top doc, "`INTRINSIC_ANYTIME_CHECKPOINT_VERSION`
/// duplication note" cross-reference on `capacity::telemetry` -- that file
/// carries an independent, byte-identical copy for the same
/// cross-module-ownership reason.
pub const INTRINSIC_ANYTIME_CHECKPOINT_VERSION: &str = "intrinsic-anytime-checkpoint-v3";

/// TS: `intrinsicCapacitySearch.ts:63` `IntrinsicCapacitySettlement`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacitySettlement {
    Exhausted,
    EvaluationCap,
    Paused,
}

impl Serialize for IntrinsicCapacitySettlement {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl IntrinsicCapacitySettlement {
    /// TS: the literal union member each variant represents
    /// (`intrinsicCapacitySearch.ts:63`). Any TS-facing string (diagnostic
    /// messages, boundary JSON, ...) must use this, not `{:?}` -- `Debug`'s
    /// PascalCase variant name (`EvaluationCap`) diverges from TS's
    /// kebab-case string (`evaluation-cap`).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Exhausted => "exhausted",
            Self::EvaluationCap => "evaluation-cap",
            Self::Paused => "paused",
        }
    }
}

/// TS: `intrinsicCapacitySearch.ts:65-71` `IntrinsicAnytimeProducerRole`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeProducerRole {
    CapacityCold,
    CapacityCohesionShadow,
    CapacityQualityWarmPrefix,
    CapacityWarmPrefix,
    LegacyComplete,
    ExperimentalPlaceDeferComplete,
}

impl IntrinsicAnytimeProducerRole {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicAnytimeProducerRole::CapacityCold => "capacity-cold",
            IntrinsicAnytimeProducerRole::CapacityCohesionShadow => "capacity-cohesion-shadow",
            IntrinsicAnytimeProducerRole::CapacityQualityWarmPrefix => {
                "capacity-quality-warm-prefix"
            }
            IntrinsicAnytimeProducerRole::CapacityWarmPrefix => "capacity-warm-prefix",
            IntrinsicAnytimeProducerRole::LegacyComplete => "legacy-complete",
            IntrinsicAnytimeProducerRole::ExperimentalPlaceDeferComplete => {
                "experimental-place-defer-complete"
            }
        }
    }
}

/// TS: `intrinsicCapacitySearch.ts:73-77` `IntrinsicAnytimeArchiveCohort`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeArchiveCohort {
    Complete,
    Partial,
    ExperimentalComplete,
}

impl IntrinsicAnytimeArchiveCohort {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicAnytimeArchiveCohort::Complete => "complete",
            IntrinsicAnytimeArchiveCohort::Partial => "partial",
            IntrinsicAnytimeArchiveCohort::ExperimentalComplete => "experimental-complete",
        }
    }
}

/// TS: `intrinsicCapacitySearch.ts:78` `IntrinsicAnytimeEligibility`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeEligibility {
    CompleteEligible,
    SubsetOnly,
}

impl IntrinsicAnytimeEligibility {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicAnytimeEligibility::CompleteEligible => "completeEligible",
            IntrinsicAnytimeEligibility::SubsetOnly => "subsetOnly",
        }
    }
}

/// TS: `intrinsicCapacitySearch.ts:80-87` `IntrinsicCapacityRetentionMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacityRetentionMode {
    Objective,
    AreaFirstShadow,
    AxisBucketsShadow,
    CohesionFrontier,
    CohesionFrontierShadow,
    QualityFrontier,
}

impl IntrinsicCapacityRetentionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicCapacityRetentionMode::Objective => "objective",
            IntrinsicCapacityRetentionMode::AreaFirstShadow => "area-first-shadow",
            IntrinsicCapacityRetentionMode::AxisBucketsShadow => "axis-buckets-shadow",
            IntrinsicCapacityRetentionMode::CohesionFrontier => "cohesion-frontier",
            IntrinsicCapacityRetentionMode::CohesionFrontierShadow => "cohesion-frontier-shadow",
            IntrinsicCapacityRetentionMode::QualityFrontier => "quality-frontier",
        }
    }
}

/// TS: `intrinsicCapacitySearch.ts:88-91` `IntrinsicAnytimeFitMask`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicAnytimeFitMask {
    pub q0: bool,
    pub q90: bool,
}

/// TS: `intrinsicCapacitySearch.ts:93-111` `IntrinsicAnytimeDecisionState`.
#[derive(Clone, Debug)]
pub struct IntrinsicAnytimeDecisionState {
    pub state: Arc<IrregularBeamState>,
    /// Exact private metadata consumed by the next placement after resume.
    pub continuation_metadata_identity: String,
    pub eligibility: IntrinsicAnytimeEligibility,
    pub placed_prepared_ids: Vec<PieceId>,
    pub pending_prepared_ids: Vec<PieceId>,
    pub deferred_prepared_ids: Vec<PieceId>,
    pub permanently_skipped_prepared_ids: Vec<PieceId>,
    pub pending_order: Vec<PieceId>,
    pub cursor: f64,
    pub pass: f64,
    /// TS: `Readonly<Record<string, number>>`. Always empty in this cold
    /// cluster (see this module's top doc, deferral is a foreign concept
    /// here) -- kept as an ordered pair list, not a map, per this crate's
    /// `checkpoints::canonical_json::JsValue::Obj` convention.
    pub deferral_counts: Vec<(String, f64)>,
    pub placed_doubled_material_area_grid2: BigInt,
    pub cavities: IntrinsicCapacityCavityMetrics,
    pub anchored_occupied_key: String,
    pub grid_span: IntrinsicCapacityGridSpan,
    pub fit_mask: IntrinsicAnytimeFitMask,
}

/// TS: `intrinsicCapacitySearch.ts:113-117` `IntrinsicAnytimeDepthBudgetLedger`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicAnytimeDepthBudgetLedger {
    pub depth: f64,
    pub consumed_placement_evaluations: f64,
    pub quota_exhausted: bool,
}

/// TS: `intrinsicCapacitySearch.ts:123-127`'s inline `perCohort` shape.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicAnytimeBudgetPerCohort {
    pub complete: f64,
    pub partial: f64,
    pub experimental_complete: f64,
}

/// TS: `intrinsicCapacitySearch.ts:119-128` `IntrinsicAnytimeBudgetLedgers`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicAnytimeBudgetLedgers {
    pub total_placement_evaluation_cap: f64,
    pub total_consumed_placement_evaluations: f64,
    pub per_depth: Vec<IntrinsicAnytimeDepthBudgetLedger>,
    pub per_cohort: IntrinsicAnytimeBudgetPerCohort,
}

/// TS: `intrinsicCapacitySearch.ts:130-133` `IntrinsicAnytimeNoSkipFrontierState`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicAnytimeNoSkipFrontierState {
    pub present: bool,
    pub first_loss_depth: Option<f64>,
}

/// TS: `intrinsicCapacitySearch.ts:135-141` `IntrinsicAnytimeIncumbentBinding`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicAnytimeIncumbentBinding {
    pub canonical_geometry_hash: String,
    pub placed_count: f64,
    pub placed_doubled_material_area_grid2: BigInt,
    pub origin: IntrinsicCapacityEndpointOrigin,
    pub selected_rotation_deg: f64,
}

/// TS: `intrinsicCapacitySearch.ts:143-152` `IntrinsicCapacitySearchCounters`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicCapacitySearchCounters {
    pub pruned_by_attainable_count: f64,
    pub pruned_by_attainable_material: f64,
    pub deduplicated_successors: f64,
    pub fit_rejected_candidates: f64,
    pub invalid_candidates: f64,
    pub endpoint_fit_rejections: f64,
    pub completed_depths: f64,
    pub depth_quota_exhaustions: f64,
}

/// TS: `intrinsicCapacitySearch.ts:166-167`'s two single-literal fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeCheckpointSettlement {
    Active,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeCheckpointCensoring {
    None,
}

/// TS: `intrinsicCapacitySearch.ts:154-172` `IntrinsicAnytimeCheckpoint`.
#[derive(Clone, Debug)]
pub struct IntrinsicAnytimeCheckpoint {
    pub version: String,
    pub request_fingerprint: String,
    pub producer_role: IntrinsicAnytimeProducerRole,
    pub archive_cohort: IntrinsicAnytimeArchiveCohort,
    pub search_bounds: IntrinsicCapacityV1Bounds,
    pub incumbent_binding: Option<IntrinsicAnytimeIncumbentBinding>,
    pub frontier: Vec<IntrinsicAnytimeDecisionState>,
    pub next_depth: f64,
    pub depth_boundary_resume_position: f64,
    pub budget_ledgers: IntrinsicAnytimeBudgetLedgers,
    pub scheduler_deficit: f64,
    pub settlement: IntrinsicAnytimeCheckpointSettlement,
    pub censoring: IntrinsicAnytimeCheckpointCensoring,
    pub no_skip_frontier: IntrinsicAnytimeNoSkipFrontierState,
    pub counters: IntrinsicCapacitySearchCounters,
    pub topology_retention_depths: Vec<IntrinsicCapacityTopologyRetentionDepthTrace>,
    pub integrity_hash: String,
}

/// TS: `intrinsicCapacitySearch.ts:174-196` `IntrinsicCapacitySearchTrace`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacitySearchTrace {
    pub beam_width: f64,
    pub local_legal_placement_fanout: f64,
    pub placement_evaluation_cap: f64,
    pub placement_evaluation_quota_per_depth: f64,
    pub consumed_placement_evaluations: f64,
    /// Prefix terminalization must never consume placement evaluations.
    pub auxiliary_placement_evaluations: f64,
    pub pruned_by_attainable_count: f64,
    pub pruned_by_attainable_material: f64,
    pub deduplicated_successors: f64,
    pub fit_rejected_candidates: f64,
    pub invalid_candidates: f64,
    pub endpoint_fit_rejections: f64,
    pub completed_depths: f64,
    pub depth_quota_exhaustions: f64,
    pub piece_count: f64,
    pub settlement: IntrinsicCapacitySettlement,
    /// Observer-only exact topology representatives around each retention
    /// boundary. Presence/omission-encoded: `None` when empty, `Some` (never
    /// empty) otherwise -- deliberately distinct from the checkpoint's own
    /// always-array `topology_retention_depths` field (see this module's top
    /// doc / capacity-search.md §3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_retention_depths: Option<Vec<IntrinsicCapacityTopologyRetentionDepthTrace>>,
}

/// TS: `intrinsicCapacitySearch.ts:198-203` `IntrinsicCapacityTopologyRepresentativeRole`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacityTopologyRepresentativeRole {
    TerminalObjective,
    MinimumComponents,
    MinimumIsolated,
    MaximumLargestComponent,
    MinimumHullWaste,
}

impl Serialize for IntrinsicCapacityTopologyRepresentativeRole {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl IntrinsicCapacityTopologyRepresentativeRole {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicCapacityTopologyRepresentativeRole::TerminalObjective => "terminal-objective",
            IntrinsicCapacityTopologyRepresentativeRole::MinimumComponents => "minimum-components",
            IntrinsicCapacityTopologyRepresentativeRole::MinimumIsolated => "minimum-isolated",
            IntrinsicCapacityTopologyRepresentativeRole::MaximumLargestComponent => {
                "maximum-largest-component"
            }
            IntrinsicCapacityTopologyRepresentativeRole::MinimumHullWaste => "minimum-hull-waste",
        }
    }
}

/// TS: `intrinsicCapacitySearch.ts:209` `decision: 'place' | 'skip'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacityDecision {
    Place,
    Skip,
}

impl Serialize for IntrinsicCapacityDecision {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl IntrinsicCapacityDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicCapacityDecision::Place => "place",
            IntrinsicCapacityDecision::Skip => "skip",
        }
    }
}

/// TS: `intrinsicCapacitySearch.ts:210` `proposalRole: 'compactness' | 'contact' | 'skip'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacityProposalRole {
    Compactness,
    Contact,
    Skip,
}

impl Serialize for IntrinsicCapacityProposalRole {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl IntrinsicCapacityProposalRole {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicCapacityProposalRole::Compactness => "compactness",
            IntrinsicCapacityProposalRole::Contact => "contact",
            IntrinsicCapacityProposalRole::Skip => "skip",
        }
    }
}

/// TS: `intrinsicCapacitySearch.ts:205-219` `IntrinsicCapacityTopologyRepresentative`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityTopologyRepresentative {
    pub role: IntrinsicCapacityTopologyRepresentativeRole,
    pub decision_identity: String,
    pub parent_decision_identity: String,
    pub decision: IntrinsicCapacityDecision,
    pub proposal_role: IntrinsicCapacityProposalRole,
    pub piece_id: PieceId,
    pub anchored_occupied_key: String,
    pub placed_count: f64,
    #[serde(serialize_with = "crate::capacity::serialize_bigint_decimal_string")]
    pub placed_doubled_material_area_grid2: BigInt,
    pub cavities: IntrinsicCapacityCavityMetrics,
    pub grid_span: IntrinsicCapacityGridSpan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology: Option<CanonicalLayoutTopologyExact>,
    pub retained: bool,
}

/// TS: `intrinsicCapacitySearch.ts:221-237` `IntrinsicCapacityTopologyRetentionDepthTrace`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityTopologyRetentionDepthTrace {
    pub depth: f64,
    pub piece_id: PieceId,
    pub measured_survivor_count: f64,
    pub retained_count: f64,
    pub best_accounting_stratum_count: f64,
    pub topology_measurement_count: f64,
    pub topology_measurement_ms: f64,
    pub legal_candidate_count: f64,
    pub contact_measured_candidate_count: f64,
    pub positive_contact_candidate_count: f64,
    pub contact_measurement_ms: f64,
    pub contact_selected_successor_count: f64,
    pub contact_deduplicated_successor_count: f64,
    pub contact_retained_successor_count: f64,
    pub representatives: Vec<IntrinsicCapacityTopologyRepresentative>,
}

/// TS: `intrinsicCapacitySearch.ts:240-248` `IntrinsicCapacitySearchPhaseTimings`.
/// Benchmark-only phase buckets; capture must default off in production.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicCapacitySearchPhaseTimings {
    pub candidate_generation_ms: f64,
    pub candidate_evaluation_ms: f64,
    pub successor_construction_ms: f64,
    pub cavity_measurement_ms: f64,
    pub retention_ms: f64,
    pub endpoint_materialization_ms: f64,
    pub total_ms: f64,
}

/// TS: `intrinsicCapacitySearch.ts:251` `status: 'paused' | 'settled'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacitySearchStatus {
    Paused,
    Settled,
}

/// TS: `intrinsicCapacitySearch.ts:250-257` `IntrinsicCapacitySearchResult`.
#[derive(Clone, Debug)]
pub struct IntrinsicCapacitySearchResult {
    pub status: IntrinsicCapacitySearchStatus,
    /// Deduplicated cold endpoints ranked by the capacity objective.
    pub endpoints: Vec<IntrinsicCapacityEndpoint>,
    pub trace: IntrinsicCapacitySearchTrace,
    pub phase_timings: Option<IntrinsicCapacitySearchPhaseTimings>,
    pub checkpoint: Option<IntrinsicAnytimeCheckpoint>,
}

/// TS: `intrinsicCapacitySearch.ts:280-284` `IntrinsicCapacityWarmPrefixSeed`.
#[derive(Clone, Debug)]
pub struct IntrinsicCapacityWarmPrefixSeed {
    pub source_role: String,
    pub depth: f64,
    pub state: Arc<IrregularBeamState>,
}

/// TS: `intrinsicCapacitySearch.ts:259-278` `RunIntrinsicCapacityColdSearchInput`.
/// See this module's top doc for the `control`/`timing_now` seam design.
pub struct RunIntrinsicCapacityColdSearchInput<'a> {
    pub sheet: &'a SheetSpec,
    pub prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    pub material_areas_by_piece_id: &'a HashMap<PieceId, BigInt>,
    pub cavity_cache: &'a mut IntrinsicCapacityCavityCache,
    /// Optional prefix incumbent used only for the strict attainable bounds.
    pub incumbent: Option<&'a IntrinsicCapacityEndpoint>,
    pub control: Option<&'a mut dyn NfpIfpControl>,
    pub capture_phase_timings: bool,
    /// Resume only from a validated depth-boundary checkpoint.
    pub checkpoint: Option<IntrinsicAnytimeCheckpoint>,
    /// Test/scheduler seam. Omit to run through settlement.
    pub maximum_depth_boundaries: Option<f64>,
    /// Exact fitting, skip-free prefix used only by an independent warm lane.
    pub warm_prefix_seed: Option<IntrinsicCapacityWarmPrefixSeed>,
    /// Deterministic scheduler credit carried by a paused protected lane.
    pub scheduler_deficit: Option<f64>,
    /// Experimental protected-lane retention; terminal objective stays
    /// unchanged.
    pub retention_mode: Option<IntrinsicCapacityRetentionMode>,
    pub settings: &'a IrregularNestingSettings,
    pub geometry_cache: &'a mut GeometryCacheStore,
    /// Rust-only deterministic clock seam; see this module's top doc.
    pub timing_now: Option<&'a TimingNowFn>,
}

/// TS: `intrinsicCapacitySearch.ts:286-298` `CapacityBeamEntry`.
#[derive(Clone, Debug)]
struct CapacityBeamEntry {
    state: Arc<IrregularBeamState>,
    placed_doubled_material_area_grid2: BigInt,
    anchored_occupied_key: String,
    grid_span: IntrinsicCapacityGridSpan,
    cavities: IntrinsicCapacityCavityMetrics,
    observer_transition: Option<CapacityObserverTransition>,
    /// The successor identity derived once at construction
    /// (`derive_intrinsic_capacity_successor_identity`): both identity
    /// inputs (`state.placement_order`, `anchored_occupied_key`) are fixed
    /// for the entry's whole lifetime, and the topology-retention memo
    /// previously rebuilt this string (a sort plus a canonical-JSON encode)
    /// on every one of its ~186k lookups per C1 job.
    successor_identity: String,
}

/// Constructs a beam entry, deriving its successor identity exactly once.
fn make_capacity_beam_entry(
    state: Arc<IrregularBeamState>,
    placed_doubled_material_area_grid2: BigInt,
    anchored_occupied_key: String,
    grid_span: IntrinsicCapacityGridSpan,
    cavities: IntrinsicCapacityCavityMetrics,
    observer_transition: Option<CapacityObserverTransition>,
) -> CapacityBeamEntry {
    let successor_identity =
        derive_intrinsic_capacity_successor_identity(&state, &anchored_occupied_key);
    CapacityBeamEntry {
        state,
        placed_doubled_material_area_grid2,
        anchored_occupied_key,
        grid_span,
        cavities,
        observer_transition,
        successor_identity,
    }
}

#[derive(Clone, Debug)]
struct CapacityObserverTransition {
    parent_decision_identity: String,
    decision: IntrinsicCapacityDecision,
    proposal_role: IntrinsicCapacityProposalRole,
    piece_id: PieceId,
}

/// TS: `intrinsicCapacitySearch.ts:300-309`/`1671-1675`
/// `ScoredCandidateReference`/`EvaluatedCandidateReference` collapsed into
/// one concrete struct (TS's `extends` relationship has no distinct runtime
/// shape once ported).
#[derive(Clone, Debug)]
struct EvaluatedCandidateReference {
    moving: TransformedCollisionGeometry,
    candidate: IrregularPlacementCandidate,
    maximum_side_grid: f64,
    envelope_area_grid2: BigInt,
    envelope_span_grid: f64,
    transform_ordinal: f64,
    grid_x: f64,
    grid_y: f64,
    width_grid: f64,
    height_grid: f64,
    shared_boundary_length_mm: Option<f64>,
}

/// TS: `intrinsicCapacitySearch.ts:311-316` `CapacitySearchError`. Drops the
/// unreachable `IrregularNestingNotImplementedError` arm, matching
/// `capacity::preflight::IntrinsicCapacityPreflightError`'s own established
/// "GREEN reused module never returns it" reasoning for the identical
/// situation.
#[derive(Clone, Debug, PartialEq)]
pub enum CapacitySearchError {
    Capacity(IntrinsicCapacityError),
    Geometry(IrregularGeometryInputError),
    Abort(NfpIfpControlAbortError),
}

impl From<NfpIfpError> for CapacitySearchError {
    fn from(value: NfpIfpError) -> Self {
        match value {
            NfpIfpError::Geometry(g) => CapacitySearchError::Geometry(g),
            NfpIfpError::Abort(a) => CapacitySearchError::Abort(a),
        }
    }
}

impl From<IrregularGeometryInputError> for CapacitySearchError {
    fn from(value: IrregularGeometryInputError) -> Self {
        CapacitySearchError::Geometry(value)
    }
}

fn capacity_error(operation: &str, message: impl Into<String>) -> CapacitySearchError {
    CapacitySearchError::Capacity(IntrinsicCapacityError {
        operation: operation.to_string(),
        message: message.into(),
    })
}

// ===========================================================================
// The `timingNow` seam's default (Rust-only addition; see this module's top
// doc).
// ===========================================================================

static PROCESS_START: LazyLock<Instant> = LazyLock::new(Instant::now);

fn default_timing_now() -> f64 {
    PROCESS_START.elapsed().as_secs_f64() * 1000.0
}

// ===========================================================================
// Seam: `CapacitySearchControl` (see this module's top doc).
// ===========================================================================

struct CapacitySearchControl<'a> {
    inner: Option<&'a mut dyn NfpIfpControl>,
}

impl NfpIfpControl for CapacitySearchControl<'_> {
    fn checkpoint(&mut self, phase: NfpIfpCheckpointPhase) -> Result<(), NfpIfpControlAbortError> {
        match self.inner.as_deref_mut() {
            None => Ok(()),
            Some(control) => control.checkpoint(phase),
        }
    }
}

// ===========================================================================
// The main search engine.
// ===========================================================================

/// TS: `intrinsicCapacitySearch.ts:329-1003` `runIntrinsicCapacityColdSearch`.
///
/// A depth-synchronized cold beam processes the immutable prepared order. At
/// every piece depth each retained state emits up to three ordinary legal
/// placement successors and one mandatory skip successor. Successors are
/// checked for exact partial q0/q90 fit and deduplicated by canonical
/// occupied-union identity before retention; states from different piece
/// depths never compete. The prefix incumbent may prune only through the
/// strict attainable-count and attainable-material bounds. A reached
/// evaluation cap settles the best retained endpoints deterministically.
pub fn run_intrinsic_capacity_cold_search(
    input: RunIntrinsicCapacityColdSearchInput<'_>,
) -> Result<IntrinsicCapacitySearchResult, CapacitySearchError> {
    let RunIntrinsicCapacityColdSearchInput {
        sheet,
        prepared_pieces,
        material_areas_by_piece_id,
        cavity_cache,
        incumbent,
        control,
        capture_phase_timings,
        checkpoint,
        maximum_depth_boundaries,
        warm_prefix_seed,
        scheduler_deficit,
        retention_mode,
        settings,
        geometry_cache,
        timing_now,
    } = input;

    let default_timing_now_ref: &TimingNowFn = &default_timing_now;
    let timing_now: &TimingNowFn = timing_now.unwrap_or(default_timing_now_ref);
    let started_at = timing_now();
    let capture = capture_phase_timings;
    let capture_topology_retention = matches!(
        retention_mode,
        Some(IntrinsicCapacityRetentionMode::CohesionFrontier)
            | Some(IntrinsicCapacityRetentionMode::CohesionFrontierShadow)
            | Some(IntrinsicCapacityRetentionMode::QualityFrontier)
    );
    let effective_retention_mode =
        retention_mode.unwrap_or(IntrinsicCapacityRetentionMode::Objective);

    let cold_beam_width = INTRINSIC_CAPACITY_V1_BOUNDS.cold_beam_width;
    let local_legal_placement_fanout = INTRINSIC_CAPACITY_V1_BOUNDS.local_legal_placement_fanout;
    let placement_evaluation_quota_per_depth =
        INTRINSIC_CAPACITY_V1_BOUNDS.placement_evaluation_quota_per_depth;
    let placement_evaluation_cap = js_math::max(
        INTRINSIC_CAPACITY_V1_BOUNDS.minimum_placement_evaluation_cap,
        prepared_pieces.len() as f64 * placement_evaluation_quota_per_depth,
    );

    let sheet_width_grid = to_grid_mm(sheet.width);
    let sheet_height_grid = to_grid_mm(sheet.height);
    let (sheet_width_grid, sheet_height_grid) = match (sheet_width_grid, sheet_height_grid) {
        (Some(w), Some(h)) => (w, h),
        _ => {
            return Err(capacity_error(
                "coldSearchSheet",
                "requested sheet has no exact canonical-grid representation.",
            ))
        }
    };

    let prepared_ids: Vec<PieceId> = prepared_pieces
        .iter()
        .map(|p| intrinsic_capacity_prepared_piece_id(p))
        .collect();
    let Some(suffix_material) = suffix_material_sums(&prepared_ids, material_areas_by_piece_id)
    else {
        return Err(capacity_error(
            "coldSearchMaterial",
            "capacity material accounting is incomplete for the prepared pieces.",
        ));
    };

    let warm_prefix = validate_warm_prefix_seed(
        warm_prefix_seed.as_ref(),
        prepared_pieces.len(),
        &prepared_ids,
        material_areas_by_piece_id,
        cavity_cache,
        sheet_width_grid,
        sheet_height_grid,
    );
    let warm_prefix_entry = match warm_prefix {
        WarmPrefixValidation::Invalid { message } => {
            return Err(capacity_error("warmPrefixSeed", message))
        }
        WarmPrefixValidation::Valid { entry } => entry,
    };

    let initial_depth = warm_prefix_entry.as_ref().map(|e| e.depth).unwrap_or(0.0);
    let producer_role = if warm_prefix_entry.is_none() {
        if retention_mode == Some(IntrinsicCapacityRetentionMode::CohesionFrontierShadow) {
            IntrinsicAnytimeProducerRole::CapacityCohesionShadow
        } else {
            IntrinsicAnytimeProducerRole::CapacityCold
        }
    } else if retention_mode == Some(IntrinsicCapacityRetentionMode::QualityFrontier) {
        IntrinsicAnytimeProducerRole::CapacityQualityWarmPrefix
    } else {
        IntrinsicAnytimeProducerRole::CapacityWarmPrefix
    };

    if let Some(max_boundaries) = maximum_depth_boundaries {
        if !is_safe_integer(max_boundaries) || max_boundaries <= 0.0 {
            return Err(capacity_error(
                "coldSearchCheckpoint",
                "maximumDepthBoundaries must be a positive safe integer.",
            ));
        }
    }
    let checkpoint_enabled = checkpoint.is_some() || maximum_depth_boundaries.is_some();
    let request_fingerprint: Option<String> = if checkpoint_enabled {
        Some(intrinsic_capacity_request_fingerprint(
            sheet,
            prepared_pieces,
            material_areas_by_piece_id,
            incumbent,
            warm_prefix_seed.as_ref(),
            scheduler_deficit,
            retention_mode,
        ))
    } else {
        None
    };
    if let Some(checkpoint_value) = &checkpoint {
        let Some(fingerprint) = &request_fingerprint else {
            return Err(capacity_error(
                "coldSearchCheckpoint",
                "checkpoint fingerprinting must be enabled for resume.",
            ));
        };
        let incumbent_binding = intrinsic_capacity_incumbent_binding(incumbent);
        let checkpoint_error = validate_intrinsic_capacity_checkpoint(ValidateCheckpointInput {
            checkpoint: checkpoint_value,
            request_fingerprint: fingerprint,
            incumbent_binding: incumbent_binding.as_ref(),
            producer_role,
            scheduler_deficit: scheduler_deficit.unwrap_or(0.0),
            prepared_ids: &prepared_ids,
            material_areas_by_piece_id,
            placement_evaluation_cap,
            sheet_width_grid,
            sheet_height_grid,
        });
        if let Some(message) = checkpoint_error {
            return Err(capacity_error("coldSearchCheckpoint", message));
        }
    }

    let mut candidate_memo = LegalCandidateMemo::new();
    let mut timings = IntrinsicCapacitySearchPhaseTimings {
        candidate_generation_ms: 0.0,
        candidate_evaluation_ms: 0.0,
        successor_construction_ms: 0.0,
        cavity_measurement_ms: 0.0,
        retention_ms: 0.0,
        endpoint_materialization_ms: 0.0,
        total_ms: 0.0,
    };

    let resumed_counters: Option<IntrinsicCapacitySearchCounters> =
        checkpoint.as_ref().map(|c| c.counters);
    let mut consumed_placement_evaluations = checkpoint
        .as_ref()
        .map(|c| c.budget_ledgers.total_consumed_placement_evaluations)
        .unwrap_or(0.0);
    let mut pruned_by_attainable_count = resumed_counters
        .map(|c| c.pruned_by_attainable_count)
        .unwrap_or(0.0);
    let mut pruned_by_attainable_material = resumed_counters
        .map(|c| c.pruned_by_attainable_material)
        .unwrap_or(0.0);
    let mut deduplicated_successors = resumed_counters
        .map(|c| c.deduplicated_successors)
        .unwrap_or(0.0);
    let mut fit_rejected_candidates = resumed_counters
        .map(|c| c.fit_rejected_candidates)
        .unwrap_or(0.0);
    let mut invalid_candidates = resumed_counters
        .map(|c| c.invalid_candidates)
        .unwrap_or(0.0);
    let mut endpoint_fit_rejections = resumed_counters
        .map(|c| c.endpoint_fit_rejections)
        .unwrap_or(0.0);
    let mut completed_depths = resumed_counters
        .map(|c| c.completed_depths)
        .unwrap_or(initial_depth);
    let mut depth_quota_exhaustions = resumed_counters
        .map(|c| c.depth_quota_exhaustions)
        .unwrap_or(0.0);
    let mut settlement = IntrinsicCapacitySettlement::Exhausted;
    let mut per_depth_budget_ledgers: Vec<IntrinsicAnytimeDepthBudgetLedger> = checkpoint
        .as_ref()
        .map(|c| c.budget_ledgers.per_depth.clone())
        .unwrap_or_else(|| {
            (0..(initial_depth as usize))
                .map(|depth| IntrinsicAnytimeDepthBudgetLedger {
                    depth: depth as f64,
                    consumed_placement_evaluations: 0.0,
                    quota_exhausted: false,
                })
                .collect()
        });
    let mut no_skip_frontier = checkpoint.as_ref().map(|c| c.no_skip_frontier).unwrap_or(
        IntrinsicAnytimeNoSkipFrontierState {
            present: true,
            first_loss_depth: None,
        },
    );
    let start_depth = checkpoint
        .as_ref()
        .map(|c| c.next_depth)
        .unwrap_or(initial_depth);
    let mut completed_depth_boundaries_this_invocation: f64 = 0.0;
    let mut topology_retention_depths: Vec<IntrinsicCapacityTopologyRetentionDepthTrace> =
        checkpoint
            .as_ref()
            .map(|c| c.topology_retention_depths.clone())
            .unwrap_or_default();

    let mut beam: Vec<CapacityBeamEntry> = if let Some(checkpoint_value) = &checkpoint {
        checkpoint_value
            .frontier
            .iter()
            .map(|entry| {
                make_capacity_beam_entry(
                    Arc::clone(&entry.state),
                    entry.placed_doubled_material_area_grid2.clone(),
                    entry.anchored_occupied_key.clone(),
                    entry.grid_span,
                    entry.cavities.clone(),
                    None,
                )
            })
            .collect()
    } else if let Some(warm_entry) = warm_prefix_entry {
        vec![warm_entry.beam_entry]
    } else {
        let empty_state = IrregularBeamState::empty(prepared_pieces.to_vec());
        let Some(empty_span) = intrinsic_capacity_state_grid_span(&empty_state) else {
            return Err(capacity_error(
                "coldSearchEmptyState",
                "the empty capacity state must have finite occupied bounds.",
            ));
        };
        let anchored_key = empty_state.canonical_occupied_geometry_key.clone();
        vec![make_capacity_beam_entry(
            empty_state,
            BigInt::from(0),
            anchored_key,
            empty_span,
            IntrinsicCapacityCavityMetrics {
                count: 0.0,
                total_area_mm2: 0.0,
                total_doubled_area_grid2: "0".to_string(),
            },
            None,
        )]
    };

    let mut control = CapacitySearchControl { inner: control };

    for depth_usize in (start_depth as usize)..prepared_pieces.len() {
        let depth = depth_usize as f64;
        let piece: &Arc<IrregularPreparedPiece> = &prepared_pieces[depth_usize];
        let piece_id: PieceId = prepared_ids[depth_usize].clone();
        let piece_material = match material_areas_by_piece_id.get(&piece_id) {
            Some(area) => area.clone(),
            None => {
                return Err(capacity_error(
                    "coldSearchMaterial",
                    format!(
                        "piece {} has no exact material accounting.",
                        piece_id.as_str()
                    ),
                ))
            }
        };
        let remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>> =
            prepared_pieces[(depth_usize + 1)..].to_vec();

        let mut successors: Vec<CapacityBeamEntry> = Vec::new();
        let mut successor_keys: HashSet<String> = HashSet::new();
        let mut contact_successor_identities: HashSet<String> = HashSet::new();
        let mut contact_fanout_trace = ContactFanoutTrace::default();

        // Reserve the skip path for every retained state before spending
        // this depth's placement quota.
        for entry in &beam {
            let skip_state = Arc::clone(&entry.state).with_unplaced_piece(WithUnplacedPieceInput {
                remaining_prepared_pieces: remaining_prepared_pieces.clone(),
                unplaced_piece_id: piece_id.clone(),
            });
            let observer_transition = if capture_topology_retention {
                Some(CapacityObserverTransition {
                    parent_decision_identity: intrinsic_capacity_successor_identity(entry),
                    decision: IntrinsicCapacityDecision::Skip,
                    proposal_role: IntrinsicCapacityProposalRole::Skip,
                    piece_id: piece_id.clone(),
                })
            } else {
                None
            };
            let skip_successor = make_capacity_beam_entry(
                skip_state,
                entry.placed_doubled_material_area_grid2.clone(),
                entry.anchored_occupied_key.clone(),
                entry.grid_span,
                entry.cavities.clone(),
                observer_transition,
            );
            push_successor(&mut successors, &mut successor_keys, skip_successor, || {
                deduplicated_successors += 1.0;
            });
        }

        let mut consumed_at_depth: f64 = 0.0;
        let mut depth_quota_exhausted = false;
        for entry in &beam {
            if depth_quota_exhausted {
                break;
            }
            let entry_placed_owned = cloned_placed(&entry.state.placed_collision_geometries);
            let mut scored: Vec<EvaluatedCandidateReference> = Vec::new();
            let mut sorted_transforms: Vec<IrregularTransformCandidate> = piece.transforms.clone();
            sorted_transforms.sort_by(transform_candidate_order);

            for (transform_ordinal, transform) in sorted_transforms.iter().enumerate() {
                if depth_quota_exhausted {
                    break;
                }
                let generation_started_at = if capture { timing_now() } else { 0.0 };
                control
                    .checkpoint(NfpIfpCheckpointPhase::CandidatePoints)
                    .map_err(CapacitySearchError::Abort)?;
                let moving = transform_collision_geometry(
                    &piece.collision_geometry,
                    transform,
                    &settings.geometry,
                    geometry_cache,
                )?;
                let legal_candidates: Vec<IrregularPlacementCandidate> =
                    if entry.state.placed_collision_geometries.is_empty() {
                        origin_anchor_candidates(&moving)
                    } else {
                        let coordinate_domain = intrinsic_coordinate_domain();
                        let gp_input = GeneratePlacementCandidatesInput {
                            sheet: &coordinate_domain,
                            placed: &entry.state.placed_collision_geometries,
                            placed_collision_index: Some(&entry.state.placed_collision_index),
                            moving: &moving,
                            settings,
                            candidate_domain: CandidateDomain::SheetlessNfp,
                            want_provenance: false,
                        };
                        generate_placement_candidates(
                            &gp_input,
                            geometry_cache,
                            DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
                            NfpCandidatePruningMode::Indexed,
                            Some(&mut candidate_memo),
                            None,
                            Some(&mut control),
                        )?
                        .candidates
                    };
                if capture_topology_retention {
                    contact_fanout_trace.legal_candidate_count += legal_candidates.len() as f64;
                }
                if capture {
                    timings.candidate_generation_ms += timing_now() - generation_started_at;
                }

                let evaluation_started_at = if capture { timing_now() } else { 0.0 };
                for candidate in &legal_candidates {
                    if consumed_at_depth >= placement_evaluation_quota_per_depth
                        || consumed_placement_evaluations >= placement_evaluation_cap
                    {
                        settlement = IntrinsicCapacitySettlement::EvaluationCap;
                        depth_quota_exhausted = true;
                        if capture {
                            timings.candidate_evaluation_ms += timing_now() - evaluation_started_at;
                        }
                        break;
                    }
                    consumed_at_depth += 1.0;
                    consumed_placement_evaluations += 1.0;
                    let Some(evaluated) =
                        evaluate_candidate(entry, &moving, candidate, transform_ordinal as f64)
                    else {
                        invalid_candidates += 1.0;
                        continue;
                    };
                    let fits = intrinsic_capacity_span_fits_sheet(
                        IntrinsicCapacityGridSpan {
                            width_grid: evaluated.width_grid,
                            height_grid: evaluated.height_grid,
                        },
                        sheet_width_grid,
                        sheet_height_grid,
                    );
                    if !fits.0 && !fits.1 {
                        fit_rejected_candidates += 1.0;
                        continue;
                    }
                    if capture_topology_retention {
                        let contact_started_at = timing_now();
                        let coordinate_domain = intrinsic_coordinate_domain();
                        let score_input = ScoreIrregularPlacementCandidateInput {
                            sheet: &coordinate_domain,
                            placed: &entry_placed_owned,
                            moving: &moving,
                            candidate,
                            policy_id: None,
                        };
                        let contact_score = score_candidate(&score_input).map_err(|error| {
                            capacity_error("capacityContactFanout", error.message)
                        })?;
                        contact_fanout_trace.measured_candidate_count += 1.0;
                        contact_fanout_trace.measurement_ms +=
                            js_math::max(0.0, timing_now() - contact_started_at);
                        if contact_score.shared_collision_boundary_length_mm > 0.0 {
                            contact_fanout_trace.positive_candidate_count += 1.0;
                        }
                        scored.push(EvaluatedCandidateReference {
                            shared_boundary_length_mm: Some(
                                contact_score.shared_collision_boundary_length_mm,
                            ),
                            ..evaluated
                        });
                    } else {
                        scored.push(evaluated);
                    }
                }
                if capture {
                    timings.candidate_evaluation_ms += timing_now() - evaluation_started_at;
                }
            }

            let construction_started_at = if capture { timing_now() } else { 0.0 };
            scored.sort_by(compare_scored_candidate_references);
            let mut built_count: usize = 0;
            // `RefCell`, not a plain `HashSet`: `build_reference` (below)
            // captures this by shared reference so a later immutable read
            // (the contact-candidate filter) can coexist with
            // `build_reference` remaining callable afterward -- a plain
            // `&mut` capture would keep an exclusive borrow alive across
            // that intervening read, which the borrow checker rejects even
            // though the two accesses never actually overlap in time.
            let built_candidate_keys: RefCell<HashSet<String>> = RefCell::new(HashSet::new());

            let mut build_reference = |reference: &EvaluatedCandidateReference,
                                       proposal_role: IntrinsicCapacityProposalRole|
             -> (bool, Option<String>) {
                built_candidate_keys
                    .borrow_mut()
                    .insert(capacity_candidate_reference_identity(reference));
                let placed_state = Arc::clone(&entry.state).with_placement(WithPlacementInput {
                    remaining_prepared_pieces: remaining_prepared_pieces.clone(),
                    placed_collision_geometry: Arc::new(IrregularPlacedPiece {
                        placement: make_capacity_placement(piece, &reference.candidate),
                        collision_geometry: reference.moving.clone(),
                    }),
                    placement_order_piece_id: piece_id.clone(),
                    on_phase_timings: None,
                    timing_now: None,
                });
                let Some(grid_span) = intrinsic_capacity_state_grid_span(&placed_state) else {
                    invalid_candidates += 1.0;
                    return (false, None);
                };
                let built_fits = intrinsic_capacity_span_fits_sheet(
                    grid_span,
                    sheet_width_grid,
                    sheet_height_grid,
                );
                if !built_fits.0 && !built_fits.1 {
                    fit_rejected_candidates += 1.0;
                    return (false, None);
                }
                let Some(anchored_occupied_key) =
                    placed_state.bottom_left_anchored_canonical_occupied_geometry_key()
                else {
                    invalid_candidates += 1.0;
                    return (false, None);
                };
                let successor = make_capacity_beam_entry(
                    placed_state,
                    &entry.placed_doubled_material_area_grid2 + &piece_material,
                    anchored_occupied_key,
                    grid_span,
                    IntrinsicCapacityCavityMetrics {
                        count: 0.0,
                        total_area_mm2: 0.0,
                        total_doubled_area_grid2: "0".to_string(),
                    },
                    if capture_topology_retention {
                        Some(CapacityObserverTransition {
                            parent_decision_identity: intrinsic_capacity_successor_identity(entry),
                            decision: IntrinsicCapacityDecision::Place,
                            proposal_role,
                            piece_id: piece_id.clone(),
                        })
                    } else {
                        None
                    },
                );
                let decision_identity = successor.successor_identity.clone();
                let added = push_successor(&mut successors, &mut successor_keys, successor, || {
                    deduplicated_successors += 1.0;
                    if proposal_role == IntrinsicCapacityProposalRole::Contact {
                        contact_fanout_trace.deduplicated_successor_count += 1.0;
                    }
                });
                (added, Some(decision_identity))
            };

            for reference in &scored {
                if built_count >= local_legal_placement_fanout as usize {
                    break;
                }
                let (added, _) =
                    build_reference(reference, IntrinsicCapacityProposalRole::Compactness);
                if added {
                    built_count += 1;
                }
            }
            if capture_topology_retention {
                let mut contact_candidates: Vec<&EvaluatedCandidateReference> = scored
                    .iter()
                    .filter(|reference| {
                        reference.shared_boundary_length_mm.unwrap_or(0.0) > 0.0
                            && !built_candidate_keys
                                .borrow()
                                .contains(&capacity_candidate_reference_identity(reference))
                    })
                    .collect();
                contact_candidates.sort_by(|a, b| compare_contact_candidate_references(a, b));
                if let Some(contact_reference) = contact_candidates.first().copied() {
                    let (added, decision_identity) =
                        build_reference(contact_reference, IntrinsicCapacityProposalRole::Contact);
                    if added {
                        contact_fanout_trace.selected_successor_count += 1.0;
                        if let Some(id) = decision_identity {
                            contact_successor_identities.insert(id);
                        }
                    }
                }
            }
            if capture {
                timings.successor_construction_ms += timing_now() - construction_started_at;
            }
        }
        if depth_quota_exhausted {
            depth_quota_exhaustions += 1.0;
        }

        let retention_started_at = if capture { timing_now() } else { 0.0 };
        let remaining_count_after_depth = prepared_pieces.len() as f64 - (depth + 1.0);
        let remaining_material_after_depth = suffix_material
            .get(depth_usize + 1)
            .cloned()
            .unwrap_or_else(|| BigInt::from(0));
        let mut surviving: Vec<CapacityBeamEntry> = Vec::new();
        for successor in successors {
            if let Some(incumbent_endpoint) = incumbent {
                let attainable_count =
                    successor.state.placement_order.len() as f64 + remaining_count_after_depth;
                if attainable_count < incumbent_endpoint.metrics.placed_count {
                    pruned_by_attainable_count += 1.0;
                    continue;
                }
                if attainable_count == incumbent_endpoint.metrics.placed_count {
                    let attainable_material = &successor.placed_doubled_material_area_grid2
                        + &remaining_material_after_depth;
                    if attainable_material
                        < incumbent_endpoint
                            .metrics
                            .placed_doubled_material_area_grid2
                    {
                        pruned_by_attainable_material += 1.0;
                        continue;
                    }
                }
            }
            surviving.push(successor);
        }

        let cavity_started_at = if capture { timing_now() } else { 0.0 };
        let mut measured_survivors: Vec<CapacityBeamEntry> = Vec::new();
        for successor in surviving {
            if successor.state.placement_order.is_empty() {
                measured_survivors.push(successor);
                continue;
            }
            match measure_intrinsic_capacity_cavities(&successor.state, cavity_cache) {
                Some(cavities) => {
                    let mut updated = successor;
                    updated.cavities = cavities;
                    measured_survivors.push(updated);
                }
                None => {
                    invalid_candidates += 1.0;
                }
            }
        }
        if capture {
            timings.cavity_measurement_ms += timing_now() - cavity_started_at;
        }

        let topology_measurements_holder = if capture_topology_retention {
            Some(CapacityTopologyMeasurements::new())
        } else {
            None
        };
        beam = retain_capacity_beam_entries(
            &measured_survivors,
            cold_beam_width,
            effective_retention_mode,
            topology_measurements_holder.as_ref(),
            timing_now,
        );
        if let Some(topology_measurements) = &topology_measurements_holder {
            let retained_successor_count = beam
                .iter()
                .filter(|entry| {
                    contact_successor_identities
                        .contains(&intrinsic_capacity_successor_identity(entry))
                })
                .count() as f64;
            topology_retention_depths.push(make_capacity_topology_retention_depth_trace(
                depth,
                &piece_id,
                &measured_survivors,
                &beam,
                topology_measurements,
                &contact_fanout_trace,
                retained_successor_count,
                timing_now,
            ));
        }
        completed_depths = depth + 1.0;
        completed_depth_boundaries_this_invocation += 1.0;
        if checkpoint_enabled {
            per_depth_budget_ledgers.push(IntrinsicAnytimeDepthBudgetLedger {
                depth,
                consumed_placement_evaluations: consumed_at_depth,
                quota_exhausted: depth_quota_exhausted,
            });
            let has_no_skip_state = beam
                .iter()
                .any(|entry| entry.state.unplaced_piece_ids.is_empty());
            no_skip_frontier = IntrinsicAnytimeNoSkipFrontierState {
                present: has_no_skip_state,
                first_loss_depth: no_skip_frontier.first_loss_depth.or({
                    if no_skip_frontier.present && !has_no_skip_state {
                        Some(depth + 1.0)
                    } else {
                        None
                    }
                }),
            };
        }
        if capture {
            timings.retention_ms += timing_now() - retention_started_at;
        }
        if beam.is_empty() {
            break;
        }
        if let Some(max_boundaries) = maximum_depth_boundaries {
            if completed_depth_boundaries_this_invocation >= max_boundaries
                && (depth + 1.0) < prepared_pieces.len() as f64
            {
                let Some(fingerprint) = &request_fingerprint else {
                    return Err(capacity_error(
                        "coldSearchCheckpoint",
                        "checkpoint fingerprint is unavailable at a requested pause boundary.",
                    ));
                };
                let counters = IntrinsicCapacitySearchCounters {
                    pruned_by_attainable_count,
                    pruned_by_attainable_material,
                    deduplicated_successors,
                    fit_rejected_candidates,
                    invalid_candidates,
                    endpoint_fit_rejections,
                    completed_depths,
                    depth_quota_exhaustions,
                };
                let incumbent_binding = intrinsic_capacity_incumbent_binding(incumbent);
                let checkpoint_out = make_intrinsic_capacity_checkpoint(MakeCheckpointInput {
                    request_fingerprint: fingerprint.clone(),
                    incumbent_binding,
                    beam: &beam,
                    prepared_ids: &prepared_ids,
                    next_depth: depth + 1.0,
                    placement_evaluation_cap,
                    consumed_placement_evaluations,
                    per_depth_budget_ledgers: &per_depth_budget_ledgers,
                    no_skip_frontier,
                    counters,
                    topology_retention_depths: &topology_retention_depths,
                    producer_role,
                    scheduler_deficit: scheduler_deficit.unwrap_or(0.0),
                    sheet_width_grid,
                    sheet_height_grid,
                });
                let total_ms = js_math::max(0.0, timing_now() - started_at);
                return Ok(IntrinsicCapacitySearchResult {
                    status: IntrinsicCapacitySearchStatus::Paused,
                    endpoints: Vec::new(),
                    trace: make_intrinsic_capacity_search_trace(
                        cold_beam_width,
                        local_legal_placement_fanout,
                        placement_evaluation_cap,
                        placement_evaluation_quota_per_depth,
                        consumed_placement_evaluations,
                        counters,
                        prepared_pieces.len() as f64,
                        IntrinsicCapacitySettlement::Paused,
                        topology_retention_depths.clone(),
                    ),
                    phase_timings: if capture {
                        Some(IntrinsicCapacitySearchPhaseTimings {
                            total_ms,
                            ..timings
                        })
                    } else {
                        None
                    },
                    checkpoint: Some(checkpoint_out),
                });
            }
        }
    }

    let materialization_started_at = if capture { timing_now() } else { 0.0 };
    let mut endpoints_by_hash: HashMap<String, IntrinsicCapacityEndpoint> = HashMap::new();
    for entry in &beam {
        let placed_id_set: HashSet<&PieceId> = entry.state.placement_order.iter().collect();
        let unplaced_prepared_ids: Vec<PieceId> = prepared_ids
            .iter()
            .filter(|id| !placed_id_set.contains(id))
            .cloned()
            .collect();
        let origin = if matches!(
            producer_role,
            IntrinsicAnytimeProducerRole::CapacityWarmPrefix
                | IntrinsicAnytimeProducerRole::CapacityQualityWarmPrefix
        ) {
            IntrinsicCapacityEndpointOrigin::WarmPrefixContinuation
        } else {
            IntrinsicCapacityEndpointOrigin::ColdSearch
        };
        let (source_role, prefix_depth) = match &warm_prefix_seed {
            Some(seed) => (Some(seed.source_role.clone()), Some(seed.depth)),
            None => (None, None),
        };
        let endpoint =
            materialize_intrinsic_capacity_endpoint(MaterializeIntrinsicCapacityEndpointInput {
                sheet,
                state: Arc::clone(&entry.state),
                unplaced_prepared_ids,
                origin,
                source_role,
                prefix_depth,
                material_areas_by_piece_id,
                cavity_cache,
            });
        let Some(endpoint) = endpoint else {
            endpoint_fit_rejections += 1.0;
            continue;
        };
        let existing = endpoints_by_hash.get(&endpoint.canonical_geometry_hash);
        let should_replace = match existing {
            None => true,
            Some(existing) => {
                compare_intrinsic_capacity_endpoints(&endpoint, existing) == Ordering::Less
            }
        };
        if should_replace {
            endpoints_by_hash.insert(endpoint.canonical_geometry_hash.clone(), endpoint);
        }
    }
    let mut endpoints: Vec<IntrinsicCapacityEndpoint> = endpoints_by_hash.into_values().collect();
    endpoints.sort_by(compare_intrinsic_capacity_endpoints);
    if capture {
        timings.endpoint_materialization_ms += timing_now() - materialization_started_at;
    }

    let total_ms = js_math::max(0.0, timing_now() - started_at);
    let counters = IntrinsicCapacitySearchCounters {
        pruned_by_attainable_count,
        pruned_by_attainable_material,
        deduplicated_successors,
        fit_rejected_candidates,
        invalid_candidates,
        endpoint_fit_rejections,
        completed_depths,
        depth_quota_exhaustions,
    };
    Ok(IntrinsicCapacitySearchResult {
        status: IntrinsicCapacitySearchStatus::Settled,
        endpoints,
        trace: make_intrinsic_capacity_search_trace(
            cold_beam_width,
            local_legal_placement_fanout,
            placement_evaluation_cap,
            placement_evaluation_quota_per_depth,
            consumed_placement_evaluations,
            counters,
            prepared_pieces.len() as f64,
            settlement,
            topology_retention_depths,
        ),
        phase_timings: if capture {
            Some(IntrinsicCapacitySearchPhaseTimings {
                total_ms,
                ..timings
            })
        } else {
            None
        },
        checkpoint: None,
    })
}

/// TS: `intrinsicCapacitySearch.ts:1010-1048`
/// `materializeIntrinsicCapacityCheckpointEndpoints`.
///
/// Materializes exact best-known endpoints from one paused protected lane.
/// Pending work is reported honestly as unplaced; the checkpoint itself
/// remains resumable and unchanged.
pub fn materialize_intrinsic_capacity_checkpoint_endpoints(
    sheet: &SheetSpec,
    prepared_pieces: &[Arc<IrregularPreparedPiece>],
    material_areas_by_piece_id: &HashMap<PieceId, BigInt>,
    cavity_cache: &mut IntrinsicCapacityCavityCache,
    checkpoint: &IntrinsicAnytimeCheckpoint,
    warm_prefix_seed: Option<&IntrinsicCapacityWarmPrefixSeed>,
) -> Vec<IntrinsicCapacityEndpoint> {
    let prepared_ids: Vec<PieceId> = prepared_pieces
        .iter()
        .map(|p| intrinsic_capacity_prepared_piece_id(p))
        .collect();
    let mut endpoints_by_hash: HashMap<String, IntrinsicCapacityEndpoint> = HashMap::new();
    for entry in &checkpoint.frontier {
        let placed_id_set: HashSet<&PieceId> = entry.state.placement_order.iter().collect();
        let unplaced_prepared_ids: Vec<PieceId> = prepared_ids
            .iter()
            .filter(|id| !placed_id_set.contains(id))
            .cloned()
            .collect();
        let origin = if matches!(
            checkpoint.producer_role,
            IntrinsicAnytimeProducerRole::CapacityWarmPrefix
                | IntrinsicAnytimeProducerRole::CapacityQualityWarmPrefix
        ) {
            IntrinsicCapacityEndpointOrigin::WarmPrefixContinuation
        } else {
            IntrinsicCapacityEndpointOrigin::ColdSearch
        };
        let (source_role, prefix_depth) = match warm_prefix_seed {
            Some(seed) => (Some(seed.source_role.clone()), Some(seed.depth)),
            None => (None, None),
        };
        let endpoint =
            materialize_intrinsic_capacity_endpoint(MaterializeIntrinsicCapacityEndpointInput {
                sheet,
                state: Arc::clone(&entry.state),
                unplaced_prepared_ids,
                origin,
                source_role,
                prefix_depth,
                material_areas_by_piece_id,
                cavity_cache,
            });
        let Some(endpoint) = endpoint else { continue };
        let existing = endpoints_by_hash.get(&endpoint.canonical_geometry_hash);
        let should_replace = match existing {
            None => true,
            Some(existing) => {
                compare_intrinsic_capacity_endpoints(&endpoint, existing) == Ordering::Less
            }
        };
        if should_replace {
            endpoints_by_hash.insert(endpoint.canonical_geometry_hash.clone(), endpoint);
        }
    }
    let mut endpoints: Vec<IntrinsicCapacityEndpoint> = endpoints_by_hash.into_values().collect();
    endpoints.sort_by(compare_intrinsic_capacity_endpoints);
    endpoints
}

// ===========================================================================
// Trace assembly.
// ===========================================================================

#[allow(clippy::too_many_arguments)]
fn make_intrinsic_capacity_search_trace(
    cold_beam_width: f64,
    local_legal_placement_fanout: f64,
    placement_evaluation_cap: f64,
    placement_evaluation_quota_per_depth: f64,
    consumed_placement_evaluations: f64,
    counters: IntrinsicCapacitySearchCounters,
    piece_count: f64,
    settlement: IntrinsicCapacitySettlement,
    topology_retention_depths: Vec<IntrinsicCapacityTopologyRetentionDepthTrace>,
) -> IntrinsicCapacitySearchTrace {
    IntrinsicCapacitySearchTrace {
        beam_width: cold_beam_width,
        local_legal_placement_fanout,
        placement_evaluation_cap,
        placement_evaluation_quota_per_depth,
        consumed_placement_evaluations,
        auxiliary_placement_evaluations: 0.0,
        pruned_by_attainable_count: counters.pruned_by_attainable_count,
        pruned_by_attainable_material: counters.pruned_by_attainable_material,
        deduplicated_successors: counters.deduplicated_successors,
        fit_rejected_candidates: counters.fit_rejected_candidates,
        invalid_candidates: counters.invalid_candidates,
        endpoint_fit_rejections: counters.endpoint_fit_rejections,
        completed_depths: counters.completed_depths,
        depth_quota_exhaustions: counters.depth_quota_exhaustions,
        piece_count,
        settlement,
        topology_retention_depths: if topology_retention_depths.is_empty() {
            None
        } else {
            Some(topology_retention_depths)
        },
    }
}

// ===========================================================================
// Warm-prefix-seed validation (`intrinsicCapacitySearch.ts:1084-1171`).
// ===========================================================================

struct ValidWarmPrefixEntry {
    depth: f64,
    beam_entry: CapacityBeamEntry,
}

enum WarmPrefixValidation {
    Valid { entry: Option<ValidWarmPrefixEntry> },
    Invalid { message: String },
}

#[allow(clippy::too_many_arguments)]
fn validate_warm_prefix_seed(
    seed: Option<&IntrinsicCapacityWarmPrefixSeed>,
    prepared_piece_count: usize,
    prepared_ids: &[PieceId],
    material_areas_by_piece_id: &HashMap<PieceId, BigInt>,
    cavity_cache: &mut IntrinsicCapacityCavityCache,
    sheet_width_grid: f64,
    sheet_height_grid: f64,
) -> WarmPrefixValidation {
    let Some(seed) = seed else {
        return WarmPrefixValidation::Valid { entry: None };
    };
    if seed.source_role.is_empty()
        || !is_safe_integer(seed.depth)
        || seed.depth <= 0.0
        || seed.depth >= prepared_piece_count as f64
    {
        return WarmPrefixValidation::Invalid {
            message: "warm prefix role or depth is invalid.".to_string(),
        };
    }
    let depth_usize = seed.depth as usize;
    let expected_placed_ids = &prepared_ids[..depth_usize];
    let expected_pending_ids = &prepared_ids[depth_usize..];
    let state_pending_ids: Vec<PieceId> = seed
        .state
        .remaining_prepared_pieces
        .iter()
        .map(|p| intrinsic_capacity_prepared_piece_id(p))
        .collect();
    if !seed.state.unplaced_piece_ids.is_empty()
        || seed.state.placement_order != expected_placed_ids
        || state_pending_ids != expected_pending_ids
    {
        return WarmPrefixValidation::Invalid {
            message: "warm prefix must be an exact skip-free prefix of the prepared order."
                .to_string(),
        };
    }
    let mut placed_doubled_material_area_grid2 = BigInt::from(0);
    for piece_id in expected_placed_ids {
        match material_areas_by_piece_id.get(piece_id) {
            None => {
                return WarmPrefixValidation::Invalid {
                    message: format!(
                        "warm prefix piece {} has no material area.",
                        piece_id.as_str()
                    ),
                }
            }
            Some(area) => placed_doubled_material_area_grid2 += area,
        }
    }
    let Some(grid_span) = intrinsic_capacity_state_grid_span(&seed.state) else {
        return WarmPrefixValidation::Invalid {
            message: "warm prefix has no exact occupied span.".to_string(),
        };
    };
    let fit_mask =
        intrinsic_capacity_span_fits_sheet(grid_span, sheet_width_grid, sheet_height_grid);
    if !fit_mask.0 && !fit_mask.1 {
        return WarmPrefixValidation::Invalid {
            message: "warm prefix does not fit the requested sheet.".to_string(),
        };
    }
    let Some(anchored_occupied_key) = seed
        .state
        .bottom_left_anchored_canonical_occupied_geometry_key()
    else {
        return WarmPrefixValidation::Invalid {
            message: "warm prefix has no anchored occupied identity.".to_string(),
        };
    };
    let Some(cavities) = measure_intrinsic_capacity_cavities(&seed.state, cavity_cache) else {
        return WarmPrefixValidation::Invalid {
            message: "warm prefix cavity measurement failed.".to_string(),
        };
    };
    WarmPrefixValidation::Valid {
        entry: Some(ValidWarmPrefixEntry {
            depth: seed.depth,
            beam_entry: make_capacity_beam_entry(
                Arc::clone(&seed.state),
                placed_doubled_material_area_grid2,
                anchored_occupied_key,
                grid_span,
                cavities,
                None,
            ),
        }),
    }
}

// ===========================================================================
// Checkpoint construction (`intrinsicCapacitySearch.ts:1173-1252`).
// ===========================================================================

#[allow(clippy::too_many_arguments)]
struct MakeCheckpointInput<'a> {
    request_fingerprint: String,
    incumbent_binding: Option<IntrinsicAnytimeIncumbentBinding>,
    beam: &'a [CapacityBeamEntry],
    prepared_ids: &'a [PieceId],
    next_depth: f64,
    placement_evaluation_cap: f64,
    consumed_placement_evaluations: f64,
    per_depth_budget_ledgers: &'a [IntrinsicAnytimeDepthBudgetLedger],
    no_skip_frontier: IntrinsicAnytimeNoSkipFrontierState,
    counters: IntrinsicCapacitySearchCounters,
    topology_retention_depths: &'a [IntrinsicCapacityTopologyRetentionDepthTrace],
    producer_role: IntrinsicAnytimeProducerRole,
    scheduler_deficit: f64,
    sheet_width_grid: f64,
    sheet_height_grid: f64,
}

fn make_intrinsic_capacity_checkpoint(
    input: MakeCheckpointInput<'_>,
) -> IntrinsicAnytimeCheckpoint {
    let pending_prepared_ids: Vec<PieceId> =
        input.prepared_ids[(input.next_depth as usize).min(input.prepared_ids.len())..].to_vec();
    let frontier: Vec<IntrinsicAnytimeDecisionState> = input
        .beam
        .iter()
        .map(|entry| {
            let permanently_skipped_prepared_ids = entry.state.unplaced_piece_ids.clone();
            let fit_mask = intrinsic_capacity_span_fits_sheet(
                entry.grid_span,
                input.sheet_width_grid,
                input.sheet_height_grid,
            );
            IntrinsicAnytimeDecisionState {
                state: Arc::clone(&entry.state),
                continuation_metadata_identity: entry.state.continuation_metadata_identity(),
                eligibility: if permanently_skipped_prepared_ids.is_empty() {
                    IntrinsicAnytimeEligibility::CompleteEligible
                } else {
                    IntrinsicAnytimeEligibility::SubsetOnly
                },
                placed_prepared_ids: entry.state.placement_order.clone(),
                pending_prepared_ids: pending_prepared_ids.clone(),
                deferred_prepared_ids: Vec::new(),
                permanently_skipped_prepared_ids,
                pending_order: pending_prepared_ids.clone(),
                cursor: input.next_depth,
                pass: 0.0,
                deferral_counts: Vec::new(),
                placed_doubled_material_area_grid2: entry
                    .placed_doubled_material_area_grid2
                    .clone(),
                cavities: entry.cavities.clone(),
                anchored_occupied_key: entry.anchored_occupied_key.clone(),
                grid_span: entry.grid_span,
                fit_mask: IntrinsicAnytimeFitMask {
                    q0: fit_mask.0,
                    q90: fit_mask.1,
                },
            }
        })
        .collect();
    let mut checkpoint = IntrinsicAnytimeCheckpoint {
        version: INTRINSIC_ANYTIME_CHECKPOINT_VERSION.to_string(),
        request_fingerprint: input.request_fingerprint,
        producer_role: input.producer_role,
        archive_cohort: IntrinsicAnytimeArchiveCohort::Partial,
        search_bounds: INTRINSIC_CAPACITY_V1_BOUNDS,
        incumbent_binding: input.incumbent_binding,
        frontier,
        next_depth: input.next_depth,
        depth_boundary_resume_position: input.next_depth,
        budget_ledgers: IntrinsicAnytimeBudgetLedgers {
            total_placement_evaluation_cap: input.placement_evaluation_cap,
            total_consumed_placement_evaluations: input.consumed_placement_evaluations,
            per_depth: input.per_depth_budget_ledgers.to_vec(),
            per_cohort: IntrinsicAnytimeBudgetPerCohort {
                complete: 0.0,
                partial: input.consumed_placement_evaluations,
                experimental_complete: 0.0,
            },
        },
        scheduler_deficit: input.scheduler_deficit,
        settlement: IntrinsicAnytimeCheckpointSettlement::Active,
        censoring: IntrinsicAnytimeCheckpointCensoring::None,
        no_skip_frontier: input.no_skip_frontier,
        counters: input.counters,
        topology_retention_depths: input.topology_retention_depths.to_vec(),
        integrity_hash: String::new(),
    };
    checkpoint.integrity_hash = intrinsic_capacity_checkpoint_integrity_hash(&checkpoint);
    checkpoint
}

// ===========================================================================
// Checkpoint validation (`intrinsicCapacitySearch.ts:1254-1501`).
// ===========================================================================

struct ValidateCheckpointInput<'a> {
    checkpoint: &'a IntrinsicAnytimeCheckpoint,
    request_fingerprint: &'a str,
    incumbent_binding: Option<&'a IntrinsicAnytimeIncumbentBinding>,
    producer_role: IntrinsicAnytimeProducerRole,
    scheduler_deficit: f64,
    prepared_ids: &'a [PieceId],
    material_areas_by_piece_id: &'a HashMap<PieceId, BigInt>,
    placement_evaluation_cap: f64,
    sheet_width_grid: f64,
    sheet_height_grid: f64,
}

fn validate_intrinsic_capacity_checkpoint(input: ValidateCheckpointInput<'_>) -> Option<String> {
    let checkpoint = input.checkpoint;
    if checkpoint.version != INTRINSIC_ANYTIME_CHECKPOINT_VERSION {
        return Some(format!(
            "unsupported checkpoint version {}.",
            checkpoint.version
        ));
    }
    let expected_integrity_hash = intrinsic_capacity_checkpoint_integrity_hash(checkpoint);
    if checkpoint.integrity_hash != expected_integrity_hash {
        return Some("checkpoint integrity hash does not match its retained frontier.".to_string());
    }
    if checkpoint.request_fingerprint != input.request_fingerprint {
        return Some(
            "checkpoint request/prepared-order fingerprint does not match the current request."
                .to_string(),
        );
    }
    if checkpoint.producer_role != input.producer_role
        || checkpoint.archive_cohort != IntrinsicAnytimeArchiveCohort::Partial
    {
        return Some(format!(
            "capacity search requires a {} partial-cohort checkpoint.",
            input.producer_role.as_str()
        ));
    }
    let bounds_encoded =
        intrinsic_capacity_canonical_json(&js_value_of_search_bounds(&checkpoint.search_bounds));
    let expected_bounds_encoded = intrinsic_capacity_canonical_json(&js_value_of_search_bounds(
        &INTRINSIC_CAPACITY_V1_BOUNDS,
    ));
    if bounds_encoded != expected_bounds_encoded {
        return Some(
            "checkpoint search bounds do not match the current capacity implementation."
                .to_string(),
        );
    }
    let checkpoint_incumbent_js = match &checkpoint.incumbent_binding {
        Some(binding) => js_value_of_incumbent_binding(binding),
        None => JsValue::Undefined,
    };
    let input_incumbent_js = match input.incumbent_binding {
        Some(binding) => js_value_of_incumbent_binding(binding),
        None => JsValue::Undefined,
    };
    if intrinsic_capacity_canonical_json(&checkpoint_incumbent_js)
        != intrinsic_capacity_canonical_json(&input_incumbent_js)
    {
        return Some(
            "checkpoint pruning incumbent does not match the current resume request.".to_string(),
        );
    }
    if !is_safe_integer(checkpoint.next_depth)
        || checkpoint.next_depth <= 0.0
        || checkpoint.next_depth >= input.prepared_ids.len() as f64
        || checkpoint.depth_boundary_resume_position != checkpoint.next_depth
    {
        return Some(
            "checkpoint is not positioned at a valid completed depth boundary.".to_string(),
        );
    }
    if checkpoint.frontier.is_empty() {
        return Some("checkpoint frontier must not be empty.".to_string());
    }
    if checkpoint.budget_ledgers.total_placement_evaluation_cap != input.placement_evaluation_cap
        || checkpoint
            .budget_ledgers
            .total_consumed_placement_evaluations
            < 0.0
        || checkpoint
            .budget_ledgers
            .total_consumed_placement_evaluations
            > checkpoint.budget_ledgers.total_placement_evaluation_cap
    {
        return Some(
            "checkpoint total budget ledger is invalid for the current request.".to_string(),
        );
    }
    let per_depth_bad =
        checkpoint
            .budget_ledgers
            .per_depth
            .iter()
            .enumerate()
            .any(|(index, ledger)| {
                ledger.depth != index as f64
                    || !is_safe_integer(ledger.consumed_placement_evaluations)
                    || ledger.consumed_placement_evaluations < 0.0
                    || ledger.consumed_placement_evaluations
                        > INTRINSIC_CAPACITY_V1_BOUNDS.placement_evaluation_quota_per_depth
                    || (ledger.quota_exhausted
                        && ledger.consumed_placement_evaluations
                            != INTRINSIC_CAPACITY_V1_BOUNDS.placement_evaluation_quota_per_depth)
            });
    if checkpoint.budget_ledgers.per_depth.len() as f64 != checkpoint.next_depth || per_depth_bad {
        return Some(
            "checkpoint per-depth budget ledger is not contiguous or exceeds its quota."
                .to_string(),
        );
    }
    let consumed_from_depths: f64 = checkpoint
        .budget_ledgers
        .per_depth
        .iter()
        .map(|ledger| ledger.consumed_placement_evaluations)
        .sum();
    if consumed_from_depths
        != checkpoint
            .budget_ledgers
            .total_consumed_placement_evaluations
        || checkpoint.budget_ledgers.per_cohort.partial != consumed_from_depths
        || checkpoint.budget_ledgers.per_cohort.complete != 0.0
        || checkpoint.budget_ledgers.per_cohort.experimental_complete != 0.0
    {
        return Some(
            "checkpoint total, per-depth, and per-cohort budget ledgers disagree.".to_string(),
        );
    }
    let depth_quota_exhaustions_expected = checkpoint
        .budget_ledgers
        .per_depth
        .iter()
        .filter(|ledger| ledger.quota_exhausted)
        .count() as f64;
    if !is_safe_integer(checkpoint.scheduler_deficit)
        || checkpoint.scheduler_deficit < 0.0
        || checkpoint.scheduler_deficit != input.scheduler_deficit
        || checkpoint.settlement != IntrinsicAnytimeCheckpointSettlement::Active
        || checkpoint.censoring != IntrinsicAnytimeCheckpointCensoring::None
        || checkpoint.counters.completed_depths != checkpoint.next_depth
        || checkpoint.counters.depth_quota_exhaustions != depth_quota_exhaustions_expected
        || !all_counters_non_negative_safe_integer(&checkpoint.counters)
    {
        return Some(
            "checkpoint scheduler or settlement state is invalid for a cold depth-boundary resume."
                .to_string(),
        );
    }
    let no_skip_bad = if checkpoint.no_skip_frontier.present {
        checkpoint.no_skip_frontier.first_loss_depth.is_some()
    } else {
        match checkpoint.no_skip_frontier.first_loss_depth {
            None => true,
            Some(first_loss_depth) => {
                !is_safe_integer(first_loss_depth)
                    || first_loss_depth < 1.0
                    || first_loss_depth > checkpoint.next_depth
            }
        }
    };
    if no_skip_bad {
        return Some(
            "checkpoint no-skip-frontier loss depth is invalid for its resume boundary."
                .to_string(),
        );
    }

    let expected_pending_ids: Vec<PieceId> =
        input.prepared_ids[(checkpoint.next_depth as usize)..].to_vec();
    let mut validation_cavity_cache: IntrinsicCapacityCavityCache = HashMap::new();
    let mut has_no_skip_state = false;
    for entry in &checkpoint.frontier {
        let state_placed_ids = entry.state.placement_order.clone();
        let state_pending_ids: Vec<PieceId> = entry
            .state
            .remaining_prepared_pieces
            .iter()
            .map(|p| intrinsic_capacity_prepared_piece_id(p))
            .collect();
        let state_skipped_ids = entry.state.unplaced_piece_ids.clone();

        if entry.continuation_metadata_identity != entry.state.continuation_metadata_identity() {
            return Some(
                "checkpoint continuation metadata identity does not match its beam state."
                    .to_string(),
            );
        }

        let recomputed_state = IrregularBeamState::from_input(IrregularBeamStateInput {
            remaining_prepared_pieces: entry.state.remaining_prepared_pieces.clone(),
            placed_collision_geometries: entry.state.placed_collision_geometries.clone(),
            unplaced_piece_ids: Some(entry.state.unplaced_piece_ids.clone()),
            unplaced_source_piece_ids: None,
            placement_order: entry.state.placement_order.clone(),
            parent: entry.state.parent.clone(),
            placed_collision_index: None,
        });
        if recomputed_state.canonical_entry_continuation_identity()
            != entry.state.canonical_entry_continuation_identity()
        {
            return Some("checkpoint canonical-entry cache is inconsistent.".to_string());
        }
        if recomputed_state
            .placed_collision_index
            .continuation_identity()
            != entry.state.placed_collision_index.continuation_identity()
            || !entry
                .state
                .placed_collision_index
                .matches(&entry.state.placed_collision_geometries)
        {
            return Some("checkpoint spatial-index cache is inconsistent.".to_string());
        }

        if entry.placed_prepared_ids != state_placed_ids
            || entry.pending_prepared_ids != expected_pending_ids
            || entry.pending_order != expected_pending_ids
            || state_pending_ids != expected_pending_ids
            || entry.permanently_skipped_prepared_ids != state_skipped_ids
            || !entry.deferred_prepared_ids.is_empty()
            || entry.cursor != checkpoint.next_depth
            || entry.pass != 0.0
            || !entry.deferral_counts.is_empty()
        {
            return Some(
                "checkpoint future-decision state does not match its beam geometry payload."
                    .to_string(),
            );
        }

        let mut partition: Vec<PieceId> = Vec::new();
        partition.extend(entry.placed_prepared_ids.iter().cloned());
        partition.extend(entry.pending_prepared_ids.iter().cloned());
        partition.extend(entry.deferred_prepared_ids.iter().cloned());
        partition.extend(entry.permanently_skipped_prepared_ids.iter().cloned());
        let unique: HashSet<&PieceId> = partition.iter().collect();
        let mut sorted_partition: Vec<&PieceId> = partition.iter().collect();
        sorted_partition.sort_by(|a, b| cmp_js_code_units(a.as_str(), b.as_str()));
        let mut sorted_prepared_ids: Vec<&PieceId> = input.prepared_ids.iter().collect();
        sorted_prepared_ids.sort_by(|a, b| cmp_js_code_units(a.as_str(), b.as_str()));
        if unique.len() != partition.len() || sorted_partition != sorted_prepared_ids {
            return Some(
                "checkpoint placed, pending, deferred, and skipped IDs are not a disjoint request partition."
                    .to_string(),
            );
        }

        let eligibility = if state_skipped_ids.is_empty() {
            IntrinsicAnytimeEligibility::CompleteEligible
        } else {
            IntrinsicAnytimeEligibility::SubsetOnly
        };
        if entry.eligibility != eligibility {
            return Some(
                "checkpoint complete eligibility disagrees with permanent-skip accounting."
                    .to_string(),
            );
        }
        has_no_skip_state =
            has_no_skip_state || eligibility == IntrinsicAnytimeEligibility::CompleteEligible;

        let mut expected_material: Option<BigInt> = Some(BigInt::from(0));
        for piece_id in &state_placed_ids {
            expected_material = match (
                expected_material,
                input.material_areas_by_piece_id.get(piece_id),
            ) {
                (Some(sum), Some(area)) => Some(sum + area),
                _ => None,
            };
        }
        if expected_material.as_ref() != Some(&entry.placed_doubled_material_area_grid2) {
            return Some("checkpoint placed-material accounting is invalid.".to_string());
        }

        let Some(grid_span) = intrinsic_capacity_state_grid_span(&entry.state) else {
            return Some(
                "checkpoint exact occupied span does not match its geometry payload.".to_string(),
            );
        };
        if grid_span.width_grid != entry.grid_span.width_grid
            || grid_span.height_grid != entry.grid_span.height_grid
        {
            return Some(
                "checkpoint exact occupied span does not match its geometry payload.".to_string(),
            );
        }

        let fit_mask = intrinsic_capacity_span_fits_sheet(
            grid_span,
            input.sheet_width_grid,
            input.sheet_height_grid,
        );
        if fit_mask.0 != entry.fit_mask.q0 || fit_mask.1 != entry.fit_mask.q90 {
            return Some(
                "checkpoint q0/q90 fit mask does not match its exact occupied span.".to_string(),
            );
        }

        let anchored_occupied_key = entry
            .state
            .bottom_left_anchored_canonical_occupied_geometry_key()
            .unwrap_or_else(|| entry.state.canonical_occupied_geometry_key.clone());
        if anchored_occupied_key != entry.anchored_occupied_key {
            return Some(
                "checkpoint anchored occupied identity does not match its geometry payload."
                    .to_string(),
            );
        }

        let Some(cavities) =
            measure_intrinsic_capacity_cavities(&entry.state, &mut validation_cavity_cache)
        else {
            return Some(
                "checkpoint cavity objective does not match its exact geometry payload."
                    .to_string(),
            );
        };
        if cavities.count != entry.cavities.count
            || cavities.total_area_mm2 != entry.cavities.total_area_mm2
        {
            return Some(
                "checkpoint cavity objective does not match its exact geometry payload."
                    .to_string(),
            );
        }
    }
    if checkpoint.no_skip_frontier.present != has_no_skip_state
        || (has_no_skip_state && checkpoint.no_skip_frontier.first_loss_depth.is_some())
    {
        return Some(
            "checkpoint no-skip-frontier state disagrees with the retained frontier.".to_string(),
        );
    }
    None
}

fn all_counters_non_negative_safe_integer(counters: &IntrinsicCapacitySearchCounters) -> bool {
    let values = [
        counters.pruned_by_attainable_count,
        counters.pruned_by_attainable_material,
        counters.deduplicated_successors,
        counters.fit_rejected_candidates,
        counters.invalid_candidates,
        counters.endpoint_fit_rejections,
        counters.completed_depths,
        counters.depth_quota_exhaustions,
    ];
    values
        .iter()
        .all(|value| is_safe_integer(*value) && *value >= 0.0)
}

// ===========================================================================
// Checkpoint integrity hash and request fingerprint
// (`intrinsicCapacitySearch.ts:1503-1624`; Encoder A:
// `checkpoints::canonical_json::intrinsic_capacity_canonical_json`).
// ===========================================================================

fn intrinsic_capacity_checkpoint_integrity_hash(checkpoint: &IntrinsicAnytimeCheckpoint) -> String {
    let preimage = js_value_of_checkpoint_for_integrity_hash(checkpoint);
    let encoded = intrinsic_capacity_canonical_json(&preimage)
        .expect("checkpoint integrity hash preimage is never top-level undefined");
    sha256_hex(&encoded)
}

fn js_value_of_checkpoint_for_integrity_hash(checkpoint: &IntrinsicAnytimeCheckpoint) -> JsValue {
    JsValue::Obj(vec![
        (
            "version".to_string(),
            JsValue::Str(checkpoint.version.clone()),
        ),
        (
            "requestFingerprint".to_string(),
            JsValue::Str(checkpoint.request_fingerprint.clone()),
        ),
        (
            "producerRole".to_string(),
            JsValue::Str(checkpoint.producer_role.as_str().to_string()),
        ),
        (
            "archiveCohort".to_string(),
            JsValue::Str(checkpoint.archive_cohort.as_str().to_string()),
        ),
        (
            "searchBounds".to_string(),
            js_value_of_search_bounds(&checkpoint.search_bounds),
        ),
        (
            "incumbentBinding".to_string(),
            match &checkpoint.incumbent_binding {
                Some(binding) => js_value_of_incumbent_binding(binding),
                None => JsValue::Undefined,
            },
        ),
        (
            "frontier".to_string(),
            JsValue::Arr(
                checkpoint
                    .frontier
                    .iter()
                    .map(js_value_of_frontier_entry_for_integrity_hash)
                    .collect(),
            ),
        ),
        ("nextDepth".to_string(), JsValue::Num(checkpoint.next_depth)),
        (
            "depthBoundaryResumePosition".to_string(),
            JsValue::Num(checkpoint.depth_boundary_resume_position),
        ),
        (
            "budgetLedgers".to_string(),
            js_value_of_budget_ledgers(&checkpoint.budget_ledgers),
        ),
        (
            "schedulerDeficit".to_string(),
            JsValue::Num(checkpoint.scheduler_deficit),
        ),
        ("settlement".to_string(), JsValue::Str("active".to_string())),
        ("censoring".to_string(), JsValue::Str("none".to_string())),
        (
            "noSkipFrontier".to_string(),
            js_value_of_no_skip_frontier(&checkpoint.no_skip_frontier),
        ),
        (
            "counters".to_string(),
            js_value_of_counters(&checkpoint.counters),
        ),
        (
            "topologyRetentionDepths".to_string(),
            JsValue::Arr(
                checkpoint
                    .topology_retention_depths
                    .iter()
                    .map(js_value_of_topology_retention_depth_trace)
                    .collect(),
            ),
        ),
    ])
}

fn js_value_of_frontier_entry_for_integrity_hash(entry: &IntrinsicAnytimeDecisionState) -> JsValue {
    let state = &entry.state;
    let pending_ids: Vec<JsValue> = state
        .remaining_prepared_pieces
        .iter()
        .map(|p| JsValue::Str(intrinsic_capacity_prepared_piece_id(p).as_str().to_string()))
        .collect();
    let placed_ids: Vec<JsValue> = state
        .placed_collision_geometries
        .iter()
        .map(|p| {
            let id = p
                .placement
                .piece_id
                .clone()
                .unwrap_or_else(|| p.placement.source_piece_id.clone());
            JsValue::Str(id.as_str().to_string())
        })
        .collect();
    let state_obj = JsValue::Obj(vec![
        ("pendingIds".to_string(), JsValue::Arr(pending_ids)),
        ("placedIds".to_string(), JsValue::Arr(placed_ids)),
        (
            "unplacedIds".to_string(),
            js_value_of_piece_ids(&state.unplaced_piece_ids),
        ),
        (
            "placementOrder".to_string(),
            js_value_of_piece_ids(&state.placement_order),
        ),
        (
            "canonicalOccupiedGeometryKey".to_string(),
            JsValue::Str(state.canonical_occupied_geometry_key.clone()),
        ),
        (
            "translatedCollisionBounds".to_string(),
            match state.translated_collision_bounds {
                Some(bounds) => js_value_of_collision_bounds(bounds),
                None => JsValue::Undefined,
            },
        ),
        (
            "sharedCollisionBoundaryLengthMm".to_string(),
            option_num(state.shared_collision_boundary_length_mm),
        ),
        (
            "sharedCollisionBoundaryContactUnits".to_string(),
            option_num(state.shared_collision_boundary_contact_units),
        ),
        (
            "nearCompleteStructuralContactCount".to_string(),
            option_num(state.near_complete_structural_contact_count),
        ),
        (
            "dominantNearCompleteStructuralContactCount".to_string(),
            option_num(state.dominant_near_complete_structural_contact_count),
        ),
        (
            "continuationMetadataIdentity".to_string(),
            JsValue::Str(state.continuation_metadata_identity()),
        ),
    ]);
    JsValue::Obj(vec![
        ("state".to_string(), state_obj),
        (
            "continuationMetadataIdentity".to_string(),
            JsValue::Str(entry.continuation_metadata_identity.clone()),
        ),
        (
            "eligibility".to_string(),
            JsValue::Str(entry.eligibility.as_str().to_string()),
        ),
        (
            "placedPreparedIds".to_string(),
            js_value_of_piece_ids(&entry.placed_prepared_ids),
        ),
        (
            "pendingPreparedIds".to_string(),
            js_value_of_piece_ids(&entry.pending_prepared_ids),
        ),
        (
            "deferredPreparedIds".to_string(),
            js_value_of_piece_ids(&entry.deferred_prepared_ids),
        ),
        (
            "permanentlySkippedPreparedIds".to_string(),
            js_value_of_piece_ids(&entry.permanently_skipped_prepared_ids),
        ),
        (
            "pendingOrder".to_string(),
            js_value_of_piece_ids(&entry.pending_order),
        ),
        ("cursor".to_string(), JsValue::Num(entry.cursor)),
        ("pass".to_string(), JsValue::Num(entry.pass)),
        (
            "deferralCounts".to_string(),
            JsValue::Obj(
                entry
                    .deferral_counts
                    .iter()
                    .map(|(key, value)| (key.clone(), JsValue::Num(*value)))
                    .collect(),
            ),
        ),
        (
            "placedDoubledMaterialAreaGrid2".to_string(),
            JsValue::BigInt(entry.placed_doubled_material_area_grid2.clone()),
        ),
        (
            "cavities".to_string(),
            js_value_of_cavities(&entry.cavities),
        ),
        (
            "anchoredOccupiedKey".to_string(),
            JsValue::Str(entry.anchored_occupied_key.clone()),
        ),
        (
            "gridSpan".to_string(),
            js_value_of_grid_span(entry.grid_span),
        ),
        ("fitMask".to_string(), js_value_of_fit_mask(entry.fit_mask)),
    ])
}

fn intrinsic_capacity_request_fingerprint(
    sheet: &SheetSpec,
    prepared_pieces: &[Arc<IrregularPreparedPiece>],
    material_areas_by_piece_id: &HashMap<PieceId, BigInt>,
    incumbent: Option<&IntrinsicCapacityEndpoint>,
    warm_prefix_seed: Option<&IntrinsicCapacityWarmPrefixSeed>,
    scheduler_deficit: Option<f64>,
    retention_mode: Option<IntrinsicCapacityRetentionMode>,
) -> String {
    let mut material_entries: Vec<(String, &BigInt)> = material_areas_by_piece_id
        .iter()
        .map(|(id, area)| (id.as_str().to_string(), area))
        .collect();
    material_entries.sort_by(|(a, _), (b, _)| cmp_js_code_units(a, b));
    let material_js = JsValue::Arr(
        material_entries
            .into_iter()
            .map(|(id, area)| JsValue::Arr(vec![JsValue::Str(id), JsValue::BigInt(area.clone())]))
            .collect(),
    );

    let sheet_json =
        serde_json::to_value(sheet).expect("sheet always serializes for the request fingerprint");
    // `Arc<IrregularPreparedPiece>` has no `Serialize` impl in this crate's
    // configuration (no `serde`-`rc` feature); deref to plain `&IrregularPreparedPiece`
    // references first, which serialize identically to owned values.
    let prepared_pieces_refs: Vec<&IrregularPreparedPiece> =
        prepared_pieces.iter().map(|piece| piece.as_ref()).collect();
    let prepared_pieces_json = serde_json::to_value(&prepared_pieces_refs)
        .expect("prepared pieces always serialize for the request fingerprint");

    let incumbent_binding = intrinsic_capacity_incumbent_binding(incumbent);
    let warm_prefix_js = match warm_prefix_seed {
        None => JsValue::Undefined,
        Some(seed) => {
            let placed_prepared_ids = js_value_of_piece_ids(&seed.state.placement_order);
            let pending_prepared_ids = JsValue::Arr(
                seed.state
                    .remaining_prepared_pieces
                    .iter()
                    .map(|p| {
                        JsValue::Str(intrinsic_capacity_prepared_piece_id(p).as_str().to_string())
                    })
                    .collect(),
            );
            let anchored_occupied_key = match seed
                .state
                .bottom_left_anchored_canonical_occupied_geometry_key()
            {
                Some(key) => JsValue::Str(key),
                None => JsValue::Undefined,
            };
            JsValue::Obj(vec![
                (
                    "sourceRole".to_string(),
                    JsValue::Str(seed.source_role.clone()),
                ),
                ("depth".to_string(), JsValue::Num(seed.depth)),
                ("placedPreparedIds".to_string(), placed_prepared_ids),
                ("pendingPreparedIds".to_string(), pending_prepared_ids),
                ("anchoredOccupiedKey".to_string(), anchored_occupied_key),
            ])
        }
    };

    let preimage = JsValue::Obj(vec![
        (
            "version".to_string(),
            JsValue::Str(INTRINSIC_ANYTIME_CHECKPOINT_VERSION.to_string()),
        ),
        (
            "searchBounds".to_string(),
            js_value_of_search_bounds(&INTRINSIC_CAPACITY_V1_BOUNDS),
        ),
        ("sheet".to_string(), json_value_to_js_value(&sheet_json)),
        (
            "preparedPieces".to_string(),
            json_value_to_js_value(&prepared_pieces_json),
        ),
        ("material".to_string(), material_js),
        (
            "incumbent".to_string(),
            match &incumbent_binding {
                Some(binding) => js_value_of_incumbent_binding(binding),
                None => JsValue::Undefined,
            },
        ),
        (
            "schedulerDeficit".to_string(),
            JsValue::Num(scheduler_deficit.unwrap_or(0.0)),
        ),
        (
            "retentionMode".to_string(),
            JsValue::Str(
                retention_mode
                    .unwrap_or(IntrinsicCapacityRetentionMode::Objective)
                    .as_str()
                    .to_string(),
            ),
        ),
        ("warmPrefix".to_string(), warm_prefix_js),
    ]);
    let encoded = intrinsic_capacity_canonical_json(&preimage)
        .expect("request fingerprint preimage is never top-level undefined");
    sha256_hex(&encoded)
}

fn intrinsic_capacity_incumbent_binding(
    incumbent: Option<&IntrinsicCapacityEndpoint>,
) -> Option<IntrinsicAnytimeIncumbentBinding> {
    incumbent.map(|endpoint| IntrinsicAnytimeIncumbentBinding {
        canonical_geometry_hash: endpoint.canonical_geometry_hash.clone(),
        placed_count: endpoint.metrics.placed_count,
        placed_doubled_material_area_grid2: endpoint
            .metrics
            .placed_doubled_material_area_grid2
            .clone(),
        origin: endpoint.origin,
        selected_rotation_deg: endpoint.selected_rotation_deg,
    })
}

// ---------------------------------------------------------------------------
// `JsValue` builders for the small value types this cluster serializes into
// the two SHA-256 hash preimages above. See this module's top doc for why
// `serde_json` reuse (via `json_value_to_js_value`) covers the two
// whole-domain-class fields (`sheet`, `preparedPieces`) instead.
// ---------------------------------------------------------------------------

fn option_num(value: Option<f64>) -> JsValue {
    match value {
        Some(v) => JsValue::Num(v),
        None => JsValue::Undefined,
    }
}

fn js_value_of_piece_ids(ids: &[PieceId]) -> JsValue {
    JsValue::Arr(
        ids.iter()
            .map(|id| JsValue::Str(id.as_str().to_string()))
            .collect(),
    )
}

fn js_value_of_collision_bounds(bounds: IrregularCollisionBounds) -> JsValue {
    JsValue::Obj(vec![
        ("minX".to_string(), JsValue::Num(bounds.min_x)),
        ("minY".to_string(), JsValue::Num(bounds.min_y)),
        ("maxX".to_string(), JsValue::Num(bounds.max_x)),
        ("maxY".to_string(), JsValue::Num(bounds.max_y)),
        ("width".to_string(), JsValue::Num(bounds.width)),
        ("height".to_string(), JsValue::Num(bounds.height)),
    ])
}

fn js_value_of_cavities(cavities: &IntrinsicCapacityCavityMetrics) -> JsValue {
    JsValue::Obj(vec![
        ("count".to_string(), JsValue::Num(cavities.count)),
        (
            "totalAreaMm2".to_string(),
            JsValue::Num(cavities.total_area_mm2),
        ),
        (
            "totalDoubledAreaGrid2".to_string(),
            JsValue::Str(cavities.total_doubled_area_grid2.clone()),
        ),
    ])
}

fn js_value_of_grid_span(span: IntrinsicCapacityGridSpan) -> JsValue {
    JsValue::Obj(vec![
        ("widthGrid".to_string(), JsValue::Num(span.width_grid)),
        ("heightGrid".to_string(), JsValue::Num(span.height_grid)),
    ])
}

fn js_value_of_fit_mask(mask: IntrinsicAnytimeFitMask) -> JsValue {
    JsValue::Obj(vec![
        ("q0".to_string(), JsValue::Bool(mask.q0)),
        ("q90".to_string(), JsValue::Bool(mask.q90)),
    ])
}

fn js_value_of_search_bounds(bounds: &IntrinsicCapacityV1Bounds) -> JsValue {
    JsValue::Obj(vec![
        (
            "coldBeamWidth".to_string(),
            JsValue::Num(bounds.cold_beam_width),
        ),
        (
            "localLegalPlacementFanout".to_string(),
            JsValue::Num(bounds.local_legal_placement_fanout),
        ),
        (
            "minimumPlacementEvaluationCap".to_string(),
            JsValue::Num(bounds.minimum_placement_evaluation_cap),
        ),
        (
            "placementEvaluationQuotaPerDepth".to_string(),
            JsValue::Num(bounds.placement_evaluation_quota_per_depth),
        ),
    ])
}

fn js_value_of_depth_budget_ledger(ledger: &IntrinsicAnytimeDepthBudgetLedger) -> JsValue {
    JsValue::Obj(vec![
        ("depth".to_string(), JsValue::Num(ledger.depth)),
        (
            "consumedPlacementEvaluations".to_string(),
            JsValue::Num(ledger.consumed_placement_evaluations),
        ),
        (
            "quotaExhausted".to_string(),
            JsValue::Bool(ledger.quota_exhausted),
        ),
    ])
}

fn js_value_of_budget_ledgers(ledgers: &IntrinsicAnytimeBudgetLedgers) -> JsValue {
    JsValue::Obj(vec![
        (
            "totalPlacementEvaluationCap".to_string(),
            JsValue::Num(ledgers.total_placement_evaluation_cap),
        ),
        (
            "totalConsumedPlacementEvaluations".to_string(),
            JsValue::Num(ledgers.total_consumed_placement_evaluations),
        ),
        (
            "perDepth".to_string(),
            JsValue::Arr(
                ledgers
                    .per_depth
                    .iter()
                    .map(js_value_of_depth_budget_ledger)
                    .collect(),
            ),
        ),
        (
            "perCohort".to_string(),
            JsValue::Obj(vec![
                (
                    "complete".to_string(),
                    JsValue::Num(ledgers.per_cohort.complete),
                ),
                (
                    "partial".to_string(),
                    JsValue::Num(ledgers.per_cohort.partial),
                ),
                (
                    "experimentalComplete".to_string(),
                    JsValue::Num(ledgers.per_cohort.experimental_complete),
                ),
            ]),
        ),
    ])
}

fn js_value_of_no_skip_frontier(frontier: &IntrinsicAnytimeNoSkipFrontierState) -> JsValue {
    JsValue::Obj(vec![
        ("present".to_string(), JsValue::Bool(frontier.present)),
        (
            "firstLossDepth".to_string(),
            option_num(frontier.first_loss_depth),
        ),
    ])
}

fn js_value_of_counters(counters: &IntrinsicCapacitySearchCounters) -> JsValue {
    JsValue::Obj(vec![
        (
            "prunedByAttainableCount".to_string(),
            JsValue::Num(counters.pruned_by_attainable_count),
        ),
        (
            "prunedByAttainableMaterial".to_string(),
            JsValue::Num(counters.pruned_by_attainable_material),
        ),
        (
            "deduplicatedSuccessors".to_string(),
            JsValue::Num(counters.deduplicated_successors),
        ),
        (
            "fitRejectedCandidates".to_string(),
            JsValue::Num(counters.fit_rejected_candidates),
        ),
        (
            "invalidCandidates".to_string(),
            JsValue::Num(counters.invalid_candidates),
        ),
        (
            "endpointFitRejections".to_string(),
            JsValue::Num(counters.endpoint_fit_rejections),
        ),
        (
            "completedDepths".to_string(),
            JsValue::Num(counters.completed_depths),
        ),
        (
            "depthQuotaExhaustions".to_string(),
            JsValue::Num(counters.depth_quota_exhaustions),
        ),
    ])
}

fn js_value_of_incumbent_binding(binding: &IntrinsicAnytimeIncumbentBinding) -> JsValue {
    JsValue::Obj(vec![
        (
            "canonicalGeometryHash".to_string(),
            JsValue::Str(binding.canonical_geometry_hash.clone()),
        ),
        (
            "placedCount".to_string(),
            JsValue::Num(binding.placed_count),
        ),
        (
            "placedDoubledMaterialAreaGrid2".to_string(),
            JsValue::BigInt(binding.placed_doubled_material_area_grid2.clone()),
        ),
        (
            "origin".to_string(),
            JsValue::Str(intrinsic_capacity_endpoint_origin_str(binding.origin).to_string()),
        ),
        (
            "selectedRotationDeg".to_string(),
            JsValue::Num(binding.selected_rotation_deg),
        ),
    ])
}

fn intrinsic_capacity_endpoint_origin_str(origin: IntrinsicCapacityEndpointOrigin) -> &'static str {
    match origin {
        IntrinsicCapacityEndpointOrigin::ColdSearch => "cold-search",
        IntrinsicCapacityEndpointOrigin::PrefixIncumbent => "prefix-incumbent",
        IntrinsicCapacityEndpointOrigin::WarmPrefixContinuation => "warm-prefix-continuation",
    }
}

fn js_value_of_canonical_layout_topology(topology: &CanonicalLayoutTopology) -> JsValue {
    JsValue::Obj(vec![
        (
            "enclosedCavityCount".to_string(),
            JsValue::Num(topology.enclosed_cavity_count),
        ),
        (
            "largestOccupiedHullGapRatio".to_string(),
            JsValue::Num(topology.largest_occupied_hull_gap_ratio),
        ),
        (
            "occupiedEnvelopeAspectRatio".to_string(),
            JsValue::Num(topology.occupied_envelope_aspect_ratio),
        ),
        (
            "positiveContactComponentCount".to_string(),
            JsValue::Num(topology.positive_contact_component_count),
        ),
        (
            "isolatedPieceCount".to_string(),
            JsValue::Num(topology.isolated_piece_count),
        ),
        (
            "largestPositiveContactComponentSize".to_string(),
            JsValue::Num(topology.largest_positive_contact_component_size),
        ),
        (
            "largestPositiveContactComponentRatio".to_string(),
            JsValue::Num(topology.largest_positive_contact_component_ratio),
        ),
    ])
}

fn js_value_of_canonical_layout_topology_exact(exact: &CanonicalLayoutTopologyExact) -> JsValue {
    JsValue::Obj(vec![
        (
            "topology".to_string(),
            js_value_of_canonical_layout_topology(&exact.topology),
        ),
        (
            "hullGapDoubledAreaGrid2".to_string(),
            JsValue::Num(exact.hull_gap_doubled_area_grid2),
        ),
        (
            "hullDoubledAreaGrid2".to_string(),
            JsValue::Num(exact.hull_doubled_area_grid2),
        ),
        (
            "exactHullGapDoubledAreaGrid2".to_string(),
            JsValue::Str(exact.exact_hull_gap_doubled_area_grid2.clone()),
        ),
        (
            "exactHullDoubledAreaGrid2".to_string(),
            JsValue::Str(exact.exact_hull_doubled_area_grid2.clone()),
        ),
    ])
}

fn js_value_of_representative(rep: &IntrinsicCapacityTopologyRepresentative) -> JsValue {
    JsValue::Obj(vec![
        (
            "role".to_string(),
            JsValue::Str(rep.role.as_str().to_string()),
        ),
        (
            "decisionIdentity".to_string(),
            JsValue::Str(rep.decision_identity.clone()),
        ),
        (
            "parentDecisionIdentity".to_string(),
            JsValue::Str(rep.parent_decision_identity.clone()),
        ),
        (
            "decision".to_string(),
            JsValue::Str(rep.decision.as_str().to_string()),
        ),
        (
            "proposalRole".to_string(),
            JsValue::Str(rep.proposal_role.as_str().to_string()),
        ),
        (
            "pieceId".to_string(),
            JsValue::Str(rep.piece_id.as_str().to_string()),
        ),
        (
            "anchoredOccupiedKey".to_string(),
            JsValue::Str(rep.anchored_occupied_key.clone()),
        ),
        ("placedCount".to_string(), JsValue::Num(rep.placed_count)),
        (
            "placedDoubledMaterialAreaGrid2".to_string(),
            JsValue::BigInt(rep.placed_doubled_material_area_grid2.clone()),
        ),
        ("cavities".to_string(), js_value_of_cavities(&rep.cavities)),
        ("gridSpan".to_string(), js_value_of_grid_span(rep.grid_span)),
        (
            "topology".to_string(),
            match &rep.topology {
                Some(topology) => js_value_of_canonical_layout_topology_exact(topology),
                None => JsValue::Undefined,
            },
        ),
        ("retained".to_string(), JsValue::Bool(rep.retained)),
    ])
}

fn js_value_of_topology_retention_depth_trace(
    trace: &IntrinsicCapacityTopologyRetentionDepthTrace,
) -> JsValue {
    JsValue::Obj(vec![
        ("depth".to_string(), JsValue::Num(trace.depth)),
        (
            "pieceId".to_string(),
            JsValue::Str(trace.piece_id.as_str().to_string()),
        ),
        (
            "measuredSurvivorCount".to_string(),
            JsValue::Num(trace.measured_survivor_count),
        ),
        (
            "retainedCount".to_string(),
            JsValue::Num(trace.retained_count),
        ),
        (
            "bestAccountingStratumCount".to_string(),
            JsValue::Num(trace.best_accounting_stratum_count),
        ),
        (
            "topologyMeasurementCount".to_string(),
            JsValue::Num(trace.topology_measurement_count),
        ),
        (
            "topologyMeasurementMs".to_string(),
            JsValue::Num(trace.topology_measurement_ms),
        ),
        (
            "legalCandidateCount".to_string(),
            JsValue::Num(trace.legal_candidate_count),
        ),
        (
            "contactMeasuredCandidateCount".to_string(),
            JsValue::Num(trace.contact_measured_candidate_count),
        ),
        (
            "positiveContactCandidateCount".to_string(),
            JsValue::Num(trace.positive_contact_candidate_count),
        ),
        (
            "contactMeasurementMs".to_string(),
            JsValue::Num(trace.contact_measurement_ms),
        ),
        (
            "contactSelectedSuccessorCount".to_string(),
            JsValue::Num(trace.contact_selected_successor_count),
        ),
        (
            "contactDeduplicatedSuccessorCount".to_string(),
            JsValue::Num(trace.contact_deduplicated_successor_count),
        ),
        (
            "contactRetainedSuccessorCount".to_string(),
            JsValue::Num(trace.contact_retained_successor_count),
        ),
        (
            "representatives".to_string(),
            JsValue::Arr(
                trace
                    .representatives
                    .iter()
                    .map(js_value_of_representative)
                    .collect(),
            ),
        ),
    ])
}

/// See this module's top doc, "`serde_json` reuse for the request-
/// fingerprint's whole-domain-class fields".
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

// ===========================================================================
// Successor construction helpers (`intrinsicCapacitySearch.ts:1648-1729`).
// ===========================================================================

fn push_successor(
    successors: &mut Vec<CapacityBeamEntry>,
    successor_keys: &mut HashSet<String>,
    successor: CapacityBeamEntry,
    mut on_duplicate: impl FnMut(),
) -> bool {
    let key = intrinsic_capacity_successor_identity(&successor);
    if successor_keys.contains(&key) {
        on_duplicate();
        return false;
    }
    successor_keys.insert(key);
    successors.push(successor);
    true
}

/// TS: `intrinsicCapacitySearch.ts:1664-1669` `intrinsicCapacitySuccessorIdentity`.
/// Future-equivalent identity at one synchronized prepared-piece depth.
/// Derived once per entry at construction (`make_capacity_beam_entry`) and
/// cached in `CapacityBeamEntry::successor_identity`; the derivation is
/// byte-identical to the previous per-call computation.
fn derive_intrinsic_capacity_successor_identity(
    state: &Arc<IrregularBeamState>,
    anchored_occupied_key: &str,
) -> String {
    let mut sorted_ids: Vec<&PieceId> = state.placement_order.iter().collect();
    sorted_ids.sort_by(|a, b| cmp_js_code_units(a.as_str(), b.as_str()));
    let json_array = intrinsic_capacity_canonical_json(&JsValue::Arr(
        sorted_ids
            .into_iter()
            .map(|id| JsValue::Str(id.as_str().to_string()))
            .collect(),
    ))
    .expect("a string array never encodes to top-level undefined");
    format!("{anchored_occupied_key}|placed={json_array}")
}

fn intrinsic_capacity_successor_identity(successor: &CapacityBeamEntry) -> String {
    successor.successor_identity.clone()
}

/// TS: `intrinsicCapacitySearch.ts:1682-1729` `evaluateCandidate`. Cheap
/// exact candidate evaluation from incrementally derived occupied bounds. No
/// placement object, beam state, spatial index, contact measurement, or
/// anchored rebuild is constructed for candidates that are not selected.
fn evaluate_candidate(
    entry: &CapacityBeamEntry,
    moving: &TransformedCollisionGeometry,
    candidate: &IrregularPlacementCandidate,
    transform_ordinal: f64,
) -> Option<EvaluatedCandidateReference> {
    let parent_bounds = entry.state.translated_collision_bounds?;
    let moving_min_x = moving.bounds.min_x + candidate.point.x;
    let moving_min_y = moving.bounds.min_y + candidate.point.y;
    let moving_max_x = moving.bounds.max_x + candidate.point.x;
    let moving_max_y = moving.bounds.max_y + candidate.point.y;
    let is_first_placement = entry.state.placed_collision_geometries.is_empty();
    let (min_x, min_y, max_x, max_y) = if is_first_placement {
        (moving_min_x, moving_min_y, moving_max_x, moving_max_y)
    } else {
        (
            js_math::min(parent_bounds.min_x, moving_min_x),
            js_math::min(parent_bounds.min_y, moving_min_y),
            js_math::max(parent_bounds.max_x, moving_max_x),
            js_math::max(parent_bounds.max_y, moving_max_y),
        )
    };
    let min_x_grid = to_grid_mm(min_x)?;
    let min_y_grid = to_grid_mm(min_y)?;
    let max_x_grid = to_grid_mm(max_x)?;
    let max_y_grid = to_grid_mm(max_y)?;
    let grid_x = to_grid_mm(candidate.point.x)?;
    let grid_y = to_grid_mm(candidate.point.y)?;
    let width_grid = max_x_grid - min_x_grid;
    let height_grid = max_y_grid - min_y_grid;
    Some(EvaluatedCandidateReference {
        moving: moving.clone(),
        candidate: candidate.clone(),
        maximum_side_grid: js_math::max(width_grid, height_grid),
        envelope_area_grid2: f64_to_bigint(width_grid) * f64_to_bigint(height_grid),
        envelope_span_grid: width_grid + height_grid,
        transform_ordinal,
        grid_x,
        grid_y,
        width_grid,
        height_grid,
        shared_boundary_length_mm: None,
    })
}

/// TS: `intrinsicCapacitySearch.ts:1731-1743` `compareScoredCandidateReferences`.
fn compare_scored_candidate_references(
    first: &EvaluatedCandidateReference,
    second: &EvaluatedCandidateReference,
) -> Ordering {
    first
        .maximum_side_grid
        .partial_cmp(&second.maximum_side_grid)
        .unwrap()
        .then_with(|| first.envelope_area_grid2.cmp(&second.envelope_area_grid2))
        .then_with(|| {
            first
                .envelope_span_grid
                .partial_cmp(&second.envelope_span_grid)
                .unwrap()
        })
        .then_with(|| {
            first
                .transform_ordinal
                .partial_cmp(&second.transform_ordinal)
                .unwrap()
        })
        .then_with(|| first.grid_x.partial_cmp(&second.grid_x).unwrap())
        .then_with(|| first.grid_y.partial_cmp(&second.grid_y).unwrap())
}

/// TS: `intrinsicCapacitySearch.ts:1745-1754` `compareContactCandidateReferences`.
fn compare_contact_candidate_references(
    first: &EvaluatedCandidateReference,
    second: &EvaluatedCandidateReference,
) -> Ordering {
    let first_len = first.shared_boundary_length_mm.unwrap_or(0.0);
    let second_len = second.shared_boundary_length_mm.unwrap_or(0.0);
    second_len
        .partial_cmp(&first_len)
        .unwrap()
        .then_with(|| compare_scored_candidate_references(first, second))
}

/// TS: `intrinsicCapacitySearch.ts:1756-1760` `capacityCandidateReferenceIdentity`.
fn capacity_candidate_reference_identity(reference: &EvaluatedCandidateReference) -> String {
    format!(
        "{}:{}:{}",
        number_to_js_string(reference.candidate.transform.index),
        number_to_js_string(reference.grid_x),
        number_to_js_string(reference.grid_y),
    )
}

// ===========================================================================
// Retention comparators and algorithms (`intrinsicCapacitySearch.ts:1762-2231`).
// ===========================================================================

fn parse_bigint(value: &str) -> BigInt {
    value
        .parse()
        .expect("decimal doubled-area strings are always valid bigint literals")
}

fn compare_bigint_decimal_strings(first: &str, second: &str) -> Ordering {
    parse_bigint(first).cmp(&parse_bigint(second))
}

/// TS: `intrinsicCapacitySearch.ts:1767-1788` `compareCapacityBeamEntries`.
/// The plain `'objective'` retention comparator. Within one depth the
/// capacity retention order mirrors the endpoint objective: count, exact
/// material, exact cavities, then intrinsic envelope compactness and
/// deterministic occupied identity. Depths never compete.
fn compare_capacity_beam_entries(
    first: &CapacityBeamEntry,
    second: &CapacityBeamEntry,
) -> Ordering {
    let first_count = first.state.placement_order.len();
    let second_count = second.state.placement_order.len();
    if first_count != second_count {
        return second_count.cmp(&first_count);
    }
    if first.placed_doubled_material_area_grid2 != second.placed_doubled_material_area_grid2 {
        return if first.placed_doubled_material_area_grid2
            > second.placed_doubled_material_area_grid2
        {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    first
        .cavities
        .count
        .partial_cmp(&second.cavities.count)
        .unwrap()
        .then_with(|| {
            compare_bigint_decimal_strings(
                &first.cavities.total_doubled_area_grid2,
                &second.cavities.total_doubled_area_grid2,
            )
        })
        .then_with(|| {
            js_math::max(first.grid_span.width_grid, first.grid_span.height_grid)
                .partial_cmp(&js_math::max(
                    second.grid_span.width_grid,
                    second.grid_span.height_grid,
                ))
                .unwrap()
        })
        .then_with(|| compare_intrinsic_capacity_envelope_areas(first.grid_span, second.grid_span))
        .then_with(|| {
            (first.grid_span.width_grid + first.grid_span.height_grid)
                .partial_cmp(&(second.grid_span.width_grid + second.grid_span.height_grid))
                .unwrap()
        })
        .then_with(|| {
            cmp_js_code_units(&first.anchored_occupied_key, &second.anchored_occupied_key)
        })
}

/// TS: `intrinsicCapacitySearch.ts:1790-1814` `compareCapacityBeamEntriesAreaFirst`.
/// Same as [`compare_capacity_beam_entries`] but swaps the order of the "max
/// side" and "envelope area" terms; used only by `'area-first-shadow'`.
fn compare_capacity_beam_entries_area_first(
    first: &CapacityBeamEntry,
    second: &CapacityBeamEntry,
) -> Ordering {
    let first_count = first.state.placement_order.len();
    let second_count = second.state.placement_order.len();
    if first_count != second_count {
        return second_count.cmp(&first_count);
    }
    if first.placed_doubled_material_area_grid2 != second.placed_doubled_material_area_grid2 {
        return if first.placed_doubled_material_area_grid2
            > second.placed_doubled_material_area_grid2
        {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    first
        .cavities
        .count
        .partial_cmp(&second.cavities.count)
        .unwrap()
        .then_with(|| {
            compare_bigint_decimal_strings(
                &first.cavities.total_doubled_area_grid2,
                &second.cavities.total_doubled_area_grid2,
            )
        })
        .then_with(|| compare_intrinsic_capacity_envelope_areas(first.grid_span, second.grid_span))
        .then_with(|| {
            js_math::max(first.grid_span.width_grid, first.grid_span.height_grid)
                .partial_cmp(&js_math::max(
                    second.grid_span.width_grid,
                    second.grid_span.height_grid,
                ))
                .unwrap()
        })
        .then_with(|| {
            (first.grid_span.width_grid + first.grid_span.height_grid)
                .partial_cmp(&(second.grid_span.width_grid + second.grid_span.height_grid))
                .unwrap()
        })
        .then_with(|| {
            cmp_js_code_units(&first.anchored_occupied_key, &second.anchored_occupied_key)
        })
}

/// TS: `intrinsicCapacitySearch.ts:1817-1825` `compareIntrinsicCapacityEnvelopeAreas`.
/// Compares canonical capacity envelopes without losing one-grid-square
/// differences. Also exported and unit-tested directly upstream.
pub fn compare_intrinsic_capacity_envelope_areas(
    first: IntrinsicCapacityGridSpan,
    second: IntrinsicCapacityGridSpan,
) -> Ordering {
    let first_area = f64_to_bigint(first.width_grid) * f64_to_bigint(first.height_grid);
    let second_area = f64_to_bigint(second.width_grid) * f64_to_bigint(second.height_grid);
    first_area.cmp(&second_area)
}

/// TS: `intrinsicCapacitySearch.ts:2209-2226` `compareCapacityBeamEntryAccounting`.
/// The prefix of [`compare_capacity_beam_entries`] (count, material, cavity
/// count, cavity area) with no geometry/identity suffix.
fn compare_capacity_beam_entry_accounting(
    first: &CapacityBeamEntry,
    second: &CapacityBeamEntry,
) -> Ordering {
    let first_count = first.state.placement_order.len();
    let second_count = second.state.placement_order.len();
    if first_count != second_count {
        return second_count.cmp(&first_count);
    }
    if first.placed_doubled_material_area_grid2 != second.placed_doubled_material_area_grid2 {
        return if first.placed_doubled_material_area_grid2
            > second.placed_doubled_material_area_grid2
        {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    first
        .cavities
        .count
        .partial_cmp(&second.cavities.count)
        .unwrap()
        .then_with(|| {
            compare_bigint_decimal_strings(
                &first.cavities.total_doubled_area_grid2,
                &second.cavities.total_doubled_area_grid2,
            )
        })
}

fn compare_capacity_beam_entries_width_first(
    first: &CapacityBeamEntry,
    second: &CapacityBeamEntry,
) -> Ordering {
    compare_capacity_beam_entry_accounting(first, second)
        .then_with(|| {
            first
                .grid_span
                .width_grid
                .partial_cmp(&second.grid_span.width_grid)
                .unwrap()
        })
        .then_with(|| {
            first
                .grid_span
                .height_grid
                .partial_cmp(&second.grid_span.height_grid)
                .unwrap()
        })
        .then_with(|| compare_capacity_beam_entries(first, second))
}

fn compare_capacity_beam_entries_height_first(
    first: &CapacityBeamEntry,
    second: &CapacityBeamEntry,
) -> Ordering {
    compare_capacity_beam_entry_accounting(first, second)
        .then_with(|| {
            first
                .grid_span
                .height_grid
                .partial_cmp(&second.grid_span.height_grid)
                .unwrap()
        })
        .then_with(|| {
            first
                .grid_span
                .width_grid
                .partial_cmp(&second.grid_span.width_grid)
                .unwrap()
        })
        .then_with(|| compare_capacity_beam_entries(first, second))
}

fn reserve_into_beam(
    retained: &mut Vec<CapacityBeamEntry>,
    retained_keys: &mut HashSet<String>,
    ordered: &[&CapacityBeamEntry],
    maximum: usize,
    beam_width: usize,
) {
    let mut added = 0usize;
    for entry in ordered {
        if retained.len() >= beam_width {
            return;
        }
        let key = intrinsic_capacity_successor_identity(entry);
        if retained_keys.contains(&key) {
            continue;
        }
        retained.push((*entry).clone());
        retained_keys.insert(key);
        added += 1;
        if added >= maximum || retained.len() >= beam_width {
            return;
        }
    }
}

/// TS: `intrinsicCapacitySearch.ts:1827-1879` `retainCapacityBeamEntries`.
fn retain_capacity_beam_entries(
    entries: &[CapacityBeamEntry],
    beam_width: f64,
    mode: IntrinsicCapacityRetentionMode,
    topology_measurements: Option<&CapacityTopologyMeasurements>,
    timing_now: &TimingNowFn,
) -> Vec<CapacityBeamEntry> {
    let beam_width_usize = beam_width as usize;
    match mode {
        IntrinsicCapacityRetentionMode::Objective => {
            let mut sorted: Vec<&CapacityBeamEntry> = entries.iter().collect();
            sorted.sort_by(|a, b| compare_capacity_beam_entries(a, b));
            sorted.into_iter().take(beam_width_usize).cloned().collect()
        }
        IntrinsicCapacityRetentionMode::AreaFirstShadow => {
            let mut sorted: Vec<&CapacityBeamEntry> = entries.iter().collect();
            sorted.sort_by(|a, b| compare_capacity_beam_entries_area_first(a, b));
            sorted.into_iter().take(beam_width_usize).cloned().collect()
        }
        IntrinsicCapacityRetentionMode::CohesionFrontier
        | IntrinsicCapacityRetentionMode::CohesionFrontierShadow
        | IntrinsicCapacityRetentionMode::QualityFrontier => {
            let allocation = if mode == IntrinsicCapacityRetentionMode::QualityFrontier {
                Some((js_math::max(1.0, beam_width - 4.0), 1.0))
            } else {
                None
            };
            let fresh = CapacityTopologyMeasurements::new();
            let topology_measurements = topology_measurements.unwrap_or(&fresh);
            retain_capacity_cohesion_frontier(
                entries,
                beam_width,
                topology_measurements,
                allocation,
                timing_now,
            )
        }
        IntrinsicCapacityRetentionMode::AxisBucketsShadow => {
            let mut retained: Vec<CapacityBeamEntry> = Vec::new();
            let mut retained_keys: HashSet<String> = HashSet::new();
            let mut by_objective: Vec<&CapacityBeamEntry> = entries.iter().collect();
            by_objective.sort_by(|a, b| compare_capacity_beam_entries(a, b));
            reserve_into_beam(
                &mut retained,
                &mut retained_keys,
                &by_objective,
                js_math::max(1.0, beam_width - 8.0) as usize,
                beam_width_usize,
            );
            let mut by_width: Vec<&CapacityBeamEntry> = entries.iter().collect();
            by_width.sort_by(|a, b| compare_capacity_beam_entries_width_first(a, b));
            reserve_into_beam(
                &mut retained,
                &mut retained_keys,
                &by_width,
                4,
                beam_width_usize,
            );
            let mut by_height: Vec<&CapacityBeamEntry> = entries.iter().collect();
            by_height.sort_by(|a, b| compare_capacity_beam_entries_height_first(a, b));
            reserve_into_beam(
                &mut retained,
                &mut retained_keys,
                &by_height,
                4,
                beam_width_usize,
            );
            reserve_into_beam(
                &mut retained,
                &mut retained_keys,
                &by_objective,
                beam_width_usize,
                beam_width_usize,
            );
            retained
        }
    }
}

#[derive(Clone, Copy)]
enum TopologyMetric {
    Isolated,
    LargestComponent,
    ComponentCount,
    HullWaste,
}

/// TS: `intrinsicCapacitySearch.ts:1889-1920` `compareTopology` (the
/// closure inside `retainCapacityCohesionFrontier`, called from that
/// function's own `reserve(entries.toSorted(...), ...)` steps over the
/// *full*, unfiltered survivor list) and `:2139-2168` `compareTopologyMetric`
/// (the free-function twin `makeCapacityTopologyRetentionDepthTrace`'s
/// `specifications` loop calls, but only ever over `bestAccounting` --
/// `measuredSurvivors` pre-filtered to entries that already tie in
/// accounting with the depth's best entry). These two TS functions are
/// **not** textually identical -- only `compareTopology` has the accounting
/// short-circuit below; `compareTopologyMetric` measures both arguments
/// unconditionally -- but they are provably behavior-equivalent at every
/// site this crate calls this single merged Rust function from `bestAccounting`,
/// because every pair drawn from that pre-filtered list already has equal
/// accounting by construction, so the short-circuit below is a guaranteed
/// no-op there; merging them into one function is therefore safe, not a
/// divergence.
///
/// # Accounting short-circuit: measurement, not just comparison, is gated
///
/// TS's `compareTopology` checks `compareCapacityBeamEntryAccounting(first,
/// second)` **first** and returns immediately on any non-zero result,
/// *before* calling `topologyMeasurements.measure()` on either argument.
/// This is not a pure comparison optimization: `measure()` has the side
/// effect of incrementing the checkpoint-visible
/// `topologyMeasurementCount`/`topologyMeasurementMs` counters (and, on a
/// cache miss, running the real topology measurement). Skipping straight to
/// `measure()` -- as this function previously did unconditionally -- still
/// produces the *same relative order* (accounting differences already
/// decide those pairs either way), but measures strictly more entries than
/// TS ever does over `retainCapacityCohesionFrontier`'s unfiltered survivor
/// list, which is directly observable in the capacity checkpoint's
/// `integrityHash` preimage (`topologyRetentionDepths[].topologyMeasurementCount`/
/// `topologyMeasurementMs`). Confirmed by direct preimage diffing against a
/// real TS run (`tests/capacity_search_vectors.rs`'s checkpoint cases,
/// `cohesion-frontier`/`cohesion-frontier-shadow`/`quality-frontier`
/// retention modes): with this short-circuit missing, every case with more
/// than one distinct-accounting measured survivor triggered one or more
/// extra measurements TS's own comparator never performs.
fn compare_topology_metric(
    topology_measurements: &CapacityTopologyMeasurements,
    first: &CapacityBeamEntry,
    second: &CapacityBeamEntry,
    metric: TopologyMetric,
    timing_now: &TimingNowFn,
) -> Ordering {
    let accounting = compare_capacity_beam_entry_accounting(first, second);
    if accounting != Ordering::Equal {
        return accounting;
    }
    let first_topology = topology_measurements.measure(first, timing_now);
    let second_topology = topology_measurements.measure(second, timing_now);
    match (&first_topology, &second_topology) {
        (None, None) => compare_capacity_beam_entries(first, second),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(first_topology), Some(second_topology)) => {
            let first_metrics = &first_topology.topology;
            let second_metrics = &second_topology.topology;
            let difference = match metric {
                TopologyMetric::Isolated => first_metrics
                    .isolated_piece_count
                    .partial_cmp(&second_metrics.isolated_piece_count)
                    .unwrap(),
                TopologyMetric::LargestComponent => second_metrics
                    .largest_positive_contact_component_size
                    .partial_cmp(&first_metrics.largest_positive_contact_component_size)
                    .unwrap(),
                TopologyMetric::ComponentCount => first_metrics
                    .positive_contact_component_count
                    .partial_cmp(&second_metrics.positive_contact_component_count)
                    .unwrap(),
                TopologyMetric::HullWaste => {
                    compare_exact_hull_waste(first_topology, second_topology)
                }
            };
            difference.then_with(|| compare_capacity_beam_entries(first, second))
        }
    }
}

/// TS: `intrinsicCapacitySearch.ts:2163-2183` `compareExactHullWaste`.
fn compare_exact_hull_waste(
    first: &CanonicalLayoutTopologyExact,
    second: &CanonicalLayoutTopologyExact,
) -> Ordering {
    if first.exact_hull_doubled_area_grid2 == "0" || second.exact_hull_doubled_area_grid2 == "0" {
        return compare_bigint_decimal_strings(
            &first.exact_hull_gap_doubled_area_grid2,
            &second.exact_hull_gap_doubled_area_grid2,
        );
    }
    let first_scaled = parse_bigint(&first.exact_hull_gap_doubled_area_grid2)
        * parse_bigint(&second.exact_hull_doubled_area_grid2);
    let second_scaled = parse_bigint(&second.exact_hull_gap_doubled_area_grid2)
        * parse_bigint(&first.exact_hull_doubled_area_grid2);
    first_scaled.cmp(&second_scaled)
}

/// TS: `intrinsicCapacitySearch.ts:1881-1964` `retainCapacityCohesionFrontier`.
/// The production-default retention algorithm: a 5-step bucketed
/// reservation, not a single top-K sort.
fn retain_capacity_cohesion_frontier(
    entries: &[CapacityBeamEntry],
    beam_width: f64,
    topology_measurements: &CapacityTopologyMeasurements,
    allocation: Option<(f64, f64)>,
    timing_now: &TimingNowFn,
) -> Vec<CapacityBeamEntry> {
    let beam_width_usize = beam_width as usize;
    let mut retained: Vec<CapacityBeamEntry> = Vec::new();
    let mut retained_keys: HashSet<String> = HashSet::new();

    let topology_bucket_width = allocation
        .map(|(_, t)| t)
        .unwrap_or_else(|| js_math::max(1.0, js_math::floor(beam_width / 4.0)));
    let objective_bucket_width = allocation.map(|(o, _)| o).unwrap_or(topology_bucket_width);

    let mut by_objective: Vec<&CapacityBeamEntry> = entries.iter().collect();
    by_objective.sort_by(|a, b| compare_capacity_beam_entries(a, b));
    reserve_into_beam(
        &mut retained,
        &mut retained_keys,
        &by_objective,
        objective_bucket_width as usize,
        beam_width_usize,
    );

    let mut by_isolated: Vec<&CapacityBeamEntry> = entries.iter().collect();
    by_isolated.sort_by(|a, b| {
        compare_topology_metric(
            topology_measurements,
            a,
            b,
            TopologyMetric::Isolated,
            timing_now,
        )
    });
    reserve_into_beam(
        &mut retained,
        &mut retained_keys,
        &by_isolated,
        topology_bucket_width as usize,
        beam_width_usize,
    );

    let mut by_largest: Vec<&CapacityBeamEntry> = entries.iter().collect();
    by_largest.sort_by(|a, b| {
        compare_topology_metric(
            topology_measurements,
            a,
            b,
            TopologyMetric::LargestComponent,
            timing_now,
        )
    });
    reserve_into_beam(
        &mut retained,
        &mut retained_keys,
        &by_largest,
        topology_bucket_width as usize,
        beam_width_usize,
    );

    let mut by_component_hull: Vec<&CapacityBeamEntry> = entries.iter().collect();
    by_component_hull.sort_by(|a, b| {
        compare_topology_metric(
            topology_measurements,
            a,
            b,
            TopologyMetric::ComponentCount,
            timing_now,
        )
        .then_with(|| {
            compare_topology_metric(
                topology_measurements,
                a,
                b,
                TopologyMetric::HullWaste,
                timing_now,
            )
        })
    });
    reserve_into_beam(
        &mut retained,
        &mut retained_keys,
        &by_component_hull,
        beam_width_usize,
        beam_width_usize,
    );

    reserve_into_beam(
        &mut retained,
        &mut retained_keys,
        &by_objective,
        beam_width_usize,
        beam_width_usize,
    );

    retained
}

/// TS: `intrinsicCapacitySearch.ts:1966-1974`'s inline type plus
/// `:1976-2001` `makeCapacityTopologyMeasurements`. Interior-mutable so a
/// shared `&CapacityTopologyMeasurements` reference can be captured by
/// multiple sequential `sort_by` comparator closures without Rust borrow-
/// checker friction (a pragmatic Rust-only accommodation; see this module's
/// top doc for the analogous `CapacitySearchControl` reasoning).
struct CapacityTopologyMeasurements {
    topology_by_identity: RefCell<HashMap<String, Option<CanonicalLayoutTopologyExact>>>,
    count: RefCell<f64>,
    elapsed_ms: RefCell<f64>,
}

impl CapacityTopologyMeasurements {
    fn new() -> Self {
        Self {
            topology_by_identity: RefCell::new(HashMap::new()),
            count: RefCell::new(0.0),
            elapsed_ms: RefCell::new(0.0),
        }
    }

    fn measure(
        &self,
        entry: &CapacityBeamEntry,
        timing_now: &TimingNowFn,
    ) -> Option<CanonicalLayoutTopologyExact> {
        let identity = &entry.successor_identity;
        if let Some(cached) = self.topology_by_identity.borrow().get(identity) {
            return cached.clone();
        }
        let started_at = timing_now();
        let measured = if entry.state.placed_collision_geometries.is_empty() {
            None
        } else {
            measure_canonical_layout_topology_exact(&cloned_placed(
                &entry.state.placed_collision_geometries,
            ))
        };
        *self.count.borrow_mut() += 1.0;
        *self.elapsed_ms.borrow_mut() += js_math::max(0.0, timing_now() - started_at);
        self.topology_by_identity
            .borrow_mut()
            .insert(identity.clone(), measured.clone());
        measured
    }

    fn count(&self) -> f64 {
        *self.count.borrow()
    }

    fn elapsed_ms(&self) -> f64 {
        *self.elapsed_ms.borrow()
    }
}

/// TS: `intrinsicCapacitySearch.ts:540-547`'s mutable accumulator object
/// literal.
#[derive(Default)]
struct ContactFanoutTrace {
    legal_candidate_count: f64,
    measured_candidate_count: f64,
    positive_candidate_count: f64,
    measurement_ms: f64,
    selected_successor_count: f64,
    deduplicated_successor_count: f64,
}

/// TS: `intrinsicCapacitySearch.ts:2003-2127` `makeCapacityTopologyRetentionDepthTrace`.
#[allow(clippy::too_many_arguments)]
fn make_capacity_topology_retention_depth_trace(
    depth: f64,
    piece_id: &PieceId,
    measured_survivors: &[CapacityBeamEntry],
    retained: &[CapacityBeamEntry],
    topology_measurements: &CapacityTopologyMeasurements,
    contact_fanout_trace: &ContactFanoutTrace,
    retained_successor_count: f64,
    timing_now: &TimingNowFn,
) -> IntrinsicCapacityTopologyRetentionDepthTrace {
    let retained_identities: HashSet<String> = retained
        .iter()
        .map(intrinsic_capacity_successor_identity)
        .collect();
    let mut objective_ordered: Vec<&CapacityBeamEntry> = measured_survivors.iter().collect();
    objective_ordered.sort_by(|a, b| compare_capacity_beam_entries(a, b));
    let best = objective_ordered.first().copied();
    let best_accounting: Vec<&CapacityBeamEntry> = match best {
        None => Vec::new(),
        Some(best) => measured_survivors
            .iter()
            .filter(|entry| compare_capacity_beam_entry_accounting(entry, best) == Ordering::Equal)
            .collect(),
    };

    let specs = [
        IntrinsicCapacityTopologyRepresentativeRole::TerminalObjective,
        IntrinsicCapacityTopologyRepresentativeRole::MinimumComponents,
        IntrinsicCapacityTopologyRepresentativeRole::MinimumIsolated,
        IntrinsicCapacityTopologyRepresentativeRole::MaximumLargestComponent,
        IntrinsicCapacityTopologyRepresentativeRole::MinimumHullWaste,
    ];
    let mut representatives: Vec<IntrinsicCapacityTopologyRepresentative> = Vec::new();
    for role in specs {
        let mut ordered: Vec<&CapacityBeamEntry> = best_accounting.clone();
        match role {
            IntrinsicCapacityTopologyRepresentativeRole::TerminalObjective => {
                ordered.sort_by(|a, b| compare_capacity_beam_entries(a, b))
            }
            IntrinsicCapacityTopologyRepresentativeRole::MinimumComponents => {
                ordered.sort_by(|a, b| {
                    compare_topology_metric(
                        topology_measurements,
                        a,
                        b,
                        TopologyMetric::ComponentCount,
                        timing_now,
                    )
                })
            }
            IntrinsicCapacityTopologyRepresentativeRole::MinimumIsolated => {
                ordered.sort_by(|a, b| {
                    compare_topology_metric(
                        topology_measurements,
                        a,
                        b,
                        TopologyMetric::Isolated,
                        timing_now,
                    )
                })
            }
            IntrinsicCapacityTopologyRepresentativeRole::MaximumLargestComponent => ordered
                .sort_by(|a, b| {
                    compare_topology_metric(
                        topology_measurements,
                        a,
                        b,
                        TopologyMetric::LargestComponent,
                        timing_now,
                    )
                }),
            IntrinsicCapacityTopologyRepresentativeRole::MinimumHullWaste => {
                ordered.sort_by(|a, b| {
                    compare_topology_metric(
                        topology_measurements,
                        a,
                        b,
                        TopologyMetric::HullWaste,
                        timing_now,
                    )
                })
            }
        }
        let Some(entry) = ordered.first().copied() else {
            continue;
        };
        let decision_identity = intrinsic_capacity_successor_identity(entry);
        let Some(transition) = &entry.observer_transition else {
            continue;
        };
        representatives.push(IntrinsicCapacityTopologyRepresentative {
            role,
            decision_identity: decision_identity.clone(),
            parent_decision_identity: transition.parent_decision_identity.clone(),
            decision: transition.decision,
            proposal_role: transition.proposal_role,
            piece_id: transition.piece_id.clone(),
            anchored_occupied_key: entry.anchored_occupied_key.clone(),
            placed_count: entry.state.placement_order.len() as f64,
            placed_doubled_material_area_grid2: entry.placed_doubled_material_area_grid2.clone(),
            cavities: entry.cavities.clone(),
            grid_span: entry.grid_span,
            topology: topology_measurements.measure(entry, timing_now),
            retained: retained_identities.contains(&decision_identity),
        });
    }
    IntrinsicCapacityTopologyRetentionDepthTrace {
        depth,
        piece_id: piece_id.clone(),
        measured_survivor_count: measured_survivors.len() as f64,
        retained_count: retained.len() as f64,
        best_accounting_stratum_count: best_accounting.len() as f64,
        topology_measurement_count: topology_measurements.count(),
        topology_measurement_ms: topology_measurements.elapsed_ms(),
        legal_candidate_count: contact_fanout_trace.legal_candidate_count,
        contact_measured_candidate_count: contact_fanout_trace.measured_candidate_count,
        positive_contact_candidate_count: contact_fanout_trace.positive_candidate_count,
        contact_measurement_ms: contact_fanout_trace.measurement_ms,
        contact_selected_successor_count: contact_fanout_trace.selected_successor_count,
        contact_deduplicated_successor_count: contact_fanout_trace.deduplicated_successor_count,
        contact_retained_successor_count: retained_successor_count,
        representatives,
    }
}

// ===========================================================================
// Small, pure helpers (`intrinsicCapacitySearch.ts:2239-2273`).
// ===========================================================================

/// TS: `intrinsicCapacitySearch.ts:2239-2256` `makeCapacityPlacement`.
fn make_capacity_placement(
    piece: &IrregularPreparedPiece,
    candidate: &IrregularPlacementCandidate,
) -> IrregularPlacement {
    IrregularPlacement {
        // TS branches on `piece.pieceId === undefined` to omit vs. include
        // the `pieceId` own-property; `piece.piece_id.clone()` reproduces
        // the exact same conditional presence via `Option`/`skip_serializing_if`
        // (see this cluster's `capacity-search.md` §3 discussion).
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

/// TS: `intrinsicCapacitySearch.ts:2258-2272` `suffixMaterialSums`.
fn suffix_material_sums(
    prepared_ids: &[PieceId],
    material_areas_by_piece_id: &HashMap<PieceId, BigInt>,
) -> Option<Vec<BigInt>> {
    let mut sums: Vec<BigInt> = vec![BigInt::from(0); prepared_ids.len() + 1];
    for index in (0..prepared_ids.len()).rev() {
        let area = material_areas_by_piece_id.get(&prepared_ids[index])?;
        let next_sum = sums[index + 1].clone();
        sums[index] = next_sum + area;
    }
    Some(sums)
}

/// TS: `transformCollisionGeometry` call site
/// (`intrinsicCapacitySearch.ts:600-603`), ported as a private local wrapper
/// around the reused `caches::resolve_transformed_collision_geometry`
/// resolver, matching `search::strict_decoder`'s own identically-named
/// private helper for the same call shape (a small, intentional local
/// duplication of a three-line adapter, not a GREEN-module violation).
fn transform_collision_geometry(
    geometry: &CollisionGeometry,
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

/// Local duplicate of `search::strict_decoder`'s own private `cloned_placed`
/// (and `capacity::endpoint`'s own private `to_owned_placed`) -- the
/// established, repeated pattern in this crate for converting
/// `&[Arc<IrregularPlacedPiece>]` into an owned slice for `canonical_grid`/
/// `search::placement_scorer` functions that take plain
/// `&[IrregularPlacedPiece]`.
fn cloned_placed(placed: &[Arc<IrregularPlacedPiece>]) -> Vec<IrregularPlacedPiece> {
    placed.iter().map(|entry| (**entry).clone()).collect()
}
