# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While Ordewell is pre-1.0, minor versions may contain breaking changes.

## [Unreleased]

### Added

- **Each AI task can run in its own git worktree (#12).** In a git repository,
  every AI task gets a worktree on its own branch instead of the shared
  workspace root, so tasks that edit the same files can run side by side
  without overwriting each other. A task that passes its verdict is committed
  and merged into one integration branch per run, lowest plan order first; its
  dependents start only once its work is on that branch. A merge conflict stops
  the task and keeps its worktree — it is never resolved automatically; resolve
  it by hand and mark the task complete, retry it, or add a task that resolves
  it. Nothing is merged into your checked-out branch until you ask: at the end
  of a run you review the diff, merge, discard the run or clean up its
  worktrees — `/handoff` in the TUI, `ordewell handoff` on the CLI, the handoff
  card in VS Code. Uncommitted changes to tracked files hold a run until you
  stash them or choose to run without isolation (`ordewell run --stash` /
  `--without-isolation`). The planner stops ordering tasks just because they
  touch the same file when isolation is on. Worktrees link `node_modules`,
  `.env*` and agent config from your checkout; set `worktreeSetupCommand`
  (`ORDEWELL_WORKTREE_SETUP`) to prepare them another way. Turn the feature off
  with the `worktreeIsolation` setting or `ORDEWELL_WORKTREE_ISOLATION=false`;
  outside a git repository nothing changes.
- **Fork and rewind a planner conversation (#9).** Rewind cuts the conversation
  back to just before one of your messages; fork continues in a copy of the
  conversation and its tasks while the original stays as it was. Both act on
  the conversation only — the task list is kept as it is — and work with any
  planner. TUI and VS Code `/fork` and `/rewind`; CLI `ordewell fork` and
  `ordewell rewind [n]`; in VS Code also the Command Palette ("Ordewell: Fork
  Conversation" and "Ordewell: Rewind Conversation").
- **Condense a planner conversation on request (#10).** `/compact` in the TUI
  and VS Code (also "Ordewell: Compact Conversation" in the Command Palette) or
  `ordewell compact` replaces the conversation with a summary the planner
  writes, keeping the last two exchanges as they were. The tasks are untouched,
  the summary is shown to you, and a failed or stopped compaction changes
  nothing.
- **The planner can read a running task's recent output (#3).** A task read
  may ask for `output` — the clean-rendered tail of what the task is printing
  right now, with `outputLines` and `outputSince` to page through it — so the
  planner can look at a task that seems stuck instead of guessing. It uses the
  existing task-read channel, so it works the same for every planner and reads
  nothing outside what Ordewell captured.

### Changed

- **Internals reorganized behind narrower modules.** The planner conversation
  has one owner, each task run is one record from spawn to verdict, a task's
  output (the live tail and the final summary) has one owner, and terminal
  rendering is a pure module. No behaviour change is intended beyond the fixes
  below.

### Fixed

- **A task's summary is its own.** When parallel tasks ran in one directory, a
  task could be summarized from another task's transcript; transcripts are now
  matched by the task's completion marker, and a dependent's prompt no longer
  carries its predecessor's marker id. Claude Code transcripts are now found
  for a working directory with a dot in its path, or one long enough that
  Claude Code shortens its name.
- **A stale runner can no longer decide a newer attempt.** A retry, cancel,
  Mark complete, stop or plan load that landed while a verdict was being read
  was overwritten by that verdict; a retried task's runner could be dropped by
  the previous attempt's exit; and a terminal that outlived a stop could fail
  or pass the task's next attempt.
- **Marking a task complete while its runner was starting is no longer undone**
  when the runner comes up.
- **One-shot plan changes and queued mid-run edits appear in the conversation**,
  so the planner's replayed dialogue and the plan no longer drift apart.
- **Two sessions saved in the same second with the same goal** — a conversation
  forked twice — no longer overwrite each other's file.

## [0.4.23] — 2026-09-23

### Fixed

- **The planner can use models you allowlist mid-session (#17).** Adding a
  model to a runner's allowlist during a session showed it to the planner, but
  its edits assigning that model were refused as "does not offer model" when
  the session's start-up model discovery hadn't listed it. The planner now uses
  the allowlist in force on each turn and the latest discovered model catalog.
  Clearing the allowlist mid-session also lifts the restriction; before, it
  fell back to the list the session started with.

## [0.4.22] — 2026-09-23

### Fixed

- **Codex tasks now run with full access under autonomous mode.** A task moved
  onto Codex, or added by hand, took the first mode Codex lists — its
  workspace-write sandbox — instead of the mode the autonomous toggle selects.
  With approvals off, a sandboxed Codex task could not ask for more access, so
  it stopped at the first blocked command. New and retargeted tasks now land on
  the toggle's mode (`fullAccess` when autonomous mode is on), and a planned
  task with no mode resolves the same way. Existing tasks keep the mode they
  have — change it per task or regenerate the plan.

## [0.4.21] — 2026-09-22

### Fixed

- **Dependent tasks now receive their predecessor's real final message, not a
  frozen frame of the runner's UI.** The output summary captured as context for
  dependent tasks was the raw terminal tail — for interactive runners that is
  mostly TUI paint (spinner lines, the `ctx:` status bar, cursor-positioned
  fragments) with the actual answer scattered or absent (#14). Capture is now
  screen-rendered and cut at the completion marker, so everything below the
  marker — the persistent status bar, spinner and input gutter — is dropped.

### Added

- **The summary prefers the agent's own session transcript.** Claude Code
  (JSONL transcripts), OpenCode (its SQLite store) and Codex (rollout files)
  all write a clean, structured record of the conversation. When the runner's
  transcript can be located for the task's working directory and start time,
  the dependent task now reads the agent's actual prose; the cleaned terminal
  capture remains the fallback when no transcript exists (#16). The terminal
  is untouched as the source of verdict evidence — this changes only what is
  summarized for downstream consumers.

## [0.4.20] — 2026-09-22

### Fixed

- **OpenCode tasks no longer sit waiting for a manual Enter to start.** In a
  tmux window or a VS Code terminal tab, OpenCode's `--prompt` flag only
  pre-fills its TUI's composer — it never submits it, unlike Claude Code's and
  Codex's own interactive prompts. A task's window opened with the prompt
  visibly typed in but idle, and a human had to press Enter in the terminal
  before it would run. The runner now sends that Enter itself right after
  launch.

## [0.4.19] — 2026-09-10

### Fixed

- **Expanding a task in the plan dock now collapses any other open task.** The
  cards acted like independent toggles, so opening several meant closing each
  one by hand before the list was readable again. They now behave as an
  accordion: at most one task body is open at a time.

## [0.4.18] — 2026-09-07

### Fixed

- **A long OpenCode planning turn no longer fails with "fetch failed".** The
  turn is one HTTP request held open for its whole duration, and OpenCode
  sends no response headers until it ends — so Node's global `fetch`, which
  gives up after 300 seconds, abandoned any turn past five minutes while the
  server was still planning. The request is the turn's transport, not its
  work: the reply is now read back out of the session instead of the turn
  being lost, and a turn still in progress keeps the planner watchdog fed.
  Failures that stay unrecoverable name the underlying cause rather than
  reporting a bare `fetch failed`.

## [0.4.17] — 2026-09-02

### Added

- **A third built-in skill, `improve-codebase-architecture`.** Adapted from
  [Matt Pocock's skill of the same name](https://github.com/mattpocock/skills):
  scans the codebase for deepening opportunities and presents them prioritized
  directly in chat (the original's HTML report has no analog here — the
  planner is read-only and can never write a file), then splits however many
  candidates the user wants to act on into ordered plan tasks instead of
  grilling through a single live refactor. Two selected candidates that touch
  overlapping files are made dependent on each other so independent runners
  never edit the same file in parallel. Invoke with `/improve-codebase-architecture`.

## [0.4.16] — 2026-08-31

### Fixed

- **The VS Code extension no longer false-positives "The planner stopped
  responding" while Claude Code is still actively working.** The webview's
  idle watchdog reset only when a progress event reached it, but Claude
  Code's adapter deliberately drops every raw line belonging to a native
  subagent before it becomes an event. A subagent doing long nested
  exploration produced nothing for over two minutes, starving the watchdog
  into interrupting a session that was never actually stuck. Liveness is now
  signaled at the shared raw-line boundary, below any adapter's content
  filtering, so it no longer depends on what a given runner chooses to
  surface — closing the same gap for every harness planner, not just Claude
  Code.
- **`/skill-name` now expands anywhere in a message, not only when it is the
  entire message.** `resolveSkillInvocation` substituted a skill invocation
  only when a message matched it exactly, so `/grilling do this` sent the
  literal, unexpanded token to the model even though the TUI and VS Code
  webview both highlighted it as recognized. Any whitespace-bounded
  `/skill-name` token is now spliced in wherever it appears.
- **Pressing Tab on a highlighted `/model set` suggestion no longer crashes.**
  It called `modelCmdPrefix(text)`, a function that was never defined
  anywhere in the codebase. A model row is only ever completed onto
  `/model set`, so that prefix is now inlined directly.

## [0.4.15] — 2026-08-31

### Fixed

- **A brand-new project directory can now be initialized instead of just
  being refused.** `assertWorkspaceIsProject` (the 0.4.9 confinement-boundary
  check — see below) rejected any workspace without a `.git`/`.ordewell`/
  manifest marker, but nothing ever bootstrapped one: there was no `init`
  command, and `.ordewell/` was only ever created lazily on first session
  save, after this check had already thrown. Starting `ordewell` in a
  genuinely fresh folder had no way through. The check itself is unchanged —
  an unmarked directory is still never admitted silently — but the TUI now
  offers an explicit "Initialize this as a new workspace?" prompt on
  rejection, and only on confirmation does it create `.ordewell/` and retry.

## [0.4.14] — 2026-08-27

### Fixed

- **Changing a subtask's model, runner, effort or mode no longer shows an
  empty picker.** Every per-task picker (`o`/`R`/`e`/`M`/`D` and their
  `/task-*` slash commands) looked a task up with a flat `state.tasks.find`,
  which only sees top-level tasks — a subtask lives nested under its parent's
  `subtasks`. That silently produced the generic empty-picker fallback
  ("Nothing to show yet…") for any subtask, and crashed a few command paths
  outright. All of those lookups now use the existing recursive task-tree
  search.
- **A VS Code subtask assigned to a different runner than its parent now gets
  its own runner's model catalog.** The per-task card passed its own
  parent-scoped model and mode lists straight through to every subtask card,
  so a subtask running on a different agent than its parent saw the wrong
  agent's models (or none). Subtasks are now scoped to their own
  `assignedRunner`.
- **VS Code's per-task model dropdown re-discovers when opened**, the same
  way the TUI's already did. Discovery only ran on activation, a config
  change, or a webview reconnect, so a catalog left degraded by a cold runner
  CLI at one of those moments never healed on its own — even after the CLI
  was clearly working, an already-assigned task's dropdown stayed empty until
  the window was reloaded.
- **The planner's `/model` picker now shows which provider each model comes
  from**, matching every other model picker in the TUI. It was the only one
  that dropped this, so two same-named models from different providers (e.g.
  OpenCode's own catalog vs. an OpenRouter-backed one) were indistinguishable.

## [0.4.13] — 2026-08-26

### Fixed

- **OpenCode (or any installed-but-not-"enabled" runner) no longer shows the
  wrong models, or none at all.** Model discovery was scoped to
  `enabledRunners` — a setting meant only to control which runners the
  planner may auto-assign tasks to — but the per-task Runner dropdown and the
  planner backend pills let you pick *any installed* runner regardless of
  that setting. Picking one outside `enabledRunners` left its catalog
  undiscovered: the VS Code extension's degraded-discovery fallback then
  silently substituted another runner's models (typically Claude Code's),
  and the TUI's task-model picker showed an unexplained empty list. Discovery
  now covers every installed runner, and the TUI's picker explains an empty
  catalog the way the planner's already did ("No `<runner>` models discovered
  yet — run `/refresh`"). (#1)

## [0.4.12] — 2026-08-26

TUI plan pane and VS Code chat-panel fixes, plus a live-resizing PTY for
in-editor agent terminals.

### Added

- **The agent PTY resizes live.** `script` allocates its PTY at 0×0 off a
  pipe, so a TUI reading its size via `ioctl` rendered as garbage until
  something called `stty`. The wrapper now sets the tab's real size before
  the agent starts and keeps a control channel (fd 3) open so later tab
  resizes reach the PTY slave too.

### Fixed

- **The TUI plan pane can now reach subtask rows.** Enter on a task with
  subtasks used to expand it and open its prompt editor in the same step,
  which hijacked every following key — including up/down — into the text
  draft. There was no key sequence that actually landed the cursor on a
  3.1/3.2 row, so subtasks read as collapsed away even though the plan tree
  had them. Enter now only reveals subtask rows on a parent's first press; a
  second enter (or any row without subtasks) opens the editor as before, and
  escape backs out of that browsing state one level at a time instead of
  leaving the plan pane. Editing a subtask's prompt no longer has its
  keystrokes swallowed as pane shortcuts, and a plan refresh no longer
  silently collapses a subtask being edited.
- **Task output in the VS Code chat panel no longer shows raw ANSI escapes.**
  Runner output is PTY text full of colour/cursor codes meant for a real
  terminal; the webview's `<pre>` rendered them as literal garbage. Escapes
  and control bytes are now stripped per chunk, and CR-only redraws are
  split onto separate lines instead of being jammed together.
- **Checkpoint summaries are truncated to a single line.** Multi-line
  reasoning could spill across the CLI notice and the extension's
  `CheckpointPanel`; both now show only the first line, capped at 120
  chars, with the full text still available via the panel's title tooltip.

## [0.4.11] — 2026-08-20

Planner and skills rework, task-idle visibility, TUI/session isolation, and a
targeted hardening of credential redaction in response to the 0.4.9 disclosure
follow-up.

### Added

- **The `grill-me`/PRD toggles are replaced with a general skills system.**
  Built-in `grilling` and `to-spec` skills (backed by `SkillsService` and a
  global skills data dir) are now invoked via slash commands, across core,
  CLI, VS Code and web.
- **Running tasks now surface when they go idle.** An `idleSince` state —
  tracked per task, emitted by the VerdictEngine and cleared when output
  resumes — shows a static idle icon in the TUI and the VS Code chat view for
  a task that is running but has produced nothing recently.

### Changed

- **Review mode is removed** from the planner prompts, settings service and
  session management (and cleaned out of the VS Code extension and web server
  routes). No tests reference it any longer.
- **Concurrent TUI sessions are isolated.** `ordewell tui` now spawns its own
  private daemon on a free port by default, so two terminals against the same
  workspace no longer pull each other's tasks into view (shared-port handoff
  for VS Code/web-UI is opt-in via `--port`/`ORDEWELL_PORT`), and that owned
  daemon self-terminates if its spawning CLI dies with a signal it can't
  deliver (e.g. `kill -9`).
- **CLI session pointers and config migration are scoped and fixed.** The
  machine-global `~/.config/ordewell/last-session.json` pointer is now
  `<workspace>/.ordewell/last-session.json`, so a one-shot command can no
  longer silently fall back to a session from an unrelated terminal.
  `migrateOldConfigDir()` now lifts each file independently, so a real `.env`
  with API keys stranded in `~/.config/ordewell` is no longer skipped once
  `settings.json` had already migrated.

### Fixed

- **A long, plain-word secret under an unambiguous credential name is now
  redacted.** Research output where the value carries no digit, no mixed case
  and no punctuation — a passphrase like `password: "correcthorsebatterystaple"`
  or `secret: "batterystaple"` — previously leaked through the identifier
  bypass. An unambiguous name (`password`, `secret`, `privateKey`,
  `passphrase`, `credentials`) with a value ≥12 chars is now treated as key
  material even without a digit. The length floor keeps short
  settings-references (`secretStoreKey: 'cohereKey'`) from being rewritten, so
  config-shaped code is still left intact — a deliberate, documented
  false-negative trade-off for sub-floor no-digit values.
- A stale `grill-me` seed left in `~/.ordewell/skills` by a build from before
  the rename to `grilling` is now pruned on upgrade, so it stops lingering
  in the skill list forever. Only untouched seeds are removed — anything a
  user added or modified under that name is left alone.

## [0.4.10] — 2026-08-17

Planner and TUI fixes, and a read/edit channel that lets the planner work on
the plan during a conversation instead of only regenerating it.

### Added

- **The planner can read and edit tasks mid-conversation.** A `task_query`
  read channel and validated `task_ops` editing during an active session,
  with batch reference semantics, an enriched plan/catalog context block,
  AI↔MAN type coherence, model and task-mode validity checks, topological
  dependency repair, and re-arming of failed or completed tasks that releases
  their blocked dependents. The shared edit rules live in `TaskEditValidator`
  so the `Session` and `TaskOps` seams cannot drift apart. See
  [ADR-0012](docs/adr/0012-the-task-query-read-channel.md).

### Fixed

- **Foreign control codes no longer reach the terminal.** Everything the TUI
  shows that it did not write itself — a planner turn, a research result, a
  task title, a runner's error — routinely carries terminal control codes, and
  only literal tabs were being stripped. These are not text: `width()` measures
  an escape as zero columns because the terminal acts on it rather than
  printing it, so a cursor-forward shifted the pane divider and painted the
  plan pane over the chat, an erase-in-line wiped the row beneath it, an
  unclosed colour bled down the screen, and a BEL rang once per frame — every
  120ms during a run. Whole sequences are now dropped rather than just their
  ESC byte, across three paths that had no sanitizing at all: streamed planner
  reasoning, every string in a normalized plan, and pastes.
- **A failed planner turn no longer leaves a prompt with no reply.** The user
  message was appended to the transcript and research log before the model was
  called, so a turn that threw left both holding a message the session never
  answered — replayed into the next turn, and shown against a plan on disk that
  had neither. A failed turn now undoes exactly its own writes, while a
  `task_ops` turn that persisted before throwing keeps its edits.
- **`/model` and `/planner` switches take effect mid-session.** `WebConfig`
  cached the resolved provider on first read and held it for the life of the
  session, so a switch left the transport pinned to the original provider while
  `apiKey` — which reads live — handed it a key belonging to someone else.
- **A Claude Code planner no longer answers as its own subagents.** Claude Code
  replays a subagent's transcript on the planner's stream, parented to the tool
  call that spawned it; read as the planner talking, an exploration agent's
  commentary opened the reply — often an answer to a prompt the user never sent
  — and its tool calls padded the research log. Subagent traffic is now dropped
  at the adapter, leaving the spawning `Agent` call and its result as the
  planner-level record.
- **A harness planner no longer loses its own research.** Backgrounding an
  exploration agent ended the turn on "I'll report back once they land", and
  everything said afterwards — including the finished research — arrived with no
  turn open and reached no one. The planner is now told to await its agents
  inside the reply, and a turn that backgrounds one anyway is asked to wait for
  the results while a turn is still open, at most twice.
- **A closed turn's straggling work stays out of the next turn.** Tool activity
  arriving after a turn ended — a backgrounded subagent finishing, a late read —
  was held and replayed into the following turn, where it read as research done
  for the user's new message. Only pre-first-turn startup warnings are held now.
- **Planner messages no longer run together.** Each Claude Code message, and
  each OpenCode text part, opens a paragraph after the first — as Codex's
  already did — instead of being concatenated onto the previous sentence.

## [0.4.9] — 2026-08-17

Completes the command-policy hardening started in 0.4.8. Four advisories
publish alongside this release with full technical detail now that the fixes
are shipped:

- [GHSA-r72g-cw5r-pxv2](https://github.com/ordewell/ordewell/security/advisories/GHSA-r72g-cw5r-pxv2)
  — command classifier bypass, high. Fixed here, including the approval-scope
  collisions found in maintainer review.
- [GHSA-q8mp-gq5v-28w8](https://github.com/ordewell/ordewell/security/advisories/GHSA-q8mp-gq5v-28w8)
  — credentials in researched files written to the session file and sent to
  the model provider, medium. Fixed here.
- [GHSA-px4h-42r5-qvhf](https://github.com/ordewell/ordewell/security/advisories/GHSA-px4h-42r5-qvhf)
  — unauthenticated daemon attack chain, high. Fixed in 0.4.8, disclosed here.
- [GHSA-7898-43ch-jgqv](https://github.com/ordewell/ordewell/security/advisories/GHSA-7898-43ch-jgqv)
  — plugin install code execution, critical. Fixed in 0.4.8, disclosed here.

**Upgrading does not undo a credential disclosure that already happened.** If
planning sessions ran in a workspace where credentials were readable, read
GHSA-q8mp-gq5v-28w8 — session files written before 0.4.9 may hold them in
plaintext, and rotation rather than upgrading is the remedy for anything a
provider or a commit already received.

### Fixed

- **The permitted command tier is a per-binary flag allowlist, not a binary
  denylist.** A binary that was previously permitted with any flag at all is
  now only permitted with the flags it's declared read-only with; an
  unrecognised flag is refused rather than allowed.
- **Bare positional ref-writes are refused.** `git branch <name>` and
  `git tag <name>` create or move a ref with no flag involved, so the guard
  covering the delete/move flag forms (`-d`, `-M`, `--delete`, ...) never saw
  them and they classified as read-only. A positional ref name is now refused
  unless `-l`/`--list` marks it as a filter pattern.
- **Shell keywords and compound-command openers are refused.** The classifier
  reads a segment's first token as the command to classify, so `{ ... }`,
  `if ... then ... fi`, `for`, `while`, `time` and `export` sat in that
  position while the command they introduce went unclassified — `if rm -rf
  src; then :; fi` really did run `rm -rf src`. These are now refused
  outright, and `source`/`.` join `eval`/`exec` rather than prompting, where
  one approval would otherwise cover every other script sourced that session.
- **Approval grants no longer collide across distinct operations.** Grant
  scope was the multiplexer name plus its first non-flag argument, which
  let approving one operation (`npm run test`, `az group list`, `aws s3 ls`)
  silently authorise a different one (`npm run <other-script>`, `az group
  delete`, `aws s3 rm`). Scope is now the binary plus up to two leading
  non-flag arguments before the first flag.
- **The daemon refuses to treat an arbitrary directory as a workspace.** A
  workspace root now has to carry a project marker (`.ordewell` or a VCS
  directory); without one, the filesystem root or any system directory could
  become the confinement boundary for every read, search and permitted
  command the planner runs.
- **Session identifiers are unguessable.** Session ids were timestamp-based,
  letting an attacker who knew roughly when planning started enumerate the
  identifier space.
- **Credentials are redacted from research output.** A planner that read a
  configuration file during research previously put its credentials into the
  provider payload, the persisted session file, and — since the session
  directory lives inside the workspace with no ignore rule — a commit waiting
  to happen. Redaction is now applied where a tool result is constructed, so
  one application covers every sink downstream, and the state directory gets
  a match-everything ignore file written inside it on first save. An
  unambiguously named credential whose value looked like an identifier
  (`password: "TopSecretValue123"`) initially slipped past the rule that
  exists to leave setting names alone; the credential name now wins.
- **The plan surface marks which tasks run without permission prompts.** The
  TUI and VS Code extension now surface a task's `autonomous: true` tag on
  its mode.

## [0.4.8] — 2026-08-11

Hardening release across the daemon and command-handling paths. This entry was
written deliberately neutral at the time, while the advisories were still
private; the detail is now public in
[GHSA-px4h-42r5-qvhf](https://github.com/ordewell/ordewell/security/advisories/GHSA-px4h-42r5-qvhf)
(unauthenticated daemon attack chain — this is the release that breaks that
chain) and
[GHSA-7898-43ch-jgqv](https://github.com/ordewell/ordewell/security/advisories/GHSA-7898-43ch-jgqv)
(plugin install code execution — fixed in full here). Note that 0.4.8 does
*not* fix the command classifier bypass
([GHSA-r72g-cw5r-pxv2](https://github.com/ordewell/ordewell/security/advisories/GHSA-r72g-cw5r-pxv2))
or the credential disclosure
([GHSA-q8mp-gq5v-28w8](https://github.com/ordewell/ordewell/security/advisories/GHSA-q8mp-gq5v-28w8));
both need 0.4.9.

No API changes. Upgrading is recommended for all users. Per this project's security
policy, fixes ship forward and are not backported to 0.4.6 or 0.4.7.

## [0.4.7] — 2026-08-10

No functional changes. Re-releases 0.4.6, whose npm and VS Code Marketplace
publishes never completed after being pushed as a tag — both registries
reject re-publishing a version number they already have on file.

## [0.4.6] — 2026-08-09

### Added

- **The planner model survives a planner switch.** Switching back to a planner
  restores the model (and thinking effort) last used with it instead of forcing
  a re-pick; with nothing remembered it falls back to the first model in that
  planner's catalog, and the model is left unset only when no models have been
  discovered. The memory lives in the same `settings.json` as `modelAllowlist`,
  so the TUI, the CLI and the VS Code extension all share it.

## [0.4.5] — 2026-08-04

### Fixed

- **Text in a task's tmux terminal is selectable and copyable.** The runner
  session sets `mouse on` for wheel scrolling, which hands mouse events to tmux
  and so takes the emulator's own drag-select with it — and tmux's replacement
  selection lands in a paste buffer no other application can read, so copying a
  stack trace out of a task's terminal was impossible. Drag-release now copies
  and leaves copy mode, piped through a detected clipboard binary (`wl-copy`,
  `xclip`, `xsel`, `pbcopy`, `clip.exe`) that also backs the default
  double-click, triple-click, `Enter` and `y` copy paths; `set-clipboard on`
  carries the cases no local binary can, such as viewing over SSH. Each option
  is applied independently, so an older tmux without `copy-command` (pre-3.2)
  no longer loses the scrollback bindings that followed it.

## [0.4.4] — 2026-08-04

### Fixed

- **TUI text is selectable and copyable again.** The TUI captured the terminal's
  mouse to read wheel events, and an app that captures the mouse takes
  drag-to-select with it — Shift+drag is not the universal escape hatch it is
  claimed to be (Terminal.app wants Fn, iTerm2 Option, tmux swallows it first).
  Copying a task prompt or an error out of the transcript matters more than a
  three-line wheel notch, so the mouse is left to the terminal by default and
  the wheel is opt-in via `/mouse on` (persisted as `ORDEWELL_TUI_MOUSE`).
  `pgup`/`pgdn` now scroll the plan pane as well as the transcript, and
  alternate scroll is disabled while the TUI is up so an uncaptured wheel cannot
  arrive as arrow keys and quietly replace the draft with a history entry.
- **The planner no longer says the same thing twice in chat.** One turn reaches
  the TUI over the session socket *and* as the last assistant entry of the plan
  the REST call returns, and while a run is live there are two subscriptions to
  that one channel — so a turn taken during execution was transcribed twice. The
  socket is now the live path, the REST reply is only a fallback for a turn it
  did not carry, and a repeat of the newest turn is dropped rather than appended.
- **Codex and OpenCode tasks open their real TUI in tmux.** Opening a task's
  terminal showed `codex exec` / `opencode run` log lines scrolling past instead
  of the agent's interface, which is the whole point of running tasks in a tmux
  window — you could watch, but not steer. One `headless` flag was deciding two
  unrelated things: whether the run is unattended (so the agent must never stop
  to ask permission) and whether it gets a terminal. A tmux window is both at
  once, so those are now separate axes and the tmux transport asks for the
  interactive shape. Claude Code, which had no non-interactive branch in its
  invocation, is unaffected.
- **Codex no longer stalls on its own approval and directory-trust prompts.**
  Both are questions `codex exec` never asks and its TUI asks by default — an
  orchestrated task has nobody to answer them, so it would sit on a menu
  forever. The interactive invocation now carries `-a never` and pre-trusts the
  task's workspace directory, matching what `exec` did implicitly.
- **VS Code tasks keep their permission-skipping flags.** The extension's
  terminal was treated as "not headless" and so lost them, meaning a task could
  block on a permission prompt in a tab nobody was watching.

## [0.4.3] — 2026-08-02

### Added

- **`ordewell --version`.** It was never implemented — the flag fell through to
  `Unknown command`, which read as a broken install rather than a missing
  feature. `version` and `-v` answer the same way, printing a bare version
  string so scripts can compare it without parsing.

## [0.4.2] — 2026-08-02

### Fixed

- **The runner selection survives a restart.** Enabled runners were held only in
  the daemon's memory, so closing and reopening Ordewell threw the choice away
  and silently reinstated the environment's defaults. They now persist to the
  same `settings.json` the model allowlist uses.

### Changed

- **One key convention for every multi-select in the TUI.** `/runners` is now a
  multi-select like `/allowlist` and `/task-deps`: space toggles, enter confirms
  the whole set, escape discards. It previously applied each toggle immediately
  on enter, with escape merely closing. Single-select pickers (`/planner`,
  `/model`, per-task assignment, sessions, keys) still confirm on enter.
- The selection mark in a picker is spaced off the cursor arrow, which rendered
  as one smudged glyph at most terminal font sizes.

## [0.4.0] — 2026-07-31

First public release.

### Added

- **Planner as a conversation.** One continuous chat that researches the repo
  read-only, asks when a goal is vague, and whose final message *is* the plan
  ([ADR-0002](docs/adr/0002-planner-as-conversation-loop.md)).
- **Per-task model routing.** Every task carries its own runner, model, thinking
  effort and mode, chosen by the planner across the whole plan and editable
  before anything runs.
- **Harness planners.** Claude Code, Codex or OpenCode can act as the planner on
  a subscription you already hold, with no separate API key
  ([ADR-0009](docs/adr/0009-coding-agents-as-planners.md)).
- **Evidence-based verdicts.** A task completes only when its unique completion
  marker appears in the runner's output; exit code is kept as diagnostic
  evidence and the model is never the tie-breaker.
- **Three surfaces over one core** — a VS Code extension, a full-screen terminal
  UI ([ADR-0006](docs/adr/0006-tui-pure-core-thin-driver.md)), and a CLI where
  every slash command is also a subcommand.
- **Read-only exploration envelope.** Reads run in parallel, anything reaching
  outside the workspace asks once, and commands that would write are refused
  ([ADR-0008](docs/adr/0008-planner-exploration-envelope.md)).
- **Runner plugins.** Claude Code, Codex and OpenCode are built in; any other
  CLI agent is a manifest, not a code change.
- **Windows support** across every surface except the tmux-backed TUI
  ([ADR-0010](docs/adr/0010-windows-support.md)).
- Deep-interview planning modes: `grill-me`, PRD drafting, TDD augmentation,
  review and verify.

[0.4.5]: https://github.com/ordewell/ordewell/releases/tag/v0.4.5
[0.4.4]: https://github.com/ordewell/ordewell/releases/tag/v0.4.4
[0.4.3]: https://github.com/ordewell/ordewell/releases/tag/v0.4.3
[0.4.2]: https://github.com/ordewell/ordewell/releases/tag/v0.4.2
[0.4.0]: https://github.com/ordewell/ordewell/releases/tag/v0.4.0
