import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  intrinsicShortSideAxes,
  intrinsicShortSideSpan
} from '../src/workers/algorithm/irregular/intrinsicShortSideAxes.js'

interface Baseline {
  readonly fixture: 'triangle-20' | 'mixed-61' | 'shapes-17'
  readonly sheet: '2000x2700' | '600x400' | '300x300'
  readonly collisionIdentitySha256: string
  readonly fittedCanonicalSha256: string
  readonly placedCount: number
  readonly unplacedCount: number
  readonly maximumAreaMm2: number
  readonly maximumCanonicalCavities: number
  readonly shortSideMaximumCanonicalCavities?: number
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
    shortSideMaximumCanonicalCavities: 1,
    maximumElapsedMs: 330_000,
    shortSideCollisionIdentitySha256:
      'c38a0cb4bb7765e4db102869224ef5b51f2a0bbc787cea05adf94ca0e2fe5e22',
    shortSideFittedCanonicalSha256:
      '2a63c729108ba7680339cebaf86d4e39368a020eee95580caf9811d6d2bbc2ca',
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
      'b1902994bbc318522d3684b32ec3fba692aad0116ef9dad2985a1a32cdb1a2df',
    shortSideFittedCanonicalSha256:
      '90bc2d76ef247394edd0719693c3aada9d8db7f9b334ccda3bcfd3c3559f8135',
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
      '6ca8e267b18556ae57f459a33cf2cccbf885bac1f0f362eaad8c676d9d189196',
    shortSideFittedCanonicalSha256:
      'fd075d118e29a5089ea684bc5af26ad4cf83f560fc7a525316d96921549957b2',
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
      '7a2d7906095f69b8def581738fd68d4ca9e27ee223f32646367e6fd71658675e',
    shortSideFittedCanonicalSha256:
      '86d65b16b47cfe43936db0fe383ac66408d811880c9dc52fb3ea4bf572933e67',
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
    shortSideMaximumCanonicalCavities: 2,
    maximumElapsedMs: 120_000,
    shortSideCollisionIdentitySha256:
      'ec2d5653fa92f45a96bf48143a216fe93e0908c5b3f2c8a571c869e4e7baace7',
    shortSideFittedCanonicalSha256:
      '3812e0e1c7731f6ffcf9ae20a946c357fb41c460911dd185632003af6d306fc4',
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
      'f7ddba15b5122ec7335c17bf2fe01851a9061ad500742f1efbcc716d9cc5cc55',
    shortSideFittedCanonicalSha256:
      'c149a21ba24b32fb029e0e5ac8cf515483ccbce673750f7458a95bf522b011b5',
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
      'e0647c8175bfadb7c158720978b7e2f0b9ab44496ac55bb90f42205fd17f7858',
    shortSideFittedCanonicalSha256:
      'c37e7e68e19c7ac35195def7324091782dcfb4d933c716f0cca7a3f10ee15707',
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
      '5d1412d3c3591612bffa40a451ab8f60e5cafaa6ad69ae1aaecaf18653067d9c',
    shortSideFittedCanonicalSha256:
      '454ed333f6e94089e94f5569ef6ac7f53c43d9a95862a05abca18d214104a005',
    shortSidePlacedCount: 5,
    shortSideUnplacedCount: 12
  }
]

const SVG_RENDERER_SCRIPT =
  process.env.IRREGULAR_SVG_RENDERER_SCRIPT ??
  (process.env.IRREGULAR_SVG_RENDERER === 'magick'
    ? 'scripts/render-svg-magick.cjs'
    : '.agents/skills/render-svg-with-electron/scripts/render-svg.cjs')

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

function hasArgument(name: string): boolean {
  return process.argv.includes(name)
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
    String(baseline.shortSideMaximumCanonicalCavities ?? baseline.maximumCanonicalCavities),
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
const skipPng = hasArgument('--skip-png')
const resumeExisting = hasArgument('--resume-existing')
const reusePng = hasArgument('--reuse-png')
await mkdir(outputDirectory, { recursive: true })

const outcomes: Array<{
  readonly fixture: Baseline['fixture']
  readonly sheet: Baseline['sheet']
  readonly passed: boolean
  readonly error?: string
}> = []
if (!resumeExisting) {
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
    readonly placedPieceIds: ReadonlyArray<string | undefined>
    readonly unplacedCount: number
    readonly unplacedPieceIds: ReadonlyArray<string>
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
      readonly directionalAdmissionTerms?: {
        readonly shortEdgeFillAdmitted: boolean
        readonly shortfallHalved: boolean
        readonly depthWithinProductionMaximumSide: boolean
        readonly envelopeAreaCostWithinProductionBound: boolean
      }
    }
    readonly intrinsicShortSidePairFoldTrace?: {
      readonly status: string
      readonly outputInfluence: 'none' | 'selected'
      readonly constructionKind?: 'pair-fold' | 'multi-row-shelf' | 'contact-strip'
      readonly envelopeAreaCostVetoes?: ReadonlyArray<unknown>
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
if (resumeExisting) {
  for (let index = 0; index < BASELINES.length; index += 1) {
    const baseline = BASELINES[index]
    const compactReport = compactReports[index]
    const shortSideReport = shortSideReports[index]
    if (baseline === undefined || compactReport === undefined || shortSideReport === undefined) {
      throw new Error(`missing resumed layout report at matrix index ${index}`)
    }
    outcomes.push({
      fixture: baseline.fixture,
      sheet: baseline.sheet,
      passed: compactReport.passed && shortSideReport.passed
    })
  }
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
  if (!skipPng && !reusePng) {
    renderSvgToPng(join(outputDirectory, compactReport.svgPath), compactPngPath)
    renderSvgToPng(join(outputDirectory, shortSideReport.svgPath), shortSidePngPath)
  } else if (!skipPng) {
    await access(compactPngPath)
    await access(shortSidePngPath)
  }
  const archiveSelected =
    shortSideReport.result.intrinsicShortSideObserverTrace?.outputInfluence === 'selected'
  const terminalTrace = shortSideReport.result.intrinsicShortSidePairFoldTrace
  const terminalSelected = terminalTrace?.outputInfluence === 'selected'
  const shortSideSource = archiveSelected
    ? ('guarded-stage1-winner' as const)
    : terminalSelected
      ? terminalTrace.constructionKind === 'contact-strip'
        ? ('terminal-contact-strip-winner' as const)
        : terminalTrace.constructionKind === 'multi-row-shelf'
          ? ('terminal-multi-row-shelf-winner' as const)
          : ('terminal-pair-fold-winner' as const)
      : ('missing-directional-output' as const)
  const shortAxisSpan = intrinsicShortSideSpan(
    intrinsicShortSideAxes(shortSideReport.sheet),
    shortSideReport.result.bounds
  )
  const shortAxisFillRatio =
    shortAxisSpan / Math.min(shortSideReport.sheet.width, shortSideReport.sheet.height)
  const profileOutcome =
    shortSideSource === 'missing-directional-output'
      ? ('directional-miss' as const)
      : ('directional-success' as const)
  const inheritedSubsetMatchesCompact =
    JSON.stringify([...shortSideReport.result.unplacedPieceIds].toSorted()) ===
    JSON.stringify([...compactReport.result.unplacedPieceIds].toSorted())
  const selectedPartitionMatchesCompact =
    JSON.stringify(
      [...shortSideReport.result.placedPieceIds].toSorted((first, second) =>
        String(first).localeCompare(String(second))
      )
    ) ===
      JSON.stringify(
        [...compactReport.result.placedPieceIds].toSorted((first, second) =>
          String(first).localeCompare(String(second))
        )
      ) && inheritedSubsetMatchesCompact
  layoutRecords.push(
    {
      fixture: baseline.fixture,
      sheet: baseline.sheet,
      profile: 'compact',
      source: 'production-compact',
      strategyId: compactReport.workerOutput.strategyId,
      placedCount: compactReport.result.placedCount,
      unplacedCount: compactReport.result.unplacedCount,
      unplacedPieceIds: compactReport.result.unplacedPieceIds,
      collisionIdentitySha256: compactReport.result.collisionIdentitySha256,
      fittedCanonicalSha256: compactReport.result.fittedCanonicalSha256,
      canonicalCavities: compactReport.result.canonicalTopology?.enclosedCavityCount,
      bounds: compactReport.result.bounds,
      exactPiecePartition: compactReport.checks.exactPiecePartition,
      passed: compactReport.objectiveProfile === 'compact' && compactReport.passed,
      svgPath: compactReport.svgPath,
      pngPath: skipPng ? undefined : basename(compactPngPath)
    },
    {
      fixture: baseline.fixture,
      sheet: baseline.sheet,
      profile: 'short-side',
      source: shortSideSource,
      strategyId: shortSideReport.workerOutput.strategyId,
      profileOutcome,
      shortAxisFillRatio,
      observerStatus: shortSideReport.result.intrinsicShortSideObserverTrace?.status ?? 'missing',
      inheritedSubsetMatchesCompact,
      selectedPartitionMatchesCompact,
      selectedRotationDeg:
        shortSideReport.result.intrinsicShortSideObserverTrace?.observerWinnerRotationDeg,
      placedCount: shortSideReport.result.placedCount,
      unplacedCount: shortSideReport.result.unplacedCount,
      unplacedPieceIds: shortSideReport.result.unplacedPieceIds,
      collisionIdentitySha256: shortSideReport.result.collisionIdentitySha256,
      fittedCanonicalSha256: shortSideReport.result.fittedCanonicalSha256,
      canonicalCavities: shortSideReport.result.canonicalTopology?.enclosedCavityCount,
      bounds: shortSideReport.result.bounds,
      exactPiecePartition: shortSideReport.checks.exactPiecePartition,
      passed:
        shortSideReport.objectiveProfile === 'short-side' &&
        Boolean(shortSideReport.checks.exactPiecePartition) &&
        selectedPartitionMatchesCompact &&
        shortSideReport.passed,
      svgPath: shortSideReport.svgPath,
      pngPath: skipPng ? undefined : basename(shortSidePngPath)
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
  ({ profile, source }) => profile === 'short-side' && source === 'missing-directional-output'
).length
const directionalSuccessCount = layoutRecords.filter(
  ({ profile, profileOutcome }) =>
    profile === 'short-side' && profileOutcome === 'directional-success'
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
    terminalContactStripWinnerCount ===
    9 &&
  guardedStage1WinnerCount === 0 &&
  compactFallbackCount === 0 &&
  directionalSuccessCount === 9 &&
  directionalMissCount === 0 &&
  layoutRecords.every(({ exactPiecePartition, passed }) =>
    Boolean(exactPiecePartition && passed)
  ) &&
  layoutRecords
    .filter(({ profile }) => profile === 'short-side')
    .every(
      ({ inheritedSubsetMatchesCompact, selectedPartitionMatchesCompact }) =>
        inheritedSubsetMatchesCompact === true && selectedPartitionMatchesCompact === true
    )
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
      command: [
        'pnpm',
        'gate:compact-nine-baselines',
        '--output-dir',
        '<output-directory>',
        ...(resumeExisting ? ['--resume-existing'] : []),
        ...(reusePng ? ['--reuse-png'] : []),
        ...(skipPng ? ['--skip-png'] : [])
      ],
      runtime: {
        node: process.version,
        v8: process.versions.v8
      },
      svgRenderer: skipPng ? undefined : SVG_RENDERER_SCRIPT,
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
    directionalMissCount,
    passed
  })
)
if (!passed) process.exitCode = 1
