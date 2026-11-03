---
status: accepted
implemented: none
amends: ["0013", "0014", "0042", "0049"]
note: "The write half of the desktop app's file and git views (docs/desktop/design.md). The daemon git-action routes and interlock slice implements G1 to G9, the checkout changes and terminal slices G10 and G11."
---

# 0062 — User git actions are confirmed at a host, and a live run holds only its landing branch

## Problem

The desktop app
([ADR-0060](../surfaces/0060-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md))
lets a person edit files in their checkout and run everyday git on it: stage,
commit, discard, branch, stash, and fetch, pull and push. They do this while
Ordewell runs a plan in the same repositories. Until now Ordewell has not
touched the user's own branch or tree except through Merge all
([ADR-0013](0013-worktree-isolation.md)). It never moves a user's checkout
([ADR-0042](0042-merge-all-lands-only-on-the-branch-the-run-started-on.md)),
never resets a user branch ([ADR-0014](0014-multi-repo-workspaces.md)), and
does no remote operation (ADR-0013).

Those rules were written about what Ordewell does on its own account. A person
asking a host to commit or switch branch is different: the action is theirs,
asked for in the moment. It still meets the runs. A run lands on the branch it
started on, and Merge all refuses a repository that has moved off it
(`wrong-branch`, ADR-0042), so a person switching away mid-run would strand the
run's work. And a Merge all into a tree with uncommitted edits to the same
files aborts with nothing explained beyond the abort.

The questions are which actions a host performs for a person, how a destructive
one is consented to, what a live run may refuse, and where those actions are
recorded.

## Decision

**A host performs a fixed set of git actions and file saves on the user's
checkout only, at the user's request only (G1, G2). Each destructive or remote
action carries a confirmation the route checks against the current state (G3),
amends are limited to unpushed commits (G4), and every action runs with the
user's own git (G5). An action that touches a live run's landing branch is
recorded in that session's timeline (G6). A live run refuses only switching
away from, or deleting, its landing branch (G7). Merge all is preceded by a
preflight that offers to set aside the user's overlapping edits (G8). A dirty
start stays the existing escalation (G9). Editing is confined to the checkout
(G10), and a terminal is a person's own shell, outside the interlock (G11).**

- The v1 action set: save a file; stage and unstage files and hunks; commit, and
  amend while unpushed; discard; create, switch and delete a branch; stash and
  pop; fetch, pull and push to the tracking remote. Arbitrary merge, rebase and
  pull requests are later.
- Nothing here is forced: no force push, no `reset --hard`, no `branch -D` of
  unmerged work without its confirmation naming it, no `clean`.

## Key properties

- **The user's checkout only (G1).** Every action targets a repository of the
  workspace in its own working tree. A task worktree under `.ordewell/worktrees`,
  an integration branch, a task branch and any branch Ordewell created
  (`ordewell/*`) are refused as a target, and a branch create may not take a
  name under `ordewell/`. Those are a run's, and they change only through the
  run's own commands.
- **The user's request only (G2).** These routes are reached by a surface
  acting for the person, with the daemon's bearer token. They are not
  `ExecutionCommands`. No planner, MCP tool, supervisor or script task reaches
  them, so no plan can ask for a commit, a push or a branch switch through
  them.
- **Confirmed against what was seen (G3).** A destructive or remote action
  carries a `confirm` object echoing what the person was shown: discard
  `{ files }`, branch delete `{ branch, unmerged }`, push and pull
  `{ remote, branch }`, amend `{ head }`. The route compares the echo with the
  state at that moment and refuses with `confirm_stale`, naming the difference,
  when they differ. This follows how `revert_task` takes `confirmed` and the
  `seen` digest, and how Merge all takes `pastChecks`. A confirmation is never
  implied by a flag the surface sets on its own.
- **Amend only while unpushed (G4).** Amend is offered, and accepted, only when
  `HEAD` is on no remote-tracking branch. Rewriting a pushed commit is out of
  scope.
- **The user's own git (G5).** Actions run the user's `git` with their
  configuration, hooks, signing and credential helpers, in the repository's own
  directory, with `GIT_TERMINAL_PROMPT=0` so a missing credential fails with
  git's message instead of hanging. A failure is answered with git's own text.
  [ADR-0028](../planner-envelope/0028-planners-never-run-repository-config.md)
  is about planners and does not apply: this is the person's own action, as if
  typed.
- **Recorded where a run can see it (G6).** An action on a repository whose
  checked-out branch is a live run's landing branch (a commit, a pull, a stash,
  a discard, a save) adds one line to that session's timeline, naming the
  action, the repository and the branch. When this daemon holds the session the
  line goes through the Session. When another host holds it, the line is
  appended to `user-actions.jsonl` in the session's directory under
  `withFileLock`, and the holder folds it in. Any other action is recorded by
  git itself (its history and reflog), and a discard, which git does not
  record, by nothing.
- **A live run holds only its landing branch (G7).** A run's *landing branch* in
  a repository is the `baseBranch` of an open isolation run. A run is *live*
  while it has an attempt in progress, a start pending, or a landing or Merge
  all under way. While a run is live, switching that repository away from its
  landing branch, detaching it, and deleting that branch are refused with
  `landing_branch_held`, naming the session, the run and the branch. Everything
  else is allowed: committing on it, pulling into it, stashing, discarding, and
  other branches and repositories. Once the run settles with work not yet
  merged, a switch is allowed with a warning that Merge all will refuse until
  the branch is back (ADR-0042's `wrong-branch` stays the backstop). A run that
  started detached names no branch and so holds nothing. The judgement spans
  hosts: the daemon reads every session's lease and isolation record on disk,
  as well as its own pool. It cannot hold against a terminal or another git
  client, which ADR-0042 still catches at Merge all.
- **A preflight before Merge all (G8).** Before Merge all a surface asks for the
  preflight. For each repository it lists the branch it lands on, the user's
  uncommitted files that overlap the incoming work, and whether other
  uncommitted files exist. With an overlap the surface offers three choices.
  *Commit* opens the commit box with those files staged. *Stash* stashes only
  the overlapping paths, under the message
  `ordewell: before Merge all of <run>`, and offers to pop them after the
  merge. *Cancel* does nothing. ADR-0013's abort on a dirty overlap stays the
  backstop for anything that changes between the preflight and the merge.
- **A dirty start is an escalation (G9).** A run that cannot start isolated on
  a dirty tree is the existing `blocked-run` escalation
  ([ADR-0053](../supervision/0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)),
  answered with Stash and continue or Run without isolation. A host shows it as
  any other escalation and adds no action of its own.
- **Editing only in the checkout (G10).** A file is saved only in the user's
  checkout, under the read rules of
  [ADR-0061](../surfaces/0061-a-host-reads-files-and-git-for-the-user-confined-to-the-workspace.md)
  (R3), and only with the hash of the content it was read at. A file that has
  changed on disk since is refused as `stale`, and the surface offers to compare
  or reload. Worktrees and integration branches are view-only. *Open in editor*
  hands the file to the user's own editor through the operating system, in the
  surface's process, and needs no route.
- **A terminal is the person's own shell (G11).** A terminal is a PTY the
  surface's own process starts, never the daemon. It opens in the user's
  checkout by default. It opens in a task's worktree only while that task is not
  running, because a shell in a running task's tree would race its runner. A
  task that starts later does not kill the shell; the terminal shows a banner
  naming it. What is typed there is outside the interlock and the timeline,
  like any terminal the person opens themselves. ADR-0042 and ADR-0013's
  preflight catch its effects on a run.

## The routes

Every route takes `workspace` and `repo`, and answers the repository's new
state (ADR-0061's `GET /api/git/repos` row for it).

| Method and path | Body | Confirm |
|---|---|---|
| `PUT /api/files/content` | `path`, `text`, `baseHash` | — |
| `POST /api/git/stage` | `paths` or `hunks` | — |
| `POST /api/git/unstage` | `paths` or `hunks` | — |
| `POST /api/git/commit` | `message`, `amend?` | `{ head }` when amending |
| `POST /api/git/discard` | `paths` or `hunks` | `{ files }` |
| `POST /api/git/branch` | `name`, `from?`, `switch?` | — |
| `POST /api/git/switch` | `branch` | — |
| `POST /api/git/branch-delete` | `branch` | `{ branch, unmerged }` |
| `POST /api/git/stash` | `paths?`, `message?` | — |
| `POST /api/git/stash-pop` | `stash` | — |
| `POST /api/git/fetch` | — | — |
| `POST /api/git/pull` | — | `{ remote, branch }` |
| `POST /api/git/push` | — | `{ remote, branch }` |
| `GET /api/plans/:sessionId/isolation/merge-preflight` | — | — |

A refusal is one of `landing_branch_held`, `confirm_stale`, `stale`,
`not_checkout`, `ordewell_branch`, `pushed` (an amend of a pushed commit), or
`git_failed` with git's text. The stash route never stashes the whole stack's
top by position: it names the stash it made, and pop takes that name.

## Testing decisions

- The interlock is a pure function of the open runs, their landing branches,
  their liveness and the action. It is tested as a table: a switch, a detach
  and a delete under a live run; the same once settled with unmerged work; a
  detached start; another repository; another branch.
- Each route is tested against a real repository through the daemon's app: the
  confirmation round trip, including `confirm_stale` after the state moves; a
  refused `ordewell/*` target; an amend of a pushed commit.
- Recording across hosts is tested with two daemons on one session: the
  non-holder's line lands in `user-actions.jsonl` under the lock and appears in
  the holder's timeline.
- The preflight is tested with an overlap, with other dirty files only, and with
  a clean tree. The stash it makes is tested to hold only the overlapping
  paths.

## Out of scope

- Merging or rebasing arbitrary branches, pull requests, and force pushes.
- Picking a remote or a branch to push to other than the tracking one.
- Holding the landing branch against the terminal or other git clients.
- Recording a discard anywhere.
- Line comments as a store of their own. A review comment is sent to the task as
  a message quoting the file and line
  ([ADR-0023](../runners/0023-messages-reach-a-running-task.md)).

## Considered options

- **Lock the whole run strictly.** Refuse every git action on a repository a
  live run lands in. Rejected: the person cannot commit unrelated work, pull,
  or stash for the length of a run, which may be hours, and most of it does not
  touch what the run will merge.
- **Warn only.** Allow every action, a switch away included, with a warning.
  Rejected: a switch away strands the run at Merge all, and the person who
  clicked through the warning learns that only at the end. The one action that
  breaks a run is worth refusing; the others are not.
- **Let the plan ask for git actions.** Expose them as execution commands, so
  a planner or supervisor could commit or push. Rejected: a push is an effect
  outside the machine, and a plan's effects go through ADR-0035's consent for
  the plan. These are the person's own hands.
- **Run actions with Ordewell's hardened git** (`NO_HOOKS`, a clean
  environment). Rejected: the person's commit hooks, signing and credentials are
  part of what committing means to them. A commit that skips them is not the
  commit they asked for.
- **Record every action in the timeline.** Rejected: a timeline is a run's
  story, and an action on another branch or repository is not part of it. Git
  already records it.
- **Edit in worktrees too.** Rejected: a task's worktree is its runner's, and
  an edit there is either lost at the task's end or lands as the task's work
  without being its own.

## Consequences

- ADR-0013's *no remote operation* and ADR-0014's and ADR-0042's *never moves
  or resets a user's branch* become rules about Ordewell acting on its own
  account. A person's action through a host is outside them, bounded instead by
  G1 to G7.
- A session's directory can be written by a host that does not hold it, but
  only to `user-actions.jsonl` and only under its lock. Every other write still
  needs the lease
  ([ADR-0049](0049-a-session-has-one-live-host.md) L5).
- A switch refused mid-run names its run, so the person knows what to stop or
  wait for. The refusal only covers the routes, not git itself.
- A discard leaves no record anywhere. Its confirmation names the files, and
  that confirmation is the only safeguard.

## History

- 2026-11-03 — accepted.
