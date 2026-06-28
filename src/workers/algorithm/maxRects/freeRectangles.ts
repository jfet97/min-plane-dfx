import { FreeRectangle, Placement, PreparedPiece } from '@shared/domain/nesting.js'

export function placementFitsFreeRectangle(
  freeRectangle: FreeRectangle,
  placement: Placement
): boolean {
  return (
    placement.x >= freeRectangle.x &&
    placement.y >= freeRectangle.y &&
    placement.x + placement.width <= freeRectangle.x + freeRectangle.width &&
    placement.y + placement.height <= freeRectangle.y + freeRectangle.height
  )
}

export function pieceFitsFreeRectangle(
  freeRectangle: FreeRectangle,
  piece: PreparedPiece,
  rotated: boolean
): boolean {
  const width = rotated ? piece.paddedBounds.height : piece.paddedBounds.width
  const height = rotated ? piece.paddedBounds.width : piece.paddedBounds.height
  return width <= freeRectangle.width && height <= freeRectangle.height
}

/**
 * Adds a free rectangle unless it is fully contained by an existing one.
 * The free-rectangle set is kept maximal by invariant: new rectangles come
 * from splits, so they can be redundant only by being smaller than an
 * existing rectangle, not by containing one.
 */
export function addFreeRectangle(
  rects: readonly FreeRectangle[],
  newRect: FreeRectangle
): FreeRectangle[] {
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

export function splitFreeRectangle(rect: FreeRectangle, placement: Placement): FreeRectangle[] {
  const rectRight = rect.x + rect.width
  const rectBottom = rect.y + rect.height
  const placementRight = placement.x + placement.width
  const placementBottom = placement.y + placement.height

  // invariant check: the placement must fit inside the free rectangle
  if (!placementFitsFreeRectangle(rect, placement)) {
    throw new Error(
      `Placement for piece ${placement.pieceId} does not fit inside free rectangle ${rect.id}`
    )
  }

  const leftRect =
    placement.x - rect.x > 0
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
  const topRect =
    placement.y - rect.y > 0
      ? new FreeRectangle({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: placement.y - rect.y,
          source: 'split'
        })
      : null
  const bottomRect =
    placementBottom < rectBottom
      ? new FreeRectangle({
          x: rect.x,
          y: placementBottom,
          width: rect.width,
          height: rectBottom - placementBottom,
          source: 'split'
        })
      : null

  return [leftRect, rightRect, topRect, bottomRect].filter((r): r is FreeRectangle => !!r)
}
