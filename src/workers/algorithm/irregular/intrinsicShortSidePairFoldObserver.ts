import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Effect } from 'effect'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularTransform,
  type IrregularPreparedPiece,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutTopology,
  placedCollisionWorldGridPath
} from '../../irregular/canonicalLayoutGeometry.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel } from '../../irregular/geometryKernel.js'
import { IrregularBeamState } from './irregularBeamState.js'

export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION =
  'intrinsic-short-side-terminal-observer-v2' as const
export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RUNTIME_MS = 500 as const
export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RSS_DELTA_BYTES = 64 * 1_048_576
export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_TRACE_BYTES = 1_048_576 as const

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
  readonly accepted: boolean
}

export interface IntrinsicShortSidePairFoldTrace {
  readonly version: typeof INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION
  readonly status: IntrinsicShortSidePairFoldStatus
  readonly outputInfluence: 'none'
  readonly executionModel: 'single-process-sequential'
  readonly requestedShortAxisMm: number
  readonly requestedLongAxisMm: number
  readonly prescribedRotationDeg: 0 | 90 | undefined
  readonly productionShortAxisSpanMm: number
  readonly productionMaximumSideMm: number
  readonly productionEnvelopeAreaMm2: number
  readonly transformEvaluations: number
  readonly expectedPairCount: number
  readonly evaluatedPairCount: number
  readonly constructionKind: 'pair-fold' | 'multi-row-shelf' | undefined
  readonly rowCount: number
  readonly selectedBottomPieceId: string | undefined
  readonly selectedUpperPieceId: string | undefined
  readonly placedCount: number
  readonly usedShortAxisSpanMm: number | undefined
  readonly usedLongAxisDepthMm: number | undefined
  readonly envelopeAreaMm2: number | undefined
  readonly canonicalGeometryHash: string | undefined
  readonly admission: IntrinsicShortSidePairFoldAdmission | undefined
  readonly runtimeMs: number
  readonly peakRssDeltaBytes: number
  readonly serializedTraceBytes: number
  readonly failureReason: string | undefined
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

/** Evaluates bounded exact terminal layouts without NFP or beam search. */
export function observeIntrinsicShortSidePairFold(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly productionShortAxisSpanMm: number
  readonly productionMaximumSideMm: number
  readonly productionEnvelopeAreaMm2: number
  readonly runtimeControl?: IntrinsicShortSidePairFoldRuntimeControl
}): Effect.Effect<IntrinsicShortSidePairFoldOutcome, never, GeometryKernel> {
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

function constructPairFold(
  input: {
    readonly sheet: SheetSpec
    readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly productionShortAxisSpanMm: number
    readonly productionMaximumSideMm: number
    readonly productionEnvelopeAreaMm2: number
    readonly runtimeControl?: IntrinsicShortSidePairFoldRuntimeControl
  },
  runtime: ObserverRuntime
) {
  return Effect.gen(function* () {
    const requestedShortAxisMm = Math.min(input.sheet.width, input.sheet.height)
    if (input.sheet.width === input.sheet.height) {
      return failedOutcome(
        input,
        runtime,
        'skipped-square-sheet',
        'square sheets do not define a physical short edge.'
      )
    }
    const geometryKernel = yield* GeometryKernel
    const requestedShortAxisGrid = toGridMm(requestedShortAxisMm)
    const requestedLongAxisGrid = toGridMm(Math.max(input.sheet.width, input.sheet.height))
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
    if (runtime.expectedPairCount === 0) {
      return failedOutcome(
        input,
        runtime,
        'no-pair',
        'the terminal pair fold requires at least two prepared pieces.',
        runtime.transformEvaluations,
        0,
        runtime.expectedPairCount,
        0
      )
    }
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
      const pairOutcome = finalizePlacedLayout({
        input,
        runtime,
        placed: pairPlaced,
        constructionKind: 'pair-fold',
        rowCount: 1,
        selectedBottomPieceId: selectedTransforms[selectedPair.bottomIndex]?.pieceId,
        selectedUpperPieceId: selectedTransforms[selectedPair.upperIndex]?.pieceId
      })
      if (pairOutcome.trace.status === 'accepted') {
        return pairOutcome
      }
    }

    const shelf = constructNextFitShelf(
      shelfTransforms,
      requestedShortAxisGrid,
      requestedLongAxisGrid
    )
    if (shelf === undefined) {
      return failedOutcome(
        input,
        runtime,
        'no-fitting-pair',
        'neither the fixed-transform pair fold nor the deterministic multi-row shelf fits both requested sheet axes.',
        runtime.transformEvaluations,
        0,
        runtime.expectedPairCount,
        runtime.evaluatedPairCount
      )
    }
    return finalizePlacedLayout({
      input,
      runtime,
      placed: shelf.placed,
      constructionKind: 'multi-row-shelf',
      rowCount: shelf.rowCount,
      selectedBottomPieceId: undefined,
      selectedUpperPieceId: undefined
    })
  })
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
  readonly input: {
    readonly sheet: SheetSpec
    readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly productionShortAxisSpanMm: number
    readonly productionMaximumSideMm: number
    readonly productionEnvelopeAreaMm2: number
  }
  readonly runtime: ObserverRuntime
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly constructionKind: 'pair-fold' | 'multi-row-shelf'
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
  const prescribedRotationDeg = input.input.sheet.width < input.input.sheet.height ? 0 : 90
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
  if (outcome.trace.serializedTraceBytes > input.runtime.maximumTraceBytes) {
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
  readonly input: {
    readonly sheet: SheetSpec
    readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly productionShortAxisSpanMm: number
    readonly productionMaximumSideMm: number
    readonly productionEnvelopeAreaMm2: number
  }
  readonly runtime: ObserverRuntime
  readonly state: IrregularBeamState
  readonly prescribedRotationDeg: 0 | 90
  readonly transformEvaluations: number
  readonly expectedPairCount: number
  readonly evaluatedPairCount: number
  readonly constructionKind: 'pair-fold' | 'multi-row-shelf'
  readonly rowCount: number
  readonly selectedBottomPieceId: string | undefined
  readonly selectedUpperPieceId: string | undefined
}): IntrinsicShortSidePairFoldOutcome {
  const placed = input.state.placedCollisionGeometries
  const dimensions = physicalDimensions(placed, input.input.sheet)
  const topology = measureCanonicalLayoutTopology(placed)
  const materialAreaMm2 = collisionMaterialAreaMm2(placed)
  const identity = canonicalCollisionLayoutIdentity(placed)
  if (
    dimensions === undefined ||
    topology === undefined ||
    materialAreaMm2 === undefined ||
    identity === undefined
  ) {
    return failedOutcome(
      input.input,
      input.runtime,
      'failed-protected-fallback',
      'exact pair-fold metrics could not be materialized.',
      input.transformEvaluations,
      placed.length,
      input.expectedPairCount,
      input.evaluatedPairCount,
      input.selectedBottomPieceId,
      input.selectedUpperPieceId
    )
  }
  const envelopeAreaMm2 = dimensions.shortAxisMm * dimensions.longAxisMm
  const fillRatio = dimensions.shortAxisMm / dimensions.requestedShortAxisMm
  const density = envelopeAreaMm2 <= 0 ? 0 : materialAreaMm2 / envelopeAreaMm2
  const projection = shortAxisProjectionMetrics(placed, input.input.sheet)
  const shortAxisSpanGainFactor =
    input.input.productionShortAxisSpanMm <= 0
      ? 0
      : dimensions.shortAxisMm / input.input.productionShortAxisSpanMm
  const envelopeAreaCostFactor =
    input.input.productionEnvelopeAreaMm2 <= 0
      ? Number.POSITIVE_INFINITY
      : envelopeAreaMm2 / input.input.productionEnvelopeAreaMm2
  const admission: IntrinsicShortSidePairFoldAdmission = {
    exactLegal: true,
    allPiecesPlaced: placed.length === input.input.preparedPieces.length,
    fillRatio,
    depthWithinProductionMaximumSide: dimensions.longAxisMm <= input.input.productionMaximumSideMm,
    projectionCoverageRatio: projection.coverageRatio,
    projectionComponentCount: projection.componentCount,
    enclosedCavityCount: topology.enclosedCavityCount,
    collisionEnvelopeDensity: density,
    shortAxisSpanGainFactor,
    envelopeAreaCostFactor,
    directionallyEfficient: shortAxisSpanGainFactor >= envelopeAreaCostFactor,
    accepted: false
  }
  const accepted =
    admission.allPiecesPlaced &&
    fillRatio >= 0.8 &&
    admission.depthWithinProductionMaximumSide &&
    projection.coverageRatio >= 0.99 &&
    projection.componentCount === 1 &&
    topology.enclosedCavityCount === 0 &&
    density >= 0.5 &&
    admission.directionallyEfficient
  const measuredAdmission = { ...admission, accepted }
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
    canonicalGeometryHash: createHash('sha256').update(identity).digest('hex'),
    admission: measuredAdmission,
    runtimeMs: Math.max(0, input.runtime.now() - input.runtime.startedAt),
    peakRssDeltaBytes: sampleRss(input.runtime),
    serializedTraceBytes: 0,
    failureReason: accepted ? undefined : 'exact pair fold failed one or more admission gates.'
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
    }
  | undefined {
  const points = placed.flatMap((entry) => placedCollisionWorldGridPath(entry) ?? [])
  if (points.length === 0) return undefined
  const widthMm = fromGrid(
    Math.max(...points.map(({ x }) => x)) - Math.min(...points.map(({ x }) => x))
  )
  const heightMm = fromGrid(
    Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y))
  )
  return {
    shortAxisMm: sheet.width < sheet.height ? widthMm : heightMm,
    longAxisMm: sheet.width < sheet.height ? heightMm : widthMm,
    requestedShortAxisMm: Math.min(sheet.width, sheet.height),
    requestedLongAxisMm: Math.max(sheet.width, sheet.height)
  }
}

function collisionMaterialAreaMm2(placed: ReadonlyArray<IrregularPlacedPiece>): number | undefined {
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
  const areaMm2 = Number(doubledAreaGrid2) / 2_000_000
  return Number.isFinite(areaMm2) ? areaMm2 : undefined
}

function shortAxisProjectionMetrics(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  sheet: SheetSpec
): { readonly coverageRatio: number; readonly componentCount: number } {
  const intervals = placed
    .flatMap((entry) => {
      const path = placedCollisionWorldGridPath(entry)
      if (path === undefined || path.length === 0) return []
      const values = path.map((point) => (sheet.width < sheet.height ? point.x : point.y))
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
    return { coverageRatio: 0, componentCount: 0 }
  }
  const span = last.end - first.start
  const covered = merged.reduce((sum, interval) => sum + interval.end - interval.start, 0)
  return {
    coverageRatio: span <= 0 ? 1 : covered / span,
    componentCount: merged.length
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
  return {
    trace: measureTraceSize({
      version: INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION,
      status,
      outputInfluence: 'none',
      executionModel: 'single-process-sequential',
      requestedShortAxisMm: Math.min(input.sheet.width, input.sheet.height),
      requestedLongAxisMm: Math.max(input.sheet.width, input.sheet.height),
      prescribedRotationDeg:
        input.sheet.width === input.sheet.height
          ? undefined
          : input.sheet.width < input.sheet.height
            ? 0
            : 90,
      productionShortAxisSpanMm: input.productionShortAxisSpanMm,
      productionMaximumSideMm: input.productionMaximumSideMm,
      productionEnvelopeAreaMm2: input.productionEnvelopeAreaMm2,
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
      canonicalGeometryHash: undefined,
      admission: undefined,
      runtimeMs: Math.max(0, runtime.now() - runtime.startedAt),
      peakRssDeltaBytes: sampleRss(runtime),
      serializedTraceBytes: 0,
      failureReason
    }),
    placedCollisionGeometries: undefined
  }
}

function measureTraceSize(trace: IntrinsicShortSidePairFoldTrace): IntrinsicShortSidePairFoldTrace {
  const first = {
    ...trace,
    serializedTraceBytes: Buffer.byteLength(JSON.stringify(trace), 'utf8')
  }
  return {
    ...first,
    serializedTraceBytes: Buffer.byteLength(JSON.stringify(first), 'utf8')
  }
}
