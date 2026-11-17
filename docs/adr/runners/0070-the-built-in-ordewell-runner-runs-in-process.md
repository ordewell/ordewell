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

**Ordewell ships its own runner, the built-in runner: a coding-agent loop that
runs inside the Ordewell process (the daemon or the VS Code extension host),
calls a provider's API through `ModelClient` with the key Ordewell already
holds for it, and is driven by `StructuredSession` like every other runner. It
is one runner per API provider, under the provider's own id and name.**

- **One runner per provider, one implementation.** Every `PROVIDER_PRIORITY`
  entry whose models can be listed (`discoversModels`) is a runner whose id is
  the vendor id (`openrouter`, `anthropic`, `google`, …) and whose name is the
  vendor's label ("OpenRouter"), declared by `ordewellManifest(provider)` and a
  generated `CONNECTORS` entry, after the coding agents in picker order
  (`PROVIDER_RUNNER_IDS`). No runner is called "Ordewell". A provider with no
  model listing (Perplexity) has no runner: one would take a task and never
  offer the model to start it. Its key still serves the API planner. The planner
  selector already offers each configured vendor under the same id and label,
  as the API planner on `ModelClient`, so one name means Ordewell's own loop on
  that provider in both selectors. A runner id is what the enabled set, the
  per-runner allowlist, modes, the model catalog and `list_runners` are keyed
  by, so each provider gets every one of them without a flag of its own.
  `providerRunners.ts` (browser-safe, also in `plan-utils`) says which ids are
  provider runners and names them, for a surface.
- **A task-mode adapter, not a runner of its own.** `OrdewellAdapter` is a
  `TaskModeAgentAdapter` built for its provider, so the message queue,
  `PermissionLedger`, task log, usage and context fill, resume, the usage-limit
  pause and the `task_complete` path are `StructuredSession`'s, unchanged. It
  spawns nothing: it ignores the process deps, reports its tools attached at
  once, and calls the attempt's task tools in this process
  (`inProcessTaskTools`), the same handlers, validation and token scope the MCP
  server serves. It refuses, never rewrites, a model of another provider
  ([ADR-0001](../routing/0001-autonomous-mode-resolution.md)). It does not plan;
  the API planner plans on the same key.
- **A runner with no command, installed where its provider is configured.** Its
  manifest's `runner` is `{ inProcess: true, provider }` (`RunnerLaunch`), so
  there is no `--version` probe: it is installed exactly while its provider is
  configured, by a key, or for `openai_compatible` by an explicit
  `OPENAI_COMPATIBLE_BASE_URL` alone, the planner's own rule
  (`vendorConfiguredIn`). That is read afresh on every look, never cached, so a
  key set with `/key-set` lists the runner at once. A listed runner is signed in;
  it never reads as signed out and has no sign-in route
  ([ADR-0052](../routing/0052-a-signed-out-coding-agent-is-flagged-and-signs-in-from-the-chat.md)):
  a provider with no key has no row, so nothing offers a Log in for it. The
  daemon's runner list marks it with its `provider` and `plans: false`.
- **Enabled by default with its key.** While the user has saved no runner choice,
  the enabled set is the coding agents found installed, then the runner of every
  provider configured in the host's own environment (`defaultEnabledRunners`):
  the process's, which `~/.ordewell/.env` fills in the CLI and the daemon, and
  what the host holds for the runner (`hostCredentials.ts`). A workspace's
  variables (`.ordewell/env`, an `.envrc`,
  [ADR-0016](../platform/0016-per-workspace-environment.md)) list the runner and
  start it in that workspace, but enable nothing: the set is one per host. A
  saved choice is never rewritten to add one.
- **Models are its provider's.** Discovery method `providers` lists the
  runner's own provider's catalog, as `<provider>:<model>` (the first colon
  splits, so `openai_compatible:qwen3:8b` is a model `qwen3:8b`), so the model
  ids a plan, a transcript and the model catalog hold mean the same on every
  runner. One `ModelInfo` shape carries the context window, the reply cap,
  prices per million tokens, tool and reasoning support, and which of those a
  catalog stated (`known`); what none stated takes a conservative default.
- **The one id it had before** (`ordewell`, unreleased) is moved as it is read:
  a task on it runs on the runner its model's provider names, its session with
  it; a plan's runner set names those runners instead, and keeps the old id
  while a task whose model names no provider is still on it, so the plan loads
  and that task alone fails at its start. A saved enabled entry becomes the
  runners of the configured providers, and where it had an allowlist entry only
  of those the entry names a model of, so none comes out enabled and
  unrestricted; the allowlist entry is split by provider. While that leaves no
  runner, both entries are kept as they were, ignored as an unknown id is, and
  moved at a later read once one is configured: an expansion to nothing, saved,
  would lose them.
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
- **The prompt** is short and provider-neutral: one task in its own worktree;
  how a long brief is worked through, each rule with its reason (how much work
  remains is never a reason to stop or to report `blocked`; the context is
  compacted for the model; the attempt's step limit, as a fixed number so the
  prompt stays one cached prefix; each coherent part committed as it works,
  when the task commits; `blocked` for an obstacle outside the model's control,
  saying what is missing; near the budget's end, what works committed and an
  honest report, never `done` short of the done criterion); then the completion
  contract every runner is given (ADR-0018 C2,
  [ADR-0047](../supervision/0047-structured-task-handoffs.md)), the same text,
  with the summary's limit and where the rest goes on one line of its own. A
  model that read a large brief as too much for one session reported `blocked`
  with tests passing and nothing committed; nothing outside it had stopped it.
  An environment block (working directory, platform, date, whether it is a git
  repository) follows, then the worktree's AGENTS.md, or else its CLAUDE.md.
  Earlier tasks' handoffs are in the first user message, as `StructuredSession`
  writes it.
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
- **A host's own keys are lent to the runner alone.** The VS Code extension
  keeps the keys a user enters in its SecretStorage, and registers a reader
  for them (`hostCredentials.ts`); the runner's listing, its default, its
  catalog and its start read the provider through it, over the environment.
  The extension host's environment never holds them, so neither a coding agent
  it spawns nor another extension beside it inherits one. The daemon, whose
  keys are its environment, registers none.
- **A mode is never widened.** The runner declares its three modes with
  the autonomous, safe and read-only tags `ModeResolver` reads. An attempt runs
  in the mode it was planned at, and an unknown mode refuses to start rather than
  running as Full ([ADR-0001](../routing/0001-autonomous-mode-resolution.md)). A
  read-only task is read-only whatever level it was planned at.
- **Lifecycle.** An attempt makes at most the step limit's model calls
  (`ordewellStepLimit` in the settings file, default 200); the last is told so and
  forced to `task_complete`. Before it the model is told twice, once it has
  used 80% of the calls and once at 95% (each rounded down), with a message
  appended to the conversation, never a rewritten system prompt: bring the part
  in hand to a committed state, then, at 95%, start nothing new and report what
  is done and what remains. Each goes out at most once an attempt, none while a
  report stands and none on the last call, and two falling due together send
  only the later. The repeat guard nudges the third identical tool call
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
- **One runner, `ordewell` ("Ordewell"), with every keyed provider's models.**
  Chosen first. It read as signed out, with a Log in that offered one
  provider's key, until any key was set, and showed as a planner option on a
  surface that took every non-agent runner for one, though it never plans. The
  same provider then had two names, "Ordewell" as a runner and "OpenRouter" as
  a planner, and one runner's 100-model line in the planner's catalog was
  filled by its first provider. Dropped for one runner per provider.
- **The VS Code extension putting its keys into the extension host's
  environment**, where the runner already reads a key. Rejected: every process
  the host spawns would inherit them, a coding agent included, which may then
  run on that key instead of the user's own login, and so would every other
  extension running in the same host.
- **The default read per workspace, from the variables a listing reads.**
  Rejected: the enabled set is one per host, held by the settings file once
  saved, while a workspace's variables differ by workspace, so the same host
  would default differently by the project it was asked from.
- **One runner per provider under ids of its own (`ordewell-openrouter`).**
  Rejected: it keeps the planner setting's namespace apart, but names one thing
  twice; a planner under a vendor's id is already Ordewell's own loop on that
  vendor, and these runners never plan, so sharing the id costs nothing
  ([ADR-0009](../planner/0009-coding-agents-as-planners.md#a-runner-in-the-provider-axis)).

## Consequences

- A provider key is enough to plan and to run a task: setting one lists, signs
  in and, with no saved choice, enables that provider's runner, beside its API
  planner of the same name. The API planner reaches each provider through the
  same `ModelClient`, by its dialect
  ([ADR-0002](../planner/0002-planner-as-conversation-loop.md),
  [ADR-0044](../planner/0044-the-planners-usage-limit-waits-and-resends.md)).
- The runner list grows by one per provider in code, though a host lists only
  the configured ones; a surface that lists every manifest (the CLI's help)
  names them as provider runners rather than one by one.
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
- 2026-11-16 — one runner per provider under the provider's id and name, installed
  and signed in exactly while that provider is configured, enabled by default
  with its key; the single `ordewell` runner is gone and what named it is moved.
- 2026-11-16 — VS Code's keys reach the runner from its SecretStorage through a
  reader the extension registers, never through the extension host's environment.
- 2026-11-16 — a provider with no model listing has no runner; the default reads
  the host's own keys, not a workspace's; the old id stays where moving it would
  lose a task or a setting.
- 2026-11-17 — the prompt says how a long brief is worked through and the step
  budget, carries every runner's completion contract, and the loop sends the 80%
  and 95% budget notices.
