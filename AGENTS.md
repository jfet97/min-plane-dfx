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

- Keep algorithm behavior inside `src/workers/algorithm/`.
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

For UI work, also run:

```sh
pnpm dev
```

Then verify the empty state, disabled controls, and that no fake algorithm output was introduced.

## Pull Requests

Use exactly these sections, in order:

```md
## Why

## What

## How

## Remarks
```

Do not add validation sections, command lists, AI attribution, co-author lines, or tool/process notes.
