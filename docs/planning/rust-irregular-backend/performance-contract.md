# Rust Irregular Backend — Preregistered Performance Contract

Status: **preregistered before any production Rust implementation existed**.
Authored 2026-07-28 from TypeScript-only baseline evidence. Per migration-prompt
section 19.3 this contract must be approved by the user before production Rust
implementation begins and must not be revised after Rust results are observed.

Approval provenance: the user delegated approval in advance during the kickoff
session ("i gotta go so no wait for my approval, I do approve everything, I want
a pr with everything (working) in it at the end", 2026-07-28). The numeric
thresholds below were therefore fixed by the implementing agent from TS-only
evidence and are binding for promotion. They may not be weakened retroactively.

## 1. Benchmark machine and provenance

All contract measurements run on one machine under controlled conditions:

- Linux 6.18.38 x86_64 (NixOS host), 16 hardware threads, 125 GiB RAM
- Node v24.18.0, pnpm 11.11.0, Electron `^33.2.1` (locked by pnpm-lock.yaml)
- Rust toolchain: rustc 1.97.1 stable, target `x86_64-unknown-linux-gnu`
- Source commit `f282f0a` (clean tree) for the TypeScript baseline
- CPU model, exact commit, dirty diff, thread count, cache policy identity,
  and all raw samples must be recorded with every measurement batch
- No other performance measurement or heavy process may run concurrently;
  measurement batches are strictly serial

### 1.1 Docker/Linux P5 runner

Run the aggregate suites through the checked-in wrapper:

```sh
pnpm benchmark:p5:linux -- --output-dir out/p5-linux-container
```

Use `pnpm benchmark:p5:linux -- --dry-run` to inspect the build and container
commands without building the image or running a benchmark. The image pins Node
v24.18.0, pnpm 11.11.0, rustc 1.97.1 stable, and the
`x86_64-unknown-linux-gnu` target. It does not and cannot manufacture the host
kernel, CPU architecture, hardware-thread count, or physical memory required by
this contract.

The wrapper compares the source host, Docker daemon host, container, and
toolchain provenance with `docker/p5-controlled-host.contract.json` before
starting the aggregate runner. The controlled daemon identity is NixOS host
`t3vm`; an unknown or different daemon operating system or name is a mismatch.
Docker Desktop and other daemon identities remain blocked even if their Linux
VM is configured to resemble the contract machine.
Classification fails closed:

- local Linux arm64 is blocked and non-authoritative;
- a Linux amd64 container emulated on an arm64 host is blocked and
  non-authoritative;
- native Linux x64 with any kernel, hardware-thread, memory, container, or
  toolchain mismatch is blocked and non-authoritative;
- a dirty source tree or unknown Git state is blocked and non-authoritative;
- authoritative execution requires all C5, C6, and C7 suites, Rust thread
  cells `1` and `default`, exactly three initial measured samples, and warmups;
- bounded profiling overrides such as `--suite C5`, `--rust-threads 1`,
  `--samples 1`, or `--skip-warmups` remain available, but they force blocked
  classification and never receive `--controlled-linux`;
- only an exact host, source, toolchain, and benchmark-schedule match causes the
  wrapper to pass `--controlled-linux` to
  `scripts/rust-parity/measure-p5-aggregate.ts`.

Wrapper provenance records the Git commit and clean or dirty state. When Git
inspection is available, it also records only an opaque SHA-256 fingerprint of
`git diff --binary`, `git diff --cached --binary`, and porcelain status. Source
contents and status text are not written to the evidence artifact.

The aggregate TypeScript file remains the sole benchmark implementation. The
wrapper only builds and runs the container, mounts the requested output
directory, and records classification plus host, image, Docker, architecture,
and toolchain provenance. Raw artifacts are
`p5-wrapper-provenance.json` and `p5-aggregate-evidence.json` in the mounted
output directory. Blocked runs may produce diagnostic timings, but they cannot
produce an authoritative P5 pass or fail verdict.

## 2. Benchmark cases

| # | Case | Profile | Harness |
| --- | --- | --- | --- |
| C1 | Mixed-61 `2000x2700` (primary gate) | Compact | `pnpm profile:mixed61` (strict; hash-pinned) |
| C2 | Triangle-20 `2000x2700` | Compact | nine-baselines case (hash-pinned) |
| C3 | Shapes-17 `2000x2700` | Compact | nine-baselines case (hash-pinned) |
| C4 | Mixed-61 `600x400` (constrained capacity) | Compact | nine-baselines case (hash-pinned) |
| C5 | Nine-baselines full serial suite (9 layouts) | Compact | `pnpm gate:compact-nine-baselines --skip-png` |
| C6 | Capacity production arm suite | Compact | `pnpm gate:capacity:production` |
| C7 | Short Side directional outcomes over the nine-baselines matrix | Compact Short Side | nine-baselines with short-side capture |

A sample is **valid** only if every pinned identity of that case (canonical
hashes, placed/unplaced partitions, areas, cavity counts, statuses, evaluation
counts) is exact. A fast wrong run is not a sample; it is a correctness failure
that halts the benchmark until fixed.

## 3. Method

- Warm-up: 1 discarded run per backend per case before measured samples.
- Order: alternating TS, Rust, TS, Rust within each case (no backend runs its
  samples back-to-back).
- Sample count: 5 measured samples per backend for C1; 3 per backend for
  C2–C7 (each C5/C6/C7 sample is a full serial suite run).
- Primary statistic: median wall-clock. Dispersion: min–max range and IQR.
- Multi-thread matrix for Rust: 1 thread, 2 threads, default threads, and 8
  threads, measured with the same method for C1 and C5.
- Outliers: no sample may be discarded. If a sample is invalidated by a
  documented external event (machine load spike, OOM-killer, power event), the
  event is recorded and the whole batch for that case is re-run.
- Decision margin: if a median ratio lands within ±5% of a threshold, take 5
  additional alternating samples for that case before the verdict.
- Peak RSS measured via `/usr/bin/time -v` (maximum resident set size) on C1.

## 4. TypeScript baseline (measured on the contract machine, commit f282f0a)

- C1 Mixed-61 `2000x2700`: elapsed **45.17 s** (strict run inside
  `pnpm profile:mixed61`, artifact `mixed61-profile-2026-07-28T18-20-23-182Z`),
  fitted canonical SHA-256 `ef2b783a…` exact, 61/61 placed, 0 cavities.
  CPU self-time: NFP/IFP candidate generation 29.6%, search/decoders 14.4%,
  canonical keys 12.9%, GC 7.9%, placement validation 6.8%, Effect runtime
  5.5%, clipper2 4.8%.
- C6 capacity gates: production+paired arms passed on this machine (logs
  `/tmp/rust-migration-stage0/baseline-gates.log`).
- Full unit suite: 913 passed / 17 skipped in 20.0 s; typecheck and lint clean.
- Reference-machine numbers (docs/operations/irregular-production-gates.md,
  commit acb4186): Mixed-61 69.4 s, Triangle-20 14.9 s, Shapes-17 12.7 s.
- Per-case baseline medians for C2–C5/C7 are recorded in
  `baseline-evidence.md` as the alternating-run baseline batches complete;
  they are measurements of the frozen TS backend and do not alter thresholds.

## 5. Promotion thresholds (binding)

Correctness is a hard gate and is not part of this section: exact parity on
every maintained case, gates, hashes, partitions, traces, and thread-count
invariance are prerequisites before any performance comparison counts.

- **P1 (one-thread native win):** Rust 1-thread median on C1 ≤ **0.667 ×** TS
  median on C1 (≥ 1.5× speedup).
- **P2 (primary gate speedup):** Rust default-thread median on C1 ≤ **0.40 ×**
  TS median on C1 (≥ 2.5× speedup).
- **P3 (parallel efficiency):** Rust default-thread median on C1 ≤ **0.77 ×**
  Rust 1-thread median on C1 (≥ 1.3× improvement from threading after cache
  and synchronization costs).
- **P4 (no per-case regression):** for every case C2–C7, Rust default-thread
  median ≤ max(1.10 × TS median, TS median + 25 ms). Small fast cases get the
  25 ms absolute allowance for fixed N-API crossing overhead.
- **P5 (aggregate suites):** Rust 1-thread total ≤ 0.75 × TS total, and Rust
  default-thread total ≤ 0.60 × TS total, on C5 and C6.
- **P6 (memory):** Rust default-thread peak RSS on C1 ≤ **1.5 ×** TS peak RSS
  on C1, and bounded (documented cap) cache memory.
- **P7 (thread-count neutrality):** no thread-count setting may change any
  semantic output byte (this is also a correctness gate; listed here because a
  violation invalidates all performance claims).

If a Rayon parallelization makes any contract case slower, it must be narrowed
or removed before promotion; parallelism is not a success criterion, lower
end-to-end time is.

## 6. Reporting

Every batch reports: all raw samples, medians, ranges, backend identity
actually executed (a Rust-requested run that silently fell back to TS fails
the batch), thread count, cache policy identity, commit, diff status, and
machine conditions. Evidence lands under `docs/planning/rust-irregular-backend/`
and the immutable raw logs under `/tmp/rust-migration-stage0/` are copied into
the PR evidence before merge.
