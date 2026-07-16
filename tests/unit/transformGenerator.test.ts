import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularOptimizerSettings,
  IrregularPoint,
  IrregularPolygon
} from '@shared/irregular/domain.js'
import {
  makeDerivedOrientationIrregularOptimizerSettings,
  makeFastIdentityIrregularOptimizerSettings,
  makeOrthogonalIrregularOptimizerSettings
} from '@shared/irregular/defaults.js'
import { PieceId } from '@shared/domain/ids.js'
import {
  IrregularGeometryInputError,
  TransformGenerator
} from '../../src/workers/irregular/services.js'
import { TransformCollisionGeometry } from '../../src/workers/irregular/transformCollisionGeometry.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

function collisionGeometry(points: ReadonlyArray<IrregularPoint>): CollisionGeometry {
  return new CollisionGeometry({
    sourcePieceId: PieceId.make('transform-test-piece'),
    sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
    sampledPoints: [point(0, 0), point(10, 0), point(10, 10), point(0, 10)],
    convexHull: polygon([point(0, 0), point(10, 0), point(10, 10), point(0, 10)]),
    collisionPolygon: polygon(points),
    placementReference: point(0, 0),
    diagnostics: []
  })
}

function settings(
  overrides: {
    readonly transformCap?: number
    readonly transformMinimumEdgeLengthMm?: number
    readonly transformAngleDeduplicationToleranceDeg?: number
    readonly configuredRotationEnabled?: boolean
    readonly configuredRotationDeg?: ReadonlyArray<number>
    readonly edgeAlignmentEnabled?: boolean
  } = {}
): IrregularOptimizerSettings {
  return new IrregularOptimizerSettings({
    orderWindow: 2,
    beamWidth: 8,
    transformCap: overrides.transformCap ?? 16,
    transformMinimumEdgeLengthMm: overrides.transformMinimumEdgeLengthMm ?? 1,
    transformAngleDeduplicationToleranceDeg:
      overrides.transformAngleDeduplicationToleranceDeg ?? 0.01,
    configuredRotationEnabled: overrides.configuredRotationEnabled ?? true,
    configuredRotationDeg: overrides.configuredRotationDeg ?? [],
    edgeAlignmentEnabled: overrides.edgeAlignmentEnabled ?? true,
    gaPopulation: 8,
    gaTimeBudgetMs: 1000,
    gaSeed: 'transform-test'
  })
}

function generate(
  points: ReadonlyArray<IrregularPoint>,
  options: {
    readonly allowRotation?: boolean
    readonly allowMirror?: boolean
    readonly settings?: IrregularOptimizerSettings
  } = {}
) {
  return Effect.runPromise(
    TransformGenerator.use((service) =>
      service.generateTransforms({
        geometry: collisionGeometry(points),
        allowRotation: options.allowRotation ?? true,
        allowMirror: options.allowMirror ?? false,
        settings: options.settings ?? settings()
      })
    ).pipe(Effect.provide(TransformGeneratorLive))
  )
}

describe('TransformGenerator.Live', () => {
  it('emits only the zero-degree orientation when rotation is disabled', async () => {
    const candidates = await generate([point(0, 0), point(4, 0), point(4, 4), point(0, 4)], {
      allowRotation: false
    })

    expect(candidates.map(({ rotationDeg }) => rotationDeg)).toEqual([0])
  })

  it('returns the four orthogonal baseline choices for a square', async () => {
    const candidates = await generate([point(0, 0), point(4, 0), point(4, 4), point(0, 4)])

    expect(candidates.map(({ rotationDeg }) => rotationDeg)).toEqual([0, 90, 180, 270])
    expect(candidates.every(({ reason }) => reason === 'orthogonal')).toBe(true)
  })

  it('appends mirrors after unmirrored choices and caps the combined list', async () => {
    const square = [point(0, 0), point(4, 0), point(4, 4), point(0, 4)]
    const candidates = await generate(square, {
      allowMirror: true,
      settings: settings({ transformCap: 6 })
    })

    expect(candidates.map(({ mirrored }) => mirrored)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true
    ])
    expect(candidates.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('reserves mirror capacity after the orthogonal baseline', async () => {
    const candidates = await generate(
      [point(0, 0), point(4, 0), point(3, 2), point(1, 3)],
      { allowMirror: true, settings: settings({ transformCap: 6 }) }
    )

    expect(candidates).toHaveLength(6)
    expect(candidates.slice(0, 4).map(({ rotationDeg, mirrored }) => [rotationDeg, mirrored])).toEqual([
      [0, false],
      [90, false],
      [180, false],
      [270, false]
    ])
    expect(candidates.some(({ mirrored }) => mirrored)).toBe(true)
  })

  it('keeps configured angles ahead of derived edge noise under the cap', async () => {
    const candidates = await generate(
      [point(0, 0), point(4, 0), point(3, 2), point(1, 3)],
      {
        allowMirror: true,
        settings: settings({ transformCap: 6, configuredRotationDeg: [12.5] })
      }
    )

    expect(candidates.slice(4).every(({ reason }) => reason === 'configured')).toBe(true)
  })

  it('can disable explicit configured angles without disabling the baseline rotations', async () => {
    const candidates = await generate([point(0, 0), point(4, 0), point(4, 4), point(0, 4)], {
      settings: settings({
        configuredRotationEnabled: false,
        configuredRotationDeg: [12.5]
      })
    })

    expect(candidates.map(({ rotationDeg }) => rotationDeg)).toEqual([0, 90, 180, 270])
  })

  it('can disable edge-derived angles without disabling configured angles', async () => {
    const candidates = await generate([point(0, 0), point(3, 3), point(0, 1)], {
      settings: settings({
        configuredRotationDeg: [12.5],
        edgeAlignmentEnabled: false
      })
    })

    expect(candidates.some(({ reason, rotationDeg }) => reason === 'configured' && rotationDeg === 12.5)).toBe(
      true
    )
    expect(candidates.some(({ reason }) => reason === 'edge_alignment')).toBe(false)
  })

  it('keeps the fast identity profile to one source-free identity choice', async () => {
    const candidates = await generate([point(0, 0), point(3, 3), point(0, 1)], {
      allowMirror: true,
      settings: makeFastIdentityIrregularOptimizerSettings({ configuredRotationDeg: [12.5] })
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      rotationDeg: 0,
      mirrored: false,
      reason: 'orthogonal'
    })
  })

  it('keeps the orthogonal profile to four unmirrored orthogonal choices', async () => {
    const candidates = await generate([point(0, 0), point(3, 3), point(0, 1)], {
      allowMirror: true,
      settings: makeOrthogonalIrregularOptimizerSettings({ configuredRotationDeg: [12.5] })
    })

    expect(candidates.map(({ rotationDeg }) => rotationDeg)).toEqual([0, 90, 180, 270])
    expect(candidates.every(({ mirrored, reason }) => !mirrored && reason === 'orthogonal')).toBe(true)
  })

  it('includes configured and edge-derived angles in the derived orientation profile', async () => {
    const candidates = await generate([point(0, 0), point(3, 3), point(0, 1)], {
      allowMirror: false,
      settings: makeDerivedOrientationIrregularOptimizerSettings({ configuredRotationDeg: [12.5] })
    })

    expect(candidates.some(({ reason, rotationDeg }) => reason === 'configured' && rotationDeg === 12.5)).toBe(
      true
    )
    expect(candidates.some(({ reason, rotationDeg }) => reason === 'edge_alignment' && rotationDeg === 315)).toBe(
      true
    )
    expect(candidates.every(({ mirrored }) => !mirrored)).toBe(true)
  })

  it('does not let mirror variants bypass the transform cap', async () => {
    const candidates = await generate([point(0, 0), point(4, 0), point(4, 4), point(0, 4)], {
      allowMirror: true,
      settings: settings({ transformCap: 3 })
    })

    expect(candidates).toHaveLength(3)
    expect(candidates.every(({ mirrored }) => !mirrored)).toBe(true)
  })

  it('adds a stable non-orthogonal alignment for a diagonal long edge', async () => {
    const candidates = await generate([point(0, 0), point(3, 3), point(0, 1)])

    expect(candidates.some(({ rotationDeg }) => Math.abs(rotationDeg - 315) < 1e-12)).toBe(true)
    expect(candidates.find(({ rotationDeg }) => Math.abs(rotationDeg - 315) < 1e-12)?.reason).toBe(
      'edge_alignment'
    )
  })

  it('derives a mirrored diagonal alignment that makes the mirrored edge horizontal', async () => {
    const diagonal = [point(0, 0), point(3, 3), point(0, 1)]
    const candidates = await generate(diagonal, { allowMirror: true })
    const mirrored = candidates.find(
      ({ mirrored: isMirrored, reason, rotationDeg }) =>
        isMirrored && reason === 'edge_alignment' && rotationDeg === 225
    )

    expect(mirrored?.rotationDeg).toBe(225)
    if (mirrored === undefined) throw new Error('expected mirrored diagonal edge alignment')

    const transformed = await Effect.runPromise(
      TransformCollisionGeometry.compute({
        geometry: collisionGeometry(diagonal),
        transform: mirrored
      })
    )
    const first = transformed.polygon.points[0]
    const second = transformed.polygon.points[1]
    if (first === undefined || second === undefined) throw new Error('expected transformed edge')
    expect(Math.abs(first.y - second.y)).toBeLessThan(1e-12)
  })

  it('ignores a short edge below the configured usable length', async () => {
    const candidates = await generate([point(0, 0), point(0.5, 0.5), point(4, 0.5)], {
      settings: settings({ transformMinimumEdgeLengthMm: 1 })
    })

    expect(candidates.some(({ rotationDeg }) => Math.abs(rotationDeg - 315) < 1e-12)).toBe(false)
  })

  it('normalizes periodic configured angles and keeps the lower duplicate', async () => {
    const candidates = await generate([point(0, 0), point(4, 0), point(4, 4), point(0, 4)], {
      settings: settings({
        configuredRotationDeg: [45, 405, -315, 44.996, 45.004, -0.004, 359.996]
      })
    })

    const configured = candidates.filter(({ reason }) => reason === 'configured')
    expect(configured.map(({ rotationDeg }) => rotationDeg)).toEqual([44.996])
    expect(candidates.map(({ rotationDeg }) => rotationDeg)).toEqual([0, 90, 180, 270, 44.996])
  })

  it('does not emit a redundant oriented-bounds source for convex polygons', async () => {
    const candidates = await generate([point(0, 0), point(4, 0), point(3, 2), point(1, 3)])

    expect(candidates.map(({ reason }) => String(reason))).not.toContain('oriented_bounds')
    expect(candidates.some(({ reason }) => reason === 'edge_alignment')).toBe(true)
  })

  it('produces the same candidates for cyclically rotated input vertices', async () => {
    const first = await generate([point(0, 0), point(6, 0), point(6, 2), point(0, 2)])
    const rotated = await generate([point(6, 2), point(0, 2), point(0, 0), point(6, 0)])

    expect(rotated).toEqual(first)
  })

  it('rejects invalid polygon geometry with a typed error', async () => {
    const failure = await generate([point(0, 0), point(4, 0), point(2, 1), point(0, 4)]).catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
  })
})
