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
//! `Promise`. Relying on that as "the routing error the TS side maps to its
//! own TS-backend execution" would be a surprising, upgrade-fragile contract
//! (`instanceof Error` on a supposedly-`Promise`-typed return value). This
//! module instead gives `runIrregularJob` one uniform contract: it always
//! returns a real `Promise<string>` that always **resolves** with the same
//! `{"ok":true,"result":...}` / `{"ok":false,"error":{"category",...}}`
//! envelope, whether the failure is a malformed request, a failed
//! revalidation, archive-ineligible routing, an algorithm failure, or a
//! contained panic. The TypeScript integration layer distinguishes "route
//! this request to the TypeScript backend" from "this backend ran the
//! request and it failed" the same way for every one of those cases:
//! inspect `envelope.error.category`/`operation` (`"not_implemented"` /
//! `"legacy-portfolio-unsupported"` for the routing case specifically).

use crate::caches::GeometryCacheStore;
use crate::result::coordinator::{compute_irregular_nesting, ComputeIrregularNestingOptions};
use crate::result::progress::IrregularComputeEventSink;
use crate::search::layout_scorer::FreeMaterialCache;

use super::error::BoundaryError;
use super::parallel::JobPool;
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
/// second tuple element is `None` only when decoding/routing failed before a
/// job-local `GeometryCacheStore` was ever constructed (nothing to report
/// cache telemetry for). The third element is the Rayon thread count this
/// job's job-owned pool actually resolved to (`boundary::parallel`,
/// diagnostics-only per that module's doc); `1` when decoding/routing failed
/// before a pool was ever constructed.
/// `thread_count_override`, when `Some`, wins over the
/// `MIN_PLANE_IRREGULAR_NATIVE_THREADS` environment variable (see
/// `boundary::parallel::resolve_thread_count`); the real N-API entry point
/// (`boundary::job::run_irregular_job`) always passes `None` here (no
/// per-call argument threads this through from TypeScript today), so only
/// this crate's own determinism-test suite uses the override.
pub fn run_job_from_json<'a>(
    request_json: &str,
    event_sink: &'a mut dyn IrregularComputeEventSink,
    is_cancelled: Option<&'a mut (dyn FnMut() -> bool + 'a)>,
    thread_count_override: Option<usize>,
) -> (String, Option<GeometryCacheStore>, usize) {
    match decode_and_route(request_json) {
        Ok(prepared) => {
            let (envelope, cache, thread_count) =
                run_job(prepared, event_sink, is_cancelled, thread_count_override);
            (envelope, Some(cache), thread_count)
        }
        Err(error) => {
            let envelope = format!(r#"{{"ok":false,"error":{}}}"#, error.to_json());
            (envelope, None, 1)
        }
    }
}

/// Runs one already-decoded, already-routed job to completion on the calling
/// thread (the job's single coordinating thread -- `boundary::job` runs this
/// from `Task::compute`'s libuv worker thread, never the JS thread). Always
/// returns a JSON envelope string: `{"ok":true,"result":{...}}` or
/// `{"ok":false,"error":{"category",...}}` -- see this module's top doc for
/// why this is not a Rust `Result`. The third element is the resolved Rayon
/// thread count (`boundary::parallel`), for the caller to forward into the
/// diagnostics sidecar; see `run_job_from_json`'s doc for
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
    is_cancelled: Option<&'a mut (dyn FnMut() -> bool + 'a)>,
    thread_count_override: Option<usize>,
) -> (String, GeometryCacheStore, usize) {
    let mut geometry_cache = GeometryCacheStore::new();
    let mut free_material_cache = FreeMaterialCache::new();
    let mut options = ComputeIrregularNestingOptions {
        event_sink: Some(event_sink),
        is_cancelled,
        focused_complete_reconstruction_enabled: true,
    };

    let job_pool = JobPool::new(thread_count_override);
    let thread_count = job_pool.thread_count();
    let _pool_guard = job_pool.install();

    let outcome = compute_irregular_nesting(
        &prepared.request,
        &prepared.settings,
        &mut options,
        &mut geometry_cache,
        &mut free_material_cache,
    );

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
    (json, geometry_cache, thread_count)
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn run_job_returns_an_ok_envelope_for_a_real_one_piece_request() {
        let json = mixed61_like_request_json().to_string();
        let prepared = decode_and_route(&json).expect("request decodes and routes");
        let mut sink = NullEventSink;
        let (envelope, _cache, _threads) = run_job(prepared, &mut sink, None, None);
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
        let (envelope, _cache, _threads) = run_job(prepared, &mut sink, None, None);
        let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
        assert_eq!(parsed["ok"], serde_json::json!(false));
        assert_eq!(
            parsed["error"]["category"],
            serde_json::json!("irregular_source_geometry_missing")
        );
    }

    #[test]
    fn run_job_stops_immediately_when_already_cancelled() {
        let json = mixed61_like_request_json().to_string();
        let prepared = decode_and_route(&json).expect("request decodes and routes");
        let mut sink = NullEventSink;
        let mut always_cancelled = || true;
        let (envelope, _cache, _threads) = run_job(prepared, &mut sink, Some(&mut always_cancelled), None);
        let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
        assert_eq!(parsed["ok"], serde_json::json!(false));
        assert_eq!(
            parsed["error"]["category"],
            serde_json::json!("worker_cancelled")
        );
    }

    // `run_job_from_json` (the real `boundary::job::RunIrregularJobTask::compute`
    // entry point): every failure mode -- malformed JSON, archive-ineligible
    // routing, and a genuine algorithm failure alike -- resolves through the
    // same envelope shape, never a distinct Rust `Result::Err`. See this
    // module's top doc, "Routing/decode failures resolve too."

    #[test]
    fn run_job_from_json_resolves_an_err_envelope_for_malformed_json() {
        let mut sink = NullEventSink;
        let (envelope, cache, _threads) = run_job_from_json("not json", &mut sink, None, None);
        assert!(cache.is_none());
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
        let (envelope, cache, _threads) = run_job_from_json(&json.to_string(), &mut sink, None, None);
        assert!(cache.is_none());
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
    fn run_job_from_json_resolves_an_ok_envelope_and_a_populated_cache_for_a_real_request() {
        let json = mixed61_like_request_json().to_string();
        let mut sink = NullEventSink;
        let (envelope, cache, _threads) = run_job_from_json(&json, &mut sink, None, None);
        assert!(cache.is_some());
        let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
        assert_eq!(parsed["ok"], serde_json::json!(true));
    }
}
