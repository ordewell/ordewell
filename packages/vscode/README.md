# Ordewell for VS Code

**Plan once, run it across Claude Code, Codex, OpenCode, GitHub Copilot CLI, Qwen Code and Cline, and review one branch.**
One goal becomes an editable plan with a runner and model assigned to each AI task.
By default, submitted build plans wait for your approval. Run settings let you
automate execution and merging. Research tasks and consented script tasks can
start during planning.

This README describes 0.12.3. See the [published releases](https://github.com/ordewell/ordewell/releases)
for versions available to install and their release notes.

## Features

- **An editable plan.** Every agent task carries a runner, model, thinking effort
  and mode. Change any of them, add or remove tasks, and rewire dependencies without
  losing completed work.
- **A planner that talks back.** It researches your workspace without modifying it,
  asks clarifying questions, and then hands you the plan.
- **Choose models per task.** Review and edit each AI task's model and thinking
  effort before execution. Planning uses the selected planner model too.
- **Worktree isolation for code tasks.** With isolation enabled and git 2.38 or
  newer, code tasks run in separate worktrees and passing changes land on an
  integration branch for review. Ops and script tasks run at the workspace root. Without a git repository,
  or with isolation disabled, tasks share your workspace folder.
- **Skills your team shares.** Write a skill once and commit it. The planner
  attaches it to the tasks it fits, and it shows as a chip on each task card.
- **More than coding tasks.** A script task runs exact commands under your
  approval and run settings, a check-and-fix loop repeats until its check passes
  or its rounds run out, and a research task reports back to the planner while
  you keep talking. A read-only task lands nothing; in a single-repository
  worktree, it can save a prototype as a patch for a later task.
- **Limits and context in view.** The footers show your Codex, Claude Code or
  OpenCode Go account's plan limits beside context and cost, and an API planner
  compacts its own context before it overflows.
- **Completion is recorded.** An AI task's `task_complete` report with status
  `done` passes its completion check. Reports marked `failed` or `blocked`, or a
  runner exit without a report, do not pass. Script tasks use their exit status.
  Review the diff and test evidence before merging.
- **No extra API key.** Claude Code, Codex or OpenCode can be the planner, using the
  subscription you already have.

## Getting started

1. Install the extension.
2. Open the Ordewell panel from the activity bar.
3. Type a goal. With Claude Code, Codex or OpenCode installed, the first usable one
   plans for you with no API key. Choose another planner in the planner bar.
4. Review the plan, then approve it to run.

Autorun and automatic merging are off by default, and the supervisor starts at
Watch. In `/settings`, you can enable autorun, automatic merging or an Act
supervisor that can merge. The handoff card lets you review the combined diff,
merge it or discard the run.

To plan with an API key instead, set `ordewell.openAiApiKey` (OpenRouter) or
`ordewell.apiKey` (Gemini), or export `OPENROUTER_API_KEY` or `GEMINI_API_KEY`. A key
you have set takes priority over the installed agent.

Each runner you want to use (Claude Code, Codex, OpenCode, GitHub Copilot CLI, Qwen Code or Cline)
must be installed and on your PATH. If a runner appears greyed out right after installing it, reload the
window so the extension picks up the new PATH.

Skills are `SKILL.md` folders: type `/name` in the panel to load one into the
conversation, and attach task skills as chips on a task's card. See
[Writing skills](https://github.com/ordewell/ordewell/blob/main/docs/skills.md).

The Command Palette offers **Ordewell: Rewind Conversation**, **Fork
Conversation** and **Compact Conversation**. Isolation can be configured under
`ordewell.worktreeIsolation` and related settings.

### On Windows

The extension and its local daemon run natively on Windows. The `ordewell`
terminal UI is not verified there; run it under
[WSL](https://learn.microsoft.com/windows/wsl/install). Ordewell finds
npm-installed runners (`.cmd` and `.exe` shims).

Most of the Windows support is tested on Linux, through the seams that stand
in for Windows. On a Windows host, only how npm-installed runners are launched
has been measured, and no first run from goal to merge has been watched end to
end. Two things are known to be open: whether Codex's read-only sandbox is
enforced, and `%VAR%` expansion on the `cmd.exe` shim route. The planner's
shell has no OS sandbox on Windows and relies on its command rules alone. See
[Windows support](https://github.com/ordewell/ordewell/blob/main/docs/adr/platform/0010-windows-support.md).

## What the extension sends

Once a day, the extension asks ordewell.ai whether a newer version is out. The
request carries the version you run and a random install ID, kept in
`~/.ordewell/version-check.json` and shared with the command line. The ID is
replaced every 30 days. Nothing else is sent: no code, prompts, paths, file
names or account details. Like any server, ordewell.ai sees the IP address the
request comes from.

The first time Ordewell starts on a machine, the extension shows a notice saying
this and sends nothing. If it cannot write that file, it shows no notice and
never sends anything. The Marketplace handles updates, so the extension shows no
update line.

Turn it off by turning off VS Code's telemetry (`telemetry.telemetryLevel`).
`ORDEWELL_NO_VERSION_CHECK=1` and `DO_NOT_TRACK=1` turn it off too. Turned off,
nothing is sent and no install ID is written.

## Also available

The same project ships a command line and a terminal UI:

```bash
npm install -g ordewell
```

## Links

- [Documentation](https://ordewell.ai/docs)
- [Source code](https://github.com/ordewell/ordewell)
- [Report a bug](https://github.com/ordewell/ordewell/issues)
- [How did your first run go?](https://github.com/ordewell/ordewell/discussions/115) Tell us what worked and where you got stuck.

Licensed under the [Apache License 2.0](https://github.com/ordewell/ordewell/blob/main/LICENSE).
The Ordewell name and logos are not covered by this license.
