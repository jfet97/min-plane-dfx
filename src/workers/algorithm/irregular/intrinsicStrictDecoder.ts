import { Data, Effect, Order } from 'effect'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutTopology
} from '../../irregular/canonicalLayoutGeometry.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNfpIfpCandidateMemoScope,
  IrregularNfpIfpControlAbortError,
  IrregularNestingNotImplementedError,
  NfpIfpService
} from '../../irregular/services.js'
import { IrregularBeamState } from './irregularBeamState.js'
import { deriveRawOccupiedHullWasteRatio } from './irregularLayoutScorer.js'

const INTRINSIC_COORDINATE_DOMAIN = new SheetSpec({
  width: 1,
  height: 1,
  label: 'intrinsic-sheetless-coordinate-domain'
})

const transformCandidateOrder = Order.combineAll<IrregularTransformCandidate>([
  Order.mapInput(Order.Number, (transform) => transform.index),
  Order.mapInput(Order.Number, (transform) => transform.rotationDeg),
  Order.mapInput(Order.Boolean, (transform) => transform.mirrored),
  Order.mapInput(Order.String, (transform) => transform.reason)
])

export const INTRINSIC_STRICT_COHESION_FLOORS = {
  maximumEnclosedCavityCount: 2,
  maximumIsolatedPieceCount: 2,
  minimumLargestPositiveContactComponentRatio: 0.8,
  maximumLargestOccupiedHullGapRatio: 0.15
} as const

export class IntrinsicStrictDecoderError extends Data.TaggedError('IntrinsicStrictDecoderError')<{
  readonly operation: string
  readonly message: string
}> {}

export interface IntrinsicStrictStepTrace {
  readonly pieceId: PieceId
  readonly candidateCount: number
  readonly transformFamilyCount: number
  readonly selectedTransformFamily: string | undefined
  readonly selectedScore: IntrinsicStrictLocalScore | undefined
}

export interface IntrinsicStrictLocalScore {
  readonly maximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly envelopeSpanMm: number
  readonly sharedBoundaryLengthMm: number
  readonly canonicalCombinedGeometryKey: string
}

export type IntrinsicStrictComparatorMode = 'pure-growth' | 'contact-band'

export interface IntrinsicStrictFamilyWinner {
  readonly score: IntrinsicStrictLocalScore
  readonly movingCollisionAreaMm2: number
}

export interface IntrinsicStrictCompletedMetrics {
  readonly envelopeMaximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly envelopeSpanMm: number
  readonly enclosedCavityCount: number
  readonly totalEnclosedCavityAreaMm2: number
  readonly largestOccupiedHullGapRatio: number
  readonly isolatedPieceCount: number
  readonly positiveContactComponentCount: number
  readonly largestPositiveContactComponentSize: number
  readonly largestPositiveContactComponentRatio: number
  readonly occupiedAreaOutsideLargestContactComponentMm2: number
  readonly occupiedHullWasteRatio: number
  readonly totalStructuralContacts: number
  readonly dominantStructuralContacts: number
  readonly contactUnits: number
  readonly sharedBoundaryLengthMm: number
  readonly canonicalGeometryHash: string
  readonly runtimeMs: number
}

export interface IntrinsicStrictCertificate {
  readonly passes: boolean
  readonly violatedFloors: ReadonlyArray<keyof typeof INTRINSIC_STRICT_COHESION_FLOORS>
  readonly relativeDeficitSum: number
}

export interface IntrinsicStrictDecodeResult {
  readonly status: 'completed' | 'incomplete' | 'infeasible-final-sheet'
  readonly placements: ReadonlyArray<IrregularPlacement>
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  readonly terminalRotationDeg: 0 | 90 | undefined
  readonly canonicalGeometryHash: string | undefined
  readonly metrics: IntrinsicStrictCompletedMetrics | undefined
  readonly certificate: IntrinsicStrictCertificate | undefined
  readonly stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
  readonly runtimeMs: number
}

interface ScoredCandidate {
  readonly state: IrregularBeamState
  readonly score: IntrinsicStrictLocalScore
  readonly transformFamily: string
  readonly movingCollisionAreaMm2: number
}

/** One strict, sheet-independent constructive decode followed by real-sheet legality. */
export function decodeIntrinsicStrictPriorityOrder(
  finalSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: {
    readonly maximumRuntimeMs?: number
    readonly comparatorMode?: IntrinsicStrictComparatorMode
  } = {}
): Effect.Effect<
  IntrinsicStrictDecodeResult,
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const maximumRuntimeMs = options.maximumRuntimeMs ?? 120_000
    const comparatorMode = options.comparatorMode ?? 'pure-growth'
    const candidateMemoScope = new IrregularNfpIfpCandidateMemoScope()
    const control = {
      checkpoint: () =>
        performance.now() - startedAt >= maximumRuntimeMs
          ? Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'deadline',
                message: `intrinsic strict decode exceeded ${maximumRuntimeMs} ms.`
              })
            )
          : Effect.void
    }
    let state = IrregularBeamState.empty(pieces)
    const stepTrace: IntrinsicStrictStepTrace[] = []

    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex]
      if (piece === undefined) continue
      const remainingPreparedPieces = pieces.slice(pieceIndex + 1)
      const candidatesByFamily = new Map<string, ScoredCandidate>()
      let candidateCount = 0

      for (const transform of [...piece.transforms].sort(transformCandidateOrder)) {
        yield* control.checkpoint()
        const moving = yield* geometryKernel.transformCollisionGeometry({
          geometry: piece.collisionGeometry,
          transform
        })
        const movingCollisionAreaMm2 = canonicalCollisionAreaMm2(moving)
        if (movingCollisionAreaMm2 === undefined) continue
        const legalCandidates =
          state.placedCollisionGeometries.length === 0
            ? originAnchorCandidates(moving)
            : yield* nfpIfpService.generatePlacementCandidates({
                sheet: INTRINSIC_COORDINATE_DOMAIN,
                placed: state.placedCollisionGeometries,
                placedCollisionIndex: state.placedCollisionIndex,
                moving,
                settings,
                candidateDomain: 'sheetless-nfp',
                candidateMemoScope,
                control
              })
        candidateCount += legalCandidates.length
        const family = transformFamilyKey(transform)
        for (const candidate of legalCandidates) {
          const scored = scoreCandidate({
            state,
            piece,
            moving,
            candidate,
            remainingPreparedPieces,
            transformFamily: family,
            movingCollisionAreaMm2
          })
          if (scored === undefined) continue
          const incumbent = candidatesByFamily.get(family)
          if (incumbent === undefined || compareLocalScores(scored.score, incumbent.score) < 0) {
            candidatesByFamily.set(family, scored)
          }
        }
      }

      const selected = selectIntrinsicStrictFamilyWinner(
        [...candidatesByFamily.values()],
        comparatorMode
      )
      const pieceId = piece.pieceId ?? piece.source.id
      stepTrace.push({
        pieceId,
        candidateCount,
        transformFamilyCount: candidatesByFamily.size,
        selectedTransformFamily: selected?.transformFamily,
        selectedScore: selected?.score
      })
      state =
        selected?.state ??
        state.withUnplacedPiece({
          remainingPreparedPieces,
          unplacedPieceId: pieceId
        })
    }

    const intrinsicRuntimeMs = Math.max(0, performance.now() - startedAt)
    if (state.unplacedPieceIds.length > 0) {
      return makeResult({
        status: 'incomplete',
        state,
        stepTrace,
        runtimeMs: intrinsicRuntimeMs
      })
    }

    const terminal = selectTerminalOrientation(state, finalSheet)
    if (terminal === undefined) {
      return makeResult({
        status: 'infeasible-final-sheet',
        state,
        stepTrace,
        runtimeMs: intrinsicRuntimeMs
      })
    }
    const runtimeMs = Math.max(0, performance.now() - startedAt)
    const metrics = completedMetrics(terminal.state, terminal.canonicalHash, runtimeMs)
    if (metrics === undefined) {
      return yield* Effect.fail(
        new IntrinsicStrictDecoderError({
          operation: 'completedMetrics',
          message: 'completed canonical layout metrics must remain finite and exact.'
        })
      )
    }
    return {
      ...makeResult({
        status: 'completed',
        state: terminal.state,
        stepTrace,
        runtimeMs
      }),
      terminalRotationDeg: terminal.rotationDeg,
      canonicalGeometryHash: terminal.canonicalHash,
      metrics,
      certificate: evaluateIntrinsicStrictCertificate(metrics)
    }
  })
}

function scoreCandidate(input: {
  readonly state: IrregularBeamState
  readonly piece: IrregularPreparedPiece
  readonly moving: TransformedCollisionGeometry
  readonly candidate: IrregularPlacementCandidate
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly transformFamily: string
  readonly movingCollisionAreaMm2: number
}): ScoredCandidate | undefined {
  const placement = makePlacement(input.piece, input.candidate)
  const placed = new IrregularPlacedPiece({
    placement,
    collisionGeometry: input.moving
  })
  const anchored = input.state
    .withPlacement({
      remainingPreparedPieces: input.remainingPreparedPieces,
      placedCollisionGeometry: placed,
      placementOrderPieceId: input.piece.pieceId ?? input.piece.source.id
    })
    .withBottomLeftAnchored()
  const bounds = anchored?.translatedCollisionBounds
  if (anchored === undefined || bounds === undefined) return undefined
  const maximumSideMm = Math.max(bounds.width, bounds.height)
  const envelopeAreaMm2 = bounds.width * bounds.height
  const envelopeSpanMm = bounds.width + bounds.height
  const sharedBoundaryLengthMm = anchored.sharedCollisionBoundaryLengthMm
  if (
    sharedBoundaryLengthMm === undefined ||
    ![maximumSideMm, envelopeAreaMm2, envelopeSpanMm, sharedBoundaryLengthMm].every(Number.isFinite)
  ) {
    return undefined
  }
  return {
    state: anchored,
    transformFamily: input.transformFamily,
    movingCollisionAreaMm2: input.movingCollisionAreaMm2,
    score: {
      maximumSideMm,
      envelopeAreaMm2,
      envelopeSpanMm,
      sharedBoundaryLengthMm,
      canonicalCombinedGeometryKey: anchored.canonicalOccupiedGeometryKey
    }
  }
}

/** Selects among pure-growth transform-family winners under the requested E1 mode. */
export function selectIntrinsicStrictFamilyWinner<T extends IntrinsicStrictFamilyWinner>(
  candidates: ReadonlyArray<T>,
  comparatorMode: IntrinsicStrictComparatorMode
): T | undefined {
  const pureLeader = candidates.reduce<T | undefined>(
    (best, candidate) =>
      best === undefined || compareLocalScores(candidate.score, best.score) < 0 ? candidate : best,
    undefined
  )
  if (pureLeader === undefined || comparatorMode === 'pure-growth') return pureLeader

  return candidates
    .filter(
      (candidate) =>
        candidate.score.maximumSideMm === pureLeader.score.maximumSideMm &&
        candidate.score.envelopeAreaMm2 <=
          pureLeader.score.envelopeAreaMm2 + 0.02 * candidate.movingCollisionAreaMm2
    )
    .toSorted(compareContactBandCandidates)[0]
}

function compareContactBandCandidates(
  first: IntrinsicStrictFamilyWinner,
  second: IntrinsicStrictFamilyWinner
): number {
  return (
    second.score.sharedBoundaryLengthMm - first.score.sharedBoundaryLengthMm ||
    first.score.envelopeAreaMm2 - second.score.envelopeAreaMm2 ||
    first.score.envelopeSpanMm - second.score.envelopeSpanMm ||
    first.score.canonicalCombinedGeometryKey.localeCompare(
      second.score.canonicalCombinedGeometryKey
    )
  )
}

function compareLocalScores(
  first: IntrinsicStrictLocalScore,
  second: IntrinsicStrictLocalScore
): number {
  return (
    first.maximumSideMm - second.maximumSideMm ||
    first.envelopeAreaMm2 - second.envelopeAreaMm2 ||
    first.envelopeSpanMm - second.envelopeSpanMm ||
    second.sharedBoundaryLengthMm - first.sharedBoundaryLengthMm ||
    first.canonicalCombinedGeometryKey.localeCompare(second.canonicalCombinedGeometryKey)
  )
}

function canonicalCollisionAreaMm2(moving: TransformedCollisionGeometry): number | undefined {
  let doubledAreaGrid2 = 0
  for (let index = 0; index < moving.polygon.points.length; index += 1) {
    const first = moving.polygon.points[index]
    const second = moving.polygon.points[(index + 1) % moving.polygon.points.length]
    if (first === undefined || second === undefined) return undefined
    const firstX = toGridMm(first.x)
    const firstY = toGridMm(first.y)
    const secondX = toGridMm(second.x)
    const secondY = toGridMm(second.y)
    if (
      firstX === undefined ||
      firstY === undefined ||
      secondX === undefined ||
      secondY === undefined
    ) {
      return undefined
    }
    doubledAreaGrid2 += firstX * secondY - secondX * firstY
  }
  const areaMm2 = Math.abs(doubledAreaGrid2) / 2_000_000
  return Number.isFinite(areaMm2) && areaMm2 > 0 ? areaMm2 : undefined
}

function originAnchorCandidates(
  moving: TransformedCollisionGeometry
): ReadonlyArray<IrregularPlacementCandidate> {
  const gridX = toGridMm(-moving.bounds.minX)
  const gridY = toGridMm(-moving.bounds.minY)
  if (gridX === undefined || gridY === undefined) return []
  return [
    new IrregularPlacementCandidate({
      pieceId: moving.sourcePieceId,
      transform: moving.transform,
      point: { x: fromGrid(gridX), y: fromGrid(gridY) },
      diagnostics: []
    })
  ]
}

function transformFamilyKey(transform: IrregularTransformCandidate): string {
  const remainder = transform.rotationDeg % 360
  const rotationDeg = remainder < 0 ? remainder + 360 : remainder
  return `${Object.is(rotationDeg, -0) ? 0 : rotationDeg}:${Number(transform.mirrored)}`
}

function makePlacement(
  piece: IrregularPreparedPiece,
  candidate: IrregularPlacementCandidate
): IrregularPlacement {
  const input = {
    sourcePieceId: piece.source.id,
    placementReference: piece.collisionGeometry.placementReference,
    transform: new IrregularTransform({
      translateX: candidate.point.x,
      translateY: candidate.point.y,
      rotationDeg: candidate.transform.rotationDeg,
      mirrored: candidate.transform.mirrored
    })
  }
  return piece.pieceId === undefined
    ? new IrregularPlacement(input)
    : new IrregularPlacement({ ...input, pieceId: piece.pieceId })
}

function selectTerminalOrientation(
  state: IrregularBeamState,
  sheet: SheetSpec
):
  | {
      readonly state: IrregularBeamState
      readonly rotationDeg: 0 | 90
      readonly canonicalHash: string
    }
  | undefined {
  const legal: Array<{
    readonly state: IrregularBeamState
    readonly rotationDeg: 0 | 90
    readonly canonicalHash: string
  }> = []
  for (const rotationDeg of [0, 90] as const) {
    const oriented = state.withQuarterTurnBottomLeft(rotationDeg)
    if (
      oriented === undefined ||
      !assertCanonicalGridLegalLayout(sheet, oriented.placedCollisionGeometries)
    ) {
      continue
    }
    const canonicalIdentity = canonicalCollisionLayoutIdentity(oriented.placedCollisionGeometries)
    if (canonicalIdentity !== undefined) {
      legal.push({
        state: oriented,
        rotationDeg,
        canonicalHash: createHash('sha256').update(canonicalIdentity).digest('hex')
      })
    }
  }
  return legal.toSorted(
    (first, second) =>
      first.canonicalHash.localeCompare(second.canonicalHash) ||
      first.rotationDeg - second.rotationDeg
  )[0]
}

function completedMetrics(
  state: IrregularBeamState,
  canonicalGeometryHash: string,
  runtimeMs: number
): IntrinsicStrictCompletedMetrics | undefined {
  const bounds = state.translatedCollisionBounds
  const topology = measureCanonicalLayoutTopology(state.placedCollisionGeometries)
  const cavities = measureCanonicalEnclosedCavities(state.placedCollisionGeometries)
  const structure = analyzeCanonicalLayoutStructure(
    intrinsicBoundsSheet(state),
    state.placedCollisionGeometries
  )
  const occupiedHullWasteRatio = deriveRawOccupiedHullWasteRatio(state)
  if (
    bounds === undefined ||
    topology === undefined ||
    cavities === undefined ||
    structure === undefined ||
    occupiedHullWasteRatio === undefined ||
    state.nearCompleteStructuralContactCount === undefined ||
    state.dominantNearCompleteStructuralContactCount === undefined ||
    state.sharedCollisionBoundaryContactUnits === undefined ||
    state.sharedCollisionBoundaryLengthMm === undefined
  ) {
    return undefined
  }
  const largestComponent = new Set(structure.positiveContactComponents[0] ?? [])
  const occupiedAreaOutsideLargestContactComponentMm2 =
    structure.pieces.reduce(
      (sum, piece) => sum + (largestComponent.has(piece.pieceId) ? 0 : piece.areaGrid2),
      0
    ) / 1_000_000
  const metrics = {
    envelopeMaximumSideMm: Math.max(bounds.width, bounds.height),
    envelopeAreaMm2: bounds.width * bounds.height,
    envelopeSpanMm: bounds.width + bounds.height,
    enclosedCavityCount: cavities.count,
    totalEnclosedCavityAreaMm2: cavities.totalAreaMm2,
    largestOccupiedHullGapRatio: topology.largestOccupiedHullGapRatio,
    isolatedPieceCount: topology.isolatedPieceCount,
    positiveContactComponentCount: topology.positiveContactComponentCount,
    largestPositiveContactComponentSize: topology.largestPositiveContactComponentSize,
    largestPositiveContactComponentRatio: topology.largestPositiveContactComponentRatio,
    occupiedAreaOutsideLargestContactComponentMm2,
    occupiedHullWasteRatio,
    totalStructuralContacts: state.nearCompleteStructuralContactCount,
    dominantStructuralContacts: state.dominantNearCompleteStructuralContactCount,
    contactUnits: state.sharedCollisionBoundaryContactUnits,
    sharedBoundaryLengthMm: state.sharedCollisionBoundaryLengthMm,
    canonicalGeometryHash,
    runtimeMs
  }
  return Object.values(metrics).every((value) =>
    typeof value === 'string' ? value.length > 0 : Number.isFinite(value)
  )
    ? metrics
    : undefined
}

function intrinsicBoundsSheet(state: IrregularBeamState): SheetSpec {
  const bounds = state.translatedCollisionBounds
  return new SheetSpec({
    width: Math.max(1, Math.ceil(bounds?.maxX ?? 0)),
    height: Math.max(1, Math.ceil(bounds?.maxY ?? 0)),
    label: 'intrinsic-completed-layout-bounds'
  })
}

export function evaluateIntrinsicStrictCertificate(
  metrics: IntrinsicStrictCompletedMetrics
): IntrinsicStrictCertificate {
  const floors = INTRINSIC_STRICT_COHESION_FLOORS
  const violations: Array<keyof typeof floors> = []
  let relativeDeficitSum = 0
  if (metrics.enclosedCavityCount > floors.maximumEnclosedCavityCount) {
    violations.push('maximumEnclosedCavityCount')
    relativeDeficitSum += Math.min(
      1,
      (metrics.enclosedCavityCount - floors.maximumEnclosedCavityCount) /
        Math.max(1, floors.maximumEnclosedCavityCount)
    )
  }
  if (metrics.isolatedPieceCount > floors.maximumIsolatedPieceCount) {
    violations.push('maximumIsolatedPieceCount')
    relativeDeficitSum += Math.min(
      1,
      (metrics.isolatedPieceCount - floors.maximumIsolatedPieceCount) /
        Math.max(1, floors.maximumIsolatedPieceCount)
    )
  }
  if (
    metrics.largestPositiveContactComponentRatio <
    floors.minimumLargestPositiveContactComponentRatio
  ) {
    violations.push('minimumLargestPositiveContactComponentRatio')
    relativeDeficitSum += Math.min(
      1,
      (floors.minimumLargestPositiveContactComponentRatio -
        metrics.largestPositiveContactComponentRatio) /
        floors.minimumLargestPositiveContactComponentRatio
    )
  }
  if (metrics.largestOccupiedHullGapRatio > floors.maximumLargestOccupiedHullGapRatio) {
    violations.push('maximumLargestOccupiedHullGapRatio')
    relativeDeficitSum += Math.min(
      1,
      (metrics.largestOccupiedHullGapRatio - floors.maximumLargestOccupiedHullGapRatio) /
        floors.maximumLargestOccupiedHullGapRatio
    )
  }
  return {
    passes: violations.length === 0,
    violatedFloors: violations,
    relativeDeficitSum
  }
}

/** Preregistered completed-layout archive order, including negative topology ordering. */
export function rankIntrinsicStrictCompletedLayouts(
  layouts: ReadonlyArray<IntrinsicStrictCompletedMetrics>
): ReadonlyArray<IntrinsicStrictCompletedMetrics> {
  const assessed = layouts.map((metrics) => ({
    metrics,
    certificate: evaluateIntrinsicStrictCertificate(metrics)
  }))
  const minimumPassingArea = Math.min(
    ...assessed
      .filter(({ certificate }) => certificate.passes)
      .map(({ metrics }) => metrics.envelopeAreaMm2)
  )
  return assessed
    .toSorted((first, second) => {
      if (first.certificate.passes !== second.certificate.passes) {
        return first.certificate.passes ? -1 : 1
      }
      if (first.certificate.passes) {
        const firstWithinOnePercent = first.metrics.envelopeAreaMm2 <= minimumPassingArea * 1.01
        const secondWithinOnePercent = second.metrics.envelopeAreaMm2 <= minimumPassingArea * 1.01
        if (firstWithinOnePercent !== secondWithinOnePercent) return firstWithinOnePercent ? -1 : 1
        if (firstWithinOnePercent) {
          return (
            first.metrics.envelopeMaximumSideMm - second.metrics.envelopeMaximumSideMm ||
            first.metrics.envelopeAreaMm2 - second.metrics.envelopeAreaMm2 ||
            first.metrics.canonicalGeometryHash.localeCompare(second.metrics.canonicalGeometryHash)
          )
        }
        return (
          first.metrics.envelopeAreaMm2 - second.metrics.envelopeAreaMm2 ||
          first.metrics.envelopeMaximumSideMm - second.metrics.envelopeMaximumSideMm ||
          first.metrics.canonicalGeometryHash.localeCompare(second.metrics.canonicalGeometryHash)
        )
      }
      return (
        first.certificate.violatedFloors.length - second.certificate.violatedFloors.length ||
        first.certificate.relativeDeficitSum - second.certificate.relativeDeficitSum ||
        first.metrics.envelopeMaximumSideMm - second.metrics.envelopeMaximumSideMm ||
        first.metrics.envelopeAreaMm2 - second.metrics.envelopeAreaMm2 ||
        first.metrics.envelopeSpanMm - second.metrics.envelopeSpanMm ||
        first.metrics.canonicalGeometryHash.localeCompare(second.metrics.canonicalGeometryHash)
      )
    })
    .map(({ metrics }) => metrics)
}

function makeResult(input: {
  readonly status: IntrinsicStrictDecodeResult['status']
  readonly state: IrregularBeamState
  readonly stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
  readonly runtimeMs: number
}): IntrinsicStrictDecodeResult {
  return {
    status: input.status,
    placements: input.state.placedCollisionGeometries.map(({ placement }) => placement),
    placedCollisionGeometries: input.state.placedCollisionGeometries,
    unplacedPieceIds: input.state.unplacedPieceIds,
    terminalRotationDeg: undefined,
    canonicalGeometryHash: undefined,
    metrics: undefined,
    certificate: undefined,
    stepTrace: input.stepTrace,
    runtimeMs: input.runtimeMs
  }
}
