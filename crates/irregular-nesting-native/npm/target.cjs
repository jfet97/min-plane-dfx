'use strict'

const NATIVE_TARGETS = Object.freeze({
  'linux-x64': Object.freeze({
    platform: 'linux',
    arch: 'x64',
    cargoTarget: 'x86_64-unknown-linux-gnu',
    libraryFileName: 'libirregular_nesting_native.so'
  }),
  'win32-x64': Object.freeze({
    platform: 'win32',
    arch: 'x64',
    cargoTarget: 'x86_64-pc-windows-msvc',
    libraryFileName: 'irregular_nesting_native.dll'
  }),
  'darwin-arm64': Object.freeze({
    platform: 'darwin',
    arch: 'arm64',
    cargoTarget: 'aarch64-apple-darwin',
    libraryFileName: 'libirregular_nesting_native.dylib'
  }),
  'darwin-x64': Object.freeze({
    platform: 'darwin',
    arch: 'x64',
    cargoTarget: 'x86_64-apple-darwin',
    libraryFileName: 'libirregular_nesting_native.dylib'
  })
})

function resolveNativeTarget(platform, arch) {
  const target = NATIVE_TARGETS[`${platform}-${arch}`]
  if (target === undefined) {
    throw new Error(`unsupported native addon target "${platform}-${arch}"`)
  }
  return target
}

function resolveNativeTargetByCargoTarget(cargoTarget) {
  const target = Object.values(NATIVE_TARGETS).find(
    (candidate) => candidate.cargoTarget === cargoTarget
  )
  if (target === undefined) {
    throw new Error(`unsupported Cargo target "${cargoTarget}"`)
  }
  return target
}

function stagedAddonFileName(platform, arch) {
  resolveNativeTarget(platform, arch)
  return `irregular-nesting-native.${platform}-${arch}.node`
}

function cargoBuildArgsForTarget(platform, arch, profile) {
  const { cargoTarget } = resolveNativeTarget(platform, arch)
  const profileArgs =
    profile === 'release' ? ['--release'] : profile === 'dev' ? [] : ['--profile', profile]
  return ['build', ...profileArgs, '--target', cargoTarget]
}

function artifactPathForTarget(crateRoot, platform, arch, profile) {
  const { cargoTarget, libraryFileName } = resolveNativeTarget(platform, arch)
  const targetProfile = profile === 'dev' ? 'debug' : profile
  return require('node:path').join(crateRoot, 'target', cargoTarget, targetProfile, libraryFileName)
}

module.exports = {
  artifactPathForTarget,
  cargoBuildArgsForTarget,
  resolveNativeTarget,
  resolveNativeTargetByCargoTarget,
  stagedAddonFileName
}
