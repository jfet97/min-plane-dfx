# Fable 5 Review: V7 Search Quality, Periodic Seeds, And The Next Decision

Reviewer: Claude (Fable 5), independent adversarial review.
Review basis: branch `v7-geometric-cohesion`, evidence commit `0b3309e`
("Record rejected periodic lattice witnesses"), reviewed from descendant
`327f7ad`. All source citations below are against that tree.

Review machine caveat: this review ran on a machine that does **not** hold the
original immutable provenance tree. The following listed paths were absent and
could not be inspected directly:

- everything under `/private/tmp/min-plane-provenance/` (including
  `v7-periodic-family-portfolio-0b3309e/{triangle-20,mixed-61}`,
  `v7-peel-shadow-e41897b-triangle`, `v7-coordinated-d55d55e-triangle`,
  `v7-component-interface-5729b25-triangle`, and every report referenced by
  `plan.md`);
- `knowledge/dependencies/sparrow` (pinned commit `961ec31…`);
- `knowledge/dependencies/dalsoo-bin-packing` (pinned commit `bde2a3e…`).

Instead of trusting the briefing numbers, I **regenerated the Triangle
periodic run from the committed source** on this machine
(`scripts/irregular-intrinsic-periodic-family-portfolio.ts --fixture
triangle-20`, output under
`/private/tmp/min-plane-provenance/v7-periodic-family-portfolio-327f7ad-fable-repro/triangle-20/`).
The regenerated run reproduces the briefed counters exactly — one family, 8/8
unique/retained transforms, 28/28 pairs, coverage flags all true,
`farNeighborRejected: 185`, `threeByThreeLatticeRejected: 16`, `noP1Basis: 8`,
`noP2Basis: 71`, `certified cells: 0`, `continuations: 0`, ~71 ms — so the
Triangle claims in the brief are verified from source, not assumed. The Mixed
run (~200 s, deadline-dominated) was not regenerated; its numbers are used as
briefed and marked accordingly. Sparrow/Dalsoo claims rely on the committed
transfer studies plus the in-repo controller source, not on the missing pinned
checkouts.

I also wrote and ran a read-only diagnostic probe against the committed
periodic implementation (method and full results in
"Reproduction: The Certificate Probe" below). Its outputs drive most of this
review. No implementation file, test, or artifact was modified.

# Verdict

**`REPAIR_PERIODIC_FINITE_CROP_FIRST`**

The Triangle periodic result is not a negative result about periodic seeding.
It is a measured defect in one gate: `farNeighborCertificate` — a sound
*sufficient* condition for infinite-lattice separation — is applied as a
*necessary* pre-materialization gate, and it is structurally incapable of
accepting any dense (near–density-1) cell. I verified this beyond argument:

1. Ten enumerated Triangle bases at **density 0.9923** fail the certificate
   while passing the project's own exact 3×3 lattice validation
   (`validatePeriodicContactLatticeControl`), i.e. the pipeline's next stage
   already certifies them as exactly legal and contacted.
2. Bypassing only that gate, the **unchanged** `expandIntrinsicPeriodicCell`
   and **unchanged** strict decoder completed a canonical-legal 20-triangle
   endpoint with **73,907.487 mm², zero cavities, hull-gap 0.0506, hull-waste
   0.0536** — versus the current V7 best of 88,124.330 mm² with hull-gap
   0.2216. That is a 16.1% envelope-area improvement, Pareto-dominant on both
   geometric archive axes, produced by machinery already in the tree.

A second, smaller defect was also measured: finite-crop materialization uses
floating-point lattice accumulation and per-axis grid rounding that (a)
diverges from the exact-grid arithmetic used by `validateLattice`, and (b)
loses structural contact on one lattice axis (0.0005 mm quantization gaps), so
even repaired cells will produce elongated, contact-poor crops until the crop
generator snaps lattice translates to exact NFP-derived contact offsets.

The single nominated experiment is therefore: repair the finite-crop path of
the existing periodic portfolio (certificate demoted to a recorded flag,
grid-exact contact-snapped crop materialization, per-stage rejection
provenance), rerun the same bounded portfolio on Triangle, two homogeneous
controls, and Mixed, with the ordinary and pocket-first baselines competing in
the same archive. Full specification under "Recommended Next Experiment".
Moving to the Sparrow-style controller now would abandon the periodic line at
the exact moment its blocking bug has been localized and its upside has been
measured. The plan's ordering ("periodic first, adaptive repair only after a
conclusive periodic result") remains sound; the current result is explicitly
not conclusive.

# What the Evidence Actually Proves

## Proven from current artifacts and source

- **The Triangle periodic run rejected all bases pre-materialization.** In
  `deriveCells` (`src/workers/algorithm/irregular/intrinsicPeriodicCells.ts`),
  the gate order is: basis enumeration (`deriveAxisBasisCandidates`,
  lines 852–905) → `canonicalizeBasis` (degenerate check) →
  `farNeighborCertificate` (line 771) → `validateLattice` 3×3 probe
  (line 775) → base-shape measurement → cell admission. No finite crop, seed,
  or continuation is ever constructed for a rejected basis. The only
  placements ever validated before rejection are the nine cells of the 3×3
  probe, and that probe only runs *after* the far-neighbor gate passes. So
  "candidate bases generated, then rejected pre-materialization" is exactly
  right; "a compact solution was generated and pruned" is wrong.
- **The certificate is the sole blocker for dense Triangle bases.** My probe
  re-derived bases from the committed enumeration seams
  (`derivePeriodicAxisBasisCandidatesControl`) over all 8 unique transforms
  and 28 transform pairs, testing 375 bases. Ten bases with density 0.9923
  returned `farNeighborCertificate = false` while
  `validatePeriodicContactLatticeControl` (exact 3×3 legality **and**
  every-center-member contact) returned `true`. Example exact numbers, from
  BigInt arithmetic, for `v1=(88.288, 0) mm`, `v2=(0, 76.262) mm`:
  `4·det² = 181,334,203,979,498,143,744` versus required
  `> D²·f2 = 319,099,662,975,537,059,360` — the certificate misses by a
  factor of ~1.76 for a cell the next stage proves exactly legal and
  contacted.
- **With the gate bypassed, the unchanged downstream machinery produces a
  strictly better Triangle endpoint.** `expandIntrinsicPeriodicCell` (no
  modifications) materialized legal crops from two of the ten witnesses; the
  best seed (20 placements) completed through the unchanged
  `constructIntrinsicStrictState`/`finalizeIntrinsicStrictState` with status
  `completed` and canonical hash
  `15d34424f53bfc7a85cc610f886a1e092b3745a8136539d9846c0a9f27ee521a`:
  area `73,907.487012 mm²`, maximum side `484.563 mm`, span `637.087 mm`,
  zero enclosed cavities, hull-gap ratio `0.0506`, hull-waste `0.0536`,
  10 isolates, largest contact component 10, shared boundary `394.92 mm`,
  0 structural contacts. Compactness and void topology both dominate the
  `88,124.330 mm²` / hull-gap `0.2216` width-3 seed.
- **Finite-crop materialization has its own exactness defect.**
  `expandIntrinsicPeriodicCell` computes lattice points as
  `base.point + row*v1 + column*v2` in floating point
  (`intrinsicPeriodicCells.ts:536–539`), while `validateLattice` uses exact
  BigInt grid multiples (`lines 1171–1174`). On the same witness cell, a
  hand-driven 2×5 crop fails first at `row=0, column=2` under the float
  arithmetic but at `row=0, column=3` under grid-exact arithmetic — the
  legality of tangent placements flips with sub-grid noise. Separately, the
  true tiling period on the v2 axis falls between canonical grid points
  (~76.2615 mm): the floor alternative (76.261) overlaps by 0.0005 mm
  (illegal), the ceil alternative (76.262) leaves a 0.0005 mm gap (legal but
  contactless). This is why the only crops that materialize today are
  elongated along the exact-tangency axis and why the completed endpoint has
  zero structural contacts.
- **The Triangle catalog contract itself executed faithfully.** Family,
  transform, pair, and cell coverage flags are all true in both the original
  and regenerated reports; the 8 transforms include the reserved
  direct/mirror × rotation-family representatives
  (`selectPeriodicTransformRepresentatives`, `periodicTransformReservationKey`,
  lines 422–447). The failure is inside cell certification, not coverage.
- **The strict continuation used by the periodic portfolio consumes ordinary
  NFP candidates only.** `constructIntrinsicStrictState` requests
  `candidateDomain: 'sheetless-nfp'` (`intrinsicStrictDecoder.ts:395`); the
  repaired occupied-envelope event family from commit `1d527bc` does not
  participate in periodic continuations. For seeded-lattice completion this is
  probably adequate (the seed provides the structure), but it must be stated
  in provenance because a failed continuation could otherwise be misread as a
  seed failure.
- **The Sparrow-fidelity gap claimed by `plan.md` is real in the controller
  source.** `intrinsicSqueezeDisruptSeparate.ts` derives its three target
  roles once at initialization (`deriveIntrinsicGlobalTargetRoles`,
  lines 863–890), runs fixed sweep counts (`sweepsPerBasin: 12`, forced
  disruption at sweeps `[0,4,8]`), and never re-derives a target from an
  accepted feasible endpoint. An incumbent-update loop *does* exist, but only
  inside the isolated pressure prelude (incumbent update and
  contraction-ratio reset at lines ~2286–2318); it does not feed the basin
  roles. A restart pool exists (capacity 8, multi-lane retention,
  lines ~4722–4838) but is per-basin, not carried across targets.

## Plausible inference needing a measurement

- **The compact motif seed will survive to a golden-competitive endpoint once
  contact-snapped crops exist.** The probe endpoint fails the current-main
  golden gates on shape (`484.6 mm` side > 354 gate; span 637 > 581) and
  contact (0 structural vs ≥ 24/17) because only elongated crops materialize
  today. Near-square crops (e.g. 2×5 cells ≈ 176.6 × 381.3 mm, ~67,344 mm²
  envelope) are blocked solely by the v2-axis tangency defect. That they will
  pass the side/span/contact gates once crops snap to NFP-exact contact
  offsets is likely but must be measured, not asserted.
- **Mixed dense families were suppressed by the same certificate.** The Mixed
  run certified only sparse-but-contacting cells (the pincer described under
  Findings), so its two completed endpoints (417,922 / 424,747 mm², briefed
  values) understate what a repaired portfolio can seed. Plausible, and
  consistent with the mechanism, but unverified on this machine.
- **`threeByThreeLatticeRejected` is dominated by the no-contact arm, not
  the illegality arm.** `validateLattice` returns `undefined` both when a 3×3
  placement is illegal and when some center member lacks positive contact
  (line 1214); the counter conflates them. The 16 rejected P1 samples (e.g.
  `v1=(88.288,0)`, `v2=(0,75.675)`) look like sparse vertex-touching lattices
  that fail the contact requirement, but the split must be measured after the
  stages are separated.

## Unsupported speculation (flagged as such)

- That the repaired periodic path will transfer any benefit to Mixed-61's
  heterogeneous majority. Mixed's repeated families cover only part of its 61
  pieces; the seeded remainder still depends on the ordinary greedy
  continuation. No current artifact supports or refutes a Mixed win.
- That P1/P2 insufficiency (needing 3+-member motifs, e.g. p6-like
  arrangements) matters for any current fixture. No evidence requires it;
  Triangle is measured to need only P2.

## Answers To The Fourteen Review Questions

**A1 (rejection boundary).** Yes — bases were generated and rejected
pre-materialization; exact boundary is `deriveCells`,
`intrinsicPeriodicCells.ts:764–779`, in the order degenerate → far-neighbor →
3×3 lattice → base shape. Nothing crop-like exists for rejected bases. Verified
by source read and by the regenerated report's stage counters.

**A2 (certificate diagnosis).** It is a *representation mismatch used at the
wrong boundary*, not an unsound proof and not a sound necessary condition. As
implemented (`farNeighborCertificate`, lines 1129–1154) it proves: if
`4·det² > D²·(|v1|²+|v2|²)` then every lattice translate outside the 3×3
neighborhood is farther than the base diameter, so the *infinite* lattice
cannot self-intersect beyond validated neighbors. That implication is correct
(min non-neighbor translate ≥ `2·det/√f2`; two convex translates intersect
only if the translate length ≤ D). But the condition is loose by up to √2
against `max(|v1|,|v2|)`, and — decisively — every dense contacting cell has
`|v1| ≤ D` and `|v2| ≤ D` with `det ≤ |v1||v2|`, which forces
`4det² ≤ 4|v1|²|v2|² ≲ D²·f2` as density → 1. Equality-region analysis aside,
the measured witnesses settle it: density-0.9923 cells fail by 1.76× while the
exact 3×3 stage passes them. A certificate that structurally cannot accept the
dense cells the experiment exists to find is the wrong gate for finite crops.

**A3 (correctness-safe finite-crop relaxation).** Never declare the infinite
lattice legal. Requirements: (i) keep basis enumeration and the degenerate
check; (ii) demote `farNeighborCertificate` to a recorded boolean
(`infiniteLatticeProven`) with its exact BigInt terms; (iii) keep the exact
3×3 validation, but split its two failure arms into distinct stages; (iv)
materialize bounded crops with **grid-exact** lattice arithmetic
(BigInt multiples as in `validateLattice:1171–1174`), then snap each translate
to the nearest exact NFP-legal contact offset within ±1 grid unit per axis,
deterministically (prefer contact, then legality, then lower coordinate);
(v) direct-validate every placed member against all previously placed
(already done in `expandIntrinsicPeriodicCell`); (vi) admit only crops whose
complete layout passes canonical identity + canonical-grid legality (already
done at strict finalization); (vii) dedupe by `canonicalCollisionLayoutIdentity`
(already done); (viii) bound work: ≤ 16 density-ranked bases per
(family, role) enter expansion, ≤ 4 crops per cell, existing 15 s catalog /
25 s continuation / 240 s fixture caps unchanged; (ix) three byte-stable
replays as already required by the peer decision (currently not implemented in
the harness — see Findings F5).

**A4 (P1/P2 expressiveness).** For Triangle, P2 is measured to be sufficient:
the probe's density-0.9923 two-member cell materializes the compact motif. The
real representational narrowings are elsewhere: (a) `deriveAxisBasisCandidates`
only emits bases with an **axis-aligned first vector** (x-axis, or y-axis via
`swapAxes`), so lattices with no axis-aligned period are only reachable if
some retained transform aligns a period with an axis — acceptable for the
current orthogonal/edge-aligned transform families, but it must be documented
as a known bound; (b) only the *tightest* basis per axis intersection is
derived (first positive axis crossing, lowest second row), which is the right
target for dense cells and is not the failure. No generic motif extension
(3+-member cells, p6 motifs) is currently justified by evidence; do not build
one yet.

**A5 (`threeByThreeLatticeRejected`).** It does not refute the finite-crop
idea. It is a distinct condition that currently conflates "3×3 placement
illegal" with "center member lacks positive contact"
(`validateLattice:1176–1214`). The discriminating measurement: split the stage
counter into `threeByThreeIllegal` and `threeByThreeNoContact`, and record per
sample the failing (n, m, memberIndex) plus the contact deficit. The 16
current samples are consistent with sparse vertex-touching P1 lattices failing
contact — i.e. correctly rejected as useless, not as false negatives — but
that reading should be confirmed by the split counters, not assumed.

**B6 (plan audit).** The ordering decision ("periodic portfolio first,
faithful adaptive Sparrow only after a conclusive periodic result",
`plan.md:1565–1624`) survives this review — precisely because the periodic
result is *not* conclusive. Stale/overconfident items found: (i) the
"Immediate Next Action" reads as if the P1/P2 portfolio contract were fully
implemented, but three peer-mandated elements are absent from the tree — the
three-byte-stable-replay requirement, the observer-only reference-prefix
audit, and the "hands off a measured non-inert remainder" eligibility arm
(only `placements.length >= 4` is implemented,
`intrinsicPeriodicFamilyPortfolio.ts:188`); (ii) plan artifact paths under
`/private/tmp` are treated as durable evidence but are machine-local — every
cross-machine review (including this one) loses them; (iii) "The old E3
periodic experiment is not a conclusive periodic negative" is correct and is
now reinforced: the *new* run is not conclusive either, for a different,
localized reason.

**B7 (periodic-only archive).** As a pure experiment the isolated archive was
acceptable for a first run, but for the *decision* the brief asks about it is
not: a portfolio verdict requires the ordinary width-3 baseline and the
pocket-first reconstruction endpoint to compete in the same run, same archive,
same budget accounting, as protected source-tagged entries. Otherwise
"periodic lost/won" is not a statement about the same selection problem. This
is Finding F6 and part of the recommended experiment.

**B8 (provenance gaps).** Sufficient to distinguish coverage from scheduling
failure at family granularity (per-family coverage flags exist), insufficient
below that: (i) rejected samples omit density, member/pair identity, and the
producing transform pair — the single most diagnostic number (density ≈ 1)
was not recorded, which is why this defect survived review; (ii) the global
`rejected` map double-counts (`noP1Basis`/`noP2Basis` overlap with the
per-stage counters); (iii) Mixed's omitted eligible families beyond the cap of
8 have no recorded identities/counts, so "familyCoverageComplete: false"
cannot be audited for what was skipped; (iv) continuation deadline runs record
no per-depth progress, so a 25 s timeout cannot be attributed to seed size vs
decoder cost; (v) no replay evidence (the harness runs once); (vi) the
observer-only prefix audit demanded by the peer decision does not exist.

**B9 (ranking).** (1) Repair the periodic certificate/finite-crop path —
measured blocking defect, measured upside, smallest change, directly on the
approved plan path. (2) Rerun the fuller bounded portfolio (Triangle, two
homogeneous controls, Mixed) with the archive correction of B7 — this is the
same experiment's confirmation arm, not a separate mechanism. (3) Broaden
finite contact-pose generation — **not now**: F0 concluded the finite contact
families already exist in NFP/IFP generation
(`help/research/dalsoo-abey-dalalah-transfer-study.md`, mapping section), and
nothing in the periodic evidence reopens that. (4) Start the Sparrow-shaped
controller — only after (1)+(2) complete conclusively; its architecture gap
list is now precise (see F8), so it can be scheduled with confidence but
should not preempt a localized, cheap, high-yield repair.

**B10 (conclusive-negative criteria after repair).** Triangle: coverage flags
all true (already achieved), every density-ranked basis either certified or
rejected with a split-stage witness, all certified cells expanded with
grid-exact contact-snapped crops, all crops ≥ 4 placements continued to exact
completion, three byte-stable replays — and then **no** completed endpoint
that is non-dominated against the same-run ordinary baseline under the shared
archive. Given the probe already produced a dominating endpoint with the
gate bypassed, a negative Triangle result after repair would falsify the
repair implementation, not the hypothesis — which is exactly what makes this
experiment sharp. Mixed: same per-family criteria, plus either
`familyCoverageComplete && continuationCoverageComplete` under raised-but-
bounded caps (16 families / 12 continuations is enough to cover the current
overflow) or recorded identities proving every skipped family has lower
multiplicity·area than every retained one; every continuation must complete
or be rerun in a second pass — deadline-truncated continuations are
inconclusive by the plan's own rule and cannot count toward a negative.

**C11 (reachability vs comparator).** Yes, the evidence now supports
reachability/representation as the binding constraint, with the roles cleanly
separated: candidate generation was repaired once (envelope events) and F0
found no further finite-source omission; retention/beam experiments (widths,
contact roles, peel/reinsert, compact closure, four-contributor
reconstruction, coordinated transport, component-interface closure) all
completed and all failed to reach the compact motif — because every
intermediate prefix of the motif is geometrically dominated and dies under
any bounded width; and the probe shows the motif *as a whole* is legal,
constructible, and archive-dominating. A comparator can only choose among
reachable endpoints; the motif was never reachable by sequential growth. The
periodic seed changes the reachable set itself — that is the representation
claim, now with a measured witness.

**C12 (portfolio of constructors).** Yes, it can generalize, under one strict
contract: every constructor is source-tagged, budgeted, deterministic, and
emits only *seeds* (frozen exact placements + remaining pieces); all seeds
complete through the one unchanged strict decoder; all completed endpoints
enter the one shared exact archive together with the always-present protected
ordinary baseline; nothing else may enter production. Under that contract a
constructor is an unlockable reachability extension, not a special path — the
archive decides, and a constructor that never wins is dead weight but never a
correctness risk. The current periodic-only archive violates the
"always-present baseline" clause; fix per B7.

**C13 (minimal faithful-Sparrow change set).** In order: (1) incumbent-driven
target progression — on an accepted canonical-legal endpoint, derive the next
target as a small contraction of the incumbent's exact envelope instead of
the three static roles (`deriveIntrinsicGlobalTargetRoles` runs once today);
(2) close the projection feedback loop — an accepted projection must re-enter
the loop as the new incumbent (machinery exists in the pressure prelude,
lines ~2286–2318, but is disconnected from the basin search); (3) carry the
restart pool across targets with scope tags instead of clearing per basin;
(4) make disruption stagnation-adaptive rather than fixed at sweeps
`[0,4,8]`; (5) only then consider coordinate-descent refinements. The
existing controller is insufficient precisely because (1) and (2) are absent:
it is a one-shot three-target sampler, not a contraction loop. Conflict
accounting, weighted separation, disruption lineage, pool retention, and
exact projection all already exist and should be retained.

**C14 (NFP/IFP backbone).** Retain it unchanged. Every mechanism this review
touches — basis enumeration (pair NFPs), 3×3 validation, crop legality,
continuation, canonical admission — already runs on the NFP/IFP + direct
validation + canonical Clipper2 stack, and the measured defect is in a gate
*above* that stack, not in it. No replacement is necessary, and none is
proposed.

## Reproduction: The Certificate Probe

Method (read-only, no implementation edits): a standalone tsx script that
(1) rebuilds the triangle-20 prepared pieces exactly as the committed harness
does; (2) enumerates the 8 unique transforms and all 28 ordered transform
pairs; (3) for each legal NFP-boundary pairing, reconstructs the four
member-pair forbidden boundaries and derives bases through the exported
`derivePeriodicAxisBasisCandidatesControl` seam (both axis orientations);
(4) for each basis evaluates the exported `farNeighborCertificate` and
`validatePeriodicContactLatticeControl`; (5) for each witness with
`far=false ∧ exact3x3=true`, builds the corresponding `IntrinsicPeriodicCell`
literal and calls the unchanged `expandIntrinsicPeriodicCell`, then completes
the best seed through the unchanged
`constructIntrinsicStrictState`/`finalizeIntrinsicStrictState`.

Results (this machine, commit `327f7ad` tree, identical periodic sources to
`0b3309e`):

```text
unique transforms: 8
bases tested: 375
witnesses far=false && exact3x3=true: 10   (all density 0.9923)
example: v1=(88.288,0) v2=(0,76.262)  det=6,733,019,456 grid²
         4det² = 181,334,203,979,498,143,744
         D²·f2 = 319,099,662,975,537,059,360   → certificate fails ×1.76
expandIntrinsicPeriodicCell (unchanged): crops per witness: 0,0,2,2,4,4,6,4,6,0
best completed endpoint via unchanged strict decoder:
  status completed
  canonicalGeometryHash 15d34424f53bfc7a85cc610f886a1e092b3745a8136539d9846c0a9f27ee521a
  area 73,907.487012 mm²   maxSide 484.563   span 637.087
  cavities 0   hullGap 0.0506   hullWaste 0.0536
  isolates 10  components 11  largest 10  structuralContacts 0/0
  sharedBoundary 394.92 mm
crop-arithmetic diagnostic (same witness cell, manual 2×5 crop):
  float accumulation (as expandIntrinsicPeriodicCell): first illegal at column 2
  grid-exact multiples (as validateLattice):            first illegal at column 3
```

The 0/0 structural contacts and the elongated shape are the v2-axis
quantization effect described above, not properties of the motif. The probe
script is not part of this commit (the delivery contract allows only this
document); it is ~450 lines, uses only exported seams, and is fully
reconstructible from the description above.

# Findings (ranked by severity)

**F1 — `farNeighborCertificate` structurally rejects every dense cell and is
used as a hard pre-materialization gate.**
`intrinsicPeriodicCells.ts:771, 1129–1154`. Sound as a sufficiency proof for
infinite lattices; provably (measured, ×1.76 on exact BigInt terms) too
strong for the dense cells that are the experiment's entire purpose. Explains
`certified cells: 0` on Triangle completely: dense bases die here (185), and
the only bases that can pass are sparse ones, which then die at the 3×3
contact requirement (16). The pincer guarantees zero certified cells for any
compact-tiling family. This single gate converted a positive experiment into
a false negative.

**F2 — Finite-crop materialization is not grid-exact and cannot represent
tangency on quantization-straddled axes.**
`expandIntrinsicPeriodicCell` accumulates float lattice points
(lines 536–539) where `validateLattice` uses BigInt grid multiples
(lines 1171–1174); measured divergence on the same cell (first-illegal at
column 2 vs 3). Separately, when a true period falls between 0.001 mm grid
points, the floor alternative overlaps (illegal) and the ceil alternative
loses contact, so crops extend only along exact-tangency axes → elongated,
contact-poor seeds. Repair: grid-exact multiples plus deterministic per-
translate snap to the nearest exact NFP-legal contact offset (±1 grid unit),
validated by the existing direct/canonical authorities. Without F2's repair,
F1's repair yields dominated-shape crops that may fail golden side/span/
contact gates for the wrong reason.

**F3 — Rejection provenance too coarse to have caught F1.**
`IntrinsicPeriodicCellRejection` (lines 98–109) records role, stage, basis,
determinant — but not density, member/pair identity, producing transform
pair, or (for 3×3) the failing translate/member and whether the failure was
legality or contact. A single recorded density column would have exposed F1
immediately (all far-rejects at density ≈ 1). Also: `noP1Basis`/`noP2Basis`
overlap with per-stage counters in one merged map (double counting), and
`validateLattice`'s two failure arms share one stage name.

**F4 — Mixed periodic result is doubly inconclusive and must not be scored as
periodic evidence.** Briefed: `familyCoverageComplete: false`,
`continuationCoverageComplete: false`, 6/8 continuations deadline-killed —
and, per F1, dense Mixed cells were certificate-suppressed on top of the
scheduling truncation. The two completed endpoints (417,922 / 424,747 mm²)
are archive filler, not a verdict. The plan already refuses to promote this;
this review confirms and strengthens that refusal.

**F5 — Three peer-mandated contract elements are missing from the
implementation.** (a) No three-byte-stable-replay loop anywhere in the
harness (`scripts/irregular-intrinsic-periodic-family-portfolio.ts` runs
once); (b) no observer-only reference-prefix audit; (c) continuation
eligibility implements only `placements.length >= 4`
(`intrinsicPeriodicFamilyPortfolio.ts:188`) — the "or hands off a measured
non-inert remainder" arm is silently absent. None of these caused the
Triangle false negative, but all three were conditions of the peer decision
that authorized this experiment.

**F6 — The periodic archive competes only against itself.** The portfolio
archive (`runIntrinsicPeriodicFamilyPortfolio`) contains only periodic
continuations. No protected ordinary baseline or pocket-first endpoint
competes in-run, so "not a quality win" conclusions require cross-run
comparison of numbers produced under different budgets. For a decision-grade
run, baselines must be first-class archive entries.

**F7 — Periodic continuations use `candidateDomain: 'sheetless-nfp'` only.**
`intrinsicStrictDecoder.ts:395`. The repaired envelope-event family (commit
`1d527bc`) does not serve continuations. Acceptable as a first bound, but it
is an undocumented asymmetry: a seed whose completion needs an interior-
segment alignment event will fail in a way that looks like a periodic
failure. Record it; optionally test the flag in a later paired cell.

**F8 — The static squeeze controller is confirmed non-faithful to Sparrow,
with a now-precise gap list.** Static one-shot target roles
(lines 863–890), fixed sweeps, incumbent progression present only in the
disconnected pressure prelude (~2286–2318), per-basin pool, fixed disruption
schedule. This sharpens — not changes — the plan's Stage 5 description, and
it means the "move to Sparrow now" option is not a small step: it requires
the coupling work of C13 before it is even the experiment its proponents
mean.

**F9 — Evidence portability.** Every decision-critical artifact lives under
machine-local `/private/tmp`, and the pinned Sparrow/Dalsoo checkouts under
`knowledge/` are untracked. On any second machine (this review), the
evidentiary chain reduces to the brief's own numbers. Reports (or at minimum
their manifests + counters) for decision-gating runs should be committed or
otherwise durably mirrored.

**F10 — Axis-aligned basis restriction (documentation-level).**
`deriveAxisBasisCandidates` requires an axis-aligned first vector; general
oblique-only lattices are reachable only through transforms that re-align a
period with an axis. Harmless for current fixtures (measured: the Triangle
motif is found), but it is a real representational bound that the plan should
state explicitly so a future non-orthogonal family failure is not
misattributed.

## Candidate Fixes And Directions

**Route 1 — Minimal repair of the current periodic implementation (chosen).**
*Changes:* demote `farNeighborCertificate` from gate to recorded flag; split
`threeByThreeLatticeRejected` into illegality/no-contact stages; grid-exact
crop lattice arithmetic; deterministic ±1-grid contact snap per translate;
density + pair identity + per-stage witnesses in rejection samples; baselines
into the same archive; the three missing peer-contract elements (replays,
prefix audit, remainder-handoff eligibility or its explicit deferral).
*Evidence:* the probe (10 witnesses, completed 73,907 mm² endpoint through
unchanged downstream machinery). *Risk:* low — legality never derives from
the removed proof; every placement remains direct-validated and every
endpoint canonically admitted; main residual risk is crop-shape selection
quality. *Generic:* yes — no fixture names, counts, or saved placements;
pure family/lattice geometry. *Cost:* small implementation delta in two
files plus harness; runtime well inside existing caps (Triangle catalog is
~70 ms today). *Reject if:* after repair, Triangle produces no completed
endpoint non-dominated against the same-run ordinary baseline across three
byte-stable replays — which, given the probe, would indict the repair code
itself and end the periodic line with a genuinely conclusive negative.

**Route 2 — Broader bounded repeated-geometry / finite-motif design.**
*Changes:* 3+-member cells (p6-like motifs), oblique bases without axis
alignment, motif-of-motifs crops. *Evidence:* none — P2 sufficed for the only
measured case. *Risk:* combinatorial growth of pair/triple enumeration;
diluted budgets. *Generic:* yes in principle. *Cost:* medium-high. *Reject
if:* proposed before a Route-1 conclusive result exists; adopt only if a
homogeneous-family fixture with a known compact motif fails Route 1 with
coverage complete and the recorded witnesses show no P1/P2 basis can express
its motif.

**Route 3 — Contact-pose / reconstruction direction from Dalsoo/Abeysooriya.**
*Changes:* new finite vertex/edge pose generators or hole-first
reconstruction arms. *Evidence against:* F0 already mapped every Dalsoo
finite contact family onto existing NFP/IFP constructions
(`dalsoo-abey-dalalah-transfer-study.md`, mapping table: NFP vertices,
antiparallel edge-support endpoints, IFP corners/intersections, NFP-NFP
intersections), and the periodic failure is measured to be above the
candidate layer. The periodic cell representation is narrower than the
Dalsoo pose grammar in *pairing* (it composes two poses into a lattice), but
the grammar itself is not missing — and after F0, "add more poses" answers a
question nobody's trace is asking. *Risk:* candidate-pool inflation,
re-litigating a closed result. *Generic:* yes. *Cost:* medium. *Reject if:* —
already rejectable now; revisit only on a new F0-style witness of a
direct-legal, canonical-legal pose absent at the raw source.

**Route 4 — Portfolio / archive correction (fold into Route 1).**
*Changes:* protected ordinary-baseline and pocket-first endpoints as
source-tagged in-run archive entries; per-family omitted-identity records;
per-continuation depth/progress traces; committed report manifests for
decision-gating runs. *Evidence:* F4/F6/F9. *Risk:* none meaningful.
*Generic:* yes. *Cost:* small. *Reject if:* never — this is hygiene required
for any decision-grade portfolio, independent of Route 1's outcome.

**Route 5 — Faithful Sparrow-style global repair.**
*Changes:* per C13: incumbent-driven contraction, projection feedback,
cross-target restart pool, stagnation-adaptive disruption, on the existing
exactness/projection machinery. *Evidence for eventual need:* completed
legal-search exhaustion on Triangle cohesion (peel, closure, four-
contributor, transport, interface pilots all negative); the beam cannot move
a placed ring. *Risk:* largest state space, infeasible-pool discipline,
multi-minute budgets; and right now it would be started while a measured
cheap repair is pending. *Generic:* yes. *Cost:* high. *Adopt when:* Route 1
completes conclusively (either outcome) — a periodic win still leaves
heterogeneous global repair open; a true periodic negative makes this the
next mandated step per the standing peer decision. *Reject if:* implemented
without incumbent progression and projection feedback — that would be the
existing static controller again, which is already measured to be
insufficient.

# Recommended Next Experiment

**1. Hypothesis.** Dense P1/P2 cells rejected solely by the infinite-lattice
certificate can, via grid-exact contact-snapped finite crops validated by the
existing direct and canonical authorities, seed completed endpoints that are
non-dominated against the ordinary and pocket-first baselines under the
shared exact archive — on Triangle specifically, beating 88,124.330 mm² with
zero cavities and restoring structural contact.

**2. Bounded algorithm sketch.**

```text
enumerate families/transforms/pairs        (unchanged, caps unchanged)
for each canonicalized basis:
  record infiniteLatticeProven = farNeighborCertificate(...)   # flag only
  run 3x3 validateLattice split into: illegal | noContact | ok
  if ok: admit cell to (family, role) density-ranked front (<= 16 per role)
for each admitted cell (<= 4 crops):
  for each (rows, columns, traversal, corner):
    for each member placement in crop order:
      target = basePoint + row*v1 + column*v2       # BigInt grid multiples
      snapped = argmax over {target + (dx,dy) : dx,dy in {-1,0,1} grid units}
                preferring (contact realized, direct-legal, lexicographic)
      if none direct-legal vs all placed -> crop dead, record witness
  bottom-left normalize; canonical identity dedupe; topology measure
seed selection, continuation, finalization         (unchanged)
archive: periodic endpoints + protected ordinary width-3 baseline
         + pocket-first reconstruction endpoint, all source-tagged
replay: entire fixture run 3x, byte-compare reports (minus runtime fields)
```

**3. Source files likely to change.**
`src/workers/algorithm/irregular/intrinsicPeriodicCells.ts` (gate→flag, stage
split, grid-exact snap-aware expansion, richer rejection records);
`src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts`
(baseline archive entries, eligibility record, continuation progress trace);
`scripts/irregular-intrinsic-periodic-family-portfolio.ts` (replay loop,
report fields); matching unit tests. No production beam, comparator,
squeeze-controller, or NFP/legality file.

**4. Services that remain authoritative.** `PlacementValidation`
(direct convex legality) for every placed member; canonical Clipper2
(`canonicalCollisionLayoutIdentity`, `assertCanonicalGridLegalLayout`) for
identity and endpoint admission; the unchanged strict decoder for
continuation; the shared exact archive comparator for selection. The
certificate proves nothing about legality in any path.

**5. Trace fields.** Per basis: family key digest, producing transform pair,
v1/v2, determinant, member doubled area, **density**, infiniteLatticeProven,
stage outcome (degenerate | farFlagOnly | threeByThreeIllegal(n,m,member) |
threeByThreeNoContact(member) | admitted), front admission/eviction. Per
crop: rows×columns/traversal/corner, per-translate snap delta, first-illegal
index on failure, canonical identity, topology tuple. Per continuation:
seed id, placements, per-depth progress timestamps, status, endpoint metrics
+ canonical hash. Per run: the three replay report digests; archive entries
with source tags (`periodic:*`, `baseline:ordinary-w3`,
`baseline:pocket-first`).

**6. Gates.** Triangle-20: complete catalog + all crops + all continuations
+ 3 replays inside the existing 240 s cap; success = a completed periodic
endpoint non-dominated vs both baselines, area < 88,124.330 mm², zero
cavities, structural contact restored (> 0 dominant contacts; golden
side/span/contact gates measured and reported, pass not required for the
experiment to be positive but required before any production talk).
Homogeneous controls: rectangles-20 and pentagons-20 (already in the
harness) must complete with certified cells > 0 and no crash/regression —
rectangles should trivially lattice; a rectangles failure falsifies the
implementation. Mixed-61: caps raised to 16 families / 12 continuations, all
continuations complete or the run is marked inconclusive; success = any
periodic endpoint non-dominated vs the 405,773.434 mm² pocket-first entry in
the same archive. Sheet-invariance: rerun Triangle on two historical sheet
dimensions; the selected sheetless seed set must be byte-identical
(sheet participates only in final fit).

**7. Promotion / rejection / inconclusive.** Promotion (of the experiment,
not to production): Triangle success as defined + homogeneous controls clean
→ periodic seeding graduates to a standing portfolio arm and Mixed evidence
is re-read. Rejection: Triangle failure with complete coverage and 3 clean
replays → periodic line closes with a conclusive negative and Stage-5
adaptive contraction starts per the standing peer decision. Inconclusive:
any cap/deadline truncation, replay divergence, or crop-stage witness gaps →
fix and rerun before drawing anything; a truncated run must not be scored.

**8. Expected failure modes and their trace signatures.** (a) Snap cannot
realize contact on a quantization-straddled axis → per-translate snap deltas
all ±1 with `contactRealized=false` on one axis; endpoint completes but
contact gates fail → report as grid-representability limit with exact
witnesses, not as a periodic negative. (b) Far crops genuinely overlap
(certificate was protecting something real for some basis) → crop
first-illegal index at |offset| ≥ 2 with grid-exact arithmetic → the basis is
recorded rejected-with-witness; no correctness impact since crops are
directly validated. (c) Continuation deadline on Mixed → per-depth progress
trace attributes time to decoder vs seed size; rerun that continuation alone.
(d) Replay divergence → byte-diff of reports isolates the nondeterministic
field; run is inconclusive by rule. (e) Elongated-crop domination persists →
crop-shape records show near-square crops generated but dominated; escalate
to seed-front shape criteria, not to new mechanisms.

**9. Production impact.** None. This remains an isolated, source-tagged
portfolio experiment: no live beam, comparator, candidate pool, or squeeze
path changes; endpoints exist only in the experiment archive with full
provenance.

# Exact Safety and Provenance Contract

- Legality is never derived from any periodic certificate, flag, or lattice
  argument. Every placed member passes direct convex validation against all
  previously placed members; every completed endpoint passes canonical-grid
  Clipper2 admission and q0/q90 final-sheet legality exactly as today. The
  infinite-lattice proof, where it passes, is recorded as provenance and used
  for nothing else.
- All lattice arithmetic in materialization is BigInt grid arithmetic; snap
  offsets are bounded to ±1 grid unit per axis and chosen by a deterministic
  total order (contact realized, then direct-legal, then lexicographic
  offset). No floating accumulation of lattice multiples anywhere.
- Determinism: stable enumeration orders (existing transform order, pair
  index, boundary-point order, crop coordinate order); run-local caches;
  three byte-stable replays required for any decision-grade report, with the
  volatile runtime fields excluded from the byte comparison and reported
  separately.
- Budgets: existing 15 s catalog / 25 s continuation / 240 s fixture caps;
  ≤ 16 admitted bases per (family, role), ≤ 4 crops per cell, Mixed caps 16
  families / 12 continuations. Cap-truncated runs are diagnostic-only and
  ineligible to decide anything, per the plan's standing rule.
- Provenance: rejection witnesses carry density, pair identity, and stage
  detail; omitted families and continuations carry identities and ranks;
  archive entries carry source tags including the two baselines; the report
  and manifest for the decision-gating runs are committed to the branch (or
  durably mirrored) so the evidentiary chain survives machine changes — this
  review is the demonstration of why.
- Prohibitions: no fixture names, piece counts, saved placements, remembered
  layouts, or triangle-specific geometry anywhere in the mechanism; sheet
  dimensions only in final fit and the monotone feasibility gate; SAT
  nowhere in this path.

# What Not To Do Yet

- **Do not start the adaptive Sparrow-style controller yet.** Its gap list is
  now precise (C13/F8) and it remains the mandated successor after a
  conclusive periodic result — which does not exist yet. Starting it now
  forfeits a measured 16% Triangle improvement sitting behind a small repair.
- **Do not add Dalsoo-style pose generators or any new contact-point
  family.** F0 stands; the failure is above the candidate layer.
- **Do not re-run the failed Triangle cohesion mechanisms** (peel/reinsert,
  compact closure, contributor reconstruction, coordinated transport,
  component-interface closure) with tuning; their negatives are complete and
  the periodic seed attacks the same symptom from the reachability side.
- **Do not "fix" the certificate by loosening its inequality** (e.g. a √2
  factor or per-coefficient shells). Any inequality-only fix keeps an
  infinite-lattice proof as a finite-crop gate — the category error survives.
  Demote it to a flag; let direct+canonical validation of the actual crop
  decide, as it already does downstream.
- **Do not promote the probe endpoint** (73,907 mm²) or any crop of this
  review into production, goldens, or saved layouts. It is diagnostic
  evidence produced outside the preregistered pipeline; the repaired
  experiment must regenerate it from source under the full contract.
- **Do not score the current Mixed periodic run** as evidence in either
  direction, and do not raise Mixed budgets beyond the bounded 16/12 caps in
  a first repaired pass.
- **Do not build P3+/motif extensions or oblique-basis enumeration** without
  a coverage-complete P1/P2 failure on a fixture with a known compact motif.

# Required Plan Corrections

1. Under "The New Periodic-Family Experiment": replace the implication that
   the P1/P2 certificate pipeline tested compact cells with the corrected
   statement — the far-neighbor gate structurally excludes dense cells, so
   the Triangle run measured the gate, not the motif space. Record the probe
   result (10 dense witnesses pass exact 3×3; unchanged expansion+decoder
   completes 73,907.487 mm², hash `15d34424…`) as the current reachability
   witness, explicitly tagged diagnostic-not-promotable.
2. Amend the periodic contract with the finite-crop rules: certificate as
   recorded flag only; split 3×3 rejection stages; BigInt lattice
   arithmetic; deterministic ±1-grid contact snap; density/pair identity in
   every rejection witness; in-run baseline archive entries.
3. Record the three peer-contract implementation gaps (no replay loop, no
   observer prefix audit, missing non-inert-remainder eligibility arm) and
   either implement them in the repaired run or explicitly re-scope them
   with reviewer sign-off — silence is the failure mode here.
4. Note `candidateDomain: 'sheetless-nfp'` for periodic continuations as an
   explicit, intentional bound (F7), so a continuation failure is not
   misread as a seed failure.
5. Document the axis-aligned-basis representational bound (F10) and the
   grid-quantization tangency limit (a true period straddling the 0.001 mm
   grid cannot be represented as simultaneous contact-and-legality on that
   axis; the snap rule is the sanctioned mitigation).
6. Update the conclusive-negative criteria for both fixtures to the B10
   definitions, and re-affirm the standing order: adaptive incumbent-driven
   contraction (with the C13 change set as its definition of "faithful")
   starts immediately after a conclusive periodic result, in either
   direction.
7. Add a durability rule for decision-gating evidence: commit report +
   manifest (or a digest mirror) for any run that a plan decision cites, so
   the next cross-machine review does not inherit an empty `/private/tmp`.
   Likewise either commit the pinned Sparrow/Dalsoo trees or record their
   absence as an accepted limitation of `knowledge/`-based citations.
