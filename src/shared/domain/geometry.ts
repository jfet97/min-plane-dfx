import { Schema, SchemaTransformation } from 'effect'

/** All internal measurements are millimeters. */
export type Millimeters = number

export const Millimeters = Schema.Number

export const Point2 = Schema.Struct({
  x: Millimeters,
  y: Millimeters
})

export const Size2 = Schema.Struct({
  width: Millimeters,
  height: Millimeters
})

export const Rect = Schema.Struct({
  x: Millimeters,
  y: Millimeters,
  width: Millimeters,
  height: Millimeters
})

export const RectWith = Schema.Struct({
  ...Rect.fields,
  longestEdge: Millimeters,
  area: Schema.Number,
  imbalance: Millimeters
})

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

export type Point2 = Schema.Schema.Type<typeof Point2>
export type Size2 = Schema.Schema.Type<typeof Size2>
export type Rect = Schema.Schema.Type<typeof Rect>
export type RectWith = Schema.Schema.Type<typeof RectWith>
