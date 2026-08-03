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

  it('preserves an LWPOLYLINE bulge and includes its arc in the bounds', () => {
    const dxf =
      baseOpen() +
      section('ENTITIES') +
      '0\nLWPOLYLINE\n70\n0\n90\n2\n' +
      '10\n0\n20\n0\n42\n1\n10\n10\n20\n0\n' +
      endsec() +
      baseClose()
    const entity = parseFirstEntity(dxf)
    const result = entityToGeometry(entity)
    expect(result).not.toBeNull()
    if (!result) return
    const segment = result.geometry.segments[0]
    expect(segment?.kind).toBe('line')
    if (segment?.kind !== 'line') return
    expect(segment.bulge).toBe(1)
    expect(result.bounds.x).toBeCloseTo(0)
    expect(result.bounds.y).toBeCloseTo(-5)
    expect(result.bounds.width).toBeCloseTo(10)
    expect(result.bounds.height).toBeCloseTo(5)
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

  it('converts an ARC into degree angles and exact arc bounds', () => {
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
    expect(result.bounds.x).toBeCloseTo(0)
    expect(result.bounds.y).toBeCloseTo(0)
    expect(result.bounds.width).toBeCloseTo(5)
    expect(result.bounds.height).toBeCloseTo(5)
    const segment = result.geometry.segments[0]
    expect(segment?.kind).toBe('arc')
    if (segment?.kind !== 'arc') return
    expect(segment.startAngle).toBeCloseTo(0)
    expect(segment.endAngle).toBeCloseTo(90)
  })

  it('keeps rounded rectangle ARC entities connected using degree angles', () => {
    const dxf =
      baseOpen() +
      section('ENTITIES') +
      '0\nLINE\n10\n0\n20\n0\n30\n0\n11\n800\n21\n0\n31\n0\n' +
      '0\nLINE\n10\n800\n20\n0\n30\n0\n11\n800\n21\n520\n31\n0\n' +
      '0\nARC\n10\n770\n20\n520\n30\n0\n40\n30\n50\n0\n51\n90\n' +
      '0\nLINE\n10\n770\n20\n550\n30\n0\n11\n30\n21\n550\n31\n0\n' +
      '0\nARC\n10\n30\n20\n520\n30\n0\n40\n30\n50\n90\n51\n180\n' +
      '0\nLINE\n10\n0\n20\n520\n30\n0\n11\n0\n21\n0\n31\n0\n' +
      endsec() +
      baseClose()
    const parser = new DxfParser()
    const parsed = parser.parseSync(dxf) as IDxf | null
    if (!parsed) throw new Error('Parser returned null')
    const results = parsed.entities
      .map((entity) => entityToGeometry(entity))
      .filter(
        (result): result is NonNullable<ReturnType<typeof entityToGeometry>> => result !== null
      )
    const segments = results.flatMap((result) => result.geometry.segments)
    const arcs = segments.filter((segment) => segment.kind === 'arc')
    const bounds = unionBounds(results.map((result) => result.bounds))

    expect(arcs.length).toBe(2)
    expect(arcs[0]?.startAngle).toBeCloseTo(0)
    expect(arcs[0]?.endAngle).toBeCloseTo(90)
    expect(arcs[1]?.startAngle).toBeCloseTo(90)
    expect(arcs[1]?.endAngle).toBeCloseTo(180)
    expect(bounds).toEqual({ x: 0, y: 0, width: 800, height: 550 })
  })

  it('converts an ELLIPSE into a line approximation with matching bbox', () => {
    const dxf =
      baseOpen() +
      section('ENTITIES') +
      '0\nELLIPSE\n10\n20\n20\n10\n30\n0\n11\n40\n21\n0\n31\n0\n40\n0.5\n41\n0\n42\n6.283185307179586\n' +
      endsec() +
      baseClose()
    const entity = parseFirstEntity(dxf)
    const result = entityToGeometry(entity)
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.geometry.entityType).toBe('ELLIPSE')
    expect(result.geometry.segments.length).toBeGreaterThan(16)
    expect(result.geometry.segments.every((segment) => segment.kind === 'line')).toBe(true)
    expect(result.bounds.x).toBeCloseTo(-20)
    expect(result.bounds.y).toBeCloseTo(-10)
    expect(result.bounds.width).toBeCloseTo(80)
    expect(result.bounds.height).toBeCloseTo(40)
    const sourceCurve = result.geometry.segments[0]
    expect(sourceCurve?.kind).toBe('line')
    if (sourceCurve?.kind !== 'line') return
    expect(sourceCurve.sourceCurve).toMatchObject({
      kind: 'ellipse',
      cx: 20,
      cy: 10,
      majorAxisX: 40,
      majorAxisY: 0,
      axisRatio: 0.5,
      startAngle: 0,
      endAngle: 6.283185307179586
    })
  })

  it('keeps a partial ELLIPSE open and computes bounds for only its sweep', () => {
    const dxf =
      baseOpen() +
      section('ENTITIES') +
      '0\nELLIPSE\n10\n20\n20\n10\n30\n0\n11\n40\n21\n0\n31\n0\n40\n0.5\n41\n0\n42\n1.5707963267948966\n' +
      endsec() +
      baseClose()
    const entity = parseFirstEntity(dxf)
    const result = entityToGeometry(entity)
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.geometry.closed).toBe(false)
    expect(result.bounds.x).toBeCloseTo(20)
    expect(result.bounds.y).toBeCloseTo(10)
    expect(result.bounds.width).toBeCloseTo(40)
    expect(result.bounds.height).toBeCloseTo(20)
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
    const dir = join(tmpdir(), `min-plane-dfx-import-${randomUUID()}`)
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
    const dir = join(tmpdir(), `min-plane-dfx-import-${randomUUID()}`)
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
