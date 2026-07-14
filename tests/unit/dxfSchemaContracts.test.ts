import { Exit, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfArcSegment, DxfEllipseSource, DxfLineSegment } from '@shared/domain/dxf.js'

/** Decodes unknown DXF data through the same schemas used at import boundaries. */
function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) {
  return Schema.decodeUnknownExit(schema)(input)
}

describe('DXF geometry schema contracts', () => {
  it('requires finite line coordinates and bulges', () => {
    const line = { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0, bulge: 0.5 }

    expect(Exit.isSuccess(decode(DxfLineSegment, line))).toBe(true)
    expect(Exit.isFailure(decode(DxfLineSegment, { ...line, bulge: Number.NaN }))).toBe(true)
    expect(Exit.isFailure(decode(DxfLineSegment, { ...line, x2: Number.POSITIVE_INFINITY }))).toBe(true)
  })

  it('requires finite arc data with a positive radius', () => {
    const arc = {
      kind: 'arc',
      x1: 10,
      y1: 0,
      x2: 0,
      y2: 10,
      cx: 0,
      cy: 0,
      radius: 10,
      startAngle: 0,
      endAngle: 90
    }

    expect(Exit.isSuccess(decode(DxfArcSegment, arc))).toBe(true)
    expect(Exit.isFailure(decode(DxfArcSegment, { ...arc, radius: 0 }))).toBe(true)
    expect(Exit.isFailure(decode(DxfArcSegment, { ...arc, endAngle: Number.NEGATIVE_INFINITY }))).toBe(true)
  })

  it('requires a non-degenerate analytic ellipse source', () => {
    const ellipse = {
      kind: 'ellipse',
      sourceId: 'ellipse-1',
      cx: 0,
      cy: 0,
      majorAxisX: 10,
      majorAxisY: 0,
      axisRatio: 0.5,
      startAngle: 0,
      endAngle: Math.PI * 2
    }

    expect(Exit.isSuccess(decode(DxfEllipseSource, ellipse))).toBe(true)
    expect(
      Exit.isFailure(
        decode(DxfEllipseSource, { ...ellipse, majorAxisX: 0, majorAxisY: 0 })
      )
    ).toBe(true)
    expect(Exit.isFailure(decode(DxfEllipseSource, { ...ellipse, axisRatio: 0 }))).toBe(true)
  })
})
