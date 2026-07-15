import { ImportedPiece } from '@shared/domain/dxf.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import type { CollisionGeometry, IrregularPoint } from '@shared/irregular/domain.js'

export const IRREGULAR_DXF_FIXTURES = [
  'angled-profile.dxf',
  'circle-ellipse-arcs.dxf',
  'concave-and-stars.dxf',
  'convex-polygons.dxf',
  'duplicate-points.dxf',
  'high-padding.dxf',
  'mixed-sheet-like-screenshot.dxf',
  'near-collinear.dxf',
  'open-contour.dxf',
  'repeated-mixed-pieces.dxf',
  'rounded-rectangle.dxf',
  'star-5-point.dxf',
  'thin-and-awkward.dxf',
  'tiny-segments.dxf',
  'transform-cases.dxf',
  'trapezoid.dxf',
  'triangle.dxf',
  'unsupported-entities.dxf'
] as const

export const VALID_SINGLE_OUTLINE_FIXTURES = [
  'angled-profile.dxf',
  'high-padding.dxf',
  'near-collinear.dxf',
  'rounded-rectangle.dxf',
  'star-5-point.dxf',
  'tiny-segments.dxf',
  'trapezoid.dxf',
  'triangle.dxf'
] as const

export const INVALID_OUTLINE_FIXTURES = [
  'circle-ellipse-arcs.dxf',
  'concave-and-stars.dxf',
  'convex-polygons.dxf',
  'duplicate-points.dxf',
  'mixed-sheet-like-screenshot.dxf',
  'open-contour.dxf',
  'repeated-mixed-pieces.dxf',
  'thin-and-awkward.dxf',
  'transform-cases.dxf',
  'unsupported-entities.dxf'
] as const

export interface CollisionOpportunityMetrics {
  readonly convexHullAreaMm2: number
  readonly convexHullBoundingBoxAreaMm2: number
  readonly convexHullToBoundingBoxRatio: number
  readonly collisionPolygonAreaMm2: number
  readonly paddedBoundingBoxAreaMm2: number
  readonly collisionPolygonToPaddedBoundingBoxRatio: number
}

export function polygonArea(points: ReadonlyArray<IrregularPoint>): number {
  let crossSum = 0
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]
    const second = points[(index + 1) % points.length]
    if (first === undefined || second === undefined) return Number.NaN
    crossSum += first.x * second.y - second.x * first.y
  }
  return Math.abs(crossSum / 2)
}

export function polygonBoundingBoxArea(points: ReadonlyArray<IrregularPoint>): number {
  const first = points[0]
  if (first === undefined) return Number.NaN

  let minX = first.x
  let minY = first.y
  let maxX = first.x
  let maxY = first.y
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return (maxX - minX) * (maxY - minY)
}

export function collisionOpportunityMetrics(
  geometry: CollisionGeometry
): CollisionOpportunityMetrics {
  const convexHullAreaMm2 = polygonArea(geometry.convexHull.points)
  const convexHullBoundingBoxAreaMm2 = polygonBoundingBoxArea(geometry.convexHull.points)
  const collisionPolygonAreaMm2 = polygonArea(geometry.collisionPolygon.points)
  const paddedBoundingBoxAreaMm2 = polygonBoundingBoxArea(geometry.collisionPolygon.points)
  return {
    convexHullAreaMm2,
    convexHullBoundingBoxAreaMm2,
    convexHullToBoundingBoxRatio: convexHullAreaMm2 / convexHullBoundingBoxAreaMm2,
    collisionPolygonAreaMm2,
    paddedBoundingBoxAreaMm2,
    collisionPolygonToPaddedBoundingBoxRatio: collisionPolygonAreaMm2 / paddedBoundingBoxAreaMm2
  }
}

export function repeatImportedPieces(
  sources: ReadonlyArray<ImportedPiece>,
  copiesPerSource: number
): ReadonlyArray<ImportedPiece> {
  return sources.flatMap((source) =>
    Array.from({ length: copiesPerSource }, (_, copyIndex) => {
      const copyId = `${source.id}-copy-${copyIndex + 1}`
      return new ImportedPiece({
        ...source,
        id: PieceId.make(copyId),
        sourceFileId: SourceFileId.make(`${source.sourceFileId}-${copyIndex + 1}`),
        label: `${source.label} copy ${copyIndex + 1}`
      })
    })
  )
}
