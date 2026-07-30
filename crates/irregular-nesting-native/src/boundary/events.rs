//! Streamed event delivery: an [`IrregularComputeEventSink`] implementation
//! that forwards portfolio progress and state snapshots to JS through
//! `ThreadsafeFunction` callbacks supplied to `runIrregularJob`.
//!
//! TS counterpart / design source: `native-boundary.md` §10-§11. Every call
//! here happens on the job's single coordinating thread (the napi
//! `AsyncTask::compute` libuv worker thread `boundary::job` runs the whole
//! job on) -- never from a Rayon worker (this crate has no Rayon dependency
//! yet; Stage 3/4 concern, migration prompt §7/§15). Calls are always
//! `ThreadsafeFunctionCallMode::NonBlocking` and their `Status` return value
//! is deliberately ignored: delivery failure (e.g. the JS side has already
//! begun tearing down) must never fail or slow the job, mirroring
//! `nesting.worker.ts`'s own `send(...)` `Effect.catchCause(() =>
//! Effect.void)` swallow pattern (native-boundary.md §10.1).
//!
//! # Ordinal
//!
//! `native-boundary.md` §10 requires "events carry an ordinal so TS can
//! assert exact logical order." This sink uses one monotonic `u64` counter
//! shared across *both* channels (portfolio progress and state snapshots),
//! not one counter per channel: a single shared counter gives TS the
//! strongest possible ordering assertion (a total order across every event
//! this job ever emits), and is trivially correct to implement given both
//! channels are only ever driven from this one coordinator thread in
//! program order.

use napi::bindgen_prelude::Unknown;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;

use crate::result::progress::IrregularComputeEventSink;
use crate::result::{IrregularPortfolioProgress, IrregularStateSnapshot};

use super::result::{project_state_snapshot, NativeIrregularPortfolioProgress};

/// `T = String` (a JSON payload), `Args = String` (what the JS callback
/// receives), `Return = Unknown<'static>` (the callback's return value is
/// never read -- see this module's top doc on the swallow pattern).
pub type JsonEventFn =
    ThreadsafeFunction<String, Unknown<'static>, String, Status, false, false, 0>;

pub struct BoundaryEventSink<'a> {
    ordinal: u64,
    on_portfolio_progress: &'a JsonEventFn,
    on_state_snapshot: Option<&'a JsonEventFn>,
}

impl<'a> BoundaryEventSink<'a> {
    pub fn new(
        on_portfolio_progress: &'a JsonEventFn,
        on_state_snapshot: Option<&'a JsonEventFn>,
    ) -> Self {
        Self {
            ordinal: 0,
            on_portfolio_progress,
            on_state_snapshot,
        }
    }

    fn next_ordinal(&mut self) -> u64 {
        let ordinal = self.ordinal;
        self.ordinal += 1;
        ordinal
    }
}

#[derive(serde::Serialize)]
struct OrdinalPortfolioProgress {
    ordinal: u64,
    #[serde(flatten)]
    progress: NativeIrregularPortfolioProgress,
}

impl IrregularComputeEventSink for BoundaryEventSink<'_> {
    fn emit_state_snapshot(&mut self, snapshot: &IrregularStateSnapshot, _beam_width: f64) {
        let Some(tsfn) = self.on_state_snapshot else {
            return;
        };
        let ordinal = self.next_ordinal();
        let dto = project_state_snapshot(snapshot, ordinal);
        let json = serde_json::to_string(&dto).expect("state snapshot always serializes");
        tsfn.call(json, ThreadsafeFunctionCallMode::NonBlocking);
    }

    fn emit_portfolio_progress(&mut self, progress: &IrregularPortfolioProgress) {
        let ordinal = self.next_ordinal();
        let payload = OrdinalPortfolioProgress {
            ordinal,
            progress: NativeIrregularPortfolioProgress::from(progress),
        };
        let json = serde_json::to_string(&payload).expect("portfolio progress always serializes");
        self.on_portfolio_progress
            .call(json, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::result::IrregularPortfolioPhase;

    #[test]
    fn ordinal_portfolio_progress_flattens_and_stamps_ordinal() {
        let progress = IrregularPortfolioProgress {
            phase: IrregularPortfolioPhase::SharedArchive,
            best_score: None,
            elapsed_ms: 12.5,
            decode_role: None,
        };
        let payload = OrdinalPortfolioProgress {
            ordinal: 3,
            progress: NativeIrregularPortfolioProgress::from(&progress),
        };
        let json = serde_json::to_string(&payload).expect("serializes");
        assert_eq!(
            json,
            r#"{"ordinal":3,"phase":"shared_archive","elapsedMs":12.5}"#
        );
    }
}
