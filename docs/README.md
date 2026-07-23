# Documentation

Use this page as the documentation entry point. Current behavior and forward
work are deliberately separated from historical evidence.

## Current System

- [Architecture](./architecture.md): process ownership and the top-level
  computation pipeline.
- [Architecture index](./architecture/index.md): focused pages for Effect,
  persistence, schemas, UI, algorithm ownership, and irregular nesting.
- [Irregular production gates](./operations/irregular-production-gates.md):
  current exact baselines, acceptance checks, provenance, and the incomplete
  sheet-invariance gate.
- [Irregular nesting roadmap](./planning/irregular-nesting-roadmap.md): the one
  active forward roadmap.

## Decisions and Evidence

- [Decision history](./history/README.md): production transitions, search
  quality decisions, sheet-invariance history, historical prompts, and reviews.
- [Research index](./research/index.md): detailed experiment reports, source
  studies, and negative results.
- [Artifact index](./artifacts/README.md): portable manifests, reports, SVGs,
  and rendered evidence.

## Reading Order for Irregular-Nesting Work

1. Read [Irregular V2 Infrastructure](./architecture/irregular-v2-infrastructure.md)
   for the current archive-only Compact quality path and the ordinary-decoder
   boundary.
2. Read the [production gates](./operations/irregular-production-gates.md) for
   exact current claims and evidence limits.
3. Read the [roadmap](./planning/irregular-nesting-roadmap.md) for still-open
   work.
4. Consult history, research, and artifacts only when the decision provenance
   or a prior failure mechanism matters.

Historical documents retain the metrics and terminology of their named commit.
They are not current production specifications unless they explicitly say so.
