---
status: accepted
amends: ["0022"]
---

# 0072 — A long dependency chain is reviewed once, edge by edge, by the planner that wrote it

## Problem

A planner orders tasks by which module calls which, even where the interfaces
the tasks fill in already exist, so a plan whose slices could run at once runs
almost serially: its longest chain of dependencies spans most of its tasks.
Rewording the planner's dependency rules did not stop it. A one-shot plan
(`ordewell plan --no-chat`, unattended runs) is taken as the planner first
writes it, and a conversation planner commits its plan with `submit_plan` and
ends its turn, so nothing asks either one to look at the chain it built.

## Decision

**When a plan's longest dependency chain reaches a threshold, the planner that
wrote it is asked once to review the plan edge by edge, and only the planner
decides what changes.** The question names the chain, task by task, and asks of
every dependency whether the dependent needs a file, name, signature or schema
that does not exist in the repository until the other task writes it; it names
the dependencies other rules require, so it never asks to drop them. How the
question is put depends on how the plan arrives.

- **An API planner's one-shot plan, before it is returned (R1).**
  `BaseAiService.reviewLongChain`, at the end of `researchAndPlan`, makes one
  more call to the planner's model when the first valid plan's longest chain is
  `CHAIN_REVIEW_MIN` tasks or more, at the lowest effort, with the
  planner's prompt and research and the plan as written. The reply is only the
  changed dependency lists (`applyChainReview`), never a plan. Ordewell applies
  them, holds the result to the plan's invariants, and keeps it only when the
  longest chain is shorter; anything else, a reply that does not parse, names an
  unknown task, breaks an invariant or does not shorten the chain, leaves the
  first plan as it was. Ordewell also refuses, whatever the reply says, one
  that leaves an ops, script or user task, or a loop's check, a subtask among
  them, no longer waiting for a task it waited for, directly or through others,
  counted with the merge gate's own walk, which passes through subtasks and
  their parents' dependencies: the merge gate and the check rest on those
  ancestors, and the question asking to keep such edges does not ensure it. A redundant direct edge may still go. An entry for a
  subtask, which the plan shows but the review does not revise, is ignored and
  logged. A changed brief, a delegated task's goal included, gets a
  `Plan revision:` note, last, that names what it no longer waits for even
  through another task. The research log records each review and its outcome,
  and the call's usage is the planner's.
- **A reply the output limit cut off is asked for once more (R2).** The second
  call carries only the plan and the question, at the lowest effort and the
  longest reply the model serves; a second cut-off or an invalid reply leaves
  the first plan. It runs on `repairLoop`, with one repair.
- **A plan through `submit_plan`, after it is committed (R3).** A conversation
  planner's accepted `submit_plan`, and a coding agent's in a one-shot session,
  answers with a `review` beside the plan when its chain is
  `TOOL_CHAIN_REVIEW_MIN` tasks or more: once a turn in the conversation, once a
  session in a one-shot. The plan is committed (in a one-shot session, recorded)
  as written and stands unless the planner calls `submit_plan` again, rewording the briefs it changes itself. The
  review is never a refusal, and it tells the planner not to mention it to the
  user.
- **The one-shot prompt words two dependency rules its own way (R4).** It says a
  dependency is for something that does not exist yet, lets the task that
  restores the build edit whatever blocks it, and gives a four-level shape for a
  goal that fills in existing interfaces. The conversation prompt keeps its own
  wording: on a conversation planner the reworded rules may split work that
  belongs in one task.

The review changes no evidence and no envelope. It grades no work, and no
verdict depends on it. The review call reads nothing the planner did not
already have, with no tools. A committed plan is never rewritten by Ordewell:
the one-shot revision happens before the plan is returned, as the planner's
own reply, and a conversation plan changes only through the planner's own
`submit_plan` ([ADR-0022](../runners/0022-ordewell-mcp-server.md) P2).

## Testing decisions

`PlanChainReview` is pure: `longestChain`, `applyChainReview` and the two
messages are tested on plain tasks, and each message is pinned word for word,
since the measured wording is the decision. `reviewLongChain` is tested through
a `BaseAiService` whose `streamPlanText` answers from a queue and keeps what each
call asked for. The `submit_plan` review is tested through `plannerToolHandler`
over a stub host, and the one-shot session's through `CliAgentAiService` with a
scripted adapter. `PlanPrompts.test.ts` pins the one-shot rules and the
conversation's as they stand.

## Out of scope

- `edit_plan`: an edit that lengthens a chain is not reviewed.
- An API planner's one-shot plan with research turned off
  (`generatePlanDirect`): it is not reviewed.
- A plan whose work sits in one task. No chain review reaches it.

## Considered options

- **Rewording the shared dependency rules alone.** Rejected: measured on the
  planner bench and on real plans, the chains stayed.
- **The review returns the whole revised plan.** Rejected: a plan written back
  can be cut off at the output limit, and costs as much as the plan did.
- **Ordewell drops edges it judges spurious.** Rejected: only the planner can
  tell an edge that consumes something from one that only orders work, and the
  plan is the source of truth (ADR-0001).
- **`submit_plan` refuses a long chain.** Rejected: a long chain can be right (a
  serial rename, an expand-contract change), and a refusal makes the planner
  fight the tool instead of weighing the edges.
- **A conversation threshold of 3.** Rejected: most plans it reached were
  already right and were kept as they were, at the cost of a review each, and
  the planner told the user of the review more often.
- **The conversation prompt takes the one-shot wording too.** Rejected: with it,
  a conversation planner split work the bench keeps in one task more often, and
  the review alone made its plans fan out.
- **Re-sending the whole planner prompt after a cut-off.** Rejected: the same
  prompt at the same allowance invites the same cut-off, and pays for the
  research again.

## Consequences

- A one-shot plan with a long chain costs one more planner call, two when the
  first is cut off; a conversation plan with a long chain may cost one more
  `submit_plan` in the same turn.
- The one-shot and conversation prompts differ in two dependency rules, so a
  change to either is measured on its own path.
- The thresholds and the wording were measured on a few goals and models; watch
  plans whose closing check or restoring task is dropped.

## History

- 2026-11-18 — accepted.
- 2026-11-18 — R1: Ordewell refuses a reply that drops an ancestor of an ops, script or user task or a loop's check; the note names only dependencies no longer reached and reaches a delegated task's goal; a subtask entry is ignored.
- 2026-11-18 — R1: the guard counts ancestors with the merge gate's walk, so a path through a subtask is held too.
