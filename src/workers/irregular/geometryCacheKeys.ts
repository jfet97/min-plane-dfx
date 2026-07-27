import type {
  IrregularGeometryCacheKey,
  IrregularGeometrySettings,
  IrregularPolygon,
  IrregularIfpBounds,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import type {
  ComputeIfpBoundsInput,
  ComputeNfpInput,
  GeneratePlacementCandidatesInput,
  TransformCollisionGeometryInput
} from './services.js'
import {
  DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
  makePairwiseNfpCacheKey,
  NFP_CONSTRUCTION_ALGORITHMS,
  NFP_GEOMETRY_CACHE_NAMESPACE,
  type NfpConstructionAlgorithm
} from './core/nfpCacheKey.js'
import { isValidCachedNfpBoundary as isValidCoreCachedNfpBoundary } from './core/nfpBoundaryCore.js'
import {
  IFP_GEOMETRY_CACHE_NAMESPACE,
  makeInnerFitBoundsCacheKey,
  makeTransformCollisionGeometryCacheKey,
  TRANSFORM_GEOMETRY_CACHE_NAMESPACE
} from './core/geometryCacheIdentity.js'
import { isValidCachedIfpBounds } from './core/ifpBoundsCore.js'
import { isValidCachedTransformedCollisionGeometry } from './core/transformCollisionGeometryCore.js'

/** Selects the relative convex NFP construction algorithm. */
export {
  DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
  NFP_CONSTRUCTION_ALGORITHMS,
  NFP_GEOMETRY_CACHE_NAMESPACE
}
export type { NfpConstructionAlgorithm }

/** Selects the live indexed candidate path or the differential-test reference path. */
export type NfpCandidatePruningMode = 'indexed' | 'reference'

/** Versioned cache namespaces keep derived artifacts isolated across algorithms. */
export { IFP_GEOMETRY_CACHE_NAMESPACE, TRANSFORM_GEOMETRY_CACHE_NAMESPACE }
export const LEGAL_CANDIDATE_MEMO_NAMESPACE = 'legal-placement-candidates-v1'

/** Builds the complete identity for one transformed collision polygon. */
export function transformCollisionGeometryCacheKey(
  input: TransformCollisionGeometryInput,
  settings: IrregularGeometrySettings
): IrregularGeometryCacheKey {
  return makeTransformCollisionGeometryCacheKey(input, settings)
}

/** Builds the complete identity for one fixed/moving pairwise NFP. */
export function pairwiseNfpCacheKey(
  input: ComputeNfpInput,
  constructionAlgorithm: NfpConstructionAlgorithm = DEFAULT_NFP_CONSTRUCTION_ALGORITHM
): IrregularGeometryCacheKey {
  return makePairwiseNfpCacheKey(
    {
      fixedPolygon: input.fixed.collisionGeometry.polygon.points,
      movingPolygon: input.moving.polygon.points,
      fixedTransform: input.fixed.collisionGeometry.transform,
      movingTransform: input.moving.transform,
      settings: input.settings
    },
    constructionAlgorithm
  )
}

/** Builds the identity for a sheet/piece inner-fit bounds artifact. */
export function innerFitBoundsCacheKey(input: ComputeIfpBoundsInput): IrregularGeometryCacheKey {
  return makeInnerFitBoundsCacheKey(input)
}

/** Builds geometry-only identity for one decode-local legal candidate-point set. */
export function legalPlacementCandidateMemoKey(
  input: GeneratePlacementCandidatesInput,
  constructionAlgorithm: NfpConstructionAlgorithm,
  candidatePruningMode: NfpCandidatePruningMode
): string {
  const sheetIdentity =
    input.candidateDomain === 'sheetless-nfp'
      ? 'sheet=deferred'
      : `sheet=${numberKey(input.sheet.width)},${numberKey(input.sheet.height)}`
  const placedPolygons = input.placed
    .map((placed) => {
      const translation = placed.placement.transform
      return [
        polygonDigest(placed.collisionGeometry.polygon.points),
        pointDigest({ x: translation.translateX, y: translation.translateY })
      ].join('@')
    })

  return JSON.stringify([
    LEGAL_CANDIDATE_MEMO_NAMESPACE,
    sheetIdentity,
    `placed=${placedPolygons.join('|')}`,
    `moving=${polygonDigest(input.moving.polygon.points)}`,
    `moving-bounds=${boundsDigest(input.moving.bounds)}`,
    ...geometrySettingsParts(input.settings.geometry),
    `nfp-construction=${constructionAlgorithm}`,
    `candidate-pruning=${candidatePruningMode}`,
    `candidate-domain=${input.candidateDomain ?? 'sheet'}`
  ])
}

/** Checks that a cached transformed artifact still describes its key inputs. */
export function isValidCachedTransform(
  value: TransformedCollisionGeometry | undefined,
  input: TransformCollisionGeometryInput
): value is TransformedCollisionGeometry {
  return isValidCachedTransformedCollisionGeometry(value, input)
}

/** Checks that a cached relative NFP has a finite strict convex boundary. */
export function isValidCachedNfpBoundary(
  value: IrregularPolygon | undefined
): value is IrregularPolygon {
  return isValidCoreCachedNfpBoundary(value)
}

/** Checks the finite bounds shape before a cached IFP is used by candidate generation. */
export function isValidCachedIfp(
  value: IrregularIfpBounds | undefined,
  input: ComputeIfpBoundsInput
): value is IrregularIfpBounds {
  return isValidCachedIfpBounds(value, input)
}

function geometrySettingsParts(settings: IrregularGeometrySettings): ReadonlyArray<string> {
  return [
    `flattening-sag=${numberKey(settings.flatteningSagToleranceMm)}`,
    `clearance-margin=${numberKey(settings.clearanceSafetyMarginMm)}`,
    `backend=${settings.geometryBackendId}`,
    `backend-version=${settings.geometryBackendVersion}`,
    'offset-policy=clipper2-offset-v3-sharp-miter-scale-1000'
  ]
}

function polygonDigest(points: ReadonlyArray<{ readonly x: number; readonly y: number }>): string {
  return points.map(pointDigest).join(';')
}

function pointDigest(point: { readonly x: number; readonly y: number }): string {
  return `${numberKey(point.x)},${numberKey(point.y)}`
}

function boundsDigest(bounds: {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}): string {
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].map(numberKey).join(',')
}

function numberKey(value: number): string {
  return Object.is(value, -0) ? '0' : String(value)
}
