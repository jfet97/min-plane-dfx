# Algorithm Boundary

The placement algorithm is still intentionally absent from the app shell. The user may implement algorithm pieces explicitly inside `src/workers/algorithm/`; infrastructure work must not invent placements or scoring behavior on its own.

Do not implement:

- MaxRects;
- candidate scoring;
- final ranking;
- beam search;
- branch and bound;
- fake placements;
- fake free rectangles;
- fake history frames;
- OCaml integration.

## Current Stub Behavior

`sortPiecesForNesting` is the user-owned initial ordering boundary. It may contain user-provided ordering logic, but it must not place pieces, score placements, split free rectangles, or produce history.

`runNestingAlgorithmStub` is the algorithm-core boundary. It accepts the fixed
piece list, sheet, a free-rectangle ordering function, a state ordering function,
and synchronous event hooks. It returns only algorithm outcome data. It does not
know about worker requests, configured strategy ids, protocol result envelopes,
Effect, or history persistence.

The core emits algorithm events, not history frames. The event stream is the
raw material for history: initial states, future beam steps, selected states,
placements, split/prune events, and completion can be translated by the wrapper
into whichever history format the worker needs.

`computeNestingStub` is the worker-facing wrapper around that boundary. It
resolves configured strategy ids, adapts strategy definitions into ordering
functions, calls the core boundary, turns algorithm events into history frames, and
wraps the outcome into `NestingStrategyResult` / `NestingResult`.

The hook path must stream events as the algorithm runs. Do not collect frames in
the wrapper and flush them after the algorithm returns. In the worker, the sync
hook offers frames into an Effect queue; a consumer fiber performs NDJSON writes
and live `history_frame` sends outside the algorithm.

## Strategy Configuration

Strategies are data, not TypeScript unions. Persistent IDs should be descriptive strings from `SCORING_CRITERIA_NOTES.md`.

The app may display strategy labels and descriptions, and it may send selected strategy IDs to the worker. Inside the wrapper, strategy IDs select configured ordering rules for a strategy run. They are not part of the algorithm core itself, and the app must not implement the scoring criteria behind those IDs until the user writes the algorithm.

## Real Algorithm Contract

When a real algorithm is implemented later, a successful run must place all pieces. For real runs, unplaced pieces are fatal validation failures, not partial success.
