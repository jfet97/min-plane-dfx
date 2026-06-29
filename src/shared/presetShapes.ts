import { DxfGeometrySummary, ImportedDxfDocument, ImportedPiece } from '@shared/domain/dxf.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { Rect } from '@shared/domain/geometry.js'

export type PresetShapeKind =
  | 'square'
  | 'rectangle'
  | 'circle'
  | 'triangle'
  | 'pentagon'
  | 'hexagon'
  | 'star'

export interface PresetShapeInput {
  readonly kind: PresetShapeKind
  readonly width: number
  readonly height: number
  readonly label: string
}

type Segment = DxfGeometrySummary['segments'][number]

function positiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.round(value))
}

function line(x1: number, y1: number, x2: number, y2: number): Segment {
  return { kind: 'line', x1, y1, x2, y2 }
}

function closePolyline(points: ReadonlyArray<readonly [number, number]>): ReadonlyArray<Segment> {
  const segments: Segment[] = []
  for (let i = 0; i < points.length; i++) {
    const current = points[i]
    const next = points[(i + 1) % points.length]
    if (current === undefined || next === undefined) continue
    segments.push(line(current[0], current[1], next[0], next[1]))
  }
  return segments
}

function regularPolygon(sides: number, width: number, height: number): ReadonlyArray<Segment> {
  const cx = width / 2
  const cy = height / 2
  const rx = width / 2
  const ry = height / 2
  const points: Array<readonly [number, number]> = []
  for (let i = 0; i < sides; i++) {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / sides
    points.push([cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry])
  }
  return closePolyline(points)
}

function star(width: number, height: number): ReadonlyArray<Segment> {
  const cx = width / 2
  const cy = height / 2
  const outerX = width / 2
  const outerY = height / 2
  const innerX = outerX * 0.42
  const innerY = outerY * 0.42
  const points: Array<readonly [number, number]> = []
  for (let i = 0; i < 10; i++) {
    const radiusX = i % 2 === 0 ? outerX : innerX
    const radiusY = i % 2 === 0 ? outerY : innerY
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / 10
    points.push([cx + Math.cos(angle) * radiusX, cy + Math.sin(angle) * radiusY])
  }
  return closePolyline(points)
}

function segmentsFor(kind: PresetShapeKind, width: number, height: number): ReadonlyArray<Segment> {
  if (kind === 'circle') return []
  if (kind === 'triangle') {
    return closePolyline([
      [0, height],
      [width / 2, 0],
      [width, height]
    ])
  }
  if (kind === 'pentagon') return regularPolygon(5, width, height)
  if (kind === 'hexagon') return regularPolygon(6, width, height)
  if (kind === 'star') return star(width, height)
  return closePolyline([
    [0, 0],
    [width, 0],
    [width, height],
    [0, height]
  ])
}

export function makePresetShapeDocument(input: PresetShapeInput): ImportedDxfDocument {
  const width = positiveInteger(input.width, 100)
  const height =
    input.kind === 'square' || input.kind === 'circle'
      ? width
      : positiveInteger(input.height, width)
  const sourceFileId = SourceFileId.make()
  const pieceId = PieceId.make()
  const label = input.label.trim() || input.kind

  const piece = new ImportedPiece({
    id: pieceId,
    sourceFileId,
    sourceLayer: 'preset',
    label,
    realBounds: new Rect({ x: 0, y: 0, width, height }),
    geometry: new DxfGeometrySummary({
      entityType: input.kind === 'circle' ? 'CIRCLE' : 'PRESET_SHAPE',
      closed: true,
      segments: [...segmentsFor(input.kind, width, height)]
    }),
    warnings: []
  })

  return new ImportedDxfDocument({
    id: sourceFileId,
    path: `preset://${sourceFileId}`,
    fileName: `${label}.preset`,
    millimetersPerUnit: 1,
    pieces: [piece],
    warnings: []
  })
}
