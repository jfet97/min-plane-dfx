# Rust Irregular Quality Acceptance

## Superseding 2026-07-31 maintenance-first decision

The earlier exact-V8 `Math.hypot` requirement and custom implementation are
historical and superseded to remove maintenance burden. Production calls now
use the single audited `js_math::hypot` boundary backed by Rust's
`f64::hypot`. The exact Node/V8 corpus and cross-backend hashes are diagnostic
comparisons; they do not replace acceptance. Unchanged legality, quality,
capacity, determinism, and supported-platform gates remain blocking. This
change does not claim a candidate result that has not run. Performance
improvement is not required; absence of a material regression is sufficient.

Historical exact-V8 evidence remains below and is labeled as superseded where
its former production requirement or promotion consequence is discussed.

## Post-PR27 policy

This follow-up policy supersedes PR27's performance-gated opt-in product decision.
Automatic routing is the requested product policy for archive-eligible profiles
that pass the complete quality matrix and native capability preflight. P2, P3,
and P5 retain their original thresholds and must still be reported honestly;
a failure or blocked authoritative measurement does not silently change runtime
routing or count as a performance pass. Explicit
`MIN_PLANE_IRREGULAR_BACKEND=typescript` remains the immediate rollback.

The TypeScript irregular backend remains the reference oracle for diagnostic
comparison and the rollback path. The Rust backend is accepted through two
independent lanes:

1. The exact semantic differential comparator remains diagnostic and unchanged.
   It compares the complete success or typed-failure projection, including
   ordered geometry, scores, traces, ledgers, checkpoints, histories, hashes,
   and typed failure context. A layout difference is reported with its first
   deterministic path; accepted quality does not erase that diagnostic.
2. A quality acceptance lane evaluates backend-aware hard invariants and the
   existing quality thresholds. It may accept a legal Rust layout that differs
   from TypeScript when every hard invariant and unchanged threshold passes.

The quality lane has exactly four outcomes:

- `exact-match`: semantic projections match and both layouts pass quality.
- `different-but-quality-accepted`: semantic projections differ, but the Rust
  layout is legal and passes quality acceptance.
- `quality-regression`: no hard invariant failed, but an unchanged quality
  threshold regressed.
- `hard-invariant-failure`: legality, accounting, topology, capacity,
  scheduler/coordinator chronology, directional Short Side, or required
  cohesion invariants failed.

Hard invariants take precedence over quality thresholds. Threshold boundaries
remain inclusive where the historical gates are inclusive: a minimum placed
count is accepted at the minimum, and maximum area or cavity limits are
accepted at the maximum. Existing TypeScript hashes, identities, counts, traces, tolerances, runtimes,
and historical gates are not changed by this policy. Cross-backend hash
agreement remains diagnostic; hashes recomputed within a required quality
proof remain hard invariants of that proof.

## Reused authorities

`irregularQualityAcceptance.ts` derives quality facts from the existing
production authorities rather than trusting backend labels or supplied geometry.
It uses canonical grid legality, canonical topology, the maintained unsnapped
translated collision-polygon envelope metric, exact placed and unplaced
accounting, capacity lane chronology, and anytime scheduler chronology. Every
placed geometry must belong to the request and caller-supplied prepared-piece
authority. Its source identity, finite transform, authoritative transform
candidate, recomputed polygon, and bounds are checked before provenance passes.

Callers must construct either `makeCompactIrregularQualityPolicy` or
`makeShortSideIrregularQualityPolicy`. These constructors require the exact
eight finite non-negative threshold fields, explicit capacity and cohesion
policy kinds, and reject incomplete policy objects at runtime. A required
capacity policy also requires a fixture-pinned quality warm-prefix expectation,
including explicit undefined values when that lane is absent. The acceptance
runner revalidates the policy and rejects profile mismatches. A Short Side policy automatically requires its selected piece set, caller-owned
prepared/request geometry authority, caller-owned Compact production geometry,
and the accepted directional-construction witness captured by
`onIntrinsicShortSidePairFoldObserverWinner` before final materialization. The
Compact selection and witness must both be legal, provenance-valid, and exact
members of the selected partition. The final returned placements and transformed
geometry must equal the witness in direct ordered comparison. Canonical identity
is not used for this proof because it normalizes translation and quarter turns.
Native pair-fold and observer traces remain semantic diagnostics only. A required
capacity policy rejects missing traces, recomputes selected material, cavity,
envelope, span, and geometry-hash terms from caller-owned geometry authority,
compares every recomputed term with the selected trace objective, checks allowed
endpoint origins and producer identity, validates cold-search accounting,
complete depth coverage, lane chronology, warm continuation restrictions, the
pinned quality warm-prefix status/source/prefix/hash, termination, and configured
cold-only objective dominance. A required cohesion policy rejects missing
evidence, recomputes canonical topology and envelope metrics from returned
geometry, binds every supplied evidence field to those metrics, and checks every
configured promotion constraint, including an explicit inclusive or exclusive
envelope-area bound. Required quality evidence is never replaced by a hardcoded
success value.

Canonical geometry hashes are SHA-256 values over the existing canonical layout
identity and must match the selected trace endpoint. The empty capacity layout
uses the versioned intrinsic-capacity empty-layout identity. The area threshold
uses the maintained inclusive tolerance of `0.000001 mm2` with unsnapped
translated polygon coordinates. Existing TypeScript hashes, identities, counts,
traces, runtimes, and historical gates remain unchanged.

`irregularQualityRunner.ts` executes TypeScript first and Rust second,
sequentially, even when TypeScript returns a typed failure. It preserves both
complete success-or-typed-failure outcomes, compares them through the unchanged
exact semantic comparator, and then classifies the result. Equal typed failures
are retained as `exact-match` diagnostics but are never accepted; mismatched
failures and success/failure divergence remain `hard-invariant-failure` with
semantic divergence preserved. Native capability and archive eligibility
preflight remain the responsibility of the existing backend orchestrator; this
runner never silently substitutes TypeScript.

## Explicit promotion gate

`pnpm gate:quality-acceptance` executes the production-acceptance command in
`scripts/rust-parity/run-quality-acceptance.ts`. The command uses a fixed
complete matrix: `triangle-20`, `mixed61`, and `shapes-17`, each at
`2000x2700`, under both `compact` and `short-side` profiles. The row policy
contains the maintained placed-count, area, cavity, and topology thresholds;
there are no arbitrary request-file or profile overrides on the promotion
command. Unit tests can inject individual rows and backend dependencies to
exercise failure classifications without substituting a TypeScript result for
native execution.

The command is intentionally separate from automatic desktop routing: it
preflights archive eligibility, native capability, and every required native
profile before any backend runs, then runs TypeScript first and Rust second for
each row. It records both backend identities and the first semantic divergence,
and exits nonzero for native unavailability, archive ineligibility, backend
failure, a hard invariant, or a quality regression. It exits successfully only
when every mandatory row is accepted, whether the row is exact-match or
different-but-quality-accepted. The workflow runs this gate only on scheduled
or manually dispatched native verification; it must not be invoked for every
automatically routed production job, because that would duplicate production
work and side effects.

The Short Side promotion decision does not invent topology or area admission
criteria beyond the maintained row thresholds. Runtime `finalizeOutcome` retains
its exact-target identity behavior. Promotion proves directional construction
from the caller-owned accepted witness and direct ordered equality with the final
returned geometry. Construction labels, counters, native traces, canonical
identity, and observer telemetry cannot establish directional success.
