import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPreparedPiece } from '@shared/irregular/domain.js'
import {
  compareIntrinsicCapacityEndpoints,
  materializeIntrinsicCapacityEndpoint,
  type IntrinsicCapacityCavityCache,
  type IntrinsicCapacityEndpoint
} from './intrinsicCapacityEndpoint.js'
import { intrinsicCapacityPreparedPieceId } from './intrinsicCapacityMaterial.js'
import type { IntrinsicSharedArchiveDirectRole } from './intrinsicSharedArchivePortfolio.js'
import { INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES } from './intrinsicSharedArchivePortfolio.js'
import type { IrregularBeamState } from './irregularBeamState.js'

/** At most three committed direct constructors times three depths. */
export const INTRINSIC_CAPACITY_MAXIMUM_PREFIX_DESCRIPTORS = 9

/** One committed direct-constructor prefix captured after construction returned. */
export interface IntrinsicCapacityPrefixDescriptor {
  readonly role: IntrinsicSharedArchiveDirectRole
  readonly depth: number
  /** Immutable prefix state exactly as committed by the direct constructor. */
  readonly state: IrregularBeamState
  readonly placedPreparedIds: ReadonlyArray<PieceId>
  readonly remainingPreparedIds: ReadonlyArray<PieceId>
}

export interface IntrinsicCapacityPrefixSource {
  readonly role: string
  readonly state: IrregularBeamState
}

/** Quarter, half, and three-quarter depths of the immutable prepared order. */
export function intrinsicCapacityPrefixDepths(pieceCount: number): ReadonlyArray<number> {
  const depths = [
    Math.floor(pieceCount / 4),
    Math.floor(pieceCount / 2),
    Math.floor((3 * pieceCount) / 4)
  ]
  return [...new Set(depths)].filter((depth) => depth >= 1 && depth < pieceCount)
}

/**
 * Walks each committed direct constructor's parent lineage once, after
 * construction returned, and captures descriptors at the unique valid depths.
 * Capture is read-only: it copies no states, rebuilds no indexes, and measures
 * no geometry, so complete construction stays byte-identical.
 */
export function captureIntrinsicCapacityPrefixDescriptors(input: {
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly sources: ReadonlyArray<IntrinsicCapacityPrefixSource>
}): ReadonlyArray<IntrinsicCapacityPrefixDescriptor> {
  const preparedIds = input.preparedPieces.map(intrinsicCapacityPreparedPieceId)
  const depths = intrinsicCapacityPrefixDepths(preparedIds.length)
  if (depths.length === 0) return []

  const descriptors: IntrinsicCapacityPrefixDescriptor[] = []
  for (const role of INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES) {
    const source = input.sources.find((candidate) => candidate.role === role)
    if (source === undefined) continue
    const statesByProcessedCount = new Map<number, IrregularBeamState>()
    let lineageState: IrregularBeamState | undefined = source.state
    while (lineageState !== undefined) {
      const processedCount =
        lineageState.placementOrder.length + lineageState.unplacedPieceIds.length
      if (!statesByProcessedCount.has(processedCount)) {
        statesByProcessedCount.set(processedCount, lineageState)
      }
      lineageState = lineageState.parent
    }
    for (const depth of depths) {
      const state = statesByProcessedCount.get(depth)
      if (state === undefined || !isExactPreparedPrefix(state, preparedIds, depth)) continue
      descriptors.push({
        role,
        depth,
        state,
        placedPreparedIds: state.placementOrder,
        remainingPreparedIds: preparedIds.slice(depth)
      })
    }
  }
  return descriptors.slice(0, INTRINSIC_CAPACITY_MAXIMUM_PREFIX_DESCRIPTORS)
}

/** A descriptor must be a skip-free processed prefix of the prepared order. */
function isExactPreparedPrefix(
  state: IrregularBeamState,
  preparedIds: ReadonlyArray<PieceId>,
  depth: number
): boolean {
  if (state.unplacedPieceIds.length > 0) return false
  if (state.placementOrder.length !== depth) return false
  for (let index = 0; index < depth; index += 1) {
    if (state.placementOrder[index] !== preparedIds[index]) return false
  }
  const remaining = state.remainingPreparedPieces.map(intrinsicCapacityPreparedPieceId)
  if (remaining.length !== preparedIds.length - depth) return false
  for (let index = 0; index < remaining.length; index += 1) {
    if (remaining[index] !== preparedIds[depth + index]) return false
  }
  return true
}

export interface IntrinsicCapacityPrefixTerminalization {
  readonly capturedCount: number
  readonly fittingCount: number
  readonly rejectedCount: number
  /** Exact fitting descriptors retained as independent warm-lane seeds. */
  readonly fittingDescriptors: ReadonlyArray<IntrinsicCapacityPrefixDescriptor>
  /** Deduplicated fitting prefix endpoints ranked by the capacity objective. */
  readonly endpoints: ReadonlyArray<IntrinsicCapacityEndpoint>
  readonly incumbent: IntrinsicCapacityEndpoint | undefined
}

/**
 * Exact-fits every descriptor against the requested sheet at partial q0/q90,
 * terminalizes the fitting ones into fully accounted partial endpoints, and
 * selects the initial incumbent. This performs zero placement evaluations.
 */
export function terminalizeIntrinsicCapacityPrefixEndpoints(input: {
  readonly sheet: SheetSpec
  readonly descriptors: ReadonlyArray<IntrinsicCapacityPrefixDescriptor>
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
  readonly cavityCache: IntrinsicCapacityCavityCache
}): IntrinsicCapacityPrefixTerminalization {
  const endpointsByHash = new Map<string, IntrinsicCapacityEndpoint>()
  const fittingDescriptors: IntrinsicCapacityPrefixDescriptor[] = []
  let fittingCount = 0
  for (const descriptor of input.descriptors) {
    const endpoint = materializeIntrinsicCapacityEndpoint({
      sheet: input.sheet,
      state: descriptor.state,
      unplacedPreparedIds: descriptor.remainingPreparedIds,
      origin: 'prefix-incumbent',
      sourceRole: descriptor.role,
      prefixDepth: descriptor.depth,
      materialAreasByPieceId: input.materialAreasByPieceId,
      cavityCache: input.cavityCache
    })
    if (endpoint === undefined) continue
    fittingDescriptors.push(descriptor)
    fittingCount += 1
    const existing = endpointsByHash.get(endpoint.canonicalGeometryHash)
    if (existing === undefined || compareIntrinsicCapacityEndpoints(endpoint, existing) < 0) {
      endpointsByHash.set(endpoint.canonicalGeometryHash, endpoint)
    }
  }
  const endpoints = [...endpointsByHash.values()].toSorted(compareIntrinsicCapacityEndpoints)
  return {
    capturedCount: input.descriptors.length,
    fittingCount,
    rejectedCount: input.descriptors.length - fittingCount,
    fittingDescriptors,
    endpoints,
    incumbent: endpoints[0]
  }
}
