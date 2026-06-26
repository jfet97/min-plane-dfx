import { Schema } from 'effect'
import { Rect, Size2, Point2 } from '../domain/geometry.js'

export const RectSchema = Rect
export const Size2Schema = Size2
export const Point2Schema = Point2

export const PositiveWidth = Schema.Number.check(Schema.isGreaterThan(0))
export const PositiveHeight = Schema.Number.check(Schema.isGreaterThan(0))
export const NonNegativePadding = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
