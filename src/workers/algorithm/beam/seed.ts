import { FreeRectangle, PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import { makeBottomLeftPlacement } from '../maxRects/placements.js'
import { FreeRectangles } from '../maxRects/freeRectangles.js'
import { NestingBeamState, type NestingAlgorithmState } from './state.js'

function emptyBeamState(sheet: SheetSpec, pieces: ReadonlyArray<PreparedPiece>): NestingBeamState {
  return new NestingBeamState({
    placements: [],
    freeRectangles: [
      new FreeRectangle({
        width: sheet.width,
        height: sheet.height,
        x: 0,
        y: 0
      })
    ],
    remainingPieces: pieces,
    unplacedPieces: []
  })
}

function placedInitialBeamState(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly selectedPieceIndex: number
  readonly rotated: boolean
}): NestingBeamState {
  const unchanged = emptyBeamState(input.sheet, input.pieces)
  const piece = input.pieces[input.selectedPieceIndex]
  if (piece === undefined) return unchanged
  // filtering preserves input order: if piece 1 is seeded first, piece 0 becomes next
  const remainingPieces = input.pieces.filter((_, index) => index !== input.selectedPieceIndex)

  const freeRectangle = unchanged.freeRectangles[0]
  if (freeRectangle === undefined) {
    return new NestingBeamState({
      placements: unchanged.placements,
      freeRectangles: unchanged.freeRectangles,
      remainingPieces,
      unplacedPieces: [piece]
    })
  }

  const placement = makeBottomLeftPlacement(freeRectangle, piece, input.rotated)
  // failed seed attempts are retained, but the selected piece leaves the future queue
  if (!FreeRectangles.doesPlacementFit(freeRectangle, placement)) {
    return new NestingBeamState({
      placements: unchanged.placements,
      freeRectangles: unchanged.freeRectangles,
      remainingPieces,
      unplacedPieces: [piece]
    })
  }

  const freeRectangles = FreeRectangles.split(freeRectangle, placement)

  return new NestingBeamState({
    placements: [placement],
    freeRectangles,
    remainingPieces,
    unplacedPieces: []
  })
}

/**
 * Builds the seed beam.
 * It tries the first two pieces as the first placement, both unrotated and
 * rotated, then keeps those states as the initial retained beam.
 */
export function initialState(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly beamWidth: number
}): NestingAlgorithmState {
  // try a small seed fanout: first piece first, second piece first, both orientations
  const states = input.pieces
    .slice(0, 2)
    .flatMap((_, selectedPieceIndex) => [
      placedInitialBeamState({ ...input, selectedPieceIndex, rotated: false }),
      placedInitialBeamState({ ...input, selectedPieceIndex, rotated: true })
    ])
    .slice(0, input.beamWidth)

  const top = states[0]
  if (top === undefined) {
    // it means input.pieces was empty
    return {
      top: emptyBeamState(input.sheet, input.pieces),
      alternatives: []
    }
  }

  return {
    top,
    alternatives: states.slice(1)
  }
}
