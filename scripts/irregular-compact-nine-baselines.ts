import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

interface Baseline {
  readonly fixture: 'triangle-20' | 'mixed-61' | 'shapes-17'
  readonly sheet: '2000x2700' | '600x400' | '300x300'
  readonly collisionIdentitySha256: string
  readonly fittedCanonicalSha256: string
  readonly placedCount: number
  readonly unplacedCount: number
  readonly maximumAreaMm2: number
  readonly maximumCanonicalCavities: number
  readonly maximumElapsedMs: number
  readonly shortSideCollisionIdentitySha256: string
  readonly shortSideFittedCanonicalSha256: string
  readonly shortSidePlacedCount: number
  readonly shortSideUnplacedCount: number
}

const BASELINES: ReadonlyArray<Baseline> = [
  {
    fixture: 'triangle-20',
    sheet: '2000x2700',
    collisionIdentitySha256: '371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127',
    fittedCanonicalSha256: 'b4d1fd9af8a1ecb4a17f1031546c1dbbb5afb19b2d99e41bdb646e52084092f7',
    placedCount: 20,
    unplacedCount: 0,
    maximumAreaMm2: 74_428.143126,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 120_000,
    shortSideCollisionIdentitySha256:
      '7a79ebd40029094854748d569acb52f95f32a96e71b3b674941ba7f20f9cfe15',
    shortSideFittedCanonicalSha256:
      'bc978c3710e6865a68c4c965fde545d0421d5d915319056b5a67689a6e918e5a',
    shortSidePlacedCount: 20,
    shortSideUnplacedCount: 0
  },
  {
    fixture: 'mixed-61',
    sheet: '2000x2700',
    collisionIdentitySha256: '3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742',
    fittedCanonicalSha256: 'ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b',
    placedCount: 61,
    unplacedCount: 0,
    maximumAreaMm2: 391_605.850174,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 330_000,
    shortSideCollisionIdentitySha256:
      'c6fb2fa21ffa6d3bee75ea5cedc6b4f74a3b0ca0e48b6540be0b10f87ae4ce76',
    shortSideFittedCanonicalSha256:
      '914bb181f71cf450d22bff7342ee9310aa4f76ec180126083e43747740b444c0',
    shortSidePlacedCount: 61,
    shortSideUnplacedCount: 0
  },
  {
    fixture: 'shapes-17',
    sheet: '2000x2700',
    collisionIdentitySha256: '1ddc8426e032ce01b47ff82cae6104fa99a3f92f44f37782d846e1a8b83c8c5d',
    fittedCanonicalSha256: '490194ca505f545cfb5880209d20b2f48cdcffbc847c8686705fd12661b5e7bf',
    placedCount: 17,
    unplacedCount: 0,
    maximumAreaMm2: 281_233.148068,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 120_000,
    shortSideCollisionIdentitySha256:
      '4dd34dcee54caa79e1cc0dc3fc88b867ddfa15a98588dda1083e820cdb44c0bb',
    shortSideFittedCanonicalSha256:
      '063f740ff97b154ab9b3116023da7de3da1de33322a27ca53f56b43b21a3c7bb',
    shortSidePlacedCount: 17,
    shortSideUnplacedCount: 0
  },
  {
    fixture: 'triangle-20',
    sheet: '600x400',
    collisionIdentitySha256: '371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127',
    fittedCanonicalSha256: 'b4d1fd9af8a1ecb4a17f1031546c1dbbb5afb19b2d99e41bdb646e52084092f7',
    placedCount: 20,
    unplacedCount: 0,
    maximumAreaMm2: 74_428.143126,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 120_000,
    shortSideCollisionIdentitySha256:
      '4b87d6df47fdf2246c6d2d8d9ad6c201d75f33e4f29072be0a64dc5d217e206f',
    shortSideFittedCanonicalSha256:
      'bf23f53f3bb796f082dc7a1e1257df3a366351bc2a637bfba08b9f5d0be929a8',
    shortSidePlacedCount: 20,
    shortSideUnplacedCount: 0
  },
  {
    fixture: 'mixed-61',
    sheet: '600x400',
    collisionIdentitySha256: '2c53f3123d5d57ab5e120717ae1e49046bb574925c49c4a33ed4febe7e81e414',
    fittedCanonicalSha256: '39e74c34e0cfcd4929ba3dde53d1b0215ca2c48e383297b15922f07115569f38',
    placedCount: 25,
    unplacedCount: 36,
    maximumAreaMm2: 239_484.9666,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 330_000,
    shortSideCollisionIdentitySha256:
      '2c53f3123d5d57ab5e120717ae1e49046bb574925c49c4a33ed4febe7e81e414',
    shortSideFittedCanonicalSha256:
      '39e74c34e0cfcd4929ba3dde53d1b0215ca2c48e383297b15922f07115569f38',
    shortSidePlacedCount: 25,
    shortSideUnplacedCount: 36
  },
  {
    fixture: 'shapes-17',
    sheet: '600x400',
    collisionIdentitySha256: '01b2060d87752bb36eebfd4eb8602709687d5cb00c71b8feaec14a6e7cf9ba12',
    fittedCanonicalSha256: '4472adc8ddfcc26af748adcfeb220e049a4f0e814cb17a99c0dc092db903921e',
    placedCount: 14,
    unplacedCount: 3,
    maximumAreaMm2: 232_178.021694,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 120_000,
    shortSideCollisionIdentitySha256:
      '01b2060d87752bb36eebfd4eb8602709687d5cb00c71b8feaec14a6e7cf9ba12',
    shortSideFittedCanonicalSha256:
      '4472adc8ddfcc26af748adcfeb220e049a4f0e814cb17a99c0dc092db903921e',
    shortSidePlacedCount: 14,
    shortSideUnplacedCount: 3
  },
  {
    fixture: 'triangle-20',
    sheet: '300x300',
    collisionIdentitySha256: '0f5befd7d02fc111be47ee447fab7f8778f06ae05d045448f22a916d66949410',
    fittedCanonicalSha256: '2f236b79c7c49a999daf5363e257bbda6b8562239571c6fedab2485cffb38c35',
    placedCount: 17,
    unplacedCount: 3,
    maximumAreaMm2: 78_811.504488,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 120_000,
    shortSideCollisionIdentitySha256:
      '0f5befd7d02fc111be47ee447fab7f8778f06ae05d045448f22a916d66949410',
    shortSideFittedCanonicalSha256:
      '2f236b79c7c49a999daf5363e257bbda6b8562239571c6fedab2485cffb38c35',
    shortSidePlacedCount: 17,
    shortSideUnplacedCount: 3
  },
  {
    fixture: 'mixed-61',
    sheet: '300x300',
    collisionIdentitySha256: 'bb22df3517b4f2bbbdebc1d35704dbf4374f96d264af919a4c8d29dc2168fa33',
    fittedCanonicalSha256: '37d7bf9c37dfe2b9702bf8df73791782006178eb570ac043b23f1ca20ca22c0b',
    placedCount: 6,
    unplacedCount: 55,
    maximumAreaMm2: 89_504.369008,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 330_000,
    shortSideCollisionIdentitySha256:
      'bb22df3517b4f2bbbdebc1d35704dbf4374f96d264af919a4c8d29dc2168fa33',
    shortSideFittedCanonicalSha256:
      '37d7bf9c37dfe2b9702bf8df73791782006178eb570ac043b23f1ca20ca22c0b',
    shortSidePlacedCount: 6,
    shortSideUnplacedCount: 55
  },
  {
    fixture: 'shapes-17',
    sheet: '300x300',
    collisionIdentitySha256: 'e4ad1ce1c7fa26e7a00ba38a5d9c11e1908ebf753031ff4811420d5097be7c71',
    fittedCanonicalSha256: 'bccfa5a4b7db4b5009a8c0f12d7c6f308c9a72550df3feb218355f33a5c1ef18',
    placedCount: 5,
    unplacedCount: 12,
    maximumAreaMm2: 87_791.951625,
    maximumCanonicalCavities: 0,
    maximumElapsedMs: 120_000,
    shortSideCollisionIdentitySha256:
      'e4ad1ce1c7fa26e7a00ba38a5d9c11e1908ebf753031ff4811420d5097be7c71',
    shortSideFittedCanonicalSha256:
      'bccfa5a4b7db4b5009a8c0f12d7c6f308c9a72550df3feb218355f33a5c1ef18',
    shortSidePlacedCount: 5,
    shortSideUnplacedCount: 12
  }
]


const SVG_RENDERER_SCRIPT =
  process.env.IRREGULAR_SVG_RENDERER === 'magick'
    ? 'scripts/render-svg-magick.cjs'
    : '.agents/skills/render-svg-with-electron/scripts/render-svg.cjs'

/**
 * Renders one layout SVG to PNG for visual review.
 *
 * The Electron renderer is the default because it uses the same engine as the
 * app preview. It aborts during platform initialization on machines without a
 * display, so `IRREGULAR_SVG_RENDERER=magick` selects the ImageMagick fallback
 * and the chosen renderer is recorded in the provenance manifest.
 */
function renderSvgToPng(svgPath: string, pngPath: string): void {
  execFileSync(process.execPath, [SVG_RENDERER_SCRIPT, svgPath, pngPath, '1000'], {
    stdio: 'inherit'
  })
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function runProcess(
  baseline: Baseline,
  arguments_: ReadonlyArray<string>,
  profile: 'compact' | 'short-side'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `${baseline.fixture} ${baseline.sheet} ${profile} exited with ${code ?? `signal ${signal}`}`
        )
      )
    })
  })
}

async function runBaseline(baseline: Baseline, outputDirectory: string): Promise<void> {
  const outputPrefix = join(outputDirectory, `${baseline.fixture}-${baseline.sheet}`)
  const compactArguments = [
    'exec',
    'tsx',
    '--tsconfig',
    'tsconfig.node.json',
    'scripts/irregular-compact-baseline.ts',
    '--fixture',
    baseline.fixture,
    '--sheet',
    baseline.sheet,
    '--output-prefix',
    outputPrefix,
    '--strict',
    '--expected-collision-identity-sha256',
    baseline.collisionIdentitySha256,
    '--expected-fitted-canonical-sha256',
    baseline.fittedCanonicalSha256,
    '--expected-placed-count',
    String(baseline.placedCount),
    '--expected-unplaced-count',
    String(baseline.unplacedCount),
    '--maximum-area-mm2',
    String(baseline.maximumAreaMm2),
    '--maximum-canonical-cavities',
    String(baseline.maximumCanonicalCavities),
    '--maximum-elapsed-ms',
    String(baseline.maximumElapsedMs),
    ...focusedExpectedArguments(baseline)
  ]
  await runProcess(baseline, compactArguments, 'compact')
  const shortSideArguments = [
    'exec',
    'tsx',
    '--tsconfig',
    'tsconfig.node.json',
    'scripts/irregular-compact-baseline.ts',
    '--fixture',
    baseline.fixture,
    '--sheet',
    baseline.sheet,
    '--output-prefix',
    `${outputPrefix}.short-side-profile`,
    '--objective-profile',
    'short-side',
    '--strict',
    '--expected-collision-identity-sha256',
    baseline.shortSideCollisionIdentitySha256,
    '--expected-fitted-canonical-sha256',
    baseline.shortSideFittedCanonicalSha256,
    '--expected-placed-count',
    String(baseline.shortSidePlacedCount),
    '--expected-unplaced-count',
    String(baseline.shortSideUnplacedCount),
    '--maximum-canonical-cavities',
    String(baseline.maximumCanonicalCavities),
    '--maximum-elapsed-ms',
    String(baseline.maximumElapsedMs),
    ...focusedExpectedArguments(baseline)
  ]
  await runProcess(baseline, shortSideArguments, 'short-side')
}

function focusedExpectedArguments(baseline: Baseline): ReadonlyArray<string> {
  const triangleHash = '371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127'
  const mixedHash = '3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742'
  const shapesProtectedHash = 'c640c06f662050f8a132168f63988c40ba41f2ebc57dc50277a91119b4b4980a'
  const shapesPromotedHash = '1ddc8426e032ce01b47ff82cae6104fa99a3f92f44f37782d846e1a8b83c8c5d'
  const values =
    baseline.fixture === 'triangle-20' && baseline.sheet !== '300x300'
      ? {
          status: 'duplicate-order',
          evaluations: 0,
          source: triangleHash,
          candidate: 'none',
          selected: triangleHash,
          influence: 'protected-fallback'
        }
      : baseline.fixture === 'mixed-61' && baseline.sheet === '2000x2700'
        ? {
            status: 'evaluation-cap',
            evaluations: 12_000,
            source: mixedHash,
            candidate: 'none',
            selected: mixedHash,
            influence: 'protected-fallback'
          }
        : baseline.fixture === 'shapes-17' && baseline.sheet === '2000x2700'
          ? {
              status: 'completed',
              evaluations: 8_035,
              source: shapesProtectedHash,
              candidate: shapesPromotedHash,
              selected: shapesPromotedHash,
              influence: 'selected'
            }
          : baseline.fixture === 'shapes-17' && baseline.sheet === '600x400'
            ? {
                status: 'skipped-no-fitting-protected-endpoint',
                evaluations: 0,
                source: shapesProtectedHash,
                candidate: 'none',
                selected: 'none',
                influence: 'none'
              }
            : baseline.fixture === 'triangle-20' && baseline.sheet === '300x300'
              ? {
                  status: 'skipped-no-fitting-protected-endpoint',
                  evaluations: 0,
                  source: triangleHash,
                  candidate: 'none',
                  selected: 'none',
                  influence: 'none'
                }
              : {
                  status: 'skipped-preflight-proven-impossible',
                  evaluations: 0,
                  source: 'none',
                  candidate: 'none',
                  selected: 'none',
                  influence: 'none'
                }
  return [
    '--expected-focused-status',
    values.status,
    '--expected-focused-evaluations',
    String(values.evaluations),
    '--expected-focused-source-hash',
    values.source,
    '--expected-focused-candidate-hash',
    values.candidate,
    '--expected-focused-selected-hash',
    values.selected,
    '--expected-focused-influence',
    values.influence
  ]
}

const outputDirectory =
  argument('--output-dir') ?? '/private/tmp/min-plane-provenance/compact-nine-baselines'
await mkdir(outputDirectory, { recursive: true })

const outcomes: Array<{
  readonly fixture: Baseline['fixture']
  readonly sheet: Baseline['sheet']
  readonly passed: boolean
  readonly error?: string
}> = []
for (const baseline of BASELINES) {
  try {
    await runBaseline(baseline, outputDirectory)
    outcomes.push({
      fixture: baseline.fixture,
      sheet: baseline.sheet,
      passed: true
    })
  } catch (error) {
    outcomes.push({
      fixture: baseline.fixture,
      sheet: baseline.sheet,
      passed: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

interface CompactReport {
  readonly fixture: Baseline['fixture']
  readonly objectiveProfile: 'compact' | 'short-side'
  readonly sheet: {
    readonly width: number
    readonly height: number
  }
  readonly result: {
    readonly placedCount: number
    readonly unplacedCount: number
    readonly collisionIdentitySha256: string
    readonly fittedCanonicalSha256: string
    readonly canonicalTopology?: {
      readonly enclosedCavityCount: number
    }
    readonly bounds: {
      readonly width: number
      readonly height: number
      readonly area: number
      readonly span: number
    }
    readonly intrinsicShortSideObserverTrace?: {
      readonly status: string
      readonly outputInfluence: 'none' | 'selected'
      readonly observerWinnerRotationDeg?: 0 | 90
    }
    readonly intrinsicShortSidePairFoldTrace?: {
      readonly status: string
      readonly outputInfluence: 'none' | 'selected'
      readonly constructionKind?: 'pair-fold' | 'multi-row-shelf' | 'contact-strip'
    }
  }
  readonly checks: Readonly<Record<string, boolean>>
  readonly passed: boolean
  readonly svgPath: string
  readonly workerOutput: {
    readonly strategyId: string | undefined
    readonly strategyLabel: string | undefined
    readonly historyFrameCount: number
  }
}

const compactReports: Array<CompactReport> = []
const shortSideReports: Array<CompactReport> = []
for (const baseline of BASELINES) {
  const prefix = join(outputDirectory, `${baseline.fixture}-${baseline.sheet}`)
  compactReports.push(JSON.parse(await readFile(`${prefix}.json`, 'utf8')) as CompactReport)
  shortSideReports.push(
    JSON.parse(await readFile(`${prefix}.short-side-profile.json`, 'utf8')) as CompactReport
  )
}

const layoutRecords = []
for (let index = 0; index < BASELINES.length; index += 1) {
  const baseline = BASELINES[index]
  const compactReport = compactReports[index]
  const shortSideReport = shortSideReports[index]
  if (baseline === undefined || compactReport === undefined || shortSideReport === undefined) {
    throw new Error(`missing layout report at matrix index ${index}`)
  }
  const compactPngPath = join(outputDirectory, `${baseline.fixture}-${baseline.sheet}.png`)
  const shortSidePngPath = join(
    outputDirectory,
    `${baseline.fixture}-${baseline.sheet}.short-side-profile.png`
  )
  renderSvgToPng(join(outputDirectory, compactReport.svgPath), compactPngPath)
  renderSvgToPng(join(outputDirectory, shortSideReport.svgPath), shortSidePngPath)
  const archiveSelected =
    shortSideReport.result.intrinsicShortSideObserverTrace?.outputInfluence ===
    'selected'
  const terminalTrace =
    shortSideReport.result.intrinsicShortSidePairFoldTrace
  const terminalSelected = terminalTrace?.outputInfluence === 'selected'
  const shortSideSource = archiveSelected
    ? ('guarded-stage1-winner' as const)
    : terminalSelected
      ? terminalTrace.constructionKind === 'contact-strip'
        ? ('terminal-contact-strip-winner' as const)
        : terminalTrace.constructionKind === 'multi-row-shelf'
          ? ('terminal-multi-row-shelf-winner' as const)
          : ('terminal-pair-fold-winner' as const)
      : ('compact-fallback' as const)
  const shortAxisSpan =
    shortSideReport.sheet.width === shortSideReport.sheet.height
      ? Math.max(
          shortSideReport.result.bounds.width,
          shortSideReport.result.bounds.height
        )
      : shortSideReport.sheet.width < shortSideReport.sheet.height
        ? shortSideReport.result.bounds.width
        : shortSideReport.result.bounds.height
  const shortAxisFillRatio =
    shortAxisSpan /
    Math.min(shortSideReport.sheet.width, shortSideReport.sheet.height)
  const profileOutcome =
    shortSideSource !== 'compact-fallback'
      ? ('directional-success' as const)
      : shortAxisFillRatio >= 0.8
        ? ('short-side-satisfied-by-compact' as const)
        : ('directional-miss' as const)
  layoutRecords.push(
    {
      fixture: baseline.fixture,
      sheet: baseline.sheet,
      profile: 'compact',
      source: 'production-compact',
      strategyId: compactReport.workerOutput.strategyId,
      placedCount: compactReport.result.placedCount,
      unplacedCount: compactReport.result.unplacedCount,
      collisionIdentitySha256: compactReport.result.collisionIdentitySha256,
      fittedCanonicalSha256: compactReport.result.fittedCanonicalSha256,
      canonicalCavities: compactReport.result.canonicalTopology?.enclosedCavityCount,
      bounds: compactReport.result.bounds,
      exactPiecePartition: compactReport.checks.exactPiecePartition,
      passed:
        compactReport.objectiveProfile === 'compact' &&
        compactReport.passed,
      svgPath: compactReport.svgPath,
      pngPath: basename(compactPngPath)
    },
    {
      fixture: baseline.fixture,
      sheet: baseline.sheet,
      profile: 'short-side',
      source: shortSideSource,
      strategyId: shortSideReport.workerOutput.strategyId,
      profileOutcome,
      shortAxisFillRatio,
      observerStatus:
        shortSideReport.result.intrinsicShortSideObserverTrace?.status ??
        'missing',
      selectedRotationDeg:
        shortSideReport.result.intrinsicShortSideObserverTrace
          ?.observerWinnerRotationDeg,
      placedCount: shortSideReport.result.placedCount,
      unplacedCount: shortSideReport.result.unplacedCount,
      collisionIdentitySha256:
        shortSideReport.result.collisionIdentitySha256,
      fittedCanonicalSha256:
        shortSideReport.result.fittedCanonicalSha256,
      canonicalCavities:
        shortSideReport.result.canonicalTopology?.enclosedCavityCount,
      bounds: shortSideReport.result.bounds,
      exactPiecePartition: shortSideReport.checks.exactPiecePartition,
      passed:
        shortSideReport.objectiveProfile === 'short-side' &&
        Boolean(shortSideReport.checks.exactPiecePartition) &&
        shortSideReport.passed,
      svgPath: shortSideReport.svgPath,
      pngPath: basename(shortSidePngPath)
    }
  )
}

const compactLayoutCount = layoutRecords.filter(({ profile }) => profile === 'compact').length
const shortSideLayoutCount = layoutRecords.filter(({ profile }) => profile === 'short-side').length
const guardedStage1WinnerCount = layoutRecords.filter(
  ({ profile, source }) => profile === 'short-side' && source === 'guarded-stage1-winner'
).length
const terminalPairFoldWinnerCount = layoutRecords.filter(
  ({ profile, source }) => profile === 'short-side' && source === 'terminal-pair-fold-winner'
).length
const terminalMultiRowShelfWinnerCount = layoutRecords.filter(
  ({ profile, source }) => profile === 'short-side' && source === 'terminal-multi-row-shelf-winner'
).length
const terminalContactStripWinnerCount = layoutRecords.filter(
  ({ profile, source }) => profile === 'short-side' && source === 'terminal-contact-strip-winner'
).length
const compactFallbackCount = layoutRecords.filter(
  ({ profile, source }) => profile === 'short-side' && source === 'compact-fallback'
).length
const directionalSuccessCount = layoutRecords.filter(
  ({ profile, profileOutcome }) =>
    profile === 'short-side' && profileOutcome === 'directional-success'
).length
const shortSideSatisfiedByCompactCount = layoutRecords.filter(
  ({ profile, profileOutcome }) =>
    profile === 'short-side' && profileOutcome === 'short-side-satisfied-by-compact'
).length
const directionalMissCount = layoutRecords.filter(
  ({ profile, profileOutcome }) => profile === 'short-side' && profileOutcome === 'directional-miss'
).length
const layoutContractPassed =
  layoutRecords.length === 18 &&
  compactLayoutCount === 9 &&
  shortSideLayoutCount === 9 &&
  guardedStage1WinnerCount +
    terminalPairFoldWinnerCount +
    terminalMultiRowShelfWinnerCount +
    terminalContactStripWinnerCount +
    compactFallbackCount ===
    9 &&
  directionalSuccessCount + shortSideSatisfiedByCompactCount === 9 &&
  directionalMissCount === 0 &&
  layoutRecords.every(({ exactPiecePartition, passed }) => Boolean(exactPiecePartition && passed))
const summaryPath = join(outputDirectory, 'summary.json')
await writeFile(
  summaryPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      passed: outcomes.every(({ passed }) => passed) && layoutContractPassed,
      caseCount: BASELINES.length,
      layoutCount: layoutRecords.length,
      compactLayoutCount,
      shortSideLayoutCount,
      guardedStage1WinnerCount,
      terminalPairFoldWinnerCount,
      terminalMultiRowShelfWinnerCount,
      terminalContactStripWinnerCount,
      compactFallbackCount,
      directionalSuccessCount,
      shortSideSatisfiedByCompactCount,
      directionalMissCount,
      outcomes,
      layouts: layoutRecords
    },
    null,
    2
  )}\n`
)
const sourceCommit =
  process.env.BASELINE_SOURCE_COMMIT ??
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const artifactNames = (await readdir(outputDirectory))
  .filter(
    (name) =>
      name !== 'manifest.json' &&
      name !== 'SHA256SUMS' &&
      (name.endsWith('.json') || name.endsWith('.svg') || name.endsWith('.png'))
  )
  .sort((first, second) => first.localeCompare(second))
const artifacts = await Promise.all(
  artifactNames.map(async (name) => ({
    name,
    sha256: createHash('sha256')
      .update(await readFile(join(outputDirectory, name)))
      .digest('hex')
  }))
)
const manifestPath = join(outputDirectory, 'manifest.json')
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      version: 'compact-short-side-production-provenance-v2',
      generatedAt: new Date().toISOString(),
      sourceCommit,
      command: ['pnpm', 'gate:compact-nine-baselines', '--output-dir', '<output-directory>'],
      runtime: {
        node: process.version,
        v8: process.versions.v8
      },
      svgRenderer: SVG_RENDERER_SCRIPT,
      execution: {
        maximumConcurrentAlgorithmProcesses: 1,
        algorithmCases: BASELINES.length * 2,
        materializedLayouts: layoutRecords.length,
        strictlySequential: true
      },
      artifacts
    },
    null,
    2
  )}\n`
)
const checksumEntries = [
  ...artifacts,
  {
    name: 'manifest.json',
    sha256: createHash('sha256')
      .update(await readFile(manifestPath))
      .digest('hex')
  }
]
const checksumPath = join(outputDirectory, 'SHA256SUMS')
await writeFile(
  checksumPath,
  `${checksumEntries.map(({ sha256, name }) => `${sha256}  ${name}`).join('\n')}\n`
)
for (const { sha256, name } of checksumEntries) {
  const verified = createHash('sha256')
    .update(await readFile(join(outputDirectory, name)))
    .digest('hex')
  if (verified !== sha256) {
    throw new Error(`provenance checksum mismatch for ${name}`)
  }
}
const passed = outcomes.every((outcome) => outcome.passed) && layoutContractPassed
console.log(
  JSON.stringify({
    outputDirectory,
    caseCount: BASELINES.length,
    layoutCount: layoutRecords.length,
    compactLayoutCount,
    shortSideLayoutCount,
    guardedStage1WinnerCount,
    terminalPairFoldWinnerCount,
    terminalMultiRowShelfWinnerCount,
    terminalContactStripWinnerCount,
    compactFallbackCount,
    directionalSuccessCount,
    shortSideSatisfiedByCompactCount,
    directionalMissCount,
    passed
  })
)
if (!passed) process.exitCode = 1
