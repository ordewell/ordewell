---
status: accepted
amends: ["0013"]
---

# 0054 — A landed task reverts on the integration branch, before Merge all

## Problem

A task finished and landed, and its work turns out to be wrong. The user could
only discard the whole run or undo the change by hand with git. ADR-0013 gave
each task its own branch partly so that one task could be undone, and each task
lands as its own `--no-ff` merge commit, so `git revert -m 1` undoes exactly it,
but nothing offered that. Doing it safely is more than one git command: other
tasks may stand on the work, a landing may be under way, a repo group has to
stay consistent, and the task has to end somewhere the scheduler will not simply
run it again.

## Decision

**The user can revert a task's landed work on the run's integration branches
until it is merged into their branch, with every landed task that depends on
it, all or nothing, and each reverted task goes back to pending and held.** The
revert adds commits and rewrites nothing.

- **Only on the integration branch.** It is the one branch Ordewell owns. Work
  already in the user's branch is refused, with the exact `git revert -m 1
  <commit>` for each repo, newest first, for them to run; Ordewell never writes
  to their branch. Merged means what the merge gate means, and what a clear-up
  reads before it deletes a branch: the user's branch contains every merge that
  landed the task, whatever the current record changed. So a revert covers only
  landings that never reached the user's branch, and asks git of each merge every
  time, wherever the user stands: a fact saved on a record goes with that record.
  A gate and the handoff read `inHead`, git's answer as last read, and it is read
  again both ways as a run closes, after Merge all and at each tick while
  anything reads as merged, so a merge the user takes back out closes its gate
  and is handed over again. HEAD holding it is not enough. An integration branch that is gone leaves nothing to merge, but puts
  nothing in the user's branch either: the revert is refused with no command to
  run. A checkout that stands on the
  integration branch, by name, detached or a branch cut from it, is no merge,
  only a review: it marks nothing merged, and clears no run. The branch the run
  started on is the user's, a fast-forward of it included, from any checkout,
  under any name its reflog says it was renamed to, and speaks for a detached
  HEAD; any other local branch has to show a merge, the landing off its
  first-parent line, whether it is checked out or not. Ordewell's own branches,
  `ordewell/` and `ordewell-preserved/` alike, are no one's, whatever a runner
  merged into them. A run with no base branch has only that, and a
  detached HEAD's own line, to go on, so Merge all makes a merge commit there. A revert cannot commit to the integration
  branch where it is checked out, so that is refused, in the preview too, naming
  where. Nor can it from Ordewell's own integration worktree with anything else
  checked out there, by name or detached, since git commits to whatever HEAD
  says: that is refused the same way, and it is the user's to put back. Tracked
  changes in that worktree, staged or not, are refused the same way too, naming
  them and where, in the preview and again before every commit: a commit would
  take in what is staged. An untracked file goes in no commit, so it stays.
- **A revert commit per landing.** Each is `git revert -m 1` of a merge that
  landed the task, worded `Revert: <subject>` beside the other messages Ordewell
  writes (ADR-0013). A continue or a retry lands a task again under a new record,
  so `IsolationRun.landings` keeps every such merge, by task and repo, and all of
  them go, with `IsolationRun.landedTasks` naming the task once no record does.
  A merge whose work a later landing already took out has nothing to commit and
  counts as reverted. A landing with the integration worktree off the branch
  fails, naming where, as one with the branch checked out elsewhere does. What
  either made is read off the branch, never off HEAD alone: a landing's merge is
  the tip with the tip it recorded and the task's for parents, and a revert's
  commit is the one HEAD names, as the branch's tip, with the commit before it
  its one parent. A checkout or anyone's commit there mid-way fails it, and it
  records nothing it did not make.
- **Landed dependents go with it.** Every task that depends on it, directly or
  not, and has landed goes too, newest landing first. A dependent that landed
  nothing is walked through and stays as it is. A subtask is a task here: it goes
  with its parent only if it depends on it. Landed reads `IsolationRun.landings`,
  not the current record: a retry, a failed spawn or a continue that conflicted
  leaves a record that is not `merged`, or none, over merges still on the branch.
  Those merges go; such a record stays, `kept`, for the worktree only it names,
  and a conflict it held is over. Depends reads the plan and
  `IsolationRun.landedOn`, what each task depended on, directly or not, when its
  worktree was cut and when it landed: a plan edit takes a link off while the
  worktree stays cut from the work, and a task that leaves the plan takes its
  dependencies with it, and the plan's links through it, while its merges stay.
  So a dependent that left goes too, and one that stood on the work through a
  link since taken off still does, at work or landed; one whose link went before
  it started starts from the tip as it is then, and stands apart. A retry keeps
  what its earlier attempts stood on, which errs towards taking more, and the
  preview names it. If
  any of what goes cannot be named, nothing
  does: a revert that took some of it would leave the rest standing on work that
  is gone. Newest means the first-parent order of the
  integration branch: the landing queue makes it one line, and git knows that
  order in each repo however the record was saved.
- **Two steps, so a surface can confirm.** `Session.revertPreview` (`GET
  /tasks/:id/revert-preview`) reads what would go, or why it would not, and
  changes nothing. `revert_task` at the command seam then needs `confirmed`, and
  takes `seen`, the task ids the user was shown: a list that changed since is
  refused. If the user declines, nothing is sent and nothing happens.
- **Refused while a dependent is live.** A dependent at work was cut from a tip
  holding the work being removed. It is named, as `refuseWhileLive` names what
  stops a clean-up. Live here also means Mark complete landing it, or paused on
  a usage limit, whose reset would resume it. A resolver at work on a conflict
  of a task that goes is refused the same way: its merge would land the attempt
  the revert ends. Tasks that do not depend on the
  work keep running: when one lands, a three-way merge from the tip it was cut
  from keeps the revert.
- **All or nothing.** The tips are recorded as `IsolationRun.landing`, with
  `reverts` saying it is a revert and which merges it takes in each repo,
  and saved before the first commit, across the
  whole set and every repo; each commit it makes is saved there as it is made. A
  conflict or a failure anywhere puts every tip back
  and names the task, repo and files. A crash does the same through
  `pruneOrphans`, since the saved run still has the tasks landed. The rollback
  moves a branch only when what sits on the tip is that revert's own commits and
  nothing else: the line it saved, each on the last. In the integration worktree
  it takes them off by a two-tree read, so a change made there since stays as it
  was, staged or not; git refuses over a path those commits touched, and the
  revert then stays recorded until that change is cleared. A crash can come between a
  commit and its save, so one more may follow that line, on it, if its message
  holds Ordewell's sentence naming one of the merges. Anything else stays recorded and holds landings
  and Merge all off it, as a landing's does (ADR-0014). It is judged again with
  its commits made and rolled back if it may no longer go: a plan loaded under
  it, the same run's saved copy too, has not heard of them.
- **The same queue.** A revert takes its turn with landings and Merge all, and
  judges everything again there, so it never reads a branch mid-landing and a
  Merge all that went first is refused with its commands. No new start is
  claimed while it waits and works: one cut now would lose what it depends on.
  The scheduler, queued starts and owed repairs hold, and the claim of anything
  depending on the work is refused, a start admitted before the revert with it.
  What the revert retires stays retired: a claim is refused for a task skipped
  since its start was asked for, and only a start asked of a task already
  skipped runs it again. A start parked on a dirty tree and replayed later is
  that same start.
- **What a reverted task is afterwards.** Pending, on a chosen hold like a
  stopped task's, with `reverted` saved on the task so the hold outlives the
  process and the plan says why. It waits on the user in the escalation inbox
  whether or not the run is still open, and behind a dependency too, so a chain
  revert lists every task it took
  ([ADR-0053](../supervision/0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).
  It starts from nothing it earned, as Mark not
  done leaves a task, and the logs of its attempts stay. A retry or a force start
  releases it and starts from the current integration tip; a Stop that withdraws
  a force start waiting behind its dependency puts the hold back. Its run record goes,
  and every reading of landed work follows: the handoff, the merge gates, Merge
  all's message. A dependent that waited at a gate for it now waits for the task
  itself. A resolver out to a conflict of it is retired, as when a retry ends the
  conflict (ADR-0015), so a retry is free and the task stays in the inbox. That
  comes last, since it saves the run: no save finds the records gone with a task
  still complete.
  `IsolationRun.reverted` keeps the run going with no record left,
  because its branch holds commits no record names and a retry starts from it.
- **Not while a loop decides.** A task in a loop that has not ended is refused:
  ADR-0045 owns those rounds, and they land and run tasks again by themselves.
- **What a surface shows.** `/revert <id>` in the terminal and a Revert button
  on the task's card in VS Code. Each reads `revertPreview`, shows the task and
  every dependent that goes with it, newest first, and sends `revert_task` with
  `confirmed` and `seen` only on the user's yes; declining sends nothing. Every
  refusal (a live dependent, a conflict and its files, work already merged and
  its `git revert`, a loop still running) is core's own sentence. The button is
  there only where the task's isolation mark says `revertible`, which reads the
  same landings and `IsolationRun.carried` a revert does, so a task with no
  record left can carry it and a carried task does not. A
  task is called by its reference, a subtask by its full path.
- **A user action.** It is in the user's controls at the seam and reaches no
  planner or supervisor tool: taking landed work back is the review's decision.
  Read-only, ops, script and user tasks land nothing, so they cannot be reverted;
  a surface offers it where a task's isolation mark says `revertible`.

## Testing decisions

The git behaviour runs against real scratch repositories
(`GitWorktreeIsolation.revert.e2e.test.ts`), reading branch tips, trees and
`git status`, never command lines: a crash is a saved run taken before the first
commit. The scheduling runs against `FakeWorktreeIsolation`
(`TaskOrchestrator.revert.test.ts`), which asserts the task's state, the hold,
the gate and what starts meanwhile; the seam's own rules go through a Session
(`executionCommands.revert.test.ts`).

## Out of scope

- A dependent that landed nothing keeps its result, though it may have been
  built on the work; what follows it waits only for what it depends on.
- Work a conflict resolver brought in has no merge of its own: reverting it, or
  the resolver that carried it, is refused rather than leaving a record that
  says landed over work that is gone. `IsolationRun.carried` keeps it from the
  moment that merge lands, so the refusal outlives the carried task's record and
  stands after it lands a merge of its own, which holds only its later work.
- A task saved with neither `landedTip` nor a `landings` entry, as ADR-0013 ran:
  no record says which merge is its, so it is refused, in those words.
- A dependent in a run started before every merge was kept
  (`IsolationRun.keepsEveryLanding`), when an attempt of it ran and nothing shows
  it landed: an earlier attempt's merge may be on the branch with no record of
  it, so the whole revert is refused.
- A task with merges in `landings` and no record or `landedTasks` entry left to
  name it, which only a build between the two could save: refused, not previewed.
- A merge two tasks are recorded as landed by, which only a landing that took the
  branch's tip for its own could save: refused, whichever of them is asked.
- A task that landed and left the plan with no `landedOn`, or no name, which only
  a run from before `landedOn` was kept can hold: nothing shows it stands apart
  from the work, so every revert of that run is refused.
- Reverting after Merge all, and any write to the user's branch.

## Considered options

- **Stop a live dependent and go on.** Rejected: it destroys work the user did
  not ask to lose. They can stop it themselves and revert again.
- **Route a conflict through conflict repair (ADR-0015).** Rejected: a repair is
  a runner fixing its own landing, judged by evidence; a user undoing a landing
  has no attempt, and a model resolving what stays would decide the very thing
  the user took back.
- **Reset the integration branch to before the landing.** Rejected: it would
  drop what landed since, and move a branch a running task's worktree was cut
  from. A revert keeps the history a later Merge all brings to the user.
- **Keep the record, under a new `reverted` status.** Rejected: every reader of
  a record's status would need to learn it to mean what no record already means.
- **Keep the hold in memory only, as a stop's is.** Rejected: a restart would
  run the work again on the next Execute, which is what the user took back.
- **A planner or supervisor tool.** Rejected: it would add a route to undoing
  reviewed work for a decision the user is present to make.
- **Take HEAD containing a landing as merged, whatever is checked out.** Rejected:
  a detached review of the integration tip would mark work merged and let a
  clear-up delete the branch, and work that is only being read would be refused
  as in the user's branch.
- **Revert a carried task's own later merge and leave what its resolver brought.**
  Rejected: the task would go back to pending with its work still on the branch,
  and a retry would start from a tip that holds it.
- **Find a dependent's forgotten merges by reading the branch's messages.**
  Rejected: a merge's message is words a task chose, and a wrong match reverts
  work the user did not ask to lose. Not being sure refuses.
- **Count a revert's commits on the branch.** Rejected: a count says nothing of
  whose they are. Anyone's plain commit on the tip filled it, so a revert that
  had missed the branch said it had reverted, and a rollback dropped the commit.
- **Keep the found-merged fact per merge, or on the run.** Rejected: git can answer
  it, and a saved answer goes stale both ways, keeping a merge the user has since
  taken out and missing one made after it was read.
- **Read only the base branch and HEAD for merged.** Rejected: a merge by hand into
  a feature branch would stop counting the moment the user left it.
- **Make the commits with `commit-tree`, so each is saved before the branch moves
  and a crash can leave none unsaved.** Rejected: it would go past the commit
  hooks and signing that the commits Ordewell writes go through.
- **Refuse a commit left unsaved by a crash.** Rejected: a crash between two
  steps would hold the run off every landing over a commit it made itself, and
  its own sentence on the saved parent leaves no plain commit in that place.
- **Refuse every revert while any landing's task has left the plan.** Rejected:
  a task that stood apart from the work would stop it for good, when its
  dependencies can be kept as it lands.
- **Commit past an integration worktree that is off its branch, through a
  temporary worktree or `commit-tree`, or move it back first.** Rejected: that
  worktree was moved by someone, for a reason Ordewell cannot read, and it may
  hold their changes. A landing needs a checkout of the branch to merge in
  anyway, and naming where it stands leaves the choice with them.

## Consequences

- Merge all brings both a reverted landing and its revert to the user's branch:
  the work does not arrive, and the history says what happened.
- A run with landed work all merged and the rest reverted is cleared up as
  merged, and its integration branch stays, since HEAD does not contain it. It
  holds nothing the user lacks but the reverted work; deleting it is theirs.
- A reverted task has no diff to show: that read goes through the record.
- A user who fast-forwards by hand on a run with no base branch, or on a branch
  other than the base branch, has their merge read as a review: it stays not
  merged until Merge all or a merge commit says otherwise, which errs towards
  keeping the branch.
- A merge by hand into a throwaway branch counts, as one into any branch of the
  user's does: a gate can open and a run can clear with the checked-out branch
  lacking the work. Its integration branch stays, since HEAD does not contain it.
- A merge the user rebases or squashes away reads as taken out, since git no
  longer shows it: its gate closes until Merge all brings it in again.
- A renamed base branch is followed for what merged means, through a reflog that
  can expire. Merge all still names the branch the run started on, and refuses
  any other as the wrong branch, so it waits for that name to come back.
- The resolver of a conflict and the task it carried stay on the integration
  branch for good; only discarding the run takes them back.

## History

- 2026-10-30 — accepted; core, the command seam and the daemon contract implemented.
- 2026-10-30 — the terminal and VS Code offer it; fully implemented.
- 2026-10-30 — landed reads `landings` over the record, and a checkout of the integration branch counts as no merge; a claim in a revert's reach is refused, and it is judged again before it settles.
- 2026-10-31 — merged means the user's branch, not HEAD: any review checkout is no merge, and Merge all makes a merge commit where no base branch says otherwise; `carried` keeps resolver-carried work; what cannot be named refuses the whole revert.
- 2026-10-31 — merged reads every merge of a task, not the current record; a branch that is gone puts nothing in the user's branch; a rollback holds each repo to its own reverts, and the mark follows `carried`.
- 2026-10-31 — a landing and a revert refuse an integration worktree off the branch and read what they made off the branch; a merge two tasks are recorded as landed by is refused; a reverted task is listed behind its dependencies.
- 2026-10-31 — a revert knows its commits by the SHAs it saves and their parent line, not a count; tracked changes in the integration worktree refuse it; a resolver of a reverted task is retired, and refuses it while at work; `landedOn` keeps a dependent that left the plan.
- 2026-10-31 — merged is asked of git for each merge across the user's branches, not read from `inHead`; `landedOn` is kept from when a worktree is cut; tracked changes are checked before every revert commit and a rollback keeps them; a claim refuses a task skipped since its start was asked for; resolvers are retired last.
- 2026-10-31 — `ordewell-preserved/` branches count as Ordewell's own; a renamed base branch is followed; `inHead` is read both ways; a Stop puts a reverted task's hold back; a dirty tree's replay is the start it parked.
