# Intrinsic Anytime Pinned-Lane Evidence

This accepted experimental bundle belongs to algorithm commit `648a93e` and
matrix-packaging commit `c171f21`.

[`targeted/`](./targeted/) contains the three staged constrained falsifiers:

- Triangle-20 `300 x 300`: exact cold output, `15/20`;
- Mixed-61 `700 x 500`: `49/61`, versus cold `45/61`;
- Mixed-61 `700 x 560`: `59/61`, versus cold `55/61`.

[`six-baselines/`](./six-baselines/) contains the strict accepted matrix for
Triangle-20, Mixed-61, and Shapes-17 on `2000 x 2700` and `600 x 400`. All six
retain their accepted canonical hashes and placed/unplaced accounting.

The targeted Triangle result is a correctness guard, not a quality claim. Its
legal `15/20` layout remains visually loose on the left side and is retained as
an explicit constrained-quality target for later subset producers.

The immutable source archives, full cold-only/warm-lane SVG set, process logs,
and original checksums remain under:

- `/private/tmp/min-plane-provenance/intrinsic-pinned-lane-648a93e-targeted/`;
- `/private/tmp/min-plane-provenance/intrinsic-pinned-lane-c171f21-six/`.
