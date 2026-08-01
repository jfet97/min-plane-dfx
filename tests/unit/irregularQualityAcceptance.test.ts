import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  assessIrregularQualityFacts,
  assertIrregularQualityPolicy,
  classifyIrregularQualityDifferential,
  exactIrregularPiecePartition,
  makeCompactIrregularQualityPolicy,
  makeIrregularQualityFacts,
  makeShortSideIrregularQualityPolicy,
  measureIrregularUnsnappedTranslatedEnvelope,
  type IrregularQualityFacts,
  type IrregularQualityPolicy
} from '../../src/workers/irregular/differential/irregularQualityAcceptance.js'
import { executeIrregularQualityAcceptance } from '../../src/workers/irregular/differential/irregularQualityRunner.js'
import type { IrregularComputeResult } from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import type { NestingRequest } from '@shared/domain/nesting.js'
import type { IrregularNestingSettings } from '@shared/irregular/domain.js'
import { canonicalCollisionLayoutIdentity } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { measureIntrinsicShortSideDirectionalReference } from '../../src/workers/algorithm/irregular/intrinsicShortSideObserver.js'
import { measureIntrinsicShortSidePairFoldGeometryEvidence } from '../../src/workers/algorithm/irregular/intrinsicShortSidePairFoldObserver.js'
import { prepareCsvPieces } from '@shared/prepareCsvPieces.js'
import type { CsvCutRow } from '@shared/domain/project.js'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { JobId, PieceId } from '@shared/domain/ids.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularPlacement,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { WorkerResponseFailureError } from '@shared/protocol/worker.js'

const compactPolicy = makeCompactIrregularQualityPolicy({
  thresholds: {
    minimumPlacedCount: 2,
    maximumAreaMm2: 100,
    maximumCanonicalCavities: 0,
    maximumPositiveContactComponentCount: 1,
    maximumIsolatedPieceCount: 0,
    minimumLargestPositiveContactComponentSize: 2,
    maximumOccupiedHullGapRatio: 1,
    maximumOccupiedEnvelopeAspectRatio: 10
  },
  capacity: { kind: 'not-required' },
  cohesion: { kind: 'not-required' }
})

const noQualityWarmPrefixExpectation = {
  status: undefined,
  outputInfluence: undefined,
  sourceRole: undefined,
  prefixDepth: undefined,
  endpointCanonicalGeometryHash: undefined
} as const

function facts(overrides: Partial<IrregularQualityFacts> = {}): IrregularQualityFacts {
  return {
    backend: 'typescript',
    requestedPieceIds: ['a', 'b'],
    placedPieceIds: ['a', 'b'],
    unplacedPieceIds: [],
    legalGeometry: true,
    provenanceValid: true,
    placedCount: 2,
    areaMm2: 100,
    canonicalCavities: 0,
    topology: {
      positiveContactComponentCount: 1,
      isolatedPieceCount: 0,
      largestPositiveContactComponentSize: 2,
      largestOccupiedHullGapRatio: 0,
      occupiedEnvelopeAspectRatio: 1
    },
    capacityContractValid: true,
    schedulerTraceValid: true,
    shortSideContractValid: undefined,
    cohesionContractValid: undefined,
    canonicalGeometryHash: 'typescript-layout',
    ...overrides
  }
}

function failure(message: string): WorkerResponseFailureError {
  return new WorkerResponseFailureError({
    code: 'worker_protocol_error',
    message,
    context: { reason: 'test' }
  })
}

function twoPieceGeometryFixture(): {
  readonly request: NestingRequest
  readonly result: IrregularComputeResult
  readonly prepared: ReadonlyArray<IrregularPreparedPiece>
} {
  const makePiece = (pieceId: string, sourcePieceId: string, translateX: number) => {
    const pieceIdValue = pieceId as never
    const sourcePieceIdValue = sourcePieceId as never
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]
    const pointValues = points.map(({ x, y }) => new IrregularPoint({ x, y }))
    const polygon = new IrregularPolygon({ points: pointValues })
    const geometry = new CollisionGeometry({
      sourcePieceId: sourcePieceIdValue,
      sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
      sampledPoints: pointValues,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: new IrregularPoint({ x: 0, y: 0 }),
      diagnostics: []
    })
    const transform = new IrregularTransformCandidate({
      index: 0,
      rotationDeg: 0,
      mirrored: false,
      reason: 'orthogonal'
    })
    const prepared = new IrregularPreparedPiece({
      pieceId: pieceIdValue,
      source: { id: sourcePieceIdValue } as never,
      allowMirror: false,
      collisionGeometry: geometry,
      transforms: [transform]
    })
    const placed = new IrregularPlacedPiece({
      placement: new IrregularPlacement({
        pieceId: pieceIdValue,
        sourcePieceId: sourcePieceIdValue,
        transform: new IrregularTransform({
          translateX,
          translateY: 0,
          rotationDeg: 0,
          mirrored: false
        })
      }),
      collisionGeometry: new TransformedCollisionGeometry({
        sourcePieceId: sourcePieceIdValue,
        transform,
        polygon,
        bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
      })
    })
    return { prepared, placed }
  }
  const first = makePiece('a', 'source-a', 0)
  const second = makePiece('b', 'source-b', 20)
  return {
    request: {
      pieces: [
        { id: 'a', sourcePieceId: 'source-a' },
        { id: 'b', sourcePieceId: 'source-b' }
      ],
      sheet: { width: 100, height: 100 }
    } as unknown as NestingRequest,
    result: {
      placedCollisionGeometries: [first.placed, second.placed],
      unplacedPieceIds: [],
      portfolio: { terminationReason: 'capacity_subset_settled' }
    } as unknown as IrregularComputeResult,
    prepared: [first.prepared, second.prepared]
  }
}

function capacityTraceForFixture(
  canonicalGeometryHash: string,
  overrides: Record<string, unknown> = {}
): NonNullable<IrregularComputeResult['capacityTrace']> {
  return {
    routing: 'bounded-complete-archive-miss',
    preflight: {},
    prefixes: {},
    prefixIncumbent: undefined,
    coldSearch: {
      settlement: 'settled',
      auxiliaryPlacementEvaluations: 0,
      completedDepths: 2,
      pieceCount: 2
    },
    warmPrefixLanes: [],
    warmPrefixEndpointsAdmitted: false,
    cohesionShadow: undefined,
    qualityWarmPrefix: undefined,
    laneCoordinator: {
      version: 'intrinsic-capacity-lane-coordinator-v3',
      aggregatePlacementEvaluationCap: 1,
      aggregateConsumedPlacementEvaluations: 0,
      warmPilotDepthBoundaries: 0,
      continuedProducers: [],
      retainedCheckpointCount: 0,
      censoredLaneCount: 0,
      quanta: [
        {
          ordinal: 0,
          producerRole: 'capacity-cold',
          sourceRole: undefined,
          prefixDepth: undefined,
          phase: 'initial',
          fromDepth: 0,
          toDepth: 2,
          placementEvaluationDelta: 0,
          outcome: 'settled'
        }
      ]
    },
    selected: {
      placedCount: 2,
      placedDoubledMaterialAreaGrid2: 200_000_000n,
      enclosedCavityCount: 0,
      totalEnclosedCavityAreaMm2: 0,
      totalEnclosedCavityDoubledAreaGrid2: '0',
      envelopeMaximumSideMm: 30,
      envelopeAreaMm2: 300,
      envelopeSpanMm: 30,
      envelopeMaximumSideGrid: 30_000,
      envelopeAreaGrid2: '300000000',
      envelopeSpanGrid: 30_000,
      canonicalGeometryHash,
      origin: 'cold-search',
      prefixDepth: undefined,
      sourceRole: undefined,
      unplacedCount: 0,
      placedMaterialAreaMm2: 100,
      selectedRotationDeg: 0
    },
    preflightRuntimeMs: 0,
    completeArchiveRuntimeMs: 0,
    prefixTerminalizationMs: 0,
    coldSearchMs: 0,
    runtimeMs: 0,
    ...overrides
  } as never
}

describe('irregular quality policy validation', () => {
  it('rejects an empty policy instead of silently disabling quality gates', () => {
    expect(() =>
      makeCompactIrregularQualityPolicy({
        thresholds: {} as never,
        capacity: {} as never,
        cohesion: {} as never
      })
    ).toThrow()
  })

  it('rejects threshold objects with missing canonical field names', () => {
    const thresholds = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`threshold-${index}`, 0])
    ) as never
    expect(() =>
      makeCompactIrregularQualityPolicy({
        thresholds,
        capacity: { kind: 'not-required' },
        cohesion: { kind: 'not-required' }
      })
    ).toThrow('Irregular quality policy requires all finite non-negative thresholds.')
  })

  it('rejects a forged policy before deriving quality facts', () => {
    const fixture = geometryFixtureForEvidence()
    expect(() =>
      makeIrregularQualityFacts({
        backend: 'typescript',
        request: fixture.request,
        result: fixture.result,
        policy: { ...compactPolicy, thresholds: {} } as never,
        geometryAuthority: []
      })
    ).toThrow('Irregular quality policy requires all finite non-negative thresholds.')
  })

  it('requires explicit cohesion area-bound semantics', () => {
    expect(() =>
      makeCompactIrregularQualityPolicy({
        thresholds: compactPolicy.thresholds,
        capacity: { kind: 'not-required' },
        cohesion: {
          kind: 'required',
          minimumPlacedCount: 0,
          maximumCavities: 0,
          maximumEnvelopeMaximumSideMm: 100,
          maximumEnvelopeAreaMm2: 100,
          maximumPositiveContactComponentCount: 1,
          maximumIsolatedPieceCount: 0,
          requireLargestComponentContainsEveryPlacedPiece: true
        } as never
      })
    ).toThrow('Required cohesion policy is incomplete.')
  })

  it('rejects a required capacity policy without selected producer identities', () => {
    expect(() =>
      makeCompactIrregularQualityPolicy({
        thresholds: compactPolicy.thresholds,
        capacity: {
          kind: 'required',
          allowedRoutings: ['bounded-complete-archive-miss'],
          expectedTerminationReason: 'capacity_subset_settled',
          requireColdOnlyDominance: false
        } as never,
        cohesion: { kind: 'not-required' }
      })
    ).toThrow('Required capacity policy needs selected endpoint origins.')
  })

  it('rejects a forged incomplete Short Side policy at the validation boundary', () => {
    expect(() =>
      assertIrregularQualityPolicy({
        ...compactPolicy,
        objectiveProfile: 'short-side',
        shortSide: { kind: 'required', selectedPieceIds: [] }
      } as never)
    ).toThrow('Short Side quality policy requires a non-empty selected piece set.')
  })

  it('derives Short Side requirements from the objective profile', () => {
    const policy = makeShortSideIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' },
      selectedPieceIds: ['a', 'b']
    })

    const assessment = assessIrregularQualityFacts(
      facts({ shortSideContractValid: undefined }),
      policy
    )

    expect(assessment.hardInvariantFailures).toContain('shortSideDirectionalGeometry')
  })
})

describe('irregular quality differential classification', () => {
  it('classifies exact semantic parity with accepted quality as exact-match', () => {
    const result = classifyIrregularQualityDifferential({
      semanticDivergence: undefined,
      typescript: { ok: true, facts: facts() },
      rust: { ok: true, facts: facts({ backend: 'rust' }) },
      policy: compactPolicy
    })

    expect(result.category).toBe('exact-match')
    expect(result.accepted).toBe(true)
  })

  it('classifies a legal different Rust layout as different-but-quality-accepted', () => {
    const result = classifyIrregularQualityDifferential({
      semanticDivergence: {
        path: 'value.canonicalGeometryHash',
        typescript: 'typescript-layout',
        rust: 'rust-layout'
      },
      typescript: { ok: true, facts: facts() },
      rust: {
        ok: true,
        facts: facts({ backend: 'rust', canonicalGeometryHash: 'rust-layout' })
      },
      policy: compactPolicy
    })

    expect(result.category).toBe('different-but-quality-accepted')
    expect(result.accepted).toBe(true)
    expect(result.semanticDivergence?.path).toBe('value.canonicalGeometryHash')
  })

  it('classifies equal typed backend failures as exact-match diagnostics without accepting them', () => {
    const error = failure('no valid layout')
    const result = classifyIrregularQualityDifferential({
      semanticDivergence: undefined,
      typescript: { ok: false, error },
      rust: { ok: false, error },
      policy: compactPolicy
    })

    expect(result.category).toBe('exact-match')
    expect(result.accepted).toBe(false)
    expect(result.backendFailures).toEqual(['typescript', 'rust'])
  })

  it('keeps mismatched typed failures as a hard invariant with exact divergence', () => {
    const semanticDivergence = {
      path: 'error.message',
      typescript: 'typescript failure',
      rust: 'rust failure'
    }
    const result = classifyIrregularQualityDifferential({
      semanticDivergence,
      typescript: { ok: false, error: failure('typescript failure') },
      rust: { ok: false, error: failure('rust failure') },
      policy: compactPolicy
    })

    expect(result.category).toBe('hard-invariant-failure')
    expect(result.accepted).toBe(false)
    expect(result.semanticDivergence).toEqual(semanticDivergence)
  })

  it('rejects malformed placed IDs before partition validation can discard them', () => {
    expect(exactIrregularPiecePartition(['a'], [undefined as never], [])).toBe(false)
  })

  it.each([
    ['provenance', { provenanceValid: false }],
    ['geometry', { legalGeometry: false }],
    ['capacity', { capacityContractValid: false }],
    ['scheduler', { schedulerTraceValid: false }],
    ['cohesion', { cohesionContractValid: false }]
  ])('classifies invalid %s evidence as hard-invariant-failure', (_name, overrides) => {
    const policy: IrregularQualityPolicy = {
      ...compactPolicy,
      cohesion: {
        kind: 'required',
        minimumPlacedCount: 2,
        maximumCavities: 0,
        maximumEnvelopeMaximumSideMm: 100,
        maximumEnvelopeAreaMm2: 100,
        maximumEnvelopeAreaInclusive: true,
        maximumPositiveContactComponentCount: 1,
        maximumIsolatedPieceCount: 0,
        requireLargestComponentContainsEveryPlacedPiece: true
      }
    }
    const result = classifyIrregularQualityDifferential({
      semanticDivergence: undefined,
      typescript: { ok: true, facts: facts() },
      rust: { ok: true, facts: facts({ backend: 'rust', ...overrides }) },
      policy
    })

    expect(result.category).toBe('hard-invariant-failure')
    expect(result.accepted).toBe(false)
  })

  it('uses the maintained unsnapped area tolerance at, inside, and beyond the boundary', () => {
    const policy = makeCompactIrregularQualityPolicy({
      thresholds: { ...compactPolicy.thresholds, maximumAreaMm2: 100 },
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' }
    })
    expect(
      assessIrregularQualityFacts(facts({ areaMm2: 100.0000009 }), policy).qualityRegressions
    ).toEqual([])
    expect(
      assessIrregularQualityFacts(facts({ areaMm2: 100.000001 }), policy).qualityRegressions
    ).toEqual([])
    expect(
      assessIrregularQualityFacts(facts({ areaMm2: 100.0000011 }), policy).qualityRegressions
    ).toContain('maximumAreaMm2')
  })
})

describe('irregular quality runner', () => {
  it('captures and compares both typed failures instead of returning after TypeScript failure', async () => {
    const events: string[] = []
    const acceptance = await Effect.runPromise(
      executeIrregularQualityAcceptance({
        request: { pieces: [], sheet: { width: 100, height: 100 } } as unknown as NestingRequest,
        settings: {} as IrregularNestingSettings,
        objectiveProfile: 'compact',
        policy: compactPolicy,
        geometryAuthority: [],
        dependencies: {
          runTypeScript: () => {
            events.push('typescript')
            return Effect.fail(failure('same failure'))
          },
          runRust: () => {
            events.push('rust')
            return Effect.fail(failure('same failure'))
          }
        }
      })
    )

    expect(events).toEqual(['typescript', 'rust'])
    expect(acceptance.category).toBe('exact-match')
    expect(acceptance.accepted).toBe(false)
  })
})

describe('unsnapped geometry metric', () => {
  it('translates collision polygons without snapping their coordinates', () => {
    const makePlaced = (pieceId: string, translateX: number) =>
      ({
        placement: new IrregularPlacement({
          pieceId: pieceId as never,
          sourcePieceId: `${pieceId}-source` as never,
          transform: new IrregularTransform({
            translateX,
            translateY: 0,
            rotationDeg: 0,
            mirrored: false
          })
        }),
        collisionGeometry: {
          polygon: {
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 0, y: 10 }
            ]
          }
        }
      }) as never
    const envelope = measureIrregularUnsnappedTranslatedEnvelope([
      makePlaced('a', 0),
      makePlaced('b', 10.0000004)
    ])
    expect(envelope.areaMm2).toBeCloseTo(200.000004, 10)
  })
})

describe('irregular capacity and cohesion evidence', () => {
  it('requires caller-owned Short Side construction witness evidence', () => {
    const policy = makeShortSideIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' },
      selectedPieceIds: ['a']
    })
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: {
        pieces: [{ id: 'a', sourcePieceId: 'source-a' }],
        sheet: { width: 100, height: 100 }
      } as unknown as NestingRequest,
      result: {
        placedCollisionGeometries: [],
        unplacedPieceIds: ['a']
      } as never,
      policy,
      geometryAuthority: []
    })
    expect(facts.shortSideContractValid).toBe(false)
  })

  it('does not treat a missing capacity trace as valid when capacity is required', () => {
    const fixturePolicy = makeCompactIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: {
        kind: 'required',
        allowedRoutings: ['bounded-complete-archive-miss'],
        allowedSelectedOrigins: ['cold-search'],
        expectedTerminationReason: 'capacity_subset_settled',
        requireColdOnlyDominance: false,
        expectedQualityWarmPrefix: noQualityWarmPrefixExpectation
      },
      cohesion: { kind: 'not-required' }
    })
    const fixture = geometryFixtureForEvidence()
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result: fixture.result,
      policy: fixturePolicy,
      geometryAuthority: []
    })
    expect(facts.capacityContractValid).toBe(false)
  })

  it('rejects a capacity trace whose objective fields disagree with result geometry', () => {
    const fixture = twoPieceGeometryFixture()
    const identity = canonicalCollisionLayoutIdentity(fixture.result.placedCollisionGeometries)
    if (identity === undefined) throw new Error('capacity fixture must have a canonical identity')
    const canonicalGeometryHash = createHash('sha256').update(identity).digest('hex')
    const result = {
      ...fixture.result,
      capacityTrace: capacityTraceForFixture(canonicalGeometryHash)
    } as IrregularComputeResult
    const policy = makeCompactIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: {
        kind: 'required',
        allowedRoutings: ['bounded-complete-archive-miss'],
        allowedSelectedOrigins: ['cold-search'],
        expectedTerminationReason: 'capacity_subset_settled',
        requireColdOnlyDominance: false,
        expectedQualityWarmPrefix: noQualityWarmPrefixExpectation
      },
      cohesion: { kind: 'not-required' }
    })

    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result,
      policy,
      geometryAuthority: fixture.prepared
    })

    expect(facts.canonicalGeometryHash).toBe(canonicalGeometryHash)
    expect(facts.capacityContractValid).toBe(false)
  })

  it('rejects capacity traces whose quality warm-prefix producer differs from the fixture', () => {
    const fixture = twoPieceGeometryFixture()
    const identity = canonicalCollisionLayoutIdentity(fixture.result.placedCollisionGeometries)
    if (identity === undefined) throw new Error('capacity fixture must have a canonical identity')
    const canonicalGeometryHash = createHash('sha256').update(identity).digest('hex')
    const policy = makeCompactIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: {
        kind: 'required',
        allowedRoutings: ['bounded-complete-archive-miss'],
        allowedSelectedOrigins: ['cold-search'],
        expectedTerminationReason: 'capacity_subset_settled',
        requireColdOnlyDominance: false,
        expectedQualityWarmPrefix: {
          status: 'settled',
          outputInfluence: 'none',
          sourceRole: 'canonical-grid',
          prefixDepth: 1,
          endpointCanonicalGeometryHash: undefined
        }
      },
      cohesion: { kind: 'not-required' }
    })
    const result = {
      ...fixture.result,
      capacityTrace: capacityTraceForFixture(canonicalGeometryHash)
    } as IrregularComputeResult
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result,
      policy,
      geometryAuthority: fixture.prepared
    })
    expect(facts.capacityContractValid).toBe(false)
  })

  it('rejects cohesion evidence whose metrics disagree with authoritative result geometry', () => {
    const fixture = twoPieceGeometryFixture()
    const identity = canonicalCollisionLayoutIdentity(fixture.result.placedCollisionGeometries)
    if (identity === undefined) throw new Error('cohesion fixture must have a canonical identity')
    const canonicalGeometryHash = createHash('sha256').update(identity).digest('hex')
    const policy = makeCompactIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: {
        kind: 'required',
        minimumPlacedCount: 2,
        maximumCavities: 0,
        maximumEnvelopeMaximumSideMm: 30,
        maximumEnvelopeAreaMm2: 300,
        maximumEnvelopeAreaInclusive: true,
        maximumPositiveContactComponentCount: 2,
        maximumIsolatedPieceCount: 2,
        requireLargestComponentContainsEveryPlacedPiece: false
      }
    })

    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result: fixture.result,
      policy,
      geometryAuthority: fixture.prepared,
      cohesionEvidence: {
        accepted: true,
        canonicalGeometryHash,
        placedCount: 2,
        enclosedCavityCount: 0,
        envelopeMaximumSideMm: 10,
        envelopeAreaMm2: 100,
        positiveContactComponentCount: 1,
        isolatedPieceCount: 0,
        largestPositiveContactComponentSize: 2
      }
    })

    expect(facts.canonicalGeometryHash).toBe(canonicalGeometryHash)
    expect(facts.cohesionContractValid).toBe(false)
  })

  it('does not treat omitted cohesion evidence as valid when cohesion is required', () => {
    const fixturePolicy = makeCompactIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: {
        kind: 'required',
        minimumPlacedCount: 0,
        maximumCavities: 0,
        maximumEnvelopeMaximumSideMm: 100,
        maximumEnvelopeAreaMm2: 100,
        maximumEnvelopeAreaInclusive: true,
        maximumPositiveContactComponentCount: 1,
        maximumIsolatedPieceCount: 0,
        requireLargestComponentContainsEveryPlacedPiece: true
      }
    })
    const fixture = geometryFixtureForEvidence()
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result: fixture.result,
      policy: fixturePolicy,
      geometryAuthority: []
    })
    expect(facts.cohesionContractValid).toBe(false)
  })

  it('enforces an exclusive cohesion envelope-area upper bound', () => {
    const fixturePolicy = makeCompactIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: {
        kind: 'required',
        minimumPlacedCount: 0,
        maximumCavities: 0,
        maximumEnvelopeMaximumSideMm: 100,
        maximumEnvelopeAreaMm2: 100,
        maximumEnvelopeAreaInclusive: false,
        maximumPositiveContactComponentCount: 1,
        maximumIsolatedPieceCount: 0,
        requireLargestComponentContainsEveryPlacedPiece: true
      }
    })
    const fixture = geometryFixtureForEvidence()
    const emptyIdentity = canonicalCollisionLayoutIdentity(fixture.result.placedCollisionGeometries)
    if (emptyIdentity === undefined) throw new Error('empty fixture must have a canonical identity')
    const canonicalGeometryHash = createHash('sha256').update(emptyIdentity).digest('hex')
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result: fixture.result,
      policy: fixturePolicy,
      geometryAuthority: [],
      cohesionEvidence: {
        accepted: true,
        canonicalGeometryHash,
        placedCount: 0,
        enclosedCavityCount: 0,
        envelopeMaximumSideMm: 0,
        envelopeAreaMm2: 100,
        positiveContactComponentCount: 0,
        isolatedPieceCount: 0,
        largestPositiveContactComponentSize: 0
      }
    })
    expect(facts.cohesionContractValid).toBe(false)
  })
})

function geometryFixtureForEvidence(): {
  readonly request: NestingRequest
  readonly result: IrregularComputeResult
} {
  return {
    request: { pieces: [], sheet: { width: 100, height: 100 } } as unknown as NestingRequest,
    result: {
      placedCollisionGeometries: [],
      unplacedPieceIds: [],
      portfolio: {} as never
    } as unknown as IrregularComputeResult
  }
}

describe('irregular geometry provenance', () => {
  const geometryFixture = () => {
    const sourcePieceId = 'source-a' as never
    const pieceId = 'a' as never
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]
    const pointValues = points.map(({ x, y }) => new IrregularPoint({ x, y }))
    const polygon = new IrregularPolygon({ points: pointValues })
    const geometry = new CollisionGeometry({
      sourcePieceId,
      sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
      sampledPoints: pointValues,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: new IrregularPoint({ x: 0, y: 0 }),
      diagnostics: []
    })
    const transform = new IrregularTransformCandidate({
      index: 0,
      rotationDeg: 0,
      mirrored: false,
      reason: 'orthogonal'
    })
    const prepared = new IrregularPreparedPiece({
      pieceId,
      source: { id: sourcePieceId } as never,
      allowMirror: false,
      collisionGeometry: geometry,
      transforms: [transform]
    })
    const placed = new IrregularPlacedPiece({
      placement: new IrregularPlacement({
        pieceId,
        sourcePieceId,
        transform: new IrregularTransform({
          translateX: 0,
          translateY: 0,
          rotationDeg: 0,
          mirrored: false
        })
      }),
      collisionGeometry: new TransformedCollisionGeometry({
        sourcePieceId,
        transform,
        polygon,
        bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
      })
    })
    const request = {
      pieces: [{ id: pieceId, sourcePieceId }],
      sheet: { width: 100, height: 100 }
    } as unknown as NestingRequest
    return { geometry, transform, prepared, placed, request, pieceId, sourcePieceId }
  }

  it('rejects duplicated placed geometry and IDs', () => {
    const fixture = geometryFixture()
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result: {
        placedCollisionGeometries: [fixture.placed, fixture.placed],
        unplacedPieceIds: []
      } as never,
      policy: compactPolicy,
      geometryAuthority: [fixture.prepared]
    })
    expect(facts.provenanceValid).toBe(false)
  })

  it('accepts distinct prepareCsvPieces copies with shared source geometry and translations', () => {
    const sourcePieceId = 'source-a' as PieceId
    const source = {
      id: sourcePieceId,
      sourceFileId: 'file-1',
      label: 'Source A',
      realBounds: { x: 0, y: 0, width: 10, height: 10 },
      geometry: { entityType: 'LWPOLYLINE', closed: true, segments: [] },
      warnings: []
    } as unknown as ImportedPiece
    const rows = [
      {
        id: 'row-1',
        reference: 'R1',
        customerName: 'Customer 1',
        amount: 1,
        linkedPieceId: sourcePieceId
      },
      {
        id: 'row-2',
        reference: 'R2',
        customerName: 'Customer 2',
        amount: 1,
        linkedPieceId: sourcePieceId
      }
    ] as unknown as ReadonlyArray<CsvCutRow>
    const preparedCopies = prepareCsvPieces(
      rows,
      new Map([[sourcePieceId, source]]),
      { width: 100, height: 100, label: 'sheet' } as never,
      0,
      'job-1' as JobId
    ).pieces
    expect(preparedCopies).toHaveLength(2)
    expect(preparedCopies[0]?.id).not.toBe(preparedCopies[1]?.id)
    expect(preparedCopies[0]?.sourcePieceId).toBe(sourcePieceId)
    expect(preparedCopies[1]?.sourcePieceId).toBe(sourcePieceId)

    const pointValues = [
      new IrregularPoint({ x: 0, y: 0 }),
      new IrregularPoint({ x: 10, y: 0 }),
      new IrregularPoint({ x: 10, y: 10 }),
      new IrregularPoint({ x: 0, y: 10 })
    ]
    const polygon = new IrregularPolygon({ points: pointValues })
    const collisionGeometry = new CollisionGeometry({
      sourcePieceId,
      sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
      sampledPoints: pointValues,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: new IrregularPoint({ x: 0, y: 0 }),
      diagnostics: []
    })
    const transform = new IrregularTransformCandidate({
      index: 0,
      rotationDeg: 0,
      mirrored: false,
      reason: 'orthogonal'
    })
    const prepared = preparedCopies.map(
      (copy) =>
        new IrregularPreparedPiece({
          pieceId: copy.id,
          source,
          allowMirror: false,
          collisionGeometry,
          transforms: [transform]
        })
    )
    const placed = prepared.map(
      (copy, index) =>
        new IrregularPlacedPiece({
          placement: new IrregularPlacement({
            pieceId: copy.pieceId,
            sourcePieceId,
            transform: new IrregularTransform({
              translateX: index * 20,
              translateY: 0,
              rotationDeg: 0,
              mirrored: false
            })
          }),
          collisionGeometry: new TransformedCollisionGeometry({
            sourcePieceId,
            transform,
            polygon,
            bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
          })
        })
    )
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: {
        pieces: preparedCopies.map((copy) => ({
          id: copy.id,
          sourcePieceId: copy.sourcePieceId
        })),
        sheet: { width: 100, height: 100 }
      } as unknown as NestingRequest,
      result: {
        placedCollisionGeometries: placed,
        unplacedPieceIds: []
      } as never,
      policy: compactPolicy,
      geometryAuthority: prepared
    })

    expect(facts.provenanceValid).toBe(true)
  })

  it.each([
    [
      'relabeled placement',
      (fixture: ReturnType<typeof geometryFixture>) => {
        Object.assign(fixture.placed, {
          placement: new IrregularPlacement({
            pieceId: 'wrong' as never,
            sourcePieceId: fixture.sourcePieceId,
            transform: fixture.placed.placement.transform
          })
        })
      }
    ],
    [
      'foreign source',
      (fixture: ReturnType<typeof geometryFixture>) => {
        Object.assign(fixture.placed, {
          placement: new IrregularPlacement({
            pieceId: fixture.pieceId,
            sourcePieceId: 'foreign' as never,
            transform: fixture.placed.placement.transform
          })
        })
      }
    ],
    [
      'non-finite transform',
      (fixture: ReturnType<typeof geometryFixture>) => {
        Object.assign(fixture.placed, {
          placement: new IrregularPlacement({
            pieceId: fixture.pieceId,
            sourcePieceId: fixture.sourcePieceId,
            transform: new IrregularTransform({
              translateX: Number.NaN,
              translateY: 0,
              rotationDeg: 0,
              mirrored: false
            })
          })
        })
      }
    ],
    [
      'geometry mismatch',
      (fixture: ReturnType<typeof geometryFixture>) => {
        Object.assign(fixture.placed, {
          collisionGeometry: new TransformedCollisionGeometry({
            sourcePieceId: fixture.sourcePieceId,
            transform: fixture.transform,
            polygon: new IrregularPolygon({
              points: [
                new IrregularPoint({ x: 1, y: 0 }),
                new IrregularPoint({ x: 10, y: 0 }),
                new IrregularPoint({ x: 10, y: 10 }),
                new IrregularPoint({ x: 0, y: 10 })
              ]
            }),
            bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
          })
        })
      }
    ]
  ])('rejects %s', (_name, mutate) => {
    const fixture = geometryFixture()
    mutate(fixture)
    const result = {
      placedCollisionGeometries: [fixture.placed],
      unplacedPieceIds: []
    } as never
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result,
      policy: compactPolicy,
      geometryAuthority: [fixture.prepared]
    })
    expect(facts.provenanceValid).toBe(false)
  })
})

describe('Short Side observer contract validation', () => {
  it('rejects a non-accepted pair fold even when observer and partition evidence pass', () => {
    const fixture = shortSideGeometryFixture()
    const pairFoldTrace = {
      status: 'no-pair',
      outputInfluence: 'none',
      expectedPairCount: 0,
      transformEvaluations: 1,
      evaluatedPairCount: 0,
      placedCount: 1,
      constructionKind: undefined,
      rowCount: 0,
      selectedBottomPieceId: undefined,
      selectedUpperPieceId: undefined,
      canonicalGeometryHash: undefined,
      admission: undefined,
      serializedTraceBytes: 0,
      contactStripLanes: []
    } as never
    const observerTrace = {
      status: 'observed',
      outputInfluence: 'none',
      settledEndpointCount: 1,
      evaluatedOrientationCount: 2,
      placementEvaluations: 0,
      candidateEvaluations: 0,
      serializedTraceBytes: 0,
      runtimeBudgetExceeded: false,
      endpoints: [
        {
          canonicalGeometryHash: 'observer',
          selected: { exactLegal: true },
          cavityHullGuardEligible: true,
          geometricParetoEligible: true
        }
      ],
      rankedCanonicalGeometryHashes: ['observer'],
      cavityHullGuardEligibleEndpointCount: 1,
      geometricParetoEligibleEndpointCount: 1,
      observerWinnerCanonicalGeometryHash: 'observer',
      observerWinnerRotationDeg: 0
    } as never
    const result = {
      ...fixture.result,
      intrinsicShortSidePairFoldTrace: pairFoldTrace,
      intrinsicShortSideObserverTrace: observerTrace
    } as never
    const policy = makeShortSideIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' },
      selectedPieceIds: ['a']
    })
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result,
      policy,
      geometryAuthority: [fixture.prepared]
    })
    expect(facts.shortSideContractValid).toBe(false)
  })

  it('rejects an observed winner that is not exact legal', () => {
    const fixture = shortSideGeometryFixture()
    const pairFoldTrace = {
      status: 'accepted',
      outputInfluence: 'selected',
      expectedPairCount: 0,
      transformEvaluations: 1,
      evaluatedPairCount: 0,
      placedCount: 1,
      constructionKind: 'multi-row-shelf',
      rowCount: 1,
      selectedBottomPieceId: undefined,
      selectedUpperPieceId: undefined,
      canonicalGeometryHash: 'pending',
      admission: { accepted: true },
      serializedTraceBytes: 0,
      contactStripLanes: []
    } as never
    const observerTrace = {
      status: 'observed',
      outputInfluence: 'none',
      settledEndpointCount: 1,
      evaluatedOrientationCount: 2,
      placementEvaluations: 0,
      candidateEvaluations: 0,
      serializedTraceBytes: 0,
      runtimeBudgetExceeded: false,
      endpoints: [
        {
          canonicalGeometryHash: 'observer',
          selected: { exactLegal: false },
          cavityHullGuardEligible: true,
          geometricParetoEligible: true
        }
      ],
      rankedCanonicalGeometryHashes: ['observer'],
      cavityHullGuardEligibleEndpointCount: 1,
      geometricParetoEligibleEndpointCount: 1,
      observerWinnerCanonicalGeometryHash: 'observer',
      observerWinnerRotationDeg: 0
    } as never
    const result = {
      ...fixture.result,
      intrinsicShortSidePairFoldTrace: pairFoldTrace,
      intrinsicShortSideObserverTrace: observerTrace
    } as never
    const policy = makeShortSideIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' },
      selectedPieceIds: ['a']
    })
    const canonicalIdentity = canonicalCollisionLayoutIdentity(
      fixture.result.placedCollisionGeometries
    )
    const expectedCanonicalGeometryHash =
      canonicalIdentity === undefined
        ? undefined
        : createHash('sha256').update(canonicalIdentity).digest('hex')
    Object.assign(pairFoldTrace, { canonicalGeometryHash: expectedCanonicalGeometryHash })
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result,
      policy,
      geometryAuthority: [fixture.prepared]
    })
    expect(facts.canonicalGeometryHash).toBe(expectedCanonicalGeometryHash)
    expect(facts.canonicalGeometryHash).not.toBe(canonicalIdentity)
    expect(facts.shortSideContractValid).toBe(false)
  })

  it('rejects forged accepted telemetry for an arbitrary legal Short Side geometry', () => {
    const fixture = shortSideGeometryFixture()
    const canonicalIdentity = canonicalCollisionLayoutIdentity(
      fixture.result.placedCollisionGeometries
    )
    if (canonicalIdentity === undefined) throw new Error('Short Side fixture must have an identity')
    const canonicalGeometryHash = createHash('sha256').update(canonicalIdentity).digest('hex')
    const pairFoldTrace = {
      status: 'accepted',
      outputInfluence: 'selected',
      expectedPairCount: 0,
      transformEvaluations: 1,
      evaluatedPairCount: 0,
      constructionKind: 'multi-row-shelf',
      rowCount: 1,
      selectedBottomPieceId: undefined,
      selectedUpperPieceId: undefined,
      placedCount: 1,
      usedShortAxisSpanMm: 999,
      usedLongAxisDepthMm: 999,
      envelopeAreaMm2: 1,
      usedShortAxisSpanGrid: 999_000,
      usedLongAxisDepthGrid: 1_000,
      envelopeAreaGrid2: '1000000',
      collisionMaterialDoubledAreaGrid2: '1',
      canonicalGeometryHash,
      admission: {
        exactLegal: true,
        allPiecesPlaced: true,
        fillRatio: 999,
        depthWithinProductionMaximumSide: false,
        projectionCoverageRatio: 0,
        projectionComponentCount: 99,
        enclosedCavityCount: 99,
        collisionEnvelopeDensity: 0,
        shortAxisSpanGainFactor: 0,
        envelopeAreaCostFactor: 999,
        directionallyEfficient: false,
        envelopeAreaCostWithinProductionBound: false,
        accepted: true
      },
      interlocking: {
        largestOccupiedHullGapRatio: 999,
        largestOccupiedHullGapDoubledAreaGrid2: '999',
        occupiedHullDoubledAreaGrid2: '1000',
        isolatedPieceCount: 99,
        positiveContactComponentCount: 99,
        largestPositiveContactComponentSize: 0,
        sharedBoundaryLengthMm: 0
      },
      serializedTraceBytes: 0,
      contactStripLanes: []
    } as never
    const observerTrace = {
      status: 'observed',
      outputInfluence: 'none',
      settledEndpointCount: 1,
      evaluatedOrientationCount: 2,
      placementEvaluations: 0,
      candidateEvaluations: 0,
      serializedTraceBytes: 0,
      runtimeBudgetExceeded: false,
      endpoints: [
        {
          canonicalGeometryHash: 'observer',
          selected: { exactLegal: true },
          cavityHullGuardEligible: true,
          geometricParetoEligible: true
        }
      ],
      rankedCanonicalGeometryHashes: ['observer'],
      cavityHullGuardEligibleEndpointCount: 1,
      geometricParetoEligibleEndpointCount: 1,
      observerWinnerCanonicalGeometryHash: 'observer',
      observerWinnerRotationDeg: 0
    } as never
    const result = {
      ...fixture.result,
      intrinsicShortSidePairFoldTrace: pairFoldTrace,
      intrinsicShortSideObserverTrace: observerTrace
    } as never
    const policy = makeShortSideIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' },
      selectedPieceIds: ['a']
    })

    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result,
      policy,
      geometryAuthority: [fixture.prepared],
      shortSideAuthority: {
        productionPlacedCollisionGeometries: fixture.result.placedCollisionGeometries,
        directionalConstructionPlacedCollisionGeometries: undefined
      }
    })

    expect(facts.legalGeometry).toBe(true)
    expect(facts.provenanceValid).toBe(true)
    expect(facts.shortSideContractValid).toBe(false)
  })

  it('uses witness equality instead of the strict-quality diagnostic for construction proof', () => {
    const fixture = shortSideGeometryFixture()
    const production = measureIntrinsicShortSideDirectionalReference({
      sheet: fixture.request.sheet,
      placedCollisionGeometries: fixture.result.placedCollisionGeometries
    })
    if (production === undefined) throw new Error('Short Side fixture needs a production reference')
    const evidence = measureIntrinsicShortSidePairFoldGeometryEvidence({
      sheet: fixture.request.sheet,
      preparedPieces: [fixture.prepared],
      placedCollisionGeometries: fixture.result.placedCollisionGeometries,
      productionShortAxisSpanMm: production.usedShortAxisSpanMm,
      productionMaximumSideMm: production.maximumSideMm,
      productionEnvelopeAreaMm2: production.envelopeAreaMm2,
      productionShortAxisSpanGrid: production.usedShortAxisSpanGrid,
      productionMaximumSideGrid: production.maximumSideGrid,
      productionEnvelopeAreaGrid2: production.envelopeAreaGrid2.toString()
    })
    if (evidence === undefined) throw new Error('Short Side fixture needs exact telemetry')

    const pairFoldTrace = {
      status: 'accepted',
      outputInfluence: 'selected',
      requestedShortAxisMm: evidence.requestedShortAxisMm,
      requestedLongAxisMm: evidence.requestedLongAxisMm,
      prescribedRotationDeg: 0,
      productionShortAxisSpanMm: production.usedShortAxisSpanMm,
      productionMaximumSideMm: production.maximumSideMm,
      productionEnvelopeAreaMm2: production.envelopeAreaMm2,
      productionShortAxisSpanGrid: production.usedShortAxisSpanGrid,
      productionMaximumSideGrid: production.maximumSideGrid,
      productionEnvelopeAreaGrid2: production.envelopeAreaGrid2.toString(),
      transformEvaluations: 1,
      expectedPairCount: 0,
      evaluatedPairCount: 0,
      constructionKind: 'multi-row-shelf',
      rowCount: 1,
      selectedBottomPieceId: undefined,
      selectedUpperPieceId: undefined,
      placedCount: 1,
      usedShortAxisSpanMm: evidence.usedShortAxisSpanMm,
      usedLongAxisDepthMm: evidence.usedLongAxisDepthMm,
      envelopeAreaMm2: evidence.envelopeAreaMm2,
      usedShortAxisSpanGrid: evidence.usedShortAxisSpanGrid,
      usedLongAxisDepthGrid: evidence.usedLongAxisDepthGrid,
      envelopeAreaGrid2: evidence.envelopeAreaGrid2,
      collisionMaterialDoubledAreaGrid2: evidence.collisionMaterialDoubledAreaGrid2,
      canonicalGeometryHash: evidence.canonicalGeometryHash,
      admission: evidence.admission,
      interlocking: evidence.interlocking,
      envelopeAreaCostVetoObserved: false,
      envelopeAreaCostVetoes: [],
      contactStrip: undefined,
      contactStripLanes: [],
      contactStripPromotion: undefined,
      runtimeMs: 0,
      peakRssDeltaBytes: 0,
      serializedTraceBytes: 0,
      failureReason: undefined
    } as never
    const observerTrace = {
      status: 'observed',
      outputInfluence: 'none',
      settledEndpointCount: 1,
      evaluatedOrientationCount: 2,
      placementEvaluations: 0,
      candidateEvaluations: 0,
      serializedTraceBytes: 0,
      runtimeBudgetExceeded: false,
      endpoints: [
        {
          canonicalGeometryHash: 'observer',
          selected: { exactLegal: true },
          cavityHullGuardEligible: true,
          geometricParetoEligible: true
        }
      ],
      rankedCanonicalGeometryHashes: ['observer'],
      cavityHullGuardEligibleEndpointCount: 1,
      geometricParetoEligibleEndpointCount: 1,
      observerWinnerCanonicalGeometryHash: 'observer',
      observerWinnerRotationDeg: 0
    } as never
    const result = {
      ...fixture.result,
      intrinsicShortSidePairFoldTrace: pairFoldTrace,
      intrinsicShortSideObserverTrace: observerTrace
    } as never
    const policy = makeShortSideIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' },
      selectedPieceIds: ['a']
    })

    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result,
      policy,
      geometryAuthority: [fixture.prepared],
      shortSideAuthority: {
        productionPlacedCollisionGeometries: fixture.result.placedCollisionGeometries,
        directionalConstructionPlacedCollisionGeometries: fixture.result.placedCollisionGeometries
      }
    })

    expect(facts.legalGeometry).toBe(true)
    expect(facts.provenanceValid).toBe(true)
    expect(evidence.admission.accepted).toBe(false)
    expect(facts.shortSideContractValid).toBe(true)
  })

  it('accepts a witness-matching disconnected layout when historical topology thresholds allow it', () => {
    const fixture = twoPieceGeometryFixture()
    const policy = makeShortSideIrregularQualityPolicy({
      thresholds: {
        minimumPlacedCount: 2,
        maximumAreaMm2: 1_000,
        maximumCanonicalCavities: 0,
        maximumPositiveContactComponentCount: 2,
        maximumIsolatedPieceCount: 2,
        minimumLargestPositiveContactComponentSize: 1,
        maximumOccupiedHullGapRatio: 1,
        maximumOccupiedEnvelopeAspectRatio: 10
      },
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' },
      selectedPieceIds: ['a', 'b']
    })
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result: fixture.result,
      policy,
      geometryAuthority: fixture.prepared,
      shortSideAuthority: {
        productionPlacedCollisionGeometries: fixture.result.placedCollisionGeometries,
        directionalConstructionPlacedCollisionGeometries: fixture.result.placedCollisionGeometries
      }
    })

    expect(facts.shortSideContractValid).toBe(true)
    expect(assessIrregularQualityFacts(facts, policy)).toMatchObject({
      hardInvariantPassed: true,
      qualityAccepted: true
    })
  })

  it('rejects a translated canonical-equivalent fallback when it differs from the witness', () => {
    const fixture = shortSideGeometryFixture()
    const witness = fixture.result.placedCollisionGeometries[0]
    if (witness === undefined) throw new Error('Short Side fixture needs one placed geometry')
    const translated = new IrregularPlacedPiece({
      placement: new IrregularPlacement({
        pieceId: witness.placement.pieceId,
        sourcePieceId: witness.placement.sourcePieceId,
        transform: new IrregularTransform({
          translateX: 20,
          translateY: 0,
          rotationDeg: 0,
          mirrored: false
        })
      }),
      collisionGeometry: witness.collisionGeometry
    })
    expect(canonicalCollisionLayoutIdentity([translated])).toBe(
      canonicalCollisionLayoutIdentity([witness])
    )
    const policy = makeShortSideIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' },
      selectedPieceIds: ['a']
    })
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result: { ...fixture.result, placedCollisionGeometries: [translated] },
      policy,
      geometryAuthority: [fixture.prepared],
      shortSideAuthority: {
        productionPlacedCollisionGeometries: fixture.result.placedCollisionGeometries,
        directionalConstructionPlacedCollisionGeometries: fixture.result.placedCollisionGeometries
      }
    })

    expect(facts.provenanceValid).toBe(true)
    expect(facts.shortSideContractValid).toBe(false)
  })

  it('accepts witness-matching output without trusting missing or malicious native traces', () => {
    const fixture = shortSideGeometryFixture()
    const policy = makeShortSideIrregularQualityPolicy({
      thresholds: compactPolicy.thresholds,
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' },
      selectedPieceIds: ['a']
    })
    const facts = makeIrregularQualityFacts({
      backend: 'typescript',
      request: fixture.request,
      result: {
        ...fixture.result,
        intrinsicShortSidePairFoldTrace: { status: 'forged-accepted-telemetry' },
        intrinsicShortSideObserverTrace: { status: 'malicious-observer-telemetry' }
      } as never,
      policy,
      geometryAuthority: [fixture.prepared],
      shortSideAuthority: {
        productionPlacedCollisionGeometries: fixture.result.placedCollisionGeometries,
        directionalConstructionPlacedCollisionGeometries: fixture.result.placedCollisionGeometries
      }
    })

    expect(facts.shortSideContractValid).toBe(true)
  })
})

function shortSideGeometryFixture(): {
  readonly request: NestingRequest
  readonly result: IrregularComputeResult
  readonly prepared: IrregularPreparedPiece
} {
  const sourcePieceId = 'source-a' as never
  const pieceId = 'a' as never
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 }
  ]
  const pointValues = points.map(({ x, y }) => new IrregularPoint({ x, y }))
  const polygon = new IrregularPolygon({ points: pointValues })
  const geometry = new CollisionGeometry({
    sourcePieceId,
    sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
    sampledPoints: pointValues,
    convexHull: polygon,
    collisionPolygon: polygon,
    placementReference: new IrregularPoint({ x: 0, y: 0 }),
    diagnostics: []
  })
  const transform = new IrregularTransformCandidate({
    index: 0,
    rotationDeg: 0,
    mirrored: false,
    reason: 'orthogonal'
  })
  const prepared = new IrregularPreparedPiece({
    pieceId,
    source: { id: sourcePieceId } as never,
    allowMirror: false,
    collisionGeometry: geometry,
    transforms: [transform]
  })
  const placed = new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId,
      sourcePieceId,
      transform: new IrregularTransform({
        translateX: 0,
        translateY: 0,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId,
      transform,
      polygon,
      bounds: new IrregularBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
    })
  })
  return {
    request: {
      pieces: [{ id: pieceId, sourcePieceId }],
      sheet: { width: 100, height: 100 }
    } as unknown as NestingRequest,
    result: {
      placedCollisionGeometries: [placed],
      unplacedPieceIds: [],
      portfolio: {} as never
    } as unknown as IrregularComputeResult,
    prepared
  }
}
