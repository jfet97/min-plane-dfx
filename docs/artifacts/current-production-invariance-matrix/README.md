# Current Production Invariance Matrix

This is the accepted ten-sheet Mixed-61 invariance evidence from `main` at
`6179cefec8548395e075df2d0da6c09532a20953` on 2026-07-24. Two independent
strict invocations completed every requested sheet without censoring.

Both runs placed all `61/61` pieces on every sheet and returned:

- canonical geometry SHA-256
  `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`;
- occupied envelope area `391,605.850174 mm2`;
- zero canonical enclosed cavities;
- byte-identical normalized SVG SHA-256
  `febad20a8357356edb383086591e3f3f6d455e1efe8d06ec2ce0b04856b6582c`.

| Sheet |
| --- |
| `900 x 1800` |
| `1000 x 1300` |
| `1000 x 1700` |
| `1100 x 1100` |
| `1200 x 1600` |
| `1400 x 1100` |
| `1500 x 2200` |
| `1700 x 1000` |
| `2000 x 1700` |
| `2000 x 2700` |

The first run took `695.18 s` wall and the second took `701.04 s` wall. Their
per-sheet algorithm times ranged from `68.15 s` to `72.32 s`. Maximum resident
set size was `1,051,525,120` bytes and `1,284,128,768` bytes respectively.

[`run-1-report.json`](./run-1-report.json) and
[`run-2-report.json`](./run-2-report.json) contain the exact per-sheet metrics.
Each sheet also has an SVG and a full Electron-rendered PNG. Every SVG is
byte-identical, every PNG is byte-identical, and the inspected render has
visible margin on all four sides with no clipping.

The exact command was:

```sh
pnpm corpus:sheet-invariance \
  --case mixed-61 \
  --sheets 900x1800,1000x1300,1000x1700,1100x1100,1200x1600,1400x1100,1500x2200,1700x1000,2000x1700,2000x2700 \
  --strict \
  --output <immutable-output-directory>
```

Environment: macOS `26.5.2` (`25F84`), Node `24.16.0`, pnpm `11.8.0`.
