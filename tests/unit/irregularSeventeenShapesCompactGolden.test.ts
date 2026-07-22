import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { importDxfFile } from '../../src/main/services/DxfImportService.js'
import { ImportedPiece } from '../../src/shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '../../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../../src/shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '../../src/shared/irregular/defaults.js'
import { IrregularNestingSettings } from '../../src/shared/irregular/domain.js'
import { preparePieces } from '../../src/shared/preparePieces.js'
import { computeIrregularNesting } from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { canonicalCollisionLayoutIdentity } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'

const FIXTURE_DIRECTORY = fileURLToPath(
  new URL('../fixtures/irregularSeventeenShapes', import.meta.url)
)
const EXPECTED_CANONICAL_HASH =
  'c640c06f662050f8a132168f63988c40ba41f2ebc57dc50277a91119b4b4980a'

describe('compact-quality seventeen-shape golden', () => {
  it(
    'keeps the heterogeneous direct-archive baseline exact',
    async () => {
      const fileNames = (await readdir(FIXTURE_DIRECTORY))
        .filter((fileName) => fileName.endsWith('.dxf'))
        .sort((first, second) => first.localeCompare(second, undefined, { numeric: true }))
      expect(fileNames).toHaveLength(17)
      const sources = await Promise.all(
        fileNames.map(async (fileName, index) => {
          const document = await importDxfFile(join(FIXTURE_DIRECTORY, fileName))
          expect(document.warnings).toEqual([])
          expect(document.pieces).toHaveLength(1)
          const source = document.pieces[0]
          if (source === undefined) throw new Error(`${fileName} did not contain one piece`)
          expect(source.warnings).toEqual([])
          return new ImportedPiece({
            ...source,
            id: PieceId.make(`shapes-17-${index + 1}`),
            sourceFileId: SourceFileId.make(`shapes-17-source-${index + 1}`),
            label: fileName
          })
        })
      )
      const sheet = new SheetSpec({ width: 2000, height: 2700, label: 'shapes-17 golden' })
      const jobId = JobId.make('shapes-17-compact-golden')
      const prepared = preparePieces(sources, sheet, 10, jobId, undefined, undefined, () =>
        'shapes-17'
      )
      expect(prepared.warnings).toEqual([])
      const settings = new IrregularNestingSettings({
        geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
        optimizer: makeCompactQualityIrregularOptimizerSettings({ localRepairBudget: 0 })
      })
      const request = new NestingRequest({
        version: 1,
        jobId,
        sheet,
        padding: 10,
        pieces: prepared.pieces,
        sourcePieces: sources,
        options: new NestingOptions({
          allowGlobalRotation: true,
          allowGlobalMirror: true,
          timeoutMs: 390_000,
          workerMode: 'irregular-convex-v2',
          historyMode: 'off',
          historyScope: 'winning_path',
          strategySelectionMode: 'single',
          strategyIds: [],
          layoutSelectionStrategyId: 'compact-first',
          finalSelectionMode: 'best',
          irregularSettings: settings
        })
      })
      const computed = await Effect.runPromise(
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
      const discriminant =
        computed.score.collisionBoundsSpanMm * computed.score.collisionBoundsSpanMm -
        4 * computed.score.collisionBoundsAreaMm2
      const maximumSide =
        (computed.score.collisionBoundsSpanMm + Math.sqrt(Math.max(0, discriminant))) / 2

      expect(computed.portfolio.source).toBe('shared-archive')
      expect(computed.unplacedPieceIds).toEqual([])
      expect(computed.placedCollisionGeometries).toHaveLength(17)
      expect(
        createHash('sha256')
          .update(canonicalCollisionLayoutIdentity(computed.placedCollisionGeometries) ?? '')
          .digest('hex')
      ).toBe(EXPECTED_CANONICAL_HASH)
      expect(computed.score.collisionBoundsAreaMm2).toBeLessThanOrEqual(304_500)
      expect(maximumSide).toBeLessThanOrEqual(559.976)
      expect(computed.portfolio.score?.canonicalEnclosedCavityCount).toBe(0)
    },
    120_000
  )
})
