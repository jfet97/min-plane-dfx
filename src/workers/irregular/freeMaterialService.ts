import {
  area,
  booleanOpWithPolyTree,
  ClipType,
  FillRule,
  type Path64,
  polyTreeToPaths64,
  stripDuplicates,
  type Paths64,
  type PolyPath64,
  PolyTree64
} from 'clipper2-ts'
import { Effect, Layer } from 'effect'
import {
  FreeMaterialRegion,
  FreeMaterialSnapshot,
  IrregularPoint,
  IrregularPolygon
} from '@shared/irregular/domain.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPlacedPiece } from '@shared/irregular/domain.js'
import {
  ComputeFreeMaterialInput,
  ExtendFreeMaterialInput,
  FreeMaterialService,
  IrregularGeometryInputError
} from './services.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'
import { CLIPPER2_OFFSET_POLICY, fromGrid, toGridMm } from './clipper2OffsetPolicy.js'

export type FreeMaterialOperation = 'union-then-difference' | 'direct-difference'

/** Effect layer providing topology-preserving sheet-space free material. */
export const FreeMaterialServiceLive = Layer.succeed(
  FreeMaterialService,
  createFreeMaterialService('union-then-difference')
)

/** Creates a free-material service with an explicit local Clipper operation. */
export function createFreeMaterialService(operation: FreeMaterialOperation): FreeMaterialService {
  return {
    computeFreeMaterial: (input) => deriveFreeMaterial(input, operation),
    extendFreeMaterial: (input) => deriveExtendedFreeMaterial(input)
  }
}

function deriveFreeMaterial(
  input: ComputeFreeMaterialInput,
  operation: FreeMaterialOperation
): Effect.Effect<FreeMaterialSnapshot, IrregularGeometryInputError> {
  const sheetPath = toSheetPath(input.sheet)
  if ('message' in sheetPath) return failInvalidGeometry('computeFreeMaterial', sheetPath.message)

  const occupiedPaths: Path64[] = []
  for (let index = 0; index < input.placed.length; index += 1) {
    const placed = input.placed[index]
    if (placed === undefined) {
      return failInvalidGeometry('computeFreeMaterial', 'placed geometry entry is missing.')
    }

    const path = toPlacedPath(placed, index)
    if ('message' in path) return failInvalidGeometry('computeFreeMaterial', path.message)
    occupiedPaths.push(path.path)
  }

  const occupiedClip = prepareOccupiedClip(operation, occupiedPaths)
  if ('message' in occupiedClip)
    return failInvalidGeometry('computeFreeMaterial', occupiedClip.message)

  return deriveSnapshotFromDifference(
    input.sheet,
    [sheetPath.path],
    occupiedClip.paths,
    'computeFreeMaterial'
  )
}

function deriveExtendedFreeMaterial(
  input: ExtendFreeMaterialInput
): Effect.Effect<FreeMaterialSnapshot, IrregularGeometryInputError> {
  const sheetPath = toSheetPath(input.parent.sheet)
  if ('message' in sheetPath) return failInvalidGeometry('extendFreeMaterial', sheetPath.message)

  const materialPaths = toMaterialPaths(input.parent)
  if ('message' in materialPaths)
    return failInvalidGeometry('extendFreeMaterial', materialPaths.message)

  const placedPath = toPlacedPath(input.placed, 0)
  if ('message' in placedPath) return failInvalidGeometry('extendFreeMaterial', placedPath.message)

  return deriveSnapshotFromDifference(
    input.parent.sheet,
    materialPaths.paths,
    [placedPath.path],
    'extendFreeMaterial'
  )
}

function deriveSnapshotFromDifference(
  sheet: SheetSpec,
  subjectPaths: Paths64,
  clipPaths: Paths64 | null,
  operation: 'computeFreeMaterial' | 'extendFreeMaterial'
): Effect.Effect<FreeMaterialSnapshot, IrregularGeometryInputError> {
  const tree = new PolyTree64()
  try {
    booleanOpWithPolyTree(
      ClipType.Difference,
      subjectPaths,
      clipPaths,
      tree,
      FillRule.NonZero
    )
  } catch (error) {
    return failInvalidGeometry(operation, clipperFailureMessage(error))
  }

  const regions = regionsFromTree(tree)
  if ('message' in regions) return failInvalidGeometry(operation, regions.message)

  const orderedRegions = [...regions.regions].sort(compareRegions)
  return Effect.succeed(
    new FreeMaterialSnapshot({
      sheet,
      regions: orderedRegions.map(
        (region) =>
          new FreeMaterialRegion({
            boundary: region.boundary,
            holes: [...region.holes].sort(comparePolygons)
          })
      ),
      diagnostics: []
    })
  )
}

interface OccupiedClipResult {
  readonly paths: Paths64 | null
}

interface MaterialPathsResult {
  readonly paths: Paths64
}

function prepareOccupiedClip(
  operation: FreeMaterialOperation,
  occupiedPaths: Paths64
): OccupiedClipResult | GeometryFailure {
  if (occupiedPaths.length === 0) return { paths: null }
  if (operation === 'direct-difference') return { paths: occupiedPaths }

  const occupiedTree = new PolyTree64()
  try {
    booleanOpWithPolyTree(ClipType.Union, occupiedPaths, null, occupiedTree, FillRule.NonZero)
  } catch (error) {
    return { message: clipperFailureMessage(error) }
  }
  const occupiedUnion = polyTreeToPaths64(occupiedTree)
  if (occupiedUnion.length === 0) {
    return { message: 'Clipper2 union returned no occupied geometry for non-empty input.' }
  }

  for (let index = 0; index < occupiedUnion.length; index += 1) {
    const unionPath = occupiedUnion[index]
    if (unionPath === undefined) return { message: 'Clipper2 union returned a missing path.' }
    const guardMessage = validateCoordinateGuard(unionPath)
    if (guardMessage !== undefined) return { message: guardMessage }
    const pathMessage = validateClipperOutputPath(unionPath, `Clipper2 union path ${index}`)
    if (pathMessage !== undefined) return { message: pathMessage }
  }

  return { paths: occupiedUnion }
}

interface PathResult {
  readonly path: Path64
}

interface GeometryFailure {
  readonly message: string
}

function toSheetPath(sheet: SheetSpec): PathResult | GeometryFailure {
  const width = toGridMm(sheet.width)
  const height = toGridMm(sheet.height)
  if (width === undefined || height === undefined) {
    return { message: 'sheet dimensions cannot be represented by the Clipper2 integer grid.' }
  }

  const path: Path64 = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height }
  ]
  const guardMessage = validateCoordinateGuard(path)
  if (guardMessage !== undefined) return { message: guardMessage }

  const pathMessage = validatePath(path, 'sheet path')
  if (pathMessage !== undefined) return { message: pathMessage }
  return { path }
}

function toMaterialPaths(snapshot: FreeMaterialSnapshot): MaterialPathsResult | GeometryFailure {
  const paths: Paths64 = []
  for (let regionIndex = 0; regionIndex < snapshot.regions.length; regionIndex += 1) {
    const region = snapshot.regions[regionIndex]
    if (region === undefined) return { message: 'free-material region entry is missing.' }

    const boundary = toMaterialPath(
      region.boundary,
      `free-material boundary ${regionIndex}`,
      true
    )
    if ('message' in boundary) return boundary
    paths.push(boundary.path)

    for (let holeIndex = 0; holeIndex < region.holes.length; holeIndex += 1) {
      const hole = region.holes[holeIndex]
      if (hole === undefined) return { message: 'free-material hole entry is missing.' }
      const holePath = toMaterialPath(
        hole,
        `free-material hole ${regionIndex}:${holeIndex}`,
        false
      )
      if ('message' in holePath) return holePath
      paths.push(holePath.path)
    }
  }

  return { paths }
}

function toMaterialPath(
  polygon: IrregularPolygon,
  label: string,
  counterClockwise: boolean
): PathResult | GeometryFailure {
  const path: Path64 = []
  for (const point of polygon.points) {
    const x = toGridMm(point.x)
    const y = toGridMm(point.y)
    if (x === undefined || y === undefined) {
      return { message: `${label} cannot be represented by the Clipper2 grid.` }
    }
    path.push({ x: normalizeNegativeZero(x), y: normalizeNegativeZero(y) })
  }

  const normalizedPath = stripDuplicates(path, true)
  const guardMessage = validateCoordinateGuard(normalizedPath)
  if (guardMessage !== undefined) return { message: `${label}: ${guardMessage}` }
  const pathMessage = validateClipperOutputPath(normalizedPath, label)
  if (pathMessage !== undefined) return { message: pathMessage }

  return { path: canonicalizeWinding(normalizedPath, counterClockwise) }
}

function toPlacedPath(placed: IrregularPlacedPiece, index: number): PathResult | GeometryFailure {
  const boundary = ConvexPolygonValidation.validateStrictBoundary(
    placed.collisionGeometry.polygon.points
  )
  if ('message' in boundary) {
    return { message: `placed collision polygon ${index} ${boundary.message}` }
  }

  const path: Path64 = []
  for (
    let pointIndex = 0;
    pointIndex < placed.collisionGeometry.polygon.points.length;
    pointIndex += 1
  ) {
    const point = placed.collisionGeometry.polygon.points[pointIndex]
    if (point === undefined)
      return { message: `placed collision polygon ${index} has a missing vertex.` }

    const translatedX = point.x + placed.placement.transform.translateX
    const translatedY = point.y + placed.placement.transform.translateY
    if (!Number.isFinite(translatedX) || !Number.isFinite(translatedY)) {
      return { message: `placed collision polygon ${index} translation is not finite.` }
    }

    const x = toGridMm(translatedX)
    const y = toGridMm(translatedY)
    if (x === undefined || y === undefined) {
      return {
        message: `placed collision polygon ${index} cannot be represented by the Clipper2 grid.`
      }
    }
    path.push({ x: normalizeNegativeZero(x), y: normalizeNegativeZero(y) })
  }

  const guardMessage = validateCoordinateGuard(path)
  if (guardMessage !== undefined) return { message: guardMessage }

  const pathMessage = validatePath(path, `placed collision polygon ${index}`)
  if (pathMessage !== undefined) return { message: pathMessage }
  return { path: canonicalizeCounterClockwise(path) }
}

/**
 * `NonZero` treats opposite windings as subtraction. Every occupied input must
 * therefore use the same counter-clockwise winding before the union, including
 * paths produced by mirrored transforms.
 */
function canonicalizeCounterClockwise(path: Path64): Path64 {
  return canonicalizeWinding(path, true)
}

function canonicalizeWinding(path: Path64, counterClockwise: boolean): Path64 {
  const isCounterClockwise = area(path) > 0
  return isCounterClockwise === counterClockwise ? path : [...path].reverse()
}

function validateCoordinateGuard(path: Path64): string | undefined {
  for (const point of path) {
    if (
      !Number.isSafeInteger(point.x) ||
      !Number.isSafeInteger(point.y) ||
      Math.abs(point.x) > CLIPPER2_OFFSET_POLICY.maxScaledCoordinate ||
      Math.abs(point.y) > CLIPPER2_OFFSET_POLICY.maxScaledCoordinate
    ) {
      return 'coordinates exceed the Clipper2 scaled coordinate guard.'
    }
  }

  return undefined
}

function validatePath(path: Path64, label: string): string | undefined {
  return validatePathStructure(path, label, true)
}

/**
 * Validates a computed Clipper2 boundary without rejecting a non-adjacent
 * repeated point created when material regions meet at one exact point.
 * Winding retains the correct net area of that diagnostic-only topology.
 */
function validateClipperOutputPath(path: Path64, label: string): string | undefined {
  return validatePathStructure(path, label, false)
}

function validatePathStructure(
  path: Path64,
  label: string,
  requireUniqueVertices: boolean
): string | undefined {
  if (path.length < 3) return `${label} must contain at least three vertices.`

  const uniquePoints = new Set<string>()
  for (let index = 0; index < path.length; index += 1) {
    const point = path[index]
    if (point === undefined) return `${label} has a missing vertex.`
    if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) {
      return `${label} contains an unsafe integer coordinate.`
    }

    const key = `${point.x}:${point.y}`
    if (requireUniqueVertices && uniquePoints.has(key))
      return `${label} must contain unique vertices.`
    uniquePoints.add(key)
  }

  const signedArea = area(path)
  if (!Number.isFinite(signedArea) || signedArea === 0) {
    return `${label} must have finite non-zero area.`
  }
  return undefined
}

interface MaterialRegionArtifact {
  readonly boundary: IrregularPolygon
  readonly holes: ReadonlyArray<IrregularPolygon>
}

interface RegionResult {
  readonly regions: ReadonlyArray<MaterialRegionArtifact>
}

function regionsFromTree(tree: PolyTree64): RegionResult | GeometryFailure {
  const regions: MaterialRegionArtifact[] = []
  const result = collectTreeChildren(tree, regions)
  if (result !== undefined) return { message: result }
  return { regions }
}

function collectTreeChildren(
  parent: PolyPath64,
  regions: MaterialRegionArtifact[]
): string | undefined {
  for (let index = 0; index < parent.count; index += 1) {
    let child: PolyPath64
    try {
      child = parent.child(index)
    } catch (error) {
      return clipperFailureMessage(error)
    }

    if (child.polygon === null) return 'Clipper2 returned a polygon node without a path.'

    if (!child.isHole) {
      const boundary = polygonFromPath(child.polygon, 'free-material boundary')
      if ('message' in boundary) return boundary.message

      const holes: IrregularPolygon[] = []
      for (let holeIndex = 0; holeIndex < child.count; holeIndex += 1) {
        let hole: PolyPath64
        try {
          hole = child.child(holeIndex)
        } catch (error) {
          return clipperFailureMessage(error)
        }
        if (!hole.isHole) continue
        if (hole.polygon === null) return 'Clipper2 returned a hole node without a path.'
        const holePolygon = polygonFromPath(hole.polygon, 'free-material hole')
        if ('message' in holePolygon) return holePolygon.message
        holes.push(holePolygon.polygon)
      }
      regions.push({ boundary: boundary.polygon, holes })
    }

    const nestedResult = collectTreeChildren(child, regions)
    if (nestedResult !== undefined) return nestedResult
  }

  return undefined
}

interface PolygonResult {
  readonly polygon: IrregularPolygon
}

function polygonFromPath(path: Path64, label: string): PolygonResult | GeometryFailure {
  const normalizedPath = normalizeClipperOutputPath(path)
  const guardMessage = validateCoordinateGuard(normalizedPath)
  if (guardMessage !== undefined) return { message: `${label}: ${guardMessage}` }
  const pathMessage = validateClipperOutputPath(normalizedPath, label)
  if (pathMessage !== undefined) return { message: pathMessage }

  const points = normalizedPath.map(
    (point) => new IrregularPoint({ x: fromGrid(point.x), y: fromGrid(point.y) })
  )
  return { polygon: new IrregularPolygon({ points: rotateToStableStart(points) }) }
}

/**
 * Normalizes redundant consecutive and closing vertices emitted by Clipper2.
 * A non-adjacent repeated point is preserved because it can encode a valid
 * point contact in the diagnostic material boundary; source input remains
 * subject to strict unique-vertex validation before boolean operations.
 */
function normalizeClipperOutputPath(path: Path64): Path64 {
  return stripDuplicates(path, true)
}

function compareRegions(first: MaterialRegionArtifact, second: MaterialRegionArtifact): number {
  return comparePolygons(first.boundary, second.boundary)
}

function comparePolygons(first: IrregularPolygon, second: IrregularPolygon): number {
  const firstPoint = first.points[0]
  const secondPoint = second.points[0]
  if (firstPoint === undefined || secondPoint === undefined)
    return first.points.length - second.points.length
  if (firstPoint.y !== secondPoint.y) return firstPoint.y - secondPoint.y
  if (firstPoint.x !== secondPoint.x) return firstPoint.x - secondPoint.x
  return polygonKey(first).localeCompare(polygonKey(second))
}

function polygonKey(polygon: IrregularPolygon): string {
  return polygon.points.map((point) => `${point.x}:${point.y}`).join('|')
}

function rotateToStableStart(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
  let startIndex = 0
  for (let index = 1; index < points.length; index += 1) {
    const candidate = points[index]
    const current = points[startIndex]
    if (candidate === undefined || current === undefined) continue
    if (candidate.y < current.y || (candidate.y === current.y && candidate.x < current.x)) {
      startIndex = index
    }
  }

  return [...points.slice(startIndex), ...points.slice(0, startIndex)]
}

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

function clipperFailureMessage(error: unknown): string {
  if (error instanceof Error) return `Clipper2 free-material operation failed: ${error.message}`
  return 'Clipper2 free-material operation failed with a non-error exception.'
}

function failInvalidGeometry(
  operation: string,
  message: string
): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(new IrregularGeometryInputError({ operation, message }))
}
