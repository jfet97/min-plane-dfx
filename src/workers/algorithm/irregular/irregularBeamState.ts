import type { PieceId } from '@shared/domain/ids.js'
import type { IrregularPlacedPiece, IrregularPreparedPiece } from '@shared/irregular/domain.js'
import {
  makePlacedCollisionSpatialIndex,
  type PlacedCollisionSpatialEntry,
  type PlacedCollisionSpatialIndex
} from '../../irregular/placedCollisionSpatialIndex.js'
import { measureSharedConvexPolygonBoundaryContact } from '../../irregular/convexPolygonContact.js'

export interface IrregularCollisionBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
  readonly width: number
  readonly height: number
}

interface IrregularBeamStateInput {
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly unplacedPieceIds?: ReadonlyArray<PieceId>
  readonly unplacedSourcePieceIds?: ReadonlyArray<PieceId>
  readonly placementOrder: ReadonlyArray<PieceId>
  readonly parent?: IrregularBeamState | undefined
  readonly placedCollisionIndex?: PlacedCollisionSpatialIndex
}

interface DerivedIrregularBeamStateMetadata {
  readonly canonicalEntryKeys: ReadonlyArray<string>
  readonly canonicalOccupiedGeometryKey: string
  readonly translatedCollisionBounds: IrregularCollisionBounds | undefined
  readonly sharedCollisionBoundaryLengthMm: number | undefined
  readonly sharedCollisionBoundaryContactUnits: number | undefined
  readonly nearCompleteStructuralContactCount: number | undefined
  readonly placedCollisionIndex: PlacedCollisionSpatialIndex
}

interface SharedCollisionBoundaryMetrics {
  readonly lengthMm: number
  readonly normalizedUnits: number
  readonly nearCompleteStructuralContactCount: number
}

const derivedMetadata = Symbol('derivedMetadata')

type IrregularBeamStateConstructionInput = IrregularBeamStateInput & {
  readonly [derivedMetadata]?: DerivedIrregularBeamStateMetadata
}

/** The algorithm-owned partial irregular layout retained by a beam. */
export class IrregularBeamState {
  /** Prepared pieces that have not yet been attempted by this state. */
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  /** Collision geometries committed to this state, in placement order. */
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  /** Prepared ids consumed without a committed legal placement. */
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  /** Legacy name retained for existing scorer callers. */
  readonly unplacedSourcePieceIds: ReadonlyArray<PieceId>
  /** Prepared ids of committed placements, retained as a deterministic history. */
  readonly placementOrder: ReadonlyArray<PieceId>
  /** Previous state on this branch, retained only while reconstructing winning history. */
  readonly parent: IrregularBeamState | undefined
  /** Exact occupancy identity independent of placement-array order. */
  readonly canonicalOccupiedGeometryKey: string
  /** Bounds around translated collision polygons retained for derived scoring. */
  readonly translatedCollisionBounds: IrregularCollisionBounds | undefined
  /** Exact cumulative boundary shared by translated collision polygons. */
  readonly sharedCollisionBoundaryLengthMm: number | undefined
  /** Shared boundary measured in fractions of the smaller polygon's longest edge. */
  readonly sharedCollisionBoundaryContactUnits: number | undefined
  /** Near-complete overlaps between collision edges at structural polygon scale. */
  readonly nearCompleteStructuralContactCount: number | undefined
  /** Persistent conservative index for translated placed collision bounds. */
  readonly placedCollisionIndex: PlacedCollisionSpatialIndex

  private readonly canonicalEntryKeys: ReadonlyArray<string>

  constructor(input: IrregularBeamStateConstructionInput) {
    this.remainingPreparedPieces = [...input.remainingPreparedPieces]
    this.placedCollisionGeometries = [...input.placedCollisionGeometries]
    const unplacedPieceIds = input.unplacedPieceIds ?? input.unplacedSourcePieceIds ?? []
    this.unplacedPieceIds = [...unplacedPieceIds]
    this.unplacedSourcePieceIds = [...unplacedPieceIds]
    this.placementOrder = [...input.placementOrder]
    this.parent = input.parent
    const metadata = input[derivedMetadata] ?? deriveMetadata(this.placedCollisionGeometries)
    const placedCollisionIndex = input.placedCollisionIndex ?? metadata.placedCollisionIndex
    this.placedCollisionIndex =
      placedCollisionIndex !== undefined && placedCollisionIndex.matches(this.placedCollisionGeometries)
        ? placedCollisionIndex
        : makePlacedCollisionSpatialIndex(this.placedCollisionGeometries)

    this.canonicalEntryKeys = metadata.canonicalEntryKeys
    this.canonicalOccupiedGeometryKey = metadata.canonicalOccupiedGeometryKey
    this.translatedCollisionBounds = metadata.translatedCollisionBounds
    this.sharedCollisionBoundaryLengthMm = metadata.sharedCollisionBoundaryLengthMm
    this.sharedCollisionBoundaryContactUnits = metadata.sharedCollisionBoundaryContactUnits
    this.nearCompleteStructuralContactCount = metadata.nearCompleteStructuralContactCount
  }

  /** Creates the empty layout state without inventing any geometry or result. */
  static empty(remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>): IrregularBeamState {
    return new IrregularBeamState({
      remainingPreparedPieces,
      placedCollisionGeometries: [],
      unplacedSourcePieceIds: [],
      placementOrder: []
    })
  }

  withPlacement(input: {
    readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly placedCollisionGeometry: IrregularPlacedPiece
    readonly placementOrderPieceId: PieceId
  }): IrregularBeamState {
    const placedCollisionGeometries = [
      ...this.placedCollisionGeometries,
      input.placedCollisionGeometry
    ]
    const canonicalEntryKeys = insertCanonicalEntryKey(
      this.canonicalEntryKeys,
      canonicalPlacedGeometryKey(input.placedCollisionGeometry)
    )
    const placedCollisionIndex = this.placedCollisionIndex.add(input.placedCollisionGeometry)
    const addedEntry = placedCollisionIndex.entries[placedCollisionIndex.entries.length - 1]
    const sharedBoundaryMetrics = extendSharedCollisionBoundaryMetrics(
      {
        lengthMm: this.sharedCollisionBoundaryLengthMm,
        normalizedUnits: this.sharedCollisionBoundaryContactUnits,
        nearCompleteStructuralContactCount: this.nearCompleteStructuralContactCount
      },
      this.placedCollisionIndex,
      addedEntry
    )
    return IrregularBeamState.fromDerivedMetadata(
      {
        remainingPreparedPieces: input.remainingPreparedPieces,
        placedCollisionGeometries,
        unplacedPieceIds: this.unplacedPieceIds,
        placementOrder: [...this.placementOrder, input.placementOrderPieceId],
        parent: this
      },
      {
        canonicalEntryKeys,
        canonicalOccupiedGeometryKey: canonicalEntryListKey(canonicalEntryKeys),
        translatedCollisionBounds:
          this.placedCollisionGeometries.length === 0
            ? derivePlacedCollisionBounds(input.placedCollisionGeometry)
            : extendCollisionBounds(this.translatedCollisionBounds, input.placedCollisionGeometry),
        sharedCollisionBoundaryLengthMm: sharedBoundaryMetrics?.lengthMm,
        sharedCollisionBoundaryContactUnits: sharedBoundaryMetrics?.normalizedUnits,
        nearCompleteStructuralContactCount:
          sharedBoundaryMetrics?.nearCompleteStructuralContactCount,
        placedCollisionIndex
      }
    )
  }

  withUnplacedPiece(input: {
    readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly unplacedPieceId: PieceId
  }): IrregularBeamState {
    return IrregularBeamState.fromDerivedMetadata(
      {
        remainingPreparedPieces: input.remainingPreparedPieces,
        placedCollisionGeometries: this.placedCollisionGeometries,
        unplacedPieceIds: [...this.unplacedPieceIds, input.unplacedPieceId],
        placementOrder: this.placementOrder,
        parent: this
      },
      {
        canonicalEntryKeys: this.canonicalEntryKeys,
        canonicalOccupiedGeometryKey: this.canonicalOccupiedGeometryKey,
        translatedCollisionBounds: this.translatedCollisionBounds,
        sharedCollisionBoundaryLengthMm: this.sharedCollisionBoundaryLengthMm,
        sharedCollisionBoundaryContactUnits: this.sharedCollisionBoundaryContactUnits,
        nearCompleteStructuralContactCount: this.nearCompleteStructuralContactCount,
        placedCollisionIndex: this.placedCollisionIndex
      }
    )
  }

  private static fromDerivedMetadata(
    input: IrregularBeamStateInput,
    metadata: DerivedIrregularBeamStateMetadata
  ): IrregularBeamState {
    return new IrregularBeamState({ ...input, [derivedMetadata]: metadata })
  }
}

function deriveMetadata(
  placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
): DerivedIrregularBeamStateMetadata {
  const canonicalEntryKeys = Object.freeze(
    placedCollisionGeometries.map(canonicalPlacedGeometryKey).toSorted(compareCanonicalKeys)
  )
  const sharedBoundaryMetrics = deriveSharedCollisionBoundaryMetrics(placedCollisionGeometries)
  return {
    canonicalEntryKeys,
    canonicalOccupiedGeometryKey: canonicalEntryListKey(canonicalEntryKeys),
    translatedCollisionBounds: deriveCollisionBounds(placedCollisionGeometries),
    sharedCollisionBoundaryLengthMm: sharedBoundaryMetrics?.lengthMm,
    sharedCollisionBoundaryContactUnits: sharedBoundaryMetrics?.normalizedUnits,
    nearCompleteStructuralContactCount: sharedBoundaryMetrics?.nearCompleteStructuralContactCount,
    placedCollisionIndex: makePlacedCollisionSpatialIndex(placedCollisionGeometries)
  }
}

function deriveSharedCollisionBoundaryMetrics(
  placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
): SharedCollisionBoundaryMetrics | undefined {
  const index = makePlacedCollisionSpatialIndex(placedCollisionGeometries)
  let totalLengthMm = 0
  let totalNormalizedUnits = 0
  let nearCompleteStructuralContactCount = 0
  for (const entry of index.entries) {
    const additional = sharedBoundaryWithEntries(entry, index.entries.slice(0, entry.ordinal))
    if (additional === undefined) return undefined
    totalLengthMm += additional.lengthMm
    totalNormalizedUnits += additional.normalizedUnits
    nearCompleteStructuralContactCount += additional.nearCompleteStructuralContactCount
    if (
      !Number.isFinite(totalLengthMm) ||
      !Number.isFinite(totalNormalizedUnits) ||
      !Number.isSafeInteger(nearCompleteStructuralContactCount)
    ) {
      return undefined
    }
  }
  return { lengthMm: totalLengthMm, normalizedUnits: totalNormalizedUnits, nearCompleteStructuralContactCount }
}

function extendSharedCollisionBoundaryMetrics(
  current: {
    readonly lengthMm: number | undefined
    readonly normalizedUnits: number | undefined
    readonly nearCompleteStructuralContactCount: number | undefined
  },
  existingIndex: PlacedCollisionSpatialIndex,
  addedEntry: PlacedCollisionSpatialEntry | undefined
): SharedCollisionBoundaryMetrics | undefined {
  if (
    current.lengthMm === undefined ||
    current.normalizedUnits === undefined ||
    current.nearCompleteStructuralContactCount === undefined ||
    addedEntry?.translated === undefined
  ) {
    return undefined
  }
  const additional = sharedBoundaryWithEntries(
    addedEntry,
    existingIndex.query(addedEntry.indexedBounds)
  )
  if (additional === undefined) return undefined
  const lengthMm = current.lengthMm + additional.lengthMm
  const normalizedUnits = current.normalizedUnits + additional.normalizedUnits
  const nearCompleteStructuralContactCount =
    current.nearCompleteStructuralContactCount + additional.nearCompleteStructuralContactCount
  return Number.isFinite(lengthMm) &&
    Number.isFinite(normalizedUnits) &&
    Number.isSafeInteger(nearCompleteStructuralContactCount)
    ? { lengthMm, normalizedUnits, nearCompleteStructuralContactCount }
    : undefined
}

function sharedBoundaryWithEntries(
  addedEntry: PlacedCollisionSpatialEntry,
  existingEntries: ReadonlyArray<PlacedCollisionSpatialEntry>
): SharedCollisionBoundaryMetrics | undefined {
  if (addedEntry.translated === undefined) return undefined
  let totalLengthMm = 0
  let totalNormalizedUnits = 0
  let nearCompleteStructuralContactCount = 0
  for (const existingEntry of existingEntries) {
    if (existingEntry.translated === undefined) return undefined
    const contact = measureSharedConvexPolygonBoundaryContact(
      addedEntry.translated,
      existingEntry.translated
    )
    if (contact === undefined) return undefined
    totalLengthMm += contact.lengthMm
    totalNormalizedUnits += contact.normalizedUnits
    nearCompleteStructuralContactCount += contact.nearCompleteStructuralContactCount
    if (
      !Number.isFinite(totalLengthMm) ||
      !Number.isFinite(totalNormalizedUnits) ||
      !Number.isSafeInteger(nearCompleteStructuralContactCount)
    ) {
      return undefined
    }
  }
  return { lengthMm: totalLengthMm, normalizedUnits: totalNormalizedUnits, nearCompleteStructuralContactCount }
}

type CanonicalPoint = readonly [x: number, y: number]

function canonicalPlacedGeometryKey(placed: IrregularPlacedPiece): string {
  const translation = placed.placement.transform
  const translatedPoints: ReadonlyArray<CanonicalPoint> =
    placed.collisionGeometry.polygon.points.map(
      (point): CanonicalPoint => [
        normalizeCanonicalCoordinate(point.x + translation.translateX),
        normalizeCanonicalCoordinate(point.y + translation.translateY)
      ]
    )
  return canonicalRecord([['polygon-ring', canonicalRingKey(translatedPoints)]])
}

function canonicalRingKey(points: ReadonlyArray<CanonicalPoint>): string {
  if (points.length === 0) return canonicalRecord([['point-count', '0']])

  const startIndex = lowestYThenXIndex(points)
  const forward = rotatedRing(points, startIndex, 1)
  const reverse = rotatedRing(points, startIndex, -1)
  const canonicalPoints = compareCanonicalPointSequences(forward, reverse) <= 0 ? forward : reverse
  return canonicalRecord([
    ['point-count', canonicalNumber(canonicalPoints.length)],
    ...canonicalPoints.map((point, index) => [`point-${index}`, canonicalPointKey(point)])
  ])
}

function rotatedRing(
  points: ReadonlyArray<CanonicalPoint>,
  startIndex: number,
  direction: 1 | -1
): ReadonlyArray<CanonicalPoint> {
  const ring: CanonicalPoint[] = []
  for (let offset = 0; offset < points.length; offset += 1) {
    const pointIndex = (startIndex + direction * offset + points.length * 2) % points.length
    const point = points[pointIndex]
    if (point === undefined) return []
    ring.push(point)
  }
  return ring
}

function lowestYThenXIndex(points: ReadonlyArray<CanonicalPoint>): number {
  let startIndex = 0
  for (let index = 1; index < points.length; index += 1) {
    const candidate = points[index]
    const current = points[startIndex]
    if (candidate === undefined || current === undefined) continue
    if (candidate[1] < current[1] || (candidate[1] === current[1] && candidate[0] < current[0])) {
      startIndex = index
    }
  }
  return startIndex
}

function compareCanonicalPointSequences(
  first: ReadonlyArray<CanonicalPoint>,
  second: ReadonlyArray<CanonicalPoint>
): number {
  const pointCountComparison = first.length - second.length
  if (pointCountComparison !== 0) return pointCountComparison

  for (let index = 0; index < first.length; index += 1) {
    const firstPoint = first[index]
    const secondPoint = second[index]
    if (firstPoint === undefined || secondPoint === undefined) {
      return firstPoint === undefined && secondPoint === undefined
        ? 0
        : firstPoint === undefined
          ? -1
          : 1
    }
    const pointComparison = compareCanonicalKeys(
      canonicalPointKey(firstPoint),
      canonicalPointKey(secondPoint)
    )
    if (pointComparison !== 0) return pointComparison
  }
  return 0
}

function canonicalPointKey(point: CanonicalPoint): string {
  return canonicalRecord([
    ['x', canonicalNumber(point[0])],
    ['y', canonicalNumber(point[1])]
  ])
}

function canonicalRecord(fields: ReadonlyArray<ReadonlyArray<string>>): string {
  return fields
    .map((field) => {
      const name = field[0]
      const value = field[1]
      if (name === undefined || value === undefined) return ''
      return `${canonicalToken(name)}${canonicalToken(value)}`
    })
    .join('')
}

function canonicalToken(value: string): string {
  return `${value.length}:${value}`
}

function canonicalNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (Object.is(value, -0)) return '0'
  if (value === Number.POSITIVE_INFINITY) return '+Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  return String(value)
}

function normalizeCanonicalCoordinate(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

function canonicalEntryListKey(entryKeys: ReadonlyArray<string>): string {
  return canonicalRecord([
    ['version', 'irregular-occupied-geometry-v1'],
    ['entry-count', canonicalNumber(entryKeys.length)],
    ...entryKeys.map((entryKey, index) => [`entry-${index}`, entryKey])
  ])
}

function compareCanonicalKeys(first: string, second: string): number {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}

function insertCanonicalEntryKey(
  entryKeys: ReadonlyArray<string>,
  entryKey: string
): ReadonlyArray<string> {
  const nextEntryKeys = [...entryKeys]
  let insertionIndex = nextEntryKeys.length
  for (let index = 0; index < nextEntryKeys.length; index += 1) {
    const existingEntryKey = nextEntryKeys[index]
    if (existingEntryKey !== undefined && compareCanonicalKeys(entryKey, existingEntryKey) < 0) {
      insertionIndex = index
      break
    }
  }
  nextEntryKeys.splice(insertionIndex, 0, entryKey)
  return Object.freeze(nextEntryKeys)
}

function deriveCollisionBounds(
  placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
): IrregularCollisionBounds | undefined {
  if (placedCollisionGeometries.length === 0) return emptyCollisionBounds()

  let collisionBounds: IrregularCollisionBounds | undefined
  for (const placedCollisionGeometry of placedCollisionGeometries) {
    const placedBounds = derivePlacedCollisionBounds(placedCollisionGeometry)
    if (placedBounds === undefined) return undefined
    collisionBounds =
      collisionBounds === undefined
        ? placedBounds
        : unionCollisionBounds(collisionBounds, placedBounds)
  }
  return collisionBounds
}

function extendCollisionBounds(
  current: IrregularCollisionBounds | undefined,
  placed: IrregularPlacedPiece
): IrregularCollisionBounds | undefined {
  if (current === undefined) return undefined

  const placedBounds = derivePlacedCollisionBounds(placed)
  if (placedBounds === undefined) return undefined
  return unionCollisionBounds(current, placedBounds)
}

function derivePlacedCollisionBounds(
  placed: IrregularPlacedPiece
): IrregularCollisionBounds | undefined {
  const translation = placed.placement.transform
  const points = placed.collisionGeometry.polygon.points
  if (points.length === 0) return undefined

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    const translatedX = point.x + translation.translateX
    const translatedY = point.y + translation.translateY
    if (!Number.isFinite(translatedX) || !Number.isFinite(translatedY)) return undefined
    minX = Math.min(minX, translatedX)
    minY = Math.min(minY, translatedY)
    maxX = Math.max(maxX, translatedX)
    maxY = Math.max(maxY, translatedY)
  }

  const width = maxX - minX
  const height = maxY - minY
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return undefined
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height
  }
}

function unionCollisionBounds(
  first: IrregularCollisionBounds,
  second: IrregularCollisionBounds
): IrregularCollisionBounds | undefined {
  const minX = Math.min(first.minX, second.minX)
  const minY = Math.min(first.minY, second.minY)
  const maxX = Math.max(first.maxX, second.maxX)
  const maxY = Math.max(first.maxY, second.maxY)
  const width = maxX - minX
  const height = maxY - minY
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return undefined
  }
  return { minX, minY, maxX, maxY, width, height }
}

function emptyCollisionBounds(): IrregularCollisionBounds {
  return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
}
