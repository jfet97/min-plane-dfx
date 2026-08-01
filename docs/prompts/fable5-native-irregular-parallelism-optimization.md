# Fable 5 Prompt: Native Irregular Parallelism Optimization

You are working in an existing checkout of the `min-plane-dfx` repository. Your task is to discover, implement, verify, and deliver the next profitable semantics-preserving native Rust parallelization for irregular nesting.

Read this entire prompt before changing any file.

## 1. Mission

Improve end-to-end execution time for the existing native Rust irregular nesting backend by parallelizing one or more verified hotspots.

This is a performance optimization task, not an algorithm redesign. Preserve every observable semantic contract. A change is accepted only when it is both correct and measurably faster through the real packaged N-API execution path.

The repository already contains a complete native Rust backend. Do not repeat the historical TypeScript-to-Rust port. Do not replace the algorithm. Do not change nesting quality. Begin from current code, current evidence, and current production behavior.

The expected result is one of these:

1. A retained native parallelization with exact semantics and repeatable end-to-end improvement.
2. A cleanly reverted experiment with durable negative evidence explaining why the seam was rejected.

Do not retain speculative concurrency because it looks elegant, uses more cores, or improves a microbenchmark. Lower real job time is the goal.

## 2. Operating mode

Work autonomously from discovery through delivery. Ask the user only when a decision is genuinely theirs and cannot be resolved from repository contracts, current code, or an obvious safe default.

### 2.1 Dynamic workflows are mandatory

Use the `Workflow` tool for substantive delegated work. Do not perform broad exploration, architecture selection, benchmark interpretation, or final multi-dimensional review as one undifferentiated solo pass.

Use dynamic workflows for at least:

- architecture and hotspot discovery;
- independent semantic-contract tracing;
- candidate-seam analysis;
- adversarial review of the proposed parallel boundary;
- verification of evidence completeness;
- review of the final diff before Codex.

Prefer deterministic workflow structures:

- multi-modal discovery for broad repository mapping;
- independent candidate proposals followed by a judge panel when several seams are plausible;
- pipelines for per-seam analysis and verification;
- adversarial verification for semantic and concurrency claims;
- a completeness critic before final delivery.

Keep normal workflows under 15 agents unless the task clearly needs more. Use pipeline execution when later work does not require a full barrier. Use a barrier only for genuine cross-result comparison, deduplication, or judging.

When model controls are available:

- use `gpt-5.6-terra` and `gpt-5.6-luna` at `max` for difficult independent analysis or verification;
- use ordinary `gpt-5.6-sol` workflow work at `medium`;
- use persistent Codex Review Chat with `gpt-5.6-sol` at `xhigh` for the final external review;
- do not request Opus.

Do not stop a running workflow merely because one agent failed. Launch a supplemental workflow for the failed dimension and let the original workflow finish.

### 2.2 Task tracking

Create and maintain a structured task list for non-trivial work. Mark tasks in progress before starting them and complete them only after their verification has passed.

### 2.3 Communication and attribution

- Use English for code, comments, documentation, commit messages, PR text, and user-visible reports.
- Never use em dash or en dash characters.
- Never include Claude, AI, generated-content, tool, or co-author attribution in commits, PRs, comments, or documentation.
- Do not add `Co-Authored-By` lines.
- Be concise in progress reports, but preserve complete evidence in repository documents and artifacts.

## 3. Repository orientation

Resolve the repository root with:

```sh
git rev-parse --show-toplevel
```

Use repository-relative paths in documentation and commands. Inspect the active branch, status, merge base, and recent history before editing.

Start with:

- `knowledge/INDEX.md`
- relevant `knowledge/*.md` pages
- `docs/planning/rust-irregular-backend/`
- current Rust source and tests
- current package scripts
- current CI workflows

The source of truth is current code. Historical prompts and planning documents may contain stale statements. Verify every important claim against current files and `git log -p` when behavior is non-obvious.

### 3.1 Current high-level architecture

The application is an Electron and TypeScript application with a separately built nesting worker. Irregular Compact and Compact Short Side jobs can execute through a coarse N-API call into a complete Rust backend.

The main native crate is:

```text
crates/irregular-nesting-native/
```

Important Rust areas include:

```text
src/boundary/          N-API DTOs, job ownership, diagnostics, errors, events, result boundary
src/domain/            typed domain models
src/geometry/          collision geometry, predicates, free-material metrics, hashing
src/transforms/        flattening, rotation, transform generation, boundary checks
src/nfp_ifp/           NFP and IFP computation, candidate generation, telemetry
src/caches/            geometry caches, identities, legal-candidate memo, telemetry
src/canonical_grid/    exact canonical layout and contact arithmetic
src/validation/        placement legality, SAT, spatial index
src/search/            beam state, scoring, strict decoder, strict families, gap regions
src/archive/           anytime archive, periodic cells/families, reconstruction, shared archive
src/capacity/          preflight, material, prefixes, search, endpoints, telemetry
src/short_side/        directional axes, pair fold, contact strip, observer, JSON
src/checkpoints/       canonical JSON and checkpoint behavior
src/result/            coordinator, materialization, progress
src/trace/             deterministic trace data
```

Trace callers, ownership, and publication boundaries before modifying any module.

### 3.2 TypeScript boundary and reference backend

The TypeScript irregular implementation remains a maintained reference, differential oracle, fallback, and rollback path. The rectangular nesting algorithm remains TypeScript-only.

Inspect current worker and integration files, including:

- `src/workers/nesting.worker.ts`
- `src/workers/algorithm/irregular/computeIrregularNesting.ts`
- `src/workers/algorithm/irregular/irregularWorkerOutput.ts`
- native backend selection and capability code found through current callers
- native build and package scripts under `crates/irregular-nesting-native/scripts/` and `scripts/`

Do not move per-candidate, per-NFP, per-placement, or per-checkpoint traffic across N-API. The production boundary must remain coarse-grained.

## 4. Current native parallelism contract

The native backend uses a job-owned Rayon pool. This is a hard architectural contract.

Read:

- `crates/irregular-nesting-native/src/boundary/parallel.rs`
- `crates/irregular-nesting-native/src/boundary/run_job.rs`
- every current `par_iter`, `into_par_iter`, `rayon::`, `with_job_pool`, and `has_job_pool` site
- `docs/planning/rust-irregular-backend/parallelism-inventory.md`
- `knowledge/strict-scoring-job-pool-parallelism.md`

### 4.1 Never use Rayon's global pool

Every production parallel iterator must execute only inside the nesting job's installed pool.

Do not rely on `with_job_pool` inline fallback around code that already starts a Rayon parallel iterator. If no job-owned pool is installed, use ordinary serial iteration. Add focused tests proving the no-pool path does not enter a Rayon worker.

Do not create an independent global pool, a nested pool, Node worker threads, child processes, or parallel TypeScript backend cohorts.

### 4.2 Existing strict-scoring parallelism

Strict-decoder candidate scoring already has a retained parallel site. Its current contract is important precedent, not a generic license to parallelize neighboring code.

The retained pattern is:

1. Compute the exact admitted candidate prefix serially.
2. Preserve finite, absent, NaN, and positive-infinity cap behavior.
3. Assign stable source ordinals before dispatch.
4. Score only immutable worker inputs.
5. Dispatch bounded chunks through the job-owned pool.
6. Replay each complete chunk serially in source order before dispatching the next chunk.
7. Keep family and gap-contained comparator mutations on the coordinator.
8. Select the lowest-source-ordinal error.
9. Keep timing capture and injected clocks on the original serial path.
10. Use ordinary serial iteration when no job-owned pool is installed.

The current chunk size is 32. Do not alter it without focused correctness tests and fresh performance evidence.

Read the actual implementation and tests in:

- `crates/irregular-nesting-native/src/search/strict_decoder.rs`
- `crates/irregular-nesting-native/tests/strict_decoder_vectors.rs`

Preserve immediate chunk replay and bounded live result memory. Do not accumulate all scored states across a transform.

### 4.3 Inventory before invention

The existing parallelism inventory contains safe candidates, measurement-dependent candidates, forbidden boundaries, risks, and historical reasoning. Its early stage labels may be stale, but its site-level semantic analysis remains useful when verified against current code.

Do not blindly implement the next listed item. Re-profile first. Current Rust cost distribution may differ substantially from historical TypeScript profiling and from earlier native measurements.

## 5. Absolute semantic preservation

The accepted current behavior is the specification, including unusual chronology and JavaScript-compatible edge cases.

Do not change:

- selected layouts;
- placed and unplaced piece-ID partitions;
- placement order;
- coordinates, transforms, or canonical collision geometry;
- fitted canonical geometry;
- canonical keys or canonical JSON bytes;
- SHA-256 identities;
- comparison signs, winners, tie order, or stable sorting;
- prepared-piece, candidate, survivor, endpoint, frontier, archive, or trace order;
- scheduler or producer chronology;
- capacity lane authority;
- checkpoint creation, validation, integrity, or resume behavior;
- work ledgers, evaluation counts, quotas, caps, or truncation boundaries;
- error category, provenance, ordering, or external mapping;
- cancellation, deadline, pause, censoring, memory-cap, or trace-cap classification;
- cache lookup, validation, stale-eviction, recomputation, or publication semantics when they are observable;
- progress event count, ordering, phase sequence, values, or optional-field presence;
- persisted history and selected-layout reveal semantics;
- Compact Short Side directional construction and no-fallback rule;
- numeric tolerances or geometry legality;
- backend routing and fallback policy unless separately authorized.

A geometrically equivalent, visually identical, tolerance-close, or better-packed result is still wrong if it differs from the accepted output.

Do not weaken tests or update expected artifacts to accept a new result.

## 6. Parallel-boundary design rules

Every retained parallel site must satisfy all of these.

### 6.1 Exact admission before dispatch

If a loop has an evaluation cap, quota, deadline-derived budget, checkpoint, early exit, first-success rule, or short-circuit, determine the exact admitted work serially before dispatch.

Do not eagerly evaluate work that changes:

- counters;
- cache mutations;
- timing callbacks;
- cancellation chronology;
- deadline chronology;
- trace entries;
- checkpoint state;
- memory retention;
- failure visibility.

If the exact admitted set cannot be derived without executing serial state transitions, the proposed seam is not yet safe.

### 6.2 Stable ordinals

Assign a stable source ordinal before parallel execution. Ordinals must derive from the original contractual order, not map iteration, task start order, thread index, or completion order.

### 6.3 Immutable worker inputs

Rayon workers may read immutable shared state and own their local work packets. Prefer `Arc` for genuinely shared immutable structures when it reduces expensive cloning.

Workers must not mutate or publish to:

- archives;
- beams or frontiers;
- caches or memos unless a separately verified cache protocol explicitly permits it;
- scheduler ledgers;
- checkpoints;
- traces;
- progress sinks;
- comparator-owned maps;
- result objects;
- diagnostic channels that feed semantic behavior.

### 6.4 Ordered serial replay

Collect indexed worker outcomes and replay them on the coordinator in original source order.

The coordinator remains authoritative for:

- stable comparison;
- first-write or last-write map semantics;
- deduplication;
- tie-breaking;
- error selection;
- accounting;
- archive admission;
- cache publication when ordering matters;
- checkpointing;
- trace emission;
- progress emission;
- final publication.

Never let the first completed task win.

### 6.5 Numeric reduction

Binary64 arithmetic is not generally associative. Parallelize production of independent terms only when the final fold can remain in the exact original left-to-right order.

Exact integer reductions may be reordered only after overflow behavior and representation are proved safe.

Do not introduce an epsilon. Do not enable floating-point reassociation or fast-math behavior.

### 6.6 Errors and panics

When several workers can fail, choose the error associated with the lowest source ordinal unless current behavior defines another exact order.

Do not expose task-completion order through error provenance.

Keep panic containment at the whole-job boundary. Do not allow an unwind to cross N-API or terminate Electron.

### 6.7 Bounded work and memory

Bound packet size and in-flight outcomes. Prove that parallel work does not retain complete beam states, geometry, or endpoint objects across an unbounded candidate set.

Measure peak RSS. A speedup that violates the approved memory bound is rejected.

### 6.8 Timing and injected clocks

Timing capture and deterministic injected clocks can make an otherwise pure scoring path observably serial. Preserve the existing serial authority unless you prove exact callback count, order, and checkpoint bytes under the injected clock.

Do not move timing callbacks into Rayon workers.

### 6.9 Cancellation and deadlines

Map existing control checkpoints before changing a loop. Do not add eager worker-side control checks merely for responsiveness if they change admitted work or chronology.

Cancellation and deadlines must never become:

- an invalid candidate;
- a cache miss;
- a generic native error;
- a cold restart;
- a partial layout;
- a TypeScript retry.

### 6.10 Cache interaction

Treat cache behavior as a separate design problem.

Before parallelizing a cache-touching seam, verify:

- exact lookup order;
- hit validation;
- stale detection and removal;
- miss computation;
- invalid-value non-publication;
- exact immutable result equality;
- duplicate-computation or single-flight policy;
- lock scope;
- cancellation cleanup;
- panic cleanup;
- bounded memory;
- whether insertion order affects telemetry or behavior.

Do not hold a coarse cache lock during expensive geometry work. Do not destroy high hit rates by switching blindly to thread-local caches. Do not introduce single-flight without proving waiters cannot deadlock, leak, or remain poisoned after failure.

## 7. Forbidden parallelization shapes

Do not parallelize these as uncontrolled races:

- complete versus capacity producers;
- cold versus warm capacity lanes;
- producer roles whose scheduler chronology is contractual;
- archive admission as tasks finish;
- frontier retention as tasks finish;
- survivor selection by completion order;
- checkpoints or traces emitted by workers;
- Short Side branches whose first valid result has ordered authority;
- wall-clock-budgeted loops whose next allowance depends on previous elapsed time;
- mutable spatial-index updates shared by sibling tasks;
- concurrent map iteration used as a ranking source;
- progress callbacks from Rayon workers;
- N-API calls from Rayon workers;
- nested Rayon pools or global-pool fallback.

A logically serial orchestrator with parallel pure subcomputations is the preferred architecture.

## 8. Discovery workflow

### 8.1 Establish the exact source state

Record:

- commit and branch;
- merge base;
- dirty status and full patch hash;
- Node, pnpm, Electron, Rust, and target versions;
- host OS and architecture;
- CPU model and logical/physical core counts;
- native addon hash;
- native capability output;
- effective thread count and cache policy.

Do not benchmark an unrecorded dirty tree.

### 8.2 Read the knowledge base

Use both semantic search and exact search when available:

```sh
qmd query "native irregular parallelism hotspot" -n 10
rg -n "Rayon|parallel|JobPool|candidate scoring|checkpoint|evaluation cap" knowledge docs crates src scripts
```

If `qmd` crashes after returning results, preserve the useful results and continue with exact search. Do not treat a cleanup crash as proof that no knowledge exists.

### 8.3 Inventory current Rayon sites

Search every current site:

```sh
rg -n "rayon|par_iter|into_par_iter|with_job_pool|has_job_pool|ThreadPool" crates/irregular-nesting-native
```

For each site, document:

- owner module;
- input order;
- shared state;
- coordinator replay;
- error ordering;
- cap and checkpoint interaction;
- cache interaction;
- memory bound;
- tests;
- measured benefit.

### 8.4 Profile before selecting a seam

Use production-shaped profiling and the real packaged N-API path. Do not infer the next hotspot from old source structure.

Inspect and reuse current tools, including:

- `pnpm profile:mixed61`
- `scripts/analyze-cpu-profile.ts`
- `scripts/rust-parity/`
- `scripts/rust-parity/time-native-backend.ts`
- existing performance and aggregate runners
- `docs/planning/rust-irregular-backend/evidence/`
- `docs/artifacts/native-hotspot-parallelism/`

Native CPU profiling may require platform-specific tools. Use the smallest reliable measurement that locates self time or phase time without changing the semantic path.

### 8.5 Generate candidate seams

Use a dynamic workflow with several independent lenses:

1. CPU self-time and frequency.
2. Allocation and cloning cost.
3. Lock and cache contention.
4. Pure batch width and grain size.
5. Semantic risk and chronology.
6. Expected Amdahl-law ceiling.

For each candidate seam, produce a card containing:

- exact path and function;
- measured cost share;
- representative batch width;
- immutable input packet;
- exact serial admission rule;
- source ordinal scheme;
- serial replay and comparator;
- cache behavior;
- cancellation and checkpoint behavior;
- error ordering;
- memory bound;
- focused RED tests;
- benchmark command;
- rollback plan;
- expected speedup ceiling.

Use a judge panel to select the best seam. Prefer one meaningful parallel boundary over many tiny dispatches.

## 9. Experiment protocol

### 9.1 Baseline first

Before production changes, build and measure an exact baseline from the selected base commit.

Use the real packaged N-API backend. Assert that the requested Rust backend actually executed. A silent TypeScript fallback invalidates the sample.

Preserve:

- raw sample outputs;
- semantic hashes;
- placed and unplaced counts;
- area and cavity metrics;
- evaluation counts;
- diagnostics;
- wall time;
- peak RSS;
- command lines;
- environment;
- addon hash;
- source commit and dirty patch hash.

### 9.2 Quiet-host policy

Do not run measurements while another CPU-heavy process, benchmark, release test, build, or workflow is competing for CPU.

Do not overlap CPU-heavy commands with each other.

Before every measurement batch, inspect host load and relevant processes. If the host is busy, wait. Do not report contested measurements as evidence.

### 9.3 One warm-up and repeated samples

Use at least one discarded warm-up for each relevant backend and thread configuration. Use repeated measured samples and report all valid samples.

Alternate baseline and candidate runs when practical to reduce drift. Do not compare an unfair cold baseline against a warm candidate.

Use median as the primary statistic unless an existing preregistered contract specifies otherwise. Report min, max, and a dispersion measure such as IQR.

### 9.4 Thread matrix

Measure at least:

- one thread;
- two threads;
- four threads;
- eight threads when the host supports it;
- compiled default threads.

Do not change the compiled default merely because an explicit high thread count wins one workload. Change thread policy only with separate complete-suite evidence and explicit approval when required.

### 9.5 Real end-to-end gate

A microbenchmark may explain a seam, but it cannot retain it. Retention requires repeatable improvement through the complete packaged N-API job.

For the primary heavy case, require at least two independent candidate batches. A speedup must exceed normal run-to-run noise.

### 9.6 Aggregate quality matrix

Run representative Compact, capacity, and Short Side cases, including maintained C1, C5, C6, and C7 evidence where those labels still exist in current scripts and documentation.

Interpret them correctly:

- C1 is the primary Mixed-61 Compact heavy workload.
- C5 is the nine Compact fixture and sheet matrix.
- C6 is the production capacity fixture matrix.
- C7 is the Short Side fixture and sheet matrix.

These long aggregate measurements are local evidence tools, not commands that must be added wholesale to every PR CI run.

### 9.7 Controlled-host authority

Local macOS measurements are diagnostic unless the performance contract explicitly grants them authority.

Do not claim controlled-Linux acceptance from local macOS results. Preserve historical controlled-host verdicts unless new evidence satisfies the documented controlled-host contract.

If controlled Linux is required, follow the repository's fail-closed host, clean-tree, provenance, and scheduling requirements. Read `knowledge/docker-p5-controlled-host.md` and current P5 documentation.

## 10. Test-driven implementation

Follow strict RED, GREEN, REFACTOR cycles for every production behavior change.

### 10.1 RED

Before production code, add focused tests that fail for the intended missing behavior. At minimum, cover:

- exact admitted prefix;
- stable source ordinals;
- perturbed completion order;
- source-order success replay;
- source-order error selection;
- no-pool serial fallback;
- installed-pool dispatch;
- bounded chunk or packet chronology;
- memory-retention boundary where testable;
- finite, absent, NaN, and infinity caps when applicable;
- comparator ties;
- first-write or last-write dedup semantics;
- checkpoint and resume parity;
- timing capture and injected-clock fallback;
- relevant cancellation and deadline chronology;
- 1, 2, 4, and 8-thread semantic equality.

Run the focused test and observe the expected failure before implementation.

### 10.2 GREEN

Implement the smallest parallel boundary that satisfies the tests. Do not add unrelated refactors, new scheduling systems, generic executors, or speculative abstractions.

### 10.3 REFACTOR

Refactor only after focused tests pass. Preserve a simple serial fallback and easy rollback.

### 10.4 Reject quickly

Revert the experiment immediately if it changes any semantic field, error, hash, checkpoint, trace, callback order, counter, cap boundary, or backend selection.

If the seam is correct but slower end to end, remove it and preserve negative evidence. Do not keep it for possible future value.

## 11. Correctness and determinism verification

Verification must be layered. Run focused checks first, then broader gates only after the seam is stable.

Do not repeatedly rerun the same broad suite without a code or evidence change that can affect it.

### 11.1 Focused Rust checks

Run relevant unit and integration tests in release mode. Important test areas include:

- strict decoder vectors;
- thread equality;
- coordinator vectors;
- capacity search vectors;
- cancellation and resume;
- cache cleanup and cap equivalence;
- checkpoint corruption and round-trip behavior;
- Short Side vectors;
- boundary run-job behavior.

Discover exact current test names before invoking filters.

### 11.2 Exact semantic projection

Compare, as applicable:

- placement order;
- placed and unplaced IDs;
- canonical occupied geometry;
- fitted canonical identity;
- score and comparator outcomes;
- step trace and decision trace;
- gap-fill evidence;
- candidate and placement evaluation counts;
- truncation and pause reason;
- checkpoint presence and contents;
- resumed completion;
- error category and provenance;
- progress sequence;
- archive and frontier order;
- capacity lane behavior;
- Short Side directional output.

Exclude only fields already designated non-semantic, such as real elapsed measurements or separate backend diagnostics. Never exclude a field merely because it differs.

### 11.3 Known exact differential characterization

Current Rust standard-library `f64::hypot` can produce bounded last-bit differences from JavaScript in `freeMaterialSliverMetric`. Read:

- `knowledge/native-hypot-parity.md`
- current exact differential documentation and tests

Do not rediscover or misreport this known characterization as a new regression. Do not weaken blocking quality acceptance because of it. Do not repeatedly run the full exact differential suite after the characterization is already established and unaffected by the change.

### 11.4 Thread equality

For every retained seam, compare exact semantics at 1, 2, 4, and 8 threads across representative modes and boundary cases. Repeat enough to expose ordering races. Where practical, perturb task completion order in a focused test rather than relying only on nondeterministic scheduling.

## 12. Quality, memory, and packaging gates

Current package scripts include:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build:native
pnpm test:native:package
pnpm test:differential
pnpm test:differential:exact
pnpm gate:quality-acceptance
pnpm gate:mixed61-compact
pnpm gate:compact-nine-baselines
pnpm gate:capacity
pnpm gate:capacity:production
```

Inspect `package.json` and current docs before relying on this list.

For a retained production change, complete the appropriate full gate sequence serially:

1. `cargo fmt --manifest-path crates/irregular-nesting-native/Cargo.toml -- --check`
2. `cargo clippy --release --manifest-path crates/irregular-nesting-native/Cargo.toml --all-targets -- -D warnings`
3. full release Rust tests
4. hotspot-specific 1, 2, 4, and 8-thread equality
5. relevant cancellation, checkpoint, resume, and cache suites
6. `pnpm typecheck`
7. `pnpm lint`
8. `pnpm test`
9. `pnpm build:native`
10. `pnpm test:native:package`
11. differential and quality acceptance gates appropriate to the changed semantics
12. production capacity and layout gates
13. final C1 and aggregate performance evidence
14. supported hosted package matrix

Call IDE diagnostics directly before finalizing when the environment provides them. If direct IDE diagnostics are unavailable, record that fact and use compiler, Clippy, TypeScript, ESLint, and test output as the executable diagnostics.

Do not run CPU-heavy gates concurrently.

### 12.1 Supported package matrix

Inspect `.github/workflows/rust-native.yml` and `.github/workflows/capacity-quality.yml`.

Hosted validation should preserve, as applicable:

- Linux x64 native package;
- Windows x64 native package;
- macOS arm64 native package;
- macOS x64 native package;
- Rust format;
- Rust lint;
- Rust unit tests;
- native build and addon smoke;
- packaged native load;
- thread-count determinism;
- required differential rows;
- layout matrix;
- capacity quality.

Do not claim a platform is supported until its artifact builds and loads through the packaged path.

## 13. Evidence and provenance

Evidence must be reproducible and reviewable after temporary directories disappear.

### 13.1 Immutable experiment root

Create a unique immutable experiment root outside the working tree for raw local artifacts. Include separate directories for:

- source snapshot or patch;
- baseline;
- candidate batches;
- aggregate matrices;
- memory measurements;
- environment and commands.

Never overwrite an earlier batch after source changes. A source change invalidates in-progress candidate measurements. Stop and rerun against the exact final source.

### 13.2 Hashes

Record SHA-256 hashes for:

- source patch;
- native addon;
- benchmark runner scripts;
- raw samples;
- summaries;
- baseline payloads.

A checksum manifest must not include itself. Verify it with a clean command before citing it.

### 13.3 Portable repository evidence

Commit concise portable summaries and manifests under the repository's existing evidence and artifact policy. Do not commit huge raw local artifacts unless policy explicitly requires it.

A portable manifest should include:

- base commit;
- candidate commit or dirty patch hash;
- branch;
- environment;
- exact commands;
- runner hashes;
- addon hashes;
- baseline and candidate artifact locations;
- checksum locations;
- sample validity rules;
- authority limitations.

### 13.4 Performance report

Update current performance documentation with:

- all measured samples or links to raw samples;
- medians and dispersion;
- per-thread comparison;
- one-thread overhead;
- multi-thread gains;
- peak RSS;
- quality and backend-execution validation;
- retained or rejected verdict;
- local versus controlled-host authority;
- known limitations.

Do not hide regressions. Do not change historical conclusions without new authoritative evidence.

### 13.5 Parallelism inventory

Update `docs/planning/rust-irregular-backend/parallelism-inventory.md` for every attempted seam:

- status;
- exact implementation boundary;
- semantic conditions;
- tests;
- benchmark result;
- retained or rejected decision;
- evidence link.

## 14. Final review

### 14.1 Internal dynamic workflow review

Before Codex, run a dynamic workflow over the final diff with independent lenses:

- semantic correctness;
- concurrency and race safety;
- cancellation, checkpoint, and chronology;
- cache behavior;
- memory bounds;
- performance methodology;
- packaging and CI;
- evidence and provenance completeness.

Adversarially verify every finding before changing code. Do not report speculative issues as facts.

### 14.2 Persistent Codex Review Chat

Run the final external review through persistent Codex Review Chat using `gpt-5.6-sol` at `xhigh`.

Use the same Codex thread for follow-up rounds. Do not start a fresh reviewer for each response.

The review subject is the final diff plus portable evidence and relevant immutable local evidence. Require stable finding IDs and the strict verdict protocol.

Resolve or technically rebut every finding. If Codex insists after a grounded rebuttal, escalate only the disputed point for user ruling. Do not merge without:

```text
VERDICT: APPROVED
```

Keep the review log for audit.

## 15. Delivery

### 15.1 Branch and commits

Work on a feature branch based on current `main`. Do not implement directly on `main` unless the user explicitly instructs it for that task.

Use focused commits. Do not mix unrelated cleanup with the optimization.

Before committing:

- inspect the exact diff;
- verify no accidental expected-value changes;
- verify no temporary artifacts entered the tree;
- verify no attribution footer exists;
- verify documentation contains no em dash or en dash characters.

### 15.2 Push and PR

Push the feature branch and open a PR only after final local verification and Codex approval.

The PR body must contain exactly these top-level sections:

```markdown
## Why

## What

## How

## Remarks
```

Report performance honestly, including one-thread overhead, explicit-thread gains, default-thread policy, memory, and authority limits.

### 15.3 CI

Monitor every hosted check. Inspect real logs for failures. Fix failures on the branch, rerun only affected local gates, push, and continue monitoring.

Do not merge while any required check is failing or pending.

Repository auto-merge may be enabled, but use it only when the PR is approved and configured to merge after all required checks pass.

### 15.4 Merge and cleanup

After all required checks are green:

1. Merge using the repository's accepted strategy.
2. Delete the remote feature branch.
3. Update local `main` to the merge commit.
4. Delete the local feature branch when safe.
5. Run minimal post-merge smoke tests through the merged native path.
6. Verify the merged commit and native capability.
7. Update the knowledge base for durable architectural findings.

Do not repeat the complete expensive matrix post-merge when hosted CI and pre-merge evidence already covered it. Use focused smoke tests only.

## 16. Candidate seam guidance

Fresh profiling decides priority. The following are investigation leads, not authorizations:

- capacity candidate scoring after exact quota admission;
- capacity endpoint materialization across a fixed frontier with serial dedup replay;
- topology measurement precomputation before serial retention sorts;
- independent NFP miss computation after serial key deduplication and a verified cache protocol;
- candidate legality components over an immutable spatial-index snapshot;
- periodic-cell candidate evaluation with stable catalog ordinals and serial dedup replay;
- strict completed-layout dominance matrix computation followed by serial Pareto peeling;
- collision-family key computation followed by serial first-occurrence grouping;
- independent preparation or transform materialization by prepared-piece ordinal;
- independent pairwise canonical contact computations with serial binary64 reduction;
- Short Side pure construction packets only where portfolio authority and first-success chronology remain serial.

Prefer seams with:

- large measured self-time;
- wide enough batches to amortize Rayon overhead;
- immutable inputs;
- no cache writes;
- exact serial admission;
- simple ordinal replay;
- bounded output size;
- clear focused tests;
- easy rollback.

Avoid tiny fan-outs of two or four unless the per-item work is demonstrably expensive.

## 17. Manual executor decision gate

Do not build a custom thread executor by default.

Consider one only if a retained, profile-proven seam shows that Rayon scheduling or grain size is the measured limiting factor.

A manual executor would need:

- one job-owned worker set;
- bounded channels or stable slots;
- bounded in-flight packets;
- stable source ordinals;
- complete joins on success, failure, cancellation, deadline, and panic;
- read-only cancellation state;
- no worker publication after cancellation;
- serial error and mutation replay;
- no shared mutable caches, archives, beams, memos, ledgers, checkpoints, comparators, or trace sinks.

Keep it only if it materially and repeatably beats tuned Rayon end to end and passes the entire acceptance matrix. Otherwise delete it completely. Never ship two schedulers without separate measured needs.

## 18. Stop conditions

Stop, investigate, and revert the current experiment if any of these occurs:

- a semantic hash changes;
- placed or unplaced partitions change;
- placement or archive order changes;
- comparator winners or ties change;
- evaluation counts or cap boundaries change;
- scheduler, lane, trace, or progress chronology changes;
- checkpoint or resumed output differs;
- error selection follows completion order;
- cancellation returns partial geometry;
- a Rayon iterator can reach the global pool;
- worker mutation or publication becomes necessary;
- memory becomes unbounded or exceeds the approved limit;
- cache contention destroys reuse;
- a broad test expectation must be weakened;
- Rust silently falls back to TypeScript during a Rust gate;
- packaged Electron cannot load the addon;
- local speedup disappears in repeated end-to-end batches;
- a maintained suite regresses materially;
- controlled-host authority is claimed without satisfying its contract.

When a mismatch occurs, create the smallest focused reproduction. Fix the root cause. Do not update accepted outputs.

## 19. Definition of done

The work is complete only when all of these are true:

### Discovery

- Current native hotspots were measured through the real packaged N-API path.
- Existing Rayon sites and job-pool ownership were inventoried.
- The selected seam has a documented semantic boundary and expected speedup ceiling.
- Alternative seams were judged through a dynamic workflow.

### Correctness

- Focused RED tests failed for the intended reason before production code.
- Exact serial admission is preserved.
- Stable ordinals are assigned before dispatch.
- Worker inputs are immutable.
- Coordinator replay preserves every mutation and comparator.
- Error order is deterministic.
- Cancellation, timing, checkpoint, trace, progress, cache, hash, and publication contracts are preserved.
- Thread counts 1, 2, 4, and 8 produce identical semantic outputs.
- The TypeScript oracle and blocking quality gates remain satisfied.

### Parallelism

- Only the job-owned Rayon pool executes production parallel work.
- No global-pool fallback exists.
- Work and live outcomes are bounded.
- There is no completion-order authority.
- No new thread or pool leak exists.

### Performance

- The final exact source has at least two independent valid primary candidate batches.
- Multi-thread improvement is repeatable and exceeds noise.
- One-thread overhead is reported.
- Representative Compact, capacity, and Short Side suites do not materially regress.
- Peak RSS remains within the approved bound.
- Controlled-host authority is stated accurately.

### Quality and integration

- Rust format, Clippy, release tests, TypeScript typecheck, ESLint, Vitest, native build, package tests, differential checks, quality gates, capacity gates, and layout gates appropriate to the change pass.
- Supported hosted package jobs pass.
- Requested Rust execution never silently used TypeScript.

### Evidence and review

- Raw local evidence is immutable and checksummed.
- Portable summaries and manifests are committed.
- The parallelism inventory and performance report are updated.
- Dynamic workflow review found no unresolved verified issue.
- Persistent Codex Review Chat returns `VERDICT: APPROVED`.

### Delivery

- The feature branch is committed and pushed.
- The PR uses exactly the required four sections.
- Hosted CI is green.
- The PR is merged.
- Branches are cleaned up.
- Local `main` is updated.
- Minimal merged-main native smoke tests pass.
- Durable knowledge is updated.

## 20. First actions

Execute these in order:

1. Read `knowledge/INDEX.md` and relevant knowledge pages.
2. Inspect branch, status, merge base, recent history, and current docs.
3. Create a task list.
4. Launch a dynamic discovery workflow over architecture, semantics, current Rayon sites, and performance tooling.
5. Record exact environment and source provenance.
6. Build the release addon and verify the real Rust backend executes.
7. Establish a quiet-host baseline through the packaged N-API path.
8. Profile current native execution.
9. Generate and judge candidate seams with dynamic workflows.
10. Write the selected seam contract and rollback plan.
11. Add focused RED tests and observe them fail.
12. Implement the minimum GREEN parallel boundary through the job-owned pool.
13. Run focused correctness and thread-equality checks.
14. Measure the exact candidate source end to end.
15. Retain or revert based on the evidence.
16. Run full serial verification for a retained seam.
17. Update evidence, inventory, and knowledge.
18. Run dynamic internal review.
19. Obtain persistent Codex Sol xhigh approval.
20. Commit, push, open the PR, monitor CI, merge, clean up, and smoke-test merged `main`.

Deliver only semantics-preserving, measured speed. If the best result is negative evidence, deliver that honestly rather than shipping unprofitable parallelism.
