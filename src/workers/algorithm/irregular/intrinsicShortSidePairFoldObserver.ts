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
import {
  fromGrid,
  toGridMm
} from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel } from '../../irregular/geometryKernel.js'
import { IrregularBeamState } from './irregularBeamState.js'

export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION =
  'intrinsic-short-side-pair-fold-observer-v1' as const
export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RUNTIME_MS = 500 as const
export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RSS_DELTA_BYTES =
  64 * 1_048_576
export const INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_TRACE_BYTES =
  1_048_576 as const

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
  readonly placedCollisionGeometries:
    | ReadonlyArray<IrregularPlacedPiece>
    | undefined
}

interface ObserverRuntime {
  readonly startedAt: number
  readonly startingRssBytes: number
  peakRssBytes: number
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

/** Constructs one exact, search-free terminal pair fold along the physical short edge. */
export function observeIntrinsicShortSidePairFold(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly productionShortAxisSpanMm: number
  readonly productionMaximumSideMm: number
  readonly productionEnvelopeAreaMm2: number
}): Effect.Effect<IntrinsicShortSidePairFoldOutcome, never, GeometryKernel> {
  const runtime: ObserverRuntime = {
    startedAt: performance.now(),
    startingRssBytes: process.memoryUsage.rss(),
    peakRssBytes: process.memoryUsage.rss()
  }
  return constructPairFold(input, runtime).pipe(
    Effect.catchTags({
      IrregularGeometryInputError: (error) =>
        Effect.succeed(
          failedOutcome(
            input,
            runtime,
            'failed-protected-fallback',
            error.message
          )
        ),
      IrregularNestingNotImplementedError: (error) =>
        Effect.succeed(
          failedOutcome(
            input,
            runtime,
            'failed-protected-fallback',
            error.message
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
  },
  runtime: ObserverRuntime
) {
  return Effect.gen(function* () {
    const requestedShortAxisMm = Math.min(
      input.sheet.width,
      input.sheet.height
    )
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
    if (requestedShortAxisGrid === undefined) {
      return failedOutcome(
        input,
        runtime,
        'failed-protected-fallback',
        'requested short axis must fit the canonical grid.'
      )
    }

    let transformEvaluations = 0
    const selectedTransforms: SelectedTransform[] = []
    for (const piece of input.preparedPieces) {
      let selected: SelectedTransform | undefined
      for (const transform of piece.transforms) {
        transformEvaluations += 1
        const geometry = yield* geometryKernel.transformCollisionGeometry({
          geometry: piece.collisionGeometry,
          transform
        })
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
        if (
          candidate.widthGrid <= 0 ||
          candidate.heightGrid <= 0
        ) {
          continue
        }
        if (
          selected === undefined ||
          compareSelectedTransforms(candidate, selected) < 0
        ) {
          selected = candidate
        }
      }
      const bounded = boundedStatus(runtime)
      if (bounded !== undefined) {
        return failedOutcome(
          input,
          runtime,
          bounded,
          `${bounded} reached after ${transformEvaluations} transform evaluations.`,
          transformEvaluations,
          0
        )
      }
      if (selected === undefined) {
        return failedOutcome(
          input,
          runtime,
          'failed-protected-fallback',
          `piece ${piece.pieceId ?? piece.source.id} has no valid pair-fold transform.`,
          transformEvaluations,
          0
        )
      }
      selectedTransforms.push(selected)
    }

    const expectedPairCount =
      (selectedTransforms.length * (selectedTransforms.length - 1)) / 2
    if (expectedPairCount === 0) {
      return failedOutcome(
        input,
        runtime,
        'no-pair',
        'the terminal pair fold requires at least two prepared pieces.',
        transformEvaluations,
        0,
        expectedPairCount,
        0
      )
    }
    const totalWidthGrid = selectedTransforms.reduce(
      (sum, selected) => sum + selected.widthGrid,
      0
    )
    let evaluatedPairCount = 0
    let selectedPair: SelectedPair | undefined
    for (
      let bottomIndex = 0;
      bottomIndex < selectedTransforms.length - 1;
      bottomIndex += 1
    ) {
      const bottom = selectedTransforms[bottomIndex]
      if (bottom === undefined) continue
      for (
        let upperIndex = bottomIndex + 1;
        upperIndex < selectedTransforms.length;
        upperIndex += 1
      ) {
        const upper = selectedTransforms[upperIndex]
        if (upper === undefined) continue
        evaluatedPairCount += 1
        const bounded = boundedStatus(runtime)
        if (bounded !== undefined) {
          return failedOutcome(
            input,
            runtime,
            bounded,
            `${bounded} reached after ${evaluatedPairCount} pair evaluations.`,
            transformEvaluations,
            0,
            expectedPairCount,
            evaluatedPairCount
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
        const depthGrid = Math.max(
          bottom.heightGrid + upper.heightGrid,
          otherMaximumHeightGrid
        )
        if (widthGrid > requestedShortAxisGrid) continue
        const candidate: SelectedPair = {
          bottomIndex,
          upperIndex,
          widthGrid,
          depthGrid,
          envelopeAreaGrid2: BigInt(widthGrid) * BigInt(depthGrid)
        }
        if (
          selectedPair === undefined ||
          compareSelectedPairs(
            candidate,
            selectedPair,
            selectedTransforms
          ) < 0
        ) {
          selectedPair = candidate
        }
      }
    }
    if (selectedPair === undefined) {
      return failedOutcome(
        input,
        runtime,
        'no-fitting-pair',
        'no single fixed-transform pair fold fits the requested short axis.',
        transformEvaluations,
        0,
        expectedPairCount,
        evaluatedPairCount
      )
    }

    let cursorGrid = 0
    const placed: IrregularPlacedPiece[] = []
    for (
      let index = 0;
      index < selectedTransforms.length;
      index += 1
    ) {
      if (index === selectedPair.upperIndex) continue
      const selected = selectedTransforms[index]
      if (selected === undefined) continue
      if (index === selectedPair.bottomIndex) {
        const upper = selectedTransforms[selectedPair.upperIndex]
        if (upper === undefined) {
          return failedOutcome(
            input,
            runtime,
            'failed-protected-fallback',
            'the selected upper pair member was unavailable.',
            transformEvaluations,
            placed.length,
            expectedPairCount,
            evaluatedPairCount
          )
        }
        placed.push(createPlacedPiece(selected, cursorGrid, 0))
        placed.push(
          createPlacedPiece(
            upper,
            cursorGrid,
            selected.heightGrid
          )
        )
        cursorGrid += Math.max(
          selected.widthGrid,
          upper.widthGrid
        )
        continue
      }
      if (cursorGrid + selected.widthGrid > requestedShortAxisGrid) {
        return failedOutcome(
          input,
          runtime,
          'failed-protected-fallback',
          'selected pair accounting exceeded the requested short axis.',
          transformEvaluations,
          placed.length,
          expectedPairCount,
          evaluatedPairCount
        )
      }
      placed.push(createPlacedPiece(selected, cursorGrid, 0))
      cursorGrid += selected.widthGrid
    }

    const beforeFinalization = boundedStatus(runtime)
    if (beforeFinalization !== undefined) {
      return failedOutcome(
        input,
        runtime,
        beforeFinalization,
        `${beforeFinalization} reached before exact finalization.`,
        transformEvaluations,
        placed.length,
        expectedPairCount,
        evaluatedPairCount,
        selectedTransforms[selectedPair.bottomIndex]?.pieceId,
        selectedTransforms[selectedPair.upperIndex]?.pieceId
      )
    }
    const normalizedState = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: placed,
      placementOrder: input.preparedPieces.map(
        (piece) => piece.pieceId ?? piece.source.id
      )
    })
    const prescribedRotationDeg =
      input.sheet.width < input.sheet.height ? 0 : 90
    const physicalState =
      normalizedState.withQuarterTurnBottomLeft(
        prescribedRotationDeg
      )
    if (
      physicalState === undefined ||
      !assertCanonicalGridLegalLayout(
        input.sheet,
        physicalState.placedCollisionGeometries
      )
    ) {
      return failedOutcome(
        input,
        runtime,
        'failed-protected-fallback',
        'the prescribed physical pair-fold orientation failed exact legality.',
        transformEvaluations,
        placed.length,
        expectedPairCount,
        evaluatedPairCount,
        selectedTransforms[selectedPair.bottomIndex]?.pieceId,
        selectedTransforms[selectedPair.upperIndex]?.pieceId
      )
    }
    const outcome = finalizeOutcome({
      input,
      runtime,
      state: physicalState,
      prescribedRotationDeg,
      transformEvaluations,
      expectedPairCount,
      evaluatedPairCount,
      selectedBottomPieceId:
        selectedTransforms[selectedPair.bottomIndex]?.pieceId,
      selectedUpperPieceId:
        selectedTransforms[selectedPair.upperIndex]?.pieceId
    })
    const boundedAfterFinalization = boundedStatus(runtime)
    if (boundedAfterFinalization !== undefined) {
      return failedOutcome(
        input,
        runtime,
        boundedAfterFinalization,
        `${boundedAfterFinalization} reached after exact finalization.`,
        transformEvaluations,
        placed.length,
        expectedPairCount,
        evaluatedPairCount,
        selectedTransforms[selectedPair.bottomIndex]?.pieceId,
        selectedTransforms[selectedPair.upperIndex]?.pieceId
      )
    }
    if (
      outcome.trace.serializedTraceBytes >
      INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_TRACE_BYTES
    ) {
      return failedOutcome(
        input,
        runtime,
        'trace-cap',
        'stabilized pair-fold trace exceeds its byte cap.',
        transformEvaluations,
        placed.length,
        expectedPairCount,
        evaluatedPairCount,
        selectedTransforms[selectedPair.bottomIndex]?.pieceId,
        selectedTransforms[selectedPair.upperIndex]?.pieceId
      )
    }
    return outcome
  })
}

function compareSelectedTransforms(
  first: SelectedTransform,
  second: SelectedTransform
): number {
  return (
    first.widthGrid - second.widthGrid ||
    first.heightGrid - second.heightGrid ||
    first.geometry.transform.index - second.geometry.transform.index ||
    first.geometry.transform.rotationDeg -
      second.geometry.transform.rotationDeg ||
    Number(first.geometry.transform.mirrored) -
      Number(second.geometry.transform.mirrored)
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

function createPlacedPiece(
  selected: SelectedTransform,
  cursorGrid: number,
  verticalOffsetGrid: number
): IrregularPlacedPiece {
  const placementInput = {
    sourcePieceId: selected.piece.source.id,
    placementReference:
      selected.piece.collisionGeometry.placementReference,
    transform: new IrregularTransform({
      translateX: fromGrid(cursorGrid - selected.minXGrid),
      translateY: fromGrid(
        verticalOffsetGrid - selected.minYGrid
      ),
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
  readonly selectedBottomPieceId: string | undefined
  readonly selectedUpperPieceId: string | undefined
}): IntrinsicShortSidePairFoldOutcome {
  const placed = input.state.placedCollisionGeometries
  const dimensions = physicalDimensions(
    placed,
    input.input.sheet
  )
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
  const envelopeAreaMm2 =
    dimensions.shortAxisMm * dimensions.longAxisMm
  const fillRatio =
    dimensions.shortAxisMm / dimensions.requestedShortAxisMm
  const density =
    envelopeAreaMm2 <= 0
      ? 0
      : materialAreaMm2 / envelopeAreaMm2
  const projection = shortAxisProjectionMetrics(
    placed,
    input.input.sheet
  )
  const shortAxisSpanGainFactor =
    input.input.productionShortAxisSpanMm <= 0
      ? 0
      : dimensions.shortAxisMm /
        input.input.productionShortAxisSpanMm
  const envelopeAreaCostFactor =
    input.input.productionEnvelopeAreaMm2 <= 0
      ? Number.POSITIVE_INFINITY
      : envelopeAreaMm2 /
        input.input.productionEnvelopeAreaMm2
  const admission: IntrinsicShortSidePairFoldAdmission = {
    exactLegal: true,
    allPiecesPlaced:
      placed.length === input.input.preparedPieces.length,
    fillRatio,
    depthWithinProductionMaximumSide:
      dimensions.longAxisMm <=
      input.input.productionMaximumSideMm,
    projectionCoverageRatio: projection.coverageRatio,
    projectionComponentCount: projection.componentCount,
    enclosedCavityCount: topology.enclosedCavityCount,
    collisionEnvelopeDensity: density,
    shortAxisSpanGainFactor,
    envelopeAreaCostFactor,
    directionallyEfficient:
      shortAxisSpanGainFactor >= envelopeAreaCostFactor,
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
    productionShortAxisSpanMm:
      input.input.productionShortAxisSpanMm,
    productionMaximumSideMm:
      input.input.productionMaximumSideMm,
    productionEnvelopeAreaMm2:
      input.input.productionEnvelopeAreaMm2,
    transformEvaluations: input.transformEvaluations,
    expectedPairCount: input.expectedPairCount,
    evaluatedPairCount: input.evaluatedPairCount,
    selectedBottomPieceId: input.selectedBottomPieceId,
    selectedUpperPieceId: input.selectedUpperPieceId,
    placedCount: placed.length,
    usedShortAxisSpanMm: dimensions.shortAxisMm,
    usedLongAxisDepthMm: dimensions.longAxisMm,
    envelopeAreaMm2,
    canonicalGeometryHash: createHash('sha256')
      .update(identity)
      .digest('hex'),
    admission: measuredAdmission,
    runtimeMs: Math.max(
      0,
      performance.now() - input.runtime.startedAt
    ),
    peakRssDeltaBytes: sampleRss(input.runtime),
    serializedTraceBytes: 0,
    failureReason: accepted
      ? undefined
      : 'exact pair fold failed one or more admission gates.'
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
  const points = placed.flatMap(
    (entry) => placedCollisionWorldGridPath(entry) ?? []
  )
  if (points.length === 0) return undefined
  const widthMm = fromGrid(
    Math.max(...points.map(({ x }) => x)) -
      Math.min(...points.map(({ x }) => x))
  )
  const heightMm = fromGrid(
    Math.max(...points.map(({ y }) => y)) -
      Math.min(...points.map(({ y }) => y))
  )
  return {
    shortAxisMm:
      sheet.width < sheet.height ? widthMm : heightMm,
    longAxisMm:
      sheet.width < sheet.height ? heightMm : widthMm,
    requestedShortAxisMm: Math.min(sheet.width, sheet.height),
    requestedLongAxisMm: Math.max(sheet.width, sheet.height)
  }
}

function collisionMaterialAreaMm2(
  placed: ReadonlyArray<IrregularPlacedPiece>
): number | undefined {
  let doubledAreaGrid2 = 0n
  for (const entry of placed) {
    const path = placedCollisionWorldGridPath(entry)
    if (path === undefined) return undefined
    let signed = 0n
    for (let index = 0; index < path.length; index += 1) {
      const point = path[index]
      const next = path[(index + 1) % path.length]
      if (point === undefined || next === undefined) return undefined
      signed +=
        BigInt(point.x) * BigInt(next.y) -
        BigInt(next.x) * BigInt(point.y)
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
      const values = path.map((point) =>
        sheet.width < sheet.height ? point.x : point.y
      )
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
  const covered = merged.reduce(
    (sum, interval) => sum + interval.end - interval.start,
    0
  )
  return {
    coverageRatio: span <= 0 ? 1 : covered / span,
    componentCount: merged.length
  }
}

function boundedStatus(
  runtime: ObserverRuntime
): 'deadline' | 'memory-cap' | undefined {
  if (
    performance.now() - runtime.startedAt >
    INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RUNTIME_MS
  ) {
    return 'deadline'
  }
  return sampleRss(runtime) >
    INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RSS_DELTA_BYTES
    ? 'memory-cap'
    : undefined
}

function sampleRss(runtime: ObserverRuntime): number {
  runtime.peakRssBytes = Math.max(
    runtime.peakRssBytes,
    process.memoryUsage.rss()
  )
  return Math.max(
    0,
    runtime.peakRssBytes - runtime.startingRssBytes
  )
}

function failedOutcome(
  input: {
    readonly sheet: SheetSpec
    readonly productionShortAxisSpanMm: number
    readonly productionMaximumSideMm: number
    readonly productionEnvelopeAreaMm2: number
  },
  runtime: ObserverRuntime,
  status: Exclude<
    IntrinsicShortSidePairFoldStatus,
    'accepted' | 'rejected-admission'
  >,
  failureReason: string,
  transformEvaluations = 0,
  placedCount = 0,
  expectedPairCount = 0,
  evaluatedPairCount = 0,
  selectedBottomPieceId?: string,
  selectedUpperPieceId?: string
): IntrinsicShortSidePairFoldOutcome {
  return {
    trace: measureTraceSize({
      version: INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION,
      status,
      outputInfluence: 'none',
      executionModel: 'single-process-sequential',
      requestedShortAxisMm: Math.min(
        input.sheet.width,
        input.sheet.height
      ),
      requestedLongAxisMm: Math.max(
        input.sheet.width,
        input.sheet.height
      ),
      prescribedRotationDeg:
        input.sheet.width === input.sheet.height
          ? undefined
          : input.sheet.width < input.sheet.height
            ? 0
            : 90,
      productionShortAxisSpanMm:
        input.productionShortAxisSpanMm,
      productionMaximumSideMm:
        input.productionMaximumSideMm,
      productionEnvelopeAreaMm2:
        input.productionEnvelopeAreaMm2,
      transformEvaluations,
      expectedPairCount,
      evaluatedPairCount,
      selectedBottomPieceId,
      selectedUpperPieceId,
      placedCount,
      usedShortAxisSpanMm: undefined,
      usedLongAxisDepthMm: undefined,
      envelopeAreaMm2: undefined,
      canonicalGeometryHash: undefined,
      admission: undefined,
      runtimeMs: Math.max(
        0,
        performance.now() - runtime.startedAt
      ),
      peakRssDeltaBytes: sampleRss(runtime),
      serializedTraceBytes: 0,
      failureReason
    }),
    placedCollisionGeometries: undefined
  }
}

function measureTraceSize(
  trace: IntrinsicShortSidePairFoldTrace
): IntrinsicShortSidePairFoldTrace {
  const first = {
    ...trace,
    serializedTraceBytes: Buffer.byteLength(
      JSON.stringify(trace),
      'utf8'
    )
  }
  return {
    ...first,
    serializedTraceBytes: Buffer.byteLength(
      JSON.stringify(first),
      'utf8'
    )
  }
}
