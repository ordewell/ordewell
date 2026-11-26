<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/logo-dark.png">
    <img src="assets/readme/logo-light.png" width="380" alt="Ordewell">
  </picture>
</p>

<p align="center">
  Ordewell is an open-source tool that turns one goal into a plan of tasks that
  your coding agents run in parallel, for you to review and merge.
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/how-it-works-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/how-it-works-light.svg">
    <img src="assets/readme/how-it-works-light.svg" width="800" alt="One goal becomes a plan you can edit. Its tasks run in parallel, each on its own agent, such as Claude Code, Codex or OpenCode, and its own git branch, and each passes only on evidence. Then you review and merge.">
  </picture>
</p>

| Use it in | Install |
|---|---|
| Desktop app | [Download for macOS, Windows or Linux](https://ordewell.ai/download) |
| Terminal | `curl -fsSL https://ordewell.ai/install.sh \| sh` (macOS and Linux; on Windows, [use npm](#install-the-terminal-app)) |
| VS Code | `code --install-extension ordewell.ordewell` |

**You need** a coding agent you already use, such as Claude Code or Codex,
installed and signed in, or a provider API key. No Ordewell account or key.

## What happens on your first run

1. Open your project in Ordewell. It shows the coding agents it found and
   whether each is signed in; choose a planner and runners, then type a goal.
2. The planner reads your repository without changing it, asks what is vague and
   writes a plan: tasks with dependencies, each with its own agent and model.
3. You edit the plan, then run it. Independent tasks run side by side; in a git
   repository, each on its own branch in its own worktree.
4. A task passes only on evidence: its agent's report, or a script's clean exit.
   You read the diff, then merge the run into your branch or discard it.

Use it in the [desktop app](#download-the-desktop-app), the
[terminal](#install-the-terminal-app), [VS Code](#vs-code) or the command line.
All of them drive the same plans, runners and settings. This README describes 0.14.14; see the
[published releases](https://github.com/ordewell/ordewell/releases) for the
versions you can install and their release notes.

<p align="center">
  <a href="https://ordewell.ai"><strong>Website</strong></a> ·
  <a href="https://ordewell.ai/docs">Documentation</a> ·
  <a href="https://ordewell.ai/news">News</a>
  <br>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
  <a href="https://www.npmjs.com/package/@ordewell/cli"><img src="https://img.shields.io/npm/v/@ordewell/cli" alt="npm"></a>
  <a href="https://github.com/ordewell/ordewell/actions/workflows/ci.yml"><img src="https://github.com/ordewell/ordewell/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

## Why Ordewell

1. **A plan you can edit.** Change any task's prompt, dependencies, agent,
   model, effort or mode before it runs. The desktop app shows the plan as a
   list or as a graph.
2. **Every task picks its own agent.** Claude Code, Codex, OpenCode, Pi, GitHub
   Copilot CLI, Qwen Code, Cline, Gemini CLI and Cursor mix freely in one plan,
   and a signed-in agent needs no extra API key. A provider API key adds the
   built-in runner, which needs no coding agent installed
   ([planners and runners](docs/planners-and-runners.md#the-built-in-runner)).
3. **Parallel, without the pile-up.** Dependent tasks wait for the work they
   need, and a merge conflict gets a repair attempt before you are asked.
   Without a git repository, tasks share your folder.
4. **Done means evidence.** A clean exit with no report is a failure, and no
   second model decides. Check-and-fix loops repeat a check and its fix until
   it passes or reaches its round limit.
5. **Your call on autonomy.** By default you run the plan, answer
   checkpoints and merge. Turn on autorun, automatic merging and an Act
   supervisor, and it runs and merges on its own; a merge conflict leaves your
   tree untouched and waits for you.

## Features

<table>
  <tr><td><b>More than code</b></td><td>Plan read-only research, operations and consented scripts alongside code tasks.</td></tr>
  <tr><td><b>Run controls</b></td><td>Watch tasks live, review their reports and choose whether to automate execution or merging.</td></tr>
  <tr><td><b>Worktree isolation</b></td><td>Run code tasks in separate git worktrees, then review and merge their changes. A worktree keeps changes apart, not access: see <a href="SECURITY.md#what-a-tasks-agent-can-reach">what a task's agent can reach</a> and <a href="https://ordewell.ai/docs#isolation">isolation and handoff</a>.</td></tr>
  <tr><td><b>Usage limits</b></td><td>Tasks pause when an agent hits its account limit. Resume later or move unfinished work to another agent.</td></tr>
  <tr><td><b>Planner choices</b></td><td>Plan with a supported coding agent without an extra API key, or use an API provider. The planner reads your repository; changes run through tasks in the plan.</td></tr>
  <tr><td><b>Interfaces</b></td><td>Use the desktop app, terminal UI, VS Code extension, CLI or local API.</td></tr>
  <tr><td><b>Skills</b></td><td>Share your team's instructions in repository skills that the planner attaches to tasks across runners.</td></tr>
</table>

## Download the desktop app

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/desktop-run-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/desktop-run-light.png">
    <img src="assets/readme/desktop-run-light.png" width="900" alt="The Ordewell desktop app showing a plan graph of six tasks in three stages. The three stage 1 tasks are running side by side, on Claude Code, Codex and GitHub Copilot CLI, each with its own model and effort; the later stages wait for them. The plan list sits on the right.">
  </picture>
  <br>
  <sub>The Ordewell desktop app.</sub>
</p>

Get the installer for your computer from [ordewell.ai/download](https://ordewell.ai/download),
or straight from the latest release:

| OS | Download |
|---|---|
| macOS, Apple silicon | [Ordewell-mac-arm64.dmg](https://github.com/ordewell/ordewell/releases/latest/download/Ordewell-mac-arm64.dmg) |
| macOS, Intel | [Ordewell-mac-x64.dmg](https://github.com/ordewell/ordewell/releases/latest/download/Ordewell-mac-x64.dmg) |
| Windows | [Ordewell-win-x64.exe](https://github.com/ordewell/ordewell/releases/latest/download/Ordewell-win-x64.exe) |
| Linux | [Ordewell-linux-x64.AppImage](https://github.com/ordewell/ordewell/releases/latest/download/Ordewell-linux-x64.AppImage) or [Ordewell-linux-x64.deb](https://github.com/ordewell/ordewell/releases/latest/download/Ordewell-linux-x64.deb) |
| Checksums | [SHA256SUMS](https://github.com/ordewell/ordewell/releases/latest/download/SHA256SUMS) |

Or install it with one command, which picks the right installer and checks it
against the release's checksums before installing:

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/ordewell/ordewell/main/scripts/install/desktop.sh | sh

# the terminal app and the desktop app together
curl -fsSL https://ordewell.ai/install.sh | sh -s -- --desktop
```

```powershell
# Windows (PowerShell 5.1 or 7)
irm https://raw.githubusercontent.com/ordewell/ordewell/main/scripts/install/desktop.ps1 | iex
```

With a package manager, once the release has been published there:

```bash
brew install --cask ordewell/tap/ordewell-desktop   # macOS
winget install Ordewell.Ordewell                    # Windows
```

Official macOS installers are signed with a Developer ID and notarized by
Apple. The Windows installer is signed by **Alessandro Costanzo Ciano**.
macOS and Windows builds support in-app updates; Linux updates by installing
the next release. Windows SmartScreen may still warn while the new certificate
builds reputation. The [desktop guide](docs/desktop/README.md#install) covers
each platform, checksums and updates.

winget's first submission is waiting on Microsoft's review; the installer
above works until it is available. The desktop app needs no Node.js.

## Install the terminal app

```bash
# macOS and Linux: a standalone binary, no Node.js needed
curl -fsSL https://ordewell.ai/install.sh | sh

# Homebrew
brew install ordewell/tap/ordewell

# npm: Windows, Alpine Linux, or if you prefer it (Node.js 20.3 or newer)
npm install -g ordewell
```

`ordewell update` upgrades Ordewell however you installed it. To see the
installer's options, such as another folder or uninstalling, run
`curl -fsSL https://ordewell.ai/install.sh | sh -s -- --help`.

**On Windows**, install with npm. [Git for Windows](https://gitforwindows.org/)
is required. The terminal UI runs natively; its mouse and paste need Node.js
22.17 or newer. See the [platform notes](https://ordewell.ai/docs#platforms).

### VS Code

Install Ordewell from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=ordewell.ordewell).
In Cursor, Windsurf or VSCodium, get it from [Open VSX](https://open-vsx.org/extension/ordewell/ordewell).

### Requirements

A [supported coding agent](https://ordewell.ai/docs#runners), installed and
signed in, or a provider API key for the built-in runner. git is optional; 2.38
or newer is recommended: tasks then run in their own worktrees. Without it, they
run directly in your folder. Each commit Ordewell writes ends with a
`Planned-with: Ordewell` trailer, on by default: `ordewell trailer off` turns it
off and `ordewell trailer on` back on. The first merge that would write it says
so once, in its confirmation. A commit an agent made itself gets none.

## Quick start

**Desktop app:** open Ordewell, choose **Open folder…** (or drop your project
folder on the window), then type a goal in the planner. The welcome window shows
which agents it found and whether each is signed in. See the
[desktop guide](docs/desktop/README.md).

**Terminal:** run `ordewell` in your project to open the terminal UI, then type a
goal. It finds your installed coding agents and plans with the first one signed
in, so there is nothing to set up; `/planner` and `/runners` change the choice.

**VS Code:** open your project folder and the Ordewell panel, then type a goal.
See the [extension guide](packages/vscode/README.md) for setup.

Ordewell also supports [command-line workflows](https://ordewell.ai/docs#first-plan)
for scripting.

Tried it? [Tell us how your first run went](https://github.com/ordewell/ordewell/discussions/115).

## How it works

A run follows the steps of [your first run](#what-happens-on-your-first-run).
Autorun and automatic merging are off by default. During planning, research tasks
can start before you run the plan, and script tasks can run with consent under
your run settings. See [run settings](https://ordewell.ai/docs#run-settings).

The planner only reads; tasks run as you, in the mode the plan assigns. In Full
and Guarded a task's agent can reach what you can, Ordewell's own daemon
included; read-only tasks run sealed. See
[SECURITY.md](SECURITY.md#what-each-part-can-touch) for what each part can touch
and [what a task's agent can reach](SECURITY.md#what-a-tasks-agent-can-reach).
Without a git repository or with isolation disabled, tasks share the workspace;
some files can also be shared between worktrees. See
[isolation and handoff](https://ordewell.ai/docs#isolation) for details.

## Documentation

The [documentation](https://ordewell.ai/docs) covers the planner options, skills,
commands, configuration and platform notes. The [desktop guide](docs/desktop/README.md)
covers installing the app, its window and its settings. Design decisions,
including the options that were rejected, are recorded as
[architecture decision records](docs/adr/), and [CONTEXT.md](CONTEXT.md) defines
the project's vocabulary. For how the planner and the runners each get their
models and credentials, see [planners and runners](docs/planners-and-runners.md).
To write your own planner or task skills, see the [skills guide](docs/skills.md).
If Codex's sandbox cannot start on your machine, see
[troubleshooting](docs/troubleshooting.md). For the experimental container mode,
off in published versions, see [running tasks in containers](docs/containers.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the
build order and project layout, and report security issues through
[SECURITY.md](SECURITY.md) rather than the public tracker.

Good places to start are the issues labelled
[good first issue](https://github.com/ordewell/ordewell/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
and the [runner integrations](https://github.com/ordewell/ordewell/issues?q=is%3Aopen+label%3A%22runner+integration%22)
that are open for help.

## Acknowledgements

The grilling, spec, architecture and TDD skills are
adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT).

## What Ordewell sends

Ordewell checks for updates daily, sending its version and a random install ID
to ordewell.ai after a one-time notice, and nothing else. The desktop app sends
the same daily check. When the answer names a newer release, the desktop app,
the terminal UI, VS Code and terminal commands say so until you update.
`ordewell update` and `/update` run the update; they send nothing to
ordewell.ai. To turn the check off, set `ORDEWELL_NO_VERSION_CHECK=1` or
`DO_NOT_TRACK=1`, turn off **Check for new versions** in the desktop app's
Settings, or turn off VS Code's telemetry for the extension. See
[version check details](https://ordewell.ai/docs#version-check).

The first time a run on your machine ends with every task passed, the terminal
UI, the desktop app or VS Code asks once how it went, with links to the
[feedback discussion](https://github.com/ordewell/ordewell/discussions/115) and
the repository. It sends nothing: a browser opens only if you pick a link. It is
recorded in `~/.ordewell/first-run-feedback.json`, so it never appears again on
that machine, and never in CI or a headless command. Set
`ORDEWELL_NO_FEEDBACK_NOTICE=1` to turn it off.

A signed desktop build downloads its own updates from GitHub Releases, and
contacts GitHub only when you ask: when you press **Update** or choose **Check
for updates…**. See the
desktop guide's [updates](docs/desktop/README.md#updates).

To show each model's context size, prices and capabilities, Ordewell fetches the
public model catalog from [models.dev](https://models.dev), a plain request
that carries no data about you or your work. Set `ORDEWELL_NO_MODELS_DEV=1` to
turn it off; a snapshot bundled with Ordewell is used instead.

Ordewell is pre-1.0, so minor releases can include breaking changes. Read the
[changelog](CHANGELOG.md) before you upgrade.

## License

Ordewell is licensed under the [Apache License 2.0](LICENSE). The Ordewell name and
logos are not covered by this license; see [NOTICE](NOTICE).
