import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { importDxfFile } from '@main/services/DxfImportService.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'

function pair(code: number, value: number | string): string {
  return `${code}\n${value}\n`
}

function dxf(entities: ReadonlyArray<string>): string {
  return [
    pair(0, 'SECTION'),
    pair(2, 'HEADER'),
    pair(0, 'ENDSEC'),
    pair(0, 'SECTION'),
    pair(2, 'ENTITIES'),
    ...entities,
    pair(0, 'ENDSEC'),
    pair(0, 'EOF')
  ].join('')
}

function line(x1: number, y1: number, x2: number, y2: number): string {
  return [
    pair(0, 'LINE'),
    pair(10, x1),
    pair(20, y1),
    pair(30, 0),
    pair(11, x2),
    pair(21, y2),
    pair(31, 0)
  ].join('')
}

function closedPolyline(x: number, y: number): string {
  return [
    pair(0, 'LWPOLYLINE'),
    pair(70, 1),
    pair(90, 4),
    pair(10, x),
    pair(20, y),
    pair(10, x + 20),
    pair(20, y),
    pair(10, x + 20),
    pair(20, y + 10),
    pair(10, x),
    pair(20, y + 10)
  ].join('')
}

function closedBowTiePolyline(): string {
  return [
    pair(0, 'LWPOLYLINE'),
    pair(70, 1),
    pair(90, 4),
    pair(10, 0),
    pair(20, 0),
    pair(10, 20),
    pair(20, 10),
    pair(10, 0),
    pair(20, 10),
    pair(10, 20),
    pair(20, 0)
  ].join('')
}

/** Writes one inline DXF and removes it after the import assertion. */
async function withImportedDxf(
  entities: ReadonlyArray<string>,
  assertion: (path: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `min-plane-dxf-topology-${randomUUID()}-`))
  const path = join(directory, 'topology.dxf')
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(path, dxf(entities), 'utf8')
    await assertion(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('DXF outline topology', () => {
  it('accepts connected LINE entities only when they form one closed cycle', async () => {
    await withImportedDxf(
      [line(0, 0, 20, 0), line(20, 0, 20, 10), line(20, 10, 0, 10), line(0, 10, 0, 0)],
      async (path) => {
        const document = await importDxfFile(path)
        const piece = document.pieces[0]
        expect(piece?.geometry.closed).toBe(true)
        expect(piece?.warnings).toEqual([])
      }
    )
  })

  it('reports an open source outline at piece level', async () => {
    await withImportedDxf(
      [
        [
          pair(0, 'LWPOLYLINE'),
          pair(70, 0),
          pair(90, 3),
          pair(10, 0),
          pair(20, 0),
          pair(10, 20),
          pair(20, 0),
          pair(10, 20),
          pair(20, 10)
        ].join('')
      ],
      async (path) => {
        const document = await importDxfFile(path)
        const piece = document.pieces[0]
        expect(piece?.geometry.closed).toBe(false)
        expect(piece?.warnings.some((warning) => warning.code === 'open_outline')).toBe(true)
        if (piece === undefined) throw new Error('open DXF test did not produce a piece')
        const collisionResult = await Effect.runPromise(
          CollisionGeometryBuilder.use((builder) =>
            builder.buildPiece({ piece, totalPaddingMm: 0 })
          ).pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => null
            }),
            Effect.provide(CollisionGeometryBuilder.Live)
          )
        )
        expect(collisionResult?._tag).toBe('IrregularGeometryInputError')
      }
    )
  })

  it('reports multiple closed entities as a disconnected grouped piece', async () => {
    await withImportedDxf([closedPolyline(0, 0), closedPolyline(40, 0)], async (path) => {
      const document = await importDxfFile(path)
      const piece = document.pieces[0]
      expect(piece?.geometry.closed).toBe(false)
      expect(piece?.warnings.some((warning) => warning.code === 'disconnected_outline')).toBe(true)
    })
  })

  it('reports branched endpoint graphs as ambiguous', async () => {
    await withImportedDxf(
      [line(0, 0, 20, 0), line(20, 0, 20, 10), line(20, 0, 20, -10)],
      async (path) => {
        const document = await importDxfFile(path)
        const piece = document.pieces[0]
        expect(piece?.geometry.closed).toBe(false)
        expect(piece?.warnings.some((warning) => warning.code === 'ambiguous_outline')).toBe(true)
      }
    )
  })

  it('rejects a closed self-intersecting polyline before a hull can hide its boundary', async () => {
    await withImportedDxf([closedBowTiePolyline()], async (path) => {
      const document = await importDxfFile(path)
      const piece = document.pieces[0]
      expect(piece?.geometry.closed).toBe(false)
      expect(piece?.warnings.some((warning) => warning.code === 'self_intersecting_outline')).toBe(
        true
      )
    })
  })

  it('rejects a degree-two LINE bow tie before a hull can hide its boundary', async () => {
    await withImportedDxf(
      [line(0, 0, 20, 10), line(20, 10, 0, 10), line(0, 10, 20, 0), line(20, 0, 0, 0)],
      async (path) => {
        const document = await importDxfFile(path)
        const piece = document.pieces[0]
        expect(piece?.geometry.closed).toBe(false)
        expect(piece?.warnings.some((warning) => warning.code === 'self_intersecting_outline')).toBe(
          true
        )
      }
    )
  })

  it('does not close a disconnected outline more loosely at large coordinates', async () => {
    const base = 1_000_000_000
    await withImportedDxf(
      [
        line(base, 0, base + 20, 0),
        line(base + 20.01, 0, base + 20, 10),
        line(base + 20, 10, base, 10),
        line(base, 10, base, 0)
      ],
      async (path) => {
        const document = await importDxfFile(path)
        const piece = document.pieces[0]
        expect(piece?.geometry.closed).toBe(false)
        expect(piece?.warnings.some((warning) => warning.code === 'open_outline')).toBe(true)
      }
    )
  })

  it('reports partially unsupported source outlines on the affected piece', async () => {
    await withImportedDxf(
      [closedPolyline(0, 0), [pair(0, 'SPLINE'), pair(70, 0)].join('')],
      async (path) => {
        const document = await importDxfFile(path)
        const piece = document.pieces[0]
        expect(document.warnings.some((warning) => warning.code === 'unsupported_dxf_entity')).toBe(
          true
        )
        expect(piece?.geometry.closed).toBe(false)
        expect(
          piece?.warnings.some((warning) => warning.code === 'partially_unsupported_outline')
        ).toBe(true)
      }
    )
  })
})
