import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { encode } from 'iconv-lite'
import type {
  NestingRequest,
  NestingResult,
  ProjectHistoryRef,
  NestingHistoryFrame
} from '@shared/domain/nesting.js'
import type { CsvRunRecord, ProjectCsvImport } from '@shared/domain/project.js'
import { Exit, Schema } from 'effect'
import { NestingRequestStrict, NestingResultStrict } from '@shared/schemas/nestingSchemas.js'
import { NestingHistoryFrame as NestingHistoryFrameSchema } from '@shared/domain/nesting.js'

export type EncodedNestingHistoryFrame = Schema.Codec.Encoded<typeof NestingHistoryFrameSchema>

/** Characters that would break the semicolon-separated CSV format. */
const CSV_DELIMITER_CHARS = /[;\r\n]/g

/** Characters that are not safe in a file name. */
const FILE_NAME_UNSAFE_CHARS = /[^a-zA-Z0-9_.-]/g

/** Collapse runs of whitespace before converting them to underscores. */
const WHITESPACE_RUNS = /\s+/g

function sanitizeCsvField(value: string): string {
  return value.replace(CSV_DELIMITER_CHARS, '').trim()
}

function splitReference(reference: string): { packslipNo: string; position: string } {
  const lastUnderscore = reference.lastIndexOf('_')
  if (lastUnderscore < 0) {
    return { packslipNo: reference, position: '' }
  }
  return {
    packslipNo: reference.slice(0, lastUnderscore),
    position: reference.slice(lastUnderscore + 1)
  }
}

/**
 * Build the default file name for a CSV result export.
 *
 * Format: `<jobDate>_<materialDescription sanitized>.csv`
 * Spaces become underscores; illegal file name characters are removed.
 */
export function buildCsvExportFileName(
  jobDate: string | undefined,
  materialDescription: string
): string {
  const datePart = jobDate ? `${jobDate}_` : ''
  const sanitizedMaterial = materialDescription
    .replace(WHITESPACE_RUNS, '_')
    .replace(FILE_NAME_UNSAFE_CHARS, '')
  return `${datePart}${sanitizedMaterial}.csv`
}

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
/**
 * Write a CSV run record to the ABAS/CAMQUIX output format.
 *
 * Emits one MATERIAL line, then for each subrun one PLATTENMASS line followed
 * by one AUFTRAG line per distinct (reference, customerName) placed on that
 * subrun. Amounts are aggregated by pieceId and then by (reference,
 * customerName). Output is Windows-1252 encoded with CRLF line endings.
 */
export async function exportCsvResultToFile(
  outPath: string,
  csvImport: ProjectCsvImport,
  csvRunRecord: CsvRunRecord
): Promise<string> {
  if (csvRunRecord.subRuns.length === 0) {
    throw new Error('CSV run record has no subruns; nothing to export.')
  }

  const lines: string[] = []
  lines.push(`MATERIAL;${sanitizeCsvField(csvImport.materialCode)};`)

  for (const subrun of csvRunRecord.subRuns) {
    lines.push(`PLATTENMASS;${subrun.sheet.width};${subrun.sheet.height}`)

    const amountByPieceId = new Map<string, number>()
    for (const placement of subrun.placements) {
      amountByPieceId.set(placement.pieceId, (amountByPieceId.get(placement.pieceId) ?? 0) + 1)
    }

    const amountByRef = new Map<
      string,
      { readonly reference: string; readonly customerName: string; amount: number }
    >()
    for (const [pieceId, amount] of amountByPieceId.entries()) {
      const prepared = csvRunRecord.preparedPieces.find((p) => p.id === pieceId)
      if (!prepared) {
        throw new Error(
          `CSV export failed: placement references unknown piece id ${pieceId} (missing from preparedPieces).`
        )
      }
      if (!prepared.cutRowRef) {
        throw new Error(`CSV export failed: piece ${pieceId} has no cutRowRef.`)
      }
      const reference = prepared.cutRowRef.reference
      const customerName = prepared.cutRowRef.customerName
      const key = `${reference}\x00${customerName}`
      const existing = amountByRef.get(key)
      if (existing) {
        existing.amount += amount
      } else {
        amountByRef.set(key, { reference, customerName, amount })
      }
    }

    for (const group of amountByRef.values()) {
      const { packslipNo, position } = splitReference(sanitizeCsvField(group.reference))
      const customerName = sanitizeCsvField(group.customerName)
      lines.push(`AUFTRAG;${packslipNo};${position};${customerName};${group.amount}`)
    }
  }

  const utf8Body = lines.join('\r\n') + '\r\n'
  const buffer = encode(utf8Body, 'win1252')
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, buffer)
  return outPath
}

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
