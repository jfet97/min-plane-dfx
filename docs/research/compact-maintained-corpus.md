# Maintained Compact corpus

## Purpose

P2 converts the wider representative fixture set into a current, reproducible
Compact gate without treating stale historical hashes as production truth. It
changes no search, allocation, ranking, candidate generation, or fit behavior.

## Inventory boundary

Commit `0858ebe42b88d79d3b532129707c877f35d93f3e` adds an inventory-only
mode to the existing no-options sheet-invariance harness. Commit
`0ca9ad6e047ebed8500af97825fc52d0f6ba963d` freezes the inventory before
the first search run.

The inventory records both immutable request order and the actual production
prepared order after `sortPiecesForNesting`. These are separate fields because
mixed generated recipes are not already sorted by the production comparator.

The maintained set contains seven existing exact requests:

| Case | Pieces | Source |
| --- | ---: | --- |
| Triangle golden | 20 | generated `70 x 60 mm` triangles |
| Rectangles | 20 | generated `154 x 104 mm` rectangles |
| Trapezoids | 20 | generated `100 x 75 x 60 mm` trapezoids |
| Pentagons | 20 | generated `90 x 90 mm` pentagons |
| Star hulls | 20 | generated `90 x 90 mm` star collision hulls |
| Mixed-50 | 50 | fixed round-robin generated recipe |
| Mixed-61 | 61 | persisted exact request |

Curved and scale-diverse historical cases remain excluded because the
no-options harness has no exact current request for them. Shapes-17 and the
constrained cases remain under the separate nine-case gate; the ten historical
Mixed-61 aspect-ratio sheets remain under their separate standing gate.

## Reproduction

Two sequential strict runs used the committed no-options harness on
`1000 x 1700` and `2000 x 2700`. Both runs completed all 14 layouts:

| Case | Canonical hash | Area mm2 | Cavities |
| --- | --- | ---: | ---: |
| Triangle golden | `b4d1fd9a...` | 74,428.143126 | 0 |
| Rectangles | `c6cdd138...` | 376,727.320320 | 0 |
| Trapezoids | `1b64d187...` | 194,388.213760 | 0 |
| Pentagons | `51326c21...` | 230,438.597040 | 0 |
| Star hulls | `51326c21...` | 230,438.597040 | 0 |
| Mixed-50 | `3726e499...` | 543,814.047975 | 1 |
| Mixed-61 | `ef2b783a...` | 391,605.850174 | 0 |

Every case placed all requested pieces. For each case, both sheets and both
runs have identical canonical hashes, envelope areas, and placed/unplaced
counts. The retained sheet-pair SVG and PNG files are also byte-identical.

Run 1 took `418.84 s` wall, `439.01 s` user CPU, and `949,288,960` bytes
maximum RSS. Run 2 took `424.30 s` wall, `443.82 s` user CPU, and
`954,531,840` bytes maximum RSS.

## Decision

Accept P2 as a standing measurement gate. Its inventory, reproduction summary,
checksums, SVGs, and full Electron PNGs are in
[`../artifacts/compact-maintained-corpus/`](../artifacts/compact-maintained-corpus/).
The nine-case and ten-sheet gates remain separate and authoritative for their
own scopes.
