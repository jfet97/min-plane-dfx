#!/usr/bin/env node
/**
 * Builds the irregular-nesting-native Rust crate for one supported target and
 * stages its `.node` addon into npm/ for the CommonJS package loader.
 *
 * Usage:
 *   node scripts/build-native.mjs [--profile <release|dev>] [--target <triple>]
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import target from '../npm/target.cjs'

const {
  artifactPathForTarget,
  cargoBuildArgsForTarget,
  resolveNativeTarget,
  resolveNativeTargetByCargoTarget,
  stagedAddonFileName
} = target
const CRATE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function parseArgs(argv) {
  let profile = 'release'
  let cargoTarget
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') {
      profile = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
    } else if (arg === '--target') {
      cargoTarget = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--target=')) {
      cargoTarget = arg.slice('--target='.length)
    }
  }
  return { profile, cargoTarget }
}

function buildNativeCrate(profile, nativeTarget) {
  const args = cargoBuildArgsForTarget(nativeTarget.platform, nativeTarget.arch, profile)
  console.log(`[build-native] running: cargo ${args.join(' ')} (cwd=${CRATE_ROOT})`)
  execFileSync('cargo', args, { cwd: CRATE_ROOT, stdio: 'inherit' })
}

function stageAddonForTarget(profile, nativeTarget) {
  const builtPath = artifactPathForTarget(
    CRATE_ROOT,
    nativeTarget.platform,
    nativeTarget.arch,
    profile
  )
  if (!existsSync(builtPath)) {
    throw new Error(
      `[build-native] expected build artifact not found at ${builtPath}. ` +
        'Check the cargo build output above for errors.'
    )
  }

  const npmDir = join(CRATE_ROOT, 'npm')
  mkdirSync(npmDir, { recursive: true })

  const destFileName = stagedAddonFileName(nativeTarget.platform, nativeTarget.arch)
  const destPath = join(npmDir, destFileName)
  copyFileSync(builtPath, destPath)
  console.log(`[build-native] copied ${builtPath} -> ${destPath}`)
}

function main() {
  const { profile, cargoTarget } = parseArgs(process.argv.slice(2))
  const nativeTarget =
    cargoTarget === undefined
      ? resolveNativeTarget(process.platform, process.arch)
      : resolveNativeTargetByCargoTarget(cargoTarget)
  buildNativeCrate(profile, nativeTarget)
  stageAddonForTarget(profile, nativeTarget)
}

main()
