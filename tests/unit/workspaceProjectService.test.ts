import { describe, expect, it } from 'vitest'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { WorkspaceProjectService } from '@main/services/WorkspaceProjectService.js'
import { makePresetShapeDocument } from '@shared/presetShapes.js'
import { DEFAULT_STRATEGY_ID } from '@shared/domain/strategies.js'
import { DEFAULT_LAYOUT_SELECTION_STRATEGY_ID } from '@shared/domain/layoutSelectionStrategies.js'
import { JobId, PieceId } from '@shared/domain/ids.js'
import type { WorkspaceProjectSettings } from '@shared/domain/project.js'

function section(name: string): string {
  return `0\nSECTION\n2\n${name}\n`
}

function endsec(): string {
  return '0\nENDSEC\n'
}

function header(): string {
  return section('HEADER') + '0\nENDSEC\n'
}

const baseOpen = (): string =>
  header() + section('TABLES') + endsec() + section('BLOCKS') + endsec()
const baseClose = (): string => '0\nEOF\n'

describe('WorkspaceProjectService', () => {
  it('creates a temporary SQLite workspace, copies DXF files, and lists persisted imports from a fresh service', async () => {
    const dir = join(tmpdir(), `min-plane-workspace-${randomUUID()}`)
    const sourceDir = join(dir, 'source')
    const sourcePath = join(sourceDir, 'rectangle.dxf')
    const dxf =
      baseOpen() +
      section('ENTITIES') +
      '0\nLINE\n10\n0\n20\n0\n30\n0\n11\n154\n21\n0\n31\n0\n' +
      '0\nLINE\n10\n154\n20\n0\n30\n0\n11\n154\n21\n104\n31\n0\n' +
      '0\nLINE\n10\n154\n20\n104\n30\n0\n11\n0\n21\n104\n31\n0\n' +
      '0\nLINE\n10\n0\n20\n104\n30\n0\n11\n0\n21\n0\n31\n0\n' +
      endsec() +
      baseClose()

    try {
      await mkdir(sourceDir, { recursive: true })
      await writeFile(sourcePath, dxf, 'utf8')
      const service = new WorkspaceProjectService(dir)
      await service.initialize()
      const documents = await service.importDxfFiles([sourcePath])

      expect(documents.length).toBe(1)
      const document = documents[0]
      expect(document?.pieces.length).toBe(1)
      expect(document?.pieces[0]?.geometry.entityType).toBe('DXF_SHAPE')
      expect(document?.pieces[0]?.realBounds).toEqual({ x: 0, y: 0, width: 154, height: 104 })
      expect(document?.path).not.toBe(sourcePath)
      if (document) {
        await expect(stat(document.path)).resolves.toBeTruthy()
      }

      const reloadedService = new WorkspaceProjectService(dir)
      await reloadedService.initialize()
      const persistedDocuments = await reloadedService.listImportedDxfs()

      expect(persistedDocuments).toEqual(documents)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists preset source documents across a fresh service instance', async () => {
    const dir = join(tmpdir(), `min-plane-workspace-${randomUUID()}`)

    try {
      const service = new WorkspaceProjectService(dir)
      const preset = makePresetShapeDocument({
        kind: 'trapezoid',
        width: 120,
        height: 80,
        topWidth: 70,
        label: 'trap'
      })
      await service.initialize()
      const stored = await service.storeSourceDocument(preset)

      expect(stored).toEqual(preset)

      const reloadedService = new WorkspaceProjectService(dir)
      await reloadedService.initialize()
      const persistedDocuments = await reloadedService.listImportedDxfs()

      expect(persistedDocuments).toEqual([preset])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists temporary workspace settings across a fresh service instance', async () => {
    const dir = join(tmpdir(), `min-plane-workspace-${randomUUID()}`)
    const settings = {
      revision: 1,
      sheet: { width: 2000, height: 1000, label: 'shop sheet' },
      padding: 10,
      pieceQuantities: { source_a: 3 },
      options: {
        allowGlobalRotation: true,
        timeoutMs: 30000,
        workerMode: 'maxrects-beam-search' as const,
        historyMode: 'final' as const,
        historyScope: 'winning_path' as const,
        strategySelectionMode: 'single' as const,
        strategyIds: [DEFAULT_STRATEGY_ID],
        layoutSelectionStrategyId: DEFAULT_LAYOUT_SELECTION_STRATEGY_ID,
        finalSelectionMode: 'manual' as const,
        topN: 3
      }
    }

    try {
      const service = new WorkspaceProjectService(dir)
      await service.initialize()
      await service.saveWorkspaceSettings(settings)

      const reloadedService = new WorkspaceProjectService(dir)
      await reloadedService.initialize()

      await expect(reloadedService.loadWorkspaceSettings()).resolves.toEqual(settings)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists archived run records across a fresh service instance', async () => {
    const dir = join(tmpdir(), `min-plane-workspace-${randomUUID()}`)
    const jobId = JobId.make('job-1')
    const pieceId = PieceId.make('piece-1')
    const settings: WorkspaceProjectSettings = {
      revision: 1,
      sheet: { width: 2000, height: 1000, label: 'shop sheet' },
      padding: 10,
      pieceQuantities: { source_a: 3 },
      options: defaultOptions(),
      runRecords: [
        {
          jobId,
          createdAt: '2026-06-29T14:00:00.000Z',
          label: 'MaxRects beam search',
          pieceCount: 1,
          sheet: { width: 2000, height: 1000, label: 'shop sheet' },
          result: {
            version: 1,
            jobId,
            status: 'ok',
            strategyResults: [
              {
                strategyRunId: 'run-1-maxrects-beam-search',
                strategyId: 'maxrects-beam-search',
                strategyLabel: 'MaxRects beam search',
                status: 'completed',
                sortedPieceIds: [pieceId],
                placements: [{ pieceId, x: 0, y: 0, width: 100, height: 100, rotation: 0 }],
                unplacedPieceIds: [],
                warnings: [],
                stats: {
                  elapsedMs: 1,
                  pieceCount: 1,
                  algorithm: benchmark()
                }
              }
            ],
            selectedStrategyRunId: 'run-1-maxrects-beam-search',
            sortedPieceIds: [pieceId],
            placements: [{ pieceId, x: 0, y: 0, width: 100, height: 100, rotation: 0 }],
            unplacedPieceIds: [],
            warnings: [],
            stats: {
              elapsedMs: 1,
              pieceCount: 1,
              algorithm: benchmark()
            }
          },
          history: {
            kind: 'ndjson_replay',
            jobId,
            path: '/tmp/history-job-1.ndjson',
            frameCount: 3,
            createdAt: '2026-06-29T14:00:01.000Z'
          }
        }
      ]
    }

    try {
      const service = new WorkspaceProjectService(dir)
      await service.initialize()
      await service.saveWorkspaceSettings(settings)

      const reloadedService = new WorkspaceProjectService(dir)
      await reloadedService.initialize()

      await expect(reloadedService.loadWorkspaceSettings()).resolves.toEqual(settings)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts later temporary workspace settings writes regardless of revision', async () => {
    const dir = join(tmpdir(), `min-plane-workspace-${randomUUID()}`)
    const newerSettings = {
      revision: 2,
      sheet: { width: 4000, height: 1000, label: 'new' },
      padding: 10,
      pieceQuantities: {},
      options: {
        allowGlobalRotation: true,
        timeoutMs: 30000,
        workerMode: 'maxrects-beam-search' as const,
        historyMode: 'final' as const,
        historyScope: 'winning_path' as const,
        strategySelectionMode: 'single' as const,
        strategyIds: [DEFAULT_STRATEGY_ID],
        layoutSelectionStrategyId: DEFAULT_LAYOUT_SELECTION_STRATEGY_ID,
        finalSelectionMode: 'manual' as const,
        topN: 3
      }
    }
    const laterSettings = {
      ...newerSettings,
      revision: 1,
      sheet: { width: 1000, height: 1000, label: 'later' }
    }

    try {
      const service = new WorkspaceProjectService(dir)
      await service.initialize()
      await service.saveWorkspaceSettings(newerSettings)
      await service.saveWorkspaceSettings(laterSettings)

      await expect(service.loadWorkspaceSettings()).resolves.toEqual(laterSettings)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function defaultOptions(): WorkspaceProjectSettings['options'] {
  return {
    allowGlobalRotation: true,
    timeoutMs: 30000,
    workerMode: 'maxrects-beam-search',
    historyMode: 'final',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: [DEFAULT_STRATEGY_ID],
    layoutSelectionStrategyId: DEFAULT_LAYOUT_SELECTION_STRATEGY_ID,
    finalSelectionMode: 'manual',
    topN: 3
  }
}

function benchmark() {
  return {
    startedAt: '2026-06-29T14:00:00.000Z',
    endedAt: '2026-06-29T14:00:00.001Z',
    elapsedMs: 1
  }
}
