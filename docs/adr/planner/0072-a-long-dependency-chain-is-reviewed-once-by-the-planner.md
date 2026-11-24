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
brief, never asked about, the tasks every slice waits for are held to leaving
the project importing and its tests collecting, the tasks before its slices,
then its slices largest first, are started first, and its slices are never
merged, however many queue past the run's parallel limit.** The question names the chain, task by task, and asks of
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
  ancestors, and the question asking to keep such edges does not ensure it. A redundant direct edge may still go.
  A `"*"` in a task's list ([ADR-0077](0077-a-dependency-on-star-runs-a-task-after-every-other-task.md))
  is no edge the question judges: a reply that drops it gets it back, every
  walk here (the chain, the ancestry, the fan-out shape) reads what it stands
  for, and one a reply adds is a wait on each task it stands for.
  The first plan's closing check, as R5 reads the plan as written, when it is
  an AI task that edits, is held too, but the other way: a reply that leaves it
  no longer waiting for a top-level task it waited for, directly or through
  others, is applied with the check waiting directly for the fewest such tasks,
  those no other of them reaches, and every other change the reply made
  stands. A reply that cut the task the check reached the slices through, a
  sweep cut to the opening task, otherwise left a plan with nothing after the
  slices, so the check ran beside them and shaping read no closing check. This
  is not Ordewell dropping or adding edges by its own judgement: it keeps an
  ancestry the planner wrote and the review's message asked it to keep, judges
  no edge, and the check runs after what it ran after. Its brief gets no note
  for them, since it ran after them before, and the research log says how many
  it got back. A task given back that the reply set after the check rejects the
  whole reply. A reply to a plan whose first version fans out is held on two
  more points. It makes no task wait on more than the plan as written: a wait
  it adds is kept only on a task the waiting one ran after in the first plan,
  directly or through others, which is what flattening a chain does, and any
  other is dropped while the rest of the reply stands, and the task gets back,
  directly, the fewest of the tasks it ran after as written that the dropped
  wait ran after too, since the reply took them away to set it after that task
  and would otherwise leave it waiting for neither. A recorded reply set
  every slice after every task before the fan-out, where as written few waited
  for the last of them, which then held them all. The tasks before the slices
  may still be put in another order among themselves: a replayed reply that
  moved the task restoring the import first kept every fan-out property, and
  dropping its waits lost the opening. And a slice the reply left no longer
  running after the first plan's opening task gets back, directly, the fewest
  of the tasks before the slices that every slice ran after as written, those
  no other of them reaches: a recorded reply cut every slice from a three-task
  opening and left the plan none. A slice still after the opening task keeps
  the reply's list, since replayed replies that let slices skip shared modules
  they did not need kept every fan-out property, and holding the slices to
  those modules lost their parallel width. A brief is told of neither, since a
  dropped wait never reaches it and a wait given back was waited for before;
  the research log counts both and names as changed only a task whose waits
  differ from the plan as written. A wait given back that would close a cycle
  leaves the plan's invariants refusing the whole reply. A plan whose first version does not fan out, a loop's check
  (held as above) and subtasks' dependencies are left as the reply has them. An entry for a
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
  on. A change task every slice of the fan-out's level waits for runs before
  the slices too, though tasks beside it do not wait for it: the level is the
  one holding the most change tasks not ordered against every other one, the
  first on a tie, counted without a task every deeper one waits for where those
  deeper hold a level of `FAN_OUT_MIN` or more (a last task that waits for only
  some slices makes none of them such a task), and only a level of
  `FAN_OUT_MIN` or more takes any. So the tasks before the slices are still
  read when they form a chain, when a catch-all task hangs off the opening task
  beside the slices, and when the last task waits for only some slices. These, first to last, are the tasks
  *before the slices*; the opening task is the first of them only when every
  other waits for it, and with none such the plan has no opening task. Its
  *slices* are the change tasks not ordered against every other one and not
  before the slices.
  Its *closing check* waits for every slice and can fix what still fails (an AI
  task that edits, or a loop's check whose body holds one; an ops task, a
  manual task, a script that may push and a read-only check with no such loop
  never count), and no other such task waits for it. A change task the closing
  check waits for that itself waits for every slice only implements one more
  module, so it is a slice of the last level, unless it is the only candidate.
  Change tasks after every other one that are not ordered against each other,
  fewer than a fan-out (a closing check and its docs, say), are the closing
  check and the tasks beside it, not slices: the closing check is chosen among
  them as among any candidates, and the others get no note.
  The shape's faults (opening tasks in series, no opening task, no closing
  check) are recorded in the research log and asked of no one. After R1, at no
  call, a wide plan gets a fixed `Plan shape:` note appended to each role's
  brief, on the plan R1 kept, each role's note standing on its own
  (`fanOutRoles`): the opening task's whenever there is an opening task, every
  other task before the slices' likewise, the slices' whenever a level holds
  `FAN_OUT_MIN` slices, and the closing check's only when there is one; that
  one is told, by directory, of the test files no brief of the plan names
  (listed from the repository root through the planner's file system, at most
  `MAX_SIZED_FILES` a listing and `UNNAMED_BUDGET_MS` in all, none when a
  listing fails), a file counting as named when a brief names it, its bare
  name, its directory, the package it tests or a file directly in it, a dotted
  module name, a file of the same stem, or a recursive glob above it, so that
  code is written once the slices' work is in; a note with nothing unnamed is
  as it was. With
  no closing check, fewer last tasks than a fan-out that wait for several
  slices, and that no slice waits for, get no note: such a task gathers only
  some slices' work, as a last check does, and a slice's note would forbid it
  the fixing it is there for. A task after one slice alone carries that
  slice's module on, and is told as a slice. A plan that does not fan out is left as it is. The slices start from the
  tree the tasks before them land, so each of those is done, besides its own
  brief's criterion, only when the project builds or imports and the test
  command the slices' briefs run (the project's own, if they name none)
  collects its tests without an error, tests may still fail, and its report
  shows each command and the end of its output. Those two checks are named,
  building or importing the project and a collection-only run of the test
  runner where it has one, and the note says the full test suite is not part
  of them: the slices and the closing check run the tests (the slices alone,
  in a fan-out with no closing check). The opening task's note says
  so, lets it edit any file for that alone, whichever task owns it, adding the
  smallest placeholder and listing each one with its owner, says to end
  `failed` when the project still does not import or collect for a cause in
  the repository's code, and to report a cause outside it that no placeholder
  fixes (a dependency that is not installed) as a finding and end `done`,
  since the slices would wait on a failure no task of the plan can mend, says to stay
  short and to end its report with a module map, and lists every
  task with the paths its brief names, read before any note Ordewell appended,
  since a `Plan revision:` note names other tasks by title. Every other task
  before the slices is told the slices wait for it and to leave the import and
  the collection as it found them or better, with no licence beyond its brief.
  A slice's note names the tasks before the slices that it waits for, and
  only a slice that waits for the opening task reads its map, with `read` and
  `include_report`. A slice's note says its own scope is its done criterion: a
  test that fails only because a sibling's code has not landed yet, or that the
  repository does not let it derive, is listed as a finding and does not stop
  it ending done, a sibling's work is taken in once it has landed, as the
  runner's note on work landing beside it says, and `failed` is for code in its scope not being in place.
  It names the closing check that runs the whole suite after the slices and
  takes those tests; with no closing check, both clauses are left out, and the
  note says only to list them and end done. Its
  table gives each task one line with the first path its brief names, at most
  `SLICE_TABLE_MAX` characters, then how many more there are and where: the
  opening task's module map, or, with no opening task, that a module its brief
  does not name is another task's. The closing check's note, on the fix task of
  its loop when the check is a script or read-only, says to write the module of
  a slice that did not land. A brief that holds a `Plan shape:` note already
  gets none again. The research log records the shape whenever notes are added.
  The supervisor's wake about a task, whether it is running long, at its
  context threshold or failed, names the task's role after the line's own
  facts and outside their cut, in a few fixed words (`FAN_OUT_ROLE_WORDS`):
  for the opening task, that it may edit any file to make the project import
  and its tests collect. The role is the one the `Plan shape:` note on the
  task's brief was written for (`notedRole`), read as the wake goes out: a
  task whose brief holds no note (on a conversation plan, a harness planner's
  one-shot plan, or added after the notes) has none named, and a task keeps
  the role it was told though an edit has moved the plan's shape since. The
  words are Ordewell's fixed ones, not the brief's, since a supervisor that saw
  only the brief once had the opening task revert the edits its note allowed.
- **A wide one-shot plan's slices start largest first (R6).** Ready tasks
  start in plan order, `maxParallel` at a time, so a long slice the planner
  listed late started late and set when the whole fan-out ended. On the plan R1
  kept, before any `Plan shape:` note is written, `largestSlicesFirst`
  (`PlanFanOut.ts`) sorts the slices of each level by size, largest first,
  stably, each taking the place and `order` of the slice it displaced. A task
  before the slices at a level with slices beside it takes the first of those
  places, sized or not, since every slice of the fan-out waits for it. The
  closing check, every other task and every dependency stay as they are, and
  the notes, written after, list the slices in the order they start. A
  slice's size is the lines of the test files its brief names, read from the
  brief before any appended note, every path it names (the notes' tables list
  at most `MAX_PATHS`, the sizing all of them), the test files under a test
  directory it names by a path (`pkg/flow/tests/`), and a test file it names
  by its bare name (`test_flow.py`) where exactly one file of that name lies
  under the directories of the paths it names whole and the test directories
  it names; a bare name beside a full path ending in it is that file, and one
  that matches no file or several reads as written. A file several slices name
  is counted in equal shares; when
  no slice names a test file that exists, the lines of every file its brief
  names; when none of those exists, there is no size and nothing moves. The
  lines are read through the planner's own file system, which
  `researchAndPlan` hands to `reviewLongChain`, and the directories are listed
  through its glob, whose rows the daemon's `PoolFileSystem` (and
  `VsCodeFileSystem`, below the workspace) writes relative to the directory
  listed: at most `MAX_SIZED_FILES` files
  a plan, else nothing moves, at most `MAX_SIZED_LISTINGS` listings, else none
  is made and the paths the briefs name whole size the slices, a file past
  `MAX_SIZED_KB` or `MAX_SIZED_LINES`
  counts as absent, a directory whose listing fails or is cut short, or a file
  system with no glob, lists nothing, a path that climbs out of the workspace
  is not read, and no content reaches a prompt. The research log records the measure and how
  many slices moved, and how many tasks before the slices moved ahead of them. Which slice finishes first is a guess from its files,
  never a verdict: it changes when a slice starts, not what it must do.
- **A wide one-shot plan's slices are never merged (R7).** However many
  slices a level holds past the run's parallel limit, each stays the task the
  planner wrote: Ordewell orders them (R6) and notes them (R5), and merges
  none. A slice pays a fixed run of calls before it does any work (finding its
  way, taking in sibling work, writing its handoff), and slices past the
  limit only queue, so merging the small ones looked free. Replayed on the
  recorded minutes of unattended library runs, with the slices sized as R6
  sizes them and started largest first, it was not: merging toward twice the
  limit, and merging with each bin capped at one and a half, two or three
  times the level's median slice, all started the closing check later, in
  the typical case or the slow one, than largest first alone. A merged task
  runs its slices one after another in one worktree, so its last slice
  starts only when the others end, while largest first already keeps the
  slots full, and a merged task pays its larger context again on every call.
  The rule that settled it, fixed before the replay was run, took the variant
  with the best median closing start over the runs whose slow case was no
  worse than largest first's by more than two minutes, and on a tie the one
  that merges less. The limit (`maxParallelSessions`) still reaches plan
  shaping as `PlannerModes.parallelLimit`, and no step reads it. A plan saved
  by a build that did merge holds merged tasks: each keeps the id of its
  first slice, records the others in `mergedSlices` and gives each slice's
  brief whole under `Slice N of M: <title>`, then one done criterion, and R5
  and R6 read such a brief slice by slice, so its paths and its size are its
  slices' together.
- **The shaping runs in one order, each step on the plan the step before it
  left (R5, R6).** On the plan R1 kept, `shapeFanOut` (`PlanFanOut.ts`),
  which `reviewLongChain` calls, reads the shape, the tasks before the slices
  with it (R5); starts those tasks ahead of the slices beside them, then the
  slices largest first (R6); then writes each role's note (R5), so the notes
  and the research log's lines describe the plan that runs.
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
since the measured wording is the decision. R1's hold on the closing check is
tested on a sweep cut to the opening task, the check's own list emptied or
moved to the first wave, another task set after it, two candidates side by
side and in a row, subtasks, a task given back that the reply set after the
check, a loop's check and a plan that does not fan out; and, on the shape of a
recorded plan whose final check reached half its slices through a sweep the
reply cut, that shaping notes it as the closing check and the log says how
many it got back, through `reviewLongChain`. Its two holds on a reply to a plan
that fans out are tested on the shapes of two recorded plans, every slice set
after all thirteen tasks before the slices and every slice cut from a
three-task opening, and on a flattening kept, a reordered opening, a wait that
would set the opening after a slice, and a plan that does not fan out.
`PlanFanOut` is too: the shape and
the three notes, each pinned word for word, the slice table's bound on a plan of
forty slices; that a slice can read the opening task's report is tested through
a session. `largestSlicesFirst` is tested over a file system that answers reads as the
planner's adapters do (numbered lines, a size cap, a line limit, and a glob
that lists a directory's files relative to it, as `PoolFileSystem` does): its
measure, its fallback, equal shares, every path a brief names, a named test
directory, a bare test-file name and the names it leaves as written, a merged
task's brief read slice by slice, the level it keeps and the bounds on reading
and listing; that the notes list the slices in their new order, and the log
line, through `reviewLongChain`; and that no slice merges at any parallel
limit, the plan shaped as with none, through `reviewLongChain`. The tasks
before the slices are tested on the shape of a recorded plan whose slices
waited for two of them, the opening note and the other tasks' note pinned word
for word; that such a task starts ahead of the slices beside it, through
`reviewLongChain`. Each role's note on a plan with no closing check, the slice
note's variant pinned word for word, and the tasks before the slices read in a
chain, beside a catch-all off the opening task and beside a last task that
waits for only some slices, which gets no note. The role a wake names is
tested through `wakeUpDigest`, its words and its place outside the line's cut,
and through `RunSupervision`: the role of the note on the task's brief, none
on a fan-out with no notes, and the note's role kept after an edit moves the
plan's shape. `unnamedTests` is tested over the same file system: the
directories no brief names, largest first, a flat suite read by the name it
tests, a sweep's directory as its own package only, a brief read before its
appended notes, a prose word naming nothing, rows outside the workspace
ignored with no file read, and no list when a listing is cut, fails or passes
the time bound; the closing note's sentence is pinned word for word and cut at
`UNNAMED_MAX`, and `shapeFanOut` lists nothing for a plan with no closing
check or one noted already.
`bench/commit0/reshape.mjs` shapes a recorded plan again through `shapeFanOut`,
sized from its run's repository, and checks it offline. That a wide plan with a fault and a short chain makes no review call,
and a long one is asked R1's message word for word, is tested through
`reviewLongChain`. `reviewLongChain` is tested through
a `BaseAiService` whose `streamPlanText` answers from a queue and keeps what each
call asked for. The `submit_plan` review is tested through `plannerToolHandler`
over a stub host, and the one-shot session's through `CliAgentAiService` with a
scripted adapter. `PlanPrompts.test.ts` pins the one-shot rules and the
conversation's as they stand.

## Out of scope

- `edit_plan`: an edit that lengthens a chain is not reviewed.
- A catch-all task R1's reply cut from the slices it swept: it keeps the
  reply's list and runs beside them as a slice. Only the closing check, and a
  slice's place after the opening task, are held.
- An API planner's one-shot plan with research turned off
  (`generatePlanDirect`): it is not reviewed.
- A plan whose work sits in one task. No chain review reaches it.
- The harness one-shot path (`CliAgentAiService.oneShot`, where the review rides
  on `submit_plan`'s answer, R3): its plans are not read for their fan-out shape
  and get no `Plan shape:` note yet, their slices keep the planner's
  order. Neither does a conversation plan.
- Tasks before the slices in series: they are named (`serial-opening`) and
  counted in the log, and the slices still wait for each. Cutting a slice's
  dependency on a later one needs a slice that can wait for a sibling's landing
  at run time without holding a slot.
- A wide plan with no task before its slices gets none: nothing restores its
  import, and the fault `no-opening` is recorded.
- Shapes still not read as they are meant: a last task that waits for only
  some slices is no closing check, so it is read as a slice and gets a slice's
  note, and the plan records `no-closing`; a catch-all task beside the slices
  is a slice; a shared module that only part of the fan-out's level waits for
  (two modules, each for half the slices), or only the deeper of two levels as
  wide as each other, is a slice, not a task before the slices.
- A gate Ordewell runs itself (a script after the opening task that must exit
  0): only the planner writes a script's body
  ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)), an
  ops script waits for a merge into the user's branch
  ([ADR-0020](../isolation/0020-ops-tasks-and-merge-gates.md)), and Ordewell
  knows no test command a planner's read can prove.
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
- **Refusing a reply that cuts the closing check off from a task it waited
  for**, as one that cuts an ops task's is refused. Rejected: the reply's other
  changes are the chain fix, and refusing it keeps the first plan's whole
  chain. Giving the check back what it waited for keeps both.
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
- **Another size: stubbed functions, tests counted, the brief's length.**
  Rejected: measured against the recorded durations of unattended runs, the
  lines of the test files a brief names predicted a slice's time better than
  counts of stubbed functions or of tests. In one run, whose briefs' test files
  did not tell slices apart, the lines of the files the brief names did better,
  so they are the fallback.
- **Sizing by the paths the notes' table lists.** Replaced: the table keeps a
  brief's first `MAX_PATHS` paths, and briefs list their module files first,
  so on recorded library runs most slices read no test file and started in
  the planner's order, and a test directory or a bare test-file name a brief
  named was read as nothing.
- **The planner asked to put its largest slices first.** Not taken: the
  ordering needs no call, and a change to the one-shot prompt is measured on
  its own (R4).
- **Telling the planner how many tasks run at once.** Not taken. The
  one-shot planner is never told the parallel limit, and its rules say to put
  every slice of a level side by side, so it wrote many more slices than
  slots. Telling it in the prompt is a wording change, and three changes to
  the planner's wording (the dependency rules, the fan-out shape, the shape's
  faults asked in R1's call) each failed their measurement, so Ordewell
  orders the slices itself (R6), and the prompt and R1's message stay as they
  are.
- **Merging a crowded level's small slices toward twice the parallel limit.**
  Chosen once, then dropped (R7). On each level of more than twice the limit
  in slices, the smallest bin was merged with the smallest other of its kind
  (the same dependencies, dependents, runner, model, mode, skills, autonomy
  and slice type), two at a time, no bin past the level's largest slice,
  until the level had about twice the limit, never fewer than `FAN_OUT_MIN`
  nor to a count that changed the plan's shape. While the sizes were wrong
  few slices merged; with R6's sizes corrected, the replay of recorded runs
  showed it started the closing check later than largest first alone.
- **Merging with a tighter cap: no bin past a multiple of the median slice.**
  Not taken: at one and a half, two and three times the median, the replay
  of recorded runs still started the closing check later in the slow case
  than largest first alone, and each merged pair costs more cached input
  than its slices apart.
- **Merging every slice with no size, as a size of nothing.** Rejected with
  the merge: any number of them fit in one bin under the cap, so one task
  would take most of a level whose briefs name their test files past the
  paths read.
- **Only the first task every slice waits for is the opening task, the rest
  read from the spine.** Replaced: a task every slice waited for, set beside
  tasks the slices did not need, read as a slice, so a recorded plan logged
  one task before slices that waited for two, and that task got a slice's
  note.
- **The opening task's note leaves every module a slice owns to that slice.**
  Replaced: with a brief limited to two files, the opening task left a package
  whose `__init__` imports every module, and whose stubs lack private helpers
  sibling modules import, not importing at any landing of the run, and
  most slices built stand-ins outside their worktrees to run their tests.
- **Ordewell adds an opening task to a wide plan with none.** Not taken: it
  costs a serial task on every wide plan whose slices need nothing first, and
  needs a runner and model Ordewell does not choose elsewhere; the recorded
  plan with none had a core task most slices waited for, which is now read as
  its opening task.
- **A separate call for the shape.** Rejected: it costs a call for what the
  notes do without one, and the questions failed even on R1's call.
- **The planner writes each role's done criterion.** Rejected: the criterion is
  a contract with the run time, and the slices of one plan need it the same
  way. Ordewell writes it, the same way every time.
- **A closing check that starts once every slice has ended, landed or not.**
  Not taken here: it is a run-time change to readiness, outside the plan. The
  slice note keeps a slice whose own scope is in place from failing instead.
- **A wake reads the role from the plan's shape.** Tried and dropped: a plan
  no note was written on fans out too, so a wake named the opening task's
  licence for a task never given it, and an edit that moved the shape named a
  role the task was not told.
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
- A slice whose files misstate its work starts too early or too late; the
  order is a guess from the repository, and a run whose planner already listed
  its long slices first can do worse for it. A bare test-file name that
  several files under the brief's directories share counts nothing, and a
  slice with no file read has no size and starts after the sized ones.
- Every slice the planner wrote runs as its own task, so a plan of many more
  slices than slots pays each one's fixed run of calls; fewer slices would
  have to come from the planner's own plan, a prompt change measured on its
  own (R4), not from a merge after the fact (R7).
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
- 2026-11-19 — R5: a slice takes in a sibling's work once it has landed; a closing check with a task beside it is the closing check; a revision note's titles are no brief's paths.
- 2026-11-20 — R6: a wide one-shot plan's slices of each level start largest first, sized by the lines of the files their briefs name.
- 2026-11-21 — R7: a wide one-shot plan's small sibling slices are merged toward twice the run's parallel limit, before the order and the notes; telling the planner the limit is not taken.
- 2026-11-21 — R5: a task every slice of the fan-out's level waits for runs before the slices; every task before the slices is done only when the project imports and its tests collect, and the opening task may edit any file for that alone. R6: such a task starts ahead of the slices beside it.
- 2026-11-21 — R7: a level is never merged below `FAN_OUT_MIN`, nor to a count that changes the plan's shape. R5: the opening task ends done, with a finding, when what stops the import is outside the repository's code.
- 2026-11-21 — R6: a slice is sized by every path its brief names, the test files under a test directory it names and a bare test-file name one file under its directories holds, not the notes' first `MAX_PATHS`; `MAX_SIZED_FILES` is 1000.
- 2026-11-21 — R7: a wide one-shot plan's slices are never merged; replayed with R6's corrected sizes, every merge tried started the closing check later than largest first alone.
- 2026-11-22 — R5: each role's note is written whether or not the plan has a closing check; a last task waiting for only some slices no longer hides the tasks before them; a wake about a task names its role.
- 2026-11-22 — R5: with no closing check, a last task waiting for several slices but not every one gets no note; a wake names the role of the note on the task's brief, not of the plan's shape.
- 2026-11-22 — R1: a reply that cuts the first plan's closing check off from a task it waited for is applied with the check waiting for those tasks directly; refusing it is not taken.
- 2026-11-23 — R1: a reply to a plan that fans out keeps an added wait only on a task the waiting one ran after as written, or between two tasks before the slices; a slice it cuts from the opening task waits again for the tasks every slice ran after.
- 2026-11-23 — R1: a dropped added wait gives the task back what the dropped one ran after that it ran after as written, so the task is not left waiting for less than the plan as written and the reply together, and an ops, user or loop-check task set after the check is no longer refused for it; the log names as changed only a task whose waits differ.
- 2026-11-22 — R5: the closing check's note names the test directories no brief of the plan names, so that code is written at the end; stubbed modules are not looked for, since that reads file contents.
- 2026-11-24 — R5: the opening and gate notes name the two checks they ask for (importing, and a collection-only run) and say the full test suite is not part of them, since "run both" had an opening run the whole suite as its own criterion.
- 2026-11-24 — R5: the two checks are building or importing the project, which fits a project with no package, and the note names no closing check in a fan-out that has none.
- 2026-11-24 — R1: a reply cannot take `"*"` from a task, and every walk reads what it stands for (ADR-0077); the one-shot wording R4 measured does not mention it.
