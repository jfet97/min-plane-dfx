import { describe, expect, it } from 'vitest'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { WorkspaceProjectService } from '@main/services/WorkspaceProjectService.js'

function section(name: string): string {
  return `0\nSECTION\n2\n${name}\n`
}

function endsec(): string {
  return '0\nENDSEC\n'
}

function header(): string {
  return section('HEADER') + '0\nENDSEC\n'
}

const baseOpen = (): string => header() + section('TABLES') + endsec() + section('BLOCKS') + endsec()
const baseClose = (): string => '0\nEOF\n'

describe('WorkspaceProjectService', () => {
  it('creates a temporary SQLite workspace, copies DXF files, and lists persisted imports from a fresh service', async () => {
    const dir = join(tmpdir(), `min-plane-workspace-${randomUUID()}`)
    const sourceDir = join(dir, 'source')
    const sourcePath = join(sourceDir, 'rectangle.dxf')
    const dxf = baseOpen() +
      section('ENTITIES') +
      '0\nLINE\n10\n0\n20\n0\n30\n0\n11\n154\n21\n0\n31\n0\n' +
      '0\nLINE\n10\n154\n20\n0\n30\n0\n11\n154\n21\n104\n31\n0\n' +
      '0\nLINE\n10\n154\n20\n104\n30\n0\n11\n0\n21\n104\n31\n0\n' +
      '0\nLINE\n10\n0\n20\n104\n30\n0\n11\n0\n21\n0\n31\n0\n' +
      endsec() + baseClose()

    try {
      await mkdir(sourceDir, { recursive: true })
      await writeFile(sourcePath, dxf, 'utf8')
      const service = new WorkspaceProjectService(dir)
      let documents
      try {
        await service.initialize()
        documents = await service.importDxfFiles([sourcePath])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('NODE_MODULE_VERSION')) {
          console.warn('Skipping SQLite workspace smoke test:', message)
          return
        }
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
})
