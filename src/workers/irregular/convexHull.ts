import { IrregularPolygon } from '@shared/irregular/domain.js'
import type { IrregularPoint } from '@shared/irregular/domain.js'
import { computeConvexHull } from './core/convexHullCore.js'

export const ConvexHull = {
  compute
} as const

/**
 * Wraps a finite point cloud in its smallest convex polygon using the monotone
 * chain algorithm. The input order is irrelevant: points are sorted by X then
 * Y first, duplicate coordinates are removed exactly, and the result follows
 * the deterministic counter-clockwise boundary convention.
 */
function compute(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  const hull = computeConvexHull(points)
  return new IrregularPolygon({ points: hull.points })
}
