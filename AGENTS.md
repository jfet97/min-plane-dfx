# Agent Instructions

`min-plane-dfx` is a local Electron desktop app for preparing DXF rectangular nesting jobs.

- `src/main/`: Electron main process, IPC handlers, dialogs, filesystem services, worker supervision.
- `src/preload/`: context bridge API exposed to the renderer.
- `src/renderer/`: Vue UI, composables, canvas preview, desktop-tool interaction state.
- `src/shared/`: domain models, schemas, IPC and worker protocols.
- `src/workers/`: Node worker entry point and the nesting algorithm.
- Package manager: `pnpm`.

## Read First

For implementation work, read these files before editing:

1. [`SCORING_CRITERIA_NOTES.md`](./SCORING_CRITERIA_NOTES.md)
2. [`docs/architecture.md`](./docs/architecture.md)
3. The relevant narrower docs under [`docs/architecture/`](./docs/architecture/index.md)

If a task touches Effect APIs, inspect the installed packages in `node_modules` first. Prefer local installed types and source over memory or web docs.

## Hard Rules

- Keep placement, candidate generation, scoring, and search behavior inside
  `src/workers/algorithm/`. Deterministic irregular-v2 geometry kernels,
  collision-artifact construction, and their Effect service boundaries live in
  `src/workers/irregular/`; they must not invent placements, scores, history,
  or search behavior.
- Do not add fake placements, fake free rectangles, fake scores, fake ranking, or fake history.
- Keep docs up to date with code changes. If implementation changes architecture, protocols, workflows, validation, persistence, or agent conventions, update the relevant `docs/` page and/or this file in the same development cycle.
- `src/workers/algorithm/sortPiecesForNesting.ts` is the user-owned initial ordering boundary. Do not change its behavior unless the user explicitly asks for algorithm work.
- Strategy IDs are descriptive strings loaded from configuration, not TypeScript unions.
- Use schema decoding at untrusted boundaries: IPC payloads, worker messages, loaded JSON, imported files, and replay NDJSON.
- Treat exported Effect Schemas as the single owner of validation for schema-backed
  inputs. Put finite-number, range, enum, structural, and cross-field input
  invariants in the relevant schema, then decode at the boundary. Do not repeat
  those input checks inside services or algorithms. Runtime checks remain only
  for values derived after decoding, external-library output, arithmetic
  overflow, or invariants that cannot be represented by the input schema.
- No `as any`, `as unknown as`, or `as never` in app code. Prefer typed adapters, discriminated unions, guards, and explicit errors.
- Avoid non-null assertions in runtime code. Use guards or explicit errors.
- Use `@effect/platform-node` for Node filesystem/path services. Do not hand-roll FileSystem or Path layers.
- Renderer state writes go through composable actions such as hydration, replacement, or reset methods.
- The app uses an Effect SQLite workspace in Electron `userData` for imported DXF copies and temporary project metadata. A user-selected JSON project is still the portable snapshot/export format.

## UI Rules

- Keep the UI dense, restrained, and CAD/tool-like.
- Prefer compact labels, native titles/tooltips, helper rows, and disabled-state explanations over large explanatory blocks.
- Make algorithm status honest: show worker-reported statuses and unplaced pieces directly.
- Result rendering must be driven by real worker results or imported source geometry. Do not invent preview data.

## Validation

After development changes, run from the repo root:

```sh
pnpm lint:fix
pnpm typecheck
```

If every modified file is Markdown (`*.md`), skip lint, typecheck, and tests.
Review the Markdown diff directly instead.

For UI work, also run:

```sh
pnpm dev
```

Then verify the empty state, disabled controls, and that no fake algorithm output was introduced.

## Algorithm Experiment Provenance

- Run competing placement, search, or scoring experiments on dedicated branches
  and isolated worktrees. Do not stack unrelated hypotheses in the main working
  tree.
- Before changing an experiment, commit the exact implementation that produced
  any result worth comparing. Use a descriptive human branch and commit name.
- For every reported layout, record the source commit, uncommitted diff or
  injected comparator, exact fixture/request, sheet dimensions, optimizer
  settings, runtime environment, metrics, and SVG/PNG paths.
- Keep immutable experiment manifests and artifact hashes under
  `/private/tmp/min-plane-provenance/` while iterating. Copy accepted reference
  artifacts into `help/artifacts/` so they remain readable on other machines.
- Update `help/help.md` with accepted results, rejected hypotheses, regressions,
  and open questions before starting the next materially different experiment.
- Never describe a layout as reproducible until its recorded checkout and
  command regenerate the same canonical geometry hash.
- Merge or cherry-pick only after comparing the isolated result against the
  triangle golden and the relevant mixed/corpus gates. Keep rejected branches
  or their manifests until their findings have been documented.

## Pull Requests

Use exactly these sections, in order:

```md
## Why

## What

## How

## Remarks
```

Do not add validation sections, command lists, AI attribution, co-author lines, or tool/process notes.

## Knowledge Base

This project may have an LLM-maintained knowledge base in `knowledge/` (git-ignored). If it doesn't exist, ignore this section. If it does exist, follow these rules:

- For facts about this codebase, consult `knowledge/INDEX.md` and its pages before reading the code.
- To look something up yourself, search the KB directly (no skill): read `INDEX.md`, then use `qmd query "..." -n 5` (if `qmd` is on PATH, a fast first pass; bump to `-n 10` if the first pass under-recalls) and `grep`/`rg` over `knowledge/*.md` to dig deeper. They are complementary, not exclusive: `grep`/`rg` catches exact strings and cross-checks hits; having `qmd` never removes the need to grep.
- After meaningful work (features, refactors, non-obvious fixes) or after pulling new commits, use `$knowledge update`.
- `$knowledge query <question>` gives a synthesized cited answer (`--persist <slug>` files it back as a wiki page); `$knowledge lint` checks health; `$knowledge help` lists commands.
