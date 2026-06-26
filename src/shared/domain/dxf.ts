import { Schema } from 'effect'
import { PieceId, SourceFileId } from './ids.js'
import { Rect } from './geometry.js'

/** Generic warning produced during import. */
export const ImportWarning = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  entityType: Schema.optional(Schema.String),
  entityHandle: Schema.optional(Schema.Union([Schema.String, Schema.Number]))
})
export type ImportWarning = Schema.Schema.Type<typeof ImportWarning>

/**
 * Compact, parser-agnostic summary of a single DXF entity.
 * The renderer uses this to redraw true geometry. The algorithm only sees
 * bounding boxes and sizes; raw geometry stays out of the worker protocol.
 */
export const DxfGeometrySummary = Schema.Struct({
  entityType: Schema.String,
  closed: Schema.Boolean,
  /** Rasterized line/arc samples in entity-local coordinates. */
  segments: Schema.Array(
    Schema.Struct({
      kind: Schema.Union([Schema.Literal('line'), Schema.Literal('arc')]),
      x1: Schema.Number,
      y1: Schema.Number,
      x2: Schema.Number,
      y2: Schema.Number,
      /** Center for arcs; required when kind === 'arc'. */
      cx: Schema.optional(Schema.Number),
      cy: Schema.optional(Schema.Number),
      radius: Schema.optional(Schema.Number),
      startAngle: Schema.optional(Schema.Number),
      endAngle: Schema.optional(Schema.Number)
    })
  )
})
export type DxfGeometrySummary = Schema.Schema.Type<typeof DxfGeometrySummary>

export const ImportedPiece = Schema.Struct({
  id: PieceId,
  sourceFileId: SourceFileId,
  sourceLayer: Schema.optional(Schema.String),
  label: Schema.String,
  realBounds: Rect,
  geometry: DxfGeometrySummary,
  warnings: Schema.Array(ImportWarning)
})
export type ImportedPiece = Schema.Schema.Type<typeof ImportedPiece>

export const ImportedDxfDocument = Schema.Struct({
  id: SourceFileId,
  path: Schema.String,
  fileName: Schema.String,
  /** User-declared unit interpretation in millimeters per DXF unit. */
  millimetersPerUnit: Schema.Number,
  pieces: Schema.Array(ImportedPiece),
  warnings: Schema.Array(ImportWarning)
})
export type ImportedDxfDocument = Schema.Schema.Type<typeof ImportedDxfDocument>
