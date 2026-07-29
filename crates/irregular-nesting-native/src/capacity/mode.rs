//! Capacity-mode wiring: trace chronology validation, the quality-admission
//! gate, the warm-lane tie-break rule, the all-unplaced fallback endpoint,
//! and the scheduler evaluation-cap arithmetic.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicCapacityMode.ts`
//! (1430 lines). Read together with
//! `docs/planning/rust-irregular-backend/characterization/capacity-core.md`
//! before touching this file.
//!
//! # Scope of this port: self-contained pure pieces only
//!
//! `intrinsicCapacityMode.ts`'s top-level orchestration
//! (`runIntrinsicCapacityMode`, `runProtectedCapacityLaneCoordinator`,
//! `runIntrinsicCapacitySchedulerColdQuantum`,
//! `runIntrinsicCapacityCohesionShadow`) all call
//! `runIntrinsicCapacityColdSearch`/`materializeIntrinsicCapacityCheckpointEndpoints`
//! (`intrinsicCapacitySearch.ts`, 2272 lines) and consume
//! `IntrinsicCapacityPrefixSource`/`captureIntrinsicCapacityPrefixDescriptors`/
//! `terminalizeIntrinsicCapacityPrefixEndpoints`
//! (`intrinsicCapacityPrefixes.ts`, 158 lines). Both of those modules are
//! `capacity::search`/`capacity::prefixes` -- **not this task's assignment**
//! (the task brief names only `preflight.rs`/`material.rs`/`endpoint.rs`/
//! `mode.rs`/`telemetry.rs`), and both are still `// Reserved for the Stage 2
//! port` stubs owned by a concurrently-running task at the time this file
//! was written. Porting the full 1430-line orchestration against an API that
//! does not exist yet would mean guessing that API's shape -- exactly what
//! this crate's file-ownership discipline exists to prevent.
//!
//! What this file ports instead, in full and byte-exact, is every piece of
//! `intrinsicCapacityMode.ts` that does **not** depend on the search/prefix
//! engine's own result types:
//! - [`intrinsic_capacity_quality_strictly_improves_placed_count`] -- the
//!   quality-warm-prefix admission gate (`intrinsicCapacityMode.ts:335-343`).
//! - [`IntrinsicCapacityLaneCoordinatorTrace`]/
//!   [`IntrinsicCapacityWarmPrefixLaneTrace`]/
//!   [`IntrinsicCapacityQualityWarmPrefixTrace`] and
//!   [`intrinsic_capacity_lane_coordinator_trace_valid`] -- the chronology
//!   self-check (`intrinsicCapacityMode.ts:200-327`), a **pure structural
//!   validator** over trace values a caller constructs -- it needs no live
//!   search engine to run or to be differentially vector-tested.
//! - [`INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS`] (`:383`).
//! - [`base_placement_evaluation_cap`] -- the pure
//!   `Math.max(minimumPlacementEvaluationCap, preparedPieces.length *
//!   placementEvaluationQuotaPerDepth)` arithmetic (`:490-494`), extracted as
//!   a function of its two bound inputs rather than hardcoding
//!   `INTRINSIC_CAPACITY_V1_BOUNDS`'s literal values (that constant is
//!   `capacity::search`'s to define; duplicating its literals here would
//!   create exactly the kind of silent-drift hazard ruling R4 warns about).
//! - [`select_protected_warm_settlement_lane`] -- the fixed
//!   `sourcePriority` deepest-lane tie-break (`:1046-1075`), ported against
//!   the [`WarmSettlementLaneView`] seam type (established pattern: see
//!   `search::layout_scorer`'s `LayoutScorerBeamStateView` doc) carrying
//!   exactly the fields this rule reads from `ProtectedCapacityLane` (a
//!   `capacity::search`-adjacent type this task does not own).
//! - [`make_all_unplaced_fallback_endpoint`] -- `makeAllUnplacedFallbackEndpoint`
//!   (`:1417-1430`), fully portable since its only dependencies
//!   (`IrregularBeamState::empty`, `materialize_intrinsic_capacity_endpoint`)
//!   are both already-ported GREEN modules.
//!
//! Trace-shape structs here intentionally omit every field the ported
//! functions never read (fixed literal `version`/`producerRole`/`policy`
//! tags, `continuedProducers`, `retainedCheckpointCount`,
//! `censoredLaneCount`, `warmPilotDepthBoundaries`) -- adding those back is
//! purely mechanical once the full orchestration lands and is explicitly
//! left to that follow-up rather than guessed at here.

use std::collections::HashMap;
use std::sync::Arc;

use num_bigint::BigInt;

use crate::domain::{IrregularPreparedPiece, PieceId, SheetSpec};
use crate::js_number::{js_math, number_to_js_string};
use crate::search::beam_state::IrregularBeamState;

use super::endpoint::{
    materialize_intrinsic_capacity_endpoint, IntrinsicCapacityCavityCache,
    IntrinsicCapacityEndpoint, IntrinsicCapacityEndpointOrigin, IntrinsicCapacityObjective,
    MaterializeIntrinsicCapacityEndpointInput,
};
use super::material::intrinsic_capacity_prepared_piece_id;

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

/// TS: `intrinsicCapacityMode.ts:82-93` `IntrinsicCapacityWarmPrefixLaneTrace`
/// (fields this module's validator reads only; see this module's top doc).
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicCapacityWarmPrefixLaneTrace {
    pub source_role: String,
    pub prefix_depth: f64,
    pub status: WarmPrefixLaneStatus,
    pub consumed_placement_evaluations: f64,
    pub completed_depths: f64,
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

/// TS: `intrinsicCapacityMode.ts:108-130` `IntrinsicCapacityQualityWarmPrefixTrace`
/// (fields this module's validator reads only; see this module's top doc).
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicCapacityQualityWarmPrefixTrace {
    pub status: QualityWarmPrefixStatus,
    pub source_role: Option<String>,
    pub prefix_depth: Option<f64>,
    pub consumed_placement_evaluations: f64,
    pub completed_depths: f64,
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

/// TS: `intrinsicCapacityMode.ts:162` `phase: 'initial' | 'resume' | 'censor'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaneCoordinatorQuantumPhase {
    Initial,
    Resume,
    Censor,
}

/// TS: `intrinsicCapacityMode.ts:166` `outcome: 'checkpointed' | 'settled' | 'censored'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaneCoordinatorQuantumOutcome {
    Checkpointed,
    Settled,
    Censored,
}

/// TS: `intrinsicCapacityMode.ts:154-167`
/// `IntrinsicCapacityLaneCoordinatorTrace['quanta'][number]`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicCapacityLaneCoordinatorQuantum {
    pub ordinal: f64,
    pub producer_role: LaneCoordinatorQuantumProducerRole,
    pub source_role: Option<String>,
    pub prefix_depth: Option<f64>,
    pub phase: LaneCoordinatorQuantumPhase,
    pub from_depth: f64,
    pub to_depth: f64,
    pub placement_evaluation_delta: f64,
    pub outcome: LaneCoordinatorQuantumOutcome,
}

/// TS: `intrinsicCapacityMode.ts:132-168` `IntrinsicCapacityLaneCoordinatorTrace`
/// (fields this module's validator reads only; see this module's top doc).
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicCapacityLaneCoordinatorTrace {
    pub aggregate_placement_evaluation_cap: f64,
    pub aggregate_consumed_placement_evaluations: f64,
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

    #[test]
    fn trace_valid_accepts_a_minimal_cold_only_trace() {
        let trace = IntrinsicCapacityLaneCoordinatorTrace {
            aggregate_placement_evaluation_cap: 100.0,
            aggregate_consumed_placement_evaluations: 10.0,
            quanta: vec![cold_quantum(0.0, 0.0, 5.0, 10.0)],
        };
        assert!(intrinsic_capacity_lane_coordinator_trace_valid(
            &trace,
            &[],
            None
        ));
    }

    #[test]
    fn trace_valid_rejects_exceeding_the_aggregate_cap() {
        let trace = IntrinsicCapacityLaneCoordinatorTrace {
            aggregate_placement_evaluation_cap: 5.0,
            aggregate_consumed_placement_evaluations: 10.0,
            quanta: vec![cold_quantum(0.0, 0.0, 5.0, 10.0)],
        };
        assert!(!intrinsic_capacity_lane_coordinator_trace_valid(
            &trace,
            &[],
            None
        ));
    }

    #[test]
    fn trace_valid_rejects_a_missing_cold_lane() {
        let trace = IntrinsicCapacityLaneCoordinatorTrace {
            aggregate_placement_evaluation_cap: 100.0,
            aggregate_consumed_placement_evaluations: 0.0,
            quanta: vec![],
        };
        assert!(!intrinsic_capacity_lane_coordinator_trace_valid(
            &trace,
            &[],
            None
        ));
    }

    #[test]
    fn trace_valid_rejects_a_mismatched_evaluation_sum() {
        let mut trace = IntrinsicCapacityLaneCoordinatorTrace {
            aggregate_placement_evaluation_cap: 100.0,
            aggregate_consumed_placement_evaluations: 999.0,
            quanta: vec![cold_quantum(0.0, 0.0, 5.0, 10.0)],
        };
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
        let trace = IntrinsicCapacityLaneCoordinatorTrace {
            aggregate_placement_evaluation_cap: 100.0,
            aggregate_consumed_placement_evaluations: 30.0,
            quanta: vec![cold, warm_initial],
        };
        let warm_lanes = vec![IntrinsicCapacityWarmPrefixLaneTrace {
            source_role: "canonical-grid".to_string(),
            prefix_depth: 3.0,
            status: WarmPrefixLaneStatus::Settled,
            consumed_placement_evaluations: 20.0,
            completed_depths: 3.0,
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
