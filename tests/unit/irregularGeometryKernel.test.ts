import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { IrregularNestingNotImplementedError } from '../../src/workers/irregular/services.js'
import { IrregularGeometrySettings } from '@shared/irregular/domain.js'

describe('GeometryKernel', () => {
  it('captures geometry settings from the provided settings service', async () => {
    const settings = new IrregularGeometrySettings({
      flatteningSagToleranceMm: 0.125,
      clearanceSafetyMarginMm: 0.25,
      convexHullSimplificationToleranceMm: 0,
      geometryBackendId: 'test-geometry-backend',
      geometryBackendVersion: 'settings-proof'
    })

    const failure = await Effect.runPromise(
      GeometryKernel.use((kernel) => kernel.convexHull([])).pipe(
        Effect.match({
          onFailure: (err) => err,
          onSuccess: () => null
        }),
        Effect.provide(GeometryKernel.Layer),
        Effect.provide(Layer.succeed(GeometrySettings, settings))
      )
    )

    expect(failure).toBeInstanceOf(IrregularNestingNotImplementedError)
    expect(failure?.message).toContain('test-geometry-backend@settings-proof')
  })

  it('keeps Unimplemented independent from geometry settings', async () => {
    const failure = await Effect.runPromise(
      GeometryKernel.use((kernel) => kernel.convexHull([])).pipe(
        Effect.match({
          onFailure: (err) => err,
          onSuccess: () => null
        }),
        Effect.provide(GeometryKernel.Unimplemented)
      )
    )

    expect(failure).toBeInstanceOf(IrregularNestingNotImplementedError)
    expect(failure?.message).toBe('GeometryKernel.convexHull is intentionally unimplemented.')
  })
})
