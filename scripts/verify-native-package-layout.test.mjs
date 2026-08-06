import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NATIVE_PACKAGE_ROOT = resolve(REPOSITORY_ROOT, 'node_modules/irregular-nesting-native')
const PACKAGE_NAME = '@jfet07-polygon-labs/polygon-nesting'
const PACKAGE_VERSION = '0.1.0'
const PACKAGE_SPECIFIER = `npm:${PACKAGE_NAME}@${PACKAGE_VERSION}`
const PACKAGE_INTEGRITY =
  'sha512-G2JAAjZ8D8q+8lA7SpZD2uGURQsdfDZB2W1UlInp2oMb/MQjp9HpKNt7/CAb/Dj9zyATzRrjVBlYSQr4uI/lPQ=='
const PACKAGE_TARBALL =
  'https://npm.pkg.github.com/download/@jfet07-polygon-labs/polygon-nesting/0.1.0/5d18869d132144b5ec47cee9650df229b2e2fa47'

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

test('pins the private native package through the stable dependency key', () => {
  const rootPackage = readJson('package.json')
  assert.equal(rootPackage.dependencies['irregular-nesting-native'], PACKAGE_SPECIFIER)

  const lockfile = readText('pnpm-lock.yaml')
  assert.match(lockfile, /specifier: npm:@jfet07-polygon-labs\/polygon-nesting@0\.1\.0/)
  assert.match(lockfile, /version: '@jfet07-polygon-labs\/polygon-nesting@0\.1\.0'/)
  assert.ok(lockfile.includes(`integrity: ${PACKAGE_INTEGRITY}`))
  assert.ok(lockfile.includes(`tarball: ${PACKAGE_TARBALL}`))
  assert.doesNotMatch(lockfile, /link:crates\/irregular-nesting-native/)

  const workspace = readText('pnpm-workspace.yaml')
  assert.match(
    workspace,
    /minimumReleaseAgeExclude:\n  - '@jfet07-polygon-labs\/polygon-nesting@0\.1\.0'/
  )
  assert.doesNotMatch(workspace, /minimumReleaseAge:\s*0/)
})

test('configures GitHub Packages without committing a credential', () => {
  assert.equal(
    readText('.npmrc'),
    ['@jfet07-polygon-labs:registry=https://npm.pkg.github.com', ''].join('\n')
  )
})

test('installs the exact portable package and all four native targets', () => {
  const packageManifest = JSON.parse(
    readFileSync(resolve(NATIVE_PACKAGE_ROOT, 'package.json'), 'utf8')
  )
  assert.equal(packageManifest.name, PACKAGE_NAME)
  assert.equal(packageManifest.version, PACKAGE_VERSION)
  assert.deepEqual(listFiles(NATIVE_PACKAGE_ROOT), [
    'LICENSES/clipper2-ts-BSL-1.0.txt',
    'NOTICE',
    'npm/index.cjs',
    'npm/irregular-nesting-native.darwin-arm64.node',
    'npm/irregular-nesting-native.darwin-x64.node',
    'npm/irregular-nesting-native.linux-x64.node',
    'npm/irregular-nesting-native.win32-x64.node',
    'npm/target.cjs',
    'package.json'
  ])
})

test('loads the addon by the unchanged runtime package key', () => {
  const loader = readText('src/workers/irregular/native/loadNativeBackend.ts')
  assert.match(loader, /require\('irregular-nesting-native'\)/)
  assert.doesNotMatch(loader, /crates[\\/]irregular-nesting-native/)

  const workerBuild = readText('vite.worker.config.ts')
  assert.match(workerBuild, /'irregular-nesting-native'/)
})

test('packages the installed dependency without workspace staging', () => {
  const rootPackage = readJson('package.json')
  assert.equal(
    rootPackage.scripts['package:native:electron'],
    'node scripts/package-electron-with-native.mjs'
  )

  const wrapper = readText('scripts/package-electron-with-native.mjs')
  assert.match(wrapper, /@jfet07-polygon-labs\/polygon-nesting/)
  assert.match(wrapper, /EXPECTED_PACKAGE_VERSION = '0\.1\.0'/)
  for (const target of ['linux-x64', 'win32-x64', 'darwin-arm64', 'darwin-x64']) {
    assert.ok(wrapper.includes(`'${target}'`))
  }
  assert.doesNotMatch(wrapper, /stageNativePackageForElectron|renameSync|workspace-link/)
  assert.equal(
    existsSync(resolve(REPOSITORY_ROOT, 'scripts/stage-native-package-for-electron.mjs')),
    false
  )

  const electronBuilder = readText('electron-builder.yml')
  assert.match(electronBuilder, /node_modules\/irregular-nesting-native\/npm\/\*\.node/)
  assert.match(electronBuilder, /node_modules\/better-sqlite3\/build\/Release\/\*\.node/)
  assert.doesNotMatch(electronBuilder, /\*\*\/\*\.node/)
})

test('removes embedded Rust build, parity, and CI integration', () => {
  const rootPackage = readJson('package.json')
  for (const scriptName of [
    'build:native',
    'benchmark:p5:linux',
    'test:differential',
    'test:differential:exact',
    'gate:quality-acceptance'
  ]) {
    assert.equal(rootPackage.scripts[scriptName], undefined)
  }

  for (const relativePath of [
    'crates/irregular-nesting-native',
    'scripts/rust-parity',
    'docker/p5-runner.Dockerfile',
    'docker/p5-controlled-host.contract.json',
    '.github/workflows/rust-native.yml',
    '.github/workflows/capture-old-rust-parity.yml'
  ]) {
    assert.equal(existsSync(resolve(REPOSITORY_ROOT, relativePath)), false, relativePath)
  }

  assert.doesNotMatch(readText('pnpm-workspace.yaml'), /crates\/\*/)
})

test('runs the external package contracts through the root script', () => {
  const rootPackage = readJson('package.json')
  assert.equal(
    rootPackage.scripts['test:native:package'],
    'node --test scripts/verify-native-license-compliance.test.mjs scripts/verify-native-package-layout.test.mjs scripts/verify-packaged-native-load.test.mjs'
  )
})
