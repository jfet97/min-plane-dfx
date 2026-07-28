# Implementation Prompt for Claude Fable 5

You are working in an existing checkout of the `min-plane-dfx` repository. Do not assume a machine-specific absolute path. Resolve the repository root with `git rev-parse --show-toplevel` and use repository-relative paths throughout the work.

Your task is to implement a production-grade native Rust backend for the complete polygon-based irregular nesting implementation used by the Compact and Compact Short Side profiles.

This is a semantics-preserving performance port. It is not an algorithm redesign. It is not an opportunity to change output quality, ranking, scheduling, geometry, tests, fixtures, limits, or production behavior. The only accepted externally observable improvement is reduced execution time.

Read this entire prompt before editing anything.

## 1. Non-negotiable objective

Rewrite the full irregular polygon algorithm for these two production profiles in Rust:

1. Compact
2. Compact Short Side, also referred to in the repository as Short Side or shortest-side-first

Use:

- Rust for the complete irregular implementation
- `napi-rs` for the Node and Electron native-addon boundary
- Rayon for real native multithreading where work is demonstrably independent and can be merged deterministically

Keep the following in TypeScript:

- the existing rectangular nesting algorithm
- Electron orchestration, IPC, worker supervision, request decoding, and application lifecycle boundaries unless a narrow compatibility adapter is needed
- the existing irregular TypeScript implementation as a maintained reference backend, differential oracle, fallback, and rollback path

The completed architecture must not be a small collection of Rust hot kernels called repeatedly from TypeScript. The final Rust backend must own the entire execution of an irregular Compact or Compact Short Side nesting job after a coarse-grained request crosses the N-API boundary. This includes preparation, geometry, caches, search, checkpoints, archive selection, Short Side construction, result materialization, diagnostics, and all deterministic work accounting that belongs to the algorithm.

Incremental implementation phases are allowed and encouraged for validation, but the final promoted backend must be a full Rust implementation. Do not stop after porting NFP, IFP, canonical keys, validation, or another subset.

## 2. Absolute semantic preservation rule

The Rust port must preserve the current TypeScript implementation's semantics exactly.

The existing TypeScript behavior is the specification, including behavior that appears unusual, inefficient, historically ordered, or inconvenient to express in Rust. Do not clean up observable behavior unless you can prove that it is completely unobservable and all differential gates remain exact.

The only accepted production improvement is execution time.

Do not change any of the following to make the Rust implementation easier or faster:

- selected layouts
- placed or unplaced piece-ID partitions
- placement coordinates or transforms
- canonical collision geometry
- fitted canonical geometry
- canonical keys
- canonical JSON bytes used by hashes
- SHA-256 identities
- comparison signs
- ranking winners
- stable tie order
- prepared-piece order
- candidate order
- survivor order
- archive order
- scheduler chronology
- checkpoint chronology
- work ledgers
- evaluation counts
- deterministic caps
- trace statuses
- strategy identities
- fallback rules
- cancellation classifications
- deadline classifications
- persisted history semantics
- decision-trace ordering
- error codes or error provenance
- numeric tolerances
- geometry legality
- complete-over-capacity authority
- Compact Short Side directional behavior

A result that is geometrically close, visually identical, equivalent within a tolerance, or better packed is still incorrect if it differs from the accepted TypeScript result.

Do not introduce an epsilon into any exact comparison. The existing `0.002 mm` conservative offset allowance is a derived geometry bound, not a ranking tolerance.

## 3. Existing tests and baselines are immutable

The existing tests must not change by one millimeter, one hash byte, one expected counter, or one semantic assertion.

Do not:

- edit existing expected values
- regenerate snapshots or golden artifacts to accept Rust output
- loosen tolerances
- increase area ceilings
- increase runtime ceilings merely to make the port pass
- remove assertions
- skip tests
- mark tests flaky
- change fixtures
- change prepared orders
- change expected hashes
- change expected status values
- alter production gates to select a friendlier case
- add conditional assertions that weaken the TypeScript baseline when Rust is enabled
- silently exclude the Rust backend from existing quality gates

You may add new tests. New tests must strengthen parity, concurrency, cache, packaging, and performance verification. They must not replace existing tests.

The unchanged existing test suite and production gates remain authoritative. If Rust disagrees with an existing test, investigate and fix Rust. Do not modify the test unless you first prove that the test is internally inconsistent with the current TypeScript production implementation and obtain an explicit user ruling.

Before implementation, record hashes of all existing tests, fixtures, accepted artifact inputs, and gate scripts relevant to this migration. At final acceptance, prove that these files remain byte-identical unless the only edits are additive backend-selection coverage that does not modify any existing expectation. Prefer adding separate test files instead of editing existing ones.

## 4. Scope boundaries

### 4.1 Included

The Rust backend must eventually own all behavior needed to execute Compact and Compact Short Side, including:

- trusted request conversion after TypeScript schema validation
- collision-geometry preparation
- curve flattening behavior used by the irregular pipeline
- conservative padding and offset behavior
- transform generation
- adaptive Compact transform policy
- transformed collision geometry
- NFP generation
- IFP generation
- NFP and IFP validation
- geometry cache keys and values
- shared geometry caches
- canonical-grid conversion
- exact canonical-grid arithmetic
- robust legality checks
- placed-collision spatial indexing
- contact computation
- candidate generation
- candidate validation
- local candidate scoring
- canonical state keys
- complete sheetless construction
- strict decoder behavior
- gap regions
- repeated-family grouping
- periodic cells and periodic continuation construction
- focused reconstruction
- shared archive validation, deduplication, and ranking
- capacity preflight
- capacity material accounting
- capacity endpoint construction
- capacity prefixes
- place-or-permanent-skip capacity search
- cold, warm-prefix, and quality-warm-prefix capacity lanes
- all resumable checkpoint state and validation
- anytime scheduler chronology
- complete-over-capacity selection
- Compact result materialization
- Compact Short Side axis selection
- pair-fold construction
- multi-row shelf construction
- protected prepared-order depth-first contact strip
- capped contact-first strip
- bounded reverse-depth and canonical-ID continuations
- Short Side exact contact tuple
- Short Side directional validation and comparison
- final result conversion
- deterministic diagnostics and telemetry
- selected-layout reveal data needed by TypeScript history persistence
- cancellation and deadline propagation within native work

### 4.2 Excluded

Do not rewrite the rectangular nesting algorithm in Rust. The rectangular worker mode remains TypeScript.

Do not turn this migration into an application-wide Rust rewrite. Renderer UI, Electron main-process services, persistence, and unrelated algorithms remain outside scope except for the smallest integration changes needed to load, select, package, and exercise the native backend.

Do not create nested Node worker threads, child processes, or parallel TypeScript backend cohorts. Real parallel execution belongs inside the Rust addon through Rayon.

## 5. Authoritative implementation map

Start from `knowledge/INDEX.md` and read all relevant knowledge pages before editing. Branch-specific pages for the active branch take precedence according to the repository knowledge rules.

At minimum, study these pages:

- `knowledge/pure-irregular-core.md`
- `knowledge/canonical-key-hot-path.md`
- `knowledge/canonical-grid-metric-exactness.md`
- `knowledge/compact-short-side-observer.md`
- `knowledge/archive-only-compact-production.md`
- `knowledge/intrinsic-anytime-portfolio.md`
- `knowledge/capacity-retention-quality-guard.md`
- `knowledge/single-process-compact-execution.md`
- `knowledge/nfp-cache-checkpoint-cost.md`
- `knowledge/irregular-trace-replay.md`
- `knowledge/maintained-compact-corpus.md`
- `knowledge/adaptive-compact-transform-policy.md`
- `knowledge/effect-schema-hot-path-boundary.md`

The previous single-process and sequential-execution documentation describes the current TypeScript implementation. This task explicitly authorizes true native multithreading inside the Rust backend. It does not authorize semantic changes, parallel TypeScript cohorts, completion-order selection, or nondeterministic scheduling. Treat the old restriction as superseded only for carefully designed, semantics-preserving Rayon work inside one native nesting job.

Use the current source as the final authority. Important files include, but are not limited to:

### Coordination and execution

- `src/workers/nesting.worker.ts`
- `src/workers/algorithm/irregular/computeIrregularNesting.ts`
- `src/workers/algorithm/irregular/irregularWorkerOutput.ts`

### Complete Compact construction

- `src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.ts`
- `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts`
- `src/workers/algorithm/irregular/intrinsicGapRegions.ts`
- `src/workers/algorithm/irregular/intrinsicStrictFamilyPortfolio.ts`
- `src/workers/algorithm/irregular/intrinsicPeriodicCells.ts`
- `src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts`
- `src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.ts`
- `src/workers/algorithm/irregular/intrinsicAnytimeArchive.ts`

### Capacity

- `src/workers/algorithm/irregular/intrinsicCapacityPreflight.ts`
- `src/workers/algorithm/irregular/intrinsicCapacityMaterial.ts`
- `src/workers/algorithm/irregular/intrinsicCapacityEndpoint.ts`
- `src/workers/algorithm/irregular/intrinsicCapacityPrefixes.ts`
- `src/workers/algorithm/irregular/intrinsicCapacitySearch.ts`
- `src/workers/algorithm/irregular/intrinsicCapacityMode.ts`
- `src/workers/algorithm/irregular/intrinsicCapacityTelemetry.ts`
- `src/workers/algorithm/irregular/intrinsicPlaceDeferCompleteShadow.ts`

### Compact Short Side

- `src/workers/algorithm/irregular/intrinsicShortSideAxes.ts`
- `src/workers/algorithm/irregular/intrinsicShortSideObserver.ts`
- `src/workers/algorithm/irregular/intrinsicShortSidePairFoldObserver.ts`
- `src/workers/algorithm/irregular/intrinsicShortSideContactStrip.ts`

### Search, keys, and scoring

- `src/workers/algorithm/irregular/irregularBeamState.ts`
- `src/workers/algorithm/irregular/irregularPlacementScorer.ts`
- `src/workers/algorithm/irregular/irregularLayoutScorer.ts`
- `src/workers/algorithm/irregular/irregularScoreGrid.ts`
- `src/workers/algorithm/sortPiecesForNesting.ts`

### Geometry and caches

- `src/workers/irregular/nfpIfpService.ts`
- `src/workers/irregular/core/nfpBoundaryCore.ts`
- `src/workers/irregular/core/ifpBoundsCore.ts`
- `src/workers/irregular/core/transformCollisionGeometryCore.ts`
- `src/workers/irregular/core/nfpCacheKey.ts`
- `src/workers/irregular/core/geometryCacheIdentity.ts`
- `src/workers/irregular/core/geometryCacheStore.ts`
- `src/workers/irregular/geometryCacheKeys.ts`
- `src/workers/irregular/geometryCacheStoreLive.ts`
- `src/workers/irregular/collisionGeometryBuilder.ts`
- `src/workers/irregular/transformGenerator.ts`
- `src/workers/irregular/placementValidation.ts`
- `src/workers/irregular/placedCollisionSpatialIndex.ts`
- `src/workers/irregular/canonicalLayoutGeometry.ts`
- `src/workers/irregular/canonicalGridMath.ts`
- `src/workers/irregular/canonicalGridContact.ts`
- `src/workers/irregular/convexPolygonContact.ts`
- `src/workers/irregular/freeMaterialService.ts`

### Trace and replay

- `src/workers/algorithm/irregular/decisionTrace.ts`
- `src/workers/decisionTraceNdjson.ts`
- `src/renderer/utils/sharedArchiveHistory.ts`
- `src/main/services/RunHistoryArchiveService.ts`

This list is a starting map, not a license to ignore additional callers, tests, helpers, or serialization code. Trace every caller and dependency before deciding the final Rust ownership boundary.

## 6. Required migration process

Use a staged, test-driven migration. Each stage must preserve a continuously usable TypeScript backend and must be independently reviewable.

### Stage 0: Freeze and characterize current behavior

Before writing production Rust:

1. Run the complete existing test and production-gate suite.
2. Capture the current TypeScript outputs and provenance.
3. Run `pnpm profile:mixed61` and preserve its artifact directory.
4. Record current wall-clock distributions on the same machine under controlled conditions.
5. Record current cache statistics and memory behavior using the existing evidence where possible.
6. Document every TypeScript input, output, state transition, comparator, and serialized form that crosses the intended Rust boundary.
7. Create a parity matrix that maps each TypeScript subsystem to Rust tests and integration gates.
8. Identify all uses of JavaScript-specific semantics such as stable sort, insertion order, UTF-16 string comparison, `Math` rounding, signed zero, `JSON.stringify`, omitted `undefined`, and `BigInt` string encoding.

Do not build a second large profiling framework. Reuse `pnpm profile:mixed61`, `scripts/analyze-cpu-profile.ts`, existing gate scripts, and small targeted Rust benchmarks or counters only when they answer a specific migration question.

### Stage 1: Establish the native package and coarse boundary

Create a Rust crate or workspace package appropriate for `napi-rs`. Use a clear name tied to irregular nesting rather than a generic native-utils package.

The boundary must be coarse-grained. The normal production path should look conceptually like:

```text
TypeScript nesting worker
  -> validate and normalize request
  -> call one native Compact or Compact Short Side job
  -> Rust owns the complete algorithm execution
  -> return one structured result or structured failure
  -> TypeScript maps it to existing worker protocol and persistence
```

Do not cross N-API per candidate, per NFP lookup, per placement validation, per checkpoint, or per search state. Do not call JavaScript callbacks from Rayon workers.

Prefer plain owned transfer objects at the boundary. Avoid exposing Rust references whose lifetime depends on JavaScript object reachability. If a long-lived native job handle is necessary for cancellation or progress, define explicit ownership, close behavior, and idempotent cleanup. A single async native execution call with Rust-owned job state is preferable when it satisfies cancellation and progress requirements.

Contain every Rust panic before it crosses N-API. Convert failures to typed, structured errors that TypeScript can map to the existing stable error protocol. Never allow an unwinding panic to terminate Electron.

### Stage 2: Achieve complete single-thread Rust parity

Implement the complete algorithm in Rust first with an effective Rayon thread count of one.

This stage is not complete until Rust owns the entire Compact and Compact Short Side path and passes exact differential comparison against TypeScript.

Do not use multithreading to hide a semantic mismatch. One-thread Rust must reproduce the TypeScript result exactly before broad Rayon work is enabled.

Maintain two independent backends:

- `typescript`
- `rust`

Add an explicit backend selector that is usable from tests and controlled rollout. Keep rectangular nesting independent from this selector.

Support a differential mode for tests and diagnostics that runs the same validated request through both irregular backends and compares exact outputs. Differential mode is not a production default and must not run two full backends concurrently in normal application use.

### Stage 3: Design caches before parallelizing

Do not enable broad Rayon parallelism until the cache architecture is designed, instrumented, and tested.

The existing Mixed-61 evidence shows approximately:

- `266,977` pairwise NFP cache lookups
- `262,166` hits
- `4,811` stores
- approximately `98.2%` NFP cache hit rate

This reuse is a central performance property. A Rust implementation that recomputes cache hits per thread can be slower even if each geometry operation is faster. A Rust implementation that protects one global hash map with one coarse mutex can serialize the hottest path and also be slower.

Treat cache design as a primary subsystem, not an incidental map.

### Stage 4: Add deterministic Rayon parallelism

After one-thread exact parity and cache validation, add real multithreading only to verified independent work.

Every parallel operation must have:

1. a stable input index assigned before spawning work
2. no dependence on task start order or completion order
3. no mutation of algorithmic selection state from Rayon workers
4. deterministic result collection by stable index
5. a serial stable reduction using the exact TypeScript comparator and tie rules
6. cancellation and deadline checks at semantics-compatible boundaries
7. deterministic work-ledger accounting
8. tests comparing one thread with multiple thread counts
9. benchmarks proving net improvement after cache and synchronization costs

Never let the first completed task win. Never iterate an unordered concurrent map to choose candidates, survivors, checkpoints, traces, or archive entries.

### Stage 5: Package, gate, and roll out

Only promote Rust after exact correctness, deterministic concurrency, packaging, and performance gates all pass.

Keep TypeScript available for fallback and rollback after promotion.

## 7. N-API contract

Design and document a versioned native API. Keep it small.

A reasonable shape is:

- native capability and version query
- one Compact execution entry point
- one Compact Short Side execution entry point, or one profile-discriminated irregular entry point
- optional explicit cancellation handle if an async-thread-safe mechanism is required
- optional native telemetry returned with the completed result

Requirements:

- Validate untrusted application data in TypeScript using the existing schemas before constructing trusted native input.
- Revalidate safety-critical invariants in Rust at the trust boundary. Never assume malformed input cannot reach native code.
- Return existing semantic error categories, not arbitrary Rust strings.
- Preserve omitted versus present optional fields where serialization or hashing observes the distinction.
- Avoid `serde_json::Value` as the internal algorithm model. Convert boundary data immediately into strongly typed Rust domain structures.
- Avoid repeated cloning of complete geometry across the N-API boundary.
- Share immutable prepared geometry inside Rust using `Arc` where it materially reduces copying.
- Do not retain N-API environment handles in Rayon tasks.
- Do not invoke JavaScript from Rayon worker threads.
- Do not expose Rayon thread lifetimes to Electron shutdown.
- Ensure an abandoned or cancelled JavaScript promise cannot leak a native job or cache.
- Catch panics at the outer native job boundary. Sanitize panic details and map the failure to the existing external `unknown_error` code with stable operation and backend context. The external protocol has no `internal_error` code.
- Include native backend version, Rust crate version, target triple, thread count, and cache policy identity only in an explicitly non-semantic diagnostic channel. Keep this channel outside result objects, persisted sub-run settings, canonical data, hashes, histories, checkpoints, progress events, and parity projections.

## 8. Exact numeric semantics

The port must reproduce current numeric semantics deliberately rather than relying on coincidental similarity between JavaScript and Rust.

### 8.1 Floating-point behavior

JavaScript `Number` uses binary64. Rust `f64` is also binary64, but language operations, casts, ordering APIs, and library behavior can differ.

Audit and reproduce:

- signed zero normalization
- rejection of NaN and infinities
- safe-integer checks
- rounding behavior
- truncation behavior
- multiplication and addition order where it affects binary64 results
- conversion from floating millimeters to the canonical grid
- string rendering used by keys or JSON
- `Math` function semantics used by transform preparation

Do not enable compiler options or transformations that reassociate floating-point expressions or otherwise change accepted results.

### 8.2 Exact integer authority

Where TypeScript uses `BigInt` or an exact fallback, use exact Rust arithmetic with proved overflow safety. Choose representations based on verified coordinate and product bounds. Use checked arithmetic and a wider integer or arbitrary-precision fallback when required.

Preserve exact signs for:

- cross-products
- doubled areas
- ratio comparisons
- canonical-grid contact terms
- span comparison
- topology and cavity terms
- capacity material accounting
- Short Side projected overlap

Do not let release-mode integer overflow wrap silently.

### 8.3 Canonical geometry authority

Preserve the existing division of responsibility:

- Clipper2 owns canonical integer Boolean geometry
- robust predicates own unsnapped source-geometry decisions
- canonical comparisons are exact
- floating millimeters are projections for rendering or telemetry when an exact grid representation exists

Before selecting a Rust Clipper binding or porting Clipper2 behavior, verify that it reproduces the existing `clipper2-ts` operations, fill rules, orientation, path cleanup, offset parameters, and output canonicalization exactly. If no Rust binding provides exact parity, use a faithful Rust-side implementation or another native arrangement that preserves the current output. Do not substitute a geometrically reasonable but behaviorally different library.

## 9. Canonical keys, ordering, and serialization

Canonical keys are contractual production data. They affect survivor ordering, capacity comparisons, checkpoint integrity, artifacts, and seeds.

Preserve byte-identical legacy key content wherever a key is externally visible or can affect selection.

Requirements:

- preserve ring-origin normalization
- preserve winding normalization
- preserve signed-zero handling
- preserve translation behavior
- preserve quarter-turn equivalence rules
- preserve piece and copy order
- preserve separator bytes and numeric rendering
- preserve stable tie ordering
- preserve current string comparison semantics

JavaScript sorting is stable. JavaScript `Map` and `Set` preserve insertion order. Rust `HashMap` and `HashSet` do not provide a deterministic iteration order and normally use randomized hashing.

Therefore:

- never use raw `HashMap` or `HashSet` iteration as an ordering source
- store contractual order explicitly in vectors or stable-index structures
- use maps only for lookup unless their contents are explicitly re-sorted with the exact legacy comparator
- verify whether each TypeScript comparison is code-unit, lexical, locale-based, numeric, or custom
- do not assume Rust byte ordering matches JavaScript UTF-16 or `localeCompare`
- preserve stable sorting by attaching original indices when necessary

Canonical checkpoint JSON must match the current custom encoding:

- object keys sorted according to the current implementation
- arrays retain their exact order
- `undefined` fields omitted
- `BigInt` values encoded as quoted base-10 strings
- optional omission preserved
- no incidental whitespace differences in bytes that feed SHA-256

Ordinary Serde output is insufficient unless differential byte tests prove it matches exactly.

## 10. Complete Compact semantics

Preserve the current archive-only Compact production authority.

Key requirements:

1. Complete construction and complete ranking are sheetless.
2. Requested-sheet dimensions affect exact preflight, capacity legality, and terminal q0/q90 fitting only.
3. The protected complete portfolio and capacity portfolio have separate namespaces, comparators, budgets, and checkpoint identities.
4. Complete endpoints admitted to the shared archive must be complete, exact, legal, and uncensored.
5. Canonical deduplication and archive ranking must match TypeScript exactly.
6. A fitting complete endpoint dominates every capacity endpoint.
7. Exact preflight may prove impossibility only through its current exact area or singleton q0/q90 rules.
8. Inconclusive preflight is not an infeasibility proof.
9. Focused reconstruction may replace the protected leader only under the current admission and comparison rules.
10. Invalid, incomplete, duplicate, capped, censored, or losing reconstruction cannot alter the protected endpoint.
11. Observer and shadow-only modules remain non-authoritative unless current TypeScript production semantics explicitly admit their result.

Preserve the direct roles and periodic behavior implemented by the current portfolio, including:

- `canonical-grid`
- `legacy-absolute-envelope`
- `open-pocket-first`
- periodic family discovery
- P1/P2 cell enumeration
- crop and Pareto selection
- source-survival audit
- replay-envelope validation
- bounded continuation behavior

Do not parallelize these roles as independent races whose completion order affects archive state, cache state, scheduler chronology, deadlines, or traces. You may parallelize pure subcomputations inside a logically serial cohort if the resulting ordered values and accounting are identical.

## 11. Capacity semantics and checkpoints

Preserve exact capacity behavior, including current production bounds and accounting.

At the time of this prompt, important production values include:

- beam width `16`
- legal-placement fanout `3`
- per-depth quota `4,096`
- total cap `max(50,000, pieceCount * 4,096)`
- permanent-skip successor retained at every depth

Verify these values from current source before implementation. Source wins if it changed.

Capacity state must preserve every accounting-distinct future. Deduplication may not collapse states that have equal occupied geometry but different pending, deferred, skipped, fit, quota, ledger, continuation, or settlement semantics.

Preserve:

- cold capacity lane
- warm-prefix lane
- protected quality-warm-prefix lane
- separate producer roles
- separate checkpoints
- separate frontier and entitlement
- separate scheduler ledgers and traces
- current admission rule for quality-warm-prefix results
- exact placed-count improvement requirement
- no silent cross-role resume
- no cold restart when a valid resumable checkpoint exists

Checkpoint compatibility is mandatory. Preserve:

- version strings
- request fingerprints
- integrity hashes
- prepared order
- ordered frontier
- cursor and depth
- placed, pending, deferred, and skipped identities
- occupied identity
- topology and cavity state
- fit masks
- material accounting
- work ledgers
- scheduler deficit
- no-skip frontier
- counters
- retention trace
- private continuation state
- producer role
- archive cohort
- incumbent and pruning context
- settlement and censoring state

A resumed Rust checkpoint must reproduce the same endpoint, trace, evaluation counts, and result as uninterrupted Rust and TypeScript execution.

Checkpoint integrity includes measured runtime fields such as `activeRuntimeMs` and optional phase timings. A faster Rust backend cannot reproduce TypeScript's production timing bytes. Handle this distinction explicitly:

- Add or reuse an injected deterministic clock in both backends for byte-level differential tests. The TypeScript direct-constructor seam already accepts `timingNow`; trace every other checkpoint producer and add an equivalent test-only clock seam where needed.
- Under the same deterministic clock sequence and the same timing-capture configuration, require byte-identical checkpoint encoding, fingerprints, integrity hashes, validation decisions, resume traces, and endpoints across TypeScript and Rust.
- With real production clocks, require the same canonical encoding rules, field presence rules, integrity validation, status transitions, and resume semantics, but compare timing fields as non-semantic measurements rather than demanding equal values.
- Never remove timing fields from production checkpoints merely to make differential bytes match.

If cross-language checkpoint persistence is currently externally supported, preserve compatibility for checkpoints produced by either backend, including correct validation of each checkpoint's actual measured timing values. If checkpoints are internal-only, still preserve the canonical encoding and validation semantics because they affect control flow.

## 12. Compact Short Side semantics

Compact Short Side is a directional construction, not a different scoring view over Compact geometry.

Preserve these non-negotiable rules:

1. Compact first selects the exact placed and unplaced piece-ID partition.
2. Short Side receives that settled partition and comparison context.
3. Short Side independently constructs new directional geometry for exactly the Compact-selected placed IDs.
4. Short Side reports exactly the same unplaced IDs.
5. Compact placements are not a legal Short Side fallback.
6. Do not rotate, relabel, or return Compact geometry as if it were a Short Side construction.
7. If no valid directional construction exists, return `irregular_no_valid_result` according to the current error contract.
8. Do not return partial geometry after deadline, cancellation, memory cap, trace cap, or evaluation cap.

Preserve portfolio order and bounded behavior:

1. exact pair-fold and multi-row shelf
2. protected prepared-order depth-first contact strip
3. capped contact-first strip with resumable depth-first decisions
4. bounded reverse-depth and canonical-ID continuations for eligible small partitions after prepared-order failure

Preserve physical-axis rules:

- use the current short-axis and long-axis definitions
- on square sheets, physical Y is the short axis and physical X is the long axis
- use exact canonical-grid spans and cross-products, not floating tolerances

Preserve the exact Short Side contact tuple:

- diagonal and axis-aligned contacts both contribute to positive-contact count
- only axis-aligned overlap contributes to projected-length tie-breaking
- projected-length suffix is not Euclidean boundary length

There is stale prose in `irregularWorkerOutput.ts` that may mention an explicit Compact fallback. The current implementation, tests, and knowledge contract require no Compact fallback. Preserve the implemented no-fallback behavior and correct stale descriptive text only if doing so does not alter any stable serialized output or existing test expectation.

## 13. Cache architecture for true multithreading

This section is critical.

Design caches for high reuse, safe concurrency, deterministic behavior, and bounded memory before enabling broad Rayon execution.

### 13.1 Required principles

- One nesting job owns a coherent cache domain.
- Cache contents never decide algorithmic order.
- Cache insertion race order never changes output, trace, checkpoint, ledger, or diagnostics that are parity-gated.
- A cache hit and a recomputation must return the same canonical immutable value.
- Invalid or stale values are never published as valid hits.
- Cache telemetry is observational and cannot affect control flow.
- Cache lifetime, memory budget, and cleanup are explicit.
- Shared immutable geometry uses ownership that is safe for concurrent reads.
- Duplicate computation is measured and bounded rather than ignored.
- Lock contention is measured rather than guessed.

### 13.2 Preserve historical access semantics

Do not normalize all cache paths into one generic sequence.

Preserve each current sequence, including:

- NFP validation, key creation, lookup, cached-value validation, stale eviction, recomputation, validation, and publication
- IFP validation before cache access
- transformed-geometry key construction and lookup before recomputation
- exact ordered-coordinate fingerprint requirements for trusted-ring reuse
- relative NFP sharing across canonically equivalent copies, followed by fixed-piece translation after retrieval
- invalid results never cached

If parallel execution changes when a lookup occurs relative to a semantic cancellation or deadline checkpoint, the parallel design is not yet valid.

### 13.3 Required design evaluation

Evaluate at least these architectures with targeted measurements:

1. sharded concurrent shared cache
2. shared read-mostly cache plus per-thread front caches
3. per-key single-flight computation with deterministic immutable publication
4. phase-local precomputation followed by immutable shared lookup tables
5. hybrid policies by cache namespace

Do not choose one global coarse mutex without evidence. Do not choose fully thread-local expensive geometry caches without measuring lost reuse and duplicate work.

The likely design should use different policies for different cache namespaces. For example, immutable high-reuse NFP data may benefit from a shared sharded backing store with small thread-local front caches, while cheap transform-derived values may use a different policy. This is a hypothesis to test, not a mandated implementation.

### 13.4 Cache keys and values

Cache keys must preserve legacy identity semantics exactly. An optimized internal hash or interned representation is allowed only when:

- it cannot escape into canonical output
- equality is proved equivalent to the legacy byte key
- collisions are resolved by exact key equality
- legacy key materialization remains byte-identical when required
- the optimization cannot alter iteration or publication order

Cache values should be immutable after publication. Prefer `Arc`-owned canonical values for shared reuse. Do not expose mutable aliases.

### 13.5 Single-flight and duplicate computation

A cache miss under contention may cause multiple threads to compute the same expensive value. Define the policy explicitly.

If using single-flight:

- avoid holding a shard lock while doing expensive geometry
- handle panics and cancellation without permanently poisoning a key
- prevent wait cycles
- ensure waiters receive the same validated immutable result
- ensure failed computations are not published as valid values
- make cleanup deterministic and leak-free

If allowing duplicate computation:

- measure duplicate count and wasted CPU
- prove duplicate results are exact
- publish using exact-key equality
- ensure the winner of publication has no semantic effect
- bound memory spikes

### 13.6 Eviction and memory

Define whether each cache is job-local, process-local, bounded, or persistent across jobs.

Default to job-local ownership unless cross-job reuse is already semantically and operationally safe. Cross-job global caches introduce versioning, memory, isolation, and stale-data concerns and require separate justification.

If eviction is needed:

- eviction order must not affect results
- a missing value may cost time but may not alter behavior
- avoid nondeterministic telemetry assertions based on race-sensitive eviction order
- enforce a documented memory cap
- record peak bytes and entry counts
- clean up all cache state at job completion or cancellation

### 13.7 Required cache telemetry

Add low-overhead integer telemetry, disabled or sampling-free by default if necessary, for:

- lookups
- hits
- misses
- stores
- stale detections
- stale removals
- duplicate computations
- single-flight waits
- shard-lock wait time or contention count
- front-cache hits
- backing-cache hits
- evictions
- entries by namespace
- approximate and peak bytes by namespace
- computation time by namespace

Telemetry ordering must not enter canonical traces or selection. Backend and cache telemetry must use an explicitly non-semantic, opt-in diagnostic sink or sidecar artifact. It must not be added to the nesting result, persisted `NestingOptions`, sub-run settings, canonical serialization, checkpoints, history frames, decision traces, protocol progress events, or any hash input. Schedule-dependent telemetry values are compared only as measurements, never as parity fields. Compare one-thread and multi-thread runs to verify that speedup is not consumed by lock contention, duplicate work, or destroyed reuse.

## 14. Safe and unsafe parallelization boundaries

Do not parallelize by intuition. Prove each boundary against state, cache, cancellation, chronology, and ordering.

### 14.1 Good candidates to investigate

Potentially safe work includes pure batches whose inputs are fully known and whose results can be indexed and reduced serially, such as:

- independent collision-geometry preparation by stable piece index
- independent transform materialization by stable piece and transform index
- independent pairwise relative NFP computations after key deduplication
- independent IFP calculations for fixed known inputs
- independent candidate legality or score evaluation within one already ordered candidate batch
- independent canonical-key component computation with serial byte assembly
- independent final metric components with exact serial reduction
- independent periodic-cell candidate evaluation with stable catalog indices
- read-only spatial-index queries for an immutable state

Every item above remains conditional. If the current TypeScript code observes checkpoints, consumes budgets, mutates caches, updates ledgers, or short-circuits within the loop, preserve that behavior before parallelizing it.

### 14.2 High-risk boundaries

Do not parallelize these as uncontrolled cohorts:

- complete versus capacity producer races
- cold versus warm lane races
- direct producer roles whose chronology affects scheduler traces
- archive admission as tasks finish
- survivor selection as candidates finish
- checkpoint publication by completion order
- depth transitions before all required ordered results exist
- Short Side portfolio branches where first success currently has defined authority
- cancellation or deadline checks at new eager positions
- mutable spatial-index updates
- global trace append operations from Rayon workers

Logical orchestration can remain serial while expensive pure work inside each step uses Rayon.

### 14.3 Deterministic parallel pattern

Use a pattern equivalent to:

```text
1. Construct the exact ordered input vector serially.
2. Assign every input a stable ordinal.
3. Evaluate selected pure work in parallel.
4. Store each result by ordinal.
5. Reconstruct the exact ordered result vector.
6. Apply validation, work accounting, stable comparison, tie-breaking, archive admission, checkpointing, and trace emission in the same logical order as TypeScript.
```

Use Rayon indexed parallel iterators only when their collection semantics are verified and explicit. Otherwise write into stable slots or sort by the original ordinal before reduction.

### 14.4 Thread configuration

Provide controlled thread-count configuration for tests and deployment.

Requirements:

- exact parity at thread counts `1`, `2`, and representative higher counts
- deterministic output across repeated runs
- avoid oversubscription with Electron and its existing worker
- document the default thread-count policy
- allow a safe environment or backend option override for diagnostics
- do not let thread count affect algorithmic budgets or selected output
- include thread count in non-authoritative diagnostic metadata

Consider a job-owned Rayon pool or another mechanism that prevents unrelated native work from unexpectedly sharing one unconstrained global pool. Prove clean shutdown and no pool leak across repeated jobs.

## 15. Cancellation, deadlines, and progress

Preserve distinctions among:

- explicit cancellation
- wall-clock deadline
- deterministic evaluation cap
- memory cap
- trace cap
- censored or paused work
- invalid geometry
- no valid result

Do not convert cancellation into a cache miss, failed candidate, cold restart, partial result, or generic native error.

Current TypeScript control checks are often lazy and placed at specific cooperative boundaries. Moving a check earlier can change which work, cache operation, ledger entry, checkpoint, or trace occurs before termination. Moving it later can violate responsiveness or budgets.

Map and preserve the current observation points. Within long native operations, add safe polling only if it preserves accepted outcomes and chronology. If exact wall-clock timing makes an identical interruption point impossible, preserve the externally specified cancellation/deadline semantics and existing no-partial-result rule, then add focused tests that prove no accepted layout or deterministic accounting changes under controlled cancellation scenarios.

Progress reporting must not require JavaScript callbacks from Rayon threads. Aggregate native progress at the same logical serial boundaries as TypeScript and publish it through a thread-safe N-API mechanism from an allowed thread.

Protocol-visible progress is part of semantic parity. Preserve the exact logical event count, phase sequence, ordering, completed and total work values, best-score payloads, and optional-field presence. Differential tests may exclude only timestamp and elapsed-duration fields that are explicitly documented as non-semantic. Do not drop, merge, coalesce, or reorder logical progress events under a generic throttling policy. Transport-level batching is allowed only if the receiver observes the same ordered event stream.

## 16. Error handling and safety

Create typed Rust error enums for precise internal provenance. Map them many-to-one into the existing `AppErrorCode` protocol. Do not add a new external code merely because Rust has a more specific internal variant.

Implement and test this external mapping table against the current source before integration:

| Concrete current TypeScript error tag or native boundary failure | Existing external `AppErrorCode` | Required context |
| --- | --- | --- |
| `IrregularComputeError` | `irregular_source_geometry_missing` | `preparedPieceId` and `sourcePieceId` |
| `IrregularGeometryInputError` | `irregular_geometry_invalid` | `operation` |
| `IrregularNestingNotImplementedError` | `not_implemented` | `service` and `operation` |
| `IrregularPlacementScoringError` | `irregular_scoring_error` | `operation` |
| `IrregularLayoutScoringError` | `irregular_scoring_error` | `operation` |
| `IrregularPortfolioError` with category `geometry` | `irregular_geometry_invalid` | `operation` and category `geometry` |
| `IrregularPortfolioError` with category `scoring` | `irregular_scoring_error` | `operation` and category `scoring` |
| `IrregularPortfolioError` with category `search` | `irregular_scoring_error` | `operation` and category `search`; preserve this unusual current mapping exactly |
| `IrregularNoValidResultError` | `irregular_no_valid_result` | `operation` |
| `IrregularNfpIfpControlAbortError` with reason `cancelled` | `worker_cancelled` | reason `cancelled` |
| `IrregularNfpIfpControlAbortError` with reason `deadline` | `worker_timeout` | reason `deadline` |
| malformed native response or N-API protocol-version mismatch detected by the worker boundary | `worker_protocol_error` | native API version and stable operation, without secrets |
| contained panic, internal invariant failure, or otherwise unclassified native defect handled by the existing unknown-failure boundary | `unknown_error` | sanitized operation and backend identity; do not expose raw panic payloads or a native backtrace by default |

Validation rejected by the existing TypeScript request schema remains `validation_error` at the existing boundary and should not enter the native algorithm. Deterministic evaluation caps, memory caps, trace caps, pauses, and censoring that are currently internal result or trace statuses must remain statuses. Do not incorrectly promote them into external error codes.

Verify the table against `src/shared/protocol/errors.ts`, `src/workers/nesting.worker.ts`, and `src/shared/protocol/worker.ts` at implementation time because current source remains authoritative.

Preserve source provenance and distinctions that current tests observe. Multiple internal variants may map to one external code, but the stable operation and category context must remain sufficient for existing diagnostics. Do not flatten all errors into `Error("native failure")`.

Use checked arithmetic and explicit invariants. Avoid `unsafe` unless a measured requirement cannot be met otherwise. Every `unsafe` block must have a local safety argument and focused tests. Prefer no `unsafe` algorithm code.

## 17. Backend selection, fallback, and rollback

Keep TypeScript and Rust as explicit irregular backends.

Requirements:

- backend selection is independent of rectangle versus irregular algorithm selection
- rectangular nesting always remains on its TypeScript implementation
- tests can force either irregular backend
- development can run differential mode
- production rollout can select Rust by feature flag, setting, or controlled default
- a missing or unloadable native binary produces a clear capability result
- fallback behavior is explicit and observable
- no silent fallback after Rust has begun a job unless current semantics and duplicate side effects are fully controlled
- cancellation and deadline must not trigger a TypeScript retry
- native semantic errors must not trigger an automatic TypeScript retry
- an unavailable addon may fall back before execution if policy permits
- TypeScript remains usable for rollback after Rust promotion

Do not overload `workerMode` in a way that confuses algorithm shape with implementation backend. Do not add the backend selector to persisted `NestingOptions` or sub-run settings, because that would change result parity and saved-job semantics. Keep backend selection as an internal, out-of-band worker execution option, process configuration, test harness option, or non-persisted feature flag. It must be resolved before algorithm execution and must not enter canonical data, result objects, histories, checkpoints, hashes, or scoring.

Backend identity, native version, thread count, cache policy, and cache telemetry belong only to the separate non-semantic diagnostic channel. Differential parity projections must exclude that entire diagnostic channel by construction rather than removing individual differing fields after a mismatch.

When running strict parity or performance gates, print which backend actually executed through the diagnostic or harness output. A test must fail if it requested Rust but silently ran TypeScript.

## 18. Testing strategy

Follow test-driven development for every new behavior and integration seam. Add tests before production code and observe them fail for the intended reason.

### 18.1 Existing suite

Run the complete unchanged existing test suite against TypeScript before migration and after every meaningful stage.

Then run all applicable existing tests against Rust through backend parameterization or a parallel Rust-specific harness without altering existing expected values.

### 18.2 Rust unit tests

Add focused Rust tests for:

- boundary conversion
- numeric limits
- exact comparisons
- signed zero
- NaN and infinity rejection
- canonical-grid rounding
- exact area and cross-products
- stable sorting
- legacy string ordering
- canonical key bytes
- canonical JSON bytes
- checkpoint hashes
- NFP and IFP validation order
- stale cache removal
- invalid-value non-publication
- transform cache order
- candidate legality
- candidate score tuples
- archive comparator
- capacity comparator
- permanent-skip behavior
- accounting-distinct state keys
- checkpoint corruption rejection
- Short Side axes
- square-sheet axis convention
- pair-fold
- multi-row shelf
- contact-strip tuple
- diagonal contact count
- axis-only projected overlap
- no Compact fallback
- panic containment
- cancellation cleanup
- cache cleanup

### 18.3 Differential tests

For every maintained fixture and important unit carrier, compare TypeScript and one-thread Rust for:

- complete result object
- placed and unplaced IDs
- transforms and coordinates
- canonical collision identity
- fitted canonical identity
- canonical keys
- score summaries
- archive entries and order
- capacity endpoints
- scheduler trace
- lane trace
- ledgers
- evaluation counts
- checkpoint bytes and hashes under an identical injected deterministic clock
- production checkpoint encoding, integrity validation, and resume semantics under real clocks without requiring equal measured timing values
- resumed endpoint
- error category and stable context
- cancellation category
- protocol-visible progress event count, phase sequence, order, completed and total work, best-score payloads, and optional-field presence
- selected-layout reveal sequence
- decision-trace event order

When complete object equality is blocked by non-authoritative elapsed time, timestamp fields, backend diagnostics, or schedule-dependent cache telemetry, compare a documented projection that excludes only fields designated non-semantic before the test runs. Keep backend diagnostics entirely outside semantic result objects. Do not exclude a field merely because it differs.

### 18.4 Concurrency determinism tests

For representative small, medium, and Mixed-61 cases:

- run Rust with one thread
- run Rust with two threads
- run Rust with the default thread count
- run Rust with another higher count where available
- repeat each configuration enough times to expose ordering races
- vary Rayon scheduling where practical
- compare all semantic outputs exactly
- compare deterministic ledgers exactly
- verify canonical hashes exactly
- verify checkpoint and resume behavior exactly
- verify no deadlocks under cache contention
- verify cancellation cleans up waiters and single-flight entries
- verify panic injection does not poison future jobs

Use race-focused stress tests for shared caches. If Loom or a similar model-checking approach is suitable for isolated cache primitives, use it for those primitives without forcing it into the whole geometry system.

### 18.5 Property and fuzz tests

Add bounded property tests or fuzz targets for:

- canonical key equivalence
- ring-origin and winding invariance
- TypeScript versus Rust canonical-grid comparisons
- NFP cached versus uncached equality
- cache single-flight equivalence
- stable indexed parallel reduction
- checkpoint encode/decode and corruption rejection
- candidate legality near touching boundaries
- integer overflow boundaries
- arbitrary thread counts producing the same result

Persist only minimal, reviewed regression cases discovered by fuzzing.

### 18.6 Required production gates

At minimum, preserve and run:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm gate:mixed61-compact`
- `pnpm gate:compact-nine-baselines`
- `pnpm gate:capacity`
- `pnpm gate:capacity:production`
- maintained sheet-invariance gates
- cancellation, history, timeout, and focused irregular unit suites documented in `docs/operations/irregular-production-gates.md`

Run strict gates serially when their accepted chronology or performance methodology requires serial execution.

The 18-layout Compact and Short Side matrix must preserve every accepted identity and partition. Mixed-61 `2000 x 2700` must retain:

- collision identity `3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742`
- fitted canonical identity `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`
- placed count `61`
- unplaced count `0`
- maximum accepted area `391605.850174 mm2`
- canonical cavities `0`
- focused status `evaluation-cap`
- focused evaluations `12000`
- focused source and selected identity equal to the collision identity
- focused influence `protected-fallback`

Verify all current values from source before relying on this summary.

## 19. Performance requirements

This port is accepted only if it preserves exact semantics and improves execution time.

Correctness is a hard gate. Performance is a promotion gate. A faster wrong result is rejected. An exact but slower Rust backend remains experimental and is not promoted.

### 19.1 Baseline method

Use `pnpm profile:mixed61` as the standard production-shaped profile before and after the migration. It already captures:

- strict Mixed-61 execution
- raw V8 CPU profile for the TypeScript path
- analyzer output
- strict result artifacts
- Git commit
- Git status
- binary source diff

For Rust, extend the evidence minimally so native phase timing and cache telemetry can be correlated with the same run. Do not replace this with a large profiling subsystem.

Benchmark on the same machine under controlled conditions. Record:

- CPU model
- core count
- operating system
- architecture
- Node and Electron versions
- Rust version
- native target triple
- backend version
- thread count
- cache policy
- source commit and dirty diff
- warm-up policy
- individual run times
- median and dispersion
- peak RSS
- cache statistics

### 19.2 Comparison matrix

Measure at least:

1. TypeScript current backend
2. Rust with one thread
3. Rust with two threads
4. Rust with default threads
5. Rust with a representative higher fixed count if different

This isolates speedup from language/runtime changes versus parallelism.

Benchmark Compact and Compact Short Side across small, medium, and Mixed-61 cases. Do not optimize only one fixture at the expense of established gates.

### 19.3 Promotion criteria

Stage 0 must propose an objective preregistered performance contract and obtain explicit user approval before production Rust implementation begins. Do not choose or revise the promotion bar after seeing Rust results.

The proposal must state concrete values for:

- the exact Compact and Compact Short Side benchmark cases
- the Mixed-61 `2000 x 2700` primary gate
- warm-up count
- alternating-run order
- measured sample count per backend and thread count
- primary statistic, normally median wall-clock time
- dispersion statistic
- allowed per-case regression tolerance
- required Mixed-61 speedup
- required aggregate or per-suite speedup
- required multi-thread improvement over one-thread Rust
- peak-RSS ceiling or allowed increase
- treatment of outliers and invalid samples
- machine-load controls and whether confidence intervals are required

Until the user approves those numeric thresholds, complete only Stage 0 characterization, architecture, test seams, and performance-contract design. Do not begin production implementation or claim a promotion criterion.

The approved contract must enforce at least these principles:

- Rust must not regress any maintained case beyond the approved numeric tolerance.
- Rust one-thread performance must meet the approved native-port threshold.
- Multi-thread Rust must meet the approved improvement over one-thread Rust on representative heavy cases after cache contention and overhead.
- Mixed-61 must meet its approved reproducible wall-clock speedup on the same machine.
- Peak memory must remain within the approved bound.
- No thread-count setting may change exact output.

Use repeated alternating runs and report all samples, not only the best run. Do not compare a warm Rust run with an unfair cold TypeScript run. Do not hide outliers outside the preregistered rule.

If a Rayon parallelization makes a workload slower, remove or narrow it. Parallelism is not itself a success criterion. Lower end-to-end time is.

## 20. Packaging and Electron integration

The repository currently uses:

- Node `>=24.11.0`
- pnpm `>=11.0.0`
- Electron declared as `^33.2.1`, currently locked in the existing lockfile
- electron-vite
- a separately built ESM nesting worker at `out/workers/nesting.worker.mjs`
- targeted `electron-rebuild` for `better-sqlite3`

Inspect current versions rather than assuming this summary remains current.

### 20.1 Native targets

Determine the actual supported release platforms from project requirements and configure `napi-rs` prebuilds accordingly. Unless project evidence narrows the set, prepare at least:

- macOS arm64
- macOS x64
- Windows x64
- Linux x64

Do not claim a platform is supported until its binary is built, loaded by the packaged Electron application, and smoke-tested.

### 20.2 Build integration

Requirements:

- add the Rust package to the pnpm workspace as appropriate
- account for `pnpm` build-script allowlists
- keep the `.node` addon external to the worker bundle
- prevent Vite or Rollup from trying to bundle native binary contents
- resolve native binaries reliably in development, tests, unpackaged production, and packaged Electron
- include native artifacts in electron-builder configuration
- unpack `.node` binaries from ASAR where required
- avoid unnecessarily adding the Node-API addon to Electron ABI rebuild steps
- preserve the targeted `better-sqlite3` rebuild behavior
- reconcile the current worker output path and supervisor resolution before relying on packaging
- produce actionable errors for missing or incompatible binaries

The current repository has electron-builder installed but lacks a complete packaging configuration. Add the minimum production-grade configuration required for native artifacts, without turning the migration into unrelated release engineering.

### 20.3 CI matrix

Add CI jobs that build and test native artifacts on supported operating systems and architectures where hosted runners permit it.

CI must cover:

- Rust format
- Rust lint with warnings treated appropriately
- Rust unit tests
- native build
- Node/Electron addon load smoke test
- TypeScript typecheck and lint
- existing full tests
- exact irregular differential tests
- one-thread and multi-thread determinism tests
- production gates
- package artifact inspection
- packaged application smoke test where feasible

The current workflow installs with `--ignore-scripts`. Adjust native build jobs deliberately rather than globally weakening install safety.

Keep expensive 18-layout and capacity gates controlled and reproducible. Do not run multiple performance measurements concurrently on the same host.

### 20.4 Versioning and compatibility

Define:

- native API version
- Rust backend semantic version
- geometry backend identity and version
- supported N-API version
- compatibility check at load time
- clear behavior for version mismatch

Node-API reduces ABI coupling but does not eliminate packaging, target, libc, or application compatibility concerns.

## 21. Code quality requirements

Match repository naming and comment style. Use English for all code, comments, documentation, commit messages, and diagnostics.

Keep the Rust architecture understandable. Prefer domain modules that mirror semantic responsibilities rather than one enormous file or one-to-one mechanical copies with no coherent ownership.

Suggested module boundaries include:

- boundary DTOs and conversion
- domain geometry
- canonical grid and exact arithmetic
- transforms and preparation
- NFP and IFP
- validation and spatial index
- cache primitives and namespaces
- candidate generation and scoring
- complete construction
- periodic construction
- reconstruction
- archive
- capacity
- checkpoints
- Short Side
- scheduler
- result conversion
- telemetry
- N-API entry points

This is not a requirement to reproduce TypeScript file boundaries exactly. It is a requirement to preserve semantics while keeping code reviewable.

Avoid premature abstractions that make differential tracing harder. During migration, maintain explicit links from Rust modules and tests to the TypeScript behavior they port.

Every optimization must include:

- the identified cost
- the semantic invariant
- a focused test
- before-and-after measurement
- rollback simplicity

## 22. Required implementation artifacts

Produce and maintain:

1. an architecture document for the Rust backend
2. a TypeScript-to-Rust semantic mapping table
3. a native boundary schema document
4. a cache and concurrency design document
5. a deterministic parallelism inventory listing every Rayon site
6. a checkpoint compatibility document
7. a backend selection and rollback document
8. native build and packaging documentation
9. CI target matrix
10. parity reports for maintained fixtures
11. one-thread versus multi-thread determinism report
12. before-and-after performance report with provenance
13. memory and cache telemetry report
14. a list of unchanged existing test and fixture hashes
15. a final acceptance checklist

Keep generated benchmark artifacts out of normal source directories unless the repository's existing artifact policy requires committed evidence.

## 23. Mandatory review discipline

Before reporting any migration stage complete:

- read the actual current code and callers
- inspect relevant Git history when behavior is non-obvious
- run the focused tests
- run the full required validation for that stage
- inspect the exact diff
- run diagnostics, lint, typecheck, and Rust checks
- verify that no existing test expectation changed
- verify that TypeScript remains usable
- verify that a requested Rust run did not silently fall back
- verify exact output, not visual similarity
- verify performance with fresh evidence before claiming speedup

Do not say a result is deterministic after one run. Do not say semantics are preserved because tests compile. Do not say performance improved based on a microbenchmark alone.

Use an independent reviewer after major stages. Address verified findings before continuing.

## 24. Stop conditions

Stop and investigate rather than pushing forward if any of these occurs:

- any existing hash changes
- any placed or unplaced partition changes
- any comparator winner changes
- any scheduler or lane chronology changes
- any checkpoint resume differs from uninterrupted execution
- any thread count changes output
- any cache race changes a trace or ledger
- any existing test needs weakening
- cancellation returns partial geometry
- Short Side reuses Compact geometry
- native failure crashes Electron
- Rust silently falls back during a Rust gate
- multi-thread execution is slower because of contention or duplicate computation
- packaged Electron cannot load the native binary
- memory grows without a documented bound

When a mismatch appears, write the smallest differential reproduction and fix the Rust implementation. Do not update accepted artifacts.

## 25. Definition of done

The work is complete only when all of the following are true:

### Scope

- Compact runs fully in Rust through a coarse N-API call.
- Compact Short Side runs fully in Rust through a coarse N-API call.
- The final architecture is not a collection of per-kernel N-API calls.
- Rectangular nesting remains TypeScript.
- The complete existing TypeScript irregular backend remains maintained and selectable.

### Semantics

- Existing tests, fixtures, expected values, and quality thresholds remain unchanged.
- All existing tests pass.
- All existing production gates pass.
- Rust one-thread output matches TypeScript exactly for every maintained case.
- Canonical key and canonical JSON bytes match where contractual.
- All accepted hashes match.
- Placed and unplaced partitions match exactly.
- Ranking, archive authority, scheduler chronology, ledgers, and checkpoints match.
- Cancellation, deadlines, errors, history, and traces match.
- Compact Short Side builds genuine directional geometry for Compact's exact selected partition and never falls back to Compact placements.

### Concurrency and caches

- Rayon performs real native multithreaded work on verified safe boundaries.
- One-thread and multi-thread outputs are identical across repeated runs.
- Cache reuse remains high.
- Shared-cache contention and duplicate computation are measured and controlled.
- Cache insertion order cannot affect behavior.
- Cache memory is bounded and cleaned up.
- No deadlocks, poisoned permanent entries, or leaked native jobs exist.

### Performance

- Rust is reproducibly faster end to end on the preregistered representative suite.
- Mixed-61 shows a clear material improvement using the existing profile harness.
- Multi-thread Rust improves heavy cases over one-thread Rust after overhead.
- No maintained case has an unexplained regression.
- Memory remains acceptable.
- Evidence includes provenance and all samples.

### Integration

- Development and tests load the correct native addon.
- Packaged Electron loads the correct platform binary.
- Supported platform and architecture artifacts are built and smoke-tested.
- CI exercises Rust, addon loading, deterministic parity, production gates, and packaging.
- Missing or incompatible native binaries fail clearly or follow the explicit pre-execution fallback policy.
- Rollback to TypeScript remains immediate and documented.

## 26. First actions

Begin with these steps in order:

1. Read `knowledge/INDEX.md` and the relevant knowledge pages.
2. Inspect the current branch, status, and recent history.
3. Map the complete current TypeScript Compact and Compact Short Side call graph.
4. Inventory all existing tests and production gates that constrain semantics.
5. Run the unchanged baseline suite and `pnpm profile:mixed61`.
6. Write the semantic mapping and migration plan before production implementation.
7. Design the coarse N-API boundary.
8. Design cache ownership and concurrency before selecting shared-map primitives.
9. Implement the full one-thread Rust backend through test-driven differential stages.
10. Enable Rayon only after exact one-thread parity.
11. Add deterministic parallel batches one at a time, measuring each.
12. Complete packaging, CI, rollout, rollback, and final evidence.

Do not ask whether to preserve semantics, tests, or the TypeScript backend. Those decisions are final.

Do not trade output changes for speed. Do not improve nesting quality. Do not alter accepted layouts. Do not weaken tests.

Deliver the same algorithm, the same decisions, the same geometry, the same errors, and the same observable contracts, implemented completely in Rust and measurably faster.