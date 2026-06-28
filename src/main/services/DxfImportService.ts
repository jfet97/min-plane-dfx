import DxfParser from 'dxf-parser'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EntityName } from 'dxf-parser/dist/entities/geomtry.js'
import { entityToGeometry, unionBounds } from './DxfBbox.js'
import {
  DxfGeometrySummary,
  ImportedDxfDocument,
  ImportedPiece,
  ImportWarning
} from '@shared/domain/dxf.js'
import type { SourceFileId } from '@shared/domain/ids.js'
import { Rect } from '@shared/domain/geometry.js'

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

type Entity = Parameters<typeof entityToGeometry>[0]
type Segment = DxfGeometrySummary['segments'][number]
type Bounds = ImportedPiece['realBounds']

function isDxfDocument(value: unknown): value is { readonly entities?: ReadonlyArray<Entity> } {
  if (typeof value !== 'object' || value === null) return false
  const entities = (value as { readonly entities?: unknown }).entities
  return entities === undefined || Array.isArray(entities)
}

function scaleSegment(segment: Segment, factor: number): Segment {
  if (segment.kind === 'line') {
    return {
      kind: 'line',
      x1: segment.x1 * factor,
      y1: segment.y1 * factor,
      x2: segment.x2 * factor,
      y2: segment.y2 * factor
    }
  }
  return {
    kind: 'arc',
    x1: segment.x1 * factor,
    y1: segment.y1 * factor,
    x2: segment.x2 * factor,
    y2: segment.y2 * factor,
    ...(segment.cx !== undefined ? { cx: segment.cx * factor } : {}),
    ...(segment.cy !== undefined ? { cy: segment.cy * factor } : {}),
    ...(segment.radius !== undefined ? { radius: segment.radius * factor } : {}),
    ...(segment.startAngle !== undefined ? { startAngle: segment.startAngle } : {}),
    ...(segment.endAngle !== undefined ? { endAngle: segment.endAngle } : {})
  }
}

function scaleBounds(bounds: Bounds, factor: number): Bounds {
  return new Rect({
    x: bounds.x * factor,
    y: bounds.y * factor,
    width: bounds.width * factor,
    height: bounds.height * factor
  })
}

function commonLayer(layers: ReadonlyArray<string | undefined>): string | undefined {
  const defined = layers.filter((layer): layer is string => layer !== undefined && layer.length > 0)
  if (defined.length === 0) return undefined
  const first = defined[0]
  return defined.every((layer) => layer === first) ? first : 'multiple'
}

/**
 * Reads a DXF file from disk, parses it, and converts supported entities
 * into one selectable imported shape per file. Unsupported entities are
 * skipped with document warnings so the import never crashes.
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
  const parsed = parser.parseSync(text)
  if (!isDxfDocument(parsed)) {
    throw new DxfImportError('dxf_parse_error', path, 'DXF parser returned no document')
  }

  const sourceFileId = randomUUID() as SourceFileId
  const warnings: ImportWarning[] = []
  const millimetersPerUnit = options.millimetersPerUnit ?? 1
  const convertedSegments: Segment[] = []
  const convertedBounds: Bounds[] = []
  const convertedEntityTypes = new Set<string>()
  const convertedLayers: Array<string | undefined> = []
  let convertedEntityCount = 0

  const entities = parsed.entities ?? []
  for (const entity of entities) {
    const entityType = entity.type as EntityName
    if (!SUPPORTED_ENTITIES.has(entityType)) {
      warnings.push(
        new ImportWarning({
          code: 'unsupported_dxf_entity',
          message: `Entity type ${entityType} is not supported and was skipped.`,
          entityType,
          entityHandle: entity.handle
        })
      )
      continue
    }

    const converted = entityToGeometry(entity)
    if (!converted) {
      warnings.push(
        new ImportWarning({
          code: 'unsupported_dxf_entity',
          message: `Entity ${entityType} did not yield a usable geometry and was skipped.`,
          entityType,
          entityHandle: entity.handle
        })
      )
      continue
    }

    convertedEntityTypes.add(entityType)
    convertedEntityCount++
    convertedLayers.push(entity.layer)
    convertedSegments.push(
      ...converted.geometry.segments.map((segment) => scaleSegment(segment, millimetersPerUnit))
    )
    convertedBounds.push(scaleBounds(converted.bounds, millimetersPerUnit))
  }

  const overallBounds = unionBounds(convertedBounds)
  const pieces: ImportedPiece[] = overallBounds
    ? [
        new ImportedPiece({
          id: randomUUID() as ImportedPiece['id'],
          sourceFileId,
          sourceLayer: commonLayer(convertedLayers),
          label: basename(path, extname(path)),
          realBounds: overallBounds,
          geometry: new DxfGeometrySummary({
            entityType:
              convertedEntityCount === 1
                ? ([...convertedEntityTypes][0] ?? 'DXF_SHAPE')
                : 'DXF_SHAPE',
            closed: convertedSegments.length > 0,
            segments: convertedSegments
          }),
          warnings: []
        })
      ]
    : []

  return new ImportedDxfDocument({
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
            new ImportWarning({
              code: 'unsupported_dxf_entity',
              message: 'No supported entities were found in this DXF file.'
            })
          ])
    ]
  })
}

/** Imports multiple DXF files, returning each result; failures become a placeholder. */
export async function importDxfFiles(
  paths: ReadonlyArray<string>,
  options: DxfImportOptions = {}
): Promise<
  ReadonlyArray<ImportedDxfDocument | { readonly path: string; readonly error: DxfImportError }>
> {
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
