import { Effect, Layer } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { IrregularPreparedPiece } from '@shared/irregular/domain.js'
import { PriorityOrderService } from '../../irregular/services.js'

/** Preserves the user-owned prepared-piece priority order for the irregular decoder. */
export const PriorityOrderServiceLive = Layer.succeed(PriorityOrderService, {
  buildPriorityOrder: (input) => Effect.succeed(input.pieces.map(preparedPieceId))
})

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}
