---
status: accepted
implemented: partial
note: "ACP agents' in-workspace reads, and a harness's native reads that never ask, are not counted yet."
---

# 0068 — A limit on the planner's own reads per turn, off by default

## Problem

The planner envelope
([ADR-0008](0008-planner-exploration-envelope.md)) decides *what* the
planner may read, never *how much*. A planner told to delegate breadth to a
research agent or a research task can still read the same area itself, and
some do: an OpenCode planner on DeepSeek V4.1 Flash went on reading the areas
it had just delegated, whatever the prompt said. Each such read lands in the
planner's context, which is the one context the whole plan depends on. The
prompt alone did not stop it, so a rule that does not depend on the model
following the prompt is needed for the models that do not.

## Decision

**When the planner read limit is on, the planner's own read-class calls in one
turn are counted, with the bytes their results held, and past either limit
every further one is refused for the rest of that turn.** It is off by default
and set in the settings file as `plannerReadLimit` (`true`, or `{ calls, kb }`)
or by `ORDEWELL_PLANNER_READ_LIMIT` (`on`, `off`, or `<calls>,<kb>`), which
wins; turned on without numbers it is 10 calls or 60 KB, whichever comes
first. One module, `PlannerReadLimit`, keeps the count per planner turn; the
session builds one and every path below asks it.

## Key properties

- **Narrowing only (R1).** The limit refuses calls the envelope would have
  allowed; it never allows one the envelope refuses. A call is admitted before
  the envelope decides it and given back if the envelope refuses it, so a
  refused read costs nothing.
- **Only the planner's own reads (R2).** A research agent's or a research
  task's reads are never charged, nor a harness subagent's native read. Web
  reads have their own budget.
- **The refusal says where the rest goes (R3).** It says how much the planner
  has read this turn and tells it to delegate what is left to a research agent
  or a research task, naming the area. The planner's budget block shows what
  is left while the limit is on.
- **Plan, task, delegation and completion tools are never refused (R4).** Only
  read-class calls are counted: the API planner's read tools and `bash`,
  `run_command`, and a harness's native reads and shell.
- **True bytes (R5).** A result is charged at its full length before any
  truncation for the log or the model.

## Where reads are counted

| Path | Seam |
| --- | --- |
| API planner's read tools and `bash` | `BaseAiService.executeToolCalls`, in call order before any runs |
| `run_command` from a harness planner | the session's own command path (`ownCommand`) |
| A harness's native reads and shell (Claude Code, Codex, OpenCode) | the permission request, at `CliAgentAiService`, when its ask is `path`, `native-shell` or `native-read`; bytes at its `tool_result` |
| OpenCode's `read`, `glob`, `grep`, `list`, `lsp` | made to ask (`readsAsk`) while the limit is on, both in 1.x's config and in 2.x's session rules, and asked as `native-read`, which the envelope allows |

## Out of scope

- **ACP agents' in-workspace reads.** An ACP agent reads with its own tools and
  asks only for what its own policy asks, so a read it does not ask about is
  not seen. This is why the ADR is `implemented: partial`.
- **A native read that never asks** on any harness, and a request with no
  tool-call id, whose bytes cannot be matched to a result (its call still
  counts).
- **The one-shot planner path**, which has no conversation turn to count in.

## Considered options

- **Stronger prompt wording.** Rejected: it is what was tried, and the model
  kept reading.
- **A token limit on the planner's context.** Rejected: it stops the turn
  rather than the read, and says nothing about where the reading should go.
- **On by default.** Rejected for now: a capable planner reads well past ten
  files on a hard goal and plans better for it. The bench's V2 variant
  (`bench/planner-eval`) measures the limit against V1 before any default
  changes.
- **Counting a harness subagent's `run_command`.** It is counted, because the
  harness's subagents share the planner's MCP token and nothing tells them
  apart there; a native subagent's own reads are not.

## Consequences

- An OpenCode planner's reads raise a permission request each while the limit
  is on, and the setting is read when its session starts: turning the limit on
  mid-conversation counts OpenCode's native reads from the next session. A
  read outside the workspace raises both `external_directory` and its read,
  so it can count twice.
- A planner that hits the limit must say what it wants read, which is the
  point, and may plan with less than it would have read itself.

## History

- 2026-11-11 — accepted.
