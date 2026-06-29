import { Schema, SchemaTransformation } from 'effect'

/** Raw DXF geometry can be fractional before it enters the nesting boundary. */
export type Millimeters = number

export const Millimeters = Schema.Number

/** Integer millimeters used by nesting rectangles, sheets, and placements. */
export type IntegerMillimeters = number

export const IntegerMillimeters = Schema.Int

export const NonNegativeIntegerMillimeters = IntegerMillimeters.check(
  Schema.isGreaterThanOrEqualTo(0)
)

export const PositiveIntegerMillimeters = IntegerMillimeters.check(Schema.isGreaterThan(0))

export class Point2 extends Schema.Class<Point2>('Point2')({
  x: NonNegativeIntegerMillimeters,
  y: NonNegativeIntegerMillimeters
}) {}

export class Size2 extends Schema.Class<Size2>('Size2')({
  width: PositiveIntegerMillimeters,
  height: PositiveIntegerMillimeters
}) {}

export class Rect extends Schema.Class<Rect>('Rect')({
  x: NonNegativeIntegerMillimeters,
  y: NonNegativeIntegerMillimeters,
  width: PositiveIntegerMillimeters,
  height: PositiveIntegerMillimeters
}) {}

export class RectWith extends Rect.extend<RectWith>('RectWith')({
  longestEdge: PositiveIntegerMillimeters,
  area: IntegerMillimeters.check(Schema.isGreaterThan(0)),
  imbalance: NonNegativeIntegerMillimeters
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
      decode: (rect) =>
        new RectWith({
          ...rect,
          longestEdge: Math.max(rect.height, rect.width),
          area: rect.height * rect.width,
          imbalance: Math.abs(rect.height - rect.width)
        }),
      encode: ({ x, y, width, height }) =>
        new Rect({
          x,
          y,
          width,
          height
        })
    })
  )
)
