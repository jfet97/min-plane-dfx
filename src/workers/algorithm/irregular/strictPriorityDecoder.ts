import { Effect, Order } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  NfpIfpService
} from '../../irregular/services.js'
import {
  IrregularPlacementScorer,
  IrregularPlacementScoringError,
  IrregularPlacementScore
} from './irregularPlacementScorer.js'

/**
 * The concrete result of the intermediate strict-priority decoder.
 *
 * This is not the future windowed beam or portfolio result. It contains no
 * score, status, history, or diagnostics beyond the placements and source ids
 * needed by the next decoder increment.
 */
export interface IrregularStrictPriorityDecodeResult {
  /** Placements emitted in the supplied priority order for pieces that fit. */
  readonly placements: ReadonlyArray<IrregularPlacement>
  /** Source ids for pieces whose supplied transforms produced no legal candidate. */
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
}

/** Stable transform order used before scoring the legal candidates they produce. */
const transformCandidateOrder = Order.combineAll<IrregularTransformCandidate>([
  Order.mapInput(Order.Number, (transform) => transform.index),
  Order.mapInput(Order.Number, (transform) => transform.rotationDeg),
  Order.mapInput(Order.Boolean, (transform) => transform.mirrored),
  Order.mapInput(Order.String, (transform) => transform.reason)
])

/**
 * Decodes one supplied priority order with deterministic baseline geometry.
 *
 * Its role is to transform a proposed order into one concrete legal layout.
 * It is not an optimizer: it never changes the supplied piece order, invents a
 * rotation, or decides that an illegal point is acceptable. Future beam and
 * portfolio search will call this same logic with different proposed orders
 * and compare the layouts it produces; re-sorting here would hide those
 * optimizer decisions.
 *
 * Strict means that the supplied piece order is preserved. Among the legal
 * candidates produced for each piece, transform and candidate selection uses
 * the explicit balanced compactness policy. A valid transformed polygon that
 * cannot fit the sheet yields no candidates, so the decoder tries the next
 * supplied transform before marking the piece unplaced.
 *
 * Transform indexes are normally unique because `TransformGenerator` emits
 * them that way. Comparing index, rotation, mirror, and reason nevertheless
 * makes malformed or replayed input deterministic when indexes tie.
 *
 * @param sheet rectangular sheet on which every collision polygon must fit
 * @param pieces already priority-ordered prepared pieces
 */
export function decodeStrictPriorityOrder(
  sheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>
): Effect.Effect<
  IrregularStrictPriorityDecodeResult,
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularPlacementScoringError,
  GeometryKernel | GeometrySettings | NfpIfpService | IrregularPlacementScorer
> {
  return Effect.gen(function* () {
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const placementScorer = yield* IrregularPlacementScorer
    const placements: IrregularPlacement[] = []
    const unplacedPieceIds: PieceId[] = []
    const placed: IrregularPlacedPiece[] = []

    for (const piece of pieces) {
      const candidates: DecoderCandidate[] = []
      const transforms = [...piece.transforms].sort(transformCandidateOrder)

      for (const transform of transforms) {
        const moving = yield* geometryKernel.transformCollisionGeometry({
          geometry: piece.collisionGeometry,
          transform
        })
        const legalCandidates = yield* nfpIfpService.generatePlacementCandidates({
          sheet,
          placed,
          moving,
          settings
        })

        for (const candidate of legalCandidates) {
          const score = yield* placementScorer.scoreCandidate({
            sheet,
            placed,
            moving,
            candidate
          })
          candidates.push({ candidate, moving, score })
        }
      }

      const selected = selectCandidate(candidates, placementScorer)
      if (selected === undefined) {
        unplacedPieceIds.push(piece.pieceId ?? piece.source.id)
        continue
      }

      const placement = makePlacement(piece, selected.candidate)
      placements.push(placement)
      placed.push(
        new IrregularPlacedPiece({
          placement,
          collisionGeometry: selected.moving
        })
      )
    }

    return { placements, unplacedPieceIds }
  })
}

function makePlacement(
  piece: IrregularPreparedPiece,
  candidate: IrregularPlacementCandidate
): IrregularPlacement {
  const input = {
    sourcePieceId: piece.source.id,
    placementReference: piece.collisionGeometry.placementReference,
    transform: new IrregularTransform({
      translateX: candidate.point.x,
      translateY: candidate.point.y,
      rotationDeg: candidate.transform.rotationDeg,
      mirrored: candidate.transform.mirrored
    })
  }
  return piece.pieceId === undefined
    ? new IrregularPlacement(input)
    : new IrregularPlacement({ ...input, pieceId: piece.pieceId })
}

interface DecoderCandidate {
  readonly candidate: IrregularPlacementCandidate
  readonly moving: TransformedCollisionGeometry
  readonly score: IrregularPlacementScore
}

function selectCandidate(
  candidates: ReadonlyArray<DecoderCandidate>,
  scorer: IrregularPlacementScorer.Service
): DecoderCandidate | undefined {
  const candidateOrder = Order.combineAll<DecoderCandidate>([
    Order.make((first, second) => scorer.compare(first.score, second.score)),
    Order.mapInput(Order.Number, (candidate) => candidate.candidate.transform.index),
    Order.mapInput(Order.Number, (candidate) => candidate.candidate.point.x),
    Order.mapInput(Order.Number, (candidate) => candidate.candidate.point.y)
  ])
  return candidates.length === 0 ? undefined : candidates.reduce(Order.min(candidateOrder))
}
