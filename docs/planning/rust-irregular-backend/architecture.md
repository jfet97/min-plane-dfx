# Rust Irregular Backend — Architecture

Status: **Stage 0 design document.** No production algorithm code exists yet.
This document describes the target architecture for the Rust port of the
Compact and Compact Short Side irregular-nesting backend and the staged plan
to get there. It does not claim any stage beyond Stage 1 scaffolding is
complete. Where the crate already contains scaffolding (`crates/irregular-nesting-native`,
committed at `dbcfec2`), this document describes that scaffolding as it is
today and states explicitly what is still design, not status.

Governing spec: `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
(hereafter "the migration prompt"), primarily §1 (non-negotiable objective),
§4 (scope boundaries), §21 (code quality / module boundaries), and the
cross-cutting rules in §2 (absolute semantic preservation), §8–9 (numeric and
key semantics), §13–14 (cache/parallelism boundaries) which this document
respects but does not re-derive. Source of truth for every behavioral claim
below is the Stage 0 characterization corpus:
`docs/planning/rust-irregular-backend/characterization/*.md`,
`docs/planning/rust-irregular-backend/js-semantics-audit.md`,
`docs/planning/rust-irregular-backend/baseline-evidence.md`, and
`docs/planning/rust-irregular-backend/performance-contract.md`. Every
scope/liveness claim in §3 below cites the specific characterization document
and, where available, the specific TS `file:line` that document already
verified — this document does not re-verify liveness independently.

Orchestrator decisions this document incorporates as fixed constraints (not
open questions):

- napi `3.12.0` / napi-derive `3.6.1` / napi-build `2.4.0`, including
  `ThreadsafeFunction` from background threads, verified working on the
  development machine; JS-visible names are camelCased.
- The Clipper2 strategy is **vendor-translating** the used subset of
  `clipper2-ts@2.0.1-18` (Core/Engine/Clipper/Offset; boolean ops
  Union/Difference/Intersection/Xor with EvenOdd+NonZero fill and PolyTree64
  output, plus Miter/Polygon offset) into Rust, pinned by differential
  vectors — not binding a different-version C++ Clipper2.
- The crate lives in the repository tree at `crates/irregular-nesting-native`
  alongside the pnpm workspace (§2.3 below records the precise, currently
  package-manager-agnostic, state of that integration and the one open
  question it leaves).
- Durable evidence lives in the repository, never only in `/tmp`.

---

## 1. Governing constraints (recap, not restatement)

Everything in this document is subordinate to the migration prompt's §2
absolute semantic preservation rule: the current TypeScript behavior,
including anything that looks unusual, is the specification. This document
never proposes an observable behavior change. Where a design choice below
affects something that could be observable (ordering, caching, error
mapping, cancellation), the choice is justified by a specific characterization
citation, not by what "seems reasonable" for a native port.

Three architectural non-negotiables from the prompt shape every section below:

1. **Coarse boundary, whole-job ownership** (prompt §1, §6 Stage 1, §7). The
   Rust backend must own the *entire* execution of one Compact or Compact
   Short Side job after one N-API call — preparation, geometry, caches,
   search, checkpoints, archive selection, Short Side construction, result
   materialization, diagnostics. Not a kernel-call collection.
2. **Two independent, selectable backends** (prompt §6 Stage 2, §17). The
   existing TypeScript irregular implementation remains a maintained
   reference/fallback/rollback backend forever, selectable independently of
   rectangular-vs-irregular algorithm choice.
3. **Staged, differential, single-thread-first delivery** (prompt §6). Full
   single-thread Rust parity must exist and be differentially verified before
   any Rayon parallelism is enabled.

---

## 2. Crate and workspace layout

### 2.1 Location and current scaffold

The crate lives at `crates/irregular-nesting-native` (napi-rs `cdylib`,
`Cargo.toml`). This is not a proposal — the directory, `Cargo.toml`, `lib.rs`,
`build.rs`, and one stub `mod.rs` per planned domain module already exist on
this branch (commit `dbcfec2`, "feat: irregular-nesting-native napi crate
skeleton with contained boundary"). What exists today is deliberately
minimal: `native_capability()` (a version/target-triple/profile descriptor,
non-semantic per prompt §7/§17) and `run_irregular_job(request_json: String)`
(a placeholder that always returns a structured `not_implemented` JSON
failure through the same panic-containment path every future entry point
will use). No algorithm code exists. This document specifies what the rest of
`src/` becomes over Stages 2–5, not what it is today.

```
crates/irregular-nesting-native/
  Cargo.toml            # napi 3 / napi-derive 3 / napi-build 2, cdylib
  build.rs               # napi_build::setup() + IRREGULAR_NATIVE_TARGET env
  rustfmt.toml
  npm/
    index.cjs             # CommonJS loader: require()s the platform .node file
    irregular-nesting-native.<platform>-<arch>.node   # build output, gitignored
  scripts/
    build-native.mjs      # `cargo build [--release]`, stages .node into npm/
  src/
    lib.rs                # napi entry points only (thin)
    boundary/mod.rs        # NativeError, contain_panics() — exists today
    archive/mod.rs         # stub -> see §3
    caches/mod.rs           # stub -> see §3
    canonical_grid/mod.rs    # stub -> see §3
    capacity/mod.rs           # stub -> see §3
    checkpoints/mod.rs         # stub -> see §3
    clipper/mod.rs               # stub -> see §3
    geometry/mod.rs                # stub -> see §3
    nfp_ifp/mod.rs                   # stub -> see §3
    result/mod.rs                     # stub -> see §3
    search/mod.rs                       # stub -> see §3
    short_side/mod.rs                     # stub -> see §3
    trace/mod.rs                            # stub -> see §3
    transforms/mod.rs                         # stub -> see §3
    validation/mod.rs                           # stub -> see §3
```

Two module names the prompt's §21 suggested-boundary list names that the
current scaffold does not have as top-level modules — `scheduler` and
`N-API entry points` — are addressed in §3.13 and §4.1 respectively: the
scheduler role is folded into `capacity` and `archive` (it is not a
standalone TS subsystem — see §3.6/§3.7), and N-API entry points remain thin
functions in `lib.rs` per prompt §21 ("keep the Rust architecture
understandable... prefer domain modules... not one enormous file", read
together with §7's "keep it small" — `lib.rs` is the boundary, not a domain
module, and stays small by delegating immediately into a `boundary::run_job`
orchestration function once one exists).

### 2.2 Dependencies

Current `Cargo.toml` (Stage 1):

```toml
[dependencies]
napi = { version = "3", default-features = false, features = ["napi8", "dyn-symbols"] }
napi-derive = "3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
num-bigint = "0.4"
ryu-js = "1"

[build-dependencies]
napi-build = "2"

[profile.release]
codegen-units = 1
lto = "thin"
overflow-checks = true   # release-mode integer overflow must never wrap silently (prompt §8.2)
```

Deliberate choices already made and to be preserved through later stages:

- `overflow-checks = true` in `[profile.release]` is a permanent policy, not
  a Stage-1-only setting: prompt §8.2 requires checked arithmetic and no
  silent release-mode wraparound for the entire migration.
- `num-bigint` is the exact-integer authority for canonical-grid arithmetic
  that TypeScript expresses with `BigInt` (`canonical-grid.md`,
  `js-semantics-audit.md` §"BigInt string round-tripping"). Coordinate/product
  bound analysis (prompt §8.2: "choose representations based on verified
  coordinate and product bounds") is Stage 2 work; `i128`/`i64` may replace
  `num-bigint` in hot paths once bounds are proved, with `num-bigint` kept
  only where TS itself falls back to arbitrary precision.
- `ryu-js` exists specifically to reproduce JavaScript `Number`-to-string
  rendering (used by canonical JSON/key numeric formatting, prompt §8.1/§9)
  rather than Rust's default float formatting, which differs from V8's in
  several corner cases (exponent thresholds, trailing-zero trimming).
- `sha2` is the canonical-hash authority (SHA-256 identities, prompt §2,
  "SHA-256 identities" is explicitly a preserved-exactly item).

Stage-3/4 additions, not yet in `Cargo.toml`, anticipated by this design:

- `rayon` — added only at Stage 4, per prompt §6 Stage 4 ("add Rayon only
  after exact one-thread parity"). Not present today by design.
- A concurrent-map crate (e.g. `dashmap`) or a hand-rolled sharded map — the
  actual choice is Stage 3 cache-design work (prompt §13.3's "required
  design evaluation") and is out of this document's scope; this document
  only reserves `caches/` as the module boundary that owns the decision.
- `robust`/`robust-predicates`-equivalent crate or a ported subset — needed
  to reproduce `robust-predicates@3.0.3` (`validation-spatial.md`), the
  unsnapped source-geometry decision authority prompt §8.3 requires kept
  separate from Clipper2's canonical-integer authority.

No Clipper2 Rust binding is added as an external dependency. Per the fixed
orchestrator decision above, `clipper/` vendor-translates the used subset of
`clipper2-ts@2.0.1-18` directly; this avoids the parity risk of binding a
different-version/different-language Clipper2 implementation that the
migration prompt's §8.3 explicitly warns against ("do not substitute a
geometrically reasonable but behaviorally different library").

### 2.3 pnpm / workspace integration — current state and open question

`pnpm-workspace.yaml` today declares no `packages:` globs and has no entry
naming `crates/*`; `crates/irregular-nesting-native` has no `package.json`.
The crate is *not* currently a pnpm workspace package in the JS sense — it is
a plain Rust crate that lives in the repository tree, built by
`node crates/irregular-nesting-native/scripts/build-native.mjs` (a direct
script per the migration prompt's "avoid a second large tooling framework"
guidance) and loaded via `npm/index.cjs`'s `require()` of the staged
`.node` file. `package.json`'s `postinstall`/`native:electron` scripts do not
yet invoke `build-native.mjs`; nothing in the JS build currently depends on
this crate.

This satisfies the orchestrator's decision (c) ("the crate lives in the pnpm
workspace as `crates/irregular-nesting-native`") in the sense of physical
location, but leaves open whether "lives in the pnpm workspace" additionally
requires a `package.json` + `pnpm-workspace.yaml` `packages:` entry so the
addon can be `import`ed as an ordinary workspace dependency (e.g.
`"irregular-nesting-native": "workspace:*"`) instead of a relative
`require()` of `npm/index.cjs`. §9 (open questions) records this as an
explicit Stage 1 decision point; this document's default recommendation,
consistent with "avoid unnecessary tooling," is to add a minimal
`package.json` (`name`, `main: "npm/index.cjs"`, a `build` script that shells
to `scripts/build-native.mjs`) and a `packages:` entry once a real TS
consumer needs to `import` it (Stage 2's differential harness), rather than
pre-emptively now.

### 2.4 Native artifact staging

`build.rs` runs `napi_build::setup()` and exposes `IRREGULAR_NATIVE_TARGET`
(Cargo's `TARGET`) to `lib.rs` at compile time, so `native_capability()`
reports the actual compiled target triple without a runtime probe.
`scripts/build-native.mjs` runs `cargo build [--release]` and copies the
resulting per-platform library (`libirregular_nesting_native.so` /
`.dylib` / `irregular_nesting_native.dll`) into
`npm/irregular-nesting-native.<platform>-<arch>.node`. `npm/index.cjs`
`require()`s that file by computed name and throws an actionable error
(with the exact build command) if it is missing — this is the "produce
actionable errors for missing or incompatible binaries" requirement (prompt
§20.2) already satisfied by the Stage 1 scaffold. Multi-platform prebuild
packaging (macOS arm64/x64, Windows x64, Linux x64 per prompt §20.1) and
ASAR-unpack / electron-builder configuration are Stage 5 work (§8.5 below);
Stage 1–4 development targets the host platform only (Linux x64 on the
reference machine, per `performance-contract.md` §1).

### 2.5 Module layout: top-level modules and their internal submodule plan

The 14 stub modules already scaffolded map one-to-one onto prompt §21's
suggested domain boundaries, with a few TS subsystems assigned to the
top-level module whose *responsibility*, not file name, matches best (detailed
justification per module in §3). Several top-level modules need internal
submodules to keep the "domain modules that mirror semantic responsibilities"
principle (prompt §21) once real algorithm code lands, because a handful of
TS files are individually 1,400–2,400 lines and cover more than one
responsibility. The planned internal layout (created incrementally as each
subsystem is ported in Stage 2, not all at once):

```
archive/
  mod.rs            # re-exports; job-facing entry points
  direct.rs          # intrinsicStrictDecoder.ts "E1" (complete/sheetless constructor)
  gap_regions.rs       # intrinsicGapRegions.ts
  family.rs              # intrinsicStrictFamilyPortfolio.ts
  periodic_cells.rs        # intrinsicPeriodicCells.ts
  periodic_family.rs         # intrinsicPeriodicFamilyPortfolio.ts
  reconstruction.rs            # intrinsicReconstructionPortfolio.ts (focused reconstruction)
  dedup_rank.rs                  # intrinsicAnytimeArchive.ts (shared archive primitive)
  shared_archive.rs                # intrinsicSharedArchivePortfolio.ts (direct+periodic orchestration)

capacity/
  mod.rs
  preflight.rs        # intrinsicCapacityPreflight.ts
  material.rs           # intrinsicCapacityMaterial.ts
  endpoint.rs             # intrinsicCapacityEndpoint.ts
  prefixes.rs               # intrinsicCapacityPrefixes.ts
  search.rs                   # intrinsicCapacitySearch.ts (beam engine)
  mode.rs                        # intrinsicCapacityMode.ts (lane orchestration: cold/warm-prefix/quality-warm-prefix)
  telemetry.rs                     # intrinsicCapacityTelemetry.ts (diagnostic only, non-authoritative)

checkpoints/
  mod.rs
  anytime.rs          # IntrinsicAnytimeCheckpoint (capacity/intrinsicCapacitySearch.ts)
  strict_direct.rs      # IntrinsicStrictDirectCheckpoint (archive/intrinsicStrictDecoder.ts)
  encoding.rs             # shared canonical-JSON/BigInt-string encode+hash helpers

canonical_grid/
  mod.rs
  math.rs             # canonicalGridMath.ts
  contact.rs            # canonicalGridContact.ts
  layout.rs               # canonicalLayoutGeometry.ts (keys, topology, legality, cavities, envelope)
  convex_contact.rs          # convexPolygonContact.ts
  free_material.rs             # freeMaterialService.ts

short_side/
  mod.rs
  axes.rs             # intrinsicShortSideAxes.ts
  observer.rs           # intrinsicShortSideObserver.ts (span measurement only — see §3.10)
  pair_fold.rs            # intrinsicShortSidePairFoldObserver.ts (authoritative construction)
  contact_strip.rs           # intrinsicShortSideContactStrip.ts

search/
  mod.rs
  beam_state.rs        # irregularBeamState.ts (canonical occupied-geometry keys — this is the live part)
  placement_scorer.rs    # irregularPlacementScorer.ts (value computation only — see §3.9)
  layout_scorer.rs         # irregularLayoutScorer.ts (value computation only — see §3.9)
  score_grid.rs               # irregularScoreGrid.ts
  sort_pieces.rs                 # sortPiecesForNesting.ts

nfp_ifp/
  mod.rs
  nfp_boundary.rs      # core/nfpBoundaryCore.ts
  ifp_bounds.rs          # core/ifpBoundsCore.ts
  candidates.rs            # nfpIfpService.ts (candidate generation/legality filtering)
  telemetry.rs                # nfpIfpTelemetry.ts (diagnostic only)

geometry/
  mod.rs
  collision_builder.rs   # collisionGeometryBuilder.ts
  arc_flattening.rs        # arcFlattening.ts
  ellipse_flattening.rs      # ellipseFlattening.ts
  convex_offset.rs              # convexPolygonOffset.ts (+ clipper2OffsetAdapter.ts/Policy.ts split with clipper/)

transforms/
  mod.rs
  generator.rs         # transformGenerator.ts (incl. adaptive Compact transform policy)
  collision_transform.rs # transformCollisionGeometryCore.ts / transformCollisionGeometry.ts

validation/
  mod.rs
  placement.rs         # placementValidation.ts
  spatial_index.rs        # placedCollisionSpatialIndex.ts
  predicates.rs              # geometryPredicates.ts, robust-predicates-equivalent
  sat.rs                        # convexSatPenetration.ts
  convex_validation.rs             # convexPolygonValidation.ts
  bounds.rs                          # convexBounds.ts
  convex_hull.rs                        # convexHullCore.ts

caches/
  mod.rs
  store.rs              # core/geometryCacheStore.ts + geometryCacheStoreLive.ts (job-scoped backing store)
  identity.rs              # core/geometryCacheIdentity.ts, geometryCacheKeys.ts
  nfp_key.rs                  # core/nfpCacheKey.ts

clipper/
  mod.rs
  core.rs               # vendored clipper2-ts Core.js subset
  engine.rs                # vendored clipper2-ts Engine.js subset
  boolean_ops.rs              # vendored Clipper.js boolean-op entry points
  offset.rs                      # vendored Offset.js (Miter/Polygon offset)
  policy.rs                         # clipper2OffsetPolicy.ts (toGridMm/fromGrid, offset parameters)

trace/
  mod.rs                # decision-trace machinery — see §3.14, currently scoped OUT for Compact/Short Side
  reveal.rs                # selectedLayoutRevealSnapshots equivalent (live — see §3.14)

result/
  mod.rs                # final IrregularComputeResult -> boundary DTO conversion
```

This layout is a plan, applied incrementally: a subsystem's submodule is
created in the same Stage-2 change that ports it, with a test and a
characterization citation, not pre-created empty. `boundary/` already exists
(§4.4) and needs no further split at this size.

---

## 3. Module map: TS subsystem → Rust module, with scope status

Every row cites the characterization document (and TS `file:line` where the
characterization document already gives one) that establishes liveness.
"PORT" means the subsystem is live on the production Compact and/or Compact
Short Side path and must be ported for Stage 2 parity. "EXCLUDED" means the
characterization corpus proves the subsystem is unreachable from the two
migrated profiles' production settings (dead, probe-only, or shadow-only),
so no Rust port is required for parity — porting it would not violate
semantics but is out of scope and must not be treated as a Stage 2 blocker.

### 3.1 `archive` — complete/sheetless construction and shared-archive ranking

| TS file | Rust submodule | Status | Evidence |
| --- | --- | --- | --- |
| `intrinsicStrictDecoder.ts` | `archive::direct` | **PORT** | `strict-decoder-gap-family.md` §1.1: "entirely live" — the E1 sheetless constructor, local scoring, family best-of selection, gap-contained candidates, Pareto ranking, `IntrinsicStrictDirectCheckpoint`. |
| `intrinsicGapRegions.ts` | `archive::gap_regions` | **PORT** | `strict-decoder-gap-family.md` §1.1: pure Clipper2-backed helper consumed only by the (live) strict decoder. |
| `intrinsicStrictFamilyPortfolio.ts` | `archive::family` | **PORT** | `strict-decoder-gap-family.md` §1.1: repeated-collision-family grouping consumed by the live decoder and periodic cluster. |
| `intrinsicPeriodicCells.ts` | `archive::periodic_cells` | **PORT** | `periodic.md` §1, `nfp-ifp.md` "Live-in-production trace": reachable via `intrinsicPeriodicFamilyPortfolio.ts` → `intrinsicSharedArchivePortfolio.ts` → `computeIrregularNesting.ts:483,529`. |
| `intrinsicPeriodicFamilyPortfolio.ts` | `archive::periodic_family` | **PORT** | `periodic.md` §1, same trace. |
| `intrinsicReconstructionPortfolio.ts` | `archive::reconstruction` | **PORT** | `reconstruction.md` §1.1: sole production caller `coordinateIntrinsicSharedArchive` (`computeIrregularNesting.ts:839-849`), `roleFamily: 'endpoint-q90-right-to-left'`, enabled by default (`focusedCompleteReconstructionControlArm !== 'disable'`). |
| `intrinsicPlaceDeferCompleteShadow.ts` | — | **EXCLUDED** | `reconstruction.md` §1.2, `worker-coordination.md` line 345: gated by `options.captureExperimentalPlaceDeferCompleteShadow`, which `nesting.worker.ts` never sets; only set `true` in `tests/unit/intrinsicCapacityMode.test.ts`. Named in the migration prompt's own §5 "Capacity" file map, but proven dead for the two migrated profiles — see open question §9.1. |
| `intrinsicSharedArchivePortfolio.ts` | `archive::shared_archive` | **PORT** | `shared-archive.md` §1: "Both files are live on the production Compact and Compact Short Side path." Orchestrates direct roles (`canonical-grid`, `legacy-absolute-envelope`, `open-pocket-first`) + periodic continuation, dedup, ranking. |
| `intrinsicAnytimeArchive.ts` | `archive::dedup_rank` | **PORT** | `shared-archive.md` §1: generic namespace-agnostic storage/dedup/rank primitive shared by `archive::shared_archive` and `capacity::mode`. |
| `intrinsicV7SeedArchive.ts`, `intrinsicComponentInterfaceClosure.ts`, `intrinsicDetachedPieceReinsertion.ts`, `intrinsicTwoPieceInterfaceReconstruction.ts`, `intrinsicGlobalSqueezePortfolio.ts`, `intrinsicSqueezeDisruptSeparate.ts`, `intrinsicTransformSeparator.ts`, `intrinsicExactProjection.ts`, `intrinsicQueueBeamDiscriminator.ts`, `intrinsicPeriodicSmallFillE3.ts` | — | **EXCLUDED** | `aux-modules-liveness.md` §0/§1.0: entire 18-file cluster unreachable from production Compact/Compact Short Side; zero production importers or flag-gated-false in required gates. |

### 3.2 `capacity` — partial (subset) placement search

All five files (`intrinsicCapacityPreflight.ts`, `intrinsicCapacityMaterial.ts`,
`intrinsicCapacityEndpoint.ts`, `intrinsicCapacitySearch.ts`,
`intrinsicCapacityPrefixes.ts`) are **PORT**: `capacity-core.md` §1
("unconditionally live whenever the production shared-archive path is
active — preflight always runs") and `capacity-search.md` §1 ("the empty-start
depth-synchronized beam search that produces the best-known exact partial
placement"). `intrinsicCapacityMode.ts` is **PORT** (lane orchestration:
cold, warm-prefix, protected quality-warm-prefix lanes, `capacity-search.md`
§2 call-site enumeration) with one internal exclusion: `runIntrinsicCapacityCohesionShadow`
(`intrinsicCapacityMode.ts:1077-1129`, `retentionMode: 'cohesion-frontier-shadow'`)
is **EXCLUDED** — `capacity-core.md` §1: "observer-only... never enters
`retainIntrinsicAnytimeArchiveNamespace`", gated by `input.captureCohesionShadow`,
never set by production. `intrinsicCapacityTelemetry.ts` is **PORT but
non-authoritative**: `capacity-search.md` classifies it as diagnostic-only
(gated by `captureCapacityShadowTelemetry`, never true in production per
`worker-coordination.md` line 343) — it is included in the module map because
its constants (`INTRINSIC_CAPACITY_NO_SKIP_PROBE_DEPTH`) are referenced by
name in prompt evidence, but its Stage 2 port is lower priority than the
authoritative lanes and MUST NOT be allowed to affect selection.

The beam width `16`, fanout `3`, per-depth quota `4,096`, and total cap
`max(50,000, pieceCount * 4,096)` cited in prompt §11 must be re-verified
against `intrinsicCapacitySearch.ts` at Stage 2 implementation time (prompt:
"Verify these values from current source before implementation. Source wins
if it changed") — `capacity-search.md` §1 additionally documents that
**production's actual retention comparator is not the plain objective
comparator these numbers might suggest**: the default `retentionMode` is
`'cohesion-frontier'`, which adds a 4th "contact" successor beyond the 3-wide
compactness fanout and retains the 16-wide beam via a 5-bucket
topology-stratified reservation (`retainCapacityCohesionFrontier`,
`intrinsicCapacitySearch.ts:1881-1964`), not a single top-16-by-objective
sort. This nuance must be preserved exactly, not simplified to "beam width
16 sorted by score."

### 3.3 `short_side` — Compact Short Side directional construction

All four files are **PORT**, with one important internal carve-out:

| TS file | Rust submodule | Status | Evidence |
| --- | --- | --- | --- |
| `intrinsicShortSideAxes.ts` | `short_side::axes` | **PORT** | `short-side.md` §1: called from both other production modules and the production gate script. |
| `intrinsicShortSideObserver.ts` | `short_side::observer` | **PORT, span-measurement fields only; its ranked winner is non-authoritative** | `short-side.md` §1: "its ranked archive endpoint... is never used to select the returned layout" — only `productionShortAxisSpanMm/…Grid` fields feed downstream logic; the winner only reaches a benchmark hook (`onIntrinsicShortSideObserverWinner`), never `selected`. |
| `intrinsicShortSidePairFoldObserver.ts` | `short_side::pair_fold` | **PORT, fully authoritative** | `short-side.md` §1: "Its accepted outcome, and only its accepted outcome, is materialized as the Short Side result." |
| `intrinsicShortSideContactStrip.ts` | `short_side::contact_strip` | **PORT** | `short-side.md` §1: called 3–5 times per Short Side request from inside the pair-fold observer. |

A real, source-verified branch must be reproduced exactly: when Compact
itself resolves through the "no archive eligible" path (i.e.
`settledCompleteArchiveForShortSideObserver` stays `undefined`), the entire
Short Side cluster is skipped even if the Short Side profile was requested,
and the request returns the plain capacity result unchanged (`short-side.md`
§1, final paragraph). This is a distinct terminal outcome from
`IrregularNoValidResultError` and must not be collapsed with it.

### 3.4 `search` — canonical state keys and score value computation

**Headline finding that reshapes this module's scope** (`search-scoring.md`,
stated up front there because it inverts a naive reading): the elaborate
score *comparators* in `irregularPlacementScorer.ts`
(`compareScores`, `balancedCompactnessOrder`, `shortSideFillOrder`,
`edgeContactThenBalancedCompactnessOrder`, `intrinsicCompactnessOrder`) and in
`irregularLayoutScorer.ts` (`layoutScoreOrder`, `strictLayoutScoreOrder`,
`scaleAwareLayoutScoreOrder`) are **not used to select anything** on the
production Compact/Compact Short Side path — they are exercised only by the
legacy `portfolioSearch.ts`/`windowedBeam.ts` beam search, itself unreachable
under the production default (`intrinsicSharedArchiveEnabled: true`,
`aux-modules-liveness.md` §1.1). What is live:

- `irregularBeamState.ts`'s canonical occupied-geometry key machinery — **PORT**,
  used pervasively for state dedup across the complete/capacity search.
- `irregularPlacementScorer.ts`'s pure `scoreCandidate` **value computation**
  (not its comparators) — **PORT**, called once per retained candidate inside
  capacity search to obtain `sharedCollisionBoundaryLengthMm`.
- `irregularLayoutScorer.ts`'s `scoreState` **value computation** (not its
  comparators) — **PORT**, called exactly once per completed job to build the
  externally-visible `IrregularLayoutScoreSummary`.
- `irregularScoreGrid.ts` — **PORT** (small shared value type/helper consumed
  by the above).
- `sortPiecesForNesting.ts` — **PORT**: produces `preparedPieces` order and
  `sortedPieceIds`, the priority order the entire pipeline runs against
  (`worker-coordination.md` §5/§6).
- The comparator functions themselves — **EXCLUDED** for the two migrated
  profiles (dead code on this path), but their *implementation* must still be
  read carefully at Stage 2 time in case a shared helper they call (e.g. a
  numeric normalization function) is also called from a live code path; do
  not port the comparators, but do not assume zero overlap without checking.
- `windowedBeam.ts`, `portfolioSearch.ts`, `priorityOrderService.ts`,
  `strictPriorityDecoder.ts` — **EXCLUDED**, `aux-modules-liveness.md` §1.0/§1.1/§1.2.

### 3.5 `nfp_ifp` — NFP/IFP construction and candidate generation

**PORT**, all of `nfpIfpService.ts`, `core/nfpBoundaryCore.ts`,
`core/ifpBoundsCore.ts` — `nfp-ifp.md` §1 conclusion: "all live on the
production Compact and Compact Short Side path." `nfpIfpTelemetry.ts` is
**PORT but semantically inert** (opt-in diagnostic counters only, `nfp-ifp.md`
§1 conclusion) — needed only for the non-semantic diagnostic channel (§4.5),
never for control flow.

Within `nfpIfpService.ts`, only the `'vertex-pair-hull'` NFP construction
algorithm and `'indexed'` candidate-pruning mode are reachable in production
(`nfp-ifp.md` "Live-in-production trace": "Neither call site overrides
`constructionAlgorithm` or `candidatePruningMode`"). The `'linear-edge-merge'`
algorithm and `'reference'` pruning mode are real, tested, differential-oracle
code paths in TS itself but have zero production callers — **EXCLUDED from
the Rust port's parity obligation** (porting them is not required for Stage 2
promotion; if ported at all, it must be flagged non-authoritative until a
production caller exists).

The public `computeIfpBounds` Effect wrapper and its
`IrregularGeometryInfeasibleError` failure channel have **zero production
call sites** (`nfp-ifp.md` "Live-in-production trace"); production uses the
internal synchronous bypass (`resolveIfpBoundsFromServiceStore` /
`resolveIfpBounds`) exclusively, and silently treats "infeasible" as "zero
candidates for this piece/transform," never as an error. The Rust port's
`nfp_ifp::ifp_bounds` module must reproduce the synchronous-bypass behavior
as the only production path; `IrregularGeometryInfeasibleError` never needs
an `AppErrorCode` mapping for this reason (confirmed independently by
`errors-protocol.md` row 3: "Dead").

### 3.6/3.7 `canonical_grid` — exact geometry bedrock

**PORT**, all five files: `canonicalGridMath.ts`, `canonicalGridContact.ts`,
`canonicalLayoutGeometry.ts`, `convexPolygonContact.ts`,
`freeMaterialService.ts` — `canonical-grid.md` §1: "every other cluster that
computes canonical identity, legality, cavities, envelope, or contact
ultimately calls into these five files." This is the numeric/geometric
bedrock the migration prompt names by name in §8.2–8.3. `canonicalLayoutGeometry.ts`
(888 lines, the most widely depended-on file in the whole irregular tree per
`canonical-grid.md` §1) is assigned to `canonical_grid::layout` rather than a
separate top-level module because its responsibility — exact canonical
identity, topology, legality, cavity, and envelope measurement — is
definitionally the same "canonical comparisons are exact" bedrock role as
`canonicalGridMath.ts`, not a different domain; splitting it into its own
top-level module would fragment one coherent exactness authority the prompt
treats as one thing (§8.3).

### 3.8 `validation` — legality, spatial index, robust predicates

**PORT**, all eight files: `placementValidation.ts`,
`placedCollisionSpatialIndex.ts`, `geometryPredicates.ts`,
`convexSatPenetration.ts`, `convexPolygonValidation.ts`, `convexBounds.ts`,
`convexHull.ts`, `core/convexHullCore.ts` (`validation-spatial.md` §1 scope
list; every file traced as a direct or one-hop caller of the live
`nfpIfpService.ts`/`irregularBeamState.ts`/collision-prep production path).

### 3.9 `geometry` and `transforms` — collision-geometry preparation

**PORT**, `collisionGeometryBuilder.ts`, `transformGenerator.ts` (including
the adaptive Compact transform policy), `arcFlattening.ts`,
`ellipseFlattening.ts`, `convexPolygonOffset.ts` — `collision-prep.md` scope
list; these run once per prepared piece for every request and are named
explicitly in prompt §4.1 ("curve flattening behavior," "conservative padding
and offset behavior," "adaptive Compact transform policy"). `clipper2OffsetAdapter.ts`
and `clipper2OffsetPolicy.ts` are split across `geometry`/`transforms`
(policy/parameter logic) and `clipper` (the vendored Clipper2 boolean-op/offset
engine itself) per §2.5's submodule table — `clipper2OffsetPolicy.ts`'s
`toGridMm`/`fromGrid` grid-conversion functions in particular are shared
utility functions called from many clusters (canonical-grid.md, short-side.md
§7.1, others) and belong with the grid-conversion policy, not the Clipper2
engine internals.

### 3.10 `caches` — geometry cache identity and storage

**PORT**, all files in `geometry-caches.md`'s scope
(`core/nfpCacheKey.ts`, `core/geometryCacheIdentity.ts`,
`core/geometryCacheStore.ts`, `geometryCacheKeys.ts`,
`geometryCacheStoreLive.ts`, `core/transformCollisionGeometryCore.ts`,
`transformCollisionGeometry.ts`). `geometry-caches.md` §1 and
`effect-boundary.md` §9.3 independently prove (one by static analysis, one by
a live runtime probe against the real Effect layer graph) that production
shares **exactly one cache instance per job** across piece preparation and
search. The Rust equivalent is one `Arc<GeometryCacheStore>` (or equivalent
job-owned shared handle) constructed once per job and threaded into every
consumer's constructor — `effect-boundary.md` §9.3 explicitly warns that "any
Rust-port refactor that turns [this] construction into a factory function
invoked at each... call site... would silently break this sharing." This
document reserves that constraint as a hard Stage 2 requirement; the detailed
concurrent-access policy (sharding, single-flight, front-caches) is Stage 3
work per the prompt's own required-artifact list (§4, "a cache and
concurrency design document") and is deliberately not decided in this
document.

The measured NFP cache hit rate this design must preserve the *reuse
characteristics* of (not the literal counts, which vary per fixture) is
~98.2% on Mixed-61 (`geometry-caches.md` §1 performance context,
`baseline-evidence.md`); this is why prompt §13 requires cache design before
parallelization — recomputing a 98%-hit-rate cache in Rust would erase the
speedup even with a faster geometry kernel.

### 3.11 `checkpoints` — resumable checkpoint state

**PORT**, two live producers, one dead producer:

- `IntrinsicAnytimeCheckpoint` (`intrinsicCapacitySearch.ts`, version
  `intrinsic-anytime-checkpoint-v3`) — **PORT**, `checkpoint-encoding.md` item 1.
- `IntrinsicStrictDirectCheckpoint` (`intrinsicStrictDecoder.ts`, version
  `intrinsic-strict-direct-checkpoint-v1`) — **PORT**, `checkpoint-encoding.md` item 2.
- `IntrinsicPlaceDeferCheckpoint` (`intrinsicPlaceDeferCompleteShadow.ts`,
  version `intrinsic-place-defer-checkpoint-v1`) — **EXCLUDED** per §3.1's
  finding that the whole producer file is dead in production
  (`checkpoint-encoding.md` item 3 cross-references the same dead-in-production
  status `reconstruction.md` §1.2 establishes).

Both live checkpoint formats require an injected deterministic clock seam for
byte-level differential testing (prompt §11) — this is a Stage 2 test-harness
requirement, not a production behavior change; production checkpoints still
use real-clock timing fields, compared as measurements, never as parity
fields, per prompt §11's exact rule.

### 3.12 `trace` and `result` — output materialization

This is the module boundary with the most important scope-narrowing finding
in the whole map, and it splits one prompt-named file group into two very
different obligations:

- **Decision-trace event stream** (`decisionTrace.ts`, `decisionTraceNdjson.ts`)
  — **EXCLUDED from Stage 2 Rust *emission* obligation, but its empty-output
  contract must be preserved by the TypeScript wrapper.** `worker-coordination.md`
  §1: `emitDecisionTrace` is accepted by `computeIrregularNesting` but "never
  invoked" on the Compact/Compact-Short-Side (archive) path — the only
  forwarding site is inside `runSingleSheetPortfolio`, the legacy
  windowed-beam/GA branch (`aux-modules-liveness.md` §1.1). For these two
  profiles, `decisionTraceEventCount` is always `0` and the
  `.decision-trace.ndjson` file is always created empty. The Rust job must
  **not** emit decision-trace events for Compact/Compact Short Side (doing so
  would be a new, unauthorized observable behavior); the empty-file/zero-count
  contract stays a TypeScript-side (`nesting.worker.ts`) responsibility,
  unaffected by which backend ran.
- **Selected-layout reveal snapshots** (`selectedLayoutRevealSnapshots`,
  `computeIrregularNesting.ts:1659-1681`) — **PORT**, into `result::reveal`.
  `trace-history.md` line 153: "Compact and Compact Short Side both call
  `selectedLayoutRevealSnapshots`." This is the data the prompt's §4.1 scope
  item "selected-layout reveal data needed by TypeScript history persistence"
  refers to. It is produced by the coordinator (which becomes Rust job logic),
  not by `sharedArchiveHistory.ts`.
- `src/renderer/utils/sharedArchiveHistory.ts` (`expandSharedArchiveSelectedLayoutReveal`)
  — **stays entirely in TypeScript, not part of the N-API boundary at all.**
  `trace-history.md` line 286: "No caller in `src/main/` or `src/workers/` —
  purely renderer-side." This file consumes already-serialized history
  frames the worker already sent over the wire; it never touches the native
  boundary and needs no Rust equivalent under any stage.
- `src/main/services/RunHistoryArchiveService.ts` — **stays entirely in
  TypeScript.** Main-process file-deletion service, unrelated to nesting
  computation; not named in prompt §4.1 and confirmed out of the native
  boundary by `trace-history.md`'s own scope note.
- `irregularWorkerOutput.ts` (`makeIrregularHistoryFrame`, `makeIrregularWorkerOutput`)
  — **stays in TypeScript** (§5 below); Rust's `result` module produces the
  boundary DTO these functions consume, but the functions themselves are the
  "map to existing worker protocol" step the prompt explicitly keeps outside
  the coarse native call (prompt §7: "TypeScript maps it to existing worker
  protocol and persistence").

### 3.13 Scheduler role — folded into `archive`/`capacity`, not a standalone module

The migration prompt's §21 suggested list names "scheduler" as a boundary.
Characterization shows no standalone TS "scheduler" file — the anytime
scheduler chronology (`intrinsicAnytimeSchedulerTrace`, cold-quantum
checkpointing, `worker-coordination.md` §4) is orchestration logic living
inside `computeIrregularNesting.ts`'s `coordinateIntrinsicSharedArchive`,
consuming `capacity::mode`'s lane primitives. This document does not invent a
`scheduler` top-level module to avoid "one-to-one mechanical copies with no
coherent ownership" in the opposite direction (creating a module with no TS
counterpart); the scheduler's *logic* is ported as part of the job
orchestration function in `boundary`/`lib.rs` (§4.1), calling into
`archive`/`capacity` in the same sequential order `coordinateIntrinsicSharedArchive`
uses today (`worker-coordination.md` §13: "this cluster is the wrong place to
look for Rayon wins... a thin, deterministic, single-threaded orchestrator").

### 3.14 `worker-coordination` cluster files — orchestration split between Rust and TS

| TS file | Rust counterpart | TS counterpart (stays) |
| --- | --- | --- |
| `computeIrregularNesting.ts`'s `coordinateIntrinsicSharedArchive` (the archive-eligible branch, `:483,504-1240`) | Ported as the top-level job orchestration function (§4.1) | — |
| `computeIrregularNesting.ts`'s piece-preparation loop (`:389-431`) | `geometry`/`transforms` (§3.9), called from job orchestration | — |
| `computeIrregularNesting.ts`'s legacy non-archive `else` branch (`runSingleSheetPortfolio`, `:1065-1069`) | **EXCLUDED** — `worker-coordination.md` §1: reachable only for non-shipped legacy settings, not part of Compact/Compact Short Side | stays TS, unmodified, unreachable by the Rust job's DTO (see open question §9.2) |
| `nesting.worker.ts` (RPC server, progress/history file writing, error-tag mapping) | — | **stays TS** entirely; wraps the one coarse native call |
| `irregularWorkerOutput.ts` | — | **stays TS** entirely (§3.12) |
| `src/shared/protocol/worker.ts`, `errors.ts` | Mirrored by `boundary`'s `NativeError`/DTO shapes, not literally shared code | **stays TS** (wire schema) |

---

## 4. Ownership boundary

### 4.1 The coarse N-API call

Per prompt §1/§6 Stage 1/§7, the production path is:

```
TypeScript nesting worker (nesting.worker.ts)
  -> validate + normalize request (existing Effect Schema, unchanged)
  -> build one trusted request DTO (NestingRequest + resolved GeometrySettings)
  -> ONE native call: run_compact_job(...) or run_compact_short_side_job(...)
       (or one profile-discriminated entry point — see open question §9.3)
  -> Rust owns: piece prep, geometry, caches, NFP/IFP, search, checkpoints,
     archive selection, capacity fallback, focused reconstruction,
     Short Side construction (if requested), result + reveal-snapshot
     materialization, diagnostics
  -> one structured success DTO or one structured failure DTO returned
  -> TypeScript maps the DTO to NestingResult / IrregularHistoryFrame via the
     unmodified irregularWorkerOutput.ts, and to WorkerResponse via the
     unmodified nesting.worker.ts error-mapping table
```

`lib.rs` stays thin: each `#[napi]` function decodes its typed arguments,
calls `boundary::run_job(...)` (a plain Rust function, not itself `#[napi]`,
so it is directly unit-testable without an N-API runtime), and encodes the
result. `boundary::run_job` is the one place per profile that owns:
constructing the job's shared state (§4.2), running the ported orchestration
sequence from `coordinateIntrinsicSharedArchive` (§3.13), and handing back a
DTO. This mirrors prompt §7's "prefer plain owned transfer objects at the
boundary" and keeps every panic-containment/error-mapping concern in one
place (`boundary`, which already exists — §2.1).

The exact request/response DTO schema (field-by-field, optional-presence
rules, versioning) is the separate "native boundary schema document" prompt
§22 requires as artifact #3; this document commits only to the shape above
and the principle that the DTO is a plain owned struct, not a JS-object
reference, converted immediately into strongly typed Rust domain structures
per prompt §7 ("avoid `serde_json::Value` as the internal algorithm model").

### 4.2 Job lifecycle and state ownership

One `boundary::run_job` call owns exactly:

- One `Arc<GeometryCacheStore>` (§3.10), constructed fresh, dropped at job
  end — job-local by default per prompt §13.6, matching the current
  TS behavior (`effect-boundary.md` §9.3: one cache instance per job).
- One prepared-piece vector (stable order from `sortPiecesForNesting`
  equivalent), immutable after construction, shared by `Arc` where geometry
  is reused across search branches (prompt §7: "share immutable prepared
  geometry inside Rust using `Arc` where it materially reduces copying").
- One job-owned Rayon thread pool (`rayon::ThreadPoolBuilder`), only from
  Stage 4 onward — not the global Rayon pool, per prompt §14.4 ("consider a
  job-owned Rayon pool... that prevents unrelated native work from
  unexpectedly sharing one unconstrained global pool"). Stage 1–3 code runs
  with an effective Rayon thread count of one and does not construct a pool
  at all.
- Checkpoint state (§3.11) and archive/capacity search state (§3.1/§3.2),
  all owned by the job, never shared across jobs or persisted beyond the
  job's own resumable-checkpoint DTO.

No N-API `Env` handle, and no JavaScript value, is retained past the initial
argument decode. No Rayon worker (once introduced in Stage 4) ever touches
N-API or calls into JavaScript, per prompt §7/§14.2.

### 4.3 Cancellation and deadline contract

This is the one place characterization overturned a naive reading of the
migration prompt, and the architecture must follow the *proven* production
mechanism, not the prompt's more elaborate-sounding cooperative-checkpoint
framing. `worker-coordination.md` §10 (confirmed by `errors-protocol.md` row 6):

- **Production cancellation and timeout today are a whole-process kill.**
  `WorkerSupervisor.cancelJob`/its `setTimeout` handler both call
  `teardownWorker`, which disposes the `ManagedRuntime` wrapping the RPC
  client — this terminates the entire Node `worker_thread` mid-computation,
  with no cooperative signal sent into the algorithm first. `nesting.worker.ts`
  never sets `ComputeIrregularNestingOptions.isCancelled`, so the *internal*
  `IrregularNfpIfpControlAbortError`/`control` checkpoint mechanism that
  `computeIrregularNesting.ts` and its callees implement is **inert in
  production** — real today only inside test harnesses and gate scripts that
  construct their own `control`.
- The one exception: `intrinsicStrictDecoder.ts`'s own internal wall-clock
  deadline (`reason: 'deadline'`, line 481) fires from its own timer, not from
  an externally-supplied `control`, and *is* live and reaches the top
  (`errors-protocol.md` row 6).

Architecture consequence: the Rust N-API job's cancellation contract must
match **today's actual production mechanism** — an externally triggered hard
abort of the whole native job process/thread, no partial result, no
in-band checkpoint-driven interruption from the worker's perspective — while
still internally implementing `intrinsicStrictDecoder`'s own live wall-clock
deadline exactly as today (a job-local timer, not an externally supplied
signal). The cooperative `isCancelled`/`control` plumbing that other
subsystems (`preflightIntrinsicCompleteCapacity`, `runIntrinsicCapacityMode`,
`runIntrinsicSharedArchivePortfolio`, `runIntrinsicReconstructionPortfolio`)
already implement in TS stays ported **for test/differential-harness parity
only** (so Rust unit/gate tests that pass their own control object behave
identically to the TS equivalents), not because production wires it today.
Whether a future, explicitly-flagged change should *newly* wire real
cooperative cancellation into the production worker path is out of this
document's scope — prompt §2's "absolute preservation" framing would treat
that as a new capability, not a port, and it is recorded as an open question
(§9.4) rather than decided here.

An async native job handle (prompt §7: "optional explicit cancellation
handle if an async-thread-safe mechanism is required") is therefore **not
required for semantic parity** at Stage 2 — a single synchronous (from
N-API's perspective, `napi::bindgen_prelude::AsyncTask`-wrapped so it does not
block the Node event loop) call that runs to completion or is killed
externally by the existing `WorkerSupervisor` mechanism reproduces today's
contract exactly. If a future stage adds real in-band cancellation as an
explicitly-flagged new capability, it must not change any accepted output,
partial-result rule, or error classification for the unmodified path.

### 4.4 Panic containment and error mapping

Already implemented in `boundary::contain_panics`/`NativeError` (§2.1's
exact code is current, not aspirational). Every `#[napi]` entry point routes
its body through `contain_panics`; any unwinding panic becomes a
`NativeError { category: "unknown", operation, message: "contained panic: ..." }`
with the payload sanitized to only the two safe-to-display `panic!` shapes
(`&'static str`/`String`), matching prompt §16's "sanitize panic details...
do not expose raw panic payloads." `boundary::run_job`'s typed error enum
(Stage 2 work) maps many-to-one into `NativeError.category`, which the
TypeScript boundary then maps into the existing external `AppErrorCode`
protocol using the table `errors-protocol.md` and the migration prompt §16
both already fully specify (reproduced there; not duplicated here). Two
category values this document commits to matching the prompt's fixed table
exactly:

- Deterministic evaluation caps, memory caps, trace caps, pauses, and
  censoring remain internal result/trace **statuses**, never promoted to
  `NativeError`/external error codes (prompt §16, final paragraph).
- `IrregularPortfolioError` with category `'search'` maps to
  `irregular_scoring_error`, not `irregular_geometry_invalid` — the "unusual"
  mapping prompt §16's table calls out explicitly and `errors-protocol.md`
  row 4 confirms is real, current, load-bearing TS behavior on the shared-archive
  path (all three live construction sites use `category: 'search'`).

### 4.5 Diagnostics channel

`native_capability()` (already implemented) is the template for every future
non-semantic diagnostic surface: backend identity, Rust crate version, target
triple, thread count, cache policy identity, and cache telemetry counters
(prompt §13.7) live in a field explicitly separate from the job's result DTO,
never merged into it, never hashed, never persisted into `NestingOptions`,
sub-run settings, checkpoints, history frames, or decision traces (prompt
§7/§13.7/§17). The `result` module's success DTO and this diagnostic sidecar
are two distinct top-level return fields from `boundary::run_job`, kept
structurally separate (not merely "conventionally excluded by the caller")
so a differential-parity comparison can exclude the whole diagnostic
channel *by construction*, per prompt §17's requirement ("exclude that
entire diagnostic channel by construction rather than removing individual
differing fields after a mismatch").

---

## 5. What stays in TypeScript

Per prompt §4.2 and confirmed file-by-file by the characterization corpus:

1. **The entire rectangular nesting algorithm** — `src/workers/algorithm/maxRects/*`,
   `src/workers/algorithm/beam/*` (generic scaffolding shared with rectangular,
   confirmed by `js-semantics-audit.md` §1: irregular routes through
   `windowedBeam.ts`'s own machinery, not `beam/state.ts`). Never touched by
   this migration.
2. **Electron orchestration, IPC, worker supervision, request decoding,
   application lifecycle** — `src/main/services/WorkerSupervisor.ts`,
   `src/main/ipc/handlers.ts`, `nesting.worker.ts`'s RPC server shell, schema
   validation (`src/shared/schemas/nestingSchemas.ts`). The coarse native call
   sits *inside* `computeIrregularWorkerResult`, replacing
   `computeIrregularNesting`'s archive-eligible branch, not any of this
   surrounding shell.
3. **The existing TypeScript irregular implementation, in full**, as the
   permanent reference/differential-oracle/fallback/rollback backend (prompt
   §1, §17). No TS irregular file is deleted, and no TS irregular file's
   observable behavior changes as a result of this migration (prompt §3: byte-
   and hash-identical existing tests/fixtures).
4. **`irregularWorkerOutput.ts`** — the worker-protocol/history-frame mapping
   step, explicitly kept outside the coarse native call by prompt §7 ("TypeScript
   maps it to existing worker protocol and persistence").
5. **`src/renderer/utils/sharedArchiveHistory.ts`,
   `src/main/services/RunHistoryArchiveService.ts`** — proven to have zero
   worker/native callers (`trace-history.md` line 286 and scope note); not
   part of the boundary under any stage.
6. **Decision-trace emission for the legacy non-archive path** (`decisionTrace.ts`,
   `decisionTraceNdjson.ts`, `windowedBeam.ts`'s own event construction) — this
   machinery is dead for Compact/Compact Short Side (§3.12) and lives entirely
   inside the excluded legacy branch, which itself stays TS.
7. **The 18-file `aux-modules-liveness.md` cluster** and the excluded files
   named per-module in §3 (`intrinsicPlaceDeferCompleteShadow.ts`,
   `runIntrinsicCapacityCohesionShadow`, the score comparators in
   `irregularPlacementScorer.ts`/`irregularLayoutScorer.ts`,
   `strictPriorityDecoder.ts`) — unreachable from the two migrated profiles;
   remain wherever they currently live, unmodified.

---

## 6. Two-backend selector design

Per prompt §17: backend selection is independent of rectangle-vs-irregular
algorithm selection (`workerMode` stays untouched), must not enter persisted
`NestingOptions` or sub-run settings, must be resolvable before algorithm
execution, and must never silently fall back mid-job.

Design:

- A new, non-persisted worker execution option (working name
  `irregularBackend: 'typescript' | 'rust'`, resolved by
  `computeIrregularWorkerResult` before calling either
  `computeIrregularNesting` or the new native entry point) — **not** a field
  on `IrregularNestingSettings`/`GeometrySettings` (those are the persisted,
  hashed, canonical-affecting settings object; adding backend identity there
  would violate prompt §17's "would change result parity and saved-job
  semantics").
- Resolution order (highest priority first), all resolved once per job before
  any algorithm code runs: (1) an explicit per-request test/harness override
  (used by differential mode and gate scripts), (2) a process-level
  environment/config override for controlled rollout (e.g.
  `IRREGULAR_BACKEND=rust`), (3) a compiled-in default. The compiled-in
  default stays `'typescript'` until Stage 5 promotion criteria (prompt §19.3,
  the preregistered `performance-contract.md` thresholds) are met and the
  orchestrator explicitly flips it — this document does not itself authorize
  that flip.
- If `irregularBackend === 'rust'` and the native addon fails to load
  (missing/incompatible binary), the resolved capability check happens
  **before** the job starts; policy may fall back to TypeScript at that
  point only (prompt §17: "an unavailable addon may fall back before
  execution if policy permits"). Once a Rust job has actually started, no
  silent fallback to TypeScript is permitted (prompt §17: "no silent fallback
  after Rust has begun a job... cancellation and deadline must not trigger a
  TypeScript retry... native semantic errors must not trigger an automatic
  TypeScript retry").
- `native_capability()` (already implemented, §2.1) is the load-time probe
  this resolution step calls to decide "addon available."
- Every gate/harness invocation prints which backend actually executed
  (prompt §17, final paragraph); a test that requested Rust and silently got
  TypeScript must fail, not pass quietly.

This selector's exact TypeScript call-site wiring (where inside
`computeIrregularWorkerResult` the branch happens, and the exact shape of the
override mechanism) is Stage 1/2 implementation work; this document commits
to the resolution-order and persistence-boundary rules above, which are
already fully determined by prompt §17 and do not need further design
before implementation starts.

---

## 7. Differential mode

Per prompt §6 Stage 2 and §18.3: differential mode runs the same validated
request through both backends and compares exact outputs; it is not a
production default and must not run two full backends concurrently in normal
application use.

- Differential mode is a test/harness-only execution path, selected via the
  same non-persisted mechanism as §6 (an explicit test option, never a
  production default), consistent with prompt §17 ("development can run
  differential mode... production rollout can select Rust... independently").
- One differential run executes TypeScript's `computeIrregularNesting` and
  the Rust `boundary::run_job` **sequentially**, not concurrently, against
  byte-identical request input, then compares:
  - complete result object (placed/unplaced IDs, transforms, coordinates,
    canonical collision/fitted-canonical hashes, canonical keys)
  - score summaries, archive entries/order, capacity endpoints
  - scheduler trace, lane trace, ledgers, evaluation counts
  - checkpoint bytes/hashes under an identical injected deterministic clock
    (§3.11) — production-clock checkpoints compared structurally, with timing
    fields excluded as measurements, per prompt §11
  - error category and stable context, cancellation category
  - protocol-visible progress event sequence (count, phase order,
    completed/total work, best-score payloads, optional-field presence)
  - selected-layout reveal sequence (`result::reveal`, §3.12)
  - decision-trace event **count**, which must be `0` for both backends on
    the Compact/Compact Short Side profiles (§3.12) — this is itself a parity
    assertion, not something excluded from comparison.
- The diagnostic channel (§4.5) is excluded from every comparison **by
  construction** — it is never part of either backend's result DTO, so there
  is nothing to strip post hoc (prompt §17/§18.3).
- A mismatch is a Stage 2 stop condition (prompt §24): "write the smallest
  differential reproduction and fix the Rust implementation. Do not update
  accepted artifacts."

The concrete harness (a new `pnpm`-aliased script or an addition to the
existing gate scripts, exact fixture set, exact comparison-projection code)
is Stage 1/2 implementation work layered on top of this design; the
comparison-field list above is fixed by the prompt and this document commits
to it now so Stage 2 does not have to re-derive it.

---

## 8. Staged migration plan

This restates prompt §6's five stages with per-stage deliverables and
validation, concretized against this document's module map and the current
scaffold state.

### Stage 1 — Native package and coarse boundary (in progress)

**Delivered already:** crate skeleton, `Cargo.toml`, `build.rs`, `npm/`
loader, `scripts/build-native.mjs`, `boundary::{NativeError, contain_panics}`,
`native_capability()`, a placeholder `run_irregular_job` proving the
panic-containment path.

**Remaining Stage 1 deliverables:**

- The typed request/response DTO layer (prompt §7) replacing today's
  placeholder `String` JSON round-trip in `run_irregular_job` — one
  `#[napi(object)]` request struct per profile (or one profile-discriminated
  request), decoded immediately into internal domain structs (no
  `serde_json::Value` internally).
- Two (or one profile-discriminated) `#[napi]` entry points:
  `run_compact_job` / `run_compact_short_side_job`, both routed through
  `boundary::run_job` (§4.1), both currently returning `not_implemented`
  (Stage 1) or a real result only once the corresponding Stage 2 subsystem
  lands.
- The TypeScript-side backend selector (§6) wired into
  `computeIrregularWorkerResult`, defaulting to `'typescript'`, with an
  explicit override for tests.
- The differential-mode harness skeleton (§7), runnable even while Rust
  always returns `not_implemented` (it should fail loudly and clearly at that
  stage, proving the harness itself works before there is anything real to
  compare).
- A decision on the pnpm-workspace `package.json` question (§2.3 open
  question), made and recorded, before the differential harness needs to
  `import`/`require` the addon from TypeScript.

**Validation:** `native_capability()` and `run_irregular_job` unit tests pass
(already true); the differential harness runs end-to-end and reports "Rust:
not_implemented" without crashing; no existing test, gate, or fixture changes
(prompt §3).

### Stage 2 — Complete single-thread Rust parity

Ported in dependency order (lower layers first, matching §3's module
ownership), each subsystem landing with: a focused Rust unit test suite
(prompt §18.2's list), a differential test against the corresponding TS
subsystem's characterized behavior, and an update to a running parity matrix
(prompt §22 artifact #10) tracking which TS file is ported, tested, and
differentially verified. Suggested order, each stage gated on the previous:

1. `canonical_grid`, `validation` — the exactness bedrock everything else
   calls (§3.6–3.8). No search logic yet; pure geometry/predicate parity.
2. `caches`, `clipper` — the vendored Clipper2 subset (differentially pinned
   against `clipper2-ts@2.0.1-18` per fixed vectors, per the orchestrator's
   Clipper2 decision), and the one-shared-cache-per-job store (§3.10).
3. `geometry`, `transforms` — collision-geometry preparation, curve
   flattening, offset, adaptive transform policy (§3.9).
4. `nfp_ifp` — NFP/IFP construction and candidate generation (§3.5), now that
   its geometry and cache dependencies exist.
5. `search` (canonical keys + score value computation only, §3.4) and
   `checkpoints` (§3.11).
6. `archive` (direct E1 constructor, gap regions, family grouping, periodic
   cells/family, reconstruction, dedup/rank, shared-archive orchestration —
   §3.1) — the largest single subsystem; land its submodules in the same
   dependency order they appear in §2.5's table.
7. `capacity` (preflight, material, endpoint, prefixes, search, mode — §3.2).
8. `short_side` (§3.3), which depends on a settled Compact placed/unplaced
   partition from steps 6–7.
9. `result`/`trace::reveal` (§3.12) and the full job orchestration function
   in `boundary` (§4.1/§3.13), completing the coarse entry point.

**This stage is not complete until Rust owns the entire Compact and Compact
Short Side path and passes exact differential comparison against
TypeScript** (prompt §6 Stage 2) — a partial port that only handles NFP/IFP
or canonical keys does not satisfy Stage 2, per prompt §1's explicit
prohibition on stopping after a subset.

**Validation:** the full differential comparison list in §7, run against
every maintained fixture (the 18-layout matrix, Mixed-61, the nine-baselines
suite, capacity gate fixtures) with Rayon thread count fixed at 1; all
existing `pnpm` gates (§8.6 below) still pass unmodified against TypeScript;
new Rust-targeted gate runs (same scripts, backend override) pass with
identical hashes/partitions/counts to the TS runs.

### Stage 3 — Cache architecture before parallelizing

Not started until Stage 2 exact parity is proven. Deliverables: the cache and
concurrency design document (prompt §22 artifact #4), evaluating at least the
five architectures prompt §13.3 lists, with targeted measurements (not
intuition) for the `pairwise-nfp-relative-v3` and `transform-collision-v1`
namespaces specifically (the two namespaces `geometry-caches.md` §1
quantifies at ~98% and ~95% hit rates respectively on Mixed-61). Telemetry
counters (prompt §13.7) added to `caches` (still single-threaded — telemetry
only, no concurrent-access change yet). **No Rayon dependency is added to
`Cargo.toml` in this stage.**

**Validation:** cache telemetry report (prompt §22 artifact #13) with
lookups/hits/misses/stores/stale-detections per namespace, matching (in
shape, not necessarily exact counts, since Rust's own recomputation paths may
differ in what triggers a miss) the TS baseline evidence
(`baseline-evidence.md`'s 266,977/262,166/4,811 NFP figures).

### Stage 4 — Deterministic Rayon parallelism

`rayon` added to `Cargo.toml` only now. Parallel sites chosen only from
prompt §14.1's "good candidate" list, each landing individually with: the
prompt §14.3 deterministic pattern (stable ordinal → parallel evaluation →
stable-slot collection → serial reduction with the exact TS comparator), a
1-thread-vs-N-thread determinism test, and a benchmark proving net
improvement after synchronization overhead (prompt §6 Stage 4, items 1–9).
High-risk boundaries (prompt §14.2) — archive admission, survivor selection,
checkpoint publication by completion order, Short Side "first success"
branches, cancellation checkpoints — are never parallelized as races; §3.13's
job-orchestration function stays logically serial throughout.

**Validation:** the full determinism matrix (1, 2, default, and a higher
fixed thread count) across small/medium/Mixed-61 cases (prompt §18.4);
promotion thresholds P1–P3, P7 from `performance-contract.md` measured and
met before any parallel site is considered "adopted" rather than "removed or
narrowed" (prompt §19.3's "if a Rayon parallelization makes a workload
slower, remove or narrow it").

### Stage 5 — Package, gate, roll out

Multi-platform prebuilds (prompt §20.1), electron-builder ASAR-unpack
configuration, CI matrix (prompt §20.3), the remaining `performance-contract.md`
promotion thresholds (P4–P6, Mixed-61 speedup) measured with fresh evidence,
and the final acceptance checklist (prompt §22 artifact #15) — including the
freeze-hash re-verification (`baseline-evidence.md`'s freeze) proving no
existing test/fixture/gate file changed except additively. Only after all of
this does the backend-selector default (§6) change from `'typescript'` to
`'rust'`, and only by explicit orchestrator decision, not automatically at
the end of this stage.

### Stage validation gates common to every stage

Per prompt §18.6, re-run at the end of every stage without modification:
`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm gate:mixed61-compact`,
`pnpm gate:compact-nine-baselines`, `pnpm gate:capacity`,
`pnpm gate:capacity:production`, plus the cancellation/history/timeout/focused
irregular unit suites `docs/operations/irregular-production-gates.md`
documents. `pnpm profile:mixed61` is re-run whenever a performance claim is
made (prompt §19.1), never substituted with a new profiling framework.

---

## 9. Open questions

1. **`intrinsicPlaceDeferCompleteShadow.ts` is named in the migration
   prompt's own §5 authoritative file map (under "Capacity") but is proven
   dead for both migrated profiles** (`reconstruction.md` §1.2,
   `worker-coordination.md` line 345, cross-referenced in §3.1/§3.11 above).
   This document excludes it from the Stage 2 parity obligation. Confirm this
   reading is correct before Stage 2 begins — if the orchestrator intends
   "port everything named in §5 regardless of production liveness" as a
   stricter reading of §5 than this document assumes, that changes Stage 2's
   scope and effort estimate.
2. **The legacy non-archive branch's `NestingRequest` shape.** §4.1/§3.14
   assume the coarse native call is only ever reached when
   `isIntrinsicSharedArchiveEligible` would be `true` (i.e., the TypeScript
   selector routes non-archive-eligible requests to the existing
   `computeIrregularNesting` legacy path unconditionally, never to Rust).
   `aux-modules-liveness.md` §15 open question 2 raises the same question
   from the opposite direction (should differential mode ever probe the dead
   branch). This document's default position: the Rust backend never claims
   ownership of non-archive-eligible requests; the TypeScript selector (§6)
   must route such a request to `'typescript'` regardless of the configured
   backend preference. This needs an explicit orchestrator ruling before
   Stage 1's selector wiring is finalized, since it changes what "backend
   unavailable" means for that request shape.
3. **One profile-discriminated entry point vs. two separate entry points.**
   Prompt §7 offers both as "a reasonable shape." §8's Stage 1 plan sketches
   two (`run_compact_job`/`run_compact_short_side_job`) because Short Side's
   contract (§3.3) is "Compact settles first, then Short Side independently
   reconstructs for the settled partition" — which could also be modeled as
   one entry point with a `profile` discriminant field and identical internal
   dispatch. This is a naming/ergonomics decision with no semantic
   consequence either way; left open for Stage 1 implementation to decide,
   not blocking this document.
4. **Whether to newly wire cooperative in-band cancellation into the
   production worker path** (§4.3's deferred question, inherited unchanged
   from `worker-coordination.md` §15 open question 3). Out of scope for
   semantics-preserving Stage 2–4 work either way; recorded here only so a
   future decision to add this capability is made explicitly and separately,
   not folded silently into "the Rust port."
5. **`crates/irregular-nesting-native` pnpm-workspace `package.json`
   question** (§2.3). This document recommends deferring a `package.json`
   until Stage 2's differential harness needs to `import` the addon as a
   workspace dependency rather than a relative `require()`; confirm this
   default is acceptable or state a preference now.
6. **Exact request/response DTO schema** is deliberately not fixed by this
   document (§4.1) — it is prompt §22 artifact #3's job, a separate "native
   boundary schema document," so that the DTO's optional-field-presence rules
   (which the characterization corpus shows are load-bearing in several
   places — e.g. `capacityTrace`, `focusedCompleteReconstructionTrace`,
   `canonicalEnclosedCavityCount`'s Compact-vs-Short-Side asymmetry,
   `worker-coordination.md` §3.3–3.4) get their own dedicated, carefully
   cross-checked specification rather than being sketched incompletely here.
