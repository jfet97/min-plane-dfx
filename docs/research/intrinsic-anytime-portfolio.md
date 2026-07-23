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

Committed implementation `b5bfa28` passes the strict paired capacity gate. On
Mixed-61 `700 x 560`, the first cold quantum consumes `3,195` evaluations and
the resumed cold lane retains its prior total of `232,209`; it is not restarted
from empty. After the complete miss, `open-pocket-first@30` wins the partial
namespace with `59/61` pieces and exact capacity identity `119d85ce...`,
compared with the protected cold control's `55/61` and `0ba279b5...`. The
Triangle constrained fixture remains tied with cold at `15/20`.

The full paired run passes in `181.97 s` wall, `196.80 s` user CPU, and
`1.02 s` system CPU, with `1,132,445,696` bytes maximum resident set size.
Exact source and input archives, the full report, checksums, SVGs, and an
inspected winning PNG are under
`/private/tmp/min-plane-provenance/intrinsic-scheduler-b5bfa28/`. The render has
visible background on all four sides and no truncated polygon.

Post-measurement review found that this report is not valid scheduler-chronology
evidence: execution settled the resumed cold lane before warm lanes, while the
trace listed warm settlement first; already-settled short cold runs were also
reported as cancelled. The layouts, objectives, evaluation totals, runtimes,
and images remain valid, but the trace transition order is rejected evidence.
The trace now appends transitions at their actual boundaries and a shared
validator/gate falsifier rejects illegal ordinals, duplicate settlement, and
cancellation of already-settled work.

The same measurement also falsifies any Stage 4 speed claim. Checkpoint reuse
removes a restart but not the summed work: the Mixed cold control still pays
about `53.58 s` complete plus `9.07 s` cold, while settling every warm lane
raises the quality arm to about `105.09 s`. This coarse scheduler is useful
continuation infrastructure, not the final solution to serial cost. Finer
complete quanta or a separately justified adaptive handoff remain required.

### Stage 4B: Shared Capacity-Lane Budget

The next opt-in scheduler increment replaces settle-all capacity execution
after a complete miss. The existing four-depth cold checkpoint is retained.
Every verified fitting warm prefix receives one depth-boundary pilot and keeps
its resulting checkpoint. Exact best-known endpoints are materialized from
paused frontiers by reporting all pending pieces as unplaced; this consumes no
new placement evaluations and does not mutate the resumable state.

The revised coordinator reserves one entire single-lane entitlement for the
protected cold checkpoint, preserving the exact cold terminal candidate. Warm
pilots and continuations share a separate single-lane entitlement. After every
pilot, the deepest fitting `canonical-grid` lane is pinned across
depth-boundary resumes until it settles or exhausts that entitlement.
`open-pocket-first` and then `legacy-absolute-envelope` are deterministic
fallbacks only when the preferred producer is unavailable. This is a bounded
producer-prior experiment backed by the existing constrained evidence, not a
general continuation-value predictor. Cavity, envelope, terminal hash, and
requested-sheet compactness remain excluded from scheduling. Cold and warm
states still never share survivor slots.

The aggregate allowance remains twice the existing single-lane bound, and a
new warm quantum starts only when the warm entitlement can reserve all `4,096`
evaluations of one depth. Budget-censored lanes remain explicit retained
checkpoints, and their exact best-known endpoints remain terminal candidates.
Each pilot, resume, and final censor transition records ordinal, lane identity,
from/to depth, evaluation delta, and outcome. The coordinator validator
reconciles these quanta with aggregate consumption and every warm-lane ledger,
and rejects a trace where more than one warm lane exceeds pilot work.

This is a work-reduction hypothesis until the committed full matrix proves the
required `700 x 500` and `700 x 560` quality floors, lower aggregate
evaluations/CPU, accepted-or-better `600 x 400` subsets, and exact roomy hashes.

The first committed measurement at `d827971` rejects a one-depth
objective-only pilot selector. On Mixed-61 `700 x 560`, it reduces elapsed time
from the settle-all arm's roughly `105 s` to `67.45 s` and spends about
`125,846` aggregate capacity evaluations instead of more than one million, but
selects `legacy-absolute-envelope@30` and returns only `57/61`. The required
floor is the already observed `59/61` from the canonical/open depth-30 lanes.
Triangle-20 `300 x 300` also keeps count/material at `15/20` but selects a
strictly worse exact endpoint than the cold control. One shallow exact partial
objective is therefore not a reliable continuation-value estimate. This result
must not be promoted; the next selector change needs an independently justified
protected-diversity or longer-probe rule.

The next committed hypothesis therefore keeps the cold candidate protected and
replaces the rejected terminal-objective selector with equal-depth warm
reselection. Its falsifiers are unchanged: Mixed-61 `700 x 560` must recover at
least `59/61`, `700 x 500` must retain the accepted `49/61`, Triangle must be
cold-exact-or-better, the constrained matrix must not regress, roomy complete
hashes must remain exact, and CPU/evaluations must stay below settle-all.

The targeted measurement at `86875e0` rejects this equal-depth round-robin
allocation as implemented. Triangle remains cold-exact at `15/20`, but
Mixed-61 `700 x 560` returns the cold `55/61` endpoint. The three depth-30 warm
lanes consume about `80k` to `84k` evaluations each and reach only depths
`51-52`; none receives enough of the `249,856`-evaluation warm entitlement to
settle its known `59/61` endpoint. Aggregate capacity work is `481,272`
evaluations, wall time is `161.80 s` for the paired targeted run, user CPU is
`173.98 s`, and maximum resident set size is `1,003,880,448` bytes. The report,
SVGs, and run log are retained under
`/private/tmp/min-plane-provenance/intrinsic-lane-reselection-86875e0-targeted/`.
The strict gate now encodes the `59/61` minimum explicitly; generic
cold-or-better comparison is not sufficient promotion evidence.

The next experiment replaces only the rejected reselection loop. All pilots,
the cold entitlement, checkpoint retention, and terminal comparison remain
unchanged. The pinned canonical lane must first preserve Triangle's exact cold
answer and reach the known `59/61` on `700 x 560` and `49/61` on `700 x 500`;
only one warm lane may exceed pilot cost. The full constrained/roomy matrix is
still conditional on those targeted falsifiers.

Commit `648a93e` passes all three targeted falsifiers. Triangle remains exact
cold at `15/20`; Mixed `700 x 500` reaches `49/61` versus cold `45/61`; Mixed
`700 x 560` reaches `59/61` versus cold `55/61`. Aggregate evaluations are
`77,377`, `414,737`, and `355,035` respectively, each within the two-base-cap
allowance. Only the deepest canonical lane exceeds pilot work and every
coordinator chronology and ledger validates. The paired run uses `294.61 s`
wall, `313.96 s` user CPU, and `1,029,423,104` bytes maximum RSS.

At packaging commit `c171f21`, all six strict accepted baselines pass with
their exact canonical hashes and accounting. The matrix uses `112.23 s` wall,
`123.35 s` user CPU, and `910,721,024` bytes maximum RSS. Portable reports,
SVGs, and full Electron PNGs are in
[`../artifacts/intrinsic-anytime-pinned-lane/`](../artifacts/intrinsic-anytime-pinned-lane/).

This accepts the bounded pinned-lane capacity step, not the final architecture.
The serial complete-miss cost remains, and the Triangle `300 x 300` endpoint is
visually loose despite being exact cold. Both are explicit inputs to the next
complete/capacity interleaving design.

### Stage 4C: Direct Complete Piece-Boundary Checkpoint

The next implementation seam is deliberately below the scheduler. The strict
sheetless constructor can pause only after one whole prepared piece has
compared every transform family, selected and anchored its winner, and committed
the resulting `IrregularBeamState`. It never checkpoints the existing
candidate-evaluation cap because that cap can stop mid-piece with incomplete
family comparison.

The versioned direct checkpoint binds the producer/candidate mode, prepared
geometry and order, geometry settings, initial frozen seed, exact anchored
state with parent lineage, pending suffix and next index, accumulated step/gap
traces, candidate evaluations, cumulative active runtime, and optional phase
ledger. Fingerprinting is opt-in with pause/resume and does not burden ordinary
strict construction. The first falsifier resumes after every committed piece
and requires exact final state, placement order, step trace, gap evidence, and
evaluation-count equality with uninterrupted construction. Scheduler and
archive integration remain intentionally unchanged at this step.

The first review of that seam found that an intact checkpoint resumed
deterministically but the validator did not yet prove that its supplied state
contained every consumed prefix piece, and did not bind settlement bounds or
phase-capture policy. The hardened checkpoint hashes the retained state lineage
and ledgers, replays the exact parent decision partition from the frozen seed,
recomputes derived occupied geometry, reconciles per-piece candidate counts,
and rejects changed runtime/evaluation bounds or phase policy. Corruption tests
cover omitted pieces, placement-order and unplaced-decision changes, broken
parents, mismatched identity, reduced counters, policy toggles, and invalid
nested phase time.

A second integrity review found two continuation-specific hazards: unbounded
parent traversal could loop on cyclic ancestry, and valid public aggregates did
not prove the private canonical/contact/spatial caches used by the next
placement. Lineage collection is now identity-cycle checked and capped at the
cursor-derived state count before hashing. `IrregularBeamState` and its spatial
index expose a deterministic continuation identity covering the private
canonical keys, contact-signature counts, bucket membership, and fallback
entries consumed by later placement. The checkpoint digest binds that identity,
so mutation is rejected while legitimate incremental metadata is preserved.
Self-cycle, two-state-cycle, canonical-key, contact-signature, and
spatial-bucket tests cover the new boundary.

The Mixed-61 roomy falsifier showed why contact-signature cache validation
cannot substitute a fresh whole-layout derivation: the constructor owns an
incremental signature history that is continuation-relevant but not identical
to recomputation from the terminal placement array. The checkpoint therefore
binds that exact class-owned identity in its integrity digest; it recomputes
canonical-entry and spatial-index structure, but preserves and hash-validates
the legitimate incremental contact history.

The first portfolio integration is intentionally narrower than scheduling.
When enabled, `canonical-grid` resumes through one completed piece at a time,
settles fully, emits its final prefix callback once, and only then allows the
unchanged direct and periodic producers to continue. The uninterrupted and
checkpointed arms match direct/periodic status, evaluations, endpoint hashes,
coverage, prefix identities, ordered sheetless/fitting archives, and winner.
Runtime is cumulative and nonnegative but excluded from equality because
validation overhead is real.

The coordinator now uses that seam for the first genuinely intertwined trace.
It starts the protected cold lane for four depths, then alternates one
`canonical-grid` committed piece and one cold depth. Both retain their own
checkpoint, budget, and comparator. If cold settles first, its exact result is
retained while complete construction continues; if the complete archive later
misses, the capacity coordinator receives that existing state rather than
starting empty. Focused integration tests preserve the complete output, verify
the cold settlement occurs before final complete settlement on the fixture,
and validate the full quantum chronology. This remains cooperative
single-worker execution and therefore makes no settled wall-time claim.

The capacity checkpoint is now `intrinsic-anytime-checkpoint-v2`. Each retained
frontier entry records the class-owned continuation identity consumed by its
next placement, while the checkpoint integrity hash binds the exact decision
partition, public objective data, incremental contact history, canonical-entry
cache, and spatial-index identity. Resume additionally rebuilds canonical-entry
and spatial-index structure from placed geometry. Corruption tests mutate each
private cache independently and require rejection; uninterrupted and resumed
endpoint/trace equality remains exact.

### Constrained Triangle Protected-Diversity Probe

The first post-scheduler quality probe is opt-in and subset-only. It keeps the
same beam width, exact legality, count/material/cavity precedence, endpoint
archive, and terminal comparator, but orders the protected lane's local
survivors by envelope area before maximum side. This tests whether the visibly
loose Triangle `300 x 300` result comes from losing a temporarily less-square
but eventually tighter branch. It has no production authority. Promotion
requires at least `15/20`, no material/cavity/maximum-side regression, a strict
envelope-area improvement, and an inspected full PNG; otherwise the exact cold
baseline remains selected and the hypothesis is recorded as rejected.

Commit `4b09d0d` rejects that area-first lane: it places only `13/20` versus the
protected objective lane's `15/20`, despite a smaller envelope for the reduced
material. Commit `05670f1` then places `16/20` by reserving width/height
orientation buckets, but it reduces the original objective survivors from 16
to 8 and applies the same switch to cold and warm continuations. Its endpoint
also regresses maximum side and envelope area and remains visibly fragmented
in the inspected PNG. It is valid rejected evidence, not an independent
protected lane and not a promotable Triangle result.

The next probe must run beside the full unchanged cold lane. It is an
observer-only generic topology frontier whose exact strata retain
count/material/cavities first, then bounded representatives for intrinsic
compactness, isolated-piece count, largest positive-contact component, and
hull waste. Triangle is only the falsifier; Mixed and Shapes remain required
non-regression controls.

The first implementation exposes that frontier only through an explicit
observer option. It starts from empty with its own producer role, fingerprint,
checkpoint identity, exact topology measurements, evaluation budget, endpoint,
trace, and SVG hook. The original 16-slot cold search and every warm lane
remain unchanged, and the cohesion endpoint is excluded from terminal
selection until its quality and cross-fixture gates pass.

The first committed measurement at `9faaf61` rejects that retention policy as
an output candidate while preserving the observer seam. Triangle-20 on
`300 x 300` kept the production `15/20` result and canonical hash
`b1455c81...` exactly. The independent lane reached `16/20` in `44,214`
placement evaluations and `1.271 s` of observer search, but exact topology
reported eight positive-contact components, six isolated pieces, and only
eight pieces in the largest component. Its `289.490 mm` maximum side also
regressed the `283.783 mm` production incumbent. The rendered PNG confirms a
strong central block with detached left and bottom pieces. It is therefore
rejected rather than admitted. The next diagnostic must determine whether
connected candidates are generated before retention and then lost, or whether
candidate generation never proposes them.

The bounded trace at `92729e0` exposed and Sol review caught a reservation
off-by-one: the generic bucket helper could append a seventeenth state before
checking the declared 16-state limit. Commit `d00413b` fixes both cohesion and
the earlier axis helper and asserts the bound at every traced depth. The clean
rerun preserves the same production and observer hashes with a maximum of 16
survivors.

That corrected trace localizes the missing mechanism before beam retention.
At depth two, the best exact count/material/cavity stratum contains nine legal
two-piece measured survivors, but its minimum contact-component count is two
and its maximum connected component has size one. No connected multi-piece
representative appears later. Across all depths, only one bounded topology
representative is discarded, and it is less connected than the retained
alternative. The NFP service already generates exact legal NFP-vertex and
antiparallel-edge-support candidates; capacity then constructs only the three
best-envelope candidates per parent. The next observer therefore preserves
those three successors exactly and appends at most one distinct
maximum-positive-boundary successor from the same legal pool. It records
contact measurement and survival separately and still has no output authority.

Commit `8ac35c8` validates that missing fanout. Triangle-20 `300 x 300` keeps
the exact production `15/20` hash while the independent lane improves from
`16/20` to `17/20`. The legal pool contains 679 positive-contact candidates;
127 distinct contact successors are added across the run and 63 survive their
immediate depth boundary. The final largest contact component grows from
`8/16` to `14/17`, exact components fall from eight to four, and isolated
pieces fall from six to three. Contact measurement adds only `28.9 ms` in the
captured run.

The inspected PNG is materially better but still not promotable. It contains a
clean 14-piece connected core plus three detached right/lower pieces, and its
`296.739 mm` maximum side exceeds the `283.783 mm` production guard. The depth
trace shows the connected 14-piece state survives, then has no fitting
positive-contact continuation; the legal pool has no positive-contact
candidate from depth 16 onward. This is the retained-coherent-state/poor-close
case that justifies a bounded generic exact reconstruction experiment over the
selected 17-piece subset. It does not justify Triangle-specific placement.

Commit `394b040` rejects that first reconstruction schedule without changing
production or the 17-piece observer incumbent. The existing targeted exact LNS
ran for `2.848 s`, but only nine of its 24 deterministic schedule entries
performed distinct searches; 15 collapsed as duplicate destroy/queue
signatures for interchangeable pieces. Its four-wide reconstruction beam and
local fanout found no accepted result. Larger rounds sometimes failed to
replace every destroyed piece, while the best legal alternative was
topologically worse than the incumbent.

This is evidence against that bounded schedule, not proof that the exact-fit
frontier is closed. The next falsifier is an observer-only detached-component
reinsertion sweep. For each component outside the largest positive-contact
component, it freezes every other placed piece and exhausts the existing legal
NFP candidates for every allowed transform over the full requested sheet,
without beam or local-fanout truncation. A positive-contact legal placement
would localize the loss to reconstruction diversity. No such placement would
justify testing bounded feature-contact candidate generation, but would still
not prove that a multi-piece global rearrangement is impossible.

Commit `015174c` executes that falsifier over the three isolated pieces in the
17-piece Triangle endpoint. The sweep covers all eight allowed transforms per
piece, with the other 16 placements frozen, in `38.8 ms`. The existing exact
sheet candidate pool returns 11, 12, and three canonical-legal candidates for
the three pieces respectively, but **zero** positive-boundary candidates in
all three cases. One placement changes the maximum side from `296.739 mm` to
`296.738 mm`; contact components, isolated count, largest component, and
structural contact metrics remain identical. The rendered result is visually
unchanged and is not promotable.

The measurement closes only the one-piece/frozen-context neighborhood exposed
by the current candidate pool. It does not prove that a different exact
contact placement or a multi-piece reconstruction is impossible. The next
bounded experiment may therefore generate explicit exact feature-contact
candidates for one detached piece against frozen component edges, validate
them through the canonical sheet authority, and retain the current 17-piece
endpoint when no strictly better legal result exists.

Single-worker cooperative interleaving is not a settled wall-time
optimization: the protected complete and capacity CPU work still sum. It first
establishes reuse and truthful deadline chronology. A later wall-time claim
requires independent parallel execution with a deterministic terminal join.

## Stage 5: Shared Exact Archive Mechanics

Complete and partial endpoints now pass through one generic exact archive
storage boundary. Each namespace supplies its own validation, canonical
identity, duplicate policy, and ranking function:

- the complete namespace preserves first-producer ownership and the unchanged
  strict sheetless ranking;
- the partial namespace rechecks exact request partition accounting, retains
  the comparator-best representative of a geometry identity, and applies the
  existing count/material-first capacity objective;
- terminal selection exposes the required complete-over-partial dominance
  without merging the namespace arrays.

The service owns validation, canonical deduplication, storage, and the terminal
namespace choice only. It does not own candidate generation, survivor slots,
budgets, or either comparator. The legacy complete winner contract and the
capacity objective therefore remain independent.

Focused tests cover invalid endpoint rejection, within-namespace duplicate
selection, namespace isolation, and complete dominance. The complete archive,
capacity mode, scheduler integration, and shared archive suites pass together
without changing the Stage 4 evidence.

## Stage 6: Experimental Place/Defer Complete Producer

The first complete-capable experimental producer is deliberately narrow. It
makes one explicit future decision: defer the first prepared piece, process the
remaining immutable order, then retry the deferred piece in a second pass. It
uses the existing exact sheetless strict constructor with a protected `19,862`
candidate-evaluation cap and a `35 s` producer-local runtime cap.

The versioned pause boundary occurs immediately after that defer transition.
Its checkpoint binds the exact request and prepared geometry, producer and
experimental archive cohort, `completeEligible` status, disjoint
placed/pending/deferred/permanently-skipped IDs, future pending order, cursor,
pass and per-piece deferral counters, exact empty-state geometry, material,
topology, and fit accounting, protected budget ledgers, scheduler deficit,
settlement/censoring, and no-skip-frontier state. Resume rejects any changed
future defer decision.

Only a skip-free complete exact endpoint is exposed. Evaluation-capped or
incomplete construction produces telemetry but no archive endpoint. The
producer is observer-only, uses an experimental namespace, and cannot alter
the legacy complete archive, capacity archive, routing, or worker output.
The protected legacy archive now settles before this opt-in observer starts, so
the experimental arm cannot consume its time allocation. A producer-local
deadline, geometry failure, strict-decoder failure, or invalid checkpoint is
converted to an explicit censored observer trace; only explicit user
cancellation may abort the parent job. Focused tests prove
uninterrupted/resumed semantic identity, corrupted future-decision rejection,
failure censoring, cancellation propagation, combined scheduler chronology,
and unchanged roomy complete output.

Promotion remains evidence-gated. The full roomy/constrained baseline matrix
must determine whether this one-defer producer reproduces accepted winners or
is retained only as rejected shadow evidence.

The matrix at committed implementation `c846745` rejects promotion of this
producer:

- Triangle-20 completes, but its experimental hash `ace7d11d...` differs from
  the accepted `371db269...`;
- Shapes-17 completes, but its experimental hash `580488e4...` differs from
  the accepted `c640c06f...`;
- Mixed-61 reaches the protected `19,862`-evaluation cap after 53 placements
  and exposes no complete endpoint.

The shadow therefore remains useful mechanism evidence only. Its pause/resume
contract works, but it does not preserve the settled complete winner contract.

The returned outputs preserve five of six accepted baseline hashes exactly,
including all three roomy cases and Triangle-20/Mixed-61 on `600 x 400`.
Shapes-17 `600 x 400` is a strict capacity-objective improvement rather than a
loss: the admitted warm endpoint places `14/17` instead of `13/17`, increases
exact placed material from `144,125.9382175` to `147,227.7221575 mm2`, and
reduces exact cavities from one to zero. Its larger envelope is subordinate to
count and material under the accepted partial objective. Because the current
strict gate pins the old hash, the six-case command exits nonzero and this
candidate is not silently copied over the accepted baseline.

The historical pre-Stage-4B Mixed-61 `700 x 500` serial-cost case places `49/61` from
`canonical-grid@15` in `80.10 s`; it still pays about `54.46 s` complete,
`6.90 s` cold, and three serial warm lanes. This independently confirms that
the coarse scheduler has not resolved F4. Exact reports, source/input archives,
checksums, SVGs, and the inspected Shapes constrained PNG are under
`/private/tmp/min-plane-provenance/intrinsic-place-defer-c846745/`. The PNG has
visible background on all four sides and no truncated polygon.
