# Pre-Auto-Routing Baseline

Recorded before implementation work for automatic Rust routing.

## Checkout

- Branch: `feat/auto-rust-irregular-p5-native-performance`
- HEAD: `a8230fec397c8d6d550380003424f2fb6312fde1`
- Commit subject: `Merge pull request #27 from jfet97/rust-irregular-backend`
- Initial working tree: clean

## Machine and toolchain provenance

- OS: `Darwin 25.5.0`, kernel `Darwin Kernel Version 25.5.0: Tue Jun 9 22:28:34 PDT 2026; root:xnu-12377.121.10~1/RELEASE_ARM64_T6041`
- CPU: Apple M4 Max, 16 physical cores
- Physical memory: 68,719,476,736 bytes (64 GiB)
- Node: `v24.16.0`
- pnpm: `11.8.0`
- rustc: `1.95.0 (59807616e 2026-04-14)`, LLVM `21.1.8`
- Cargo: `1.95.0 (f2d3ce0bd 2026-03-21)`
- Rust host and build target: `aarch64-apple-darwin`
- `rustup` was not installed on this machine.

## Native release addon

`pnpm build:native` exited 0. It built the `release` artifact for `aarch64-apple-darwin` and staged `crates/irregular-nesting-native/npm/irregular-nesting-native.darwin-arm64.node`.

A direct package probe exited 0:

```sh
node -e "const addon = require('irregular-nesting-native'); console.log(JSON.stringify(addon.nativeCapability()));"
```

```json
{"apiVersion":3,"crateVersion":"0.1.0","targetTriple":"aarch64-apple-darwin","profiles":["compact","compact-short-side"]}
```

The capability API does not advertise a thread policy. The implemented policy in `crates/irregular-nesting-native/src/boundary/parallel.rs` is one job-owned Rayon pool per job, never the global pool; production resolves `MIN_PLANE_IRREGULAR_NATIVE_THREADS` as a positive integer and otherwise defaults to one thread. The explicit override is test-only.

## Pre-change gates

| Command | Result |
| --- | --- |
| `ELECTRON_RUN_AS_NODE=1 pnpm exec electron ./node_modules/vitest/vitest.mjs run tests/unit/irregularBackendSelection.test.ts tests/unit/nativeBackendLoadClassification.test.ts` | exit 0; selector and native-load classification: 2 files, 9 tests passed |
| `ELECTRON_RUN_AS_NODE=1 pnpm exec electron ./node_modules/vitest/vitest.mjs run tests/unit/irregularBackendSelection.test.ts tests/unit/irregularDifferential.test.ts` | exit 0; selector and backend router: 2 files, 16 tests passed |
| `MIN_PLANE_REQUIRE_NATIVE_ADDON=1 ELECTRON_RUN_AS_NODE=1 pnpm exec electron ./node_modules/vitest/vitest.mjs run tests/unit/nativeIrregularBackend.test.ts` | exit 0; 1 file, 28 tests passed |
| `cargo test --release --target aarch64-apple-darwin --manifest-path crates/irregular-nesting-native/Cargo.toml` | exit 0; unit suite 588 passed, 2 ignored; all integration suites passed |
| `pnpm test:native:package` | exit 0; 32 passed |
| `pnpm test:differential` | exit 0; required matrix 16/16 passed |
| `pnpm gate:mixed61-compact` | exit 0; 61/61 placed, canonical SHA-256 `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`, elapsed 32,585.843 ms |
| `pnpm gate:compact-nine-baselines --skip-png` | exit 0; 9 cases and 18 layouts passed |
| `pnpm gate:capacity` | exit 0; all 8 production fixtures passed, all 6 paired-eligible cold-only comparisons passed, and the aggregate gate passed |
| `pnpm gate:capacity:production` | exit 0; all 8 production fixtures and the aggregate gate passed |

One initial Rust test invocation, `cargo test --release --target aarch64-apple-darwin` from the repository root, exited 101 because the root has no `Cargo.toml`. The manifest-qualified invocation above is the successful authoritative release Rust test result.

Local macOS timing is non-authoritative for P5. These elapsed values establish only this machine's pre-change baseline; P5 acceptance requires its designated controlled evidence.
