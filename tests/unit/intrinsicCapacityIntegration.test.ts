import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { ImportedPiece } from '@shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '@shared/irregular/defaults.js'
import { IrregularNestingSettings } from '@shared/irregular/domain.js'
import { makePresetShapeDocument } from '@shared/presetShapes.js'
import { preparePieces } from '@shared/preparePieces.js'
import { computeIrregularNesting } from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { makeIrregularWorkerOutput } from '../../src/workers/algorithm/irregular/irregularWorkerOutput.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'

const settings = new IrregularNestingSettings({
  geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  optimizer: makeCompactQualityIrregularOptimizerSettings()
})

function makeRectangleRequest(input: {
  readonly jobKey: string
  readonly count: number
  readonly widthMm: number
  readonly heightMm: number
  readonly sheet: SheetSpec
  readonly paddingMm: number
}): NestingRequest {
  const preset = makePresetShapeDocument({
    kind: 'rectangle',
    width: input.widthMm,
    height: input.heightMm,
    label: 'rectangle'
  })
  const rectangle = preset.pieces[0]
  if (rectangle === undefined) throw new Error('rectangle preset must contain one piece')

  const sources = Array.from(
    { length: input.count },
    (_, index) =>
      new ImportedPiece({
        ...rectangle,
        id: PieceId.make(`rectangle-copy-${index + 1}`),
        sourceFileId: SourceFileId.make(`rectangle-source-copy-${index + 1}`),
        label: `rectangle copy ${index + 1}`
      })
  )
  const jobId = JobId.make(input.jobKey)
  const prepared = preparePieces(
    sources,
    input.sheet,
    input.paddingMm,
    jobId,
    undefined,
    undefined,
    () => `rectangle-${input.widthMm}x${input.heightMm}`
  )
  expect(prepared.warnings).toEqual([])

  return new NestingRequest({
    version: 1,
    jobId,
    sheet: input.sheet,
    padding: input.paddingMm,
    pieces: prepared.pieces,
    sourcePieces: sources,
    options: new NestingOptions({
      allowGlobalRotation: true,
      allowGlobalMirror: true,
      timeoutMs: 120_000,
      workerMode: 'irregular-convex-v2',
      historyMode: 'final',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'best',
      irregularSettings: settings
    })
  })
}

function compute(request: NestingRequest) {
  return Effect.runPromise(
    computeIrregularNesting(request).pipe(
      Effect.provide(CollisionGeometryBuilder.Live),
      Effect.provide(TransformGeneratorLive),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(FreeMaterialServiceLive),
      Effect.provide(IrregularPlacementScorer.Live),
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(Layer.succeed(GeometrySettings, settings))
    )
  )
}

describe('intrinsic capacity integration', () => {
  it(
    'bypasses complete construction for an area-proven impossible sheet and reports the honest partial result',
    async () => {
      const request = makeRectangleRequest({
        jobKey: 'capacity-area-proven',
        count: 2,
        widthMm: 80,
        heightMm: 60,
        sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' }),
        paddingMm: 10
      })
      const computed = await compute(request)

      expect(computed.capacityTrace).toBeDefined()
      expect(computed.capacityTrace?.routing).toBe('preflight-proven-impossible')
      expect(computed.capacityTrace?.preflight.kind).toBe('proven_impossible')
      expect(computed.capacityTrace?.prefixes.capturedCount).toBe(0)
      expect(computed.capacityTrace?.coldSearch.auxiliaryPlacementEvaluations).toBe(0)

      expect(computed.portfolio.status).toBe('completed')
      expect(computed.portfolio.terminationReason).toBe('capacity_subset_settled')
      expect(computed.portfolio.source).toBe('shared-archive')
      expect(computed.placedCollisionGeometries).toHaveLength(1)
      expect(computed.unplacedPieceIds).toHaveLength(1)
      const allIds = request.pieces.map(({ id }) => id)
      const accounted = [
        ...computed.placedCollisionGeometries.map(
          ({ placement }) => placement.pieceId ?? placement.sourcePieceId
        ),
        ...computed.unplacedPieceIds
      ]
      expect([...accounted].toSorted()).toEqual([...allIds].toSorted())

      const diagnosticCodes = computed.diagnostics.map(({ code }) => code)
      expect(diagnosticCodes).toContain('capacity_preflight_proven_impossible')
      expect(diagnosticCodes).toContain('capacity_subset_settled')
      expect(diagnosticCodes).not.toContain('bounded_complete_archive_miss')

      const output = makeIrregularWorkerOutput({
        request,
        computed,
        algorithmBenchmark: {
          startedAt: '2026-07-23T00:00:00.000Z',
          endedAt: '2026-07-23T00:00:01.000Z',
          elapsedMs: 1000
        }
      })
      const layout = output.result.layout
      if (layout === undefined || layout.kind !== 'irregular') {
        throw new Error('capacity integration must produce an irregular layout')
      }
      expect(layout.placements).toHaveLength(1)
      expect(layout.unplacedPieceIds).toHaveLength(1)
      expect(output.historyFrames).toHaveLength(2)
      expect(output.historyFrames[0]?.placements).toEqual([])
      expect(output.historyFrames[0]?.title).toBe('shared-archive-selected-layout-reveal')
      expect(output.historyFrames.at(-1)?.placements).toHaveLength(1)
      expect(output.historyFrames.at(-1)?.title).toBe('shared-archive-final-selected')
    },
    120_000
  )

  it(
    'enters capacity mode honestly after an inconclusive preflight and bounded complete archive miss',
    async () => {
      const request = makeRectangleRequest({
        jobKey: 'capacity-archive-miss',
        count: 2,
        widthMm: 55,
        heightMm: 55,
        sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' }),
        paddingMm: 0
      })
      const computed = await compute(request)

      expect(computed.capacityTrace).toBeDefined()
      expect(computed.capacityTrace?.routing).toBe('bounded-complete-archive-miss')
      expect(computed.capacityTrace?.preflight.kind).toBe('inconclusive')

      expect(computed.portfolio.terminationReason).toBe('capacity_subset_settled')
      expect(computed.placedCollisionGeometries).toHaveLength(1)
      expect(computed.unplacedPieceIds).toHaveLength(1)

      const diagnosticCodes = computed.diagnostics.map(({ code }) => code)
      expect(diagnosticCodes).toContain('capacity_preflight_inconclusive')
      expect(diagnosticCodes).toContain('bounded_complete_archive_miss')
      expect(diagnosticCodes).toContain('capacity_subset_settled')
      expect(diagnosticCodes).not.toContain('capacity_preflight_proven_impossible')

      const prefixes = computed.capacityTrace?.prefixes
      expect(prefixes).toBeDefined()
      expect(prefixes !== undefined && prefixes.capturedCount).toBeGreaterThanOrEqual(1)
      expect(computed.capacityTrace?.prefixIncumbent).toBeDefined()
      expect(computed.capacityTrace?.prefixIncumbent?.placedCount).toBe(1)
    },
    120_000
  )

  it(
    'keeps the complete path unchanged when the archive fits, with capacity trace vocabulary only in diagnostics',
    async () => {
      const request = makeRectangleRequest({
        jobKey: 'capacity-complete-fitted',
        count: 2,
        widthMm: 40,
        heightMm: 30,
        sheet: new SheetSpec({ width: 2000, height: 2700, label: 'roomy 2000x2700' }),
        paddingMm: 10
      })
      const computed = await compute(request)

      expect(computed.capacityTrace).toBeUndefined()
      expect(computed.portfolio.terminationReason).toBe('shared_archive_completed')
      expect(computed.unplacedPieceIds).toEqual([])
      const diagnosticCodes = computed.diagnostics.map(({ code }) => code)
      expect(diagnosticCodes).toContain('capacity_preflight_inconclusive')
      expect(diagnosticCodes).toContain('complete_archive_fitted')
      expect(diagnosticCodes).not.toContain('capacity_subset_settled')
      expect(diagnosticCodes).not.toContain('bounded_complete_archive_miss')
    },
    120_000
  )
})
