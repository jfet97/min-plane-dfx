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

function compareSerializedContactScores(first: string, second: string): number {
  const [firstCount, firstAxisUnits] = first.split(':')
  const [secondCount, secondAxisUnits] = second.split(':')
  if (
    firstCount === undefined ||
    firstAxisUnits === undefined ||
    secondCount === undefined ||
    secondAxisUnits === undefined
  ) {
    throw new Error('invalid serialized contact score')
  }
  const countOrder = Number(firstCount) - Number(secondCount)
  if (countOrder !== 0) return countOrder
  const firstUnits = BigInt(firstAxisUnits)
  const secondUnits = BigInt(secondAxisUnits)
  return firstUnits < secondUnits ? -1 : firstUnits > secondUnits ? 1 : 0
}

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
  readonly tieEvidenceSink?: (
    entry: import('../../src/workers/algorithm/irregular/intrinsicShortSideContactStrip.js').IntrinsicShortSideContactStripTieEvidence
  ) => void
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
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.tieEvidenceSink === undefined ? {} : { tieEvidenceSink: input.tieEvidenceSink })
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

  it('settles a tied anchor on the contacting orientation at equal depth', async () => {
    const ties: Array<{
      readonly tiedCount: number
      readonly selectionChanged: boolean
      readonly winnerScore: string | undefined
      readonly bestAlternativeScore: string | undefined
    }> = []
    const outcome = await construct({
      pieces: [
        rectangle('wall', 40, 20),
        preparedPiece(
          'leaning',
          [point(0, 0), point(40, 0), point(40, 20)],
          [0, 180]
        ),
        rectangle('afterwards', 10, 10)
      ],
      tieEvidenceSink: (entry) => {
        ties.push(entry)
      }
    })

    expect(outcome.trace.status).toBe('constructed')
    const placed = outcome.placedCollisionGeometries ?? []
    expect(placed).toHaveLength(3)
    // the 180-degree orientation edge-contacts the wall despite losing the
    // translation-order baseline to the point-contact 0-degree orientation
    expect(placed[1]?.placement.transform.rotationDeg).toBe(180)
    // the piece placed after the swap keeps the layout at the depth the
    // baseline construction would also have reached in this scenario
    const allPoints = placed.flatMap((entry) => placedCollisionWorldGridPath(entry) ?? [])
    expect(Math.max(...allPoints.map(({ y }) => y))).toBeLessThanOrEqual(30_000)
    expect(
      ties.some(
        (tie) =>
          tie.selectionChanged &&
          tie.winnerScore !== undefined &&
          tie.bestAlternativeScore !== undefined &&
          compareSerializedContactScores(tie.winnerScore, tie.bestAlternativeScore) > 0
      )
    ).toBe(true)
  })

  it('falls back to the deterministic tuple when a tied candidate has diagonal contact', async () => {
    const ties: Array<{
      readonly selectionChanged: boolean
      readonly scores: ReadonlyArray<{
        readonly contactAxisUnits: string | undefined
      }>
    }> = []
    const trianglePoints = [point(0, 0), point(40, 0), point(20, 20)]
    const outcome = await construct({
      pieces: [
        preparedPiece('base', trianglePoints, [0]),
        preparedPiece('moving', trianglePoints, [0, 180])
      ],
      tieEvidenceSink: (entry) => {
        ties.push(entry)
      }
    })

    expect(outcome.trace.status).toBe('constructed')
    expect(outcome.placedCollisionGeometries).toHaveLength(2)
    expect(
      ties.some(
        (tie) =>
          !tie.selectionChanged &&
          tie.scores.some(({ contactAxisUnits }) => contactAxisUnits === undefined)
      )
    ).toBe(true)
  })

  it('refuses a contacting alternative that is deeper than the baseline winner', async () => {
    const ties: Array<{
      readonly tiedCount: number
      readonly selectionChanged: boolean
      readonly winnerScore: string | undefined
      readonly bestAlternativeScore: string | undefined
    }> = []
    const outcome = await construct({
      pieces: [
        rectangle('wall', 40, 40),
        preparedPiece(
          'leaning',
          [point(0, 0), point(40, 0), point(0, 20)],
          [0, 270]
        )
      ],
      tieEvidenceSink: (entry) => {
        ties.push(entry)
      }
    })

    expect(outcome.trace.status).toBe('constructed')
    const placed = outcome.placedCollisionGeometries ?? []
    expect(placed).toHaveLength(2)
    // the 270-degree orientation offers twice the contact but doubles the
    // depth, so the depth bound keeps the shallow baseline orientation
    expect(placed[1]?.placement.transform.rotationDeg).toBe(0)
    const secondPath = placed[1] === undefined ? [] : (placedCollisionWorldGridPath(placed[1]) ?? [])
    expect(Math.max(...secondPath.map(({ y }) => y))).toBeLessThanOrEqual(20_000)
    expect(
      ties.some(
        (tie) =>
          !tie.selectionChanged &&
          tie.winnerScore !== undefined &&
          tie.bestAlternativeScore !== undefined
      )
    ).toBe(true)
  })
})
