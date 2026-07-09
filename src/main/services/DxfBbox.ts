import type { IEntity, IPoint } from 'dxf-parser/dist/entities/geomtry.js'
import type { ILineEntity } from 'dxf-parser/dist/entities/line.js'
import type { ILwpolylineEntity } from 'dxf-parser/dist/entities/lwpolyline.js'
import type { IArcEntity } from 'dxf-parser/dist/entities/arc.js'
import type { ICircleEntity } from 'dxf-parser/dist/entities/circle.js'
import type { IPolylineEntity } from 'dxf-parser/dist/entities/polyline.js'
import type { IEllipseEntity } from 'dxf-parser/dist/entities/ellipse.js'
import type { IVertexEntity } from 'dxf-parser/dist/entities/vertex.js'
import type { DxfGeometrySummary } from '@shared/domain/dxf.js'

type Segment = DxfGeometrySummary['segments'][number]

interface RawBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const FULL_CIRCLE_RADIANS = Math.PI * 2
const ELLIPSE_SEGMENTS_PER_REVOLUTION = 96

/** Build the compact DxfGeometrySummary for a LINE entity. */
function lineSegments(line: ILineEntity): Segment[] {
  const a = line.vertices[0]
  const b = line.vertices[1]
  if (!a || !b) return []
  return [
    {
      kind: 'line',
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y
    }
  ]
}

function lwPolylineSegments(verts: ReadonlyArray<IPoint>, closed: boolean): Segment[] {
  if (verts.length === 0) return []
  const segs: Segment[] = []
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i]
    const b = verts[i + 1]
    if (!a || !b) continue
    segs.push({ kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }
  if (!closed) return segs
  const last = verts[verts.length - 1]
  const first = verts[0]
  if (!last || !first) return segs
  if (first.x !== last.x || first.y !== last.y) {
    segs.push({ kind: 'line', x1: last.x, y1: last.y, x2: first.x, y2: first.y })
  }
  return segs
}

function circleSegments(circle: ICircleEntity): Segment[] {
  const c = circle.center
  const r = circle.radius
  return [0, 90, 180, 270].map((startAngle) => ({
    kind: 'arc',
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    cx: c.x,
    cy: c.y,
    radius: r,
    startAngle,
    endAngle: startAngle + 90
  }))
}

function arcSegments(arc: IArcEntity): Segment[] {
  const a = arc.center
  return [
    {
      kind: 'arc',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      cx: a.x,
      cy: a.y,
      radius: arc.radius,
      startAngle: radiansToDegrees(arc.startAngle),
      endAngle: radiansToDegrees(arcEndForSvg(arc.startAngle, arc.endAngle))
    }
  ]
}

function ellipseBounds(ellipse: IEllipseEntity): {
  cx: number
  cy: number
  rx: number
  ry: number
} {
  const c = ellipse.center
  const a = ellipse.majorAxisEndPoint
  const major = Math.sqrt(a.x * a.x + a.y * a.y)
  const minor = major * ellipse.axisRatio
  // rotate bounding box by the ellipse angle in world space
  const angle = Math.atan2(a.y, a.x)
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const rx = major * cos + minor * sin
  const ry = major * sin + minor * cos
  return { cx: c.x, cy: c.y, rx, ry }
}

function ellipseSegments(ellipse: IEllipseEntity): Segment[] {
  const points = ellipsePoints(ellipse)
  const segs: Segment[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (!a || !b) continue
    segs.push({ kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }
  return segs
}

function ellipsePoints(ellipse: IEllipseEntity): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  const center = ellipse.center
  const major = ellipse.majorAxisEndPoint
  const minor = {
    x: -major.y * ellipse.axisRatio,
    y: major.x * ellipse.axisRatio
  }
  const start = ellipse.startAngle
  const end = ellipseEndParameter(ellipse.startAngle, ellipse.endAngle)
  const sweep = end - start
  const segmentCount = Math.max(
    16,
    Math.ceil((Math.abs(sweep) / FULL_CIRCLE_RADIANS) * ELLIPSE_SEGMENTS_PER_REVOLUTION)
  )

  return Array.from({ length: segmentCount + 1 }, (_, index) => {
    const t = start + (sweep * index) / segmentCount
    return {
      x: center.x + major.x * Math.cos(t) + minor.x * Math.sin(t),
      y: center.y + major.y * Math.cos(t) + minor.y * Math.sin(t)
    }
  })
}

function polylineVertices(poly: IPolylineEntity): ReadonlyArray<IPoint> {
  // dxf POLYLINE keeps its vertices in the ENTITYs list as VERTEX entries that
  // appear immediately after the POLYLINE header. the parser keeps the order
  // in `poly.vertices`
  return poly.vertices.map((v: IVertexEntity) => v)
}

function segmentBounds(segs: ReadonlyArray<Segment>): RawBounds | null {
  if (segs.length === 0) return null
  const bounds = segs.reduce(
    (acc, segment) => {
      const points =
        segment.kind === 'arc'
          ? arcBoundsPoints(segment)
          : [
              { x: segment.x1, y: segment.y1 },
              { x: segment.x2, y: segment.y2 }
            ]
      for (const point of points) {
        acc.minX = Math.min(acc.minX, point.x)
        acc.minY = Math.min(acc.minY, point.y)
        acc.maxX = Math.max(acc.maxX, point.x)
        acc.maxY = Math.max(acc.maxY, point.y)
      }
      return acc
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  )
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY
  }
}

function arcBoundsPoints(segment: Segment): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  const cx = segment.cx ?? 0
  const cy = segment.cy ?? 0
  const radius = segment.radius ?? 0
  const start = degreesToRadians(segment.startAngle ?? 0)
  const end = arcEndForSvg(start, degreesToRadians(segment.endAngle ?? 0))
  const angles = [start, end]
  for (const cardinal of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2, FULL_CIRCLE_RADIANS]) {
    const candidate = cardinal < start ? cardinal + FULL_CIRCLE_RADIANS : cardinal
    if (candidate >= start && candidate <= end) {
      angles.push(candidate)
    }
  }
  return angles.map((angle) => ({
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle)
  }))
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180
}

function arcEndForSvg(start: number, end: number): number {
  return end <= start ? end + FULL_CIRCLE_RADIANS : end
}

function ellipseEndParameter(start: number, end: number): number {
  return end <= start ? end + FULL_CIRCLE_RADIANS : end
}

/**
 * Convert a single DXF entity into a compact DxfGeometrySummary + an optional
 * warning. Returns null when the entity is not one we can represent yet.
 */
export function entityToGeometry(entity: IEntity): {
  readonly geometry: DxfGeometrySummary
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
} | null {
  switch (entity.type) {
    case 'LINE': {
      const line = entity as ILineEntity
      const segs = lineSegments(line)
      if (segs.length === 0) return null
      const bounds = segmentBounds(segs)
      if (!bounds) return null
      return {
        geometry: { entityType: 'LINE', closed: false, segments: segs },
        bounds
      }
    }

    case 'LWPOLYLINE': {
      const lw = entity as ILwpolylineEntity
      const verts = lw.vertices
      if (verts.length < 2) return null
      const segs = lwPolylineSegments(verts, lw.shape === true)
      const bounds = segmentBounds(segs)
      if (!bounds) return null
      return {
        geometry: { entityType: 'LWPOLYLINE', closed: lw.shape === true, segments: segs },
        bounds
      }
    }

    case 'POLYLINE': {
      const poly = entity as IPolylineEntity
      const verts = polylineVertices(poly)
      if (verts.length < 2) return null
      const segs = lwPolylineSegments(verts, poly.shape === true)
      const bounds = segmentBounds(segs)
      if (!bounds) return null
      return {
        geometry: { entityType: 'POLYLINE', closed: poly.shape === true, segments: segs },
        bounds
      }
    }

    case 'CIRCLE': {
      const circle = entity as ICircleEntity
      const r = circle.radius
      if (!Number.isFinite(r) || r <= 0) return null
      const c = circle.center
      return {
        geometry: { entityType: 'CIRCLE', closed: true, segments: circleSegments(circle) },
        bounds: { x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r }
      }
    }

    case 'ARC': {
      const arc = entity as IArcEntity
      const r = arc.radius
      if (!Number.isFinite(r) || r <= 0) return null
      const segs = arcSegments(arc)
      const bounds = segmentBounds(segs)
      if (!bounds) return null
      return {
        geometry: { entityType: 'ARC', closed: false, segments: segs },
        bounds
      }
    }

    case 'ELLIPSE': {
      const ellipse = entity as IEllipseEntity
      const segs = ellipseSegments(ellipse)
      const { cx, cy, rx, ry } = ellipseBounds(ellipse)
      const bounds = segmentBounds(segs)
      return {
        geometry: {
          entityType: 'ELLIPSE',
          closed: true,
          segments: segs
        },
        bounds: bounds ?? { x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry }
      }
    }

    default:
      return null
  }
}

/** Returns the union bounds across all provided rectangles. */
export function unionBounds(
  rectangles: ReadonlyArray<{
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }>
): {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
} | null {
  if (rectangles.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rectangles) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
