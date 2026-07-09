import { Context, Effect, Layer, Match } from 'effect'
import type {
  FlattenSourceGeometryInput,
  OffsetConvexPolygonInput,
  TransformCollisionGeometryInput,
  ValidatePlacementInput
} from './services.js'
import { IrregularNestingNotImplementedError } from './services.js'
import { ArcFlattening } from './arcFlattening.js'
import { DEFAULT_IRREGULAR_GEOMETRY_SETTINGS } from '@shared/irregular/defaults.js'
import type {
  FlattenedGeometry,
  IrregularGeometrySettings,
  IrregularPoint,
  IrregularPolygon,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import type { DxfGeometrySegment } from '@shared/domain/dxf.js'

export class GeometrySettings extends Context.Service<
  GeometrySettings,
  IrregularGeometrySettings
>()('min-plane-dfx/irregular/GeometrySettings') {
  static readonly Make = DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
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
     * Compute the deterministic convex hull for already flattened sample
     * points.
     */
    readonly convexHull: (
      points: ReadonlyArray<IrregularPoint>
    ) => Effect.Effect<IrregularPolygon, IrregularNestingNotImplementedError>
    /**
     * Expand a convex polygon outward by a caller-provided distance, typically
     * padding plus clearance margin.
     */
    readonly offsetConvexPolygon: (
      input: OffsetConvexPolygonInput
    ) => Effect.Effect<IrregularPolygon, IrregularNestingNotImplementedError>
    /**
     * Apply a rotation and mirror choice to collision geometry while preserving
     * the placement reference convention.
     */
    readonly transformCollisionGeometry: (
      input: TransformCollisionGeometryInput
    ) => Effect.Effect<TransformedCollisionGeometry, IrregularNestingNotImplementedError>
    /**
     * Validate that a candidate placement is inside the sheet and does not
     * overlap already placed collision polygons.
     */
    readonly validatePlacement: (
      input: ValidatePlacementInput
    ) => Effect.Effect<void, IrregularNestingNotImplementedError>
  }
}

export class GeometryKernel extends Context.Service<GeometryKernel, GeometryKernel.Service>()(
  'min-plane-dfx/irregular/GeometryKernel'
) {
  static readonly Make = Effect.gen(function* () {
    const settings = yield* GeometrySettings

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

        for (const segment of piece.geometry.segments) {
          Match.value<DxfGeometrySegment>(segment).pipe(
            Match.when({ kind: 'line' }, (line) => {
              pointsStore.push(line.x1, line.y1)
              pointsStore.push(line.x2, line.y2)
            }),
            Match.when({ kind: 'arc' }, (arc) => {
              const points = ArcFlattening.samplePoints(arc, settings.flatteningSagToleranceMm)
              for (const point of points) {
                pointsStore.push(point.x, point.y)
              }
            }),
            Match.exhaustive
          )
        }
        return failNotImplemented('convexHull', settings)
      },
      convexHull: () => failNotImplemented('convexHull', settings),
      offsetConvexPolygon: () => failNotImplemented('offsetConvexPolygon', settings),
      transformCollisionGeometry: () => failNotImplemented('transformCollisionGeometry', settings),
      validatePlacement: () => failNotImplemented('validatePlacement', settings)
    })
  })

  static readonly Layer = Layer.effect(GeometryKernel, GeometryKernel.Make)
  static readonly Live = GeometryKernel.Layer.pipe(Layer.provide(GeometrySettings.Live))
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
  settings?: IrregularGeometrySettings
): Effect.Effect<never, IrregularNestingNotImplementedError> {
  const suffix =
    settings === undefined
      ? '.'
      : ` for ${settings.geometryBackendId}@${settings.geometryBackendVersion}.`
  return Effect.fail(
    new IrregularNestingNotImplementedError({
      service: 'GeometryKernel',
      operation,
      message: `GeometryKernel.${operation} is intentionally unimplemented${suffix}`
    })
  )
}
