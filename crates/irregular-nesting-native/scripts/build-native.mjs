#!/usr/bin/env node
// Builds the irregular-nesting-native Rust crate and stages the resulting
// platform-specific `.node` binary into `npm/` for the CommonJS loader
// (`npm/index.cjs`) to `require()`.
//
// Usage:
//   node scripts/build-native.mjs [--profile <release|dev>]
//
// Defaults to a release build (matches production packaging). This is
// deliberately a small, direct script per the migration prompt's guidance to
// avoid building a second large tooling framework around the native crate.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRATE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const LIB_FILE_NAME_BY_PLATFORM = {
  linux: 'libirregular_nesting_native.so',
  darwin: 'libirregular_nesting_native.dylib',
  win32: 'irregular_nesting_native.dll',
};

function parseArgs(argv) {
  let profile = 'release';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile') {
      profile = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length);
    }
  }
  return { profile };
}

// Cargo's on-disk profile directory name diverges from the CLI profile name
// only for the built-in `dev` profile, which lands in `target/debug`.
function targetDirNameForProfile(profile) {
  return profile === 'dev' ? 'debug' : profile;
}

function cargoBuildArgs(profile) {
  if (profile === 'release') {
    return ['build', '--release'];
  }
  if (profile === 'dev') {
    return ['build'];
  }
  return ['build', '--profile', profile];
}

function buildNativeCrate(profile) {
  const args = cargoBuildArgs(profile);
  console.log(`[build-native] running: cargo ${args.join(' ')} (cwd=${CRATE_ROOT})`);
  execFileSync('cargo', args, { cwd: CRATE_ROOT, stdio: 'inherit' });
}

function stageAddonForCurrentPlatform(profile) {
  const platform = process.platform;
  const libFileName = LIB_FILE_NAME_BY_PLATFORM[platform];
  if (!libFileName) {
    const supported = Object.keys(LIB_FILE_NAME_BY_PLATFORM).join(', ');
    throw new Error(`[build-native] unsupported platform "${platform}". Supported: ${supported}.`);
  }

  const targetDirName = targetDirNameForProfile(profile);
  const builtPath = join(CRATE_ROOT, 'target', targetDirName, libFileName);
  if (!existsSync(builtPath)) {
    throw new Error(
      `[build-native] expected build artifact not found at ${builtPath}. ` +
        'Check the cargo build output above for errors.'
    );
  }

  const npmDir = join(CRATE_ROOT, 'npm');
  mkdirSync(npmDir, { recursive: true });

  const destFileName = `irregular-nesting-native.${platform}-${process.arch}.node`;
  const destPath = join(npmDir, destFileName);
  copyFileSync(builtPath, destPath);
  console.log(`[build-native] copied ${builtPath} -> ${destPath}`);
}

function main() {
  const { profile } = parseArgs(process.argv.slice(2));
  buildNativeCrate(profile);
  stageAddonForCurrentPlatform(profile);
}

main();
