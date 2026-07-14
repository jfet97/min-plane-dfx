import { Exit, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  IrregularBounds,
  IrregularGeometrySettings,
  IrregularOptimizerSettings,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'

/** Decodes an unknown value through one schema without constructing invalid classes directly. */
function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) {
  return Schema.decodeUnknownExit(schema)(input)
}

describe('irregular schema contracts', () => {
  it('requires finite coordinates and ordered bounds', () => {
    expect(Exit.isSuccess(decode(IrregularPoint, { x: -2.5, y: 4 }))).toBe(true)
    expect(Exit.isFailure(decode(IrregularPoint, { x: Number.NaN, y: 4 }))).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularBounds, { minX: 4, minY: 0, maxX: 3, maxY: 10 })
      )
    ).toBe(true)
  })

  it('requires finite indexed transform candidates and preserves periodic angles', () => {
    expect(
      Exit.isSuccess(
        decode(IrregularTransformCandidate, {
          index: 0,
          rotationDeg: 450,
          mirrored: false,
          reason: 'orthogonal'
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularTransformCandidate, {
          index: 1.5,
          rotationDeg: 90,
          mirrored: false,
          reason: 'orthogonal'
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularTransformCandidate, {
          index: 0,
          rotationDeg: Number.POSITIVE_INFINITY,
          mirrored: false,
          reason: 'orthogonal'
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularTransformCandidate, {
          index: 0,
          rotationDeg: 90,
          mirrored: false,
          reason: 'unsupported'
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularTransformCandidate, {
          index: 0,
          rotationDeg: 0,
          mirrored: false,
          reason: 'oriented_bounds'
        })
      )
    ).toBe(true)
  })

  it('requires conservative geometry settings', () => {
    const valid = {
      flatteningSagToleranceMm: 0.25,
      clearanceSafetyMarginMm: 0.25,
      geometryBackendId: 'test-backend',
      geometryBackendVersion: '1'
    }

    expect(Exit.isSuccess(decode(IrregularGeometrySettings, valid))).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularGeometrySettings, {
          ...valid,
          flatteningSagToleranceMm: 0
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularGeometrySettings, {
          ...valid,
          clearanceSafetyMarginMm: 0.1
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularGeometrySettings, {
          ...valid,
          geometryBackendVersion: ''
        })
      )
    ).toBe(true)
  })

  it('requires positive integer optimizer controls', () => {
    const valid = {
      orderWindow: 2,
      beamWidth: 24,
      transformCap: 16,
      gaPopulation: 32,
      gaTimeBudgetMs: 60_000,
      gaSeed: 'test-seed'
    }

    expect(Exit.isSuccess(decode(IrregularOptimizerSettings, valid))).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularOptimizerSettings, { ...valid, orderWindow: 0 })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularOptimizerSettings, { ...valid, gaTimeBudgetMs: 1.5 })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularOptimizerSettings, { ...valid, gaSeed: '' })
      )
    ).toBe(true)
  })

  it('keeps polygon vertices schema-backed as finite points', () => {
    expect(
      Exit.isSuccess(
        decode(IrregularPolygon, {
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 0, y: 3 }
          ]
        })
      )
    ).toBe(true)
    expect(
      Exit.isFailure(
        decode(IrregularPolygon, {
          points: [
            { x: 0, y: 0 },
            { x: Number.NEGATIVE_INFINITY, y: 0 },
            { x: 0, y: 3 }
          ]
        })
      )
    ).toBe(true)
  })
})
