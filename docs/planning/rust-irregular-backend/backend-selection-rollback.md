# Backend Selection, Fallback, and Rollback — Design

Stage 0 design document for `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
§17 ("Backend selection, fallback, and rollback") and the related mandates in
§7 (native capability query), §16 (error mapping table), and §18.1/18.3/18.6
(test forcing, differential mode, "did a requested Rust run silently fall
back"). This document is a **design for Stage 1+**; no production Rust exists
yet in this checkout (confirmed: no `crates/` directory, no `napi`/`@napi-rs`
dependency in `package.json`, no `Cargo.toml` anywhere under version control).
Nothing described here is implemented; every claim about current TypeScript
behavior is source-cited, and every claim about the Rust-era design is marked
as design, not status.

Primary sources read for this document: `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
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
- Fallback is explicit and observable; no silent fallback after Rust has
  begun a job.
- Cancellation, deadline, and native semantic errors must never trigger an
  automatic TypeScript retry.
- An unavailable addon may fall back **before execution** if policy permits.
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

New shared module: **`src/shared/irregular/backendSelection.ts`** (new file,
pure, no Effect dependency — must be importable from both `src/main` and
`src/workers` without pulling in Electron):

```ts
export type IrregularBackend = 'typescript' | 'rust' | 'differential'

export type IrregularBackendFallbackPolicy = 'strict' | 'fallback-before-execution'

export const IRREGULAR_BACKEND_ENV_VAR = 'MIN_PLANE_IRREGULAR_BACKEND'
export const IRREGULAR_BACKEND_FALLBACK_POLICY_ENV_VAR =
  'MIN_PLANE_IRREGULAR_BACKEND_FALLBACK_POLICY'

export const DEFAULT_IRREGULAR_BACKEND: IrregularBackend = 'typescript'
export const DEFAULT_IRREGULAR_BACKEND_FALLBACK_POLICY: IrregularBackendFallbackPolicy = 'strict'

/** Pure, total, no I/O. Throws on an unrecognized non-empty value — an
 * operator typo must not silently resolve to the default. */
export function parseIrregularBackend(raw: string | undefined): IrregularBackend { ... }
export function parseIrregularBackendFallbackPolicy(
  raw: string | undefined
): IrregularBackendFallbackPolicy { ... }
```

`WorkerSupervisorOptions` (`WorkerSupervisor.ts:25-28`) gains two optional
fields, mirroring `historyDirectory`:

```ts
export interface WorkerSupervisorOptions {
  readonly workerPath: string
  readonly historyDirectory: string
  readonly defaultTimeoutMs: number
  readonly irregularBackend?: IrregularBackend                    // new
  readonly irregularBackendFallbackPolicy?: IrregularBackendFallbackPolicy // new
}
```

`makeWorkerThread` (`WorkerSupervisor.ts:200-207`) is extended:

```ts
env: {
  ...process.env,
  MIN_PLANE_HISTORY_DIR: this.options.historyDirectory,
  [IRREGULAR_BACKEND_ENV_VAR]: this.options.irregularBackend ?? DEFAULT_IRREGULAR_BACKEND,
  [IRREGULAR_BACKEND_FALLBACK_POLICY_ENV_VAR]:
    this.options.irregularBackendFallbackPolicy ?? DEFAULT_IRREGULAR_BACKEND_FALLBACK_POLICY
}
```

`createSupervisor()` (`src/main/ipc/handlers.ts:137-146`) resolves
`WorkerSupervisorOptions.irregularBackend` from `process.env[IRREGULAR_BACKEND_ENV_VAR]`
at supervisor-construction time — **this is the one place production
configuration lives**; nothing in `NestingRequest`/`NestingOptions` is
touched. Test/CLI callers construct their own `WorkerSupervisor` (or the
lower-level direct-call dispatch in §5) with an explicit
`irregularBackend`/`irregularBackendFallbackPolicy`, bypassing `process.env`
entirely — this is "test forcing" at the supervisor layer.

**Resolution granularity is deliberately per-job, not per-app-session.**
`makeWorkerThread` runs once per `WorkerSupervisor.runNesting` call
(confirmed: `NodeWorker.layer(() => this.makeWorkerThread(requestId, request.jobId))`
lazily invokes the factory once per job — `WorkerSupervisor.ts:122-125`,
consistent with the class's own doc comment "every call gets its own worker
instance", `:69-71`). If `createSupervisor()` re-reads `process.env` on every
`runNesting()` call rather than only at construction (a small, explicitly
recommended deviation from the existing `historyDirectory` precedent, which
is fixed at construction time), an operator can flip the backend with no
Electron app restart — this is the concrete rollback mechanism (§7).

### 2.3 Inside the worker thread

`nesting.worker.ts`'s `computeIrregularWorkerResult` (`:340-401`) is the sole
call site of `computeIrregularNesting`. It is changed to call a new dispatch
module instead of `computeIrregularNesting` directly:

**`src/workers/algorithm/irregular/irregularBackendDispatch.ts`** (new file)
is the single choke point that implements capability probing, the
pre-execution fallback policy, differential execution, and backend-diagnostic
emission. Its contract:

```ts
export interface IrregularBackendDispatchResult {
  readonly result: Effect.Effect<IrregularComputeResult, IrregularComputeErrorType, ...>
  // non-semantic; never serialized into NestingResult/history/checkpoints.
  readonly diagnostics: IrregularBackendDiagnostics
}

export interface IrregularBackendDiagnostics {
  readonly backendRequested: IrregularBackend
  readonly backendExecuted: 'typescript' | 'rust'   // 'differential' resolves to whichever
                                                       // produced the returned result (§4)
  readonly fallbackApplied: boolean
  readonly fallbackReason?: 'addon-unavailable' | 'addon-version-mismatch'
  readonly nativeCapability?: NativeCapabilityProbe   // see §3
}

export function dispatchIrregularBackend(
  input: PreparedIrregularComputeInput,        // the already-validated, already-prepared
                                                 // input computeIrregularNesting takes today
  options: ComputeIrregularNestingOptions | undefined,
  backend: IrregularBackend,
  fallbackPolicy: IrregularBackendFallbackPolicy
): IrregularBackendDispatchResult
```

`computeIrregularWorkerResult` reads `IrregularBackend`/`IrregularBackendFallbackPolicy`
from `process.env` **once**, at the top of the function, via
`parseIrregularBackend(process.env[IRREGULAR_BACKEND_ENV_VAR])` — the same
worker thread never re-reads the environment mid-job (a worker thread runs
exactly one job today, per `worker-coordination.md`'s finding that
`nesting.worker.ts`'s RPC handler forks one `handleRunNesting` per thread
lifetime; §11 open question 1 covers what happens if this assumption is ever
loosened). The resolved `IrregularBackendDiagnostics` is emitted only via the
non-semantic channel (§6) — never added to `WorkerResponse`/`NestingResult`/
`NestingHistoryFrame` (those schemas are contractual per
`worker-coordination.md` §3 and `errors-protocol.md` §8; adding a field to
them is an observable protocol change requiring an explicit ruling, not
something this design authorizes).

`gate:*` and baseline scripts (`scripts/irregular-compact-baseline.ts` and
its callers, per `tests-gates-inventory.md` §1a/§2) call
`computeIrregularNesting` directly, **not** through the worker thread. They
must gain an additive `--irregular-backend <typescript|rust|differential>`
CLI flag (default `typescript`, preserving every existing pinned value
byte-for-byte with zero behavior change to the current invocations) that
calls `dispatchIrregularBackend` instead of `computeIrregularNesting`
directly, mirroring the existing kebab-case flag convention
(`--expected-canonical-sha256`, `--maximum-elapsed-ms`, etc., confirmed at
`gate:mixed61-compact`'s `package.json` script body). This is how gate
scripts gain Rust forcing without touching a single existing assertion —
per prompt §3, add new scripts/flags, never edit pinned expectations.

## 3. Capability probe

A lazily-initialized, memoized probe, invoked **only when `backend` resolves
to `'rust'` or `'differential'`** (never on the default `'typescript'` path,
so the native addon is never even attempted to load for a pure-TypeScript
production job — no load-time cost, no crash surface added to the unmodified
default path):

```ts
export interface NativeCapabilityProbe {
  readonly available: true
  readonly nativeApiVersion: number      // versioned N-API contract, prompt §7/§20.4
  readonly backendVersion: string        // Rust crate semver
  readonly targetTriple: string
  readonly threadCountDefault: number
} | {
  readonly available: false
  readonly reason: 'not-installed' | 'load-error' | 'version-mismatch'
  readonly detail: string                // sanitized — no raw panic/backtrace, prompt §16
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

## 4. Pre-execution fallback policy

Two named policies, both **explicit and observable**, resolved from
`IRREGULAR_BACKEND_FALLBACK_POLICY_ENV_VAR` (§2.2):

- **`strict`** (default). `backend === 'rust'` and the capability probe
  returns `available: false` ⇒ the job **fails**, mapped to the external
  `worker_protocol_error` code (see §6.2 for the exact mapping — this reuses
  the currently-declared-but-zero-producer code documented in
  `errors-protocol.md` §1, whose only current constructor sites are none, and
  whose intended purpose per the prompt's §16 table is exactly "malformed
  native response or N-API protocol-version mismatch detected by the worker
  boundary" — an unloadable addon is the concrete first real producer of this
  code). This is the mandatory policy for every gate/CI job that requests
  Rust (§7, §8) — a strict run must never silently substitute TypeScript.
- **`fallback-before-execution`**. `backend === 'rust'` and the capability
  probe returns `available: false` ⇒ `dispatchIrregularBackend` transparently
  executes the TypeScript path instead, **but only because no native call has
  been made yet** (the probe runs before any N-API boundary crossing) — this
  is precisely the prompt's "an unavailable addon may fall back before
  execution if policy permits." The fallback **must** be logged (§6.1) with
  `fallbackApplied: true`, `fallbackReason: 'addon-unavailable' |
  'addon-version-mismatch'`. This is the only fallback path anywhere in this
  design; there is no analogous mid-job fallback.

`backend === 'differential'` never triggers the fallback policy on a probe
failure in the same way: if the native addon is unavailable, differential
mode cannot compare anything, and it **fails** unconditionally regardless of
fallback policy (a differential run's entire purpose is exercising Rust; a
silent skip would defeat it). This is a deliberate asymmetry from `'rust'`
and is called out explicitly so it is not mistaken for an inconsistency.

### 4.1 No-retry rules (hard requirement, not configurable)

Once `dispatchIrregularBackend` has made the first N-API call for a job
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
- There is no code path anywhere in `dispatchIrregularBackend` (or any
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
(`nesting.worker.ts`, real worker thread — allowed, but documented as never
the compiled-in default and never selected by `createSupervisor()`'s own
fallback logic) and the direct-call path (gate/test scripts). Semantics,
identical in both:

1. Run **TypeScript first**, to completion, with the deterministic clock seam
   (per `checkpoint-encoding.md`'s injected-clock requirement, referenced
   here for completeness — full design owned by that document) when the
   caller supplies one, otherwise the real clock.
2. Run **Rust second**, sequentially — never concurrently with the
   TypeScript run — against the identical trusted input, using the same
   clock-seam configuration.
3. Compare the two `IrregularComputeResult` values (and, at the worker
   boundary, the two derived `NestingResult`/`NestingHistoryFrame` shapes)
   using a **parity projection function** that excludes, by construction, only
   the fields the migration prompt and sibling design docs designate
   non-semantic (elapsed/timestamp fields not covered by an injected clock,
   backend diagnostics, cache telemetry — never excluded ad hoc because a
   field happens to differ).
4. On exact match: **the TypeScript result is what the job returns** —
   TypeScript remains the externally-observable authority in differential
   mode, consistent with "differential mode is not a production default."
   Differential mode is a comparison instrument, not an alternate production
   path.
5. On mismatch: the job **fails**. The failure is not one of the 8
   `IrregularComputeErrorType` tags (neither backend actually failed); it is
   a new internal-only tag,
   `IrregularBackendDifferentialMismatchError { operation, mismatchedFields:
   readonly string[] }`, mapped to the external `worker_protocol_error` code
   with `context: { operation: 'differential-compare', mismatchedFieldCount }`
   (the mismatched field *names* may be large/sensitive geometry data and
   should not be embedded verbatim in an external error context — only a
   count and a pointer to the diagnostic-channel detail, per prompt §16's
   "do not expose raw panic payloads... by default"). **This specific mapping
   choice is flagged as an open question (§11.3)** — it is a reasonable,
   internally-consistent extension of the existing table, not something the
   prompt states explicitly, and the orchestrator should confirm it before
   Stage 2 implementation relies on it.

Because differential mode always runs both backends sequentially in one
process/thread, it inherits full N-API/Rayon-pool lifecycle risk twice per
job (§4 of `build-packaging.md` covers pool shutdown) — this is acceptable
for tests/CI/diagnostics, explicitly not for production traffic, and is why
`createSupervisor()`'s own env resolution never produces `'differential'` as
a default; only an explicit operator/CI override can select it.

## 6. Observability: the non-semantic diagnostic channel

Per prompt §17, backend identity/version/thread count/cache policy/cache
telemetry belong **only** to a channel that is excluded from parity
projections **by construction** — never added to and then subtracted from the
result schema.

### 6.1 Concrete mechanism

`IrregularBackendDiagnostics` (§2.3) is never placed on any Effect Schema
type that crosses the RPC boundary. It is surfaced two ways, both outside the
`WorkerRequest`/`WorkerResponse` schema union:

1. **Structured stderr log line**, one per job, emitted by
   `computeIrregularWorkerResult` after dispatch resolves (success or
   failure) via `console.error(JSON.stringify({ channel:
   'irregular-backend-diagnostics', jobId, ...diagnostics }))`. `WorkerSupervisor`
   already pipes the worker thread's `stderr` to `process.stderr`
   (`WorkerSupervisor.ts:216-219`, confirmed read) with a `[worker:stderr]`
   prefix, so this line is already visible to whatever supervises the main
   process (Electron console, packaged-app log file, or a CI job's captured
   output) without any new plumbing. A fixed `channel` discriminant makes the
   line greppable by test harnesses and CI (§7).
2. **In-process return value** for the direct-call dispatch path used by
   gate/test scripts (§2.3) — `dispatchIrregularBackend`'s
   `IrregularBackendDispatchResult.diagnostics` is available synchronously to
   any caller that invokes the dispatcher directly, with no log-scraping
   needed. This is the primary mechanism new differential/parity tests
   should use (§7); the stderr line exists for the real worker-thread path,
   where no other return channel exists.

Both forms carry exactly the same field set (`IrregularBackendDiagnostics`,
§2.3) so a test can assert on either depending on which entry point it drives.

### 6.2 Error mapping additions to the existing table

`errors-protocol.md` §1.2/§3 documents the current 8-row external mapping
table (source-verified against `nesting.worker.ts:403-453`) and confirms
`worker_protocol_error` has zero current producers, reserved for exactly this
migration. This design adds exactly two new internal-only tag → external-code
rows, additive to (never replacing) the existing table:

| New internal condition | External `AppErrorCode` | Context fields |
| --- | --- | --- |
| `backend === 'rust'`, capability probe `available: false`, fallback policy `strict` | `worker_protocol_error` | `nativeApiVersion: 'unavailable'`, `requestedBackend: 'rust'`, `reason` (probe's `reason`) |
| Differential-mode exact-comparison mismatch (§5) | `worker_protocol_error` | `operation: 'differential-compare'`, `mismatchedFieldCount` |

No existing row in the 8-row table changes. `not_implemented`,
`irregular_source_geometry_missing`, etc. retain their exact current meaning
and construction sites; this design does not touch any of them.

## 7. Gates must fail on silent fallback

Every gate/CI invocation that intends to run Rust (`--irregular-backend rust`
on a gate script, or `MIN_PLANE_IRREGULAR_BACKEND=rust` +
`MIN_PLANE_IRREGULAR_BACKEND_FALLBACK_POLICY=strict` for a worker-thread-based
test) runs with `fallbackPolicy: 'strict'`, never
`'fallback-before-execution'`. Under `'strict'`, a missing/unloadable addon
already fails the job outright (§4) — there is no code path under which a
strict, Rust-requested run can complete "successfully" while having actually
executed TypeScript, because strict mode never reaches TypeScript execution
on a probe failure. The only remaining thing a gate/test must additionally
assert is that **`backendExecuted === backendRequested`** on the
`IrregularBackendDiagnostics` payload for every passing run (§6) — this
closes the residual case where a future refactor accidentally reintroduces a
fallback path under `'strict'` without a corresponding job failure; the
assertion is a second, independent tripwire, not the sole mechanism.
`docs/planning/rust-irregular-backend/ci-matrix.md` specifies exactly which
CI jobs run under which policy and assert this.

## 8. Rollback runbook

Rollback to TypeScript, at any point after Rust promotion, requires **no
code deploy and no persisted-data migration**, because backend selection
never touches persisted state:

1. Set `MIN_PLANE_IRREGULAR_BACKEND=typescript` in the environment the
   Electron main process launches with (or simply unset it, since
   `'typescript'` is the compiled-in default per `DEFAULT_IRREGULAR_BACKEND`,
   §2.2 — rollback via *removing* an override is equally valid to rollback
   via *setting* one, as long as the compiled default remains `'typescript'`
   until an explicit, separate promotion decision flips it).
2. Because `createSupervisor()` is designed to resolve this per job (§2.2),
   the very next nesting job after the environment change runs on
   TypeScript — no application restart is required if the environment
   change is applied to the running main process (e.g., via a support
   toggle that calls `process.env[...] = ...` before the next
   `createSupervisor()`-adjacent read); a full process restart is required
   only if the environment is supplied at OS/launcher level (the common
   case for a packaged desktop app).
3. No `NestingRequest`, `NestingOptions`, persisted project file, saved job,
   or history artifact needs any change — every persisted shape is already
   backend-agnostic by construction (§1).
4. Verify rollback took effect by checking the diagnostic channel (§6.1) on
   the next job: `backendExecuted: 'typescript'`.
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
completely orthogonal to `IrregularBackend`. Rectangular nesting never reads
`IRREGULAR_BACKEND_ENV_VAR` and is never routed through
`dispatchIrregularBackend` — the dispatcher is imported and called only from
the irregular branch of `computeIrregularWorkerResult`, exactly where
`computeIrregularNesting` is called today. A `workerMode` value that selects
the legacy non-archive/windowed-beam path (`worker-coordination.md` §1, "not
exercised by Compact or Compact Short Side production traffic") is out of
this migration's scope per the prompt's profile list; `dispatchIrregularBackend`
is never invoked from that branch, and `backend === 'rust'`/`'differential'`
requested for a non-archive-eligible request is out of scope for Stage 1/2 —
see open question §11.5.

## 10. Test-forcing surface summary

| Surface | Mechanism | Bypasses worker thread? |
| --- | --- | --- |
| Real `WorkerSupervisor`/IPC path (closest to production) | `WorkerSupervisorOptions.irregularBackend`/`.irregularBackendFallbackPolicy` passed to a test-constructed `WorkerSupervisor`, or `process.env` set before `createSupervisor()` | No — exercises the real worker thread, RPC layer, and env propagation |
| `nesting.worker.ts` unit-level | `MIN_PLANE_IRREGULAR_BACKEND`/`MIN_PLANE_IRREGULAR_BACKEND_FALLBACK_POLICY` set on the test process before spawning a worker thread directly (no `WorkerSupervisor`) | No |
| Gate/baseline scripts | New `--irregular-backend`/`--irregular-backend-fallback-policy` CLI flags on `scripts/irregular-compact-baseline.ts` and callers (§2.3) | Yes — direct call into `dispatchIrregularBackend` |
| New Vitest specs (additive, per prompt §18.1/§18.3) | Import `dispatchIrregularBackend` directly, same as gate scripts | Yes |
| Native capability probe in isolation | `probeNativeIrregularAddon()` imported and called directly, no request/job involved | N/A |

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
3. **`worker_protocol_error` mapping for the two new conditions (§6.2) is a
   design choice, not a prompt-mandated fact.** The prompt's §16 table
   assigns `worker_protocol_error` to "malformed native response or N-API
   protocol-version mismatch detected by the worker boundary" — an
   unavailable addon and a differential-mismatch are both plausibly this
   category, but the prompt does not enumerate them explicitly. Confirm this
   mapping, and confirm that a differential-mismatch belongs in the external
   protocol at all (an alternative: differential mode is *only* ever driven
   through the direct-call dispatch path in tests/CI, never through the real
   worker-thread/RPC path in a shape that could reach an end user, in which
   case no external `AppErrorCode` is needed for it at all, and this becomes
   an internal-only `Error` a test harness catches directly).
4. **Compiled default flip timing.** §2.2/§8 assume `DEFAULT_IRREGULAR_BACKEND
   = 'typescript'` throughout Stage 1-4 and only flips to `'rust'` at an
   explicit, separate promotion decision gated by
   `performance-contract.md`'s thresholds. Confirm this is the intended
   sequencing (i.e., this document's design must not be read as authorizing
   the default flip itself).
5. **Legacy non-archive `workerMode` interaction with `backend === 'rust'`.**
   §9 scopes `dispatchIrregularBackend` to the archive-eligible (Compact /
   Compact Short Side) branch only, per the prompt's two-profile scope. If a
   test or operator requests `backend: 'rust'` for a request that resolves
   to the legacy non-archive path (reachable only via pre-existing
   `irregularSettings`, per `worker-coordination.md` §1 / `errors-protocol.md`
   §1.1), confirm the intended behavior: (a) `'rust'` is silently ignored and
   TypeScript always runs for that branch (since Rust never implements it,
   per the prompt's scope), or (b) requesting `'rust'` for a non-archive
   request should itself be a hard, observable error under `strict` policy
   (consistent with §7's "no silent fallback" spirit, applied to "no silent
   backend that never had a chance to run Rust at all").
