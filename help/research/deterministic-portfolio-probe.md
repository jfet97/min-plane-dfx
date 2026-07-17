# Deterministic Portfolio Probe

Date: 2026-07-17  
Branch: `deterministic-portfolio-probe`  
Base: `be19e75c090c201191b5dd3ee9b4b99d3798fa8a`  
Corpus-harness commit: `f0d974f`  
Experiment commit: `2203fb5`

## Hypothesis

Keep the accepted local placement scorer and beam width unchanged, disable local
repair, and evaluate three bounded deterministic alternatives beside the baseline:

1. interleave the smallest quarter of pieces through the large-first order;
2. round-robin shape families while preserving order within each family;
3. distribute the first four transform orientations within identical-shape families.

Every alternative uses the existing beam decoder. The existing whole-layout
comparator chooses the final result. The feature is opt-in and off by default.

## Result

Rejected for direct production use at the first current gate. The official
triangle golden remains green while the feature is disabled, but the opt-in,
repair-free four-sheet triangle corpus is not sheet invariant and does not
preserve the accepted compact lattice.

| Sheet (mm) | Bounds (mm) | Area (mm2) | Span (mm) | Contacts | Holes | Geometry hash |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1000 x 1300 | 151.350 x 529.728 | 80,174.333 | 681.078 | 19 | 1 | `d0f2b271...0433b` |
| 1000 x 1700 | 151.350 x 529.728 | 80,174.333 | 681.078 | 19 | 0 | `3267a68b...66d8` |
| 2000 x 1700 | 485.584 x 151.350 | 73,493.138 | 636.934 | 23 | 0 | `c82fe9fb...a65d` |
| 2000 x 2700 | 227.025 x 441.440 | 100,217.916 | 668.465 | 22 | 0 | `b1f48443...ed05` |

The 1000 x 1700 result is visibly a tall two-column strip. The four canonical
geometry hashes differ, so this is not a presentation-only rotation or translation.

The mixed61, mixed50, and homogeneous corpus gates were deliberately not run after
this failure. Their roughly four complete beam decodes per sheet could not make
this standalone implementation production-ready once it failed the current
triangle gate.

## Validation

- Type checking passed.
- Focused portfolio, schema-contract, and official triangle-golden tests passed:
  31 tests total.
- The opt-in repair-free triangle corpus completed all four sheet variants and
  reported `geometryEquivalent: false`.

## Provenance

The immutable experiment report SHA-256 is
`2f88fe945257157a31301c9507fdac4b0d8bd2c5931b83a7e5112bd1ac725cbc`.

Representative 1000 x 1700 artifact hashes:

- SVG: `2c69b6409029d9c609c6264b1f2ee7d117ac5903e60cccad7c1a0bc51980d958`
- PNG: `aefbf3f412a7b0f8752dfcf33a6b7d4457d6e3317024d97f893fe78f024b4809`

## Conclusion

Bounded order and orientation diversity by itself is not the missing mechanism.
It preserves the current scorer but still starts from sheet-dependent local beam
branches. A global winner chosen from four such branches cannot restore a compact
branch that none of them retained. Do not merge this implementation unchanged.
Keep its exact commit as a research input for combinations with intrinsic local
ranking or a decoder that retains stronger geometric diversity.
