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

The accepted implementation caches IFP's plain structural result through the
same single store. Transformed geometry instead materializes its existing
public domain object once before storing, preserving historical hit identity
without repeated nested schema construction. Both public operations remain
deferred with `Effect.suspend`, and typed invalid/infeasible outcomes are
adapted only at the service shell. The full suite and a separate strict
sequential 18-layout run preserved every production identity and contract.

See
[`../research/pure-irregular-core-stage2.md`](../research/pure-irregular-core-stage2.md)
and
[`../artifacts/pure-irregular-core-stage2/`](../artifacts/pure-irregular-core-stage2/).

## 2026-07-27: separate trusted carriers from boundary schemas

Stage 3 removes `Schema.Class` inheritance from sixteen geometry and search
carriers constructed inside trusted worker computation. Named schemas remain
the validation authority at IPC, replay, persistence, export, and other
untrusted boundaries.

The change is accepted because the full suite and strict sequential 18-layout
gate preserved every production identity and contract. TypeScript symbol
resolution covers direct, namespace, renamed, and transitively re-exported
schema references, and deterministic clocks prove that incomplete phase
instrumentation is still detected. One paired matrix also observed every
layout running faster, with `12.52%` lower aggregate elapsed time, but that
single pass is recorded as supporting evidence rather than a statistical
performance guarantee.

See
[`../research/pure-irregular-core-stage3.md`](../research/pure-irregular-core-stage3.md)
and
[`../artifacts/pure-irregular-core-stage3/`](../artifacts/pure-irregular-core-stage3/).

## 2026-07-27: memoize strict validation only while exact coordinates are unchanged

Strict boundary validation stays the authority over what is a valid ring. What
changes is how often the warm pairwise NFP path re-establishes a conclusion it
already holds.

The check is quadratic, because a consistent turn sign does not imply a simple
ring, and one warm resolution previously ran it four times: both inputs, the
boundary read back from the cache, and the translated ring. Reported cache
telemetry puts `98.2%` of pairwise lookups on that warm path. An exact linear
coordinate fingerprint now guards every identity-memoized validation result, so
runtime mutation forces revalidation; foreign and malformed values still take
the full check. The canonical ring key builds each vertex key once rather than
three times.

The original identity-only experiment was rejected during review because
TypeScript `readonly` does not enforce runtime immutability and its retained
artifact bundle did not contain the raw SVGs or reports needed to substantiate
all provenance claims. The hardened design detects valid-to-invalid and
invalid-to-valid mutation, and an independent oracle-side classifier proves the
canonical-key corpus exercises the reverse selection branch. Fresh final-commit
gates accepted the hardened design: `895` tests passed, and all `18` layouts in
the strict sequential Compact and Short Side matrix passed and rendered on
source commit `59fa2220600c89002b2cbdd7ae4e3ccf6d7591cc`. One same-host
Mixed-61 pair observed an `8.96%` reduction; identity preservation, not that
single timing, is the acceptance authority.

The translated ring is still validated: it is a fresh array and float
translation can round vertices into collinearity. Replacing the quadratic
simple-ring test with an `O(n)` turning argument remains open, and is deferred
because it would change which inputs produce which rejection message.

See
[`../research/trusted-ring-validation-memo.md`](../research/trusted-ring-validation-memo.md)
and
[`../artifacts/trusted-ring-validation-memo/`](../artifacts/trusted-ring-validation-memo/).
