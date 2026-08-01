# Deterministic Parallelism Inventory — Rust Irregular Nesting Backend

Status: Stage 0 design artifact. Required implementation artifact #5 of migration-prompt
§22 ("a deterministic parallelism inventory listing every Rayon site"). Governed by
`docs/prompts/fable5-rust-irregular-nesting-implementation.md` §14 ("Safe and unsafe
parallelization boundaries"), read together with §13 ("Cache architecture for true
multithreading") and §19 (the preregistered performance contract). This document does
not authorize any Rayon code today — no `rayon` dependency exists in
`crates/irregular-nesting-native/Cargo.toml` yet, and migration-prompt §6 Stage 4 forbids
enabling broad parallelism before Stage 2 (full one-thread parity) and Stage 3 (cache
architecture) land. This is the inventory that Stage 4 must implement against, and the
contract Stage 4's determinism tests must prove.

Source corpus: the 20 documents in `docs/planning/rust-irregular-backend/characterization/`,
specifically each document's own "Parallelism assessment" section (§13, or the equivalent
un-numbered section in `reconstruction.md`, which uses identical `## 13. Parallelism
assessment` heading text despite not appearing under `grep -n "^#"` in a plain-text scan —
the file contains a non-ASCII byte elsewhere that makes `grep` treat it as binary; use
`grep -a` to see its headings), plus the horizontal `js-semantics-audit.md` §13. Every site
below is drawn directly from that corpus; none is newly invented. Where the source material
already gives a "SAFE-CANDIDATE (with conditions) / FORBIDDEN / NEEDS-MEASUREMENT" verdict
in substance, this document assigns the formal verdict directly; where the source material
was itself ambivalent or recommended deferral, this document says so explicitly rather than
picking a verdict on its own authority.

This document does not repeat the exhaustive line-level behavioral proofs already recorded
in the characterization corpus. Each site card cites the source document and file:line so
a Stage 4 implementer can go straight to the primary evidence.

---

## 0. How to use this document

Each candidate site gets a card with these fields, exactly as requested:

- **Description** — what pure/independent work exists.
- **TS location** — `file.ts:lines`, traced (not guessed) by the source characterization doc.
- **Why independent** — the concrete argument for why parallel evaluation cannot change the
  result, restricted to the *pure compute* portion only.
- **Stable-index scheme** — how ordinals are assigned before dispatch, per migration-prompt
  §14.3 step 1-2.
- **Reduction / comparator** — the exact serial fold, sort, or admission rule that must run
  after parallel evaluation, and which existing TS comparator function it must reproduce.
- **Cancellation/budget interaction** — whether a `control.checkpoint(...)` call, an
  evaluation-cap check, or a wall-clock deadline check currently sits inside the loop being
  parallelized, and what that implies.
- **Cache interaction** — whether the site reads/writes a namespace covered by
  `geometry-caches.md`/`nfp-ifp.md`, and therefore is gated on the Stage 3 cache-architecture
  decision (migration-prompt §13.3).
- **Risk class** — one or more of the codes in §1.2 below.
- **Required tests** — beyond the standard template (§1.3), any site-specific determinism
  property.
- **Target Rust module** — best-fit module in `crates/irregular-nesting-native/src/`, using
  the Stage 1 skeleton's actual directory names where one exists, and flagging where the
  skeleton has no matching module yet (§7).
- **Verdict** — `SAFE-CANDIDATE (conditions: …)`, `NEEDS-MEASUREMENT (reason: …)`, or
  `FORBIDDEN (reason: …)`.

## 1. Vocabulary

### 1.1 Verdicts

- **SAFE-CANDIDATE (with conditions)** — the pure-compute portion is provably independent
  and order-invariant; a Rayon implementation is permitted in Stage 4 *once* every listed
  condition (cache design, ordinal reduction, budget pre-computation, etc.) is met and the
  required tests pass at thread counts 1, 2, default, and 8. This verdict is not a promise
  that parallelizing the site is profitable — see Priority (§2) — only that it is safe.
- **NEEDS-MEASUREMENT** — safety is plausible or proven for the pure compute, but the
  workload is too small, too rare, or too entangled with an unresolved design question
  (cache policy, module layout, a "should this dead code even be ported" open question) to
  commit to a verdict without a targeted benchmark or an explicit orchestrator ruling first.
  Treat as "no" until measured.
- **FORBIDDEN (reason: …)** — parallelizing this as an uncontrolled cohort would change
  selected layouts, partitions, ranking, chronology, or accounting. Maps to migration-prompt
  §14.2. Never attempt without a fresh, explicit, separately-approved redesign.

### 1.2 Risk classes

- **RC-A** — pure per-item map, zero shared mutable state, trivial ordinal reduction (no
  sort, no dedup, no cap). Lowest implementation risk.
- **RC-B** — pure per-item map feeding a stable sort whose comparator can return a tie;
  parallel key computation is safe only if the final sort stays serial and stable, keyed on
  `(comparator_result, original_index)`.
- **RC-C** — pure per-item map, but the *set* of items actually evaluated is gated by an
  evaluation-cap or checkpoint boundary that currently fires mid-loop; parallel-safe only for
  a pre-determined admitted subset (computed by a cheap serial pre-pass, or by scoring the
  full batch and then serially truncating the *fold*, never the scoring, at the cap).
- **RC-D** — pure per-item map feeding a `Map`-based first-write-wins or last-write-wins
  dedup/ownership structure; needs a serial replay in original order after parallel
  evaluation, not a concurrent map.
- **RC-E** — pure per-item map that reads or writes a shared cache/memo namespace; gated on
  the Stage 3 cache-architecture decision (single-flight vs. sharded vs. duplicate-computation
  policy, migration-prompt §13.3/§13.5).
- **RC-F** — pure per-item map feeding a non-associative binary64 serial sum; parallel
  computation of the individual terms is fine, but the fold into the final sum must stay
  strictly serial and left-to-right (migration-prompt §8.1).
- **RC-G** — wall-clock-budget-relative; the loop being parallelized currently measures
  elapsed time consumed by *prior* iterations to decide how much budget the *next* iteration
  gets. Parallelizing changes the measured quantity itself, not just its computation order.

### 1.3 Standard determinism test template (T-STD)

Every SAFE-CANDIDATE site requires, at minimum:

> Run the owning stage under Rust thread counts `{1, 2, default, 8}` on the preregistered
> performance-contract fixtures (`performance-contract.md` §2: C1 Mixed-61 `2000x2700`, C2
> Triangle-20 `2000x2700`, C3 Shapes-17 `2000x2700`, C4 Mixed-61 `600x400`, C7 Short Side over
> the nine-baselines matrix), each repeated ≥ 5 times per thread count, with Rayon's
> work-stealing schedule perturbed where practical (e.g. varying `RAYON_NUM_THREADS` and, if
> feasible, injecting artificial scheduling jitter in a debug harness) to expose latent
> ordering races per migration-prompt §18.4. Assert byte-identical: canonical collision/fitted
> hashes, placed/unplaced ID partitions, evaluation counts, checkpoint bytes under an injected
> deterministic clock, and the exact ordered array/field this site contributes to. Additionally
> assert 1-thread Rust output is byte-identical to the TypeScript differential oracle for the
> same fixture (this is Stage 2's parity requirement, re-asserted here because a site that
> passes only the N-thread self-consistency check but silently diverged from TS at 1 thread is
> not actually safe).

Per-site "Required tests" entries below list only what T-STD does not already cover.

---

## 2. Priority map

Priorities are derived from the Mixed-61 CPU self-time breakdown recorded in
`baseline-evidence.md` (41,972 samples, 45.5 s sampled, commit `f282f0a`). A cluster whose
TypeScript code accounts for a larger self-time share is a higher-value Rayon target *if* a
safe site exists in it — this is a sequencing hint for Stage 4, not a safety judgment.

| Mixed-61 self-time category | Share | Primary cluster(s) | Sites |
| --- | ---: | --- | --- |
| NFP/IFP candidate generation | 29.6% | `nfp-ifp`, `geometry-caches`, `validation-spatial` (hull) | PAR-NFP-\*, PAR-CACHE-\*, PAR-VAL-04 |
| search / decoders / portfolios | 14.4% | `capacity-search`, `strict-decoder-gap-family`, `periodic` | PAR-CAPSEARCH-\*, PAR-STRICT-\*, PAR-PERIOD-\* |
| beam-state canonical keys | 12.9% | `search-scoring`, `canonical-grid` | PAR-XCUT-01, PAR-CGRID-\* |
| GC | 7.9% | n/a (Rust has no GC; addressed by `Arc`-sharing, not Rayon) | — |
| placement validation / convex predicates | 6.8% | `validation-spatial` | PAR-VAL-01..03,07 |
| Effect runtime | 5.5% | n/a (disappears entirely — no Effect-TS in Rust) | — |
| other geometry kernels | 5.5% | `collision-prep`, `canonical-grid` | PAR-COLL/GEOM-01, PAR-CGRID-\* |
| clipper2 | 4.8% | `collision-prep`, `nfp-ifp` (via hull/offset) | PAR-COLL/GEOM-01 (conditional on Clipper2 binding thread-safety) |
| spatial index | 3.9% | `validation-spatial` | PAR-VAL-05, PAR-VAL-06 |
| canonical grid exact math | 3.2% | `canonical-grid` | PAR-CGRID-01..04 |
| canonical layout metrics | 3.2% | `canonical-grid` | PAR-CGRID-03,04 |

**Priority tiers used in §3 site cards:** HIGH (cluster ≥ 10% self-time and a SAFE-CANDIDATE
site exists), MEDIUM (3–10% or high-value but currently gated on Stage 3 cache design),
LOW (< 3%, dead/near-dead code, or fan-out width too small to amortize thread dispatch).

---

## 3. Site inventory

### 3.1 Collision preparation and Effect-boundary geometry layer

`collision-prep.md` and `effect-boundary.md` characterize the same physical loop
(`computeIrregularNesting.ts:389-431`) from two angles — the former from the
`CollisionGeometryBuilder`/`TransformGenerator` implementation side, the latter from the
`GeometryKernel.Service` Effect-schema-decode wrapper side. A Rust port collapses the schema-decode
seam entirely (no Effect-TS in Rust), so both characterizations converge on one Rust-side site.

**PAR-GEOM-01 — Per-piece collision geometry build + transform generation.** Priority: MEDIUM
(5.5% "other geometry kernels" + a share of 4.8% clipper2).
- Description: for each prepared piece `i`, `collisionGeometry_i = buildPiece(source_i,
  padding)` then `transforms_i = generateTransforms(collisionGeometry_i, …)`.
- TS location: `computeIrregularNesting.ts:389-431`; `collisionGeometryBuilder.ts`
  (`CollisionGeometryBuilder.buildPiece`); `transformGenerator.ts`
  (`TransformGenerator.generateTransforms`); Effect-schema wrapper in `geometryKernel.ts`
  (`flattenSourceGeometry`, `convexHull`, `offsetConvexPolygon`).
- Why independent: pure function of piece-local inputs plus globally-shared, read-only
  settings; no piece's computation reads or mutates another piece's intermediate state
  (`collision-prep.md` §4, §9; `effect-boundary.md` §4, §9.4 — this loop touches **no**
  cache).
- Stable-index scheme: ordinal = position in `sortedPieces` (the already-stably-sorted input
  list from `sortPiecesForNesting`).
- Reduction / comparator: none — reconstruct `preparedPieces: Vec<PreparedPiece>` and
  concatenate `diagnostics: Vec<CollisionGeometryDiagnostic>` by walking ordinals `0..n` in
  order, never by completion order (`collision-prep.md` §13, `effect-boundary.md` §13.1,
  `worker-coordination.md` §13 all independently confirm this exact requirement).
- Cancellation/budget interaction: none observed inside this specific loop in the current TS
  source.
- Cache interaction: none for this loop itself. (Downstream candidate generation that
  *consumes* these transforms does touch caches — see §3.2/§3.3.)
- Risk class: RC-A.
- Required tests: T-STD plus a fixed-seed fixture with two pieces that would previously
  reach `diagnostics`/`preparedPieces` in a specific TS order, asserting the Rust ordinal
  reconstruction reproduces that exact order at every thread count.
- Target Rust module: `geometry` (piece build) + `transforms` (transform generation); the
  orchestrating loop itself lives above both, in whatever module owns `computeIrregularNesting`'s
  Rust equivalent (proposed `search::pipeline` or a new top-level `pipeline` module — see §7).
- Verdict: **SAFE-CANDIDATE** (conditions: (1) ordinal-indexed reconstruction, never
  completion-order append; (2) the chosen Rust Clipper2 strategy must itself be verified safe
  for concurrent, independent invocation from multiple threads — this is a property of the
  vendor-translated `clipper2-ts` port, not of this loop, and must be proven before this site
  is enabled).

**PAR-GEOM-02 — Curve flattening within one piece.** Priority: LOW.
- Description: `ArcFlattening`/`EllipseFlattening` per-segment point generation within one
  piece's source curves.
- TS location: `geometryKernel.ts:119-161` (`arcFlattening.ts`/`ellipseFlattening.ts`).
- Why independent: per-segment computation is pure, *except* for a shared
  `pointsStore`/`sampledSourceCurves` mutable accumulator (`collision-prep.md` §4, §13).
- Stable-index scheme: ordinal = segment position within one piece's curve list.
- Reduction / comparator: serial merge into the accumulator in original segment order,
  preserving the exact-key global dedup semantics documented in `collision-prep.md` §4.
- Cancellation/budget interaction: none observed.
- Cache interaction: writes the piece-local `pointsStore` accumulator only, not a
  cross-piece cache.
- Risk class: RC-A (with a serial-merge condition).
- Required tests: T-STD only; no fixture is known to exercise > tens of segments per piece.
- Target Rust module: `geometry`.
- Verdict: **NEEDS-MEASUREMENT** (reason: typically tens of segments per piece — the source
  document itself flags this as "likely marginal compared to piece-level parallelism"; do not
  implement before PAR-GEOM-01 is measured and found insufficient on its own).

### 3.2 Geometry caches (NFP / transform / IFP namespaces)

`geometry-caches.md` is the authoritative cluster for cache *design*; migration-prompt §13
requires the cache architecture to be designed, instrumented, and tested (Stage 3) before any
of the sites below — or any site elsewhere that reads/writes these namespaces — is enabled
under Rayon. The sites here are the *pure compute* payloads that the cache design must wrap.

**PAR-CACHE-01 — Pure NFP/transform compute, pre-cache.** Priority: HIGH (feeds the 29.6%
NFP/IFP category directly).
- Description: `computeRelativeNfpBoundary`/`computeTransformedCollisionGeometry` — the pure
  compute functions, not the cache-aware wrapper — for distinct `(fixed, moving)` or
  `(geometry, transform)` pairs.
- TS location: `nfpBoundaryCore.ts::resolveNfpBoundary` (`:125-167`);
  `transformCollisionGeometryCore.ts::resolveTransformedCollisionGeometry` (`:38-63`).
- Why independent: side-effect-free functions of their inputs; distinct keys share no data
  (`geometry-caches.md` §13).
- Stable-index scheme: ordinal = position in the deduplicated key list assembled *before*
  dispatch (migration-prompt §14.1: "independent pairwise relative NFP computations after key
  deduplication").
- Reduction / comparator: none beyond writing into slots keyed by the pre-deduplicated key
  list; no sort.
- Cancellation/budget interaction: none in the pure-compute functions themselves; the
  *caller* loops that invoke them do observe checkpoints (see PAR-NFP-01).
- Cache interaction: this **is** the cache-fill payload. Gated entirely on the Stage 3
  single-flight-vs-duplicate-computation policy decision (`geometry-caches.md` §13, second
  bullet): "the published value for a given key must be identical regardless of which thread
  wins the race," which holds today because both functions are pure — but the publish
  mechanism (single-flight lock vs. allow-duplicate-then-publish-by-exact-key-equality) is an
  explicit Stage 3 design decision, not decided by this document.
- Risk class: RC-E.
- Required tests: T-STD plus a forced-cache-miss-storm stress test (many threads requesting
  the same uncached key simultaneously) asserting the published value is identical to a
  single-threaded recomputation, and that stale/invalid values are never published
  (migration-prompt §13.1, §18.4).
- Target Rust module: `nfp_ifp` (NFP), `transforms` (transformed collision geometry),
  `caches` (the shared store both read/write).
- Verdict: **NEEDS-MEASUREMENT** (reason: safety of the pure compute is not in question, but
  the *profitable* concurrency policy — single-flight vs. sharded vs. duplicate-allowed — is
  explicitly a Stage 3 measurement task per migration-prompt §13.3, which lists five
  architectures to evaluate with targeted measurements before any is chosen. This is the
  single highest-value site in the whole inventory given the 98.2% NFP cache hit rate
  recorded in the migration prompt §6 and must not be short-circuited to a default choice).

**PAR-CACHE-02 — Cache key construction.** Priority: MEDIUM.
- Description: `makePairwiseNfpCacheKey`, `makeTransformCollisionGeometryCacheKey`,
  `makeInnerFitBoundsCacheKey` — pure string/tuple building.
- TS location: `nfpCacheKey.ts`, `geometryCacheIdentity.ts`.
- Why independent: pure per-input construction, no shared state (`geometry-caches.md` §13).
- Stable-index scheme: ordinal = position in whatever candidate list is requesting keys.
- Reduction / comparator: none.
- Cancellation/budget interaction: none.
- Cache interaction: produces the keys the cache is addressed by; does not itself touch the
  store.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: `caches` (key types), `nfp_ifp`/`transforms` (call sites).
- Verdict: **SAFE-CANDIDATE** (no conditions beyond T-STD — this is cheap enough that
  parallelizing it in isolation is unlikely to matter; bundle it with PAR-CACHE-01's batch
  dispatch rather than as a standalone Rayon call).

**PAR-CACHE-03 — Cache read-decide-write critical section.** Priority: HIGH (structural
prerequisite for PAR-CACHE-01 and every NFP/IFP consumer site below).
- Description: the get → validate-hit → evict-if-stale → compute → materialize → set
  sequence itself (`effect-boundary.md` §9.5's 10-step sequence for
  `transformCollisionGeometry`; `geometry-caches.md` §9.1-9.3 for the NFP/IFP equivalents).
- TS location: `transformCollisionGeometry.ts` (wrapper); `nfpBoundaryCore.ts`/`ifpBoundsCore.ts`.
- Why independent: not independent by itself — this is the contended resource PAR-CACHE-01's
  parallel dispatch races against. Listed as its own site because it is the actual
  Stage 3 deliverable, not a side effect of parallelizing the compute.
- Stable-index scheme: not applicable (this is a shared-structure design, not an indexed
  batch).
- Reduction / comparator: not applicable.
- Cancellation/budget interaction: "if parallel execution changes when a lookup occurs
  relative to a semantic cancellation or deadline checkpoint, the parallel design is not yet
  valid" (migration-prompt §13.2, restated verbatim by `geometry-caches.md` §13).
- Cache interaction: this *is* the cache.
- Risk class: RC-E, RC-G (stale-eviction ordering interacts with wall-clock-adjacent
  checkpoint behavior in callers).
- Required tests: race-focused stress tests per migration-prompt §18.4, model-checked with
  Loom or an equivalent tool on the isolated cache primitive (not the whole geometry system,
  per migration-prompt §18.4's explicit scoping).
- Target Rust module: `caches`.
- Verdict: **NEEDS-MEASUREMENT** (reason: this is Stage 3's primary subsystem in its own
  right; migration-prompt §13.3 requires evaluating ≥ 5 named architectures before choosing
  one — no verdict is possible until that evaluation exists).

**PAR-CACHE-04 — `validatedRings` fingerprint memo.** Priority: LOW.
- Description: a shared mutable side table (fingerprint memo avoiding redundant ring
  revalidation) with no natural sharding key beyond array identity.
- TS location: cited in `geometry-caches.md` §4/§9.4/§12.3 (JS-object-identity-keyed
  `WeakMap`-style memo).
- Why independent: not independent as a shared structure — flagged because Rust's ownership
  model may make the underlying hazard it defends against (redundant revalidation of the same
  JS object) not exist at all.
- Stable-index scheme: n/a.
- Reduction / comparator: n/a.
- Cancellation/budget interaction: none.
- Cache interaction: itself a cache; the open question is whether to port it as a literal
  shared structure at all.
- Risk class: RC-E.
- Required tests: a differential test proving the *validation outcome* (accept/reject,
  reported winding) for every ring is unchanged whether or not the memo exists, before
  dropping it.
- Target Rust module: `caches` or `validation` (undecided — see open questions, §8).
- Verdict: **NEEDS-MEASUREMENT** (reason: `geometry-caches.md` §13 explicitly recommends
  *not* porting this as a literal shared cache, contingent on benchmark evidence that the
  underlying O(n²) revalidation cost is not dominant post-port — this needs explicit
  orchestrator confirmation before a Rust implementer treats it as free to drop, per that
  document's own closing caveat).

### 3.3 NFP/IFP service

**PAR-NFP-01 — Per-placed-piece NFP resolution loop.** Priority: HIGH.
- Description: for each already-placed piece, `resolveNfpBoundaryFromServiceStore(placed,
  moving, geometry-settings)`.
- TS location: `nfpIfpService.ts:314-352` (the `for (const placed of input.placed)` loop).
- Why independent: pure function of `(placed, moving, settings)` plus the shared cache
  (`nfp-ifp.md` §13).
- Stable-index scheme: ordinal = position in `input.placed`.
- Reduction / comparator: write into slots by ordinal; no sort needed for this loop alone
  (downstream consumers sort).
- Cancellation/budget interaction: a `'placed-nfp'` checkpoint fires immediately before and
  after *each* iteration today (`nfp-ifp.md` §10, checkpoints 3-4). A parallel version must
  gather the checkpoint decision serially at fixed points — either bracket the whole parallel
  batch with one checkpoint before and one after, since checkpoint *count* is not itself
  parity-gated (`geometry-caches.md` §13.7), but checkpoint-failure timing *relative to
  partial cache mutation* still is.
- Cache interaction: consumes PAR-CACHE-01/03 directly.
- Risk class: RC-A (pure compute) + RC-E (cache) + RC-C (checkpoint boundary condition).
- Required tests: T-STD plus a cancellation-mid-batch test asserting no partial-cache-publish
  artifact survives a cancelled job (migration-prompt §15's "no partial result" rule).
- Target Rust module: `nfp_ifp`.
- Verdict: **SAFE-CANDIDATE** (conditions: Stage 3 cache design landed first; checkpoint
  bracketing as described above).

**PAR-NFP-02 — Candidate-point legality assessment across raw points.** Priority: HIGH.
- Description: per-point legality-and-grid-key computation across `sortedPoints`.
- TS location: `nfpIfpService.ts:495-554`.
- Why independent for the *pure* part only: NOT independent as a whole — the algorithm is
  "walk `sortedPoints` in order, and the set of already-`acceptedGridKeys` mutates as you go,"
  so a later point's outcome genuinely depends on which earlier points (in fixed `(y,x)`
  order) already claimed that grid cell (`nfp-ifp.md` §13).
- Stable-index scheme: ordinal = position in `sortedPoints`.
- Reduction / comparator: parallel-evaluate each point's own legality+grid-key result, then
  serially reduce over the exact `sortedPoints` order to decide first-acceptance-per-grid-key
  — migration-prompt §14.3's exact deterministic pattern.
- Cancellation/budget interaction: none observed inside this specific inner computation.
- Cache interaction: none directly (feeds candidate generation, not the NFP cache itself).
- Risk class: RC-D.
- Required tests: T-STD plus a synthetic fixture with two raw points that map to the same
  grid key, asserting the "first in `sortedPoints` order" point wins acceptance at every
  thread count, not the first to finish.
- Target Rust module: `nfp_ifp`.
- Verdict: **SAFE-CANDIDATE** (conditions: the pure per-point map runs in parallel; the
  first-acceptance-per-grid-key fold runs serially afterward in original `sortedPoints`
  order, never as a concurrent map).

**PAR-NFP-03 — Pairwise NFP-NFP boundary intersection search.** Priority: MEDIUM.
- Description: for each `(first, second)` pair with `second.index > first.index`, call
  `addBoundaryIntersections` against the already-built `candidateNfpBoundaries`.
- TS location: `nfpIfpService.ts:427-489`.
- Why independent: pure function of already-built boundaries; each pair only *adds* points
  into a shared `CanonicalPointSet` via commutative, associative operations (Set-membership-
  then-push, Map bit-OR) whose eventual output is provably order-independent
  (`nfp-ifp.md` §5, §13).
- Stable-index scheme: ordinal = `(first.index, second.index)` pair position in the fixed
  nested-loop enumeration order.
- Reduction / comparator: parallel map collecting per-pair point lists, merged with a stable
  reduction into the point set (order-independent by construction, per the source doc's own
  proof).
- Cancellation/budget interaction: none observed inside this loop specifically.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only (the source document already proves order-independence of the
  merge; T-STD is sufficient to catch a regression in that proof).
- Target Rust module: `nfp_ifp`.
- Verdict: **SAFE-CANDIDATE** (no additional conditions beyond T-STD).

**PAR-NFP-04 — 9-alternative grid-snap search per raw point.** Priority: LOW.
- Description: `canonicalPlacementPointAlternatives` — pure, tiny per-point search.
- TS location: `nfpIfpService.ts:569-593`.
- Why independent: pure, no shared state.
- Stable-index scheme: swept up in whichever outer restructuring is chosen for PAR-NFP-02.
- Reduction / comparator: n/a standalone.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: covered by PAR-NFP-02's tests.
- Target Rust module: `nfp_ifp`.
- Verdict: **NEEDS-MEASUREMENT** (reason: too small to be a standalone Rayon dispatch; fold
  into PAR-NFP-02's batch rather than parallelizing separately).

### 3.4 Canonical grid

**PAR-CGRID-01 — Convex-hull dedup+sort+monotone-chain build, across independent calls.**
Priority: MEDIUM.
- Description: `canonicalGridConvexHull` is a pure function of one input point list; many
  independent calls (one per candidate/state being evaluated) are parallelizable across
  *calls*, though the internal `buildHalf` stack loop must not itself be parallelized.
- TS location: `canonicalGridMath.ts:138-171`.
- Why independent: pure per-call; `canonical-grid.md` §13 explicitly separates "parallelize
  across calls" from "do not parallelize inside one call."
- Stable-index scheme: ordinal = position in whatever candidate/state batch is requesting
  hulls.
- Reduction / comparator: none beyond ordinal-indexed collection.
- Cancellation/budget interaction: none observed at this layer.
- Cache interaction: none.
- Risk class: RC-A, plus the `js-semantics-audit.md` §13 caveat: the function's internal
  `Map`-based first-position/last-value dedup is order-sensitive if its *input* array were
  ever assembled by a non-deterministic parallel merge — today it is always serially
  constructed, so this is a constraint on upstream callers, not this site itself.
- Required tests: T-STD plus the audit's named property test (duplicate-coordinate input,
  asserting the same duplicate instance survives at every thread count).
- Target Rust module: `canonical_grid`.
- Verdict: **SAFE-CANDIDATE** (conditions: input point lists must remain serially assembled
  before dispatch, per the audit's caveat).

**PAR-CGRID-02 — Per-piece/per-pair canonical-grid path construction and edge extraction.**
Priority: MEDIUM.
- Description: `canonicalGridPathEdges` given one path.
- TS location: `canonicalGridContact.ts:210-234`.
- Why independent: pure given one path (`canonical-grid.md` §13).
- Stable-index scheme: ordinal = placed-piece index.
- Reduction / comparator: combine results serially by ordinal, matching migration-prompt
  §14.3's construct→assign→evaluate→store→reconstruct pattern exactly (the source document
  states this explicitly).
- Cancellation/budget interaction: none at this layer.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: `canonical_grid`.
- Verdict: **SAFE-CANDIDATE** (no additional conditions).

**PAR-CGRID-03 — Lower-triangle pairwise contact/intersection scans.** Priority: MEDIUM.
- Description: per-pair Clipper2 intersection calls inside `measureCanonicalLayoutContacts`,
  `assertCanonicalGridLegalLayout`, `analyzeCanonicalLayoutStructure`, `measureContactGraph`.
- TS location: `canonicalLayoutGeometry.ts` (multiple functions; see `canonical-grid.md` §13
  for exact line ranges per function).
- Why independent: per individual pair, pure and independent of every other pair.
- Stable-index scheme: ordinal = lower-triangle pair index in the fixed deterministic
  enumeration order.
- Reduction / comparator: **two different rules depending on function** — (a)
  `assertCanonicalGridLegalLayout` returns only a `boolean` today (legal iff no pair is
  illegal), so full parallel evaluation-then-AND-reduce is safe and preserves the boolean
  exactly, though it changes *how much work is done* (loses the current first-failure
  early-exit) — acceptable since no per-pair diagnostic is currently surfaced; (b)
  `analyzeCanonicalLayoutStructure` accumulates ordered diagnostic arrays
  (`positiveContactPairs`, `positiveAreaConflicts`, …) that are explicitly re-sorted with a
  total-order comparator (`comparePiecePairs`) before return, so parallel discovery followed
  by the existing serial sort is also safe **provided** that sort is still applied serially,
  in the exact TS order/comparator, afterward.
- Cancellation/budget interaction: none observed at the pairwise-scan layer itself
  (`measureCanonicalGridBoundaryOverlapAxisUnits`'s own checkpoint-observing scan is a
  separate, must-stay-serial site — see §4 below).
- Cache interaction: none.
- Risk class: RC-A for (a); RC-B for (b).
- Required tests: T-STD plus, for `assertCanonicalGridLegalLayout` specifically, a test
  proving no per-pair diagnostic is ever added to this function's return type in the Rust
  port without re-deriving this parallelism decision (a full-scan design silently loses "first
  failure reported" semantics the moment a diagnostic is added).
- Target Rust module: `canonical_grid`.
- Verdict: **SAFE-CANDIDATE** (conditions: (a) `assertCanonicalGridLegalLayout` stays
  boolean-only; (b) `analyzeCanonicalLayoutStructure`'s final sort remains serial and uses
  the exact `comparePiecePairs` comparator).

**PAR-CGRID-04 — Shared-boundary map-then-sum-reduce across placed pieces.** Priority:
MEDIUM.
- Description: `sharedConvexPolygonBoundarySegments`/`measureSharedConvexPolygonBoundaryContact`
  and their canonical-grid analogs, over "all currently-placed pieces vs. one newly-added
  piece."
- TS location: `convexPolygonContact.ts`; consumed by `irregularBeamState.ts`'s
  `sharedBoundaryWithEntries` (a different cluster's call site, see PAR-XCUT-01's neighbor
  discussion in `search-scoring.md`).
- Why independent: pure given two already-translated polygons; the accumulated
  `lengthMm`/`normalizedUnits`/`nearCompleteStructuralContactCount` sums are associative and
  commutative in the abstract, and `dominantNearCompleteStructuralContactCount` is a
  `Map`-then-`Math.max` reduction (provably order-independent).
- Stable-index scheme: ordinal = placed-piece index in the existing placed-set order.
- Reduction / comparator: **not a free associative sum** — `lengthMm` is a plain `Number`
  binary64 accumulation (`deriveSharedCollisionBoundaryMetrics`'s nested summation order,
  flagged independently by `search-scoring.md` §13.2 as "the sharpest hazard in this
  cluster"). The individual per-pair terms may be computed in parallel, but the final sum
  must be folded **serially, left-to-right, in the exact current order** — RC-F applies.
- Cancellation/budget interaction: none.
- Cache interaction: none directly (contrast with `irregularLayoutScorer.ts`'s free-material
  cache, a different site — see PAR-SCORE-04).
- Risk class: RC-F.
- Required tests: T-STD plus a bit-identical-sum differential test across thread counts,
  per migration-prompt §14.4.
- Target Rust module: `canonical_grid` (pure geometry) / `search` (the beam-state caller).
- Verdict: **SAFE-CANDIDATE** (conditions: per-pair term computation only; the summation
  fold itself remains strictly serial and left-to-right, matching TS iteration order exactly).

**PAR-CGRID-05 — `identityAtQuarterTurn`'s 4-rotation fan-out.** Priority: LOW.
- Description: 4 per-rotation identity strings computed independently, then
  `.toSorted()[0]` selects the code-unit-smallest.
- TS location: `canonicalLayoutGeometry.ts:144-149`.
- Why independent: pure, no shared state across the 4 rotations.
- Stable-index scheme: ordinal 0-3 (fixed rotation order).
- Reduction / comparator: serial code-unit-smallest selection over exactly 4 elements.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: `canonical_grid`.
- Verdict: **NEEDS-MEASUREMENT** (reason: fan-out width of 4 has essentially no performance
  benefit given thread-dispatch overhead; `canonical-grid.md` §13 says this explicitly —
  do not implement).

**PAR-CGRID-06 — `freeMaterialService.ts` per-region/per-hole path construction.** Priority:
LOW.
- Description: `toMaterialPaths` — embarrassingly parallel across regions/holes.
- TS location: `freeMaterialService.ts:204-232`.
- Why independent: pure per-region/per-hole transform.
- Stable-index scheme: ordinal = region/hole index.
- Reduction / comparator: none beyond ordinal collection.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: n/a — see verdict.
- Target Rust module: `canonical_grid` (or wherever free-material derivation lands; see §7).
- Verdict: **NEEDS-MEASUREMENT** (reason: `freeMaterialService.ts` has **zero production
  call sites** on the Compact/Compact Short Side path — `canonical-grid.md` §1 confirms it
  runs "at most twice per completed job" only through non-default diagnostic/legacy paths.
  Parallelizing it would only speed up tests, which migration-prompt §19 explicitly excludes
  as a goal. Deprioritize below every other site in this document.)

### 3.5 Validation and spatial index

**PAR-VAL-01 — `GeometryPredicates.orientation` batch evaluation.** Priority: LOW standalone
/ enabling for others.
- Description: pure O(1) three-point orientation test.
- TS location: cited in `validation-spatial.md` §13 (no dedicated line range given for the
  predicate itself — see that document's §2/§7 for the exact site).
- Why independent: pure, no shared state.
- Stable-index scheme: ordinal = position in whatever batch calls it.
- Reduction / comparator: none standalone.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: covered by whichever larger batch invokes it (see PAR-VAL-02/07).
- Target Rust module: `validation`.
- Verdict: **NEEDS-MEASUREMENT** (reason: not valuable standalone; only valuable as part of
  a larger batch reduction, per the source document's own framing).

**PAR-VAL-02 — `ConvexPolygonValidation.validateStrictBoundary` across distinct polygons.**
Priority: MEDIUM (6.8% placement-validation share).
- Description: validating every placed piece's translated polygon independently.
- TS location: `convexPolygonValidation.ts:15-33`.
- Why independent: no shared state across different polygons; per-polygon cost is O(n)
  (fast path) or O(n²) (fallback sweep), but polygons are tiny (≤ 8 vertices typical, per the
  linear-ring-topology corpus finding cited in `validation-spatial.md` §1).
- Stable-index scheme: ordinal = piece index in the placed-set snapshot being validated.
- Reduction / comparator: none beyond ordinal collection — this is a batch-of-independent-
  booleans/results, not a sort.
- Cancellation/budget interaction: none observed inside this function.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only; note the parallelism opportunity is *across* polygons in a
  batch, not within one (the source doc is explicit that within-polygon parallelism is not
  valuable at these vertex counts).
- Target Rust module: `validation`.
- Verdict: **SAFE-CANDIDATE** (no additional conditions).

**PAR-VAL-03 — `convexBounds.ts` batch operations across distinct polygons.** Priority:
MEDIUM.
- Description: `boundsForPoints`/`translatePolygonWithBounds`/`areDisjoint`, same
  batch-across-independent-polygons reasoning as PAR-VAL-02.
- TS location: `convexBounds.ts`.
- Why independent: pure, O(n)/O(1), no shared state.
- Stable-index scheme: ordinal = polygon index in the batch.
- Reduction / comparator: none.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: `validation`.
- Verdict: **SAFE-CANDIDATE** (no additional conditions).

**PAR-VAL-04 — `computeConvexHull` (`convexHullCore.ts`) across independent NFP pairs.**
Priority: HIGH (feeds the 29.6% NFP/IFP category — this is the live default
`'vertex-pair-hull'` algorithm's hull step, called once per pairwise NFP construction).
- Description: many independent `computeConvexHull` calls across independent piece pairs,
  each over a small Minkowski-sum point set (`|fixed| × |moving|`, still small given the
  vertex-count corpus finding).
- TS location: `core/convexHullCore.ts`.
- Why independent: pure per call; the internal sort/scan is sequential-with-backtracking
  (not itself parallel-friendly) but each *call* is independent of every other call.
- Stable-index scheme: ordinal = pair index in the already-deduplicated NFP key list (shared
  with PAR-CACHE-01's ordinal scheme).
- Reduction / comparator: none beyond ordinal-indexed collection of hull results feeding
  onward into PAR-CACHE-01's NFP compute.
- Cancellation/budget interaction: inherits PAR-NFP-01's checkpoint bracketing (this
  function is invoked from inside that loop).
- Cache interaction: this is exactly migration-prompt §14.1's "independent pairwise relative
  NFP computations after key deduplication" candidate; **explicitly conditional on the
  NFP-cache single-flight/deduplication design (Stage 3) being in place first**
  (`validation-spatial.md` §13).
- Risk class: RC-A, RC-E (via its caller).
- Required tests: T-STD only, run jointly with PAR-CACHE-01/PAR-NFP-01's tests since they
  share a dispatch batch.
- Target Rust module: `validation` (hull primitive), called from `nfp_ifp`.
- Verdict: **SAFE-CANDIDATE** (conditions: gated on Stage 3 cache design landing first, per
  the source document's explicit conditionality).

**PAR-VAL-05 — `PlacedCollisionSpatialIndex.query(bounds)` concurrent reads on an immutable
index.** Priority: MEDIUM (3.9% spatial-index share).
- Description: read-only spatial-index queries against an already-constructed, immutable
  index — the exact case migration-prompt §14.1 names directly ("read-only spatial-index
  queries for an immutable state").
- TS location: `placedCollisionSpatialIndex.ts` (`query`).
- Why independent: `query()` never mutates `self`; `add()` never mutates `self` either — it
  always returns a new instance (structurally guaranteed today).
- Stable-index scheme: ordinal = candidate-point/candidate index in whatever batch is
  querying the same snapshot.
- Reduction / comparator: none — pure read fan-out.
- Cancellation/budget interaction: none inside `query()` itself.
- Cache interaction: none (this is the spatial index, not a geometry cache namespace).
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: `validation`. A Rust port sharing one `Arc<SpatialIndex>` across Rayon
  worker threads for concurrent `query()` calls requires no locking beyond `Arc`'s reference
  counting, **provided** the index is never mutated while a concurrent query might be in
  flight against the same logical snapshot — already guaranteed structurally.
- Verdict: **SAFE-CANDIDATE** (no additional conditions beyond preserving the
  never-mutate-in-place invariant into the Rust type).

**PAR-VAL-06 — `PlacedCollisionSpatialIndex.add(placed)` from a shared parent, across sibling
beam branches.** Priority: MEDIUM/HIGH long-term (Stage 4 headline target, paired with
PAR-SCORE-05).
- Description: multiple sibling branches of a beam search calling `.add()` on the same
  parent index from different threads concurrently.
- TS location: `placedCollisionSpatialIndex.ts` (`add`).
- Why independent: each call is a pure function of `(parent, one new piece)` and produces an
  independent new index; none of them mutates the parent.
- Stable-index scheme: ordinal = sibling-candidate index under one parent state.
- Reduction / comparator: n/a — each sibling produces its own independent index; the
  downstream candidate/state comparator (owned by the search cluster, see PAR-SCORE-05)
  performs the actual serial reduction.
- Cancellation/budget interaction: inherited from the caller (capacity-search or
  strict-decoder loop dispatching the siblings).
- Cache interaction: none directly, but today's `add()` is O(n)-copy-heavy
  (`validation-spatial.md` §4, §13) — naively parallelizing many O(n)-copy calls only spreads
  the copying across threads, it does not reduce total work.
- Risk class: RC-A (correctness) with a profitability caveat.
- Required tests: T-STD plus a before/after total-CPU-time measurement proving the
  persistent-structure redesign (see next line) is a net win, not just a redistribution.
- Target Rust module: `validation`.
- Verdict: **NEEDS-MEASUREMENT** (reason: explicitly conditional on Stage 3 cache-architecture
  work *and* on first adopting a cheaper persistent structure for `add()` — e.g. an
  `Arc`-chained append-only structure or an actual immutable spatial tree with
  O(log n)-ish incremental update — so that parallelizing many sibling `add()` calls is worth
  the thread-coordination overhead at all. Do not parallelize the current O(n)-copy `add()`
  as-is.).

**PAR-VAL-07 — `assessPlacement`'s per-placed-polygon OR-reduction.** Priority: LOW at
current polygon sizes.
- Description: the outer per-`placedPolygon` loop and inner per-edge-pair loops within
  `polygonsHavePositiveAreaOverlap`'s helpers — "does any pair satisfy predicate P," an
  OR-reduction.
- TS location: `placementValidation.ts:130-141` (outer loop); helper functions within.
- Why independent: OR over a fixed, already-known set of pairs is associative and
  order-independent *for the boolean result*.
- Stable-index scheme: ordinal = placed-polygon index (outer), edge-pair index (inner).
- Reduction / comparator: boolean OR-reduce; **and**, only in the rare case a
  `GeometryFailure` occurs, select the failure by stable-index/first-in-original-order
  tie-break, never "whichever thread got there first."
- Cancellation/budget interaction: none inside this function; the 7-stage short-circuit
  sequence one level up (§4 below) must stay serial regardless.
- Cache interaction: none.
- Risk class: RC-A (boolean result) with a narrow RC-D-like tie-break requirement for the
  rare failure path.
- Required tests: T-STD plus a synthetic fixture forcing a reachable `GeometryFailure` (per
  `validation-spatial.md` §11's finding that such paths are "either provably unreachable or
  reachable only for pathological extreme-magnitude inputs") to assert the stable-index
  tie-break, if such a fixture can be constructed at all.
- Target Rust module: `validation`.
- Verdict: **NEEDS-MEASUREMENT** (reason: theoretically safe but, per the source document's
  own assessment, "practically not worth parallelizing at today's problem sizes" given ≤ 8
  vertices typical — do not implement ahead of measurement; migration-prompt §14 explicitly
  forbids parallelizing by intuition).

### 3.6 Search and scoring

**PAR-SCORE-01 — `sortPiecesForNesting`.** Priority: LOW (single call per job).
- Description: one total sort over the whole piece list, called once per job before any
  search state exists.
- TS location: `sortPiecesForNesting.ts`.
- Why independent: the function itself has zero hidden state; sort-key computation requires
  no work per comparison (pre-computed integers).
- Stable-index scheme: n/a (single call).
- Reduction / comparator: the existing TS comparator, applied by a stable sort.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-B (stability matters if any two pieces tie).
- Required tests: T-STD only.
- Target Rust module: `search`.
- Verdict: **NEEDS-MEASUREMENT** (reason: piece counts are tens, not millions — no internal
  parallelism opportunity worth pursuing, per `search-scoring.md` §13.1. Not a Stage 4
  target.).

**PAR-SCORE-02 — `irregularScoreGrid.ts` pure numeric transforms.** Priority: LOW standalone.
- Description: every function is a pure, allocation-free `number -> number | undefined`
  transform with no shared state.
- TS location: `irregularScoreGrid.ts`.
- Why independent: trivially parallel-safe by construction.
- Stable-index scheme: n/a.
- Reduction / comparator: n/a.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only, exercised as part of whichever caller batch uses it.
- Target Rust module: `search`.
- Verdict: **NEEDS-MEASUREMENT** (reason: no standalone workload large enough to matter;
  call from any thread as needed, do not dispatch it as its own Rayon batch).

**PAR-SCORE-03 — `irregularPlacementScorer.ts`'s `scoreCandidate` within one already-ordered
candidate batch.** Priority: HIGH (feeds the 14.4% search/decoders category directly; this
is migration-prompt §14.1's named example verbatim).
- Description: `scoreCandidate(sheet, placed snapshot, moving, candidate)`, independent per
  candidate within one already-generated candidate batch.
- TS location: `irregularPlacementScorer.ts:198-281`; live call site
  `intrinsicCapacitySearch.ts:654` inside `for (const candidate of legalCandidates)`
  (`:623-684`).
- Why independent: pure given its inputs; reads no mutable shared state, writes none.
- Stable-index scheme: ordinal = position in `legalCandidates`.
- Reduction / comparator: `compareScoredCandidateReferences`/`compareContactCandidateReferences`
  (owned by `capacity-search.md`, `:1731-1743`/`:1745-1754`) — the exact TS comparator, applied
  serially after parallel scoring.
- Cancellation/budget interaction: the evaluation-cap check that currently short-circuits the
  loop early (`intrinsicCapacitySearch.ts:624-634`,
  `consumedAtDepth >= placementEvaluationQuotaPerDepth || consumedPlacementEvaluations >=
  placementEvaluationCap`) must be evaluated **before** dispatching parallel work, not
  interleaved with it — the ordinal-position-based decision of *which* candidates get scored
  at all is chronology-sensitive even though scoring each *admitted* candidate is not.
- Cache interaction: none inside `scoreCandidate` itself (per `search-scoring.md` §9, the
  only true cache in this cluster belongs to `irregularLayoutScorer.ts`, see PAR-SCORE-04).
- Risk class: RC-C.
- Required tests: T-STD plus a fixture that would exactly trip the per-depth quota mid-batch,
  asserting the identical candidate subset is admitted at every thread count (this is the
  cluster's own explicit callout — see PAR-CAPSEARCH-01, the same site viewed from the
  capacity-search cluster).
- Target Rust module: `search` (scorer) / `capacity` (caller loop).
- Verdict: **SAFE-CANDIDATE** (conditions: evaluation-cap admission precomputed serially
  before parallel scoring dispatch; see PAR-CAPSEARCH-01 for the full condition).

**PAR-SCORE-04 — `irregularLayoutScorer.ts`'s pure numeric helpers.** Priority: LOW (called
at most once per job in production).
- Description: `deriveFreeMaterialMetrics`, `polygonArea`, `polygonPerimeter`,
  `absolutePolygonArea`, `convexHull`, `deriveRawOccupiedHullWasteRatio`.
- TS location: `irregularLayoutScorer.ts`.
- Why independent: each operates on one already-materialized state/snapshot with no shared
  mutable state.
- Stable-index scheme: n/a for the default Compact/Compact Short Side path (single call).
- Reduction / comparator: n/a.
- Cancellation/budget interaction: none.
- Cache interaction: the free-material cache's parent-lookup fast path
  (`computeSnapshotWithParentFallback`) is a genuine cross-call dependency — see the
  "must stay serial" note in §4.
- Risk class: RC-A standalone; RC-E if the free-material cache is ever shared across
  parallel `scoreState` calls (not the case in current production shape).
- Required tests: T-STD only, contingent on whether `windowedBeam.ts`-style beam search under
  non-default settings is ever brought into scope (it is dead for production today, per
  `aux-modules-liveness.md`).
- Target Rust module: `search`.
- Verdict: **NEEDS-MEASUREMENT** (reason: `scoreState` runs at most once per job on the
  production default path — no meaningful parallel workload exists to extract today).

**PAR-SCORE-05 — Sibling-candidate `.withPlacement` + local scoring fan-out under one parent
beam state.** Priority: HIGH — the single most-cited Stage 4 target across the whole corpus.
- Description: independent *sibling* branches (different candidates applied to the same
  parent state) each call `.withPlacement` (canonical-entry-key insertion, spatial-index add,
  contact measurement) and local scoring; each reads the same immutable parent, writes
  nothing shared.
- TS location: `irregularBeamState.ts` (`withPlacement`, lines 172-253 per
  `search-scoring.md` §4.1); consuming loops in `intrinsicCapacitySearch.ts` and
  `intrinsicStrictDecoder.ts` (owned by those clusters, not this one).
- Why independent: each transition is a pure function of one parent + one new placement; the
  beam search's tree of states cannot have individual `.withPlacement` calls reordered
  relative to their true parent-child dependency, but independent siblings under the same
  parent have no such constraint.
- Stable-index scheme: ordinal = sibling-candidate index under one fixed parent state
  (matching PAR-SCORE-03/PAR-CAPSEARCH-01/PAR-STRICT-01's ordinal schemes, since they are the
  same dispatch batch viewed from different clusters).
- Reduction / comparator: **owned by the calling cluster, not this one** — the actual serial
  reduction uses `intrinsicStrictDecoder.ts`'s or `intrinsicCapacitySearch.ts`'s own local
  comparator, never anything defined in `irregularPlacementScorer.ts`/`irregularLayoutScorer.ts`
  itself (`search-scoring.md` §13.2 is explicit about this).
- Cancellation/budget interaction: inherited from the caller's evaluation-cap/checkpoint
  boundary (see PAR-SCORE-03, PAR-CAPSEARCH-01, PAR-STRICT-01).
- Cache interaction: the contact-measurement phase inside `.withPlacement` reads
  `this.placedCollisionIndex` — **the pre-add index**, not the post-add one — any parallel
  restructuring must preserve this "measure against the old index, not the new one" ordering
  exactly (`search-scoring.md` §4.1 step 4).
- Risk class: RC-A (per-sibling independence) with an RC-F caveat on
  `deriveSharedCollisionBoundaryMetrics`'s internal summation (PAR-CGRID-04's fold rule
  applies here too, since `.withPlacement` calls into it).
- Required tests: T-STD plus the "measure against pre-add index" invariant test, plus a
  bit-identical-sum test for the boundary-metric summation across thread counts.
- Target Rust module: `search` (beam state), co-designed with `capacity` and the proposed
  `complete` module (see §7) since those own the actual reduction comparator.
- Verdict: **SAFE-CANDIDATE** (conditions: designed jointly with the owning cluster's
  comparator — this document names the site and its constraints; PAR-CAPSEARCH-01 and
  PAR-STRICT-01 own the specific reduction rules for their respective loops).

### 3.7 Capacity core

**PAR-CAPCORE-01 — Per-transform geometry/area/span computation inside preflight's inner
loop.** Priority: MEDIUM.
- Description: for one piece, each transform's `geometryKernel.transformCollisionGeometry`,
  `exactDoubledPolygonAreaGrid2`, and `transformedGridSpan` calls are independent of every
  other transform of the same piece; the only cross-transform state is pure min/min/or
  reductions (`minimumDoubledAreaGrid2`, `minimumSingletonSpanPressurePpm`, `singletonFits`).
- TS location: `intrinsicCapacityPreflight.ts:113-146`.
- Why independent: no shared mutable state read within the per-transform body other than the
  associative/commutative reduction targets.
- Stable-index scheme: ordinal = transform index within one piece's transform list.
- Reduction / comparator: min/min/or reductions — associative, order-independent by
  construction.
- Cancellation/budget interaction: `control.checkpoint('candidate-points')` is currently
  issued once per transform (line 114); a parallel batch-then-reduce implementation must
  issue an equivalent checkpoint at matching granularity (e.g. once before dispatching each
  piece's transform batch) to avoid doing more or less speculative work before honoring
  cancellation than the current serial loop does.
- Cache interaction: calls into `transformCollisionGeometry` (PAR-CACHE-01's namespace).
- Risk class: RC-A, RC-C, RC-E.
- Required tests: T-STD plus a cancellation-mid-piece test.
- Target Rust module: `capacity`.
- Verdict: **SAFE-CANDIDATE** (conditions: checkpoint granularity preserved; gated on Stage
  3 cache design for the `transformCollisionGeometry` calls it makes).

**PAR-CAPCORE-02 — Per-piece outer loop of preflight.** Priority: MEDIUM.
- Description: `minimumDoubledCollisionAreaSumGrid2` (sum, exact bigint), 
  `maximumSingletonSpanPressurePpm` (max), `singletonInfeasiblePieceIds` (append) computed
  per-piece in parallel and reduced serially by stable piece index.
- TS location: `intrinsicCapacityPreflight.ts:99-160`.
- Why independent: exact-bigint sum is associative and lossless (not the binary64 hazard
  class); max is associative.
- Stable-index scheme: ordinal = prepared-piece index.
- Reduction / comparator: sum/max reductions are order-independent; **but**
  `singletonInfeasiblePieceIds`'s *first* element is externally observable (becomes the
  reported `pieceId` in the `'singleton-transform-set-does-not-fit'` outcome,
  `intrinsicCapacityPreflight.ts:175-182`) — the reduction must explicitly re-sort/select by
  original prepared-piece index, never by completion order.
- Cancellation/budget interaction: inherits PAR-CAPCORE-01's per-transform checkpoint.
- Cache interaction: none directly at this layer.
- Risk class: RC-A for the sum/max; RC-D for the first-infeasible-piece-id report.
- Required tests: T-STD plus a two-infeasible-piece fixture asserting the reported
  `pieceId` is always the lower prepared-index piece at every thread count.
- Target Rust module: `capacity`.
- Verdict: **SAFE-CANDIDATE** (conditions: first-infeasible-id selection by stable index,
  not completion order).

**PAR-CAPCORE-03 — `transformedGridSpan`'s point-bbox reduction.** Priority: LOW.
- Description: trivial commutative min/max reduction over a small point set.
- TS location: `intrinsicCapacityPreflight.ts:236-254`.
- Why independent: min/max is associative.
- Stable-index scheme: n/a — polygon points are typically well under a hundred.
- Reduction / comparator: min/max, order-independent.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: `capacity`.
- Verdict: **NEEDS-MEASUREMENT** (reason: not worth it at this grain per the source
  document's own assessment; architecturally safe if ever needed, not a Stage 4 priority).

**PAR-CAPCORE-04 — `exactDoubledPolygonAreaGrid2`'s shoelace sum.** Priority: LOW.
- Description: exact bigint shoelace-term summation — associative and lossless, unlike an
  equivalent floating-point shoelace sum.
- TS location: `intrinsicCapacityMaterial.ts:28-34`.
- Why independent: exact bigint arithmetic; order does not affect the result at all (a
  genuinely different property from the binary64 RC-F hazard elsewhere in this document).
- Stable-index scheme: n/a — per-ring point counts are small.
- Reduction / comparator: sum, fully order-independent.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A (notably *not* RC-F, despite superficially resembling PAR-CGRID-04 — this
  is the one site in the whole inventory where a parallel tree-reduction sum is provably
  bit-identical to the serial sum, because the arithmetic is exact bigint, not binary64).
- Required tests: T-STD only.
- Target Rust module: `capacity`.
- Verdict: **NEEDS-MEASUREMENT** (reason: not a meaningful target on its own at typical
  per-ring point counts; recorded because the associativity property is genuinely useful to
  know if this ever needs to scale up).

**PAR-CAPCORE-05 — q0/q90 orientation evaluations in `materializeIntrinsicCapacityEndpoint`.**
Priority: MEDIUM.
- Description: exactly two independent units of work
  (`withQuarterTurnBottomLeft(0)`/`withQuarterTurnBottomLeft(90)`, each followed by legality
  check, identity, and hashing), pushed into an array and resolved only afterward via a full
  sort.
- TS location: `intrinsicCapacityEndpoint.ts:182-198` (evaluation), `:199-202` (sort).
- Why independent: no early-exit/first-wins logic; both are always computed today.
- Stable-index scheme: ordinal 0 (`q0`), 1 (`q90`) — fixed, not completion order.
- Reduction / comparator: full sort at `:199-202`, applied serially after both complete.
- Cancellation/budget interaction: none observed at this specific site.
- Cache interaction: none directly.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: `capacity`.
- Verdict: **SAFE-CANDIDATE** (no additional conditions — merge by stable index `0` then
  `90`, requires no chronology changes).

**PAR-CAPCORE-06 — Endpoint materialization across independent beam-frontier entries.**
Priority: HIGH (directly downstream of the capacity-search depth loop's hottest per-depth
work).
- Description: each `entry` in `beam` processed independently
  (`materializeIntrinsicCapacityEndpoint` call, then a dedup-map write).
- TS location: `intrinsicCapacitySearch.ts:939-968` (loop structure owned by the
  capacity-search cluster; the pure payload is owned by capacity-core).
- Why independent: this cluster's functions (PAR-CAPCORE-05 and its dependencies) are
  exactly the pure, parallelizable payload; the loop shape itself belongs to
  capacity-search.
- Stable-index scheme: ordinal = position in `beam`.
- Reduction / comparator: `compareIntrinsicCapacityEndpoints`/`compareIntrinsicCapacityObjectives`
  (`intrinsicCapacityEndpoint.ts:289-347`), applied via the existing dedup-map-then-`.toSorted`
  serial pipeline.
- Cancellation/budget interaction: inherits the depth-loop's own checkpoint (see
  PAR-CAPSEARCH's "must stay serial" notes, §4).
- Cache interaction: none new beyond PAR-CAPCORE-05's.
- Risk class: RC-A, RC-D (dedup-map ordering).
- Required tests: T-STD plus the standard dedup-by-stable-index test.
- Target Rust module: `capacity`.
- Verdict: **SAFE-CANDIDATE** (conditions: dedup-map insertion replayed serially by stable
  ordinal after parallel materialization, matching PAR-CAPCORE-02's pattern — flagged by
  `capacity-core.md` §13 as "a strong Rayon candidate for a future cross-cluster
  optimization").

### 3.8 Capacity search (anytime beam)

**PAR-CAPSEARCH-01 — Per-transform candidate generation and scoring within one beam entry.**
Priority: HIGH. Same physical site as PAR-SCORE-03, documented independently by
`capacity-search.md` §13 with the loop-owner's perspective.
- Description: for a fixed beam entry and fixed piece, each transform's
  `geometryKernel.transformCollisionGeometry` + `nfpIfpService.generatePlacementCandidates` +
  per-candidate `evaluateCandidate` work.
- TS location: `intrinsicCapacitySearch.ts:590-686`.
- Why independent: pure function of `(entry, piece, transform)`.
- Stable-index scheme: ordinal = `(transform index, candidate index)` within the
  transform-sorted, candidate-generation order.
- Reduction / comparator: `compareScoredCandidateReferences`/`compareContactCandidateReferences`.
- Cancellation/budget interaction: **the per-depth/global evaluation-quota short-circuit
  currently depends on sequential consumption order across transforms and candidates**
  (`consumedAtDepth`/`consumedPlacementEvaluations` checked and incremented per-candidate, in
  transform-sorted order). A parallel version must either (a) pre-reserve a stable evaluation
  budget per transform deterministically before dispatch, matching the exact sequential
  consumption count each transform would have used, or (b) run the full unbounded candidate
  evaluation in parallel and re-impose the cap via a deterministic serial reduction pass
  afterward. Either approach must reproduce the exact same
  `evaluated`/`invalidCandidates`/`fitRejectedCandidates` counts and the exact same **set**
  of evaluated candidates as the current sequential early-exit — a nontrivial re-derivation,
  not a free parallelization.
- Cache interaction: `transformCollisionGeometry` + `nfpIfpService` calls — PAR-CACHE-01's
  namespace.
- Risk class: RC-C, RC-E.
- Required tests: T-STD plus an exact-cap-boundary fixture (a case tuned to exhaust
  `placementEvaluationQuotaPerDepth` mid-transform) asserting identical `evaluated`/
  `invalidCandidates`/`fitRejectedCandidates` counts and identical evaluated-candidate set at
  every thread count.
- Target Rust module: `capacity` + `search`.
- Verdict: **SAFE-CANDIDATE** (conditions: exact reproduction of (a) or (b) above, proven by
  the cap-boundary fixture; gated on Stage 3 cache design for the geometry/NFP calls it
  makes).

**PAR-CAPSEARCH-02 — `compareTopology`'s per-entry topology-measurement population.**
Priority: MEDIUM.
- Description: once the `measuredSurvivors` set for a depth is fixed, computing
  `measureCanonicalLayoutTopologyExact` for each distinct entry is embarrassingly parallel.
- TS location: `makeCapacityTopologyMeasurements`, `intrinsicCapacitySearch.ts:1976-2001`.
- Why independent: pure function of one entry's placed geometries, memoized by identity.
- Stable-index scheme: ordinal = position in the fixed `measuredSurvivors` vector.
- Reduction / comparator: none for population itself; the five serial sort comparators in
  `retainCapacityCohesionFrontier` (`:1881-1964`) consume the populated memo afterward and
  must remain serial/ordered reductions.
- Cancellation/budget interaction: none observed at the memo-population layer itself.
- Cache interaction: requires replacing the `Map`-based memo with a pre-sized,
  stable-index-keyed parallel-safe cache, since `retainCapacityCohesionFrontier` calls
  `topologyMeasurements.measure` from within five separate serial sort comparators that must
  all observe the same memoized values.
- Risk class: RC-E.
- Required tests: T-STD plus a test asserting the five sort comparators produce identical
  frontier retention at every thread count once the memo is pre-populated.
- Target Rust module: `capacity`.
- Verdict: **SAFE-CANDIDATE** (conditions: memo population happens fully, in parallel, by
  stable index, strictly *before* any of the five serial sorts begins reading it — never
  interleaved).

**PAR-CAPSEARCH-03 — Independent `evaluateCandidate` calls within one transform's
`legalCandidates`, once the quota-slice is fixed.** Priority: HIGH (same underlying work as
PAR-SCORE-03/PAR-CAPSEARCH-01; listed separately because the source document frames it as
its own bullet with a narrower precondition).
- Description: pure, stateless, indexable-by-ordinal candidate evaluation once the admitted
  subset for a transform's evaluation-quota slice is deterministically fixed.
- TS location: `intrinsicCapacitySearch.ts` (same loop as PAR-CAPSEARCH-01).
- Why independent: pure given the pre-fixed admitted subset.
- Stable-index scheme: ordinal = candidate index within the pre-fixed admitted subset.
- Reduction / comparator: same as PAR-CAPSEARCH-01.
- Cancellation/budget interaction: **subsumed by PAR-CAPSEARCH-01** — this site only exists
  once the quota-slice has already been deterministically fixed by that site's condition (a)
  or (b).
- Cache interaction: same as PAR-CAPSEARCH-01.
- Risk class: RC-A once the precondition holds.
- Required tests: covered by PAR-CAPSEARCH-01's tests.
- Target Rust module: `capacity` + `search`.
- Verdict: **SAFE-CANDIDATE** (conditions: strictly a corollary of PAR-CAPSEARCH-01;
  implement together, not separately).

### 3.9 Complete construction (strict decoder / gap regions / family portfolio)

**PAR-STRICT-01 — Per-candidate scoring (`scoreCandidate` + gap-containment test).**
Priority: HIGH (14.4% search/decoders share).
- Description: `scoreCandidate` and the gap-containment test it triggers
  (`candidateContainedInIntrinsicGap`) — pure function of `(state, piece, moving, candidate,
  remainingPreparedPieces, transformFamily, movingCollisionAreaMm2/Grid2, gapRegions,
  timingNow)`, with no shared mutable state except the optional phase-timing accumulator
  (trivially made per-candidate and summed serially afterward).
- TS location: `intrinsicStrictDecoder.ts:1394-1498`; gap test at `:1465-1467`.
- Why independent: pure given its full input tuple.
- Stable-index scheme: ordinal = `(transform, candidate)` pair within the already-known
  `legalCandidates` array.
- Reduction / comparator: the existing serial fold (`intrinsicStrictDecoder.ts` §5 items 3-4,
  §6.2 in `strict-decoder-gap-family.md`) over results **in original ordinal order**, to
  reproduce Map-insertion-order tie behavior exactly.
- Cancellation/budget interaction: the evaluation cap must be re-expressed as "score the
  first `min(remainingBudget, legalCandidates.length)` candidates of this transform in
  parallel, then serially fold and consume budget in order, truncating the fold — never the
  scoring — at the cap." Scoring extra candidates that get discarded by the serial fold is
  acceptable **only if** it does not change `candidateEvaluationCount` accounting or the
  identity of the discarding point — the serial fold, not the parallel scoring, must be the
  sole authority for what counts as "evaluated."
- Cache interaction: `generatePlacementCandidates`/`transformCollisionGeometry` calls happen
  once per (piece, transform) — any parallelization here multiplies concurrent pressure on
  the shared NFP/IFP and geometry caches; must be co-designed with Stage 3 (§9 constraint,
  `strict-decoder-gap-family.md` §13.3).
- Risk class: RC-C, RC-D, RC-E.
- Required tests: T-STD plus the exact-cap-boundary fixture pattern from PAR-CAPSEARCH-01,
  applied to the strict-decoder's own evaluation cap.
- Target Rust module: proposed `complete` (see §7 — no exact skeleton match today).
- Verdict: **SAFE-CANDIDATE** (conditions: serial fold is sole evaluation-count authority;
  co-designed with Stage 3 cache architecture).
- Implementation status (2026-08-01): **RETAINED**. The Rust strict decoder computes the
  exact admitted prefix serially with the original partial-order cap semantics, including NaN
  and positive infinity, then assigns stable source ordinals and scores through the installed
  job-owned Rayon pool in bounded 32-candidate chunks. The coordinator replays each complete
  chunk in source order before dispatching the next, so only one bounded result chunk and its
  retained beam states remain live. No installed pool means ordinary serial iteration rather
  than a global-Rayon fallback. Timing capture and injected clocks also retain the original
  serial path. Tests compare the injected-clock serial authority against no-timing execution at
  threads 1, 2, 4, and 8 for every recorded decoder mode, finite cap boundaries, checkpoint
  chronology, evaluation counts, truncation, trace, gap-fill evidence, and canonical occupied
  geometry. A focused chronology test also proves the next scoring chunk cannot start before
  coordinator replay finishes for the current chunk. Two independent real N-API Mixed-61
  batches measured repeatable multi-thread improvement with comparable peak RSS. See
  `evidence/performance-report.md` for the exact final samples, durable provenance, diagnostic
  local evidence, and authority limits.

**PAR-STRICT-02 — `deriveCanonicalIntrinsicGapRegions` per-piece invocation.** Priority: LOW.
- Description: reads a fixed `state.placedCollisionGeometries` snapshot, produces a
  read-only result consumed by every subsequent transform/candidate in that piece.
- TS location: `intrinsicStrictDecoder.ts:568`.
- Why independent: already effectively "compute once per piece" in the existing code.
- Stable-index scheme: n/a — one computation per piece already.
- Reduction / comparator: n/a.
- Cancellation/budget interaction: none additional.
- Cache interaction: none beyond the geometry it reads.
- Risk class: RC-A.
- Required tests: none beyond existing coverage.
- Target Rust module: proposed `complete`.
- Verdict: **NEEDS-MEASUREMENT** (reason: no further parallelization opportunity exists
  *within* one piece's gap-region computation without descending into Clipper2 internals,
  which is out of this cluster's scope per its own characterization).

**PAR-STRICT-03 — `selectIntrinsicStrictCompletedParetoFront`/`rankIntrinsicStrictCompletedLayouts`
pairwise dominance checks.** Priority: MEDIUM.
- Description: the O(n²) `layouts.some(other =>
  intrinsicStrictCompletedLayoutDominates(other, candidate))` inner loop over an already-
  fully-known, already-finished list.
- TS location: `intrinsicStrictDecoder.ts:2274-2279`, `:2296-2301`.
- Why independent: pure pairwise comparison over an already-finished list — no
  chronology dependency once the list exists.
- Stable-index scheme: ordinal = position in the input array.
- Reduction / comparator: compute the full dominance matrix (or per-candidate "is dominated"
  boolean) in parallel, indexed by stable position, **followed by** the existing serial
  peeling/ordering logic applied to the resulting frontier set exactly as today.
- Cancellation/budget interaction: none — the input list is already fully materialized
  before this runs.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: proposed `complete`.
- Verdict: **SAFE-CANDIDATE** (no additional conditions — "an excellent Rayon target" per
  the source document).

**PAR-STRICT-04 — `groupIntrinsicCollisionFamilies` key computation.** Priority: MEDIUM.
- Description: `intrinsicCollisionFamilyKey`, including the O(n)-per-piece
  `canonicalCyclicPolygonKey` cyclic-variant enumeration.
- TS location: `intrinsicStrictFamilyPortfolio.ts:514-528`.
- Why independent: pure per piece, independent across pieces.
- Stable-index scheme: ordinal = original piece position.
- Reduction / comparator: the existing serial first-occurrence grouping fold, applied over
  the precomputed keys in original order.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A, RC-D (first-occurrence grouping).
- Required tests: T-STD plus a duplicate-key fixture asserting first-occurrence-in-original-
  order grouping at every thread count.
- Target Rust module: proposed `complete`.
- Verdict: **SAFE-CANDIDATE** (conditions: keys computed in parallel by original piece
  position; grouping fold stays serial afterward).

### 3.10 Periodic cells and periodic family portfolio

**PAR-PERIOD-01 — Crop enumeration across `(rows, traversal, corner)` combinations.**
Priority: MEDIUM (part of the 14.4% search/decoders share).
- Description: each combination is a fully independent, pure computation given
  `(cell, familyMembers)`; the exact instance migration-prompt §14.1 names directly
  ("independent periodic-cell candidate evaluation with stable catalog indices").
- TS location: `enumerateIntrinsicPeriodicCellCrops`, `CELLS:707-809`.
- Why independent: builds its own fresh `placed` array per combination; only interacts with
  outer scope by pushing into `candidates`/`identities` on success.
- Stable-index scheme: enumerate the exact same ordered list of `(rows, traversal, corner)`
  ordinals serially first, matching `CELLS:726-730`'s triple loop exactly.
- Reduction / comparator: evaluate each ordinal's candidate in parallel, then **replay the
  original ordinal order serially** to perform the `identities.has(...)` first-write-wins
  dedup and build `candidates` in the documented order — "first triple-loop iteration to
  reach a given canonical identity wins" is order-sensitive and must be resolved after the
  parallel phase.
- Cancellation/budget interaction: none observed at this specific enumeration.
- Cache interaction: none directly (invokes NFP/legality machinery owned by other clusters).
- Risk class: RC-D.
- Required tests: T-STD plus a two-combination-same-identity fixture asserting first-ordinal
  wins at every thread count.
- Target Rust module: proposed `periodic` (see §7).
- Verdict: **SAFE-CANDIDATE** (conditions: ordinal enumeration serial-first, parallel
  evaluation, serial dedup replay).

**PAR-PERIOD-02 — `deriveEdgeContactBasisCandidates`'s 4-level relation-discovery loop.**
Priority: MEDIUM.
- Description: for a fixed `members` array, each `(fixedMemberIndex, movingMemberIndex,
  fixedEdge, movingEdge)` combination independently computes candidate vectors and calls
  `validateEdgeContactRelation`, self-contained per call.
- TS location: `CELLS:1257-1312`.
- Why independent: each call builds its own `placed` array from `members` each time.
- Stable-index scheme: ordinal = `(fixedMemberIndex, movingMemberIndex, fixedEdge,
  movingEdge, candidateIndex)` tuple, in the fixed nested-loop enumeration order.
- Reduction / comparator: max-by-length-then-min-by-key fold into `relations: Map` — **not**
  simply commutative for ties, but the tie-break compares `edgeContactProvenanceKey(...)`
  lexicographically, which is well-defined regardless of fold order. A parallel map-reduce
  with a deterministic per-key combine function is safe here, unlike PAR-PERIOD-01's dedup
  (which depends on encounter order, not just key comparison).
- Cancellation/budget interaction: none observed at this specific loop.
- Cache interaction: none directly.
- Risk class: RC-A (the tie-break is a true total order, not encounter-order-dependent).
- Required tests: T-STD plus a tie-break property test comparing serial vs. parallel-fold
  results for a synthetic multi-candidate-same-length fixture.
- Target Rust module: proposed `periodic`.
- Verdict: **SAFE-CANDIDATE** (no additional conditions — the source document explicitly
  distinguishes this from the encounter-order-dependent dedups elsewhere in the cluster).

**PAR-PERIOD-03 — Per-representative-transform P1 cell derivation.** Priority: MEDIUM.
- Description: each transform representative's `deriveCells` call is independent of every
  other representative's.
- TS location: `CELLS:426-444`.
- Why independent: no shared mutable state between iterations other than
  `rejected`/`rejectedSamples` accumulators, which are pure appends.
- Stable-index scheme: ordinal = representative-transform index.
- Reduction / comparator: reconstruct accumulators from stable-ordinal-indexed parallel
  results, folded serially afterward, preserving the documented 8-sample-per-call/32-sample-
  per-family caps by replaying in original order.
- Cancellation/budget interaction: caps enforced by the serial replay, not the parallel
  compute.
- Cache interaction: none directly.
- Risk class: RC-A, RC-D (accumulator replay).
- Required tests: T-STD plus a cap-boundary fixture for the 8/32-sample limits.
- Target Rust module: proposed `periodic`.
- Verdict: **SAFE-CANDIDATE** (conditions: accumulator caps enforced by serial replay in
  original representative order).

**PAR-PERIOD-04 — Per-pair P2 enumeration's outer `(firstIndex, secondIndex)` loop body,
pure work only.** Priority: MEDIUM, but genuinely high-risk in practice per the source
document's own framing.
- Description: the pure NFP/legality/cell-derivation work per `(firstIndex, secondIndex)`
  pair is independent.
- TS location: `CELLS:448-502`.
- Why independent (pure part only): no shared mutable state within one pair's pure geometry
  work.
- Stable-index scheme: a cheap, sequential pre-pass first computes the exact serial
  attempt-count/truncation point (see next line), then ordinals are assigned only to pairs
  that pre-pass determines would have been attempted.
- Reduction / comparator: none beyond ordinal collection of the attempted pairs' results.
- Cancellation/budget interaction: the shared `enumeratedPairCount`/`pairCoverageComplete`/
  `runtimeCoverageComplete` budget counters and wall-clock deadline checks are interleaved
  throughout the current loop; `enumeratedPairCount += 1` happens unconditionally per pair
  *before* its offsets are even computed (`CELLS:460`) — the counting and early-termination
  behavior is genuinely chronology-bound. A safe design must precompute the exact serial
  attempt-count/truncation-point first (a cheap sequential pass), then parallelize only the
  pure work for pairs that would have been attempted — never let parallel pairs race the
  truncation decision itself.
- Cache interaction: none directly.
- Risk class: RC-C, RC-G.
- Required tests: T-STD plus a deadline/pair-cap-boundary fixture proving identical
  `enumeratedPairCount`/`pairCoverageComplete`/`runtimeCoverageComplete` at every thread
  count.
- Target Rust module: proposed `periodic`.
- Verdict: **SAFE-CANDIDATE** (conditions: mandatory serial pre-pass to fix the attempted-pair
  set before any parallel dispatch — "good candidate in principle, high-risk in practice" per
  the source document, do not implement without the pre-pass).

Two further periodic-cluster items are explicitly **FORBIDDEN**, not merely conditional, and
are recorded in §5 rather than as sites here: the continuation-execution loop's shared,
monotonically-shrinking wall-clock budget (`PORTFOLIO:301-392`), and the `winner`
selection-by-execution-order `find` over `runs` (`PORTFOLIO:398-402`).

### 3.11 Shared archive

**PAR-ARCH-01 — `requestedSheetFit`'s `fit(0)`/`fit(90)` computations.** Priority: LOW/MEDIUM
(runs once per completed endpoint, not per candidate).
- Description: two fully independent pure reads of the same immutable `state` snapshot.
- TS location: `intrinsicSharedArchivePortfolio.ts:704-705`; two-key sort at `:713-717`.
- Why independent: no shared mutable state, no cache writes, no cancellation checks inside
  `fit`.
- Stable-index scheme: ordinal 0 (`q0`), 1 (`q90`) — fixed.
- Reduction / comparator: the two-key sort at `:713-717`, applied deterministically to the
  two ordinals in a fixed order.
- Cancellation/budget interaction: none inside `fit`.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: `archive`.
- Verdict: **SAFE-CANDIDATE** (no additional conditions).

**PAR-ARCH-02 — `retainRankedSharedArchive`'s per-endpoint `validate`/`identity` precompute.**
Priority: MEDIUM.
- Description: pure per-element `validate`/`identity` closures computed before the strictly
  serial Map insertion pass.
- TS location: `intrinsicSharedArchivePortfolio.ts:363-364, :362`.
- Why independent: pure per element.
- Stable-index scheme: ordinal = position in the input endpoint array.
- Reduction / comparator: map-then-serially-insert — the Map insertion pass itself **must**
  stay serial to preserve first-occurrence order (see §4 below); only the `validate`/
  `identity` precompute is parallel.
- Cancellation/budget interaction: none inside these closures.
- Cache interaction: none.
- Risk class: RC-A, RC-D (downstream insertion).
- Required tests: T-STD only.
- Target Rust module: `archive`.
- Verdict: **SAFE-CANDIDATE** (conditions: precompute only; the Map insertion pass itself is
  a separate, forbidden-to-parallelize step — see §5).

### 3.12 Reconstruction

**PAR-RECON-01 — Per-spec `intrinsicPreparedPieceClassKey` computation.** Priority: LOW
(reconstruction runs at most once, for a single named role, on the production path).
- Description: pure per-piece computation, used inside
  `intrinsicReconstructionEffectiveOrderKey`.
- TS location: `intrinsicReconstructionPortfolio.ts:548` (call site), `:551-582`
  (definition).
- Why independent: depends only on one piece's own fields.
- Stable-index scheme: ordinal = original piece array index within one spec's piece list.
- Reduction / comparator: serial join in original array order — computing all pieces' class
  keys for a given spec's piece list in parallel and then joining serially is safe and
  observably identical, *provided* the join step remains strictly ordered by original array
  index.
- Cancellation/budget interaction: none inside the key computation itself.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: proposed `reconstruction` (see §7).
- Verdict: **SAFE-CANDIDATE** (no additional conditions).

**PAR-RECON-02 — `buildCanonicalEndpointOrders`'s four `order(role)` calls.** Priority: LOW.
- Description: four independent pure functions of the same `positions` map and `pieces`
  array (`q0-ltr`, `q0-rtl`, `q90-ltr`, `q90-rtl`).
- TS location: `intrinsicReconstructionPortfolio.ts:418-423`.
- Why independent: each call only reads shared immutable data and produces its own
  independent `Vec`.
- Stable-index scheme: ordinal 0-3, fixed role order.
- Reduction / comparator: assemble the returned array in the fixed `[q0-ltr, q0-rtl, q90-ltr,
  q90-rtl]` order serially.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: proposed `reconstruction`.
- Verdict: **SAFE-CANDIDATE** (no additional conditions — fan-out width 4, low absolute
  value given reconstruction's single-role production usage, but explicitly safe).

**PAR-RECON-03 — `buildIntrinsicReconstructionSpecs`'s spec-list construction.** Priority:
LOW.
- Description: pure, side-effect-free spec-list construction.
- TS location: `intrinsicReconstructionPortfolio.ts:301-339`.
- Why independent: pure, no shared state.
- Stable-index scheme: n/a — single construction per call.
- Reduction / comparator: the final concatenation order (`:312-338`) must be preserved
  exactly for the serial spec loop that follows.
- Cancellation/budget interaction: none.
- Cache interaction: none.
- Risk class: RC-A.
- Required tests: T-STD only.
- Target Rust module: proposed `reconstruction`.
- Verdict: **NEEDS-MEASUREMENT** (reason: safe to construct off the hot path, but there is
  no meaningful workload here to parallelize — this is setup, not a Stage 4 target).

### 3.13 Compact Short Side

**PAR-SHORT-01 — Per-endpoint q0/q90 observation in `observeIntrinsicShortSideOrientations`.**
Priority: MEDIUM (part of the C7 Short Side benchmark case).
- Description: each `observeEndpoint` call is a pure function of `(sheet, endpoint,
  archiveIndex, requestedLongAxis, requestedShortAxisMm)` with no shared mutable state.
- TS location: `intrinsicShortSideObserver.ts:161-169`.
- Why independent: no interaction with any other endpoint's evaluation.
- Stable-index scheme: ordinal = `archiveIndex`.
- Reduction / comparator: re-sort by `archiveIndex`-stamped results using the exact serial
  comparator (`compareEndpointObservations`/`compareOrientationObservations`,
  `short-side.md` §6.1-6.2) rather than trusting parallel completion order.
- Cancellation/budget interaction: the runtime-budget check (§10.1 in `short-side.md`) is
  currently a single post-hoc check on total elapsed wall time; parallelizing this loop
  changes the *wall-clock* elapsed time (likely shorter) but not the boolean 250 ms outcome
  in the vast majority of cases — a Rust port must still measure the same wall-clock boundary
  (start-to-finish of this stage), not sum of per-task time.
- Cache interaction: none directly.
- Risk class: RC-B, RC-G (budget measured against wall-clock boundary, not summed task
  time).
- Required tests: T-STD plus a boundary-timing fixture near the 250 ms threshold, run at
  every thread count, asserting the boolean outcome is thread-count-invariant (may require a
  deterministic injected clock for the differential test per migration-prompt §11's timing
  seam).
- Target Rust module: `short_side`.
- Verdict: **SAFE-CANDIDATE** (conditions: re-sort by `archiveIndex` with the exact serial
  comparator; wall-clock boundary measured start-to-finish of the stage, not per-task).

**PAR-SHORT-02 — Per-piece single-transform selection in `constructPairFold`.** Priority:
MEDIUM.
- Description: each piece's inner loop over `piece.transforms` to find the best pair-fold
  and shelf transform is independent across pieces.
- TS location: `intrinsicShortSidePairFoldObserver.ts:337-398`.
- Why independent: no shared state read besides the immutable `piece` itself, for the pure
  geometry computation (`geometryKernel.transformCollisionGeometry` call).
- Stable-index scheme: ordinal = `(piece, transform)` pair index.
- Reduction / comparator: serial fold of the counter/budget accounting in original order,
  after parallel pure-geometry computation only.
- Cancellation/budget interaction: the loop increments the shared
  `runtime.transformEvaluations` counter and checks `boundedStatus` **inside** the
  per-transform loop (`:341-354`) — parallelize only the pure geometry computation; counter
  increment and budget-check timing must be reconstructed serially by stable index
  afterward.
- Cache interaction: `transformCollisionGeometry` — PAR-CACHE-01's namespace.
- Risk class: RC-C, RC-E.
- Required tests: T-STD plus a budget-boundary fixture proving identical
  `runtime.transformEvaluations` counts and identical `boundedStatus` transitions at every
  thread count.
- Target Rust module: `short_side`.
- Verdict: **SAFE-CANDIDATE** (conditions: pure geometry only in parallel; counter/budget
  accounting reconstructed serially by stable index).

**PAR-SHORT-03 — Contact-score computation across already-placed pieces in
`candidateContactAxisUnits`.** Priority: MEDIUM.
- Description: the loop over `placed` pieces for one candidate is a pure, read-only
  reduction (sum of `axisUnits`, boolean-or of `positiveContactCount` increments) with a
  cooperative checkpoint inside it.
- TS location: `intrinsicShortSideContactStrip.ts:657-706`; checkpoint at `:676-693`.
- Why independent: pure per-placed-piece contact test.
- Stable-index scheme: ordinal = placed-piece index within one candidate's evaluation.
- Reduction / comparator: sum/boolean-or reduction — safe to parallelize the pure
  per-placed-piece contact test with a serial reduction.
- Cancellation/budget interaction: **only if** the deadline/memory-cap checkpoint boundary is
  preserved at the same logical granularity (checked at least once per outer candidate
  evaluation, not silently removed by fusing the whole reduction into one uninterruptible
  parallel task). This checkpoint exists specifically to bound worst-case O(n²)
  candidate-vs-placed scans on large inputs.
- Cache interaction: bridges to an NFP-service checkpoint (`short-side.md` §10.3).
- Risk class: RC-C, RC-F (the `axisUnits` sum is a binary64 accumulation — verify
  associativity assumption against `short-side.md` §7 before treating the sum as free to
  reassociate; if it is a plain `Number` sum, treat as RC-F and fold serially).
- Required tests: T-STD plus a large-`placed`-count fixture proving the checkpoint still
  fires at the same logical granularity under parallel execution.
- Target Rust module: `short_side`.
- Verdict: **SAFE-CANDIDATE** (conditions: checkpoint granularity preserved at least once
  per outer candidate; sum fold verified serial if binary64).

### 3.14 Cross-cutting sites (not owned by one cluster)

**PAR-XCUT-01 — Canonical-key component computation with serial byte assembly.** Priority:
HIGH (12.9% "beam-state canonical keys" share — the single largest CPU-time category with no
dedicated safe site named above; this is the general pattern migration-prompt §14.1 names
directly: "independent canonical-key component computation with serial byte assembly").
- Description: per-piece or per-segment key *components* (coordinate strings, ring
  canonicalization fragments) computed independently, then assembled into the final key
  string strictly serially, in the exact TS concatenation order.
- TS location: distributed across `irregularBeamState.ts` (canonical occupied-geometry keys,
  `search-scoring.md` §8.1), `canonicalGridContact.ts`/`convexPolygonContact.ts` (structural-
  contact-signature strings, `canonical-grid.md` §6), `intrinsicStrictDecoder.ts`
  (`intrinsicStrictCanonicalJson`, `strict-decoder-gap-family.md` §8.1),
  `intrinsicReconstructionPortfolio.ts` (`canonicalPointRing`, `intrinsicPreparedPieceClassKey`,
  `reconstruction.md` §8.2-8.3).
- Why independent: each component (one ring's point-string, one piece's coordinate pair, one
  contact's signature fragment) is a pure function of its own local input.
- Stable-index scheme: ordinal = component position in the final assembled string (piece
  index, ring-point index, or segment index depending on the specific key).
- Reduction / comparator: **strict serial concatenation in the exact original order** — this
  is not a sort, it is byte assembly; any reordering changes the key's bytes and therefore
  every downstream hash/comparison that consumes it. No component-level parallelism is safe
  unless the assembly step is proven to remain byte-identical to serial assembly.
- Cancellation/budget interaction: none typically at the key-construction layer itself.
- Cache interaction: canonical keys often serve as cache keys elsewhere (PAR-CACHE-02); do
  not conflate key *construction* parallelism with cache *lookup* parallelism.
- Risk class: RC-B (many of these keys feed a downstream stable sort using the key as a
  tie-break, e.g. `localeCompare`/default-string-sort distinctions catalogued exhaustively in
  `js-semantics-audit.md` and per-cluster §5/§6 sections — the *sort* comparator choice,
  locale-vs-default, must be preserved per site, not unified).
- Required tests: T-STD plus a byte-identical-key differential test (Rust key bytes vs. TS
  key bytes) at every thread count, for every canonical-key construction site touched by a
  Stage 4 change.
- Target Rust module: distributed — `search` (beam-state keys), `canonical_grid` (contact
  signatures), proposed `complete` (strict-decoder canonical JSON), proposed `reconstruction`
  (piece-class keys).
- Verdict: **NEEDS-MEASUREMENT** (reason: this is a real pattern with real CPU share, but
  because it is distributed across many distinct key constructions rather than one function,
  each concrete instance needs its own targeted measurement and its own byte-identical
  differential test before being enabled — treat this entry as a checklist item for Stage 4
  planning, not a single implementable site).

**PAR-XCUT-02 — Error selection under a parallel candidate batch.** Priority: n/a (a
correctness constraint on every other site, not a standalone performance target).
- Description: today, because `computeIrregularNesting` and everything it calls is built
  from sequential generators, at most one of the 17 tagged error classes is ever "in flight"
  at a time, and error provenance is inherently "first sequentially-encountered failure in
  program order." If any site above is parallelized and two parallel units of work would
  independently raise different errors, the *chosen* winner's error identity becomes
  observable.
- TS location: `errors-protocol.md` §13 (horizontal finding, no single file:line).
- Why independent: n/a — this is a constraint, not a candidate.
- Stable-index scheme: whatever ordinal scheme the parallelized site already uses.
- Reduction / comparator: "first ordinal, not first thread to finish" must be the winning
  failure, per migration-prompt §14.3.
- Cancellation/budget interaction: n/a.
- Cache interaction: n/a.
- Risk class: applies to every RC-C/RC-D site above.
- Required tests: a dual-failure fixture (two ordinals in the same parallel batch that would
  both fail with different error identities) for every SAFE-CANDIDATE site whose pure compute
  can raise a typed error (PAR-GEOM-01, PAR-CACHE-01, PAR-NFP-01/02/03, PAR-STRICT-01, and
  any capacity-core/capacity-search site that calls `transformCollisionGeometry`/NFP
  generation), asserting the lowest-ordinal error's identity and context always wins.
- Target Rust module: `boundary` (error mapping), enforced at each site's reduction step.
- Verdict: **SAFE-CANDIDATE** (this is a required condition attached to every other
  parallelized site that can fail, not an independent site of its own — no verdict of
  "implement this" applies standalone).

---

## 4. Clusters with no Rayon candidate

Five clusters produced **no** SAFE-CANDIDATE or NEEDS-MEASUREMENT site at all; their own §13
sections say so explicitly. Recorded here for completeness, since the task is to enumerate
every candidate site and these clusters' contribution is "we checked, there is none."

- **`checkpoint-encoding.md`** — "This entire cluster is chronology-bound and must remain
  serial. There is no safe Rayon candidate anywhere in checkpoint construction, validation,
  or resume." The one nuance: `validateIntrinsicCapacityCheckpoint`'s frontier loop
  (`:1386-1493`) is *structurally* embarrassingly parallel per-entry, but shares a mutable
  `validationCavityCache` `Map` across iterations — explicitly deferred to "no earlier than
  Stage 3," not Stage 2. See §5 for the FORBIDDEN framing of checkpoint chronology itself.
- **`trace-history.md`** — the one theoretically-independent site
  (`selectedLayoutRevealSnapshots`, `computeIrregularNesting.ts:1659-1692`) is explicitly
  "too small to matter" (bounded by sheet capacity, tens to low hundreds of pieces) and the
  document's own recommendation is "keep serial." The live emission chain
  (`emitStateSnapshot`) is chronology-bound by explicit protocol contract (migration-prompt
  §15).
- **`worker-coordination.md`** — "this cluster is the wrong place to look for Rayon wins.
  Its job in a Rust port is to be a thin, deterministic, single-threaded orchestrator." Its
  one nominally-independent loop (piece preparation) is the *same* loop as PAR-GEOM-01,
  already counted there — not a second site.
- **`errors-protocol.md`** — `toIrregularWorkerFailure` runs once per job, at job end; "not a
  meaningful target for parallelization." Its real contribution is the cross-cutting
  constraint recorded as PAR-XCUT-02.
- **`tests-gates-inventory.md`** and **`aux-modules-liveness.md`** — the former documents
  gate-harness scripts that are deliberately kept sequential by policy (not a Rust algorithm
  concern at all: "prompt §3 forbids changing observable behavior... without an explicit
  ruling"); the latter documents modules with zero production importers (`portfolioSearch.ts`/
  `priorityOrderService.ts`/`windowedBeam.ts`, the overlap-relaxation/LNS family,
  `intrinsicPeriodicSmallFillE3.ts`, `intrinsicQueueBeamDiscriminator.ts`, the E5/E5.1 family,
  `intrinsicV7SeedArchive.ts`) — "not applicable: none of this cluster is scheduled to run in
  the Rust port." Any parallelism analysis for dead code is explicitly out of scope per that
  document's own headline finding (§0).

---

## 5. Forbidden boundaries (migration-prompt §14.2), mapped to concrete TS modules

Every bullet in migration-prompt §14.2 is reproduced below with the concrete TS module(s)
the characterization corpus traced it to, and the reason parallelizing it as an uncontrolled
cohort would violate migration-prompt §2/§10/§11/§12/§15.

| §14.2 category | Concrete TS module(s) | Mechanism observed | Rust implication |
| --- | --- | --- | --- |
| Complete versus capacity producer races | `computeIrregularNesting.ts::coordinateIntrinsicSharedArchive` (`:474-1240`), gating between `intrinsicSharedArchivePortfolio.ts` (complete) and `intrinsicCapacityMode.ts` (capacity) | Each stage's *input* is the previous stage's decided output — `preflight.kind` gates which sub-pipeline runs; `winner === undefined` gates whether capacity mode runs at all (`worker-coordination.md` §13) | Keep this dispatch a strict sequential decision tree in Rust; never race the two producer roles |
| Cold versus warm lane races | `intrinsicCapacityMode.ts::runProtectedCapacityLaneCoordinator` (`:467-999`) | Cold lane resolves first; warm pilot lanes run in `fittingDescriptors` order; the single warm-resume loop's budget is `basePlacementEvaluationCap - warmConsumedPlacementEvaluations`, a function of the *actual measured* consumption of every prior step (`capacity-core.md` §13) | Preserve the exact cold → warm-pilot → warm-resume → quality sequencing; budgets must be computed from real prior-step consumption, not estimated ahead of time |
| Direct producer roles whose chronology affects scheduler traces | `intrinsicSharedArchivePortfolio.ts` (canonical-grid, legacy-absolute-envelope, open-pocket-first roles), `computeIrregularNesting.ts`'s `intrinsicAnytimeSchedulerTrace.quanta` | The canonical-grid role's per-piece-boundary checkpoint drives the interleaved capacity scheduler quantum via `onCanonicalGridCheckpointed` (`computeIrregularNesting.ts:650-703`); `docs/architecture/compact-architecture-explained.md` states "HARD CONSTRAINT: COMPACT IS SINGLE-PROCESS" (`shared-archive.md` §13) | Do not parallelize the three direct roles without an explicit new user instruction lifting the single-process constraint |
| Archive admission as tasks finish | `intrinsicSharedArchivePortfolio.ts::retainRankedSharedArchive` (`:355-380`), `intrinsicAnytimeArchive.ts::retainIntrinsicAnytimeArchiveNamespace` (`:37-46`) | First-occurrence-wins position and `selectDuplicate`'s `retained`-vs-`candidate` argument order both depend on encounter order (`shared-archive.md` §13) | Map-precompute is fine (PAR-ARCH-02); the Map insertion pass itself must stay serial in input order |
| Survivor selection as candidates finish | `intrinsicCapacitySearch.ts::retainCapacityCohesionFrontier` (`:1881-1964`), `intrinsicStrictDecoder.ts`'s per-candidate scoring loop (`:621-667`) | Both are documented "never let the first completed task win" sites | Serial reduction only, by the exact existing comparator, after full parallel scoring of an already-fixed candidate set |
| Checkpoint publication by completion order | `intrinsicCapacitySearch.ts` pause boundary (`:876-934`), `intrinsicStrictDecoder.ts::IntrinsicStrictDirectCheckpoint`, `intrinsicPlaceDeferCompleteShadow.ts` checkpoint, the `onCanonicalGridCheckpointed` interleave inside `intrinsicSharedArchivePortfolio.ts`'s `while (true)` loop (`:261-333`) | "The order in which these two independent producers' pause/resume cycles interleave is itself production behavior" (`checkpoint-encoding.md` §13) | Never run the capacity cold quantum and canonical-grid direct construction concurrently, even if each individually produces correct bytes |
| Depth transitions before all required ordered results exist | `intrinsicCapacitySearch.ts`'s outer depth `for` loop (`:522-935`) | "Each depth's beam is a function of the *previous* depth's retained beam... states from different piece depths never compete" (`capacity-search.md` §13, quoting the file's own doc comment at `:325-326`) | No parallelism across depths, ever; only within one depth's already-fixed candidate batch (PAR-CAPSEARCH-\*) |
| Short Side portfolio branches where first success currently has defined authority | `intrinsicShortSidePairFoldObserver.ts::constructPairFold`'s four-lane terminal portfolio (pair-fold/shelf → depth-first strip → contact-first strip → order continuations, `:319-762`) | Each later lane's runtime budget is "outer budget minus already-consumed time/RSS" — lane N's budget is a function of lanes `1..N-1`'s actual consumption (`short-side.md` §13.2) | Lanes must run strictly sequentially; only the pure geometry work *inside* one lane (PAR-SHORT-\*) may be parallelized |
| Cancellation or deadline checks at new eager positions | `IrregularNfpIfpControl.checkpoint(...)` call sites throughout `nfpIfpService.ts`, `intrinsicStrictDecoder.ts` (`:475-483,584`), `intrinsicCapacitySearch.ts`, `intrinsicShortSideContactStrip.ts` (`:676-693`), `intrinsicCapacityPreflight.ts:114` | Moving a check earlier/later changes which work, cache operation, ledger entry, checkpoint, or trace occurs before termination (migration-prompt §15, restated per-cluster throughout §9-10 sections) | Every SAFE-CANDIDATE site's card above states its specific checkpoint-preservation condition; do not introduce new suspension points |
| Mutable spatial-index updates | `placedCollisionSpatialIndex.ts::add()` | Current design is persistent/non-mutating (`add()` never mutates `self`) — this is a *reminder* boundary: if a future perf redesign ever makes `add()` in-place-mutating for cost reasons, this forbidden category applies immediately and PAR-VAL-06's SAFE-CANDIDATE verdict would need re-review | Keep `add()` persistent (return a new instance) in the Rust port; do not introduce in-place mutation to chase performance |
| Global trace append operations from Rayon workers | `decisionTrace.ts` event emission (dead for Compact/Compact Short Side today), `intrinsicAnytimeSchedulerTrace.quanta` append in `computeIrregularNesting.ts`, `nesting.worker.ts`'s frame-emission queue (`decisionTrace.ts`/`trace-history.md` §13) | "This is the clearest example... of 'cache/trace ordering is part of the contract, not an implementation detail'" (`worker-coordination.md` §13) | All trace/progress append operations happen on the single orchestrating thread, after Rayon work has been reduced to ordered results |

---

## 6. Dependency chain for Stage 3/4 sequencing

The site inventory is not independent of itself — several SAFE-CANDIDATE verdicts are
explicitly conditional on other sites landing first. This is the recommended sequencing,
derived from the conditions already stated per-site (not a new decision):

1. **Cache architecture (PAR-CACHE-03)** must land first. It gates PAR-CACHE-01,
   PAR-NFP-01, PAR-VAL-04, PAR-CAPCORE-01, PAR-CAPSEARCH-01, PAR-STRICT-01, PAR-SHORT-02 —
   the majority of the HIGH-priority sites in this document.
2. **Cheap ordinal-indexed sites with no cache dependency** can land independently of (1) and
   should be implemented and measured first as low-risk proof of the deterministic-parallel-
   pattern harness itself: PAR-GEOM-01, PAR-NFP-02, PAR-NFP-03, PAR-CGRID-01/02/03/04,
   PAR-VAL-02/03/05, PAR-CAPCORE-02/05/06, PAR-CAPSEARCH-02, PAR-STRICT-03/04, PAR-PERIOD-01/
   02/03/04, PAR-ARCH-01/02, PAR-RECON-01/02, PAR-SHORT-01/03.
3. **Persistent spatial-index redesign (PAR-VAL-06's precondition)** should land before
   attempting PAR-SCORE-05's sibling-fan-out, since PAR-SCORE-05 is the highest-value Stage 4
   target named across the corpus and depends on `add()` being cheap enough to parallelize
   profitably.
4. **PAR-XCUT-02's error-selection discipline** must be implemented as part of every site
   above that can fail, not bolted on afterward.
5. Every site, once implemented, must pass T-STD (§1.3) before being considered promotable
   per the performance contract's P7 (thread-count neutrality is itself a correctness gate,
   `performance-contract.md` §5).

---

## 7. Target Rust module gaps (open question for Stage 2 module layout)

The current crate skeleton (`crates/irregular-nesting-native/src/`) has these modules, all
empty stubs today: `archive`, `boundary`, `caches`, `canonical_grid`, `capacity`,
`checkpoints`, `clipper`, `geometry`, `nfp_ifp`, `result`, `search`, `short_side`, `trace`,
`transforms`, `validation`. Migration-prompt §21's suggested module list additionally names
"complete construction," "periodic construction," "reconstruction," "scheduler," and
"telemetry" as distinct semantic responsibilities — none of these has a matching top-level
directory yet. This document has cited proposed placements (`complete`, `periodic`,
`reconstruction`) for the strict-decoder/gap-region/family-portfolio cluster, the periodic
cluster, and the reconstruction cluster respectively, since those three clusters' work is
large enough and distinct enough from `search`/`archive`/`capacity` to warrant it — but this
is a proposal for the architecture document (migration-prompt §22 artifact #1), not a
decision this document is authorized to make on its own. Recorded as Open Question 1 below.

---

## 8. Open questions

1. **Module layout for `complete` (strict decoder), `periodic`, `reconstruction`,
   `scheduler`, and `telemetry`.** This document assumed `complete`, `periodic`, and
   `reconstruction` as new top-level modules (§7) for citation purposes. The orchestrator
   should confirm this against the forthcoming architecture document rather than treat this
   inventory as binding on module layout.
2. **`validatedRings` fingerprint memo (PAR-CACHE-04).** `geometry-caches.md` §13
   recommends *not* porting it as a literal shared cache, contingent on Rust's ownership
   model making the underlying hazard moot and on benchmark evidence that the O(n²)
   revalidation cost is not dominant post-port. This needs an explicit orchestrator ruling
   before a Stage 2/3 implementer treats it as free to drop, per that document's own
   closing caveat and per migration-prompt §2's "absolute semantic preservation" framing.
3. **Cache concurrency policy (PAR-CACHE-01/03).** Migration-prompt §13.3 lists five
   candidate architectures (sharded concurrent shared cache; shared read-mostly + per-thread
   front caches; per-key single-flight with immutable publication; phase-local precomputation
   + immutable lookup tables; hybrid by namespace) and explicitly forbids choosing one without
   targeted measurement. This inventory does not choose one — it is Stage 3's own artifact
   (the "cache and concurrency design document," migration-prompt §22 artifact #4) to decide,
   informed by the priority ranking in §2 above (NFP/IFP is 29.6% of Mixed-61 CPU time and
   should be measured first).
4. **`freeMaterialService.ts` (PAR-CGRID-06) and reconstruction's dead `.archive`/`.winner`
   fields (PAR-RECON-\* is about live code; the archive-ranking machinery in
   `retainIntrinsicReconstructionArchive` is separately dead per `reconstruction.md` §1.1).**
   Both are unit-tested and therefore must be ported for parity per migration-prompt §3, but
   neither should receive Stage 3/4 parallelization effort ahead of live-path work, per each
   source document's own recommendation. Confirm this prioritization is acceptable before
   Stage 4 planning locks in a work order.
5. **Loom (or equivalent model-checking) scope for cache primitives.** Migration-prompt
   §18.4 authorizes Loom "for isolated cache primitives... without forcing it into the whole
   geometry system." This document defers the exact primitive boundary to Stage 3's cache
   design document; recorded here so it is not silently dropped.
6. **PAR-SHORT-03's `axisUnits` sum associativity.** This card flags an unresolved question
   about whether the sum is a plain `Number` (binary64, RC-F, must fold serially) or an exact
   integer/bigint accumulation (RC-A, free to reassociate) — `short-side.md` §7 should be
   re-checked at Stage 4 implementation time to resolve this before choosing a fold strategy,
   since the two risk classes imply different Rust implementations.
