import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MATRIX_BACKEND_MODULE = resolve(REPOSITORY_ROOT, 'scripts/lib/irregularMatrixBackend.ts')

function readText(relativePath) {
  return readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8')
}

function evaluateBackendArgument(source) {
  assert.equal(
    existsSync(MATRIX_BACKEND_MODULE),
    true,
    'scripts/lib/irregularMatrixBackend.ts must define the shared matrix CLI parser'
  )
  const evaluation = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import { parseIrregularMatrixBackend } from './scripts/lib/irregularMatrixBackend.ts'; console.log(parseIrregularMatrixBackend(${source}))`
    ],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' }
  )
  return evaluation
}

test('routes the compact baseline through the shared production backend executor', () => {
  const sharedExecutorPath = resolve(
    REPOSITORY_ROOT,
    'src/workers/irregular/productionIrregularBackend.ts'
  )
  assert.equal(existsSync(sharedExecutorPath), true, 'shared production executor must exist')

  const baseline = readText('scripts/irregular-compact-baseline.ts')
  assert.match(baseline, /productionIrregularBackend\.js/)
  assert.match(baseline, /executeProductionIrregularBackend/)
  assert.doesNotMatch(baseline, /\bcomputeIrregularNesting\s*\(/)

  const worker = readText('src/workers/nesting.worker.ts')
  assert.match(worker, /executeProductionIrregularBackend/)
  assert.doesNotMatch(worker, /computeIrregularNestingNative/)
  assert.doesNotMatch(worker, /probeNativeIrregularAddon/)
})

test('defaults the compact matrix backend to Rust', () => {
  const evaluation = evaluateBackendArgument('undefined')
  assert.equal(evaluation.status, 0, evaluation.stderr)
  assert.equal(evaluation.stdout.trim(), 'rust')
})

test('accepts an explicit TypeScript diagnostic backend', () => {
  const evaluation = evaluateBackendArgument("'typescript'")
  assert.equal(evaluation.status, 0, evaluation.stderr)
  assert.equal(evaluation.stdout.trim(), 'typescript')
})

test('rejects unsupported compact matrix backends', () => {
  const evaluation = evaluateBackendArgument("'auto'")
  assert.notEqual(evaluation.status, 0)
  assert.match(evaluation.stderr, /--backend must be rust or typescript/)
})

test('uses a protocol-valid effectively unlimited timeout for native matrix requests', () => {
  const baseline = readText('scripts/irregular-compact-baseline.ts')
  assert.equal(baseline.split('timeoutMs: Number.MAX_SAFE_INTEGER').length - 1, 2)
  assert.doesNotMatch(baseline, /timeoutMs: 0/)
})

test('records backend identity and native diagnostics in compact reports', () => {
  const baseline = readText('scripts/irregular-compact-baseline.ts')
  const sharedExecutor = readText('src/workers/irregular/productionIrregularBackend.ts')
  assert.match(baseline, /backend: args\.backend/)
  assert.match(baseline, /nativeDiagnostics/)
  assert.match(sharedExecutor, /requestedThreadCount/)
  assert.match(sharedExecutor, /actualThreadCount/)
  assert.match(sharedExecutor, /nativeWallClockMs/)
})

test('propagates backend selection and provenance across both matrix profiles', () => {
  const matrix = readText('scripts/irregular-compact-nine-baselines.ts')
  assert.match(matrix, /parseIrregularMatrixBackend/)
  assert.equal(matrix.split("'--backend'").length - 1, 4)
  assert.match(matrix, /backend: selectedBackend/)
  assert.match(matrix, /nativeDiagnostics/)
  assert.match(matrix, /strictlySequential: true/)
})

test('keeps the published package layout contract and exact 0.1.0 pin', () => {
  const rootPackage = JSON.parse(readText('package.json'))
  assert.equal(
    rootPackage.dependencies['irregular-nesting-native'],
    'npm:@jfet07-polygon-labs/polygon-nesting@0.1.0'
  )
  assert.match(
    rootPackage.scripts['test:native:package'],
    /verify-native-matrix-execution\.test\.mjs/
  )

  const packageContract = readText('scripts/verify-native-package-layout.test.mjs')
  assert.match(packageContract, /const PACKAGE_VERSION = '0\.1\.0'/)
  assert.match(packageContract, /irregular-nesting-native\.darwin-arm64\.node/)
  assert.match(packageContract, /irregular-nesting-native\.linux-x64\.node/)
  assert.match(packageContract, /irregular-nesting-native\.win32-x64\.node/)
})
