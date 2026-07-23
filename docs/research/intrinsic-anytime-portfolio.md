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

The focused test pauses after depth two on a four-piece constrained fixture,
resumes with a fresh cavity cache, and compares the entire semantic trace plus
the ordered endpoint hashes, partitions, and objectives against an
uninterrupted run. Both capacity suites pass. The broader suite still reports
the 35 unrelated baseline failures already documented by capacity v1.

## Remaining Stages

1. Add scale-free pressure and bounded no-skip-frontier probe telemetry without
   changing routing.
2. Continue verified fitting prefixes in independent protected shadow lanes
   while retaining the empty cold lane.
3. Interleave protected complete and capacity checkpoints in deterministic
   quanta.
4. Share exact endpoint/archive storage mechanics while preserving separate
   namespaces and selection keys.
5. Add place/defer transitions only in an experimental complete-capable shadow
   producer and judge promotion against the full baseline matrix.
