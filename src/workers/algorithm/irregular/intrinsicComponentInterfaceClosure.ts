import { performance } from 'node:perf_hooks'
import { SheetSpec } from '@shared/domain/nesting.js'
import type { PieceId } from '@shared/domain/ids.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularTransform
} from '@shared/irregular/domain.js'
import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutEnvelope,
  measureCanonicalLayoutTopology,
  placedCollisionWorldGridPath
} from '../../irregular/canonicalLayoutGeometry.js'
import { measureSharedConvexPolygonBoundaryContact } from '../../irregular/convexPolygonContact.js'
import { fromGrid } from '../../irregular/clipper2OffsetPolicy.js'
import { boundsForPoints } from '../../irregular/convexBounds.js'
import type { InternalPoint, InternalPolygonWithBounds } from '../../irregular/internalGeometry.js'

export interface IntrinsicComponentInterfaceMetrics {
  readonly canonicalGeometryIdentity: string
  readonly enclosedCavityCount: number
  readonly totalEnclosedCavityAreaMm2: number
  readonly largestOccupiedHullGapRatio: number
  readonly envelopeAreaMm2: number
  readonly envelopeMaximumSideMm: number
  readonly envelopeSpanMm: number
  readonly occupiedHullWasteRatio: number
  readonly positiveContactComponentCount: number
  readonly isolatedPieceCount: number
  readonly largestPositiveContactComponentSize: number
  readonly totalStructuralContacts: number
  readonly dominantStructuralContacts: number
}

export interface IntrinsicComponentInterfaceAttempt {
  readonly movingComponentPieceIds: ReadonlyArray<PieceId>
  readonly targetComponentPieceIds: ReadonlyArray<PieceId>
  readonly movingPieceId: PieceId
  readonly targetPieceId: PieceId
  readonly movingEdgeIndex: number
  readonly targetEdgeIndex: number
  readonly deltaXGrid: number
  readonly deltaYGrid: number
  readonly outcome:
    | 'canonical-illegal'
    | 'duplicate-layout'
    | 'lost-internal-contact'
    | 'missing-structural-interface'
    | 'envelope-regression'
    | 'exact-nonqualifying'
    | 'qualifying'
  readonly canonicalGeometryIdentity: string | undefined
  readonly newStructuralInterfaceSignatures: ReadonlyArray<string>
  readonly preservedInternalContactCount: number | undefined
  readonly metrics: IntrinsicComponentInterfaceMetrics | undefined
}

export interface IntrinsicComponentInterfaceEndpoint {
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly attempt: IntrinsicComponentInterfaceAttempt
}

export interface IntrinsicComponentInterfaceClosureResult {
  readonly status: 'completed' | 'deadline-exhausted' | 'materialization-cap-exhausted'
  readonly runtimeMs: number
  readonly maximumMaterializations: number
  readonly materializationCount: number
  readonly compatibleEdgePairCount: number
  readonly seedMetrics: IntrinsicComponentInterfaceMetrics
  readonly attempts: ReadonlyArray<IntrinsicComponentInterfaceAttempt>
  readonly exactEndpoints: ReadonlyArray<IntrinsicComponentInterfaceEndpoint>
  readonly qualifyingEndpoints: ReadonlyArray<IntrinsicComponentInterfaceEndpoint>
}

interface GridPoint {
  readonly x: number
  readonly y: number
}

interface GridEdge {
  readonly start: GridPoint
  readonly end: GridPoint
  readonly index: number
  readonly lengthSquaredGrid2: number
}

interface ComponentEdge {
  readonly componentPieceIds: ReadonlyArray<PieceId>
  readonly pieceId: PieceId
  readonly edge: GridEdge
}

const DEFAULT_MAXIMUM_MATERIALIZATIONS = 2_000
const DEFAULT_MAXIMUM_RUNTIME_MS = 30_000

/**
 * Tries exact rigid component-to-component edge closures without entering an
 * overlapping relaxed state. It is an experiment-only diagnostic, not a live
 * placement policy.
 */
export function runIntrinsicComponentInterfaceClosure(input: {
  readonly seedPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly maximumMaterializations?: number
  readonly maximumRuntimeMs?: number
}): IntrinsicComponentInterfaceClosureResult | undefined {
  const startedAt = performance.now()
  const maximumMaterializations = Math.max(
    1,
    Math.floor(input.maximumMaterializations ?? DEFAULT_MAXIMUM_MATERIALIZATIONS)
  )
  const maximumRuntimeMs = Math.max(1, input.maximumRuntimeMs ?? DEFAULT_MAXIMUM_RUNTIME_MS)
  const seed = anchorBottomLeft(input.seedPlaced)
  if (seed === undefined) return undefined
  const seedSheet = intrinsicBoundsSheet(seed)
  if (seedSheet === undefined || !assertCanonicalGridLegalLayout(seedSheet, seed)) return undefined
  const seedMetrics = measureMetrics(seed)
  const seedStructure = analyzeCanonicalLayoutStructure(seedSheet, seed)
  if (seedMetrics === undefined || seedStructure === undefined) return undefined

  const componentEdges = componentEdgesFor(seed, seedStructure.positiveContactComponents)
  if (componentEdges === undefined) return undefined
  const attempts: IntrinsicComponentInterfaceAttempt[] = []
  const exactEndpoints: IntrinsicComponentInterfaceEndpoint[] = []
  const qualifyingEndpoints: IntrinsicComponentInterfaceEndpoint[] = []
  const seenIdentities = new Set<string>([seedMetrics.canonicalGeometryIdentity])
  let compatibleEdgePairCount = 0
  let materializationCount = 0
  let status: IntrinsicComponentInterfaceClosureResult['status'] = 'completed'

  outer: for (const moving of componentEdges) {
    for (const target of componentEdges) {
      if (samePieceSet(moving.componentPieceIds, target.componentPieceIds)) continue
      if (!areAntiparallel(moving.edge, target.edge)) continue
      const deltaXGrid = target.edge.end.x - moving.edge.start.x
      const deltaYGrid = target.edge.end.y - moving.edge.start.y
      if (deltaXGrid === 0 && deltaYGrid === 0) continue
      compatibleEdgePairCount += 1
      if (performance.now() - startedAt >= maximumRuntimeMs) {
        status = 'deadline-exhausted'
        break outer
      }
      if (materializationCount >= maximumMaterializations) {
        status = 'materialization-cap-exhausted'
        break outer
      }
      materializationCount += 1
      const moved = translateComponent(seed, new Set(moving.componentPieceIds), deltaXGrid, deltaYGrid)
      const candidate = moved === undefined ? undefined : anchorBottomLeft(moved)
      const base = attemptBase(moving, target, deltaXGrid, deltaYGrid)
      const candidateSheet = candidate === undefined ? undefined : intrinsicBoundsSheet(candidate)
      if (
        candidate === undefined ||
        candidateSheet === undefined ||
        !assertCanonicalGridLegalLayout(candidateSheet, candidate)
      ) {
        attempts.push({
          ...base,
          outcome: 'canonical-illegal',
          canonicalGeometryIdentity: undefined,
          newStructuralInterfaceSignatures: [],
          preservedInternalContactCount: undefined,
          metrics: undefined
        })
        continue
      }
      const metrics = measureMetrics(candidate)
      const identity = metrics?.canonicalGeometryIdentity
      if (metrics === undefined || identity === undefined) return undefined
      if (seenIdentities.has(identity)) {
        attempts.push({
          ...base,
          outcome: 'duplicate-layout',
          canonicalGeometryIdentity: identity,
          newStructuralInterfaceSignatures: [],
          preservedInternalContactCount: undefined,
          metrics
        })
        continue
      }
      seenIdentities.add(identity)
      const structure = analyzeCanonicalLayoutStructure(candidateSheet, candidate)
      const internalPairs = seedStructure.positiveContactPairs.filter(([first, second]) =>
        moving.componentPieceIds.includes(first) && moving.componentPieceIds.includes(second)
      )
      const candidatePairs = pairKeySet(structure?.positiveContactPairs ?? [])
      const preservedInternalContactCount = internalPairs.filter(([first, second]) =>
        candidatePairs.has(pairKey(first, second))
      ).length
      const targetContact = sharedBoundaryContact(candidate, moving.pieceId, target.pieceId)
      const signatures = targetContact?.nearCompleteStructuralContactSignatures ?? []
      const common = {
        ...base,
        canonicalGeometryIdentity: identity,
        newStructuralInterfaceSignatures: signatures,
        preservedInternalContactCount,
        metrics
      }
      if (preservedInternalContactCount !== internalPairs.length) {
        attempts.push({ ...common, outcome: 'lost-internal-contact' })
        continue
      }
      if (signatures.length === 0) {
        attempts.push({ ...common, outcome: 'missing-structural-interface' })
        continue
      }
      if (!nonIncreasingEnvelope(metrics, seedMetrics)) {
        attempts.push({ ...common, outcome: 'envelope-regression' })
        continue
      }
      const qualifies =
        metrics.totalStructuralContacts >= 6 &&
        metrics.dominantStructuralContacts >= 3 &&
        (metrics.positiveContactComponentCount <= 14 ||
          metrics.largestPositiveContactComponentSize >= 4) &&
        (!moving.componentPieceIds.some((pieceId) =>
          isIsolatedPiece(pieceId, seedStructure.positiveContactPairs)
        ) || metrics.isolatedPieceCount <= 10) &&
        metrics.enclosedCavityCount === 0 &&
        metrics.envelopeAreaMm2 <= seedMetrics.envelopeAreaMm2 &&
        metrics.envelopeMaximumSideMm <= seedMetrics.envelopeMaximumSideMm &&
        metrics.envelopeSpanMm <= seedMetrics.envelopeSpanMm &&
        metrics.largestOccupiedHullGapRatio <= seedMetrics.largestOccupiedHullGapRatio
      const attempt: IntrinsicComponentInterfaceAttempt = {
        ...common,
        outcome: qualifies ? 'qualifying' : 'exact-nonqualifying'
      }
      attempts.push(attempt)
      const endpoint = { placedCollisionGeometries: candidate, attempt }
      exactEndpoints.push(endpoint)
      if (qualifies) qualifyingEndpoints.push(endpoint)
    }
  }

  const rank = (first: IntrinsicComponentInterfaceEndpoint, second: IntrinsicComponentInterfaceEndpoint) => {
    const firstMetrics = first.attempt.metrics
    const secondMetrics = second.attempt.metrics
    if (firstMetrics === undefined || secondMetrics === undefined) return 0
    return (
      firstMetrics.positiveContactComponentCount - secondMetrics.positiveContactComponentCount ||
      second.attempt.newStructuralInterfaceSignatures.length -
        first.attempt.newStructuralInterfaceSignatures.length ||
      (second.attempt.preservedInternalContactCount ?? 0) -
        (first.attempt.preservedInternalContactCount ?? 0) ||
      firstMetrics.envelopeAreaMm2 - secondMetrics.envelopeAreaMm2 ||
      firstMetrics.envelopeMaximumSideMm - secondMetrics.envelopeMaximumSideMm ||
      firstMetrics.canonicalGeometryIdentity.localeCompare(secondMetrics.canonicalGeometryIdentity)
    )
  }
  return {
    status,
    runtimeMs: performance.now() - startedAt,
    maximumMaterializations,
    materializationCount,
    compatibleEdgePairCount,
    seedMetrics,
    attempts,
    exactEndpoints: exactEndpoints.toSorted(rank),
    qualifyingEndpoints: qualifyingEndpoints.toSorted(rank)
  }
}

function attemptBase(
  moving: ComponentEdge,
  target: ComponentEdge,
  deltaXGrid: number,
  deltaYGrid: number
) {
  return {
    movingComponentPieceIds: moving.componentPieceIds,
    targetComponentPieceIds: target.componentPieceIds,
    movingPieceId: moving.pieceId,
    targetPieceId: target.pieceId,
    movingEdgeIndex: moving.edge.index,
    targetEdgeIndex: target.edge.index,
    deltaXGrid,
    deltaYGrid
  }
}

function componentEdgesFor(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  components: ReadonlyArray<ReadonlyArray<PieceId>>
): ReadonlyArray<ComponentEdge> | undefined {
  const result: ComponentEdge[] = []
  for (const componentPieceIds of components) {
    for (const pieceId of componentPieceIds) {
      const entry = placed.find((candidate) => placedPieceId(candidate) === pieceId)
      const path = entry === undefined ? undefined : placedCollisionWorldGridPath(entry)
      if (path === undefined) return undefined
      const edges = longEdges(path)
      for (const edge of edges) result.push({ componentPieceIds, pieceId, edge })
    }
  }
  return result.toSorted((first, second) =>
    componentKey(first.componentPieceIds).localeCompare(componentKey(second.componentPieceIds)) ||
    first.pieceId.localeCompare(second.pieceId) ||
    first.edge.index - second.edge.index
  )
}

function longEdges(path: ReadonlyArray<GridPoint>): ReadonlyArray<GridEdge> {
  const edges = path.map((start, index) => {
    const end = path[(index + 1) % path.length]
    if (end === undefined) return undefined
    const deltaX = end.x - start.x
    const deltaY = end.y - start.y
    return {
      start,
      end,
      index,
      lengthSquaredGrid2: deltaX * deltaX + deltaY * deltaY
    }
  })
  if (edges.some((edge) => edge === undefined)) return []
  const valid = edges.filter((edge): edge is GridEdge => edge !== undefined)
  const longest = Math.max(0, ...valid.map(({ lengthSquaredGrid2 }) => lengthSquaredGrid2))
  return valid.filter(({ lengthSquaredGrid2 }) => lengthSquaredGrid2 > 0 && lengthSquaredGrid2 * 4 >= longest)
}

function areAntiparallel(first: GridEdge, second: GridEdge): boolean {
  const firstX = first.end.x - first.start.x
  const firstY = first.end.y - first.start.y
  const secondX = second.end.x - second.start.x
  const secondY = second.end.y - second.start.y
  return firstX * secondY - firstY * secondX === 0 && firstX * secondX + firstY * secondY < 0
}

function translateComponent(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  movingPieceIds: ReadonlySet<PieceId>,
  deltaXGrid: number,
  deltaYGrid: number
): ReadonlyArray<IrregularPlacedPiece> | undefined {
  const deltaX = fromGrid(deltaXGrid)
  const deltaY = fromGrid(deltaYGrid)
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return undefined
  return placed.map((entry) =>
    !movingPieceIds.has(placedPieceId(entry))
      ? entry
      : new IrregularPlacedPiece({
          placement: new IrregularPlacement({
            ...entry.placement,
            transform: new IrregularTransform({
              ...entry.placement.transform,
              translateX: entry.placement.transform.translateX + deltaX,
              translateY: entry.placement.transform.translateY + deltaY
            })
          }),
          collisionGeometry: entry.collisionGeometry
        })
  )
}

function anchorBottomLeft(
  placed: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<IrregularPlacedPiece> | undefined {
  const paths = placed.map(placedCollisionWorldGridPath)
  if (paths.some((path) => path === undefined)) return undefined
  const points = paths.flatMap((path) => path ?? [])
  if (points.length === 0) return undefined
  const minimumX = Math.min(...points.map(({ x }) => x))
  const minimumY = Math.min(...points.map(({ y }) => y))
  const deltaX = fromGrid(-minimumX)
  const deltaY = fromGrid(-minimumY)
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return undefined
  return placed.map(
    (entry) =>
      new IrregularPlacedPiece({
        placement: new IrregularPlacement({
          ...entry.placement,
          transform: new IrregularTransform({
            ...entry.placement.transform,
            translateX: entry.placement.transform.translateX + deltaX,
            translateY: entry.placement.transform.translateY + deltaY
          })
        }),
        collisionGeometry: entry.collisionGeometry
      })
  )
}

function intrinsicBoundsSheet(
  placed: ReadonlyArray<IrregularPlacedPiece>
): SheetSpec | undefined {
  const paths = placed.map(placedCollisionWorldGridPath)
  if (paths.some((path) => path === undefined)) return undefined
  const points = paths.flatMap((path) => path ?? [])
  if (points.length === 0) return undefined
  const maximumX = Math.max(...points.map(({ x }) => x))
  const maximumY = Math.max(...points.map(({ y }) => y))
  const width = Math.ceil(fromGrid(maximumX))
  const height = Math.ceil(fromGrid(maximumY))
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? new SheetSpec({ width, height, label: 'intrinsic-component-interface' })
    : undefined
}

function measureMetrics(
  placed: ReadonlyArray<IrregularPlacedPiece>
): IntrinsicComponentInterfaceMetrics | undefined {
  const canonicalGeometryIdentity = canonicalCollisionLayoutIdentity(placed)
  const cavities = measureCanonicalEnclosedCavities(placed)
  const topology = measureCanonicalLayoutTopology(placed)
  const envelope = measureCanonicalLayoutEnvelope(placed)
  const contacts = measureCanonicalLayoutContacts(placed)
  if (
    canonicalGeometryIdentity === undefined ||
    cavities === undefined ||
    topology === undefined ||
    envelope === undefined ||
    contacts === undefined
  ) {
    return undefined
  }
  return {
    canonicalGeometryIdentity,
    enclosedCavityCount: cavities.count,
    totalEnclosedCavityAreaMm2: cavities.totalAreaMm2,
    largestOccupiedHullGapRatio: topology.largestOccupiedHullGapRatio,
    envelopeAreaMm2: envelope.areaMm2,
    envelopeMaximumSideMm: envelope.maximumSideMm,
    envelopeSpanMm: envelope.spanMm,
    occupiedHullWasteRatio: envelope.occupiedHullWasteRatio,
    positiveContactComponentCount: topology.positiveContactComponentCount,
    isolatedPieceCount: topology.isolatedPieceCount,
    largestPositiveContactComponentSize: topology.largestPositiveContactComponentSize,
    totalStructuralContacts: contacts.totalStructuralContacts,
    dominantStructuralContacts: contacts.dominantStructuralContacts
  }
}

function sharedBoundaryContact(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  firstPieceId: PieceId,
  secondPieceId: PieceId
) {
  const first = placed.find((entry) => placedPieceId(entry) === firstPieceId)
  const second = placed.find((entry) => placedPieceId(entry) === secondPieceId)
  const firstPolygon = first === undefined ? undefined : contactPolygon(first)
  const secondPolygon = second === undefined ? undefined : contactPolygon(second)
  return firstPolygon === undefined || secondPolygon === undefined
    ? undefined
    : measureSharedConvexPolygonBoundaryContact(firstPolygon, secondPolygon)
}

function contactPolygon(entry: IrregularPlacedPiece): InternalPolygonWithBounds | undefined {
  const path = placedCollisionWorldGridPath(entry)
  if (path === undefined) return undefined
  const points: InternalPoint[] = path.map(({ x, y }) => ({ x: fromGrid(x), y: fromGrid(y) }))
  const bounds = boundsForPoints(points)
  return bounds === undefined ? undefined : { polygon: { points }, bounds }
}

function pairKeySet(pairs: ReadonlyArray<readonly [PieceId, PieceId]>): ReadonlySet<string> {
  return new Set(pairs.map(([first, second]) => pairKey(first, second)))
}

function pairKey(first: PieceId, second: PieceId): string {
  return first < second ? `${first}|${second}` : `${second}|${first}`
}

function isIsolatedPiece(pieceId: PieceId, pairs: ReadonlyArray<readonly [PieceId, PieceId]>): boolean {
  return !pairs.some(([first, second]) => first === pieceId || second === pieceId)
}

function nonIncreasingEnvelope(
  candidate: IntrinsicComponentInterfaceMetrics,
  seed: IntrinsicComponentInterfaceMetrics
): boolean {
  return (
    candidate.envelopeAreaMm2 <= seed.envelopeAreaMm2 &&
    candidate.envelopeMaximumSideMm <= seed.envelopeMaximumSideMm &&
    candidate.envelopeSpanMm <= seed.envelopeSpanMm
  )
}

function samePieceSet(first: ReadonlyArray<PieceId>, second: ReadonlyArray<PieceId>): boolean {
  return componentKey(first) === componentKey(second)
}

function componentKey(pieceIds: ReadonlyArray<PieceId>): string {
  return [...pieceIds].toSorted().join('|')
}

function placedPieceId(entry: IrregularPlacedPiece): PieceId {
  return entry.placement.pieceId ?? entry.placement.sourcePieceId
}
