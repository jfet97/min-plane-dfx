import { Data, Effect } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPreparedPiece } from '@shared/irregular/domain.js'
import { toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel } from '../../irregular/geometryKernel.js'
import type {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  IrregularNfpIfpControl,
  IrregularNfpIfpControlAbortError
} from '../../irregular/services.js'
import {
  exactDoubledPolygonAreaGrid2,
  intrinsicCapacityPreparedPieceId
} from './intrinsicCapacityMaterial.js'

/** Invalid or incomplete capacity accounting is an error, never a proof. */
export class IntrinsicCapacityError extends Data.TaggedError('IntrinsicCapacityError')<{
  readonly operation: string
  readonly message: string
}> {}

export interface IntrinsicCapacityPreflightMeasurements {
  readonly pieceCount: number
  readonly sheetWidthGrid: number
  readonly sheetHeightGrid: number
  /** Exact doubled canonical requested-sheet area in grid-squared units. */
  readonly sheetDoubledAreaGrid2: bigint
  /** Exact sum over pieces of the minimum valid doubled collision area. */
  readonly minimumDoubledCollisionAreaSumGrid2: bigint
  /** Prepared ids whose entire transform set cannot fit the sheet at q0 or q90. */
  readonly singletonInfeasiblePieceIds: ReadonlyArray<PieceId>
}

export type IntrinsicCapacityPreflightOutcome =
  | {
      readonly kind: 'proven_impossible'
      readonly reason: 'singleton-transform-set-does-not-fit'
      readonly pieceId: PieceId
      readonly measurements: IntrinsicCapacityPreflightMeasurements
    }
  | {
      readonly kind: 'proven_impossible'
      readonly reason: 'minimum-collision-area-exceeds-sheet-area'
      readonly measurements: IntrinsicCapacityPreflightMeasurements
    }
  | {
      readonly kind: 'inconclusive'
      readonly measurements: IntrinsicCapacityPreflightMeasurements
    }

/**
 * Proof-only capacity preflight. It can prove that complete packing is
 * impossible via exact necessary conditions; it can never claim feasibility.
 * The proofs use the exact canonical collision polygons: collision polygons
 * must stay pairwise disjoint inside the sheet, so their exact area sum and
 * each singleton q0/q90 span are sound necessary bounds without any waste
 * percentage, density factor, or safety allowance.
 */
export function preflightIntrinsicCompleteCapacity(
  sheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  control?: IrregularNfpIfpControl
): Effect.Effect<
  IntrinsicCapacityPreflightOutcome,
  | IntrinsicCapacityError
  | IrregularGeometryInputError
  | IrregularNestingNotImplementedError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel
> {
  return Effect.gen(function* () {
    const geometryKernel = yield* GeometryKernel
    const sheetWidthGrid = toGridMm(sheet.width)
    const sheetHeightGrid = toGridMm(sheet.height)
    if (
      sheetWidthGrid === undefined ||
      sheetHeightGrid === undefined ||
      sheetWidthGrid <= 0 ||
      sheetHeightGrid <= 0
    ) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'preflightSheet',
          message: `requested sheet ${sheet.width}x${sheet.height} has no exact positive canonical-grid area.`
        })
      )
    }
    const sheetDoubledAreaGrid2 = 2n * BigInt(sheetWidthGrid) * BigInt(sheetHeightGrid)

    let minimumDoubledCollisionAreaSumGrid2 = 0n
    const singletonInfeasiblePieceIds: PieceId[] = []
    for (const piece of pieces) {
      if (control !== undefined) yield* control.checkpoint('candidate-points')
      const pieceId = intrinsicCapacityPreparedPieceId(piece)
      if (piece.transforms.length === 0) {
        return yield* Effect.fail(
          new IntrinsicCapacityError({
            operation: 'preflightTransforms',
            message: `piece ${pieceId} has an empty transform set; capacity accounting is incomplete.`
          })
        )
      }
      let minimumDoubledAreaGrid2: bigint | undefined
      let singletonFits = false
      for (const transform of piece.transforms) {
        if (control !== undefined) yield* control.checkpoint('candidate-points')
        const moving = yield* geometryKernel.transformCollisionGeometry({
          geometry: piece.collisionGeometry,
          transform
        })
        const doubledAreaGrid2 = exactDoubledPolygonAreaGrid2(moving.polygon.points)
        const span = transformedGridSpan(moving.polygon.points)
        if (doubledAreaGrid2 === undefined || span === undefined) {
          return yield* Effect.fail(
            new IntrinsicCapacityError({
              operation: 'preflightTransformGeometry',
              message: `piece ${pieceId} transform ${transform.index} has no exact positive canonical collision polygon.`
            })
          )
        }
        if (minimumDoubledAreaGrid2 === undefined || doubledAreaGrid2 < minimumDoubledAreaGrid2) {
          minimumDoubledAreaGrid2 = doubledAreaGrid2
        }
        singletonFits ||=
          (span.width <= sheetWidthGrid && span.height <= sheetHeightGrid) ||
          (span.height <= sheetWidthGrid && span.width <= sheetHeightGrid)
      }
      if (minimumDoubledAreaGrid2 === undefined) {
        return yield* Effect.fail(
          new IntrinsicCapacityError({
            operation: 'preflightTransformAccounting',
            message: `piece ${pieceId} produced no valid transform measurement.`
          })
        )
      }
      minimumDoubledCollisionAreaSumGrid2 += minimumDoubledAreaGrid2
      if (!singletonFits) singletonInfeasiblePieceIds.push(pieceId)
    }

    const measurements: IntrinsicCapacityPreflightMeasurements = {
      pieceCount: pieces.length,
      sheetWidthGrid,
      sheetHeightGrid,
      sheetDoubledAreaGrid2,
      minimumDoubledCollisionAreaSumGrid2,
      singletonInfeasiblePieceIds
    }
    const firstSingletonInfeasiblePieceId = singletonInfeasiblePieceIds[0]
    if (firstSingletonInfeasiblePieceId !== undefined) {
      return {
        kind: 'proven_impossible',
        reason: 'singleton-transform-set-does-not-fit',
        pieceId: firstSingletonInfeasiblePieceId,
        measurements
      }
    }
    if (minimumDoubledCollisionAreaSumGrid2 > sheetDoubledAreaGrid2) {
      return {
        kind: 'proven_impossible',
        reason: 'minimum-collision-area-exceeds-sheet-area',
        measurements
      }
    }
    return { kind: 'inconclusive', measurements }
  })
}

/**
 * Exact canonical-grid span of one transformed collision polygon. A convex
 * polygon fits an axis-aligned sheet exactly when its grid span fits, because
 * grid-aligned translations preserve canonical coordinates exactly.
 */
function transformedGridSpan(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>
): { readonly width: number; readonly height: number } | undefined {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    const gridX = toGridMm(point.x)
    const gridY = toGridMm(point.y)
    if (gridX === undefined || gridY === undefined) return undefined
    minX = Math.min(minX, gridX)
    minY = Math.min(minY, gridY)
    maxX = Math.max(maxX, gridX)
    maxY = Math.max(maxY, gridY)
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return undefined
  return { width: maxX - minX, height: maxY - minY }
}
