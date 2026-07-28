# Fable 5 task: make Short Side genuinely Compact-quality

Work autonomously and skeptically from the checked-out repository root.

The upstream project and pull-request target is:

`jfet97/min-plane-dfx`

Create a new human-named branch before making any change. Never work directly
on `main`. Push the branch and open a pull request against
`jfet97/min-plane-dfx:main`. If direct branch push is unavailable, use a fork
and still target that upstream `main`.

The user does **not** want another superficial shelf heuristic. The real product
goal is:

> Produce a layout that fills the requested sheet's shorter side while retaining
> the contact-driven compactness and interlocking quality of Compact.

In plain language: the result should look like Compact was asked to compact
hard **and** spread usefully across the short edge. It must not merely arrange
pieces in AABB rows that happen to span the width while leaving obvious
polygon-shaped gaps.

## Critical current-state warning

As of this prompt:

- `main` and `origin/main` are both at:
  `9027aa6e58c306d33f89f525e9d43bba081d7902`
- No corrective revert has been applied after the latest user complaint.
- The global stable-baseline orientation change at `9193f26` is still active
  on `main`.
- The latest archived evidence commit is `9027aa6`.
- The branch `short-side-multi-row` also preserves this state.

The latest result is **not accepted by the user**, despite passing the numeric
matrix. Do not mistake committed/pushed state for accepted product quality.

The user rejected this Mixed-61 `2000 x 2700` short-side layout:

`docs/artifacts/compact-short-side-observer/matrix/mixed-61-2000x2700.short-side-profile.png`

The screenshot showed:

- repeated triangular voids above flat-bottom pentagons/trapezoids;
- later small rectangles left at row ends even though earlier row tails appear
  large enough to contain them;
- strong short-edge fill numerically, but visibly weak interlocking and wasted
  space.

The user’s exact criticism was essentially:

> There are many empty spaces. Some pentagons could face downward and the
> little squares on the right could fit in those spaces. Why can’t we retain
> Compact’s compactness and simply add the requirement to fill the short side?

Treat that as the authoritative product requirement.

## Read before deciding anything

Read project instructions first:

1. `AGENTS.md`
2. `CLAUDE.md`, if present
3. `SCORING_CRITERIA_NOTES.md`
4. `docs/architecture.md`
5. relevant files under `docs/architecture/`
6. the Compact, intrinsic-capacity, short-side, scoring/search,
   single-process, and open-source research under `docs/`

Read these current short-side sources and evidence:

- `src/workers/algorithm/irregular/intrinsicShortSideObserver.ts`
- `src/workers/algorithm/irregular/intrinsicShortSidePairFoldObserver.ts`
- `src/workers/algorithm/irregular/computeIrregularNesting.ts`
- `scripts/irregular-compact-baseline.ts`
- `scripts/irregular-compact-nine-baselines.ts`
- `tests/unit/intrinsicShortSideObserver.test.ts`
- `tests/unit/intrinsicShortSidePairFoldObserver.test.ts`
- `docs/architecture/compact-architecture-explained.md`
- `docs/research/compact-short-side-observer.md`
- `docs/history/compact-short-side-target-aware-construction.md`
- `docs/history/compact-short-side-projection-stage2.md`
- `docs/planning/irregular-nesting-roadmap.md`
- `docs/operations/irregular-production-gates.md`
- `docs/artifacts/compact-short-side-observer/README.md`
- `docs/artifacts/compact-short-side-observer/matrix/manifest.json`
- `docs/artifacts/compact-short-side-observer/matrix/summary.json`
- `docs/artifacts/compact-short-side-observer/matrix/VISUAL_REVIEW.md`

Use the source links and mechanism summaries already recorded in
`docs/research/open-source-irregular-nesting-strategies.md` and related
`docs/research/` pages.

## Historical architecture that must remain intact

Production Compact already has a substantial architecture that is not
disposable:

- protected sheetless complete construction;
- exact intrinsic archive authority;
- roomy-sheet invariance;
- intertwined resumable capacity/subset work for constrained sheets;
- complete endpoints dominate partial endpoints when they fit;
- exact q0/q90 requested-sheet validation after intrinsic construction;
- deterministic checkpoint/resume behavior;
- separate complete and partial namespaces;
- no cold restart after discovering a complete miss;
- all algorithm work currently single-process and sequential.

Do not damage or flatten this architecture merely to add Short Side.

Production Compact’s roomy results and canonical hashes remain protected. Sheet
dimensions must not become a Compact compactness preference or reorder the
legacy complete cohort.

## Mandatory single-process rule

Everything must remain:

`single-process, single-worker, deterministic, cooperative, sequential`

Do not introduce:

- threads;
- two simultaneous worker executions;
- parallel complete and short-side processes;
- background algorithm races;
- nondeterministic scheduling.

This restriction remains until the user explicitly revokes it.

## What the current Short Side implementation actually does

The current Short Side sibling is not a true directional Compact optimizer.
It is a bounded post-production mechanism:

1. inspect settled Compact archive endpoints;
2. reuse one if it already fills at least 80% of the relevant short edge;
3. otherwise try an exact terminal pair fold;
4. otherwise build one deterministic prepared-order next-fit AABB shelf;
5. validate exact legality and admission;
6. preserve production Compact authority.

This is cheap and deterministic, but it does not perform Compact’s exact
contact-driven placement search while satisfying the directional goal.

That mismatch is now the central design problem.

## The latest bad change

Commit `9193f26` added a generic-looking tie-break:

- when shelf transform height and width tie;
- prefer the transform with the longest horizontal support on the row
  baseline.

The intent was to make triangles point upward without triangle-specific code.
It changed only orientation identities and preserved all 18 AABB envelopes.

However, it globally affects every asymmetric family before any row or
neighbor context exists. It therefore turns pentagons/trapezoids into
flat-bottom shapes even where the opposite orientation would interlock better.

Important evidence:

- pre-tie-break implementation/artifacts: commit `0d20d14`;
- stable-baseline code commit: `9193f26`;
- stable-baseline archive commit: `9027aa6`;
- current matrix:
  `docs/artifacts/compact-short-side-observer/matrix/`;
- portable rejected-comparison package:
  `docs/artifacts/compact-short-side-observer/rejected-stable-baseline/`.

The stable version preserved:

- bounds: `1987.776 x 301.187 mm`;
- envelope area: `598,692.290112 mm²`;
- short-edge fill: `99.3888%`;
- all `61/61` pieces;
- zero cavities;
- production Compact hashes.

Yet the user correctly rejected it visually. Its hull-gap ratio also worsened
slightly:

- before: `0.4325051759018452`;
- after: `0.43256001182424386`.

This proves that equal envelope, fill, density, and exact legality are
insufficient promotion criteria.

## Sol xhigh’s latest review

The portable review findings are recorded at:

`docs/artifacts/compact-short-side-observer/rejected-stable-baseline/README.md`

Sol concluded:

1. the directional outcome classification remains correct;
2. the shelf remains bounded/exact/deterministic;
3. the promotion evidence missed a real packing-quality regression;
4. its earlier “stop deeper work” suggestion is withdrawn;
5. the global stable-baseline tie-break should be reverted;
6. the smallest next experiment could retain exact rectangular tails of closed
   rows and probe later pieces into them deterministically before opening a new
   row.

Sol proposed a bounded row-tail first-fit experiment with no new transforms,
NFPs, reordering, or beam states.

**Do not blindly implement Sol’s proposal.**

The user explicitly asked for this Fable review because the deeper question is
whether row-tail first-fit is merely another local patch or whether Short Side
needs a more principled directional Compact cohort. Independently judge:

- whether Sol’s row-tail idea materially addresses the product requirement;
- whether it only hides one symptom;
- whether another mechanism reuses much more of Compact’s exact search and
  archive work;
- whether the best next step is a bounded experiment, an architectural change,
  or first a clean revert plus a written plan.

## Rejected or dangerous shortcuts

Do not:

- add triangle-, pentagon-, Mixed-61-, or fixture-specific code;
- use vertex count as a hidden shape-specific exception;
- add a fixed `+10%`, `+20%`, or arbitrary area multiplier as authority;
- use sheet-normalized compactness to order production Compact;
- introduce a target rectangle based on a magic waste percentage without
  evidence;
- rerun a cold search after production;
- use one flat survivor list for complete, partial, and directional states;
- widen a beam indiscriminately;
- add randomized GA behavior;
- accept overlap/infeasible states into production authority;
- call a legal but visibly sparse row arrangement “Compact-quality”;
- promote based only on unchanged bounding boxes;
- use concurrency or multiple algorithm processes.

Density, pressure, waste, or target-envelope estimates may guide a protected
experimental lane, but they cannot prove impossibility or prune the protected
complete cohort.

## What you must decide

Before editing, produce an evidence-led diagnosis and compare at least these
families of solution:

### A. Revert plus bounded row-tail backfill

Keep the pre-`9193f26` shelf transforms and prepared order. Retain closed-row
tails and let later pieces enter earlier tails deterministically.

Assess:

- whether AABB-only tails can meaningfully improve polygon interlocking;
- whether squares can actually fill the observed gaps;
- whether this reduces depth/area rather than merely moving voids;
- whether it is a useful production-shaped improvement or only another shelf
  patch.

### B. Contextual orientation selection inside the shelf

Choose among equal-envelope transforms using already placed row/neighbour
geometry rather than a global baseline preference.

Assess:

- exact shared-boundary/contact potential;
- row upper/lower silhouette complementarity;
- whether NFP/contact computation can be reused cheaply;
- deterministic boundedness;
- whether orientation decisions need limited backtracking;
- risks of greedily improving local contact while harming later pieces.

### C. Protected directional Compact construction cohort

Reuse Compact candidate generation, exact NFP legality, state representation,
checkpointing, and archive mechanics, but give one protected sequential cohort
a lexicographic directional contract:

1. complete/placed material and legality;
2. sufficient short-edge coverage or shortfall bucket;
3. existing intrinsic Compact quality;
4. canonical identity.

Assess:

- how much existing Compact work/checkpoints can be reused;
- whether this can begin from settled archive states or warm prefixes;
- whether it requires new survivor slots;
- how to prevent sheet size from contaminating production Compact;
- how to remain single-process;
- whether this is the first mechanism that truly matches the user’s request.

### D. Target-envelope replay using existing Compact states

Start from already calculated Compact archive/checkpoints and replay or
continue only states likely to fit a directional envelope, without starting
from empty.

Assess:

- whether state continuation contains enough future decision information;
- whether an envelope is a hard feasibility boundary or merely a scheduling
  hint;
- whether multiple target depths are required;
- how to avoid arbitrary area multipliers;
- whether it duplicates previously rejected Stage 2/3 mechanisms.

### E. Other source-backed mechanisms

Derive any stronger candidate from the pinned open-source implementations, but
state precisely:

- what mechanism transfers;
- what objective/terminal semantics must not transfer;
- how it maps to this codebase’s exact geometry and archive authority;
- why it is more than generic inspiration.

## Evaluation criteria

Judge candidates against:

- visual and measurable compactness;
- short-edge coverage;
- exact legality;
- all-piece/material accounting;
- zero cavity regression;
- occupied-hull waste;
- contact components and isolated pieces;
- row-tail waste and unused-slot area;
- maximum side, envelope area, and depth;
- deterministic resume;
- work reuse;
- evaluation count;
- wall time and CPU time;
- peak RSS;
- implementation complexity;
- production Compact isolation;
- single-process execution.

Add explicit metrics that detect the latest failure. Consider, but do not
automatically adopt:

- exact unused rectangular tail area;
- row silhouette gap integral;
- support/contact length normalized by perimeter;
- vertical gap between adjacent row silhouettes;
- family-wide orientation churn;
- count/area of later pieces that geometrically fit earlier tails;
- contact-component and isolated-piece regression;
- occupied hull gap with a strict no-regression or Pareto rule.

Explain which metrics are robust and which can be gamed.

## Required experiment discipline

If you decide implementation is warranted:

1. Do not experiment directly on `main`.
2. Create a normal human-named branch and isolated worktree.
3. Preserve the current `9027aa6` state and pre-tie-break artifacts.
4. Commit every comparable hypothesis before the next one.
5. Store every report, trace, manifest, SVG, and PNG needed for review under a
   clearly named repository path in `docs/artifacts/`. Commit it to the branch.
6. Keep rejected results and document why they failed.
7. Run algorithm cases strictly sequentially.
8. Never benchmark while typecheck/lint or another algorithm run is active.
9. Render SVGs with:
   `.agents/skills/render-svg-with-electron/scripts/render-svg.cjs`
10. Open every relevant PNG at original detail.

Do not merge or push a new algorithm solely because automated gates pass.
Visual review is now a first-class promotion gate.

## Mandatory baseline matrix

The production gate contains nine Compact cases and nine Short Side cases:

- Triangle-20:
  - `2000 x 2700`
  - `600 x 400`
  - `300 x 300`
- Mixed-61:
  - `2000 x 2700`
  - `600 x 400`
  - `300 x 300`
- Shapes-17:
  - `2000 x 2700`
  - `600 x 400`
  - `300 x 300`

Any promotable result must:

- preserve every production Compact canonical hash and count;
- produce nine honest Short Side outcomes;
- have zero directional misses unless the experiment is explicitly rejected;
- remain single-process sequential;
- archive JSON, SVG, PNG, manifest, and checksums;
- be inspected visually one by one.

The targeted Mixed-61 `2000 x 2700` candidate must at minimum:

- retain all `61/61` pieces;
- remain canonical-exact and q0/q90 legal;
- retain zero cavities;
- keep short-edge fill at least `0.993888`;
- strictly improve depth below `301.187 mm` or envelope area below
  `598,692.290112 mm²`, unless you justify a much stronger contact/hull
  improvement with no practical space regression;
- not regress the pre-tie-break hull/contact metrics;
- show a visible reduction of the repeated void pattern;
- avoid simply moving the little rectangles to a different useless tail.

Require two deterministic reproductions before the full matrix.

## Validation

After any development cycle:

```sh
pnpm lint:fix
pnpm typecheck
```

Run focused tests and the relevant strict production gates. Do not claim the
full suite is green unless it actually is; distinguish unrelated existing
failures from regressions with evidence.

## Documentation

Any meaningful implementation or architecture decision must update:

- the relevant architecture explanation;
- short-side research/history;
- active roadmap;
- production gate documentation;
- accepted/rejected artifact README;
Explicitly record the `9193f26` stable-baseline rule as a rejected experiment:
it preserved envelopes but degraded interlocking quality.

## Portable artifact and link rules

The user will review the work from another operating system and another
machine. Therefore:

- never put required evidence, screenshots, SVGs, PNGs, reports, traces, or
  manifests in `/tmp`, `/private/tmp`, a home directory, a desktop directory,
  or any other machine-local location;
- never use `file://`, editor-specific URLs, macOS paths, Windows paths, Linux
  home paths, or absolute filesystem links in the pull request or docs;
- use repository-relative Markdown links only;
- put all reviewable evidence under `docs/artifacts/`;
- put durable design/research explanations under `docs/`;
- verify every linked file is committed and visible in the pushed branch;
- include direct repository-relative links to the most important PNGs in the
  pull-request description;
- do not claim visual validation without committing the exact PNGs that were
  inspected.

## Your required response before broad implementation

Return:

1. a concise diagnosis tied to exact code and artifact evidence;
2. an honest assessment of whether the current shelf concept can ever satisfy
   “Compact plus short-side fill”;
3. a ranked comparison of the candidate architectures above;
4. the smallest experiment capable of falsifying your preferred direction;
5. explicit promotion and stop gates;
6. expected code reuse versus genuinely new code;
7. expected runtime/memory risk;
8. whether `9193f26` should be reverted immediately;
9. a phased implementation plan if and only if the evidence supports it.

Then act autonomously only within the selected narrow experiment. Stop on a
failed or ambiguous measurement. Do not expand from a weak result into a broad
rewrite.

The success condition is not “the matrix says pass.” It is:

> The Short Side result visibly and measurably retains Compact-like
> interlocking while filling the short edge, with exact legality, deterministic
> single-process execution, protected production Compact, and no cold restart.
