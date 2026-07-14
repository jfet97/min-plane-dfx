/** Shared DXF source, preview, warning, and imported-piece contracts. */

import { Schema } from 'effect'
import { PieceId, SourceFileId } from './ids.js'
import { Rect } from './geometry.js'

/** Finite numeric value retained from a DXF entity in millimeters or radians. */
const FiniteDxfNumber = Schema.Finite

/** Positive finite DXF length or ratio that cannot describe a degenerate curve. */
const PositiveFiniteDxfNumber = Schema.Finite.check(Schema.isGreaterThan(0))

/** Generic warning produced during import. */
export class ImportWarning extends Schema.Class<ImportWarning>('ImportWarning')({
  /** Stable warning category used by UI and tests. */
  code: Schema.String,
  /** Human-readable warning text safe to show in the UI. */
  message: Schema.String,
  /** Optional: original DXF entity type that produced the warning, when known. */
  entityType: Schema.optional(Schema.String),
  /** Optional: original DXF entity handle, when the parser provided one. */
  entityHandle: Schema.optional(Schema.Union([Schema.String, Schema.Number]))
}) {}

/**
 * Preserved DXF ellipse parameters attached to preview segments.
 *
 * The major-axis values are a vector from the ellipse center, while the angles
 * are DXF parameters in radians. `sourceId` identifies one original entity so
 * the collision flattener can sample a repeated preview approximation once.
 */
const DxfEllipseSourceFields = Schema.Struct({
  kind: Schema.Literal('ellipse'),
  sourceId: Schema.NonEmptyString,
  cx: FiniteDxfNumber,
  cy: FiniteDxfNumber,
  majorAxisX: FiniteDxfNumber,
  majorAxisY: FiniteDxfNumber,
  axisRatio: PositiveFiniteDxfNumber,
  startAngle: FiniteDxfNumber,
  endAngle: FiniteDxfNumber
}).check(
  Schema.makeFilter((ellipse) =>
    ellipse.majorAxisX !== 0 || ellipse.majorAxisY !== 0
      ? undefined
      : {
          path: ['majorAxisX'],
          issue: 'ellipse major-axis vector must not be zero.'
        }
  )
)

/** Validated analytic ellipse source retained by preview line segments. */
export const DxfEllipseSource = DxfEllipseSourceFields
export type DxfEllipseSource = Schema.Schema.Type<typeof DxfEllipseSource>

/** Preview line or chord carrying optional source-level curve parameters. */
export const DxfLineSegment = Schema.Struct({
  kind: Schema.Literal('line'),
  /** Segment start X in piece-local millimeters. */
  x1: FiniteDxfNumber,
  /** Segment start Y in piece-local millimeters. */
  y1: FiniteDxfNumber,
  /** Segment end X in piece-local millimeters. */
  x2: FiniteDxfNumber,
  /** Segment end Y in piece-local millimeters. */
  y2: FiniteDxfNumber,
  /** Original LWPOLYLINE/POLYLINE bulge for the segment, when non-zero. */
  bulge: Schema.optional(FiniteDxfNumber),
  /** Original ellipse parameters when this line is only a preview approximation. */
  sourceCurve: Schema.optional(DxfEllipseSource)
})
export type DxfLineSegment = Schema.Schema.Type<typeof DxfLineSegment>

/** Preview circular arc with source angles retained in degrees. */
export const DxfArcSegment = Schema.Struct({
  kind: Schema.Literal('arc'),
  /** Arc start X in piece-local millimeters. */
  x1: FiniteDxfNumber,
  /** Arc start Y in piece-local millimeters. */
  y1: FiniteDxfNumber,
  /** Arc end X in piece-local millimeters. */
  x2: FiniteDxfNumber,
  /** Arc end Y in piece-local millimeters. */
  y2: FiniteDxfNumber,
  /** Arc center X in piece-local millimeters. */
  cx: FiniteDxfNumber,
  /** Arc center Y in piece-local millimeters. */
  cy: FiniteDxfNumber,
  /** Arc radius in millimeters. */
  radius: PositiveFiniteDxfNumber,
  /** Arc start angle in degrees. */
  startAngle: FiniteDxfNumber,
  /** Arc end angle in degrees. */
  endAngle: FiniteDxfNumber
})
export type DxfArcSegment = Schema.Schema.Type<typeof DxfArcSegment>

/** Preview segment union consumed by renderer and source-fidelity collision code. */
export const DxfGeometrySegment = Schema.Union([DxfLineSegment, DxfArcSegment])
export type DxfGeometrySegment = Schema.Schema.Type<typeof DxfGeometrySegment>

export const DxfGeometryEntityType = Schema.Literals([
  'LINE',
  'LWPOLYLINE',
  'POLYLINE',
  'CIRCLE',
  'ARC',
  'ELLIPSE',
  'DXF_SHAPE',
  'PRESET_SHAPE'
])
export type DxfGeometryEntityType = Schema.Schema.Type<typeof DxfGeometryEntityType>

/**
 * Compact, parser-agnostic summary of imported DXF geometry.
 *
 * The renderer uses `segments` for a deterministic preview approximation. The
 * irregular worker also consumes source parameters carried by those segments
 * so collision sampling can use its configured sag tolerance instead of the
 * preview resolution.
 */
export class DxfGeometrySummary extends Schema.Class<DxfGeometrySummary>('DxfGeometrySummary')({
  /** Supported source geometry type, or grouped/preset shape marker. */
  entityType: DxfGeometryEntityType,
  /** Whether the imported summary should be treated as a closed outline. */
  closed: Schema.Boolean,
  /** Tagged line/arc segments in piece-local millimeter coordinates. */
  segments: Schema.Array(DxfGeometrySegment)
}) {}

export class ImportedPiece extends Schema.Class<ImportedPiece>('ImportedPiece')({
  /** Stable app-owned piece id; generated when missing from loaded data. */
  id: PieceId.withDefault,
  /** Source document id this piece was imported from. */
  sourceFileId: SourceFileId,
  /**
   * Optional: CAD drawing layer name shared by the grouped DXF entities, when
   * available. This is DXF metadata, not an Effect Layer.
   */
  sourceLayer: Schema.optional(Schema.String),
  /** Display label, usually derived from the source file name. */
  label: Schema.String,
  /** Integer millimeter bounds of the real imported geometry before padding. */
  realBounds: Rect,
  /** Parser-agnostic source geometry used for preview and irregular nesting input. */
  geometry: DxfGeometrySummary,
  /** Piece-local import warnings that apply to this imported piece. */
  warnings: Schema.Array(ImportWarning)
}) {}

export class ImportedDxfDocument extends Schema.Class<ImportedDxfDocument>('ImportedDxfDocument')({
  /** Stable app-owned source file id; generated when missing from loaded data. */
  id: SourceFileId.withDefault,
  /** Original source path selected by the user. */
  path: Schema.String,
  /** Base file name shown in the UI. */
  fileName: Schema.String,
  /** User-declared unit interpretation in millimeters per DXF unit. */
  millimetersPerUnit: Schema.Number,
  /** Imported selectable pieces produced from this DXF document. */
  pieces: Schema.Array(ImportedPiece),
  /** Document-level import warnings, including skipped unsupported entities. */
  warnings: Schema.Array(ImportWarning)
}) {}
