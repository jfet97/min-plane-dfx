import { Effect, Layer } from 'effect'
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
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import {
  buildIntrinsicFamilyPortfolioChromosomes,
  groupIntrinsicCollisionFamilies,
  orderIntrinsicFamilyPortfolioPieces,
  runIntrinsicStrictFamilyPortfolio,
  selectIntrinsicFamilyPortfolioWinner,
  selectRepeatedElongatedFamilies,
  sizeBands,
  type IntrinsicFamilyPortfolioRun
} from '../../src/workers/algorithm/irregular/intrinsicStrictFamilyPortfolio.js'
import type {
  IntrinsicStrictCompletedMetrics,
  IntrinsicStrictDecodeResult
} from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function sourcePiece(id: string): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
}

function transform(
  index: number,
  rotationDeg: number,
  mirrored = false
): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg,
    mirrored,
    reason: 'configured'
  })
}

function preparedPiece(input: {
  readonly id: string
  readonly family: string
  readonly width: number
  readonly height: number
  readonly transforms?: ReadonlyArray<IrregularTransformCandidate>
}): IrregularPreparedPiece {
  const points = [
    point(0, 0),
    point(input.width, 0),
    point(input.width, input.height),
    point(0, input.height)
  ]
  const polygon = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(input.id),
    interchangeabilityKey: input.family,
    source: sourcePiece(input.id),
    allowMirror: true,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(input.id),
      sourceBounds: new IrregularBounds({
        minX: 0,
        minY: 0,
        maxX: input.width,
        maxY: input.height
      }),
      sampledPoints: points,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms:
      input.transforms ??
      [transform(0, 0), transform(1, 90), transform(2, 0, true), transform(3, 90, true)]
  })
}

function ids(pieces: ReadonlyArray<IrregularPreparedPiece>): ReadonlyArray<string> {
  return pieces.map((piece) => piece.pieceId ?? piece.source.id)
}

function buildChromosomes(pieces: ReadonlyArray<IrregularPreparedPiece>) {
  return Effect.runPromise(
    buildIntrinsicFamilyPortfolioChromosomes(pieces).pipe(
      Effect.provide(GeometryKernel.Live.pipe(Layer.provide(GeometrySettings.Live)))
    )
  )
}

describe('intrinsic strict family portfolio', () => {
  it('groups collision-identical interchangeable copies and round-robins families', () => {
    const pieces = [
      preparedPiece({ id: 'a1', family: 'a', width: 10, height: 2 }),
      preparedPiece({ id: 'a2', family: 'a', width: 10, height: 2 }),
      preparedPiece({ id: 'b1', family: 'b', width: 8, height: 3 }),
      preparedPiece({ id: 'b2', family: 'b', width: 8, height: 3 }),
      preparedPiece({ id: 'b3', family: 'b', width: 8, height: 3 }),
      preparedPiece({ id: 'c1', family: 'c', width: 6, height: 5 })
    ]

    expect(groupIntrinsicCollisionFamilies(pieces).map(({ members }) => ids(members))).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2', 'b3'],
      ['c1']
    ])
    expect(ids(orderIntrinsicFamilyPortfolioPieces(pieces, 'family-round-robin'))).toEqual([
      'a1',
      'b1',
      'c1',
      'a2',
      'b2',
      'b3'
    ])
  })

  it('forms consecutive 75% long-side bands before family interleaving', () => {
    const pieces = [
      preparedPiece({ id: 'a1', family: 'a', width: 100, height: 10 }),
      preparedPiece({ id: 'a2', family: 'a', width: 80, height: 10 }),
      preparedPiece({ id: 'b1', family: 'b', width: 74, height: 10 }),
      preparedPiece({ id: 'c1', family: 'c', width: 60, height: 10 })
    ]

    expect(sizeBands(pieces).map(ids)).toEqual([
      ['a1', 'a2'],
      ['b1', 'c1']
    ])
    expect(
      ids(orderIntrinsicFamilyPortfolioPieces(pieces, 'size-band-family-interleave'))
    ).toEqual(['a1', 'a2', 'b1', 'c1'])
  })

  it('partitions large-first at maximum collision area divided by eight', () => {
    const pieces = [
      preparedPiece({ id: 'small', family: 'small', width: 2, height: 2 }),
      preparedPiece({ id: 'boundary', family: 'boundary', width: 5, height: 2.5 }),
      preparedPiece({ id: 'maximum', family: 'maximum', width: 10, height: 10 }),
      preparedPiece({ id: 'tiny', family: 'tiny', width: 1, height: 1 })
    ]

    expect(ids(orderIntrinsicFamilyPortfolioPieces(pieces, 'large-first-small-fill'))).toEqual([
      'boundary',
      'maximum',
      'small',
      'tiny'
    ])
  })

  it('selects the two largest repeated elongated collision families generically', () => {
    const pieces = [
      preparedPiece({ id: 'thin1', family: 'thin', width: 10, height: 2 }),
      preparedPiece({ id: 'thin2', family: 'thin', width: 10, height: 2 }),
      preparedPiece({ id: 'wide1', family: 'wide', width: 8, height: 4 }),
      preparedPiece({ id: 'wide2', family: 'wide', width: 8, height: 4 }),
      preparedPiece({ id: 'square1', family: 'square', width: 9, height: 9 }),
      preparedPiece({ id: 'square2', family: 'square', width: 9, height: 9 }),
      preparedPiece({ id: 'single', family: 'single', width: 20, height: 2 })
    ]

    expect(selectRepeatedElongatedFamilies(pieces).map(({ members }) => ids(members))).toEqual([
      ['wide1', 'wide2'],
      ['thin1', 'thin2']
    ])
  })

  it('derives orientation from transformed bounds rather than transform indices', async () => {
    const makePieces = (offset: number) => [
      preparedPiece({
        id: 'a1',
        family: 'a',
        width: 12,
        height: 3,
        transforms: [transform(offset + 7, 90), transform(offset + 2, 0)]
      }),
      preparedPiece({
        id: 'a2',
        family: 'a',
        width: 12,
        height: 3,
        transforms: [transform(offset + 9, 90), transform(offset + 4, 0)]
      }),
      preparedPiece({
        id: 'b1',
        family: 'b',
        width: 10,
        height: 2,
        transforms: [transform(offset + 5, 90), transform(offset + 1, 0)]
      }),
      preparedPiece({
        id: 'b2',
        family: 'b',
        width: 10,
        height: 2,
        transforms: [transform(offset + 8, 90), transform(offset + 3, 0)]
      })
    ]

    const first = await buildChromosomes(makePieces(0))
    const second = await buildChromosomes(makePieces(20))
    expect(first.map(({ identitySha256 }) => identitySha256)).toEqual(
      second.map(({ identitySha256 }) => identitySha256)
    )
    expect(
      first.find(
        ({ orderId, templateId }) => orderId === 'baseline' && templateId === 'crossed'
      )?.pieces.map((piece) => piece.transforms.map(({ rotationDeg }) => rotationDeg))
    ).toEqual([[0], [0], [90], [90]])
  })

  it('records invalid templates and duplicate chromosomes without replacement', async () => {
    const onlyLandscape = [transform(0, 0), transform(1, 0, true)]
    const pieces = [
      preparedPiece({ id: 'a1', family: 'a', width: 12, height: 3 }),
      preparedPiece({ id: 'b1', family: 'b', width: 10, height: 2 }),
      preparedPiece({ id: 'a2', family: 'a', width: 12, height: 3 }),
      preparedPiece({
        id: 'b2',
        family: 'b',
        width: 10,
        height: 2,
        transforms: onlyLandscape
      })
    ]
    pieces[1] = preparedPiece({
      id: 'b1',
      family: 'b',
      width: 10,
      height: 2,
      transforms: onlyLandscape
    })

    const chromosomes = await buildChromosomes(pieces)
    expect(chromosomes).toHaveLength(8)
    expect(chromosomes.filter(({ status }) => status === 'invalid')).toHaveLength(4)
    expect(chromosomes.some(({ status }) => status === 'duplicate')).toBe(true)
  })

  it('selects completed layouts through the intrinsic archive order', () => {
    const cohesive = metrics('cohesive', { isolatedPieceCount: 0, envelopeAreaMm2: 10_000 })
    const fragment = metrics('fragment', { isolatedPieceCount: 9, envelopeAreaMm2: 5_000 })
    const runs = [portfolioRun('fragment', fragment), portfolioRun('cohesive', cohesive)]

    const selected = selectIntrinsicFamilyPortfolioWinner(runs)
    expect(selected.archive.map(({ canonicalGeometryHash }) => canonicalGeometryHash)).toEqual([
      'cohesive',
      'fragment'
    ])
    expect(selected.winner?.result?.metrics?.canonicalGeometryHash).toBe('cohesive')
  })

  it('keeps the eight-chromosome decode sheet-blind wherever the winner fits', async () => {
    const pieces = [
      preparedPiece({ id: 'a1', family: 'a', width: 4, height: 2 }),
      preparedPiece({ id: 'b1', family: 'b', width: 3, height: 1 }),
      preparedPiece({ id: 'a2', family: 'a', width: 4, height: 2 }),
      preparedPiece({ id: 'b2', family: 'b', width: 3, height: 1 })
    ]
    const run = (sheet: SheetSpec) =>
      Effect.runPromise(
        runIntrinsicStrictFamilyPortfolio(sheet, pieces, {
          maximumRuntimeMsPerChromosome: 2_000,
          maximumTotalRuntimeMs: 10_000
        }).pipe(
          Effect.provide(GeometryKernel.Live),
          Effect.provide(NfpIfpServiceLive),
          Effect.provide(Layer.succeed(GeometrySettings, GeometrySettings.Make))
        )
      )

    const landscape = await run(new SheetSpec({ width: 30, height: 20, label: 'landscape' }))
    const portrait = await run(new SheetSpec({ width: 20, height: 30, label: 'portrait' }))
    expect(landscape.winner?.result?.canonicalGeometryHash).toBe(
      portrait.winner?.result?.canonicalGeometryHash
    )
    expect(landscape.runs.map(({ status }) => status)).toEqual(
      portrait.runs.map(({ status }) => status)
    )
  })
})

function metrics(
  canonicalGeometryHash: string,
  overrides: Partial<IntrinsicStrictCompletedMetrics>
): IntrinsicStrictCompletedMetrics {
  return {
    envelopeMaximumSideMm: 100,
    envelopeAreaMm2: 8_000,
    envelopeSpanMm: 180,
    enclosedCavityCount: 0,
    totalEnclosedCavityAreaMm2: 0,
    largestOccupiedHullGapRatio: 0.05,
    isolatedPieceCount: 0,
    positiveContactComponentCount: 1,
    largestPositiveContactComponentSize: 10,
    largestPositiveContactComponentRatio: 1,
    occupiedAreaOutsideLargestContactComponentMm2: 0,
    occupiedHullWasteRatio: 0.05,
    totalStructuralContacts: 9,
    dominantStructuralContacts: 9,
    contactUnits: 9,
    sharedBoundaryLengthMm: 90,
    canonicalGeometryHash,
    runtimeMs: 1,
    ...overrides
  }
}

function portfolioRun(
  label: string,
  completedMetrics: IntrinsicStrictCompletedMetrics
): IntrinsicFamilyPortfolioRun {
  const result: IntrinsicStrictDecodeResult = {
    status: 'completed',
    placements: [],
    placedCollisionGeometries: [],
    unplacedPieceIds: [],
    terminalRotationDeg: 0,
    canonicalGeometryHash: completedMetrics.canonicalGeometryHash,
    metrics: completedMetrics,
    certificate: undefined,
    stepTrace: [],
    runtimeMs: 1
  }
  return {
    chromosome: {
      orderId: 'baseline',
      templateId: 'coaxial',
      status: 'valid',
      invalidReason: undefined,
      duplicateOf: undefined,
      identitySha256: label,
      selectedElongatedFamilyKeys: [],
      pieceIds: [],
      pieces: []
    },
    status: 'completed',
    result,
    runtimeMs: 1
  }
}
