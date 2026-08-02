//! `boundary::run_job`: the plain, N-API-free job execution function.
//!
//! Per `docs/planning/rust-irregular-backend/architecture.md` §4.1: "`lib.rs`
//! stays thin: each `#[napi]` function decodes its typed arguments, calls
//! `boundary::run_job(...)` (a plain Rust function, not itself `#[napi]`, so
//! it is directly unit-testable without an N-API runtime), and encodes the
//! result." This module is that function. `boundary::job` (the
//! `AsyncTask`/`ThreadsafeFunction` glue) and, transitively, `lib.rs`'s
//! `#[napi]` `run_irregular_job` are the only callers.
//!
//! Per architecture.md §4.1/§4.2, one call owns exactly: decoding +
//! revalidating the request (§13.1), routing (archive-eligibility, §13.1's
//! "load-bearing scope check"), constructing the job-local
//! `GeometryCacheStore`/`FreeMaterialCache` (one instance per job, never
//! shared, per §4.2), running `result::coordinator::compute_irregular_nesting`,
//! and returning **one** JSON envelope string -- never a Rust `Result`, so
//! that every domain-level failure (as opposed to a fundamentally malformed
//! call) resolves the caller's promise rather than rejecting it, matching
//! this crate's pre-existing placeholder-boundary convention
//! (`lib.rs`'s original `{"ok":false,"error":{...}}` shape, extended here
//! with the real `AppErrorCode` category table instead of a placeholder).
//!
//! # Routing/decode failures resolve too, they do not throw or reject
//!
//! An earlier version of this module had `boundary::job` convert a
//! synchronous `decode_and_route` failure into an N-API throw before
//! spawning the async job, mirroring native-boundary.md §5's
//! `create_irregular_job`/`.run()` two-call split. Verified empirically
//! against this repo's actual napi 3.12/napi-derive 3.6 codegen (not
//! assumed): a `#[napi]` function whose return type mentions `AsyncTask<_>`
//! is classified `is_async` by napi-derive's codegen
//! (`napi-derive-backend`'s `gen_fn_return`), and for that class of
//! function, a synchronous `Result::Err` is converted by
//! `napi::bindgen_prelude::ToNapiValue for Result<T>`'s blanket impl into a
//! plain JS `Error` **value returned normally** from the call (via
//! `napi_create_error`) -- not thrown (`napi_throw`), not a rejected
//! `Promise`. Relying on that for typed boundary-error handling would be a
//! surprising, upgrade-fragile contract (`instanceof Error` on a
//! supposedly-`Promise`-typed return value). This
//! module instead gives `runIrregularJob` one uniform contract: it always
//! returns a real `Promise<string>` that always **resolves** with the same
//! `{"ok":true,"result":...}` / `{"ok":false,"error":{"category",...}}`
//! envelope, whether the failure is a malformed request, a failed
//! revalidation, archive-ineligible routing, an algorithm failure, or a
//! contained panic. Worker orchestration preflights archive eligibility before
//! native execution. The `"not_implemented"` /
//! `"legacy-portfolio-unsupported"` envelope remains defense-in-depth for
//! direct boundary calls that bypass worker preflight.

use crate::caches::{CacheTelemetrySnapshot, GeometryCacheStore};
use crate::nfp_ifp::NfpIfpAbortReason;
use crate::result::coordinator::{compute_irregular_nesting, ComputeIrregularNestingOptions};
use crate::result::progress::IrregularComputeEventSink;
use crate::search::layout_scorer::FreeMaterialCache;

use super::error::BoundaryError;
use super::parallel::{JobPool, JobThreadCounts};
use super::request::{require_archive_eligible, PreparedRequest, RequestDto};
use super::result::project_result;

/// Decodes, revalidates, and routes `request_json` without running the
/// algorithm. Exposed separately from [`run_job_from_json`] purely for
/// finer-grained unit testing; `boundary::job` calls
/// [`run_job_from_json`], never this function directly, so that a
/// decode/routing failure resolves through the same envelope as every other
/// failure (see this module's top doc).
pub fn decode_and_route(request_json: &str) -> Result<PreparedRequest, BoundaryError> {
    let prepared = RequestDto::decode_and_prepare(request_json)?;
    require_archive_eligible(&prepared.settings)?;
    Ok(prepared)
}

/// The single entry point `boundary::job::RunIrregularJobTask::compute` calls.
/// Always returns a JSON envelope string (see this module's top doc); the
/// second tuple element is the post-cleanup geometry-cache telemetry snapshot.
/// Decoding and routing failures return the default zero-usage snapshot because
/// no job-local cache was constructed. The third element is the post-cleanup
/// free-material cache telemetry snapshot. The fourth element carries both
/// the resolved requested Rayon thread count and the built pool's actual
/// worker count (`boundary::parallel::JobThreadCounts`, diagnostics-only
/// per that module's doc -- the two differ exactly when the pool-build
/// fallback fired); `{requested: 1, actual: 1}` when decoding or routing
/// failed before a pool was constructed.
/// `thread_count_override`, when `Some`, wins over the
/// `MIN_PLANE_IRREGULAR_NATIVE_THREADS` environment variable (see
/// `boundary::parallel::resolve_thread_count`); the real N-API entry point
/// (`boundary::job::run_irregular_job`) always passes `None` here (no
/// per-call argument threads this through from TypeScript today), so only
/// this crate's own determinism-test suite uses the override.
pub fn run_job_from_json<'a>(
    request_json: &str,
    event_sink: &'a mut dyn IrregularComputeEventSink,
    cancellation_reason: Option<&'a mut (dyn FnMut() -> Option<NfpIfpAbortReason> + Send + 'a)>,
    thread_count_override: Option<usize>,
) -> (
    String,
    CacheTelemetrySnapshot,
    crate::search::layout_scorer::FreeMaterialCacheTelemetry,
    JobThreadCounts,
) {
    run_job_from_json_with_cache_caps_for_test(
        request_json,
        event_sink,
        cancellation_reason,
        thread_count_override,
        None,
    )
}

/// Per-call cache budgets for deterministic cache-pressure tests. Production
/// callers omit this override and continue to use the finite defaults.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CacheCapOverrides {
    pub geometry_bytes: u64,
    pub free_material_bytes: u64,
}

/// Non-semantic test seam that avoids process-global environment overrides.
pub(crate) fn run_job_from_json_with_cache_caps_for_test<'a>(
    request_json: &str,
    event_sink: &'a mut dyn IrregularComputeEventSink,
    cancellation_reason: Option<&'a mut (dyn FnMut() -> Option<NfpIfpAbortReason> + Send + 'a)>,
    thread_count_override: Option<usize>,
    cache_caps: Option<CacheCapOverrides>,
) -> (
    String,
    CacheTelemetrySnapshot,
    crate::search::layout_scorer::FreeMaterialCacheTelemetry,
    JobThreadCounts,
) {
    match decode_and_route(request_json) {
        Ok(prepared) => run_job_with_cache_caps(
            prepared,
            event_sink,
            cancellation_reason,
            thread_count_override,
            cache_caps,
        ),
        Err(error) => {
            let envelope = format!(r#"{{"ok":false,"error":{}}}"#, error.to_json());
            (
                envelope,
                CacheTelemetrySnapshot::default(),
                crate::search::layout_scorer::FreeMaterialCacheTelemetry::default(),
                JobThreadCounts {
                    requested: 1,
                    actual: 1,
                },
            )
        }
    }
}

/// Runs one already-decoded, already-routed job to completion on the calling
/// thread (the job's single coordinating thread -- `boundary::job` runs this
/// from `Task::compute`'s libuv worker thread, never the JS thread). Always
/// returns a JSON envelope string: `{"ok":true,"result":{...}}` or
/// `{"ok":false,"error":{"category",...}}` -- see this module's top doc for
/// why this is not a Rust `Result`. The second and third elements are
/// post-cleanup geometry and free-material cache telemetry snapshots. The
/// fourth element is the job pool's requested-and-actual thread-count
/// snapshot (`boundary::parallel::JobThreadCounts`), for the caller to
/// forward into the diagnostics sidecar; see `run_job_from_json`'s doc for
/// `thread_count_override`.
///
/// Constructs and installs this job's own `rayon::ThreadPool`
/// (`boundary::parallel::JobPool`) for the duration of the
/// `compute_irregular_nesting` call, per `cache-concurrency-design.md` §7
/// ("`boundary::run_job` constructs one `rayon::ThreadPool` at job start...
/// and uses it exclusively for that job's parallel work"). The pool (and
/// its worker threads) is dropped, and the thread-local installed-pool slot
/// cleared, when this function returns -- including on an early return via
/// `?`/panic-unwind, since the guard's `Drop` runs regardless (see
/// `JobPoolGuard`'s own doc).
pub fn run_job<'a>(
    prepared: PreparedRequest,
    event_sink: &'a mut dyn IrregularComputeEventSink,
    cancellation_reason: Option<&'a mut (dyn FnMut() -> Option<NfpIfpAbortReason> + Send + 'a)>,
    thread_count_override: Option<usize>,
) -> (
    String,
    CacheTelemetrySnapshot,
    crate::search::layout_scorer::FreeMaterialCacheTelemetry,
    JobThreadCounts,
) {
    run_job_with_cache_caps(
        prepared,
        event_sink,
        cancellation_reason,
        thread_count_override,
        None,
    )
}

fn run_job_with_cache_caps<'a>(
    prepared: PreparedRequest,
    event_sink: &'a mut dyn IrregularComputeEventSink,
    cancellation_reason: Option<&'a mut (dyn FnMut() -> Option<NfpIfpAbortReason> + Send + 'a)>,
    thread_count_override: Option<usize>,
    cache_caps: Option<CacheCapOverrides>,
) -> (
    String,
    CacheTelemetrySnapshot,
    crate::search::layout_scorer::FreeMaterialCacheTelemetry,
    JobThreadCounts,
) {
    let mut geometry_cache = cache_caps.map_or_else(GeometryCacheStore::new, |caps| {
        GeometryCacheStore::with_byte_cap(caps.geometry_bytes)
    });
    let mut free_material_cache = cache_caps.map_or_else(FreeMaterialCache::new, |caps| {
        FreeMaterialCache::with_byte_cap(caps.free_material_bytes)
    });
    let mut options = ComputeIrregularNestingOptions {
        event_sink: Some(event_sink),
        cancellation_reason,
        focused_complete_reconstruction_enabled: true,
    };

    let job_pool = JobPool::new(thread_count_override);
    let thread_counts = job_pool.thread_counts();

    // The whole job body runs inside the pool (`run_scoped`): the
    // coordinating code executes on a pool worker with the job-pool slot
    // installed there, so every nested `with_job_pool` entry is an inline
    // call on the current pool instead of a per-chunk cross-thread
    // injection. See `boundary::parallel::JobPool::run_scoped`'s doc for
    // the measured cost this collapses.
    let outcome = job_pool.run_scoped(|| {
        compute_irregular_nesting(
            &prepared.request,
            &prepared.settings,
            &mut options,
            &mut geometry_cache,
            &mut free_material_cache,
        )
    });

    let json = match outcome {
        Ok(result) => {
            let dto = project_result(&result);
            let result_json = serde_json::to_string(&dto).expect("result DTO always serializes");
            format!(r#"{{"ok":true,"result":{result_json}}}"#)
        }
        Err(error) => {
            let boundary_error: BoundaryError = (&error).into();
            format!(r#"{{"ok":false,"error":{}}}"#, boundary_error.to_json())
        }
    };
    free_material_cache.clear_and_shrink();
    geometry_cache.clear_and_shrink();
    let geometry_cache_telemetry = geometry_cache.telemetry().clone();
    let free_material_telemetry = free_material_cache.telemetry().clone();
    (
        json,
        geometry_cache_telemetry,
        free_material_telemetry,
        thread_counts,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nfp_ifp::NfpIfpAbortReason;
    use crate::result::progress::NullEventSink;

    fn mixed61_like_request_json() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "jobId": "job-run-job-test",
            "sheet": {"width": 400.0, "height": 400.0, "label": "sheet-1"},
            "padding": 2.0,
            "pieces": [
                {
                    "id": "piece-1",
                    "sourcePieceId": "source-1",
                    "realBounds": {"x": 0.0, "y": 0.0, "width": 60.0, "height": 40.0},
                    "paddedBounds": {
                        "x": 0.0, "y": 0.0, "width": 64.0, "height": 44.0,
                        "longestEdge": 64.0, "area": 2816.0, "imbalance": 20.0
                    },
                    "padding": 2.0,
                    "allowRotation": true
                }
            ],
            "sourcePieces": [
                {
                    "id": "source-1",
                    "sourceFileId": "file-1",
                    "label": "square",
                    "realBounds": {"x": 0.0, "y": 0.0, "width": 60.0, "height": 40.0},
                    "geometry": {
                        "entityType": "PRESET_SHAPE",
                        "closed": true,
                        "segments": [
                            {"kind": "line", "x1": 0.0, "y1": 0.0, "x2": 60.0, "y2": 0.0},
                            {"kind": "line", "x1": 60.0, "y1": 0.0, "x2": 60.0, "y2": 40.0},
                            {"kind": "line", "x1": 60.0, "y1": 40.0, "x2": 0.0, "y2": 40.0},
                            {"kind": "line", "x1": 0.0, "y1": 40.0, "x2": 0.0, "y2": 0.0}
                        ]
                    },
                    "warnings": []
                }
            ],
            "options": {
                "allowGlobalRotation": true,
                "timeoutMs": 60000.0,
                "workerMode": "irregular-convex-v2",
                "historyMode": "off",
                "irregularSettings": {
                    "geometry": {
                        "flatteningSagToleranceMm": 0.25,
                        "clearanceSafetyMarginMm": 0.25,
                        "geometryBackendId": "clipper2-rs-vendor",
                        "geometryBackendVersion": "0"
                    },
                    "optimizer": {
                        "orderWindow": 4,
                        "beamWidth": 4,
                        "transformCap": 4,
                        "gaPopulation": 4,
                        "gaTimeBudgetMs": 0,
                        "gaSeed": "default",
                        "intrinsicSharedArchiveEnabled": true
                    }
                }
            }
        })
    }

    const TIMING_ONLY_FIELD_NAMES: &[&str] = &[
        "runtimeMs",
        "elapsedMs",
        "preflightRuntimeMs",
        "completeArchiveRuntimeMs",
        "prefixTerminalizationMs",
        "coldSearchMs",
        "topologyMeasurementMs",
        "contactMeasurementMs",
        "serializedTraceBytes",
        "peakRssDeltaBytes",
    ];

    fn normalize_timing_only_fields(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(items) => {
                serde_json::Value::Array(items.iter().map(normalize_timing_only_fields).collect())
            }
            serde_json::Value::Object(fields) => {
                let mut normalized = serde_json::Map::with_capacity(fields.len());
                for (key, field_value) in fields {
                    if TIMING_ONLY_FIELD_NAMES.contains(&key.as_str()) {
                        normalized.insert(
                            key.clone(),
                            serde_json::Value::String("<timing: present>".to_string()),
                        );
                    } else {
                        normalized.insert(key.clone(), normalize_timing_only_fields(field_value));
                    }
                }
                serde_json::Value::Object(normalized)
            }
            other => other.clone(),
        }
    }

    #[test]
    fn run_job_returns_an_ok_envelope_for_a_real_one_piece_request() {
        let json = mixed61_like_request_json().to_string();
        let prepared = decode_and_route(&json).expect("request decodes and routes");
        let mut sink = NullEventSink;
        let (envelope, _cache, _free_material_telemetry, _threads) =
            run_job(prepared, &mut sink, None, None);
        let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
        assert_eq!(parsed["ok"], serde_json::json!(true));
        assert!(parsed["result"]["placedCollisionGeometries"].is_array());
        assert!(parsed["result"]["portfolio"]["status"].is_string());
    }

    #[test]
    fn decode_and_route_rejects_archive_ineligible_settings_before_running() {
        let mut json = mixed61_like_request_json();
        json["options"]["irregularSettings"]["optimizer"]["intrinsicSharedArchiveEnabled"] =
            serde_json::json!(false);
        let error = decode_and_route(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "not_implemented");
    }

    #[test]
    fn run_job_returns_an_err_envelope_when_source_geometry_is_missing() {
        let mut json = mixed61_like_request_json();
        json["sourcePieces"] = serde_json::json!([]);
        let prepared = decode_and_route(&json.to_string()).expect("request decodes and routes");
        let mut sink = NullEventSink;
        let (envelope, cache_telemetry, free_material_telemetry, _threads) =
            run_job(prepared, &mut sink, None, None);
        assert_eq!(cache_telemetry.current_bytes, 0);
        assert!(cache_telemetry
            .namespaces
            .values()
            .all(|counters| counters.entries == 0 && counters.approx_bytes == 0));
        assert_eq!(free_material_telemetry.entries, 0);
        assert_eq!(free_material_telemetry.current_bytes, 0);
        let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
        assert_eq!(parsed["ok"], serde_json::json!(false));
        assert_eq!(
            parsed["error"]["category"],
            serde_json::json!("irregular_source_geometry_missing")
        );
    }

    #[test]
    fn run_job_preserves_each_cancellation_reason_in_the_typed_failure_envelope() {
        for (reason, category, context_reason) in [
            (
                NfpIfpAbortReason::Cancelled,
                "worker_cancelled",
                "cancelled",
            ),
            (NfpIfpAbortReason::Deadline, "worker_timeout", "deadline"),
        ] {
            let json = mixed61_like_request_json().to_string();
            let prepared = decode_and_route(&json).expect("request decodes and routes");
            let mut sink = NullEventSink;
            let mut cancellation_reason = || Some(reason);
            let (envelope, _cache, _free_material_telemetry, _threads) =
                run_job(prepared, &mut sink, Some(&mut cancellation_reason), None);
            let parsed: serde_json::Value =
                serde_json::from_str(&envelope).expect("envelope is JSON");
            assert_eq!(parsed["ok"], serde_json::json!(false));
            assert_eq!(parsed["error"]["category"], serde_json::json!(category));
            assert_eq!(
                parsed["error"]["context"]["reason"],
                serde_json::json!(context_reason)
            );
        }
    }

    // `run_job_from_json` (the real `boundary::job::RunIrregularJobTask::compute`
    // entry point): every failure mode -- malformed JSON, archive-ineligible
    // routing, and a genuine algorithm failure alike -- resolves through the
    // same envelope shape, never a distinct Rust `Result::Err`. See this
    // module's top doc, "Routing/decode failures resolve too."

    #[test]
    fn run_job_from_json_resolves_an_err_envelope_for_malformed_json() {
        let mut sink = NullEventSink;
        let (envelope, cache_telemetry, free_material_telemetry, _threads) =
            run_job_from_json("not json", &mut sink, None, None);
        assert_eq!(cache_telemetry, CacheTelemetrySnapshot::default());
        assert_eq!(
            free_material_telemetry,
            crate::search::layout_scorer::FreeMaterialCacheTelemetry::default()
        );
        let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
        assert_eq!(parsed["ok"], serde_json::json!(false));
        assert_eq!(
            parsed["error"]["category"],
            serde_json::json!("worker_protocol_error")
        );
    }

    #[test]
    fn run_job_from_json_resolves_an_err_envelope_for_archive_ineligible_routing() {
        let mut json = mixed61_like_request_json();
        json["options"]["irregularSettings"]["optimizer"]["intrinsicSharedArchiveEnabled"] =
            serde_json::json!(false);
        let mut sink = NullEventSink;
        let (envelope, cache_telemetry, free_material_telemetry, _threads) =
            run_job_from_json(&json.to_string(), &mut sink, None, None);
        assert_eq!(cache_telemetry, CacheTelemetrySnapshot::default());
        assert_eq!(free_material_telemetry.entries, 0);
        assert_eq!(free_material_telemetry.current_bytes, 0);
        let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
        assert_eq!(parsed["ok"], serde_json::json!(false));
        assert_eq!(
            parsed["error"]["category"],
            serde_json::json!("not_implemented")
        );
        assert_eq!(
            parsed["error"]["operation"],
            serde_json::json!("legacy-portfolio-unsupported")
        );
    }

    #[test]
    fn cache_caps_and_thread_counts_preserve_result_error_order_and_hash_bytes() {
        let path = format!(
            "{}/tests/vectors/thread-equality-mixed61-20-piece-request.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let request_json = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read fixture {path}: {error}"));
        let cap_cases = [
            ("default", None),
            (
                "effectively-unlimited",
                Some(CacheCapOverrides {
                    geometry_bytes: u64::MAX,
                    free_material_bytes: u64::MAX,
                }),
            ),
            (
                "tight",
                Some(CacheCapOverrides {
                    geometry_bytes: 256 * 1024,
                    free_material_bytes: 128 * 1024,
                }),
            ),
            (
                "zero",
                Some(CacheCapOverrides {
                    geometry_bytes: 0,
                    free_material_bytes: 0,
                }),
            ),
        ];
        let mut baseline: Option<(String, Vec<u8>)> = None;
        let mut tight_evictions = 0;
        let mut zero_cap_rejections = 0;

        for (cap_name, caps) in cap_cases {
            for thread_count in [1, 2] {
                let mut sink = NullEventSink;
                let (envelope, geometry, free_material, resolved_threads) =
                    run_job_from_json_with_cache_caps_for_test(
                        &request_json,
                        &mut sink,
                        None,
                        Some(thread_count),
                        caps,
                    );
                assert_eq!(resolved_threads.requested, thread_count);
                assert_eq!(
                    resolved_threads.actual, thread_count,
                    "a successful pool build must report an actual worker count equal to \
                     the requested one"
                );
                let parsed: serde_json::Value =
                    serde_json::from_str(&envelope).expect("envelope must be valid JSON");
                assert_eq!(parsed["ok"], serde_json::json!(true));
                let normalized = normalize_timing_only_fields(&parsed);
                let bytes = serde_json::to_vec(&normalized)
                    .expect("the timing-normalized envelope always serializes");
                if let Some((baseline_name, baseline_bytes)) = &baseline {
                    assert_eq!(
                        &bytes, baseline_bytes,
                        "cap={cap_name} threads={thread_count} changed result/error/order/hash bytes from {baseline_name}"
                    );
                } else {
                    baseline = Some((format!("cap={cap_name} threads={thread_count}"), bytes));
                }
                if cap_name == "tight" {
                    assert_eq!(geometry.oversized_rejections, 0);
                    tight_evictions += geometry.evictions + free_material.evictions;
                }
                if cap_name == "zero" {
                    zero_cap_rejections +=
                        geometry.oversized_rejections + free_material.oversized_rejections;
                }
            }
        }
        assert!(
            tight_evictions > 0,
            "tight caps must force deterministic recomputation"
        );
        assert!(
            zero_cap_rejections > 0,
            "zero cache caps must reject cache publications without changing semantics"
        );
    }

    fn profile_mixed61(cache_caps: Option<CacheCapOverrides>) {
        let path = format!(
            "{}/tests/vectors/mixed61-2000x2700-compact-request.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let fixture_json = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read fixture {path}: {error}"));
        let fixture: serde_json::Value =
            serde_json::from_str(&fixture_json).expect("profile fixture must be JSON");
        let coordinator_request = &fixture["request"];
        let boundary_request = serde_json::json!({
            "version": 1,
            "jobId": "profile-mixed61-2000x2700",
            "sheet": coordinator_request["sheet"],
            "padding": coordinator_request["padding"],
            "pieces": coordinator_request["pieces"],
            "sourcePieces": coordinator_request["sourcePieces"],
            "options": {
                "allowGlobalRotation": coordinator_request["allowGlobalRotation"],
                "allowGlobalMirror": coordinator_request["allowGlobalMirror"],
                "timeoutMs": 180000,
                "workerMode": "irregular-convex-v2",
                "historyMode": coordinator_request["historyMode"],
                "historyScope": "winning_path",
                "strategySelectionMode": "all_configured",
                "strategyIds": ["short-fill-bottom-left-then-short-side-fit"],
                "layoutSelectionStrategyId": "compact-first",
                "finalSelectionMode": "manual",
                "topN": 3,
                "irregularSettings": coordinator_request["settings"],
            }
        });
        let request_json = serde_json::to_string(&boundary_request)
            .expect("profile fixture request always serializes");
        let started = std::time::Instant::now();
        let mut sink = NullEventSink;
        let (envelope, geometry, free_material, threads) =
            run_job_from_json_with_cache_caps_for_test(
                &request_json,
                &mut sink,
                None,
                Some(1),
                cache_caps,
            );
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        let parsed: serde_json::Value =
            serde_json::from_str(&envelope).expect("profile envelope must be JSON");
        assert_eq!(parsed["ok"], serde_json::json!(true));
        let normalized = normalize_timing_only_fields(&parsed);
        let normalized_json =
            serde_json::to_string(&normalized).expect("normalized JSON serializes");
        let namespace_hits: u64 = geometry.namespaces.values().map(|item| item.hits).sum();
        let namespace_misses: u64 = geometry.namespaces.values().map(|item| item.misses).sum();
        let cloning_hits: u64 = geometry
            .namespaces
            .values()
            .map(|item| item.cloning_hits)
            .sum();
        println!(
            "PROFILE {}",
            serde_json::json!({
                "threads": threads,
                "elapsedMs": elapsed_ms,
                "normalizedEnvelopeSha256": crate::geometry::hash::sha256_hex(&normalized_json),
                "geometry": {
                    "capBytes": geometry.cap_bytes,
                    "peakBytes": geometry.peak_bytes,
                    "hits": namespace_hits,
                    "misses": namespace_misses,
                    "cloningHits": cloning_hits,
                    "evictions": geometry.evictions,
                    "oversizedRejections": geometry.oversized_rejections,
                },
                "freeMaterial": free_material,
            })
        );
    }

    #[test]
    #[ignore = "serial Mixed-61 profiling evidence"]
    fn profile_mixed61_default_cache_caps() {
        profile_mixed61(None);
    }

    #[test]
    #[ignore = "serial Mixed-61 profiling evidence"]
    fn profile_mixed61_effectively_unlimited_cache_caps() {
        profile_mixed61(Some(CacheCapOverrides {
            geometry_bytes: u64::MAX,
            free_material_bytes: u64::MAX,
        }));
    }

    #[test]
    fn run_job_from_json_reports_cleaned_cache_snapshots_for_a_real_request() {
        let json = mixed61_like_request_json().to_string();
        let mut sink = NullEventSink;
        let (envelope, cache_telemetry, free_material_telemetry, _threads) =
            run_job_from_json(&json, &mut sink, None, None);
        assert_eq!(cache_telemetry.current_bytes, 0);
        assert!(cache_telemetry.peak_bytes > 0);
        assert!(cache_telemetry.admissions > 0);
        assert!(cache_telemetry
            .namespaces
            .values()
            .all(|counters| counters.entries == 0 && counters.approx_bytes == 0));
        assert_eq!(free_material_telemetry.entries, 0);
        assert_eq!(free_material_telemetry.current_bytes, 0);
        let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
        assert_eq!(parsed["ok"], serde_json::json!(true));
    }
}
