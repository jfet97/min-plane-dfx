import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  type IrregularPlacedPiece
} from '@shared/irregular/domain.js'
import { constructIntrinsicShortSideContactStrip } from '../../src/workers/algorithm/irregular/intrinsicShortSideContactStrip.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutTopology,
  placedCollisionWorldGridPath
} from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'

const STRIP_SETTINGS = GeometrySettings.Make

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function sourcePiece(id: string): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({
      entityType: 'PRESET_SHAPE',
      closed: true,
      segments: []
    }),
    warnings: []
  })
}

function preparedPiece(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  rotations: ReadonlyArray<number>
): IrregularPreparedPiece {
  const polygon = new IrregularPolygon({ points: [...points] })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: new IrregularBounds({
        minX: Math.min(...points.map(({ x }) => x)),
        minY: Math.min(...points.map(({ y }) => y)),
        maxX: Math.max(...points.map(({ x }) => x)),
        maxY: Math.max(...points.map(({ y }) => y))
      }),
      sampledPoints: [...points],
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms: rotations.map(
      (rotationDeg, index) =>
        new IrregularTransformCandidate({
          index,
          rotationDeg,
          mirrored: false,
          reason: 'configured'
        })
    )
  })
}

function triangle(id: string, width: number, height: number): IrregularPreparedPiece {
  return preparedPiece(
    id,
    [point(0, 0), point(width, 0), point(width / 2, height)],
    [0, 180]
  )
}

function rectangle(id: string, width: number, height: number): IrregularPreparedPiece {
  return preparedPiece(
    id,
    [point(0, 0), point(width, 0), point(width, height), point(0, height)],
    [0]
  )
}

function construct(input: {
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly stripSheet?: SheetSpec
  readonly maximumRuntimeMs?: number
  readonly now?: () => number
}) {
  return Effect.runPromise(
    constructIntrinsicShortSideContactStrip({
      stripSheet:
        input.stripSheet ?? new SheetSpec({ width: 400, height: 800, label: 'strip' }),
      preparedPieces: input.pieces,
      settings: STRIP_SETTINGS,
      runtimeControl: {
        ...(input.maximumRuntimeMs === undefined
          ? {}
          : { maximumRuntimeMs: input.maximumRuntimeMs }),
        ...(input.now === undefined ? {} : { now: input.now })
      }
    }).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(GeometrySettings.Live)
    )
  )
}

function occupiedShortAxisSpanGrid(placed: ReadonlyArray<IrregularPlacedPiece>): number {
  const points = placed.flatMap((entry) => placedCollisionWorldGridPath(entry) ?? [])
  return Math.max(...points.map(({ x }) => x)) - Math.min(...points.map(({ x }) => x))
}

function readings(...values: ReadonlyArray<number>): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)] ?? 0
}

describe('intrinsic short-side contact strip', () => {
  it('interlocks opposed orientations instead of advancing by bounding box', async () => {
    const width = 40
    const outcome = await construct({
      pieces: [
        triangle('triangle-1', width, 30),
        triangle('triangle-2', width, 30),
        triangle('triangle-3', width, 30),
        triangle('triangle-4', width, 30)
      ]
    })

    expect(outcome.trace.status).toBe('constructed')
    const placed = outcome.placedCollisionGeometries
    expect(placed).toHaveLength(4)
    if (placed === undefined) return
    // four side-by-side bounding boxes would span four widths; interlocking must
    // beat that strictly while keeping the layout exactly legal.
    expect(occupiedShortAxisSpanGrid(placed)).toBeLessThan(4 * width * 1_000)
    expect(
      assertCanonicalGridLegalLayout(
        new SheetSpec({ width: 400, height: 800, label: 'strip' }),
        placed
      )
    ).toBe(true)
    expect(measureCanonicalLayoutTopology(placed)?.enclosedCavityCount).toBe(0)
    const rotations = placed.map(({ placement }) => placement.transform.rotationDeg)
    expect(new Set(rotations).size).toBe(2)
  })

  it('reproduces one canonical identity across repeated construction', async () => {
    const pieces = [
      rectangle('rectangle-1', 60, 40),
      triangle('triangle-1', 40, 30),
      triangle('triangle-2', 40, 30),
      rectangle('rectangle-2', 30, 20)
    ]
    const first = await construct({ pieces })
    const second = await construct({ pieces })

    expect(first.trace.status).toBe('constructed')
    expect(second.trace.status).toBe('constructed')
    expect(canonicalCollisionLayoutIdentity(first.placedCollisionGeometries ?? [])).toBe(
      canonicalCollisionLayoutIdentity(second.placedCollisionGeometries ?? [])
    )
  })

  it('settles every piece on the strip floor before opening depth', async () => {
    const outcome = await construct({
      pieces: [rectangle('rectangle-1', 60, 40), rectangle('rectangle-2', 60, 40)]
    })

    const placed = outcome.placedCollisionGeometries ?? []
    expect(placed).toHaveLength(2)
    for (const entry of placed) {
      const path = placedCollisionWorldGridPath(entry) ?? []
      expect(Math.min(...path.map(({ y }) => y))).toBe(0)
    }
  })

  it('reports no legal placement when a piece cannot fit the strip', async () => {
    const outcome = await construct({
      pieces: [rectangle('too-wide', 500, 40)],
      stripSheet: new SheetSpec({ width: 400, height: 800, label: 'strip' })
    })

    expect(outcome.trace.status).toBe('no-legal-placement')
    expect(outcome.placedCollisionGeometries).toBeUndefined()
    expect(outcome.trace.failureReason).toContain('too-wide')
  })

  it('stops at its deadline without returning a partial layout', async () => {
    const outcome = await construct({
      pieces: [rectangle('rectangle-1', 60, 40), rectangle('rectangle-2', 60, 40)],
      maximumRuntimeMs: 5,
      now: readings(0, 1, 2, 500)
    })

    expect(outcome.trace.status).toBe('deadline')
    expect(outcome.placedCollisionGeometries).toBeUndefined()
  })
})
