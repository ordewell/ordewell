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

**A `blocker` finding that cites a task whose work had landed (when it was
reported, for a task it names; when the reporting attempt started, for a file
it cites), and cites no task whose work was still to come, raises a
`landed_blocker` event for that task, counted across the plan and raised as the
count of reporting tasks reaches 1, 2, 4, 8…; the supervisor writes the one
fix.**

- **What counts.** A finding of severity `blocker`, in the handoff of any task as
  it settles, passed or not, that names a completed task of this plan whose pass
  landed work on the run's branch (not a read-only, ops or person's task), in
  one of two ways, and nothing read from its words (`LandedBlockers`):
  - a `task` reference with no finding id, at the attempt that landed or
    unpinned. A reference with a finding id cites that report, which may be
    about anyone's work, and a reference to a plan below is that plan's
    supervisor's;
  - a `file` it cites that a landing changed: the first such file in its
    evidence, which is where the defect is, not the callers it shows in after
    it. Of several landings that changed that file, the last before the
    reporting attempt started is the work the reporter's tree held. None, once
    another task's landing after that start changed that file: what the report
    complained of was still being written, as a placeholder the opening task
    left for a slice is. Every report from a tree cut before that landing is
    judged alike, whenever it was made, so the count of the owner does not fall
    and then climb back through 1 and 2 on reports from that same tree, raising
    it twice at each. The files are what each landed task's branch changed
    (`IsolationRunController.changedPaths`), read once per landing and only when
    a blocker cites a file. A run that shares the checkout can say nothing, and
    has only the first signal.

  A finding names one owner at most: its first landed task reference, else its
  file's. A closing check's "the merged tree does not build" that cites every
  slice is one defect, not a fix owed by each. A loop's check between rounds
  reports nothing ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md) L3): its loop's body is the fix,
  and runs again; once its last round fails, it reports as any task.
- **A wait is no blocker.** A finding whose evidence cites, by a `task`
  reference with no finding id, a task of this plan other than the reporter
  that lands work and had not landed when the report was written, and can
  still land before the reporter's work is wanted, is a wait notice: it counts
  against no one, whatever files it cites, then or after the work it waited on
  lands. A citation of the reporter itself, of a report's finding or of a plan
  below is no work it waits on; nor is one of a task skipped or failed, which
  lands nothing, or of one that depends on the reporter, as the closing check
  the slice note names as the one the work is for does.
- **Landed by the report, or before the attempt started.** A report that names
  the owner by a `task` reference counts against its work landed before the
  report: a reporter that names the task has its work, taken in mid-attempt as
  the slice note asks once it lands. A report that names it only by a file
  counts against work whose verdict came before the reporting attempt started,
  as its attempt's usage record says, else before the report: a file says
  nothing of a take-in, and work that landed after is work the reporter may
  never have taken in. A take-in is the runner's own merge
  ([ADR-0013](../isolation/0013-worktree-isolation.md)) and the plan keeps no
  time for it, so the start is the last moment the records say its tree held
  what had landed. A retry of the owner that lands again starts the count over.
- **One fact per landed task.** Reports are grouped by the task whose work they
  name, so 20 reports are one fact. The count is derived from the plan's
  handoffs and the landings as each task settles, never stored (the rule of
  [ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)), so a report
  that a later landing overtook stops counting at the next report: a doubling
  never names it again.
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
  what the producer read. A citation of a task outside the producer's readable
  set is saved marked `unread`, so once that task leaves the plan it opens its
  handoff to no one, where a citation the producer could read passes it on
  (ADR-0057 R1).
- **The completion contract asks for it.** A finding about work another task
  has landed cites that task, and the file the defect is in as its first file,
  with the input that shows it; waiting on work not yet landed is no blocker,
  but an `info` finding that cites that task. A slice's role note
  (`PlanFanOut.sliceNote`) says the same of the tests it leaves: each an `info`
  finding citing, by task reference, the slice it waits for, and `blocker` only
  for a defect in landed code that stops it, with the file and the input. A
  runner that words a wait as a blocker and cites only files is still matched
  by them, until the landing it waited on changes the file.

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
- **Count against work landed before the report.** The rule as first built.
  Dropped: on a second recorded run it counted slices' waits on siblings still
  at work against landed tasks, by a placeholder in a file they cited or by a
  sibling they cited beside one that had not landed, and named such a report
  again at a later doubling, long after the work it waited on had landed.
- **Count a task reference, too, against work landed before the attempt
  started.** Built, then dropped: a slice that took in a sibling's work once it
  landed, as its role note asks, and found a defect in it raised nothing for
  it, and a slice-on-slice defect is found in just that case.
- **Take the reporter's last take-in from git.** Not built: it would read the
  reporter's branch for merges at every report, for a time the attempt's start
  bounds from below; a defect found by file in work taken in mid-attempt waits
  for a reporter that started after it landed.
- **Overtake a file's report only by a landing after the report.** Built, then
  dropped: reports from one tree made either side of the landing were judged
  apart, so those before it stopped counting while those after it counted
  afresh, and the owner was raised again at 1 and 2.
- **Never raise an owner again at a count already raised.** Not built: it
  needs the raises stored, where the count is derived (ADR-0034's rule).
- **Overtake a file's report only by a landing of a task the finding names.**
  Rejected: a wait worded as a blocker that cites only files names no task, and
  would count against the placeholder's owner until a doubling named it again.
- **Fall through to the next file when the first was overtaken.** Rejected: the
  first landed file is where the report says the defect is, and the files after
  it are callers, which would name the wrong task.

## Consequences

- Replayed on the first recorded run under the rule as first built, the
  opening task's defect is raised at its first report, 67 minutes in, and the
  second task's at its first report by file, 100 minutes in; five raises name
  four other tasks, one of them a third defect a landed task left in a file two
  tasks cited. That run has not been replayed under the wait and attempt-start
  rules.
- Replayed on the second, the rule as it stands raises neither wait notice nor
  the doubling that named one again, and keeps the defects slices reported in
  landed helpers with the file and the input.
- A slice that took in landed work mid-attempt and found a defect in it raises
  it when it names the task; one that cites only the file raises nothing for
  it, and the next reporter that started after that landing does.
- A report from a tree cut before a later landing of its file stops counting
  once that landing is in, even when that landing changed the file for another
  reason and the defect stands; a reporter that started after it names the
  later landing's task.
- A slice that cites a file before the file it found broken, or a defect in a
  file nobody landed, raises nothing, or raises the wrong task: the contract
  asks for the file first, and nothing enforces it.
- A blocker that cites, by task reference, a sibling whose work landed between
  the reporter's start and its report is raised against that sibling: the plan
  cannot tell that case from a defect found after taking the sibling's work in,
  and the reference counts work landed by the report.
- Whether a small model acts on the line is not shown by any test: a paid run
  is.
- A report against work no fix touches keeps doubling to at most log2 of the
  slices; a supervisor told a fix exists adds none, but nothing enforces that.

## History

- 2026-11-21 — accepted: the event, its count by task reference and by the files
  a landing changed, the digest line and the wider citation scope.
- 2026-11-21 — one owner per finding, owners that land work only, a loop's check between rounds left to its loop, and an unreadable citation marked so it passes nothing on.
- 2026-11-21 — only a defect in landed work: a citation of work still to come is a wait notice, work counts from the reporting attempt's start, a file a later landing changed names no one, and the slice note and contract ask for a wait as `info`.
- 2026-11-21 — a task reference counts work landed by the report, a file's report is overtaken by a landing after its attempt started, and no task that depends on the reporter, or skipped or failed, is a wait.
- 2026-11-21 — a consequence recorded: a task reference to a sibling that landed mid-attempt is raised against it.
