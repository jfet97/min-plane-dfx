import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularNestingSettings,
  IrregularOptimizerSettings,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import {
  compareIntrinsicCompactnessPlacementScores,
  IrregularPlacementScorer,
  IrregularPlacementScoringError,
  type IrregularPlacementScore,
  type ScoreIrregularPlacementCandidateInput
} from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function rectanglePoints(width: number, height: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

function transform(
  index: number,
  rotationDeg = 0,
  mirrored = false,
  reason: IrregularTransformCandidate['reason'] = 'configured'
): IrregularTransformCandidate {
  return new IrregularTransformCandidate({ index, rotationDeg, mirrored, reason })
}

function movingGeometry(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  movingTransform = transform(0)
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(id),
    transform: movingTransform,
    polygon: polygon(points),
    bounds: bounds(points)
  })
}

function placedGeometry(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX: number,
  translateY: number,
  placedTransform = transform(0)
): IrregularPlacedPiece {
  const geometry = movingGeometry(id, points, placedTransform)
  const placement = new IrregularPlacement({
    sourcePieceId: PieceId.make(id),
    transform: new IrregularTransform({
      translateX,
      translateY,
      rotationDeg: placedTransform.rotationDeg,
      mirrored: placedTransform.mirrored
    })
  })
  return new IrregularPlacedPiece({ placement, collisionGeometry: geometry })
}

function candidate(
  id: string,
  x: number,
  y: number,
  candidateTransform = transform(0)
): IrregularPlacementCandidate {
  return new IrregularPlacementCandidate({
    pieceId: PieceId.make(id),
    transform: candidateTransform,
    point: point(x, y),
    diagnostics: []
  })
}

function sheet(width: number, height: number): SheetSpec {
  return new SheetSpec({ width, height, label: 'scorer test sheet' })
}

function score(input: ScoreIrregularPlacementCandidateInput) {
  return Effect.runPromise(
    IrregularPlacementScorer.use((scorer) => scorer.scoreCandidate(input)).pipe(
      Effect.provide(IrregularPlacementScorer.Live)
    )
  )
}

function scoreWithConfiguredPolicy(
  input: ScoreIrregularPlacementCandidateInput,
  policyId: 'balanced-compactness' | 'short-side-fill'
) {
  const settings = new IrregularNestingSettings({
    geometry: GeometrySettings.Make.geometry,
    optimizer: new IrregularOptimizerSettings({
      ...GeometrySettings.Make.optimizer,
      placementPolicyId: policyId,
      placementPolicyIds: [policyId]
    })
  })
  return Effect.runPromise(
    IrregularPlacementScorer.use((scorer) => scorer.scoreCandidate(input)).pipe(
      Effect.provide(IrregularPlacementScorer.Layer),
      Effect.provide(Layer.succeed(GeometrySettings, settings))
    )
  )
}

async function rank(
  inputs: ReadonlyArray<ScoreIrregularPlacementCandidateInput>
): Promise<IrregularPlacementScore> {
  const scores = await Promise.all(inputs.map(score))
  return scores.reduce((best, current) =>
    IrregularPlacementScorer.Make.compare(current, best) < 0 ? current : best
  )
}

function baseInput(
  currentSheet: SheetSpec,
  moving: TransformedCollisionGeometry,
  currentCandidate: IrregularPlacementCandidate,
  placed: ReadonlyArray<IrregularPlacedPiece> = []
): ScoreIrregularPlacementCandidateInput {
  return {
    sheet: currentSheet,
    placed,
    moving,
    candidate: currentCandidate
  }
}

describe('IrregularPlacementScorer', () => {
  it('ranks candidates by the balanced tuple in lexicographic order', async () => {
    const moving = movingGeometry('piece', rectanglePoints(1, 1))
    const placed = [placedGeometry('placed', rectanglePoints(1, 1), 0, 0)]
    const firstWins = await rank([
      baseInput(sheet(10, 10), moving, candidate('piece', 4, 4), placed),
      baseInput(sheet(10, 10), moving, candidate('piece', 6, 0), placed)
    ])
    expect(firstWins.candidate.point).toEqual(point(4, 4))

    const normalizedSumWins = await rank([
      baseInput(sheet(10, 20), moving, candidate('piece', 3, 1), placed),
      baseInput(sheet(10, 20), moving, candidate('piece', 1, 7), placed)
    ])
    expect(normalizedSumWins.candidate.point).toEqual(point(3, 1))

    const absoluteSpanWins = await rank([
      baseInput(sheet(10, 20), moving, candidate('piece', 3, 3), placed),
      baseInput(sheet(10, 20), moving, candidate('piece', 1, 7), placed)
    ])
    expect(absoluteSpanWins.candidate.point).toEqual(point(3, 3))

    const largePlaced = [placedGeometry('placed-large', rectanglePoints(10, 10), 0, 0)]
    const [raised, bottom] = await Promise.all([
      score(baseInput(sheet(20, 20), moving, candidate('piece', 1, 2), largePlaced)),
      score(baseInput(sheet(20, 20), moving, candidate('piece', 1, 1), largePlaced))
    ])
    expect(IrregularPlacementScorer.Make.compare(raised, bottom)).toBe(0)

    const [right, left] = await Promise.all([
      score(baseInput(sheet(20, 20), moving, candidate('piece', 2, 1), largePlaced)),
      score(baseInput(sheet(20, 20), moving, candidate('piece', 1, 1), largePlaced))
    ])
    expect(IrregularPlacementScorer.Make.compare(right, left)).toBe(0)
  })

  it('guards short-side fill with global envelope quality on landscape sheets', async () => {
    const moving = movingGeometry('piece', rectanglePoints(2, 2))
    const placed = [placedGeometry('placed', rectanglePoints(2, 2), 50, 0)]
    const currentSheet = sheet(100, 20)
    const balancedCandidate = baseInput(currentSheet, moving, candidate('piece', 0, 0), placed)
    const shortSideCandidate = baseInput(currentSheet, moving, candidate('piece', 0, 4), placed)

    const balancedWinner = await rank([balancedCandidate, shortSideCandidate])
    const shortSideWinner = await rank([
      { ...balancedCandidate, policyId: 'short-side-fill' },
      { ...shortSideCandidate, policyId: 'short-side-fill' }
    ])

    expect(balancedWinner.candidate.point).toEqual(point(0, 0))
    expect(shortSideWinner.candidate.point).toEqual(point(0, 0))
  })

  it('guards short-side fill with global envelope quality on portrait sheets', async () => {
    const moving = movingGeometry('piece', rectanglePoints(2, 2))
    const placed = [placedGeometry('placed', rectanglePoints(2, 2), 0, 50)]
    const currentSheet = sheet(20, 100)
    const balancedCandidate = baseInput(currentSheet, moving, candidate('piece', 0, 0), placed)
    const shortSideCandidate = baseInput(currentSheet, moving, candidate('piece', 4, 0), placed)

    const winner = await rank([
      { ...balancedCandidate, policyId: 'short-side-fill' },
      { ...shortSideCandidate, policyId: 'short-side-fill' }
    ])

    expect(winner.candidate.point).toEqual(point(0, 0))
  })

  it('retains short-axis progress after the envelope criteria tie', async () => {
    const moving = movingGeometry('piece', rectanglePoints(2, 2))
    const placed = [placedGeometry('placed', rectanglePoints(2, 2), 0, 0)]
    const currentSheet = sheet(100, 20)
    const longAxisCandidate = baseInput(
      currentSheet,
      moving,
      candidate('piece', 48, 2),
      placed
    )
    const shortAxisCandidate = baseInput(
      currentSheet,
      moving,
      candidate('piece', 18, 8),
      placed
    )

    const winner = await rank([
      { ...longAxisCandidate, policyId: 'short-side-fill' },
      { ...shortAxisCandidate, policyId: 'short-side-fill' }
    ])

    expect(winner.candidate.point).toEqual(point(18, 8))
  })

  it('falls back to balanced compactness on square sheets', async () => {
    const moving = movingGeometry('piece', rectanglePoints(2, 2))
    const placed = [placedGeometry('placed', rectanglePoints(2, 2), 5, 0)]
    const compactCandidate = baseInput(sheet(20, 20), moving, candidate('piece', 0, 0), placed)
    const tallerCandidate = baseInput(sheet(20, 20), moving, candidate('piece', 0, 4), placed)

    const [compact, taller] = await Promise.all([
      score({ ...compactCandidate, policyId: 'short-side-fill' }),
      score({ ...tallerCandidate, policyId: 'short-side-fill' })
    ])

    expect(compact.policyId).toBe('balanced-compactness')
    expect(taller.policyId).toBe('balanced-compactness')
    expect(IrregularPlacementScorer.Make.compare(compact, taller)).toBeLessThan(0)
  })

  it('lets edge contact prefer a longer shared padded boundary before compactness', async () => {
    const moving = movingGeometry('moving', rectanglePoints(4, 2))
    const placed = [placedGeometry('placed', rectanglePoints(4, 2), 0, 0)]
    const currentSheet = sheet(100, 10)
    const compactCandidate = baseInput(currentSheet, moving, candidate('moving', 4, 0), placed)
    const contactCandidate = baseInput(currentSheet, moving, candidate('moving', 0, 2), placed)

    const balancedCompact = await score(compactCandidate)
    const balancedContact = await score(contactCandidate)

    const compact = await score({
      ...compactCandidate,
      policyId: 'edge-contact-then-balanced-compactness'
    })
    const contact = await score({
      ...contactCandidate,
      policyId: 'edge-contact-then-balanced-compactness'
    })

    expect(compact.sharedCollisionBoundaryLengthMm).toBe(2)
    expect(contact.sharedCollisionBoundaryLengthMm).toBe(4)
    expect(IrregularPlacementScorer.Make.compare(balancedCompact, balancedContact)).toBeGreaterThan(
      0
    )
    expect(IrregularPlacementScorer.Make.compare(contact, compact)).toBeLessThan(0)
  })

  it('uses the policy selected through GeometrySettings when callers omit a gene', async () => {
    const moving = movingGeometry('piece', rectanglePoints(2, 2))
    const placed = [placedGeometry('placed', rectanglePoints(2, 2), 50, 0)]
    const currentSheet = sheet(100, 20)
    const balancedCandidate = baseInput(currentSheet, moving, candidate('piece', 0, 0), placed)
    const shortSideCandidate = baseInput(currentSheet, moving, candidate('piece', 0, 4), placed)

    const balanced = await scoreWithConfiguredPolicy(balancedCandidate, 'balanced-compactness')
    const shortSide = await scoreWithConfiguredPolicy(shortSideCandidate, 'short-side-fill')

    expect(balanced.policyId).toBe('balanced-compactness')
    expect(shortSide.policyId).toBe('short-side-fill')
  })

  it('reports the area and perimeter terms from the true combined collision span', async () => {
    const moving = movingGeometry('moving', rectanglePoints(2, 2))
    const result = await score(
      baseInput(sheet(20, 10), moving, candidate('moving', 1, 1), [
        placedGeometry('placed', rectanglePoints(2, 2), 10, 2)
      ])
    )

    expect(result.worstNormalizedSheetConsumption).toBe(0.55)
    expect(result.normalizedSheetSpanSum).toBeCloseTo(0.85)
    expect(result.usedClusterMaxSideMm).toBe(11)
    expect(result.usedClusterAreaMm2).toBe(33)
    expect(result.usedClusterSpanMm).toBe(14)
    expect(result.candidateBottomMm).toBe(1)
    expect(result.candidateLeftMm).toBe(1)
  })

  it('keeps max-side-first intrinsic ranking independent from sheet dimensions', async () => {
    const moving = movingGeometry('moving', rectanglePoints(1, 1))
    const placed = [placedGeometry('placed', rectanglePoints(1, 1), 0, 0)]
    const scorePair = async (currentSheet: SheetSpec) =>
      Promise.all([
        score(baseInput(currentSheet, moving, candidate('moving', 9, 4), placed)),
        score(baseInput(currentSheet, moving, candidate('moving', 7, 7), placed))
      ])

    const [landscapeWide, landscapeSquare] = await scorePair(sheet(100, 10))
    const [portraitWide, portraitSquare] = await scorePair(sheet(10, 100))

    expect(landscapeWide.usedClusterMaxSideMm).toBe(10)
    expect(landscapeSquare.usedClusterMaxSideMm).toBe(8)
    expect(IrregularPlacementScorer.Make.compare(landscapeWide, landscapeSquare)).toBeGreaterThan(0)
    expect(IrregularPlacementScorer.Make.compare(portraitWide, portraitSquare)).toBeGreaterThan(0)
    expect(
      compareIntrinsicCompactnessPlacementScores(landscapeWide, landscapeSquare)
    ).toBeGreaterThan(0)
    expect(
      compareIntrinsicCompactnessPlacementScores(portraitWide, portraitSquare)
    ).toBeGreaterThan(0)
  })

  it('canonicalizes translated local scores to the collision geometry grid', async () => {
    const moving = movingGeometry('moving', rectanglePoints(7.123, 3.456))
    const result = await score(
      baseInput(
        sheet(2_000_000, 2_000_000),
        moving,
        candidate('moving', 900_000.0004, 800_000.0004)
      )
    )

    expect(result.candidateBottomMm).toBe(800_000)
    expect(result.candidateLeftMm).toBe(900_000)
    expect(result.usedClusterAreaMm2).toBe(7.123 * 3.456)
    expect(result.usedClusterSpanMm).toBe(7.123 + 3.456)
  })

  it('uses translated moving polygon bounds for bottom and left', async () => {
    const moving = movingGeometry('moving', [
      point(-3, -2),
      point(1, -2),
      point(1, 2),
      point(-3, 2)
    ])
    const result = await score(baseInput(sheet(20, 20), moving, candidate('moving', 5, 6)))

    expect(result.candidateBottomMm).toBe(4)
    expect(result.candidateLeftMm).toBe(2)
  })

  it('derives the combined span from translated vertices when both polygons have negative local bounds', async () => {
    const moving = movingGeometry('moving', [
      point(-2, -1),
      point(1, -1),
      point(1, 2),
      point(-2, 2)
    ])
    const placed = [
      placedGeometry('placed', [point(-4, -3), point(-1, -3), point(-1, 1), point(-4, 1)], 11, 7)
    ]

    const result = await score(baseInput(sheet(20, 20), moving, candidate('moving', 3, 2), placed))

    expect(result.worstNormalizedSheetConsumption).toBe(0.45)
    expect(result.normalizedSheetSpanSum).toBe(0.8)
    expect(result.usedClusterAreaMm2).toBe(63)
    expect(result.usedClusterSpanMm).toBe(16)
    expect(result.candidateBottomMm).toBe(1)
    expect(result.candidateLeftMm).toBe(1)
  })

  it('leaves translation-equivalent candidates tied for upstream canonical ordering', async () => {
    const moving = movingGeometry('piece', rectanglePoints(1, 1))
    const inputs = [
      baseInput(sheet(10, 10), moving, candidate('piece', 4, 4)),
      baseInput(sheet(10, 10), moving, candidate('piece', 6, 0))
    ]

    const scores = await Promise.all(inputs.map(score))
    const first = scores[0]
    const second = scores[1]
    if (first === undefined || second === undefined) throw new Error('expected two scores')
    expect(IrregularPlacementScorer.Make.compare(first, second)).toBe(0)
  })

  it('resolves exact score ties by transform metadata and then piece id', async () => {
    const scoreFor = async (id: string, candidateTransform: IrregularTransformCandidate) => {
      const moving = movingGeometry(
        id,
        [point(-1, -1), point(1, -1), point(1, 1), point(-1, 1)],
        candidateTransform
      )
      return score(baseInput(sheet(10, 10), moving, candidate(id, 1, 1, candidateTransform)))
    }

    const lowerIndex = await scoreFor('piece', transform(0))
    const higherIndex = await scoreFor('piece', transform(1))
    expect(IrregularPlacementScorer.Make.compare(higherIndex, lowerIndex)).toBeGreaterThan(0)

    const lowerRotation = await scoreFor('piece', transform(1, 0))
    const higherRotation = await scoreFor('piece', transform(1, 90))
    expect(IrregularPlacementScorer.Make.compare(higherRotation, lowerRotation)).toBeGreaterThan(0)

    const unmirrored = await scoreFor('piece', transform(1, 0, false))
    const mirrored = await scoreFor('piece', transform(1, 0, true))
    expect(IrregularPlacementScorer.Make.compare(mirrored, unmirrored)).toBeGreaterThan(0)

    const configured = await scoreFor('piece', transform(1, 0, false, 'configured'))
    const edgeAligned = await scoreFor('piece', transform(1, 0, false, 'edge_alignment'))
    expect(IrregularPlacementScorer.Make.compare(edgeAligned, configured)).toBeGreaterThan(0)

    const firstPiece = await scoreFor('a-piece', transform(1))
    const secondPiece = await scoreFor('z-piece', transform(1))
    expect(IrregularPlacementScorer.Make.compare(secondPiece, firstPiece)).toBeGreaterThan(0)
  })

  it('scores candidates without deciding whether they are legal', async () => {
    const moving = movingGeometry('outside', rectanglePoints(1, 1))
    const result = await score(baseInput(sheet(2, 2), moving, candidate('outside', 5, 5)))

    expect(result.candidate.point).toEqual(point(5, 5))
  })

  it('returns a typed error for mismatched candidate metadata', async () => {
    const moving = movingGeometry('moving', rectanglePoints(1, 1))
    const failure = await Effect.runPromise(
      IrregularPlacementScorer.use((scorer) =>
        scorer.scoreCandidate(baseInput(sheet(10, 10), moving, candidate('other', 0, 0)))
      ).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined
        }),
        Effect.provide(IrregularPlacementScorer.Live)
      )
    )

    expect(failure).toBeInstanceOf(IrregularPlacementScoringError)
    expect(failure?.operation).toBe('scoreCandidate')
  })
})
