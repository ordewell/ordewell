---
status: accepted
implemented: none
amends: ["0049"]
note: "The read half of the desktop app's file and git views (docs/desktop/design.md). The daemon read routes slice implements it."
---

# 0061 — A host reads files and git for the user, confined to the workspace and needing no lease

## Problem

The desktop app
([ADR-0060](0060-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md))
shows the user's repository: an Explorer over the files, a viewer and editor, a
review of each task's diff and of the whole run, the user's own uncommitted
changes, and a commit graph with its branches. All of it is read through the
daemon, because the renderer has no file system and the daemon is the one
process that knows the runs, their worktrees and their integration branches.

Nothing in the daemon reads files or git for a person today. The reads Ordewell
has are the planner's, inside the exploration envelope
([ADR-0008](../planner-envelope/0008-planner-exploration-envelope.md)), which
exists to bound what a model may see and run. The VS Code extension reads a
task's diff in-process with `readTaskDiff` (`taskDiffRead.ts`), and no route
serves it. Two questions follow. Which principal do these reads act for, and so
which rules bound them? And may a host read a session another host holds, which
[ADR-0049](../isolation/0049-a-session-has-one-live-host.md) leaves out of scope
beyond what `GET /api/sessions/:id` serves from the file?

## Decision

**The daemon serves file and git reads to the user principal, the bearer of its
token, under their own rules and not the planner envelope's (R1). It reads
three scopes per repository: the user's checkout, a run's integration branch,
and a task's worktree (R2). Every path is confined to its scope's root by the
rules `readTaskDiff` already keeps, with `.ordewell/skills/` the one visible
part of `.ordewell` (R3). None of these reads needs the session lease (R4), and
every answer is bounded and typed (R5) and runs git read-only (R6).**

## Key properties

- **The user principal (R1).** The routes are admitted by the daemon's bearer
  token like every other route, and act for the person at the surface. No
  planner tool, MCP tool, research subagent or script reaches them, and they
  neither use nor widen the envelope of ADR-0008. One core module (the
  *workspace reader*) owns them, separate from `dirListing` and the research
  tools, so a change to what a planner may read cannot move what a person sees,
  and the other way round.
- **Three scopes per repository (R2).** A read names its *view scope*:
  `checkout` (the user's own working tree on disk, for a repository of the
  workspace); `integration` with a session (the run's integration branch, read
  from git objects, since it has no worktree); or `task` with a session and a
  task (the task's worktree on disk while it exists, otherwise its task branch
  in git objects). A scope that no longer exists, such as a pruned worktree with
  a deleted branch or a discarded run, answers a typed `gone` naming why. It
  never falls back to another scope.
- **Confined to its scope (R3).** A path is relative and passes `allowedPath`
  (`packages/core/src/services/taskDiffRead.ts`): not empty, not absolute, no
  drive letter, and no `..`, `.git` or `.ordewell` segment. On disk, its
  `realpath` must also stay inside the scope root, so a symlink pointing out of
  the workspace is listed as a link and not followed. The one exception is
  `.ordewell/skills/`, which is committed by design
  ([ADR-0024](../planner/0024-unified-skills.md)) and is shown, and in the
  checkout edited, like any other committed file. The rest of `.ordewell`
  (sessions, worktrees, state) and every `.git` are never listed or read. Files
  git ignores are listed and marked as ignored, not hidden.
- **No lease needed (R4).** A read changes nothing, so it does not take or need
  the session lease, as L5 already lets reads of git through. An `integration` or `task`
  scope is resolved from the session's saved isolation record on disk, without
  adopting the session. A host can therefore show the files, diffs and branches
  of a session another host holds, alongside what `GET /api/sessions/:id`
  serves.
- **Bounded and typed answers (R5).** A tree is listed one directory at a time.
  A file answers its text, or a typed `binary` or `too-large` with its size
  (the cap is a tuning value), never a silently cut text. A log is paged by
  cursor. A diff answers its list of changed files first, and each file's patch
  on request. Every answer names the commit or the on-disk state it was read
  at, so a later write can say what it saw.
- **Read-only git (R6).** These reads run git with `GIT_OPTIONAL_LOCKS=0`, so a
  status never takes the index lock from a user's own git or a run's landing,
  and with no hooks. They never fetch. A remote-tracking branch is shown as of
  the last fetch, which the user starts
  ([ADR-0062](../isolation/0062-user-git-actions-are-confirmed-at-a-host-and-a-live-run-holds-only-its-landing-branch.md)).

## The routes

Every route takes `workspace` and, where it applies, `repo` (a repository path
relative to the workspace, `.` for the root) and the view scope (`scope`, with
`sessionId` and `taskId` as it needs).

| Method and path | Answers |
|---|---|
| `GET /api/files/tree` | One directory's entries: name, kind, ignored, git status. |
| `GET /api/files/content` | A file's text and its hash, or `binary` / `too-large` / `gone`. |
| `GET /api/files/find` | Paths matching a name query, for quick open. |
| `GET /api/git/repos` | The workspace's repositories, with each one's branch, upstream, ahead and behind, and whether it is detached. |
| `GET /api/git/status` | The checkout's staged, unstaged, untracked and conflicted files. |
| `GET /api/git/diff` | A file list, or one file's patch: staged, unstaged, or between two refs. |
| `GET /api/git/log` | A page of commits with parents and refs, for the commit graph. |
| `GET /api/git/commit` | One commit's message, author and changed files; its patch per file. |
| `GET /api/git/branches` | Local and remote-tracking branches, marking those Ordewell created and any a live run lands on. |
| `GET /api/plans/:sessionId/tasks/:taskId/diff` | A task's diff, as `readTaskDiff` reads it for VS Code. |

The run's whole diff stays on the existing `GET /api/plans/:sessionId/isolation/diff`.

## Testing decisions

- Confinement is tested on the workspace reader, with no daemon: every
  `allowedPath` refusal; a symlink out of the scope root; `.ordewell/skills/`
  shown and the rest of `.ordewell` refused; `.git` refused at any depth.
- Each scope is tested against a real repository: a checkout, an integration
  branch with no worktree, a task worktree, and the same task after its
  worktree is pruned, which reads from the branch, then `gone` once the branch
  is deleted too.
- A read of a session another host holds is tested to answer from the record
  without taking the lease.
- The routes are tested through the daemon's app, as the other routes are.

## Out of scope

- Search across file contents. Quick open matches names only.
- Watching the file system and pushing changes. A surface reads again on a
  run's frames and on focus.
- Anything that writes: that is
  [ADR-0062](../isolation/0062-user-git-actions-are-confirmed-at-a-host-and-a-live-run-holds-only-its-landing-branch.md).

## Considered options

- **Serve the reads through the planner envelope.** Rejected: the envelope
  bounds a model, which may not read outside the workspace or past its
  allowlist and is refused shapes a person needs. Reusing it would tie what a
  person can see to a security boundary built for something else. A change to
  either would move the other.
- **Electron main reads the file system and git itself.** Rejected: the daemon
  is the one process that knows the runs, their worktrees and their branches,
  and it holds the interlock of ADR-0062. Reads in main would be a second
  implementation, one per client, with confinement checked twice. Main still
  hands a file to the user's editor, which needs no read.
- **Hide all of `.ordewell`.** Rejected: `.ordewell/skills/` is committed and
  reviewed like source (ADR-0024), and a person editing a skill should not need
  another tool.
- **Show all of `.ordewell`.** Rejected: sessions, worktrees and state are
  Ordewell's own records, and a worktree under it is better read as its task's
  scope, which knows what the task is.
- **Require the lease to read a held session's files and diffs.** Rejected: a
  read changes nothing, L5 already lets git reads through, and refusing would
  leave a second window blind to a run it can see the plan of.

## Consequences

- The daemon gains a module and a set of routes whose bound is the user's, not
  the planner's. A review of a change to either names which one it touches.
- A held session's diffs and branches are visible from another host. Its
  in-memory progress is not, beyond the saved file.
- `readTaskDiff` becomes reachable over the daemon. Its path rules are now the
  confinement for every user read, so a change to them changes both.

## History

- 2026-11-03 — accepted.
