# Unified Intrinsic Anytime Portfolio

This report tracks the staged replacement of Compact capacity v1's serial
complete-then-cold boundary. The production baselines remain the exact artifacts
under `docs/artifacts/current-compact-baselines/`.

## Accepted Contract

The target is one deterministic scheduler and checkpoint protocol around
protected cohorts:

- the legacy complete cohort retains its existing sheetless constructors,
  budgets, retention, and intrinsic winner contract;
- subset lanes may permanently skip pieces and retain their own budgets and
  depth buckets;
- new complete-capable place/defer work remains a shadow cohort until it
  reproduces the accepted complete winners.

The cohorts share exact geometry and endpoint/archive mechanics. They never
share survivor slots or one comparator. Requested-sheet dimensions may decide
legality, q0/q90 fit, scheduling priority, and named diversity buckets. They
must not become an intrinsic compactness preference.

## Stage 1: Resumable Cold Search

The existing `intrinsic-capacity-v1` depth loop now has an optional pause seam.
With no pause quantum, the production call runs through settlement exactly as
before. With a positive quantum it stops only after a completed depth and
returns no endpoint.

The versioned checkpoint binds:

- the complete prepared input, exact material accounting, requested sheet, and
  algorithm version through SHA-256;
- each retained `IrregularBeamState` to disjoint placed, pending, deferred, and
  permanently skipped IDs;
- pending order, cursor, pass and deferral counters;
- exact material, cavity metrics, anchored occupied identity, grid span, and
  q0/q90 fit;
- total, per-depth, and partial-cohort evaluation ledgers;
- scheduler deficit, settlement/censoring state, and no-skip-frontier state;
- every semantic trace counter accumulated before the pause.

Resume rejects a version, fingerprint, producer/cohort, boundary, partition,
geometry identity, fit-mask, material, or budget mismatch. Candidate memoization
is invocation-local and intentionally omitted; it affects only recomputation
cost, not search semantics.

The first Sol review found three checkpoint defects before Stage 2:

- the irreversible pruning incumbent and fixed search bounds were not bound to
  the checkpoint;
- historical quota flags, cumulative counters, and no-skip loss depth were
  under-validated;
- the no-option production path still paid input hashing and checkpoint-ledger
  allocation.

The corrected checkpoint fingerprints and stores the exact incumbent binding
and current v1 bounds, reconciles every depth flag and cumulative counter, and
requires a bounded first no-skip-loss depth. Multi-pause replay and corrupted
counter/quota/incumbent resumes are now tested. Fingerprinting, per-depth ledger
copies, and no-skip checkpoint accounting are lazy and run only when pausing or
resuming; the ordinary no-option production path does none of that work.

The focused test pauses after depth two on a four-piece constrained fixture,
resumes with a fresh cavity cache, and compares the entire semantic trace plus
the ordered endpoint hashes, partitions, and objectives against an
uninterrupted run. Both capacity suites pass. The broader suite still reports
the 35 unrelated baseline failures already documented by capacity v1.

Committed implementation `970ed2be14edb69d41333b8d48377514aab80eed`
passes the strict paired capacity gate. The longest control remains the serial
Mixed-61 `700 x 560` path: production and cold-only arms both place `55/61`,
consume `232,209` placement evaluations, retain zero cavities, and select
canonical capacity identity `0ba279b5...`; total wall times are about `61.76 s`
and `61.65 s`. This stage is semantic infrastructure, not a speed claim.

The initial focused checkpoint/capacity suites passed `24/24` in `1.46 s` wall,
`3.32 s` user, and `0.65 s` system time with `160,989,184` bytes maximum
resident set. Immutable reports, SVG/PNG renders, hashes, and environment
metadata are under
`/private/tmp/min-plane-provenance/intrinsic-checkpoint-970ed2b-pMI3QZ/`.
After the review corrections, the expanded focused suites pass `25/25`.

## Stage 2: Observer-Only Pressure and No-Skip Probe

The coordinator now has an explicit benchmark-only
`captureCapacityShadowTelemetry` option. When enabled, it records two
scale-free exact pressures from the proof preflight:

- minimum summed collision area divided by requested-sheet area;
- the worst piece's best q0/q90 axis-span pressure.

Both ratios are integer parts per million rounded upward. They are observations,
not feasibility proofs beyond the existing raw-area and singleton checks.

The same option runs an independent cold lane for at most four completed depth
boundaries and returns its checkpoint's no-permanent-skip frontier state,
first-loss depth, evaluation count, and elapsed time. The probe has a fresh
cavity cache, no incumbent, and no access to the production result. Its output
declares `routingInfluence: none`; no production call enables it by default,
and no routing, ranking, survivor, or terminal-selection code reads it.

The constrained three-square integration falsifier observes collision-area
pressure `1,098,221 ppm`, singleton-span pressure `605,040 ppm`, and first
no-skip loss at depth two while producing byte-for-byte identical placements,
unplaced IDs, routing, and termination to the unobserved control.

Committed implementation `63126a8afd0b06ab60e336e54d57e335aaf5b0e7`
passes the strict paired capacity gate. On the longest Mixed-61 `700 x 560`
case the four-depth probe consumes `3,195` evaluations and about `58 ms`, while
the unchanged production path still spends about `52.09 s` in the complete
archive and `8.78 s` in its later `232,209`-evaluation cold search. Production
and cold-only arms retain `55/61` and capacity identity `0ba279b5...`.

The full gate takes `132.78 s` wall, `142.82 s` user CPU, `0.75 s` system CPU,
and reports `1,019,691,008` bytes maximum resident set size. Immutable report,
manifest, SVG, PNG, and hashes are under
`/private/tmp/min-plane-provenance/intrinsic-shadow-telemetry-63126a8/`.
The rendered Mixed-61 image has visible background on all four sides with no
truncated polygon.

## Stage 3: Protected Warm-Prefix Shadow Lanes

Each captured descriptor that passes exact endpoint materialization at q0 or
q90 can now seed an independent `capacity-warm-prefix` lane. Seed validation
rechecks that the state is a skip-free exact prepared-order prefix, has the
expected pending suffix, fits the requested sheet, and has exact material,
cavity, span, and anchored-identity accounting.

Warm lanes use the same place-or-permanently-skip depth loop and versioned
checkpoint protocol as the cold lane. Their fingerprint additionally binds the
source role, prefix depth, placed and pending IDs, and anchored occupied
identity. A warm checkpoint cannot resume as a cold producer or from another
prefix. Reused depths have zero evaluation ledgers; later depths retain the
ordinary per-depth and total bounds.

This stage remains benchmark opt-in. Every fitting descriptor receives its own
frontier, cavity cache, and full protected capacity budget. The empty-start
cold lane still runs first with unchanged inputs and remains the sole search
lane admitted to final selection. Warm endpoint quality, reused placement
count, evaluations, completed depth, and elapsed time are reported only in
`warmPrefixLanes`.

Focused tests prove warm pause/resume equivalence and that enabling warm
observers leaves the cold trace, placed geometries, and unplaced IDs unchanged.

The first gate launch was stopped after `6.73 s` because the gate report
projection omitted `warmPrefixLanes` even though the observers executed. It is
not comparable evidence. The reporter was corrected and committed before the
measurement was restarted.

The committed artifact-capable measurement at
`68168bc3692e73e65553c40af60cacc961cb2170` proves that continuation has
material value on the prior serial regression:

- the unchanged cold lane consumes `232,209` evaluations in about `9.01 s`
  after approximately `51.90 s` of complete construction and places `55/61`;
- `canonical-grid@30` reuses 30 placements, consumes `121,012` evaluations in
  about `6.02 s`, and places `59/61`;
- `open-pocket-first@30` reuses 30 placements, consumes `120,972` evaluations
  in about `6.07 s`, and also places `59/61`;
- on Triangle-20, no warm lane beats cold: the one count tie has a worse exact
  partial compactness objective.

The strict full paired run at reporter commit `4ac2707` passed in `181.86 s`.
The artifact-capable Mixed-only rerun passed in `165.72 s` wall,
`178.86 s` user CPU, and `0.90 s` system CPU, with `1,081,524,224` bytes
maximum resident set size. Immutable exact source/input archives, report,
checksums, all six warm SVGs, and inspected cold/best-warm PNGs are under
`/private/tmp/min-plane-provenance/intrinsic-warm-prefix-68168bc/`.

This result promotes warm continuation as scheduler-worthy work, not as a new
unprotected production winner.

## Stage 4: Deterministic Protected Scheduler V1

The first scheduler increment is deliberately coarse and opt-in. It establishes
the ownership and continuation contracts before attempting finer-grained
producer interleaving:

1. the protected empty-start cold lane receives one four-depth quantum;
2. its paused checkpoint carries a scheduler deficit bound into the request
   fingerprint and resume validator;
3. the unchanged sheetless legacy complete cohort receives its full protected
   settlement quantum;
4. a fitting complete endpoint cancels capacity work and returns the exact
   legacy complete winner;
5. after an uncensored complete miss, verified warm-prefix lanes settle
   independently, their exact endpoints become partial candidates, and the cold
   lane resumes its existing checkpoint rather than restarting from empty.

The trace records every protected quantum, the initial cold evaluation ledger,
checkpoint reuse, warm admission, and the cancellation reason. Complete and
partial states still have disjoint frontiers, budgets, and comparators. Warm
endpoints are admitted only after the settled legacy cohort produces no fitting
complete endpoint. The scheduler remains disabled unless the experiment option
is selected.

Focused integration tests cover both terminal branches: a complete miss proves
that the cold checkpoint is reused and warm endpoints are admitted without
losing placed/unplaced accounting; a roomy complete fit proves placement
identity with the scheduler disabled and records capacity cancellation.

## Remaining Stages

1. Share exact endpoint/archive storage mechanics while preserving separate
   namespaces and selection keys.
2. Add place/defer transitions only in an experimental complete-capable shadow
   producer and judge promotion against the full baseline matrix.
