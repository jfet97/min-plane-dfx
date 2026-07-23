# Intrinsic pinned-lane targeted falsifiers

- source commit: `648a93e44d6ee47ece407a4a982fe209ffb0f216`
- branch: `intrinsic-anytime-portfolio`
- runtime: Darwin arm64 25.5.0, Node v24.16.0, pnpm 11.8.0
- cases: Triangle-20 `300x300`, Mixed-61 `700x500`, Mixed-61 `700x560`
- settings: Compact quality defaults; deterministic scheduler, protected cold
  entitlement, one-depth warm pilots, pinned deepest canonical continuation,
  shadow telemetry, and experimental complete observer enabled
- command: `/usr/bin/time -l pnpm exec tsx --tsconfig tsconfig.node.json
  scripts/irregular-capacity-gate.ts --strict --paired --case
  capacity-triangles20-300x300,capacity-mixed61-700x560,capacity-mixed61-700x500
  --output
  /private/tmp/min-plane-provenance/intrinsic-pinned-lane-648a93e-targeted`

## Result

Accepted targeted evidence:

- Triangle `300x300`: exact cold output `15/20`;
- Mixed `700x500`: `49/61`, versus cold `45/61`;
- Mixed `700x560`: `59/61`, versus cold `55/61`.

Only the deepest canonical warm lane exceeds pilot work in each case. All
coordinator chronologies and aggregate/per-lane evaluation ledgers validate.
The paired process used `294.61 s` wall, `313.96 s` user CPU, `1.36 s` system
CPU, and `1,029,423,104` bytes maximum resident set size.

The `700x560` PNG was rendered from the generated SVG with the repository
Electron renderer at 1400 pixels. It has visible background margin on all four
sides, an intact sheet boundary, and no truncated polygon.
