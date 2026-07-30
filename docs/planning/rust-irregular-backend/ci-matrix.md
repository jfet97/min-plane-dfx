# CI Matrix — Design

Status: **Stage 0 design document.** No new workflow file is added by this
document and no existing workflow is modified — `.github/workflows/capacity-quality.yml`
is the only workflow file that exists in this checkout today (verified:
`find .github/workflows -type f` → one file). Every job below is proposed for
implementation in Stage 1+ (native build/smoke jobs can land as soon as the
crate skeleton builds; differential/determinism/production-gate jobs land
only as their prerequisite Stage-2+ code exists). Claims about current CI
behavior are source-cited; claims about the target matrix are marked design.

Governing spec: `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
§20.3 ("CI matrix", quoted in full in §1 below). Related constraints consumed
from: §18.6 (required production gates), §18.4 (concurrency determinism
tests), §19.3/§20.3 ("Do not run multiple performance measurements
concurrently on the same host").

Primary sources read for this document: the migration prompt §20.3 (full);
`.github/workflows/capacity-quality.yml` (full, the only existing workflow);
`docs/planning/rust-irregular-backend/build-packaging.md` (full); `docs/planning/rust-irregular-backend/backend-selection-rollback.md`
(full); `docs/planning/rust-irregular-backend/stage0-rulings.md` (full);
`docs/operations/irregular-production-gates.md` (full); `docs/planning/rust-irregular-backend/performance-contract.md`
§1–3; `docs/planning/rust-irregular-backend/architecture.md` (Stage 5 section,
`crates/irregular-nesting-native` provenance); `package.json` (`scripts`,
`engines`, full); `pnpm-workspace.yaml` (full); `flake.nix` (full); the
`crates/irregular-nesting-native` skeleton committed at `dbcfec2`:
`Cargo.toml`, `scripts/build-native.mjs`, `npm/index.cjs`, `src/lib.rs`,
`rustfmt.toml`, `.gitignore` (all read in full); `docs/planning/rust-irregular-backend/characterization/tests-gates-inventory.md`
§12 (dual-runtime hazard).

---

## 1. What the prompt requires, verbatim

Prompt §20.3, quoted in full:

> Add CI jobs that build and test native artifacts on supported operating
> systems and architectures where hosted runners permit it.
>
> CI must cover: Rust format; Rust lint with warnings treated appropriately;
> Rust unit tests; native build; Node/Electron addon load smoke test;
> TypeScript typecheck and lint; existing full tests; exact irregular
> differential tests; one-thread and multi-thread determinism tests;
> production gates; package artifact inspection; packaged application smoke
> test where feasible.
>
> The current workflow installs with `--ignore-scripts`. Adjust native build
> jobs deliberately rather than globally weakening install safety.
>
> Keep expensive 18-layout and capacity gates controlled and reproducible. Do
> not run multiple performance measurements concurrently on the same host.

Every section below maps one-to-one onto this list, plus the operational gate
inventory in `docs/operations/irregular-production-gates.md`.

## 2. Current CI state — what exists today, and the gaps this design closes

`.github/workflows/capacity-quality.yml` (full file, 48 lines) defines exactly
two jobs, both `runs-on: ubuntu-latest`, both triggered on `pull_request` and
`push` to `main`:

- `capacity-quality` — `pnpm install --frozen-lockfile --ignore-scripts` then
  `pnpm gate:capacity:production --output "$RUNNER_TEMP/capacity" --quiet`.
- `layout-matrix` — same install step, then `pnpm gate:compact-nine-baselines
  --output-dir "$RUNNER_TEMP/layouts" --skip-png`.

Both use `pnpm/action-setup@v4` (`version: 11`), `actions/setup-node@v4`
(`node-version: 24.11.0`, `cache: pnpm`), and a `concurrency` block
(`group: capacity-quality-${{ github.ref }}`, `cancel-in-progress: true`).
This is the exact convention every new job below reuses (§3), not a new
pattern.

**Gaps this design must close, stated plainly because the prompt's list
implies they exist and they do not today:**

1. No CI job runs `pnpm typecheck`, `pnpm lint`, or `pnpm test` at all.
   `capacity-quality.yml` runs only the two gate scripts above. TS
   typecheck/lint/full-suite (prompt §20.3 items 6–7) is a genuine gap, not
   something already covered elsewhere.
2. No CI job runs `pnpm gate:mixed61-compact` or the Focused Correctness Gate
   vitest list from `docs/operations/irregular-production-gates.md` ("Focused
   Correctness Gate" section: `intrinsicSharedArchiveAdmission.test.ts` and
   six sibling specs, plus `gate:mixed61-compact`). Only the capacity and
   nine-baselines gates are wired into CI today.
3. No Rust-related job exists yet, because no Rust crate existed until
   `dbcfec2` (the current skeleton commit) and no `.node` build is wired into
   any workflow.

This document's job matrix (§4) fills all three gaps additively. Nothing in
`capacity-quality.yml` is edited by this design — new jobs live in new
workflow files (§3).

## 3. Proposed workflow files (design, not created by this document)

One workflow file per cadence, so trigger conditions stay simple and legible
rather than one large workflow with per-job `if:` cadence gates:

| File | Cadence | Contents |
| --- | --- | --- |
| `.github/workflows/ts-checks.yml` (new) | Per-PR + push to `main` | `ts-typecheck`, `ts-lint`, `existing-full-suite` (closes gap 1, §2) |
| `.github/workflows/rust-checks.yml` (new) | Per-PR + push to `main` | `rust-fmt`, `rust-clippy`, `native` matrix (build + `cargo test` + addon-load smoke), `differential-tests` (subset), `determinism-tests` (subset) |
| `.github/workflows/production-gates.yml` (new) | Per-PR + push to `main`, plus the Rust-backend rows once Stage 2+ lands | `mixed61-compact-gate`, `focused-correctness-gate` (closes gap 2, §2); TypeScript and Rust sibling jobs use the implemented worker routing and differential parity harness |
| `.github/workflows/nightly-native.yml` (new) | `schedule` (nightly) + `workflow_dispatch` | Full determinism matrix (prompt §18.4's full 1/2/default/8-thread × small/medium/Mixed-61 grid), full differential vector suite, capacity paired gate (`gate:capacity`, the expensive cold-only comparison `production-gates.yml` deliberately excludes per `irregular-production-gates.md`'s own PR/manual split) |
| `.github/workflows/release-packaging.yml` (new) | Tag push matching a release pattern (e.g. `v*`) + `workflow_dispatch` | `package-artifact-inspection`, `packaged-app-smoke` per platform |

`capacity-quality.yml` itself is left untouched; its two existing jobs remain
the TS-backend `gate:capacity:production` / `gate:compact-nine-baselines`
authority until `production-gates.yml` is judged a safe additive superset (an
explicit orchestrator call, not assumed here — see §9).

## 4. Full job matrix

All jobs reuse the existing convention: `actions/checkout@v4`,
`pnpm/action-setup@v4` (`version: 11`), `actions/setup-node@v4`
(`node-version: 24.11.0`, `cache: pnpm`), `pnpm install --frozen-lockfile
--ignore-scripts` as the install step, matching `engines` in `package.json`
(`node >=24.11.0`, `pnpm >=11.0.0`). Rust jobs additionally add
`dtolnay/rust-toolchain@stable` (or a pinned version — see open question §9.2)
and `Swatinem/rust-cache@v2` (§6).

| Job name | Purpose (prompt §20.3 item) | Runner(s) | Cadence | Key command(s) | Blocking on PR? |
| --- | --- | --- | --- | --- | --- |
| `rust-fmt` | Rust format | `ubuntu-latest` | Per-PR | `cargo fmt --manifest-path crates/irregular-nesting-native/Cargo.toml -- --check` | Yes |
| `rust-clippy` | Rust lint, warnings as errors | `ubuntu-latest` | Per-PR | `cargo clippy --manifest-path crates/irregular-nesting-native/Cargo.toml --all-targets --all-features -- -D warnings` | Yes |
| `native` (matrix) | Rust unit tests + native build + addon-load smoke | `ubuntu-latest` (linux x64), `macos-latest` (macOS arm64 native + macOS x64 cross-compiled), `windows-latest` (windows x64) | Per-PR | See §5.1 | Yes |
| `ts-typecheck` | TypeScript typecheck | `ubuntu-latest` | Per-PR | `pnpm typecheck` | Yes |
| `ts-lint` | TypeScript lint | `ubuntu-latest` | Per-PR | `pnpm lint` | Yes |
| `existing-full-suite` | Existing full test suite, unmodified | `ubuntu-latest` | Per-PR | `node crates/irregular-nesting-native/scripts/build-native.mjs --profile release` (once the addon is a real dependency of any test path — harmless no-op cost otherwise) then `pnpm test` | Yes |
| `differential-tests` | Exact irregular differential tests (TS vs Rust) | `ubuntu-latest` | Per-PR: small/representative subset. Nightly: full vector suite | See §5.2 | Yes (subset) |
| `determinism-tests` | One-thread vs multi-thread determinism | `ubuntu-latest` | Per-PR: 1 vs 2 threads, small case only. Nightly: full 1/2/default/8-thread × small/medium/Mixed-61 grid, repeated | See §5.3 | Yes (subset) |
| `mixed61-compact-gate` | Production gate | `ubuntu-latest` | Per-PR | `pnpm gate:mixed61-compact` | Yes |
| `focused-correctness-gate` | Production gate | `ubuntu-latest` | Per-PR | Focused vitest list from `irregular-production-gates.md` (§5.4) | Yes |
| `capacity-quality` (existing) | Production gate | `ubuntu-latest` | Per-PR (unchanged) | `pnpm gate:capacity:production --quiet` | Yes |
| `layout-matrix` (existing) | Production gate | `ubuntu-latest` | Per-PR (unchanged) | `pnpm gate:compact-nine-baselines --skip-png` | Yes |
| `mixed61-compact-gate-rust` / `layout-matrix-rust` / `focused-correctness-gate-rust` | Same gates, Rust-forced | `ubuntu-latest` | Per-PR, **only once implemented** (§7) | Same commands + `--irregular-backend rust` / `MIN_PLANE_IRREGULAR_BACKEND=rust` | Yes, once it exists |
| `capacity-paired-gate` | Production gate (expensive cold-only comparison) | `ubuntu-latest` | Nightly only | `pnpm gate:capacity` | No (nightly informational + tracked) |
| `package-artifact-inspection` | Package artifact inspection | `ubuntu-latest`, `macos-latest`, `windows-latest` | Pre-release (tag push) | See §5.5 | Yes, blocks release tag promotion |
| `packaged-app-smoke` | Packaged application smoke test | `ubuntu-latest` (xvfb), `macos-latest`, `windows-latest` | Pre-release (tag push) | See §5.6 | Yes where feasible; macOS x64 flagged (§5.6) |

## 5. Concrete job definitions

### 5.1 `native` matrix — build, test, addon-load smoke

Matrix axis (`strategy.matrix.include`), each entry pinning the Rust target
triple per `build-packaging.md` §9's table:

| `os` | Rust targets built | Addon-load smoke performed |
| --- | --- | --- |
| `ubuntu-latest` | `x86_64-unknown-linux-gnu` | Native (same arch as runner) |
| `macos-latest` | `aarch64-apple-darwin` (native), `x86_64-apple-darwin` (cross-compiled via `rustup target add x86_64-apple-darwin`) | arm64 binary: native load. x64 binary: **Rosetta-mediated** load only — `arch -x86_64 node -e "require('./crates/irregular-nesting-native/npm/irregular-nesting-native.darwin-x64.node')"` under Rosetta 2 (preinstalled on GitHub-hosted macOS runners). This is a real limitation, not a formality: a cross-compiled binary built on an arm64 runner cannot be `dlopen`'d by that runner's native (arm64) Node process, so the smoke test itself must run under emulation. Flagged in §9.1 as insufficient, on its own, to satisfy prompt §20.1's "do not claim a platform is supported until its binary is built, loaded by the packaged Electron application, and smoke-tested" for macOS x64 — a real x64 (or Rosetta-hosting packaged Electron) verification is still needed before first release. |
| `windows-latest` | `x86_64-pc-windows-msvc` | Native |

Steps per matrix entry:

1. Checkout, pnpm/node setup (§4 preamble), `pnpm install --frozen-lockfile
   --ignore-scripts`.
2. `dtolnay/rust-toolchain@stable` (installs `rustc`/`cargo`; add
   `rustup target add x86_64-apple-darwin` as an extra step only on the
   `macos-latest` matrix entry, before the build step).
3. `Swatinem/rust-cache@v2` scoped to `crates/irregular-nesting-native` (§6).
4. Build: `node crates/irregular-nesting-native/scripts/build-native.mjs
   --profile release` — the actual script already committed at `dbcfec2`
   (`crates/irregular-nesting-native/scripts/build-native.mjs`, verified read
   in full), which runs `cargo build --release` and stages
   `irregular-nesting-native.<platform>-<arch>.node` into `npm/`. For the
   macOS x64 cross-compile, this needs an explicit `--target
   x86_64-apple-darwin` extension to `build-native.mjs`'s `cargoBuildArgs`
   (not present in the current skeleton, which always builds for the host
   triple — flagged as a needed additive change, §9.3) or an equivalent
   direct `cargo build --release --target x86_64-apple-darwin` step with
   manual staging into `npm/irregular-nesting-native.darwin-x64.node`.
5. `cargo test --manifest-path crates/irregular-nesting-native/Cargo.toml`
   (runs the crate's existing `#[cfg(test)]` module, e.g.
   `native_capability_reports_expected_shape` and
   `run_irregular_job_returns_structured_not_implemented_error` in
   `src/lib.rs`, and every subsequent Rust unit test added per prompt §18.2).
6. Addon-load smoke (plain Node): `node -e "const c =
   require('./crates/irregular-nesting-native/npm/index.cjs').nativeCapability();
   if (typeof c.apiVersion !== 'number') throw new Error('bad capability
   shape')"` — exercises exactly the loader in `npm/index.cjs` (verified read
   in full: it `require()`s the platform-arch-named `.node` file and throws a
   remediation-bearing error on failure) and the `native_capability`/`Capability`
   N-API entry point already implemented in `src/lib.rs`.
7. Addon-load smoke (Electron-as-node): `ELECTRON_RUN_AS_NODE=1 pnpm exec
   electron -e "require('./crates/irregular-nesting-native/npm/index.cjs')"`
   — required because `tests-gates-inventory.md` §12 ("Electron-vs-plain-Node
   runtime split") documents that `pnpm test` runs vitest inside Electron's
   bundled Node (`package.json:26`, `ELECTRON_RUN_AS_NODE=1 electron
   ./node_modules/vitest/vitest.mjs run`) while gate scripts run under plain
   `tsx`/system Node — an N-API addon must be proven loadable from **both**
   ABI contexts, not just one, before any job downstream (`existing-full-suite`,
   the differential/determinism jobs) can trust it. Skipped for the Windows
   matrix entry only if Electron's Windows build cannot run headless in that
   step (flagged §9.4 for empirical check; Linux/macOS GitHub runners are
   already known to run headless Electron-as-node without a display server
   since this mode never opens a window).

### 5.2 `differential-tests` — exact TS vs Rust comparison

The concrete differential harness is
`scripts/rust-parity/run-differential.ts`. It preflights archive eligibility and
native availability, runs TypeScript and Rust sequentially, compares the shared
complete semantic projection, and exits nonzero on missing capability or any
mismatch. Per-PR jobs run a fixed small representative subset; nightly jobs may
run the full maintained matrix.

Runtime orchestration is covered by focused Vitest specs that call
`executeIrregularBackend` and `computeIrregularNestingDifferential` with
injected backend dependencies. Worker routing coverage verifies that
`MIN_PLANE_IRREGULAR_BACKEND=differential` reaches the dedicated production
orchestration. There is no fallback-policy environment variable or dispatcher
diagnostic contract.

The focused orchestration tests assert exact backend invocation counts and
order. The real parity CLI exits nonzero unless both backend runs complete.

### 5.3 `determinism-tests` — one-thread vs multi-thread

Design for Stage 4+ (Rayon parallelism, prompt §18.4). Thread count is
controlled via `RAYON_NUM_THREADS` (Rayon's standard environment override for
its global thread pool). Per-PR subset:

```sh
RAYON_NUM_THREADS=1 pnpm test:focused tests/unit/irregularBackendDeterminism.test.ts
RAYON_NUM_THREADS=2 pnpm test:focused tests/unit/irregularBackendDeterminism.test.ts
```

on the small representative case only, comparing canonical hashes, ledgers,
and checkpoint bytes exactly (prompt §18.4's exact-comparison list). Nightly
runs the full grid: 1 thread, 2 threads, default (unset), and 8 threads,
crossed with small/medium/Mixed-61 cases, each configuration repeated several
times to expose ordering races, matching `performance-contract.md`'s own
"Multi-thread matrix for Rust: 1 thread, 2 threads, default threads, and 8
threads" wording for its C1/C5 cases (that document measures *timing* on a
dedicated benchmark machine, §8 below; this CI job measures *determinism*
only — same thread-count grid, different purpose and different, disposable,
hosted-runner hardware).

### 5.4 `focused-correctness-gate`

Runs the exact command block from `docs/operations/irregular-production-gates.md`
("Focused Correctness Gate" section, quoted there in full):

```sh
ELECTRON_RUN_AS_NODE=1 pnpm exec electron ./node_modules/vitest/vitest.mjs run \
  tests/unit/intrinsicSharedArchiveAdmission.test.ts \
  tests/unit/intrinsicSharedArchivePortfolio.test.ts \
  tests/unit/intrinsicCapacityMode.test.ts \
  tests/unit/intrinsicCapacityIntegration.test.ts \
  tests/unit/intrinsicReconstructionPortfolio.test.ts \
  tests/unit/irregularTriangleCompactGolden.test.ts \
  tests/unit/irregularSeventeenShapesCompactGolden.test.ts
pnpm gate:mixed61-compact
```

(the nine-baselines third line of that block is already covered by the
existing `layout-matrix` job, so this new job does not duplicate it).

### 5.5 `package-artifact-inspection`

Design for Stage 5, once `build-packaging.md` §7's `electron-builder`
configuration exists. Steps:

1. `pnpm install --frozen-lockfile --ignore-scripts` (§6 on native build
   jobs applies here too — the addon build step remains separate and
   explicit).
2. `node crates/irregular-nesting-native/scripts/build-native.mjs --profile release`.
3. `pnpm native:electron` (unchanged, preserves the targeted `better-sqlite3`
   rebuild — `build-packaging.md` §6, prompt §20.2's "preserve the targeted
   `better-sqlite3` rebuild behavior").
4. `pnpm build && pnpm exec electron-builder --publish=never`.
5. A new, additive inspection script (e.g. `scripts/verify-packaged-artifact.mjs`,
   not present in this checkout today — proposed here, not implemented)
   asserting, per `build-packaging.md` §7/§4.2's flagged risks:
   - `npx asar list release/**/*.asar` contains **no** `.node` files (they
     must be unpacked, not archived);
   - the corresponding `*.asar.unpacked` (or platform-equivalent unpack
     directory) contains `node_modules/irregular-nesting-native/**/*.node`
     and `node_modules/better-sqlite3/**/*.node`;
   - `out/main/index.js` and `out/preload/index.js` contain no inlined
     reference to `irregular-nesting-native`'s module body (grep for the
     package's own source strings, e.g. a literal function name only Rust
     JS-glue would emit) — the concrete check `build-packaging.md` §2 flags
     as "must be smoke-tested in Stage 1 ... not merely assumed";
   - `out/workers/nesting.worker.mjs` contains no inlined `.node`
     binary/base64 content (confirms the `rollupOptions.external` addition
     in `vite.worker.config.ts`, `build-packaging.md` §4.1, actually held).

### 5.6 `packaged-app-smoke`

Design for Stage 5. Feasibility differs sharply by platform — stated
concretely rather than assumed uniform:

- **Linux** (`ubuntu-latest`): feasible. `apt-get install -y xvfb` (or
  `coactions/setup-xvfb`), then `xvfb-run --auto-servernum
  ./release/*.AppImage --no-sandbox` (Electron under a container commonly
  needs `--no-sandbox` in CI), asserting the process reaches a ready signal
  (e.g. main-process log line, or an IPC ping) before being killed. A full
  UI-driven smoke test is out of scope here per prompt §20.2's "without
  turning the migration into unrelated release engineering" — this checks
  that the packaged app boots and the native addon loads inside it, not full
  UI behavior.
- **Windows** (`windows-latest`): feasible. GitHub-hosted Windows runners
  provide an interactive desktop session; run the NSIS-installed or
  `--dir`-extracted app directly, same boot/ready-signal assertion.
- **macOS arm64** (`macos-latest`): feasible. Run the packaged `.app`
  directly; GitHub-hosted macOS runners provide a GUI session.
- **macOS x64**: **not feasible as a genuine hosted-runner smoke test today.**
  A cross-compiled `x86_64-apple-darwin` `.node` binary packaged into a full
  x64 Electron app cannot be run natively on the arm64 `macos-latest` runner,
  and running a full x64 *Electron* app (not just the `.node` file, §5.1)
  under Rosetta is a heavier, less-verified proposition than the single-file
  Rosetta load-smoke in §5.1. This platform's packaged-app smoke test is
  flagged as a genuine gap (§9.1): either accept Rosetta-mediated
  packaged-app verification after an explicit Stage-5 spike proves it works,
  or require one real Intel Mac (self-hosted runner or manual pre-release
  check) before ever claiming macOS x64 as "supported" per prompt §20.1.

## 6. Cache strategy

- **pnpm**: unchanged from the existing convention —
  `actions/setup-node@v4`'s built-in `cache: pnpm`, keyed on `pnpm-lock.yaml`.
  Note: `pnpm-workspace.yaml` today has no `packages:` field (verified, full
  file contents above) — per `stage0-rulings.md` R18, the crate only gains
  its npm `package.json` and a `pnpm-workspace.yaml` `packages:` entry once
  Stage 2's differential harness needs `require('irregular-nesting-native')`
  from TS. Until then, `pnpm install`'s dependency graph does not include the
  crate at all, and native-build jobs invoke `cargo`/`scripts/build-native.mjs`
  directly, independent of the pnpm cache. Once R18 triggers, no cache
  reconfiguration is needed — the same `pnpm-lock.yaml`-keyed cache
  transparently covers the new workspace member.
- **cargo**: `Swatinem/rust-cache@v2`, one instance per `native` matrix entry
  (so Linux/macOS/Windows never share a cache key — `target/` directories are
  not portable across OS or target triple), scoped with `workspaces:
  crates/irregular-nesting-native -> target`. Cache key derives from the
  committed `Cargo.lock` (465 lines, already committed at `dbcfec2`, verified)
  plus the pinned `rustc` version (§9.2), so a lockfile bump or toolchain bump
  correctly invalidates the cache rather than silently reusing stale
  artifacts. `rust-fmt`/`rust-clippy` (ubuntu-only, no build matrix) use their
  own small `Swatinem/rust-cache@v2` instance so they are not blocked waiting
  on the full build matrix's cache population.
- Neither cache is shared between the per-PR `native` matrix and the nightly
  workflow's jobs beyond what the lockfile/toolchain key naturally allows —
  no special-cased nightly-vs-PR cache scoping is needed.

## 7. Native build jobs and `--ignore-scripts`: adjusted deliberately, not weakened globally

`build-packaging.md` §3 (design, already written) establishes the binding
rule this CI matrix must follow, restated concretely for CI: `irregular-nesting-native`'s
own `package.json` (once it exists, R18) must declare **no**
`preinstall`/`install`/`postinstall`/`prepare` script, so native compilation
is never triggered by `pnpm install` itself. Concretely, this means:

- Every job in this matrix — including every `native` matrix entry, the
  packaging jobs, and `existing-full-suite` — keeps the exact existing
  install line unchanged: `pnpm install --frozen-lockfile --ignore-scripts`.
  `--ignore-scripts` is **never** removed or weakened at the `pnpm install`
  call site in any job, matching `build-packaging.md` §3's "`--ignore-scripts`
  is never removed globally to accommodate the native crate."
- Jobs that need a compiled `.node` addon add one explicit, separate,
  non-lifecycle step after install: `node crates/irregular-nesting-native/scripts/build-native.mjs
  --profile release` (or, once wired per `build-packaging.md` §8,
  `pnpm native:rust:release`). This is exactly the "adjust native build jobs
  deliberately rather than globally weakening install safety" the prompt
  asks for — the adjustment is an additive, explicit build step scoped to
  the jobs that need it, not a change to the shared install command every
  job runs.
- `@napi-rs/cli`'s own install-script behavior remains an open,
  Stage-1-flagged risk (`build-packaging.md` §3, §11.3): if `pnpm install
  --ignore-scripts` ever reports it as an ignored build script once it
  becomes a devDependency, the fix is a `pnpm-workspace.yaml` `allowBuilds`
  entry (`"@napi-rs/cli": true`, following the exact `better-sqlite3`/
  `electron`/`esbuild` precedent already in that file), never a change to
  any CI job's `pnpm install` flags. As of this document, the committed
  crate skeleton does not depend on `@napi-rs/cli` at all (verified: no
  `@napi-rs` string anywhere in `package.json`, `Cargo.toml`, or
  `pnpm-workspace.yaml`) — it builds via plain `cargo build --release` plus
  the hand-written staging script, so this risk has not materialized yet and
  may never need to.
- `pnpm native:electron` (`electron-rebuild -f -w better-sqlite3`) stays the
  **only** rebuild step in every job that runs it, scoped exactly as it is
  today (`package.json:25`) — no job adds a corresponding
  `electron-rebuild -w irregular-nesting-native` step, per prompt §20.2
  ("avoid unnecessarily adding the Node-API addon to Electron ABI rebuild
  steps") and `build-packaging.md` §6's ABI-stability rationale.

## 8. Production gates: what runs serially, what parallelizes as independent jobs, and what CI does not measure at all

Per `docs/operations/irregular-production-gates.md` ("Constrained Capacity
Gate" section, quoted): "CI runs the full 18-layout Compact/Short Side matrix
as a separate job, so the independent gate families may overlap without
adding threads or concurrency inside an algorithm execution." Two distinct
rules follow, and conflating them is the most likely CI-design mistake:

1. **Within one gate script/job, execution stays strictly serial.** Every
   gate script (`gate:mixed61-compact`, `gate:compact-nine-baselines`,
   `gate:capacity`, `gate:capacity:production`) already runs its own
   fixtures serially in-process — this is unchanged by CI and is not
   something a workflow file can violate, since it is enforced inside the
   script, not by job scheduling.
2. **Across jobs, independent gate families may run as separate,
   concurrently-scheduled GitHub Actions jobs.** `capacity-quality` and
   `layout-matrix` already do this today (two jobs, same trigger, run in
   parallel on separate runners) — this design's new `mixed61-compact-gate`
   and `focused-correctness-gate` jobs (§5.4) follow the identical pattern:
   separate jobs, no shared runner, no `needs:` dependency forcing
   sequencing, each with its own `concurrency` group
   (`<job-name>-${{ github.ref }}`, `cancel-in-progress: true`, matching the
   existing file's block) so a superseding push cancels only that job's
   in-flight run, not siblings.

**What CI never does:** re-measure `performance-contract.md`'s P1–P7
promotion thresholds. That contract is explicit that its measurements happen
on "one machine under controlled conditions" (§1: a specific pinned Linux
host, "No other performance measurement or heavy process may run
concurrently; measurement batches are strictly serial") — a shared,
variable-load, ephemeral GitHub-hosted runner cannot satisfy that method, and
this design does not pretend otherwise. CI's production-gate jobs assert
**correctness** (exact hashes, exact partitions, generous runtime ceilings
that catch gross regressions, not comparative timing) — never the strict
performance promotion verdict. The prompt's "do not run multiple performance
measurements concurrently on the same host" is satisfied trivially by CI jobs
never being performance measurements in the contract's sense; it becomes
binding only for whoever runs the actual `performance-contract.md` benchmark
batches on the dedicated machine, outside this CI matrix entirely.

Rust-backend production-gate jobs (`mixed61-compact-gate-rust`, etc., §4's
last data row) are additive siblings of the TS-backend jobs, not
replacements, for as long as TypeScript remains the production default
(`stage0-rulings.md` and `backend-selection-rollback.md` §2.2's
`DEFAULT_IRREGULAR_BACKEND = 'typescript'`) — both must stay green
simultaneously; a Rust-backend gate job never supersedes or skips its
TS-backend counterpart.

## 9. Failing hard when a Rust-requested run silently executed TypeScript

This is the concrete CI expression of the fail-closed runtime policy:

1. Every job that intends to run Rust selects `rust` or `differential`
   explicitly. The shared execution module checks archive eligibility and native
   availability before execution. Failure of either check returns a typed job
   failure; it never invokes TypeScript as a substitute.
2. Runtime-focused tests inject counting TypeScript and Rust dependencies and
   assert exact invocation order. They also assert zero backend invocations on a
   failed preflight and zero Rust user callbacks during the differential second
   run.
3. The differential parity CLI prints `typescript=ran rust=ran` only after both
   executions complete. It exits nonzero before execution when native capability
   or archive eligibility is absent, and exits nonzero with the first mismatch
   path when complete projected outcomes diverge.
4. A production differential mismatch is a job failure by construction through
   `irregular_differential_mismatch`; CI must not swallow the nonzero exit or
   typed failure.

Any workflow step piping a gate/test command's output through a filter that
could mask a non-zero exit code (e.g. `| tee log.txt` without `set -o
pipefail`, or unconditionally proceeding to the log-grep step after a failed
run) is a bug in the workflow, not a design gap in the mechanism above — every
job using this pattern must set `bash`'s `pipefail` (`shell: bash` and
`set -o pipefail` at the top of a multi-line `run:` block, or split the run
and grep into separate steps so the run step's own exit code gates the job
independent of the grep step).

## 10. Open questions for the orchestrator

1. **Whether macOS x64's Rosetta-mediated addon-load smoke (§5.1) and the
   flagged packaged-app-smoke gap (§5.6) are sufficient to call that
   platform "supported"** before a real Intel Mac (or a verified,
   Stage-5-spiked Rosetta packaged-app path) has actually run the packaged
   app, per prompt §20.1's explicit "do not claim a platform is supported
   until its binary is built, loaded by the packaged Electron application,
   and smoke-tested." This document's `native` matrix job satisfies "built"
   and a narrow form of "loaded"; it does not satisfy "loaded by the packaged
   Electron application" for macOS x64 specifically.
2. **Exact Rust toolchain pin for CI.** No `rust-toolchain.toml` exists in
   this repository today (verified: none found at any depth under 2). This
   document recommends adding one (e.g. pinning to the `rustc 1.97.1 stable`
   already used for `performance-contract.md`'s baseline measurements, so
   `dtolnay/rust-toolchain@stable` in every job and the developer's `flake.nix`
   rust derivation stay implicitly aligned) rather than each job independently
   floating on whatever `@stable` resolves to on a given day, which could
   silently drift from the pinned performance-contract toolchain.
3. **`build-native.mjs`'s missing `--target` passthrough for cross-compiling
   macOS x64 (§5.1 step 4).** The committed script
   (`crates/irregular-nesting-native/scripts/build-native.mjs`) always builds
   for the host triple; the macOS x64 matrix entry needs either a small
   additive change to accept `--target x86_64-apple-darwin` (staging into the
   correctly-named `.node` file regardless of host `process.arch`) or a
   CI-only direct `cargo build --release --target x86_64-apple-darwin` step
   with manual copy/rename, bypassing the script for that one matrix leg.
   This document does not modify the script (out of scope for a planning
   document); flagged for whoever implements this workflow.
4. **Whether Electron-as-node addon-load smoke (§5.1 step 7) is empirically
   headless-safe on `windows-latest`.** Linux and macOS GitHub-hosted runners
   are well-established to run this mode without a display server (it never
   opens a window); this document has not verified the Windows case and
   flags it rather than assuming parity.
5. **Whether `production-gates.yml` (new) should eventually absorb
   `capacity-quality.yml`'s two existing jobs**, once its additive
   `mixed61-compact-gate`/`focused-correctness-gate` jobs have run reliably
   for a period, versus leaving `capacity-quality.yml` permanently
   untouched and merely sitting alongside a second workflow file. This
   document deliberately leaves `capacity-quality.yml` alone (§3) and treats
   consolidation as a separate, later, explicit decision — not something a
   CI-matrix design document should fold in silently.
6. **Nightly/pre-release job failure policy** — whether a nightly
   `capacity-paired-gate` (§4) or determinism-grid failure should page/block
   anything, or remain informational-until-triaged. This document marks it
   "No (nightly informational + tracked)" in §4 as a reasonable default,
   consistent with the prompt's "keep expensive ... gates controlled and
   reproducible" (read as: run them, but don't make hosted-runner flakiness
   in an expensive nightly job block every subsequent PR), but this is a
   process choice for the orchestrator to confirm, not a fact derived from
   any source document.
