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

export interface InternalTransformCandidate {
  readonly index: number
  readonly rotationDeg: number
  readonly mirrored: boolean
  readonly reason: string
}

export interface InternalGeometrySettings {
  readonly flatteningSagToleranceMm: number
  readonly clearanceSafetyMarginMm: number
  readonly geometryBackendId: string
  readonly geometryBackendVersion: string
}

export interface InternalSheetSpec {
  readonly width: number
  readonly height: number
  readonly label: string
}

export interface InternalCollisionGeometry<TPieceId extends string = string> {
  readonly sourcePieceId: TPieceId
  readonly sourceBounds: InternalBounds
  readonly sampledPoints: ReadonlyArray<InternalPoint>
  readonly convexHull: InternalPolygon
  readonly collisionPolygon: InternalPolygon
  readonly placementReference: InternalPoint
}

export interface InternalTransformedCollisionGeometry<
  TPieceId extends string = string,
  TTransform extends InternalTransformCandidate = InternalTransformCandidate
> {
  readonly sourcePieceId: TPieceId
  readonly transform: TTransform
  readonly polygon: InternalPolygon
  readonly bounds: InternalBounds
}

export interface InternalIfpBounds<
  TPieceId extends string = string,
  TSheet extends InternalSheetSpec = InternalSheetSpec
> {
  readonly sheet: TSheet
  readonly movingPieceId: TPieceId
  readonly bounds: InternalBounds
}
