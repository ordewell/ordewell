# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While Ordewell is pre-1.0, minor versions may contain breaking changes.

## [Unreleased]

### Changed

- **The `grill-me` skill is renamed to `grilling`**, invoked as `/grilling`.
  Its interview method is rewritten around a design-tree/frontier/rounds
  structure instead of one-question-at-a-time.

### Fixed

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
