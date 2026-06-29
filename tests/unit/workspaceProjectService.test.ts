import { describe, expect, it } from 'vitest'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { WorkspaceProjectService } from '@main/services/WorkspaceProjectService.js'
import { makePresetShapeDocument } from '@shared/presetShapes.js'
import { DEFAULT_STRATEGY_ID } from '@shared/domain/strategies.js'
import { DEFAULT_LAYOUT_SELECTION_STRATEGY_ID } from '@shared/domain/layoutSelectionStrategies.js'

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

function skipIfNativeSqliteMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('NODE_MODULE_VERSION')) return false
  console.warn('Skipping SQLite workspace smoke test:', message)
  return true
}

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
      let documents
      try {
        await service.initialize()
        documents = await service.importDxfFiles([sourcePath])
      } catch (error) {
        if (skipIfNativeSqliteMismatch(error)) return
        throw error
      }

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
      let stored
      try {
        await service.initialize()
        stored = await service.storeSourceDocument(preset)
      } catch (error) {
        if (skipIfNativeSqliteMismatch(error)) return
        throw error
      }

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
      try {
        await service.initialize()
        await service.saveWorkspaceSettings(settings)
      } catch (error) {
        if (skipIfNativeSqliteMismatch(error)) return
        throw error
      }

      const reloadedService = new WorkspaceProjectService(dir)
      await reloadedService.initialize()

      await expect(reloadedService.loadWorkspaceSettings()).resolves.toEqual(settings)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores stale temporary workspace settings writes', async () => {
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
    const staleSettings = {
      ...newerSettings,
      revision: 1,
      sheet: { width: 1000, height: 1000, label: 'stale' }
    }

    try {
      const service = new WorkspaceProjectService(dir)
      try {
        await service.initialize()
        await service.saveWorkspaceSettings(newerSettings)
        await service.saveWorkspaceSettings(staleSettings)
      } catch (error) {
        if (skipIfNativeSqliteMismatch(error)) return
        throw error
      }

      await expect(service.loadWorkspaceSettings()).resolves.toEqual(newerSettings)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
