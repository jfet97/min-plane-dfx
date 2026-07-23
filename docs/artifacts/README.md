# Irregular Nesting Artifacts

This tree preserves portable manifests, reports, SVGs, and PNG renders for
accepted and rejected experiments. Metrics belong to the commit and status
named by each artifact set; most are historical and are not current production
baselines.

## Current Production Evidence

- [`current-compact-baselines/`](./current-compact-baselines/): complete,
  Chromium-rendered PNG, SVG, and JSON evidence for the six durable Compact
  baselines: Triangle-20, Mixed-61, and Shapes-17 on both `2000 x 2700` and
  `600 x 400`.
- [`intrinsic-capacity-v1/`](./intrinsic-capacity-v1/): constrained-sheet
  capacity gate evidence — sheet-outline SVG/PNG renders of representative
  exact partial layouts, the combined strict `gate:capacity` report with full
  capacity traces, and the artifact manifest.
- [`current-production-invariance-sample/`](./current-production-invariance-sample/):
  two completed archive-only production decodes from `b506344`. Their SVGs are
  byte-identical, but the full sheet matrix was cancelled and remains unproven.
- [`intrinsic-shared-archive-quality/`](./intrinsic-shared-archive-quality/):
  archive-quality calibration that established the current Triangle-20 and
  Mixed-61 area floors before production integration.
- [`shapes-17-baseline/`](./shapes-17-baseline/): the all-distinct Shapes-17
  archive baseline.

The executable current gates, including the fitted Mixed production hash, are
documented in
[`../operations/irregular-production-gates.md`](../operations/irregular-production-gates.md).

## Shared-Archive and Periodic Research

- [`deterministic-periodic-budget/`](./deterministic-periodic-budget/)
- [`periodic-audit-speed/`](./periodic-audit-speed/)
- [`intrinsic-shared-archive-step4/`](./intrinsic-shared-archive-step4/)
- [`v7-search-redesign/`](./v7-search-redesign/)

These sets preserve source-survival, deterministic-budget, performance, and
archive-selection evidence, including rejected or non-production endpoints.

## Historical Ordinary-Decoder Research

- [`candidate-l-audit/`](./candidate-l-audit/)
- [`candidate-l-recombination/`](./candidate-l-recombination/)
- [`beam-topology-diversity/`](./beam-topology-diversity/)
- [`bounded-ga-order-rotation/`](./bounded-ga-order-rotation/)
- [`small-piece-gap-diversity/`](./small-piece-gap-diversity/)
- [`protected-boundary-anchor/`](./protected-boundary-anchor/)
- [`protected-intrinsic-contact-seed/`](./protected-intrinsic-contact-seed/)
- [`protected-pareto-frontier-lane/`](./protected-pareto-frontier-lane/)

The protected-lane artifacts remain useful causal evidence for the ordinary
requested-sheet decoder. They are not accepted Compact quality production
outputs at `b506344`.

## Retired Fixed-Reference Handoff

[`canonical-reference-decode-handoff/`](./canonical-reference-decode-handoff/)
preserves the immutable ten-sheet result from commit `5186255`: area
`430,344.917527 mm2`, two sheet-space holes, and `53/14` structural contacts.
That evidence belongs to the deleted fixed-reference coordinator and must not
be used to claim current archive-only ten-sheet invariance.

## Provenance Notes

Artifact manifests are immutable run records. A manifest may retain an original
`help/artifacts/...` source path or `/private/tmp/min-plane-provenance/...` path
because changing it would falsify the recorded run. Documentation links use the
current `docs/artifacts/` location.

The topic-level interpretation lives in
[`../history/search-quality-decisions.md`](../history/search-quality-decisions.md)
and [`../history/sheet-invariance-decisions.md`](../history/sheet-invariance-decisions.md).
