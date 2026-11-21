---
status: accepted
amends: ["0029", "0047", "0057"]
---

# 0073 — A blocker found in landed work reaches the supervisor while the run can still land a fix

## Problem

Slices of one plan run beside each other, and each takes in what its siblings
have landed. When one of them finds that work another task already landed is
broken, its handoff says so as a `blocker` finding, and nothing reads it until
the closing check. In a recorded run of 37 tasks, 20 slices cited one defect in
the opening task's landed code by its file, the first 67 minutes in, and 9 cited
another in a second task's, the first 84 minutes in. A wake listed what had
passed, not what the handoffs found, so the supervisor never heard of them. The
closing check fixed both in 12 model calls when it started, 147 minutes in, and
the run's three-hour cap cut it before it landed: its unlanded commit passed
5182 tests, the merged tree 2330.

Of that run's 65 blocker findings, 61 cited only files and commits; none of the
four that cited a task named the work at fault. Twenty slices had a
`task_complete` refused for citing, as evidence, a sibling the brief's own *Plan
shape* list names: the readable set
([ADR-0047](0047-structured-task-handoffs.md)) scoped citations as it scopes
reads.

## Decision

**A `blocker` finding that cites a task whose work had landed when it was
reported raises a `landed_blocker` event for that task, counted across the plan
and raised as the count of reporting tasks reaches 1, 2, 4, 8…; the supervisor
writes the one fix.**

- **What counts.** A finding of severity `blocker`, in the handoff of any task as
  it settles, passed or not, that names a completed task of this plan in one of
  two ways, and nothing read from its words (`LandedBlockers`):
  - a `task` reference with no finding id, at the attempt that landed or
    unpinned. A reference with a finding id cites that report, which may be
    about anyone's work, and a reference to a plan below is that plan's
    supervisor's;
  - a `file` it cites that a landing changed: the first such file in its
    evidence, which is where the defect is, not the callers it shows in after
    it. Of several landings that changed that file, the last before the report
    is the work the reporter's tree held. The files are what each landed task's
    branch changed (`IsolationRunController.changedPaths`), read once per
    landing and only when a blocker cites a file. A run that shares the checkout
    can say nothing, and has only the first signal.
- **Landed before the report.** A report counts only against work whose verdict
  came before the reporter's: one made before is about work that was not there.
  So the count only grows as reporters settle, and a retry of the owner that
  lands again starts it over.
- **One fact per landed task.** Reports are grouped by the task whose work they
  name, so 20 reports are one fact. The count is derived from the plan's
  handoffs as each task settles, never stored (the rule of
  [ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)).
- **Raised on doubling.** The event is raised when the count reaches a power of
  two: the first report, its corroboration, then 4, 8, 16. Twenty reports raise
  five events over a run. A queued event for the same task is replaced by the
  latest, keeping the first's stamp, as `running_long` is.
- **Held.** `landed_blocker` is held as `task_failed` is
  ([ADR-0057](0057-information-moves-by-reference.md) R4): it goes with the
  next wake, or at the cache's maximum age, minutes at most. It is never a
  ride-along: its line is whole.
- **What it says.** `task #1 "Opening" has landed, and 4 tasks report a blocker
  in its work: #5/F2 "…"; #7/F1 "…"; #9/F1 "…" and 1 more; the closing check is
  #37 "…"`, then once per wake one line of guidance (`LANDED_BLOCKER_ADVICE`):
  fix it once, by one task, never once per report; read a report; if it holds,
  one `edit_plan` that adds a fix task depending on the owner and citing the
  reports, makes the closing check depend on it, and reorders it ahead of every
  task not yet started; add none if a task already fixes it; do not retry, stop
  or message the reporters. The level's brief says whether the supervisor acts
  or suggests.
- **Any task of the plan may be cited.** A handoff's `task` reference may name
  any task of its plan, pinned to that task's latest attempt. A finding id is
  accepted only on a task the producer may read (ADR-0047's readable set),
  which `read` still holds to. A citation reads nothing; a finding id would say
  what the producer read.
- **The completion contract asks for it.** One sentence: a finding about work
  another task has landed cites that task, and the file the defect is in as its
  first file.

## Testing decisions

`landedBlockers` is pure over a plan tree and a lookup of each landed task's
files, so its tests build plans with handoffs and verdict times and need no git.
`RunSupervision` is tested through a fake host whose `landedPaths` answers from
a table, from a settling task's handoff to the line `deliver` receives; the
event's hold and collapse in `WakePolicy`, and the digest line and advice in
`Supervisor`, each in their own suites. A recorded run is replayed from a
scratch script outside the repository that bundles this module and feeds the
run's handoffs in settle order, each landing's files read from its merge; no
recorded data is committed, and fixtures are synthetic.

## Considered options

- **Task references only.** The design as first prototyped. Dropped: on the
  recorded run it raised nothing for either defect, since the slices cited the
  broken file and never the task, and its only raises came from references to
  another report's finding, itself about unlanded work.
- **Every file a blocker cites.** Rejected: a finding cites the callers the
  defect shows in after the file it is in, and on the recorded run the task that
  landed the callers was raised as often as the one at fault.
- **Read the finding's words for a task's name.** Rejected: a report's words are
  data (ADR-0057 R3), and a mention is not a claim about whose work is broken.
- **Ordewell adds the fix task itself from the finding.** Rejected: its brief
  would be a runner's words, which are never another task's brief (ADR-0057
  R3); its runner, model and mode would be chosen by nobody, against
  [ADR-0001](../routing/0001-autonomous-mode-resolution.md); and telling 20
  reports of one defect from two defects in one task is judgement no code makes.
- **Re-open the owning task: continue its session with the reports.** Kept as a
  supervisor's choice, not the default: a completed task re-opened is not
  completed, so every dependent not yet started waits for it, and if the new
  attempt fails every one of them is blocked (ADR-0034). In a fan-out that is
  the whole plan behind one retry.
- **Wake at once on every report.** Rejected: 20 wakes for one defect, each a
  turn, and the wake-up rate guard would drop an Act supervisor to Watch.
- **List every handoff's findings in each wake.** Rejected: 210 findings in one
  run; the cap (ADR-0057 R5) would cut them to counts, and the two that mattered
  would read as two of many.

## Consequences

- Replayed on the recorded run, the opening task's defect is raised at its
  first report, 67 minutes in, and the second task's at its first report by
  file, 100 minutes in; five raises name four other tasks, one of them a third
  defect a landed task left in a file two tasks cited.
- A slice that cites a file before the file it found broken, or a defect in a
  file nobody landed, raises nothing, or raises the wrong task: the contract
  asks for the file first, and nothing enforces it.
- Whether a small model acts on the line is not shown by any test: a paid run
  is.
- A report against work no fix touches keeps doubling to at most log2 of the
  slices; a supervisor told a fix exists adds none, but nothing enforces that.

## History

- 2026-11-21 — accepted: the event, its count by task reference and by the files
  a landing changed, the digest line and the wider citation scope.
