import type { PreparedPiece } from '@shared/domain/nesting.js'

/**
 * The identity sort. Returns the input unchanged so that:
 *   - the worker has a stable, real function behind the sort boundary
 *   - sorting can be swapped for a real strategy without touching callers
 *   - tests can prove input order is preserved
 *
 * This function is deliberately a no-op. It does not place pieces, score them,
 * or pick a winning run. Any future algorithm will replace this body only.
 */
export function sortPiecesForNesting(
  pieces: ReadonlyArray<PreparedPiece>
): ReadonlyArray<PreparedPiece> {
  return pieces
}