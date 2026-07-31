import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { stageNativePackageForElectron } from './stage-native-package-for-electron.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8'))
}

function readText(relativePath) {
  return readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8')
}

function listFiles(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) visit(path)
      else files.push(relative(root, path))
    }
  }
  visit(root)
  return files
}

test('declares the native workspace package as a production dependency', () => {
  const rootPackage = readJson('package.json')
  assert.equal(rootPackage.dependencies['irregular-nesting-native'], 'workspace:*')
})

test('exposes the Node packaging contract suite through the root scripts', () => {
  const rootPackage = readJson('package.json')
  assert.equal(
    rootPackage.scripts['test:native:package'],
    'node --test crates/irregular-nesting-native/scripts/build-native.test.mjs scripts/verify-native-license-compliance.test.mjs scripts/verify-native-package-layout.test.mjs scripts/verify-packaged-native-load.test.mjs'
  )
})

test('publishes the loader, target binaries, and notices from the native package', () => {
  const nativePackage = readJson('crates/irregular-nesting-native/package.json')
  assert.equal(nativePackage.main, 'npm/index.cjs')
  assert.equal(nativePackage.exports, './npm/index.cjs')
  assert.deepEqual(nativePackage.files, [
    'npm/index.cjs',
    'npm/target.cjs',
    'npm/*.node',
    'NOTICE',
    'LICENSES/**'
  ])
})

test('includes a distributable native package notice', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: resolve(REPOSITORY_ROOT, 'crates/irregular-nesting-native'),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
  const [packageReport] = JSON.parse(result.stdout)
  assert.ok(packageReport.files.some(({ path }) => path === 'NOTICE'))
})

test('loads the addon by package name without checkout-relative fallbacks', () => {
  const loader = readText('src/workers/irregular/native/loadNativeBackend.ts')
  assert.match(loader, /require\('irregular-nesting-native'\)/)
  assert.doesNotMatch(loader, /crates[\\/]irregular-nesting-native/)

  const workerBuild = readText('vite.worker.config.ts')
  assert.match(workerBuild, /'irregular-nesting-native'/)
})

test('keeps native package loader failures independent from checkout paths', () => {
  const packageLoader = readText('crates/irregular-nesting-native/npm/index.cjs')
  assert.doesNotMatch(packageLoader, /crates[\\/]irregular-nesting-native/)
})

test('stages only distributable native package files before Electron packaging', () => {
  const rootPackage = readJson('package.json')
  assert.equal(
    rootPackage.scripts['package:native:electron'],
    'node scripts/package-electron-with-native.mjs'
  )

  const stagingScript = readText('scripts/stage-native-package-for-electron.mjs')
  for (const packagedPath of [
    'package.json',
    'NOTICE',
    'npm/index.cjs',
    'npm/target.cjs',
    'LICENSES'
  ]) {
    assert.match(stagingScript, new RegExp(packagedPath.replaceAll('/', '\\/')))
  }
  assert.match(stagingScript, /endsWith\('\.node'\)/)
  assert.doesNotMatch(stagingScript, /cpSync\(sourceRoot, destinationRoot/)

  const packagingWrapper = readText('scripts/package-electron-with-native.mjs')
  assert.match(packagingWrapper, /renameSync\(WORKSPACE_PACKAGE, WORKSPACE_PACKAGE_BACKUP\)/)
  assert.match(packagingWrapper, /spawnSync\(process\.execPath, \[electronBuilderCli/)
  assert.doesNotMatch(packagingWrapper, /pnpm\.cmd/)
  assert.match(packagingWrapper, /finally \{/)
  assert.match(packagingWrapper, /renameSync\(WORKSPACE_PACKAGE_BACKUP, WORKSPACE_PACKAGE\)/)

  const electronBuilder = readText('electron-builder.yml')
  assert.match(electronBuilder, /node_modules\/irregular-nesting-native\/npm\/\*\.node/)
  assert.match(electronBuilder, /node_modules\/better-sqlite3\/build\/Release\/\*\.node/)
  assert.doesNotMatch(electronBuilder, /\*\*\/\*\.node/)
})

test('staged Electron package contains no Rust workspace or target files', (context) => {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'min-plane-native-stage-'))
  const destinationRoot = resolve(temporaryDirectory, 'irregular-nesting-native')
  context.after(() => rmSync(temporaryDirectory, { force: true, recursive: true }))

  const addonFiles = stageNativePackageForElectron(
    resolve(REPOSITORY_ROOT, 'crates/irregular-nesting-native'),
    destinationRoot
  )
  assert.deepEqual(
    listFiles(destinationRoot),
    [
      'LICENSES/clipper2-ts-BSL-1.0.txt',
      'NOTICE',
      'npm/index.cjs',
      ...addonFiles.map((fileName) => `npm/${fileName}`),
      'npm/target.cjs',
      'package.json'
    ].sort()
  )
})

test('requires the real addon integration and package contract suites in native CI', () => {
  const workflow = readText('.github/workflows/rust-native.yml')
  assert.match(workflow, /MIN_PLANE_REQUIRE_NATIVE_ADDON:\s*['"]1['"]/)
  assert.match(workflow, /tests\/unit\/nativeIrregularBackend\.test\.ts/)
  assert.match(workflow, /^\s*- run: pnpm test:native:package$/m)
  assert.ok(
    workflow.indexOf('build-native.mjs --release') < workflow.indexOf('pnpm test:native:package'),
    'native package contracts must run after the staged addon exists'
  )
})

test('requires packaged native loading on every supported native runner', () => {
  const workflow = readText('.github/workflows/rust-native.yml')
  assert.match(workflow, /packaged-native-load/)
  for (const runner of ['ubuntu-24.04', 'windows-latest', 'macos-15', 'macos-15-intel']) {
    assert.match(workflow, new RegExp(`^\\s*runner: ${runner}$`, 'm'))
  }
  for (const target of [
    'x86_64-unknown-linux-gnu',
    'x86_64-pc-windows-msvc',
    'aarch64-apple-darwin',
    'x86_64-apple-darwin'
  ]) {
    assert.match(workflow, new RegExp(target))
  }
  assert.match(workflow, /scripts\/verify-packaged-native-load\.mjs/)

  const packagedJob = workflow.slice(workflow.indexOf('  packaged-native-load:'))
  assert.match(packagedJob, /^\s*- run: pnpm native:electron$/m)
  assert.match(
    packagedJob,
    /^\s*run: pnpm package:native:electron --publish=never --dir --\$\{\{ matrix\.electron_target \}\}$/m
  )
})

test('runs the full strict differential matrix only on scheduled and manual CI', () => {
  const workflow = readText('.github/workflows/rust-native.yml')
  assert.match(workflow, /^\s*schedule:/m)
  assert.match(workflow, /^\s*workflow_dispatch:/m)
  assert.match(workflow, /differential-full/)
  assert.match(workflow, /differential-fixture-matrix\.ts --strict-exploratory/)
  assert.match(workflow, /differential-required/)
  assert.match(workflow, /pnpm test:differential/)
})
