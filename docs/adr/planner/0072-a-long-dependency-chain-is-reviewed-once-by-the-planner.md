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

A one-shot plan that does fan out over code whose parts call each other (a
library whose bodies are stubs) needs three things around its slices: one short
task before them that makes the project import and collect its tests, a done
criterion each slice can meet in its own worktree, and one check after them all.
Told so in words, the planner still wrote three opening tasks in series, none,
or no closing check, and its slices kept iterating against siblings that were
still stubs, so a slice that had done its own part failed, and a failed
dependency blocks the closing check that waits for it.

## Decision

**When a plan's longest dependency chain reaches a threshold, the planner that
wrote it is asked once to review the plan edge by edge, and only the planner
decides what changes. The review asks that chain question and nothing else; a
wide one-shot plan's fan-out shape is read by Ordewell and noted on each role's
brief, never asked about.** The question names the chain, task by task, and asks of
every dependency whether the dependent needs a file, name, signature or schema
that does not exist in the repository until the other task writes it; it names
the dependencies other rules require, so it never asks to drop them. How the
question is put depends on how the plan arrives.

- **An API planner's one-shot plan, before it is returned (R1).**
  `BaseAiService.reviewLongChain`, at the end of `researchAndPlan`, makes one
  more call to the planner's model when the first valid plan's longest chain is
  `CHAIN_REVIEW_MIN` tasks or more, and only then, at the lowest effort, with the
  planner's prompt and research and the plan as written. The reply is only the
  changed dependency lists (`applyChainReview`), never a plan. Ordewell applies
  them, holds the result to the plan's invariants, and keeps it only when the
  longest chain is shorter; anything else, a reply that does not parse, names an
  unknown task, breaks an invariant or does not shorten the chain, leaves the
  first plan as it was. The reply adds no task. Ordewell also refuses,
  whatever the reply says, one that leaves an ops, script or user task, or a loop's check, a subtask among
  them, no longer waiting for a task it waited for, directly or through others,
  counted with the merge gate's own walk, which passes through subtasks and
  their parents' dependencies: the merge gate and the check rest on those
  ancestors, and the question asking to keep such edges does not ensure it. A redundant direct edge may still go. An entry for a
  subtask, which the plan shows but the review does not revise, is ignored and
  logged. A changed brief, a delegated task's goal included, gets a
  `Plan revision:` note, last, that names what it no longer waits for even
  through another task, and tells it to take in that work once it has landed
  and until then leave the tests that need it to the closing check. The research log records each review and its outcome,
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
- **A wide one-shot plan's shape is read and noted, never asked about (R5).**
  `fanOutShape` (`PlanFanOut.ts`) reads the shape from the top-level
  dependencies alone, and only of a plan where `FAN_OUT_MIN` or more slices sit
  at one level. A change task edits the repository and is not research, an ops
  task, a loop's check or in a loop's body. Its *opening task* is the first
  change task every slice waits for; a later one that waits for it alone, or
  for an install or a manual step besides, is a shared module the slices build
  on. Its *slices* are the change tasks not ordered against every other one.
  Its *closing check* waits for every slice and can fix what still fails (an AI
  task that edits, or a loop's check whose body holds one; an ops task, a
  manual task, a script that may push and a read-only check with no such loop
  never count), and no other such task waits for it. A change task the closing
  check waits for that itself waits for every slice only implements one more
  module, so it is a slice of the last level, unless it is the only candidate.
  The shape's faults (opening tasks in series, no opening task, no closing
  check) are recorded in the research log and asked of no one. After R1, at no
  call, a wide plan with a closing check gets a fixed `Plan shape:` note
  appended to each role's brief, on the plan R1 kept. The opening task's note
  says to stay short and to end its report with a module map, and lists every
  task with the paths its brief names. A slice reads that map with `read` and
  `include_report`. A slice's note says its own scope is its done criterion: a
  test that fails only because a sibling's code has not landed, or that the
  repository does not let it derive, is listed as a finding and does not stop
  it ending done, and `failed` is for code in its scope not being in place. Its
  table gives each task one line with the first path its brief names, at most
  `SLICE_TABLE_MAX` characters, then how many more there are and where: the
  opening task's module map, or, with no opening task, that a module its brief
  does not name is another task's. The closing check's note, on the fix task of
  its loop when the check is a script or read-only, says to write the module of
  a slice that did not land. A brief that holds a `Plan shape:` note already
  gets none again. The research log records the shape whenever notes are added.
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
since the measured wording is the decision. `PlanFanOut` is too: the shape and
the three notes, each pinned word for word, the slice table's bound on a plan of
forty slices; that a slice can read the opening task's report is tested through
a session. That a wide plan with a fault and a short chain makes no review call,
and a long one is asked R1's message word for word, is tested through
`reviewLongChain`. `reviewLongChain` is tested through
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
- The harness one-shot path (`CliAgentAiService.oneShot`, where the review rides
  on `submit_plan`'s answer, R3): its plans are not read for their fan-out shape
  and get no `Plan shape:` note yet. Neither does a conversation plan.
- The run time: a failed slice still blocks the closing check (a skip releases
  it, and lands nothing), and the closing check cannot reach a failed slice's
  unlanded work. R5's slice note makes the slice end done instead wherever its
  own scope is in place.

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
- **Telling the planner the fan-out shape in its prompt alone.** Rejected: it
  still wrote serial opening tasks, none, or no closing check, and the
  one-shot prompt's wording is measured on its own (R4).
- **Ordewell rewires a faulty shape itself.** Rejected for the same reason as
  dropping edges: which task makes the project import, and which shared module
  most slices need, only the planner can tell.
- **The shape's faults asked in R1's review call.** Tried and dropped. Each
  fault was put to the planner as a question of its own, the call made for a
  fault even under the chain threshold, and the reply could add the restoring
  task or closing check a fault asked for, which Ordewell wired in. Measured on
  real planning-only plans it made them worse than the chain question alone:
  where it was asked the opening mostly stayed serial, some replies were
  rejected whole so the chain fix they carried was lost too, and one library's
  chains got longer. The role notes, which need no call, were present and right
  in every plan, so they stay.
- **A separate call for the shape.** Rejected: it costs a call for what the
  notes do without one, and the questions failed even on R1's call.
- **The planner writes each role's done criterion.** Rejected: the criterion is
  a contract with the run time, and the slices of one plan need it the same
  way. Ordewell writes it, the same way every time.
- **A closing check that starts once every slice has ended, landed or not.**
  Not taken here: it is a run-time change to readiness, outside the plan. The
  slice note keeps a slice whose own scope is in place from failing instead.
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
- A wide plan's shape costs no call: its faults are only recorded, so a plan
  with no opening task or no closing check keeps that fault unless the chain
  question's reply happens to mend it. `FAN_OUT_MIN` is not tuned yet, and the
  notes are worded as their measurement takes them.

## History

- 2026-11-18 — accepted.
- 2026-11-18 — R1: Ordewell refuses a reply that drops an ancestor of an ops, script or user task or a loop's check; the note names only dependencies no longer reached and reaches a delegated task's goal; a subtask entry is ignored.
- 2026-11-18 — R1: the guard counts ancestors with the merge gate's walk, so a path through a subtask is held too.
- 2026-11-18 — R5: a wide one-shot plan's fan-out faults ride on R1's call, its reply may add the task a fault asks for, and each role's brief gets a `Plan shape:` note; R1's revision note lets a slice take in landed work.
- 2026-11-18 — R5: a read-only check counts as the closing check only through a loop whose body edits; an added restoring task waits for what every slice waited for; R1's revision note has a slice name the tests it leaves in findings.
- 2026-11-19 — R5: the fault questions and the tasks a reply could add are dropped after failing their measurement; R1 asks the chain question only, the notes go to the closing check no other waits for and the first opening task, and a slice's table is bounded.
