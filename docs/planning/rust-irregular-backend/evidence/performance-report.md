# Rust Irregular Backend: Performance Contract Measurement Report

**Date:** 2026-07-31

**Working tree:** `rust-irregular-backend` at `0fa19255e4c01bf5e7c113ed6779a6dc4eac2e7c`, with uncommitted changes.

## Current verification update

The preregistered controlled Linux host remains the authority for P1 through P7. The current macOS verification host does not replace the controlled comparative performance record.

P1, P4, P6, and P7 remain passed. P2 and P3 remain failed. P5 remains unevaluated. Rust must remain opt-in through `MIN_PLANE_IRREGULAR_BACKEND=rust`; TypeScript remains the default backend.

Current macOS correctness runs completed Mixed-61 Compact in 30826 ms and Short Side in 31300 ms. The Compact production gate passed at `32061.670542` ms with area `391605.85017399996` and zero cavities. These are gate-completion observations, not new P1 through P7 comparative samples.

## Historical controlled measurement detail
## 1. Machine and source provenance

- Linux 6.18.38 x86_64 (NixOS host `t3vm`), CPU `Intel(R) Core(TM) Ultra 7 270K Plus`,
  16 hardware threads (16 cores × 1 thread/core), 125 GiB RAM (56 GiB free, 15 GiB used at
  measurement start).
- `rustc 1.97.1 (8bab26f4f 2026-07-14)`, Node `v24.18.0`, `pnpm 11.11.0`.
- Branch `rust-irregular-backend`, commit `88b572711642a96d765ecd39ad2872c15b081dff`
  ("perf: canonical-key buffer writing + deterministic Rayon infrastructure"), **working
  tree dirty** (per task instructions: do not commit). Uncommitted diff at measurement time:
  10 files changed (223 insertions, 52 deletions) — the N2 fix (`js_number/js_math.rs`
  Node/V8-compatible two-argument `Math.hypot`), canonical-key/contact/transform/validation follow-on changes,
  packaging additions (`package.json` `build:native`/`test:differential` scripts,
  `.github/workflows/rust-native.yml`, `electron-builder.yml`), plus this batch's own
  additions: `examples/run_mixed61.rs` (VmHWM printer, +27 lines, additive-only),
  `scripts/rust-parity/time-native-backend.ts` (new, additive), and
  `scripts/rust-parity/measure-peak-rss.ts` (new, additive). No existing script was
  modified. Full `git diff --stat` and `git status --short` reproduced in §8.
- **Release addon rebuilt** at the start of this session via
  `node crates/irregular-nesting-native/scripts/build-native.mjs --release` (precondition);
  cargo reported the release binary already up to date with the working tree (0.03 s,
  no recompilation needed) — the addon under test is `libirregular_nesting_native.so`
  compiled from the exact dirty tree at `88b5727` + N2 fix, copied to
  `crates/irregular-nesting-native/npm/irregular-nesting-native.linux-x64.node`.
  The `run_mixed61` example was separately rebuilt in `--release` after the VmHWM
  addition (`cargo build --release --example run_mixed61`, 14.95 s).
- Machine quiet check: `uptime` at start showed load average 2.84/2.72/3.27 (16 cores);
  `ps aux | grep -E 'cargo|tsx|node'` found only unrelated long-running host infrastructure
  (t3 Sentry MCP proxy, t3code deploy server, xcodebuildmcp) — no stray irregular-nesting
  processes. Those processes were left running throughout (never killed — "never kill
  unrelated processes" per instructions) but consumed negligible CPU (aggregate <2% in
  `ps aux` snapshots) and are not irregular-nesting workloads. Load average at the end of
  the batch was 1.04/1.29/1.61, confirming no runaway concurrent load developed.
- **One real concurrency incident, caught and corrected:** the first C1 batch launch used
  `nohup ... &` inside a script that was *also* passed `run_in_background: true` to the
  Bash tool, which started two independent copies of the alternating C1 script
  simultaneously (confirmed via `ps aux`, two `bash run-c1-main.sh` process trees, and two
  divergent `"1,ts,..."` CSV rows with different timings). This violates the contract's
  "no other performance measurement may run concurrently" rule. **Both processes were
  killed immediately** (`pkill` + explicit `kill -9` on the surviving orphaned child tree),
  all partial output files for that attempt were deleted, and the C1 batch was **restarted
  from a clean, single-process launch**. Every dataset in this report comes from that clean
  restart (or from batches launched after it, all single-process) — no sample from the
  corrupted concurrent run is included anywhere below.

## 2. Method

- **C1 (Mixed-61 `2000x2700` Compact):** 1 discarded warm-up per backend, then 5 measured
  samples per backend, strictly alternating TS, Rust, TS, Rust, … (never back-to-back).
  - TS: `pnpm exec tsx --tsconfig tsconfig.node.json scripts/irregular-compact-baseline.ts
    --fixture mixed-61 --sheet 2000x2700 --strict --expected-collision-identity-sha256 ...
    --expected-fitted-canonical-sha256 ...` — the same entry
    `scripts/profile-mixed61.mjs` (`pnpm profile:mixed61`) uses, invoked directly without
    `--cpu-prof` (profiling overhead would bias the sample) and without modifying the
    script. Two numbers were recorded per sample: the script's own self-reported
    `elapsedMs` (Effect.runPromise duration only — the "internal" number, primary for
    contract ratios) and an external `date +%s%N`-wrapped whole-process wall time
    ("external", secondary, includes tsx/Node startup — reported for context, not used for
    verdicts since the Rust side's own `elapsedMs` methodology is process-internal too).
  - Rust: `pnpm exec tsx ... scripts/rust-parity/verify-mixed61-hash.ts --sheet 2000x2700
    --profile compact` (existing, unmodified script; drives the real `.node` addon via
    `computeIrregularNestingNative`, the same entry point `nesting.worker.ts` uses). Its own
    `elapsedMs` (Effect.runPromise duration) is the internal number; external wall time
    recorded the same way as TS.
  - Every sample's hash pair was checked against the pinned acceptance-bar values
    (`3839e80d…` collision identity, `ef2b783a…` fitted canonical, 61 placed / 0 unplaced) —
    **exact on every one of the 10 TS+Rust samples** (see §3).
- **Thread matrix (C1):** `MIN_PLANE_IRREGULAR_NATIVE_THREADS=N` env var (the crate's own
  documented resolution order — see `boundary/parallel.rs`) set to 2 and 8, 3 samples each,
  same alternation-free-but-otherwise-identical method as above (Rust-only; thread count is
  meaningless for the TS backend). **`threads=1` and `threads=default` are the same
  configuration on this build**: `boundary::parallel::resolve_thread_count` resolves to a
  compiled-in default of **1** thread whenever `MIN_PLANE_IRREGULAR_NATIVE_THREADS` is
  unset (confirmed by reading `crates/irregular-nesting-native/src/boundary/parallel.rs`
  directly, and independently confirmed empirically: TS wrapper code
  (`nativeIrregularBackend.ts`) never sets this env var). The main C1 batch's 5 Rust
  samples above were run with the env var unset, so they serve as both the `threads=1` and
  the `threads=default` bucket (5 ≥ the contract's minimum of 3) — no separate "default"
  run was needed or possible, since there is no distinct default configuration to measure.
- **C2/C3/C4:** 1 discarded warm-up per backend per case, then 3 alternating samples per
  backend. TS side used `irregular-compact-baseline.ts` exactly as for C1 (fixture/sheet
  varied, expected hashes from `scripts/irregular-compact-nine-baselines.ts`'s pinned
  `BASELINES` table). **`run-differential.ts` was evaluated first but not used for per-case
  timing**: it deliberately never reports wall-clock elapsed for either backend (confirmed
  by grep — its own module doc explains why: timing fields are excluded from comparison,
  and no `elapsedMs`/`Date.now`/`performance.now` call exists anywhere in that file). Since
  scripts may not be modified, a new **additive** script,
  `scripts/rust-parity/time-native-backend.ts`, was written to fill this specific gap: it
  duplicates `irregular-compact-baseline.ts`'s exact request-construction logic (verbatim,
  not reimplemented — same fixtures, same `preparePieces` call, same settings) for
  `triangle-20`/`shapes-17`/`mixed-61` at an arbitrary `--sheet`, then calls
  `computeIrregularNestingNative` and times only that call, mirroring
  `verify-mixed61-hash.ts`'s own methodology so the two backends' `elapsedMs` values stay
  apples-to-apples. No existing script was changed.
- **C6 (capacity production suite):** `pnpm gate:capacity:production` (TS-only, unmodified),
  3 full sequential runs, external wall time only (`date +%s%N` around the whole `pnpm`
  invocation) — no Rust-side timing was collected for this batch per the task's own
  instruction ("Rust equivalence already covered by the differential matrix elsewhere").
- **Peak RSS on C1:** a second additive script, `scripts/rust-parity/measure-peak-rss.ts`
  (`--backend ts|rust`), runs the C1 Mixed-61 `2000x2700` Compact request through the
  requested backend and reports `process.resourceUsage().maxRSS` (Linux: kB, whole-process
  lifetime peak — the same quantity `/usr/bin/time -v`'s "Maximum resident set size" and the
  Rust example's `/proc/self/status` `VmHWM` report) measured after the compute call
  returns. 3 samples per path: TS (via `computeIrregularNesting`), Rust-via-addon (via
  `computeIrregularNestingNative`, same in-process N-API path production uses), and
  Rust-pure-standalone (`examples/run_mixed61`, extended in this batch to print `VmHWM` from
  `/proc/self/status` at the end of its run — no N-API/libuv/Node overhead at all, the
  purest lower bound). `/usr/bin/time -v` itself was not available/attempted as a separate
  wrapper since both `process.resourceUsage().maxRSS` and `/proc/self/status`'s `VmHWM` are
  the same OS-level "peak RSS" quantity `/usr/bin/time -v` reads from the same kernel
  source (`getrusage`/`/proc/<pid>/status`), so no information is lost by using them
  directly instead.
- **All batches ran single-process, strictly serial** (after the one incident in §1 was
  caught and corrected — the batch immediately following it, and every batch after, were
  verified single-process via `ps aux` before launch and monitored to completion before the
  next batch started).
- **Gates run against this batch's additions** (per task instructions, since TS and Rust
  files were touched): `cargo fmt --check` (clean on the two lines this batch touched in
  `run_mixed61.rs`; the crate-wide dirty tree has pre-existing formatting drift elsewhere,
  unrelated to this batch — not fixed here, out of scope), `cargo clippy --release --example
  run_mixed61 -- -D warnings` (clean), `cargo test --release` (**710 passed, 0 failed** —
  matches the STATE claim exactly), `pnpm exec eslint` on both new scripts (clean).
  `pnpm typecheck:node` **fails**, but on a pre-existing, already-committed error in
  `scripts/rust-parity/dump-mixed61-2000x2700-request.ts` (3 errors, `git diff HEAD` on that
  file is empty — it was already broken at `88b5727` before this session started); neither
  new script in this batch appears in the error list. This is reported honestly as a known,
  out-of-scope pre-existing gate failure, not something this batch introduced or fixed.

## 3. C1 — Mixed-61 `2000x2700` Compact (primary gate)

All 10 samples (5 TS + 5 Rust) reproduced the pinned acceptance-bar identity exactly:
collision-identity SHA-256 `3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742`,
fitted-canonical SHA-256 `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`,
61 placed / 0 unplaced, every time. TS's own `--strict` checks (partition, area, canonical
cavities, focused-reconstruction trace fields, short-side observer/pair-fold contracts,
scheduler chronology) also passed on every sample.

### 3.1 Raw samples (internal `elapsedMs`, ms) — 1 warm-up discarded per backend

| # | TS internal | TS external (wall) | Rust internal (threads unset = 1/default) | Rust external (wall) |
| --- | --- | --- | --- | --- |
| 1 | 43110.12 | 43822 | 26760 | 27334 |
| 2 | 43162.69 | 43831 | 26655 | 27226 |
| 3 | 43250.28 | 43934 | 26867 | 27461 |
| 4 | 43148.12 | 43830 | 26836 | 27395 |
| 5 | 43066.13 | 43764 | 26887 | 27458 |
| **median** | **43148.12** | **43830** | **26836** | **27395** |
| min–max | 43066.13–43250.28 | 43764–43934 | 26655–26887 | 27226–27461 |
| IQR | 43110.12–43162.69 (52.57) | 43822–43831 (9) | 26760–26867 (107) | 27334–27458 (124) |

Warm-ups (discarded): TS 43652.36 ms, Rust 26774 ms — both within the measured samples'
range, confirming the warm-up was sufficient and not itself an outlier needing extension.

### 3.2 Thread matrix (Rust only; internal `elapsedMs`, ms)

| threads | samples | median | min–max |
| --- | --- | --- | --- |
| 1 (env unset) | reused from §3.1 (5 samples) | 26836 | 26655–26887 |
| default (env unset — **same config as `threads=1`** on this build, see §2) | reused from §3.1 (5 samples) | 26836 | 26655–26887 |
| 2 | 27091, 26996, 26883 | 26996 | 26883–27091 |
| 8 | 26965, 27065, 27045 | 27045 | 26965–27065 |

All 6 thread-matrix samples (threads=2 ×3, threads=8 ×3) reproduced the identical pinned
hash pair exactly — **P7 holds** across every thread count tested (1/default, 2, 8).
Wall-clock is flat within noise across 1/2/8 threads (26836–27045 ms, a 0.8% spread) —
this workload's Rayon parallel sites (piece-prep loop, per-placed NFP resolution) are not
the wall-clock bottleneck for Mixed-61 Compact at this scale, so additional threads buy
essentially nothing end-to-end.

## 4. C2/C3/C4 — secondary compact cases

All samples (9 TS + 9 Rust across the three cases) reproduced their pinned
`irregular-compact-nine-baselines.ts` acceptance hashes exactly.

### C2 — Triangle-20 `2000x2700` (20 placed / 0 unplaced)

| # | TS internal (ms) | Rust internal (ms) |
| --- | --- | --- |
| 1 | 4270.86 | 2604 |
| 2 | 4271.13 | 2600 |
| 3 | 4311.64 | 2595 |
| **median** | **4271.13** | **2600** |

### C3 — Shapes-17 `2000x2700` (17 placed / 0 unplaced)

| # | TS internal (ms) | Rust internal (ms) |
| --- | --- | --- |
| 1 | 7905.64 | 4951 |
| 2 | 7773.36 | 4809 |
| 3 | 7851.56 | 4866 |
| **median** | **7851.56** | **4866** |

### C4 — Mixed-61 `600x400` (25 placed / 36 unplaced, constrained capacity)

| # | TS internal (ms) | Rust internal (ms) |
| --- | --- | --- |
| 1 | 3956.53 | 1890 |
| 2 | 4004.50 | 1879 |
| 3 | 3853.77 | 1934 |
| **median** | **3956.53** | **1890** |

## 5. C6 — capacity production suite (TS only, per task instruction)

`pnpm gate:capacity:production` (3 sequential runs, no Rust-side measurement — the task
brief directs recording TS timings only here, citing the differential fixture matrix as
the source of Rust capacity-semantics equivalence elsewhere).

| # | exit | wall (ms) | passed |
| --- | --- | --- | --- |
| 1 | 0 | 135677 | true |
| 2 | 0 | 135435 | true |
| 3 | 0 | 135064 | true |
| **median** | | **135435** | |

## 6. Peak RSS on C1

| path | samples (kB) | median (kB) | median (MB) |
| --- | --- | --- | --- |
| TS (`process.resourceUsage().maxRSS`) | 915088, 860932, 864176 | 864176 | ≈844 MB |
| Rust via `.node` addon (`process.resourceUsage().maxRSS`, same Node process) | 283244, 307568, 305236 | 305236 | ≈298 MB |
| Rust pure standalone (`/proc/self/status` `VmHWM`, no Node/N-API at all) | 123468, 122752, 120180 | 122752 | ≈120 MB |

Every sample's placed/unplaced counts and both hashes matched the pinned C1 acceptance
values exactly (checked inline by each wrapper run, not shown again here for brevity —
identical to §3's values on every sample).

## 7. Contract thresholds — verdicts

| # | Threshold | Computed ratio | Verdict |
| --- | --- | --- | --- |
| **P1** | 1-thread median ≤ 0.667 × TS median | 26836 / 43148.12 = **0.6220** | **PASS** (≥1.5×; actual speedup 1.608×) |
| **P2** | default-thread median ≤ 0.40 × TS median | 26836 / 43148.12 = **0.6220** (default = 1-thread config, §2/§3.2) | **FAIL** (needs ≥2.5×; actual 1.608×) |
| **P3** | default-thread median ≤ 0.77 × 1-thread median | 26836 / 26836 = **1.0000** (identical configuration — there is no distinct "default" pool on this build) | **FAIL** (no threading benefit is possible when default==1-thread; threads=2/8 medians of 26996/27045 vs. the 26836 baseline confirm no real speedup from more threads either, ratios 1.006/1.008) |
| **P4** | per-case default-thread median ≤ max(1.10×TS, TS+25ms) | C2: 2600/4271.13=0.609 (threshold 4698.25); C3: 4866/7851.56=0.620 (threshold 8636.72); C4: 1890/3956.53=0.478 (threshold 4352.18) | **PASS** on all three (C2, C3, C4) — Rust median is well under both the TS median itself and the relaxed threshold in every case |
| **P5** | C5 total: 1-thread ≤0.75×TS, default ≤0.60×TS; same for C6 | **not measured** — C5 (nine-baselines full serial suite) was not in this batch's instructed scope, and C6 was recorded TS-only per the task's own instruction (no Rust-side C6 total exists to form a ratio) | **NOT EVALUATED** (see note below — not a pass or fail; the data needed does not exist in this batch) |
| **P6** | default-thread peak RSS on C1 ≤ 1.5 × TS peak RSS | 305236 / 864176 = **0.3532** (Rust-via-addon); 122752/864176 = 0.1420 (Rust-pure, for reference) | **PASS** by a wide margin either way measured |
| **P7** | no thread-count setting changes any semantic output byte | all 10 C1 main-batch samples + all 6 thread-matrix samples (1/default/2/8 threads) reproduced the identical collision-identity and fitted-canonical hash pair, exactly, every time | **PASS** |

**P5 note:** the task's instructed batch list for this measurement session was
"C1 + thread matrix, C2/C3/C4, C6 (TS-only)" — C5 (`pnpm gate:compact-nine-baselines
--skip-png`) and C7 (short-side directional outcomes) were not included, and C6 was
explicitly scoped TS-only ("for Rust equivalence the differential matrix already covers
capacity semantics"). P5 is therefore honestly **unevaluated by this report**, not
passing or failing — a future batch would need to (a) run C5 with the same
alternating-and-thread-matrix method used for C1 here, and (b) run C6 through the Rust
backend (which the differential-fixture-matrix harness already exercises for
correctness, but not for a comparable aggregate wall-clock total) before P5 can be given
a verdict.

## 8. Diff status (reproduced from `git status --short` at measurement time)

```
 M crates/irregular-nesting-native/examples/run_mixed61.rs
 M crates/irregular-nesting-native/src/canonical_grid/contact.rs
 M crates/irregular-nesting-native/src/js_number/js_math.rs
 M crates/irregular-nesting-native/src/search/layout_scorer.rs
 M crates/irregular-nesting-native/src/transforms/flattening.rs
 M crates/irregular-nesting-native/src/transforms/generator.rs
 M crates/irregular-nesting-native/src/validation/sat.rs
 M docs/planning/rust-irregular-backend/evidence/differential-e2e-report.md
 M docs/planning/rust-irregular-backend/stage0-rulings.md
 M package.json
?? .github/workflows/rust-native.yml
?? electron-builder.yml
?? scripts/rust-parity/measure-peak-rss.ts
?? scripts/rust-parity/time-native-backend.ts
```

(`examples/run_mixed61.rs`'s modification is this batch's own VmHWM addition, §2/§6;
`measure-peak-rss.ts` and `time-native-backend.ts` are this batch's own additive scripts.
Everything else predates this measurement session — the N2 fix and packaging work whose
completion was this batch's precondition.)

## 9. Honest promotion conclusion

- **P1 (one-thread native win): PASS.** The Rust backend, run single-threaded, is a real,
  solid 1.61× wall-clock win over TypeScript on the primary gate (43.15 s → 26.84 s,
  internal-timer basis), comfortably past the ≥1.5× bar.
- **P4 (no per-case regression): PASS on all measured cases.** C2/C3/C4 all show the Rust
  backend at 1.6–2.1× faster than TS, nowhere close to regressing.
- **P6 (memory): PASS by a wide margin.** Rust's peak RSS is roughly a third of TS's
  through the addon path (and roughly an eighth of TS's in the pure-Rust standalone path,
  which has no N-API/V8 heap overhead at all) — memory was never a promotion risk on this
  workload.
- **P7 (thread-count neutrality): PASS.** Every semantic hash was byte-identical across
  every thread count tested (1, default, 2, 8) and every sample (16 total Rust runs on C1
  across §3/§3.2) — this crate's job-owned-pool, thread-local, deterministic-Rayon design
  produces the same answer no matter how many workers process it.
- **P2 (primary-gate 2.5× speedup) and P3 (parallel efficiency): FAIL, as expected and as
  this task's own framing anticipated.** The default thread count on this build is
  compiled-in to **1** (no env var override in production TS code, confirmed by source
  inspection) — so P2's "default-thread" measurement is numerically identical to P1's
  "1-thread" measurement, and 1.61× falls well short of the 2.5× bar P2 requires. P3 asks
  whether *turning on* threading buys a further 1.3× beyond the 1-thread number; since the
  compiled default is 1-thread, there is no threading benefit to measure in the production
  default configuration, and even the explicit threads=2/threads=8 samples (§3.2) show
  essentially flat wall-clock (26996 ms, 27045 ms vs. the 26836 ms baseline — a ≤1%
  spread, i.e. no real speedup from more threads on this workload at this scale). This is
  not a measurement artifact: it is a structural fact about the current Rayon
  parallelization's scope (piece-prep loop and per-placed NFP resolution, per the crate's
  own doc comments) not dominating Mixed-61 Compact's wall-clock profile.
- **P5 (aggregate suites): not evaluated** — out of this batch's instructed scope (§7).

**Conclusion, stated plainly:** on the evidence gathered in this batch, the Rust backend
clears the correctness bar (exact hash parity on every one of the 34 archive-eligible
compute samples across C1–C4, plus thread-count invariance across 16 additional C1 runs)
and clears every *unconditional* performance bar it was asked to clear here (P1, P4, P6,
P7). It does **not** clear the two thresholds that were explicitly gated on default
parallelism (P2, P3) — because the shipped default is single-threaded and this workload's
current Rayon coverage does not meaningfully speed up even when more threads are made
available. Per the contract's own binding language ("If a Rayon parallelization makes any
contract case slower, it must be narrowed or removed before promotion; parallelism is not
a success criterion"), this is not a defect requiring rollback — single-threaded Rust is
already a solid, correctness-preserving win over TypeScript — but it does mean **the
backend has not earned unconditional default-on promotion under this contract**: it
remains appropriate as an **opt-in** backend (selectable via the existing
`MIN_PLANE_IRREGULAR_BACKEND`-style selector) rather than the unconditional default,
until either P2/P3 are re-evaluated against a deliberately-relaxed target or the
parallelization is widened enough to close the gap. P5 could not be evaluated in this
batch and should be measured before any final promotion decision is made.
