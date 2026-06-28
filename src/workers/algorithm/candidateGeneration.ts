import { FreeRectangle, Placement, PreparedPiece } from '@shared/domain/nesting.js'

function placementSize(piece: PreparedPiece, rotated: boolean) {
  return {
    width: rotated ? piece.paddedBounds.height : piece.paddedBounds.width,
    height: rotated ? piece.paddedBounds.width : piece.paddedBounds.height,
    rotation: rotated ? 90 : 0
  } as const
}

/**
 * Builds the current bottom-left candidate placement for a piece inside a
 * chosen free rectangle.
 */
export function makeBottomLeftPlacement(
  freeRectangle: FreeRectangle,
  piece: PreparedPiece,
  rotated: boolean
): Placement {
  const size = placementSize(piece, rotated)
  return new Placement({
    pieceId: piece.id,
    x: freeRectangle.x,
    y: freeRectangle.y,
    ...size
  })
}

/**
 * Builds a top-left candidate placement for a piece inside a chosen free
 * rectangle.
 */
export function makeTopLeftPlacement(
  freeRectangle: FreeRectangle,
  piece: PreparedPiece,
  rotated: boolean
): Placement {
  const size = placementSize(piece, rotated)
  return new Placement({
    pieceId: piece.id,
    x: freeRectangle.x,
    y: freeRectangle.y + freeRectangle.height - size.height,
    ...size
  })
}
