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
  type IntrinsicTargetBox,
  type IntrinsicTransformCatalog
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
  type IntrinsicSeparatorProposal,
  type IntrinsicSeparatorWeights
} from './intrinsicTransformSeparator.js'

export const INTRINSIC_GLOBAL_SEARCH_DEFAULTS = {
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
  interfaceDisruptionMaximumCavityCount: 2,
  interfaceDisruptionMaximumHullGapRatio: 0.15,
  interfaceDisruptionStagnationSweeps: 2,
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

export type IntrinsicDisruptionProposalKind = Extract<
  IntrinsicSeparatorProposal['kind'],
  'swap' | 'group-transport' | 'split-squeeze' | 'interface-disrupt'
>

export interface IntrinsicDisruptionLineageProvenance {
  readonly originSweep: number
  readonly originProposalKind: IntrinsicDisruptionProposalKind
  readonly originStateKey: string
  readonly depth: number
}

export interface IntrinsicLineageWitnessTrace {
  readonly stateKey: string
  readonly rawLoss: number
  readonly weightedLoss: number
  readonly originSweep: number
  readonly originProposalKind: IntrinsicDisruptionProposalKind
  readonly originStateKey: string
  readonly depth: number
}

export interface IntrinsicDirectDisruptionProposalCounts {
  readonly swap: number
  readonly groupTransport: number
  readonly splitSqueeze: number
  readonly interfaceDisrupt: number
}

export interface IntrinsicGlobalSweepTrace {
  readonly roleId: IntrinsicGlobalTargetRole['id']
  readonly basinIndex: 0 | 1
  readonly sweepIndex: number
  readonly completedSweepCount: number
  readonly forcedDisruption: boolean
  readonly interfaceDisruptionStagnated: boolean
  readonly interfaceDisruptionProposalCount: number
  readonly poolSize: number
  readonly proposalCount: number
  readonly separationEvaluationCount: number
  readonly lowestRawLoss: number
  readonly directDisruptionProposalCounts: IntrinsicDirectDisruptionProposalCounts
  readonly preDeduplicationLineageCount: number
  readonly postDeduplicationLineageCount: number
  readonly retainedLineageCount: number
  readonly reservedLineage: IntrinsicLineageWitnessTrace | undefined
  readonly activeLineageRetentionOutcome:
    | 'lane-unavailable'
    | 'retained-by-prior-lane'
    | 'reserved-active-lineage'
    | 'capacity-evicted'
  readonly activeLineageRetentionReason: string
  readonly shadowLineageSnapshot: IntrinsicLineageWitnessTrace | undefined
  readonly shadowLineageSnapshotOutcome:
    | 'lane-unavailable'
    | 'initialized'
    | 'replaced'
    | 'retained-earlier-or-better'
    | 'retained-no-current-lineage'
  readonly shadowLineageSnapshotReason: string
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

export interface IntrinsicStructuralHandoffDiagnostic {
  readonly canonicalGeometryIdentity: string
  readonly targetRoleId: IntrinsicGlobalTargetRole['id']
  readonly basinIndex: 0 | 1
  readonly projectionAttempt: number
  readonly metrics: IntrinsicStructuralHandoffMetrics
}

export interface IntrinsicStructuralHandoffRetentionTrace {
  readonly outcome:
    | 'retained'
    | 'duplicate-replaced'
    | 'duplicate-discarded'
    | 'capacity-pruned'
  readonly candidate: IntrinsicStructuralHandoffDiagnostic
  readonly representative: IntrinsicStructuralHandoffDiagnostic | undefined
  readonly pruned: IntrinsicStructuralHandoffDiagnostic | undefined
  readonly retainedCanonicalGeometryIdentities: ReadonlyArray<string>
}

export type IntrinsicProjectionLane =
  | 'global-raw'
  | 'global-final-gls'
  | 'role-disruption'

export interface IntrinsicProjectionWorkItem {
  readonly lane: IntrinsicProjectionLane
  readonly requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined
  readonly targetRole: IntrinsicGlobalTargetRole
  readonly basinIndex: 0 | 1
  readonly targetBox: IntrinsicTargetBox
  readonly state: IntrinsicRelaxedState
  readonly stateKey: string
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly weights: IntrinsicSeparatorWeights
  readonly disruptionLineage: boolean
  readonly disruptionLineageProvenance: IntrinsicDisruptionLineageProvenance | undefined
  readonly workIdentity: string
}

export interface IntrinsicProjectionLaneTrace {
  readonly lane: IntrinsicProjectionLane
  readonly requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined
  readonly outcome: 'selected' | 'lane-unavailable' | 'lane-collapsed'
  readonly workIdentity: string | undefined
  readonly collapsedIntoWorkIdentity: string | undefined
  readonly targetRoleId: IntrinsicGlobalTargetRole['id'] | undefined
  readonly basinIndex: 0 | 1 | undefined
  readonly stateKey: string | undefined
  readonly disruptionLineage: boolean | undefined
  readonly disruptionLineageProvenance: IntrinsicDisruptionLineageProvenance | undefined
  readonly rawLoss: number | undefined
  readonly weightedLoss: number | undefined
  readonly eligibleCandidateCount: number
  readonly skippedDuplicateCount: number
}

export interface IntrinsicProjectionAttemptTrace {
  readonly lane: IntrinsicProjectionLane
  readonly requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined
  readonly targetRoleId: IntrinsicGlobalTargetRole['id']
  readonly basinIndex: 0 | 1
  readonly stateKey: string
  readonly disruptionLineage: boolean
  readonly disruptionLineageProvenance: IntrinsicDisruptionLineageProvenance | undefined
  readonly completedBasinCount: number
  readonly completedSweepCount: number
  readonly projectionAttempt: number
  readonly rawLoss: number
  readonly weightedLoss: number
  readonly conflictCount: number
  readonly outcome:
    | 'exact-success'
    | 'projection-exhausted'
    | 'exact-analysis'
    | 'invalid-input'
    | 'deadline'
    | 'structural-analysis-invalid'
  readonly failedPieceId: PieceId | undefined
  readonly dilationSteps: number | undefined
  readonly structuralCanonicalGeometryIdentity: string | undefined
  readonly handoffRetention?: IntrinsicStructuralHandoffRetentionTrace
}

export interface IntrinsicGlobalSearchResult {
  readonly status: 'completed' | 'deadline-fallback' | 'budget-fallback'
  readonly fullE1Fallback: ReadonlyArray<IrregularPlacedPiece>
  readonly partition: IntrinsicPiecePartition
  readonly targetRoles: ReadonlyArray<IntrinsicGlobalTargetRole>
  readonly searchedBasinCount: number
  readonly unavailableQuarterTurnBasinCount: number
  readonly structuralHandoffs: ReadonlyArray<IntrinsicStructuralHandoff>
  readonly trace: ReadonlyArray<IntrinsicGlobalSweepTrace>
  readonly projectionLaneTrace: ReadonlyArray<IntrinsicProjectionLaneTrace>
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
  readonly expectedStructuralPieceCount?: number
  readonly sweepsPerBasin: number
  readonly forcedDisruptionSweeps: ReadonlyArray<number>
  readonly poolCapacity: number
  readonly maximumSeparationEvaluations: number
  readonly maximumProjectionAttempts: number
  readonly maximumRuntimeMs: number
  readonly structuralHandoffCapacity: number
  readonly explorationAreaCapMm2: number
  readonly interfaceDisruptionMaximumCavityCount: number
  readonly interfaceDisruptionMaximumHullGapRatio: number
  readonly interfaceDisruptionStagnationSweeps: number
  readonly seed: number
}

export interface IntrinsicInfeasiblePoolEntry {
  readonly state: IntrinsicRelaxedState
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly key: string
  readonly disruptionLineage: boolean
  readonly disruptionLineageProvenance: IntrinsicDisruptionLineageProvenance | undefined
  readonly disruptionProtectedUntilSweep: number | undefined
}

export interface IntrinsicInfeasiblePoolRetention {
  readonly pool: ReadonlyArray<IntrinsicInfeasiblePoolEntry>
  readonly preDeduplicationLineageCount: number
  readonly postDeduplicationLineageCount: number
  readonly retainedLineageCount: number
  readonly reservedLineage: IntrinsicLineageWitnessTrace | undefined
  readonly activeLineageRetentionOutcome:
    | 'lane-unavailable'
    | 'retained-by-prior-lane'
    | 'reserved-active-lineage'
    | 'capacity-evicted'
  readonly activeLineageRetentionReason: string
}

export interface IntrinsicProjectionLaneCandidate {
  readonly targetRole: IntrinsicGlobalTargetRole
  readonly basinIndex: 0 | 1
  readonly targetBox: IntrinsicTargetBox
  readonly entry: IntrinsicInfeasiblePoolEntry
  readonly weights: IntrinsicSeparatorWeights
}

export interface IntrinsicProjectionWorkSelection {
  readonly workItems: ReadonlyArray<IntrinsicProjectionWorkItem>
  readonly trace: ReadonlyArray<IntrinsicProjectionLaneTrace>
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

/** Mixes the fixed schedule seed with an order-independent sheetless job identity. */
export function deriveIntrinsicGlobalOrdinalSeed(
  catalog: IntrinsicTransformCatalog,
  scheduleSeed: number
): number {
  const canonicalJobIdentity = JSON.stringify(
    catalog.entries
      .map((entry) => [
        entry.pieceId,
        entry.transforms.map((transform) => [
          transform.canonicalTransformKey,
          transform.canonicalLocalGeometryKey
        ])
      ])
      .toSorted(([firstId], [secondId]) => String(firstId).localeCompare(String(secondId)))
  )
  return hashIntrinsicSeed(`${scheduleSeed >>> 0}:${canonicalJobIdentity}`)
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

/** Fixed production E5 structural search. It never publishes transient overlap geometry. */
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
  scheduleInput: IntrinsicGlobalSearchSchedule,
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
    const fullE1Fallback = [...input.fullE1Placed]
    const schedule = snapshotIntrinsicGlobalSchedule(scheduleInput)
    const startedAt = performance.now()
    const partition = partitionIntrinsicStructuralPieces(input.allPreparedPieces)
    if (
      partition === undefined ||
      (schedule.expectedStructuralPieceCount !== undefined &&
        partition.structuralPieces.length !== schedule.expectedStructuralPieceCount)
    ) {
      return yield* globalFailure(
        'partition',
        schedule.expectedStructuralPieceCount === undefined
          ? 'the E3 area partition must yield a valid structural subset.'
          : `the E3 area partition must yield exactly ${schedule.expectedStructuralPieceCount} structural pieces for this experiment assertion.`
      )
    }
    const allE1ById = new Map(
      fullE1Fallback.map((entry) => [placedPieceId(entry), entry] as const)
    )
    const preparedIds = input.allPreparedPieces.map(preparedPieceId).toSorted()
    const fallbackIds = fullE1Fallback.map(placedPieceId).toSorted()
    if (
      new Set(preparedIds).size !== preparedIds.length ||
      allE1ById.size !== input.allPreparedPieces.length ||
      fullE1Fallback.length !== input.allPreparedPieces.length ||
      !sameSortedPieceIds(preparedIds, fallbackIds) ||
      !assertSheetlessExactFallback(fullE1Fallback)
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
    const jobCatalog = yield* buildIntrinsicTransformCatalog(input.allPreparedPieces)
    const catalog = yield* buildIntrinsicTransformCatalog(partition.structuralPieces)
    const ordinalSeed = deriveIntrinsicGlobalOrdinalSeed(jobCatalog, schedule.seed)
    const initialState = relaxedStateFromExactLayout(catalog, exactStructuralReference)
    const targetRoles = deriveIntrinsicGlobalTargetRoles(
      fullE1Fallback,
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
    let searchedBasinCount = 0
    let scheduleStatus: IntrinsicGlobalSearchResult['status'] = 'completed'
    const trace: IntrinsicGlobalSweepTrace[] = []
    let projectionLaneTrace: ReadonlyArray<IntrinsicProjectionLaneTrace> = []
    const projectionTrace: IntrinsicProjectionAttemptTrace[] = []
    const projectionCandidates: IntrinsicProjectionLaneCandidate[] = []
    const handoffs: IntrinsicStructuralHandoff[] = []
    let completedBasinCount = 0
    const searchControl = deadlineControl(
      input.control,
      startedAt,
      schedule.maximumRuntimeMs
    )
    const quarterTurnState = remapIntrinsicTransformsQuarterTurn(catalog, initialState)
    const basinPlans = targetRoles.flatMap((role) => {
      const q0 = {
        role,
        basinIndex: 0 as const,
        targetBox: { widthMm: role.widthMm, heightMm: role.heightMm },
        basinState: initialState
      }
      return quarterTurnState === undefined
        ? [q0]
        : [
            q0,
            {
              role,
              basinIndex: 1 as const,
              targetBox: { widthMm: role.heightMm, heightMm: role.widthMm },
              basinState: quarterTurnState
            }
          ]
    })
    const unavailableQuarterTurnBasinCount =
      quarterTurnState === undefined ? targetRoles.length : 0
    if (basinPlans.length === 0) {
      return yield* globalFailure(
        'initialize',
        'the canonical q0 state did not produce any searchable basin.'
      )
    }

    for (const { role, basinIndex, targetBox, basinState } of basinPlans) {
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
      searchedBasinCount += 1
      let pool: ReadonlyArray<IntrinsicInfeasiblePoolEntry> = [
        {
          state: basinState,
          evaluation: initialEvaluation,
          key: intrinsicRelaxedStateKey(catalog, basinState) ?? '',
          disruptionLineage: false,
          disruptionLineageProvenance: undefined,
          disruptionProtectedUntilSweep: undefined
        }
      ]
      let weights: IntrinsicSeparatorWeights = { byConflictKey: new Map() }
      let lowestObservedRawLoss = initialEvaluation.rawLoss
      let consecutiveNonImprovingSweeps = 0
      let shadowLineageSnapshot: IntrinsicLineageWitnessTrace | undefined

      for (let sweepIndex = 0; sweepIndex < schedule.sweepsPerBasin; sweepIndex += 1) {
        if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
          scheduleStatus = 'deadline-fallback'
          break
        }
        const candidates: IntrinsicInfeasiblePoolEntry[] = [...pool]
        let proposalCount = 0
        let interfaceDisruptionProposalCount = 0
        let directDisruptionProposalCounts = emptyDirectDisruptionProposalCounts()
        const forcedDisruption = schedule.forcedDisruptionSweeps.includes(sweepIndex)
        const interfaceDisruptionStagnated =
          consecutiveNonImprovingSweeps >= schedule.interfaceDisruptionStagnationSweeps
        for (const [poolIndex, entry] of pool.entries()) {
          const disruptionProposals =
            forcedDisruption
              ? intrinsicDisruptionProposals({
                  targetBox,
                  catalog,
                  state: entry.state,
                  ordinal: deterministicOrdinal(
                    ordinalSeed,
                    completedSweepCount,
                    poolIndex + 31
                  ),
                  maximumInterfaceCavityCount:
                    schedule.interfaceDisruptionMaximumCavityCount,
                  maximumInterfaceHullGapRatio:
                    schedule.interfaceDisruptionMaximumHullGapRatio,
                  interfaceDisruptionStagnated
                })
              : []
          interfaceDisruptionProposalCount += disruptionProposals.filter(
            ({ kind }) => kind === 'interface-disrupt'
          ).length
          directDisruptionProposalCounts = addDirectDisruptionProposalCounts(
            directDisruptionProposalCounts,
            disruptionProposals
          )
          const proposals = [
            ...intrinsicFocusedProposals({
              catalog,
              state: entry.state,
              evaluation: entry.evaluation,
              weights
            }),
            ...disruptionProposals
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
              const isDisruption = isIntrinsicDisruptionProposalKind(proposal.kind)
              const disruptionLineageProvenance = advanceIntrinsicDisruptionLineage(
                entry,
                proposal.kind,
                sweepIndex,
                key
              )
              candidates.push({
                state: proposal.state,
                evaluation,
                key,
                disruptionLineage: disruptionLineageProvenance !== undefined,
                disruptionLineageProvenance,
                disruptionProtectedUntilSweep: isDisruption ? sweepIndex : undefined
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
        const shadowUpdate = updateIntrinsicLineageShadowSnapshot(
          shadowLineageSnapshot,
          reweightIntrinsicPool(candidates, weights)
        )
        shadowLineageSnapshot = shadowUpdate.snapshot
        const retention = retainIntrinsicInfeasiblePoolWithDiagnostics(
          candidates,
          schedule.poolCapacity,
          weights,
          sweepIndex
        )
        pool = retention.pool
        const best = pool[0]
        if (best === undefined) {
          return yield* globalFailure('search', 'the reweighted basin pool became empty.')
        }
        if (best.evaluation.rawLoss < lowestObservedRawLoss) {
          lowestObservedRawLoss = best.evaluation.rawLoss
          consecutiveNonImprovingSweeps = 0
        } else {
          consecutiveNonImprovingSweeps += 1
        }
        completedSweepCount += 1
        trace.push({
          roleId: role.id,
          basinIndex,
          sweepIndex,
          completedSweepCount,
          forcedDisruption,
          interfaceDisruptionStagnated,
          interfaceDisruptionProposalCount,
          poolSize: pool.length,
          proposalCount,
          separationEvaluationCount,
          lowestRawLoss: best.evaluation.rawLoss,
          directDisruptionProposalCounts,
          preDeduplicationLineageCount: retention.preDeduplicationLineageCount,
          postDeduplicationLineageCount: retention.postDeduplicationLineageCount,
          retainedLineageCount: retention.retainedLineageCount,
          reservedLineage: retention.reservedLineage,
          activeLineageRetentionOutcome: retention.activeLineageRetentionOutcome,
          activeLineageRetentionReason: retention.activeLineageRetentionReason,
          shadowLineageSnapshot,
          shadowLineageSnapshotOutcome: shadowUpdate.outcome,
          shadowLineageSnapshotReason: shadowUpdate.reason
        })
      }
      if (scheduleStatus !== 'completed') break

      completedBasinCount += 1
      projectionCandidates.push(
        ...pool.map((entry) => ({ targetRole: role, basinIndex, targetBox, entry, weights }))
      )
    }

    if (scheduleStatus === 'completed') {
      const workSelection = selectIntrinsicProjectionWorkItems(
        projectionCandidates,
        targetRoles
      )
      projectionLaneTrace = workSelection.trace
      for (const workItem of workSelection.workItems.slice(
        0,
        schedule.maximumProjectionAttempts
      )) {
        if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
          scheduleStatus = 'deadline-fallback'
          break
        }
        const provisional = provisionalLayoutFromRelaxedState(catalog, workItem.state)
        const reinsertionPriorityPieceIds = intrinsicProjectionPriority(
          catalog,
          workItem.state,
          workItem.evaluation,
          workItem.weights
        )
        if (provisional === undefined || reinsertionPriorityPieceIds === undefined) {
          return yield* globalFailure(
            'search',
            'a selected projection lane state could not be converted for exact projection.'
          )
        }
        projectionAttemptCount += 1
        const attempted = yield* Effect.matchEffect(
          dependency.project({
            targetBox: workItem.targetBox,
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
        const traceBase = projectionAttemptTraceBase(
          workItem,
          completedBasinCount,
          completedSweepCount,
          projectionAttemptCount
        )
        if (attempted.kind === 'failure') {
          switch (attempted.error._tag) {
            case 'IntrinsicExactProjectionError': {
              projectionTrace.push({
                ...traceBase,
                outcome: attempted.error.category,
                failedPieceId: attempted.error.failedPieceId,
                dilationSteps: attempted.error.attempts,
                structuralCanonicalGeometryIdentity: undefined
              })
              break
            }
            case 'IrregularNfpIfpControlAbortError':
              if (attempted.error.reason === 'cancelled') {
                return yield* Effect.fail(attempted.error)
              }
              projectionTrace.push({
                ...traceBase,
                outcome: 'deadline',
                failedPieceId: undefined,
                dilationSteps: undefined,
                structuralCanonicalGeometryIdentity: undefined
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
            role: workItem.targetRole,
            basinIndex: workItem.basinIndex,
            projectionAttempt: projectionAttemptCount,
            targetBox: workItem.targetBox,
            projection: attempted.value,
            expectedStructuralPieceIds: catalog.entries.map(({ pieceId }) => pieceId)
          })
          if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
            scheduleStatus = 'deadline-fallback'
            break
          }
          const handoffRetention =
            handoff === undefined
              ? undefined
              : addStructuralHandoff(
                  handoffs,
                  handoff,
                  schedule.structuralHandoffCapacity
                )
          projectionTrace.push({
            ...traceBase,
            outcome:
              handoff === undefined ? 'structural-analysis-invalid' : 'exact-success',
            failedPieceId: undefined,
            dilationSteps: attempted.value.dilationSteps,
            structuralCanonicalGeometryIdentity:
              handoff?.metrics.canonicalGeometryIdentity,
            ...(handoffRetention === undefined ? {} : { handoffRetention })
          })
        }
        if (scheduleStatus !== 'completed') break
      }
    }

    const expectedSweepCount = basinPlans.length * schedule.sweepsPerBasin
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
      fullE1Fallback,
      partition,
      targetRoles,
      searchedBasinCount,
      unavailableQuarterTurnBasinCount,
      structuralHandoffs: handoffs,
      trace,
      projectionLaneTrace,
      projectionTrace,
      completedSweepCount,
      separationEvaluationCount,
      projectionAttemptCount,
      projectionSuccessCount,
      runtimeMs: Math.max(0, performance.now() - startedAt)
    }
  })
}

function snapshotIntrinsicGlobalSchedule(
  schedule: IntrinsicGlobalSearchSchedule
): IntrinsicGlobalSearchSchedule {
  return {
    ...(schedule.expectedStructuralPieceCount === undefined
      ? {}
      : { expectedStructuralPieceCount: schedule.expectedStructuralPieceCount }),
    sweepsPerBasin: schedule.sweepsPerBasin,
    forcedDisruptionSweeps: [...schedule.forcedDisruptionSweeps],
    poolCapacity: schedule.poolCapacity,
    maximumSeparationEvaluations: schedule.maximumSeparationEvaluations,
    maximumProjectionAttempts: schedule.maximumProjectionAttempts,
    maximumRuntimeMs: schedule.maximumRuntimeMs,
    structuralHandoffCapacity: schedule.structuralHandoffCapacity,
    explorationAreaCapMm2: schedule.explorationAreaCapMm2,
    interfaceDisruptionMaximumCavityCount:
      schedule.interfaceDisruptionMaximumCavityCount,
    interfaceDisruptionMaximumHullGapRatio:
      schedule.interfaceDisruptionMaximumHullGapRatio,
    interfaceDisruptionStagnationSweeps: schedule.interfaceDisruptionStagnationSweeps,
    seed: schedule.seed
  }
}

function exactStructuralHandoff(input: {
  readonly role: IntrinsicGlobalTargetRole
  readonly basinIndex: 0 | 1
  readonly projectionAttempt: number
  readonly targetBox: IntrinsicTargetBox
  readonly projection: IntrinsicExactProjectionResult
  readonly expectedStructuralPieceIds: ReadonlyArray<PieceId>
}): IntrinsicStructuralHandoff | undefined {
  const sheet = new SheetSpec({
    width: Math.ceil(input.targetBox.widthMm),
    height: Math.ceil(input.targetBox.heightMm),
    label: 'intrinsic-global-structural-projection'
  })
  const placed = input.projection.placedCollisionGeometries
  const actualPieceIds = placed.map(placedPieceId).toSorted()
  const expectedPieceIds = [...input.expectedStructuralPieceIds].toSorted()
  if (
    new Set(actualPieceIds).size !== actualPieceIds.length ||
    !sameSortedPieceIds(expectedPieceIds, actualPieceIds) ||
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
  const envelopeMaximumSideMm = Math.max(bounds.width, bounds.height)
  const envelopeSpanMm = bounds.width + bounds.height
  if (
    ![
      cavities.count,
      cavities.totalAreaMm2,
      topology.largestOccupiedHullGapRatio,
      envelopeAreaMm2,
      envelopeMaximumSideMm,
      envelopeSpanMm,
      occupiedHullWasteRatio,
      beamState.nearCompleteStructuralContactCount,
      beamState.dominantNearCompleteStructuralContactCount
    ].every(Number.isFinite)
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
      envelopeMaximumSideMm,
      envelopeSpanMm,
      occupiedHullWasteRatio,
      totalStructuralContacts: beamState.nearCompleteStructuralContactCount,
      dominantStructuralContacts: beamState.dominantNearCompleteStructuralContactCount
    }
  }
}

/** Preregistered E5 lane selection over completed basin pools, without generic backfill. */
export function selectIntrinsicProjectionWorkItems(
  candidates: ReadonlyArray<IntrinsicProjectionLaneCandidate>,
  targetRoles: ReadonlyArray<IntrinsicGlobalTargetRole>
): IntrinsicProjectionWorkSelection {
  const distinctCandidates = new Map<string, IntrinsicProjectionLaneCandidate>()
  for (const candidate of candidates) {
    const identity = projectionWorkIdentity(candidate)
    const existing = distinctCandidates.get(identity)
    if (existing === undefined || compareProjectionCandidateRaw(candidate, existing) < 0) {
      distinctCandidates.set(identity, candidate)
    }
  }
  const available = [...distinctCandidates.values()]
  const selected: IntrinsicProjectionWorkItem[] = []
  const trace: IntrinsicProjectionLaneTrace[] = []
  const selectedIdentities = new Set<string>()

  const registerLane = (
    lane: IntrinsicProjectionLane,
    requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined,
    eligibleCandidates: ReadonlyArray<IntrinsicProjectionLaneCandidate>
  ): void => {
    if (eligibleCandidates.length === 0) {
      trace.push(unavailableProjectionLaneTrace(lane, requestedTargetRoleId))
      return
    }
    let skippedDuplicateCount = 0
    const candidate = eligibleCandidates.find((eligible) => {
      if (selectedIdentities.has(projectionWorkIdentity(eligible))) {
        skippedDuplicateCount += 1
        return false
      }
      return true
    })
    if (candidate === undefined) {
      const collapsed = projectionWorkItem(
        lane,
        requestedTargetRoleId,
        eligibleCandidates[0] as IntrinsicProjectionLaneCandidate
      )
      trace.push({
        ...projectionLaneTraceFromWork(collapsed),
        outcome: 'lane-collapsed',
        collapsedIntoWorkIdentity: collapsed.workIdentity,
        eligibleCandidateCount: eligibleCandidates.length,
        skippedDuplicateCount
      })
      return
    }
    const workItem = projectionWorkItem(lane, requestedTargetRoleId, candidate)
    selectedIdentities.add(workItem.workIdentity)
    selected.push(workItem)
    trace.push({
      ...projectionLaneTraceFromWork(workItem),
      outcome: 'selected',
      collapsedIntoWorkIdentity: undefined,
      eligibleCandidateCount: eligibleCandidates.length,
      skippedDuplicateCount
    })
  }

  registerLane('global-raw', undefined, available.toSorted(compareProjectionCandidateRaw))
  registerLane(
    'global-final-gls',
    undefined,
    available.toSorted(compareProjectionCandidateWeighted)
  )
  for (const role of targetRoles) {
    const disruption = available
      .filter(
        ({ targetRole, entry }) =>
          targetRole.id === role.id && entry.disruptionLineage
      )
      .toSorted(compareProjectionRoleLineageCandidate)
    registerLane('role-disruption', role.id, disruption)
  }

  return { workItems: selected.slice(0, 5), trace }
}

function projectionWorkIdentity(candidate: IntrinsicProjectionLaneCandidate): string {
  return `${candidate.targetRole.id}:${candidate.basinIndex}:${candidate.entry.key}`
}

function compareProjectionCandidateRaw(
  first: IntrinsicProjectionLaneCandidate,
  second: IntrinsicProjectionLaneCandidate
): number {
  return (
    comparePoolEntriesByRaw(first.entry, second.entry) ||
    first.targetRole.id.localeCompare(second.targetRole.id) ||
    first.basinIndex - second.basinIndex ||
    first.entry.key.localeCompare(second.entry.key)
  )
}

function compareProjectionCandidateWeighted(
  first: IntrinsicProjectionLaneCandidate,
  second: IntrinsicProjectionLaneCandidate
): number {
  return (
    comparePoolEntriesByWeight(first.entry, second.entry) ||
    first.targetRole.id.localeCompare(second.targetRole.id) ||
    first.basinIndex - second.basinIndex ||
    first.entry.key.localeCompare(second.entry.key)
  )
}

function compareProjectionRoleLineageCandidate(
  first: IntrinsicProjectionLaneCandidate,
  second: IntrinsicProjectionLaneCandidate
): number {
  return (
    first.entry.evaluation.weightedLoss - second.entry.evaluation.weightedLoss ||
    first.entry.evaluation.rawLoss - second.entry.evaluation.rawLoss ||
    first.entry.key.localeCompare(second.entry.key) ||
    first.basinIndex - second.basinIndex ||
    compareDisruptionLineageProvenance(
      first.entry.disruptionLineageProvenance,
      second.entry.disruptionLineageProvenance
    )
  )
}

function projectionWorkItem(
  lane: IntrinsicProjectionLane,
  requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined,
  candidate: IntrinsicProjectionLaneCandidate
): IntrinsicProjectionWorkItem {
  return {
    lane,
    requestedTargetRoleId,
    targetRole: candidate.targetRole,
    basinIndex: candidate.basinIndex,
    targetBox: candidate.targetBox,
    state: candidate.entry.state,
    stateKey: candidate.entry.key,
    evaluation: candidate.entry.evaluation,
    weights: candidate.weights,
    disruptionLineage: candidate.entry.disruptionLineage,
    disruptionLineageProvenance: candidate.entry.disruptionLineageProvenance,
    workIdentity: projectionWorkIdentity(candidate)
  }
}

function projectionLaneTraceFromWork(
  workItem: IntrinsicProjectionWorkItem
): Omit<
  IntrinsicProjectionLaneTrace,
  'outcome' | 'collapsedIntoWorkIdentity' | 'eligibleCandidateCount' | 'skippedDuplicateCount'
> {
  return {
    lane: workItem.lane,
    requestedTargetRoleId: workItem.requestedTargetRoleId,
    workIdentity: workItem.workIdentity,
    targetRoleId: workItem.targetRole.id,
    basinIndex: workItem.basinIndex,
    stateKey: workItem.stateKey,
    disruptionLineage: workItem.disruptionLineage,
    disruptionLineageProvenance: workItem.disruptionLineageProvenance,
    rawLoss: workItem.evaluation.rawLoss,
    weightedLoss: workItem.evaluation.weightedLoss
  }
}

function unavailableProjectionLaneTrace(
  lane: IntrinsicProjectionLane,
  requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined
): IntrinsicProjectionLaneTrace {
  return {
    lane,
    requestedTargetRoleId,
    outcome: 'lane-unavailable',
    workIdentity: undefined,
    collapsedIntoWorkIdentity: undefined,
    targetRoleId: undefined,
    basinIndex: undefined,
    stateKey: undefined,
    disruptionLineage: undefined,
    disruptionLineageProvenance: undefined,
    rawLoss: undefined,
    weightedLoss: undefined,
    eligibleCandidateCount: 0,
    skippedDuplicateCount: 0
  }
}

export function inheritIntrinsicDisruptionLineage(
  parentLineage: boolean,
  proposalKind: IntrinsicSeparatorProposal['kind']
): boolean {
  return parentLineage || isIntrinsicDisruptionProposalKind(proposalKind)
}

export function advanceIntrinsicDisruptionLineage(
  parent: Pick<
    IntrinsicInfeasiblePoolEntry,
    'disruptionLineage' | 'disruptionLineageProvenance'
  >,
  proposalKind: IntrinsicSeparatorProposal['kind'],
  sweepIndex: number,
  stateKey: string
): IntrinsicDisruptionLineageProvenance | undefined {
  if (parent.disruptionLineage && parent.disruptionLineageProvenance !== undefined) {
    return {
      ...parent.disruptionLineageProvenance,
      depth: parent.disruptionLineageProvenance.depth + 1
    }
  }
  return isIntrinsicDisruptionProposalKind(proposalKind)
    ? {
        originSweep: sweepIndex,
        originProposalKind: proposalKind,
        originStateKey: stateKey,
        depth: 0
      }
    : undefined
}

function isIntrinsicDisruptionProposalKind(
  proposalKind: IntrinsicSeparatorProposal['kind']
): proposalKind is IntrinsicDisruptionProposalKind {
  return (
    proposalKind === 'swap' ||
    proposalKind === 'group-transport' ||
    proposalKind === 'split-squeeze' ||
    proposalKind === 'interface-disrupt'
  )
}

function emptyDirectDisruptionProposalCounts(): IntrinsicDirectDisruptionProposalCounts {
  return { swap: 0, groupTransport: 0, splitSqueeze: 0, interfaceDisrupt: 0 }
}

function addDirectDisruptionProposalCounts(
  counts: IntrinsicDirectDisruptionProposalCounts,
  proposals: ReadonlyArray<IntrinsicSeparatorProposal>
): IntrinsicDirectDisruptionProposalCounts {
  let swap = counts.swap
  let groupTransport = counts.groupTransport
  let splitSqueeze = counts.splitSqueeze
  let interfaceDisrupt = counts.interfaceDisrupt
  for (const { kind } of proposals) {
    switch (kind) {
      case 'swap':
        swap += 1
        break
      case 'group-transport':
        groupTransport += 1
        break
      case 'split-squeeze':
        splitSqueeze += 1
        break
      case 'interface-disrupt':
        interfaceDisrupt += 1
        break
      default:
        break
    }
  }
  return { swap, groupTransport, splitSqueeze, interfaceDisrupt }
}

function projectionAttemptTraceBase(
  workItem: IntrinsicProjectionWorkItem,
  completedBasinCount: number,
  completedSweepCount: number,
  projectionAttempt: number
): Omit<
  IntrinsicProjectionAttemptTrace,
  | 'outcome'
  | 'failedPieceId'
  | 'dilationSteps'
  | 'structuralCanonicalGeometryIdentity'
  | 'handoffRetention'
> {
  return {
    lane: workItem.lane,
    requestedTargetRoleId: workItem.requestedTargetRoleId,
    targetRoleId: workItem.targetRole.id,
    basinIndex: workItem.basinIndex,
    stateKey: workItem.stateKey,
    disruptionLineage: workItem.disruptionLineage,
    disruptionLineageProvenance: workItem.disruptionLineageProvenance,
    completedBasinCount,
    completedSweepCount,
    projectionAttempt,
    rawLoss: workItem.evaluation.rawLoss,
    weightedLoss: workItem.evaluation.weightedLoss,
    conflictCount: workItem.evaluation.conflicts.length
  }
}

function addStructuralHandoff(
  handoffs: IntrinsicStructuralHandoff[],
  candidate: IntrinsicStructuralHandoff,
  capacity: number
): IntrinsicStructuralHandoffRetentionTrace {
  const boundedCapacity = Math.max(0, capacity)
  const candidateDiagnostic = structuralHandoffDiagnostic(candidate)
  const existingIndex = handoffs.findIndex(
    ({ metrics }) =>
      metrics.canonicalGeometryIdentity === candidate.metrics.canonicalGeometryIdentity
  )
  if (existingIndex >= 0) {
    const existing = handoffs[existingIndex]
    if (existing !== undefined && compareStructuralHandoffs(candidate, existing) < 0) {
      handoffs.splice(existingIndex, 1, candidate)
      handoffs.sort(compareStructuralHandoffs)
      handoffs.splice(boundedCapacity)
      return structuralRetentionTrace(
        'duplicate-replaced',
        candidateDiagnostic,
        structuralHandoffDiagnostic(candidate),
        structuralHandoffDiagnostic(existing),
        handoffs
      )
    }
    return structuralRetentionTrace(
      'duplicate-discarded',
      candidateDiagnostic,
      existing === undefined ? undefined : structuralHandoffDiagnostic(existing),
      candidateDiagnostic,
      handoffs
    )
  }

  handoffs.push(candidate)
  handoffs.sort(compareStructuralHandoffs)
  const pruned = handoffs.splice(boundedCapacity)[0]
  const retained = handoffs.includes(candidate)
  return structuralRetentionTrace(
    retained ? 'retained' : 'capacity-pruned',
    candidateDiagnostic,
    retained ? candidateDiagnostic : undefined,
    pruned === undefined ? undefined : structuralHandoffDiagnostic(pruned),
    handoffs
  )
}

/** Bounded canonical-identity structural archive with truthful retention diagnostics. */
export function retainIntrinsicStructuralHandoffsWithDiagnostics(
  candidates: ReadonlyArray<IntrinsicStructuralHandoff>,
  capacity: number
): {
  readonly handoffs: ReadonlyArray<IntrinsicStructuralHandoff>
  readonly trace: ReadonlyArray<IntrinsicStructuralHandoffRetentionTrace>
} {
  const handoffs: IntrinsicStructuralHandoff[] = []
  const trace = candidates.map((candidate) =>
    addStructuralHandoff(handoffs, candidate, capacity)
  )
  return { handoffs: [...handoffs], trace }
}

/** Bounded canonical-identity structural archive seam. */
export function retainIntrinsicStructuralHandoffs(
  candidates: ReadonlyArray<IntrinsicStructuralHandoff>,
  capacity: number
): ReadonlyArray<IntrinsicStructuralHandoff> {
  return retainIntrinsicStructuralHandoffsWithDiagnostics(candidates, capacity).handoffs
}

function structuralHandoffDiagnostic(
  handoff: IntrinsicStructuralHandoff
): IntrinsicStructuralHandoffDiagnostic {
  return {
    canonicalGeometryIdentity: handoff.metrics.canonicalGeometryIdentity,
    targetRoleId: handoff.targetRoleId,
    basinIndex: handoff.basinIndex,
    projectionAttempt: handoff.projectionAttempt,
    metrics: { ...handoff.metrics }
  }
}

function structuralRetentionTrace(
  outcome: IntrinsicStructuralHandoffRetentionTrace['outcome'],
  candidate: IntrinsicStructuralHandoffDiagnostic,
  representative: IntrinsicStructuralHandoffDiagnostic | undefined,
  pruned: IntrinsicStructuralHandoffDiagnostic | undefined,
  handoffs: ReadonlyArray<IntrinsicStructuralHandoff>
): IntrinsicStructuralHandoffRetentionTrace {
  return {
    outcome,
    candidate,
    representative,
    pruned,
    retainedCanonicalGeometryIdentities: handoffs.map(
      ({ metrics }) => metrics.canonicalGeometryIdentity
    )
  }
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
    first.metrics.canonicalGeometryIdentity.localeCompare(
      second.metrics.canonicalGeometryIdentity
    )
  )
}

/** Width-bounded raw, direct-disruption, GLS, active-lineage, and Pareto retention. */
export function retainIntrinsicInfeasiblePool(
  candidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>,
  capacity: number,
  weights: IntrinsicSeparatorWeights,
  sweepIndex: number
): ReadonlyArray<IntrinsicInfeasiblePoolEntry> {
  return retainIntrinsicInfeasiblePoolWithDiagnostics(
    candidates,
    capacity,
    weights,
    sweepIndex
  ).pool
}

export function retainIntrinsicInfeasiblePoolWithDiagnostics(
  candidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>,
  capacity: number,
  weights: IntrinsicSeparatorWeights,
  sweepIndex: number
): IntrinsicInfeasiblePoolRetention {
  const boundedCapacity = Math.max(1, capacity)
  const reweighted = reweightIntrinsicPool(candidates, weights)
  const unique = new Map<string, IntrinsicInfeasiblePoolEntry>()
  for (const candidate of reweighted) {
    const existing = unique.get(candidate.key)
    if (existing === undefined) {
      unique.set(candidate.key, candidate)
      continue
    }
    const preferred =
      compareDuplicatePoolEntries(candidate, existing, sweepIndex) < 0
        ? candidate
        : existing
    unique.set(candidate.key, {
      ...preferred,
      disruptionLineage: candidate.disruptionLineage || existing.disruptionLineage,
      disruptionLineageProvenance: preferredDisruptionLineageProvenance(
        candidate,
        existing
      )
    })
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
  const lineageRanked = values
    .filter(({ disruptionLineage }) => disruptionLineage)
    .toSorted(compareActiveLineageEntries)
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
  const distinctActiveLineage = lineageRanked.find(
    (candidate) => !selected.some(({ key }) => key === candidate.key)
  )
  let activeLineageRetentionOutcome: IntrinsicInfeasiblePoolRetention['activeLineageRetentionOutcome']
  let activeLineageRetentionReason: string
  let reservedLineageEntry: IntrinsicInfeasiblePoolEntry | undefined
  if (lineageRanked.length === 0) {
    activeLineageRetentionOutcome = 'lane-unavailable'
    activeLineageRetentionReason = 'no lineage-bearing state survived same-key deduplication'
  } else if (distinctActiveLineage === undefined) {
    activeLineageRetentionOutcome = 'retained-by-prior-lane'
    activeLineageRetentionReason =
      'the best lineage-bearing identity was already retained by an earlier semantic lane'
    reservedLineageEntry = lineageRanked.find((candidate) =>
      selected.some(({ key }) => key === candidate.key)
    )
  } else if (selected.length >= boundedCapacity) {
    activeLineageRetentionOutcome = 'capacity-evicted'
    activeLineageRetentionReason =
      'pool capacity was exhausted by the raw, direct-disruption, and weighted reservations'
    reservedLineageEntry = distinctActiveLineage
  } else {
    addUniquePoolEntry(selected, distinctActiveLineage, boundedCapacity)
    activeLineageRetentionOutcome = 'reserved-active-lineage'
    activeLineageRetentionReason =
      'the best distinct lineage-bearing state received the persistent active reservation'
    reservedLineageEntry = distinctActiveLineage
  }
  for (const candidate of pareto) addUniquePoolEntry(selected, candidate, boundedCapacity)
  for (const candidate of rawRanked) addUniquePoolEntry(selected, candidate, boundedCapacity)
  const rawWinner = rawRanked[0]
  const pool = rawWinner === undefined
    ? []
    : [rawWinner, ...selected.filter(({ key }) => key !== rawWinner.key)]
  return {
    pool,
    preDeduplicationLineageCount: reweighted.filter(({ disruptionLineage }) => disruptionLineage)
      .length,
    postDeduplicationLineageCount: lineageRanked.length,
    retainedLineageCount: pool.filter(({ disruptionLineage }) => disruptionLineage).length,
    reservedLineage:
      reservedLineageEntry === undefined
        ? undefined
        : intrinsicLineageWitnessTrace(reservedLineageEntry),
    activeLineageRetentionOutcome,
    activeLineageRetentionReason
  }
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

function compareActiveLineageEntries(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry
): number {
  return (
    first.evaluation.weightedLoss - second.evaluation.weightedLoss ||
    first.evaluation.rawLoss - second.evaluation.rawLoss ||
    first.key.localeCompare(second.key) ||
    compareDisruptionLineageProvenance(
      first.disruptionLineageProvenance,
      second.disruptionLineageProvenance
    )
  )
}

function preferredDisruptionLineageProvenance(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry
): IntrinsicDisruptionLineageProvenance | undefined {
  const candidates = [
    ...(first.disruptionLineageProvenance === undefined
      ? []
      : [first.disruptionLineageProvenance]),
    ...(second.disruptionLineageProvenance === undefined
      ? []
      : [second.disruptionLineageProvenance])
  ]
  return candidates.toSorted(compareDisruptionLineageProvenance)[0]
}

function compareDisruptionLineageProvenance(
  first: IntrinsicDisruptionLineageProvenance | undefined,
  second: IntrinsicDisruptionLineageProvenance | undefined
): number {
  if (first === undefined) return second === undefined ? 0 : 1
  if (second === undefined) return -1
  return (
    first.originSweep - second.originSweep ||
    disruptionProposalKindOrdinal(first.originProposalKind) -
      disruptionProposalKindOrdinal(second.originProposalKind) ||
    first.originStateKey.localeCompare(second.originStateKey) ||
    first.depth - second.depth
  )
}

function disruptionProposalKindOrdinal(kind: IntrinsicDisruptionProposalKind): number {
  switch (kind) {
    case 'swap':
      return 0
    case 'group-transport':
      return 1
    case 'split-squeeze':
      return 2
    case 'interface-disrupt':
      return 3
  }
}

function intrinsicLineageWitnessTrace(
  entry: IntrinsicInfeasiblePoolEntry
): IntrinsicLineageWitnessTrace | undefined {
  const provenance = entry.disruptionLineageProvenance
  return provenance === undefined
    ? undefined
    : {
        stateKey: entry.key,
        rawLoss: entry.evaluation.rawLoss,
        weightedLoss: entry.evaluation.weightedLoss,
        originSweep: provenance.originSweep,
        originProposalKind: provenance.originProposalKind,
        originStateKey: provenance.originStateKey,
        depth: provenance.depth
      }
}

function updateIntrinsicLineageShadowSnapshot(
  current: IntrinsicLineageWitnessTrace | undefined,
  candidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>
): {
  readonly snapshot: IntrinsicLineageWitnessTrace | undefined
  readonly outcome: IntrinsicGlobalSweepTrace['shadowLineageSnapshotOutcome']
  readonly reason: string
} {
  const candidate = candidates
    .filter(({ disruptionLineage }) => disruptionLineage)
    .map(intrinsicLineageWitnessTrace)
    .filter((entry): entry is IntrinsicLineageWitnessTrace => entry !== undefined)
    .toSorted(compareLineageWitnessForShadow)[0]
  if (candidate === undefined) {
    return current === undefined
      ? {
          snapshot: undefined,
          outcome: 'lane-unavailable',
          reason: 'the pre-truncation candidate set contained no lineage witness'
        }
      : {
          snapshot: current,
          outcome: 'retained-no-current-lineage',
          reason: 'the earlier shadow witness was retained because this sweep generated none'
        }
  }
  if (current === undefined) {
    return {
      snapshot: candidate,
      outcome: 'initialized',
      reason: 'the first pre-truncation lineage witness initialized the basin shadow'
    }
  }
  if (compareLineageWitnessForShadow(candidate, current) < 0) {
    return {
      snapshot: candidate,
      outcome: 'replaced',
      reason: 'a better raw-loss, weighted-loss, or state-key witness replaced the shadow'
    }
  }
  return {
    snapshot: current,
    outcome: 'retained-earlier-or-better',
    reason: 'the earlier shadow witness won or tied the deterministic witness order'
  }
}

function compareLineageWitnessForShadow(
  first: IntrinsicLineageWitnessTrace,
  second: IntrinsicLineageWitnessTrace
): number {
  return (
    first.rawLoss - second.rawLoss ||
    first.weightedLoss - second.weightedLoss ||
    first.stateKey.localeCompare(second.stateKey)
  )
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
  const widthGrid = floorIntrinsicTargetGrid(widthMm)
  const heightGrid = floorIntrinsicTargetGrid(heightMm)
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

export function floorIntrinsicTargetGrid(valueMm: number): number | undefined {
  if (!Number.isFinite(valueMm) || valueMm <= 0) return undefined
  const nearestGrid = toGridMm(valueMm)
  if (nearestGrid === undefined) return undefined
  const grid = fromGrid(nearestGrid) <= valueMm ? nearestGrid : nearestGrid - 1
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

function hashIntrinsicSeed(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

function sameSortedPieceIds(
  first: ReadonlyArray<PieceId>,
  second: ReadonlyArray<PieceId>
): boolean {
  return (
    first.length === second.length &&
    first.every((pieceId, index) => pieceId === second[index])
  )
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
