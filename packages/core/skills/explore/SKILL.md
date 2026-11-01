---
name: explore
description: Work an open problem with no known path: which approach to take, whether something is feasible, what the options are. Not for a build with known steps or a failure to explain.
---

An open problem is done when a claim has survived an attempt to break it, not when the first plausible answer arrives. Plan in rounds, and let each round's reports decide the next.

## 1. Frame it

Write down the question, what a finished answer looks like, and how a claim will be judged: a command, a measurement, a review. Ask the user only about what you cannot find yourself, and mostly about the bar: what makes an answer good enough.

## 2. Plan the first round only

Plan nothing beyond it. You do not yet know which questions matter, so a later task written now is a guess.

Who finds out is decided as WHO EXPLORES says, by what the result is. A question one lookup answers, whose conclusion only decides what you say or ask, is orientation, not a round: read it yourself, or ask one of your own agents if you have any, within the turn. What a later task acts on, or what needs a worktree, another model or the user's eye, is a task of its own. It is a research task, and so a round, only when you must decide something on its report; a read-only task whose report only later tasks read is not.

Make the research tasks deliberately different: another approach, another source, a different assumption, one that questions the premise itself. Several variations on one idea are one task done several times. Keep the round within the run's Parallel limit, so none waits.

Each brief stands alone and holds the question, where to start, and the report you want: a claim, the evidence for it, what would break it, and the commands it ran with their output. A claim that comes with a command is worth more than one that comes with an argument.

Tell the user, in a line each, what the round asks. Then wait. Reports wake you.

## 3. Read what came back

Sort each claim: it holds on evidence, it failed, or it is unverified. Drop what failed, and note why in a line, so the same idea is not planned again. Never take a claim for true because its author sounded sure.

## 4. Try to break what looks promising

For each promising claim, add a refuter:

- A research task given the claim and how to reproduce it, and told to break it. Do not hand it the author's reasoning, which would anchor it. It reports either the break, with how, or what it tried and why the claim survived.
- A claim that is a change with a checkable bar can be built instead, as a change task inside a check-and-fix loop. The loop's check is the refuter, and whether the bar is met is its verdict.

A claim is trusted only after its refuter fails to break it.

## 5. Let one check choose between competing approaches

When the question is which of several approaches to take, explore them side by side and choose on a check, not on an opinion:

- A shared check, fixed before the explorers start: a test, a build or a measurement the same for every approach. Write it into every explorer's brief, so the candidates are compared on one bar. Only a candidate that passes it is eligible.
- Explorers: read-only tasks, each trying one deliberately different approach, with no dependencies between them. Each runs the shared check and reports its commands with their output. An explorer that builds a prototype keeps it with `save_patch` before it calls `task_complete`, because its worktree is thrown away with it. Tell it to.
- The choice: if exactly one candidate passes, no judge is needed; that one is chosen. If several pass, one judge task that depends on every explorer recommends one. It reads their handoffs with `read` (with `include_report` where the summary is not enough), tries to break the most promising claim, and cites its evidence: the explorers' checks and its own, not its opinion. If none passes, that is a finding: say so, and plan the next round.
- Make the judge a research task, so that its recommendation wakes you and the build task is yours to add once you have read it. A recommendation is advice. Adding the build task on one explorer's patch is the pick, and approving that task is the user's, or at Act the supervisor's.
- The build task you add after the choice depends on the chosen explorer, and on the judge when there is one. It applies that explorer's patch with `apply_patch`, resolves any conflicts the tool reports, and runs the checks itself, since the explorer ran them at its own base. Say so in its brief. An explorer ran the shared check in a worktree it could write, so its patch may change the check itself: tell the builder, and the judge if there is one, to confirm that the patch leaves the check's files alone, or to run the check as the base has it. A patch that deletes or adds a file the worktree also changed applies nothing: the tool says why, and the builder applies the rest by hand.

A prototype that was not saved with `save_patch` is gone with the worktree. If an explorer is not asked to save one, the builder re-creates the approach from its report, so ask for a report that is enough to do that.

## 6. Extend the plan

Extend the plan as reports arrive, with the next round, not all of it at once:

- Prune: remove the pending tasks whose premise just failed. Leave what has run; it is the record.
- Deepen what survived: narrower questions, a harder refuter, a prototype.
- Widen only when a round found nothing that survives, and then with a direction the failures pointed away from.

At the end of each round tell the user what survived, what died and what the next round is.

## 7. Spend your own context on integration

The reports are your input. Do not redo a task's research yourself; read its report, and its output or diff only where the plan rests on it. Your work is to compare claims, reconcile reports that disagree, choose, and see what no single task could.

## 8. Stop

Stop when a claim has survived its refuter and the next step is known: plan the build, as vertical slices with a loop at the end if it has a checkable bar, or answer the user if the finding is the result. Stop too when rounds stop producing anything new: say what is established, what is not and what more would cost, and let the user decide.
