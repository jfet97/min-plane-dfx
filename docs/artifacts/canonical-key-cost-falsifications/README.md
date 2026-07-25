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

**(b) is the better design.** It attacks call count rather than cost per call,
it keeps string-keyed containers so no module outside the key functions changes,
and it is the shape a compiled port would want anyway.

## What review has to decide

Both options change every identity *value* while preserving the equivalence
relation. That is safe here — these keys are used exclusively for equality and as
memo keys, verified: there is no ordinal tie-break on them anywhere in the
search, and the production SHA-256 layout identity is computed by a separate
path in `canonicalLayoutGeometry.ts` that these keys never feed.

Correctness would therefore be demonstrated the same way the previous steps
were: identical canonical hashes, bounds, topologies, partitions and work
ledgers across all 18 gate layouts. What cannot be demonstrated by the gates,
and so needs a human decision, is whether changing the canonical representative
rule is acceptable as a matter of contract.
