# Why the canonical dedup keys resist local optimization

Five falsified hypotheses against the largest remaining profile block, and the
one approach the measurements leave standing. Recorded so the next attempt does
not repeat them.

The profile and hypothesis-specific measurements below were collected while
investigating Mixed-61 `2000 x 2700` after the Schema-class and canonical-grid
changes. They establish where the work occurs, but they are not treated as one
causal before/after series.

## Accepted paired result

The retained code was measured again after rebasing onto the current production
baseline. Both commands ran serially on the same host with no other measured
workload:

```sh
pnpm exec tsx --tsconfig tsconfig.node.json \
  scripts/irregular-compact-baseline.ts \
  --fixture mixed-61 --sheet 2000x2700 \
  --output-prefix <output-prefix> \
  --capture-short-side-observer \
  --capture-short-side-pair-fold-observer
```

| Committed stage | Wall time | Relative speed |
| --- | ---: | ---: |
| production baseline `4de3964` | 40,866.15 ms | 1.0000 |
| pure assessment and inline translation `03a70c2` | 40,606.55 ms | **1.0064x** |

Both reports use Node `v24.16.0` and V8 `13.6.233.17-node.49`. They preserve
collision identity `3839e80d...`, fitted canonical identity `ef2b783a...`,
`61 / 0` accounting, every work ledger, and every Compact and Short Side
contract check. The measured gain is only `0.635%`; the accepted value is the
smaller trusted hot-path surface with no observed performance or output
regression, not a material speedup.

## Merge validation

Committed PR state `96a1419` passed the complete test suite with 844 tests
passing, 17 explicitly skipped historical protected-lane tests, and zero
failures. The serial production gate also passed all nine Compact and nine Short
Side layouts: four directional successes, five Compact fallbacks, and zero
directional misses. The gate ran with
`maximumConcurrentAlgorithmProcesses: 1`.

## The block

After the Effect Schema and `bigint` orientation work, canonical key
construction is the second largest category at **19.3%** of self time:

| Function | Self time | Share |
| --- | ---: | ---: |
| `canonicalRingKey` | 2.69 s | 5.0% |
| `canonicalRecord` | 2.50 s | 4.7% |
| `canonicalCollisionPolygonKey` | 1.34 s | 2.5% |
| `bottomLeftAnchoredCanonicalOccupiedGeometryKey` | 1.06 s | 2.0% |
| `pointKey` (NFP candidate points) | 0.95 s | 1.8% |
| `compareCanonicalPointSequences` | 0.94 s | 1.8% |

Instrumented over one full run:

```
canonicalRingKey        4,944,263 calls
                          676,054 distinct results   (86.3% repeats)
                              161 characters average
```

Roughly 800 MB of transient string data per run.

## Falsified hypotheses

| # | Hypothesis | Result |
| --- | --- | --- |
| 1 | Memoize `canonicalPolygonDigest`/`polygonDigest` by point-array identity | **0.91x — regression.** 52,314 → 57,4xx equivalent; measured earlier at 94,368 → 103,561 ms on the pre-#12 baseline. Every probe missed and paid added `WeakMap` traffic. |
| 2 | Rewrite `canonicalRingKey` allocation-free with byte-identical output | **1.7% of the run.** Microbenchmark 5,865 → 5,309 ns, a 9.5% improvement on the function. |
| 3 | Remove the `Effect` wrapper around per-candidate placement assessment | **1.005x.** The assessment never suspends, but the wrapper was not the cost. |
| 4 | Memoize the key on the `IrregularPlacedPiece` object | **Not viable.** 322,537 calls over 255,106 distinct objects — 1.26 calls per object. |
| 5 | Stop materializing a translated ring copy per key | **1.007x**, despite removing 4.9M array allocations and roughly 120M point objects. |

Hypotheses 3 and 5 are kept in the tree anyway: together they remove redundant
trusted-path machinery, reduce the surface a future port has to carry, preserve
typed error provenance and emitted keys, and show no regression in the paired
run. They are simply not where most of the time is.

## The decisive measurement

```
canonicalCollisionPolygonKey   4,944,263 calls
                               4,944,263 distinct point arrays
                                    1.00 calls per array
```

Every call receives a freshly allocated array. There is **zero** object-identity
reuse, which is why hypotheses 1 and 4 could not work and why hypothesis 5 —
removing the allocation — changed almost nothing. The cost is not the container
around the work; it is the work.

Taken together the five results bound the reachable gain: the profile attributes
19.3% to these functions, but removing their allocations, copies, and wrappers
yields about 2%. The remainder is intrinsic — building and hashing 4.9M strings
of 161 characters inside V8's string machinery, attributed as self time to the
frames that build them.

## What is left standing

Only one approach survives: **do not produce the strings**.

Two ways to get there, both requiring review before implementation because both
change identity *values*:

**(a) Hash-plus-structural-equality containers.** Replace the string-keyed maps
and sets across roughly eight modules with a hash bucket plus full structural
comparison. The hash may only choose the bucket; canonical equality must resolve
collisions. In JavaScript this means two `uint32` lanes with `Math.imul`, not a
`bigint` and not a `Number` pretending to hold 64 bits.

**(b) Translation-equivariant canonical form.** Make the placed-piece key derive
from a precomputed local ring identity plus its anchor, instead of canonicalizing
a translated ring from scratch each time. The start-vertex rule, lowest `y` then
`x`, is already translation-invariant. The direction rule is not: it compares
*stringified* point keys lexicographically. Switching that comparison to numeric
makes the whole form translation-equivariant, and the key becomes
`(normalized local shape id, absolute anchor)` — a bijection with the translated
canonical ring, so the equivalence relation is preserved exactly while the
per-call work drops from `O(n)` string construction to `O(1)`.

**(b) is the better design** on cost grounds. It attacks call count rather than
cost per call and it is the shape a compiled port would want anyway. But see the
correction below before acting on it: the claim that made it look *safe* was
wrong.

## CORRECTION — the safety argument below was false

> **Superseded.** The paragraph this section replaces asserted that these keys
> are "used exclusively for equality and as memo keys, verified: there is no
> ordinal tie-break on them anywhere in the search". **That assertion is false.**
> It was written without tracing the consumers, and it is retracted here rather
> than silently edited. Full evidence:
> [`../canonical-key-consumer-inventory/README.md`](../canonical-key-consumer-inventory/README.md).

The canonical representative rule is the start-vertex choice
`lowestYThenXIndex` plus the forward/reverse direction minimisation in
`canonicalRingKey` (`irregularBeamState.ts:761-772`, `:789`). Changing it
preserves the equivalence relation and changes every key *value* — that much was
right. What was wrong is the belief that only equality consumes those values.

Key values are an **ordinal ranking axis in the production search**:

| Site | Role |
| --- | --- |
| `windowedBeam.ts:2650` | `makeStateOrder` terminates on `Order.mapInput(Order.String, (state) => state.key)`, and `beamStateKey` (`:2685`) is `` `${state.canonicalOccupiedGeometryKey}::…` `` — the canonical key is the leading bytes of the sort axis. Feeds `rankScoredStates` → `productionRanked.slice(0, beamWidth)` (`:2419`) and the final layout pick (`:807`). |
| `intrinsicCapacitySearch.ts:1769`, `:1795` | Both capacity beam comparators terminate in `compareStrings(first.anchoredOccupiedKey, second.anchoredOccupiedKey)`, driving `.toSorted(…).slice(0, beamWidth)` at `:1817` / `:1820`. |
| `intrinsicStrictDecoder.ts:1661` | `compareLocalScores` tie-breaks on `canonicalCombinedGeometryKey.localeCompare(…)` — the decoder's per-step placement choice. |
| `windowedBeam.ts:1941-1953` | `intrinsicStateGeometryKey` is `JSON.stringify(canonicalRings.toSorted())`, so key *order* is baked into the emitted bytes. |
| `irregularBeamState.ts:184`, `:316`, `:372`, `:436`, `:521` | `canonicalEntryListKey` names fields `entry-${index}` by position in the lexicographically sorted array, so relative key order is baked into the state-level key itself. |

They are also **serialised into committed artifacts**: 22 files under `docs/`
contain raw key text (255 occurrences of `irregular-occupied-geometry-v2` in
`current-compact-baselines/shapes-17-300x300.json` alone), reaching disk via
`intrinsicCapacitySearch.ts:2062` → `scripts/irregular-compact-baseline.ts:809`.
The `SHA256SUMS` over those trees currently verify.

And they are **hashed into checkpoint integrity digests** that gate control flow
by strict `!==`: `intrinsicCapacitySearch.ts:1490-1537` (validated at `:1276`)
and `intrinsicStrictDecoder.ts:1054-1073` (validated at `:942`).

The one sub-claim that held up: `canonicalLayoutGeometry.ts` really does compute
the production SHA-256 identity by a code-disjoint path with its own
canonicalisation (`:613`, `:139`) and shares no helper with
`irregularBeamState.ts`. That does not rescue the conclusion — the search
upstream selects a *different layout*, which then hashes differently.

**Consequence for (a) and (b).** Neither is an equality-only implementation
detail. Both can change search decisions on ties and can change regenerated
artifacts. The maintained corpus compares exact canonical layout hashes for its
covered requests, while artifact checksums detect changes only when those
artifacts are explicitly regenerated. Neither proves that every possible tie is
exercised. Any future attempt must therefore keep a byte-identical legacy key
for every ordering, serialisation and digest consumer, introduce a fast key only
for pure-equality consumers, and prove comparator-sign parity directly. That is
a substantially larger and riskier change than this document originally
implied, and the ~2% ceiling established above should be weighed against it.

The NFP/IFP geometry cache keys (`pairwiseNfpCacheKey`, `innerFitBoundsCacheKey`)
and `pointKey` are the exception: every consumer routes through
`cacheKeyToString` into a plain `Map` or `Set`, with no sort, no digest and no
artifact. Those are genuinely equality-only.
