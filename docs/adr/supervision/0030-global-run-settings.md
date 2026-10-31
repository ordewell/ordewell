---
status: accepted
amends: ["0001", "0013", "0020", "0029"]
---

# 0030 — Run settings are saved once and live per session; autorun

*Pending:* [ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) — delegation joins the run settings, off by default, and the Parallel limit counts a whole tree.
*Pending:* [ADR-0056](0056-a-mandate-narrows-down-the-tree.md) — the root's mandate is derived from these settings on each read; a child's is saved with its plan.

**Amends:** ADR-0029 — the supervisor level, merge at gates automatically, the
retry limit and the wake-up read budget stop being per-plan settings saved at
run start; the default level becomes Watch; "an unapproved task never starts"
gains the autorun exception. ADR-0013 and ADR-0020 — "the user opts in per
plan" becomes "the user opts in". ADR-0001 — where the Full/Guarded level is
saved, not what it means.

## Problem

ADR-0029 made four settings plan settings: the supervisor level, *Merge at
gates automatically*, the supervisor's retry limit and the wake-up read budget.
Each is saved on the plan and captured at run start, so a change during a run
applies to the next one. Only a lowering of the level takes effect at once.

In use, that shape is wrong three ways:

- **They describe the user, not the plan.** How much a person lets Ordewell act
  for them does not change from one goal to the next. Per plan, every new
  session starts at the defaults and the user sets them again, or forgets to.
- **"Applies to the next run" reads as broken.** The user turns auto-merge on
  during a long run, the next gate waits anyway, and nothing on screen says
  why. ADR-0029 borrowed the rule from ADR-0001's modes, but the reason does
  not carry over: a mode is part of the plan the user reviews and of what a
  task runs with; the level and the merge setting are neither.
- **A session still stops at review.** Even at Act with auto-merge on, a new
  goal waits for the outline to be confirmed and for Execute. A user who wants
  to state a goal and come back to a finished run has no setting for it.

ADR-0029 stated the per-plan choice but weighed no alternative to it, so no
rejected option is reopened here.

The Full/Guarded level (ADR-0001) has a related problem. The TUI and CLI save
it in `~/.ordewell/.env`, which the daemon reads only when it starts, and the
extension in VS Code's own `ordewell.autonomousMode` setting, so two surfaces
on one machine can disagree.

## Decision

**Full/Guarded, the supervisor level, merge at gates automatically, autorun,
the retry limit and the wake-up read budget are the user's settings, saved
machine-wide in `settings.json`.** Full/Guarded, the supervisor level, the merge
setting, autorun and the retry limit are changed through `/settings` (or the
headless commands behind it). The wake-up read budget and the Planned-with line
have no panel row: only `ordewell supervisor reads <n>` or an edit of the file
sets the budget, and only `ordewell trailer` or an edit of the file sets the
line. A change made through `/settings` is saved to the file and applies at once
to the session it is made in. Every other open session keeps the values it
opened with; the file is the default a new session (or one reopened after
closing) starts from, so the last change made anywhere is what the next session
opens with. The Planned-with line is the exception: every session reads it from
the user's setting as it writes a commit, so a change reaches the next landing in
any session. Autorun, a new setting, starts the plan when the planner submits
it. Full/Guarded and the parallel limit are not run settings and stay
machine-wide: every open session sees a change to them.**

### One store, and a copy per open session

`settings.json` in the global data dir (`SettingsService`) holds every value.
There is no per-plan value and no per-workspace override.

- **An open session holds its own copy of the run settings.** It is seeded from
  the file when the session opens, created or adopted, and only a change made in
  that session moves it. It is not saved with the session: closing drops it, and
  reopening reads the file, as a new session does.
- **The plan stores none of them.** Older plans' `supervisorLevel`,
  `mergeAtGatesAutomatically`, `supervisorRetryLimit` and `wakeUpReadBudget`
  are ignored on load and dropped on the next save. A plan once set to Act
  opens under the session's level: the safe direction, accepted rather than
  migrated.
- **A run keeps its own copy, `runSettings`, taken from the session's copy.**
  It is what the run actually used, the record behind the timeline, and the
  value a guard or a failure lowers.
- **Full/Guarded moves too.** On first start, a value in `~/.ordewell/.env` or
  a non-default `ordewell.autonomousMode` is copied into `settings.json` once,
  so nobody's level flips; the VS Code setting is removed from the extension.
  `ORDEWELL_AUTONOMOUS_MODE` stays as an override from the environment, but
  Ordewell no longer writes it. Its meaning is unchanged: read at generation,
  never at spawn (ADR-0001).
- **No new environment variables.** A script or CI run that needs its own
  values points `ORDEWELL_SETTINGS_PATH` at its own file.

| setting | values | default |
|---|---|---|
| autonomy level | Full, Guarded | **Guarded** |
| supervisor level | Off, Watch, Act | **Watch** |
| merge at gates automatically | on, off | off |
| autorun | on, off | off |
| Planned-with line in commits Ordewell writes (not in the panels) | on, off | **on** |
| supervisor retry limit | whole number ≥ 0 | 2 |
| wake-up read budget (not in the panels) | whole number ≥ 1 | 12 |

Watch becomes the default because it only reads and writes notes to the user:
it never acts, and it makes the planner's watching of a run something a new
user has without asking. Its cost is planner usage on each wake-up. Older
plans that loaded as Off follow the session's value like any other.

### Panels, not plan controls

The settings change in the planner chat, through `/settings`: a stepped panel in
the TUI and the Run block of the chat's Settings panel in VS Code. A change is
saved as it is made; there is no one-slash-command-per-setting on either surface.
The headless CLI keeps one command per value for scripts, where no panel exists.
The Planned-with line and the wake-up read budget have the command and no panel
row.

| headless command | sets |
|---|---|
| `ordewell auto [full\|guarded]` | autonomy level |
| `ordewell supervisor [off\|watch\|act]` | supervisor level |
| `ordewell supervisor retries <n>` | retry limit |
| `ordewell supervisor reads <n>` | wake-up read budget (no panel row) |
| `ordewell automerge [on\|off]` | merge at gates automatically |
| `ordewell trailer [on\|off]` | Planned-with line in commits Ordewell writes |
| `ordewell autorun [on\|off]` | autorun |
| `ordewell parallel [<n>]` | tasks that run at once |

Parallel is the exception to the one store: the TUI keeps it in `.env` and
VS Code in `ordewell.maxParallelSessions`, not in `settings.json`.

Choosing Act or turning autorun on asks to confirm and says what it allows,
ops tasks on real systems included. The plan pane's `G`, `W` and `L` and VS
Code's plan-card controls are removed: one route per setting. `L` had no job
left, since lowering the supervisor now lowers the run at once.

**The planner cannot change any of them.** The panel and the headless commands
never reach the planner as a message, and no planner tool, MCP tool or route the
planner can reach sets a run setting. A supervisor that could raise its own
level would make the level its own consent.

### The Planned-with line

`plannedWithTrailer` is not about a run's supervision: it decides whether the
commits Ordewell itself writes (ADR-0013) end with the git trailer
`Planned-with: Ordewell`. It is a run setting only in being the user's, saved in
`settings.json` and set with `ordewell trailer [on|off]` or by editing the file;
the panels do not show it, being a preference set once, not a run control. On by default, because the line
is how a reader of the history learns a change was planned and landed by
Ordewell; off for those who would rather keep history free of it. The run keeps
no copy: the line is read from the user's setting as each message is written,
so a change reaches the next landing, in any session, without a restart.

### Seeing them

The welcome screen's Setup block, in the TUI and in VS Code's empty chat, gains
two rows: **Autonomy** (Full/Guarded) and **Run** (supervisor level, auto-merge,
autorun), both pointing at `/settings`. Act and autorun on are drawn as a
warning, as the autonomous mode's `⚡` is. A status badge shows the same values
at all times, not only during a run, and during a run shows the run's level
where it differs from the session's one: `Act → Watch` once the wake-up-rate
guard has lowered it, with the reason in the supervisor's note. In the TUI the
badge sits at the right end of the status row and is left off the bare welcome
screen, whose Setup block already shows the same values.

While a session is open both rows show that session's own copy. The bare welcome
shows the file's values, which the session a user starts next will open with.
Full/Guarded and Parallel are machine-wide in either case.

The status row it shares with the badge speaks for the chat on screen and for
nothing else: whether that chat is planning, condensing, working or paused on a
usage limit, and nothing when it is idle. What the run waits on (tasks that wait
for you, a pause for Merge all) is shown in the plan pane's title, or on the
status row when there is no plan pane.

The two rows keep the glossary's line: *autonomy* names Full/Guarded only, and
the other four are the **run settings**.

### When a change applies

A change in `/settings` updates **the saved file and the session it was made in,
at once, in either direction.**

- **The session's run, if one is under way, takes the new value now.** Its
  `runSettings` is updated and the next merge gate, wake-up, retry or read is
  decided by it.
- **Every check at the command seam reads the run's level at the moment of the
  call.** A wake-up turn already under way is held to a lowering at once, as
  ADR-0029 already says, and may use a raise at once; its prompt still carries
  the rules it was given, so a raised turn may only suggest. The next turn is
  told the new rules.
- **Every other open session keeps the values it opened with, its next run
  included.** It does not read the file again while it is open. A raise or a
  lowering made in one window therefore never reaches a run the user was not
  looking at, nor the next one in that window.
- **A new session, or one reopened after closing, starts from the file**, so
  the last change made anywhere is what it opens with. A closed session keeps no
  copy: a surface showing it reads the file, as a new session would.

There is no "lower every run everywhere" from one window; lowering a run is done
in its session, or by stopping it.

### The user's change beats an automatic lowering

ADR-0029 lowers a run for its rest when a loop guard trips (Act to Watch) or
the supervisor fails (unsupervised). A user's change after either sets the run
to the level chosen:

- **After a guard**, the loop guards keep their memory — retries, failed-attempt
  shapes, the supervisor's edits — so raising the level never resets a limit.
  Only the wake-up rate window is cleared; kept, it would trip again at the next
  wake-up.
- **After a failure**, the change restarts supervision. Wake-ups not delivered
  are handed over whole at its first turn, as they are after a user message.

It is a fresh consent, given after the notice that explained the lowering.

### Autorun

**With autorun on, a plan the planner submits is approved and started when its
reply ends, as if the user had pressed Execute.** It is a switch of its own, independent of the
supervisor level, for the reason ADR-0029 keeps auto-merge independent: two
consents, "I do not need to see the plan" and "act for me when something goes
wrong", that users want in either combination.

- **The planner skips the outline gate.** Its prompt, read on each turn, tells
  it to write the outline into the chat as the plan's summary and submit
  without waiting. It still asks clarifying questions when it needs answers:
  a guess on real ambiguity that then runs unattended is the costly failure.
- **It fires on a submission only** — the first plan of a session, or a new
  plan after a run has finished. Never when a session loads with a plan
  waiting, and never when autorun is turned on while one waits: that plan is
  already in front of the user. An edit starts nothing either: the planner
  calls `run_plan` when the user wants it run.
- **It never silently does nothing.** A task the planner started with `run_task`
  in the reply that submitted the plan is live when the reply ends. In Full,
  autorun joins that work as one scheduled run, by the path Execute takes during
  a run, so the dependents start and the plan is approved; it skips only when a
  scheduled run is already going, which has the plan's tasks. One waiting on a
  person, or held by a usage limit that gives it back, with nothing live, is
  still going, in Full and in Guarded: starting a run over it would take back
  its pause and its failures
  ([ADR-0053](0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).
  In Guarded it does not join, since a join would approve a script task the user
  was never shown ([ADR-0035](0035-effects-are-consented-and-recorded.md)). A
  usage limit holding anything else, a task started alone or a run that ended on
  a failure, is left as it is too, and the plan waits for Execute, which takes it
  in for the reset to go on with. The refusal is in the timeline, and whenever
  autorun cannot start a plan a notice says why.
- **A Stop since the plan was submitted wins.** Autorun's start is admitted as
  the plan lands, so a Stop after that withdraws it as it withdraws any start
  not yet claimed ([ADR-0029](0029-the-supervisor.md)): the run stays stopped, the
  plan stays as it is, and a notice says so. It is a run to stop while the reply
  it waits on is open, so that Stop is not told there is nothing to stop, and a
  user's Stop counts even when it finds nothing at all. A plan submitted after
  the Stop is a new start, and a run opened after it, the user's Execute, has
  the plan already, so autorun neither starts it nor says it did not.
- **A failure in the reply stays a failure.** A task or script task that failed
  in the reply is not run again by the run that follows it, on either path: the
  fresh chance is the user's to ask for
  ([ADR-0053](0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)),
  and a failure nobody saw retried would go unread. It is listed, and blocks its
  dependents, as any does. A task that failed before the reply gets the chance a
  run gives, as it does from Execute: resubmitting a plan after a failed run is
  asking for it again.
- **The approval and the start are recorded** in the timeline as `run_plan`
  through the command seam, with autorun as who asked, and drawn as
  "Started by autorun".
- **It works under Guarded.** Guarded keeps meaning what ADR-0001 says, the
  runners' safe modes; autorun answers whether the plan waits, not what each
  task may do. ADR-0029's rule that a planner's own `run_task` and
  `retry_task` ask in Guarded is unchanged: autorun is the user's standing
  instruction, not the planner choosing to start. Its start leaves a script task
  as the commit left it: unapproved, that waits for the user
  ([ADR-0035](0035-effects-are-consented-and-recorded.md)), and the rest runs.
- **It starts ops tasks too.** This is a deliberate choice, and it carries the
  risk ADR-0029 names for Act's added tasks, wider: an instruction injected
  into something the planner read can become an ops task that runs on real
  systems from a plan no person read. Holding plans with ops tasks for review
  was weighed and rejected below. The narrower answer — declared scope per ops
  task, escalation of outward effects — belongs to the mandate (#23), which
  revisits this. Until then, turning autorun on is the user's statement that
  they accept it, and its confirmation says so.

This is the exception to ADR-0029's "an unapproved task never starts": under
autorun, submission is approval, a script task under Guarded apart.

**With autorun on and Full, nobody is asked: a planner turn may start anything,
on a first plan as on an approved one.** That is `run_task`, `run_plan`,
`run_script`, a retry, and script tasks. Otherwise a task waits for a person the
user has said is not needed: a task added to an approved plan stops a finished
run at the first follow-up, and a first plan the planner started by hand is
refused `run_plan` for the rest of the session.

- **The planner starts it, when it asks.** Nothing starts on its own: adding a
  task for later stays possible, and autorun still fires on a whole submitted
  plan only. `run_plan` starts the whole plan, or makes the work already live
  one scheduled run and approves what waits, so the planner never needs to drive
  tasks one by one. It leaves what failed as it is, as it does anywhere
  ([ADR-0053](0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)):
  a planner's `retry_task` is what starts a failed task again.
- **Such a start makes the plan approved**, as autorun's own start does, so
  nothing later in the session is refused for it.
- **A start in the reply that adds the task goes through at once**, since the
  edit is in the plan as its `edit_plan` call answers (ADR-0022, P2; ADR-0029).
- **Both settings are read at the start**, not when the task was added, so
  turning autorun off or going to Guarded stops it at once. A start that goes
  through approves the task, as the user's own start does.
- **Ops tasks too**, for the reason autorun starts them in a submitted plan.
- **Script tasks, and `run_script`, in Full only** ([ADR-0035](0035-effects-are-consented-and-recorded.md)).
  With autorun on in Full, `run_script` runs a script without asking, and a
  script task the planner writes, a rewritten body included, is approved as it
  lands. Under Guarded autorun does not do so: `run_script` asks
  on the approval card, and a script task the planner writes waits for the
  user's approval unless their effect allowlist covers it. A script's body is
  shown verbatim either way.
- **A planner turn the user started, or a supervisor at Act.** A wake-up turn
  at Act is never refused for a plan the user has not approved; at Watch and Off
  the supervisor's level refuses it as ever (ADR-0029). Under Guarded or with
  autorun off, a task the user has not approved waits for them as before.
- **Effects stay recorded.** The effect allowlist, the record of every effect
  and a script's verdict do not change: each is a task, its consent recorded as
  autorun ([ADR-0035](0035-effects-are-consented-and-recorded.md)).

### API

`GET /api/settings` answers every run setting and the autonomy level; with
`?sessionId=` it answers that open session's own copy, and an unknown or closed
id falls back to the file rather than erroring. `PATCH /api/settings` changes
any of them, writes the file, and with a `sessionId` also applies the change to
that session at once and answers with that session's values, as a change in
`/settings` does. The per-plan
`PATCH /api/plans/:sessionId/settings` and
`POST /api/plans/:sessionId/supervisor/lower` are removed: their only client is
the CLI's own `apiClient`, and the project is before 1.0.

The route takes the run settings as named fields, never the autonomy level.
Full/Guarded stays in `SETTINGS_ENV_REFUSED`'s approval-posture class: a
surface writes it to `settings.json` itself, through `SettingsService`, and
the daemon reads it from there at generation.

## Considered options

- **Rejected: keep them per plan.** Every new goal starts at the defaults, and
  the settings describe the user, not the goal.
- **Rejected: per workspace.** A setting saved per
  repository is set again in every repository and forgotten in most. A
  per-workspace override for a repository with ops tasks on production can
  come later if it is needed.
- **Rejected: a global default with a per-plan override.** Two values for one
  setting, and a pane that must show which one won.
- **Rejected: keep "applies at the next run".** The rule fits modes, which are
  part of the reviewed plan; it does not fit the level or the merge setting,
  and it makes a change look ignored.
- **Rejected: a change reaches every session's run at once.** It would raise a
  run in another repository, perhaps one with ops tasks, to Act without the
  user looking at it.
- **Rejected: every open session reads the file live.** A change made in one
  window moved another window's panel while that window's run kept its own
  values, so the panel and the run disagreed. The session now holds the copy its
  panel shows.
- **Rejected: keep one session's change in every open session's panel but not
  its run.** The same disagreement, with a second rule to explain why a shown
  value is not what will run.
- **Rejected: raises apply only to the typing session, lowerings everywhere.**
  Safer for a "stop everything", at the cost of an asymmetry no other setting
  has. Sessions keep what they started with, as in other agent tools.
- **Rejected: a guard's or failure's lowering holds over the user's change.**
  It brings back "change it now, it applies later" for the case where the user
  has just read why.
- **Rejected: autorun implied by Act, or allowed only with Act.** It ties two
  consents together and forbids autorun with Watch or Off, and Act without
  autorun.
- **Rejected: autorun skips clarifying questions too.** The planner would guess
  on real ambiguity, and the guess would run unattended.
- **Rejected: autorun skips only the final review.** The outline confirmation
  becomes the review, and the user still answers once per session.
- **Rejected: autorun holds plans with ops tasks for review, or holds the ops
  tasks back.** Safer against injection; recorded as a choice for #23 to
  revisit, not as safe.
- **Dropped: the planner's starts under autorun need an approved plan.** It was
  the rule until 2026-10-31, for fear of a plan no person had looked at. It did
  not hold that line, since autorun already started such a plan, ops tasks
  included. A planner that called `submit_plan` and `run_task` in one reply left
  the plan unapproved for good: autorun saw live work and did nothing, `run_plan`
  was refused both ways, dependents never started, and the user had to start a
  script task by hand, in Full with autorun on.
- **Rejected: start on `edit_plan` too.** An edit may add work for later, and a
  turn may make several; the planner says when it wants a run.
- **Rejected: autorun joins live work in Guarded too.** It would approve a script
  task the user was never shown, which Guarded's autorun does not do.
- **Rejected: Guarded turns autorun into an approval card.** One setting would
  silently switch another off.
- **Rejected: autorun on by default.** A new user's
  first goal would run agents without permission prompts from a plan they never
  saw, and the README's "review the plan" would describe a product that is not
  there out of the box.
- **Rejected: mirror the values into VS Code's settings.** Two stores and a sync
  with conflict rules, for a settings page. The `/settings` panel and the Setup
  row show them on every surface.
- **Rejected: an "Autonomy" label over all of them.** The glossary keeps
  *autonomy* for Full/Guarded; a Guarded session can have an Act supervisor.
- **Rejected: a row in the /settings panels for the Planned-with line.** A
  preference most users set once, or never, would take up space in the main
  settings menu beside the values that change how a run is supervised. The
  headless command and the file are enough, as with the daily version check
  (ADR-0048).
- **Rejected: a row in the /settings panels for the wake-up read budget.** It is
  an advanced loop limit, not a run control a user tunes from the chat; a row
  beside Autonomy and Supervisor would suggest it is safe to change without
  knowing how the supervisor wakes. The headless command and the file stay.
- **Rejected: keep the old routes as aliases.** One in-repo client, before 1.0.

## Consequences

- `UserSettings` holds these values; the plan keeps `runSettings`, which one
  module owns (`RunSupervision`): a session seeds its own copy when it opens, a
  run the user starts copies them, keeps them for a run that continues, and
  applies the user's change to the run under way (`Session.applyRunSettings`).
  The scheduler keeps no value of its own: it reads the run's `runSettings` as it
  decides each automatic merge.
- The TUI and VS Code gain `/settings` and the Setup rows, and lose `G`, `W`,
  `L` and the plan-card controls. VS Code's `ordewell.autonomousMode` goes.
- The planner prompt gains an autorun branch: no outline gate, submit after the
  summary. The rule is read each turn, so turning autorun on mid-conversation
  changes the planner's next turn.
- The timeline gains autorun as an actor.
- With autorun on, Full and Act, Ordewell can go from a goal to changes on real
  systems with no person reading anything. Each of the three is a separate
  setting with its own confirmation; #23 owns the narrower answer.
- With autorun on and Full alone, a planner turn can too, a script task on a
  first plan included. An instruction injected into what the planner read can
  run as a script with no card and no plan a person saw, as an ops task already
  could. That is what the two settings ask for: the user trades every point of
  review for a run that does not stop, and reads the timeline afterwards.
- ADR-0013's "never merged for the user" holds unless the user opts in, once,
  for every plan.
- The README's "Review the plan" step names autorun in `/settings` as the way to skip it.

## History

- 2026-10-12 — accepted.
- 2026-10-12 — `/settings` in VS Code is a Run block in the chat's Settings panel, saving each setting as it is set; the terminal UI takes Parallel, retries and reads as typed numbers and steps with ←/→.
- 2026-10-12 — the terminal UI's `/settings` saves each step on enter and stays on it, instead of saving once at the last step; esc closes and keeps what was saved. Users wanted to see a choice take effect and leave with esc, as the VS Code Run block already allows. Act and autorun on still ask first, and the menu returns to the step either way.
- 2026-10-12 — with autorun on and Full, the planner may start a task added
  after the plan was approved; a start in the reply that adds it waits for the
  edit to land.
- 2026-10-12 — amended: the setting is read as "merge automatically": at merge
  gates and at the end of a run. A user who turned it on was still stopped at
  the end of the run, and the handoff overlay asked about a merge the
  supervisor was about to make. The settings key
  `mergeAtGatesAutomatically` is unchanged; the handoff is not opened by the
  surfaces while an automatic merge is coming
  ([ADR-0029](0029-the-supervisor.md), "Merge at gates automatically").
- 2026-10-13 — one owner of the run's settings (`RunSupervision`); the
  scheduler reads them as it decides instead of holding a copy pushed from
  several places. A run the supervisor opened had merged by the user's setting
  from another session rather than by its own.
- 2026-10-13 — in the TUI the badge sits at the right end of the status row
  rather than on a row of its own, and is left off the bare welcome screen,
  whose Setup block already shows the same values.
- 2026-10-14 — the status row the badge shares speaks only for the chat on
  screen; what the run waits on moved to the plan pane's title.
- 2026-10-21 — with autorun on in Full, the planner's `run_script` and the script tasks it writes in the user's turn run without asking; under Guarded autorun approves the rest of what the planner writes, but not a script task unless the effect allowlist covers it ([ADR-0035](0035-effects-are-consented-and-recorded.md)).
- 2026-10-21 — research limits lived in the global store and the live run copy, set from the `/settings` panel (ADR-0037 R4).
- 2026-10-22: the TUI and VS Code set every value in `/settings`; the
  one-value slash commands are gone from both, and the headless CLI keeps them
  for scripts. The panel was already the one place a user saw them together,
  and two ways to set one value read as two products.
- 2026-10-22 — the two research limits are removed: research starts are the
  planner's judgement, bounded by the run's Parallel limit ([ADR-0037](0037-research-tasks-wake-the-planner.md) R4).
- 2026-10-23 — the Planned-with line, a seventh value: whether Ordewell's own commits end with `Planned-with: Ordewell` (ADR-0013). On by default, read as each message is written, not copied onto the run.
- 2026-10-23 — the Planned-with line is not in the `/settings` panels or VS Code's Run block: it is set with `ordewell trailer` or in `settings.json`.
- 2026-10-25 — the autonomy level starts Guarded on a fresh install; an
  explicit Full, or one already saved, is kept.
- 2026-10-25 — the wake-up read budget leaves the `/settings` panels in the TUI
  and VS Code: it has no panel row and is set with `ordewell supervisor reads
  <n>` or in `settings.json`, which the headless command still writes.
- 2026-10-26 — a start in the reply that adds the task goes through at once: the edit commits as its call answers (ADR-0022, P2).
- 2026-10-27 — an open session shows and keeps its own run settings, seeded from `settings.json` when it opens; another session's change no longer moves its panel, and the file is the default the next session opens with.
- 2026-10-31 — in Full with autorun a planner turn or an Act supervisor may start anything, on a first plan too, and such a start makes the plan approved; autorun joins live work in Full rather than doing nothing, and says why when it cannot start a plan.
- 2026-10-31 — a Stop since the plan was submitted withdraws autorun's start, and what failed in the reply stays failed.
- 2026-10-31 — a user's Stop withdraws autorun's start even with nothing live, and a run opened after that Stop has the plan; under Guarded autorun's start approves no script task the commit left unapproved.
- 2026-10-31 — autorun restarts no run a usage limit holds, and skips a scheduled run with nothing live in Guarded as in Full.
- 2026-10-31 — the plan left to Execute under a usage limit is taken in for the reset to go on with; Execute no longer takes the pause back.
- 2026-10-31 — a planner's `run_plan` leaves what failed as it is, in Full with autorun as anywhere ([ADR-0053](0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).
