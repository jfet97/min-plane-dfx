import { Context, Effect, Layer } from 'effect'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import {
  CollisionGeometry,
  CollisionGeometryDiagnostic,
  IrregularBounds,
  IrregularPoint,
  IrregularPolygon
} from '@shared/irregular/domain.js'
import type { BuildCollisionGeometryInput } from './services.js'
import {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError
} from './services.js'
import { GeometryKernel } from './geometryKernel.js'

type CollisionGeometryBuilderError =
  | IrregularGeometryInputError
  | IrregularNestingNotImplementedError

interface NormalizedHull {
  readonly sourceBounds: IrregularBounds
  readonly convexHull: IrregularPolygon
}

interface NormalizedCollisionGeometry {
  readonly convexHull: IrregularPolygon
  readonly collisionPolygon: IrregularPolygon
  readonly placementReference: IrregularPoint
}

export namespace CollisionGeometryBuilder {
  export interface Service {
    /**
     * Builds the deterministic collision artifact for one imported closed
     * source outline. Transform choices are generated later by
     * `TransformGenerator`.
     */
    readonly buildPiece: (
      input: BuildCollisionGeometryInput
    ) => Effect.Effect<CollisionGeometry, CollisionGeometryBuilderError>
    /**
     * Builds collision artifacts in the same order as the supplied imported
     * pieces.
     */
    readonly buildPieces: (
      input: ReadonlyArray<BuildCollisionGeometryInput>
    ) => Effect.Effect<ReadonlyArray<CollisionGeometry>, CollisionGeometryBuilderError>
  }
}

export class CollisionGeometryBuilder extends Context.Service<
  CollisionGeometryBuilder,
  CollisionGeometryBuilder.Service
>()('min-plane-dfx/irregular/CollisionGeometryBuilder') {
  static readonly Make = Effect.gen(function* () {
    const geometryKernel = yield* GeometryKernel

    const buildPiece = (input: BuildCollisionGeometryInput) =>
      Effect.gen(function* () {
        // an open path has no enclosed material, so it cannot safely define a collision area
        if (!input.piece.geometry.closed) {
          return yield* failInvalidSourceGeometry(
            input.piece,
            'source geometry must be a closed outline before collision geometry can be built.'
          )
        }

        // flattening keeps the original source coordinates for debug and export traceability
        const flattened = yield* geometryKernel.flattenSourceGeometry({ piece: input.piece })

        // the hull removes concave detail conservatively before placement geometry is created
        const sourceHull = yield* geometryKernel.convexHull(flattened.sampledPoints)

        // translate source coordinates before offsetting so the offset math stays near the local origin
        const normalizedHull = yield* normalizeHull(input.piece, sourceHull)

        // GeometryKernel owns the configured safety margin and derives the final offset distance
        const collisionPolygon = yield* geometryKernel.offsetConvexPolygon({
          polygon: normalizedHull.convexHull,
          totalPaddingMm: input.totalPaddingMm
        })

        // the collision bounds minimum is the placement origin used by NFPs, IFPs, and placements
        const normalizedCollision = yield* normalizeCollisionGeometry(
          input.piece,
          normalizedHull,
          collisionPolygon
        )

        return new CollisionGeometry({
          sourcePieceId: input.piece.id,
          sourceBounds: normalizedHull.sourceBounds,
          sampledPoints: flattened.sampledPoints,
          convexHull: normalizedCollision.convexHull,
          collisionPolygon: normalizedCollision.collisionPolygon,
          placementReference: normalizedCollision.placementReference,
          diagnostics: [...flattened.diagnostics, ...importWarningDiagnostics(input.piece)]
        })
      })

    return CollisionGeometryBuilder.of({
      buildPiece,
      buildPieces: (inputs) => Effect.forEach(inputs, buildPiece, { concurrency: 1 })
    })
  })

  static readonly Layer = Layer.effect(CollisionGeometryBuilder, CollisionGeometryBuilder.Make)
  static readonly Live = CollisionGeometryBuilder.Layer.pipe(
    Layer.provideMerge(GeometryKernel.Live)
  )
  static readonly Unimplemented = Layer.succeed(
    CollisionGeometryBuilder,
    CollisionGeometryBuilder.of({
      buildPiece: () => failNotImplemented('buildPiece'),
      buildPieces: () => failNotImplemented('buildPieces')
    })
  )
}

/**
 * Computes source hull bounds and expresses the hull relative to its own bounds
 * minimum so the subsequent offset calculation uses small local coordinates.
 *
 * This is only an intermediate coordinate system. The public placement origin
 * is chosen later from the padded collision polygon bounds, as required by the
 * engine-wide placement convention.
 */
function normalizeHull(
  piece: ImportedPiece,
  sourceHull: IrregularPolygon
): Effect.Effect<NormalizedHull, IrregularGeometryInputError> {
  if (sourceHull.points.length < 3) {
    return failInvalidSourceGeometry(
      piece,
      'source geometry must contain at least three non-collinear points.'
    )
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const point of sourceHull.points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return failInvalidSourceGeometry(piece, 'source geometry points must have finite coordinates.')
    }

    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  return Effect.succeed({
    sourceBounds: new IrregularBounds({ minX, minY, maxX, maxY }),
    convexHull: new IrregularPolygon({
      points: sourceHull.points.map(
        (point) => new IrregularPoint({ x: point.x - minX, y: point.y - minY })
      )
    })
  })
}

/**
 * Re-bases the hull and collision polygon to the collision polygon's lower-left
 * bound corner, which is the single placement point convention for v2.
 *
 * The same translation is applied to both polygons so their overlap remains
 * exact. The source-space placement reference records that padded bound corner
 * before rebasing; it may lie outside cut material because padding is included.
 */
function normalizeCollisionGeometry(
  piece: ImportedPiece,
  normalizedHull: NormalizedHull,
  collisionPolygon: IrregularPolygon
): Effect.Effect<NormalizedCollisionGeometry, IrregularGeometryInputError> {
  const collisionBounds = boundsForPolygon(collisionPolygon)
  if (collisionBounds === undefined) {
    return failInvalidSourceGeometry(piece, 'collision polygon must contain at least one finite vertex.')
  }

  const translateX = -collisionBounds.minX
  const translateY = -collisionBounds.minY
  return Effect.succeed({
    convexHull: translatePolygon(normalizedHull.convexHull, translateX, translateY),
    collisionPolygon: translatePolygon(collisionPolygon, translateX, translateY),
    placementReference: new IrregularPoint({
      x: normalizedHull.sourceBounds.minX + collisionBounds.minX,
      y: normalizedHull.sourceBounds.minY + collisionBounds.minY
    })
  })
}

function boundsForPolygon(polygon: IrregularPolygon): IrregularBounds | undefined {
  const firstPoint = polygon.points[0]
  if (firstPoint === undefined || !Number.isFinite(firstPoint.x) || !Number.isFinite(firstPoint.y)) {
    return undefined
  }

  let minX = firstPoint.x
  let minY = firstPoint.y
  let maxX = firstPoint.x
  let maxY = firstPoint.y
  for (const point of polygon.points.slice(1)) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  return new IrregularBounds({ minX, minY, maxX, maxY })
}

function translatePolygon(
  polygon: IrregularPolygon,
  translateX: number,
  translateY: number
): IrregularPolygon {
  return new IrregularPolygon({
    points: polygon.points.map(
      (point) => new IrregularPoint({ x: point.x + translateX, y: point.y + translateY })
    )
  })
}

function importWarningDiagnostics(piece: ImportedPiece): ReadonlyArray<CollisionGeometryDiagnostic> {
  return piece.warnings.map(
    (warning) =>
      new CollisionGeometryDiagnostic({
        code: warning.code,
        message: warning.message,
        pieceId: piece.id
      })
  )
}

function failInvalidSourceGeometry(
  piece: ImportedPiece,
  message: string
): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(new IrregularGeometryInputError({
    operation: 'buildCollisionGeometry',
    message: `${piece.id}: ${message}`
  }))
}

function failNotImplemented(
  operation: string
): Effect.Effect<never, IrregularNestingNotImplementedError> {
  return Effect.fail(new IrregularNestingNotImplementedError({
    service: 'CollisionGeometryBuilder',
    operation,
    message: `CollisionGeometryBuilder.${operation} is intentionally unimplemented.`
  }))
}
