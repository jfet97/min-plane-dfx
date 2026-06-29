import { describe, expect, it } from 'vitest'
import { makePresetShapeDocument } from '@shared/presetShapes.js'
import type { DxfGeometrySummary } from '@shared/domain/dxf.js'

function segmentBounds(segments: DxfGeometrySummary['segments']): {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const segment of segments) {
    minX = Math.min(minX, segment.x1, segment.x2)
    minY = Math.min(minY, segment.y1, segment.y2)
    maxX = Math.max(maxX, segment.x1, segment.x2)
    maxY = Math.max(maxY, segment.y1, segment.y2)
  }
  return { minX, minY, maxX, maxY }
}

describe('makePresetShapeDocument', () => {
  it('creates a preset document with integer source bounds', () => {
    const document = makePresetShapeDocument({
      kind: 'rectangle',
      width: 120.4,
      height: 80.5,
      label: 'panel'
    })
    const piece = document.pieces[0]

    expect(document.path).toMatch(/^preset:\/\//)
    expect(piece?.label).toBe('panel')
    expect(piece?.realBounds).toMatchObject({ x: 0, y: 0, width: 120, height: 81 })
    expect(piece?.geometry.segments).toHaveLength(4)
  })

  it('represents circles as circle source geometry with one diameter', () => {
    const document = makePresetShapeDocument({
      kind: 'circle',
      width: 50,
      height: 20,
      label: 'washer'
    })
    const piece = document.pieces[0]

    expect(piece?.realBounds.width).toBe(50)
    expect(piece?.realBounds.height).toBe(50)
    expect(piece?.geometry.entityType).toBe('CIRCLE')
    expect(piece?.geometry.segments).toEqual([])
  })

  it('builds polygon outlines for regular presets', () => {
    const document = makePresetShapeDocument({
      kind: 'hexagon',
      width: 60,
      height: 60,
      label: ''
    })
    const piece = document.pieces[0]

    expect(piece?.label).toBe('hexagon')
    expect(piece?.geometry.segments).toHaveLength(6)
  })

  it('uses top width for trapezoid outlines', () => {
    const document = makePresetShapeDocument({
      kind: 'trapezoid',
      width: 100,
      height: 50,
      topWidth: 40,
      label: 'trap'
    })
    const piece = document.pieces[0]
    const first = piece?.geometry.segments[0]

    expect(piece?.realBounds).toMatchObject({ x: 0, y: 0, width: 100, height: 50 })
    expect(piece?.geometry.segments).toHaveLength(4)
    expect(first).toMatchObject({ x1: 30, y1: 0, x2: 70, y2: 0 })
  })

  it('fits star outlines tightly inside the requested bounds', () => {
    const document = makePresetShapeDocument({
      kind: 'star',
      width: 120,
      height: 80,
      label: 'star'
    })
    const piece = document.pieces[0]
    const bounds = segmentBounds(piece?.geometry.segments ?? [])

    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 120, maxY: 80 })
  })
})
