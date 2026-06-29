import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  NestingRequest,
  NestingResult,
  ProjectHistoryRef,
  NestingHistoryFrame
} from '@shared/domain/nesting.js'
import { Exit, Schema } from 'effect'
import { NestingRequestStrict, NestingResultStrict } from '@shared/schemas/nestingSchemas.js'
import { NestingHistoryFrame as NestingHistoryFrameSchema } from '@shared/domain/nesting.js'

export type EncodedNestingHistoryFrame = Schema.Codec.Encoded<typeof NestingHistoryFrameSchema>

/**
 * Append a history frame to the optional NDJSON replay file referenced by
 * ProjectHistoryRef. Each line is a JSON object (one per frame) so the
 * replay can be loaded later without parsing the full object.
 */
export async function appendHistoryFrame(
  ref: ProjectHistoryRef,
  frame: NestingHistoryFrame
): Promise<void> {
  await mkdir(dirname(ref.path), { recursive: true })
  await writeFile(ref.path, `${JSON.stringify(frame)}\n`, { flag: 'a', encoding: 'utf8' })
}

/**
 * Write a NestingRequest or NestingResult to a file as pretty JSON.
 * Returns the path written. Throws on schema validation failure.
 */
export async function exportNestingRequestToFile(
  path: string,
  request: NestingRequest
): Promise<string> {
  const exit = Schema.decodeUnknownExit(NestingRequestStrict)(request)
  if (Exit.isFailure(exit)) {
    throw new Error('NestingRequest failed schema validation')
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(request, null, 2), 'utf8')
  return path
}

export async function exportNestingResultToFile(
  path: string,
  result: NestingResult
): Promise<string> {
  const exit = Schema.decodeUnknownExit(NestingResultStrict)(result)
  if (Exit.isFailure(exit)) {
    throw new Error('NestingResult failed schema validation')
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(result, null, 2), 'utf8')
  return path
}

/**
 * Validate and write a history NDJSON replay file from an in-memory frame
 * list. Each frame becomes one NDJSON line. Use this when the renderer has
 * the frames in memory and wants a single dump (e.g. on save).
 */
export async function exportHistoryToFile(
  path: string,
  frames: ReadonlyArray<NestingHistoryFrame>
): Promise<string> {
  // Validate each frame via its schema before serializing.
  for (const frame of frames) {
    const exit = Schema.decodeUnknownExit(NestingHistoryFrameSchema)(frame)
    if (Exit.isFailure(exit)) {
      throw new Error('History frame failed schema validation')
    }
  }
  await mkdir(dirname(path), { recursive: true })
  const body = frames.map((f) => JSON.stringify(f)).join('\n')
  await writeFile(path, body.length > 0 ? `${body}\n` : '', 'utf8')
  return path
}

/**
 * Load a worker-written NDJSON history replay and return schema-encoded
 * objects that are safe to send through Electron IPC.
 */
export async function loadHistoryReplayFromFile(
  ref: ProjectHistoryRef
): Promise<ReadonlyArray<EncodedNestingHistoryFrame>> {
  const text = await readFile(ref.path, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line)
        const decoded = Schema.decodeUnknownExit(NestingHistoryFrameSchema)(parsed)
        if (Exit.isFailure(decoded)) return []
        return [parsed as EncodedNestingHistoryFrame]
      } catch {
        return []
      }
    })
}
