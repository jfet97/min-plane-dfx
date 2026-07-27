# Adversarial review record

Five exchanges with an independent read-only reviewer. Verdicts moved from an
initial approval through three revision rounds to approval.

This historical approval was later superseded. A fresh review found that the
test oracle did not preserve the historical segment predicate literally and
produced an extreme finite-coordinate counterexample to the unrestricted
shortcut. The production implementation now uses a conservative numeric
envelope and the historical sweep outside it.

## Findings and outcomes

- **F1 non-atomic guard.** The reviewer executed a ring whose coordinate
  accessor mutates during reading, showing the fingerprint and the value it
  guards could observe different contents. This is why the polygon-digest memo
  was dropped. The remaining guard reads by index, matching the validation it
  protects; the residual non-atomicity is documented rather than hidden, and
  the reviewer accepted that residue for plain internal geometry.
- **F2 mislabeled corpus case.** A test claimed to cover a zero-revolution
  ring, which is unreachable. Corrected.
- **F3 no demonstrated benefit.** Drove the removal of the digest memo and the
  bisection after per-component measurement.
- **F4 wrong artifact under review.** The review worktree had failed to move to
  the rebuilt commits and the reviewer caught it. Corrected and re-verified.

## Independent evidence the reviewer produced

A brute force over `2753880` rings: every ordered distinct-vertex ring of
lengths 3 to 8 on the `{-1,0,1}^2` grid, plus `2130432` rings with
non-adjacent coordinate repetition allowed. No divergence from the retained
quadratic oracle. Of `46020` consistently turning rings the revolution counts
were `1: 1372`, `2: 30374`, `3: 14274`, none zero; every count-one ring was
simple and every higher count self-intersected.

The reviewer also rebuilt the access-path falsifier in memory, restoring the
iterator walk to confirm the committed test genuinely fails without the fix.

The historical verdict is not an acceptance authority. The final hardened
source, portable matrix, and current review supersede it.
