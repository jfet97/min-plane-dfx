# Rust Irregular Backend — Final Acceptance Checklist

**Date:** 2026-07-30
**Scope:** migration prompt §22 artifact #15 ("a final acceptance checklist"), walking §25
("Definition of done") item by item.
**Branch:** `rust-irregular-backend` @ `88b572711642a96d765ecd39ad2872c15b081dff` (working tree
uncommitted per task instructions — do not commit).
**Method:** every item below is graded **met** / **met-with-note** / **not-met** against
evidence actually re-produced in this session (not cited from memory) — see the "Evidence"
column for the exact document/command each verdict rests on. This checklist is deliberately
blunt: promotion criteria that are not met are reported as not met, not softened.

Status legend: **met** — fully satisfied, no caveat. **met-with-note** — satisfied in substance
but with a documented, non-blocking caveat the orchestrator should know about. **not-met** —
not satisfied; the consequence is stated explicitly, not glossed over.

---

## 1. Scope

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1.1 | Compact runs fully in Rust through a coarse N-API call | **met** | `boundary::run_job::run_job_from_json` is the single coarse entry point (`crates/irregular-nesting-native/src/boundary/run_job.rs`); `native-boundary.md` §4 documents the one-profile-discriminated-call shape; `verify-mixed61-hash.ts --profile compact` reproduces the acceptance-bar hash through this exact path (`differential-e2e-report.md` "Acceptance bar" section). |
| 1.2 | Compact Short Side runs fully in Rust through a coarse N-API call | **met** | Same entry point, `profile=short-side`; `verify-mixed61-hash.ts --profile short-side` reproduces its own pinned hash (`ef2b783a…` sibling `2a63c729…`, `differential-e2e-report.md`); `short_side` module (`src/short_side/`) builds genuine directional geometry, not a Compact-geometry reuse (§1.9 below). |
| 1.3 | The final architecture is not a collection of per-kernel N-API calls | **met** | One `#[napi]`-exported coarse job API (`boundary/`); `architecture.md` §4.1 (still labeled "Stage 0 design" — see §6 doc-maintenance note below, but the coarse-call architecture it specifies is what actually shipped, independently confirmed by reading `boundary/run_job.rs`/`lib.rs` directly rather than trusting the design doc's own claim). |
| 1.4 | Rectangular nesting remains TypeScript | **met** | No rectangular-nesting code exists anywhere in `crates/irregular-nesting-native`; the crate's own module map (`architecture.md` §3, cross-checked by directory listing) covers only the irregular Compact/Compact-Short-Side subsystems named in the migration prompt's §5 file map. Untouched by this port. |
| 1.5 | The complete existing TypeScript irregular backend remains maintained and selectable | **met** | `src/workers/nesting.worker.ts`'s backend-selection routing (the one sanctioned wiring edit, `freeze-verification.md` §5) takes the exact prior `computeIrregularNesting` branch whenever `MIN_PLANE_IRREGULAR_BACKEND` is unset or resolves to `'typescript'` — confirmed byte-identical pre/post-change by `pnpm test:focused` (925 passed, 17 skipped, this session, §7 below); `backend-selection-rollback.md` documents the selector and rollback runbook. |

## 2. Semantics

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 2.1 | Existing tests, fixtures, expected values, and quality thresholds remain unchanged | **met** | `freeze-verification.md`: 1,118/1,120 frozen files byte-identical to `f282f0a`; the 2 diffs are the pre-approved `package.json` script additions and the one sanctioned `trustedGeometryCarrierBoundary.test.ts` exclusion-list addition (an addition to scope, not a weakened assertion). Re-hashed fresh this session (§7 below shows the gate suite that depends on this holding). |
| 2.2 | All existing tests pass | **met** | `pnpm test:focused` this session: **92 files, 925 passed, 17 skipped, 0 failed**. `cargo test --release` this session: **710 passed, 0 failed** (crate's own new-but-permanent vector suites, not "existing TS tests", counted separately in §7). |
| 2.3 | All existing production gates pass | **met** | This session, serially: `pnpm gate:capacity:production` (PASS), `pnpm gate:mixed61-compact` (PASS), `pnpm gate:compact-nine-baselines --skip-png` (PASS) — full results and timings in §7. |
| 2.4 | Rust one-thread output matches TypeScript exactly for every maintained case | **met** | `differential-fixture-matrix.ts --required-only`: **16/16** rows passed this session (2/4/8-piece mixed61 subsets × 2 profiles, triangle-20, shapes-17, mixed61 at 600×400/300×300/2000×2700 × 2 profiles) — full log in §7. This is Rust running at its compiled default, which is 1 thread (`performance-report.md` §2, confirmed by reading `boundary::parallel::resolve_thread_count`). |
| 2.5 | Canonical key and canonical JSON bytes match where contractual | **met** | `canonical_layout_vectors`/`canonical_grid`-family suites in `cargo test --release` (541 crate-internal tests including canonical-key/canonical-JSON vector suites); `verify-mixed61-hash.ts`'s `fittedCanonicalSha256` is itself a canonical-JSON-derived hash and matches exactly on both profiles. |
| 2.6 | All accepted hashes match | **met** | Acceptance-bar hash (`ef2b783a…`, 61/61 placed) reproduced exactly through the Rust backend (`differential-e2e-report.md`); `verify-mixed61-hash.ts` re-run both profiles this session as part of §7 — both PASS against the pinned baseline table. |
| 2.7 | Placed and unplaced partitions match exactly | **met** | Every "OK" row in the differential matrix asserts placed/unplaced equality as part of its comparison (`run-differential.ts`'s documented projection); 61/61 placed, 0 unplaced on the primary gate, both backends, every sample (`performance-report.md` §3). |
| 2.8 | Ranking, archive authority, scheduler chronology, ledgers, and checkpoints match | **met** | `shared_archive_vectors` (ranking comparator, admission, checkpoint chronology — 5/5 cargo tests), `coordinator_vectors` (nested scheduler resume, cancellation-mid-resume — 8/8), `capacity_search_vectors` (336 checkpoint-resume cases — 3/3 test functions) — see `determinism-report.md` §4 for the full re-run this session. |
| 2.9 | Cancellation, deadlines, errors, history, and traces match | **met** | `coordinator_vectors.rs::cancellation_injected_during_the_nested_scheduler_resume_aborts_the_whole_job` (cancellation returns no partial geometry, migration-prompt §24 stop condition); five-trace field-for-field wire projection confirmed live (`nativeIrregularBackend.ts`'s own "Trace fidelity" doc, re-read this session) — see §6 doc-currency note: `differential-e2e-report.md` line 54's prose still calls these "opaque", which is now stale (§6 below). |
| 2.10 | Compact Short Side builds genuine directional geometry for Compact's exact selected partition and never falls back to Compact placements | **met** | `short_side_vectors.rs` (4/4: axes, pair-fold trace, observer status/ranking, contact-strip trace, all reproducing TS traces exactly — not merely a placement passthrough); the Short Side acceptance-bar hash (`2a63c729…`) differs from the Compact hash (`ef2b783a…`) on the identical 61-piece partition, which is only possible if Short Side actually re-derives its own directional geometry rather than reusing Compact's placements verbatim. |

## 3. Concurrency and caches

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 3.1 | Rayon performs real native multithreaded work on verified safe boundaries | **met** | `parallelism-inventory.md` §3 site inventory; two sites landed and shipped (piece-prep loop `PAR-GEOM-01`, per-placed NFP resolution `PAR-NFP-01`/`PAR-CACHE-01`, `boundary/parallel.rs` + `nfp_ifp/boundary_core.rs`), both gated by the deterministic-pattern requirement (stable ordinal → parallel eval → stable-slot collection → serial reduction). |
| 3.2 | One-thread and multi-thread outputs are identical across repeated runs | **met** | `determinism-report.md` §1: `thread_equality.rs`, 4 fixtures × 12 runs (threads {1,2,4,8} × 3 repeats) = **48/48 hash-exact** vs. the threads=1 baseline, re-run this session (67.23s). §2: full Mixed-61 primary gate at 1/2/8 threads, 11 Rust samples, all hash-exact (`performance-report.md` §3.2, P7 verdict PASS). |
| 3.3 | Cache reuse remains high | **met** | `memory-cache-report.md` §3: full Mixed-61 default and effectively unlimited runs both record 276,454 geometry hits, 276,454 cloning hits, and 5,299 misses. Default caps therefore preserve unlimited-cache reuse exactly. |
| 3.4 | Shared-cache contention and duplicate computation are measured and controlled | **met** | `memory-cache-report.md` §§1 and 4: Rayon workers perform pure computation only; the coordinator alone probes, touches, evicts, and publishes. Stable-slot collection followed by serial publication prevents duplicate concurrent mutation. One-thread and two-thread cap-equivalence regressions are byte-exact. |
| 3.5 | Cache insertion order cannot affect behavior | **met** | `memory-cache-report.md` §4: default, unlimited, forced-eviction, and forced-rejection runs produce identical timing-normalized envelope bytes. Cache policy changes reuse only and is not a semantic input. |
| 3.6 | Cache memory is bounded and cleaned up | **met** | `memory-cache-report.md` §§1-3: finite 56 MiB geometry and 8 MiB free-material defaults; full Mixed-61 charged peaks are 10,889,512 B and 51,089 B with zero evictions or rejections; normal completion explicitly clears and shrinks both caches before diagnostics publication. |
| 3.7 | No deadlocks, poisoned permanent entries, or leaked native jobs exist | **met** | Cache mutation is coordinator-only and uses no shared cache locks. Panic unwind drops job-local ownership; normal completion clears and shrinks retained storage. The release suite and repeated thread-equality matrix complete without hangs. |

## 4. Performance

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 4.1 | Rust is reproducibly faster end to end on the preregistered representative suite | **met-with-note** | 1-thread (= shipped default) Rust beats TS on every measured case: C1 1.61×, C2 1.64×, C3 1.61×, C4 2.09× (`performance-report.md` §3–4, P1/P4 PASS). **Note**: P5 (aggregate-suite ratio) was out of this batch's instructed scope and remains formally unevaluated — see 4.2. |
| 4.2 | Mixed-61 shows a clear material improvement using the existing profile harness | **met** | `performance-report.md` §3.1: C1 (Mixed-61 2000×2700 Compact) TS median 43,148 ms → Rust median 26,836 ms, **1.61× speedup**, 5 alternating samples per backend, hash-exact on every sample. |
| 4.3 | Multi-thread Rust improves heavy cases over one-thread Rust after overhead | **not-met** | `performance-report.md` §3.2/§7 (P3): threads=2 median 26,996 ms, threads=8 median 27,045 ms vs. the 1-thread/default baseline of 26,836 ms on Mixed-61 Compact — flat within ≤1% noise, **no measurable speedup from additional threads** on this workload at this scale. Stated plainly in the performance report's own §9: this is a structural fact about the current Rayon site coverage (piece-prep loop + per-placed NFP resolution) not dominating this workload's wall-clock profile, not a measurement artifact. |
| 4.4 | No maintained case has an unexplained regression | **met** | Every measured case (C1–C4) is faster in Rust than TS, at every thread count tested; no case regressed. (Thread-count-vs-thread-count is flat, §4.3, but that is "no benefit", not "a regression" — no case is slower in Rust than in TS at any measured configuration.) |
| 4.5 | Memory remains acceptable | **met** | P6 PASS: Rust default-thread peak RSS on C1 is 0.35× (via-addon) / 0.14× (pure standalone) of TS's, both far under the 1.5× ceiling (`performance-report.md` §6–7; independently re-confirmed by `memory-cache-report.md` §3 with a fresh single-sample run this evidence pass). |
| 4.6 | Evidence includes provenance and all samples | **met** | `performance-report.md` §1 (machine/commit/toolchain provenance, the one caught-and-corrected concurrency incident disclosed rather than hidden) and §3–6 (every raw sample tabulated, not just medians). |

### 4.7 Promotion verdict (P1–P7, `performance-contract.md`) — stated explicitly per the task's own instruction

| Threshold | Verdict | Consequence |
| --- | --- | --- |
| P1 (1-thread ≥1.5× TS) | **PASS** (1.61×) | — |
| P2 (default-thread ≥2.5× TS) | **FAIL** (1.61×, since default==1-thread on this build) | **Backend does not earn unconditional default-on promotion under the preregistered contract.** |
| P3 (parallel efficiency, threading buys ≥1.3× over 1-thread) | **FAIL** (flat, ≤1% spread across 1/2/8 threads) | Current Rayon coverage does not widen the performance case for turning on threading by default. |
| P4 (no per-case regression) | **PASS** | — |
| P5 (aggregate suites) | **NOT EVALUATED** (out of the measurement batch's instructed scope) | Must be measured before any final promotion decision — genuinely open, not silently assumed passing. |
| P6 (memory) | **PASS** | — |
| P7 (thread-count neutrality) | **PASS** | — |

**Consequence, stated per this task's explicit instruction:** P2/P3 (and the unevaluated P5) are
**not met** — therefore **the Rust backend must remain opt-in (`MIN_PLANE_IRREGULAR_BACKEND=rust`),
not the default backend.** `backend-selection-rollback.md`'s selector already defaults to
`'typescript'` and requires an explicit environment override to select Rust — this default is
**correct and must not be changed** until P2/P3/P5 are re-evaluated and cleared, per
`performance-contract.md`'s own binding language ("parallelism is not a success criterion") and
the migration prompt §25's performance section, which this checklist reads as requiring **all**
listed performance criteria, not a subset, before the backend could be considered for
default-on promotion. Single-threaded Rust is, on its own, a correctness-preserving, reproducible
win (P1/P4/P6/P7 all pass) and remains valuable as an **opt-in** backend regardless of the P2/P3
outcome.

## 5. Integration

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 5.1 | Development and tests load the correct native addon | **met** | `node crates/irregular-nesting-native/scripts/build-native.mjs --release` (re-run this session, addon reported up to date, 0.03–0.07s); `nativeIrregularBackend.test.ts`/`irregularBackendSelection.test.ts` (12 tests total) pass as part of `pnpm test:focused` this session. |
| 5.2 | Packaged Electron loads the correct platform binary | **met-with-note** | `electron-builder.yml` (this session's evidence pass confirms it exists and its `asarUnpack`/`npmRebuild: false` configuration matches `build-packaging.md` §4/§6/§7's design). **Note**: no packaged-app smoke test was executed in this evidence pass (that is `ci-matrix.md` §5.6 `packaged-app-smoke`, a CI job design, not yet exercised end-to-end against a real built Electron package on this machine) — the configuration is verified by inspection and design-doc cross-reference, not by an actual packaged-app boot test in this session. |
| 5.3 | Supported platform and architecture artifacts are built and smoke-tested | **met-with-note** | Only `x86_64-unknown-linux-gnu` was built and tested this session (this development machine's own platform, per `native-boundary.md` §3.1's target-triple capability field, confirmed `x86_64-unknown-linux-gnu` in every capability probe this session). macOS/Windows artifacts are design-only (`build-packaging.md` §9 prebuild-targets section) — not built or smoke-tested on this machine, since no macOS/Windows build host is available in this environment. This is an honest scope gap, not a claim of full multi-platform coverage. |
| 5.4 | CI exercises Rust, addon loading, deterministic parity, production gates, and packaging | **met-with-note** | `.github/workflows/rust-native.yml` (new this port, present on disk, its own header comment cross-references `ci-matrix.md`) defines rust-fmt/rust-clippy/rust-test/native-build/addon-load-smoke/required-differential-subset/determinism jobs for the per-PR tier; **the full production-gate and packaging jobs are explicitly deferred to a "nightly" tier** (the workflow file's own header comment: "Expensive gates ... deliberately NOT run per-PR"). This workflow has not been observed to execute successfully on GitHub's own runners as part of this evidence pass (no CI run was triggered/inspected this session — only the workflow file's presence and content were reviewed). |
| 5.5 | Missing or incompatible native binaries fail clearly before explicit Rust or differential execution | **met** | `backend-selection-rollback.md` §3-4 (capability probe and fail-closed no-retry rules); `native-boundary.md` §3.3 (load-time compatibility check); `boundary::error` module's typed error mapping (`cargo test --release`'s `boundary::error::tests` — 8 tests, all green, covering API-version mismatch, panic sanitization, archive-ineligibility routing). |
| 5.6 | Rollback to TypeScript remains immediate and documented | **met** | `backend-selection-rollback.md` §8 ("Rollback runbook"); the default backend selection is `'typescript'` unless explicitly overridden (§4.7 above), so rollback is the unmodified default state rather than a separate procedure. |
| 5.7 | Native event callbacks use one ordered API-v2 channel and drain before settlement | **met** | `boundary::events` owns one Rust ordinal sequence across progress, snapshots, and terminal. `nativeIrregularBackend.test.ts` exercises delayed progress and snapshot delivery, callback rejection, malformed data, gaps, duplicates, reversals, and post-terminal callbacks through the injectable addon seam. The real-addon smoke script asserts the terminal marker appears before its promise resolves. |

---

## 6. Documentation-currency notes (honesty, not scored against Definition-of-Done, but material)

- **The nine Stage-0-era design documents** (`architecture.md`, `semantic-mapping.md`,
  `native-boundary.md`, `cache-concurrency-design.md`, `parallelism-inventory.md`,
  `checkpoint-compatibility.md`, `backend-selection-rollback.md`, `build-packaging.md`,
  `ci-matrix.md`, `parity-matrix.md`) were each committed once during Stage 0 and **never
  revised afterward** (confirmed by `git log -1` on each file this session — every one's last
  touch is a Stage-0-era commit, `99f9fec`/`26115fc`/`d65047b`). Migration prompt §22's framing
  ("Produce **and maintain**") is not fully honored: these documents still self-label "Status:
  Stage 0 design document" even though the design they describe has since been implemented,
  differentially verified, and shipped. Their factual content was independently spot-checked
  against real source in this pass (§1.3, §5.2 above) and found accurate as *design* documents,
  but they are not living status trackers. `architecture.md`'s own header is corrected as part of
  this evidence pass (see below); the other eight are left as-is (out of this task's literal
  scope, which named only `architecture.md`'s header) — flagged here so the gap is visible rather
  than silently inherited.
- **`differential-e2e-report.md` line 54** still describes the five trace fields
  (`capacityTrace`/`intrinsicAnytimeSchedulerTrace`/`focusedCompleteReconstructionTrace`/
  `intrinsicShortSideObserverTrace`/`intrinsicShortSidePairFoldTrace`) as "opaque ... the native
  boundary doesn't yet structurally project." **This is stale.** `scripts/rust-parity/run-differential.ts`'s
  own current module doc (re-read this session, lines 29–34) states the opposite and more recent
  fact: "All five trace fields ... are otherwise compared field-for-field (`nativeIrregularBackend.ts`
  now reconstructs every one of them from the native boundary's real, structured wire projection)."
  `nativeIrregularBackend.ts`'s own "Trace fidelity" doc comment (re-read this session) confirms
  the same: full field-for-field reconstruction, not an opaque passthrough. Native state snapshots
  also carry and decode the complete `remainingPreparedPieces` queue, so retained snapshots,
  streamed snapshots, and `makeIrregularWorkerOutput` history frames preserve exact reveal titles
  and remaining IDs. The only narrow exclusion is the ten named wall-clock-derived field values
  (presence or absence is still compared). **Net effect: this is a documentation-lag issue in one
  older report, not an unresolved semantic gap**. The actual current behavior is strictly better
  than what that stale sentence describes, and every differential row that depends on trace and
  snapshot comparison passes with those structures compared in full.

## 7. Final gate suite — this session, run serially

Addon rebuilt first (`node crates/irregular-nesting-native/scripts/build-native.mjs --release`;
reported up to date, no recompilation needed — the working tree was already built from the
current dirty state). Every gate below was run to completion in this session, in the order
listed, one at a time (never concurrently), before this checklist was finalized.

| # | Gate | Result | Notes |
| --- | --- | --- | --- |
| 1 | `cargo fmt --check` | **PASS** | Clean, 0 diff. |
| 2 | `cargo clippy --all-targets -- -D warnings` | **PASS** | Clean, 0 warnings. |
| 3 | `cargo test --release` | **PASS** | 710 passed, 0 failed (matches STATE claim exactly). `thread_equality.rs` alone: 67.23s. |
| 4 | `pnpm typecheck` | **PASS** | `typecheck:node` + `typecheck:web`, both clean. |
| 5 | `pnpm lint` | **PASS** | `eslint .`, clean. |
| 6 | `pnpm test:focused` | **PASS** | 92 files, 925 passed, 17 skipped, 0 failed. 15.83s. |
| 7 | `differential-fixture-matrix.ts --required-only` | **PASS** | 16/16 required rows passed (mixed61 2/4/8-piece × 2 profiles, triangle-20, shapes-17, mixed61 600×400/300×300/2000×2700 × 2 profiles, full log retained at `/tmp/diff-matrix-required.log`). |
| 8 | `differential-fixture-matrix.ts --exploratory-only` | **PASS** | 8/8 exploratory (N1) rows passed (mixed61 9/10/20/40-piece × 2 profiles). |
| 9 | `verify-mixed61-hash.ts --profile compact` | **PASS** | `fittedCanonicalSha256 = ef2b783a…`, `collisionIdentitySha256 = 3839e80d…`, 61/61 placed, `elapsedMs = 26984`, matches pinned baseline exactly. |
| 10 | `verify-mixed61-hash.ts --profile short-side` | **PASS** | `fittedCanonicalSha256 = 2a63c729…`, `collisionIdentitySha256 = c38a0cb4…`, 61/61 placed, `elapsedMs = 27202`, matches pinned baseline exactly. |
| 11 | `pnpm gate:capacity:production` | **PASS** | 9/9 case-level `passed:true`, final `{"reportPath":"/tmp/irregular-capacity-gate/report.json","passed":true}`. |
| 12 | `pnpm gate:mixed61-compact --output /tmp/final-sheet-invariance` | **PASS** | `qualityAccepted:true`, canonical hash/area/cavities/runtime checks all `true`, 61/61 placed, `elapsedMs = 46700.87`, final `{"reportPath":"/tmp/final-sheet-invariance/report.json","passed":true}`. |
| 13 | `pnpm gate:compact-nine-baselines --output-dir /tmp/final-nine-baselines --skip-png` | **PASS** | `caseCount: 9`, `layoutCount: 18` (9 Compact + 9 Compact Short Side), `directionalSuccessCount: 9`, `directionalMissCount: 0`, `compactFallbackCount: 0` (Short Side never fell back to Compact geometry, confirming §2.10 above independently on all 9 baselines, not only Mixed-61), final `passed:true`; every one of the 19 individual case+profile JSON reports (`grep -c '"passed":true'` on the raw log) also reported `passed:true`, 0 `false`. |

**All gates passed. No failure was masked or reported prematurely as passing** — this table was
filled in only after each command's own exit code and full log were inspected, in the order
run.

---

## 8. Overall verdict

- **Correctness/semantics (§1–2): fully met.** No known semantic gap remains after Finding N1
  and Finding N2 both closed (`differential-e2e-report.md`); every required and exploratory
  differential row passes; every existing test and gate passes; the freeze holds.
- **Concurrency/caches (§3): fully met**, with one measurement-scope note (§3.4) that does not
  indicate a defect.
- **Performance (§4): partially met.** P1/P4/P6/P7 pass; **P2 and P3 do not**, and P5 was not
  evaluated. Per the task's own instruction, this is reported plainly: **the Rust backend has
  not earned unconditional default-on promotion and must remain opt-in**, exactly as
  `backend-selection-rollback.md`'s current default already has it.
- **Integration (§5): met, with honest scope notes** on single-platform build/test coverage and
  on CI not having been observed to execute successfully on real GitHub infrastructure as part
  of this evidence pass (the workflow file exists and was reviewed, not executed remotely here).
- **No stop condition from migration prompt §24 was triggered** at any point in this evidence
  pass: no existing hash changed, no placed/unplaced partition changed, no comparator winner
  changed outside the two already-closed, already-fixed findings, no checkpoint-resume
  divergence, no thread-count-dependent output change, no cache-race-driven trace/ledger
  change, no existing test needed weakening, cancellation returns no partial geometry, Short
  Side does not reuse Compact geometry, and no Rust gate silently fell back to TypeScript.
