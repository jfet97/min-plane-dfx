import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularGeometrySettings,
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

function collisionGeometry(
  points: ReadonlyArray<IrregularPoint>,
  placementReference: IrregularPoint = point(0, 0)
): CollisionGeometry {
  return new CollisionGeometry({
    sourcePieceId: PieceId.make('transform-test-piece'),
    sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
    sampledPoints: [point(0, 0), point(10, 0), point(10, 10), point(0, 10)],
    convexHull: polygon([point(0, 0), point(10, 0), point(10, 10), point(0, 10)]),
    collisionPolygon: polygon(points),
    placementReference,
    diagnostics: []
  })
}

function settings(
  overrides: {
    readonly intrinsicSharedArchiveEnabled?: boolean
    readonly placementPolicyId?: IrregularOptimizerSettings['placementPolicyId']
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
    intrinsicSharedArchiveEnabled: overrides.intrinsicSharedArchiveEnabled ?? false,
    ...(overrides.placementPolicyId === undefined
      ? {}
      : { placementPolicyId: overrides.placementPolicyId }),
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
    readonly flatteningSagToleranceMm?: number
    readonly placementReference?: IrregularPoint
    readonly settings?: IrregularOptimizerSettings
  } = {}
) {
  const flatteningSagToleranceMm = options.flatteningSagToleranceMm ?? 0.25
  return Effect.runPromise(
    TransformGenerator.use((service) =>
      service.generateTransforms({
        geometry: collisionGeometry(points, options.placementReference),
        allowRotation: options.allowRotation ?? true,
        allowMirror: options.allowMirror ?? false,
        geometrySettings: new IrregularGeometrySettings({
          flatteningSagToleranceMm,
          clearanceSafetyMarginMm: flatteningSagToleranceMm,
          geometryBackendId: 'transform-test',
          geometryBackendVersion: '0'
        }),
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

  it('keeps exact derived edge angles ahead of configured approximations under the cap', async () => {
    const candidates = await generate(
      [point(0, 0), point(4, 0), point(3, 2), point(1, 3)],
      {
        allowMirror: true,
        settings: settings({ transformCap: 6, configuredRotationDeg: [12.5] })
      }
    )

    expect(candidates.slice(4).every(({ reason }) => reason === 'edge_alignment')).toBe(true)
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

  it('scales Compact edge and angle tolerances with the collision polygon and sag', async () => {
    const base = [point(0, 0), point(12, 0), point(10, 5), point(1, 7)]
    const compactSettings = settings({
      intrinsicSharedArchiveEnabled: true,
      transformMinimumEdgeLengthMm: 100,
      transformAngleDeduplicationToleranceDeg: 10
    })

    const transforms = await Promise.all(
      [0.1, 1, 10].map((scale) =>
        generate(
          base.map(({ x, y }) => point(x * scale, y * scale)),
          {
            flatteningSagToleranceMm: 0.25 * scale,
            settings: compactSettings
          }
        )
      )
    )

    const identities = transforms.map((candidates) =>
      candidates.map(({ rotationDeg, mirrored, reason }) => ({
        rotationDeg: Number(rotationDeg.toFixed(9)),
        mirrored,
        reason
      }))
    )
    expect(identities[1]).toEqual(identities[0])
    expect(identities[2]).toEqual(identities[0])
  })

  it('keeps large-radius angles distinct when merging them would exceed curve sag', async () => {
    const candidates = await generate(
      [point(0, 0), point(1000, 0), point(1000, 1000), point(0, 1000)],
      {
        flatteningSagToleranceMm: 0.25,
        settings: settings({
          intrinsicSharedArchiveEnabled: true,
          configuredRotationDeg: [10, 10.04]
        })
      }
    )

    expect(
      candidates
        .filter(({ reason }) => reason === 'configured')
        .map(({ rotationDeg }) => rotationDeg)
    ).toEqual([10, 10.04])
  })

  it('keeps adaptive transforms invariant when the source-space placement reference moves', async () => {
    const boundary = [point(0, 0), point(1000, 0), point(1000, 1000), point(0, 1000)]
    const compactSettings = settings({
      intrinsicSharedArchiveEnabled: true,
      configuredRotationDeg: [10, 10.04]
    })
    const origin = await generate(boundary, {
      placementReference: point(0, 0),
      settings: compactSettings
    })
    const translatedSource = await generate(boundary, {
      placementReference: point(1_000_000, -2_000_000),
      settings: compactSettings
    })

    expect(translatedSource).toEqual(origin)
  })

  it('retains a short but scale-meaningful Compact edge', async () => {
    const candidates = await generate([point(0, 0), point(0.5, 0.5), point(4, 0.5)], {
      settings: settings({
        intrinsicSharedArchiveEnabled: true,
        transformMinimumEdgeLengthMm: 1.2
      })
    })

    expect(candidates.some(({ rotationDeg }) => Math.abs(rotationDeg - 315) < 1e-12)).toBe(true)
  })

  it('keeps persisted thresholds when an archive-requested profile is not Compact-eligible', async () => {
    const candidates = await generate([point(0, 0), point(0.5, 0.5), point(4, 0.5)], {
      settings: settings({
        intrinsicSharedArchiveEnabled: true,
        placementPolicyId: 'short-side-fill',
        transformMinimumEdgeLengthMm: 1.2
      })
    })

    expect(candidates.some(({ rotationDeg }) => Math.abs(rotationDeg - 315) < 1e-12)).toBe(false)
  })

  it('uses the longer near-angle edge as the capped Compact representative', async () => {
    const degreesToRadians = Math.PI / 180
    const edgeVectors = [
      { length: 10, directionDeg: -10.04 },
      { length: 1, directionDeg: -10 },
      { length: 5.590984394749958, directionDeg: 120 },
      { length: 8.551922421444505, directionDeg: 200 }
    ]
    const rawPoints = [{ x: 0, y: 0 }]
    for (const edge of edgeVectors.slice(0, -1)) {
      const previous = rawPoints.at(-1)
      if (previous === undefined) throw new Error('expected polygon construction point')
      rawPoints.push({
        x: previous.x + edge.length * Math.cos(edge.directionDeg * degreesToRadians),
        y: previous.y + edge.length * Math.sin(edge.directionDeg * degreesToRadians)
      })
    }
    const minX = Math.min(...rawPoints.map(({ x }) => x))
    const minY = Math.min(...rawPoints.map(({ y }) => y))
    const candidates = await generate(
      rawPoints.map(({ x, y }) => point(x - minX, y - minY)),
      {
        settings: settings({
          intrinsicSharedArchiveEnabled: true,
          transformCap: 5,
          configuredRotationDeg: [20]
        })
      }
    )

    expect(candidates).toHaveLength(5)
    expect(candidates.at(-1)?.reason).toBe('edge_alignment')
    expect(candidates.at(-1)?.rotationDeg).toBeCloseTo(10.04, 12)
    expect(candidates.some(({ rotationDeg }) => rotationDeg === 10)).toBe(false)
    expect(candidates.some(({ rotationDeg }) => rotationDeg === 20)).toBe(false)
  })

  it('deduplicates Compact angles across the circular zero-degree seam', async () => {
    const candidates = await generate([point(0, 0), point(10, 0), point(10, 10), point(0, 10)], {
      settings: settings({
        intrinsicSharedArchiveEnabled: true,
        configuredRotationDeg: [359.98, 0.02]
      })
    })

    expect(candidates.filter(({ reason }) => reason === 'configured')).toEqual([])
    expect(candidates.filter(({ rotationDeg }) => rotationDeg === 0)).toHaveLength(1)
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
