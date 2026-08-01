# Tests and Gates Inventory — Compact / Compact Short Side

Cluster: `tests-gates-inventory`. This document characterizes the **test and
gate layer** itself — the files that pin exact behavior for the current
TypeScript implementation and that a Rust port must reproduce byte-for-byte —
rather than the algorithmic semantics of any one subsystem (those are covered
by the 13 sibling cluster docs in this directory). Every nontrivial claim below
was verified by reading the named file(s) in full and, where a script writes a
provenance artifact, by inspecting the checked-in artifact JSON.

Governing spec: `docs/history/prompts/fable5-rust-irregular-nesting-implementation.md`
§§2, 3, 8, 9, 13, 14, 18 (read in full for this document). §3 is the operative
rule for this cluster: **the existing tests and gate scripts are immutable**;
the Rust port must pass them unmodified, and any apparent inconsistency must be
reported to the user rather than "fixed" by editing a test or fixture.

## 1. Purpose and role in Compact / Compact Short Side execution

This cluster has two kinds of members, and the distinction matters for the
port:

1. **Vitest unit/integration suites** (`tests/unit/*.test.ts`,
   `tests/renderer/*.test.ts`) — run by `pnpm test` /
   `pnpm test:focused`. These are the CI-authoritative correctness gate. They
   run inside Electron's Node runtime (see §12).
2. **Standalone `tsx` provenance/gate scripts** (`scripts/irregular-*.ts`) —
   most are **not** wired into `package.json` and are **not** CI gates; they
   are research/diagnostic harnesses that write timestamped evidence under
   `/private/tmp/...` or a `--output` directory. Exactly four are promoted to
   `package.json` scripts and are production gates:
   - `gate:mixed61-compact` → `scripts/irregular-sheet-invariance.ts`
     (`corpus:sheet-invariance` with `--case mixed-61 --sheets 2000x2700`)
   - `gate:compact-nine-baselines` → `scripts/irregular-compact-nine-baselines.ts`
     (which shells out to `scripts/irregular-compact-baseline.ts` 18 times)
   - `gate:capacity` / `gate:capacity:production` →
     `scripts/irregular-capacity-gate.ts`
   - `corpus:sheet-invariance` (used ad hoc for the 10-sheet historical matrix,
     not wired to a single fixed `pnpm` alias beyond `gate:mixed61-compact`)

   `scripts/profile-mixed61.mjs` and `scripts/analyze-cpu-profile.ts` are
   **performance-profiling** tools, not gates, but `profile-mixed61.mjs`
   internally reruns `scripts/irregular-compact-baseline.ts --strict` with the
   exact same pinned Mixed-61 values as the gate scripts, so a broken parity
   also breaks profiling (nonzero exit before the CPU profile is analyzed).
   `scripts/irregular-benchmark.ts` (`pnpm benchmark:irregular`) is a
   performance/regression benchmark with only a legality audit
   (`assertCanonicalGridLegalLayout`), not an exact-value gate.

   All remaining `scripts/irregular-intrinsic-*.ts`,
   `scripts/irregular-overlap-relaxation*.ts`,
   `scripts/irregular-short-side-*.ts`, `scripts/irregular-targeted-exact-lns-probe.ts`,
   `scripts/irregular-sheet-trace-dump.ts`, and
   `scripts/verify-irregular-intrinsic-shared-archive.ts` are **research
   evidence harnesses** for modules and code paths that are largely
   non-production (see §1a). They are not invoked by any `package.json`
   script and are not part of CI. Confirmed by: `grep -n "scripts/irregular"
   package.json` returns only the five promoted aliases above; none of the
   other 18 `irregular-intrinsic-*`/probe/evidence scripts appear.

### 1a. Liveness of the modules these scripts/tests exercise

- `scripts/irregular-compact-baseline.ts`, `irregular-compact-nine-baselines.ts`,
  `irregular-sheet-invariance.ts`, `irregular-capacity-gate.ts`, and the two
  golden vitest specs (`irregularTriangleCompactGolden.test.ts`,
  `irregularSeventeenShapesCompactGolden.test.ts`) all call
  `computeIrregularNesting` (`src/workers/algorithm/irregular/computeIrregularNesting.ts`)
  directly — the same production entry point the Electron worker uses
  (traced further in `worker-coordination.md`). These are on the live
  production path.
- The `irregular-intrinsic-*` probe scripts import individual internal
  modules (`runIntrinsicV7SeedArchive`, `runIntrinsicPeriodicFamilyPortfolio`,
  `runIntrinsicSharedArchiveDirectPortfolio`, `intrinsicPeriodicSmallFillE3`,
  `runIntrinsicGlobalSqueezePortfolio`, `runIntrinsicQueueBeamDiscriminator`,
  etc.) and call them **directly**, bypassing `computeIrregularNesting`.
  Whether each such module is *also* reachable from `computeIrregularNesting`
  in production is a per-module question answered by the other cluster docs
  (`periodic.md`, `shared-archive.md`, `capacity-core.md`,
  `capacity-search.md`); this document only establishes that the *scripts*
  themselves are not gates and carry no pinned-value authority over the Rust
  port. One module is explicitly flagged dead in `periodic.md:60`:
  `intrinsicPeriodicSmallFillE3.ts` has "no importer anywhere in `src/`" —
  its only caller is `scripts/irregular-intrinsic-periodic-small-fill-e3.ts`.
  `scripts/irregular-intrinsic-v7-seed-archive.ts` is explicitly
  self-labeled non-authoritative: its emitted report always sets
  `status: 'diagnostic-only-no-production-winner'`
  (`scripts/irregular-intrinsic-v7-seed-archive.ts:357`) and
  `triangleGolden.note` states "This experiment ancestry is not current main"
  (`:379`). It never sets `process.exitCode`/`process.exit` on any
  pass/fail condition (verified by grep across the file) — it is pure
  evidence capture.
- `scripts/verify-irregular-intrinsic-shared-archive.ts` is a repeatability
  comparator for two saved runs of `irregular-intrinsic-shared-archive.ts`
  (diffs `report.json` byte-for-byte on selected fields); it is a manual
  research tool with a hardcoded fixture list (`triangle-20`, `mixed-61`,
  `rectangles-20`, `pentagons-20`), not a CI gate.

## 2. Entry points, callers, callees (traced, not guessed)

- **`pnpm test`** (`package.json:26`) → `pnpm native:electron && ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run` → vitest, configured by `vitest.config.ts:1-15`, which includes `tests/unit/**/*.test.ts` and `tests/renderer/**/*.test.ts` with `environment: 'node'` and path aliases `@shared → src/shared`, `@main → src/main`.
- **`pnpm test:focused`** (`package.json:27`) → same vitest invocation without a preceding `native:electron` rebuild, used by `docs/operations/irregular-production-gates.md:34-41`'s "Focused Correctness Gate" to run seven specific spec files plus the two production gate scripts.
- **`pnpm gate:mixed61-compact`** (`package.json:32`) → `pnpm corpus:sheet-invariance --case mixed-61 --sheets 2000x2700 --allow-single-sheet --strict --expected-canonical-sha256 ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b --maximum-area-mm2 391606 --maximum-canonical-cavities 0 --maximum-elapsed-ms 330000` → `scripts/irregular-sheet-invariance.ts` → `computeIrregularNesting` (once, no-options, `historyMode: 'off'`) → `canonicalizeIrregularLayout` (`scripts/lib/irregularLayoutCanonicalization.ts`, not read in full for this doc — canonical hashing is covered by `geometry-caches.md`/`shared-archive.md`) for the SHA-256, and `measureCanonicalLayoutTopology` for cavity count.
- **`pnpm gate:compact-nine-baselines`** (`package.json:33`) → `scripts/irregular-compact-nine-baselines.ts` → spawns `pnpm exec tsx scripts/irregular-compact-baseline.ts` as a **child process**, twice per baseline (once `--objective-profile` omitted = Compact, once `--objective-profile short-side`), for each of 9 `(fixture, sheet)` pairs → 18 total `computeIrregularNesting` invocations, strictly sequential (script awaits each `runProcess` before starting the next; `irregular-compact-nine-baselines.ts:220-235,393-410`).
- **`pnpm gate:capacity` / `gate:capacity:production`** (`package.json:34-35`) → `scripts/irregular-capacity-gate.ts --strict [--paired]` → in-process (no subprocess spawn) `computeIrregularNesting` calls for 8 fixtures, each run in a `production` arm and (if `--paired`) a `cold-only` arm (`capacityControlArm: 'disable-prefix-reuse'`), always sequential (single `for` loop, `irregular-capacity-gate.ts:1051-1078`).
- **`pnpm profile:mixed61`** (`package.json:30`) → `scripts/profile-mixed61.mjs` → spawns `node --cpu-prof ... --import tsx scripts/irregular-compact-baseline.ts --fixture mixed-61 --sheet 2000x2700 --strict [pinned expectations]`, then `scripts/analyze-cpu-profile.ts --profile <path> --top 40`. Not a correctness gate but re-asserts the same Mixed-61 pinned values as `gate:compact-nine-baselines`'s Mixed-61 row (`profile-mixed61.mjs:31-56`).
- **`pnpm corpus:sheet-invariance`** (`package.json:31`) → `scripts/irregular-sheet-invariance.ts`, used both by `gate:mixed61-compact` and manually for the historical 10-sheet matrix documented in `docs/operations/irregular-production-gates.md:102-128`.
- **`pnpm benchmark:irregular`** (`package.json:29`) → `scripts/irregular-benchmark.ts`, a perf/regression tool, not wired to any gate. Its only correctness check is `assertCanonicalGridLegalLayout` per run (`irregular-benchmark.ts:973-976`), which throws (not `process.exitCode`) on illegal geometry.

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

- All gate/baseline scripts build a `NestingRequest` (`src/shared/domain/nesting.js`) either from generated preset shapes (`makePresetShapeDocument`) or from DXF import (`importDxfFile`) or by decoding the persisted fixture `tests/fixtures/irregularSheetInvariance/mixed61-request.json` via `Schema.decodeUnknownSync(NestingRequest)`. The Mixed-61 fixture is 4,658 lines of JSON and is documented as "the exact persisted 61-piece request from job `780d4ec5-b64e-4f48-a8d8-0bfd30877549`" (`tests/fixtures/irregularSheetInvariance/README.md:3-4`) — sheet `2000 x 2700 mm`, `10 mm` padding, reorder window `4`, beam width `8`, local fanout `4`, repair disabled, transform cap `8`, edge-contact policy, GA disabled.
- `NestingOptions.irregularSettings` is always overridden per-script (e.g. `timeoutMs: 0`, `historyMode: 'off'` or `'final'`) even when starting from the persisted fixture — so the fixture's own `options.timeoutMs`/`historyMode` are **not** what production gates run under; scripts construct a fresh `NestingOptions` wrapping the same `irregularSettings.optimizer`/`geometry`. A Rust differential harness replaying these gates must reproduce this override, not the fixture's raw options.
- Gate scripts read `IrregularComputeResult` (`computeIrregularNesting.ts`) fields: `placedCollisionGeometries`, `unplacedPieceIds`, `score`, `portfolio` (`source`, `status`, `terminationReason`), `capacityTrace`, `capacityShadowTelemetry`, `intrinsicAnytimeSchedulerTrace`, `experimentalPlaceDeferTrace`, `focusedCompleteReconstructionTrace`, `intrinsicShortSideObserverTrace`, `intrinsicShortSidePairFoldTrace`. Every one of these is `| undefined` in the type and is omitted from JSON reports via a custom `jsonSafe` helper (`JSON.parse(JSON.stringify(value, (_,e) => typeof e === 'bigint' ? e.toString() : e))` — `irregular-compact-baseline.ts:351-357`, `irregular-capacity-gate.ts:946-952`, `irregular-short-side-shelf-probe.ts:355-361`, `irregular-short-side-strip-evidence.ts:157-163`) — this is `JSON.stringify`'s native `undefined`-drops-key behavior, not a bespoke encoder; it is **not** the canonical checkpoint encoder that §9 of the migration prompt requires byte parity for (that encoder is covered by other cluster docs, e.g. `capacity-core.md`/`shared-archive.md`). BigInt values, where present (e.g. canonical-grid coordinates), are stringified before `JSON.stringify`, matching prompt §9's "BigInt values encoded as quoted base-10 strings" requirement for these report artifacts too.
- `irregular-compact-baseline.ts` writes two artifacts per invocation: `${outputPrefix}.json` (full report) and `${outputPrefix}.svg`, and — only when `--capture-short-side-observer` is passed — a third `${outputPrefix}.short-side-profile.json` + `.svg` pair. `irregular-compact-nine-baselines.ts` always passes `--objective-profile short-side` on the second of its two sub-invocations per baseline rather than `--capture-short-side-observer`, so the 18-layout matrix's "short-side" row is a **separate full Compact Short Side production run** (`intrinsicObjectiveProfileId: 'short-side'` threaded into `IrregularOptimizerSettings`, `irregular-compact-baseline.ts:363-369`), not an observer-only diagnostic. This is an important distinction: the 18-layout matrix does not exercise the "guarded observer" code path pinned counts in §4 below by default (those come only from the `--capture-short-side-observer` diagnostic flag).

## 4. Algorithm state and every mutation point

Not applicable in the usual sense — these are test/gate harnesses, not
stateful algorithm modules. The state worth documenting here is **harness
state that could affect reproducibility**:

- `irregular-compact-nine-baselines.ts` accumulates `outcomes: Array<{fixture, sheet, passed, error?}>` and `layoutRecords: Array<...>` by iterating `BASELINES` **in the fixed literal array order** (`irregular-compact-nine-baselines.ts:27-183`): `triangle-20/2000x2700`, `mixed-61/2000x2700`, `shapes-17/2000x2700`, `triangle-20/600x400`, `mixed-61/600x400`, `shapes-17/600x400`, `triangle-20/300x300`, `mixed-61/300x300`, `shapes-17/300x300`. This order determines only report/manifest ordering, not algorithm output — each baseline is an independent process.
- `irregular-capacity-gate.ts` mutates `warmLaneEndpoints: Array<...>` and `cohesionEndpoint: IntrinsicCapacityEndpoint | undefined` via `onCapacityWarmPrefixLane`/`onCapacityCohesionShadowLane` callbacks threaded through `ComputeIrregularNestingOptions` (`irregular-capacity-gate.ts:497-538`) — these are **observation callbacks only**; per the module's own contract (also asserted by `checks.qualityWarmPrefixContract` etc.) they must not affect `computeIrregularNesting`'s returned result. A Rust port's equivalent instrumentation hooks must preserve this: callback firing order/timing may be observed for tests but must not feed back into search state.
- `verify-irregular-intrinsic-shared-archive.ts` accumulates a `failures: string[]` array across a `for (const fixture of fixtures)` loop and throws once at the end if non-empty (`:189-191`) — order-sensitive only for its own error message, not semantically load-bearing.

## 5. Ordering sources: sorts, Map/Set insertion order, iteration order reaching output

- `irregular-sheet-invariance.ts:274` sorts `shapes-17`/DXF file names with
  `.sort((first, second) => first.localeCompare(second, undefined, { numeric: true }))`
  — same comparator used independently in `irregular-compact-baseline.ts:246`,
  `irregular-intrinsic-shared-archive.ts:868`, and
  `irregularSeventeenShapesCompactGolden.test.ts:41`. All four call sites
  order the 17 DXF fixture files identically, so `Shapes-17`'s piece ID
  assignment (`shapes-17-1` .. `shapes-17-17`) is filename-sort-order
  dependent and is pinned identically by both the gate script and the unit
  test. A Rust harness reproducing this fixture must implement the exact
  same `numeric: true` locale-aware comparator (see §6 for the exact
  semantics) or piece IDs — and therefore every downstream hash — will
  diverge.
- `irregular-compact-nine-baselines.ts:667-674` and
  `irregular-capacity-gate.ts:1218-1225` both sort the artifact directory
  listing with plain `.sort((first, second) => first.localeCompare(second))`
  (no `numeric` option) before hashing each file into the manifest — this
  governs only the `SHA256SUMS`/`manifest.json` provenance file layout, not
  any nesting output.
- `irregular-capacity-gate.ts:1049-1051` iterates the `fixtures` **module-level
  array literal** (`:104-223`) in declaration order:
  `capacity-area-proven-rect2`, `capacity-singleton-proven`,
  `capacity-archive-miss-squares2`, `capacity-count-vs-material`,
  `capacity-triangles20-300x300`, `capacity-mixed61-500x400`,
  `capacity-mixed61-700x500`, `capacity-mixed61-700x560`. Order affects only
  report/console ordering (each fixture is fully independent); it does not
  affect `passed`.
- `irregular-sheet-invariance.ts:559,375` iterate `allCaseIds` (=
  `generatedCases.map(id) ++ ['mixed-61']`, `:111`) filtered by
  `selectedCaseIds` — a `Set`, but only used for membership testing
  (`.has(caseId)`), never iterated, so `Set` insertion order is not
  observable here.
- `irregular-compact-baseline.ts:667` sorts `requestedPieceIds`/other ID
  arrays with plain `.sort()` (default lexical) purely for the
  `exactPiecePartition` equality check — this is a test-only comparison, not
  a value that reaches canonical output.

## 6. Comparators and tie rules: exact comparison chains, signs, tie-breakers

- The `localeCompare(second, undefined, { numeric: true })` DXF-filename
  comparator (§5) is the one comparator in this cluster with externally
  visible, hash-affecting consequences. `numeric: true` makes it a "natural
  sort" (`3268390_2.dxf` sorts before `3268390_10.dxf`) rather than pure
  lexical ASCII/code-unit order. **The `tests/fixtures/irregularSeventeenShapes/`
  files are named `3268390_1.dxf` … `3268390_17.dxf`** (confirmed via
  directory listing). I verified both orderings directly with Node
  (`Array.prototype.sort` with and without `{numeric:true}` over the real
  17 filenames): natural sort produces `_1, _2, _3, …, _9, _10, _11, …,
  _17`, while plain lexical/code-unit sort produces `_1, _10, _11, …, _17,
  _2, _3, …, _9` (because the ASCII byte `.` (`0x2E`) that starts `.dxf`
  sorts below the digit `0`–`9` range, so `3268390_1.dxf` — whose next byte
  after `_1` is `.` — sorts before `3268390_10.dxf` — whose next byte is
  `0` — which in turn sorts before `3268390_2.dxf`). These two orderings
  are **confirmed different** (`natural !== plain`, verified empirically),
  so `Shapes-17` piece-ID assignment (`shapes-17-1` .. `shapes-17-17`, in
  natural-sort file order) depends on implementing genuine natural/numeric
  sort, not naive byte comparison. A Rust port must implement locale-aware
  "numeric" comparison (e.g. splitting digit runs and comparing them as
  integers) or `Shapes-17` piece-ID assignment — and hence the pinned
  `1ddc8426...`/`490194ca...`/etc. hashes — will not reproduce. This is the
  single highest-risk hidden comparator in this cluster.
- `irregular-sheet-invariance.ts:274,868` and `irregular-compact-baseline.ts:246`
  use `Intl`-backed `String.prototype.localeCompare` with the **default
  locale** of the running Node/Electron process (no explicit locale argument
  is passed as the first parameter — the calls are `a.localeCompare(b,
  undefined, {numeric:true})`, i.e. `undefined` locale = "use the runtime
  default locale", governed by ICU data bundled with Node/Electron). For pure
  ASCII decimal filenames this should be locale-invariant, but the Rust
  implementation should pin an explicit collation (e.g. natural-sort on
  ASCII digit runs) rather than rely on any ICU-equivalent crate defaulting
  differently.
- Artifact-manifest sorts (`localeCompare` without `numeric`) are plain
  code-unit-ish sorts for ASCII filenames; not hash-affecting.

## 7. Numeric semantics: BigInt, Number arithmetic order, Math.*, rounding, signed zero

- `irregular-short-side-shelf-probe.ts:381-384` converts an mm² area to a
  canonical grid² integer via `Math.round(productionEnvelopeAreaMm2 *
  1_000_000)` and asserts `Number.isSafeInteger(...)` on the result before
  using it — this mirrors the canonical-grid conversion documented in
  `nfp-ifp.md`/`capacity-core.md` (grid resolution `0.001 mm` ⇒ area scale
  `1e6`) but is reimplemented locally in this probe rather than imported from
  a shared grid-math module; not load-bearing for production but a data
  point that the grid-area scale factor `1_000_000` is treated as public
  knowledge across the codebase.
- `irregular-compact-baseline.ts:736` uses a `+ 0.000_001` slack when
  comparing `bounds.area <= args.maximumAreaMm2 + 0.000_001` — this is a
  **test-tolerance epsilon on a derived floating-mm² report metric**, not a
  ranking/geometry comparison; it exists purely to absorb IEEE-754
  representation noise in the CLI-supplied `String → Number` maximum-area
  argument. It is explicitly not the kind of epsilon prohibited by prompt
  §2's "Do not introduce an epsilon into any exact comparison" — that rule
  governs the *algorithm's* canonical comparisons, not this presentation
  check — but a Rust harness reproducing this specific gate check should
  keep the identical `1e-6` slack on this specific comparison to avoid
  spurious gate failures from binary64 print/reparse differences.
- `irregular-compact-baseline.ts:339-342`/`irregular-capacity-gate.ts` compute
  `area = width * height` and `span = width + height` from
  `Math.min/Math.max` over collision-polygon point arrays — ordinary
  floating arithmetic, order-independent for min/max but summation order for
  width/height is fixed (`maxX - minX`, `maxY - minY`) and single-term, so no
  reassociation risk.
- `irregular-compact-nine-baselines.ts` and `irregular-capacity-gate.ts`
  format elapsed time via `performance.now()` differences (`Math.max(0,
  performance.now() - startedAt)`); the `Math.max(0, …)` guard exists because
  `performance.now()` monotonicity is not guaranteed to survive floating
  subtraction rounding at the microsecond level, not a game with signed
  zero.

## 8. Serialization and hashing: JSON.stringify, canonical encoders, BigInt, undefined omission

- Every gate/baseline script hashes bytes with Node's `crypto.createHash('sha256')`. Two distinct hashing regimes exist and must not be confused:
  1. **Canonical geometry/layout hashes** (`collisionIdentitySha256`, `fittedCanonicalSha256`) come from `canonicalCollisionLayoutIdentity` (canonical collision identity string) and `canonicalizeIrregularLayout(...).sha256` (`scripts/lib/irregularLayoutCanonicalization.ts`, not read for this cluster — see `geometry-caches.md`/`shared-archive.md` for the canonical encoder itself). These are the values pinned in `docs/operations/irregular-production-gates.md` and `irregular-compact-nine-baselines.ts`'s `BASELINES` table and are exact-parity gates for the Rust port.
  2. **Provenance/manifest hashes** (`manifest.json`, `SHA256SUMS`) hash raw artifact file bytes (`irregular-compact-nine-baselines.ts:675-682,717-737`; `irregular-capacity-gate.ts:1226-1233,1265-1277`) — these protect evidence-trail integrity, not algorithm parity, and are irrelevant to Rust porting except as a reminder that report JSON formatting (`JSON.stringify(value, null, 2)` + trailing `\n`, used consistently across every script) is itself hashed, so pretty-print formatting changes would break manifest self-verification (not a parity concern, a script-internal integrity check only).
- `irregular-compact-baseline.ts:352-357` (`jsonSafe`) is the canonical
  "make BigInt JSON-safe" idiom used throughout this cluster: `JSON.parse(JSON.stringify(value, (_,e) => typeof e === 'bigint' ? e.toString() : e))`. This round-trips through `JSON.stringify`, meaning ordinary `undefined`-valued object fields are dropped exactly as native `JSON.stringify` drops them (no explicit "omit undefined" logic needed) and object key order follows **insertion order of the original JS object literal**, not any canonical sort. This is fine for evidence artifacts but is explicitly **not** claimed by these scripts to be the canonical-checkpoint encoder that prompt §9 requires exact parity for; that encoder lives in production code (see `capacity-core.md` for checkpoint JSON specifics) and must be characterized/ported separately from this report-writing convenience.
- `irregular-targeted-exact-lns-probe.ts:224-226` computes `selectedHash =
  sha256(JSON.stringify(result.placedCollisionGeometries))` — hashing the
  **raw placement array via default `JSON.stringify`**, not the canonical
  encoder. This is a probe-only ad hoc identity check (default key order,
  no ring-origin/winding normalization) and must never be treated as a
  parity oracle; it is included here only to flag that not every SHA-256 in
  this codebase is a canonical-identity hash — this file's `selectedHash` is
  order/representation-sensitive noise, unlike `collisionIdentitySha256`/
  `fittedCanonicalSha256`.

## 9. Caches touched and the exact historical access sequence

Not applicable at the gate-script level — these scripts each construct fresh
Effect layers per invocation (`Effect.provide(CollisionGeometryBuilder.Live)`,
`NfpIfpServiceLive`, etc.), so no cache state is shared across gate-script
processes, and within one process each `computeIrregularNesting` call gets
its own job-scoped caches (per `geometry-caches.md`/`nfp-ifp.md`). One
exception: `irregular-sheet-invariance.ts:643`
(`enableNfpIfpTelemetry()`/`nfpIfpTelemetrySnapshot()`) is a **process-global
telemetry singleton** (`src/workers/irregular/nfpIfpTelemetry.ts`, covered by
its own concerns in `geometry-caches.md`) enabled only when
`--capture-cache-telemetry` is passed; it accumulates counters across every
case/sheet run in one script invocation and is written once at the end
(`irregular-sheet-invariance.ts:630-635`) — global mutable state confined to
one script process, never asserted against in any gate (`captureCacheTelemetry`
is not used by `gate:mixed61-compact`'s fixed argument list).

## 10. Cancellation / deadline / budget / evaluation-cap observation points

- Every gate/baseline script sets `timeoutMs: 0` on its `NestingOptions`
  (`irregular-compact-baseline.ts:174`, `irregular-sheet-invariance.ts:347,461`,
  `irregular-capacity-gate.ts:276,301`) — i.e. gates run with the
  **outer request timeout disabled**, so any deadline/cancellation behavior
  they exercise is purely from internal search budgets (evaluation caps,
  runtime caps passed via `ComputeIrregularNestingOptions`), never the
  worker-level timeout classification (that is `worker-coordination.md`'s
  concern). `irregularSeventeenShapesCompactGolden.test.ts:79` is the one
  exception in this cluster with a nonzero `timeoutMs: 390_000` (matching
  the "irregular request timeout floor is `390,000 ms`" documented in
  `docs/operations/irregular-production-gates.md:165-166`), though the test
  itself still finishes well inside that budget in the accepted baseline
  (focused-reconstruction evaluation cap `8,035` well under any deadline).
- `irregular-compact-nine-baselines.ts`'s `BASELINES` table encodes a
  `maximumElapsedMs` **runtime ceiling** per case (`120_000` for
  Triangle-20/Shapes-17, `330_000` for Mixed-61 at every sheet) — this is a
  generous wall-clock ceiling checked by `irregular-compact-baseline.ts:741`
  (`checks.runtime`), not a deterministic cap; the actual observed runtimes
  are documented separately in `docs/operations/irregular-production-gates.md`'s
  table (e.g. Mixed-61 `2000x2700` observed `69.361 s` against a `330 s`
  ceiling) and are explicitly called out as "measurements, not exact timing
  assertions" (`docs/operations/irregular-production-gates.md:23-24`). A Rust
  port must not be gated on wall-clock ceilings for exact-parity purposes,
  only for the separate, later performance-promotion gate (prompt §19).
- The one **deterministic, exact-count** evaluation cap pinned by both a
  gate script and a unit test is the focused-complete-reconstruction cap:
  Mixed-61 `2000x2700` → `status: 'evaluation-cap'`,
  `consumedCandidateEvaluations: 12_000`
  (`irregular-compact-nine-baselines.ts:319-327`, cross-checked byte-for-byte
  against `docs/artifacts/current-compact-baselines/mixed-61-2000x2700.json`'s
  `result.focusedCompleteReconstructionTrace`); Shapes-17 `2000x2700` →
  `status: 'completed'`, `consumedCandidateEvaluations: 8_035`
  (`irregular-compact-nine-baselines.ts:328-336`, and independently pinned by
  the unit test `irregularSeventeenShapesCompactGolden.test.ts:118-126`).
  These evaluation counts are exact chronology-derived integers (not
  wall-clock-derived) and are prime Rust differential-parity gates per
  prompt §18.6.
- `irregular-capacity-gate.ts`'s `checks.auxiliaryEvaluationsZero` (`:1117-1119`)
  and `checks.coldSearchReachedEveryDepth` (`:1120-1124`) assert exact
  zero/coverage-complete integer invariants on the capacity cold-search
  trace, not wall-clock values — see `capacity-search.md` for the underlying
  semantics.
- `irregular-capacity-gate.ts` fixtures also pin exact prefix-depth/warm-lane
  identities: Mixed-61 `700x500` → `qualityWarmPrefix: {status:
  'evaluation-cap', outputInfluence: 'strict-count-improvement', sourceRole:
  'canonical-grid', prefixDepth: 15, endpointCanonicalGeometryHash:
  '0c98259d05531d74d14d7e72eac64d0d1f02e9ffb5e99910aabad048f67bf77d'}`
  (`:190-199`); Mixed-61 `700x560` → `prefixDepth: 30, endpointCanonicalGeometryHash:
  '2d252e359cf482f55bc5de60cdde7b3482a8f6b0493e1c686ae9d94296741e69'`
  (`:213-219`); Triangle-20 `300x300` → `status:
  'skipped-below-minimum-piece-count', prefixDepth: 10` (`:163-168`). These
  are chronology/accounting pins, differential-parity gates for the capacity
  cluster.

## 11. Error paths: tagged error classes, categories, context fields, propagation

- Gate scripts mostly let errors propagate as uncaught rejections (the
  scripts are top-level `await` ESM modules run under `tsx`; an uncaught
  throw exits the process nonzero, which is the desired gate-failure
  signal). Explicit typed-error handling appears in exactly two places in
  this cluster:
  - `irregular-intrinsic-family-portfolio-probe.ts:134-142` and
    `irregular-intrinsic-strict-probe.ts:110-118` and
    `irregular-intrinsic-periodic-small-fill-e3.ts` (via
    `IrregularNfpIfpControlAbortError`) catch the abort/deadline error class
    from `src/workers/irregular/services.js`
    (`error instanceof IrregularNfpIfpControlAbortError`) and convert it to a
    `status: 'deadline'` report row rather than letting the probe crash — a
    **probe-only** graceful-degradation pattern, not a production error path.
  - `irregular-intrinsic-global-squeeze-e4.ts:107-109,246-279` wraps its
    entire experiment in a `.then(success, failure)` pair and serializes any
    error via `serializeExperimentError` (captures `_tag`, `name`, `message`,
    `stack`) into `report.json`'s `failure` field — again probe-only
    evidence capture, not a production error-classification contract (that
    contract is `errors-protocol.md`'s concern).
- `irregular-targeted-exact-lns-probe.ts:181,211` are the only scripts in
  this cluster that use a **non-{0,1} process exit code as a semantic
  signal**: `process.exit(replayReports.every(r => r.replay.legal) ? 0 : 3)`
  and `process.exit(canonicalGridLegal ? 0 : 2)` — exit code `2` means
  "baseline preflight found the incumbent canonical-grid illegal", exit code
  `3` means "at least one destroy/replay lineage came back illegal". These
  are probe-specific conventions, not part of any documented production
  error taxonomy, and are not consumed by any other script.

## 12. JS-specific semantics hazards for a Rust port

- **Electron-vs-plain-Node runtime split.** `pnpm test`/`test:focused` run
  vitest **inside Electron's Node runtime** via `ELECTRON_RUN_AS_NODE=1
  electron ...` (`package.json:26-28`), required so native modules
  (`better-sqlite3`, rebuilt for Electron's ABI by `native:electron` →
  `electron-rebuild -f -w better-sqlite3`) load correctly. But every
  `scripts/irregular-*.ts` gate/baseline script runs under **plain `tsx`
  under plain Node** (`pnpm exec tsx --tsconfig tsconfig.node.json
  scripts/...`), with no Electron involvement at all. This means: (a) any
  future Rust N-API addon must be loadable from **two different Node ABI
  contexts** (Electron's bundled Node and the system/nvm Node that `tsx`
  runs under) for the full gate suite to pass, and this dual-runtime
  requirement is invisible if you only look at `vitest.config.ts`; (b) any
  Electron-runtime-specific behavior (e.g. subtly different V8 flags/build)
  is untested by the `scripts/irregular-*.ts` gate family and only tested by
  the vitest suite.
- **`localeCompare` default-locale dependence** (§5, §6) — the natural-sort
  DXF filename ordering depends on ICU data bundled with the Node/Electron
  build in use. A Rust natural-sort implementation must be pinned
  explicitly (e.g. digit-run comparison) rather than delegated to any
  locale-aware library whose collation tables could differ from Node's ICU
  snapshot.
- **`JSON.stringify` key-omission-on-`undefined` and insertion-order key
  serialization** (§8) is relied on throughout the report-writing code in
  this cluster as a convenience, not a contract — but the underlying
  production canonical-checkpoint encoder (covered by other docs) does rely
  on it as a contract per prompt §9, and the two are easy to conflate when
  reading these scripts. Do not assume any `JSON.stringify(...)` call site
  in `scripts/` is canonical-hash-relevant without checking whether its
  output feeds `createHash('sha256')` on a *geometry identity string*
  (canonical, parity-relevant) versus a *report/manifest object*
  (evidence-only, not parity-relevant).
- **`Number.isSafeInteger`/`Number.isFinite` guards are scattered ad hoc** in
  argument parsers (`optionalIntegerArgument`, `nonNegativeIntegerArgument`,
  `positiveIntegerArgument` — reimplemented near-identically in at least 6
  different scripts) rather than centralized; each has slightly different
  bounds (`< 0` rejected vs `<= 0` rejected vs `< 1` rejected). These are
  CLI-input validators, not part of the algorithm's own numeric-safety
  contract (prompt §8.1), but a Rust CLI-parity harness reproducing these
  gates verbatim should match each script's specific bound, not assume a
  single shared validator.
- **Process spawning and `pnpm`/`tsx` subprocess indirection.**
  `irregular-compact-nine-baselines.ts` spawns `pnpm exec tsx ...`
  eighteen times via `child_process.spawn('pnpm', [...], {stdio:
  'inherit'})` (`:220-235`). This means the 18-layout matrix is 18
  **independent OS processes**, not 18 in-process calls — of the four gates,
  only this one is subprocess-based; `gate:capacity`/`gate:mixed61-compact`
  run in-process. A Rust differential-parity harness that wants bit-identical
  reproduction of `gate:compact-nine-baselines` needs an equivalent
  subprocess-per-case invocation (or must prove that in-process invocation
  is behaviorally identical, which is plausible but unverified by this
  document).

## 13. Parallelism assessment

- All four promoted gates are explicitly documented and implemented as
  **strictly sequential, single-process** (`irregular-compact-nine-baselines.ts`'s
  manifest records `maximumConcurrentAlgorithmProcesses: 1`,
  `strictlySequential: true`, `:706,709`; `irregular-capacity-gate.ts`'s
  manifest records the same, `:1256-1257`; `docs/operations/irregular-production-gates.md:48,58,61`
  explicitly states "The run remains strictly sequential and single-process"
  for the Compact/Short-Side matrix). None of the pinned-value gates in this
  cluster exercise concurrent `computeIrregularNesting` invocations; they
  are safe **inputs** to a Rust one-thread differential-parity harness but
  say nothing about multithreaded/Rayon behavior — that is entirely the
  concern of prompt §§13-14 and the concurrency-determinism tests prompt
  §18.4 calls for (which do not yet exist in this codebase; see §15 open
  questions).
- Within `irregular-capacity-gate.ts`, the `production` and `cold-only` arms
  for one fixture run sequentially, not concurrently (`await runArm(...)`
  then conditionally `await runArm(...)` again, `:1054-1078`) — so the
  "paired" comparison is not a race; `cold-only`'s result cannot leak into
  `production`'s state because they are fully separate
  `computeIrregularNesting` calls with fresh Effect layers.
- Independent-and-parallelizable-in-principle work exists (e.g. the 18
  `irregular-compact-baseline.ts` subprocess invocations are mutually
  independent and could run concurrently), but the current implementation
  deliberately does not do so, and prompt §3 forbids changing observable
  behavior (including runtime chronology of gate scripts) without an
  explicit ruling — so a Rust port should **not** parallelize the gate
  harness itself even though the underlying fixture computations have no
  cross-dependency; only the internal Rust algorithm's Rayon parallelism is
  in scope for §§13-14.

## 14. Tests and gates covering this cluster

This section **is** the primary deliverable; see the inventory table below.
"Serial?" answers whether the file/gate's own logic requires sequential
execution (shared mutable harness state, subprocess chronology, or a
single long production run) — not whether vitest happens to isolate test
files into separate workers (it does, by default, and no file in
`tests/unit`/`tests/renderer` opts out of that isolation via
`describe.concurrent`/`test.concurrent`, confirmed by `grep -rln
"\.concurrent("` returning no results for either directory).

### 14.1 Promoted gates (package.json scripts, CI-authoritative)

| Gate | Script(s) | Pinned exact values | Serial? |
| --- | --- | --- | --- |
| `pnpm gate:mixed61-compact` | `irregular-sheet-invariance.ts` | canonical SHA-256 `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`, max area `391606 mm²`, max canonical cavities `0`, max elapsed `330000 ms` (runtime ceiling, not exact) | Yes — one sequential no-options run |
| `pnpm gate:compact-nine-baselines` | `irregular-compact-nine-baselines.ts` → `irregular-compact-baseline.ts` ×18 | 9 Compact + 9 Short-Side rows, each with its own `collisionIdentitySha256`/`fittedCanonicalSha256`/placed/unplaced counts/`maximumCanonicalCavities` (full table at `irregular-compact-nine-baselines.ts:27-183`, reproduced/cross-checked in `docs/operations/irregular-production-gates.md:9-19`); plus per-baseline focused-reconstruction expectations (`status`, `evaluations`, source/candidate/selected hash, `influence`) at `:304-377`; plus 18-layout-matrix invariants (`layoutRecords.length === 18`, `compactLayoutCount === 9`, `shortSideLayoutCount === 9`, `directionalSuccessCount === 9`, `directionalMissCount === 0`, `guardedStage1WinnerCount === 0`, every short-side row's `unplacedPieceIds` sorted-equal to its Compact counterpart) at `:622-638` | Yes — 18 sequential `pnpm exec tsx` subprocesses |
| `pnpm gate:capacity [--paired]` / `pnpm gate:capacity:production` | `irregular-capacity-gate.ts` | 8 fixtures; exact routing/placed-count pins for `capacity-area-proven-rect2`, `capacity-singleton-proven`, `capacity-archive-miss-squares2`, `capacity-triangles20-300x300` (17, hash `2f236b79...`), `capacity-mixed61-700x500` (50, hash `97dbc502...`, warm-prefix depth 15, endpoint hash `0c98259d...`), `capacity-mixed61-700x560` (59, hash `36cee348...`, warm-prefix depth 30, endpoint hash `2d252e35...`); plus per-fixture invariant checks (`partitionExact`, `capacitySettled`, `auxiliaryEvaluationsZero`, `coldSearchReachedEveryDepth`, `schedulerChronology`, `laneCoordinatorChronology`, `oneWarmLaneBeyondPilot`, `prefixNotBelowColdOnly` when paired) | Yes — sequential fixture loop, sequential production/cold-only arms |
| `pnpm profile:mixed61` (not a correctness gate, but re-asserts pins) | `profile-mixed61.mjs` → `irregular-compact-baseline.ts` | Same Mixed-61 `2000x2700` values as the nine-baselines table (collision `3839e80d...`, fitted `ef2b783a...`, placed 61/0, area `391605.850174`, cavities 0, focused evaluation-cap 12000, source/selected hash `3839e80d...`, influence `protected-fallback`) | Yes — one baseline run then one analysis pass |

### 14.2 Vitest unit specs with exact hash/evaluation-count pins (differential-parity-critical)

| File | Pinned value(s) | Subsystem (see sibling doc) |
| --- | --- | --- |
| `tests/unit/irregularTriangleCompactGolden.test.ts` | `collisionIdentitySha256` (via `canonicalCollisionLayoutIdentity` → sha256) `371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127` for Triangle-20 `2000x2700` (`:34-35,205-207`); `0f5befd7d02fc111be47ee447fab7f8778f06ae05d045448f22a916d66949410` for the `300x300` capacity subset (`:37,281,297`), placed `17`, unplaced exactly `[triangle-copy-18,19,20]`, `terminationReason: 'capacity_subset_settled'`, `enclosedCavityCount: 0`; optimizer settings object-matched (`orderWindow:4, beamWidth:8, localCandidateFanout:4, localRepairBudget:0, transformCap:8, baselineOnly:true, gaEnabled:false, placementPolicyId:'edge-contact-then-balanced-compactness'`, `:125-134`); `portfolio.source: 'shared-archive'`; strategy id `'irregular-convex-shared-archive'`; history-frame count `TRIANGLE_COUNT+1` with first frame title `'shared-archive-selected-layout-reveal'` and last `'shared-archive-final-selected'` | `shared-archive.md`, `capacity-search.md` |
| `tests/unit/irregularSeventeenShapesCompactGolden.test.ts` | Collision hash `1ddc8426e032ce01b47ff82cae6104fa99a3f92f44f37782d846e1a8b83c8c5d` (`:30-31,111-114`); `focusedCompleteReconstructionTrace` object-matched exactly: `status:'completed'`, `sourceCanonicalGeometryHash:'c640c06f662050f8a132168f63988c40ba41f2ebc57dc50277a91119b4b4980a'`, `candidateCanonicalGeometryHash`/`selectedCanonicalGeometryHash` both equal to the collision hash, `consumedCandidateEvaluations: 8_035`, `candidateEvaluationAccountingComplete: true`, `outputInfluence:'selected'` (`:118-126`) | `shared-archive.md` (focused reconstruction) |
| `tests/unit/intrinsicSqueezeDisruptSeparate.test.ts` | One test (`:2880-2895`) loads the real Mixed-61 fixture and pins `partition?.structuralPieces` length `53`, `partition?.fillerPieces` length `8` — an exact structural/filler partition count, not a hash. This is the **only** unit test in `tests/unit` that touches the Mixed-61 fixture directly. | (module not covered by this cluster's read list — flag for whichever sibling doc covers `intrinsicSqueezeDisruptSeparate.ts`) |

No other file under `tests/unit/*.test.ts` contains a 40+ hex-character
string (confirmed by `grep -rlE "[0-9a-f]{40,64}" tests/unit/*.test.ts`
returning only the two golden files above). **The Mixed-61 `2000x2700`
canonical hashes (`3839e80d...` collision, `ef2b783a...` fitted) that the
migration prompt's §18.6 summary and `docs/operations/irregular-production-gates.md`
cite are pinned only by gate *scripts* (`irregular-compact-nine-baselines.ts`,
`irregular-sheet-invariance.ts` via `gate:mixed61-compact`,
`profile-mixed61.mjs`) — never by any `tests/unit` vitest spec.** A Rust
differential-parity CI job that runs only `pnpm test` would silently miss
the Mixed-61 hash pins entirely; the gate scripts must be part of the Rust
promotion pipeline, not merely `pnpm test`.

### 14.3 Full `tests/unit/` inventory (subsystem, pinning style, serial)

Every file below was inventoried for its top-level `describe(...)` label and
scanned for exact-value pinning patterns (`toBe`/`toEqual`/`toMatchObject`
against hashes, counts, or status literals). Detailed algorithmic semantics
for each subsystem are covered by the named sibling doc; this table's job is
only to record *that a test exists, what kind of exactness it pins, and
whether it is serial-sensitive* (shared runtime/global-state dependence, not
vitest's per-file worker isolation).

| File (lines) | Top describe() | Pinning style | Notes / serial? |
| --- | --- | --- | --- |
| `algorithm.test.ts` (858) | `sortPiecesForNesting` | exact array ordering (`toEqual` on ID sequences) | No |
| `appApiContract.test.ts` (84) | AppApi contract | IPC surface shape | No |
| `canonicalCollisionPolygonKeyEquivalence.test.ts` (237) | `canonicalCollisionPolygonKey` | exact string-key equivalence | No — see `geometry-caches.md` |
| `canonicalGridContact.test.ts` (89) | canonical grid contact overlap axis units | exact integer arithmetic | No — see `capacity-core.md` |
| `canonicalGridMath.test.ts` (179) | canonical grid exact arithmetic | exact integer/BigInt arithmetic, rounding | No — see `capacity-core.md` |
| `canonicalLayoutGeometry.test.ts` (312) | canonical collision layout geometry | exact topology/cavity counts | No — see `capacity-core.md`/`shared-archive.md` |
| `clipper2OffsetAdapter.test.ts` (213) | Clipper2 offset adapter | exact offset geometry | No — see `collision-prep.md` |
| `collisionGeometryBuilder.test.ts` (238) | `CollisionGeometryBuilder` | exact padded geometry | No — see `collision-prep.md` |
| `convexBounds.test.ts` (47) | convex bounds | exact bounds arithmetic | No |
| `convexPolygonValidation.test.ts` (51) | `ConvexPolygonValidation` | exact predicate results | No — see `validation-spatial.md` |
| `convexPolygonValidationTopology.test.ts` (396) | strict boundary validation topology | exact predicate results | No — see `validation-spatial.md` |
| `convexSatPenetration.test.ts` (38) | `measureConvexSatPenetration` | exact numeric penetration | No |
| `csvImportService.test.ts` (117) | `CsvImportService` | import behavior, not nesting-hash | No |
| `decisionTraceNdjson.test.ts` (136) | `IrregularDecisionTraceBatcher` | exact NDJSON event ordering | No — see `errors-protocol.md`/`worker-coordination.md` |
| `dxfBbox.test.ts` (300) | `entityToGeometry` | exact geometric bounds | No |
| `dxfFixtures.test.ts` (69) | DXF fixtures | fixture-file round-trip | No |
| `dxfSchemaContracts.test.ts` (59) | DXF geometry schema contracts | schema shape | No |
| `dxfSourceFlattening.test.ts` (134) | DXF source flattening fidelity | exact curve-flattening tolerances | No |
| `dxfTopology.test.ts` (219) | DXF outline topology | exact winding/topology | No |
| `exportService.test.ts` (637) | `ExportService` | export byte-shape, includes `timeoutMs` tests | No |
| `freeMaterialService.test.ts` (415) | `FreeMaterialServiceLive` | exact free-material region geometry | No |
| `geometryBackendParity.test.ts` (422) | geometry backend parity | **explicitly a parity test between two internal geometry backends** — directly relevant methodology precedent for the Rust/TS differential harness design | No |
| `geometryPredicates.test.ts` (28) | `GeometryPredicates` | exact robust-predicate signs | No — see `validation-spatial.md` |
| `idDefaults.test.ts` (115) | generated id schemas | ID format, includes timeout-adjacent defaults | No |
| `ifpTransformCore.test.ts` (282) | pure IFP and transformed geometry cores | exact geometry | No — see `nfp-ifp.md` |
| `intrinsicAnytimeArchive.test.ts` (50) | intrinsic anytime archive | exact archive ordering | No — see `shared-archive.md` |
| `intrinsicCapacityIntegration.test.ts` (678) | intrinsic capacity integration | exact counts incl. `consumedCandidateEvaluations: 0` cases (`:195,304,401`) | No — see `capacity-search.md`. Referenced by the Focused Correctness Gate (`docs/operations/irregular-production-gates.md:38`). |
| `intrinsicCapacityMode.test.ts` (1368) | intrinsic capacity quality admission | exact routing/status/hash | No — see `capacity-core.md`/`capacity-search.md`. Focused-gate member. |
| `intrinsicComponentInterfaceClosure.test.ts` (80) | intrinsic component interface closure | exact endpoint counts | No |
| `intrinsicExactProjection.test.ts` (788) | intrinsic exact projection | exact deadline/projection semantics | No |
| `intrinsicGapRegions.test.ts` (218) | intrinsic gap regions | exact region enumeration | No — see `strict-decoder-gap-family.md` |
| `intrinsicGlobalSqueezePortfolio.test.ts` (974) | intrinsic global squeeze portfolio | exact deadline/status handling | No |
| `intrinsicPeriodicCells.test.ts` (484) | intrinsic periodic cells | exact cell enumeration, imports the same `MAXIMUM_*` constants as `scripts/irregular-intrinsic-periodic-family-portfolio.ts` | No — see `periodic.md` |
| `intrinsicPeriodicFamilyPortfolio.test.ts` (508) | intrinsic periodic family portfolio | exact deadline/status handling | No — see `periodic.md` |
| `intrinsicReconstructionPortfolio.test.ts` (366) | intrinsic reconstruction portfolio | exact reconstruction ordering | No — see `shared-archive.md`. Focused-gate member. |
| `intrinsicSharedArchiveAdmission.test.ts` (52) | intrinsic shared archive admission | exact admission rules | No — see `shared-archive.md`. Focused-gate member. |
| `intrinsicSharedArchivePortfolio.test.ts` (393) | `retainRankedSharedArchive` | exact evaluation counts (`requestedCandidateEvaluations`/`consumedCandidateEvaluations` small integers, `:180,282-329`) and archive ordering | No — see `shared-archive.md` |
| `intrinsicShortSideContactStrip.test.ts` (348) | intrinsic short-side contact strip | exact tie-evidence/contact geometry | No — see `short-side.md` |
| `intrinsicShortSideObserver.test.ts` (444) | intrinsic short-side observer | exact ranking/trace-budget | No — see `short-side.md` |
| `intrinsicShortSidePairFoldObserver.test.ts` (762) | intrinsic short-side pair-fold observer | exact contract fields | No — see `short-side.md` |
| `intrinsicSqueezeDisruptSeparate.test.ts` (3406, largest file) | intrinsic global squeeze/disrupt/separate controller | exact deterministic proposal generation (`sampleOrdinal`-keyed reproducibility asserted at `:2921-2924`); **the one Mixed-61-fixture unit test** (§14.2) | No |
| `intrinsicStrictDecoder.test.ts` (1560) | `decodeIntrinsicStrictPriorityOrder` | exact comparator-chain tie-breaking | No — see `strict-decoder-gap-family.md` |
| `intrinsicStrictFamilyPortfolio.test.ts` (361) | intrinsic strict family portfolio | exact chromosome/order determinism | No — see `strict-decoder-gap-family.md` |
| `intrinsicV7SeedArchive.test.ts` (118) | intrinsic V7 seed archive | small, exercises a module the gate scripts treat as diagnostic-only (§1a) | No |
| `ipcChannels.test.ts` (17) | IPC channel allowlist | list membership | No |
| `irregularBeamDecoder.test.ts` (386) | `decodeStrictPriorityOrder` | exact decode determinism | No |
| `irregularBenchmark.test.ts` (967) | irregular benchmark and debug corpus | exercises `scripts/irregular-benchmark.ts`'s exported functions (`resolveBenchmarkOptions`, `summarizeBenchmarkScore`, etc.) directly as a library — this is the one file that unit-tests gate-adjacent *script* code, not just production `src/` code | No |
| `irregularGeometryCache.test.ts` (546) | irregular geometry caches | exact cache key/value semantics | No — see `geometry-caches.md` |
| `irregularGeometryKernel.test.ts` (474) | `GeometryKernel` | exact kernel outputs | No |
| `irregularInfrastructure.test.ts` (16) | `IrregularNestingInfrastructureLive` | layer wiring | No |
| `irregularLayoutCanonicalization.test.ts` (50) | irregular layout canonicalization | exact canonical-hash function behavior — tests `scripts/lib/irregularLayoutCanonicalization.ts`, the exact module every gate script above uses to compute `fittedCanonicalSha256` | No — highly relevant to Rust canonical-hash parity |
| `irregularLayoutScorer.test.ts` (1156) | `IrregularLayoutScorer` | exact score-tuple computation | No — see `search-scoring.md` |
| `irregularPlacementScorer.test.ts` (469) | `IrregularPlacementScorer` | exact placement score tuples | No — see `search-scoring.md` |
| `irregularPortfolio.test.ts` (627) | irregular GA portfolio | exact GA determinism (seeded) | No |
| `irregularSchemaContracts.test.ts` (726) | irregular worker defaults | default-settings schema shape | No |
| `irregularTriangleCompactGolden.test.ts` (301) | see §14.2 | exact hash | **Yes** — a full production `computeIrregularNesting` run per `it()`, 30s/30s timeouts |
| `irregularSeventeenShapesCompactGolden.test.ts` (130) | see §14.2 | exact hash + evaluation count | **Yes** — one full production run, 120s timeout |
| `irregularWindowedBeam.test.ts` (2621) | `decodeWindowedIrregularBeam` | exact beam-decode determinism | No |
| `irregularWorkerCompute.test.ts` (307) | `computeIrregularNesting` | worker-level cancellation/timeout classification tests (see `worker-coordination.md`) | No |
| `nfpBoundaryCore.test.ts` (220) | pure NFP boundary core | exact boundary geometry | No — see `nfp-ifp.md` |
| `nfpBoundaryTrustedRings.test.ts` (225) | trusted ring shortcuts on the pairwise NFP path | exact trusted-ring reuse | No — see `nfp-ifp.md` |
| `nfpIfpService.test.ts` (2311, 2nd largest) | `NfpIfpServiceLive` | exact NFP/IFP cache access sequence | No — see `nfp-ifp.md` |
| `nfpIfpTelemetry.test.ts` (120) | NFP/IFP telemetry | telemetry counters (non-semantic) | No |
| `overlapRelaxation.test.ts` (158) | `relaxOverlappingLayout` | exact relaxation acceptance | No |
| `overlapRelaxationTracker.test.ts` (17) | `OverlapRelaxationTracker` | small state tracker | No |
| `placedCollisionSpatialIndex.test.ts` (169) | `PlacedCollisionSpatialIndex` | exact spatial-query results | No — see `collision-prep.md` |
| `placementValidation.test.ts` (304) | `PlacementValidation` | exact legality predicate | No — see `validation-spatial.md` |
| `preparePieces.test.ts` (127) | `preparePieces` | exact prepared-order determinism | No |
| `presetShapes.test.ts` (96) | `makePresetShapeDocument` | exact preset geometry | No |
| `projectFileService.test.ts` (199) | `ProjectFileService` | file round-trip | No |
| `pureIfpTransformContract.test.ts` (410) | pure IFP and transformed-cache preservation oracle | exact cache-preservation invariants | No — see `nfp-ifp.md`/`geometry-caches.md` |
| `pureIrregularCoreBoundary.test.ts` (127) | pure irregular core boundary | architectural purity assertions | No |
| `result.test.ts` (44) | result utils | small utility | No |
| `ringFingerprintAccessPath.test.ts` (156) | validation guard ring-reading contract | exact ring-fingerprint access order | No — see `nfp-ifp.md`/`validation-spatial.md` |
| `runHistoryArchiveService.test.ts` (53) | `RunHistoryArchiveService` | archive round-trip | No |
| `runHistoryGif.test.ts` (15) | run history GIF encoder | small | No |
| `schemas.test.ts` (430) | `ProjectDocumentStrict` | schema validation, includes timeout/cancel fields | No |
| `sourcePiecesForPreparedPieces.test.ts` (58) | `sourcePiecesForPreparedPieces` | exact ID resolution | No |
| `targetedExactLns.test.ts` (189) | targeted exact LNS policy | exact admissibility rules | No |
| `transformGenerator.test.ts` (457) | `TransformGenerator.Live` | exact transform enumeration order | No |
| `trustedGeometryCarrierBoundary.test.ts` (336) | trusted geometry carrier boundary | uses the fixture files under `tests/fixtures/trusted-geometry-carrier-boundary/` (architectural lint-style test, not algorithm) | No |
| `workerProtocol.test.ts` (251) | `WorkerRequest` | protocol shape, includes cancel/timeout messages | No — see `worker-coordination.md`/`errors-protocol.md` |
| `workspaceProjectService.test.ts` (307) | `WorkspaceProjectService` | file/workspace round-trip | No |

### 14.4 `tests/renderer/` (brief — UI-facing, not algorithm-hash relevant)

`vitest.config.ts:6` includes `tests/renderer/**/*.test.ts` in the same
vitest run as `tests/unit`. None of the seven files pin any SHA-256 or
nesting-algorithm exact value (confirmed: no hash-like string literal in any
file). They test Vue composables/components: `irregularSettingsUi.test.ts`
(101 lines, settings-form UI), `resultCanvas.test.ts` (177, canvas render
transforms), `runHistoryGif.test.ts` (103, GIF-sequence selection UI logic —
distinct from `tests/unit/runHistoryGif.test.ts`'s encoder test),
`savedRunConfiguration.test.ts` (107), `useCsvImportStore.test.ts` (376,
largest), `useHistoryStore.test.ts` (138), `useSettings.test.ts` (115,
"settings timeout hydration" — UI-side timeout display, not algorithm
deadline semantics). None are relevant to Rust backend parity beyond
confirming the Rust port must not change any renderer-visible IPC/result
shape these tests depend on.

### 14.5 `tests/fixtures/` inventory

| Path | Role |
| --- | --- |
| `tests/fixtures/dxf/*.dxf` (19 files) + `generate-test-dxfs.mjs` (310 lines) | Hand/script-generated DXF fixtures for import/geometry unit tests (`angled-profile`, `benchmark-skewed-quad`, `circle-ellipse-arcs`, `concave-and-stars`, `convex-polygons`, `duplicate-points`, `high-padding`, `mixed-sheet-like-screenshot`, `near-collinear`, `open-contour`, `repeated-mixed-pieces`, `rounded-rectangle`, `star-5-point`, `thin-and-awkward`, `tiny-segments`, `transform-cases`, `trapezoid`, `triangle`, `unsupported-entities`). `generate-test-dxfs.mjs` is a **fixture generator**, not a test or gate; it is not invoked by `package.json` or by any script read for this cluster — regenerating fixtures is a manual/occasional operation. |
| `tests/fixtures/irregularBenchmarkFixtures.ts` (399 lines) | Exports `IRREGULAR_DXF_FIXTURES`, `IRREGULAR_BENCHMARK_CORPUS`, `IRREGULAR_BENCHMARK_PROFILES`, `calculateAreaFeasibilityBounds`, `repeatImportedPieces` — consumed by `scripts/irregular-benchmark.ts` and `tests/unit/irregularBenchmark.test.ts`. Not a gate; defines named repeatable perf profiles. |
| `tests/fixtures/irregularSeventeenShapes/3268390_1..17.dxf` + one CSV | The Shapes-17 golden corpus (§5, §6 — natural-sort-ordered). Referenced by `irregularSeventeenShapesCompactGolden.test.ts`, `irregular-compact-baseline.ts`, `irregular-intrinsic-shared-archive.ts`, `irregular-short-side-shelf-probe.ts`. |
| `tests/fixtures/irregularSheetInvariance/mixed61-request.json` (4,658 lines) + `README.md` | The Mixed-61 golden persisted request (§3). Referenced by nearly every `irregular-*` gate/probe script and by exactly one `tests/unit` spec (`intrinsicSqueezeDisruptSeparate.test.ts`). |
| `tests/fixtures/trusted-geometry-carrier-boundary/{namespace-import,runtime-class,schema-alias,transitive-alias}.ts` | Synthetic TS source fixtures consumed by `tests/unit/trustedGeometryCarrierBoundary.test.ts`'s architectural-boundary lint test (not nesting-algorithm fixtures). |

## 15. Open questions and ambiguities

1. **The migration prompt's §18.6 Mixed-61 summary is source-verified, but
   only against gate *scripts*, not vitest.** I independently confirmed
   every value in prompt §18.6 (`3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742`
   collision, `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`
   fitted, `61/0` placed/unplaced, area `391605.850174 mm²`, `0` canonical
   cavities, `evaluation-cap` at `12000`, source/selected hash equal to the
   collision hash, `protected-fallback` influence) directly against
   `docs/artifacts/current-compact-baselines/mixed-61-2000x2700.json`
   (a checked-in accepted-run artifact) and against
   `irregular-compact-nine-baselines.ts`'s `BASELINES` literal. **No
   contradiction found** — this is a confirmation, not a correction. But
   because none of these values are pinned in `tests/unit`, a Rust CI
   pipeline that gates only on `pnpm test` would never catch a Mixed-61
   regression; the four promoted gate scripts must be explicit, separate CI
   steps for the Rust port, exactly as they are today for TypeScript
   (already true per `docs/operations/irregular-production-gates.md`, but
   worth stating explicitly as a Rust-CI requirement, not just a TS-CI habit).
2. **Compact Short Side is not cavity-free for Mixed-61.** I discovered
   `shortSideMaximumCanonicalCavities: 1` for the Mixed-61 `2000x2700` and
   `600x400` rows (`irregular-compact-nine-baselines.ts:54,123`), and
   independently confirmed `canonicalTopology.enclosedCavityCount: 1` in
   `docs/artifacts/compact-short-side-directional-contract/mixed-61-2000x2700.short-side-profile.json`.
   The migration prompt does not mention this anywhere, and
   `docs/operations/irregular-production-gates.md`'s summary table only
   lists Compact (not Short Side) cavity counts. This is a real, source-true
   asymmetry: **Compact achieves zero canonical cavities for Mixed-61 at
   every gated sheet, but Compact Short Side does not (exactly one cavity
   at `2000x2700`, exactly two at `600x400` for Shapes-17,
   `shortSideMaximumCanonicalCavities: 2` at `irregular-compact-nine-baselines.ts:123`)**.
   A Rust implementer must not assume Short Side inherits Compact's
   zero-cavity property, and a naive "if cavities > 0, something is wrong"
   sanity check would be a false-positive trap for the Rust Short Side path.
3. **Whether `irregular-compact-baseline.ts`'s subprocess-per-case
   architecture is behaviorally load-bearing or just an implementation
   convenience is unverified.** §12 flags that `gate:compact-nine-baselines`
   is the only promoted gate using OS subprocesses instead of in-process
   calls; I did not find evidence either way for whether running the same 18
   `computeIrregularNesting` calls in-process (as `gate:capacity` does)
   would change any pinned value. Given prompt §3's "existing tests are
   immutable" rule, the safe assumption is to preserve subprocess isolation
   for this specific gate unless/until proven unnecessary — but this is an
   assumption, not a proven fact, and is worth a targeted differential check
   before the Rust port's equivalent harness is built.
4. **No `tests/unit` spec exercises Compact Short Side's exact hash pins.**
   All Short Side hash pinning (`shortSideCollisionIdentitySha256`,
   `shortSideFittedCanonicalSha256` for all 9 baseline cells) lives only in
   `irregular-compact-nine-baselines.ts`'s `BASELINES` array. `short-side.md`
   (sibling doc) should be consulted for whether any `tests/unit/intrinsicShortSide*.test.ts`
   file pins a full-pipeline hash rather than component-level behavior — a
   read of those files' `describe`/`it` bodies beyond top-level labels was
   out of scope for this cluster's inventory pass and is worth a follow-up
   cross-check against `short-side.md`'s own file-level findings.
5. **No concurrency-determinism tests exist yet.** Prompt §18.4 requires
   "run Rust with one thread / two threads / default / higher count... verify
   canonical hashes exactly" — no such infrastructure exists anywhere in
   this cluster today (confirmed: no `describe.concurrent`/thread-count
   parameterization in any gate script or vitest spec). This is expected —
   it is Rust-port-stage work, not missing TS coverage — but it means there
   is no existing TS-side harness pattern to imitate for thread-count
   parameterization; the Rust port's Stage 2/3 work will need to invent this
   pattern from scratch, informed by the sequential-execution assumptions
   documented in §13 above.
