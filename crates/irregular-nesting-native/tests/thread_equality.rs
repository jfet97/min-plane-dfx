//! Stage 4 thread-equality determinism suite (migration-prompt §14.4,
//! `parallelism-inventory.md` §1.3 "T-STD", this task's own brief item 4):
//! proves every Rayon parallel site this crate has enabled so far
//! (`boundary::parallel`'s job-owned pool; `result::coordinator`'s
//! `PAR-GEOM-01` piece-preparation dispatch; `nfp_ifp::boundary_core`'s
//! `PAR-CACHE-01`/`PAR-NFP-01` NFP-miss precompute) produces a
//! **byte-identical** full result envelope regardless of how many Rayon
//! worker threads the job's pool was built with.
//!
//! Runs four representative fixtures (2/4/8/20-piece truncations of the
//! Mixed-61 `2000x2700` request, matching this task's brief "2/4/8-piece +
//! one 20-piece" requirement and `scripts/rust-parity/run-differential.ts`'s
//! own truncation convention: `pieces.slice(0, n)` plus the referenced
//! `sourcePieces` only) at thread counts `{1, 2, 4, 8}`, three repeats each,
//! through the exact same `boundary::run_job::run_job_from_json` entry
//! point `boundary::job::run_irregular_job`'s `Task::compute` calls in
//! production -- so this test exercises the real job-owned-pool
//! construction/installation path, not a lower-level seam.
//!
//! `run_job_from_json`'s returned JSON envelope is the full projected
//! result (`{"ok":true,"result": ...}` with every placement, canonical
//! hash, portfolio/capacity/scheduler trace, and state-snapshot history the
//! real N-API surface returns) or a typed error envelope -- see
//! `boundary::run_job`'s own top doc for why this is never a bare Rust
//! `Result`. Diagnostics like `thread_count_used`/`wall_clock_ms` live in a
//! separate sidecar (`boundary::diagnostics::JobDiagnostics`), never merged
//! into this envelope -- but the envelope itself still carries a handful of
//! genuinely wall-clock-derived fields inside its traces (`runtimeMs`,
//! `focusedCompleteReconstructionTrace.runtimeMs`, etc.), exactly as
//! documented by `boundary::result`'s own "Non-semantic timing/byte-count
//! fields" doc section and by `scripts/rust-parity/run-differential.ts`'s
//! `TIMING_ONLY_TRACE_FIELD_NAMES` constant (reproduced verbatim below,
//! same field-name list, same "presence-only, never by value" comparison
//! rule this crate's own TS-oracle differential harness already
//! establishes as the correct definition of "matches exactly" for this
//! envelope shape). Every other field -- every placement, canonical hash,
//! placed/unplaced partition, portfolio/capacity/scheduler status, and
//! state-snapshot history entry -- is compared by exact value, satisfying
//! this task's brief "full projection incl. traces."

use std::fs;

use irregular_nesting_native::boundary::run_job::run_job_from_json;
use irregular_nesting_native::result::progress::NullEventSink;
use serde_json::Value;

const THREAD_COUNTS: [usize; 4] = [1, 2, 4, 8];
const REPEATS_PER_THREAD_COUNT: usize = 3;

/// Verbatim copy of `scripts/rust-parity/run-differential.ts`'s
/// `TIMING_ONLY_TRACE_FIELD_NAMES` -- the one place this crate's own
/// TS-oracle differential harness already draws the "real field, compared
/// presence-only, never by value" line for wall-clock-derived content. Reused
/// here rather than re-derived so this test's definition of "the envelope
/// matches" is identical to the definition the rest of this crate's parity
/// suite already uses, not a second, independently-invented one.
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

const TIMING_PRESENT_MARKER: &str = "<timing: present>";

/// Walks `value` recursively and replaces every object field whose key is
/// in [`TIMING_ONLY_FIELD_NAMES`] with a fixed presence marker, at any
/// nesting depth, in any of the envelope's traces -- mirroring
/// `run-differential.ts`'s `normalizeTimingOnlyFields` exactly. A
/// presence/absence mismatch for one of these fields still fails the
/// comparison (the marker only replaces a *present* field's *value*); a
/// wall-clock value mismatch never does.
fn normalize_timing_only_fields(value: &Value) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.iter().map(normalize_timing_only_fields).collect())
        }
        Value::Object(fields) => {
            let mut normalized = serde_json::Map::with_capacity(fields.len());
            for (key, field_value) in fields {
                if TIMING_ONLY_FIELD_NAMES.contains(&key.as_str()) {
                    normalized.insert(
                        key.clone(),
                        Value::String(TIMING_PRESENT_MARKER.to_string()),
                    );
                } else {
                    normalized.insert(key.clone(), normalize_timing_only_fields(field_value));
                }
            }
            Value::Object(normalized)
        }
        other => other.clone(),
    }
}

fn fixture_path(piece_count: usize) -> String {
    format!(
        "{}/tests/vectors/thread-equality-mixed61-{piece_count}-piece-request.json",
        env!("CARGO_MANIFEST_DIR")
    )
}

/// Runs the job once at `thread_count` and returns its envelope, already
/// timing-normalized (see [`normalize_timing_only_fields`]) and re-parsed
/// so `assert_eq!` compares structured JSON `Value`s (order-insensitive on
/// object keys, matching `boundary::result`'s own "field order deliberately
/// not required to match" convention) rather than raw byte strings, which
/// would spuriously fail on the wall-clock fields this comparison
/// deliberately normalizes.
fn run_once(request_json: &str, thread_count: usize) -> Value {
    let mut sink = NullEventSink;
    let (envelope, _cache, resolved_thread_count) =
        run_job_from_json(request_json, &mut sink, None, Some(thread_count));
    assert_eq!(
        resolved_thread_count, thread_count,
        "run_job_from_json must resolve to exactly the requested override thread count"
    );
    let parsed: Value = serde_json::from_str(&envelope).expect("envelope must be valid JSON");
    normalize_timing_only_fields(&parsed)
}

/// Sanity check every fixture actually ran the real algorithm (not an
/// error envelope) before trusting equality across thread counts to mean
/// anything -- an empty/`ok:false` envelope compared to itself would
/// trivially "match" without proving anything about the parallel sites.
fn assert_envelope_is_a_real_success(envelope: &Value, piece_count: usize) {
    assert_eq!(
        envelope["ok"],
        serde_json::json!(true),
        "fixture with {piece_count} pieces must resolve ok:true (got {envelope})"
    );
    let placed = envelope["result"]["placedCollisionGeometries"]
        .as_array()
        .unwrap_or_else(|| panic!("result.placedCollisionGeometries must be an array: {envelope}"));
    assert!(
        !placed.is_empty(),
        "fixture with {piece_count} pieces must place at least one piece"
    );
}

fn thread_equality_case(piece_count: usize) {
    let path = fixture_path(piece_count);
    let request_json = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read fixture {path}: {error}"));

    // Baseline: three repeats at threads=1 must already agree with each
    // other (self-consistency at the historical single-thread baseline),
    // and must be a genuine success envelope.
    let baseline = run_once(&request_json, 1);
    assert_envelope_is_a_real_success(&baseline, piece_count);
    for repeat in 1..REPEATS_PER_THREAD_COUNT {
        let envelope = run_once(&request_json, 1);
        assert_eq!(
            envelope, baseline,
            "pieces={piece_count} threads=1 repeat={repeat} diverged from repeat=0"
        );
    }

    // Every other thread count: three repeats each, every repeat asserted
    // identical (modulo the timing-only normalization above) to the
    // threads=1 baseline. This is the actual determinism proof
    // migration-prompt §14.4 asks for -- not merely "stable under
    // repetition at a fixed thread count" (T-STD's self-consistency check)
    // but "identical to the 1-thread reference result at every thread
    // count" (T-STD's stronger requirement, restated in this task's brief
    // as "asserting BYTE-IDENTICAL results").
    for &thread_count in THREAD_COUNTS.iter().filter(|&&count| count != 1) {
        for repeat in 0..REPEATS_PER_THREAD_COUNT {
            let envelope = run_once(&request_json, thread_count);
            assert_eq!(
                envelope, baseline,
                "pieces={piece_count} threads={thread_count} repeat={repeat} diverged from the \
                 threads=1 baseline -- a Rayon parallel site in this crate is not thread-count-\
                 invariant"
            );
        }
    }
}

#[test]
fn two_piece_fixture_is_thread_count_invariant() {
    thread_equality_case(2);
}

#[test]
fn four_piece_fixture_is_thread_count_invariant() {
    thread_equality_case(4);
}

#[test]
fn eight_piece_fixture_is_thread_count_invariant() {
    thread_equality_case(8);
}

#[test]
fn twenty_piece_fixture_is_thread_count_invariant() {
    thread_equality_case(20);
}
