import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { NestingRequest } from '@shared/domain/nesting.js'
import {
  IrregularNestingSettings,
  IrregularOptimizerSettings,
  IrregularPortfolioProgress
} from '@shared/irregular/domain.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '@shared/irregular/defaults.js'
import { WorkerResponseFailureError } from '@shared/protocol/worker.js'
import type {
  ComputeIrregularNestingOptions,
  IrregularComputeResult,
  IrregularStateSnapshot
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import type { NativeIrregularBackendOptions } from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import {
  computeIrregularNestingDifferential,
  executeIrregularBackend,
  type IrregularBackendExecutionDependencies
} from '../../src/workers/irregular/differential/irregularDifferential.js'
import {
  compareIrregularDifferentialOutcomes,
  projectIrregularDifferentialOutcome
} from '../../src/workers/irregular/differential/irregularSemanticComparison.js'

const workerSource = readFileSync(
  fileURLToPath(new URL('../../src/workers/nesting.worker.ts', import.meta.url)),
  'utf8'
)

const request = {} as NestingRequest
const eligibleSettings = new IrregularNestingSettings({
  geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  optimizer: makeCompactQualityIrregularOptimizerSettings()
})
const availableProbe = {
  available: true as const,
  nativeApiVersion: 2,
  backendVersion: 'test',
  targetTriple: 'test-target',
  profiles: ['compact']
}

function result(sortedPieceIds: ReadonlyArray<string> = []): IrregularComputeResult {
  return {
    placedCollisionGeometries: [],
    score: {} as IrregularComputeResult['score'],
    unplacedPieceIds: [],
    diagnostics: [],
    sortedPieceIds: sortedPieceIds.map(PieceId.make),
    stateSnapshots: [],
    beamWidth: 1,
    portfolio: {} as IrregularComputeResult['portfolio']
  }
}

function dependencies(input?: {
  readonly typescript?: Effect.Effect<IrregularComputeResult, WorkerResponseFailureError>
  readonly rust?: Effect.Effect<IrregularComputeResult, WorkerResponseFailureError>
  readonly available?: boolean
  readonly calls?: string[]
  readonly rustOptions?: Array<NativeIrregularBackendOptions | undefined>
}): IrregularBackendExecutionDependencies {
  return {
    probeNative: () =>
      input?.available === false
        ? {
            available: false,
            reason: 'not-installed',
            detail: 'missing test addon'
          }
        : availableProbe,
    runTypeScript: (_request, _settings, options) =>
      Effect.sync(() => input?.calls?.push('typescript')).pipe(
        Effect.flatMap(() => {
          options?.emitStateSnapshot?.({} as IrregularStateSnapshot, 1)
          options?.emitDecisionTrace?.(
            {} as Parameters<NonNullable<ComputeIrregularNestingOptions['emitDecisionTrace']>>[0]
          )
          return (
            options?.emitPortfolioProgress?.(
              new IrregularPortfolioProgress({ phase: 'deterministic_beam', elapsedMs: 0 })
            ) ?? Effect.void
          )
        }),
        Effect.flatMap(() => input?.typescript ?? Effect.succeed(result()))
      ),
    runRust: (_request, _settings, options) =>
      Effect.sync(() => {
        input?.calls?.push('rust')
        input?.rustOptions?.push(options)
      }).pipe(Effect.flatMap(() => input?.rust ?? Effect.succeed(result())))
  }
}

async function failureOf(
  effect: Effect.Effect<IrregularComputeResult, WorkerResponseFailureError>
): Promise<WorkerResponseFailureError> {
  return Effect.runPromise(Effect.flip(effect))
}

describe('runtime irregular differential routing', () => {
  it('routes differential through dual-backend orchestration instead of the TypeScript fallback', () => {
    expect(workerSource).toContain("backend === 'differential'")
    expect(workerSource).toContain('computeIrregularNestingDifferential')
  })

  it('runs TypeScript first with callbacks and Rust second without user callbacks', async () => {
    const calls: string[] = []
    const rustOptions: Array<NativeIrregularBackendOptions | undefined> = []
    const snapshots = vi.fn()
    const traces = vi.fn()
    const progress = vi.fn(() => Effect.void)
    const typescriptResult = result(['typescript-authority'])

    const returned = await Effect.runPromise(
      computeIrregularNestingDifferential({
        request,
        settings: eligibleSettings,
        options: {
          emitStateSnapshot: snapshots,
          emitDecisionTrace: traces,
          emitPortfolioProgress: progress
        },
        dependencies: dependencies({
          calls,
          rustOptions,
          typescript: Effect.succeed(typescriptResult),
          rust: Effect.succeed(result(['typescript-authority']))
        })
      })
    )

    expect(calls).toEqual(['typescript', 'rust'])
    expect(snapshots).toHaveBeenCalledOnce()
    expect(traces).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledOnce()
    expect(rustOptions).toEqual([undefined])
    expect(returned).toBe(typescriptResult)
  })

  it('preflights native availability before explicit Rust or differential execution', async () => {
    const calls: string[] = []
    for (const backend of ['rust', 'differential'] as const) {
      const failure = await failureOf(
        executeIrregularBackend({
          backend,
          request,
          settings: eligibleSettings,
          dependencies: dependencies({ available: false, calls })
        })
      )
      expect(failure.code).toBe('worker_protocol_error')
      expect(failure.context).toMatchObject({ requestedBackend: backend })
    }
    expect(calls).toEqual([])
  })

  it('fails explicit Rust and differential requests that are archive-ineligible', async () => {
    const calls: string[] = []
    const ineligibleSettings = new IrregularNestingSettings({
      geometry: eligibleSettings.geometry,
      optimizer: new IrregularOptimizerSettings({
        ...eligibleSettings.optimizer,
        intrinsicSharedArchiveEnabled: false
      })
    })

    for (const backend of ['rust', 'differential'] as const) {
      const failure = await failureOf(
        executeIrregularBackend({
          backend,
          request,
          settings: ineligibleSettings,
          dependencies: dependencies({ calls })
        })
      )
      expect(failure.code).toBe('worker_protocol_error')
      expect(failure.context).toMatchObject({ requestedBackend: backend })
    }
    expect(calls).toEqual([])
  })

  it('keeps TypeScript authoritative for archive-ineligible requests', async () => {
    const calls: string[] = []
    const ineligibleSettings = new IrregularNestingSettings({
      geometry: eligibleSettings.geometry,
      optimizer: new IrregularOptimizerSettings({
        ...eligibleSettings.optimizer,
        intrinsicSharedArchiveEnabled: false
      })
    })

    await Effect.runPromise(
      executeIrregularBackend({
        backend: 'typescript',
        request,
        settings: ineligibleSettings,
        dependencies: dependencies({ available: false, calls })
      })
    )

    expect(calls).toEqual(['typescript'])
  })

  it('preserves the TypeScript failure when both typed failure envelopes are equal', async () => {
    const typescriptFailure = new WorkerResponseFailureError({
      code: 'irregular_no_valid_result',
      message: 'no result',
      context: { operation: 'test' }
    })
    const rustFailure = new WorkerResponseFailureError({
      code: 'irregular_no_valid_result',
      message: 'no result',
      context: { operation: 'test' }
    })

    const returned = await failureOf(
      computeIrregularNestingDifferential({
        request,
        settings: eligibleSettings,
        dependencies: dependencies({
          typescript: Effect.fail(typescriptFailure),
          rust: Effect.fail(rustFailure)
        })
      })
    )

    expect(returned).toBe(typescriptFailure)
  })

  it('returns a bounded typed mismatch with the first semantic path', async () => {
    const longValue = `typescript-${'x'.repeat(800)}`
    const failure = await failureOf(
      computeIrregularNestingDifferential({
        request,
        settings: eligibleSettings,
        dependencies: dependencies({
          typescript: Effect.succeed(result([longValue])),
          rust: Effect.succeed(result(['rust']))
        })
      })
    )

    expect(failure.code).toBe('irregular_differential_mismatch')
    expect(failure.context?.['path']).toBe('value.sortedPieceIds[0]')
    expect(String(failure.context?.['typescriptValue']).length).toBeLessThan(560)
    expect(failure.context?.['rustValue']).toBe('"rust"')
  })
})

describe('shared irregular semantic comparison', () => {
  it('preserves BigInt as decimal strings and normalizes only timing values to presence', () => {
    const typescriptValue = Object.assign(result(), {
      semanticProbe: {
        ledger: [{ materialGrid2: 9007199254740993123456789n }],
        checkpoint: {
          hash: 'same',
          runtimeMs: 1,
          serializedTraceBytes: 100,
          peakRssDeltaBytes: 10
        }
      }
    })
    const rustValue = Object.assign(result(), {
      semanticProbe: {
        ledger: [{ materialGrid2: 9007199254740993123456789n }],
        checkpoint: {
          hash: 'same',
          runtimeMs: 999,
          serializedTraceBytes: 999,
          peakRssDeltaBytes: 9999
        }
      }
    })
    const typescript = { ok: true as const, value: typescriptValue }
    const rust = { ok: true as const, value: rustValue }

    expect(compareIrregularDifferentialOutcomes(typescript, rust)).toBeUndefined()
    expect(JSON.stringify(projectIrregularDifferentialOutcome(typescript))).toContain(
      '9007199254740993123456789'
    )
  })

  it('compares typed failure context through the same first-divergence comparator', () => {
    const typescript = {
      ok: false as const,
      error: new WorkerResponseFailureError({
        code: 'irregular_geometry_invalid',
        message: 'invalid',
        context: { operation: 'typescript' }
      })
    }
    const rust = {
      ok: false as const,
      error: new WorkerResponseFailureError({
        code: 'irregular_geometry_invalid',
        message: 'invalid',
        context: { operation: 'rust' }
      })
    }

    expect(compareIrregularDifferentialOutcomes(typescript, rust)?.path).toBe(
      'error.context.operation'
    )
  })
})
