# Compact Architecture, Explained Simply

The Compact path is a competition between several independent layout builders.

## HARD CONSTRAINT: COMPACT IS SINGLE-PROCESS

> **UNTIL THE USER EXPLICITLY SAYS OTHERWISE, COMPLETE AND CAPACITY WORK MUST
> RUN COOPERATIVELY AND SEQUENTIALLY INSIDE ONE EXISTING ALGORITHM WORKER.
> NEVER LAUNCH ANOTHER PROCESS, CHILD PROCESS, NESTED WORKER, `worker_thread`,
> OR CONCURRENT COHORT EXECUTION FOR ONE NESTING JOB.**

Independent builders are logical cohorts, not CPU-parallel tasks. “Interleaved”
always means deterministic pause/resume on one execution thread. This rule
overrides performance experiments and remains in force until the user
personally revokes it.

## 0. Essential Vocabulary

### Piece

A piece is one polygon that must be placed. In Mixed-61 there are 61 pieces; in
Triangle-20 there are 20. Compact first tries to place every requested piece
without overlap. When the requested sheet cannot hold them all, it returns the
best exact subset it found and explicitly lists the remaining pieces as
unplaced.

### Layout

A layout is an arrangement of some or all pieces. A layout is:

- **partial** while pieces are still missing;
- **complete** when every requested piece is present;
- **settled subset** when search has finished with some pieces explicitly
  unplaced;
- **legal** when pieces do not overlap and satisfy the geometry rules.

### Candidate

When the algorithm is about to place one piece, it normally has many possible
legal positions. Each possible position is a candidate.

For example:

```text
place the new piece beside the left edge     → candidate A
place it inside an open pocket               → candidate B
rotate it and place it above the cluster     → candidate C
```

The scorer compares these candidates. The selected candidate becomes part of
the current partial layout; the others are discarded.

### Rotation and mirroring

A rotation turns a piece. Mirroring reflects it, as if the shape were viewed
in a mirror. Reflection is not generally equivalent to rotation.

Each prepared piece records whether mirroring is allowed. When it is allowed,
the transform generator may produce both ordinary and mirrored orientations.
The `mirrored` flag is part of transform identity, periodic-cell provenance,
canonical geometry, legality checks, and replay identity. A mirrored placement
therefore competes as a real geometric alternative.

When mirroring is forbidden, no mirrored candidate is generated. The current
Triangle-20, Mixed-61, and Shapes-17 baselines all enable mirroring, so their
reported runtimes include the larger mirrored transform domain.

### Constructor

A constructor is a complete method for growing a layout.

It receives a starting arrangement, repeatedly chooses where to place the next
piece, and stops when:

- every piece has been placed;
- the capacity cohort has made an exact place-or-skip decision for every piece;
- its deterministic evaluation budget has ended; or
- it proves that its current path cannot produce a legal completion.

Different constructors can make different early choices. That matters because
a position that looks best now can block a much better arrangement several
pieces later.

### Seed

A seed is simply the starting partial arrangement given to a constructor.

The constructor does not necessarily start from an empty layout. It can start
with a few pieces already arranged in a legal, promising motif. Those initial
pieces and their exact positions form the seed.

This is similar to giving several people the same box of puzzle pieces but
starting each person with a different small group already assembled. Every
complete-cohort constructor must still place every remaining piece. A
capacity-cohort constructor may instead settle with explicit skipped pieces
when the sheet is too tight. The different starts expose different possible
futures.

Seeds are not fake final answers and they do not receive a scoring exemption.
After completing them, every constructor submits its result to the same exact
archive and the same final comparison.

The current seed categories are:

#### Normal compact seed

This is a conventional deterministic start produced by the general compact
constructor. It tries to begin from a small occupied envelope without relying
on a recognized repeated pattern.

It is the ordinary control path: useful when the input has no special repeated
geometry.

#### Open-pocket-first seed

An open pocket is an empty region that is still accessible from outside the
current cluster. It may be useful for a later piece.

The open-pocket-first seed tries to avoid an early arrangement that surrounds
a large unusable hole. It begins from a motif that leaves useful empty regions
open for later filling.

This does not mean “maximize empty space.” It means prefer a compact start
whose remaining gaps can still be used, instead of closing a ring around empty
material.

#### Repeated-pattern or periodic seed

When several pieces share the same geometry, a small group may form a motif
that can repeat by translation.

For example, two edge-matched triangles can define a repeating triangular
lattice. A periodic seed begins from a finite, collision-free crop of such a
motif.

The algorithm derives the repeating directions from exact geometric contact;
it does not contain a hard-coded “Triangle-20” layout. The same mechanism can
apply to any compatible repeated family.

#### Raw source-audit witness

The periodic search initially generates more exact cells and finite crops than
the normal bounded selector can retain. The source audit observes those
pre-pruning candidates.

A witness is one promising legal crop that proves: “this exact starting motif
really existed before pruning.” It is called raw because it comes from that
earlier candidate population, before the normal retained-cell frontier.

Before a cached witness can be used, the current algorithm:

1. verifies that it belongs to a currently eligible piece family and cell;
2. reconstructs its declared finite crop from that current cell;
3. checks piece identity and uniqueness;
4. checks canonical collision legality;
5. recomputes its canonical identity, topology, and envelope metrics.

Only a witness that passes all checks becomes an ordinary seed. It then
competes under the same construction budget and exact archive as every other
seed.

### Cold and warm execution

These terms describe whether the expensive source-audit discovery is repeated.
They do not describe different scoring or different quality modes.

#### Cold execution

A cold run has no reusable audit result. It:

1. generates the current periodic cells;
2. enumerates all bounded finite crops in the selected source domain;
3. measures and filters them;
4. retains the best witnesses;
5. runs the selected constructors.

This is the authoritative from-scratch path.

#### Warm execution

A warm run receives a replay envelope produced by an earlier identical cold
run.

The envelope contains the previously discovered audit witnesses plus identities
that bind them to:

- the replay format and algorithm version;
- the normalized prepared pieces;
- the source-audit scope;
- an optional basis-source restriction;
- the currently eligible family, cell, and source domain;
- the exact replay contents.

The warm run never trusts those bytes blindly. It validates the envelope and
requires its expected content digest through a separate trusted channel. That
separate digest proves that witnesses were not silently removed from the cache.
The algorithm then reconstructs every claimed witness crop from the current
cells and uses those regenerated seeds downstream instead of using cached
placement objects. If any file, schema, digest, identity, source, crop,
piece-copy assignment, legality, topology, or metric check fails, the cache is
treated as a miss and the ordinary cold path runs automatically.

When validation succeeds, the algorithm avoids exhaustive rediscovery of the
same source-audit crops. Ranking, construction, archive admission, and winner
selection are unchanged.

In the current exact Mixed-61 measurement:

```text
cold exhaustive source-audit crop attempts:    23,456
warm targeted crop reconstruction attempts:       352
```

The cold and warm runs produced byte-identical winner SVGs.

## 1. Several bounded constructors

A constructor is one strategy for building a complete layout piece by piece.
For example, one constructor may begin from:

- a normal compact seed;
- an open-pocket-first seed;
- a repeated-pattern or periodic seed;
- a raw source-audit witness that survived exact validation.

“Bounded” means that every constructor receives a fixed, deterministic
allowance. It can evaluate only a limited number of candidates and
continuations; it cannot search forever. This keeps runtime reproducible and
prevents one strategy from consuming the entire quality budget.

Each constructor repeatedly performs the same broad operation:

```text
current partial layout
    → generate legal positions for the next piece
    → score those positions
    → retain the best one
    → continue until every piece is placed or the budget ends
```

The constructors intentionally start from different ideas because one greedy
strategy cannot predict every useful future. A periodic seed may discover a
repeated triangle lattice, while pocket-first construction may work better for
heterogeneous pieces.

## 2. Complete and subset layouts have separate exact archives

The architecture deliberately does not place complete and subset states in one
beam or compare them with one scoring rule.

The **complete archive** accepts only layouts with every requested piece
placed. It preserves the established sheetless Compact ranking.

The **partial archive** accepts only settled endpoints whose placed and
unplaced piece IDs form an exact, disjoint partition of the request. Its
objective compares:

1. placed piece count;
2. placed material;
3. the existing exact partial compactness metrics.

Both archives require canonical Clipper2 legality, deterministic geometry
identity, and finite measurements. At final selection, any fitting complete
endpoint dominates every subset endpoint. A subset wins only when no settled
complete endpoint fits the requested sheet.

### Reusing a settled complete result

The complete archive can give its settled sheetless leader to one small,
bounded reconstruction producer. This is useful when the original constructor
found all pieces but made poor early choices.

The producer does not start from empty and it does not try to move one piece at
a time inside the old layout. It reuses the old endpoint as information:

```text
settled exact complete layout
    -> derive one deterministic geometric piece order
    -> rebuild all pieces with the existing exact constructor
    -> submit the rebuilt endpoint to the same complete archive
```

If rebuilding finds a better exact complete layout, the archive may select it.
If it duplicates the old order, runs out of its fixed budget, fails to finish,
or produces a worse layout, the protected result remains untouched.

The current focused order reads the settled layout in a rigid q90 frame from
right to left. This is generic geometry-derived ordering: it contains no
Shapes-17 IDs and no requested-sheet dimensions.

## 3. The sheet-independent complete archive

Conceptually, the archive resembles this table:

| Layout | Area | Maximum side | Cavities | Hull gap | Cohesion | Canonical hash |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| A | 391,606 | 629 | 0 | 0.137 | … | `ef2b…` |
| B | 405,773 | 680 | 0 | 0.150 | … | `…` |
| C | 430,345 | 760 | 2 | 0.190 | … | `…` |

The canonical hash identifies the arrangement independently of its absolute
position and permitted rigid quarter-turn orientation. Equivalent copies are
deduplicated.

Crucially, archive ranking does not use:

```text
layoutWidth / requestedSheetWidth
layoutHeight / requestedSheetHeight
distance from a requested sheet edge
```

It uses properties of the arrangement itself:

- occupied-envelope area;
- maximum occupied side;
- occupied span;
- enclosed cavities;
- convex-hull waste and gaps;
- contact-component and cohesion information;
- deterministic geometry identity.

Changing a roomy sheet from `2000 × 2700` to `1000 × 1300` therefore cannot
change which arrangement is intrinsically more compact.

## 4. Where the requested sheet enters

Only after sheetless layouts exist and have been intrinsically ranked does the
algorithm test requested-sheet fit:

```text
Does this completed layout fit at 0°?
Does the same completed layout fit after a rigid 90° rotation?
```

These orientations are called `q0` and `q90`.

No pieces are individually rearranged during this step. The complete motif is
rotated as one rigid object.

The selection process is:

```text
build and rank layouts without sheet preferences
    → discard layouts that do not legally fit the requested sheet
    → choose the best remaining intrinsic layout
```

A smaller sheet may legitimately reject a motif because it physically does not
fit. But if the same best motif fits on two sheets, those sheets cannot express
different compactness preferences and steer the search toward different
geometry.

That separation is the basis of sheet invariance: sheet dimensions constrain
legality and final fit, but not compactness preferences.

For the capacity cohort, the sheet also constrains whether each proposed
placement is legal and whether the current occupied span fits at `q0` or
`q90`. It may influence named scheduling buckets, but it never enters the
complete cohort's compactness comparator.

## 5. The resumable anytime scheduler

Compact now starts protected capacity work before the complete cohort has
finished. Both cohorts advance in deterministic quanta:

```text
capacity checkpoint
    → complete-constructor checkpoint
    → capacity checkpoint
    → complete-constructor checkpoint
    → ...
```

If a fitting complete endpoint settles, it wins and remaining capacity work is
cancelled. If the protected complete cohort settles without a fitting
endpoint, capacity continues from its existing checkpoint. It does not restart
from an empty layout.

This is cooperative interleaving on one worker. It prevents the old
complete-miss-then-cold-restart boundary, but it is not parallel execution:
the CPU costs of both protected cohorts can still add.

This single-worker behavior is mandatory, not merely the current
implementation. Do not turn the logical cohorts into concurrent processes or
threads without a new explicit user instruction.

## 6. What a capacity checkpoint contains

A checkpoint contains more than geometry. It binds:

- algorithm version and request fingerprint;
- producer and archive cohort;
- placed, pending, deferred, and permanently skipped piece IDs;
- pending order, cursor, and deferral state;
- exact material, cavities, topology, and `q0`/`q90` fit;
- per-depth and per-cohort evaluation ledgers;
- scheduler deficit and settlement/censoring state;
- no-skip-frontier state.

Those fields make pause/resume deterministic. A changed future decision state
or request fingerprint is rejected instead of being resumed ambiguously.

## 7. The production capacity frontier

The production cold capacity lane is still bounded to 16 states. At each piece
depth it:

1. preserves an explicit skip successor;
2. generates exact legal sheetless contact candidates;
3. rejects candidates whose occupied span cannot fit the requested sheet at
   `q0` or `q90`;
4. keeps the ordinary compactness successors;
5. adds at most one distinct positive-contact successor per parent;
6. retains protected representatives for the best accounting stratum,
   including compactness and topology diversity.

This mechanism is generic. It uses exact boundary contact and topology for any
polygon family; it contains no Triangle fixture IDs or hard-coded triangle
placements.

Placed count and material remain the terminal partial objective. Topology
diversity only prevents promising legal continuations from disappearing too
early.

## 8. Current measured behavior

On roomy sheets, the settled complete cohort remains authoritative. Triangle-20
and Mixed-61 retain their accepted geometry. Shapes-17 now uses the focused
reconstruction winner: all `17/17` pieces, zero cavities,
`281,233.148068 mm2` instead of `304,499.845650 mm2`, and four isolated pieces
instead of ten.

The same Shapes-17 canonical hash is selected on `600 x 600`, `2000 x 2700`,
`5000 x 5000`, and `10000 x 10000`. A `540 x 580` boundary test also proves
that the reconstruction source remains the top sheetless leader even when that
source itself does not fit the requested sheet.

On Triangle-20 at `300 × 300`, the production capacity lane now returns the
exact `17/20` layout with three explicitly unplaced pieces. The accepted
no-options run used `15.675 s` end to end, including `14.263 s` in protected
complete-archive work. The former `15/20` production endpoint is no longer
selected.

One-piece, feature-contact, two-piece, and lost-interface repair experiments
did not justify another production mechanism. The lost-interface prototype
was removed because its continuation deduplication and deadline contract were
invalid and it found no promotable result.

### 8.1 The experimental short-side sibling

The short-side profile is currently materialized only by the benchmark and
artifact gate. The worker and UI do not enable it, so it is not yet a
user-facing production strategy. `outputInfluence: none` means specifically
that it cannot alter the production Compact result returned by the coordinator.

The experimental sibling first asks
whether an already-settled complete archive endpoint gives a material,
exactly-legal fill of the requested short edge. If not, one bounded terminal
observer constructs directional layouts and admits at most one of them.

The observer builds two families.

The historical family is search-free. It fixes each piece's minimum-width
transform, enumerates every unordered pair once, and stacks exactly one pair.
If that pair is absent or fails admission, the same transform evaluation
retains one depth-minimizing transform per piece and performs one
prepared-order, next-fit multi-row shelf.

The second family is the exact contact-driven strip. It works in normalized
directional coordinates where `x` is the requested short axis and `y` is the
requested long axis, so filling the short edge means spreading along `x` and
compactness means minimizing `y`. Each prepared piece is placed once, in
prepared order, at the legal candidate whose occupied grid anchor is
lexicographically smallest in `(y, x)`. Candidates come from the same exact
NFP/IFP generator and canonical legality check production Compact uses, so a
piece settles into a neighbour's concavity instead of advancing by bounding box,
and opposed orientations interlock without any shape-specific rule. There is
still no beam, no reordering, no repair, and no restart.

The two families exist because the historical one cannot express interlocking
at all. Its cursor advances by the AABB width and its rows are separated by the
tallest bounding box, which pins every roomy fixture near `50%`
collision-envelope density while production Compact reaches about `80%`.

The strip replaces the historical incumbent only when it regresses none of
short-edge fill, envelope area, long-axis depth, collision-envelope density,
occupied-hull gap, isolated-piece count, positive-contact component count, or
largest positive-contact component size, and strictly improves at least one.
This strict no-regression rule exists because the rejected `9193f26`
stable-baseline tie-break preserved every envelope, fill, density, legality
result, and production hash while visibly degrading packing quality. A rejected
strip stays in the trace with its full measurements rather than disappearing.

On `2000 x 2700` the contact strip wins Mixed-61 with `2000.000 x 207.700 mm`,
all `61/61` pieces, zero cavities, `100%` short-edge fill, `75.4664%` density,
and a `0.215088` occupied-hull gap, replacing the shelf's
`1987.776 x 301.187 mm`, `52.3621%` density, and `0.432505` hull gap. Triangle-20
and Shapes-17 keep their historical sources: their strips are measured, recorded,
and rejected because the Triangle strip fills only `46.2333%` of the short edge
and the Shapes strip regresses density and hull gap.

Exact density, topology, fill, depth, and area-cost guards remain mandatory.
When Compact already fills at least `80%` of the short edge, reuse is reported
as `short-side-satisfied-by-compact`; it is not counted as an
observer-generated winner. Any output below that floor is a
`directional-miss`, so a corner Compact fallback cannot make the profile gate
pass. Square sheets use their larger occupied span against the common side.

This experiment remains single-process and sequential. The strict gate contains nine
unchanged Compact controls plus nine sibling outputs. The current sources are
one archive winner, one terminal-pair winner, one contact-strip winner, one
multi-row winner, and five Compact layouts that already satisfy the short-edge
contract. The gate requires nine satisfied profiles and zero directional misses.

## 9. How candidate scoring worked before

Suppose a partial layout contains 30 pieces and the next piece has 500 legal
placement proposals.

Previously, every proposal became an entire new state:

```text
proposal
    → create all placement objects
    → insert canonical entries
    → extend the spatial index
    → extend contact information
    → assemble the new state
    → translate the entire state to the bottom-left origin
    → rebuild translated placements and index
    → calculate its canonical comparison key
```

The algorithm then compared all 500 states and discarded 499 of them.

The dominant cost was not discovering NFP positions. It was fully
materializing and bottom-left-anchoring hundreds of states that were
immediately discarded.

The Mixed-61 profile measured approximately:

```text
candidate generation:          8.7 seconds
candidate-state scoring:     134.3 seconds
eager state anchoring:       126.0 seconds
```

## 10. How candidate scoring works now

For each proposal, the scorer computes only the information necessary for the
comparison:

```text
proposal
    → intrinsic bounds and contact metrics
    → exact canonical key that the anchored state would produce
    → comparison
```

The canonical key uses the same translation arithmetic as complete anchoring,
but it does not rebuild every placement object and spatial index.

Only after the winner is known does the algorithm create the complete retained
state:

```text
winning proposal only
    → build and retain the full state
    → bottom-left-anchor it
    → continue construction
```

This is analogous to comparing 500 house plans on paper and constructing only
the selected house, instead of constructing 500 houses and demolishing 499.

## 11. Why complete output remains identical

The optimization does not change:

- generated candidate positions;
- collision legality;
- comparison order;
- deterministic tie-breaking;
- the selected proposal;
- the completed archive;
- requested-sheet fitting.

It changes only when the expensive full anchored state is materialized.

That is why paired profiles produced identical reports and byte-identical SVGs
while strict construction improved by `6.60×` and the complete periodic phase
improved by `3.83×`.
