import { Effect, Schema } from 'effect'

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

type GeneratedIdBase = Schema.Codec<string, string, never, never> & Schema.WithoutConstructorDefault

type GeneratedIdSchema<S extends GeneratedIdBase> = S & {
  make(): S['Type']
  make(input: string): S['Type']
  readonly withConstructorDefault: Schema.withConstructorDefault<S>
  readonly withDefault: Schema.withConstructorDefault<S>
}

function newId(): string {
  const globalCrypto = globalThis as { crypto?: { randomUUID?: () => string } }
  if (typeof globalCrypto.crypto?.randomUUID === 'function') {
    return globalCrypto.crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function withGeneratedId<S extends GeneratedIdBase>(schema: S): GeneratedIdSchema<S> {
  function make(): S['Type']
  function make(input: string): S['Type']
  function make(input?: string): S['Type'] {
    if (input !== undefined) return Schema.decodeSync(schema)(input)
    return newId() as S['Type']
  }

  const withConstructorDefault = schema.pipe(Schema.withConstructorDefault(Effect.sync(make)))
  return Object.assign(schema, {
    make,
    withConstructorDefault,
    withDefault: withConstructorDefault
  })
}

export const PieceId = withGeneratedId(PieceBrand(Schema.String))
export const SourceFileId = withGeneratedId(SourceFileBrand(Schema.String))
export const JobId = withGeneratedId(JobBrand(Schema.String))
export const FreeRectId = withGeneratedId(FreeRectBrand(Schema.String))

export type PieceId = Schema.Schema.Type<typeof PieceId>
export type SourceFileId = Schema.Schema.Type<typeof SourceFileId>
export type JobId = Schema.Schema.Type<typeof JobId>
export type FreeRectId = Schema.Schema.Type<typeof FreeRectId>
