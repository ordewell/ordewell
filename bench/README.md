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
  empty turns, grilling-ignoring eagerness). Deterministic and offline.
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

- `fake-claude/` — a deterministic stand-in for the `claude` CLI: no LLM, no
  API key. Put the folder first on `PATH` and Ordewell's own `claude-code`
  connector and structured runner drive it as they would the real binary. It
  speaks the stream-json protocol the connector reads, answers the `mcp_status`
  check, and completes a task by calling `task_complete` on the Ordewell MCP
  server named in the `--mcp-config` file it is given — it never prints the
  text marker. A task steers it with a cue in its prompt:
  `<fake-claude>{"delayMs":400,"write":{"A.txt":"hi"},"status":"blocked","reason":"why"}</fake-claude>`
  (all fields optional; see the header of `fake-claude.mjs` for the full list).
  `claude` is the POSIX shim and `claude.cmd` the Windows one.
- `drive-pipeline.mjs` — drives a plan end to end through the fake `claude`
  (`--runner fake`, the default) so auto-advance, parallel task scheduling and
  dependency chains can be tested without spending anything, or through a real
  `opencode` (`--runner opencode`). The VS Code integration scenarios
  (`packages/vscode/src/test-integration/`) use the same fake via `PATH`.
- `pipeline.test.mjs` — runs the driver under `node:test`. Needs core built
  first (`npm run build:core`).

## Tests

```bash
node --test "bench/**/*.test.mjs"
```
