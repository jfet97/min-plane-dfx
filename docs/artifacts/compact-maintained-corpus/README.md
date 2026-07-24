# Maintained Compact corpus

This directory is the portable P2 evidence captured from the committed
measurement harness on 2026-07-24.

- `inventory.json` freezes the included and excluded cases before search,
  including exact sources, prepared order, settings, and expected sheet
  classification.
- `reproduction.json` compares two sequential current-source reproductions.
- every included case has an SVG and Electron-rendered PNG for both
  `1000 x 1700` and `2000 x 2700`.
- `checksums.sha256` covers every retained evidence file except itself.

All seven cases are complete and canonical-identical between the two roomy
sheets and between both reproductions. The corresponding sheet-pair SVGs and
PNGs are byte-identical.

Raw timing logs and reports remain under
`/private/tmp/min-plane-provenance/compact-maintained-corpus/0ca9ad6/`.
