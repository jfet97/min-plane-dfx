# Algorithm Boundary

The nesting algorithm is intentionally absent.

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

## Allowed Stub Behavior

`sortPiecesForNesting` may return the input unchanged.

The worker may produce a typed stub result that clearly marks pieces as unplaced and warns that the algorithm is not implemented.

## Strategy Configuration

Strategies are data, not TypeScript unions. Persistent IDs should be descriptive strings from `SCORING_CRITERIA_NOTES.md`.

The app may display strategy labels and descriptions, and it may send selected strategy IDs to the worker. It must not implement the scoring criteria behind those IDs until the user writes the algorithm.

## Real Algorithm Contract

When a real algorithm is implemented later, a successful run must place all pieces. For real runs, unplaced pieces are fatal validation failures, not partial success.
