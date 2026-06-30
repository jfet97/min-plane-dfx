import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { encode } from 'iconv-lite'
import {
  CsvImportError,
  importCsvFiles,
  parseAbasCamquixCsv,
  parseCsvWindows1252
} from '../../src/main/services/CsvImportService.js'

const sampleCsv = `JOB;20260630;;ACRYL 5MM GEGOSSEN SATIN;;;20260630\r\nBAR;8669;;;5\r\nCUT;1000;;;;;3282597_2;Customer A;;;3`

describe('CsvImportService', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `min-plane-csv-${randomUUID()}`)
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('decodes a Windows-1252 file to UTF-8', async () => {
    const file = join(dir, 'sample.csv')
    const text = 'JOB;20260630;;Müller;;;20260630\r\n'
    await writeFile(file, encode(text, 'win1252'))
    const decoded = await parseCsvWindows1252(file)
    expect(decoded).toBe(text)
  })

  it('parses the real sample format', () => {
    const parsed = parseAbasCamquixCsv(sampleCsv, '/workspace/jobs/sample.csv')
    expect(parsed.sourcePath).toBe('/workspace/jobs/sample.csv')
    expect(parsed.fileName).toBe('sample.csv')
    expect(parsed.jobDate).toBe('20260630')
    expect(parsed.materialCode).toBe('8669')
    expect(parsed.materialDescription).toBe('ACRYL 5MM GEGOSSEN SATIN')
    expect(parsed.thicknessMm).toBe(5)
    expect(parsed.rows.length).toBe(1)

    const row = parsed.rows[0]
    if (!row) throw new Error('expected a CSV row')
    expect(row.reference).toBe('3282597_2')
    expect(row.customerName).toBe('Customer A')
    expect(row.amount).toBe(3)
    expect(typeof row.id).toBe('string')

    expect(parsed.runConfiguration.runId).toBe(parsed.id)
    expect(parsed.runConfiguration.label).toBe('ACRYL 5MM GEGOSSEN SATIN')
    expect(parsed.runConfiguration.defaultSheet.width).toBe(1500)
    expect(parsed.runConfiguration.defaultSheet.height).toBe(1500)
  })

  it('parses a Windows-1252 encoded file with umlauts', async () => {
    const file = join(dir, 'umlaut.csv')
    const text = `JOB;20260630;;ACRYL 5MM GEGOSSEN SATIN;;;20260630\r\nBAR;8669;;;5\r\nCUT;1000;;;;;3282597_2;Müller;;;3`
    await writeFile(file, encode(text, 'win1252'))
    const result = await importCsvFiles([file])
    expect(result.failures.length).toBe(0)
    expect(result.successes.length).toBe(1)
    const parsed = result.successes[0]
    if (!parsed) throw new Error('expected a parsed CSV')
    expect(parsed.rows[0]?.customerName).toBe('Müller')
  })

  it('rejects a CSV missing a JOB line', () => {
    const csv = `BAR;8669;;;5\r\nCUT;1000;;;;;3282597_2;Customer A;;;3`
    expect(() => parseAbasCamquixCsv(csv, '/tmp/missing-job.csv')).toThrow(CsvImportError)
    expect(() => parseAbasCamquixCsv(csv, '/tmp/missing-job.csv')).toThrow(
      'CSV must contain at least a JOB line, a BAR line, and one CUT line'
    )
  })

  it('rejects a CSV missing a BAR line', () => {
    const csv = `JOB;20260630;;ACRYL 5MM GEGOSSEN SATIN;;;20260630\r\nCUT;1000;;;;;3282597_2;Customer A;;;3`
    expect(() => parseAbasCamquixCsv(csv, '/tmp/missing-bar.csv')).toThrow(CsvImportError)
    expect(() => parseAbasCamquixCsv(csv, '/tmp/missing-bar.csv')).toThrow(
      'CSV must contain at least a JOB line, a BAR line, and one CUT line'
    )
  })

  it('rejects a CSV with no CUT lines', () => {
    const csv = `JOB;20260630;;ACRYL 5MM GEGOSSEN SATIN;;;20260630\r\nBAR;8669;;;5`
    expect(() => parseAbasCamquixCsv(csv, '/tmp/no-cuts.csv')).toThrow(CsvImportError)
    expect(() => parseAbasCamquixCsv(csv, '/tmp/no-cuts.csv')).toThrow(
      'CSV must contain at least a JOB line, a BAR line, and one CUT line'
    )
  })

  it('rejects an invalid amount', () => {
    const csv = `JOB;20260630;;ACRYL 5MM GEGOSSEN SATIN;;;20260630\r\nBAR;8669;;;5\r\nCUT;1000;;;;;3282597_2;Customer A;;;0`
    expect(() => parseAbasCamquixCsv(csv, '/tmp/zero-amount.csv')).toThrow(CsvImportError)
    expect(() => parseAbasCamquixCsv(csv, '/tmp/zero-amount.csv')).toThrow('amount')
  })

  it('rejects a field containing a semicolon', () => {
    const csv = `JOB;20260630;;ACRYL 5MM GEGOSSEN SATIN;;;20260630\r\nBAR;8669;;;5\r\nCUT;1000;;;;;3282597_2;Cus;tomer;;;3`
    expect(() => parseAbasCamquixCsv(csv, '/tmp/semicolon-field.csv')).toThrow(CsvImportError)
  })

  it('collects failures per file without failing the whole batch', async () => {
    const good = join(dir, 'good.csv')
    const bad = join(dir, 'bad.csv')
    await writeFile(good, encode(sampleCsv, 'win1252'))
    await writeFile(bad, encode('not;a;valid;csv\r\n', 'win1252'))
    const result = await importCsvFiles([good, bad])
    expect(result.successes.length).toBe(1)
    expect(result.failures.length).toBe(1)
    expect(result.failures[0]?.path).toBe(bad)
    expect(result.failures[0]?.error).toBeInstanceOf(CsvImportError)
  })
})
