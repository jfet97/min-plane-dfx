import { Effect } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularNestingSettings,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { GeometryKernel } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  NfpIfpService
} from '../../irregular/services.js'

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
 * Candidate selection uses the lowest `(y, x)` point, followed by the supplied
 * transform metadata. This is only a deterministic baseline; it is not a
 * compactness scorer and must not be treated as the future material-efficiency
 * policy. A valid transformed polygon that cannot fit the sheet yields no
 * candidates, so the decoder tries the next supplied transform before marking
 * the piece unplaced.
 *
 * Transform indexes are normally unique because `TransformGenerator` emits
 * them that way. Comparing index, rotation, mirror, and reason nevertheless
 * makes malformed or replayed input deterministic when indexes tie.
 *
 * @param sheet rectangular sheet on which every collision polygon must fit
 * @param pieces already priority-ordered prepared pieces
 * @param settings geometry and optimizer settings forwarded to candidate generation
 */
export function decodeStrictPriorityOrder(
  sheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  settings: IrregularNestingSettings
): Effect.Effect<
  IrregularStrictPriorityDecodeResult,
  IrregularNestingNotImplementedError | IrregularGeometryInputError,
  GeometryKernel | NfpIfpService
> {
  return Effect.gen(function* () {
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const placements: IrregularPlacement[] = []
    const unplacedPieceIds: PieceId[] = []
    const placed: IrregularPlacedPiece[] = []

    for (const piece of pieces) {
      const candidates: DecoderCandidate[] = []
      const transforms = [...piece.transforms].sort(compareTransformCandidates)

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
          candidates.push({ candidate, moving })
        }
      }

      const selected = selectCandidate(candidates)
      if (selected === undefined) {
        unplacedPieceIds.push(piece.source.id)
        continue
      }

      const placement = new IrregularPlacement({
        sourcePieceId: piece.source.id,
        transform: new IrregularTransform({
          translateX: selected.candidate.point.x,
          translateY: selected.candidate.point.y,
          rotationDeg: selected.candidate.transform.rotationDeg,
          mirrored: selected.candidate.transform.mirrored
        })
      })
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

interface DecoderCandidate {
  readonly candidate: IrregularPlacementCandidate
  readonly moving: TransformedCollisionGeometry
}

function compareTransformCandidates(
  first: IrregularTransformCandidate,
  second: IrregularTransformCandidate
): number {
  if (first.index !== second.index) return first.index - second.index
  if (first.rotationDeg !== second.rotationDeg) return first.rotationDeg - second.rotationDeg
  if (first.mirrored !== second.mirrored) return Number(first.mirrored) - Number(second.mirrored)
  return compareStrings(first.reason, second.reason)
}

function selectCandidate(
  candidates: ReadonlyArray<DecoderCandidate>
): DecoderCandidate | undefined {
  return candidates.reduce<DecoderCandidate | undefined>((selected, candidate) => {
    if (selected === undefined || compareCandidates(candidate, selected) < 0) return candidate
    return selected
  }, undefined)
}

function compareCandidates(first: DecoderCandidate, second: DecoderCandidate): number {
  const pointYComparison = first.candidate.point.y - second.candidate.point.y
  if (pointYComparison !== 0) return pointYComparison

  const pointXComparison = first.candidate.point.x - second.candidate.point.x
  if (pointXComparison !== 0) return pointXComparison

  return compareTransformCandidates(first.candidate.transform, second.candidate.transform)
}

function compareStrings(first: string, second: string): number {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}
