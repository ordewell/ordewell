---
status: accepted
amends: ["0008", "0009", "0020", "0022", "0026", "0029", "0030"]
note: "Settles #95. The mandate (#23) takes over the consent table and the effect allowlist when it lands."
---

# 0035 — Every effect is consented to and recorded, whoever performs it

*Pending:* [ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) — a script task marked `readOnly` runs sealed in a throwaway worktree, past no gate.
*Pending:* [ADR-0056](0056-a-mandate-narrows-down-the-tree.md) — below the root a mandate replaces the consent table, and the effect allowlist becomes one list per level.

## Problem

ADR-0008 kept the planner from acting on its own account. Mutation belonged to
the runners (ADR-0009), and an effect the plan needed was an ops task
(ADR-0020, ADR-0026). The envelope refuses the commonest effects outright
(`git push`, `git commit`), and in Full it refuses everything the allowlist
does not cover. Pushing a branch, or setting one value on a cloud resource in
Full, therefore took a runner session: a model that reads its harness's instructions and the
task's prompt, then runs one command. The planner hears how it went in a later
turn.

What the rule protects has to be read against where it applies:

- **Under Guarded, some effects already run as research.** A cloud CLI's write
  is `ask`, not `refuse`, so once approved it runs through `run_command`, and
  the approval is remembered for its scope (ADR-0008, T1), which can cover
  sibling commands that write too. It is recorded as a research step, with no
  task, gate or verdict.
- **In Full with autorun it does not prevent effects; it reroutes them.** An
  ops task the planner writes starts at once and runs in its runner's
  autonomous mode. ADR-0030 says so: an instruction injected into something
  the planner read "can become an ops task that runs on real systems from a
  plan no person read".
- **Under Guarded, or with autorun off, the consent is to a prompt.** The user
  approves a description that a runner interprets as it goes. The commands
  that ran are known afterwards, from the task log.
- **Full gives the most restricted planner.** `auto` resolves to `allowlist`
  in Full (ADR-0026), so a Full planner may run less than a Guarded one, while
  its tasks may do more.

What the indirection does deliver is a **consent point** where an approval
exists, a **record** (a task in the plan with a log, a verdict and retry
context) and **order** (merge gates, never during Merge all). Those are worth
keeping. Forbidding the planner every effect is only the bluntest way to keep
them.

The rule also answers three different questions at once:

| question | where it is answered |
|---|---|
| **Capability:** what can a session technically do? | the boundary it runs in: the OS sandbox ([ADR-0011](../planner-envelope/0011-sandboxing-the-planners-shell.md), [ADR-0036](../planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md)), later leases and containers (#97, #99); the in-process envelope (ADR-0008, ADR-0026) where none runs |
| **Authority:** what may happen without a person? | core, at the command seam: plan approval, the consent rule below, later the mandate (#23), narrowing down the tree (#92) |
| **Judgment:** do it myself or hand it off, and how to split the work? | the planner's prompt, with what it can see of its own context and budgets |

A prompt never enforces authority (ADR-0029 rejects it for the supervisor
level), and core never decides judgment. This ADR changes the answer to the
second question for the planner's own effects, from "never" to "consented to
and recorded".

## Decision

**Every effect is consented to and recorded, whoever performs it. The planner
may perform an effect itself as a script task: an ops task whose body is a
literal script that Ordewell runs with no model. The planner still never
writes repository files.**

### Script tasks

- **What it is.** A task with `type: 'script'`, beside `ai` and `user`. Its
  body is either `commands`, a list of argument vectors run in order with no
  shell and stopping at the first that fails, or `script`, one script run by
  the interpreter the planner's own commands use (the research shell,
  ADR-0011), outside the planner's sandbox, as a task runs. It has no runner,
  model or mode, and no subtasks, and is never one: like an ops task, it is
  top-level only.
- **It is an ops task in everything ADR-0020 says about where and when ops
  tasks run.** At the workspace root, never in a worktree; behind a merge gate
  when it depends on change tasks; never while Merge all runs; and followed by
  the tracked-file check, so a script that leaves a tracked change waits on
  the user. It runs with the workspace's environment (ADR-0016), as a task
  does.
- **Its verdict is its exit status.** Every command exiting 0, or the script
  exiting 0, passes. Anything else fails, with the status and the tail of the
  error output as the reason. A wall-clock limit, ten minutes unless the task
  sets another (at most a day), ends it as failed. `VerdictEngine` stays the only producer of
  verdicts: the exit status is handed to it as the attempt's evidence, as a
  runner's `task_complete` call is. No model is asked anything. This is the
  one completion that is not a `task_complete` call, because there is no
  runner to make one; the evidence is the status of the literal script the
  plan holds.
- **Its log is its task log**: each command as run, its output and its exit
  status. The planner reads it with `task_output`, as any task's. The log
  keeps only the ends of a long output, so the whole of it is also streamed to
  a file beside the attempt's log (`<attempt>.output.txt`). The verdict names
  that file, and the handoff lists it as an artifact, because the reason a
  command failed is often in the middle of what it printed. The file has a
  guard of tens of megabytes, and what it does not keep is counted and said.
- **Only the planner writes the body.** The surfaces draw a script task as an
  ops task with its body, read-only, in place of a prompt, and the task editor
  leaves it alone; the user consents to it or does not.
- **A retry runs it again as written.** To change what runs, the planner edits
  it first (`edit_plan`), so the plan holds what ran. The supervisor's
  identical-retry guard (ADR-0029) reads the body as it reads a prompt; the
  user may retry an unchanged script.

### Running one from a planner turn

- **`run_script`** is a new execution tool through the command seam
  (ADR-0029), offered by the Ordewell MCP server and to the API planner alike.
  It adds a script task to the plan and starts it in one step, and returns
  when the task ends, with its verdict and the tail of its output. A script
  still running after a minute returns "still running"; its end reaches the
  planner as a research task's report does
  ([ADR-0037](0037-research-tasks-wake-the-planner.md)).
- **It runs inside the turn.** A start that a planner turn asks for waits for
  the turn's start hold (ADR-0029), because a runner the scheduler spawns
  could race the turn's edits. A script task started by `run_script` is not
  spawned by the scheduler: the seam adds it to the plan as the turn's
  committed edits left it (ADR-0022, P2) and runs it in the same step. It takes the gate check
  and the Merge-all exclusion an ops task takes when it starts. A closed merge
  gate leaves it in the plan, waiting at the gate, and `run_script` says so.
- **Consent.** Until the mandate (#23), a script task the planner adds gets
  the consent any task the planner adds gets (ADR-0029, ADR-0030), with three
  differences: the effect allowlist can pre-approve it, in Full without autorun
  the user is asked on the approval card rather than left to start it, and
  autorun in Guarded does not approve it (see below):

  | turn | covered by the effect allowlist | otherwise |
  |---|---|---|
  | the user's, Guarded | runs | the user approves it on the approval card |
  | the user's, Full without autorun | runs | the user approves it on the approval card |
  | the user's, Full with autorun | runs | runs |
  | the supervisor's, at Act | runs | runs: a task it adds is approved (ADR-0029) |
  | the supervisor's, at Watch | refused: suggest it to the user | refused: suggest it to the user |

  In Full with autorun, nobody is asked, on a first plan as on an approved one,
  and the start makes the plan approved, as autorun's own start does (ADR-0030).
  The effect allowlist is read on every call. The card
  shows the commands or the script verbatim, so the consent is to
  what will run, not to a description of it. In Full without autorun the user
  reviews what the planner proposes in any case; the card puts the script in
  front of them when it would run. An unanswered or denied card leaves the
  task in the plan, unapproved, for the user to start or remove: absence is
  denial (ADR-0008, T5). While a `run_script` card is open, Execute and
  `run_plan` leave that script out of what they approve, so the card alone
  decides and a denial after an Execute does not come too late. A script task in
  a submitted plan is approved with the plan, like every task in it, and runs
  when the scheduler reaches it.
- **A script waiting at a closed merge gate keeps its place.** `run_script`
  leaves it in the plan, approved, and a later planner edit that leaves its
  body alone does not drop its queued start; one that changes the body takes
  it out of the approved set, and it then does not run.
- **Consent is to a body.** An edit that changes an approved script task's
  body or time limit, or turns it into another type of task (or another type
  into a script task), takes it out of the approved set, and the new body needs
  consent by the same rule. Under Full with autorun that rule asks nobody: the
  edit that writes the new body approves it as it commits. Otherwise a script
  approved as shown could run as something else. The same question for an AI task's prompt belongs to the
  mandate (#23).

### The effect allowlist

The user's standing approval for named effects, beside the planner allowlist
(ADR-0026), which names reads.

- **A rule is matched against the whole command, flags included.** A planner
  allowlist rule reads only the words before the command's first flag; an
  effect's flags change what it does (`--force`, `--delete`), so an effect
  rule must match every word, in order. `git push origin feature/*` covers
  `git push origin feature/login`, and not `git push origin feature/login
  --force`. `*` stands for one word, or inside a word for any run of
  characters, as in the planner allowlist, except that it never stands for
  what changes the effect (see below).
- **A rule names its operation before any `*`.** The words up to and
  including the operation's verb are spelled out, so `az webapp config * set`
  is not a rule, while
  `az webapp config appsettings set --resource-group dev --name * --settings *`
  covers setting any app setting on any app in one resource group.
- **It covers a `commands` body only, and only when every command in it is
  covered.** A `script` body is shell, and matching shell text against a rule
  is the classifier's problem again (ADR-0036). A script needs a person,
  autorun in Full, or an Act supervisor.
- **A `*` never stands for what changes the effect.** It never stands for a
  word starting with `-`, `+` or `:` (a flag, a refspec's force or delete),
  unless the rule's own word starts that way, so `git push origin *` covers
  neither `--force` nor `+main` nor `:main`. It never runs over a `:`, except
  inside a `scheme://` URL, which is a value an effect takes (`curl -X POST *`),
  so `feature/*` cannot name `feature/x:main`, which pushes to `main`; a rule
  spells out a colon itself, as in `docker push app:*`. On Windows a word
  starting with `/` counts as a flag too; elsewhere it starts a path, which is
  a value.
- **The planner allowlist's `!` exclusions hold for effects too**, and an
  exclusion wins; a `!` entry written in the effect allowlist counts as one. A
  command exclusion is matched as the planner allowlist matches it. A path or
  URL exclusion holds for an argument that names an absolute path (or one
  starting `~`) or a URL it covers: the argument whole, or the part after a
  `=`, `@`, `:` or `,` or a short flag (`--url=…`, `-d @…`), as written or
  normalised. A path also stands as `dir/*`, so `!/home/me/.ssh/*` holds for
  `/home/me/.ssh` itself, and a URL as its origin. A relative path is not
  checked, since the body does not say where it runs.
- **A program named by its path (`./bin/deploy`) is never covered**: it is a
  file the repository ships (ADR-0026).
- **A rule that runs the repository's own code** (`npm run deploy`,
  `make release`) runs whatever the repository holds when it runs. Such rules
  are the user's to write; the list has no built-in entries at all.
- **An entry that is no rule is ignored, with a warning**: one whose program
  is named by its path or is a `*`, or whose operation is not spelled out
  before its first `*`.
- **User settings only**: VS Code `ordewell.effectAllowlist`, elsewhere
  `ORDEWELL_EFFECT_ALLOW` (comma- or newline-separated), refused from a
  workspace's environment files like the other approval settings (ADR-0016,
  ADR-0026), and read on every request.
- The mandate's `effect` grant takes it over when the mandate lands (#23).

### The scheduler starts only approved tasks

The consent rule holds only if nothing else starts the task. Today the
scheduler starts any pending task, so a task the planner adds in the user's
turn during a run starts on its own, while the planner's own `run_task` of it
is refused (#95). For a script task, that would run an effect still waiting
for the user's consent.

**The scheduler starts only tasks in the plan's approved set** (`approvedTasks`):
every task when the plan is executed, a task the user adds by hand or starts
themselves, a task an Act supervisor adds, and one a Full planner, or a Full
supervisor at Act, starts with autorun on. Any other task added after approval waits, shown as "waits for
your approval" on every surface. This is the first of #95's two options, and it
makes ADR-0029's "an unapproved task never starts" true of the scheduler too.

How the user approves what waits, without starting anything early:

- **With autorun on, a task the planner adds in the user's turn needs no
  approval, a script task apart.** Autorun is the user's standing word that
  they need not approve what the planner writes; the tasks the edit wrote are
  approved as it commits, in Full and in Guarded alike, and start once their
  dependencies finish. The setting is read as the edit commits, so turning
  autorun off first holds the task. A task added while autorun was off is
  approved when the planner next rewrites it with autorun on. A supervisor's
  wake-up turn is not the user's turn and approves nothing this way, unless it
  is at Act under Full with autorun.
- **A script task is the exception: autorun approves one only where
  `run_script` would run it unasked.** That is Full with autorun, on a first
  plan as on an approved one, or a body the effect allowlist covers. In Guarded, any other script
  task the planner writes waits for the user's approval, through autorun's own
  start of a submitted plan too, and no card is asked:
  its row shows the body verbatim, and starting it, or Execute, is the user's
  consent. Otherwise a Guarded user's turn with autorun on would run a script
  the user was never shown, and a card the user denied could be undone by the
  next edit in the same turn.
- **With autorun off, a script task added by `edit_plan` waits for approval even
  when the effect allowlist covers it.** The allowlist pre-approves a script
  through `run_script`, and through an edit only while autorun is on.
- **`/run` (Execute) while a run is under way approves every task that waits.**
  It does not restart the run: each approved task starts once its dependencies
  finish, and the answer says how many were approved. A run the scheduler was
  not driving, one task started on its own, becomes the plan's run.
- **The planner's `run_plan` during a run joins it and approves nothing.** Tasks
  started one by one with `run_task` are no scheduled run: when one finishes,
  nothing starts its dependents. In a plan the user has approved, `run_plan`
  makes them the plan's run, so the scheduler starts the dependents, and only
  those already in the approval record: a task added since still waits for the
  user, and the answer names it. It grants nothing `run_task` does not, since
  the planner can start each approved task itself, and Guarded still asks the
  user first. In a plan the user never executed it is refused, saying that
  executing the plan is what makes the run. Under Full with autorun neither
  holds: it approves what waits and makes the run, on a first plan too
  (ADR-0030).
- **A force start never skips unfinished dependencies.** It approves the task.
  If every dependency it would build on has finished, it starts now. If one is
  still under way or yet to run, the task is approved and queued, and the
  answer says which it waits for ("starts once task X finishes"). Outside a run
  it adds that nothing starts it until the plan runs. A force start does go
  past a failed dependency (ADR-0034) or a merge gate (ADR-0020), as asked, but
  still waits for any other dependency that is under way. A dependency blocked
  behind the failure is gone past with it, but what that dependency waits on
  that is under way or yet to run is still waited for. A Stop withdraws a
  queued start (ADR-0029), whether or not a run is under way.

### What stays

- **No planner writes repository files**, in any mode, through any tool. A
  code change is a change task: a worktree, a landing, the handoff's review
  (ADR-0013).
- **The envelope.** `run_command` keeps ADR-0008 and ADR-0026, and where a
  sandbox holds it, what it would refuse runs sealed instead (ADR-0036). Its
  refusals and the `allowlist` mode now point the planner at `run_script` for
  an exact effect, and at an ops task for one that needs judgment.
- **Ops tasks stay** for effects that need a model: watching a pipeline and
  reacting to it, investigating a failed deploy, an operation whose next step
  depends on what the last one found.
- **Repository config still runs nothing for a planner** (ADR-0028). A script
  task is a task: it runs what its body names, which may be the repository's
  own code, under the consent above.

### The record

The timeline records a script task's start as it records any start through the
seam (ADR-0029), with who asked (the user, a planner turn, the supervisor,
autorun), how it was consented to (the card, an allowlist rule by name, autorun
in Full, Act) and its verdict. Surfaces draw it as an ops task whose prompt is
its body, read-only. The end of a `run_script` that was still running after its
minute is recorded beside its start.

## Considered options

- **Keep "the planner never acts" and make ops tasks cheaper.** Rejected: the
  cost is the model between the request and the command, and a cheaper runner
  is still a model interpreting a prompt.
- **Give the planner its harness's own shell with the user's credentials.**
  Rejected: Ordewell sees only part of what a native shell runs before it runs
  (ADR-0026), so effects would escape the consent and the plan. ADR-0036 offers
  the native shell as an opt-in without the user's credentials, so it stays a
  way to read.
- **Move `git push`, `git commit` and cloud writes from `refuse` to `ask` in
  `run_command`.** Rejected: an approval is remembered per scope (ADR-0008,
  T1), so one yes to a push would cover every later push, and the effect would
  be a research step with no gate, retry or verdict.
- **The `allow` approval mode (ADR-0026) as the answer.** Rejected: it runs
  cloud writes with no record in the plan, and `git push` and `git commit` stay
  refused under it.
- **A runner told to run exactly this script.** Rejected: it pays for a model
  session that adds nothing, and puts a model between the script and its
  verdict.
- **Record effects in the research log only.** Rejected: the plan is the
  record of what runs (ADR-0001), and a research step has no merge gate, no
  Merge-all exclusion, no retry and no verdict.
- **Let the effect allowlist cover scripts.** Rejected: matching shell text
  against a rule is the classifier's problem again.
- **Built-in effect allowlist entries.** Rejected: a default pre-approves an
  effect the user never chose.
- **In Full with autorun, a first plan gets the card.** The earlier rule:
  `run_script`, and a script task in a plan, needed a plan the user had already
  approved. Dropped: it asked a person the user had said was not needed, and
  stopped on a dependency no one could see, since a plan autorun failed to start
  stayed unapproved for the rest of the session. It guarded nothing ADR-0030 had
  not already given up, since an ops task on that same first plan ran from a
  plan no person read, and it pushed the planner back to ops tasks, which show
  less of what will run.
- **Run every script task unattended in Full.** Rejected: without autorun the
  user reviews what the planner proposes, and an effect gets the same review,
  on the card, when it would run.
- **Let autorun approve a script task in Guarded too.** Rejected: Guarded means
  the user is asked first, and a script the planner wrote in their turn would
  run having been shown to no one. The approval card is the one place the body
  is put in front of them before it runs.
- **Ask for every script task until the mandate.** Rejected: autorun in Full
  already starts ops tasks unattended (ADR-0030). A stricter rule for script
  tasks than for the ops tasks they replace would push the planner back to ops
  tasks, which show less of what will run.
- **Script tasks that change files** (a codemod or a formatter, in a worktree).
  Deferred: change tasks are landed and reviewed, and nothing here needs a
  deterministic one.
- **#95's second option: a task the planner adds in the user's turn counts as
  approved.** Rejected: the user asked for a change, not for every change the
  planner then chooses; for a script task, it would run an effect nobody saw.
- **Names.** *Command*, *action*, *effect* and *operation* were rejected for
  ops tasks (ADR-0020) and stay unused for this. *Script task* says what the
  body is.
- **A force start that ignores dependencies.** The earlier behaviour: a task
  started on work that was not there yet. Approving and starting are separate
  acts; the force start approves, and the task starts when what it builds on
  has finished.
- **`/run` during a run refused as already running.** The earlier behaviour: the
  only way to approve a waiting task was to start it by hand, early.
- **Autorun approving only what the user wrote.** Rejected: autorun is the
  user's word that they need not approve what the planner writes in their
  turn, and the held task otherwise sat with no card.

## Consequences

- "Set this value and push" is one script task: one row in the plan, run in
  the planner's turn, with its output and its verdict.
- The planner has three shapes for a change to the world: a script task when
  it can state the commands, an ops task when the work needs judgment, a change
  task for files.
- The injection risk ADR-0029 and ADR-0030 accept for ops tasks under Act and
  autorun applies to script tasks too, narrowed in one way: what runs is the
  script that was written, shown verbatim. Declared scope and the escalation
  of outward effects stay with the mandate (#23).
- In Full with autorun, more runs with nobody reading it. A script on a first
  plan can run from something injected into what the planner read, an issue
  body or a fetched page, with no card and no plan a person saw, as an ops task
  already could. That is what Full with autorun asks for, and it is the trade:
  the user gives up the last point where a body was put in front of them, and
  keeps the record, the verdict and the two switches, read at each start. The
  timeline shows what ran, afterwards.
- During a run, a task added after approval waits for approval (#95); every
  surface gains that row state.
- The plan schema gains `type: 'script'` with `commands` or `script` and an
  optional time limit; `submit_plan` and `edit_plan` accept it; the execution
  tools gain `run_script`.
- AGENTS.md states the script-task exception to the `task_complete` rule,
  CONTEXT.md defines *Script task* and *Effect allowlist*, and SECURITY.md's
  "What each part can touch" names both.

## History

- 2026-10-15 — accepted; settles #95 with its first option. Not yet implemented.
- 2026-10-16 — #95 implemented: the scheduler starts only tasks in the approval record, checked at the one claim every start passes, and a task the user adds by hand is approved as it lands. A task added after approval waits, shown as waiting for the user's approval to start in VS Code, the TUI, `ordewell status` and `ordewell run`; the user approves it by starting it or executing the plan. Seen live: in Guarded with autorun on, a task the planner added in the user's turn during a run started on its own, with no card. Script tasks and the effect allowlist are not yet implemented.
- 2026-10-17 — approving what waits: with autorun on the planner's additions in the user's turn are approved as they land, `/run` during a run approves every waiting task and joins the run, and a force start approves the task but queues it behind dependencies still under way; the rows say "waits for your approval" and name the key that approves.
- 2026-10-17 — a force start past a failure waits for the work a blocked dependency waits on, and a Stop with no run under way withdraws a queued start.
- 2026-10-21 — script tasks, `run_script` and the effect allowlist implemented (#107). The plan model, the validator, `submit_plan`, `edit_plan` and the plan JSON accept `type: 'script'`; `ScriptSession` runs a body at the workspace root with no model, behind an ops task's merge gate and Merge-all exclusion, and hands its exit status to `VerdictEngine`. `run_script` is on the MCP server and the API planner, and the end of one still running after a minute reaches the planner as a report. Consent follows the table, and an edit to a body, a time limit or the type withdraws an approval. The effect allowlist is `ordewell.effectAllowlist` / `ORDEWELL_EFFECT_ALLOW`, with the wildcard and exclusion rules above. Surfaces draw a script task read-only; the timeline records who asked and how it was consented to. Where the built code differs from this ADR's first text: autorun in Guarded does not approve a script task the planner writes in the user's turn unless the effect allowlist covers it, and no card is asked; with autorun off, a script task added by `edit_plan` waits even when the allowlist covers it; the autorun row of the table needs an approved plan; Execute leaves out a script whose card is open; a script waiting at a closed merge gate keeps its queued start across an edit that leaves its body alone.
- 2026-10-24 — the planner's `run_plan` while only tasks started with `run_task` are running joins them into the plan's run, approving nothing, as the user's Execute does; before, it was refused as "already running" and the dependents of those tasks started only by hand.
- 2026-10-24 — a script attempt's whole output is kept in a file beside its log, named in the verdict and as a handoff artifact; before, the log kept the first 32,000 and last 16,000 characters and the verdict the last 4,000 of stderr, which lost the failure of a long command.
- 2026-10-26 — `run_script` adds its task to the plan as the turn's committed edits left it, and autorun approves what an edit wrote as it commits: a tool's edit commits as its call answers (ADR-0022, P2).
- 2026-10-31 — in Full with autorun nobody is asked on a first plan either, and a start there makes the plan approved; an approved plan is no longer a condition of the consent table's autorun row.
- 2026-10-31 — under Guarded autorun's start of a submitted plan leaves a script task the commit left unapproved; before, that start approved it and ran it.
