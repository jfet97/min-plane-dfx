import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { decode } from 'iconv-lite'
import { ProjectCsvImport, CsvCutRow, ProjectRunConfiguration } from '@shared/domain/project.js'
import { NestingOptions, SheetSpec } from '@shared/domain/nesting.js'
import { SourceFileId } from '@shared/domain/ids.js'
import { DEFAULT_STRATEGY_ID } from '@shared/domain/strategies.js'
import { DEFAULT_LAYOUT_SELECTION_STRATEGY_ID } from '@shared/domain/layoutSelectionStrategies.js'

export class CsvImportError extends Error {
  readonly code: 'file_read_error' | 'csv_parse_error'
  readonly path: string

  constructor(code: 'file_read_error' | 'csv_parse_error', path: string, message: string) {
    super(message)
    this.code = code
    this.path = path
  }
}

const MAX_FIELD_LENGTH = 255
const DEFAULT_SHEET = new SheetSpec({
  width: 1500,
  height: 1500,
  label: 'mother plate 1500x1500'
})

function makeDefaultRunConfiguration(runId: string, label: string): ProjectRunConfiguration {
  return new ProjectRunConfiguration({
    runId,
    label,
    defaultSheet: DEFAULT_SHEET,
    padding: 10,
    options: new NestingOptions({
      allowGlobalRotation: true,
      timeoutMs: 30000,
      workerMode: 'maxrects-beam-search',
      historyMode: 'final',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [DEFAULT_STRATEGY_ID],
      layoutSelectionStrategyId: DEFAULT_LAYOUT_SELECTION_STRATEGY_ID,
      finalSelectionMode: 'manual'
    })
  })
}

/** Decodes a Windows-1252 encoded CSV file to a UTF-8 string. */
export async function parseCsvWindows1252(sourcePath: string): Promise<string> {
  const buffer = await readFile(sourcePath).catch((err: unknown) => {
    throw new CsvImportError(
      'file_read_error',
      sourcePath,
      err instanceof Error ? err.message : String(err)
    )
  })
  return decode(buffer, 'win1252')
}

function assertNoDelimiterChars(value: string, fieldName: string, path: string): void {
  if (value.includes(';')) {
    throw new CsvImportError(
      'csv_parse_error',
      path,
      `${fieldName} contains a literal semicolon: ${value}`
    )
  }
  if (value.includes('\n') || value.includes('\r')) {
    throw new CsvImportError(
      'csv_parse_error',
      path,
      `${fieldName} contains a line break: ${value}`
    )
  }
}

function trimAndValidateField(value: string, fieldName: string, path: string): string {
  const trimmed = value.trim()
  assertNoDelimiterChars(trimmed, fieldName, path)
  if (trimmed.length > MAX_FIELD_LENGTH) {
    throw new CsvImportError(
      'csv_parse_error',
      path,
      `${fieldName} exceeds maximum length of ${MAX_FIELD_LENGTH}: ${trimmed.length}`
    )
  }
  return trimmed
}

function assertFieldCount(
  fields: readonly string[],
  expected: number,
  lineType: string,
  path: string
): void {
  if (fields.length !== expected) {
    throw new CsvImportError(
      'csv_parse_error',
      path,
      `${lineType} line must have exactly ${expected} semicolon-separated fields, got ${fields.length}`
    )
  }
}

function parsePositiveInteger(value: string, fieldName: string, path: string): number {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new CsvImportError(
      'csv_parse_error',
      path,
      `${fieldName} must be a positive integer, got ${value}`
    )
  }
  const parsed = Number(trimmed)
  if (parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new CsvImportError(
      'csv_parse_error',
      path,
      `${fieldName} must be a positive integer, got ${value}`
    )
  }
  return parsed
}

/** Parses an ABAS/CAMQUIX CSV string into a project import document. */
export function parseAbasCamquixCsv(content: string, sourcePath: string): ProjectCsvImport {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 3) {
    throw new CsvImportError(
      'csv_parse_error',
      sourcePath,
      'CSV must contain at least a JOB line, a BAR line, and one CUT line'
    )
  }

  let jobLine: string | undefined
  let barLine: string | undefined
  const cutLines: string[] = []

  for (const line of lines) {
    const type = line.split(';')[0]?.trim()
    if (type === 'JOB') {
      if (jobLine !== undefined) {
        throw new CsvImportError('csv_parse_error', sourcePath, 'CSV contains multiple JOB lines')
      }
      jobLine = line
    } else if (type === 'BAR') {
      if (barLine !== undefined) {
        throw new CsvImportError('csv_parse_error', sourcePath, 'CSV contains multiple BAR lines')
      }
      barLine = line
    } else if (type === 'CUT') {
      cutLines.push(line)
    } else {
      throw new CsvImportError(
        'csv_parse_error',
        sourcePath,
        `Unknown line type: ${type ?? '(empty)'}`
      )
    }
  }

  if (jobLine === undefined) {
    throw new CsvImportError('csv_parse_error', sourcePath, 'CSV is missing a JOB line')
  }
  if (barLine === undefined) {
    throw new CsvImportError('csv_parse_error', sourcePath, 'CSV is missing a BAR line')
  }
  if (cutLines.length === 0) {
    throw new CsvImportError(
      'csv_parse_error',
      sourcePath,
      'CSV must contain at least one CUT line'
    )
  }

  const jobFields = jobLine.split(';').map((f) => f.trim())
  assertFieldCount(jobFields, 7, 'JOB', sourcePath)
  const jobDate = trimAndValidateField(jobFields[1] ?? '', 'jobDate', sourcePath)
  const materialDescription = trimAndValidateField(
    jobFields[3] ?? '',
    'materialDescription',
    sourcePath
  )
  const repeatedJobDate = trimAndValidateField(jobFields[6] ?? '', 'repeatedJobDate', sourcePath)
  if (jobDate.length > 0 && repeatedJobDate.length > 0 && jobDate !== repeatedJobDate) {
    throw new CsvImportError(
      'csv_parse_error',
      sourcePath,
      `JOB line dates do not match: ${jobDate} and ${repeatedJobDate}`
    )
  }

  const barFields = barLine.split(';').map((f) => f.trim())
  assertFieldCount(barFields, 5, 'BAR', sourcePath)
  const materialCode = trimAndValidateField(barFields[1] ?? '', 'materialCode', sourcePath)
  const thicknessMm = parsePositiveInteger(barFields[4] ?? '', 'thicknessMm', sourcePath)

  const rows: CsvCutRow[] = []
  for (const cutLine of cutLines) {
    const fields = cutLine.split(';').map((f) => f.trim())
    assertFieldCount(fields, 11, 'CUT', sourcePath)
    const rawReference = trimAndValidateField(fields[6] ?? '', 'reference', sourcePath)
    const customerName = trimAndValidateField(fields[7] ?? '', 'customerName', sourcePath)
    const amount = parsePositiveInteger(fields[10] ?? '', 'amount', sourcePath)

    rows.push(
      new CsvCutRow({
        reference: rawReference,
        customerName,
        amount
      })
    )
  }

  const fileName = basename(sourcePath)
  const id = SourceFileId.make()
  return new ProjectCsvImport({
    id,
    sourcePath,
    fileName,
    materialCode,
    materialDescription,
    thicknessMm,
    jobDate,
    rows,
    runConfiguration: makeDefaultRunConfiguration(id, materialDescription)
  })
}

/** Imports multiple CSV files, returning successes and failures separately. */
export async function importCsvFiles(paths: readonly string[]): Promise<{
  successes: ProjectCsvImport[]
  failures: Array<{ path: string; error: unknown }>
}> {
  const successes: ProjectCsvImport[] = []
  const failures: Array<{ path: string; error: unknown }> = []

  await Promise.all(
    paths.map(async (path) => {
      try {
        const content = await parseCsvWindows1252(path)
        const parsed = parseAbasCamquixCsv(content, path)
        successes.push(parsed)
      } catch (err) {
        failures.push({ path, error: err })
      }
    })
  )

  return { successes, failures }
}
