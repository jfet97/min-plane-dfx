# Accepted Contact-Strip Short-Side Matrix

This is the current-source 18-layout production gate: nine Compact controls and
nine Short Side profile outputs, each with JSON, SVG, and PNG evidence, a
provenance manifest, verified `SHA256SUMS`, and an individual visual review in
[`VISUAL_REVIEW.md`](./VISUAL_REVIEW.md). The profile is now schema-backed and
selectable through the production UI; both profiles still execute through one
sequential algorithm worker.

## The targeted case

Mixed-61 `2000 x 2700` is the layout the user rejected. It is the only
short-side layout that changed.

- rejected AABB shelf:
  [PNG](./comparison/mixed-61-2000x2700.rejected-shelf.png) ·
  [SVG](./comparison/mixed-61-2000x2700.rejected-shelf.svg)
- accepted contact strip:
  [PNG](./comparison/mixed-61-2000x2700.accepted-contact-strip.png) ·
  [SVG](./comparison/mixed-61-2000x2700.accepted-contact-strip.svg)

| Measurement | Rejected shelf | Accepted contact strip |
| --- | ---: | ---: |
| bounds | `1987.776 x 301.187 mm` | `2000.000 x 207.700 mm` |
| envelope area | `598,692.290112 mm2` | `415,400.000000 mm2` |
| long-axis depth | `301.187 mm` | `207.700 mm` |
| short-edge fill | `99.3888%` | `100.0000%` |
| collision-envelope density | `52.3621%` | `75.4664%` |
| occupied-hull gap | `0.4325051759018452` | `0.2150884212578726` |
| isolated pieces | `39` | `28` |
| largest contact component | `8` | `12` |
| shared boundary | `0 mm` | `1356.501 mm` |
| pieces | `61/61` | `61/61` |
| enclosed cavities | `0` | `0` |

In the accepted layout the triangles and trapezoids alternate up and down into
each other and the small rectangles sit inside the notches between triangles,
which is what the rejected screenshot was missing.

## Isolation

Every production Compact canonical collision hash, fitted hash, placed/unplaced
partition, area ceiling, and cavity gate is byte-identical to
[`../matrix/`](../matrix/). Eight of the nine Short Side layouts are also
identical. In the Short Side profile, the guarded observer and terminal
construction lanes may select the returned legal layout; ordinary Compact
remains the default profile and retains its exact established output.

## Reproduction

The recorded final-source run at source commit `2f308bb` used
`pnpm gate:compact-nine-baselines` and reproduced the established canonical
collision and fitted hashes for all 18 layouts. Earlier development runs
produced the same geometry; their trace bookkeeping is not part of this
archive.

The recorded run executed 18 production requests strictly sequentially—one
Compact and one persisted Short Side request for each fixture/sheet pair—with
at most one algorithm process active. Each report also verifies the worker
strategy identity. `manifest.json` identifies the exact source commit and
portable reproduction command.

## Rejected constructions retained

Triangle-20 and Shapes-17 on `2000 x 2700` keep their historical sources. Their
contact strips were constructed and measured, then rejected by the strict
no-regression rule:

| Fixture | Strip result | Why rejected |
| --- | --- | --- |
| Triangle-20 | `924.666 x 76.262 mm`, `94.7458%` density, `0.006194` hull gap | fills only `46.2333%` of the short edge, below the directional admission floor |
| Shapes-17 | `1990.872 x 212.128 mm`, `99.5436%` fill | density falls to `49.8095%` and hull gap rises to `0.353270` against the pair fold's `50.2790%` and `0.204224` |

Both remain readable in each case's
`intrinsicShortSidePairFoldTrace.contactStripPromotion.contactStripSummary`.

## Renderer

PNGs were produced with the repository Electron/Chromium renderer and inspected
one by one. `manifest.json` records the exact renderer and source commit.
