# Stage 0 Orchestrator Rulings

Binding answers to the open questions raised by the characterization corpus and
design docs. Implementers follow these unless a later ruling supersedes them in
this file. Authority: the user delegated decisions for this migration to the
implementing agent ("I do approve everything", 2026-07-28); the migration
prompt's semantic-freeze rules remain supreme and no ruling below may weaken
them.

## Scope

- **R1 — Dead and probe-only modules are out of Rust scope.** All 18 modules
  with DEAD / PROBE-ONLY verdicts in `characterization/aux-modules-liveness.md`,
  plus `intrinsicPlaceDeferCompleteShadow.ts` (opt-in, `outputInfluence: 'none'`;
  enabled by two test call sites and unconditionally by
  `scripts/irregular-capacity-gate.ts:534`, but the gate writes its trace into
  the JSON report without asserting on it, and the gate scripts call the TS
  `computeIrregularNesting` in-process, never a Rust backend — adversarially
  verified 2026-07-29) and the decision-trace event stream where proven
  dead for production defaults (`trace-history.md`), are NOT ported. The
  migration prompt's §5 file list is a reading map, not a scope override;
  proven liveness wins. The TS backend remains the only backend for any request
  outside the archive-eligible Compact / Compact Short Side path.
- **R2 — Backend routing rule.** The Rust backend claims a job only when the
  validated request matches the archive-eligible Compact / Compact Short Side
  production shape (`isIntrinsicSharedArchiveEligible` semantics). Everything
  else routes to TypeScript regardless of configured backend preference.
- **R3 — Faithful port of reachable-but-odd code.** `canonicalGridPointOnSegment`
  (no production callers) IS ported (trivial cost, keeps unit-test parity
  possible). `identityAtQuarterTurn`'s dead `undefined` guard, the
  `protectedSeeds` two-literal role check omitting `'settled-protected'`, the
  asymmetric `candidateEvaluationAccountingComplete` rule (cap keeps `true`,
  deadline sets `false`), and the two differently-guarded doubled-area→mm²
  helpers are all reproduced verbatim, each with a code comment naming the TS
  source line. `extendFreeMaterial` + `'direct-difference'` are ported for
  test parity but excluded from performance work.
- **R4 — Reconstruction caps stay caller-supplied.** The 12,000-eval /
  15,000 ms focused-reconstruction caps live at the orchestrator call site
  (mirroring `computeIrregularNesting.ts:846-847`), not as module defaults.

## Exact semantics

- **R5 — Four canonical-JSON encoders stay four.** The divergent encoders in
  `intrinsicCapacitySearch.ts` (ordinal key sort), `intrinsicStrictDecoder.ts`
  (localeCompare key sort, Map handling), `intrinsicPeriodicFamilyPortfolio.ts`
  (localeCompare, no bigint), and `irregularBeamState.ts` are ported as four
  distinct Rust functions with byte-for-byte differential vector tests each.
  No unification.
- **R6 — Integer arithmetic.** Checked `i128` only where a per-operation bound
  is proven from admission-guard limits; `num-bigint` for ratio comparisons
  (`compareCanonicalGridRatios` cross-multiplies squared magnitudes and
  exceeds i128 at the literal safe-integer bound) and anywhere bounds are
  unproven. Never silent wraparound; overflow-checks stay on in release.
- **R7 — Number→string.** `ryu-js` crate (ECMAScript shortest-round-trip
  algorithm) for every Number that renders into keys, canonical JSON, or hash
  preimages; differential vectors must cover negative zero, exponent-threshold,
  and non-integer cases drawn from real fixture values.
- **R8 — String comparison per call site.** Each call site is routed to its
  exact TS mechanism: UTF-16 code-unit ordering for `<`/default sort (Rust:
  compare by u16 code units, NOT bytes, when non-ASCII is possible), and a
  collator equivalent for `localeCompare` sites. Gate: differential vector
  tests over every string alphabet reachable in fixtures; if fixtures are
  all-ASCII (expected), ASCII ordering satisfies both and the vectors prove it.
- **R9 — robust predicates.** Use the `robust` crate (Shewchuk port) provided
  a caller audit confirms only predicate SIGNS are consumed (adaptive exact
  sign is implementation-independent); if any caller consumes magnitudes,
  translate `robust-predicates@3.0.3` verbatim instead. Differential vectors
  over fixture geometry either way.
- **R10 — Clipper2.** Vendor-translate the used subset of `clipper2-ts@2.0.1-18`
  (Core/Engine/Clipper/Offset: Union/Difference/Intersection/Xor with
  EvenOdd+NonZero and PolyTree64 output; Miter/Polygon offset) into
  `src/clipper/` in the crate. Acceptance: byte-exact vertex sequences
  (including ring order and starting vertex) on a differential vector matrix of
  operation × fill rule × {single ring, multi-ring, holes, collinear,
  self-touching} drawn from real pipeline inputs, plus all downstream
  hash-pinned gates.
- **R11 — Floating-point folds.** Serial left-to-right reduction in original
  loop order for every Number accumulation feeding ranked/serialized values;
  parallel term computation allowed, reduction serial.

- **R21 — V8 trig parity is an open risk, gated end-to-end.** Measured: neither
  Rust std nor libm reproduces V8's Math.atan2/asin/sin/cos/hypot bit-for-bit
  in general (evidence in transforms/generator.rs and flattening.rs module
  docs). Current policy: per-call-site choice backed by that site's own
  differential vectors (generator uses libm for atan2/asin — 100% vector-exact
  on the production-representative matrix; rotate/sin/cos on std — 100%
  vector-exact; flattening carries a documented 1e-9 tolerance on its
  deliberately-adversarial synthetic matrix, ~10⁶× below the 0.001 mm grid
  step). The authoritative gate is the end-to-end differential harness: if any
  pipeline hash mismatch traces to trig, the affected call sites must switch
  to a verbatim port of V8's ieee754 implementations. No tolerance may ever
  migrate into comparators, keys, or hashes.

  **Addendum (2026-07-30, Findings N1/N2 closure): a V8-exact `hypot` now
  exists and is the mandated primitive for any `hypot` reaching a semantic
  field.** `Math.hypot` specifically no longer needs the "neither std nor
  libm reproduces it" tradeoff above — `js_number::js_math::hypot` is a
  verbatim port of V8's own `Builtin_MathHypot` (Neumaier-compensated
  normalized-sum algorithm, not fdlibm's high/low-word-splitting
  `std`/`libm` algorithm), measured `0/21696` bit mismatches against a real
  Node v24 oracle versus `7177/21696` (33%) for `std::f64::hypot` and
  `7468/21696` (34%) for `libm::hypot` on the same vectors. N1
  (`collinear_overlap_segment`'s comparator-flipping edge length) and N2
  (`polygon_perimeter`'s metric-corrupting edge length, plus a fuller audit
  of `canonical_grid::contact`'s and `transforms::generator`'s other
  `.hypot(` call sites) both trace to exactly this divergence — see
  `differential-e2e-report.md`'s N1/N2 addenda for the full evidence trail.
  Ruling, going forward: **any call site whose `hypot` output can reach a
  score, a metric, a comparator tie-break, or a value serialized onto a
  result/trace DTO must route through `js_math::hypot`, not `f64::hypot` or
  `libm::hypot`** — this is no longer a per-call-site tossup between two
  imperfect options the way `atan2`/`asin`/`sin`/`cos` still are (no
  verbatim V8 port exists for those yet); it is a strictly-better drop-in
  replacement with proven full parity. Call sites confirmed to have **no**
  reachable semantic field (pure Rust-only test assertions, or code with
  zero production callers) may stay on `std`/`libm`, each such choice
  documented at its own call site per this ruling's existing "per-call-site,
  evidence-backed" policy.

- **R22 — spatial-index continuation identity ordering — REVOKED 2026-07-30.**
  Originally: the Rust `PlacedCollisionSpatialIndex::continuation_identity`
  sorted bucket rows by parsed (cell_x, cell_y) integer tuples instead of
  replicating TS's unseeded `localeCompare` for the same JSON, and rendered
  `cellSizeMm` via plain `serde_json` `f64` `Serialize` (`"64.0"` instead of
  JS's `"64"`) — per characterization `validation-spatial.md` §12 hazard 1,
  on the premise that this identity never crosses a checkpoint, hash, or
  process boundary and is a same-process self-consistency check whose only
  requirement is internal determinism. A formal carve-out from R8 was
  granted for this single call site on that premise.

  That premise was found false on 2026-07-30: `search::beam_state::IrregularBeamState::continuation_metadata_identity`
  embeds `continuation_identity()`'s string directly, and that embedded
  string is itself part of both `search::strict_decoder`'s
  `IntrinsicStrictDirectCheckpoint.integrityHash` preimage and
  `capacity::search`'s `IntrinsicAnytimeCheckpoint.integrityHash` preimage —
  both cross-language, parity-gated SHA-256 hashes compared byte-for-byte
  against the TS oracle. The carve-out is revoked; `continuation_identity()`
  is now byte-exact against TS `continuationIdentity()` (cell keys sorted via
  `checkpoints::canonical_json::locale_compare_keys`, `cellSizeMm` rendered
  via `checkpoints::canonical_json::json_number_token`). The same
  false-premise pattern was found and fixed in
  `search::beam_state::IrregularBeamState::contact_signature_continuation_identity`
  (also embedded in the same checkpoint preimages via
  `continuation_metadata_identity`), which had both the identical
  `localeCompare`-vs-code-unit-order divergence and a latent `count: f64`
  "1.0"-vs-"1" JSON-number-rendering bug; both are now byte-exact and sort
  via `locale_compare_keys` too.

  Byte-exactness is vector-pinned: `tests/vectors/validation.json`'s
  `spatialIndex` cases now record each case's real TS
  `continuationIdentity()` string directly (asserted in
  `tests/validation_vectors.rs::spatial_index_sequences_match_ts_oracle`);
  `tests/beam_state_vectors.rs` asserts `contactSignatureContinuationIdentity`/
  `continuationMetadataIdentity` byte-exact (previously content-equivalence
  only); `tests/strict_decoder_vectors.rs`'s
  `checkpoint_integrity_hash_matches_ts_after_spatial_index_continuation_identity_fix`
  (previously `#[ignore]`d) and `checkpoint_cases_match_ts` both assert
  `checkpoint.integrityHash` byte-exact; `tests/capacity_search_vectors.rs`'s
  checkpoint case asserts the same for the capacity checkpoint. Fixing the
  capacity checkpoint's `integrityHash` additionally required an unrelated,
  independently-discovered fix in `capacity::search::compare_topology_metric`
  (a missing `compareCapacityBeamEntryAccounting` short-circuit before
  calling `topologyMeasurements.measure()`, which caused extra topology
  measurements — and therefore a diverging `topologyMeasurementCount`/
  `topologyMeasurementMs` in the checkpoint preimage — for every
  `cohesion-frontier`/`cohesion-frontier-shadow`/`quality-frontier` retention
  case with more than one distinct-accounting measured survivor); see that
  function's own doc comment for the full root-cause writeup.

## Checkpoints and timing

- **R12 — Checkpoints are internal-only.** No production serialization of any
  checkpoint was found; no wire-format compatibility is required. Encoding and
  validation semantics (hash preimation builders, curated field projections,
  version strings, corruption rejection) are still ported exactly because they
  affect control flow. The three checkpoint types keep their structurally
  different contracts (including `IntrinsicPlaceDeferCheckpoint`'s missing
  integrity hash — though that type is out of scope per R1).
- **R13 — timingNow seam.** `intrinsicCapacitySearch.ts` receives an additive,
  behavior-preserving test-only `timingNow` seam on the TS side (defaulting to
  `performance.now`) so deterministic-clock differential tests can compare
  timing-bearing diagnostics; explicitly allowed by migration prompt §11.

## Testing and evidence

- **R14 — Differential vectors.** TS oracle vectors are generated by additive
  scripts under `scripts/rust-parity/` (new directory; frozen files untouched)
  and committed under `crates/irregular-nesting-native/tests/vectors/`.
  Vectors serialize BigInt as quoted base-10 strings and record the generating
  commit.
- **R15 — Pre-Stage-2 TS test hardening.** New TS-side characterization tests
  recommended by the parity matrix are authored as part of each Stage-2
  subsystem's differential work (not a separate pass), so oracle and test
  land together.
- **R16 — Durable artifacts live in the repo** (user directive): evidence under
  `docs/planning/rust-irregular-backend/evidence/`, never only under /tmp.

## Boundary

- **R17 — Entry points.** One profile-discriminated execution entry point
  (`runIrregularJob`) plus `nativeCapability`. Progress/history/trace streams
  cross via ThreadsafeFunction from the job's coordinating thread only, never
  from Rayon workers.
- **R18 — Crate workspace wiring.** `crates/irregular-nesting-native` gets its
  npm package.json + pnpm-workspace entry when the Stage-2 differential harness
  first needs to require it from TS, not before (architecture.md default
  confirmed).
- **R20 — validatedRings memo.** The TS process-lifetime trusted-ring
  fingerprint memo becomes a job-local memo in Rust: a hit only skips
  revalidation of byte-identical ring data whose revalidation result is
  deterministic, so job-local scope is observationally identical except for
  time. No cross-job native cache state in the first promoted version.
- **R19 — Cancellation.** The production supervisor kill remains the outer
  mechanism; the native job also honors the cooperative `isCancelled` polling
  seam at the same logical observation points TS has. No new mid-computation
  cancellation points inside functions that have none (e.g. the atomic
  canonical-layout functions).
