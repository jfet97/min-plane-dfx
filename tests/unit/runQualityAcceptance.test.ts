import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  QUALITY_ACCEPTANCE_ROWS,
  assertQualityAcceptancePreflight,
  executeQualityAcceptanceRow,
  qualityAcceptanceExitCode,
  requiredNativeProfileForQualityProfile,
  runQualityAcceptanceMatrix,
  type QualityAcceptanceLoadedRow,
  type QualityAcceptanceExecutionDependencies
} from '../../scripts/rust-parity/run-quality-acceptance.js'
import {
  DEFAULT_IRREGULAR_NESTING_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '@shared/irregular/defaults.js'
import { IrregularNestingSettings } from '@shared/irregular/domain.js'
import type { NestingRequest } from '@shared/domain/nesting.js'
import type { IrregularComputeResult } from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import type { WorkerResponseFailureError } from '@shared/protocol/worker.js'

const availableProbe = {
  available: true as const,
  nativeApiVersion: 3,
  backendVersion: 'test-native',
  targetTriple: 'test-target',
  profiles: ['compact', 'compact-short-side']
}

function loadedRow(index = 0): QualityAcceptanceLoadedRow {
  const spec = QUALITY_ACCEPTANCE_ROWS[index]
  if (spec === undefined) throw new Error('quality acceptance fixture row is missing')
  return {
    spec,
    request: {} as NestingRequest,
    settings: DEFAULT_IRREGULAR_NESTING_SETTINGS
  }
}

function dependencies(
  probe: QualityAcceptanceExecutionDependencies['probe'],
  onRun: () => void
): QualityAcceptanceExecutionDependencies {
  const effect = Effect.succeed({} as IrregularComputeResult)
  return {
    probe,
    runTypeScript: () => {
      onRun()
      return effect as Effect.Effect<IrregularComputeResult, WorkerResponseFailureError>
    },
    runRust: () => {
      onRun()
      return effect as Effect.Effect<IrregularComputeResult, WorkerResponseFailureError>
    }
  }
}

type TestPlacedGeometry = {
  readonly placement: {
    readonly transform: {
      readonly translateX: number
      readonly translateY: number
      readonly rotationDeg: number
      readonly mirrored: boolean
    }
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

function shortSideWitnessFixture(): {
  readonly request: NestingRequest
  readonly result: IrregularComputeResult
  readonly prepared: never
  readonly placed: TestPlacedGeometry
} {
  const sourcePieceId = 'source-a'
  const pieceId = 'a'
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 }
  ]
  const polygon = { points }
  const transform = { index: 0, rotationDeg: 0, mirrored: false, reason: 'orthogonal' }
  const prepared = {
    pieceId,
    source: { id: sourcePieceId },
    allowMirror: false,
    collisionGeometry: {
      sourcePieceId,
      sourceBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      sampledPoints: points,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: { x: 0, y: 0 },
      diagnostics: []
    },
    transforms: [transform]
  } as never
  const placed = {
    placement: {
      pieceId,
      sourcePieceId,
      placementReference: { x: 0, y: 0 },
      transform: { translateX: 0, translateY: 0, rotationDeg: 0, mirrored: false }
    },
    collisionGeometry: {
      sourcePieceId,
      transform,
      polygon,
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    }
  } as unknown as TestPlacedGeometry
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
    prepared,
    placed
  }
}

describe('quality acceptance promotion gate', () => {
  it('defines the complete fixture/profile matrix without truncated rows', () => {
    expect(QUALITY_ACCEPTANCE_ROWS).toHaveLength(6)
    expect(QUALITY_ACCEPTANCE_ROWS.map(({ id }) => id)).toEqual([
      'triangle-20-2000x2700-compact',
      'triangle-20-2000x2700-short-side',
      'mixed61-2000x2700-compact',
      'mixed61-2000x2700-short-side',
      'shapes-17-2000x2700-compact',
      'shapes-17-2000x2700-short-side'
    ])
    expect(new Set(QUALITY_ACCEPTANCE_ROWS.map(({ fixture }) => fixture))).toEqual(
      new Set(['triangle-20', 'mixed61', 'shapes-17'])
    )
    expect(
      QUALITY_ACCEPTANCE_ROWS.every(({ profile }) => ['compact', 'short-side'].includes(profile))
    ).toBe(true)
    expect(QUALITY_ACCEPTANCE_ROWS.every(({ sheet }) => sheet === '2000x2700')).toBe(true)
    expect(QUALITY_ACCEPTANCE_ROWS.every(({ minimumPlacedCount }) => minimumPlacedCount > 0)).toBe(
      true
    )
  })

  it('maps each production profile to the native advertised profile', () => {
    expect(requiredNativeProfileForQualityProfile('compact')).toBe('compact')
    expect(requiredNativeProfileForQualityProfile('short-side')).toBe('compact-short-side')
  })

  it('preflights archive eligibility and both native profiles before execution', () => {
    expect(() =>
      assertQualityAcceptancePreflight({ rows: [loadedRow()], probe: availableProbe })
    ).not.toThrow()
    expect(() =>
      assertQualityAcceptancePreflight({
        rows: [
          {
            ...loadedRow(),
            settings: new IrregularNestingSettings({
              ...DEFAULT_IRREGULAR_NESTING_SETTINGS,
              optimizer: makeCompactQualityIrregularOptimizerSettings({
                intrinsicSharedArchiveEnabled: false
              })
            })
          }
        ],
        probe: availableProbe
      })
    ).toThrow(/archive preflight/)
    expect(() =>
      assertQualityAcceptancePreflight({
        rows: [loadedRow()],
        probe: { available: false, reason: 'not-installed', detail: 'missing addon' }
      })
    ).toThrow(/native capability preflight/)
    expect(() =>
      assertQualityAcceptancePreflight({
        rows: [loadedRow(), loadedRow(1)],
        probe: { ...availableProbe, profiles: ['compact'] }
      })
    ).toThrow(/missing profile/)
  })

  it('does not invoke either backend when native capability preflight fails', async () => {
    let runs = 0
    await expect(
      runQualityAcceptanceMatrix({
        rows: [loadedRow()],
        dependencies: dependencies(
          { available: false, reason: 'load-error', detail: 'broken addon' },
          () => {
            runs += 1
          }
        ),
        logger: { log: () => undefined, error: () => undefined }
      })
    ).rejects.toThrow(/no backend ran/)
    expect(runs).toBe(0)
  })

  it('does not invoke either backend when archive eligibility preflight fails', async () => {
    let runs = 0
    const row = loadedRow()
    await expect(
      runQualityAcceptanceMatrix({
        rows: [
          {
            ...row,
            settings: new IrregularNestingSettings({
              ...row.settings,
              optimizer: makeCompactQualityIrregularOptimizerSettings({
                intrinsicSharedArchiveEnabled: false
              })
            })
          }
        ],
        dependencies: dependencies(availableProbe, () => {
          runs += 1
        }),
        logger: { log: () => undefined, error: () => undefined }
      })
    ).rejects.toThrow(/archive preflight/)
    expect(runs).toBe(0)
  })

  it('captures the TypeScript directional witness and supplies it to both backend assessments', async () => {
    const fixture = shortSideWitnessFixture()
    const row = loadedRow(1)
    const result = await executeQualityAcceptanceRow({
      row: {
        ...row,
        request: fixture.request
      },
      dependencies: {
        probe: availableProbe,
        runTypeScript: (_request, _settings, options) => {
          options?.onPreparedPieces?.([fixture.prepared])
          options?.onIntrinsicShortSideProductionGeometry?.(
            fixture.result.placedCollisionGeometries
          )
          options?.onIntrinsicShortSidePairFoldObserverWinner?.(
            fixture.result.placedCollisionGeometries
          )
          return Effect.succeed(fixture.result) as Effect.Effect<
            IrregularComputeResult,
            WorkerResponseFailureError
          >
        },
        runRust: () =>
          Effect.succeed(fixture.result) as Effect.Effect<
            IrregularComputeResult,
            WorkerResponseFailureError
          >
      }
    })

    expect(result.result.typescript.hardInvariantFailures).not.toContain(
      'typescript.shortSideDirectionalGeometry'
    )
    expect(result.result.rust.hardInvariantFailures).not.toContain(
      'rust.shortSideDirectionalGeometry'
    )
  })

  it('rejects a divergent Rust Short Side layout without independent construction evidence', async () => {
    const fixture = shortSideWitnessFixture()
    const divergentPlaced = {
      ...fixture.placed,
      placement: {
        ...fixture.placed.placement,
        transform: {
          ...fixture.placed.placement.transform,
          translateX: 20
        }
      }
    } as never
    const divergentResult = {
      ...fixture.result,
      placedCollisionGeometries: [divergentPlaced]
    } as IrregularComputeResult
    const result = await executeQualityAcceptanceRow({
      row: {
        ...loadedRow(1),
        request: fixture.request
      },
      dependencies: {
        probe: availableProbe,
        runTypeScript: (_request, _settings, options) => {
          options?.onPreparedPieces?.([fixture.prepared])
          options?.onIntrinsicShortSideProductionGeometry?.(
            fixture.result.placedCollisionGeometries
          )
          options?.onIntrinsicShortSidePairFoldObserverWinner?.(
            fixture.result.placedCollisionGeometries
          )
          return Effect.succeed(fixture.result) as Effect.Effect<
            IrregularComputeResult,
            WorkerResponseFailureError
          >
        },
        runRust: () =>
          Effect.succeed(divergentResult) as Effect.Effect<
            IrregularComputeResult,
            WorkerResponseFailureError
          >
      }
    })

    expect(result.result.hardInvariantFailures).toContain('rust.shortSideDirectionalGeometry')
    expect(result.result.accepted).toBe(false)
  })

  it('maps accepted and rejected quality results to stable process exit codes', () => {
    expect(qualityAcceptanceExitCode({ accepted: true })).toBe(0)
    expect(qualityAcceptanceExitCode({ accepted: false })).toBe(1)
  })
})
