# Dalsoo, Abeysooriya, And Dalalah: Transfer Study For V7

Date: 2026-07-20

## Decision

Do **not** add a Dalsoo-style feature-contact generator to the active V7
Stage-1 S/A/E arms. For the already permitted transforms (q0, q90, and only an
already enabled mirror), the production NFP/IFP generator already enumerates the
finite vertex and antiparallel-edge support positions that Dalsoo can construct.
A new generator would therefore be a high-risk duplicate until a coverage audit
proves an omitted canonical legal point.

Add an instrumentation-only **F0 feature-contact coverage audit** alongside
the Stage-0/Stage-1 trace work. It has no new candidate positions and no effect
on ranking. If F0 finds a real omission, run a separate, bounded constructive
seed experiment, **F1**, after S/A/E rather than combining it with their global
move vocabulary. If it does not, the next useful transfer is not Dalsoo's pose
loop: it is a later, carefully bounded version of Abeysooriya's order-level
reconstruction/Jostle idea using this repository's exact geometry and topology
terminal order.

This conclusion is source-level. It distinguishes the small Java repository
from the two papers it cites; Dalsoo is not an implementation of the complete
Abeysooriya Jostle algorithm. It does not change active V7 code.

## Sources And Evidence Boundaries

| Source | Pin or DOI | What was inspected | Evidence limit |
| --- | --- | --- | --- |
| Dalsoo-Bin-Packing | [`bde2a3ef09f48980e59328eae7b042e6d9fdd4bc`](https://github.com/whitegreen/Dalsoo-Bin-Packing/tree/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc) | Complete Java source, README, `single.png`, `multiple.png`, and current demo | Strong for this library; it is a small implementation, not a benchmarked reproduction of either paper |
| Abeysooriya, Bennell, Martínez-Sykora (2018), *Jostle heuristics for the 2D-irregular shapes bin packing problems with free rotation* | [DOI 10.1016/j.ijpe.2017.09.014](https://doi.org/10.1016/j.ijpe.2017.09.014), [accepted manuscript](https://eprints.whiterose.ac.uk/134688/1/Accepted_article_IJPE.pdf) | Primary accepted manuscript, especially pp. 9-26 | Strong for the published algorithm; its free-rotation and multi-bin assumptions do not match the V7 core |
| Dalalah, Khrais, Bataineh (2014), *Waste minimization in irregular stock cutting* | [DOI 10.1016/j.jmsy.2013.11.003](https://doi.org/10.1016/j.jmsy.2013.11.003), [publisher record](https://www.sciencedirect.com/science/article/abs/pii/S0278612513001209) | Publisher abstract and visible method/implementation section summaries | The primary full text was not openly available during this pass; claims below are limited to the publisher's own visible descriptions |

### Primary-paper retrieval and verification record

The two articles are not interchangeable citations. Their evidence was handled
separately on 2026-07-20:

| Article | Retrieval and local evidence | Verification result |
| --- | --- | --- |
| Abeysooriya et al. 2018 | Downloaded accepted-manuscript PDF: [`/private/tmp/dalsoo-transfer-study-2026-07-20/abeysooriya-bennell-martinez-sykora-2018-accepted.pdf`](/private/tmp/dalsoo-transfer-study-2026-07-20/abeysooriya-bennell-martinez-sykora-2018-accepted.pdf). Searchable extraction: [`/private/tmp/dalsoo-transfer-study-2026-07-20/abeysooriya-bennell-martinez-sykora-2018-accepted.txt`](/private/tmp/dalsoo-transfer-study-2026-07-20/abeysooriya-bennell-martinez-sykora-2018-accepted.txt). Rendered primary pages: [`/private/tmp/dalsoo-transfer-study-2026-07-20/rendered/`](/private/tmp/dalsoo-transfer-study-2026-07-20/rendered/). | The full 43-page accepted manuscript was extracted. The geometry, free-rotation, hole-filling, constructive pseudocode, and Jostle/join-release pages were rendered; the figures and Algorithm 1 pages were visually checked rather than inferred from extraction alone. |
| Dalalah et al. 2014 | The publisher record exposes the abstract and section snippets, but its direct PDF endpoint `https://www.sciencedirect.com/science/article/pii/S0278612513001209/pdfft?isDTMRedir=true&download=true` returned HTTP 403 on this date. The publisher record says “Purchase PDF”; the author-request record at [ResearchGate](https://www.researchgate.net/publication/259513330_Waste_minimization_in_irregular_stock_cutting) reports no full text available. | No primary PDF or locally extracted text was available. The Dalalah discussion below is therefore intentionally limited to the publisher’s own abstract/section descriptions and never used to establish unobservable algorithm details. |

The Dalsoo README says that its algorithms are *adapted from* the papers and
explicitly says that the Jostle method is not used. Treat a shared paper citation
as provenance of inspiration, not proof that a method exists in the Java code.

## What The Dalsoo Source Actually Supports

### Problem class and input model

`DalsooPack` accepts one outer vertex ring (`double[][]`) per item, a scalar
spacing, a rotation setting, rectangular bin dimensions, and an `hSkew`
axis preference
([`DalsooPack.java:23-51`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/DalsooPack.java#L23-L51)).
Its stated contract is simple polygons only: no holes and no self-intersection
([`README.md:14-38`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/README.md#L14-L38)).
The data model has no inner-ring collection, material-region tree, or stock
polygon argument. Therefore the library cannot represent an input part with a
hole, a stock sheet with a hole, or a general non-rectangular stock boundary.

It can receive a **simple concave outer ring**. The offset helper even falls
back to JTS when its simple offset construction fails on a "rather concave"
shape ([`MathUtil.java:459-489`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/MathUtil.java#L459-L489)).
The current demo includes several concave prototype rings
([`DemoApplet.java:107-150`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/test/java/whitegreen/dalsoo/DemoApplet.java#L107-L150)).
That is support for simple concavity, not support for input holes or an explicit
hole-filling algorithm.

The outer operation is multiple homogeneous rectangular bins. `packAll` keeps
opening a new bin from the remaining pieces until none remain
([`DalsooPack.java:62-84`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/DalsooPack.java#L62-L84)).
Each successive bin receives only that residual pending collection; successful
placements in an earlier bin are never reconsidered, moved, or reassigned
([`Bin.java:391-397`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L391-L397)).
This is fundamentally different from the fixed single-sheet request that
defines Mixed-61 and V7.

### What the screenshots do and do not prove

The pinned README caption for `multiple.png` claims 240 polygons on 14 sheets;
the image visibly contains concave C/U-like pieces and empty regions
([`README.md:63-65`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/README.md#L63-L65),
[`multiple.png`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/multiple.png)).
It is visual evidence that the package can lay out simple concave outlines and
can output multiple sheets. It is **not** a reproducible proof of general
contour nesting:

- the current demo generates 200 random pieces from six prototypes with no
  fixed seed, while the README image claims 240, so the image is not tied to a
  recorded current demo request;
- white interiors in the PNG are background/concavities; the image does not
  identify an inner ring, a piece ID inside a cavity, or a certified placement;
- source input cannot encode a part or stock with an inner contour;
- source has no occupied-union/free-space object from which it could enumerate
  or rank a cavity independently.

An item can incidentally enter the notch of a concave already placed outer
ring if a tested feature-contact pose is feasible. This is weaker than an IFP
inside a known cavity: it neither enumerates the cavity as a region nor proves
that all legal placements in the notch are reached.

### Candidate construction, rotations, and spacing

`Bin.pack` optionally sorts by area and then permanently places the next piece.
`PackedPoly.compareTo` is ascending area and the decoder selects from the tail,
so `largestFirst=true` really is largest-first despite the contradictory inline
“smallest first” comment. There is no beam, archive, restart, repair, or
backtracking ([`Bin.java:91-107`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L91-L107),
[`PackedPoly.java:105-108`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/PackedPoly.java#L105-L108)).
The first piece is an exceptional origin placement: in **both** modes it scans
the discrete `rotSteps` angles, chooses an orientation, then translates its
bounding-box lower-left to `(0, 0)`
([`Bin.java:109-135`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L109-L135)).

For later pieces it has two genuinely different pose loops:

1. `useAbey=false` selects the `Dalalah`-named path. It loops every discrete
   `2πi / rotSteps` orientation and every moving-offset-vertex / placed-offset-
   vertex pair, with translation `fixedVertex - movingVertex`
   ([`Bin.java:211-256`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L211-L256)).
2. `useAbey=true` selects the `Abey`-named path. It does **not** loop
   `rotSteps` after the initial item. For each moving vertex and each placed
   vertex it uses the two adjacent-edge combinations to derive two
   contact-compatible rotations, aligns that moving vertex to the placed vertex,
   and tests the pose
   ([`Bin.java:137-208`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L137-L208)).

The second path is a finite edge-derived **orientation-tuning** routine. It is
not the primary paper's Jostle outer search. It is only useful with arbitrary
angles; with quarter turns fixed before candidate generation, it introduces no
transform that the existing generator does not already receive.

Spacing is one-sided by construction. A `PackedPoly` stores both original
`inpts` and a buffered `outpts`; the **new** candidate is tested using its
offset ring against previously placed original rings
([`PackedPoly.java:25-64`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/PackedPoly.java#L25-L64),
[`Bin.java:258-275`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L258-L275)).
The optional `segmentMaxLength` subdivides **only** that offset boundary, adding
synthetic contact vertices before either later-piece pose loop runs. Thus it
changes feature coverage even in `useAbey=true`; `rotSteps` is its later-piece
quality/runtime knob only in `useAbey=false`. Neither setting is a wall-time or
evaluation budget.

### Objective and why it cannot be the V7 selector

For every candidate Dalsoo incrementally adds its original vertices to an
occupied convex hull and minimizes hull area multiplied by an origin/axis
pressure
([`Convex.java:48-97`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Convex.java#L48-L97),
[`Bin.java:181-195`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L181-L195),
[`Bin.java:227-241`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L227-L241)).
`hSkew` intentionally biases horizontal versus vertical packing; it is not a
sheet-normalized quantity, but it remains an arbitrary axis preference. More
importantly, it is not even formula-consistent between source paths:

```text
first item:        AREA_SC * boundingBoxArea * (hSkew * (centerX - minX) + (1 - hSkew) * (centerY - minY))
useAbey=true:      hull * (hSkew * abs(centerX) + (1 - hSkew) * abs(centerY))
useAbey=false:     hull * (hSkew * abs(centerX) +               abs(centerY))
```

The last expression omits the `(1 - hSkew)` multiplier and scores the buffered
candidate centre rather than the original-piece centre. It is a literal source
branch inconsistency, not a result established by either cited paper. It makes
the README's simple “horizontal versus vertical” description unreliable for
the `useAbey=false` path, and is another reason not to transfer `hSkew` as a V7
compactness signal.

Convex-hull pressure is useful as a cheap *proposal* signal, but it is blind to
the hollow-ring distinction: a ring and a filled compact cluster can have the
same hull. It cannot replace V7's exact topology fields—cavity count, hull-gap
ratio, isolated pieces, contact-component structure, envelope, and canonical
legality.

### Feasibility is not a certification boundary

The library's fast test performs an AABB rejection, one placed-polygon
**vertex-mean** inside-candidate test, and strict double-precision edge
crossings
([`Bin.java:317-345`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/Bin.java#L317-L345)).
`PackedPoly.place` obtains that “centroid” by averaging vertices, not by an
area-centroid calculation
([`PackedPoly.java:94-103`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/PackedPoly.java#L94-L103),
[`MathUtil.java:257-269`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/MathUtil.java#L257-L269)).
The source itself labels the shortcut not completely robust.

The exact failure boundary is directional: it can detect a placed polygon that
contains its own sampled vertex-mean inside the candidate, but it never tests
candidate vertices inside the placed polygon. If a candidate is fully inside a
concave placed polygon without a proper edge crossing and does not contain that
single sampled point, it can be accepted. The strict segment predicate also
does not report endpoint or collinear overlap
([`MathUtil.java:666-721`](https://github.com/whitegreen/Dalsoo-Bin-Packing/blob/bde2a3ef09f48980e59328eae7b042e6d9fdd4bc/src/main/java/whitegreen/dalsoo/MathUtil.java#L666-L721)).
That makes boundary contact cheap, but it cannot certify all containment and
degenerate-overlap cases. JTS is used only as an offset fallback, not as an
integer-grid placement oracle.

None of the following is transferable: the floating intersection test, the
centroid shortcut, one-sided offset collision convention, single-pass commit,
origin-biased `hSkew`, or opening another sheet when a promising future is lost.

## What The Papers Actually Add

### Dalalah et al. (2014)

The primary paper is a single-stock irregular knapsack/cutting problem, not
Dalsoo's multi-rectangular-bin loop. The publisher describes convex or
non-convex items in convex or non-convex stock; the objective is the relative
difference between the occupied collection's area and its convex-hull area. It
uses iterative placements and lists angle, bound, point-inclusion, and polygon
intersection feasibility checks. The visible implementation summary also says
that a fixed initially oriented polygon is required and that set size, number
of items tried, and angle increment control cost
([publisher record](https://www.sciencedirect.com/science/article/abs/pii/S0278612513001209)).

This validates three limited ideas:

- a global external-waste/hull signal can be an auxiliary steering metric;
- non-convex stock/shape feasibility needs more than a bounding-box rule;
- candidate count and angular resolution must be explicit budget dimensions.

It does **not** validate the source library's exact implementation details, and
the full article was unavailable in this pass. Most importantly, its hull
objective is exactly insufficient as a terminal objective for the observed ring
failure. V7 must keep the Clipper2-derived cavity and connectivity certificate.

### Abeysooriya et al. (2018)

The paper is much closer architecturally but not identical operationally. It
solves a two-dimensional irregular **multi-homogeneous-bin** problem with a
constructive decoder, finite or free rotations, and an outer Jostle local
search. Its objective is bin use, and it treats allocation and placement
together ([pp. 1-4 of the accepted manuscript](https://eprints.whiterose.ac.uk/134688/1/Accepted_article_IJPE.pdf)).

For a fixed orientation it builds NFP/IFP geometry, rather than relying on a
feature loop. It merges each bin's partial layout and retains enclosed gaps as
holes. A remaining piece first receives an IFP-in-hole test; otherwise the
feasible set is IFP intersected with the complement of the merged-layout NFP
([pp. 10-14](https://eprints.whiterose.ac.uk/134688/1/Accepted_article_IJPE.pdf)).
This is genuine **layout-created cavity** handling, not support for an input
part with a hole.

The paper's free-rotation contribution begins from a finite-rotation touching
placement. Each current contact feature derives nearby candidate angles:
edge-vertex, vertex-vertex, edge-edge, and bin-edge contacts
([pp. 14-16](https://eprints.whiterose.ac.uk/134688/1/Accepted_article_IJPE.pdf)).
For restricted rotations it simply evaluates the permitted orientations. Its
placement policies try holes first, then bottom-left, minimum length, or convex
hull utilisation ([pp. 17-19](https://eprints.whiterose.ac.uk/134688/1/Accepted_article_IJPE.pdf)).

Its actual global contribution is Jostle, not a special contact point. The
decoder rebuilds left-to-right and right-to-left orderings; repeated rebuilding
changes the order induced by the prior layout. After stagnation it applies
one-piece insertion or bin swapping; the strongest variant temporarily joins
adjacent pieces, then releases them on a kick
([pp. 20-26](https://eprints.whiterose.ac.uk/134688/1/Accepted_article_IJPE.pdf)).

This supports a future bounded reconstruction portfolio. It does **not** support
copying unrestricted rotations, an axis-directed strip objective, multi-bin
swaps, random kicks, or the paper's join/release rule directly into V7.
Merging a contact-rich chain into a macro-piece would make the current ring
failure harder, not easier, to escape.

## Mapping To The Current Convex NFP/Canonical Architecture

The important result of comparing the real code is that the potential Dalsoo
feature family is already present for each permitted transform:

| Finite contact construction | Existing `min-plane-dfx` construction | Consequence |
| --- | --- | --- |
| Moving vertex meets fixed vertex: `t = fixedVertex - movingVertex` | Every pairwise NFP boundary vertex is added to the candidate set | Do not add a duplicate vertex-to-vertex generator |
| Antiparallel moving/fixed edge contact | `addAntiparallelEdgeSupportPoints` adds both finite endpoint translations of the contact interval | Do not sample the interior of a full shared edge |
| Sheet-edge / IFP boundary contact | IFP rectangle corners plus NFP/IFP boundary intersections | Already covered for the rectangular sheet model |
| Simultaneous contact with two placed pieces | Pairwise NFP-boundary intersections | Already covered as a finite extremum |
| Free-angle tuning from a touching feature | Not applicable under the permitted quarter-turn/mirror family | Keep transform-family coverage; never synthesize arbitrary angles |

The production generator constructs pairwise NFP boundaries for every placed
piece, adds NFP vertices, antiparallel edge supports, IFP intersections, and
pairwise NFP intersections, then direct-validates each finite candidate
([`nfpIfpService.ts:626-824`](../../src/workers/irregular/nfpIfpService.ts#L626-L824),
[`nfpIfpService.ts:1033-1086`](../../src/workers/irregular/nfpIfpService.ts#L1033-L1086)).
Every prepared transform is generated before its legal candidates are scored
([`windowedBeam.ts:1102-1148`](../../src/workers/algorithm/irregular/windowedBeam.ts#L1102-L1148),
[`strictPriorityDecoder.ts:95-122`](../../src/workers/algorithm/irregular/strictPriorityDecoder.ts#L95-L122)).

The local convex validator deliberately permits edge/vertex contact but rejects
positive area overlap through the robust convex predicate path
([`placementValidation.ts:25-35`](../../src/workers/irregular/placementValidation.ts#L25-L35),
[`placementValidation.ts:157-199`](../../src/workers/irregular/placementValidation.ts#L157-L199)).
Canonical integer-grid legality and topology are separately available through
Clipper2 for the terminal/exact boundary
([`canonicalLayoutGeometry.ts:49-119`](../../src/workers/irregular/canonicalLayoutGeometry.ts#L49-L119)).

There are two real differences from Abeysooriya's hole procedure:

1. The live collision model accepts strict convex rings, so it cannot import
   concave input parts or arbitrary hole contours.
2. Layout-created cavities between convex pieces are measured exactly in the
   canonical topology, but are not a separate first-class IFP queue during
   constructive placement. The finite NFP constraint arrangement should expose
   their touching extrema; whether local scoring/fanout preserves them is an
   empirical retention question, not evidence of a missing Dalsoo feature.

This is the critical distinction. An explicit cavity queue may become a future
decoder/ordering phase, but a vertex/edge generator is not a substitute for it.

## V7 Stage 1.5/F: Feature-Contact Coverage Probe

### Decision boundary

Stage 1.5 is an independent **candidate-coverage** question between the
existing constructive seeds and the S/A/E global-motion arms. It begins with
F0, a trace-only audit. F1, a candidate-producing probe, is permitted only if
F0 records a concrete omission. Neither changes the live S/A/E implementation,
their allowed transform policy, or their local/terminal comparator.

### F0 purpose and scope

F0 is a trace-only audit to determine whether a purportedly useful compact
contact pose was:

1. constructed by an existing finite geometry family;
2. merged with another identical point;
3. direct-legal under the live convex validator;
4. canonical-legal at an exact protection/archive boundary; and
5. retained or evicted by local fanout and later whole-state survival.

It changes no candidate point, no score, no comparator, no seed, and no timing
decision. It is compatible with the active S/A/E plan because it measures their
inputs rather than creating a fourth move arm.

### F0 required trace fields

Attach a compact source bitset to each raw candidate point before point-set
deduplication:

```text
ifp_corner
nfp_vertex
antiparallel_edge_support
ifp_nfp_intersection
nfp_nfp_intersection
```

For every `(seedRole, arm, step, parentStateId, pieceId, transform)` emit only
aggregate counters. `transform` is the existing prepared q0/q90 transform and,
only when already enabled for the request, its existing mirror; F0 must not
synthesise a new angle or mirror:

```text
rawBySource
uniqueBySourceMask
outsideIfp
liveConvexRejected
liveConvexLegal
phaseIncompatible
canonicalChecked
canonicalLegal
localFanoutRetained
localFanoutEvictedByReason
```

The existing transform event currently records only `legalCandidateCount`
([`decisionTrace.ts:324-349`](../../src/workers/algorithm/irregular/decisionTrace.ts#L324-L349)).
F0 refines that count without serialising every point. Keep full point-level
witnesses only under the V7 bounded-trace policy: the final infeasible survivors,
the eight legal archive survivors, and the first sample that enters each source
family or shows a live/canonical disagreement. Dedupe witnesses by phase-aware
state key and source-feature key.

For the two strict seed constructors, record the same five source counters at
each constructive step. For S/A/E, record them only when the arm requests a
fresh decode or a reconstruction; do not attach a geometry payload to every
global squeeze move.

### F0 micro-oracle tests

Add focused tests, not a broad new decoder, for every permitted q0/q90/mirror
transform family. From fixed and moving collision polygons, calculate the
finite algebraic expectations:

```text
vertex-vertex:        fixedVertex - movingVertex
antiparallel support: fixedStart - movingEnd
                      fixedEnd   - movingStart
```

Filter these points by the same IFP and direct validator used in production.
Assert that every legal expected point is present in the generator's unique set,
with the expected source bit. Separately test NFP/IFP and NFP/NFP intersections.
The test must retain a fractional translation basis and compare phase-aware
coordinates; it must never prove coverage by rounding both sides independently.

### F0 pass/fail decision

F0 passes if all of the following are true on Triangle-20, Mixed-61, and the
known V7 compact witnesses:

- each direct-legal finite feature extremum is present before local fanout;
- every relevant transform family was evaluated;
- a rejected candidate can be attributed to fanout/whole-state selection rather
  than absence from the generator;
- no live/canonical mismatch is hidden in a feature-source aggregate.

If F0 passes, reject a new feature-contact generator. Continue with survivor,
order, cavity-queue, or global-reconstruction work.

If F0 fails because a direct- and canonical-legal finite extremum is absent,
preserve the exact witness and proceed to F1. If F0 fails only because the
expected point is off the current phase, record `phaseIncompatible`; do not
round it into a different phase and call it a missing candidate.

### F1: Conditional feature-contact seed probe

F1 is authorised only by an F0 witness. It is **not** part of S/A/E and must not
be combined with S, A, or E in its first run.

#### Candidate rule

Implement only the finite family F0 proved absent. Do not enumerate arbitrary
edge interiors or copy the free-angle branch. For every existing state and
allowed transform (the request's q0/q90 family and only an already enabled
mirror):

1. derive the witness family in world coordinates;
2. retain the state's fractional translation basis and project the proposal
   only as `basis + integerGridDelta`; if it cannot be represented on the
   parent phase/grid, record `phaseIncompatible` and reject it—never round it
   onto a different phase;
3. require the exact same IFP/NFP/direct convex filter as ordinary candidates;
4. at the Stage-1.5 protection boundary, materialise the projected candidate in
   canonical grid space and require canonical Clipper2 admission before it can
   enter the protected F batch or endpoint archive;
5. dedupe before scoring by `(source-family, transform, phase-aware point key)`
   and then by the ordinary phase-aware state key; a feature tag must not keep
   an otherwise identical state;
6. hand each remaining legal point to the unchanged local scorer and exact
   endpoint archive. F receives no private score, finalist, or winner lane.

Cap a batch at eight *new* phase-distinct points after ordinary candidate
deduplication. The cap applies only to the demonstrated missing family; it is
not an opportunity to generate a second broad feature loop. Keep a hard 12,000
evaluation / 60-second budget for the independent Stage-1.5/F decode. If its
extra candidate count exceeds 10% of the ordinary unique candidate count on
either gate, stop and classify the mechanism as too expensive before raising
the cap.

#### Acceptance and rejection

F1 is worth retaining only if it passes all of these gates:

- at least one phase-distinct canonical-legal candidate exists that ordinary
  generation omitted;
- that candidate survives ordinary local fanout and the V7 two-sweep protected
  survival rule, rather than requiring an F-only winner lane;
- it produces a distinct legal endpoint in the common area/topology archive;
- Triangle-20 preserves the approved golden canonical geometry and all current
  compactness/contact gates;
- Mixed-61 is legal on every required reference sheet and yields at least one
  endpoint that strictly improves the common exact archive decision against the
  same dual-seed baseline, without worsening the accepted cavity, hull-gap,
  isolate, contact-component, or maximum-side gates;
- the selected Mixed endpoint cannot be a raw-contact or `hSkew` winner: its
  canonical topology certificate and `I_numeric`/Clipper2 admission must agree;
- three deterministic replays agree on canonical geometry and source counters;
- it remains inside the stated evaluation and wall-time budget.

Reject F1 if it adds only duplicate state keys, if new points are immediately
dominated/evicted, if it merely increases raw contact, or if its benefit depends
on a sheet-relative hSkew-like score. Preserve its witness and traces, then move
to the retention or reconstruction hypothesis.

## Interaction With Dual Seeds, Exact `I_numeric`, and S/A/E

| V7 mechanism | F0/F1 interaction |
| --- | --- |
| Dual exact seeds | F0 measures both comparators independently. F1 may become a third constructive seed only after it proves a unique legal endpoint; it must not replace either dual seed or lower the recorded reference bar. |
| Phase-aware dedup/cache | F0 exposes phase incompatibility. F1 uses the immutable basis plus grid delta representation and cannot merge q0/q90 futures through a terminal identity. |
| Exact `I_numeric` | F0 reports the first live/canonical disagreement. F1 protection uses canonical wall/overlap counts, not a raw SAT ordering or a hull score. |
| Legal endpoint archive | F0 shows whether an existing feature point reaches the archive. F1 offers points to the same area-first/topology-first/Pareto archive; it gets no private endpoint winner. |
| S split arm | No direct coupling. S tests global split motion; F tests a constructive point omission. Combine only after independent success. |
| A pair atom arm | A addresses a colliding pair after construction. It is not evidence that a feature point was missing. F1 never changes A's balanced allocations. |
| E refinement arm | E probes local translations at two radii. F1 is a finite contact construction; keep them independent to know whether the gain is reachability or refinement. |
| Triangle golden and ring avoidance | Hull-only or contact-only F variants fail by definition. The common topology terminal, exact triangle replay, and rendered inspection remain mandatory. |

## When To Reuse The Real Abeysooriya Idea

If F0 passes and V7 still produces legal but ring-like endpoints, a feature
generator is the wrong next change. The paper suggests a **reconstruction
portfolio** instead:

1. begin from an exact legal seed or archive endpoint;
2. derive two deterministic piece orders from its canonical geometry, but pair
   directions and quarter turns symmetrically so the procedure does not encode
   a requested-sheet axis;
3. rebuild with the existing NFP/IFP candidate generator and exact canonical
   endpoint archive;
4. retain a small number of whole legal decodes under a fixed time/evaluation
   budget; and
5. make one bounded order kick only after measured stagnation.

This borrows Jostle's useful responsibility split—global order change followed
by a deterministic decoder—without borrowing free rotation, random mutation,
multi-bin logic, or its scalar objective. It belongs after the independent V7
arms, because it is a decoder/portfolio stage rather than a local global-motion
operator. Its first experiment should be a separate seed portfolio with the
same canonical terminal comparator, not a hidden repair after an S/A/E run.

Do not port join-and-release yet. The paper joins adjacent convex/no-hole
clusters for later reconstruction, whereas the current failure can form a
contact-rich ring or chain. A macro-piece would freeze exactly the topology V7
needs to break. Consider grouping only after a future trace proves that a
positive-contact component is compact under the common topology certificate and
can be released deterministically.

## Final Recommendation

The visual Dalsoo result is a reminder that concave **notches** can make feature
placement useful. It is not evidence that its Java implementation solves the
Mixed-61 cavity or ring problem. The source comparison gives a sharper plan:

1. instrument the existing NFP generator with F0 source provenance;
2. prove or disprove a real finite feature omission before altering candidates;
3. if no omission exists, do not duplicate Dalsoo—continue with exact survivor
   policy and, after V7, a bounded Abey-style reconstruction/order portfolio;
4. keep canonical Clipper2 legality, phase-aware identity, cavity/connectivity
   topology, dual seeds, and the Triangle golden as non-negotiable boundaries.
