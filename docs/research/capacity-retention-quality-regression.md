# Capacity Retention Quality Regression

## Result

The capacity gate regression was fixed without reverting the production
cohesion frontier. A third, protected continuation lane preserves the current
Triangle-20, Mixed-61, and Shapes-17 matrix identities while improving
Mixed-61 to:

| Sheet | Before | Accepted | Reused prefix | Extra lane work |
| --- | ---: | ---: | ---: | ---: |
| `700 x 500` | 48/61 | 50/61 | canonical depth 15 | 182,205 evaluations, 8.986 s |
| `700 x 560` | 58/61 | 59/61 | canonical depth 30 | 121,472 evaluations, 7.784 s |

Triangle-20 `300 x 300` remains exactly `17/20`, canonical SHA-256
`2f236b79...`, and consumes zero capacity-quality evaluations because its 20
pieces are below the generic 32-piece scheduling threshold.

## Root cause

Independent deterministic bisections identified `38e4bf0` as the first bad
commit. That promotion changed the capacity frontier globally from 16
objective-ranked survivors to four objective representatives plus 12 topology
representatives. It improved the accepted constrained matrix—Triangle-20
`300 x 300` from 15 to 17, Mixed-61 `600 x 400` from 24 to 25, and Shapes-17
`600 x 400` from 13 to 14—but reduced the older Mixed-61 `700 x 500` and
`700 x 560` results.

The historical commit `648a93e` was rerun independently and reproduced 49 and
59 pieces. The red gate floors were therefore real, but no CI workflow had
been enforcing `pnpm gate:capacity`.

## Rejected global rebalance

Commit `281f3ea` globally retained 12 objective and four topology
representatives. It recovered 50 pieces on `700 x 500`, 59 on `700 x 560`,
and preserved Triangle-20 at 17. The full matrix falsified promotion:

- Mixed-61 `600 x 400` regressed from 25 to 24 pieces;
- Shapes-17 `600 x 400` kept 14 pieces but increased envelope area from
  `232,178.021694` to `237,854 mm2`;
- Mixed-61 `300 x 300` changed canonical identity.

Commit `9753e4f` reverted the experiment. The corresponding matrix stopped
after 15 of 18 layouts and is explicitly incomplete rejected evidence, not a
baseline.

## Accepted mechanism

The ordinary cohesion-frontier cold and warm lanes remain unchanged. After an
uncensored complete-archive miss, the coordinator may start one
`capacity-quality-warm-prefix` producer:

- source: deepest exact-fitting `canonical-grid` prefix;
- retention: 12 objective plus four topology representatives;
- protection: distinct producer role, checkpoint fingerprint, frontier, base
  entitlement, scheduler quanta, and ledger;
- scope: requests with at least twice the production beam width, currently 32
  pieces;
- admission: strictly greater placed count only;
- terminal truth: distinct settled, evaluation-cap, and
  checkpointed-censored trace states;
- exclusions: exact preflight impossibility, a fitting complete endpoint,
  ties, losses, and smaller requests.

The checkpoint format is `intrinsic-anytime-checkpoint-v3`. It includes
cumulative topology-retention records, and uninterrupted versus resumed traces
and endpoints match after excluding measured timing fields. Cross-role resume
is rejected.

## Accepted evidence

Source: `62e5c1913a9dc02685a81d75cc7ae509aed962c9`.

Commands:

```sh
pnpm gate:capacity --output <output-directory>
pnpm gate:compact-nine-baselines --output-dir <output-directory> --skip-png
```

Both commands ran strictly sequentially with one algorithm process. The paired
capacity gate passed every fixture and pinned:

- Triangle-20 `300 x 300`: 17, output `2f236b79...`, quality lane skipped;
- Mixed-61 `700 x 500`: 50, output `97dbc502...`, quality endpoint
  `0c98259d...`, canonical prefix 15;
- Mixed-61 `700 x 560`: 59, output `36cee348...`, quality endpoint
  `2d252e35...`, canonical prefix 30.

The full 18-layout Compact/Short Side matrix passed with all accepted hashes,
placed/unplaced partitions, area/cavity metrics, scheduler traces, and profile
outcomes unchanged. CI now runs both gates on Ubuntu; the matrix uses
`--skip-png` only to avoid a display dependency.

Portable evidence is under
[`../artifacts/capacity-retention-quality-guard/`](../artifacts/capacity-retention-quality-guard/README.md).
