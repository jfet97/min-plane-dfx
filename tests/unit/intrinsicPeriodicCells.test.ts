import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  canonicalPeriodicCellIdentityControl,
  derivePeriodicAxisBasisControl,
  derivePeriodicAxisBasisCandidatesControl,
  exactAxisIntersectionsControl,
  enumerateIntrinsicPeriodicCells,
  expandIntrinsicPeriodicCell,
  farNeighborCertificate,
  periodicMemberDoubledAreaControl,
  rankIntrinsicPeriodicCells,
  rankIntrinsicPeriodicSeeds,
  shiftOrderedPairForbiddenBoundaryControl,
  validatePeriodicContactLatticeControl,
  type IntrinsicPeriodicBaseMember,
  type IntrinsicPeriodicCell
} from '../../src/workers/algorithm/irregular/intrinsicPeriodicCells.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function preparedPiece(
  id: string,
  family: string,
  points: ReadonlyArray<IrregularPoint>,
  rotations: ReadonlyArray<number> = [0, 90]
): IrregularPreparedPiece {
  const polygon = new IrregularPolygon({ points })
  const source = new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    interchangeabilityKey: family,
    source,
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: source.id,
      sourceBounds: new IrregularBounds({
        minX: Math.min(...points.map(({ x }) => x)),
        minY: Math.min(...points.map(({ y }) => y)),
        maxX: Math.max(...points.map(({ x }) => x)),
        maxY: Math.max(...points.map(({ y }) => y))
      }),
      sampledPoints: points,
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

function runCatalog(pieces: ReadonlyArray<IrregularPreparedPiece>) {
  return Effect.runPromise(
    enumerateIntrinsicPeriodicCells(pieces).pipe(
      Effect.provide(GeometryKernel.Live.pipe(Layer.provide(GeometrySettings.Live))),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

function transformed(piece: IrregularPreparedPiece): TransformedCollisionGeometry {
  const transform = piece.transforms[0]
  if (transform === undefined) throw new Error('test transform missing')
  return new TransformedCollisionGeometry({
    sourcePieceId: piece.source.id,
    transform,
    polygon: piece.collisionGeometry.collisionPolygon,
    bounds: piece.collisionGeometry.sourceBounds
  })
}

describe('intrinsic periodic cells', () => {
  it('keeps a finite rectangle crop source when the infinite far proof is equal', async () => {
    const pieces = Array.from({ length: 6 }, (_, index) =>
      preparedPiece(`rectangle-${index}`, 'rectangle', [
        point(0, 0),
        point(4, 0),
        point(4, 2),
        point(0, 2)
      ])
    )
    const catalog = await runCatalog(pieces)
    expect(catalog.selectedFamilyKey).toContain('rectangle')
    expect(catalog.uniqueTransformCount).toBe(2)
    expect(catalog.cells.length).toBeGreaterThan(0)
    expect(catalog.cells.every(({ basisProvenance }) => basisProvenance !== undefined)).toBe(true)
    expect(catalog.cells.some(({ basisProvenance }) => basisProvenance?.sourceKey.length)).toBe(true)
    expect(
      catalog.cells.some(
        ({ basisProvenance }) => basisProvenance?.sourceKind === 'nfp-boundary-vertex-pair'
      )
    ).toBe(true)
    const edgeContactCell = catalog.cells.find(
      ({ basisProvenance }) => basisProvenance?.sourceKind === 'edge-contact-pair'
    )
    expect(edgeContactCell?.basisProvenance?.contactRelations).toHaveLength(2)
    expect(
      edgeContactCell?.basisProvenance?.contactRelations?.every(
        ({ lengthMm, fixedPieceId, movingPieceId }) =>
          lengthMm > 0 && fixedPieceId.length > 0 && movingPieceId.length > 0
      )
    ).toBe(true)
    expect(catalog.cells.every(({ infiniteFarProof }) => infiniteFarProof)).toBe(false)
  })

  it('keeps a triangle-like repeated family source-linked and exact', async () => {
    const pieces = Array.from({ length: 4 }, (_, index) =>
      preparedPiece(`triangle-${index}`, 'triangle-like', [point(0, 0), point(4, 0), point(0, 2)])
    )
    const catalog = await runCatalog(pieces)
    expect(catalog.selectedFamilyKey).toContain('triangle-like')
    expect(catalog.cells.every(({ determinantGrid2 }) => BigInt(determinantGrid2) > 0n)).toBe(true)
    for (const seed of catalog.cells) {
      const expanded = await Effect.runPromise(expandIntrinsicPeriodicCell(seed, pieces))
      expect(
        expanded[0]?.placements.every(({ placement }) => placement.pieceId !== undefined)
      ).toBe(true)
    }
  })

  it('preserves selected collision-family and transform-family coverage before caps', async () => {
    const broad = Array.from({ length: 3 }, (_, index) =>
      preparedPiece(
        `broad-${index}`,
        'broad',
        [point(0, 0), point(6, 0), point(0, 2)],
        [0, 90, 180, 270]
      )
    )
    const narrow = Array.from({ length: 2 }, (_, index) =>
      preparedPiece(
        `narrow-${index}`,
        'narrow',
        [point(0, 0), point(3, 0), point(0, 3)],
        [0, 90]
      )
    )
    const catalog = await Effect.runPromise(
      enumerateIntrinsicPeriodicCells([...broad, ...narrow], {
        maximumFamilyCount: 1,
        maximumTransformsPerFamily: 2,
        maximumPairsPerFamily: 1
      }).pipe(
        Effect.provide(GeometryKernel.Live.pipe(Layer.provide(GeometrySettings.Live))),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )
    expect(catalog.familyCoverageComplete).toBe(false)
    expect(catalog.families).toHaveLength(1)
    const family = catalog.families[0]
    expect(family?.memberCount).toBe(3)
    expect(family?.transformCoverageComplete).toBe(false)
    expect(family?.transformReservations).toEqual(
      expect.arrayContaining([expect.objectContaining({ availableCount: 4, retainedCount: 2 })])
    )
  })

  it('uses exact union, axis duality, and the negative moving-base offset', () => {
    const forbidden = [
      [
        { x: -1000, y: -1000 },
        { x: 1000, y: -1000 },
        { x: 1000, y: 1000 },
        { x: -1000, y: 1000 }
      ]
    ]
    expect(derivePeriodicAxisBasisControl(forbidden)).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 1 }
    ])
    expect(derivePeriodicAxisBasisControl(forbidden, true)).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 0 }
    ])
    expect(shiftOrderedPairForbiddenBoundaryControl([{ x: 7, y: 11 }], { x: 2, y: 3 })).toEqual([
      { x: 5, y: 8 }
    ])
    expect(
      exactAxisIntersectionsControl(
        [
          { x: 0, y: -1 },
          { x: 1001, y: 1 },
          { x: 0, y: 2 }
        ],
        'y',
        0
      )
    ).toContainEqual({ x: '1001/2', y: '0/1' })
    const adjacent = derivePeriodicAxisBasisCandidatesControl([
      [
        { x: -1000, y: -1000 },
        { x: 1000, y: -1000 },
        { x: 1001, y: 1000 },
        { x: -1000, y: 1000 }
      ]
    ])
    expect(adjacent.map(([v1]) => v1.x)).toEqual(expect.arrayContaining([1, 1.001]))
    const ringWithDetachedComponent = [
      [
        { x: -3000, y: -3000 },
        { x: 3000, y: -3000 },
        { x: 3000, y: -2000 },
        { x: -3000, y: -2000 }
      ],
      [
        { x: -3000, y: 2000 },
        { x: 3000, y: 2000 },
        { x: 3000, y: 3000 },
        { x: -3000, y: 3000 }
      ],
      [
        { x: -3000, y: -2000 },
        { x: -2000, y: -2000 },
        { x: -2000, y: 2000 },
        { x: -3000, y: 2000 }
      ],
      [
        { x: 2000, y: -2000 },
        { x: 3000, y: -2000 },
        { x: 3000, y: 2000 },
        { x: 2000, y: 2000 }
      ],
      [
        { x: 5000, y: -500 },
        { x: 6000, y: -500 },
        { x: 6000, y: 500 },
        { x: 5000, y: 500 }
      ]
    ]
    expect(
      derivePeriodicAxisBasisCandidatesControl(ringWithDetachedComponent).length
    ).toBeGreaterThan(0)
  })

  it('keeps BigInt far-neighbor arithmetic and independently checks contact lattices', async () => {
    const square = preparedPiece('square', 'square', [
      point(0, 0),
      point(1, 0),
      point(1, 1),
      point(0, 1)
    ])
    const member: IntrinsicPeriodicBaseMember = {
      piece: square,
      geometry: transformed(square),
      point: point(0, 0)
    }
    const halfGridTriangle = preparedPiece('half-grid', 'half-grid', [
      point(0, 0),
      point(0.001, 0),
      point(0, 0.001)
    ])
    expect(
      periodicMemberDoubledAreaControl({
        piece: halfGridTriangle,
        geometry: transformed(halfGridTriangle),
        point: point(0, 0)
      })
    ).toBe('1')
    expect(
      farNeighborCertificate(
        [member],
        [
          { x: 2_000n, y: 0n },
          { x: 0n, y: 2_000n }
        ]
      )
    ).toBe(true)
    expect(
      farNeighborCertificate(
        [member],
        [
          { x: 1_000n, y: 0n },
          { x: 0n, y: 1_000n }
        ]
      )
    ).toBe(false)
    const nearSafeLimit = 9_007_199_254_740_991n
    expect(
      farNeighborCertificate(
        [member],
        [
          { x: nearSafeLimit, y: 0n },
          { x: 0n, y: nearSafeLimit }
        ]
      )
    ).toBe(true)
    await expect(
      Effect.runPromise(
        validatePeriodicContactLatticeControl([member], { x: 1, y: 0 }, { x: 0, y: 1 })
      )
    ).resolves.toBe(true)
    await expect(
      Effect.runPromise(
        validatePeriodicContactLatticeControl([member], { x: 0.5, y: 0 }, { x: 0, y: 1 })
      )
    ).resolves.toBe(false)
  })

  it('deduplicates the whole cell under quarter-turn and basis swap', () => {
    const first = preparedPiece('first', 'square', [
      point(0, 0),
      point(1, 0),
      point(1, 1),
      point(0, 1)
    ])
    const second = preparedPiece('second', 'square', [
      point(0, 0),
      point(1, 0),
      point(1, 1),
      point(0, 1)
    ])
    const horizontal = [
      { piece: first, geometry: transformed(first), point: point(0, 0) },
      { piece: second, geometry: transformed(second), point: point(1, 0) }
    ]
    const vertical = [
      { piece: first, geometry: transformed(first), point: point(0, 0) },
      { piece: second, geometry: transformed(second), point: point(0, 1) }
    ]
    expect(
      canonicalPeriodicCellIdentityControl('P2', horizontal, { x: 2, y: 0 }, { x: 0, y: 1 })
    ).toBe(canonicalPeriodicCellIdentityControl('P2', vertical, { x: 0, y: 2 }, { x: -1, y: 0 }))
  })

  it('expands P2 with an odd real remainder and rebuilds actual source metadata', async () => {
    const pieces = Array.from({ length: 5 }, (_, index) =>
      preparedPiece(`copy-${index}`, 'square', [point(0, 0), point(1, 0), point(1, 1), point(0, 1)])
    )
    const first = pieces[0]
    const second = pieces[1]
    if (first === undefined || second === undefined) return
    const members = [
      { piece: first, geometry: transformed(first), point: point(0, 0) },
      { piece: second, geometry: transformed(second), point: point(1, 0) }
    ]
    const cell: IntrinsicPeriodicCell = {
      role: 'P2',
      familyKey: 'square',
      members,
      v1: { x: 2, y: 0 },
      v2: { x: 0, y: 1 },
      determinantGrid2: '2000000',
      memberDoubledAreaGrid2: '4000000',
      density: 1,
      envelopeMaximumSideMm: 2,
      hullWasteRatio: 0,
      sharedBoundaryLengthMm: 1,
      infiniteFarProof: false,
      threeByThreeLatticeLegal: true,
      threeByThreeCentreContactComplete: true,
      canonicalKey: 'control'
    }
    const seed = (await Effect.runPromise(expandIntrinsicPeriodicCell(cell, pieces)))[0]
    expect(seed?.placements).toHaveLength(4)
    expect(seed?.crop).toEqual(
      expect.objectContaining({ rows: expect.any(Number), columns: expect.any(Number) })
    )
    expect(seed?.remainingFamilyMembers.map(({ pieceId }) => pieceId)).toEqual([pieces[4]?.pieceId])
    expect(
      seed?.placements.map(({ placement, collisionGeometry }) => ({
        pieceId: placement.pieceId,
        sourcePieceId: placement.sourcePieceId,
        geometrySourcePieceId: collisionGeometry.sourcePieceId
      }))
    ).toEqual(
      pieces.slice(0, 4).map((piece) => ({
        pieceId: piece.pieceId,
        sourcePieceId: piece.source.id,
        geometrySourcePieceId: piece.source.id
      }))
    )
    const denominator = '9007199254740991000000'
    const lower = {
      ...cell,
      determinantGrid2: denominator,
      memberDoubledAreaGrid2: '9007199254740991000000',
      canonicalKey: 'lower'
    }
    const higher = {
      ...cell,
      determinantGrid2: denominator,
      memberDoubledAreaGrid2: '9007199254740991000001',
      canonicalKey: 'higher'
    }
    expect(
      rankIntrinsicPeriodicCells([lower, higher]).map(({ canonicalKey }) => canonicalKey)
    ).toEqual(['higher', 'lower'])
    const certifiedFiniteSource = { ...cell, canonicalKey: 'certified-finite-source' }
    const unverifiedFiniteSource = {
      ...cell,
      determinantGrid2: '1000000',
      memberDoubledAreaGrid2: '4000000',
      threeByThreeLatticeLegal: false,
      threeByThreeCentreContactComplete: false,
      canonicalKey: 'unverified-finite-source'
    }
    expect(
      rankIntrinsicPeriodicCells([unverifiedFiniteSource, certifiedFiniteSource]).map(
        ({ canonicalKey }) => canonicalKey
      )
    ).toEqual(['certified-finite-source', 'unverified-finite-source'])
    if (seed !== undefined) {
      const topologicallyWeak = {
        ...seed,
        cellKey: 'denser-cell',
        componentCount: 2,
        isolatedPieceCount: 1,
        largestComponentSize: 3
      }
      const topologicallyStrong = {
        ...seed,
        cellKey: 'less-dense-cell',
        componentCount: 1,
        isolatedPieceCount: 0,
        largestComponentSize: 4
      }
      expect(rankIntrinsicPeriodicSeeds([topologicallyWeak, topologicallyStrong])[0]?.cellKey).toBe(
        'less-dense-cell'
      )
    }
  })
})
