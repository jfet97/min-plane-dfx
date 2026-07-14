/** Converts parser entities into honest preview segments and analytic bounds. */

import type { IEntity, IPoint } from 'dxf-parser/dist/entities/geomtry.js'
import type { ILineEntity } from 'dxf-parser/dist/entities/line.js'
import type { ILwpolylineEntity } from 'dxf-parser/dist/entities/lwpolyline.js'
import type { IArcEntity } from 'dxf-parser/dist/entities/arc.js'
import type { ICircleEntity } from 'dxf-parser/dist/entities/circle.js'
import type { IPolylineEntity } from 'dxf-parser/dist/entities/polyline.js'
import type { IEllipseEntity } from 'dxf-parser/dist/entities/ellipse.js'
import type { IVertexEntity } from 'dxf-parser/dist/entities/vertex.js'
import type { DxfEllipseSource, DxfGeometrySummary, DxfLineSegment } from '@shared/domain/dxf.js'

type Segment = DxfGeometrySummary['segments'][number]
type PolylineVertex = IPoint & { readonly bulge?: number }
type Point2D = Pick<IPoint, 'x' | 'y'>

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
  if (!a || !b || !isFinitePoint(a) || !isFinitePoint(b)) return []
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

/** Builds preview chords while retaining each source vertex's outgoing bulge. */
function lwPolylineSegments(verts: ReadonlyArray<PolylineVertex>, closed: boolean): Segment[] {
  if (verts.length === 0 || verts.some((vertex) => !isFinitePolylineVertex(vertex))) return []
  const segs: Segment[] = []
  for (let i = 0; i < verts.length - 1; i++) {
    const fromVertex = verts[i]
    const toVertex = verts[i + 1]
    if (!fromVertex || !toVertex) continue
    segs.push(polylineSegment(fromVertex, toVertex))
  }
  if (!closed) return segs
  const last = verts[verts.length - 1]
  const first = verts[0]
  if (!last || !first) return segs
  if (first.x !== last.x || first.y !== last.y) {
    segs.push(polylineSegment(last, first))
  }
  return segs
}

/** Returns whether a parser vertex can participate in finite 2D geometry. */
function isFinitePolylineVertex(vertex: PolylineVertex): boolean {
  return (
    Number.isFinite(vertex.x) &&
    Number.isFinite(vertex.y) &&
    (vertex.bulge === undefined || Number.isFinite(vertex.bulge))
  )
}

/** Keeps the raw bulge on the chord so the worker can resample it later. */
function polylineSegment(fromVertex: PolylineVertex, toVertex: IPoint): DxfLineSegment {
  const bulge = fromVertex.bulge
  return {
    kind: 'line',
    x1: fromVertex.x,
    y1: fromVertex.y,
    x2: toVertex.x,
    y2: toVertex.y,
    ...(bulge !== undefined && bulge !== 0 ? { bulge } : {})
  }
}

interface BulgeArcParameters {
  readonly centerX: number
  readonly centerY: number
  readonly radius: number
  readonly startAngle: number
  readonly sweep: number
}

/**
 * Converts a DXF bulge chord into analytic arc parameters for exact bounds.
 *
 * A bulge is the tangent of one quarter of the signed included angle. Keeping
 * the signed sweep here preserves clockwise negative bulges without changing
 * the renderer-facing line segment representation.
 */
function bulgeArcParameters(segment: DxfLineSegment): BulgeArcParameters | null {
  const bulge = segment.bulge
  if (bulge === undefined || !Number.isFinite(bulge) || bulge === 0) return null

  const dx = segment.x2 - segment.x1
  const dy = segment.y2 - segment.y1
  const chord = Math.hypot(dx, dy)
  if (!Number.isFinite(chord) || chord <= 0) return null

  const sweep = 4 * Math.atan(bulge)
  const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge))
  if (!Number.isFinite(sweep) || !Number.isFinite(radius) || radius <= 0) return null

  const midpointX = (segment.x1 + segment.x2) / 2
  const midpointY = (segment.y1 + segment.y2) / 2
  const centerOffset = (chord * (1 - bulge * bulge)) / (4 * bulge)
  const normalX = -dy / chord
  const normalY = dx / chord
  const centerX = midpointX + normalX * centerOffset
  const centerY = midpointY + normalY * centerOffset
  const startAngle = Math.atan2(segment.y1 - centerY, segment.x1 - centerX)

  return { centerX, centerY, radius, startAngle, sweep }
}

/** Returns endpoints and cardinal arc points needed for a bulge-aware bounds. */
function bulgeBoundsPoints(
  segment: DxfLineSegment
): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  const endpoints = [
    { x: segment.x1, y: segment.y1 },
    { x: segment.x2, y: segment.y2 }
  ]
  const arc = bulgeArcParameters(segment)
  if (arc === null) return endpoints

  const points = [...endpoints]
  for (const cardinal of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
    if (!angleOnSignedSweep(cardinal, arc.startAngle, arc.sweep)) continue
    points.push({
      x: arc.centerX + arc.radius * Math.cos(cardinal),
      y: arc.centerY + arc.radius * Math.sin(cardinal)
    })
  }
  return points
}

/** Tests whether an angle lies on a signed, non-zero arc sweep. */
function angleOnSignedSweep(angle: number, start: number, sweep: number): boolean {
  const fullTurn = FULL_CIRCLE_RADIANS
  if (sweep > 0) {
    const delta = (((angle - start) % fullTurn) + fullTurn) % fullTurn
    return delta <= sweep + 1e-12
  }
  const delta = (((start - angle) % fullTurn) + fullTurn) % fullTurn
  return delta <= -sweep + 1e-12
}

function circleSegments(circle: ICircleEntity): Segment[] {
  const c = circle.center
  const r = circle.radius
  return [0, 90, 180, 270].map((startAngle) => {
    const endAngle = startAngle + 90
    const start = arcPoint(c.x, c.y, r, degreesToRadians(startAngle))
    const end = arcPoint(c.x, c.y, r, degreesToRadians(endAngle))
    return {
      kind: 'arc',
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      cx: c.x,
      cy: c.y,
      radius: r,
      startAngle,
      endAngle
    }
  })
}

function arcSegments(arc: IArcEntity): Segment[] {
  const a = arc.center
  const endAngle = arcEndForSvg(arc.startAngle, arc.endAngle)
  const start = arcPoint(a.x, a.y, arc.radius, arc.startAngle)
  const end = arcPoint(a.x, a.y, arc.radius, endAngle)
  return [
    {
      kind: 'arc',
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      cx: a.x,
      cy: a.y,
      radius: arc.radius,
      startAngle: radiansToDegrees(arc.startAngle),
      endAngle: radiansToDegrees(endAngle)
    }
  ]
}

/** Computes the exact axis-aligned bounds of the represented ellipse arc. */
function ellipseBounds(ellipse: IEllipseEntity): RawBounds | null {
  const center = ellipse.center
  const major = ellipse.majorAxisEndPoint
  const start = ellipse.startAngle
  const end = ellipseEndParameter(ellipse.startAngle, ellipse.endAngle)
  const sweep = end - start
  if (
    !isFinitePoint(center) ||
    !isFinitePoint(major) ||
    !Number.isFinite(ellipse.axisRatio) ||
    ellipse.axisRatio <= 0 ||
    Math.hypot(major.x, major.y) <= 0 ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    sweep <= 0
  ) {
    return null
  }

  const minor = {
    x: -major.y * ellipse.axisRatio,
    y: major.x * ellipse.axisRatio
  }
  const parameters = [start, end]
  const xExtrema = Math.atan2(minor.x, major.x)
  const yExtrema = Math.atan2(minor.y, major.y)
  for (const candidate of [xExtrema, xExtrema + Math.PI, yExtrema, yExtrema + Math.PI]) {
    if (angleOnSignedSweep(candidate, start, sweep)) parameters.push(candidate)
  }

  const points = parameters.map((parameter) => ellipsePoint(center, major, minor, parameter))
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Keeps the analytic ellipse parameters beside its line-only preview. */
function ellipseSource(ellipse: IEllipseEntity, sourceId: string): DxfEllipseSource {
  return {
    kind: 'ellipse',
    sourceId,
    cx: ellipse.center.x,
    cy: ellipse.center.y,
    majorAxisX: ellipse.majorAxisEndPoint.x,
    majorAxisY: ellipse.majorAxisEndPoint.y,
    axisRatio: ellipse.axisRatio,
    startAngle: ellipse.startAngle,
    endAngle: ellipse.endAngle
  }
}

/** Builds a fixed-resolution preview while attaching the analytic ellipse source. */
function ellipseSegments(ellipse: IEllipseEntity, sourceId: string): Segment[] {
  const points = ellipsePoints(ellipse)
  const segs: Segment[] = []
  const sourceCurve = ellipseSource(ellipse, sourceId)
  for (let i = 0; i < points.length - 1; i++) {
    const startPoint = points[i]
    const endPoint = points[i + 1]
    if (!startPoint || !endPoint) continue
    segs.push({
      kind: 'line',
      x1: startPoint.x,
      y1: startPoint.y,
      x2: endPoint.x,
      y2: endPoint.y,
      sourceCurve
    })
  }
  return segs
}

/** Evaluates a DXF ellipse at its parameter angle in radians. */
function ellipsePoint(
  center: Point2D,
  major: Point2D,
  minor: Point2D,
  parameter: number
): { readonly x: number; readonly y: number } {
  return {
    x: center.x + major.x * Math.cos(parameter) + minor.x * Math.sin(parameter),
    y: center.y + major.y * Math.cos(parameter) + minor.y * Math.sin(parameter)
  }
}

/** Samples an ellipse only for preview rendering; collision sampling uses its source parameters. */
function ellipsePoints(
  ellipse: IEllipseEntity
): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  const center = ellipse.center
  const major = ellipse.majorAxisEndPoint
  if (
    !isFinitePoint(center) ||
    !isFinitePoint(major) ||
    !Number.isFinite(ellipse.axisRatio) ||
    ellipse.axisRatio <= 0 ||
    Math.hypot(major.x, major.y) <= 0 ||
    !Number.isFinite(ellipse.startAngle) ||
    !Number.isFinite(ellipse.endAngle)
  ) {
    return []
  }
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
    return ellipsePoint(center, major, minor, t)
  })
}

/** Returns whether a parser point has finite coordinates. */
function isFinitePoint(point: IPoint | undefined): point is IPoint {
  return point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y)
}

/** Reads ordered POLYLINE vertices retained by the parser's entity grouping. */
function polylineVertices(poly: IPolylineEntity): ReadonlyArray<PolylineVertex> {
  // dxf POLYLINE keeps its vertices in the ENTITYs list as VERTEX entries that
  // appear immediately after the POLYLINE header. the parser keeps the order
  // in `poly.vertices`
  return poly.vertices.map((v: IVertexEntity) => v)
}

/** Computes bounds from analytic arcs and bulges instead of preview chords. */
function segmentBounds(segs: ReadonlyArray<Segment>): RawBounds | null {
  if (segs.length === 0) return null
  const bounds = segs.reduce(
    (acc, segment) => {
      const points = segment.kind === 'arc' ? arcBoundsPoints(segment) : bulgeBoundsPoints(segment)
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
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return null
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY
  }
}

function arcBoundsPoints(
  segment: Segment
): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  if (segment.kind === 'line') {
    return [
      { x: segment.x1, y: segment.y1 },
      { x: segment.x2, y: segment.y2 }
    ]
  }
  const start = degreesToRadians(segment.startAngle)
  const end = arcEndForSvg(start, degreesToRadians(segment.endAngle))
  const angles = [start, end]
  for (const cardinal of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2, FULL_CIRCLE_RADIANS]) {
    const candidate = cardinal < start ? cardinal + FULL_CIRCLE_RADIANS : cardinal
    if (candidate >= start && candidate <= end) {
      angles.push(candidate)
    }
  }
  return angles.map((angle) => ({
    x: segment.cx + segment.radius * Math.cos(angle),
    y: segment.cy + segment.radius * Math.sin(angle)
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

/** Normalizes wrapped ellipse parameters into a positive DXF sweep. */
function ellipseEndParameter(start: number, end: number): number {
  return end <= start ? end + FULL_CIRCLE_RADIANS : end
}

/** Identifies full ellipses so partial ellipse arcs remain open outlines. */
function ellipseIsClosed(ellipse: IEllipseEntity): boolean {
  const end = ellipseEndParameter(ellipse.startAngle, ellipse.endAngle)
  return Math.abs(end - ellipse.startAngle - FULL_CIRCLE_RADIANS) <= 1e-9
}

/** Creates a stable source key, using the import ordinal when no DXF handle exists. */
function sourceIdForEntity(entity: IEntity, fallbackOrdinal?: number): string {
  return `${entity.type}:${String(entity.handle ?? fallbackOrdinal ?? 'unknown')}`
}

function arcPoint(
  cx: number,
  cy: number,
  radius: number,
  angleRadians: number
): { readonly x: number; readonly y: number } {
  return {
    x: cx + radius * Math.cos(angleRadians),
    y: cy + radius * Math.sin(angleRadians)
  }
}

/**
 * Converts one parser entity into a compact geometry summary and exact bounds.
 * Returns null when the entity is unsupported, malformed, or not finite 2D data.
 * The optional ordinal keeps repeated handle-less source curves distinct.
 */
export function entityToGeometry(
  entity: IEntity,
  fallbackOrdinal?: number
): {
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
      if (
        poly.is3dPolyline === true ||
        poly.isPolyfaceMesh === true ||
        poly.is3dPolygonMesh === true
      ) {
        return null
      }
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
      if (!Number.isFinite(r) || r <= 0 || !isFinitePoint(circle.center)) return null
      const c = circle.center
      return {
        geometry: { entityType: 'CIRCLE', closed: true, segments: circleSegments(circle) },
        bounds: { x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r }
      }
    }

    case 'ARC': {
      const arc = entity as IArcEntity
      const r = arc.radius
      if (
        !Number.isFinite(r) ||
        r <= 0 ||
        !isFinitePoint(arc.center) ||
        !Number.isFinite(arc.startAngle) ||
        !Number.isFinite(arc.endAngle)
      ) {
        return null
      }
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
      const bounds = ellipseBounds(ellipse)
      if (!bounds) return null
      const segs = ellipseSegments(ellipse, sourceIdForEntity(entity, fallbackOrdinal))
      if (segs.length === 0) return null
      return {
        geometry: {
          entityType: 'ELLIPSE',
          closed: ellipseIsClosed(ellipse),
          segments: segs
        },
        bounds
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
