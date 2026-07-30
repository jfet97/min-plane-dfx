//! Unified streamed event delivery over one [`ThreadsafeFunction`] callback.
//!
//! Every event is produced on the job's single coordinator thread. The sink
//! owns the only ordinal sequence, including the terminal marker, and records
//! the first N-API delivery status failure for `boundary::job` to expose in its
//! final envelope after it has attempted terminal delivery.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::{self, Thread};

use napi::bindgen_prelude::Unknown;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use serde::Serialize;

use crate::result::progress::IrregularComputeEventSink;
use crate::result::{IrregularPortfolioProgress, IrregularStateSnapshot};

use super::diagnostics::increment_terminal_latch_close_requests_by_cleanup;
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

const TERMINAL_PENDING: i32 = -1;
const TERMINAL_ADMITTING: i32 = -2;
const TERMINAL_WAITING: i32 = -3;
const TERMINAL_CLOSING: i32 = -4;

struct TerminalLatchState {
    outcome: AtomicI32,
    cleanup_requested: AtomicBool,
    waiter: OnceLock<Thread>,
}

#[derive(Clone)]
pub struct TerminalLatch {
    state: Arc<TerminalLatchState>,
}

pub struct TerminalAcknowledgement {
    latch: TerminalLatch,
}

impl TerminalLatch {
    pub fn new() -> Self {
        Self {
            state: Arc::new(TerminalLatchState {
                outcome: AtomicI32::new(TERMINAL_PENDING),
                cleanup_requested: AtomicBool::new(false),
                waiter: OnceLock::new(),
            }),
        }
    }

    pub fn enqueue_terminal_and_wait(
        &self,
        enqueue: impl FnOnce(TerminalAcknowledgement) -> Status,
    ) -> Status {
        match self.state.outcome.compare_exchange(
            TERMINAL_PENDING,
            TERMINAL_ADMITTING,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => {}
            Err(outcome) => return status_for_terminal_outcome(outcome),
        }

        let waiter_registration = self.state.waiter.set(thread::current());
        debug_assert!(waiter_registration.is_ok());
        let enqueue_status = enqueue(TerminalAcknowledgement {
            latch: self.clone(),
        });
        if enqueue_status != Status::Ok {
            self.commit_status(enqueue_status);
            return status_for_terminal_outcome(self.state.outcome.load(Ordering::SeqCst));
        }

        let _ = self.state.outcome.compare_exchange(
            TERMINAL_ADMITTING,
            TERMINAL_WAITING,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        self.commit_cleanup_if_requested();

        loop {
            let outcome = self.state.outcome.load(Ordering::SeqCst);
            if is_terminal_outcome(outcome) {
                return status_for_terminal_outcome(outcome);
            }
            thread::park();
            self.commit_cleanup_if_requested();
        }
    }

    pub fn close_for_cleanup(&self) {
        increment_terminal_latch_close_requests_by_cleanup();
        self.state.cleanup_requested.store(true, Ordering::SeqCst);
        self.commit_cleanup_if_requested();
        self.unpark_waiter();
    }

    #[cfg(test)]
    fn close(&self) {
        self.state.cleanup_requested.store(true, Ordering::SeqCst);
        self.commit_cleanup_if_requested();
        self.unpark_waiter();
    }

    fn acknowledge(&self, status: Status) {
        self.commit_status(status);
    }

    fn commit_status(&self, status: Status) {
        let status_code = i32::from(status);
        loop {
            let current = self.state.outcome.load(Ordering::SeqCst);
            if is_terminal_outcome(current) {
                return;
            }
            if self
                .state
                .outcome
                .compare_exchange(current, status_code, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                self.unpark_waiter();
                return;
            }
        }
    }

    fn commit_cleanup_if_requested(&self) {
        if !self.state.cleanup_requested.load(Ordering::SeqCst) {
            return;
        }
        loop {
            let current = self.state.outcome.load(Ordering::SeqCst);
            if is_terminal_outcome(current) || current == TERMINAL_ADMITTING {
                return;
            }
            if self
                .state
                .outcome
                .compare_exchange(
                    current,
                    TERMINAL_CLOSING,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_ok()
            {
                return;
            }
        }
    }

    fn unpark_waiter(&self) {
        if let Some(waiter) = self.state.waiter.get() {
            waiter.unpark();
        }
    }
}

impl Default for TerminalLatch {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalAcknowledgement {
    pub fn acknowledge(self, status: Status) {
        self.latch.acknowledge(status);
    }
}

fn is_terminal_outcome(outcome: i32) -> bool {
    outcome == TERMINAL_CLOSING || outcome >= 0
}

fn status_for_terminal_outcome(outcome: i32) -> Status {
    match outcome {
        TERMINAL_CLOSING => Status::Closing,
        outcome if outcome >= 0 => Status::from(outcome),
        _ => unreachable!("terminal latch outcome must be committed"),
    }
}

#[derive(Default)]
struct DeliveryFailure {
    first: Option<Status>,
}

impl DeliveryFailure {
    fn record(&mut self, status: Status) {
        if self.first.is_none() {
            self.first = Some(status);
        }
    }

    fn status(&self) -> Option<Status> {
        self.first
    }
}

pub struct BoundaryEventSink<'a> {
    next_ordinal: u64,
    terminal_emitted: bool,
    emit_state_snapshots: bool,
    on_event: &'a JsonEventFn,
    terminal_latch: TerminalLatch,
    delivery_failure: DeliveryFailure,
}

impl<'a> BoundaryEventSink<'a> {
    pub fn new(
        on_event: &'a JsonEventFn,
        emit_state_snapshots: bool,
        terminal_latch: TerminalLatch,
    ) -> Self {
        Self {
            next_ordinal: 0,
            terminal_emitted: false,
            emit_state_snapshots,
            on_event,
            terminal_latch,
            delivery_failure: DeliveryFailure::default(),
        }
    }

    pub fn emit_terminal_and_wait(&mut self) -> Status {
        if self.terminal_emitted {
            debug_assert!(false, "attempted to emit a native event after terminal");
            return Status::Ok;
        }
        self.terminal_emitted = true;
        let ordinal = self.take_ordinal();
        let json = serde_json::to_string(&NativeIrregularEvent::Terminal { ordinal })
            .expect("native terminal event always serializes");
        let terminal_latch = self.terminal_latch.clone();
        let on_event = self.on_event;
        let status = terminal_latch.enqueue_terminal_and_wait(|acknowledgement| {
            on_event.call_with_return_value(
                json,
                ThreadsafeFunctionCallMode::NonBlocking,
                move |callback_result, _env| {
                    let status = callback_result
                        .map(|_| Status::Ok)
                        .unwrap_or_else(|error| error.status);
                    acknowledgement.acknowledge(status);
                    Ok(())
                },
            )
        });
        if status != Status::Ok {
            self.record_delivery_failure(status);
        }
        status
    }

    pub fn first_delivery_failure(&self) -> Option<Status> {
        self.delivery_failure.status()
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
            self.record_delivery_failure(status);
        }
    }

    fn record_delivery_failure(&mut self, status: Status) {
        self.delivery_failure.record(status);
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
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use super::*;
    use crate::result::IrregularPortfolioPhase;

    #[test]
    fn cleanup_close_does_not_block_during_terminal_enqueue_admission() {
        let latch = TerminalLatch::new();
        let waiter_latch = latch.clone();
        let (enqueue_entered_sender, enqueue_entered_receiver) = mpsc::channel();
        let (release_enqueue_sender, release_enqueue_receiver) = mpsc::channel();
        let (close_returned_sender, close_returned_receiver) = mpsc::channel();

        let waiter = thread::spawn(move || {
            waiter_latch.enqueue_terminal_and_wait(|_acknowledgement| {
                enqueue_entered_sender
                    .send(())
                    .expect("enqueue entered notification");
                release_enqueue_receiver
                    .recv()
                    .expect("enqueue release notification");
                Status::Ok
            })
        });

        enqueue_entered_receiver
            .recv()
            .expect("terminal enqueue entered");
        let cleanup_latch = latch.clone();
        let cleanup = thread::spawn(move || {
            cleanup_latch.close_for_cleanup();
            close_returned_sender
                .send(())
                .expect("cleanup close returned notification");
        });

        let close_returned = close_returned_receiver.recv_timeout(Duration::from_millis(100));
        release_enqueue_sender
            .send(())
            .expect("release terminal enqueue");
        cleanup.join().expect("cleanup thread completes");
        assert_eq!(
            waiter.join().expect("waiter thread completes"),
            Status::Closing
        );
        assert_eq!(close_returned, Ok(()));
    }

    #[test]
    fn accepted_terminal_with_retained_acknowledgement_unblocks_as_closing_on_cleanup() {
        let latch = TerminalLatch::new();
        let retained_acknowledgement = Arc::new(Mutex::new(None));
        let (accepted_sender, accepted_receiver) = mpsc::channel();
        let (result_sender, result_receiver) = mpsc::channel();
        let waiter_latch = latch.clone();
        let waiter_acknowledgement = Arc::clone(&retained_acknowledgement);

        let waiter = thread::spawn(move || {
            let status = waiter_latch.enqueue_terminal_and_wait(move |acknowledgement| {
                *waiter_acknowledgement
                    .lock()
                    .expect("retained acknowledgement lock") = Some(acknowledgement);
                accepted_sender.send(()).expect("accepted notification");
                Status::Ok
            });
            result_sender.send(status).expect("terminal result");
        });

        accepted_receiver.recv().expect("accepted terminal enqueue");
        assert_eq!(result_receiver.try_recv(), Err(mpsc::TryRecvError::Empty));

        latch.close();

        assert_eq!(
            result_receiver.recv().expect("cleanup releases waiter"),
            Status::Closing
        );
        waiter.join().expect("waiter thread completes");
    }

    #[test]
    fn live_terminal_waits_until_acknowledgement_callback_returns() {
        let latch = TerminalLatch::new();
        let retained_acknowledgement = Arc::new(Mutex::new(None));
        let (accepted_sender, accepted_receiver) = mpsc::channel();
        let (result_sender, result_receiver) = mpsc::channel();
        let waiter_latch = latch.clone();
        let waiter_acknowledgement = Arc::clone(&retained_acknowledgement);

        let waiter = thread::spawn(move || {
            let status = waiter_latch.enqueue_terminal_and_wait(move |acknowledgement| {
                *waiter_acknowledgement
                    .lock()
                    .expect("retained acknowledgement lock") = Some(acknowledgement);
                accepted_sender.send(()).expect("accepted notification");
                Status::Ok
            });
            result_sender.send(status).expect("terminal result");
        });

        accepted_receiver.recv().expect("accepted terminal enqueue");
        assert_eq!(result_receiver.try_recv(), Err(mpsc::TryRecvError::Empty));

        retained_acknowledgement
            .lock()
            .expect("retained acknowledgement lock")
            .take()
            .expect("retained acknowledgement")
            .acknowledge(Status::Ok);

        assert_eq!(
            result_receiver.recv().expect("callback releases waiter"),
            Status::Ok
        );
        waiter.join().expect("waiter thread completes");
    }

    #[test]
    fn callback_failure_wins_over_later_cleanup() {
        let latch = TerminalLatch::new();
        let retained_acknowledgement = Arc::new(Mutex::new(None));
        let (accepted_sender, accepted_receiver) = mpsc::channel();
        let (result_sender, result_receiver) = mpsc::channel();
        let waiter_latch = latch.clone();
        let waiter_acknowledgement = Arc::clone(&retained_acknowledgement);

        let waiter = thread::spawn(move || {
            let status = waiter_latch.enqueue_terminal_and_wait(move |acknowledgement| {
                *waiter_acknowledgement
                    .lock()
                    .expect("retained acknowledgement lock") = Some(acknowledgement);
                accepted_sender.send(()).expect("accepted notification");
                Status::Ok
            });
            result_sender.send(status).expect("terminal result");
        });

        accepted_receiver.recv().expect("accepted terminal enqueue");
        retained_acknowledgement
            .lock()
            .expect("retained acknowledgement lock")
            .take()
            .expect("retained acknowledgement")
            .acknowledge(Status::PendingException);
        latch.close();

        assert_eq!(
            result_receiver
                .recv()
                .expect("callback failure releases waiter"),
            Status::PendingException
        );
        waiter.join().expect("waiter thread completes");
    }

    #[test]
    fn cleanup_wins_over_late_callback() {
        let latch = TerminalLatch::new();
        let retained_acknowledgement = Arc::new(Mutex::new(None));
        let (accepted_sender, accepted_receiver) = mpsc::channel();
        let (result_sender, result_receiver) = mpsc::channel();
        let waiter_latch = latch.clone();
        let waiter_acknowledgement = Arc::clone(&retained_acknowledgement);

        let waiter = thread::spawn(move || {
            let status = waiter_latch.enqueue_terminal_and_wait(move |acknowledgement| {
                *waiter_acknowledgement
                    .lock()
                    .expect("retained acknowledgement lock") = Some(acknowledgement);
                accepted_sender.send(()).expect("accepted notification");
                Status::Ok
            });
            result_sender.send(status).expect("terminal result");
        });

        accepted_receiver.recv().expect("accepted terminal enqueue");
        latch.close();
        retained_acknowledgement
            .lock()
            .expect("retained acknowledgement lock")
            .take()
            .expect("retained acknowledgement")
            .acknowledge(Status::Ok);

        assert_eq!(
            result_receiver.recv().expect("cleanup releases waiter"),
            Status::Closing
        );
        waiter.join().expect("waiter thread completes");
    }

    #[test]
    fn immediate_enqueue_failure_does_not_wait_for_acknowledgement() {
        let latch = TerminalLatch::new();

        assert_eq!(
            latch.enqueue_terminal_and_wait(|_acknowledgement| Status::QueueFull),
            Status::QueueFull
        );
    }

    #[test]
    fn ordinary_delivery_failure_remains_authoritative_after_terminal_cleanup() {
        let latch = TerminalLatch::new();
        let mut delivery_failure = DeliveryFailure::default();
        delivery_failure.record(Status::QueueFull);

        latch.close();
        delivery_failure.record(Status::Closing);

        assert_eq!(delivery_failure.status(), Some(Status::QueueFull));
    }

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
