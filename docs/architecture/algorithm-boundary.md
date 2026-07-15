# Algorithm Boundary

The placement algorithm lives behind the worker boundary in `src/workers/algorithm/`. Infrastructure code must not invent placements, scores, history, or strategy behavior outside that path.

Do not add unrelated algorithm systems or fabricated output without an explicit design decision:

- branch and bound;
- fake placements;
- fake free rectangles;
- fake history frames;
- OCaml integration.

## Current Behavior

`sortPiecesForNesting` is the user-owned initial ordering boundary. It may contain user-provided ordering logic, but it must not place pieces, score placements, split free rectangles, or produce history.

`runMaxRectsBeamSearch` is the algorithm-core boundary. It accepts the fixed
piece list, sheet, adaptive beam width, a non-empty list of candidate ordering
functions, a layout/state ordering function, and synchronous event hooks. It
owns one beam run: selected candidate strategies are alternatives inside that
beam, not separate worker runs. It does not know about worker requests,
configured strategy ids, protocol result envelopes, Effect, or history
persistence.

The core operates on integer-millimeter rectangles only. Coordinates and
padding are non-negative integers; widths and heights are positive integers.
DXF fractional geometry is normalized by main before the worker request is
created, so the algorithm must not perform float rounding or unit conversion.
Padding in the UI is total clearance; the prepared piece footprint has
`ceil(padding / 2)` added per side before it crosses the worker boundary.

`NestingAlgorithmState` is the retained beam for one algorithm step: rank 0 is
stored as `top`, and the other retained states live in `alternatives`. The order
used to choose survivors compares individual beam states, not the container.
History translation emits one frame per retained state with `beamRank`, so main
and renderer can inspect the top state and the other retained alternatives.
Scrubbing rank 1 across steps shows the rank-1 snapshot at each step, not the
ancestry path of one final branch; lineage replay requires explicit parent
links that the current history model does not store.
Inside a beam member, `remainingPieces` is the future placement queue, while
`unplacedPieces` is the branch-local bucket for pieces already rejected as not
fitting.

Algorithm internals are grouped by domain under `src/workers/algorithm/`:
`beam/` owns retained-state shape and seed construction, while `maxRects/` owns
placement anchors and free-rectangle mechanics. The root files stay focused on
strategy orchestration, ordering adapters, and worker-facing wrappers.

Irregular v2 geometry services live under `src/workers/irregular/`. That
directory owns deterministic collision-geometry preparation and geometry-kernel
operations such as flattening, convex hulls, offsets, and transforms. It does
not own placement generation, scoring, beam state, or search. Those algorithm
behaviors belong under `src/workers/algorithm/`, including the strict-priority
irregular decoder under `src/workers/algorithm/irregular/`.

The `irregular-convex-v2` worker mode is exposed through the request schema and
renderer, but the worker currently returns `not_implemented` before MaxRects is
reached. Keep it that way until the real convex geometry and search
implementations exist.

The core emits algorithm events from `src/workers/algorithm/events.ts`, not
history frames and not worker-wire payloads. The event stream is the raw
material for history: initial states, beam-step counts, selected states,
placement applications with ids plus split/prune data, and completion can be
translated by the wrapper into schema-backed history or worker protocol
payloads.

`computeNesting` is the worker-facing wrapper around that boundary. It
resolves configured strategy ids, adapts strategy definitions into ordering
functions, calls the core boundary, turns the initial beam and every selected
beam survivor into history frames, and wraps the outcome into
`NestingStrategyResult` / `NestingResult`.

The hook path must stream events as the algorithm runs. Do not collect frames in
the wrapper and flush them after the algorithm returns. In the worker, the sync
hook offers frames into an Effect queue; a consumer fiber performs NDJSON writes
and live `history_frame` sends outside the algorithm.

## Strategy Configuration

Strategies are data, not TypeScript unions. Persistent IDs should be descriptive strings from `SCORING_CRITERIA_NOTES.md`.

The app may display strategy labels and descriptions, and it may send selected
candidate strategy IDs to the worker. Inside the wrapper, those IDs select
candidate ordering rules for one beam run. They are not part of the algorithm
core itself.

## Algorithm Contract

An `ok` run places all pieces. A `partial` run returns concrete placements plus the pieces the selected beam could not place.
