# JS-Semantics Audit: `src/workers/` and `src/shared/`

Cluster: `js-semantics-audit`. This document is a **horizontal** sweep across the
entire irregular-nesting source tree (`src/workers/**`, `src/shared/**`) for
JavaScript-specific runtime semantics that a byte-for-byte Rust port must
reproduce deliberately rather than accidentally approximate. It complements,
rather than duplicates, the 14 sibling characterization documents in this
directory, each of which already characterizes one subsystem's full behavior
(state machine, control flow, cache access sequence, etc.) in depth. Where a
sibling document already gives an exhaustive, source-verified account of a
specific site, this document cites it by file name and does not re-derive the
full context — it instead (a) verifies the claim against the source, (b)
places it in the horizontal category it belongs to, and (c) flags any
cross-cluster inconsistency that no single per-cluster document could see.
Where this audit found something no sibling document flags, it is marked
**NEW** and treated with full original depth.

Methodology: systematic `grep -rn` sweeps across `src/workers` and
`src/shared` for every pattern named in the task brief (`.sort`/`.toSorted`,
`localeCompare`, string comparison operators, `Map`/`Set` iteration,
`Object.keys/entries/values/fromEntries`, `JSON.stringify`/`JSON.parse`,
`BigInt`/`.toString()`, `Number`/`.toFixed`/template-literal number
rendering, `Math.*`, `Object.is`/`-0`, `Number.isSafeInteger`/`isFinite`,
`undefined`-vs-missing spread idioms), followed by targeted `Read` of every
distinct call site and its enclosing function to determine whether the
result reaches canonical output, a hash, a cache key, a comparator, or a
trace, or is purely diagnostic. All file:line references were verified
against the working tree at the commit checked out when this document was
written (branch `rust-irregular-backend`).

**Total pattern counts found in `src/workers/` + `src/shared/` (this audit's raw sweep):**

| Pattern | Count | Files |
|---|---|---|
| `.sort(`/`.toSorted(` call sites | 277 | ~55 |
| Named `compare*` comparator function definitions | 114 | ~45 |
| `.localeCompare(` call sites | 135 | 26 |
| `JSON.stringify(`/`JSON.parse(` | 43 | 21 |
| `Object.keys`/`Object.entries`/`Object.values`/`Object.fromEntries` | 20 | 5 |
| `Object.is(` | 18 | 15 |
| `Math.*` calls | 744 | ~50 |
| `Number.isSafeInteger`/`Number.isFinite`/`Number.isInteger`/`isFinite`/`isNaN` | 292 | ~45 |
| `.toString()` (non-`JSON.stringify`) | 27 | 10 |
| `.toFixed(` | 1 | 1 |

---

## 1. Purpose and role in Compact / Compact Short Side execution

This cluster has no single "module" — it is every file under `src/workers/`
and `src/shared/` that the Compact and Compact Short Side irregular pipeline
touches. Per-file liveness (which of the ~100 files under `src/workers/`
actually execute on the production `computeIrregularNesting` path for these
two profiles, as opposed to being shadow/observer-only or dead) has already
been traced file-by-file by the 14 sibling documents; §1 of each sibling
document contains the authoritative caller-traced liveness table for its
files. This document does not re-trace liveness for files already covered
(cross-reference table below) and only adds liveness notes for primitives
that no sibling document owns (`canonicalGridMath.ts`, the canonical-key
machinery private to `irregularBeamState.ts`, `src/shared/domain/ids.ts`,
`src/shared/protocol/*.ts`).

**File → owning sibling doc (verified by grep of each doc for the filename basename):**

| File | Owning doc(s) |
|---|---|
| `intrinsicCapacityMode.ts`, `intrinsicCapacityPreflight.ts`, `intrinsicCapacityMaterial.ts`, `intrinsicCapacityEndpoint.ts`, `intrinsicCapacityPrefixes.ts` | `capacity-core.md` |
| `intrinsicCapacitySearch.ts`, `intrinsicCapacityTelemetry.ts` | `capacity-search.md` |
| `collisionGeometryBuilder.ts`, `transformCollisionGeometry.ts`, `core/transformCollisionGeometryCore.ts` | `collision-prep.md` |
| `src/shared/protocol/errors.ts`, `ipc.ts`, `worker.ts`, `decisionTrace.ts` | `errors-protocol.md` |
| `nfpIfpService.ts`, `nfpIfpTelemetry.ts`, `core/ifpBoundsCore.ts`, `core/nfpBoundaryCore.ts`, `core/nfpCacheKey.ts` | `nfp-ifp.md` |
| `intrinsicPeriodicCells.ts`, `intrinsicPeriodicFamilyPortfolio.ts`, `intrinsicPeriodicSmallFillE3.ts` | `periodic.md` |
| `irregularLayoutScorer.ts`, `irregularPlacementScorer.ts`, `irregularScoreGrid.ts`, `windowedBeam.ts` | `search-scoring.md` |
| `intrinsicSharedArchivePortfolio.ts`, `intrinsicAnytimeArchive.ts`, `intrinsicV7SeedArchive.ts` | `shared-archive.md` |
| `intrinsicStrictDecoder.ts`, `intrinsicStrictFamilyPortfolio.ts`, `intrinsicGapRegions.ts` | `strict-decoder-gap-family.md` |
| `placementValidation.ts`, `placedCollisionSpatialIndex.ts`, `geometryPredicates.ts`, `convexSatPenetration.ts` | `validation-spatial.md` |
| `nesting.worker.ts`, `computeNesting.ts`, `computeIrregularNesting.ts`, `decisionTraceNdjson.ts` | `worker-coordination.md` |
| `intrinsicReconstructionPortfolio.ts`, `intrinsicTwoPieceInterfaceReconstruction.ts`, `intrinsicDetachedPieceReinsertion.ts`, `intrinsicComponentInterfaceClosure.ts` | `reconstruction.md` |
| `core/geometryCacheStore.ts`, `core/geometryCacheIdentity.ts`, `geometryCacheStoreLive.ts`, `geometryCacheKeys.ts` | `geometry-caches.md` |
| `intrinsicShortSideAxes.ts`, `intrinsicShortSideContactStrip.ts`, `intrinsicShortSideObserver.ts`, `intrinsicShortSidePairFoldObserver.ts` | `short-side.md` |

All other files under `src/workers/algorithm/irregular/` (e.g.
`intrinsicSqueezeDisruptSeparate.ts`, `intrinsicGlobalSqueezePortfolio.ts`,
`intrinsicQueueBeamDiscriminator.ts`, `targetedExactLns.ts`,
`intrinsicTransformSeparator.ts`, `intrinsicExactProjection.ts`,
`intrinsicPlaceDeferCompleteShadow.ts`, `portfolioSearch.ts`,
`priorityOrderService.ts`, `overlapRelaxation.ts`/`overlapRelaxationV1.ts`)
are each covered by two or more sibling docs simultaneously (verified via
cross-grep; every file above with no dedicated row is imported by at least
one file the table above already covers). `src/workers/algorithm/maxRects/*`
and `src/workers/algorithm/beam/*` implement the **rectangular** nesting
algorithm and generic beam-search scaffolding shared with rectangular —
per the migration prompt §1 ("Keep the existing rectangular nesting
algorithm... in TypeScript"), `maxRects/freeRectangles.ts` and
`maxRects/placements.ts` are **not in scope for the Rust port** (rectangular
stays TS). `beam/state.ts`, `beam/candidates.ts`, `beam/seed.ts` are generic
scaffolding parameterized by `nestingAlgorithm.ts`/`sortPiecesForNesting.ts`;
`beam/state.ts:129`'s bare `.toSorted()` (§5) operates on
`string`-typed piece-id-derived keys for the rectangular/generic beam and is
out of scope for the same reason unless the irregular profiles are proven to
route through it (they do not — irregular uses `windowedBeam.ts`'s own beam
machinery, confirmed by `search-scoring.md` §1/§2).

`src/shared/domain/ids.ts` (`PieceId`/`SourceFileId`/`JobId`/`FreeRectId`
brands) is imported transitively by every domain type in every sibling
cluster; its `Math.random()`-based ID-generation fallback (§7, §12) is **not
live** on the nesting hot path — see the liveness proof in §12.

---

## 2. Entry points, callers, callees

Not independently re-traced here; `worker-coordination.md` §2 already traces
`nesting.worker.ts` → `computeNesting.ts` → `computeIrregularNesting.ts` as
the single production entry point for both Compact and Compact Short Side.
This audit's "entry points" are instead **the call sites of each JS-semantics
primitive** — i.e., every place a comparator, a canonical encoder, or a
numeric-formatting helper is invoked. Those call graphs are enumerated in
§5–§8 below, verified with `grep -rn` against the current tree, not
estimated.

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission

Relevant to this audit (not a full data-shape catalog — see per-cluster docs
for that):

- **`PieceId`/`SourceFileId`/`JobId`/`FreeRectId`** (`src/shared/domain/ids.ts:7-10,49-58`) are nominal string brands (`Schema.brand`, an Effect Schema construct). At the Rust/N-API boundary these must decode to plain owned `String`/newtype-wrapped `String` — the brand itself carries no runtime representation difference from `string`, so no special Rust encoding is needed beyond a newtype, but **every place a `PieceId` is used as a `Map`/comparator key relies on plain string equality/ordering**, not any brand-aware comparison.
- **`Record<string, number>` rejection-reason maps** (`intrinsicPeriodicCells.ts` `rejected` field, §5 item and cross-referenced in `periodic.md:185`) — built from a `Map<string, number>`, converted to a plain object via `Object.fromEntries` for JSON-shaped diagnostic output. Field presence is exactly the map's key set; there is no optional-omission subtlety beyond what `periodic.md:134` already documents for `hasOwnProperty`-gated domain-class fields (`IrregularPlacement.pieceId`/`interchangeabilityKey`/`priorityOrderKey`, `src/shared/irregular/domain.ts:694-712,644-661`) — **true own-property omission**, not `undefined`-valued presence. `Object.keys`/`Object.entries`/`JSON.stringify` do not see the key at all when omitted; a Rust port must model this as a field the serializer skips entirely (`Option<T>` + `#[serde(skip_serializing_if = "Option::is_none")]` or equivalent bespoke logic matching the specific custom encoder, not `null`).
- **Checkpoint envelope types** (`IntrinsicAnytimeCheckpoint`, `IntrinsicStrictDirectCheckpoint`) each carry their own `integrityHash: string` field computed by a *different* canonical encoder (§8) — this is a data-shape fact with direct bearing on §8's finding that there is no single unified "canonical checkpoint JSON" type in the source.
- **Decision-trace events** (`IrregularDecisionTraceEvent`, `decisionTrace.ts`, owned by `errors-protocol.md`) are serialized with **plain** `JSON.stringify(event)` (`decisionTraceNdjson.ts:36`, `nesting.worker.ts:108`) — field order is **insertion order** (object literal property declaration order at each event-construction call site), not sorted. This is a different serialization regime from the sorted canonical encoders in §8 and must not be conflated with them in the Rust port (see §8's "two regimes" finding).

---

## 4. Algorithm state and every mutation point

Not applicable as a single state machine — this audit is horizontal.
Sibling docs enumerate mutation points per subsystem. The state most
directly relevant to this audit is the **key-derivation state** implicit in
comparator/encoder helper functions, all of which are pure (no closure
mutation) with one partial exception:

- `insertCanonicalEntryKey` (`irregularBeamState.ts:873-888`) performs an
  **explicit stable-sorted insertion** into a frozen array copy (linear scan
  for the first element `compareCanonicalKeys`-greater than the new key,
  `splice` insert there, `Object.freeze` the result) rather than
  `push` + `.toSorted()`. This is behaviorally equivalent to appending then
  stable-sorting by `compareCanonicalKeys` (verified: the scan finds the
  first existing entry strictly greater than the new key and inserts before
  it, which reproduces stable insertion-sort placement for a list that is
  already sorted on entry — the invariant this function's every caller
  relies on). A Rust port using `Vec::binary_search` + `insert` is
  behaviorally identical *only if* the array is provably already sorted at
  every call (true here, since this is the sole mutator) — a linear
  `Vec::insert` scan is also fine and avoids re-proving the invariant.

---

## 5. Ordering sources

### 5.1 `.sort()`/`.toSorted()` — stable-sort reliance

Both `Array.prototype.sort` and `Array.prototype.toSorted` are
**specification-guaranteed stable** in ECMAScript (since ES2019); V8 has
implemented this since Node 11. Every one of the 277 call sites found in
this sweep therefore preserves relative order among elements the comparator
treats as equal. **A Rust port must use a stable sort for every one of
these** (`slice::sort_by`/`sort_by_key`, which are stable; `sort_unstable_by`
is `Cmp`-only and stability is not guaranteed — never substitute it for a
site whose comparator has a possible zero return). Per-cluster docs already
verify, for their own comparators, whether ties are actually reachable and
whether stability is load-bearing; where a comparator is a genuine total
order (no possible tie), stability doesn't matter for that specific site but
the Rust implementation should still default to a stable sort as a project
policy, since a future TS edit that loosens a comparator to allow ties would
silently rely on stability without a corresponding Rust change being forced.

### 5.2 Comparator taxonomy (114 named `compare*` functions)

Three orthogonal string-ordering primitives coexist in this codebase and
**must not be treated as interchangeable**:

1. **Plain `<`/`>` (code-unit / UTF-16 lexicographic) comparison** —
   e.g. `compareStrings` (`intrinsicCapacitySearch.ts:2233-2237`),
   `compareCanonicalKeys` (`irregularBeamState.ts:867-871`). Both are
   textually identical three-line `first < second ? -1 : first > second ? 1
   : 0` bodies, independently written in each file (not a shared utility).
   JS `<`/`>` on strings compares **UTF-16 code units**, which for
   pure-BMP (non-surrogate-pair) content is identical to Rust's `str`/`&str`
   `Ord` (byte-wise UTF-8 comparison, which agrees with code-point order,
   which agrees with UTF-16 code-unit order for all code points below
   `U+10000`). They diverge only for supplementary-plane characters
   (surrogate pairs) — Rust's UTF-8 byte order still equals code-point
   order for supplementary characters, but JS's UTF-16 code-unit order does
   **not** (a lone high surrogate sorts between `U+D800` and `U+DBFF`,
   i.e. *before* all of `U+E000..U+FFFF` but *after* all of `U+0000..U+D7FF`,
   whereas the actual supplementary code point it's paired with is
   `>= U+10000`). Piece IDs/keys in this codebase are almost always
   ASCII or short generated identifiers, but any comparator fed a
   **user-supplied label or `source.id`** (several are, per `periodic.md:343`)
   is theoretically exposed to this divergence. Rust equivalent: implement
   code-unit comparison explicitly (`str::encode_utf16().cmp(...)`), do
   **not** assume `str::cmp` (UTF-8 byte order) is always equivalent —
   prove it per input domain or use the UTF-16 comparison unconditionally
   for safety.

2. **`String.prototype.localeCompare`** — 135 call sites across 26 files
   (table in the header). Invokes ICU-backed ECMA-402 `Intl.Collator`-style
   collation under Node's **default locale** (confirmed on this machine:
   Node v24.18.0, `icu_small: false` i.e. full-ICU build, `new
   Intl.Collator().resolvedOptions().locale === 'en-US'`). This is
   fundamentally a different algorithm from (1): base-letter ordering
   generally coincides with ASCII order for the unaccented Latin alphabet,
   but case, punctuation, and digit interleaving are governed by ICU's
   default collation tailoring, not code-point value. `periodic.md:343`,
   `search-scoring.md:600-609,1511-1517`, and
   `strict-decoder-gap-family.md:534,568` already identify this as the
   single highest mechanical-port risk in their respective clusters. This
   audit's contribution is the **complete cross-file inventory** (below) and
   the observation that **no two files share a `localeCompare`-based
   comparator implementation** — each of the 26 files below re-derives its
   own `.localeCompare(...)` call inline rather than calling a shared
   ordering utility, so a Rust port must supply an ICU-equivalent collator
   (e.g. `icu_collator`/`rust_icu` tuned to Node's default-locale root
   collation) and route **every one of these 135 call sites** through it,
   not just the ones sibling docs already flagged:

   | File | `localeCompare` sites | Sibling doc covering it |
   |---|---:|---|
   | `intrinsicSqueezeDisruptSeparate.ts` | 27 | none dedicated (cross-referenced by `nfp-ifp.md`, `search-scoring.md`, `errors-protocol.md`, `collision-prep.md`) |
   | `intrinsicV7SeedArchive.ts` | 15 | `shared-archive.md`, `search-scoring.md` |
   | `intrinsicQueueBeamDiscriminator.ts` | 14 | `validation-spatial.md`, `search-scoring.md`, `nfp-ifp.md` |
   | `intrinsicStrictDecoder.ts` | 9 | `strict-decoder-gap-family.md` |
   | `intrinsicTransformSeparator.ts` | 8 | `search-scoring.md` |
   | `intrinsicPeriodicCells.ts` | 8 | `periodic.md` |
   | `intrinsicPeriodicFamilyPortfolio.ts` | 7 | `periodic.md` |
   | `targetedExactLns.ts` | 6 | `search-scoring.md` |
   | `intrinsicTwoPieceInterfaceReconstruction.ts` | 6 | `reconstruction.md` |
   | `intrinsicDetachedPieceReinsertion.ts` | 4 | `reconstruction.md` |
   | `canonicalLayoutGeometry.ts` | 3 | none dedicated (imported by `validation-spatial.md`, `search-scoring.md`) — **NEW**, see below |
   | `intrinsicShortSidePairFoldObserver.ts` | 3 | `short-side.md` |
   | `intrinsicReconstructionPortfolio.ts` | 3 | `reconstruction.md` |
   | `intrinsicExactProjection.ts` | 3 | `search-scoring.md` |
   | `intrinsicComponentInterfaceClosure.ts` | 3 | `validation-spatial.md` |
   | `intrinsicCapacityEndpoint.ts` | 3 | `capacity-core.md` |
   | `intrinsicShortSideObserver.ts` | 2 | `short-side.md` |
   | `intrinsicSharedArchivePortfolio.ts` | 2 | `shared-archive.md` |
   | `intrinsicGapRegions.ts` | 2 | `strict-decoder-gap-family.md` |
   | `placedCollisionSpatialIndex.ts` | 1 | `validation-spatial.md` |
   | `freeMaterialService.ts` | 1 | none dedicated — **NEW**, see below |
   | `windowedBeam.ts` | 1 | `search-scoring.md` |
   | `portfolioSearch.ts` | 1 | `search-scoring.md`, `worker-coordination.md` |
   | `irregularBeamState.ts` | 1 | `search-scoring.md` |
   | `intrinsicStrictFamilyPortfolio.ts` | 1 | `strict-decoder-gap-family.md` |
   | `intrinsicGlobalSqueezePortfolio.ts` | 1 | none dedicated — **NEW**, see below |

   **NEW — `canonicalLayoutGeometry.ts`** (3 sites, e.g. line ~222 sorting
   canonical polygon strings, line ~565 sorting components): this file
   builds `positiveContactPairs`/`positiveAreaConflicts` diagnostics and
   `canonicalCollisionLayoutIdentity` reachable from
   `intrinsicStrictCanonicalJson`'s `frozenGeometryIdentity` field (§8) —
   i.e. its `localeCompare`-sorted order **can** feed a SHA-256 checkpoint
   hash transitively. Must be included in the collation-parity test matrix,
   not just treated as a diagnostics-only file.

   **NEW — `freeMaterialService.ts:?`** and **`intrinsicGlobalSqueezePortfolio.ts:?`**:
   single `localeCompare` call sites, low volume but still must route
   through the same collator as everything else — a Rust port that
   "handles the big files" and treats a 1-call-site file as negligible
   risks a silent divergence exactly where no test happens to probe it.

3. **Bare `.toSorted()`/`.sort()` with no comparator argument** — per
   ECMA-262 `Array.prototype.sort`, when no comparator is supplied, elements
   are first converted `ToString` (via `SortCompare`'s default: `undefined`
   elements sort last, then remaining elements are compared as strings using
   code-unit `<`), so bare-sort on an array of **numbers** silently performs
   **string** comparison (`[10, 2, 1].sort()` → `[1, 10, 2]`, not
   `[1, 2, 10]`) and bare-sort on an array of **tuples/objects** implicitly
   stringifies each element via `Array.prototype.toString`
   (`[a,b].toString()` = `` `${a},${b}` ``, or `Object.prototype.toString`
   → `"[object Object]"` for non-array objects, which would make every
   element compare equal). This audit verified every bare `.toSorted()`/
   `.sort()` call site's element type; **none operate on bare numbers** (the
   number-array footgun does not currently fire anywhere in this cluster —
   confirmed by reading each of the ~35 bare-sort call sites), but two
   confirmed, source-verified **tuple-stringification** sites exist and are
   already documented in depth by `periodic.md:185,343` (reproduced here for
   completeness because they are the highest-severity instance of this
   category and directly feed a diagnostic field, not because this audit
   found them independently):
   - `intrinsicPeriodicCells.ts:531,689,1144`:
     `Object.fromEntries([...rejected.entries()].toSorted())` where
     `rejected: Map<string, number>` — sorts `[string, number]` tuples by
     converting each to `` `${key},${count}` `` and comparing as strings.
     Because `Map` keys are unique, this collapses in practice to
     "compare by key string, with the numeric suffix only breaking ties
     between keys where one is a literal string-prefix of another" — but
     it is **not** simply "sort by key," and a Rust port that swaps in
     `BTreeMap<String,u64>`'s natural key-only ordering is subtly wrong for
     any pathological prefix-collision key set, however unlikely in
     practice. Must be reproduced as literal tuple-to-string-then-compare.

   All other bare `.toSorted()` sites operate on `ReadonlyArray<string>`
   (piece-ID arrays, canonical-key/variant-string arrays — e.g.
   `intrinsicReconstructionPortfolio.ts:594`, `intrinsicStrictDecoder.ts:1249-1250,1379`,
   `intrinsicTwoPieceInterfaceReconstruction.ts:132,137,480`,
   `intrinsicDetachedPieceReinsertion.ts:105,268`,
   `intrinsicExactProjection.ts:225,232`,
   `intrinsicSqueezeDisruptSeparate.ts:1002-1003,1667-1668`,
   `intrinsicGlobalSqueezePortfolio.ts:718-719,730-731`,
   `intrinsicComponentInterfaceClosure.ts:487`,
   `targetedExactLns.ts:466,475`, `windowedBeam.ts:1782,2684`,
   `intrinsicTransformSeparator.ts:1295`,
   `intrinsicPeriodicCells.ts:2195`, `intrinsicQueueBeamDiscriminator.ts:2431,3310`,
   `beam/state.ts:129` (out of scope, §1)) — for these, bare sort ==
   category-1 code-unit string comparison, which Rust's default `Vec<String>`
   `sort()` (byte-wise UTF-8) reproduces correctly for the ASCII/BMP content
   these arrays actually carry, but formally still needs the same
   supplementary-plane caveat as category 1.

### 5.3 `Map`/`Set` iteration order reaching output

JS `Map` and `Set` preserve **insertion order** (ECMA-262
`OrderedHashMap`/`OrderedHashSet` semantics) for both `.keys()`/`.values()`/
`.entries()`/`for...of` and the spread operator. Every one of the following
constructs relies on this and **must not be replaced by Rust's `HashMap`/
`HashSet`** (which have no deterministic iteration order and are typically
randomized per-process): any `[...someMap.entries()]`,
`[...someMap.values()]`, `[...someSet]`, `Object.fromEntries([...map])`
pattern found in this sweep. Representative confirmed sites beyond what
sibling docs already cover:

- `irregularScoreGrid`/`irregularBeamState` `nearCompleteStructuralContactSignatureCounts`
  (`irregularBeamState.ts:166`, `[...this.nearCompleteStructuralContactSignatureCounts.entries()].toSorted(...)`)
  — insertion order feeds the *input* to an explicit sort, so final order is
  comparator-determined, not insertion-order-determined; the insertion order
  only matters as the **tie-break** for elements the comparator treats as
  equal (stability, §5.1).
- `intrinsicPeriodicCells.ts:531,689,1144` (§5.2 item 3) — `Map` iteration
  order here is irrelevant to the *final* string (the bare `.toSorted()`
  fully re-orders), but is exactly the "insertion order feeds a sort input"
  pattern generally and worth flagging as the safe case: **when a `Map`'s
  iteration order feeds an explicit total-order sort with no ties, Rust's
  `HashMap` + explicit sort afterward is safe; when it does not (§5.4,
  `Object.fromEntries` with no subsequent sort, or any direct spread into an
  output array/string), it is not.**
- `nfpIfpTelemetry.ts:146,152` — `[...current.namespaces].toSorted(([a],[b])=>...)`,
  `[...current.checkpointsByPhase].toSorted(...)` — same safe pattern
  (Map → sort), owned by `nfp-ifp.md`.
- `core/geometryCacheStore.ts` and cache-store implementations
  (`geometry-caches.md`, not re-derived here) use `Map` for actual lookup
  tables where iteration order is never observed (pure key→value lookup) —
  these are **safe** to back with Rust `HashMap`/`DashMap` since no ordering
  guarantee is relied on, per `geometry-caches.md`'s own analysis.

### 5.4 `Object.keys`/`Object.entries`/`Object.fromEntries` — integer-key reordering hazard (NEW)

Per ECMA-262 `OrdinaryOwnPropertyKeys` (`10.1.11.1`, invoked by
`Object.keys`/`Object.values`/`Object.entries`/`for...in`/`JSON.stringify`'s
own-property enumeration and `Object.fromEntries`'s resulting object), own
string property keys are iterated in a specific order: **first, all keys
that are canonical array-index strings (non-negative integers ≤
2³²−2, no leading zero, as produced by `ToString` of the integer), in
ascending numeric order — regardless of insertion order — then all other
string keys in insertion order.** This is a well-known JS engine behavior
distinct from "objects preserve insertion order," which is only true for
non-integer-like keys.

This audit found one **currently latent but live** instance of exactly this
hazard: `intrinsicQueueBeamDiscriminator.ts:766-810` builds
`experimentalWidthRoles`/`survivesAtTotalCapacities`/
`survivesAtExperimentalWidths` via
`Object.fromEntries(experimentalWidths.map((width) => [String(width), ...]))`
where `experimentalWidths = [0, 1, 3, 7, 12] as const`
(`intrinsicQueueBeamDiscriminator.ts:756`) and
`capacities = [1, 2, 4, 8, 13] as const` (`intrinsicQueueBeamDiscriminator.ts:755`).
The string keys produced (`"0"`,`"1"`,`"3"`,`"7"`,`"12"` and
`"1"`,`"2"`,`"4"`,`"8"`,`"13"`) are all canonical array-index strings, so
per spec their `Object.keys`/`Object.entries`/`JSON.stringify` enumeration
order is **forced ascending numeric**, not insertion order. Because both
source literal arrays already happen to be listed in ascending order, there
is **no currently observable divergence** between "as constructed" and
"as the spec mandates" — but this is exactly the kind of invisible
dependency the migration prompt warns about: if either literal array is ever
edited to a non-ascending order (e.g. reordered for readability, or a value
inserted out of order) in a future TS change, `Object.keys`/`Object.entries`/
any downstream `JSON.stringify` of these fields would **silently** revert to
ascending order regardless of the new array order, while a naive Rust
port using an order-preserving map (`IndexMap`, `Vec<(String,T)>`, or
`serde_json::Map` with `preserve_order`) would **not** — it would preserve
whatever order the Rust equivalent of `experimentalWidths`/`capacities` is
iterated in. **Recommendation: the Rust port must emit these two `Record`
fields in ascending-numeric-string-key order unconditionally** (not
"whatever order the source `[u32; 5]` literal is in"), to be spec-faithful
independent of future source-array reordering, and a differential/golden
test should assert this specific field's key order rather than relying on
today's already-sorted literals to mask the hazard. This delayed-lineage
diagnostic block (`intrinsicQueueBeamDiscriminator.ts:783-810`) is
calibration/diagnostic tooling (used to measure whether the "protected"
reference candidate survives at various experimental beam widths) — grep of
its only consumer (`delayedLineage`, assigned at line 783) shows it feeds a
debug/telemetry field, not placement selection; confirm this against
`validation-spatial.md`'s or `search-scoring.md`'s liveness trace for
`intrinsicQueueBeamDiscriminator.ts` before deciding whether it needs
byte-exact Rust parity or can be dropped as non-authoritative diagnostics
per prompt §13.7 (cache/backend telemetry must not enter canonical output —
if this is genuinely diagnostic-only and never reaches a hash/trace/decision
this may be out of scope entirely; flagged as an open question, §15).

No other `Object.fromEntries`/`Object.keys` site in this sweep builds
canonical-array-index-like string keys from a source array that isn't
already sorted ascending — the `rejected: Record<string,number>` maps
(§5.2 item 3) use non-numeric diagnostic-reason strings
(`"invalidMovingGrid"` etc., per `periodic.md:336`), so the integer-key
reordering rule never applies there.

### 5.5 Iteration order that reaches selection/output beyond the above

Covered exhaustively per-subsystem by sibling docs (`shared-archive.md`
for archive iteration, `capacity-search.md`/`capacity-core.md` for beam
frontier iteration, `periodic.md` for cell-enumeration order, `short-side.md`
for portfolio-branch order). No additional cross-cutting finding beyond
§5.1–§5.4.

---

## 6. Comparators and tie rules

The exact per-comparator tie chain for each of the 114 `compare*` functions
is already documented, comparator-by-comparator, in the sibling doc that
owns each function's file (see the mapping table in §1). This section adds
the **cross-cutting facts about the comparator layer as a whole** that only
become visible by looking at all 114 together:

1. **The three foundational string-comparator implementations
   (`compareStrings`, `compareCanonicalKeys`, and inline
   `.localeCompare` lambdas) are each independently hand-written per file**,
   not centralized in one shared utility module anywhere under `src/shared/`
   or `src/workers/irregular/`. A search for a shared `compareStrings`/
   `compareCanonicalKeys` export outside the files that define them locally
   found none — every file that needs code-unit string comparison
   re-implements the identical 3-line body. This is not itself a hazard (the
   bodies are textually identical and behaviorally equivalent), but it means
   a Rust port **may safely unify these into one shared `fn compare_code_unit`
   helper** without changing observable behavior, since there is no
   file-specific variation among the code-unit comparators — only the
   choice of code-unit vs. locale-aware comparator varies per call site, and
   that choice must be preserved exactly per site (§5.2).

2. **BigInt comparators are also independently re-implemented per file**
   with at least four near-identical bodies found: `compareBigInts`
   (`canonicalGridMath.ts:12-14`, ascending), `compareBigIntAscending`
   (`intrinsicStrictDecoder.ts:2101-2103`), `compareBigIntAscending`
   (`intrinsicSharedArchivePortfolio.ts:420-422`), `compareBigInt`
   (`intrinsicPeriodicCells.ts:2363-2365`), `compareBigInt`
   (`intrinsicExactProjection.ts:1035-1037`), plus **descending** variants
   `compareBigintDescending`/`compareBigintsAscending`
   (`intrinsicCapacityEndpoint.ts:278-281,349-351`,
   `intrinsicCapacitySearch.ts:2228-2231`). All bodies use the pattern
   `first === second ? 0 : first < second ? -1 : 1` (or the descending
   mirror). BigInt `<`/`===` in JS perform exact arbitrary-precision integer
   comparison with no representation ambiguity — the Rust equivalent is
   exact `i128`/`i64`/arbitrary-precision comparison depending on the
   verified coordinate/product bound for each specific call site (per
   migration prompt §8.2); there is no signed-zero or rounding subtlety for
   BigInt comparison itself (unlike `Number` comparison, §7).

3. **Compound comparators uniformly use `||`-chained numeric-difference or
   explicit-branch tie chains**, e.g.
   `compareOccupiedDistance(...) || compareExactFraction(...)` style
   short-circuit chaining seen throughout `intrinsicQueueBeamDiscriminator.ts`,
   `intrinsicCapacitySearch.ts`, `intrinsicV7SeedArchive.ts`. Because `||`
   treats `0` (and `-0`, since `-0` is falsy in JS) as "continue to the next
   clause," a subtraction-based sub-comparator that could legitimately
   return `-0` for an equal-but-negative-zero-difference pair is
   **automatically handled correctly** by the chain (falls through, same as
   a literal `0`) — this is one of the few places where JS's falsy-`-0`
   behavior actually helps rather than hinders parity; Rust's `||`/`or_else`
   equivalent over `Ordering::Equal` needs no special `-0` handling either,
   since `Ordering` has no signed-zero concept — the hazard is entirely
   upstream, in whether the **subtraction itself** ever produces a wrong
   sign due to float precision, not in the chaining operator.

4. **NEW — three-way (not two-way) inconsistency in canonical-JSON
   comparators used for SHA-256 checkpoint hashing.** See §8.1 — this is the
   single most important comparator-layer finding in this document and is
   placed there because it is inseparable from the hashing context.

---

## 7. Numeric semantics

### 7.1 `Number`-to-string rendering (ECMA-262 `Number::toString`)

Every one of the following constructs invokes the ECMAScript `Number`-to-
`String` conversion, which is the **shortest-decimal-string-that-round-trips**
algorithm (historically Grisu/Dragon4-class; V8 uses a `fast-dtoa`/`bignum-dtoa`
hybrid) with a **specific exponential-notation switchover** at magnitude
`>= 1e21` or `< 1e-6` (ECMA-262 `Number::toString`, steps for `n` outside
`(-6, 21]`): plain `String(value)`, template-literal interpolation
`` `${value}` ``, and the number-typed branch of every custom canonical
encoder in §8 (which bottoms out in `JSON.stringify(value)` for numbers,
and `JSON.stringify`'s number serialization is defined in terms of this same
`Number::toString` algorithm, **except** that `JSON.stringify` maps
non-finite numbers to the literal `null` rather than throwing or using
`Number::toString`'s `"NaN"`/`"Infinity"` strings — see §7.4).

Confirmed call sites that render a `number` into a **key, hash input, or
cache identity** (not just a human-readable diagnostic message):

- `canonicalNumber` (`irregularBeamState.ts:844-850`) — explicit `NaN`/`-0`/
  `±Infinity` special-casing, falls through to bare `String(value)` for
  every finite non-zero value; feeds `canonicalPointKey`/
  `canonicalEntryListKey` → `canonicalOccupiedGeometryKey`, the beam-state
  dedup key. **Fully characterized already by `search-scoring.md:999-1040`**,
  including the exact ECMA-262 exponential-notation range and the explicit
  recommendation that Rust needs an ECMA-262-compatible `Number::toString`,
  not `f64::to_string()`/`{}` `Display` (which never uses exponential
  notation and is a different, though also shortest-round-trip-class,
  algorithm). This audit independently confirms that recommendation and
  extends it: the task brief's suggested tool class is a Rust crate
  purpose-built to reproduce ECMAScript's algorithm bit-for-bit (marketed
  under names like `ryu-js`, distinguished from the generic `ryu` crate
  which reproduces Rust/Java float formatting, not JS's). **This must be
  verified for exact byte-for-byte parity with V8 (including the `-0`
  case, which JS's `Number::toString` renders as `"0"` — no sign — and the
  exponential-notation boundary) via a differential test harness before
  being trusted**, not assumed correct from its README; if no verified
  crate exists, port ECMA-262 §6.1.6.1.20 `Number::toString` directly and
  golden-test it against thousands of V8-generated `(value, string)` pairs
  spanning denormals, boundary magnitudes (`1e-7`/`1e-6`/`1e20`/`1e21`), and
  `-0`.
- `numberKey` (`geometryCacheKeys.ts:158-160`, `core/geometryCacheIdentity.ts:139-141`,
  `core/nfpCacheKey.ts:104-106`) — three near-identical
  `Object.is(value,-0) ? '0' : String(value)` copies, each independently
  defined per file (not shared), feeding NFP/IFP/transform cache keys.
  **Fully characterized by `geometry-caches.md:473-503,1057-1074,1143`** —
  flagged there as "the single highest-risk" number-to-string site because
  cache-key mismatches (not just observable-output mismatches) would cause
  silent over-recomputation or, worse, silent under-recomputation if two
  distinct floats ever rendered to colliding strings (`geometry-caches.md`'s
  own analysis; not re-derived here).
- `canonicalGridMath.ts:140`: `` `${point.x},${point.y}` `` template-literal
  dedup key inside `canonicalGridConvexHull` — **NEW finding, not flagged
  by any sibling doc** (this file is a shared primitive imported by several
  clusters but owned by none). Two additional subtleties beyond plain
  `Number::toString` rendering:
  - `new Map(points.map((point) => [key, point])).values()` — when
    `points` contains multiple entries with the **same** `(x,y)` key
    (possible if upstream produced duplicate coordinate objects with
    distinct identity, e.g. from independent geometry construction paths),
    the `Map` constructor calls `.set(key, point)` once per array element
    **in array order**; for a repeated key, each `.set` call **overwrites
    the value but does not move the key's position** (`Map.prototype.set`
    semantics: re-setting an existing key updates its value in place,
    preserving original insertion-order position). The net effect: the
    de-duplicated `unique` array below preserves the **position of the
    first occurrence** of each distinct `(x,y)` pair, but the **point
    object instance retained is the last occurrence** with that key. A
    naive Rust port using `HashMap::entry(key).or_insert(point)` would keep
    the **first** value, not the last — a real, silent divergence if any
    caller of `canonicalGridConvexHull` ever passes coordinate-duplicate
    points that are not `Object.is`-identical instances (this matters only
    if some downstream identity/reference equality on the point object
    itself is later observed, since the numeric `x`/`y` values are equal by
    construction of the key — low practical risk but the *mechanism* is a
    genuine JS-Map-vs-Rust-HashMap divergence that must be captured in the
    Rust port as `HashMap::insert` (last-wins-value, first-wins-position via
    a stable/ordered map), not `.entry().or_insert()`).
  - `canonicalGridCrossSign` (used by the hull's turn test, `:82-109`) is
    itself an exact/fast-path hybrid gated by `Number.isSafeInteger` and
    `CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT = 2**25 - 1` — see §7.2.

### 7.2 Exact-integer/float hybrid predicates (`canonicalGridMath.ts`) — NEW, foundational

`canonicalGridMath.ts` (152 lines, no dedicated sibling doc — imported by
`validation-spatial.md`, `search-scoring.md`, `strict-decoder-gap-family.md`,
`periodic.md`, `short-side.md`'s clusters per grep, but "owned" by none) is
the shared primitive implementing exact-integer orientation predicates on
the canonical grid. It is the concrete embodiment of migration prompt §8.2's
"exact integer authority" and §8.3's "robust predicates own unsnapped
source-geometry decisions" requirements, and deserves a Rust implementer's
full attention as a template for the rest of the port:

- `isCanonicalGridCoordinate(value) = Number.isSafeInteger(value)`
  (`:8-10`) — gates every predicate; any non-safe-integer coordinate makes
  the exact predicate return `undefined` (propagated, not defaulted),
  forcing callers to handle "exactness unavailable" explicitly rather than
  silently falling back to imprecise float math.
- `canonicalGridCross` (`:29-48`) computes the exact `BigInt` cross product
  of `(first - origin) × (second - origin)`, gated by the safe-integer
  check on all six coordinates.
- `canonicalGridCrossSign` (`:82-109`) is a **documented, proof-commented**
  fast path: within `CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT = 2**25 - 1`
  (chosen so `8L² = 2^53 - 2^29 + 8 < Number.MAX_SAFE_INTEGER`, per the
  inline proof at `:50-62`), the sign is computed directly in `Number`
  arithmetic with **zero rounding risk** (proved, not assumed); outside that
  bound, it falls back to the exact `BigInt` path and compares against
  zero. **The Rust port must reproduce both the bound and the branch
  structure exactly** — not just "use `i128` everywhere" (which would be
  *more* exact than the JS reference for the float fast-path branch and
  therefore could, in principle, disagree with JS's `Number`-arithmetic
  result for the extremely rare pathological case where the `Number`
  fast-path's floating-point rounding — which is proved impossible by the
  `2^25-1` bound but only for **this specific formula's evaluation order**
  — differs from an always-exact computation; the migration prompt's
  general instruction *not* to "reassociate floating-point expressions" (§8.1)
  applies directly here: the Rust fast path must literally compute
  `(first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x)`
  in `f64` in that exact operation order when within the bound, not
  substitute an always-exact `i128` computation, if bit-for-bit parity with
  the *reference outputs of this exact code* is the goal for values at or
  near the boundary of other, non-orientation, dependent computations that
  might observe intermediate float rounding — though for the sign result
  itself the two are provably identical within the bound, so this is a
  belt-and-suspenders note, not a proven divergence).
- `canonicalGridConvexHull` (`:138-171`) — monotone-chain (Andrew's
  algorithm) hull construction using `canonicalGridCrossSign` for turn
  tests; the dedup-then-sort front end is discussed in §7.1.
- `doubledGridAreaToMm2` (`:198-201`) — `Number(doubledAreaGrid2) / 2_000_000`
  gated by `Number.isFinite`. `Number(bigint)` conversion for a `bigint`
  whose magnitude exceeds `Number.MAX_VALUE` (~1.7976931348623157e308)
  produces `Infinity`/`-Infinity` (does **not** throw), caught by the
  `isFinite` gate and mapped to `undefined`; for a `bigint` within `f64`
  range but exceeding `2^53`, conversion **silently loses precision**
  (round-to-nearest-even, per ECMA-262 `BigInt::toNumber` /
  `NumberToBigInt`'s inverse), which is accepted here since this is
  explicitly a **projection for display**, per prompt §8.3, not a canonical
  value — but the Rust equivalent bigint-to-`f64` conversion (via `i128` or
  an arbitrary-precision crate's `to_f64`) must use the same
  round-to-nearest-ties-to-even rounding mode to match bit-for-bit, which is
  not guaranteed by every crate's default `as f64`/`.to_f64()` implementation
  and should be verified, not assumed.
- `canonicalGridPointOnSegment` (`:173-186`) mixes the exact
  `canonicalGridCrossSign` collinearity test with **plain float**
  `Math.min`/`Math.max` bounding-box containment on the raw `number`
  coordinates — i.e. this one predicate is a hybrid of exact and
  non-exact tests within the same function; a Rust port must replicate the
  hybrid, not "upgrade" the bounding-box check to exact-integer comparison
  even though the coordinates are already safe integers at this point
  (harmless in practice since integer `Math.min`/`Math.max` on safe
  integers is itself exact, but worth noting as a "don't silently unify
  this into one exact-only predicate" instruction).
- `canonicalGridCounterClockwise`/`canonicalGridClockwise` (`:188-196`)
  reorient a path based on `canonicalGridSignedDoubledArea`'s sign,
  **defaulting to "leave as-is" when the signed area is exactly zero**
  (`signed >= 0n ? path : reversed` for CCW — zero area counts as "already
  CCW," not "ambiguous/reject"). This zero-area tie-break direction (CCW
  wins ties, by `>=` not `>`) is a concrete, easily-inverted-by-accident
  detail a Rust port must copy exactly (`>=` not `>` and vice versa for the
  CW variant, which uses `<=`).

`tests/unit/canonicalGridMath.test.ts` (179 lines) already differentially
tests `canonicalGridCrossSign`'s fast path against the exact `BigInt` oracle
(`exactCrossSign`, `:13-21`) with a **seeded, non-`Math.random()`**
pseudo-random generator (`makeSequence`, `:25-30`, explicit LCG — chosen so
"failures reproduce," per the file's own comment) — this is exactly the
kind of differential golden test the Rust port's equivalent module should
be checked against byte-for-byte (§14).

### 7.3 `Math.*` semantics divergences from Rust (NEW, general porting guidance)

744 `Math.*` call sites were found; enumerating each individually adds no
value over the per-cluster docs' existing per-site analysis. This audit's
contribution is the **general hazard classes** every one of these call sites
must be checked against, since they recur throughout the 744 sites and are
easy to miss when porting mechanically:

1. **`Math.round` is round-half-toward-positive-infinity, not round-half-away-from-zero.**
   `Math.round(-0.5) === -0`, `Math.round(-2.5) === -2` (not `-3`). Rust's
   `f64::round()` is round-half-**away-from-zero** (`(-2.5_f64).round() ==
   -3.0`). **Every direct `Math.round(...)` call in this codebase that can
   receive a negative operand** — confirmed live examples:
   `intrinsicStrictDecoder.ts:1693,1698` (`Math.round(valueMm * 1_000)`,
   `Math.round(valueMm2 * 1_000_000)` — the exact "floating millimeters to
   canonical grid" conversion the migration prompt §8.1 calls out by name),
   `intrinsicTransformSeparator.ts:503-504,536-537,721-722,729-730,934-935`,
   `intrinsicSqueezeDisruptSeparate.ts:3086-3089`,
   `overlapRelaxationV1.ts:1267,1271`, `overlapRelaxation.ts:787` — **must
   not** be translated to Rust's `.round()` method call. Implement JS's
   exact convention: `(x + 0.5).floor()` reproduces it correctly **only**
   for the halfway case in the direction JS rounds (need to verify sign
   handling around zero: JS `Math.round(x)` for `x` in `[-0.5, 0)` returns
   `-0`, which is `(x+0.5).floor()` in Rust terms `(x+0.5)` ∈ `[0, 0.5)`,
   `.floor() == 0.0` — matches JS's `-0` magnitude-wise but Rust's
   `.floor()` on a non-negative input never produces `-0.0`, so an explicit
   sign-preservation step is needed if `-0` must survive, consistent with
   `search-scoring.md`'s point that raw `-0` from rounding/rotation is
   folded away downstream by `Object.is(value,-0)` guards in most call sites
   anyway — verify per call site whether the `-0` is observable before the
   next fold).
2. **`Math.round`/`Math.floor(abs(x)+0.5)*Math.sign(x)` are two *different*,
   both live, rounding conventions in the same codebase.**
   `irregularScoreGrid.ts:21-30,33-41`
   (`canonicalizeIrregularScoreMillimeterUnits`/`canonicalizeIrregularScoreScalar`)
   implement **round-half-away-from-zero** via
   `Math.sign(value) * Math.floor(Math.abs(value)*scale + 0.5)`, which is
   the Rust-`.round()`-*compatible* convention — the **opposite** of the
   direct-`Math.round()` sites in item 1. **Fully characterized already by
   `search-scoring.md:925-953,1049-1050,1537-1538,1783`**, including the
   critical follow-on fact that `Math.sign(0) === 0` and `Math.sign(-0) ===
   -0` (JS preserves the sign of zero through `Math.sign`), whereas Rust's
   `f64::signum()` returns `1.0` for `+0.0` and `-1.0` for `-0.0` (**never**
   `0.0`) — a second, independent divergence stacked on top of the rounding
   convention itself, both already documented there in full. This audit's
   contribution is flagging that a Rust implementer who sees "just use
   `.round()`" as a global find-and-replace strategy for `Math.round(...)`
   call sites would get item 1's sites right by accident (if they happen to
   implement JS's actual convention) but item 2's sites **wrong** (since
   `.round()` matches item 2's *intent*, i.e. round-half-away-from-zero, but
   these sites don't call `Math.round` directly — they hand-roll the
   opposite-of-`Math.round` convention specifically to get
   round-half-away-from-zero, which is confusingly the behavior Rust's
   built-in method already has — the danger is a maintainer "simplifying"
   item 2's hand-rolled formula down to `.round()` during the port, which
   would be correct for the *rounding* half but silently drop the
   `Math.sign(0)`-preserves-sign / `Math.sign(-0)===-0` behavior that the
   hand-rolled version's `Math.sign(value) * ...` structure produces at
   exactly `value === -0`.
3. **`Math.max`/`Math.min` propagate `NaN`; Rust's `f64::max`/`f64::min`
   methods ignore `NaN`.** `Math.max(a, NaN) === NaN` for any `a`. Rust's
   `a.max(b)` "ignores NaN... if one of the arguments is NaN, then the other
   argument is returned" (per `f64::max` documentation) — the **opposite**
   policy. With 397 `Math.max` and 188 `Math.min` call sites in this
   cluster, a systematic audit of which specific sites can ever receive a
   `NaN` operand was **not** performed by this document (out of scope for
   a targeted audit of this size — flagged as an open question, §15) but
   the semantic gap itself is unconditionally real and must be a standing
   Rust-port rule: **do not translate `Math.max(a, b)`/`Math.min(a, b)` to
   Rust's `a.max(b)`/`a.min(b)` method calls without first proving neither
   operand can be `NaN` at that call site** (an `f64::is_nan()` assertion in
   debug builds, or an explicit NaN-propagating wrapper function used
   everywhere `Math.max`/`Math.min` is translated, is the safe default).
   Related, smaller: `Math.max(+0, -0) === +0`, `Math.min(+0, -0) === -0`
   in JS (defined, deterministic per spec); Rust's `f64::max`/`min` methods'
   documentation explicitly states zero-sign handling is **not** guaranteed
   ("this function does not guarantee IEEE 754-2008 semantics with respect
   to negative zero" is not the literal wording, but the practical effect is
   platform/implementation-detail territory for the ±0 case) — any call
   site whose operands could be `±0` with observably different downstream
   sign handling needs the same explicit-wrapper treatment as the NaN case.
4. **`Math.sign`** — see item 2's `Math.sign(0)`/`Math.sign(-0)` note; also
   `Math.sign(NaN) === NaN` (Rust has no direct `f64` equivalent method;
   `f64::signum()` returns `NaN` for `NaN` input too, so this one case
   matches, but the zero case does not, per above).
5. **`Math.hypot`** (21 call sites) — JS's `Math.hypot(a, b, ...)` is
   specified to handle overflow/underflow more carefully than a naive
   `sqrt(a*a+b*b)` (spec explicitly requires certain special-case results
   for `±Infinity`/`NaN` operands, `Math.hypot(Infinity, NaN) === Infinity`
   notably — `Infinity` wins over `NaN`, an explicit spec carve-out). Rust's
   `f64::hypot` (libm-backed) is also overflow/underflow-aware per IEEE 754
   but its exact `NaN`-vs-`Infinity` precedence should be checked against
   the specific libm implementation linked, not assumed identical to V8's
   `Math.hypot`, for any call site whose operands could plausibly be
   `Infinity`/`NaN` (most geometry call sites operate on already-validated
   finite coordinates, per the pervasive `Number.isFinite` gating found
   throughout this sweep, §7.4 — so this is a low-probability but
   nonzero-severity edge case).
6. **`Math.atan2`, `Math.sin`/`Math.cos`, `Math.PI`, `Math.SQRT1_2`** — used
   for transform/rotation angle math (owned by `collision-prep.md` and
   `short-side.md`'s clusters for the geometric meaning); the *numeric*
   hazard is standard libm cross-platform transcendental-function bit-
   exactness, which is **not** guaranteed identical between V8's math
   library and Rust's linked libm even for the same input — this is a
   general floating-point portability caveat orthogonal to JS-specific
   semantics, already implicitly covered by the migration prompt §8.1's
   "Do not enable compiler options... that reassociate floating-point
   expressions," but worth flagging explicitly here: **transcendental
   function results (`sin`/`cos`/`atan2`/`sqrt`) may differ in the last bit
   between V8 (which uses its own `fdlibm`-derived implementations for some
   of these, not always the platform libm) and whatever libm Rust links
   against on the target platform — a differential test suite comparing
   these specific functions' outputs across the full domain relevant to
   collision-geometry transforms is necessary before trusting bit-exact
   parity**, independent of everything else in this document.

### 7.4 `Number.isSafeInteger`/`Number.isFinite`/`isNaN` gating

292 sites found; the overwhelming pattern (confirmed by sampling across
~15 files) is **defensive gating before an exact-integer or canonical-grid
operation** — e.g. `isCanonicalGridCoordinate` (§7.2),
`canonicalizeIrregularScoreMillimeterUnits`'s `Number.isFinite` guards
(§7.3 item 2), `intrinsicCapacitySearch.ts:1368`'s
`Object.values(checkpoint.counters).every(isNonNegativeSafeInteger)`
(checkpoint integrity validation — owned by `capacity-search.md`). Rust
equivalents: `f64::is_finite()` for `Number.isFinite`, and for
`Number.isSafeInteger` the exact predicate is `x.is_finite() && x.fract() ==
0.0 && x.abs() <= 2f64.powi(53) - 1.0` — note `Number.isSafeInteger` does
**not** coerce (`Number.isSafeInteger("5") === false`, irrelevant for typed
Rust but confirms these are strict `typeof value === 'number'`-gated checks
already at the TS type level) and specifically differs from `isFinite`
(global, coercing) vs `Number.isFinite` (strict, non-coercing) — **this
sweep found zero uses of the bare global `isFinite`/`isNaN` (only the
`Number.`-qualified strict forms)** in the files that matter for canonical
computation; the two bare-global hits in the 292-count are inside
`assertNever.ts`-adjacent guard clauses and message formatting, not
canonical paths (verified by spot-check, not exhaustively re-audited given
time budget — flagged as a light-verification item in §15 rather than a
confirmed-exhaustive claim).

### 7.5 Signed-zero handling — `Object.is(value, -0)` normalization

18 call sites across 15 files independently implement the same
`Object.is(value, -0) ? 0 : value` (numeric) or
`Object.is(value, -0) ? '0' : String(value)` (string-key) idiom — no shared
helper. File list (verified via the grep in this audit's raw sweep):
`intrinsicStrictFamilyPortfolio.ts:452`, `intrinsicExactProjection.ts:1024`,
`geometryCacheKeys.ts:159`, `convexSatPenetration.ts:89`,
`core/ifpBoundsCore.ts:130`, `core/geometryCacheIdentity.ts:140`,
`core/transformCollisionGeometryCore.ts:181`, `irregularBeamState.ts:497,846,855`,
`intrinsicTransformSeparator.ts:1544`, `freeMaterialService.ts:488`,
`core/nfpCacheKey.ts:105`, `transformGenerator.ts:432`,
`intrinsicStrictDecoder.ts:1761`, `core/nfpBoundaryCore.ts:87`,
`nfpIfpService.ts:1291`, `intrinsicQueueBeamDiscriminator.ts:4771`. All 18
are internally consistent with each other (same fold direction: `-0 → 0`/
`'0'`, never the reverse), so a Rust port **may** consolidate these into one
shared `fn fold_negative_zero(f64) -> f64` / `fn fold_negative_zero_key(f64)
-> String` helper without changing behavior — same reasoning as §6 item 1
for the code-unit string comparators. `Object.is` itself (not `===`) is used
specifically because `===` treats `+0 === -0` as `true` (cannot distinguish
them), while `Object.is(-0, -0) === true` and `Object.is(-0, 0) === false` —
Rust's `f64::to_bits()` equality or `x.is_sign_negative() && x == 0.0` is
the correct translation of `Object.is(value, -0)`, **not** `value == -0.0`
(which is always `true` for any zero, positive or negative, per IEEE 754
comparison semantics that Rust's `==` on `f64` follows identically to JS's
`===`).

---

## 8. Serialization and hashing

### 8.1 Four independent "canonical JSON"-family encoders — CRITICAL, cross-cluster finding

This audit's single highest-value finding is that this codebase contains
**four textually distinct, independently hand-written canonical-encoding
functions**, each feeding checkpoint integrity hashes, request fingerprints,
or dedup keys, and **they are not mutually consistent with each other**:

| Encoder | File:line | Object-key sort | BigInt handling | `Map` handling | Feeds |
|---|---|---|---|---|---|
| `intrinsicStrictCanonicalJson` | `intrinsicStrictDecoder.ts:1257-1276` | `.localeCompare` | `typeof value==='bigint' → JSON.stringify(value.toString())` | special-cased: `[...value.entries()].toSorted(([a],[b])=>String(a).localeCompare(String(b)))` then recursed as an array | `intrinsicStrictDirectRequestFingerprint` (`:1021-1053`) and `intrinsicStrictDirectCheckpointIntegrityHash` (`:1056-...`), both `createHash('sha256').update(...).digest('hex')` |
| `canonicalJson` (capacity) | `intrinsicCapacitySearch.ts:1626-1635` | `compareStrings` (plain `<`/`>`, **not** locale) | `typeof value==='bigint' → JSON.stringify(value.toString())` | **no special case** — a bare `Map` value reaching this function falls through to `typeof value !== 'object'`... **actually `typeof someMap === 'object'` is `true`**, so it falls into the generic object branch and is walked via `Object.entries(map)`, which is **empty** for a `Map` (a `Map`'s own enumerable string-keyed properties are empty; its entries are not own-enumerable properties) — **a `Map` value passed to this encoder silently serializes as `{}`**, discarding all its entries, with no error | `intrinsicCapacityCheckpointIntegrityHash` (`:1503-...`) and the request-fingerprint equality checks at `:1305,1310` — both checkpoint-identity-critical, `createHash('sha256').update(...).digest('hex')` at the integrity-hash site |
| `canonicalJson` (periodic) | `intrinsicPeriodicFamilyPortfolio.ts:1285-1291` | `.localeCompare` | **none** — `typeof value !== 'object'` is `true` for `bigint` (JS `typeof 1n === 'bigint'`, not `'object'`), so it falls to `JSON.stringify(value)`, and **`JSON.stringify` throws a `TypeError` on any `bigint`** ("Do not know how to serialize a BigInt") | same silent-`{}`-discard issue as above (falls into `Object.entries`, empty) | `sha256(canonicalJson(pieces))`, `sha256(canonicalJson(eligibleSourceDomainEntries(...)))`, `sha256(canonicalJson(replay))` (`:1206,1214,1218`) — fully characterized by `periodic.md:244,261-266` (which independently found and flagged the same BigInt-throws landmine) |
| `canonicalRecord`/`canonicalToken`/`canonicalNumber` | `irregularBeamState.ts:829-850` | N/A — not JSON; a bespoke **length-prefixed ("netstring") token concatenation**: `` `${name.length}:${name}${value.length}:${value}` `` per field, fields supplied as an already-ordered array of `[name, value]` string tuples (ordering is the *caller's* responsibility, via `compareCanonicalKeys`-sorted `insertCanonicalEntryKey`, §4) | N/A (only ever fed pre-stringified `string`/`canonicalNumber(number)` values, never raw `bigint`) | N/A | `canonicalPointKey`/`canonicalEntryListKey` → `canonicalOccupiedGeometryKey` (beam-state dedup identity, **not** SHA-256-hashed — used directly as a `Map`/comparator key string) — fully characterized by `search-scoring.md:1131-1166` |

**What no single per-cluster document can say, because each only looked at
its own file, is that these four encoders are mutually inconsistent as a
*set*, despite all serving the same conceptual role ("canonical JSON for a
hash/key"):**

- The migration prompt §9 refers to "the current custom encoding" for
  "canonical checkpoint JSON" in the **singular**, as though one encoding
  governs all checkpoints. **Source truth: there is no single canonical
  checkpoint JSON encoder.** There are at least three JSON-shaped ones
  (Strict Direct, Capacity/Anytime, Periodic source-audit) plus one
  non-JSON netstring-style one (beam-state dedup identity), and the three
  JSON-shaped ones disagree on (a) string comparator (locale vs. code-unit)
  and (b) `BigInt` handling (encode-as-string vs. throw). **A Rust port
  must implement four separate, independently-verified canonical encoders,
  one per checkpoint/key namespace, matching each source function's exact
  behavior — including its exact failure mode where the source throws or
  silently discards data — not one unified "canonical JSON" module.**
  This is exactly the kind of "SOURCE truth that contradicts the migration
  prompt's summary" the task brief asks to be reported prominently; see
  §15.
- The `compareStrings`-vs-`.localeCompare` divergence between the Capacity
  encoder and the other two is **not currently reachable as an observable
  hash difference** for the specific field-name sets each encoder is fed
  today (all are TypeScript interface field names — camelCase ASCII
  identifiers with no shared prefixes differing only by case/punctuation,
  where code-unit and default-locale collation coincide, per the general
  reasoning in §5.2 item 1) — but this is an empirical, not a structural,
  guarantee, and it is trivially broken by adding a new field whose name
  happens to collate differently than it code-unit-compares relative to a
  sibling field (e.g. any pair of field names differing only in a digit vs.
  letter at the first divergent position). **The Rust port must implement
  both variants distinctly per source function, not pick one "canonical"
  string comparator for canonical-JSON key sorting project-wide.**
- The `Map`-argument silent-`{}`-discard behavior in the Capacity and
  Periodic encoders (both lack `intrinsicStrictCanonicalJson`'s explicit
  `value instanceof Map` branch) is a **latent landmine, not a currently
  observed bug** — this audit did not find any call site that actually
  passes a `Map` instance into either of these two encoders (both are fed
  plain object/array-shaped checkpoint/audit data built explicitly for
  hashing, not raw `Map`s) — but a Rust port's equivalent encoder function,
  if given a generic `serde_json::Value`-like input type, must reproduce
  this exact silent-discard behavior for parity **if** it's ever
  observably reachable, or the implementer must add an assertion that no
  `Map`-shaped value ever reaches these two specific encoders (provable
  today, not provable forever) rather than "helpfully" serializing `Map`
  contents the way `intrinsicStrictCanonicalJson` does, which would be
  outright new behavior for two of the three checkpoint hashes if a future
  TS change ever passes one in.

### 8.2 Two serialization regimes: sorted-canonical vs. plain-insertion-order

Distinct from §8.1's sorted canonical encoders, this codebase also uses
**plain, unsorted `JSON.stringify`** at several sites where field order is
**insertion order** (own-property creation order at the object-literal call
site), not sorted:

- `decisionTraceNdjson.ts:36`: `` events.map((event) => JSON.stringify(event)).join('\n') `` —
  NDJSON decision-trace serialization. Field order = the exact property
  order each `IrregularDecisionTraceEvent` variant's object literal is
  written in at its construction site(s) (owned by `errors-protocol.md`'s
  decision-trace type catalog). A Rust `serde`-derived struct serializer
  reproduces this correctly **only if** the struct's field declaration
  order exactly matches the TS object literal's property order at
  construction — not, e.g., alphabetical or grouped-by-category ordering
  that might seem more idiomatic in Rust.
- `nesting.worker.ts:108`: `` `${JSON.stringify(frame)}\n` `` — checkpoint
  frame persistence to disk, same insertion-order regime (owned by
  `worker-coordination.md`).
- `geometryCacheStore.ts:14` (`JSON.stringify([key.namespace, key.parts])`),
  `geometryCacheKeys.ts:95`, `placedCollisionSpatialIndex.ts:119-125`
  (`continuationIdentity()` — note this one **does** locally sort its
  `buckets` field via `.toSorted(([a],[b]) => a.localeCompare(b))` before
  the outer plain `JSON.stringify`, i.e. it is a **hybrid**: one field
  pre-sorted, the object literal's own key order otherwise left as-written),
  `irregularLayoutScorer.ts:40-...` (`makeFreeMaterialCacheKey`) — all
  **cache keys**, not hashes; field order matters only insofar as it must be
  *consistent* across calls with the same logical input (guaranteed by
  construction, since the same code path always builds the object literal
  in the same order) — owned respectively by `geometry-caches.md`,
  `validation-spatial.md`, `search-scoring.md`.
- `assertNever.ts:7`: `JSON.stringify(value)` inside an error message
  string — diagnostic only, no ordering stakes.

**The two regimes must not be conflated in the Rust port**: nothing in §8.2
should be routed through the §8.1 canonical encoders' sorted-key logic (that
would change cache-key/trace-output bytes, a forbidden observable change
per migration prompt §2), and nothing in §8.1 should be "simplified" to
plain field-declaration-order `derive(Serialize)` (that would silently
change hash bytes whenever object key insertion order ever differs from
sorted order, which is exactly the entire point of using a sorting encoder
for a checkpoint hash — to be independent of construction-order
refactoring elsewhere in the code).

### 8.3 `canonicalToken`'s UTF-16 code-unit length prefix (NEW, extends `search-scoring.md`)

`search-scoring.md:1131-1166` already documents `canonicalToken(value) =
` `` `${value.length}:${value}` `` and states the Rust port "must reproduce
`canonicalToken`'s `"{len}:{value}"` format exactly." This audit adds the
specific mechanism: JS `String.prototype.length` counts **UTF-16 code
units**, not Unicode scalar values (`.chars().count()` in Rust) and not
UTF-8 bytes (`.len()` in Rust). For any token value containing a character
outside the Basic Multilingual Plane (i.e. requiring a UTF-16 surrogate
pair — emoji, some CJK Extension B+ characters, etc.), `value.length` counts
it as **2**, while Rust's `.chars().count()` would count it as **1** and
`.len()` (bytes) would count it as **4**. **The Rust port must compute this
length as `value.encode_utf16().count()`**, not `.len()` or
`.chars().count()`, for any token value that cannot be proven ASCII/BMP-only
at every call site (`canonicalPointKey`'s `'x'`/`'y'` literals and
`canonicalNumber`'s numeric-string outputs are provably ASCII-only, but
`canonicalEntryListKey`'s `entryKeys` values are themselves the output of
other canonical-key functions recursively — need to trace whether any path
into these keys can embed a user-supplied piece label/source-id containing
non-BMP characters; not fully traced by this audit given time budget,
flagged in §15).

### 8.4 `undefined`-omission idiom

The `.filter(([, fieldValue]) => fieldValue !== undefined)` step present in
all three JSON-shaped canonical encoders (§8.1) plus the pervasive
`...(x === undefined ? {} : { x })` conditional-spread idiom seen throughout
(e.g. `intrinsicPeriodicCells.ts:528`: `...(sourceAuditCells === undefined ?
{} : { sourceAuditCells })`) both implement "omit the key entirely when the
value is `undefined`," matching `JSON.stringify`'s own native behavior
(`JSON.stringify({a: undefined})` → `"{}"`, the key is dropped, not
serialized as `null`). This is consistent with the `hasOwnProperty`-gated
domain-class field-omission pattern already documented in §3/`periodic.md:134`.
**Rust translation: every one of these must be `Option<T>` +
`#[serde(skip_serializing_if = "Option::is_none")]` (or the custom
encoder's explicit filter, matching whichever of §8.1/§8.2's regimes
applies) — never `Option<T>` serialized as `null` when `None`.**

### 8.5 SHA-256 / `createHash('sha256')` usage

Every `createHash('sha256')` call found in this sweep (`intrinsicStrictDecoder.ts`,
`intrinsicCapacitySearch.ts`, `intrinsicPeriodicFamilyPortfolio.ts`, plus
`canonicalCollisionLayoutIdentity`-adjacent hashing owned by
`search-scoring.md`/`validation-spatial.md`) hashes the **UTF-8-encoded
bytes** of a JS string (`Hash.update(string)` defaults to UTF-8 encoding in
Node). As `periodic.md:265` already notes, UTF-8 encoding of a JS string is
a **UTF-16-to-UTF-8 transcode**, and for any input string containing
unpaired ("lone") surrogates — which can arise from malformed/adversarial
input, not just exotic-but-valid Unicode — Node's transcoder substitutes the
Unicode replacement character (`U+FFFD`) per WHATWG encoding-standard
practice, **not** an error. A Rust port constructing the equivalent bytes
from a `String` (always valid UTF-8, cannot represent lone surrogates at
all) must special-case this: either prove no canonical-hash input string can
ever contain a lone surrogate (likely true if all string content originates
from valid-UTF-8/valid-JSON decode paths at the N-API boundary, but not
proven by this audit), or implement the same WHATWG lone-surrogate → `U+FFFD`
substitution explicitly when constructing the pre-hash string from any
JS-`String`-typed (not proven-valid-UTF-8-at-the-type-level) source data.

---

## 9. Caches touched and the exact historical access sequence

Not this cluster's primary subject — see `geometry-caches.md`, `nfp-ifp.md`,
`collision-prep.md`, `capacity-search.md` for the authoritative per-cache
access-sequence documentation. This audit's connection to caching is
entirely through the key-construction functions in §7.1/§8.1/§8.2
(`numberKey`, `canonicalToken`/`canonicalRecord`, `serializeGeometryCacheKey`,
`continuationIdentity`, `makeFreeMaterialCacheKey`) — every one of those
functions' *output bytes* is a cache key, so any JS-semantics divergence in
how they render a `number`/sort a `Map`/fold `-0` becomes a **cache-key
divergence**, which (per migration prompt §13.1: "A cache hit and a
recomputation must return the same canonical immutable value") could cause
either silent over-recomputation (harmless but slow) or, if two logically
distinct inputs ever collide to the same malformed key, an **incorrect
cache hit** (a correctness bug, not just a performance one). This elevates
every §7/§8 finding that feeds a cache key to at least MAJOR severity even
where the same finding, if only feeding a diagnostic field, would be minor.

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points

Not this cluster's primary subject — see `worker-coordination.md`,
`capacity-search.md`, `errors-protocol.md`. Relevant JS-semantics
intersection: `Number.isSafeInteger`/`Number.isFinite` gate several
counter/budget fields at checkpoint-integrity-validation boundaries (e.g.
`intrinsicCapacitySearch.ts:1368`, `:1429`, `intrinsicPeriodicFamilyPortfolio.ts:1278-1282`'s
`Number.isSafeInteger(value) && value >= 0` batch check on survival-audit
counters) — these are **validation gates on already-computed values**, not
themselves budget-consuming operations, so they carry no deadline-timing
hazard beyond "must be evaluated with the same strictness" (a Rust
`u64`/checked-arithmetic counter type naturally satisfies "safe non-negative
integer" by construction and makes these specific checks either
unconditionally true or replaced by a type-level invariant — acceptable
simplification *only if* the checkpoint-corruption detection behavior these
checks exist for is preserved by some other means, e.g. still validating
that a deserialized `u64` doesn't exceed a documented bound if the JS
`Number.isSafeInteger` check was ever actually catching out-of-range rather
than wrong-type values — not fully disambiguated by this audit, flagged in
§15).

---

## 11. Error paths

Not this cluster's primary subject — see `errors-protocol.md` for the full
tagged-error-class catalog. JS-semantics intersection found in this sweep:

- `JSON.parse` failures (2 call sites, both inside checkpoint/frame-loading
  paths owned by `worker-coordination.md`) throw a `SyntaxError` on
  malformed JSON — must map to a typed Rust `Result::Err`, not a panic.
- `JSON.stringify` **throws** a `TypeError` on any `bigint` value reached
  without a special case (§8.1's Periodic-encoder landmine) and on circular
  references (not found to be reachable in this sweep's traced structures,
  but not exhaustively proven absent) — any Rust translation of a
  `JSON.stringify`-based encoder must decide, per site, whether to
  (a) reproduce the throw as a Rust `panic!`/`Result::Err` (preserving "this
  is a genuine programming-error landmine, not a data-error path" if that's
  what the TS behavior implies) or (b) prove the throwing input shape is
  unreachable in the Rust type system (preferred where provable, since Rust
  has no dynamic `bigint`-vs-`object` `typeof` ambiguity to accidentally
  trigger it) — this decision must be made **per encoder**, not globally,
  since §8.1 shows the four encoders have different (and differently
  landmine-prone) type coverage.
- `assertNever(value, label?)` (`src/shared/utils/assertNever.ts:1-9`) throws
  an `Error` whose message embeds `JSON.stringify(value)` — used as the
  exhaustiveness-check helper at the end of discriminated-union `switch`
  statements throughout the codebase (the Rust equivalent is exhaustive
  `match` with no default arm, which the Rust compiler enforces
  statically — this specific runtime helper becomes **entirely
  unnecessary** in the Rust port, a case where Rust's type system provides
  a stronger guarantee than the TS runtime check it replaces, which is safe
  per migration prompt §2 since it doesn't change any *reachable* observable
  behavior, only removes a runtime check for a case Rust's compiler already
  makes unreachable).

---

## 12. JS-specific semantics hazards for a Rust port (consolidated)

Ranked by severity (severity = blast radius × silence of failure mode):

1. **CRITICAL** — Four independent canonical-JSON-family encoders (§8.1)
   feeding three separate SHA-256 checkpoint/fingerprint hashes plus one
   beam-state dedup key, with real comparator (locale vs. code-unit) and
   `BigInt`/`Map` handling divergences between them. Must be ported as four
   distinct, independently-tested functions, never unified.
2. **CRITICAL** — `Number::toString` (ECMA-262 shortest-round-trip,
   exponential-notation-switchover algorithm) must be reproduced exactly
   for every number that can reach a key, cache identity, or hash input
   (§7.1). Verify any candidate Rust crate byte-for-byte against V8 output
   before trusting it; do not use `f64::to_string()`/`{}` `Display`.
3. **CRITICAL** — `localeCompare`-based sorts (135 sites, 26 files) need a
   verified ICU-equivalent collator matching Node's default-locale root
   collation, kept strictly separate from the 100+ code-unit (`compareStrings`/
   `compareCanonicalKeys`/bare-`.toSorted()`) sites that must **not** go
   through the same collator (§5.2, §6 item 4).
4. **MAJOR** — `Math.round` (round-half-toward-+∞) vs. the hand-rolled
   `Math.sign(x)*Math.floor(abs(x)+0.5)` (round-half-away-from-zero,
   coincidentally matching Rust's `.round()`) are two *different*, both
   live, rounding conventions applied to millimeter→grid conversions in
   different files — a global "replace `Math.round` with `.round()`"
   mechanical translation is wrong for roughly half of these sites (§7.3
   items 1-2).
5. **MAJOR** — `Math.max`/`Math.min` propagate `NaN`; Rust's `f64::max`/
   `f64::min` methods ignore `NaN` and return the non-`NaN` operand instead
   (§7.3 item 3). 397+188 call sites; not individually audited for
   NaN-reachability by this document — treat as a standing translation rule,
   not a closed list.
6. **MAJOR** — `Object.is(value, -0)` normalization (18 independently
   hand-written copies, §7.5) must translate to `f64::to_bits()`
   equality/`is_sign_negative()`, never `== -0.0` (which is always `true`
   for JS `===` too, so this specific pitfall is about picking the wrong
   Rust primitive, not misunderstanding the JS source).
7. **MODERATE** — Bare `.toSorted()`/`.sort()` on `[string, number]` `Map`-
   entry tuples (`intrinsicPeriodicCells.ts:531,689,1144`) relies on
   `Array.prototype.toString`'s implicit comma-join stringification for
   comparison, not a key-only sort — already fully characterized by
   `periodic.md`, reconfirmed here (§5.2 item 3).
8. **MODERATE** — `Object.keys`/`Object.entries`/`Object.fromEntries`'
   forced-ascending-numeric-key-first enumeration order for canonical-array-
   index-shaped string keys (§5.4) is currently latent (masked by
   already-ascending source literals) at `intrinsicQueueBeamDiscriminator.ts:756,766-816`
   — must be handled explicitly (force ascending-numeric order
   unconditionally in the Rust serializer for these specific `Record`
   types), not left to whatever order an `IndexMap`/`Vec` happens to
   preserve.
9. **MODERATE** — `canonicalToken`'s length prefix is a UTF-16 code-unit
   count (`value.length`), not a byte length or scalar-value count (§8.3) —
   must use `.encode_utf16().count()` in Rust for any non-provably-ASCII
   token content.
10. **MINOR (but must be proven, not assumed)** — Transcendental-function
    (`sin`/`cos`/`atan2`/`sqrt`/`hypot`) last-bit agreement between V8's math
    library and whatever libm Rust links against is not guaranteed by
    either being "IEEE-754 compliant" in the abstract (§7.3 items 5-6) —
    needs a dedicated differential test sweep across the geometry domain.
11. **MINOR, non-live** — `PieceId`/`SourceFileId`/etc. `Math.random()`-based
    ID generation fallback (`src/shared/domain/ids.ts:26-30`) is
    non-deterministic and has no Rust-reproducible equivalent, but is only
    reachable from `src/shared/presetShapes.ts:127` (module-load-time preset
    catalog generation), never from the nesting-request hot path — confirmed
    not live for this cluster's purposes (§1, §12 liveness proof: grep of
    `PieceId.make(` call sites shows only `presetShapes.ts`, `prepareCsvPieces.ts`
    (explicit-argument form, deterministic), and `sourcePiecesForPreparedPieces.ts`
    (explicit-argument form, deterministic) — no call site inside
    `src/workers/` invokes the zero-argument random-generating overload).

---

## 13. Parallelism assessment

This audit's subject matter (comparators, canonical encoders, numeric
formatting) is **pure, side-effect-free function evaluation** in every case
found — no comparator, encoder, or numeric helper in this sweep mutates
shared state, observes a cache, or checks a deadline. This makes all of it
a **safe Rayon candidate for the computation itself**, subject to the
migration prompt §14.3 deterministic pattern (ordinal-indexed parallel
evaluation, serial reconstruction) — **but** three of this audit's own
findings constrain *how* that parallelism must be structured:

- Because stability matters for every `.sort()`/`.toSorted()` call whose
  comparator can return a tie (§5.1), any parallel pre-computation of sort
  keys must preserve original array index as an explicit tie-break if the
  parallel evaluation order could otherwise scramble which of two
  originally-adjacent equal-key elements ends up first — i.e. compute keys
  in parallel, then perform the actual sort **serially and stably** keyed
  on `(comparator_result, original_index)`, per prompt §14.3 exactly.
- The SHA-256 checkpoint-hash construction (§8.1, §8.5) is itself a cheap,
  purely-serial reduction over an already-fully-assembled string — safe to
  leave serial regardless of how the string's *contents* were assembled
  (which may itself be safely parallelized, subject to the ordering
  constraints already documented per-cluster) — consistent with
  `periodic.md:374`'s identical conclusion for its own hash sites.
- `canonicalGridConvexHull`'s `Map`-based first-position/last-value dedup
  (§7.1) is **not** independent-of-iteration-order in the strict sense —
  if the input `points` array were ever assembled by a non-deterministic
  parallel merge (it is not, currently — always a plain serial
  `.map()` production, per this audit's read of every call site), the
  *choice* of which duplicate-coordinate point instance survives could
  become race-dependent. Not an actual current risk (the input is always
  serially constructed today), but a constraint on any future
  parallelization of the geometry-preparation step that feeds this
  function's input array.

No new high-risk parallelization boundary beyond what migration prompt §14.2
and the per-cluster docs already identify was found by this audit.

---

## 14. Tests and gates covering this cluster

Grep of `tests/` and `scripts/` for coverage directly exercising the
JS-semantics patterns audited above:

- `tests/unit/canonicalGridMath.test.ts` (179 lines) — differential test of
  `canonicalGridCrossSign`'s `Number`-fast-path against the exact `BigInt`
  oracle (`canonicalGridCross`), using a seeded (non-`Math.random()`) LCG
  for reproducibility (§7.2). Also exercises `canonicalGridConvexHull`,
  `canonicalGridAbsoluteDoubledArea`, `compareCanonicalGridRatios`.
- `tests/unit/canonicalCollisionPolygonKeyEquivalence.test.ts` (237 lines) —
  exercises the `canonicalCollisionPolygonKey`/`canonicalPointKey`/
  `canonicalNumber` family from `irregularBeamState.ts` (§7.1, §8.1's
  fourth encoder).
- `tests/unit/canonicalGridContact.test.ts`, `canonicalLayoutGeometry.test.ts`,
  `irregularLayoutCanonicalization.test.ts`, `ringFingerprintAccessPath.test.ts` —
  further canonical-key/geometry-identity coverage, owned by
  `validation-spatial.md`/`search-scoring.md`'s test inventories.
- `tests/unit/irregularSeventeenShapesCompactGolden.test.ts`,
  `tests/unit/irregularTriangleCompactGolden.test.ts` — full-pipeline golden
  output tests; these are the tests most likely to **catch** (not
  specifically target) any of this audit's hazards, since a comparator or
  number-formatting divergence anywhere in the pipeline would eventually
  perturb selected placement order or a canonical key embedded in the
  golden output.
- `tests/unit/intrinsicAnytimeArchive.test.ts`,
  `tests/unit/intrinsicCapacityIntegration.test.ts`,
  `tests/unit/intrinsicCapacityMode.test.ts`,
  `tests/unit/intrinsicPeriodicFamilyPortfolio.test.ts`,
  `tests/unit/intrinsicShortSidePairFoldObserver.test.ts`,
  `tests/unit/intrinsicSqueezeDisruptSeparate.test.ts`,
  `tests/unit/irregularPortfolio.test.ts`,
  `tests/unit/irregularWindowedBeam.test.ts`,
  `tests/unit/trustedGeometryCarrierBoundary.test.ts` — matched by grep for
  `localeCompare`/`canonicalJson`/`toSorted` string literals appearing in
  test fixture/assertion code; **none of these appear to directly unit-test
  the `localeCompare`-vs-code-unit comparator choice itself** (i.e., no test
  found asserts "this specific field is sorted by locale collation, and
  here is a fixture where that produces a different order than code-unit
  comparison would") — this is a **coverage gap** relevant to this audit's
  top finding (§12 item 3): the existing test suite would very likely
  **not** catch a Rust port that silently substituted code-unit comparison
  for locale comparison (or vice versa) at any of the 135 sites, unless the
  substitution happened to also change selected-layout output in one of the
  golden tests by coincidence. Flagged as an open question / recommended
  new test in §15.
- `scripts/irregular-capacity-gate.ts` — the only dedicated gate script
  found under `scripts/` with "gate" in its name; owned by
  `capacity-search.md`/`capacity-core.md`'s test/gate inventories, not
  independently re-examined here for JS-semantics-specific assertions.
- No test found anywhere under `tests/` that specifically constructs a
  fixture with non-ASCII/non-BMP piece labels or IDs to probe the
  UTF-16-code-unit-length (`canonicalToken`, §8.3) or lone-surrogate
  (`sha256`, §8.5) hazards — both are **untested edge cases today**, not
  just unported ones.

---

## 15. Open questions and ambiguities

1. **Contradicts migration prompt §9's framing.** The prompt describes "the
   current custom encoding" for canonical checkpoint JSON as if singular.
   **Source truth (§8.1): there are at least four independently-implemented
   canonical encoding functions in this cluster** — three JSON-shaped
   (`intrinsicStrictCanonicalJson`, `intrinsicCapacitySearch.ts`'s
   `canonicalJson`, `intrinsicPeriodicFamilyPortfolio.ts`'s `canonicalJson`)
   with real comparator and `BigInt`/`Map`-handling divergences between
   them, plus one non-JSON netstring-style encoder
   (`irregularBeamState.ts`'s `canonicalRecord`/`canonicalToken`). The Rust
   port's implementation plan should explicitly enumerate these as four
   separate deliverables with four separate differential test suites, not
   design one "canonical JSON" module and expect it to cover all checkpoint
   namespaces.
2. Is `intrinsicQueueBeamDiscriminator.ts:756,766-816`'s `delayedLineage`/
   `experimentalWidthRoles`/`survivesAtTotalCapacities`/
   `survivesAtExperimentalWidths` diagnostic block (§5.4's latent
   integer-key-reordering hazard) reachable in any canonical, hashed, or
   parity-gated output, or is it purely a calibration/debug artifact
   (per prompt §13.7's "non-semantic diagnostic sink" carve-out) that the
   Rust port can implement with any convenient ordering, or even omit
   entirely from the first parity milestone? This audit traced its
   assignment site but not its full downstream consumer chain within the
   time budget for this cluster — needs a definitive liveness ruling from
   whichever cluster ends up owning `intrinsicQueueBeamDiscriminator.ts`'s
   full behavioral characterization (currently split across
   `nfp-ifp.md`/`search-scoring.md`/`errors-protocol.md`/
   `strict-decoder-gap-family.md`/`validation-spatial.md` per §1's mapping,
   none of which claims this file as primary owner).
3. **Environment dependency on ICU/locale for `localeCompare` (135 sites).**
   `localeCompare`'s result depends on the ICU data bundled with the
   Node/V8 build in use and on the resolved default locale (confirmed
   `en-US`/full-ICU on the machine this audit ran on, via
   `Intl.Collator().resolvedOptions()`) — but this was **not** verified
   against the actual Electron-packaged production runtime's Node/V8/ICU
   configuration (Electron bundles its own V8; whether it matches the dev
   Node's ICU data and default-locale resolution was not independently
   confirmed by this audit, only assumed consistent). If Electron's bundled
   ICU or locale resolution ever differs from the reference Node used to
   generate golden fixtures, **the golden fixtures themselves would not be
   a stable oracle for `localeCompare`-dependent ordering**, independent of
   anything the Rust port does. Recommend explicitly pinning/asserting the
   ICU version and default-locale resolution used to generate any
   `localeCompare`-sensitive golden fixture, and re-verifying against the
   actual packaged Electron runtime, before treating those fixtures as the
   Rust port's oracle for collation-order parity.
4. Is the `Math.max`/`Math.min` NaN-propagation divergence (§7.3 item 3,
   §12 item 5) actually reachable at any of the 397+188 call sites in this
   cluster, or are all operands always already `Number.isFinite`-gated
   upstream (which the pervasive `Number.isFinite` gating pattern found
   throughout this sweep, §7.4, makes plausible but which this document did
   not exhaustively prove for all 585 sites)? A full site-by-site NaN-
   reachability audit was out of scope for this document's time budget;
   recommend either (a) a targeted follow-up sweep before the Rust port
   trusts `.max()`/`.min()` method calls anywhere in translated code, or
   (b) adopting the safe default of a NaN-propagating wrapper everywhere,
   permanently, and never revisiting the question.
5. Does any code path construct a piece label, `source.id`, or
   interchangeability key containing non-BMP Unicode content (surrogate
   pairs) or lone surrogates, which would make §6 item 1's code-unit-vs-
   UTF-8-byte-order divergence and §8.3's/§8.5's UTF-16-length/lone-
   surrogate hazards concretely reachable rather than theoretical? Not
   traced to the UI/import boundary by this audit (out of scope — this
   cluster is `src/workers/`+`src/shared/`, not the renderer/import
   pipeline); recommend the orchestrator confirm with whichever
   characterization effort covers piece import/label assignment whether
   arbitrary Unicode is actually reachable in these fields in production.
6. §7.4's claim that no bare (non-`Number.`-qualified) `isFinite`/`isNaN`
   reaches a canonical computation path was verified by spot-check, not an
   exhaustive re-audit of all 292 matched lines — flagged as a
   light-verification item; if a canonical-path use of the coercing global
   forms is later found, it needs its own dedicated hazard entry (the
   coercing global `isFinite`/`isNaN` first apply `ToNumber` to a non-number
   argument, which has no meaningful Rust equivalent for already-typed
   `f64` values and would only matter if the JS call site could ever
   receive a non-number-typed value, itself unlikely given this is a
   TypeScript codebase with static typing at every such call site — but not
   proven impossible given `any`/`unknown` escape hatches are possible
   anywhere).
