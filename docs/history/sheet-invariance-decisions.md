# Sheet-Invariance Decision History

This is a historical decision record. Current production behavior is documented
in [`../architecture/irregular-v2-infrastructure.md`](../architecture/irregular-v2-infrastructure.md),
and incomplete forward verification is tracked in
[`../planning/irregular-nesting-roadmap.md`](../planning/irregular-nesting-roadmap.md).

## Original Per-Sheet Failure

The 2026-07-17 corpus at `32c1951` showed that all seven then-tested cases could
change geometry between `1000 x 1700` and `2000 x 2700`. Triangle demonstrated
that equal area is insufficient: one sheet produced a long chain while the
other produced a compact lattice. Mixed-61 showed that a smaller envelope can
still contain worse internal holes.

Trace work at `b750ac0` found two causes:

1. translation-dependent occupied-hull waste differed near floating precision;
   canonicalization at `95de72c` fixed that false split;
2. the first real split then occurred in local fanout, where normalized sheet
   axes changed the rank of the same legal candidate and pruned a useful branch.

Candidate L confirmed that intrinsic ranking can reduce divergence, but its
standalone Triangle regression prevented promotion.

## Protected Ordinary-Decoder Experiments

Boundary-anchor, intrinsic-contact, and Pareto-frontier lanes recovered better
ordinary-decoder branches without consuming production beam capacity. The
best historical protected checkpoint on `2000 x 2700` was
`430,344.917527 mm2`, two sheet-space holes, and `53/14` structural contacts.
Other roomy sheets still produced different hashes.

Forced-lineage and canonicalized-legacy experiments established a scoped
blocker: the historical reference motif depended on locally dominated branches
preserved by a sheet-relative trajectory. Making that same independent
per-sheet decoder intrinsic destroyed the trajectory. This was a search-tree
reachability result, not a legality impossibility.

Evidence:

- [`../research/sheet-invariance-mechanism-arc-and-blocker.md`](../research/sheet-invariance-mechanism-arc-and-blocker.md)
- [`../artifacts/protected-pareto-frontier-lane/`](../artifacts/protected-pareto-frontier-lane/)

## Retired Fixed-Reference Handoff

Commit `48054f7` introduced a second protected decode on a fixed
`2000 x 2700` sheet. Later hardening through `ac32e94` checked q0/q90 fit and
exact overlap on the requested sheet and used a sheet-free topology
certificate for admission.

At the historical ten-sheet checkpoint `5186255`, all tested requests selected
the same hash at `430,344.917527 mm2`, two holes, and `53/14` contacts. The nine
non-reference requests took about `70.4-89.3 s`; reference reuse took about
`40.1 s`. This evidence justified the then-current `120 s` worker timeout.

That result belongs only to the retired coordinator. The complete report,
manifest, ten SVGs, and ten PNGs remain as immutable historical evidence under
[`../artifacts/canonical-reference-decode-handoff/`](../artifacts/canonical-reference-decode-handoff/).

## Archive-Only Production

The shared-archive line replaced coordination between requested and fixed
sheets with sheetless construction and ranking:

- `4831035` established a common exact archive;
- `fa9ab29` restored the Triangle witness through bounded source admission;
- the cold `P2 + axis-union` allocation found the current smaller Mixed
  endpoint;
- `8b0fba4` removed the fixed-reference coordinator and schema flag and made
  the shared archive the Compact quality path;
- `f33831f` merged the integration, recorded on `main` by `b506344`.

Current one-sheet baselines are Triangle `74,428.143126 mm2`, Mixed
`391,605.850174 mm2`, and Shapes-17 `304,499.845650 mm2`, all with zero
canonical occupied-union cavities. These are not the fixed-reference results.

## Current Evidence Limit

Fresh archive-only production decodes on `900 x 1800` and `1000 x 1300`
produced byte-identical SVGs with SHA-256 `febad20a...`. The full matrix was
cancelled before completion and no durable complete report was produced.

Therefore:

- the architecture is sheetless through archive ranking;
- the two completed current decodes are positive evidence;
- current ten-sheet invariance remains unproven;
- the retired ten-sheet artifact set cannot be cited as proof of the current
  implementation.

The next gate is the complete current matrix described in the roadmap, with
requested-sheet q0/q90 fit separated from sheetless selection.
