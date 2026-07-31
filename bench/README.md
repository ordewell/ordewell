# Ordewell dev harnesses

Offline tooling for exercising the planner conversation loop, the VS Code
webview, and the execution pipeline against the real core stack. Zero
dependencies. Pure Node (`node:test`, stdlib).

> **The cost model that used to live here has been retired.** `run.mjs` priced a
> routed plan against a single-premium-model baseline from a token *estimate* and
> a price table — it never metered a real run, because Ordewell drives external
> runner CLIs that bill out of band. It was only ever a projection, and an
> end-to-end measurement on real repositories did not reproduce its conclusion.
> Nothing user-facing should quote a cost saving; there is no measurement behind
> one. See the caution in [AGENTS.md](../AGENTS.md).

## Live conversation harness (`bench/live/`)

End-to-end testing of the planner conversation loop (ADR-0002) with the real
core stack:

- `mock-provider.mjs` — a local OpenAI-compatible server simulating budget-model
  quirks (streamed reasoning, fenced JSON with trailing commas, prose preambles,
  empty turns, grill-me-ignoring eagerness). Deterministic and offline.
- `drive-conversation.mjs` — drives `OpenAiService`/`Session` through scripted
  scenarios with assertions (against the mock), or prints a behavioral report
  against a real model: `--real --model deepseek/deepseek-v4-flash` with
  `OPENROUTER_API_KEY` in the environment (never hardcoded).
- `drive-taskops.mjs` — drives the post-plan `task_ops` edit path.
- `webview-harness.mjs` + `webview-screenshot.mjs` — serve the built VS Code
  chat webview in a browser with a mocked VS Code API, replay a full planning
  conversation, assert the sequential-timeline UI contract, and capture
  screenshots.

## Execution pipeline harness (`bench/pipeline/`)

- `fake-runner/` — a deterministic stand-in for a coding-agent CLI: no LLM, no
  API key. Emits the completion marker on cue, so auto-advance, parallel task
  scheduling, and dependency chains can be tested without spending anything.
- `drive-pipeline.mjs` — drives a plan end to end through the fake runner.

## Tests

```bash
node --test bench/
```
