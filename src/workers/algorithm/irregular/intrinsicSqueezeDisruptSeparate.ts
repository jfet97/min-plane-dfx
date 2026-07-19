import { Data, Effect } from 'effect'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import type {
  IrregularPlacedPiece,
  IrregularPreparedPiece
} from '@shared/irregular/domain.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutTopology
} from '../../irregular/canonicalLayoutGeometry.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  IrregularNfpIfpControl,
  NfpIfpService
} from '../../irregular/services.js'
import {
  IrregularNfpIfpControlAbortError
} from '../../irregular/services.js'
import { IrregularBeamState } from './irregularBeamState.js'
import { deriveRawOccupiedHullWasteRatio } from './irregularLayoutScorer.js'
import {
  buildIntrinsicTransformCatalog,
  assertIntrinsicTargetExactLegal,
  IntrinsicExactProjectionError,
  projectIntrinsicLayoutExactly,
  type IntrinsicExactProjectionResult,
  type IntrinsicTargetBox
} from './intrinsicExactProjection.js'
import {
  evaluateIntrinsicSeparation,
  intrinsicDisruptionProposals,
  intrinsicFocusedProposals,
  intrinsicProjectionPriority,
  intrinsicRelaxedStateKey,
  provisionalLayoutFromRelaxedState,
  relaxedStateFromExactLayout,
  remapIntrinsicTransformsQuarterTurn,
  updateIntrinsicSeparatorWeights,
  type IntrinsicRelaxedState,
  type IntrinsicSeparationEvaluation,
  type IntrinsicSeparatorWeights
} from './intrinsicTransformSeparator.js'

export const INTRINSIC_GLOBAL_SEARCH_DEFAULTS = {
  expectedStructuralPieceCount: 53,
  targetRoleCount: 3,
  basinCountPerRole: 2,
  sweepsPerBasin: 12,
  forcedDisruptionSweeps: [0, 4, 8] as const,
  poolCapacity: 8,
  maximumSeparationEvaluations: 200_000,
  maximumProjectionAttempts: 5,
  maximumRuntimeMs: 110_000,
  structuralHandoffCapacity: 5,
  explorationAreaCapMm2: 439_904.17,
  productionAreaTargetMm2: 430_344.918,
  maximumCavityCount: 2,
  maximumLargestHullGapRatio: 0.15,
  seed: 0x4e_34_53_44
} as const

export interface IntrinsicPiecePartition {
  readonly structuralPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly fillerPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly maximumCollisionAreaMm2: number
  readonly structuralAreaThresholdMm2: number
}

export interface IntrinsicGlobalTargetRole {
  readonly id: 'e1-envelope' | 'expanded-e1-envelope' | 'four-three-cap'
  readonly widthMm: number
  readonly heightMm: number
  readonly areaMm2: number
}

export interface IntrinsicGlobalSweepTrace {
  readonly roleId: IntrinsicGlobalTargetRole['id']
  readonly basinIndex: 0 | 1
  readonly sweepIndex: number
  readonly completedSweepCount: number
  readonly forcedDisruption: boolean
  readonly poolSize: number
  readonly proposalCount: number
  readonly separationEvaluationCount: number
  readonly lowestRawLoss: number
}

export interface IntrinsicStructuralHandoffMetrics {
  readonly canonicalGeometryIdentity: string
  readonly enclosedCavityCount: number
  readonly totalEnclosedCavityAreaMm2: number
  readonly largestOccupiedHullGapRatio: number
  readonly envelopeAreaMm2: number
  readonly envelopeMaximumSideMm: number
  readonly envelopeSpanMm: number
  readonly occupiedHullWasteRatio: number
  readonly totalStructuralContacts: number
  readonly dominantStructuralContacts: number
}

export interface IntrinsicStructuralHandoff {
  readonly targetRoleId: IntrinsicGlobalTargetRole['id']
  readonly basinIndex: 0 | 1
  readonly projectionAttempt: number
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly metrics: IntrinsicStructuralHandoffMetrics
}

export interface IntrinsicProjectionAttemptTrace {
  readonly targetRoleId: IntrinsicGlobalTargetRole['id']
  readonly basinIndex: 0 | 1
  readonly completedBasinCount: number
  readonly completedSweepCount: number
  readonly projectionAttempt: number
  readonly rawLoss: number
  readonly conflictCount: number
  readonly outcome:
    | 'exact-success'
    | 'projection-exhausted'
    | 'exact-analysis'
    | 'invalid-input'
    | 'deadline'
    | 'quality-rejected'
  readonly failedPieceId: PieceId | undefined
  readonly dilationSteps: number | undefined
}

export interface IntrinsicGlobalSearchResult {
  readonly status: 'completed' | 'deadline-fallback' | 'budget-fallback'
  readonly fullE1Fallback: ReadonlyArray<IrregularPlacedPiece>
  readonly partition: IntrinsicPiecePartition
  readonly targetRoles: ReadonlyArray<IntrinsicGlobalTargetRole>
  readonly structuralHandoffs: ReadonlyArray<IntrinsicStructuralHandoff>
  readonly trace: ReadonlyArray<IntrinsicGlobalSweepTrace>
  readonly projectionTrace: ReadonlyArray<IntrinsicProjectionAttemptTrace>
  readonly completedSweepCount: number
  readonly separationEvaluationCount: number
  readonly projectionAttemptCount: number
  readonly projectionSuccessCount: number
  readonly runtimeMs: number
}

export class IntrinsicGlobalSearchError extends Data.TaggedError('IntrinsicGlobalSearchError')<{
  readonly operation: 'partition' | 'initialize' | 'search' | 'archive'
  readonly message: string
}> {}

export interface IntrinsicGlobalSearchSchedule {
  readonly expectedStructuralPieceCount: number
  readonly sweepsPerBasin: number
  readonly forcedDisruptionSweeps: ReadonlyArray<number>
  readonly poolCapacity: number
  readonly maximumSeparationEvaluations: number
  readonly maximumProjectionAttempts: number
  readonly maximumRuntimeMs: number
  readonly structuralHandoffCapacity: number
  readonly explorationAreaCapMm2: number
  readonly productionAreaTargetMm2: number
  readonly maximumCavityCount: number
  readonly maximumLargestHullGapRatio: number
  readonly seed: number
}

export interface IntrinsicInfeasiblePoolEntry {
  readonly state: IntrinsicRelaxedState
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly key: string
  readonly disruptionProtectedUntilSweep: number | undefined
}

interface ProjectionDependency {
  readonly project: typeof projectIntrinsicLayoutExactly
}

const productionSchedule: IntrinsicGlobalSearchSchedule = {
  ...INTRINSIC_GLOBAL_SEARCH_DEFAULTS,
  forcedDisruptionSweeps: INTRINSIC_GLOBAL_SEARCH_DEFAULTS.forcedDisruptionSweeps
}

/** E3's registered area partition; no positional slicing is allowed. */
export function partitionIntrinsicStructuralPieces(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): IntrinsicPiecePartition | undefined {
  const areas = pieces.map((piece) => collisionAreaMm2(piece))
  if (areas.some((area) => area === undefined)) return undefined
  const finiteAreas = areas.filter((area): area is number => area !== undefined)
  const maximumCollisionAreaMm2 = Math.max(...finiteAreas)
  if (!Number.isFinite(maximumCollisionAreaMm2) || maximumCollisionAreaMm2 <= 0) {
    return undefined
  }
  const structuralAreaThresholdMm2 = maximumCollisionAreaMm2 / 8
  const structuralPieces: IrregularPreparedPiece[] = []
  const fillerPieces: IrregularPreparedPiece[] = []
  for (const [index, piece] of pieces.entries()) {
    const area = finiteAreas[index]
    if (area === undefined) return undefined
    ;(area >= structuralAreaThresholdMm2 ? structuralPieces : fillerPieces).push(piece)
  }
  return {
    structuralPieces,
    fillerPieces,
    maximumCollisionAreaMm2,
    structuralAreaThresholdMm2
  }
}

/** Three sheet-free target roles, with both dimensions floored to the collision grid. */
export function deriveIntrinsicGlobalTargetRoles(
  e1StructuralPlaced: ReadonlyArray<IrregularPlacedPiece>,
  explorationAreaCapMm2: number = INTRINSIC_GLOBAL_SEARCH_DEFAULTS.explorationAreaCapMm2
): ReadonlyArray<IntrinsicGlobalTargetRole> | undefined {
  const bounds = canonicalPlacedBounds(e1StructuralPlaced)
  if (
    bounds === undefined ||
    !Number.isFinite(explorationAreaCapMm2) ||
    explorationAreaCapMm2 <= 0
  ) {
    return undefined
  }
  const exact = targetRole('e1-envelope', bounds.widthMm, bounds.heightMm)
  const exactArea = bounds.widthMm * bounds.heightMm
  const uniformScale = Math.sqrt(explorationAreaCapMm2 / exactArea)
  const expanded = targetRole(
    'expanded-e1-envelope',
    bounds.widthMm * uniformScale,
    bounds.heightMm * uniformScale
  )
  const fourThree = targetRole(
    'four-three-cap',
    Math.sqrt((explorationAreaCapMm2 * 4) / 3),
    Math.sqrt((explorationAreaCapMm2 * 3) / 4)
  )
  if (exact === undefined || expanded === undefined || fourThree === undefined) return undefined
  return [exact, expanded, fourThree]
}

/** Fixed production E4 structural search. It never publishes transient overlap geometry. */
export function runIntrinsicSqueezeDisruptSeparate(input: {
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly fullE1Placed: ReadonlyArray<IrregularPlacedPiece>
  readonly control?: IrregularNfpIfpControl
}): Effect.Effect<
  IntrinsicGlobalSearchResult,
  | IntrinsicGlobalSearchError
  | IntrinsicExactProjectionError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return runIntrinsicSqueezeDisruptSeparateWithSchedule(input, productionSchedule, {
    project: projectIntrinsicLayoutExactly
  })
}

/** Deterministic reduced-budget seam for synthetic controller tests. */
export function runIntrinsicSqueezeDisruptSeparateWithSchedule(
  input: {
    readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly fullE1Placed: ReadonlyArray<IrregularPlacedPiece>
    readonly control?: IrregularNfpIfpControl
  },
  schedule: IntrinsicGlobalSearchSchedule,
  dependency: ProjectionDependency
): Effect.Effect<
  IntrinsicGlobalSearchResult,
  | IntrinsicGlobalSearchError
  | IntrinsicExactProjectionError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const partition = partitionIntrinsicStructuralPieces(input.allPreparedPieces)
    if (
      partition === undefined ||
      partition.structuralPieces.length !== schedule.expectedStructuralPieceCount
    ) {
      return yield* globalFailure(
        'partition',
        `the E3 area partition must yield exactly ${schedule.expectedStructuralPieceCount} structural pieces.`
      )
    }
    const allE1ById = new Map(
      input.fullE1Placed.map((entry) => [placedPieceId(entry), entry] as const)
    )
    if (
      allE1ById.size !== input.allPreparedPieces.length ||
      input.fullE1Placed.length !== input.allPreparedPieces.length ||
      !assertSheetlessExactFallback(input.fullE1Placed)
    ) {
      return yield* globalFailure(
        'initialize',
        'the immutable full E1 fallback must cover every prepared piece once and be exact-legal.'
      )
    }
    const structuralReference = partition.structuralPieces.map((piece) =>
      allE1ById.get(preparedPieceId(piece))
    )
    if (structuralReference.some((entry) => entry === undefined)) {
      return yield* globalFailure(
        'initialize',
        'the immutable E1 fallback is missing one structural piece.'
      )
    }
    const exactStructuralReference = structuralReference.filter(
      (entry): entry is IrregularPlacedPiece => entry !== undefined
    )
    const catalog = yield* buildIntrinsicTransformCatalog(partition.structuralPieces)
    const initialState = relaxedStateFromExactLayout(catalog, exactStructuralReference)
    const targetRoles = deriveIntrinsicGlobalTargetRoles(
      input.fullE1Placed,
      schedule.explorationAreaCapMm2
    )
    if (initialState === undefined || targetRoles === undefined || targetRoles.length !== 3) {
      return yield* globalFailure(
        'initialize',
        'the structural E1 state or registered target roles could not be canonicalized.'
      )
    }

    let separationEvaluationCount = 0
    let completedSweepCount = 0
    let projectionAttemptCount = 0
    let projectionSuccessCount = 0
    let scheduleStatus: IntrinsicGlobalSearchResult['status'] = 'completed'
    const trace: IntrinsicGlobalSweepTrace[] = []
    const projectionTrace: IntrinsicProjectionAttemptTrace[] = []
    const handoffs: IntrinsicStructuralHandoff[] = []
    let completedBasinCount = 0
    const searchControl = deadlineControl(
      input.control,
      startedAt,
      schedule.maximumRuntimeMs
    )

    for (const role of targetRoles) {
      for (const basinIndex of [0, 1] as const) {
        const targetBox =
          basinIndex === 0
            ? { widthMm: role.widthMm, heightMm: role.heightMm }
            : { widthMm: role.heightMm, heightMm: role.widthMm }
        const basinState =
          basinIndex === 0
            ? initialState
            : remapIntrinsicTransformsQuarterTurn(catalog, initialState)
        if (basinState === undefined) {
          return yield* globalFailure(
            'initialize',
            'the q90 basin could not be expressed with catalog-supported transforms.'
          )
        }
        if (separationEvaluationCount >= schedule.maximumSeparationEvaluations) {
          scheduleStatus = 'budget-fallback'
          break
        }
        const initialEvaluation = evaluateIntrinsicSeparation(
          targetBox,
          catalog,
          basinState
        )
        if (initialEvaluation === undefined) {
          return yield* globalFailure('search', 'the initial separation loss was not finite.')
        }
        separationEvaluationCount += 1
        let pool: ReadonlyArray<IntrinsicInfeasiblePoolEntry> = [
          {
            state: basinState,
            evaluation: initialEvaluation,
            key: intrinsicRelaxedStateKey(catalog, basinState) ?? '',
            disruptionProtectedUntilSweep: undefined
          }
        ]
        let weights: IntrinsicSeparatorWeights = { byConflictKey: new Map() }

        for (let sweepIndex = 0; sweepIndex < schedule.sweepsPerBasin; sweepIndex += 1) {
          if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
            scheduleStatus = 'deadline-fallback'
            break
          }
          const candidates: IntrinsicInfeasiblePoolEntry[] = [...pool]
          let proposalCount = 0
          const forcedDisruption = schedule.forcedDisruptionSweeps.includes(sweepIndex)
          for (const [poolIndex, entry] of pool.entries()) {
            const proposals = [
              ...intrinsicFocusedProposals({
                targetBox,
                catalog,
                state: entry.state,
                evaluation: entry.evaluation,
                weights,
                ordinal: deterministicOrdinal(schedule.seed, completedSweepCount, poolIndex)
              }),
              ...(forcedDisruption
                ? intrinsicDisruptionProposals({
                    targetBox,
                    catalog,
                    state: entry.state,
                    ordinal: deterministicOrdinal(schedule.seed, completedSweepCount, poolIndex + 31)
                  })
                : [])
            ]
            proposalCount += proposals.length
            for (const proposal of proposals) {
              if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
                scheduleStatus = 'deadline-fallback'
                break
              }
              if (separationEvaluationCount >= schedule.maximumSeparationEvaluations) {
                scheduleStatus = 'budget-fallback'
                break
              }
              const evaluation = evaluateIntrinsicSeparation(
                targetBox,
                catalog,
                proposal.state,
                weights
              )
              separationEvaluationCount += 1
              const key = intrinsicRelaxedStateKey(catalog, proposal.state)
              if (evaluation !== undefined && key !== undefined) {
                const isDisruption =
                  proposal.kind === 'swap' ||
                  proposal.kind === 'group-transport' ||
                  proposal.kind === 'split-squeeze' ||
                  proposal.kind === 'interface-disrupt'
                candidates.push({
                  state: proposal.state,
                  evaluation,
                  key,
                  disruptionProtectedUntilSweep: isDisruption ? sweepIndex + 1 : undefined
                })
              }
            }
            if (scheduleStatus !== 'completed') break
          }
          if (scheduleStatus !== 'completed') break
          const rawBest = reweightIntrinsicPool(candidates, weights).toSorted(
            comparePoolEntriesByRaw
          )[0]
          if (rawBest === undefined) {
            return yield* globalFailure('search', 'the infeasible basin pool became empty.')
          }
          weights = updateIntrinsicSeparatorWeights(weights, rawBest.evaluation)
          pool = retainIntrinsicInfeasiblePool(
            candidates,
            schedule.poolCapacity,
            weights,
            sweepIndex
          )
          const best = pool[0]
          if (best === undefined) {
            return yield* globalFailure('search', 'the reweighted basin pool became empty.')
          }
          completedSweepCount += 1
          trace.push({
            roleId: role.id,
            basinIndex,
            sweepIndex,
            completedSweepCount,
            forcedDisruption,
            poolSize: pool.length,
            proposalCount,
            separationEvaluationCount,
            lowestRawLoss: best.evaluation.rawLoss
          })
        }
        if (scheduleStatus !== 'completed') break

        completedBasinCount += 1
        if (
          completedBasinCount >= 2 &&
          projectionAttemptCount < schedule.maximumProjectionAttempts
        ) {
          if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
            scheduleStatus = 'deadline-fallback'
            break
          }
          const best = pool[0]
          if (best === undefined) {
            return yield* globalFailure('search', 'the completed basin had no projection state.')
          }
          const provisional = provisionalLayoutFromRelaxedState(catalog, best.state)
          const reinsertionPriorityPieceIds = intrinsicProjectionPriority(
            catalog,
            best.state,
            best.evaluation,
            weights
          )
          if (provisional === undefined || reinsertionPriorityPieceIds === undefined) {
            return yield* globalFailure(
              'search',
              'the lowest-loss basin state could not be converted for exact projection.'
            )
          }
          projectionAttemptCount += 1
          const attempted = yield* Effect.matchEffect(
            dependency.project({
              targetBox,
              catalog,
              referencePlaced: exactStructuralReference,
              provisionalPlaced: provisional,
              reinsertionPriorityPieceIds,
              control: searchControl
            }),
            {
              onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
              onSuccess: (value) => Effect.succeed({ kind: 'success' as const, value })
            }
          )
          if (attempted.kind === 'failure') {
            switch (attempted.error._tag) {
              case 'IntrinsicExactProjectionError': {
                projectionTrace.push({
                  targetRoleId: role.id,
                  basinIndex,
                  completedBasinCount,
                  completedSweepCount,
                  projectionAttempt: projectionAttemptCount,
                  rawLoss: best.evaluation.rawLoss,
                  conflictCount: best.evaluation.conflicts.length,
                  outcome: attempted.error.category,
                  failedPieceId: attempted.error.failedPieceId,
                  dilationSteps: attempted.error.attempts
                })
                break
              }
              case 'IrregularNfpIfpControlAbortError':
                if (attempted.error.reason === 'cancelled') {
                  return yield* Effect.fail(attempted.error)
                }
                projectionTrace.push({
                  targetRoleId: role.id,
                  basinIndex,
                  completedBasinCount,
                  completedSweepCount,
                  projectionAttempt: projectionAttemptCount,
                  rawLoss: best.evaluation.rawLoss,
                  conflictCount: best.evaluation.conflicts.length,
                  outcome: 'deadline',
                  failedPieceId: undefined,
                  dilationSteps: undefined
                })
                scheduleStatus = 'deadline-fallback'
                break
              case 'IrregularGeometryInputError':
              case 'IrregularNestingNotImplementedError':
                return yield* Effect.fail(attempted.error)
            }
          } else {
            projectionSuccessCount += 1
            const handoff = exactStructuralHandoff({
              role,
              basinIndex,
              projectionAttempt: projectionAttemptCount,
              targetBox,
              projection: attempted.value,
              schedule
            })
            if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
              scheduleStatus = 'deadline-fallback'
              break
            }
            if (handoff !== undefined) {
              addStructuralHandoff(handoffs, handoff, schedule.structuralHandoffCapacity)
            }
            projectionTrace.push({
              targetRoleId: role.id,
              basinIndex,
              completedBasinCount,
              completedSweepCount,
              projectionAttempt: projectionAttemptCount,
              rawLoss: best.evaluation.rawLoss,
              conflictCount: best.evaluation.conflicts.length,
              outcome: handoff === undefined ? 'quality-rejected' : 'exact-success',
              failedPieceId: undefined,
              dilationSteps: attempted.value.dilationSteps
            })
          }
        }
      }
      if (scheduleStatus !== 'completed') break
    }

    const expectedSweepCount =
      targetRoles.length * 2 * schedule.sweepsPerBasin
    if (scheduleStatus === 'completed' && completedSweepCount !== expectedSweepCount) {
      scheduleStatus = 'budget-fallback'
    }
    if (
      scheduleStatus === 'completed' &&
      (yield* globalSearchCheckpoint(searchControl)) === 'deadline'
    ) {
      scheduleStatus = 'deadline-fallback'
    }
    if (scheduleStatus !== 'completed') handoffs.splice(0, handoffs.length)
    return {
      status: scheduleStatus,
      fullE1Fallback: input.fullE1Placed,
      partition,
      targetRoles,
      structuralHandoffs: handoffs,
      trace,
      projectionTrace,
      completedSweepCount,
      separationEvaluationCount,
      projectionAttemptCount,
      projectionSuccessCount,
      runtimeMs: Math.max(0, performance.now() - startedAt)
    }
  })
}

function exactStructuralHandoff(input: {
  readonly role: IntrinsicGlobalTargetRole
  readonly basinIndex: 0 | 1
  readonly projectionAttempt: number
  readonly targetBox: IntrinsicTargetBox
  readonly projection: IntrinsicExactProjectionResult
  readonly schedule: IntrinsicGlobalSearchSchedule
}): IntrinsicStructuralHandoff | undefined {
  const sheet = new SheetSpec({
    width: Math.ceil(input.targetBox.widthMm),
    height: Math.ceil(input.targetBox.heightMm),
    label: 'intrinsic-global-structural-projection'
  })
  const placed = input.projection.placedCollisionGeometries
  if (
    !assertCanonicalGridLegalLayout(sheet, placed) ||
    !assertIntrinsicTargetExactLegal(input.targetBox, placed)
  ) {
    return undefined
  }
  const identity = canonicalCollisionLayoutIdentity(placed)
  const topology = measureCanonicalLayoutTopology(placed)
  const cavities = measureCanonicalEnclosedCavities(placed)
  const beamState = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: placed,
    placementOrder: placed.map(placedPieceId)
  })
  const bounds = beamState.translatedCollisionBounds
  const occupiedHullWasteRatio = deriveRawOccupiedHullWasteRatio(beamState)
  if (
    identity === undefined ||
    topology === undefined ||
    cavities === undefined ||
    bounds === undefined ||
    occupiedHullWasteRatio === undefined ||
    beamState.nearCompleteStructuralContactCount === undefined ||
    beamState.dominantNearCompleteStructuralContactCount === undefined
  ) {
    return undefined
  }
  const envelopeAreaMm2 = bounds.width * bounds.height
  if (
    cavities.count > input.schedule.maximumCavityCount ||
    topology.largestOccupiedHullGapRatio > input.schedule.maximumLargestHullGapRatio ||
    envelopeAreaMm2 > input.schedule.explorationAreaCapMm2
  ) {
    return undefined
  }
  return {
    targetRoleId: input.role.id,
    basinIndex: input.basinIndex,
    projectionAttempt: input.projectionAttempt,
    placedCollisionGeometries: placed,
    metrics: {
      canonicalGeometryIdentity: identity,
      enclosedCavityCount: cavities.count,
      totalEnclosedCavityAreaMm2: cavities.totalAreaMm2,
      largestOccupiedHullGapRatio: topology.largestOccupiedHullGapRatio,
      envelopeAreaMm2,
      envelopeMaximumSideMm: Math.max(bounds.width, bounds.height),
      envelopeSpanMm: bounds.width + bounds.height,
      occupiedHullWasteRatio,
      totalStructuralContacts: beamState.nearCompleteStructuralContactCount,
      dominantStructuralContacts: beamState.dominantNearCompleteStructuralContactCount
    }
  }
}

function addStructuralHandoff(
  handoffs: IntrinsicStructuralHandoff[],
  candidate: IntrinsicStructuralHandoff,
  capacity: number
): void {
  const existingIndex = handoffs.findIndex(
    ({ metrics }) =>
      metrics.canonicalGeometryIdentity === candidate.metrics.canonicalGeometryIdentity
  )
  if (existingIndex >= 0) {
    const existing = handoffs[existingIndex]
    if (existing !== undefined && compareStructuralHandoffs(candidate, existing) < 0) {
      handoffs.splice(existingIndex, 1, candidate)
    }
  } else {
    if (handoffs.some((existing) => dominatesStructuralHandoff(existing, candidate))) return
    for (let index = handoffs.length - 1; index >= 0; index -= 1) {
      const existing = handoffs[index]
      if (existing !== undefined && dominatesStructuralHandoff(candidate, existing)) {
        handoffs.splice(index, 1)
      }
    }
    handoffs.push(candidate)
  }
  handoffs.sort(compareStructuralHandoffs)
  handoffs.splice(Math.max(0, capacity))
}

/** Bounded non-dominated exact structural archive seam. */
export function retainIntrinsicStructuralHandoffs(
  candidates: ReadonlyArray<IntrinsicStructuralHandoff>,
  capacity: number
): ReadonlyArray<IntrinsicStructuralHandoff> {
  const retained: IntrinsicStructuralHandoff[] = []
  for (const candidate of candidates) addStructuralHandoff(retained, candidate, capacity)
  return retained
}

function dominatesStructuralHandoff(
  first: IntrinsicStructuralHandoff,
  second: IntrinsicStructuralHandoff
): boolean {
  const firstMetrics = first.metrics
  const secondMetrics = second.metrics
  const noWorse =
    firstMetrics.enclosedCavityCount <= secondMetrics.enclosedCavityCount &&
    firstMetrics.totalEnclosedCavityAreaMm2 <= secondMetrics.totalEnclosedCavityAreaMm2 &&
    firstMetrics.largestOccupiedHullGapRatio <= secondMetrics.largestOccupiedHullGapRatio &&
    firstMetrics.envelopeAreaMm2 <= secondMetrics.envelopeAreaMm2 &&
    firstMetrics.envelopeMaximumSideMm <= secondMetrics.envelopeMaximumSideMm &&
    firstMetrics.envelopeSpanMm <= secondMetrics.envelopeSpanMm &&
    firstMetrics.occupiedHullWasteRatio <= secondMetrics.occupiedHullWasteRatio &&
    firstMetrics.totalStructuralContacts >= secondMetrics.totalStructuralContacts &&
    firstMetrics.dominantStructuralContacts >= secondMetrics.dominantStructuralContacts
  const strictlyBetter =
    firstMetrics.enclosedCavityCount < secondMetrics.enclosedCavityCount ||
    firstMetrics.totalEnclosedCavityAreaMm2 < secondMetrics.totalEnclosedCavityAreaMm2 ||
    firstMetrics.largestOccupiedHullGapRatio < secondMetrics.largestOccupiedHullGapRatio ||
    firstMetrics.envelopeAreaMm2 < secondMetrics.envelopeAreaMm2 ||
    firstMetrics.envelopeMaximumSideMm < secondMetrics.envelopeMaximumSideMm ||
    firstMetrics.envelopeSpanMm < secondMetrics.envelopeSpanMm ||
    firstMetrics.occupiedHullWasteRatio < secondMetrics.occupiedHullWasteRatio ||
    firstMetrics.totalStructuralContacts > secondMetrics.totalStructuralContacts ||
    firstMetrics.dominantStructuralContacts > secondMetrics.dominantStructuralContacts
  return noWorse && strictlyBetter
}

function compareStructuralHandoffs(
  first: IntrinsicStructuralHandoff,
  second: IntrinsicStructuralHandoff
): number {
  return (
    first.metrics.enclosedCavityCount - second.metrics.enclosedCavityCount ||
    first.metrics.largestOccupiedHullGapRatio - second.metrics.largestOccupiedHullGapRatio ||
    first.metrics.envelopeAreaMm2 - second.metrics.envelopeAreaMm2 ||
    first.metrics.envelopeMaximumSideMm - second.metrics.envelopeMaximumSideMm ||
    first.metrics.envelopeSpanMm - second.metrics.envelopeSpanMm ||
    first.metrics.totalEnclosedCavityAreaMm2 - second.metrics.totalEnclosedCavityAreaMm2 ||
    first.metrics.occupiedHullWasteRatio - second.metrics.occupiedHullWasteRatio ||
    second.metrics.dominantStructuralContacts - first.metrics.dominantStructuralContacts ||
    second.metrics.totalStructuralContacts - first.metrics.totalStructuralContacts ||
    first.metrics.canonicalGeometryIdentity.localeCompare(
      second.metrics.canonicalGeometryIdentity
    )
  )
}

/** Width-bounded raw, GLS-weighted, and forced-disruption pool retention. */
export function retainIntrinsicInfeasiblePool(
  candidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>,
  capacity: number,
  weights: IntrinsicSeparatorWeights,
  sweepIndex: number
): ReadonlyArray<IntrinsicInfeasiblePoolEntry> {
  const boundedCapacity = Math.max(1, capacity)
  const reweighted = reweightIntrinsicPool(candidates, weights)
  const unique = new Map<string, IntrinsicInfeasiblePoolEntry>()
  for (const candidate of reweighted) {
    const existing = unique.get(candidate.key)
    if (
      existing === undefined ||
      compareDuplicatePoolEntries(candidate, existing, sweepIndex) < 0
    ) {
      unique.set(candidate.key, candidate)
    }
  }
  const values = [...unique.values()]
  const rawRanked = values.toSorted(comparePoolEntriesByRaw)
  const weightedRanked = values.toSorted(comparePoolEntriesByWeight)
  const protectedRanked = values
    .filter(
      ({ disruptionProtectedUntilSweep }) =>
        disruptionProtectedUntilSweep !== undefined &&
        disruptionProtectedUntilSweep >= sweepIndex
    )
    .toSorted(comparePoolEntriesByWeight)
  const pareto = values
    .filter(
      (candidate) =>
        !values.some(
          (other) =>
            other.key !== candidate.key && dominatesPoolEntry(other, candidate)
        )
    )
    .toSorted(comparePoolEntriesByRaw)
  const selected: IntrinsicInfeasiblePoolEntry[] = []
  addUniquePoolEntry(selected, rawRanked[0], boundedCapacity)
  addUniquePoolEntry(selected, protectedRanked[0], boundedCapacity)
  addUniquePoolEntry(selected, weightedRanked[0], boundedCapacity)
  for (const candidate of pareto) addUniquePoolEntry(selected, candidate, boundedCapacity)
  for (const candidate of rawRanked) addUniquePoolEntry(selected, candidate, boundedCapacity)
  const rawWinner = rawRanked[0]
  return rawWinner === undefined
    ? []
    : [rawWinner, ...selected.filter(({ key }) => key !== rawWinner.key)]
}

function reweightIntrinsicPool(
  candidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>,
  weights: IntrinsicSeparatorWeights
): ReadonlyArray<IntrinsicInfeasiblePoolEntry> {
  return candidates.map((candidate) => ({
    ...candidate,
    evaluation: {
      ...candidate.evaluation,
      weightedLoss: intrinsicWeightedLoss(candidate.evaluation, weights)
    }
  }))
}

function intrinsicWeightedLoss(
  evaluation: IntrinsicSeparationEvaluation,
  weights: IntrinsicSeparatorWeights
): number {
  return evaluation.conflicts.reduce(
    (sum, conflict) =>
      sum +
      conflict.normalizedDepth *
        conflict.normalizedDepth *
        (weights.byConflictKey.get(conflict.key) ?? 1),
    0
  )
}

function compareDuplicatePoolEntries(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry,
  sweepIndex: number
): number {
  const firstProtected =
    first.disruptionProtectedUntilSweep !== undefined &&
    first.disruptionProtectedUntilSweep >= sweepIndex
  const secondProtected =
    second.disruptionProtectedUntilSweep !== undefined &&
    second.disruptionProtectedUntilSweep >= sweepIndex
  return (
    Number(secondProtected) - Number(firstProtected) ||
    comparePoolEntriesByRaw(first, second)
  )
}

function comparePoolEntriesByRaw(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry
): number {
  return (
    first.evaluation.rawLoss - second.evaluation.rawLoss ||
    first.evaluation.weightedLoss - second.evaluation.weightedLoss ||
    first.key.localeCompare(second.key)
  )
}

function comparePoolEntriesByWeight(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry
): number {
  return (
    first.evaluation.weightedLoss - second.evaluation.weightedLoss ||
    first.evaluation.rawLoss - second.evaluation.rawLoss ||
    first.key.localeCompare(second.key)
  )
}

function dominatesPoolEntry(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry
): boolean {
  return (
    first.evaluation.rawLoss <= second.evaluation.rawLoss &&
    first.evaluation.weightedLoss <= second.evaluation.weightedLoss &&
    (first.evaluation.rawLoss < second.evaluation.rawLoss ||
      first.evaluation.weightedLoss < second.evaluation.weightedLoss)
  )
}

function addUniquePoolEntry(
  selected: IntrinsicInfeasiblePoolEntry[],
  candidate: IntrinsicInfeasiblePoolEntry | undefined,
  capacity: number
): void {
  if (
    candidate !== undefined &&
    selected.length < capacity &&
    !selected.some(({ key }) => key === candidate.key)
  ) {
    selected.push(candidate)
  }
}

function targetRole(
  id: IntrinsicGlobalTargetRole['id'],
  widthMm: number,
  heightMm: number
): IntrinsicGlobalTargetRole | undefined {
  const widthGrid = floorPositiveGrid(widthMm)
  const heightGrid = floorPositiveGrid(heightMm)
  if (widthGrid === undefined || heightGrid === undefined) return undefined
  const canonicalWidthMm = fromGrid(widthGrid)
  const canonicalHeightMm = fromGrid(heightGrid)
  return {
    id,
    widthMm: canonicalWidthMm,
    heightMm: canonicalHeightMm,
    areaMm2: canonicalWidthMm * canonicalHeightMm
  }
}

function floorPositiveGrid(valueMm: number): number | undefined {
  if (!Number.isFinite(valueMm) || valueMm <= 0) return undefined
  const grid = Math.floor(valueMm * 1_000 + Number.EPSILON)
  return Number.isSafeInteger(grid) && grid > 0 ? grid : undefined
}

function canonicalPlacedBounds(
  placed: ReadonlyArray<IrregularPlacedPiece>
): { readonly widthMm: number; readonly heightMm: number } | undefined {
  const points = placed.flatMap((entry) =>
    entry.collisionGeometry.polygon.points.map((point) => ({
      x: toGridMm(point.x + entry.placement.transform.translateX),
      y: toGridMm(point.y + entry.placement.transform.translateY)
    }))
  )
  if (
    points.length === 0 ||
    points.some(({ x, y }) => x === undefined || y === undefined)
  ) {
    return undefined
  }
  const complete = points.filter(
    (point): point is { readonly x: number; readonly y: number } =>
      point.x !== undefined && point.y !== undefined
  )
  const minimumX = Math.min(...complete.map(({ x }) => x))
  const minimumY = Math.min(...complete.map(({ y }) => y))
  const maximumX = Math.max(...complete.map(({ x }) => x))
  const maximumY = Math.max(...complete.map(({ y }) => y))
  return {
    widthMm: fromGrid(maximumX - minimumX),
    heightMm: fromGrid(maximumY - minimumY)
  }
}

function assertSheetlessExactFallback(
  placed: ReadonlyArray<IrregularPlacedPiece>
): boolean {
  const state = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: placed,
    placementOrder: placed.map(placedPieceId)
  }).withBottomLeftAnchored()
  const bounds = state?.translatedCollisionBounds
  if (state === undefined || bounds === undefined) return false
  const sheet = new SheetSpec({
    width: Math.max(1, Math.ceil(bounds.width)),
    height: Math.max(1, Math.ceil(bounds.height)),
    label: 'intrinsic-global-e1-fallback-proof'
  })
  return assertCanonicalGridLegalLayout(sheet, state.placedCollisionGeometries)
}

function collisionAreaMm2(piece: IrregularPreparedPiece): number | undefined {
  const points = piece.collisionGeometry.collisionPolygon.points
  if (points.length < 3) return undefined
  let doubleArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (current === undefined || next === undefined) return undefined
    doubleArea += current.x * next.y - next.x * current.y
  }
  const area = Math.abs(doubleArea) / 2
  return Number.isFinite(area) && area > 0 ? area : undefined
}

function deterministicOrdinal(seed: number, sweep: number, poolIndex: number): number {
  return Math.abs((seed ^ Math.imul(sweep + 1, 0x45d9f3b) ^ Math.imul(poolIndex + 1, 0x27d4eb2d)) | 0)
}

function deadlineControl(
  control: IrregularNfpIfpControl | undefined,
  startedAt: number,
  maximumRuntimeMs: number
): IrregularNfpIfpControl {
  return {
    checkpoint: (phase) =>
      Effect.gen(function* () {
        if (control !== undefined) yield* control.checkpoint(phase)
        if (performance.now() - startedAt >= maximumRuntimeMs) {
          return yield* Effect.fail(
            new IrregularNfpIfpControlAbortError({
              reason: 'deadline',
              message: 'the intrinsic global search reached its cooperative deadline.'
            })
          )
        }
      })
  }
}

function globalSearchCheckpoint(
  control: IrregularNfpIfpControl
): Effect.Effect<'continue' | 'deadline', IrregularNfpIfpControlAbortError> {
  return Effect.matchEffect(control.checkpoint('candidate-points'), {
    onFailure: (error) =>
      error.reason === 'deadline' ? Effect.succeed('deadline' as const) : Effect.fail(error),
    onSuccess: () => Effect.succeed('continue' as const)
  })
}

function globalFailure(
  operation: IntrinsicGlobalSearchError['operation'],
  message: string
): Effect.Effect<never, IntrinsicGlobalSearchError> {
  return Effect.fail(new IntrinsicGlobalSearchError({ operation, message }))
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}

export type IntrinsicGlobalProjectionError = IntrinsicExactProjectionError
