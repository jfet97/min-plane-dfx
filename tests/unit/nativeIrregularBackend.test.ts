import { Effect, Schema } from 'effect'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect, RectWith } from '@shared/domain/geometry.js'
import { JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec, PreparedPiece } from '@shared/domain/nesting.js'
import { IrregularNestingSettings, IrregularOptimizerSettings } from '@shared/irregular/domain.js'
import {
  computeIrregularNestingNative,
  setIsCancelledPollIntervalMsForTests
} from '../../src/workers/irregular/native/nativeIrregularBackend.js'
import { probeNativeIrregularAddon } from '../../src/workers/irregular/native/loadNativeBackend.js'

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
const describeIfAvailable = probe.available ? describe : describe.skip

function archiveEligibleSettings(overrides?: {
  readonly intrinsicSharedArchiveEnabled?: boolean
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
      intrinsicSharedArchiveEnabled: overrides?.intrinsicSharedArchiveEnabled ?? true
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
      expect(probe.nativeApiVersion).toBe(1)
      expect(probe.profiles).toContain('compact')
      expect(probe.profiles).toContain('compact-short-side')
    }
  })

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
