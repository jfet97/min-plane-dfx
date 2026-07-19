import { Effect } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacementCandidate,
  type IrregularPlacedPiece,
  type IrregularPreparedPiece
} from '@shared/irregular/domain.js'
import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  type CanonicalGridAabb,
  type CanonicalLayoutStructuralAnalysis
} from '../../irregular/canonicalLayoutGeometry.js'
import { IrregularGeometryInputError } from '../../irregular/services.js'
import {
  measureRelaxationMetrics,
  type IntrinsicRelaxationMetrics
} from './overlapRelaxation.js'
import {
  relaxOverlappingLayoutV1,
  type OverlapRelaxationV1Options
} from './overlapRelaxationV1.js'
import {
  runWindowedIrregularReconstruction,
  type IrregularWindowedBeamError
} from './windowedBeam.js'
import { IrregularBeamState } from './irregularBeamState.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type { NfpIfpService } from '../../irregular/services.js'
import type { IrregularPlacementScorer } from './irregularPlacementScorer.js'
import type { IrregularLayoutScorer } from './irregularLayoutScorer.js'
import { PlacementValidation } from '../../irregular/placementValidation.js'

const REQUESTED_DESTROY_SIZES = [2, 3, 5, 8] as const
const ROUND_DEADLINE_MS = 5_000
const GLOBAL_DEADLINE_MS = 60_000
const GRID_MM = 0.001

export type TargetedExactLnsTarget = 'interface' | 'hull_void' | 'v1_hazard'
export type TargetedExactLnsQueueOrder = 'priority' | 'small_first'

export interface TargetedExactLnsRoundReport {
  readonly roundIndex: number
  readonly target: TargetedExactLnsTarget
  readonly requestedK: number
  readonly effectiveK: number
  readonly queueOrder: TargetedExactLnsQueueOrder
  readonly destroyIds: ReadonlyArray<PieceId>
  readonly queueIds: ReadonlyArray<PieceId>
  readonly mandatoryIds: ReadonlyArray<PieceId>
  readonly dilationGrid: number
  readonly coverage: string
  readonly frozenHash: string | undefined
  readonly runtimeMs: number
  readonly candidateCount: number
  readonly candidateMetrics: IntrinsicRelaxationMetrics | undefined
  readonly legal: boolean
  readonly decision: 'accepted' | 'rejected' | 'skipped_duplicate' | 'timed_out' | 'unplaced'
}

export interface TargetedExactLnsResult {
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly accepted: boolean
  readonly incumbentMetrics: IntrinsicRelaxationMetrics
  readonly selectedMetrics: IntrinsicRelaxationMetrics
  readonly rounds: ReadonlyArray<TargetedExactLnsRoundReport>
  readonly v1SnapshotHash: string | undefined
  readonly runtimeMs: number
}

export interface TargetedExactLnsInput {
  readonly sheet: SheetSpec
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly incumbent: ReadonlyArray<IrregularPlacedPiece>
  readonly now?: () => number
  readonly v1Options?: OverlapRelaxationV1Options
  readonly roundDeadlineMs?: number
  readonly globalDeadlineMs?: number
}

export interface TargetedDestroySelection {
  readonly destroyIds: ReadonlyArray<PieceId>
  readonly mandatoryIds: ReadonlyArray<PieceId>
  readonly dilationGrid: number
  readonly coverage: string
}

export interface ExactLineageReplayResult {
  readonly legal: boolean
  readonly firstFailingPieceId: PieceId | undefined
  readonly replayedPieceIds: ReadonlyArray<PieceId>
  readonly finalCanonicalLegal: boolean
}

/** Replays real incumbent placements against a frozen context without searching. */
export function replayFrozenExactLineage(input: {
  readonly constraintSheet: SheetSpec
  readonly sourceLayout: ReadonlyArray<IrregularPlacedPiece>
  readonly frozenPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly destroyedQueue: ReadonlyArray<IrregularPreparedPiece>
}): Effect.Effect<ExactLineageReplayResult, IrregularGeometryInputError> {
  return Effect.gen(function* () {
    const sourceById = new Map(
      input.sourceLayout.map((entry) => [
        entry.placement.pieceId ?? entry.placement.sourcePieceId,
        entry
      ] as const)
    )
    const placed = [...input.frozenPlaced]
    const replayedPieceIds: PieceId[] = []
    for (const piece of input.destroyedQueue) {
      const pieceId = preparedPieceId(piece)
      const source = sourceById.get(pieceId)
      if (source === undefined) {
        return yield* invalidInput(`incumbent replay has no source placement for ${pieceId}.`)
      }
      const candidate = new IrregularPlacementCandidate({
        pieceId,
        transform: source.collisionGeometry.transform,
        point: {
          x: source.placement.transform.translateX,
          y: source.placement.transform.translateY
        },
        diagnostics: []
      })
      const legal = yield* PlacementValidation.check({
        sheet: input.constraintSheet,
        placed,
        moving: source.collisionGeometry,
        candidate
      })
      if (!legal) {
        return {
          legal: false,
          firstFailingPieceId: pieceId,
          replayedPieceIds,
          finalCanonicalLegal: false
        }
      }
      placed.push(source)
      replayedPieceIds.push(pieceId)
    }
    const finalCanonicalLegal = assertCanonicalGridLegalLayout(input.constraintSheet, placed)
    return {
      legal: finalCanonicalLegal,
      firstFailingPieceId: finalCanonicalLegal ? undefined : replayedPieceIds.at(-1),
      replayedPieceIds,
      finalCanonicalLegal
    }
  })
}

/** Runs the preregistered 24-round exact targeted reconstruction schedule. */
export function runTargetedExactLns(
  input: TargetedExactLnsInput
): Effect.Effect<
  TargetedExactLnsResult,
  IrregularWindowedBeamError,
  | GeometryKernel
  | GeometrySettings
  | NfpIfpService
  | IrregularPlacementScorer
  | IrregularLayoutScorer
> {
  return Effect.gen(function* () {
    const now = input.now ?? Date.now
    const startedAt = now()
    const globalDeadline = startedAt + (input.globalDeadlineMs ?? GLOBAL_DEADLINE_MS)
    const roundDeadlineMs = input.roundDeadlineMs ?? ROUND_DEADLINE_MS
    const originalRankById = new Map(
      input.allPreparedPieces.map((piece, index) => [preparedPieceId(piece), index] as const)
    )
    if (originalRankById.size !== input.allPreparedPieces.length) {
      return yield* invalidInput('prepared piece IDs must be unique.')
    }
    const preparedById = new Map(
      input.allPreparedPieces.map((piece) => [preparedPieceId(piece), piece] as const)
    )
    const incumbentMetrics = measureRelaxationMetrics(input.incumbent)
    if (
      incumbentMetrics === undefined ||
      input.incumbent.length !== input.allPreparedPieces.length
    ) {
      return yield* invalidInput('targeted exact LNS requires one complete incumbent.')
    }
    const v1 = yield* relaxOverlappingLayoutV1(
      input.sheet,
      input.incumbent,
      input.v1Options ?? { maximumEvaluations: 25_000, maximumDiagnosticExactChecks: 0 }
    )
    const fixedHazardSnapshot = v1.bestRelaxedSnapshot
    const v1ConstraintSheet: SheetSpec = {
      width: v1.targetWidth,
      height: v1.targetHeight,
      label: 'targeted exact LNS V1 intrinsic constraint'
    }
    const fixedHazardAnalysis = analyzeCanonicalLayoutStructure(
      v1ConstraintSheet,
      fixedHazardSnapshot
    )
    if (fixedHazardAnalysis === undefined) {
      return yield* invalidInput('V1 relaxed snapshot could not be measured on the canonical grid.')
    }
    let incumbent = input.incumbent
    let selectedMetrics = incumbentMetrics
    let accepted = false
    const rounds: TargetedExactLnsRoundReport[] = []
    const seenSignatures = new Set<string>()
    let roundIndex = 0

    for (const target of ['interface', 'hull_void', 'v1_hazard'] as const) {
      for (const requestedK of REQUESTED_DESTROY_SIZES) {
        for (const queueOrder of ['priority', 'small_first'] as const) {
          const roundStartedAt = now()
          if (roundStartedAt >= globalDeadline) {
            rounds.push(timeoutReport(roundIndex, target, requestedK, queueOrder))
            roundIndex += 1
            continue
          }
          const sourceLayout = target === 'v1_hazard' ? fixedHazardSnapshot : incumbent
          const constraintSheet =
            target === 'v1_hazard'
              ? v1ConstraintSheet
              : {
                  width: selectedMetrics.width,
                  height: selectedMetrics.height,
                  label: 'targeted exact LNS incumbent intrinsic constraint'
                }
          const sourceAnalysis =
            target === 'v1_hazard'
              ? fixedHazardAnalysis
              : analyzeCanonicalLayoutStructure(constraintSheet, sourceLayout)
          if (sourceAnalysis === undefined) {
            return yield* invalidInput('incumbent structural analysis failed during LNS.')
          }
          const selection = selectTargetedDestroySet({
            target,
            requestedK,
            analysis: sourceAnalysis,
            originalRankById
          })
          const destroyedQueue = orderDestroyedQueue({
            destroyIds: selection.destroyIds,
            queueOrder,
            preparedById,
            originalRankById
          })
          if (destroyedQueue === undefined) {
            return yield* invalidInput('destroy target contains an unknown prepared piece ID.')
          }
          const queueIds = destroyedQueue.map(preparedPieceId)
          const signature = `${selection.destroyIds.toSorted().join('|')}::${queueIds.join('|')}`
          if (seenSignatures.has(signature)) {
            rounds.push({
              roundIndex,
              target,
              requestedK,
              effectiveK: selection.destroyIds.length,
              queueOrder,
              destroyIds: selection.destroyIds,
              queueIds,
              mandatoryIds: selection.mandatoryIds,
              dilationGrid: selection.dilationGrid,
              coverage: selection.coverage,
              frozenHash: undefined,
              runtimeMs: now() - roundStartedAt,
              candidateCount: 0,
              candidateMetrics: undefined,
              legal: false,
              decision: 'skipped_duplicate'
            })
            roundIndex += 1
            continue
          }
          seenSignatures.add(signature)
          const destroySet = new Set(selection.destroyIds)
          const frozen = sourceLayout.filter(
            ({ placement }) => !destroySet.has(placement.pieceId ?? placement.sourcePieceId)
          )
          if (!assertCanonicalGridLegalLayout(constraintSheet, frozen)) {
            return yield* invalidInput('destroy selection retained an illegal frozen context.')
          }
          const frozenHash = canonicalCollisionLayoutIdentity(frozen)
          const preferredTransforms = new Map(
            sourceLayout
              .filter(({ placement }) =>
                destroySet.has(placement.pieceId ?? placement.sourcePieceId)
              )
              .map(({ placement, collisionGeometry }) => [
                placement.pieceId ?? placement.sourcePieceId,
                collisionGeometry.transform.index
              ] as const)
          )
          let candidateCount = 0
          const deadlineMs = Math.min(globalDeadline, roundStartedAt + roundDeadlineMs)
          const outcome = yield* runWindowedIrregularReconstruction({
            constraintSheet,
            finalSheet: input.sheet,
            allPreparedPieces: input.allPreparedPieces,
            destroyedQueue,
            frozenPlaced: frozen,
            options: { transformPreferences: preferredTransforms },
            control: { deadlineMs }
          }).pipe(
            Effect.map((result) => ({ _tag: 'Completed' as const, result })),
            Effect.catchTag('IrregularWindowedBeamAbortedError', (error) =>
              error.reason === 'deadline'
                ? Effect.succeed({ _tag: 'TimedOut' as const })
                : Effect.fail(error)
            ),
            Effect.catchTag('IrregularNfpIfpControlAbortError', (error) =>
              error.reason === 'deadline'
                ? Effect.succeed({ _tag: 'TimedOut' as const })
                : Effect.fail(error)
            )
          )
          if (outcome._tag === 'TimedOut' || now() > deadlineMs) {
            rounds.push({
              roundIndex,
              target,
              requestedK,
              effectiveK: selection.destroyIds.length,
              queueOrder,
              destroyIds: selection.destroyIds,
              queueIds,
              mandatoryIds: selection.mandatoryIds,
              dilationGrid: selection.dilationGrid,
              coverage: selection.coverage,
              frozenHash,
              runtimeMs: now() - roundStartedAt,
              candidateCount,
              candidateMetrics: undefined,
              legal: false,
              decision: 'timed_out'
            })
            roundIndex += 1
            continue
          }
          candidateCount = outcome.result.candidateCounts.reduce((sum, count) => sum + count, 0)
          const finalists = enumerateExactQuarterTurnFinalists(
            input.sheet,
            outcome.result.rankedStates.slice(0, 4).flatMap((state) =>
              state.unplacedPieceIds.length === 0 ? [state.placedCollisionGeometries] : []
            )
          )
          const rankedFinalists = finalists
            .map((placed) => {
              const metrics = measureRelaxationMetrics(placed)
              const key = canonicalCollisionLayoutIdentity(placed)
              return metrics === undefined || key === undefined ? undefined : { placed, metrics, key }
            })
            .filter(
              (
                candidate
              ): candidate is {
                readonly placed: ReadonlyArray<IrregularPlacedPiece>
                readonly metrics: IntrinsicRelaxationMetrics
                readonly key: string
              } => candidate !== undefined
            )
            .toSorted(compareFinalists)
          const candidate = rankedFinalists[0]
          const legal =
            candidate !== undefined &&
            assertCanonicalGridLegalLayout(constraintSheet, candidate.placed) &&
            assertCanonicalGridLegalLayout(input.sheet, candidate.placed)
          const admissible =
            candidate !== undefined &&
            legal &&
            isAdmissibleTargetedImprovement(selectedMetrics, candidate.metrics)
          if (admissible && now() <= deadlineMs) {
            incumbent = candidate.placed
            selectedMetrics = candidate.metrics
            accepted = true
          }
          rounds.push({
            roundIndex,
            target,
            requestedK,
            effectiveK: selection.destroyIds.length,
            queueOrder,
            destroyIds: selection.destroyIds,
            queueIds,
            mandatoryIds: selection.mandatoryIds,
            dilationGrid: selection.dilationGrid,
            coverage: selection.coverage,
            frozenHash,
            runtimeMs: now() - roundStartedAt,
            candidateCount,
            candidateMetrics: candidate?.metrics,
            legal,
            decision:
              outcome.result.bestState.unplacedPieceIds.length > 0
                ? 'unplaced'
                : admissible
                  ? 'accepted'
                  : 'rejected'
          })
          roundIndex += 1
        }
      }
    }
    return {
      placedCollisionGeometries: incumbent,
      accepted,
      incumbentMetrics,
      selectedMetrics,
      rounds,
      v1SnapshotHash: canonicalCollisionLayoutIdentity(fixedHazardSnapshot),
      runtimeMs: now() - startedAt
    }
  })
}

export function selectTargetedDestroySet(input: {
  readonly target: TargetedExactLnsTarget
  readonly requestedK: number
  readonly analysis: CanonicalLayoutStructuralAnalysis
  readonly originalRankById: ReadonlyMap<PieceId, number>
}): TargetedDestroySelection {
  const aabbById = new Map(input.analysis.pieces.map(({ pieceId, aabb }) => [pieceId, aabb]))
  let mandatoryIds: ReadonlyArray<PieceId> = []
  let targetAabb: CanonicalGridAabb | undefined
  let coverage: string = input.target
  if (input.target === 'interface') {
    const primary = input.analysis.positiveContactComponents[0] ?? []
    const detached = input.analysis.positiveContactComponents[1] ?? []
    const pair = closestCrossComponentPair(primary, detached, aabbById, input.originalRankById)
    mandatoryIds = pair === undefined ? primary.slice(0, 1) : pair
    targetAabb = unionAabbs(mandatoryIds.flatMap((pieceId) => optionalAabb(aabbById.get(pieceId))))
    coverage = `interface:${primary.length}:${detached.length}`
  } else if (input.target === 'hull_void') {
    targetAabb = input.analysis.largestHullGap?.aabb
    coverage = input.analysis.largestHullGap === undefined ? 'hull_void:none' : 'hull_void:largest'
  } else {
    mandatoryIds = [
      ...new Set([
        ...input.analysis.positiveAreaConflicts.flatMap((pair) => pair),
        ...input.analysis.wallOffenders
      ])
    ].toSorted()
    targetAabb = unionAabbs(mandatoryIds.flatMap((pieceId) => optionalAabb(aabbById.get(pieceId))))
    coverage = `hazards:${input.analysis.positiveAreaConflicts.length}:${input.analysis.wallOffenders.length}`
  }
  const exactLegalizationIds = [
    ...new Set([
      ...input.analysis.positiveAreaConflicts.flatMap((pair) => pair),
      ...input.analysis.wallOffenders
    ])
  ].toSorted()
  mandatoryIds = [...new Set([...mandatoryIds, ...exactLegalizationIds])]
  if (mandatoryIds.length > 0) {
    targetAabb = unionAabbs(
      mandatoryIds.flatMap((pieceId) => optionalAabb(aabbById.get(pieceId)))
    )
  }
  const desiredSize = Math.max(input.requestedK, mandatoryIds.length)
  const ranked = input.analysis.pieces
    .filter(({ pieceId }) => !mandatoryIds.includes(pieceId))
    .map(({ pieceId, aabb }) => ({
      pieceId,
      ...aabbDistance(aabb, targetAabb ?? aabb),
      rank: input.originalRankById.get(pieceId) ?? Number.MAX_SAFE_INTEGER
    }))
    .toSorted(
      (first, second) =>
        first.chebyshevGap - second.chebyshevGap ||
        first.squaredGap - second.squaredGap ||
        first.rank - second.rank ||
        first.pieceId.localeCompare(second.pieceId)
    )
  const fill = ranked.slice(0, Math.max(0, desiredSize - mandatoryIds.length))
  const destroyIds = [...mandatoryIds, ...fill.map(({ pieceId }) => pieceId)]
  return {
    destroyIds,
    mandatoryIds,
    dilationGrid: fill.reduce((maximum, entry) => Math.max(maximum, entry.chebyshevGap), 0),
    coverage
  }
}

export function orderDestroyedQueue(input: {
  readonly destroyIds: ReadonlyArray<PieceId>
  readonly queueOrder: TargetedExactLnsQueueOrder
  readonly preparedById: ReadonlyMap<PieceId, IrregularPreparedPiece>
  readonly originalRankById: ReadonlyMap<PieceId, number>
}): ReadonlyArray<IrregularPreparedPiece> | undefined {
  const pieces = input.destroyIds.map((pieceId) => input.preparedById.get(pieceId))
  if (pieces.some((piece) => piece === undefined)) return undefined
  const defined = pieces.filter((piece): piece is IrregularPreparedPiece => piece !== undefined)
  return defined.toSorted((first, second) => {
    const firstId = preparedPieceId(first)
    const secondId = preparedPieceId(second)
    const rankDifference =
      (input.originalRankById.get(firstId) ?? Number.MAX_SAFE_INTEGER) -
      (input.originalRankById.get(secondId) ?? Number.MAX_SAFE_INTEGER)
    if (input.queueOrder === 'priority') return rankDifference || firstId.localeCompare(secondId)
    return (
      collisionArea(first) - collisionArea(second) ||
      rankDifference ||
      firstId.localeCompare(secondId)
    )
  })
}

export function isAdmissibleTargetedImprovement(
  incumbent: IntrinsicRelaxationMetrics,
  candidate: IntrinsicRelaxationMetrics
): boolean {
  const nonWorse =
    candidate.maxSide <= incumbent.maxSide + GRID_MM &&
    candidate.area <= incumbent.area + GRID_MM &&
    candidate.topology.enclosedCavityCount <= incumbent.topology.enclosedCavityCount &&
    candidate.topology.largestOccupiedHullGapRatio <=
      incumbent.topology.largestOccupiedHullGapRatio + 1e-12 &&
    candidate.topology.positiveContactComponentCount <=
      incumbent.topology.positiveContactComponentCount &&
    candidate.topology.isolatedPieceCount <= incumbent.topology.isolatedPieceCount &&
    candidate.topology.largestPositiveContactComponentSize >=
      incumbent.topology.largestPositiveContactComponentSize &&
    candidate.nearCompleteStructuralContactCount >=
      incumbent.nearCompleteStructuralContactCount &&
    candidate.dominantNearCompleteStructuralContactCount >=
      incumbent.dominantNearCompleteStructuralContactCount &&
    candidate.sharedCollisionBoundaryContactUnits + 1e-9 >=
      incumbent.sharedCollisionBoundaryContactUnits
  const strict =
    candidate.maxSide < incumbent.maxSide - GRID_MM ||
    candidate.area < incumbent.area - GRID_MM ||
    candidate.topology.enclosedCavityCount < incumbent.topology.enclosedCavityCount ||
    candidate.topology.largestOccupiedHullGapRatio <
      incumbent.topology.largestOccupiedHullGapRatio - 1e-12 ||
    candidate.topology.positiveContactComponentCount <
      incumbent.topology.positiveContactComponentCount ||
    candidate.topology.isolatedPieceCount < incumbent.topology.isolatedPieceCount ||
    candidate.topology.largestPositiveContactComponentSize >
      incumbent.topology.largestPositiveContactComponentSize ||
    candidate.nearCompleteStructuralContactCount > incumbent.nearCompleteStructuralContactCount ||
    candidate.dominantNearCompleteStructuralContactCount >
      incumbent.dominantNearCompleteStructuralContactCount ||
    candidate.sharedCollisionBoundaryContactUnits >
      incumbent.sharedCollisionBoundaryContactUnits + 1e-9
  return nonWorse && strict
}

function enumerateExactQuarterTurnFinalists(
  sheet: SheetSpec,
  finalists: ReadonlyArray<ReadonlyArray<IrregularPlacedPiece>>
): ReadonlyArray<ReadonlyArray<IrregularPlacedPiece>> {
  const byKey = new Map<string, ReadonlyArray<IrregularPlacedPiece>>()
  for (const placed of finalists) {
    const state = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: placed,
      placementOrder: placed.map(
        ({ placement }) => placement.pieceId ?? placement.sourcePieceId
      )
    })
    for (const rotationDeg of [0, 90] as const) {
      const oriented = state.withQuarterTurnBottomLeft(rotationDeg)?.placedCollisionGeometries
      if (oriented === undefined || !assertCanonicalGridLegalLayout(sheet, oriented)) continue
      const key = canonicalCollisionLayoutIdentity(oriented)
      if (key !== undefined && !byKey.has(key)) byKey.set(key, oriented)
    }
  }
  return [...byKey.values()]
}

function compareFinalists(
  first: { readonly metrics: IntrinsicRelaxationMetrics; readonly key: string },
  second: { readonly metrics: IntrinsicRelaxationMetrics; readonly key: string }
): number {
  const pairs: ReadonlyArray<readonly [number, number]> = [
    [first.metrics.topology.enclosedCavityCount, second.metrics.topology.enclosedCavityCount],
    [first.metrics.topology.positiveContactComponentCount, second.metrics.topology.positiveContactComponentCount],
    [first.metrics.topology.isolatedPieceCount, second.metrics.topology.isolatedPieceCount],
    [-first.metrics.topology.largestPositiveContactComponentSize, -second.metrics.topology.largestPositiveContactComponentSize],
    [first.metrics.topology.largestOccupiedHullGapRatio, second.metrics.topology.largestOccupiedHullGapRatio],
    [first.metrics.maxSide, second.metrics.maxSide],
    [first.metrics.area, second.metrics.area],
    [-first.metrics.dominantNearCompleteStructuralContactCount, -second.metrics.dominantNearCompleteStructuralContactCount],
    [-first.metrics.nearCompleteStructuralContactCount, -second.metrics.nearCompleteStructuralContactCount],
    [-first.metrics.sharedCollisionBoundaryContactUnits, -second.metrics.sharedCollisionBoundaryContactUnits]
  ]
  for (const [left, right] of pairs) {
    if (left !== right) return left < right ? -1 : 1
  }
  return first.key.localeCompare(second.key)
}

function closestCrossComponentPair(
  primary: ReadonlyArray<PieceId>,
  detached: ReadonlyArray<PieceId>,
  aabbById: ReadonlyMap<PieceId, CanonicalGridAabb>,
  originalRankById: ReadonlyMap<PieceId, number>
): ReadonlyArray<PieceId> | undefined {
  const selected = primary
    .flatMap((first) =>
      detached.flatMap((second) => {
        const firstAabb = aabbById.get(first)
        const secondAabb = aabbById.get(second)
        if (firstAabb === undefined || secondAabb === undefined) return []
        const distance = aabbDistance(firstAabb, secondAabb)
        return [{ first, second, ...distance }]
      })
    )
    .toSorted(
      (first, second) =>
        first.chebyshevGap - second.chebyshevGap ||
        first.squaredGap - second.squaredGap ||
        (originalRankById.get(first.first) ?? Number.MAX_SAFE_INTEGER) -
          (originalRankById.get(second.first) ?? Number.MAX_SAFE_INTEGER) ||
        first.first.localeCompare(second.first) ||
        first.second.localeCompare(second.second)
    )[0]
  return selected === undefined ? undefined : [selected.first, selected.second]
}

function aabbDistance(first: CanonicalGridAabb, second: CanonicalGridAabb) {
  const gapX = Math.max(0, first.minX - second.maxX, second.minX - first.maxX)
  const gapY = Math.max(0, first.minY - second.maxY, second.minY - first.maxY)
  return {
    chebyshevGap: Math.max(gapX, gapY),
    squaredGap: gapX * gapX + gapY * gapY
  }
}

function unionAabbs(aabbs: ReadonlyArray<CanonicalGridAabb>): CanonicalGridAabb | undefined {
  const first = aabbs[0]
  if (first === undefined) return undefined
  return aabbs.slice(1).reduce(
    (result, aabb) => ({
      minX: Math.min(result.minX, aabb.minX),
      minY: Math.min(result.minY, aabb.minY),
      maxX: Math.max(result.maxX, aabb.maxX),
      maxY: Math.max(result.maxY, aabb.maxY)
    }),
    first
  )
}

function optionalAabb(aabb: CanonicalGridAabb | undefined): ReadonlyArray<CanonicalGridAabb> {
  return aabb === undefined ? [] : [aabb]
}

function collisionArea(piece: IrregularPreparedPiece): number {
  const bounds = piece.collisionGeometry.collisionPolygon.points.reduce(
    (result, point) => ({
      minX: Math.min(result.minX, point.x),
      minY: Math.min(result.minY, point.y),
      maxX: Math.max(result.maxX, point.x),
      maxY: Math.max(result.maxY, point.y)
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY
    }
  )
  return (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY)
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function invalidInput(message: string) {
  return Effect.fail(
    new IrregularGeometryInputError({ operation: 'runTargetedExactLns', message })
  )
}

function timeoutReport(
  roundIndex: number,
  target: TargetedExactLnsTarget,
  requestedK: number,
  queueOrder: TargetedExactLnsQueueOrder
): TargetedExactLnsRoundReport {
  return {
    roundIndex,
    target,
    requestedK,
    effectiveK: 0,
    queueOrder,
    destroyIds: [],
    queueIds: [],
    mandatoryIds: [],
    dilationGrid: 0,
    coverage: 'global_deadline',
    frozenHash: undefined,
    runtimeMs: 0,
    candidateCount: 0,
    candidateMetrics: undefined,
    legal: false,
    decision: 'timed_out'
  }
}
