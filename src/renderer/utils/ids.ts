import type { FreeRectId, JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'

declare const crypto: {
  readonly randomUUID?: () => string
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Deterministic fallback for environments without crypto.randomUUID
  // (older test environments, SSR fallbacks). Not cryptographic but unique
  // enough for short-lived ids inside a single app instance.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function newJobId(): JobId {
  return newId() as JobId
}

export function newPieceId(): PieceId {
  return newId() as PieceId
}

export function newSourceFileId(): SourceFileId {
  return newId() as SourceFileId
}

export function newFreeRectId(): FreeRectId {
  return newId() as FreeRectId
}
