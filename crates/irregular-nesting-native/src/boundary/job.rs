//! `boundary::job`: the N-API-specific glue around [`super::run_job`] --
//! `AsyncTask`/`ThreadsafeFunction` wiring and the cooperative-cancellation
//! job registry. Every `#[napi]` export this crate's real job surface needs
//! (`runIrregularJob`/`cancelIrregularJob`/`getLastJobDiagnostics`) is
//! declared directly in this module, not in `lib.rs` -- napi-derive's
//! registration is item-based, not module-position-based, so `lib.rs` only
//! needs a `pub use` of these three names for discoverability (matching how
//! it already re-exports `boundary::{contain_panics, NativeError}`).
//!
//! # Async mechanism: `napi::bindgen_prelude::AsyncTask`, not `tokio`
//!
//! Per this task's brief ("choose the simplest correct napi 3.x mechanism;
//! document"): `AsyncTask<T: Task>` runs `Task::compute` on N-API's own
//! libuv worker-thread pool (`napi_create_async_work`) and resolves the
//! returned JS `Promise` back on the JS thread automatically -- no `tokio`
//! runtime, no `async`/`async-runtime` Cargo feature, no extra dependency.
//! This is strictly simpler than napi-rs's `tokio_rt`-based `spawn`
//! mechanism and already satisfies every requirement here: `compute` runs
//! off the JS thread (so `runIrregularJob` never blocks the event loop), and
//! exactly one dedicated OS thread runs one job's `compute()` body end to
//! end (matching `native-boundary.md` §6.1/§11's "job's single logically-
//! serial coordinator thread" requirement for `ThreadsafeFunction` calls).
//!
//! # Cancellation
//!
//! Each invocation receives an opaque token outside the semantic request JSON.
//! `CancellationRegistry` owns its token-keyed `CancellationLease` entries;
//! production N-API exports share one lazily-created registry, while tests
//! construct independent registries. A lease records the first requested
//! `Cancelled` or `Deadline` reason, which `Task::compute` polls from its own
//! coordinator thread. Completion removes a registration only when its lease
//! is pointer-identical to the stored lease, preventing an older completion
//! from removing a newer registration. An unknown token or invalid wire reason
//! is a harmless no-op that returns `false`.

use std::collections::{hash_map::Entry, HashMap};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use napi::bindgen_prelude::{AsyncTask, Function, Unknown};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

use crate::nfp_ifp::NfpIfpAbortReason;

use super::diagnostics::{
    increment_terminal_cleanup_hooks_fired, last_job_diagnostics_json, record_last_job_diagnostics,
    JobDiagnostics,
};
use super::events::{BoundaryEventSink, JsonEventFn, TerminalLatch};
use super::run_job::run_job_from_json;

const CANCELLATION_RUNNING: u8 = 0;
const CANCELLATION_CANCELLED: u8 = 1;
const CANCELLATION_TIMEOUT: u8 = 2;

/// One task-owned cancellation state. The first accepted cancellation reason
/// is retained so later control-plane requests cannot rewrite the terminal
/// failure this invocation reports.
struct CancellationLease {
    reason: AtomicU8,
}

impl CancellationLease {
    fn new() -> Self {
        Self {
            reason: AtomicU8::new(CANCELLATION_RUNNING),
        }
    }

    fn request(&self, reason: NfpIfpAbortReason) {
        let encoded = match reason {
            NfpIfpAbortReason::Cancelled => CANCELLATION_CANCELLED,
            NfpIfpAbortReason::Deadline => CANCELLATION_TIMEOUT,
        };
        let _ = self.reason.compare_exchange(
            CANCELLATION_RUNNING,
            encoded,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    fn reason(&self) -> Option<NfpIfpAbortReason> {
        match self.reason.load(Ordering::Acquire) {
            CANCELLATION_RUNNING => None,
            CANCELLATION_CANCELLED => Some(NfpIfpAbortReason::Cancelled),
            CANCELLATION_TIMEOUT => Some(NfpIfpAbortReason::Deadline),
            unexpected => panic!("invalid native cancellation state {unexpected}"),
        }
    }
}

/// Invocation-token keyed cancellation registrations for one addon instance.
/// Tests construct isolated registries directly; the N-API exports share the
/// lazily-created addon registry below.
struct CancellationRegistry {
    leases: Mutex<HashMap<String, Arc<CancellationLease>>>,
}

impl CancellationRegistry {
    fn new() -> Self {
        Self {
            leases: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<CancellationLease>>> {
        self.leases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn register(
        &self,
        invocation_token: String,
        lease: Arc<CancellationLease>,
    ) -> std::result::Result<(), ()> {
        match self.lock().entry(invocation_token) {
            Entry::Vacant(entry) => {
                entry.insert(lease);
                Ok(())
            }
            Entry::Occupied(_) => Err(()),
        }
    }

    fn cancel(&self, invocation_token: &str, reason: NfpIfpAbortReason) -> bool {
        let Some(lease) = self.lock().get(invocation_token).cloned() else {
            return false;
        };
        lease.request(reason);
        true
    }

    fn remove_if_current(&self, invocation_token: &str, completing_lease: &Arc<CancellationLease>) {
        let mut leases = self.lock();
        if leases
            .get(invocation_token)
            .is_some_and(|stored_lease| Arc::ptr_eq(stored_lease, completing_lease))
        {
            leases.remove(invocation_token);
        }
    }
}

fn native_cancellation_registry() -> Arc<CancellationRegistry> {
    static REGISTRY: OnceLock<Arc<CancellationRegistry>> = OnceLock::new();
    Arc::clone(REGISTRY.get_or_init(|| Arc::new(CancellationRegistry::new())))
}

fn cancellation_reason_from_wire(reason: &str) -> Option<NfpIfpAbortReason> {
    match reason {
        "cancelled" => Some(NfpIfpAbortReason::Cancelled),
        "timeout" => Some(NfpIfpAbortReason::Deadline),
        _ => None,
    }
}

struct TerminalCleanupHookData {
    terminal_latch: TerminalLatch,
    fired: Arc<AtomicBool>,
}

struct TerminalCleanupHook {
    data: *mut TerminalCleanupHookData,
    fired: Arc<AtomicBool>,
}

unsafe impl Send for TerminalCleanupHook {}

impl TerminalCleanupHook {
    fn register(env: &Env, terminal_latch: TerminalLatch) -> Result<Self> {
        let fired = Arc::new(AtomicBool::new(false));
        let data = Box::into_raw(Box::new(TerminalCleanupHookData {
            terminal_latch,
            fired: Arc::clone(&fired),
        }));
        let status = Status::from(unsafe {
            napi::sys::napi_add_env_cleanup_hook(
                env.raw(),
                Some(terminal_cleanup_hook),
                data.cast::<c_void>(),
            )
        });
        if status != Status::Ok {
            unsafe {
                drop(Box::from_raw(data));
            }
            return Err(Error::new(
                status,
                "native irregular terminal cleanup hook registration failed",
            ));
        }
        Ok(Self { data, fired })
    }

    fn remove_and_reclaim(self, env: &Env) -> Result<()> {
        if self.fired.load(Ordering::Acquire) {
            return Ok(());
        }
        let status = Status::from(unsafe {
            napi::sys::napi_remove_env_cleanup_hook(
                env.raw(),
                Some(terminal_cleanup_hook),
                self.data.cast::<c_void>(),
            )
        });
        if status != Status::Ok {
            return Err(Error::new(
                status,
                "native irregular terminal cleanup hook removal failed",
            ));
        }
        unsafe {
            drop(Box::from_raw(self.data));
        }
        Ok(())
    }
}

unsafe extern "C" fn terminal_cleanup_hook(data: *mut c_void) {
    if data.is_null() {
        return;
    }
    let hook_data = unsafe { Box::from_raw(data.cast::<TerminalCleanupHookData>()) };
    hook_data.fired.store(true, Ordering::Release);
    increment_terminal_cleanup_hooks_fired();
    hook_data.terminal_latch.close_for_cleanup();
}

/// Requests cooperative cancellation of the native invocation identified by
/// its opaque `invocation_token`. The public `jobId` remains semantic request
/// data and is never used to locate a native cancellation lease. Returns
/// `false` for an unknown token or an invalid reason, and otherwise records
/// the first cancellation reason without replacing it.
#[napi]
pub fn cancel_irregular_job(invocation_token: String, reason: String) -> bool {
    let Some(reason) = cancellation_reason_from_wire(&reason) else {
        return false;
    };
    native_cancellation_registry().cancel(&invocation_token, reason)
}

/// The `napi::Task` this crate's `AsyncTask` wraps. Every field is `Send`
/// (plain owned data plus `ThreadsafeFunction`, `Send`+`Sync` by
/// napi-rs's own unsafe impl) so the whole struct can move onto the libuv
/// worker thread `compute()` runs on.
pub struct RunIrregularJobTask {
    invocation_token: String,
    cancellation_registry: Arc<CancellationRegistry>,
    cancellation_lease: Arc<CancellationLease>,
    request_json: String,
    on_event: JsonEventFn,
    emit_state_snapshots: bool,
    terminal_latch: TerminalLatch,
    terminal_cleanup_hook: Option<TerminalCleanupHook>,
}

impl Task for RunIrregularJobTask {
    type Output = String;
    type JsValue = String;

    /// Runs on an N-API libuv worker thread -- the job's one dedicated
    /// coordinating thread. Panic containment wraps the entire body (this
    /// task's brief: "wire it around the whole job"): a caught panic still
    /// resolves the promise with a sanitized `unknown_error` envelope,
    /// never lets the panic unwind across the N-API boundary
    /// (`boundary::contain_panics`, already-existing crate infrastructure).
    /// Decoding/revalidation/routing (`run_job_from_json`'s own
    /// `decode_and_route` call) happens here too, not before spawning --
    /// see `run_job`'s own top doc for why every failure mode resolves
    /// through the same envelope rather than throwing/rejecting.
    fn compute(&mut self) -> Result<Self::Output> {
        let started_at = Instant::now();
        let request_json = std::mem::take(&mut self.request_json);
        let cancellation_lease = Arc::clone(&self.cancellation_lease);
        let mut sink = BoundaryEventSink::new(
            &self.on_event,
            self.emit_state_snapshots,
            self.terminal_latch.clone(),
        );

        let outcome = super::contain_panics(
            "runIrregularJob",
            std::panic::AssertUnwindSafe(|| {
                let mut cancellation_reason = || cancellation_lease.reason();
                let (envelope, cache_telemetry, free_material_cache_telemetry, thread_count_used) =
                    run_job_from_json(
                        &request_json,
                        &mut sink,
                        Some(&mut cancellation_reason),
                        None,
                    );
                record_last_job_diagnostics(JobDiagnostics {
                    backend_version: env!("CARGO_PKG_VERSION").to_string(),
                    thread_count_used: thread_count_used as u32,
                    wall_clock_ms: started_at.elapsed().as_secs_f64() * 1000.0,
                    cache_telemetry,
                    free_material_cache_telemetry,
                });
                Ok(envelope)
            }),
        );
        sink.emit_terminal_and_wait();
        let delivery_failure = sink.first_delivery_failure();

        self.cancellation_registry
            .remove_if_current(&self.invocation_token, &self.cancellation_lease);

        if let Some(status) = delivery_failure {
            let boundary_error =
                super::error::BoundaryError::native_event_delivery_failed(format!("{status:?}"));
            return Ok(format!(
                r#"{{"ok":false,"error":{}}}"#,
                boundary_error.to_json()
            ));
        }

        match outcome {
            Ok(envelope) => Ok(envelope),
            Err(native_error) => {
                // §12 sanitization: the default envelope never carries the
                // raw panic payload -- `BoundaryError::from_panic` fixes the
                // message to a generic string and keeps only
                // `operation`/`backend: "rust"` context.
                let boundary_error = super::error::BoundaryError::from_panic(&native_error);
                Ok(format!(
                    r#"{{"ok":false,"error":{}}}"#,
                    boundary_error.to_json()
                ))
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }

    fn finally(mut self, env: Env) -> Result<()> {
        if let Some(terminal_cleanup_hook) = self.terminal_cleanup_hook.take() {
            terminal_cleanup_hook.remove_and_reclaim(&env)?;
        }
        Ok(())
    }
}

/// TS-facing entry point (re-exported by `lib.rs`'s `#[napi]`
/// `run_irregular_job`). Returns `Ok(AsyncTask<_>)`, and therefore a real
/// `Promise`, after callback construction and invocation-token registration
/// succeed. A malformed callback or duplicate active token throws synchronously
/// before an async task is created. Decoding, revalidation, and
/// archive-eligibility routing all happen inside the spawned task, not here
/// -- see `run_job`'s own top doc for why.
#[napi]
pub fn run_irregular_job(
    env: Env,
    request_json: String,
    invocation_token: String,
    on_event: Function<'_, String, Unknown<'static>>,
    emit_state_snapshots: bool,
) -> Result<AsyncTask<RunIrregularJobTask>> {
    let on_event = on_event.build_threadsafe_function::<String>().build()?;
    let cancellation_registry = native_cancellation_registry();
    let cancellation_lease = Arc::new(CancellationLease::new());

    if cancellation_registry
        .register(invocation_token.clone(), Arc::clone(&cancellation_lease))
        .is_err()
    {
        return Err(Error::new(
            Status::InvalidArg,
            "native irregular invocation token is already registered",
        ));
    }

    let terminal_latch = TerminalLatch::new();
    let terminal_cleanup_hook = match TerminalCleanupHook::register(&env, terminal_latch.clone()) {
        Ok(terminal_cleanup_hook) => terminal_cleanup_hook,
        Err(error) => {
            cancellation_registry.remove_if_current(&invocation_token, &cancellation_lease);
            return Err(error);
        }
    };

    Ok(AsyncTask::new(RunIrregularJobTask {
        invocation_token,
        cancellation_registry,
        cancellation_lease,
        request_json,
        on_event,
        emit_state_snapshots,
        terminal_latch,
        terminal_cleanup_hook: Some(terminal_cleanup_hook),
    }))
}

/// Non-semantic diagnostics sidecar export (`architecture.md` §4.5): the
/// last completed job's backend identity, thread count, wall-clock
/// duration, and cache telemetry, or the JSON literal `"null"` if no job has
/// completed yet in this process. Never inspected by any algorithm code
/// path and never merged into `runIrregularJob`'s resolved envelope.
#[napi]
pub fn get_last_job_diagnostics() -> String {
    last_job_diagnostics_json()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::nfp_ifp::NfpIfpAbortReason;

    use super::{CancellationLease, CancellationRegistry};

    #[test]
    fn cancellation_registry_keeps_overlapping_public_job_ids_independently_cancellable() {
        let registry = CancellationRegistry::new();
        let public_job_id = "shared-public-job-id";
        let first_token = format!("{public_job_id}:first-invocation");
        let second_token = format!("{public_job_id}:second-invocation");
        let first_lease = Arc::new(CancellationLease::new());
        let second_lease = Arc::new(CancellationLease::new());

        registry
            .register(first_token.clone(), Arc::clone(&first_lease))
            .expect("first invocation token registers");
        registry
            .register(second_token.clone(), Arc::clone(&second_lease))
            .expect("second invocation token registers");

        assert!(registry.cancel(&second_token, NfpIfpAbortReason::Deadline));
        assert_eq!(first_lease.reason(), None);
        assert_eq!(second_lease.reason(), Some(NfpIfpAbortReason::Deadline));

        assert!(registry.cancel(&first_token, NfpIfpAbortReason::Cancelled));
        assert_eq!(first_lease.reason(), Some(NfpIfpAbortReason::Cancelled));
        assert_eq!(second_lease.reason(), Some(NfpIfpAbortReason::Deadline));
    }

    #[test]
    fn cancellation_registry_retains_the_first_cancellation_reason() {
        let registry = CancellationRegistry::new();
        let lease = Arc::new(CancellationLease::new());
        let token = "first-reason-token";

        registry
            .register(token.to_string(), Arc::clone(&lease))
            .expect("token registers");
        assert!(registry.cancel(token, NfpIfpAbortReason::Deadline));
        assert!(registry.cancel(token, NfpIfpAbortReason::Cancelled));

        assert_eq!(lease.reason(), Some(NfpIfpAbortReason::Deadline));
    }

    #[test]
    fn cancellation_registry_rejects_a_duplicate_token_without_replacing_its_lease() {
        let registry = CancellationRegistry::new();
        let original_lease = Arc::new(CancellationLease::new());
        let duplicate_lease = Arc::new(CancellationLease::new());

        registry
            .register("duplicate-token".to_string(), Arc::clone(&original_lease))
            .expect("original token registers");
        assert!(registry
            .register("duplicate-token".to_string(), Arc::clone(&duplicate_lease))
            .is_err());

        assert!(registry.cancel("duplicate-token", NfpIfpAbortReason::Deadline));
        assert_eq!(original_lease.reason(), Some(NfpIfpAbortReason::Deadline));
        assert_eq!(duplicate_lease.reason(), None);
    }

    #[test]
    fn cancellation_registry_removes_only_the_pointer_identical_completing_lease() {
        let registry = CancellationRegistry::new();
        let registered_lease = Arc::new(CancellationLease::new());
        let unrelated_lease = Arc::new(CancellationLease::new());
        let token = "pointer-identity-token";

        registry
            .register(token.to_string(), Arc::clone(&registered_lease))
            .expect("token registers");
        registry.remove_if_current(token, &unrelated_lease);

        assert!(registry.cancel(token, NfpIfpAbortReason::Cancelled));
        assert_eq!(
            registered_lease.reason(),
            Some(NfpIfpAbortReason::Cancelled)
        );

        registry.remove_if_current(token, &registered_lease);
        assert!(!registry.cancel(token, NfpIfpAbortReason::Cancelled));
    }
}
