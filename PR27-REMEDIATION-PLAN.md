# PR 27 Remediation Plan

## Context

PR 27 ports archive-eligible Compact and Compact Short Side irregular nesting to Rust through napi-rs and Rayon. The review found release, parity, cancellation, validation, cache, licensing, and test-evidence defects that prevent merging the native backend safely.

The binding contract remains unchanged for this remediation: existing TypeScript and Node/V8 semantics, fixtures, hashes, comparator winners, traces, ledgers, checkpoints, history, and output quality must remain stable. Only execution-time improvements are accepted. TypeScript remains the maintained fallback, differential oracle, and runtime authority.

The native backend will be completed and merged with the custom V8-compatible `js_math::hypot`. Replacing it with `f64::hypot` or `libm::hypot` is deferred to a separate post-merge experiment because both alternatives already show binary64 differences at semantic call sites.

All behavioral changes follow TDD: add a focused failing regression, verify the expected failure, implement the minimum fix, run the focused test, then run the relevant broader gates before starting the next cycle.

## 1. Establish a trustworthy failing baseline

Critical files:

- `.github/workflows/rust-native.yml`
- `package.json`
- `scripts/rust-parity/differential-fixture-matrix.ts`
- `scripts/rust-parity/run-differential.ts`

Steps:

1. Reproduce the currently failing native smoke and required differential CI jobs from a clean frozen install.
2. Capture the exact failing command, fixture row, semantic path, TypeScript value, Rust value, and first differing canonical byte or `f64::to_bits()` value.
3. Re-run each failure without code changes. If either failure is not repeatable, stop that fix and diagnose nondeterminism first.
4. Add a minimal regression test for every reproducible failure before changing production code. Do not update fixtures, hashes, tolerances, or expected outputs to make the gate green.

Acceptance:

- The initial failures are reproducible and represented by focused red tests.
- The existing oracle remains authoritative.

## 2. Preserve and prove Node/V8 `Math.hypot` semantics

Critical files:

- `crates/irregular-nesting-native/src/js_number/js_math.rs`
- `crates/irregular-nesting-native/src/transforms/flattening.rs`
- `scripts/rust-parity/dump-js-hypot.ts` (new)
- `crates/irregular-nesting-native/tests/js_hypot_vectors.rs` (new)
- `crates/irregular-nesting-native/tests/vectors/js-hypot.json` (new)
- `crates/irregular-nesting-native/Cargo.toml`
- relevant R21 and hypot evidence documentation

Steps:

1. Add a deterministic Node 24 oracle generator that records raw input and output binary64 bits, Node and V8 versions, generator seed, source hash, and corpus hash. Support byte-for-byte `--write` and `--check` modes.
2. Commit the generated corpus and add a Rust integration test that compares output bits exactly, including zero, subnormal, finite, overflow, infinity, and NaN cases.
3. Replace the five production-reachable `libm::hypot` expressions in `transforms/flattening.rs` with `js_math::hypot`. Keep unrelated `sin`, `cos`, `atan`, `atan2`, `acos`, and source-faithful Clipper `sqrt(x*x + y*y)` operations unchanged.
4. Add collision-builder curve witnesses proving that flattening reaches the semantic primitive.
5. Correct documentation that calls the implementation a verbatim V8 port. Describe it as a Node/V8-compatible two-argument implementation proven by the committed oracle corpus.
6. Correct stale reachability and dependency documentation: `transforms::flattening` is production-wired through `geometry::collision_builder`, and `libm` remains used by flattening transcendental operations after semantic `hypot` calls move to `js_math::hypot`.
7. Remove or regenerate unsupported 21,696-case claims from reproducible evidence.

Acceptance:

- The committed corpus regenerates byte-for-byte under the pinned Node version.
- Custom Rust hypot matches every oracle output bit.
- No production TypeScript `Math.hypot` route uses Rust `f64::hypot` or `libm::hypot`.

## 3. Close native trust-boundary validation gaps

Critical files:

- `src/shared/irregular/domain.ts`
- `crates/irregular-nesting-native/src/boundary/request.rs`
- `crates/irregular-nesting-native/src/domain/settings.rs`

Steps:

1. Add table-driven red tests around `RequestDto::decode_and_prepare` for every TypeScript scalar refinement and default.
2. Revalidate positive finite integers: `orderWindow`, `beamWidth`, `localCandidateFanout`, `transformCap`, and `gaPopulation`.
3. Revalidate non-negative finite integers: `localRepairBudget`, `gaGenerationBudget`, `gaEvaluationBudget`, and `gaTimeBudgetMs`.
4. Revalidate non-negative finite millimeters, positive finite degrees, every configured rotation, non-empty `gaSeed`, non-empty `placementPolicyIds`, policy membership and uniqueness, geometry backend identity fields, and all Compact Short Side archive and GA cross-field rules.
5. Preserve existing typed native-boundary failure categories and valid defaults.

Acceptance:

- Invalid direct N-API requests fail before algorithm execution with the expected typed validation envelope.
- All valid TypeScript-produced requests and defaulted settings still decode identically.

## 4. Restore complete native history and snapshot fidelity

Critical files:

- `crates/irregular-nesting-native/src/boundary/result.rs`
- `crates/irregular-nesting-native/src/result/progress.rs`
- `src/workers/irregular/native/nativeIrregularBackend.ts`
- `src/workers/algorithm/irregular/irregularWorkerOutput.ts`
- `tests/unit/nativeIrregularBackend.test.ts`
- `tests/unit/irregularWorkerCompute.test.ts`

Steps:

1. Add Compact and Compact Short Side red tests asserting the ordered remaining queue, frame titles, and `remainingPieceIds` for initial, intermediate, and terminal snapshots.
2. Extend the native state-snapshot DTO with the complete ordered `remainingPreparedPieces` representation already present in Rust state.
3. Decode the queue through the shared schema and remove the hard-coded `remainingPreparedPieces: []` reconstruction.
4. Extend the shared differential projection to compare this queue exactly.
5. Add assertions that native snapshot callbacks are emitted, ordered, and consumed before the terminal response.

Acceptance:

- Native and TypeScript history frames match for titles, remaining IDs, placements, unplaced IDs, source, and order.
- Differential mode can no longer mask a missing remaining queue.

## 5. Make callback delivery ordered, awaited, and terminal-safe

Critical files:

- `crates/irregular-nesting-native/src/boundary/events.rs`
- `crates/irregular-nesting-native/src/boundary/result.rs`
- `src/workers/irregular/native/nativeIrregularBackend.ts`
- `tests/unit/nativeIrregularBackend.test.ts`

Steps:

1. Add red tests with delayed and failing progress Effects, reversed callback arrival, duplicate or missing ordinals, and callbacks arriving after settlement.
2. Put progress and state snapshots on one Rust-allocated ordinal sequence.
3. Replace fire-and-forget `Effect.runPromise(...).catch(() => {})` with one ordered dispatcher that buffers by ordinal, serializes effectful delivery, propagates failures, and drains before native completion is exposed.
4. Treat ordinal gaps and duplicates as typed protocol failures.
5. Add a terminal latch so no history, progress, or trace event is accepted after success, failure, cancellation, timeout, or differential mismatch.

Acceptance:

- Callback effects are delivered in ordinal order and fully awaited.
- Callback failures cannot be swallowed.
- No observable callback occurs after the terminal response.

## 6. Implement real runtime differential mode

Critical files:

- `src/shared/irregular/backendSelection.ts`
- `src/workers/nesting.worker.ts`
- `src/workers/irregular/differential/irregularDifferential.ts` (new)
- `scripts/rust-parity/run-differential.ts`
- `tests/unit/irregularDifferential.test.ts` (new)

Steps:

1. Add red tests proving that `differential` currently invokes TypeScript only.
2. Extract one shared semantic projection and comparator used by both the CLI harness and production runtime.
3. Include ordered placements, transforms, scores, archive contents, candidates, complete snapshots, unplaced IDs, traces, ledgers, checkpoints, hashes, and typed failure envelopes. Exclude only documented non-semantic timing and process-memory measurements.
4. For an archive-eligible differential request, preflight native availability, run TypeScript first with observable callbacks, run Rust second silently against the same validated request, compare outcomes, and return the TypeScript outcome only on equality.
5. Return a stable typed `irregular_differential_mismatch` failure with the first mismatch path and bounded diagnostic values on divergence.
6. Fail explicitly when an explicitly requested Rust or differential backend is unavailable or ineligible. Do not silently execute TypeScript alone.

Acceptance:

- Runtime tests prove one TypeScript run and one Rust run.
- Only TypeScript contributes externally observable callbacks.
- Equal success and equal typed failure outcomes preserve the TypeScript authority.
- CLI and runtime use the same comparator.

## 7. Propagate cancellation through a real control protocol

Critical files:

- `src/shared/protocol/worker.ts`
- `src/main/services/WorkerSupervisor.ts`
- `src/workers/nesting.worker.ts`
- `src/workers/irregular/native/nativeIrregularBackend.ts`
- `tests/unit/workerSupervisor.test.ts` (new)
- `tests/unit/workerProtocol.test.ts`

Steps:

1. Add red tests for user cancellation, timeout, stale cancellation requests, cancellation before native registration, queue draining, and absence of terminal success after cancellation.
2. Add a `CancelNesting` worker RPC carrying immutable `requestId`, public `jobId`, and `cancelled` or `timeout` reason.
3. Maintain a worker-side active-run controller keyed by `requestId`, with first-writer-wins reason, `isRequested()`, and one-shot native cancellation registration.
4. Retain an active worker RPC client/control handle in `PendingJob` for the full run lifetime. The supervisor must be able to issue `CancelNesting` while the `RunNesting` stream is still active; creating the client only inside the run fiber is insufficient.
5. Send cancellation through the retained RPC handle and retain the worker stream until it returns the typed terminal envelope. Use worker disposal only after a bounded cancellation-grace watchdog expires.
6. Wire Effect interruption to the same idempotent controller so interruption invokes native cancellation exactly once.
7. Preserve `worker_cancelled` versus `worker_timeout` semantics.

Acceptance:

- Cancellation and timeout set the Rust cooperative flag before fallback termination.
- History and trace queues drain before the terminal failure response.
- Stale or mismatched cancellation requests cannot affect the active run.

## 8. Make native cancellation registration ownership-safe

Critical files:

- `crates/irregular-nesting-native/src/boundary/job.rs`
- `crates/irregular-nesting-native/src/boundary/run_job.rs`
- `src/workers/irregular/native/loadNativeBackend.ts`
- `src/workers/irregular/native/nativeIrregularBackend.ts`

Steps:

1. Add Rust red tests for overlapping calls with the same public job ID, independent cancellation, completion cleanup, duplicate invocation registration, and timeout reason mapping.
2. Generate a unique invocation token for each native call. Keep public `jobId` as diagnostic data only.
3. Key the Rust registry by invocation token and store an owned cancellation lease rather than a bare job-ID flag.
4. Reject duplicate token registration instead of overwriting it.
5. During cleanup, remove the registry entry only when it is pointer-identical to the completing task's lease.
6. Carry cancellation reason through the lease so expected cancellation and timeout resolve to their correct typed envelopes.

Acceptance:

- Two overlapping invocations sharing a public job ID remain independently cancellable.
- One invocation cannot remove or cancel another invocation's registration.

## 9. Bound cache memory without changing semantic output

Critical files:

- `crates/irregular-nesting-native/src/caches/store.rs`
- `crates/irregular-nesting-native/src/caches/telemetry.rs`
- `crates/irregular-nesting-native/src/caches/transform_collision_geometry.rs`
- `crates/irregular-nesting-native/src/nfp_ifp/boundary_core.rs`
- `crates/irregular-nesting-native/src/nfp_ifp/ifp_bounds.rs`
- `crates/irregular-nesting-native/src/search/layout_scorer.rs`
- `crates/irregular-nesting-native/src/boundary/run_job.rs`

Recommended design:

- Job-local deterministic charged LRU.
- Start with a documented 64 MiB total default budget, provisionally split into 56 MiB for geometry and 8 MiB for free-material snapshots.
- Before finalizing the constants, profile Mixed-61 and raise the fixed bound if necessary to preserve baseline reuse and runtime. The final value must remain finite, documented, and enforced.
- Pass an explicit conservative byte charge from each concrete cache call site rather than making the type-erased store guess value layouts.

Steps:

1. Add tiny-cap red tests for deterministic LRU eviction, replacement accounting, stale removal, clear, oversized entries, current and peak bytes, and exact result equality after recomputation.
2. Charge serialized key capacity, retained value capacities, metadata, and conservative allocator/container overhead with checked saturating arithmetic.
3. Keep all cache access, LRU touches, eviction, and stable publication on the coordinator thread. Parallel workers remain cache-free and return pure values.
4. Reject a single oversized cache entry without failing the job or evicting unrelated entries. Future access recomputes the pure value.
5. Extend telemetry with cap, current and peak bytes, admissions, replacements, evictions and evicted bytes, and oversized rejections. Keep telemetry out of semantic DTOs.
6. Add explicit release and shrink at normal job completion and error cleanup; panic unwind still relies on ownership drop.
7. Apply the same charged-memory principle to the existing bounded FreeMaterialCache.
8. Compare unlimited, tight-cap, one-thread, and multi-thread runs byte-for-byte.
9. Profile Mixed-61 and verify that the final default cap does not materially reduce the established hit rate or regress runtime.

Acceptance:

- Current charged bytes never exceed the documented cap.
- Eviction changes reuse only, never results, errors, ordering, traces, or hashes.
- Job completion releases retained cache values.

## 10. Remove redundant NFP pre-pass cache work

Critical files:

- `crates/irregular-nesting-native/src/nfp_ifp/boundary_core.rs`
- `crates/irregular-nesting-native/src/nfp_ifp/candidates.rs`
- `crates/irregular-nesting-native/src/caches/store.rs`

Steps:

1. Add a red telemetry and clone-count test proving the current pre-pass reads and clones a hot value that the real resolver reads again.
2. Add a non-cloning typed probe for pre-pass presence and validity checks.
3. Preserve validation, stale removal, first-encounter key deduplication, parallel pure computation, and stable serial publication.
4. Leave the actual resolver as the sole cloning cache hit used to produce the candidate.

Acceptance:

- A hot valid key is not cloned by the pre-pass.
- Cold and stale paths retain exact publication and error ordering.
- One-thread and multi-thread outputs remain byte-identical.

## 11. Package a deployable target-aware native addon

Critical files:

- root `package.json`
- `pnpm-workspace.yaml`
- `electron-builder.yml`
- `crates/irregular-nesting-native/package.json`
- `crates/irregular-nesting-native/npm/index.cjs`
- `crates/irregular-nesting-native/scripts/build-native.mjs`
- `src/workers/irregular/native/loadNativeBackend.ts`
- `scripts/verify-packaged-native-load.mjs` (new)

Steps:

1. Add Node red tests for target mapping and staged filenames for Linux x64, Windows x64, macOS arm64, and macOS x64.
2. Add explicit Cargo target selection and read artifacts from `target/<triple>/<profile>`.
3. Declare the native workspace package as a root production dependency and export `npm/index.cjs` as its stable package entry point.
4. Include the loader, target binaries, and notices in the package file allowlist.
5. Resolve the addon by package name in both development and packaged execution. Remove source-tree-only resolution as the production path.
6. Configure narrow Asar unpacking for `.node` files.
7. Add a packaged verifier that launches the packaged Electron executable with `ELECTRON_RUN_AS_NODE=1`, loads through the packaged package entry point, and validates `nativeCapability()`.

Acceptance:

- The unpacked packaged app contains and loads the correct target binary without access to the repository checkout.
- Wrong or missing target artifacts fail packaging or the packaged verifier.

## 12. Restore Clipper2 license compliance

Critical files:

- `crates/irregular-nesting-native/src/clipper/core.rs`
- `crates/irregular-nesting-native/src/clipper/engine.rs`
- `crates/irregular-nesting-native/LICENSES/clipper2-ts-BSL-1.0.txt` (new)
- `crates/irregular-nesting-native/package.json`
- `electron-builder.yml`

Steps:

1. Add the upstream copyright notice and Boost Software License reference to each translated Rust source.
2. Copy the complete upstream license text into a repository-owned distributable `LICENSES` path.
3. Include the notice in the native package and Electron artifact.
4. Add byte-for-byte license-copy and packaged-presence tests.

Acceptance:

- Source derivatives and distributed artifacts contain the required copyright and complete license statement.

## 13. Strengthen CI and test integrity

Critical files:

- `.github/workflows/rust-native.yml`
- `scripts/rust-parity/run-differential.ts`
- `crates/irregular-nesting-native/tests/thread_equality.rs`
- `crates/irregular-nesting-native/tests/coordinator_vectors.rs`
- `tests/unit/nativeIrregularBackend.test.ts`

Steps:

1. Make native integration tests fail clearly when a required prebuilt addon is missing in native CI, rather than silently skipping.
2. Compare complete semantic snapshots, including remaining prepared pieces.
3. Separate exact semantic values from explicitly diagnostic timing and RSS values. Do not describe normalized comparisons as byte-identical envelopes.
4. Add a true raw-envelope or canonical-byte thread-equality assertion for semantic output.
5. Remove relative numeric tolerances from fields governed by exact parity, or narrow the documented contract if a field is proven non-semantic before changing its assertion.
6. Assert snapshot callback presence and cross-channel ordering.
7. Add required packaged-load jobs on native runners for Linux x64, Windows x64, macOS arm64, and macOS x64.
8. Keep the required differential subset on every PR and add scheduled and manual full-matrix execution.

Acceptance:

- CI cannot be green when the addon was not built or packaged.
- Claims in tests and evidence match what is actually compared.
- Both current failing CI jobs are green for verified reasons.

## 14. Full verification and Sol closure

Run fresh verification after all implementation cycles:

1. `cargo fmt --check --manifest-path crates/irregular-nesting-native/Cargo.toml`
2. `cargo clippy --manifest-path crates/irregular-nesting-native/Cargo.toml --all-targets -- -D warnings`
3. Full release Rust test suite, including boundary, cancellation, cache, hypot, thread-equality, and focused red-row regressions.
4. `pnpm build:native`
5. Focused TypeScript unit tests for backend selection, native adapter, worker protocol, supervisor cancellation, history, differential comparison, and packaged loader.
6. `pnpm test:differential` and the full exploratory matrix.
7. Mixed-61 Compact and Compact Short Side baseline hashes, winners, traces, area, cavities, cache hit rate, peak charged bytes, and runtime.
8. Root lint and typecheck.
9. Native package dry-run inspection.
10. Plain Node, Electron-as-Node, and packaged Electron addon-load smoke tests.
11. CI matrix on Linux x64, Windows x64, macOS arm64, and macOS x64.
12. Project diagnostics through the configured IDE diagnostics integration. If unavailable, report that limitation explicitly and rely on compiler, linter, and test output.
13. Resume the persistent Sol review with the working-tree fixes and require every F1 through F8 finding, plus newly verified findings, to become `RESOLVED` or `WITHDRAWN`.

Do not commit, push, merge, or alter baselines unless explicitly requested after all gates pass.

## 15. Post-merge hypot experiment

Perform this only after the custom-hypot remediation is merged and recorded as the baseline.

1. Create separate experimental branches for `f64::hypot` and `libm::hypot`.
2. Change only the semantic hypot implementation or call routing.
3. Run the primitive oracle, complete differential matrix, final canonical hashes, comparator winners, traces, placed and unplaced counts, final area, cavities, Compact and Compact Short Side layouts, Mixed-61 runtime, and output-quality metrics.
4. Produce a three-way comparison against the merged custom implementation.
5. Do not merge an alternative automatically. Any semantic divergence requires an explicit decision to relax the exact-parity contract in a separate PR.
