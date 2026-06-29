# Architecture

This is the entry point for architecture documentation in `min-plane-dfx`.

Read this file first, then [`architecture/index.md`](./architecture/index.md) before designing or implementing changes.

## Architecture Tree

[`architecture/index.md`](./architecture/index.md) routes to focused docs for:

- process boundaries;
- Effect runtime and service ownership;
- project persistence;
- UI clarity;
- algorithm boundary.

## Repository Shape

The app is intentionally compact:

```text
Vue renderer
  -> preload API
  -> Electron main IPC handlers
  -> Effect-backed main services
  -> WorkerSupervisor
  -> worker_threads nesting worker
  -> MaxRects beam search
```

Main owns filesystem, dialogs, project files, imports, exports, and worker lifecycle. The renderer owns UI state only. The worker owns computation workflow and history emission for a single job.

## Non-Negotiable Boundary

The worker owns nesting computation. Infrastructure may prepare requests, validate data, display imported DXF geometry, show worker results, and replay emitted history. It must not fabricate placements, scores, history, or strategy output outside the algorithm path.
