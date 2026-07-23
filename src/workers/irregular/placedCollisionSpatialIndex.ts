import type { IrregularPlacedPiece } from '@shared/irregular/domain.js'
import { ConvexPolygonValidation, type ConvexPolygonWinding } from './convexPolygonValidation.js'
import { translatePolygonWithBounds } from './convexBounds.js'
import type {
  InternalBounds,
  InternalPolygonWithBounds
} from './internalGeometry.js'

export const DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM = 64

const MAX_GRID_CELLS_PER_ENTRY = 4096
const MAX_GRID_CELLS_PER_QUERY = 4096

export interface IndexedPlacedCollisionPolygon extends InternalPolygonWithBounds {
  readonly winding: ConvexPolygonWinding
}

export interface PlacedCollisionSpatialEntry {
  readonly placed: IrregularPlacedPiece
  readonly translated: IndexedPlacedCollisionPolygon | undefined
  readonly validationMessage: string | undefined
  readonly indexedBounds: InternalBounds | undefined
  readonly ordinal: number
}

export interface PlacedCollisionSpatialIndex {
  readonly size: number
  readonly cellSizeMm: number
  readonly entries: ReadonlyArray<PlacedCollisionSpatialEntry>
  readonly add: (placed: IrregularPlacedPiece) => PlacedCollisionSpatialIndex
  readonly matches: (placed: ReadonlyArray<IrregularPlacedPiece>) => boolean
  readonly query: (bounds?: InternalBounds) => ReadonlyArray<PlacedCollisionSpatialEntry>
  readonly continuationIdentity: () => string
}

export function makeEmptyPlacedCollisionSpatialIndex(
  cellSizeMm = DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM
): PlacedCollisionSpatialIndex {
  return new UniformPlacedCollisionSpatialIndex({
    cellSizeMm: validCellSize(cellSizeMm),
    entries: [],
    buckets: new Map(),
    fallbackEntries: []
  })
}

export function makePlacedCollisionSpatialIndex(
  placed: ReadonlyArray<IrregularPlacedPiece>,
  cellSizeMm = DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM
): PlacedCollisionSpatialIndex {
  let index = makeEmptyPlacedCollisionSpatialIndex(cellSizeMm)
  for (const placedPiece of placed) index = index.add(placedPiece)
  return index
}

class UniformPlacedCollisionSpatialIndex implements PlacedCollisionSpatialIndex {
  readonly size: number
  readonly cellSizeMm: number
  readonly entries: ReadonlyArray<PlacedCollisionSpatialEntry>

  private readonly buckets: ReadonlyMap<string, ReadonlyArray<PlacedCollisionSpatialEntry>>
  private readonly fallbackEntries: ReadonlyArray<PlacedCollisionSpatialEntry>

  constructor(input: {
    readonly cellSizeMm: number
    readonly entries: ReadonlyArray<PlacedCollisionSpatialEntry>
    readonly buckets: ReadonlyMap<string, ReadonlyArray<PlacedCollisionSpatialEntry>>
    readonly fallbackEntries: ReadonlyArray<PlacedCollisionSpatialEntry>
  }) {
    this.size = input.entries.length
    this.cellSizeMm = input.cellSizeMm
    this.entries = input.entries
    this.buckets = input.buckets
    this.fallbackEntries = input.fallbackEntries
  }

  add(placed: IrregularPlacedPiece): PlacedCollisionSpatialIndex {
    const entry = makeEntry(placed, this.entries.length)
    const entries = [...this.entries, entry]
    const buckets = new Map(this.buckets)
    const fallbackEntries = [...this.fallbackEntries]
    const cellRange = entry.indexedBounds === undefined
      ? undefined
      : gridCellRange(entry.indexedBounds, this.cellSizeMm, MAX_GRID_CELLS_PER_ENTRY)

    if (cellRange === undefined) {
      fallbackEntries.push(entry)
    } else {
      for (let cellX = cellRange.minX; cellX <= cellRange.maxX; cellX += 1) {
        for (let cellY = cellRange.minY; cellY <= cellRange.maxY; cellY += 1) {
          const key = cellKey(cellX, cellY)
          const bucket = buckets.get(key) ?? []
          buckets.set(key, [...bucket, entry])
        }
      }
    }

    return new UniformPlacedCollisionSpatialIndex({
      cellSizeMm: this.cellSizeMm,
      entries,
      buckets,
      fallbackEntries
    })
  }

  matches(placed: ReadonlyArray<IrregularPlacedPiece>): boolean {
    if (placed.length !== this.entries.length) return false
    for (let index = 0; index < placed.length; index += 1) {
      const placedPiece = placed[index]
      const entry = this.entries[index]
      if (placedPiece === undefined || entry === undefined || entry.placed !== placedPiece) {
        return false
      }
    }
    return true
  }

  continuationIdentity(): string {
    return JSON.stringify({
      cellSizeMm: this.cellSizeMm,
      entryOrdinals: this.entries.map(({ ordinal }) => ordinal),
      buckets: [...this.buckets.entries()]
        .map(([key, entries]) => [key, entries.map(({ ordinal }) => ordinal)] as const)
        .toSorted(([first], [second]) => first.localeCompare(second)),
      fallbackOrdinals: this.fallbackEntries.map(({ ordinal }) => ordinal)
    })
  }

  query(bounds?: InternalBounds): ReadonlyArray<PlacedCollisionSpatialEntry> {
    const selected = new Set<PlacedCollisionSpatialEntry>(this.fallbackEntries)
    const cellRange = bounds === undefined
      ? undefined
      : gridCellRange(bounds, this.cellSizeMm, MAX_GRID_CELLS_PER_QUERY)

    if (bounds === undefined || cellRange === undefined) {
      for (const entry of this.entries) selected.add(entry)
    } else {
      for (let cellX = cellRange.minX; cellX <= cellRange.maxX; cellX += 1) {
        for (let cellY = cellRange.minY; cellY <= cellRange.maxY; cellY += 1) {
          const bucket = this.buckets.get(cellKey(cellX, cellY))
          if (bucket === undefined) continue
          for (const entry of bucket) selected.add(entry)
        }
      }
    }

    return this.entries.filter((entry) => {
      if (entry.validationMessage !== undefined || entry.indexedBounds === undefined) {
        return selected.has(entry)
      }
      return (
        selected.has(entry) &&
        (bounds === undefined || !areDisjoint(entry.indexedBounds, bounds))
      )
    })
  }
}

function makeEntry(
  placed: IrregularPlacedPiece,
  ordinal: number
): PlacedCollisionSpatialEntry {
  const translated = translatePolygonWithBounds(placed.collisionGeometry.polygon, {
    x: placed.placement.transform.translateX,
    y: placed.placement.transform.translateY
  })
  if (translated === undefined) {
    return {
      placed,
      translated: undefined,
      validationMessage: 'placed translation must produce finite polygon coordinates.',
      indexedBounds: undefined,
      ordinal
    }
  }

  const validation = ConvexPolygonValidation.validateStrictBoundary(translated.polygon.points)
  if ('message' in validation) {
    return {
      placed,
      translated: undefined,
      validationMessage: validation.message,
      indexedBounds: undefined,
      ordinal
    }
  }

  return {
    placed,
    translated: { ...translated, winding: validation.winding },
    validationMessage: undefined,
    indexedBounds: translated.bounds,
    ordinal
  }
}

interface GridCellRange {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

function gridCellRange(
  bounds: InternalBounds,
  cellSizeMm: number,
  maximumCellCount: number
): GridCellRange | undefined {
  if (
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.maxY) ||
    bounds.minX > bounds.maxX ||
    bounds.minY > bounds.maxY
  ) {
    return undefined
  }

  const minX = Math.floor(bounds.minX / cellSizeMm)
  const minY = Math.floor(bounds.minY / cellSizeMm)
  const maxX = Math.floor(bounds.maxX / cellSizeMm)
  const maxY = Math.floor(bounds.maxY / cellSizeMm)
  const width = maxX - minX + 1
  const height = maxY - minY + 1
  const cellCount = width * height
  if (
    !Number.isSafeInteger(minX) ||
    !Number.isSafeInteger(minY) ||
    !Number.isSafeInteger(maxX) ||
    !Number.isSafeInteger(maxY) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(cellCount) ||
    cellCount < 1 ||
    cellCount > maximumCellCount
  ) {
    return undefined
  }

  return { minX, minY, maxX, maxY }
}

function cellKey(cellX: number, cellY: number): string {
  return `${cellX}:${cellY}`
}

function validCellSize(cellSizeMm: number): number {
  return Number.isFinite(cellSizeMm) && cellSizeMm > 0
    ? cellSizeMm
    : DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM
}

function areDisjoint(first: InternalBounds, second: InternalBounds): boolean {
  return (
    first.maxX < second.minX ||
    second.maxX < first.minX ||
    first.maxY < second.minY ||
    second.maxY < first.minY
  )
}
