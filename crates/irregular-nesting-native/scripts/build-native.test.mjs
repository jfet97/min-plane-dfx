import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import test from 'node:test'
import { resolve } from 'node:path'
import { artifactPathForTarget, resolveNativeTarget, stagedAddonFileName } from '../npm/target.cjs'

const require = createRequire(import.meta.url)
const { cargoBuildArgsForTarget, resolveNativeTargetByCargoTarget } = require('../npm/target.cjs')
const CRATE_ROOT = resolve(import.meta.dirname, '..')

const TARGETS = [
  {
    platform: 'linux',
    arch: 'x64',
    cargoTarget: 'x86_64-unknown-linux-gnu',
    libraryFileName: 'libirregular_nesting_native.so'
  },
  {
    platform: 'win32',
    arch: 'x64',
    cargoTarget: 'x86_64-pc-windows-msvc',
    libraryFileName: 'irregular_nesting_native.dll'
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    cargoTarget: 'aarch64-apple-darwin',
    libraryFileName: 'libirregular_nesting_native.dylib'
  },
  {
    platform: 'darwin',
    arch: 'x64',
    cargoTarget: 'x86_64-apple-darwin',
    libraryFileName: 'libirregular_nesting_native.dylib'
  }
]

test('maps every supported deployment platform to its Cargo target', () => {
  for (const target of TARGETS) {
    assert.deepEqual(resolveNativeTarget(target.platform, target.arch), target)
  }
})

test('uses platform and architecture in each staged addon filename', () => {
  for (const target of TARGETS) {
    assert.equal(
      stagedAddonFileName(target.platform, target.arch),
      `irregular-nesting-native.${target.platform}-${target.arch}.node`
    )
  }
})

test('resolves explicit Cargo target triples before staging their addon', () => {
  for (const target of TARGETS) {
    assert.deepEqual(resolveNativeTargetByCargoTarget(target.cargoTarget), target)
  }
})

test('discovers release and development artifacts in Cargo target triple directories', () => {
  for (const target of TARGETS) {
    assert.equal(
      artifactPathForTarget(CRATE_ROOT, target.platform, target.arch, 'release'),
      resolve(CRATE_ROOT, 'target', target.cargoTarget, 'release', target.libraryFileName)
    )
    assert.equal(
      artifactPathForTarget(CRATE_ROOT, target.platform, target.arch, 'dev'),
      resolve(CRATE_ROOT, 'target', target.cargoTarget, 'debug', target.libraryFileName)
    )
  }
})

test('passes the mapped Cargo target explicitly for every deployment build', () => {
  for (const target of TARGETS) {
    assert.deepEqual(cargoBuildArgsForTarget(target.platform, target.arch, 'release'), [
      'build',
      '--release',
      '--target',
      target.cargoTarget
    ])
  }
})

test('rejects unsupported targets before Cargo executes', () => {
  assert.throws(
    () => resolveNativeTarget('linux', 'arm64'),
    /unsupported native addon target "linux-arm64"/
  )
})

test(
  'stages a macOS addon that dyld can load after copying the Cargo artifact',
  { skip: process.platform !== 'darwin' },
  () => {
    const nativeTarget = resolveNativeTarget(process.platform, process.arch)
    const build = spawnSync(
      process.execPath,
      [
        resolve(CRATE_ROOT, 'scripts', 'build-native.mjs'),
        '--profile',
        'release',
        '--target',
        nativeTarget.cargoTarget
      ],
      { cwd: CRATE_ROOT, encoding: 'utf8' }
    )
    assert.equal(build.status, 0, build.stderr || build.stdout)

    const stagedPath = resolve(
      CRATE_ROOT,
      'npm',
      stagedAddonFileName(nativeTarget.platform, nativeTarget.arch)
    )
    const signature = spawnSync('codesign', ['-dvvv', stagedPath], {
      cwd: CRATE_ROOT,
      encoding: 'utf8'
    })
    assert.equal(signature.status, 0, signature.stderr || signature.stdout)
    assert.doesNotMatch(signature.stderr, /linker-signed/)

    const load = spawnSync(
      process.execPath,
      ['-e', "require('./npm/index.cjs'); process.stdout.write('loaded')"],
      { cwd: CRATE_ROOT, encoding: 'utf8' }
    )
    assert.equal(load.signal, null, `addon load terminated by ${String(load.signal)}`)
    assert.equal(load.status, 0, load.stderr || load.stdout)
    assert.equal(load.stdout, 'loaded')
  }
)
