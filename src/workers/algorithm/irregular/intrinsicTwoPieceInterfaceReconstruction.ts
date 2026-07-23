import { performance } from 'node:perf_hooks'
import { Effect } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularTransform,
  type IrregularNestingSettings,
  type IrregularPreparedPiece
} from '@shared/irregular/domain.js'
import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutContacts
} from '../../irregular/canonicalLayoutGeometry.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import { PlacementValidation } from '../../irregular/placementValidation.js'
import {
  IrregularNfpIfpCandidateMemoScope,
  NfpIfpService
} from '../../irregular/services.js'
import {
  measureRelaxationMetrics,
  type IntrinsicRelaxationMetrics
} from './overlapRelaxation.js'
import { isAdmissibleTargetedImprovement } from './targetedExactLns.js'

export interface IntrinsicTwoPieceInterfaceReconstructionResult {
  readonly status:
    | 'completed'
    | 'invalid-seed'
    | 'deadline-exhausted'
    | 'candidate-cap-exhausted'
  readonly runtimeMs: number
  readonly maximumRuntimeMs: number
  readonly maximumCandidateEvaluations: number
  readonly candidateEvaluations: number
  readonly pairCount: number
  readonly orderCount: number
  readonly exactEndpointCount: number
  readonly admissibleEndpointCount: number
  readonly detachedPieceIds: ReadonlyArray<PieceId>
  readonly interfacePieceIds: ReadonlyArray<PieceId>
  readonly selectedPair: readonly [PieceId, PieceId] | undefined
  readonly selectedOrder: ReadonlyArray<PieceId> | undefined
  readonly bestExactPair: readonly [PieceId, PieceId] | undefined
  readonly bestExactOrder: ReadonlyArray<PieceId> | undefined
  readonly seedMetrics: IntrinsicRelaxationMetrics | undefined
  readonly selectedMetrics: IntrinsicRelaxationMetrics | undefined
  readonly bestExactMetrics: IntrinsicRelaxationMetrics | undefined
  readonly admissionGuardPassed: boolean
  readonly promotionEligible: boolean
  readonly outputInfluence: 'none'
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly admissionGuardPlacedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly bestExactPlacedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
}

export interface IntrinsicLostInterfaceRepairResult {
  readonly status:
    | 'completed'
    | 'invalid-seed'
    | 'no-lost-interface'
    | 'deadline-exhausted'
    | 'candidate-cap-exhausted'
  readonly runtimeMs: number
  readonly maximumRuntimeMs: number
  readonly maximumCandidateEvaluations: number
  readonly candidateEvaluations: number
  readonly triplePieceIds: ReadonlyArray<PieceId>
  readonly lostContactPair: readonly [PieceId, PieceId] | undefined
  readonly orderCount: number
  readonly exactEndpointCount: number
  readonly admissionGuardEndpointCount: number
  readonly promotionEndpointCount: number
  readonly admissionGuardPassed: boolean
  readonly promotionEligible: boolean
  readonly outputInfluence: 'none'
  readonly seedMetrics: IntrinsicRelaxationMetrics | undefined
  readonly diagnosticMetrics: IntrinsicRelaxationMetrics | undefined
  readonly bestExactMetrics: IntrinsicRelaxationMetrics | undefined
  readonly diagnosticOrder: ReadonlyArray<PieceId> | undefined
  readonly bestExactOrder: ReadonlyArray<PieceId> | undefined
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly diagnosticPlacedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly bestExactPlacedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
}

interface ExactCandidate {
  readonly pair: readonly [PieceId, PieceId]
  readonly order: ReadonlyArray<PieceId>
  readonly identity: string
  readonly metrics: IntrinsicRelaxationMetrics
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
}

interface TripleCandidate {
  readonly order: ReadonlyArray<PieceId>
  readonly identity: string
  readonly metrics: IntrinsicRelaxationMetrics
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
}

interface CandidateBudget {
  count: number
  exhausted: boolean
}

const DEFAULT_MAXIMUM_RUNTIME_MS = 30_000
const DEFAULT_MAXIMUM_CANDIDATE_EVALUATIONS = 200_000

/**
 * Reconstructs one detached piece together with one piece from the largest
 * contact component, without beam or local-fanout truncation.
 */
export function runIntrinsicTwoPieceInterfaceReconstruction(input: {
  readonly sheet: SheetSpec
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly seedPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly maximumRuntimeMs?: number
  readonly maximumCandidateEvaluations?: number
}): Effect.Effect<
  IntrinsicTwoPieceInterfaceReconstructionResult,
  unknown,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const maximumRuntimeMs = Math.max(
      1,
      input.maximumRuntimeMs ?? DEFAULT_MAXIMUM_RUNTIME_MS
    )
    const maximumCandidateEvaluations = Math.max(
      1,
      Math.floor(
        input.maximumCandidateEvaluations ??
          DEFAULT_MAXIMUM_CANDIDATE_EVALUATIONS
      )
    )
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const seedMetrics = measureRelaxationMetrics(input.seedPlaced)
    const structure = analyzeCanonicalLayoutStructure(
      input.sheet,
      input.seedPlaced
    )
    if (
      seedMetrics === undefined ||
      structure === undefined ||
      !assertCanonicalGridLegalLayout(input.sheet, input.seedPlaced)
    ) {
      return invalidResult({
        input,
        startedAt,
        maximumRuntimeMs,
        maximumCandidateEvaluations,
        seedMetrics
      })
    }
    const largestComponent = [...structure.positiveContactComponents]
      .toSorted(
        (first, second) =>
          second.length - first.length ||
          componentKey(first).localeCompare(componentKey(second))
      )[0]
    const interfacePieceIds = [...(largestComponent ?? [])].toSorted()
    const interfacePieceIdSet = new Set(interfacePieceIds)
    const detachedPieceIds = input.seedPlaced
      .map(placedPieceId)
      .filter((pieceId) => !interfacePieceIdSet.has(pieceId))
      .toSorted()
    const preparedById = new Map(
      input.allPreparedPieces.map(
        (piece) => [preparedPieceId(piece), piece] as const
      )
    )
    const incumbentById = new Map(
      input.seedPlaced.map((piece) => [placedPieceId(piece), piece] as const)
    )
    const memoScope = new IrregularNfpIfpCandidateMemoScope()
    const budget: CandidateBudget = { count: 0, exhausted: false }
    const acceptedCandidates: ExactCandidate[] = []
    let bestExactCandidate: ExactCandidate | undefined
    const seenExactIdentities = new Set<string>()
    let exactEndpointCount = 0
    let admissibleEndpointCount = 0
    let orderCount = 0
    let deadlineExhausted = false

    outer: for (const detachedPieceId of detachedPieceIds) {
      for (const interfacePieceId of interfacePieceIds) {
        const pair = [detachedPieceId, interfacePieceId] as const
        const frozen = input.seedPlaced.filter(
          (entry) => !pair.includes(placedPieceId(entry))
        )
        for (const order of [
          [detachedPieceId, interfacePieceId],
          [interfacePieceId, detachedPieceId]
        ] as const) {
          orderCount += 1
          if (performance.now() - startedAt >= maximumRuntimeMs) {
            deadlineExhausted = true
            break outer
          }
          const firstPiece = preparedById.get(order[0])
          const secondPiece = preparedById.get(order[1])
          if (firstPiece === undefined || secondPiece === undefined) continue
          const firstCandidates = yield* enumeratePlacedCandidates({
            sheet: input.sheet,
            placed: frozen,
            piece: firstPiece,
            incumbent: incumbentById.get(order[0]),
            settings,
            geometryKernel,
            nfpIfpService,
            memoScope,
            budget,
            maximumCandidateEvaluations
          })
          if (budget.exhausted) break outer
          for (const firstPlaced of firstCandidates) {
            if (performance.now() - startedAt >= maximumRuntimeMs) {
              deadlineExhausted = true
              break outer
            }
            const secondCandidates = yield* enumeratePlacedCandidates({
              sheet: input.sheet,
              placed: [...frozen, firstPlaced],
              piece: secondPiece,
              incumbent: incumbentById.get(order[1]),
              settings,
              geometryKernel,
              nfpIfpService,
              memoScope,
              budget,
              maximumCandidateEvaluations
            })
            if (budget.exhausted) break outer
            for (const secondPlaced of secondCandidates) {
              const replacements = new Map([
                [order[0], firstPlaced],
                [order[1], secondPlaced]
              ])
              const candidateLayout = input.seedPlaced.map(
                (entry) => replacements.get(placedPieceId(entry)) ?? entry
              )
              if (
                !assertCanonicalGridLegalLayout(input.sheet, candidateLayout)
              ) {
                continue
              }
              const identity =
                canonicalCollisionLayoutIdentity(candidateLayout)
              if (
                identity === undefined ||
                seenExactIdentities.has(identity)
              ) {
                continue
              }
              seenExactIdentities.add(identity)
              exactEndpointCount += 1
              const metrics = measureRelaxationMetrics(candidateLayout)
              if (metrics === undefined) {
                continue
              }
              const exactCandidate = {
                pair,
                order,
                identity,
                metrics,
                placedCollisionGeometries: candidateLayout
              }
              if (
                bestExactCandidate === undefined ||
                compareCandidates(exactCandidate, bestExactCandidate) < 0
              ) {
                bestExactCandidate = exactCandidate
              }
              if (!isAdmissibleTargetedImprovement(seedMetrics, metrics)) continue
              admissibleEndpointCount += 1
              acceptedCandidates.push(exactCandidate)
            }
          }
        }
      }
    }

    acceptedCandidates.sort(compareCandidates)
    const selected = acceptedCandidates[0]
    const status = deadlineExhausted
      ? 'deadline-exhausted'
      : budget.exhausted
        ? 'candidate-cap-exhausted'
        : 'completed'
    const promotionCandidate =
      status === 'completed'
        ? acceptedCandidates.find((candidate) =>
            strictlyImprovesTopology(seedMetrics, candidate.metrics)
          )
        : undefined
    return {
      status,
      runtimeMs: performance.now() - startedAt,
      maximumRuntimeMs,
      maximumCandidateEvaluations,
      candidateEvaluations: budget.count,
      pairCount: detachedPieceIds.length * interfacePieceIds.length,
      orderCount,
      exactEndpointCount,
      admissibleEndpointCount,
      detachedPieceIds,
      interfacePieceIds,
      selectedPair: selected?.pair,
      selectedOrder: selected?.order,
      bestExactPair: bestExactCandidate?.pair,
      bestExactOrder: bestExactCandidate?.order,
      seedMetrics,
      selectedMetrics: selected?.metrics ?? seedMetrics,
      bestExactMetrics: bestExactCandidate?.metrics,
      admissionGuardPassed: selected !== undefined,
      promotionEligible: promotionCandidate !== undefined,
      outputInfluence: 'none',
      placedCollisionGeometries: input.seedPlaced,
      admissionGuardPlacedCollisionGeometries:
        selected?.placedCollisionGeometries ?? input.seedPlaced,
      bestExactPlacedCollisionGeometries:
        bestExactCandidate?.placedCollisionGeometries ?? input.seedPlaced
    }
  })
}

/**
 * Repairs exactly one structural contact displaced by the best two-piece
 * diagnostic. It never widens beyond the derived three-piece neighborhood.
 */
export function runIntrinsicLostInterfaceRepair(input: {
  readonly sheet: SheetSpec
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly seedPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly twoPieceDiagnosticPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly twoPiecePair: readonly [PieceId, PieceId] | undefined
  readonly maximumRuntimeMs?: number
  readonly maximumCandidateEvaluations?: number
}): Effect.Effect<
  IntrinsicLostInterfaceRepairResult,
  unknown,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const maximumRuntimeMs = Math.max(
      1,
      input.maximumRuntimeMs ?? DEFAULT_MAXIMUM_RUNTIME_MS
    )
    const maximumCandidateEvaluations = Math.max(
      1,
      Math.floor(
        input.maximumCandidateEvaluations ??
          DEFAULT_MAXIMUM_CANDIDATE_EVALUATIONS
      )
    )
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const seedMetrics = measureRelaxationMetrics(input.seedPlaced)
    const seedStructure = analyzeCanonicalLayoutStructure(
      input.sheet,
      input.seedPlaced
    )
    const diagnosticStructure = analyzeCanonicalLayoutStructure(
      input.sheet,
      input.twoPieceDiagnosticPlaced
    )
    if (
      seedMetrics === undefined ||
      seedStructure === undefined ||
      diagnosticStructure === undefined ||
      input.twoPiecePair === undefined ||
      !assertCanonicalGridLegalLayout(input.sheet, input.seedPlaced) ||
      !assertCanonicalGridLegalLayout(
        input.sheet,
        input.twoPieceDiagnosticPlaced
      )
    ) {
      return invalidTripleResult({
        status: 'invalid-seed',
        input,
        startedAt,
        maximumRuntimeMs,
        maximumCandidateEvaluations,
        seedMetrics
      })
    }
    const largestSeedComponent = [...seedStructure.positiveContactComponents]
      .toSorted(
        (first, second) =>
          second.length - first.length ||
          componentKey(first).localeCompare(componentKey(second))
      )[0]
    const largestSeedIds = new Set(largestSeedComponent ?? [])
    const movedInterfacePieceId = input.twoPiecePair.find((pieceId) =>
      largestSeedIds.has(pieceId)
    )
    const detachedPieceId = input.twoPiecePair.find(
      (pieceId) => pieceId !== movedInterfacePieceId
    )
    if (
      movedInterfacePieceId === undefined ||
      detachedPieceId === undefined
    ) {
      return invalidTripleResult({
        status: 'no-lost-interface',
        input,
        startedAt,
        maximumRuntimeMs,
        maximumCandidateEvaluations,
        seedMetrics
      })
    }
    const seedById = new Map(
      input.seedPlaced.map((piece) => [placedPieceId(piece), piece] as const)
    )
    const diagnosticById = new Map(
      input.twoPieceDiagnosticPlaced.map(
        (piece) => [placedPieceId(piece), piece] as const
      )
    )
    const lostContactPair = seedStructure.positiveContactPairs
      .filter(
        ([first, second]) =>
          first === movedInterfacePieceId || second === movedInterfacePieceId
      )
      .map((pair) => {
        const seedFirst = seedById.get(pair[0])
        const seedSecond = seedById.get(pair[1])
        const diagnosticFirst = diagnosticById.get(pair[0])
        const diagnosticSecond = diagnosticById.get(pair[1])
        const seedContact =
          seedFirst === undefined || seedSecond === undefined
            ? undefined
            : measureCanonicalLayoutContacts([seedFirst, seedSecond])
        const diagnosticContact =
          diagnosticFirst === undefined || diagnosticSecond === undefined
            ? undefined
            : measureCanonicalLayoutContacts([
                diagnosticFirst,
                diagnosticSecond
              ])
        return { pair, seedContact, diagnosticContact }
      })
      .filter(
        ({ seedContact, diagnosticContact }) =>
          seedContact !== undefined &&
          (diagnosticContact === undefined ||
            diagnosticContact.totalStructuralContacts <
              seedContact.totalStructuralContacts ||
            diagnosticContact.sharedBoundaryLengthMm <
              seedContact.sharedBoundaryLengthMm - 1e-9)
      )
      .toSorted(
        (first, second) =>
          Number((second.seedContact?.totalStructuralContacts ?? 0) > 0) -
            Number((first.seedContact?.totalStructuralContacts ?? 0) > 0) ||
          (second.seedContact?.sharedBoundaryLengthMm ?? 0) -
            (first.seedContact?.sharedBoundaryLengthMm ?? 0) ||
          otherPairEndpoint(first.pair, movedInterfacePieceId).localeCompare(
            otherPairEndpoint(second.pair, movedInterfacePieceId)
          )
      )[0]?.pair
    if (lostContactPair === undefined) {
      return invalidTripleResult({
        status: 'no-lost-interface',
        input,
        startedAt,
        maximumRuntimeMs,
        maximumCandidateEvaluations,
        seedMetrics
      })
    }
    const lostNeighborPieceId = otherPairEndpoint(
      lostContactPair,
      movedInterfacePieceId
    )
    const triplePieceIds = [
      detachedPieceId,
      movedInterfacePieceId,
      lostNeighborPieceId
    ] as const
    if (new Set(triplePieceIds).size !== 3) {
      return invalidTripleResult({
        status: 'no-lost-interface',
        input,
        startedAt,
        maximumRuntimeMs,
        maximumCandidateEvaluations,
        seedMetrics
      })
    }
    const preparedById = new Map(
      input.allPreparedPieces.map(
        (piece) => [preparedPieceId(piece), piece] as const
      )
    )
    const frozen = input.seedPlaced.filter(
      (piece) => !triplePieceIds.includes(placedPieceId(piece))
    )
    const memoScope = new IrregularNfpIfpCandidateMemoScope()
    const budget: CandidateBudget = { count: 0, exhausted: false }
    const seenExactIdentities = new Set<string>()
    const guardCandidates: TripleCandidate[] = []
    const promotionCandidates: TripleCandidate[] = []
    let bestExactCandidate: TripleCandidate | undefined
    let exactEndpointCount = 0
    let orderCount = 0
    let deadlineExhausted = false

    outer: for (const order of permutations(triplePieceIds)) {
      orderCount += 1
      const firstPiece = preparedById.get(order[0])
      const secondPiece = preparedById.get(order[1])
      const thirdPiece = preparedById.get(order[2])
      if (
        firstPiece === undefined ||
        secondPiece === undefined ||
        thirdPiece === undefined
      ) {
        continue
      }
      const firstCandidates = yield* enumeratePlacedCandidates({
        sheet: input.sheet,
        placed: frozen,
        piece: firstPiece,
        incumbent: seedById.get(order[0]),
        settings,
        geometryKernel,
        nfpIfpService,
        memoScope,
        budget,
        maximumCandidateEvaluations
      })
      if (budget.exhausted) break
      for (const firstPlaced of firstCandidates) {
        const secondCandidates = yield* enumeratePlacedCandidates({
          sheet: input.sheet,
          placed: [...frozen, firstPlaced],
          piece: secondPiece,
          incumbent: seedById.get(order[1]),
          settings,
          geometryKernel,
          nfpIfpService,
          memoScope,
          budget,
          maximumCandidateEvaluations
        })
        if (budget.exhausted) break outer
        for (const secondPlaced of secondCandidates) {
          const thirdCandidates = yield* enumeratePlacedCandidates({
            sheet: input.sheet,
            placed: [...frozen, firstPlaced, secondPlaced],
            piece: thirdPiece,
            incumbent: seedById.get(order[2]),
            settings,
            geometryKernel,
            nfpIfpService,
            memoScope,
            budget,
            maximumCandidateEvaluations
          })
          if (budget.exhausted) break outer
          for (const thirdPlaced of thirdCandidates) {
            if (performance.now() - startedAt >= maximumRuntimeMs) {
              deadlineExhausted = true
              break outer
            }
            if (budget.count > maximumCandidateEvaluations) {
              budget.exhausted = true
              break outer
            }
            const replacements = new Map([
              [order[0], firstPlaced],
              [order[1], secondPlaced],
              [order[2], thirdPlaced]
            ])
            const candidateLayout = input.seedPlaced.map(
              (piece) => replacements.get(placedPieceId(piece)) ?? piece
            )
            if (!assertCanonicalGridLegalLayout(input.sheet, candidateLayout)) {
              continue
            }
            const identity = canonicalCollisionLayoutIdentity(candidateLayout)
            if (
              identity === undefined ||
              seenExactIdentities.has(identity)
            ) {
              continue
            }
            seenExactIdentities.add(identity)
            exactEndpointCount += 1
            const metrics = measureRelaxationMetrics(candidateLayout)
            if (metrics === undefined) continue
            const candidate = {
              order,
              identity,
              metrics,
              placedCollisionGeometries: candidateLayout
            }
            if (
              bestExactCandidate === undefined ||
              compareTripleCandidates(candidate, bestExactCandidate) < 0
            ) {
              bestExactCandidate = candidate
            }
            if (!isAdmissibleTargetedImprovement(seedMetrics, metrics)) continue
            guardCandidates.push(candidate)
            if (strictlyImprovesTopology(seedMetrics, metrics)) {
              promotionCandidates.push(candidate)
            }
          }
        }
      }
    }
    guardCandidates.sort(compareTripleCandidates)
    promotionCandidates.sort(compareTripleCandidates)
    const diagnostic = guardCandidates[0]
    const promotion = promotionCandidates[0]
    const status = deadlineExhausted
      ? 'deadline-exhausted'
      : budget.exhausted
        ? 'candidate-cap-exhausted'
        : 'completed'
    const promotionEligible = status === 'completed' && promotion !== undefined
    return {
      status,
      runtimeMs: performance.now() - startedAt,
      maximumRuntimeMs,
      maximumCandidateEvaluations,
      candidateEvaluations: budget.count,
      triplePieceIds,
      lostContactPair,
      orderCount,
      exactEndpointCount,
      admissionGuardEndpointCount: guardCandidates.length,
      promotionEndpointCount: promotionCandidates.length,
      admissionGuardPassed: diagnostic !== undefined,
      promotionEligible,
      outputInfluence: 'none',
      seedMetrics,
      diagnosticMetrics: diagnostic?.metrics,
      bestExactMetrics: bestExactCandidate?.metrics,
      diagnosticOrder: diagnostic?.order,
      bestExactOrder: bestExactCandidate?.order,
      placedCollisionGeometries: input.seedPlaced,
      diagnosticPlacedCollisionGeometries:
        diagnostic?.placedCollisionGeometries ?? input.seedPlaced,
      bestExactPlacedCollisionGeometries:
        bestExactCandidate?.placedCollisionGeometries ?? input.seedPlaced
    }
  })
}

function enumeratePlacedCandidates(input: {
  readonly sheet: SheetSpec
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly piece: IrregularPreparedPiece
  readonly incumbent: IrregularPlacedPiece | undefined
  readonly settings: IrregularNestingSettings
  readonly geometryKernel: GeometryKernel.Service
  readonly nfpIfpService: NfpIfpService
  readonly memoScope: IrregularNfpIfpCandidateMemoScope
  readonly budget: CandidateBudget
  readonly maximumCandidateEvaluations: number
}): Effect.Effect<ReadonlyArray<IrregularPlacedPiece>, unknown> {
  return Effect.gen(function* () {
    const result: IrregularPlacedPiece[] = []
    const seen = new Set<string>()
    const transforms = [...input.piece.transforms].toSorted(
      (first, second) =>
        first.index - second.index ||
        first.rotationDeg - second.rotationDeg ||
        Number(first.mirrored) - Number(second.mirrored) ||
        first.reason.localeCompare(second.reason)
    )
    for (const transform of transforms) {
      const moving = yield* input.geometryKernel.transformCollisionGeometry({
        geometry: input.piece.collisionGeometry,
        transform
      })
      const generated =
        yield* input.nfpIfpService.generatePlacementCandidates({
          sheet: input.sheet,
          placed: input.placed,
          moving,
          settings: input.settings,
          candidateDomain: 'sheet',
          candidateMemoScope: input.memoScope
        })
      const candidates = [...generated]
      if (
        input.incumbent !== undefined &&
        input.incumbent.collisionGeometry.transform.index === transform.index
      ) {
        const incumbentCandidate = new IrregularPlacementCandidate({
          pieceId: preparedPieceId(input.piece),
          transform,
          point: {
            x: input.incumbent.placement.transform.translateX,
            y: input.incumbent.placement.transform.translateY
          },
          diagnostics: []
        })
        const legal = yield* PlacementValidation.check({
          sheet: input.sheet,
          placed: input.placed,
          moving,
          candidate: incumbentCandidate
        })
        if (legal) candidates.push(incumbentCandidate)
      }
      for (const candidate of candidates) {
        if (input.budget.count >= input.maximumCandidateEvaluations) {
          input.budget.exhausted = true
          return result
        }
        input.budget.count += 1
        const key = `${transform.index}:${candidate.point.x}:${candidate.point.y}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push(
          new IrregularPlacedPiece({
            placement: makePlacement(input.piece, candidate),
            collisionGeometry: moving
          })
        )
      }
    }
    return result
  })
}

function compareCandidates(
  first: ExactCandidate,
  second: ExactCandidate
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
    [first.metrics.span, second.metrics.span]
  ]
  for (const [left, right] of pairs) {
    if (left !== right) return left < right ? -1 : 1
  }
  return (
    first.pair[0].localeCompare(second.pair[0]) ||
    first.pair[1].localeCompare(second.pair[1]) ||
    first.order.join('|').localeCompare(second.order.join('|')) ||
    first.identity.localeCompare(second.identity)
  )
}

function compareTripleCandidates(
  first: TripleCandidate,
  second: TripleCandidate
): number {
  const topologyDifference =
    first.metrics.topology.positiveContactComponentCount -
      second.metrics.topology.positiveContactComponentCount ||
    first.metrics.topology.isolatedPieceCount -
      second.metrics.topology.isolatedPieceCount ||
    second.metrics.topology.largestPositiveContactComponentSize -
      first.metrics.topology.largestPositiveContactComponentSize
  return (
    topologyDifference ||
    first.metrics.maxSide - second.metrics.maxSide ||
    first.metrics.area - second.metrics.area ||
    first.metrics.span - second.metrics.span ||
    first.order.join('|').localeCompare(second.order.join('|')) ||
    first.identity.localeCompare(second.identity)
  )
}

function strictlyImprovesTopology(
  seed: IntrinsicRelaxationMetrics,
  candidate: IntrinsicRelaxationMetrics
): boolean {
  return (
    candidate.topology.positiveContactComponentCount <
      seed.topology.positiveContactComponentCount ||
    candidate.topology.isolatedPieceCount <
      seed.topology.isolatedPieceCount ||
    candidate.topology.largestPositiveContactComponentSize >
      seed.topology.largestPositiveContactComponentSize
  )
}

function makePlacement(
  piece: IrregularPreparedPiece,
  candidate: IrregularPlacementCandidate
): IrregularPlacement {
  const placementInput = {
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
    ? new IrregularPlacement(placementInput)
    : new IrregularPlacement({ ...placementInput, pieceId: piece.pieceId })
}

function invalidResult(input: {
  readonly input: {
    readonly seedPlaced: ReadonlyArray<IrregularPlacedPiece>
  }
  readonly startedAt: number
  readonly maximumRuntimeMs: number
  readonly maximumCandidateEvaluations: number
  readonly seedMetrics: IntrinsicRelaxationMetrics | undefined
}): IntrinsicTwoPieceInterfaceReconstructionResult {
  return {
    status: 'invalid-seed',
    runtimeMs: performance.now() - input.startedAt,
    maximumRuntimeMs: input.maximumRuntimeMs,
    maximumCandidateEvaluations: input.maximumCandidateEvaluations,
    candidateEvaluations: 0,
    pairCount: 0,
    orderCount: 0,
    exactEndpointCount: 0,
    admissibleEndpointCount: 0,
    detachedPieceIds: [],
    interfacePieceIds: [],
    selectedPair: undefined,
    selectedOrder: undefined,
    bestExactPair: undefined,
    bestExactOrder: undefined,
    seedMetrics: input.seedMetrics,
    selectedMetrics: input.seedMetrics,
    bestExactMetrics: undefined,
    admissionGuardPassed: false,
    promotionEligible: false,
    outputInfluence: 'none',
    placedCollisionGeometries: input.input.seedPlaced,
    admissionGuardPlacedCollisionGeometries: input.input.seedPlaced,
    bestExactPlacedCollisionGeometries: input.input.seedPlaced
  }
}

function invalidTripleResult(input: {
  readonly status: 'invalid-seed' | 'no-lost-interface'
  readonly input: {
    readonly seedPlaced: ReadonlyArray<IrregularPlacedPiece>
  }
  readonly startedAt: number
  readonly maximumRuntimeMs: number
  readonly maximumCandidateEvaluations: number
  readonly seedMetrics: IntrinsicRelaxationMetrics | undefined
}): IntrinsicLostInterfaceRepairResult {
  return {
    status: input.status,
    runtimeMs: performance.now() - input.startedAt,
    maximumRuntimeMs: input.maximumRuntimeMs,
    maximumCandidateEvaluations: input.maximumCandidateEvaluations,
    candidateEvaluations: 0,
    triplePieceIds: [],
    lostContactPair: undefined,
    orderCount: 0,
    exactEndpointCount: 0,
    admissionGuardEndpointCount: 0,
    promotionEndpointCount: 0,
    admissionGuardPassed: false,
    promotionEligible: false,
    outputInfluence: 'none',
    seedMetrics: input.seedMetrics,
    diagnosticMetrics: undefined,
    bestExactMetrics: undefined,
    diagnosticOrder: undefined,
    bestExactOrder: undefined,
    placedCollisionGeometries: input.input.seedPlaced,
    diagnosticPlacedCollisionGeometries: input.input.seedPlaced,
    bestExactPlacedCollisionGeometries: input.input.seedPlaced
  }
}

function permutations(
  pieceIds: readonly [PieceId, PieceId, PieceId]
): ReadonlyArray<readonly [PieceId, PieceId, PieceId]> {
  const [first, second, third] = pieceIds
  return [
    [first, second, third],
    [first, third, second],
    [second, first, third],
    [second, third, first],
    [third, first, second],
    [third, second, first]
  ]
}

function otherPairEndpoint(
  pair: readonly [PieceId, PieceId],
  knownPieceId: PieceId
): PieceId {
  return pair[0] === knownPieceId ? pair[1] : pair[0]
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
