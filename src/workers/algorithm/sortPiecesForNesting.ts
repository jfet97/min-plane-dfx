import type { PreparedPiece } from '@shared/domain/nesting.js'
import { Order } from 'effect'

// combineAll keeps the "and then" chain explicit: longestEdge, then area, then imbalance.
// flip makes each numeric comparison descending, so larger candidates sort first.
const paddedBoundsOrder = Order.combineAll<PreparedPiece['paddedBounds']>([
  Order.mapInput(Order.flip(Order.Number), (piece) => piece.longestEdge),
  Order.mapInput(Order.flip(Order.Number), (piece) => piece.area),
  Order.mapInput(Order.flip(Order.Number), (piece) => piece.imbalance)
])

const order = Order.mapInput(paddedBoundsOrder, (piece: PreparedPiece) => piece.paddedBounds)


export function sortPiecesForNesting(
  pieces: ReadonlyArray<PreparedPiece>
): ReadonlyArray<PreparedPiece> {
  return pieces.toSorted(order)
}
