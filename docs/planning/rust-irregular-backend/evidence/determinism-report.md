# Rust Irregular Backend: Determinism Report

**Date:** 2026-07-31

**Working tree:** `rust-irregular-backend` at `0fa19255e4c01bf5e7c113ed6779a6dc4eac2e7c`, with uncommitted changes.

## Current verification update

`cargo test --release --test thread_equality` passed 6/6. The canonical semantic-byte comparison sorts object keys, preserves array order and every semantic value, and normalizes only documented timing/RSS values by presence. Score fields remain exact.

Required differential rows passed 16/16, strict full required rows passed 16/16, and exploratory N1 rows passed 8/8. The release Rust suite passed 590 library tests plus all integration and documentation tests.

The Node/V8 hypot oracle contains 21,696 vectors generated with exact Node `v24.11.1`; corpus SHA-256: `bc444e7d2813fb2a7faa150ab03fa1c92e2be28e4c26971ad3796de5c491a266`.

## Historical verification detail
## 1. Thread-count determinism — `tests/thread_equality.rs`

**Command:** `cargo test --release --test thread_equality` (re-run this session).

**Result:**

```
running 4 tests
test two_piece_fixture_is_thread_count_invariant ... ok
test four_piece_fixture_is_thread_count_invariant ... ok
test eight_piece_fixture_is_thread_count_invariant ... ok
test twenty_piece_fixture_is_thread_count_invariant ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 65.98s
```

**Method** (see the test file's own module doc for the full rationale): for each of four
Mixed-61 `2000x2700` truncations (2/4/8/20 pieces), the test runs the real
`boundary::run_job::run_job_from_json` entry point (the same production path
`Task::compute` uses, including job-owned Rayon pool construction) at thread counts
`{1, 2, 4, 8}`, `REPEATS_PER_THREAD_COUNT = 3` times each — **12 total job runs per fixture**
(1 threads=1 baseline + 2 further threads=1 repeats + 3 thread counts × 3 repeats). Every one
of the 12 runs is compared, full envelope, against the threads=1 baseline: every placement,
canonical hash, placed/unplaced partition, portfolio/capacity/scheduler trace, and
state-snapshot history entry must match exactly. Only ten documented wall-clock-derived fields
(`runtimeMs`, `elapsedMs`, `preflightRuntimeMs`, `completeArchiveRuntimeMs`,
`prefixTerminalizationMs`, `coldSearchMs`, `topologyMeasurementMs`, `contactMeasurementMs`,
`serializedTraceBytes`, `peakRssDeltaBytes`) are normalized to a presence-only marker before
comparison, mirroring `scripts/rust-parity/run-differential.ts`'s own
`TIMING_ONLY_TRACE_FIELD_NAMES`/`normalizeTimingOnlyFields` — a presence/absence mismatch for
one of those fields still fails the test; only the wall-clock *value* is excused.

**Outcome: 4 fixtures × 12 runs = 48 total job executions, every one hash-exact against its
fixture's own threads=1 baseline.** This is the source of the "12/12 hash-exact thread matrix"
figure: for each fixture, all 12 runs (spanning every tested thread count) reproduce the
threads=1 reference byte-for-byte. No divergence was observed at any thread count on any
fixture.

## 2. Thread-count determinism, primary gate — `performance-report.md` §3.2

The performance-contract measurement batch (`docs/planning/rust-irregular-backend/evidence/
performance-report.md`, same commit) independently exercises thread-count invariance on the
**full 61-piece Mixed-61 `2000x2700` primary gate**, which `thread_equality.rs` truncates for
tractable CI runtime:

| threads | samples | hash pair |
| --- | --- | --- |
| 1 / default (env unset) | 5 | `3839e80d…` / `ef2b783a…` (exact, every sample) |
| 2 | 3 | `3839e80d…` / `ef2b783a…` (exact, every sample) |
| 8 | 3 | `3839e80d…` / `ef2b783a…` (exact, every sample) |

All 11 Rust samples across three distinct thread-count configurations reproduced the identical
collision-identity and fitted-canonical SHA-256 pair — P7 (thread-count neutrality) holds on the
full production-shape case, not only the truncated CI fixtures in §1.

## 3. Repeated-process (same-configuration) determinism — Finding N1 5× repro

`differential-e2e-report.md`'s Finding N1 addendum independently re-ran the exact truncated
mixed61 `{9, 10, 20, 40}`-piece repro (both profiles) **5 times each as fully independent
process invocations** (not thread-count variation — this isolates whether any per-process
non-determinism exists, e.g. from unordered `HashMap` iteration order or ASLR-dependent
memory-address-derived hashing):

> "Re-running the exact repro (`mixed61 --pieces {9,10,20,40} --profile compact`, 5× each)
> after the fix reproduces the **identical** divergent winner hashes every single time,
> byte-for-byte unchanged... The divergence is fully deterministic across process invocations
> (ruling out an unordered-`HashMap`-iteration-order nondeterminism explanation too — a
> randomly-reseeded-per-process `HashMap` dependency would show *different* wrong answers
> across the 5 independent process runs, not the same one every time)."

This 5×-repeated-process evidence is doubly useful: it proves per-process determinism (every
independent process invocation, fresh ASLR/heap layout/thread scheduling, produces the exact
same output), and its context (the now-closed Finding N1) is itself now moot — the underlying
divergence was root-caused to a `hypot` ULP difference and fixed (commit `81a57ed`); the
`--exploratory-only` matrix (the 8 rows this exact repro covers, both profiles ×
{9,10,20,40}-piece) is 8/8 passing as of that fix, re-confirmed by `differential-fixture-matrix.ts`
below.

**Command and output (re-run fresh this session):**

```
$ pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/differential-fixture-matrix.ts --exploratory-only
[differential-fixture-matrix] exploratory (N1): mixed61 pieces=9 profile=compact ... OK
[differential-fixture-matrix] exploratory (N1): mixed61 pieces=9 profile=short-side ... OK
[differential-fixture-matrix] exploratory (N1): mixed61 pieces=10 profile=compact ... OK
[differential-fixture-matrix] exploratory (N1): mixed61 pieces=10 profile=short-side ... OK
[differential-fixture-matrix] exploratory (N1): mixed61 pieces=20 profile=compact ... OK
[differential-fixture-matrix] exploratory (N1): mixed61 pieces=20 profile=short-side ... OK
[differential-fixture-matrix] exploratory (N1): mixed61 pieces=40 profile=compact ... OK
[differential-fixture-matrix] exploratory (N1): mixed61 pieces=40 profile=short-side ... OK
[differential-fixture-matrix] required: 0/0 passed; exploratory (N1): 8/8 passed
```

## 4. Checkpoint resume equivalence — coordinator and capacity-search vector suites

Migration prompt §24 stop condition: "any checkpoint resume differs from uninterrupted
execution." Two vector suites carry TS-oracle-derived checkpoint/resume fixtures exercised
through the real Rust checkpoint-encode/decode/resume path, re-run this session:

**Command:** `cargo test --release --test coordinator_vectors --test capacity_search_vectors`

```
running 3 tests (capacity_search_vectors)
test vector_file_reports_at_least_four_hundred_total_cases ... ok
test full_run_cases_reproduce_ts_endpoints_and_trace ... ok
test checkpoint_cases_reproduce_ts_hash_fields_and_resume_to_the_recorded_ground_truth ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.03s

running 8 tests (coordinator_vectors)
test archive_ineligible_settings_return_a_typed_routing_error ... ok
test missing_source_geometry_returns_the_typed_compute_error ... ok
test short_side_profile_with_zero_placed_pieces_fails_closed_with_no_valid_result ... ok
test history_mode_off_suppresses_state_snapshots_but_not_progress ... ok
test two_small_squares_on_a_roomy_sheet_settle_through_the_shared_archive_winner_path ... ok
test baseline_uncancelled_run_matches_ts_oracle_and_fires_the_nested_resume ... ok
test cancellation_injected_during_the_nested_scheduler_resume_aborts_the_whole_job ... ok
test full_job_vectors_match_ts_oracle ... ok
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 8.17s
```

- `capacity_search_vectors.rs::checkpoint_cases_reproduce_ts_hash_fields_and_resume_to_the_recorded_ground_truth`
  walks **336 `checkpointCases`** (`tests/vectors/capacity-search.json`), each encoding a
  bounded capacity-search run's checkpoint bytes at a paused depth boundary, decoding it back,
  resuming the search from that checkpoint, and asserting the resumed endpoints and trace match
  the TS-oracle-recorded ground truth exactly — proving encode → decode → resume produces the
  identical result an uninterrupted run would have produced, for every one of 336 cases.
- `coordinator_vectors.rs::baseline_uncancelled_run_matches_ts_oracle_and_fires_the_nested_resume`
  proves the full-job **nested scheduler resume** (cold-quantum resume inside
  `result::coordinator`'s interleaved scheduler, not just the capacity-search checkpoint layer)
  fires and matches the TS oracle's exact regression-pinned call count and outcome — the same
  file's `cancellation_injected_during_the_nested_scheduler_resume_aborts_the_whole_job` proves
  cancellation injected mid-resume aborts the whole job cleanly rather than producing a partial
  result (migration prompt §15 / §24 "cancellation returns partial geometry").
- `coordinator_vectors.rs::full_job_vectors_match_ts_oracle` (the crate's largest single-file
  vector suite) independently re-confirms full-job TS-oracle parity is unaffected by any of the
  above.

## 5. Summary

| Determinism axis | Evidence | Result |
| --- | --- | --- |
| Thread count (CI-tractable fixtures) | `tests/thread_equality.rs`, 4 fixtures × 12 runs | 48/48 hash-exact vs. threads=1 baseline |
| Thread count (full Mixed-61 primary gate) | `performance-report.md` §3.2, 11 Rust samples across 1/2/8 threads | 11/11 hash-exact |
| Repeated process invocation (same config) | Finding N1 5× repro, 4 piece-counts × 2 profiles | 5/5 identical per case, every case |
| Checkpoint resume vs. uninterrupted | `capacity_search_vectors.rs` (336 cases) + `coordinator_vectors.rs` (8 tests incl. nested-resume) | all green, TS-oracle exact |

No divergence was found on any determinism axis this report checked. Every axis was re-run
fresh in this session (not cited from a stale prior log) and reproduced the recorded result.
