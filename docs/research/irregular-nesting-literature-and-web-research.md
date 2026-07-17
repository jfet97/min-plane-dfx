# Source-first research report: irregular 2D nesting objectives and search strategies

Date: 2026-07-17

## Scope

This report investigates algorithms relevant to the current `min-plane-dfx` failure mode: a deterministic beam that ranks structural shared-boundary contact before whole-layout compactness can preserve contact-rich chains or separated contact clusters while discarding layouts that use the sheet materially better.

Only primary or upstream sources are used below: current upstream repositories and source code, official project documentation, and papers. The source inspection was bounded to methods that could plausibly work for roughly 10–100 pieces in a desktop application.

Two upstream source snapshots were inspected directly:

- Sparrow commit [`961ec31f576c5817ece779ff73982b4553760a4e`](https://github.com/JeroenGar/sparrow/tree/961ec31f576c5817ece779ff73982b4553760a4e)
- PackingSolver commit [`3d8d97dd8ae5ac46f08328636f5e168283282ebc`](https://github.com/fontanf/packingsolver/tree/3d8d97dd8ae5ac46f08328636f5e168283282ebc)

## Main conclusion

The current strict structural-contact-first comparator is not supported by the strongest source-backed approaches inspected here. Contact is useful for generating placements, recognizing repeated motifs, or breaking near-ties. It is not a sufficient global layout objective.

The central mathematical problem is straightforward:

- total internal contact is unchanged when disconnected contact components are translated farther apart without changing their internal contacts;
- therefore it cannot measure the empty space between components;
- a strict lexicographic comparison lets one additional contact dominate an arbitrarily worse envelope, hull, span, or leftover;
- even a connected contact graph can form a long one-dimensional chain.

The most defensible near-term production direction is therefore:

1. make global envelope/material use the final authority;
2. retain contact-oriented states through explicit beam diversity or a bounded tolerance, rather than letting contact dominate without limit;
3. run a small, deterministic post-construction compaction or repair pass;
4. add optional periodic/motif candidates for high-multiplicity identical shapes;
5. keep multiple orderings or guide policies in a fixed total budget.

This is not a request to remove contact. It is a request to put contact in the role the evidence supports.

## What current upstream solvers actually optimize

### Sparrow: shrink the global container, then repair feasibility

Sparrow is paired with Gardeyn, Vanden Berghe, and Wauters, [“An open-source heuristic to reboot 2D nesting research”](https://arxiv.org/abs/2509.13329), DOI [`10.48550/arXiv.2509.13329`](https://doi.org/10.48550/arXiv.2509.13329). The paper describes a decomposition into a sequence of feasibility problems in which collisions are gradually resolved.

The current source makes the separation of concerns concrete:

- `LBFOptimizer::new` sorts the constructive seed by descending `convex_hull_area * diameter`: [`src/optimizer/lbf.rs`, lines 38–58](https://github.com/JeroenGar/sparrow/blob/961ec31f576c5817ece779ff73982b4553760a4e/src/optimizer/lbf.rs#L38-L58).
- `LBFEvaluator::compute_loss` gives a feasible placement the loss `10 * x + y`, so the constructive seed prefers leftmost, then lower positions. It does not rank total shared boundary: [`src/eval/lbf_evaluator.rs`, lines 12–52](https://github.com/JeroenGar/sparrow/blob/961ec31f576c5817ece779ff73982b4553760a4e/src/eval/lbf_evaluator.rs#L12-L52).
- `Explorer::explore` shrinks the strip, attempts separation, stores promising infeasible layouts by collision loss, restores them with biased randomness, and disrupts the order by swapping large items: [`src/optimizer/explore.rs`, lines 21–87](https://github.com/JeroenGar/sparrow/blob/961ec31f576c5817ece779ff73982b4553760a4e/src/optimizer/explore.rs#L21-L87) and [`src/optimizer/explore.rs`, lines 89–238](https://github.com/JeroenGar/sparrow/blob/961ec31f576c5817ece779ff73982b4553760a4e/src/optimizer/explore.rs#L89-L238).
- `Compressor::compress` repeatedly shrinks at a split position and invokes separation, with an adaptive shrink step: [`src/optimizer/compress.rs`, lines 11–79](https://github.com/JeroenGar/sparrow/blob/961ec31f576c5817ece779ff73982b4553760a4e/src/optimizer/compress.rs#L11-L79).
- `Separator::separate` operates several workers with different random orders and selects the best collision-loss result: [`src/optimizer/separator.rs`, lines 72–178](https://github.com/JeroenGar/sparrow/blob/961ec31f576c5817ece779ff73982b4553760a4e/src/optimizer/separator.rs#L72-L178). Guided collision weights are updated in the same module: [`src/optimizer/separator.rs`, lines 223–258](https://github.com/JeroenGar/sparrow/blob/961ec31f576c5817ece779ff73982b4553760a4e/src/optimizer/separator.rs#L223-L258).
- `Tracker` caches the pair collision matrix and adaptive guided-local-search weights: [`src/quantify/tracker.rs`, lines 14–132](https://github.com/JeroenGar/sparrow/blob/961ec31f576c5817ece779ff73982b4553760a4e/src/quantify/tracker.rs#L14-L132).
- `search` combines focused samples, container-wide samples, and coordinate descent: [`src/sample/search.rs`, lines 20–74](https://github.com/JeroenGar/sparrow/blob/961ec31f576c5817ece779ff73982b4553760a4e/src/sample/search.rs#L20-L74).
- `BestSamples` keeps a bounded set and rejects transform-similar samples that are no better: [`src/sample/best_samples.rs`, lines 7–83](https://github.com/JeroenGar/sparrow/blob/961ec31f576c5817ece779ff73982b4553760a4e/src/sample/best_samples.rs#L7-L83).

Practical lesson: the constructive left-bottom rule is merely a seed. The global goal is the shrinking container. Collision resolution is a separate feasibility problem. This architecture avoids pretending that local adjacency is equivalent to used-sheet compactness.

### PackingSolver: portfolio of global guide ratios and scan directions

PackingSolver's current irregular tree search also does not use total shared boundary as its final global score.

- `BranchingScheme::NodeComparator::operator()` defines guide IDs based on guide/envelope area divided by item convex-hull area, AABB area ratios, or profit—not shared boundary: [`src/irregular/tree_search.hpp`, lines 643–727](https://github.com/fontanf/packingsolver/blob/3d8d97dd8ae5ac46f08328636f5e168283282ebc/src/irregular/tree_search.hpp#L643-L727).
- `tree_search` runs a portfolio over guide IDs, scan directions, growth factors, and iterative beam-search configurations: [`src/irregular/tree_search.cpp`, lines 2740–2920](https://github.com/fontanf/packingsolver/blob/3d8d97dd8ae5ac46f08328636f5e168283282ebc/src/irregular/tree_search.cpp#L2740-L2920).
- `Solution::better` compares the actual terminal objective: bin count and leftovers, or used `x_max`/`y_max` for open-dimension cases: [`src/irregular/tree_search.cpp`, lines 2092–2132](https://github.com/fontanf/packingsolver/blob/3d8d97dd8ae5ac46f08328636f5e168283282ebc/src/irregular/tree_search.cpp#L2092-L2132).
- `large_item_first` defines large items by convex-hull area relative to the largest item and solves/fixes them before small items: [`src/irregular/large_item_first.cpp`](https://github.com/fontanf/packingsolver/blob/3d8d97dd8ae5ac46f08328636f5e168283282ebc/src/irregular/large_item_first.cpp).

Practical lesson: a small policy portfolio is normal and useful. It allows globally compact, directionally different, and size-aware branches to survive without forcing all intentions into one brittle lexicographic tuple.

### PackingSolver periodic cells: promising support for repeated shapes, with a caveat

`compute_periodic_packings` enumerates one-item and two-rotation cells from no-fit-polygon boundary candidates, derives horizontal and vertical lattice vectors, and checks neighboring copies: [`src/irregular/periodic_packing.cpp`, lines 395–674](https://github.com/fontanf/packingsolver/blob/3d8d97dd8ae5ac46f08328636f5e168283282ebc/src/irregular/periodic_packing.cpp#L395-L674). The upstream tests are in [`test/irregular/periodic_packing_test.cpp`](https://github.com/fontanf/packingsolver/blob/3d8d97dd8ae5ac46f08328636f5e168283282ebc/test/irregular/periodic_packing_test.cpp).

However, in the inspected snapshot the symbol was not referenced by the production tree search outside its implementation/tests. This is evidence that periodic cells are a legitimate algorithmic building block, not evidence that they already explain PackingSolver's ordinary production quality.

Practical lesson: generate periodic/motif placements as optional beam seeds or macro-candidates when a shape has high multiplicity. Do not force every instance through a repeated-cell solver.

### Jagua-rs: geometry acceleration is a first-class subsystem

The [Jagua-rs upstream repository](https://github.com/JeroenGar/jagua-rs) and Gardeyn et al., [“Decoupling Geometry from Optimization in 2D Irregular Cutting and Packing Problems”](https://doi.org/10.1287/ijoc.2024.1025), DOI `10.1287/ijoc.2024.1025`, describe a dedicated collision engine with hierarchical collision detection, exact-feasibility-preserving simplification, and cheap fail-fast surrogate tests.

Practical lesson: a search that emits hundreds of megabytes of per-candidate trace data and repeatedly executes exact all-pairs geometry is paying for the wrong abstraction boundary. Broad phase, cached pair data, cheap rejection, and bounded diagnostic sampling should be designed independently of the ranking experiment.

## Literature-backed improvement patterns

### Construction followed by explicit compaction or separation

- Gomes and Oliveira, [“Solving Irregular Strip Packing problems by hybridising simulated annealing and linear programming”](https://doi.org/10.1016/j.ejor.2004.09.008), DOI `10.1016/j.ejor.2004.09.008`, use simulated annealing to guide the search and linear programming to compact/separate layouts and generate locally optimized neighborhoods.
- Imamichi, Yagiura, and Nagamochi, [“An iterated local search algorithm based on nonlinear programming for the irregular strip packing problem”](https://doi.org/10.1016/j.disopt.2009.04.002), DOI `10.1016/j.disopt.2009.04.002`, combine overlap minimization, swap moves, nonlinear programming, and iterated local search.
- Umetani et al., [“Solving the irregular strip packing problem via guided local search for overlap minimization”](https://doi.org/10.1111/j.1475-3995.2009.00707.x), DOI `10.1111/j.1475-3995.2009.00707.x`, use guided local search for overlap minimization.
- Umetani and Murakami, [“Coordinate descent heuristics for the irregular strip packing problem of rasterized shapes”](https://arxiv.org/abs/2104.04525), DOI [`10.1016/j.ejor.2022.03.034`](https://doi.org/10.1016/j.ejor.2022.03.034), alternate horizontal and vertical line searches and use guided overlap weights; the method explicitly treats compaction as an improvement phase.
- Cherri et al., [“A model-based heuristic for the irregular strip packing problem”](https://doi.org/10.1590/0101-7438.2016.036.03.0447), DOI `10.1590/0101-7438.2016.036.03.0447`, use three phases: dotted-board construction, variable-neighborhood improvement on progressively finer grids, and continuous local compaction.

Shared lesson: construction and improvement do not need the same score or candidate mechanism. A bounded post-pass is more principled than demanding that every intermediate greedy decision already be globally optimal.

### Fast approximate placement as a metaheuristic building block

Chehrazad, Roose, and Wauters, [“A fast and scalable bottom-left-fill algorithm to solve nesting problems using a semi-discrete representation”](https://arxiv.org/abs/2103.08739), DOI [`10.1016/j.ejor.2021.10.043`](https://doi.org/10.1016/j.ejor.2021.10.043), represent pieces and the strip with equidistant vertical intervals, use a sweep-line construction with conservative extensions, and optimize the order of overlap tests. The reported role is a very fast greedy building block for metaheuristics, not a proof that one bottom-left ordering is enough.

Shared lesson: consider a cheap conservative placement evaluator for broad exploration, followed by exact validation. The current exact geometry can remain the authority.

### Pairwise clustering helps selectively, not universally

Sato et al., [“A Study in Pairwise Clustering for Bi-dimensional Irregular Strip Packing Using the Dotted Board Model”](https://doi.org/10.1016/j.ifacol.2018.08.297), DOI `10.1016/j.ifacol.2018.08.297`, found pairwise clustering beneficial in some tested cases rather than uniformly.

Shared lesson: motif/pair clustering belongs in a portfolio. It should not become another universal hard ranking rule.

### Size/type decomposition is current practice

The current PackingSolver source contains an explicit `large_item_first` strategy. A recent supporting paper, Liu, [“Hierarchical algorithm for large-scale irregular packing problems”](https://doi.org/10.1631/ENG.ITEE.2025.0080), DOI `10.1631/ENG.ITEE.2025.0080`, classifies pieces by area/fullness and applies different box stacking, shape matching, and gravity-packing stages.

Shared lesson: the strange late placement of large rectangles in a mixed fixture is a real search-order concern. Large-first should be one deterministic start in a portfolio, not necessarily the only order and not necessarily a permanently frozen prefix.

## Actionable strategy families

These are ordered from lowest-risk/closest to the existing beam toward larger architectural changes.

### 1. Compactness-authoritative comparator with bounded contact tolerance

Keep unplaced count first. Replace unbounded strict contact dominance with one of the following explicit policies:

- compact envelope/hull first, then structural contact as a near-tie breaker; or
- require a minimum normalized contact density, but compare globally compact states within a deliberately wide contact band; or
- define an epsilon-Pareto relation: a contact gain may dominate only if envelope growth stays below a normalized bound.

Do not use raw millimetres. Normalize by a stable per-instance scale and report the unit in trace output.

Why it may work: it directly fixes the non-implication between internal contact and global compactness while preserving contact among geometrically comparable layouts.

Primary risk: one fixed epsilon may not generalize. It should be tested as a small sweep and rejected if it becomes a hidden fixture separator.

### 2. Quota-based beam diversity with the same total beam width

With beam width 8, retain geometric survivors by role, for example:

- 3 globally compact envelope/hull states;
- 2 contact/motif states;
- 1 short-side or directionally complementary state;
- 2 best remaining nondominated states.

Apply geometry-equivalence deduplication before quota allocation so identical-copy permutations do not consume slots. Terminal selection still uses the true global material-use objective.

Why it may work: PackingSolver's multi-guide, multi-direction portfolio and Sparrow's bounded transform-similar sample set both support preserving distinct search intentions instead of collapsing them into a single strict tuple.

Primary risk: quotas can waste capacity on weak roles. Measure role contribution and allow unused quota to spill into the global pool.

### 3. Bounded deterministic terminal compaction

After the beam completes, run a small fixed budget of alternating horizontal/vertical moves or remove-and-reinsert moves:

- start with frontier pieces, pieces adjacent to large voids, and pieces in singleton/small contact components;
- preserve current orientation in the first pass;
- accept only legal moves that improve the global terminal objective;
- stop after a strict move/evaluation budget, not a wall-clock loop.

Why it may work: construction-plus-compaction is one of the most consistent patterns across the literature. It also targets the user's observed “same structure, avoidable raised/gapped placement” directly.

Primary risk: a broad remove/reinsert neighborhood can explode. Keep it terminal, deterministic, and frontier-limited initially.

### 4. Shrink-and-separate improvement phase

For a stronger second-stage optimizer:

1. shrink the used envelope by a small amount;
2. allow temporary overlaps;
3. minimize weighted pair collision loss with focused coordinate moves;
4. adapt weights for persistent collisions;
5. preserve the best feasible state and restart from bounded disrupted states.

Why it may work: this is the architectural pattern used by Sparrow and guided-overlap local-search papers. It optimizes the actual global container rather than a proxy.

Primary risk: this is a larger implementation and performance project. It should follow, not block, the lower-risk comparator/diversity experiment.

### 5. Optional periodic/motif macro-candidates

For piece types with high multiplicity:

- enumerate one- and two-item contact cells from legal NFP boundary placements;
- derive lattice translations and validate immediate neighboring copies;
- inject good cells as initial beam states or macro-placement candidates;
- let ordinary search place the remainder and mixed types.

Why it may work: it directly represents the repeated triangle lattice without teaching the whole-layout score to prefer every long contact chain.

Primary risk: periodic helpers can overfit identical-piece fixtures and may be expensive for arbitrary rotations. Gate by multiplicity and cap cell enumeration.

### 6. Size-aware ordering portfolio and bounded deferral

Run at least two deterministic construction orders within the same overall budget:

- existing/user-owned order;
- descending convex-hull-area or `area * diameter` order, with a bounded allowance to defer a large item when it materially worsens the envelope.

Do not permanently freeze a bad large-prefix placement; allow terminal repair or one alternative scan direction.

Why it may work: it addresses the mixed fixture's awkward large rectangles and is supported by both Sparrow's seed ordering and PackingSolver's `large_item_first` strategy.

Primary risk: large-first can strand small concave spaces or damage repeated small-shape lattices. That is why it should be a portfolio member and not a universal replacement.

## Recommended experiment sequence

### Phase A: isolate ranking from candidate generation

For every strategy, replay or regenerate the same candidate set where possible. Compare:

1. current strict contact-first;
2. compactness first/contact tie-break;
3. contact-band sweep;
4. epsilon-Pareto contact versus envelope growth;
5. quota-based beam diversity.

If candidate sets differ, label the result clearly. Do not attribute a candidate-generation improvement to the comparator.

### Phase B: add one bounded terminal improvement

Apply the same terminal compaction budget to the best two Phase A strategies. Compare both pre-repair and post-repair output so repair cannot hide a bad beam.

### Phase C: add targeted seeds

Test periodic motif seeds only on high-multiplicity instances and large-first only on mixed-size instances. Neither is a universal gate.

## Deterministic evaluation corpus

Do not select production behavior from two screenshots. A small headless corpus is sufficient to reject brittle strategies:

- the approved 20-identical-triangle fixture;
- both exact 61-piece morning fixtures/traces;
- 10, 20, 50, and 100 identical rectangles;
- 10, 20, and 50 identical trapezoids;
- 10, 20, and 50 identical pentagons/stars;
- mixed 25, 50, 61, and 100-piece fixtures with large/small area ratios;
- repeated-shape mixtures, such as triangles plus rectangles and trapezoids plus small fillers;
- at least one rotation-disabled and one mirroring-disabled variant.

For accepted winners, render and inspect a PNG. Numerical gates should include:

- placed/unplaced count;
- used collision-envelope area, span, and worst normalized sheet consumption;
- occupied-hull waste;
- number of contact components and inter-component envelope gaps;
- contact density, not only total contact;
- obvious fit-capable holes where a remaining/repeated item could be inserted;
- deterministic runtime, candidate evaluations, exact geometry calls, and trace bytes.

The triangle golden should be structural rather than byte-for-byte: all pieces placed, compact lattice, no conspicuous one-triangle holes or long extension, and deterministic bottom-left terminal normalization. A few-percent regression on an easy fixture can be acceptable if it removes a catastrophic fragmented/chain result across harder fixtures; report that as a Pareto trade-off rather than hiding it.

## Performance and trace recommendations

The 800+ MB trace is not merely a storage problem. It can dominate runtime and distort strategy comparisons.

### Trace budget

- preserve step summaries, selected/pruned counts, survivor IDs, terminal scores, and explicit rejection reasons;
- sample or aggregate candidate-level events after a small diagnostic prefix;
- omit repeated polygon arrays and reference canonical geometry/transform IDs instead;
- impose byte and event budgets with an explicit `trace_truncated` summary;
- validate that history-off and bounded-history modes produce identical winners.

### Geometry/search hot path

- keep an incremental spatial broad phase;
- cache pair collision/NFP results by canonical piece type, transform, and relative configuration where valid;
- use cheap AABB/surrogate failure before exact polygon tests;
- deduplicate transforms and geometry-equivalent beam states before expensive scoring;
- update envelope, contact, and pair contributions incrementally rather than rebuilding whole-layout metrics;
- profile history-off first, then optimize only measured hot paths.

The Jagua-rs collision-engine split and Sparrow's cached pair tracker are strong source-backed references for this work. A raster/semi-discrete broad evaluator is a longer-term option if exact geometry remains the bottleneck after ordinary caching and broad-phase fixes.

## Concrete recommendation for `min-plane-dfx`

The next production candidate should combine three small changes, evaluated independently and together:

1. geometry-equivalent beam deduplication for identical copies;
2. a fixed-width role-diverse beam whose terminal authority is global envelope/material use;
3. a bounded deterministic terminal compaction pass.

Then add two optional portfolio seeds:

- a large-first order for mixed-size instances;
- a periodic two-item/motif seed for high-multiplicity identical shapes.

This combination is more general than a fixture-specific conditional separator. If the corpus still shows a clear failure frontier, an epsilon/contact-density guard can be introduced with its measured Pareto table and explicit semantics.

The larger Sparrow-style shrink-and-separate optimizer is the strongest longer-term route if the existing legal-placement beam reaches a quality ceiling. It should be treated as a separate improvement architecture, not layered into the current comparator as more scoring fields.

## Source index

- Gardeyn, Vanden Berghe, Wauters: [An open-source heuristic to reboot 2D nesting research](https://arxiv.org/abs/2509.13329), DOI [`10.48550/arXiv.2509.13329`](https://doi.org/10.48550/arXiv.2509.13329)
- [Sparrow upstream source](https://github.com/JeroenGar/sparrow)
- [PackingSolver upstream source](https://github.com/fontanf/packingsolver)
- Gardeyn et al.: [Decoupling Geometry from Optimization in 2D Irregular Cutting and Packing Problems](https://doi.org/10.1287/ijoc.2024.1025), DOI `10.1287/ijoc.2024.1025`
- [Jagua-rs upstream source](https://github.com/JeroenGar/jagua-rs)
- Gomes, Oliveira: [Hybrid simulated annealing and linear programming](https://doi.org/10.1016/j.ejor.2004.09.008), DOI `10.1016/j.ejor.2004.09.008`
- Imamichi, Yagiura, Nagamochi: [Iterated local search based on nonlinear programming](https://doi.org/10.1016/j.disopt.2009.04.002), DOI `10.1016/j.disopt.2009.04.002`
- Umetani et al.: [Guided local search for overlap minimization](https://doi.org/10.1111/j.1475-3995.2009.00707.x), DOI `10.1111/j.1475-3995.2009.00707.x`
- Umetani, Murakami: [Coordinate descent heuristics for rasterized shapes](https://arxiv.org/abs/2104.04525), DOI [`10.1016/j.ejor.2022.03.034`](https://doi.org/10.1016/j.ejor.2022.03.034)
- Cherri et al.: [A model-based heuristic for the irregular strip packing problem](https://doi.org/10.1590/0101-7438.2016.036.03.0447), DOI `10.1590/0101-7438.2016.036.03.0447`
- Chehrazad, Roose, Wauters: [Fast scalable bottom-left-fill with semi-discrete representation](https://arxiv.org/abs/2103.08739), DOI [`10.1016/j.ejor.2021.10.043`](https://doi.org/10.1016/j.ejor.2021.10.043)
- Sato et al.: [Pairwise clustering with the dotted-board model](https://doi.org/10.1016/j.ifacol.2018.08.297), DOI `10.1016/j.ifacol.2018.08.297`
- Liu: [Hierarchical algorithm for large-scale irregular packing problems](https://doi.org/10.1631/ENG.ITEE.2025.0080), DOI `10.1631/ENG.ITEE.2025.0080`
