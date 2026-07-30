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

use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::caches::CacheTelemetrySnapshot;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDiagnostics {
    pub backend_version: String,
    /// Rayon pool size this run used. Always `1` at this stage: this crate
    /// has no Rayon dependency yet (Stage 3/4 concern, migration prompt
    /// §14.4/§16.2) -- see `native_capability`'s `default_thread_count` for
    /// the analogous "what the pool would use" capability-query field this
    /// mirrors.
    pub thread_count_used: u32,
    pub wall_clock_ms: f64,
    pub cache_telemetry: CacheTelemetrySnapshot,
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
        Some(diagnostics) => {
            serde_json::to_string(diagnostics).expect("JobDiagnostics always serializes")
        }
        None => "null".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_reads_back_the_last_job_diagnostics() {
        record_last_job_diagnostics(JobDiagnostics {
            backend_version: "0.1.0".to_string(),
            thread_count_used: 1,
            wall_clock_ms: 12.5,
            cache_telemetry: CacheTelemetrySnapshot::default(),
        });
        let json = last_job_diagnostics_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(parsed["backendVersion"], serde_json::json!("0.1.0"));
        assert_eq!(parsed["threadCountUsed"], serde_json::json!(1));
    }
}
