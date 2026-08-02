//! Non-semantic diagnostics sidecar (native-boundary.md §14,
//! architecture.md §4.5): backend identity, thread count, wall-clock
//! duration, and cache telemetry for the *last* job this addon ran, exposed
//! only through the separate, opt-in `getLastJobDiagnostics()` export --
//! never folded into `NativeIrregularComputeResult` (`boundary::result`),
//! never part of a streamed event, never read by any algorithm code path.
//!
//! Per architecture.md §4.5: "The `result` module's success DTO and this
//! diagnostic sidecar are two distinct top-level return fields... kept
//! structurally separate... so a differential-parity comparison can exclude
//! the whole diagnostic channel *by construction*." `getLastJobDiagnostics`
//! (a plain, separate export) is that structural separation at the N-API
//! surface: nothing about the shape of `runIrregularJob`'s resolved
//! envelope changes depending on whether a caller ever calls it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::caches::CacheTelemetrySnapshot;
use crate::search::layout_scorer::FreeMaterialCacheTelemetry;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDiagnostics {
    pub backend_version: String,
    /// The Rayon pool size this run actually used: the built pool's live
    /// worker count (`ThreadPool::current_num_threads`), not the requested
    /// value. Differs from `thread_count_requested` exactly when the
    /// pool-build fallback degraded to a single-thread pool.
    pub thread_count_used: u32,
    /// The resolved requested pool size (explicit override, the
    /// `MIN_PLANE_IRREGULAR_NATIVE_THREADS` environment variable, or the
    /// automatic default that reserves one OS-visible CPU outside the
    /// job-owned pool for the native coordinator and Electron). Benchmark
    /// validation must reject samples where this differs from
    /// `thread_count_used`.
    pub thread_count_requested: u32,
    pub wall_clock_ms: f64,
    pub cache_telemetry: CacheTelemetrySnapshot,
    pub free_material_cache_telemetry: FreeMaterialCacheTelemetry,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessLifecycleDiagnostics {
    terminal_cleanup_hooks_fired: u64,
    terminal_latch_close_requests_by_cleanup: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LastJobDiagnosticsJson<'a> {
    #[serde(flatten)]
    job: &'a JobDiagnostics,
    process_lifecycle: ProcessLifecycleDiagnostics,
}

static TERMINAL_CLEANUP_HOOKS_FIRED: AtomicU64 = AtomicU64::new(0);
static TERMINAL_LATCH_CLOSE_REQUESTS_BY_CLEANUP: AtomicU64 = AtomicU64::new(0);

pub fn increment_terminal_cleanup_hooks_fired() {
    TERMINAL_CLEANUP_HOOKS_FIRED.fetch_add(1, Ordering::SeqCst);
}

pub fn increment_terminal_latch_close_requests_by_cleanup() {
    TERMINAL_LATCH_CLOSE_REQUESTS_BY_CLEANUP.fetch_add(1, Ordering::SeqCst);
}

fn process_lifecycle_diagnostics() -> ProcessLifecycleDiagnostics {
    ProcessLifecycleDiagnostics {
        terminal_cleanup_hooks_fired: TERMINAL_CLEANUP_HOOKS_FIRED.load(Ordering::SeqCst),
        terminal_latch_close_requests_by_cleanup: TERMINAL_LATCH_CLOSE_REQUESTS_BY_CLEANUP
            .load(Ordering::SeqCst),
    }
}

fn last_job_diagnostics_slot() -> &'static Mutex<Option<JobDiagnostics>> {
    static SLOT: OnceLock<Mutex<Option<JobDiagnostics>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Records `diagnostics` as the most recently completed job's diagnostics.
/// Called once, at the end of every `boundary::job::run_irregular_job`
/// execution (success or failure alike -- diagnostics are collected
/// regardless of the job's own outcome).
pub fn record_last_job_diagnostics(diagnostics: JobDiagnostics) {
    let mut slot = last_job_diagnostics_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *slot = Some(diagnostics);
}

/// Returns the last recorded job's diagnostics as a JSON string, or `"null"`
/// if no job has completed yet in this process.
pub fn last_job_diagnostics_json() -> String {
    let slot = last_job_diagnostics_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match slot.as_ref() {
        Some(diagnostics) => serde_json::to_string(&LastJobDiagnosticsJson {
            job: diagnostics,
            process_lifecycle: process_lifecycle_diagnostics(),
        })
        .expect("JobDiagnostics always serializes"),
        None => "null".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_reads_back_the_last_job_diagnostics() {
        // The two thread counts are deliberately different here: the JSON
        // must carry the actual pool size and the resolved requested size
        // as two independent fields, so a pool-build-fallback divergence
        // is visible to benchmark validation instead of being flattened
        // into one echoed number.
        record_last_job_diagnostics(JobDiagnostics {
            backend_version: "0.1.0".to_string(),
            thread_count_used: 1,
            thread_count_requested: 8,
            wall_clock_ms: 12.5,
            cache_telemetry: CacheTelemetrySnapshot::default(),
            free_material_cache_telemetry: FreeMaterialCacheTelemetry::default(),
        });
        let json = last_job_diagnostics_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(parsed["backendVersion"], serde_json::json!("0.1.0"));
        assert_eq!(parsed["threadCountUsed"], serde_json::json!(1));
        assert_eq!(parsed["threadCountRequested"], serde_json::json!(8));
        assert!(parsed["processLifecycle"]["terminalCleanupHooksFired"]
            .as_u64()
            .is_some());
        assert!(
            parsed["processLifecycle"]["terminalLatchCloseRequestsByCleanup"]
                .as_u64()
                .is_some()
        );
    }
}
