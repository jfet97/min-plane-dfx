# Architecture Index

Read the docs that match the task. For broad implementation work, read all of them.

- [Process Boundaries](./process-boundaries.md): renderer, preload, main, services, supervisor, and worker responsibilities.
- [Effect Runtime](./effect-runtime.md): where Effect layers live and where Promise escape hatches are allowed.
- [Schema Models](./schema-models.md): class-first schema conventions, named models, and constructor/factory usage.
- [Project Persistence](./project-persistence.md): single JSON snapshots, hydration, history references, and missing replay behavior.
- [UI Clarity](./ui-clarity.md): desktop-tool UI expectations and honest algorithm state.
- [Algorithm Boundary](./algorithm-boundary.md): worker algorithm ownership and wrapper responsibilities.

## Adding Docs

- Cross-cutting app architecture goes in `docs/architecture/`.
- Short task plans can go in `docs/planning/` if they need to survive a branch.
- Do not add docs that describe fake algorithm behavior as if it exists.
