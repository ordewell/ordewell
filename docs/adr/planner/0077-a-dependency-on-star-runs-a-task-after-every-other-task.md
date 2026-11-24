---
status: accepted
amends: ["0072"]
---

# 0077 — A dependency on "*" runs a task after every other task that does not come after it

## Problem

A closing check (the task that runs the whole suite and fixes what fails, an
integration check, a final review) has to wait for every other task, and a
planner says so only by listing each of them in its dependencies. A recorded
one-shot plan's final "run the full suite and fix" task listed 34 of its 38
other tasks and missed 4, so it could start while they still ran. In a
conversation plan the list goes stale as the plan changes: a task added later
is not in the closing check's list unless the planner remembers to put it
there, and nothing tells it to.

## Decision

**In the `dependencies` of a top-level task, the entry `"*"` means: after
every other top-level task that does not itself come after this one, directly
or through others; core reads it from the plan as it stands each time, and
never writes it out into the stored list.** There is no new field: a planner
writes `"dependencies": ["*"]` on its closing check, or `"*"` beside ids it
names (which are then redundant), through `submit_plan`, `edit_plan`, a text
reply's plan or task ops, and a user's edit alike. Because the stored list
keeps `"*"`, a task added, removed, split or merged later is covered, or let
go of, without anyone touching the check.

`AfterAll.ts` holds the rule, and every reader of what a task waits on goes
through it (`afterAllReader`, or `resolveAfterAll` for a walk that reads lists
straight off the tasks): the held dependencies (`heldDependencies`), so the
start rule, the blocked rule (ADR-0034), the merge gate (ADR-0020) and a
subtask's inherited waits; the order repair (`PlanGraph.repairOrder`); the
handoffs a task is given and may read (ADR-0047); what lands beside a task and
what a revert reaches; the fan-out shape and the chain review (ADR-0072); and
the surfaces' rows and graph, through `@ordewell/core/plan-utils`. A surface
that names a dependency names `"*"` as "after all other tasks".

## Key properties

- **What "*" stands for (A1).** Every other top-level task, after the ids the
  list names, except: a task that comes after this one, by a stated edge,
  directly or through others, a whole top-level task at a time (one whose
  subtask waits on this task or one of its subtasks comes after it); a
  research task, which reports to the planner and lands nothing; a loop's
  body, which runs only for its check and is waited for through it (ADR-0045
  L3, L4); and every other `"*"` task and whatever comes after one. A PR
  opener after the closing check, a loop's fix after its check, and a task
  after a loop are left out by construction, so phases in sequence still work.
- **Two "*" tasks (A2).** They do not wait for each other, nor for each
  other's followers, unless one names the other. That is also why `"*"`
  closes no cycle: a task it stands for reaches no `"*"` task through stated
  edges, so a cycle through one is a cycle the stated edges already make, and
  the plan's cycle check, which reads stated edges, refuses it.
- **Top-level only (A3).** A subtask that holds `"*"` is refused with why: it
  already waits for what its parent waits for. A loop's body task that holds
  it is refused too, since it depends only on its check, on what its check
  depends on, and on its fellow body tasks.
- **Never written out (A4).** The stored plan, the session file and every
  snapshot keep `"*"` as written. A session saved before this decision has no
  `"*"` and reads exactly as it did.
- **A started "*" task stays where it is (A5).** The order repair puts a
  pending `"*"` task after everything it stands for, so a closing check
  follows a task added after it. A running or finished one is read by the ids
  it names alone there: work added once it started is not work it ran after,
  and moving it is what pinning refuses.
- **The chain review keeps it (A6).** A review reply that gives a `"*"` task a
  list without `"*"` gets `"*"` back, and the rest of the reply stands: `"*"`
  is no edge the chain question judges. A reply may name `"*"` itself; on a
  plan that fans out, an added `"*"` is kept only where it stands for no task
  the waiting one did not run after as written (ADR-0072 R1).

## Testing decisions

`AfterAll.test.ts` pins the rule on plain tasks: followers, a subtask's edge,
research, loops, two `"*"` tasks, the acyclic case, a task added or removed,
a flat list, a subtask, a task the plan does not hold yet, and the store's
round trip. Each consumer is tested through its own seam, not the resolver:
`readiness.afterAll.test.ts` (waits, skip, retry, removal, a failure, a
subtask, a script task's merge gate, a loop between rounds),
`afterAll.validation.test.ts` (intake, the one-shot id reading, the subtask
and loop-body refusals, cycles, a dependency edit), `TaskOps.afterAll.test.ts`
(add, a completed check, update, split, merge), `handoff.afterAll.test.ts`,
`PlanChainReview.afterAll.test.ts`, the task row and the desktop graph. The
planner bench (`bench/planner-eval`) reads `"*"` the same way, so its width,
path and closing-check metrics measure the plan the scheduler runs.

## Out of scope

- The one-shot planner's prompt, whose dependency wording ADR-0072 R4 holds
  as measured: it does not mention `"*"`, and the one-shot intake accepts it.
- Groups of tasks, id patterns or any other set a dependency could name.
- A delegated task's check: it is still a task that names the delegated task
  directly (ADR-0055 D8), and `"*"` makes no task one.

## Considered options

- **An explicit "after all" field on the task.** Rejected: a second way to say
  what `dependencies` says, which every route a plan arrives by, every edit
  and every surface would have to learn, and which could disagree with the
  list beside it.
- **Ordewell guessing the closing check and filling in its waits.** Rejected:
  telling a closing check from a task that merely comes late is a judgement
  about the plan's meaning, and the planner, not Ordewell, owns it. A guess
  written into the stored list would also go stale exactly as a planner's
  list does.
- **Groups or id patterns (`"slice-*"`, a named set).** More flexible, but more
  text for the planner to learn and to get wrong, and more ways for a pattern
  to match a task it did not mean; the problem is one shape, the task after
  everything, and one token answers it.
- **Reading "after" over every edge, `"*"` ones included, as the only rule.**
  Rejected: two `"*"` tasks each with a follower then wait on each other's
  followers, which can close a cycle the plan never wrote. Leaving out what
  follows another `"*"` task makes that impossible.

## Consequences

- A closing check stays last however the plan changes, and a planner writes
  one token for it.
- A reader that walks dependencies without `AfterAll` reads `"*"` as an id
  naming no task, and so as no wait: a new walk must go through it.
- What a `"*"` task waits for is not visible in its stored list; the surfaces
  say "after all other tasks", and the graph draws the edges it stands for.

## History

- 2026-11-24 — accepted.
