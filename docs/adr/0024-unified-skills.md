# 0024 — Unified skills: one format, one loader, two audiences

**Status:** accepted

## Context

Ordewell had two things called a skill. The planner's skills were `SKILL.md`
files in `~/.ordewell/skills/`, seeded from the package (ADR-0021) and loaded
by `/name`. The task-side skills were *toggles* (`tdd`, `verify`): a settings
boolean whose only effect was a prompt block. `tdd` was added to every task;
`verify` told the planner, in chat and one-shot planning alike, to append a
final verification task. The two shared a word and nothing else, so a team
could not write a skill for its tasks, share one through git, or have the
planner choose which tasks get one. `/name` also rewrote the user's message
into the skill's body, so the transcript no longer showed what was typed.

## Decision

**One `SKILL.md` format and one loader serve every skill.** The format is the
Agent Skills spec (agentskills.io): a folder with a `SKILL.md`, frontmatter,
then instructions. Ordewell reads `name`, `description`, one field of its own
(`applies-to`) and Claude Code's two invocation fields. The **folder name is the
skill's identity** (`/name`, the names in a plan, `ordewell skills`), and a
frontmatter `name` should match it. A name is lowercase letters, digits, `-` and
`_`, starting with a letter or digit; a folder named otherwise is skipped and
reported by `ordewell skills` rather than listed, and a plan that attaches such
a name gets a warning:

- **`applies-to: planner | task`**, default `planner`. A planner skill is
  instructions for the planning conversation; a task skill is instructions for
  a runner working one task.
- **`disable-model-invocation`** and **`user-invocable`**, Claude Code's
  invocation fields, with its meaning. Unmarked is both: the user may type
  `/name` and a model may invoke it.
- **Every built-in is user-only** (`disable-model-invocation: true`), the new
  `tdd` task skill included. No model sees a built-in in a catalog or can pick
  one on its own; the user opts in.

**Two scopes.** Global `~/.ordewell/skills/` holds the built-in seeds and the
user's own skills, and is written by the user only. Workspace
`.ordewell/skills/` is committed: the `.ordewell/.gitignore` rules ignore the
state directory but carve out `skills/`. Because it is committed, it reaches
every task worktree through git (ADR-0013) and a task can write a skill there
that later tasks use, through the normal worktree → merge gate path
(ADR-0020). **Global wins on a name clash**; the workspace copy is reported as
shadowed rather than dropped silently.

**Planner skills.**
- `/xxx` keeps the user's text verbatim. The skill's body is sent to the
  planner beside it, and the transcript holds a **skill-load entry**: a
  snapshot of the skill as loaded (name, scope, path, body), so a resumed,
  forked or rewound conversation hands the planner what the live one had even
  if the file has changed since. The surface shows a one-line notice with the
  path.
- A token naming no skill, or one with `user-invocable: false`, is plain text.
- The model can invoke a model-invocable planner skill itself through the
  `load_skill` tool on Ordewell's MCP server (ADR-0022). It is tool-only: the
  planner's prompt carries the skill catalog (name and description) only when
  tools are attached, and a planner without them gets no catalog and no
  fallback.

**Task skills.**
- A task skill reaches a runner **only by being attached to a task in the
  plan** (`skills` on the task or subtask). The planner is the only model that
  invokes task skills; it sees a catalog of model-invocable ones and is told to
  attach one only where its description says it applies.
- **Ordewell injects the body into the task prompt at spawn**, so any harness
  works and nothing is written into a runner's own skills directory. A fresh
  attempt resolves the skills where it runs and **snapshots them**: the task
  keeps the latest attempt's snapshot, and on the structured transport, the one
  that keeps a task log, each attempt's log opens with a skills entry naming
  them and their paths, so history shows what that attempt was given. A retry resolves again; a conflict
  repair and a continue add no snapshot, since they resume work that already
  holds the skills.
- Names are checked **leniently at submit, hard at spawn**. An unresolved name
  in a submitted plan or edit is a warning, because a task it depends on may
  create the skill in its worktree. A planner skill on a task is refused. At
  spawn the name is resolved in the task's worktree plus global (in a repo group
  also the group root's folder, read from the main checkout; without worktrees,
  the workspace instead of the worktree); if any does
  not resolve, the task fails before the runner starts and says which names
  and which directories were searched.
- `/tdd` on a task skill is a **directive to the planner**: the entry carries
  no body, and the planner is told to attach the skill to the tasks it fits.
- Skills show as **editable chips** on task and subtask cards in VS Code,
  where they are locked while the plan executes (the same lock as model and
  mode). The TUI sets them from the plan pane (`K`) or `/task-skills`, and the
  CLI with `ordewell task-skills`; those are not locked, and an edit applies
  the next time the task spawns.

**No toggles.** Settings hold no skill switch. TDD applies to a task only when
the `tdd` skill is attached, by the planner or by `/tdd`. The read-only
`ordewell skills` command lists what a workspace sees.

**Workspace skills in a repo group** (ADR-0014). The group root is no
repository, so its own `.ordewell/skills/` is read from the main checkout and
never needs committing; each repo's committed folder is read as checked out in
the task's worktree, or in the workspace when tasks run without worktrees. The
planner's catalog, `/name`, the chips, `ordewell task-skills` and `ordewell
skills` read the same folders, so they list the same skills. Among workspace
folders the group root's wins, then repos in layout order. A workspace skill
attached to a task but not yet committed, when tasks get worktrees, produces a
warning at submit saying which folder to commit.

## Considered options

- **A `tdd` mode toggle** (TDD added to every task). It could not be chosen
  per task, shared or edited by a team, and cost every task a block of prompt
  it did not always need. Replaced by the `tdd` task skill.
- **`verify` as a planner skill.** The toggle told the planner to append a final
  verification task to every plan. Dropped outright, not migrated: Ordewell
  already derives verdicts from the runner's completion evidence, and a team
  that wants the behaviour can recreate it as a user `SKILL.md` in
  `~/.ordewell/skills/` or `.ordewell/skills/` with no code change.
- **Two separate systems** (a planner skill store and a task skill store).
  Two loaders, two formats and two precedence rules for one concept.
- **A `.ordewell-skills/` folder at the workspace root.** A second place to
  look and a second ignore rule, when `.ordewell/` already exists and only
  needed a carve-out.
- **Linking skills into worktrees.** ADR-0013's bootstrap never links
  `.ordewell/`; committing the folder gets the same result through git, with
  history.
- **Workspace wins on a name clash.** A cloned repo could then replace a
  skill the user wrote or edited with its own text. Global wins and the
  shadowed copy is reported.
- **Runners loading task skills mid-task.** Each runner would need its own
  mechanism, or the planner's MCP server would have to be handed to every
  runner. Injection at spawn needs neither. The `load_skill` handler could
  serve runners later without changing the format.
- **Falling back to the exploration envelope for `load_skill`.** The envelope
  is a security boundary (ADR-0008); a new verb on it for skills would widen
  it. A planner without tools gets no catalog instead.

## Relations

[ADR-0008](0008-planner-exploration-envelope.md) (the envelope is unchanged),
[ADR-0009](0009-coding-agents-as-planners.md) (harness planners get skills
through the same tool), [ADR-0013](0013-worktree-isolation.md) (committed
skills reach worktrees through git),
[ADR-0014](0014-multi-repo-workspaces.md) (a repo group's skill folders),
[ADR-0021](0021-built-in-skill-seeds-refresh.md) (seeds still refresh when
unedited), [ADR-0022](0022-ordewell-mcp-server.md) (`load_skill` lives on that
server).

## History

- 2026-10-09 — accepted: one format and loader; planner and task skills; the `tdd` and `verify` toggles dropped.
