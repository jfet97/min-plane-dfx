/** Deterministic irregular geometry operations used by the worker boundary. */

import { Context, Effect, Exit, Layer, Match, Schema } from 'effect'
import type {
  FlattenSourceGeometryInput,
  TransformCollisionGeometryInput,
  ValidatePlacementInput
} from './services.js'
import {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  OffsetConvexPolygonInput,
  GeometryCache
} from './services.js'
import { ArcFlattening } from './arcFlattening.js'
import { EllipseFlattening } from './ellipseFlattening.js'
import { ConvexHull } from './convexHull.js'
import { ConvexPolygonOffset } from './convexPolygonOffset.js'
import { TransformCollisionGeometry } from './transformCollisionGeometry.js'
import { PlacementValidation } from './placementValidation.js'
import { DEFAULT_IRREGULAR_NESTING_SETTINGS } from '@shared/irregular/defaults.js'
import {
  FlattenedGeometry,
  IrregularGeometrySettings,
  IrregularNestingSettings,
  IrregularPoint,
  IrregularPolygon,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import type { DxfGeometrySegment } from '@shared/domain/dxf.js'
import { isValidCachedTransform, transformCollisionGeometryCacheKey } from './geometryCacheKeys.js'
import { GeometryCacheInMemory } from './services.js'

/** Effect service providing the decoded irregular geometry settings. */
export class GeometrySettings extends Context.Service<GeometrySettings, IrregularNestingSettings>()(
  'min-plane-dfx/irregular/GeometrySettings'
) {
  static readonly Make = DEFAULT_IRREGULAR_NESTING_SETTINGS
  static readonly Live = Layer.succeed(GeometrySettings, GeometrySettings.Make)
}

export namespace GeometryKernel {
  export interface Service {
    /**
     * Flatten imported DXF summary geometry into deterministic source sample
     * points using the configured geometry settings.
     */
    readonly flattenSourceGeometry: (
      input: FlattenSourceGeometryInput
    ) => Effect.Effect<FlattenedGeometry, IrregularNestingNotImplementedError>
    /**
     * Compute the exact deterministic convex hull for already flattened sample
     * points.
     */
    readonly convexHull: (
      points: ReadonlyArray<IrregularPoint>
    ) => Effect.Effect<IrregularPolygon, IrregularNestingNotImplementedError>
    /**
     * Expand a convex polygon by half of the caller-provided total padding plus
     * the configured clearance safety margin.
     */
    readonly offsetConvexPolygon: (
      input: OffsetConvexPolygonInput
    ) => Effect.Effect<
      IrregularPolygon,
      IrregularNestingNotImplementedError | IrregularGeometryInputError
    >
    /**
     * Apply a rotation and mirror choice to collision geometry while preserving
     * the placement reference convention.
     */
    readonly transformCollisionGeometry: (
      input: TransformCollisionGeometryInput
    ) => Effect.Effect<
      TransformedCollisionGeometry,
      IrregularNestingNotImplementedError | IrregularGeometryInputError
    >
    /**
     * Validate that a candidate placement is inside the sheet and does not
     * overlap already placed collision polygons.
     */
    readonly validatePlacement: (
      input: ValidatePlacementInput
    ) => Effect.Effect<void, IrregularNestingNotImplementedError | IrregularGeometryInputError>
  }
}

/** Effect service for deterministic source flattening and collision geometry operations. */
export class GeometryKernel extends Context.Service<GeometryKernel, GeometryKernel.Service>()(
  'min-plane-dfx/irregular/GeometryKernel'
) {
  static readonly Make = Effect.gen(function* () {
    const settings = yield* GeometrySettings
    const geometryCache = yield* GeometryCache

    const makePointsStore = () => {
      const points: IrregularPoint[] = []
      const seen = new Set<`${number}:${number}`>()
      return {
        push(x: number, y: number) {
          // exact keys are intentional here: this only deduplicates points already emitted with identical coordinates
          // it avoids introducing a hidden geometric tolerance, grid snapping, or arc-specific rounding policy
          const key = `${x}:${y}` as const
          if (seen.has(key)) return
          seen.add(key)
          points.push({ x, y })
        },
        get() {
          return [...points]
        }
      }
    }

    return GeometryKernel.of({
      flattenSourceGeometry: ({ piece }) => {
        const pointsStore = makePointsStore()
        const sampledSourceCurves = new Set<string>()

        for (const segment of piece.geometry.segments) {
          Match.value<DxfGeometrySegment>(segment).pipe(
            Match.when({ kind: 'line' }, (line) => {
              const sourceCurve = line.sourceCurve
              if (sourceCurve !== undefined) {
                if (sampledSourceCurves.has(sourceCurve.sourceId)) return
                sampledSourceCurves.add(sourceCurve.sourceId)
                const points = EllipseFlattening.samplePoints(
                  sourceCurve,
                  settings.geometry.flatteningSagToleranceMm
                )
                for (const point of points) {
                  pointsStore.push(point.x, point.y)
                }
                return
              }

              if (line.bulge !== undefined && line.bulge !== 0) {
                const points = ArcFlattening.sampleBulgePoints(
                  line,
                  settings.geometry.flatteningSagToleranceMm
                )
                for (const point of points) {
                  pointsStore.push(point.x, point.y)
                }
                return
              }

              pointsStore.push(line.x1, line.y1)
              pointsStore.push(line.x2, line.y2)
            }),
            Match.when({ kind: 'arc' }, (arc) => {
              const points = ArcFlattening.samplePoints(
                arc,
                settings.geometry.flatteningSagToleranceMm
              )
              for (const point of points) {
                pointsStore.push(point.x, point.y)
              }
            }),
            Match.exhaustive
          )
        }
        return Effect.succeed(
          new FlattenedGeometry({
            sourcePieceId: piece.id,
            sampledPoints: pointsStore.get(),
            diagnostics: []
          })
        )
      },
      convexHull: (points) => Effect.succeed(ConvexHull.compute(points)),
      offsetConvexPolygon: (input) =>
        decodeOffsetConvexPolygonInput(input).pipe(
          Effect.flatMap(({ polygon, totalPaddingMm }) =>
            computeCollisionOffsetMm(totalPaddingMm, settings.geometry).pipe(
              Effect.flatMap((distanceMm) => ConvexPolygonOffset.compute(polygon, distanceMm))
            )
          )
        ),
      transformCollisionGeometry: (input) => {
        const key = transformCollisionGeometryCacheKey(input, settings.geometry)
        return geometryCache.get<TransformedCollisionGeometry>(key).pipe(
          Effect.flatMap((cached) => {
            if (isValidCachedTransform(cached, input)) return Effect.succeed(cached)
            const removeInvalid = cached === undefined ? Effect.void : geometryCache.remove(key)
            return removeInvalid.pipe(
              Effect.flatMap(() => TransformCollisionGeometry.compute(input)),
              Effect.tap((computed) => geometryCache.set(key, computed))
            )
          })
        )
      },
      validatePlacement: PlacementValidation.validate
    })
  })

  static readonly Layer = Layer.effect(GeometryKernel, GeometryKernel.Make).pipe(
    Layer.provideMerge(GeometryCacheInMemory)
  )
  static readonly LayerWithCache = Layer.effect(GeometryKernel, GeometryKernel.Make)
  static readonly Live = GeometryKernel.Layer
  static readonly Unimplemented = Layer.succeed(
    GeometryKernel,
    GeometryKernel.of({
      flattenSourceGeometry: () => failNotImplemented('flattenSourceGeometry'),
      convexHull: () => failNotImplemented('convexHull'),
      offsetConvexPolygon: () => failNotImplemented('offsetConvexPolygon'),
      transformCollisionGeometry: () => failNotImplemented('transformCollisionGeometry'),
      validatePlacement: () => failNotImplemented('validatePlacement')
    })
  )
}

function failNotImplemented(
  operation: string,
  settings?: IrregularNestingSettings
): Effect.Effect<never, IrregularNestingNotImplementedError> {
  const suffix =
    settings === undefined
      ? '.'
      : ` for ${settings.geometry.geometryBackendId}@${settings.geometry.geometryBackendVersion}.`
  return Effect.fail(
    new IrregularNestingNotImplementedError({
      service: 'GeometryKernel',
      operation,
      message: `GeometryKernel.${operation} is intentionally unimplemented${suffix}`
    })
  )
}

/** Combines schema-validated request padding with the configured safety margin. */
function computeCollisionOffsetMm(
  totalPaddingMm: number,
  settings: IrregularGeometrySettings
): Effect.Effect<number, IrregularGeometryInputError> {
  const distanceMm = totalPaddingMm / 2 + settings.clearanceSafetyMarginMm
  if (!Number.isFinite(distanceMm)) {
    return failInvalidGeometryInput(
      'offsetConvexPolygon',
      'totalPaddingMm plus clearanceSafetyMarginMm must produce a finite offset distance.'
    )
  }

  return Effect.succeed(distanceMm)
}

/** Decodes the operation input so callers cannot request an inward collision offset. */
function decodeOffsetConvexPolygonInput(
  input: OffsetConvexPolygonInput
): Effect.Effect<OffsetConvexPolygonInput, IrregularGeometryInputError> {
  const decoded = Schema.decodeUnknownExit(OffsetConvexPolygonInput)(input)
  if (Exit.isFailure(decoded)) {
    return failInvalidGeometryInput(
      'offsetConvexPolygon',
      'offset input must satisfy the shared offset geometry schema.'
    )
  }

  return Effect.succeed(decoded.value)
}

function failInvalidGeometryInput(
  operation: string,
  message: string
): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(new IrregularGeometryInputError({ operation, message }))
}
