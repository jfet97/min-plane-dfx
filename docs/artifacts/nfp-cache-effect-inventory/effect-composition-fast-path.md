# Removing `Effect.gen` from the per-candidate path

The final TypeScript hot-path experiment agreed after #16. Baseline `9cffb49`,
Mixed-61 `2000x2700`, serial and single-process throughout.

## What the earlier measurements pointed at

Two costs were measured separately in
[`follow-up-measurements.json`](./follow-up-measurements.json), against a
41,152 ms baseline:

| Source | Cost | Share |
| --- | ---: | ---: |
| NFP cache-hit path, 6.92 µs x 262,166 hits | 1,814 ms | 4.41% |
| `Effect.gen` checkpoint composition | 1,289 ms | 3.13% |

**These two are not additive and must not be summed.** They were measured by
different methods against the same run — a sampled per-hit breakdown and a
standalone microbenchmark — and the regions they cover overlap, since
checkpoints fire inside the same candidate-generation work the hit timings span.
Neither figure is an independent slice of the run, so no combined ceiling is
derivable from them.

The checkpoint microbenchmark is the one that pointed at the change, because of
how it was built. Both of its arms run their checkpoint through `yield*` on a
live fiber; they differ only in whether the checkpoint body is an `Effect.gen`
(1,392 ms) or a direct `Effect.void` / `Effect.fail` (108 ms). **The 1,289 ms
difference is therefore generator construction alone, not fiber stepping.**
Telemetry recorded `directVoidCount: 0` — nothing was taking the cheap path.

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

### Protocol 1 — the preregistered run

Five alternating serial A/B pairs, same host. This is the run the agreed
acceptance criterion applies to.

| Pair | Baseline (ms) | Experiment (ms) | Speedup |
| ---: | ---: | ---: | ---: |
| 1 | 50,253 | 47,882 | 1.0495 |
| 2 | 51,769 | 49,789 | 1.0398 |
| 3 | 51,730 | 49,688 | 1.0411 |
| 4 | 52,665 | 48,940 | 1.0761 |
| 5 | 53,233 | 49,375 | 1.0781 |
| | | **median** | **1.0495** |

**Protocol 1 misses the 1.05x threshold**, by 0.05 percentage points.

The baseline arm drifted monotonically upward across the run — 50,253 ms rising
to 53,233 ms — which alternation only partly cancels and which inflates the
later pairs in both directions.

### Protocol 2 — an additional confirmatory run

Run after protocol 1 and declared in advance as the last. It is **not**
preregistered and its median does not substitute for protocol 1's.

| Pair | Baseline (ms) | Experiment (ms) | Speedup |
| ---: | ---: | ---: | ---: |
| 1 | 52,080 | 49,175 | 1.0591 |
| 2 | 52,902 | 49,835 | 1.0615 |
| 3 | 52,784 | 49,343 | 1.0697 |
| 4 | 54,152 | 49,820 | 1.0869 |
| 5 | 52,741 | 50,453 | 1.0454 |
| | | **median** | **1.0615** |

### Reading

Across both runs the per-pair speedup ranges from **1.0398 to 1.0869**, and six
of ten pairs individually clear 1.05.

The conclusion this supports is a **promising 4% to 8.7% speedup that requires
code review** — not an automatic acceptance. The preregistered protocol missed
its threshold. Protocol 2 clearing it is evidence that the effect is real and
that the five-pair median is sensitive to host noise near the bar; it is not a
substitute for the criterion that was agreed beforehand.

No pooled median is reported as a decision statistic here. Pooling ten pairs
after seeing that the first five missed would be choosing the summary that gives
the desired answer.

What the parity evidence below can carry, and what the 0.05-point miss should
cost, is a judgement for review rather than something these numbers settle.

## Parity

Exact, and it is the part with no ambiguity.

- **Canonical hash**: `ef2b783a…` in all twenty A/B runs, one distinct hash.
- **Work ledgers**: identical counter for counter in every pair —
  4,991,970 checkpoints (2,975,313 live / 2,016,657 inert), 266,977 NFP lookups,
  262,166 hits, 4,811 stores, 9,420 memo consultations, 32 memo hits.
- **Eighteen layouts**: `gate:compact-nine-baselines` reports `passed: true`,
  nine Compact and nine Short-Side, `directionalMissCount: 0`.
- **Test suite**: 841 passed, 6 failed, 17 skipped — identical counts and
  identical files to unmodified `9cffb49` on the same host. Both failing files
  are pre-existing; see below.
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

## Pre-existing suite failures, recorded not fixed

Neither is caused by this change, and neither is touched by it. Both reproduce
on unmodified `9cffb49`.

**1. `workspaceProjectService.test.ts`, 5 tests.** `better_sqlite3` native
binding fails to load in this sandbox (`Could not locate the bindings file`).
Environmental.

**2. `intrinsicStrictDecoder.test.ts:592`, 1 test.** A load-dependent flake, not
a code defect:

```
full suite,  unmodified 9cffb49 :  FAIL  (expected false to be true)
full suite,  this branch        :  FAIL  (identical assertion, identical line)
file alone,  this branch        :  PASS 3 of 3
```

`expect(phaseTimings.coverageComplete).toBe(true)` asserts a property of the
host, not of the code. `coverageComplete` reports whether the unmeasured
residual is small relative to the phase total
(`intrinsicStrictDecoder.ts:1347-1359`); under the suite's parallel workers a
scheduler slice exceeds the 0.05 ms instrumentation allowance, so the flag
correctly reports `false`.

A fix — asserting that each flag faithfully reports its own measurement rather
than asserting `true` — was written in #14 (`4ac115c`) and again in #16. Neither
merge took the hunk, and `toBe(true)` is on `main` today. **It is deliberately
not included here.** Carrying it through an unrelated optimization PR is how it
was lost twice; it needs its own change.

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
