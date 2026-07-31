//! Capacity-mode wiring: the full `intrinsicCapacityMode.ts` orchestration --
//! `runIntrinsicCapacityMode`, `runProtectedCapacityLaneCoordinator`,
//! `runIntrinsicCapacitySchedulerColdQuantum`,
//! `runIntrinsicCapacityCohesionShadow` -- plus trace chronology validation,
//! the quality-admission gate, the warm-lane tie-break rule, the
//! all-unplaced fallback endpoint, and the scheduler evaluation-cap
//! arithmetic.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicCapacityMode.ts`
//! (1430 lines), read together with
//! `docs/planning/rust-irregular-backend/characterization/capacity-core.md`
//! (this module's primary governing source) and
//! `docs/planning/rust-irregular-backend/characterization/capacity-search.md`.
//!
//! # History: pure pieces first, orchestration in a follow-up
//!
//! This file was originally written while `capacity::search`/
//! `capacity::prefixes` were still stubs, so only the pieces that did not
//! depend on the search/prefix engine's own result types were ported then
//! (see this module's own `#[cfg(test)]` module and the functions listed
//! below -- all unchanged since, still byte-exact ports of their TS
//! counterparts): [`intrinsic_capacity_quality_strictly_improves_placed_count`],
//! [`intrinsic_capacity_lane_coordinator_trace_valid`],
//! [`INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS`],
//! [`base_placement_evaluation_cap`], [`select_protected_warm_settlement_lane`],
//! [`make_all_unplaced_fallback_endpoint`]. Both `capacity::search` and
//! `capacity::prefixes` are fully ported now, so this follow-up adds the
//! remaining top-level orchestration against their real APIs:
//! [`run_intrinsic_capacity_mode`] (`runIntrinsicCapacityMode`,
//! `:1143-1411`), the private `run_protected_capacity_lane_coordinator`
//! (`runProtectedCapacityLaneCoordinator`, `:467-999`), the private
//! `run_intrinsic_capacity_cohesion_shadow` (`runIntrinsicCapacityCohesionShadow`,
//! `:1077-1129`), and [`run_intrinsic_capacity_scheduler_cold_quantum`]
//! (`runIntrinsicCapacitySchedulerColdQuantum`, `:386-431`).
//!
//! Every trace-shape struct this file already defined (the lane-coordinator/
//! warm-prefix/quality-warm-prefix trace types) is *extended* in place with
//! the fields the structural validator never read but the real orchestration
//! must produce (`reusedPlacedCount`, `selectedForContinuation`,
//! `checkpointRetained`, `elapsedMs`, `version`/`producerRole`/`policy`
//! fixed-literal tags, `continuedProducers`, `retainedCheckpointCount`,
//! `censoredLaneCount`, `warmPilotDepthBoundaries`) -- never a second,
//! parallel copy of the same TS type.
//!
//! # Deliberately narrowed vs. the full TS `RunIntrinsicCapacityModeInput`
//!
//! Per `result::mod`'s own "Deliberately not ported" section (this cluster's
//! coordinator has never been able to set any of these, since
//! `nesting.worker.ts` -- the sole production caller -- never sets the
//! corresponding `ComputeIrregularNestingOptions` fields), the following TS
//! input fields are **not** carried by [`RunIntrinsicCapacityModeInput`]:
//! `disablePrefixReuse` (`capacityControlArm`), `capturePhaseTimings`
//! (`captureCapacityPhaseTimings`), `captureWarmPrefixTelemetry`
//! (`captureCapacityWarmPrefixTelemetry` -- and per `:1244` its own branch is
//! provably dead once `coordinateProtectedLanes` is set, which production
//! always does at the one call site that would otherwise reach it),
//! `onCohesionShadowLane`/`onWarmPrefixLane` (`onCapacity*Lane`, pure
//! diagnostic hooks that influence no returned value). This function body
//! always behaves as if each of these were `false`/omitted, exactly
//! production's own always-taken branch. `captureCohesionShadow` **is**
//! carried (`capture_cohesion_shadow`) and the cohesion-shadow observer is
//! fully ported below, per this task's explicit brief, even though
//! production itself never sets it to `true`.
//!
//! # No `timingNow` seam in `intrinsicCapacityMode.ts` itself
//!
//! Unlike `intrinsicCapacitySearch.ts` (which carries a real, TS-source
//! `timingNow` seam this crate's `capacity::search` already threads through),
//! `intrinsicCapacityMode.ts` calls `performance.now()` unconditionally with
//! no override -- confirmed by direct source grep. This file therefore does
//! not invent one either (out of scope: TS source files are not this task's
//! to edit). The orchestration functions below accept and forward an
//! optional `timing_now` seam **only** as pass-through to their own nested
//! `run_intrinsic_capacity_cold_search` calls (preserving that
//! already-established lower-layer seam's usefulness to callers), while
//! this file's own `elapsed_ms`/`runtime_ms` accounting uses the real
//! wall clock directly, exactly matching TS's own unconditional
//! `performance.now()` -- both are diagnostic-only fields excluded from
//! byte-exact differential comparison, matching every other
//! `performance.now()`-derived field in this crate.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use num_bigint::BigInt;
use serde::{Serialize, Serializer};

use crate::archive::anytime::{
    retain_intrinsic_anytime_archive_namespace, IntrinsicAnytimeArchiveNamespace,
    IntrinsicAnytimeArchiveNamespacePolicy,
};
use crate::archive::shared::IntrinsicSharedArchiveDirectRole;
use crate::caches::GeometryCacheStore;
use crate::domain::{IrregularNestingSettings, IrregularPreparedPiece, PieceId, SheetSpec};
use crate::js_number::{js_math, number_to_js_string};
use crate::nfp_ifp::NfpIfpControl;
use crate::search::beam_state::{IrregularBeamState, TimingNowFn};

use super::endpoint::{
    compare_intrinsic_capacity_endpoints, intrinsic_capacity_endpoint_partitions_request,
    intrinsic_capacity_objective, materialize_intrinsic_capacity_endpoint,
    IntrinsicCapacityCavityCache, IntrinsicCapacityEndpoint, IntrinsicCapacityEndpointOrigin,
    IntrinsicCapacityObjective, MaterializeIntrinsicCapacityEndpointInput,
};
use super::material::{
    intrinsic_capacity_material_areas, intrinsic_capacity_prepared_piece_id,
    IntrinsicCapacityMaterialAreas,
};
use super::prefixes::{
    capture_intrinsic_capacity_prefix_descriptors, terminalize_intrinsic_capacity_prefix_endpoints,
    IntrinsicCapacityPrefixDescriptor, IntrinsicCapacityPrefixSource,
};
use super::preflight::{IntrinsicCapacityError, IntrinsicCapacityPreflightOutcome};
use super::search::{
    materialize_intrinsic_capacity_checkpoint_endpoints, run_intrinsic_capacity_cold_search,
    CapacitySearchError, IntrinsicAnytimeCheckpoint, IntrinsicCapacityRetentionMode,
    IntrinsicCapacitySearchResult, IntrinsicCapacitySearchStatus, IntrinsicCapacitySettlement,
    IntrinsicCapacityWarmPrefixSeed, RunIntrinsicCapacityColdSearchInput,
    INTRINSIC_CAPACITY_V1_BOUNDS,
};

/// TS: `intrinsicCapacityMode.ts:335-343`
/// `intrinsicCapacityQualityStrictlyImprovesPlacedCount`.
pub fn intrinsic_capacity_quality_strictly_improves_placed_count(
    candidate_placed_count: Option<f64>,
    incumbent_placed_count: Option<f64>,
) -> bool {
    match candidate_placed_count {
        Some(candidate) => candidate > incumbent_placed_count.unwrap_or(0.0),
        None => false,
    }
}

/// TS: `intrinsicCapacityMode.ts:383`
/// `INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS = 4`.
pub const INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS: f64 = 4.0;

/// TS: `intrinsicCapacityMode.ts:490-494`'s `basePlacementEvaluationCap`
/// computation, extracted as a pure function of its two bound inputs. See
/// this module's top doc for why the `INTRINSIC_CAPACITY_V1_BOUNDS`
/// constant itself is not duplicated here.
pub fn base_placement_evaluation_cap(
    prepared_piece_count: f64,
    minimum_placement_evaluation_cap: f64,
    placement_evaluation_quota_per_depth: f64,
) -> f64 {
    js_math::max(
        minimum_placement_evaluation_cap,
        prepared_piece_count * placement_evaluation_quota_per_depth,
    )
}

// ===========================================================================
// Lane-coordinator trace chronology validator
// (`intrinsicCapacityMode.ts:132-327`)
// ===========================================================================

/// TS: `intrinsicCapacityMode.ts:86` `status: 'settled' | 'checkpointed-censored'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WarmPrefixLaneStatus {
    Settled,
    CheckpointedCensored,
}

impl WarmPrefixLaneStatus {
    /// TS: `intrinsicCapacityMode.ts:86` literal union. Any TS-facing
    /// string must use this, not `{:?}`.
    pub fn as_str(self) -> &'static str {
        match self {
            WarmPrefixLaneStatus::Settled => "settled",
            WarmPrefixLaneStatus::CheckpointedCensored => "checkpointed-censored",
        }
    }
}

impl Serialize for WarmPrefixLaneStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `intrinsicCapacityMode.ts:82-93` `IntrinsicCapacityWarmPrefixLaneTrace`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityWarmPrefixLaneTrace {
    pub source_role: String,
    pub prefix_depth: f64,
    pub reused_placed_count: f64,
    pub status: WarmPrefixLaneStatus,
    pub selected_for_continuation: bool,
    pub checkpoint_retained: bool,
    pub consumed_placement_evaluations: f64,
    pub completed_depths: f64,
    pub elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<IntrinsicCapacityObjective>,
}

/// TS: `intrinsicCapacityMode.ts:112-117`'s `status` union.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QualityWarmPrefixStatus {
    SkippedBelowMinimumPieceCount,
    SkippedNoFittingCanonicalPrefix,
    Settled,
    EvaluationCap,
    CheckpointedCensored,
}

impl QualityWarmPrefixStatus {
    /// TS: `intrinsicCapacityMode.ts:112-117` literal union. Any TS-facing
    /// string must use this, not `{:?}`.
    pub fn as_str(self) -> &'static str {
        match self {
            QualityWarmPrefixStatus::SkippedBelowMinimumPieceCount => {
                "skipped-below-minimum-piece-count"
            }
            QualityWarmPrefixStatus::SkippedNoFittingCanonicalPrefix => {
                "skipped-no-fitting-canonical-prefix"
            }
            QualityWarmPrefixStatus::Settled => "settled",
            QualityWarmPrefixStatus::EvaluationCap => "evaluation-cap",
            QualityWarmPrefixStatus::CheckpointedCensored => "checkpointed-censored",
        }
    }
}

impl Serialize for QualityWarmPrefixStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `intrinsicCapacityMode.ts:118` `outputInfluence: 'none' |
/// 'strict-count-improvement'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QualityWarmPrefixOutputInfluence {
    None,
    StrictCountImprovement,
}

impl QualityWarmPrefixOutputInfluence {
    pub fn as_str(self) -> &'static str {
        match self {
            QualityWarmPrefixOutputInfluence::None => "none",
            QualityWarmPrefixOutputInfluence::StrictCountImprovement => "strict-count-improvement",
        }
    }
}

impl Serialize for QualityWarmPrefixOutputInfluence {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `intrinsicCapacityMode.ts:109` `version`.
pub const INTRINSIC_CAPACITY_QUALITY_WARM_PREFIX_TRACE_VERSION: &str =
    "intrinsic-capacity-quality-warm-prefix-v1";

/// TS: `intrinsicCapacityMode.ts:108-130` `IntrinsicCapacityQualityWarmPrefixTrace`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityQualityWarmPrefixTrace {
    pub version: &'static str,
    pub producer_role: &'static str,
    pub policy: &'static str,
    pub status: QualityWarmPrefixStatus,
    pub output_influence: QualityWarmPrefixOutputInfluence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix_depth: Option<f64>,
    pub reused_placed_count: f64,
    pub request_piece_count: f64,
    pub minimum_piece_count: f64,
    pub placement_evaluation_cap: f64,
    pub consumed_placement_evaluations: f64,
    pub completed_depths: f64,
    pub checkpoint_retained: bool,
    pub elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<IntrinsicCapacityObjective>,
}

/// TS: `intrinsicCapacityMode.ts:156-159`
/// `IntrinsicCapacityLaneCoordinatorTrace['quanta'][number]['producerRole']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaneCoordinatorQuantumProducerRole {
    CapacityCold,
    CapacityQualityWarmPrefix,
    CapacityWarmPrefix,
}

impl LaneCoordinatorQuantumProducerRole {
    pub fn as_str(self) -> &'static str {
        match self {
            LaneCoordinatorQuantumProducerRole::CapacityCold => "capacity-cold",
            LaneCoordinatorQuantumProducerRole::CapacityQualityWarmPrefix => {
                "capacity-quality-warm-prefix"
            }
            LaneCoordinatorQuantumProducerRole::CapacityWarmPrefix => "capacity-warm-prefix",
        }
    }
}

impl Serialize for LaneCoordinatorQuantumProducerRole {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `intrinsicCapacityMode.ts:162` `phase: 'initial' | 'resume' | 'censor'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaneCoordinatorQuantumPhase {
    Initial,
    Resume,
    Censor,
}

impl LaneCoordinatorQuantumPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            LaneCoordinatorQuantumPhase::Initial => "initial",
            LaneCoordinatorQuantumPhase::Resume => "resume",
            LaneCoordinatorQuantumPhase::Censor => "censor",
        }
    }
}

impl Serialize for LaneCoordinatorQuantumPhase {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `intrinsicCapacityMode.ts:166` `outcome: 'checkpointed' | 'settled' | 'censored'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaneCoordinatorQuantumOutcome {
    Checkpointed,
    Settled,
    Censored,
}

impl LaneCoordinatorQuantumOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            LaneCoordinatorQuantumOutcome::Checkpointed => "checkpointed",
            LaneCoordinatorQuantumOutcome::Settled => "settled",
            LaneCoordinatorQuantumOutcome::Censored => "censored",
        }
    }
}

impl Serialize for LaneCoordinatorQuantumOutcome {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `intrinsicCapacityMode.ts:154-167`
/// `IntrinsicCapacityLaneCoordinatorTrace['quanta'][number]`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityLaneCoordinatorQuantum {
    pub ordinal: f64,
    pub producer_role: LaneCoordinatorQuantumProducerRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix_depth: Option<f64>,
    pub phase: LaneCoordinatorQuantumPhase,
    pub from_depth: f64,
    pub to_depth: f64,
    pub placement_evaluation_delta: f64,
    pub outcome: LaneCoordinatorQuantumOutcome,
}

/// TS: `intrinsicCapacityMode.ts:137-151` `continuedProducers` union member.
/// Wire shape: internally tagged on `role`, matching TS's own discriminated
/// union exactly (`{"role":"capacity-cold"}` /
/// `{"role":"capacity-warm-prefix","sourceRole":...,"prefixDepth":...}` /
/// `{"role":"capacity-quality-warm-prefix","sourceRole":...,"prefixDepth":...}`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum LaneCoordinatorContinuedProducer {
    #[serde(rename = "capacity-cold")]
    CapacityCold,
    #[serde(rename = "capacity-warm-prefix")]
    CapacityWarmPrefix {
        source_role: String,
        prefix_depth: f64,
    },
    /// `sourceRole` is always `'canonical-grid'` at this variant's one
    /// construction site (`intrinsicCapacityMode.ts:986`).
    #[serde(rename = "capacity-quality-warm-prefix")]
    CapacityQualityWarmPrefix {
        source_role: String,
        prefix_depth: f64,
    },
}

/// TS: `intrinsicCapacityMode.ts:133` `version`.
pub const INTRINSIC_CAPACITY_LANE_COORDINATOR_TRACE_VERSION: &str =
    "intrinsic-capacity-lane-coordinator-v3";

/// TS: `intrinsicCapacityMode.ts:132-168` `IntrinsicCapacityLaneCoordinatorTrace`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityLaneCoordinatorTrace {
    pub version: &'static str,
    pub aggregate_placement_evaluation_cap: f64,
    pub aggregate_consumed_placement_evaluations: f64,
    pub warm_pilot_depth_boundaries: f64,
    pub continued_producers: Vec<LaneCoordinatorContinuedProducer>,
    pub retained_checkpoint_count: f64,
    pub censored_lane_count: f64,
    pub quanta: Vec<IntrinsicCapacityLaneCoordinatorQuantum>,
}

/// TS: `intrinsicCapacityMode.ts:316-318` `capacityLaneIdentity`.
fn capacity_lane_identity(source_role: &str, prefix_depth: f64) -> String {
    format!("{source_role}@{}", number_to_js_string(prefix_depth))
}

/// TS: `intrinsicCapacityMode.ts:320-327` `capacityLaneQuantumIdentity`.
fn capacity_lane_quantum_identity(quantum: &IntrinsicCapacityLaneCoordinatorQuantum) -> String {
    capacity_lane_identity(
        quantum.source_role.as_deref().unwrap_or("unknown"),
        quantum.prefix_depth.unwrap_or(0.0),
    )
}

/// TS: `intrinsicCapacityMode.ts:200-314` `intrinsicCapacityLaneCoordinatorTraceValid`.
/// Verifies exact coordinator chronology and per-lane evaluation accounting.
/// Not a ranking comparator -- a structural chronology validator used only
/// by tests/gates, never by production control flow; a Rust port that wants
/// an equivalent self-check must reproduce these exact inequalities (`>` vs
/// `>=`) precisely, which this function does.
pub fn intrinsic_capacity_lane_coordinator_trace_valid(
    trace: &IntrinsicCapacityLaneCoordinatorTrace,
    warm_lanes: &[IntrinsicCapacityWarmPrefixLaneTrace],
    quality_lane: Option<&IntrinsicCapacityQualityWarmPrefixTrace>,
) -> bool {
    if trace.aggregate_consumed_placement_evaluations > trace.aggregate_placement_evaluation_cap {
        return false;
    }
    for (index, quantum) in trace.quanta.iter().enumerate() {
        if quantum.ordinal != index as f64
            || quantum.from_depth.fract() != 0.0
            || quantum.to_depth.fract() != 0.0
            || quantum.from_depth < 0.0
            || quantum.to_depth < quantum.from_depth
            || quantum.placement_evaluation_delta.fract() != 0.0
            || quantum.placement_evaluation_delta < 0.0
        {
            return false;
        }
    }

    let cold_quanta: Vec<&IntrinsicCapacityLaneCoordinatorQuantum> = trace
        .quanta
        .iter()
        .filter(|quantum| quantum.producer_role == LaneCoordinatorQuantumProducerRole::CapacityCold)
        .collect();
    if cold_quanta.is_empty()
        || cold_quanta[0].phase != LaneCoordinatorQuantumPhase::Initial
        || cold_quanta
            .iter()
            .any(|quantum| quantum.source_role.is_some() || quantum.prefix_depth.is_some())
    {
        return false;
    }

    let evaluation_sum: f64 = trace
        .quanta
        .iter()
        .map(|quantum| quantum.placement_evaluation_delta)
        .sum();
    if evaluation_sum != trace.aggregate_consumed_placement_evaluations {
        return false;
    }

    let mut warm_resume_identities: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for quantum in &trace.quanta {
        if quantum.producer_role == LaneCoordinatorQuantumProducerRole::CapacityWarmPrefix
            && quantum.phase == LaneCoordinatorQuantumPhase::Resume
            && quantum.placement_evaluation_delta > 0.0
        {
            warm_resume_identities.insert(capacity_lane_quantum_identity(quantum));
        }
    }
    if warm_resume_identities.len() > 1 {
        return false;
    }

    for lane in warm_lanes {
        let lane_identity = capacity_lane_identity(&lane.source_role, lane.prefix_depth);
        let lane_quanta: Vec<&IntrinsicCapacityLaneCoordinatorQuantum> = trace
            .quanta
            .iter()
            .filter(|quantum| {
                quantum.producer_role == LaneCoordinatorQuantumProducerRole::CapacityWarmPrefix
                    && capacity_lane_quantum_identity(quantum) == lane_identity
            })
            .collect();
        if !lane_quanta_chronology_valid(
            &lane_quanta,
            lane.consumed_placement_evaluations,
            lane.completed_depths,
        ) {
            return false;
        }
        let Some(last) = lane_quanta.last() else {
            return false;
        };
        let expected_outcome = if lane.status == WarmPrefixLaneStatus::CheckpointedCensored {
            LaneCoordinatorQuantumOutcome::Censored
        } else {
            LaneCoordinatorQuantumOutcome::Settled
        };
        if last.outcome != expected_outcome {
            return false;
        }
    }

    let quality_quanta: Vec<&IntrinsicCapacityLaneCoordinatorQuantum> = trace
        .quanta
        .iter()
        .filter(|quantum| {
            quantum.producer_role == LaneCoordinatorQuantumProducerRole::CapacityQualityWarmPrefix
        })
        .collect();
    match quality_lane {
        None => {
            if !quality_quanta.is_empty() {
                return false;
            }
        }
        Some(quality_lane)
            if matches!(
                quality_lane.status,
                QualityWarmPrefixStatus::SkippedBelowMinimumPieceCount
                    | QualityWarmPrefixStatus::SkippedNoFittingCanonicalPrefix
            ) =>
        {
            if !quality_quanta.is_empty() || quality_lane.consumed_placement_evaluations != 0.0 {
                return false;
            }
        }
        Some(quality_lane) => {
            if quality_quanta.is_empty()
                || quality_quanta[0].phase != LaneCoordinatorQuantumPhase::Initial
            {
                return false;
            }
            for (index, quantum) in quality_quanta.iter().enumerate() {
                if quantum.source_role != quality_lane.source_role
                    || quantum.prefix_depth != quality_lane.prefix_depth
                {
                    return false;
                }
                if index > 0 && quantum.from_depth != quality_quanta[index - 1].to_depth {
                    return false;
                }
            }
            let sum: f64 = quality_quanta
                .iter()
                .map(|quantum| quantum.placement_evaluation_delta)
                .sum();
            if sum != quality_lane.consumed_placement_evaluations {
                return false;
            }
            let Some(last) = quality_quanta.last() else {
                return false;
            };
            if last.to_depth != quality_lane.completed_depths {
                return false;
            }
            let expected_outcome =
                if quality_lane.status == QualityWarmPrefixStatus::CheckpointedCensored {
                    LaneCoordinatorQuantumOutcome::Censored
                } else {
                    LaneCoordinatorQuantumOutcome::Settled
                };
            if last.outcome != expected_outcome {
                return false;
            }
        }
    }

    true
}

/// Shared per-lane quantum-chain contiguity + evaluation-sum + completed-depths
/// check reused by both the warm-lane and (inline) quality-lane validation
/// arms above (TS repeats this exact shape twice, `:258-271`/`:301-306`).
fn lane_quanta_chronology_valid(
    lane_quanta: &[&IntrinsicCapacityLaneCoordinatorQuantum],
    consumed_placement_evaluations: f64,
    completed_depths: f64,
) -> bool {
    let Some(first) = lane_quanta.first() else {
        return false;
    };
    if first.phase != LaneCoordinatorQuantumPhase::Initial {
        return false;
    }
    for index in 1..lane_quanta.len() {
        if lane_quanta[index].from_depth != lane_quanta[index - 1].to_depth {
            return false;
        }
    }
    let sum: f64 = lane_quanta
        .iter()
        .map(|quantum| quantum.placement_evaluation_delta)
        .sum();
    if sum != consumed_placement_evaluations {
        return false;
    }
    let Some(last) = lane_quanta.last() else {
        return false;
    };
    last.to_depth == completed_depths
}

// ===========================================================================
// Warm-lane settlement tie-break (`intrinsicCapacityMode.ts:1001-1075`)
// ===========================================================================

/// TS: `intrinsicCapacityMode.ts:433-446`
/// `ProtectedCapacityLane['role']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtectedCapacityLaneRole {
    CapacityCold,
    CapacityQualityWarmPrefix,
    CapacityWarmPrefix,
}

/// Seam view carrying exactly the fields
/// [`select_protected_warm_settlement_lane`] reads from one
/// `ProtectedCapacityLane` (`intrinsicCapacityMode.ts:433-446`, a
/// `capacity::search`-adjacent type this task does not own). See this
/// module's top doc, "Scope of this port".
#[derive(Clone, Debug, PartialEq)]
pub struct WarmSettlementLaneView {
    pub role: ProtectedCapacityLaneRole,
    /// TS: `lane.result.status === 'paused' && lane.result.checkpoint !== undefined`.
    pub is_paused_with_checkpoint: bool,
    /// TS: `lane.endpoints[0] !== undefined`.
    pub has_first_endpoint: bool,
    pub source_role: Option<String>,
    pub prefix_depth: Option<f64>,
}

/// TS: `intrinsicCapacityMode.ts:1046-1075` `selectProtectedWarmSettlementLane`.
/// Returns the index (into `lanes`, unchanged) of the single warm lane to
/// resume: deepest `prefixDepth` first, ties broken by the fixed
/// `sourcePriority` list, final fallback to the first deepest candidate in
/// `lanes` order.
pub fn select_protected_warm_settlement_lane(lanes: &[WarmSettlementLaneView]) -> Option<usize> {
    let candidates: Vec<(usize, &WarmSettlementLaneView)> = lanes
        .iter()
        .enumerate()
        .filter(|(_, lane)| {
            lane.role == ProtectedCapacityLaneRole::CapacityWarmPrefix
                && lane.is_paused_with_checkpoint
                && lane.has_first_endpoint
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }

    let maximum_prefix_depth = candidates
        .iter()
        .map(|(_, lane)| lane.prefix_depth.unwrap_or(0.0))
        .fold(f64::NEG_INFINITY, js_math::max);
    let deepest_candidates: Vec<(usize, &WarmSettlementLaneView)> = candidates
        .into_iter()
        .filter(|(_, lane)| lane.prefix_depth.unwrap_or(0.0) == maximum_prefix_depth)
        .collect();

    // TS: `intrinsicCapacityMode.ts:1063-1067` `sourcePriority` -- a fixed
    // literal priority list, iterated in this exact order.
    const SOURCE_PRIORITY: [&str; 3] = [
        "canonical-grid",
        "open-pocket-first",
        "legacy-absolute-envelope",
    ];
    for source_role in SOURCE_PRIORITY {
        if let Some((index, _)) = deepest_candidates
            .iter()
            .find(|(_, lane)| lane.source_role.as_deref() == Some(source_role))
        {
            return Some(*index);
        }
    }
    deepest_candidates.first().map(|(index, _)| *index)
}

// ===========================================================================
// All-unplaced fallback endpoint (`intrinsicCapacityMode.ts:1411-1430`)
// ===========================================================================

/// TS: `intrinsicCapacityMode.ts:1417-1430` `makeAllUnplacedFallbackEndpoint`.
/// The final, always-materializable fallback if every other candidate
/// endpoint fails to materialize: every prepared piece reported unplaced.
pub fn make_all_unplaced_fallback_endpoint(
    sheet: &SheetSpec,
    prepared_pieces: &[Arc<IrregularPreparedPiece>],
    material_areas_by_piece_id: &HashMap<PieceId, BigInt>,
    cavity_cache: &mut IntrinsicCapacityCavityCache,
) -> Option<IntrinsicCapacityEndpoint> {
    let unplaced_prepared_ids: Vec<PieceId> = prepared_pieces
        .iter()
        .map(|piece| intrinsic_capacity_prepared_piece_id(piece))
        .collect();
    let state = IrregularBeamState::empty(prepared_pieces.to_vec());
    materialize_intrinsic_capacity_endpoint(MaterializeIntrinsicCapacityEndpointInput {
        sheet,
        state,
        unplaced_prepared_ids,
        origin: IntrinsicCapacityEndpointOrigin::ColdSearch,
        source_role: None,
        prefix_depth: None,
        material_areas_by_piece_id,
        cavity_cache,
    })
}

// ===========================================================================
// Top-level orchestration (`intrinsicCapacityMode.ts:52-431,1131-1430`). See
// this module's top doc for scope/seam notes.
// ===========================================================================

/// TS: `intrinsicCapacityMode.ts:52-55` `IntrinsicCapacityRouting`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacityRouting {
    PreflightProvenImpossible,
    BoundedCompleteArchiveMiss,
}

impl IntrinsicCapacityRouting {
    /// TS: `intrinsicCapacityMode.ts:52-55` literal union. Any TS-facing
    /// string must use this, not `{:?}`.
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicCapacityRouting::PreflightProvenImpossible => "preflight-proven-impossible",
            IntrinsicCapacityRouting::BoundedCompleteArchiveMiss => "bounded-complete-archive-miss",
        }
    }
}

impl Serialize for IntrinsicCapacityRouting {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `intrinsicCapacityMode.ts:56-65` `IntrinsicCapacityPrefixTrace`'s
/// `descriptors` element shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityPrefixDescriptorSummary {
    pub role: String,
    pub depth: f64,
}

/// TS: `intrinsicCapacityMode.ts:56-65` `IntrinsicCapacityPrefixTrace`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityPrefixTrace {
    pub captured_count: f64,
    pub fitting_count: f64,
    pub rejected_count: f64,
    pub terminalized_count: f64,
    pub descriptors: Vec<IntrinsicCapacityPrefixDescriptorSummary>,
}

/// TS: `intrinsicCapacityMode.ts:67-74` `IntrinsicCapacityIncumbentTrace`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityIncumbentTrace {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix_depth: Option<f64>,
    pub placed_count: f64,
    pub placed_material_area_mm2: f64,
    pub selected_rotation_deg: f64,
    pub canonical_geometry_hash: String,
}

/// TS: `intrinsicCapacityMode.ts:76-80` `IntrinsicCapacitySelectionTrace`
/// (TS `extends IntrinsicCapacityObjective`; represented here as an
/// explicit nested `objective` field rather than a flattened duplicate of
/// every `IntrinsicCapacityObjective` field, since Rust has no structural
/// "extends" -- `#[serde(flatten)]` reproduces the real TS object's flat
/// key set on the wire (`objective`'s own fields alongside
/// `unplacedCount`/`placedMaterialAreaMm2`/`selectedRotationDeg`, exactly
/// TS's `{...intrinsicCapacityObjective(selected), unplacedCount, ...}`
/// spread shape at `intrinsicCapacityMode.ts:1396-1401`) without a second,
/// nested `objective` wire key the TS interface never has.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacitySelectionTrace {
    #[serde(flatten)]
    pub objective: IntrinsicCapacityObjective,
    pub unplaced_count: f64,
    pub placed_material_area_mm2: f64,
    pub selected_rotation_deg: f64,
}

/// TS: `intrinsicCapacityMode.ts:95-106` `IntrinsicCapacityCohesionShadowTrace`.
/// `producer_role`/`status`/`output_influence` are fixed single-literal
/// values in TS; kept as `&'static str` rather than single-variant enums,
/// matching this crate's established fixed-literal-tag convention (e.g.
/// `result::INTRINSIC_ANYTIME_SCHEDULER_TRACE_VERSION`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityCohesionShadowTrace {
    pub producer_role: &'static str,
    pub status: &'static str,
    pub output_influence: &'static str,
    pub consumed_placement_evaluations: f64,
    pub completed_depths: f64,
    pub elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<IntrinsicCapacityObjective>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention_depths:
        Option<Vec<crate::capacity::search::IntrinsicCapacityTopologyRetentionDepthTrace>>,
}

/// TS: `intrinsicCapacityMode.ts:175-197` `IntrinsicCapacityTrace`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityTrace {
    pub routing: IntrinsicCapacityRouting,
    pub preflight: IntrinsicCapacityPreflightOutcome,
    pub prefixes: IntrinsicCapacityPrefixTrace,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix_incumbent: Option<IntrinsicCapacityIncumbentTrace>,
    pub cold_search: crate::capacity::search::IntrinsicCapacitySearchTrace,
    /// Observer-only independent warm lanes; excluded from final selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warm_prefix_lanes: Option<Vec<IntrinsicCapacityWarmPrefixLaneTrace>>,
    pub warm_prefix_endpoints_admitted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cohesion_shadow: Option<IntrinsicCapacityCohesionShadowTrace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_warm_prefix: Option<IntrinsicCapacityQualityWarmPrefixTrace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane_coordinator: Option<IntrinsicCapacityLaneCoordinatorTrace>,
    pub selected: IntrinsicCapacitySelectionTrace,
    /// Coordinator-measured proof-only preflight runtime. Diagnostic-only
    /// (non-semantic timing; `scripts/rust-parity/run-differential.ts`'s
    /// `TIMING_ONLY_TRACE_FIELD_NAMES` compares this cluster's wall-clock
    /// fields presence-only, never by value).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preflight_runtime_ms: Option<f64>,
    /// Coordinator-measured unchanged complete archive runtime before the
    /// miss. Diagnostic-only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete_archive_runtime_ms: Option<f64>,
    /// Diagnostic-only.
    pub prefix_terminalization_ms: f64,
    /// Diagnostic-only.
    pub cold_search_ms: f64,
    /// Diagnostic-only.
    pub runtime_ms: f64,
}

/// TS: `intrinsicCapacityMode.ts:329-333` `IntrinsicCapacityModeResult`.
pub struct IntrinsicCapacityModeResult {
    pub endpoint: IntrinsicCapacityEndpoint,
    pub trace: IntrinsicCapacityTrace,
    /// Diagnostic-only; always `None` since this port never sets
    /// `capture_phase_timings` (see this module's top doc).
    pub phase_timings: Option<crate::capacity::search::IntrinsicCapacitySearchPhaseTimings>,
}

/// TS: `intrinsicCapacityMode.ts:345-381` `RunIntrinsicCapacityModeInput`. See
/// this module's top doc, "Deliberately narrowed", for exactly which TS
/// fields are absent here and why.
pub struct RunIntrinsicCapacityModeInput<'a> {
    pub sheet: &'a SheetSpec,
    pub prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    pub routing: IntrinsicCapacityRouting,
    pub preflight: &'a IntrinsicCapacityPreflightOutcome,
    /// Committed direct-constructor states; empty when complete mode was
    /// bypassed.
    pub prefix_sources: &'a [IntrinsicCapacityPrefixSource],
    /// Runs one independent generic topology frontier without selecting it.
    pub capture_cohesion_shadow: bool,
    /// Existing protected cold work produced before complete-cohort
    /// settlement.
    pub scheduled_cold_start: Option<IntrinsicCapacitySearchResult>,
    /// Allows settled warm lanes into the partial archive after a complete
    /// miss.
    pub admit_warm_prefix_endpoints: bool,
    /// Coordinates cold and warm lanes under one aggregate evaluation
    /// budget.
    pub coordinate_protected_lanes: bool,
    /// Coordinator-measured preflight runtime carried into the trace.
    pub preflight_runtime_ms: Option<f64>,
    /// Coordinator-measured complete archive runtime carried into the
    /// trace.
    pub complete_archive_runtime_ms: Option<f64>,
    pub retention_mode: Option<IntrinsicCapacityRetentionMode>,
}

/// Clones every prepared piece's `Arc` contents into an owned `Vec`, the
/// established adapter this cluster's coordinator already uses (see
/// `result::coordinator`'s identically-named private helper) to bridge
/// `&[Arc<IrregularPreparedPiece>]` call sites onto pure functions
/// (`intrinsic_capacity_material_areas`) that take plain owned slices,
/// mirroring TS's `ReadonlyArray<IrregularPreparedPiece>` (no ownership
/// distinction in JS).
fn owned_prepared_pieces(pieces: &[Arc<IrregularPreparedPiece>]) -> Vec<IrregularPreparedPiece> {
    pieces.iter().map(|piece| (**piece).clone()).collect()
}

/// TS: `intrinsicCapacityMode.ts:557,595,718,966` `continuedLaneIndexes`, a
/// `Set<number>`. Reproduced as an explicit insertion-ordered `Vec` (never a
/// `HashSet`) per this crate's JS-`Set`-insertion-order-is-observable
/// convention (`capacity-core.md` §12 item 4): `Set.add` on an
/// already-present value is a silent no-op that does not move or duplicate
/// it, which this helper reproduces via the `contains` guard.
fn add_continued_lane_index(indexes: &mut Vec<usize>, index: usize) {
    if !indexes.contains(&index) {
        indexes.push(index);
    }
}

/// Reborrows `control` for one nested `run_intrinsic_capacity_cold_search`
/// call. `&mut dyn Trait` parameters carry a *fixed* elided trait-object
/// lifetime bound once declared (a well-known Rust invariance hazard: `&mut
/// T` is invariant in `T`, and `T = dyn NfpIfpControl` here always has some
/// concrete-but-implicit lifetime bound baked in at the declaration site);
/// plain `.as_deref_mut()` reborrows preserve that original fixed bound, so
/// a struct literal that also carries a short-lived local field (e.g. a
/// freshly constructed `IntrinsicCapacityCavityCache`) alongside a plain
/// reborrow fails to type-check. Re-coercing through `as &mut dyn
/// NfpIfpControl` here forces fresh elision at every call site, matching
/// the same underlying cause `result::coordinator`'s `control_dyn` doc
/// comment documents (worked around there via a concrete wrapper type
/// instead, since that module's `control` originates from a concrete type
/// each time rather than an already-`dyn` reference).
fn reborrow_control<'b>(
    control: &'b mut Option<&mut dyn NfpIfpControl>,
) -> Option<&'b mut dyn NfpIfpControl> {
    control
        .as_deref_mut()
        .map(|control| control as &mut dyn NfpIfpControl)
}

/// TS: `intrinsicCapacityMode.ts:386-431` `runIntrinsicCapacitySchedulerColdQuantum`.
/// Advances the protected cold lane once before complete-cohort settlement.
pub struct RunIntrinsicCapacitySchedulerColdQuantumInput<'a> {
    pub sheet: &'a SheetSpec,
    pub prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    pub checkpoint: Option<IntrinsicAnytimeCheckpoint>,
    pub maximum_depth_boundaries: Option<f64>,
    pub retention_mode: Option<IntrinsicCapacityRetentionMode>,
}

// `control` carries its own lifetime parameter `'c`, independent of `'a`
// (used by every other borrowed parameter here). Every other caller in this
// crate reborrows `control` from a plain local scoped to the same duration
// as `sheet`/`settings`/`geometry_cache`, so unifying all of them under one
// `'a` was harmless there. `result::coordinator`'s `on_canonical_grid_checkpointed`
// closure is the one caller that must pass a `control` reborrow whose
// lifetime is *shorter* than `sheet`/`settings`/`geometry_cache` (a
// higher-ranked, per-invocation lifetime scoped to that one closure call,
// coming from `archive::shared`'s `OnCanonicalGridCheckpointed` callback
// parameter -- see that type's own doc comment): forcing it into the same
// `'a` as the long-lived parameters is unsatisfiable (confirmed by direct
// compiler experimentation: E0521 "borrowed data escapes outside of
// function" pinned at exactly this unification). Splitting the lifetime
// costs nothing for every other, already-`'a`-unified caller (Rust infers
// `'c = 'a` for them automatically).
// `geometry_cache` carries its own independent lifetime `'g`, for exactly
// the same reason and via exactly the same mechanism as `control`'s `'c`
// above: `result::coordinator`'s `on_canonical_grid_checkpointed` closure
// reborrows the coordinator's single job-wide `GeometryCacheStore` (never a
// phase-private one -- see `archive::shared`'s `OnCanonicalGridCheckpointed`
// doc comment and `cache-concurrency-design.md` §2) through
// `archive::shared`'s callback parameter, which is just as HRTB-short-lived
// as the `control` reborrow it arrives alongside.
//
// clippy's `needless_lifetimes` suggests collapsing `'c`/`'g` into `'a` here;
// that suggestion is exactly the bug the comment above this function
// explains -- `&'c mut dyn NfpIfpControl`/`&'g mut GeometryCacheStore` are
// both invariant, so unifying either with the longer-lived `'a` parameters
// would re-introduce the E0521 unsatisfiable borrow this lifetime split was
// written to fix. Deliberately allowed, not a missed elision.
#[allow(clippy::needless_lifetimes)]
pub fn run_intrinsic_capacity_scheduler_cold_quantum<'a, 'c, 'g>(
    input: RunIntrinsicCapacitySchedulerColdQuantumInput<'a>,
    mut control: Option<&'c mut dyn NfpIfpControl>,
    settings: &'a IrregularNestingSettings,
    geometry_cache: &'g mut GeometryCacheStore,
    timing_now: Option<&'a TimingNowFn>,
) -> Result<IntrinsicCapacitySearchResult, CapacitySearchError> {
    let owned_pieces = owned_prepared_pieces(input.prepared_pieces);
    let areas_by_piece_id = match intrinsic_capacity_material_areas(&owned_pieces) {
        IntrinsicCapacityMaterialAreas::Invalid { piece_id } => {
            return Err(CapacitySearchError::Capacity(IntrinsicCapacityError {
                operation: "schedulerMaterialAreas".to_string(),
                message: format!(
                    "piece {} has no exact positive unpadded material area.",
                    piece_id.as_str()
                ),
            }));
        }
        IntrinsicCapacityMaterialAreas::Complete { areas_by_piece_id } => areas_by_piece_id,
    };
    let maximum_depth_boundaries = input.maximum_depth_boundaries.unwrap_or_else(|| {
        js_math::min(
            INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS,
            js_math::max(1.0, input.prepared_pieces.len() as f64),
        )
    });
    let scheduler_deficit = input
        .checkpoint
        .as_ref()
        .map(|checkpoint| checkpoint.scheduler_deficit)
        .unwrap_or(1.0);
    let mut cavity_cache = IntrinsicCapacityCavityCache::new();
    run_intrinsic_capacity_cold_search(RunIntrinsicCapacityColdSearchInput {
        sheet: input.sheet,
        prepared_pieces: input.prepared_pieces,
        material_areas_by_piece_id: &areas_by_piece_id,
        cavity_cache: &mut cavity_cache,
        incumbent: None,
        control: reborrow_control(&mut control),
        capture_phase_timings: false,
        checkpoint: input.checkpoint,
        maximum_depth_boundaries: Some(maximum_depth_boundaries),
        warm_prefix_seed: None,
        scheduler_deficit: Some(scheduler_deficit),
        retention_mode: input.retention_mode,
        settings,
        geometry_cache,
        timing_now,
    })
}

// ===========================================================================
// `runProtectedCapacityLaneCoordinator` (`intrinsicCapacityMode.ts:433-999`).
// ===========================================================================

/// TS: `intrinsicCapacityMode.ts:459` `INTRINSIC_CAPACITY_WARM_PILOT_DEPTH_BOUNDARIES = 1`.
const INTRINSIC_CAPACITY_WARM_PILOT_DEPTH_BOUNDARIES: f64 = 1.0;
/// TS: `intrinsicCapacityMode.ts:460-461`
/// `INTRINSIC_CAPACITY_QUALITY_MINIMUM_PIECE_COUNT = INTRINSIC_CAPACITY_V1_BOUNDS.coldBeamWidth * 2`.
const INTRINSIC_CAPACITY_QUALITY_MINIMUM_PIECE_COUNT: f64 =
    INTRINSIC_CAPACITY_V1_BOUNDS.cold_beam_width * 2.0;

/// TS: `intrinsicCapacityMode.ts:433-446` `ProtectedCapacityLane`.
#[derive(Clone)]
struct ProtectedCapacityLane {
    role: ProtectedCapacityLaneRole,
    source_role: Option<String>,
    prefix_depth: Option<f64>,
    reused_placed_count: f64,
    warm_prefix_seed: Option<IntrinsicCapacityWarmPrefixSeed>,
    elapsed_ms: f64,
    result: IntrinsicCapacitySearchResult,
    endpoints: Vec<IntrinsicCapacityEndpoint>,
    selected_for_continuation: bool,
}

struct MakeProtectedCapacityLaneInput<'a> {
    role: ProtectedCapacityLaneRole,
    source_role: Option<String>,
    prefix_depth: Option<f64>,
    reused_placed_count: f64,
    warm_prefix_seed: Option<IntrinsicCapacityWarmPrefixSeed>,
    result: IntrinsicCapacitySearchResult,
    elapsed_ms: f64,
    selected_for_continuation: bool,
    sheet: &'a SheetSpec,
    prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    material_areas_by_piece_id: &'a HashMap<PieceId, BigInt>,
}

/// TS: `intrinsicCapacityMode.ts:1001-1044` `makeProtectedCapacityLane`.
fn make_protected_capacity_lane(
    input: MakeProtectedCapacityLaneInput<'_>,
) -> ProtectedCapacityLane {
    let endpoints = if input.result.status == IntrinsicCapacitySearchStatus::Settled {
        input.result.endpoints.clone()
    } else {
        match &input.result.checkpoint {
            None => Vec::new(),
            Some(checkpoint) => materialize_intrinsic_capacity_checkpoint_endpoints(
                input.sheet,
                input.prepared_pieces,
                input.material_areas_by_piece_id,
                &mut IntrinsicCapacityCavityCache::new(),
                checkpoint,
                input.warm_prefix_seed.as_ref(),
            ),
        }
    };
    ProtectedCapacityLane {
        role: input.role,
        source_role: input.source_role,
        prefix_depth: input.prefix_depth,
        reused_placed_count: input.reused_placed_count,
        warm_prefix_seed: input.warm_prefix_seed,
        elapsed_ms: input.elapsed_ms,
        result: input.result,
        endpoints,
        selected_for_continuation: input.selected_for_continuation,
    }
}

#[allow(clippy::too_many_arguments)]
fn push_lane_coordinator_quantum(
    quanta: &mut Vec<IntrinsicCapacityLaneCoordinatorQuantum>,
    producer_role: LaneCoordinatorQuantumProducerRole,
    source_role: Option<String>,
    prefix_depth: Option<f64>,
    phase: LaneCoordinatorQuantumPhase,
    from_depth: f64,
    to_depth: f64,
    placement_evaluation_delta: f64,
    outcome: LaneCoordinatorQuantumOutcome,
) {
    quanta.push(IntrinsicCapacityLaneCoordinatorQuantum {
        ordinal: quanta.len() as f64,
        producer_role,
        source_role,
        prefix_depth,
        phase,
        from_depth,
        to_depth,
        placement_evaluation_delta,
        outcome,
    });
}

struct ProtectedCapacityLaneCoordinatorResult {
    cold_search: IntrinsicCapacitySearchResult,
    cold_endpoints: Vec<IntrinsicCapacityEndpoint>,
    warm_endpoints: Vec<IntrinsicCapacityEndpoint>,
    warm_prefix_lanes: Vec<IntrinsicCapacityWarmPrefixLaneTrace>,
    quality_endpoints: Vec<IntrinsicCapacityEndpoint>,
    quality_warm_prefix: IntrinsicCapacityQualityWarmPrefixTrace,
    trace: IntrinsicCapacityLaneCoordinatorTrace,
    elapsed_ms: f64,
}

struct RunProtectedCapacityLaneCoordinatorInput<'a> {
    sheet: &'a SheetSpec,
    prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    material_areas_by_piece_id: &'a HashMap<PieceId, BigInt>,
    fitting_descriptors: &'a [IntrinsicCapacityPrefixDescriptor],
    scheduled_cold_start: Option<IntrinsicCapacitySearchResult>,
    retention_mode: Option<IntrinsicCapacityRetentionMode>,
}

/// TS: `intrinsicCapacityMode.ts:467-999` `runProtectedCapacityLaneCoordinator`.
/// Gives every protected lane one bounded sample, then resumes only the best
/// paused lane while a shared aggregate budget can reserve one full depth.
/// See `capacity-core.md` §4/§13: this whole function is chronology-bound
/// and must stay logically serial -- never race lanes against each other or
/// let "first completed" decide a winner.
#[allow(clippy::too_many_lines)]
fn run_protected_capacity_lane_coordinator<'a>(
    input: RunProtectedCapacityLaneCoordinatorInput<'a>,
    mut control: Option<&'a mut dyn NfpIfpControl>,
    settings: &'a IrregularNestingSettings,
    geometry_cache: &'a mut GeometryCacheStore,
    timing_now: Option<&'a TimingNowFn>,
) -> Result<ProtectedCapacityLaneCoordinatorResult, CapacitySearchError> {
    let started_at = Instant::now();
    let base_cap = base_placement_evaluation_cap(
        input.prepared_pieces.len() as f64,
        INTRINSIC_CAPACITY_V1_BOUNDS.minimum_placement_evaluation_cap,
        INTRINSIC_CAPACITY_V1_BOUNDS.placement_evaluation_quota_per_depth,
    );
    let mut canonical_grid_descriptors: Vec<&IntrinsicCapacityPrefixDescriptor> = input
        .fitting_descriptors
        .iter()
        .filter(|descriptor| descriptor.role == IntrinsicSharedArchiveDirectRole::CanonicalGrid)
        .collect();
    // TS: `.toSorted((first, second) => second.depth - first.depth)` --
    // stable descending sort (see this module's top doc / `capacity-core.md`
    // §12 item 3: `sort_by`, never `sort_unstable_by`).
    canonical_grid_descriptors
        .sort_by(|first, second| second.depth.partial_cmp(&first.depth).unwrap());
    let deepest_quality_descriptor = canonical_grid_descriptors.first().copied();
    let quality_descriptor =
        if input.prepared_pieces.len() as f64 >= INTRINSIC_CAPACITY_QUALITY_MINIMUM_PIECE_COUNT {
            deepest_quality_descriptor
        } else {
            None
        };
    let aggregate_placement_evaluation_cap = base_cap
        * if quality_descriptor.is_none() {
            2.0
        } else {
            3.0
        };

    let mut lanes: Vec<ProtectedCapacityLane> = Vec::new();
    let mut coordinator_quanta: Vec<IntrinsicCapacityLaneCoordinatorQuantum> = Vec::new();
    let mut continued_lane_indexes: Vec<usize> = Vec::new();

    // Cold lane, initial.
    let cold_started_at = Instant::now();
    let cold_result = match input.scheduled_cold_start {
        Some(scheduled) => scheduled,
        None => run_intrinsic_capacity_cold_search(RunIntrinsicCapacityColdSearchInput {
            sheet: input.sheet,
            prepared_pieces: input.prepared_pieces,
            material_areas_by_piece_id: input.material_areas_by_piece_id,
            cavity_cache: &mut IntrinsicCapacityCavityCache::new(),
            incumbent: None,
            control: reborrow_control(&mut control),
            capture_phase_timings: false,
            checkpoint: None,
            maximum_depth_boundaries: Some(js_math::min(
                INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS,
                js_math::max(1.0, input.prepared_pieces.len() as f64),
            )),
            warm_prefix_seed: None,
            scheduler_deficit: Some(1.0),
            retention_mode: input.retention_mode,
            settings,
            geometry_cache: &mut *geometry_cache,
            timing_now,
        })?,
    };
    lanes.push(make_protected_capacity_lane(
        MakeProtectedCapacityLaneInput {
            role: ProtectedCapacityLaneRole::CapacityCold,
            source_role: None,
            prefix_depth: None,
            reused_placed_count: 0.0,
            warm_prefix_seed: None,
            result: cold_result.clone(),
            elapsed_ms: js_math::max(0.0, cold_started_at.elapsed().as_secs_f64() * 1000.0),
            selected_for_continuation: false,
            sheet: input.sheet,
            prepared_pieces: input.prepared_pieces,
            material_areas_by_piece_id: input.material_areas_by_piece_id,
        },
    ));
    push_lane_coordinator_quantum(
        &mut coordinator_quanta,
        LaneCoordinatorQuantumProducerRole::CapacityCold,
        None,
        None,
        LaneCoordinatorQuantumPhase::Initial,
        0.0,
        cold_result.trace.completed_depths,
        cold_result.trace.consumed_placement_evaluations,
        if cold_result.status == IntrinsicCapacitySearchStatus::Paused {
            LaneCoordinatorQuantumOutcome::Checkpointed
        } else {
            LaneCoordinatorQuantumOutcome::Settled
        },
    );

    // Cold lane, one resume if the initial sample paused.
    if lanes[0].result.status == IntrinsicCapacitySearchStatus::Paused {
        let checkpoint = lanes[0].result.checkpoint.clone().ok_or_else(|| {
            CapacitySearchError::Capacity(IntrinsicCapacityError {
                operation: "capacityLaneCoordinator".to_string(),
                message: "paused protected cold lane has no checkpoint.".to_string(),
            })
        })?;
        let initial_elapsed_ms = lanes[0].elapsed_ms;
        let initial_completed_depths = lanes[0].result.trace.completed_depths;
        let initial_consumed = lanes[0].result.trace.consumed_placement_evaluations;
        let scheduler_deficit = checkpoint.scheduler_deficit;
        let resumed_at = Instant::now();
        let resumed = run_intrinsic_capacity_cold_search(RunIntrinsicCapacityColdSearchInput {
            sheet: input.sheet,
            prepared_pieces: input.prepared_pieces,
            material_areas_by_piece_id: input.material_areas_by_piece_id,
            cavity_cache: &mut IntrinsicCapacityCavityCache::new(),
            incumbent: None,
            control: reborrow_control(&mut control),
            capture_phase_timings: false,
            checkpoint: Some(checkpoint),
            maximum_depth_boundaries: None,
            warm_prefix_seed: None,
            scheduler_deficit: Some(scheduler_deficit),
            retention_mode: input.retention_mode,
            settings,
            geometry_cache: &mut *geometry_cache,
            timing_now,
        })?;
        let resumed_status = resumed.status;
        let resumed_completed_depths = resumed.trace.completed_depths;
        let placement_evaluation_delta = js_math::max(
            0.0,
            resumed.trace.consumed_placement_evaluations - initial_consumed,
        );
        lanes[0] = make_protected_capacity_lane(MakeProtectedCapacityLaneInput {
            role: ProtectedCapacityLaneRole::CapacityCold,
            source_role: None,
            prefix_depth: None,
            reused_placed_count: 0.0,
            warm_prefix_seed: None,
            result: resumed,
            elapsed_ms: initial_elapsed_ms
                + js_math::max(0.0, resumed_at.elapsed().as_secs_f64() * 1000.0),
            selected_for_continuation: true,
            sheet: input.sheet,
            prepared_pieces: input.prepared_pieces,
            material_areas_by_piece_id: input.material_areas_by_piece_id,
        });
        add_continued_lane_index(&mut continued_lane_indexes, 0);
        push_lane_coordinator_quantum(
            &mut coordinator_quanta,
            LaneCoordinatorQuantumProducerRole::CapacityCold,
            None,
            None,
            LaneCoordinatorQuantumPhase::Resume,
            initial_completed_depths,
            resumed_completed_depths,
            placement_evaluation_delta,
            if resumed_status == IntrinsicCapacitySearchStatus::Paused {
                LaneCoordinatorQuantumOutcome::Censored
            } else {
                LaneCoordinatorQuantumOutcome::Settled
            },
        );
    }

    // Warm pilot lanes, one bounded sample per fitting descriptor.
    for descriptor in input.fitting_descriptors {
        let lane_started_at = Instant::now();
        let warm_prefix_seed = IntrinsicCapacityWarmPrefixSeed {
            source_role: descriptor.role.as_str().to_string(),
            depth: descriptor.depth,
            state: Arc::clone(&descriptor.state),
        };
        let result = run_intrinsic_capacity_cold_search(RunIntrinsicCapacityColdSearchInput {
            sheet: input.sheet,
            prepared_pieces: input.prepared_pieces,
            material_areas_by_piece_id: input.material_areas_by_piece_id,
            cavity_cache: &mut IntrinsicCapacityCavityCache::new(),
            incumbent: None,
            control: reborrow_control(&mut control),
            capture_phase_timings: false,
            checkpoint: None,
            maximum_depth_boundaries: Some(INTRINSIC_CAPACITY_WARM_PILOT_DEPTH_BOUNDARIES),
            warm_prefix_seed: Some(warm_prefix_seed.clone()),
            scheduler_deficit: None,
            retention_mode: input.retention_mode,
            settings,
            geometry_cache: &mut *geometry_cache,
            timing_now,
        })?;
        let status = result.status;
        let completed_depths = result.trace.completed_depths;
        let consumed = result.trace.consumed_placement_evaluations;
        lanes.push(make_protected_capacity_lane(
            MakeProtectedCapacityLaneInput {
                role: ProtectedCapacityLaneRole::CapacityWarmPrefix,
                source_role: Some(descriptor.role.as_str().to_string()),
                prefix_depth: Some(descriptor.depth),
                reused_placed_count: descriptor.placed_prepared_ids.len() as f64,
                warm_prefix_seed: Some(warm_prefix_seed),
                result,
                elapsed_ms: js_math::max(0.0, lane_started_at.elapsed().as_secs_f64() * 1000.0),
                selected_for_continuation: false,
                sheet: input.sheet,
                prepared_pieces: input.prepared_pieces,
                material_areas_by_piece_id: input.material_areas_by_piece_id,
            },
        ));
        push_lane_coordinator_quantum(
            &mut coordinator_quanta,
            LaneCoordinatorQuantumProducerRole::CapacityWarmPrefix,
            Some(descriptor.role.as_str().to_string()),
            Some(descriptor.depth),
            LaneCoordinatorQuantumPhase::Initial,
            descriptor.depth,
            completed_depths,
            consumed,
            if status == IntrinsicCapacitySearchStatus::Paused {
                LaneCoordinatorQuantumOutcome::Checkpointed
            } else {
                LaneCoordinatorQuantumOutcome::Settled
            },
        );
    }

    // Single warm-lane resume loop: exactly one lane, selected once, may be
    // resumed repeatedly while the shared budget allows (never re-selected
    // mid-loop -- see `capacity-core.md` §13).
    let mut warm_consumed_placement_evaluations: f64 = lanes
        .iter()
        .filter(|lane| lane.role == ProtectedCapacityLaneRole::CapacityWarmPrefix)
        .map(|lane| lane.result.trace.consumed_placement_evaluations)
        .sum();
    let warm_lane_views: Vec<WarmSettlementLaneView> = lanes
        .iter()
        .map(|lane| WarmSettlementLaneView {
            role: lane.role,
            is_paused_with_checkpoint: lane.result.status == IntrinsicCapacitySearchStatus::Paused
                && lane.result.checkpoint.is_some(),
            has_first_endpoint: !lane.endpoints.is_empty(),
            source_role: lane.source_role.clone(),
            prefix_depth: lane.prefix_depth,
        })
        .collect();
    if let Some(selected_index) = select_protected_warm_settlement_lane(&warm_lane_views) {
        while base_cap - warm_consumed_placement_evaluations
            >= INTRINSIC_CAPACITY_V1_BOUNDS.placement_evaluation_quota_per_depth
        {
            let Some(warm_prefix_seed) = lanes[selected_index].warm_prefix_seed.clone() else {
                break;
            };
            let Some(checkpoint) = lanes[selected_index].result.checkpoint.clone() else {
                break;
            };
            let source_role = lanes[selected_index]
                .source_role
                .clone()
                .unwrap_or_else(|| "unknown".to_string());
            let prefix_depth = lanes[selected_index].prefix_depth.unwrap_or(0.0);
            let reused_placed_count = lanes[selected_index].reused_placed_count;
            let previous_consumed = lanes[selected_index]
                .result
                .trace
                .consumed_placement_evaluations;
            let previous_completed_depths = lanes[selected_index].result.trace.completed_depths;
            let previous_elapsed_ms = lanes[selected_index].elapsed_ms;
            let scheduler_deficit = checkpoint.scheduler_deficit;
            let resumed_at = Instant::now();
            let resumed =
                run_intrinsic_capacity_cold_search(RunIntrinsicCapacityColdSearchInput {
                    sheet: input.sheet,
                    prepared_pieces: input.prepared_pieces,
                    material_areas_by_piece_id: input.material_areas_by_piece_id,
                    cavity_cache: &mut IntrinsicCapacityCavityCache::new(),
                    incumbent: None,
                    control: reborrow_control(&mut control),
                    capture_phase_timings: false,
                    checkpoint: Some(checkpoint),
                    maximum_depth_boundaries: Some(1.0),
                    warm_prefix_seed: Some(warm_prefix_seed.clone()),
                    scheduler_deficit: Some(scheduler_deficit),
                    retention_mode: input.retention_mode,
                    settings,
                    geometry_cache: &mut *geometry_cache,
                    timing_now,
                })?;
            let consumed_delta = resumed.trace.consumed_placement_evaluations - previous_consumed;
            warm_consumed_placement_evaluations += js_math::max(0.0, consumed_delta);
            let resumed_status = resumed.status;
            let resumed_completed_depths = resumed.trace.completed_depths;
            lanes[selected_index] = make_protected_capacity_lane(MakeProtectedCapacityLaneInput {
                role: ProtectedCapacityLaneRole::CapacityWarmPrefix,
                source_role: Some(source_role.clone()),
                prefix_depth: Some(prefix_depth),
                reused_placed_count,
                warm_prefix_seed: Some(warm_prefix_seed),
                result: resumed,
                elapsed_ms: previous_elapsed_ms
                    + js_math::max(0.0, resumed_at.elapsed().as_secs_f64() * 1000.0),
                selected_for_continuation: true,
                sheet: input.sheet,
                prepared_pieces: input.prepared_pieces,
                material_areas_by_piece_id: input.material_areas_by_piece_id,
            });
            add_continued_lane_index(&mut continued_lane_indexes, selected_index);
            push_lane_coordinator_quantum(
                &mut coordinator_quanta,
                LaneCoordinatorQuantumProducerRole::CapacityWarmPrefix,
                Some(source_role),
                Some(prefix_depth),
                LaneCoordinatorQuantumPhase::Resume,
                previous_completed_depths,
                resumed_completed_depths,
                js_math::max(0.0, consumed_delta),
                if resumed_status == IntrinsicCapacitySearchStatus::Paused {
                    LaneCoordinatorQuantumOutcome::Checkpointed
                } else {
                    LaneCoordinatorQuantumOutcome::Settled
                },
            );
        }
    }

    // Quality lane: one deepest canonical-grid prefix, gated on piece count.
    let mut quality_endpoints: Vec<IntrinsicCapacityEndpoint> = Vec::new();
    let mut quality_warm_prefix = IntrinsicCapacityQualityWarmPrefixTrace {
        version: INTRINSIC_CAPACITY_QUALITY_WARM_PREFIX_TRACE_VERSION,
        producer_role: "capacity-quality-warm-prefix",
        policy: "quality-frontier",
        status: QualityWarmPrefixStatus::SkippedNoFittingCanonicalPrefix,
        output_influence: QualityWarmPrefixOutputInfluence::None,
        source_role: None,
        prefix_depth: None,
        reused_placed_count: 0.0,
        request_piece_count: input.prepared_pieces.len() as f64,
        minimum_piece_count: INTRINSIC_CAPACITY_QUALITY_MINIMUM_PIECE_COUNT,
        placement_evaluation_cap: base_cap,
        consumed_placement_evaluations: 0.0,
        completed_depths: 0.0,
        checkpoint_retained: false,
        elapsed_ms: 0.0,
        endpoint: None,
    };
    if let Some(descriptor) = deepest_quality_descriptor {
        if (input.prepared_pieces.len() as f64) < INTRINSIC_CAPACITY_QUALITY_MINIMUM_PIECE_COUNT {
            quality_warm_prefix.status = QualityWarmPrefixStatus::SkippedBelowMinimumPieceCount;
            quality_warm_prefix.source_role = Some("canonical-grid".to_string());
            quality_warm_prefix.prefix_depth = Some(descriptor.depth);
            quality_warm_prefix.reused_placed_count = descriptor.placed_prepared_ids.len() as f64;
        }
    }
    let mut quality_continued = false;
    if let Some(descriptor) = quality_descriptor {
        let quality_started_at = Instant::now();
        let warm_prefix_seed = IntrinsicCapacityWarmPrefixSeed {
            source_role: "canonical-grid".to_string(),
            depth: descriptor.depth,
            state: Arc::clone(&descriptor.state),
        };
        let mut quality_result =
            run_intrinsic_capacity_cold_search(RunIntrinsicCapacityColdSearchInput {
                sheet: input.sheet,
                prepared_pieces: input.prepared_pieces,
                material_areas_by_piece_id: input.material_areas_by_piece_id,
                cavity_cache: &mut IntrinsicCapacityCavityCache::new(),
                incumbent: None,
                control: reborrow_control(&mut control),
                capture_phase_timings: false,
                checkpoint: None,
                maximum_depth_boundaries: Some(INTRINSIC_CAPACITY_WARM_PILOT_DEPTH_BOUNDARIES),
                warm_prefix_seed: Some(warm_prefix_seed.clone()),
                scheduler_deficit: None,
                retention_mode: Some(IntrinsicCapacityRetentionMode::QualityFrontier),
                settings,
                geometry_cache: &mut *geometry_cache,
                timing_now,
            })?;
        push_lane_coordinator_quantum(
            &mut coordinator_quanta,
            LaneCoordinatorQuantumProducerRole::CapacityQualityWarmPrefix,
            Some("canonical-grid".to_string()),
            Some(descriptor.depth),
            LaneCoordinatorQuantumPhase::Initial,
            descriptor.depth,
            quality_result.trace.completed_depths,
            quality_result.trace.consumed_placement_evaluations,
            if quality_result.status == IntrinsicCapacitySearchStatus::Paused {
                LaneCoordinatorQuantumOutcome::Checkpointed
            } else {
                LaneCoordinatorQuantumOutcome::Settled
            },
        );
        while quality_result.status == IntrinsicCapacitySearchStatus::Paused
            && base_cap - quality_result.trace.consumed_placement_evaluations
                >= INTRINSIC_CAPACITY_V1_BOUNDS.placement_evaluation_quota_per_depth
        {
            let Some(checkpoint) = quality_result.checkpoint.clone() else {
                break;
            };
            let previous_depth = quality_result.trace.completed_depths;
            let previous_evaluations = quality_result.trace.consumed_placement_evaluations;
            let scheduler_deficit = checkpoint.scheduler_deficit;
            quality_result =
                run_intrinsic_capacity_cold_search(RunIntrinsicCapacityColdSearchInput {
                    sheet: input.sheet,
                    prepared_pieces: input.prepared_pieces,
                    material_areas_by_piece_id: input.material_areas_by_piece_id,
                    cavity_cache: &mut IntrinsicCapacityCavityCache::new(),
                    incumbent: None,
                    control: reborrow_control(&mut control),
                    capture_phase_timings: false,
                    checkpoint: Some(checkpoint),
                    maximum_depth_boundaries: Some(1.0),
                    warm_prefix_seed: Some(warm_prefix_seed.clone()),
                    scheduler_deficit: Some(scheduler_deficit),
                    retention_mode: Some(IntrinsicCapacityRetentionMode::QualityFrontier),
                    settings,
                    geometry_cache: &mut *geometry_cache,
                    timing_now,
                })?;
            quality_continued = true;
            push_lane_coordinator_quantum(
                &mut coordinator_quanta,
                LaneCoordinatorQuantumProducerRole::CapacityQualityWarmPrefix,
                Some("canonical-grid".to_string()),
                Some(descriptor.depth),
                LaneCoordinatorQuantumPhase::Resume,
                previous_depth,
                quality_result.trace.completed_depths,
                js_math::max(
                    0.0,
                    quality_result.trace.consumed_placement_evaluations - previous_evaluations,
                ),
                if quality_result.status == IntrinsicCapacitySearchStatus::Paused {
                    LaneCoordinatorQuantumOutcome::Checkpointed
                } else {
                    LaneCoordinatorQuantumOutcome::Settled
                },
            );
        }
        let quality_lane = make_protected_capacity_lane(MakeProtectedCapacityLaneInput {
            role: ProtectedCapacityLaneRole::CapacityQualityWarmPrefix,
            source_role: Some("canonical-grid".to_string()),
            prefix_depth: Some(descriptor.depth),
            reused_placed_count: descriptor.placed_prepared_ids.len() as f64,
            warm_prefix_seed: Some(warm_prefix_seed),
            result: quality_result.clone(),
            elapsed_ms: js_math::max(0.0, quality_started_at.elapsed().as_secs_f64() * 1000.0),
            selected_for_continuation: quality_continued,
            sheet: input.sheet,
            prepared_pieces: input.prepared_pieces,
            material_areas_by_piece_id: input.material_areas_by_piece_id,
        });
        quality_endpoints = quality_lane.endpoints.clone();
        if quality_result.status == IntrinsicCapacitySearchStatus::Paused {
            push_lane_coordinator_quantum(
                &mut coordinator_quanta,
                LaneCoordinatorQuantumProducerRole::CapacityQualityWarmPrefix,
                Some("canonical-grid".to_string()),
                Some(descriptor.depth),
                LaneCoordinatorQuantumPhase::Censor,
                quality_result.trace.completed_depths,
                quality_result.trace.completed_depths,
                0.0,
                LaneCoordinatorQuantumOutcome::Censored,
            );
        }
        quality_warm_prefix = IntrinsicCapacityQualityWarmPrefixTrace {
            version: INTRINSIC_CAPACITY_QUALITY_WARM_PREFIX_TRACE_VERSION,
            producer_role: "capacity-quality-warm-prefix",
            policy: "quality-frontier",
            status: if quality_result.status == IntrinsicCapacitySearchStatus::Paused {
                QualityWarmPrefixStatus::CheckpointedCensored
            } else if quality_result.trace.settlement == IntrinsicCapacitySettlement::EvaluationCap
            {
                QualityWarmPrefixStatus::EvaluationCap
            } else {
                QualityWarmPrefixStatus::Settled
            },
            output_influence: QualityWarmPrefixOutputInfluence::None,
            source_role: Some("canonical-grid".to_string()),
            prefix_depth: Some(descriptor.depth),
            reused_placed_count: descriptor.placed_prepared_ids.len() as f64,
            request_piece_count: input.prepared_pieces.len() as f64,
            minimum_piece_count: INTRINSIC_CAPACITY_QUALITY_MINIMUM_PIECE_COUNT,
            placement_evaluation_cap: base_cap,
            consumed_placement_evaluations: quality_result.trace.consumed_placement_evaluations,
            completed_depths: quality_result.trace.completed_depths,
            checkpoint_retained: quality_result.checkpoint.is_some(),
            elapsed_ms: quality_lane.elapsed_ms,
            endpoint: quality_endpoints.first().map(intrinsic_capacity_objective),
        };
    }

    let Some(cold_lane_final) = lanes
        .iter()
        .find(|lane| lane.role == ProtectedCapacityLaneRole::CapacityCold)
    else {
        return Err(CapacitySearchError::Capacity(IntrinsicCapacityError {
            operation: "capacityLaneCoordinator".to_string(),
            message: "protected capacity coordination lost the cold lane.".to_string(),
        }));
    };
    let cold_lane_result = cold_lane_final.result.clone();
    let cold_lane_endpoints = cold_lane_final.endpoints.clone();

    let warm_lanes: Vec<&ProtectedCapacityLane> = lanes
        .iter()
        .filter(|lane| lane.role == ProtectedCapacityLaneRole::CapacityWarmPrefix)
        .collect();

    let retained_checkpoint_count = lanes
        .iter()
        .filter(|lane| lane.result.status == IntrinsicCapacitySearchStatus::Paused)
        .count() as f64
        + if quality_warm_prefix.status == QualityWarmPrefixStatus::CheckpointedCensored {
            1.0
        } else {
            0.0
        };
    for lane in &warm_lanes {
        if lane.result.status == IntrinsicCapacitySearchStatus::Paused {
            push_lane_coordinator_quantum(
                &mut coordinator_quanta,
                LaneCoordinatorQuantumProducerRole::CapacityWarmPrefix,
                Some(
                    lane.source_role
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string()),
                ),
                Some(lane.prefix_depth.unwrap_or(0.0)),
                LaneCoordinatorQuantumPhase::Censor,
                lane.result.trace.completed_depths,
                lane.result.trace.completed_depths,
                0.0,
                LaneCoordinatorQuantumOutcome::Censored,
            );
        }
    }
    let aggregate_consumed_placement_evaluations =
        cold_lane_result.trace.consumed_placement_evaluations
            + warm_consumed_placement_evaluations
            + quality_warm_prefix.consumed_placement_evaluations;

    let mut continued_producers: Vec<LaneCoordinatorContinuedProducer> = Vec::new();
    for &lane_index in &continued_lane_indexes {
        let Some(lane) = lanes.get(lane_index) else {
            continue;
        };
        continued_producers.push(if lane.role == ProtectedCapacityLaneRole::CapacityCold {
            LaneCoordinatorContinuedProducer::CapacityCold
        } else {
            LaneCoordinatorContinuedProducer::CapacityWarmPrefix {
                source_role: lane
                    .source_role
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
                prefix_depth: lane.prefix_depth.unwrap_or(0.0),
            }
        });
    }
    if quality_continued {
        continued_producers.push(
            LaneCoordinatorContinuedProducer::CapacityQualityWarmPrefix {
                source_role: "canonical-grid".to_string(),
                prefix_depth: quality_descriptor
                    .map(|descriptor| descriptor.depth)
                    .unwrap_or(0.0),
            },
        );
    }

    let warm_prefix_lanes_trace: Vec<IntrinsicCapacityWarmPrefixLaneTrace> = warm_lanes
        .iter()
        .map(|lane| IntrinsicCapacityWarmPrefixLaneTrace {
            source_role: lane
                .source_role
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            prefix_depth: lane.prefix_depth.unwrap_or(0.0),
            reused_placed_count: lane.reused_placed_count,
            status: if lane.result.status == IntrinsicCapacitySearchStatus::Paused {
                WarmPrefixLaneStatus::CheckpointedCensored
            } else {
                WarmPrefixLaneStatus::Settled
            },
            selected_for_continuation: lane.selected_for_continuation,
            checkpoint_retained: lane.result.checkpoint.is_some(),
            consumed_placement_evaluations: lane.result.trace.consumed_placement_evaluations,
            completed_depths: lane.result.trace.completed_depths,
            elapsed_ms: lane.elapsed_ms,
            endpoint: lane.endpoints.first().map(intrinsic_capacity_objective),
        })
        .collect();
    let warm_endpoints_flat: Vec<IntrinsicCapacityEndpoint> = warm_lanes
        .iter()
        .flat_map(|lane| lane.endpoints.iter().cloned())
        .collect();

    Ok(ProtectedCapacityLaneCoordinatorResult {
        cold_search: cold_lane_result,
        cold_endpoints: cold_lane_endpoints,
        warm_endpoints: warm_endpoints_flat,
        warm_prefix_lanes: warm_prefix_lanes_trace,
        quality_endpoints,
        quality_warm_prefix,
        trace: IntrinsicCapacityLaneCoordinatorTrace {
            version: INTRINSIC_CAPACITY_LANE_COORDINATOR_TRACE_VERSION,
            aggregate_placement_evaluation_cap,
            aggregate_consumed_placement_evaluations,
            warm_pilot_depth_boundaries: INTRINSIC_CAPACITY_WARM_PILOT_DEPTH_BOUNDARIES,
            continued_producers,
            retained_checkpoint_count,
            censored_lane_count: retained_checkpoint_count,
            quanta: coordinator_quanta,
        },
        elapsed_ms: js_math::max(0.0, started_at.elapsed().as_secs_f64() * 1000.0),
    })
}

// ===========================================================================
// `runIntrinsicCapacityCohesionShadow` (`intrinsicCapacityMode.ts:1077-1129`).
// ===========================================================================

/// TS: `runIntrinsicCapacityCohesionShadow`'s `{ endpoint, trace }` return
/// shape, minus `endpoint` -- this port never wires the benchmark-only
/// `onCohesionShadowLane` hook that is the TS return value's only other
/// consumer (see this module's top doc), so the raw endpoint is unused here
/// (its `IntrinsicCapacityObjective` projection lives on `trace.endpoint`).
struct CohesionShadowOutcome {
    trace: IntrinsicCapacityCohesionShadowTrace,
}

/// TS: `intrinsicCapacityMode.ts:1077-1129` `runIntrinsicCapacityCohesionShadow`.
/// Observer-only: never enters `retainIntrinsicAnytimeArchiveNamespace`, its
/// endpoint is always `outputInfluence: 'none'`.
#[allow(clippy::too_many_arguments)]
fn run_intrinsic_capacity_cohesion_shadow<'a>(
    sheet: &'a SheetSpec,
    prepared_pieces: &'a [Arc<IrregularPreparedPiece>],
    material_areas_by_piece_id: &'a HashMap<PieceId, BigInt>,
    mut control: Option<&'a mut dyn NfpIfpControl>,
    settings: &'a IrregularNestingSettings,
    geometry_cache: &'a mut GeometryCacheStore,
    timing_now: Option<&'a TimingNowFn>,
) -> Result<CohesionShadowOutcome, CapacitySearchError> {
    let started_at = Instant::now();
    let mut cavity_cache = IntrinsicCapacityCavityCache::new();
    let result = run_intrinsic_capacity_cold_search(RunIntrinsicCapacityColdSearchInput {
        sheet,
        prepared_pieces,
        material_areas_by_piece_id,
        cavity_cache: &mut cavity_cache,
        incumbent: None,
        control: reborrow_control(&mut control),
        capture_phase_timings: false,
        checkpoint: None,
        maximum_depth_boundaries: None,
        warm_prefix_seed: None,
        scheduler_deficit: None,
        retention_mode: Some(IntrinsicCapacityRetentionMode::CohesionFrontierShadow),
        settings,
        geometry_cache,
        timing_now,
    })?;
    if result.status != IntrinsicCapacitySearchStatus::Settled {
        return Err(CapacitySearchError::Capacity(IntrinsicCapacityError {
            operation: "capacityCohesionShadow".to_string(),
            message: "the independent cohesion observer did not settle.".to_string(),
        }));
    }
    let endpoint = result.endpoints.first().cloned();
    let elapsed_ms = js_math::max(0.0, started_at.elapsed().as_secs_f64() * 1000.0);
    Ok(CohesionShadowOutcome {
        trace: IntrinsicCapacityCohesionShadowTrace {
            producer_role: "capacity-cohesion-shadow",
            status: "settled",
            output_influence: "none",
            consumed_placement_evaluations: result.trace.consumed_placement_evaluations,
            completed_depths: result.trace.completed_depths,
            elapsed_ms,
            endpoint: endpoint.as_ref().map(intrinsic_capacity_objective),
            retention_depths: result.trace.topology_retention_depths.clone(),
        },
    })
}

// ===========================================================================
// `runIntrinsicCapacityMode` (`intrinsicCapacityMode.ts:1143-1411`).
// ===========================================================================

/// TS: `intrinsicCapacityMode.ts:1143-1411` `runIntrinsicCapacityMode`. Runs
/// intrinsic-capacity-v1: terminalize fitting complete-search prefixes into
/// zero-evaluation incumbents, run the empty-start cold subset search, and
/// settle one exact best-known partial endpoint with a complete
/// placed/unplaced partition of the request.
pub fn run_intrinsic_capacity_mode<'a>(
    input: RunIntrinsicCapacityModeInput<'a>,
    mut control: Option<&'a mut dyn NfpIfpControl>,
    settings: &'a IrregularNestingSettings,
    geometry_cache: &'a mut GeometryCacheStore,
    timing_now: Option<&'a TimingNowFn>,
) -> Result<IntrinsicCapacityModeResult, CapacitySearchError> {
    let started_at = Instant::now();
    let owned_pieces = owned_prepared_pieces(input.prepared_pieces);
    let areas_by_piece_id = match intrinsic_capacity_material_areas(&owned_pieces) {
        IntrinsicCapacityMaterialAreas::Invalid { piece_id } => {
            return Err(CapacitySearchError::Capacity(IntrinsicCapacityError {
                operation: "capacityMaterialAreas".to_string(),
                message: format!(
                    "piece {} has no exact positive unpadded material area.",
                    piece_id.as_str()
                ),
            }));
        }
        IntrinsicCapacityMaterialAreas::Complete { areas_by_piece_id } => areas_by_piece_id,
    };
    let prepared_ids: Vec<PieceId> = input
        .prepared_pieces
        .iter()
        .map(|piece| intrinsic_capacity_prepared_piece_id(piece))
        .collect();
    let mut cavity_cache = IntrinsicCapacityCavityCache::new();

    let prefix_started_at = Instant::now();
    let descriptors =
        capture_intrinsic_capacity_prefix_descriptors(input.prepared_pieces, input.prefix_sources);
    let terminalization = terminalize_intrinsic_capacity_prefix_endpoints(
        input.sheet,
        &descriptors,
        &areas_by_piece_id,
        &mut cavity_cache,
    );
    let prefix_terminalization_ms =
        js_math::max(0.0, prefix_started_at.elapsed().as_secs_f64() * 1000.0);

    let cold_search_started_at = Instant::now();
    let (coordinated, cold_search) = if input.coordinate_protected_lanes {
        let result = run_protected_capacity_lane_coordinator(
            RunProtectedCapacityLaneCoordinatorInput {
                sheet: input.sheet,
                prepared_pieces: input.prepared_pieces,
                material_areas_by_piece_id: &areas_by_piece_id,
                fitting_descriptors: &terminalization.fitting_descriptors,
                scheduled_cold_start: input.scheduled_cold_start,
                retention_mode: input.retention_mode,
            },
            reborrow_control(&mut control),
            settings,
            &mut *geometry_cache,
            timing_now,
        )?;
        let cold_search = result.cold_search.clone();
        (Some(result), cold_search)
    } else {
        let scheduled_is_settled = matches!(
            &input.scheduled_cold_start,
            Some(scheduled) if scheduled.status == IntrinsicCapacitySearchStatus::Settled
        );
        let cold_search = if scheduled_is_settled {
            input
                .scheduled_cold_start
                .expect("checked Some+Settled above")
        } else {
            let checkpoint = input
                .scheduled_cold_start
                .as_ref()
                .and_then(|scheduled| scheduled.checkpoint.clone());
            let scheduler_deficit = checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.scheduler_deficit);
            let incumbent = if checkpoint.is_none() {
                terminalization.incumbent.as_ref()
            } else {
                None
            };
            run_intrinsic_capacity_cold_search(RunIntrinsicCapacityColdSearchInput {
                sheet: input.sheet,
                prepared_pieces: input.prepared_pieces,
                material_areas_by_piece_id: &areas_by_piece_id,
                cavity_cache: &mut cavity_cache,
                incumbent,
                control: reborrow_control(&mut control),
                capture_phase_timings: false,
                checkpoint,
                maximum_depth_boundaries: None,
                warm_prefix_seed: None,
                scheduler_deficit,
                retention_mode: input.retention_mode,
                settings,
                geometry_cache: &mut *geometry_cache,
                timing_now,
            })?
        };
        (None, cold_search)
    };
    let cold_search_ms = match &coordinated {
        Some(coordinated) => coordinated.elapsed_ms,
        None => js_math::max(0.0, cold_search_started_at.elapsed().as_secs_f64() * 1000.0),
    };

    let cohesion_shadow = if input.capture_cohesion_shadow {
        Some(run_intrinsic_capacity_cohesion_shadow(
            input.sheet,
            input.prepared_pieces,
            &areas_by_piece_id,
            reborrow_control(&mut control),
            settings,
            &mut *geometry_cache,
            timing_now,
        )?)
    } else {
        None
    };

    let warm_prefix_lanes: Option<Vec<IntrinsicCapacityWarmPrefixLaneTrace>> =
        coordinated.as_ref().map(|c| c.warm_prefix_lanes.clone());
    let warm_endpoints: Vec<IntrinsicCapacityEndpoint> = coordinated
        .as_ref()
        .map(|c| c.warm_endpoints.clone())
        .unwrap_or_default();

    let mut base_endpoints: Vec<IntrinsicCapacityEndpoint> = match &coordinated {
        Some(c) => c.cold_endpoints.clone(),
        None => cold_search.endpoints.clone(),
    };
    base_endpoints.extend(terminalization.endpoints.iter().cloned());
    if input.admit_warm_prefix_endpoints {
        base_endpoints.extend(warm_endpoints.iter().cloned());
    }

    let mut identity =
        |endpoint: &IntrinsicCapacityEndpoint| Some(endpoint.canonical_geometry_hash.clone());
    let mut validate = |endpoint: &IntrinsicCapacityEndpoint| {
        endpoint.metrics.placed_count == endpoint.placed_prepared_ids.len() as f64
            && intrinsic_capacity_endpoint_partitions_request(
                &endpoint.placed_prepared_ids,
                &endpoint.unplaced_prepared_ids,
                &prepared_ids,
            )
    };
    let mut select_duplicate =
        |retained: &IntrinsicCapacityEndpoint, candidate: &IntrinsicCapacityEndpoint| {
            if compare_intrinsic_capacity_endpoints(candidate, retained) == std::cmp::Ordering::Less
            {
                candidate.clone()
            } else {
                retained.clone()
            }
        };
    let mut rank = |mut unique: Vec<IntrinsicCapacityEndpoint>| {
        unique.sort_by(compare_intrinsic_capacity_endpoints);
        unique
    };
    let base_candidates =
        retain_intrinsic_anytime_archive_namespace(IntrinsicAnytimeArchiveNamespacePolicy {
            namespace: IntrinsicAnytimeArchiveNamespace::Partial,
            endpoints: &base_endpoints,
            identity: &mut identity,
            validate: &mut validate,
            select_duplicate: &mut select_duplicate,
            rank: &mut rank,
        });

    let quality_endpoint = coordinated
        .as_ref()
        .and_then(|c| c.quality_endpoints.first().cloned());
    let quality_improves_placed_count = intrinsic_capacity_quality_strictly_improves_placed_count(
        quality_endpoint
            .as_ref()
            .map(|endpoint| endpoint.metrics.placed_count),
        base_candidates
            .first()
            .map(|endpoint| endpoint.metrics.placed_count),
    );
    let candidates = if quality_improves_placed_count {
        let mut augmented = base_candidates.clone();
        if let Some(endpoint) = &quality_endpoint {
            augmented.push(endpoint.clone());
        }
        retain_intrinsic_anytime_archive_namespace(IntrinsicAnytimeArchiveNamespacePolicy {
            namespace: IntrinsicAnytimeArchiveNamespace::Partial,
            endpoints: &augmented,
            identity: &mut identity,
            validate: &mut validate,
            select_duplicate: &mut select_duplicate,
            rank: &mut rank,
        })
    } else {
        base_candidates
    };

    let selected = match candidates.into_iter().next() {
        Some(endpoint) => Some(endpoint),
        None => make_all_unplaced_fallback_endpoint(
            input.sheet,
            input.prepared_pieces,
            &areas_by_piece_id,
            &mut cavity_cache,
        ),
    };
    let Some(selected) = selected else {
        return Err(CapacitySearchError::Capacity(IntrinsicCapacityError {
            operation: "capacitySettlement".to_string(),
            message: "capacity mode could not settle any exact partial endpoint.".to_string(),
        }));
    };
    if !intrinsic_capacity_endpoint_partitions_request(
        &selected.placed_prepared_ids,
        &selected.unplaced_prepared_ids,
        &prepared_ids,
    ) {
        return Err(CapacitySearchError::Capacity(IntrinsicCapacityError {
            operation: "capacityPartition".to_string(),
            message: "settled capacity endpoint does not exactly partition the prepared request."
                .to_string(),
        }));
    }

    let prefix_incumbent =
        terminalization
            .incumbent
            .as_ref()
            .map(|incumbent| IntrinsicCapacityIncumbentTrace {
                source_role: incumbent.source_role.clone(),
                prefix_depth: incumbent.prefix_depth,
                placed_count: incumbent.metrics.placed_count,
                placed_material_area_mm2: incumbent.metrics.placed_material_area_mm2,
                selected_rotation_deg: incumbent.selected_rotation_deg,
                canonical_geometry_hash: incumbent.canonical_geometry_hash.clone(),
            });

    let quality_warm_prefix_trace = coordinated.as_ref().map(|c| {
        let mut trace = c.quality_warm_prefix.clone();
        trace.output_influence = if quality_improves_placed_count
            && quality_endpoint.as_ref().is_some_and(|endpoint| {
                endpoint.canonical_geometry_hash == selected.canonical_geometry_hash
            }) {
            QualityWarmPrefixOutputInfluence::StrictCountImprovement
        } else {
            QualityWarmPrefixOutputInfluence::None
        };
        trace
    });

    let selected_objective = intrinsic_capacity_objective(&selected);
    let trace = IntrinsicCapacityTrace {
        routing: input.routing,
        preflight: input.preflight.clone(),
        prefixes: IntrinsicCapacityPrefixTrace {
            captured_count: terminalization.captured_count,
            fitting_count: terminalization.fitting_count,
            rejected_count: terminalization.rejected_count,
            terminalized_count: terminalization.endpoints.len() as f64,
            descriptors: descriptors
                .iter()
                .map(|descriptor| IntrinsicCapacityPrefixDescriptorSummary {
                    role: descriptor.role.as_str().to_string(),
                    depth: descriptor.depth,
                })
                .collect(),
        },
        prefix_incumbent,
        cold_search: cold_search.trace.clone(),
        warm_prefix_lanes,
        warm_prefix_endpoints_admitted: input.admit_warm_prefix_endpoints,
        cohesion_shadow: cohesion_shadow.as_ref().map(|shadow| shadow.trace.clone()),
        quality_warm_prefix: quality_warm_prefix_trace,
        lane_coordinator: coordinated.as_ref().map(|c| c.trace.clone()),
        selected: IntrinsicCapacitySelectionTrace {
            unplaced_count: selected.unplaced_prepared_ids.len() as f64,
            placed_material_area_mm2: selected.metrics.placed_material_area_mm2,
            selected_rotation_deg: selected.selected_rotation_deg,
            objective: selected_objective,
        },
        preflight_runtime_ms: input.preflight_runtime_ms,
        complete_archive_runtime_ms: input.complete_archive_runtime_ms,
        prefix_terminalization_ms,
        cold_search_ms,
        runtime_ms: js_math::max(0.0, started_at.elapsed().as_secs_f64() * 1000.0),
    };

    Ok(IntrinsicCapacityModeResult {
        phase_timings: cold_search.phase_timings,
        endpoint: selected,
        trace,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_gate_admits_only_a_strict_placed_count_improvement() {
        assert!(intrinsic_capacity_quality_strictly_improves_placed_count(
            Some(18.0),
            Some(17.0)
        ));
        assert!(!intrinsic_capacity_quality_strictly_improves_placed_count(
            Some(17.0),
            Some(17.0)
        ));
        assert!(!intrinsic_capacity_quality_strictly_improves_placed_count(
            Some(16.0),
            Some(17.0)
        ));
        assert!(!intrinsic_capacity_quality_strictly_improves_placed_count(
            None,
            Some(17.0)
        ));
        // Missing incumbent placed count treated as 0.
        assert!(intrinsic_capacity_quality_strictly_improves_placed_count(
            Some(1.0),
            None
        ));
    }

    fn cold_quantum(
        ordinal: f64,
        from: f64,
        to: f64,
        delta: f64,
    ) -> IntrinsicCapacityLaneCoordinatorQuantum {
        IntrinsicCapacityLaneCoordinatorQuantum {
            ordinal,
            producer_role: LaneCoordinatorQuantumProducerRole::CapacityCold,
            source_role: None,
            prefix_depth: None,
            phase: LaneCoordinatorQuantumPhase::Initial,
            from_depth: from,
            to_depth: to,
            placement_evaluation_delta: delta,
            outcome: LaneCoordinatorQuantumOutcome::Settled,
        }
    }

    fn base_lane_coordinator_trace(
        aggregate_placement_evaluation_cap: f64,
        aggregate_consumed_placement_evaluations: f64,
        quanta: Vec<IntrinsicCapacityLaneCoordinatorQuantum>,
    ) -> IntrinsicCapacityLaneCoordinatorTrace {
        IntrinsicCapacityLaneCoordinatorTrace {
            version: INTRINSIC_CAPACITY_LANE_COORDINATOR_TRACE_VERSION,
            aggregate_placement_evaluation_cap,
            aggregate_consumed_placement_evaluations,
            warm_pilot_depth_boundaries: INTRINSIC_CAPACITY_WARM_PILOT_DEPTH_BOUNDARIES,
            continued_producers: Vec::new(),
            retained_checkpoint_count: 0.0,
            censored_lane_count: 0.0,
            quanta,
        }
    }

    #[test]
    fn trace_valid_accepts_a_minimal_cold_only_trace() {
        let trace =
            base_lane_coordinator_trace(100.0, 10.0, vec![cold_quantum(0.0, 0.0, 5.0, 10.0)]);
        assert!(intrinsic_capacity_lane_coordinator_trace_valid(
            &trace,
            &[],
            None
        ));
    }

    #[test]
    fn trace_valid_rejects_exceeding_the_aggregate_cap() {
        let trace = base_lane_coordinator_trace(5.0, 10.0, vec![cold_quantum(0.0, 0.0, 5.0, 10.0)]);
        assert!(!intrinsic_capacity_lane_coordinator_trace_valid(
            &trace,
            &[],
            None
        ));
    }

    #[test]
    fn trace_valid_rejects_a_missing_cold_lane() {
        let trace = base_lane_coordinator_trace(100.0, 0.0, vec![]);
        assert!(!intrinsic_capacity_lane_coordinator_trace_valid(
            &trace,
            &[],
            None
        ));
    }

    #[test]
    fn trace_valid_rejects_a_mismatched_evaluation_sum() {
        let mut trace =
            base_lane_coordinator_trace(100.0, 999.0, vec![cold_quantum(0.0, 0.0, 5.0, 10.0)]);
        assert!(!intrinsic_capacity_lane_coordinator_trace_valid(
            &trace,
            &[],
            None
        ));
        trace.aggregate_consumed_placement_evaluations = 10.0;
        assert!(intrinsic_capacity_lane_coordinator_trace_valid(
            &trace,
            &[],
            None
        ));
    }

    #[test]
    fn trace_valid_validates_a_warm_lane_chain() {
        let cold = cold_quantum(0.0, 0.0, 5.0, 10.0);
        let warm_initial = IntrinsicCapacityLaneCoordinatorQuantum {
            ordinal: 1.0,
            producer_role: LaneCoordinatorQuantumProducerRole::CapacityWarmPrefix,
            source_role: Some("canonical-grid".to_string()),
            prefix_depth: Some(3.0),
            phase: LaneCoordinatorQuantumPhase::Initial,
            from_depth: 0.0,
            to_depth: 3.0,
            placement_evaluation_delta: 20.0,
            outcome: LaneCoordinatorQuantumOutcome::Settled,
        };
        let trace = base_lane_coordinator_trace(100.0, 30.0, vec![cold, warm_initial]);
        let warm_lanes = vec![IntrinsicCapacityWarmPrefixLaneTrace {
            source_role: "canonical-grid".to_string(),
            prefix_depth: 3.0,
            reused_placed_count: 0.0,
            status: WarmPrefixLaneStatus::Settled,
            selected_for_continuation: false,
            checkpoint_retained: false,
            consumed_placement_evaluations: 20.0,
            completed_depths: 3.0,
            elapsed_ms: 0.0,
            endpoint: None,
        }];
        assert!(intrinsic_capacity_lane_coordinator_trace_valid(
            &trace,
            &warm_lanes,
            None
        ));

        // A wrong `completedDepths` must fail.
        let mut bad_lanes = warm_lanes.clone();
        bad_lanes[0].completed_depths = 4.0;
        assert!(!intrinsic_capacity_lane_coordinator_trace_valid(
            &trace, &bad_lanes, None
        ));
    }

    #[test]
    fn select_warm_settlement_lane_prefers_deepest_then_source_priority() {
        let lanes = vec![
            WarmSettlementLaneView {
                role: ProtectedCapacityLaneRole::CapacityWarmPrefix,
                is_paused_with_checkpoint: true,
                has_first_endpoint: true,
                source_role: Some("legacy-absolute-envelope".to_string()),
                prefix_depth: Some(5.0),
            },
            WarmSettlementLaneView {
                role: ProtectedCapacityLaneRole::CapacityWarmPrefix,
                is_paused_with_checkpoint: true,
                has_first_endpoint: true,
                source_role: Some("canonical-grid".to_string()),
                prefix_depth: Some(5.0),
            },
            WarmSettlementLaneView {
                role: ProtectedCapacityLaneRole::CapacityWarmPrefix,
                is_paused_with_checkpoint: true,
                has_first_endpoint: true,
                source_role: Some("open-pocket-first".to_string()),
                prefix_depth: Some(7.0),
            },
        ];
        // Index 2 is deepest (prefixDepth 7), so it wins outright even
        // though it is not the highest-priority source role.
        assert_eq!(select_protected_warm_settlement_lane(&lanes), Some(2));
    }

    #[test]
    fn select_warm_settlement_lane_returns_none_without_eligible_candidates() {
        let lanes = vec![WarmSettlementLaneView {
            role: ProtectedCapacityLaneRole::CapacityCold,
            is_paused_with_checkpoint: true,
            has_first_endpoint: true,
            source_role: None,
            prefix_depth: None,
        }];
        assert_eq!(select_protected_warm_settlement_lane(&lanes), None);
    }

    #[test]
    fn base_placement_evaluation_cap_uses_the_floor_when_piece_count_is_small() {
        assert_eq!(
            base_placement_evaluation_cap(2.0, 50_000.0, 4_096.0),
            50_000.0
        );
        assert_eq!(
            base_placement_evaluation_cap(20.0, 50_000.0, 4_096.0),
            81_920.0
        );
    }

    #[test]
    fn all_unplaced_fallback_endpoint_reports_every_piece_unplaced() {
        use crate::domain::{
            CollisionGeometry, DxfGeometryEntityType, DxfGeometrySummary, ImportedPiece,
            IrregularBounds, IrregularPoint, IrregularPolygon, IrregularTransformCandidate,
            IrregularTransformReason, Rect, SourceFileId,
        };

        fn square(side: f64) -> IrregularPolygon {
            IrregularPolygon::new(vec![
                IrregularPoint::new(0.0, 0.0),
                IrregularPoint::new(side, 0.0),
                IrregularPoint::new(side, side),
                IrregularPoint::new(0.0, side),
            ])
        }

        let shape = square(10.0);
        let piece = Arc::new(IrregularPreparedPiece {
            piece_id: Some(PieceId::new("piece-1")),
            interchangeability_key: None,
            source: ImportedPiece {
                id: PieceId::new("piece-1"),
                source_file_id: SourceFileId::new("source-1"),
                source_layer: None,
                label: "piece-1".to_string(),
                real_bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
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
                source_piece_id: PieceId::new("piece-1"),
                source_bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
                sampled_points: shape.points.clone(),
                convex_hull: shape.clone(),
                collision_polygon: shape,
                placement_reference: IrregularPoint::new(0.0, 0.0),
                diagnostics: vec![],
            },
            transforms: vec![IrregularTransformCandidate {
                index: 0.0,
                rotation_deg: 0.0,
                mirrored: false,
                reason: IrregularTransformReason::Orthogonal,
            }],
            priority_order_key: None,
        });
        let sheet = SheetSpec {
            width: 1000.0,
            height: 800.0,
            label: "test".to_string(),
        };
        let materials: HashMap<PieceId, BigInt> = HashMap::new();
        let mut cache = IntrinsicCapacityCavityCache::new();
        let endpoint =
            make_all_unplaced_fallback_endpoint(&sheet, &[piece], &materials, &mut cache)
                .expect("fallback endpoint materializes");
        assert_eq!(endpoint.placed_prepared_ids, Vec::<PieceId>::new());
        assert_eq!(
            endpoint.unplaced_prepared_ids,
            vec![PieceId::new("piece-1")]
        );
    }
}
