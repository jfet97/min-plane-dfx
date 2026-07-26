import type { InternalPoint } from '../internalGeometry.js'
import type { GeometryCacheKey } from './geometryCacheStore.js'

export const NFP_GEOMETRY_CACHE_NAMESPACE = 'pairwise-nfp-relative-v3'
export const NFP_CONSTRUCTION_ALGORITHMS = ['linear-edge-merge', 'vertex-pair-hull'] as const
export type NfpConstructionAlgorithm = (typeof NFP_CONSTRUCTION_ALGORITHMS)[number]
export const DEFAULT_NFP_CONSTRUCTION_ALGORITHM: NfpConstructionAlgorithm = 'vertex-pair-hull'

export interface CoreTransformCandidate {
  readonly index: number
  readonly rotationDeg: number
  readonly mirrored: boolean
  readonly reason: string
}

export interface CoreGeometrySettings {
  readonly flatteningSagToleranceMm: number
  readonly clearanceSafetyMarginMm: number
  readonly geometryBackendId: string
  readonly geometryBackendVersion: string
}

export interface PairwiseNfpKeyInput {
  readonly fixedPolygon: ReadonlyArray<InternalPoint>
  readonly movingPolygon: ReadonlyArray<InternalPoint>
  readonly fixedTransform: CoreTransformCandidate
  readonly movingTransform: CoreTransformCandidate
  readonly settings: CoreGeometrySettings
}

export function makePairwiseNfpCacheKey(
  input: PairwiseNfpKeyInput,
  constructionAlgorithm: NfpConstructionAlgorithm = DEFAULT_NFP_CONSTRUCTION_ALGORITHM
): GeometryCacheKey {
  return {
    namespace: NFP_GEOMETRY_CACHE_NAMESPACE,
    parts: [
      `fixed-polygon=${canonicalPolygonDigest(input.fixedPolygon)}`,
      `moving-polygon=${canonicalPolygonDigest(input.movingPolygon)}`,
      `fixed-transform=${transformDigest(input.fixedTransform)}`,
      `moving-transform=${transformDigest(input.movingTransform)}`,
      ...geometrySettingsParts(input.settings),
      'nfp-algorithm=convex-fixed-plus-negated-moving-relative-v3',
      `nfp-construction=${constructionAlgorithm}`
    ]
  }
}

function geometrySettingsParts(settings: CoreGeometrySettings): ReadonlyArray<string> {
  return [
    `flattening-sag=${numberKey(settings.flatteningSagToleranceMm)}`,
    `clearance-margin=${numberKey(settings.clearanceSafetyMarginMm)}`,
    `backend=${settings.geometryBackendId}`,
    `backend-version=${settings.geometryBackendVersion}`,
    'offset-policy=clipper2-offset-v3-sharp-miter-scale-1000'
  ]
}

function canonicalPolygonDigest(points: ReadonlyArray<InternalPoint>): string {
  if (points.length === 0) return ''
  let startIndex = 0
  for (let index = 1; index < points.length; index += 1) {
    const candidate = points[index]
    const current = points[startIndex]
    if (candidate === undefined || current === undefined) continue
    if (candidate.x < current.x || (candidate.x === current.x && candidate.y < current.y)) {
      startIndex = index
    }
  }

  const forward = cyclicPolygonDigest(points, startIndex, 1)
  const reverse = cyclicPolygonDigest(points, startIndex, -1)
  return forward < reverse ? forward : reverse
}

function cyclicPolygonDigest(
  points: ReadonlyArray<InternalPoint>,
  startIndex: number,
  direction: 1 | -1
): string {
  const pointKeys: string[] = []
  for (let offset = 0; offset < points.length; offset += 1) {
    const index = (startIndex + direction * offset + points.length * 2) % points.length
    const point = points[index]
    if (point === undefined) return ''
    pointKeys.push(pointDigest(point))
  }
  return pointKeys.join(';')
}

function transformDigest(transform: CoreTransformCandidate): string {
  return [
    `index=${numberKey(transform.index)}`,
    `rotation=${numberKey(transform.rotationDeg)}`,
    `mirrored=${Number(transform.mirrored)}`,
    `reason=${transform.reason}`
  ].join(',')
}

function pointDigest(point: InternalPoint): string {
  return `${numberKey(point.x)},${numberKey(point.y)}`
}

function numberKey(value: number): string {
  return Object.is(value, -0) ? '0' : String(value)
}
