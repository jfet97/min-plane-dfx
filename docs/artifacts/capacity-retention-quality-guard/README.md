# Capacity Retention Quality Guard

Accepted source: `62e5c1913a9dc02685a81d75cc7ae509aed962c9`.

The two production layouts below are exact canonical-legal results from the
strict sequential paired capacity gate:

| Fixture | Placed | Output SHA-256 | Prefix | Quality endpoint |
| --- | ---: | --- | ---: | --- |
| Mixed-61 `700 x 500` | 50/61 | `97dbc502...` | canonical 15 | `0c98259d...` |
| Mixed-61 `700 x 560` | 59/61 | `36cee348...` | canonical 30 | `2d252e35...` |

Each PNG was rendered from the adjacent complete SVG with the repository
Electron renderer and visually checked for margins and truncation:

- [`capacity-mixed61-700x500-production.svg`](./capacity-mixed61-700x500-production.svg)
  and [`PNG`](./capacity-mixed61-700x500-production.png);
- [`capacity-mixed61-700x560-production.svg`](./capacity-mixed61-700x560-production.svg)
  and [`PNG`](./capacity-mixed61-700x560-production.png).

[`matrix-18/summary.json`](./matrix-18/summary.json) and the adjacent 18 SVGs
record the post-change Compact/Short Side gate. All 18 accepted layouts passed
without a canonical, accounting, area, cavity, scheduler, or profile change.
The matrix ran with `--skip-png`; the flag affects rendering only.

The complete immutable paired reports, manifests, and checksums remain under:

```text
/private/tmp/min-plane-provenance/capacity-retention-quality-guard/
  quality-warm-prefix-scaled-full-paired/
  quality-warm-prefix-scaled-matrix-18/
```

Key portable artifact hashes:

```text
c5d74530723aecc2d816b9386f14bd652ce27e7bde89ce099a004477552581b8  capacity-mixed61-700x500-production.svg
aa0fd30b9c2d57c0fcf4373a30a27a891325045ee0305e27b348a052c7fd5001  capacity-mixed61-700x500-production.png
231b7cb79bf379eb9d04da8ff433a13a0204dffeda54b20247e5ff67c1f7f9b3  capacity-mixed61-700x560-production.svg
082f4ea8a4e4afcfce2bfc1eb7dea22a6148040e06eb11140daa9e650194937a  capacity-mixed61-700x560-production.png
c99c0fd5e88acf15d032d1441616b7b8f6e4b0a05bfd14f9f031b3f01c408df8  matrix-18/summary.json
```
