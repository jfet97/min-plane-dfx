import { ImportedPiece } from '@shared/domain/dxf.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import type { CollisionGeometry, IrregularPoint } from '@shared/irregular/domain.js'

export interface IrregularBenchmarkCorpusCase {
  readonly id: string
  readonly description: string
  readonly fixtureNames: ReadonlyArray<string>
  readonly fixtureAreasMm2: ReadonlyArray<number>
  readonly fixtureBoundingBoxAreasMm2: ReadonlyArray<number>
  readonly repeatCount: number
  readonly pieceCount: number
  readonly sheetWidth: number
  readonly sheetHeight: number
  readonly padding: number
}

export const DETERMINISTIC_GA_TIME_BUDGET_MS = 9_000_000_000_000_000

export const IRREGULAR_BENCHMARK_CORPUS: ReadonlyArray<IrregularBenchmarkCorpusCase> = [
  {
    id: 'triangle-trapezoid-20-500x300',
    description: '20 repeated triangle/trapezoid pieces on a capacity-sensitive sheet.',
    fixtureNames: ['triangle.dxf', 'trapezoid.dxf'],
    fixtureAreasMm2: [3150, 6375],
    fixtureBoundingBoxAreasMm2: [6300, 8625],
    repeatCount: 10,
    pieceCount: 20,
    sheetWidth: 500,
    sheetHeight: 300,
    padding: 0
  },
  {
    id: 'triangle-trapezoid-20-550x300',
    description: '20 repeated triangle/trapezoid pieces with a wider feasible sheet.',
    fixtureNames: ['triangle.dxf', 'trapezoid.dxf'],
    fixtureAreasMm2: [3150, 6375],
    fixtureBoundingBoxAreasMm2: [6300, 8625],
    repeatCount: 10,
    pieceCount: 20,
    sheetWidth: 550,
    sheetHeight: 300,
    padding: 0
  },
  {
    id: 'skewed-quad-12-330x160',
    description:
      '12 raw skewed quadrilaterals with a 3-by-4 axis-aligned feasibility witness.',
    fixtureNames: ['benchmark-skewed-quad.dxf'],
    fixtureAreasMm2: [3200],
    fixtureBoundingBoxAreasMm2: [4400],
    repeatCount: 12,
    pieceCount: 12,
    sheetWidth: 330,
    sheetHeight: 160,
    padding: 0
  }
]

export interface IrregularBenchmarkAreaFeasibilityBounds {
  readonly rawPieceAreaLowerBoundMm2: number
  readonly axisAlignedBoundingBoxAreaMm2: number
  readonly sheetAreaMm2: number
  readonly rawAreaSlackMm2: number
  readonly axisAlignedBoundingBoxAreaSlackMm2: number
  readonly rawAreaNecessaryConditionPasses: boolean
}

export function calculateAreaFeasibilityBounds(
  benchmarkCase: IrregularBenchmarkCorpusCase
): IrregularBenchmarkAreaFeasibilityBounds {
  if (
    benchmarkCase.fixtureNames.length !== benchmarkCase.fixtureAreasMm2.length ||
    benchmarkCase.fixtureNames.length !== benchmarkCase.fixtureBoundingBoxAreasMm2.length
  ) {
    throw new Error(`Area metadata does not match fixtures for ${benchmarkCase.id}.`)
  }

  const availablePieceCount = benchmarkCase.fixtureNames.length * benchmarkCase.repeatCount
  if (benchmarkCase.pieceCount > availablePieceCount) {
    throw new Error(`Piece budget exceeds repeated fixtures for ${benchmarkCase.id}.`)
  }

  let rawPieceAreaLowerBoundMm2 = 0
  let axisAlignedBoundingBoxAreaMm2 = 0
  let remainingPieceCount = benchmarkCase.pieceCount
  for (let fixtureIndex = 0; fixtureIndex < benchmarkCase.fixtureNames.length; fixtureIndex += 1) {
    const copyCount = Math.min(benchmarkCase.repeatCount, remainingPieceCount)
    const fixtureArea = benchmarkCase.fixtureAreasMm2[fixtureIndex]
    const fixtureBoundingBoxArea = benchmarkCase.fixtureBoundingBoxAreasMm2[fixtureIndex]
    if (fixtureArea === undefined || fixtureBoundingBoxArea === undefined) {
      throw new Error(`Area metadata is missing for ${benchmarkCase.id}.`)
    }
    rawPieceAreaLowerBoundMm2 += fixtureArea * copyCount
    axisAlignedBoundingBoxAreaMm2 += fixtureBoundingBoxArea * copyCount
    remainingPieceCount -= copyCount
  }

  const sheetAreaMm2 = benchmarkCase.sheetWidth * benchmarkCase.sheetHeight
  return {
    rawPieceAreaLowerBoundMm2,
    axisAlignedBoundingBoxAreaMm2,
    sheetAreaMm2,
    rawAreaSlackMm2: sheetAreaMm2 - rawPieceAreaLowerBoundMm2,
    axisAlignedBoundingBoxAreaSlackMm2: sheetAreaMm2 - axisAlignedBoundingBoxAreaMm2,
    rawAreaNecessaryConditionPasses: rawPieceAreaLowerBoundMm2 <= sheetAreaMm2
  }
}

export interface IrregularBenchmarkProfile {
  readonly id: string
  readonly description: string
  readonly corpusCaseId: string
  readonly orderWindow: number
  readonly beamWidth: number
  readonly localCandidateFanout: number
  readonly transformCap: number
  readonly freeMaterialOperation: 'union-then-difference' | 'direct-difference'
  readonly nfpConstruction: 'linear-edge-merge' | 'vertex-pair-hull'
  readonly gaEnabled: boolean
  readonly baselineOnly: boolean
  readonly gaPopulation: number
  readonly gaGenerationBudget: number
  readonly gaEvaluationBudget: number
  readonly gaTimeBudgetMs: number
  readonly gaSeed: string
  readonly priorityOrderMutationEnabled: boolean
  readonly transformPreferenceMutationEnabled: boolean
  readonly placementPolicyMutationEnabled: boolean
}

export const IRREGULAR_BENCHMARK_PROFILES: ReadonlyArray<IrregularBenchmarkProfile> = [
  {
    id: 'near-capacity-beam-1',
    description: 'Deterministic narrow beam baseline for the 500x300 case.',
    corpusCaseId: 'triangle-trapezoid-20-500x300',
    orderWindow: 2,
    beamWidth: 1,
    localCandidateFanout: 2,
    transformCap: 4,
    freeMaterialOperation: 'union-then-difference',
    nfpConstruction: 'vertex-pair-hull',
    gaEnabled: false,
    baselineOnly: true,
    gaPopulation: 4,
    gaGenerationBudget: 3,
    gaEvaluationBudget: 12,
    gaTimeBudgetMs: DETERMINISTIC_GA_TIME_BUDGET_MS,
    gaSeed: 'near-capacity-20',
    priorityOrderMutationEnabled: true,
    transformPreferenceMutationEnabled: true,
    placementPolicyMutationEnabled: true
  },
  {
    id: 'near-capacity-beam-4',
    description: 'Wider deterministic beam baseline for the 500x300 case.',
    corpusCaseId: 'triangle-trapezoid-20-500x300',
    orderWindow: 2,
    beamWidth: 4,
    localCandidateFanout: 2,
    transformCap: 4,
    freeMaterialOperation: 'union-then-difference',
    nfpConstruction: 'vertex-pair-hull',
    gaEnabled: false,
    baselineOnly: true,
    gaPopulation: 4,
    gaGenerationBudget: 3,
    gaEvaluationBudget: 12,
    gaTimeBudgetMs: DETERMINISTIC_GA_TIME_BUDGET_MS,
    gaSeed: 'near-capacity-20',
    priorityOrderMutationEnabled: true,
    transformPreferenceMutationEnabled: true,
    placementPolicyMutationEnabled: true
  },
  {
    id: 'near-capacity-ga-lite',
    description: 'Low-budget seeded GA comparison with the same count and a different score.',
    corpusCaseId: 'triangle-trapezoid-20-500x300',
    orderWindow: 2,
    beamWidth: 4,
    localCandidateFanout: 2,
    transformCap: 4,
    freeMaterialOperation: 'union-then-difference',
    nfpConstruction: 'vertex-pair-hull',
    gaEnabled: true,
    baselineOnly: false,
    gaPopulation: 2,
    gaGenerationBudget: 1,
    gaEvaluationBudget: 2,
    gaTimeBudgetMs: DETERMINISTIC_GA_TIME_BUDGET_MS,
    gaSeed: 'near-capacity-alt',
    priorityOrderMutationEnabled: true,
    transformPreferenceMutationEnabled: true,
    placementPolicyMutationEnabled: true
  },
  {
    id: 'near-capacity-ga',
    description: 'Bounded seeded GA comparison for the 500x300 case.',
    corpusCaseId: 'triangle-trapezoid-20-500x300',
    orderWindow: 2,
    beamWidth: 4,
    localCandidateFanout: 2,
    transformCap: 4,
    freeMaterialOperation: 'union-then-difference',
    nfpConstruction: 'vertex-pair-hull',
    gaEnabled: true,
    baselineOnly: false,
    gaPopulation: 4,
    gaGenerationBudget: 3,
    gaEvaluationBudget: 12,
    gaTimeBudgetMs: DETERMINISTIC_GA_TIME_BUDGET_MS,
    gaSeed: 'near-capacity-20',
    priorityOrderMutationEnabled: true,
    transformPreferenceMutationEnabled: true,
    placementPolicyMutationEnabled: true
  },
  {
    id: 'near-capacity-wide-beam-4',
    description: 'Wider deterministic beam proving the second capacity case is feasible.',
    corpusCaseId: 'triangle-trapezoid-20-550x300',
    orderWindow: 2,
    beamWidth: 4,
    localCandidateFanout: 2,
    transformCap: 4,
    freeMaterialOperation: 'union-then-difference',
    nfpConstruction: 'vertex-pair-hull',
    gaEnabled: false,
    baselineOnly: true,
    gaPopulation: 4,
    gaGenerationBudget: 3,
    gaEvaluationBudget: 12,
    gaTimeBudgetMs: DETERMINISTIC_GA_TIME_BUDGET_MS,
    gaSeed: 'near-capacity-wide-20',
    priorityOrderMutationEnabled: true,
    transformPreferenceMutationEnabled: true,
    placementPolicyMutationEnabled: true
  },
  {
    id: 'near-capacity-skewed-beam-1',
    description: 'Narrow beam profile for the raw skewed-quad feasibility case.',
    corpusCaseId: 'skewed-quad-12-330x160',
    orderWindow: 1,
    beamWidth: 1,
    localCandidateFanout: 2,
    transformCap: 4,
    freeMaterialOperation: 'union-then-difference',
    nfpConstruction: 'vertex-pair-hull',
    gaEnabled: false,
    baselineOnly: true,
    gaPopulation: 4,
    gaGenerationBudget: 3,
    gaEvaluationBudget: 12,
    gaTimeBudgetMs: DETERMINISTIC_GA_TIME_BUDGET_MS,
    gaSeed: 'skewed-quad-12',
    priorityOrderMutationEnabled: true,
    transformPreferenceMutationEnabled: true,
    placementPolicyMutationEnabled: true
  },
  {
    id: 'near-capacity-skewed-beam-4',
    description:
      'Wider same-count profile for comparing raw skewed-quad layout usability.',
    corpusCaseId: 'skewed-quad-12-330x160',
    orderWindow: 2,
    beamWidth: 4,
    localCandidateFanout: 4,
    transformCap: 4,
    freeMaterialOperation: 'union-then-difference',
    nfpConstruction: 'vertex-pair-hull',
    gaEnabled: false,
    baselineOnly: true,
    gaPopulation: 4,
    gaGenerationBudget: 3,
    gaEvaluationBudget: 12,
    gaTimeBudgetMs: DETERMINISTIC_GA_TIME_BUDGET_MS,
    gaSeed: 'skewed-quad-12',
    priorityOrderMutationEnabled: true,
    transformPreferenceMutationEnabled: true,
    placementPolicyMutationEnabled: true
  }
]

export const IRREGULAR_DXF_FIXTURES = [
  'benchmark-skewed-quad.dxf',
  'angled-profile.dxf',
  'circle-ellipse-arcs.dxf',
  'concave-and-stars.dxf',
  'convex-polygons.dxf',
  'duplicate-points.dxf',
  'high-padding.dxf',
  'mixed-sheet-like-screenshot.dxf',
  'near-collinear.dxf',
  'open-contour.dxf',
  'repeated-mixed-pieces.dxf',
  'rounded-rectangle.dxf',
  'star-5-point.dxf',
  'thin-and-awkward.dxf',
  'tiny-segments.dxf',
  'transform-cases.dxf',
  'trapezoid.dxf',
  'triangle.dxf',
  'unsupported-entities.dxf'
] as const

export const VALID_SINGLE_OUTLINE_FIXTURES = [
  'benchmark-skewed-quad.dxf',
  'angled-profile.dxf',
  'high-padding.dxf',
  'near-collinear.dxf',
  'rounded-rectangle.dxf',
  'star-5-point.dxf',
  'tiny-segments.dxf',
  'trapezoid.dxf',
  'triangle.dxf'
] as const

export const INVALID_OUTLINE_FIXTURES = [
  'circle-ellipse-arcs.dxf',
  'concave-and-stars.dxf',
  'convex-polygons.dxf',
  'duplicate-points.dxf',
  'mixed-sheet-like-screenshot.dxf',
  'open-contour.dxf',
  'repeated-mixed-pieces.dxf',
  'thin-and-awkward.dxf',
  'transform-cases.dxf',
  'unsupported-entities.dxf'
] as const

export interface CollisionOpportunityMetrics {
  readonly convexHullAreaMm2: number
  readonly convexHullBoundingBoxAreaMm2: number
  readonly convexHullToBoundingBoxRatio: number
  readonly collisionPolygonAreaMm2: number
  readonly paddedBoundingBoxAreaMm2: number
  readonly collisionPolygonToPaddedBoundingBoxRatio: number
}

export function polygonArea(points: ReadonlyArray<IrregularPoint>): number {
  let crossSum = 0
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]
    const second = points[(index + 1) % points.length]
    if (first === undefined || second === undefined) return Number.NaN
    crossSum += first.x * second.y - second.x * first.y
  }
  return Math.abs(crossSum / 2)
}

export function polygonBoundingBoxArea(points: ReadonlyArray<IrregularPoint>): number {
  const first = points[0]
  if (first === undefined) return Number.NaN

  let minX = first.x
  let minY = first.y
  let maxX = first.x
  let maxY = first.y
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return (maxX - minX) * (maxY - minY)
}

export function collisionOpportunityMetrics(
  geometry: CollisionGeometry
): CollisionOpportunityMetrics {
  const convexHullAreaMm2 = polygonArea(geometry.convexHull.points)
  const convexHullBoundingBoxAreaMm2 = polygonBoundingBoxArea(geometry.convexHull.points)
  const collisionPolygonAreaMm2 = polygonArea(geometry.collisionPolygon.points)
  const paddedBoundingBoxAreaMm2 = polygonBoundingBoxArea(geometry.collisionPolygon.points)
  return {
    convexHullAreaMm2,
    convexHullBoundingBoxAreaMm2,
    convexHullToBoundingBoxRatio: convexHullAreaMm2 / convexHullBoundingBoxAreaMm2,
    collisionPolygonAreaMm2,
    paddedBoundingBoxAreaMm2,
    collisionPolygonToPaddedBoundingBoxRatio: collisionPolygonAreaMm2 / paddedBoundingBoxAreaMm2
  }
}

export function repeatImportedPieces(
  sources: ReadonlyArray<ImportedPiece>,
  copiesPerSource: number
): ReadonlyArray<ImportedPiece> {
  return sources.flatMap((source) =>
    Array.from({ length: copiesPerSource }, (_, copyIndex) => {
      const copyId = `${source.id}-copy-${copyIndex + 1}`
      return new ImportedPiece({
        ...source,
        id: PieceId.make(copyId),
        sourceFileId: SourceFileId.make(`${source.sourceFileId}-${copyIndex + 1}`),
        label: `${source.label} copy ${copyIndex + 1}`
      })
    })
  )
}
