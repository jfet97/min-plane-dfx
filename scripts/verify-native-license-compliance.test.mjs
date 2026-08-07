import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NATIVE_PACKAGE_ROOT = resolve(REPOSITORY_ROOT, 'node_modules/irregular-nesting-native')
const CLIPPER_LICENSE_PATH = resolve(NATIVE_PACKAGE_ROOT, 'LICENSES/clipper2-ts-BSL-1.0.txt')
const UPSTREAM_CLIPPER_LICENSE_PATH = resolve(REPOSITORY_ROOT, 'node_modules/clipper2-ts/LICENSE')
const NATIVE_NOTICE_PATH = resolve(NATIVE_PACKAGE_ROOT, 'NOTICE')
const UPSTREAM_COPYRIGHT_NOTICE = 'Copyright: Angus Johnson 2010-2025'

test('keeps the complete Clipper2 license in the installed native package', () => {
  assert.deepEqual(readFileSync(CLIPPER_LICENSE_PATH), readFileSync(UPSTREAM_CLIPPER_LICENSE_PATH))
})

test('keeps the Clipper2 attribution in the installed native package notice', () => {
  const notice = readFileSync(NATIVE_NOTICE_PATH, 'utf8')
  assert.ok(notice.includes(UPSTREAM_COPYRIGHT_NOTICE))
  assert.match(notice, /LICENSES\/clipper2-ts-BSL-1\.0\.txt/)
})

test('copies installed native legal notices into Electron resources', () => {
  const electronBuilder = readFileSync(resolve(REPOSITORY_ROOT, 'electron-builder.yml'), 'utf8')
  assert.match(electronBuilder, /from: node_modules\/irregular-nesting-native\/NOTICE/)
  assert.match(electronBuilder, /to: LICENSES\/irregular-nesting-native\/NOTICE/)
  assert.match(electronBuilder, /from: node_modules\/irregular-nesting-native\/LICENSES/)
  assert.match(electronBuilder, /to: LICENSES\/irregular-nesting-native\/LICENSES/)
})

test('runs license compliance checks through the native package contract suite', () => {
  const rootPackage = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  assert.match(
    rootPackage.scripts['test:native:package'],
    /scripts\/verify-native-license-compliance\.test\.mjs/
  )
})
