# Irregular Nesting Roadmap

This is the active forward roadmap for convex irregular nesting after the
`600 x 400` baseline replacement at `7b71611`.
It contains only uncompleted work. Architecture and current behavior
live in [`../architecture/irregular-v2-infrastructure.md`](../architecture/irregular-v2-infrastructure.md);
past decisions live under [`../history/`](../history/README.md).

## Current Production Boundary

The Compact quality profile runs the intrinsic shared archive directly. Three
sheetless direct constructors and a bounded repeated-family periodic portfolio
submit only complete canonical-exact endpoints. The archive deduplicates and
ranks those endpoints without sheet dimensions, filters them by requested-sheet
q0/q90 fit, and selects one fitting winner. It has no ordinary-beam competitor,
ordinary-beam fallback, fixed reference sheet, or
`canonicalReferenceDecodeEnabled` flag.

The ordinary requested-sheet decoder remains available when the shared archive
is not explicitly eligible, including intentional `short_side_fill` and active
GA configurations.

Current exact production baselines are:

| Fixture | Sheet | Placed | Envelope area | Cavities | Runtime | PNG |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Triangle-20 | `2000 x 2700` | 20/20 | `74,428.143126 mm2` | 0 | `12.702 s` | [`triangle-20-2000x2700.png`](../artifacts/current-compact-baselines/triangle-20-2000x2700.png) |
| Mixed-61 | `2000 x 2700` | 61/61 | `391,605.850174 mm2` | 0 | `52.535 s` | [`mixed-61-2000x2700.png`](../artifacts/current-compact-baselines/mixed-61-2000x2700.png) |
| Shapes-17 | `2000 x 2700` | 17/17 | `304,499.845650 mm2` | 0 | `6.489 s` | [`shapes-17-2000x2700.png`](../artifacts/current-compact-baselines/shapes-17-2000x2700.png) |
| Triangle-20 | `600 x 400` | 20/20 | `74,428.143126 mm2` | 0 | `12.761 s` | [`triangle-20-600x400.png`](../artifacts/current-compact-baselines/triangle-20-600x400.png) |
| Mixed-61 | `600 x 400` | 24/61 | `232,800.043098 mm2` | 0 | `3.726 s` | [`mixed-61-600x400.png`](../artifacts/current-compact-baselines/mixed-61-600x400.png) |
| Shapes-17 | `600 x 400` | 13/17 | `228,616.694352 mm2` | 1 | `9.326 s` | [`shapes-17-600x400.png`](../artifacts/current-compact-baselines/shapes-17-600x400.png) |

Runtime observations are from one sequential strict run at `7b71611` on
2026-07-23, Node `v24.16.0`, V8 `13.6.233.17-node.49`, macOS arm64. They are
measured baselines, not deterministic acceptance thresholds. The executable
gate is `pnpm gate:compact-six-baselines`; reports and renders are in
[`../artifacts/current-compact-baselines/`](../artifacts/current-compact-baselines/).

Do not substitute the earlier sheetless Mixed experiment hash `3839e80d...`
for the fitted production hash. Do not use the retired fixed-reference
`430,344.917527 mm2` result as a current production baseline.

Two fresh current-production decodes on `900 x 1800` and `1000 x 1300`
produced byte-identical SVGs (SHA-256 `febad20a...`). That is a preliminary
two-sheet observation only. The full matrix was cancelled before completion,
so current ten-sheet invariance is not established.

## Priority Order

### P0: Add exact constrained-sheet capacity mode — implemented

`intrinsic-capacity-v1` is implemented and gated. The sheetless complete
archive is preserved for every request whose best complete motif fits; the
proof-only preflight bypasses complete construction only for exact
area-sum or singleton impossibility; a valid bounded complete archive miss
routes into the separate empty-start subset search; at most nine committed
sheetless direct-constructor prefixes terminalize into zero-placement-
evaluation incumbents that prune only through the strict attainable-count
and material-area bounds. Focused falsifier tests live in
`tests/unit/intrinsicCapacityMode.test.ts` and
`tests/unit/intrinsicCapacityIntegration.test.ts`; the constrained fixture
gate is `pnpm gate:capacity`.

The reviewed contract, implementation decisions, fixed first-version bounds,
endpoint accounting, traces, falsifiers, runtime worst case, and the still
deferred identical-sheet continuation are recorded in
[`intrinsic-capacity-mode.md`](./intrinsic-capacity-mode.md). Implementation
evidence is in
[`../research/intrinsic-capacity-mode-implementation.md`](../research/intrinsic-capacity-mode-implementation.md).

The first version does not close the inconclusive-sheet double-work problem:
captured exact prefixes become terminal incumbents, not continuation states.
The accepted next revision is a stratified anytime portfolio: first make the
cold lane checkpointable, then add shadow pressure/no-skip telemetry, protected
warm-prefix lanes, deterministic complete/capacity scheduling, shared exact
archive mechanics, and only then a place/defer complete-capable shadow
producer. A fixed `10%` waste route is rejected because it misses both measured
serial-cost cases. Heuristic pressure may schedule protected work but may not
prune, rank, or displace the legacy complete cohort.

The checkpoint, observer-only telemetry, protected warm-prefix seams, and first
deterministic scheduler are implemented. The telemetry
path is benchmark opt-in, records exact scale-free pressure and a bounded cold
no-skip-frontier probe, and cannot affect routing or endpoint selection. The
warm path independently continues every verified fitting captured prefix with
its own checkpoint, frontier, cache, and budget. The opt-in scheduler grants a
four-depth quantum to the empty cold lane before the unchanged complete cohort;
a fitting complete endpoint cancels capacity, while a complete miss resumes the
same cold checkpoint and admits independently settled warm endpoints to the
partial archive. Complete and partial states never share survivor slots or a
comparator. The next measurable step is shared exact archive mechanics with
separate namespaces.

That shared storage boundary is now implemented: complete and partial
namespaces reuse exact validation/deduplication mechanics while retaining their
own ranking and duplicate policies. Terminal selection encodes fitting-complete
dominance without flattening the archives. The remaining experimental step is
the protected place/defer complete-capable shadow producer.

That Stage 6 producer is now implemented behind an observer-only option. Its
single deterministic transition defers the first pending piece to a second
pass, and its versioned checkpoint binds the disjoint future-decision state and
protected evaluation ledger. Only a complete skip-free exact result can become
an experimental endpoint; it still cannot enter the settled legacy archive.
Promotion remains blocked on the full matrix.

### P0: Freeze the archive-only correctness and quality gate

Establish the archive-only baseline before changing allocation or search.

Scope:

- reproduce Triangle-20, Mixed-61, and Shapes-17 twice from clean current-main
  inputs;
- establish current archive-only results for mixed-50, rectangles, trapezoids,
  pentagons, stars, and the other maintained corpus cases;
- preserve exact endpoint status, source selection, legality, canonical hash,
  area, cavity, runtime, and render provenance;
- make the focused gate automatic for later algorithm experiments.

Dependencies: none beyond `b506344` and the existing fixtures.

Falsifiers: nondeterministic endpoint or source order, a changed golden hash or
area, any unplaced piece, nonzero canonical cavity in the three current
baselines, invalid geometry, runtime censoring presented as completion, or a
render that disagrees with the reported geometry.

Acceptance gate: two clean reproductions; exact Triangle and Shapes unit
goldens; the Mixed production gate; deterministic portable reports, manifests,
and SVG/PNG evidence; and a recorded current corpus baseline.

### P0: Complete current production sheet-invariance verification

Run the historical roomy-sheet dimensions against the current archive-only
production path. Classify each requested sheet by whether the same sheetless
leader fits at q0 or q90 before comparing final geometry.

Dependencies: the frozen identities and uncensored execution from the previous
item.

Falsifiers: different sheetless archive selection on two requests where the
same leader fits; different canonical geometry or normalized SVG; source-set or
endpoint changes caused by runtime censoring; or a divergence that cannot be
explained by the requested-sheet fit boundary.

Acceptance gate: repeat the complete matrix and obtain one canonical geometry
wherever the same leader legally fits. Any fit-boundary divergence must be
reproducible and documented. The existing two-sheet observation does not satisfy
this gate.

### P1: Profile and accelerate the stable archive path

Profile cold production before changing work allocation. The current measured
references are approximately `16.621 s` for Triangle, `268.978 s` for Mixed,
and `27.271 s` for Shapes-17. The `390 s` worker timeout floor is the current
safety boundary, not a performance target.

The first measurement is a fresh cache-disabled, production-equivalent
Mixed-61 run in separate serial processes. Record direct-role runtimes, catalog
and source-selection phases, strict periodic construction, per-continuation
runtime/status/evaluation counts, finalization, archive ranking, and timing
coverage. Historical filtered evidence points to strict construction as the
dominant phase, but it is not current proof. If the fresh run confirms that
result, split the opaque construction phase into candidate generation versus
state construction/scoring before choosing an optimization.

Checkpoint `54b437a` completed that measurement and the first cold-path
optimization. On the clean `4f3ddb8` baseline, two serial Mixed-61 samples put
direct-plus-periodic work at `251,188-253,774 ms`; two exact-commit optimized
samples put it at `244,420-248,283 ms`. The medians improve from `252,481 ms` to
`246,352 ms` (`-2.43%`), with non-overlapping ranges. Strict-construction
medians improve from `158,551 ms` to `154,347 ms` (`-2.65%`). The optimization
removes a redundant complete-layout hull calculation from local envelope
ranking; it preserves selected sources, budget settlements, archive order,
q0/q90 fit, hashes, all three fixture identities, and the current two-sheet
invariance sample. Full evidence is in
[`../research/intrinsic-shared-archive-performance-checkpoint.md`](../research/intrinsic-shared-archive-performance-checkpoint.md).

The candidate-state split and first major optimization are complete. On the
exact `a57894c` Mixed profile, bottom-left state realization consumed
`125,999 ms` of `134,314 ms` candidate scoring. Commit `70b8a6d` computes the
same anchored comparison identity without rebuilding discarded states and
anchors only the retained winner. Construction improves from `143,042 ms` to
`21,669 ms` (6.60x), while the periodic phase improves from `162,386 ms` to
`42,375 ms` (3.83x), with identical archives, hashes, and SVG.

Nested timing must remain explicitly enabled by the benchmark harness and
default off in production, independently of deterministic evaluation caps.
Semantic execution and budget-settlement flags must remain available even when
timing is disabled.

The version-3 same-process replay contract is also complete. It binds algorithm
version, scope, optional basis-source restriction, prepared input, eligible
source domain, and replay content, then reconstructs each crop from its current
cell and revalidates membership, legality, identity, topology, and metrics.
Completeness requires the expected replay digest from a separately trusted
channel, and only regenerated current-cell seeds continue downstream. Every
invalid entry falls back cold without consuming the cold continuation budget.
Replay-envelope export remains explicit so ordinary production audit runs do
not pay cache-artifact construction. Keep durable Electron persistence deferred
unless repeated-job measurement shows enough practical value. The exact
`f65a4e5` trusted pair measures a 1.210x periodic and 1.162x combined warm gain
with the same archive, hash, metrics, and byte-identical winner SVG. The earlier
1.224x periodic and 1.170x combined figures remain historical version-2
evidence, not the current replay contract.

The next performance pass should profile the new 21.7-second construction
floor before changing behavior. Current single-sample buckets point to
placement-object materialization (`6.7 s`), anchored canonical-key derivation
(`4.9 s`), and candidate generation (`8.3 s`); none should be optimized without
a repeated serial profile and the same exact-output gates.

Dependencies: freeze the current allocation and acceptance corpus for this
work. If the later allocation audit changes either, remeasure before accepting
the change.

Falsifiers: changed selected sources, status tuples, archive order, endpoint
hashes, fit orientation, or legality; new deadline censoring; or a speedup
obtained by omitting accepted search work.

Acceptance gate for every performance-only change: freeze ordered selected
source ids; direct and periodic status/evaluation tuples; coverage and
production-validity flags; ordered sheetless and fitted archives with roles,
sources, metrics, certificates, and hashes; q0/q90 fit classifications and
selected rotation; and the three current exact fixture identities. Preserve the
two-sheet invariance sample immediately and the full matrix once established.
Require repeated serial timings with dispersion and report cold and warm/cache
improvements separately. Any better layout belongs to a separate search-quality
experiment rather than equivalence evidence.

### P1: Audit periodic source allocation

Compare the current cold `P2 + axis-union` allocation with exhaustive raw-source
enumeration, a validated warm replay of that exhaustive control, and pre-front
source-stratified reservations. Reservations, if tested, must act before global
raw Pareto reduction and truncation.

This is now an allocation falsifier, not a prerequisite for the performance
work above or for the already-integrated production path. Close it without
implementation if the current allocation passes the full gates and no valuable
source is demonstrably excluded.

Dependencies: completed correctness, corpus, and sheet-invariance baselines;
fixed continuation/evaluation caps; explicit separation of sheetless and fitted
hashes.

Falsifiers: inert reservations, unstable candidate domains, loss of the current
Triangle or Mixed winner, loss of the `405,773.434053 mm2` direct pocket-first
fallback, or any corpus/invariance regression.

Acceptance gate: stable repeated domains and hashes, measured non-inert
eligibility, preserved current floors and direct fallback, and either a strict
archive-quality improvement or a simpler allocation with equivalent accepted
outputs.

### P2: Test cavity-first commensurate two-piece scheduling

For one exact live gap and one alternate geometry class, compare
`scheduled -> alternate` with `alternate -> scheduled`, then rejoin only after
both branches have placed the same two geometry classes. Define opportunities
from live cavity/gap geometry and fit, never fixture names, piece counts, or an
unbounded free queue.

Dependencies: stable shared archive and allocation policy; exact gap geometry;
fixed equal budgets.

Falsifiers: no real opportunities, no commensurate survivor, or no distinct
canonical-exact archive improvement under the preregistered budget.

Acceptance gate: a deterministic exact endpoint that strictly improves the
accepted archive without regressing Triangle, Mixed, Shapes-17, the wider
corpus, or requested-sheet fit behavior.

### P3: Try bounded archive-seeded destroy and repair only if triggered

If cavity-first scheduling fails or complete constructors repeatedly preserve
the same weak topology, remove one cavity-adjacent or conflict-connected subset
from an exact archive endpoint, freeze the complement, and reconstruct the
subset through the strict decoder. Bounded insertion, reversal, or
geometry-derived order rebuilds belong inside this experiment rather than as a
separate roadmap stage.

Dependencies: the trigger above, the common exact archive, and a rerun proving
that the corrected sampled-relocation primitive retains its claimed Mixed
movement advantage.

Falsifier: zero qualifying canonical-exact improvements at the fixed evaluation
budget closes this branch.

Acceptance gate: a strict exact archive improvement, unchanged incumbent
fallbacks, deterministic accounting, and no relaxed or SAT-only state crossing
the canonical admission boundary.

## Evidence-Triggered Backlog

These are not active stages:

- Hull-guided proposal ordering reopens only if profiling proves proposal
  volume dominates. Because it changes which work survives a cap, it requires a
  search-policy ablation rather than being treated as a free optimization.
- Bounded GA reopens only after traces demonstrate an order/rotation bottleneck
  that deterministic construction cannot expose. Earlier GA runs were roughly
  `4.3-6.4x` slower, helped rectangles, and did not protect Mixed topology.
- Oblique bases, P3+ periodic cells, or motif-of-motifs crops reopen only after
  a coverage-complete P1/P2 failure on a known compact motif proves a
  representation gap. P2 already expresses the Triangle witness.

## Disposition of the Previous Eleven Items

| Previous item | Disposition |
| --- | --- |
| Pre-front reservations | narrowed to the P1 allocation falsifier |
| Repeated-fixture allocation falsifier | merged into the P0/P1 gates |
| Full corpus, sheet, and Shapes-17 gate | split into the two P0 gates |
| Cavity-first scheduling | retained as P2 |
| Archive-seeded destroy and repair | retained as conditional P3 |
| Deterministic stagnation kick | merged into bounded P3 disruption variants |
| Hull-guided steering | removed as an active stage; evidence-triggered only |
| Optional bounded GA | removed as an active stage; evidence-triggered only |
| Broader periodic representation | removed as an active stage; evidence-triggered only |
| Production replay-cache policy | merged into P1 performance work if replay is promoted |
| Performance improvement | retained as P1 after the baseline is frozen |

The former duplicated “Immediate Next Action,” fixed-reference follow-ups,
trace-size work already completed by bounded trace detail, and an independent
“avoid local repair” goal are not forward roadmap items. The compact archive
does not use the ordinary decoder's terminal repair as a fallback.
