import { describe, expect, it, beforeEach } from 'vitest'
import { useCsvImportStore } from '../../src/renderer/composables/useCsvImportStore.js'
import type {
  NestingOptions,
  NestingLayout,
  NestingResult,
  NestingSubRun,
  Placement,
  PreparedPiece,
  SheetSpec
} from '@shared/domain/nesting.js'
import { JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'
import { DEFAULT_IRREGULAR_NESTING_SETTINGS } from '@shared/irregular/defaults.js'
import type { ProjectCsvImport } from '@shared/domain/project.js'

function pid(value: string): PieceId {
  return value as PieceId
}

function sfid(value: string): SourceFileId {
  return value as SourceFileId
}

function makeSheet(): SheetSpec {
  return { width: 1500, height: 1500, label: 'mother plate' }
}

function makeDefaultOptions(): NestingOptions {
  return {
    allowGlobalRotation: true,
    timeoutMs: 5000,
    workerMode: 'maxrects-beam-search',
    historyMode: 'final',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: ['balanced-preserve-free-then-bottom-left'],
    layoutSelectionStrategyId: 'compact-first',
    finalSelectionMode: 'manual'
  }
}

function makePreparedPiece(id: string, cutRowRef?: PreparedPiece['cutRowRef']): PreparedPiece {
  return {
    id: pid(id),
    sourcePieceId: pid(id),
    realBounds: { x: 0, y: 0, width: 10, height: 5 },
    paddedBounds: { x: 0, y: 0, width: 14, height: 9, longestEdge: 14, area: 126, imbalance: 5 },
    padding: 2,
    allowRotation: true,
    cutRowRef
  }
}

function makePlacement(pieceId: string): Placement {
  return { pieceId: pid(pieceId), x: 0, y: 0, width: 10, height: 5, rotation: 0 }
}

function makeIrregularLayout(
  pieceId: string,
  sourcePieceId: string,
  translateX: number,
  rotationDeg: number,
  mirrored: boolean
): NestingLayout {
  return {
    kind: 'irregular',
    placements: [
      {
        pieceId: pid(pieceId),
        sourcePieceId: pid(sourcePieceId),
        placementReference: { x: 1.5, y: 2.5 },
        transform: { translateX, translateY: 6, rotationDeg, mirrored }
      }
    ],
    unplacedPieceIds: [],
    score: {
      unplacedCount: 0,
      largestNetFreeMaterialRegionAreaMm2: 100,
      freeMaterialRegionCount: 1,
      freeMaterialHoleCount: 0,
      freeMaterialSliverMetric: 1,
      collisionBoundsWorstNormalizedSheetConsumption: 0.5,
      collisionBoundsNormalizedSpanSum: 0.8,
      collisionBoundsAreaMm2: 240,
      collisionBoundsSpanMm: 30
    },
    source: 'beam',
    status: 'completed',
    diagnostics: []
  }
}

function makeSubRun(index: number, overrides?: Partial<NestingSubRun>): NestingSubRun {
  return {
    subRunId: `sub-${index}`,
    parentRunId: 'run-1',
    index,
    sheet: makeSheet(),
    padding: 10,
    options: makeDefaultOptions(),
    placements: [],
    unplacedPieceIds: [],
    pieceIds: [],
    requestPieceIds: [],
    ...overrides
  } as NestingSubRun
}

function makeNestingResult(
  csvImportId: string,
  subRun: NestingSubRun,
  preparedPieces: PreparedPiece[]
): NestingResult {
  return {
    version: 1,
    jobId: 'job-1' as JobId,
    status: subRun.unplacedPieceIds.length === 0 ? 'ok' : 'partial',
    strategyResults: [],
    sortedPieceIds: [...subRun.requestPieceIds],
    placements: [...subRun.placements],
    unplacedPieceIds: [...subRun.unplacedPieceIds],
    warnings: [],
    stats: {
      elapsedMs: 0,
      pieceCount: preparedPieces.length,
      algorithm: {
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:00.000Z',
        elapsedMs: 0
      }
    },
    runSummary: {
      runId: csvImportId,
      subRuns: [subRun],
      totalPlaced: subRun.placements.length,
      totalUnplaced: subRun.unplacedPieceIds.length,
      totalSheetAreaMm2: subRun.sheet.width * subRun.sheet.height,
      usedAreaMm2: subRun.placements.reduce((sum, p) => sum + p.width * p.height, 0)
    },
    preparedPieces,
    csvImportId
  } as NestingResult
}

function makeCsvImport(id: string): ProjectCsvImport {
  return {
    id: sfid(id),
    sourcePath: `/tmp/${id}.csv`,
    fileName: `${id}.csv`,
    materialCode: '8669',
    materialDescription: 'ACRYL 5MM',
    thicknessMm: 5,
    jobDate: '20260630',
    rows: [],
    runConfiguration: {
      runId: id,
      label: `CSV run ${id}`,
      defaultSheet: makeSheet(),
      padding: 10,
      options: makeDefaultOptions()
    }
  }
}

describe('useCsvImportStore', () => {
  const store = useCsvImportStore()

  beforeEach(() => {
    store.clear()
  })

  it('keeps the full preparedPieces catalog across multiple subruns', () => {
    const csvImportId = 'csv-1'
    store.appendCsvImports([makeCsvImport(csvImportId)])

    const pieces0 = [makePreparedPiece('p-0'), makePreparedPiece('p-1')]
    store.startSubrun(csvImportId, 0, pieces0, makeSheet(), 10, makeDefaultOptions())
    const subRun0 = makeSubRun(0, {
      placements: [makePlacement('p-0')],
      unplacedPieceIds: [pid('p-1')],
      pieceIds: [pid('p-0'), pid('p-1')],
      requestPieceIds: [pid('p-0'), pid('p-1')]
    })
    store.appendSubrunResult(csvImportId, makeNestingResult(csvImportId, subRun0, pieces0))

    const pieces1 = [makePreparedPiece('p-2'), makePreparedPiece('p-3')]
    store.startSubrun(csvImportId, 1, pieces1, makeSheet(), 10, makeDefaultOptions())
    const subRun1 = makeSubRun(0, {
      placements: [makePlacement('p-2')],
      unplacedPieceIds: [pid('p-3')],
      pieceIds: [pid('p-2'), pid('p-3')],
      requestPieceIds: [pid('p-2'), pid('p-3')]
    })
    store.appendSubrunResult(csvImportId, makeNestingResult(csvImportId, subRun1, pieces1))

    const session = store.state.value.activeSessions.get(csvImportId)
    const preparedIds = session?.preparedPieces.map((p) => p.id).sort()
    expect(preparedIds).toEqual([pid('p-0'), pid('p-1'), pid('p-2'), pid('p-3')].sort())
  })

  it('finalizeSession returns a complete CsvRunRecord and correct runSummary totals', () => {
    const csvImportId = 'csv-1'
    store.appendCsvImports([makeCsvImport(csvImportId)])

    const pieces0 = [makePreparedPiece('p-0'), makePreparedPiece('p-1')]
    store.startSubrun(csvImportId, 0, pieces0, makeSheet(), 10, makeDefaultOptions())
    const subRun0 = makeSubRun(0, {
      placements: [makePlacement('p-0')],
      unplacedPieceIds: [pid('p-1')],
      pieceIds: [pid('p-0'), pid('p-1')],
      requestPieceIds: [pid('p-0'), pid('p-1')]
    })
    store.appendSubrunResult(csvImportId, makeNestingResult(csvImportId, subRun0, pieces0))

    const pieces1 = [makePreparedPiece('p-2'), makePreparedPiece('p-3')]
    store.startSubrun(csvImportId, 1, pieces1, makeSheet(), 10, makeDefaultOptions())
    const subRun1 = makeSubRun(0, {
      placements: [makePlacement('p-2'), makePlacement('p-3')],
      unplacedPieceIds: [],
      pieceIds: [pid('p-2'), pid('p-3')],
      requestPieceIds: [pid('p-2'), pid('p-3')]
    })
    store.appendSubrunResult(csvImportId, makeNestingResult(csvImportId, subRun1, pieces1))

    const outcome = store.finalizeSession(csvImportId)
    expect(outcome).not.toBeNull()
    if (!outcome) return

    const { result, csvRunRecord } = outcome
    const preparedIds = csvRunRecord.preparedPieces.map((p) => p.id).sort()
    expect(preparedIds).toEqual([pid('p-0'), pid('p-1'), pid('p-2'), pid('p-3')].sort())

    expect(result.runSummary).not.toBeUndefined()
    expect(result.runSummary?.totalPlaced).toBe(3)
    expect(result.runSummary?.totalUnplaced).toBe(1)
    expect(csvRunRecord.unplacedPieceIds).toEqual([pid('p-1')])
    expect(csvRunRecord.subRuns).toHaveLength(2)
    expect(store.state.value.activeSessions.has(csvImportId)).toBe(false)
    expect(store.state.value.csvRunRecords.some((r) => r.csvImportId === csvImportId)).toBe(true)
  })

  it('getCsvRunRecords includes active sessions alongside finalized records', () => {
    const activeId = 'csv-active'
    const finalizedId = 'csv-finalized'
    store.appendCsvImports([makeCsvImport(activeId), makeCsvImport(finalizedId)])

    const activePieces = [makePreparedPiece('p-a')]
    store.startSubrun(activeId, 0, activePieces, makeSheet(), 10, makeDefaultOptions())
    const activeSubRun = makeSubRun(0, {
      placements: [],
      unplacedPieceIds: [pid('p-a')],
      pieceIds: [pid('p-a')],
      requestPieceIds: [pid('p-a')]
    })
    store.appendSubrunResult(activeId, makeNestingResult(activeId, activeSubRun, activePieces))

    const finalizedPieces = [makePreparedPiece('p-f')]
    store.startSubrun(finalizedId, 0, finalizedPieces, makeSheet(), 10, makeDefaultOptions())
    const finalizedSubRun = makeSubRun(0, {
      placements: [makePlacement('p-f')],
      unplacedPieceIds: [],
      pieceIds: [pid('p-f')],
      requestPieceIds: [pid('p-f')]
    })
    store.appendSubrunResult(
      finalizedId,
      makeNestingResult(finalizedId, finalizedSubRun, finalizedPieces)
    )
    store.finalizeSession(finalizedId)

    const records = store.getCsvRunRecords()
    const ids = records.map((r) => r.csvImportId).sort()
    expect(ids).toEqual([activeId, finalizedId].sort())
  })

  it('preserves irregular transforms and layouts across independent CSV subruns', () => {
    const csvImportId = 'csv-irregular'
    store.appendCsvImports([makeCsvImport(csvImportId)])

    const firstPiece = {
      ...makePreparedPiece('copy-0'),
      sourcePieceId: pid('source-0'),
      allowMirror: false
    }
    const firstOptions = {
      ...makeDefaultOptions(),
      workerMode: 'irregular-convex-v2' as const,
      allowGlobalMirror: false,
      irregularSettings: DEFAULT_IRREGULAR_NESTING_SETTINGS
    }
    const firstRequest = store.startSubrun(
      csvImportId,
      0,
      [firstPiece],
      makeSheet(),
      10,
      firstOptions
    )
    expect(firstRequest.options.allowGlobalMirror).toBe(false)
    expect(firstRequest.options.irregularSettings?.optimizer.beamWidth).toBe(
      DEFAULT_IRREGULAR_NESTING_SETTINGS.optimizer.beamWidth
    )
    expect(firstRequest.pieces[0]?.allowMirror).toBe(false)
    const firstSubRun = makeSubRun(0, {
      placements: [],
      layout: makeIrregularLayout('copy-0', 'source-0', 12.5, 37.5, true),
      options: firstOptions,
      unplacedPieceIds: [],
      pieceIds: [pid('copy-0')],
      requestPieceIds: [pid('copy-0')]
    })
    store.appendSubrunResult(
      csvImportId,
      makeNestingResult(csvImportId, firstSubRun, [firstPiece])
    )

    const secondPiece = {
      ...makePreparedPiece('copy-1'),
      sourcePieceId: pid('source-1')
    }
    store.startSubrun(
      csvImportId,
      1,
      [secondPiece],
      { width: 800, height: 700, label: 'second plate' },
      8,
      { ...makeDefaultOptions(), workerMode: 'irregular-convex-v2' }
    )
    const secondSubRun = makeSubRun(0, {
      placements: [],
      layout: makeIrregularLayout('copy-1', 'source-1', 4, 90, false),
      unplacedPieceIds: [],
      pieceIds: [pid('copy-1')],
      requestPieceIds: [pid('copy-1')]
    })
    store.appendSubrunResult(
      csvImportId,
      makeNestingResult(csvImportId, secondSubRun, [secondPiece])
    )

    const outcome = store.finalizeSession(csvImportId)
    expect(outcome).not.toBeNull()
    if (!outcome) return

    expect(outcome.csvRunRecord.subRuns).toHaveLength(2)
    expect(outcome.csvRunRecord.subRuns.map((subRun) => subRun.layout?.kind)).toEqual([
      'irregular',
      'irregular'
    ])
    const firstPlacement = outcome.csvRunRecord.subRuns[0]?.layout
    const secondPlacement = outcome.csvRunRecord.subRuns[1]?.layout
    if (firstPlacement?.kind !== 'irregular' || secondPlacement?.kind !== 'irregular') return
    expect(firstPlacement.placements[0]?.transform).toEqual({
      translateX: 12.5,
      translateY: 6,
      rotationDeg: 37.5,
      mirrored: true
    })
    expect(secondPlacement.placements[0]?.transform).toEqual({
      translateX: 4,
      translateY: 6,
      rotationDeg: 90,
      mirrored: false
    })
    expect(outcome.result.strategyResults.map((result) => result.layout?.kind)).toEqual([
      'irregular',
      'irregular'
    ])
    expect(outcome.result.runSummary?.totalPlaced).toBe(2)
    expect(outcome.csvRunRecord.subRuns[0]?.options.allowGlobalMirror).toBe(false)
    expect(outcome.csvRunRecord.subRuns[0]?.options.irregularSettings).toEqual(
      DEFAULT_IRREGULAR_NESTING_SETTINGS
    )
    expect(outcome.csvRunRecord.preparedPieces[0]?.allowMirror).toBe(false)
  })
})
