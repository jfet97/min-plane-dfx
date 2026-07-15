import { Data, Effect } from 'effect'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { PieceId } from '@shared/domain/ids.js'
import type { NestingRequest } from '@shared/domain/nesting.js'
import {
  CollisionGeometryDiagnostic,
  IrregularPlacedPiece,
  IrregularPreparedPiece
} from '@shared/irregular/domain.js'
import { CollisionGeometryBuilder } from '../../irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  NfpIfpService,
  TransformGenerator
} from '../../irregular/services.js'
import { sortPiecesForNesting } from '../sortPiecesForNesting.js'
import {
  IrregularLayoutScore,
  IrregularLayoutScoringError,
  IrregularLayoutScorer
} from './irregularLayoutScorer.js'
import {
  IrregularPlacementScorer,
  IrregularPlacementScoringError
} from './irregularPlacementScorer.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  decodeWindowedIrregularBeam,
  IrregularWindowedBeamError
} from './windowedBeam.js'

/** Reports that a prepared piece has no imported geometry available to the worker. */
export class IrregularComputeError extends Data.TaggedError('IrregularComputeError')<{
  readonly preparedPieceId: PieceId
  readonly sourcePieceId: PieceId
  readonly message: string
}> {}

/** One real beam state emitted by the irregular decoder. */
export interface IrregularStateSnapshot {
  readonly stepIndex: number
  readonly beamRank: number
  readonly candidateCount: number
  readonly state: IrregularBeamState
}

/** Synchronous worker-facing notification for one selected real beam state. */
export interface ComputeIrregularNestingOptions {
  readonly emitStateSnapshot?: (snapshot: IrregularStateSnapshot, beamWidth: number) => void
}

/** Plain algorithm output before any worker protocol or history DTO adaptation. */
export interface IrregularComputeResult {
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly score: IrregularLayoutScore
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
  readonly sortedPieceIds: ReadonlyArray<PieceId>
  readonly stateSnapshots: ReadonlyArray<IrregularStateSnapshot>
  readonly beamWidth: number
}

export type IrregularComputeErrorType =
  | IrregularComputeError
  | IrregularGeometryInputError
  | IrregularNestingNotImplementedError
  | IrregularWindowedBeamError
  | IrregularPlacementScoringError
  | IrregularLayoutScoringError

export function computeIrregularNesting(
  request: NestingRequest,
  options?: ComputeIrregularNestingOptions
): Effect.Effect<
  IrregularComputeResult,
  IrregularComputeErrorType,
  | GeometrySettings
  | GeometryKernel
  | CollisionGeometryBuilder
  | TransformGenerator
  | NfpIfpService
  | IrregularPlacementScorer
  | IrregularLayoutScorer
> {
  return Effect.gen(function* () {
    const settings = yield* GeometrySettings
    const sortedPieces = sortPiecesForNesting(request.pieces)
    const sourcePieces = request.sourcePieces ?? []
    const preparedPieces: IrregularPreparedPiece[] = []
    const diagnostics: CollisionGeometryDiagnostic[] = []
    const geometryBuilder = yield* CollisionGeometryBuilder
    const transformGenerator = yield* TransformGenerator
    const layoutScorer = yield* IrregularLayoutScorer

    for (const prepared of sortedPieces) {
      const source = findSourcePiece(prepared.sourcePieceId, prepared.id, sourcePieces)
      if (source === undefined) {
        return yield* Effect.fail(
          new IrregularComputeError({
            preparedPieceId: prepared.id,
            sourcePieceId: prepared.sourcePieceId,
            message: `No imported source geometry was found for prepared piece ${prepared.id}.`
          })
        )
      }

      const collisionGeometry = yield* geometryBuilder.buildPiece({
        piece: source,
        totalPaddingMm: request.padding
      })
      const allowRotation = request.options.allowGlobalRotation && prepared.allowRotation
      const transforms = yield* transformGenerator.generateTransforms({
        geometry: collisionGeometry,
        allowRotation,
        allowMirror: true,
        settings: settings.optimizer
      })
      preparedPieces.push(
        new IrregularPreparedPiece({
          pieceId: prepared.id,
          source,
          allowMirror: true,
          collisionGeometry,
          transforms
        })
      )
      diagnostics.push(...collisionGeometry.diagnostics)
    }

    const stateSnapshots: IrregularStateSnapshot[] = []
    const captureStateSnapshot = (snapshot: IrregularStateSnapshot): void => {
      stateSnapshots.push(snapshot)
      options?.emitStateSnapshot?.(snapshot, settings.optimizer.beamWidth)
    }
    const beam = yield* decodeWindowedIrregularBeam(
      request.sheet,
      preparedPieces,
      {
        onInitialState: (state) => {
          captureStateSnapshot({
            stepIndex: 0,
            beamRank: 0,
            candidateCount: 0,
            state
          })
        },
        onStateSelected: (snapshot) => {
          captureStateSnapshot({ ...snapshot, stepIndex: snapshot.stepIndex + 1 })
        }
      }
    )
    const score = yield* layoutScorer.scoreState({
      sheet: request.sheet,
      state: beam.bestState
    })
    diagnostics.push(...score.freeMaterialSnapshot.diagnostics)
    return {
      placedCollisionGeometries: beam.bestState.placedCollisionGeometries,
      score,
      unplacedPieceIds: beam.bestState.unplacedPieceIds,
      diagnostics,
      sortedPieceIds: sortedPieces.map((piece) => piece.id),
      stateSnapshots,
      beamWidth: settings.optimizer.beamWidth
    }
  })
}

function findSourcePiece(
  sourcePieceId: PieceId,
  preparedPieceId: PieceId,
  sourcePieces: ReadonlyArray<ImportedPiece>
): ImportedPiece | undefined {
  const direct = sourcePieces.find(
    (source) => source.id === sourcePieceId || source.id === preparedPieceId
  )
  if (direct !== undefined) return direct

  const baseId = sourcePieceId.replace(/-copy-\d+$/, '')
  const preparedBaseId = preparedPieceId.replace(/-copy-\d+$/, '')
  const base = sourcePieces.find(
    (source) => source.id === baseId || source.id === preparedBaseId
  )
  return base
}
