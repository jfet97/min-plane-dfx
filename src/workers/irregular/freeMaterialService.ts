import {
  area,
  booleanOpWithPolyTree,
  ClipType,
  FillRule,
  type Path64,
  polyTreeToPaths64,
  type Paths64,
  type PolyPath64,
  PolyTree64
} from 'clipper2-ts'
import { Effect, Exit, Layer, Schema } from 'effect'
import {
  FreeMaterialRegion,
  FreeMaterialSnapshot,
  IrregularPoint,
  IrregularPolygon
} from '@shared/irregular/domain.js'
import type { IrregularPlacedPiece } from '@shared/irregular/domain.js'
import {
  ComputeFreeMaterialInput,
  FreeMaterialService,
  IrregularGeometryInputError
} from './services.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'
import { CLIPPER2_OFFSET_POLICY, fromGrid, toGridMm } from './clipper2OffsetPolicy.js'

/** Effect layer providing topology-preserving sheet-space free material. */
export const FreeMaterialServiceLive = Layer.succeed(FreeMaterialService, {
  computeFreeMaterial
})

/**
 * Computes `sheet - union(translated placed collision polygons)` for display
 * and scoring. The resulting regions preserve interior holes and never define
 * placement legality.
 */
function computeFreeMaterial(
  input: ComputeFreeMaterialInput
): Effect.Effect<FreeMaterialSnapshot, IrregularGeometryInputError> {
  return decodeInput(input).pipe(Effect.flatMap(deriveFreeMaterial))
}

function decodeInput(
  input: ComputeFreeMaterialInput
): Effect.Effect<ComputeFreeMaterialInput, IrregularGeometryInputError> {
  const decoded = Schema.decodeUnknownExit(ComputeFreeMaterialInput)(input)
  if (Exit.isFailure(decoded)) {
    return failInvalidGeometry(
      'computeFreeMaterial',
      'free-material input must satisfy its schema.'
    )
  }

  return Effect.succeed(decoded.value)
}

function deriveFreeMaterial(
  input: ComputeFreeMaterialInput
): Effect.Effect<FreeMaterialSnapshot, IrregularGeometryInputError> {
  const sheetPath = toSheetPath(input)
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

  const tree = new PolyTree64()
  try {
    let occupiedUnion: Paths64 | null = null
    if (occupiedPaths.length > 0) {
      const occupiedTree = new PolyTree64()
      booleanOpWithPolyTree(ClipType.Union, occupiedPaths, null, occupiedTree, FillRule.NonZero)
      occupiedUnion = polyTreeToPaths64(occupiedTree)
      if (occupiedUnion.length === 0) {
        return failInvalidGeometry(
          'computeFreeMaterial',
          'Clipper2 union returned no occupied geometry for non-empty input.'
        )
      }
      for (let index = 0; index < occupiedUnion.length; index += 1) {
        const unionPath = occupiedUnion[index]
        if (unionPath === undefined) {
          return failInvalidGeometry(
            'computeFreeMaterial',
            'Clipper2 union returned a missing path.'
          )
        }
        const guardMessage = validateCoordinateGuard(unionPath)
        if (guardMessage !== undefined)
          return failInvalidGeometry('computeFreeMaterial', guardMessage)
        const pathMessage = validatePath(unionPath, `Clipper2 union path ${index}`)
        if (pathMessage !== undefined)
          return failInvalidGeometry('computeFreeMaterial', pathMessage)
      }
    }

    booleanOpWithPolyTree(
      ClipType.Difference,
      [sheetPath.path],
      occupiedUnion,
      tree,
      FillRule.NonZero
    )
  } catch (error) {
    return failInvalidGeometry('computeFreeMaterial', clipperFailureMessage(error))
  }

  const regions = regionsFromTree(tree)
  if ('message' in regions) return failInvalidGeometry('computeFreeMaterial', regions.message)

  const orderedRegions = [...regions.regions].sort(compareRegions)
  return Effect.succeed(
    new FreeMaterialSnapshot({
      sheet: input.sheet,
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

interface PathResult {
  readonly path: Path64
}

interface GeometryFailure {
  readonly message: string
}

function toSheetPath(input: ComputeFreeMaterialInput): PathResult | GeometryFailure {
  const width = toGridMm(input.sheet.width)
  const height = toGridMm(input.sheet.height)
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
  return { path }
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
  if (path.length < 3) return `${label} must contain at least three vertices.`

  const uniquePoints = new Set<string>()
  for (let index = 0; index < path.length; index += 1) {
    const point = path[index]
    if (point === undefined) return `${label} has a missing vertex.`
    if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) {
      return `${label} contains an unsafe integer coordinate.`
    }

    const key = `${point.x}:${point.y}`
    if (uniquePoints.has(key)) return `${label} must contain unique vertices.`
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
  const guardMessage = validateCoordinateGuard(path)
  if (guardMessage !== undefined) return { message: `${label}: ${guardMessage}` }
  const pathMessage = validatePath(path, label)
  if (pathMessage !== undefined) return { message: pathMessage }

  const points = path.map(
    (point) => new IrregularPoint({ x: fromGrid(point.x), y: fromGrid(point.y) })
  )
  return { polygon: new IrregularPolygon({ points: rotateToStableStart(points) }) }
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
