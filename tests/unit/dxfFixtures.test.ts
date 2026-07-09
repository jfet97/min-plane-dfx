import { describe, expect, it } from 'vitest'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importDxfFile } from '@main/services/DxfImportService.js'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const fixturesDir = join(repoRoot, 'tests', 'fixtures', 'dxf')

const expectedFixtures = [
  'circle-ellipse-arcs.dxf',
  'concave-and-stars.dxf',
  'convex-polygons.dxf',
  'mixed-sheet-like-screenshot.dxf',
  'rounded-rectangle.dxf',
  'star-5-point.dxf',
  'thin-and-awkward.dxf',
  'transform-cases.dxf',
  'trapezoid.dxf',
  'triangle.dxf'
] as const

describe('DXF fixtures', () => {
  it('keeps the expected irregular shape corpus checked in', async () => {
    const files = await readdir(fixturesDir)
    expect(files.filter((file) => file.endsWith('.dxf')).sort()).toEqual([...expectedFixtures])
  })

  it.each(expectedFixtures)('imports %s into usable geometry', async (fixtureName) => {
    const document = await importDxfFile(join(fixturesDir, fixtureName))
    expect(document.pieces.length).toBe(1)
    const piece = document.pieces[0]
    expect(piece?.geometry.segments.length).toBeGreaterThan(0)
    expect(piece?.realBounds.width).toBeGreaterThan(0)
    expect(piece?.realBounds.height).toBeGreaterThan(0)
  })
})
