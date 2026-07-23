import type { PieceId } from '@shared/domain/ids.js'
import type { IrregularPoint, IrregularPreparedPiece } from '@shared/irregular/domain.js'
import { toGridMm } from '../../irregular/clipper2OffsetPolicy.js'

/** Grid-squared units per doubled square millimeter on the canonical 0.001 mm grid. */
const DOUBLED_GRID2_PER_MM2 = 2_000_000

/** Resolves the immutable prepared identity used by capacity accounting. */
export function intrinsicCapacityPreparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

/**
 * Exact doubled polygon area on the canonical integer grid.
 * Undefined means the ring cannot be represented exactly, never zero-by-default.
 */
export function exactDoubledPolygonAreaGrid2(
  points: ReadonlyArray<IrregularPoint>
): bigint | undefined {
  if (points.length < 3) return undefined
  const gridPoints: Array<readonly [bigint, bigint]> = []
  for (const point of points) {
    const gridX = toGridMm(point.x)
    const gridY = toGridMm(point.y)
    if (gridX === undefined || gridY === undefined) return undefined
    gridPoints.push([BigInt(gridX), BigInt(gridY)])
  }
  let doubled = 0n
  for (let index = 0; index < gridPoints.length; index += 1) {
    const first = gridPoints[index]
    const second = gridPoints[(index + 1) % gridPoints.length]
    if (first === undefined || second === undefined) return undefined
    doubled += first[0] * second[1] - second[0] * first[1]
  }
  const magnitude = doubled < 0n ? -doubled : doubled
  return magnitude > 0n ? magnitude : undefined
}

/**
 * Exact doubled unpadded material area of one prepared piece. The unpadded
 * convex hull is the engine-wide material authority for convex irregular
 * pieces; padding never counts as placed material.
 */
export function preparedPieceDoubledMaterialAreaGrid2(
  piece: IrregularPreparedPiece
): bigint | undefined {
  return exactDoubledPolygonAreaGrid2(piece.collisionGeometry.convexHull.points)
}

/** Builds the exact per-piece material map or reports the first invalid piece. */
export function intrinsicCapacityMaterialAreas(
  pieces: ReadonlyArray<IrregularPreparedPiece>
):
  | { readonly kind: 'complete'; readonly areasByPieceId: ReadonlyMap<PieceId, bigint> }
  | { readonly kind: 'invalid'; readonly pieceId: PieceId } {
  const areasByPieceId = new Map<PieceId, bigint>()
  for (const piece of pieces) {
    const pieceId = intrinsicCapacityPreparedPieceId(piece)
    const doubledAreaGrid2 = preparedPieceDoubledMaterialAreaGrid2(piece)
    if (doubledAreaGrid2 === undefined || areasByPieceId.has(pieceId)) {
      return { kind: 'invalid', pieceId }
    }
    areasByPieceId.set(pieceId, doubledAreaGrid2)
  }
  return { kind: 'complete', areasByPieceId }
}

/** Converts one exact doubled grid-squared area to display square millimeters. */
export function doubledGrid2ToMm2(doubledAreaGrid2: bigint): number {
  return Number(doubledAreaGrid2) / DOUBLED_GRID2_PER_MM2
}
