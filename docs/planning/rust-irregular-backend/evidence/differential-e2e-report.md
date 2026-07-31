# Rust Irregular Backend: Differential E2E Report

**Date:** 2026-07-31

**Working tree:** `rust-irregular-backend` at `0fa19255e4c01bf5e7c113ed6779a6dc4eac2e7c`, with uncommitted changes.

## Current verification update

Required differential rows passed 16/16. Strict full required rows passed 16/16, and exploratory N1 rows passed 8/8. The comparison remains TypeScript first, Rust second, sequentially, over placements, partitions, score, portfolio, diagnostics, sorted-piece order, complete snapshots, and all five structured traces. Only documented timing/RSS field values normalize by presence.

The Rust-only Mixed-61 Compact verification produced collision SHA `3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742`, fitted SHA `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`, 61 placed, 0 unplaced, in 30826 ms. Short Side produced collision SHA `c38a0cb4bb7765e4db102869224ef5b51f2a0bbc787cea05adf94ca0e2fe5e22`, fitted SHA `2a63c729108ba7680339cebaf86d4e39368a020eee95580caf9811d6d2bbc2ca`, 61 placed, 0 unplaced, in 31300 ms.

The Mixed-61 Compact production gate passed with area `391605.85017399996`, cavities `0`, and elapsed `32061.670542` ms. The Compact nine-baseline gate passed 9 cases and 18 layouts. The capacity production report passed at `/tmp/capacity-production.Q2EH7P/report.json`.

## Historical verification detail
## Acceptance bar

> mixed-61 2000×2700 fitted canonical SHA-256 `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b` with 61/61 placed from the RUST backend.

**MET.** Verified directly against the native addon (not just diffed against TypeScript) via the new `scripts/rust-parity/verify-mixed61-hash.ts`, which runs `computeIrregularNestingNative` alone and reproduces `scripts/irregular-compact-baseline.ts`'s own `fittedCanonicalSha256` computation (`canonicalizeIrregularLayout` over absolute-space collision polygons):

```
$ pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/verify-mixed61-hash.ts --sheet 2000x2700 --profile compact
{
  "placedCount": 61,
  "unplacedCount": 0,
  "collisionIdentitySha256": "3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742",
  "fittedCanonicalSha256": "ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b",
  "elapsedMs": 36216
}
```

Both hashes match the `irregular-compact-nine-baselines.ts` baseline table exactly (`collisionIdentitySha256`/`fittedCanonicalSha256` for `mixed-61`/`2000x2700`). The Compact Short Side profile was verified the same way and also matches its baseline entry exactly:

```
$ pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/verify-mixed61-hash.ts --sheet 2000x2700 --profile short-side
{
  "placedCount": 61,
  "unplacedCount": 0,
  "collisionIdentitySha256": "c38a0cb4bb7765e4db102869224ef5b51f2a0bbc787cea05adf94ca0e2fe5e22",
  "fittedCanonicalSha256": "2a63c729108ba7680339cebaf86d4e39368a020eee95580caf9811d6d2bbc2ca",
  "elapsedMs": 36783
}
```

## Gate summary (all green)

| Gate | Result |
|---|---|
| `cargo fmt --check` (crate) | clean |
| `cargo clippy --all-targets --release -- -D warnings` | clean |
| `cargo test --release` (crate) | **692 passed**, 0 failed |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test:focused` | **924 passed**, 17 skipped (92 files), 0 failed |
| `pnpm gate:capacity:production` | `{"reportPath":"/tmp/irregular-capacity-gate/report.json","passed":true}` |
| `pnpm gate:mixed61-compact --output /tmp/e2e-sheet-invariance` | `{"reportPath":"/tmp/e2e-sheet-invariance/report.json","passed":true}`, canonical hash `ef2b783a...` confirmed (TS side; Rust side independently confirmed above) |

## Differential fixture matrix

Every row below ran **both backends sequentially** (TypeScript first, then Rust, never concurrently) through `run-differential.ts` and compared the full documented semantic projection: placements, score, portfolio, diagnostics, sorted-piece order, complete state-snapshot sequence (including full remaining prepared pieces), and all five structured trace fields. The only normalized values are the explicitly named wall-clock-derived fields; presence or absence is still compared. `placed`/`unplaced` are read from the matched TypeScript result (both backends agreed on these in every "OK" row).

| Fixture | Sheet | Profile | Result | Placed/Unplaced | Elapsed |
|---|---|---|---|---|---|
| mixed61 (2 pieces) | 2000×2700 (fixture default) | Compact | **OK** | 2/0 | <1s |
| mixed61 (2 pieces) | 2000×2700 | Compact Short Side | **OK** | 2/0 | <1s |
| mixed61 (4 pieces) | 2000×2700 | Compact | **OK** (after fix #1) | 4/0 | <1s |
| mixed61 (4 pieces) | 2000×2700 | Compact Short Side | **OK** | 4/0 | <1s |
| mixed61 (8 pieces) | 2000×2700 | Compact | **OK** (after fix #2) | 8/0 | ~3.5s |
| mixed61 (8 pieces) | 2000×2700 | Compact Short Side | **OK** | 8/0 | ~3.5s |
| triangle-20 | 2000×2700 | Compact | **OK** | 20/0 | 7.3s |
| triangle-20 | 2000×2700 | Compact Short Side | **OK** | 20/0 | 8.2s |
| shapes-17 | 2000×2700 | Compact | **OK** | 17/0 | 13.7s |
| shapes-17 | 2000×2700 | Compact Short Side | **OK** (Finding N2 closed) | 17/0 | ~15s |
| mixed-61 (capacity path) | 600×400 | Compact | **OK** (after fix #3) | 25/36 | ~6s |
| mixed-61 (capacity path) | 600×400 | Compact Short Side | **OK** | 25/36 | ~8.4s |
| mixed-61 | 300×300 | Compact | **OK** | 6/55 | 1.7s |
| mixed-61 | 300×300 | Compact Short Side | **OK** | 6/55 | 1.8s |
| mixed-61 (full, run last) | 2000×2700 | Compact | **OK** | 61/0 | 79.4s |
| mixed-61 (full, run last) | 2000×2700 | Compact Short Side | **OK** (Finding N2 closed) | 61/0 | 83.2s |

Every hash-relevant field (placements, sorted-piece order, unplaced ids, diagnostics text/codes other than the two fixed bugs below) matched byte-for-byte in every row. `placedCount`/`unplacedCount` for every named-baseline row above match `scripts/irregular-compact-nine-baselines.ts`'s table exactly (25/36 for mixed-61 600×400, 6/55 for mixed-61 300×300, 61/0 for mixed-61 2000×2700, etc.).

## Divergences found, root-caused, and fixed

### Fix 1 — `derive_axis_basis_candidates`'s `axis_is_y` flag was inverted at all 3 call sites (correctness)

**File:** `crates/irregular-nesting-native/src/archive/periodic_cells.rs`
**Symptom:** mixed61 4-piece Compact — `diagnostics[0].message` diverged: TypeScript selected `periodic-P2`, Rust selected `legacy-absolute-envelope`.
**Root cause:** `boundary_line_intersections(boundaries, axis_is_y, value)`'s `axis_is_y: bool` parameter encodes the same thing as TS's `axis: 'x' | 'y'` string (`axis_is_y == true` ⟺ TS `'y'`, confirmed against the two *other* correct call sites of this function in the same file, e.g. `boundary_candidate_points`). `derive_axis_basis_candidates` called it with the literals swapped: `false` where TS passes `'y'` (finding the axis-crossing point) and `true` (twice) where TS passes `'x'` (finding the constrained second-basis-vector candidates). The effect: the "axis-union" basis-candidate source (TS `sourceKind: 'axis-union'`) intersected the wrong coordinate line, producing zero or geometrically-wrong candidates for the real, asymmetric production geometry in the mixed-61 fixture (a symmetric/degenerate case in the existing curated `periodic.json` vectors happened not to expose this — that vector suite still passes 100% after the fix, and no vector anywhere directly exercises the internal `derive_axis_basis_candidates`/`boundaryLineIntersections('y', ...)` pairing in isolation).
**Fix:** swapped the three literal `bool` arguments to their correct values. Verified the family cell catalog's `bySourceKind` breakdown (`P1:axis-union`, `P2:axis-union`, `P1:nfp-boundary-vertex-pair`, `P2:nfp-boundary-vertex-pair`, each capped at 16) now matches TypeScript exactly (16/16/16/16 on both sides, previously 0/0/16/16 on the Rust side).
**Verified by:** mixed61 2/4/8-piece Compact and Compact Short Side all pass; full `cargo test --release` (692 tests) unaffected.

### Fix 2 — O(n²) clone blowup in periodic continuation construction (performance; was a hard blocker for the acceptance-bar run)

**Files:** `crates/irregular-nesting-native/src/archive/periodic_cells.rs`, `crates/irregular-nesting-native/src/archive/periodic_family.rs`
**Symptom:** mixed61 7-piece Compact: Rust backend exceeded the periodic catalog's 30s runtime budget and failed with `catalog-runtime=false` (a native-only error TypeScript never produces for the same input, which completes in ~1s). Timing instrumentation isolated ~18–24s inside a single `periodic_cell_front` call processing ~3,900–4,600 raw P2 cells.
**Root cause (two compounding bugs):**
  1. `IntrinsicPeriodicBaseMember.piece` was stored as `IrregularPreparedPiece` **by value**, not `Arc`-wrapped. TS objects are reference-counted implicitly by the JS engine — passing `piece` around a crop-enumeration double loop that can visit thousands of candidate points for real fixture geometry never deep-copies in TS. The Rust port deep-cloned the full prepared piece (source geometry, all transform candidates) on every `IntrinsicPeriodicBaseMember` construction (~9,000+ times for a 4-member family at 7 pieces) and again every time a constructed `IntrinsicPeriodicCell` got cloned downstream.
  2. `periodic_cell_front`'s per-`sourceKind` grouping loop (`let mut group = by_source_kind.get(&source_kind).cloned().unwrap_or_default(); group.push(cell); by_source_kind.set(source_kind, group);`) deep-cloned the **entire accumulated group** on every iteration instead of mutating in place — TS's equivalent (`const group = bySourceKind.get(sourceKind) ?? []; group.push(cell); bySourceKind.set(sourceKind, group)`) mutates the same array reference in O(1) amortized; the Rust port's `.get().cloned()` + reinsert pattern is O(group size) per call, i.e. O(n²) total for a group that grows to ~2,000+ elements. The identical anti-pattern also existed in `periodic_family.rs`'s witness-continuation grouping loop (a live production code path — `admitSourceAuditWitnesses`/`admit_source_audit_witnesses` is `true` in production, not `false` as a first read suggested).
**Fix:**
  1. Changed `IntrinsicPeriodicBaseMember.piece` to `Arc<IrregularPreparedPiece>`; hoisted one `Arc::new` per family (not per candidate) for the representative and second-member pieces, then `Arc::clone` (a refcount bump) at each construction site. `serde`'s `"rc"` feature was already enabled crate-wide, so `Serialize`/`Deserialize` derives kept working unchanged.
  2. Added `OrderedMap::get_or_insert_with` (already present with this exact name/shape in `periodic_family.rs`'s own copy of the same utility type; added the missing method to `periodic_cells.rs`'s copy too) and switched both grouping call sites to it — a single `HashMap` lookup plus, on miss, one insert; no clone of the accumulated value.
**Result:** the same 7-piece case dropped from a >45s timeout/failure to **3.2s**, matching TypeScript's own ~3.6s. No behavior change (compared to a hypothetical "if it had finished" run) since both fixes are pure performance/aliasing changes over otherwise-identical logic — confirmed via the full `cargo test --release` suite (692/692) and every differential row in the matrix above, up to and including the 79s/83s full 61-piece runs that previously would not have completed inside any practical budget.

### Fix 3 — Two TS-facing diagnostic messages used Rust `Debug`'s PascalCase spelling instead of the TS kebab-case string (correctness, string-only)

**File:** `crates/irregular-nesting-native/src/result/coordinator.rs` (plus new `as_str()` methods on `crates/irregular-nesting-native/src/capacity/preflight.rs::IntrinsicCapacityProvenImpossibleReason` and `crates/irregular-nesting-native/src/capacity/search.rs::IntrinsicCapacitySettlement`)
**Symptom:** mixed-61 600×400 (the capacity-path baseline) diverged twice in sequence:
  - `diagnostics[0].message`: TS `"reason minimum-collision-area-exceeds-sheet-area; ..."` vs Rust `"reason MinimumCollisionAreaExceedsSheetArea; ..."` (all three numeric fields already matched).
  - `diagnostics[1].message`: TS `"settlement evaluation-cap; ..."` vs Rust `"settlement EvaluationCap; ..."` (every other field — placed/unplaced counts, evaluations, hash — already matched byte-for-byte).
**Root cause:** two `format!("... {:?} ...", enum_value, ...)` call sites used the derived `Debug` representation directly instead of a proper TS-string conversion. `IntrinsicCapacityProvenImpossibleReason`'s message was also missing the `; piece {pieceId}` suffix TS appends only for the `singleton-transform-set-does-not-fit` variant.
**Fix:** added `as_str() -> &'static str` to both enums (mirroring the exact TS literal-union strings) and used them at both call sites; restored the conditional `; piece {pieceId}` suffix. Grepped the whole crate for the same `{:?}`-into-a-`message:`-field anti-pattern afterward (only two Rust-internal invariant-failure error messages remained, both on paths where the whole job fails outright rather than producing a divergent-but-successful result, so `run-differential.ts`'s field-by-field projection never reaches them).
**Result:** mixed-61 600×400 now matches exactly for both profiles, `placedCount=25`/`unplacedCount=36`/`canonicalSha256=2c53f31...` all confirmed against `irregular-compact-nine-baselines.ts`'s baseline table.

## Non-blocking findings (documented, not fixed)

### Finding N1 — Rare periodic "raw-witness" continuation tie-break divergence outside the required fixture matrix (CLOSED, see addendum below)

Exploring beyond the required 2/4/8-piece subsets (for bug-hunting headroom), truncated mixed61 subsets at 9, 10, 20, and 40 pieces (**not** part of the required test matrix, and not the real production fixture sizes) intermittently diverge on which `periodic-P2` "raw-witness" continuation becomes the shared-archive winner, e.g. at 9 pieces: TS selects `b024838a...` (envelope 71952.78mm², deficit 0), Rust selects `e50afdeaee...` (deficit 0, also present and correct in TS's own candidate list) instead of a third candidate `dbbea521...` (envelope 71953.16mm², deficit 0.3025, **not** deficit-zero, so it cannot itself be the TS winner).

Root-caused as far as time allowed:
- The **selected set of 8 continuations is byte-identical** between TS and Rust (verified: `sourceId`, `cellKey`, `basisSourceKey`, `seed.canonicalKey`, `seed.envelopeAreaMm2`, `seed.crop`, placed piece IDs, and remaining-family-member IDs all matched exactly for all 8 slots).
- The divergence appears only in the **strict-decoder "pure-growth" execution** of one specific witness continuation (placing the other family's remaining pieces on top of the frozen seed) — every input to that decoder call (`allPreparedPieces`, `remainingPreparedPieces` order, `frozenPlaced`, candidate mode, evaluation cap, runtime cap) was verified identical between the two languages.
- Did not fully isolate within the time budget available; the leading remaining hypothesis is the coordinator's per-phase-private `GeometryCacheStore` (the periodic runner gets its own fresh cache, documented in `coordinator.rs`'s own top doc as "a performance difference, never an observable-output difference" — an *asserted*, not *proven*, invariant) versus TS's single ambient-service cache shared across the whole job. Testing this would require restructuring the borrow-checker-constrained cache-sharing in `coordinator.rs` (the direct phase and the periodic runner both need a live `&mut GeometryCacheStore` simultaneously today), which is a real implementation change, not a quick toggle.

**Does not affect the required acceptance bar or fixture matrix**: the full 61-piece mixed-61 2000×2700 request (both profiles), 600×400, 300×300, triangle-20, shapes-17, and the 2/4/8-piece subsets all pass byte-exact including hashes. Flagging this precisely so a follow-up task can pick it up without re-deriving the above.

#### Addendum (2026-07-30, follow-up task): cache-scoping hypothesis tested and disproven; root cause still open

Per this finding's own leading hypothesis, `result/coordinator.rs`'s two per-phase-private `GeometryCacheStore` instances (`periodic_geometry_cache` for the periodic-family runner, `scheduler_geometry_cache` for the interleaved scheduler's nested cold-quantum resume) were eliminated: both `archive::shared::IntrinsicPeriodicFamilyPortfolioRunner::run` and `archive::shared::OnCanonicalGridCheckpointed` now take `geometry_cache: &mut GeometryCacheStore` as an explicit call parameter (the same reborrow-as-parameter pattern used for `control`, since both a struct-captured field and a top-level function parameter borrowing the same coordinator-level store simultaneously hit the identical E0499/E0521 rustc limitation this crate documents elsewhere), reborrowed from the coordinator's single job-wide `geometry_cache` at points in `archive::shared`'s own call chain where the prior borrow has already ended. `boundary::run_job.rs` already constructed exactly one `GeometryCacheStore` per job (confirmed by a full-crate grep: the only non-test `GeometryCacheStore::new()` call site left in the entire crate); with this fix, `result::coordinator.rs` now threads that one instance through every phase (direct, periodic, and the interleaved scheduler resume) instead of allocating two independent ones, matching `cache-concurrency-design.md` §2 exactly.

**Result: the hypothesis is disproven.** Re-running the exact repro (`mixed61 --pieces {9,10,20,40} --profile compact`, 5× each) after the fix reproduces the **identical** divergent winner hashes every single time, byte-for-byte unchanged from before the fix (`9-piece`: TS `b024838a27...` vs Rust `e50afdeaee...`; `10-piece`: TS selects `periodic-P2`, Rust selects `canonical-grid`; `20-piece`: TS `971acce3c2...` vs Rust `00a8c257ab...`). The divergence is fully deterministic across process invocations (ruling out an unordered-`HashMap`-iteration-order nondeterminism explanation too — a randomly-reseeded-per-process `HashMap` dependency would show *different* wrong answers across the 5 independent process runs, not the same one every time), and is completely unaffected by whether the direct/periodic/scheduler phases share one cache instance or three independent ones — confirming the cache is exactly what its own doc comment always asserted: "a pure memoization layer, not a correctness input."

Further narrowing attempted this session: `search::strict_decoder`'s `compare_local_scores`/`compare_exact_local_envelopes`/`select_intrinsic_strict_family_winner` (the tie-break comparator chain a "which continuation wins" divergence would most obviously implicate) were re-read side-by-side against `intrinsicStrictDecoder.ts`'s `compareLocalScores`/`compareExactLocalEnvelopes`/`selectIntrinsicStrictFamilyWinner` line-for-line and found faithfully ported (same short-circuit precedence, same first-wins-on-tie reduce/fold semantics, same `MaximumSideFirst`/`AreaFirst` branch structure). Combined with this finding's own prior session's result ("the selected set of 8 continuations is byte-identical... every input to that decoder call... was verified identical"), this narrows the remaining hypothesis space *away* from the winner-selection comparator itself and *toward* candidate-generation order during the pure-growth decode's own per-piece placement loop (i.e., something upstream of `select_intrinsic_strict_family_winner` feeds it a same-scoring-but-differently-ordered candidate list on at least one placement step, so the "keep first on tie" reduce picks a different candidate) — not isolated within this session's time budget either. A full trace-and-diff of per-piece candidate score arrays for the specific witness continuation (both languages, instrumented) is the concrete next step for whoever picks this up.

#### Addendum (2026-07-30, follow-up task, commit `81a57ed`): root cause found and fixed — `collinear_overlap_segment`'s `hypot` was the "something upstream" the previous addendum was looking for

The previous addendum's narrowed hypothesis ("candidate-generation order during the pure-growth decode... something upstream of `select_intrinsic_strict_family_winner` feeds it a same-scoring-but-differently-ordered candidate list") was correct in spirit but imprecise: the candidates were not differently *ordered*, they were differently *scored* by roughly 1 ULP. `canonical_grid::contact::collinear_overlap_segment`'s edge-length `hypot` call (then `std::f64::hypot`) fed `shared_convex_polygon_boundary_length`'s summed total, which becomes `IrregularBeamState::shared_collision_boundary_length_mm` — a `search::strict_decoder::compare_local_scores` tie-break field. `std::f64::hypot`/`libm::hypot` disagree with V8's own `Math.hypot` (fdlibm's high/low-word-splitting algorithm vs V8's Neumaier-compensated-sum algorithm) in the last 1-2 bits on a measurable fraction of real inputs; on the truncated 9/10/20-piece subsets, two competing witness continuations had bit-identical exact grid metrics but a `sharedBoundaryLengthMm` that tied in TS (real contact geometry, computed via V8's `Math.hypot`) yet disagreed by 1 ULP under Rust's `std`/`libm` hypot — enough to flip which candidate the "keep first on tie" fold picked.

**Fix**: `js_number::js_math::hypot`, a two-argument Node/V8-compatible implementation that normalizes by the maximum magnitude, sums normalized squares with Neumaier compensation, then applies `sqrt(sum) * max`. It was routed through the comparator-reaching call site. **Measured, not assumed**: `scripts/rust-parity/dump-js-hypot.ts` produces the committed 21,696-vector Node/V8 oracle at `tests/vectors/js-hypot.json`; `tests/js_hypot_vectors.rs` asserts the implementation against that corpus by raw binary64 bits for finite and infinite outputs.

**Result, independently re-verified by the N2-closure task (this same document's N2 addendum)**: `differential-fixture-matrix.ts --exploratory-only` now reports `8/8 passed` for exactly the `mixed61 --pieces {9,10,20,40} --profile {compact,short-side}` matrix this finding's repro commands named — the divergence this addendum set out to explain is gone. **Finding N1 is CLOSED.**

**Permanent fixture rows added**: `scripts/rust-parity/differential-fixture-matrix.ts` (new file) now carries both the acceptance-bar `REQUIRED_ROWS` matrix (this report's own "Reproduction" section; at the time this addendum was originally written, verified 14/16 passing — the 2 non-passing rows were Finding N2's pre-existing ULP-level `freeMaterialSliverMetric` divergence at `shapes-17 2000x2700 short-side` and `mixed61 2000x2700 short-side`, byte-identical to the values this report's N2 section already recorded, not a new regression) and an `EXPLORATORY_ROWS` list carrying this finding's 9/10/20/40-piece truncated subsets (both profiles) as permanent, non-blocking (unless `--strict-exploratory`) rows, so this divergence stays visible without re-deriving the repro commands. **Update (Finding N2 closure, see below): `REQUIRED_ROWS` is now 16/16 and `EXPLORATORY_ROWS` is 8/8** — re-verified after the N2 fix with the exact same commands, both group counts printed by the matrix script itself (`required: 16/16 passed; exploratory (N1): 0/0 passed` and `required: 0/0 passed; exploratory (N1): 8/8 passed` for the `--required-only`/`--exploratory-only` runs respectively). The `EXPLORATORY_ROWS` 8/8 is expected, not a re-discovery: Finding N1 itself was already fixed by a later commit (`81a57ed`, "fix: N1 — V8-exact Math.hypot port closes comparator-flipping ULP divergence", landed after this report was first written but never reflected back into this file) — see this report's own N1 section below for the finding and `js_math::hypot`'s doc comment for the fix's evidence trail. This N2-closure session independently re-confirmed the 8/8 exploratory pass rate as part of its own re-verification pass, which is worth recording here since this file previously had no explicit closure note for N1 at all.

### Finding N2 — Pre-existing, previously-documented ULP-level float divergence class (not a new bug) — **CLOSED, see addendum below**

`portfolio.score.freeMaterialSliverMetric` differs at the last 1–2 significant digits of an `f64` (e.g. `86.17847042969392` vs `86.17847042969387` at mixed61 40 pieces; `313539.85657207255` vs `313539.8565720725` at mixed-61 2000×2700 Compact Short Side; `222.54854651458191` vs `222.54854651458194` at shapes-17 2000×2700 Compact Short Side) — a relative difference on the order of 1e-13 to 1e-15. This is the same class of divergence the coordinator-port commit (`a709134`) already documented: "763 mismatches -> 0 strict + 2 ULP-bounded leaf fields (1e-9, documented; E2E hash gates adjudicate observability)".

Confirmed non-blocking each time it appeared: `firstDivergence` walks object keys in sorted order, so every key alphabetically before `portfolio` (`beamWidth`, `diagnostics`, `placedCollisionGeometries`, i.e. every placement/hash-relevant field) matched byte-for-byte before reaching this diagnostic float. Per stage0-rulings R21/R11, no tolerance may ever migrate into comparators, keys, or hashes — this field is a diagnostic score metric, never any of those, and the E2E hash gates (which passed, including the acceptance-bar hash) are the correct adjudicator here, not the strict field-level differential harness.

#### Addendum (2026-07-30, follow-up task): root cause proven and fixed — `polygon_perimeter`'s `hypot` was the same N1-class divergence, applied to a metric instead of a comparator

Root cause, confirmed by measurement (per this finding's own "measure, don't assume" standard): `search::layout_scorer::polygon_perimeter` (`irregularLayoutScorer.ts:401-410`'s port) summed edge lengths via `std::f64::hypot`, not V8's `Math.hypot`. Of the 235 polygon edges exercised by this crate's own free-material vector suite, 80 (34%) disagreed with the V8 oracle by 1 ULP — the same magnitude and mechanism N1 (above) already root-caused and fixed for `collinear_overlap_segment`'s comparator-feeding `hypot`, just landing on `derive_free_material_metrics`'s `free_material_sliver_metric` (`perimeter * perimeter / net_area`, serialized onto `IrregularLayoutScore::free_material_sliver_metric`, i.e. exactly the `portfolio.score.freeMaterialSliverMetric` field this finding names) instead of a strict-decoder tie-break field.

**Fix**: routed `polygon_perimeter` through `js_number::js_math::hypot`, matching `collinear_overlap_segment`'s established two-argument Node/V8-compatible implementation. Its current parity evidence is the committed 21,696-vector oracle generated by `scripts/rust-parity/dump-js-hypot.ts` and asserted by `tests/js_hypot_vectors.rs`. Per R21's compatibility-evidence mandate, every other `.hypot(`-style call site in the crate was also re-audited (not just this one) for reachability to any semantic field: a score, metric, comparator tie-break, or serialized result/trace value. That audit found and fixed additional under-scoped sites in `canonical_grid::contact` (`canonical_grid_edge_length_mm`, `canonical_grid_turn_cosine`, `polygon_edge_length`, `point_distance`, `convex_turn_cosine`, all feeding structural-contact signature strings and `near_complete_structural_contact_count`/`normalized_units`, which reach both `compare_local_scores` and serialized result DTOs) and `transforms::generator` (`derive_usable_edges`'s edge length feeds `compare_representative_significance`/`compare_output_order`'s tie-break subtraction; `derive_effective_transform_policy`'s `maximum_radius_mm` shapes the adaptive Compact policy's transform candidate set). Sites confirmed to have **no** reachable semantic field (Rust-only test assertions in `transforms::flattening`, and `validation::sat`'s test code, the latter doubly so since that whole module has zero production callers) were deliberately left on `std::f64::hypot`, each with its own doc comment recording why. See each function's own doc comment (`crates/irregular-nesting-native/src/search/layout_scorer.rs`, `src/canonical_grid/contact.rs`, `src/transforms/generator.rs`, `src/js_number/js_math.rs::hypot`) for the full per-call-site reachability chain.

**Result, independently re-verified**:
- `differential-fixture-matrix.ts --required-only`: **16/16** (both previously-affected rows, `shapes-17 2000x2700 short-side` and `mixed61 2000x2700 short-side`, now pass with no divergence at all, not merely a diagnostic-only one).
- `differential-fixture-matrix.ts --exploratory-only`: **8/8** (unaffected by this fix; already closed by N1, see that finding's own addendum above).
- `verify-mixed61-hash.ts` (Rust backend alone, both profiles) reproduces the acceptance-bar hashes exactly: Compact `fittedCanonicalSha256 = ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`; Compact Short Side `fittedCanonicalSha256 = 2a63c729108ba7680339cebaf86d4e39368a020eee95580caf9811d6d2bbc2ca` — byte-identical to this report's own "Acceptance bar" section above.
- `cargo test --release`: 710/710 passed (0 failed), including the `free_material_vectors`, `scorers_vectors`, and `canonical_layout_vectors` suites this fix's own call sites feed — no fixture regeneration was needed anywhere; every affected recorded vector value either already matched the Node/V8-compatible result or was within the suite's own pre-existing bounded tolerance, consistent with this fix only ever *removing* divergence from the TS oracle, never introducing new disagreement.

**Finding N2 is CLOSED.**

## Harness changes (this session)

`scripts/rust-parity/run-differential.ts` (new file, owned by this task per the migration prompt's `scripts/rust-parity/` convention) was extended with:
- `--sheet WIDTHxHEIGHT` — sheet override for any fixture (was previously fixed to the mixed61 fixture's baked-in 2000×2700).
- `--profile compact|short-side` — overrides `intrinsicObjectiveProfileId` the same way `scripts/irregular-compact-baseline.ts`'s own `--objective-profile` does (same field, same two values, same replace-only-that-field semantics).
- `--fixture triangle-20` / `--fixture shapes-17` — constructs the same synthetic/DXF-derived requests `scripts/irregular-compact-baseline.ts` does, reusing the same production helpers (`preparePieces`, `makePresetShapeDocument`, `importDxfFile`) rather than duplicating algorithm logic.
- `mixed61 --sheet ...` rebuilds the mixed-61 request at a different sheet the same way `scripts/irregular-compact-baseline.ts`'s own `mixed61Request` does (decode the fixture, replace only `sheet`/`jobId`), preserving the `--pieces N` truncation path unchanged when `--sheet` is not given.

New file `scripts/rust-parity/verify-mixed61-hash.ts`: a one-shot acceptance-bar verifier that runs the Rust backend **alone** (not diffed against TS) and prints both `collisionIdentitySha256` (an internal self-consistency hash) and `fittedCanonicalSha256` (the acceptance-bar hash, computed identically to `scripts/irregular-compact-baseline.ts`'s own `sha256CanonicalLayout`/`canonicalizeIrregularLayout`), so the acceptance bar can be checked directly against the native addon.

## Files changed (this session, Rust-side fixes only)

- `crates/irregular-nesting-native/src/archive/periodic_cells.rs` — Fix 1 (axis-union), Fix 2 (Arc-wrap `IntrinsicPeriodicBaseMember.piece`, `OrderedMap::get_or_insert_with`, `periodic_cell_front` grouping).
- `crates/irregular-nesting-native/src/archive/periodic_family.rs` — Fix 2 (witness-continuation grouping, same `get_or_insert_with`).
- `crates/irregular-nesting-native/src/capacity/preflight.rs` — Fix 3 (`IntrinsicCapacityProvenImpossibleReason::as_str`).
- `crates/irregular-nesting-native/src/capacity/search.rs` — Fix 3 (`IntrinsicCapacitySettlement::as_str`).
- `crates/irregular-nesting-native/src/result/coordinator.rs` — Fix 3 call sites.
- `scripts/rust-parity/run-differential.ts` — harness extension (new file this task; see above).
- `scripts/rust-parity/verify-mixed61-hash.ts` — new acceptance-bar verifier.
- `docs/planning/rust-irregular-backend/evidence/differential-e2e-report.md` — this report.

Other files showing as modified/untracked in `git status` at the start of and during this session (`crates/irregular-nesting-native/src/{lib.rs,boundary/**,caches/telemetry.rs,result/materialize.rs}`, `Cargo.toml`, `tests/coordinator_vectors.rs`, `package.json`, `scripts/smoke-run.mjs`, `src/shared/irregular/backendSelection.ts`, `src/workers/irregular/native/**`, TS backend-selection tests) were **not** touched by this task — they are concurrent work from the parallel orchestrator workflow, already present before this session's differential runs began (confirmed via file mtimes), and are included as-is in every build/test run reported above.

## Reproduction

```bash
export PATH="$HOME/.cargo/bin:$PATH"
node crates/irregular-nesting-native/scripts/build-native.mjs

# small subsets, both profiles
for n in 2 4 8; do
  for profile in compact short-side; do
    pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts \
      --fixture mixed61 --pieces "$n" --profile "$profile"
  done
done

# named baselines
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts --fixture triangle-20 --sheet 2000x2700
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts --fixture triangle-20 --sheet 2000x2700 --profile short-side
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts --fixture shapes-17 --sheet 2000x2700
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts --fixture shapes-17 --sheet 2000x2700 --profile short-side
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts --fixture mixed61 --sheet 600x400
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts --fixture mixed61 --sheet 600x400 --profile short-side
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts --fixture mixed61 --sheet 300x300
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts --fixture mixed61 --sheet 300x300 --profile short-side

# the big one, last
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts --fixture mixed61 --sheet 2000x2700
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/run-differential.ts --fixture mixed61 --sheet 2000x2700 --profile short-side

# acceptance-bar hash, Rust backend only
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/verify-mixed61-hash.ts --sheet 2000x2700 --profile compact

# gates
cd crates/irregular-nesting-native && cargo fmt --check && cargo clippy --all-targets --release -- -D warnings && cargo test --release && cd ../..
pnpm typecheck && pnpm lint && pnpm test:focused
pnpm gate:capacity:production
pnpm gate:mixed61-compact --output /tmp/e2e-sheet-invariance
```
