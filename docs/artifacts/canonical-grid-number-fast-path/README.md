# Exact Number fast path for the canonical grid orientation predicate

Evidence for issue #11 §3.8, taken out of sequence because the measurements in
§3.6 did not survive contact with the profiler. See "Why this came before the
dedup keys" below.

## Result

The controlled local comparison uses the immediate parent and the exact
implementation commit on the same host:

| Commit | Mixed-61 `2000 x 2700` | Relative |
| --- | ---: | ---: |
| `e34f850` parent | 48,645.62 ms | 1.000 |
| `48fc203` exact Number cross sign | **43,015.86 ms** | **1.131x** |

That is an 11.57% wall-time reduction. Both reports preserve the collision
identity hash, fitted canonical hash, bounds, canonical topology,
placed/unplaced partition, focused evaluation ledger, and every strict check.
The full maintained gate separately reproduced all nine Compact and nine Short
Side layouts with exact accepted hashes and work ledgers.

The profiled run at `48fc203` took 43,546.19 ms and produced the same logical
result as the 43,015.86 ms unprofiled run. Its categorized samples place
canonical-grid exact math at 1.29 s (2.9%); `canonicalGridCross` is no longer a
top function. See `mixed-61-2000x2700.after-profile-analysis.txt`.

## Environment and reproduction

```
before commit  e34f8505b8238a840859c830ac41ca4bc90eee07
after commit   48fc20375b5273de65e6e2ee13be79c46af5de35
case           mixed-61, sheet 2000x2700
node           v24.16.0
v8             13.6.233.17-node.49
os             Darwin 25.5.0, arm64
machine        Mac16,9
build mode     tsx (source, no bundling)
```

Run the unprofiled report at each commit:

```sh
TSX_TSCONFIG_PATH=tsconfig.node.json \
node --import tsx scripts/irregular-compact-baseline.ts \
  --fixture mixed-61 --sheet 2000x2700 \
  --output-prefix <prefix> \
  --capture-short-side-observer \
  --capture-short-side-pair-fold-observer \
  --strict
```

Run and categorize the after profile:

```sh
TSX_TSCONFIG_PATH=tsconfig.node.json \
node --cpu-prof --cpu-prof-dir=<dir> \
  --cpu-prof-name=mixed-61-2000x2700.after.cpuprofile \
  --cpu-prof-interval=500 \
  --import tsx scripts/irregular-compact-baseline.ts \
  --fixture mixed-61 --sheet 2000x2700 \
  --output-prefix <prefix> \
  --capture-short-side-observer \
  --capture-short-side-pair-fold-observer \
  --strict

pnpm exec tsx --tsconfig tsconfig.node.json scripts/analyze-cpu-profile.ts \
  --profile docs/artifacts/canonical-grid-number-fast-path/mixed-61-2000x2700.after.cpuprofile.gz \
  --inclusive-filter src/shared/irregular/domain
```

## What the change is

All four call sites of `canonicalGridCross` consume only the sign:

| Call site | Use |
| --- | --- |
| `canonicalGridMath.canonicalGridConvexHull` | `turn > 0n` |
| `canonicalGridMath.canonicalGridPointOnSegment` | `cross === 0n` |
| `canonicalGridContact.canonicalGridCollinearOverlap` | `!== 0n`, twice |

`canonicalGridCrossSign` therefore returns `-1 | 0 | 1 | undefined` and computes
the sign in `Number` when the operands are provably exact, falling back to the
`bigint` value otherwise. `canonicalGridCross` is unchanged and remains exported
as the differential-test oracle.

## Why the fast path cannot round

With every coordinate bounded by `L`:

- each difference is at most `2L`;
- each product is at most `4L^2`;
- their difference is at most `8L^2`.

Choosing `L = 2^25 - 1` gives `8L^2 = 2^53 - 2^29 + 8`, strictly below
`Number.MAX_SAFE_INTEGER`. No intermediate value can round, so the sign is exact
by construction rather than by tolerance.

In canonical grid units of a thousandth of a millimetre that bound covers
`±33.5 m`, more than twelve times the largest dimension in the maintained
production gates. The bound is checked on the operands **before** any
multiplication, which is the only ordering that works: converting an
already-rounded `Number` back to `bigint` cannot recover exactness.

Coordinates outside the bound are not approximated and not rejected — they take
the exact `bigint` path. This matters: the repository's own grid tests exercise
coordinates near `900,000,000`, roughly twenty-seven times the fast-path bound,
so the fallback is live and covered rather than theoretical.

## Tests

`tests/unit/canonicalGridMath.test.ts` compares `canonicalGridCrossSign` against
the sign of the exact `bigint` oracle over 3,600 deterministic pseudo-random
triples spanning nine coordinate-magnitude buckets: `1`, `1,000`, `2,700,000`,
`L - 1`, `L`, `L + 1`, `2^31`, `900,000,000`, and
`Number.MAX_SAFE_INTEGER`.

Explicit adversarial cases cover both signs of `L + 1`, mixed-sign coordinates
at `Number.MAX_SAFE_INTEGER`, collinear safe-integer extremes, and an unsafe
integer. The suite also covers coincident, negative, and signed-zero inputs and
asserts that a single grid unit still flips the orientation at the largest
admitted fast-path magnitude.

The sequence is seeded rather than `Math.random`, so a failure reproduces.

## Why this came before the dedup keys

Issue #11 ordered hash-assisted dedup (§3.6) before the `bigint` fast paths
(§3.8). Two measurements taken after the previous change reversed that:

1. **The dedup key cost is not allocation.** An allocation-free rewrite of
   `canonicalRingKey` producing byte-identical output was prototyped and
   benchmarked: `5,865 ns` to `5,309 ns`, a `9.5%` improvement on the function
   and roughly `1.7%` of the run. Not worth a change.
2. **The cost is intrinsic string construction at volume.** Instrumenting a full
   run counted `4,944,263` calls to `canonicalRingKey` producing `676,054`
   distinct results — an `86.3%` repeat rate — at `161` characters average.
   Removing that cost means not building strings at all, which means replacing
   string-keyed maps and sets with hash-plus-structural-equality containers
   across roughly eight modules, or redesigning the canonical form to be
   translation-equivariant so the key can be derived from a precomputed local
   identity. Both are real changes with real risk to the dedup relation.

The orientation predicate, by contrast, has a local and checkable correctness
criterion: does the `Number` path produce the same sign as `bigint` for every
input the guard admits? That is provable and testable in isolation, so it went
first.

The dedup keys remain the largest single block at `19.3%` and are still worth
doing. They now need the design decision above rather than a micro-optimization.

## Files

- `mixed-61-2000x2700.before.json` — parent-commit unprofiled report;
- `mixed-61-2000x2700.after.json` — implementation-commit unprofiled report;
- `mixed-61-2000x2700.after-profiled.json` — implementation-commit profiled report;
- `mixed-61-2000x2700.after.cpuprofile.gz` — implementation-commit raw V8 profile;
- `mixed-61-2000x2700.after-profile-analysis.txt` — reproducible profile categorization.
