# @ordewell/core

The engine behind **[Ordewell](https://ordewell.ai)**: pure TypeScript with no UI
dependencies, shared by the CLI, the terminal UI, the VS Code extension and the
local API server.

This package is published so those surfaces can depend on it. It has no CLI of
its own — if you want to *use* Ordewell, install
**[@ordewell/cli](https://www.npmjs.com/package/@ordewell/cli)** instead.

```bash
npm install @ordewell/core
```

## What's inside

| Module | Responsibility |
| --- | --- |
| `Session` | One plan's full lifecycle — generation, execution, mutation, persistence |
| `PlanStore` | All plan-shaped state: the task tree, status sets, runner set |
| `Planner` | The read-only model that researches a repo and emits the plan |
| `TaskOrchestrator` | Pure scheduler — dependency order and parallelism |
| `VerdictEngine` | Completion-marker verification; the model is never the tie-breaker |
| `ModelResolver` / `ModeResolver` | Per-task model routing and mode resolution |
| `RunnerRegistry` | Built-in runners plus the plugin manifest engine |

Subpath exports: `@ordewell/core/parsing`, `/plan-utils`, `/testing`.

## Stability

Pre-1.0. The surfaces in this monorepo are the intended consumers, and the API
changes with them — pin an exact version if you depend on it directly.

The domain vocabulary these names come from is defined in
[CONTEXT.md](https://github.com/ordewell/ordewell/blob/main/CONTEXT.md).

Licensed under the [Apache License 2.0](./LICENSE).
