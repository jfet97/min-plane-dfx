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
//! `cancel_irregular_job(job_id)` flips a job-keyed `Arc<AtomicBool>` in a
//! process-global registry (`OnceLock<Mutex<HashMap<...>>>` -- this crate has
//! no existing job-registry helper to reuse; a plain `Mutex`-guarded map is
//! the minimal correct structure for "look up or insert one entry, guarded
//! against concurrent `cancel`/job-completion races," and every operation on
//! it is O(1) and briefly held, so lock contention is not a concern). The
//! flag is polled from `Task::compute`'s own thread only (never mutated
//! there), satisfying `native-boundary.md` §6.3's "the flag is read only by
//! the single logically-serial coordinator thread." The entry is removed
//! once the job's `compute()` finishes, so `cancel_irregular_job` on an
//! unknown/already-finished job id is a harmless, idempotent no-op (returns
//! `false`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use napi::bindgen_prelude::{AsyncTask, Function, Unknown};
use napi::{Env, Result as NapiResult, Task};
use napi_derive::napi;

use super::diagnostics::{last_job_diagnostics_json, record_last_job_diagnostics, JobDiagnostics};
use super::events::{BoundaryEventSink, JsonEventFn};
use super::run_job::run_job_from_json;

fn job_registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn registry_lock() -> std::sync::MutexGuard<'static, HashMap<String, Arc<AtomicBool>>> {
    job_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Requests cooperative cancellation of the job identified by `job_id`.
/// Idempotent; returns `true` iff a running job with that id was found (the
/// return value is diagnostic convenience only, never load-bearing --
/// TypeScript must not branch its own success/failure handling on it, since
/// a job that finishes between lookup and flag-set still completes
/// normally, matching `native-boundary.md` §6.3's "no partial result"
/// framing applied to this simplified single-call surface).
#[napi]
pub fn cancel_irregular_job(job_id: String) -> bool {
    match registry_lock().get(&job_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Best-effort, cheap extraction of `jobId` from the raw wire JSON, used
/// only to key the cancellation registry entry *before* the real
/// [`super::request::RequestDto`] decode (which requires every other field
/// too) runs inside `Task::compute`. Never used for anything
/// safety-critical: if this returns `None` (malformed top-level JSON, or a
/// missing/non-string `jobId`), the job simply is not registered for
/// cancellation -- `Task::compute`'s own real decode will independently
/// reject the same malformed request with a proper `BoundaryError`.
fn extract_job_id_best_effort(request_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(request_json).ok()?;
    value.get("jobId")?.as_str().map(str::to_string)
}

/// The `napi::Task` this crate's `AsyncTask` wraps. Every field is `Send`
/// (plain owned data plus `ThreadsafeFunction`, `Send`+`Sync` by
/// napi-rs's own unsafe impl) so the whole struct can move onto the libuv
/// worker thread `compute()` runs on.
pub struct RunIrregularJobTask {
    job_id: Option<String>,
    request_json: String,
    on_portfolio_progress: JsonEventFn,
    on_state_snapshot: Option<JsonEventFn>,
    cancel_flag: Arc<AtomicBool>,
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
    fn compute(&mut self) -> NapiResult<Self::Output> {
        let started_at = Instant::now();
        let request_json = std::mem::take(&mut self.request_json);
        let cancel_flag = Arc::clone(&self.cancel_flag);
        let on_portfolio_progress = &self.on_portfolio_progress;
        let on_state_snapshot = self.on_state_snapshot.as_ref();

        let outcome = super::contain_panics(
            "runIrregularJob",
            std::panic::AssertUnwindSafe(move || {
                let mut sink = BoundaryEventSink::new(on_portfolio_progress, on_state_snapshot);
                let mut is_cancelled = move || cancel_flag.load(Ordering::SeqCst);
                let (envelope, geometry_cache) =
                    run_job_from_json(&request_json, &mut sink, Some(&mut is_cancelled));
                record_last_job_diagnostics(JobDiagnostics {
                    backend_version: env!("CARGO_PKG_VERSION").to_string(),
                    thread_count_used: 1,
                    wall_clock_ms: started_at.elapsed().as_secs_f64() * 1000.0,
                    cache_telemetry: geometry_cache
                        .map(|cache| cache.telemetry().clone())
                        .unwrap_or_default(),
                });
                Ok(envelope)
            }),
        );

        if let Some(job_id) = &self.job_id {
            registry_lock().remove(job_id);
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

    fn resolve(&mut self, _env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        Ok(output)
    }
}

/// TS-facing entry point (re-exported by `lib.rs`'s `#[napi]`
/// `run_irregular_job`). Always returns `Ok(AsyncTask<_>)` -- i.e. always a
/// real `Promise` -- except when building a `ThreadsafeFunction` from one of
/// the supplied callbacks itself fails (a fundamentally malformed call, e.g.
/// a non-function argument; effectively unreachable from a
/// correctly-typed TypeScript caller). Decoding, revalidation, and
/// archive-eligibility routing all happen inside the spawned task, not here
/// -- see `run_job`'s own top doc for why.
#[napi]
pub fn run_irregular_job(
    request_json: String,
    on_portfolio_progress: Function<'_, String, Unknown<'static>>,
    on_state_snapshot: Option<Function<'_, String, Unknown<'static>>>,
    // Accepted for uniformity with `on_portfolio_progress`/`on_state_snapshot`
    // and to keep the door open for a future profile that does emit
    // decision-trace events, but never invoked -- the ported archive-path
    // coordinator does not call `emitDecisionTrace` either (see
    // `result::mod`'s "Deliberately not ported"; native-boundary.md §10.3).
    _on_decision_trace_batch: Option<Function<'_, String, Unknown<'static>>>,
) -> NapiResult<AsyncTask<RunIrregularJobTask>> {
    let on_portfolio_progress = on_portfolio_progress
        .build_threadsafe_function::<String>()
        .build()?;
    let on_state_snapshot = match on_state_snapshot {
        Some(function) => Some(function.build_threadsafe_function::<String>().build()?),
        None => None,
    };

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let job_id = extract_job_id_best_effort(&request_json);
    if let Some(job_id) = &job_id {
        registry_lock().insert(job_id.clone(), Arc::clone(&cancel_flag));
    }

    Ok(AsyncTask::new(RunIrregularJobTask {
        job_id,
        request_json,
        on_portfolio_progress,
        on_state_snapshot,
        cancel_flag,
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
