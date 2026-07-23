# Shapes-17 Baseline

This fixture preserves the 17 DXF files and job CSV supplied as the third
irregular search baseline beside Triangle-20 and Mixed-61. Every DXF imports as
one closed source outline without warnings. The run uses the shared roomy
`2000 x 2700 mm` sheet, `10 mm` padding, compact-quality settings, repair
disabled, and the three sheet-free direct archive roles.

The selected `legacy-absolute-envelope` endpoint is:

- envelope area: `304,499.845650 mm2`;
- maximum side: `559.975 mm`;
- enclosed cavities: `0`;
- canonical geometry hash:
  `c640c06f662050f8a132168f63988c40ba41f2ebc57dc50277a91119b4b4980a`;
- source commit: `8f84f8124ac3254e58a45d75b6c5d0f87df91d71`;
- fixture digest:
  `1b4b29b54a1e29c0b923e81e3e19166767432747c376481907f186dee4e0b84b`.

A second clean run at the same commit reproduced every direct role's status,
evaluation count, endpoint hash, archive order, selected winner, and the exact
SVG SHA-256 `067591d5f868c2d45cca4cc354160f9a28e230b9afac39118a844d3bce44266d`.

All three direct roles completed. The full periodic matrix is intentionally not
the acceptance path for this all-distinct fixture: it discovers zero repeated-
family periodic sources, while the current matrix contract requires exactly
eight. This is a useful domain distinction, not a search failure.

The initial run also exposed a valid-circle exactness bug. A full circle's
analytic final sample can differ infinitesimally from its first sample and then
quantize to the same Clipper2 grid point. The offset adapter now removes only
adjacent and closing grid duplicates before strict path validation; genuinely
collapsed polygons still fail the existing three-unique-vertex guard.

Artifacts:

- `report.json`: complete direct-run metrics and provenance;
- `manifest.json`: immutable artifact hashes;
- `shapes-17-shared-archive-winner.svg`: exact selected layout;
- `shapes-17-shared-archive-winner.png`: complete Chromium render.
