# Irregular V2 Infrastructure

## HARD CONSTRAINT: NO PARALLEL NESTING EXECUTION

> **ONE NESTING JOB MUST REMAIN INSIDE ONE EXISTING ALGORITHM WORKER.
> SUBPROCESSES, CHILD PROCESSES, NESTED WORKERS, `worker_threads`, AND
> CONCURRENT COMPLETE/CAPACITY EXECUTION ARE FORBIDDEN UNTIL THE USER
> EXPLICITLY REVOKES THIS RULE.**

Compact cohorts may checkpoint and interleave deterministically, but they must
not execute simultaneously. This restriction applies to production changes
and performance experiments.

Irregular v2 is a real deterministic convex engine. It flattens imported closed
outlines, builds padded convex collision polygons, generates finite
rotation/mirror choices, produces NFP/IFP contact candidates, and validates
placements directly. Its ordinary path runs a configurable requested-sheet beam
plus optional bounded seeded GA. The eligible Compact quality profile instead
runs the intrinsic anytime coordinator around separate complete and capacity
archives. It is not a concave/hole-aware nesting engine.

For the current production contract, start with
[`Current Integration State`](#current-integration-state). The constructor,
pressure, protected-lane, and old Triangle sections retained earlier in this
page document reusable machinery and historical experiments; they do not
override the current intertwined Compact quality contract. Decision chronology
and full metrics live under [`../history/`](../history/README.md) and
[`../research/`](../research/index.md).

## Shared DTOs

`src/shared/irregular/` owns schema-backed DTO classes and default constants for
the convex irregular engine shell:

- collision and transformed geometry shapes;
- placement transforms;
- geometry settings;
- optimizer settings;
- cache keys;
- portfolio progress and result envelopes;
- free-material regions with explicit boundaries and holes.

These DTOs are named app payloads and should stay aligned with the rest of
`src/shared/domain/`: use `Schema.Class` for exported data shapes. Service
contracts may still use interfaces for operation inputs because those are
dependency boundaries, not persisted payloads.

The verified derived-geometry hot path uses worker-private structural point,
bounds, polygon, and polygon-with-bounds records. Schema-backed geometry is
still accepted at service inputs and restored at public-service outputs; cache
entries intentionally retain private records so hot cache hits avoid class
construction while preserving those public contracts.

## Worker Services

`src/workers/irregular/` owns Effect service tags for the engine:

- `GeometryKernel`;
- `CollisionGeometryBuilder`;
- `TransformGenerator`;
- `NfpIfpService`;
- `FreeMaterialService`;
- `PriorityOrderService`;
- `IrregularNestingPortfolio`;
- `GeometryCache`.

`src/workers/algorithm/irregular/strictPriorityDecoder.ts` is an algorithm
module rather than another Effect service. `decodeStrictPriorityOrder` consumes
an already priority-ordered list, transforms each piece's existing transform
candidates in deterministic metadata order, and asks `NfpIfpService` for legal
candidates against the real placed collision geometries. It chooses by
the configured local candidate policy, then translated candidate bottom/left
and transform `(index, rotationDeg, mirrored, reason)`, retains the chosen
transformed geometry for later candidates, and records an ordinary no-fit piece
as unplaced before continuing. Transform indexes are normally unique because
`TransformGenerator` emits them that way; the complete tie-break keeps malformed
or replayed input deterministic.

This is the strict-order baseline for the real windowed beam. It does not
generate transforms, reorder pieces, score layouts, prune a beam, emit history,
or invent placement data. Candidate
generation and direct placement validation remain the legality authority. The
decoder uses `IrregularPlacementScorer` only to compare those real legal
candidates with the requested explicit local policy: balanced compactness,
envelope-guarded short-side fill, or exact shared padded-edge contact followed
by balanced compactness. The contact policy measures only the collision envelopes already
accepted by direct validation, so its preferred edge mates preserve configured
source clearance. It does not use free-material metrics to accept candidates; whole-layout
metrics remain a separate beam-retention and portfolio concern. A valid transformed
polygon that exceeds the sheet is an infeasible transform and produces zero
candidates, allowing the decoder to try the next supplied transform; invalid
geometry and invalid derived arithmetic remain typed failures. The supplied
order must remain untouched so future beam and portfolio layers can make their
priority decisions outside this baseline.

### Current Compact-Archive Constructors

The intrinsic strict decoder is a separate constructor used by the Compact quality
production archive. It preserves the user-owned prepared
piece order, anchors the first transformed polygon at the normalized origin,
and asks the NFP service only for sheetless boundary, support, and intersection
candidates. The geometry service still performs exact overlap validation and
canonical translation admission, but rectangular sheet bounds are deferred.
The constructor retains the best candidate from each rotation/mirror family,
then selects one winner by absolute maximum side, envelope area, envelope span,
shared boundary as a bounded tie-break, and canonical combined geometry. Only a
completed layout is tested against the real sheet, at q0 and q90. This path has
its own provenance harness and exact topology metrics; it does not alter the
ordinary beam, GA, repair, or explicit `short_side_fill` behavior.

Compact derives its transform-noise policy independently for every prepared
collision polygon. An edge is usable when its length reaches
`min(4 * flatteningSagToleranceMm, 0.01 * smallerCollisionDimensionMm)`.
Near-angle deduplication is capped at `0.051 degrees` and tightened until the
worst vertex displacement around the collision polygon's local placement
origin stays within the flattening sag:
`2 * asin(min(1, sag / (2 * maximumVertexRadius)))`. Collision vertices are
already rebased to that origin; `placementReference` stores the corresponding
source-space coordinate and is not subtracted from local points.

Within one near-angle group, source priority remains orthogonal, edge-derived,
then configured. Competing edge-derived angles use the longer usable collision
edge as their representative before the transform cap is applied, with stable
angle and source-order tie-breaks. Circular distance handles the zero/full-turn
seam. The persisted minimum-edge and angle-deduplication fields remain decoded
for ordinary-path and replay compatibility, but Compact ignores their numeric
values. Only the transform cap and enabled orientation sources remain
user-visible Compact controls.

### Intrinsic Capacity Mode

When the eligible Compact request cannot hold every prepared piece, the
coordinator no longer fails with "no fitting endpoint". The routing is:

1. `preflightIntrinsicCompleteCapacity` runs before the shared archive. It is
   proof-only: exact `bigint` shoelace sums of the minimum valid canonical
   collision areas against the doubled canonical sheet area, plus an exact
   singleton q0/q90 span test per piece. Its outcomes are only
   `proven_impossible(reason)` or `inconclusive`; invalid geometry or
   incomplete transform accounting is an error, never a proof.
2. A proven-impossible request bypasses complete construction and runs
   `intrinsic-capacity-v1` from the empty state.
3. An inconclusive request starts a bounded cold-capacity quantum, then
   interleaves the unchanged sheetless complete constructor with resumes of
   that checkpoint. A fitting complete endpoint wins and cancels capacity. A
   valid, uncensored complete archive with no fitting endpoint records
   `bounded_complete_archive_miss` and hands the existing cold checkpoint to
   the capacity coordinator. Cancellation, deadline censoring, invalid
   geometry, and incomplete coverage remain errors, not capacity transitions.

After each committed, uncapped, complete direct constructor returns, one
read-only parent-lineage walk captures at most nine prefix descriptors at
quarter/half/three-quarter depths of the immutable prepared order
(`canonical-grid`, `legacy-absolute-envelope`, `open-pocket-first` only; a
descriptor must be a skip-free processed prefix). Fitting descriptors
terminalize into fully accounted partial endpoints with zero placement
evaluations; the best becomes the initial incumbent.

`intrinsic-capacity-v1` is a depth-synchronized cold beam over the prepared
order with beam width `16`, local legal-placement fanout `3`, a deterministic
`4,096`-evaluation quota per piece depth, a total allowance of
`max(50,000, pieceCount * 4,096)`, and one mandatory skip successor at every
piece depth. Skip paths are reserved before placement work, so exhausting a
busy depth cannot prevent later pieces from being considered. Ordinary
compactness proposals are ranked from incrementally maintained occupied bounds
without constructing full placement states or anchored rebuilds for discarded
candidates. The production contact fanout separately measures positive
boundary contact for fitting legal candidates, and the bounded survivor pool
receives exact topology measurement before retention. Every successor is
checked for exact partial q0/q90 grid-span fit and deduplicated by
anchored canonical occupied-union identity plus the exact placed-ID set before
retention; exact enclosed-cavity measurement is cached by geometry identity
alone and covers every retained contender. The incumbent may prune a cold
state only through the strict attainable-count and attainable-material bounds;
equality always remains searchable. Retention and final endpoint selection
follow the capacity objective: more placed pieces, more exact unpadded placed
material (convex-hull `bigint` grid areas), fewer exact cavities, less cavity
area, then smaller intrinsic maximum side, envelope area, and span, and
finally deterministic geometry identity.

Endpoint materialization re-runs the authoritative canonical legality per
rigid orientation and returns an exact placed/unplaced partition of the
request. The result reaches the app as an ordinary completed portfolio with
termination reason `capacity_subset_settled`, honest `unplacedPieceIds`, the
selected-layout reveal history, additive diagnostics codes
(`capacity_preflight_proven_impossible`, `capacity_preflight_inconclusive`,
`complete_archive_fitted`, `bounded_complete_archive_miss`,
`capacity_subset_settled`), and the structured `capacityTrace` on the compute
result. The evidence gate is `pnpm gate:capacity`.
Capacity reveal frames carry the settled endpoint's exact unplaced IDs at
every step, and the proof-only preflight observes the cooperative
cancellation/deadline control before and during transform measurement.

The production `intrinsic-anytime-portfolio` wraps the unchanged cold depth loop in a
versioned request-fingerprinted checkpoint, grants deterministic protected
cold/complete/warm quanta, and coordinates capacity checkpoints after an
uncensored complete miss. The cold checkpoint owns one base-cap entitlement
through exact settlement. Every warm lane receives one bounded pilot under a
second entitlement. The deepest fitting `canonical-grid` checkpoint is then
pinned through depth-boundary resumes until settlement or exhaustion;
open-pocket and legacy are deterministic absence fallbacks. Other checkpoints
become explicit censored best-known states. Coordinator telemetry records every
actual pilot and resume with lane identity, depth transition, and evaluation
delta; its validator reconciles aggregate and per-lane accounting. Complete and
partial endpoints share exact archive storage mechanics but retain separate
namespaces, survivor policies, and comparators; complete dominance is a
terminal rule.

The strict sheetless direct constructor also exposes an opt-in direct
checkpoint below portfolio scheduling. A pause is legal only after one complete
piece transition has compared all transform families, anchored the selected
state, and retained its parent lineage. The checkpoint is sheetless and binds
the producer mode, prepared request/settings fingerprint, exact state, pending
suffix, traces, and cumulative active-work/evaluation ledgers. Candidate caps
that stop within a piece remain non-resumable truncation. Fingerprinting is
disabled on the ordinary path. Resume also revalidates the complete parent
chain: every consumed prepared ID must occur exactly once as placed or
unplaced, placement order and per-piece traces must agree with that chain, and
derived occupied geometry must recompute exactly. The integrity hash covers the
retained lineage and ledgers. Runtime/evaluation settlement bounds and
phase-capture policy are fingerprinted; only the completed-piece scheduler
quantum may change between resumes. Lineage traversal is cycle checked and
bounded by the committed cursor. A class-owned continuation identity covers the
private canonical, contact-signature, and spatial-index caches consumed by later
placement. Resume preserves exact incremental state while rejecting cache
mutation.
Canonical-entry and spatial-index structure are recomputed for validation.
Incremental contact-signature history is instead integrity-bound exactly,
because a whole-layout derivation is not the same continuation state.

The direct portfolio has an integration seam that advances only
`canonical-grid` through a configurable completed-piece quantum until that
producer settles. It then continues the unchanged direct-role and periodic
order. Checkpoint callbacks expose chronology only; archive retention,
comparators, and the single final constructed-prefix callback remain unchanged.
The production anytime coordinator consumes that callback by resuming the protected
cold checkpoint for one depth after each canonical complete piece. Complete and
partial work remain separate state machines and archives. Once the cold lane
settles, later complete checkpoints continue without duplicating capacity work;
after a complete miss the settled/checkpointed cold state transfers directly to
the capacity coordinator. The production capacity retention frontier protects
generic compactness and exact contact/topology representatives inside its own
16-state cohort; it does not alter complete-cohort survivor slots or ranking.

An additional observer-only experimental complete cohort makes one explicit
place/defer decision by moving the first pending piece to a second pass. Its
checkpoint binds the exact future-decision partition and ledgers. It exposes
only a skip-free complete endpoint, has no output authority, and runs only
after the protected legacy archive settles. Its local runtime or geometry
failures become censored telemetry; explicit user cancellation is the only
shadow failure propagated to the parent job. It remains ineligible for
promotion until it reproduces the accepted complete matrix.

### Historical and Experimental Constructors

The following E4, V7, pressure, and early shared-archive descriptions preserve
the design and failure mechanisms of their named experiments. They are not the
current Compact quality selection contract. Current decisions and retained
lessons are summarized in
[`../history/search-quality-decisions.md`](../history/search-quality-decisions.md).

The preregistered E4 experiment is a separate complete-layout optimizer around
that exact E1 seed. It has no requested-sheet input. Synthetic target boxes are
derived only from the seed's canonical occupied geometry and stable
per-instance area caps. Private transient states may overlap while a
transform-aware SAT/GLS separator changes finite transform families, swaps
large pieces, transports bounded nearby groups, and crosses worse basins. These
states are diagnostics only and never become worker results or history.
SAT conflict depth remains a search heuristic: selected pressure intermediates
and endpoints are cross-classified against canonical-grid Clipper2 legality,
cached by canonical relaxed-state key, and only the canonical result decides
whether an endpoint is exact. The trace retains SAT/canonical disagreements so
floating separator residue cannot silently reject or admit a layout.
Relaxed poses retain the exact finite translation as a phase basis plus integer
grid search offsets. Every authoritative vertex is formed by adding the local
coordinate and phase basis in millimetres, rounding once, and then applying the
integer offset. Canonical state identity includes the current anchored world
path and a deterministic phase signature over every finite transform; exact
materialization fails if it cannot reproduce the requested canonical paths.
The complete identity payload is stored as a SHA-256 key so traces and legality
memos retain the phase distinction without duplicating full polygon catalogs.
Initialization also publishes an observer-only identity-control witness for the
exact structural E1 state inside its own canonical occupied box. It records the
SAT raw and weighted loss, conflict tuple, exact-zero flag, canonical identity
and coverage control, and canonical legality classification. This observation
costs zero registered separation evaluations, is never selection-eligible, and
therefore exposes SAT residue without allowing it to reject the canonical E1
control. The portfolio carries this witness into its report-facing structural
outcome instead of dropping it at the controller boundary.
The retained pre-V7 pressure foundation evaluates the existing focused
separator candidates first, deduplicates later sources by canonical state key,
and records source, pass, ordinal, pose, conflict tuple, clearance, cap, winner,
and outer-survival accounting. Every evaluated candidate is checked under
canonical legality before SAT ranking; a canonical-legal state is retained even
when SAT reports residue, while SAT-clear canonical-illegal states never become
exact endpoints. Each retained parent runs bounded priority-forward and
priority-reverse collider orders against one shared budget with a deterministic
forward reservation, so reverse keeps its allocation and may reclaim unused
forward budget. The adaptive transform-family generator remains typed and
tested but is dormant here because the existing focused transform pass already
produces the same states; its call-site trace reports zero cost. A two-radius,
sixteen-position refinement generator is exposed only as
a dormant intensifier API for a future explicitly promising coordinated atom;
the current pressure loop never invokes it. No static shrink role, whole-box
coordinate generator, or reserved conflict slot is part of this foundation.
The older adaptive-depth helpers and adaptive-only termination labels are also
dormant in the retained pre-V7 lanes.

The V7 adaptive-pressure experiment is a separate use of that machinery. It
derives 5%, 2.5%, and 1.25% contractions from the current exact incumbent,
reserves a cumulative third of a 50,000-evaluation pressure budget for each
failure, and can retain low-loss restart states for a paired research arm. Four
mandatory sweeps may extend to eight while the raw loss keeps improving; two
flat extra sweeps stop the attempt. An accepted exact endpoint resets the
failure chain and becomes the next pressure incumbent; three consecutive
failures terminate it. Attempt traces distinguish local evaluations from
cumulative start/end, cumulative
limit, and local quota. Relaxed states remain private and only canonical-legal,
strictly improving endpoints can reach exact projection or the common archive.
The paired Triangle/Mixed ablation at `9baaa95` found restart capacity three
harmful on Triangle and quality-neutral but slower on Mixed. Cross-target
restart injection is therefore rejected as a default; the production-facing
contract remains capacity zero unless later paired corpus evidence reverses
that result. Adaptive target depth and the exact-only handoff remain retained.

The schedule additionally accepts an explicit `pressureContractionRatios`
sequence (default 5%, 2.5%, 1.25%) and a `pressureMoveVocabulary`. The default
`mtv` vocabulary preserves the historical behavior. The `sampled-relocation`
vocabulary augments every composite collider visit with two deterministic
compass rings scaled by the piece's characteristic length, a bounded Halton
coverage of legal bottom-left positions inside the contracted target box, and
at most two shrinking-ring refinement rounds around the best candidate before
the unchanged weighted-nonworsening commit; evaluation accounting, GLS
weights, canonical-legality classification, and the exact-only promotion gate
are unchanged. Refinement starts from the best sampled state's canonical frame
and rings that state's selected pose, avoiding the former re-anchor mismatch
between the current and best states. The equal-budget Triangle matrix from the pinned
74,428 mm2 seed (baseline, 0.625% final step, sampled relocation, both)
produced no canonical-exact endpoint in any arm; the smaller-step arm reached
raw loss 3.6e-06 while retaining 12 distributed pair conflicts, so the
Triangle pressure branch is closed by the preregistered stop rule.

The periodic family portfolio's source-survival audit can additionally admit
its bounded raw-crop Pareto witnesses as source-tagged `raw-witness:`
continuations (`admitSourceAuditWitnesses`, harness `--admit-raw-witnesses`):
without it, cell fronts ranked by cell-local proxies can evict the source of
the best known crops — measured on Triangle, where the 74,428 mm2 witness
basis is generated but retains zero cells in a default run and the archive's
best entry is 37% worse. With admission, the Triangle archive gains both the
74,428 witness and a 90,352 mm2 three-band lattice with 7 isolates and 9
components that the default pipeline had never surfaced. Ordinary and raw
witness continuations compete inside the same `maximumContinuationCount` cap.
Deduplication uses canonical occupied geometry plus the ordered remaining-piece
future, and an ordinary continuation remains the representative when the same
future is reached through both sources. Extending this periodic-specific
mechanism into a universal all-front retention policy remains a hypothesis,
not an established architecture.

Periodic strict continuations also accept an optional deterministic candidate-
evaluation cap. The counter increments exactly once before each direct-legal
candidate enters strict local scoring; reaching the cap stops before committing
the partially evaluated piece and reports `evaluation-cap` with the consumed
count. Wall time remains an independent safety abort. This separates a stable
search budget from machine speed while preserving the historical unbounded
behavior when no evaluation cap is supplied. Selection coverage and execution
coverage are reported separately: selecting every bounded continuation does not
imply that every selected continuation reached a terminal decode.
Explicitly capped runs also distinguish complete decodes from budget settlement:
`continuationExecutionCoverageComplete` requires a completed decode, while
`continuationBudgetSettlementComplete` also accepts a deliberate
`evaluation-cap` stop and rejects invalid or wall-time-censored runs.
When that explicit cap is active, selected continuations execute by ascending
seed-envelope area, maximum side, and span, then by more already placed pieces
and stable source identity. This changes only censored execution order: archive
ranking and the selected continuation set remain unchanged. The no-cap path
preserves its historical order.
An independent, explicit, default-off benchmark flag enables phase telemetry
without changing capped or uncapped production execution. Top-level timings isolate catalog construction, continuation
selection, execution ordering, strict construction, exact finalization, archive
ranking, and residual bookkeeping. Strict construction separates candidate
generation from candidate state construction/scoring. Candidate-state telemetry
further isolates placement materialization, canonical-entry insertion, spatial-
index extension, exact contact extension, state assembly, bottom-left
anchoring, envelope scoring, candidate selection, and residual bookkeeping.
Selection separates source-
audit crop enumeration, retained-cell crop enumeration, crop-front ranking, and
its remaining bookkeeping so optimization follows measured cost.
Telemetry coverage is complete only when top-level, nested selection, and nested
construction residuals are at most 1% of their respective totals and every
selected continuation has nested construction telemetry. A large residual or
missing run therefore fails the measurement gate instead of being hidden by
arithmetic reconciliation.

Local strict ranking obtains maximum side, envelope area, and span from the
incrementally maintained occupied bounds after canonical 0.001 mm conversion.
It does not recompute complete-layout convex-hull metrics for each candidate;
hull waste remains a completed-layout/archive measurement. This optimization
does not change candidate generation, local comparison order, archive identity,
or requested-sheet fitting.

Candidate comparison also avoids rebuilding a fully bottom-left-anchored state
for every discarded proposal. The scorer derives the exact canonical identity
that full anchoring would produce using the same translation arithmetic,
polygon canonicalization, and sorted entry record. It then performs the full
placement and spatial-index rebuild only for the retained step winner. Envelope
and contact terms are translation-invariant, and the retained state is anchored
before traces, gap evidence, parent history, or the next construction step can
observe it.

The Step 4 shared-archive experiment is the first common terminal boundary for
the two protected direct constructors, baseline-order gap-contained
construction, and eight bounded periodic continuations. Periodic selection
includes source-audit raw-crop Pareto witnesses under the same hard
continuation cap as retained-cell sources; a retained-cell surrogate cannot
silently remove a better exact completed layout from terminal competition.
Direct constructors
can enable trace-only candidate accounting without imposing a cap; the normal
uncapped result shape stays unchanged. Calibration freezes the observed exact
completion counts, while periodic continuations keep the fixed 19,862-candidate
cap. Catalog runtime coverage, execution of every selected source, and complete
deterministic budget settlement are mandatory experiment gates. The selector
admits at most eight continuations; when fewer exist, complete continuation
coverage proves that the smaller set is exhaustive rather than censored.

Every untruncated complete state enters one adapter that measures sheetless
canonical legality, identity, hash, metrics, and certificate before consulting
the requested sheet. Requested-sheet q0/q90 fit and fitted hashes are separate
metadata. Deduplication and geometric Pareto retention use only the sheetless
hash and metrics. Final selection is restricted to the first compactness/void
Pareto front, then minimizes the bounded cohesion-certificate deficit before
cavity, hull-gap, and intrinsic compactness tie-breaks. Cohesion therefore
selects among geometrically non-dominated endpoints; it cannot rescue dominated
geometry or partition archive admission. Requested-sheet filtering occurs
before this final selection. Evaluation-capped partial states have no endpoint
and cannot enter either archive.

The first frozen two-root no-audit matrix passed on Triangle-20, Mixed-61,
Rectangles-20, and Pentagons-20, but it was only an infrastructure control: it
excluded the known 74,428 Triangle witness and selected the 115,228 protected
fallback. The quality-monotonic follow-up restores bounded witness admission
and selects the exact 74,428.143 mm2 two-band Triangle lattice while preserving
the 405,773.434 mm2 zero-cavity Mixed pocket-first endpoint. The source audit
is currently expensive; later acceleration must reproduce its admitted hashes
before replacing it.

Source-audit acceleration has three explicit modes. Equivalent cells are
memoized by canonical cell key within one run, with separate logical and
physical attempt counters. A content-addressed warm replay can replace raw crop
enumeration. Its version-3 algorithm-owned envelope binds the source scope,
optional basis-source restriction, canonical prepared-input digest, current
eligible family/cell/source domain, and replay digest. The harness schema-
decodes the untrusted product; the algorithm then checks domain membership,
reconstructs every declared finite crop from the current cell, and revalidates
bounded survival records, witnesses, canonical-grid legality, canonical
identity, contact topology, and envelope metrics before rebuilding each
ordinary seed future. Ranking,
deduplication, reservations, and the continuation cap remain unchanged. A
schema, version, digest, scope, domain, crop, or witness mismatch is a cache
miss and executes the unchanged cold path; it does not fail the nesting request
or spend the cold continuation budget. File-read, JSON, schema, and provenance
failures remain distinguished in harness diagnostics. Replay-envelope emission is independently
opt-in, so production source-audit quality does not pay digest construction or
retain an unused cache artifact. Acceptance also requires the replay digest
through a separately trusted channel; the digest stored inside the untrusted
envelope cannot certify that witnesses were not removed. Regenerated current-
cell seeds, not cached placement objects, become the downstream replay.
Durable Electron persistence remains deferred.

The experimental `p2-axis-union` scope is a cold allocation policy, not an
equivalent cache. It admits raw witnesses only from two-member periodic cells
with an axis-union basis, then applies the unchanged Pareto/dedup/cap pipeline.
It is generic over collision families and contains no fixture identifiers. A
narrower source set can change which later futures fit into the fixed cap, so
this mode is judged by endpoint and corpus quality rather than source-list
equality.

The shared-archive runner also owns a heterogeneous direct-only baseline named
`shapes-17`. It imports 17 committed DXFs with deterministic piece/source IDs,
uses the shared `2000 x 2700 mm` roomy sheet and `10 mm` padding, and compares
the same three sheet-free direct roles. Calibration is a complete decision run:
it retains and ranks the direct endpoints, selects the fitting winner, and
writes the winner SVG. Periodic source-count gates remain scoped to repeated-
family experiments; an all-distinct job is valid with zero periodic cells.

Clipper2 offset input is quantized once to the canonical `0.001 mm` grid. The
adapter removes consecutive duplicates and an equal closing point created by
that quantization before strict path validation. This is required for analytic
full circles, whose final floating sample can be infinitesimally different from
the first while representing the same grid point. No general tolerance or
shape repair is introduced: non-adjacent duplicates, non-convex boundaries,
and paths with fewer than three unique grid vertices remain invalid.

The isolated V7 seed/archive experiment keeps that E4 path intact while
testing a replacement controller with stricter observability boundaries. Each
independent arm constructs two complete canonical-exact, sheet-free seeds:
`canonical-grid` uses max-side-first growth and `legacy-absolute-envelope`
uses area-first absolute-envelope growth. Neither seed reads a requested sheet.
The controller caches immutable transform/basis phase signatures per run and
reports hits/misses. It ranks all infeasible survivors by an exact canonical
pressure tuple—wall offender count, overlap pair count, conflicted-piece count,
wall overrun, doubled Clipper overlap area, envelope area, maximum side, and
span—before using SAT only as a deterministic tie-break and proposal direction.
Canonical legal states are archive-only: they do not terminate the scan or take
an infeasible-pool slot. The capacity-eight endpoint archive deduplicates future
states by phase-aware relaxed state key, while terminal rendering may later
deduplicate rigid quarter turns. Its seed representatives and Pareto selections
compare hull-gap fractions by cross multiplication, not floating ratios.

V7 Stage 1 runs `control`, `split`, `atomic`, and `refine` as independent
arms. Each arm receives one 12,000-evaluation / 60-second budget shared across
both seeds and all three contraction ratios. `split` evaluates q=1/3, 1/2, and
2/3 partitions on the existing contraction axis; `atomic` moves the strongest
canonical positive-overlap pair with every exact balanced integer allocation;
`refine` exposes the existing two-radius vocabulary without requiring atomic
success. No combinations, graph cut, rigid component transport, or broad
coordinate descent are enabled at this stage. Full candidate records are
bounded to final pool/archive survivors and four deterministic sample kinds per
`(arm, seed, ratio)`, so a Stage 1 arm has at most 24 samples. V7 remains
experiment-only until its provenance runs, triangle gates, and review establish
that it improves an exact completed layout rather than merely a relaxed state.

The V7 reconstruction archive treats intrinsic envelope compactness and exact
void topology as its two dominance axes. Exact-contact connectivity remains a
real but bounded selection axis: each geometric frontier round chooses a
compactness representative, a void representative, then one contact
representative. Contact therefore preserves one structurally useful alternative
without blocking strict improvement on both geometric axes. Diagnostic
certificate floors do not partition the archive.

The optional queue-vs-beam discriminator is an independent replay. At each
synchronized depth it measures whether a distinct remaining geometry class can
produce non-dominated gap-contained growth, and whether one of four rejected
same-piece geometric-front alternatives produces a better one-step
continuation. Its budgets, candidates, and output are trace-only and cannot
alter the live reconstruction result.

The experimental Stage 2A partial geometric beam reuses that exact sheetless
successor enumeration but changes retention. One protected width-one control
remains outside experimental capacity. The global canonical successor union is
deduplicated by occupied geometry plus remaining geometry-class order and
unplaced ids, partitioned into compactness/void Pareto layers, and retained by
bounded layer breadth followed by guaranteed repeated within-layer geometric
dispersion. Exact contact gets at most one post-breadth selection turn and is
never a dominance axis. Dispersion compares exact occupied unions under rigid
quarter turns using void/contact signature Hamming distance and a Clipper2 XOR
area ratio computed with integer shoelace arithmetic. A failed Boolean distance
measurement is unavailable, never a maximum-diversity reward. If the initially
represented Pareto layers cannot fill capacity, retention opens the next layer
deterministically; layer extraction stops once the bounded width cannot consult
another layer. Requested sheet dimensions appear only in the monotone q0/q90
fit gate and the shared canonical q0/q90 terminal finalizer. Trace identities
are versioned SHA-256 digests; full future-equivalence keys remain internal.
The evidence harness has a cold, isolated Stage 2A path that freezes and hashes
the prepared-piece order, skips Stage 0/1 reconstruction and queue work, and
hashes finalized SVG and PNG output. Alternate-piece scheduling remains
disabled until a later paired commensurate ablation at a successful fixed beam
width.

The same cold harness can run a diagnostic four-contributor legal reconstruction
and a trace-only coordinated complete-layout pilot. The legal cell deduplicates
reinsertion orders by intrinsic geometry class, keeps width four plus bounded
eviction shadows, and finalizes all terminal successors through the common exact
archive. The coordinated pilot then reuses the existing squeeze/disrupt/separate
engine from an immutable exact incumbent. Temporary overlap states remain
private; only canonical-legal handoffs are measured and rendered. A handoff is
diagnostically qualifying only when it is novel, strictly improves the common
geometric archive, improves cohesion, and does not regress cavity or hull
topology. Neither observer is wired into production selection.

Stage 2A also has one evidence-bounded intrinsic feature family. For every
transformed moving polygon, it intersects axis-aligned NFP segments with the
translations that align the moving min/max bounds to the occupied min/max
envelope. These sheet-free interior segment events enter only the experimental
successor pool; ordinary candidates remain the sole source of the protected
width-one winner. The protected lineage is completed first, then experimental
expansion receives only the deterministic remainder of the declared search-wide
evaluation/deadline cap; experimental parents and feature candidates therefore
cannot starve it or double the cell budget. Width zero bypasses experimental
expansion. Exact sheetless validation filters the added points before
scoring. Experimental retention uses layer breadth, at most one bounded contact
turn, and dispersion for every remaining slot. Canonical exact legality and the
topology/cavity/contact axes are evaluated once per canonical successor after
raw candidate deduplication, not once per duplicate placement; failure to
measure an exact-legal representative aborts the run explicitly.

At no more than five registered points, E4 projects a relaxed state back to the
exact geometry domain: canonicalize to the collision grid, remove both
endpoints of exact conflicts plus target-wall offenders, pin each removed piece
to its relaxed finite transform, and reinsert the conflict closure with exact
NFP/IFP candidates nearest the relaxed pose. Orientation-family fallback is
allowed only when the pinned transform has no legal candidate. Only complete
layouts passing canonical exact legality enter the bounded archive; E1 remains
the immutable fallback. Projection preservation uses canonical layout identity,
followed by the existing exact legality and complete piece-coverage checks,
rather than equality between independently accumulated floating diagnostics.
Complete intrinsic contact, occupied-envelope, and hull-waste certificates are
likewise remeasured from snapped canonical polygons. Requested-sheet q0/q90 fit
occurs after one archive winner is selected. E4 remains experiment-only until
hull-gap, cavity, area, runtime, determinism, triangle, corpus, and visual gates
all pass.

### Ordinary Requested-Sheet Decoder

Local compactness ranks the largest normalized sheet-axis consumption, the sum
of both normalized spans, collision-bounds area, and then absolute span. Bounds,
anchor coordinates, and shared boundary length are canonicalized to the existing
`0.001 mm` collision grid before comparison, so floating subtraction noise cannot
change a fanout choice. Keeping normalized spans before area prevents a negligible
rotated bounding-box area reduction from evicting every orthogonal seed on a
rectangular sheet.
Before applying the configured local fanout, the windowed beam also merges exact
translated collision-ring duplicates after the same canonicalization. Transform
metadata remains the deterministic representative tie-break, but equivalent
rotation or mirror descriptions cannot consume separate fanout slots. Decision
traces report rejected equivalents as `duplicate_local_geometry`.
Whole-state occupancy identity uses the same `0.001 mm` grid encoded as exact
integer units. It must not serialize the rounded millimeter `number` directly:
different V8 releases can print the same intended grid coordinate with opposite
sub-ulp tails, which would split geometrically identical deduplication keys and
change deterministic beam tie-breaks between the desktop and headless runtimes.

`GeometrySettings` yields one `IrregularNestingSettings` value containing both
geometry and optimizer settings. `GeometrySettings.Live` supplies the shared
defaults only; tests and future worker configuration can replace that layer with
arbitrary schema-validated settings. Algorithms yield the service instead of
accepting positional settings arguments, so each run has one configuration
source.

`IrregularOptimizerSettings` is the complete experiment surface. A request can
persist an `options.irregularSettings` value, which the worker supplies through
`GeometrySettings` for that run. It can independently vary `orderWindow`,
`beamWidth`, local-candidate fanout, transform limits and configured-angle
enablement, global rotation/mirror gates, local policy choices, GA population,
generation/evaluation/time budgets, seed, and the three chromosome-gene toggles
(priority order, transform preference, and policy). `gaEnabled`,
`baselineOnly`, or a zero GA budget retain the deterministic beam-only baseline.
This makes benchmark rows schema-validated and replayable without hidden
process-global knobs.

`localRepairBudget` controls an optional deterministic terminal improvement
pass. Zero disables it. Each iteration removes each placed piece in turn,
regenerates legal NFP/IFP candidates against the remaining layout, scores at
most the configured budget of local candidates per removal, and commits only
the single best strict whole-layout improvement. The pass uses the same geometry
legality and whole-layout comparator as the beam; it does not move pieces to
invented coordinates. Repair exploration keeps its legal sheet-space freedom;
anchoring intermediate states would make the sheet edges block later
reinsertion paths. If the cooperative deadline expires during repair, the
incomplete iteration is discarded and the last fully scored repair result is
returned; a deadline during beam search and cancellation at any phase still
abort the decode. After the final improvement, the completed winner is rigidly
tested at the four rigid quarter-turn orientations. Every variant is normalized
to the sheet bottom-left, and variants whose occupied bounds exceed the sheet
are discarded. Terminal selection first minimizes the occupied-envelope tuple:
worst normalized sheet consumption, normalized span sum, bounds area, bounds
span, and occupied-hull waste. Only envelope-equivalent variants minimize the
real Euclidean gap from the sheet origin to the nearest occupied collision edge,
preventing a concave cluster corner from stranding material at the bottom-left
without preferring a materially worse sheet orientation. The normal whole-layout
score and the quarter-turn angle break the remaining ties. The state preserves
the exact rotation- and translation-invariant contact metrics derived before
this terminal transform, avoiding a second floating-point collinearity
classification of unchanged contacts. The oriented improvement remains the
terminal winner and is not re-ranked against states that were already worse
than the original beam winner. Winning-path history hooks receive the same
selected quarter-turn and bottom-left normalization for every frame, so replay
does not visually drift or rotate only at the end even though search uses its
original legal coordinates. Decision traces record every legal terminal variant
as `terminal_orientation_scored`. Final geometry reconstruction accepts an
absolute placement angle outside the capped search transform list only when it
is an exact rigid quarter-turn of a prepared transform with the same mirror
state. The terminal orientation therefore does not need to consume search
transform capacity, while arbitrary unprepared angles remain invalid. The
protocol-facing worker rebuilds public collision polygons from source geometry
and final placement transforms. It recomputes bounds and free-material
diagnostics from those polygons but carries the selected portfolio state's five
contact metrics unchanged. Reclassifying exact shared edges after the final
rigid translation or quarter-turn can lose collinearity through floating-point
rounding even though visible geometry and legality are unchanged; that
reconstruction artifact must not replace the score that selected the winner.
Because
the budget also bounds accepted
iterations and per-piece candidate fanout, enabling repair is an explicit
quality/cost choice and applies to every baseline or GA decode.

The concrete transform-profile factories are convenience bundles over those
persisted explicit settings, not a separate configuration model. Fast identity
(`cap1`) and orthogonal (`cap4`) disable configured and edge-derived angle
sources; derived orientation (`cap16`) enables both. Mirror safety gates remain
per job and per piece. The `Compact quality` preset is the measured small
repeated-shape profile: order window `4`, beam width `8`, local fanout `4`, local
repair budget `8`, transform cap `8`, edge-contact policy, and GA disabled. The
renderer labels it as an optimizer preset and exposes local repair separately as
an explicit enable control plus its numeric budget.

When `beamWidth > 1`, each step protects the exact width-one incumbent lineage
and uses the remaining slots for ranked alternatives. With all other settings
identical, this guarantees that the wider beam cannot finish with more unplaced
pieces than `beamWidth = 1`. This changes search retention only, not geometry
legality.

The production beam does not add scale-diversity-specific local candidates or
replace production slots with a second global compactness policy. When repair
is disabled, beam width is greater than one, and no chromosome transform
preference is active, it may seed one position-independent score tie with an
unrepresented sheet-boundary anchor class. That seed advances in an isolated
eight-state protected lane under the legacy pre-canonical hull ordering. The
canonical production beam remains separate and cross-lane deduplication keeps
its representative.

The same activation boundary may seed one additional protected-only local
candidate when a positive canonical shared-boundary length already occupies at
least two production fanout positions. The seed is the direct maximum-side,
then area, then span winner of that exact tier. It never replaces or reorders a
production candidate and advances in a separate width-one intrinsic lane.
Protected intrinsic pruning ranks contact strength, maximum side, area, span,
raw hull waste, placement identity, and translation-normalized geometry. It
must not consume normalized sheet fields, sheet-boundary coordinates, or
free-material fields.

A second protected-only reservation keeps a bounded non-dominated set of local
candidates per exact shared-boundary-length tier (zero tier included): maximum
side, area, and span, capped at two, deduplicated by translation-normalized
geometry. These Pareto frontier seeds never replace or reorder production
candidates and advance in a separate width-two lane whose per-tier frontier
ranks intrinsic max side, area, span, holes, raw hull waste, placement
identity, and translation-normalized geometry. Both protected seeds fire only
from production, boundary, or intrinsic parents, so the width-one intrinsic
pool is byte-identical. Cross-lane geometry deduplication keeps the production
representative and ORs only lane eligibility; decision traces emit
`pareto_frontier_reserved` and `protected_pareto_frontier_survivor` with a
`paretoFrontierReserved` count and lane-correct ranks. The frontier retains
`freeMaterialHoleCount` as one domination objective because removing it
measurably flips the approved two-hole reference to a three-hole motif;
enclosed holes are arrangement-intrinsic and edge cases are bounded by the
terminal gate.

Production, boundary, intrinsic, and Pareto terminal winners are oriented independently.
Each protected winner may compete only when it is strictly better under the
production layout comparator and has strictly smaller collision-envelope area.
Both lanes are disabled under terminal repair, preserving repair-8 golden and
deadline semantics. Cross-lane convergence keeps the production representative
and propagates eligibility only. Decision traces identify boundary and intrinsic
survivors with lane-correct ranks. These are bounded quality recoveries; the
decoder as a whole is not yet sheet-invariant.

The reorder window is also a bounded deferral budget. A branch may choose
later-priority pieces from its configured prefix, but after the oldest remaining
piece has been bypassed by `orderWindow - 1` later-ranked placements, that piece
becomes the branch's only eligible next piece. This preserves useful local
reordering without allowing a stream of newly entering small pieces to starve a
large piece from the user-owned initial sort order indefinitely.

### Historical Ordinary-Decoder Triangle Pruning Finding

The 20-copy pointed-triangle regression demonstrates a real delayed-reward
limit of the current beam score. With order window `4`, local fanout `4`,
transform cap `8`, and the edge-contact policy, the future compact lattice is
generated by a width-5 run but is first removed at beam step `3`, after the
fourth placement. Its state is primary rank `7` and the most compact successor
at that step: collision-bounds area `20043.5832 mm2` versus `26724.7776 mm2`
for the retained contact-heavy states. It temporarily has dominant/total
structural-contact counts `1/2`, while ranks 1 through 4 have `2/3`, so the
structural-contact prefix of the whole-layout comparator correctly explains the
pruning decision.

The protected width-one incumbent is primary rank `13` at that same step and
uses the fifth retained slot, but removing incumbent protection alone still
does not retain rank `7`. Pure compactness reservation is also insufficient: it
retains the desired four-piece prefix, then switches to a smaller fragmented
branch. Contact-slack compactness variants keep the lineage for a few more
steps, but later choose a state with the same structural-contact count and
smaller current bounds even though the discarded state closes a better lattice
several placements later. The missing information is therefore future topology,
not another ordering of the existing immediate score fields.

For this exact regression, width `12` still loses the delayed branch. Width
`13` without repair was the first measured beam that reached the width-14
terminal lattice: 23 structural contacts, dominant contact count 16, cycle rank
4, collision-bounds area `80174.3328 mm2`, and hull waste ratio `0.047619`.
Cycle-first ordering, incumbent removal, and topology/score/parent-lineage quotas
all failed to recover that result at width `8`.

Bounded terminal repair changes the practical result without pretending that
beam pruning predicted the delayed reward. The measured width-8 compact-quality
profile with repair budget `8` reaches 24 structural contacts, dominant contact
count 17, cycle rank 5, collision-bounds area `80174.3328 mm2`, and hull waste
ratio `0.047619` in about `4.53 s` on the benchmark machine. It is a general
remove-and-reinsert improvement using real candidates, not a triangle-specific
override. The unrepaired beam remains available with repair budget `0`.

### Historical Ordinary-Decoder Triangle Golden

This section records the earlier beam-plus-repair golden; it is not the current
archive-only Triangle production gate. The hermetic repeated-triangle golden is
derived only from replay job `e8ed1b5a-b18f-4f3d-ada1-79634bb10bb0`. The test
does not read replay files,
the workspace database, or renderer state at runtime. It creates 20 deterministic
copies of the built-in `70 x 60 mm` triangle and runs them on the original
`2000 x 2700 mm` sheet with `10 mm` total padding, rotations and mirroring
enabled, and the Compact quality profile (`order 4`, `beam 8`, `fanout 4`,
`repair 8`, `transform cap 8`, edge-contact policy, and GA disabled). The
original sheet remains part of the fixture because measured smaller sheets
changed candidate legality or ranking and did not preserve the approved result.

The approved result is a bottom-left compact lattice with all 20 pieces placed.
Its measured collision envelope is approximately `353.152 x 227.025 mm` in one
terminal orientation, with area `80174.3328 mm2`, span `580.177 mm`, hull waste
ratio `0.047619`, 24 structural contacts, dominant contact count 17, and no
free-material holes. The regression enforces an orientation-invariant quality
envelope around those measurements rather than raw piece ids or every
floating-point transform. Interchangeable-copy permutations, terminal
quarter-turns, and equivalent compact arrangements therefore remain valid,
while upward or rightward chains, missing pieces, weak contact graphs, and
triangle-sized lattice gaps fail the contract.

### Ordinary-Decoder Decision Trace

When worker history is enabled, every irregular beam decode can synchronously
emit plain internal decision-event classes. The trace identifies the executed
baseline or GA chromosome and records generated legal-candidate counts, bounded
local score detail, local fanout decisions, successor deduplication,
whole-layout scores, beam retention or pruning, and the final winner.
`historyMode: off` leaves the callback absent, so normal benchmark decodes do
not construct trace events.

Local candidate detail is deliberately diagnostic rather than exhaustive. For
each parent state and eligible piece, the trace retains the complete score and
selection decision for every selected candidate, any candidate displaced by a
compactness reservation, one protected intrinsic candidate outside production
fanout, and the first candidate rejected below the local fanout cutoff. One
`local_candidate_summary` then reports generated, unique, selected, and detailed
totals plus counts for every selection or rejection reason, including duplicate
local geometry. With fanout `F`, this bounds full local detail to at most
`F + 3` candidates per parent/piece even when NFP generation produces hundreds
of candidates. Transform events still report the full legal-candidate counts.
Successor scoring, successor deduplication, beam
selection, terminal orientation, local repair acceptance, and the winner remain
exhaustive. This reduction changes only diagnostic persistence; candidate
generation, ranking, retained states, winner selection, and replay history are
unchanged.

The worker serializes these events as one JSON object per line in a separate
`<jobId>.decision-trace.ndjson` file. Replay history remains the selected
winning-state timeline used by the UI; the decision trace is a diagnostic audit
of alternatives that disappeared before the winner was chosen. Each decode uses
compact deterministic chromosome, state, and candidate ids while retaining its
decode id for correlation. The worker preserves event order while serializing
bounded batches instead of issuing one filesystem append per event.
Accepted terminal moves emit `local_repair_accepted` with the iteration, moved
piece, repaired state, and whole-layout score.

The shipped interactive profile is intentionally narrow: `orderWindow = 1`,
`beamWidth = 1`, local candidate fanout `= 4`, transform cap `= 16`, and GA
disabled. It produces a deterministic first result while retaining enough real
local alternatives for the whole-layout scorer to reject obvious fragmentation.
Each invocation uses an independent settings instance, so renderer and CSV
editing cannot mutate a shared default.

The renderer separately persists one mirror-eligibility flag per imported source
shape. Both normal and CSV preparation copy that flag into every generated
`PreparedPiece`, and the global mirror gate must also be enabled before a
mirrored transform can be generated.

`GeometryKernel.Live` currently implements DXF source flattening, convex hull,
strictly convex polygon offsetting, and transformation of one padded collision
polygon. Transforming validates the strictly convex collision boundary with
robust predicates, mirrors across the stable local Y axis first, then rotates
counter-clockwise around the unchanged placement reference; its output includes
the resulting local bounds. `CollisionGeometryBuilder.Live` composes flattening,
hulling, offsetting, and normalization for a closed imported outline: it
preserves source samples, rebases both derived polygons to the padded collision
polygon's lower-left bounds corner, and carries import warnings as diagnostics.
Offset derives its outward distance from half the caller-provided total padding
plus `clearanceSafetyMarginMm`. Invalid or non-convex geometry is rejected
instead of inventing a collision polygon. `TransformGeneratorLive` now emits
only a deterministic finite set of rotation/mirror metadata: orthogonal angles,
configured angles, and usable-edge alignments. For a convex polygon, the
minimum-area oriented bounding box always has a side parallel to a polygon edge,
so the complete edge-alignment set already contains every OBB orientation and
there is no separate redundant `oriented_bounds` reason. It does not transform
polygons or place pieces. Its
`transformMinimumEdgeLengthMm` setting means that edges shorter than the
configured physical millimeter threshold are ignored as geometric noise; the
default is `1`. Its
`transformAngleDeduplicationToleranceDeg` setting means that periodic angles
within that circular degree distance are treated as one candidate; the default
is `0.01` degrees. When global rotation or the prepared piece disables
rotation, it emits `0` degrees only. `configuredRotationDeg` defaults to an
empty array and lets the optimizer add finite degree values explicitly.
`NfpIfpServiceLive` defaults to the exact vertex-pair plus convex-hull
construction for correctness. The linear edge-merge constructor remains
available through the explicit `makeNfpIfpServiceLayer` and
`makeNfpIfpServiceLive` factories for benchmark and differential-test wiring;
its translated-ring canonicalization uses an exact hull fallback whenever the
O(n) pass cannot prove strict convexity. Both factories accept
`NfpConstructionAlgorithm` (`linear-edge-merge` or `vertex-pair-hull`) and
default to `vertex-pair-hull`; the linear edge-merge path is an explicit
differential/experimental construction, not the current performance default,
because safe translated-ring canonicalization can require an exact hull
fallback. Every candidate still passes direct
convex placement validation, which remains the legality authority. Candidate
generation indexes NFP boundaries and boundary segments using inclusive
axis-aligned overlap, so it skips only pairs whose bounds prove that no contact
can occur. Candidate points are canonicalized and deduplicated as they are
collected, and points or boundary pairs outside the IFP bounds are discarded
only when those bounds make them impossible candidates. Exact contacts and
every non-disjoint case continue to robust predicate classification, followed
by direct legality validation.

Collision offsets use the versioned Clipper2 `clipper2-offset-v3` policy with
integer `Paths64`, `0.001 mm` grid precision, Miter joins, and a miter limit of
`10.0`. This keeps the triangle fixture's acute corners pointed instead of
turning them into short chamfer edges. The limit remains finite, so inputs with
an even larger required miter ratio still take Clipper2's bounded fallback; the
adapter policy version participates in geometry cache identity.

`FreeMaterialServiceLive`
computes the
sheet-space difference between the sheet and the union of translated placed
collision polygons through Clipper2's integer `Paths64` and `PolyTree64`
boundary. Its output groups each outer material boundary with its direct holes
for visualization and scoring. An exact point contact can appear as a repeated
non-adjacent vertex in a computed Clipper boundary; that winding is preserved
for its correct net diagnostic area, while source polygons remain strictly
unique-vertex validated. Free material is never used as placement legality or
as an implicit concave/hole-aware nesting feature.

The alternative geometry paths are parity-gated experiments, not interchangeable
defaults. Focused tests compare NFP construction and free-material operations
using convex fixture-derived geometry across winding, transforms, padding, and
typed failures. A backend switch also requires the complete
`IrregularLayoutScorer` tuple: elapsed time and placed count alone are not a
quality equivalence proof. The hard benchmark corpus records exact score deltas
and serial elapsed-time medians. Its measured linear-edge-merge variations are
numerically negligible but have no broad speed advantage; direct difference is
exact-score equivalent but slower. The shipped vertex-pair-hull plus
union-then-difference defaults therefore remain unchanged.

`PlacedCollisionSpatialIndex` is a worker-private persistent uniform grid for
translated placed-collision bounds. Each beam state carries the index for its
branch and appends one committed placement when creating a successor; the
strict decoder follows the same append-only path. Grid queries are conservative:
large or non-finite cell ranges and invalid placed geometry remain in a fallback
set, and exact convex validation still decides legality.

NFP candidate generation deliberately iterates the supplied placed array; its
separate NFP-boundary `BoundsIndex` pruning remains the mainline/reference
differential path. The pre-Volta candidate reference supplies no spatial index
and therefore performs the original full placed-array legality checks. A
matched persistent index is used only by direct placement validation, where its
translated moving bounds can exclude disjoint placed entries before the same
exact positive-area overlap predicates run. A missing or mismatched index falls
back to the full placed array, so the optimization cannot use stale branch
state or change candidate legality.

## Current Integration State

`NestingOptions.workerMode` accepts both:

- `maxrects-beam-search`;
- `irregular-convex-v2`.

Normal requests, exported requests, project/workspace persistence, and CSV
run configuration can carry the irregular mode. `NestingRequest` also has an
optional `sourcePieces` payload so the irregular worker can receive the original
DXF geometry summaries instead of only rectangle-prepared pieces.

The worker runs `computeIrregularNesting` for this mode. It preserves prepared
copy ids and source ids, emits `IrregularLayout` transform placements with the
source-space placement reference required to reproduce each transform rather
than fabricated rectangle placements, and writes tagged `IrregularHistoryFrame`
records to the normal NDJSON history path. It replays the selected portfolio
chromosome when GA is enabled; a deterministic beam-only run records its
winning path during the single baseline decode. In either case it follows
explicit beam-state parent links from the terminal state back to the empty
state, so persisted and emitted history contains only the actual winning branch
rather than losing beam alternatives. Worker lifecycle and portfolio-progress
events are forwarded through the main-process supervisor to the renderer, which
shows the real current phase instead of a fake percentage. Missing source
geometry becomes the typed
`irregular_source_geometry_missing` worker failure; invalid derived geometry
and scoring become distinct typed failures.

For the explicitly enabled compact-quality profile, with GA inactive and no
intentional `short_side_fill` policy, `computeIrregularNesting` runs the
intrinsic anytime coordinator instead of the ordinary windowed beam. Exact
preflight proofs may route directly to capacity. Otherwise the coordinator
starts a bounded cold-capacity checkpoint and interleaves it with the protected
sheetless complete constructors. Complete endpoints enter the complete
namespace and remain ranked only by intrinsic geometry and topology; capacity
endpoints enter a separate count/material-first namespace.

A settled fitting complete archive may then run one bounded focused complete
reconstruction producer. It derives a deterministic q90 right-to-left piece
order from the unfiltered settled sheetless leader and rebuilds through the
existing exact strict constructor. The result enters the same complete archive;
it receives no scoring exemption and cannot weaken the protected endpoint.
The producer has fixed runtime and candidate-evaluation bounds, propagates
external cancellation, and records explicit duplicate, evaluation-cap,
deadline, incomplete, skip, failure, candidate, and selected states.

Requested-sheet fit determines whether the producer can affect the current
request, but never chooses its source. The source remains the highest-ranked
unfiltered sheetless complete endpoint even if a lower-ranked protected
endpoint is the first one that fits. Exact preflight impossibility and a
settled complete archive with no fitting endpoint both skip reconstruction
with zero focused work, preserving the existing capacity checkpoint path.

A fitting settled complete endpoint wins and cancels capacity. If the complete
archive settles without a fitting endpoint, that outcome is not an error: the
existing cold/warm checkpoints continue to exact capacity settlement, which
returns a disjoint placed/unplaced request partition. Sheet dimensions
constrain capacity legality and q0/q90 endpoint fit, but never rank or prune the
complete cohort.

The schema-backed `intrinsicObjectiveProfileId` may select `compact` or
`short-side`. Both first run the same protected Compact coordinator on the same
single worker. `short-side` then observes settled complete endpoints at q0/q90;
if that has no admitted winner, it evaluates the bounded pair-fold, multi-row
shelf, and contact-strip terminal constructions sequentially under their shared
runtime and RSS limits. Only a canonical-legal, all-piece admitted result may
replace the selected Compact result. Otherwise the worker returns the exact
Compact or capacity result with an `intrinsic_short_side_compact-fallback`
diagnostic. The selector changes neither complete-cohort construction nor
intrinsic archive ranking, and does not create another worker or a concurrent
algorithm execution.

The compact path has no ordinary-beam competitor and no fixed-reference
fallback. An incomplete direct state cannot become an endpoint. Cooperative
cancellation, deadline censoring, incomplete execution, invalid geometry, or
invalid accounting remain typed failures; a settled non-fitting complete
archive does not. External renderer cancellation remains a supervisor boundary
that disposes the worker and returns no partial result. The fixed family,
transform, pair, cell, continuation, and capacity caps are intentional
deterministic search bounds rather than claims of exhaustive coverage.
Progress reports the real coordinator phases and emits the selected exact
complete or capacity endpoint as `completed`. Irregular jobs use a `390000 ms`
timeout floor; other worker modes retain their configured timeout.

Selected archive history truthfully reveals prefixes of the selected exact
layout. Intermediate frames are labelled
`shared-archive-selected-layout-reveal` and the terminal record is
`shared-archive-final-selected`; this is not fabricated beam ancestry. The
selected endpoint retains its exact canonical contact and hull metrics while
free-material metrics are reconstructed on the requested sheet. Exact
occupied-union cavity count is exposed separately as
`canonicalEnclosedCavityCount`; it must not overwrite the sheet-space
`freeMaterialHoleCount` measurement.

The removed canonical-reference coordinator, fixed `2000 x 2700` decode, admission
certificate, and `canonicalReferenceDecodeEnabled` schema field are historical only.
The compact production gate now contains nine baselines. On `2000 x 2700`,
Triangle-20 is `74,428.143126 mm2`, Mixed-61 is `391,605.850174 mm2`, and
Shapes-17 is `281,233.148068 mm2`; all pieces are placed and canonical cavity
count is zero. The Shapes endpoint is the exact `1ddc8426...` focused
reconstruction of protected sheetless source `c640c06f...`; it is unchanged on
the tested `600 x 600`, `5000 x 5000`, and `10000 x 10000` roomy sheets. On
`600 x 400`, Triangle-20 retains the exact same canonical
motif, Shapes-17 settles an exact 14-piece subset at `232,178.021694 mm2`
with three pieces unplaced and zero canonical cavities, and Mixed-61 settles an
exact 25-piece subset at `239,484.9666 mm2` with 36 pieces unplaced and zero
canonical cavities. On `300 x 300`, Triangle-20 places 17, Mixed-61 places 6,
and Shapes-17 places 5; every result has an exact placed/unplaced partition and
zero canonical cavities. Layout identity ignores translation, rigid
quarter-turn, copy order, ring origin, and winding while preserving reflection
and relative placement.

Two independent strict ten-sheet production runs at `6179cef` completed on
2026-07-24. All twenty Mixed-61 decodes placed every piece and returned the same
canonical collision geometry, area, topology, and byte-identical normalized
SVG. See the
[`current-production-invariance-matrix`](../artifacts/current-production-invariance-matrix/)
and the [standing verification gate](../operations/irregular-production-gates.md#full-current-sheet-matrix).

Do not route `irregular-convex-v2` requests to MaxRects.

The renderer accepts tagged irregular history alongside existing rectangular
history. It redraws the original DXF segments using the stored placement
reference, mirror, rotation, and translation, and can overlay the exact
translated padded collision hulls emitted by the worker. A placement missing
its source or reference is reported as unrenderable rather than replaced with
a rectangle.
The debug and history panels expose real result status, transforms, candidate
counts, free-material score metrics, unplaced ids, and diagnostics.

CSV/manual subruns preserve tagged irregular layouts and transforms while they
are aggregated. The rectangle CSV serializer rejects an irregular record only
at export time because its rows cannot represent a transform placement; regular
result JSON instead includes an explicit schema-validated irregular transform
export with source/copy ids, placement reference, transform, subrun metadata,
and CSV source-row links when available.

## Benchmark Corpus Contract

The standalone `benchmark:irregular` runner has named deterministic corpus cases
and search profiles so capacity-sensitive comparisons do not depend on hidden
process state. The current cases use the imported triangle/trapezoid set with
20 pieces on `500x300` and `550x300` sheets, plus a raw skewed-quadrilateral
case with 12 pieces on `330x160`. The named profiles include narrow and wider
deterministic beams, a low-budget seeded GA same-count comparison, a bounded
GA run that reaches all 20 pieces on the tighter sheet, and same-count beam
profiles for the raw skewed-quadrilateral case.
Named GA profiles use explicit generation/evaluation limits and a neutralized
large time sentinel rather than a 15-second wall-clock cutoff, so the seed and
those finite limits determine the comparison result.
The skewed beam-1 and beam-4 profiles are executed through the shared runner
in tests; they place the same count with passing audits, while beam-4 produces
a strictly better whole-layout score.
For option precedence, an explicit CLI value overrides the selected profile,
which overrides general defaults. An explicit `--ga-enabled` also derives
`baselineOnly` to its inverse when `--baseline-only` is omitted; an explicit
`--baseline-only` value wins over that derivation, and the contradictory pair
`gaEnabled=true` plus `baselineOnly=true` is rejected.

Every invocation emits a `provenance` JSON record containing `baselineSha`,
`variantSha`, Node and pnpm versions, platform, architecture, host identifier,
UTC timestamp, exact replay command, and the benchmark runner version. The
record also contains `baselineRevision` and `variantRevision`, each recording
the verified full SHA (or `null` with an `unavailable` source), the requested
CLI/environment value or default ref, and the source used to resolve it. The
baseline revision defaults to `origin/main` and the variant revision to `HEAD`;
explicit CLI values and the corresponding environment variables must be full
40-character commit SHAs that resolve to commits in the current repository.
When both revisions resolve, `exactCommand` pins those SHAs for replay; if
either revision is unavailable, `exactCommand` is `null` rather than claiming
an exact replay command. A
`resolvedProfileSettings` JSON record follows it and contains the complete
resolved CLI/profile settings, including fixture and piece budgets, search
controls, GA controls, and measurement counts.
Corpus id and area bounds are included only when the resolved fixture order,
repeat count, piece count, sheet dimensions, and padding exactly match a
declared corpus case; otherwise those corpus-specific fields are omitted.

Each corpus case also carries raw polygon areas and axis-aligned bounding-box
areas measured from its checked-in DXF source geometry. The triangle/trapezoid
fixtures declare areas `3150` and `6375` square millimeters with bounding-box
areas `6300` and `8625`; the skewed quadrilateral declares `3200` and `4400`.
The runner-side bound reports the total raw piece area as a necessary lower
bound, the summed axis-aligned box area as a conservative packing diagnostic,
the sheet area, and both slacks. Passing the raw-area condition is necessary
but not sufficient for legal nesting; the raw skewed-quadrilateral case has a
deterministic 3-by-4 grid witness whose `12 * 110 * 40` bounding-box area
exactly equals its `330 * 160` sheet area.

Every measured row reports the elapsed time, placed and unplaced counts, the
terminal legality-audit status, and the complete whole-layout score. The score
is compared in this order:

1. lower `unplacedCount`;
2. higher `dominantNearCompleteStructuralContactCount`;
3. at 20 or fewer placements, higher exact
   `nearCompleteStructuralContactCount`; above 20 placements, higher
   `floor(nearCompleteStructuralContactCount / 2)`;
4. lower `collisionBoundsWorstNormalizedSheetConsumption`;
5. lower `collisionBoundsNormalizedSpanSum`;
6. lower `collisionBoundsAreaMm2`;
7. lower `collisionBoundsSpanMm`;
8. lower `occupiedHullWasteRatio`;
9. above 20 placements, higher exact
   `nearCompleteStructuralContactCount` after compactness;
10. higher continuous normalized contact units, then exact shared boundary
    length; at 20 or fewer placements the legacy integer contact band remains
    ahead of those continuous contact tie-breaks;
11. lower collision-bound `minY`, then `minX`, to anchor equivalent layouts at lower-left;
12. higher `largestNetFreeMaterialRegionAreaMm2`;
13. lower `freeMaterialRegionCount`;
14. lower `freeMaterialHoleCount`;
15. lower `freeMaterialSliverMetric`.

A structural contact is an exact collinear overlap between two collision edges
that are each at least half as long as their polygon's longest edge. It counts
only when the overlap covers at least 95 percent of the shorter contacting edge.
This gives the beam an immediate discrete reward for a real near-complete edge
mate while excluding short offset-join chamfers and substantial but incomplete
edge fragments. The scale-normalized contact band and raw millimeters remain in
results and traces as diagnostics and late tie-breaks; they do not outrank
compactness once structural-contact counts tie.

Each qualifying contact also receives a local edge-shape signature. The
signature contains the contacting edge length normalized by its polygon's
longest edge plus the normalized adjacent-edge lengths and endpoint turn at
both ends. Endpoint descriptors and the two participating edge descriptors are
sorted, so the signature is invariant to placement, rotation, mirror, winding,
and piece order. Values are quantized to deterministic `0.001` ratio/turn bands.
`dominantNearCompleteStructuralContactCount` is the largest frequency in the
layout's internal signature histogram. Ranking it first keeps one repeated
edge-mating motif alive instead of letting a mixture of unrelated full-edge
contacts form a branching contact graph. The histogram remains private beam
metadata; results and decision traces expose only the dominant frequency and
the total structural-contact count.

Collision-bound compactness intentionally comes before free-material diagnostics:
when every piece stays within one connected sheet region, the total free area is
nearly constant and small Clipper2 quantization differences must not steer the
beam toward a looser cluster. Collision-bound width, height, `minX`, and `minY`
are first canonicalized to an explicit `0.001 mm` score grid. This removes
floating subtraction noise that can otherwise make translated but identical
layouts compare differently at large sheet coordinates; it is deterministic
quantization at the existing collision-geometry precision, not an epsilon
comparison. The dimensionless occupied-hull waste ratio is likewise
canonicalized to the `0.000001` scalar score grid before ranking, so shoelace
area cancellation at large translations cannot split otherwise equivalent beam
states. Lower-left anchoring then precedes free-material diagnostics so symmetric
placement is not selected by fragmentation noise.

Rows also include placement order and unplaced source ids for the scorer's
final deterministic tie-breaks. A terminal audit failure makes the row invalid;
placed count alone is not a quality result.

Benchmark rows also include a `gaMetrics` JSON record that stays outside worker
protocols and product output. `scheduledEvaluationSlots` and
`distinctChromosomeKeys` describe GA-loop scheduling; evaluated-chromosome cache
hits and misses distinguish reused results from new work. `actualFullBeamDecodes`
includes the deterministic baseline plus every cache miss that starts a decoder.
The decoded-beam elapsed and candidate totals aggregate successful baseline and
GA phase measurements, while final reconstruction and final-score timings
measure materializing the selected portfolio result separately. These counters
are benchmark-only and do not alter optimizer decisions, scores, or legality.
Candidate totals are read from completed decoder results rather than step-time
callbacks. During GA search, the portfolio reimburses only metrics collection
and benchmark phase callbacks against the search deadline before scheduling the
next evaluation, so opt-in reporting cannot change time-budget termination.

## Ownership

Geometry services remain under `src/workers/irregular/`. Placement selection,
scoring, beam state, and search belong under `src/workers/algorithm/`, including
the strict-priority decoder, local irregular scorer, layout scorer, windowed
beam, and seeded GA/search portfolio:

- priority ordering;
- placement candidate selection;
- windowed beam;
- scoring;
- GA/search.

`src/workers/algorithm/irregular/irregularPlacementScorer.ts` owns the local
candidate-policy score for candidates already accepted by NFP/IFP generation
and direct validation. `irregularLayoutScorer.ts` owns a separate lexicographic
whole-layout score for beam retention: unplaced count first, then near-complete
structural contacts, compact collision bounds, occupied-hull waste, legacy
contact diagnostics, lower-left anchoring, and free-material usability and
fragmentation diagnostics. Free material is scoring-only and never accepts or
rejects a placement. Local translated-ring deduplication happens before fanout;
after expansion and before the expensive layout score, the beam separately
deduplicates successor states by canonical occupied geometry and the ordered
remaining sequence of explicit interchangeability signatures. Normal quantity
copies share their original source signature; CSV copies additionally retain
their CSV row identity. Collision geometry, transform sets, and per-copy
transform preferences remain part of the signature, while concrete copy ids
remain on the deterministic representative used for history and output. This
prevents equivalent transforms and identical-copy permutations from consuming
the configured diversity without merging distinct sources, customer rows, queue
orders, or search behavior. The run also retains its scored beam states. A
bounded cache owned by the layout-scorer service reuses
only Clipper2 free-material snapshots for identical sheet and occupied
geometry, including across portfolio decodes. When a cached parent state gains
one placement, it subtracts that collision polygon from the cached material
snapshot through the same integer-grid `PolyTree64` adapter; root, cache-miss,
and failed-incremental paths retain the full sheet-minus-occupied computation.
It always rebuilds the state-specific score so placement order and unplaced ids
remain correct. This removes duplicate Clipper2 work without changing legality,
score criteria, or the winning-path history.

`portfolioSearch.ts` owns chromosome construction, deterministic PRNG mutation,
crossover, evaluation/generation/time checkpoints, progress, cancellation, and
selection between the GA and beam results. GA initialization always puts the
deterministic priority-ordered chromosome first as the greedy incumbent. The
remaining initial chromosomes use deterministic single-gene and multi-gene
mutation strata derived from `gaSeed`, deduplicate when alternatives are
available, and fall back to the incumbent only when the configured gene space
cannot produce enough distinct chromosomes. Every later generation carries the
same incumbent forward, and final portfolio selection compares it with every
GA result, so broader search cannot discard a baseline result. Its transform
gene is a preferred candidate index with deterministic fallback to the
remaining legal transforms; it never encodes raw coordinates. Portfolio
selection uses the same `IrregularLayoutScorer` ordering as beam retention,
including placement order and unplaced source ids as final deterministic
tie-breaks; the incumbent preference applies only on a complete score tie.
`geometryCacheKeys.ts` namespaces transformed geometry, pairwise NFP, and IFP
artifacts by their complete geometry/settings identity, and validates cached
artifacts before reuse. Pairwise NFP keys use
canonical transformed fixed and moving polygon geometry plus transform, settings,
NFP operation, and construction algorithm identity; they deliberately exclude
piece ids and fixed sheet translation. The pairwise cache stores only the
relative NFP boundary, while `NfpIfpService` returns a fresh id-bearing result
after applying the current fixed translation. Free-material regions remain a
sheet-space diagnostic artifact and do not replace direct placement validation.

The live NFP service also owns a decoder-local memo for complete legal candidate
sets. `windowedBeam.ts` creates one opaque scope for each decoder invocation and
passes it through ordinary expansion and terminal repair. Within that scope,
the memo key contains the sheet dimensions, local placed collision rings in
placed-array order with their sheet translations, the ordered moving collision
ring and bounds, geometry settings, candidate-pruning mode, and NFP construction
algorithm. Ring order, winding, and the local/translation decomposition
remain exact because they participate in floating-point candidate construction.
Copy ids and the
current moving transform metadata do not affect legal point geometry, so cached
entries store only points and diagnostics and restore fresh piece and transform
metadata for every caller. Cache hits still run the cooperative-control
checkpoint; failed or aborted generation is never stored. Calls without a scope
retain the uncached service behavior, and separate baseline, GA, repair, or
replay decodes cannot share entries. This is exact geometry-infrastructure
reuse: it does not change candidate generation semantics, local ranking, beam
retention, scoring, or history selection.
