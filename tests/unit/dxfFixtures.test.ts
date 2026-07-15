import { describe, expect, it } from 'vitest'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importDxfFile } from '@main/services/DxfImportService.js'
import {
  INVALID_OUTLINE_FIXTURES,
  IRREGULAR_DXF_FIXTURES,
  VALID_SINGLE_OUTLINE_FIXTURES
} from '../fixtures/irregularBenchmarkFixtures.js'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const fixturesDir = join(repoRoot, 'tests', 'fixtures', 'dxf')

describe('DXF fixtures', () => {
  it('keeps the expected irregular shape corpus checked in', async () => {
    const files = await readdir(fixturesDir)
    expect(files.filter((file) => file.endsWith('.dxf')).sort()).toEqual(
      [...IRREGULAR_DXF_FIXTURES].sort()
    )
  })

  it.each(IRREGULAR_DXF_FIXTURES)('imports %s into usable geometry', async (fixtureName) => {
    const document = await importDxfFile(join(fixturesDir, fixtureName))
    expect(document.pieces.length).toBe(1)
    const piece = document.pieces[0]
    expect(piece?.geometry.segments.length).toBeGreaterThan(0)
    expect(piece?.realBounds.width).toBeGreaterThan(0)
    expect(piece?.realBounds.height).toBeGreaterThan(0)
  })

  it.each(VALID_SINGLE_OUTLINE_FIXTURES)('keeps %s nestable', async (fixtureName) => {
    const document = await importDxfFile(join(fixturesDir, fixtureName))
    expect(document.pieces[0]?.geometry.closed).toBe(true)
    expect(document.pieces[0]?.warnings).toEqual([])
    expect(document.warnings).toEqual([])
  })

  it.each(INVALID_OUTLINE_FIXTURES)(
    'marks %s as non-nestable when topology is ambiguous',
    async (fixtureName) => {
      const document = await importDxfFile(join(fixturesDir, fixtureName))
      expect(document.pieces[0]?.geometry.closed).toBe(false)
      expect(document.pieces[0]?.warnings.length).toBeGreaterThan(0)
    }
  )
})
