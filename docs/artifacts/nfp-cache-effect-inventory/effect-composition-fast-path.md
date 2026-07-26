# Removing `Effect.gen` from the per-candidate path

The final TypeScript hot-path experiment agreed after #16. Baseline `9cffb49`,
Mixed-61 `2000x2700`, serial and single-process throughout.

## What the earlier measurements pointed at

Two ceilings were established in
[`follow-up-measurements.json`](./follow-up-measurements.json), against a
41,152 ms baseline:

| Source | Cost | Share |
| --- | ---: | ---: |
| NFP cache-hit path, 6.92 µs x 262,166 hits | 1,814 ms | 4.41% |
| `Effect.gen` checkpoint composition | 1,289 ms | 3.13% |
| **combined** | **3,103 ms** | **7.54%** |

The checkpoint microbenchmark is the load-bearing one, because of how it was
built. Both of its arms run their checkpoint through `yield*` on a live fiber;
they differ only in whether the checkpoint body is an `Effect.gen` (1,392 ms)
or a direct `Effect.void` / `Effect.fail` (108 ms). **The 1,289 ms difference is
therefore generator construction alone, not fiber stepping.** Telemetry recorded
`directVoidCount: 0` — nothing was taking the cheap path.

That reframes the task. Reaching this cost does not require extracting a
synchronous kernel; it requires the controls to stop building a generator per
checkpoint.

## The change

Six files, +115 / -64.

**Four checkpoint controls split once at construction instead of per call.**
`intrinsicStrictDecoder.ts`, `intrinsicGlobalSqueezePortfolio.ts`,
`intrinsicSqueezeDisruptSeparate.ts` and `windowedBeam.ts` each built an
`Effect.gen` on every checkpoint in order to sequence an optional upstream
checkpoint before their own deadline read. The upstream branch is now decided
once, when the control is created:

- no upstream — the checkpoint evaluates its deadline and returns the shared
  `Effect.void`, or an `Effect.fail`;
- upstream present — `Effect.flatMap(upstream.checkpoint(phase), deadlineReached)`.

`windowedBeam.ts` additionally has an event-loop yield every eighth checkpoint.
Seven of every eight now return a constant; only the eighth composes, and it
composes exactly the same suspension it did before.

**Safety of eager evaluation.** Moving the deadline read from the `Effect.gen`
body to the enclosing function makes it run at construction rather than at
execution. That is observationally identical here because every one of the 29
`.checkpoint(` call sites in `src/` constructs and immediately runs the result —
27 as `yield* …`, two inside `Effect.matchEffect(control.checkpoint(…), …)`.
Verified by enumeration, not by sampling. Any future call site that stores a
checkpoint without running it would break this, which is why the reasoning is
recorded here.

**One NFP cache-hit fast path.** `GeometryCache` gains an optional `getSync`.
`computeNfpBoundaryCached` uses it to skip composing a `flatMap` around a lookup
that is a `Map.get` underneath. Resolution — validate, evict if stale, compute,
store, translate — is written once in `resolveNfpBoundary` and reached by both
routes, so a hit cannot behave differently depending on which path it took.
`getSync` records the same counters as `get`, so a run's tallies do not depend on
the route either.

## Result

Five alternating serial A/B pairs, same host, per the agreed protocol. Run
twice; the second run was declared in advance as the last.

| Pair | Protocol 1 | Protocol 2 |
| ---: | ---: | ---: |
| 1 | 1.0495 | 1.0591 |
| 2 | 1.0398 | 1.0615 |
| 3 | 1.0411 | 1.0697 |
| 4 | 1.0761 | 1.0869 |
| 5 | 1.0781 | 1.0454 |
| **median** | **1.0495** | **1.0615** |

**Protocol 1 misses the 1.05 bar. Protocol 2 clears it.** Pooled over all ten
pairs the median is **1.0603** and the mean **1.0607**; six of ten individual
pairs clear 1.05, four do not, and the spread runs 1.0398 to 1.0869.

The honest reading is that this change is worth **roughly 4% to 8.7%**, and
whether any single five-pair median lands above or below 1.05 depends on host
noise. Protocol 1 showed monotonic upward drift in the baseline arm — 50,253 ms
rising to 53,233 ms across its five runs — which alternation only partly cancels.

What raises confidence above "a coin flip near the bar" is that the result
matches a ceiling predicted independently, before this code was written: 7.54%
was available, most of the checkpoint share plus part of the cache share was
targeted, and 5-7% is what came out. The mechanism and the magnitude agree.

## Parity

Exact, and it is the part with no ambiguity.

- **Canonical hash**: `ef2b783a…` in all twenty A/B runs, one distinct hash.
- **Work ledgers**: identical counter for counter in every pair —
  4,991,970 checkpoints (2,975,313 live / 2,016,657 inert), 266,977 NFP lookups,
  262,166 hits, 4,811 stores, 9,420 memo consultations, 32 memo hits.
- **Eighteen layouts**: `gate:compact-nine-baselines` reports `passed: true`,
  nine Compact and nine Short-Side, `directionalMissCount: 0`.
- **Test suite**: 841 passed, 6 failed, 17 skipped — identical counts and
  identical files to unmodified `9cffb49` on the same host. Five failures are
  `workspaceProjectService.test.ts` failing to load the `better_sqlite3` native
  binding in this sandbox; the sixth is the known phase-coverage assertion in
  `intrinsicStrictDecoder.test.ts:592`, which passes 3 of 3 in isolation and
  fails under parallel workers.
- **Lint and typecheck**: clean.

Layout parity was checked directly rather than inferred from the gate's pinned
hashes: the gate was run on both arms and all **eighteen emitted SVGs compare
byte-identical** under `cmp`.

## Memory

Peak RSS over four alternating single-case runs per arm, `time -f %M`:

| Arm | Samples (kB) | Median |
| --- | --- | ---: |
| `9cffb49` | 802,716 / 842,788 / 846,612 / 858,808 | 844,700 |
| experiment | 823,388 / 845,908 / 848,624 / 914,968 | 847,266 |

**+0.30% median**, with heavily overlapping ranges and one high outlier in each
direction. No material regression. This is the expected shape: the change
removes allocations rather than adding them, and a shorter run simply gives the
heap less occasion to be collected before its high-water mark.

## What this does not do

It does not extract a synchronous candidate-generation kernel. The measurements
said the reachable cost was generator construction, and a kernel extraction is
not needed to reach it — the surgical change is smaller, its equivalence is
checkable by enumeration, and it leaves the geometry untouched.

It does not touch the canonical key representative rules, the candidate memo, or
`IrregularPolygon`, per the constraints agreed for this experiment.

Remaining unclaimed from the 7.54% ceiling: key construction (1.62 µs of a
6.92 µs hit) and the two hit-time validation predicates (1.88 µs combined), which
are deliberate and documented as untouchable at this boundary.
