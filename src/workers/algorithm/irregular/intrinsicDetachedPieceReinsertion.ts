import { performance } from 'node:perf_hooks'
import { Effect } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularTransform,
  type IrregularPreparedPiece
} from '@shared/irregular/domain.js'
import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity
} from '../../irregular/canonicalLayoutGeometry.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularNfpIfpCandidateMemoScope,
  NfpIfpService
} from '../../irregular/services.js'
import {
  measureRelaxationMetrics,
  type IntrinsicRelaxationMetrics
} from './overlapRelaxation.js'
import { IrregularPlacementScorer } from './irregularPlacementScorer.js'
import { isAdmissibleTargetedImprovement } from './targetedExactLns.js'

export interface IntrinsicDetachedPieceReinsertionPieceReport {
  readonly pieceId: PieceId
  readonly transformCount: number
  readonly generatedCandidateCount: number
  readonly canonicalLegalCandidateCount: number
  readonly positiveContactCandidateCount: number
  readonly admissibleCandidateCount: number
  readonly bestMetrics: IntrinsicRelaxationMetrics | undefined
}

export interface IntrinsicDetachedPieceReinsertionResult {
  readonly status: 'completed' | 'invalid-seed'
  readonly runtimeMs: number
  readonly detachedPieceIds: ReadonlyArray<PieceId>
  readonly seedMetrics: IntrinsicRelaxationMetrics | undefined
  readonly selectedMetrics: IntrinsicRelaxationMetrics | undefined
  readonly selectedPieceId: PieceId | undefined
  readonly accepted: boolean
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly pieceReports: ReadonlyArray<IntrinsicDetachedPieceReinsertionPieceReport>
}

interface ReinsertionCandidate {
  readonly pieceId: PieceId
  readonly identity: string
  readonly metrics: IntrinsicRelaxationMetrics
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
}

/**
 * Exhausts the existing exact sheet candidate pool for each piece outside the
 * largest positive-contact component while every other placement stays frozen.
 */
export function runIntrinsicDetachedPieceReinsertion(input: {
  readonly sheet: SheetSpec
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly seedPlaced: ReadonlyArray<IrregularPlacedPiece>
}): Effect.Effect<
  IntrinsicDetachedPieceReinsertionResult,
  unknown,
  GeometryKernel | GeometrySettings | NfpIfpService | IrregularPlacementScorer
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const placementScorer = yield* IrregularPlacementScorer
    const seedMetrics = measureRelaxationMetrics(input.seedPlaced)
    const structure = analyzeCanonicalLayoutStructure(input.sheet, input.seedPlaced)
    if (
      seedMetrics === undefined ||
      structure === undefined ||
      !assertCanonicalGridLegalLayout(input.sheet, input.seedPlaced)
    ) {
      return {
        status: 'invalid-seed' as const,
        runtimeMs: performance.now() - startedAt,
        detachedPieceIds: [],
        seedMetrics,
        selectedMetrics: seedMetrics,
        selectedPieceId: undefined,
        accepted: false,
        placedCollisionGeometries: input.seedPlaced,
        pieceReports: []
      }
    }
    const largestComponent = [...structure.positiveContactComponents]
      .toSorted(
        (first, second) =>
          second.length - first.length ||
          componentKey(first).localeCompare(componentKey(second))
      )[0]
    const largestComponentIds = new Set(largestComponent ?? [])
    const detachedPieceIds = input.seedPlaced
      .map(placedPieceId)
      .filter((pieceId) => !largestComponentIds.has(pieceId))
      .toSorted()
    const preparedById = new Map(
      input.allPreparedPieces.map((piece) => [preparedPieceId(piece), piece] as const)
    )
    const candidateMemoScope = new IrregularNfpIfpCandidateMemoScope()
    const acceptedCandidates: ReinsertionCandidate[] = []
    const pieceReports: IntrinsicDetachedPieceReinsertionPieceReport[] = []

    for (const pieceId of detachedPieceIds) {
      const piece = preparedById.get(pieceId)
      if (piece === undefined) continue
      const frozen = input.seedPlaced.filter((entry) => placedPieceId(entry) !== pieceId)
      let generatedCandidateCount = 0
      let canonicalLegalCandidateCount = 0
      let positiveContactCandidateCount = 0
      let admissibleCandidateCount = 0
      const pieceCandidates: ReinsertionCandidate[] = []
      const seenIdentities = new Set<string>()
      const transforms = [...piece.transforms].toSorted(
        (first, second) =>
          first.index - second.index ||
          first.rotationDeg - second.rotationDeg ||
          Number(first.mirrored) - Number(second.mirrored) ||
          first.reason.localeCompare(second.reason)
      )
      for (const transform of transforms) {
        const moving = yield* geometryKernel.transformCollisionGeometry({
          geometry: piece.collisionGeometry,
          transform
        })
        const candidates = yield* nfpIfpService.generatePlacementCandidates({
          sheet: input.sheet,
          placed: frozen,
          moving,
          settings,
          candidateDomain: 'sheet',
          candidateMemoScope
        })
        generatedCandidateCount += candidates.length
        for (const candidate of candidates) {
          const score = yield* placementScorer.scoreCandidate({
            sheet: input.sheet,
            placed: frozen,
            moving,
            candidate
          })
          if (score.sharedCollisionBoundaryLengthMm > 0) {
            positiveContactCandidateCount += 1
          }
          const placed = new IrregularPlacedPiece({
            placement: makePlacement(piece, candidate.point, transform),
            collisionGeometry: moving
          })
          const candidateLayout = input.seedPlaced.map((entry) =>
            placedPieceId(entry) === pieceId ? placed : entry
          )
          if (!assertCanonicalGridLegalLayout(input.sheet, candidateLayout)) continue
          canonicalLegalCandidateCount += 1
          const identity = canonicalCollisionLayoutIdentity(candidateLayout)
          if (identity === undefined || seenIdentities.has(identity)) continue
          seenIdentities.add(identity)
          const metrics = measureRelaxationMetrics(candidateLayout)
          if (
            metrics === undefined ||
            !isAdmissibleTargetedImprovement(seedMetrics, metrics)
          ) {
            continue
          }
          admissibleCandidateCount += 1
          const acceptedCandidate = {
            pieceId,
            identity,
            metrics,
            placedCollisionGeometries: candidateLayout
          }
          pieceCandidates.push(acceptedCandidate)
          acceptedCandidates.push(acceptedCandidate)
        }
      }
      pieceCandidates.sort(compareReinsertionCandidates)
      pieceReports.push({
        pieceId,
        transformCount: transforms.length,
        generatedCandidateCount,
        canonicalLegalCandidateCount,
        positiveContactCandidateCount,
        admissibleCandidateCount,
        bestMetrics: pieceCandidates[0]?.metrics
      })
    }

    acceptedCandidates.sort(compareReinsertionCandidates)
    const selected = acceptedCandidates[0]
    return {
      status: 'completed',
      runtimeMs: performance.now() - startedAt,
      detachedPieceIds,
      seedMetrics,
      selectedMetrics: selected?.metrics ?? seedMetrics,
      selectedPieceId: selected?.pieceId,
      accepted: selected !== undefined,
      placedCollisionGeometries:
        selected?.placedCollisionGeometries ?? input.seedPlaced,
      pieceReports
    }
  })
}

function compareReinsertionCandidates(
  first: ReinsertionCandidate,
  second: ReinsertionCandidate
): number {
  const pairs: ReadonlyArray<readonly [number, number]> = [
    [
      first.metrics.topology.positiveContactComponentCount,
      second.metrics.topology.positiveContactComponentCount
    ],
    [
      first.metrics.topology.isolatedPieceCount,
      second.metrics.topology.isolatedPieceCount
    ],
    [
      -first.metrics.topology.largestPositiveContactComponentSize,
      -second.metrics.topology.largestPositiveContactComponentSize
    ],
    [first.metrics.maxSide, second.metrics.maxSide],
    [first.metrics.area, second.metrics.area],
    [first.metrics.span, second.metrics.span],
    [
      -first.metrics.sharedCollisionBoundaryContactUnits,
      -second.metrics.sharedCollisionBoundaryContactUnits
    ]
  ]
  for (const [left, right] of pairs) {
    if (left !== right) return left < right ? -1 : 1
  }
  return (
    first.pieceId.localeCompare(second.pieceId) ||
    first.identity.localeCompare(second.identity)
  )
}

function makePlacement(
  piece: IrregularPreparedPiece,
  point: { readonly x: number; readonly y: number },
  transform: IrregularPreparedPiece['transforms'][number]
): IrregularPlacement {
  const placementInput = {
    sourcePieceId: piece.source.id,
    placementReference: piece.collisionGeometry.placementReference,
    transform: new IrregularTransform({
      translateX: point.x,
      translateY: point.y,
      rotationDeg: transform.rotationDeg,
      mirrored: transform.mirrored
    })
  }
  return piece.pieceId === undefined
    ? new IrregularPlacement(placementInput)
    : new IrregularPlacement({ ...placementInput, pieceId: piece.pieceId })
}

function componentKey(pieceIds: ReadonlyArray<PieceId>): string {
  return [...pieceIds].toSorted().join('|')
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}
