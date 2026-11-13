---
status: accepted
amends: ["0002"]
---

# 0067 — The planner keeps a decision record, and a checkpoint is seeded with it

## Problem

A **Compaction** or an automatic **Context compaction** replaces everything
before its cut with one prose summary (ADR-0002). The summary is asked to keep
the goal, decisions, constraints and open questions, but it is the model's
paraphrase written at the moment of the cut: a constraint the user stated forty
messages ago comes back reworded or not at all, the reason behind a decision is
dropped as detail, and an option ruled out early is proposed again after the
restart. The longer a planning conversation runs, the more of what it settled
rests on summaries of summaries. Nothing the planner decided was held anywhere
but the conversation itself.

## Decision

**The planner writes a decision record as it goes, through a `record` tool, and
every checkpoint seeds the next context with the record, the user's constraints
verbatim, and a short "where we are" summary of only what the record does not
hold.**

The record lives on the plan (`decisionRecord` on `LegacyPlanState`), persisted
with it and broadcast with it. An entry is one of four kinds, each with an id by
kind and number:

| Kind | Id | Holds |
| --- | --- | --- |
| `decision` | D1, D2, … | What was decided, and its `why` (required) |
| `constraint` | C1, … | The user's own words, verbatim |
| `rejected` | R1, … | The option ruled out, and its `why` (required) |
| `question` | Q1, … | What is still open |

An entry may name an earlier one it `supersedes`. Nothing is edited or deleted.
A superseded entry stays on the plan and drops out of what the planner is told.

The planner is told the record the way it is told the plan block (ADR-0012
T10). It sees the standing entries whole once per live context, in a
`<decision_record>` block grouped by kind. After that it sees only entries it
did not write itself in that context, in a `<decision_record_changes>` block.
What it recorded itself it was answered with. A checkpoint's notice restates the
record whole, so the context the checkpoint starts already holds the record. The
checkpoint stores how many entries the notice restated (`checkpoint.record`).
The next turn tells only what came after those entries.

At a checkpoint the summary turn is given the record and told it is restated
whole beside the summary, so the summary covers where things stand and what
the record does not hold. The checkpoint's notice is the record, then
`Where we are:` and the summary. The same notice is written by every checkpoint:
the user's `/compact` on any backend, and an API planner's automatic compaction
at 90% of the window. With an empty record the notice is the summary alone, as
before.

## Key properties

- **A constraint is the user's words (R1).** A `constraint` entry is refused
  unless its text appears, whitespace aside, in one of the user's messages,
  the open turn's included. A paraphrase must be recorded as a decision.
- **A batch lands whole or not at all (R2).** One call may add several entries.
  If any one is refused, none is kept and the answer names each fault by its
  position, so the planner never reconciles a half-written batch.
- **The record is the open turn's (R3).** Only a planner tool call bound to the
  open turn records. Each entry carries `at`, the transcript index where that
  turn's user message lands. A rewind or fork cut before that index drops the
  entry with the turn (`recordBefore`), and a fork copies the whole record.
- **No secret's value is kept (R4).** Text and `why` go through the summary
  redaction (`redactSummaryText`, ADR-0061 P1) after R1's check has read the
  raw words.
- **The record is bounded (R5).** It holds at most 150 live entries. Past that,
  an addition is refused and the planner is told to supersede what no longer
  stands: a superseding entry replaces a live one, so it is never refused, and
  superseded entries, which no fresh context is told, do not count.
- **The record writes nothing but the plan's own notes (R6).** It changes no
  task and needs no consent, so every planner is offered it: harness planners
  as an Ordewell MCP tool with the read-only hint the other planner tools
  carry, API planners beside the task-read tools. A wake-up turn at Watch
  may record too.

## Testing decisions

- `decisionRecord.ts` is a pure module (add, live, before, render) tested
  through its functions. `PlannerConversation` is tested with a fake AI service
  whose turns call `recordFromTool` while they run, as a real tool call does.
- Each backend's restart is driven end to end with only the agent's binary
  faked: `bench/pipeline/fake-claude` for Claude Code and `fake-acp` for Copilot
  CLI over ACP. The planner records, the user compacts, and the first prompt of
  the fresh agent session must carry the record, the constraint quoted and
  `Where we are:`. The API planner's automatic compaction is driven at 90% of
  the window by the SDK-level fake provider of `plannerAutoCompaction`'s tests.
- Codex and OpenCode have no planner fake. They replay through the same
  harness opening message (`CliAgentAiService.openingMessage`) the Claude Code
  test covers.

## Out of scope

- Drawing the record in the TUI and VS Code. Surfaces get it as
  `decisionRecord` on the serialized plan (`SerializedPlan`), on
  `plan_generated` and every plan broadcast.
- Letting the user edit the record directly. They correct it by telling the
  planner, which supersedes the entry.

## Considered options

- **A better summary prompt alone.** Rejected: a summary written at the cut is
  still a paraphrase of the whole conversation, and each later compaction
  paraphrases it again. What must survive verbatim has to be captured before
  the cut, when it is said.
- **An `edit_plan` op for record entries.** Rejected: `edit_plan` refuses
  without a plan, and recording starts before there is one. On an API planner a
  task-ops reply ends the turn. The op would also pass through the plan-change
  checks, the mandate and Watch, which judge task changes, and it would report
  "Tasks updated" for a note.
- **Extracting the record from the transcript at compaction time.** Rejected:
  it is the same model paraphrasing at the same moment, so it has the faults of
  the summary it was meant to fix.
- **Resending the whole record every turn.** Rejected: it grows with the
  conversation, and an unchanged record tells nothing. It follows the plan
  block's rule instead.
- **Telling the planner its own entries back.** Rejected: the tool's answer
  already carries them, ids included.

## Consequences

- A restart keeps what was settled in the words it was settled in. Getting the
  record right is the planner's job, prompted in WHO EXPLORES, and a record the
  planner never wrote leaves the summary-only checkpoint ADR-0002 describes.
- An API planner's automatic compaction both seeds the record in the notice and
  resets the plan block's count, so the next call is told the record twice.
  This is redundant but correct, and it happens once per compaction.
- Every planner's tool set grows by one tool, which counts against the tool
  definition sizes `toolSetSize.sent.test.ts` holds.

## History

- 2026-11-10 — accepted and implemented: the `record` tool, the record on the plan, and the seeded checkpoint for `/compact` and automatic compaction.
- 2026-11-13 — R5 counts live entries only, so a superseding entry is accepted at the limit; counting superseded ones froze a full record for good.
