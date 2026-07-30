//! Unified streamed event delivery over one [`ThreadsafeFunction`] callback.
//!
//! Every event is produced on the job's single coordinator thread. The sink
//! owns the only ordinal sequence, including the terminal marker, and records
//! the first N-API delivery status failure for `boundary::job` to expose in its
//! final envelope after it has attempted terminal delivery.

use std::sync::mpsc::sync_channel;

use napi::bindgen_prelude::Unknown;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use serde::Serialize;

use crate::result::progress::IrregularComputeEventSink;
use crate::result::{IrregularPortfolioProgress, IrregularStateSnapshot};

use super::result::{
    project_state_snapshot, NativeIrregularPortfolioProgress, NativeStateSnapshot,
};

/// `T = String` (a JSON payload), `Args = String` (the JS callback's argument),
/// and `Return = Unknown<'static>` (the callback return is not consumed).
pub type JsonEventFn =
    ThreadsafeFunction<String, Unknown<'static>, String, Status, false, false, 0>;

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum NativeIrregularEvent {
    PortfolioProgress {
        ordinal: u64,
        progress: NativeIrregularPortfolioProgress,
    },
    StateSnapshot {
        ordinal: u64,
        snapshot: NativeStateSnapshot,
        beam_width: f64,
    },
    Terminal {
        ordinal: u64,
    },
}

pub struct BoundaryEventSink<'a> {
    next_ordinal: u64,
    terminal_emitted: bool,
    emit_state_snapshots: bool,
    on_event: &'a JsonEventFn,
    first_delivery_failure: Option<String>,
}

impl<'a> BoundaryEventSink<'a> {
    pub fn new(on_event: &'a JsonEventFn, emit_state_snapshots: bool) -> Self {
        Self {
            next_ordinal: 0,
            terminal_emitted: false,
            emit_state_snapshots,
            on_event,
            first_delivery_failure: None,
        }
    }

    pub fn emit_terminal_and_wait(&mut self) {
        if self.terminal_emitted {
            debug_assert!(false, "attempted to emit a native event after terminal");
            return;
        }
        self.terminal_emitted = true;
        let ordinal = self.take_ordinal();
        let json = serde_json::to_string(&NativeIrregularEvent::Terminal { ordinal })
            .expect("native terminal event always serializes");
        let (sender, receiver) = sync_channel(1);
        let status = self.on_event.call_with_return_value(
            json,
            ThreadsafeFunctionCallMode::NonBlocking,
            move |callback_result, _env| {
                let acknowledgement = callback_result
                    .map(|_| ())
                    .map_err(|error| format!("{:?}", error.status));
                let _ = sender.send(acknowledgement);
                Ok(())
            },
        );
        if status != Status::Ok {
            self.record_delivery_failure(format!("{status:?}"));
            return;
        }
        match receiver.recv() {
            Ok(Ok(())) => {}
            Ok(Err(status)) => self.record_delivery_failure(status),
            Err(_) => self.record_delivery_failure(format!("{:?}", Status::Closing)),
        }
    }

    pub fn first_delivery_failure(&self) -> Option<&str> {
        self.first_delivery_failure.as_deref()
    }

    fn take_ordinal(&mut self) -> u64 {
        let ordinal = self.next_ordinal;
        self.next_ordinal += 1;
        ordinal
    }

    fn send(&mut self, event: NativeIrregularEvent) {
        debug_assert!(
            !self.terminal_emitted,
            "attempted to emit a native event after terminal"
        );
        let json = serde_json::to_string(&event).expect("native irregular event always serializes");
        let status = self
            .on_event
            .call(json, ThreadsafeFunctionCallMode::NonBlocking);
        if status != Status::Ok {
            self.record_delivery_failure(format!("{status:?}"));
        }
    }

    fn record_delivery_failure(&mut self, failure: String) {
        if self.first_delivery_failure.is_none() {
            self.first_delivery_failure = Some(failure);
        }
    }
}

impl IrregularComputeEventSink for BoundaryEventSink<'_> {
    fn emit_state_snapshot(&mut self, snapshot: &IrregularStateSnapshot, beam_width: f64) {
        if !self.emit_state_snapshots || self.terminal_emitted {
            debug_assert!(
                !self.terminal_emitted,
                "attempted to emit a native event after terminal"
            );
            return;
        }
        let ordinal = self.take_ordinal();
        self.send(NativeIrregularEvent::StateSnapshot {
            ordinal,
            snapshot: project_state_snapshot(snapshot),
            beam_width,
        });
    }

    fn emit_portfolio_progress(&mut self, progress: &IrregularPortfolioProgress) {
        if self.terminal_emitted {
            debug_assert!(false, "attempted to emit a native event after terminal");
            return;
        }
        let ordinal = self.take_ordinal();
        self.send(NativeIrregularEvent::PortfolioProgress {
            ordinal,
            progress: NativeIrregularPortfolioProgress::from(progress),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::result::IrregularPortfolioPhase;

    #[test]
    fn progress_and_terminal_share_the_tagged_ordinal_sequence() {
        let progress = NativeIrregularEvent::PortfolioProgress {
            ordinal: 3,
            progress: NativeIrregularPortfolioProgress::from(&IrregularPortfolioProgress {
                phase: IrregularPortfolioPhase::SharedArchive,
                best_score: None,
                elapsed_ms: 12.5,
                decode_role: None,
            }),
        };
        let terminal = NativeIrregularEvent::Terminal { ordinal: 4 };

        assert_eq!(
            serde_json::to_string(&progress).expect("serializes"),
            r#"{"kind":"portfolio-progress","ordinal":3,"progress":{"phase":"shared_archive","elapsedMs":12.5}}"#
        );
        assert_eq!(
            serde_json::to_string(&terminal).expect("serializes"),
            r#"{"kind":"terminal","ordinal":4}"#
        );
    }
}
