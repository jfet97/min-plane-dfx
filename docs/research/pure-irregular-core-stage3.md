# Pure Irregular Core Stage 3

## Decision

Retain the separation between trusted runtime geometry carriers and Effect
Schema boundary models.

Sixteen geometry/search carriers that were constructed inside trusted worker
computation are now ordinary TypeScript classes. Each has a separately named
exported schema for IPC, replay, persistence, export, and other untrusted
decoding boundaries. Settings and terminal boundary envelopes remain
schema-backed where they are decoded or emitted; this stage does not claim the
whole search is already Effect-free.

Source commit: `d258acf6286145da7551abfceb3e31d260080deb`.

## Boundary proof

The converted runtime carriers include points, bounds, polygons, placement and
transform values, collision and flattened geometry, prepared pieces, NFP/IFP
results, free-material diagnostics, priority keys, and geometry-cache keys.

The boundary gate uses the TypeScript AST to prove that every listed runtime
class has no heritage clause and has a separately exported schema. It also
rejects imports of those schema symbols from trusted algorithm and geometry
modules, except the named service boundary that decodes inputs. Runtime
assertions confirm that boundary decoding produces ordinary structural
records and retains the existing finite/ordered validation failures.

## Correctness evidence

Lint and node/renderer typechecks passed. The complete suite passed `881`
tests with `17` intentional skips. The first full-suite attempt exposed the
existing machine-dependent phase-coverage assertion; the test now compares
the reported flag with the production coverage classifier instead of demanding
that one scheduler-sensitive timing sample always classify as complete.

The strict single-process matrix passed all nine fixture/sheet cases and all 18
Compact/Short Side layouts. Every pinned identity and production contract
remained exact.

Raw provenance:
`/private/tmp/min-plane-provenance/pure-irregular-core-stage3-d258acf/`.

Portable evidence:
[`../artifacts/pure-irregular-core-stage3/`](../artifacts/pure-irregular-core-stage3/).

## Runtime observation

This was one sequential before/after matrix on the same machine, so it is an
observation rather than a statistically repeated benchmark. Against the
immediately preceding Stage 2 run, every one of the 18 layouts was faster:

- aggregate elapsed time: `157,588.357 ms` to `136,977.417 ms`;
- aggregate reduction: `13.08%` (`1.1505x`);
- per-layout speedup range: `1.1036x` to `1.3366x`;
- Mixed-61 `2000 x 2700` Compact: `40,303.953 ms` to `36,346.943 ms`;
- Triangle-20 `2000 x 2700` Compact: `4,092.070 ms` to `3,093.484 ms`.

The consistent direction and the exact output parity support promotion, but no
stronger performance guarantee is inferred from a single paired pass.

## Next boundary

Candidate generation still uses an Effect generator and cooperative Effect
checkpoints around otherwise synchronous work. The next portability stage is a
resumable pure candidate-generation state machine advanced by the Effect shell
in deterministic counted quanta. It remains separate from any multi-process or
multi-thread experiment.
