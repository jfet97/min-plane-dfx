/** Imports DXF files, preserves source parameters, and classifies piece topology. */

import DxfParser from 'dxf-parser'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { orient2d } from 'robust-predicates'
import { entityToGeometry, unionBounds } from './DxfBbox.js'
import {
  DxfGeometrySummary,
  type DxfGeometryEntityType,
  type DxfEllipseSource,
  type DxfGeometrySegment,
  ImportedDxfDocument,
  ImportedPiece,
  ImportWarning
} from '@shared/domain/dxf.js'
import { SourceFileId } from '@shared/domain/ids.js'
import { Rect } from '@shared/domain/geometry.js'

const SUPPORTED_DXF_ENTITY_TYPES = [
  'LINE',
  'LWPOLYLINE',
  'POLYLINE',
  'CIRCLE',
  'ARC',
  'ELLIPSE'
] as const satisfies ReadonlyArray<DxfGeometryEntityType>

type SupportedDxfEntityType = (typeof SUPPORTED_DXF_ENTITY_TYPES)[number]

const SUPPORTED_ENTITIES: ReadonlySet<string> = new Set(SUPPORTED_DXF_ENTITY_TYPES)

/** Options that control unit conversion while preserving source coordinates. */
export interface DxfImportOptions {
  /** Millimeters per DXF unit. Defaults to 1 (assume DXF is already in mm). */
  readonly millimetersPerUnit?: number
}

/** Stable import failure carrying the source path and boundary-level error code. */
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
type RawBounds = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface IntegerContainer {
  readonly bounds: Rect
  readonly offsetX: number
  readonly offsetY: number
}

interface ConvertedEntity {
  readonly geometry: DxfGeometrySummary
  readonly bounds: RawBounds
}

interface Point2D {
  readonly x: number
  readonly y: number
}

interface OutlineClassification {
  readonly closed: boolean
  readonly warnings: ReadonlyArray<ImportWarning>
}

const INTEGER_MM_EPSILON = 1e-6

function isDxfDocument(value: unknown): value is { readonly entities?: ReadonlyArray<Entity> } {
  if (typeof value !== 'object' || value === null) return false
  const entities = (value as { readonly entities?: unknown }).entities
  return entities === undefined || Array.isArray(entities)
}

function isSupportedDxfEntityType(value: string): value is SupportedDxfEntityType {
  return SUPPORTED_ENTITIES.has(value)
}

/** Scales segment coordinates and all attached source curve parameters together. */
function scaleSegment(segment: Segment, factor: number): Segment {
  if (segment.kind === 'line') {
    return {
      kind: 'line',
      x1: segment.x1 * factor,
      y1: segment.y1 * factor,
      x2: segment.x2 * factor,
      y2: segment.y2 * factor,
      ...(segment.bulge === undefined ? {} : { bulge: segment.bulge }),
      ...(segment.sourceCurve === undefined
        ? {}
        : { sourceCurve: scaleEllipseSource(segment.sourceCurve, factor) })
    }
  }
  return {
    kind: 'arc',
    x1: segment.x1 * factor,
    y1: segment.y1 * factor,
    x2: segment.x2 * factor,
    y2: segment.y2 * factor,
    cx: segment.cx * factor,
    cy: segment.cy * factor,
    radius: segment.radius * factor,
    startAngle: segment.startAngle,
    endAngle: segment.endAngle
  }
}

/** Scales ellipse coordinates while leaving dimensionless ratios and angles intact. */
function scaleEllipseSource(source: DxfEllipseSource, factor: number): DxfEllipseSource {
  return {
    ...source,
    cx: source.cx * factor,
    cy: source.cy * factor,
    majorAxisX: source.majorAxisX * factor,
    majorAxisY: source.majorAxisY * factor
  }
}

function snapIntegerNoise(value: number): number {
  const rounded = Math.round(value)
  return Math.abs(value - rounded) <= INTEGER_MM_EPSILON ? rounded : value
}

function scaleBounds(bounds: RawBounds, factor: number): RawBounds {
  return {
    x: bounds.x * factor,
    y: bounds.y * factor,
    width: bounds.width * factor,
    height: bounds.height * factor
  }
}

function integerContainingBounds(bounds: RawBounds): IntegerContainer | null {
  const originX = Math.floor(snapIntegerNoise(bounds.x))
  const originY = Math.floor(snapIntegerNoise(bounds.y))
  const maxX = Math.ceil(snapIntegerNoise(bounds.x + bounds.width))
  const maxY = Math.ceil(snapIntegerNoise(bounds.y + bounds.height))
  const width = maxX - originX
  const height = maxY - originY
  if (width <= 0 || height <= 0) return null
  return {
    bounds: new Rect({
      x: 0,
      y: 0,
      width,
      height
    }),
    offsetX: -originX,
    offsetY: -originY
  }
}

/** Rebases preview and collision source coordinates into the integer container. */
function translateSegment(segment: Segment, dx: number, dy: number): Segment {
  if (segment.kind === 'line') {
    return {
      kind: 'line',
      x1: segment.x1 + dx,
      y1: segment.y1 + dy,
      x2: segment.x2 + dx,
      y2: segment.y2 + dy,
      ...(segment.bulge === undefined ? {} : { bulge: segment.bulge }),
      ...(segment.sourceCurve === undefined
        ? {}
        : { sourceCurve: translateEllipseSource(segment.sourceCurve, dx, dy) })
    }
  }
  return {
    kind: 'arc',
    x1: segment.x1 + dx,
    y1: segment.y1 + dy,
    x2: segment.x2 + dx,
    y2: segment.y2 + dy,
    cx: segment.cx + dx,
    cy: segment.cy + dy,
    radius: segment.radius,
    startAngle: segment.startAngle,
    endAngle: segment.endAngle
  }
}

/** Translates ellipse centers while keeping their local axis vectors unchanged. */
function translateEllipseSource(
  source: DxfEllipseSource,
  dx: number,
  dy: number
): DxfEllipseSource {
  return {
    ...source,
    cx: source.cx + dx,
    cy: source.cy + dy
  }
}

function commonLayer(layers: ReadonlyArray<string | undefined>): string | undefined {
  const defined = layers.filter((layer): layer is string => layer !== undefined && layer.length > 0)
  if (defined.length === 0) return undefined
  const first = defined[0]
  return defined.every((layer) => layer === first) ? first : 'multiple'
}

const TOPOLOGY_EPSILON_MM = 1e-7

/** Returns a segment endpoint in the shared 2D coordinate system. */
function segmentStart(segment: DxfGeometrySegment): Point2D {
  return { x: segment.x1, y: segment.y1 }
}

/** Returns the endpoint used to connect this segment to the next one. */
function segmentEnd(segment: DxfGeometrySegment): Point2D {
  return { x: segment.x2, y: segment.y2 }
}

/** Compares imported endpoints without snapping or changing source coordinates. */
function samePoint(leftPoint: Point2D, rightPoint: Point2D): boolean {
  return (
    Math.abs(leftPoint.x - rightPoint.x) <= TOPOLOGY_EPSILON_MM &&
    Math.abs(leftPoint.y - rightPoint.y) <= TOPOLOGY_EPSILON_MM
  )
}

interface StraightSourceSegment {
  readonly start: Point2D
  readonly end: Point2D
  readonly entityIndex: number
  readonly segmentIndex: number
  readonly segmentCount: number
  readonly entityClosed: boolean
}

/**
 * Rejects crossings and non-adjacent touches between exact straight source
 * edges before a convex hull could hide an ambiguous material boundary.
 *
 * Curved source edges are intentionally not approximated here: their collision
 * sampling happens later with the configured sag setting, while this importer
 * check only rejects topology that is already unambiguously invalid in the
 * stored straight DXF segments.
 */
function hasSelfIntersectionBetweenStraightSegments(
  entities: ReadonlyArray<ConvertedEntity>
): boolean {
  const segments: StraightSourceSegment[] = []
  for (const [entityIndex, entity] of entities.entries()) {
    for (const [segmentIndex, segment] of entity.geometry.segments.entries()) {
      if (segment.kind !== 'line' || segment.bulge !== undefined || segment.sourceCurve !== undefined) {
        continue
      }
      segments.push({
        start: segmentStart(segment),
        end: segmentEnd(segment),
        entityIndex,
        segmentIndex,
        segmentCount: entity.geometry.segments.length,
        entityClosed: entity.geometry.closed
      })
    }
  }

  for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
    const first = segments[firstIndex]
    if (first === undefined) return true
    for (let secondIndex = firstIndex + 1; secondIndex < segments.length; secondIndex += 1) {
      const second = segments[secondIndex]
      if (second === undefined) return true
      if (areAdjacentStraightSegments(first, second)) continue
      if (straightSegmentsIntersect(first, second)) return true
    }
  }

  return false
}

/** Identifies the shared endpoints that are required by one source outline. */
function areAdjacentStraightSegments(
  first: StraightSourceSegment,
  second: StraightSourceSegment
): boolean {
  if (first.entityIndex !== second.entityIndex) {
    return segmentsShareEndpoint(first, second)
  }

  const indexDifference = Math.abs(first.segmentIndex - second.segmentIndex)
  return (
    indexDifference === 1 ||
    (first.entityClosed && indexDifference === first.segmentCount - 1)
  )
}

/** Returns whether two source edges share one declared endpoint. */
function segmentsShareEndpoint(first: StraightSourceSegment, second: StraightSourceSegment): boolean {
  return (
    samePoint(first.start, second.start) ||
    samePoint(first.start, second.end) ||
    samePoint(first.end, second.start) ||
    samePoint(first.end, second.end)
  )
}

/** Tests two finite straight source edges with robust orientation predicates. */
function straightSegmentsIntersect(first: StraightSourceSegment, second: StraightSourceSegment): boolean {
  const firstStartTurn = orient2d(
    first.start.x,
    first.start.y,
    first.end.x,
    first.end.y,
    second.start.x,
    second.start.y
  )
  const firstEndTurn = orient2d(
    first.start.x,
    first.start.y,
    first.end.x,
    first.end.y,
    second.end.x,
    second.end.y
  )
  const secondStartTurn = orient2d(
    second.start.x,
    second.start.y,
    second.end.x,
    second.end.y,
    first.start.x,
    first.start.y
  )
  const secondEndTurn = orient2d(
    second.start.x,
    second.start.y,
    second.end.x,
    second.end.y,
    first.end.x,
    first.end.y
  )

  if (firstStartTurn === 0 && pointIsOnStraightSegment(second.start, first)) return true
  if (firstEndTurn === 0 && pointIsOnStraightSegment(second.end, first)) return true
  if (secondStartTurn === 0 && pointIsOnStraightSegment(first.start, second)) return true
  if (secondEndTurn === 0 && pointIsOnStraightSegment(first.end, second)) return true

  return (firstStartTurn > 0) !== (firstEndTurn > 0) && (secondStartTurn > 0) !== (secondEndTurn > 0)
}

/** Checks whether a collinear source point lies on a finite source edge. */
function pointIsOnStraightSegment(point: Point2D, segment: StraightSourceSegment): boolean {
  return (
    point.x >= Math.min(segment.start.x, segment.end.x) &&
    point.x <= Math.max(segment.start.x, segment.end.x) &&
    point.y >= Math.min(segment.start.y, segment.end.y) &&
    point.y <= Math.max(segment.start.y, segment.end.y)
  )
}

/** Validates one entity path and returns its two graph endpoints. */
function entityEndpoints(
  geometry: DxfGeometrySummary
): { readonly start: Point2D; readonly end: Point2D } | null {
  const first = geometry.segments[0]
  if (first === undefined) return null

  let previousEnd = segmentEnd(first)
  for (const segment of geometry.segments.slice(1)) {
    const start = segmentStart(segment)
    if (!samePoint(previousEnd, start)) return null
    previousEnd = segmentEnd(segment)
  }

  const start = segmentStart(first)
  if (geometry.closed && !samePoint(start, previousEnd)) return null
  return { start, end: previousEnd }
}

/** Creates a piece-level warning for an outline condition that disables nesting. */
function outlineWarning(code: string, message: string): ImportWarning {
  return new ImportWarning({ code, message })
}

/**
 * Classifies the grouped entities as one nestable outline or an honest failure.
 *
 * A single entity must declare closure, while multiple open entities may form a
 * closed outline only when their endpoint graph is one connected degree-two
 * cycle. Unsupported entities force the piece invalid even when supported
 * geometry happens to form a cycle, because the missing source cannot be
 * represented safely by collision geometry.
 */
function classifyOutline(
  entities: ReadonlyArray<ConvertedEntity>,
  hasSkippedGeometry: boolean
): OutlineClassification {
  const warnings: ImportWarning[] = []
  if (hasSkippedGeometry) {
    warnings.push(
      outlineWarning(
        'partially_unsupported_outline',
        'The DXF piece contains unsupported or unusable entities; collision geometry is disabled.'
      )
    )
  }

  const endpoints = entities.map((entity) => entityEndpoints(entity.geometry))
  const hasInvalidPath = endpoints.some((endpoint) => endpoint === null)
  if (hasInvalidPath) {
    warnings.push(
      outlineWarning(
        'ambiguous_outline',
        'The DXF piece contains an entity whose segments are disconnected or cannot be ordered into one path.'
      )
    )
    return { closed: false, warnings }
  }

  if (hasSelfIntersectionBetweenStraightSegments(entities)) {
    warnings.push(
      outlineWarning(
        'self_intersecting_outline',
        'The DXF piece contains intersecting straight source edges, so its material boundary is ambiguous.'
      )
    )
    return { closed: false, warnings }
  }

  const resolvedEndpoints = endpoints.filter(
    (endpoint): endpoint is { readonly start: Point2D; readonly end: Point2D } => endpoint !== null
  )
  if (entities.length === 1) {
    const entity = entities[0]
    if (entity?.geometry.closed && resolvedEndpoints.length === 1) {
      return { closed: warnings.length === 0, warnings }
    }
    warnings.push(
      outlineWarning(
        'open_outline',
        'The DXF piece does not declare a closed outline; collision geometry is disabled.'
      )
    )
    return { closed: false, warnings }
  }

  const closedEntityCount = entities.filter((entity) => entity.geometry.closed).length
  if (closedEntityCount > 0) {
    warnings.push(
      outlineWarning(
        closedEntityCount === entities.length ? 'disconnected_outline' : 'ambiguous_outline',
        closedEntityCount === entities.length
          ? 'The DXF piece groups multiple closed outlines; choose one outline per piece before nesting.'
          : 'The DXF piece mixes closed entities with open entities, so its material boundary is ambiguous.'
      )
    )
    return { closed: false, warnings }
  }

  const parent = entities.map((_, index) => index)
  const nodes: Array<{ readonly point: Point2D; readonly edges: number[] }> = []

  /** Finds a graph component representative with path compression. */
  const find = (index: number): number => {
    const parentIndex = parent[index]
    if (parentIndex === undefined || parentIndex === index) return index
    const root = find(parentIndex)
    parent[index] = root
    return root
  }

  /** Joins two entity edges that share an endpoint node. */
  const union = (left: number, right: number): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }

  /** Reuses an endpoint node without snapping the stored source coordinate. */
  const nodeFor = (point: Point2D): number => {
    const existing = nodes.findIndex((node) => samePoint(node.point, point))
    if (existing >= 0) return existing
    nodes.push({ point, edges: [] })
    return nodes.length - 1
  }

  for (const [edgeIndex, endpoint] of resolvedEndpoints.entries()) {
    if (samePoint(endpoint.start, endpoint.end)) {
      warnings.push(
        outlineWarning(
          'ambiguous_outline',
          'The DXF piece contains an open entity with identical endpoints, so its topology is ambiguous.'
        )
      )
      return { closed: false, warnings }
    }
    const startNode = nodeFor(endpoint.start)
    const endNode = nodeFor(endpoint.end)
    const start = nodes[startNode]
    const end = nodes[endNode]
    if (!start || !end) return { closed: false, warnings }
    start.edges.push(edgeIndex)
    end.edges.push(edgeIndex)
    for (const otherEdge of start.edges) union(edgeIndex, otherEdge)
    for (const otherEdge of end.edges) union(edgeIndex, otherEdge)
  }

  const componentCount = new Set(resolvedEndpoints.map((_, index) => find(index))).size
  if (componentCount > 1) {
    warnings.push(
      outlineWarning(
        'disconnected_outline',
        'The DXF piece contains multiple disconnected paths; collision geometry is disabled.'
      )
    )
    return { closed: false, warnings }
  }

  if (nodes.some((node) => node.edges.length > 2)) {
    warnings.push(
      outlineWarning(
        'ambiguous_outline',
        'The DXF piece has a branched endpoint graph, so one material boundary cannot be determined.'
      )
    )
    return { closed: false, warnings }
  }

  if (nodes.some((node) => node.edges.length !== 2)) {
    warnings.push(
      outlineWarning(
        'open_outline',
        'The DXF piece is connected but its endpoint graph remains open; collision geometry is disabled.'
      )
    )
    return { closed: false, warnings }
  }

  return { closed: warnings.length === 0, warnings }
}

/**
 * Reads a DXF file from disk, parses it, and converts supported entities
 * into one selectable imported shape per file. Unsupported entities remain
 * document and piece warnings, and any affected piece is marked non-nestable.
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

  const sourceFileId = SourceFileId.make()
  const warnings: ImportWarning[] = []
  const millimetersPerUnit = options.millimetersPerUnit ?? 1
  const convertedSegments: Segment[] = []
  const convertedBounds: RawBounds[] = []
  const convertedEntities: ConvertedEntity[] = []
  const convertedEntityTypes = new Set<SupportedDxfEntityType>()
  const convertedLayers: Array<string | undefined> = []
  let hasSkippedGeometry = false

  const entities = parsed.entities ?? []
  for (const [entityIndex, entity] of entities.entries()) {
    const entityType = String(entity.type)
    if (!isSupportedDxfEntityType(entityType)) {
      hasSkippedGeometry = true
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

    const converted = entityToGeometry(entity, entityIndex)
    if (!converted) {
      hasSkippedGeometry = true
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
    convertedLayers.push(entity.layer)
    const scaledSegments = converted.geometry.segments.map((segment) =>
      scaleSegment(segment, millimetersPerUnit)
    )
    const scaledGeometry: DxfGeometrySummary = {
      entityType: converted.geometry.entityType,
      closed: converted.geometry.closed,
      segments: scaledSegments
    }
    const scaledBounds = scaleBounds(converted.bounds, millimetersPerUnit)
    convertedEntities.push({ geometry: scaledGeometry, bounds: scaledBounds })
    convertedSegments.push(...scaledSegments)
    convertedBounds.push(scaledBounds)
  }

  const rawOverallBounds = unionBounds(convertedBounds)
  const integerContainer = rawOverallBounds ? integerContainingBounds(rawOverallBounds) : null
  const overallBounds = integerContainer?.bounds ?? null
  const emptyImportMessage =
    rawOverallBounds === null
      ? 'No supported entities were found in this DXF file.'
      : 'No supported entities with a positive-area integer millimeter footprint were found in this DXF file.'
  const geometrySegments = integerContainer
    ? convertedSegments.map((segment) =>
        translateSegment(segment, integerContainer.offsetX, integerContainer.offsetY)
      )
    : []
  const outline = classifyOutline(convertedEntities, hasSkippedGeometry)
  const pieces: ImportedPiece[] = overallBounds
    ? [
        new ImportedPiece({
          sourceFileId,
          sourceLayer: commonLayer(convertedLayers),
          label: basename(path, extname(path)),
          realBounds: overallBounds,
          geometry: new DxfGeometrySummary({
            entityType:
              convertedEntities.length === 1
                ? ([...convertedEntityTypes][0] ?? 'DXF_SHAPE')
                : 'DXF_SHAPE',
            closed: outline.closed,
            segments: geometrySegments
          }),
          warnings: [...outline.warnings, ...warnings]
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
              message: emptyImportMessage
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
