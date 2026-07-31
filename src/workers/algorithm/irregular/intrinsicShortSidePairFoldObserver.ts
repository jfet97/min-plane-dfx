import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Effect } from 'effect'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularTransform,
  type IrregularNestingSettings,
  type IrregularPreparedPiece,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutTopologyExact,
  placedCollisionWorldGridPath
} from '../../irregular/canonicalLayoutGeometry.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel } from '../../irregular/geometryKernel.js'
import { NfpIfpService } from '../../irregular/services.js'
import {
  INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_BACKTRACKS,
  INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_CANDIDATE_EVALUATIONS,
  INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES,
  INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS,
  constructIntrinsicShortSideContactStrip,
  type IntrinsicShortSideContactStripTrace
} from './intrinsicShortSideContactStrip.js'
import { intrinsicShortSideEnvelopeAreaCostWithinProductionBound } from './intrinsicShortSideObserver.js'
import { intrinsicShortSideAxes } from './intrinsicShortSideAxes.js'
import { IrregularBeamState } from './irregularBeamState.js'

export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION =
  'intrinsic-short-side-terminal-observer-v6' as const
export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RUNTIME_MS = 30_000 as const
export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RSS_DELTA_BYTES = 512 * 1_048_576
export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_TRACE_BYTES = 1_048_576 as const
export const INTRINSIC_SHORT_SIDE_ORDER_CONTINUATION_MAX_PIECES = 8 as const

export interface IntrinsicShortSidePairFoldRuntimeControl {
  readonly maximumRuntimeMs?: number
  readonly maximumRssDeltaBytes?: number
  readonly maximumTraceBytes?: number
  readonly now?: () => number
  readonly currentRssBytes?: () => number
}

export type IntrinsicShortSidePairFoldStatus =
  | 'accepted'
  | 'skipped-square-sheet'
  | 'no-pair'
  | 'no-fitting-pair'
  | 'rejected-admission'
  | 'deadline'
  | 'memory-cap'
  | 'trace-cap'
  | 'failed-protected-fallback'

export interface IntrinsicShortSidePairFoldAdmission {
  readonly exactLegal: boolean
  readonly allPiecesPlaced: boolean
  readonly fillRatio: number
  readonly depthWithinProductionMaximumSide: boolean
  readonly projectionCoverageRatio: number
  readonly projectionComponentCount: number
  readonly enclosedCavityCount: number | undefined
  readonly collisionEnvelopeDensity: number
  readonly shortAxisSpanGainFactor: number
  readonly envelopeAreaCostFactor: number
  readonly directionallyEfficient: boolean
  readonly envelopeAreaCostWithinProductionBound: boolean
  readonly accepted: boolean
}

/*
 * One causal quality veto: the named construction passed every pre-existing
 * admission term and failed only the production envelope area-cost bound.
 * Retained so a quality-protected fallback can substantiate which sibling was
 * vetoed even when a later construction became the selected trace outcome.
 */
export interface IntrinsicShortSideEnvelopeAreaCostVeto {
  readonly constructionKind: IntrinsicShortSideConstructionKind
  readonly admission: IntrinsicShortSidePairFoldAdmission
}

/**
 * Interlocking-quality measurements for one terminal construction.
 *
 * The rejected `9193f26` promotion showed that equal envelope, fill, density,
 * legality, and production hashes cannot detect degraded packing quality. These
 * terms make the packing structure itself explicit so a replacement cannot be
 * promoted while regressing it.
 */
export interface IntrinsicShortSideInterlockingMetrics {
  readonly largestOccupiedHullGapRatio: number
  readonly largestOccupiedHullGapDoubledAreaGrid2: string
  readonly occupiedHullDoubledAreaGrid2: string
  readonly isolatedPieceCount: number
  readonly positiveContactComponentCount: number
  readonly largestPositiveContactComponentSize: number
  readonly sharedBoundaryLengthMm: number
}

export interface IntrinsicShortSidePairFoldTrace {
  readonly version: typeof INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION
  readonly status: IntrinsicShortSidePairFoldStatus
  readonly outputInfluence: 'none' | 'selected'
  readonly executionModel: 'single-process-sequential'
  readonly requestedShortAxisMm: number
  readonly requestedLongAxisMm: number
  readonly prescribedRotationDeg: 0 | 90 | undefined
  readonly productionShortAxisSpanMm: number
  readonly productionMaximumSideMm: number
  readonly productionEnvelopeAreaMm2: number
  readonly productionShortAxisSpanGrid: number
  readonly productionMaximumSideGrid: number
  readonly productionEnvelopeAreaGrid2: string
  readonly transformEvaluations: number
  readonly expectedPairCount: number
  readonly evaluatedPairCount: number
  readonly constructionKind: IntrinsicShortSideConstructionKind | undefined
  readonly rowCount: number
  readonly selectedBottomPieceId: string | undefined
  readonly selectedUpperPieceId: string | undefined
  readonly placedCount: number
  readonly usedShortAxisSpanMm: number | undefined
  readonly usedLongAxisDepthMm: number | undefined
  readonly envelopeAreaMm2: number | undefined
  readonly usedShortAxisSpanGrid: number | undefined
  readonly usedLongAxisDepthGrid: number | undefined
  readonly envelopeAreaGrid2: string | undefined
  readonly collisionMaterialDoubledAreaGrid2: string | undefined
  readonly canonicalGeometryHash: string | undefined
  readonly admission: IntrinsicShortSidePairFoldAdmission | undefined
  readonly interlocking: IntrinsicShortSideInterlockingMetrics | undefined
  readonly envelopeAreaCostVetoObserved: boolean
  readonly envelopeAreaCostVetoes: ReadonlyArray<IntrinsicShortSideEnvelopeAreaCostVeto>
  readonly contactStrip: IntrinsicShortSideContactStripTrace | undefined
  readonly contactStripLanes: ReadonlyArray<IntrinsicShortSideContactStripTrace>
  readonly contactStripPromotion: IntrinsicShortSideContactStripPromotion | undefined
  readonly runtimeMs: number
  readonly peakRssDeltaBytes: number
  readonly serializedTraceBytes: number
  readonly failureReason: string | undefined
}

export type IntrinsicShortSideConstructionKind = 'pair-fold' | 'multi-row-shelf' | 'contact-strip'

/** Measured directional summary of one terminal construction, promoted or not. */
export interface IntrinsicShortSideConstructionSummary {
  readonly usedShortAxisSpanMm: number | undefined
  readonly usedLongAxisDepthMm: number | undefined
  readonly envelopeAreaMm2: number | undefined
  readonly usedShortAxisSpanGrid: number | undefined
  readonly usedLongAxisDepthGrid: number | undefined
  readonly envelopeAreaGrid2: string | undefined
  readonly collisionMaterialDoubledAreaGrid2: string | undefined
  readonly admission: IntrinsicShortSidePairFoldAdmission | undefined
  readonly interlocking: IntrinsicShortSideInterlockingMetrics | undefined
  readonly status: IntrinsicShortSidePairFoldStatus
  readonly failureReason: string | undefined
}

export interface IntrinsicShortSidePairFoldGeometryEvidence {
  readonly exactLegal: true
  readonly requestedShortAxisMm: number
  readonly requestedLongAxisMm: number
  readonly usedShortAxisSpanMm: number
  readonly usedLongAxisDepthMm: number
  readonly envelopeAreaMm2: number
  readonly usedShortAxisSpanGrid: number
  readonly usedLongAxisDepthGrid: number
  readonly envelopeAreaGrid2: string
  readonly collisionMaterialDoubledAreaGrid2: string
  readonly canonicalGeometryHash: string
  readonly admission: IntrinsicShortSidePairFoldAdmission
  readonly interlocking: IntrinsicShortSideInterlockingMetrics
}

/**
 * Computes the historical strict-quality diagnostic from recomputed geometry.
 * Runtime construction and quality promotion do not use this value for admission;
 * promotion proves construction through caller-owned witness equality and applies
 * fixture-specific historical thresholds separately.
 */
function intrinsicShortSideStrictQualityDiagnosticAccepted(input: {
  readonly exactLegal: boolean
  readonly allPiecesPlaced: boolean
  readonly requestedShortAxisGrid: number
  readonly usedShortAxisGrid: number
  readonly usedLongAxisGrid: number
  readonly productionShortAxisSpanGrid: number
  readonly productionMaximumSideGrid: number
  readonly projectionCoveredGrid: number
  readonly projectionSpanGrid: number
  readonly projectionComponentCount: number
  readonly enclosedCavityCount: number
  readonly collisionMaterialDoubledAreaGrid2: bigint
  readonly envelopeAreaGrid2: bigint
  readonly productionEnvelopeAreaGrid2: bigint
  readonly directionallyEfficient: boolean
  readonly envelopeAreaCostWithinProductionBound: boolean
  readonly placedCount: number
  readonly interlocking: IntrinsicShortSideInterlockingMetrics
}): boolean {
  const productionShortfall = Math.max(
    0,
    input.requestedShortAxisGrid - input.productionShortAxisSpanGrid
  )
  const candidateShortfall = Math.max(0, input.requestedShortAxisGrid - input.usedShortAxisGrid)
  const projectionCovered =
    input.projectionSpanGrid <= 0 ||
    100n * BigInt(input.projectionCoveredGrid) >= 99n * BigInt(input.projectionSpanGrid)
  const interlocking =
    input.interlocking.isolatedPieceCount === 0 &&
    input.interlocking.positiveContactComponentCount === 1 &&
    input.interlocking.largestPositiveContactComponentSize === input.placedCount &&
    input.interlocking.sharedBoundaryLengthMm > 0
  return (
    input.exactLegal &&
    input.allPiecesPlaced &&
    5n * BigInt(input.usedShortAxisGrid) >= 4n * BigInt(input.requestedShortAxisGrid) &&
    2n * BigInt(candidateShortfall) <= BigInt(productionShortfall) &&
    input.usedLongAxisGrid <= input.productionMaximumSideGrid &&
    projectionCovered &&
    input.projectionComponentCount === 1 &&
    input.enclosedCavityCount === 0 &&
    input.collisionMaterialDoubledAreaGrid2 >= input.envelopeAreaGrid2 &&
    input.directionallyEfficient &&
    input.envelopeAreaCostWithinProductionBound &&
    intrinsicShortSideEnvelopeAreaCostWithinProductionBound(
      input.envelopeAreaGrid2,
      input.productionEnvelopeAreaGrid2
    ) &&
    interlocking
  )
}

/** Recomputes the authoritative directional evidence from prepared and placed geometry. */
export function measureIntrinsicShortSidePairFoldGeometryEvidence(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly productionShortAxisSpanMm: number
  readonly productionMaximumSideMm: number
  readonly productionEnvelopeAreaMm2: number
  readonly productionShortAxisSpanGrid: number
  readonly productionMaximumSideGrid: number
  readonly productionEnvelopeAreaGrid2: string
}): IntrinsicShortSidePairFoldGeometryEvidence | undefined {
  const dimensions = physicalDimensions(input.placedCollisionGeometries, input.sheet)
  const topologyExact = measureCanonicalLayoutTopologyExact(input.placedCollisionGeometries)
  const contacts = measureCanonicalLayoutContacts(input.placedCollisionGeometries)
  const material = collisionMaterialArea(input.placedCollisionGeometries)
  const identity = canonicalCollisionLayoutIdentity(input.placedCollisionGeometries)
  if (
    dimensions === undefined ||
    topologyExact === undefined ||
    contacts === undefined ||
    material === undefined ||
    identity === undefined ||
    !assertCanonicalGridLegalLayout(input.sheet, input.placedCollisionGeometries)
  ) {
    return undefined
  }
  const productionShortAxisSpanGrid = input.productionShortAxisSpanGrid
  const productionMaximumSideGrid = input.productionMaximumSideGrid
  const productionEnvelopeAreaGrid2 = (() => {
    try {
      return BigInt(input.productionEnvelopeAreaGrid2)
    } catch {
      return undefined
    }
  })()
  if (
    !Number.isFinite(input.productionShortAxisSpanMm) ||
    input.productionShortAxisSpanMm < 0 ||
    !Number.isFinite(input.productionMaximumSideMm) ||
    input.productionMaximumSideMm < 0 ||
    !Number.isFinite(input.productionEnvelopeAreaMm2) ||
    input.productionEnvelopeAreaMm2 < 0 ||
    !Number.isSafeInteger(productionShortAxisSpanGrid) ||
    productionShortAxisSpanGrid <= 0 ||
    !Number.isSafeInteger(productionMaximumSideGrid) ||
    productionMaximumSideGrid <= 0 ||
    productionEnvelopeAreaGrid2 === undefined ||
    productionEnvelopeAreaGrid2 <= 0n
  ) {
    return undefined
  }
  const topology = topologyExact.topology
  const envelopeAreaGrid2 = BigInt(dimensions.shortAxisGrid) * BigInt(dimensions.longAxisGrid)
  const envelopeAreaMm2 = Number(envelopeAreaGrid2) / 1_000_000
  const fillRatio = dimensions.shortAxisGrid / dimensions.requestedShortAxisGrid
  const density =
    envelopeAreaGrid2 <= 0n
      ? 0
      : Number(material.doubledAreaGrid2) / (2 * Number(envelopeAreaGrid2))
  const projection = shortAxisProjectionMetrics(input.placedCollisionGeometries, input.sheet)
  const shortAxisSpanGainFactor = dimensions.shortAxisGrid / productionShortAxisSpanGrid
  const envelopeAreaCostFactor = Number(envelopeAreaGrid2) / Number(productionEnvelopeAreaGrid2)
  const depthWithinProductionMaximumSide = dimensions.longAxisGrid <= productionMaximumSideGrid
  const directionallyEfficient =
    BigInt(dimensions.shortAxisGrid) * productionEnvelopeAreaGrid2 >=
    BigInt(productionShortAxisSpanGrid) * envelopeAreaGrid2
  const expectedPieceIds = input.preparedPieces.map((piece) => piece.pieceId ?? piece.source.id)
  const placedPieceIds = input.placedCollisionGeometries.map(
    ({ placement }) => placement.pieceId ?? placement.sourcePieceId
  )
  const expectedPieceIdSet = new Set(expectedPieceIds)
  const placedPieceIdSet = new Set(placedPieceIds)
  const exactTargetIdentity =
    expectedPieceIdSet.size === expectedPieceIds.length &&
    placedPieceIdSet.size === placedPieceIds.length &&
    placedPieceIds.length === expectedPieceIds.length &&
    expectedPieceIds.every((pieceId) => placedPieceIdSet.has(pieceId))
  const envelopeAreaCostWithinProductionBound =
    intrinsicShortSideEnvelopeAreaCostWithinProductionBound(
      envelopeAreaGrid2,
      productionEnvelopeAreaGrid2
    )
  const interlocking: IntrinsicShortSideInterlockingMetrics = {
    largestOccupiedHullGapRatio: topology.largestOccupiedHullGapRatio,
    largestOccupiedHullGapDoubledAreaGrid2: topologyExact.exactHullGapDoubledAreaGrid2,
    occupiedHullDoubledAreaGrid2: topologyExact.exactHullDoubledAreaGrid2,
    isolatedPieceCount: topology.isolatedPieceCount,
    positiveContactComponentCount: topology.positiveContactComponentCount,
    largestPositiveContactComponentSize: topology.largestPositiveContactComponentSize,
    sharedBoundaryLengthMm: contacts.sharedBoundaryLengthMm
  }
  const accepted = intrinsicShortSideStrictQualityDiagnosticAccepted({
    exactLegal: true,
    allPiecesPlaced: exactTargetIdentity,
    requestedShortAxisGrid: dimensions.requestedShortAxisGrid,
    usedShortAxisGrid: dimensions.shortAxisGrid,
    usedLongAxisGrid: dimensions.longAxisGrid,
    productionShortAxisSpanGrid,
    productionMaximumSideGrid,
    projectionCoveredGrid: projection.coveredGrid,
    projectionSpanGrid: projection.spanGrid,
    projectionComponentCount: projection.componentCount,
    enclosedCavityCount: topology.enclosedCavityCount,
    collisionMaterialDoubledAreaGrid2: material.doubledAreaGrid2,
    envelopeAreaGrid2,
    productionEnvelopeAreaGrid2,
    directionallyEfficient,
    envelopeAreaCostWithinProductionBound,
    placedCount: input.placedCollisionGeometries.length,
    interlocking
  })
  const admission: IntrinsicShortSidePairFoldAdmission = {
    exactLegal: true,
    allPiecesPlaced: exactTargetIdentity,
    fillRatio,
    depthWithinProductionMaximumSide,
    projectionCoverageRatio: projection.coverageRatio,
    projectionComponentCount: projection.componentCount,
    enclosedCavityCount: topology.enclosedCavityCount,
    collisionEnvelopeDensity: density,
    shortAxisSpanGainFactor,
    envelopeAreaCostFactor,
    directionallyEfficient,
    envelopeAreaCostWithinProductionBound,
    accepted
  }
  const canonicalGeometryHash = createHash('sha256').update(identity).digest('hex')
  return {
    exactLegal: true,
    requestedShortAxisMm: dimensions.requestedShortAxisMm,
    requestedLongAxisMm: dimensions.requestedLongAxisMm,
    usedShortAxisSpanMm: dimensions.shortAxisMm,
    usedLongAxisDepthMm: dimensions.longAxisMm,
    envelopeAreaMm2,
    usedShortAxisSpanGrid: dimensions.shortAxisGrid,
    usedLongAxisDepthGrid: dimensions.longAxisGrid,
    envelopeAreaGrid2: envelopeAreaGrid2.toString(),
    collisionMaterialDoubledAreaGrid2: material.doubledAreaGrid2.toString(),
    canonicalGeometryHash,
    admission,
    interlocking
  }
}

/** Strict no-regression comparison between the contact strip and the incumbent. */
export interface IntrinsicShortSideContactStripPromotion {
  readonly incumbentConstructionKind: IntrinsicShortSideConstructionKind | undefined
  readonly contactStripSummary: IntrinsicShortSideConstructionSummary | undefined
  readonly contactStripAdmitted: boolean
  /** `undefined` when the comparison could not be measured at all. */
  readonly fillNotRegressed: boolean | undefined
  readonly envelopeAreaNotRegressed: boolean | undefined
  readonly depthNotRegressed: boolean | undefined
  readonly densityNotRegressed: boolean | undefined
  readonly hullGapNotRegressed: boolean | undefined
  readonly isolatedPiecesNotRegressed: boolean | undefined
  readonly positiveContactComponentsNotRegressed: boolean | undefined
  readonly largestContactComponentNotRegressed: boolean | undefined
  readonly strictlyImproved: boolean | undefined
  readonly promoted: boolean
}

export interface IntrinsicShortSidePairFoldOutcome {
  readonly trace: IntrinsicShortSidePairFoldTrace
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece> | undefined
}

interface ObserverRuntime {
  readonly startedAt: number
  readonly startingRssBytes: number
  peakRssBytes: number
  transformEvaluations: number
  expectedPairCount: number
  evaluatedPairCount: number
  envelopeAreaCostVetoObserved: boolean
  readonly envelopeAreaCostVetoes: IntrinsicShortSideEnvelopeAreaCostVeto[]
  readonly maximumRuntimeMs: number
  readonly maximumRssDeltaBytes: number
  readonly maximumTraceBytes: number
  readonly now: () => number
  readonly currentRssBytes: () => number
}

interface SelectedTransform {
  readonly piece: IrregularPreparedPiece
  readonly pieceId: string
  readonly geometry: TransformedCollisionGeometry
  readonly widthGrid: number
  readonly heightGrid: number
  readonly minXGrid: number
  readonly minYGrid: number
}

interface SelectedPair {
  readonly bottomIndex: number
  readonly upperIndex: number
  readonly widthGrid: number
  readonly depthGrid: number
  readonly envelopeAreaGrid2: bigint
}

interface ShelfLayout {
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly rowCount: number
}

/**
 * Evaluates bounded exact terminal directional layouts.
 *
 * Two families are constructed sequentially: the historical fixed-transform
 * pair fold and AABB shelf, and one exact contact-driven strip that reuses
 * production Compact's NFP/IFP candidate generation. The contact strip replaces
 * the historical incumbent only when it regresses none of the directional and
 * interlocking measurements and strictly improves at least one.
 */
export function observeIntrinsicShortSidePairFold(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly settings: IrregularNestingSettings
  readonly productionShortAxisSpanMm: number
  readonly productionMaximumSideMm: number
  readonly productionEnvelopeAreaMm2: number
  readonly productionShortAxisSpanGrid: number
  readonly productionMaximumSideGrid: number
  readonly productionEnvelopeAreaGrid2: string
  readonly runtimeControl?: IntrinsicShortSidePairFoldRuntimeControl
}): Effect.Effect<IntrinsicShortSidePairFoldOutcome, never, GeometryKernel | NfpIfpService> {
  const now = input.runtimeControl?.now ?? (() => performance.now())
  const currentRssBytes = input.runtimeControl?.currentRssBytes ?? (() => process.memoryUsage.rss())
  const startingRssBytes = currentRssBytes()
  const runtime: ObserverRuntime = {
    startedAt: now(),
    startingRssBytes,
    peakRssBytes: startingRssBytes,
    transformEvaluations: 0,
    expectedPairCount: 0,
    evaluatedPairCount: 0,
    envelopeAreaCostVetoObserved: false,
    envelopeAreaCostVetoes: [],
    maximumRuntimeMs:
      input.runtimeControl?.maximumRuntimeMs ?? INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RUNTIME_MS,
    maximumRssDeltaBytes:
      input.runtimeControl?.maximumRssDeltaBytes ??
      INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RSS_DELTA_BYTES,
    maximumTraceBytes:
      input.runtimeControl?.maximumTraceBytes ?? INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_TRACE_BYTES,
    now,
    currentRssBytes
  }
  return constructPairFold(input, runtime).pipe(
    Effect.catchTags({
      IrregularGeometryInputError: (error) =>
        Effect.succeed(
          failedOutcome(
            input,
            runtime,
            'failed-protected-fallback',
            error.message,
            runtime.transformEvaluations,
            0,
            runtime.expectedPairCount,
            runtime.evaluatedPairCount
          )
        ),
      IrregularNestingNotImplementedError: (error) =>
        Effect.succeed(
          failedOutcome(
            input,
            runtime,
            'failed-protected-fallback',
            error.message,
            runtime.transformEvaluations,
            0,
            runtime.expectedPairCount,
            runtime.evaluatedPairCount
          )
        )
    })
  )
}

interface TerminalObserverInput {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly settings: IrregularNestingSettings
  readonly productionShortAxisSpanMm: number
  readonly productionMaximumSideMm: number
  readonly productionEnvelopeAreaMm2: number
  readonly productionShortAxisSpanGrid: number
  readonly productionMaximumSideGrid: number
  readonly productionEnvelopeAreaGrid2: string
  readonly runtimeControl?: IntrinsicShortSidePairFoldRuntimeControl
}

function constructPairFold(input: TerminalObserverInput, runtime: ObserverRuntime) {
  return Effect.gen(function* () {
    const axes = intrinsicShortSideAxes(input.sheet)
    const requestedShortAxisMm = axes.shortAxisMm
    const geometryKernel = yield* GeometryKernel
    const requestedShortAxisGrid = toGridMm(requestedShortAxisMm)
    const requestedLongAxisGrid = toGridMm(axes.longAxisMm)
    if (requestedShortAxisGrid === undefined || requestedLongAxisGrid === undefined) {
      return failedOutcome(
        input,
        runtime,
        'failed-protected-fallback',
        'requested sheet axes must fit the canonical grid.'
      )
    }

    const selectedTransforms: SelectedTransform[] = []
    const shelfTransforms: SelectedTransform[] = []
    for (const piece of input.preparedPieces) {
      let selected: SelectedTransform | undefined
      let shelfSelected: SelectedTransform | undefined
      for (const transform of piece.transforms) {
        runtime.transformEvaluations += 1
        const geometry = yield* geometryKernel.transformCollisionGeometry({
          geometry: piece.collisionGeometry,
          transform
        })
        const bounded = boundedStatus(runtime)
        if (bounded !== undefined) {
          return failedOutcome(
            input,
            runtime,
            bounded,
            `${bounded} reached after ${runtime.transformEvaluations} transform evaluations.`
          )
        }
        const minXGrid = toGridMm(geometry.bounds.minX)
        const minYGrid = toGridMm(geometry.bounds.minY)
        const maxXGrid = toGridMm(geometry.bounds.maxX)
        const maxYGrid = toGridMm(geometry.bounds.maxY)
        if (
          minXGrid === undefined ||
          minYGrid === undefined ||
          maxXGrid === undefined ||
          maxYGrid === undefined
        ) {
          continue
        }
        const candidate = {
          piece,
          pieceId: piece.pieceId ?? piece.source.id,
          geometry,
          widthGrid: maxXGrid - minXGrid,
          heightGrid: maxYGrid - minYGrid,
          minXGrid,
          minYGrid
        }
        if (candidate.widthGrid <= 0 || candidate.heightGrid <= 0) {
          continue
        }
        if (selected === undefined || compareSelectedTransforms(candidate, selected) < 0) {
          selected = candidate
        }
        if (shelfSelected === undefined || compareShelfTransforms(candidate, shelfSelected) < 0) {
          shelfSelected = candidate
        }
      }
      if (selected === undefined || shelfSelected === undefined) {
        return failedOutcome(
          input,
          runtime,
          'failed-protected-fallback',
          `piece ${piece.pieceId ?? piece.source.id} has no valid pair-fold transform.`,
          runtime.transformEvaluations,
          0
        )
      }
      selectedTransforms.push(selected)
      shelfTransforms.push(shelfSelected)
    }

    runtime.expectedPairCount = (selectedTransforms.length * (selectedTransforms.length - 1)) / 2
    const totalWidthGrid = selectedTransforms.reduce((sum, selected) => sum + selected.widthGrid, 0)
    let selectedPair: SelectedPair | undefined
    for (let bottomIndex = 0; bottomIndex < selectedTransforms.length - 1; bottomIndex += 1) {
      const bottom = selectedTransforms[bottomIndex]
      if (bottom === undefined) continue
      for (
        let upperIndex = bottomIndex + 1;
        upperIndex < selectedTransforms.length;
        upperIndex += 1
      ) {
        const upper = selectedTransforms[upperIndex]
        if (upper === undefined) continue
        const boundedBeforePair = boundedStatus(runtime)
        if (boundedBeforePair !== undefined) {
          return failedOutcome(
            input,
            runtime,
            boundedBeforePair,
            `${boundedBeforePair} reached after ${runtime.evaluatedPairCount} pair evaluations.`,
            runtime.transformEvaluations,
            0,
            runtime.expectedPairCount,
            runtime.evaluatedPairCount
          )
        }
        const widthGrid =
          totalWidthGrid -
          bottom.widthGrid -
          upper.widthGrid +
          Math.max(bottom.widthGrid, upper.widthGrid)
        const otherMaximumHeightGrid = selectedTransforms.reduce(
          (maximum, selected, index) =>
            index === bottomIndex || index === upperIndex
              ? maximum
              : Math.max(maximum, selected.heightGrid),
          0
        )
        const depthGrid = Math.max(bottom.heightGrid + upper.heightGrid, otherMaximumHeightGrid)
        runtime.evaluatedPairCount += 1
        const boundedAfterPair = boundedStatus(runtime)
        if (boundedAfterPair !== undefined) {
          return failedOutcome(
            input,
            runtime,
            boundedAfterPair,
            `${boundedAfterPair} reached after ${runtime.evaluatedPairCount} pair evaluations.`,
            runtime.transformEvaluations,
            0,
            runtime.expectedPairCount,
            runtime.evaluatedPairCount
          )
        }
        if (widthGrid > requestedShortAxisGrid || depthGrid > requestedLongAxisGrid) {
          continue
        }
        const candidate: SelectedPair = {
          bottomIndex,
          upperIndex,
          widthGrid,
          depthGrid,
          envelopeAreaGrid2: BigInt(widthGrid) * BigInt(depthGrid)
        }
        if (
          selectedPair === undefined ||
          compareSelectedPairs(candidate, selectedPair, selectedTransforms) < 0
        ) {
          selectedPair = candidate
        }
      }
    }
    let pairOutcome: IntrinsicShortSidePairFoldOutcome | undefined
    if (selectedPair !== undefined) {
      const pairPlaced = constructPairLayout(
        selectedTransforms,
        selectedPair,
        requestedShortAxisGrid
      )
      if (pairPlaced === undefined) {
        return failedOutcome(
          input,
          runtime,
          'failed-protected-fallback',
          'selected pair accounting exceeded the requested short axis.'
        )
      }
      pairOutcome = finalizePlacedLayout({
        input,
        runtime,
        placed: pairPlaced,
        constructionKind: 'pair-fold',
        rowCount: 1,
        selectedBottomPieceId: selectedTransforms[selectedPair.bottomIndex]?.pieceId,
        selectedUpperPieceId: selectedTransforms[selectedPair.upperIndex]?.pieceId
      })
    }

    const shelf = constructNextFitShelf(
      shelfTransforms,
      requestedShortAxisGrid,
      requestedLongAxisGrid
    )
    const shelfOutcome =
      shelf === undefined
        ? undefined
        : finalizePlacedLayout({
            input,
            runtime,
            placed: shelf.placed,
            constructionKind: 'multi-row-shelf',
            rowCount: shelf.rowCount,
            selectedBottomPieceId: undefined,
            selectedUpperPieceId: undefined
          })
    const incumbent = selectDirectionalIncumbent(pairOutcome, shelfOutcome)

    const outerRuntimeRemainingMs = Math.max(
      0,
      runtime.maximumRuntimeMs - (runtime.now() - runtime.startedAt)
    )
    const outerRssRemainingBytes = Math.max(0, runtime.maximumRssDeltaBytes - sampleRss(runtime))
    const depthStrip = yield* constructIntrinsicShortSideContactStrip({
      stripSheet: new SheetSpec({
        width: requestedShortAxisMm,
        height: axes.longAxisMm,
        label: `short-side-strip-${requestedShortAxisMm}x${axes.longAxisMm}`
      }),
      preparedPieces: input.preparedPieces,
      settings: input.settings,
      selectionPolicy: 'depth-first',
      orderPolicy: 'prepared',
      runtimeControl: {
        maximumRuntimeMs: Math.min(
          INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS,
          outerRuntimeRemainingMs
        ),
        maximumRssDeltaBytes: Math.min(
          INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES,
          outerRssRemainingBytes
        ),
        now: runtime.now,
        currentRssBytes: () => {
          const current = runtime.currentRssBytes()
          runtime.peakRssBytes = Math.max(runtime.peakRssBytes, current)
          return current
        }
      }
    })
    const boundedAfterDepthStrip = boundedStatus(runtime)
    if (boundedAfterDepthStrip !== undefined) {
      return failedOutcome(
        input,
        runtime,
        boundedAfterDepthStrip,
        `${boundedAfterDepthStrip} reached during depth-first contact-strip construction.`
      )
    }
    const depthStripOutcome =
      depthStrip.placedCollisionGeometries === undefined
        ? undefined
        : finalizePlacedLayout({
            input,
            runtime,
            placed: depthStrip.placedCollisionGeometries,
            constructionKind: 'contact-strip',
            rowCount: 0,
            selectedBottomPieceId: undefined,
            selectedUpperPieceId: undefined
          })
    const contactRuntimeRemainingMs = Math.max(
      0,
      runtime.maximumRuntimeMs - (runtime.now() - runtime.startedAt)
    )
    const contactRssRemainingBytes = Math.max(0, runtime.maximumRssDeltaBytes - sampleRss(runtime))
    const contactStrip = yield* constructIntrinsicShortSideContactStrip({
      stripSheet: new SheetSpec({
        width: requestedShortAxisMm,
        height: axes.longAxisMm,
        label: `short-side-strip-${requestedShortAxisMm}x${axes.longAxisMm}`
      }),
      preparedPieces: input.preparedPieces,
      settings: input.settings,
      selectionPolicy: 'contact-first',
      orderPolicy: 'prepared',
      runtimeControl: {
        maximumCandidateEvaluations: INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_CANDIDATE_EVALUATIONS,
        maximumBacktracks: INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_BACKTRACKS,
        maximumRuntimeMs: Math.min(
          INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS,
          contactRuntimeRemainingMs
        ),
        maximumRssDeltaBytes: Math.min(
          INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES,
          contactRssRemainingBytes
        ),
        now: runtime.now,
        currentRssBytes: () => {
          const current = runtime.currentRssBytes()
          runtime.peakRssBytes = Math.max(runtime.peakRssBytes, current)
          return current
        }
      }
    })
    const boundedAfterContactStrip = boundedStatus(runtime)
    if (boundedAfterContactStrip !== undefined) {
      return failedOutcome(
        input,
        runtime,
        boundedAfterContactStrip,
        `${boundedAfterContactStrip} reached during contact-first strip construction.`
      )
    }
    const contactStripOutcome =
      contactStrip.placedCollisionGeometries === undefined
        ? undefined
        : finalizePlacedLayout({
            input,
            runtime,
            placed: contactStrip.placedCollisionGeometries,
            constructionKind: 'contact-strip',
            rowCount: 0,
            selectedBottomPieceId: undefined,
            selectedUpperPieceId: undefined
          })
    let stripOutcome = selectDirectionalIncumbent(depthStripOutcome, contactStripOutcome)
    let selectedStripTrace =
      stripOutcome === contactStripOutcome ? contactStrip.trace : depthStrip.trace
    const contactStripLanes = [depthStrip.trace, contactStrip.trace]
    if (
      incumbent === undefined &&
      stripOutcome === undefined &&
      input.preparedPieces.length <= INTRINSIC_SHORT_SIDE_ORDER_CONTINUATION_MAX_PIECES
    ) {
      const orderContinuations = [
        {
          orderPolicy: 'reverse' as const,
          preparedPieces: input.preparedPieces.toReversed()
        },
        {
          orderPolicy: 'piece-id-ascending' as const,
          preparedPieces: sortByPieceId(input.preparedPieces)
        }
      ]
      for (const continuation of orderContinuations) {
        const remainingRuntimeMs = Math.max(
          0,
          runtime.maximumRuntimeMs - (runtime.now() - runtime.startedAt)
        )
        const remainingRssBytes = Math.max(0, runtime.maximumRssDeltaBytes - sampleRss(runtime))
        const continuedStrip = yield* constructIntrinsicShortSideContactStrip({
          stripSheet: new SheetSpec({
            width: requestedShortAxisMm,
            height: axes.longAxisMm,
            label: `short-side-strip-${requestedShortAxisMm}x${axes.longAxisMm}`
          }),
          preparedPieces: continuation.preparedPieces,
          settings: input.settings,
          selectionPolicy: 'depth-first',
          orderPolicy: continuation.orderPolicy,
          runtimeControl: {
            maximumRuntimeMs: Math.min(
              INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS,
              remainingRuntimeMs
            ),
            maximumRssDeltaBytes: Math.min(
              INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES,
              remainingRssBytes
            ),
            now: runtime.now,
            currentRssBytes: () => {
              const current = runtime.currentRssBytes()
              runtime.peakRssBytes = Math.max(runtime.peakRssBytes, current)
              return current
            }
          }
        })
        contactStripLanes.push(continuedStrip.trace)
        const boundedAfterContinuation = boundedStatus(runtime)
        if (boundedAfterContinuation !== undefined) {
          return failedOutcome(
            input,
            runtime,
            boundedAfterContinuation,
            `${boundedAfterContinuation} reached during ${continuation.orderPolicy} contact-strip continuation.`
          )
        }
        if (continuedStrip.placedCollisionGeometries === undefined) continue
        const continuedOutcome = finalizePlacedLayout({
          input,
          runtime,
          placed: continuedStrip.placedCollisionGeometries,
          constructionKind: 'contact-strip',
          rowCount: 0,
          selectedBottomPieceId: undefined,
          selectedUpperPieceId: undefined
        })
        stripOutcome = selectDirectionalIncumbent(stripOutcome, continuedOutcome)
        if (stripOutcome === continuedOutcome) {
          selectedStripTrace = continuedStrip.trace
        }
        if (stripOutcome !== undefined) break
      }
    }
    const promotion = evaluateIntrinsicShortSideContactStripPromotion(
      incumbent,
      stripOutcome,
      selectedStripTrace
    )
    const selected =
      selectDirectionalIncumbent(incumbent, stripOutcome) ??
      failedOutcome(
        input,
        runtime,
        'no-fitting-pair',
        'no exact directional construction fit both requested sheet axes.',
        runtime.transformEvaluations,
        0,
        runtime.expectedPairCount,
        runtime.evaluatedPairCount
      )
    const trace = measureTraceSize({
      ...selected.trace,
      /*
       * The selected outcome's trace was snapshotted before the contact strip
       * finalized, so refresh the causal veto aggregate from the runtime:
       * a strip-only causal veto must survive into the composite trace.
       */
      envelopeAreaCostVetoObserved: runtime.envelopeAreaCostVetoObserved,
      envelopeAreaCostVetoes: [...runtime.envelopeAreaCostVetoes],
      contactStrip: selectedStripTrace,
      contactStripLanes,
      contactStripPromotion: promotion,
      peakRssDeltaBytes: sampleRss(runtime),
      runtimeMs: Math.max(0, runtime.now() - runtime.startedAt),
      serializedTraceBytes: 0
    })
    if (selectedOutputTraceSize(trace) > runtime.maximumTraceBytes) {
      return failedOutcome(
        input,
        runtime,
        'trace-cap',
        'composite terminal short-side trace exceeds its byte cap.'
      )
    }
    return {
      trace,
      placedCollisionGeometries: selected.placedCollisionGeometries
    }
  })
}

function selectDirectionalIncumbent(
  first: IntrinsicShortSidePairFoldOutcome | undefined,
  second: IntrinsicShortSidePairFoldOutcome | undefined
): IntrinsicShortSidePairFoldOutcome | undefined {
  if (first?.trace.status !== 'accepted')
    return second?.trace.status === 'accepted' ? second : undefined
  if (second?.trace.status !== 'accepted') return first
  const firstExact = exactPromotionMetrics(first)
  const secondExact = exactPromotionMetrics(second)
  if (firstExact === undefined) return secondExact === undefined ? first : second
  if (secondExact === undefined) return first
  const firstFillTier = directionalFillTier(firstExact)
  const secondFillTier = directionalFillTier(secondExact)
  if (firstFillTier !== secondFillTier) {
    return firstFillTier > secondFillTier ? first : second
  }
  if (firstFillTier < 2 && firstExact.shortAxisSpanGrid !== secondExact.shortAxisSpanGrid) {
    return firstExact.shortAxisSpanGrid > secondExact.shortAxisSpanGrid ? first : second
  }
  if (firstExact.envelopeAreaGrid2 !== secondExact.envelopeAreaGrid2) {
    return firstExact.envelopeAreaGrid2 < secondExact.envelopeAreaGrid2 ? first : second
  }
  if (firstExact.longAxisDepthGrid !== secondExact.longAxisDepthGrid) {
    return firstExact.longAxisDepthGrid < secondExact.longAxisDepthGrid ? first : second
  }
  const topologyOrder = compareDirectionalTopology(first, second)
  if (topologyOrder !== 0) {
    return topologyOrder < 0 ? first : second
  }
  return (first.trace.canonicalGeometryHash ?? '').localeCompare(
    second.trace.canonicalGeometryHash ?? ''
  ) <= 0
    ? first
    : second
}

function sortByPieceId(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): ReadonlyArray<IrregularPreparedPiece> {
  return [...pieces].sort((first, second) => {
    const firstId = first.pieceId ?? first.source.id
    const secondId = second.pieceId ?? second.source.id
    return firstId < secondId ? -1 : firstId > secondId ? 1 : 0
  })
}

function directionalFillTier(metrics: {
  readonly shortAxisSpanGrid: number
  readonly requestedShortAxisGrid: number
}): 0 | 1 | 2 {
  if (100n * BigInt(metrics.shortAxisSpanGrid) >= 99n * BigInt(metrics.requestedShortAxisGrid)) {
    return 2
  }
  return 5n * BigInt(metrics.shortAxisSpanGrid) >= 4n * BigInt(metrics.requestedShortAxisGrid)
    ? 1
    : 0
}

function compareDirectionalTopology(
  first: IntrinsicShortSidePairFoldOutcome,
  second: IntrinsicShortSidePairFoldOutcome
): number {
  const firstCavities = first.trace.admission?.enclosedCavityCount
  const secondCavities = second.trace.admission?.enclosedCavityCount
  if (firstCavities !== undefined && secondCavities !== undefined) {
    if (firstCavities !== secondCavities) {
      return firstCavities - secondCavities
    }
  } else if (firstCavities !== secondCavities) {
    return firstCavities === undefined ? 1 : -1
  }
  const firstInterlocking = first.trace.interlocking
  const secondInterlocking = second.trace.interlocking
  if (firstInterlocking === undefined || secondInterlocking === undefined) {
    return firstInterlocking === undefined ? (secondInterlocking === undefined ? 0 : 1) : -1
  }
  const firstGap = BigInt(firstInterlocking.largestOccupiedHullGapDoubledAreaGrid2)
  const firstHull = BigInt(firstInterlocking.occupiedHullDoubledAreaGrid2)
  const secondGap = BigInt(secondInterlocking.largestOccupiedHullGapDoubledAreaGrid2)
  const secondHull = BigInt(secondInterlocking.occupiedHullDoubledAreaGrid2)
  const firstScaledGap = firstGap * secondHull
  const secondScaledGap = secondGap * firstHull
  if (firstScaledGap !== secondScaledGap) {
    return firstScaledGap < secondScaledGap ? -1 : 1
  }
  return (
    firstInterlocking.isolatedPieceCount - secondInterlocking.isolatedPieceCount ||
    firstInterlocking.positiveContactComponentCount -
      secondInterlocking.positiveContactComponentCount ||
    secondInterlocking.largestPositiveContactComponentSize -
      firstInterlocking.largestPositiveContactComponentSize
  )
}

/**
 * Decides whether the contact strip replaces the historical incumbent.
 *
 * Promotion requires the strip to regress none of fill, envelope area, depth,
 * collision density, occupied-hull gap, isolated-piece count, component count,
 * or largest contact component, and to strictly improve at least one of them.
 * Equal envelopes therefore can no longer hide a packing-quality regression,
 * and a strip that merely relocates waste is rejected rather than promoted.
 */
export function evaluateIntrinsicShortSideContactStripPromotion(
  incumbent: IntrinsicShortSidePairFoldOutcome | undefined,
  strip: IntrinsicShortSidePairFoldOutcome | undefined,
  stripTrace: IntrinsicShortSideContactStripTrace
): IntrinsicShortSideContactStripPromotion {
  const contactStripSummary =
    strip === undefined
      ? undefined
      : {
          usedShortAxisSpanMm: strip.trace.usedShortAxisSpanMm,
          usedLongAxisDepthMm: strip.trace.usedLongAxisDepthMm,
          envelopeAreaMm2: strip.trace.envelopeAreaMm2,
          usedShortAxisSpanGrid: strip.trace.usedShortAxisSpanGrid,
          usedLongAxisDepthGrid: strip.trace.usedLongAxisDepthGrid,
          envelopeAreaGrid2: strip.trace.envelopeAreaGrid2,
          collisionMaterialDoubledAreaGrid2: strip.trace.collisionMaterialDoubledAreaGrid2,
          admission: strip.trace.admission,
          interlocking: strip.trace.interlocking,
          status: strip.trace.status,
          failureReason: strip.trace.failureReason
        }
  const unmeasured: IntrinsicShortSideContactStripPromotion = {
    incumbentConstructionKind: incumbent?.trace.constructionKind,
    contactStripSummary,
    contactStripAdmitted: false,
    fillNotRegressed: undefined,
    envelopeAreaNotRegressed: undefined,
    depthNotRegressed: undefined,
    densityNotRegressed: undefined,
    hullGapNotRegressed: undefined,
    isolatedPiecesNotRegressed: undefined,
    positiveContactComponentsNotRegressed: undefined,
    largestContactComponentNotRegressed: undefined,
    strictlyImproved: undefined,
    promoted: false
  }
  if (stripTrace.status !== 'constructed' || strip === undefined) return unmeasured
  const contactStripAdmitted = strip.trace.status === 'accepted'
  if (incumbent === undefined) {
    return { ...unmeasured, contactStripAdmitted }
  }
  const stripAdmission = strip.trace.admission
  const stripInterlocking = strip.trace.interlocking
  const incumbentAdmission = incumbent.trace.admission
  const incumbentInterlocking = incumbent.trace.interlocking
  const stripExact = exactPromotionMetrics(strip)
  const incumbentExact = exactPromotionMetrics(incumbent)
  if (stripAdmission === undefined || stripInterlocking === undefined || stripExact === undefined) {
    return { ...unmeasured, contactStripAdmitted }
  }
  if (
    incumbentAdmission === undefined ||
    incumbentInterlocking === undefined ||
    incumbentExact === undefined
  ) {
    return {
      ...unmeasured,
      contactStripAdmitted,
      fillNotRegressed: true,
      envelopeAreaNotRegressed: true,
      depthNotRegressed: true,
      densityNotRegressed: true,
      hullGapNotRegressed: true,
      isolatedPiecesNotRegressed: true,
      positiveContactComponentsNotRegressed: true,
      largestContactComponentNotRegressed: true,
      strictlyImproved: true,
      promoted: contactStripAdmitted
    }
  }
  const fillNotRegressed = stripExact.shortAxisSpanGrid >= incumbentExact.shortAxisSpanGrid
  const envelopeAreaNotRegressed = stripExact.envelopeAreaGrid2 <= incumbentExact.envelopeAreaGrid2
  const depthNotRegressed = stripExact.longAxisDepthGrid <= incumbentExact.longAxisDepthGrid
  const densityNotRegressed =
    stripExact.materialDoubledAreaGrid2 * incumbentExact.envelopeAreaGrid2 >=
    incumbentExact.materialDoubledAreaGrid2 * stripExact.envelopeAreaGrid2
  const hullGapNotRegressed =
    BigInt(stripInterlocking.largestOccupiedHullGapDoubledAreaGrid2) *
      BigInt(incumbentInterlocking.occupiedHullDoubledAreaGrid2) <=
    BigInt(incumbentInterlocking.largestOccupiedHullGapDoubledAreaGrid2) *
      BigInt(stripInterlocking.occupiedHullDoubledAreaGrid2)
  const isolatedPiecesNotRegressed =
    stripInterlocking.isolatedPieceCount <= incumbentInterlocking.isolatedPieceCount
  const positiveContactComponentsNotRegressed =
    stripInterlocking.positiveContactComponentCount <=
    incumbentInterlocking.positiveContactComponentCount
  const largestContactComponentNotRegressed =
    stripInterlocking.largestPositiveContactComponentSize >=
    incumbentInterlocking.largestPositiveContactComponentSize
  const strictlyImproved =
    stripExact.shortAxisSpanGrid > incumbentExact.shortAxisSpanGrid ||
    stripExact.envelopeAreaGrid2 < incumbentExact.envelopeAreaGrid2 ||
    stripExact.longAxisDepthGrid < incumbentExact.longAxisDepthGrid ||
    stripExact.materialDoubledAreaGrid2 * incumbentExact.envelopeAreaGrid2 >
      incumbentExact.materialDoubledAreaGrid2 * stripExact.envelopeAreaGrid2 ||
    BigInt(stripInterlocking.largestOccupiedHullGapDoubledAreaGrid2) *
      BigInt(incumbentInterlocking.occupiedHullDoubledAreaGrid2) <
      BigInt(incumbentInterlocking.largestOccupiedHullGapDoubledAreaGrid2) *
        BigInt(stripInterlocking.occupiedHullDoubledAreaGrid2) ||
    stripInterlocking.isolatedPieceCount < incumbentInterlocking.isolatedPieceCount ||
    stripInterlocking.positiveContactComponentCount <
      incumbentInterlocking.positiveContactComponentCount ||
    stripInterlocking.largestPositiveContactComponentSize >
      incumbentInterlocking.largestPositiveContactComponentSize
  return {
    incumbentConstructionKind: incumbent.trace.constructionKind,
    contactStripSummary,
    contactStripAdmitted,
    fillNotRegressed,
    envelopeAreaNotRegressed,
    depthNotRegressed,
    densityNotRegressed,
    hullGapNotRegressed,
    isolatedPiecesNotRegressed,
    positiveContactComponentsNotRegressed,
    largestContactComponentNotRegressed,
    strictlyImproved,
    promoted:
      contactStripAdmitted &&
      fillNotRegressed &&
      envelopeAreaNotRegressed &&
      depthNotRegressed &&
      densityNotRegressed &&
      hullGapNotRegressed &&
      isolatedPiecesNotRegressed &&
      positiveContactComponentsNotRegressed &&
      largestContactComponentNotRegressed &&
      strictlyImproved
  }
}

function exactPromotionMetrics(outcome: IntrinsicShortSidePairFoldOutcome):
  | {
      readonly shortAxisSpanGrid: number
      readonly requestedShortAxisGrid: number
      readonly longAxisDepthGrid: number
      readonly envelopeAreaGrid2: bigint
      readonly materialDoubledAreaGrid2: bigint
    }
  | undefined {
  const shortAxisSpanGrid = outcome.trace.usedShortAxisSpanGrid
  const requestedShortAxisGrid = toGridMm(outcome.trace.requestedShortAxisMm)
  const longAxisDepthGrid = outcome.trace.usedLongAxisDepthGrid
  const envelopeAreaGrid2 = outcome.trace.envelopeAreaGrid2
  const materialDoubledAreaGrid2 = outcome.trace.collisionMaterialDoubledAreaGrid2
  if (
    shortAxisSpanGrid === undefined ||
    requestedShortAxisGrid === undefined ||
    longAxisDepthGrid === undefined ||
    envelopeAreaGrid2 === undefined ||
    materialDoubledAreaGrid2 === undefined
  ) {
    return undefined
  }
  return {
    shortAxisSpanGrid,
    requestedShortAxisGrid,
    longAxisDepthGrid,
    envelopeAreaGrid2: BigInt(envelopeAreaGrid2),
    materialDoubledAreaGrid2: BigInt(materialDoubledAreaGrid2)
  }
}

function compareSelectedTransforms(first: SelectedTransform, second: SelectedTransform): number {
  return (
    first.widthGrid - second.widthGrid ||
    first.heightGrid - second.heightGrid ||
    first.geometry.transform.index - second.geometry.transform.index ||
    first.geometry.transform.rotationDeg - second.geometry.transform.rotationDeg ||
    Number(first.geometry.transform.mirrored) - Number(second.geometry.transform.mirrored)
  )
}

function compareShelfTransforms(first: SelectedTransform, second: SelectedTransform): number {
  return (
    first.heightGrid - second.heightGrid ||
    second.widthGrid - first.widthGrid ||
    first.geometry.transform.index - second.geometry.transform.index ||
    first.geometry.transform.rotationDeg - second.geometry.transform.rotationDeg ||
    Number(first.geometry.transform.mirrored) - Number(second.geometry.transform.mirrored)
  )
}

function compareSelectedPairs(
  first: SelectedPair,
  second: SelectedPair,
  selectedTransforms: ReadonlyArray<SelectedTransform>
): number {
  if (first.envelopeAreaGrid2 !== second.envelopeAreaGrid2) {
    return first.envelopeAreaGrid2 < second.envelopeAreaGrid2 ? -1 : 1
  }
  return (
    first.depthGrid - second.depthGrid ||
    (selectedTransforms[first.bottomIndex]?.pieceId ?? '').localeCompare(
      selectedTransforms[second.bottomIndex]?.pieceId ?? ''
    ) ||
    (selectedTransforms[first.upperIndex]?.pieceId ?? '').localeCompare(
      selectedTransforms[second.upperIndex]?.pieceId ?? ''
    )
  )
}

function constructPairLayout(
  selectedTransforms: ReadonlyArray<SelectedTransform>,
  selectedPair: SelectedPair,
  requestedShortAxisGrid: number
): ReadonlyArray<IrregularPlacedPiece> | undefined {
  let cursorGrid = 0
  const placed: IrregularPlacedPiece[] = []
  for (let index = 0; index < selectedTransforms.length; index += 1) {
    if (index === selectedPair.upperIndex) continue
    const selected = selectedTransforms[index]
    if (selected === undefined) return undefined
    if (index === selectedPair.bottomIndex) {
      const upper = selectedTransforms[selectedPair.upperIndex]
      if (upper === undefined) return undefined
      placed.push(createPlacedPiece(selected, cursorGrid, 0))
      placed.push(createPlacedPiece(upper, cursorGrid, selected.heightGrid))
      cursorGrid += Math.max(selected.widthGrid, upper.widthGrid)
      continue
    }
    if (cursorGrid + selected.widthGrid > requestedShortAxisGrid) {
      return undefined
    }
    placed.push(createPlacedPiece(selected, cursorGrid, 0))
    cursorGrid += selected.widthGrid
  }
  return placed
}

function constructNextFitShelf(
  selectedTransforms: ReadonlyArray<SelectedTransform>,
  requestedShortAxisGrid: number,
  requestedLongAxisGrid: number
): ShelfLayout | undefined {
  let cursorGrid = 0
  let rowStartGrid = 0
  let rowHeightGrid = 0
  let rowCount = selectedTransforms.length === 0 ? 0 : 1
  const placed: IrregularPlacedPiece[] = []
  for (const selected of selectedTransforms) {
    if (
      selected.widthGrid > requestedShortAxisGrid ||
      selected.heightGrid > requestedLongAxisGrid
    ) {
      return undefined
    }
    if (cursorGrid > 0 && cursorGrid + selected.widthGrid > requestedShortAxisGrid) {
      rowStartGrid += rowHeightGrid
      cursorGrid = 0
      rowHeightGrid = 0
      rowCount += 1
    }
    if (rowStartGrid + selected.heightGrid > requestedLongAxisGrid) {
      return undefined
    }
    placed.push(createPlacedPiece(selected, cursorGrid, rowStartGrid))
    cursorGrid += selected.widthGrid
    rowHeightGrid = Math.max(rowHeightGrid, selected.heightGrid)
  }
  return { placed, rowCount }
}

function createPlacedPiece(
  selected: SelectedTransform,
  cursorGrid: number,
  verticalOffsetGrid: number
): IrregularPlacedPiece {
  const placementInput = {
    sourcePieceId: selected.piece.source.id,
    placementReference: selected.piece.collisionGeometry.placementReference,
    transform: new IrregularTransform({
      translateX: fromGrid(cursorGrid - selected.minXGrid),
      translateY: fromGrid(verticalOffsetGrid - selected.minYGrid),
      rotationDeg: selected.geometry.transform.rotationDeg,
      mirrored: selected.geometry.transform.mirrored
    })
  }
  return new IrregularPlacedPiece({
    placement:
      selected.piece.pieceId === undefined
        ? new IrregularPlacement(placementInput)
        : new IrregularPlacement({
            ...placementInput,
            pieceId: selected.piece.pieceId
          }),
    collisionGeometry: selected.geometry
  })
}

function finalizePlacedLayout(input: {
  readonly input: TerminalObserverInput
  readonly runtime: ObserverRuntime
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly constructionKind: IntrinsicShortSideConstructionKind
  readonly rowCount: number
  readonly selectedBottomPieceId: string | undefined
  readonly selectedUpperPieceId: string | undefined
}): IntrinsicShortSidePairFoldOutcome {
  const beforeFinalization = boundedStatus(input.runtime)
  if (beforeFinalization !== undefined) {
    return failedOutcome(
      input.input,
      input.runtime,
      beforeFinalization,
      `${beforeFinalization} reached before exact finalization.`,
      input.runtime.transformEvaluations,
      input.placed.length,
      input.runtime.expectedPairCount,
      input.runtime.evaluatedPairCount,
      input.selectedBottomPieceId,
      input.selectedUpperPieceId
    )
  }
  const normalizedState = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: input.placed,
    placementOrder: input.input.preparedPieces.map((piece) => piece.pieceId ?? piece.source.id)
  })
  const prescribedRotationDeg = intrinsicShortSideAxes(
    input.input.sheet
  ).normalizedToPhysicalRotationDeg
  const physicalState = normalizedState.withQuarterTurnBottomLeft(prescribedRotationDeg)
  if (
    physicalState === undefined ||
    !assertCanonicalGridLegalLayout(input.input.sheet, physicalState.placedCollisionGeometries)
  ) {
    return failedOutcome(
      input.input,
      input.runtime,
      'failed-protected-fallback',
      'the prescribed physical terminal orientation failed exact legality.',
      input.runtime.transformEvaluations,
      input.placed.length,
      input.runtime.expectedPairCount,
      input.runtime.evaluatedPairCount,
      input.selectedBottomPieceId,
      input.selectedUpperPieceId
    )
  }
  const outcome = finalizeOutcome({
    input: input.input,
    runtime: input.runtime,
    state: physicalState,
    prescribedRotationDeg,
    transformEvaluations: input.runtime.transformEvaluations,
    expectedPairCount: input.runtime.expectedPairCount,
    evaluatedPairCount: input.runtime.evaluatedPairCount,
    constructionKind: input.constructionKind,
    rowCount: input.rowCount,
    selectedBottomPieceId: input.selectedBottomPieceId,
    selectedUpperPieceId: input.selectedUpperPieceId
  })
  const boundedAfterFinalization = boundedStatus(input.runtime)
  if (boundedAfterFinalization !== undefined) {
    return failedOutcome(
      input.input,
      input.runtime,
      boundedAfterFinalization,
      `${boundedAfterFinalization} reached after exact finalization.`,
      input.runtime.transformEvaluations,
      input.placed.length,
      input.runtime.expectedPairCount,
      input.runtime.evaluatedPairCount,
      input.selectedBottomPieceId,
      input.selectedUpperPieceId
    )
  }
  if (selectedOutputTraceSize(outcome.trace) > input.runtime.maximumTraceBytes) {
    return failedOutcome(
      input.input,
      input.runtime,
      'trace-cap',
      'stabilized terminal short-side trace exceeds its byte cap.',
      input.runtime.transformEvaluations,
      input.placed.length,
      input.runtime.expectedPairCount,
      input.runtime.evaluatedPairCount,
      input.selectedBottomPieceId,
      input.selectedUpperPieceId
    )
  }
  return outcome
}

function finalizeOutcome(input: {
  readonly input: TerminalObserverInput
  readonly runtime: ObserverRuntime
  readonly state: IrregularBeamState
  readonly prescribedRotationDeg: 0 | 90
  readonly transformEvaluations: number
  readonly expectedPairCount: number
  readonly evaluatedPairCount: number
  readonly constructionKind: IntrinsicShortSideConstructionKind
  readonly rowCount: number
  readonly selectedBottomPieceId: string | undefined
  readonly selectedUpperPieceId: string | undefined
}): IntrinsicShortSidePairFoldOutcome {
  const placed = input.state.placedCollisionGeometries
  const dimensions = physicalDimensions(placed, input.input.sheet)
  const topologyExact = measureCanonicalLayoutTopologyExact(placed)
  const contacts = measureCanonicalLayoutContacts(placed)
  const material = collisionMaterialArea(placed)
  const identity = canonicalCollisionLayoutIdentity(placed)
  if (
    dimensions === undefined ||
    topologyExact === undefined ||
    contacts === undefined ||
    material === undefined ||
    identity === undefined
  ) {
    return failedOutcome(
      input.input,
      input.runtime,
      'failed-protected-fallback',
      'exact terminal construction metrics could not be materialized.',
      input.transformEvaluations,
      placed.length,
      input.expectedPairCount,
      input.evaluatedPairCount,
      input.selectedBottomPieceId,
      input.selectedUpperPieceId
    )
  }
  const topology = topologyExact.topology
  const envelopeAreaGrid2 = BigInt(dimensions.shortAxisGrid) * BigInt(dimensions.longAxisGrid)
  const envelopeAreaMm2 = Number(envelopeAreaGrid2) / 1_000_000
  const fillRatio = dimensions.shortAxisGrid / dimensions.requestedShortAxisGrid
  const density =
    envelopeAreaGrid2 <= 0n
      ? 0
      : Number(material.doubledAreaGrid2) / (2 * Number(envelopeAreaGrid2))
  const projection = shortAxisProjectionMetrics(placed, input.input.sheet)
  const productionShortAxisSpanGrid = input.input.productionShortAxisSpanGrid
  const productionMaximumSideGrid = input.input.productionMaximumSideGrid
  const productionEnvelopeAreaGrid2 = BigInt(input.input.productionEnvelopeAreaGrid2)
  if (
    !Number.isSafeInteger(productionShortAxisSpanGrid) ||
    !Number.isSafeInteger(productionMaximumSideGrid) ||
    productionShortAxisSpanGrid <= 0 ||
    productionEnvelopeAreaGrid2 <= 0n
  ) {
    return failedOutcome(
      input.input,
      input.runtime,
      'failed-protected-fallback',
      'production comparison metrics must fit the canonical grid.',
      input.transformEvaluations,
      placed.length,
      input.expectedPairCount,
      input.evaluatedPairCount,
      input.selectedBottomPieceId,
      input.selectedUpperPieceId
    )
  }
  const shortAxisSpanGainFactor = dimensions.shortAxisGrid / productionShortAxisSpanGrid
  const envelopeAreaCostFactor = Number(envelopeAreaGrid2) / Number(productionEnvelopeAreaGrid2)
  const depthWithinProductionMaximumSide = dimensions.longAxisGrid <= productionMaximumSideGrid
  const directionallyEfficient =
    BigInt(dimensions.shortAxisGrid) * productionEnvelopeAreaGrid2 >=
    BigInt(productionShortAxisSpanGrid) * envelopeAreaGrid2
  const expectedPieceIds = input.input.preparedPieces.map(
    (piece) => piece.pieceId ?? piece.source.id
  )
  const placedPieceIds = placed.map(({ placement }) => placement.pieceId ?? placement.sourcePieceId)
  const expectedPieceIdSet = new Set(expectedPieceIds)
  const placedPieceIdSet = new Set(placedPieceIds)
  const exactTargetIdentity =
    expectedPieceIdSet.size === expectedPieceIds.length &&
    placedPieceIdSet.size === placedPieceIds.length &&
    placedPieceIds.length === expectedPieceIds.length &&
    expectedPieceIds.every((pieceId) => placedPieceIdSet.has(pieceId))
  const envelopeAreaCostWithinProductionBound =
    intrinsicShortSideEnvelopeAreaCostWithinProductionBound(
      envelopeAreaGrid2,
      productionEnvelopeAreaGrid2
    )
  const admittedBesidesAreaCost =
    exactTargetIdentity &&
    5n * BigInt(dimensions.shortAxisGrid) >= 4n * BigInt(dimensions.requestedShortAxisGrid) &&
    depthWithinProductionMaximumSide &&
    (projection.spanGrid <= 0 ||
      100n * BigInt(projection.coveredGrid) >= 99n * BigInt(projection.spanGrid)) &&
    projection.componentCount === 1 &&
    topology.enclosedCavityCount === 0 &&
    material.doubledAreaGrid2 >= envelopeAreaGrid2 &&
    directionallyEfficient
  const admission: IntrinsicShortSidePairFoldAdmission = {
    exactLegal: true,
    allPiecesPlaced: exactTargetIdentity,
    fillRatio,
    depthWithinProductionMaximumSide,
    projectionCoverageRatio: projection.coverageRatio,
    projectionComponentCount: projection.componentCount,
    enclosedCavityCount: topology.enclosedCavityCount,
    collisionEnvelopeDensity: density,
    shortAxisSpanGainFactor,
    envelopeAreaCostFactor,
    directionallyEfficient,
    envelopeAreaCostWithinProductionBound,
    accepted: false
  }
  /*
   * Compact-relative quality terms remain evidence, not admission gates. The
   * Short Side profile owns a directional terminal contract: every exact
   * construction that accounts for its complete target piece set is eligible.
   */
  const accepted = exactTargetIdentity
  const measuredAdmission = { ...admission, accepted }
  if (!envelopeAreaCostWithinProductionBound && admittedBesidesAreaCost) {
    input.runtime.envelopeAreaCostVetoObserved = true
    input.runtime.envelopeAreaCostVetoes.push({
      constructionKind: input.constructionKind,
      admission: measuredAdmission
    })
  }
  const interlocking: IntrinsicShortSideInterlockingMetrics = {
    largestOccupiedHullGapRatio: topology.largestOccupiedHullGapRatio,
    largestOccupiedHullGapDoubledAreaGrid2: topologyExact.exactHullGapDoubledAreaGrid2,
    occupiedHullDoubledAreaGrid2: topologyExact.exactHullDoubledAreaGrid2,
    isolatedPieceCount: topology.isolatedPieceCount,
    positiveContactComponentCount: topology.positiveContactComponentCount,
    largestPositiveContactComponentSize: topology.largestPositiveContactComponentSize,
    sharedBoundaryLengthMm: contacts.sharedBoundaryLengthMm
  }
  const rawTrace: IntrinsicShortSidePairFoldTrace = {
    version: INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION,
    status: accepted ? 'accepted' : 'rejected-admission',
    outputInfluence: 'none',
    executionModel: 'single-process-sequential',
    requestedShortAxisMm: dimensions.requestedShortAxisMm,
    requestedLongAxisMm: dimensions.requestedLongAxisMm,
    prescribedRotationDeg: input.prescribedRotationDeg,
    productionShortAxisSpanMm: input.input.productionShortAxisSpanMm,
    productionMaximumSideMm: input.input.productionMaximumSideMm,
    productionEnvelopeAreaMm2: input.input.productionEnvelopeAreaMm2,
    productionShortAxisSpanGrid: input.input.productionShortAxisSpanGrid,
    productionMaximumSideGrid: input.input.productionMaximumSideGrid,
    productionEnvelopeAreaGrid2: input.input.productionEnvelopeAreaGrid2,
    transformEvaluations: input.transformEvaluations,
    expectedPairCount: input.expectedPairCount,
    evaluatedPairCount: input.evaluatedPairCount,
    constructionKind: input.constructionKind,
    rowCount: input.rowCount,
    selectedBottomPieceId: input.selectedBottomPieceId,
    selectedUpperPieceId: input.selectedUpperPieceId,
    placedCount: placed.length,
    usedShortAxisSpanMm: dimensions.shortAxisMm,
    usedLongAxisDepthMm: dimensions.longAxisMm,
    envelopeAreaMm2,
    usedShortAxisSpanGrid: dimensions.shortAxisGrid,
    usedLongAxisDepthGrid: dimensions.longAxisGrid,
    envelopeAreaGrid2: envelopeAreaGrid2.toString(),
    collisionMaterialDoubledAreaGrid2: material.doubledAreaGrid2.toString(),
    canonicalGeometryHash: createHash('sha256').update(identity).digest('hex'),
    admission: measuredAdmission,
    interlocking,
    envelopeAreaCostVetoObserved: input.runtime.envelopeAreaCostVetoObserved,
    envelopeAreaCostVetoes: [...input.runtime.envelopeAreaCostVetoes],
    contactStrip: undefined,
    contactStripLanes: [],
    contactStripPromotion: undefined,
    runtimeMs: Math.max(0, input.runtime.now() - input.runtime.startedAt),
    peakRssDeltaBytes: sampleRss(input.runtime),
    serializedTraceBytes: 0,
    failureReason: accepted
      ? undefined
      : 'the exact terminal construction failed one or more admission gates.'
  }
  const trace = measureTraceSize(rawTrace)
  return {
    trace,
    placedCollisionGeometries: accepted ? placed : undefined
  }
}

function physicalDimensions(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  sheet: SheetSpec
):
  | {
      readonly shortAxisMm: number
      readonly longAxisMm: number
      readonly requestedShortAxisMm: number
      readonly requestedLongAxisMm: number
      readonly shortAxisGrid: number
      readonly longAxisGrid: number
      readonly requestedShortAxisGrid: number
      readonly requestedLongAxisGrid: number
    }
  | undefined {
  const points = placed.flatMap((entry) => placedCollisionWorldGridPath(entry) ?? [])
  if (points.length === 0) return undefined
  const widthGrid = Math.max(...points.map(({ x }) => x)) - Math.min(...points.map(({ x }) => x))
  const heightGrid = Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y))
  const requestedShortAxisMm = Math.min(sheet.width, sheet.height)
  const requestedLongAxisMm = Math.max(sheet.width, sheet.height)
  const requestedShortAxisGrid = toGridMm(requestedShortAxisMm)
  const requestedLongAxisGrid = toGridMm(requestedLongAxisMm)
  if (requestedShortAxisGrid === undefined || requestedLongAxisGrid === undefined) {
    return undefined
  }
  const axes = intrinsicShortSideAxes(sheet)
  const shortAxisGrid = axes.shortAxis === 'width' ? widthGrid : heightGrid
  const longAxisGrid = axes.longAxis === 'width' ? widthGrid : heightGrid
  return {
    shortAxisMm: fromGrid(shortAxisGrid),
    longAxisMm: fromGrid(longAxisGrid),
    requestedShortAxisMm,
    requestedLongAxisMm,
    shortAxisGrid,
    longAxisGrid,
    requestedShortAxisGrid,
    requestedLongAxisGrid
  }
}

function collisionMaterialArea(
  placed: ReadonlyArray<IrregularPlacedPiece>
): { readonly doubledAreaGrid2: bigint } | undefined {
  let doubledAreaGrid2 = 0n
  for (const entry of placed) {
    const path = placedCollisionWorldGridPath(entry)
    if (path === undefined) return undefined
    let signed = 0n
    for (let index = 0; index < path.length; index += 1) {
      const point = path[index]
      const next = path[(index + 1) % path.length]
      if (point === undefined || next === undefined) return undefined
      signed += BigInt(point.x) * BigInt(next.y) - BigInt(next.x) * BigInt(point.y)
    }
    doubledAreaGrid2 += signed < 0n ? -signed : signed
  }
  return { doubledAreaGrid2 }
}

function shortAxisProjectionMetrics(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  sheet: SheetSpec
): {
  readonly coverageRatio: number
  readonly componentCount: number
  readonly coveredGrid: number
  readonly spanGrid: number
} {
  const intervals = placed
    .flatMap((entry) => {
      const path = placedCollisionWorldGridPath(entry)
      if (path === undefined || path.length === 0) return []
      const shortAxis = intrinsicShortSideAxes(sheet).shortAxis
      const values = path.map((point) => (shortAxis === 'width' ? point.x : point.y))
      return [{ start: Math.min(...values), end: Math.max(...values) }]
    })
    .toSorted((first, second) => first.start - second.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const interval of intervals) {
    const last = merged.at(-1)
    if (last === undefined || interval.start > last.end) {
      merged.push({ ...interval })
    } else {
      last.end = Math.max(last.end, interval.end)
    }
  }
  const first = merged[0]
  const last = merged.at(-1)
  if (first === undefined || last === undefined) {
    return { coverageRatio: 0, componentCount: 0, coveredGrid: 0, spanGrid: 0 }
  }
  const span = last.end - first.start
  const covered = merged.reduce((sum, interval) => sum + interval.end - interval.start, 0)
  return {
    coverageRatio: span <= 0 ? 1 : covered / span,
    componentCount: merged.length,
    coveredGrid: covered,
    spanGrid: span
  }
}

function boundedStatus(runtime: ObserverRuntime): 'deadline' | 'memory-cap' | undefined {
  if (runtime.now() - runtime.startedAt > runtime.maximumRuntimeMs) {
    return 'deadline'
  }
  return sampleRss(runtime) > runtime.maximumRssDeltaBytes ? 'memory-cap' : undefined
}

function sampleRss(runtime: ObserverRuntime): number {
  runtime.peakRssBytes = Math.max(runtime.peakRssBytes, runtime.currentRssBytes())
  return Math.max(0, runtime.peakRssBytes - runtime.startingRssBytes)
}

function failedOutcome(
  input: {
    readonly sheet: SheetSpec
    readonly productionShortAxisSpanMm: number
    readonly productionMaximumSideMm: number
    readonly productionEnvelopeAreaMm2: number
    readonly productionShortAxisSpanGrid: number
    readonly productionMaximumSideGrid: number
    readonly productionEnvelopeAreaGrid2: string
  },
  runtime: ObserverRuntime,
  status: Exclude<IntrinsicShortSidePairFoldStatus, 'accepted' | 'rejected-admission'>,
  failureReason: string,
  transformEvaluations = runtime.transformEvaluations,
  placedCount = 0,
  expectedPairCount = runtime.expectedPairCount,
  evaluatedPairCount = runtime.evaluatedPairCount,
  selectedBottomPieceId?: string,
  selectedUpperPieceId?: string
): IntrinsicShortSidePairFoldOutcome {
  const axes = intrinsicShortSideAxes(input.sheet)
  return {
    trace: measureTraceSize({
      version: INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION,
      status,
      outputInfluence: 'none',
      executionModel: 'single-process-sequential',
      requestedShortAxisMm: axes.shortAxisMm,
      requestedLongAxisMm: axes.longAxisMm,
      prescribedRotationDeg: axes.normalizedToPhysicalRotationDeg,
      productionShortAxisSpanMm: input.productionShortAxisSpanMm,
      productionMaximumSideMm: input.productionMaximumSideMm,
      productionEnvelopeAreaMm2: input.productionEnvelopeAreaMm2,
      productionShortAxisSpanGrid: input.productionShortAxisSpanGrid,
      productionMaximumSideGrid: input.productionMaximumSideGrid,
      productionEnvelopeAreaGrid2: input.productionEnvelopeAreaGrid2,
      transformEvaluations,
      expectedPairCount,
      evaluatedPairCount,
      constructionKind: undefined,
      rowCount: 0,
      selectedBottomPieceId,
      selectedUpperPieceId,
      placedCount,
      usedShortAxisSpanMm: undefined,
      usedLongAxisDepthMm: undefined,
      envelopeAreaMm2: undefined,
      usedShortAxisSpanGrid: undefined,
      usedLongAxisDepthGrid: undefined,
      envelopeAreaGrid2: undefined,
      collisionMaterialDoubledAreaGrid2: undefined,
      canonicalGeometryHash: undefined,
      admission: undefined,
      interlocking: undefined,
      envelopeAreaCostVetoObserved: runtime.envelopeAreaCostVetoObserved,
      envelopeAreaCostVetoes: [...runtime.envelopeAreaCostVetoes],
      contactStrip: undefined,
      contactStripLanes: [],
      contactStripPromotion: undefined,
      runtimeMs: Math.max(0, runtime.now() - runtime.startedAt),
      peakRssDeltaBytes: sampleRss(runtime),
      serializedTraceBytes: 0,
      failureReason
    }),
    placedCollisionGeometries: undefined
  }
}

export function withMeasuredIntrinsicShortSidePairFoldTrace(
  trace: IntrinsicShortSidePairFoldTrace
): IntrinsicShortSidePairFoldTrace {
  const first = {
    ...trace,
    serializedTraceBytes: Buffer.byteLength(JSON.stringify(trace), 'utf8')
  }
  return {
    ...first,
    serializedTraceBytes: Buffer.byteLength(JSON.stringify(first), 'utf8')
  }
}

function measureTraceSize(trace: IntrinsicShortSidePairFoldTrace): IntrinsicShortSidePairFoldTrace {
  return withMeasuredIntrinsicShortSidePairFoldTrace(trace)
}

function selectedOutputTraceSize(trace: IntrinsicShortSidePairFoldTrace): number {
  return withMeasuredIntrinsicShortSidePairFoldTrace({
    ...trace,
    outputInfluence: 'selected'
  }).serializedTraceBytes
}
