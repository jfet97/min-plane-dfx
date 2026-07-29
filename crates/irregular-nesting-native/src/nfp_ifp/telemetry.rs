//! Opt-in, observational-only counters for the candidate-generation path.
//!
//! TS source: `src/workers/irregular/nfpIfpTelemetry.ts` (237 lines), read
//! in full. Self-documented there as never influencing control flow or
//! canonical output (`nfpIfpTelemetry.ts:1-15`); `nfp-ifp.md` §1/§13.7
//! confirm this module is "live but semantically inert" and that its counts
//! are compared only as measurements, never as parity fields.
//!
//! # Cache-namespace counters are NOT re-ported here
//!
//! TS's `NfpIfpTelemetrySnapshot` also carries per-namespace `GeometryCache`
//! counters (`cacheInstances`, `namespaces: Record<string,
//! NfpIfpCacheNamespaceCounters>`). In TS these are populated by
//! `geometryCacheStoreLive.ts` calling `NfpIfpTelemetry.recordCacheGet`/
//! `recordCacheSet`/`recordCacheRemove`/`recordCacheInstance` on every store
//! action — `nfpIfpService.ts` itself never calls those four recorders
//! directly (only `recordMemoBypass`/`recordMemoRequest`/`recordMemoRestore`/
//! `recordCheckpoint`, confirmed by direct read of `nfpIfpService.ts`'s only
//! `NfpIfpTelemetry.*` call sites). The Rust equivalent of that
//! store-side wiring already exists and is owned by `caches`
//! ([`crate::caches::CacheTelemetrySnapshot`], populated automatically by
//! every [`crate::caches::GeometryCacheStore`] action) — this module does
//! not duplicate it. This struct carries only the two counter families this
//! cluster's own code actually populates: the legal-candidate memo counters
//! and the cancellation-checkpoint counters.
//!
//! # No global mutable state
//!
//! TS models this as a module-level `enableNfpIfpTelemetry()`/
//! `disableNfpIfpTelemetry()`/`nfpIfpTelemetrySnapshot()` triple over one
//! `let state: MutableState | undefined` binding — a single-process-wide
//! opt-in singleton, safe only because Node's worker-per-job model never
//! shares that binding across jobs. This crate has no equivalent shared
//! mutable global to reuse safely across concurrent/parallel jobs (a design
//! goal this port must not regress ahead of Stage 3/4), so
//! [`NfpIfpTelemetry`] is instead an ordinary owned value threaded through as
//! `Option<&mut NfpIfpTelemetry>`: `None` reproduces TS's "disabled" state
//! (every recorder becomes a no-op, matching the TS module doc's own
//! "allocates nothing" guarantee) and `Some(&mut telemetry)` reproduces the
//! "enabled" state, scoped to exactly the caller that opted in rather than a
//! process-wide singleton.

use std::collections::BTreeMap;

/// TS: `nfpIfpTelemetry.ts:78-93` (`MutableState['memo']`,
/// `NfpIfpMemoCounters`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct NfpIfpMemoCounters {
    /// Calls that skipped the memo because the caller supplied no scope.
    pub bypasses: u64,
    /// Calls that consulted the memo.
    pub requests: u64,
    /// Consultations served from the memo.
    pub hits: u64,
    /// Consultations that found no entry at all.
    pub misses: u64,
    /// Consultations that found an entry but re-computed because provenance
    /// was wanted (`nfp-ifp.md` §9.C item 5).
    pub provenance_misses: u64,
    /// Memo hits that rebuilt candidate objects.
    pub restore_calls: u64,
    /// Candidate objects rebuilt across every memo hit.
    pub restored_candidates: u64,
}

/// TS: `nfpIfpTelemetry.ts:208-214` (`recordMemoRequest`'s `outcome`
/// parameter).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoRequestOutcome {
    Hit,
    Miss,
    ProvenanceMiss,
}

/// TS: `services.ts:78-83` (`IrregularNfpIfpCheckpointPhase`). Duplicated as
/// a Rust enum here (rather than reused from `super::service`, which does
/// not itself need a string-keyed counter map) purely so this module's
/// `checkpoints_by_phase` map has a stable string key matching the TS phase
/// literal exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum NfpIfpCheckpointPhase {
    Ifp,
    PlacedNfp,
    IfpBoundaryIntersection,
    PairwiseNfpBoundaryIntersection,
    CandidatePoints,
}

impl NfpIfpCheckpointPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            NfpIfpCheckpointPhase::Ifp => "ifp",
            NfpIfpCheckpointPhase::PlacedNfp => "placed-nfp",
            NfpIfpCheckpointPhase::IfpBoundaryIntersection => "ifp-boundary-intersection",
            NfpIfpCheckpointPhase::PairwiseNfpBoundaryIntersection => {
                "pairwise-nfp-boundary-intersection"
            }
            NfpIfpCheckpointPhase::CandidatePoints => "candidate-points",
        }
    }
}

/// TS: `nfpIfpTelemetry.ts:224-227` (`recordCheckpoint`'s `outcome`
/// parameter).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointOutcome {
    /// No control was supplied; the checkpoint is an immediate no-op.
    Inert,
    /// A control was supplied and its checkpoint returned the shared
    /// "always succeeds immediately" value.
    DirectVoid,
    /// A control was supplied and its checkpoint returned some other
    /// (possibly suspending/failing) computation.
    Composed,
}

/// TS: `nfpIfpTelemetry.ts:76-93` (`MutableState['checkpointsByPhase'
/// | 'checkpointsLive' | 'checkpointsInert' | 'checkpointsDirectVoid' |
/// 'checkpointsComposed']`, aggregated into `NfpIfpCheckpointCounters` at
/// snapshot time, `nfpIfpTelemetry.ts:48-59`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NfpIfpCheckpointCounters {
    /// Checkpoints reached, by phase.
    pub by_phase: BTreeMap<&'static str, u64>,
    /// Checkpoints that had a control to poll.
    pub live: u64,
    /// Checkpoints that had no control and were therefore inert.
    pub inert: u64,
    /// Live controls that returned the shared "always succeeds" value
    /// directly.
    pub direct_void: u64,
    /// Live controls that returned another effect, including composed
    /// checks.
    pub composed: u64,
}

/// TS: `nfpIfpTelemetry.ts:61-67` (`NfpIfpTelemetrySnapshot`), narrowed per
/// this module's top-level doc to the two counter families this cluster's
/// own code populates (memo + checkpoints); cache-namespace counters live in
/// `caches::CacheTelemetrySnapshot`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NfpIfpTelemetry {
    pub memo: NfpIfpMemoCounters,
    pub checkpoints: NfpIfpCheckpointCounters,
}

impl NfpIfpTelemetry {
    pub fn new() -> Self {
        Self::default()
    }

    /// TS: `nfpIfpTelemetry.ts:197-201` (`recordMemoBypass`).
    pub fn record_memo_bypass(&mut self) {
        self.memo.bypasses += 1;
    }

    /// TS: `nfpIfpTelemetry.ts:203-214` (`recordMemoRequest`). A
    /// consultation that found an entry but still recomputed because the
    /// caller wanted provenance counts as a provenance miss, which is
    /// otherwise indistinguishable from a plain miss.
    pub fn record_memo_request(&mut self, outcome: MemoRequestOutcome) {
        self.memo.requests += 1;
        match outcome {
            MemoRequestOutcome::Hit => self.memo.hits += 1,
            MemoRequestOutcome::Miss => self.memo.misses += 1,
            MemoRequestOutcome::ProvenanceMiss => self.memo.provenance_misses += 1,
        }
    }

    /// TS: `nfpIfpTelemetry.ts:216-221` (`recordMemoRestore`).
    pub fn record_memo_restore(&mut self, count: u64) {
        self.memo.restore_calls += 1;
        self.memo.restored_candidates += count;
    }

    /// TS: `nfpIfpTelemetry.ts:223-237` (`recordCheckpoint`).
    pub fn record_checkpoint(&mut self, phase: NfpIfpCheckpointPhase, outcome: CheckpointOutcome) {
        *self.checkpoints.by_phase.entry(phase.as_str()).or_insert(0) += 1;
        match outcome {
            CheckpointOutcome::Inert => self.checkpoints.inert += 1,
            CheckpointOutcome::DirectVoid => {
                self.checkpoints.live += 1;
                self.checkpoints.direct_void += 1;
            }
            CheckpointOutcome::Composed => {
                self.checkpoints.live += 1;
                self.checkpoints.composed += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_memo_bypass_increments_only_bypasses() {
        let mut telemetry = NfpIfpTelemetry::new();
        telemetry.record_memo_bypass();
        telemetry.record_memo_bypass();
        assert_eq!(telemetry.memo.bypasses, 2);
        assert_eq!(telemetry.memo.requests, 0);
    }

    #[test]
    fn record_memo_request_splits_outcomes_correctly() {
        let mut telemetry = NfpIfpTelemetry::new();
        telemetry.record_memo_request(MemoRequestOutcome::Hit);
        telemetry.record_memo_request(MemoRequestOutcome::Miss);
        telemetry.record_memo_request(MemoRequestOutcome::ProvenanceMiss);
        assert_eq!(telemetry.memo.requests, 3);
        assert_eq!(telemetry.memo.hits, 1);
        assert_eq!(telemetry.memo.misses, 1);
        assert_eq!(telemetry.memo.provenance_misses, 1);
    }

    #[test]
    fn record_memo_restore_accumulates_candidate_counts_across_calls() {
        let mut telemetry = NfpIfpTelemetry::new();
        telemetry.record_memo_restore(3);
        telemetry.record_memo_restore(5);
        assert_eq!(telemetry.memo.restore_calls, 2);
        assert_eq!(telemetry.memo.restored_candidates, 8);
    }

    #[test]
    fn record_checkpoint_tracks_phase_live_inert_direct_void_and_composed() {
        let mut telemetry = NfpIfpTelemetry::new();
        telemetry.record_checkpoint(NfpIfpCheckpointPhase::Ifp, CheckpointOutcome::Inert);
        telemetry.record_checkpoint(NfpIfpCheckpointPhase::Ifp, CheckpointOutcome::DirectVoid);
        telemetry.record_checkpoint(
            NfpIfpCheckpointPhase::PlacedNfp,
            CheckpointOutcome::Composed,
        );

        assert_eq!(telemetry.checkpoints.by_phase.get("ifp"), Some(&2));
        assert_eq!(telemetry.checkpoints.by_phase.get("placed-nfp"), Some(&1));
        assert_eq!(telemetry.checkpoints.inert, 1);
        assert_eq!(telemetry.checkpoints.live, 2);
        assert_eq!(telemetry.checkpoints.direct_void, 1);
        assert_eq!(telemetry.checkpoints.composed, 1);
    }

    #[test]
    fn checkpoint_phase_as_str_matches_ts_literals() {
        assert_eq!(NfpIfpCheckpointPhase::Ifp.as_str(), "ifp");
        assert_eq!(NfpIfpCheckpointPhase::PlacedNfp.as_str(), "placed-nfp");
        assert_eq!(
            NfpIfpCheckpointPhase::IfpBoundaryIntersection.as_str(),
            "ifp-boundary-intersection"
        );
        assert_eq!(
            NfpIfpCheckpointPhase::PairwiseNfpBoundaryIntersection.as_str(),
            "pairwise-nfp-boundary-intersection"
        );
        assert_eq!(
            NfpIfpCheckpointPhase::CandidatePoints.as_str(),
            "candidate-points"
        );
    }
}
