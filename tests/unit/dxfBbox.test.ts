import { describe, expect, it } from 'vitest'
import DxfParser, { type IDxf } from 'dxf-parser'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { entityToGeometry, unionBounds } from '@main/services/DxfBbox.js'
import { importDxfFile } from '@main/services/DxfImportService.js'

/**
 * Helper: parse a minimal DXF (one entity) and return the single entity.
 * Test fixtures are inline to avoid filesystem dependencies.
 */
function parseFirstEntity(dxf: string): import('dxf-parser/dist/entities/geomtry.js').IEntity {
  const parser = new DxfParser()
  const parsed = parser.parseSync(dxf) as IDxf | null
  if (!parsed) throw new Error('Parser returned null')
  const entity = parsed.entities[0]
  if (!entity) throw new Error('No entity parsed')
  return entity
}

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

describe('entityToGeometry', () => {
  it('converts a single LINE into a 1-segment line geometry', () => {
    const dxf =
      baseOpen() +
      section('ENTITIES') +
      '0\nLINE\n10\n0\n20\n0\n30\n0\n11\n10\n21\n5\n31\n0\n' +
      endsec() +
      baseClose()
    const entity = parseFirstEntity(dxf)
    const result = entityToGeometry(entity)
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.geometry.entityType).toBe('LINE')
    expect(result.geometry.segments.length).toBe(1)
    expect(result.geometry.segments[0]?.kind).toBe('line')
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 10, height: 5 })
  })

  it('converts a closed LWPOLYLINE (4 verts) into line segments and matching bbox', () => {
    const dxf =
      baseOpen() +
      section('ENTITIES') +
      '0\nLWPOLYLINE\n70\n1\n90\n4\n' +
      '10\n0\n20\n0\n10\n10\n20\n0\n10\n10\n20\n5\n10\n0\n20\n5\n' +
      endsec() +
      baseClose()
    const entity = parseFirstEntity(dxf)
    const result = entityToGeometry(entity)
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.geometry.entityType).toBe('LWPOLYLINE')
    expect(result.geometry.closed).toBe(true)
    expect(result.geometry.segments.length).toBe(4)
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 10, height: 5 })
  })

  it('converts a CIRCLE into a 2x-radius bbox', () => {
    const dxf =
      baseOpen() +
      section('ENTITIES') +
      '0\nCIRCLE\n10\n5\n20\n5\n30\n0\n40\n3\n' +
      endsec() +
      baseClose()
    const entity = parseFirstEntity(dxf)
    const result = entityToGeometry(entity)
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.geometry.entityType).toBe('CIRCLE')
    expect(result.bounds).toEqual({ x: 2, y: 2, width: 6, height: 6 })
  })

  it('converts an ARC into a conservative bbox equal to the parent circle', () => {
    const dxf =
      baseOpen() +
      section('ENTITIES') +
      '0\nARC\n10\n0\n20\n0\n30\n0\n40\n5\n50\n0\n51\n90\n' +
      endsec() +
      baseClose()
    const entity = parseFirstEntity(dxf)
    const result = entityToGeometry(entity)
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.geometry.entityType).toBe('ARC')
    expect(result.bounds).toEqual({ x: -5, y: -5, width: 10, height: 10 })
    expect(result.geometry.segments[0]?.kind).toBe('arc')
  })

  it('returns null for unsupported entity types (e.g. SPLINE)', () => {
    const dxf = baseOpen() + section('ENTITIES') + '0\nSPLINE\n70\n0\n' + endsec() + baseClose()
    const entity = parseFirstEntity(dxf)
    expect(entityToGeometry(entity)).toBeNull()
  })
})

describe('unionBounds', () => {
  it('returns null for an empty list', () => {
    expect(unionBounds([])).toBeNull()
  })

  it('returns the union of multiple rectangles', () => {
    const result = unionBounds([
      { x: 0, y: 0, width: 10, height: 5 },
      { x: 5, y: 3, width: 8, height: 4 }
    ])
    expect(result).toEqual({ x: 0, y: 0, width: 13, height: 7 })
  })

  it('handles a single rectangle', () => {
    const result = unionBounds([{ x: 1, y: 2, width: 3, height: 4 }])
    expect(result).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })
})

describe('importDxfFile', () => {
  it('groups supported entities from one DXF file into one selectable imported piece', async () => {
    const dir = join(tmpdir(), `min-plane-dxf-import-${randomUUID()}`)
    const path = join(dir, 'rectangle.dxf')
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
      await mkdir(dir, { recursive: true })
      await writeFile(path, dxf, 'utf8')
      const document = await importDxfFile(path)
      expect(document.pieces.length).toBe(1)
      const piece = document.pieces[0]
      expect(piece?.label).toBe('rectangle')
      expect(piece?.geometry.segments.length).toBe(4)
      expect(piece?.realBounds).toEqual({ x: 0, y: 0, width: 154, height: 104 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes fractional DXF bounds into an integer millimeter container', async () => {
    const dir = join(tmpdir(), `min-plane-dxf-import-${randomUUID()}`)
    const path = join(dir, 'fractional.dxf')
    const dxf =
      baseOpen() +
      section('ENTITIES') +
      '0\nLWPOLYLINE\n70\n1\n90\n4\n' +
      '10\n10.2\n20\n5.7\n10\n20.1\n20\n5.7\n10\n20.1\n20\n11.2\n10\n10.2\n20\n11.2\n' +
      endsec() +
      baseClose()

    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path, dxf, 'utf8')
      const document = await importDxfFile(path)
      const piece = document.pieces[0]
      expect(piece?.realBounds).toEqual({ x: 0, y: 0, width: 11, height: 7 })
      const segment = piece?.geometry.segments[0]
      expect(segment?.kind).toBe('line')
      if (segment?.kind !== 'line') return
      expect(segment.x1).toBeCloseTo(0.2)
      expect(segment.y1).toBeCloseTo(0.7)
      expect(segment.x2).toBeCloseTo(10.1)
      expect(segment.y2).toBeCloseTo(0.7)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
