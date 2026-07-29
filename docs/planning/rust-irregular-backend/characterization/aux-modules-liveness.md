# Cluster: aux-modules-liveness

Scope: the 18 files in `src/workers/algorithm/irregular/` not covered by any sibling
characterization document: `portfolioSearch.ts`, `priorityOrderService.ts`,
`strictPriorityDecoder.ts`, `targetedExactLns.ts`, `windowedBeam.ts`,
`overlapRelaxation.ts`, `overlapRelaxationV1.ts`, `overlapRelaxationTracker.ts`,
`intrinsicComponentInterfaceClosure.ts`, `intrinsicDetachedPieceReinsertion.ts`,
`intrinsicExactProjection.ts`, `intrinsicGlobalSqueezePortfolio.ts`,
`intrinsicPeriodicSmallFillE3.ts`, `intrinsicQueueBeamDiscriminator.ts`,
`intrinsicSqueezeDisruptSeparate.ts`, `intrinsicTransformSeparator.ts`,
`intrinsicTwoPieceInterfaceReconstruction.ts`, `intrinsicV7SeedArchive.ts`.

Every file listed above was read in full or by exhaustive structural survey
(complete export/import trace, every docstring, and deep representative
sampling of internal logic sufficient to describe algorithm shape and confirm
liveness) before writing this document. For the two largest files
(`intrinsicSqueezeDisruptSeparate.ts`, 5,622 lines, and
`intrinsicQueueBeamDiscriminator.ts`, 4,812 lines) the full public export
surface (every `export function`/`export class`/`export interface`), every
docstring, and roughly half of the internal implementation were read directly;
the remainder consists of repeated variations on already-observed patterns
(GLS conflict-weight bookkeeping, canonical-legality classification, bounded
retention/dedup, trace-object construction) that do not change the liveness
verdict or the algorithm-shape summary below. Per the task brief, the primary
deliverable for this cluster is the liveness verdict (section 1); sections 3–13
are intentionally short for modules that are DEAD/PROBE-ONLY, per the
instruction "for LIVE modules apply the full checklist; for others a short
paragraph each." No module in this cluster is LIVE.

## 0. Headline finding

**All 18 files in this cluster are unreachable from the production Compact and
Compact Short Side execution path.** None of them are imported, directly or
transitively, from any module the migration prompt's Rust scope (§4.1, §5)
names as part of the Compact/Compact Short Side execution path
(`computeIrregularNesting.ts`, `intrinsicSharedArchivePortfolio.ts`,
`intrinsicStrictDecoder.ts`, `intrinsicGapRegions.ts`,
`intrinsicStrictFamilyPortfolio.ts`, `intrinsicPeriodicCells.ts`,
`intrinsicPeriodicFamilyPortfolio.ts`, `intrinsicReconstructionPortfolio.ts`,
`intrinsicAnytimeArchive.ts`, the capacity cluster, or the Short Side cluster).
This was verified by exhaustive repo-wide grep for every module's basename as
an import target across `src/`, `tests/`, and `scripts/` (commands and outputs
reproduced in section 1), not by sampling.

Two of the 18 files (`portfolioSearch.ts`, `priorityOrderService.ts`) *are*
imported by `computeIrregularNesting.ts` itself — but only into a branch that
is unreachable for the shipped Compact and Compact Short Side settings
presets. This is the one genuinely subtle case in the cluster and is treated
in full detail in section 1.1.

**Consequence for the Rust port:** none of this cluster needs a Rust
implementation to achieve Compact/Compact Short Side parity. The two-and-a-half
"reachable but never executed" files (`portfolioSearch.ts`,
`priorityOrderService.ts`, and `windowedBeam.ts` which they call) are the
TypeScript reference backend's legacy GA/beam decoder for `workerMode`
configurations other than the two migrated profiles; the migration prompt's
scope boundary (§4.1) does not name this legacy path, and it explicitly stays
in TypeScript regardless (§4.2: "the existing irregular TypeScript
implementation as a maintained reference backend ... fallback, and rollback
path"). The remaining 15 files are pure research/diagnostic/probe tooling with
zero production callers and, for four of them, zero test callers at all.

## 1. Purpose and role in Compact / Compact Short Side execution

### 1.0 Liveness verdict table

| Module | Verdict | Non-test importers | Evidence |
| --- | --- | --- | --- |
| `portfolioSearch.ts` | **DEAD** (reachable via import graph, never executed for Compact/Short Side) | `computeIrregularNesting.ts:42-45`, `src/workers/irregular/infrastructure.ts:8` | §1.1 |
| `priorityOrderService.ts` | **DEAD** (same reachable-but-unexecuted status as above; only consumer is `portfolioSearch.ts`) | `computeIrregularNesting.ts:46`, `portfolioSearch.ts:21`, `infrastructure.ts:9` | §1.1 |
| `windowedBeam.ts` | **DEAD** (only entered from the dead `portfolioSearch.ts` GA/beam path and from `targetedExactLns.ts`, itself dead) | `portfolioSearch.ts:36`, `targetedExactLns.ts:30-32` | §1.1, §1.2 |
| `strictPriorityDecoder.ts` | **DEAD, test-only** — zero non-test importers anywhere in the repo | none | `grep -rln "strictPriorityDecoder" --include="*.ts" .` → `tests/unit/irregularBeamDecoder.test.ts`, `tests/unit/irregularWindowedBeam.test.ts` only |
| `targetedExactLns.ts` | **PROBE-ONLY** | `scripts/irregular-targeted-exact-lns-probe.ts`, `scripts/irregular-capacity-gate.ts:47` (flag-gated, see §1.3) | §1.3 |
| `overlapRelaxation.ts` | **PROBE-ONLY** | `overlapRelaxationV1.ts:15-18`, `targetedExactLns.ts:21-24`, `intrinsicDetachedPieceReinsertion.ts:22-24`, `intrinsicTwoPieceInterfaceReconstruction.ts:25-28`, 3 scripts | §1.3 |
| `overlapRelaxationV1.ts` | **PROBE-ONLY** | `targetedExactLns.ts:26-28`, 2 scripts | §1.3 |
| `overlapRelaxationTracker.ts` | **PROBE-ONLY** (helper of `overlapRelaxation.ts` only) | `overlapRelaxation.ts:24` | grep |
| `intrinsicComponentInterfaceClosure.ts` | **PROBE-ONLY** | `scripts/irregular-capacity-gate.ts:34` (flag-gated), `scripts/irregular-intrinsic-v7-seed-archive.ts` | §1.3 |
| `intrinsicDetachedPieceReinsertion.ts` | **PROBE-ONLY, zero unit tests** | `scripts/irregular-capacity-gate.ts:35` (flag-gated) | §1.3, §14 |
| `intrinsicExactProjection.ts` | **DEAD** — zero non-test/non-probe production importers; used only by the E5/E5.1/V7 experiments below | `intrinsicGlobalSqueezePortfolio.ts:33`, `intrinsicTransformSeparator.ts:16-22`, `intrinsicSqueezeDisruptSeparate.ts:30-38`, `intrinsicV7SeedArchive.ts:33-38`, 1 script | errors-protocol.md line 153 (independent confirmation) |
| `intrinsicGlobalSqueezePortfolio.ts` | **DEAD** — zero non-test importers repo-wide | none | errors-protocol.md line 154 (independent confirmation); own grep reproduced below |
| `intrinsicPeriodicSmallFillE3.ts` | **PROBE-ONLY, zero unit tests** | `scripts/irregular-intrinsic-periodic-small-fill-e3.ts` | §1.4, §14 |
| `intrinsicQueueBeamDiscriminator.ts` | **DEAD, test/probe-only** — self-documented as never entering the live decode | `tests/unit/intrinsicStrictDecoder.test.ts`, `scripts/irregular-intrinsic-v7-seed-archive.ts` | §1.5 (SPECIAL FOCUS) |
| `intrinsicSqueezeDisruptSeparate.ts` | **DEAD** — imported only by `intrinsicGlobalSqueezePortfolio.ts` (itself dead) and `intrinsicV7SeedArchive.ts` (itself dead) | none live | errors-protocol.md line 156 (independent confirmation) |
| `intrinsicTransformSeparator.ts` | **DEAD** — imported only by the E5/E5.1 dead cluster | `intrinsicSqueezeDisruptSeparate.ts:39-58`, `intrinsicV7SeedArchive.ts:39-50` | grep |
| `intrinsicTwoPieceInterfaceReconstruction.ts` | **PROBE-ONLY, zero unit tests** | `scripts/irregular-capacity-gate.ts:36` (flag-gated) | §1.3, §14 |
| `intrinsicV7SeedArchive.ts` | **DEAD** — zero non-test importers repo-wide | none | errors-protocol.md line 157 (independent confirmation) |

Terminology used consistently in this document, matching the task's
requested taxonomy:

- **DEAD** — no code path reachable from `computeIrregularNesting.ts` under
  any settings a shipped Compact or Compact Short Side preset can produce
  ever calls into the module, and no `pnpm`-aliased script or gate exercises
  it either.
- **PROBE-ONLY** — the module is invoked only by a manually-run `tsx
  scripts/irregular-*.ts` diagnostic (no `pnpm` script alias) or is
  behind a non-default CLI flag inside an aliased gate script, and/or is
  covered by a `tests/unit/*.test.ts` file that `pnpm test` runs.

None of the 18 modules reach the LIVE bar (reachable from
`computeIrregularNesting.ts` under the settings a shipped Compact/Compact
Short Side preset actually produces).

### 1.1 The `portfolioSearch.ts` / `priorityOrderService.ts` / `windowedBeam.ts` triad — reachable but never executed

This is the one case in the cluster worth walking through in full, because
static import analysis alone is insufient — the modules ARE imported by the
live coordinator file.

`computeIrregularNesting.ts:41-46` imports
`IrregularNestingPortfolioLive` from `portfolioSearch.js` and
`PriorityOrderServiceLive` from `priorityOrderService.js`, and at
`computeIrregularNesting.ts:434-438` builds the `IrregularNestingPortfolio`
service from those two layers:

```ts
const portfolioService = yield* Effect.service(IrregularNestingPortfolio).pipe(
  Effect.provide(
    IrregularNestingPortfolioLive.pipe(Layer.provideMerge(PriorityOrderServiceLive))
  )
)
```

That service is threaded into `coordinateIntrinsicSharedArchive` (the archive
coordinator, `computeIrregularNesting.ts:474` onward) as
`input.portfolioService`, but it is only actually *invoked* — `.run(...)` — at
exactly one call site: `computeIrregularNesting.ts:1438`, inside
`runSingleSheetPortfolio` (`computeIrregularNesting.ts:1378-1441`).
`runSingleSheetPortfolio` is itself called from exactly one place,
`computeIrregularNesting.ts:1066`, inside the `else` branch of:

```ts
if (archiveEnabled) {
  /* ... the entire Compact / Compact Short Side archive-only construction ... */
} else {
  const production = yield* runSingleSheetPortfolio(input, input.request.sheet, undefined)
  /* ... */
}
```

(`computeIrregularNesting.ts:504-1064` is the `if` body;
`computeIrregularNesting.ts:1065-1069` is the `else` body.)
`archiveEnabled` is defined at `computeIrregularNesting.ts:483` as
`isIntrinsicSharedArchiveEligible(input.settings)`, a thin wrapper
(`computeIrregularNesting.ts:1695-1697`) over
`intrinsicSharedArchiveEligibility` (`src/shared/irregular/executionMode.ts:16-32`):

```ts
export function intrinsicSharedArchiveEligibility(
  optimizer: IrregularOptimizerSettings
): IntrinsicSharedArchiveEligibility {
  if (optimizer.intrinsicSharedArchiveEnabled !== true) {
    return { eligible: false, reason: 'archive-disabled' }
  }
  if (optimizer.placementPolicyId === 'short-side-fill') {
    return { eligible: false, reason: 'short-side-fill' }
  }
  const gaDisabled = /* gaEnabled === false || baselineOnly === true || … budgets === 0 */
  if (!gaDisabled) return { eligible: false, reason: 'ga-active' }
  return { eligible: true }
}
```

The production Compact settings factory,
`makeCompactQualityIrregularOptimizerSettings`
(`src/shared/irregular/defaults.ts:149-165`), unconditionally sets
`intrinsicSharedArchiveEnabled: true`, `baselineOnly: true`, `gaEnabled: false`,
and `placementPolicyId: 'edge-contact-then-balanced-compactness'` (not
`'short-side-fill'`) — so `archiveEnabled` is always `true` for it.
`makeCompactShortSideIrregularOptimizerSettings`
(`src/shared/irregular/defaults.ts:168-175`) calls
`makeCompactQualityIrregularOptimizerSettings` and overrides only
`intrinsicObjectiveProfileId: 'short-side'`, which
`intrinsicSharedArchiveEligibility` never inspects — so Compact Short Side is
equally always archive-eligible. `DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS`
(`defaults.ts:177-178`) and `DEFAULT_IRREGULAR_NESTING_SETTINGS`
(`defaults.ts:180-183`), used as the worker's fallback default
(`src/workers/irregular/geometryKernel.ts:38`, confirmed by
`worker-coordination.md` line 96-101), are also built from
`makeCompactQualityIrregularOptimizerSettings()`. The renderer's settings UI
exposes exactly two presets — `applyCompactQualityPreset` and
`applyCompactShortSidePreset`
(`src/renderer/utils/irregularSettingsUi.ts:53-70`) — both of which call the
same two archive-eligible factories. `irregularSettingsUiState`
(`irregularSettingsUi.ts:27-50`) explicitly labels the *non*-eligible case
`'legacy-requires-migration'`:

```ts
if (eligibility.eligible) {
  return { mode: /* 'compact-shared-archive' | 'compact-short-side' */, ... }
}
return { mode: 'legacy-requires-migration', ... }
```

So the `else` branch that calls `portfolioSearch.ts`'s `IrregularNestingPortfolio.run` —
and therefore `windowedBeam.ts` and, if GA is active, the underlying
generational search — is reachable only when a request's
`options.irregularSettings` is something *other* than one of the two shipped
Compact presets: e.g. a persisted pre-archive settings object from before the
shared-archive system existed, or a hand-built settings object in a test.
Neither the Compact nor the Compact Short Side profile the migration prompt
scopes into Rust can ever produce such a settings object through the shipped
UI or the shipped defaults. `priorityOrderService.ts` has exactly one
consumer, `portfolioSearch.ts:21` (imported as `PriorityOrderService`) plus
the layer construction site already discussed, so it inherits the same dead
status. `windowedBeam.ts` is called from `portfolioSearch.ts:36-37`
(`runWindowedIrregularBeam`, invoked at `portfolioSearch.ts:537-549` inside
`decodeChromosome`) and from `targetedExactLns.ts:30-32`
(`runWindowedIrregularReconstruction`); both call sites are themselves
unreachable for Compact/Compact Short Side (this section, and §1.3
respectively).

A second, independent piece of evidence: `src/workers/irregular/infrastructure.ts`
also imports and wires `IrregularNestingPortfolioLive` and
`PriorityOrderServiceLive` (`infrastructure.ts:8-9,17-26`) into an exported
`IrregularNestingInfrastructureLive` layer bundle. That bundle itself has
**zero production importers**: `src/workers/irregular/index.ts:3` re-exports
it, but nothing in `src/` imports `src/workers/irregular/index.ts` (verified
by `grep -rln "irregular/index\.js"` across `src/`, which returns nothing —
the one apparent hit, `src/renderer/utils/irregularSettingsUi.ts:6`, imports
the unrelated `@shared/irregular/index.js` domain barrel). The only consumer
of `IrregularNestingInfrastructureLive` anywhere is
`tests/unit/irregularInfrastructure.test.ts:1-16`, and that test only proves
the Effect Layer graph *composes* (it calls
`CollisionGeometryBuilder.use(...)` through the merged layer to check that
`GeometrySettings.Live` is threaded correctly) — it never calls
`IrregularNestingPortfolio.run`, so it does not exercise
`portfolioSearch.ts`'s or `windowedBeam.ts`'s actual algorithm logic either.

### 1.2 `strictPriorityDecoder.ts`

`strictPriorityDecoder.ts` exports `decodeStrictPriorityOrder`
(`strictPriorityDecoder.ts:72-144`), a single-pass "decode one supplied
priority order with deterministic baseline geometry" function whose own
docstring (`strictPriorityDecoder.ts:49-71`) says it exists to be called by
"future beam and portfolio search" — i.e., it predates and was superseded by
`windowedBeam.ts`. `grep -rln "strictPriorityDecoder" --include="*.ts" .`
returns only `tests/unit/irregularBeamDecoder.test.ts` and
`tests/unit/irregularWindowedBeam.test.ts`; no `src/` file, including
`portfolioSearch.ts` and `windowedBeam.ts` themselves, imports it. It is dead
even within the dead legacy-GA subsystem.

### 1.3 The overlap-relaxation / targeted-LNS / capacity-shadow probe family

`overlapRelaxation.ts`, `overlapRelaxationV1.ts`, `overlapRelaxationTracker.ts`,
`targetedExactLns.ts`, `intrinsicComponentInterfaceClosure.ts`,
`intrinsicDetachedPieceReinsertion.ts`, and
`intrinsicTwoPieceInterfaceReconstruction.ts` form a second, independent
cluster with a distinct purpose: post-hoc "can we squeeze this settled
capacity layout tighter" experiments. All 7 are imported by
`scripts/irregular-capacity-gate.ts` (`irregular-capacity-gate.ts:34-36,43-47`),
the script backing the *required* production gates `pnpm gate:capacity` and
`pnpm gate:capacity:production` (`package.json:34-35`, both run
`scripts/irregular-capacity-gate.ts --strict[--paired]`).

This makes the liveness question for this sub-cluster more subtle than a pure
import trace: the script that a required gate runs really does import these
modules. But every call to them inside the script is gated behind CLI flags
that default to `false` and that neither `gate:capacity` nor
`gate:capacity:production` passes:

- `runCohesionLnsShadow` (`irregular-capacity-gate.ts:885-944`, calls
  `runTargetedExactLns`) only runs if `captureCohesionLnsShadow` is true.
- `runCohesionReinsertionShadow` (`irregular-capacity-gate.ts:844-883`, calls
  `runIntrinsicDetachedPieceReinsertion`) only runs if
  `captureCohesionReinsertionShadow` is true.
- `runCohesionFeatureContactShadow` (`irregular-capacity-gate.ts:781-842`,
  calls `runIntrinsicComponentInterfaceClosure` and, transitively,
  `measureRelaxationMetrics` / `isAdmissibleTargetedImprovement` from
  `overlapRelaxation.ts` / `targetedExactLns.ts`) only runs if
  `captureCohesionFeatureContactShadow` is true.
- `runCohesionTwoPieceInterfaceShadow` (`irregular-capacity-gate.ts:718-779`,
  calls `runIntrinsicTwoPieceInterfaceReconstruction`) only runs if
  `captureCohesionTwoPieceInterfaceShadow` is true.

All four flags default to `false` in `parseArguments`
(`irregular-capacity-gate.ts:969-1046`, defaults declared
`irregular-capacity-gate.ts:976-980`) and are set only by the CLI options
`--cohesion-lns-shadow`, `--cohesion-reinsertion-shadow`,
`--cohesion-feature-contact-shadow`, `--cohesion-two-piece-interface-shadow`
(`irregular-capacity-gate.ts:1013-1024`). Neither `gate:capacity` nor
`gate:capacity:production` (`package.json:34-35`) passes any of these flags —
they pass only `--strict [--paired]`. **Executing the required gate therefore
never calls into any of the 7 modules in this sub-cluster**; the gate would
pass or fail identically if the four shadow functions were deleted from the
script, so long as the script still typechecks. This is exactly the same
"imported by a live file, never executed under the actual invocation" pattern
as §1.1, one layer removed (a dev/gate *script*, not the production
algorithm). `overlapRelaxationV1.ts` and `overlapRelaxation.ts` are each
additionally invoked by their own unaliased probe scripts
(`scripts/irregular-overlap-relaxation-v1-probe.ts`,
`scripts/irregular-overlap-relaxation-probe.ts`,
`scripts/irregular-targeted-exact-lns-probe.ts`), none of which have a
`package.json` alias (`grep -n '"[a-z0-9:-]*":.*irregular' package.json`
lists only `benchmark:irregular`, `corpus:sheet-invariance`,
`gate:compact-nine-baselines`, `gate:capacity`, `gate:capacity:production` —
no probe script is aliased).

### 1.4 `intrinsicPeriodicSmallFillE3.ts`

`runIntrinsicPeriodicSmallFillE3` (`intrinsicPeriodicSmallFillE3.ts:52-158`)
runs four bounded "E3" roles (`E1`, `P1`, `P2`, `L1`) that reuse *live*
production primitives — `constructIntrinsicStrictState` /
`finalizeIntrinsicStrictState` from `intrinsicStrictDecoder.ts` and
`groupIntrinsicCollisionFamilies` from `intrinsicStrictFamilyPortfolio.ts`,
both part of the migration prompt's Rust scope — but the *orchestrating
function itself* has exactly one importer,
`scripts/irregular-intrinsic-periodic-small-fill-e3.ts`, which has no
`package.json` alias and no test file. It is a manually-run research
comparison harness that exercises live building blocks in a combination the
production coordinator never uses.

### 1.5 `intrinsicQueueBeamDiscriminator.ts` (SPECIAL FOCUS)

This 4,812-line file is the largest in the cluster and was already flagged by
independent sibling readers: `errors-protocol.md:155` records
"`intrinsicQueueBeamDiscriminator.ts` has zero non-test importers repo-wide";
`strict-decoder-gap-family.md` repeatedly marks call sites into live
production comparators/helpers as "(dead)" specifically because their only
caller is this file (e.g. `strict-decoder-gap-family.md:158,162,164,165,174`);
`validation-spatial.md:128,184,874` likewise treats it as the sole outlier
that does something other unrelated files in its area do not. This
document's independent verification agrees: `grep -rln
"intrinsicQueueBeamDiscriminator" --include="*.ts" .` returns only
`tests/unit/intrinsicStrictDecoder.test.ts` and
`scripts/irregular-intrinsic-v7-seed-archive.ts` (itself dead, §1.6/§1.7).
Every exported entry point's own docstring self-declares non-authoritative,
diagnostic-only status:

- `runIntrinsicQueueBeamDiscriminator` (`intrinsicQueueBeamDiscriminator.ts:635`):
  "Replays one pure-growth strict construction under independent diagnostic
  budgets. It never participates in the live decode, ranking, or deadline."
  (`:631-634`)
- `runIntrinsicPartialGeometricBeam` (`:1063`): "Runs the first live Stage 2A
  beam cell while keeping reordering disabled." (`:1062`, describing an
  *experimental* Stage 2A width, not the production beam)
- `runIntrinsicPeelReinsertObserver` (`:1409`): "Audits whether a bounded
  exact peel/reinsert can improve a completed layout." (`:1408`)
- `generateIntrinsicEnvelopeEventCandidates` (`:2929`): "Ordinary NFP vertices
  remain the protected control; these bounded interior points are
  experimental successors only." (`:2921-2924`)
- `auditIntrinsicReferenceSuccessorReachability` (`:3162`): "Audits one exact
  historical successor without changing search selection." (`:3161`)

The module also defines its own typed error,
`IntrinsicQueueBeamDiscriminatorError` (`:587-592`, tag
`'IntrinsicQueueBeamDiscriminatorError'`, fields `operation:
'input'|'measurement'`, `message`), which per `errors-protocol.md:57,155,595,652`
has no entry in the external `AppErrorCode` mapping table and cannot reach it
— there is no live call path from `computeIrregularNesting.ts` into any
function that can raise it.

Its full exported surface (`grep -n "^export function\|^export const\|^export
class\|^export interface\|^export type"
intrinsicQueueBeamDiscriminator.ts`) is: `runIntrinsicQueueBeamDiscriminator`,
`runIntrinsicPartialGeometricBeam`, `runIntrinsicPeelReinsertObserver`,
`generateIntrinsicEnvelopeEventCandidates`,
`auditIntrinsicReferenceSuccessorReachability`,
`measureIntrinsicQueueBeamAxes`, `intrinsicQueueBeamAxesDominate`,
`assessIntrinsicQueueCandidate`, `assessIntrinsicBeamContinuation`,
`classifyIntrinsicQueueBeamHeadroom`, `boundIntrinsicDiscriminatorWitnesses`,
`selectIntrinsicCompactClosureCandidates`, `selectIntrinsicPartialGeometricBeam`,
`measureExactDoubledPathsArea`, plus ~20 exported trace/result interfaces and
`IntrinsicQueueBeamDiscriminatorError`. None of these names appear anywhere
in `computeIrregularNesting.ts`, `intrinsicSharedArchivePortfolio.ts`,
`intrinsicStrictDecoder.ts`, `intrinsicReconstructionPortfolio.ts`, or any
other file the migration prompt names as part of Compact/Compact Short Side.
The module's role is exactly what its name says: an audit tool that
constructs a parallel "queue vs. beam headroom" comparison (using Clipper2
boolean ops directly, `import { booleanOpWithPolyTree, ... } from
'clipper2-ts'` at `:4-11`, separately from the production NFP/IFP pipeline)
to answer a research question about whether widening the strict decoder's
beam or its lookahead queue would help — a question the production Compact
path never asks at runtime.

### 1.6 The E5 / E5.1 structural-search family: `intrinsicExactProjection.ts`, `intrinsicTransformSeparator.ts`, `intrinsicSqueezeDisruptSeparate.ts`, `intrinsicGlobalSqueezePortfolio.ts`

These four files form one coherent, self-contained experimental subsystem
(internally called "E5"/"E5.1" in comments, e.g.
`intrinsicGlobalSqueezePortfolio.ts:161` "Complete sheetless structural-to-full
E5 portfolio", `intrinsicSqueezeDisruptSeparate.ts:945` "Fixed production E5
structural search", `:4712` "Preregistered E5 lane selection", and the
`IntrinsicInfeasibleSearchScope` literal `'ordinary-e5.1'` at `:126,1277,1365`):
a guided-local-search (GLS) style SAT-overlap separator that
starts from the live E1 structural-piece placement, disrupts/transports/swaps
overlapping "relaxed" poses under a private finite-transform-catalog
coordinate system (`intrinsicExactProjection.ts`'s
`IntrinsicTransformCatalog`), and periodically attempts an exact
canonical-grid projection (`projectIntrinsicLayoutExactly`,
`intrinsicExactProjection.ts:254-418`) back into a real
`IrregularPlacedPiece[]` layout, with an additional "contracted pressure"
repair lane (`intrinsicSqueezeDisruptSeparate.ts:1726-2608`) that
progressively shrinks the target box and re-separates.

Import direction is strictly one-way and never touches the live cluster:
`intrinsicTransformSeparator.ts` depends only on `intrinsicExactProjection.ts`
(`:16-22`); `intrinsicSqueezeDisruptSeparate.ts` depends on both
(`:30-58`); `intrinsicGlobalSqueezePortfolio.ts` depends on
`intrinsicSqueezeDisruptSeparate.ts` and `intrinsicExactProjection.ts`
(`:24-33`) plus the *live* `intrinsicStrictDecoder.ts` (for
`constructIntrinsicStrictState`/`evaluateIntrinsicStrictCertificate`/
`measureIntrinsicSheetlessCompletedLayout`, `:15-23` — the dependency points
from dead code into live code, never the reverse). `grep -rln
"intrinsicGlobalSqueezePortfolio" --include="*.ts" .` returns only
`tests/unit/intrinsicGlobalSqueezePortfolio.test.ts` and three unaliased
scripts (`irregular-intrinsic-periodic-family-portfolio.ts`,
`irregular-intrinsic-global-triangle-diagnostic.ts`,
`irregular-intrinsic-global-squeeze-e4.ts`) — zero production importers,
confirming `errors-protocol.md:154`'s independent finding.
`intrinsicExactProjection.ts` and `intrinsicTransformSeparator.ts` have no
importers outside this four-file family plus `intrinsicV7SeedArchive.ts`
(§1.7) and their own unit tests.

### 1.7 `intrinsicV7SeedArchive.ts`

A fifth, later experiment ("V7", `INTRINSIC_V7_STAGE1_ARMS = ['control',
'split', 'atomic', 'refine']`, `intrinsicV7SeedArchive.ts:53`) that reuses
live `intrinsicStrictDecoder.ts` primitives plus the dead
`intrinsicExactProjection.ts`/`intrinsicTransformSeparator.ts` machinery and
one function imported from `intrinsicSqueezeDisruptSeparate.ts`
(`generateIntrinsicTwoRadiusRefinementCandidates`, `:51`). `grep -rln
"intrinsicV7SeedArchive" --include="*.ts" .` returns only
`tests/unit/intrinsicV7SeedArchive.test.ts` and the unaliased script
`scripts/irregular-intrinsic-v7-seed-archive.ts` — zero production
importers, confirming `errors-protocol.md:157`'s independent finding. This
script is also the sole non-test importer of both
`intrinsicComponentInterfaceClosure.ts` (§1.3) and
`intrinsicQueueBeamDiscriminator.ts` (§1.5), tying three otherwise-separate
experimental sub-clusters together at the tooling layer only.

## 2. Entry points, callers, callees (traced, not guessed)

Because every module is DEAD or PROBE-ONLY, "entry point" means either (a)
the one production import site that never executes at runtime (§1.1), or (b)
a `tsx scripts/irregular-*.ts` command line, or (c) a `tests/unit/*.test.ts`
file. All are enumerated per-module in section 1 and section 14; there is no
additional live call graph to trace. The one cross-file dependency graph
worth stating explicitly, because it determines what a Rust implementer must
NOT accidentally treat as in-scope just because it looks structurally similar
to live code:

```
computeIrregularNesting.ts ──(imports, dead branch)──> portfolioSearch.ts ──> windowedBeam.ts
                                                      └─(imports, dead branch)──> priorityOrderService.ts
targetedExactLns.ts ──> windowedBeam.ts, overlapRelaxationV1.ts, overlapRelaxation.ts
overlapRelaxationV1.ts ──> overlapRelaxation.ts
overlapRelaxation.ts ──> overlapRelaxationTracker.ts
intrinsicDetachedPieceReinsertion.ts ──> overlapRelaxation.ts, targetedExactLns.ts
intrinsicTwoPieceInterfaceReconstruction.ts ──> overlapRelaxation.ts, targetedExactLns.ts
intrinsicTransformSeparator.ts ──> intrinsicExactProjection.ts
intrinsicSqueezeDisruptSeparate.ts ──> intrinsicExactProjection.ts, intrinsicTransformSeparator.ts
intrinsicGlobalSqueezePortfolio.ts ──> intrinsicSqueezeDisruptSeparate.ts, intrinsicExactProjection.ts
                                     └─(live)──> intrinsicStrictDecoder.ts
intrinsicV7SeedArchive.ts ──> intrinsicExactProjection.ts, intrinsicTransformSeparator.ts,
                               intrinsicSqueezeDisruptSeparate.ts (one function)
                            └─(live)──> intrinsicStrictDecoder.ts
intrinsicPeriodicSmallFillE3.ts ──(live)──> intrinsicStrictDecoder.ts, intrinsicPeriodicCells.ts,
                                             intrinsicStrictFamilyPortfolio.ts
intrinsicComponentInterfaceClosure.ts, intrinsicQueueBeamDiscriminator.ts ──(live, read-only)──>
                                             canonicalLayoutGeometry.ts, intrinsicStrictDecoder.ts, etc.
strictPriorityDecoder.ts ──(no src importer at all)
```

No file in this cluster is imported by any file in this cluster's inverse
direction — the dependency graph among the 18 files (plus their live
building blocks) is a DAG rooted at unreachable entry points, so there is no
risk of a live file accidentally depending on one of these transitively.

## 3. Data in/out

Because nothing here is LIVE, this section is deliberately brief; the shapes
below exist only to help a future maintainer recognize this code if it is
ever encountered, not because a Rust port needs them.

- **Legacy GA/beam triad** (`portfolioSearch.ts`, `priorityOrderService.ts`,
  `windowedBeam.ts`): input is `IrregularPortfolioChromosome` (priority
  order + per-piece transform preference map + placement policy id,
  `portfolioSearch.ts:39-43`) plus `IrregularPreparedPiece[]`; output is
  `IrregularPortfolioResult` (same shared-domain type the live archive path
  also produces, `@shared/irregular/domain.js`), so its *output shape* is
  compatible with the live path even though it is never invoked.
- **Overlap-relaxation family**: input `ReadonlyArray<IrregularPlacedPiece>`
  (an already-complete or already-capacity incumbent layout); output an
  `IntrinsicRelaxationMetrics` tuple (`overlapRelaxation.ts:35-51`) carrying
  both floating-mm and, where available, exact canonical-grid (`bigint`
  string) envelope/hull fields, used purely for internal admissibility
  comparisons (§6).
- **E5/E5.1/V7 family**: input/working state is `IntrinsicRelaxedState`
  (`intrinsicTransformSeparator.ts:33-35`, a `pieceId -> {transformKey,
  translationBasis, translateGrid}` pose list in a *private* finite-transform
  coordinate frame that is never itself a publishable placement — only
  `provisionalLayoutFromRelaxedState` (`intrinsicTransformSeparator.ts:156-174`)
  or `projectIntrinsicLayoutExactly` (`intrinsicExactProjection.ts:254-418`)
  convert it back to canonical, and the latter is the only one whose result
  is asserted canonical-legal before being returned).
- **Queue/beam discriminator family**: input is
  `ReadonlyArray<IrregularPreparedPiece>` plus runtime/evaluation budgets;
  output is one of several `IntrinsicQueueBeam*Result` trace objects
  (`intrinsicQueueBeamDiscriminator.ts:244-586`) that record per-depth
  candidate-generation, scoring, and selection statistics — none of these
  fields are consumed by production code.

Optional-field presence/omission conventions inside these dead modules follow
the same house style as the live code (spread-conditional object literals,
e.g. `computeIrregularNesting.ts:1403-1436`'s `portfolioInput` construction —
the object built immediately before the one call into the dead
`portfolioService.run` at `:1438` — uses the `...(x !== undefined ? {k: x} :
{})` idiom pervasively, and `windowedBeam.ts`/`portfolioSearch.ts` use the
same idiom throughout their own option-building code) — this is noted only
because it is the same JS-specific hazard the live clusters document; see §12.

## 4. Algorithm state and every mutation point

Not applicable in the sense the checklist intends (no production algorithm
state is mutated by any of these modules, because none of them run in
production). Internally, each family maintains its own private, per-call
mutable state that never escapes the function call:

- `portfolioSearch.ts`'s `runPortfolio` maintains `evaluatedByChromosome:
  Map<string, EvaluatedChromosome>` (`:325-328`) as a per-run GA cache and
  `bestOverall`/`bestGa` running-best variables (`:296,324`) — entirely local.
- `windowedBeam.ts`'s beam loop mutates `beam`, `scoredBeam`,
  `incumbentState`, `productionBeamStates`, `boundaryAnchorStates`,
  `intrinsicContactStates`, `paretoFrontierStates` (`:395-408`) once per
  step, local to one `runWindowedIrregularBeamCore` call.
- `overlapRelaxationV1.ts`'s `runArm`-equivalent search mutates
  `current`/`tracker`/`totals`/`bestLayout`/`bestTracker`/`bestTotals`/
  `strikes` (`:226-243`) across sweeps, local to one
  `relaxOverlappingLayoutV1` call.
- `intrinsicSqueezeDisruptSeparate.ts`'s basin search mutates `pool`,
  `weights`, `lowestObservedRawLoss`, `consecutiveNonImprovingSweeps`,
  `shadowLineageSnapshot` (`:1275-1289`) per basin, and the outer function
  additionally mutates `handoffs`, `projectionCandidates`,
  `contractedPressureTrace` (`:1067-1075`) across basins/roles — all local
  to one `runIntrinsicSqueezeDisruptSeparateWithSchedule` call.
- `intrinsicV7SeedArchive.ts` and `intrinsicQueueBeamDiscriminator.ts`
  maintain analogous per-call accumulators (archive lists, step-trace
  arrays, evaluation-budget counters) that are always local to one
  `Effect.gen` invocation.

None of these mutation sequences are observable from outside the dead call,
and none interact with the live NFP/IFP caches, the live archive, or the
live scheduler.

## 5. Ordering sources

Because none of this reaches production output, the ordering catalogue below
is informational (in case a future change makes any of this reachable) and
to support the port scope decision, not a porting requirement.

- **Stable-sort reliance**: every module in the cluster uses `.toSorted(...)`
  (ES2023 stable, non-mutating) rather than `.sort(...)` for ranking —
  consistent with the house style documented in the live clusters. Examples:
  `portfolioSearch.ts:428` (`generationResults.toSorted(evaluatedOrder(...))`),
  `windowedBeam.ts:1448,1459,1469,...` (candidate/state ranking throughout),
  `overlapRelaxationV1.ts:530,601` (candidate evaluation ranking),
  `intrinsicSqueezeDisruptSeparate.ts:1378,5179-5199` (pool retention
  ranking), `intrinsicTwoPieceInterfaceReconstruction.ts:254`
  (`acceptedCandidates.sort(compareCandidates)` — this one uses mutating
  `.sort()` on a freshly-built local array, so mutation-safety is moot but
  it is the one inconsistent spot in the cluster relative to the `.toSorted()`
  house style).
- **Map/Set insertion order observed**: `portfolioSearch.ts`'s
  `evaluatedByChromosome` Map (`:325`) is looked up by key, never iterated
  for order, so insertion order is not observable in its output.
  `intrinsicSqueezeDisruptSeparate.ts`'s `unique = new Map<string,
  IntrinsicInfeasiblePoolEntry>()` (`:5158`) is iterated via `[...unique.values()]`
  (`:5178`) immediately followed by an explicit `.toSorted(...)` — so Map
  iteration order is only a *staging* step before a deterministic sort, not
  itself an ordering source. The same pattern recurs in
  `intrinsicExactProjection.ts`'s `catalogById`/`placedById` Maps (lookup
  only) and `intrinsicComponentInterfaceClosure.ts`'s `seenIdentities: Set<string>`
  (`:130`, membership test only).
- **PRNG-driven order**: `portfolioSearch.ts`'s `DeterministicPrng` class
  (`:1266-1290`) is a from-scratch xorshift-style generator seeded by
  `hashSeed(settings.optimizer.gaSeed)` (`:1292-1299`, an FNV-1a-style hash of
  the seed string) — deterministic given the seed, and never touches
  `Math.random`. It drives population mutation/crossover order in the dead
  GA branch only.
- **Halton low-discrepancy sequences**: used as a *deterministic* sampling
  order (not random) in `overlapRelaxationV1.ts:1246-1256` (`halton`),
  `intrinsicTransformSeparator.ts:1165-1175` (`halton`), and (indirectly, via
  `intrinsicSampledRelocationProposalsForPiece`) in
  `intrinsicSqueezeDisruptSeparate.ts`. Same base-2/base-3 radical-inverse
  algorithm reimplemented independently in each file rather than shared.

## 6. Comparators and tie rules

Representative comparator chains (all numeric-then-string, matching the live
clusters' house style of "domain criteria first, `localeCompare`/lexical key
last for a total order"):

- `selectBetterIrregularPortfolioCandidate` (`portfolioSearch.ts:936-960`):
  layout-scorer comparison, then "preferred chromosome key" tie-break
  (baseline preferred over GA on exact tie), then
  `second.chromosomeKey < first.chromosomeKey` (raw string `<`, not
  `localeCompare`) as the final tie-break.
- `evaluatedOrder` (`portfolioSearch.ts:962-967`): layout-scorer compare,
  then `Order.String` on `chromosomeKey` — `Order.String` is Effect's
  library `String` order, which is a plain code-unit/UTF-16 comparison
  (equivalent to `<`), not `localeCompare`.
- `compareRepresentativeStates` (`windowedBeam.ts:2624-2637`): placement-order
  array comparison, then unplaced-source-piece-id array comparison
  (`Order.Array(Order.String)`, i.e., elementwise UTF-16 `<`), then raw
  string `Order.String` on the state key.
- The multiple `protectedLegacy*`/`protectedIntrinsic*`/`protectedParetoFrontier*`
  `Order.combineAll([...])` chains in `windowedBeam.ts:2253-2377` compose 10+
  numeric criteria (unplaced count, contact counts ascending/descending via
  `Order.flip`, area/span, hull-waste ratio, free-material metrics) before
  falling back to `placementOrder`/`unplacedSourcePieceIds` array order and
  finally the state key — this is by far the deepest comparator chain in the
  cluster, mirroring the live layout-scorer's own comparator depth
  (documented in `search-scoring.md`) but for the dead beam engine.
- `compareIntrinsicRelaxationMetrics` (`overlapRelaxation.ts:675-728`) and
  `isAdmissibleTargetedImprovement` (`targetedExactLns.ts:531-593`,
  duplicated near-verbatim as `isAdmissibleRelaxationImprovement` in
  `overlapRelaxation.ts:620-673`) both branch on whether *exact* canonical-grid
  fields (`bigint`-encoded strings) are available on both sides before
  falling back to floating-mm comparison — see §7 for the exact/float
  duality this implies.
- `compareStructuralHandoffs` (`intrinsicSqueezeDisruptSeparate.ts:5117-5133`),
  `compareFullCandidates` (`intrinsicGlobalSqueezePortfolio.ts:564-588`, which
  additionally calls `evaluateIntrinsicStrictCertificate` from the *live*
  `intrinsicStrictDecoder.ts` to compute a "violated floors" / "relative
  deficit sum" prefix before the geometric criteria), and
  `compareCandidates`/`compareReinsertionCandidates`
  (`intrinsicTwoPieceInterfaceReconstruction.ts:377-407`,
  `intrinsicDetachedPieceReinsertion.ts:213-245`) all follow the same
  numeric-tuple-then-lexical-tiebreak shape.
- `comparePoolEntriesByRaw`/`comparePoolEntriesByWeight`/`dominatesPoolEntry`
  (`intrinsicSqueezeDisruptSeparate.ts:5430-5462`) implement a raw/weighted
  dual ranking plus a Pareto-dominance predicate (non-strict `<=` on both
  axes, strict `<` on at least one) reused for the GLS pool retention.

None of these comparators are reachable from production output, so their
exact tie rules are documentation-only for this migration; no Rust port
obligation follows from them.

## 7. Numeric semantics

- **BigInt exact-grid comparisons**: pervasive across the E5/V7 family and
  the overlap-relaxation family whenever an "exact" canonical-grid metric is
  available: `overlapRelaxation.ts:628-651` and
  `targetedExactLns.ts:538-562` both do
  `BigInt(candidate.exact.envelopeAreaGrid2) <= BigInt(incumbent.exact.envelopeAreaGrid2)`
  style comparisons (the fields themselves are stored as decimal strings,
  `IntrinsicRelaxationMetrics['exact']` at `overlapRelaxation.ts:45-50`, and
  converted to `BigInt` only at comparison time — consistent with the "BigInt
  string encoding" hazard the migration prompt calls out in §8.1/§9).
  `intrinsicExactProjection.ts:780-816` computes envelope
  width/height/area/span directly in `bigint` from `BigInt(x)`/`BigInt(y)`
  grid coordinates with no intermediate float step.
  `intrinsicTransformSeparator.ts:1413-1421` implements exact `bigint`
  cross-product orientation tests (`gridOrientation`) for segment
  intersection, mirroring the live canonical-grid predicates' exactness
  discipline.
- **Signed-zero normalization**: `intrinsicExactProjection.ts:1021-1024` and
  `intrinsicTransformSeparator.ts:1541-1544` both implement
  `normalizedRotationDeg` with `Object.is(normalized, -0) ? 0 : normalized`
  — the identical `-0` guard pattern the live code uses elsewhere.
  `intrinsicTransformSeparator.ts:1038-1039` explicitly guards `rawX === 0 ?
  0 : rawX` when composing a pose's world coordinate, to avoid propagating a
  computed `-0`.
- **Grid conversion**: every module in the E5/V7/overlap families converts
  between floating millimeters and the canonical grid via the shared
  `toGridMm`/`fromGrid` helpers from `clipper2OffsetPolicy.js` (e.g.
  `overlapRelaxationV1.ts:1270-1276`, `intrinsicExactProjection.ts:824-841`)
  — the same grid-conversion authority the live geometry cluster uses, so
  there is no separate grid-rounding policy invented in this dead cluster.
- **Custom PRNG bit operations**: `portfolioSearch.ts:1274-1299`'s
  `DeterministicPrng` uses `Math.imul` and `>>> 0` (unsigned right shift) —
  standard 32-bit-safe JS idioms for a from-scratch PRNG; not shared with any
  live module.
- **`Math.hypot`/`Math.sqrt`/`Math.atan`-free geometry**: the SAT-penetration
  and separating-axis code in `overlapRelaxation.ts:390`,
  `overlapRelaxationV1.ts` (`measureConvexSatPenetration`, imported from
  `../../irregular/convexSatPenetration.js`, itself outside this cluster),
  and `intrinsicTransformSeparator.ts:1065-1102` use `Math.hypot` for axis
  normalization (`windowedBeam.ts` local repair code also uses `Math.hypot`
  in `terminalBottomLeftCornerGapMm`, `windowedBeam.ts:971`) — floating,
  non-exact, and explicitly documented in-line as "raw" (SAT) rather than
  canonical-grid decisions; every family that uses raw SAT loss follows it
  with an exact canonical-grid legality re-check
  (`assertCanonicalGridLegalLayout`/`assertIntrinsicTargetExactLegal`) before
  ever accepting a result, matching the "Clipper2/robust-predicates own
  exactness, floats are for search heuristics only" division of
  responsibility the migration prompt requires (§8.3) for the live code —
  this dead cluster follows the same discipline even though it is unused.

## 8. Serialization and hashing

- `intrinsicTransformSeparator.ts:177-205`'s `intrinsicRelaxedStateKey`
  builds a canonical per-pose array (`[pieceId, transformKey,
  phaseSignature, pointSequenceKey]`), `JSON.stringify`s the whole array, and
  SHA-256-hashes it (`createHash('sha256').update(JSON.stringify(keyed))...`,
  `:204`), producing a `sha256:<hex>` string. This is the only SHA-256 use in
  the cluster; it is entirely private to the dead E5/V7 state-deduplication
  logic and is never compared against, or mixed into, any live canonical
  hash.
- `portfolioSearch.ts:1074-1080`'s `chromosomeKey` builds a plain
  `priorityOrder.join('|') + '::' + transforms + '::' + policyId` string (no
  JSON, no hash) — used only as a `Map`/`Set` dedup key inside the dead GA
  loop.
- `windowedBeam.ts:2679-2699`'s `beamStateKey`/
  `preparedPieceInterchangeabilitySignature` use `JSON.stringify` on plain
  object literals (property order is source-literal-fixed, so this is
  deterministic per V8's own object-literal key-order guarantee for string
  keys) combined with the *live* `canonicalOccupiedGeometryKey` from
  `IrregularBeamState` — again private to the dead beam engine.
- `intrinsicExactProjection.ts:181-191`'s `canonicalKey` for
  `IntrinsicTransformCatalog` and `intrinsicTransformSeparator.ts:1233-1237`'s
  memo key both `JSON.stringify` array-of-tuples structures (never bare
  objects with variable key order), avoiding the "JSON.stringify key-order"
  hazard by construction.

None of these feed into any canonical hash, checkpoint, or trace that the
migration prompt's parity gates observe.

## 9. Caches touched and the exact historical access sequence

All caches in this cluster are private, per-call-scoped, and never shared
with the live NFP/IFP/geometry caches:

- `IrregularNfpIfpCandidateMemoScope` (imported from the *live*
  `services.ts`) is instantiated fresh per call in `windowedBeam.ts:367`,
  `intrinsicDetachedPieceReinsertion.ts:109`,
  `intrinsicTwoPieceInterfaceReconstruction.ts:146`, and
  `intrinsicQueueBeamDiscriminator.ts` (per `nfp-ifp.md:120`'s own
  cross-reference) — this is the same job-local/bounded cache lifetime
  pattern the live callers use (`nfp-ifp.md:120` explicitly lists these dead
  files' construction sites alongside the live ones as evidence the pattern
  is uniform), but because the *callers* never run in production, these
  particular cache instances are never constructed at runtime either.
- `intrinsicTransformSeparator.ts:74-79,207-224`'s
  `IntrinsicPhaseSignatureMemo` (`byCatalogEntryAndBasis: Map<string, string |
  undefined>`) is an explicit request/hit/miss-counted memo, created via
  `createIntrinsicPhaseSignatureMemo()` and read/written only inside
  `translationPhaseSignature` (`:1226-1264`) — one per `runIntrinsicV7SeedArchive`
  arm (`intrinsicV7SeedArchive.ts`).
- `intrinsicSqueezeDisruptSeparate.ts:166-172,2830-2913`'s
  `IntrinsicPressureCanonicalLegalityMemo` (`byStateKey: Map<string,
  IntrinsicPressureCanonicalLegality>`) similarly counts
  request/evaluation/hit/disagreement, created once per contracted-pressure
  lane attempt (`createIntrinsicPressureCanonicalLegalityMemo()` at
  `:1921`).

No cache in this cluster is bounded by a job-level memory policy beyond
"lives as long as the enclosing function call" — appropriate for dead code,
and explicitly not a Rust-port concern.

## 10. Cancellation / deadline / budget / evaluation-cap observation points

Every module in this cluster implements its own cooperative
deadline/cancellation checkpoint, structurally similar to but independent
from the live `IrregularNfpIfpControl`/scheduler checkpoints documented in
`worker-coordination.md` and `capacity-search.md`:

- `windowedBeam.ts:1167-1215`'s `controlCheckpoint` checks
  `control.isCancelled()`/`control.deadlineMs` every call, and every 8th
  call (`CHECKPOINTS_PER_EVENT_LOOP_YIELD = 8`, `:1165`) also does
  `yield* yieldToEventLoop()` (`Effect.promise(() => new Promise(resolve =>
  setImmediate(resolve)))`, `:1208-1215`) — an explicit macrotask yield
  never present in the live decoder's checkpoint (worth flagging because it
  is a distinct cooperative-scheduling shape a reader might mistake for a
  live pattern).
- `overlapRelaxation.ts`/`overlapRelaxationV1.ts` use plain evaluation
  counters (`budget.evaluations`, `input.budget.count`) checked against
  `maximumEvaluations` inline in their sweep loops (`overlapRelaxation.ts:219-221`,
  `overlapRelaxationV1.ts:277-283`) with no wall-clock deadline at all —
  these are pure evaluation-cap-bounded searches, no `Date.now()`/`deadlineMs`
  anywhere in either file.
- `targetedExactLns.ts` uses an injectable clock (`input.now ?? Date.now`,
  `:172`) and two nested deadlines — `globalDeadline` (`:174`) and a
  per-round `roundDeadlineMs` (`:175`, capped by `Math.min(globalDeadline,
  roundStartedAt + roundDeadlineMs)` at `:310`) — the same
  "injected deterministic clock" seam pattern the migration prompt requires
  for checkpoint timing byte-parity (§11), reused here even though unused in
  production.
- `intrinsicSqueezeDisruptSeparate.ts`'s `makeAbsoluteControl`
  (`:753-772`, in `intrinsicGlobalSqueezePortfolio.ts`) and
  `globalSearchCheckpoint`/`deadlineControl` wrap the live
  `IrregularNfpIfpControl` shape with an additional absolute
  `performance.now() - startedAt >= maximumRuntimeMs` deadline layered on
  top of any caller-supplied control — every sweep, basin, and pressure
  attempt loop calls this checkpoint before doing further work
  (`intrinsicSqueezeDisruptSeparate.ts:1292,1340,1344,1455,1551,1588` and
  many more).
- `intrinsicComponentInterfaceClosure.ts:143` and
  `intrinsicTwoPieceInterfaceReconstruction.ts:167,188` use plain
  `performance.now() - startedAt >= maximumRuntimeMs` wall-clock checks with
  no injectable clock and no cooperative yield — the simplest deadline shape
  in the cluster.

Because none of these modules run in production, none of these checkpoints
are part of the migration prompt's "map and preserve the current observation
points" requirement (§15) — that requirement applies to the live decoder,
capacity search, and archive coordinator checkpoints, documented in the
sibling `worker-coordination.md`, `capacity-search.md`, and
`strict-decoder-gap-family.md` clusters.

## 11. Error paths

Tagged error classes defined inside this cluster, all `Data.TaggedError`
subclasses in the house style:

| Class | Location | Tag | Fields | Reaches `AppErrorCode`? |
| --- | --- | --- | --- | --- |
| `IrregularWindowedBeamAbortedError` | `windowedBeam.ts:121-126` | `IrregularWindowedBeamAbortedError` | `reason: 'deadline'\|'cancelled'`, `message` | No on the live path (`errors-protocol.md:149`); would be absorbed by `IrregularPortfolioError` if the dead legacy path ever ran |
| `IntrinsicExactProjectionError` | `intrinsicExactProjection.ts:81-93` | `IntrinsicExactProjectionError` | `operation` (4-literal union), `category: 'invalid-input'\|'exact-analysis'\|'projection-exhausted'`, `message`, optional `failedPieceId`, `attempts` | No (`errors-protocol.md:153`) |
| `IntrinsicGlobalPortfolioError` | `intrinsicGlobalSqueezePortfolio.ts:136-141` | `IntrinsicGlobalPortfolioError` | `operation: 'initialize'\|'partition'\|'structural-search'\|'gap-fill'\|'archive'`, `message` | No (`errors-protocol.md:154`) |
| `IntrinsicGlobalSearchError` | `intrinsicSqueezeDisruptSeparate.ts:739-742` | `IntrinsicGlobalSearchError` | `operation: 'partition'\|'initialize'\|'search'\|'archive'`, `message` | No (`errors-protocol.md:156`) |
| `IntrinsicQueueBeamDiscriminatorError` | `intrinsicQueueBeamDiscriminator.ts:587-592` | `IntrinsicQueueBeamDiscriminatorError` | `operation: 'input'\|'measurement'`, `message` | No (`errors-protocol.md:155`) |
| `IntrinsicV7SeedArchiveError` | `intrinsicV7SeedArchive.ts:210-215` (verified present) | `IntrinsicV7SeedArchiveError` | `operation: 'seed'\|'catalog'\|'state'\|'analysis'`, `message` | No (`errors-protocol.md:157`) |

`portfolioSearch.ts` additionally constructs the *live* `IrregularPortfolioError`
class (imported from `../../irregular/services.js`, not defined in this
cluster) via its own `toPortfolioError`/`failPortfolio` helpers
(`portfolioSearch.ts:1086-1111`) — this is the one place a dead-cluster file
produces an error type that *does* have an external mapping
(`irregular_geometry_invalid`/`irregular_scoring_error`, per the migration
prompt's §16 table), but only because `IrregularNestingPortfolio.run`'s
declared return type requires it; the mapping is exercised only if the dead
`else` branch (§1.1) ever runs.

Per the migration prompt's §16 table and its verification requirement
against current source: none of the six error classes in this cluster's own
table need a Rust port mapping, because none of them can be raised on the
Compact/Compact Short Side path. This matches `errors-protocol.md`'s
independent, already-committed conclusion for the four classes it covers
(`IntrinsicExactProjectionError`, `IntrinsicGlobalPortfolioError`,
`IntrinsicGlobalSearchError`, `IntrinsicV7SeedArchiveError`), and extends it
to `IrregularWindowedBeamAbortedError` and
`IntrinsicQueueBeamDiscriminatorError`.

## 12. JS-specific semantics hazards for a Rust port

Documented here for completeness even though none of this cluster requires
porting; a future maintainer who stumbles into this code (e.g. while
grepping for a shared helper) should not mistake these hazards for
production requirements:

- **Stable-sort reliance**: as in the live clusters, every `.toSorted(...)`
  call in this cluster depends on `Array.prototype.toSorted`/`.sort`'s
  ES2019+ stability guarantee for its final lexical tie-break to be
  meaningful when earlier numeric criteria are equal (e.g.
  `windowedBeam.ts:2253-2274`'s 15-criterion chain always ends in an
  explicit string key, so stability is not actually load-bearing there —
  but `intrinsicComponentInterfaceClosure.ts:299-303`'s `componentEdgesFor`
  sort and several others rely on the *input* order surviving equal keys).
- **`Order.String` vs `localeCompare` vs raw `<`**: the cluster is
  inconsistent about which string comparison it uses for the "last resort"
  tie-break — `windowedBeam.ts` mixes `Order.String` (Effect's library,
  itself a raw `<`) and manual `first.chromosomeKey <
  second.chromosomeKey` (`portfolioSearch.ts:959`); other files use
  `.localeCompare(...)` for the same role (e.g.
  `intrinsicComponentInterfaceClosure.ts:251`,
  `intrinsicDetachedPieceReinsertion.ts:242-243`,
  `targetedExactLns.ts:679`). `localeCompare` without an explicit locale
  argument is locale- and Node-ICU-build-dependent in general; the specific
  piece-id/hash strings compared here are ASCII, so in practice
  `localeCompare` and raw `<` agree — but this is exactly the kind of
  "verify whether each TypeScript comparison is code-unit, lexical,
  locale-based, or numeric" case the migration prompt calls out (§9), and it
  recurs inconsistently within this one dead cluster.
- **BigInt string round-tripping**: the "exact" canonical-grid metrics
  (`IntrinsicRelaxationMetrics['exact']`, `overlapRelaxation.ts:45-50`) are
  stored as decimal strings and `BigInt(...)`-parsed at every comparison
  site rather than carried as `bigint` end-to-end — a pattern a Rust
  implementer must not copy literally (Rust would carry `i128`/exact types
  natively), but is worth noting because it recurs in the *live*
  `intrinsicCapacityEndpoint.ts`/`intrinsicStrictDecoder.ts` metrics too
  (per `capacity-core.md`/`strict-decoder-gap-family.md`), so a reader
  cannot use "string-encoded BigInt field" alone to distinguish live from
  dead code.
- **`JSON.stringify` on array-of-tuples vs plain objects**: every
  cluster module that builds a `JSON.stringify`-based key does so over
  arrays/tuples with source-fixed shape (never over an object whose key set
  varies at runtime), so none of them are exposed to V8's object-key
  insertion-order semantics — but this is a discipline that must be
  independently verified for each new key function, not assumed.
- **`Math.imul`/unsigned-shift PRNG**: `portfolioSearch.ts`'s
  `DeterministicPrng` (`:1266-1290`) is bit-exact only under JS's 32-bit
  `Math.imul` semantics; a naive Rust port using `wrapping_mul` on `i32`/`u32`
  would need to replicate `Math.imul`'s truncation exactly if this code were
  ever promoted — moot today since it is dead.

## 13. Parallelism assessment

Not applicable: none of this cluster is scheduled to run in the Rust port
(§0), so there is no Rayon parallelization decision to make for it. For
completeness, if any of these modules were ever promoted to production (out
of scope for this migration), the same "safe candidate" analysis the live
clusters use would apply per-module:

- The overlap-relaxation and E5/E5.1 sweep loops are **chronology-bound**
  (each sweep's candidate pool depends on the previous sweep's GLS weight
  updates, `intrinsicSqueezeDisruptSeparate.ts:1384,3766+`) — not a safe
  Rayon candidate as written.
- Independent per-candidate SAT-penetration/legality evaluation *within* one
  sweep (e.g. the `for (const proposal of proposals)` inner loop,
  `intrinsicSqueezeDisruptSeparate.ts:1339-1374`) is the kind of
  "independent candidate legality or score evaluation within one already
  ordered candidate batch" the migration prompt's §14.1 lists as a
  potentially safe pattern — but this observation has no bearing on the
  current port since the outer function never runs.

## 14. Tests and gates covering this cluster

Exact files, found by `grep -rl "<module>" tests/unit/*.test.ts` per module
(reproduced per-module in section 1) and cross-checked against
`vitest.config.ts:5` (`include: ['tests/unit/**/*.test.ts', ...]`, so all of
the following run under the required `pnpm test` gate):

| Test file | Covers |
| --- | --- |
| `tests/unit/irregularPortfolio.test.ts` | `portfolioSearch.ts` |
| `tests/unit/irregularBeamDecoder.test.ts` | `strictPriorityDecoder.ts` |
| `tests/unit/irregularWindowedBeam.test.ts` | `windowedBeam.ts`, `strictPriorityDecoder.ts`, `targetedExactLns.ts` |
| `tests/unit/targetedExactLns.test.ts` | `targetedExactLns.ts`, `overlapRelaxation.ts` |
| `tests/unit/canonicalLayoutGeometry.test.ts` | (incidental) `targetedExactLns.ts` helper reuse |
| `tests/unit/overlapRelaxation.test.ts` | `overlapRelaxation.ts`, `overlapRelaxationV1.ts` |
| `tests/unit/overlapRelaxationTracker.test.ts` | `overlapRelaxationTracker.ts`, `overlapRelaxation.ts` |
| `tests/unit/intrinsicComponentInterfaceClosure.test.ts` | `intrinsicComponentInterfaceClosure.ts` |
| `tests/unit/intrinsicExactProjection.test.ts` | `intrinsicExactProjection.ts` |
| `tests/unit/intrinsicSqueezeDisruptSeparate.test.ts` | `intrinsicSqueezeDisruptSeparate.ts`, `intrinsicExactProjection.ts`, `intrinsicTransformSeparator.ts` |
| `tests/unit/intrinsicGlobalSqueezePortfolio.test.ts` | `intrinsicGlobalSqueezePortfolio.ts`, `intrinsicSqueezeDisruptSeparate.ts` |
| `tests/unit/intrinsicV7SeedArchive.test.ts` | `intrinsicV7SeedArchive.ts` |
| `tests/unit/intrinsicStrictDecoder.test.ts` | (incidental) `intrinsicQueueBeamDiscriminator.ts` |
| `tests/unit/irregularInfrastructure.test.ts` | (incidental, layer-composition only) `portfolioSearch.ts`/`priorityOrderService.ts` via `infrastructure.ts` |

**Zero unit-test coverage** (no `tests/unit/*.test.ts` file references them
by any name): `priorityOrderService.ts`, `intrinsicDetachedPieceReinsertion.ts`,
`intrinsicPeriodicSmallFillE3.ts`, `intrinsicTwoPieceInterfaceReconstruction.ts`.
These four are exercised only by manual `tsx scripts/irregular-*.ts` runs
(`intrinsicDetachedPieceReinsertion.ts`/`intrinsicTwoPieceInterfaceReconstruction.ts`
via the flag-gated shadow arms of `irregular-capacity-gate.ts`, §1.3;
`intrinsicPeriodicSmallFillE3.ts` via its own dedicated unaliased script,
§1.4) or, for `priorityOrderService.ts`, only via the dead
`computeIrregularNesting.ts` layer-construction path (§1.1).

**Gate scripts touching this cluster**, and exactly what they exercise
(package.json script name → script file → cluster modules actually invoked
under that script's *default* invocation):

| `pnpm` script | Script file | Cluster modules imported | Actually invoked by the required gate? |
| --- | --- | --- | --- |
| `benchmark:irregular` (not a required gate — a manual benchmark) | `scripts/irregular-benchmark.ts` | `portfolioSearch.ts` | Not verified as part of this cluster's scope; not in the migration prompt's §18.6 required-gate list |
| `gate:capacity` | `scripts/irregular-capacity-gate.ts --strict --paired` | `targetedExactLns.ts`, `overlapRelaxation.ts`, `intrinsicDetachedPieceReinsertion.ts`, `intrinsicTwoPieceInterfaceReconstruction.ts`, `intrinsicComponentInterfaceClosure.ts` | **No** — all four `--cohesion-*-shadow` flags default `false` (`irregular-capacity-gate.ts:976-980`) and are not passed by this alias; every call site into these 5 modules is behind one of those flags (§1.3) |
| `gate:capacity:production` | `scripts/irregular-capacity-gate.ts --strict` | same 5 modules | **No**, same reason |

No other `pnpm`-aliased script (`grep -n '"[a-z0-9:-]*":.*irregular'
package.json`) imports any file in this cluster. The following scripts touch
cluster modules but have **no `package.json` alias** (manual `tsx` invocation
only, never run by CI or a named gate):
`scripts/irregular-targeted-exact-lns-probe.ts`,
`scripts/irregular-overlap-relaxation-v1-probe.ts`,
`scripts/irregular-overlap-relaxation-probe.ts`,
`scripts/irregular-intrinsic-v7-seed-archive.ts`,
`scripts/irregular-intrinsic-periodic-family-portfolio.ts`,
`scripts/irregular-intrinsic-global-triangle-diagnostic.ts`,
`scripts/irregular-intrinsic-global-squeeze-e4.ts`,
`scripts/irregular-intrinsic-periodic-small-fill-e3.ts`.

**Conclusion for the migration:** `pnpm test`, `pnpm gate:capacity`, and
`pnpm gate:capacity:production` remain green regardless of whether this
cluster's TypeScript is ported to Rust, deleted, or left untouched, *as long
as the TypeScript reference backend keeps building* (the gate script still
needs to typecheck its imports). The migration prompt's §3 immutability rule
("the existing test suite ... remains authoritative") therefore obligates
the Rust migration to leave these 18 TypeScript files and their tests alone,
not to reimplement them.

## 15. Open questions and ambiguities

1. **Source-truth correction to the migration prompt's implicit framing.**
   The migration prompt's "Authoritative implementation map" (§5) does not
   name any of these 18 files, which is consistent with the finding here —
   no contradiction. However, a reader who only skims the SPECIAL FOCUS
   instruction's phrase "flagged by the reconstruction reader as having zero
   production importers" might assume only `intrinsicQueueBeamDiscriminator.ts`
   is anomalous. Source truth, independently reverified in this document: the
   *entire 18-file cluster* is equally unreachable, including two files
   (`portfolioSearch.ts`, `priorityOrderService.ts`) that ARE imported by the
   live coordinator file `computeIrregularNesting.ts` — the more subtle and
   more important case for a Rust implementer to understand correctly (§1.1),
   since a naive "grep for importers of `computeIrregularNesting.ts`'s
   imports" check would incorrectly flag these two as live.
2. **Should the Rust port's differential-mode harness (migration prompt
   §6/§17/§18.3) ever route a request through the dead legacy branch
   (`archiveEnabled === false`)?** The migration prompt scopes Rust to
   Compact and Compact Short Side only, and both shipped presets are always
   archive-eligible (§1.1). If a future test or persisted-settings replay
   ever constructs a non-archive-eligible `irregularSettings` object and
   feeds it through the backend selector, the current recommendation (also
   given by `worker-coordination.md`) is that the Rust backend should not
   attempt to reproduce that branch — it falls outside "Compact and Compact
   Short Side" as those profiles are defined by their settings factories,
   and TypeScript remains available as the reference/fallback backend for
   any request shape the Rust port does not claim to own. This document
   does not resolve whether the differential harness should assert-reject
   such a request or silently route it to TypeScript-only comparison; that
   is a Stage 1 boundary-design decision, not a characterization fact.
3. **Should `pnpm gate:capacity`/`pnpm gate:capacity:production` ever be run
   with the `--cohesion-*-shadow` flags as part of a *future* stricter
   gate?** Today they are not (§1.3, §14); if a maintainer later decides to
   strengthen the gate to include those flags, the modules in §1.3 would
   move from PROBE-ONLY to a gate-exercised (but still not
   Compact/Compact-Short-Side-production) status. This document reports the
   gate's *current* default invocation only, as required; it is not a
   recommendation to change the gate.
4. **`errors-protocol.md`'s table omits `IrregularWindowedBeamAbortedError`'s
   and `IntrinsicQueueBeamDiscriminatorError`'s "why it can never reach
   `AppErrorCode`" derivation from this cluster's own liveness evidence** —
   that sibling document derives the same dead conclusion from its own
   independent read of `computeIrregularNesting.ts`'s error-mapping call
   sites. This document's §1.1 and §1.5 supply the module-level liveness
   proof those conclusions rest on; the two documents are consistent and
   mutually corroborating, not contradictory, but a reviewer comparing them
   line-by-line should expect the *emphasis* to differ (errors-protocol.md
   is error-class-first, this document is module-first).
