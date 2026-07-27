import { ConvexPolygonValidation } from '../convexPolygonValidation.js'
import type {
  InternalIfpBounds,
  InternalSheetSpec,
  InternalTransformCandidate
} from '../internalGeometry.js'
import {
  boundsForPoints,
  makeInnerFitBoundsCacheKey,
  type InnerFitBoundsKeyInput
} from './geometryCacheIdentity.js'
import type { GeometryCacheKey, GeometryCacheStore } from './geometryCacheStore.js'

export type CoreIfpBoundsFailureKind = 'invalid' | 'infeasible'

export interface CoreIfpBoundsSuccess<
  TPieceId extends string,
  TSheet extends InternalSheetSpec
> {
  readonly ok: true
  readonly value: InternalIfpBounds<TPieceId, TSheet>
  readonly key: GeometryCacheKey
}

export interface CoreIfpBoundsFailure {
  readonly ok: false
  readonly kind: CoreIfpBoundsFailureKind
  readonly message: string
}

export type CoreIfpBoundsResult<
  TPieceId extends string,
  TSheet extends InternalSheetSpec
> = CoreIfpBoundsSuccess<TPieceId, TSheet> | CoreIfpBoundsFailure

/** Resolves rectangular IFP bounds while preserving validation-before-cache ordering. */
export function resolveIfpBounds<
  TPieceId extends string,
  TTransform extends InternalTransformCandidate,
  TSheet extends InternalSheetSpec
>(
  input: InnerFitBoundsKeyInput<TPieceId, TTransform, TSheet>,
  cache: GeometryCacheStore
): CoreIfpBoundsResult<TPieceId, TSheet> {
  const validation = ConvexPolygonValidation.validateStrictBoundary(input.moving.polygon.points)
  if ('message' in validation) return invalid(validation.message)

  const key = makeInnerFitBoundsCacheKey(input)
  const cached = cache.get<InternalIfpBounds<TPieceId, TSheet>>(key)
  if (isValidCachedIfpBounds(cached, input)) {
    return { ok: true, value: cached, key }
  }

  if (cached !== undefined) cache.remove(key)
  const computed = computeIfpBounds(input)
  if (!computed.ok) return computed
  cache.set(key, computed.value)
  return { ...computed, key }
}

export function computeIfpBounds<
  TPieceId extends string,
  TTransform extends InternalTransformCandidate,
  TSheet extends InternalSheetSpec
>(
  input: InnerFitBoundsKeyInput<TPieceId, TTransform, TSheet>
): Omit<CoreIfpBoundsSuccess<TPieceId, TSheet>, 'key'> | CoreIfpBoundsFailure {
  const validation = ConvexPolygonValidation.validateStrictBoundary(input.moving.polygon.points)
  if ('message' in validation) return invalid(validation.message)

  const polygonBounds = boundsForPoints(input.moving.polygon.points)
  if (polygonBounds === undefined) return invalid('moving polygon bounds must be finite.')

  const minX = normalizeNegativeZero(-polygonBounds.minX)
  const minY = normalizeNegativeZero(-polygonBounds.minY)
  const maxX = normalizeNegativeZero(input.sheet.width - polygonBounds.maxX)
  const maxY = normalizeNegativeZero(input.sheet.height - polygonBounds.maxY)
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return invalid('IFP arithmetic must produce finite bounds.')
  }
  if (minX > maxX || minY > maxY) {
    return { ok: false, kind: 'infeasible', message: 'moving polygon cannot fit inside the sheet.' }
  }

  return {
    ok: true,
    value: {
      sheet: input.sheet,
      movingPieceId: input.moving.sourcePieceId,
      bounds: { minX, minY, maxX, maxY }
    }
  }
}

export function isValidCachedIfpBounds<
  TPieceId extends string,
  TTransform extends InternalTransformCandidate,
  TSheet extends InternalSheetSpec
>(
  value: InternalIfpBounds<TPieceId, TSheet> | undefined,
  input: InnerFitBoundsKeyInput<TPieceId, TTransform, TSheet>
): value is InternalIfpBounds<TPieceId, TSheet> {
  if (value === undefined) return false
  const movingBounds = boundsForPoints(input.moving.polygon.points)
  if (movingBounds === undefined) return false
  return (
    value.movingPieceId === input.moving.sourcePieceId &&
    value.sheet.width === input.sheet.width &&
    value.sheet.height === input.sheet.height &&
    value.bounds.minX === -movingBounds.minX &&
    value.bounds.minY === -movingBounds.minY &&
    value.bounds.maxX === input.sheet.width - movingBounds.maxX &&
    value.bounds.maxY === input.sheet.height - movingBounds.maxY &&
    [value.bounds.minX, value.bounds.minY, value.bounds.maxX, value.bounds.maxY].every(
      Number.isFinite
    )
  )
}

function invalid(message: string): CoreIfpBoundsFailure {
  return { ok: false, kind: 'invalid', message }
}

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}
