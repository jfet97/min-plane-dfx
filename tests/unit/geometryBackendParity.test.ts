import { Effect } from 'effect'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importDxfFile } from '@main/services/DxfImportService.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import { DEFAULT_IRREGULAR_GEOMETRY_SETTINGS } from '@shared/irregular/defaults.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { IrregularGeometryInputError, NfpIfpService } from '../../src/workers/irregular/services.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { TransformCollisionGeometry } from '../../src/workers/irregular/transformCollisionGeometry.js'
import {
  createFreeMaterialService,
  type FreeMaterialOperation
} from '../../src/workers/irregular/freeMaterialService.js'
import {
  makeNfpIfpServiceLive,
  type NfpConstructionAlgorithm
} from '../../src/workers/irregular/nfpIfpService.js'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const fixturesDirectory = join(repoRoot, 'tests', 'fixtures', 'dxf')
const geometryCache = new Map<string, Promise<CollisionGeometry>>()

const fixturePairs = [
  ['triangle.dxf', 'trapezoid.dxf'],
  ['trapezoid.dxf', 'angled-profile.dxf'],
  ['rounded-rectangle.dxf', 'triangle.dxf']
] as const

const transformCases = [
  {
    fixed: { rotationDeg: 0, mirrored: false },
    moving: { rotationDeg: 0, mirrored: false },
    fixedTranslate: { x: 20, y: 30 },
    fixedReversed: false,
    movingReversed: false
  },
  {
    fixed: { rotationDeg: 90, mirrored: false },
    moving: { rotationDeg: 37, mirrored: true },
    fixedTranslate: { x: 130, y: 90 },
    fixedReversed: true,
    movingReversed: false
  },
  {
    fixed: { rotationDeg: 180, mirrored: true },
    moving: { rotationDeg: 270, mirrored: false },
    fixedTranslate: { x: 240, y: 160 },
    fixedReversed: false,
    movingReversed: true
  }
] as const

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  const firstPoint = points[0]
  if (firstPoint === undefined) throw new Error('test polygon must contain a point')

  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

async function fixtureGeometry(
  fixtureName: string,
  totalPaddingMm: number
): Promise<CollisionGeometry> {
  const key = `${fixtureName}:${totalPaddingMm}`
  const cached = geometryCache.get(key)
  if (cached !== undefined) return cached

  const pending = importDxfFile(join(fixturesDirectory, fixtureName)).then(async (document) => {
    const piece = document.pieces[0]
    if (piece === undefined) throw new Error(`fixture ${fixtureName} imported without a piece`)

    return Effect.runPromise(
      CollisionGeometryBuilder.use((builder) => builder.buildPiece({ piece, totalPaddingMm })).pipe(
        Effect.provide(CollisionGeometryBuilder.Live),
        Effect.provide(GeometrySettings.Live)
      )
    )
  })
  geometryCache.set(key, pending)
  return pending
}

function reverseWinding(geometry: CollisionGeometry): CollisionGeometry {
  return new CollisionGeometry({
    sourcePieceId: geometry.sourcePieceId,
    sourceBounds: geometry.sourceBounds,
    sampledPoints: geometry.sampledPoints,
    convexHull: polygon([...geometry.convexHull.points].reverse()),
    collisionPolygon: polygon([...geometry.collisionPolygon.points].reverse()),
    placementReference: geometry.placementReference,
    diagnostics: geometry.diagnostics
  })
}

function transformCandidate(
  index: number,
  rotationDeg: number,
  mirrored: boolean
): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg,
    mirrored,
    reason: 'configured'
  })
}

function transformGeometry(
  geometry: CollisionGeometry,
  input: { readonly index: number; readonly rotationDeg: number; readonly mirrored: boolean },
  reversed: boolean
): TransformedCollisionGeometry {
  const source = reversed ? reverseWinding(geometry) : geometry
  const transform = transformCandidate(input.index, input.rotationDeg, input.mirrored)
  return Effect.runSync(TransformCollisionGeometry.compute({ geometry: source, transform }))
}

function placedGeometry(
  geometry: CollisionGeometry,
  input: {
    readonly index: number
    readonly rotationDeg: number
    readonly mirrored: boolean
    readonly translateX: number
    readonly translateY: number
  },
  reversed: boolean
): IrregularPlacedPiece {
  const transformed = transformGeometry(geometry, input, reversed)
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: geometry.sourcePieceId,
      transform: new IrregularTransform({
        translateX: input.translateX,
        translateY: input.translateY,
        rotationDeg: input.rotationDeg,
        mirrored: input.mirrored
      })
    }),
    collisionGeometry: transformed
  })
}

function transformedGeometry(
  geometry: CollisionGeometry,
  input: { readonly index: number; readonly rotationDeg: number; readonly mirrored: boolean },
  reversed: boolean
): TransformedCollisionGeometry {
  return transformGeometry(geometry, input, reversed)
}

function computeNfp(
  input: Parameters<NfpIfpService['computeNfp']>[0],
  algorithm: NfpConstructionAlgorithm
) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.computeNfp(input)).pipe(
      Effect.provide(makeNfpIfpServiceLive(algorithm))
    )
  )
}

function rawGeometry(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    transform: transformCandidate(0, 0, false),
    polygon: polygon(points),
    bounds: bounds(points)
  })
}

function rawPlacedPiece(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>
): IrregularPlacedPiece {
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: PieceId.make(pieceId),
      transform: new IrregularTransform({
        translateX: 0,
        translateY: 0,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: rawGeometry(pieceId, points)
  })
}

async function captureNfpFailure(
  input: Parameters<NfpIfpService['computeNfp']>[0],
  algorithm: NfpConstructionAlgorithm
): Promise<unknown> {
  try {
    await computeNfp(input, algorithm)
    return undefined
  } catch (error) {
    return error
  }
}

function expectGeometryFailure(value: unknown): asserts value is IrregularGeometryInputError {
  expect(value).toBeInstanceOf(IrregularGeometryInputError)
  if (!(value instanceof IrregularGeometryInputError)) {
    throw new Error('expected an irregular geometry input error')
  }
}

function canonicalRegions(snapshot: Awaited<ReturnType<typeof computeFreeMaterial>>) {
  return snapshot.regions.map((region) => ({
    boundary: region.boundary.points.map(({ x, y }) => [x, y]),
    holes: region.holes.map((hole) => hole.points.map(({ x, y }) => [x, y]))
  }))
}

function computeFreeMaterial(
  operation: FreeMaterialOperation,
  value: Parameters<ReturnType<typeof createFreeMaterialService>['computeFreeMaterial']>[0]
) {
  return Effect.runPromise(createFreeMaterialService(operation).computeFreeMaterial(value))
}

describe('geometry backend parity', () => {
  it('matches vertex-pair hull NFPs across convex fixtures, winding, transforms, and padding', async () => {
    for (const [pairIndex, [fixedFixture, movingFixture]] of fixturePairs.entries()) {
      for (const parityCase of transformCases) {
        const padding = pairIndex === 0 ? 0 : pairIndex === 1 ? 4 : 8
        const [fixedBase, movingBase] = await Promise.all([
          fixtureGeometry(fixedFixture, padding),
          fixtureGeometry(movingFixture, padding)
        ])
        const fixed = placedGeometry(
          fixedBase,
          {
            index: pairIndex,
            rotationDeg: parityCase.fixed.rotationDeg,
            mirrored: parityCase.fixed.mirrored,
            translateX: parityCase.fixedTranslate.x,
            translateY: parityCase.fixedTranslate.y
          },
          parityCase.fixedReversed
        )
        const moving = transformedGeometry(
          movingBase,
          {
            index: pairIndex + 10,
            rotationDeg: parityCase.moving.rotationDeg,
            mirrored: parityCase.moving.mirrored
          },
          parityCase.movingReversed
        )
        const input = {
          fixed,
          moving,
          settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
        }

        const [linear, reference] = await Promise.all([
          computeNfp(input, 'linear-edge-merge'),
          computeNfp(input, 'vertex-pair-hull')
        ])

        expect(linear).toEqual(reference)
      }
    }
  })

  it('preserves typed NFP failures across both construction algorithms', async () => {
    const validSquare = [point(0, 0), point(4, 0), point(4, 4), point(0, 4)]
    const failureCases = [
      {
        name: 'concave moving polygon',
        fixed: validSquare,
        moving: [point(0, 0), point(4, 0), point(2, 1), point(4, 4), point(0, 4)]
      },
      {
        name: 'too-few-vertex moving polygon',
        fixed: validSquare,
        moving: [point(0, 0), point(1, 0)]
      },
      {
        name: 'collinear fixed polygon',
        fixed: [point(0, 0), point(1, 0), point(2, 0)],
        moving: validSquare
      },
      {
        name: 'repeated fixed polygon',
        fixed: [point(0, 0), point(2, 0), point(2, 0), point(0, 2)],
        moving: validSquare
      }
    ]

    for (const failureCase of failureCases) {
      const input = {
        fixed: rawPlacedPiece(`fixed-${failureCase.name}`, failureCase.fixed),
        moving: rawGeometry(`moving-${failureCase.name}`, failureCase.moving),
        settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
      }
      const [linearFailure, referenceFailure] = await Promise.all([
        captureNfpFailure(input, 'linear-edge-merge'),
        captureNfpFailure(input, 'vertex-pair-hull')
      ])

      expectGeometryFailure(linearFailure)
      expectGeometryFailure(referenceFailure)
      expect(linearFailure.operation).toBe(referenceFailure.operation)
      expect(linearFailure.message).toBe(referenceFailure.message)
    }
  })

  it('matches free-material paths for padded transformed convex fixtures and mixed winding', async () => {
    const [triangle, trapezoid, roundedRectangle] = await Promise.all([
      fixtureGeometry('triangle.dxf', 6),
      fixtureGeometry('trapezoid.dxf', 6),
      fixtureGeometry('rounded-rectangle.dxf', 6)
    ])
    const placed = [
      placedGeometry(
        triangle,
        { index: 0, rotationDeg: 37, mirrored: false, translateX: 100, translateY: 100 },
        false
      ),
      placedGeometry(
        trapezoid,
        { index: 1, rotationDeg: 90, mirrored: true, translateX: 350, translateY: 250 },
        true
      ),
      placedGeometry(
        roundedRectangle,
        { index: 2, rotationDeg: 180, mirrored: false, translateX: 700, translateY: 500 },
        false
      )
    ]
    const value = {
      sheet: new SheetSpec({ width: 1000, height: 750, label: 'geometry parity sheet' }),
      placed,
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }

    const [unionThenDifference, directDifference] = await Promise.all([
      computeFreeMaterial('union-then-difference', value),
      computeFreeMaterial('direct-difference', value)
    ])

    expect(canonicalRegions(directDifference)).toEqual(canonicalRegions(unionThenDifference))
  })

  it('preserves typed free-material failures across both difference paths', async () => {
    const failureCases = [
      {
        name: 'concave',
        points: [point(0, 0), point(4, 0), point(2, 1), point(4, 4), point(0, 4)]
      },
      {
        name: 'too-few-vertex',
        points: [point(0, 0), point(1, 0)]
      },
      {
        name: 'collinear',
        points: [point(0, 0), point(1, 0), point(2, 0)]
      },
      {
        name: 'repeated',
        points: [point(0, 0), point(1, 0), point(1, 0), point(0, 1)]
      }
    ]

    for (const failureCase of failureCases) {
      const value = {
        sheet: new SheetSpec({ width: 10, height: 8, label: 'failure parity sheet' }),
        placed: [rawPlacedPiece(`failure-${failureCase.name}`, failureCase.points)],
        settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
      }
      const outcomes = await Promise.all(
        (['union-then-difference', 'direct-difference'] as const).map(async (operation) => {
          try {
            await computeFreeMaterial(operation, value)
            return undefined
          } catch (error) {
            return error
          }
        })
      )
      const unionFailure = outcomes[0]
      const directFailure = outcomes[1]
      expectGeometryFailure(unionFailure)
      expectGeometryFailure(directFailure)
      expect(unionFailure.operation).toBe(directFailure.operation)
      expect(unionFailure.message).toBe(directFailure.message)
    }
  })
})
