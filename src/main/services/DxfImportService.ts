import DxfParser, { type IDxf } from 'dxf-parser'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EntityName } from 'dxf-parser/dist/entities/geomtry.js'
import { entityToGeometry, unionBounds } from './DxfBbox.js'
import type {
  ImportedDxfDocument,
  ImportedPiece,
  ImportWarning
} from '@shared/domain/dxf.js'
import type { SourceFileId } from '@shared/domain/ids.js'

const SUPPORTED_ENTITIES: ReadonlySet<EntityName> = new Set<EntityName>([
  'LINE',
  'LWPOLYLINE',
  'POLYLINE',
  'CIRCLE',
  'ARC',
  'ELLIPSE'
])

export interface DxfImportOptions {
  /** Millimeters per DXF unit. Defaults to 1 (assume DXF is already in mm). */
  readonly millimetersPerUnit?: number
}

export class DxfImportError extends Error {
  readonly code: 'file_read_error' | 'dxf_parse_error'
  readonly path: string

  constructor(code: 'file_read_error' | 'dxf_parse_error', path: string, message: string) {
    super(message)
    this.code = code
    this.path = path
  }
}

/**
 * Reads a DXF file from disk, parses it, and converts supported entities
 * into compact pieces + per-document warnings. Unsupported entities are
 * skipped with a warning so the import never crashes.
 */
export async function importDxfFile(
  path: string,
  options: DxfImportOptions = {}
): Promise<ImportedDxfDocument> {
  const text = await readFile(path, 'utf8').catch((err: unknown) => {
    throw new DxfImportError(
      'file_read_error',
      path,
      err instanceof Error ? err.message : String(err)
    )
  })

  const parser = new DxfParser()
  const dxf = parser.parseSync(text) as IDxf | null
  if (!dxf) {
    throw new DxfImportError('dxf_parse_error', path, 'DXF parser returned no document')
  }

  const sourceFileId = randomUUID() as SourceFileId
  const pieces: ImportedPiece[] = []
  const warnings: ImportWarning[] = []
  const millimetersPerUnit = options.millimetersPerUnit ?? 1

  const entities = dxf.entities ?? []
  for (const entity of entities) {
    const entityType = entity.type as EntityName
    if (!SUPPORTED_ENTITIES.has(entityType)) {
      warnings.push({
        code: 'unsupported_dxf_entity',
        message: `Entity type ${entityType} is not supported and was skipped.`,
        entityType,
        entityHandle: entity.handle
      })
      continue
    }

    const converted = entityToGeometry(entity)
    if (!converted) {
      warnings.push({
        code: 'unsupported_dxf_entity',
        message: `Entity ${entityType} did not yield a usable geometry and was skipped.`,
        entityType,
        entityHandle: entity.handle
      })
      continue
    }

    const scaled = {
      x: converted.bounds.x * millimetersPerUnit,
      y: converted.bounds.y * millimetersPerUnit,
      width: converted.bounds.width * millimetersPerUnit,
      height: converted.bounds.height * millimetersPerUnit
    }

    pieces.push({
      id: randomUUID() as ImportedPiece['id'],
      sourceFileId,
      sourceLayer: entity.layer,
      label: `${entityType}-${entity.handle ?? pieces.length + 1}`,
      realBounds: scaled,
      geometry: converted.geometry,
      warnings: []
    })
  }

  const overallBounds = unionBounds(pieces.map((p) => p.realBounds))

  return {
    id: sourceFileId,
    path,
    fileName: basename(path),
    millimetersPerUnit,
    pieces,
    warnings: [
      ...warnings,
      ...(overallBounds
        ? []
        : [
            {
              code: 'unsupported_dxf_entity',
              message: 'No supported entities were found in this DXF file.'
            } as ImportWarning
          ])
    ]
  }
}

/** Imports multiple DXF files, returning each result; failures become a placeholder. */
export async function importDxfFiles(
  paths: ReadonlyArray<string>,
  options: DxfImportOptions = {}
): Promise<ReadonlyArray<ImportedDxfDocument | { readonly path: string; readonly error: DxfImportError }>> {
  return Promise.all(
    paths.map(async (path) => {
      try {
        return await importDxfFile(path, options)
      } catch (err) {
        if (err instanceof DxfImportError) return { path, error: err }
        throw err
      }
    })
  )
}