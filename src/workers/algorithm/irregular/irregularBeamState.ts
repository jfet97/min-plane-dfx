import type { PieceId } from '@shared/domain/ids.js'
import type {
  IrregularPlacedPiece,
  IrregularPreparedPiece
} from '@shared/irregular/domain.js'

/** The algorithm-owned partial irregular layout retained by a beam. */
export class IrregularBeamState {
  /** Prepared pieces that have not yet been attempted by this state. */
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  /** Collision geometries committed to this state, in placement order. */
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  /** Prepared ids consumed without a committed legal placement. */
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  /** Legacy name retained for existing scorer callers. */
  readonly unplacedSourcePieceIds: ReadonlyArray<PieceId>
  /** Prepared ids of committed placements, retained as a deterministic history. */
  readonly placementOrder: ReadonlyArray<PieceId>
  /** Previous state on this branch, retained only while reconstructing winning history. */
  readonly parent: IrregularBeamState | undefined

  constructor(input: {
    readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
    readonly unplacedPieceIds?: ReadonlyArray<PieceId>
    readonly unplacedSourcePieceIds?: ReadonlyArray<PieceId>
    readonly placementOrder: ReadonlyArray<PieceId>
    readonly parent?: IrregularBeamState | undefined
  }) {
    this.remainingPreparedPieces = [...input.remainingPreparedPieces]
    this.placedCollisionGeometries = [...input.placedCollisionGeometries]
    const unplacedPieceIds = input.unplacedPieceIds ?? input.unplacedSourcePieceIds ?? []
    this.unplacedPieceIds = [...unplacedPieceIds]
    this.unplacedSourcePieceIds = [...unplacedPieceIds]
    this.placementOrder = [...input.placementOrder]
    this.parent = input.parent
  }

  /** Creates the empty layout state without inventing any geometry or result. */
  static empty(remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>): IrregularBeamState {
    return new IrregularBeamState({
      remainingPreparedPieces,
      placedCollisionGeometries: [],
      unplacedSourcePieceIds: [],
      placementOrder: []
    })
  }
}
