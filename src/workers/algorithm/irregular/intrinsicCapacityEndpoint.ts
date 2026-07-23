import { createHash } from 'node:crypto'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPlacedPiece } from '@shared/irregular/domain.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutEnvelope
} from '../../irregular/canonicalLayoutGeometry.js'
import { toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { doubledGrid2ToMm2 } from './intrinsicCapacityMaterial.js'
import { canonicalAreaMetric, canonicalLinearMetric } from './intrinsicStrictDecoder.js'
import type { IrregularBeamState } from './irregularBeamState.js'

/** Constant identity for the honest all-unplaced capacity layout. */
export const INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY = 'intrinsic-capacity-empty-layout-v1'

export interface IntrinsicCapacityEndpointMetrics {
  readonly placedCount: number
  /** Exact doubled unpadded material area over placed prepared pieces. */
  readonly placedDoubledMaterialAreaGrid2: bigint
  readonly placedMaterialAreaMm2: number
  readonly enclosedCavityCount: number
  readonly totalEnclosedCavityAreaMm2: number
  readonly envelopeMaximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly envelopeSpanMm: number
}

export type IntrinsicCapacityEndpointOrigin = 'cold-search' | 'prefix-incumbent'

/** One exact partial capacity layout with a complete placed/unplaced partition. */
export interface IntrinsicCapacityEndpoint {
  readonly origin: IntrinsicCapacityEndpointOrigin
  readonly sourceRole: string | undefined
  readonly prefixDepth: number | undefined
  /** Placed prepared ids in placement order. */
  readonly placedPreparedIds: ReadonlyArray<PieceId>
  /** Unplaced prepared ids in immutable prepared order. */
  readonly unplacedPreparedIds: ReadonlyArray<PieceId>
  readonly selectedRotationDeg: 0 | 90
  readonly canonicalGeometryIdentity: string
  readonly canonicalGeometryHash: string
  /** Oriented, bottom-left anchored exact placed collision geometries. */
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly metrics: IntrinsicCapacityEndpointMetrics
}

export interface IntrinsicCapacityCavityMetrics {
  readonly count: number
  readonly totalAreaMm2: number
}

/** Exact cavity results cached by canonical occupied-union identity. */
export type IntrinsicCapacityCavityCache = Map<string, IntrinsicCapacityCavityMetrics>

/**
 * Measures exact enclosed cavities for one partial state, cached by the
 * translation-independent anchored occupied-union identity. Cavity topology is
 * invariant under exact canonical-grid translation and quarter-turns.
 */
export function measureIntrinsicCapacityCavities(
  state: IrregularBeamState,
  cache: IntrinsicCapacityCavityCache
): IntrinsicCapacityCavityMetrics | undefined {
  if (state.placedCollisionGeometries.length === 0) return { count: 0, totalAreaMm2: 0 }
  const occupiedKey = state.bottomLeftAnchoredCanonicalOccupiedGeometryKey()
  if (occupiedKey === undefined) return undefined
  const cached = cache.get(occupiedKey)
  if (cached !== undefined) return cached
  const measured = measureCanonicalEnclosedCavities(state.placedCollisionGeometries)
  if (measured === undefined) return undefined
  const metrics = { count: measured.count, totalAreaMm2: measured.totalAreaMm2 }
  cache.set(occupiedKey, metrics)
  return metrics
}

export interface IntrinsicCapacityGridSpan {
  readonly widthGrid: number
  readonly heightGrid: number
}

/** Exact canonical-grid span of one partial layout at its current translation. */
export function intrinsicCapacityStateGridSpan(
  state: IrregularBeamState
): IntrinsicCapacityGridSpan | undefined {
  const bounds = state.translatedCollisionBounds
  if (bounds === undefined) return undefined
  const minX = toGridMm(bounds.minX)
  const minY = toGridMm(bounds.minY)
  const maxX = toGridMm(bounds.maxX)
  const maxY = toGridMm(bounds.maxY)
  if (minX === undefined || minY === undefined || maxX === undefined || maxY === undefined) {
    return undefined
  }
  return { widthGrid: maxX - minX, heightGrid: maxY - minY }
}

/** Exact partial q0/q90 fit on grid spans; final legality re-runs at endpoints. */
export function intrinsicCapacitySpanFitsSheet(
  span: IntrinsicCapacityGridSpan,
  sheetWidthGrid: number,
  sheetHeightGrid: number
): { readonly q0: boolean; readonly q90: boolean } {
  return {
    q0: span.widthGrid <= sheetWidthGrid && span.heightGrid <= sheetHeightGrid,
    q90: span.heightGrid <= sheetWidthGrid && span.widthGrid <= sheetHeightGrid
  }
}

export interface MaterializeIntrinsicCapacityEndpointInput {
  readonly sheet: SheetSpec
  readonly state: IrregularBeamState
  readonly unplacedPreparedIds: ReadonlyArray<PieceId>
  readonly origin: IntrinsicCapacityEndpointOrigin
  readonly sourceRole?: string
  readonly prefixDepth?: number
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
  readonly cavityCache: IntrinsicCapacityCavityCache
}

/**
 * Converts one exact partial state into a capacity endpoint by selecting the
 * deterministic legal q0/q90 orientation and measuring exact metrics. Returns
 * undefined when neither rigid orientation is canonical-grid legal on the
 * requested sheet.
 */
export function materializeIntrinsicCapacityEndpoint(
  input: MaterializeIntrinsicCapacityEndpointInput
): IntrinsicCapacityEndpoint | undefined {
  const placedPreparedIds = input.state.placementOrder
  if (placedPreparedIds.length === 0) {
    return makeEmptyIntrinsicCapacityEndpoint(input)
  }
  const cavities = measureIntrinsicCapacityCavities(input.state, input.cavityCache)
  if (cavities === undefined) return undefined
  const placedDoubledMaterialAreaGrid2 = sumMaterialAreas(
    placedPreparedIds,
    input.materialAreasByPieceId
  )
  if (placedDoubledMaterialAreaGrid2 === undefined) return undefined

  const legal: Array<{
    readonly rotationDeg: 0 | 90
    readonly identity: string
    readonly hash: string
    readonly oriented: IrregularBeamState
  }> = []
  for (const rotationDeg of [0, 90] as const) {
    const oriented = input.state.withQuarterTurnBottomLeft(rotationDeg)
    if (
      oriented === undefined ||
      !assertCanonicalGridLegalLayout(input.sheet, oriented.placedCollisionGeometries)
    ) {
      continue
    }
    const identity = canonicalCollisionLayoutIdentity(oriented.placedCollisionGeometries)
    if (identity === undefined) continue
    legal.push({
      rotationDeg,
      identity,
      hash: createHash('sha256').update(identity).digest('hex'),
      oriented
    })
  }
  const selected = legal.toSorted(
    (first, second) =>
      first.hash.localeCompare(second.hash) || first.rotationDeg - second.rotationDeg
  )[0]
  if (selected === undefined) return undefined
  const envelope = measureCanonicalLayoutEnvelope(selected.oriented.placedCollisionGeometries)
  if (envelope === undefined) return undefined
  return {
    origin: input.origin,
    sourceRole: input.sourceRole,
    prefixDepth: input.prefixDepth,
    placedPreparedIds,
    unplacedPreparedIds: input.unplacedPreparedIds,
    selectedRotationDeg: selected.rotationDeg,
    canonicalGeometryIdentity: selected.identity,
    canonicalGeometryHash: selected.hash,
    placedCollisionGeometries: selected.oriented.placedCollisionGeometries,
    metrics: {
      placedCount: placedPreparedIds.length,
      placedDoubledMaterialAreaGrid2,
      placedMaterialAreaMm2: doubledGrid2ToMm2(placedDoubledMaterialAreaGrid2),
      enclosedCavityCount: cavities.count,
      totalEnclosedCavityAreaMm2: cavities.totalAreaMm2,
      envelopeMaximumSideMm: envelope.maximumSideMm,
      envelopeAreaMm2: envelope.areaMm2,
      envelopeSpanMm: envelope.spanMm
    }
  }
}

function makeEmptyIntrinsicCapacityEndpoint(
  input: MaterializeIntrinsicCapacityEndpointInput
): IntrinsicCapacityEndpoint {
  return {
    origin: input.origin,
    sourceRole: input.sourceRole,
    prefixDepth: input.prefixDepth,
    placedPreparedIds: [],
    unplacedPreparedIds: input.unplacedPreparedIds,
    selectedRotationDeg: 0,
    canonicalGeometryIdentity: INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY,
    canonicalGeometryHash: createHash('sha256')
      .update(INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY)
      .digest('hex'),
    placedCollisionGeometries: [],
    metrics: {
      placedCount: 0,
      placedDoubledMaterialAreaGrid2: 0n,
      placedMaterialAreaMm2: 0,
      enclosedCavityCount: 0,
      totalEnclosedCavityAreaMm2: 0,
      envelopeMaximumSideMm: 0,
      envelopeAreaMm2: 0,
      envelopeSpanMm: 0
    }
  }
}

function sumMaterialAreas(
  pieceIds: ReadonlyArray<PieceId>,
  materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
): bigint | undefined {
  let sum = 0n
  for (const pieceId of pieceIds) {
    const area = materialAreasByPieceId.get(pieceId)
    if (area === undefined) return undefined
    sum += area
  }
  return sum
}

function compareBigintDescending(first: bigint, second: bigint): number {
  if (first === second) return 0
  return first > second ? -1 : 1
}

/**
 * Total capacity objective:
 * more placed pieces, more unpadded placed material, fewer exact cavities,
 * less exact cavity area, smaller intrinsic maximum side, smaller intrinsic
 * envelope area, smaller intrinsic span, deterministic geometry identity.
 */
export function compareIntrinsicCapacityEndpoints(
  first: IntrinsicCapacityEndpoint,
  second: IntrinsicCapacityEndpoint
): number {
  return (
    second.metrics.placedCount - first.metrics.placedCount ||
    compareBigintDescending(
      first.metrics.placedDoubledMaterialAreaGrid2,
      second.metrics.placedDoubledMaterialAreaGrid2
    ) ||
    first.metrics.enclosedCavityCount - second.metrics.enclosedCavityCount ||
    canonicalAreaMetric(first.metrics.totalEnclosedCavityAreaMm2) -
      canonicalAreaMetric(second.metrics.totalEnclosedCavityAreaMm2) ||
    canonicalLinearMetric(first.metrics.envelopeMaximumSideMm) -
      canonicalLinearMetric(second.metrics.envelopeMaximumSideMm) ||
    canonicalAreaMetric(first.metrics.envelopeAreaMm2) -
      canonicalAreaMetric(second.metrics.envelopeAreaMm2) ||
    canonicalLinearMetric(first.metrics.envelopeSpanMm) -
      canonicalLinearMetric(second.metrics.envelopeSpanMm) ||
    first.canonicalGeometryHash.localeCompare(second.canonicalGeometryHash) ||
    intrinsicCapacityOriginRank(first.origin) - intrinsicCapacityOriginRank(second.origin) ||
    (first.prefixDepth ?? -1) - (second.prefixDepth ?? -1) ||
    (first.sourceRole ?? '').localeCompare(second.sourceRole ?? '')
  )
}

function intrinsicCapacityOriginRank(origin: IntrinsicCapacityEndpointOrigin): number {
  return origin === 'cold-search' ? 0 : 1
}

/** Verifies the exact placed/unplaced partition of the prepared request. */
export function intrinsicCapacityEndpointPartitionsRequest(
  endpoint: Pick<IntrinsicCapacityEndpoint, 'placedPreparedIds' | 'unplacedPreparedIds'>,
  allPreparedIds: ReadonlyArray<PieceId>
): boolean {
  const partition = [...endpoint.placedPreparedIds, ...endpoint.unplacedPreparedIds]
  if (partition.length !== allPreparedIds.length) return false
  if (new Set(partition).size !== partition.length) return false
  const allIds = new Set(allPreparedIds)
  return partition.every((pieceId) => allIds.has(pieceId))
}
