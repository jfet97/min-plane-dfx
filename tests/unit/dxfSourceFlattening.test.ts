import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { importDxfFile } from '@main/services/DxfImportService.js'
import { cloneImportedPiece } from '@shared/sourcePiecesForPreparedPieces.js'
import { IrregularGeometrySettings, IrregularNestingSettings } from '@shared/irregular/domain.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import type { ImportedPiece } from '@shared/domain/dxf.js'

function pair(code: number, value: number | string): string {
  return `${code}\n${value}\n`
}

function dxf(entity: string): string {
  return [
    pair(0, 'SECTION'),
    pair(2, 'HEADER'),
    pair(0, 'ENDSEC'),
    pair(0, 'SECTION'),
    pair(2, 'ENTITIES'),
    entity,
    pair(0, 'ENDSEC'),
    pair(0, 'EOF')
  ].join('')
}

function bulgePolyline(): string {
  return [
    pair(0, 'LWPOLYLINE'),
    pair(70, 1),
    pair(90, 3),
    pair(10, 0),
    pair(20, 0),
    pair(42, 1),
    pair(10, 20),
    pair(20, 0),
    pair(10, 0),
    pair(20, 20)
  ].join('')
}

function ellipse(): string {
  return [
    pair(0, 'ELLIPSE'),
    pair(10, 30),
    pair(20, 20),
    pair(30, 0),
    pair(11, 40),
    pair(21, 0),
    pair(31, 0),
    pair(40, 0.5),
    pair(41, 0),
    pair(42, Math.PI * 2)
  ].join('')
}

/** Imports one source entity and guarantees temporary-file cleanup. */
async function importEntity(entity: string): Promise<ImportedPiece> {
  const directory = await mkdtemp(join(tmpdir(), `min-plane-dxf-flatten-${randomUUID()}-`))
  const path = join(directory, 'source.dxf')
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(path, dxf(entity), 'utf8')
    const document = await importDxfFile(path)
    const piece = document.pieces[0]
    if (piece === undefined) throw new Error('DXF test entity did not produce a piece')
    return piece
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Flattens one piece with a supplied collision sag tolerance. */
async function flatten(piece: ImportedPiece, sagToleranceMm: number) {
  const settings = new IrregularGeometrySettings({
    flatteningSagToleranceMm: sagToleranceMm,
    clearanceSafetyMarginMm: sagToleranceMm,
    geometryBackendId: 'test-geometry-backend',
    geometryBackendVersion: 'source-fidelity'
  })
  return Effect.runPromise(
    GeometryKernel.use((kernel) => kernel.flattenSourceGeometry({ piece })).pipe(
      Effect.provide(GeometryKernel.Layer),
      Effect.provide(
        Layer.succeed(
          GeometrySettings,
          new IrregularNestingSettings({
            geometry: settings,
            optimizer: GeometrySettings.Make.optimizer
          })
        )
      )
    )
  )
}

describe('DXF source flattening fidelity', () => {
  it('preserves bulges through source-piece cloning and samples tighter tolerances more densely', async () => {
    const piece = await importEntity(bulgePolyline())
    const firstSegment = piece.geometry.segments[0]
    expect(firstSegment?.kind).toBe('line')
    if (firstSegment?.kind !== 'line') return
    expect(firstSegment.bulge).toBe(1)

    const clonedPiece = cloneImportedPiece(piece)
    const loose = await flatten(clonedPiece, 1)
    const tight = await flatten(clonedPiece, 0.1)

    expect(tight.sampledPoints.length).toBeGreaterThan(loose.sampledPoints.length)
  })

  it('preserves ellipse parameters through normalization and samples them at collision tolerance', async () => {
    const piece = await importEntity(ellipse())
    const firstSegment = piece.geometry.segments[0]
    expect(firstSegment?.kind).toBe('line')
    if (firstSegment?.kind !== 'line') return
    expect(firstSegment.sourceCurve).toMatchObject({
      kind: 'ellipse',
      cx: 40,
      cy: 20,
      majorAxisX: 40,
      majorAxisY: 0,
      axisRatio: 0.5
    })

    const loose = await flatten(cloneImportedPiece(piece), 5)
    const tight = await flatten(cloneImportedPiece(piece), 0.25)

    expect(tight.sampledPoints.length).toBeGreaterThan(loose.sampledPoints.length)
  })
})
