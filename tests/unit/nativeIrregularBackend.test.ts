import { Effect, Schema } from 'effect'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect, RectWith } from '@shared/domain/geometry.js'
import { JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec, PreparedPiece } from '@shared/domain/nesting.js'
import { IrregularNestingSettings, IrregularOptimizerSettings } from '@shared/irregular/domain.js'
import {
  computeIrregularNestingNative,
  computeIrregularNestingNativeWithTransportForTests,
  setIsCancelledPollIntervalMsForTests,
  type NativeIrregularJobTransport
} from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import { probeNativeIrregularAddon } from '../../src/workers/irregular/native/loadNativeBackend.js'
import { makeIrregularWorkerOutput } from '../../src/workers/algorithm/irregular/irregularWorkerOutput.js'

/**
 * These tests exercise the real `irregular-nesting-native` addon (no
 * mocking of the N-API boundary), matching this repo's convention of
 * driving real production entry points rather than stand-ins (see
 * `scripts/rust-parity/dump-coordinator.ts`'s own doc). The addon is a
 * gitignored build artifact (`crates/irregular-nesting-native/npm/*.node`,
 * produced by `node crates/irregular-nesting-native/scripts/build-native.mjs`)
 * -- unlike `better-sqlite3`, nothing in this repo's `pnpm test`/`test:focused`
 * scripts currently rebuilds it automatically (deliberately out of this
 * task's scope; see `nativeIrregularBackend.ts`'s own module doc), so every
 * test below skips itself (not fails) when the addon has not been built for
 * the current machine, keeping `pnpm test:focused` green regardless of build
 * state -- exactly what the default (`MIN_PLANE_IRREGULAR_BACKEND` unset)
 * production path requires: it never even attempts to load the addon.
 */
const probe = probeNativeIrregularAddon()
const describeIfAvailable =
  !probe.available && probe.reason === 'not-installed' ? describe.skip : describe
const NATIVE_LIFECYCLE_PROBE_TIMEOUT_MS = 8_000
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NATIVE_LIFECYCLE_PROBE_PATH = resolve(
  REPO_ROOT,
  'crates/irregular-nesting-native/scripts/worker-terminal-lifecycle-probe.mjs'
)

/** Runs a real Worker lifecycle fixture and bounds only test-harness hangs. */
function runNativeLifecycleProbe(mode: 'terminal-barrier' | 'cleanup-proof'): Promise<string> {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(process.execPath, [NATIVE_LIFECYCLE_PROBE_PATH, mode], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let completed = false
    const deadline = setTimeout(() => {
      if (completed) return
      completed = true
      child.kill('SIGKILL')
      rejectProbe(
        new Error(
          `native Worker lifecycle probe ${mode} did not exit within ${NATIVE_LIFECYCLE_PROBE_TIMEOUT_MS}ms. ` +
            `stdout: ${stdout}\nstderr: ${stderr}`
        )
      )
    }, NATIVE_LIFECYCLE_PROBE_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error: Error) => {
      if (completed) return
      completed = true
      clearTimeout(deadline)
      rejectProbe(error)
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (completed) return
      completed = true
      clearTimeout(deadline)
      if (code === 0) {
        resolveProbe(stdout)
        return
      }
      rejectProbe(
        new Error(
          `native Worker lifecycle probe ${mode} exited with code ${code}, signal ${signal}. ` +
            `stdout: ${stdout}\nstderr: ${stderr}`
        )
      )
    })
  })
}

function archiveEligibleSettings(overrides?: {
  readonly intrinsicSharedArchiveEnabled?: boolean
  readonly intrinsicObjectiveProfileId?: 'compact' | 'short-side'
}): IrregularNestingSettings {
  return new IrregularNestingSettings({
    geometry: {
      flatteningSagToleranceMm: 0.25,
      clearanceSafetyMarginMm: 0.25,
      geometryBackendId: 'test',
      geometryBackendVersion: '1'
    },
    optimizer: new IrregularOptimizerSettings({
      orderWindow: 1,
      beamWidth: 2,
      transformCap: 4,
      transformMinimumEdgeLengthMm: 0,
      transformAngleDeduplicationToleranceDeg: 0.01,
      configuredRotationDeg: [],
      gaPopulation: 1,
      gaTimeBudgetMs: 1,
      gaSeed: 'test',
      intrinsicSharedArchiveEnabled: overrides?.intrinsicSharedArchiveEnabled ?? true,
      intrinsicObjectiveProfileId: overrides?.intrinsicObjectiveProfileId ?? 'compact'
    })
  })
}

function source(id: string): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`file-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 2, height: 2 }),
    geometry: new DxfGeometrySummary({
      entityType: 'LWPOLYLINE',
      closed: true,
      segments: [
        { kind: 'line', x1: 0, y1: 0, x2: 2, y2: 0 },
        { kind: 'line', x1: 2, y1: 0, x2: 2, y2: 2 },
        { kind: 'line', x1: 2, y1: 2, x2: 0, y2: 2 },
        { kind: 'line', x1: 0, y1: 2, x2: 0, y2: 0 }
      ]
    }),
    warnings: []
  })
}

function prepared(id: string, sourcePieceId = id): PreparedPiece {
  const realBounds = new Rect({ x: 0, y: 0, width: 2, height: 2 })
  return new PreparedPiece({
    id: PieceId.make(id),
    sourcePieceId: PieceId.make(sourcePieceId),
    realBounds,
    paddedBounds: new RectWith({ ...realBounds, longestEdge: 2, area: 4, imbalance: 0 }),
    padding: 0,
    allowRotation: true
  })
}

function request(
  pieces: ReadonlyArray<PreparedPiece>,
  sourcePieces: ReadonlyArray<ImportedPiece>,
  jobId = 'native-backend-test-job'
): NestingRequest {
  return new NestingRequest({
    version: 1,
    jobId: JobId.make(jobId),
    sheet: new SheetSpec({ width: 20, height: 20, label: 'test sheet' }),
    padding: 0,
    pieces,
    sourcePieces,
    options: new NestingOptions({
      allowGlobalRotation: true,
      timeoutMs: 5000,
      workerMode: 'irregular-convex-v2',
      historyMode: 'stream',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'best'
    })
  })
}

const MIXED61_FIXTURE_PATH = resolve('tests/fixtures/irregularSheetInvariance/mixed61-request.json')

interface Mixed61FixturePiece {
  readonly id: string
  readonly sourcePieceId: string
}

/**
 * Derives a request from a slice of the real mixed61 production fixture
 * (real, non-trivial polygon geometry, unlike this file's own `source()`/
 * `prepared()` unit-square helpers) -- used only by the cancellation test
 * below, which needs the native job to take measurably longer than a
 * near-instant trivial square placement so the `isCancelled` poll
 * (`setIsCancelledPollIntervalMsForTests`) has a real chance to observe
 * `true` before the job's own promise settles. A trivial 1-square-piece job
 * was empirically observed to sometimes resolve before even a 1ms poll tick
 * under concurrent test-suite load, which is expected, cooperative-
 * cancellation behavior (R19) rather than a bug -- this fixture-backed
 * request exists to keep the test itself non-flaky, not to change the
 * production contract.
 */
function realGeometryRequest(pieceCount: number): NestingRequest {
  const fixture = JSON.parse(readFileSync(MIXED61_FIXTURE_PATH, 'utf8')) as {
    readonly pieces: ReadonlyArray<Mixed61FixturePiece>
    readonly sourcePieces: ReadonlyArray<{ readonly id: string }>
    readonly [key: string]: unknown
  }
  const pieces = fixture.pieces.slice(0, pieceCount)
  const sourcePieceIds = new Set(pieces.map((piece) => piece.sourcePieceId))
  return Schema.decodeUnknownSync(NestingRequest)({
    ...fixture,
    jobId: 'native-backend-cancel-job',
    pieces,
    sourcePieces: fixture.sourcePieces.filter((piece) => sourcePieceIds.has(piece.id))
  })
}

describeIfAvailable('computeIrregularNestingNative', () => {
  it('reports the native addon as available with the expected N-API contract', () => {
    expect(probe.available).toBe(true)
    if (probe.available) {
      expect(probe.nativeApiVersion).toBe(2)
      expect(probe.profiles).toContain('compact')
      expect(probe.profiles).toContain('compact-short-side')
    }
  })

  it(
    'keeps the real-addon native promise pending until its Worker terminal callback returns',
    async () => {
      const output = await runNativeLifecycleProbe('terminal-barrier')
      expect(output).toContain('terminal-barrier-ok')
    },
    NATIVE_LIFECYCLE_PROBE_TIMEOUT_MS + 2_000
  )

  it(
    'proves cleanup releases the retained terminal wait in the real addon',
    async () => {
      const output = await runNativeLifecycleProbe('cleanup-proof')
      expect(output).toContain('cleanup-proof-process-lifecycle=1/1')
      expect(output).toContain('cleanup-proof-ok')
    },
    NATIVE_LIFECYCLE_PROBE_TIMEOUT_MS + 2_000
  )

  it('places every piece of a small archive-eligible request through the real addon', async () => {
    const settings = archiveEligibleSettings()
    const req = request(
      [prepared('piece-1'), prepared('piece-2')],
      [source('piece-1'), source('piece-2')]
    )

    const progressEvents: Array<{ readonly phase: string }> = []
    const snapshotOrdinals: number[] = []
    let nextOrdinal = 0

    const result = await Effect.runPromise(
      computeIrregularNestingNative(req, settings, {
        emitPortfolioProgress: (progress) =>
          Effect.sync(() => {
            progressEvents.push({ phase: progress.phase })
          }),
        emitStateSnapshot: () => {
          snapshotOrdinals.push(nextOrdinal)
          nextOrdinal += 1
        }
      })
    )

    expect(result.placedCollisionGeometries.length + result.unplacedPieceIds.length).toBe(2)
    expect(result.portfolio.source).toBe('shared-archive')
    expect(result.portfolio.status).toBe('completed')
    expect(progressEvents.length).toBeGreaterThan(0)
    // Every real production placement in this fixture fits the generous sheet.
    expect(result.unplacedPieceIds.length).toBe(0)
  })

  it('does not expose the real-addon envelope until a delayed progress effect drains', async () => {
    const settings = archiveEligibleSettings()
    const req = request([prepared('piece-1')], [source('piece-1')], 'native-terminal-drain-test')
    let releaseProgress: (() => void) | undefined
    let progressStarted = false
    let resultSettled = false
    let firstProgress = true
    const resultPromise = Effect.runPromise(
      computeIrregularNestingNative(req, settings, {
        emitPortfolioProgress: () => {
          const shouldDelay = firstProgress
          firstProgress = false
          return Effect.gen(function* () {
            progressStarted = true
            if (shouldDelay) {
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    releaseProgress = resolve
                  })
              )
            }
          })
        }
      })
    ).then((result) => {
      resultSettled = true
      return result
    })

    while (!progressStarted) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(resultSettled).toBe(false)
    releaseProgress?.()
    await resultPromise
    expect(resultSettled).toBe(true)
  })

  it.each(['compact', 'short-side'] as const)(
    'preserves returned and streamed %s reveal queues through history frames',
    async (intrinsicObjectiveProfileId) => {
      const settings = archiveEligibleSettings({ intrinsicObjectiveProfileId })
      const req = request(
        [prepared('piece-1'), prepared('piece-2')],
        [source('piece-1'), source('piece-2')],
        `native-prepared-queue-history-${intrinsicObjectiveProfileId}`
      )
      const streamedSnapshots: Array<{
        readonly remainingPreparedPieces: ReadonlyArray<{
          readonly pieceId: string | undefined
          readonly sourceId: string
          readonly transformCount: number
          readonly collisionPolygonPointCount: number
        }>
      }> = []

      const result = await Effect.runPromise(
        computeIrregularNestingNative(req, settings, {
          emitStateSnapshot: (snapshot) => {
            streamedSnapshots.push({
              remainingPreparedPieces: snapshot.state.remainingPreparedPieces.map((piece) => ({
                pieceId: piece.pieceId,
                sourceId: piece.source.id,
                transformCount: piece.transforms.length,
                collisionPolygonPointCount: piece.collisionGeometry.collisionPolygon.points.length
              }))
            })
          }
        })
      )
      const expectedQueueIds = [['piece-1', 'piece-2'], ['piece-2'], []]
      const returnedQueueProjection = result.stateSnapshots.map((snapshot) =>
        snapshot.state.remainingPreparedPieces.map((piece) => ({
          pieceId: piece.pieceId,
          sourceId: piece.source.id,
          transformCount: piece.transforms.length,
          collisionPolygonPointCount: piece.collisionGeometry.collisionPolygon.points.length
        }))
      )

      expect(returnedQueueProjection.map((queue) => queue.map((piece) => piece.pieceId))).toEqual(
        expectedQueueIds
      )
      expect(returnedQueueProjection).toEqual(
        streamedSnapshots.map((snapshot) => snapshot.remainingPreparedPieces)
      )
      for (const queue of returnedQueueProjection) {
        for (const preparedPiece of queue) {
          expect(preparedPiece.sourceId).toBe(preparedPiece.pieceId)
          expect(preparedPiece.transformCount).toBeGreaterThan(0)
          expect(preparedPiece.collisionPolygonPointCount).toBeGreaterThan(0)
        }
      }

      const output = makeIrregularWorkerOutput({
        request: req,
        computed: result,
        algorithmBenchmark: {
          startedAt: '2026-07-30T00:00:00.000Z',
          endedAt: '2026-07-30T00:00:00.001Z',
          elapsedMs: 1
        }
      })
      expect(
        output.historyFrames.map((frame) => ({
          title: frame.title,
          remainingPieceIds: frame.remainingPieceIds
        }))
      ).toEqual([
        {
          title: 'shared-archive-selected-layout-reveal',
          remainingPieceIds: ['piece-1', 'piece-2']
        },
        { title: 'shared-archive-selected-layout-reveal', remainingPieceIds: ['piece-2'] },
        { title: 'shared-archive-final-selected', remainingPieceIds: [] }
      ])
    }
  )

  it('reconstructs the five trace fields with their real TS shapes, not raw wire blobs', async () => {
    const settings = archiveEligibleSettings()
    const req = request(
      [prepared('piece-1'), prepared('piece-2')],
      [source('piece-1'), source('piece-2')]
    )

    const result = await Effect.runPromise(computeIrregularNestingNative(req, settings))

    // Present on every archive-eligible run that reaches the non-`proven_impossible`
    // preflight outcome (`result::mod`'s own doc on both fields), which every
    // request through this test file's `archiveEligibleSettings()` does.
    expect(result.intrinsicAnytimeSchedulerTrace).toBeDefined()
    expect(result.intrinsicAnytimeSchedulerTrace?.version).toBe('intrinsic-anytime-scheduler-v1')
    expect(result.intrinsicAnytimeSchedulerTrace?.quanta.length).toBeGreaterThanOrEqual(2)
    result.intrinsicAnytimeSchedulerTrace?.quanta.forEach((quantum, index) => {
      expect(quantum.ordinal).toBe(index)
      expect(typeof quantum.producerRole).toBe('string')
      expect(typeof quantum.outcome).toBe('string')
    })

    expect(result.focusedCompleteReconstructionTrace).toBeDefined()
    expect(result.focusedCompleteReconstructionTrace?.version).toBe(
      'intrinsic-focused-complete-reconstruction-v1'
    )
    expect(typeof result.focusedCompleteReconstructionTrace?.status).toBe('string')

    // `capacityTrace` is only present when capacity mode actually settled
    // this result (`result::mod`'s own doc); this small always-fitting
    // request may or may not reach that branch, so this asserts real
    // `bigint` reconstruction (not a wire string) only when present, rather
    // than asserting presence itself.
    if (result.capacityTrace !== undefined) {
      expect(typeof result.capacityTrace.selected.placedDoubledMaterialAreaGrid2).toBe('bigint')
      expect(typeof result.capacityTrace.preflight.measurements.sheetDoubledAreaGrid2).toBe(
        'bigint'
      )
      expect(['preflight-proven-impossible', 'bounded-complete-archive-miss']).toContain(
        result.capacityTrace.routing
      )
    }
  })

  it('maps an archive-ineligible request to the not_implemented routing code', async () => {
    const settings = archiveEligibleSettings({ intrinsicSharedArchiveEnabled: false })
    const req = request([prepared('piece-1')], [source('piece-1')])

    const error = await Effect.runPromise(
      computeIrregularNestingNative(req, settings).pipe(Effect.flip)
    )
    expect(error.code).toBe('not_implemented')
  })

  it('maps isCancelled polling to worker_cancelled via cancelIrregularJob', async () => {
    setIsCancelledPollIntervalMsForTests(1)
    try {
      const req = realGeometryRequest(6)
      const settings = req.options.irregularSettings
      expect(settings).toBeDefined()
      if (settings === undefined) return

      const error = await Effect.runPromise(
        computeIrregularNestingNative(req, settings, { isCancelled: () => true }).pipe(Effect.flip)
      )
      expect(error.code).toBe('worker_cancelled')
    } finally {
      setIsCancelledPollIntervalMsForTests(50)
    }
  })
})

function nativeFailureEnvelope(): string {
  return JSON.stringify({
    ok: false,
    error: {
      category: 'worker_cancelled',
      operation: 'computeIrregularNesting',
      message: 'cancelled'
    }
  })
}

function nativeEvent(
  kind: 'portfolio-progress' | 'state-snapshot' | 'terminal',
  ordinal: number
): string {
  switch (kind) {
    case 'portfolio-progress':
      return JSON.stringify({
        kind,
        ordinal,
        progress: { phase: 'completed', elapsedMs: 0 }
      })
    case 'state-snapshot':
      return JSON.stringify({
        kind,
        ordinal,
        snapshot: {
          stepIndex: 0,
          beamRank: 0,
          candidateCount: 0,
          placements: [],
          remainingPreparedPieces: [],
          unplacedPieceIds: ['piece-1']
        },
        beamWidth: 2
      })
    case 'terminal':
      return JSON.stringify({ kind, ordinal })
  }
}

function fakeNativeTransport(run: NativeIrregularJobTransport['run']): NativeIrregularJobTransport {
  return { run, cancel: () => false }
}

function nativeTestEffect(
  transport: NativeIrregularJobTransport,
  options?: Parameters<typeof computeIrregularNestingNativeWithTransportForTests>[3]
) {
  return computeIrregularNestingNativeWithTransportForTests(
    transport,
    request([prepared('piece-1')], [source('piece-1')], 'native-event-dispatcher-test'),
    archiveEligibleSettings(),
    options
  )
}

async function expectNativeProtocolFailure(
  effect: ReturnType<typeof nativeTestEffect>,
  operation: string
): Promise<void> {
  const error = await Effect.runPromise(effect.pipe(Effect.flip))
  expect(error).toMatchObject({
    code: 'worker_protocol_error',
    message: 'native irregular event channel failed',
    context: { operation }
  })
}

describe('native irregular event dispatcher', () => {
  it('registers deferred native cancellation only after the native run is registered', async () => {
    let nativeRunRegistered = false
    let nativeCancellationCount = 0
    const transport: NativeIrregularJobTransport = {
      run: (_requestJson, onEvent) => {
        nativeRunRegistered = true
        onEvent(nativeEvent('terminal', 0))
        return Promise.resolve(nativeFailureEnvelope())
      },
      cancel: () => {
        expect(nativeRunRegistered).toBe(true)
        nativeCancellationCount += 1
        return true
      }
    }

    const error = await Effect.runPromise(
      nativeTestEffect(transport, {
        isCancelled: () => true,
        registerNativeCancellation: (cancel) => cancel()
      }).pipe(Effect.flip)
    )

    expect(error.code).toBe('worker_cancelled')
    expect(nativeCancellationCount).toBe(1)
  })

  it('serializes delayed progress and snapshot callbacks before exposing the envelope', async () => {
    let releaseProgress: (() => void) | undefined
    let snapshotsDelivered = 0
    let settled = false
    const addon = fakeNativeTransport(async (_requestJson, onEvent) => {
      onEvent(nativeEvent('portfolio-progress', 0))
      onEvent(nativeEvent('state-snapshot', 1))
      onEvent(nativeEvent('terminal', 2))
      return nativeFailureEnvelope()
    })
    const completion = Effect.runPromise(
      nativeTestEffect(addon, {
        emitPortfolioProgress: () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                releaseProgress = resolve
              })
          ),
        emitStateSnapshot: () => {
          snapshotsDelivered += 1
        }
      }).pipe(Effect.flip)
    ).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(snapshotsDelivered).toBe(0)
    expect(settled).toBe(false)

    releaseProgress?.()
    await completion
    expect(snapshotsDelivered).toBe(1)
    expect(settled).toBe(true)
  })

  it.each([
    ['reversed', [nativeEvent('portfolio-progress', 1), nativeEvent('terminal', 2)]],
    ['duplicate', [nativeEvent('portfolio-progress', 0), nativeEvent('terminal', 0)]],
    ['missing', [nativeEvent('portfolio-progress', 0), nativeEvent('terminal', 2)]]
  ] as const)('rejects a %s ordinal sequence', async (_caseName, events) => {
    const addon = fakeNativeTransport(async (_requestJson, onEvent) => {
      events.forEach(onEvent)
      return nativeFailureEnvelope()
    })

    await expectNativeProtocolFailure(nativeTestEffect(addon), 'nativeEventOrdinal')
  })

  it('rejects a malformed event', async () => {
    const addon = fakeNativeTransport(async (_requestJson, onEvent) => {
      onEvent('{not json')
      onEvent(nativeEvent('terminal', 0))
      return nativeFailureEnvelope()
    })

    await expectNativeProtocolFailure(nativeTestEffect(addon), 'nativeEventDecode')
  })

  it('maps a rejected progress callback and suppresses the queued snapshot callback', async () => {
    let snapshotCallbackCount = 0
    const transport = fakeNativeTransport(async (_requestJson, onEvent) => {
      onEvent(nativeEvent('portfolio-progress', 0))
      onEvent(nativeEvent('state-snapshot', 1))
      onEvent(nativeEvent('terminal', 2))
      return nativeFailureEnvelope()
    })

    await expectNativeProtocolFailure(
      nativeTestEffect(transport, {
        emitPortfolioProgress: () => Effect.die(new Error('user callback secret')),
        emitStateSnapshot: () => {
          snapshotCallbackCount += 1
        }
      }),
      'nativeEventCallback'
    )
    expect(snapshotCallbackCount).toBe(0)
  })

  it('maps a throwing snapshot callback to a sanitized protocol failure', async () => {
    const addon = fakeNativeTransport(async (_requestJson, onEvent) => {
      onEvent(nativeEvent('state-snapshot', 0))
      onEvent(nativeEvent('terminal', 1))
      return nativeFailureEnvelope()
    })

    await expectNativeProtocolFailure(
      nativeTestEffect(addon, {
        emitStateSnapshot: () => {
          throw new Error('user snapshot secret')
        }
      }),
      'nativeEventCallback'
    )
  })

  it('drains delayed progress but suppresses a queued snapshot after a malformed event', async () => {
    let releaseProgress: (() => void) | undefined
    let progressFinished = false
    let snapshotCallbackCount = 0
    let settled = false
    const transport = fakeNativeTransport(async (_requestJson, onEvent) => {
      onEvent(nativeEvent('portfolio-progress', 0))
      await Promise.resolve()
      onEvent(nativeEvent('state-snapshot', 1))
      onEvent('{not json')
      return nativeFailureEnvelope()
    })
    const completion = Effect.runPromise(
      nativeTestEffect(transport, {
        emitPortfolioProgress: () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                releaseProgress = () => {
                  progressFinished = true
                  resolve()
                }
              })
          ),
        emitStateSnapshot: () => {
          snapshotCallbackCount += 1
        }
      }).pipe(Effect.flip)
    ).then((error) => {
      settled = true
      return error
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    releaseProgress?.()
    const error = await completion
    expect(progressFinished).toBe(true)
    expect(snapshotCallbackCount).toBe(0)
    expect(error.context?.['operation']).toBe('nativeEventDecode')
  })

  const terminalTransportOutcomes: ReadonlyArray<readonly [string, string, () => Promise<string>]> =
    [
      [
        'transport rejection',
        'nativeTransport',
        () => Promise.reject(new Error('transport secret'))
      ],
      ['malformed envelope', 'nativeEnvelopeDecode', () => Promise.resolve('not json')]
    ]

  it.each(terminalTransportOutcomes)(
    'drains delayed callback work before exposing %s',
    async (_name, expectedOperation, finish) => {
      let releaseProgress: (() => void) | undefined
      let settled = false
      const transport = fakeNativeTransport(async (_requestJson, onEvent) => {
        onEvent(nativeEvent('portfolio-progress', 0))
        onEvent(nativeEvent('terminal', 1))
        return finish()
      })
      const completion = Effect.runPromise(
        nativeTestEffect(transport, {
          emitPortfolioProgress: () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  releaseProgress = resolve
                })
            )
        }).pipe(Effect.flip)
      ).then((error) => {
        settled = true
        return error
      })

      await Promise.resolve()
      expect(settled).toBe(false)
      releaseProgress?.()
      const error = await completion
      expect(error).toMatchObject({
        code: 'worker_protocol_error',
        context: { operation: expectedOperation }
      })
    }
  )

  it('preserves nativeEventDelivery precedence when terminal delivery failed', async () => {
    const transport = fakeNativeTransport(async () =>
      JSON.stringify({
        ok: false,
        error: {
          category: 'worker_protocol_error',
          operation: 'nativeEventDelivery',
          message: 'native irregular event delivery failed',
          context: { napiStatus: 'Closing' }
        }
      })
    )
    const error = await Effect.runPromise(nativeTestEffect(transport).pipe(Effect.flip))
    expect(error).toMatchObject({
      code: 'worker_protocol_error',
      message: 'native irregular event delivery failed',
      context: { napiStatus: 'Closing' }
    })
  })

  it('rejects transport resolution without the API-v2 terminal event', async () => {
    const transport = fakeNativeTransport(async () => nativeFailureEnvelope())
    await expectNativeProtocolFailure(nativeTestEffect(transport), 'nativeEventTerminal')
  })

  it('rejects a callback received after terminal', async () => {
    const transport = fakeNativeTransport(async (_requestJson, onEvent) => {
      onEvent(nativeEvent('terminal', 0))
      onEvent(nativeEvent('portfolio-progress', 1))
      return nativeFailureEnvelope()
    })

    await expectNativeProtocolFailure(nativeTestEffect(transport), 'nativeEventAfterTerminal')
  })

  it('suppresses callbacks scheduled after adapter settlement', async () => {
    let lateOnEvent: ((json: string) => void) | undefined
    let publicCallbackCount = 0
    const transport = fakeNativeTransport(async (_requestJson, onEvent) => {
      lateOnEvent = onEvent
      onEvent(nativeEvent('terminal', 0))
      return nativeFailureEnvelope()
    })

    await Effect.runPromise(
      nativeTestEffect(transport, {
        emitPortfolioProgress: () =>
          Effect.sync(() => {
            publicCallbackCount += 1
          })
      }).pipe(Effect.flip)
    )
    lateOnEvent?.(nativeEvent('portfolio-progress', 1))
    await Promise.resolve()
    expect(publicCallbackCount).toBe(0)
  })
})
