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

`computeNestingStub` produces a typed stub result that clearly marks pieces as unplaced and warns that the placement algorithm is not implemented. It accepts an `emitFrame` callback so real algorithm work can emit history while running; the stub only exercises the history pipeline with an initial frame.

## Strategy Configuration

Strategies are data, not TypeScript unions. Persistent IDs should be descriptive strings from `SCORING_CRITERIA_NOTES.md`.

The app may display strategy labels and descriptions, and it may send selected strategy IDs to the worker. It must not implement the scoring criteria behind those IDs until the user writes the algorithm.

## Real Algorithm Contract

When a real algorithm is implemented later, a successful run must place all pieces. For real runs, unplaced pieces are fatal validation failures, not partial success.
