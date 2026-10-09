# Writing skills

A skill is a folder with a `SKILL.md` file: a short frontmatter block, then
instructions in Markdown. Ordewell uses the [Agent Skills](https://agentskills.io)
format, and one loader serves every skill. The design is recorded in
[ADR-0024](adr/0024-unified-skills.md).

A skill is for one of two audiences:

- A **planner skill** guides the planning conversation: how to interview you,
  how to write a spec.
- A **task skill** guides a runner working on one task: how to write tests,
  how to follow a house style.

## Format

```
my-skill/
  SKILL.md
```

| Field | Meaning |
| --- | --- |
| `name` | Should match the folder name. The **folder name** is the skill's identity: it is what you type as `/name`, what a plan lists, and what `ordewell skills` shows. |
| `description` | What it does and when it applies. Models choose skills from this line, so state when it applies. |
| `applies-to` | `planner` (the default) or `task`. |
| `disable-model-invocation` | `true` means only you can invoke it. |
| `user-invocable` | `false` means only a model can invoke it. |

Leave the two invocation fields out and both you and a model may invoke the
skill. The built-in skills are all user-only.

A planner skill:

```markdown
---
name: threat-model
description: Walk through a threat model before planning work that touches authentication or user data.
---

Before proposing tasks, list the assets involved, who can reach them, and what
could go wrong. Ask about anything you cannot tell from the code.
```

A task skill. Its description states when it applies, because the planner
reads it to decide which tasks get the skill:

```markdown
---
name: migration-safety
description: Attach to tasks that add or change a database migration; not to tasks that only read data or change application code.
applies-to: task
---

Write migrations so they can run twice without error. Never edit a migration
that has already been committed; add a new one.
```

## Scopes and precedence

| Scope | Location | Notes |
| --- | --- | --- |
| global | `~/.ordewell/skills/` | Built-in skills are copied here. You write these; tasks do not. |
| workspace | `<workspace>/.ordewell/skills/` | Committed to git, so a team shares them. |

The rest of `.ordewell/` (plans, sessions, worktrees) stays ignored; only
`skills/` is carved out in `.ordewell/.gitignore`. A `.gitignore` you have
edited yourself is left alone, so if you customised it, add `!skills/` and
`!skills/**` there.

When a global and a workspace skill share a name, **the global one wins**. The
workspace copy is reported as shadowed, so it is never silently lost. Rename
one of them to use both.

Built-in skills are refreshed when you have not edited your copy
([ADR-0021](adr/0021-built-in-skill-seeds-refresh.md)).

## Using a skill in the planner

Type `/name` anywhere in a message to the planner. Your text is kept exactly as
you wrote it; the skill's instructions are sent to the planner with it. The
conversation shows a one-line notice with the skill's name and path. The skill
is saved as it was when loaded, so a resumed or forked conversation hands the
planner the same text even if the file changes later.

A `/word` that names no skill, or a skill that is not user-invocable, is
ordinary text.

When the planner has tools attached, it is also told which model-invocable
planner skills exist (name and description) and can load one itself with the
`load_skill` tool. A skill marked `disable-model-invocation: true` is never
offered to it.

## Attaching task skills

A runner receives a task skill only if it is attached to its task in the plan.
The planner is the only model that attaches them:

- It sees the model-invocable task skills with their descriptions, and is told
  to attach one only where the description says it applies.
- Type `/name` for a task skill and the planner is told to attach it to the
  tasks it fits. Its body is not shown to the planner. For example, `/tdd`
  asks for the built-in `tdd` skill. TDD applies to a task only when that skill
  is attached.
- In VS Code, skills appear as chips on task and subtask cards. Add or remove
  them there; they are locked while the plan executes, like a task's model and
  mode.
- In the TUI, press `K` on a task, or type `/task-skills <id> [a,b|none]`.
- From a shell, run `ordewell task-skills <id> [a,b|none]`. With no names it
  lists the task skills and marks the attached ones.

The TUI and CLI do not lock a running plan: an edit is saved to the plan and
applies the next time the task spawns.

When the task starts, Ordewell puts the skill's text into the task's prompt, so
this works the same on every runner. The skills a task attempt was given are
recorded on the attempt and shown at the top of its task log.

A plan may name a skill that does not exist yet, with a warning, because a
task it depends on may create it. If the name still does not resolve when the
task starts, the task fails before its runner is spawned, and the message lists
the directories searched. Only `applies-to: task` skills can be attached.

A workspace skill that exists but is not committed gets a warning too: tasks
run in git worktrees, which receive only what is committed, so commit its
`.ordewell/skills/<name>/` folder.

In a multi-repo group, the group folder's own `.ordewell/skills/` is read in
place and needs no commit. Each repo's committed `.ordewell/skills/` is read as
checked out in the task's worktree. When names clash, global wins, then the
group folder, then the repos in the order the group lists them.

## Tasks that create skills

A task can write `.ordewell/skills/<name>/SKILL.md` in its worktree. When it is
merged, the skill is part of the workspace, and later tasks in the plan can
have it attached. The task that writes it needs no special handling; it goes
through the same merge gate as any other change
([ADR-0020](adr/0020-ops-tasks-and-merge-gates.md)).

## Listing skills

```
ordewell skills [--workspace /path] [--json]
```

Prints each skill's name, scope, `applies-to`, who can invoke it, and the path
to its `SKILL.md`, then any workspace skill shadowed by a global one. It only
reads; it changes nothing.
