import { Schema, SchemaTransformation } from 'effect'

/** All internal measurements are millimeters. */
export type Millimeters = number

export const Millimeters = Schema.Number

export class Point2 extends Schema.Class<Point2>('Point2')({
  x: Millimeters,
  y: Millimeters
}) {}

export class Size2 extends Schema.Class<Size2>('Size2')({
  width: Millimeters,
  height: Millimeters
}) {}

export class Rect extends Schema.Class<Rect>('Rect')({
  x: Millimeters,
  y: Millimeters,
  width: Millimeters,
  height: Millimeters
}) {}

export class RectWith extends Rect.extend<RectWith>('RectWith')({
  longestEdge: Millimeters,
  area: Schema.Number,
  imbalance: Millimeters
}) {
  static fromRect(rect: Rect): RectWith {
    return new RectWith({
      ...rect,
      longestEdge: Math.max(rect.height, rect.width),
      area: rect.height * rect.width,
      imbalance: Math.abs(rect.height - rect.width)
    })
  }
}

export const RectWithFromRect = Rect.pipe(
  Schema.decodeTo(
    RectWith,
    SchemaTransformation.transform({
      decode: (rect) => ({
        ...rect,
        longestEdge: Math.max(rect.height, rect.width),
        area: rect.height * rect.width,
        imbalance: Math.abs(rect.height - rect.width)
      }),
      encode: ({ x, y, width, height }) => ({
        x,
        y,
        width,
        height
      })
    })
  )
)
