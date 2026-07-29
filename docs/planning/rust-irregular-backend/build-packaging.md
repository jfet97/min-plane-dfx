# Native Build and Packaging — Design

Stage 0 design document for `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
§20 ("Packaging and Electron integration"). Design for Stage 1+; no
`crates/` directory, no `napi`/`@napi-rs` dependency, no `Cargo.toml`, and no
`electron-builder` configuration exist in this checkout today (verified:
`find . -maxdepth 1 -iname electron-builder*` → none; `node -e "require('./package.json').build"`
→ `undefined`; `grep -n napi package.json` → no hits). Every claim about
current repository state below is source-cited; every claim about the
Rust-era design is marked as design.

Primary sources read for this document: `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
§20 (full); `package.json` (full, `scripts`/`engines`/`devDependencies`/
`dependencies`); `pnpm-workspace.yaml` (full); `electron.vite.config.ts`
(full); `vite.worker.config.ts` (full); `flake.nix` (full, already extended
with a Rust toolchain per the orchestrator's prior decision); `src/main/services/WorkerSupervisor.ts`
(`makeWorkerThread`); `src/main/ipc/handlers.ts` (`getWorkerPath`,
`createSupervisor`); `docs/planning/rust-irregular-backend/characterization/tests-gates-inventory.md`
§12 (dual-runtime finding); `docs/planning/rust-irregular-backend/characterization/worker-coordination.md`;
`.github/workflows/capacity-quality.yml` (the only existing CI workflow, for
the `--ignore-scripts` convention); `node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/package.json`
(verified `better-sqlite3`'s own install script: `"install": "prebuild-install
|| node-gyp rebuild --release"` — a classic V8-ABI/node-gyp addon, **not**
Node-API, which is the concrete justification in §6 for why it needs
`electron-rebuild` and a napi-rs addon does not).

---

## 1. Target package layout

`crates/irregular-nesting-native/` (path fixed by the orchestrator's prior
decision) is a single directory that is simultaneously:

- a Cargo package (`Cargo.toml`, `src/lib.rs`, `build.rs`) — the `napi`/
  `napi-derive`/`napi-build` convention colocates the crate and its
  napi-rs-generated npm package in one directory, and
- an npm package (`package.json` with a `napi` config block, a generated
  `index.js`/`index.d.ts` loader, and — for the multi-platform prebuild model
  in §7 — a set of per-platform optional-dependency stub packages under
  `crates/irregular-nesting-native/npm/<platform-arch>/`, the standard
  `@napi-rs/cli` scaffold produced by `napi build`/`napi create-npm-dirs`).

Proposed npm package name: **`irregular-nesting-native`**, unscoped, matching
the root package's own unscoped naming (`"name": "min-plane-dfx"`,
`package.json`) — there is no existing `@scope` convention in this repository
to match (verified: no internal `@...` package exists among current
`dependencies`/`devDependencies`). This is a low-stakes naming choice the
orchestrator can trivially rename; it is fixed here only so the rest of this
document and `ci-matrix.md` have one concrete string to refer to.

A root-level `Cargo.toml` workspace manifest is added:

```toml
[workspace]
resolver = "2"
members = ["crates/irregular-nesting-native"]
```

This lets `cargo fmt`/`cargo clippy`/`cargo test` run from the repository
root (matching how `pnpm` commands already run from root) without every CI
step needing a `--manifest-path`/`cd` indirection, and gives natural room to
add a second crate later (e.g. a `clipper2-rs-vendor` crate housing the
vendor-translated Clipper2 subset named in the orchestrator's Clipper2
strategy decision) as an additional workspace member without restructuring.

## 2. pnpm workspace integration

`pnpm-workspace.yaml` currently has no `packages:` field at all (verified,
full file contents: `verifyDepsBeforeRun: false` plus `allowBuilds`) — the
root project is implicitly the only workspace package. This design adds:

```yaml
packages:
  - '.'
  - 'crates/*'

verifyDepsBeforeRun: false

allowBuilds:
  better-sqlite3: true
  electron: true
  esbuild: true
  # See §3 — add an entry here only if Stage 1 empirically confirms
  # @napi-rs/cli or the native package itself declares a blocked lifecycle
  # script; do not add speculatively.
```

The root `package.json` gains a workspace dependency:

```json
{
  "dependencies": {
    "irregular-nesting-native": "workspace:*"
  }
}
```

so `require('irregular-nesting-native')`/`import ... from 'irregular-nesting-native'`
resolves through ordinary pnpm-managed `node_modules` linking from every
consumer (`src/workers/nesting.worker.ts`, `src/main`, `scripts/*.ts` run
under `tsx`, `tests/unit/*.test.ts` run under vitest) with no special-cased
path resolution — this is why §5's binary-resolution design needs almost no
custom logic, unlike the pre-existing `getWorkerPath()` candidate-list
pattern (`src/main/ipc/handlers.ts:152-160`), which exists only because
`out/workers/nesting.worker.mjs` is a build artifact placed *outside*
`node_modules` by `vite.worker.config.ts`, not because native-module
resolution itself is hard.

Declaring it as a `dependency` (not `devDependency`) matters beyond pnpm
linking: `electron-vite`'s `externalizeDepsPlugin()` (used by every
`electron.vite.config.ts` build target — see §4) externalizes packages
listed in `dependencies`/`optionalDependencies`/`peerDependencies` by
default, not `devDependencies`. Putting the native package in
`devDependencies` would risk Rollup trying to bundle it into the `main`/
`preload` output. This must be smoke-tested in Stage 1 (build once, inspect
the `out/main`/`out/preload` bundles for an inlined reference to the native
package), not merely assumed from documented plugin behavior.

## 3. Build-script allowlist

The existing `allowBuilds` map (`pnpm-workspace.yaml`, quoted above) is
pnpm's mechanism for approving a dependency's `preinstall`/`install`/
`postinstall`/`prepare` lifecycle scripts, which pnpm blocks by default for
anything not explicitly listed (the `better-sqlite3`/`electron`/`esbuild`
entries are the existing precedent — `better-sqlite3` needs this because its
own `install` script runs `prebuild-install || node-gyp rebuild`, quoted in
full above).

Design rule for `irregular-nesting-native` itself: **its own `package.json`
must declare no `preinstall`/`install`/`postinstall`/`prepare` script.**
Native compilation is triggered only by an explicit, non-lifecycle `pnpm`
script (§8), never by an npm install hook. This is deliberate, not
incidental: the existing CI workflow already installs with `--ignore-scripts`
(`.github/workflows/capacity-quality.yml`: `pnpm install --frozen-lockfile
--ignore-scripts`, confirmed the only workflow file in this repository), and
`--ignore-scripts` disables **every** lifecycle script repository-wide,
including the root package's own `postinstall` (`pnpm native:electron`,
`package.json`). A native crate that requires a lifecycle hook to become
usable would silently produce a half-installed workspace under the existing
CI convention. Keeping native compilation entirely out of lifecycle hooks
means:

- `pnpm install --ignore-scripts` continues to be safe and fast for any CI
  job that does not need a compiled addon (pure TypeScript typecheck/lint,
  for example).
- Native-build CI jobs opt in explicitly via a separate step (`ci-matrix.md`
  §3), matching the prompt's "adjust native build jobs deliberately rather
  than globally weakening install safety" (§20.3).
- `--ignore-scripts` is never removed globally to accommodate the native
  crate.

**Unresolved dependency risk, flagged for empirical Stage-1 verification,
not asserted as fact:** `@napi-rs/cli` (the `napi` CLI, a devDependency this
design will add) is a third-party package whose own install-script behavior
has not been inspected in this pass (it is not yet installed anywhere in
this checkout). If `pnpm install` reports it as a blocked build script (pnpm
prints an "Ignored build scripts" list, and `pnpm approve-builds` is the
interactive command to inspect/approve it), add `"@napi-rs/cli": true` to
`allowBuilds` following the exact precedent already set for `better-sqlite3`/
`electron`/`esbuild` — do not weaken `--ignore-scripts` at the `pnpm install`
invocation level to work around it.

## 4. Keeping the `.node` addon external to bundled output

### 4.1 The worker bundle (`vite.worker.config.ts`)

The worker is built as a single-file ESM bundle
(`format: 'es'`, `ssr: true`, `lib.entry: src/workers/nesting.worker.ts`,
output `out/workers/nesting.worker.mjs`) with an explicit
`rollupOptions.external` allowlist that today reads:

```ts
external: [
  'electron',
  'node:worker_threads',
  'node:fs',
  'node:path',
  'node:url',
  'node:crypto'
]
```

Design change: add `'irregular-nesting-native'` to this array. Rollup, given
an external specifier, never traverses into that module's source at all — it
leaves the `import`/`require` as a runtime resolution left to Node. This
means napi-rs's generated JS loader (which internally performs a sequence of
per-platform `try { require('./irregular-nesting-native.<platform>.node')
} catch { ... }` calls, or requires a per-platform optional-dependency
package — the exact shape depends on which napi-rs packaging mode is chosen,
§7) is never inspected or rewritten by Rollup; it executes exactly as
written, resolved by Node's own `node_modules` algorithm at run time. No
further Rollup configuration (no manual `.node` asset handling, no `assetsInclude`)
is needed as long as the whole package is external — Rollup only ever sees
the bare import specifier `'irregular-nesting-native'`, never a `.node` file
path.

**One cross-module-system risk requires a Stage-1 smoke test, not an
assumption:** `nesting.worker.mjs` is genuine ESM (`.mjs` extension, `format:
'es'`), and importing a CommonJS package (napi-rs's generated `index.js` is
CJS by default) from ESM relies on Node's CJS-named-exports detection
(`cjs-module-lexer`), which works reliably for the simple
`module.exports.foo = ...`/`exports.foo = ...` assignment patterns napi-rs
generates, but this must be verified against the *actual* generated file
once `napi build` has run, not assumed from napi-rs's general reputation for
ESM compatibility. If named-export detection fails, the fallback is
`import pkg from 'irregular-nesting-native'; const { compactExecute } = pkg`
(default-import-then-destructure), which always works for CJS interop
regardless of static analysis and should be the pattern used in
`irregularBackendDispatch.ts` (see
`docs/planning/rust-irregular-backend/backend-selection-rollback.md`) from
the start, sidestepping the risk rather than depending on the smoke test
passing.

### 4.2 The main/preload bundles (`electron.vite.config.ts`)

Both the `main` and `preload` targets already use
`plugins: [externalizeDepsPlugin()]` (`electron.vite.config.ts:10,20`), which
externalizes everything in `dependencies` (§2) automatically — no manual
`external` array exists for these targets today (unlike the worker's
hand-written list), and none should be added specifically for the native
package; `externalizeDepsPlugin()`'s existing, already-relied-upon behavior
is the mechanism. This must still be smoke-tested once the dependency is
declared (§2), since `externalizeDepsPlugin()`'s exact matching rules
(e.g., whether it externalizes transitive dependencies of a workspace
package, which matters for napi-rs's per-platform optional-dependency
subpackages, §7) are not verified in this pass.

### 4.3 Renderer bundle

The renderer (`src/renderer`) never imports the native package — nesting
execution is worker/main-process-only, and no source under `src/renderer`
should ever import `irregular-nesting-native` directly. No renderer-target
configuration change is needed; this is stated only to close the loop on all
four `electron.vite.config.ts` build targets.

## 5. Binary resolution: dev, test, unpackaged production, packaged

| Mode | Worker bundle location | Native addon resolution | Notes |
| --- | --- | --- | --- |
| **Dev** (`pnpm dev`) | `out/workers/nesting.worker.mjs`, rebuilt by `pnpm build:worker` (chained into `dev`, `package.json`) | `node_modules/irregular-nesting-native` (pnpm workspace symlink → `crates/irregular-nesting-native`, containing whatever `.node` file the developer's last `pnpm build:native` produced for their own OS/arch) | No ASAR involved. Ordinary `require`/`import` resolution. |
| **Test** (`pnpm test`/`test:focused`) | Same `out/workers/...mjs` | Same `node_modules/irregular-nesting-native` | **Dual runtime**: `pnpm test` runs vitest inside Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1 electron ...`, `package.json:26`), while every `scripts/irregular-*.ts` gate/baseline script runs under plain `tsx`/system Node (`tests-gates-inventory.md` §12, source-verified). A single N-API-built `.node` binary must load correctly under **both** without a separate rebuild step for either — see §6 for why this is expected to hold, unlike `better-sqlite3`. |
| **Unpackaged production** (`pnpm build && electron .`, or `electron-vite preview`) | `out/workers/...mjs` (built, not dev-server-served) | Same `node_modules/irregular-nesting-native` | Same as dev; still no ASAR. |
| **Packaged** (electron-builder output) | Inside `app.asar` (or unpacked, depending on `files`/`asarUnpack` — the worker `.mjs` itself is plain JS text and is fine to remain inside the asar) at a path `getWorkerPath()`-equivalent logic must resolve (§5.1) | `node_modules/irregular-nesting-native` **must be listed under `asarUnpack`** (§7) — a native addon's `.node` binary cannot be `dlopen`'d directly from inside an asar archive, an Electron/Node limitation independent of napi-rs, identical in kind to why any node-gyp addon needs the same treatment | This is the one mode requiring new packaging configuration (§7); nothing here is implemented today (no `build` key in `package.json`). |

### 5.1 The worker-path resolver already anticipates this split

`getWorkerPath()` (`src/main/ipc/handlers.ts:152-160`, quoted in full):

```ts
function getWorkerPath(): string {
  const candidates = [
    join(__dirname, 'workers', 'nesting.worker.mjs'),
    join(__dirname, '..', 'workers', 'nesting.worker.mjs')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] ?? join(__dirname, 'workers', 'nesting.worker.mjs')
}
```

This candidate-list-then-`existsSync` pattern exists because the worker
bundle is a **file outside `node_modules`**, whose location relative to
`__dirname` differs between dev/unpackaged and packaged layouts. The native
addon does **not** need an equivalent candidate list: it is resolved by
package name through Node's ordinary module resolution
(`require('irregular-nesting-native')`/`import ... from
'irregular-nesting-native'`), which works identically inside an asar archive
for the package's `index.js`/JS-only files (Electron's asar integration
patches `fs`/module resolution to read JS files transparently from inside
the archive) — only the `.node` binary itself needs to physically exist
**outside** the archive (`asarUnpack`, §7), at exactly the path Node's
resolution algorithm would compute if the archive weren't compressed at all
(Electron's asar-unpack mechanism preserves the same directory shape
alongside the `.asar` file specifically so this works without any addon-side
special-casing). **This must be confirmed by an addon-load smoke test against
an actual packaged build (`ci-matrix.md` "packaging-smoke" job) before being
relied upon** — it is standard, well-documented Electron/napi-rs behavior,
not a novel claim, but this document has not itself built and smoke-tested a
packaged artifact.

## 6. Why the N-API addon does not need `electron-rebuild`, and why `better-sqlite3` does

`better-sqlite3`'s own `package.json` `install` script (quoted in full, §
header) is `"prebuild-install || node-gyp rebuild --release"` — this is the
classic pre-N-API native-addon model: a binary compiled against a specific
Node ABI version (`NODE_MODULE_VERSION`), which differs between plain Node
and Electron's bundled (patched) Node/V8 even at the same nominal Node
version. That ABI mismatch is exactly what `electron-rebuild` exists to fix,
and exactly why `package.json`'s `native:electron` script
(`"electron-rebuild -f -w better-sqlite3"`) is scoped with `-w
better-sqlite3` — targeting only that one package, not a general "rebuild
every native dependency" pass.

An addon built through `napi-rs` against the **Node-API** (N-API) ABI is, by
N-API's own design goal, ABI-stable across Node releases and across
Electron's bundled Node, as long as both runtimes expose the N-API version
the addon was compiled against (prompt §20.4: "Node-API reduces ABI coupling
but does not eliminate packaging, target, libc, or application compatibility
concerns" — the "does not eliminate" clause is why §5's table still calls
out the dual-runtime *test* requirement explicitly, and why §3's capability
probe/version check exists at all; ABI stability is a design goal, not a
substitute for verification). Concretely: `Cargo.toml`'s `napi` dependency
should pin an explicit N-API version feature (e.g., an `napi = { version =
"3", features = ["napi4"] }`-shaped declaration — the exact minimum N-API
version is a Stage-1 decision based on which N-API surface the crate
actually needs, not fixed by this document) rather than defaulting to the
newest experimental ABI tier, and the **same compiled `.node` binary** is
used for both the Electron-bundled Node path and the plain-Node/`tsx` path
in `pnpm test` — no `electron-rebuild -w irregular-nesting-native` step is
ever added, and `native:electron`'s existing `-w better-sqlite3` scoping is
preserved byte-for-byte (prompt §20.2: "preserve the targeted `better-sqlite3`
rebuild behavior").

## 7. electron-builder additions

No `build` configuration exists in `package.json` today (verified: `require('./package.json').build`
→ `undefined`), despite `electron-builder` already being a devDependency.
Per prompt §20.2 ("The current repository has electron-builder installed but
lacks a complete packaging configuration. Add the minimum production-grade
configuration required for native artifacts, without turning the migration
into unrelated release engineering"), this design proposes the minimum
additive `build` block needed for the native addon and the worker bundle to
survive packaging — explicitly **not** a full release-engineering pass
(no code signing, no auto-update, no installer polish; those remain
out of scope and are not implied by anything below):

```json
{
  "build": {
    "appId": "com.min-plane.dfx",
    "directories": { "output": "release" },
    "files": [
      "out/**/*",
      "node_modules/**/*",
      "package.json"
    ],
    "asarUnpack": [
      "**/*.node",
      "node_modules/irregular-nesting-native/**"
    ],
    "npmRebuild": false,
    "mac": { "target": ["dmg"] },
    "win": { "target": ["nsis"] },
    "linux": { "target": ["AppImage"] }
  }
}
```

Key decisions and rationale:

- **`asarUnpack: ["**/*.node", ...]`** — a broad glob is intentionally
  redundant with the explicit `node_modules/irregular-nesting-native/**`
  entry; `better-sqlite3`'s own `.node` file needs identical treatment and is
  covered by the broad glob alone, so no `better-sqlite3`-specific line is
  needed. If the per-platform prebuild model (§7.1) is used instead of a
  single in-tree package, the unpack pattern must instead cover every
  `irregular-nesting-native-<platform>-<arch>` optional-dependency package
  (`node_modules/irregular-nesting-native-*/**`) — this is a Stage 5
  decision contingent on which of §7.1's two models is chosen.
- **`npmRebuild: false`** — electron-builder's default behavior includes an
  npm/pnpm rebuild pass for native dependencies before packaging (its own
  version of what `electron-rebuild` does standalone). Per prompt §20.2
  ("avoid unnecessarily adding the Node-API addon to Electron ABI rebuild
  steps"), this is explicitly disabled; the existing `native:electron`
  script remains the **only** rebuild step in the pipeline, and it stays
  scoped to `better-sqlite3` (§6). `npmRebuild: false` must not silently
  break `better-sqlite3`'s own Electron-ABI compatibility in a packaged
  build — this needs a Stage-5 packaging smoke test confirming
  `better-sqlite3` still loads correctly in a packaged app when
  `native:electron`'s output is what ships (i.e., that the pre-rebuilt
  `better-sqlite3` binary present in `node_modules` at packaging time is
  the one electron-builder includes, since `npmRebuild: false` means
  electron-builder will not redo that work itself).
- **`files`** — a minimal allowlist; the exact glob needs Stage-5 tuning
  (e.g., excluding `node_modules/.pnpm`'s dev-only packages) but the
  principle — `out/**` (build output, including the worker `.mjs`) plus
  `node_modules/**` (runtime dependencies, including the native package and
  its `.node` binary) — is the minimum needed for the packaged app to have
  everything §5's resolution table requires at runtime.
- **Target selection** (`dmg`/`nsis`/`AppImage`) is one target per platform,
  the simplest viable choice per platform, deliberately not an exhaustive
  installer matrix — consistent with "without turning the migration into
  unrelated release engineering."

## 8. `package.json` script additions (additive, no existing script edited)

| New script | Purpose |
| --- | --- |
| `native:rust` | `pnpm --filter irregular-nesting-native build` (debug build for local dev speed; napi-rs's `napi build` without `--release`) |
| `native:rust:release` | `pnpm --filter irregular-nesting-native build -- --release` — used by CI's native-build jobs (`ci-matrix.md`) and by packaging |
| `build:native` (alias, used by `dev`/`test` prerequisite chaining, §8.1) | Resolves to `native:rust` in dev-oriented invocations |

### 8.1 Wiring into existing scripts, matching the existing `native:electron` precedent

`pnpm test`'s current definition already chains a native-rebuild
prerequisite ahead of the actual test run:

```json
"test": "pnpm native:electron && ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run"
```

This design extends the same pattern additively (existing scripts are edited
only to *prepend* a new prerequisite step, never to change their own
existing behavior once that prerequisite succeeds — `pnpm native:electron`
itself is untouched):

```json
"test": "pnpm native:electron && pnpm native:rust && ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run",
"dev": "pnpm native:electron && pnpm native:rust && pnpm build:worker && electron-vite dev"
```

This is a **behavior-preserving** addition under prompt §3: it does not
change any existing test's expected values, only ensures the native addon
exists before tests run (analogous to why `native:electron` already exists
before tests run — `better-sqlite3` must be loadable before any test that
touches the database layer, and once Rust backend tests exist, the same
logic applies to `irregular-nesting-native`). Because `pnpm run <script>`
invocations (as opposed to lifecycle hooks fired by `pnpm install`) are
**not** affected by `--ignore-scripts` (§3), this chaining continues to work
correctly in CI even though CI installs with `--ignore-scripts` — `pnpm test`
is invoked as an explicit, separate CI step, not as part of `pnpm install`.

Crucially, `postinstall: "pnpm native:electron"` (`package.json`, existing)
is **not** extended to also run `pnpm native:rust` — native Rust compilation
stays out of the install lifecycle entirely (§3), even for local developer
convenience; a developer running `pnpm install` for the first time will need
to separately run `pnpm native:rust` (or `pnpm dev`/`pnpm test`, which now
chain it) before the addon exists. This asymmetry versus `native:electron`
is deliberate, not an oversight — it is the direct consequence of §3's rule
that native compilation must never be a lifecycle hook.

## 9. Prebuild targets

Per prompt §20.1, at minimum: macOS arm64, macOS x64, Windows x64, Linux
x64. Rust target triples:

| Platform | Rust target | Notes |
| --- | --- | --- |
| macOS arm64 | `aarch64-apple-darwin` | Native build on an Apple-Silicon CI runner |
| macOS x64 | `x86_64-apple-darwin` | Cross-compiled from the same Apple-Silicon runner (`rustup target add x86_64-apple-darwin`, Xcode's clang/linker already support this target natively) rather than a separate Intel runner — the standard napi-rs community pattern for this platform pair, avoiding a second paid macOS runner class. Flagged for Stage-5 empirical verification since this document has not built anything. |
| Windows x64 | `x86_64-pc-windows-msvc` | Native build on a Windows runner; MSVC toolchain is the napi-rs default and requires no extra setup beyond the standard `rustup` MSVC target, which hosted Windows runners already support. |
| Linux x64 | `x86_64-unknown-linux-gnu` | glibc target, matching hosted Ubuntu CI runners exactly (`ci-matrix.md`). musl (for Alpine-style portability) is explicitly **not** in scope unless the orchestrator later narrows/widens the supported-platform list — the prompt's floor is these 4 targets, and this repository's development machine (NixOS, per `performance-contract.md`) is glibc-based, consistent with targeting glibc rather than musl by default. |

No platform's binary may be claimed "supported" until it is built, loaded by
a packaged Electron application on that platform, and smoke-tested (prompt
§20.1's own requirement, restated here because it directly gates when
`ci-matrix.md`'s packaging-smoke job may be considered authoritative per
platform).

### 9.1 Two packaging models — a Stage-1 decision, not resolved by this document

napi-rs supports two common distribution shapes, and this document
deliberately does not pick one, because the choice has downstream
consequences for `asarUnpack` globs (§7), `allowBuilds` (§3), and CI artifact
handling (`ci-matrix.md`) that should be decided once, explicitly, in Stage 1:

1. **Single in-tree package, multiple `.node` files.** `irregular-nesting-native/`
   ships every platform's compiled `.node` file directly inside the one
   package (napi-rs's generated `index.js` picks the right one at `require`
   time by `process.platform`/`process.arch`). Simpler pnpm-workspace story
   (one package), larger published/installed size (all platforms' binaries
   present even though only one is used at runtime) — acceptable for an
   Electron app that is not published to a public npm registry.
2. **Per-platform optional-dependency subpackages.** `irregular-nesting-native`
   depends on `irregular-nesting-native-darwin-arm64`,
   `irregular-nesting-native-win32-x64-msvc`, etc. as `optionalDependencies`;
   npm/pnpm installs only the one matching the current platform. Smaller
   per-platform install, but requires each subpackage to actually be
   published/linked (workspace-local subpackages under
   `crates/irregular-nesting-native/npm/*` work for this without npm-registry
   publication, using pnpm's workspace-protocol linking, but this needs
   Stage-1 verification that pnpm's workspace linking correctly resolves
   *optional* workspace dependencies per-platform during `pnpm install`
   rather than always installing all of them, which would defeat the size
   benefit and complicate the "only the current platform's binary is
   present" assumption §5's resolution table relies on).

Model 1 is the simpler default recommendation for this repository
specifically, because the artifact is a private, self-packaged Electron app
(not a published npm library many consumers install), and disk-size-per-install
matters far less than for a public library — but this is a recommendation,
not a decision this document is authorized to finalize; flagged in §11.

## 10. Actionable load-failure errors

The capability probe (`docs/planning/rust-irregular-backend/backend-selection-rollback.md`
§3) is the consumer of every load failure this section produces. Concrete
failure classification the probe must be able to distinguish (each maps to a
different `NativeCapabilityProbe.reason` and a different sanitized `detail`
string, per that document's schema):

- **`not-installed`** — `require('irregular-nesting-native')` throws
  `MODULE_NOT_FOUND` (package absent from `node_modules` entirely — e.g. a
  platform whose optional-dependency subpackage, §9.1 model 2, was not
  installed because it didn't match the current platform). Actionable
  `detail`: name the attempted package, `process.platform`/`process.arch`,
  and point at `pnpm native:rust` (dev) or the relevant CI/packaging job
  (production) as the remediation.
- **`load-error`** — the package resolves, but napi-rs's own loader throws
  while attempting to `require` the platform-specific `.node` file (corrupt
  binary, wrong OS/arch binary present, missing shared-library dependency).
  Actionable `detail`: include the underlying error's message (sanitized —
  no raw stack/backtrace beyond a single-line summary, per prompt §16's
  "do not expose raw panic payloads or a native backtrace by default")
  alongside `process.platform`/`process.arch` and the resolved package path.
- **`version-mismatch`** — the addon loads and responds to the
  capability/version-query N-API entry point (prompt §7), but reports a
  `nativeApiVersion` this TypeScript build does not recognize/support
  (§20.4's "compatibility check at load time"/"clear behavior for version
  mismatch"). Actionable `detail`: report both the addon's reported version
  and the TypeScript build's expected version range.

None of these three ever throw an unhandled exception out of
`probeNativeIrregularAddon()` — every failure mode is caught at the
`require`/version-check boundary and converted to the typed
`{ available: false, reason, detail }` shape, which is what makes the
"missing or unloadable native binary produces a clear capability result"
requirement (prompt §17) concrete rather than aspirational.

## 11. Open questions for the orchestrator

1. **Single-package vs. per-platform-optional-dependency model (§9.1)** is
   an explicit Stage-1 decision this document recommends but does not make.
2. **`npmRebuild: false`'s interaction with `better-sqlite3` in a packaged
   build (§7)** needs a Stage-5 empirical packaging smoke test before being
   relied upon; this document states the intended mechanism, not a verified
   outcome.
3. **`@napi-rs/cli`'s own install-script behavior (§3)** is unverified in
   this pass (the package is not yet installed anywhere in this checkout);
   Stage 1 must check `pnpm install`'s "ignored build scripts" output and
   add an `allowBuilds` entry only if actually needed.
4. **Exact minimum N-API version to target (§6)** is a Stage-1 decision
   based on which N-API surface (async work queue, `ThreadsafeFunction`,
   etc.) the coarse boundary and Rayon-facing cancellation/progress design
   actually need — deferred to the native-boundary-schema document, not
   fixed here.
5. **`electron.vite.config.ts`'s `externalizeDepsPlugin()` exact matching
   rules for a workspace (`workspace:*`) dependency with its own nested
   optional dependencies (§4.2, §9.1 model 2)** are asserted from documented
   plugin behavior, not verified against this specific package shape — flag
   for a Stage-1 build-and-inspect smoke test before relying on it in CI
   (`ci-matrix.md`'s `native-build`/`addon-load-smoke` jobs are designed to
   catch a failure here).
6. **`appId`/target list/output directory (§7)** are placeholder-reasonable
   defaults, not confirmed product decisions — the orchestrator should
   confirm or replace `com.min-plane.dfx` and the specific installer targets
   (`dmg`/`nsis`/`AppImage`) before Stage 5 packaging work treats them as
   final.
