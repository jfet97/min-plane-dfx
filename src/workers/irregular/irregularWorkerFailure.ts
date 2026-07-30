import { WorkerResponseFailureError } from '@shared/protocol/worker.js'
import type { IrregularComputeErrorType } from '../algorithm/irregular/computeIrregularNesting.js'

export function toIrregularWorkerFailure(
  error: IrregularComputeErrorType
): WorkerResponseFailureError {
  switch (error._tag) {
    case 'IrregularComputeError':
      return new WorkerResponseFailureError({
        code: 'irregular_source_geometry_missing',
        message: error.message,
        context: {
          preparedPieceId: error.preparedPieceId,
          sourcePieceId: error.sourcePieceId
        }
      })
    case 'IrregularGeometryInputError':
      return new WorkerResponseFailureError({
        code: 'irregular_geometry_invalid',
        message: error.message,
        context: { operation: error.operation }
      })
    case 'IrregularNestingNotImplementedError':
      return new WorkerResponseFailureError({
        code: 'not_implemented',
        message: error.message,
        context: { service: error.service, operation: error.operation }
      })
    case 'IrregularPlacementScoringError':
    case 'IrregularLayoutScoringError':
      return new WorkerResponseFailureError({
        code: 'irregular_scoring_error',
        message: error.message,
        context: { operation: error.operation }
      })
    case 'IrregularPortfolioError':
      return new WorkerResponseFailureError({
        code:
          error.category === 'geometry' ? 'irregular_geometry_invalid' : 'irregular_scoring_error',
        message: error.message,
        context: { operation: error.operation, category: error.category }
      })
    case 'IrregularNoValidResultError':
      return new WorkerResponseFailureError({
        code: 'irregular_no_valid_result',
        message: error.message,
        context: { operation: error.operation }
      })
    case 'IrregularNfpIfpControlAbortError':
      return new WorkerResponseFailureError({
        code: error.reason === 'cancelled' ? 'worker_cancelled' : 'worker_timeout',
        message: error.message,
        context: { reason: error.reason }
      })
  }
}
