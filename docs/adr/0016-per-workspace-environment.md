# 0016 — Per-workspace environment for the planner and agents

**Status:** accepted

The daemon, and the VS Code extension host, take their environment once, from
whatever started them. Every planner turn and task agent inherits it. That is
right for credentials a user exports in their login shell, and wrong for
anything a project sets for itself: a `CLAUDE_CONFIG_DIR` in a project's
`.envrc` selects which Claude Code account works on that project, and it was
silently lost whenever Ordewell started anywhere but a shell already inside the
project — a desktop launcher, a daemon running for another workspace, or a
shell where direnv had blocked an edited `.envrc`. Agents then ran on the wrong
account with nothing said. Structured connectors launch runners directly,
so the user's direnv hook never fires for them.

## Decision

**Each spawn — every task agent and every harness planner — resolves its
workspace's own variables from its working directory and runs with them on top
of the daemon's environment.** A task worktree
(`<root>/.ordewell/worktrees/<run>/<task>/<rest>`) is resolved as the directory
it stands for in the user's checkout (`<root>/<rest>`): direnv allows an
`.envrc` at its own path only, and the copy linked into a worktree is a path it
has never been told about.

Two sources, the second winning:

1. **direnv**, when installed: `direnv export json` in the spawn's directory,
   with the daemon's own `DIRENV_*` state removed so the answer is a fresh load
   rather than a diff against wherever the daemon was started. direnv's allow
   list stays the gate: a blocked `.envrc` is never loaded, and Ordewell warns
   once per run that tasks start without it and how to allow it.
   `ORDEWELL_DIRENV=false` turns this source off.
2. **`.ordewell/env`**, the nearest one up from the directory: dotenv lines,
   for projects without direnv or variables that belong to Ordewell alone.
   `.ordewell/` is git-ignored by Ordewell; a file git nevertheless tracks is
   ignored with a warning.

The connector's launch environment wins over both. Built-in manifests have
no `env` field or terminal invocation templates (ADR-0025). Completion summaries
come from `task_complete`; transcript discovery is not the completion path.

## Security

The harness planner runs with the exploration envelope of
[ADR-0008](0008-planner-exploration-envelope.md), before the user has approved
anything, so what reaches its environment must not be choosable by the
repository being planned:

- direnv only exports what the user explicitly allowed.
- A tracked `.ordewell/env` is ignored, so cloning a repository cannot supply
  one.
- The variables refused for settings writes (`SETTINGS_ENV_REFUSED`: dynamic
  loaders, runtime options, executable paths, Ordewell's approval and settings
  paths) are refused here too, from both sources, and named in a warning.
  `PATH` is among them; agents keep the PATH Ordewell resolves for them.

## Rejected

- **A `runnerEnv` setting.** Settings are global to the machine, and this is
  exactly the configuration that differs per project.
- **Launching runners through an interactive login shell** so the user's direnv
  hook fires. It would run every shell start-up file for every task, and still
  miss the planner, which is not spawned through a shell.
- **Loading `.envrc` without direnv.** An `.envrc` is a shell script; running it
  outside direnv's allow model would execute repository code unasked.

## History

- 2026-10-09 — aligned with [ADR-0025](0025-structured-only-runners.md).
