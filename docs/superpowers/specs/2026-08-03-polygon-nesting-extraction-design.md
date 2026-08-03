# Polygon Nesting Engine Extraction Design

## Status

The conversational design was approved on 2026-08-03. The written specification is pending the required file review gate.

The owner authorized autonomous execution after specification review. Immediate confirmation is still required before the first outward-facing package and image publication, and before deleting the embedded source crate after external-package cutover.

## Mission

Extract the accepted Rust polygon nesting engine from `min-plane-dfx` into a private standalone repository named `jfet97/polygon-nesting`.

The standalone repository will provide one deterministic Rust implementation through two thin adapters:

1. an N-API package for the Electron desktop application;
2. a normal Rust CLI in an OCI image for one-shot Azure Container Job executions.

This is a behavior-preserving product-boundary extraction. It does not redesign the algorithm, add profiles, alter scoring, tune caches, expand platform support, or move the TypeScript polygon implementation.

## Accepted source and gate decision

The initial source candidate is:

```text
SOURCE_MIN_PLANE_COMMIT=e4f3608878611c002f343473fab72adc7d155f87
```

At design time:

- local `main`, `origin/main`, and GitHub `main` all identify this commit;
- the working tree is clean;
- PR 30 introduced the retained job-owned Rayon implementation;
- PR 31 restored semantic periodic-crop chronology by reverting one parallel seam;
- PR 32 corrected macOS staged-addon signing;
- the current `main` push workflow passed Rust formatting, Clippy, release tests, required differential rows, thread equality, native loading, and four-target packaging;
- quality acceptance and the full strict differential matrix were skipped on that push because their workflow conditions require a pull request, schedule, or manual dispatch. Phase A must run both on the exact frozen source.

The checked-in performance measurements predate the PR 31 correction. The owner explicitly accepted the existing tests and results and waived fresh post-correction performance benchmarking as an extraction blocker. The migration document and release evidence must state this fact without claiming that historical speedup measurements describe the exact extracted source.

The source commit must be rechecked immediately before the Phase A freeze. If `main` changes, the freeze and all source identities must use the newly accepted commit instead.

## External destinations

The authorized destinations are:

- GitHub repository: private `github.com/jfet97/polygon-nesting`;
- NPM registry: GitHub Packages;
- NPM package: `@jfet97/polygon-nesting`;
- OCI registry: GitHub Container Registry;
- OCI image: `ghcr.io/jfet97/polygon-nesting`;
- initial OCI architecture: `linux/amd64`;
- first unified engine version: `0.1.0`.

The first release should publish both the NPM package and OCI image after all release gates pass. Immediate confirmation is required before publication because these are outward-facing actions.

Rust crates are workspace implementation units for the initial release. They are not published to crates.io.

## Repository structure

```text
polygon-nesting/
  Cargo.toml
  Cargo.lock
  crates/
    polygon-nesting-protocol/
    polygon-nesting-core/
    polygon-nesting-cli/
    polygon-nesting-napi/
  packages/
    polygon-nesting/
  tests/
    vectors/
    fixtures/
    integration/
  docs/
    architecture.md
    migration-from-min-plane-dfx.md
    protocol-compatibility.md
    napi-compatibility.md
    cli-contract.md
    azure-container-job-contract.md
  Dockerfile
```

The required dependency direction is:

```text
polygon-nesting-protocol <- polygon-nesting-core <- polygon-nesting-cli
                                               <- polygon-nesting-napi
```

`polygon-nesting-core` must never depend on N-API, Node, Electron, libuv, Azure SDKs, HTTP servers, shell argument parsing, storage SDKs, or application database code.

## Extraction strategy

Use an atomic workspace import rather than lifting the current combined crate or rewriting repository history.

The first standalone import establishes protocol and core ownership together and moves the algorithm, tests, vectors, legal files, and provenance without changing behavior. The adapters are then built on the typed boundary. Provenance is retained through source commit metadata, fixture and artifact hashes, a complete migration map, and copied license material rather than filtered Git history.

## Protocol crate

`polygon-nesting-protocol` owns application-neutral, versioned serde types and compatibility policy:

- `EngineRequest` and supported Compact or Compact Short Side settings;
- `EngineResult`;
- ordered semantic `EngineEvent` values;
- typed `EngineError` and output envelope;
- non-semantic `ExecutionDiagnostics`;
- input and output format versions;
- deterministic wire serialization rules for protocol envelopes;
- safety-critical validation of untrusted external data.

Core-internal checkpoint canonical JSON, identity preimages, and cache-key encoders remain core-owned. They are not protocol wire formats and must not be exposed through the protocol crate.

The standalone request must not expose Electron routing concepts such as `jobId`, `strategyRunId`, `workerMode`, UI labels, persistence paths, or worker request IDs.

The current desktop request DTO remains in the N-API compatibility adapter. It preserves current presence-sensitive fields, unknown-field behavior, defaults, and error projection, then converts into the neutral `EngineRequest`.

Archive-ineligible requests remain typed unsupported outcomes. They are never silently emulated by the TypeScript algorithm or a new legacy mode.

Protocol validation and runtime geometry validation remain distinct. Protocol validation protects the untrusted boundary. Core validation protects computation invariants and placement legality.

## Core crate

`polygon-nesting-core` owns deterministic polygon computation and all invocation-local resources.

It contains the extracted implementation currently rooted in:

```text
archive/
capacity/
caches/
canonical_grid/
checkpoints/
clipper/
domain/
geometry/
js_number/
nfp_ifp/
result/
search/
short_side/
trace/
transforms/
validation/
```

It also owns the reusable portions of the current boundary:

- typed job execution;
- job-owned Rayon pool;
- requested and actual worker resolution;
- geometry and free-material caches;
- coordinator ownership;
- cooperative cancellation and first-terminal-reason retention;
- semantic event sequencing;
- internal-to-protocol result and error projection;
- non-semantic cache and thread telemetry.

The public service is typed, for example:

```rust
pub fn run(
    request: EngineRequest,
    control: &dyn EngineControl,
    events: &mut dyn EngineEventSink,
) -> Result<EngineResult, EngineError>
```

Exact names may differ, but JSON parsing and serialization are adapter concerns.

One call owns one pool, all caches, cancellation state, coordinator state, and diagnostics. All parallel work uses the owned pool. Immutable parallel results are replayed in deterministic order. The ambient global Rayon pool is never initialized by the engine.

The extraction must preserve:

- exact integer-grid and BigInt authority;
- robust predicate ownership;
- translated Clipper2 Boolean and offset behavior;
- current JavaScript number compatibility rules;
- canonical JSON and cache-key byte semantics;
- deterministic ordering;
- serial periodic-crop checkpoint and attempt chronology;
- cache cleanup and bounds;
- current Compact and Compact Short Side quality outcomes.

No cache-key or canonical-JSON implementation is deduplicated during the split unless byte equivalence is first proved. Type-erased cache behavior is retained during the behavior-preserving extraction.

## Cancellation model

Core defines application-neutral cooperative control and retains the first terminal reason atomically.

Protocol-visible terminal reasons remain:

- explicit cancellation;
- deadline expiration.

`SIGTERM` maps to ordinary explicit cancellation. It does not add a new protocol-visible reason. A later reason cannot overwrite the first observed reason. Existing cancellation checkpoints and chronology remain unchanged.

The N-API invocation-token registry, JavaScript reason parsing, and environment cleanup hooks remain adapter-owned. `EngineRequest` retains the current positive millisecond runtime limit as an application-neutral deadline duration. The CLI accepts an optional positive `--deadline-ms <N>` safety override. The effective deadline is the earlier of the request deadline and the CLI override. Omitting the flag leaves the request deadline unchanged.

Public job identifiers are never used as cancellation identity.

## Event model

Protocol owns semantic progress and optional snapshot values. Core owns production order and ordinal assignment.

The N-API adapter maps core events onto the established callback JSON and acknowledged terminal lifecycle. The terminal frame, terminal latch, callback acknowledgement, and delivery-error containment are N-API transport concerns, not semantic engine events.

The CLI writes the same semantic event values as ordered NDJSON. Events can be disabled for final-only runs. Complete replay snapshots are opt-in and are not emitted at high frequency by default.

The existing N-API event sink's deferred delivery-failure behavior is preserved. A transport failure does not silently become a new core cancellation or alter deterministic computation.

## Error and diagnostics model

Protocol and core use application-neutral typed errors for:

- malformed input;
- protocol version mismatch;
- archive ineligibility;
- invalid geometry;
- cancellation;
- deadline expiration;
- deterministic engine failure.

The N-API adapter maps those errors back to the current desktop categories and compatibility envelope. N-API status failures, callback delivery failures, environment cleanup state, and FFI panic containment remain in the adapter.

The CLI serializes the shared result or error envelope and maps outcomes to documented exit statuses.

Requested and actual thread counts, cache telemetry, timings, memory measurements, and adapter lifecycle counters are non-semantic. They never affect canonical result identity.

## N-API adapter and package

`polygon-nesting-napi` owns:

- N-API exports;
- `AsyncTask` and `ThreadsafeFunction` integration;
- current desktop JSON compatibility;
- cancellation-token registry;
- terminal acknowledgement and ordered callback delivery;
- event delivery error handling;
- N-API panic containment;
- addon capability and target diagnostics;
- process-global last-job diagnostics where compatibility requires them.

The NPM package at `packages/polygon-nesting` is published as `@jfet97/polygon-nesting`. The desktop preserves its existing runtime import through an NPM alias:

```json
{
  "dependencies": {
    "irregular-nesting-native": "npm:@jfet97/polygon-nesting@0.1.0"
  }
}
```

The installed dependency key therefore remains `irregular-nesting-native`, and the existing package-name `require()` path remains valid. The first release also retains the current staged binary filename pattern `irregular-nesting-native.<platform>-<arch>.node`. Loader and staged-binary error detection do not require an application migration in `0.1.0`.

The package owns:

- stable CommonJS loading;
- explicit platform and architecture mapping;
- prebuilt target-specific `.node` files;
- package contents allowlists;
- package metadata and release provenance;
- Clipper2 notice and full license text.

The repository `.npmrc` contains only the scope mapping and environment-token reference:

```ini
@jfet97:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
always-auth=true
```

No credential is committed. The private package grants GitHub Actions access to `jfet97/min-plane-dxf`. Its CI uses a token with `read:packages`; release CI uses `write:packages`. Local development supplies `NODE_AUTH_TOKEN` from the user's authenticated GitHub package token or equivalent credential.

Initial desktop targets remain closed to:

- Linux x64;
- Windows x64;
- macOS arm64;
- macOS x64.

The build stages the explicit target artifact. Copied macOS addons receive the required ad-hoc signature before load verification. Unsupported targets fail clearly. The package must not ship Rust source trees or Cargo `target/` directories.

The package keeps the current coarse-grained job call. It never introduces per-candidate or per-NFP traffic across N-API.

## CLI adapter

`polygon-nesting-cli` is an ordinary Linux executable. It is not a Node program and not an HTTP server.

Initial contract:

```text
polygon-nesting run \
  --input /work/request.json \
  --output /work/result.json \
  --events /work/events.ndjson \
  --deadline-ms 300000
```

`--events` and `--deadline-ms` are optional. A final-only job omits `--events`. A missing deadline override uses the request's runtime limit. The override must be a positive integer number of milliseconds and can only shorten the request deadline.

Stable exit statuses are:

```text
0  successful engine result
1  unexpected adapter or internal failure
2  malformed CLI invocation, malformed input JSON, or protocol version mismatch
3  typed domain or deterministic engine failure
4  cancellation or deadline expiration
5  requested result or event artifact could not be written
```

When `--output` is syntactically available and writable, malformed input, version failure, domain failure, cancellation, deadline, and internal failure all write the versioned result or error envelope atomically before returning the corresponding nonzero status. A malformed CLI invocation that does not establish an output path has no output-artifact guarantee.

Result and event files are written to sibling temporary files and renamed only after complete serialization and flush. An event write failure does not change the semantic engine outcome, but the CLI attempts to write an I/O failure envelope to `--output` and exits with status 5. If the result itself cannot be written, stderr and status 5 are the only guaranteed signals.

No Azure credential, storage SDK, customer path convention, HTTP route, or application persistence concern enters protocol or core.

## OCI image

The initial image is `linux/amd64` and contains only the release CLI, legal material, certificates required for the runtime environment, and minimal runtime support.

The Dockerfile is multi-stage and runs the CLI as a non-root user. The runtime image includes OCI labels for:

- engine version;
- source repository;
- source commit;
- license metadata;
- image revision.

A real fixture smoke test builds the image, verifies the runtime user is non-root, runs one calculation, and checks the result and optional NDJSON events.

The image executes one engine invocation and exits. Unrelated nesting jobs are never multiplexed inside one container process.

## Azure Container Job contract

The engine repository documents but does not provision Azure resources.

The initial handoff uses a platform-managed Azure Files volume mounted at `/work`. Azure or backend orchestration owns the storage account, credentials, mount, retention, and access policy. The engine container sees ordinary filesystem paths only.

The consuming backend owns:

1. creating a queued run record;
2. writing `/work/request.json` on the durable mounted volume;
3. starting one Azure Container Job execution with that volume mounted;
4. passing only CLI paths and optional deadline configuration;
5. reading the atomically renamed `/work/result.json` and optional `/work/events.ndjson` after the execution exits;
6. recording the process status and exposing status and results to the frontend.

A nonzero exit can still have a durable typed error artifact. The backend treats the exit status and output envelope together. Missing output after exit is an orchestration or I/O failure, not a domain outcome.

The container is temporary. It runs one calculation, writes durable artifacts through the mounted filesystem, and exits. It is not the persistent HTTP backend. Alternative Blob Storage staging or upload belongs to a consuming wrapper or backend and is not implemented in the engine image.

The initial runtime contract assumes Linux amd64. No Linux arm64 support is claimed.

## Migration phases

### Phase A: freeze and characterize

- Recheck clean `main`, `origin/main`, source commit, and GitHub checks.
- Record exact Node, pnpm, Electron, Rust, Cargo, target, OS, CPU, and memory metadata.
- Run current Rust formatting, Clippy, release tests, thread equality, no-global-pool containment, real-addon, lifecycle, differential, quality, capacity, and package gates.
- Materialize standalone EngineRequest fixtures for Triangle-20, Mixed-61, and Shapes-17.
- Preserve all current Rust vectors and source fixtures with SHA-256 manifests.
- Preserve old-engine result or error envelopes, ordered events, normalized semantic identities, canonical layout identities, requested and actual worker diagnostics, addon hashes, and legal hashes.
- Record the explicit performance-gate waiver. Do not reuse historical speedup values as current-source claims.

A reproducible baseline failure is fixed in `min-plane-dfx` before extraction proceeds.

### Phase B: standalone protocol and core

- Create the private GitHub repository only after confirming it does not already exist.
- Establish the workspace and lockfile.
- Import protocol and core atomically with tests, vectors, fixtures, notices, and migration map.
- Replace the internal JSON runner with the typed service.
- Preserve a temporary adapter-only compatibility wrapper for parity testing.
- Remove public documentation paths that require the old checkout while retaining explicit migration provenance.

### Phase C: adapters and release pipeline

- Build N-API compatibility on the typed core.
- Build the CLI and its file, event, cancellation, and exit-status tests.
- Build and smoke-test the non-root Linux amd64 OCI image.
- Add private GitHub Actions release workflows for the four desktop addons, NPM package, Linux amd64 image, checksums, and private GitHub release.
- Release actions use one tag and version identity.

### Phase D: release candidate and desktop cutover

- Assemble one release-candidate NPM tarball containing all four verified desktop binaries and record its SHA-256.
- Build one Linux amd64 release-candidate image, record its immutable image digest, and export it for prepublication smoke tests.
- In an isolated `min-plane-dfx` cutover branch, replace `workspace:*` with the exact local tarball through the dependency key `irregular-nesting-native`.
- Compare embedded and release-candidate outputs over the frozen corpus.
- Run plain Node, Electron-as-Node, lifecycle, native integration, quality, and all four packaged-app gates against the exact tarball bytes intended for publication.
- Run CLI and OCI gates against the exact image digest intended for publication.
- Confirm immediately before outward publication.
- Publish the already verified tarball as `@jfet97/polygon-nesting@0.1.0` to GitHub Packages without rebuilding it.
- Publish the already verified image digest as `ghcr.io/jfet97/polygon-nesting:0.1.0` and an immutable source-revision tag without rebuilding it.
- Create the private GitHub release with the same checksums, image digest, and evidence.
- Replace the local tarball in `min-plane-dfx` with `"irregular-nesting-native": "npm:@jfet97/polygon-nesting@0.1.0"` and the authenticated GitHub Packages configuration.
- Verify a clean registry installation, package integrity, plain Node load, Electron-as-Node load, and packaged application smoke from the published package. These postpublication checks verify registry delivery, while all correctness and four-target release gates already ran on the immutable prepublication bytes.
- Retain a version-pinned rollback path.
- Confirm immediately before deleting the embedded crate and obsolete staging or CI ownership.
- Remove embedded ownership only after every cutover and registry-delivery gate passes.

## Verification

### Protocol and core

- `cargo fmt --check`;
- Clippy with warnings denied;
- all moved Rust unit and vector tests;
- exact canonical JSON, grid, layout, JS-number, robust predicate, Clipper, NFP/IFP, cache-key, capacity, search, archive, reconstruction, and Short Side vectors;
- typed malformed request and version tests;
- archive eligibility tests;
- cancellation first-reason tests;
- thread-count equality across repeated runs;
- no-global-Rayon process isolation;
- exact frozen-corpus result identities;
- explicit proof that diagnostics do not affect semantic hashes.

### N-API

- plain Node addon load;
- Electron-as-Node addon load;
- API compatibility and capability shape;
- real-addon fixture;
- ordered event delivery;
- terminal acknowledgement;
- cancellation and cleanup lifecycle;
- malformed request compatibility;
- package allowlist;
- legal-file inclusion;
- macOS copied-addon signing and child-process load;
- target-specific builds for all four supported desktop targets.

### CLI and image

- success fixture output;
- ordered parseable NDJSON;
- final-only mode;
- malformed invocation and malformed request;
- typed engine failure;
- cancellation, deadline, and `SIGTERM` handling;
- result and event write failures;
- Linux amd64 image build;
- non-root runtime proof;
- real fixture smoke;
- OCI version and source metadata.

### Cross-repository cutover

- no runtime repository-relative dependency after removal;
- released package loads in all supported packaged Electron targets;
- frozen old and new semantic identities match;
- standalone repository tests pass without the old checkout;
- OCI CLI runs without Node or Electron;
- package and image versions identify the same source release.

## Documentation and evidence

The standalone repository retains:

- architecture and dependency diagram;
- protocol compatibility policy;
- N-API compatibility and publishing policy;
- CLI file and exit-status contract;
- Azure Container Job integration contract;
- complete source module and test migration map;
- source commit and engine release commit;
- fixture, vector, package, addon, image, notice, and license hashes;
- exact commands and gate outcomes;
- recorded gate waiver and rejected alternatives;
- supported targets and explicit unsupported targets.

Claims are limited to actions actually performed. No Azure deployment, crates.io publication, arm64 Linux support, public package visibility, or cross-platform performance result is claimed without direct verification.

## Commit structure

Keep the work reviewable in coherent commits:

1. baseline evidence plus standalone protocol and core;
2. N-API adapter and NPM release pipeline;
3. CLI, OCI image, and Azure integration contract;
4. desktop external-package cutover;
5. embedded-crate removal only after confirmed cutover acceptance.

Do not combine unrelated cleanup or algorithm experiments with the extraction.

## Final independent review

After implementation and verification, run the interactive `codex-review-chat` skill using `gpt-5.6-sol` at `xhigh` reasoning effort. Provide the approved specification, implementation plan, final diffs, and verification evidence. Resolve every confirmed finding before completion or document why it does not apply.
