# NFP/IFP cache path and Effect usage: inventory before instrumentation

Groundwork for the measurement-only cache experiment. No behaviour changes here —
this records what is actually on the path so the instrumentation measures the
right things and the "make the inner loops pure" question is answered from the
source rather than from a profile that cannot separate geometry cost from
runtime cost.

Baseline: `b07ba36` (after #12, #13, #14).

Claims are marked **verified** (read directly in the source while writing this)
or **reported** (produced by an automated sweep, cited but not independently
re-read). Do not act on a *reported* line without re-reading it.

## Why a profile could not answer this

The largest single frame in the post-#13 profile is
`(anon) [nfpIfpService.ts]` at **19.3% of the whole run**. The profile was taken
on transpiled code, so every anonymous function in the file — generator bodies,
`.pipe` callbacks, comparators, closures — collapses into that one bucket with no
line attribution. Geometry cost and Effect cost are mixed inside it and cannot be
separated by sampling.

This matters because the last estimate made from that profile was wrong by 20x:
removing `Effect` from per-candidate placement assessment was predicted at
10–15% and measured at **1.005x** (#14, whole PR 1.0064x).

## The caches

**verified.** `GeometryCacheLive` (`services.ts:422-437`) is a single
`Map<string, unknown>` behind `Effect.sync` accessors. A hit therefore costs
three Effect nodes — the `Effect.sync` from `get`, the caller's `Effect.flatMap`,
and an `Effect.succeed` — plus one more through the public `computeNfp` /
`computeIfpBounds` wrappers.

| Cache | Store | Key | Lookup |
| --- | --- | --- | --- |
| NFP boundary | shared `Map` via `GeometryCache` | `pairwiseNfpCacheKey` | Effect, `computeNfpBoundaryCached` (`nfpIfpService.ts:124-152`) |
| IFP bounds | shared `Map` via `GeometryCache` | `innerFitBoundsCacheKey` | Effect, `computeIfpBoundsValuesCached` (`:560-580`) |
| Legal candidates | local `Map` in `makeGeneratePlacementCandidates` (`:951-1032`) | composite | synchronous |

**reported.** All `GeometryCache` namespaces resolve to one shared `Map`
instance despite the layer being merged three times. None of the three caches has
any hit/miss/request counter today; the only existing instrumentation on the path
is `NfpIfpCandidateProvenance`, which counts candidate admission, not cache
behaviour. The counter precedent to copy is `IntrinsicPhaseSignatureMemo`.

## The profile does not isolate Effect, cache, or schema cost

Earlier exploratory microbenchmarks reported a raw `sync → flatMap → succeed`
cost and a public `computeNfp` hit cost, but they did not measure the production
candidate-generation call path and are not evidence for an end-to-end
optimization. The archived CPU profile attributes 8.7% of total self time to all
Effect runtime and 3.1% to `makePrimitive`; the anonymous NFP frame mixes cache
keys, validation, translation, candidate construction, geometry, and Effect.

**verified architectural inventory.** #12 converted
`TransformedCollisionGeometry`, `IrregularPlacedPiece` and
`IrregularPlacementCandidate` to plain classes. The *leaves* were not converted:

```
domain.ts:133   IrregularPoint              extends Schema.Class   (x, y: FiniteNumber)
domain.ts:157   IrregularBounds             extends Schema.Class
domain.ts:162   IrregularPolygon            extends Schema.Class   (Schema.Array(IrregularPoint))
domain.ts:190   IrregularTransformCandidate extends Schema.Class
```

And the memo restore path constructs one per cached candidate, on every hit
(`nfpIfpService.ts:1053-1066`):

```ts
function restoreCachedLegalCandidates(cached, moving) {
  return cached.map(({ point, diagnostics }) =>
    new IrregularPlacementCandidate({      // plain since #12
      pieceId: moving.sourcePieceId,
      transform: moving.transform,
      point: new IrregularPoint(point),    // still Schema.Class — validates, per candidate, per hit
      diagnostics: [...diagnostics]
    })
  )
}
```

This is the exact mechanism #12 identified and fixed one level up, still live on
the memo-restore path. `IrregularPolygon` compounds schema construction wherever
it is instantiated because its field is `Schema.Array(IrregularPoint)`.

These shared classes also cross worker, history, and persisted-result
boundaries, so they cannot simply be converted in place. Any hot-path cleanup
must first introduce a separate plain internal representation and preserve a
schema-backed boundary model. The blast radius is wider than #12's and requires
its own call-site inventory and gates.

**Re-weighted by measurement.** The memo hit path fires 32 times in the captured
run, so `restoreCachedLegalCandidates` is not a credible large optimization
target there. The 262,166-hit candidate-generation NFP path returns an
`InternalPolygon`; it does **not** construct `IrregularPolygon`. The public
`computeNfp` wrapper does materialize the domain schema class, but that is a
different call path. No schema conversion is justified by these cache counts.

## Cancellation: no `isCancelled` origin, but controls are frequently present

The inner loops carry cancellation/deadline checkpoints. The counters show that
59.6% receive a control object and distinguish the shared `Effect.void` identity
from another returned effect. They do not determine allocation, suspension,
failure, cancellation polling, fiber stepping, or event-loop yielding.

**verified.** `isCancelled` appears 15 times in `src/` and every one is a
*forward* of `input.isCancelled` — `portfolioSearch.ts:278`, `:384`,
`computeIrregularNesting.ts:1442`, `windowedBeam.ts:773`. There is no origin. The
only sites that ever supply the callback are four tests
(`tests/unit/irregularPortfolio.test.ts:474`, `:556`,
`tests/unit/irregularWindowedBeam.test.ts:819`, `:1144`).

**verified.** In the NFP service the checkpoint primitive is `nfpCheckpoint`,
batched with `pointIndex % 32` (`nfpIfpService.ts:837`) and taking
`input.control`, which is `undefined` on the baseline-decode path.

**reported.** `windowedBeam.ts:1171` returns `Effect.void` when `control` is
undefined, making every baseline-decode checkpoint a no-op; the intrinsic
capacity and periodic lanes run uncheckpointed for the same reason. Live in
production are the GA decodes, which always set `deadlineMs`, and the strict
decoder's self-imposed deadline. Separately reported: the deadline half of the
contract is already plain synchronous `performance.now()` comparisons and needs
no Effect at all; only the cancellation poll and a `setImmediate` yield in
`windowedBeam` ride the monad.

## Effect capability inventory in `src/workers/irregular/`

**reported.** Every `Effect.Effect<...>` in the directory is declared with
`R = never` — no context service is needed at call time. The three `yield* Service`
sites are layer constructors that hand the resolved service down as a plain
argument. A sweep for `withSpan`, `annotate`, `Tracer`, `Metric`, `Clock`,
`Random`, `Ref`, `Deferred`, `Fiber`, `Effect.interrupt`, `yieldNow`, `sleep`,
`async` and `promise` returns **zero hits** in the directory.

The layer uses Effect for typed failures and for the checkpoint effects supplied
by callers. Some controls are synchronous deadline checks, while other paths can
poll cancellation or yield to the event loop. A pure internal kernel remains a
possible design, but only after separating these control shapes without changing
their checkpoint order or suspension behavior.

**reported**, search layer: `irregularBeamState.ts` is already fully Effect-free
after #14. The scorers (`irregularPlacementScorer.ts:198`,
`irregularLayoutScorer.ts:224`) are synchronous bodies whose Effect carries only
a typed scoring error. Tracing imposes nothing — `decisionTrace.ts:693` is a
plain `=> void` callback and there is no `Effect.withSpan` or `Effect.log`
anywhere under `src/workers/`.

The practical reading: "keep Effect for tracing" does not apply because no
Effect tracing is present. Typed failures and cooperative controls are the
load-bearing behavior that any internal-purity experiment must preserve.

## Correction: wall-clock budgets can influence shipped geometry

Issue #11 records the inference that no wall-clock deadline is authoritative in
the nine gate cases, on the grounds that three PRs made the run 1.804x faster
with every canonical hash unchanged.

**That inference does not hold.** Unchanged hashes show the budgets were not
*reached* at either speed, not that reaching them would be inconsequential.

**reported**, and it should be re-verified before being relied on: three
production paths let a clock decide which layout is emitted — the 15 s focused
reconstruction deadline (a timeout drops the endpoint from the archive, and
shapes-17 @ 2000x2700 is pinned with `influence: 'selected'`), the 250 ms
short-side observer censor, and the 30 s / 512 MiB pair-fold plus 20 s / 256 MiB
contact-strip budgets, which archived matrix artifacts indicate produced the
shipped short-side geometry for 4 of the 9 baselines.

**verified** mitigation: the baseline report carries `focusedAccounting`,
`shortSideObserverRuntimeBudget` and `shortSidePairFoldBudget`
(`scripts/irregular-compact-baseline.ts:743`, `:756`, `:768`), so the gates can
fail rather than silently accept a different hash on a slow machine. The shipped
worker has no equivalent guard.

Consequence: the work-counter budget conversion is **not** the no-op that #11
implies, and it would close a real machine-dependence in the shipped product.
This does not authorize parallel execution: the project remains strictly
single-process until the user explicitly changes that rule.

## Measured

`src/workers/irregular/nfpIfpTelemetry.ts`, enabled with
`--capture-cache-telemetry`. Integer counts only. The captured run reproduced the
same canonical identity, but enabled counters still add work inside hot loops
and could affect a deadline-censored run; parity is an observed result, not a
semantic guarantee.

```
scripts/irregular-sheet-invariance.ts --case mixed-61 --sheets 2000x2700
  --allow-single-sheet --strict --capture-cache-telemetry
  --expected-canonical-sha256 ef2b783a… --maximum-area-mm2 391606
  --maximum-canonical-cavities 0 --maximum-elapsed-ms 330000
```

`passed: true`, canonical SHA-256 `ef2b783a…` reproduced exactly, 51,185 ms.
Raw counts: [`mixed-61-2000x2700.cache-telemetry.json`](./mixed-61-2000x2700.cache-telemetry.json).

| Cache | Lookups | Hits | Stores | Stale removals | Hit rate | Reuse per stored value |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `pairwise-nfp-relative-v3` | 266,977 | 262,166 | 4,811 | 0 | **98.20%** | **54.5x** |
| `transform-collision-v1` | 10,028 | 9,540 | 488 | 0 | 95.13% | 19.5x |
| `sheet-ifp-v1` | **0** | 0 | 0 | 0 | — | — |

`cacheInstances: 1` — the layer is merged three times but resolves to a single
backing `Map`, which the source could only suggest structurally.

| Candidate memo | |
| --- | ---: |
| calls that bypassed it (no scope) | 0 |
| consultations | 9,420 |
| hits | **32** |
| misses | 9,388 |
| provenance misses | 0 |
| candidate objects restored, whole run | **224** |

| Checkpoints | Count | Share |
| --- | ---: | ---: |
| `pairwise-nfp-boundary-intersection` | 4,292,842 | **86.0%** |
| `placed-nfp` | 530,874 | 10.6% |
| `candidate-points` | 140,090 | 2.8% |
| `ifp` | 28,164 | 0.6% |
| **total** | **4,991,970** | |
| with a live control | 2,975,313 | **59.6%** |
| inert (`control === undefined`) | 2,016,657 | 40.4% |
| live control returned `Effect.void` directly | **0** | 0% of live |
| live control returned a composed effect | **2,975,313** | 100% of live |

### What these numbers change

**The candidate memo needs an A/B measurement.** Its 0.34% hit rate is low, and
9,388 misses build `legalPlacementCandidateMemoKey`. But each of the 32 hits
bypasses the entire uncached candidate generator, so counts alone cannot show
whether the memo is net-negative. Removal requires alternating serial A/B runs
with exact identity and work-ledger parity, representative timing, and the full
18-layout correctness gate.

**The remaining `Schema.Class` leaves are an architectural cleanup candidate,
not a measured optimization from this evidence.** The 262,166-hit
candidate-generation path returns `InternalPolygon` and never materializes
`IrregularPolygon`. Profile and call-site evidence must identify a genuinely hot
constructor path before prioritizing a boundary/internal representation split.

**`sheet-ifp-v1` is dead on this path.** Every candidate-generation call on this
case takes the `candidateDomain === 'sheetless-nfp'` branch
(`nfpIfpService.ts:642-647`), so the IFP bounds cache is never consulted.
Anything written about the IFP hit path is untested here.

**The NFP boundary cache is the workload.** 262,166 hits, 4,811 distinct
boundaries — consistent with the ~3,900 oriented-shape pairs the corpus implies.
The cache is doing its job. Whatever a hit costs is multiplied by 262,166, which
is what makes the per-hit re-translation and re-canonicalisation
(`nfpIfpService.ts:143` → `:483-505`) worth measuring. The follow-up measurement
below supersedes the earlier unverified public-wrapper microbenchmark.

**Correction to the cancellation reading above.** 59.6% of checkpoints receive a
control object, not a minority. `isCancelled` has no production origin in the
current worker wiring, but the counter does not say whether a particular control
returns `Effect.void`, reads a deadline, fails, polls cancellation, or yields.
The 4.99 million calls make checkpoint dispatch worth measuring, but no Effect
or fiber cost can be attributed from this count alone.

Caveat on scope: this measures `scripts/irregular-sheet-invariance.ts`, the gate
path that pins the production hashes, not `nesting.worker.ts` literally. The
`isCancelled` wiring question is specific to the worker and is unaffected, but
the live/inert split could differ there.

## Follow-up timing experiments

Raw results and exact source commits are recorded in
[`follow-up-measurements.json`](./follow-up-measurements.json). Every algorithm
run was serial and single-process.

### Candidate memo: rejected as a production change

Five alternating same-host control/bypass pairs kept the exact production
canonical hash. Removing the memo produced a median **1.0074x** speedup, a mean
**1.0066x** speedup, and one slower pair. This is measurable but far below the
predeclared **1.05x** threshold. The benchmark-only bypass remains only on the
recorded experiment commit; the production memo is unchanged.

### NFP cache hit: measured ceiling is below five percent

Three sampled runs measured 1,023 hits each, one hit every 256 calls. Median
component cost was:

| Component | µs / hit | Extrapolated over 262,166 hits |
| --- | ---: | ---: |
| input validation | 0.669 | 176 ms |
| key construction | 1.623 | 426 ms |
| cache plus Effect round trip | 2.415 | 633 ms |
| cached-boundary validation | 1.214 | 318 ms |
| translation and canonicalization | 0.997 | 261 ms |
| **total** | **6.920** | **1,814 ms** |

Against the paired memo experiment's 41,152 ms mean control, the whole measured
hit path is about **4.4%**. No narrow subcomponent clears the five-percent
production threshold, and `IrregularPolygon` is not constructed on this path.

### Checkpoint dispatch: composed controls are real, but still sub-threshold

The refined counter shows all 2,975,313 live checkpoints returned composed
effects; none returned `Effect.void` directly. A five-pair microbenchmark of the
strict decoder's `Effect.gen` deadline-control shape measured a median 1,393 ms,
versus 108 ms for the same number of direct synchronous deadline reads: a
1,289 ms difference, about **3.1%** of the representative run.

This is a microbenchmark, not an end-to-end fast-path result. Its delta includes
suspension, iterator creation, generator stepping, and Effect interpretation;
it is not attributable to generator construction alone. A production prototype
would need to preserve upstream cancellation, deadline-read count, failure
points, phase order, and any event-loop yields. The isolated result does not
clear the five-percent threshold.

### Decision

None of the three isolated changes qualifies for production:

- keep the candidate memo;
- do not prioritize `IrregularPolygon` conversion from this evidence;
- do not add a checkpoint fast path from the microbenchmark alone.

The sampled NFP span begins after its caller's checkpoint, so the two measured
regions are adjacent rather than overlapping. Their sum is nevertheless only a
rough engineering ceiling because both values are independently extrapolated
and the checkpoint result is a microbenchmark.

### Final Effect-composition experiment: rejected

PR #17 first measured an eager implementation that moved deadline and
cancellation observations from lazy Effect execution to effect construction.
Exact ordinary outputs did not prove deadline-boundary equivalence, so that
implementation is rejected regardless of its reported timing.

Review produced a lazy-equivalent candidate at `63c7685`: `Effect.suspend`
avoids generator iterators while preserving upstream failure ordering,
deadline-read timing, and the before/after checks around every eighth
windowed-beam event-loop yield. Differential tests also cover synchronous and
effect-backed NFP-cache hit, miss, stale eviction, output, counter, and telemetry
parity.

One confirmation protocol was recorded before running the corrected candidate:
five serial baseline-then-experiment pairs, exact hash and ledger parity, and a
required median speedup of at least `1.05x`.

| Pair | Baseline | Lazy candidate | Speedup |
| ---: | ---: | ---: | ---: |
| 1 | `39,840.263 ms` | `38,496.737 ms` | `1.03490x` |
| 2 | `40,127.977 ms` | `38,624.041 ms` | `1.03894x` |
| 3 | `40,225.167 ms` | `38,776.839 ms` | `1.03735x` |
| 4 | `40,388.062 ms` | `38,996.893 ms` | `1.03567x` |
| 5 | `40,485.572 ms` | `39,151.983 ms` | `1.03406x` |

The median is **`1.03567x`**, below the predeclared `1.05x` threshold.
Every pair has byte-identical SVG and telemetry output, the full local suite
passes `847` tests with `17` skipped and zero failures, and the serial
18-layout gate passes. Correctness is strong; the production benefit is not
large enough. The code remains unmerged and TypeScript hot-path optimization
stops here.

Portable summary:
[`lazy-checkpoint-confirmation.json`](./lazy-checkpoint-confirmation.json).
Immutable raw evidence:
`/private/tmp/min-plane-provenance/pr17-lazy-checkpoint-confirmation/`.

## Instrumentation still missing

The remaining questions for any broader prototype are:

1. derived per-call structures never cached at all (`BoundsIndex`,
   `allNfpIndex`, `candidateNfpIndex`)
2. memory footprint of the unbounded, never-cleared cache
3. end-to-end cost of a coherent pure internal kernel without removing,
   batching, or reordering checkpoints

Any timed run must re-check the three budget assertions in
`scripts/irregular-compact-baseline.ts:743`, `:756`, `:768`.

## What not to do

- Do not rewrite the candidate generator before these numbers exist. The one
  Effect removal already measured on this path returned 1.005x.
- Do not treat the 19.3% anonymous frame as an Effect cost. It is unattributed.
- Do not touch the canonical key representative rule. See
  [`../canonical-key-consumer-inventory/README.md`](../canonical-key-consumer-inventory/README.md).
