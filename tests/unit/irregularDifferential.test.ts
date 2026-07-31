import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { NestingRequest } from '@shared/domain/nesting.js'
import type { NestingResult } from '@shared/domain/nesting.js'
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
import type { ActiveRunController } from '../../src/workers/activeRunController.js'
import { dispatchNestingComputation } from '../../src/workers/nestingDispatch.js'
import {
  computeIrregularNestingDifferential,
  executeIrregularBackend,
  type IrregularBackendExecutionDependencies
} from '../../src/workers/irregular/differential/irregularDifferential.js'
import type { NativeCapabilityProbe } from '../../src/workers/irregular/native/loadNativeBackend.js'
import {
  compareIrregularDifferentialOutcomes,
  projectIrregularDifferentialOutcome
} from '../../src/workers/irregular/differential/irregularSemanticComparison.js'

const request = {} as NestingRequest
const eligibleSettings = new IrregularNestingSettings({
  geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  optimizer: makeCompactQualityIrregularOptimizerSettings()
})
const shortSideSettings = new IrregularNestingSettings({
  geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  optimizer: makeCompactQualityIrregularOptimizerSettings({
    intrinsicObjectiveProfileId: 'short-side'
  })
})
const ineligibleSettings = new IrregularNestingSettings({
  geometry: eligibleSettings.geometry,
  optimizer: new IrregularOptimizerSettings({
    ...eligibleSettings.optimizer,
    intrinsicSharedArchiveEnabled: false
  })
})
const availableProbe: NativeCapabilityProbe = {
  available: true,
  nativeApiVersion: 3,
  backendVersion: 'test',
  targetTriple: 'test-target',
  profiles: ['compact']
}
const availableShortSideProbe: NativeCapabilityProbe = {
  ...availableProbe,
  profiles: ['compact', 'compact-short-side']
}
const availableShortSideOnlyProbe: NativeCapabilityProbe = {
  ...availableProbe,
  profiles: ['compact-short-side']
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
  readonly probe?: NativeCapabilityProbe
  readonly available?: boolean
  readonly events?: string[]
  readonly rustOptions?: Array<NativeIrregularBackendOptions | undefined>
}): IrregularBackendExecutionDependencies {
  return {
    probeNative: () => {
      input?.events?.push('probe')
      if (input?.probe !== undefined) return input.probe
      return input?.available === false
        ? {
            available: false,
            reason: 'not-installed',
            detail: 'missing test addon'
          }
        : availableProbe
    },
    runTypeScript: (_request, _settings, options) =>
      Effect.sync(() => input?.events?.push('typescript')).pipe(
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
        input?.events?.push('rust')
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
  it('routes irregular work through the injected irregular backend orchestrator', async () => {
    const events: string[] = []
    const irregularRequest = {
      options: { workerMode: 'irregular-convex-v2' }
    } as NestingRequest
    const irregularResult = {} as NestingResult
    const computeNesting = vi.fn(() => {
      events.push('typescript-maxrects')
      return irregularResult
    })
    const computeIrregular = vi.fn(() => {
      events.push('irregular')
      return Effect.succeed(irregularResult)
    })

    const returned = await Effect.runPromise(
      dispatchNestingComputation({
        request: irregularRequest,
        emitFrame: () => {},
        irregularEmitFrame: undefined,
        emitPortfolioProgress: () => Effect.void,
        emitDecisionTrace: undefined,
        controller: {} as ActiveRunController,
        dependencies: { computeNesting, computeIrregular }
      })
    )

    expect(returned).toBe(irregularResult)
    expect(computeIrregular).toHaveBeenCalledOnce()
    expect(computeNesting).not.toHaveBeenCalled()
    expect(events).toEqual(['irregular'])
  })

  it.each([
    {
      name: 'explicit TypeScript skips native probing',
      backend: 'typescript' as const,
      settings: eligibleSettings,
      probe: {
        available: false as const,
        reason: 'not-installed' as const,
        detail: 'missing test addon'
      },
      expectedEvents: ['typescript']
    },
    {
      name: 'auto uses TypeScript for archive-ineligible settings',
      backend: 'auto' as const,
      settings: ineligibleSettings,
      probe: {
        available: false as const,
        reason: 'not-installed' as const,
        detail: 'missing test addon'
      },
      expectedEvents: ['typescript']
    },
    {
      name: 'auto uses Rust for eligible Compact settings',
      backend: 'auto' as const,
      settings: eligibleSettings,
      probe: availableProbe,
      expectedEvents: ['probe', 'rust']
    },
    {
      name: 'auto uses Rust for eligible Compact Short Side settings',
      backend: 'auto' as const,
      settings: shortSideSettings,
      probe: availableShortSideProbe,
      expectedEvents: ['probe', 'rust']
    }
  ])('$name', async ({ backend, settings, probe, expectedEvents }) => {
    const events: string[] = []

    await Effect.runPromise(
      executeIrregularBackend({
        backend,
        request,
        settings,
        dependencies: dependencies({ events, probe })
      })
    )

    expect(events).toEqual(expectedEvents)
  })

  it('dispatches rectangles through MaxRects without evaluating irregular backend selection', async () => {
    const events: string[] = []
    const rectangleRequest = {
      options: { workerMode: 'maxrects-beam-search' }
    } as NestingRequest
    const maxRectsResult = {} as NestingResult
    const computeNesting = vi.fn((_request, _options) => {
      events.push('typescript-maxrects')
      return maxRectsResult
    })
    const parseBackend = vi.fn()
    const probeNative = vi.fn()
    const runRust = vi.fn()
    const computeIrregular = vi.fn(() => {
      parseBackend()
      probeNative()
      runRust()
      events.push('irregular-route')
      throw new Error('rectangle dispatch evaluated the irregular route')
    })

    const returned = await Effect.runPromise(
      dispatchNestingComputation({
        request: rectangleRequest,
        emitFrame: () => {},
        irregularEmitFrame: undefined,
        emitPortfolioProgress: () => Effect.void,
        emitDecisionTrace: undefined,
        controller: {} as ActiveRunController,
        dependencies: { computeNesting, computeIrregular }
      })
    )

    expect(returned).toBe(maxRectsResult)
    expect(computeNesting).toHaveBeenCalledOnce()
    expect(computeIrregular).not.toHaveBeenCalled()
    expect(parseBackend).not.toHaveBeenCalled()
    expect(probeNative).not.toHaveBeenCalled()
    expect(runRust).not.toHaveBeenCalled()
    expect(events).toEqual(['typescript-maxrects'])
  })

  it('runs TypeScript first with callbacks and Rust second without user callbacks', async () => {
    const events: string[] = []
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
          events,
          rustOptions,
          typescript: Effect.succeed(typescriptResult),
          rust: Effect.succeed(result(['typescript-authority']))
        })
      })
    )

    expect(events).toEqual(['probe', 'typescript', 'rust'])
    expect(snapshots).toHaveBeenCalledOnce()
    expect(traces).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledOnce()
    expect(rustOptions).toEqual([undefined])
    expect(returned).toBe(typescriptResult)
  })

  it.each([
    {
      name: 'unavailable native addon',
      probe: {
        available: false as const,
        reason: 'not-installed' as const,
        detail: 'missing test addon'
      },
      reason: 'not-installed' as const
    },
    {
      name: 'incompatible native addon',
      probe: {
        available: false as const,
        reason: 'version-mismatch' as const,
        detail: 'native API mismatch'
      },
      reason: 'version-mismatch' as const
    }
  ])('fails auto before execution for $name', async ({ probe, reason }) => {
    const events: string[] = []
    const failure = await failureOf(
      executeIrregularBackend({
        backend: 'auto',
        request,
        settings: eligibleSettings,
        dependencies: dependencies({ events, probe })
      })
    )

    expect(failure.code).toBe('worker_protocol_error')
    expect(failure.context).toEqual({ requestedBackend: 'auto', reason })
    expect(events).toEqual(['probe'])
  })

  it.each(['auto', 'rust', 'differential'] as const)(
    'rejects %s when the native capability misses the required Short Side profile',
    async (backend) => {
      const events: string[] = []
      const failure = await failureOf(
        executeIrregularBackend({
          backend,
          request,
          settings: shortSideSettings,
          dependencies: dependencies({ events, probe: availableProbe })
        })
      )

      expect(failure.code).toBe('worker_protocol_error')
      expect(failure.context).toEqual({
        requestedBackend: backend,
        reason: 'profile-mismatch',
        requiredProfile: 'compact-short-side',
        advertisedProfiles: ['compact']
      })
      expect(events).toEqual(['probe'])
    }
  )

  it.each(['auto', 'rust', 'differential'] as const)(
    'rejects %s when the native capability misses the required Compact profile',
    async (backend) => {
      const events: string[] = []
      const failure = await failureOf(
        executeIrregularBackend({
          backend,
          request,
          settings: eligibleSettings,
          dependencies: dependencies({
            events,
            probe: availableShortSideOnlyProbe
          })
        })
      )

      expect(failure.code).toBe('worker_protocol_error')
      expect(failure.context).toEqual({
        requestedBackend: backend,
        reason: 'profile-mismatch',
        requiredProfile: 'compact',
        advertisedProfiles: ['compact-short-side']
      })
      expect(events).toEqual(['probe'])
    }
  )

  it('preflights native availability before explicit Rust or differential execution', async () => {
    for (const backend of ['rust', 'differential'] as const) {
      const events: string[] = []
      const failure = await failureOf(
        executeIrregularBackend({
          backend,
          request,
          settings: eligibleSettings,
          dependencies: dependencies({ available: false, events })
        })
      )
      expect(failure.code).toBe('worker_protocol_error')
      expect(failure.context).toMatchObject({ requestedBackend: backend })
      expect(events).toEqual(['probe'])
    }
  })

  it('fails explicit Rust and differential requests that are archive-ineligible', async () => {
    const ineligibleSettings = new IrregularNestingSettings({
      geometry: eligibleSettings.geometry,
      optimizer: new IrregularOptimizerSettings({
        ...eligibleSettings.optimizer,
        intrinsicSharedArchiveEnabled: false
      })
    })

    for (const backend of ['rust', 'differential'] as const) {
      const events: string[] = []
      const failure = await failureOf(
        executeIrregularBackend({
          backend,
          request,
          settings: ineligibleSettings,
          dependencies: dependencies({ events })
        })
      )
      expect(failure.code).toBe('worker_protocol_error')
      expect(failure.context).toMatchObject({ requestedBackend: backend })
      expect(events).toEqual([])
    }
  })

  it('keeps TypeScript authoritative for archive-ineligible requests', async () => {
    const events: string[] = []
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
        dependencies: dependencies({ available: false, events })
      })
    )

    expect(events).toEqual(['typescript'])
  })

  it('propagates a Rust failure without retrying TypeScript after dispatch', async () => {
    const events: string[] = []
    const rustFailure = new WorkerResponseFailureError({
      code: 'irregular_geometry_invalid',
      message: 'native failure',
      context: { operation: 'rust' }
    })

    const returned = await failureOf(
      executeIrregularBackend({
        backend: 'rust',
        request,
        settings: eligibleSettings,
        dependencies: dependencies({ events, rust: Effect.fail(rustFailure) })
      })
    )

    expect(returned).toBe(rustFailure)
    expect(events).toEqual(['probe', 'rust'])
  })

  it('returns an auto-dispatched Rust failure by identity without retrying TypeScript', async () => {
    const events: string[] = []
    const rustFailure = new WorkerResponseFailureError({
      code: 'irregular_geometry_invalid',
      message: 'auto native failure',
      context: { operation: 'auto-rust' }
    })

    const returned = await failureOf(
      executeIrregularBackend({
        backend: 'auto',
        request,
        settings: eligibleSettings,
        dependencies: dependencies({ events, rust: Effect.fail(rustFailure) })
      })
    )

    expect(returned).toBe(rustFailure)
    expect(events).toEqual(['probe', 'rust'])
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
