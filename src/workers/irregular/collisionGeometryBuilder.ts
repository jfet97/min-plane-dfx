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

        // translating by the hull minimum gives every piece one stable local placement reference
        const normalizedHull = yield* normalizeHull(input.piece, sourceHull)

        // GeometryKernel owns the configured safety margin and derives the final offset distance
        const collisionPolygon = yield* geometryKernel.offsetConvexPolygon({
          polygon: normalizedHull.convexHull,
          totalPaddingMm: input.totalPaddingMm
        })

        return new CollisionGeometry({
          sourcePieceId: input.piece.id,
          sourceBounds: normalizedHull.sourceBounds,
          sampledPoints: flattened.sampledPoints,
          convexHull: normalizedHull.convexHull,
          collisionPolygon,
          placementReference: normalizedHull.placementReference,
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
 * Computes the source hull bounds and expresses the hull in a local coordinate
 * system whose origin is its lower-left bound corner.
 *
 * The returned `placementReference` is that original source coordinate. A
 * future placement at `(x, y)` can therefore render the source outline by
 * translating it from `placementReference` to `(x, y)`, while collision and
 * transform calculations use the smaller local coordinates.
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

  const placementReference = new IrregularPoint({ x: minX, y: minY })
  return Effect.succeed({
    sourceBounds: new IrregularBounds({ minX, minY, maxX, maxY }),
    convexHull: new IrregularPolygon({
      points: sourceHull.points.map(
        (point) => new IrregularPoint({ x: point.x - minX, y: point.y - minY })
      )
    }),
    placementReference
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
