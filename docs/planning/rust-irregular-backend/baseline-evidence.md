# Stage 0 Baseline Evidence — TypeScript Backend

Machine: Linux 6.18.38 x86_64 (NixOS), 16 hardware threads, 125 GiB RAM,
Node v24.18.0, pnpm 11.11.0. Source commit `f282f0a`, clean tree.
Raw logs: `/tmp/rust-migration-stage0/` (functional log, gates log, rerun log,
freeze hashes). Date: 2026-07-28.

## Functional suite (all green)

- `pnpm typecheck`: pass (7.8 s)
- `pnpm lint`: pass (4.0 s)
- `pnpm test`: 913 passed, 17 skipped, 90 files, 20.0 s, exit 0

## Production gates (all green on this machine)

- `pnpm gate:capacity` (paired): pass
- `pnpm gate:capacity:production`: pass
- `pnpm gate:mixed61-compact --output /tmp/rust-migration-stage0/sheet-invariance`:
  pass — elapsed 48,453.8 ms, fitted canonical SHA-256
  `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`,
  61/61 placed, area 391,605.850174 mm², 0 canonical cavities.
  (`--output` overrides only the report directory; the macOS default
  `/private/tmp` does not exist on this Linux host.)
- `pnpm gate:compact-nine-baselines --output-dir /tmp/rust-migration-stage0/nine-baselines --skip-png`:
  pass — 18 layouts (9 Compact + 9 Short Side profile), every check true,
  `directionalSuccessCount` 9, `directionalMissCount` 0, `compactFallbackCount` 0,
  short-side winners: 1 multi-row shelf + 8 contact strip. Total 3 m 32.9 s.
- `pnpm profile:mixed61`: pass — strict elapsed 45,172.8 ms, artifact
  `/tmp/min-plane-provenance/mixed61-profile-2026-07-28T18-20-23-182Z-3457365/`
  (cpuprofile, analysis, result JSON/SVG, git commit/status/diff).

## Per-layout baseline wall-clock (nine-baselines rerun, single serial pass)

| Case | Sheet | Compact ms | Short-Side-profile ms |
| --- | --- | ---: | ---: |
| triangle-20 | 2000x2700 | 5,361 | 5,871 |
| mixed-61 | 2000x2700 | 48,615 | 52,337 |
| shapes-17 | 2000x2700 | 8,534 | 16,382 |
| triangle-20 | 600x400 | 4,649 | 5,819 |
| mixed-61 | 600x400 | 4,536 | 6,817 |
| shapes-17 | 600x400 | 9,053 | 13,869 |
| triangle-20 | 300x300 | 5,667 | 6,011 |
| mixed-61 | 300x300 | 842 | 961 |
| shapes-17 | 300x300 | 2,450 | 2,799 |

These are single-sample Stage-0 measurements; contract batches follow the
alternating multi-sample method in `performance-contract.md`.

## Mixed-61 CPU self-time breakdown (41,972 samples, 45.5 s sampled)

| Category | Self time | Share |
| --- | ---: | ---: |
| NFP/IFP candidate generation | 13.49 s | 29.6% |
| search / decoders / portfolios | 6.56 s | 14.4% |
| beam-state canonical keys | 5.85 s | 12.9% |
| GC | 3.60 s | 7.9% |
| placement validation / convex predicates | 3.07 s | 6.8% |
| Effect runtime | 2.50 s | 5.5% |
| other geometry kernels | 2.50 s | 5.5% |
| clipper2 | 2.20 s | 4.8% |
| spatial index | 1.79 s | 3.9% |
| canonical grid exact math | 1.48 s | 3.2% |
| canonical layout metrics | 1.45 s | 3.2% |

Top functions: anonymous NFP/IFP service closures 19.0%,
`canonicalPlacementPointAlternatives` 4.0%, `canonicalRingKey` 3.1%,
`canonicalCollisionPolygonKey` 2.4%, spatial-index `add` 2.3%, `pointKey` 2.1%.

## Freeze

SHA-256 of every file under `tests/`, `scripts/`, `docs/artifacts/`, plus
`package.json`, `vitest.config.ts`, `vite.worker.config.ts`, `tsconfig*.json`
recorded at commit `f282f0a` in
`/tmp/rust-migration-stage0/freeze-hashes-before.txt` (1,120 entries).
Final acceptance must re-hash and prove byte-identity (additive new files are
allowed; existing expectations are immutable).
