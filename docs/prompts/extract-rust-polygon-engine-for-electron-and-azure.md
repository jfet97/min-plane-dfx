# Prompt: Extract the Rust Polygon Nesting Engine for Electron and Azure

Read this entire prompt before changing any file.

## 1. Mission

After the active native Rust parallelism optimization has reached a terminal,
accepted state on `main`, extract the complete **current Rust polygon nesting
engine** into a new standalone repository.

The resulting engine must have one Rust implementation and two thin delivery
adapters:

1. an N-API package used locally by this Electron desktop application;
2. a normal Rust CLI packaged in an OCI image, to be run once per job by Azure
   Container Jobs.

This is an extraction and product-boundary task. It is not an algorithm
redesign, a performance experiment, a rectangle-nesting task, or a port of the
current TypeScript polygon implementation.

The output must preserve the accepted Rust engine's algorithm, numerical
authorities, deterministic ordering, cancellation semantics, and accepted
quality results. Improve packaging and application boundaries only when that is
necessary to make the engine reusable.

## 2. Scope

### 2.1 In scope

Extract the Rust implementation currently rooted at:

```text
crates/irregular-nesting-native/
```

The extraction includes the archive-eligible Compact and Compact Short Side
polygon engine and the Rust modules it actually requires, including:

```text
archive/          capacity/         caches/           canonical_grid/
checkpoints/      clipper/          domain/           geometry/
js_number/        nfp_ifp/          result/           search/
short_side/       trace/            transforms/       validation/
```

It includes the job-owned Rayon pool, cache ownership, canonical JSON, input
revalidation, cancellation checkpoints, and semantic progress/snapshot events.

The current natural extraction seam is already present:

```text
boundary::run_job  plain Rust execution and job ownership
boundary::job      Node/libuv/N-API AsyncTask and ThreadsafeFunction glue
```

Use that seam as evidence, but do not retain the current `boundary` directory
layout merely because it already exists.

### 2.2 Explicitly out of scope

Do not move, port, redesign, or maintain any of the following as part of this
task:

- rectangular nesting or MaxRects;
- the current TypeScript polygon algorithm, requested-sheet beam, or GA path;
- Electron renderer, preload, main process, SQLite workspace, DXF dialogs, or
  project persistence;
- Vue UI state, Electron history persistence, or worker-thread supervision;
- an Azure HTTP API, database schema, Blob Storage account, Azure credentials,
  or a deployment in a real Azure subscription.

Do not broaden native support beyond the current archive-eligible Compact and
Compact Short Side contract. An ineligible legacy request must remain a typed
unsupported/ineligible engine outcome, never be silently emulated.

## 3. Gate before any extraction

Do not start from an active optimization worktree or a partially accepted Rust
change.

1. Inspect `git status`, current branch, `origin/main`, recent commits, the
   active native optimization branch or PR, and all relevant CI results.
2. Confirm that the active parallelism work has either been merged to `main`
   with its required correctness and performance evidence, or has been
   explicitly rejected and reverted.
3. Record the exact accepted source commit as `SOURCE_MIN_PLANE_COMMIT` in the
   new repository's migration document and release metadata.
4. Run the current native Rust and Electron integration gates before moving
   code. Preserve their artifacts and canonical result identities as the
   migration baseline.
5. If a baseline is not reproducible, fix the baseline first. Do not use an
   extraction as an opportunity to hide an existing correctness or performance
   uncertainty.

The source of truth is the accepted current Rust code, not old prompts. Read
the current crate, its tests, relevant knowledge pages, package scripts, CI,
and the newest parallelism evidence before deciding where every module belongs.

## 4. Target repository and crate layout

Create a separate repository only after its Git host, owner, repository name,
NPM registry, and container registry are known. Do not invent external
destinations or publish packages/images to a guessed organization.

Use `polygon-nesting-engine` below as a placeholder repository name only. A
reasonable Rust workspace shape is:

```text
polygon-nesting-engine/
  Cargo.toml
  Cargo.lock
  crates/
    polygon-nesting-core/
    polygon-nesting-protocol/
    polygon-nesting-cli/
    polygon-nesting-napi/
  packages/
    polygon-nesting-napi/
  tests/
    vectors/
    integration/
  docs/
    migration-from-min-plane-dfx.md
    azure-container-job-contract.md
  Dockerfile
```

Different names are acceptable only when the same dependency direction is
preserved:

```text
protocol <- core <- cli
                 <- napi
```

`core` must never depend on `napi`, `napi-derive`, Node, Electron, libuv,
Azure SDKs, HTTP servers, shell argument parsing, Blob Storage, or application
database code.

### 4.1 `polygon-nesting-protocol`

Own versioned, serde-backed engine data:

- `EngineRequest` and supported profile/settings fields;
- `EngineResult`, diagnostics, semantic error envelope, and non-semantic
  execution diagnostics;
- ordered `EngineEvent` values for progress and optional snapshots;
- input/output format versioning and compatibility rules;
- canonical JSON where it is already part of deterministic behavior.

The protocol must be application-neutral. It may start from the current Rust
request/result DTOs and their exact wire semantics, but it must not expose
Electron IPC envelopes, TypeScript `Schema.Class` instances, worker request
IDs, UI labels, filesystem paths, or persistence details as engine concepts.

Keep the safety-critical Rust revalidation at the protocol boundary. The
external backend is untrusted exactly as the desktop boundary is untrusted.

### 4.2 `polygon-nesting-core`

Own all deterministic polygon computation. Its public service should be typed,
not a `String -> String` wrapper, for example:

```rust
run(
    request: EngineRequest,
    control: &mut dyn EngineControl,
    events: &mut dyn EngineEventSink,
) -> Result<EngineResult, EngineError>
```

The exact type names may differ, but preserve these properties:

- the core has no N-API, CLI, Azure, Node, or Electron dependency;
- JSON parsing and serialization happen in adapters, not inner algorithm code;
- one engine invocation owns one job-local Rayon pool, caches, and coordinator;
- Rayon work remains deterministic and uses only the job-owned pool;
- cancellation is cooperative and retains the first terminal reason;
- events are semantic data, ordered by the core, rather than N-API callbacks;
- engine errors are typed and do not depend on the desktop app's error enum;
- cache/thread telemetry stays explicitly non-semantic.

Do not replace exact integer-grid `BigInt` authorities, robust predicates,
Clipper2 Boolean ownership, V8-parity numerical behavior, or their differential
and vector tests with looser approximations during the split.

### 4.3 `polygon-nesting-napi`

This is the Electron-only adapter. It may depend on `napi-rs` and contains all
Node/libuv-specific behavior currently in `boundary::job`, `boundary::events`,
and N-API diagnostics glue.

It must:

- expose a coarse-grained asynchronous call, never per-candidate or per-NFP
  N-API traffic;
- adapt the established Electron package API or provide a deliberate,
  versioned compatibility migration for it;
- map engine events onto the existing acknowledged callback semantics;
- preserve cancellation, terminal acknowledgement, event ordering, and error
  containment guarantees required by Electron;
- contain no algorithm decision, cache ownership, or duplicate validation
  logic that belongs in the core.

The desktop application should eventually depend on a versioned external NPM
package, not `workspace:*` and not a repository-relative Rust path.

### 4.4 `polygon-nesting-cli`

This is the Azure adapter. It is an ordinary Linux executable, not a Node
program and not an HTTP server.

Provide an explicit, testable file contract such as:

```text
polygon-nesting run \
  --input /work/request.json \
  --output /work/result.json \
  --events /work/events.ndjson
```

The exact flags may differ, but the contract must be stable and documented:

- input is one versioned engine request;
- output is one versioned engine result/error envelope;
- events are optional, ordered NDJSON and can be disabled for final-only jobs;
- process exit status distinguishes success, domain failure, cancellation, and
  malformed invocation;
- `SIGTERM`/deadline cancellation is translated to the same cooperative core
  control mechanism;
- no Azure credential, storage SDK, customer data path, or application
  database concern enters the core.

## 5. Azure Container Jobs model

The engine repository supplies an OCI image containing the CLI. It does not
need to create or manage a live Azure environment.

The consuming backend owns orchestration:

```text
frontend
  -> backend creates run record: queued
  -> backend writes request.json to durable storage
  -> backend starts one Azure Container Job execution with run ID/input reference
  -> container runs polygon-nesting CLI once
  -> container writes result.json and optional events.ndjson to durable storage
  -> backend exposes status and result to frontend
```

An Azure Container Job is a temporary container. It starts, runs one nesting
calculation, writes durable artifacts, exits, and is then gone. It is not the
always-running HTTP backend.

Use one engine invocation per container execution. Scale customer demand by
starting more Azure executions, not by running unrelated nesting jobs inside
one process. Assign CPU and memory to each execution; the job-owned Rayon pool
uses that container allocation for parallel inner work.

Do not use N-API in the Azure container. N-API produces a Node addon for the
desktop integration. The Azure image runs the normal Rust CLI built from the
same `polygon-nesting-core` source.

Initially, prefer final-result jobs with compact status/progress artifacts.
Make complete replay history an explicit opt-in artifact. Do not turn large
state snapshots into a high-frequency backend-to-frontend transport by
default.

## 6. Packaging and release requirements

One engine version must identify all distributable artifacts built from the
same source commit:

- Rust crates and tagged source release;
- NPM N-API package with prebuilt supported `.node` binaries;
- OCI image for the Linux CLI;
- checksums, release notes, and source commit metadata.

Carry forward the current native packaging guarantees where relevant:

- explicit target mapping and target-specific native artifacts;
- Node and Electron addon-load coverage;
- macOS staging/signing behavior required for the copied `.node` artifact;
- legal notices and license files for translated Clipper2 material;
- package contents allowlists and verification that the package does not ship
  source trees or a Cargo `target/` directory;
- a Linux container smoke test that invokes the CLI using a real fixture.

The current desktop targets are Linux x64, Windows x64, macOS arm64, and macOS
x64. Do not promise Linux arm64 or other targets without adding build and test
coverage. The Azure image target must match the actual selected Azure runtime
architecture.

Publishing an NPM package and publishing an OCI image are separate release
actions. Do not mark the migration complete until both delivery paths are
versioned, reproducible, and independently verified.

## 7. Migration sequence

### Phase A: freeze and characterize

1. Capture `SOURCE_MIN_PLANE_COMMIT`, toolchain versions, target triples,
   profile/version, request fixtures, semantic output identities, thread-count
   diagnostics, and benchmark environment.
2. Run the current Rust vectors, native thread-equality checks, native package
   tests, Electron load verification, and accepted Compact quality gates.
3. Copy or move all Rust-owned fixtures and golden vectors into the new
   repository with their provenance. Do not rely on paths back into
   `min-plane-dfx`.
4. Add a migration document that maps every extracted module and test from its
   source path to its new owner.

### Phase B: establish the standalone workspace

1. Create the protocol and core crates before creating either adapter.
2. Move the Rust algorithm and tests as an atomic first import, retaining
   complete license/provenance material.
3. Replace the current N-API-bound `String -> String` runner internally with a
   typed core boundary while preserving adapter-visible compatibility where the
   desktop needs it.
4. Move the job pool, caches, event trait, cancellation, request validation,
   error projection, result projection, and diagnostics to their appropriate
   protocol/core ownership.
5. Remove stale references to `min-plane-dfx` documents from public crate docs;
   replace them with current standalone documentation and explicit migration
   provenance.
6. Keep the first split intentionally behavior-preserving. Do not combine it
   with new profiles, different scores, history redesign, cache tuning, or a
   new parallelization hypothesis.

### Phase C: build adapters

1. Build the N-API crate/package on top of the extracted core and reproduce
   the desktop addon API and lifecycle tests.
2. Build the CLI on top of the same core and add fixture-based input, output,
   event, domain-failure, cancellation, and malformed-request tests.
3. Add a minimal multi-stage Dockerfile that runs the CLI as a non-root user.
   The image must contain only what the CLI needs at runtime.
4. Document the Azure execution/storage contract, but do not provision Azure
   resources or hard-code an Azure account into the engine repository.

### Phase D: release and desktop cutover

1. Build and verify release artifacts from the new repository.
2. Publish only to the explicitly authorized package and container registries.
3. In `min-plane-dfx`, replace the workspace dependency with the released NPM
   package version and retain the existing package-name resolution pattern.
4. Run the current Electron and native integration/package gates against the
   external package, including the packaged-app verifier on every supported
   desktop target.
5. Compare old embedded-addon and new external-package output for the frozen
   corpus. Differences are release blockers unless a documented, separately
   accepted algorithm change caused them.
6. Only after every cutover gate passes, remove the embedded Rust crate,
   bespoke staging scripts, and obsolete CI from `min-plane-dfx`. Keep a
   version-pinned rollback path to the last accepted external package.

## 8. Required verification

The following are minimum acceptance conditions. Add focused tests for any
new seam or failure mode discovered during extraction.

### Core and protocol

- Rust formatting and clippy with warnings denied;
- all moved Rust unit/vector tests;
- canonical JSON and exact-grid numeric vectors;
- thread-count determinism and job-pool ownership tests;
- archive eligibility/profile validation tests;
- exact frozen-corpus result identities and non-semantic diagnostic separation;
- malformed request and error-envelope tests at the protocol boundary.

### N-API adapter

- plain Node and Electron-as-Node addon-load tests;
- existing terminal acknowledgement, ordered-event, cancellation, and cleanup
  lifecycle tests;
- a real-addon end-to-end fixture through the external NPM package;
- target-specific packaging, notice, and macOS signing verification.

### CLI and OCI image

- fixture run writes the expected final result;
- optional event file is ordered and parses as NDJSON;
- malformed input, typed engine failure, cancellation, and output write
  failures have defined exit behavior;
- Docker build and non-root runtime smoke test;
- image metadata identifies engine version and source commit.

### Cross-repository cutover

- `min-plane-dfx` has no runtime repository-relative dependency on the old
  crate after removal;
- its supported packaged Electron artifacts load the released N-API package;
- the new engine repository can run all core, CLI, N-API, and release tests
  without the old checkout present;
- the future backend can invoke the CLI from the OCI image without Node or
  Electron installed.

## 9. Documentation and evidence

Keep durable evidence in the new repository:

- architecture diagram and crate dependency direction;
- protocol version and compatibility policy;
- N-API compatibility and publishing policy;
- CLI file and exit-status contract;
- Azure Container Job integration contract, clearly separating engine work
  from consuming-backend work;
- source migration map, accepted baseline commit, artifacts, fixture hashes,
  and reproducible commands;
- rejected extraction alternatives and their evidence, where applicable.

Do not claim Azure deployment, registry publishing, or a supported platform
unless it actually happened and has been verified. Do not claim reproducibility
without a recorded command and canonical output hash.

## 10. Delivery discipline

Work on an isolated branch/worktree. Keep the extraction reviewable in
coherent commits:

1. baseline and standalone core/protocol;
2. N-API adapter and package release pipeline;
3. CLI/OCI image and Azure integration contract;
4. `min-plane-dfx` external-package cutover and removal of the embedded crate.

Do not bundle unrelated cleanup. Do not delete the source crate before the
released external package has passed the desktop cutover gates.

Before completion, run the required validation in both repositories, inspect
all diffs, update the relevant knowledge bases, and report:

- accepted source and engine release commits;
- artifact versions, checksums, and supported targets;
- every executed gate and its result;
- exact remaining external blockers, if repository/registry/Azure authority
  was not supplied.

Never add AI/tool attribution, co-author lines, or generated-content markers
to commits, packages, images, release notes, or project documentation.
