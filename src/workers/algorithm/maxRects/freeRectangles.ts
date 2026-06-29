import { FreeRectangle, Placement, PreparedPiece } from '@shared/domain/nesting.js'

function doesPlacementFit(freeRectangle: FreeRectangle, placement: Placement): boolean {
  return (
    placement.x >= freeRectangle.x &&
    placement.y >= freeRectangle.y &&
    placement.x + placement.width <= freeRectangle.x + freeRectangle.width &&
    placement.y + placement.height <= freeRectangle.y + freeRectangle.height
  )
}

function doesPieceFit(
  freeRectangle: FreeRectangle,
  piece: PreparedPiece,
  rotated: boolean
): boolean {
  const width = rotated ? piece.paddedBounds.height : piece.paddedBounds.width
  const height = rotated ? piece.paddedBounds.width : piece.paddedBounds.height
  return width <= freeRectangle.width && height <= freeRectangle.height
}

/**
 * Returns true only when the placement overlaps the free rectangle with
 * positive area. Touching edges are allowed: rectangles use half-open spans
 * `[x, x + width)` and `[y, y + height)`, so adjacent integer-mm rectangles do
 * not steal cells from each other.
 */
function intersects(rect: FreeRectangle, placement: Placement): boolean {
  return (
    placement.x < rect.x + rect.width &&
    placement.x + placement.width > rect.x &&
    placement.y < rect.y + rect.height &&
    placement.y + placement.height > rect.y
  )
}

/**
 * Adds a free rectangle unless it is fully contained by an existing one.
 * The free-rectangle set is kept maximal by invariant: new rectangles come
 * from splits, so they can be redundant only by being smaller than an
 * existing rectangle, not by containing one.
 */
function add(rects: readonly FreeRectangle[], newRect: FreeRectangle): FreeRectangle[] {
  for (const rect of rects) {
    if (
      newRect.x >= rect.x &&
      newRect.x + newRect.width <= rect.x + rect.width &&
      newRect.y >= rect.y &&
      newRect.y + newRect.height <= rect.y + rect.height
    ) {
      return [...rects]
    }
  }

  return [newRect, ...rects]
}

function split(rect: FreeRectangle, placement: Placement): FreeRectangle[] {
  const rectRight = rect.x + rect.width
  const rectTop = rect.y + rect.height
  const placementRight = placement.x + placement.width
  const placementTop = placement.y + placement.height

  // no overlap means this rectangle remains available as-is
  if (!intersects(rect, placement)) {
    return [rect]
  }

  // split along the occupied projection, keeping only positive-area remnants
  const leftRect =
    placement.x > rect.x
      ? new FreeRectangle({
          x: rect.x,
          y: rect.y,
          width: placement.x - rect.x,
          height: rect.height,
          source: 'split'
        })
      : null
  const rightRect =
    placementRight < rectRight
      ? new FreeRectangle({
          x: placementRight,
          y: rect.y,
          width: rectRight - placementRight,
          height: rect.height,
          source: 'split'
        })
      : null
  const lowerRect =
    placement.y > rect.y
      ? new FreeRectangle({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: placement.y - rect.y,
          source: 'split'
        })
      : null
  const upperRect =
    placementTop < rectTop
      ? new FreeRectangle({
          x: rect.x,
          y: placementTop,
          width: rect.width,
          height: rectTop - placementTop,
          source: 'split'
        })
      : null

  return [leftRect, rightRect, lowerRect, upperRect].filter((r): r is FreeRectangle => !!r)
}

export const FreeRectangles = {
  add,
  doesPieceFit,
  doesPlacementFit,
  intersects,
  split
}
