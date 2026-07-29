'use strict';

// Loads the platform-appropriate irregular-nesting-native addon produced by
// `scripts/build-native.mjs`. This file is CommonJS (`.cjs`) so it can be
// `require()`d directly regardless of the consuming package's module type.
//
// The addon file itself (`irregular-nesting-native.<platform>-<arch>.node`)
// is build output and is gitignored (see `../.gitignore`); it must be built
// locally or restored from a packaging step before this module can load.

const path = require('node:path');

const platform = process.platform;
const arch = process.arch;
const binaryName = `irregular-nesting-native.${platform}-${arch}.node`;
const binaryPath = path.join(__dirname, binaryName);

let native;
try {
  // CommonJS native addon load.
  native = require(binaryPath);
} catch (cause) {
  const causeMessage = cause && cause.message ? cause.message : String(cause);
  throw new Error(
    `irregular-nesting-native: failed to load native addon "${binaryName}" from ${binaryPath}.\n` +
      'Build it first with:\n' +
      '  node crates/irregular-nesting-native/scripts/build-native.mjs\n' +
      '(runs "cargo build --release" and stages the .node binary into npm/).\n' +
      `Original error: ${causeMessage}`,
    { cause }
  );
}

module.exports = native;
