---
status: accepted
implemented: partial
note: "An ACP agent's read that its own policy lets through without asking is counted but cannot be refused, and Claude Code's MCP resource tools are not counted."
---

# 0068 — A limit on the planner's own reads per turn

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

**The planner's own read-class calls in one turn are counted, with the bytes
their results held, and past either limit every further one is refused for the
rest of that turn.** The limit is on by default, at 10 calls or 60 KB,
whichever comes first. The settings file's `plannerReadLimit` (`true`,
`false`, or `{ calls, kb }`) or `ORDEWELL_PLANNER_READ_LIMIT` (`on`, `off`, or
`<calls>,<kb>`), which wins, changes the numbers or turns it off. One module, `PlannerReadLimit`, keeps the count per planner turn; the
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
- **Every harness's native reads are reached, by the means it allows (R6).**
  Claude Code's `Read`, `Grep`, `Glob`, `LS` and `LSP` ask, and are counted and
  refused at the permission request. An `LSP` read is *confined*: allowed only
  inside the workspace and never offered for approval outside it, since a
  language server answers from the whole project it indexed. OpenCode's reads
  are made to ask. Codex never asks about a read of its own, so while the limit
  is on its shell, `unified_exec` and `view_image` are turned off and every read
  goes through `run_command`, which is counted and refused. An ACP agent's
  asked single-path read or search is counted and refused at the request; one
  its own policy lets through unasked is counted from its result and cannot be
  refused, so the asked reads after it are refused once the turn is past the
  limit.

## Where reads are counted

| Path | Seam |
| --- | --- |
| API planner's read tools and `bash` | `BaseAiService.executeToolCalls`, in call order before any runs |
| `run_command` from a harness planner | the session's own command path (`ownCommand`) |
| A harness's native reads (Claude Code, OpenCode, ACP) | the permission request, at `CliAgentAiService`, when its ask is `path`, `native-shell` or `native-read`; bytes at its `tool_result` |
| A Codex planner's reads | `ownCommand`: with the limit on, Codex's own shell and `view_image` are off, so every read is a `run_command` |
| An ACP read that was never asked | `PlannerReadLimit.record`, from its `tool_result` marked `unaskedRead`: counted, not refused |
| OpenCode's `read`, `glob`, `grep`, `list`, `lsp` | made to ask (`readsAsk`) while the limit is on, both in 1.x's config and in 2.x's session rules, and asked as `native-read`, which the envelope allows |

## Out of scope

- **Refusing an ACP read its agent never asks about.** The tool call reaches
  Ordewell once the read has run, and ACP has no hook like OpenCode's
  `readsAsk`, so it is counted and not refused. This, with the next item, is why
  the ADR is `implemented: partial`.
- **Claude Code's MCP resource tools** (`ListMcpResourcesTool`,
  `ReadMcpResourceTool`, `ReadMcpResourceDirTool`) read MCP servers' resources,
  not the workspace, and have no ask rule: they are not counted.
- **A request with no tool-call id**, whose bytes cannot be matched to a result
  (its call still counts).
- **The one-shot planner path**, which has no conversation turn to count in; a
  one-shot Codex planner keeps its own shell.

## Considered options

- **Stronger prompt wording.** Rejected: it is what was tried, and the model
  kept reading.
- **A token limit on the planner's context.** Rejected: it stops the turn
  rather than the read, and says nothing about where the reading should go.
- **Off by default.** First chosen, pending the planner bench: a capable
  planner reads well past ten files on a hard goal and might plan better for
  it, so the default was to change only if plans did not get worse. The bench
  (`bench/planner-eval`, V2 against V1) met that on the breadth goal G5 with
  OpenCode planners on two models: the planners' own reads after their first
  delegation fell with the limit, and the plans were no worse on the rubric.
  The sample is small. Dropped for that reason.
- **Counting a harness subagent's `run_command`.** It is counted, because the
  harness's subagents share the planner's MCP token and nothing tells them
  apart there; a native subagent's own reads are not.

## Consequences

- An OpenCode planner's reads raise a permission request each while the limit
  is on, and the setting is read when its session starts: turning the limit on
  mid-conversation counts OpenCode's native reads from the next session. A
  read outside the workspace raises both `external_directory` and its read,
  so it can count twice.
- A Codex planner under the limit has no shell or image viewer of its own, and
  neither do Codex's native subagents, whose reads then go through
  `run_command` and are charged to the planner's limit.
- A planner that hits the limit must say what it wants read, which is the
  point, and may plan with less than it would have read itself.

## History

- 2026-11-11 — accepted.
- 2026-11-12 — on by default, after the planner bench showed plans no worse.
- 2026-11-12 — native reads of Claude Code (`LSP`), Codex and ACP counted and refused where the harness allows; two gaps remain.
