# @ordewell/cli

The command line and terminal UI for **[Ordewell](https://ordewell.ai)**, task
orchestration for coding agents. One goal becomes an editable plan with a runner
and model assigned to each AI task. With worktree isolation enabled, code tasks
run in separate worktrees; ops and script tasks run at the workspace root.
Ordewell records task outcomes and combines code changes for review and merging.

This README describes 0.11.3. See the [published releases](https://github.com/ordewell/ordewell/releases)
for versions available to install and their release notes.

## Installation

```bash
npm install -g @ordewell/cli        # or: npm install -g ordewell
```

**Requirements:** Node.js 20.3 or newer, at least one of Claude Code, Codex or
OpenCode, and git for task isolation. Linux, macOS and Windows are supported;
on Windows, run the terminal UI under WSL.

## Usage

Run `ordewell` in your project to open the terminal UI: the conversation on the
left, the live plan on the right (or beneath it, below 70 columns). The first run lets you pick a planner and runners
with `/planner` (Harness › Model › Effort, each step saved as you go) and `/runners`, and no API key is needed if you plan with a coding
agent you already use.
By default, submitted build plans wait for your approval. Autorun can start them
automatically; research tasks and consented script tasks can start during planning.
Automatic merging is optional, and an Act supervisor can also merge.
The welcome screen lists the repositories and branches code tasks will use, and
whether they get isolated worktrees.

`/settings` walks autonomy, supervisor, merge automatically, autorun, parallel
(research uses the same Parallel slots) and delegation in one panel and saves only what you changed. `/planner` walks harness, model and
effort in one flow, so there is no separate model or effort command. Press `?` in
the plan pane for the full key sheet; the footer shows only the keys that apply
to the selected task.

Most commands in the terminal UI are also subcommands. The exceptions: `/help`
is `ordewell --help`; `/quit`, `/new` (every `ordewell plan` starts a fresh
session) and `/save` (plans persist as they change) have no subcommand; `/load`
and `/delete` are `ordewell sessions load|delete`; `/open` opens a task's view
in the full-screen terminal, where a shell has no view to switch to
(`ordewell checkpoint` answers from one); `/inbox` lists everything waiting on you
and answers it in place, with a count on the status row while anything waits; `/mouse` configures that terminal; and
`/settings` is a panel over headless commands that remain for scripts
(`ordewell auto`, `supervisor`, `automerge`, `autorun`, `parallel` and `delegation`);
`ordewell supervisor reads` and `ordewell trailer` have no panel row. `/planner` has its own `ordewell planner`, and its model and effort
steps are `ordewell model` and `ordewell planner-effort`.

```bash
export AI_PROVIDER=claude-code      # plan with Claude Code, Codex or OpenCode

ordewell plan --goal "Add rate limiting to the public API"
ordewell run
ordewell handoff review             # read the diff
ordewell handoff merge              # bring it onto your branch
```

Run `ordewell --help` for the full list, or `ordewell setup` to write a
starter `.env` file.

Type `/name` in the conversation to load a skill, and use `ordewell skills` to
list the ones a workspace sees and `ordewell task-skills` to attach them to a
task. [Writing skills](https://github.com/ordewell/ordewell/blob/main/docs/skills.md) covers the format.

This package also installs `@ordewell/web`, the local API server that the CLI and
terminal UI talk to over `127.0.0.1`. It starts on demand.

## Documentation

Full documentation is at **[ordewell.ai/docs](https://ordewell.ai/docs)**, and the
source is at **[github.com/ordewell/ordewell](https://github.com/ordewell/ordewell)**.

## License

[Apache License 2.0](./LICENSE)
