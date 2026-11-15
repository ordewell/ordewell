---
status: accepted
amends: ["0022", "0025"]
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
- **Context is managed by the runner** (`compaction.ts`), to spend fewer tokens without losing the task:
  - **Fill.** Every step reports its usage with the model's context window, a
    defaulted one included, since compaction acts on the same figure, and with
    the prompt plus reply as `contextTokens`, so `ContextWindowFill` reads the
    meter. A compaction resets it to the compacted size.
  - **Trigger.** Before each request the next prompt is estimated: the provider's
    last count (the whole prompt and its reply) plus an estimate of what was
    recorded since, or the whole prompt estimated when there is no count (a fresh
    attempt, the step after a compaction). Past the window minus a reserve, 15%
    of the window and at least 16k tokens, the conversation is compacted. The
    threshold is never under half the window, so a window under about 32k does not
    compact on every step. Estimates count four characters to a token.
  - **Summary.** A separate call, with no tools, writes the messages between the
    kept head and tail under fixed headings: Objective, Requirements, Decisions,
    Work State (Completed, Active, Blocked), Next Move, Relevant Files, Important
    Context. A missing heading earns one reminder; one still missing is filled
    with "(not recorded)" so the shape never varies.
  - **Kept word for word.** The task message (its prompt and the earlier tasks'
    handoffs) and a tail of up to a quarter of the window. The tail starts at the
    earliest user message that fits, else the earliest assistant message, and
    never at a tool result, so a call stays with its result.
  - **Persisted.** A `compaction` transcript line names the replaced range and
    holds the summary message; the lines before it stay on disk and the fold
    applies it, so a resume continues from the compacted conversation. The task
    log gets a `compaction` event with the sizes before and after, and the summary
    call's spend is billed under the `compaction` purpose, apart from the meter.
  - **Overflow.** When the provider refuses a request as too long (a context
    overflow), the same step is retried from a conversation compacted to 0.85,
    0.7, 0.5 and then 0.35 of the window, the tail shrinking with it, before the
    refusal fails the step.
  - **Cache hints.** Every request marks breakpoints after the tool list, after
    the system prompt and at the last message. The tool list and the system prompt
    are fixed for the attempt (the prompt is read back from the transcript, never
    rebuilt), and nothing that changes between steps, such as a count or a clock,
    is in them. A Claude model reached through OpenRouter carries a provider
    order, Anthropic's own API and then Bedrock, with fallbacks left on:
    OpenRouter's usual pick, Vertex's global endpoint, spreads successive
    requests over caches that share nothing, so a step there pays to write the
    prefix and reads the previous one only by chance. The order gives up
    OpenRouter's own choice among Claude's upstreams, and its sticky routing,
    while one of the two is up; a request either cannot take still routes
    elsewhere, uncached.

## Key properties

- **Keys are held, never handed on.** Every provider key in the
  attempt's environment goes into `HeldSecrets`, and every event and transcript
  line passes its redaction
  ([ADR-0061](../platform/0061-held-secrets-are-hidden-exactly-and-agent-text-by-name-in-depth.md)).
  No key reaches a shell child's environment, in any mode.
- **A mode is never widened.** The runner declares its three modes with
  the autonomous, safe and read-only tags `ModeResolver` reads. An attempt runs
  in the mode it was planned at, and an unknown mode refuses to start rather than
  running as Full ([ADR-0001](../routing/0001-autonomous-mode-resolution.md)). A
  read-only task is read-only whatever level it was planned at.
- **Lifecycle.** An attempt makes at most the step limit's model calls
  (`ordewellStepLimit` in the settings file, default 200); the last is told so and
  forced to `task_complete`. The repeat guard nudges the third identical tool call
  in a row and ends the attempt as failed on the fourth. Messages to a running
  task reach the model between steps, an interrupt stops cooperatively, a usage
  limit pauses the attempt, and a resume reads the transcript back; one with no
  session start is not resumable.
- **A quiet stream is abandoned, and nothing runs twice.** `createModelClient`
  wraps every dialect's client in `withStreamTimeouts`: a request whose stream
  sends no `ModelEvent` (an SSE keepalive comment is not one) for 180 s before
  its first event, or 60 s between events, is aborted with a transient
  `ModelError` (`ordewellStreamTimeouts` in the settings file, in seconds). Before
  any event `withRetry` sends it again. After one the loop decides, as only it
  knows what ran: with no tool call started it drops the partial reply and
  sends the same request again; with one, the calls and their results are
  already recorded and the turn goes on to its next step from them. Either
  retry follows the retry policy and leaves a line in the task log.

## Modes

| Mode | Tag | What it means |
| --- | --- | --- |
| Full | autonomous | Every tool runs without asking. `edit` and `write` stay inside the worktree, and the shell's environment holds no keys. |
| Guarded | safe | Edits inside the worktree go ahead; every shell command asks. *Allow for this task* grants a command prefix that must match the whole command line, never only its first word. |
| Read-only | read-only | No edit tools. The sealed `run_command` ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)) is the only shell. |

The shell runs unsandboxed in every mode that has one; sandboxing it is a later
hardening step. Guarded's prefix grant lasts for the attempt, matches only a
whole command line made of the prefix and plain arguments, and never a line with
a shell operator.

## Seams

Three pieces build on the loop, each at one seam, handed in through
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
  and the assembler is the one place a request is built from it, and places
  its cache breakpoints. Compaction rewrites the stored transcript instead (see
  the context bullet above), so what is assembled is always what a resume loads.

## Testing decisions

The loop and the adapter are tested against a scripted `ModelClient` and an
in-memory transcript store (`loopKit.ts`), with no network. End to end,
`ordewellRunner.e2e.test.ts` runs a real session on a real worktree against
the `mock/ordewell-runner` persona of `bench/live/mock-provider.mjs`, which reads,
edits, runs a test through the shell and calls `task_complete`; the verdict
comes from that call.

## Out of scope

- Per-family tool shapes: one neutral set serves every model until a family
  measurably needs its own.
- Sandboxing the shell.
- A live-verified provider matrix: the effort and model tables of the Responses
  and Gemini adapters, and the Anthropic key header, are checked by recorded
  fixtures only; `bench/live/runner-smoke.mjs` is the hand-run check.

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

- A provider key is enough to plan and to run a task. The API planner reaches
  each provider through the same `ModelClient`, by its dialect
  ([ADR-0002](../planner/0002-planner-as-conversation-loop.md),
  [ADR-0044](../planner/0044-the-planners-usage-limit-waits-and-resends.md)).
- Ordewell owns the runner's prompt, tools and modes, and so their defects.
- The runner runs in the host's process: a tool that hangs or a loop that leaks
  costs the host, not a child it can kill.

## History

- 2026-11-14 — accepted; Full mode on chat-completions implemented.
- 2026-11-14 — context fill, compaction and cache breakpoints implemented.
- 2026-11-14 — the model catalog implemented: each provider's `/models` says
  which models exist, models.dev fills window, reply cap, prices and
  capabilities (daily background fetch, cache under the data directory, bundled
  snapshot as the offline fallback; `ModelDetails.ts`).
- 2026-11-14 — the modes, the step limit, the repeat guard, the Anthropic
  Messages, Responses and Gemini dialects, and the planner on `ModelClient` implemented; fully implemented.
- 2026-11-15 — a Claude model through OpenRouter is routed to Anthropic, then
  Bedrock, so its cache is read from the second step on.
- 2026-11-15 — stream timeouts implemented: a stream quiet past them is cut and
  its step retried, keeping any tool call that already ran.
