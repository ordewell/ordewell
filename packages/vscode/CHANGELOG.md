# Change Log

## [Unreleased]

### Fixed

- **Task and subtask prompts are keyboard accessible.** Editable prompts can be
  focused and activated from the keyboard; read-only prompts remain unchanged.
## [0.11.3] - 2026-10-29

### Fixed

- **Repository configuration introduced during a run waits for your consent.**
  A landing that adds or edits the configuration a runner loads at launch
  holds the next task start, which names each path until the configuration is
  committed for a new run or removed. Configuration already present when the
  run started, and instruction files, are not held.
- **A repository MCP server cannot take Ordewell's name.** A Claude Code change
  or ops task does not start when its directory declares a server named
  `ordewell`, since Claude Code does not document which server wins. Rename or
  remove that server to start the task.

## [0.11.2] - 2026-10-29

### Added

- **`/resume` opens the session browser.** It answers as an alias of
  `/sessions` in the chat, and is listed beside it in `/help` and the command
  suggestions (#139; thanks @Logic769).

### Fixed

- **Claude Code's named usage limits resume tasks at reset.** A five-hour limit
  message is recognized; when a reset time is available, the task resumes with
  its existing session and any kept worktree.
- **Claude Code's configured picker models are available.** Models in
  `modelPicker.options` appear in planner and task pickers, using the runner's
  home and workspace environment. Planner settings are checked against the
  workspace's own catalog, including before its models have been listed.
- **A task connecting Ordewell's tools shows its status.** Its card and chat
  show when the runner is connecting, and stopping it stops the runner without
  waiting for the connection.
- **Failed tasks have a Retry button.** It appears on task and subtask cards
  during and after a run. The Force Start, Skip, Retry and Cancel Task palette
  commands now ask for an eligible task, including blocked tasks for Skip.
- **Replacing a plan asks for confirmation.** Regenerate Plan confirms when an
  existing plan has tasks, and `/new` warns when it will stop a run.
- **Session and task handling is more reliable.** Late errors and fork editors
  stay with their session, and overlapping task starts, landings and conflict
  repairs keep their worktrees and holds until safe to release.
- **Smaller fixes.** Clear All Tasks restores run settings from the settings
  file; Toggle Runner keeps the last runner enabled; Save Session explains when
  nothing was saved; and command errors after `/new` appear in the chat.

## [0.11.1] - 2026-10-27

### Changed

- **The Marketplace overview no longer opens with a session recording.** The
  listing leads with the written introduction.
- **No extension code changed.** This release carries the version bump and the
  listing text.

## [0.11.0] - 2026-10-27

### Upgrade notes

New installations now start in Guarded autonomy. A read-only task can test
changes in its own throwaway worktree and lands nothing, and the planner's
plan edits apply as it makes them. A saved autonomy level or `ORDEWELL_AUTONOMOUS_MODE`
override is kept. Run settings now apply to the session on screen and set the
defaults for new or reopened sessions; other open sessions keep their values.
Autonomy, Parallel tasks and the Planned-with trailer remain shared.

The inert `ordewell.researchEnabled` setting has been removed. See the
[project changelog](https://github.com/ordewell/ordewell/blob/main/CHANGELOG.md)
for daemon and API upgrade information.

### Added

- **Sign in to a coding agent from the chat.** A signed-out Claude Code or
  Codex stays selectable, with a red dot and **Log in** on its Planner and
  Runners pills and its own row on the first screen, with the active planner
  first. The action remains available after the chat starts. It runs that
  agent's login in an integrated terminal with the workspace's environment and
  confirms its status afterwards;
  signing in another agent leaves the planner choice alone. A confirmed
  signed-out planner is refused before a turn is sent, with its login command
  in the message; task runners are not blocked by this preflight. Unknown
  status never blocks, including Codex API-key or custom-provider setups its
  status command cannot judge. OpenCode has no declared status or login command
  and stays unflagged.
- **Account limits in the footers.** When Codex, Claude Code or OpenCode Go
  plans, the planner footer shows what that account has used of its plan's
  windows (five hours, a week, a month) beside the planner's context and cost,
  and a task log's footer shows its own runner's, in the order context,
  limits, cost.
  Limits are read from each runner's own account, with your workspace's
  environment, about once a minute while the window has focus; the footer
  stays on one line, with reset times in the hover. They are never saved and
  never pause work.
- **An API planner compacts its own context.** An OpenAI, OpenRouter,
  OpenAI-compatible or Gemini planner targets a prompt budget of 90% of its
  model's known window, first trimming older file reads, then condensing the
  conversation. The original history is kept, including after a manual
  `/compact`. The context meter says when automatic compaction is unavailable because the
  window is unknown or the setting is off. The chat shows a Compacting status
  with Stop, then one quiet "Context compacted automatically" marker whose
  summary opens on demand. If a call still cannot fit, only the planner pauses,
  with your message kept and
  tasks still running, and a Retry compaction button above the composer
  attempts recovery. `"plannerAutoCompaction": false` in
  `~/.ordewell/settings.json` turns it off.
- **The first screen shows the repositories and branches tasks will use**
  in a repository card, with each one's commit, any uncommitted changes, and
  whether code tasks get isolated worktrees. It only reads, and refreshes on
  focus and on a settings or workspace change. The screen also explains
  whether plan submission waits for approval or starts automatically with
  autorun.
- **"Completion received" as soon as a task reports.** The card says so at
  once while the attempt winds down; the verdict still comes when it ends.
- **Read-only and research tasks can read the web** through Ordewell's own
  `fetch` and `web_search`, under the planner's web-read policy and without
  asking you; each decision is in the task's log, not the planner chat.
- **Task handoffs.** A task's expanded details show the summary, numbered
  findings with severity and evidence, artifacts and a count of findings left
  in the log.
  Dependents can pull the full handoff, and a loop's check gets its fix's
  handoff and its own previous findings. Research run updates carry summaries
  and whole findings; long reports stay in attempt logs.
- **A read-only task's saved patch.** A task that tried a change can keep it as
  a patch. Its task card and its log show how many files and lines the patch
  changes, where it is saved and what it left out, with an Open patch button
  that opens the file in an editor tab. Saving requires an isolated worktree in
  a single repository and a working sandbox. A dependent change task can apply
  it with `apply_patch`, resolve any conflicts and validate it at its own base.
- **Script tasks.** A plan can hold a task with no runner and no model, a list
  of commands or one script that Ordewell runs at the workspace root; its exit
  status is its verdict. The plan shows its body, read-only, in place of a
  prompt.
- **The planner can carry out a small effect in your turn** with
  `run_script`: a push, a tag or one cloud setting, as a script task. In a
  user turn, its approval card shows exactly what will run, unless the effect
  allowlist covers it or Full with autorun permits it on an approved plan.
  A supervisor at Act may run it without asking; Watch can only suggest it.
- **`ordewell.effectAllowlist` names script tasks that run without asking.**
  A rule matches the whole command, flags included, and a task runs unasked
  only when every command is covered. It has no built-in rules.
- **Check-and-fix loops.** A task can be a loop's check: while it fails with
  rounds left, the tasks of its body fix what it found and the check runs
  again, with no planner turn in between. The plan shows each loop's rounds.
- **Research tasks.** When the planner must decide something on what a
  read-only task finds, it marks that task as research, and its report wakes it
  with the result, at every supervisor level. Research tasks run within the
  run's Parallel limit like any other task.
- **The planner chooses a strategy before it outlines a plan**, from answering
  a question with no plan to exploring an open problem one round at a time,
  and each of its turns tells it how full its context is and what remains of
  its budgets.
- **Planner skills `diagnose` and `explore`**, for a failure to explain and an
  open problem. Type `/diagnose` or `/explore`, or let the planner load one.
- **Sealed runs.** Where the planner's sandbox runs, a command its rules would
  refuse without asking can run sealed instead: the workspace read-only, no network,
  no home directory and none of your credentials.
- **`ordewell.plannerNativeShell` lets a Claude Code or OpenCode 2.x planner on
  macOS use its own shell**, off by default and on checked versions only, with
  every command run in Ordewell's sealed profile with the network. A
  workspace cannot set it.
- **A daily version check.** Once a day Ordewell asks ordewell.ai whether a
  newer version is out and shows one line when it is. The request carries the
  version you run and a random install ID, shared with the CLI through
  `~/.ordewell/version-check.json` and replaced every 30 days; nothing else is
  sent, though ordewell.ai sees the IP address of any request, which the notice
  says too. The first start shows a notice and sends nothing. Turn it off with
  VS Code's telemetry setting
  (`telemetry.telemetryLevel`), `ORDEWELL_NO_VERSION_CHECK=1` or
  `DO_NOT_TRACK=1`: off, no notice, no ID and no request.
- **Real commit messages.** A change task can state a commit message, and the
  commits Ordewell writes to land it use it instead of git's default merge
  message. Handoffs show the commit.
- **A `Planned-with: Ordewell` trailer** ends the commits Ordewell writes. Turn
  it off with `ordewell trailer off` (it is not in the settings panel).
- **Installed coding agents that are switched off now show in the Runners
  block.** Clicking one saves it in the shared enabled-runner list, so the
  planner can use it on the next turn, including in an existing conversation.

### Changed

- **Run settings belong to this window's open session.** The Run block shows
  and changes its supervisor level, auto-merge at gates, autorun and retry
  limit. Changes apply to its active run and are saved in
  `~/.ordewell/settings.json` as defaults for new or reopened sessions. Other
  open sessions keep their values, including for their next run. Headless
  settings commands and file edits set defaults for sessions opened afterwards;
  use `ordewell supervisor reads <n>` or the file for the wake-up read budget.
  Autonomy and Parallel tasks apply across sessions; the Planned-with setting
  is read at each commit.
- **Settings makes its open state clearer.** The collapsed header is simpler,
  and the first screen and sign-in controls follow light themes.
- **New installations start in Guarded autonomy.** A settings file with no
  level used to mean Full; tasks now run in their runner's safe mode and
  a planner request the allowlist does not cover asks you. A level you saved
  is kept.
- **The planner's `submit_plan` and `edit_plan` apply as the call answers.**
  The plan shows the change while the planner is still replying, a change
  stays if the reply is stopped or fails, and the "Proposed: lands when this
  reply ends" preview is gone.
- **A queued task can be edited while others run.** A task that has not
  started keeps its runner, model, effort, mode, prompt, dependency, skill and
  ops editors during a run.
- **Marking a task complete or not done is deliberate.** It is refused while a
  run could still advance the task, and asks you to confirm once it is
  stopped. A task's status circle only shows its status; the mark is at the
  bottom of its details.
- **Open log is now Open chat**, and a task offers it only once an attempt has
  started.
- **Execute Plan shows Starting… at once** and becomes Stop when a task
  starts.
- **The planner's activity stays visible for the whole turn**, including
  while it streams its thinking.
- **Supervisor reads is no longer in the Run block.** Set it with
  `ordewell supervisor reads <n>` or in `settings.json`; a saved value is
  kept.
- **The chat and task logs fold what an agent did.** Each run of thinking,
  calls, subagents and setup notices between two messages is one line that
  says what it did, such as "Ran 4 commands, fetched 2 pages (2 failed)", and
  opens to its rows. Each row, each step of a subagent and each long report
  opens on its own. A line with something failed or denied in it is coloured
  as a failure, and a call that never ran is never counted as run. Requests
  waiting for an answer, errors and every message stay in view, and a script
  task's log folds nothing: each command shows its whole output and exit. The
  Expand all and Collapse all buttons are gone.
- **Merge and Split are planner requests, not task-card buttons.** Ask the
  planner in chat to merge or split tasks; the task cards no longer carry the
  controls, their selection banner or their inline error.
- **A read-only task is the same on every runner.** It reads with its runner's
  own tools, runs commands sealed with its worktree writable, so a review can
  run the tests, and lands nothing: its report is its result.
- **A runner that cannot connect to Ordewell's tools holds its task** instead
  of failing it, and every hold shows its reason on the task's status badge.
- **The planner chooses between its own agents and a research task by what the
  result is, not by how long it will take.** A conclusion it needs this turn
  stays in the turn; evidence that needs a worktree, another runner's judgement
  or your eye, or that a later task acts on, is a task of its own, marked as
  research only when the planner must decide something on its report, and a
  search that takes rounds is the `explore` skill.
- **The planner is sent its plan whole once, then only what changed.** The
  whole plan goes again after a reorder, a reset or compaction, or a turn that
  did not land.
- **Opening a session another Ordewell host is running is refused.** The
  message names the window or process that holds it. Before, a second window
  loaded the session as well, and the two removed each other's task worktrees
  and overwrote its file
  ([ADR-0049](../../docs/adr/isolation/0049-a-session-has-one-live-host.md)).
- **A plan marker and a handoff preview use the terminal's words.** The marker
  reads `Plan generated · 3 tasks`, and the preview names the findings count,
  severity, commit and the first line of the summary.
- **The inert `ordewell.researchEnabled` setting is gone.** It never changed
  what the planner did.

### Fixed

- **A coding-agent planner keeps Ordewell's tools across turns.** A lost
  connection is checked before the next turn and recovered by restarting once
  and resuming the conversation. If the tools still cannot attach, the turn
  fails visibly without being sent.
- **Copying selected chat text works in VS Code 1.143.** Mouse selections in
  the planner conversation and `Planner ctx` footer keep focus for Cmd+C,
  Ctrl+C and context-menu Copy after the composer has been used.
- **A supervisor's Merge all after a run that merged itself no longer shows a
  refusal**; the run update says the work is already merged.
- **A Runners pill click is saved.** Switching a runner off or on in the chat
  header now saves it in the enabled runners every surface shares, so the
  planner stops offering it on the next turn of a conversation already under
  way, and on supervisor wake-ups too. The pills show that saved list after a
  reload, and the last runner on cannot be switched off from them.
- **A task log's header follows the attempt on screen.** Its usage is that
  attempt's, with the task total beneath it, its `/` commands come from that
  attempt, and a runner that has gone quiet reads Stalled after the next status
  update.
- **A task log tab reopens after a window reload.** The tab finds its task
  again, and a tab whose task left the plan closes instead of staying empty.
- **A subtask's log tab is named by its dotted reference** (`Task 2.1 · …`),
  and its card carries the same Waits for Merge all, Conflict and Repairing
  badges as its parent's.
- **An early Stop releases the chat.** Stopping before the planner turn opened
  no longer leaves the webview drawing the turn as working.
- **A turn waiting on your approval card is no longer called a hang** by the
  chat's watchdog.
- **Approving a plan no longer marks a manual task approved before the run
  reaches it**, and a task whose approval the planner withdraws is announced
  instead of changing silently.
- **Merge all's guidance in the handoff card is the terminal's next step**,
  including for a lone repository whose merge conflicted: your tree is as it
  was, and you merge the branch yourself with git.
- **A script task's or a manual task's log tab no longer names a runner** it does
  not have.

## [0.10.12] - 2026-10-22

### Fixed

- **A task's completion report survives a forced message that is taken back or
  never read.** A forced message that is read, or that opens the next turn,
  still replaces the report as before.

## [0.10.11] - 2026-10-22

### Changed

- **Run settings and planner steps live in one place each.** `/settings` covers
  autonomy, supervisor, merging, autorun and parallel tasks; `/planner` covers
  harness, model and effort. The one-value slash commands and the "Set Parallel
  Tasks" palette command are gone.
- **The Marketplace listing is rewritten.** Its description and overview lead
  with planning once and running across Claude Code, Codex and OpenCode, say
  that nothing runs until you approve the plan, and make an installed coding
  agent the default way to plan, with API keys as a secondary note.

### Security

- **The planner's shell runs in an OS sandbox on macOS and Linux**: it can
  write only to a scratch folder, and a command run without asking has no
  network.
- **A read-only task can no longer write outside the sandbox**: its runner's
  own edit, write, shell and web tools are withheld.
- **Once a read-only task has run a command sealed, all its later commands run
  sealed too**, allowlisted ones included, so none can run a script a sealed
  run rewrote with the network and your files in reach.
- **A read-only task's sealed runs cannot plant a git repository**: the
  worktree root itself and its `.git` are held still — on macOS Seatbelt denies
  renaming or removing the root and any write to the `.git`, and on Linux the
  worktree mount refuses a rename while the `.git` is bound read-only — and
  every `.git` entry the checkout brought is held the same way and checked
  after each run. In a repo group each worktree is writable, while the group's
  task workspace root is not persistently writable: a write is refused where
  it is bound read-only, and under bubblewrap's throwaway overlay one may
  succeed only into the layer discarded with the run. On macOS they cannot
  create a `.git` anywhere they may write. A `.git` that was not there before
  the task's first sealed run is removed after every run; one that cannot be
  removed, or one that changed, stops that task's shell. So git run later there
  loads no repository the run planted or armed with hooks or filters of its
  own, and `task_diff` refuses a read-only task.
- **An edit to an approved script task's body needs your consent again.**
### Fixed

- **A completed task's `task_complete` call shows as a success, not a
  rejection.** The tool reply now reaches the runner before Ordewell stops it.

## [0.10.10] - 2026-10-19

### Added

- **One usage line everywhere: context and cost only**, such as
  `ctx 61k (6%) · ≈$7.89`. On a subscription the cost reads `API-equivalent`,
  and an estimate a runner makes itself is marked as one. The Tasks total
  names runners that report no cost.
- **Claude Code task attempts record the cost and context window their runner
  reports**, so they count in the Tasks total.
- **The context meter shows the main model's real context from its first
  call.**

### Changed

- **A task's runner is stopped as soon as it reports completion**; its closing
  message is cut short, and what it reports while it stops is still counted.
- **Compaction's size line uses the same token wording as the usage line.**

### Fixed

- **Claude Code's counted cost stays right after a crash result and after
  `/clear`.**
- **Each cost is counted once**, including the cost of the planner's own
  `/compact` summary turn.
- **The Tasks total no longer says a runner reports no cost while its first
  attempt is still running.**

## [0.10.9] - 2026-10-19

### Fixed

- **Reloading the window keeps working under the same session.** A reload used
  to start a second session file, which later reopened with completed tasks
  shown as not done. Sessions forked by earlier reloads stay as separate
  entries in session history, the newest file holding the run's latest state.
- **A loaded session no longer offers Merge all for work already merged.**
  Loading a saved session re-checks git: Merge all lists only what is still
  unmerged, and a finished run whose work is all merged is cleaned up.
- **A coding-agent planner whose process ended between turns is restarted on
  your next message** instead of answering "The claude-code planner exited with
  code 143."
- **The chat's stop button stops only the planner.** With an empty composer it
  appears while the planner is working; while tasks run and the planner is
  idle it is the inert send arrow, and **Stop run** halts the tasks.
- **Reloading after a crash mid-run no longer reverts finished tasks.** A
  restore snapshot older than the saved session no longer overwrites it.

### Changed

- **The Open log button on a task header spans the title and assignment
  lines** and is never overlapped by them in a narrow panel.
- **A running task's check ring shows a sweeping progress arc** instead of a
  faint glow. With reduced motion it is a still ring with a dot.

## [0.10.8] - 2026-10-18

### Fixed

- **The VS Code extension now ships its changelog**, including release notes
  for the saved-session loading fix.

## [0.10.7] - 2026-10-18

### Fixed

- **Loading a saved session stays idle until you ask it to continue.** Opening
  session history or reloading VS Code no longer replays unanswered planner
  messages, wakes the supervisor or restarts tasks at a saved usage-limit
  reset. Unanswered messages are preserved for your next message, and paused
  tasks wait for an explicit resume, even with autorun enabled.

## [0.10.6] - 2026-10-18

### Changed

- **Task cards give the title the full row.** The runner, model and effort sit
  under it with **Open log** beside them, and the row below the card starts
  where the title does: dependencies, the status, then Merge and Split.
- **A task's status is one badge after its dependencies.** A long skip or block
  reason is cut to that row; click it to read the whole of it.
- **A failed task's ring is red and a skipped one is dotted**, instead of the
  empty ring of a task still to do.
- **The collapsed Run settings show their summary on the Run line.**
- **Every task control is sent through the same checked path as the terminal
  UI's**, so each is kept in the timeline with who pressed it: Resume now,
  Don't Resume, Mark complete and Mark not done, Force start (card and command
  palette), Interrupt, queued messages, checkpoint answers and a request's
  Allow or Deny. A refused control shows its reason, and the chat no longer
  writes its own "cancelled" or "Execution stopped." beside the timeline's
  line.
- **A task moved to another runner gets a model that runner can run**, and its
  thinking effort moves to the nearest level the new model offers. An edit or a
  new task naming a runner that does not exist is refused, as is an edit that
  would put an ops task on its runner's read-only mode.
- **A usage-limit pause keeps the run open**, and a Retry in a finished plan
  no longer shows the plan as completed. A paused task you edit into a manual
  one stops waiting at the reset.
- **Changing a setting while the planner is answering no longer loses the
  turn**, and Stop keeps the planner's live context.
- **Dependencies work across the whole plan, subtasks included**, and the
  dependency picker keeps the choices outside its list. Removing a parent
  detaches dependencies on its descendants and releases their runners.
- **Whether a task can start is one rule, the same one the terminal UI uses.**
  A task with no prompt cannot be started, a force start waits for a dependency
  an edit added meanwhile and for the planner's turn to end, marking a task
  complete while it starts no longer starts it again, a failed ops task asks at
  its merge gate before it starts, and a hand-added task that breaks the plan's
  rules is refused.
- **Run marks and cards are dropped only for the run they belong to.** A
  refused Run task, Force start or Execute keeps the previous handoff and
  marks, while the command palette's Force start clears them as the plan
  pane's does.

### Fixed

- **The planner's words stay between the tool calls where it said them**, live
  and after a window reload.
- **A streamed task message no longer appears twice**, and opening a task log
  or switching attempts during a run keeps live text, tool rows, approval
  cards and turn endings.
- **Force-sending a message no longer overtakes one the runner already
  holds**, consecutive Claude Code turns stay separate, and a failed OpenCode
  permission answer keeps its card open and can be answered again.
- **A plan saved with an old blocked status loads as pending.**
- **Completed tasks stop showing Working, Interrupt and Send now.**
- **A planner turn that fails, hits its usage limit or is abandoned leaves
  nothing behind**, including the skills it loaded and its research, and
  Execute during a reply no longer rolls back the planner's token totals.

## [0.10.5] — 2026-10-17

### Added

- **A `/model` you send in a task's chat is written to the plan**, so the card
  and every later Retry or Continue use the model you picked in the runner.
- **A planner that hits its usage limit resends at the reset.** **Don't
  resend** keeps it from going on its own.
- **The planner is told when you change runners or models**, and a task the
  change leaves outside is flagged on its card ("codex is switched off").
- **Approve all.** A waiting task's card has an **Approve** button, and
  **Approve all** appears when tasks wait for your approval.
- **A task's usage and assignment stay visible while it runs:** a usage line in
  the task log, and the runner, model and mode on the card.

### Changed

- **A task's usage is its whole spend**, summed over every attempt and model.
  The context meter reads the latest model's window, and cost shows only when
  the runner reported it.
- **Continue stays on the runner that made the session**, and a Retry after
  moving a task to another runner carries its files over.
- **Merge all lands only on the branch the run started on**, and the Merge
  confirmation names it (`main @ a1b2c3d`).
- **The enabled runners are one list shared with the terminal UI**, saved in
  Ordewell's settings file. A list in the old `ordewell.enabledRunners` setting
  is copied there once and cleared.
- **A usage limit counts only when it ended a turn Ordewell started**, and a
  provider's throttle is no longer taken for an account limit.

### Fixed

- **A force start never starts a task ahead of a dependency still under way.**
- **VS Code and the terminal saving settings at the same moment no longer lose
  one save.**
- **A running task can no longer be moved to another runner or have its model
  cleared.** Stop it first.
- **The context meter keeps a model's reported window** when a task switches
  away and back, and across a Continue.

## [0.10.4] — 2026-10-17

### Fixed

- **Switching planner no longer looks frozen behind a slow coding-agent CLI.**
  The picked planner lights at once.
- **A coding agent installed while VS Code is open is noticed on the next
  refresh**, in the runner panel and as the no-key default planner, without a
  window reload.
- **OpenCode v2 model variants are discovered again.**

## [0.10.3] — 2026-10-16

### Changed

- **First-start API-key setup offers every supported provider** through a
  single **Add API key** button.
- **Task cards show the runner, model and thinking effort beneath the title**,
  during execution too.
- **The empty chat says nothing runs until you approve the plan**, or warns
  that a plan starts at once when autorun is on.

### Fixed

- **A first run with no API key plans with an installed coding agent** (Claude
  Code, Codex or OpenCode) instead of failing on a missing OpenRouter key, and
  says it is detecting coding agents until it knows.
- **A planner that cannot plan points to `/planner`**, not to an OpenRouter key.
- **Plan approval and Guarded starts are more dependable.** The planner can
  start a plan again after a run that failed, was stopped or was reloaded,
  Guarded asks on the approval card, and proposed plan changes show while the
  planner is still replying.
- **Tasks added while a plan runs wait for your approval, and Stop also cancels
  queued starts and messages.** Approval cards survive a reload.
- **An ops or user task waits until all the work it builds on is merged into
  your branch.**

## [0.10.2] — 2026-10-14

### Added

- **Markdown renders in chat.** Tables, lists, code blocks and quotes display
  properly; wide tables scroll sideways. Raw HTML is off, only `http(s)` links
  are links, images show as text, and a single newline is a line break.
- **Settings panel.** The toggle stays pinned while the body scrolls, and the
  Run section is a dropdown, collapsed by default with a one-line summary;
  `/settings` expands it.
- **A paused task moved to another runner keeps its uncommitted work** instead
  of starting from scratch (#94).

### Changed

- **`ordewell.aiProvider` is validated at runtime.** An unknown value shows a
  warning listing the valid choices, and the planner is detected from your API
  keys instead.

### Fixed

- **Esc closes an expanded task first**, before it reaches the planner turn or
  clears what you typed.

## [0.10.1] — 2026-10-14

No extension changes; released alongside the CLI's fixes.

## [0.10.0] — 2026-10-14

### Security

- **The planner cannot change your run settings.** `/supervisor`, `/automerge`,
  `/autorun` and `/auto` are yours alone; a supervisor can deny a runner's
  approval but never allow one.
- **A repository cannot poison Ordewell's TOML reader**, and a project MCP
  server named to look like Ordewell's own (`ordewell_x`) no longer has its
  tools pre-approved: Ordewell recognises its own tools by exact name.

### Added

- **Native runner commands in task chats.** Task cards and log tabs complete the runner’s commands and skills, and task logs show command results, compaction events and loaded commands, skills and MCP servers.
- **A supervisor.** The planner keeps watching your run and writes you notes,
  labelled "Supervisor" in the chat. Off, **Watch** (default) or **Act**, set
  with `/supervisor [off|watch|act]`. At Act it may run, stop, retry and skip
  tasks (a skip needs a reason, and never marks work complete), edit the plan
  and merge without asking; guards stop it from looping, and
  `/supervisor retries <n>` and `/supervisor reads <n>` set its limits.
- **Run settings in chat.** `/supervisor`, `/automerge [on|off]` and
  `/autorun [on|off]` report the value bare and set it with an argument, and
  the Settings panel's Run block sets each by a click or a typed number, saved
  at once. They are saved on your machine, not on the plan, and apply at once
  to the chat you change them in. The empty chat's Setup block has
  **Autonomy** and **Run** rows, and the plan bar shows the values.
  `/supervisor act` and `/autorun on` ask you to confirm.
- **Autorun.** `/autorun on` starts each plan the planner submits, as if you
  had pressed Execute.
- **Merge all at any time during a run.** A Merge all button and an "unmerged"
  count appear whenever landed work is not in your branch yet.
- **`/automerge on`** also merges at the end of a run. The handoff card says
  the supervisor may merge it when one is on its way, and keeps its buttons.
- **Read-only tasks.** A review or audit that must not change files runs in its
  runner's read-only mode. An ops task is never read-only: it runs the
  commands it exists for.
- **Usage across tasks.** Each task attempt's usage is recorded, and the plan
  card shows a *Tasks total* of tokens, cost and time; hover for the
  per-model breakdown.
- **A task paused on a usage limit resumes on its own.** The card reads
  "Resumes at 8:10pm" with a **Don't resume** button. A task moved to another
  runner leaves the wait and is ready on the new one.
- **Resume now.** When a usage limit resets early, **Resume now** on a paused
  task's card or in its log resumes it in its saved session, along with every
  other task waiting on that runner's reset. A message typed into its box
  resumes it too, and Skip is offered while it is paused, even with the run
  held on the limit.
- **Send now in the planner chat and on pending messages.** There is one Send
  button. While a turn runs, Enter queues your message and `Ctrl+Enter`
  (`Cmd+Enter` on macOS) stops the turn in flight and answers it in the turn
  that replaces it, ahead of anything queued; a hint under the input names
  both keys, and the run's tasks carry on. A skill invocation (`/name …`) sent
  this way goes to the planner as a prompt, while a built-in command still
  runs as Send does, and a supervisor wake-up it stops keeps its run update
  for the next turn. Pending messages sit above the input in the planner chat,
  a task's log and a running or waiting task's card, each marked *queued*,
  *waiting for the current step* or *sending now…* with its own *Send now*,
  and a message sent this way keeps its sent-now mark when the log is
  reopened. A message the runner already has can be sent now as well: Claude
  Code runs it as the next turn after the interrupt, while Codex and OpenCode
  1.x take it back and send it again first.

### Changed

- **Skip no longer lands a task's work.** It used to mark the task complete. A
  skipped task now ends as **Skipped**, with no verdict and nothing of its work
  landed; its worktree is kept, and you can retry it or Mark Complete it later.
  Its dependents go ahead without it, told it was skipped and why. The card
  shows a "Skipped" badge, never Done. Skip is offered on a failed, blocked or
  waiting task. **Mark Complete is unchanged**: it vouches for the work and
  lands it.
- **A failed task blocks only its dependents.** Independent work keeps running;
  a card a failure holds back reads "Blocked by #N", and a retry or a skip of
  the failed task lets it start.
- **Codex's read-only and Guarded modes are unavailable where its sandbox
  cannot start**, shown with the reason and never assigned. Full access stays
  available. See the repository's `docs/troubleshooting.md` for the fix.
- **A task's report is its full `task_complete` summary**, shown ahead of any
  log tail and handed whole (up to a cut) to dependent tasks.
- **A runner is reminded once when its turn ends without `task_complete`.** The
  reminder appears in the task view as an "Ordewell: …" line, not as your
  message.
- **Runners' own memory is off in Ordewell runs**: Claude Code's auto-memory
  and Codex's memories no longer load into planners or tasks.
- **Guarded planners read the web without asking**, as Full does, behind the
  same guards. Set `ordewell.plannerApprovals` to `ask` to approve each new
  site and search provider.
- **A message sent during a run is answered at once** instead of waiting for
  the current batch of tasks.
- **The planner no longer names a mode**; it marks a task read-only or not, and
  a task it adds or moves gets its runner's mode for your Full/Guarded level.
- **The built-in `tdd` task skill** is attached by the planner on its own.
- **The run is drawn from one core view.** A chat that joins a run already going
  receives its current state at once instead of waiting for the next change,
  and a task card reads the same as the terminal UI's row.
- **Planner selection is decided in core.** Reselecting the planner already in
  use changes nothing; choosing a model keeps the current effort only where
  that model offers it and drops one it does not; clearing the model clears its
  effort.
- **A subtask is named by its dotted reference** (`#2.1`) everywhere: a
  dependency on a task card, a handoff's landed list, the heading its report
  gets in a dependent task's prompt (where subtask 1.1 read as "Task 1"), and
  the prompts the planner is given, never by a bare order.
- **`/planner` is one stepped flow**, Harness › Model › Effort, saved once at
  the end; cancelling applies nothing.
- **Task cards are slimmer**: model and mode show when a card is expanded.
- **Task cards stand out in light themes.** A card has its own fill, a step
  toward the theme's text colour, instead of the plan's near-white, and hover
  and the open card go a step further; dark themes look as before and
  high-contrast themes keep plain outlines. Light themes also get darker
  orange, purple and cyan and the theme's link colour as the accent, so badges,
  task numbers and secondary text on a card reach AA contrast.

### Removed

- **`ordewell.autonomousMode`.** Your value is copied once; use `/auto full` or
  `/auto guarded`.
- **The list of queued edits above the input**: a message sent during a run is
  a planner turn now.

### Fixed

- **A setup command that doesn't fit a repository no longer stops every task.**
  When `ordewell.worktreeSetupCommand` fails in a repository, its task
  worktrees get the default links instead, with one warning per run naming the
  repository and the error.
- **Running, stopping or a plan update during a planner turn no longer makes
  the chat think the planner has finished.** The working indicator,
  Esc-to-stop, queueing a message and Send now keep working until the turn
  ends, and a chat panel reloaded mid-turn shows the planner as working.
- A planner reads a file's line range with `sed -n '10,40p'` without asking,
  as it does with `head` and `tail`, and a denied command says how to rewrite it.
- Codex works as the planner on machines where its sandbox cannot start,
  such as stock Ubuntu 24.04, instead of stopping with an error.
- A planner reads back the long tool output its runner saved outside the
  workspace, without asking.
- A usage limit shows once in the planner chat and in a task's log (#79; thanks
  [@mayuriphad](https://github.com/mayuriphad), #96).
- **Show full / Show less** reads a checkpoint's summary in full.
- A resumed task keeps the paused attempt's uncommitted work in an isolated
  run.
- A coding-agent planner's reply stays beside the plan it submits.
- A message is no longer shown twice after a reload.
- A task's runner is never swapped for another: a plan or edit naming a runner
  the plan may not use is refused, and the model allowlist now checks subtasks
  too.
- A subtask can be edited on its own, by its dotted label or its title, instead
  of failing with "Task not found".
- A plan replaced mid-turn keeps the old turn's saved research out of the new
  plan and stops the old plan's run with it.
- Executing a plan whose tasks are all done announces the end once, not twice.
- An Ordewell-tool approval is logged as decided on Codex too, and Claude Code
  and Codex cancel a permission request still open when the turn ends.
- A runner's final line is not lost when its pipe closes without a trailing
  newline, and a process that dies mid-turn reports its stderr instead of
  hanging.
- Stopping a run goes before its runners are killed, and a second Mark complete
  no longer lands the task again.
- **A webview message that fails says so**: the error is logged and shown
  instead of being dropped as an unhandled rejection.
- **Stopping a task while a repair reads its evidence no longer lands the
  repair's work anyway**; the conflict stays as it was and waits on you.
- **A runner whose process exited but whose output pipe is still held open no
  longer hangs its turn**; the turn ends a short grace after `exit`, and output
  written before it is still delivered.
- **Stopping a task no longer signals a process-group id the system has
  recycled** to another process.
- **An OpenCode event-stream error now fails the turn** instead of leaving it
  waiting on a permission request nobody would see.
- **A read-only Claude task runs the model its plan names**, not Sonnet, which
  the `claude` CLI ran for the `haiku` alias in plan mode.
- **A planner sees nested files without `tree` installed**, instead of planning
  from a one-level listing.
- **A continue whose saved Claude session is gone fails in Claude's own words**
  instead of being respawned as an MCP attach failure.
- **A planner turn stopped before replying is shown as stopped**,
  not as an empty response.
- **A finished task's log never shows a call as still running.**
- **A task waiting at a checkpoint shows so at once**, with the controls to
  answer it.
- **A planner under worktree isolation names files from the workspace root**,
  so a task reads its own worktree rather than your checkout.
- **A failure reported without a reason shows the runner's own explanation**
  instead of "no reason given".
- **An approved checkpoint reads as approved to the runner**, not as a bare
  "continue" it could take as no answer.
- **A one-shot planner's backgrounded subagents are waited for** before its
  plan is given up on.

## [0.9.1] — 2026-10-11

### Security

- **Planners no longer run a repository's config**: no project hooks, `env`,
  helper commands, plugins or language servers. The project's `CLAUDE.md` and
  `AGENTS.md` still reach the planner, as text.
- **Project MCP servers start only once you approve them**, remembered per
  repository and definition. In Full they start only if the planner allowlist
  names them.
- **Web reads are guarded without a person**: private addresses are refused,
  redirects to another site are decided again, nothing is attached, and a URL
  or query that looks like it carries a secret is refused.
- **`curl` and `wget` in the planner's shell are approved per site**, never
  write files, and stay refused in Full. A refused effect points the planner
  to an ops task.

### Added

- **Web search and fetch for every planner.** Guarded asks once per site for a
  fetch and once per session for a search; Full under `auto` reads without
  asking.
- **`ordewell.plannerWebReadBudget`** caps the web reads in one planner turn;
  0 turns them off. `!web_search:*`, `!https://*` and `!http://*` in
  `ordewell.plannerAllowlist` turn them off too.

### Changed

- The Stalled badge appears after 5 minutes without output, not one.

### Fixed

- Ordewell's own web search works with DuckDuckGo's real results page.
- The model panel names the planner's actual provider instead of "via
  OpenRouter".
- The skill picker reads "Add skill…".

## [0.9.0] — 2026-10-10

### Security

- **One research envelope for every planner.** Claude Code, Codex and OpenCode
  planners research under the same rules as the API planner; file writes are
  refused in every mode.
- **The planner's approval settings are user settings only**, so a
  repository's `.vscode/settings.json` cannot widen them.

### Added

- **Harness planners run commands and use your MCP tools**, approved like the
  API planner's research.
- **Planner allowlist** (`ordewell.plannerAllowlist`), with a built-in list of
  read-only commands and MCP tools (`ordewell.plannerAllowlistDefaults`).
- **`ordewell.plannerApprovals`**: `auto` (default) asks you in Guarded and
  runs only the allowlist in Full; or `ask`, `allowlist`, `allow`.

### Fixed

- Planners and tasks start again on OpenCode 2, and tasks find
  `task_complete` there.

## [0.8.1] — 2026-10-10

### Changed

- Up to five AI tasks now run at once by default, up from three
  (`ordewell.maxParallelSessions`).
- The extension's README is refreshed for 0.8: skills, reported completion,
  and Open VSX for Cursor, Windsurf and VSCodium.

## [0.8.0] — 2026-10-10

### Security

- **A Claude Code planner can no longer write through its native plan file.**
  It now researches with `Read`, `Grep` and `Glob` only; shell tools and
  Claude Code's plan-mode transitions are withheld.
- **A runner never inherits another Ordewell's MCP credential** when Ordewell
  runs inside another Ordewell's task.

### Added

- **Skills, unified.** Planner skills and task skills are one `SKILL.md`
  format, in `~/.ordewell/skills/` or a workspace's committed
  `.ordewell/skills/`. The planner can attach a skill to a task or subtask, and
  its text goes into that task's prompt on every runner.
- **Skill chips on task and subtask cards.** Add or remove a task's skills
  from the card; they lock while the plan executes, like its model and mode.
- **`/tdd` is a skill.** It asks the planner to attach `tdd` to the tasks it
  fits, instead of applying TDD to every task.

### Changed

- **`/name` keeps your text.** The message is sent as typed, with the skill's
  instructions beside it, and the chat shows which skill was loaded.
- **Tools or nothing.** A task or coding-agent planner whose Ordewell tools
  cannot connect is respawned once, then fails before its prompt is sent.
- **A coding-agent planner plans through tools only**; plan JSON in its reply
  is not taken as a plan.

### Removed

- The terminal transport, its tmux requirement, the Structured toggle and the
  Structured/Terminal badges. Every runner is driven through its own protocol.
- The `verify` and `tdd` toggles. Use `/tdd` or attach the skill to a task.
- Plugin runners.

## [0.7.2] — 2026-10-07

### Security

- **Planner research refuses more command-policy bypasses.** A `!`-prefixed
  command, more than 32 substitutions on a line, an interpreter fed through
  stdin, combined or glued inline-code flags and versioned interpreter names,
  quoting or escaping that hid a command inside `$( )`, `${…}` or `$'…'`, a
  `<<` inside a comment or expansion that hid the lines after it, re-cased
  command names, `NAME+=` prefixes and several Windows `cmd` forms used to ask
  for approval or run, and are now refused. In the cmd dialect, a program path
  written with forward slashes is refused too; use backslashes.

### Changed

- **Stopping a planner turn is not reported as an error.** Whatever the
  planner's backend names the error it throws on the way out, a stop stays
  quiet; a real failure whose message mentions "aborted" is still shown.
- **A runner starts in its own process group without a controlling terminal.**
  A prompt that reads `/dev/tty` fails instead of waiting on the host terminal.

### Fixed

- **Stop ends everything a task started.** On Linux and macOS, closing or
  stopping a task used to signal only the runner's own process, so the shells,
  MCP servers, test runs and dev servers it had started kept running. The whole
  process group is now signalled. An interactive (pty-wrapped) task is the
  exception: its agent runs in a session of its own under `script`, so Stop
  relies on the pty hangup to end the agent and its foreground children, and a
  process the agent deliberately detached can outlive Stop.
- **A runner that fails to start no longer stays running**, and non-ASCII
  output split across two reads no longer turns into `�`.
- **Task badges no longer outlive their session.** Restoring a session kept
  the previous plan's stalled and approval badges, which are keyed by task id.
- **A closed chat view is no longer posted to**, and the `/help` text clears
  on its own timer without a stale one wiping a later message.
- **A failed reschedule or model refresh after a settings change is logged**
  instead of surfacing as an unhandled rejection.
- **A plan replaced mid-turn is not written to by the old turn**, and a task
  the scheduler should not start (after Stop, no longer ready, or past the
  parallel limit) is not started.
- **Changes are saved before they are shown**, and a queued plan edit is
  applied once, to the plan it was queued for; a queued message you removed
  stays removed.
- **A git command stuck on a hook is stopped after ten minutes**, and a task
  whose verdict could not be settled fails with the reason instead of staying
  stuck integrating.

## [0.7.1] — 2026-10-06

### Added

- **A message reaches a running task between tool calls.** A message typed in
  a task log while a Claude Code, Codex or OpenCode 1.x task works is read by
  the model after the command or edit in flight, inside the same turn,
  instead of when the turn ends. A message the runner already has is marked
  handed over and can no longer be removed. OpenCode 2.x keeps the old
  behaviour.
- **Send now.** A button beside Send, and on each queued message, interrupts
  the running step and delivers the message straight away (`Ctrl+Enter` in
  the message box). On Codex it stops the agent waiting on a command, not the
  command itself.

### Fixed

- **A message sent to a task is never lost.** One still queued when the task
  reported done used to vanish; the verdict now waits for it. A message that
  can no longer reach the runner is shown as undelivered.
- **Merge all never deletes a live task's worktree.** A run with a task still
  live is left alone, and work that never landed is kept on an
  `ordewell-preserved/…` branch before a worktree is removed.

## [0.7.0] — 2026-10-05

## [0.6.4] — 2026-10-04

### Security

- **Approving one `cd` no longer approves every later one** during planner
  research. Once `cd "$HOME"` was approved, `cd "$HOME" && cat .ssh/id_rsa`
  ran without a prompt. Such a command is now approved for that exact line only.
- **`builtin eval`, `builtin source` and `enable -f` are refused** during
  planner research, like `eval` and `source`. They used to only ask.

## [0.6.3] — 2026-10-04

### Security

- **Planner research no longer reads outside the workspace through a `cd`
  chain.** A command such as `cd nonexist || X=1 && cat ../secret` read
  outside the workspace with no prompt in 0.6.2. It now asks.

### Fixed

- **OpenCode 2.x runs on the terminal transport**, with the plan's agent,
  model and variant.
- **The terminal transport works on macOS without tmux**: OpenCode tasks no
  longer fail at once on macOS's `script`, and Codex tasks no longer hang.

## [0.6.2] — 2026-10-04

### Fixed

- **A `cd` into a repo inside the workspace no longer prompts** during planner
  research, including a chain of them joined by `&&`.
- **Planner search works on a Mac without ripgrep.** The `grep` fallback no
  longer fails on macOS's `grep`, which has no `-P`.
- **OpenCode 2.x works as a planner and a structured-transport runner.** It
  replaced its server API, which made planning with it fail at once. The
  terminal transport is not covered yet.

## [0.6.1] — 2026-10-02

### Added

- **Ops tasks.** A task that changes no repository files — a deploy, a cloud
  CLI call, a push — can be an ops task: it runs in your checkout instead of a
  worktree. Its card says Ops, and a pending AI task's card can flip it.
- **Merge all during a run.** A task waiting for work to be merged into your
  branch says "Waits for Merge all", and the handoff card offers Merge all
  mid-run: the run goes on, and the waiting tasks start once it has merged.
  Starting a waiting task anyway asks first.

## [0.6.0] — 2026-10-02

### Changed

- **The structured transport is now the default.** Tasks are driven through
  their runner's own protocol — Claude Code, Codex and OpenCode alike — instead
  of a terminal screen and keyboard. Switch off the Structured toggle to go back
  to the terminal transport; a choice you already stored is kept, and it applies
  from the next run. tmux is needed only by the terminal transport.
- **The task log's message box works like the planner's.** Enter sends and
  Shift+Enter starts a new line; one button sends what is typed, stops the live
  turn when nothing is, and greys out when there is neither. Esc twice stops the
  turn too. The separate Interrupt button is gone.

### Added

- **The plan dock can be resized.** Drag its top edge (or focus it and use the
  arrow keys) to make the plan taller or shorter, up to nearly the whole chat.
  The height is remembered across sessions and VS Code restarts. It is a
  ceiling, not a fixed size: a plan shorter than it, or one with its tasks
  collapsed, still shrinks to where its content ends.

### Fixed

- **Live logs follow new output again.** The task log, the planner conversation
  and a task card's runner output stay on the newest lines while you are at the
  bottom, and stop following as soon as you scroll up to read back.

## [0.5.6] — 2026-09-30

### Fixed

- **OpenCode's terminal fits its tab.** The agent was floored at 80 columns, so
  in a narrower tab its TUI was clipped on the right and its lines wrapped
  mid-word. The floor is now 45 columns, the limit below which OpenCode exits.

- **`/model set` with an API model while a coding agent plans.** Naming an
  OpenRouter (or other vendor) model such as `deepseek/deepseek-v4-flash` used
  to open a picker of the agent's own Claude models and set nothing. It now
  offers to switch the planner to that provider and sets the model. The
  `/model set` suggestions also follow the planner now: with a coding agent
  planning they list that agent's models, not the whole API catalog.

- **An API planner now uses the model you set last.** A planner conversation
  on OpenRouter (or any OpenAI-compatible provider) kept calling the model it
  started with, so the picker changed the setting but not the running
  conversation. The model is now read on every API call.

- **A session saves into the workspace after Execute, not the extension
  host's own directory.** Approving a plan had handed the session an empty
  workspace path, so every later save under that plan landed in a stray
  `.ordewell` folder instead of the one you opened.
- **The usage-limit pause message mentions a kept worktree only when there is
  one.**

## [0.5.5] — 2026-09-28

### Added

- **The planner chat streams and shows what it used.** A planner's reply text
  appears as it is written instead of all at once, and the chat draws a token
  line from what the provider or runner reports — input, output and cached
  tokens, per-currency cost where stated, and context-window fill. Research
  subagents get their own cards with their brief, model, outcome and digest,
  and their usage counts into the line. A tool call reads as one line that the
  header's expand-all button opens.
- **Queue a prompt while the planner is working.** A message sent mid-turn is
  held and shown with an × to take it back; Esc withdraws the newest one, and
  with none queued the first Esc arms a stop and the second within about two
  seconds stops the turn (the button reads "Stop (Esc Esc)").
- **An approval card, plan markers and the plan dock.** A planner approval
  draws as a card naming what is approved and who decided it, and a committed
  plan becomes a marker in the conversation.

### Fixed

- **The chat panel follows light themes.** The focused input, hovered and
  expanded cards and inline code no longer render as dark blocks, and muted
  text stays readable.
- **A check you marked complete reads "Marked by you"**, not "Model Review" —
  your decision is no longer presented as a model verdict.
- **Finished tasks stay finished when the planner rewrites the plan.** A
  planner that answered "add a task" with the whole plan could send finished
  tasks back to pending, and they ran again. A task that is done, running or
  waiting on you now keeps its status whatever the planner writes, and an
  applied queued change is not applied again when the window reloads.
- **A usage limit or a failed merge no longer marks a finished task
  failed.** The task waits on you with its work kept, and the notice says why.
- **Cancelling a task keeps its worktree**, so Mark complete can still land
  work the runner finished before you cancelled it.

## [0.5.4] — 2026-09-26

### Fixed

- The chat panel follows light themes: the focused chat input, hovered and
  expanded task cards and inline code no longer render dark, and hover
  highlights and the runner chip in the model badge are visible. Thanks to
  @directsol.

## [0.5.3] — 2026-09-26

No extension changes; released alongside the CLI's fixes.

## [0.5.2] — 2026-09-26

### Added

- **Each project's own environment reaches its planner and agents**, from its
  allowed direnv `.envrc` and an untracked `.ordewell/env`, however VS Code was
  launched — so a project's `CLAUDE_CONFIG_DIR` picks the Claude Code account
  its agents run under.
- **`/parallel [<n>]` and "Ordewell: Set Parallel Tasks"** set how many AI tasks
  run at once, with no ceiling; `ordewell.maxParallelSessions` no longer stops
  at 5, and a change applies to a run already going.

### Fixed

- **OpenCode tasks no longer die in narrow terminals.** OpenCode's TUI exits
  with SIGILL (code 132) below about 45 columns, and each parallel task used to
  open beside the last one, halving the width every time. The agent now always
  gets at least 80 columns; task terminals open without taking focus, so
  parallel tasks share one side group as tabs, each named after its task.
- **A retry resumes a run its failure paused**, instead of only resetting the
  task to pending.
- **Finished agents are closed** when the run is merged, cleaned up or
  discarded, and when a repair or retry replaces them.
- **A task stopped at Claude Code's folder-trust or Bypass Permissions
  confirmation warns that it is waiting for you** instead of looking busy.

## [0.5.1] — 2026-09-26

### Added

- **A conflicted task repairs its own conflict first (ADR-0015).** A passed
  task whose landing conflicts runs again in its kept worktree, on its own
  runner and model, to merge the latest work in and resolve the conflict
  within evidence and a bounded number of tries. The new
  `ordewell.conflictRepairAttempts` setting (default 2; 0 turns repair off)
  caps how many repairs one task gets. Task cards show a repairing task with
  its attempt and the conflicting files, and mark a landed task that only
  landed after a repair; the handoff card names repaired tasks and their
  files. A repair that fails or runs out leaves the conflict exactly as it
  was: files named, "Resolve as a task" and the rest of the ways out working.

### Changed

- **Rewind forks the conversation instead of cutting it.** `/rewind` ("Ordewell:
  Rewind Conversation") copies the conversation up to just before the chosen
  message, with the current tasks, into a new session and loads it. The
  original keeps its whole conversation; use `/sessions` to go back. Like
  `/fork`, it asks first while a run is executing, since loading stops it.
- **A fully merged run is cleared up.** Once Merge all has merged everything,
  the run's worktrees and branches are removed and the handoff card and task
  marks close. A new run also deletes earlier runs' branches your checked-out
  branch already contains.

## [0.5.0] — 2026-09-25

### Added

- **Each AI task can run in its own git worktree (#12).** In a git repository,
  tasks work on their own branches and land on one integration branch per run,
  so tasks that edit the same files no longer overwrite each other. A task card
  marks a merge conflict, with an opt-in "Resolve as a task" action, and the
  task details show its branch and worktree. Uncommitted changes open a prompt
  to stash them, run without isolation this time, or cancel. At the end of a
  run the handoff card shows the integration branch and the landed tasks, with
  Review diff, Merge, Discard and Clean up. Turn it off with the
  `ordewell.worktreeIsolation` setting; `ordewell.worktreeSetupCommand`
  prepares new worktrees your own way.
- **A folder of git repositories isolates them together (ADR-0014).** Each task
  gets a worktree of every repository at its usual path, and a task lands in
  every repository it changed or in none. The handoff card shows each
  repository, and Merge all merges every one or none, naming the repository
  and reason when it holds back. Pick the repositories with
  `ordewell.workspaceRepos`, and link extra gitignored state such as
  `*.tfstate` into worktrees with `ordewell.worktreeLinks`.
- **Fork, rewind and compact the planner conversation (#9, #10).** `/fork`
  continues in a copy of the conversation, `/rewind` cuts it back to before one
  of your messages, and `/compact` replaces it with a summary the planner
  writes, keeping the last two exchanges. Also in the Command Palette as
  "Ordewell: Fork Conversation", "Ordewell: Rewind Conversation" and
  "Ordewell: Compact Conversation". The task list is left as it is.
- The planner can read a running task's recent output, so it can look at a
  task that seems stuck instead of guessing (#3).

### Fixed

- A task's summary is taken from its own transcript, not from another task
  that ran in the same directory.
- A retry, cancel, Mark complete or stop is no longer overwritten by a verdict
  from the task's previous attempt, and marking a task complete while its
  runner starts is no longer undone.
- Conflict marks and the handoff card come back after a reconnect or a session
  load.

## [0.4.23] — 2026-09-23

### Fixed

- Models added to a runner's allowlist during a session can now be assigned
  by the planner, and clearing the allowlist lifts the restriction right away
  (#17).

## [0.4.22] — 2026-09-23

### Fixed

- Codex tasks added or moved onto Codex now run with full access when
  autonomous mode is on, instead of the workspace-write sandbox. The New Task
  card's mode defaults to "Runner default", which follows the toggle.

## [0.4.21] — 2026-09-22

### Fixed

- A dependent task's context about its predecessors now shows the runner's
  actual final message, cleaned from the terminal's TUI paint (#14), and reads
  the agent's own session transcript when one is available (#16).

## [0.4.20] — 2026-09-22

### Fixed

- An OpenCode task's terminal tab no longer sits with the prompt typed in but
  unsent — it now starts on its own instead of waiting for a manual Enter.

## [0.4.19] — 2026-09-10

### Fixed

- Expanding a task in the plan dock now collapses any other open task, so the
  list stays readable instead of accumulating open cards.

## [0.4.18] — 2026-09-07

### Fixed

- A long OpenCode planning turn no longer fails with "fetch failed" — the
  planner reads the reply back out of the session instead of losing the turn.

### Added

- A third built-in skill, `improve-codebase-architecture` — invoke with
  `/improve-codebase-architecture` to surface deepening opportunities and turn
  the ones you pick into ordered plan tasks.

### Changed

- **The `grill-me` skill is renamed to `grilling`**, invoked as `/grilling`.

## [0.4.2] — 2026-08-02

### Fixed

- **The extension could not start.** `uuid` was left out of the bundle while the
  .vsix ships no `node_modules`, so activation threw `Cannot find module 'uuid'`
  and the panel never rendered. Affects every 0.4.0 install; upgrade.

  The bundler externalises everything in `dependencies` by default, and the
  build only opted `@ordewell/core` back in. Builds now fail if any module is
  left external without being shipped.

## [0.4.1] — 2026-08-02 (unreleased)

### Changed

- Marketplace icon now carries its own background. It was a transparent PNG with
  near-black strokes, so the mark disappeared on every dark background VS Code
  and the Marketplace render it against.
- Marketplace listing: dropped the lead image, which was a mock VS Code window
  drawn around the panel rather than a screenshot of one.
- Corrected the planner setup step — it named the `OPENROUTER_API_KEY` and
  `GEMINI_API_KEY` environment variables as though they were settings. The
  settings are `ordewell.openAiApiKey` and `ordewell.apiKey`.
- Corrected the CLI install: `npm install -g ordewell`, then `ordewell`.

## [0.4.0] — 2026-07-31

First public release.

### Added

- Streaming planner timeline: live thinking, each research step with its
  outcome, and task cards you expand for the runner's own output.
- Editable plan cards — change a task's runner and its model, effort and mode
  re-derive in place.
- Planner bar: choose the planning backend, its model, and thinking effort,
  scoped to what that backend can actually run.
- Harness planners — plan with Claude Code, Codex or OpenCode on a subscription
  you already hold, with no separate API key.
- Evidence-based task verdicts, with *Mark complete* and *Mark not done* for the
  cases the marker can't settle.
- Deep-interview planning modes: grill-me, PRD drafting, TDD augmentation,
  review and verify.
- Windows support.

Full project changelog:
https://github.com/ordewell/ordewell/blob/main/CHANGELOG.md

[Unreleased]: https://github.com/ordewell/ordewell/compare/v0.11.1...HEAD
[0.11.1]: https://github.com/ordewell/ordewell/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/ordewell/ordewell/compare/v0.10.12...v0.11.0
