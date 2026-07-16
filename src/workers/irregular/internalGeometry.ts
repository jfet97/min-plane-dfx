export interface InternalPoint {
  readonly x: number
  readonly y: number
}

export interface InternalBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export interface InternalPolygon {
  readonly points: ReadonlyArray<InternalPoint>
}

export interface InternalPolygonWithBounds {
  readonly polygon: InternalPolygon
  readonly bounds: InternalBounds
}
