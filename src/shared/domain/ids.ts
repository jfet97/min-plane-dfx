import { Schema } from 'effect'

/**
 * Brand symbols for nominal typing on string/number primitives that must not
 * be confused with each other across IPC and worker boundaries.
 */
export type PieceIdBrand = string & { readonly __pieceId: unique symbol }
export type SourceFileIdBrand = string & { readonly __sourceFileId: unique symbol }
export type JobIdBrand = string & { readonly __jobId: unique symbol }
export type FreeRectIdBrand = string & { readonly __freeRectId: unique symbol }

const PieceBrand = Schema.brand('PieceId')
const SourceFileBrand = Schema.brand('SourceFileId')
const JobBrand = Schema.brand('JobId')
const FreeRectBrand = Schema.brand('FreeRectId')

export const PieceId = PieceBrand(Schema.String)
export const SourceFileId = SourceFileBrand(Schema.String)
export const JobId = JobBrand(Schema.String)
export const FreeRectId = FreeRectBrand(Schema.String)

export type PieceId = Schema.Schema.Type<typeof PieceId>
export type SourceFileId = Schema.Schema.Type<typeof SourceFileId>
export type JobId = Schema.Schema.Type<typeof JobId>
export type FreeRectId = Schema.Schema.Type<typeof FreeRectId>
