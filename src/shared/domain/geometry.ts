import { Schema } from 'effect'

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

export type Point2 = Schema.Schema.Type<typeof Point2>
export type Size2 = Schema.Schema.Type<typeof Size2>
export type Rect = Schema.Schema.Type<typeof Rect>
