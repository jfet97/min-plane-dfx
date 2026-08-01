# Backend Selection, Fallback, and Rollback — Design

Stage 0 design document for `docs/history/prompts/fable5-rust-irregular-nesting-implementation.md`
§17 ("Backend selection, fallback, and rollback") and the related mandates in
§7 (native capability query), §16 (error mapping table), and §18.1/18.3/18.6
(test forcing, differential mode, "did a requested Rust run silently fall
back"). This document began as the Stage 0 design and now records the implemented
backend-selection, differential, and rollback contract. The native Rust backend
exists in this checkout. Statements in this document describe current behavior
unless a paragraph is explicitly marked as future rollout work.

Primary sources read for this document: `docs/history/prompts/fable5-rust-irregular-nesting-implementation.md`
§§2, 4, 7, 16, 17, 18; `docs/planning/rust-irregular-backend/characterization/worker-coordination.md`
(full); `docs/planning/rust-irregular-backend/characterization/errors-protocol.md`
(full); `docs/planning/rust-irregular-backend/characterization/tests-gates-inventory.md`
(full); `docs/planning/rust-irregular-backend/performance-contract.md`;
`src/main/services/WorkerSupervisor.ts` (full); `src/workers/nesting.worker.ts`
(the `computeIrregularWorkerResult`/`handleRunNesting` region, cross-checked
against `worker-coordination.md`'s line citations); `src/main/ipc/handlers.ts`
(`createSupervisor`/`getWorkerPath`); `src/shared/irregular/defaults.ts`
(`IRREGULAR_WORKER_MODE`, `workerTimeoutForMode`); `src/shared/protocol/errors.ts`;
`src/shared/protocol/worker.ts`.

---

## 1. Governing constraints (from the prompt, restated precisely)

- Backend selection is independent of rectangle-vs-irregular algorithm
  selection (`workerMode`). It must not be conflated with `workerMode`.
- Backend selection must **not** enter `NestingOptions`, sub-run settings, the
  persisted request, or any canonical/result/history/checkpoint data. It is an
  out-of-band worker execution option, process configuration, test-harness
  option, or non-persisted feature flag, resolved **before** algorithm
  execution.
- Tests must be able to force either backend.
- Development must be able to run a differential mode (both backends, same
  request, exact comparison), which is never the production default and never
  runs the two backends concurrently.
- A missing/unloadable native binary must produce a clear capability result.
- Fallback is explicit selection of the TypeScript backend. An explicit Rust
  or differential request never silently substitutes TypeScript.
- Cancellation, deadline, and native semantic errors must never trigger an
  automatic TypeScript retry.
- Native availability and archive eligibility are checked before Rust or
  differential execution. Failure of either check fails the explicit request.
- TypeScript remains usable for rollback after Rust promotion.
- Backend identity, native version, thread count, cache policy, and cache
  telemetry live only in a non-semantic diagnostic channel, excluded from
  parity projections **by construction**, not by after-the-fact field
  removal.
- Any harness that requested Rust and got a silent TypeScript fallback must
  fail, not pass quietly.

## 2. Where the selector concretely lives

### 2.1 The existing precedent this design reuses

`WorkerSupervisor.makeWorkerThread` already injects a non-request,
non-persisted value into the spawned worker thread's process environment:

```ts
// src/main/services/WorkerSupervisor.ts:200-207
const worker = new NodeThreadWorker(this.options.workerPath, {
  env: {
    ...process.env,
    MIN_PLANE_HISTORY_DIR: this.options.historyDirectory
  },
  ...
})
```

`this.options.historyDirectory` is itself resolved once, outside any
`NestingRequest`, from `process.env['MIN_PLANE_HISTORY_DIR']` with a
compiled-in fallback (`src/main/ipc/handlers.ts` → `createSupervisor()` at
`WorkerSupervisor.ts:349`). This is exactly the shape §17 asks for: a
worker-execution-adjacent value that is (a) never part of `NestingRequest`/
`NestingOptions`, (b) resolved by the main process before the job starts,
(c) threaded into the worker thread's environment, not its RPC payload. The
backend selector reuses this exact mechanism rather than inventing a new one.

### 2.2 Concrete design

Shared module **`src/shared/irregular/backendSelection.ts`** is pure and has no
Effect dependency, so it is importable from worker code without pulling in
Electron:

```ts
export type IrregularBackend = 'auto' | 'typescript' | 'rust' | 'differential'

export const IRREGULAR_BACKEND_ENV_VAR = 'MIN_PLANE_IRREGULAR_BACKEND'
export const DEFAULT_IRREGULAR_BACKEND: IrregularBackend = 'auto'

/** Pure and total for recognized values. An unrecognized non-empty value throws. */
export function parseIrregularBackend(raw: string | undefined): IrregularBackend { ... }
export function readIrregularBackendFromEnv(
  env: Readonly<Record<string, string | undefined>>
): IrregularBackend { ... }
```

There is no fallback-policy type, fallback-policy environment variable, or
fallback dispatcher. The worker inherits `MIN_PLANE_IRREGULAR_BACKEND` through
the existing `...process.env` worker-thread environment. The selector is read
once for the job by `computeIrregularWorkerResult`; nothing in
`NestingRequest` or `NestingOptions` is touched.

Tests can force selection by supplying the process-like environment read by the
worker parser or by calling the injected backend execution module directly.
The parity CLI bypasses environment selection and always requests both backends
explicitly.

### 2.3 Inside the worker thread

`nesting.worker.ts`'s `computeIrregularWorkerResult` is the irregular backend
routing call site. It reads `IrregularBackend` from `process.env` once for the
job through `readIrregularBackendFromEnv`, then delegates to
`src/workers/irregular/differential/irregularDifferential.ts`.

`executeIrregularBackend` is the shared execution choke point. TypeScript
selection executes TypeScript directly. Rust and differential selections first
check archive eligibility and native capability. An explicit request fails
before backend execution if either preflight check fails. Differential selection
then runs TypeScript first with normal callbacks and Rust second without user
callbacks. `computeIrregularNestingDifferential` is the dedicated differential
wrapper used by the worker routing branch.

The execution module returns the existing `IrregularComputeResult` success or
`WorkerResponseFailureError` failure channel directly. It does not add backend
identity, capability, or fallback diagnostics to `WorkerResponse`,
`NestingResult`, or `NestingHistoryFrame`.

Existing `gate:*` and baseline scripts remain unchanged. Differential parity
is exercised by `scripts/rust-parity/run-differential.ts`, which directly
preflights and runs the TypeScript and native implementations sequentially.
This keeps backend forcing additive and does not modify pinned baseline values,
tolerances, or production algorithm bounds.

## 3. Capability probe

A lazily-initialized, memoized probe, invoked when `backend` resolves to
`'auto'`, `'rust'`, or `'differential'` for an archive-eligible request. It is
never invoked for the explicit `'typescript'` path or auto's
archive-ineligible TypeScript path, so the native addon is not attempted for
those jobs:

```ts
export type NativeCapabilityProbe =
  | {
      readonly available: true
      readonly nativeApiVersion: number // versioned N-API contract, prompt §7/§20.4
      readonly backendVersion: string // Rust crate semver
      readonly targetTriple: string
      readonly profiles: ReadonlyArray<string>
    }
  | {
      readonly available: false
      readonly reason: 'not-installed' | 'load-error' | 'version-mismatch'
      readonly detail: string // sanitized; no raw panic/backtrace, prompt §16
    }

export function probeNativeIrregularAddon(): NativeCapabilityProbe
```

Implementation shape: a `try { require('irregular-nesting-native') } catch`
around the package's module resolution, then an explicit call into the
addon's own version-query N-API entry point (prompt §7: "native capability
and version query" is one of the required entry points) and a version check
against the native API version this TypeScript build was written against
(prompt §20.4's "compatibility check at load time"). A version mismatch
(addon loads but reports an incompatible `nativeApiVersion`) is treated
identically to a load failure — `available: false`. `probeNativeIrregularAddon`
never throws; every failure mode is captured into the `false` variant. See
`docs/planning/rust-irregular-backend/build-packaging.md` §5 for exactly
which load failures this must classify (missing platform optional-dependency,
ABI mismatch, corrupt binary) and the actionable-error-message requirement.

## 4. Pre-execution backend policy

Backend choice is explicit or automatic. TypeScript is the maintained oracle,
fallback, and rollback path, but rollback requires selecting it explicitly.
An explicitly requested Rust or differential run never silently substitutes
TypeScript. Auto selects TypeScript only for archive-ineligible jobs; an eligible
auto job requires a compatible native addon advertising the job's required
`compact` or `compact-short-side` profile.

Before an eligible auto, Rust, or differential run executes, the worker probes
the native addon and validates the required profile. Unavailable, incompatible,
or profile-mismatched capability fails with `worker_protocol_error` before
either backend starts. Explicit Rust and differential additionally fail before
probing when the request is archive-ineligible. Differential mode performs all
preflight checks before the TypeScript oracle run starts, so it cannot emit
partial TypeScript callbacks and then discover that Rust could not execute.

### 4.1 No-retry rules (hard requirement, not configurable)

Once `executeIrregularBackend` has made the first N-API call for a job
(i.e., control has crossed into Rust), **no code path may retry the same job
in TypeScript**, regardless of what the Rust side returns:

- A native semantic error (any error the Rust boundary maps to one of the 8
  `AppErrorCode` values in `errors-protocol.md` §1.2/§3's table) propagates
  as-is — it is a real job failure, not a cache miss or retry trigger.
- A native cancellation or deadline classification propagates as-is; it is
  never downgraded to "recompute in TypeScript."
- A contained Rust panic (mapped to `unknown_error` per prompt §16, "contained
  panic, internal invariant failure, or otherwise unclassified native
  defect") is a job failure, not a fallback trigger.
- There is no code path anywhere in `executeIrregularBackend` (or any
  caller) that catches a post-dispatch Rust failure and re-invokes the
  TypeScript algorithm for the same request. Any future change that adds
  such a path is, per prompt §17, only permissible if "current semantics and
  duplicate side effects are fully controlled" — which this design does not
  attempt to satisfy and therefore does not implement. This must remain an
  explicit orchestrator decision, not something introduced incidentally
  during Stage 2+ implementation.

This mirrors current TypeScript production behavior exactly:
`worker-coordination.md` §10 establishes that today's production
cancellation/timeout is a **hard external kill** of the whole worker thread
with no partial-result path and no cooperative retry of any kind — the
no-retry rule for the Rust path is the same "no partial result, no silent
recompute" invariant applied to a second backend rather than a new
restriction invented for this migration.

## 5. Differential mode wiring

`backend === 'differential'` is a legal value for both the env-var path
(`nesting.worker.ts`, real worker thread, but never the compiled-in default)
and the direct-call path used by tests and parity scripts. Semantics,
identical in both:

1. Preflight archive eligibility and native capability before either backend
   executes. An explicitly requested unavailable or ineligible Rust or
   differential run fails without a TypeScript fallback.
2. Run **TypeScript first**, to completion, with every normal user callback.
3. Run **Rust second**, sequentially, against the identical validated request.
   The second run is silent: it receives no user progress, snapshot, or trace
   callback.
4. Compare both complete success or typed failure outcomes through
   `src/workers/irregular/differential/irregularSemanticComparison.ts`. The
   shared CLI/runtime projection includes every result field and preserves
   BigInt as exact decimal strings. Documented wall-clock fields, the
   timing-derived serialized trace size, and peak RSS measurements are normalized
   to presence markers; no other semantic field is omitted.
5. On exact match, return the original TypeScript success or failure. TypeScript
   remains the externally observable authority and rollback path.
6. On mismatch, fail with `irregular_differential_mismatch`. Context carries the
   stable first mismatch path plus bounded TypeScript and Rust diagnostic values.

Because differential mode always runs both backends sequentially in one
process/thread, it inherits full N-API/Rayon-pool lifecycle risk twice per
job (§4 of `build-packaging.md` covers pool shutdown) — this is acceptable
for tests/CI/diagnostics, explicitly not for production traffic, and is why
`createSupervisor()`'s own env resolution never produces `'differential'` as
a default; only an explicit operator/CI override can select it.

## 6. Observability and error mapping

Backend identity, native version, thread count, cache policy, and cache
telemetry remain outside semantic result, history, snapshot, ledger, and
checkpoint schemas. The differential parity CLI reports capability and backend
execution to stdout and stderr. Production runtime differential mode exposes
only the original TypeScript success or typed failure when parity holds, or the
stable mismatch failure when parity does not hold.

### 6.1 Error mapping additions to the existing table

The runtime adds backend-orchestration conditions to the external error mapping
without changing existing algorithm failure mappings:

| New internal condition | External `AppErrorCode` | Context fields |
| --- | --- | --- |
| Eligible auto, Rust, or differential request has unavailable or incompatible native capability | `worker_protocol_error` | `requestedBackend`, `reason` |
| Explicit Rust or differential request is archive-ineligible | `worker_protocol_error` | `requestedBackend`, `reason` |
| Eligible auto, Rust, or differential request lacks the required native profile | `worker_protocol_error` | `requestedBackend`, `reason`, `requiredProfile`, `advertisedProfiles` |
| Differential-mode exact-comparison mismatch (§5) | `irregular_differential_mismatch` | `path`, bounded `typescriptValue`, bounded `rustValue` |

No existing row in the 8-row table changes. `not_implemented`,
`irregular_source_geometry_missing`, etc. retain their exact current meaning
and construction sites; this design does not touch any of them.

## 7. Gates must fail on silent fallback

Every gate or CI invocation that intends to run Rust selects `rust` or
`differential` explicitly. There is no fallback-policy setting. The shared
execution module preflights archive eligibility and native availability, and a
failed preflight returns a typed job failure before either backend executes.
After execution begins, native cancellation, deadline, semantic failure, panic,
or callback failure propagates without a TypeScript retry.

The differential CLI provides an additional gate: it reports whether each
backend ran and exits nonzero unless both executions occurred and their complete
projected outcomes compare equal. `docs/planning/rust-irregular-backend/ci-matrix.md`
specifies the CI jobs that exercise this path.

## 8. Rollback runbook

Rollback to TypeScript, at any point after Rust promotion, requires **no
code deploy and no persisted-data migration**, because backend selection
never touches persisted state:

1. Set `MIN_PLANE_IRREGULAR_BACKEND=typescript` in the environment the
   Electron main process launches with. Do not unset the variable or leave it
   empty for rollback: unset and empty values resolve to `auto`, which may
   dispatch an eligible job to Rust.
2. The worker reads the selector for each irregular job, so the next nesting
   job after the environment change runs on TypeScript. No application
   restart is required if the environment change is applied to the running
   process (for example, by assigning `process.env[...]` before the next
   job). A full process restart is required when the environment is supplied
   at OS or launcher level, which is common for packaged desktop apps.
3. No `NestingRequest`, `NestingOptions`, persisted project file, saved job,
   or history artifact needs any change — every persisted shape is already
   backend-agnostic by construction (§1).
4. Verify rollback with a worker routing test or an explicit TypeScript run.
   The selected TypeScript path does not probe or execute the native backend.
5. The Rust addon package remains installed and loadable; rollback does not
   uninstall or unpackage it. A subsequent roll-forward is the same
   one-variable flip in reverse.

This satisfies prompt §17's "TypeScript remains usable for rollback after
Rust promotion" and §25's "Rollback to TypeScript remains immediate and
documented" with a mechanism that is fully exercised by the *test-forcing*
machinery itself (§2.2's supervisor override is literally the same code path
production rollback uses), so rollback is continuously tested from Stage 1
onward rather than being a special, unexercised production-only path.

## 9. Interaction with `workerMode`

`workerMode` (`src/shared/domain/nesting.ts:105`, values including
`IRREGULAR_WORKER_MODE = 'irregular-convex-v2'`, `src/shared/irregular/defaults.ts:14`)
continues to select **rectangular vs. irregular algorithm shape** exactly as
today (`nesting.worker.ts:240,348`, per `worker-coordination.md` §1) and is
completely orthogonal to `IrregularBackend`. Rectangular nesting remains on
its existing TypeScript path and is never routed through irregular backend
execution. The irregular branch delegates to `executeIrregularBackend`.

Rust and differential selections are restricted to archive-eligible Compact
and Compact Short Side jobs. If an irregular request is not archive-eligible,
an explicit Rust or differential selection fails before either backend executes.
TypeScript selection remains the explicit maintained path for legacy or
non-archive irregular jobs.

## 10. Test-forcing surface summary

| Surface | Mechanism | Bypasses worker thread? |
| --- | --- | --- |
| Real `WorkerSupervisor`/IPC path (closest to production) | Set `MIN_PLANE_IRREGULAR_BACKEND` before the per-job worker thread is spawned | No; exercises the real worker thread, RPC layer, and inherited environment |
| `nesting.worker.ts` routing test | Inspect or execute the worker routing branch with a forced environment value | No |
| Differential unit specs | Call `executeIrregularBackend` or `computeIrregularNestingDifferential` with injected TypeScript, Rust, and capability dependencies | Yes |
| Differential parity CLI | `scripts/rust-parity/run-differential.ts` always preflights and runs both backends directly | Yes |
| Native capability probe in isolation | Call `probeNativeIrregularAddon()` directly, with no request or job involved | N/A |

## 11. Open questions for the orchestrator

1. **Worker-thread job cardinality assumption.** This design assumes (per
   `worker-coordination.md`'s traced evidence) that one `nesting.worker.ts`
   thread handles exactly one job, so reading `process.env` once at the top
   of `computeIrregularWorkerResult` is equivalent to reading it once per
   job. If a future change makes `WorkerSupervisor` reuse a worker thread
   across multiple jobs, `IRREGULAR_BACKEND_ENV_VAR` must be re-read (or
   re-injected via a per-RPC-call value instead of process env) — confirm
   this assumption is expected to hold for the duration of the migration.
2. **Env-var-only production rollout vs. an app-level settings toggle.**
   §2/§8 designs the production selector as an environment variable the main
   process reads. For a packaged desktop app, end users/support staff cannot
   set OS environment variables easily; a real rollout likely needs a
   main-process-level persisted **app** setting (distinct from any per-job
   `NestingOptions`) — e.g., a small local config file under
   `app.getPath('userData')` — with the environment variable remaining as
   the lower-level mechanism `createSupervisor()` ultimately still uses
   internally. This document deliberately stops at the environment-variable
   layer, which is sufficient for Stage 1 test-forcing and CI, and defers
   the "how does a real rollout flip this for real users" UX/ops question to
   the orchestrator — it is a product decision, not something inferable
   from source.
3. **Compiled default flip timing.** `DEFAULT_IRREGULAR_BACKEND` is currently
   `'auto'`. Any future default change requires an explicit, separate
   promotion decision gated by `performance-contract.md`; this document does
   not authorize that flip.
