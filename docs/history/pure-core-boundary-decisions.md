# Pure Core Boundary Decisions

## 2026-07-26: separate performance rejection from portability

The reviewed PR #17 checkpoint/cache fast path was rejected as a TypeScript
performance change. Its lazy-equivalent implementation preserved behavior but
measured only `1.03567x` median against a preregistered `1.05x` threshold.

That result does not reject the independent requirement that algorithm
internals become portable and Effect-free. Stage 1 therefore extracted the
complete cached pairwise NFP operation for architectural value, without
claiming a speedup. The extraction includes its structural hull, robust
predicate inputs, keying, cached-value validation, cache mutation, translation,
and explicit outcomes; a direct-import-only façade was rejected because it
would leave transitive Schema dependencies.

Effect remains the lazy worker shell. `GeometryCacheLive` owns one synchronous
store, public service calls adapt explicit core failures to the existing typed
Effect errors, and candidate generation invokes the core between unchanged
cooperative checkpoints.

The decision is accepted because the full suite and strict sequential
18-layout gate preserved exact behavior. Continue through bounded lower-level
seams; do not attempt a broad algorithm rewrite or use unpaired runtime
observations as promotion evidence.

See
[`../research/pure-irregular-core-stage1.md`](../research/pure-irregular-core-stage1.md)
and
[`../artifacts/pure-irregular-core-stage1/`](../artifacts/pure-irregular-core-stage1/).

## 2026-07-27: preserve cache ordering while expanding the pure seam

Stage 2 moves rectangular IFP bounds and transformed-collision cache resolution
into the structural core. It does not normalize their different historical
event orders: IFP validates before cache access, while transformed geometry
performs key/get before miss-path validation. This distinction is frozen by an
independent current-main oracle.

The accepted implementation caches plain structural values through the same
single store, defers public operations with `Effect.suspend`, and adapts typed
invalid/infeasible outcomes only at the service shell. The full suite and a
separate strict sequential 18-layout run preserved every production identity
and contract.

See
[`../research/pure-irregular-core-stage2.md`](../research/pure-irregular-core-stage2.md)
and
[`../artifacts/pure-irregular-core-stage2/`](../artifacts/pure-irregular-core-stage2/).
