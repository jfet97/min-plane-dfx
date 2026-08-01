# Parity Matrix — Compact / Compact Short Side (Stage 0 item 7)

Status: Stage 0 design artifact. This document maps every TypeScript
subsystem on the Compact / Compact Short Side production path to (a) the
existing tests/gates that currently pin its behavior, (b) planned **new**
Rust unit tests, (c) planned differential (TS-vs-Rust) tests, (d) planned
concurrency-determinism tests, and (e) planned property/fuzz targets. It does
not itself add any test; it is the plan required by the governing migration
prompt (`docs/history/prompts/fable5-rust-irregular-nesting-implementation.md`,
hereafter "the prompt") §6 Stage 0 item 7 and is grounded exclusively in the
Stage 0 characterization corpus under
`docs/planning/rust-irregular-backend/characterization/` plus
`docs/planning/rust-irregular-backend/js-semantics-audit.md`,
`docs/planning/rust-irregular-backend/baseline-evidence.md`, and
`docs/planning/rust-irregular-backend/performance-contract.md`. Every "(a)"
entry below was independently re-verified against source in this pass (gate
scripts, `package.json`, checked-in artifacts) rather than trusted
second-hand from the characterization docs; see §2 for the highest-stakes
case (Mixed-61) verified line-by-line.

Per the prompt §2, nothing in this document is a recommendation to change
behavior. "Planned test" descriptions state what a Rust differential harness
must assert to detect a regression from the pinned TypeScript behavior, not
a new algorithm.

This document does not restate full subsystem semantics — each subsystem
section names its owning characterization doc(s) for that. It restates only
what is needed to state exact test expectations.

---

## 1. Method and column legend

Each subsystem section below has five lettered subsections:

- **(a) Existing tests/gates** — exact files, exact pinned values, exact
  `file:line` citations, re-verified against source in this pass where the
  value is load-bearing (hash, count, status literal). Distinguishes
  CI-authoritative (`pnpm test`, four promoted `gate:*` scripts) from
  non-gated research scripts, per
  `characterization/tests-gates-inventory.md`.
- **(b) Planned NEW Rust unit tests** — mapped from the prompt's §18.2 list
  (34 items; verbatim item names are used as tags below so completeness
  against the prompt can be checked by searching this document for each
  quoted phrase). "NEW" means additive to the Rust test suite; it never
  replaces or edits an existing TypeScript test (prompt §3).
- **(c) Planned differential tests** — mapped from the prompt's §18.3 list
  (21 items). These compare TypeScript output to one-thread Rust output on
  the same validated request, per prompt §6 Stage 2 and §17.
- **(d) Planned concurrency determinism tests** — mapped from the prompt's
  §18.4 procedure (run at 1, 2, default, and a higher thread count; repeat;
  vary scheduling; compare all semantic outputs, ledgers, hashes, checkpoint
  resume; verify no deadlocks; verify cancellation/panic cleanup) and from
  §14.1/§14.2's safe/unsafe boundary lists. Subsystems whose current
  TypeScript chronology is a §14.2 "high-risk boundary" are marked
  **serial-only** with a citation, not silently skipped.
- **(e) Planned property/fuzz targets** — mapped from the prompt's §18.5
  list (10 items).

Appendix §16 cross-checks that every item in prompt §§18.2/18.3/18.5 is
mapped to at least one subsystem.

---

## 2. Mixed-61 pinned identities — exact source locations (re-verified)

The prompt §18.6 states seven Mixed-61 `2000x2700` pinned values. Every one
was re-verified directly against source in this pass (not merely against the
characterization doc), with exact line numbers:

| Pinned value | Exact value | Verified source location |
| --- | --- | --- |
| Collision identity | `3839e80d26be257381f1962816765a886d4b7e3c3d78120892e4a6a943dfa742` | `scripts/irregular-compact-nine-baselines.ts:48` (`BASELINES[1].collisionIdentitySha256`); also `scripts/profile-mixed61.mjs:31` (`--expected-collision-identity-sha256`); also `docs/artifacts/current-compact-baselines/mixed-61-2000x2700.json` → `result.collisionIdentitySha256` (checked-in accepted-run artifact, re-read this pass) |
| Fitted canonical identity | `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b` | `package.json:32` (`gate:mixed61-compact`'s `--expected-canonical-sha256`); `scripts/irregular-compact-nine-baselines.ts:49`; `scripts/profile-mixed61.mjs:32`; `docs/artifacts/current-compact-baselines/mixed-61-2000x2700.json` → `result.fittedCanonicalSha256` |
| Placed / unplaced | `61` / `0` | `scripts/irregular-compact-nine-baselines.ts:50-51`; `scripts/profile-mixed61.mjs:33-35`; artifact `result.placedCount`/`result.unplacedCount` |
| Maximum accepted area | `391605.850174 mm²` (gate ceiling `391606`, i.e. `package.json:32`'s `--maximum-area-mm2 391606`; exact value `391_605.850174` at `scripts/irregular-compact-nine-baselines.ts:52`, `--maximum-area-mm2 391605.850174` at `scripts/profile-mixed61.mjs:37-38`) | artifact `result.bounds.area = 391605.85017399996` (binary64 nearest value; re-read this pass) |
| Canonical cavities | `0` | `package.json:32`'s `--maximum-canonical-cavities 0`; `scripts/irregular-compact-nine-baselines.ts:53`; artifact `result.canonicalTopology.enclosedCavityCount = 0` |
| Focused status / evaluations | `evaluation-cap` / `12000` | `scripts/irregular-compact-nine-baselines.ts:319-327` (`focusedExpectedArguments`, the `mixed-61`/`2000x2700` branch); `scripts/profile-mixed61.mjs:41-43`; artifact `result.focusedCompleteReconstructionTrace.status`/`.consumedCandidateEvaluations` |
| Focused source/selected hash = collision hash | equal, both `3839e80d…` | `scripts/irregular-compact-nine-baselines.ts:321,325` (`source: mixedHash, selected: mixedHash`, `candidate: 'none'`); `scripts/profile-mixed61.mjs:44-49` (also pins `--expected-focused-candidate-hash none` — the characterization doc's summary omits this exact `'none'` sentinel, recorded here as the precise value) |
| Focused influence | `protected-fallback` | `scripts/irregular-compact-nine-baselines.ts:326`; `scripts/profile-mixed61.mjs:50`; artifact `result.focusedCompleteReconstructionTrace.outputInfluence` |

Two additional facts, confirmed this pass, that the prompt's own §18.6
summary omits and a Rust differential harness must still reproduce exactly:

- Compact Short Side is **not** cavity-free for Mixed-61: `scripts/irregular-compact-nine-baselines.ts:54` pins `shortSideMaximumCanonicalCavities: 1` for Mixed-61 `2000x2700` (and its own distinct hashes: `shortSideCollisionIdentitySha256: 'c38a0cb4bb7765e4db102869224ef5b51f2a0bbc787cea05adf94ca0e2fe5e22'`, `shortSideFittedCanonicalSha256: '2a63c729108ba7680339cebaf86d4e39368a020eee95580caf9811d6d2bbc2ca'`, `shortSidePlacedCount: 61`, `shortSideUnplacedCount: 0`, lines 56-61). A Rust port must not treat "zero cavities" as a Short Side sanity invariant.
- None of the seven §18.6 values is pinned by any `tests/unit/*.test.ts` vitest spec — only by the gate *scripts*. Confirmed by `grep -rlE "3839e80d|ef2b783a" tests/unit/*.test.ts` (no hits). A Rust CI pipeline that runs only `pnpm test` would never catch a Mixed-61 regression; §3 below lists the four promoted gate scripts as separate, mandatory Rust-CI steps.

---

## 3. Cross-cutting test/gate infrastructure (applies to every subsystem below)

Full detail: `characterization/tests-gates-inventory.md`. Summary, re-verified against `package.json` this pass:

| Gate | Invocation (`package.json`) | CI-authoritative? | Serial? |
| --- | --- | --- | --- |
| `pnpm test` / `pnpm test:focused` | `package.json:26-27` | Yes | Vitest isolates files into workers by default; no file opts into `.concurrent` |
| `pnpm gate:mixed61-compact` | `package.json:32` → `scripts/irregular-sheet-invariance.ts` | Yes | Yes — one sequential run |
| `pnpm gate:compact-nine-baselines` | `package.json:33` → `scripts/irregular-compact-nine-baselines.ts` → 18 sequential `pnpm exec tsx` **subprocesses** | Yes | Yes |
| `pnpm gate:capacity[:production]` | `package.json:34-35` → `scripts/irregular-capacity-gate.ts` | Yes | Yes — in-process, sequential fixture loop |
| `pnpm profile:mixed61` | `package.json:30` | Not a correctness gate, but re-asserts the Mixed-61 pins (§2) and fails nonzero before profiling if parity breaks | Yes |

A Rust CI pipeline must run all five as distinct steps; `pnpm test` alone is
insufficient (§2). All five are currently strictly single-process/serial —
none exercises concurrent `computeIrregularNesting` invocations, so none
constrains multithreaded Rust behavior; that is exclusively the concern of
the concurrency-determinism tests (§1 column d) this document adds.

---

## 4. Subsystem S1 — Worker coordination and N-API boundary

Owning doc: `characterization/worker-coordination.md`. TS files:
`src/workers/nesting.worker.ts`, `src/workers/algorithm/irregular/computeIrregularNesting.ts` (coordinator shell), `src/workers/algorithm/irregular/irregularWorkerOutput.ts`, `src/main/services/WorkerSupervisor.ts` (not read in full by the cluster doc but the coarse RPC/IPC boundary this subsystem terminates at).

### (a) Existing tests/gates

- `tests/unit/irregularWorkerCompute.test.ts` (307 lines) — direct test of `computeIrregularNesting`/`makeIrregularWorkerOutput`: quarter-turn resolution/rejection (`:128-164`), `IrregularComputeError` on missing source geometry (`:175-187`), `-copy-N` id fallback, decision-trace-gated-by-history-mode (`:206-227`, exercises the **non-archive** legacy path only), transform/history-frame shape (`:229-281`), history-off suppression (`:283-306`).
- `tests/unit/workerProtocol.test.ts` (251 lines) — schema round-trip for `WorkerRequest`/`WorkerResponse`/`RunNestingPayload`/`NestingHistorySummary`; does not exercise `nesting.worker.ts` itself.
- `tests/unit/algorithm.test.ts:107-118` — `sortPiecesForNesting` pass-through/empty-array only (coverage gap, cross-referenced in S9).
- **No test spawns the actual `nesting.worker.ts` worker thread or drives it through `WorkerSupervisor`** — confirmed by `grep -rln "WorkerSupervisor|nesting.worker.mjs|runNesting(" tests/` returning only `algorithm.test.ts`'s unrelated local helper. The RPC-server progress-event sequence is exercised only by manual packaged-app use.
- Every four-gate family in §3 transitively exercises this subsystem end-to-end (it is the coordinator every gate script calls into) but does not test worker-thread RPC specifically, since gate scripts call `computeIrregularNesting` in-process, bypassing `nesting.worker.ts`.

### (b) Planned NEW Rust unit tests

- **"boundary conversion"** — round-trip a trusted `NestingRequest`-shaped Rust DTO through the coarse N-API entry point (prompt §7's "one Compact execution entry point" / "one Compact Short Side execution entry point"); assert every field the current worker forwards into `computeIrregularNesting`'s options object is preserved, including the "genuinely absent vs. present-with-`undefined`" optional-field distinction documented cluster-wide (S5-S17 all touch this; this subsystem is the single funnel point).
- **"panic containment"** — inject a deliberate `panic!` inside the outer native job boundary and assert it is caught, sanitized, and mapped to `unknown_error` with stable operation/backend context (prompt §16), never an unwinding panic reaching the N-API caller (prompt §7).
- **"cancellation cleanup"** — abandon/cancel a job mid-flight at each of the observation points S6/S15/S13 document and assert no leaked native job, no leaked cache, no partial result surfaces (prompt §15/§17).

### (c) Planned differential tests

- **"complete result object"** — full `IrregularComputeResult` equality (minus the explicitly-excluded non-semantic diagnostic channel, prompt §7/§17) between TS and one-thread Rust for every maintained fixture (Triangle-20, Shapes-17, Mixed-61, the 8 capacity fixtures) at every gated sheet.
- **"protocol-visible progress event count, phase sequence, order, completed and total work, best-score payloads, and optional-field presence"** — since no existing test spawns the real worker thread (a), this is **wholly new coverage** for the Rust port; it must reproduce the current `nesting.worker.ts` progress-emission sequence exactly (excluding only timestamp/elapsed fields).
- **"error category and stable context"** / **"cancellation category"** — see S2's dedicated coverage; cross-referenced here because this subsystem is where the TS→native error mapping table (prompt §16) is applied.

### (d) Planned concurrency determinism tests

This subsystem is the **outer** boundary; per prompt §6 Stage 1 it must never call JS from Rayon workers and never cross N-API per candidate/NFP/checkpoint. Concurrency-determinism tests here are top-level: run the full Mixed-61/Triangle-20/Shapes-17/capacity-fixture suite at 1, 2, default, and a higher fixed thread count (prompt §18.4) through **this** entry point and assert byte-identical `IrregularComputeResult` at every count — this is the outermost instance of the pattern each inner subsystem also tests locally (S6, S9, S12, S15).

### (e) Planned property/fuzz targets

- **"arbitrary thread counts producing the same result"** — the outermost instance of this target; fuzzes thread-count selection (not request content) across the maintained fixture corpus.

---

## 5. Subsystem S2 — Errors and protocol mapping

Owning doc: `characterization/errors-protocol.md`. TS files: `src/shared/protocol/errors.ts`, `src/workers/nesting.worker.ts` (the private, unexported `toIrregularWorkerFailure`), `src/shared/protocol/worker.ts`.

### (a) Existing tests/gates

- `tests/unit/workerProtocol.test.ts:224-240` — schema round-trip for one `'failure'` response shape (`irregular_source_geometry_missing` + context), **does not exercise `toIrregularWorkerFailure` itself** (private, unexported — grep-confirmed no `export` at `nesting.worker.ts:403`).
- `tests/unit/irregularWorkerCompute.test.ts:175-188` — asserts the **internal** typed error (`instanceof IrregularComputeError`, `._tag === 'IrregularComputeError'`), not the external `AppErrorCode` mapping.
- **No dedicated test file exists for `nesting.worker.ts` or `WorkerSupervisor.ts`** — confirmed by `find` across the repo. The prompt §16 mapping table (9 rows) is **not directly unit-tested anywhere in the existing suite**. This is the single largest testing gap flagged across the entire corpus for this subsystem: the Rust port's differential harness carries essentially the full parity burden here (see §15).
- No `scripts/*.ts` gate references `AppErrorCode`/`WorkerResponseFailureError`/`toIrregularWorkerFailure` (grep-confirmed).
- Indirect coverage exists per-error-class in each owning cluster's own tests (e.g. `tests/unit/nfpIfpService.test.ts:1412,1429` exercises `IrregularGeometryInfeasibleError` directly) but never through the external mapping boundary.

### (b) Planned NEW Rust unit tests

- **"boundary conversion"** — construct every one of the prompt §16 table's 9 rows' concrete TS-side error condition (or its Rust-equivalent typed error enum variant) and assert the mapped `AppErrorCode`, required context fields (`preparedPieceId`/`sourcePieceId`, `operation`, `service`, category, native API version, sanitized operation/backend identity) exactly as tabulated in the prompt.
- **"panic containment"** — a contained panic must map to `unknown_error` with sanitized operation/backend context, never expose raw panic payload/backtrace by default (prompt §16 last row).

### (c) Planned differential tests

- **"error category and stable context"** — for every one of the 9 mapping-table rows, run the TS condition and the equivalent Rust condition and assert identical `{code, context}` shape (this is **new** coverage per (a) above, not a port of an existing test).
- **"cancellation category"** — `IrregularNfpIfpControlAbortError` with reason `cancelled` → `worker_cancelled`; reason `deadline` → `worker_timeout`; both with `reason` context preserved exactly (prompt §16 rows 6-7).

### (d) Planned concurrency determinism tests

N/A as an independent Rayon boundary (error construction is not itself parallelized); covered as part of S1's outer-boundary concurrency tests — errors raised from within parallel work must still resolve to the same mapped code/context regardless of thread count or which worker raised first.

### (e) Planned property/fuzz targets

- Fuzz malformed/edge-case native responses and N-API protocol-version mismatches and assert they always resolve to `worker_protocol_error` with native API version + stable operation, never leak secrets (prompt §16 row 8).

---

## 6. Subsystem S3 — Effect service boundary and GeometryKernel wiring

Owning doc: `characterization/effect-boundary.md`. TS files: `src/workers/irregular/geometryKernel.ts` (+ `core/`), `src/workers/irregular/infrastructure.ts`, `src/workers/irregular/services.ts` (Context.Tag declarations).

### (a) Existing tests/gates

- `tests/unit/irregularGeometryKernel.test.ts` (475 lines) — every one of `GeometryKernel`'s 5 operations: flattening-tolerance threading (`:135-159`), `.Unimplemented` independence (`:161-174`), convex-hull CCW/order-independence/near-collinear retention (`:176-220`), offset-distance formula + two failure modes with exact message text (`:222-311`), `transformCollisionGeometry` rotation/mirror/degenerate behavior (`:313-473`).
- `tests/unit/irregularGeometryCache.test.ts` (547 lines) — cross-service cache coherence with exact telemetry counter assertions per namespace (own primary subject is S5, exercised here as a wiring/composition proof).
- `tests/unit/irregularInfrastructure.test.ts` (14 lines) — the **sole** consumer of `infrastructure.ts` anywhere in the repo; proves nothing about production behavior since production never uses this layer (dead-code-but-tested, per prompt §3 immutability).
- `tests/unit/trustedGeometryCarrierBoundary.test.ts` (337 lines) and `tests/unit/pureIrregularCoreBoundary.test.ts` (128 lines) — architectural-purity lint tests (plain-class/schema split, Effect-free `core/*`), not algorithm-hash relevant but must still pass in a Rust-differential CI.

### (b) Planned NEW Rust unit tests

- **"boundary conversion"** — the schema-decoded → plain trusted domain class conversion this layer owns; assert the Rust equivalent (module-boundary conversion, not an Effect service) preserves the same optional-field-present-vs-absent distinctions (S1/S5 recurring theme).
- **"panic containment"** — this is the seam where a native-side "layer composition" failure would surface; assert construction failures map cleanly rather than panicking through.

### (c) Planned differential tests

This subsystem has no *direct* semantic output of its own (it is composition/wiring); its differential burden is carried entirely by the subsystems it wires (S4, S5, S6, S7) — no separate row needed beyond confirming the Rust module boundary produces the same composed behavior end-to-end (covered by S1's "complete result object" test).

### (d) Planned concurrency determinism tests

N/A — this is composition-time wiring, not per-request mutable state. The Rust equivalent (explicit ownership/dependency-injection via constructor parameters, not an Effect layer) has no concurrency-determinism surface of its own.

### (e) Planned property/fuzz targets

None specific to this subsystem beyond what S4/S5/S6/S7 already cover through it.

---

## 7. Subsystem S4 — Collision geometry preparation

Owning doc: `characterization/collision-prep.md`. TS files: `collisionGeometryBuilder.ts`, `transformGenerator.ts`, `arcFlattening.ts`, `ellipseFlattening.ts`, `clipper2OffsetAdapter.ts`, `clipper2OffsetPolicy.ts`, `convexPolygonOffset.ts`.

### (a) Existing tests/gates

- `tests/unit/collisionGeometryBuilder.test.ts` — `buildPiece`/`buildPieces`, full-circle closing-point dedup, two independently-verified worked padded-offset numeric examples, diagnostics propagation, open-path rejection.
- `tests/unit/transformGenerator.test.ts` — the largest test file for this cluster: orthogonal baseline, mirror-cap interaction, transform-profile presets, adaptive Compact scale-invariance across `0.1x/1x/10x` (`:284-313`), large-radius distinctness (`:315-332`), placement-reference translation invariance (`:334-350`), fanout-capped longer-edge selection (`:375-410`), circular zero-seam dedup (`:412-422`), periodic configured-angle normalization (`:424-434`), cyclic-rotation input-order invariance (`:443-448`).
- `tests/unit/clipper2OffsetAdapter.test.ts` — `CLIPPER2_OFFSET_POLICY` full-object pin, `toGridMm`/`fromGrid` rounding pin, conservative-allowance bound proof, CCW normalization for both windings, miter-join sharp-corner exactness, headroom/coordinate-guard rejection, quantization-collapse rejection.
- `tests/unit/dxfSourceFlattening.test.ts` — the **only** test exercising `ArcFlattening`/`EllipseFlattening`, and only indirectly through a real DXF import; **no test directly unit-tests either flattening module by name** (grep-confirmed).
- Production gates transitively depending on byte-identical output: `gate:mixed61-compact`, `gate:compact-nine-baselines`, `gate:capacity[:production]` (§3) — any drift in this cluster's trig/rounding/transform ordering changes placement geometry and breaks these.

### (b) Planned NEW Rust unit tests

- **"exact area and cross-products"** — this cluster's `clipper2OffsetPolicy.ts`'s `toGridMm`/`fromGrid` conversion is the shared dependency used pervasively across the whole pipeline (S5-S15); a dedicated Rust unit suite must pin its rounding rule (round-half-away-from-zero on magnitude, sign reapplied) independent of any single caller.
- **"signed zero"** — `toGridMm(-0)` returns `-0` in JS (`Math.sign(-0) === -0`); assert the Rust port's chosen `f64`→grid-int path either preserves or provably-collapses this identically downstream (the characterization doc found it is masked by `String(-0) === '0'` at every string-key call site — a Rust port must confirm the same masking, not merely assume it).
- **"NaN and infinity rejection"** — `toGridMm` rejects non-finite input via `Number.isFinite` before scaling.
- **"transform cache order"** — `transformCandidateOrder`'s exact multi-key `Order.combineAll` chain (index, rotationDeg, mirrored, reason) must be reproduced as an explicit Rust comparator, not an incidental `Vec` order.
- Vendor-translated Clipper2: per the orchestrator decision, the Rust port vendor-translates the used subset of `clipper2-ts@2.0.1-18` rather than binding a different-version C++ Clipper2. New Rust unit tests must pin `inflatePaths`' exact miter-join/quantization-collapse/coordinate-guard behavior against the same fixtures `clipper2OffsetAdapter.test.ts` uses, as differential vectors against the vendored TS source (not merely against a generic Clipper2 spec).

### (c) Planned differential tests

- **"transforms and coordinates"** — for every prepared piece across every maintained fixture, assert the Rust-generated transform candidate set (index/rotationDeg/mirrored/reason, in order) and every collision-polygon coordinate are byte-identical to TS.
- **"canonical collision identity"** — this cluster's output is the direct geometric input to S8's identity hash; any divergence here is caught transitively by S8's differential test, but a dedicated per-piece coordinate diff (before hashing) localizes failures faster.

### (d) Planned concurrency determinism tests

Per prompt §14.1, "independent collision-geometry preparation by stable piece index" and "independent transform materialization by stable piece and transform index" are named **good Rayon candidates**. Concurrency tests: run the full per-piece collision-geometry-build + transform-generation batch at 1/2/default/higher thread counts and assert (a) byte-identical output vector regardless of count, (b) stable ordinal-indexed reduction (not first-completed-wins).

### (e) Planned property/fuzz targets

- **"integer overflow boundaries"** — fuzz mm-scale coordinates near the `Number.isSafeInteger` boundary (~9,007,199,254 mm at scale 1000) through `toGridMm`/its Rust equivalent and assert identical accept/reject behavior.
- **"TypeScript versus Rust canonical-grid comparisons"** — property-test that for a wide sample of source polygons, TS's and Rust's padded/offset/transformed collision polygons agree exactly at the grid-integer level (not merely "close").

---

## 8. Subsystem S5 — Geometry caches (NFP / transform namespaces + telemetry)

Owning doc: `characterization/geometry-caches.md`. TS files: `nfpCacheKey.ts`, `geometryCacheIdentity.ts`, `geometryCacheStore.ts`, `geometryCacheKeys.ts`, `geometryCacheStoreLive.ts`, `nfpIfpTelemetry.ts`.

### (a) Existing tests/gates

- `tests/unit/nfpBoundaryCore.test.ts` (220 lines) — exact cache-key JSON bytes, exact miss/hit/stale/clear action-log ordering, no-cache-on-invalid-input, no-store-on-relative-construction-overflow.
- `tests/unit/ifpTransformCore.test.ts` (282 lines) — exact action-log ordering for `resolveTransformedCollisionGeometry`/`resolveIfpBounds`, hit results are the *identical object reference* (plain-object, not domain-class-wrapped).
- `tests/unit/pureIfpTransformContract.test.ts` (410 lines) — Effect-layer equivalent, pins two golden cache-key byte strings, proves construction-inertness of the returned Effect (no cache action until run).
- `tests/unit/nfpBoundaryTrustedRings.test.ts` (225 lines) — trusted-ring identity-memo contract: repeat-resolution identity, persistent invalid-input rejection, revalidation after in-place mutation in both directions.
- `tests/unit/ringFingerprintAccessPath.test.ts` (156 lines) — index-vs-iterator access-path equivalence for the fingerprint guard.
- `tests/unit/irregularGeometryCache.test.ts` (546 lines) — highest-level integration: all three namespaces simultaneously, telemetry-namespace counters tied to exact call sequences, transform-key separation by transform index, relative-NFP sharing across canonically-equivalent copies, cache-miss-on-any-input-change, stale-boundary eviction.
- `tests/unit/nfpIfpTelemetry.test.ts` (120 lines) — telemetry module in isolation (disabled-is-inert, reset-on-enable).
- `scripts/irregular-sheet-invariance.ts` (backing `gate:mixed61-compact`) optionally captures telemetry via `--capture-cache-telemetry` but does not gate on it — telemetry is confirmed non-semantic per prompt §13.7.

### (b) Planned NEW Rust unit tests

- **"stale cache removal"** — reproduce the exact miss/hit/stale/clear action-log sequence `nfpBoundaryCore.test.ts` pins, at the Rust cache-primitive level.
- **"invalid-value non-publication"** — a failed/invalid computation must never be published as a cache hit (prompt §13.1); test with deliberately-failing geometry inputs.
- **"transform cache order"** — transform-key separation by transform index must be preserved exactly (this cluster's specific instance of S4's transform-order requirement).
- **"cache cleanup"** — job-scoped cache lifetime: assert all cache state is released at job completion/cancellation with no leak across repeated jobs (prompt §13.6).
- **"canonical key bytes"** — the exact cache-key JSON byte strings `nfpBoundaryCore.test.ts`/`pureIfpTransformContract.test.ts` pin must be reproduced byte-for-byte by the Rust key builder.

### (c) Planned differential tests

- **"canonical keys"** — cache-key construction for the pairwise-NFP and transform-collision namespaces, byte-identical to TS for the same inputs.
- Cache-observable output equality: assert a Rust cache hit and a Rust recomputation return the same canonical immutable value (prompt §13.1), differentially checked against the single TS value for the same input.

### (d) Planned concurrency determinism tests

This is the **primary subject of prompt §13** ("design caches before parallelizing"). Required before any broad Rayon rollout:
- Evaluate and benchmark the five architectures prompt §13.3 lists (sharded shared cache; shared + per-thread front caches; per-key single-flight; phase-local precomputation; hybrid-by-namespace) with the Mixed-61 cache-statistics baseline (`baseline-evidence.md`: 266,977 lookups, 262,166 hits, 4,811 stores, ~98.2% hit rate) as the reuse target to preserve.
- Concurrency-determinism tests: run the full Mixed-61 fixture at 1/2/default/higher thread counts and assert (a) identical NFP/IFP/transform values regardless of insertion race order (prompt §13.1 "cache insertion race order never changes output"), (b) no deadlocks under contention, (c) cancellation cleans up single-flight waiters (prompt §18.4).
- Explicitly test that "front-cache hits"/"backing-cache hits"/"duplicate computations"/"single-flight waits" telemetry (prompt §13.7) never feeds back into control flow, matched against a control run with telemetry disabled.

### (e) Planned property/fuzz targets

- **"NFP cached versus uncached equality"** — property test: for a wide sample of piece-pair/transform inputs, a fresh (uncached) computation and a cache-hit-returned value are byte-identical.
- **"cache single-flight equivalence"** — under simulated concurrent misses on the same key, all waiters receive the same validated immutable result; no waiter observes a different value.

---

## 9. Subsystem S6 — NFP/IFP construction and candidate generation

Owning doc: `characterization/nfp-ifp.md`. TS files: `nfpIfpService.ts`, `core/nfpBoundaryCore.ts`, `core/ifpBoundsCore.ts`, `core/transformCollisionGeometryCore.ts`.

### (a) Existing tests/gates

- `tests/unit/nfpIfpService.test.ts` (2,311 lines, second-largest test file) — the primary differential/behavior suite: provenance accounting, canonical-grid ordering, ring canonicalization, IFP/NFP computation and translation, NFP-cache-by-algorithm separation, laziness of the public Effect API until execution, exact checkpoint/cache sequencing for pure NFP and IFP cores, construction-algorithm parity (reference vs. linear), indexed-vs-reference candidate-pruning parity, IFP infeasibility/invalidity/staleness, contact-only/sheetless seeding, legal-candidate memo hit/miss/provenance-miss/abort semantics, point combination/dedup, segment-intersection numeric fallback paths, sheetless/spatial-index-backed candidate parity.
- `tests/unit/geometryBackendParity.test.ts` (422 lines) — **an existing internal parity precedent**: differential comparison between `'vertex-pair-hull'` (production) and `'linear-edge-merge'` (non-production) NFP construction, and `'indexed'` vs `'reference'` candidate pruning — directly relevant methodology precedent for the Rust/TS differential harness.
- The two golden tests (`irregularSeventeenShapesCompactGolden.test.ts`, `irregularTriangleCompactGolden.test.ts`) are the highest-value end-to-end parity gates: a wrong candidate point, wrong cache-sharing decision, or wrong grid-snap tie-break changes the selected layout hash, not just an intermediate value.
- No dedicated `scripts/` gate beyond the general test-suite invocation (grep-confirmed no matches under `scripts/` for `nfpIfpService`/`NfpIfpService`/`generatePlacementCandidates`).

### (b) Planned NEW Rust unit tests

- **"NFP and IFP validation order"** — reproduce the exact validate→key→lookup→validate-cached-value→stale-eviction→recompute→validate→publish sequence per prompt §13.2, at the Rust module boundary.
- **"candidate legality"** — grid-snap-then-exact-convex-overlap-check ordering for every candidate point (delegates to S7's `placementValidation` but must be tested here at the candidate-generation call site too, since S6 decides "keep the first grid-legal alternative per raw point").
- **"exact area and cross-products"** / **"exact comparisons"** — segment-intersection numeric fallback paths (currently pinned at `nfpIfpService.test.ts:1955-2057`).

### (c) Planned differential tests

- **"canonical keys"** — NFP/IFP cache keys (delegates to S5, exercised here at the point of construction).
- Candidate-point-set equality: for every maintained fixture's every (fixed piece, moving piece, transform) triple encountered during a full run, assert the ordered candidate point set (post grid-snap, post dedup) is byte-identical between TS and Rust — this is the single highest-leverage differential test in the corpus, since S9-S17's search behavior is entirely downstream of this set.

### (d) Planned concurrency determinism tests

Prompt §14.1 names "independent pairwise relative NFP computations after key deduplication" and "independent IFP calculations for fixed known inputs" as **good Rayon candidates**. Tests: batch all distinct (piece-pair, transform) NFP computations and all distinct IFP computations needed for one search step, assign stable ordinals, compute in parallel, reduce by ordinal, and assert byte-identical results at 1/2/default/higher thread counts. Must preserve the exact historical cache-access sequence per subsystem S5's concurrency tests — a parallel design that changes *when* a lookup occurs relative to a cancellation/deadline checkpoint is invalid per prompt §13.2.

### (e) Planned property/fuzz targets

- **"NFP cached versus uncached equality"** (primary owner; S5 references this from the cache-primitive angle, this subsystem owns the algorithmic-equality angle).
- **"candidate legality near touching boundaries"** — fuzz near-touching/near-collinear configurations through the full candidate-generation → legality-check pipeline and assert identical accept/reject at exact boundaries (delegates to S7 for the predicate itself, tests the end-to-end candidate pipeline here).

---

## 10. Subsystem S7 — Validation and spatial index

Owning doc: `characterization/validation-spatial.md`. TS files: `placementValidation.ts`, `placedCollisionSpatialIndex.ts`, `geometryPredicates.ts`, `convexSatPenetration.ts` (dead), `convexPolygonValidation.ts`, `convexBounds.ts`, `convexHull.ts`, `core/convexHullCore.ts`.

### (a) Existing tests/gates

- `tests/unit/placementValidation.test.ts` (304 lines) — `check`/`validate`, pure-failure-provenance path, edge/vertex touching legality, positive-overlap rejection (diamond-inscribed-in-square, rotated-boundary-contact), sheet-bounds rejection.
- `tests/unit/placedCollisionSpatialIndex.test.ts` (169 lines) — broad-phase bucket filtering with boundary-touching survival, structural-sharing proof under `add`, conservative fallback-set retention for invalid placed geometry, **direct differential parity check between the indexed and brute-force `assessPlacement` paths** — an existing internal precedent directly analogous to the TS/Rust differential methodology.
- `tests/unit/geometryPredicates.test.ts` (28 lines) — DXF y-up sign convention for all three turn outcomes, plus one case pinning that the *robust* predicate correctly resolves a naive-double-subtraction-rounds-to-zero determinant (`Number.EPSILON`-scale points) — a direct exactness proof for the `robust-predicates` dependency this cluster relies on.
- `tests/unit/convexPolygonValidationTopology.test.ts` (396 lines) — **the single most rigorous test in this cluster**: re-implements the pre-optimization quadratic oracle in the test file and asserts exact object equality (including message text) against the guarded linear fast path across >6,500 generated cases, with explicit minimum-count assertions per outcome category.
- `tests/unit/convexBounds.test.ts` (47 lines), `tests/unit/convexPolygonValidation.test.ts` (51 lines), `tests/unit/convexSatPenetration.test.ts` (38 lines, dead-code coverage but immutable per prompt §3).
- **No test file imports `convexHull.js`/`core/convexHullCore.js` by name** — coverage is entirely indirect via `irregularGeometryKernel.test.ts`, `nfpIfpService.test.ts`, `geometryBackendParity.test.ts`. Flagged as a genuine coverage gap in the source doc.
- No test constructs an entry/query whose grid-cell fan-out exceeds `MAX_GRID_CELLS_PER_ENTRY`/`MAX_GRID_CELLS_PER_QUERY` (`= 4096` each) to confirm the conservative-fallback path is reached.

### (b) Planned NEW Rust unit tests

- **"exact comparisons"** — `orientation`'s robust-predicate wrapping (via a Rust equivalent of `robust-predicates`' `orient2d`, sign-inverted for y-up) must resolve the same near-zero-determinant case `geometryPredicates.test.ts` pins.
- **"candidate legality"** — port `convexPolygonValidationTopology.test.ts`'s >6,500-case differential oracle as a Rust unit/property test directly (it is already structured as an oracle-vs-optimized-path comparison, the closest existing precedent to a Rust differential test in the whole corpus).
- New direct unit tests for `compute_convex_hull` (degenerate ≤2-point input, collinear-input collapse to two points, known-shape hull vertex/winding checks) — closing the coverage gap identified in (a); the migration prompt requires porting this code with full correctness regardless of current indirect-only coverage.
- New boundary test for the `4096`-grid-cell-fan-out conservative-fallback path — closing the coverage gap identified in (a).

### (c) Planned differential tests

- **"candidate legality"** — for every candidate point reaching `assessPlacement` across every maintained fixture, assert identical accept/reject and identical indexed-vs-brute-force agreement (mirrors `placedCollisionSpatialIndex.test.ts`'s existing internal precedent, now cross-language).

### (d) Planned concurrency determinism tests

Prompt §14.1 names "read-only spatial-index queries for an immutable state" as a **good Rayon candidate**. Tests: run concurrent read-only legality queries against one immutable placed-collision spatial-index snapshot at 1/2/default/higher thread counts and assert identical results; prompt §14.2 flags "mutable spatial-index updates" as **high-risk/serial-only** — index *construction* (incremental `add`) must remain logically serial, only *queries* against a completed snapshot are parallelizable.

### (e) Planned property/fuzz targets

- **"candidate legality near touching boundaries"** (primary owner) — fuzz near-touching/near-collinear/near-zero-determinant point configurations through `orientation`/`validateStrictBoundary`/`assessPlacement` and assert exact TS/Rust agreement, extending `convexPolygonValidationTopology.test.ts`'s existing generator strategy (perturbed convex rings, star families, pinch/touch cases) into a cross-language property test.

---

## 11. Subsystem S8 — Canonical grid exact arithmetic and canonical layout geometry

Owning doc: `characterization/canonical-grid.md`. TS files: `canonicalLayoutGeometry.ts`, `canonicalGridMath.ts`, `canonicalGridContact.ts`, `convexPolygonContact.ts`, `freeMaterialService.ts`.

### (a) Existing tests/gates

- `tests/unit/canonicalGridMath.test.ts` (179 lines) — `CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT`, `canonicalGridCrossSign`'s fast-path/fallback agreement including at `Number.MAX_SAFE_INTEGER`, `canonicalGridConvexHull`/`canonicalGridAbsoluteDoubledArea` invariance under large-grid translation, `compareCanonicalGridRatios`.
- `tests/unit/canonicalGridContact.test.ts` (89 lines) — `measureCanonicalGridBoundaryOverlapAxisUnits`'s axis-aligned-measured / diagonal-undecidable / checkpoint-aborted behavior — **directly confirms prompt §12's contract**: "diagonal and axis-aligned contacts both contribute to positive-contact count; only axis-aligned overlap contributes to projected-length tie-breaking."
- `tests/unit/canonicalLayoutGeometry.test.ts` (312 lines, 9 `it` blocks) — `placedCollisionWorldGridPath` rounding, `canonicalCollisionLayoutIdentity`'s translation/quarter-turn/copy-order/ring-origin/winding invariance and reflection/relative-placement sensitivity, `assertCanonicalGridLegalLayout`, `analyzeCanonicalLayoutStructure`, `measureCanonicalLayoutContacts` at "high-coordinate" magnitudes.
- `tests/unit/freeMaterialService.test.ts` (415 lines) — no-placement whole-sheet, single-hole region, border-touching, exact-point contact, deterministic hole ordering, mirrored-winding canonicalization, full-coverage empty-result, malformed-geometry typed error, union-failure typed error; plus the confirmed-dead-for-production `extendFreeMaterial`/`'direct-difference'` paths (still immutable per prompt §3).
- **No dedicated test file for `convexPolygonContact.ts`** — indirect only.
- `gate:mixed61-compact` is a **direct end-to-end byte-parity gate** for this cluster's most consequential output (`canonicalCollisionLayoutIdentity` → the fitted canonical SHA-256).

### (b) Planned NEW Rust unit tests

- **"canonical-grid rounding"** — the shared `toGridMm`/`fromGrid` conversion (also S4's dependency).
- **"exact area and cross-products"** — `canonicalGridCrossSign`'s fast-path (fits in `f64` exactly) vs. fallback (exact-integer) agreement, including at `Number.MAX_SAFE_INTEGER`; `compareCanonicalGridRatios`'s cross-multiplication.
- **"signed zero"** — the unguarded `Number` subtraction in `identityAtQuarterTurn`'s translation step (`x - minX`/`y - minY`) has no safe-integer check in TS; the Rust port must reproduce the same unguarded `f64` subtraction, not "fix" it with a checked path (source doc explicit finding — the TS original itself has this latent imprecision and must be reproduced, not corrected).
- **"canonical key bytes"** — `canonicalCollisionLayoutIdentity`'s ring-origin normalization, winding normalization, quarter-turn equivalence, translation behavior, all reproduced byte-for-byte; also `canonicalRingKey`/`canonicalToken`'s length-prefixed-token format (`"${v.length}:${v}"`, no separators, `canonicalNumber`'s signed-zero/NaN/Infinity normalization via `String(value)`).
- **"diagonal contact count"** / **"axis-only projected overlap"** — `hasPositiveCanonicalGridBoundaryContact` (any collinear direction counts) vs. `measureCanonicalGridBoundaryOverlapAxisUnits` (explicitly `'undecidable'` on positive diagonal contact) as two independently-tested Rust functions, matching `canonicalGridContact.test.ts`'s existing split.
- Test that `canonicalGridPointOnSegment` (`canonicalGridMath.ts:173-186`) — confirmed to have **zero production callers anywhere in `src/`** — is either faithfully ported as unreachable or explicitly ruled droppable; do not silently omit without the orchestrator ruling the prompt requires for dead code.

### (c) Planned differential tests

- **"canonical collision identity"** and **"fitted canonical identity"** — the two headline Mixed-61 hashes (§2); for every maintained fixture assert byte-identical SHA-256 between TS and Rust.
- **"canonical keys"** — ring/winding/quarter-turn-equivalence classes: for a battery of transform/translation/reflection variants of each fixture's geometry, assert TS and Rust agree on which variants hash identically and which do not.

### (d) Planned concurrency determinism tests

Prompt §14.1 names "independent final metric components with exact serial reduction" as a candidate; canonical-identity computation for one completed layout is itself a single serial computation per layout, but **independent layouts' canonical-identity computations** (e.g. multiple candidate endpoints in one search batch) are parallelizable with stable-ordinal reduction. Test at 1/2/default/higher thread counts.

### (e) Planned property/fuzz targets

- **"canonical key equivalence"** and **"ring-origin and winding invariance"** (primary owner of both) — property-fuzz ring rotations, winding reversals, quarter-turn transforms, and translations of the same logical layout and assert the canonical identity is invariant exactly where TS says it must be and sensitive exactly where TS says it must be (reflection/relative-placement sensitivity, per `canonicalLayoutGeometry.test.ts`).
- **"TypeScript versus Rust canonical-grid comparisons"** (primary owner) — the direct cross-language instance of this prompt §18.5 item.
- **"integer overflow boundaries"** — `compareCanonicalGridRatios`'s cross-multiplied magnitudes approach `i128::MAX` at the practical coordinate bound identified in the source doc; fuzz near that boundary.

---

## 12. Subsystem S9 — Search and scoring (placement/layout scorers, prepared-order sort, beam state)

Owning doc: `characterization/search-scoring.md`. TS files: `irregularBeamState.ts`, `irregularPlacementScorer.ts`, `irregularLayoutScorer.ts`, `irregularScoreGrid.ts`, `sortPiecesForNesting.ts`.

### (a) Existing tests/gates

- `tests/unit/algorithm.test.ts:107-117` — `sortPiecesForNesting`: only pass-through-of-equal-priority and empty-array cases. **Does not test the actual descending longestEdge/area/imbalance ordering or any real tie-break** — a confirmed coverage gap.
- `tests/unit/irregularPlacementScorer.test.ts` (469 lines, 16 `it` blocks) — balanced/short-side-fill/edge-contact policies, square-sheet override, translation-equivalent ties, exact transform/pieceId tie-break resolution, typed-error path for mismatched candidate metadata, grid canonicalization of translated scores. Confirmed **dead for production Compact/Compact Short Side** (S12/S17 select via different scorers) but authoritative and immutable per prompt §3.
- `tests/unit/irregularLayoutScorer.test.ts` (1,156 lines, largest in this cluster, 31 `it` blocks) — translation-invariant anchoring, unplaced-count dominance, compaction-vs-free-material tie order, structural-contact band transitions at `STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT` (20), exact-tie determinism, free-material cache hit/reuse/extend/fallback (`:841-995`), canonical-key/grid-identity equivalence for `IrregularBeamState` (`:996-1155`).
- `tests/unit/canonicalCollisionPolygonKeyEquivalence.test.ts` (237 lines) — dedicated ring-origin/winding-normalization equivalence-class tests; primary source of truth for exact canonical-key equivalence.
- **Coverage gap**: no dedicated `irregularScoreGrid.test.ts`; the grid-rounding functions (`canonicalizeIrregularScoreMillimeters`/etc.) are exercised only incidentally through downstream score assertions, never at the grid-rounding function boundary with adversarial inputs (exact `0.0005mm` half-way boundary, near-`Number.MAX_SAFE_INTEGER/1000`, `-0` input).

### (b) Planned NEW Rust unit tests

- **"stable sorting"** — `sortPiecesForNesting`'s actual descending longestEdge/area/imbalance comparator with genuinely-differing and genuinely-tied inputs, closing the coverage gap in (a) with a **new TS characterization test first** (per this document's recommendation and prompt §18 TDD requirement), then the Rust equivalent.
- **"canonical-grid rounding"** / **"signed zero"** / **"exact comparisons"** — dedicated `irregularScoreGrid`-boundary tests for `canonicalizeIrregularScoreMillimeters`/`...MillimeterUnits`/`...Scalar`, covering the `-0.0005mm` half-way tie, the `-0`/`Math.sign` interaction, and the `Number.isSafeInteger` overflow boundary — closing the second coverage gap in (a), again with a new TS oracle test first.
- **"candidate score tuples"** — the full comparator chains in both `irregularPlacementScorer.ts` and `irregularLayoutScorer.ts`, even though dead for production Compact (must still be ported exactly per prompt §3).
- **"canonical key bytes"** — `canonicalCollisionPolygonKey`'s equivalence-class behavior (ring-origin, rotation-of-start-vertex, winding reversal).

### (c) Planned differential tests

- **"score summaries"** — for the production-live scoring path actually reached by Compact/Compact Short Side (this cluster's dead-for-production scorers are ported for parity but not exercised by production differential fixtures; S12/S14/S15/S17 own the live comparators), assert byte-identical score tuples.
- **"canonical keys"** — `canonicalCollisionPolygonKey`/`IrregularBeamState`'s canonical-key output, byte-identical between TS and Rust for the same beam state.

### (d) Planned concurrency determinism tests

Prompt §14.1 names "independent candidate legality or score evaluation within one already ordered candidate batch" and "independent canonical-key component computation with serial byte assembly" as **good candidates**. Tests: score a batch of candidates in parallel by stable ordinal, reduce serially with the exact TS comparator, assert 1/2/default/higher-thread-count identity.

### (e) Planned property/fuzz targets

- **"canonical key equivalence"** and **"ring-origin and winding invariance"** — this cluster's own instance (distinct beam states, distinct call sites from S8's layout-level identity).
- **"stable indexed parallel reduction"** — property-fuzz random candidate batches and random thread counts against the serial TS ordering, asserting the parallel-then-serially-reduced result always matches the fully-serial result.

---

## 13. Subsystem S10 — Strict decoder, gap regions, repeated-family grouping

Owning doc: `characterization/strict-decoder-gap-family.md`. TS files: `intrinsicStrictDecoder.ts`, `intrinsicGapRegions.ts` (part of the same file per the cluster doc's grouping), `intrinsicStrictFamilyPortfolio.ts`.

### (a) Existing tests/gates

- `tests/unit/intrinsicStrictDecoder.test.ts` (1,560 lines, ~40 `it` blocks) — phase-coverage residual thresholds, exact candidate-evaluation cap, full checkpoint round-trip through every piece boundary, corrupted-checkpoint rejection across every validation branch, frozen-seed wrapper equivalence, F0-observer non-interference, comparator-mode parametrized tests, origin-anchor normalization, family-winner-before-selection preservation, exact 2%/1% growth-band boundary, sub-grid ULP-noise rejection, authoritative rounded-world envelope after fractional translation, contact-vs-growth non-veto Pareto behavior, Pareto-front-opens-next-layer behavior, exact Clipper path-area measurement across holes and quarter turns.
- `tests/unit/intrinsicGapRegions.test.ts` (218 lines) — exact hull-gap derivation, boundary-touching containment, enclosed-cavity vs. hull-open-gap distinction, real contained-candidate selection with non-inert evidence recording, contained-candidate retention before same-family growth collapse.
- `tests/unit/intrinsicStrictFamilyPortfolio.test.ts` (361 lines) — family grouping/round-robin, size-band interleaving, large-first-small-fill partitioning, repeated-elongated-family selection, orientation-from-transformed-bounds (dead-path but immutable), invalid/duplicate chromosome recording (dead-path), Pareto-tradeoff-front starting representative, sheet-blind eight-chromosome decode (`runIntrinsicStrictFamilyPortfolio` — confirmed **not reachable from production**, still a required regression gate per prompt §3).
- `gate:mixed61-compact` is a **de facto end-to-end parity gate** for this cluster's numeric/comparator/hashing behavior even though it never imports these files by name — the production Compact path routes through `constructIntrinsicStrictState`/`evaluateIntrinsicStrictCertificate`/`rankIntrinsicStrictCompletedLayouts` for the `'canonical-grid'`, `'legacy-absolute-envelope'`, `'open-pocket-first'` direct roles.

### (b) Planned NEW Rust unit tests

- **"exact comparisons"** — Pareto-dominance comparison and ranking of completed layouts, the cohesion "certificate" (floor violations + exact relative-deficit fraction).
- **"checkpoint hashes"** / **"checkpoint corruption rejection"** — `IntrinsicStrictDirectCheckpoint` (version `'intrinsic-strict-direct-checkpoint-v1'`), reproducing every corruption-rejection branch `intrinsicStrictDecoder.test.ts:285-472` pins.
- **"accounting-distinct state keys"** — states with equal occupied geometry but different pending/deferred/fit/quota/ledger semantics must remain distinct (prompt §10 rule).
- **"exact area and cross-products"** — exact Clipper path-area measurement across holes and quarter turns.

### (c) Planned differential tests

- **"canonical keys"** / **"canonical collision identity"** / **"fitted canonical identity"** — this cluster is the primary producer feeding S8's identity for the three direct roles; assert byte-identical completed-layout metrics and canonical hashes per role.
- **"evaluation counts"** — exact candidate-evaluation cap and consumed-evaluation counters.
- **"checkpoint bytes and hashes under an identical injected deterministic clock"** — round-trip pause/resume and assert byte-identical checkpoint state (delegates encoding specifics to S16, exercised here at this producer).

### (d) Planned concurrency determinism tests

**Serial-only for the overall decode chronology** — prompt §10 rule 1 requires the complete construction to be sheetless/deterministic in a fixed order; per-candidate scoring within one decode step (already covered by S9) is the parallelizable inner work, but the decode's own step sequence, checkpoint pause boundaries, and Pareto-front updates must remain logically serial (prompt §14.2 "depth transitions before all required ordered results exist").

### (e) Planned property/fuzz targets

- **"checkpoint encode/decode and corruption rejection"** — fuzz-mutate valid checkpoints field-by-field and assert rejection with the correct `IntrinsicCapacityError`/decoder-specific error, matching the exhaustive-branch pattern `intrinsicStrictDecoder.test.ts:285-472` already established in TS.

---

## 14. Subsystem S11 — Periodic cells and family portfolio

Owning doc: `characterization/periodic.md`. TS files: `intrinsicPeriodicCells.ts`, `intrinsicPeriodicFamilyPortfolio.ts`.

### (a) Existing tests/gates

- `tests/unit/intrinsicPeriodicCells.test.ts` (484 lines, 7 `it` blocks) — finite-crop source selection under infinite-far-proof tie, triangle-family source-linking/exactness, transform/family coverage-before-cap accounting, exact union + axis duality + negative moving-base offset sign, BigInt far-neighbor arithmetic plus independent 3×3 lattice/contact checks, whole-cell quarter-turn/basis-swap dedup, P2 expansion with an odd real remainder.
- `tests/unit/intrinsicPeriodicFamilyPortfolio.test.ts` (508 lines, 6 `it` blocks) — each retained seed running independently through the strict archive, phase-coverage failure when unclassified residual exceeds 1%, capped-continuation reordering by compact seed cost without changing uncapped order, admitting raw-crop Pareto witnesses as source-tagged archive competitors, replaying validated raw witnesses without full source-audit enumeration.
- Indirect: `tests/unit/intrinsicSharedArchivePortfolio.test.ts` constructs synthetic `'periodic-P1'`/`'periodic-P2'` role endpoints and directly tests the production-validity boolean formulas (`intrinsicSharedPeriodicCatalogCoverageValid`/`intrinsicSharedPeriodicSelectionValid`) that gate the whole nesting job on this cluster's coverage flags.
- `gate:mixed61-compact`/`gate:compact-nine-baselines`/`gate:capacity*` exercise this cluster indirectly through the shared-archive path (this cluster runs unconditionally as part of Compact production, per its own §1 liveness trace).

### (b) Planned NEW Rust unit tests

- **"exact area and cross-products"** — BigInt-exact P1/P2 lattice basis derivation, far-neighbor certificate arithmetic (already exact-integer in TS; Rust equivalent must use an equally exact wide-integer/arbitrary-precision type).
- **"canonical key bytes"** — whole-cell canonical identity (`canonicalPeriodicCellIdentityControl`) under quarter-turn/basis-swap dedup.
- **"stable sorting"** — capped-continuation reordering by compact seed cost must not change the uncapped order (direct pin from `intrinsicPeriodicFamilyPortfolio.test.ts:189` — the execution-vs-selection order distinction the source doc calls out explicitly).

### (c) Planned differential tests

- **"archive entries and order"** — periodic-family candidate endpoints admitted into the shared archive, byte-identical order/hash between TS and Rust.
- **"evaluation counts"** — phase-coverage residual accounting.

### (d) Planned concurrency determinism tests

Prompt §14.1 names "independent periodic-cell candidate evaluation with stable catalog indices" as a **good candidate**. Test: evaluate the periodic-cell catalog in parallel by stable index, reduce serially into the archive with the exact TS comparator/order, assert 1/2/default/higher-thread-count identity. The archive-admission step itself must remain serial (S12).

### (e) Planned property/fuzz targets

- **"integer overflow boundaries"** — fuzz the BigInt far-neighbor lattice arithmetic near practical coordinate bounds.

---

## 15. Subsystem S12 — Shared archive (dedup / rank / winner selection)

Owning doc: `characterization/shared-archive.md`. TS files: `intrinsicSharedArchivePortfolio.ts`, `intrinsicAnytimeArchive.ts`.

### (a) Existing tests/gates

- `tests/unit/intrinsicSharedArchivePortfolio.test.ts` (393 lines) — `retainRankedSharedArchive` (dedup-by-hash-keeps-first-encountered-role, sheetless rank independent of sheet fit), `selectIntrinsicSharedArchiveWinner` (Pareto-front-first-then-certificate-deficit selection; dominance not rescued by certificate), `normalizeIntrinsicSharedArchiveConstructedRun` (evaluation-cap/incomplete-endpoint exclusion), `intrinsicSharedPeriodicSelectionValid`/`intrinsicSharedArchiveExperimentValid`/`intrinsicSharedPeriodicCatalogCoverageValid`. **Confirmed coverage gap**: every synthetic test fixture in this file omits the `exact` field, so only the float-fallback branches of `compareCertificateDeficit`/`compareLargestHullGap`/`compareEnvelope` are unit-tested — the BigInt-exact branches production always takes have **no direct unit coverage** in this file (presumably exercised only indirectly via full-pipeline gates, since real geometry always populates `exact`).
- `tests/unit/intrinsicAnytimeArchive.test.ts` (50 lines) — `retainIntrinsicAnytimeArchiveNamespace` (dedup + invalid-rejection + custom rank), `selectIntrinsicAnytimeSettledEndpoint` (complete-over-partial dominance) — the **only** place this function is exercised at all.
- `tests/unit/intrinsicSharedArchiveAdmission.test.ts` (52 lines) — eligibility gating (`isIntrinsicSharedArchiveEligible`), `portfolioProgressForDecodeRole`.
- The four promoted gates (§3) exercise this cluster's dedup/rank/winner-selection logic end-to-end; any regression is very likely caught since they assert exact canonical hashes.

### (b) Planned NEW Rust unit tests

- **"archive comparator"** — the full multi-key comparator chain (Pareto front, certificate deficit, largest hull gap, envelope) — **including new BigInt-exact-branch fixtures** the TS suite currently lacks (closing the confirmed gap in (a); should be added as new TS characterization tests first, per this document's convention, then ported).
- **"invalid-value non-publication"** — `normalizeIntrinsicSharedArchiveConstructedRun`'s evaluation-cap/incomplete-endpoint exclusion.
- **"accounting-distinct state keys"** — dedup-by-hash-keeps-first-encountered-role semantics.

### (c) Planned differential tests

- **"archive entries and order"** — for every maintained fixture, assert the deduplicated/ranked archive's exact member set, order, and winner selection are byte-identical TS vs. Rust — this is the direct producer of the Mixed-61 `protected-fallback` result (§2).
- **"complete result object"** cross-reference: the archive winner (or capacity fallback, S14) becomes `selected` in `computeIrregularNesting.ts`; S1's end-to-end test is this cluster's ultimate differential gate too.

### (d) Planned concurrency determinism tests

**Serial-only per prompt §10/§14.2**: "Do not parallelize these roles as independent races whose completion order affects archive state" and "archive admission as tasks finish" is an explicit high-risk boundary. The three direct roles' *own* sheetless construction (S10) may use parallel sub-computation internally, but admission into this archive, dedup, and winner selection must remain a single serial pass over a stable-ordered input vector (prompt §14.3 pattern) regardless of thread count. Concurrency-determinism tests here assert exactly this: run the archive-admission step with the direct-role and periodic-role endpoints computed at 1/2/default/higher thread counts upstream, and assert the archive's own admission/dedup/rank/winner output is thread-count-invariant.

### (e) Planned property/fuzz targets

- **"stable indexed parallel reduction"** — fuzz-generate synthetic endpoint batches (including the currently-uncovered BigInt-exact-field shape) and property-test that parallel upstream computation followed by this cluster's serial reduction always matches the fully-serial baseline.

---

## 16. Subsystem S13 — Focused reconstruction and place/defer shadow

Owning doc: `characterization/reconstruction.md`. TS files: `intrinsicReconstructionPortfolio.ts`, `intrinsicPlaceDeferCompleteShadow.ts`.

### (a) Existing tests/gates

- `tests/unit/intrinsicReconstructionPortfolio.test.ts` (367 lines) — `buildCanonicalEndpointOrders`, `buildIntrinsicReconstructionSpecs`, `intrinsicReconstructionSpecMatchesFamily`, `intrinsicReconstructionEffectiveOrderKey`, `retainIntrinsicReconstructionArchive` (capacity-override and protected-seed cases), `runIntrinsicReconstructionPortfolio` end-to-end deadline/evaluation-cap/cancellation behavior.
- `tests/unit/intrinsicCapacityMode.test.ts` `describe('experimental place/defer complete shadow', ...)` (`:1133-1264`) — `runIntrinsicPlaceDeferCompleteShadow` pause/resume/checkpoint-rejection, `observeIntrinsicPlaceDeferCompleteShadow` censoring/cancellation-propagation, bypassing `computeIrregularNesting.ts`.
- `tests/unit/intrinsicCapacityIntegration.test.ts:165-234` — **the single production golden path proving `'duplicate-order'` → `outputInfluence: 'protected-fallback'` is reachable** — this is exactly the Mixed-61 `2000x2700` production outcome (§2). `:370-413` (`'skipped-no-fitting-protected-endpoint'`), `:271-320` (`'skipped-preflight-proven-impossible'`), `:618-666` (`captureExperimentalPlaceDeferCompleteShadow: true`, asserts byte-identical placed/unplaced geometry to the non-shadow run and `outputInfluence === 'none'`).
- `tests/unit/irregularSeventeenShapesCompactGolden.test.ts:36-129` — **the one golden test where focused reconstruction actually wins** (`outputInfluence: 'selected'`, `consumedCandidateEvaluations: 8_035`), the single highest-value differential/golden test for this cluster's live code path.
- **Confirmed gap**: no test directly asserts `retainIntrinsicReconstructionArchive`'s output byte-for-byte against a golden hash — only structural assertions. No test exercises `roleFamily: 'pure-growth'`/`'gap-contained'` through the production caller (only `'endpoint-q90-right-to-left'` is live in production; the other families are unit-tested directly but not through `computeIrregularNesting.ts`).

### (b) Planned NEW Rust unit tests

- **"exact comparisons"** — the four q0/q90 traversal comparators (`buildCanonicalEndpointOrders`) plus the reversed-priority and gap-contained order variants.
- **"accounting-distinct state keys"** — `intrinsicReconstructionEffectiveOrderKey`'s dedup semantics.
- **"canonical key bytes"** — `intrinsicPreparedPieceClassKey`, `canonicalPointRing`.

### (c) Planned differential tests

- **"evaluation counts"** — the exact `consumedCandidateEvaluations` counter at both pinned outcomes (`12_000` evaluation-cap for Mixed-61, `8_035` completed for Shapes-17) — these are chronology-derived exact integers, prime differential-parity targets.
- **"archive entries and order"** — `retainIntrinsicReconstructionArchive`'s internal 8-slot Pareto archive (dead on the production path today but must still be ported/differentially tested per prompt §3, since it is unit-tested).
- **"resumed endpoint"** — the protected-fallback/duplicate-order and selected/win outcomes must resolve identically TS vs. Rust for both golden fixtures.

### (d) Planned concurrency determinism tests

**Serial-only**: the reconstruction decode is a single bounded re-decode of the strict sheetless constructor per candidate order, run one order at a time against a shared runtime/evaluation budget (prompt §14.2 "depth transitions before all required ordered results exist" applies at the decode-step level, inherited from S10). The *catalog* of candidate orders to try (reversed priority + 4 q0/q90 traversal orders + gap-contained variants) is fixed and small (bounded by the family-match filter, in production exactly one non-seed spec); not a meaningful Rayon target on its own, though each order's internal decode may reuse S9/S10's parallel sub-computation.

### (e) Planned property/fuzz targets

- **"checkpoint encode/decode and corruption rejection"** — extend to the place/defer shadow's own checkpoint (`IntrinsicPlaceDeferCheckpoint`, version `'intrinsic-place-defer-checkpoint-v1'`), reproducing `intrinsicCapacityMode.test.ts:1181-1211`'s corruption-rejection case.

---

## 17. Subsystem S14 — Capacity core (preflight, material accounting, endpoint construction, mode orchestration)

Owning doc: `characterization/capacity-core.md`. TS files: `intrinsicCapacityPreflight.ts`, `intrinsicCapacityMaterial.ts`, `intrinsicCapacityEndpoint.ts`, `intrinsicCapacityMode.ts`.

### (a) Existing tests/gates

- `tests/unit/intrinsicCapacityMode.test.ts` (1,368 lines) — exact routing/status/hash pins for quality admission, resume round-trips, corruption rejection (`counters.deduplicatedSuccessors = -1`, `budgetLedgers.perDepth[0].quotaExhausted` mutation → `IntrinsicCapacityError` with `operation: 'coldSearchCheckpoint'`), place/defer shadow checkpoints (S13/S16). Member of the Focused Correctness Gate (`docs/operations/irregular-production-gates.md:38`).
- `tests/unit/intrinsicCapacityIntegration.test.ts` (678 lines) — exact counts incl. `consumedCandidateEvaluations: 0` cases.
- `pnpm gate:capacity[:production]` (`scripts/irregular-capacity-gate.ts`, §3) — 8 fixtures, exact routing/placed-count pins including `capacity-mixed61-700x500` (50, hash `97dbc502…`, warm-prefix depth 15, endpoint hash `0c98259d…`) and `capacity-mixed61-700x560` (59, hash `36cee348…`, warm-prefix depth 30, endpoint hash `2d252e35…`) — re-verified exact values at `scripts/irregular-capacity-gate.ts:190-219` per the characterization doc's own citation; plus per-fixture invariant checks (`partitionExact`, `capacitySettled`, `auxiliaryEvaluationsZero`, `coldSearchReachedEveryDepth`, `schedulerChronology`, `laneCoordinatorChronology`, `oneWarmLaneBeyondPilot`, `prefixNotBelowColdOnly` when paired).

### (b) Planned NEW Rust unit tests

- **"exact area and cross-products"** — `exactDoubledPolygonAreaGrid2`'s bigint shoelace formula (term order is mathematically irrelevant for exact bigint arithmetic — a positive finding worth a dedicated commutativity/associativity-invariance test).
- **"capacity comparator"** — `compareIntrinsicCapacityObjectives`'s full 11-key chain (placedCount desc, material area desc, cavity count asc, cavity area asc, max side asc, envelope area asc, span asc, `canonicalGeometryHash.localeCompare` asc, origin rank asc, prefixDepth asc, sourceRole `localeCompare` asc) — **note the deliberate `localeCompare` (not ordinal `compareStrings`) at exactly two of the eleven keys**; the Rust port must reproduce this exact inconsistency, not "fix" it to one comparator throughout.
- **"legacy string ordering"** — the `localeCompare` hazard above; pin an explicit ASCII-safe collation (digit-run or plain byte comparison for these hex-hash/role-name strings) since these are ASCII-only in practice, but do not silently substitute a different comparator without proving equivalence for every input this cluster's fields can hold.
- **"signed zero"** — `toGridMm(-0)` reproduced at this cluster's own call sites (`intrinsicCapacityPreflight.ts:79-80,244-245`, `intrinsicCapacityMaterial.ts:23-24`, `intrinsicCapacityEndpoint.ts:122-125`).
- **"canonical JSON bytes"** — the bigint-vs-string field split in `IntrinsicCapacityEndpointMetrics` (`placedDoubledMaterialAreaGrid2: bigint` compared directly; `totalEnclosedCavityDoubledAreaGrid2`/`envelopeAreaGrid2: string` round-tripped through `BigInt(string)` before comparison) — reproduce both representations exactly wherever an external boundary observes them.

### (c) Planned differential tests

- **"capacity endpoints"** — for every capacity-routed fixture (preflight-proven-impossible and bounded-complete-archive-miss branches), assert byte-identical endpoint metrics, canonical hash, and origin/sourceRole/prefixDepth between TS and Rust.
- **"lane trace"** / **"scheduler trace"** — `IntrinsicCapacityLaneCoordinatorTrace`'s `continuedProducers` (Set-insertion-order-derived, must be an explicit `Vec` in Rust, not a `HashSet`), the 9-call-site `appendCoordinatorQuantum` chronology.
- **"evaluation counts"** — `warmConsumedPlacementEvaluations` and related accounting.

### (d) Planned concurrency determinism tests

**Serial-only for lane coordination** per prompt §14.2 ("cold versus warm lane races", "direct producer roles whose chronology affects scheduler traces"): the cold lane, each warm-prefix lane, and the quality-warm-prefix lane must resolve in the current fixed chronological order regardless of thread count; only the *pure geometry work inside* one lane's search step (S6/S9's parallel candidates) is a Rayon target. Concurrency tests: run the full lane-coordinator sequence at 1/2/default/higher thread counts with the inner geometry work parallelized, and assert the lane trace, checkpoint chronology, and final endpoint are byte-identical at every thread count.

### (e) Planned property/fuzz targets

- **"integer overflow boundaries"** — `envelopeAreaGrid2: BigInt(widthGrid) * BigInt(heightGrid)` can exceed `2^53` (up to ~`2^106`); fuzz grid magnitudes near this range and assert the Rust wide-integer/arbitrary-precision type never silently truncates where JS `BigInt` would not.

---

## 18. Subsystem S15 — Capacity search (beam engine, prefixes, telemetry)

Owning doc: `characterization/capacity-search.md`. TS files: `intrinsicCapacitySearch.ts`, `intrinsicCapacityPrefixes.ts`, `intrinsicCapacityTelemetry.ts`.

### (a) Existing tests/gates

- Covered jointly with S14 by `tests/unit/intrinsicCapacityMode.test.ts` and `tests/unit/intrinsicCapacityIntegration.test.ts` (this cluster's engine is the callee `intrinsicCapacityMode.ts` orchestrates; no separate top-level test file targets `intrinsicCapacitySearch.ts` by name, confirmed by the cluster doc's own caller trace).
- `pnpm gate:capacity[:production]` pins exact prefix-depth/warm-lane identities: Mixed-61 `700x500` → `prefixDepth: 15`, `endpointCanonicalGeometryHash: '0c98259d05531d74d14d7e72eac64d0d1f02e9ffb5e99910aabad048f67bf77d'`; Mixed-61 `700x560` → `prefixDepth: 30`, `endpointCanonicalGeometryHash: '2d252e359cf482f55bc5de60cdde7b3482a8f6b0493e1c686ae9d94296741e69'`; Triangle-20 `300x300` → `status: 'skipped-below-minimum-piece-count'`, `prefixDepth: 10`.
- Production values independently re-derived from source and confirmed by the cluster doc: cold beam width `16` (`intrinsicCapacitySearch.ts:55`), legal-placement fanout `3` (`:56`), minimum total evaluation cap `50_000` (`:57`), per-depth quota `4_096` (`:58`), total cap `max(50_000, pieceCount * 4_096)` (`:352-355`), checkpoint version `'intrinsic-anytime-checkpoint-v3'` (`:61`), max captured prefix descriptors `9` (`intrinsicCapacityPrefixes.ts:16`).
- **Critical undocumented-by-the-prompt nuance, confirmed against source**: the production default beam-retention comparator is **not** the plain objective comparator the prompt §11's "beam width 16, fanout 3" phrasing implies. Production `retentionMode` defaults to `'cohesion-frontier'` (`computeIrregularNesting.ts:533-538`), which adds a 4th "contact" successor beyond the 3-wide fanout and retains the 16-wide beam via a 5-bucket topology-stratified reservation (`retainCapacityCohesionFrontier`), not a single top-16-by-objective sort. A Rust port that implements only the plain objective retention would silently diverge from production on every capacity-routed fixture.

### (b) Planned NEW Rust unit tests

- **"permanent-skip behavior"** — one skip successor reserved per current beam entry, before spending the depth's placement quota, at every depth (`:549-580`).
- **"capacity comparator"** — this cluster's five-comparator family: `compareScoredCandidateReferences`, `compareContactCandidateReferences`, `compareCapacityBeamEntries` (plain `'objective'`), `compareCapacityBeamEntriesAreaFirst`, `compareCapacityBeamEntryAccounting` (the accounting-only prefix used by the cohesion-frontier path) — and the full 5-step `retainCapacityCohesionFrontier` bucketed reservation (objective bucket, isolated-piece bucket, largest-positive-contact-component bucket, component-count+hull-waste bucket, plain-objective-fill bucket), since this is the **production default**, not the simpler plain comparator.
- **"accounting-distinct state keys"** — `intrinsicCapacitySuccessorIdentity` (`anchoredOccupiedKey + sorted(placementOrder)` as JSON) must dedupe exactly the same successors TS dedupes, no more, no fewer.
- **"checkpoint corruption rejection"** — reproduce `intrinsicCapacityMode.test.ts:634-680`'s corruption cases at this cluster's own checkpoint-construction boundary.
- **"legacy string ordering"** — `compareIntrinsicCapacityEndpoints`' `localeCompare` on `canonicalGeometryHash`/`sourceRole` is the **only** comparator in this cluster using `localeCompare` instead of the plain `compareStrings` used everywhere else in the same file — an explicit, deliberate inconsistency that must be reproduced exactly (a Rust port that "cleans up" this inconsistency into one comparator throughout would silently diverge).
- **"stable sorting"** — insertion-order preservation into `successors` (skip successors in beam order, then compactness successors in `scored`-sorted order per beam entry, then contact successor) as the tiebreak substrate for every downstream comparator.

### (c) Planned differential tests

- **"capacity endpoints"** / **"ledgers"** — final endpoint set, `consumedPlacementEvaluations`, `prunedByAttainableCount`/`prunedByAttainableMaterial`/`deduplicatedSuccessors`/`fitRejectedCandidates`/`invalidCandidates`/`endpointFitRejections`/`completedDepths`/`depthQuotaExhaustions` counters — all monotonic counters incremented at exactly one call site each in TS; each must be independently verified byte-identical.
- **"checkpoint bytes and hashes under an identical injected deterministic clock"** — `intrinsicCapacityCheckpointIntegrityHash`/`intrinsicCapacityRequestFingerprint`'s curated-field-subset `canonicalJson` hash-preimage (delegated to S16 for the encoding contract, exercised here as the primary live producer).
- **"resumed endpoint"** — pause at an arbitrary depth boundary, resume in both TS and Rust, assert the resumed endpoint/trace equal an uninterrupted run in both languages and equal each other.

### (d) Planned concurrency determinism tests

Per-depth work is the **primary target named by the prompt's own worked examples** (§13's central performance discussion cites this exact 98.2%-cache-hit-rate workload). Good Rayon candidates within one depth (prompt §14.1): scoring candidates per beam entry per transform (S9), NFP/IFP computation (S6). High-risk/serial per prompt §14.2: "depth transitions before all required ordered results exist" — the outer `for (const entry of beam)` / `for (let depth = ...)` loop structure, the `depthQuotaExhausted` early-break, and `retainCapacityBeamEntries`'s bucketed reservation must remain serial across one depth's full successor set. Concurrency tests: parallelize the per-beam-entry-per-transform candidate generation/scoring by stable ordinal, serially reduce into `successors` in the exact insertion order documented in (a), and assert the retained beam and all counters are byte-identical at 1/2/default/higher thread counts, matching the Mixed-61 cache-reuse baseline from `baseline-evidence.md`.

### (e) Planned property/fuzz targets

- **"arbitrary thread counts producing the same result"** — this cluster's own instance: fuzz thread count against the 8 capacity gate fixtures and assert identical routing/hash/counter output at every count.
- **"checkpoint encode/decode and corruption rejection"** — fuzz-mutate valid capacity checkpoints field-by-field (frontier entries, budget ledgers, no-skip frontier, counters) and assert rejection with `IntrinsicCapacityError` for every semantically-invalid mutation, matching `intrinsicCapacityMode.test.ts`'s existing corruption battery.

---

## 19. Subsystem S16 — Checkpoint encoding (cross-cutting: 3 producers + 1 adjacent non-checkpoint encoder)

Owning doc: `characterization/checkpoint-encoding.md`. TS files (no single dedicated module — grounded in): `intrinsicCapacitySearch.ts` (`IntrinsicAnytimeCheckpoint`, version `'intrinsic-anytime-checkpoint-v3'`, S15), `intrinsicStrictDecoder.ts` (`IntrinsicStrictDirectCheckpoint`, version `'intrinsic-strict-direct-checkpoint-v1'`, S10), `intrinsicPlaceDeferCompleteShadow.ts` (`IntrinsicPlaceDeferCheckpoint`, version `'intrinsic-place-defer-checkpoint-v1'`, S13); plus the adjacent non-checkpoint `intrinsicPeriodicFamilyPortfolio.ts:1285-1293` `canonicalJson` (S11, source-audit replay-envelope digests only, no version/integrity fields).

### (a) Existing tests/gates

- No dedicated test file or gate script exists solely for "checkpoint encoding" as a concept — coverage lives entirely inside each producer's own test file, cited in S10/S13/S15's (a) sections above (`intrinsicCapacityMode.test.ts`'s corruption/resume cases, `intrinsicStrictDecoder.test.ts`'s round-trip/corruption cases, `intrinsicCapacityMode.test.ts:1134-1211`'s place-defer-shadow checkpoint cases).
- **Critical finding, re-confirmed this pass**: no checkpoint object of any of the three types is ever actually serialized to bytes/disk/IPC in production (`grep -rln "checkpoint" src --include="*.ts" | grep -v "workers/algorithm/irregular\|workers/irregular"` → zero results). Checkpoints are pure in-process object references passed by ordinary function call within one `computeIrregularNesting` execution; even the corruption tests object-spread-mutate a live object rather than round-tripping through `JSON.stringify`/`parse`. Consequence: the three `canonicalJson`-family encoders exist **solely as deterministic SHA-256 hash-preimage builders** for `integrityHash`/`requestFingerprint`, never for actual checkpoint reconstruction from bytes — a Rust port needs exact hash-preimage-string parity, but not full `serde` round-trip parity for the whole checkpoint struct (ordinary Rust ownership/move semantics suffice for pause/resume, since Rust has no process-boundary crossing here either).
- **No dedicated checkpoint-encoding gate script exists in `scripts/`** — confirmed by grep; `scripts/irregular-capacity-gate.ts`'s only `checkpoint`-adjacent reference is an unrelated `tmpdir()` literal. Checkpoint correctness is covered exclusively by the unit tests above.

### (b) Planned NEW Rust unit tests

- **"canonical JSON bytes"** — reproduce all three encoders' exact byte output (Encoder A `intrinsicCapacitySearch.ts:1626-1635` — ordinal `compareStrings` key sort, no `Map` special-casing; Encoder B `intrinsicStrictDecoder.ts:1257-1277` — `localeCompare` key sort, explicit `Map` handling via `String(key).localeCompare`; the place-defer shadow's own encoder) as three **independently-named** Rust functions, not unified into one shared encoder — the source doc explicitly documents these as three genuinely different encoders and flags "these are easy to conflate" as a hazard.
- **"checkpoint hashes"** — `intrinsicCapacityCheckpointIntegrityHash`/`intrinsicCapacityRequestFingerprint`'s curated field-subset selection (exact field list, exact order where order matters for array fields since `canonicalJson` preserves array order).
- **"checkpoint corruption rejection"** — the union of all three producers' corruption-rejection branches (already enumerated per-producer in S10/S13/S15).
- Injected deterministic clock seam: per prompt §11, add a Rust equivalent of the TS `timingNow` test-only clock seam so byte-level differential tests can compare `activeRuntimeMs` and phase-timing fields exactly under a controlled clock sequence, while under real clocks these fields are compared only as measurements.

### (c) Planned differential tests

- **"checkpoint bytes and hashes under an identical injected deterministic clock"** — for each of the three checkpoint types, pause at a matched point in TS and Rust under the same injected clock sequence and assert byte-identical `integrityHash`/`requestFingerprint`/full field set.
- **"production checkpoint encoding, integrity validation, and resume semantics under real clocks without requiring equal measured timing values"** — same three checkpoint types under real (non-injected) clocks: assert identical encoding rules, field-presence rules, integrity validation, status transitions, resume semantics, while treating `activeRuntimeMs`/phase timings as non-semantic measurements.
- **"resumed endpoint"** — cross-reference to S10/S13/S15's own resumed-endpoint tests; this subsystem's differential burden is the byte-level encoding underneath those, not a separate end-to-end endpoint comparison.

### (d) Planned concurrency determinism tests

Prompt §14.2 flags "checkpoint publication by completion order" as **high-risk/serial-only**. Concurrency tests: with the inner search work parallelized (S6/S9/S15), assert the checkpoint object published at a given pause boundary is identical regardless of how many threads computed the work leading up to it — checkpoint publication itself must remain a single serial event per pause boundary, never a race among completing threads.

### (e) Planned property/fuzz targets

- **"checkpoint encode/decode and corruption rejection"** (primary owner across all three producers) — a unified property-fuzz harness that mutates each checkpoint type's fields (including the `Object.prototype.hasOwnProperty`-sensitive optional fields documented in S10/S13/S15, e.g. `incumbentBinding: undefined` vs. omitted) and asserts identical accept/reject and identical rejection error/operation tag between TS and Rust for every mutation.

---

## 20. Subsystem S17 — Compact Short Side (axes, observer, pair-fold, contact strip)

Owning doc: `characterization/short-side.md`. TS files: `intrinsicShortSideAxes.ts`, `intrinsicShortSideObserver.ts`, `intrinsicShortSidePairFoldObserver.ts`, `intrinsicShortSideContactStrip.ts`.

### (a) Existing tests/gates

- `tests/unit/intrinsicShortSideObserver.test.ts` (444 lines, 10 cases) — material short-axis fill ranking, Pareto-front tie-breaking, dominated-strip rejection, transpose/orientation-swap identity preservation, exact-integer admission boundary, area-cost-bound veto-evidence case, square-sheet physical-Y convention, no-legal-orientation handling, zero-work skip when no archive settled, runtime-budget censoring.
- `tests/unit/intrinsicShortSidePairFoldObserver.test.ts` (762 lines, 14 cases) — deterministic pair selection + transpose identity, "retains exact directional rows even below historical quality telemetry floors" (confirms quality floors are evidence-only, not gating), shelf fallthrough, area-cost-bound and four-thirds-boundary telemetry (both confirmed evidence-only, not veto-authoritative), deadline/RSS budget sharing with the contact strip, trace-cap discard/enforcement, output-influence remeasurement, strip promotion at q0/q90, dual-lane recording without legacy-flag authority.
- `tests/unit/intrinsicShortSideContactStrip.test.ts` (348 lines, 8 cases) — interlocking-vs-bounding-box construction, canonical-identity reproducibility, floor-before-depth ordering, no-legal-placement reporting, deadline-without-partial-result, tied-anchor contacting-orientation preference, **"counts diagonal contact without projecting it into the axis-length suffix"** (direct unit coverage of the exact contact tuple prompt §12 requires), depth-refusal for a deeper contacting alternative.
- `tests/unit/intrinsicCapacityIntegration.test.ts:112` (`'runs the Short Side profile through the existing worker result and history path'`) — the closest thing to an end-to-end integration test in `tests/unit` for this cluster.
- **No dedicated unit test file exists for `intrinsicShortSideAxes.ts` itself** — confirmed by grep; exercised only indirectly through the three observer test files and the gate script.
- `pnpm gate:compact-nine-baselines` — the 18-layout matrix; asserts `guardedStage1WinnerCount === 0` and `compactFallbackCount === 0` as **required** conditions (the strongest available production evidence that the archive observer's ranked winner must never be the selected output, and for the no-Compact-fallback contract), plus per-fixture `shortSideCollisionIdentitySha256`/`shortSideFittedCanonicalSha256`/`shortSidePlacedCount`/`shortSideUnplacedCount`/(for two fixtures) `shortSideMaximumCanonicalCavities` (re-verified this pass for Mixed-61 `2000x2700`, §2).

### (b) Planned NEW Rust unit tests

- **"Short Side axes"** — direct axis-convention test (square sheet, `width < height`, `width > height`) closing the confirmed gap in (a) — the TS side currently relies on indirect coverage only, so this must start as a new TS characterization test before the Rust equivalent.
- **"square-sheet axis convention"** — physical Y is the short axis, physical X is the long axis on square sheets (prompt §12 explicit rule), pinned exactly by `intrinsicShortSideObserver.test.ts`'s existing case; reproduce at the Rust axis-selection boundary.
- **"pair-fold"** — deterministic pair selection + transpose identity, exact contract fields.
- **"multi-row shelf"** — shelf fallthrough behavior.
- **"contact-strip tuple"** — the exact tuple ordering: floor-before-depth, tied-anchor contacting-orientation preference, depth-refusal for a deeper contacting alternative.
- **"diagonal contact count"** — diagonal contacts count toward positive-contact count but never toward the projected-length suffix (direct port of the existing `'counts diagonal contact without projecting it into the axis-length suffix'` test).
- **"axis-only projected overlap"** — only axis-aligned overlap contributes to projected-length tie-breaking (delegates to S8's `measureCanonicalGridBoundaryOverlapAxisUnits`, tested here at this cluster's call site).
- **"no Compact fallback"** — assert that when no legal directional construction exists for the full target placed-ID set, the result is `irregular_no_valid_result` (prompt §12 rule 7), never a silent substitution of Compact geometry (prompt §12 rules 5-6).

### (c) Planned differential tests

- **"placed and unplaced IDs"** — Short Side must report exactly the same unplaced IDs Compact settled on (prompt §12 rule 4); differential test compares the Compact-settled partition and the Short Side partition across both languages.
- **"canonical collision identity"** / **"fitted canonical identity"** — Short Side's own distinct hashes (not Compact's) for every one of the 9 baseline fixtures, per `gate:compact-nine-baselines`'s table (re-verified for Mixed-61 `2000x2700` in §2: `shortSideCollisionIdentitySha256: 'c38a0cb4bb7765e4db102869224ef5b51f2a0bbc787cea05adf94ca0e2fe5e22'`, `shortSideFittedCanonicalSha256: '2a63c729108ba7680339cebaf86d4e39368a020eee95580caf9811d6d2bbc2ca'`).
- **"transforms and coordinates"** — Short Side independently constructs new directional geometry; assert the actual transform/coordinate set (not just the final hash) is byte-identical TS vs. Rust, so a coincidental hash collision cannot mask a divergent construction path.
- The confirmed non-zero-cavity asymmetry (§2) must be an explicit differential assertion, not an implicit "should be zero" check: assert Rust reproduces the exact same non-zero cavity count Short Side legitimately produces for Mixed-61/Shapes-17 at certain sheets.

### (d) Planned concurrency determinism tests

Prompt §14.2 explicitly flags "Short Side portfolio branches where first success currently has defined authority" as **high-risk/serial-only**: the portfolio order (exact pair-fold and multi-row shelf → protected prepared-order depth-first contact strip → capped contact-first strip with resumable depth-first decisions → bounded reverse-depth and canonical-ID continuations, prompt §12) must be tried in this fixed order with defined first-success authority, never as a race. Concurrency tests: with each stage's internal pure geometry work parallelized (S6/S9), assert the portfolio's stage order and which stage's result is authoritative are thread-count-invariant.

### (e) Planned property/fuzz targets

- **"candidate legality near touching boundaries"** — this cluster's own instance for directional contact-strip construction (tied-anchor, near-touching orientation cases).
- **"integer overflow boundaries"** — exact canonical-grid spans and cross-products at extreme sheet/piece-count combinations (prompt §12: "use exact canonical-grid spans and cross-products, not floating tolerances").

---

## 21. Subsystem S18 — Decision trace and persisted history

Owning doc: `characterization/trace-history.md`. TS files: `decisionTrace.ts`, `decisionTraceNdjson.ts`, `sharedArchiveHistory.ts`, `RunHistoryArchiveService.ts`.

### (a) Existing tests/gates

- `tests/unit/decisionTraceNdjson.test.ts` — `IrregularDecisionTraceBatcher` batching-threshold behavior and `serializeIrregularDecisionTraceBatch`'s exact NDJSON bytes/key-order, hand-constructed events (does not exercise the production-dead emission path — decision-trace emission is confirmed dead-for-the-Compact-archive-path elsewhere in this cluster's own analysis, only live for the legacy non-archive branch).
- `tests/unit/irregularWorkerCompute.test.ts:206-227` — the only test exercising `decisionTrace.ts` events end-to-end through `computeIrregularNesting`, and only via the legacy non-archive settings shape. `:229-280` exercises `makeIrregularWorkerOutput`'s (call-site-discarded-in-production) `historyFrames` field, proving the live `emitStateSnapshot` sequence and the discarded field agree on `stepIndex` ordering.
- `tests/unit/irregularTriangleCompactGolden.test.ts:190-200` and `tests/unit/intrinsicCapacityIntegration.test.ts:320-361` — production-shaped golden/integration tests pinning the full `'shared-archive-selected-layout-reveal'` → `'shared-archive-final-selected'` title sequence and frame count (`TRIANGLE_COUNT + 1`, `2` respectively) — these are the tests that pin the **live-path** contract.
- `tests/unit/workerProtocol.test.ts:112-133` — `NestingHistorySummary.decisionTracePath`/`decisionTraceEventCount` true-optional round-trip (always present together, no partial-presence case tested).
- `tests/unit/runHistoryArchiveService.test.ts` — deletes both managed files and leaves unrelated files untouched; treats already-missing files as successful deletion; validates every job id before deleting any file (atomicity).
- `tests/renderer/runHistoryGif.test.ts:85-102` — the only direct test of `expandSharedArchiveSelectedLayoutReveal`'s expansion behavior, and only against the single-frame legacy shape (modern multi-frame case untested — confirmed gap).
- **No dedicated test file for `sharedArchiveHistory.ts` itself** — confirmed by grep; exercised only indirectly.

### (b) Planned NEW Rust unit tests

- **"canonical JSON bytes"** — `serializeIrregularDecisionTraceBatch`'s exact NDJSON byte/key-order output.
- New test closing the confirmed gap: exercise `expandSharedArchiveSelectedLayoutReveal` against the modern multi-frame shape, not only the single-frame legacy shape — again, add the TS characterization test first per this document's convention.

### (c) Planned differential tests

- **"selected-layout reveal sequence"** — the `'shared-archive-selected-layout-reveal'` → `'shared-archive-final-selected'` title sequence and frame count, byte-identical TS vs. Rust for the live-path production golden fixtures.
- **"decision-trace event order"** for the legacy non-archive branch is a TypeScript-only characterization concern. It is outside Rust and differential scope. Explicit ineligible Rust or differential requests fail before execution.

### (d) Planned concurrency determinism tests

Prompt §14.2 flags "global trace append operations from Rayon workers" as **explicitly high-risk/serial-only**. Trace/history emission must occur only at the same logical serial boundaries TS uses (prompt §15's "aggregate native progress at the same logical serial boundaries as TypeScript"), never directly from parallel work. Concurrency tests: with inner search work parallelized, assert the emitted trace/history event sequence is thread-count-invariant and matches the serial TS sequence exactly.

### (e) Planned property/fuzz targets

None specific beyond the general checkpoint/canonical-key fuzz targets already covering this cluster's inputs (S8, S16); this subsystem's own surface is primarily a deterministic serialization/sequencing concern, better covered by the differential and unit tests above than by property fuzzing.

---

## 22. Subsystem S19 — Auxiliary/dead modules (must-preserve-tests, non-production-path)

Owning doc: `characterization/aux-modules-liveness.md`. TS files: `portfolioSearch.ts`, `priorityOrderService.ts`, `windowedBeam.ts`, `strictPriorityDecoder.ts`, `targetedExactLns.ts`, `overlapRelaxation.ts`, `overlapRelaxationV1.ts`, `overlapRelaxationTracker.ts`, `intrinsicComponentInterfaceClosure.ts`, `intrinsicExactProjection.ts`, `intrinsicSqueezeDisruptSeparate.ts`, `intrinsicGlobalSqueezePortfolio.ts`, `intrinsicV7SeedArchive.ts`, `intrinsicDetachedPieceReinsertion.ts`, `intrinsicPeriodicSmallFillE3.ts`, `intrinsicTwoPieceInterfaceReconstruction.ts`, `intrinsicQueueBeamDiscriminator.ts`.

Confirmed by exhaustive import-graph tracing: every module in this list is **unreachable from `computeIrregularNesting.ts`'s production Compact/Compact Short Side path**, either entirely dead (reachable via import but never executed for these two profiles) or probe-only (reachable only from `scripts/irregular-*.ts` files with no `package.json` alias). None affects the Mixed-61 identities in §2 or any of S1-S18's production behavior.

### (a) Existing tests/gates

- 14 of the 18 modules have direct `tests/unit/*.test.ts` coverage (full mapping table in `aux-modules-liveness.md` §14): `irregularPortfolio.test.ts`, `irregularBeamDecoder.test.ts`, `irregularWindowedBeam.test.ts`, `targetedExactLns.test.ts`, `overlapRelaxation.test.ts`, `overlapRelaxationTracker.test.ts`, `intrinsicComponentInterfaceClosure.test.ts`, `intrinsicExactProjection.test.ts`, `intrinsicSqueezeDisruptSeparate.test.ts`, `intrinsicGlobalSqueezePortfolio.test.ts`, `intrinsicV7SeedArchive.test.ts` (plus incidental coverage in `canonicalLayoutGeometry.test.ts`, `intrinsicStrictDecoder.test.ts`, `irregularInfrastructure.test.ts`).
- **Zero unit-test coverage** for exactly 4 modules: `priorityOrderService.ts`, `intrinsicDetachedPieceReinsertion.ts`, `intrinsicPeriodicSmallFillE3.ts`, `intrinsicTwoPieceInterfaceReconstruction.ts` — exercised only by manual `tsx scripts/irregular-*.ts` runs.
- `gate:capacity[:production]`'s `--cohesion-*-shadow` flags default `false` and are **not** passed by either promoted alias, so the 5 modules gated behind them (`targetedExactLns.ts`, `overlapRelaxation.ts`, `intrinsicDetachedPieceReinsertion.ts`, `intrinsicTwoPieceInterfaceReconstruction.ts`, `intrinsicComponentInterfaceClosure.ts`) are **not** actually invoked by either promoted gate today, confirmed by reading the flag defaults directly.

### (b) Planned NEW Rust unit tests

Per prompt §3 (existing tests are immutable) and the "reproduce dead code faithfully, do not silently drop it" principle applied throughout this corpus: every one of these 18 modules must still be ported with full correctness to keep its existing TS test green under a Rust-parameterized harness, but **none is a priority target for the performance-contract's representative-case selection** (`performance-contract.md` §2's C1-C7 cases never exercise this subsystem's code paths). Planned tests are exactly the Rust-equivalent unit tests for each module's own existing TS assertions — no new test categories beyond what S1-S18 already define, since these modules reuse the same comparator/geometry/checkpoint primitives characterized there.

### (c) Planned differential tests

None required for production parity (this subsystem is unreachable from Compact/Compact Short Side); differential tests here are optional regression insurance only, lower priority than S1-S18.

### (d) Planned concurrency determinism tests

N/A — not on the production Rayon-parallelization path; if ported, no concurrency claims are made or required.

### (e) Planned property/fuzz targets

None planned; out of scope per the prompt's Compact/Compact Short Side boundary (prompt §4.1/§4.2).

---

## 23. Cross-cutting: JS-specific semantics audit feeding (b)/(e) across every subsystem above

Owning doc: `js-semantics-audit.md` (horizontal sweep, not a subsystem). Raw pattern counts across `src/workers/`+`src/shared/`: 277 `.sort`/`.toSorted` call sites (~55 files), 114 named `compare*` comparators (~45 files), 135 `.localeCompare` call sites (26 files), 43 `JSON.stringify`/`JSON.parse` sites (21 files), 20 `Object.keys`/`entries`/`values`/`fromEntries` sites (5 files), 18 `Object.is(` sites (15 files), 744 `Math.*` calls (~50 files), 292 `Number.isSafeInteger`/`isFinite`/`isInteger`/`isNaN` sites (~45 files), 27 non-`JSON.stringify` `.toString()` sites (10 files), 1 `.toFixed(` site.

Every subsystem section above already cites its own instances of these patterns where load-bearing. This section records the **document-level obligation**: prompt §18.2's items "signed zero," "NaN and infinity rejection," "stable sorting," "legacy string ordering," "canonical key bytes," and "canonical JSON bytes" are not satisfiable by a handful of spot tests — a Rust unit-test plan for this migration must include, per subsystem, an explicit audit checklist derived from this document's per-pattern grep counts, not just the specific instances already called out in S1-S19. The four independent "canonical JSON"-family encoders (S16's three checkpoint encoders plus the periodic replay-envelope encoder, S11) are the highest-severity instance of this hazard, since they are easy to conflate and each has genuinely different key-sort/Map-handling rules (§8.1 of `js-semantics-audit.md`, cross-verified against `checkpoint-encoding.md` §8 and `periodic.md` §7-8 in this pass).

---

## 24. Coverage gaps — where differential tests carry the parity burden

This section aggregates every confirmed absence of direct TypeScript unit coverage found across the corpus. For each, no existing TS test pins the exact value/behavior at the unit level today — parity for the Rust port therefore depends entirely on (i) a **new** TS characterization test added first (this document's default recommendation, consistent with prompt §18's TDD requirement and prompt §3's "add, never edit" rule), and/or (ii) the **differential test** (TS-vs-Rust, one-thread) and **gate-script** coverage that does exist, which is exact but end-to-end and therefore slower to localize a regression from.

1. **The prompt §16 external error-mapping table (9 rows) has zero direct unit coverage** (S2). Neither `nesting.worker.ts` nor `WorkerSupervisor.ts` has a dedicated test file; the mapping is only indirectly touched by schema round-trip tests and one internal-tag assertion. **Highest-priority gap** — this is the exact table the prompt's §16 SPECIAL FOCUS asks to be verified and implemented, and it is currently unverified by any automated test. New TS tests should be added before/alongside the Rust port so the Rust differential harness has a byte-exact oracle.
2. **No test spawns the real `nesting.worker.ts` worker thread or drives it through `WorkerSupervisor`** (S1). The RPC-server progress-event sequence characterized in `worker-coordination.md` §10 is untested by the existing suite; the Rust port's differential-parity plan must add this coverage from scratch, not port an existing test.
3. **The Mixed-61 pinned identities (§2) are never asserted by any `tests/unit` vitest spec** — only by gate scripts. A Rust CI job gated only on `pnpm test` would silently miss a Mixed-61 regression; all four promoted gate scripts (§3) must be mandatory, separate Rust-CI steps.
4. **`intrinsicSharedArchivePortfolio.test.ts`'s comparator fixtures never populate the `exact` field** (S12), so the BigInt-exact branches of `compareCertificateDeficit`/`compareLargestHullGap`/`compareEnvelope` — the branches production always takes — have no direct unit coverage, only indirect coverage via full-pipeline gates.
5. **No dedicated test file for `intrinsicShortSideAxes.ts`** (S17), **no dedicated `irregularScoreGrid.test.ts`** (S9), **no direct test of `sortPiecesForNesting`'s real ordering logic** (S9/S1), **no direct unit test of `convexHull.ts`/`core/convexHullCore.ts`** (S7), **no dedicated `sharedArchiveHistory.ts` test** (S18), **no dedicated checkpoint-encoding gate script** (S16, though covered by producer-level unit tests) — each is a confirmed, source-verified gap; each subsystem section above names the specific new test needed.
6. **No checkpoint of any of the three types is ever actually serialized to bytes in production** (S16) — meaning the byte-level canonical-JSON encoders exist solely as hash-preimage builders, never exercised as a real serialize/deserialize round trip anywhere in the existing suite. A Rust port's byte-parity claim for these encoders is validated entirely by new differential tests, since no existing TS test performs a real round trip either.
7. **`gate:compact-nine-baselines`'s subprocess-per-case architecture (18 independent OS processes) is unverified as behaviorally load-bearing versus an implementation convenience** — no evidence either way was found for whether in-process invocation (as `gate:capacity` uses) would change any pinned value; the safe assumption per prompt §3 is to preserve subprocess isolation for this gate's Rust-equivalent harness unless proven unnecessary by a targeted differential check.
8. **No concurrency-determinism tests exist anywhere in the current TypeScript-only codebase** — this is expected (it is Rust-port Stage 2/3+ work per prompt §6), but it means there is no existing pattern to imitate for thread-count parameterization; every subsystem's (d) column above must be designed from the prompt's §14/§18.4 principles directly, not adapted from an existing TS harness.

None of these gaps blocks Stage 0. They define exactly where the Rust migration's new-test investment (prompt §18 TDD requirement) must land before Stage 2 can claim "exact one-thread parity" with confidence rather than end-to-end-only confidence.

---

## 25. Open questions

1. Whether `gate:compact-nine-baselines`'s subprocess-per-case architecture must be reproduced exactly by the Rust differential harness, or whether in-process invocation can be proven behaviorally equivalent — needs a targeted differential check before Stage 5 packaging locks in the harness shape (§24 item 7).
2. Differential handling of non-archive requests is resolved: Rust and differential execution are restricted to archive-eligible Compact and Compact Short Side jobs. An explicit ineligible Rust or differential request fails before execution. TypeScript remains the explicit maintained selection for request shapes outside that scope.
3. Whether `canonicalGridPointOnSegment` (`canonicalGridMath.ts:173-186`, S8) — confirmed to have zero production callers anywhere in `src/` — should be ported as faithfully-unreachable code or explicitly ruled droppable; needs an orchestrator ruling before Stage 2 per prompt §2's "prove completely unobservable" bar.
4. Whether new TS characterization tests recommended throughout this document (S2's error-mapping table, S9's `sortPiecesForNesting`/`irregularScoreGrid` boundary tests, S12's BigInt-exact comparator fixtures, S17's `intrinsicShortSideAxes` direct test, S18's modern-multi-frame `expandSharedArchiveSelectedLayoutReveal` case) should be authored as a dedicated pre-Stage-2 TS-test-hardening pass, or written directly as part of each Stage-2 Rust differential test's TS oracle setup — an implementation-sequencing decision, not a semantics question, but worth an explicit ruling so the two are not duplicated or skipped.
