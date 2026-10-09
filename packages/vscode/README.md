# Ordewell for VS Code

**Task orchestration for coding agents.** One goal becomes an ordered plan of tasks,
each on its own runner, model and branch. Read and change the plan before anything
runs, then review the result before it reaches your branch.

![The planning loop](https://raw.githubusercontent.com/ordewell/ordewell/main/assets/readme/vscode-panel-loop.gif)

## Features

- **An editable plan.** Every task carries a runner, model, thinking effort and
  mode. Change any of them, add or remove tasks, and rewire dependencies without
  losing completed work.
- **A planner that talks back.** It researches your workspace without modifying it,
  asks when your goal is vague, and its final message is the plan.
- **The right model for each task.** Assignments are made across the whole plan and
  shown to you before anything runs.
- **Isolated execution.** Each task works in its own git worktree, and passing work
  lands on one integration branch. A handoff card at the end lets you review the
  diff, merge it, or discard it.
- **Verdicts from evidence.** A task completes when the runner reports it done —
  through an attempt-bound `task_complete` call.
- **No extra API key.** Claude Code, Codex or OpenCode can be the planner, using the
  subscription you already have.

## Getting started

1. Install the extension.
2. Open the Ordewell panel from the activity bar.
3. Choose a planner in the planner bar. To plan with an API key instead, set
   `ordewell.openAiApiKey` (OpenRouter) or `ordewell.apiKey` (Gemini), or export
   `OPENROUTER_API_KEY` or `GEMINI_API_KEY`.
4. Type a goal.

Each runner you want to use (Claude Code, Codex or OpenCode) must be installed and
on your PATH. If a runner appears greyed out right after installing it, reload the
window so the extension picks up the new PATH.

Skills are `SKILL.md` folders: type `/name` in the panel to load one into the
conversation, and attach task skills as chips on a task's card. See
[Writing skills](https://github.com/ordewell/ordewell/blob/main/docs/skills.md).

The Command Palette offers **Ordewell: Rewind Conversation**, **Fork
Conversation**, **Compact Conversation** and **Set Parallel Tasks**, and isolation
can be configured under `ordewell.worktreeIsolation` and related settings.

## Also available

The same project ships a command line and a terminal UI:

```bash
npm install -g ordewell
```

## Links

- [Documentation](https://ordewell.ai/docs)
- [Source code](https://github.com/ordewell/ordewell)
- [Report a bug](https://github.com/ordewell/ordewell/issues)

Licensed under the [Apache License 2.0](https://github.com/ordewell/ordewell/blob/main/LICENSE).
The Ordewell name and logos are not covered by this license.
