import type { IrregularPolygon, IrregularPreparedPiece } from '@shared/irregular/domain.js'

export const MIN_CANONICAL_REFERENCE_COLLISION_AREA_RATIO = 4
export const MIN_CANONICAL_REFERENCE_FAMILY_COUNT = 2

/** Geometry-and-family activation boundary for the expensive canonical decode. */
export function hasScaleDiverseMultiFamilyWorkload(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  interchangeabilityFamilies: ReadonlyArray<string>
): boolean {
  let minimumAreaMm2 = Number.POSITIVE_INFINITY
  let maximumAreaMm2 = 0
  for (const piece of pieces) {
    const areaMm2 = collisionPolygonAreaMm2(piece.collisionGeometry.collisionPolygon)
    if (areaMm2 === undefined) return false
    minimumAreaMm2 = Math.min(minimumAreaMm2, areaMm2)
    maximumAreaMm2 = Math.max(maximumAreaMm2, areaMm2)
  }
  return (
    new Set(interchangeabilityFamilies).size >= MIN_CANONICAL_REFERENCE_FAMILY_COUNT &&
    Number.isFinite(minimumAreaMm2) &&
    minimumAreaMm2 > 0 &&
    maximumAreaMm2 >= minimumAreaMm2 * MIN_CANONICAL_REFERENCE_COLLISION_AREA_RATIO
  )
}

function collisionPolygonAreaMm2(polygon: IrregularPolygon): number | undefined {
  let doubledArea = 0
  for (let index = 0; index < polygon.points.length; index += 1) {
    const first = polygon.points[index]
    const second = polygon.points[(index + 1) % polygon.points.length]
    if (first === undefined || second === undefined) return undefined
    doubledArea += first.x * second.y - second.x * first.y
    if (!Number.isFinite(doubledArea)) return undefined
  }
  const areaMm2 = Math.abs(doubledArea) / 2
  return Number.isFinite(areaMm2) && areaMm2 > 0 ? areaMm2 : undefined
}
