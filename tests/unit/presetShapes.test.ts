import { describe, expect, it } from 'vitest'
import { makePresetShapeDocument } from '@shared/presetShapes.js'

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
})
