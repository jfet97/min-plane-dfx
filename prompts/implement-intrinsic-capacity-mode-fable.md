# Implement Intrinsic Capacity Mode Without Regressing Compact

You are taking over a mature TypeScript/Effect irregular-nesting engine after a
large search-quality, exactness, sheet-invariance, and performance effort. Work
as an implementation owner, skeptical reviewer, and performance engineer. Do
not merely summarize the repository or write another speculative plan: inspect
the current code, implement the highest-priority capacity mode, prove what you
changed, and leave reviewable code and evidence.

## Repository And Delivery Contract

1. Start from the latest remote `main` of:
   `https://github.com/jfet97/min-plane-dfx`.
2. Read the root `AGENTS.md` and `CLAUDE.md`, if present, before editing.
3. Create and work on a normal human-named branch:
   `intrinsic-capacity-mode-fable`.
4. Do not rewrite unrelated code or revive retired legacy controls/decoders.
5. Commit all accepted implementation, tests, documentation, reports, and
   portable evidence.
6. Push the branch and open a pull request against `main`.
7. Use exactly these pull-request sections, in this order:
   `Why`, `What`, `How`, `Remarks`.
8. Never add model/tool attribution, co-author lines, or generated-by footers.

The repository may be on another machine. Do not rely on local knowledge-base
files or `/private/tmp` paths referenced by earlier work. The tracked source,
documentation, fixtures, and artifacts are the portable source of truth.

## Read First

Read these current contracts before touching code:

1. `SCORING_CRITERIA_NOTES.md`
2. `docs/architecture.md`
3. `docs/architecture/index.md`
4. `docs/architecture/algorithm-boundary.md`
5. `docs/architecture/irregular-v2-infrastructure.md`
6. `docs/architecture/process-boundaries.md`
7. `docs/operations/irregular-production-gates.md`
8. `docs/planning/intrinsic-capacity-mode.md`
9. `docs/planning/irregular-nesting-roadmap.md`
10. `docs/research/intrinsic-shared-archive-performance-checkpoint.md`
11. `docs/research/adaptive-compact-transform-policy.md`
12. `docs/research/open-source-nesting-strategies.md`
13. `docs/research/open-source-irregular-nesting-strategies.md`
14. `docs/research/dalsoo-abey-dalalah-transfer-study.md`
15. `docs/history/search-quality-decisions.md`
16. `docs/history/sheet-invariance-decisions.md`

Also inspect every other tracked Markdown file under `docs/planning/`. Treat
`docs/planning/intrinsic-capacity-mode.md` as the primary implementation
contract and `docs/planning/irregular-nesting-roadmap.md` as the priority and
interaction map. Historical reports explain prior evidence; they do not
override current architecture.

## Current Production Boundary

Compact quality currently:

1. prepares exact collision geometry and a finite transform domain;
2. runs several bounded, sheetless constructors;
3. admits complete canonical-exact endpoints into one intrinsic shared archive;
4. ranks complete layouts without requested-sheet dimensions;
5. only afterward tests rigid q0/q90 fit on the requested sheet;
6. returns no partial result if no complete endpoint fits.

This separation is intentional. If the same winning complete motif fits on two
roomy sheets, both must select the same geometry. Sheet dimensions constrain
legality and final fit; they must not steer complete-layout compactness.

The three tracked baseline winners are:

| Fixture | Envelope area | Cavities | Canonical hash prefix | Recent runtime |
| --- | ---: | ---: | --- | ---: |
| Triangle-20 | `74,428.143126 mm2` | 0 | `371db269...` | about `12.6 s` |
| Mixed-61 | `391,605.850174 mm2` | 0 | `ef2b783a...` fitted | about `53.0 s` |
| Shapes-17 | `304,499.845650 mm2` | 0 | `c640c06f...` | about `7.4 s` |

The portable renders and manifest are under
`docs/artifacts/current-compact-baselines/`.

Recent performance work is not optional context. The engine stopped
fully anchoring and rebuilding every discarded proposal, improving the dominant
strict-construction path by roughly 6.6x while preserving the exact archive and
winner. A validated replay seam also demonstrated a smaller warm-run gain.
Capacity work must not accidentally restore eager state construction, add
unbounded hot-loop topology work, or make roomy-sheet Compact slower without
measured justification.

## Primary Mission

Implement the complete first production version specified in
`docs/planning/intrinsic-capacity-mode.md`.

The user-visible contract is:

- if all pieces fit, return the same best complete sheet-independent motif;
- if they cannot all be placed, return the best exact partial layout and report
  every omitted piece as unplaced.

Do not estimate whether pieces fit by adding a waste percentage. The only
preflight outcomes are:

```text
proven_impossible(reason)
inconclusive
```

The initial proof-only preflight must use:

- exact `bigint` shoelace area over every piece's finite valid transform set;
- an exact singleton q0/q90 fit test;
- conservative error handling: invalid or incomplete accounting is an error,
  never a proof.

Routing must remain:

```text
preflight proven impossible
    -> skip complete construction
    -> run intrinsic-capacity-v1 from empty

preflight inconclusive
    -> run unchanged sheetless complete archive
    -> return immediately if a complete endpoint fits
    -> otherwise record bounded_complete_archive_miss
    -> run intrinsic-capacity-v1
```

Cancellation, timeout, invalid geometry, incomplete source coverage, or a
censored constructor are not capacity transitions.

## Required Capacity Search

Implement the exact endpoint, accounting, trace, and search contract from the
planning document. In particular:

- capture at most nine committed direct-constructor prefix descriptors after
  constructors complete, at quarter/half/three-quarter depths;
- allow only `canonical-grid`, `legacy-absolute-envelope`, and
  `open-pocket-first` direct roles in v1 prefix reuse;
- ensure capture does not change complete construction, archive order,
  evaluations, hashes, or source selection;
- exact-fit and terminalize fitting prefixes as initial incumbents with zero
  warm placement evaluations;
- still run the cold subset search from the empty state;
- use cold beam width `16`, local legal fanout `3`, evaluation cap `50,000`,
  and one mandatory skip successor at every piece depth;
- check exact partial q0/q90 fit and canonical deduplication before retention;
- never compare states from different piece depths directly;
- rank endpoints by:
  1. more placed pieces;
  2. more unpadded placed material area;
  3. fewer exact enclosed cavities;
  4. less exact cavity area;
  5. smaller intrinsic maximum side;
  6. smaller intrinsic envelope area;
  7. smaller intrinsic span;
  8. deterministic prepared order and geometry identity;
- prune only through the strict attainable-count and attainable-material bounds
  specified in the plan;
- preserve equality, because topology and compactness can still decide it;
- return an exact partition of placed and unplaced prepared IDs.

Do not weaken canonical Clipper2 legality, exact endpoint admission, or the
shared archive. Do not make SAT residue authoritative. Do not introduce
fixture-specific rules, piece-count-specific rules, fake placements, or
sheet-normalized complete-layout preferences.

## Performance Mission

Capacity mode must be useful without destroying the speed gains already won.
Measure and report, separately:

1. proof-only preflight time;
2. unchanged complete archive time;
3. descriptor capture and terminalization time;
4. cold capacity-search time;
5. consumed placement evaluations;
6. exact topology/cache time;
7. final endpoint materialization time;
8. total cold runtime.

Follow these constraints:

- complete-path prefix capture is one post-construction lineage walk;
- no q0/q90, cavity measurement, spatial-index rebuild, or state copying in the
  complete constructor hot loop;
- at most nine prefix endpoints receive exact fit/topology measurement;
- cache retained-state cavity results by canonical occupied-union identity;
- do not build full anchored states for proposals that are discarded before
  retention;
- benchmark telemetry must default off and must not change semantic settlement;
- do not claim a prefix speedup unless it reduces both cold successor
  evaluations and elapsed capacity time in a paired run;
- keep cold and warm/replay measurements separate.

If profiling shows a different dominant cost than expected, fix the measured
bottleneck while preserving the specified semantics. Document any deliberate
departure from the v1 bounds and demonstrate why it is required.

## Required Tests And Falsifiers

Add focused tests before relying on large fixtures. At minimum cover:

- area-proven impossibility bypasses complete construction;
- singleton-infeasible geometry bypasses complete construction;
- inconclusive preflight never claims feasibility;
- inconclusive plus fitting complete endpoint never enters capacity mode;
- bounded complete archive miss enters capacity mode honestly;
- skip successors can prefer several smaller pieces over one large piece;
- every endpoint partitions the request exactly;
- equality in count/material bounds is not pruned;
- no-fitting-prefix output equals cold-only output;
- prefix-enabled output never ranks below cold-only;
- deterministic replay produces the same descriptors, pruning, endpoint, and
  trace;
- cancellation and deadline censoring remain errors;
- Compact selected-layout history and GIF reveal remain functional.

Then run the current complete baselines from clean inputs:

- Triangle-20;
- Mixed-61;
- Shapes-17.

For complete roomy-sheet behavior, preserve or improve quality, exact legality,
zero cavities, current hashes where semantics are unchanged, and current
performance within measured noise. Run multiple roomy sheet dimensions and
verify that the same complete motif is selected whenever it fits.

Create constrained fixtures that isolate:

- exact area impossibility;
- singleton impossibility;
- inconclusive/no-fitting-complete behavior;
- count versus material-area priority;
- useful prefix incumbent;
- no useful fitting prefix;
- q0 versus q90 partial fit.

Record PNG/SVG renders for representative complete and capacity outcomes. Keep
large raw traces out of Git; commit bounded summaries, manifests, relevant
excerpts, hashes, and portable renders.

## Future Directions To Protect, Not Prematurely Implement

Read and assess every remaining roadmap item while implementing capacity mode:

- freeze the wider correctness/corpus gate;
- complete the roomy-sheet invariance matrix;
- continue performance profiling of the new construction floor;
- audit periodic source allocation;
- test cavity-first commensurate two-piece scheduling;
- use bounded archive-seeded destroy/repair only when its trigger is met;
- keep hull steering, GA, and broader periodic representation
  evidence-triggered rather than always on;
- keep identical-sheet continuation outside capacity v1.

Do not fold these into one uncontrolled experiment. In your final report,
explain:

1. which later directions the capacity implementation enables;
2. which it makes unnecessary;
3. which assumptions or seams should be changed now to avoid blocking them;
4. which should remain deferred until their documented trigger is observed.

## Open-Source Control Pass

If the tracked source reviews are insufficient for a disputed design choice,
clone and inspect the current upstream source of:

- Sparrow: `https://github.com/JeroenGar/sparrow`
- PackingSolver: `https://github.com/fontanf/packingsolver`
- libnest2d: `https://github.com/tamasmeszaros/libnest2d`
- Deepnest: `https://github.com/Jack000/Deepnest`
- SVGnest: `https://github.com/Jack000/SVGnest`
- Dalsoo-Bin-Packing: `https://github.com/whitegreen/Dalsoo-Bin-Packing`

Use them to challenge scheduling, construction, compaction, and portfolio
choices. Do not copy their numerical kernels or weaker collision checks into
the exact production boundary. The transferable patterns are bounded
constructor portfolios, explicit skip/fill phases, rotation-family coverage,
large-first/small-fill scheduling, and global improvement stages—not blind code
translation.

## Documentation And Final Report

Keep current architecture and operational docs synchronized with the code.
Update `docs/planning/intrinsic-capacity-mode.md` to distinguish implemented
behavior from deferred work, and update the roadmap rather than creating a
second competing plan.

Add one substantial report under `docs/research/` containing:

- critical review of the original capacity design;
- implementation architecture and exactness argument;
- every defect found and fixed;
- performance profiles and paired comparisons;
- complete and constrained fixture tables;
- canonical identities, areas, cavities, placed/unplaced counts, and runtimes;
- trace interpretation;
- portable SVG/PNG and manifest paths;
- rejected alternatives and falsification evidence;
- remaining risks and ranked next steps.

End with a concise merge recommendation:

```text
APPROVE
APPROVE WITH FOLLOW-UPS
DO NOT MERGE
```

Base that recommendation on exact evidence, not optimism. Push the complete
branch and open the pull request only after lint, typecheck, focused tests,
complete baselines, constrained capacity gates, deterministic reruns, and
portable evidence are finished.
