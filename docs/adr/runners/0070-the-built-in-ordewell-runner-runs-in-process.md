---
status: accepted
implemented: partial
amends: ["0022", "0025"]
note: "Built: Full mode on chat-completions. Later slices: Guarded and read-only gates, run_command and the other task tools, the step limit and repeat guard, compaction and caching, the models.dev catalog, the other dialects, and the planner on ModelClient."
---

# 0070 — The built-in Ordewell runner runs in-process

## Problem

Every runner Ordewell drives is a coding agent someone else ships: Claude Code,
Codex, OpenCode, or an ACP agent
([ADR-0060](0060-acp-runners-are-data-on-one-connector.md)). A user with only a
provider key (the one the API planner already plans with) can plan but cannot
run a task without installing and signing in to one of them. Ordewell also
cannot shape the agent its tasks run on: its modes, its tools and its prompt are
each runner's own.

## Decision

**Ordewell ships its own runner, `ordewell` ("Ordewell"): a coding-agent loop
that runs inside the Ordewell process (the daemon or the VS Code extension
host), calls the provider's API through `ModelClient` with the keys Ordewell
already holds, and is driven by `StructuredSession` like every other runner.**

- **A task-mode adapter, not a runner of its own.** `OrdewellAdapter` is a
  `TaskModeAgentAdapter` behind the `ordewell` entry of `CONNECTORS`, so the
  message queue, `PermissionLedger`, task log, usage and context fill, resume,
  the usage-limit pause and the `task_complete` path are `StructuredSession`'s,
  unchanged. It spawns nothing: it ignores the process deps, reports its tools
  attached at once, and calls the attempt's task tools in this process
  (`inProcessTaskTools`), the same handlers, validation and token scope the MCP
  server serves. It does not plan; the API planner plans on the same key.
- **A runner with no command.** Its manifest's `runner` is `{ inProcess: true }`
  (`RunnerLaunch`), so it is installed wherever Ordewell is, with no
  `--version` probe. It reads as signed in once any provider has a key, and
  otherwise as signed out with `/key` as its sign-in route
  ([ADR-0052](../routing/0052-a-signed-out-coding-agent-is-flagged-and-signs-in-from-the-chat.md)).
  It is listed with the other runners in `ordewell runners` and `/runners`.
- **Models are every keyed provider's.** Discovery method `providers` lists each
  keyed provider's own catalog, grouped by provider, as `<provider>:<model>`
  (the first colon splits, so `openai_compatible:qwen3:8b` is a model `qwen3:8b`).
  One `ModelInfo` shape carries the context window, the reply cap, prices per
  million tokens, tool and reasoning support, and which of those a catalog
  stated (`known`); what none stated takes a conservative default.
- **The loop** (`OrdewellLoop`) runs a turn as steps until one ends with no tool
  call. Each step is one `ModelClient.stream` call whose request is rebuilt from
  the saved transcript; retries are `ModelClient`'s policy. A tool call starts
  as soon as the stream completes it, calls run in parallel, and their results
  are recorded in call order. Each message is appended to a transcript store
  outside every workspace
  ([ADR-0032](../planner-envelope/0032-runner-state-outside-the-workspace.md)),
  keyed by the session id the adapter reports as its native session id, so a
  resume reads it back. Events map to the task log's vocabulary: text, thinking,
  `tool_call`, `tool_result`, usage. An interrupt stops cooperatively, and a
  short grace later aborts the stream and the running tools.
- **One neutral tool set**: `read`, `edit`, `write`, `shell`, `grep`, `glob`,
  then the task tools as native tools, `task_complete` and `read_task` (the
  token's `read`, renamed because `read` reads files here). The list is fixed
  for the whole attempt so the cached prefix holds.
- **The prompt** is short and provider-neutral: one task in its own worktree,
  ended by `task_complete` with a summary, findings and a handoff, and a commit
  message when the task commits
  ([ADR-0047](../supervision/0047-structured-task-handoffs.md)). An environment
  block (working directory, platform, date, whether it is a git repository)
  follows, then the worktree's AGENTS.md, or else its CLAUDE.md. Earlier tasks'
  handoffs are in the first user message, as `StructuredSession` writes it.
- **Completion is the token-bound `task_complete` alone**
  ([ADR-0025](0025-structured-only-runners.md)). The loop ending a turn, or the
  model saying it is done, proves nothing.

## Key properties

- **Keys are held, never handed on.** Every provider key in the
  attempt's environment goes into `HeldSecrets`, and every event and transcript
  line passes its redaction
  ([ADR-0061](../platform/0061-held-secrets-are-hidden-exactly-and-agent-text-by-name-in-depth.md)).
  No key reaches a shell child's environment, in any mode.
- **A mode not built refuses.** The runner declares its three modes with
  the autonomous, safe and read-only tags `ModeResolver` reads. An attempt in a
  mode whose gate is not built refuses to start with a message naming it, and
  never runs as Full ([ADR-0001](../routing/0001-autonomous-mode-resolution.md)).

## Modes

| Mode | Tag | What it means |
| --- | --- | --- |
| Full | autonomous | Every tool runs without asking. `edit` and `write` stay inside the worktree, and the shell's environment holds no keys. |
| Guarded | safe | Edits inside the worktree go ahead; every shell command asks. *Allow for this task* grants a command prefix that must match the whole command line, never only its first word. |
| Read-only | read-only | No edit tools. The sealed `run_command` ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)) is the only shell. |

A change task's shell runs unsandboxed in every mode; sandboxing it is a later
hardening step.

## Seams

Three later pieces build on the loop, each at one seam, handed in through
`OrdewellAdapterOptions`:

- **The gate** (`ToolGate`) is asked before each neutral tool runs and may
  refuse it with a reason, which the model reads as the tool's result. The
  modes build Guarded and read-only here.
- **The step boundary** (`StepBoundaryHook`) runs before every step with the
  transcript, and may inject user messages, override the step's tool choice or
  end the turn. Message delivery, the step limit (which forces `task_complete`
  on the last step, beside a repeat guard) and a usage-limit pause go here.
- **The transcript store and the request assembler** (`TranscriptStore`,
  `RequestAssembler`): the store is the one record of what the model has seen,
  JSON lines in `<data dir>/runners/ordewell/sessions/<id>/transcript.jsonl`,
  and the assembler is the one place a request is built from it. Compaction
  folds old messages in either; caching places its breakpoints in the
  assembler.

## Testing decisions

The loop and the adapter are tested against a scripted `ModelClient` and an
in-memory transcript store (`loopKit.ts`), with no network. End to end,
`ordewellRunner.e2e.test.ts` runs a real session on a real worktree against
the `mock/ordewell-runner` persona of `bench/live/mock-provider.mjs`, which reads,
edits, runs a test through the shell and calls `task_complete`; the verdict
comes from that call.

## Out of scope

- The Guarded and read-only gates, and `checkpoint`, `apply_patch`,
  `save_patch`, `run_command`, `fetch` and `web_search` as native tools.
- The step limit, the repeat guard, compaction and prompt caching.
- Per-family tool shapes: one neutral set serves every model until a family
  measurably needs its own.
- The model catalog from each provider's `/models` plus models.dev; until then
  `ModelInfo` is what the existing listing states, defaulted elsewhere.
- Moving the planner onto `ModelClient`. Only the planner moves; the runner is
  on it already.

## Considered options

- **A separate ACP agent binary, driven by the ACP connector.** Rejected: it
  needs an install of its own and a hop through the MCP server for every task
  tool, for an agent that ships with Ordewell anyway.
- **A forked child process.** Rejected: it buys process isolation alone, at
  the cost of the plumbing to carry events, tool calls and keys across, while
  the tools already confine paths and strip keys.
- **The Vercel AI SDK, or raw `fetch` per dialect, under `ModelClient`.**
  Rejected: `ModelClient` sits on the providers' official SDKs, which track
  each API's changes, rather than a second abstraction over them or a hand-kept
  copy of each wire format.

## Consequences

- A provider key is enough to plan and to run a task.
- Ordewell owns the runner's prompt, tools and modes, and so their defects.
- The runner runs in the host's process: a tool that hangs or a loop that leaks
  costs the host, not a child it can kill.

## History

- 2026-11-14 — accepted; Full mode on chat-completions implemented.
