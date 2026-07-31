import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NATIVE_PACKAGE_ROOT = resolve(REPOSITORY_ROOT, 'crates/irregular-nesting-native')
const CLIPPER_LICENSE_PATH = resolve(NATIVE_PACKAGE_ROOT, 'LICENSES/clipper2-ts-BSL-1.0.txt')
const UPSTREAM_CLIPPER_LICENSE_PATH = resolve(REPOSITORY_ROOT, 'node_modules/clipper2-ts/LICENSE')
const CLIPPER_DERIVATIVE_PATHS = [
  'src/clipper/core.rs',
  'src/clipper/engine.rs',
  'src/clipper/offset.rs'
]
const UPSTREAM_COPYRIGHT_NOTICE = 'Copyright: Angus Johnson 2010-2025'
const UPSTREAM_LICENSE_REFERENCE = 'License: https://www.boost.org/LICENSE_1_0.txt'

function readNativePackageFile(relativePath) {
  return readFileSync(resolve(NATIVE_PACKAGE_ROOT, relativePath))
}

test('keeps the upstream copyright and license reference in every Clipper2 derivative', () => {
  for (const relativePath of CLIPPER_DERIVATIVE_PATHS) {
    const source = readNativePackageFile(relativePath).toString('utf8')
    assert.match(source, /Vendor-translated port of `clipper2-ts@2\.0\.1-18`/)
    assert.ok(source.includes(UPSTREAM_COPYRIGHT_NOTICE), `${relativePath} lacks copyright`)
    assert.ok(
      source.includes(UPSTREAM_LICENSE_REFERENCE),
      `${relativePath} lacks license reference`
    )
  }
})

test('copies the complete vendored Clipper2 license byte for byte', () => {
  assert.deepEqual(readFileSync(CLIPPER_LICENSE_PATH), readFileSync(UPSTREAM_CLIPPER_LICENSE_PATH))
})

test('attributes Clipper2 and points to the complete package license from NOTICE', () => {
  const notice = readNativePackageFile('NOTICE').toString('utf8')
  assert.ok(notice.includes(UPSTREAM_COPYRIGHT_NOTICE))
  assert.match(notice, /LICENSES\/clipper2-ts-BSL-1\.0\.txt/)
})

test('publishes the complete Clipper2 license in the native package tarball', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: NATIVE_PACKAGE_ROOT,
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
  const [packageReport] = JSON.parse(result.stdout)
  assert.ok(packageReport.files.some(({ path }) => path === 'LICENSES/clipper2-ts-BSL-1.0.txt'))
})

test('copies native legal notices into Electron resources', () => {
  const electronBuilder = readFileSync(resolve(REPOSITORY_ROOT, 'electron-builder.yml'), 'utf8')
  assert.match(electronBuilder, /from: crates\/irregular-nesting-native\/NOTICE/)
  assert.match(electronBuilder, /to: LICENSES\/irregular-nesting-native\/NOTICE/)
  assert.match(electronBuilder, /from: crates\/irregular-nesting-native\/LICENSES/)
  assert.match(electronBuilder, /to: LICENSES\/irregular-nesting-native\/LICENSES/)
})

test('runs license compliance checks through the native packaging contract suite', () => {
  const rootPackage = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  assert.match(
    rootPackage.scripts['test:native:package'],
    /scripts\/verify-native-license-compliance\.test\.mjs/
  )
})
