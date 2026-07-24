import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  INTRINSIC_SHORT_SIDE_OBSERVER_MAX_RUNTIME_MS,
  INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES,
  observeIntrinsicShortSideOrientations
} from '../../src/workers/algorithm/irregular/intrinsicShortSideObserver.js'
import type { IntrinsicSharedArchiveEndpoint } from '../../src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.js'
import type { IntrinsicStrictCompletedMetrics } from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import { canonicalCollisionLayoutIdentity } from '../../src/workers/irregular/canonicalLayoutGeometry.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function placedRectangle(id: string, width: number, height: number): IrregularPlacedPiece {
  const pieceId = PieceId.make(id)
  const points = [point(0, 0), point(width, 0), point(width, height), point(0, height)]
  const polygon = new IrregularPolygon({ points })
  const transform = new IrregularTransformCandidate({
    index: 0,
    rotationDeg: 0,
    mirrored: false,
    reason: 'configured'
  })
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId,
      sourcePieceId: pieceId,
      placementReference: point(0, 0),
      transform: new IrregularTransform({
        translateX: 0,
        translateY: 0,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: pieceId,
      transform,
      polygon,
      bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: width, maxY: height })
    })
  })
}

function endpoint(
  role: string,
  width: number,
  height: number,
  input: {
    readonly cavities?: number
    readonly hullGapRatio?: number
    readonly cohesionPasses?: boolean
    readonly cohesionDeficit?: number
  } = {}
): IntrinsicSharedArchiveEndpoint {
  const placedCollisionGeometries = [placedRectangle(role, width, height)]
  const identity = canonicalCollisionLayoutIdentity(placedCollisionGeometries)
  if (identity === undefined) throw new Error('test endpoint must have a canonical identity')
  const hash = createHash('sha256').update(identity).digest('hex')
  const metrics: IntrinsicStrictCompletedMetrics = {
    envelopeMaximumSideMm: Math.max(width, height),
    envelopeAreaMm2: width * height,
    envelopeSpanMm: width + height,
    enclosedCavityCount: input.cavities ?? 0,
    totalEnclosedCavityAreaMm2: 0,
    largestOccupiedHullGapRatio: input.hullGapRatio ?? 0,
    isolatedPieceCount: 0,
    positiveContactComponentCount: 1,
    largestPositiveContactComponentSize: 1,
    largestPositiveContactComponentRatio: 1,
    occupiedAreaOutsideLargestContactComponentMm2: 0,
    occupiedHullWasteRatio: 0,
    totalStructuralContacts: 0,
    dominantStructuralContacts: 0,
    contactUnits: 0,
    sharedBoundaryLengthMm: 0,
    canonicalGeometryHash: hash,
    runtimeMs: 0
  }
  return {
    role,
    sourceId: undefined,
    sheetlessCanonicalGeometryIdentity: identity,
    sheetlessCanonicalGeometryHash: hash,
    placedCollisionGeometries,
    metrics,
    certificate: {
      passes: input.cohesionPasses ?? true,
      violatedFloors: [],
      relativeDeficitSum: input.cohesionDeficit ?? 0
    },
    requestedSheetFit: {
      q0: { fits: true, canonicalGeometryHash: hash },
      q90: { fits: true, canonicalGeometryHash: hash },
      selectedRotationDeg: 0,
      selectedCanonicalGeometryHash: hash,
      selectedPlacedCollisionGeometries: placedCollisionGeometries
    }
  }
}

function deterministicClock(...readings: ReadonlyArray<number>): () => number {
  let index = 0
  return () => readings[Math.min(index++, readings.length - 1)] ?? 0
}

describe('intrinsic short-side observer', () => {
  it('minimizes requested long-axis span before rewarding short-axis fill', () => {
    const fullShortSide = endpoint('full-short-side', 4, 6)
    const shorterLongAxis = endpoint('shorter-long-axis', 3, 5)
    const trace = observeIntrinsicShortSideOrientations({
      sheet: new SheetSpec({ width: 10, height: 6, label: 'landscape' }),
      endpoints: [fullShortSide, shorterLongAxis],
      now: deterministicClock(0, 1)
    })

    expect(trace.status).toBe('observed')
    expect(trace.observerWinnerCanonicalGeometryHash).toBe(
      shorterLongAxis.sheetlessCanonicalGeometryHash
    )
    expect(trace.observerWinnerRotationDeg).toBe(0)
    expect(trace.endpoints.find(({ role }) => role === 'shorter-long-axis')?.selected).toMatchObject({
      exactLegal: true,
      requestedLongAxisUsedSpanMm: 3,
      requestedShortAxisShortfallMm: 1
    })
    expect(trace.placementEvaluations).toBe(0)
    expect(trace.candidateEvaluations).toBe(0)
    expect(trace.outputInfluence).toBe('none')
  })

  it('rejects a shorter but geometrically dominated wasteful strip before ranking', () => {
    const production = endpoint('production', 487.983, 152.522, {
      hullGapRatio: 0.029_710_516_900_773_094
    })
    const wastefulStrip = endpoint('wasteful-strip', 1_513.5, 88.288, {
      hullGapRatio: 0.5
    })
    const trace = observeIntrinsicShortSideOrientations({
      sheet: new SheetSpec({ width: 2_000, height: 2_700, label: 'portrait' }),
      endpoints: [production, wastefulStrip],
      now: deterministicClock(0, 1)
    })

    expect(trace.status).toBe('observed')
    expect(trace.observerWinnerCanonicalGeometryHash).toBe(
      production.sheetlessCanonicalGeometryHash
    )
    expect(
      trace.endpoints.find(({ role }) => role === 'wasteful-strip')
    ).toMatchObject({
      cavityHullGuardEligible: false,
      geometricParetoEligible: false
    })
    expect(trace.cavityHullGuardEligibleEndpointCount).toBe(1)
    expect(trace.geometricParetoEligibleEndpointCount).toBe(1)
  })

  it('preserves endpoint selection and swaps orientation on a transposed sheet', () => {
    const fullShortSide = endpoint('full-short-side', 4, 6)
    const shorterLongAxis = endpoint('shorter-long-axis', 3, 5)
    const landscape = observeIntrinsicShortSideOrientations({
      sheet: new SheetSpec({ width: 10, height: 6, label: 'landscape' }),
      endpoints: [fullShortSide, shorterLongAxis],
      now: deterministicClock(0, 1)
    })
    const portrait = observeIntrinsicShortSideOrientations({
      sheet: new SheetSpec({ width: 6, height: 10, label: 'portrait' }),
      endpoints: [fullShortSide, shorterLongAxis],
      now: deterministicClock(0, 1)
    })

    expect(portrait.observerWinnerCanonicalGeometryHash).toBe(
      landscape.observerWinnerCanonicalGeometryHash
    )
    expect(landscape.observerWinnerRotationDeg).toBe(0)
    expect(portrait.observerWinnerRotationDeg).toBe(90)
    expect(portrait.endpoints.find(({ role }) => role === 'shorter-long-axis')?.selected).toMatchObject(
      {
        requestedLongAxisUsedSpanMm: 3,
        requestedShortAxisShortfallMm: 1
      }
    )
  })

  it('uses deterministic intrinsic behavior without a directional shortfall on square sheets', () => {
    const candidate = endpoint('square-candidate', 4, 2)
    const trace = observeIntrinsicShortSideOrientations({
      sheet: new SheetSpec({ width: 6, height: 6, label: 'square' }),
      endpoints: [candidate],
      now: deterministicClock(10, 20)
    })

    expect(trace.requestedLongAxis).toBe('square')
    expect(trace.endpoints[0]?.q0.requestedShortAxisShortfallMm).toBe(0)
    expect(trace.endpoints[0]?.q90.requestedShortAxisShortfallMm).toBe(0)
    expect(trace.endpoints[0]?.q0.requestedLongAxisUsedSpanMm).toBe(4)
    expect(trace.endpoints[0]?.q90.requestedLongAxisUsedSpanMm).toBe(4)
    expect(trace.runtimeMs).toBe(10)
    expect(trace.runtimeBudgetExceeded).toBe(false)
  })

  it('does not select an endpoint when neither orientation is exactly legal', () => {
    const trace = observeIntrinsicShortSideOrientations({
      sheet: new SheetSpec({ width: 3, height: 3, label: 'too small' }),
      endpoints: [endpoint('does-not-fit', 4, 2)],
      now: deterministicClock(0, 1)
    })

    expect(trace.status).toBe('observed-no-legal-orientation')
    expect(trace.observerWinnerCanonicalGeometryHash).toBeUndefined()
    expect(trace.observerWinnerRotationDeg).toBeUndefined()
    expect(trace.rankedCanonicalGeometryHashes).toEqual([])
  })

  it('reports an explicit zero-work skip when no complete archive settled', () => {
    const trace = observeIntrinsicShortSideOrientations({
      sheet: new SheetSpec({ width: 600, height: 400, label: 'preflight miss' }),
      endpoints: [],
      now: deterministicClock(0, 0)
    })

    expect(trace).toMatchObject({
      status: 'skipped-no-settled-complete-endpoints',
      outputInfluence: 'none',
      settledEndpointCount: 0,
      evaluatedOrientationCount: 0,
      cavityHullGuardEligibleEndpointCount: 0,
      geometricParetoEligibleEndpointCount: 0,
      placementEvaluations: 0,
      candidateEvaluations: 0,
      runtimeMs: 0,
      runtimeBudgetExceeded: false,
      endpoints: [],
      rankedCanonicalGeometryHashes: []
    })
    expect(trace.serializedTraceBytes).toBeLessThanOrEqual(
      INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES
    )
  })

  it('censors the observer result when trace materialization exceeds the runtime budget', () => {
    const candidate = endpoint('candidate', 3, 5)
    const trace = observeIntrinsicShortSideOrientations({
      sheet: new SheetSpec({ width: 10, height: 6, label: 'budget' }),
      endpoints: [candidate],
      now: deterministicClock(0, INTRINSIC_SHORT_SIDE_OBSERVER_MAX_RUNTIME_MS + 1)
    })

    expect(trace.status).toBe('runtime-budget-exceeded')
    expect(trace.runtimeBudgetExceeded).toBe(true)
    expect(trace.serializedTraceBytes).toBeGreaterThan(0)
    expect(trace.serializedTraceBytes).toBeLessThanOrEqual(
      INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES
    )
    expect(trace.observerWinnerCanonicalGeometryHash).toBeUndefined()
    expect(trace.observerWinnerRotationDeg).toBeUndefined()
    expect(trace.rankedCanonicalGeometryHashes).toEqual([])
    expect(trace.endpoints).toEqual([])
  })
})
