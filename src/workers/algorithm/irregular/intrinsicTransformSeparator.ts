import { createHash } from 'node:crypto'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularTransform
} from '@shared/irregular/domain.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import {
  analyzeCanonicalLayoutStructure,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutTopology,
  placedCollisionWorldGridPath
} from '../../irregular/canonicalLayoutGeometry.js'
import type {
  IntrinsicFiniteTransform,
  IntrinsicTargetBox,
  IntrinsicTransformCatalog,
  IntrinsicTransformCatalogEntry
} from './intrinsicExactProjection.js'
import { assertIntrinsicTargetExactLegal } from './intrinsicExactProjection.js'

export interface IntrinsicRelaxedPose {
  readonly pieceId: PieceId
  readonly transformKey: string
  readonly translationBasisXmm: number
  readonly translationBasisYmm: number
  readonly translateXGrid: number
  readonly translateYGrid: number
}

export interface IntrinsicRelaxedState {
  readonly poses: ReadonlyArray<IntrinsicRelaxedPose>
}

export interface IntrinsicSeparationConflict {
  readonly key: string
  readonly kind: 'pair' | 'wall'
  readonly firstPieceId: PieceId
  readonly secondPieceId: PieceId | undefined
  readonly rawDepth: number
  readonly normalizedDepth: number
  readonly moveXGrid: number
  readonly moveYGrid: number
}

export interface IntrinsicSeparationEvaluation {
  readonly rawLoss: number
  readonly weightedLoss: number
  readonly conflicts: ReadonlyArray<IntrinsicSeparationConflict>
  readonly exactZeroLoss: boolean
}

export interface IntrinsicSeparatorProposal {
  readonly kind:
    | 'separate'
    | 'transform'
    | 'swap'
    | 'group-transport'
    | 'split-squeeze'
    | 'interface-disrupt'
  readonly state: IntrinsicRelaxedState
  readonly affectedPieceIds: ReadonlyArray<PieceId>
  readonly key: string
}

export interface IntrinsicSeparatorWeights {
  readonly byConflictKey: ReadonlyMap<string, number>
}

/** Per-run cache for immutable transform/basis phase signatures. */
export interface IntrinsicPhaseSignatureMemo {
  readonly byCatalogEntryAndBasis: Map<string, string | undefined>
  requestCount: number
  cacheHitCount: number
  cacheMissCount: number
}

export interface IntrinsicPhaseSignatureCacheStats {
  readonly requestCount: number
  readonly cacheHitCount: number
  readonly cacheMissCount: number
}

interface GridPoint {
  readonly x: number
  readonly y: number
}

interface GridPolygon {
  readonly points: ReadonlyArray<GridPoint>
  readonly center: GridPoint
  readonly characteristicLength: number
  readonly maximumSide: number
  readonly areaGrid2: number
}

interface ResolvedPose {
  readonly pose: IntrinsicRelaxedPose
  readonly catalogEntry: IntrinsicTransformCatalogEntry
  readonly finiteTransform: IntrinsicFiniteTransform
  readonly polygon: GridPolygon
}

interface SatPenetration {
  readonly depth: number
  readonly moveX: number
  readonly moveY: number
}

const HALTON_PRIMES = [2, 3] as const

/** Converts an exact layout into the private finite-transform state. */
export function relaxedStateFromExactLayout(
  catalog: IntrinsicTransformCatalog,
  placed: ReadonlyArray<IrregularPlacedPiece>
): IntrinsicRelaxedState | undefined {
  const placedById = new Map(
    placed.map((entry) => [placedPieceId(entry), entry] as const)
  )
  if (placedById.size !== catalog.entries.length || placed.length !== catalog.entries.length) {
    return undefined
  }
  const poses: IntrinsicRelaxedPose[] = []
  for (const entry of catalog.entries) {
    const exact = placedById.get(entry.pieceId)
    if (exact === undefined) return undefined
    const finiteTransform = entry.transforms.find(
      ({ canonicalTransformKey }) =>
        canonicalTransformKey === transformKey(exact.collisionGeometry.transform)
    )
    const translationBasisXmm = exact.placement.transform.translateX
    const translationBasisYmm = exact.placement.transform.translateY
    if (
      finiteTransform === undefined ||
      !Number.isFinite(translationBasisXmm) ||
      !Number.isFinite(translationBasisYmm)
    ) {
      return undefined
    }
    poses.push({
      pieceId: entry.pieceId,
      transformKey: finiteTransform.canonicalTransformKey,
      translationBasisXmm,
      translationBasisYmm,
      translateXGrid: 0,
      translateYGrid: 0
    })
  }
  return canonicalizeRelaxedState(catalog, { poses })
}

/** Builds exact-domain placements only for projection; relaxed states are never worker results. */
export function provisionalLayoutFromRelaxedState(
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState
): ReadonlyArray<IrregularPlacedPiece> | undefined {
  const resolved = resolveState(catalog, state)
  if (resolved === undefined) return undefined
  const placed = resolved.map(({ pose, catalogEntry, finiteTransform, polygon }) => {
    const materialized = makePlaced(catalogEntry, finiteTransform, pose)
    const path = materialized === undefined
      ? undefined
      : placedCollisionWorldGridPath(materialized)
    return path !== undefined && pointSequenceKey(path) === pointSequenceKey(polygon.points)
      ? materialized
      : undefined
  })
  return placed.some((entry) => entry === undefined)
    ? undefined
    : placed.filter((entry): entry is IrregularPlacedPiece => entry !== undefined)
}

/** Complete-state identity, translation-invariant on the canonical collision grid. */
export function intrinsicRelaxedStateKey(
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState,
  phaseSignatureMemo?: IntrinsicPhaseSignatureMemo
): string | undefined {
  const canonical = canonicalizeRelaxedState(catalog, state)
  if (canonical === undefined) return undefined
  const keyed = canonical.poses.map((pose) => {
    const phaseSignature = translationPhaseSignature(catalog, pose, phaseSignatureMemo)
    const finiteTransform = catalog.entries
      .find(({ pieceId }) => pieceId === pose.pieceId)
      ?.transforms.find(
        ({ canonicalTransformKey }) => canonicalTransformKey === pose.transformKey
      )
    const polygon = finiteTransform === undefined
      ? undefined
      : gridPolygon(finiteTransform, pose)
    return phaseSignature === undefined || polygon === undefined
      ? undefined
      : [
          pose.pieceId,
          pose.transformKey,
          phaseSignature,
          pointSequenceKey(polygon.points)
        ]
  })
  if (keyed.some((entry) => entry === undefined)) return undefined
  return `sha256:${createHash('sha256').update(JSON.stringify(keyed)).digest('hex')}`
}

export function createIntrinsicPhaseSignatureMemo(): IntrinsicPhaseSignatureMemo {
  return {
    byCatalogEntryAndBasis: new Map(),
    requestCount: 0,
    cacheHitCount: 0,
    cacheMissCount: 0
  }
}

export function intrinsicPhaseSignatureCacheStats(
  memo: IntrinsicPhaseSignatureMemo
): IntrinsicPhaseSignatureCacheStats {
  return {
    requestCount: memo.requestCount,
    cacheHitCount: memo.cacheHitCount,
    cacheMissCount: memo.cacheMissCount
  }
}

/** Deterministic complete-state deduplication seam for the bounded infeasible pool. */
export function dedupeIntrinsicRelaxedStates(
  catalog: IntrinsicTransformCatalog,
  states: ReadonlyArray<IntrinsicRelaxedState>,
  capacity: number
): ReadonlyArray<IntrinsicRelaxedState> {
  const unique = new Map<string, IntrinsicRelaxedState>()
  for (const state of states) {
    const canonical = canonicalizeRelaxedState(catalog, state)
    const key = canonical === undefined ? undefined : intrinsicRelaxedStateKey(catalog, canonical)
    if (canonical !== undefined && key !== undefined && !unique.has(key)) {
      unique.set(key, canonical)
    }
  }
  return [...unique.entries()]
    .toSorted(([first], [second]) => first.localeCompare(second))
    .slice(0, Math.max(0, capacity))
    .map(([, state]) => state)
}

/** Deterministic normalized SAT and target-wall loss with GLS conflict weights. */
export function evaluateIntrinsicSeparation(
  targetBox: IntrinsicTargetBox,
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState,
  weights: IntrinsicSeparatorWeights = { byConflictKey: new Map() }
): IntrinsicSeparationEvaluation | undefined {
  const targetWidthGrid = toGridMm(targetBox.widthMm)
  const targetHeightGrid = toGridMm(targetBox.heightMm)
  const resolved = resolveState(catalog, state)
  if (
    targetWidthGrid === undefined ||
    targetHeightGrid === undefined ||
    targetWidthGrid <= 0 ||
    targetHeightGrid <= 0 ||
    resolved === undefined
  ) {
    return undefined
  }
  const conflicts: IntrinsicSeparationConflict[] = []
  for (const entry of resolved) {
    const wallConflicts = wallPenetrations(entry, targetWidthGrid, targetHeightGrid)
    conflicts.push(...wallConflicts)
  }
  for (let firstIndex = 0; firstIndex < resolved.length; firstIndex += 1) {
    const first = resolved[firstIndex]
    if (first === undefined) return undefined
    for (let secondIndex = 0; secondIndex < firstIndex; secondIndex += 1) {
      const second = resolved[secondIndex]
      if (second === undefined) return undefined
      const penetration = satPenetration(first.polygon, second.polygon)
      if (penetration === undefined || penetration.depth <= 0) continue
      const firstId = first.pose.pieceId < second.pose.pieceId ? first.pose.pieceId : second.pose.pieceId
      const secondId = first.pose.pieceId < second.pose.pieceId ? second.pose.pieceId : first.pose.pieceId
      const normalizer = Math.max(
        1,
        Math.min(first.polygon.characteristicLength, second.polygon.characteristicLength)
      )
      const normalizedDepth = penetration.depth / normalizer
      conflicts.push({
        key: `pair:${firstId}:${secondId}`,
        kind: 'pair',
        firstPieceId: first.pose.pieceId,
        secondPieceId: second.pose.pieceId,
        rawDepth: penetration.depth,
        normalizedDepth,
        moveXGrid: penetration.moveX,
        moveYGrid: penetration.moveY
      })
    }
  }
  const sorted = conflicts.toSorted(compareConflicts)
  let rawLoss = 0
  let weightedLoss = 0
  for (const conflict of sorted) {
    const squared = conflict.normalizedDepth * conflict.normalizedDepth
    rawLoss += squared
    weightedLoss += squared * (weights.byConflictKey.get(conflict.key) ?? 1)
  }
  if (!Number.isFinite(rawLoss) || !Number.isFinite(weightedLoss)) return undefined
  return { rawLoss, weightedLoss, conflicts: sorted, exactZeroLoss: sorted.length === 0 }
}

/** Raises only the currently maximal normalized GLS conflict class. */
export function updateIntrinsicSeparatorWeights(
  weights: IntrinsicSeparatorWeights,
  evaluation: IntrinsicSeparationEvaluation
): IntrinsicSeparatorWeights {
  const next = new Map(weights.byConflictKey)
  const maximumUtility = evaluation.conflicts.reduce((maximum, conflict) => {
    const weight = next.get(conflict.key) ?? 1
    return Math.max(maximum, conflict.normalizedDepth / weight)
  }, 0)
  for (const conflict of evaluation.conflicts) {
    const weight = next.get(conflict.key) ?? 1
    if (conflict.normalizedDepth / weight === maximumUtility) {
      next.set(conflict.key, weight + 1)
    }
  }
  return { byConflictKey: next }
}

/** Projection order from weighted conflict contribution, canonical center, then piece id. */
export function intrinsicProjectionPriority(
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState,
  evaluation: IntrinsicSeparationEvaluation,
  weights: IntrinsicSeparatorWeights
): ReadonlyArray<PieceId> | undefined {
  const resolved = resolveState(catalog, state)
  if (resolved === undefined) return undefined
  const contribution = new Map<PieceId, number>()
  for (const conflict of evaluation.conflicts) {
    const value =
      conflict.normalizedDepth * conflict.normalizedDepth *
      (weights.byConflictKey.get(conflict.key) ?? 1)
    contribution.set(
      conflict.firstPieceId,
      (contribution.get(conflict.firstPieceId) ?? 0) + value
    )
    if (conflict.secondPieceId !== undefined) {
      contribution.set(
        conflict.secondPieceId,
        (contribution.get(conflict.secondPieceId) ?? 0) + value
      )
    }
  }
  return resolved
    .toSorted(
      (first, second) =>
        (contribution.get(second.pose.pieceId) ?? 0) -
          (contribution.get(first.pose.pieceId) ?? 0) ||
        first.polygon.center.x - second.polygon.center.x ||
        first.polygon.center.y - second.polygon.center.y ||
        first.pose.pieceId.localeCompare(second.pose.pieceId)
    )
    .map(({ pose }) => pose.pieceId)
}

/** Applies one rigid q90 turn to the complete world layout using equivalent catalog geometry. */
export function remapIntrinsicTransformsQuarterTurn(
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState
): IntrinsicRelaxedState | undefined {
  const resolved = resolveState(catalog, state)
  if (resolved === undefined) return undefined
  const rotatedById = new Map<PieceId, ReadonlyArray<GridPoint>>()
  let globalMinimumX = Number.POSITIVE_INFINITY
  let globalMinimumY = Number.POSITIVE_INFINITY
  for (const entry of resolved) {
    const rotated = entry.polygon.points.map(({ x, y }) => ({ x: -y, y: x }))
    rotatedById.set(entry.pose.pieceId, rotated)
    for (const point of rotated) {
      globalMinimumX = Math.min(globalMinimumX, point.x)
      globalMinimumY = Math.min(globalMinimumY, point.y)
    }
  }
  if (!Number.isSafeInteger(globalMinimumX) || !Number.isSafeInteger(globalMinimumY)) {
    return undefined
  }
  const replacements: IntrinsicRelaxedPose[] = []
  for (const entry of catalog.entries) {
    const priorPose = state.poses.find(({ pieceId }) => pieceId === entry.pieceId)
    const rotated = rotatedById.get(entry.pieceId)?.map(({ x, y }) => ({
      x: x - globalMinimumX,
      y: y - globalMinimumY
    }))
    if (rotated === undefined || priorPose === undefined) return undefined
    const desiredLocalKey = translationNormalizedPointSetKey(rotated)
    if (desiredLocalKey === undefined) return undefined
    const alternate = entry.transforms.find((finiteTransform) => {
      const points = finiteTransformPhasePoints(
        finiteTransform,
        priorPose.translationBasisXmm,
        priorPose.translationBasisYmm
      )
      return points !== undefined && translationNormalizedPointSetKey(points) === desiredLocalKey
    })
    const alternatePoints =
      alternate === undefined
        ? undefined
        : finiteTransformPhasePoints(
            alternate,
            priorPose.translationBasisXmm,
            priorPose.translationBasisYmm
          )
    const rotatedBounds = polygonBounds(rotated)
    const alternateBounds = alternatePoints === undefined ? undefined : polygonBounds(alternatePoints)
    if (alternate === undefined || rotatedBounds === undefined || alternateBounds === undefined) {
      return undefined
    }
    const translateXGrid = rotatedBounds.minimumX - alternateBounds.minimumX
    const translateYGrid = rotatedBounds.minimumY - alternateBounds.minimumY
    if (!Number.isSafeInteger(translateXGrid) || !Number.isSafeInteger(translateYGrid)) {
      return undefined
    }
    replacements.push({
      pieceId: entry.pieceId,
      transformKey: alternate.canonicalTransformKey,
      translationBasisXmm: priorPose.translationBasisXmm,
      translationBasisYmm: priorPose.translationBasisYmm,
      translateXGrid,
      translateYGrid
    })
  }
  const remapped = canonicalizeRelaxedState(catalog, { poses: replacements })
  const remappedResolved = remapped === undefined ? undefined : resolveState(catalog, remapped)
  if (remappedResolved === undefined) return undefined
  for (const entry of remappedResolved) {
    const expected = rotatedById.get(entry.pose.pieceId)?.map(({ x, y }) => ({
      x: x - globalMinimumX,
      y: y - globalMinimumY
    }))
    if (expected === undefined || pointSetKey(entry.polygon.points) !== pointSetKey(expected)) {
      return undefined
    }
  }
  return remapped
}

/** Finite deterministic separation and transform proposals for the registered conflict leader. */
export function intrinsicFocusedProposals(input: {
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly weights: IntrinsicSeparatorWeights
}): ReadonlyArray<IntrinsicSeparatorProposal> {
  if (input.evaluation.conflicts.length === 0) return []
  const priority = intrinsicProjectionPriority(
    input.catalog,
    input.state,
    input.evaluation,
    input.weights
  )
  const selectedPieceId = priority?.[0]
  if (selectedPieceId === undefined) return []
  return intrinsicFocusedProposalsForPiece({ ...input, selectedPieceId })
}

/** Existing focused proposal vocabulary applied to one explicit collider. */
export function intrinsicFocusedProposalsForPiece(input: {
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly weights: IntrinsicSeparatorWeights
  readonly selectedPieceId: PieceId
}): ReadonlyArray<IntrinsicSeparatorProposal> {
  const { selectedPieceId } = input
  if (
    !input.evaluation.conflicts.some(
      ({ firstPieceId, secondPieceId }) =>
        firstPieceId === selectedPieceId || secondPieceId === selectedPieceId
    )
  ) {
    return []
  }
  const selectedPose = input.state.poses.find(({ pieceId }) => pieceId === selectedPieceId)
  const selectedEntry = input.catalog.entries.find(({ pieceId }) => pieceId === selectedPieceId)
  if (selectedPose === undefined || selectedEntry === undefined) return []
  const proposals: IntrinsicSeparatorProposal[] = []
  const translations = input.evaluation.conflicts
    .filter(
      ({ firstPieceId, secondPieceId }) =>
        firstPieceId === selectedPieceId || secondPieceId === selectedPieceId
    )
    .toSorted((first, second) => {
      const firstContribution =
        first.normalizedDepth * first.normalizedDepth *
        (input.weights.byConflictKey.get(first.key) ?? 1)
      const secondContribution =
        second.normalizedDepth * second.normalizedDepth *
        (input.weights.byConflictKey.get(second.key) ?? 1)
      return secondContribution - firstContribution || first.key.localeCompare(second.key)
    })
    .flatMap((conflict) => {
      const sign = conflict.firstPieceId === selectedPieceId ? 1 : -1
      const separation = {
        x: Math.round(conflict.moveXGrid * sign),
        y: Math.round(conflict.moveYGrid * sign)
      }
      return [
        separation,
        { x: separation.x * 2, y: separation.y * 2 }
      ]
    })
  for (const [index, delta] of translations.entries()) {
    if (delta.x === 0 && delta.y === 0) continue
    const next = replacePose(input.state, selectedPieceId, {
      ...selectedPose,
      translateXGrid: selectedPose.translateXGrid + delta.x,
      translateYGrid: selectedPose.translateYGrid + delta.y
    })
    const canonical = canonicalizeRelaxedState(input.catalog, next)
    if (canonical === undefined) continue
    proposals.push({
      kind: 'separate',
      state: canonical,
      affectedPieceIds: [selectedPieceId],
      key: `separate:${selectedPieceId}:${index}:${delta.x}:${delta.y}`
    })
  }
  const currentCenter = poseWorldCenter(input.catalog, selectedPose)
  if (currentCenter !== undefined) {
    for (const finiteTransform of selectedEntry.transforms) {
      if (finiteTransform.canonicalTransformKey === selectedPose.transformKey) continue
      const localCenter = finiteTransformPhaseCenter(finiteTransform, selectedPose)
      if (localCenter === undefined) continue
      const transformedPose: IntrinsicRelaxedPose = {
        ...selectedPose,
        transformKey: finiteTransform.canonicalTransformKey,
        translateXGrid: Math.round(currentCenter.x - localCenter.x),
        translateYGrid: Math.round(currentCenter.y - localCenter.y)
      }
      const canonical = canonicalizeRelaxedState(
        input.catalog,
        replacePose(input.state, selectedPieceId, transformedPose)
      )
      if (canonical === undefined) continue
      proposals.push({
        kind: 'transform',
        state: canonical,
        affectedPieceIds: [selectedPieceId],
        key: `transform:${selectedPieceId}:${finiteTransform.canonicalTransformKey}`
      })
    }
  }
  return dedupeProposals(input.catalog, proposals)
}

/** Swaps two world centers while preserving each selected finite transform. */
export function swapIntrinsicWorldCenters(
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState,
  firstPieceId: PieceId,
  secondPieceId: PieceId
): IntrinsicRelaxedState | undefined {
  if (firstPieceId === secondPieceId) return undefined
  const first = state.poses.find(({ pieceId }) => pieceId === firstPieceId)
  const second = state.poses.find(({ pieceId }) => pieceId === secondPieceId)
  if (first === undefined || second === undefined) return undefined
  const firstCenter = poseWorldCenter(catalog, first)
  const secondCenter = poseWorldCenter(catalog, second)
  const firstLocalCenter = poseLocalCenter(catalog, first)
  const secondLocalCenter = poseLocalCenter(catalog, second)
  if (
    firstCenter === undefined ||
    secondCenter === undefined ||
    firstLocalCenter === undefined ||
    secondLocalCenter === undefined
  ) {
    return undefined
  }
  const replacements = new Map<PieceId, IntrinsicRelaxedPose>([
    [
      firstPieceId,
      {
        ...first,
        translateXGrid: Math.round(secondCenter.x - firstLocalCenter.x),
        translateYGrid: Math.round(secondCenter.y - firstLocalCenter.y)
      }
    ],
    [
      secondPieceId,
      {
        ...second,
        translateXGrid: Math.round(firstCenter.x - secondLocalCenter.x),
        translateYGrid: Math.round(firstCenter.y - secondLocalCenter.y)
      }
    ]
  ])
  return canonicalizeRelaxedState(catalog, {
    poses: state.poses.map((pose) => replacements.get(pose.pieceId) ?? pose)
  })
}

/** Transports a bounded group by one world-center delta. */
export function transportIntrinsicGroup(
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState,
  pieceIds: ReadonlyArray<PieceId>,
  delta: GridPoint
): IntrinsicRelaxedState | undefined {
  const selected = new Set(pieceIds)
  if (selected.size === 0 || !Number.isSafeInteger(delta.x) || !Number.isSafeInteger(delta.y)) {
    return undefined
  }
  if (pieceIds.some((pieceId) => !state.poses.some((pose) => pose.pieceId === pieceId))) {
    return undefined
  }
  return canonicalizeRelaxedState(catalog, {
    poses: state.poses.map((pose) =>
      selected.has(pose.pieceId)
        ? {
            ...pose,
            translateXGrid: pose.translateXGrid + delta.x,
            translateYGrid: pose.translateYGrid + delta.y
          }
        : pose
    )
  })
}

/** Deterministic topology-changing proposals used at forced disruption sweeps. */
export function intrinsicDisruptionProposals(input: {
  readonly targetBox: IntrinsicTargetBox
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
  readonly ordinal: number
  readonly interfaceDisruptionStagnated?: boolean
  readonly maximumInterfaceCavityCount: number
  readonly maximumInterfaceHullGapRatio: number
}): ReadonlyArray<IntrinsicSeparatorProposal> {
  const resolved = resolveState(input.catalog, input.state)
  if (resolved === undefined || resolved.length < 2) return []
  const ranked = resolved.toSorted(
    (first, second) =>
      second.polygon.areaGrid2 - first.polygon.areaGrid2 ||
      second.polygon.maximumSide - first.polygon.maximumSide ||
      first.pose.pieceId.localeCompare(second.pose.pieceId)
  )
  const first = ranked[0]
  const distinctMate = ranked.find(
    (candidate) =>
      candidate.pose.pieceId !== first?.pose.pieceId &&
      baseCollisionFamilyKey(candidate.catalogEntry) !==
        (first === undefined ? undefined : baseCollisionFamilyKey(first.catalogEntry))
  )
  if (first === undefined) return []
  const proposals: IntrinsicSeparatorProposal[] = []
  if (distinctMate !== undefined) {
    const swapped = swapIntrinsicWorldCenters(
      input.catalog,
      input.state,
      first.pose.pieceId,
      distinctMate.pose.pieceId
    )
    if (swapped !== undefined) {
      proposals.push({
        kind: 'swap',
        state: swapped,
        affectedPieceIds: [first.pose.pieceId, distinctMate.pose.pieceId],
        key: `swap:${first.pose.pieceId}:${distinctMate.pose.pieceId}`
      })
    }
  }
  const satellites = ranked
    .filter(({ pose }) => pose.pieceId !== first.pose.pieceId)
    .toSorted((left, right) => {
      const leftDistance = squaredDistance(first.polygon.center, left.polygon.center)
      const rightDistance = squaredDistance(first.polygon.center, right.polygon.center)
      return leftDistance - rightDistance || left.pose.pieceId.localeCompare(right.pose.pieceId)
    })
    .slice(0, 3)
    .map(({ pose }) => pose.pieceId)
  const delta = haltonOffset(input.targetBox, input.ordinal + 17)
  const group = [first.pose.pieceId, ...satellites]
  const transported = transportIntrinsicGroup(input.catalog, input.state, group, delta)
  if (transported !== undefined) {
    proposals.push({
      kind: 'group-transport',
      state: transported,
      affectedPieceIds: group,
      key: `group:${group.join(',')}:${delta.x}:${delta.y}`
    })
  }
  const squeezed = splitSqueezeProposal(input)
  if (squeezed !== undefined) proposals.push(squeezed)
  const interfaceDisruption = gapInterfaceProposal(input)
  if (interfaceDisruption !== undefined) proposals.push(interfaceDisruption)
  return dedupeProposals(input.catalog, proposals)
}

function splitSqueezeProposal(input: {
  readonly targetBox: IntrinsicTargetBox
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
}): IntrinsicSeparatorProposal | undefined {
  const resolved = resolveState(input.catalog, input.state)
  if (resolved === undefined || resolved.length < 2) return undefined
  const widthGrid = toGridMm(input.targetBox.widthMm)
  const heightGrid = toGridMm(input.targetBox.heightMm)
  if (widthGrid === undefined || heightGrid === undefined) return undefined
  const horizontal = widthGrid >= heightGrid
  const ordered = resolved.toSorted((first, second) => {
    const firstCoordinate = horizontal ? first.polygon.center.x : first.polygon.center.y
    const secondCoordinate = horizontal ? second.polygon.center.x : second.polygon.center.y
    return firstCoordinate - secondCoordinate || first.pose.pieceId.localeCompare(second.pose.pieceId)
  })
  const splitIndex = Math.max(1, Math.floor(ordered.length / 2))
  const firstGroup = ordered.slice(0, splitIndex).map(({ pose }) => pose.pieceId)
  const secondGroup = ordered.slice(splitIndex).map(({ pose }) => pose.pieceId)
  if (secondGroup.length === 0) return undefined
  const squeezeGrid = Math.max(1, Math.round((horizontal ? widthGrid : heightGrid) / 20))
  const firstMoved = transportIntrinsicGroup(
    input.catalog,
    input.state,
    firstGroup,
    horizontal ? { x: squeezeGrid, y: 0 } : { x: 0, y: squeezeGrid }
  )
  if (firstMoved === undefined) return undefined
  const complete = transportIntrinsicGroup(
    input.catalog,
    firstMoved,
    secondGroup,
    horizontal ? { x: -squeezeGrid, y: 0 } : { x: 0, y: -squeezeGrid }
  )
  return complete === undefined
    ? undefined
    : {
        kind: 'split-squeeze',
        state: complete,
        affectedPieceIds: [...firstGroup, ...secondGroup],
        key: `split-squeeze:${horizontal ? 'x' : 'y'}:${squeezeGrid}:${firstGroup.join(',')}`
      }
}

function gapInterfaceProposal(input: {
  readonly targetBox: IntrinsicTargetBox
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
  readonly interfaceDisruptionStagnated?: boolean
  readonly maximumInterfaceCavityCount: number
  readonly maximumInterfaceHullGapRatio: number
}): IntrinsicSeparatorProposal | undefined {
  const provisional = provisionalLayoutFromRelaxedState(input.catalog, input.state)
  if (provisional === undefined) return undefined
  const sheet = new SheetSpec({
    width: Math.ceil(input.targetBox.widthMm),
    height: Math.ceil(input.targetBox.heightMm),
    label: 'intrinsic-private-gap-interface'
  })
  const structure = analyzeCanonicalLayoutStructure(sheet, provisional)
  const topology = measureCanonicalLayoutTopology(provisional)
  const cavities = measureCanonicalEnclosedCavities(provisional)
  const gap = structure?.largestHullGap
  if (
    structure === undefined ||
    topology === undefined ||
    cavities === undefined ||
    gap === undefined ||
    !assertIntrinsicTargetExactLegal(input.targetBox, provisional) ||
    structure.positiveAreaConflicts.length > 0 ||
    structure.wallOffenders.length > 0
  ) {
    return undefined
  }
  const structurallyPoor =
    topology.largestOccupiedHullGapRatio > input.maximumInterfaceHullGapRatio ||
    cavities.count > input.maximumInterfaceCavityCount
  if (!structurallyPoor && input.interfaceDisruptionStagnated !== true) return undefined
  const gapCenter = {
    x: (gap.aabb.minX + gap.aabb.maxX) / 2,
    y: (gap.aabb.minY + gap.aabb.maxY) / 2
  }
  const gapPath = gap.path.map(({ x, y }) => ({ x: toGridMm(x), y: toGridMm(y) }))
  if (gapPath.some(({ x, y }) => x === undefined || y === undefined)) return undefined
  const exactGapPath = gapPath.filter(
    (point): point is GridPoint => point.x !== undefined && point.y !== undefined
  )
  const resolved = resolveState(input.catalog, input.state)
  const adjacent = resolved?.toSorted(
    (first, second) =>
      polygonBoundaryDistanceSquared(first.polygon.points, exactGapPath) -
        polygonBoundaryDistanceSquared(second.polygon.points, exactGapPath) ||
      first.pose.pieceId.localeCompare(second.pose.pieceId)
  )[0]
  const pose = input.state.poses.find(({ pieceId }) => pieceId === adjacent?.pose.pieceId)
  const center = pose === undefined ? undefined : poseWorldCenter(input.catalog, pose)
  if (pose === undefined || center === undefined) return undefined
  const delta = {
    x: Math.round((gapCenter.x - center.x) / 2),
    y: Math.round((gapCenter.y - center.y) / 2)
  }
  if (delta.x === 0 && delta.y === 0) return undefined
  const transported = transportIntrinsicGroup(
    input.catalog,
    input.state,
    [pose.pieceId],
    delta
  )
  return transported === undefined
    ? undefined
    : {
        kind: 'interface-disrupt',
        state: transported,
        affectedPieceIds: [pose.pieceId],
        key: `gap-interface:${pose.pieceId}:${delta.x}:${delta.y}`
      }
}

export function canonicalizeRelaxedState(
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState
): IntrinsicRelaxedState | undefined {
  const poseById = new Map(state.poses.map((pose) => [pose.pieceId, pose] as const))
  if (poseById.size !== catalog.entries.length || state.poses.length !== catalog.entries.length) {
    return undefined
  }
  const resolved = resolveStateUncanonicalized(catalog, state)
  if (resolved === undefined) return undefined
  let minimumX = Number.POSITIVE_INFINITY
  let minimumY = Number.POSITIVE_INFINITY
  for (const entry of resolved) {
    for (const point of entry.polygon.points) {
      minimumX = Math.min(minimumX, point.x)
      minimumY = Math.min(minimumY, point.y)
    }
  }
  if (!Number.isSafeInteger(minimumX) || !Number.isSafeInteger(minimumY)) return undefined
  const poses = catalog.entries.map((entry) => {
    const pose = poseById.get(entry.pieceId)
    if (pose === undefined) return undefined
    const translateXGrid = pose.translateXGrid - minimumX
    const translateYGrid = pose.translateYGrid - minimumY
    return Number.isSafeInteger(translateXGrid) && Number.isSafeInteger(translateYGrid)
      ? { ...pose, translateXGrid, translateYGrid }
      : undefined
  })
  return poses.some((pose) => pose === undefined)
    ? undefined
    : {
        poses: poses.filter((pose): pose is IntrinsicRelaxedPose => pose !== undefined)
      }
}

function resolveState(
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState
): ReadonlyArray<ResolvedPose> | undefined {
  const canonical = canonicalizeRelaxedState(catalog, state)
  return canonical === undefined ? undefined : resolveStateUncanonicalized(catalog, canonical)
}

function resolveStateUncanonicalized(
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState
): ReadonlyArray<ResolvedPose> | undefined {
  const poseById = new Map(state.poses.map((pose) => [pose.pieceId, pose] as const))
  if (poseById.size !== catalog.entries.length || state.poses.length !== catalog.entries.length) {
    return undefined
  }
  const result: ResolvedPose[] = []
  for (const catalogEntry of catalog.entries) {
    const pose = poseById.get(catalogEntry.pieceId)
    const finiteTransform = catalogEntry.transforms.find(
      ({ canonicalTransformKey }) => canonicalTransformKey === pose?.transformKey
    )
    if (
      pose === undefined ||
      finiteTransform === undefined ||
      !Number.isFinite(pose.translationBasisXmm) ||
      !Number.isFinite(pose.translationBasisYmm) ||
      !Number.isSafeInteger(pose.translateXGrid) ||
      !Number.isSafeInteger(pose.translateYGrid)
    ) {
      return undefined
    }
    const polygon = gridPolygon(finiteTransform, pose)
    if (polygon === undefined) return undefined
    result.push({ pose, catalogEntry, finiteTransform, polygon })
  }
  return result
}

function gridPolygon(
  finiteTransform: IntrinsicFiniteTransform,
  pose: IntrinsicRelaxedPose
): GridPolygon | undefined {
  const points = finiteTransform.geometry.polygon.points.map((point) => {
    const basisX = toGridMm(point.x + pose.translationBasisXmm)
    const basisY = toGridMm(point.y + pose.translationBasisYmm)
    if (basisX === undefined || basisY === undefined) return undefined
    const rawX = basisX + pose.translateXGrid
    const rawY = basisY + pose.translateYGrid
    const x = rawX === 0 ? 0 : rawX
    const y = rawY === 0 ? 0 : rawY
    return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : undefined
  })
  if (points.length < 3 || points.some((point) => point === undefined)) return undefined
  const complete = points.filter((point): point is GridPoint => point !== undefined)
  const center = polygonCenter(complete)
  const characteristicLength = polygonCharacteristicLength(complete)
  const bounds = polygonBounds(complete)
  const areaGrid2 = polygonAreaGrid2(complete)
  return center === undefined ||
    characteristicLength === undefined ||
    bounds === undefined ||
    areaGrid2 === undefined
    ? undefined
    : {
        points: complete,
        center,
        characteristicLength,
        maximumSide: Math.max(
          bounds.maximumX - bounds.minimumX,
          bounds.maximumY - bounds.minimumY
        ),
        areaGrid2
      }
}

function satPenetration(first: GridPolygon, second: GridPolygon): SatPenetration | undefined {
  let minimumDepth = Number.POSITIVE_INFINITY
  let selectedAxis: GridPoint | undefined
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.points.length; index += 1) {
      const start = polygon.points[index]
      const end = polygon.points[(index + 1) % polygon.points.length]
      if (start === undefined || end === undefined) return undefined
      const axisX = -(end.y - start.y)
      const axisY = end.x - start.x
      const length = Math.hypot(axisX, axisY)
      if (length === 0 || !Number.isFinite(length)) return undefined
      const normalizedAxis = { x: axisX / length, y: axisY / length }
      const firstProjection = projectPolygon(first.points, normalizedAxis)
      const secondProjection = projectPolygon(second.points, normalizedAxis)
      if (firstProjection === undefined || secondProjection === undefined) return undefined
      const depth =
        Math.min(firstProjection.maximum, secondProjection.maximum) -
        Math.max(firstProjection.minimum, secondProjection.minimum)
      if (depth <= 0) return undefined
      if (depth < minimumDepth) {
        minimumDepth = depth
        selectedAxis = normalizedAxis
      }
    }
  }
  if (selectedAxis === undefined || !Number.isFinite(minimumDepth)) return undefined
  const centerDelta = {
    x: first.center.x - second.center.x,
    y: first.center.y - second.center.y
  }
  const direction = centerDelta.x * selectedAxis.x + centerDelta.y * selectedAxis.y < 0 ? -1 : 1
  return {
    depth: minimumDepth,
    moveX: selectedAxis.x * minimumDepth * direction,
    moveY: selectedAxis.y * minimumDepth * direction
  }
}

function wallPenetrations(
  entry: ResolvedPose,
  targetWidthGrid: number,
  targetHeightGrid: number
): ReadonlyArray<IntrinsicSeparationConflict> {
  const minimumX = Math.min(...entry.polygon.points.map(({ x }) => x))
  const minimumY = Math.min(...entry.polygon.points.map(({ y }) => y))
  const maximumX = Math.max(...entry.polygon.points.map(({ x }) => x))
  const maximumY = Math.max(...entry.polygon.points.map(({ y }) => y))
  const normalizer = Math.max(1, entry.polygon.characteristicLength)
  const descriptors = [
    { side: 'left', depth: Math.max(0, -minimumX), x: Math.max(0, -minimumX), y: 0 },
    { side: 'bottom', depth: Math.max(0, -minimumY), x: 0, y: Math.max(0, -minimumY) },
    {
      side: 'right',
      depth: Math.max(0, maximumX - targetWidthGrid),
      x: -Math.max(0, maximumX - targetWidthGrid),
      y: 0
    },
    {
      side: 'top',
      depth: Math.max(0, maximumY - targetHeightGrid),
      x: 0,
      y: -Math.max(0, maximumY - targetHeightGrid)
    }
  ]
  return descriptors
    .filter(({ depth }) => depth > 0)
    .map(({ side, depth, x, y }) => ({
      key: `wall:${entry.pose.pieceId}:${side}`,
      kind: 'wall' as const,
      firstPieceId: entry.pose.pieceId,
      secondPieceId: undefined,
      rawDepth: depth,
      normalizedDepth: depth / normalizer,
      moveXGrid: x,
      moveYGrid: y
    }))
}

function compareConflicts(
  first: IntrinsicSeparationConflict,
  second: IntrinsicSeparationConflict
): number {
  return (
    second.normalizedDepth - first.normalizedDepth ||
    second.rawDepth - first.rawDepth ||
    first.key.localeCompare(second.key)
  )
}

function haltonOffset(targetBox: IntrinsicTargetBox, ordinal: number): GridPoint {
  const width = toGridMm(targetBox.widthMm) ?? 0
  const height = toGridMm(targetBox.heightMm) ?? 0
  const index = Math.max(1, Math.floor(ordinal) + 1)
  return {
    x: Math.round((halton(index, HALTON_PRIMES[0]) - 0.5) * width * 0.18),
    y: Math.round((halton(index, HALTON_PRIMES[1]) - 0.5) * height * 0.18)
  }
}

function halton(index: number, base: number): number {
  let fraction = 1
  let result = 0
  let current = index
  while (current > 0) {
    fraction /= base
    result += fraction * (current % base)
    current = Math.floor(current / base)
  }
  return result
}

function poseWorldCenter(
  catalog: IntrinsicTransformCatalog,
  pose: IntrinsicRelaxedPose
): GridPoint | undefined {
  const local = poseLocalCenter(catalog, pose)
  return local === undefined
    ? undefined
    : { x: local.x + pose.translateXGrid, y: local.y + pose.translateYGrid }
}

function poseLocalCenter(
  catalog: IntrinsicTransformCatalog,
  pose: IntrinsicRelaxedPose
): GridPoint | undefined {
  const finiteTransform = catalog.entries
    .find(({ pieceId }) => pieceId === pose.pieceId)
    ?.transforms.find(({ canonicalTransformKey }) => canonicalTransformKey === pose.transformKey)
  return finiteTransform === undefined
    ? undefined
    : finiteTransformPhaseCenter(finiteTransform, pose)
}

function finiteTransformPhaseCenter(
  finiteTransform: IntrinsicFiniteTransform,
  pose: IntrinsicRelaxedPose
): GridPoint | undefined {
  const points = finiteTransformPhasePoints(
    finiteTransform,
    pose.translationBasisXmm,
    pose.translationBasisYmm
  )
  return points === undefined ? undefined : polygonCenter(points)
}

function finiteTransformPhasePoints(
  finiteTransform: IntrinsicFiniteTransform,
  basisXmm: number,
  basisYmm: number
): ReadonlyArray<GridPoint> | undefined {
  const points = finiteTransform.geometry.polygon.points.map(({ x, y }) => ({
    x: toGridMm(x + basisXmm),
    y: toGridMm(y + basisYmm)
  }))
  if (points.some(({ x, y }) => x === undefined || y === undefined)) return undefined
  return points.filter(
    (point): point is GridPoint => point.x !== undefined && point.y !== undefined
  )
}

function translationPhaseSignature(
  catalog: IntrinsicTransformCatalog,
  pose: IntrinsicRelaxedPose,
  memo?: IntrinsicPhaseSignatureMemo
): string | undefined {
  const entry = catalog.entries.find(({ pieceId }) => pieceId === pose.pieceId)
  if (entry === undefined) return undefined
  const memoKey = `${entry.pieceId}:${pose.translationBasisXmm}:${pose.translationBasisYmm}`
  if (memo !== undefined) {
    memo.requestCount += 1
    if (memo.byCatalogEntryAndBasis.has(memoKey)) {
      memo.cacheHitCount += 1
      return memo.byCatalogEntryAndBasis.get(memoKey)
    }
    memo.cacheMissCount += 1
  }
  const signatures = entry.transforms.map((finiteTransform) => {
    const points = finiteTransformPhasePoints(
      finiteTransform,
      pose.translationBasisXmm,
      pose.translationBasisYmm
    )
    const pathKey = points === undefined
      ? undefined
      : translationNormalizedPointSetKey(points)
    return pathKey === undefined
      ? undefined
      : [finiteTransform.canonicalTransformKey, pathKey]
  })
  const result = signatures.some((entry) => entry === undefined)
    ? undefined
    : JSON.stringify(signatures)
  memo?.byCatalogEntryAndBasis.set(memoKey, result)
  return result
}

function baseCollisionFamilyKey(
  entry: IntrinsicTransformCatalogEntry
): string | undefined {
  const points = entry.preparedPiece.collisionGeometry.collisionPolygon.points.map(({ x, y }) => ({
    x: toGridMm(x),
    y: toGridMm(y)
  }))
  if (points.some(({ x, y }) => x === undefined || y === undefined)) return undefined
  const complete = points.filter(
    (point): point is GridPoint => point.x !== undefined && point.y !== undefined
  )
  return translationNormalizedPointSetKey(complete)
}

function translationNormalizedPointSetKey(points: ReadonlyArray<GridPoint>): string | undefined {
  const bounds = polygonBounds(points)
  return bounds === undefined
    ? undefined
    : pointSetKey(
        points.map(({ x, y }) => ({
          x: x - bounds.minimumX,
          y: y - bounds.minimumY
        }))
      )
}

function pointSetKey(points: ReadonlyArray<GridPoint>): string {
  return points
    .map(({ x, y }) => `${x}:${y}`)
    .toSorted()
    .join('|')
}

function pointSequenceKey(points: ReadonlyArray<GridPoint>): string {
  return points.map(({ x, y }) => `${x}:${y}`).join('|')
}

function polygonCenter(points: ReadonlyArray<GridPoint>): GridPoint | undefined {
  if (points.length === 0) return undefined
  const bounds = polygonBounds(points)
  return bounds === undefined
    ? undefined
    : { x: (bounds.minimumX + bounds.maximumX) / 2, y: (bounds.minimumY + bounds.maximumY) / 2 }
}

function polygonCharacteristicLength(points: ReadonlyArray<GridPoint>): number | undefined {
  const bounds = polygonBounds(points)
  if (bounds === undefined) return undefined
  const width = bounds.maximumX - bounds.minimumX
  const height = bounds.maximumY - bounds.minimumY
  const value = Math.max(1, Math.min(width, height) || Math.max(width, height))
  return Number.isFinite(value) ? value : undefined
}

function polygonAreaGrid2(points: ReadonlyArray<GridPoint>): number | undefined {
  if (points.length < 3) return undefined
  let doubleArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (current === undefined || next === undefined) return undefined
    doubleArea += current.x * next.y - next.x * current.y
  }
  const area = Math.abs(doubleArea) / 2
  return Number.isFinite(area) ? area : undefined
}

function polygonBoundaryDistanceSquared(
  first: ReadonlyArray<GridPoint>,
  second: ReadonlyArray<GridPoint>
): number {
  let minimum = Number.POSITIVE_INFINITY
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    const firstStart = first[firstIndex]
    const firstEnd = first[(firstIndex + 1) % first.length]
    if (firstStart === undefined || firstEnd === undefined) continue
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
      const secondStart = second[secondIndex]
      const secondEnd = second[(secondIndex + 1) % second.length]
      if (secondStart === undefined || secondEnd === undefined) continue
      minimum = Math.min(
        minimum,
        segmentDistanceSquared(firstStart, firstEnd, secondStart, secondEnd)
      )
    }
  }
  return minimum
}

function segmentDistanceSquared(
  firstStart: GridPoint,
  firstEnd: GridPoint,
  secondStart: GridPoint,
  secondEnd: GridPoint
): number {
  if (gridSegmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return 0
  return Math.min(
    pointSegmentDistanceSquared(firstStart, secondStart, secondEnd),
    pointSegmentDistanceSquared(firstEnd, secondStart, secondEnd),
    pointSegmentDistanceSquared(secondStart, firstStart, firstEnd),
    pointSegmentDistanceSquared(secondEnd, firstStart, firstEnd)
  )
}

function pointSegmentDistanceSquared(
  point: GridPoint,
  start: GridPoint,
  end: GridPoint
): number {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const denominator = deltaX * deltaX + deltaY * deltaY
  if (denominator === 0) return squaredDistance(point, start)
  const parameter = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / denominator)
  )
  return squaredDistance(point, {
    x: start.x + parameter * deltaX,
    y: start.y + parameter * deltaY
  })
}

function gridSegmentsIntersect(
  firstStart: GridPoint,
  firstEnd: GridPoint,
  secondStart: GridPoint,
  secondEnd: GridPoint
): boolean {
  const firstSecondStart = gridOrientation(firstStart, firstEnd, secondStart)
  const firstSecondEnd = gridOrientation(firstStart, firstEnd, secondEnd)
  const secondFirstStart = gridOrientation(secondStart, secondEnd, firstStart)
  const secondFirstEnd = gridOrientation(secondStart, secondEnd, firstEnd)
  if (
    oppositeBigIntSigns(firstSecondStart, firstSecondEnd) &&
    oppositeBigIntSigns(secondFirstStart, secondFirstEnd)
  ) {
    return true
  }
  return (
    (firstSecondStart === 0n && gridPointOnSegment(secondStart, firstStart, firstEnd)) ||
    (firstSecondEnd === 0n && gridPointOnSegment(secondEnd, firstStart, firstEnd)) ||
    (secondFirstStart === 0n && gridPointOnSegment(firstStart, secondStart, secondEnd)) ||
    (secondFirstEnd === 0n && gridPointOnSegment(firstEnd, secondStart, secondEnd))
  )
}

function gridOrientation(first: GridPoint, second: GridPoint, third: GridPoint): bigint {
  return (
    (BigInt(second.x) - BigInt(first.x)) * (BigInt(third.y) - BigInt(first.y)) -
    (BigInt(second.y) - BigInt(first.y)) * (BigInt(third.x) - BigInt(first.x))
  )
}

function oppositeBigIntSigns(first: bigint, second: bigint): boolean {
  return (first < 0n && second > 0n) || (first > 0n && second < 0n)
}

function gridPointOnSegment(point: GridPoint, start: GridPoint, end: GridPoint): boolean {
  return (
    point.x >= Math.min(start.x, end.x) &&
    point.x <= Math.max(start.x, end.x) &&
    point.y >= Math.min(start.y, end.y) &&
    point.y <= Math.max(start.y, end.y)
  )
}

function polygonBounds(points: ReadonlyArray<GridPoint>):
  | {
      readonly minimumX: number
      readonly minimumY: number
      readonly maximumX: number
      readonly maximumY: number
    }
  | undefined {
  const first = points[0]
  if (first === undefined) return undefined
  let minimumX = first.x
  let minimumY = first.y
  let maximumX = first.x
  let maximumY = first.y
  for (const point of points.slice(1)) {
    minimumX = Math.min(minimumX, point.x)
    minimumY = Math.min(minimumY, point.y)
    maximumX = Math.max(maximumX, point.x)
    maximumY = Math.max(maximumY, point.y)
  }
  return { minimumX, minimumY, maximumX, maximumY }
}

function projectPolygon(
  points: ReadonlyArray<GridPoint>,
  axis: GridPoint
): { readonly minimum: number; readonly maximum: number } | undefined {
  const first = points[0]
  if (first === undefined) return undefined
  let minimum = first.x * axis.x + first.y * axis.y
  let maximum = minimum
  for (const point of points.slice(1)) {
    const projection = point.x * axis.x + point.y * axis.y
    minimum = Math.min(minimum, projection)
    maximum = Math.max(maximum, projection)
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? { minimum, maximum } : undefined
}

function replacePose(
  state: IntrinsicRelaxedState,
  pieceId: PieceId,
  replacement: IntrinsicRelaxedPose
): IntrinsicRelaxedState {
  return {
    poses: state.poses.map((pose) => (pose.pieceId === pieceId ? replacement : pose))
  }
}

function dedupeProposals(
  catalog: IntrinsicTransformCatalog,
  proposals: ReadonlyArray<IntrinsicSeparatorProposal>
): ReadonlyArray<IntrinsicSeparatorProposal> {
  const seen = new Set<string>()
  const result: IntrinsicSeparatorProposal[] = []
  for (const proposal of proposals) {
    const stateKey = intrinsicRelaxedStateKey(catalog, proposal.state)
    if (stateKey === undefined || seen.has(stateKey)) continue
    seen.add(stateKey)
    result.push(proposal)
  }
  return result
}

function makePlaced(
  entry: IntrinsicTransformCatalogEntry,
  finiteTransform: IntrinsicFiniteTransform,
  pose: IntrinsicRelaxedPose
): IrregularPlacedPiece | undefined {
  const translateX = pose.translationBasisXmm + fromGrid(pose.translateXGrid)
  const translateY = pose.translationBasisYmm + fromGrid(pose.translateYGrid)
  if (!Number.isFinite(translateX) || !Number.isFinite(translateY)) return undefined
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId: entry.pieceId,
      sourcePieceId: entry.preparedPiece.source.id,
      placementReference: entry.preparedPiece.collisionGeometry.placementReference,
      transform: new IrregularTransform({
        translateX,
        translateY,
        rotationDeg: finiteTransform.transform.rotationDeg,
        mirrored: finiteTransform.transform.mirrored
      })
    }),
    collisionGeometry: finiteTransform.geometry
  })
}

function squaredDistance(first: GridPoint, second: GridPoint): number {
  const deltaX = first.x - second.x
  const deltaY = first.y - second.y
  return deltaX * deltaX + deltaY * deltaY
}

function transformKey(transform: {
  readonly index: number
  readonly rotationDeg: number
  readonly mirrored: boolean
  readonly reason: string
}): string {
  return JSON.stringify([
    transform.index,
    normalizedRotationDeg(transform.rotationDeg),
    transform.mirrored,
    transform.reason
  ])
}

function normalizedRotationDeg(rotationDeg: number): number {
  const remainder = rotationDeg % 360
  const normalized = remainder < 0 ? remainder + 360 : remainder
  return Object.is(normalized, -0) ? 0 : normalized
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}

/** Millimeter conversion seam kept explicit at the private/public boundary. */
export function intrinsicGridTranslationToMm(grid: number): number | undefined {
  return Number.isSafeInteger(grid) ? fromGrid(grid) : undefined
}
