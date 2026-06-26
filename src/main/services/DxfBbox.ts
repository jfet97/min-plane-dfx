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

function lwPolylineSegments(verts: ReadonlyArray<IPoint>): Segment[] {
  if (verts.length === 0) return []
  const segs: Segment[] = []
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i]!
    const b = verts[i + 1]!
    segs.push({ kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }
  // Close the loop for closed polylines (last -> first).
  const last = verts[verts.length - 1]!
  const first = verts[0]!
  if (first.x !== last.x || first.y !== last.y) {
    segs.push({ kind: 'line', x1: last.x, y1: last.y, x2: first.x, y2: first.y })
  }
  return segs
}

function circleSegments(circle: ICircleEntity): Segment[] {
  // Conservative approximation as two cardinal line segments forming the bbox.
  // The actual circle is later redrawn from center+radius; this is enough for
  // visual fidelity in the preview without computing exact arc samples here.
  const c = circle.center
  const r = circle.radius
  return [
    { kind: 'line', x1: c.x - r, y1: c.y, x2: c.x + r, y2: c.y },
    { kind: 'line', x1: c.x + r, y1: c.y, x2: c.x - r, y2: c.y }
  ]
}

function arcSegments(arc: IArcEntity): Segment[] {
  // Two-sample arc: store as a single segment with the actual arc parameters
  // so the renderer can draw the full arc later without re-parsing.
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
      startAngle: arc.startAngle,
      endAngle: arc.endAngle
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
  // Rotate bounding box by the ellipse angle in world space.
  const angle = Math.atan2(a.y, a.x)
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const rx = major * cos + minor * sin
  const ry = major * sin + minor * cos
  return { cx: c.x, cy: c.y, rx, ry }
}

function polylineVertices(poly: IPolylineEntity): ReadonlyArray<IPoint> {
  // DXF POLYLINE keeps its vertices in the ENTITYs list as VERTEX entries that
  // appear immediately after the POLYLINE header. The parser keeps the order
  // in `poly.vertices`.
  return poly.vertices.map((v: IVertexEntity) => v)
}

/**
 * Convert a single DXF entity into a compact DxfGeometrySummary + an optional
 * warning. Returns null when the entity is not one we can represent yet.
 */
export function entityToGeometry(entity: IEntity): {
  readonly geometry: DxfGeometrySummary
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
} | null {
  switch (entity.type) {
    case 'LINE': {
      const line = entity as ILineEntity
      const segs = lineSegments(line)
      if (segs.length === 0) return null
      const bounds = segs.reduce(
        (acc, s) => ({
          minX: Math.min(acc.minX, s.x1, s.x2),
          minY: Math.min(acc.minY, s.y1, s.y2),
          maxX: Math.max(acc.maxX, s.x1, s.x2),
          maxY: Math.max(acc.maxY, s.y1, s.y2)
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      )
      return {
        geometry: { entityType: 'LINE', closed: false, segments: segs },
        bounds: {
          x: bounds.minX,
          y: bounds.minY,
          width: bounds.maxX - bounds.minX,
          height: bounds.maxY - bounds.minY
        }
      }
    }

    case 'LWPOLYLINE': {
      const lw = entity as ILwpolylineEntity
      const verts = lw.vertices
      if (verts.length < 2) return null
      const segs = lwPolylineSegments(verts)
      const minX = verts.reduce((acc, v) => Math.min(acc, v.x), Infinity)
      const minY = verts.reduce((acc, v) => Math.min(acc, v.y), Infinity)
      const maxX = verts.reduce((acc, v) => Math.max(acc, v.x), -Infinity)
      const maxY = verts.reduce((acc, v) => Math.max(acc, v.y), -Infinity)
      return {
        geometry: { entityType: 'LWPOLYLINE', closed: lw.shape === true, segments: segs },
        bounds: {
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY
        }
      }
    }

    case 'POLYLINE': {
      const poly = entity as IPolylineEntity
      const verts = polylineVertices(poly)
      if (verts.length < 2) return null
      const segs = lwPolylineSegments(verts)
      const minX = verts.reduce((acc, v) => Math.min(acc, v.x), Infinity)
      const minY = verts.reduce((acc, v) => Math.min(acc, v.y), Infinity)
      const maxX = verts.reduce((acc, v) => Math.max(acc, v.x), -Infinity)
      const maxY = verts.reduce((acc, v) => Math.max(acc, v.y), -Infinity)
      return {
        geometry: { entityType: 'POLYLINE', closed: poly.shape === true, segments: segs },
        bounds: {
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY
        }
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
      // Conservative bounding box for a circular arc: same as the parent circle.
      const c = arc.center
      return {
        geometry: { entityType: 'ARC', closed: false, segments: arcSegments(arc) },
        bounds: { x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r }
      }
    }

    case 'ELLIPSE': {
      const ellipse = entity as IEllipseEntity
      const { cx, cy, rx, ry } = ellipseBounds(ellipse)
      return {
        geometry: {
          entityType: 'ELLIPSE',
          closed: true,
          // Line-segment approximation along the rotated bbox edges. Sufficient
          // for import preview; the renderer also redraws the full ellipse.
          segments: [
            { kind: 'line', x1: cx - rx, y1: cy, x2: cx + rx, y2: cy },
            { kind: 'line', x1: cx + rx, y1: cy, x2: cx - rx, y2: cy }
          ]
        },
        bounds: { x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry }
      }
    }

    default:
      return null
  }
}

/** Returns the union bounds across all provided rectangles. */
export function unionBounds(
  rectangles: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }>
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null {
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