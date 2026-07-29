# TypeScript → Rust Semantic Mapping (Compact / Compact Short Side)

Status: **Stage 0 design document.** No production Rust code exists yet. This
is the file-by-file mapping a Stage 1+ implementer follows; it is not a status
report. Governing spec: `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
("the migration prompt"), especially §2 (semantic preservation), §8 (numeric
semantics), §9 (keys/ordering/serialization), §13 (cache architecture), §14
(parallelization boundaries). Every row below is sourced from one or more of
the characterization documents in `docs/planning/rust-irregular-backend/characterization/`,
`docs/planning/rust-irregular-backend/js-semantics-audit.md`, and direct
citation of the TypeScript source. Nothing here proposes a behavior change;
"key semantic invariants" columns describe what the TypeScript **does**,
including anything that looks unusual — per migration prompt §2, that is the
specification.

All file paths are repo-relative. All TS paths are relative to
`src/workers/algorithm/irregular/` unless a different directory is spelled
out explicitly.

## 0. How to read this document

- **One row per TS module** on the production Compact/Compact Short Side path
  (migration prompt §4.1), plus rows for out-of-scope/dead modules with their
  liveness evidence (§ "Out of scope" below), plus rows for boundary files
  that stay in TypeScript by design.
- **"Planned Rust module"** uses the crate/module layout in §1. This is a
  design proposal for Stage 1, not a name already in the tree — no Rust crate
  exists yet.
- **"Port risk"** is CRITICAL / HIGH / MEDIUM / LOW, based on: (a) whether the
  file hand-rolls a canonical-JSON/hash encoder or checkpoint schema, (b) how
  many of the JS-semantics hazard classes in `js-semantics-audit.md` §12 it
  exercises, (c) whether it is on the Mixed-61 hot path (`baseline-evidence.md`
  CPU breakdown), (d) LOC/branch complexity. It is a porting-effort/danger
  signal, not a production-severity rating.
- **"Parity tests"** lists existing `tests/unit/*.test.ts` files (immutable
  per migration prompt §3 — run unchanged against Rust) and the production
  gates (`pnpm gate:*`) that transitively cover the row. Where no dedicated
  unit test exists, that gap is called out explicitly (it is itself a
  characterization fact, not a Rust-port omission license). New differential
  tests required by migration prompt §18.3/§18.5 are referenced by category
  (see §2.4) rather than re-listed per row.

## 1. Rust crate and module layout (Stage 1 proposal)

Per the orchestrator decisions: the crate lives in the pnpm workspace at
`crates/irregular-nesting-native` (napi-rs cdylib, napi 3.12.0 / napi-derive
3.6.1 / napi-build 2.4.0, JS-visible names camelCased), and the Clipper2
strategy is a vendor-translation of the used subset of `clipper2-ts@2.0.1-18`
into a second crate, `crates/clipper2-rs`, pinned by differential vectors
against the TS package — not a binding to a different-version C++ Clipper2.

```
crates/
  clipper2-rs/                     # vendor-translated clipper2-ts@2.0.1-18 subset
    src/core.rs                    # Point64/PointD/Path64/Rect64 + PolyTree64 (Core.ts)
    src/engine.rs                  # boolean-op engine internals (Engine.ts)
    src/clipper.rs                 # booleanOp/union/difference/intersection/xor,
                                    #   EvenOdd+NonZero fill, PolyTree64 output (Clipper.ts)
    src/offset.rs                  # Miter/Polygon offset (Offset.ts)
    tests/                         # differential vectors vs. clipper2-ts@2.0.1-18
  irregular-nesting-native/
    src/napi_api.rs                # #[napi] exported entry point(s); one call
                                    #   per nesting job, coarse-grained boundary
    src/core/
      protocol/                    # request/response DTOs, AppErrorCode-mirroring
                                    #   error enum (protocol/errors.ts, protocol/worker.ts)
      domain/                      # trusted carrier structs + PieceId/SourceFileId/
                                    #   JobId newtypes (shared/irregular/domain.ts,
                                    #   shared/domain/ids.ts, shared/domain/nesting.ts)
      coordinator/                 # computeIrregularNesting.ts, irregularWorkerOutput.ts
      complete_archive/
        shared_archive_portfolio.rs
        anytime_archive.rs
      strict_decoder/
        strict_decoder.rs
        gap_regions.rs
        strict_family_portfolio.rs
      periodic/
        cells.rs
        family_portfolio.rs
      reconstruction/
        portfolio.rs
        place_defer_shadow.rs
      capacity/
        preflight.rs
        material.rs
        endpoint.rs
        prefixes.rs
        search.rs                  # runIntrinsicCapacityColdSearch + checkpoint codec
        mode.rs                    # runIntrinsicCapacityMode routing
        telemetry.rs                # non-authoritative shadow probe
      short_side/
        axes.rs
        observer.rs
        pair_fold_observer.rs
        contact_strip.rs
      search_scoring/
        beam_state.rs              # canonical occupied-geometry key machinery (hot path)
        placement_scorer.rs        # scoreCandidate value computation (comparators unused
                                    #   in production — see row notes)
        layout_scorer.rs           # scoreState value computation
        score_grid.rs
        sort_pieces.rs
      geometry/
        canonical_grid/
          math.rs                  # canonicalGridMath.ts
          contact.rs                # canonicalGridContact.ts
        layout_geometry.rs          # canonicalLayoutGeometry.ts
        convex_contact.rs           # convexPolygonContact.ts
        free_material.rs
        flatten/
          arc.rs
          ellipse.rs
        offset/
          clipper2_adapter.rs       # calls into clipper2-rs
          offset_policy.rs
          convex_offset.rs
        validate/
          convex_polygon_validation.rs
          convex_bounds.rs
          convex_hull.rs
          predicates.rs             # wraps a robust-predicates-equivalent orient2d
          placement_validation.rs
          spatial_index.rs          # placedCollisionSpatialIndex.ts
        collision_prep/
          builder.rs                # collisionGeometryBuilder.ts
          transform_generator.rs
        nfp_ifp/
          service.rs                 # nfpIfpService.ts
          boundary_core.rs           # nfpBoundaryCore.ts
          ifp_bounds_core.rs
          transform_collision_geometry_core.rs
          transform_collision_geometry.rs
          telemetry.rs               # nfpIfpTelemetry.ts (diagnostic, non-authoritative)
        cache/
          nfp_cache_key.rs
          cache_identity.rs          # geometryCacheIdentity.ts
          cache_store.rs             # geometryCacheStore.ts + geometryCacheStoreLive.ts
          cache_keys.rs              # geometryCacheKeys.ts
        internal.rs                 # internalGeometry.ts vocabulary (plain structs)
      trace/
        decision_trace.rs
        decision_trace_ndjson.rs
    tests/                          # Rust unit + differential + property/fuzz tests
                                     # (call `core::*` directly; no napi needed)
```

`irregular-nesting-native` is split into `napi_api` (thin, napi-only) and
`core` (pure Rust, no napi dependency) specifically so the bulk of the port's
tests (§18.2/§18.5 of the migration prompt) run without an N-API host and so
`core` can be property/fuzz-tested with ordinary Rust tooling (`cargo test`,
`proptest`/`cargo fuzz`).

## 2. Cross-cutting invariants (apply to every row unless the row overrides them)

These are not repeated per row; they are referenced by short tag.

- **[STABLE-SORT]** Every `.sort()`/`.toSorted()` in the TS source is
  spec-guaranteed stable (ES2019+). The matching Rust primitive is always
  `slice::sort_by`/`sort_by_key` (stable) — never `sort_unstable_by`. Per
  `js-semantics-audit.md` §5.1, apply this by default even where today's
  comparator has no reachable tie, since a future TS comparator edit could
  introduce one silently.
- **[CODE-UNIT vs LOCALE]** Two non-interchangeable string-ordering regimes
  coexist: (a) plain `<`/`>`/bare `.toSorted()` = UTF-16 code-unit order
  (Rust: `str`/`String::cmp`, provably equivalent only for BMP content — no
  surrogate pairs); (b) `.localeCompare()` (135 call sites, 26 files,
  `js-semantics-audit.md` §5.2 item 2) = ICU default-locale collation
  (confirmed `en-US`/full-ICU on the reference dev machine; **not** yet
  verified against Electron's bundled V8/ICU — open question). A Rust port
  needs both a code-unit comparator and a verified ICU-equivalent collator
  (e.g. `icu_collator`) and must route each call site to the one the source
  uses, never substitute one for the other (migration prompt §9).
- **[NUMBER-TOSTRING]** Any `String(number)`/template-literal number
  interpolation/`JSON.stringify(number)` that reaches a cache key, canonical
  key, or hash input must reproduce ECMA-262 `Number::toString` (shortest
  round-trip decimal, exponential notation at `>=1e21`/`<1e-6`) byte-for-byte,
  including `-0` → `"0"`. Not `f64::to_string()`/`{}` `Display` (never uses
  exponential notation) and not the generic `ryu` crate (reproduces
  Rust/Java float formatting, not JS's). Verify any candidate crate
  differentially against V8 output before trusting it (`js-semantics-audit.md`
  §7.1, §12 item 2 — ranked the single highest-severity numeric hazard).
- **[NEG-ZERO]** 18 independently hand-written `Object.is(value, -0) ? 0 : value`
  (or `'0'`) sites. Rust: `f64::is_sign_negative() && x == 0.0`, never
  `x == -0.0` (always true for any zero in both languages). May be
  consolidated into one shared Rust helper without changing behavior (all 18
  are internally consistent — `js-semantics-audit.md` §7.5).
- **[MATH-ROUND]** `Math.round` is round-half-toward-+∞ (`Math.round(-0.5) ===
  -0`), **not** Rust `f64::round()` (round-half-away-from-zero). Some files
  hand-roll the opposite convention (`Math.sign(x) * Math.floor(abs(x)+0.5)`,
  which *does* match Rust `.round()`, e.g. `irregularScoreGrid.ts`). Never
  mechanically replace `Math.round(...)` with `.round()`; check each site's
  actual convention (`js-semantics-audit.md` §7.3 items 1-2, ranked MAJOR).
- **[MINMAX-NAN]** `Math.max`/`Math.min` propagate `NaN`; Rust `f64::max`/`min`
  methods ignore `NaN` and return the other operand — the opposite policy.
  Do not translate `Math.max(a,b)` to `a.max(b)` without first proving neither
  operand can be `NaN` at that call site, or use an explicit NaN-propagating
  wrapper everywhere (`js-semantics-audit.md` §7.3 item 3, §15 open question 4
  — reachability not exhaustively audited).
- **[HASHMAP-ORDER]** JS `Map`/`Set` preserve insertion order and "update
  value, keep position" on re-`set` of an existing key. Rust `HashMap`/
  `HashSet` guarantee neither. Never use raw Rust `HashMap`/`HashSet`
  iteration as an ordering source (migration prompt §9); use `IndexMap`/
  `IndexSet` (matching "re-insert keeps position" semantics) or an explicit
  `Vec` + lookup index wherever TS relies on Map/Set iteration order, even as
  a tie-break staged before an explicit sort.
- **[BIGINT-EXACT]** Exact integer authority (cross-products, doubled areas,
  ratio comparisons, canonical-grid contact terms, capacity material
  accounting, Short Side projected overlap) uses JS `BigInt` in TS. Choose
  `i128` (checked) vs. arbitrary precision per call site based on the proved
  coordinate/product bound (migration prompt §8.2); `compareCanonicalGridRatios`'s
  cross-multiplication of squared magnitudes is the most exposed (within ~2
  orders of magnitude of `i128::MAX` at the practical `maxScaledCoordinate`
  bound per `canonical-grid.md` §15 item 7) — an explicit Stage 2 decision is
  required, not an implicit per-file choice.
- **[FOUR-ENCODERS]** There is **no single "canonical checkpoint JSON"
  encoder**, contrary to a naive reading of migration prompt §9. Four
  independent, mutually-inconsistent encoders exist:
  `intrinsicStrictCanonicalJson` (`intrinsicStrictDecoder.ts:1257-1276`,
  locale-sorted, `Map`-aware, BigInt-as-string), `canonicalJson` in
  `intrinsicCapacitySearch.ts:1626-1635` (code-unit-sorted, `Map` silently
  discarded as `{}`, BigInt-as-string), `canonicalJson` in
  `intrinsicPeriodicFamilyPortfolio.ts:1285-1291` (locale-sorted, `Map`
  silently discarded, **BigInt throws `TypeError`**), and
  `canonicalRecord`/`canonicalToken`/`canonicalNumber` in
  `irregularBeamState.ts:829-850` (non-JSON netstring format, feeds a beam
  dedup key, not a hash). **Port as four separate, independently-tested Rust
  functions; never unify.** (`js-semantics-audit.md` §8.1, §12 item 1 —
  CRITICAL, and `checkpoint-encoding.md` throughout.)
- **[REASSOC]** Do not reassociate any `f64` summation that feeds a compared,
  ranked, or serialized-as-exact value (e.g. boundary-length accumulation).
  Individual terms may be computed in parallel; the fold must stay serial, in
  the original left-to-right order (migration prompt §8.1, §14.3).
- **[UNDEFINED-OMIT]** `undefined`-valued object fields, and true
  own-property omission (`hasOwnProperty`-gated constructor fields), must
  serialize as an absent key, never `null`. Rust: `Option<T>` +
  `#[serde(skip_serializing_if = "Option::is_none")]`, or the specific custom
  encoder's own filter, matching whichever of the four encoders above applies.

### 2.4 Parity-test categories referenced per row (see migration prompt §18)

- **[U]** existing `tests/unit/*.test.ts` (immutable, run unchanged).
- **[G]** production gate (`pnpm gate:mixed61-compact`, `gate:compact-nine-baselines`,
  `gate:capacity`, `gate:capacity:production`).
- **[D]** new Stage-2+ TS-vs-1-thread-Rust differential test (§18.3) —
  required for every row; not re-stated per row unless the row needs a
  non-default projection (e.g. excluding non-semantic timing fields).
- **[P]** new property/fuzz test (§18.5).
- **[C]** new concurrency-determinism test (§18.4) — only listed where the
  row is itself parallelization-relevant (cache, capacity search, canonical
  key construction).

---

## 3. Coordination and execution

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `src/workers/nesting.worker.ts` | `napi_api` (boundary only; RPC/queue/fiber plumbing stays TS — see §12 "stays TS" table) | Only the **coarse boundary crossing** (trusted request in, complete result + diagnostics out) is ported; the worker-thread RPC shell, layer wiring (`Effect.provide` chain), and NDJSON frame writer stay TS and call the new Rust entry point. Backend selection/fallback must classify a Rust-requested run that silently fell back to TS as a failed sample (perf contract §6). | `tests/unit/irregularWorkerCompute.test.ts` [U]; `tests/unit/workerProtocol.test.ts` [U] | MEDIUM — boundary-design risk (getting the trust/ownership split wrong), not algorithmic-hazard risk. |
| `computeIrregularNesting.ts` | `core::coordinator` | Owns: `isIntrinsicSharedArchiveEligible` routing (archive vs. legacy branch — legacy is dead for shipped presets, see §12), preflight-first-then-archive-then-capacity-fallback sequencing (migration prompt §10/§11), the four mutually-exclusive `materialize*` result-construction functions (each calls `FreeMaterialService`/`IrregularLayoutScorer.scoreState` at most once, twice total for Short Side jobs — `canonical-grid.md` §1), Short Side's `directionalTargetIds` derivation from `selected.placedCollisionGeometries`. 1,921 lines; the single largest coordination surface. | `tests/unit/irregularSeventeenShapesCompactGolden.test.ts`, `irregularTriangleCompactGolden.test.ts`, `intrinsicCapacityIntegration.test.ts`, `intrinsicSharedArchivePortfolio.test.ts` [U]; `pnpm gate:mixed61-compact`, `gate:compact-nine-baselines`, `gate:capacity[:production]` [G] | CRITICAL — the single coordination file every profile/branch/routing decision flows through; a sequencing bug here silently changes which producer's endpoint becomes `selected`. |
| `irregularWorkerOutput.ts` | `core::coordinator` (result-shaping submodule) | Final `IrregularNestingResult`/`IrregularComputeResult` shape construction from the coordinator's internal `selected` state; field presence/omission conventions per **[UNDEFINED-OMIT]**. | `tests/unit/irregularWorkerCompute.test.ts` [U] | MEDIUM |
| `src/workers/algorithm/computeNesting.ts` | *(stays TS — dispatch boundary)* | Dispatches between the excluded rectangular algorithm (stays TS, migration prompt §4.2) and the irregular path. Not itself part of the Rust scope; must be updated only to call the new native boundary for irregular requests. | `tests/unit/irregularWorkerCompute.test.ts` [U] | LOW (integration-only; no algorithmic content to port). |

## 4. Complete Compact construction

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `intrinsicSharedArchivePortfolio.ts` | `core::complete_archive::shared_archive_portfolio` | Owns the production `while(true)` resume loop for `IntrinsicStrictDirectCheckpoint`; admits complete endpoints via `assertCanonicalGridLegalLayout`+`canonicalCollisionLayoutIdentity` (migration prompt §10 rule 4: "complete, exact, legal, uncensored"); `retainRankedSharedArchive`/`selectIntrinsicSharedArchiveWinner` dedup+rank order. `.localeCompare()` at 2 sites vs. `canonicalLayoutGeometry.ts`'s default `.toSorted()`/`<` for the identity builder it depends on — verified-not-assumed-equivalent today (**[CODE-UNIT vs LOCALE]**). | `tests/unit/intrinsicSharedArchivePortfolio.test.ts`, `intrinsicSharedArchiveAdmission.test.ts` [U]; `gate:mixed61-compact`, `gate:compact-nine-baselines` [G] | CRITICAL — governs which complete endpoint becomes the protected leader; checkpoint chronology and dedup order are both parity-gated. |
| `intrinsicStrictDecoder.ts` | `core::strict_decoder::strict_decoder` | 2,363 lines; the strict sheetless constructor used by every direct-role producer. Owns `intrinsicStrictCanonicalJson` (**[FOUR-ENCODERS]**, one of the four), `IntrinsicStrictDirectCheckpoint` (version `'intrinsic-strict-direct-checkpoint-v1'`) construct/validate/resume, `analyzeCanonicalLayoutStructure`/`assertCanonicalGridLegalLayout`/`measureCanonicalLayoutTopologyExact` calls (imports fully live per `canonical-grid.md`), internal deadline checkpoint. 9 `.localeCompare()` sites (largest single hazard concentration per `strict-decoder-gap-family.md` §12 item 1 — verified empirically to diverge from code-unit order on punctuation, e.g. `'12,3'` vs `'12-3'` vs `'12;3'`). | `tests/unit/intrinsicStrictDecoder.test.ts` [U]; `gate:mixed61-compact`, `gate:compact-nine-baselines` [G] | CRITICAL — largest, most complex file in the cluster; checkpoint integrity hash + `.localeCompare` concentration + BigInt-as-string encoding all compound. |
| `intrinsicGapRegions.ts` | `core::strict_decoder::gap_regions` | Gap-region derivation for the strict decoder's "open-pocket-first" role; sole production caller of `canonicalGridClockwise` (`canonicalGridMath.ts`). 2 `.localeCompare()` sites. | `tests/unit/intrinsicGapRegions.test.ts` [U] | HIGH |
| `intrinsicStrictFamilyPortfolio.ts` | `core::strict_decoder::strict_family_portfolio` | Repeated-family grouping feeding the strict decoder; 1 `.localeCompare()` site; independent `compareBigIntAscending` (near-identical body to 3+ other files' BigInt comparators — safe-to-unify per **[BIGINT-EXACT]**/`js-semantics-audit.md` §6 item 2). | `tests/unit/intrinsicStrictFamilyPortfolio.test.ts` [U] | MEDIUM |
| `intrinsicPeriodicCells.ts` | `core::periodic::cells` | 2,365 lines. P1/P2 cell enumeration, crop and Pareto selection, source-survival audit. Bare `.toSorted()` on `[string,number]` `Map`-entry tuples at 3 sites (`:531,689,1144`) — **not** simply "sort by key" (tuple-to-string-then-compare via `Array.prototype.toString`'s comma-join, `js-semantics-audit.md` §5.2 item 3 / §12 item 7 — a `BTreeMap` natural-order port would be subtly wrong). 8 `.localeCompare()` sites, several on strings that can embed user-controlled `piece.source.id` (`periodic.md` §12 item 1 — directly affects survivor order, a migration-prompt-protected field). `Array.prototype.includes` on object references = reference-identity dedup, not structural (`periodic.md` §12 item 5). Pervasive load-bearing `Map`/`Set` insertion order (**[HASHMAP-ORDER]**). | `tests/unit/intrinsicPeriodicCells.test.ts` [U]; indirectly `gate:mixed61-compact` [G] | CRITICAL — largest file with the highest hazard density (tuple-stringify sort + locale/user-string interaction + pervasive Map-order reliance) in the whole cluster. |
| `intrinsicPeriodicFamilyPortfolio.ts` | `core::periodic::family_portfolio` | 1,482 lines. Owns the third **[FOUR-ENCODERS]** member (`canonicalJson`, `:1285-1291` — locale-sorted, **BigInt input throws `TypeError`**, not encoded — must reproduce the throw or prove unreachable, not silently "fix" by encoding it). 7 `.localeCompare()` sites. `performance.now()`-based budgets whose *thresholds* (30000/25000/15000/240000ms, etc.) are production constants to copy verbatim, not tune (`periodic.md` §12 item 8). | `tests/unit/intrinsicPeriodicFamilyPortfolio.test.ts` [U]; `gate:mixed61-compact` [G] | CRITICAL — throwing BigInt encoder + locale-sensitive survivor/tie-break order + verbatim deadline constants. |
| `intrinsicReconstructionPortfolio.ts` | `core::reconstruction::portfolio` | Focused reconstruction: bounded catalog of alternative deterministic piece orders re-decoded through the strict constructor, gated by `intrinsicReconstructionSpecMatchesFamily`. **Production-live path is narrower than the full export surface**: only the `'endpoint-q90-right-to-left'` role and `runs` are read by the coordinator; the internal 8-slot Pareto `archive`/`winner` (`retainIntrinsicReconstructionArchive`) is fully computed every call but has **zero observable effect on nesting results today** — still must be ported byte-for-byte (unit-tested, migration prompt §3 immutability). 3 `.localeCompare()` sites; mixed with plain `.toSorted()` for ring-canonicalization/checkpoint-partition equality (`reconstruction.md` §12 item 1). | `tests/unit/intrinsicReconstructionPortfolio.test.ts` [U]; `irregularSeventeenShapesCompactGolden.test.ts` (focused reconstruction genuinely wins, `outputInfluence: 'selected'`) [U]; `intrinsicCapacityIntegration.test.ts` (`'protected-fallback'` path) [U] | HIGH — outcome-affecting on at least one golden fixture; dead-but-tested archive path adds porting effort without production payoff. |
| `intrinsicAnytimeArchive.ts` | `core::complete_archive::anytime_archive` | 62 lines — small namespace/comparator helper shared by the capacity search's anytime scheduler. | `tests/unit/intrinsicAnytimeArchive.test.ts` [U] | LOW |

## 5. Capacity

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `intrinsicCapacityPreflight.ts` | `core::capacity::preflight` | Exact-area and singleton-q0/q90 impossibility proofs only (migration prompt §10 rules 7-8: inconclusive is not a proof). Exact `BigInt` pressure-ratio arithmetic (`minimumCollisionAreaPressurePpm`, `maximumSingletonSpanPressurePpm`) with fixture-pinned exact expected values (e.g. `1_080_000n`). Cooperative `control.checkpoint` observation is reason-agnostic (cancellation vs. deadline both reachable, tested explicitly). Unconditionally live whenever the archive path is eligible (§4.1 — always runs first). | `tests/unit/intrinsicCapacityMode.test.ts` `describe('intrinsic capacity preflight', ...)` [U]; `intrinsicCapacityIntegration.test.ts` (routing assertions) [U]; `gate:capacity[:production]` [G] | HIGH — exact BigInt pressure arithmetic is fixture-pinned to specific integer values; any rounding/precision divergence fails a hard regression. |
| `intrinsicCapacityMaterial.ts` | `core::capacity::material` | 72 lines. Shared material-accounting utility/type module consumed by the search and by prefix reuse. | Indirect via `intrinsicCapacityMode.test.ts`, `intrinsicCapacityIntegration.test.ts` [U] | LOW |
| `intrinsicCapacityEndpoint.ts` | `core::capacity::endpoint` | 369 lines. `compareIntrinsicCapacityEndpoints` (terminal endpoint ranking) uses `.localeCompare()` for `canonicalGeometryHash`/`sourceRole` fields, while the cluster's own `compareStrings` (in `intrinsicCapacitySearch.ts`) is code-unit — both are ASCII hex digests/role literals in practice so they coincide today, but this must be **proven**, not assumed (`capacity-search.md` §12 item 1). Descending BigInt comparator variants (`compareBigintDescending`) distinct from the ascending family elsewhere (**[BIGINT-EXACT]**). | `tests/unit/intrinsicCapacityMode.test.ts`, `intrinsicCapacityIntegration.test.ts` [U] | HIGH — terminal endpoint comparator directly decides capacity-mode selection; locale/code-unit coincidence is empirical, not structural. |
| `intrinsicCapacityPrefixes.ts` | `core::capacity::prefixes` | 159 lines. Captures up to 9 zero-evaluation "warm prefix" descriptors from the legacy direct constructors' committed lineages; terminalizes fitting ones into zero-search incumbent endpoints. | `tests/unit/intrinsicCapacityMode.test.ts` `describe('intrinsic capacity prefixes', ...)` [U] | MEDIUM |
| `intrinsicCapacitySearch.ts` | `core::capacity::search` | 2,273 lines. The empty-start depth-synchronized beam search itself (`runIntrinsicCapacityColdSearch`); production constants beam width `16`, legal-placement fanout `3` (migration prompt §11); owns `IntrinsicAnytimeCheckpoint` (version `'intrinsic-anytime-checkpoint-v3'`, one of the **[FOUR-ENCODERS]**: code-unit-sorted, `Map`-silently-discarded, BigInt-as-string); `compareCapacityBeamEntries`/`retainCapacityBeamEntries`/`retainCapacityCohesionFrontier` comparator family; replay-determinism and checkpoint-resume are directly unit-tested with exact fixture assertions. | `tests/unit/intrinsicCapacityMode.test.ts` `describe('intrinsic capacity search', ...)` (replay-determinism, checkpoint resume, corruption rejection) [U]; `gate:capacity[:production]` [G] | CRITICAL — largest file in the capacity cluster; checkpoint encode/validate/hash is one of the four canonical encoders and the search itself is a Rayon-parallelization target under migration prompt §14, raising cache/ordering stakes simultaneously. |
| `intrinsicCapacityMode.ts` | `core::capacity::mode` | 1,430 lines. Thin-but-large routing wrapper: `runIntrinsicCapacityMode` dispatches `'preflight-proven-impossible'` and `'bounded-complete-archive-miss'` routing, calls prefix capture/terminalization, and hosts the observer-only `runIntrinsicCapacityCohesionShadow` (`retentionMode: 'cohesion-frontier-shadow'`, `outputInfluence: 'none'` — must be ported for test parity but never affects selection) and warm-prefix telemetry (non-authoritative unless `admitWarmPrefixEndpoints === true`). | `tests/unit/intrinsicCapacityMode.test.ts` (full file, 1,368 lines) [U]; `intrinsicCapacityIntegration.test.ts` [U]; `gate:capacity[:production]` [G] | HIGH — large routing surface with two non-authoritative shadow branches that must be byte-exact for tests yet provably inert for selection; easy to under- or over-port. |
| `intrinsicCapacityTelemetry.ts` | `core::capacity::telemetry` | 159 lines. `measureIntrinsicCapacityShadowTelemetry`, strictly observer-only (`routingInfluence: 'none'`), a 4-depth-bounded cold search run only when `captureCapacityShadowTelemetry === true`. Per migration prompt §13.7, this is diagnostic and must never re-enter canonical output — but it is unit-tested and gate-referenced (`intrinsicCapacityLaneCoordinatorTraceValid`), so still needs byte-exact porting. | `tests/unit/intrinsicCapacityMode.test.ts` (telemetry subsections) [U]; `gate:capacity` (via `irregular-capacity-gate.ts`) [G] | MEDIUM |
| `intrinsicPlaceDeferCompleteShadow.ts` | `core::reconstruction::place_defer_shadow` | 465 lines, 464-line non-authoritative shadow producer; owns `IntrinsicPlaceDeferCheckpoint` (version `'intrinsic-place-defer-checkpoint-v1'`) — a checkpoint-shaped structure that is **not** one of the four canonical hash encoders (different purpose) but must still be ported to its own exact schema, not unified with the others. | `tests/unit/intrinsicCapacityMode.test.ts` `describe('experimental place/defer complete shadow', ...)` [U] | MEDIUM |

## 6. Compact Short Side

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `intrinsicShortSideAxes.ts` | `core::short_side::axes` | 34 lines. Axis selection including the square-sheet axis convention (migration prompt §18.2 explicitly requires a dedicated test category for this). No dedicated unit-test file — exercised only indirectly. | Indirect via `intrinsicShortSideContactStrip.test.ts`, `intrinsicShortSideObserver.test.ts`, `intrinsicShortSidePairFoldObserver.test.ts` [U] | MEDIUM — tiny file, but the square-sheet-axis-convention edge case has no dedicated regression today; a Rust port risks silently changing that specific tie unless a new differential test is added. |
| `intrinsicShortSideObserver.ts` | `core::short_side::observer` | 775 lines. Imports `compareCanonicalGridRatios`/`compareBigInts` from `canonicalGridMath.ts` for exact span-ratio comparison — no floating tolerance (migration prompt §12: "use exact canonical-grid spans and cross-products, not floating tolerances"). Runs even when the complete archive was bypassed (preflight-proven-impossible), consuming zero archive endpoints but still the capacity-produced `selected.placedCollisionGeometries`. | `tests/unit/intrinsicShortSideObserver.test.ts` [U] | HIGH |
| `intrinsicShortSidePairFoldObserver.ts` | `core::short_side::pair_fold_observer` | 1,677 lines — largest file in the Short Side cluster. Pair-fold construction and multi-row shelf construction (migration prompt §12 scope items). 3 `.localeCompare()` sites. | `tests/unit/intrinsicShortSidePairFoldObserver.test.ts` [U]; `gate:compact-nine-baselines` (short-side winner categorization: multi-row shelf vs. contact strip) [G] | CRITICAL — largest, most complex Short Side file; directional construction winner directly determines the nine-baselines gate's per-case short-side outcome. |
| `intrinsicShortSideContactStrip.ts` | `core::short_side::contact_strip` | 845 lines. Sole production caller of `measureCanonicalGridBoundaryOverlapAxisUnits` (`canonicalGridContact.ts`) — builds the Short Side "contact strip" score tuple: `hasPositiveCanonicalGridBoundaryContact` (any collinear direction) feeds `positiveContactCount`; `measureCanonicalGridBoundaryOverlapAxisUnits` (axis-aligned only, `'undecidable'` on positive diagonal contact) feeds `axisUnits` — migration prompt §12's "diagonal and axis-aligned contacts both contribute to positive-contact count; only axis-aligned overlap contributes to projected-length tie-breaking" is a **confirmed-by-source**, not contradicted, claim (`canonical-grid.md` §15 item 1). Protected prepared-order depth-first contact strip, capped contact-first strip, bounded reverse-depth and canonical-ID continuations, exact contact tuple, directional validation/comparison. | `tests/unit/intrinsicShortSideContactStrip.test.ts` [U]; `gate:compact-nine-baselines` [G] | CRITICAL — the exact contact tuple and directional comparison are the specific outcome the nine-baselines gate pins per case; a sign or tie-break error here silently flips the winning direction. |

## 7. Search, keys, scoring

**Headline fact governing every row in this section** (`search-scoring.md`,
verified by call-site grep): the elaborate score **comparators**
(`compareScores`, `balancedCompactnessOrder`, `shortSideFillOrder`,
`edgeContactThenBalancedCompactnessOrder`, `intrinsicCompactnessOrder`,
`layoutScoreOrder`, `strictLayoutScoreOrder`, `scaleAwareLayoutScoreOrder`)
are **not used to select anything** on the production Compact/Compact Short
Side path under shipped presets — they are exercised only by the dead legacy
`portfolioSearch.ts`/`windowedBeam.ts` GA/beam engine (§9). What **is** live:
(a) `IrregularBeamState`'s canonical occupied-geometry key machinery (state
dedup, hot path), (b) `irregularPlacementScorer.ts`'s pure `scoreCandidate`
*value* computation (not its comparators) called once per retained candidate
inside capacity search, (c) `irregularLayoutScorer.ts`'s `scoreState` *value*
computation called once or twice per job. **A Rust port must still port the
comparators byte-for-byte (unit-tested, migration prompt §3), but must not
assume they are reachable from the production selection path** — treat them
as tested-but-currently-inert, exactly like the reconstruction archive and
capacity shadow lanes above.

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `irregularBeamState.ts` | `core::search_scoring::beam_state` | 986 lines. Owns the fourth **[FOUR-ENCODERS]** member: `canonicalRecord`/`canonicalToken`/`canonicalNumber` — a bespoke length-prefixed netstring format (`` `${name.length}:${name}${value.length}:${value}` ``) where `canonicalToken`'s length prefix is a **UTF-16 code-unit count** (`.encode_utf16().count()` in Rust, not `.len()`/`.chars().count()` — `js-semantics-audit.md` §8.3), feeding `canonicalOccupiedGeometryKey` (beam dedup identity, used directly as a comparator/Map key, not SHA-256-hashed). `insertCanonicalEntryKey` does an explicit stable-sorted linear-scan insertion into a frozen array copy — behaviorally equivalent to append+stable-sort **only** because the array is provably already sorted at every call (this is the sole mutator); `Vec::binary_search`+`insert` is safe only under that same invariant. `compareCanonicalKeys` is code-unit (not locale). Deepest call-count concentration of the CPU profile (`canonicalPlacementPointAlternatives` 4.0%, `canonicalRingKey` 3.1%, `canonicalCollisionPolygonKey` 2.4% of Mixed-61 total — `baseline-evidence.md`). | `tests/unit/canonicalCollisionPolygonKeyEquivalence.test.ts` [U]; indirect via every golden/capacity/short-side test that constructs an `IrregularBeamState` — **no dedicated `irregularBeamState.test.ts` exists** | CRITICAL — hottest CPU path in the whole pipeline (beam-state canonical keys are 12.9% of Mixed-61 self-time per `baseline-evidence.md`) *and* one of the four hand-rolled canonical encoders *and* has no dedicated unit test, so a Rust-port regression here is the likeliest silent hash-changing bug and the least directly test-covered. |
| `irregularPlacementScorer.ts` | `core::search_scoring::placement_scorer` | 451 lines. `scoreCandidate` value computation is live (called from `intrinsicCapacitySearch.ts:654` when `captureTopologyRetention` is true, the production default via `'cohesion-frontier'` retention mode) — only `sharedCollisionBoundaryLengthMm` is read from the result. Its five named comparators are dead on the production path (see headline). | `tests/unit/irregularPlacementScorer.test.ts` (469 lines, 16 `it` blocks) [U] | HIGH — value computation is hot-path live; comparators must still port exactly for test parity despite being production-inert. |
| `irregularLayoutScorer.ts` | `core::search_scoring::layout_scorer` | 585 lines. `scoreState` called once (Compact) or twice (Compact Short Side — once for the settled Compact result, once for the final directional result) per completed job. `computeSnapshotWithParentFallback`'s `extendFreeMaterial` incremental branch is **provably dead in production** (`state.parent` is always `undefined` at every production construction site) but is directly unit-tested — must port, cannot skip. `MAX_FREE_MATERIAL_CACHE_ENTRIES = 256` eviction logic is never under real pressure in production (≤2 calls/job) but must still be correct for the test suite. | `tests/unit/irregularLayoutScorer.test.ts` [U] | MEDIUM — low call volume (≤2/job) bounds the performance stakes; correctness stakes remain full because of test immutability. |
| `irregularScoreGrid.ts` | `core::search_scoring::score_grid` | 42 lines. `canonicalizeIrregularScoreMillimeterUnits`/`canonicalizeIrregularScoreScalar` hand-roll round-half-away-from-zero via `Math.sign(value) * Math.floor(Math.abs(value)*scale + 0.5)` — the **opposite** hand-rolled convention from `Math.round`-direct sites elsewhere in the codebase, and confusingly the one that *does* match Rust `.round()`'s rounding direction while *not* matching Rust's `f64::signum()` (`Math.sign(0)===0`, `Math.sign(-0)===-0`; Rust `signum()` never returns `0.0`) — **[MATH-ROUND]**, do not "simplify" this to `.round()` during the port, it would silently drop the sign-of-zero preservation. | Indirect via `search-scoring.md`'s cited golden/capacity tests; no dedicated unit-test file | MEDIUM — tiny file, but the rounding-convention footgun is exactly the kind of change a well-meaning simplification pass would introduce. |
| `sortPiecesForNesting.ts` | `core::search_scoring::sort_pieces` | 18 lines. `Array.prototype.toSorted` — **[STABLE-SORT]** applies directly; this is the prepared-piece order the migration prompt explicitly protects ("prepared-piece order"). Shared with the rectangular algorithm (out-of-scope) at the call-site level, but the irregular profile's own comparator must be ported. No dedicated unit-test file. | Indirect only — no `sortPiecesForNesting.test.ts` | LOW — tiny, single-purpose, but zero dedicated test coverage for a migration-prompt-protected ordering; recommend a new differential test rather than relying on golden-test coincidence. |

## 8. Geometry — collision prep, curve flattening, offset, transform

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `src/workers/irregular/collisionGeometryBuilder.ts` | `core::geometry::collision_prep::builder` | 259 lines. Builds every piece's source convex hull (calls `ConvexHull.compute` → `convexHullCore.ts`) and conservative-padded collision polygon. Template-literal number coercion used as a dedup key (`geometryKernel.ts:103`, shared pattern) — **[NUMBER-TOSTRING]** applies; JS `-0` collapses to `"0"` in the key. | `tests/unit/collisionGeometryBuilder.test.ts` [U] | MEDIUM |
| `src/workers/irregular/transformGenerator.ts` | `core::geometry::collision_prep::transform_generator` | 441 lines. Transform generation and the adaptive Compact transform policy (migration prompt §5's `docs/research/adaptive-compact-transform-policy.md`, substituting for the missing `knowledge/` page). Two `Array.prototype.sort` sites with different comparators — **[STABLE-SORT]**. Signed-zero fold at `:432`. | `tests/unit/transformGenerator.test.ts` [U] | MEDIUM |
| `src/workers/irregular/arcFlattening.ts` | `core::geometry::flatten::arc` | 163 lines. Curve flattening behavior used by the irregular pipeline (migration prompt §4.1 explicit scope item). No dedicated unit-test file found. | Indirect only | MEDIUM — no direct test coverage located; flag for a new Stage 2 differential test against known arc fixtures. |
| `src/workers/irregular/ellipseFlattening.ts` | `core::geometry::flatten::ellipse` | 172 lines. Same category as arc flattening. No dedicated unit-test file found. | Indirect only | MEDIUM — same test-coverage gap as `arcFlattening.ts`. |
| `src/workers/irregular/clipper2OffsetAdapter.ts` | `core::geometry::offset::clipper2_adapter` | 234 lines. Conservative padding/offset behavior; calls into `clipper2-ts`'s `stripDuplicates` (removes only **consecutive** duplicate points via exact-integer `Point64Utils.equals`, plus one trailing closure point — intentionally preserves non-adjacent repeated points, per its own doc comment). The Rust `clipper2-rs` binding must reproduce this exact consecutive-only dedup, not a more aggressive pass (`canonical-grid.md` §12 item 5). | `tests/unit/clipper2OffsetAdapter.test.ts` [U] | HIGH — directly depends on `clipper2-rs`'s fidelity to `clipper2-ts`'s specific path-cleanup behavior, the single largest external-dependency risk in this subsection. |
| `src/workers/irregular/clipper2OffsetPolicy.ts` | `core::geometry::offset::offset_policy` | 59 lines. Shared `toGridMm`/`fromGrid` grid-conversion authority used throughout the geometry cluster (including the dead E5/V7 experimental families, which reuse it unchanged) and Miter/Polygon offset parameter policy. Signed-zero propagation through `toGridMm`/`fromGrid` follows plain IEEE-754 `*`/`/` sign rules identically in JS and Rust (safe) — the hazard is only in code that stringifies the result afterward, which is out of this file. | Indirect via every geometry test that exercises grid conversion | HIGH — single shared grid-conversion authority; a divergence here propagates to every canonical-grid computation in the cluster. |
| `src/workers/irregular/convexPolygonOffset.ts` | `core::geometry::offset::convex_offset` | 65 lines. Convex-specific offset shortcut. | Indirect | LOW |

## 9. Geometry — NFP/IFP and candidate generation

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `src/workers/irregular/nfpIfpService.ts` | `core::geometry::nfp_ifp::service` | 1,299 lines. Combines IFP corners, NFP vertices, antiparallel-edge support points, NFP/IFP and NFP/NFP intersections into one canonical point set; snaps to canonical grid; keeps the first grid-legal alternative per raw point passing exact convex-overlap legality (`placementValidation.ts`). Production always runs `constructionAlgorithm='vertex-pair-hull'`, `candidatePruningMode='indexed'` (neither overridden at either production wiring site) — the `'linear-edge-merge'`/`'reference'` alternatives are real, tested, differential-oracle code but **not selected in production**; must still be ported (unit/differential-oracle tested) but are not the hot default. `resolveIfpBoundsFromServiceStore` is an internal synchronous bypass of the public `computeIfpBounds` Effect API — the public API's `IrregularGeometryInfeasibleError` failure channel is a **tested contract with zero production call sites**; production silently absorbs "infeasible" instead of failing (§11 asymmetry, `nfp-ifp.md`). Single largest CPU-profile category: NFP/IFP candidate generation is 29.6% of Mixed-61 self-time, anonymous NFP/IFP service closures alone 19.0% (`baseline-evidence.md`). | `tests/unit/nfpIfpService.test.ts` [U]; `geometryBackendParity.test.ts` [U]; `gate:mixed61-compact` [G] | CRITICAL — largest single CPU-time contributor in the entire pipeline; both construction-algorithm variants and both pruning-mode variants must port exactly even though only one pair is production-selected, and the public-vs-internal-API failure-channel asymmetry is an easy place to accidentally "fix" behavior during the port. |
| `src/workers/irregular/core/nfpBoundaryCore.ts` | `core::geometry::nfp_ifp::boundary_core` | 509 lines. NFP (Minkowski-difference boundary) construction; caches per fixed/moving pair, translates into sheet space. Calls `computeConvexHull` (`convexHullCore.ts`) directly at 3 sites, including as the live default NFP-boundary construction algorithm. | `tests/unit/nfpBoundaryCore.test.ts`, `nfpBoundaryTrustedRings.test.ts` [U] | HIGH — hot path, exact ordered-coordinate fingerprint requirement for trusted-ring reuse (migration prompt §13.2) is load-bearing here. |
| `src/workers/irregular/core/ifpBoundsCore.ts` | `core::geometry::nfp_ifp::ifp_bounds_core` | 131 lines. IFP/sheet-bounds construction; cache validation that never trusts a stale cached rectangle over the live polygon bounds (migration prompt §13.2: "IFP validation before cache access"). | `tests/unit/ifpTransformCore.test.ts`, `pureIfpTransformContract.test.ts` [U] | MEDIUM |
| `src/workers/irregular/nfpIfpTelemetry.ts` | `core::geometry::nfp_ifp::telemetry` | 237 lines. Passive, opt-in counters; no imports, no control-flow effect (self-documented). Non-authoritative per migration prompt §13.7. | `tests/unit/nfpIfpTelemetry.test.ts` [U] | LOW |
| `src/workers/irregular/transformCollisionGeometry.ts` | `core::geometry::nfp_ifp::transform_collision_geometry` | Effect-wrapped caller around the pure `transformCollisionGeometryCore.ts` resolver. | Indirect via `pureIrregularCoreBoundary.test.ts`, `trustedGeometryCarrierBoundary.test.ts` [U] | MEDIUM |
| `src/workers/irregular/core/transformCollisionGeometryCore.ts` | `core::geometry::nfp_ifp::transform_collision_geometry_core` | Pure hot-path resolver called directly by `geometryKernel.ts`; transformed-geometry key construction and lookup before recomputation (migration prompt §13.2). Signed-zero fold at `:181`. | `tests/unit/pureIrregularCoreBoundary.test.ts` [U] | HIGH |

## 10. Geometry — caches

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `src/workers/irregular/core/nfpCacheKey.ts` | `core::geometry::cache::nfp_cache_key` | Relative NFP sharing across canonically equivalent copies, followed by fixed-piece translation after retrieval (migration prompt §13.2). Own copy of `numberKey` (`Object.is(value,-0)?'0':String(value)`) — **[NUMBER-TOSTRING]** + **[NEG-ZERO]**, flagged as the single highest-risk number-to-string site in `geometry-caches.md` because a cache-key mismatch is a correctness bug (silent wrong hit), not just a performance one. | `tests/unit/nfpBoundaryCore.test.ts`, `nfpBoundaryTrustedRings.test.ts` [U] | CRITICAL — cache-key divergence risk is strictly worse than an output-formatting divergence: it can cause a silently wrong cache hit, not just a slow miss. |
| `src/workers/irregular/core/geometryCacheIdentity.ts` | `core::geometry::cache::cache_identity` | Own copy of `numberKey`; transformed-geometry key construction. Signed-zero fold at `:140`. | `tests/unit/irregularGeometryCache.test.ts` [U] | CRITICAL — same "wrong cache hit is a correctness bug" reasoning as `nfpCacheKey.ts`. |
| `src/workers/irregular/core/geometryCacheStore.ts` | `core::geometry::cache::cache_store` | Synchronous backing store; `JSON.stringify([key.namespace, key.parts])` cache-key serialization — plain insertion-order regime (**not** one of the four canonical encoders; §8.2 "two regimes," do not conflate). Map iteration here is pure key→value lookup, never observed for order — safe to back with a Rust `HashMap`/`DashMap` per `geometry-caches.md`'s own analysis. | `tests/unit/irregularGeometryCache.test.ts` [U] | HIGH — this is the module Stage 3-4's cache-architecture redesign (migration prompt §13) attaches to; getting the key-serialization byte contract exactly right here is a prerequisite for any concurrent-cache work. |
| `src/workers/irregular/geometryCacheKeys.ts` | `core::geometry::cache::cache_keys` | Own copy of `numberKey`; `JSON.stringify` at `:95`, plain insertion-order regime. | `tests/unit/irregularGeometryCache.test.ts` [U] | HIGH |
| `src/workers/irregular/geometryCacheStoreLive.ts` | `core::geometry::cache::cache_store` (implementation) | Live Effect-service wiring of the cache store; per `effect-boundary.md` §9 (independently probe-verified against the real production layer graph), exactly **one `GeometryCache` instance is shared per job** across every service that reads it — this "one cache domain per job" invariant (migration prompt §13.1) must be reproduced by the Rust job-context design, not accidentally duplicated per call site. | `tests/unit/irregularGeometryCache.test.ts` [U] | HIGH — the single-instance-per-job invariant is exactly the seam migration prompt §13's cache-architecture requirements attach to. |

## 11. Geometry — canonical grid, layout identity, contact, free material

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `src/workers/irregular/canonicalGridMath.ts` | `core::geometry::canonical_grid::math` | 201 lines. Foundational exact BigInt/Number dual-path primitives. `isCanonicalGridCoordinate = Number.isSafeInteger`; `canonicalGridCrossSign`'s documented, proof-commented fast path (exact within `CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT = 2**25-1`, chosen so `8L² < 2^53`) must be reproduced with the **same bound and branch structure**, computing the fast-path formula in the exact `f64` operation order specified — not substituted with an always-exact `i128` computation (**[REASSOC]**, `js-semantics-audit.md` §7.2). `canonicalGridCounterClockwise`/`Clockwise` default to "leave as-is" on exactly-zero signed area (`>=`/`<=`, not `>`/`<` — an easily-inverted-by-accident tie direction). `canonicalGridConvexHull`'s dedup Map is "last write wins value, first-occurrence-wins position" on duplicate `(x,y)` keys — a naive `HashMap::entry().or_insert()` port would keep the *first* value, wrong; needs `HashMap::insert`-equivalent (last-wins) semantics with position tracked separately. `doubledGridAreaToMm2` guards `Number.isFinite` after `Number(bigint)` (can silently become `±Infinity` for out-of-`f64`-range bigints, no exception) — the sibling `doubledGrid2ToMm2` elsewhere does **not** guard identically; port each site's guard-or-no-guard individually, do not unify. `canonicalGridPointOnSegment` has **zero production callers anywhere in `src/`** (open question — port faithfully as unreachable, pending an explicit ruling). | `tests/unit/canonicalGridMath.test.ts` (differential fast-path-vs-BigInt-oracle with a seeded LCG) [U] | CRITICAL — this is the concrete embodiment of migration prompt §8.2/§8.3's exact-integer-authority requirement and a template every other exact predicate in the port depends on; the fast-path/exact-path bound and branch structure is proof-load-bearing, not just "port the formula." |
| `src/workers/irregular/canonicalGridContact.ts` | `core::geometry::canonical_grid::contact` | 386 lines. `hasPositiveCanonicalGridBoundaryContact` (any collinear direction — positive-contact count) vs. `measureCanonicalGridBoundaryOverlapAxisUnits` (axis-aligned only, `'undecidable'` on positive diagonal contact — projected-length tie-break) are deliberately different predicates feeding different downstream fields (confirmed, not contradicted, migration prompt §12 claim). The overlap-axis-units scan is the cluster's one cancellation-aware loop — must stay serial (§14). | `tests/unit/canonicalGridContact.test.ts` [U] | HIGH |
| `src/workers/irregular/canonicalLayoutGeometry.ts` | `core::geometry::layout_geometry` | 888 lines, most widely depended-on file in the cluster (23 non-test importers). `assertCanonicalGridLegalLayout`, `canonicalCollisionLayoutIdentity` (the SHA-256 preimage for collision/fitted identity — the exact identity `gate:mixed61-compact` pins), `measureCanonicalEnclosedCavities`, `measureCanonicalLayoutEnvelope`, `measureCanonicalLayoutContacts`, `analyzeCanonicalLayoutStructure`, `measureCanonicalLayoutTopologyExact`. `orderedPiecePair` uses raw `<` while `comparePiecePairs` uses `.localeCompare()` **in the same file** on the same `PieceId` type — **[CODE-UNIT vs LOCALE]**, must not be unified. `identityAtQuarterTurn`'s 4-rotation smallest-code-unit-string selection at `:144-149` has an unguarded `Number` subtraction (`x - minX`/`y - minY`, `:608`) with no `Number.isSafeInteger` check unlike the file's exact-BigInt functions — a latent imprecision that must be **reproduced**, not fixed, per migration prompt §2. `largestHullGapRegion`'s pre-order-traversal tie-break rule (`netDoubledArea === selectedDoubledArea && key < (selectedKey ?? key)`) must be preserved under any future parallel `PolyTree64` walk (§14). Recursive `PolyPath64`/`PolyTree64` traversal has no explicit depth cap — do not introduce one. | `tests/unit/canonicalLayoutGeometry.test.ts` [U]; `gate:mixed61-compact` (exact collision/fitted SHA-256 identity) [G] | CRITICAL — `canonicalCollisionLayoutIdentity` is the exact hash `gate:mixed61-compact` pins byte-for-byte; the most consequential single output in the whole migration for the primary performance-contract case. |
| `src/workers/irregular/convexPolygonContact.ts` | `core::geometry::convex_contact` | 319 lines. Floating-mm counterpart to `canonicalGridContact.ts`: shared boundary between already-translated convex polygons via `robust-predicates`' adaptive-precision `orient2d` (through `geometryPredicates.ts`), not exact BigInt arithmetic — exactly the "robust predicates own unsnapped source-geometry decisions" division of responsibility (migration prompt §8.3). Called from `irregularBeamState.ts`'s `deriveMetadata` on **every** `IrregularBeamState` construction — one of the hottest functions in the pipeline. **No dedicated unit-test file exists**; exercised only indirectly. | Indirect only via `irregularPlacementScorer.test.ts` and every test constructing a 2+-piece `IrregularBeamState` — **no `convexPolygonContact.test.ts` or `irregularBeamState.test.ts`** | CRITICAL — hot-path file (every beam-state construction) with **zero dedicated test coverage**; combined with the `robust-predicates` bit-for-bit fidelity requirement (see `geometryPredicates.ts` row), this is a top candidate for a new Stage 2 differential/property test before any refactor is trusted. |
| `src/workers/irregular/freeMaterialService.ts` | `core::geometry::free_material` | 501 lines. Called at most **twice** per completed job (once for settled Compact, once for the final Short Side directional result), not per-candidate — size the performance budget accordingly, but port correctness byte-for-byte including the two branches (`extendFreeMaterial`, `createFreeMaterialService('direct-difference')`) that are **provably unreachable in production** yet directly unit-tested. `stripDuplicates` consecutive-only exact-equality dedup (shared with `clipper2OffsetAdapter.ts`, see §12 item 5 there). | `tests/unit/freeMaterialService.test.ts` (415 lines, incl. a "differential operations" describe block exercising the dead branches) [U] | HIGH — low call volume bounds performance risk; the two provably-dead-but-tested branches raise correctness-porting effort without production payoff, a pattern to flag explicitly rather than silently drop. |

## 12. Geometry — validation, spatial index, hull, predicates

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `src/workers/irregular/placementValidation.ts` | `core::geometry::validate::placement_validation` | 430 lines. `assessPlacement` is the dominant production call site by volume — pure, synchronous, deliberately **not** Effect-wrapped ("wrapping it in Effect cost one effect construction and one fiber step per point for no benefit," own docstring) — called once per canonical candidate point per alternative inside `nfpIfpService.ts`'s hot loop. `PlacementValidation.checkSheetless` (no sheet-bounds enforcement) has 4 live call sites in `intrinsicPeriodicCells.ts`. | `tests/unit/placementValidation.test.ts` [U] | HIGH — highest call-volume validation function in the pipeline. |
| `src/workers/irregular/placedCollisionSpatialIndex.ts` | `core::geometry::validate::spatial_index` | 261 lines. Persistent (functional/immutable) uniform-grid broad-phase index, owned incrementally by `irregularBeamState.ts` and `intrinsicShortSideContactStrip.ts`. `continuationIdentity()`'s cache key is a **hybrid** serialization: the `buckets` field is pre-sorted via `.toSorted(([a],[b]) => a.localeCompare(b))`, then the whole object goes through plain (unsorted, insertion-order) `JSON.stringify` — do not treat this as fully one regime or the other (§8.2 "two regimes," `js-semantics-audit.md` §8.2). Cell-key strings (`"${cellX}:${cellY}"`, e.g. `"-3:5"`) sorted with **no-locale-argument** `.localeCompare()` produce a demonstrably different order from byte comparison for negative-number-containing keys (empirically verified divergence example in `validation-spatial.md` §12 item 1 — the single highest-severity finding in that cluster). Migration prompt explicitly lists "mutable spatial-index updates" as a high-risk parallelization boundary (§14.2) — must stay serial/orchestrated, not become an uncontrolled Rayon cohort. | `tests/unit/placedCollisionSpatialIndex.test.ts` [U] | CRITICAL — the empirically-confirmed locale-vs-byte divergence on negative-coordinate cell keys is a concrete, demonstrated (not merely theoretical) parity hazard, and this structure is also named as a high-risk parallelization boundary. |
| `src/workers/irregular/geometryPredicates.ts` | `core::geometry::validate::predicates` | 35 lines. The single shared exact-sign orientation predicate (`orientation`), wrapping `robust-predicates@3.0.3`'s adaptive-precision `orient2d` and inverting its sign for the app's y-up DXF convention. Most widely depended-on primitive in the validation cluster (used by `convexPolygonValidation.ts`, `placementValidation.ts`, `convexHullCore.ts`, `nfpBoundaryCore.ts`, `convexPolygonContact.ts`, `irregularLayoutScorer.ts`). A Rust replacement (candidates: the `robust` crate, or a hand-port of Shewchuk's adaptive-precision predicates) must be proved **bit-for-bit** equivalent to this specific JS package's expansion/summation strategy — different adaptive-precision implementations can legitimately disagree on the exact-zero/epsilon boundary for near-collinear-but-not-exactly-collinear inputs even when each is individually "correct" (migration prompt §8.3 explicitly forbids "a geometrically reasonable but behaviorally different library"). | `tests/unit/geometryPredicates.test.ts` [U] | CRITICAL — single shared exact-sign predicate underlying nearly every other exactness guarantee in the geometry cluster; a Rust substitute that is merely "also adaptive-precision" is not sufficient per migration prompt §8.3, and this needs the largest differential-vector test suite of any predicate in the port. |
| `src/workers/irregular/convexPolygonValidation.ts` | `core::geometry::validate::convex_polygon_validation` | 314 lines. Sole gate for "is this a legal v2 collision polygon" everywhere in the pipeline (`placementValidation.ts`, `placedCollisionSpatialIndex.ts`, `nfpBoundaryCore.ts`, `transformCollisionGeometryCore.ts`, `ifpBoundsCore.ts`, `transformGenerator.ts`, `nfpIfpService.ts`, `freeMaterialService.ts`, `clipper2OffsetAdapter.ts`, `convexPolygonOffset.ts`). Guarded linear simple-ring decision has a documented performance provenance (`docs/artifacts/linear-ring-topology/`) — the guard's *condition*, not just its optimization intent, must be reproduced. | `tests/unit/convexPolygonValidation.test.ts`, `convexPolygonValidationTopology.test.ts` [U] | HIGH — widest fan-in of any single validator in the cluster. |
| `src/workers/irregular/convexBounds.ts` | `core::geometry::validate::convex_bounds` | 102 lines. `boundsForPoints`, `translatePolygonWithBounds`, `areDisjoint` broad-phase separation test. **[MINMAX-NAN]** applies to any `Math.min`/`Math.max` inside bounds computation. | `tests/unit/convexBounds.test.ts` [U] | LOW |
| `src/workers/irregular/convexHull.ts` | `core::geometry::validate::convex_hull` | 18 lines. Thin domain-object wrapper (`IrregularPoint[]` in / `IrregularPolygon` out) — sole implementation bound to `GeometryKernel.Live`'s `convexHull` operation. | Indirect via `collisionGeometryBuilder.test.ts` [U] | LOW |
| `src/workers/irregular/core/convexHullCore.ts` | `core::geometry::validate::convex_hull` (core) | 41 lines. Structural monotone-chain hull, no domain-object dependency; called directly by `nfpBoundaryCore.ts` at 3 sites, including as the **live default NFP-boundary construction algorithm** — more central than the `convexHull.ts` wrapper alone suggests. | Indirect via `nfpBoundaryCore.test.ts` [U] | MEDIUM |

## 13. Effect service boundary / trusted-domain handoff

These files are the TS-side "trusted data handoff" seam (schema-decoded
request → plain trusted classes → pure `core/*` math). The Effect service
wiring itself (Context.Tag/Layer composition, `.Live`/`.Unimplemented` split)
is an Effect-specific TypeScript idiom with no direct Rust analogue; the Rust
port's equivalent is an ordinary Rust job-context struct/trait boundary
constructed once per N-API call. Per-file liveness below is proved by direct
probe against the real production layer graph (`effect-boundary.md` §9), not
assumed.

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `src/workers/irregular/services.ts` | `core::domain` + `napi_api` job-context wiring | 451 lines. Declares 6 `Context.Service` tags, 6 `Data.TaggedError` classes, every operation-scoped input interface, the `GeometryCache` implementation, `cacheKeyToString`. **Live** — every tag/error class is used by the production `nesting.worker.ts` wiring. The Rust equivalent is a plain struct bundling the job's caches/config, constructed once per job (satisfying migration prompt §13.1's "one nesting job owns a coherent cache domain"). | `tests/unit/irregularGeometryKernel.test.ts`, `irregularGeometryCache.test.ts`, `pureIrregularCoreBoundary.test.ts`, `trustedGeometryCarrierBoundary.test.ts` [U] | MEDIUM — no algorithmic hazard, but getting the "one job, one cache/context instance" invariant right here is foundational for Stage 3-4's concurrency work. |
| `src/workers/irregular/geometryKernel.ts` | `core::domain` (settings) + boundary dispatch | 265 lines. `GeometryKernel` Effect service (5 operations) plus `GeometrySettings` holding the resolved `IrregularNestingSettings` for one job — `request.options.irregularSettings ?? GeometrySettings.Make`. **Live**, provided at `nesting.worker.ts:397-398`. | `tests/unit/irregularGeometryKernel.test.ts` [U] | MEDIUM |
| `src/workers/irregular/internalGeometry.ts` | `core::geometry::internal` | 68 lines. 8 plain, Effect-free, `@shared/*`-free structural interfaces — the vocabulary the pure `core/*` modules are typed against; imported by 19+ files. **Live** — pure type-vocabulary, no behavior; the Rust equivalent is plain struct definitions, not a wrapper module with logic. | Indirect via every `core/*` test | LOW — types only, no logic to get wrong. |
| `src/workers/irregular/infrastructure.ts` | *(not a Rust-port target)* | 29 lines. `IrregularNestingInfrastructureLive` convenience layer. **Dead on the production path** — `nesting.worker.ts` hand-composes the same services directly instead (because production must inject the *request's own* settings, while this file pins hard-coded `GeometrySettings.Live` defaults; using it in production would silently ignore request-supplied settings). Zero non-test importers (`tests/unit/irregularInfrastructure.test.ts` only). | `tests/unit/irregularInfrastructure.test.ts` [U] — test remains, no Rust equivalent needed | LOW — dead code; port only if the test file demands byte-identical composition behavior, which it does not (it only asserts the Layer graph composes). |
| `src/workers/irregular/index.ts` | *(not a Rust-port target)* | 5 lines. Barrel re-export. **Fully dead — zero importers anywhere in the repository**, including the "dead" `infrastructure.ts`. | none | LOW — no behavior to preserve. |

## 14. Trace and replay

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `decisionTrace.ts` | `core::trace::decision_trace` | 693 lines. Decision-trace event construction; `IrregularDecisionTraceEvent` field order is **insertion order** (object-literal property declaration order at each construction site) — a distinct, plain-JSON regime from the four sorted canonical encoders (**[FOUR-ENCODERS]** does not apply here — do not conflate). A Rust `serde`-derived struct reproduces this correctly only if field declaration order matches the TS literal's property order exactly, not an alphabetized or "logical" Rust-idiomatic order. | Indirect via golden tests exercising decision-trace output | HIGH — field-order-is-the-contract is an easy trap for a Rust `derive(Serialize)` that "helpfully" reorders fields. |
| `src/workers/decisionTraceNdjson.ts` | `core::trace::decision_trace_ndjson` | 37 lines. `events.map(event => JSON.stringify(event)).join('\n')` — plain per-event `JSON.stringify`, same insertion-order regime as `decisionTrace.ts`. | `tests/unit/decisionTraceNdjson.test.ts` [U] | MEDIUM |
| `src/renderer/utils/sharedArchiveHistory.ts` | *(stays TS — renderer)* | 36 lines. Renderer-side history reconstruction consuming Rust-produced reveal data. Out of scope per migration prompt §4.2 ("Renderer UI ... remain outside scope"); Rust must produce the correct "selected-layout reveal data needed by TypeScript history persistence" (§4.1) but does not implement this file. | n/a (TS-only) | N/A — not a Rust-port row; listed for completeness of the "Trace and replay" file group named in migration prompt §5. |
| `src/main/services/RunHistoryArchiveService.ts` | *(stays TS — main process)* | 77 lines. Electron main-process persistence service. Out of scope per migration prompt §4.2. | `tests/unit/runHistoryArchiveService.test.ts` [U] | N/A — not a Rust-port row. |

## 15. Protocol, shared domain, and the coarse N-API boundary

| TS file | Planned Rust module | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `src/shared/protocol/errors.ts` | `core::protocol` (mirrored error enum) | External `AppErrorCode` contract. `assertNever`-driven exhaustiveness in TS becomes a Rust exhaustive `match` with no default arm — the runtime `assertNever` helper itself is unnecessary in Rust (a case where Rust's type system provides a *stronger* guarantee than the TS runtime check it replaces, safe per migration prompt §2 since it changes no *reachable* behavior). Several internal error classes (`IrregularWindowedBeamAbortedError`, `IntrinsicQueueBeamDiscriminatorError`) provably cannot reach `AppErrorCode` at all (dead-branch-only constructors) — do not add Rust mapping arms for codes that have no live constructor, but do document why each omission is safe. | `tests/unit/workerProtocol.test.ts` [U] | HIGH — the external error contract Electron IPC depends on; must be exact for both reachable and (documented) unreachable codes. |
| `src/shared/protocol/worker.ts` | `core::protocol` (request/response DTOs) | 188 lines. RPC message shapes. The one function boundary a coarse-grained N-API call must reproduce end-to-end. | `tests/unit/workerProtocol.test.ts`, `irregularWorkerCompute.test.ts` [U] | HIGH |
| `src/shared/irregular/domain.ts` | `core::domain` (trusted carriers) | Trusted plain classes (`IrregularPreparedPiece`, `IrregularPlacement`, `IrregularPlacedPiece`, etc.) constructed **after** TS Effect-Schema validation (migration prompt §4.1: "trusted request conversion after TypeScript schema validation" is in scope for Rust, the *validation* itself is not). `hasOwnProperty`-gated optional fields (`pieceId`, `interchangeabilityKey`, `priorityOrderKey`) are true own-property omission, not `undefined`-valued presence — **[UNDEFINED-OMIT]**. | `tests/unit/irregularSchemaContracts.test.ts`, `trustedGeometryCarrierBoundary.test.ts` [U] | HIGH — every downstream cluster's DTOs derive from this file's shape; an omission-vs-null mismatch here would corrupt every canonical encoder that reads these fields. |
| `src/shared/irregular/executionMode.ts` | `core::coordinator` (small pure reimplementation) | `intrinsicSharedArchiveEligibility` — 3-branch pure function (`intrinsicSharedArchiveEnabled !== true` → ineligible; `placementPolicyId === 'short-side-fill'` → ineligible; GA-active → ineligible; else eligible) that gates the entire archive-vs-legacy coordinator branch. Small and pure, but the routing decision it makes is exactly what determines whether the Rust port's scope (archive-eligible Compact/Short-Side) applies to a given request — the Rust coordinator must reimplement this exact predicate, not just receive a pre-computed boolean, since it is cheap and the source of truth stays TS-defined for UI purposes too. | Indirect via `intrinsicCapacityIntegration.test.ts` routing assertions [U] | MEDIUM — small surface, but a routing-logic mismatch here would silently misclassify which requests the Rust backend should claim. |
| `src/shared/domain/ids.ts` | `core::domain` (newtypes) | `PieceId`/`SourceFileId`/`JobId`/`FreeRectId` nominal string brands (Effect Schema `Schema.brand`) — no runtime representation beyond `string`; Rust newtype wrapping a `String` is sufficient. The `Math.random()`-based zero-argument ID-generation fallback is confirmed **not reachable** from the nesting hot path (only from `presetShapes.ts` module-load-time catalog generation) — do not port that fallback as part of the nesting algorithm. | Indirect | LOW |
| `src/shared/domain/nesting.ts`, `src/shared/domain/geometry.ts` (relevant subset) | `core::protocol` (boundary DTOs) | Sheet/rect scalar schemas shared with the excluded rectangular algorithm; Rust needs matching plain structs for whatever subset the irregular request payload uses. | Indirect | LOW |
| `src/shared/irregular/defaults.ts` | *(stays TS — settings construction)* | Builds the two shipped production settings factories (`makeCompactQualityIrregularOptimizerSettings`, `makeCompactShortSideIrregularOptimizerSettings`) that are always archive-eligible. Not itself ported — the *resolved* settings object crosses the N-API boundary as data; Rust never needs to hardcode these defaults, only to read whatever settings TS sends. | n/a (TS-only) | N/A — not a Rust-port row, but its production values (beam width 16, fanout 3, etc.) are the numeric contract migration prompt §11 pins; verify against source before relying on any cached copy. |

## 16. Vendored external dependencies

| Origin | Planned Rust crate | Key semantic invariants | Parity tests | Port risk |
|---|---|---|---|---|
| `clipper2-ts@2.0.1-18` (npm, used subset: Core, Engine, Clipper, Offset) | `crates/clipper2-rs` | Per orchestrator decision: **vendor-translate** the used subset into Rust, pinned by differential vectors against `clipper2-ts@2.0.1-18` output — not a binding to a different-version C++ Clipper2 (migration prompt §8.3: "verify that it reproduces the existing `clipper2-ts` operations, fill rules, orientation, path cleanup, offset parameters, and output canonicalization exactly... Do not substitute a geometrically reasonable but behaviorally different library"). Must reproduce: Union/Difference/Intersection/Xor boolean ops, EvenOdd+NonZero fill rules, `PolyTree64` output shape/traversal order, Miter/Polygon offset parameters, and `stripDuplicates`'s exact consecutive-only dedup behavior (canonical-grid.md §12 item 5). | New differential-vector test suite (does not exist yet — Stage 1 deliverable) comparing `clipper2-rs` output against `clipper2-ts@2.0.1-18` for every boolean-op/fill-rule/offset-parameter combination the production pipeline exercises | CRITICAL — every canonical Boolean-geometry result in the entire port (NFP boundaries, free material, gap regions, cavities) ultimately bottoms out in this crate; a subtle divergence here is invisible until a downstream canonical hash silently changes. |
| `robust-predicates@3.0.3` (npm, wrapped by `geometryPredicates.ts`) | folded into `core::geometry::validate::predicates` (no separate crate planned; evaluate `robust` crate vs. hand-port) | Adaptive-precision exact `orient2d`; see §12 row for `geometryPredicates.ts` for the full bit-for-bit-equivalence requirement. | Same as `geometryPredicates.ts` row | CRITICAL — see §12 row. |

---

## 17. Out of scope — dead/probe-only modules (stay TypeScript, no Rust work)

Source: `docs/planning/rust-irregular-backend/characterization/aux-modules-liveness.md`
(full liveness verdict table, §1.0 of that document). All 18 files below are
**unreachable from the production Compact/Compact Short Side execution path**
under any settings a shipped preset can produce. Per migration prompt §3
(test immutability) they must be **left alone**, not reimplemented, deleted,
or "cleaned up" — their existing tests keep passing against the unmodified
TypeScript regardless of Rust-port progress.

| TS file | Verdict | Evidence |
|---|---|---|
| `portfolioSearch.ts` | DEAD — reachable via import graph (imported by `computeIrregularNesting.ts`), never executed for either shipped preset (both are always archive-eligible, so the `else` branch that calls it never runs) | `aux-modules-liveness.md` §1.1 |
| `priorityOrderService.ts` | DEAD — sole consumer is the dead `portfolioSearch.ts` | §1.1 |
| `windowedBeam.ts` | DEAD — only entered from the dead GA/beam branch and from dead `targetedExactLns.ts` | §1.1, §1.2 |
| `strictPriorityDecoder.ts` | DEAD, test-only — zero non-test importers anywhere | §1.2 |
| `targetedExactLns.ts` | PROBE-ONLY — unaliased probe script; capacity-gate shadow flags default `false` | §1.3 |
| `overlapRelaxation.ts` | PROBE-ONLY | §1.3 |
| `overlapRelaxationV1.ts` | PROBE-ONLY | §1.3 |
| `overlapRelaxationTracker.ts` | PROBE-ONLY (helper of `overlapRelaxation.ts` only) | §1.3 |
| `intrinsicComponentInterfaceClosure.ts` | PROBE-ONLY — capacity-gate shadow flag defaults `false` | §1.3 |
| `intrinsicDetachedPieceReinsertion.ts` | PROBE-ONLY, zero unit tests | §1.3, §14 |
| `intrinsicExactProjection.ts` | DEAD — zero non-test/non-probe production importers | §1.6 |
| `intrinsicGlobalSqueezePortfolio.ts` | DEAD — zero non-test importers repo-wide | §1.6 |
| `intrinsicPeriodicSmallFillE3.ts` | PROBE-ONLY, zero unit tests | §1.4, §14 |
| `intrinsicQueueBeamDiscriminator.ts` | DEAD, test/probe-only — self-documented "never participates in the live decode, ranking, or deadline" | §1.5 |
| `intrinsicSqueezeDisruptSeparate.ts` | DEAD — imported only by dead files | §1.6 |
| `intrinsicTransformSeparator.ts` | DEAD — imported only by the dead E5/E5.1 cluster | §1.6 |
| `intrinsicTwoPieceInterfaceReconstruction.ts` | PROBE-ONLY, zero unit tests | §1.3, §14 |
| `intrinsicV7SeedArchive.ts` | DEAD — zero non-test importers repo-wide | §1.7 |
| `convexSatPenetration.ts` (`src/workers/irregular/`) | DEAD — sole importers are the dead `overlapRelaxation.ts`/`overlapRelaxationV1.ts` island; independently reconfirmed by `validation-spatial.md` §1 with an empirical grep chain | `validation-spatial.md` §1, table row + "Dead-code evidence" block |

Also confirmed dead/non-production by `effect-boundary.md` (not in the
18-file `aux-modules-liveness.md` list, but same category):

| TS file | Verdict | Evidence |
|---|---|---|
| `src/workers/irregular/infrastructure.ts` | DEAD on production path — `nesting.worker.ts` hand-composes services directly instead; using this file in production would silently ignore request-supplied settings | `effect-boundary.md` §1.1 |
| `src/workers/irregular/index.ts` | Fully dead — zero importers anywhere in the repository | `effect-boundary.md` §1.1 |

**Consequence for the migration:** none of these ~20 files need a Rust
implementation to achieve Compact/Compact Short Side parity. `pnpm test`,
`pnpm gate:capacity`, and `pnpm gate:capacity:production` remain green
regardless of whether this code is ported, deleted, or left untouched, as
long as the TypeScript reference backend keeps building (the capacity-gate
script still imports several of them behind default-`false` flags and must
still typecheck).

## 18. Files that stay TypeScript by design (boundary-adjacent, not dead)

These are not dead code — they run in every production request — but the
migration prompt scopes them out of the Rust port explicitly (§4.2) or they
are the TS-side half of a boundary this document already covers on the Rust
side.

| TS file/area | Reason it stays TS | Rust-port implication |
|---|---|---|
| `src/main/services/WorkerSupervisor.ts`, `src/main/ipc/handlers.ts` | Electron main-process orchestration, IPC (migration prompt §4.2) | None — Rust is called from behind this layer, unchanged. |
| `src/renderer/utils/irregularSettingsUi.ts` | Renderer UI (§4.2) | None — constructs the settings object that eventually crosses the boundary; Rust only sees the resolved value. |
| `src/shared/schemas/nestingSchemas.ts`, Effect Schema validation generally | "Trusted request conversion **after** TypeScript schema validation" is in scope for Rust; the validation itself is not (§4.1 wording) | Rust must treat every field as already-validated/trusted; do not re-validate, but do not silently accept a shape TS would have rejected either (differential harness should assert TS always validates first). |
| `src/workers/algorithm/maxRects/*`, `src/workers/algorithm/beam/*` (except where irregular-specific, e.g. `windowedBeam.ts` which is itself dead) | Rectangular nesting algorithm and its generic beam scaffolding stay TS (§4.2) | None — out of scope entirely. `beam/state.ts:129`'s bare `.toSorted()` is confirmed unreachable from the irregular profiles (`js-semantics-audit.md` §1). |

---

## 19. Open questions requiring an orchestrator ruling

1. **`clipper2-rs` fidelity acceptance criterion.** What differential-vector
   coverage (operation × fill-rule × input-shape matrix) is sufficient to
   accept `clipper2-rs` as "exactly reproduces `clipper2-ts@2.0.1-18`" before
   any dependent geometry cluster (NFP, free material, gap regions) is
   trusted? This is the single highest-leverage decision for Stage 1/2
   sequencing (§16).
2. **BigInt-to-Rust-integer representation.** Checked `i128` vs. arbitrary
   precision (e.g. `num-bigint`) for the exact cross-product/area/ratio
   family — `compareCanonicalGridRatios`'s cross-multiplication of squared
   magnitudes is within roughly two orders of magnitude of `i128::MAX` at the
   practical `maxScaledCoordinate` bound (`canonical-grid.md` §15 item 7).
   Needs an explicit Stage 2 decision with a documented bound proof, not an
   implicit per-file choice.
3. **`localeCompare` collator parity against Electron's bundled ICU/V8**,
   not just the reference dev-machine Node build. The `en-US`/full-ICU
   default-locale resolution used to generate today's golden fixtures was
   confirmed only on the dev machine; whether it matches Electron's bundled
   V8/ICU is unverified (`js-semantics-audit.md` §15 item 3). If it diverges,
   the golden fixtures themselves are not a stable oracle for
   `.localeCompare()`-dependent ordering independent of anything the Rust
   port does — recommend pinning/asserting the ICU version and locale
   resolution actually used to generate each `.localeCompare`-sensitive
   golden fixture before treating it as the Rust port's collation oracle.
4. **`intrinsicQueueBeamDiscriminator.ts`'s `delayedLineage` diagnostic
   block's exact reachability** (`js-semantics-audit.md` §15 item 2) — moot
   for the Rust port scope since the whole file is confirmed dead
   (aux-modules-liveness.md §1.0), but flagged in case a future TS change
   revives any part of this file.
5. **`canonicalGridPointOnSegment` (`canonicalGridMath.ts:173-186`) has zero
   production callers.** Port faithfully as unreachable, or obtain an
   explicit ruling that it may be omitted with a citation to this document
   (`canonical-grid.md` §15 item 2)?
6. **Missing `knowledge/` directory.** Migration prompt §5 directs the
   implementer to `knowledge/INDEX.md` and named `knowledge/*.md` pages; no
   `knowledge/` directory exists in this checkout (confirmed independently by
   at least six characterization documents). The closest living equivalents
   are `docs/architecture/`, `docs/research/`, `docs/artifacts/`, and
   `docs/operations/irregular-production-gates.md`. Should the prompt be
   corrected, or should a `knowledge/` index be reconstructed from these
   directories before Stage 1 begins?
7. **New test coverage for currently-untested hot-path files.** Three files
   have no dedicated unit test today despite being on the production hot
   path: `convexPolygonContact.ts` (every `IrregularBeamState` construction),
   `irregularBeamState.ts` itself (no `irregularBeamState.test.ts`), and
   `arcFlattening.ts`/`ellipseFlattening.ts` (curve flattening). Should Stage
   1/2 add new TS-side unit tests for these *before* porting (to sharpen the
   oracle), or is the existing golden/integration-test indirect coverage
   accepted as sufficient given migration prompt §3 forbids adding tests that
   "replace" rather than "strengthen" the existing suite?
8. **`Math.max`/`Math.min` NaN-reachability** was not exhaustively audited
   across all 397+188 call sites (`js-semantics-audit.md` §15 item 4).
   Recommend adopting the safe default (an explicit NaN-propagating wrapper
   everywhere `Math.max`/`Math.min` is translated) as standing Rust-port
   policy rather than deferring a full site-by-site audit — requesting
   confirmation this is acceptable rather than blocking on the audit.
9. **Non-BMP/lone-surrogate reachability in piece labels/IDs** — not traced
   to the UI/import boundary by the JS-semantics audit (out of its
   `src/workers`+`src/shared` scope). Affects §2's `[CODE-UNIT vs LOCALE]`
   surrogate-pair caveat and the SHA-256 lone-surrogate substitution question
   (`js-semantics-audit.md` §15 item 5). Needs confirmation from whichever
   characterization effort covers piece import/label assignment.
