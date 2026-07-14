import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  CLIPPER2_OFFSET_POLICY,
  fromGrid,
  toGridMm
} from '../../src/workers/irregular/clipper2OffsetPolicy.js'
import { Clipper2OffsetAdapter } from '../../src/workers/irregular/clipper2OffsetAdapter.js'
import { ConvexPolygonOffset } from '../../src/workers/irregular/convexPolygonOffset.js'
import { IrregularGeometryInputError } from '../../src/workers/irregular/services.js'
import { IrregularPoint, IrregularPolygon } from '@shared/irregular/domain.js'

/** Creates a domain point for a geometry fixture. */
function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

/** Creates a domain polygon from ordered, implicitly closed vertices. */
function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

/** Runs the adapter while preserving its typed success-or-failure result for assertions. */
function runAdapter(input: {
  readonly polygon: IrregularPolygon
  readonly distanceMm: number
}): Promise<IrregularPolygon | IrregularGeometryInputError> {
  return Effect.runPromise(
    Clipper2OffsetAdapter.compute(input).pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: (value) => value
      })
    )
  )
}

/** Runs the public offset boundary while preserving its typed result for assertions. */
function runOffset(
  input: IrregularPolygon,
  distanceMm: number
): Promise<IrregularPolygon | IrregularGeometryInputError> {
  return Effect.runPromise(
    ConvexPolygonOffset.compute(input, distanceMm).pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: (value) => value
      })
    )
  )
}

describe('Clipper2 offset adapter', () => {
  it('exposes the declared deterministic policy tuple', () => {
    expect(CLIPPER2_OFFSET_POLICY).toEqual({
      backendPackage: 'clipper2-ts',
      backendVersion: '2.0.1-18',
      adapterPathMode: 'integer Paths64 via inflatePaths',
      decimalPrecision: 3,
      scale: 1000,
      gridStepMm: 0.001,
      rounding: 'nearest grid point, ties away from zero',
      conservativeOffsetAllowanceMm: 0.002,
      joinType: 'Miter',
      miterLimit: 2,
      endType: 'Polygon',
      futureRoundJoinArcToleranceMm: 0.01,
      fillRule: 'NonZero',
      winding: 'counter-clockwise',
      maxScaledCoordinate: 1_000_000_000,
      adapterPolicyVersion: 'clipper2-offset-v2'
    })
  })

  it('rounds grid ties away from zero and dequantizes without another round', () => {
    expect(toGridMm(1.2344)).toBe(1234)
    expect(toGridMm(1.2345)).toBe(1235)
    expect(toGridMm(-1.2345)).toBe(-1235)
    expect(fromGrid(-1235)).toBe(-1.235)
  })

  it('normalizes the adapter result to a stable counter-clockwise collision ring', async () => {
    const result = await runAdapter({
      polygon: polygon([point(0, 0), point(4, 0), point(4, 3), point(0, 3)]),
      distanceMm: 1.5
    })

    expect(result).toEqual(
      polygon([
        point(-1.502, -1.502),
        point(5.502, -1.502),
        point(5.502, 4.502),
        point(-1.502, 4.502)
      ])
    )
  })

  it('keeps the public boundary winding for a clockwise source polygon', async () => {
    const result = await runOffset(
      polygon([point(0, 0), point(0, 3), point(4, 3), point(4, 0)]),
      1.5
    )

    expect(result).toEqual(
      polygon([
        point(-1.502, -1.502),
        point(-1.502, 4.502),
        point(5.502, 4.502),
        point(5.502, -1.502)
      ])
    )
  })

  it('uses the miter limit instead of emitting an unbounded acute corner spike', async () => {
    const result = await runAdapter({
      polygon: polygon([point(0, 0), point(4, 0), point(0, 3)]),
      distanceMm: 1.5
    })

    expect(result).toEqual(
      polygon([
        point(-1.502, -1.502),
        point(5.083, -1.502),
        point(5.767, 0.552),
        point(0.159, 4.759),
        point(-1.502, 3.928)
      ])
    )
  })

  it('keeps the requested real-valued envelope after nearest-grid conversion', async () => {
    const widthMm = 1.00049
    const requestedOffsetMm = 0.25049
    const result = await runAdapter({
      polygon: polygon([
        point(0, 0),
        point(widthMm, 0),
        point(widthMm, 1),
        point(0, 1)
      ]),
      distanceMm: requestedOffsetMm
    })

    expect(result).not.toBeInstanceOf(IrregularGeometryInputError)
    if (result instanceof IrregularGeometryInputError) return

    expect(Math.max(...result.points.map((point) => point.x))).toBeGreaterThanOrEqual(
      widthMm + requestedOffsetMm
    )
  })

  it('rejects a polygon that collapses during 0.001 millimeter quantization', async () => {
    const result = await runAdapter({
      polygon: polygon([point(0, 0), point(0.0004, 0), point(0, 1)]),
      distanceMm: 0
    })

    expect(result).toBeInstanceOf(IrregularGeometryInputError)
    expect(result).toMatchObject({
      operation: 'offsetConvexPolygon',
      message: 'quantized input must contain at least three unique vertices.'
    })
  })

  it('rejects coordinates without enough scaled headroom for twice the offset', async () => {
    const result = await runAdapter({
      polygon: polygon([point(999990, 0), point(999999, 0), point(999999, 10), point(999990, 10)]),
      distanceMm: 1
    })

    expect(result).toBeInstanceOf(IrregularGeometryInputError)
    expect(result).toMatchObject({
      operation: 'offsetConvexPolygon',
      message:
        'polygon coordinates plus twice the scaled offset exceed the Clipper2 coordinate guard.'
    })
  })

  it('rejects non-convex input through the robust predicate precondition', async () => {
    const result = await runOffset(
      polygon([point(0, 0), point(4, 0), point(2, 1), point(4, 3), point(0, 3)]),
      1
    )

    expect(result).toBeInstanceOf(IrregularGeometryInputError)
    expect(result).toMatchObject({
      operation: 'offsetConvexPolygon',
      message: 'polygon must be strictly convex with one consistent winding.'
    })
  })
})
