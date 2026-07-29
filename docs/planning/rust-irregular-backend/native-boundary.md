# Native N-API Boundary: Design for `crates/irregular-nesting-native`

Stage 0 design document for the Rust irregular-nesting port (Compact /
Compact Short Side). This document specifies the versioned N-API contract
per the migration prompt (`docs/prompts/fable5-rust-irregular-nesting-implementation.md`,
sections 7, 15, 16 — read in full; sections 2, 8, 9, 13, 14 read for the
absolute-semantic-preservation ground rules this contract must not violate).

This is a **design for Stage 1+**. No production Rust exists yet in this
checkout. Every claim about current TypeScript behavior below is cited to
source or to a characterization document in
`docs/planning/rust-irregular-backend/characterization/`; every claim about
the Rust side is a proposal, not a status report.

Orchestrator decisions this document incorporates as given:

- napi `3.12.0` / `napi-derive` `3.6.1` / `napi-build` `2.4.0` are verified
  working on the build machine, including `ThreadsafeFunction` calls
  originating from background (non-JS) threads. JS-visible names are
  camelCased by the napi-rs macros from idiomatic Rust `snake_case`; this
  document writes Rust identifiers in `snake_case` throughout and does not
  hand-annotate `js_name` unless the camelCase auto-conversion would not
  produce the name TypeScript needs to consume.
- The Clipper2 strategy is a from-scratch Rust vendor-translation of the
  used subset of `clipper2-ts@2.0.1-18` (`Core`/`Engine`/`Clipper`/`Offset`;
  boolean ops `Union`/`Difference`/`Intersection`/`Xor` with `EvenOdd`/
  `NonZero`, `PolyTree64` output, `Miter`/`Polygon` offset), pinned by
  differential vectors — not a binding to a different-version C++ Clipper2.
  This document treats the Clipper2 backend as fully internal to Rust; no
  Clipper2 type crosses the N-API boundary in either direction.
- The crate lives in the pnpm workspace at `crates/irregular-nesting-native`.
- Durable evidence lives in the repository, never only in `/tmp`.

Files read in full or in the relevant part for this document beyond the
characterization corpus: `src/shared/protocol/worker.ts` (188 lines, full),
`src/workers/nesting.worker.ts` (492 lines, full),
`src/workers/algorithm/irregular/computeIrregularNesting.ts` (relevant
parts: `ComputeIrregularNestingOptions`, `IrregularComputeResult`,
`IrregularComputeErrorType`, lines 1-460), `src/shared/protocol/errors.ts`
(full), `src/shared/domain/nesting.ts` (relevant part: `SheetSpec`,
`NestingOptions`, `PreparedPiece`, `NestingRequest` field declarations),
`src/shared/domain/geometry.ts` (`Rect`/`RectWith`), `src/shared/domain/dxf.ts`
(`ImportedPiece`, `DxfGeometrySummary`, segment/ellipse-source shapes),
`src/shared/irregular/domain.ts` (relevant classes: `CollisionGeometryDiagnostic`,
`CollisionGeometry`, `TransformedCollisionGeometry`, `IrregularPreparedPiece`,
`IrregularPlacement`, `IrregularPlacedPiece`, `IrregularLayoutScoreSummary`,
`IrregularPortfolioProgress`, `IrregularPortfolioResult`, `IrregularHistoryFrame`).

---

## 1. Purpose and non-goals

This document specifies:

1. A capability/version query.
2. One profile-discriminated irregular execution entry point (with
   justification for one rather than two).
3. The complete trusted request DTO.
4. The complete result DTO, including optional trace fields and their
   presence semantics.
5. A structured failure DTO and the `AppErrorCode` mapping table,
   cross-checked against `errors-protocol.md` and current source, with
   discrepancies reported.
6. Streamed event delivery for state snapshots, portfolio progress, and
   decision-trace events, with exact logical event parity and no JS calls
   from Rayon workers.
7. Cancellation design: an `isCancelled`-polling equivalent, idempotent
   cleanup, and abandoned-promise safety.
8. Panic containment mapped to `unknown_error` with sanitized context.
9. Rust-side revalidation of safety-critical invariants.
10. The non-semantic diagnostics sidecar channel.
11. Load-time version compatibility checks.

This document does **not** specify: the internal Rust module layout for
NFP/IFP/canonical-grid/capacity/archive/Short-Side algorithm code (owned by
the architecture document and the per-subsystem characterization docs), the
exact cache concurrency design (owned by the cache/concurrency design
document per migration prompt §22.4), or the full TS-to-Rust field-by-field
schema transcription for every nested domain type (owned by the semantic
mapping table, migration prompt §22.2). Where this document needs a nested
shape it has not independently derived from source, it says so explicitly
and defers to that mapping table.

---

## 2. Crate and module layout (boundary-relevant slice only)

```
crates/irregular-nesting-native/
  Cargo.toml
  build.rs                      # napi-build
  src/
    lib.rs                      # napi entry points re-exported here
    napi_api/
      mod.rs
      capability.rs             # get_capability()
      request.rs                # NativeIrregularRequest and nested DTOs, decode + revalidation
      result.rs                 # NativeIrregularOutcome and nested DTOs, encode
      error.rs                  # IrregularNativeError enum, AppErrorCode mapping, panic containment
      events.rs                 # NativeIrregularCallbacks, ThreadsafeFunction wiring
      job.rs                    # NativeIrregularJob class: create/run/cancel/dispose
      diagnostics.rs            # non-semantic diagnostics sidecar DTO and channel
    algorithm/                  # not this document's subject; see architecture doc
    ...
```

`napi_api` is the only module tree this document constrains. Everything
under `algorithm/` is free to evolve per the architecture document as long
as it satisfies the contracts fixed here.

---

## 3. Versioning and capability query

### 3.1 Version identifiers

Three independent version/identity strings, never conflated:

| Identifier | Meaning | Example |
|---|---|---|
| `native_api_version` | The N-API **contract** version defined by this document (request/result/event/error shapes). Bumped only when a boundary-visible shape changes incompatibly. | `1` |
| `backend_version` | The Rust algorithm crate's own semantic version (`Cargo.toml` `version`). Bumped on any algorithm-affecting change, informational only. | `"0.1.0"` |
| `geometry_backend_id` / `geometry_backend_version` | Identity of the vendored Clipper2 translation, mirroring the existing TS concept (`IrregularGeometrySettings.geometryBackendId`/`geometryBackendVersion`, `src/shared/irregular/domain.ts:280-299`, already part of the trusted request DTO — see §7.4). This pair is *not* about the request's geometry settings; it is the Rust addon's own compiled-in Clipper2-translation identity, reported for diagnostics. | `"clipper2-rs-vendor"` / `"2.0.1-18"` |

`native_api_version` is a plain unsigned integer, not a semver string,
because it gates a **discrete, enumerable contract** (this document's own
shape), not a continuous compatibility range. TypeScript pins one expected
integer at build time and refuses to route to Rust on any mismatch (§3.3).

### 3.2 `get_capability()`

```rust
#[napi(object)]
pub struct NativeCapability {
    pub native_api_version: u32,
    pub backend_version: String,
    pub geometry_backend_id: String,
    pub geometry_backend_version: String,
    /// Target triple the addon was compiled for (e.g. "x86_64-unknown-linux-gnu").
    pub target_triple: String,
    /// Cargo package version of the `napi` crate actually linked, for diagnostics.
    pub napi_runtime_version: String,
    /// Identity of the cache architecture in effect (see the cache/concurrency
    /// design document). Non-semantic; changes freely across Rust releases.
    pub cache_policy_id: String,
    /// Rayon default thread count the addon would use if not overridden
    /// (see §16.2). Non-semantic.
    pub default_thread_count: u32,
    /// Supported irregular profiles, as the literal `intrinsicObjectiveProfileId`
    /// strings this backend can execute. Always `["compact", "short-side"]`
    /// for this crate; present so TypeScript never has to hardcode the list
    /// twice.
    pub supported_profiles: Vec<String>,
}

#[napi]
pub fn get_capability() -> NativeCapability { /* ... */ }
```

`get_capability()` is synchronous, side-effect-free, and cheap (no job
state, no allocation beyond the returned struct). It is the **only**
function TypeScript may call before deciding whether the addon is usable at
all (§3.3, §17 in spirit — matches migration prompt §17's "a missing or
unloadable native binary produces a clear capability result").

Every field on `NativeCapability` is explicitly **non-semantic diagnostic
data** per migration prompt §7 and §13.7: none of it may enter canonical
output, hashes, checkpoints, progress events, or persisted settings. See §14.

### 3.3 Load-time compatibility check

The TypeScript integration layer (the future analogue of
`nesting.worker.ts`'s backend wiring) must:

1. Attempt to load the addon (platform-specific `.node` resolution, per the
   packaging document). A load failure (missing binary, ABI mismatch,
   `dlopen` error) is caught and treated as "native backend unavailable" —
   the backend selector must not route to Rust (migration prompt §17).
2. On successful load, call `get_capability()` and compare
   `native_api_version` against a compile-time constant embedded in the TS
   wrapper (e.g. `EXPECTED_NATIVE_API_VERSION = 1`).
3. On mismatch, treat the addon as unavailable for the **same** reason as a
   load failure — do not attempt to call `run` on a version-mismatched
   addon. If a test or gate explicitly forced the Rust backend, this must
   be a hard, loud failure (migration prompt §17: "A test must fail if it
   requested Rust but silently ran TypeScript"), not a silent fallback.
4. If a caller nonetheless reaches the execution entry point with a
   contract the addon does not recognize (should not happen given step 2,
   but N-API arguments are not statically guaranteed to match Rust's
   expectations — see §13), the addon itself must reject with
   `worker_protocol_error` (§9) rather than panicking or guessing.

This step-2/step-3 check is the concrete, live producer this design gives
to `worker_protocol_error` — declared in `AppErrorCode`
(`src/shared/protocol/errors.ts:19`) but, per `errors-protocol.md` §1 and
§15 open question 1, currently **dead** in TypeScript (grep-confirmed zero
non-declaration occurrences repo-wide). Assigning it a real producer here
is new capability introduced by the native boundary itself, not a change to
any existing accepted TypeScript behavior — consistent with the migration
prompt's own framing of this code as "anticipating the future native/N-API
boundary" (`errors-protocol.md` §1).

---

## 4. Entry point shape: one profile-discriminated call

**Decision: one execution entry point, not two.**

```rust
#[napi]
pub fn create_irregular_job(request: NativeIrregularRequest) -> napi::Result<NativeIrregularJob>
```

`NativeIrregularJob` (a `#[napi]` class, §6) exposes `.run(callbacks)`,
`.cancel(reason)`, and `.dispose()`. There is no separate "Compact job" vs.
"Compact Short Side job" constructor or method.

**Justification, from source:**

- TypeScript itself already uses exactly one function,
  `computeIrregularNesting` (`computeIrregularNesting.ts:364`), for both
  profiles. `effect-boundary.md` §1 states this explicitly: "Compact and
  Compact Short Side are **identical** through this entire cluster: nothing
  here branches on `intrinsicObjectiveProfileId` ... Both profiles call the
  exact same `computeIrregularNesting` entry point ... with the exact same
  layer graph ... the only thing that differs between the two profiles is
  the *value* of `IrregularNestingSettings` carried inside the request."
  The profile discriminator, `IrregularOptimizerSettings.intrinsicObjectiveProfileId:
  'compact' | 'short-side'` (`src/shared/irregular/domain.ts`, part of
  `IrregularNestingSettings.optimizer`), is already **data**, not an
  entry-point choice, everywhere upstream of the coordinator.
- `coordinateIntrinsicSharedArchive` (`computeIrregularNesting.ts:474-1240`)
  runs the full shared, profile-independent pipeline (preflight, scheduler
  cold-start, archive run, capacity fallback, focused reconstruction) for
  **both** profiles, and only branches into the Short-Side-specific
  observer/pair-fold block (`:1071-1203`) when
  `shortSideProfileRequested(request)` is true (`worker-coordination.md`
  §1). Splitting the N-API surface into two functions would require either
  (a) duplicating the entire shared preamble across two Rust entry points
  (real drift risk — two copies of the "compute prepared pieces, run
  preflight, run the archive, run capacity fallback, run focused
  reconstruction" sequence, which must stay byte-identical between the two
  "flavors" since Compact and Compact Short Side share that whole prefix),
  or (b) having both thin entry points immediately delegate into one shared
  internal function anyway — which is strictly more indirection than one
  public entry point with the profile carried in the (already-present)
  settings, for zero additional safety.
- The migration prompt itself offers this option explicitly: "one Compact
  execution entry point [...] one Compact Short Side execution entry point,
  or one profile-discriminated irregular entry point" (§7). Given the
  source evidence above, the profile-discriminated single entry point is
  the one that actually mirrors current TypeScript architecture — the
  two-entry-point alternative would be a **new** architectural split that
  does not exist today and would need to be independently kept consistent.
- A single entry point does not weaken the "coarse boundary, one call per
  job" requirement (migration prompt §6 Stage 1): each `create_irregular_job`
  call still ends up doing all algorithm work — Compact's shared prefix and,
  when requested, Short Side's construction — inside one Rust-owned job, in
  the same relative order TypeScript's single coordinator uses.

The profile is read from `request.options.irregular_settings.optimizer.intrinsic_objective_profile_id`
(§7.4) exactly as TypeScript reads it; Rust must **not** accept a redundant,
independently-settable "profile" parameter at the N-API surface, since that
would create a second source of truth that could disagree with the settings
object (a new hazard TypeScript does not have today).

---

## 5. Result and lifecycle types at a glance

```rust
#[napi]
pub struct NativeIrregularJob { /* opaque; methods in §6 */ }

#[napi(object)]
pub struct NativeIrregularOutcome {
    pub result: NativeIrregularComputeResult,   // §8
    // Non-semantic; always present, never inspected by parity gates. See §14.
    pub diagnostics: NativeJobDiagnostics,
}
```

`create_irregular_job` returns `napi::Result<NativeIrregularJob>` — a
synchronous `Result`, not a `Promise`, because job creation performs only
cheap, synchronous top-level revalidation (§13.1) and allocates no
long-lived thread; an `Err` here corresponds to a native-boundary rejection
that never reaches the TypeScript-visible async job at all (mapped through
the same `IrregularNativeError` → `AppErrorCode` table as any other failure,
§9). `.run(...)` (§6) is what returns the `Promise`.

---

## 6. Job lifecycle: create / run / cancel / dispose

### 6.1 Why a three-call shape, not a single async function

The migration prompt suggests "a single async native execution call with
Rust-owned job state" is *preferable when it satisfies cancellation and
progress requirements* (§6 Stage 1), and separately allows "an optional
explicit cancellation handle if an async-thread-safe mechanism is required"
(§7). This design needs the handle, for a reason specific to porting from
Effect fibers to native OS threads that the characterization corpus makes
concrete:

`worker-coordination.md` §10 and `errors-protocol.md` §10 both establish
that **today's actual production cancellation mechanism is not cooperative
at all** — `WorkerSupervisor.cancelJob` / the main-process timeout both call
`teardownWorker`, which disposes the `ManagedRuntime` wrapping the RPC
client, **terminating the entire Node `worker_thread` outright**
(`WorkerSupervisor.ts:178-198`). This works today because the whole
algorithm runs as Effect fibers inside one JS/V8 execution context
(`nesting.worker.mjs`'s worker thread), and Node's `worker.terminate()`
tears down that entire V8 isolate, unconditionally stopping every fiber. In
the Rust port, the algorithm instead runs on native OS threads (a
job-owned coordinator thread plus, later, a Rayon pool). **`worker.terminate()`
on the surrounding Node worker thread does not reliably stop a raw OS
thread the native addon spawned** — Node's `worker_threads` are separate
V8 isolates inside the *same* OS process, not separate OS processes, and
terminating the isolate does not automatically terminate arbitrary native
threads unless the addon has explicitly wired cleanup into that isolate's
teardown. Losing the ability to hard-kill algorithm execution is a direct
consequence of moving execution off the JS thread; this design compensates
for it with an explicit, cooperative mechanism (§6.3) so that the
**externally observable** contract — no partial result, ever, on
cancellation or timeout — is preserved even though the internal mechanism
changes from "OS-level kill" to "cooperative flag + abort".

A single fire-and-forget async call has no place to attach this mechanism
after the call has started without also inventing a second entry point;
an explicit job handle, created synchronously and then run, is the
minimal shape that supports it while still being "one native job" in
spirit.

### 6.2 `NativeIrregularJob` surface

```rust
#[napi]
impl NativeIrregularJob {
    #[napi(getter)]
    pub fn job_id(&self) -> String { /* echoes request.job_id */ }

    /// Starts execution. May be called exactly once per job. A second call
    /// rejects synchronously with `IrregularNativeError::JobAlreadyStarted`
    /// (mapped to `unknown_error`, §9 — a programmer-error case with no
    /// TypeScript precedent, since `computeIrregularNesting` has no
    /// equivalent "run twice" possibility).
    #[napi]
    pub fn run(&self, callbacks: NativeIrregularCallbacks) -> napi::Result<JsObject /* Promise<NativeIrregularOutcome> */> { /* ... */ }

    /// Idempotent. Safe to call before `run`, during `run`, after `run`'s
    /// promise has settled, or multiple times. Requests cooperative
    /// termination; see §6.3 for exactly what this changes and does not
    /// change relative to TypeScript's hard-kill semantics.
    #[napi]
    pub fn cancel(&self, reason: Option<String> /* "cancelled" | "deadline", default "cancelled" */) { /* ... */ }

    /// Idempotent. Releases the job-owned cache, the job-owned Rayon pool
    /// (if any), and all `ThreadsafeFunction` handles. Safe to call multiple
    /// times and safe to call whether or not `run` was ever invoked or has
    /// settled. TypeScript MUST call this on every exit path (success,
    /// failure, cancellation, timeout) — see §6.4.
    #[napi]
    pub fn dispose(&self) { /* ... */ }
}
```

### 6.3 Cancellation semantics preserved, mechanism changed

What must **not** change, because it is the migration prompt's absolute
preservation rule and matches every accepted test today:

- A cancelled or timed-out job never resolves its promise with a partial
  result. It always rejects, mapped to `worker_cancelled` or
  `worker_timeout` (§9), exactly as `toIrregularWorkerFailure` maps
  `IrregularNfpIfpControlAbortError` today (`nesting.worker.ts:446-451`).
- The distinction between "cancelled" and "deadline" (two different
  external codes, `worker_cancelled` vs. `worker_timeout`) is preserved.

What is a **new, explicitly authorized** mechanism, not a port of existing
behavior (flagged here and in §17 as needing orchestrator confirmation
before Stage 2 relies on it):

- The Rust job coordinator polls a cooperative `Arc<AtomicU8>` flag
  (`0` = running, `1` = cancel requested, `2` = deadline requested) at the
  coordinator-stage boundaries `worker-coordination.md` §13 already
  identifies as the *existing* logically-serial checkpoints in
  `coordinateIntrinsicSharedArchive` (preflight → scheduler cold-start →
  archive run → capacity fallback → focused reconstruction → Short-Side
  observer/pair-fold), plus the one checkpoint that is genuinely live in
  production today (`intrinsicStrictDecoder.ts:472-487`'s per-decode
  wall-clock budget, the live source of `reason: 'deadline'` per
  `errors-protocol.md` §11.2). On observing a non-zero flag, the
  coordinator **discards all partial state** and fails the job with the
  corresponding `IrregularNativeError::ControlAbort { reason }` — it never
  returns partial geometry, matching migration prompt §15's "no partial
  result" rule and `errors-protocol.md`'s finding that production
  cancellation today is a full-kill, never a partial return.
- This is a deliberate widening of *polling density* relative to
  TypeScript, where `isCancelled`/`control` is `undefined` in production
  and therefore polled nowhere (`errors-protocol.md` §10, §11.2:
  "`control` is always `undefined` in production ... the entire internal
  `IrregularNfpIfpControlAbortError`/checkpoint-phase mechanism ... is
  inert dead code from the worker's perspective"). The migration prompt
  §15 warns that "moving a check earlier ... can change which work, cache
  operation, ledger entry, checkpoint, or trace occurs before termination"
  — but since production never observes *any* chronology past a
  cancellation point today (the whole thread dies), there is no accepted
  trace or ledger state this change could diverge from. The only invariant
  to preserve is "no partial result ever reaches the promise," which
  discard-on-abort trivially satisfies regardless of which checkpoint
  fired.
- `Rayon` worker closures never read or write this flag directly (migration
  prompt §14.2's "cancellation or deadline checks at new eager positions"
  risk is specifically about checks introduced *inside* a parallel batch
  that would make batch-internal completion order observable); the flag is
  read only by the single logically-serial coordinator thread between
  batches, matching the deterministic parallel pattern in migration prompt
  §14.3.

### 6.4 Idempotent cleanup and abandoned-promise safety

- `dispose()` releases the job-local `GeometryCache`-equivalent store, the
  job-owned Rayon pool (§16.2), and all `ThreadsafeFunction` references,
  and is safe to call any number of times from any state. Internally this
  is implemented with an `Arc<JobState>` plus a `once`-style disposed flag
  (not `Drop`-only — see next bullet).
- The native addon does **not** infer job abandonment from `NativeIrregularJob`
  garbage collection. N-API finalizer callbacks are not guaranteed to run
  promptly, or at all, before process exit, and relying on them would
  silently violate migration prompt §7's "Ensure an abandoned or cancelled
  JavaScript promise cannot leak a native job or cache" the moment a caller
  drops a job reference without awaiting it. Instead, cleanup is an
  **explicit ownership contract**: the TypeScript integration layer must
  call `.dispose()` on every exit path of the code that today calls
  `WorkerSupervisor.teardownWorker` (`WorkerSupervisor.ts:193-198`) —
  normal completion, cancellation, and timeout alike — mirroring the
  existing pattern where `ManagedRuntime.dispose()` is already an explicit,
  unconditional call on every one of those paths today, not something that
  depends on GC. This is a contract to enforce with a lint/test (§18 open
  question), not a runtime guarantee the addon can provide unilaterally.
- As defense in depth (not a substitute for the explicit contract above),
  the job registers a napi environment cleanup hook
  (`Env::add_env_cleanup_hook` or the napi-rs `3.x` equivalent) that also
  triggers disposal if the surrounding Node environment tears down without
  an explicit `.dispose()` call. **This specific property — whether an
  environment cleanup hook reliably fires under an abrupt `worker.terminate()`
  of the Node worker thread hosting the addon — is a different, unverified
  capability from the already-confirmed "ThreadsafeFunction from background
  threads works" finding, and must be independently verified in Stage 1**
  before any code path relies on it for correctness rather than defense in
  depth. Flagged as an open question in §18.
- If `.run()`'s promise is genuinely abandoned (never awaited, but the
  `NativeIrregularJob` object itself is still reachable and `.dispose()`
  is never called), the native job **continues running to completion** on
  its own thread — matching today's behavior, where nothing in production
  ever abandons a job without going through an explicit
  `WorkerSupervisor.cancelJob`/timeout/completion path.

---

## 7. Request DTO

The request DTO is the **trusted, post-validation** shape — Seam A
(`effect-boundary.md` §2.3) has already run in TypeScript by the time
`create_irregular_job` is called; this DTO carries exactly what
`NestingRequest` guarantees after `Schema.decodeUnknownSync` succeeds
(`effect-boundary.md` §2.3, §3.2-3.5; `src/shared/domain/nesting.ts:143-152`).
Rust must **not** re-decode this as if it were untrusted JSON (migration
prompt §7: "Avoid `serde_json::Value` as the internal algorithm model");
napi-rs's `#[napi(object)]` `FromNapiValue` derive performs the JS→Rust
struct conversion, and §13 defines the additional, Rust-owned safety-net
revalidation this crosses a *new* trust boundary (JS↔native, which does not
exist in the current architecture) requires beyond that.

### 7.1 Top level

```rust
#[napi(object)]
pub struct NativeIrregularRequest {
    /// Must be 1. `NestingRequest.version` is `Schema.Literal(1)`
    /// (`nesting.ts:144`) — always `1` for any request that reached Seam A.
    pub version: u32,
    pub job_id: String,
    pub sheet: NativeSheetSpec,
    /// `NestingRequest.padding`: `NonNegativeIntegerMillimeters`.
    pub padding_mm: i64,
    pub pieces: Vec<NativePreparedPiece>,
    /// TS optionality: `sourcePieces?: ImportedPiece[]`. Omission is not a
    /// decode error in TS; `computeIrregularNesting.ts:381` resolves it to
    /// `[]`. The N-API boundary requires TypeScript to pass an **empty
    /// vector**, not `None`/`null`, for this field — Rust performs the same
    /// `?? []` resolution TypeScript performs, at the same call site
    /// (`effect-boundary.md` §2.3), so there is no behavioral difference,
    /// only a representation choice: napi-rs `Vec<T>` has no "absent" state
    /// distinct from "empty" the way TS `undefined` does, and none is
    /// needed here since the two cases already collapse to identical
    /// behavior in TS itself.
    pub source_pieces: Vec<NativeImportedPiece>,
    pub options: NativeNestingOptions,
    /// TS optionality: `strategyRunId?: string`. Genuinely presence-sensitive
    /// (governs history-file append vs. truncate mode,
    /// `nesting.worker.ts:203`, and the derived `strategyRunId` id,
    /// `irregularWorkerOutput.ts:30-39`) — modeled as `Option<String>`,
    /// not a sentinel string.
    pub strategy_run_id: Option<String>,
}
```

### 7.2 `NativeSheetSpec`

```rust
#[napi(object)]
pub struct NativeSheetSpec {
    pub width: i64,   // PositiveIntegerMillimeters
    pub height: i64,  // PositiveIntegerMillimeters
    pub label: String,
}
```

Mirrors `SheetSpec` (`nesting.ts:59-63`). `label` is carried for
completeness/echo purposes only — no characterization document found it
consumed by any comparator, key, or hash on the Compact/Compact Short Side
path; confirm against the semantic mapping table before Stage 2, do not
assume.

### 7.3 `NativePreparedPiece` and `NativeImportedPiece`

`request.pieces[i]` is a `PreparedPiece` (`nesting.ts:120-141`) — the
piece's bounds/padding/rotation-mirror policy, **not** yet built collision
geometry. `request.source_pieces` carries the raw imported/DXF geometry
(`ImportedPiece`, `dxf.ts:132-150`) that the Rust job resolves per prepared
piece via the same `findSourcePiece`/`-copy-\d+$`-suffix-stripping fallback
TypeScript uses today (`computeIrregularNesting.ts:1906-1920`,
`worker-coordination.md` §5/§12) and then runs through collision-geometry
preparation itself (flatten → convex hull → offset — in scope for Rust per
migration prompt §4.1). This is not optional: per the migration prompt's
inclusion list, "collision-geometry preparation" and "curve flattening
behavior used by the irregular pipeline" are explicitly Rust's
responsibility, so the boundary carries raw prepared-piece and
source-geometry data, not pre-built `CollisionGeometry`.

```rust
#[napi(object)]
pub struct NativePreparedPiece {
    /// `PreparedPiece.id`: has a constructor default in TS but is always
    /// present after decode of a real request. Always required here.
    pub id: String,
    pub source_piece_id: String,
    pub interchangeability_key: Option<String>,   // Schema.optional(NonEmptyString)
    pub real_bounds: NativeRect,
    pub padded_bounds: NativeRectWith,
    pub padding_mm: i64,                          // NonNegativeIntegerMillimeters
    pub allow_rotation: bool,
    pub allow_mirror: bool,                        // always concrete after decode (default true)
    pub cut_row_ref: Option<NativeCutRowRef>,
}

#[napi(object)]
pub struct NativeCutRowRef {
    pub reference: String,
    pub customer_name: String,
    pub csv_row_id: String,
}

#[napi(object)]
pub struct NativeRect { pub x: i64, pub y: i64, pub width: i64, pub height: i64 }

#[napi(object)]
pub struct NativeRectWith {
    pub x: i64, pub y: i64, pub width: i64, pub height: i64,
    pub longest_edge: i64, pub area: i64, pub imbalance: i64,
}

#[napi(object)]
pub struct NativeImportedPiece {
    pub id: String,
    pub source_file_id: String,
    pub source_layer: Option<String>,
    pub label: String,
    pub real_bounds: NativeRect,
    pub geometry: NativeDxfGeometrySummary,
    // `warnings: ImportWarning[]` is import-pipeline metadata never consumed
    // by the nesting algorithm on any characterized code path; omitted from
    // the trusted native DTO. Confirm against the semantic mapping table
    // before Stage 2 that no irregular-pipeline code reads it (not found by
    // any characterization document read for this design).
}

#[napi(object)]
pub struct NativeDxfGeometrySummary {
    pub entity_type: String,   // one of DxfGeometryEntityType's 8 literals
    pub closed: bool,
    pub segments: Vec<NativeDxfGeometrySegment>,
}

/// Mirrors the `DxfLineSegment | DxfArcSegment` union (`dxf.ts:58-101`).
/// napi-rs has no native tagged-union derive for `#[napi(object)]`; model
/// this as a struct with a `kind` discriminant and per-kind-optional fields
/// (mirroring how the JSON wire shape already looks), not two Rust enum
/// variants exposed separately — the JS caller already produces exactly
/// this shape from `Schema.Union`. Field presence must match the source
/// variant exactly: an "arc" segment must not carry `bulge`/`source_curve`
/// present-but-null.
#[napi(object)]
pub struct NativeDxfGeometrySegment {
    pub kind: String,          // "line" | "arc"
    pub x1: f64, pub y1: f64, pub x2: f64, pub y2: f64,
    pub bulge: Option<f64>,                        // line only
    pub source_curve: Option<NativeDxfEllipseSource>, // line only
    pub cx: Option<f64>, pub cy: Option<f64>,       // arc only
    pub radius: Option<f64>,                         // arc only
    pub start_angle: Option<f64>, pub end_angle: Option<f64>, // both kinds, different units (see note)
}

#[napi(object)]
pub struct NativeDxfEllipseSource {
    pub source_id: String,
    pub cx: f64, pub cy: f64,
    pub major_axis_x: f64, pub major_axis_y: f64,
    pub axis_ratio: f64,
    pub start_angle: f64, pub end_angle: f64,
}
```

Note (must be verified against source, not assumed, in the semantic mapping
table): `DxfLineSegment.startAngle`/`endAngle` do not exist on the line
variant at all (only `x1,y1,x2,y2,bulge?,sourceCurve?`); `DxfArcSegment`'s
`startAngle`/`endAngle` are **degrees**
(`dxf.ts:92-95`) while `DxfEllipseSource`'s `startAngle`/`endAngle` are DXF
parameter **radians** (`dxf.ts:40-41`, doc comment: "the angles are DXF
parameters in radians"). The flattened `NativeDxfGeometrySegment` struct
above collapses the union for napi-rs representability; this unit
mismatch between an arc segment's own angles and a line segment's carried
ellipse-source angles is real TS behavior (two different angle units
coexisting in the same tagged union) and must be preserved exactly by
whatever Rust code consumes these fields, not "fixed" into one unit.

Coordinates on `NativeDxfGeometrySegment`/`NativeDxfEllipseSource` are `f64`
(`Schema.Finite`, not integer-constrained, per `dxf.ts:8`) — distinct from
the `i64` integer-millimeter fields on `NativeRect`/`NativeSheetSpec`. Do
not unify these two numeric representations.

### 7.4 `NativeNestingOptions` and `NativeIrregularNestingSettings`

```rust
#[napi(object)]
pub struct NativeNestingOptions {
    pub allow_global_rotation: bool,
    pub allow_global_mirror: bool,           // always concrete after decode (default true)
    pub timeout_ms: f64,
    pub worker_mode: String,                 // must be "irregular-convex-v2" to reach this entry point at all
    pub history_mode: String,                // 'stream' | 'final' | 'off' — see §10.2 for what Rust needs it for
    /// `irregularSettings?: IrregularNestingSettings`. TypeScript resolves
    /// omission to `GeometrySettings.Make` (`DEFAULT_IRREGULAR_NESTING_SETTINGS`,
    /// `geometryKernel.ts:38`) *before* this boundary is ever reached in the
    /// real worker wiring (`nesting.worker.ts:375`). The N-API boundary
    /// therefore requires this field to always be present (TypeScript
    /// performs the `?? GeometrySettings.Make` resolution before
    /// constructing the native request), not optional — there is no
    /// behavior to preserve in letting Rust re-implement that default
    /// independently, and doing so would create a second copy of the
    /// default settings object that could drift from
    /// `defaults.ts:149-183`.
    pub irregular_settings: NativeIrregularNestingSettings,
    // `historyScope`, `strategySelectionMode`, `strategyIds`,
    // `layoutSelectionStrategyId`, `finalSelectionMode`, `topN`,
    // `maxHistoryEvents` are declared on `NestingOptions` but, per
    // `worker-coordination.md` §3.1/§3.2, either steer only the rectangular
    // path or (maxHistoryEvents) have zero effect on the irregular worker
    // today. Omitted from the native DTO; if the semantic mapping table
    // finds any of these consumed by a characterized irregular code path,
    // add it back rather than assume this list is exhaustive.
}

#[napi(object)]
pub struct NativeIrregularNestingSettings {
    pub geometry: NativeIrregularGeometrySettings,
    pub optimizer: NativeIrregularOptimizerSettings,
}

#[napi(object)]
pub struct NativeIrregularGeometrySettings {
    pub flattening_sag_tolerance_mm: f64,     // PositiveFiniteMillimeters
    pub clearance_safety_margin_mm: f64,      // NonNegativeFiniteMillimeters, >= flattening_sag_tolerance_mm
    pub geometry_backend_id: String,
    pub geometry_backend_version: String,
}

#[napi(object)]
pub struct NativeIrregularOptimizerSettings {
    pub order_window: u32,
    pub beam_width: u32,
    pub local_candidate_fanout: u32,
    pub local_repair_budget: u32,
    pub intrinsic_shared_archive_enabled: bool,
    /// `'compact' | 'short-side'` — the profile discriminator (§4).
    pub intrinsic_objective_profile_id: String,
    pub transform_cap: u32,
    pub transform_minimum_edge_length_mm: f64,
    pub transform_angle_deduplication_tolerance_deg: f64,
    pub configured_rotation_enabled: bool,
    pub edge_alignment_enabled: bool,
    pub configured_rotation_deg: Vec<f64>,
    pub ga_enabled: bool,
    pub baseline_only: bool,
    pub ga_population: u32,
    pub ga_generation_budget: u32,
    pub ga_evaluation_budget: u32,
    pub ga_time_budget_ms: u32,
    pub ga_seed: String,
    pub priority_order_mutation_enabled: bool,
    pub transform_preference_mutation_enabled: bool,
    pub placement_policy_mutation_enabled: bool,
    pub placement_policy_id: String,
    pub placement_policy_ids: Vec<String>,
}
```

Field list and defaults per `effect-boundary.md` §3.3/§3.4
(`IrregularOptimizerSettings`, `src/shared/irregular/domain.ts:301-466`) —
all defaults are already resolved by TypeScript's `Schema` decode before
this boundary; every field here is **required**, none optional, because
Seam A guarantees a concrete value for every one of them by the time a
`NestingRequest` decodes successfully.

---

## 8. Result DTO

`IrregularComputeResult` (`computeIrregularNesting.ts:329-352`) is the
"plain algorithm output before any worker protocol or history DTO
adaptation." The native result DTO mirrors it directly — the coarse
boundary means TypeScript's `makeIrregularWorkerOutput`/`makeIrregularHistoryFrame`
adaptation into `NestingResult`/`IrregularHistoryFrame` (schema-typed,
persisted, RPC-serialized shapes) stays in TypeScript, reading this DTO,
exactly as `nesting.worker.ts:377-401` reads `computeIrregularNesting`'s
return value today. Rust does not need to reproduce the `NestingResult`/
`IrregularHistoryFrame` `Schema.Class` shapes; it needs to reproduce the
data those adapters read.

```rust
#[napi(object)]
pub struct NativeIrregularComputeResult {
    pub placed_collision_geometries: Vec<NativeIrregularPlacedPiece>,
    pub score: NativeIrregularLayoutScore,               // full internal score, not the summary (§8.1)
    pub unplaced_piece_ids: Vec<String>,
    pub diagnostics: Vec<NativeCollisionGeometryDiagnostic>,
    pub sorted_piece_ids: Vec<String>,
    pub state_snapshots: Vec<NativeIrregularStateSnapshotRecord>, // see §10.2 — retained for parity even
                                                                    // though production streams these live too
    pub beam_width: u32,
    pub portfolio: NativeIrregularPortfolioResult,

    // Optional trace fields. Presence mirrors computeIrregularNesting.ts
    // :1221-1237's conditional-spread exactly — see the table below. napi-rs
    // `Option<T>` fields serialize as `undefined` (key omitted, matching
    // TypeScript's own `undefined`-omission convention) when `None`, never
    // as `null` — this must be verified against the actual napi-rs 3.x
    // `Option<T>` `ToNapiValue` behavior for `#[napi(object)]` fields in
    // Stage 1 before relying on it (flagged in §18).
    pub capacity_trace: Option<NativeIntrinsicCapacityTrace>,
    pub capacity_shadow_telemetry: Option<NativeIntrinsicCapacityShadowTelemetry>,
    pub intrinsic_anytime_scheduler_trace: Option<NativeIntrinsicAnytimeSchedulerTrace>,
    pub experimental_place_defer_trace: Option<NativeIntrinsicPlaceDeferTrace>,
    pub focused_complete_reconstruction_trace: Option<NativeFocusedCompleteReconstructionTrace>,
    pub intrinsic_short_side_observer_trace: Option<NativeIntrinsicShortSideObserverTrace>,
    pub intrinsic_short_side_pair_fold_trace: Option<NativeIntrinsicShortSidePairFoldTrace>,
}
```

### 8.1 Presence table for optional trace fields

Reproduced from `worker-coordination.md` §3.3, cross-checked against
`computeIrregularNesting.ts:338-352`:

| Field | Present when |
|---|---|
| `capacity_trace` | A capacity-mode result materialized this run (the `preflight.kind === 'proven_impossible'` branch, or an archive-miss branch). |
| `capacity_shadow_telemetry` | `options.captureCapacityShadowTelemetry === true` — never true in production; only reachable via test/script harnesses that set benchmark-only options `ComputeIrregularNestingOptions` never receives from `nesting.worker.ts` (`worker-coordination.md` §1). The native entry point should still support this for parity-test parameterization, not omit it. |
| `intrinsic_anytime_scheduler_trace` | The scheduler cold-start ran — effectively every archive-branch run that reaches the non-`proven_impossible` preflight outcome (`schedulerEnabled` is a hardcoded `true` local, `worker-coordination.md` §3.3). |
| `experimental_place_defer_trace` | `options.captureExperimentalPlaceDeferCompleteShadow === true` — never true in production, same status as `capacity_shadow_telemetry`. |
| `focused_complete_reconstruction_trace` | `focusedCompleteReconstructionEnabled` — true unless explicitly disabled; production never disables it, so this is present on effectively every archive-branch run. |
| `intrinsic_short_side_observer_trace` | The short-side observer block ran (only reachable when the archive branch ran **and** Short Side is requested or a benchmark observer option is set). |
| `intrinsic_short_side_pair_fold_trace` | The pair-fold observer ran inside that same block. |

`capacity_shadow_telemetry` and `experimental_place_defer_trace` are only
ever exercised by test/gate harnesses today (`worker-coordination.md` §1),
never by production `nesting.worker.ts`. Keep them in the DTO for
differential-test parity with the existing TS test suite (migration prompt
§18.1: "Run all applicable existing tests against Rust ... without altering
existing expected values"), but they carry no production behavior to
preserve beyond exact byte parity when a test explicitly enables them.

### 8.2 Score: full internal object, not the output summary

`IrregularComputeResult.score` is the **full** `IrregularLayoutScore`
(`irregularLayoutScorer.ts`), not `IrregularLayoutScoreSummary`
(`src/shared/irregular/domain.ts:901-925`). `worker-coordination.md` §3.4
documents a concrete, load-bearing divergence between the two: the internal
score carries `occupiedHullWasteRatio`
(`preserveSharedArchiveExactMetrics`, `computeIrregularNesting.ts:1786-1798`)
— actively used as a comparator criterion elsewhere
(`irregularLayoutScorer.ts:522,535`) — which is **dropped** before the
worker-output boundary and never appears in `IrregularLayoutScoreSummary`.
The native result DTO must carry the full score object with this field
intact; TypeScript's downstream summary construction (kept in TypeScript,
per §5's "coarse boundary" scoping — summary derivation for the RPC/history
DTOs stays outside Rust) is what drops it, exactly as
`layoutScoreSummaryFields`/`scoreSummary` do today
(`computeIrregularNesting.ts:1709-1727`, `irregularWorkerOutput.ts:212-236`).
**Do not summarize the score inside Rust** — that would silently move where
a currently-TypeScript-owned field-dropping decision happens, and risks
losing the field's continued internal availability for any future TS
consumer.

Full field enumeration for `NativeIrregularLayoutScore` is deferred to the
semantic mapping table (`irregularLayoutScorer.ts` is `search-scoring.md`'s
subject, not this document's).

### 8.3 `NativeIrregularPlacedPiece`, `NativeCollisionGeometryDiagnostic`

```rust
#[napi(object)]
pub struct NativeIrregularPlacedPiece {
    pub placement: NativeIrregularPlacement,
    pub collision_geometry: NativeTransformedCollisionGeometry,
}

#[napi(object)]
pub struct NativeIrregularPlacement {
    pub piece_id: Option<String>,             // always Some for new Rust-produced results
    pub source_piece_id: String,
    pub placement_reference: Option<NativeIrregularPoint>, // always Some for new Rust-produced results
    pub transform: NativeIrregularTransform,
}

#[napi(object)]
pub struct NativeTransformedCollisionGeometry {
    pub source_piece_id: String,
    pub transform: NativeIrregularTransformCandidate,
    pub polygon: NativeIrregularPolygon,
    pub bounds: NativeIrregularBounds,
}

#[napi(object)]
pub struct NativeCollisionGeometryDiagnostic {
    pub code: String,
    pub message: String,
    /// `CollisionGeometryDiagnostic.pieceId` uses `hasOwnProperty`-gated
    /// true own-property omission in TS (`domain.ts:508-524`), not merely
    /// `undefined`-valued presence. `Option<String>` with napi-rs's
    /// omit-on-`None` behavior (verify per §18) reproduces this correctly
    /// for the purposes of what crosses the N-API boundary; TypeScript's
    /// own downstream re-construction of `CollisionGeometryDiagnostic`
    /// instances from this DTO must use the same `hasOwnProperty`-gated
    /// constructor pattern it already uses, not blindly pass through an
    /// `undefined`-valued key.
    pub piece_id: Option<String>,
}
```

`NativeIrregularPoint`, `NativeIrregularBounds`, `NativeIrregularPolygon`,
`NativeIrregularTransform`, `NativeIrregularTransformCandidate` mirror
`domain.ts:139-297`'s plain classes field-for-field; deferred to the
semantic mapping table for exact enumeration (geometry/canonical-key
clusters own their precision requirements, not this document).

### 8.4 `NativeIrregularPortfolioResult`

Mirrors `IrregularPortfolioResult` (`domain.ts:1066+`): `status`,
`termination_reason: Option<String>` (`Schema.optional`, genuinely
presence-sensitive — "optional for older persisted results; emitted by
every current portfolio run" per the source doc comment, so Rust-produced
results should always populate it), `source`, `placements: Vec<NativeIrregularPlacement>`,
`unplaced_piece_ids: Vec<String>`, `score: Option<NativeIrregularLayoutScoreSummary>`.
Full field enumeration deferred to the semantic mapping table.

---

## 9. Structured failure DTO and error mapping

### 9.1 Failure DTO

```rust
#[napi(object)]
pub struct NativeIrregularFailure {
    pub code: String,      // one of AppErrorCode's strings, restricted to the set in §9.3
    pub message: String,
    /// All context values observed on the live TypeScript mapping today are
    /// plain strings or branded-string subtypes (`errors-protocol.md` §3:
    /// "All context values across the entire live surface are plain strings
    /// ... no numbers, booleans, nested objects, or BigInt"). Modeled
    /// uniformly as `HashMap<String, String>`; a numeric context value
    /// introduced only by this native boundary (`worker_protocol_error`'s
    /// `nativeApiVersion`, §9.3) is rendered as its decimal string form for
    /// uniformity — this is a new Rust-only convention with no TypeScript
    /// precedent to preserve, and is called out as an open question in §18
    /// for the orchestrator to confirm rather than silently assumed.
    pub context: HashMap<String, String>,
}
```

Napi-rs surfaces a `Result::Err` from an async job as a rejected JS Promise
carrying whatever error value is returned; the addon must reject with an
object structurally compatible with what the TypeScript integration layer
expects to convert into `WorkerResponseFailureError`
(`worker.ts:51-57`) — i.e., the fields above, nothing more. `create_irregular_job`
(synchronous) and `.run()` (async) both use this same `NativeIrregularFailure`
shape for every rejection.

### 9.2 Internal Rust error enum

```rust
pub enum IrregularNativeError {
    SourceGeometryMissing { prepared_piece_id: String, source_piece_id: String },
    GeometryInvalid { operation: String },
    NotImplemented { service: String, operation: String },
    ScoringError { operation: String },
    PortfolioError { operation: String, category: PortfolioErrorCategory },
    NoValidResult { operation: String },
    ControlAbort { reason: ControlAbortReason },
    // Rust-only, no TS `_tag` precedent (§3.3, §13):
    ProtocolVersionMismatch { native_api_version: u32, operation: String },
    // Panic containment (§12):
    Defect { operation: String },
}

pub enum PortfolioErrorCategory { Geometry, Scoring, Search }
pub enum ControlAbortReason { Cancelled, Deadline }
```

`ScoringError` collapses `IrregularPlacementScoringError` and
`IrregularLayoutScoringError` into one Rust variant because both already
map to the identical external code and context shape
(`irregular_scoring_error`, `{ operation }`) with no further distinguishing
information ever crossing the boundary (`errors-protocol.md` §11.1's rows
8-9; `nesting.worker.ts:426-432` handles both `_tag`s in one `switch` arm).
Preserving two separate TS `_tag`s as two separate Rust variants would add
type-level distinction with zero externally observable difference — safe
to unify per `errors-protocol.md` §12's general finding that `_tag`
discriminants "have no external visibility."

### 9.3 Mapping table (cross-checked against source and `errors-protocol.md`)

| `IrregularNativeError` variant | External `AppErrorCode` | Context fields |
|---|---|---|
| `SourceGeometryMissing` | `irregular_source_geometry_missing` | `preparedPieceId`, `sourcePieceId` |
| `GeometryInvalid` | `irregular_geometry_invalid` | `operation` |
| `NotImplemented` | `not_implemented` | `service`, `operation` |
| `ScoringError` | `irregular_scoring_error` | `operation` |
| `PortfolioError { category: Geometry }` | `irregular_geometry_invalid` | `operation`, `category: "geometry"` |
| `PortfolioError { category: Scoring \| Search }` | `irregular_scoring_error` | `operation`, `category: "scoring" \| "search"` |
| `NoValidResult` | `irregular_no_valid_result` | `operation` |
| `ControlAbort { reason: Cancelled }` | `worker_cancelled` | `reason: "cancelled"` |
| `ControlAbort { reason: Deadline }` | `worker_timeout` | `reason: "deadline"` |
| `ProtocolVersionMismatch` | `worker_protocol_error` | `nativeApiVersion` (decimal string, see §9.1), `operation` |
| `Defect` | `unknown_error` | `operation`, `backend: "rust"` (sanitized; see §12) |

This table is a **direct transcription** of `toIrregularWorkerFailure`
(`nesting.worker.ts:403-453`) plus the migration prompt §16 table, both of
which `errors-protocol.md` §11 independently confirmed agree exactly
("this table matches the migration prompt's section 16 table exactly,
verified against current source"). **No discrepancy was found between the
migration prompt's §16 table and current TypeScript source** for the 8 rows
that exist in both. Notes and caveats to carry forward, all sourced from
`errors-protocol.md`:

- `not_implemented` is currently **dead** in TypeScript production — only
  test-only `.Unimplemented` stub layers construct it
  (`errors-protocol.md` §1.2 row 7). Rust's `NotImplemented` variant is
  correspondingly not expected to fire for any of the two Rust-ported
  profiles unless a genuinely unimplemented sub-feature is deliberately
  stubbed during incremental Stage 2 rollout. Preserve the exact `code`,
  `service`, `operation` shape regardless.
- `ControlAbort { reason: Cancelled }` corresponds to a TS construction
  site (`computeIrregularNesting.ts:519`) that is **dead in production**
  today because `nesting.worker.ts` never wires `isCancelled`
  (`errors-protocol.md` §1.2 row 6, §11.2). In this design it becomes
  **live** via the cooperative cancellation mechanism in §6.3 — an
  explicitly new, authorized capability (not a TS behavior port), whose
  external observable shape (`worker_cancelled`, `{reason: "cancelled"}`)
  is nonetheless identical to what `toIrregularWorkerFailure` would
  already produce if `isCancelled` were ever wired in TS.
- `ControlAbort { reason: Deadline }` corresponds to the one checkpoint
  that **is** live in TypeScript production today
  (`intrinsicStrictDecoder.ts:472-487`'s per-decode wall-clock budget,
  `errors-protocol.md` §11.2). Its exact trigger point (*which* input was
  being evaluated when the budget expired) is inherently wall-clock-
  dependent and non-deterministic across machines/hardware
  (`errors-protocol.md` §7 makes the same point explicitly) — the Rust
  port reproduces the class of check (same budget unit, same comparison)
  but is not expected to fire at the identical logical step TypeScript
  would on the same input, consistent with migration prompt §8.1's
  numeric-semantics guidance applied to wall-clock, not deterministic,
  quantities.
- `worker_protocol_error` and `Defect`/`unknown_error`'s
  native-boundary-specific meaning are new producers this design
  introduces (§3.3, §12) — not a change to any accepted TypeScript
  behavior, since the code was already declared and reserved but unused.
- `IrregularGeometryInfeasibleError` (`services.ts:47-52`) is **not** a
  member of `IrregularComputeErrorType` and has no external code
  (`errors-protocol.md` §1.2 row 3, confirmed dead on the archive/production
  path — its only live construction site, `nfpIfpService.ts:242-247`
  inside `computeIfpBoundsCached`, has zero production callers). No Rust
  variant is needed for it on the ported Compact/Compact-Short-Side path;
  confirm this remains true if any future profile routes through
  `computeIfpBounds` directly.
- **Open, unresolved discrepancy carried forward from `errors-protocol.md`
  §15 open question 4**: `workerTimeoutForMode`'s 390-second floor
  (`src/shared/irregular/defaults.ts:19-26`) appears to have no live
  caller in `WorkerSupervisor`, which instead hardcodes `defaultTimeoutMs:
  60_000`. This affects when the **main-process** hard timeout fires
  around the whole worker thread (a different mechanism from anything in
  this document, per §6.1), not the native boundary's own contract, but it
  is exactly the kind of fact that determines whether a Compact Short Side
  job today can even complete before being killed. Flagged again here
  because it directly bears on whether `worker_timeout`'s realistic
  production frequency changes once Rust is faster — the orchestrator
  should resolve which of the 60s/390s figures is authoritative before any
  performance-contract interpretation assumes either one.

---

## 10. Streamed event delivery

Three logical event channels, all delivered via `ThreadsafeFunction`
callbacks supplied once, in `NativeIrregularCallbacks`, to `.run()`:

```rust
#[napi(object)]
pub struct NativeIrregularCallbacks {
    /// Called for each `IrregularPortfolioProgress` the coordinator would
    /// emit today via `emitPortfolioProgress` — see §10.1. Always present;
    /// production `nesting.worker.ts` always sets `emitPortfolioProgress`
    /// (`nesting.worker.ts:348-374`, unconditionally included), so the
    /// native boundary requires it too rather than making it optional.
    pub on_portfolio_progress: ThreadsafeFunction<NativeIrregularPortfolioProgress, ...>,
    /// Called for each selected beam state snapshot — see §10.2. Optional:
    /// present iff `historyMode !== 'off'` on the TypeScript side, mirroring
    /// `emitStateSnapshot`'s own presence rule (`nesting.worker.ts:348-374`).
    pub on_state_snapshot: Option<ThreadsafeFunction<NativeIrregularStateSnapshotRecord, ...>>,
    /// Called per decision-trace event batch — see §10.3. Optional: present
    /// iff `historyMode !== 'off' && workerMode === 'irregular-convex-v2'`,
    /// mirroring `emitDecisionTrace`'s presence rule. Expected call count is
    /// zero for both Compact and Compact Short Side today (§10.3).
    pub on_decision_trace_batch: Option<ThreadsafeFunction<Vec<NativeIrregularDecisionTraceEvent>, ...>>,
}
```

### 10.1 Portfolio progress

`IrregularPortfolioProgress` (`domain.ts:1037-1049`):

```rust
#[napi(object)]
pub struct NativeIrregularPortfolioProgress {
    pub decode_role: Option<String>,       // "production" | "canonical-reference"
    pub phase: String,                     // IrregularPortfolioPhase literal
    pub generation: Option<u32>,
    pub evaluations_completed: Option<u32>,
    pub population_size: Option<u32>,
    pub best_score: Option<NativeIrregularLayoutScoreSummary>,
    pub best_source: Option<String>,       // "beam" | "ga"
    pub elapsed_ms: f64,
    pub remaining_ms: Option<f64>,
}
```

`elapsed_ms` should be produced by whatever clock Rust uses internally
(monotonic; does not need to match any TS wall-clock value byte-for-byte —
`worker-coordination.md` §7 already establishes this class of field as
diagnostic/telemetry, not gated by exact-value tests). The **logical**
phase sequence, count, and `bestScore`/optional-field presence are what
migration prompt §15/§18.3 require exact parity for: "Preserve the exact
logical event count, phase sequence, ordering, completed and total work
values, best-score payloads, and optional-field presence." A differential
test must exclude only `elapsed_ms`/`remaining_ms` as explicitly documented
non-semantic fields, never the phase/count/best-score fields.

Delivery: call from the job's single logically-serial coordinator thread
only, at exactly the call sites `coordinateIntrinsicSharedArchive`'s Rust
port uses for `emitSharedArchiveProgress`
(`computeIrregularNesting.ts:1454` and siblings, per
`worker-coordination.md` §13). **Never** call this `ThreadsafeFunction`
from inside a Rayon closure — migration prompt §14.2 explicitly forbids
"global trace append operations from Rayon workers," and progress emission
is the same class of hazard even though it is not itself a trace-append.
Use non-blocking `ThreadsafeFunction` calls (`ThreadsafeFunctionCallMode::NonBlocking`)
and treat delivery failure (e.g. the JS side has already begun tearing
down) as ignorable — matching `send(...)`'s
`Effect.catchCause(() => Effect.void)` swallow pattern in
`nesting.worker.ts:182-185`. Progress delivery must never fail or slow the
job.

### 10.2 State snapshots / history frames

TypeScript's `emitStateSnapshot(snapshot, beamWidth)`
(`ComputeIrregularNestingOptions`, `computeIrregularNesting.ts:118`) feeds
`makeIrregularHistoryFrame` (`irregularWorkerOutput.ts:42-82`), which needs
`request`, a derived `strategyRunId`, the snapshot, `beamWidth`, and a
`createdAt` timestamp to build one `IrregularHistoryFrame`. Every one of
those inputs except `createdAt` is already available inside the Rust job
(the request DTO and the profile-derived `strategyRunId` construction are
both pure functions of data Rust already owns per §7); `createdAt` is a
plain ISO-8601 timestamp Rust can generate itself with no behavioral
difference (`worker-coordination.md` §12 confirms this class of field is
not gated by exact-value tests, only by round-tripping through
`Schema.String`).

**Design choice: Rust emits the complete, already-assembled history-frame
record**, not raw snapshot pieces that TypeScript reassembles:

```rust
#[napi(object)]
pub struct NativeIrregularStateSnapshotRecord {
    pub step_index: u32,
    pub beam_rank: u32,
    pub candidate_count: u32,
    pub source: Option<String>,       // "beam" | "shared-archive"
    pub state: NativeIrregularBeamStateSnapshot,  // see below
    pub beam_width_for_frame: u32,    // hardcoded `1` for every shared-archive-sourced
                                        // frame, mirroring irregularWorkerOutput.ts:78
                                        // exactly — NOT input.beamWidth
    pub title: String,                // 'shared-archive-final-selected' | 'shared-archive-selected-layout-reveal'
    pub strategy_label: Option<String>,
    pub created_at: String,           // ISO-8601, generated by Rust
}
```

This mirrors the migration prompt's own framing exactly: "Rust owns the
complete algorithm execution ... This includes ... result materialization
... selected-layout reveal data needed by TypeScript history persistence"
(§1). TypeScript's role becomes a dumb pass-through: append the record to
the NDJSON file, optionally forward it over the existing RPC stream when
`historyMode === 'stream'`, and increment `frameCount` — exactly what
`makeFrameEmitter` (`nesting.worker.ts:156-188`) does today with a
TS-constructed `IrregularHistoryFrame`, minus the construction step, which
Rust now performs. **`beamWidthForFrame`'s hardcoded-`1` rule
(`irregularWorkerOutput.ts:78`: `sharedArchive ? 1 : input.beamWidth`) and
the `title`/`strategyLabel` selection rules (`:51-70`) must be ported
verbatim into Rust**, not "cleaned up" into always using the real beam
width or a computed title — these are exact, currently-accepted output
values per `worker-coordination.md` §3.5.

`NativeIrregularBeamStateSnapshot` mirrors `IrregularBeamState`'s
externally-relevant fields (placements so far, remaining/unplaced piece
IDs, occupied geometry identity, etc.) — full enumeration deferred to the
semantic mapping table (`search-scoring.md`'s subject).

Delivery: same threading rule as §10.1 — job coordinator thread only, in
program order, non-blocking calls, delivery failure ignored. Ordering must
be strict emission order (matches `Queue.offerUnsafe`/`Stream.runForEach`'s
FIFO semantics, `nesting.worker.ts:212-230`); napi-rs's `ThreadsafeFunction`
preserves call order for calls made from one calling thread in program
order (verify this specific ordering guarantee for the exact napi 3.12
API surface chosen in Stage 1, per §18).

`state_snapshots` is also retained on `NativeIrregularComputeResult` (§8)
as a complete post-hoc array for differential testing convenience
(comparing a whole run's snapshot sequence against TypeScript's without
needing to capture the live callback stream in a test), mirroring
`IrregularComputeResult.stateSnapshots` (`computeIrregularNesting.ts:335`)
directly — this is not a new field, it already exists on the plain
TypeScript algorithm output today.

### 10.3 Decision trace

Per `worker-coordination.md` §1: for Compact and Compact Short Side,
`emitDecisionTrace` is **accepted but never invoked** —
`grep -n "emitDecisionTrace" computeIrregularNesting.ts` shows exactly two
hits, the field declaration and one forwarding site inside
`runSingleSheetPortfolio` (the legacy, non-archive, not-ported branch).
`decisionTraceEventCount` is always `0` for these two profiles in
production; the NDJSON file is still created (empty) whenever
`historyMode !== 'off'`.

**Design decision (flagged for explicit orchestrator confirmation, §18):**
this design wires `on_decision_trace_batch` into the N-API surface (present
under the same condition TypeScript uses today) but the Rust archive-path
coordinator does not call it — matching current behavior exactly, with the
callback plumbing present for uniformity with `on_portfolio_progress`/
`on_state_snapshot` and to keep the door open for a future profile that
does emit decision-trace events without a boundary-shape change. This is
the conservative choice: it reproduces "accepted but zero calls" exactly,
rather than either (a) silently dropping the callback field, which would
be a boundary-shape difference for no behavioral reason, or (b) inventing
new decision-trace emission for these two profiles, which the migration
prompt's absolute-preservation rule (§2: "decision-trace ordering" is in
the do-not-change list) would forbid without an explicit ruling.

`NativeIrregularDecisionTraceEvent`'s exact field shape is
`errors-protocol.md`/`decisionTrace.ts`'s subject, deferred to the semantic
mapping table; since it is never constructed on the ported path today, its
exact shape is not load-bearing for Stage 1/2 acceptance.

---

## 11. Threading and ownership rules for all three event channels

- All three `ThreadsafeFunction`s are invoked **only** from the job's
  single dedicated coordinator OS thread (§6.1), never from a Rayon worker
  thread, per migration prompt §7 ("Do not invoke JavaScript from Rayon
  worker threads") and §15 ("Progress reporting must not require
  JavaScript callbacks from Rayon threads. Aggregate native progress at
  the same logical serial boundaries as TypeScript"). If a future Rayon
  batch (Stage 4) produces information that would otherwise feed one of
  these events, the batch must complete and be reduced back to the
  coordinator thread before the event fires — exactly the "construct
  ordered input → parallelize pure work → reassemble in order → apply ...
  trace emission in the same logical order as TypeScript" pattern
  (migration prompt §14.3).
- The addon does not retain a raw N-API `Env` handle inside the coordinator
  thread or any Rayon task (migration prompt §7); only `ThreadsafeFunction`
  handles (which are explicitly designed by napi-rs for cross-thread use)
  and owned Rust data cross into those threads.
- `ThreadsafeFunction` handles are released as part of `dispose()` (§6.4),
  not left to `Drop` timing alone, so that a `.cancel()`-then-`.dispose()`
  sequence deterministically stops any further JS calls before returning
  control to the caller.

---

## 12. Panic containment

Every panic that could occur inside `.run()`'s coordinator thread or any
Rayon worker it spawns must be caught **before** it can unwind across the
N-API boundary or take down the Electron process (migration prompt §7:
"Contain every Rust panic before it crosses N-API ... Never allow an
unwinding panic to terminate Electron"; §16: "Create typed Rust error enums
... Never allow an unwinding panic to terminate Electron" repeated;
"contained panic, internal invariant failure, or otherwise unclassified
native defect handled by the existing unknown-failure boundary" maps to
`unknown_error`).

Design:

- Wrap the coordinator thread's top-level work in `std::panic::catch_unwind`
  (requiring the coordinator's closure and everything it touches to be
  `UnwindSafe`, or wrapped in `AssertUnwindSafe` with a documented
  justification per migration prompt §16's "Every `unsafe` block must have
  a local safety argument" spirit, applied here to the unwind-safety
  assertion rather than literal `unsafe`).
  - `catch_unwind` catches the *this-thread* panic; if the panic occurs
    inside a **Rayon** worker (Stage 4), Rayon's own panic propagation
    (a panicking `rayon::join`/parallel-iterator closure poisons and
    re-panics on the thread that joins the work) must be caught at the
    **Rayon-batch reduction point** inside the coordinator, before any
    partial batch result is used — not only at the outermost coordinator
    boundary — so that a single bad candidate evaluation cannot leave
    shared cache/archive state in an inconsistent condition observed by
    later serial code before the panic is reported.
- On a caught panic, construct `IrregularNativeError::Defect { operation }`
  where `operation` is the best-known logical operation name in scope at
  the catch site (mirroring the `operation` context TypeScript's own typed
  errors already carry for every other code, so `unknown_error`'s context
  is not less informative than its siblings' `operation` fields — this
  goes slightly beyond what `nesting.worker.ts`'s outer `Effect.catchCause`
  provides today, which has no `operation` field at all, only
  `Cause.pretty(cause)` as the whole message; see the note below).
- **Sanitization, per migration prompt §7 and §16**: do not expose the raw
  panic payload (`std::panic::PanicHookInfo`'s message, which may embed
  arbitrary formatted data including, in principle, fragments of
  algorithm state) or a native backtrace in the `message`/`context` fields
  by default. The `message` should be a fixed, generic string (e.g.
  `"native irregular nesting job failed unexpectedly"`) plus the sanitized
  `operation`/`backend: "rust"` context fields from the mapping table
  (§9.3). Full panic detail (payload, backtrace) belongs only in the
  non-semantic diagnostics sidecar (§14), gated behind an explicit opt-in
  diagnostic capture flag, never in the default `NativeIrregularFailure`.
- **Note on TypeScript's own current `unknown_error` sanitization**:
  `errors-protocol.md` §12 finds that TypeScript's *existing*
  `unknown_error` path (`Cause.pretty(cause)`, `nesting.worker.ts:333`) is
  **not** currently sanitized — it embeds full Effect defect formatting,
  potentially including stack traces. This document's Rust-side
  sanitization is therefore **stricter** than current TS behavior for this
  one code, which the migration prompt explicitly authorizes ("do not
  expose raw panic payloads or a native backtrace by default") even though
  it is not, strictly, "preserving exact TypeScript behavior" for
  `unknown_error`'s message text specifically. `errors-protocol.md` §15
  open question 5 already flags that no test pins `unknown_error`'s
  message byte-for-byte, so this is a safe, prompt-authorized divergence,
  not a forbidden one — confirm this reading with the orchestrator before
  Stage 2 (§18).
- After a panic is caught and converted, the job's cache/state must be
  discarded, not reused — `dispose()` runs the normal cleanup path
  (§6.4); a poisoned mutex or corrupted shared-cache entry must not
  silently affect a *later, different* job (migration prompt §18.4:
  "verify panic injection does not poison future jobs"). Because caches
  are job-local by default (per the cache/concurrency design document's
  expected default, migration prompt §13.6), this is largely free as long
  as no cache handle escapes the panicking job's `Arc` graph into a
  process-global structure.

---

## 13. Rust-side revalidation of safety-critical invariants

The current architecture has exactly one untrusted→trusted boundary (Seam
A, TypeScript `Schema.decodeUnknownSync`) plus two narrow, redundant
in-process re-validations (Seam B, `effect-boundary.md` §2.3). The Rust
port introduces a **second, genuinely new trust boundary**: JS↔native
across N-API. Migration prompt §7 is explicit that this new boundary must
not be assumed safe merely because TypeScript validated correctly upstream:
"Revalidate safety-critical invariants in Rust at the trust boundary. Never
assume malformed input cannot reach native code."

### 13.1 What `create_irregular_job` revalidates synchronously, before any thread is spawned

Cheap, O(piece count) or O(1) structural checks, matching what Seam A
already guarantees so that a genuine mismatch indicates either (a) a bug in
the napi-rs `FromNapiValue` conversion, (b) a test/script harness
constructing the native DTO directly without going through TypeScript's
schema (an explicitly supported use case for differential/unit testing per
migration prompt §18.2, which must still be defended against), or (c) a
future TypeScript regression that stops validating before calling Rust:

- `version == 1`.
- `sheet.width > 0`, `sheet.height > 0`, both within the safe-integer
  canonical-grid bound established by `canonical-grid.md`'s proved
  arithmetic (the exact ceiling — the `2^25 - 1` cross-product fast-path
  bound and/or the `2^53 - 1` safe-integer ceiling documented in
  `js-semantics-audit.md` §7.2 — must be re-derived from
  `canonical-grid.md` directly in Stage 2, not assumed from this document).
- `padding_mm >= 0`; every `piece.padding_mm >= 0`.
- Every `piece.real_bounds`/`padded_bounds` fields are positive/non-negative
  per the same rule as `Rect`/`RectWith` (`geometry.ts:29-39`).
- `irregular_settings.geometry.clearance_safety_margin_mm >= irregular_settings.geometry.flattening_sag_tolerance_mm`
  and `flattening_sag_tolerance_mm > 0` (the cross-field check
  `domain.ts:285-294` already enforces at Seam A — re-checked here, not
  trusted blindly).
- `irregular_settings.optimizer.placement_policy_id` is a member of
  `irregular_settings.optimizer.placement_policy_ids`, and
  `placement_policy_ids` has no duplicates (`domain.ts:418-458`'s
  cross-field filter, re-checked).
- **The load-bearing new check**: if
  `irregular_settings.optimizer.intrinsic_objective_profile_id == "short-side"`,
  then `intrinsic_shared_archive_enabled == true` **and** GA is fully
  disabled (`ga_enabled == false || baseline_only == true || ga_time_budget_ms
  == 0 || ga_generation_budget == 0 || ga_evaluation_budget == 0`), and
  `placement_policy_id != "short-side-fill"` — reproducing
  `domain.ts:418-458`'s Short-Side cross-field constraint exactly.
- **The load-bearing scope check**: `intrinsic_shared_archive_eligibility`
  — the Rust equivalent of `intrinsicSharedArchiveEligibility`
  (`src/shared/irregular/executionMode.ts:16-32`) — must evaluate to
  `true` for the supplied settings. **If it does not, `create_irregular_job`
  must reject**, rather than attempt any execution. This is the single most
  important revalidation in this list: `errors-protocol.md` §1.1 and
  `worker-coordination.md` §1 both establish that when this eligibility
  check is false, current TypeScript takes the **legacy windowed-beam/GA
  path** (`runSingleSheetPortfolio`, the `else` branch of
  `coordinateIntrinsicSharedArchive`'s `archiveEnabled` gate,
  `computeIrregularNesting.ts:1065-1069`) — a code path this migration
  explicitly does **not** port to Rust (migration prompt names only Compact
  and Compact Short Side; `worker-coordination.md` §1 documents the legacy
  path as "a distinct algorithm shape kept in TypeScript"). A Rust addon
  that received such a request and attempted to run its (nonexistent)
  legacy-path emulation, or silently ran the archive path anyway despite
  ineligible settings, would both be observable behavior changes forbidden
  by migration prompt §2. Rejecting cleanly, with a typed error, is the
  only safe response. **Primary defense should be at the TypeScript backend
  selector** (route ineligible requests to the TypeScript backend
  unconditionally, regardless of the configured Rust/TypeScript preference
  — see the backend-selection/rollback document and §18 open question 1
  here); this native-boundary check is the required defense-in-depth layer,
  per migration prompt §7, not a substitute for correct TS-side routing.

A revalidation failure at this stage maps through the same
`IrregularNativeError`/`AppErrorCode` table as any other failure (§9); the
specific code depends on which check failed — most naturally
`GeometryInvalid { operation: "nativeBoundaryRevalidation" }` →
`irregular_geometry_invalid` for generic structural/numeric invariant
violations (closest semantic match to Seam B's own
`IrregularGeometryInputError` usage for analogous checks,
`effect-boundary.md` §2.3), and specifically `NotImplemented { service:
"irregular-native", operation: "legacy-portfolio-unsupported" }` →
`not_implemented` for the shared-archive-eligibility rejection above (this
finally gives `not_implemented` a legitimate, intentional live purpose in
the Rust backend — "an operation this backend does not implement" is
exactly what the code was always documented to mean, even though no
current TypeScript path constructs it that way). **Confirm both mapping
choices with the orchestrator before Stage 2** (§18) — reasonable
alternatives exist (e.g. `worker_protocol_error` for the eligibility
rejection, on the theory that it is closer to "a malformed/unsupported
request shape reaching the native boundary" than to "invalid geometry").

### 13.2 What is re-checked during execution, not at job creation

Seam B's two specific checks (`effect-boundary.md` §2.3) — non-convex
collision polygon reaching `offsetConvexPolygon`, non-finite computed
offset distance — are re-implemented as part of the ported
collision-geometry-preparation code itself (in scope per migration prompt
§4.1), not duplicated again at the N-API boundary; they run exactly once
per prepared piece, exactly where TypeScript runs them today, and map to
`GeometryInvalid { operation: "offsetConvexPolygon" | "generateTransforms" }`
→ `irregular_geometry_invalid`, preserving the `operation` context value
exactly (message text is not contractually pinned per
`errors-protocol.md` §15 open question 5, but `operation` values are
effectively enumerable and should be preserved verbatim).

---

## 14. Non-semantic diagnostics sidecar channel

Per migration prompt §7 and §13.7: native backend version, Rust crate
version, target triple, thread count, and cache policy identity belong
**only** in an explicitly non-semantic diagnostic channel, kept **outside**
result objects, persisted sub-run settings, canonical data, hashes,
histories, checkpoints, progress events, and parity projections.

```rust
#[napi(object)]
pub struct NativeJobDiagnostics {
    pub capability: NativeCapability,           // §3.2, echoed for convenience
    pub thread_count_used: u32,                 // actual Rayon pool size this run used
    pub wall_clock_ms: f64,                     // Rust-measured job duration; not gated by any parity test
    /// Cache telemetry (§13.7 of the migration prompt: lookups, hits,
    /// misses, stores, stale detections/removals, duplicate computations,
    /// single-flight waits, shard-lock contention, front/backing-cache
    /// hits, evictions, entries and bytes by namespace, computation time by
    /// namespace). Full shape owned by the cache/concurrency design
    /// document; referenced here only to fix its channel, not its fields.
    pub cache_telemetry: Option<NativeCacheTelemetry>,
    /// Present only when a panic was caught (§12) and a diagnostic capture
    /// flag was set on the request/callbacks (not by default — sanitized
    /// failure fields in §9/§12 are what production code sees).
    pub panic_detail: Option<NativePanicDetail>,
}
```

Enforcement rules, restated as concrete constraints on this design:

- `NativeJobDiagnostics` is returned **only** on `NativeIrregularOutcome`
  (§5) — the success path — never folded into
  `NativeIrregularComputeResult` (§8) itself, and never included in any of
  the three streamed event payloads (§10). A field that could affect a
  differential-parity comparison must not be reachable by accidentally
  comparing `NativeIrregularOutcome` structurally instead of
  `NativeIrregularOutcome.result` — the TypeScript integration layer and
  any Rust-side differential-test harness must diff `.result` only, never
  the whole outcome, exactly as migration prompt §17 requires ("Backend
  identity, native version, thread count, cache policy, and cache
  telemetry belong only to the separate non-semantic diagnostic channel.
  Differential parity projections must exclude that entire diagnostic
  channel by construction rather than removing individual differing
  fields after a mismatch").
- On failure, `NativeIrregularFailure` (§9.1) has no diagnostics field at
  all in the default path; if diagnostic capture is explicitly requested
  (test/gate harness only), it must be delivered through a **separate**
  side-channel call (e.g. an additional field only present when an opt-in
  flag was set on the request, itself excluded from the default failure
  shape TypeScript's protocol schema expects), not by growing
  `NativeIrregularFailure`'s `context: HashMap<String, String>` with
  non-string diagnostic payloads.
- `get_capability()` (§3.2) is itself entirely diagnostic and must never be
  read by any algorithm code path — it exists solely for the TypeScript
  load-time check (§3.3) and for populating `NativeJobDiagnostics.capability`.

---

## 15. Cross-check summary: discrepancies between the migration prompt and current source

Collected here for visibility, all independently sourced from the
characterization corpus, none newly discovered by this document:

1. **No discrepancy in the §16 error-mapping table itself** — confirmed
   exact against `nesting.worker.ts:403-453` by `errors-protocol.md` §11.
2. `worker_protocol_error` (prompt §16 row) has zero current TypeScript
   producers — correctly anticipatory, not a current bug
   (`errors-protocol.md` §1, §15 open question 1).
3. `not_implemented` (prompt §16 row) is unreachable from any real
   TypeScript job today, only from test-only `.Unimplemented` layers
   (`errors-protocol.md` §1.2 row 7, §15 open question 2).
4. The `IrregularNfpIfpControlAbortError`/`isCancelled` cooperative
   mechanism the prompt's §15 narrative describes as apparently
   load-bearing in production is, per source, **entirely inert** in
   TypeScript production (`errors-protocol.md` §10, §15 open question 3;
   `worker-coordination.md` §10, §15 open question 3). This document's
   §6.3 response is the recommended resolution, flagged for explicit
   orchestrator sign-off.
5. The prompt's §9 framing of "the current custom encoding" for canonical
   checkpoint JSON in the singular does not match source: there are (at
   least) four independently-implemented canonical encoders with real
   comparator and `BigInt`/`Map`-handling divergences
   (`js-semantics-audit.md` §8.1, §15 open question 1). This is a
   checkpoint-encoding concern, not a native-boundary-shape concern per
   se — checkpoints do not cross the N-API boundary designed in this
   document (they are internal Rust state per migration prompt §11) —
   but it directly affects the checkpoint-compatibility document's scope
   and is recorded here so it is not lost.
6. `workerTimeoutForMode`'s 390-second floor has no confirmed live caller;
   the supervisor's actual timeout may be `60_000` ms in production for
   irregular jobs too (`errors-protocol.md` §15 open question 4). Recorded
   again in §9.3.

None of these discrepancies require a source-of-truth change under the
migration prompt's own rules (§2: "the existing TypeScript behavior is the
specification"); they require explicit, recorded design decisions where
the native boundary must do something TypeScript's production code
path never actually exercises (most prominently, cooperative
cancellation, §6.3).

---

## 16. Threading and Rayon boundary notes specific to this document

Not a full concurrency design (owned by the cache/concurrency design
document, migration prompt §22.4); the following are the constraints this
boundary document imposes on any future concurrency design:

- **16.1** No `NativeIrregularCallbacks` `ThreadsafeFunction` is ever
  cloned into, or called from, a Rayon worker closure (§11).
- **16.2** The job owns its own Rayon thread pool (`rayon::ThreadPoolBuilder`
  building a job-scoped `ThreadPool`, not `rayon::join`/`par_iter` against
  the process-global default pool), so that thread count is a per-job,
  per-call configuration value (test harnesses can vary it per migration
  prompt §14.4) and so that pool shutdown is tied to `dispose()` (§6.4)
  rather than outliving the job or leaking into unrelated concurrent jobs.
  `NativeCapability.default_thread_count` (§3.2) reports what the pool
  would use absent an override; an explicit thread-count override, if
  supported, is a diagnostic/test-only field on the request, never part of
  the semantic request shape that could affect canonical output (migration
  prompt §14.4: "do not let thread count affect algorithmic budgets or
  selected output").
- **16.3** `Arc<GeometryCacheStore>`-equivalent sharing (the cache
  architecture's central object, per `effect-boundary.md` §9.3's "one
  cache per job" finding) must be constructed exactly once per job and
  threaded explicitly through every consumer's constructor — Rust has no
  implicit Effect-Layer-style memoization to accidentally get this right,
  unlike the TypeScript source (`effect-boundary.md` §12 point 2). This
  document does not further specify the cache's internal design; it only
  fixes that the cache's lifetime is job-scoped and its ownership crosses
  no N-API boundary (it is never exposed to JS in any form).

---

## 17. What this document deliberately leaves to other Stage-0 deliverables

- Exact field-for-field enumeration of every nested domain type referenced
  above by name only (`NativeIrregularBeamStateSnapshot`,
  `NativeIrregularLayoutScore`, `NativeIntrinsicCapacityTrace`, etc.) —
  the TS-to-Rust semantic mapping table (migration prompt §22.2).
- Canonical-grid integer bounds and arithmetic — `canonical-grid.md` and
  the architecture document; this document only asserts that no
  canonical-grid `BigInt`-equivalent value ever crosses the N-API boundary
  (§7.4 note, §13.1).
- Cache concurrency/telemetry internals — the cache and concurrency design
  document (migration prompt §22.4); this document only fixes the
  diagnostics-channel placement (§14) and the "job-owned, one instance"
  ownership constraint (§16.3).
- Checkpoint encoding/compatibility — the checkpoint compatibility document
  (migration prompt §22.6); checkpoints are Rust-internal state per
  migration prompt §11 and do not cross this N-API boundary in this
  design. If cross-process/cross-version checkpoint resume via N-API is
  ever required, it needs an explicit addendum to this document.
- Packaging, platform targets, CI matrix — the native build/packaging
  document and CI target matrix (migration prompt §22.8-9).

---

## 18. Open questions requiring an orchestrator ruling

1. **Cooperative cancellation as a new capability (§6.3).** Confirm this
   design may introduce cooperative, coordinator-stage-boundary polling for
   cancellation/deadline as the Rust mechanism, given that TypeScript's own
   equivalent mechanism is inert in production today and that a native OS
   thread cannot be safely hard-killed the way a Node `worker_thread` can.
   Confirm the externally observable contract to preserve is exactly "no
   partial result, correct external code" and nothing about internal
   chronology, since production observes no chronology past a cancellation
   point today.
2. **Environment-cleanup-hook reliability under `worker.terminate()`
   (§6.4).** Requires a Stage 1 experiment distinct from the
   already-verified "`ThreadsafeFunction` from background threads works"
   finding. Until verified, treat `.dispose()` as the only reliable cleanup
   path and document the cleanup hook as best-effort only.
3. **`Option<T>` omission-vs-`null` behavior for napi-rs 3.x `#[napi(object)]`
   fields (§8, §8.3).** Must be verified experimentally in Stage 1 before
   any optional-field-presence claim in this document (§8.1's trace-field
   table, `piece_id`'s `hasOwnProperty`-gated omission) is trusted for
   parity testing.
4. **`ThreadsafeFunction` call-order guarantee under the exact napi 3.12
   API surface chosen (§10.2).** Must be confirmed, not assumed, before
   relying on it for the FIFO-ordering claim streamed events require.
5. **Mapping choice for the shared-archive-eligibility rejection (§13.1).**
   `not_implemented` vs. `worker_protocol_error` vs. a different code for
   "this backend does not implement the legacy non-archive-eligible
   settings shape." Needs an explicit ruling before Stage 2 gates depend on
   it.
6. **Numeric context-value string rendering for `worker_protocol_error`
   (§9.1).** Confirm the decimal-string convention for
   `nativeApiVersion` is acceptable, or specify an alternative
   representation, given there is no TypeScript precedent to preserve for
   this brand-new context field.
7. **`unknown_error` sanitization being stricter in Rust than in current
   TypeScript (§12).** Confirm this is an accepted, prompt-authorized
   divergence for message text specifically (not code/context shape),
   consistent with `errors-protocol.md` §15 open question 5's finding that
   no test currently pins `unknown_error` message bytes.
8. **`ImportedPiece.warnings` and `SheetSpec.label` non-inclusion in the
   trusted native DTO (§7.2, §7.3).** Confirm no characterized irregular
   code path reads either field before finalizing the request DTO; if the
   semantic mapping table finds a consumer, both fields need to be added
   back.
9. **Decision-trace callback wiring for two profiles that never call it
   (§10.3).** Confirm keeping `on_decision_trace_batch` present-but-unused
   in the boundary shape (rather than omitting it entirely) is the correct
   choice, or confirm an explicit decision to omit it for Stage 1/2 and
   revisit only if a future profile needs it.
10. **Primary vs. defense-in-depth responsibility for the
    shared-archive-eligibility guard (§13.1).** Confirm the backend
    selector (TypeScript) is the primary enforcement point (never routing
    an ineligible request to Rust at all) and that this document's native
    check is explicitly secondary defense-in-depth, consistent with
    migration prompt §7's "never assume malformed input cannot reach
    native code" framing applied to a case where the "malformed" input is
    actually a valid TypeScript request shape for a code path Rust simply
    does not implement.
