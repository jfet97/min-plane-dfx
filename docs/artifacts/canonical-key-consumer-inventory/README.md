# Canonical key consumers: a retracted claim, and the real inventory

[`../canonical-key-cost-falsifications/README.md`](../canonical-key-cost-falsifications/README.md)
shipped with this assertion:

> these keys are used exclusively for equality and as memo keys, verified: there
> is no ordinal tie-break on them anywhere in the search

**It is false.** It was written without tracing the consumers, and reviewers were
right to push back on it. This document is the inventory that should have been
done first.

Every claim below is marked **verified** (read directly in the source while
writing this) or **reported** (found by an automated sweep, cited but not
independently re-read). Nothing acts on a *reported* line without re-reading it.

## The representative rule

`canonicalRingKey` (`irregularBeamState.ts:761-772`) picks a start vertex with
`lowestYThenXIndex` (`:789`) and a direction by minimising
`compareCanonicalPointSequences(forward, reverse)` (`:765`).

Changing either choice preserves the equivalence relation and changes every key
*value*. That part of the original analysis was correct. What follows is what
consumes those values.

## Ordering — the keys rank production search states

**verified**

| Site | Consequence |
| --- | --- |
| `windowedBeam.ts:2685` | `beamStateKey` returns `` `${state.canonicalOccupiedGeometryKey}::${remaining}::${unplaced}` `` — the canonical key is the **leading** bytes. |
| `windowedBeam.ts:2646-2652` | `makeStateOrder` = `[layoutScorer.compare, intrinsicGeometryStateCriterion, Order.mapInput(Order.String, (state) => state.key)]`. The last criterion is a lexicographic order on the string above. |
| `windowedBeam.ts:2639-2644` → `:2419`, `:807` | `rankScoredStates` feeds `productionRanked.slice(0, beamWidth)` and the final layout pick. On a score tie the key value alone decides which state survives. |
| `intrinsicCapacitySearch.ts:1769` | `compareCapacityBeamEntries` terminates in `compareStrings(first.anchoredOccupiedKey, second.anchoredOccupiedKey)`. All preceding criteria are exact integer/bigint grid metrics, so ties reach it. |
| `intrinsicCapacitySearch.ts:1795` | `compareCapacityBeamEntriesAreaFirst`, same terminal comparison. |
| `intrinsicStrictDecoder.ts:1661` | `compareLocalScores` terminates in `first.canonicalCombinedGeometryKey.localeCompare(second.canonicalCombinedGeometryKey)` — the decoder's per-step placement choice. |

**reported** — same shape, not re-read: `windowedBeam.ts:2636` (dedup
representative selection), `:1669` and `:1723` (protected-lane and Pareto-frontier
candidate picks, both bounded takes),
`intrinsicQueueBeamDiscriminator.ts:4699` (canonical key as the *leading*
criterion, not a tie-break), `:2325`, `:4195`, `:4717`,
`intrinsicStrictDecoder.ts:1621`, `:1640`.

Ties are reachable rather than theoretical: `layoutScoreOrder`
(`irregularLayoutScorer.ts:546-555`) terminates on `placementOrder` and
`unplacedSourcePieceIds` only, so two successors placing the same piece ids in
the same order at different offsets compare equal under the full scorer. The
tie-break criteria exist because the tie occurs.

### Order is baked into the key bytes themselves

**verified.** `canonicalEntryListKey` (`irregularBeamState.ts:865-871`) names its
fields `entry-${index}`, where `index` is the position in a lexicographically
sorted array — sorted at `:184` via `insertCanonicalEntryKey`/`compareCanonicalKeys`
(`:873-894`) and at `:316`, `:372`, `:436`, `:521` via `toSorted(compareCanonicalKeys)`.

So the *relative order* of two pieces' keys is part of the state-level key's
bytes. A value-only change to the representative rule propagates structurally
into `canonicalOccupiedGeometryKey` and everything derived from it.

## Serialization — raw key text is in committed artifacts

**verified.**

```
docs/artifacts/current-compact-baselines/shapes-17-300x300.json
    255 occurrences of  irregular-occupied-geometry-v2
22 files under docs/ contain raw canonical key text
sha256sum -c docs/artifacts/compact-short-side-observer/matrix/SHA256SUMS  →  all OK
```

Path to disk: `intrinsicCapacitySearch.ts:2062` puts `anchoredOccupiedKey`,
`decisionIdentity` and `parentDecisionIdentity` on a trace record →
`computeIrregularNesting.ts:1319` → `scripts/irregular-compact-baseline.ts:809` →
`writeFile` at `:830`.

The stored text embeds the representative choice directly — the first vertex of
each serialised ring is the `lowestYThenXIndex` pick.

**reported**: `scripts/irregular-intrinsic-v7-seed-archive.ts:1039` writes
SHA-256 digests *of the key strings* into `report.json`.

## Hashing that gates control flow

**reported**, not re-read, but consequential enough to list:
`intrinsicCapacitySearch.ts:1490-1537` hashes `canonicalOccupiedGeometryKey`,
`continuationMetadataIdentity()` and `anchoredOccupiedKey` into a checkpoint
integrity digest compared with strict `!==` at `:1276`;
`intrinsicStrictDecoder.ts:1054-1073` does the same over lineage fields,
validated at `:942`.

## Where the RNG seed comes from

**verified**, and worth isolating because it is the least obvious path:

```
canonicalCollisionPolygonKey            (irregularBeamState.ts:744)
  → canonicalLocalGeometryKey           (intrinsicExactProjection.ts:867-888)
  → catalog entry canonicalLocalGeometryKey / canonicalTransformKey
  → JSON.stringify(sorted catalog)      (intrinsicSqueezeDisruptSeparate.ts:901-911)
  → hashIntrinsicSeed(...)              (:912)
```

The canonical key text is an input to a search *seed*. A change to the
representative rule changes the seed, which changes the schedule, which changes
the layout — with no comparator involved at all.

## What survived

**verified.** `canonicalLayoutGeometry.ts` really is code-disjoint: it defines
its own `canonicalRing` / `canonicalRingDirection` (`:613-630`) with a different
algorithm and byte format, and its import closure never references
`irregularBeamState.ts`. The production SHA-256 layout identity is computed
there.

This does not rescue the original conclusion. The identity is
`sha256(canonicalCollisionLayoutIdentity(oriented.placedCollisionGeometries))`,
and `oriented` is whichever state the key-ordered search retained. A different
survivor hashes differently even though the hashing code never saw a key.

**verified.** The NFP/IFP geometry cache keys — `pairwiseNfpCacheKey`,
`innerFitBoundsCacheKey` — and `pointKey` are genuinely equality-only. Every
consumer routes through `cacheKeyToString` into a plain `Map` or `Set`: no sort,
no digest, no artifact. Optimisation work targeting *those* keys carries none of
the risk described above.

**reported honest negative.** There are no snapshot tests on key values: no
`.snap` files, no `toMatchSnapshot`, and no test hard-codes a literal key
substring. The tests that touch keys compare them to each other within one
process, which survives a rule change. Also reported: one already-stale checksum
in `docs/artifacts/intrinsic-anytime-pinned-lane/SHA256SUMS:29`, which is
therefore not evidence of anything.

## Consequence

The original framing — "a contract decision the gates cannot settle" — was
backwards because the representative participates in production ordering,
serialization, checkpoint integrity, and a seed. The maintained corpus would
catch changes to its exact covered layout hashes. Committed checksums detect
changes only when their artifacts are regenerated, and no existing gate proves
that every possible ordering tie is exercised.

Any future fast-key design must therefore:

1. keep a **byte-identical legacy key** for every ordering, serialization and
   digest consumer;
2. introduce the fast key **only** for pure-equality consumers;
3. prove **comparator-sign parity** between the two across the corpus;
4. clear a materially higher bar than the ~2% ceiling that
   [`../canonical-key-cost-falsifications/README.md`](../canonical-key-cost-falsifications/README.md)
   established for local optimisation, because the risk is now known to be
   larger.
