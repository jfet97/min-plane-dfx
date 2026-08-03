# Polygon Nesting Engine Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the accepted Rust polygon nesting engine into private `jfet97/polygon-nesting`, publish a unified `0.1.0` N-API package and Linux amd64 OCI image, and cut `min-plane-dfx` over to the released package without changing algorithm behavior.

**Architecture:** Import the accepted engine atomically into application-neutral `protocol` and deterministic `core` crates, then build N-API and CLI adapters over one typed execution boundary. Freeze all current semantic identities before movement, verify immutable release-candidate package and image bytes before publication, and remove embedded desktop ownership only after registry-delivery verification.

**Tech Stack:** Rust 2021, Cargo workspace, serde, serde_json with `float_roundtrip`, Rayon, napi-rs 3, Node 24, pnpm 11, Electron 33, GitHub Actions, GitHub Packages, GHCR, Docker/OCI, Azure Container Apps Jobs file contract.

---

## Repository labels used by this plan

- `SOURCE_REPO`: `/Users/andreasimonecosta/Documents/Work/min-plane-dfx`
- `SOURCE_WORKTREE`: `/Users/andreasimonecosta/Documents/Work/min-plane-dfx/.claude/worktrees/polygon-nesting-extraction`
- `ENGINE_REPO`: `/Users/andreasimonecosta/Documents/Work/polygon-nesting`
- `SOURCE_MIN_PLANE_COMMIT`: `e4f3608878611c002f343473fab72adc7d155f87`, subject to the Phase A equality recheck
- Engine release: `0.1.0`
- NPM package: `@jfet97/polygon-nesting`
- OCI image: `ghcr.io/jfet97/polygon-nesting`

## Locked file structure

### Standalone repository

```text
polygon-nesting/
  .github/workflows/ci.yml
  .github/workflows/release.yml
  .npmrc
  Cargo.toml
  Cargo.lock
  Dockerfile
  NOTICE
  LICENSES/clipper2-ts-BSL-1.0.txt
  README.md
  crates/polygon-nesting-protocol/Cargo.toml
  crates/polygon-nesting-protocol/src/lib.rs
  crates/polygon-nesting-protocol/src/error.rs
  crates/polygon-nesting-protocol/src/event.rs
  crates/polygon-nesting-protocol/src/request.rs
  crates/polygon-nesting-protocol/src/result.rs
  crates/polygon-nesting-protocol/src/version.rs
  crates/polygon-nesting-core/Cargo.toml
  crates/polygon-nesting-core/src/lib.rs
  crates/polygon-nesting-core/src/control.rs
  crates/polygon-nesting-core/src/events.rs
  crates/polygon-nesting-core/src/job.rs
  crates/polygon-nesting-core/src/parallel.rs
  crates/polygon-nesting-core/src/archive/
  crates/polygon-nesting-core/src/capacity/
  crates/polygon-nesting-core/src/caches/
  crates/polygon-nesting-core/src/canonical_grid/
  crates/polygon-nesting-core/src/checkpoints/
  crates/polygon-nesting-core/src/clipper/
  crates/polygon-nesting-core/src/domain/
  crates/polygon-nesting-core/src/geometry/
  crates/polygon-nesting-core/src/js_number/
  crates/polygon-nesting-core/src/nfp_ifp/
  crates/polygon-nesting-core/src/result/
  crates/polygon-nesting-core/src/search/
  crates/polygon-nesting-core/src/short_side/
  crates/polygon-nesting-core/src/trace/
  crates/polygon-nesting-core/src/transforms/
  crates/polygon-nesting-core/src/validation/
  crates/polygon-nesting-cli/Cargo.toml
  crates/polygon-nesting-cli/src/main.rs
  crates/polygon-nesting-cli/src/args.rs
  crates/polygon-nesting-cli/src/artifacts.rs
  crates/polygon-nesting-cli/src/exit.rs
  crates/polygon-nesting-cli/src/signals.rs
  crates/polygon-nesting-napi/Cargo.toml
  crates/polygon-nesting-napi/build.rs
  crates/polygon-nesting-napi/src/lib.rs
  crates/polygon-nesting-napi/src/compat.rs
  crates/polygon-nesting-napi/src/diagnostics.rs
  crates/polygon-nesting-napi/src/events.rs
  crates/polygon-nesting-napi/src/job.rs
  packages/polygon-nesting/package.json
  packages/polygon-nesting/npm/index.cjs
  packages/polygon-nesting/npm/target.cjs
  packages/polygon-nesting/scripts/build-native.mjs
  packages/polygon-nesting/scripts/build-native.test.mjs
  packages/polygon-nesting/scripts/worker-terminal-lifecycle-probe.mjs
  tests/vectors/core/
  tests/vectors/protocol/
  tests/fixtures/triangle-20/
  tests/fixtures/mixed-61/
  tests/fixtures/shapes-17/
  tests/integration/docker-smoke.sh
  tests/integration/frozen-corpus.rs
  docs/architecture.md
  docs/azure-container-job-contract.md
  docs/cli-contract.md
  docs/migration-from-min-plane-dfx.md
  docs/napi-compatibility.md
  docs/protocol-compatibility.md
  docs/release-evidence/0.1.0/source.json
  docs/release-evidence/0.1.0/parity.json
  docs/release-evidence/0.1.0/release.json
  docs/release-evidence/0.1.0/SHA256SUMS
```

### Source repository cutover files

```text
package.json
pnpm-lock.yaml
.npmrc
src/workers/irregular/native/loadNativeBackend.ts
scripts/package-electron-with-native.mjs
scripts/stage-native-package-for-electron.mjs
scripts/verify-native-license-compliance.test.mjs
scripts/verify-native-package-layout.test.mjs
scripts/verify-packaged-native-load.mjs
electron-builder.yml
.github/workflows/rust-native.yml
crates/irregular-nesting-native/
```

---

### Task 1: Freeze exact source and toolchain metadata

**Files:**
- Create: `SOURCE_WORKTREE/docs/artifacts/polygon-nesting-extraction-baseline/source.json`

- [ ] **Step 1: Verify the accepted source is still exact and clean**

Run from `SOURCE_REPO`:

```bash
git status --porcelain=v1
git rev-parse origin/main
gh api repos/jfet97/min-plane-dxf/commits/main --jq .sha
git diff --exit-code origin/main -- crates/irregular-nesting-native package.json pnpm-lock.yaml scripts/rust-parity scripts/irregular-compact-nine-baselines.ts scripts/irregular-capacity-gate.ts tests/fixtures
```

Expected: `origin/main` and GitHub `main` both equal `e4f3608878611c002f343473fab72adc7d155f87`, and the extraction worktree has no changes to engine, harness, or fixture paths relative to that source. The worktree may contain the committed design and plan. If the accepted source SHAs differ, stop extraction, inspect the new commits and checks, and replace every recorded source SHA only after establishing the new accepted source.

- [ ] **Step 2: Capture resolved toolchain and host facts**

Run:

```bash
node --version
pnpm --version
rustc -Vv
cargo --version
rustup show active-toolchain
rustup target list --installed
uname -a
sysctl -n machdep.cpu.brand_string
sysctl -n hw.logicalcpu
sysctl -n hw.memsize
```

Expected: commands succeed. Record exact stdout, not inferred versions.

- [ ] **Step 3: Write source metadata**

Generate `source.json` directly from command output so no manually transcribed version can drift:

```bash
node <<'NODE'
const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const run = (command, args = []) => execFileSync(command, args, { encoding: 'utf8' }).trim()
const output = 'docs/artifacts/polygon-nesting-extraction-baseline/source.json'
mkdirSync('docs/artifacts/polygon-nesting-extraction-baseline', { recursive: true })
const source = {
  sourceRepository: 'https://github.com/jfet97/min-plane-dxf',
  sourceCommit: run('git', ['rev-parse', 'origin/main']),
  engineRelease: '0.1.0',
  performanceGate: {
    freshPostCorrectionBenchmarkRequired: false,
    decision: 'owner explicitly accepted existing tests and results',
    historicalSpeedupClaimedForSource: false
  },
  toolchain: {
    node: run('node', ['--version']),
    pnpm: run('pnpm', ['--version']),
    rustc: run('rustc', ['-Vv']),
    cargo: run('cargo', ['--version'])
  },
  host: {
    os: run('uname', ['-a']),
    cpu: run('sysctl', ['-n', 'machdep.cpu.brand_string']),
    logicalCpuCount: Number(run('sysctl', ['-n', 'hw.logicalcpu'])),
    memoryBytes: Number(run('sysctl', ['-n', 'hw.memsize']))
  }
}
writeFileSync(output, `${JSON.stringify(source, null, 2)}\n`)
NODE
```

Expected: the generated source commit equals the accepted commit and every metadata value comes from the current host.

- [ ] **Step 4: Commit the metadata shell after all baseline tasks complete**

Do not commit yet. Task 2 and Task 3 populate the same evidence directory so the baseline lands as one coherent commit.

### Task 2: Run current source correctness and lifecycle gates

**Files:**
- Create: `SOURCE_WORKTREE/docs/artifacts/polygon-nesting-extraction-baseline/gates/*.log`
- Create: `SOURCE_WORKTREE/docs/artifacts/polygon-nesting-extraction-baseline/gates/results.json`

- [ ] **Step 1: Run Rust formatting and lint gates**

```bash
cargo fmt --manifest-path crates/irregular-nesting-native/Cargo.toml -- --check
cargo clippy --manifest-path crates/irregular-nesting-native/Cargo.toml --all-targets -- -D warnings
```

Expected: both exit 0.

- [ ] **Step 2: Run release Rust tests**

```bash
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml --test thread_equality
cargo test --release --manifest-path crates/irregular-nesting-native/Cargo.toml --test no_pool_global_rayon_containment
```

Expected: all tests pass. Preserve complete stdout and stderr.

- [ ] **Step 3: Build the current real addon and package checks**

```bash
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
pnpm build:native
pnpm test:native:package
MIN_PLANE_REQUIRE_NATIVE_ADDON=1 pnpm exec vitest run tests/unit/nativeIrregularBackend.test.ts
```

Expected: all commands exit 0 and the real-addon test cannot skip.

- [ ] **Step 4: Run Node and Electron lifecycle probes**

```bash
node -e "const c=require('./crates/irregular-nesting-native/npm/index.cjs').nativeCapability(); if(c.apiVersion!==3) throw new Error(JSON.stringify(c))"
ELECTRON_RUN_AS_NODE=1 pnpm exec electron -e "const c=require('./crates/irregular-nesting-native/npm/index.cjs').nativeCapability(); if(c.apiVersion!==3) throw new Error(JSON.stringify(c))"
node crates/irregular-nesting-native/scripts/worker-terminal-lifecycle-probe.mjs terminal-barrier
node crates/irregular-nesting-native/scripts/worker-terminal-lifecycle-probe.mjs cleanup-proof
ELECTRON_RUN_AS_NODE=1 pnpm exec electron crates/irregular-nesting-native/scripts/worker-terminal-lifecycle-probe.mjs terminal-barrier
ELECTRON_RUN_AS_NODE=1 pnpm exec electron crates/irregular-nesting-native/scripts/worker-terminal-lifecycle-probe.mjs cleanup-proof
```

Expected: all probes exit 0.

- [ ] **Step 5: Run differential and quality gates on the exact source**

```bash
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-js-hypot.ts --check
pnpm test:differential
pnpm test:differential:exact
pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/differential-fixture-matrix.ts --strict-exploratory --strict-exact
pnpm gate:quality-acceptance
pnpm gate:compact-nine-baselines --output-dir docs/artifacts/polygon-nesting-extraction-baseline/nine-baselines --skip-png
pnpm gate:mixed61-compact --output docs/artifacts/polygon-nesting-extraction-baseline/mixed61
pnpm gate:capacity:production
```

Expected: every required command exits 0. A strict differential failure is a baseline blocker and must be resolved in the source repository before extraction.

- [ ] **Step 6: Record machine-readable gate results**

Write `results.json` as an array of command, exit status, start timestamp, end timestamp, and log path. Every required row must have status `passed`.

### Task 3: Freeze vectors, fixtures, identities, and legal bytes

**Files:**
- Create: `SOURCE_WORKTREE/docs/artifacts/polygon-nesting-extraction-baseline/native-vectors.sha256`
- Create: `SOURCE_WORKTREE/docs/artifacts/polygon-nesting-extraction-baseline/source-fixtures.sha256`
- Create: `SOURCE_WORKTREE/docs/artifacts/polygon-nesting-extraction-baseline/legal-and-addon.sha256`
- Create: `SOURCE_WORKTREE/docs/artifacts/polygon-nesting-extraction-baseline/SHA256SUMS`
- Create: `SOURCE_WORKTREE/docs/artifacts/polygon-nesting-extraction-baseline/package-manifest.json`
- Create: `SOURCE_WORKTREE/docs/artifacts/polygon-nesting-extraction-baseline/migration-corpus.json`

- [ ] **Step 1: Hash every Rust-owned vector**

```bash
find crates/irregular-nesting-native/tests/vectors -maxdepth 1 -type f -print0 \
  | sort -z \
  | xargs -0 shasum -a 256 \
  > docs/artifacts/polygon-nesting-extraction-baseline/native-vectors.sha256
```

Expected: one line per vector and no path outside the repository.

- [ ] **Step 2: Hash application source fixtures used to materialize engine requests**

```bash
find tests/fixtures/irregularSheetInvariance tests/fixtures/irregularSeventeenShapes -type f -print0 \
  | sort -z \
  | xargs -0 shasum -a 256 \
  > docs/artifacts/polygon-nesting-extraction-baseline/source-fixtures.sha256
```

Expected: Mixed-61 and all 17 Shapes DXFs are represented.

- [ ] **Step 3: Hash legal material and native addon**

```bash
shasum -a 256 \
  crates/irregular-nesting-native/NOTICE \
  crates/irregular-nesting-native/LICENSES/clipper2-ts-BSL-1.0.txt \
  crates/irregular-nesting-native/npm/*.node \
  > docs/artifacts/polygon-nesting-extraction-baseline/legal-and-addon.sha256
```

Expected: notice, complete license, and current staged addon are present.

- [ ] **Step 4: Record the package allowlist**

```bash
pnpm --dir crates/irregular-nesting-native pack --dry-run --json \
  > docs/artifacts/polygon-nesting-extraction-baseline/package-manifest.json
```

Expected: loader, target map, `.node`, notice, and license files only. No `src/` or `target/` path is present.

- [ ] **Step 5: Materialize standalone engine requests and expected outcomes**

Extend the existing parity fixture preparation with a read-only export mode that writes, for every Triangle-20, Mixed-61, and Shapes-17 Compact and Short Side baseline row:

```text
request.json
result.json
events.ndjson
semantic-projection.json
metadata.json
```

`metadata.json` must contain source fixture hashes, profile, sheet dimensions, requested and actual workers, collision identity, fitted identity, and normalized semantic SHA-256.

Run the exporter and populate `migration-corpus.json` with every row and artifact hash.

- [ ] **Step 6: Hash the complete evidence directory**

```bash
find docs/artifacts/polygon-nesting-extraction-baseline -type f ! -name SHA256SUMS -print0 \
  | sort -z \
  | xargs -0 shasum -a 256 \
  > docs/artifacts/polygon-nesting-extraction-baseline/SHA256SUMS
```

Expected: every baseline artifact is represented exactly once.

- [ ] **Step 7: Commit the complete baseline**

```bash
git add docs/artifacts/polygon-nesting-extraction-baseline
git commit -m "test: freeze polygon engine extraction baseline"
```

Expected: one baseline commit with no algorithm changes.

### Task 4: Create the private standalone repository and workspace

**Files:**
- Create: all root workspace files under `ENGINE_REPO`

- [ ] **Step 1: Confirm the destination does not already exist**

```bash
gh repo view jfet97/polygon-nesting
```

Expected: repository-not-found. If it exists, inspect it and reuse it only when its contents and ownership match this extraction.

- [ ] **Step 2: Create and clone the private repository**

```bash
gh repo create jfet97/polygon-nesting --private --description "Deterministic Rust polygon nesting engine with N-API and CLI adapters" --clone
```

Run from `/Users/andreasimonecosta/Documents/Work` so the clone lands at `ENGINE_REPO`.

Expected: private repository exists and `git -C ENGINE_REPO remote -v` points to `jfet97/polygon-nesting`.

- [ ] **Step 3: Write the root Cargo workspace**

Create `Cargo.toml`:

```toml
[workspace]
members = [
  "crates/polygon-nesting-protocol",
  "crates/polygon-nesting-core",
  "crates/polygon-nesting-cli",
  "crates/polygon-nesting-napi",
]
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"

[profile.release]
codegen-units = 1
lto = "thin"
overflow-checks = true
```

Do not declare `rust-version` in `0.1.0` because the source repository floats stable Rust and has no verified minimum supported Rust version. The release metadata records the exact compiler used.

- [ ] **Step 4: Create crate manifests with the locked dependency direction**

Protocol depends only on serde and serde_json. Core depends on protocol plus deterministic algorithm dependencies. CLI depends on core, protocol, `clap`, `ctrlc`, and serde_json. N-API depends on core, protocol, napi, napi-derive, and serde_json.

- [ ] **Step 5: Add a dependency-direction test**

Create `scripts/verify-dependency-direction.sh` that runs:

```bash
cargo metadata --format-version 1 --no-deps
```

Parse workspace package dependencies and fail if protocol depends on another workspace crate, or core depends on CLI/N-API.

- [ ] **Step 6: Run the empty workspace check**

```bash
cargo check --workspace
```

Expected: pass after minimal crate `lib.rs` and CLI `main.rs` files exist.

- [ ] **Step 7: Commit the workspace skeleton**

```bash
git add .
git commit -m "chore: establish polygon nesting workspace"
```

### Task 5: Define the versioned protocol with tests first

**Files:**
- Create: `crates/polygon-nesting-protocol/src/{lib,error,event,request,result,version}.rs`
- Create: `crates/polygon-nesting-protocol/tests/protocol_vectors.rs`
- Copy: frozen request/error vectors into `tests/vectors/protocol/`

- [ ] **Step 1: Write failing protocol version tests**

Test these exact rules:

```rust
assert_eq!(ProtocolVersion::CURRENT, ProtocolVersion::new(1));
assert!(decode_request(r#"{"version":2}"#).is_err());
assert_eq!(encode_outcome(&outcome)?, encode_outcome(&outcome)?);
```

Also test unknown-field acceptance, decimal-string BigInt values, optional field omission, and archive-ineligible typed outcomes.

- [ ] **Step 2: Run the protocol tests and confirm failure**

```bash
cargo test -p polygon-nesting-protocol --test protocol_vectors
```

Expected: compile failure because protocol types are not implemented.

- [ ] **Step 3: Implement protocol types**

Define:

```rust
pub const PROTOCOL_VERSION: u32 = 1;

pub struct EngineRequest {
    pub version: u32,
    pub timeout_ms: u64,
    pub profile: EngineProfile,
    pub sheet: SheetSpec,
    pub pieces: Vec<PreparedPiece>,
    pub settings: EngineSettings,
    pub history: HistoryMode,
}

pub enum EngineProfile {
    Compact,
    CompactShortSide,
}

pub enum EngineOutcome {
    Success { result: EngineResult, diagnostics: ExecutionDiagnostics },
    Failure { error: EngineError, diagnostics: ExecutionDiagnostics },
}
```

Port current serde rename, omission, default, safe-integer, and version semantics from `boundary/request.rs` and `boundary/result.rs`. Do not include `jobId`, `strategyRunId`, or `workerMode`.

- [ ] **Step 4: Implement semantic events**

Define:

```rust
pub struct SequencedEngineEvent {
    pub ordinal: u64,
    pub event: EngineEvent,
}

pub enum EngineEvent {
    PortfolioProgress(PortfolioProgress),
    StateSnapshot(StateSnapshot),
}
```

Terminal acknowledgement is intentionally absent.

- [ ] **Step 5: Run protocol tests**

```bash
cargo test -p polygon-nesting-protocol
```

Expected: all protocol tests pass.

- [ ] **Step 6: Commit protocol ownership**

```bash
git add crates/polygon-nesting-protocol tests/vectors/protocol
git commit -m "feat: define versioned polygon nesting protocol"
```

### Task 6: Import deterministic core modules atomically

**Files:**
- Copy: `SOURCE_REPO/crates/irregular-nesting-native/src/{archive,capacity,caches,canonical_grid,checkpoints,clipper,domain,geometry,js_number,nfp_ifp,result,search,short_side,trace,transforms,validation}`
- Create: `crates/polygon-nesting-core/src/{lib,control,events,job,parallel}.rs`
- Copy: `NOTICE`, `LICENSES/clipper2-ts-BSL-1.0.txt`

- [ ] **Step 1: Copy deterministic modules and legal bytes without editing**

Use a file-preserving copy and verify legal hashes against Phase A.

- [ ] **Step 2: Move current pool implementation into core**

Copy `boundary/parallel.rs` to `core/src/parallel.rs`. Replace imports of `crate::boundary::parallel` with `crate::parallel` only. Preserve worker resolution, fallback, `run_scoped`, deterministic replay, and no-global-pool behavior.

- [ ] **Step 3: Add compile-only module declarations**

Create `core/src/lib.rs` declaring every imported module and the new control/events/job modules.

- [ ] **Step 4: Run core check and capture expected failures**

```bash
cargo check -p polygon-nesting-core
```

Expected: failures only from old `boundary::*` references and protocol type mismatches. Any algorithm error unrelated to ownership indicates an incomplete import.

- [ ] **Step 5: Replace boundary references without algorithm changes**

Move pure request conversion, result projection, diagnostics values, and run ownership into core. Keep N-API symbols out of core. Preserve core-internal checkpoint canonical JSON and cache-key encoders in their current modules.

- [ ] **Step 6: Verify no forbidden dependency or symbol remains**

```bash
rg -n 'napi|ThreadsafeFunction|AsyncTask|libuv|electron|azure|boundary::' crates/polygon-nesting-core
```

Expected: no matches except migration comments that are removed before commit.

- [ ] **Step 7: Run core check**

```bash
cargo check -p polygon-nesting-core
```

Expected: pass.

- [ ] **Step 8: Commit the atomic core import**

```bash
git add crates/polygon-nesting-core NOTICE LICENSES
git commit -m "feat: import deterministic polygon nesting core"
```

### Task 7: Implement typed control, events, and job service

**Files:**
- Modify: `crates/polygon-nesting-core/src/{control,events,job,lib}.rs`
- Test: `crates/polygon-nesting-core/tests/job_service.rs`
- Test: `crates/polygon-nesting-core/tests/control.rs`

- [ ] **Step 1: Write failing first-reason cancellation tests**

Test:

```rust
let control = CancellationControl::new();
assert!(control.cancel(CancelReason::Cancelled));
assert!(!control.cancel(CancelReason::Deadline));
assert_eq!(control.reason(), Some(CancelReason::Cancelled));
```

Repeat with deadline first.

- [ ] **Step 2: Implement cancellation control**

Use an atomic first-writer state with exactly `Running`, `Cancelled`, and `Deadline`. Adapt it to the current NFP/IFP control trait without changing checkpoint placement.

- [ ] **Step 3: Write failing event sequence tests**

Emit progress, snapshot, progress and assert ordinals `0, 1, 2`, exact payload order, and no terminal event.

- [ ] **Step 4: Implement event sequencing**

Define:

```rust
pub trait EngineEventSink: Send {
    fn emit(&mut self, event: SequencedEngineEvent);
}

pub struct EventSequencer<'a> {
    next_ordinal: u64,
    sink: &'a mut dyn EngineEventSink,
}
```

Preserve the existing infallible sink behavior.

- [ ] **Step 5: Write a failing typed job fixture test**

Decode one frozen `EngineRequest`, call typed `run`, and compare its protocol outcome and semantic hash with the frozen old-engine artifact.

- [ ] **Step 6: Implement typed `run`**

Construct job-local caches and `JobPool`, enter the pool through `run_scoped`, call the current coordinator, project to protocol values, capture diagnostics, and clear/shrink caches before return.

- [ ] **Step 7: Run focused tests**

```bash
cargo test -p polygon-nesting-core --test control
cargo test -p polygon-nesting-core --test job_service
```

Expected: pass.

- [ ] **Step 8: Commit typed execution**

```bash
git add crates/polygon-nesting-core
git commit -m "refactor: expose typed polygon nesting job service"
```

### Task 8: Move all Rust vectors and portability tests

**Files:**
- Copy: all current Rust integration tests into `crates/polygon-nesting-core/tests/`
- Copy: all 35 native vectors into `tests/vectors/core/`
- Modify: fixture path helpers in moved tests

- [ ] **Step 1: Copy tests and vectors**

Preserve filenames and bytes. Verify SHA-256 against Phase A.

- [ ] **Step 2: Make fixture paths standalone**

Replace every path that escapes the crate or repository with a path under `tests/vectors` or `tests/fixtures`. Copy the Mixed-61 engine request and materialized Shapes-17/Triangle-20 requests into the standalone repository.

- [ ] **Step 3: Update tests to call typed core where appropriate**

Thread equality must call typed `run`, normalize only approved diagnostics, and compare exact semantic bytes across 1, 2, 4, and 8 workers.

- [ ] **Step 4: Preserve process isolation**

Keep `no_pool_global_rayon_containment.rs` as its own integration test executable and do not run it inside another test process.

- [ ] **Step 5: Run the complete core suite**

```bash
cargo test --release -p polygon-nesting-core
cargo test --release -p polygon-nesting-core --test thread_equality
cargo test --release -p polygon-nesting-core --test no_pool_global_rayon_containment
```

Expected: all moved tests pass and frozen identities match.

- [ ] **Step 6: Commit portable vectors and tests**

```bash
git add crates/polygon-nesting-core/tests tests/vectors tests/fixtures
git commit -m "test: preserve standalone polygon engine vectors"
```

### Task 9: Build the N-API compatibility adapter with lifecycle tests

**Files:**
- Create: `crates/polygon-nesting-napi/src/{lib,compat,diagnostics,events,job}.rs`
- Copy/adapt: current `boundary/job.rs`, `boundary/events.rs`, N-API diagnostics, and `build.rs`
- Test: `crates/polygon-nesting-napi/tests/compat.rs`

- [ ] **Step 1: Write failing desktop compatibility tests**

For frozen desktop JSON, assert the adapter conversion produces the expected neutral `EngineRequest`. Assert missing or invalid `jobId`, `strategyRunId`, and `workerMode` preserve current desktop error categories.

- [ ] **Step 2: Implement compatibility DTO conversion**

Keep desktop-only fields in `compat.rs`. Reuse protocol validation for engine fields. Do not duplicate core geometry validation.

- [ ] **Step 3: Port cancellation token registry and AsyncTask**

Keep opaque token identity, pointer-identical cleanup, environment cleanup hooks, and panic containment in N-API.

- [ ] **Step 4: Port ordered callback and terminal acknowledgement**

Semantic ordinals come from core. Append terminal at the next ordinal and preserve current deferred delivery-failure selection.

- [ ] **Step 5: Run Rust adapter tests**

```bash
cargo test --release -p polygon-nesting-napi
```

Expected: pass.

- [ ] **Step 6: Commit the N-API adapter**

```bash
git add crates/polygon-nesting-napi
git commit -m "feat: add Electron N-API compatibility adapter"
```

### Task 10: Build the scoped NPM package and four target artifacts

**Files:**
- Create: `packages/polygon-nesting/package.json`
- Create: `packages/polygon-nesting/npm/{index,target}.cjs`
- Create: `packages/polygon-nesting/scripts/{build-native.mjs,build-native.test.mjs,worker-terminal-lifecycle-probe.mjs}`
- Create: `.npmrc`

- [ ] **Step 1: Write the package manifest**

Use:

```json
{
  "name": "@jfet97/polygon-nesting",
  "version": "0.1.0",
  "private": false,
  "publishConfig": { "registry": "https://npm.pkg.github.com" },
  "main": "npm/index.cjs",
  "exports": "./npm/index.cjs",
  "files": ["npm/index.cjs", "npm/target.cjs", "npm/*.node", "NOTICE", "LICENSES/**"]
}
```

Retain these exact binary filenames: `irregular-nesting-native.linux-x64.node`, `irregular-nesting-native.win32-x64.node`, `irregular-nesting-native.darwin-arm64.node`, and `irregular-nesting-native.darwin-x64.node`.

- [ ] **Step 2: Port target mapping and staging tests**

Support only Linux x64, Windows x64, macOS arm64, and macOS x64. Unsupported combinations fail before Cargo.

- [ ] **Step 3: Preserve macOS copied-addon signing**

After staging a Darwin addon on Darwin, run `codesign --force --sign -`. The regression test must inspect the signature, reject `linker-signed`, and load the addon in a child process.

- [ ] **Step 4: Add package allowlist and legal tests**

Run `npm pack --dry-run --json` and reject any Rust source or Cargo `target/` path. Verify notice and license hashes.

- [ ] **Step 5: Run local target build and lifecycle checks**

```bash
node packages/polygon-nesting/scripts/build-native.mjs --release
node --test packages/polygon-nesting/scripts/build-native.test.mjs
node -e "const c=require('./packages/polygon-nesting/npm/index.cjs').nativeCapability(); if(c.apiVersion!==3) throw new Error(JSON.stringify(c))"
ELECTRON_RUN_AS_NODE=1 pnpm exec electron -e "const c=require('./packages/polygon-nesting/npm/index.cjs').nativeCapability(); if(c.apiVersion!==3) throw new Error(JSON.stringify(c))"
```

Expected: all pass.

- [ ] **Step 6: Commit package ownership**

```bash
git add packages/polygon-nesting .npmrc NOTICE LICENSES
git commit -m "build: package polygon nesting native addons"
```

### Task 11: Implement the CLI contract test first

**Files:**
- Create: `crates/polygon-nesting-cli/src/{main,args,artifacts,exit,signals}.rs`
- Create: `crates/polygon-nesting-cli/tests/cli.rs`

- [ ] **Step 1: Write failing success and NDJSON tests**

Invoke the binary with a frozen request and assert:

- exit 0;
- `result.json` matches the frozen semantic outcome;
- each event line parses independently;
- ordinals are contiguous and ordered;
- no terminal transport event appears.

- [ ] **Step 2: Write failing exit-code tests**

Assert exact statuses 1 through 5 for internal failure injection, malformed input, typed domain failure, cancellation/deadline, and output write failure.

- [ ] **Step 3: Implement CLI argument parsing**

Define clap arguments named `input`, `output`, optional `events`, and optional positive `deadline_ms` for the `run` subcommand. The rendered usage is `polygon-nesting run --input PATH --output PATH [--events PATH] [--deadline-ms MILLISECONDS]`. The override can only shorten `EngineRequest.timeout_ms`.

- [ ] **Step 4: Implement atomic artifacts**

Write to sibling temporary files, flush, sync, and rename. Typed failure and cancellation envelopes are written before nonzero exit whenever output is available.

- [ ] **Step 5: Implement SIGTERM mapping**

Install a signal handler that writes `CancelReason::Cancelled` into the same first-writer control. It does not create a new protocol reason.

- [ ] **Step 6: Run CLI tests**

```bash
cargo test --release -p polygon-nesting-cli
```

Expected: all CLI contract tests pass.

- [ ] **Step 7: Commit CLI adapter**

```bash
git add crates/polygon-nesting-cli
git commit -m "feat: add one-shot polygon nesting CLI"
```

### Task 12: Build and test the non-root Linux amd64 OCI image

**Files:**
- Create: `Dockerfile`
- Create: `tests/integration/docker-smoke.sh`

- [ ] **Step 1: Write the failing Docker smoke script**

The script builds `linux/amd64`, checks the runtime UID is not zero, mounts a temporary `/work`, runs one fixture, parses result JSON and NDJSON, and checks image labels.

- [ ] **Step 2: Write the multi-stage Dockerfile**

Build the release CLI in the builder stage. Copy only the binary, certificates, `NOTICE`, and `LICENSES` into the runtime stage. Create an unprivileged user and set it as `USER`.

- [ ] **Step 3: Add OCI labels**

Set version `0.1.0`, source repository, revision build argument, and `org.opencontainers.image.licenses=NOASSERTION`. Include the Clipper2 notice and BSL text without claiming a repository-wide license that has not been authorized.

- [ ] **Step 4: Run the smoke test**

```bash
bash tests/integration/docker-smoke.sh
```

Expected: image builds for Linux amd64, runtime UID is nonzero, fixture succeeds, and labels match source metadata.

- [ ] **Step 5: Commit image support**

```bash
git add Dockerfile tests/integration/docker-smoke.sh
git commit -m "build: package CLI as non-root OCI image"
```

### Task 13: Write standalone architecture and contracts

**Files:**
- Create: `docs/{architecture,azure-container-job-contract,cli-contract,migration-from-min-plane-dfx,napi-compatibility,protocol-compatibility}.md`
- Create: `README.md`

- [ ] **Step 1: Write the source migration map**

Map every source module and test to protocol, core, N-API, CLI, or excluded application ownership. Record `SOURCE_MIN_PLANE_COMMIT`, baseline commit, toolchains, waiver, and fixture hashes.

- [ ] **Step 2: Write protocol compatibility policy**

Document version 1, unknown-field behavior, additive versus breaking changes, exact omission semantics, and typed ineligibility.

- [ ] **Step 3: Write N-API compatibility policy**

Document the `irregular-nesting-native` NPM alias, retained binary filenames, API 3 behavior, target matrix, package authentication, and lifecycle guarantees.

- [ ] **Step 4: Write CLI contract**

Document flags, deadline precedence, output guarantees, NDJSON ordering, exact exit statuses, and atomic write behavior.

- [ ] **Step 5: Write Azure contract**

Document the platform-managed Azure Files `/work` mount, one invocation per execution, backend responsibilities, nonzero-exit artifact handling, and explicit absence of Azure SDKs in the engine.

- [ ] **Step 6: Run documentation checks**

```bash
rg -n -P 'min-plane-dfx/.+tests|\.\./\.\./min-plane-dfx|T[B]D|T[O]DO|\x{2013}|\x{2014}' README.md docs crates packages tests
```

Expected: no stale checkout dependency, placeholders, or forbidden dash characters. Provenance references to the repository name are allowed.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md docs
git commit -m "docs: define standalone engine contracts"
```

### Task 14: Add CI and immutable release-candidate assembly

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `scripts/assemble-release-candidate.mjs`
- Create: `scripts/verify-release-candidate.mjs`

- [ ] **Step 1: Add normal CI**

Run Rust fmt, Clippy with warnings denied, workspace release tests, thread equality, no-global-pool containment, protocol and CLI tests, Node/Electron local load on the runner target, package allowlist, legal checks, and Linux amd64 Docker smoke.

- [ ] **Step 2: Add four-target addon matrix**

Build and load Linux x64, Windows x64, macOS arm64, and macOS x64 artifacts on matching GitHub runners. Upload each `.node` with its SHA-256.

- [ ] **Step 3: Assemble one NPM tarball without rebuilding**

Download the four verified addon artifacts, place them in one package, run package tests, then run `npm pack`. Record tarball SHA-256 and file manifest.

- [ ] **Step 4: Assemble one OCI candidate without rebuilding after smoke**

Build by source commit, smoke the digest, and record the immutable digest and OCI labels.

- [ ] **Step 5: Keep publication gated**

The release workflow requires manual dispatch or a signed `v0.1.0` tag and a protected `publish` environment. Candidate assembly and testing run before the environment approval. Publication jobs consume uploaded tarball and image digest artifacts instead of rebuilding.

- [ ] **Step 6: Run workflow validation locally where available**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --release --workspace
node scripts/verify-release-candidate.mjs --dry-run
```

Expected: pass.

- [ ] **Step 7: Commit CI and release pipeline**

```bash
git add .github scripts
git commit -m "ci: verify and assemble engine releases"
```

### Task 15: Prove standalone parity without the old checkout

**Files:**
- Create: `tests/integration/frozen-corpus.rs`
- Create: `docs/release-evidence/0.1.0/parity.json`

- [ ] **Step 1: Run frozen corpus through typed core**

For every frozen request, compare exact semantic output to Phase A, excluding only approved non-semantic diagnostic values.

- [ ] **Step 2: Run frozen corpus through N-API**

Compare the complete desktop compatibility envelope and ordered callbacks to Phase A.

- [ ] **Step 3: Run frozen corpus through CLI**

Compare output envelopes and semantic NDJSON events.

- [ ] **Step 4: Prove checkout independence**

Run the standalone test suite with `SOURCE_REPO` temporarily unavailable through a renamed path or isolated CI checkout. No test may read outside `ENGINE_REPO`.

- [ ] **Step 5: Record parity evidence**

Write every request hash, old outcome hash, core hash, N-API hash, CLI hash, and pass status into `parity.json`.

- [ ] **Step 6: Commit parity evidence**

```bash
git add tests/integration/frozen-corpus.rs docs/release-evidence/0.1.0/parity.json
git commit -m "test: prove standalone engine parity"
```

### Task 16: Prepare the desktop cutover against the exact tarball

**Files:**
- Modify in an isolated `min-plane-dfx` cutover worktree: `package.json`, `pnpm-lock.yaml`, `.npmrc`
- Modify only if required by verified incompatibility: native staging and verifier scripts

- [ ] **Step 1: Install the exact release-candidate tarball under the old dependency key**

Use an NPM alias or local tarball dependency that resolves as `irregular-nesting-native`. Do not alter `loadNativeBackend.ts` when the retained package and binary names work.

- [ ] **Step 2: Run package-name resolution tests**

Verify `require('irregular-nesting-native')` resolves the release-candidate package and not the embedded workspace directory.

- [ ] **Step 3: Run old versus candidate corpus comparison**

Use the frozen corpus and require exact semantic equality under the existing normalizations.

- [ ] **Step 4: Run desktop integration gates**

```bash
pnpm test:native:package
MIN_PLANE_REQUIRE_NATIVE_ADDON=1 pnpm exec vitest run tests/unit/nativeIrregularBackend.test.ts
pnpm test:differential:exact
pnpm gate:quality-acceptance
```

Expected: pass against the tarball.

- [ ] **Step 5: Run all four packaged-app gates in CI**

Use the exact release-candidate tarball artifact in each platform job. Verify packaged executable and app.asar loading, notices, licenses, and macOS signing.

- [ ] **Step 6: Commit the prepublication cutover branch**

Commit only dependency/configuration changes. Do not delete the embedded crate.

### Task 17: Run Codex Review Chat and resolve findings

**Files:**
- Review: specification, this plan, both repository diffs, parity evidence, CI logs, and release candidate manifests

- [ ] **Step 1: Invoke `codex-review-chat`**

Use `gpt-5.6-sol` with `xhigh` reasoning effort as requested by the owner.

- [ ] **Step 2: Provide complete review context**

Include:

```text
approved specification path
implementation plan path
SOURCE_MIN_PLANE_COMMIT
engine repository diff and commits
min-plane-dfx cutover diff
all executed gate results
NPM tarball SHA-256
OCI image digest
known waived performance evidence
```

- [ ] **Step 3: Verify every finding before editing**

Read actual code, trace callers, reproduce the failure scenario, and reject unsupported findings with evidence.

- [ ] **Step 4: Fix confirmed findings test-first**

Add a failing focused test, implement the smallest behavior-preserving fix, rerun focused and full relevant gates, and commit.

- [ ] **Step 5: Ask Codex to review the resolved state**

Continue the same review chat until no confirmed blocker remains.

### Task 18: Publish the verified `0.1.0` artifacts

**Files:**
- Update: `docs/release-evidence/0.1.0/release.json`

- [ ] **Step 1: Verify authentication and destination access**

```bash
gh auth status
npm whoami --registry=https://npm.pkg.github.com
docker login ghcr.io
```

Expected: authenticated as an authorized `jfet97` publisher. If authentication is interactive or unavailable, request only the needed login action.

- [ ] **Step 2: Present the immutable publication facts for final safety confirmation**

Report repository, visibility, version, NPM tarball SHA-256, OCI image digest, supported targets, and all gate outcomes. Request confirmation immediately before publication.

- [ ] **Step 3: Publish the exact verified tarball without rebuilding**

```bash
TARBALL="$(find dist -maxdepth 1 -name 'jfet97-polygon-nesting-0.1.0.tgz' -print -quit)"
test -n "$TARBALL"
npm publish "$TARBALL" --registry=https://npm.pkg.github.com
```

Expected: `@jfet97/polygon-nesting@0.1.0` exists and its registry integrity matches the candidate.

- [ ] **Step 4: Publish the exact verified image digest without rebuilding**

Tag and push the already tested image as:

```text
ghcr.io/jfet97/polygon-nesting:0.1.0
ghcr.io/jfet97/polygon-nesting:source-e4f360887861
```

Expected: both tags resolve to the recorded digest.

- [ ] **Step 5: Create the private GitHub release**

Create tag `v0.1.0`, attach checksums and evidence, and state the source commit and performance waiver without AI attribution.

- [ ] **Step 6: Verify registry delivery**

Install from GitHub Packages in a clean temporary directory, load under Node and Electron-as-Node, pull the GHCR image by digest, and rerun the image fixture smoke.

- [ ] **Step 7: Commit release evidence**

Record package integrity, image digest, release URL, commands, and verification results.

### Task 19: Finalize desktop registry cutover

**Files:**
- Modify: `SOURCE_WORKTREE/package.json`
- Modify: `SOURCE_WORKTREE/pnpm-lock.yaml`
- Create or modify: `SOURCE_WORKTREE/.npmrc`

- [ ] **Step 1: Replace the candidate tarball with the published alias**

Set:

```json
"irregular-nesting-native": "npm:@jfet97/polygon-nesting@0.1.0"
```

Use the committed scope registry mapping and environment token reference. Commit no token.

- [ ] **Step 2: Install from the registry cleanly**

```bash
rm -rf node_modules
NODE_AUTH_TOKEN="$NODE_AUTH_TOKEN" pnpm install --frozen-lockfile --ignore-scripts
```

Expected: install succeeds from GitHub Packages and the lockfile pins `0.1.0` integrity.

- [ ] **Step 3: Run registry-backed desktop gates**

Run Node, Electron-as-Node, real-addon, lifecycle, differential, quality, and packaged application smoke. Full four-target correctness already ran on identical tarball bytes; registry-backed checks prove package delivery and resolution.

- [ ] **Step 4: Commit cutover**

```bash
git add package.json pnpm-lock.yaml .npmrc
git commit -m "build: consume external polygon nesting package"
```

### Task 20: Remove embedded ownership after confirmed cutover

**Files:**
- Delete: `SOURCE_WORKTREE/crates/irregular-nesting-native/`
- Modify/delete: obsolete staging scripts and native CI ownership only when no longer used
- Modify: `electron-builder.yml`, package verification tests, workflow paths

- [ ] **Step 1: Prove no runtime or test path requires the embedded crate**

```bash
rg -n 'crates/irregular-nesting-native|workspace:\*|\.\./.*irregular-nesting-native' package.json pnpm-lock.yaml src scripts tests .github electron-builder.yml
```

Expected: only explicit removal targets or migration documentation remain.

- [ ] **Step 2: Present the deletion set for final safety confirmation**

List every file and CI responsibility being removed and the exact external rollback version.

- [ ] **Step 3: Delete embedded source and obsolete scripts**

Retain application-side package and packaged-app verification that remains useful for the external dependency. Delete only build/staging ownership replaced by the standalone package.

- [ ] **Step 4: Run the full source repository validation**

```bash
pnpm typecheck
pnpm lint
pnpm test:focused
pnpm test:native:package
pnpm test:differential:exact
pnpm gate:quality-acceptance
pnpm build
```

Expected: all pass with no embedded crate.

- [ ] **Step 5: Run IDE diagnostics**

Call `mcp__ide__getDiagnostics` for the complete workspace. Expected: no new errors or warnings caused by the cutover.

- [ ] **Step 6: Commit removal**

```bash
git add -A
git commit -m "refactor: remove embedded polygon nesting engine"
```

### Task 21: Final verification, knowledge updates, and reporting

**Files:**
- Update: both repositories' `knowledge/` bases through `/knowledge update`
- Update: final release evidence and migration status documents

- [ ] **Step 1: Run standalone final gates**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --release --workspace
bash tests/integration/docker-smoke.sh
node scripts/verify-release-candidate.mjs
```

Expected: pass.

- [ ] **Step 2: Run source repository final gates**

Run the full validation from Task 20 again on the final commit.

- [ ] **Step 3: Inspect both final diffs and Git states**

```bash
git status --short
git log --oneline --decorate -10
```

Expected: clean trees and coherent commits.

- [ ] **Step 4: Update both knowledge bases**

Invoke `/knowledge update` in each repository and commit the resulting durable knowledge changes when the skill produces tracked files.

- [ ] **Step 5: Run final Codex review if post-review changes were substantial**

Continue the existing `codex-review-chat` and provide the final SHAs and gate outputs.

- [ ] **Step 6: Report exact outcomes**

Report:

- accepted source commit;
- standalone engine release commit and tag;
- NPM package version and integrity;
- addon SHA-256 values for four targets;
- OCI image digest and architecture;
- every executed gate and result;
- performance waiver;
- remaining external blockers;
- rollback package version.

Do not claim Azure deployment, crates.io publication, Linux arm64 support, or any gate that was not actually executed.
