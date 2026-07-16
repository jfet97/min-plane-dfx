# Parallel Experiment Ledger

This document is a live review ledger for the isolated irregular-nesting
experiments. It records the goal, current evidence, review path, and remaining
proof for every worker. It is intentionally separate from `todo.md`, which is
the restart/scheduling handoff.

## Review convention

The primary checkout must remain untouched until an experiment is selected for
integration. Every implementation lives in a detached worktree under
`/private/tmp`.

Parallel profile runs are valid for deterministic legality and layout-score
comparison, but not for elapsed-time ranking: concurrent benchmark processes
compete for CPU and are continuously scheduled/descheduled. Treat every timing
number collected during this parallel phase as contention-contaminated. Only
the retained benchmark worker may make performance claims, using serialized,
alternating baseline/variant repeats on an otherwise idle machine.

For any worktree, start with:

```sh
git -C <worktree> status --short
git -C <worktree> diff --check
git -C <worktree> diff 232f274..HEAD
git -C <worktree> diff
```

The committed range contains the preserved checkpoint. The final plain
`git diff` is important because a worker may still have a deliberately
uncommitted last correction. Do not integrate an experiment merely because it
has a benchmark number: verify regression/parity coverage and inspect the
current diff.

## Mandatory result comparator

Elapsed time is not the primary definition of a better nesting result. Every
benchmark comparison must report the existing `IrregularLayoutScorer`
lexicographic quality fields alongside elapsed time:

1. `unplacedCount` — lower is better.
2. `largestNetFreeMaterialRegionAreaMm2` — higher is better: it measures the
   largest contiguous usable material region left on the sheet.
3. `freeMaterialRegionCount` — lower is better: fewer disconnected regions
   means less fragmentation.
4. `freeMaterialHoleCount` — lower is better.
5. `freeMaterialSliverMetric` — lower is better: it penalizes thin, awkward
   leftover regions.
6. collision-bound consumption/span/area criteria — lower is better, after
   free-material usability ties.

Therefore, legality and `unplacedCount` are hard acceptance gates. The exact
lexicographic score remains the diagnostic and deterministic tie-breaker, but
it is not by itself a performance veto: before rejecting a faster variant, the
score delta must be materially significant in the relevant sheet and geometry
resolution. Report exact deltas and both relative cost/quality effects so the
selection decision is explicit. The benchmark corpus must include cases where
two layouts place the same number of pieces but differ materially on
free-material usability and fragmentation; otherwise it cannot distinguish
search quality.

## Quality-gate coordination

Mill's first corpus milestone is the gate for interpreting every other
experiment. When it lands, resume or notify every completed worker and require
the mandatory score report against the new cases before describing any change
as an improvement, regression, or score-equivalent. Update this ledger after
each meaningful worker result with:

- the exact worktree/commit/diff under review;
- validation and benchmark command evidence;
- full layout-score comparison, not only elapsed time or placed count;
- any remaining correctness, parity, or benchmark-discrimination gap.

## Original internal-data experiments

### Einstein — NFP/IFP and transform internal DTOs

- **Agent:** `019f6af8-7a98-7103-b3ff-fe7dc0c2963b`
- **Worktree:** `/private/tmp/min-plane-dfx-nfp-transform`
- **Final isolated commit:** `4d7a836`, clean and rebased onto `0930854`.
- **Goal:** replace schema-class construction inside NFP/IFP generation,
  candidate enumeration, and transform geometry with structural records;
  restore schema classes only at public service adapters.
- **Changed implementation:**
  `src/workers/irregular/nfpIfpService.ts` and
  `src/workers/irregular/transformCollisionGeometry.ts`.
- **Rebased named-profile evidence:** checkpoint `4d7a836` rebases cleanly
  onto `0930854`; `pnpm lint:fix`, `pnpm typecheck`, and 36 focused geometry
  tests pass. Every named profile passes legality and has a byte-identical full
  score object, placement order, and unplaced-id order (`compare = 0`). Earlier
  elapsed values are contention-contaminated and invalid for performance
  ranking; Ramanujan must rerun this worktree serially.
- **Still unproven:** exact placement-coordinate parity was not captured as an
  explicit assertion. The full layout comparator now reports all numeric score
  fields, placement order, and unplaced-id order as identical (`compare = 0`)
  on the standard profile; review candidate-order/geometry tests before
  accepting that as broad coordinate parity. A single benchmark run is only a
  promising signal.
- **Review command:**
  `git -C /private/tmp/min-plane-dfx-nfp-transform diff 232f274..HEAD`, then
  `git -C /private/tmp/min-plane-dfx-nfp-transform diff` for the final line.
- **Serial evidence (complete):** alternating fresh-process medians confirm
  exact full-score/audit/portfolio parity with substantial savings: beam-1
  `249.22 → 176.48 ms` (`29.2%`), GA-lite `1721.11 → 1153.66 ms` (`33.0%`),
  full-GA `9676.39 → 6803.84 ms` (`29.7%`), and wide-beam
  `739.67 → 436.00 ms` (`41.1%`). Raw evidence:
  `/private/tmp/irregular-serialized-0930854-Einstein-rerun.log`. Sol reviewed
  the full ledger and recommended integration. The parity gate, lint,
  typecheck, and full suite (`425` tests) now pass in the primary checkout.

### Planck — trusted irregular service DTO handoffs

- **Agent:** `019f6af8-7d9a-7cc3-a199-23e12ca84558`
- **Worktree:** `/private/tmp/min-plane-dfx-service-dto`
- **Latest checkpoint:** `f4eb376` (handoff removal); implementation is still
  uncommitted in the worktree.
- **Goal:** remove `Schema.Struct`/schema decoding between already trusted
  irregular worker services while retaining schema ownership at untrusted
  boundaries.
- **Current diff:**
  `src/workers/irregular/collisionGeometryBuilder.ts`,
  `src/workers/irregular/services.ts`,
  `src/workers/irregular/transformGenerator.ts`,
  `tests/unit/irregularGeometryKernel.test.ts`,
  `tests/unit/transformGenerator.test.ts`, and
  `docs/architecture/irregular-v2-infrastructure.md`.
- **Reported final evidence:** baseline `4507.70 ms`, after `4699.23 ms`
  (`4.25%` slower); both `50 / 0` and audit passed. Lint/typecheck and 40
  focused tests pass; `git diff --check origin/main` is clean.
- **Interpretation:** it preserves the coarse placement result but currently
  has no speed gain. The full comparator is now equivalent (`compare = 0`) on
  the standard profile, but the isolated elapsed comparison was `5.32%` slower
  and remains noisy. Do not integrate until a discriminating corpus confirms
  the same non-regression and the boundary simplification is judged worthwhile.
- **Rebased named-profile evidence:** checkpoint `5bdc792` rebases cleanly onto
  `0930854`; all four profile audits and complete score/tie-break objects are
  exactly equal to baseline. The per-run timing differences are mixed and
  single-run only, so this remains a clarity refactor without a measured win.
- **Review command:** `git -C /private/tmp/min-plane-dfx-service-dto diff`.
- **Serial evidence (complete):** exact full-score/audit/portfolio parity, but
  no material speed result: beam-1 `250.60 → 250.15 ms`, GA-lite
  `1798.19 → 1807.46 ms`, full-GA `9640.44 → 9586.72 ms`, and wide-beam
  `742.61 → 736.27 ms`. Keep isolated unless the service-boundary clarity is
  independently worth its maintenance cost. Raw evidence:
  `/private/tmp/irregular-serialized-0930854-Planck-rerun.log`.

### Feynman — irregular beam, portfolio, and GA DTOs

- **Agent:** `019f6af8-7fb7-7f40-ad3a-322f3d79996e`
- **Worktree:** `/private/tmp/min-plane-dfx-irregular-search`
- **Latest checkpoint:** `64c4a28` (handoff removal); implementation remains
  uncommitted while the experiment continues.
- **Goal:** keep prepared pieces, placements, placed geometry, scores, and
  progress as plain records inside strict decoding, beam search, and portfolio
  search. Reconstruct schema-backed worker output only at the output adapter.
- **Current diff:**
  `computeIrregularNesting.ts`, `irregularBeamState.ts`,
  `irregularWorkerOutput.ts`, `portfolioSearch.ts`, `searchTypes.ts`,
  `strictPriorityDecoder.ts`, and `irregularLayoutScorer.test.ts` under
  `src/workers/algorithm/irregular/`.
- **Evidence so far:** baseline `4643.34 ms`, `50 / 0`, audit passed.
- **Current completion evidence:** the implementation passes lint,
  typecheck, and the full test run (43 files, 416 tests). Standard-profile
  layout comparison is exactly equivalent across every numeric score field and
  final ordering tie-breaker; elapsed difference is within one-run noise.
- **Still required:** rerun on Mill's discriminating profiles, then review the
  larger output-adapter/portfolio diff before integration.
- **Rebased named-profile evidence:** checkpoint `565f135` rebases cleanly onto
  `0930854`; all four profile audits and complete layout-score/tie-break
  objects are exactly equal to baseline. Single-run elapsed observations favour
  the variant by roughly `1%` to `11%`, but this is not a performance claim
  until repeated measurements and review confirm it.
- **Review command:** `git -C /private/tmp/min-plane-dfx-irregular-search diff`.
- **Serial evidence (complete):** exact full-score/audit/portfolio parity with
  only small mixed timing changes: beam-1 `248.37 → 239.60 ms`, GA-lite
  `1727.94 → 1707.89 ms`, full-GA `9590.42 → 9442.88 ms`, and wide-beam
  `745.89 → 749.78 ms`. This is not a compelling performance integration
  candidate. Raw evidence:
  `/private/tmp/irregular-serialized-0930854-Feynman-rerun.log`.

### Raman — MaxRects plain internals

- **Agent:** `019f6af8-8203-7a62-bad7-d85e7459bdd4`
- **Worktree:** `/private/tmp/min-plane-dfx-maxrects`
- **Review commits:** implementation `7544233`, handoff removal `5faa94a`.
- **Goal:** use plain internal placement/free-rectangle records and remove the
  redundant prepared-piece schema re-decode in rectangular MaxRects code.
- **Changed scope:** nine files, 146 additions and 72 deletions; the worktree
  is clean.
- **Reported evidence:** lint/typecheck pass and 46 focused rectangular tests
  pass. The irregular 50-piece benchmark was `4563.55 ms` before and
  `4728.66 ms` after; both were `50 / 0` and audit passed.
- **Interpretation:** no demonstrated speed benefit. The benchmark is not a
  direct MaxRects measurement, so integrate only if the cleaner boundary is
  independently valuable and a rectangular benchmark is added. It is
  score-equivalent on both the standard profile and the existing
  `angled-profile.dxf`/`star-5-point.dxf` profile: all nine numeric layout
  criteria match exactly and both audits pass. After rebasing onto `0930854`,
  it is also exactly score-equivalent on all four named capacity profiles,
  including final placement/unplaced-ID tie-break arrays. The detached rebase
  checkpoints are `31637c1` and `5e9986a`; profile timing differences remain
  single-run noise.
- **Review command:**
  `git -C /private/tmp/min-plane-dfx-maxrects diff 232f274..5faa94a`.
- **Serial evidence (complete):** exact full-score/audit/portfolio parity, but
  neutral-to-slower: beam-1 `268.39 → 272.48 ms`, GA-lite
  `1831.56 → 1862.74 ms`, full-GA `9785.98 → 9716.35 ms`, and wide-beam
  `748.12 → 752.14 ms`. Do not integrate for performance. Raw evidence:
  `/private/tmp/irregular-serialized-0930854-Raman-rerun.log`.

### Arendt — Clipper/free-material intermediates

- **Agent:** `019f6afd-311b-7883-9d89-5b9db9e664fd`
- **Worktree:** `/private/tmp/min-plane-dfx-free-material`
- **Review checkpoint:** `82980d010131333f3b15c646a29cc3cd43904165`.
- **Goal:** keep intermediate Clipper/free-material geometry plain; validate
  and construct schema classes only when producing external outputs.
- **Changed implementation:**
  `src/workers/irregular/clipper2OffsetAdapter.ts` and
  `src/workers/irregular/freeMaterialService.ts`.
- **Reported evidence:** baseline `4554.10 ms`, after `4546.40 ms` (`0.17%`
  lower); both `50 / 0`, audit passed. Lint/typecheck and 35 focused tests pass;
  diff check is clean. The worktree is clean and detached.
- **Interpretation:** correctness evidence is good, but performance evidence is
  neutral. The full standard-profile comparator is exactly equivalent, so this
  refactor is a boundary-clarity decision, not a quality or speed improvement.
  Review primarily for absence of accidental public-schema weakening.
- **Review command:**
  `git -C /private/tmp/min-plane-dfx-free-material diff 232f274..82980d0`.
- **Serial evidence (complete):** exact full-score/audit/portfolio parity with
  no material speed effect: beam-1 `250.72 → 248.01 ms`, GA-lite
  `1757.75 → 1766.00 ms`, full-GA `9649.04 → 9649.33 ms`, and wide-beam
  `745.71 → 750.05 ms`. Keep isolated unless boundary clarity alone justifies
  it. Raw evidence:
  `/private/tmp/irregular-serialized-0930854-Arendt-rerun.log`.

### Ramanujan — retained benchmark comparator

- **Agent:** `019f6acf-6bde-7600-a20c-eacb5dfd1cac`
- **Worktree:** `/private/tmp/min-plane-dfx-repro-20260716`
- **Current baseline:** clean at `0930854`.
- **Role:** benchmark comparison only; it should not implement production code.
- **Known high-budget GA result:** with 200 repeated pieces, 1000×750 sheet,
  GA population 12, generation budget 24, evaluation budget 288, and three
  minutes, it took `218524.33 ms` and placed `88 / 112`; audit passed and the
  run ended on the time budget. The standard beam+GA comparison took about
  `55.413 s` and also placed 88, so more time alone did not improve quality.
- **Provenance gap:** current serial logs must record baseline and variant SHA,
  Node/pnpm toolchain versions, host details, and runner version before future
  composition benchmarks are accepted.

## Search-quality and search-cost experiments

All nine workers below have been launched in independent detached worktrees.
At the time this ledger was written they were in setup/research/baseline stage.
Mill has now completed its first reporting/corpus milestone; its isolated diff
must be reviewed and integrated before the other workers can run the same named
profiles against their own worktrees.

### Ampere — prepared transform cache

- **Agent:** `019f6b08-850e-73f2-a33d-51afacfec726`
- **Worktree:** `/private/tmp/min-plane-dfx-prepared-transform-cache`
- **Goal:** cache each source piece × rotation × mirror collision polygon and
  bounds across beam/GA decodes. The cache key must include every geometry and
  transform setting that changes output.
- **Required proof:** hit/miss correctness tests, stable candidate/legality
  behavior, and a repeated-decode benchmark at meaningful scale.
- **Current result:** implementation and cache hit/miss plus strict/windowed
  parity tests are complete. Rebased checkpoint `9659b8a` passes lint,
  typecheck, 37 focused tests, and diff check. All four named profiles pass
  legality and have exact full-score/tie-break parity. Earlier elapsed values
  are invalid because they were collected concurrently; Ramanujan must rerun
  this worktree serially before performance selection.
- **Serial evidence (complete):** exact full-score/audit/portfolio parity, but
  no consistent gain: beam-1 `249.05 → 258.19 ms`, GA-lite
  `1747.06 → 1751.50 ms`, full-GA `10002.48 → 9812.35 ms`, and wide-beam
  `744.26 → 755.48 ms`. The cache is not a speed integration candidate yet.
  Raw evidence: `/private/tmp/irregular-serialized-0930854-Ampere-rerun.log`.

### Hubble — GA prefix-state cache

- **Agent:** `019f6b08-8805-7b40-a343-87d603b532e1`
- **Worktree:** `/private/tmp/min-plane-dfx-ga-prefix-cache`
- **Goal:** reuse immutable decoded prefix state when related GA chromosomes
  share an ordered prefix.
- **Required proof:** keys must encode semantically equivalent state only;
  no mutable state may leak across chromosomes; cancellation and budget
  semantics must remain intact. Benchmark GA with fixed seed and compare both
  time and layout quality.
- **Rebased named-profile evidence:** commit `46c4611` rebases onto `0930854`
  with all four audits and complete score/tie-break objects exactly equal to
  baseline. Timings are mixed (`+10.85 ms`, `-20.75 ms`, `-1033.86 ms`,
  `+22.27 ms`) across one run each, so this needs repeated GA-specific
  measurement before it can be called a cache win.
- **Serial evidence (partial):** Ramanujan used discarded one-process warmups
  followed by alternating `B1,V1,B2,V2,B3,V3` fresh-process measurements.
  Hubble is exact-score/audit equivalent. Accepted three-pair medians are
  `261.40 → 270.25 ms` for beam-1 and `1815.95 → 1829.53 ms` for GA-lite,
  making it slower on both completed profiles. Full-GA has only two pairs and
  wide-beam is not yet run, so neither has an accepted median. Raw log:
  `/private/tmp/irregular-serialized-0930854-Hubble.log`.
- **Invalid complete claim:** the attempted full-GA third pair had a failed
  variant sample followed by a duplicate baseline sample, so its reported
  `10092.00 → 9788.40 ms` median is not protocol-valid. Beam-1 and GA-lite are
  validly slower; wide-beam is also slower. Hubble remains rejected without a
  defensible full-GA speed result.

### Volta — placed-geometry spatial index

- **Agent:** `019f6b08-8a6b-79f3-b93f-7cfadb5fc059`
- **Worktree:** `/private/tmp/min-plane-dfx-spatial-index`
- **Goal:** test a deterministic persistent uniform grid for placed collision
  geometry before considering an R-tree, avoiding full scans during direct
  validation and NFP work.
- **Required proof:** candidate legality must be identical. Benchmark a
  nontrivial 100/200-piece case and attribute the saved work where possible.
- **Current result:** persistent uniform-grid indexing and exact
  validation/NFP prefiltering are implemented. Rebased checkpoint `2807e47`
  passes lint, typecheck, 83 focused tests, and diff check. Every named profile
  passes legality and has an exact complete-score/tie-break match. Do not use
  concurrent elapsed observations; Ramanujan must benchmark it serially.
- **Serial evidence (complete):** exact full-score/audit/portfolio parity.
  Beam-1 improves `266.28 → 250.82 ms` (`5.8%`), but GA-lite, full-GA, and
  wide-beam change by only `0.2%`, `0.6%`, and `0.7%`. This is a secondary
  candidate, not a broad cost reduction. Raw evidence:
  `/private/tmp/irregular-serialized-0930854-Volta-rerun.log`.

### Fermat — adaptive transforms

- **Agent:** `019f6b08-8d18-70d2-9fe2-d6bac939b7a1`
- **Worktree:** `/private/tmp/min-plane-dfx-adaptive-transforms`
- **Goal:** first try cheap orthogonal/configured transforms, then make derived
  angles or mirrors available only as deterministic placement repair under
  explicit settings.
- **Required proof:** fixed settings/seed must stay deterministic; every
  degree of freedom must be testable. Compare quality and cost against fixed
  transform-cap profiles.
- **Rebased named-profile evidence:** checkpoint `c69a4db` passes lint,
  typecheck, 427 tests, and diff check. All four named profiles pass legality
  and are exact full-score/tie-break matches. Its prior elapsed data is invalid
  because it was collected concurrently; serial timing is required.
- **Serial evidence (complete):** exact full-score/audit/portfolio parity but
  consistently slower: beam-1 `250.47 → 254.29 ms`, GA-lite
  `1794.75 → 1836.37 ms`, full-GA `9952.03 → 10296.96 ms`, and wide-beam
  `773.42 → 776.90 ms`. It is not an integration candidate. Raw evidence:
  `/private/tmp/irregular-serialized-0930854-Fermat-rerun.log`.

### Schrodinger — diversified deterministic GA seeds

- **Agent:** `019f6b08-8f75-7410-9536-c95a7c35790f`
- **Worktree:** `/private/tmp/min-plane-dfx-ga-seeds`
- **Goal:** seed GA from distinct deterministic order/profile variants while
  retaining a greedy incumbent that wider search cannot lose.
- **Required proof:** no uncontrolled randomness, incumbent protection tests,
  and fixed-seed quality/cost benchmarks across several profiles.
- **Current result:** seeded single/multi-gene diversity, deduplication, and
  greedy-incumbent protection are implemented with focused tests. On the easy
  standard profile both `seed-alpha` (`42068.95 ms`) and `seed-beta`
  (`45286.74 ms`) produce strictly worse GA tuples than the greedy baseline
  (`4506.29 ms`), chiefly by reducing largest free material and worsening
  fragmentation. Portfolio selection correctly retains the baseline. This is a
  safety success, not a quality improvement; named-corpus reruns remain
  required.
- **Rebased named-profile evidence:** commits `9b9a64f` and `d24cec7` pass
  lint, typecheck, focused portfolio/corpus tests, and diff check. Three
  profiles are exact score/tie-break matches, but `near-capacity-ga` is
  slightly lower at `largestNetFreeMaterialRegionAreaMm2` despite placing all
  pieces. This earlier exact-comparator observation is diagnostic only; the
  accepted serial result below establishes whether it is material.
- **Serial evidence (complete):** the full-GA run is faster
  (`9951.63 → 7908.92 ms`), but it reproducibly regresses the first differing
  score criterion after the `0` unplaced-count tie: largest net free material
  `53263.12593250008 → 53263.04887050009 mm²`. That deterministic quality
  delta is `0.07706199999 mm²` (about `0.00014%` of the region). This is
  negligible beside the `20.5%` full-GA median speedup and is therefore a
  performance candidate, not a rejected result. Other profiles are
  score-equivalent. Raw evidence:
  `/private/tmp/irregular-serialized-0930854-Schrodinger-rerun.log`.

### Pauli — memetic repair

- **Agent:** `019f6b08-920d-7d61-a93a-76e6fae1d639`
- **Worktree:** `/private/tmp/min-plane-dfx-memetic-repair`
- **Goal:** add bounded local repair around a beam/GA incumbent: order-window
  swaps/inserts and transform alternatives under configurable budgets.
- **Required proof:** legal and deterministic output; a hard feasible corpus
  case must show a strict comparator improvement before claiming quality gain.
- **Current standard-profile result:** repair is legal and exactly
  score-equivalent, but `29553.25 ms` versus `5138.72 ms` adds `24570.73 ms`
  without value on that easy case. It is not an improvement. Mill's
  discriminating profiles are required before deciding whether bounded repair
  ever earns its cost.
- **Rebased named-profile evidence:** checkpoint `a222607` passes lint,
  typecheck, 424 full tests, focused tests, and diff check. It is exact on
  beam-1, full GA, and wide-beam, but `near-capacity-ga-lite` is strictly worse
  at `largestNetFreeMaterialRegionAreaMm2` (`66180.74406000003` baseline vs
  `59721.90538800002` repair). That was an isolated preliminary observation;
  it does not override the accepted serial evidence below. Its earlier elapsed
  data was collected concurrently and must not be used.
- **Serial evidence (complete):** exact full-score/audit parity on every
  profile and effectively no performance effect: beam-1 `-0.61%`, GA-lite
  `+0.47%`, full-GA `-0.73%`, and wide-beam `+0.15%` (variant versus
  baseline). It has no demonstrated reason to integrate for speed, but it is
  not rejected for a score regression. The disagreement with the earlier
  isolated score report must be investigated before any future repair work
  relies on that report. Raw evidence is retained in Ramanujan's serial log.

### McClintock — NFP candidate pruning

- **Agent:** `019f6b08-9532-7641-ad8b-c221297435a8`
- **Worktree:** `/private/tmp/min-plane-dfx-nfp-pruning`
- **Goal:** use NFP/candidate bounds and early canonical dedupe to skip boundary
  intersections that cannot matter.
- **Required proof:** exact candidate-set or legality parity tests. A prior
  sweep prefilter was rejected because it lacked both proof and measurable
  value; this experiment must not repeat that failure.
- **Current result:** inclusive NFP/segment bounds indexing and early canonical
  point dedupe are implemented, with exact reference-vs-indexed candidate
  parity and legality tests. Lint/typecheck, 22 focused tests, the full 417-test
  suite, and diff check pass. The 50/100/200 baseline-to-variant times were
  `4633.10 → 4131.56 ms`, `21814.76 → 18233.38 ms`, and
  `41695.27 → 33904.93 ms`; all complete score tuples and audits matched. This
  is the strongest measured cost candidate so far, pending named-profile
  confirmation and independent review. After rebasing as `8e7b098` onto
  `0930854`, all four named profiles retain byte-identical full score objects
  and audits while each one-run elapsed observation is faster (`279.45 →
  261.65 ms`, `2092.32 → 1832.64 ms`, `11258.35 → 9778.08 ms`, and `815.81 →
  726.33 ms`). It is the leading candidate for repeated benchmarking and final
  Sol review.
- **Serial evidence (complete):** alternating fresh-process medians confirm a
  consistent exact-quality speed win: beam-1 `253.78 → 236.70 ms` (`6.7%`),
  GA-lite `1767.39 → 1587.13 ms` (`10.2%`), full-GA `9935.19 → 8960.46 ms`
  (`9.8%`), and wide-beam `764.61 → 690.39 ms` (`9.7%`). Every audit, complete
  score object, and portfolio status/reason is exact. Raw evidence:
  `/private/tmp/irregular-serialized-0930854-McClintock.log`. This is the
  first confirmed integration candidate, subject to Sol review.

### Parfit — parity-gated geometry alternatives

- **Agent:** `019f6b08-9798-7980-8401-96aa495afad8`
- **Worktree:** `/private/tmp/min-plane-dfx-geometry-alternatives`
- **Goal:** compare linear convex Minkowski with vertex-pair hull, and direct
  difference with union-then-difference free-material operations.
- **Required proof:** parity coverage across convex fixtures, winding,
  transforms, padding, and failures. Production defaults change only if an
  equivalent path is demonstrably faster; a documented no-go is valid.
- **Rebased named-profile evidence:** checkpoint `872a8f1` passes lint,
  typecheck, 113 focused tests, and diff check. Direct difference is exactly
  score-equivalent to the default. The linear Minkowski path is *not*
  equivalent: it improves some profiles at the first free-material criterion
  but makes `near-capacity-ga-lite` strictly worse at that same earlier
  criterion. This is an exact-comparator diagnostic, not an automatic
  rejection: the pending serial report must quantify whether each delta is
  material before a default-selection decision. All elapsed observations are
  invalid because they were collected concurrently.
- **Serial evidence (complete):** all profiles preserve legality, unplaced
  counts, and portfolio outcomes. `linear-edge-merge` has negligible
  first-criterion variation (at most `0.0000454%`) and mixed timing: beam-1
  `253.07 → 253.53 ms`, GA-lite `1783.99 → 1770.59 ms`, full-GA
  `9880.96 → 9789.57 ms`, wide-beam `775.04 → 766.52 ms`. Direct difference
  is exact-score equivalent but slower on every profile. Neither alternative
  is a broad replacement for the current default. Raw evidence:
  `/private/tmp/irregular-serialized-0930854-Parfit-linear-edge-merge.log` and
  `/private/tmp/irregular-serialized-0930854-Parfit-direct-difference.log`.

### Mill — hard benchmark corpus

- **Agent:** `019f6b08-99f5-7541-9498-95fa9896262f`
- **Worktree:** `/private/tmp/min-plane-dfx-benchmark-corpus`
- **Goal:** create deterministic, feasible near-capacity fixtures and runner
  profiles that separate physical capacity limits from search-quality limits.
- **Required proof:** imports and audits pass; document simple area feasibility
  bounds; at least one corpus case must make beam/GA profiles meaningfully
  comparable. It must not change production geometry or search behavior.
- **Milestone 1 result:** full layout-score summaries and named profiles now
  exist in `scripts/irregular-benchmark.ts`; deterministic capacity fixtures
  are in `tests/fixtures/irregularBenchmarkFixtures.ts`; equal-count
  score-ordering/import tests and reporting docs were added. Lint/typecheck,
  419 focused tests, and diff check pass.
- **Discriminating evidence:** Beam-1 produced `19 / 1` in `277.94 ms` with
  score `(1, 59721.8655, 1, 7, 489.4215, 0.989657, 1.965570, 144872.8006,
  784.8534)`; GA-lite also produced `19 / 1` but a strictly better score
  `(1, 66180.7441, 1, 6, 419.0007, 0.990767, 1.966121, 144952.2692,
  784.9071)` in `1804.26 ms`. Full GA placed `20 / 0` in `11007.89 ms`; the
  wider case with beam 4 also placed `20 / 0` in `811.33 ms`.
- **Remaining corpus work:** area-feasibility bounds and a broader raw-fixture
  set. Milestone 1 already proves why equal placed count is insufficient.

## Integration order

1. Integrate Parfit's parity gate and Einstein's broad kernel speed reduction.
2. Rebase McClintock onto Einstein, rerun exact candidate parity plus a fresh
   serial combined benchmark, then consider it for integration. Its isolated
   percentage must not be added to Einstein's because both modify the NFP path.
3. Remove Schrodinger's duplicated score comparator, then rebenchmark it on
   the Einstein-plus-McClintock baseline before considering its GA speedup.
4. Revisit Volta only after the combined NFP stack and on larger 100/200-piece
   profiles. Keep Planck and Arendt as architecture-only maintenance options.
5. Do not pursue Feynman, Raman, Ampere, Hubble, Fermat, or Pauli further
   without a new hypothesis and corpus evidence. Keep Parfit's production
   backend switches disabled.

## Review status

Persistent reviewer: Sol/high agent `019f6b22-4f06-7811-8ba6-ad1b56386769`. Keep this thread
open and reuse it for every later project review; it is intentionally separate
from the failed external review-chat attempt.

The Mill benchmark-corpus diff has an external review-chat log at
`/tmp/codex-review-chat-1784208597-44227.md`. The reviewer session was created
but both its initial call and its one permitted resynchronization produced no
reply because of `Auth(AuthorizationRequired)`. This is a failed review attempt,
not approval. Do not integrate Mill's diff until it receives a valid review or
is independently reviewed with equivalent scrutiny.

Persistent Sol/high review is now active through agent
`019f6b22-4f06-7811-8ba6-ad1b56386769`. Its first verdict is **NEEDS CHANGES**:
profile CLI precedence is contradictory, GA wall-clock profiles are not fully
reproducible, named-corpus quality/feasibility claims lack execution tests, and
the exported comparator is unnecessary. Mill is fixing all four findings in
its isolated worktree before the same reviewer re-checks it.

Mill fixed every finding and the same retained Sol reviewer returned
**APPROVED**: F1–F4 are resolved. The reviewed corpus/runner change is now
integrated and pushed as `0930854 Add irregular benchmark corpus profiles`.
Every Luna owns rebasing its own isolated worktree onto that commit and reruns
the named profiles before any earlier benchmark conclusion can be accepted.

## Serial timing queue

Ramanujan is the sole accepted elapsed-time runner. Once every experiment has
finished rebase and correctness/quality verification and the machine is quiet,
it will run alternating baseline/variant warmups and repeated measurements for
every completed implementation worktree. It will report medians only; all
parallel elapsed values above are retained solely as historical diagnostics.
