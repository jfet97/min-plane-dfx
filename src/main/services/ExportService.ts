import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { encode } from 'iconv-lite'
import type {
  NestingRequest,
  NestingResult,
  ProjectHistoryRef,
  NestingHistoryFramePayload,
  NestingSubRun,
  PreparedPiece
} from '@shared/domain/nesting.js'
import type { CsvRunRecord, ProjectCsvImport } from '@shared/domain/project.js'
import {
  IrregularTransformExport,
  type IrregularExportPlacement,
  type IrregularLayout,
  type IrregularPlacement
} from '@shared/irregular/domain.js'
import { Exit, Schema } from 'effect'
import { NestingRequestStrict, NestingResultStrict } from '@shared/schemas/nestingSchemas.js'
import { NestingHistoryFramePayload as NestingHistoryFramePayloadSchema } from '@shared/domain/nesting.js'

export type EncodedNestingHistoryFramePayload = Schema.Codec.Encoded<
  typeof NestingHistoryFramePayloadSchema
>

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
  frame: NestingHistoryFramePayload
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
  const decodedResult = exit.value
  const irregularExport = hasIrregularLayout(decodedResult)
    ? buildIrregularTransformExport(decodedResult)
    : undefined
  const output =
    irregularExport !== undefined
      ? {
          format: 'min-plane-dfx/nesting-result-with-irregular-transforms',
          version: 1,
          result: decodedResult,
          irregularTransformExport: irregularExport
        }
      : decodedResult
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(output, null, 2), 'utf8')
  return path
}

/** build the truthful JSON representation used for irregular result export. */
export function buildIrregularTransformExport(result: NestingResult): IrregularTransformExport {
  const subRuns = irregularSubRuns(result)
  if (subRuns.length === 0) {
    throw new Error('Irregular result has no transform layout to export.')
  }

  const preparedPieces = result.preparedPieces ?? []
  const document = {
    format: 'min-plane-dfx/irregular-transform-export' as const,
    version: 1 as const,
    jobId: result.jobId,
    runId: result.runSummary?.runId ?? result.jobId,
    subRuns: subRuns.map((subRun) => ({
      subRunId: subRun.subRunId,
      parentRunId: subRun.parentRunId,
      index: subRun.index,
      ...(subRun.sheet !== undefined ? { sheet: subRun.sheet } : {}),
      placements: subRun.layout.placements.map((placement) =>
        exportPlacement(placement, preparedPieces)
      ),
      unplacedPieceIds: [...subRun.layout.unplacedPieceIds]
    }))
  }
  const decoded = Schema.decodeUnknownExit(IrregularTransformExport)(document)
  if (Exit.isFailure(decoded)) {
    throw new Error('Irregular transform export failed schema validation')
  }
  return decoded.value
}

function hasIrregularLayout(result: NestingResult): boolean {
  return Boolean(
    result.layout?.kind === 'irregular' ||
      result.strategyResults.some((strategy) => strategy.layout?.kind === 'irregular') ||
      result.runSummary?.subRuns.some((subRun) => subRun.layout?.kind === 'irregular')
  )
}

function irregularSubRuns(
  result: NestingResult
): ReadonlyArray<{
  readonly subRunId: string
  readonly parentRunId: string
  readonly index: number
  readonly sheet?: NestingSubRun['sheet']
  readonly layout: IrregularLayout
}> {
  const summarySubRuns = result.runSummary?.subRuns
    .filter((subRun) => subRun.layout?.kind === 'irregular')
    .map((subRun) => ({
      subRunId: subRun.subRunId,
      parentRunId: subRun.parentRunId,
      index: subRun.index,
      sheet: subRun.sheet,
      layout: subRun.layout as IrregularLayout
    }))
  if (summarySubRuns !== undefined && summarySubRuns.length > 0) return summarySubRuns

  if (result.layout?.kind === 'irregular') {
    return [
      {
        subRunId: result.selectedStrategyRunId ?? result.jobId,
        parentRunId: result.jobId,
        index: 0,
        layout: result.layout
      }
    ]
  }

  return result.strategyResults.flatMap((strategy) =>
    strategy.layout?.kind === 'irregular'
      ? [
          {
            subRunId: strategy.strategyRunId,
            parentRunId: result.jobId,
            index: 0,
            layout: strategy.layout
          }
        ]
      : []
  )
}

function exportPlacement(
  placement: IrregularPlacement,
  preparedPieces: ReadonlyArray<PreparedPiece>
): IrregularExportPlacement {
  const pieceId = placement.pieceId ?? placement.sourcePieceId
  const prepared = preparedPieces.find(
    (candidate) =>
      candidate.id === pieceId ||
      candidate.id === placement.sourcePieceId ||
      candidate.sourcePieceId === placement.sourcePieceId
  )
  return {
    pieceId,
    sourcePieceId: placement.sourcePieceId,
    ...(placement.placementReference !== undefined
      ? {
          placementReference: {
            x: placement.placementReference.x,
            y: placement.placementReference.y
          }
        }
      : {}),
    transform: {
      translateX: placement.transform.translateX,
      translateY: placement.transform.translateY,
      rotationDeg: placement.transform.rotationDeg,
      mirrored: placement.transform.mirrored
    },
    ...(prepared?.cutRowRef !== undefined
      ? {
          sourceRow: {
            reference: prepared.cutRowRef.reference,
            customerName: prepared.cutRowRef.customerName,
            csvRowId: prepared.cutRowRef.csvRowId
          }
        }
      : {})
  }
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

  if (
    csvRunRecord.subRuns.some(
      (subrun) =>
        subrun.layout?.kind === 'irregular' ||
        subrun.options.workerMode === 'irregular-convex-v2'
    )
  ) {
    throw new Error(
      'CSV export cannot represent irregular transforms; export the Nesting Result JSON instead.'
    )
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
  frames: ReadonlyArray<NestingHistoryFramePayload>
): Promise<string> {
  // Validate each frame via its schema before serializing.
  for (const frame of frames) {
    const exit = Schema.decodeUnknownExit(NestingHistoryFramePayloadSchema)(frame)
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
): Promise<ReadonlyArray<EncodedNestingHistoryFramePayload>> {
  const text = await readFile(ref.path, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line)
        const decoded = Schema.decodeUnknownExit(NestingHistoryFramePayloadSchema)(parsed)
        if (Exit.isFailure(decoded)) return []
        const encoded = Schema.encodeUnknownExit(NestingHistoryFramePayloadSchema)(decoded.value)
        return Exit.isFailure(encoded) ? [] : [encoded.value]
      } catch {
        return []
      }
    })
}
