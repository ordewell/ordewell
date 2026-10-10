# Change Log

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
