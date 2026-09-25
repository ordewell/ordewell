# 0014 — Multi-repo workspaces: isolate a repo group, land it atomically

**Status:** accepted — amends [ADR-0013](0013-worktree-isolation.md)

**Amends:** ADR-0013 (worktree isolation), which assumed the workspace is one git repository.

Worktree isolation is available only when the workspace is a git repository.
Many users open a plain folder that holds several independent repositories — any
number of them, under any names — and for them isolation reports `not-git` and
every task runs in the shared root, with all the overlap problems ADR-0013 was
written to remove. Making the workspace's parent a repository is not an answer:
the repositories are independent, with their own history and remotes.

A second case is worse than unavailable. A workspace that *is* a repository and
contains further repositories that are not submodules isolates the outer one
only. Each task worktree is a checkout of the outer repository, where those
nested directories are untracked and absent, so a task that needs them either
cannot see them or is linked to the live ones and edits them unreviewed, while
the run's handoff claims to describe the whole workspace.

This ADR records the design for both. It was built in slices; the *As
implemented* sections below say where each one sharpened the design or
deviated from it.

## Decision

**A workspace is a repo group, and isolation runs over the group.** A repo group
is the set of git repositories isolated together for one workspace. A workspace
that is one repository is a group of one, with the repo at path `.`; there is one
code path, not a single-repo path and a multi-repo one.

### Supported layouts

- **A folder that is not itself a git repo, with git repos directly inside it.**
  One level down, auto-detected. Together they form the group.
- **Deeper repos** are included only when listed in a new `workspaceRepos`
  setting, as paths relative to the workspace. Auto-detection does not look past
  one level: a scan of the whole tree would visit every dependency folder, and a
  repo that deep is as likely to be a vendored clone as a project.
- **A workspace that is itself a repo and contains nested repos that are not
  submodules is refused**, with the inactive reason `nested-repos`. The refusal
  names them. Looking for them stops two levels below the root and skips `.git`,
  `.ordewell`, `node_modules` and any directory the outer repo ignores. A
  directory counts as a nested repo when it holds its own `.git` (directory or
  file) and is not a gitlink of the outer repo (mode 160000) or a path listed in
  its `.gitmodules`.
- **Git submodules are out of scope.** A submodule is owned by its outer repo,
  which already decides what commit it is at; it is neither refused nor
  isolated separately.
- **VS Code multi-root workspaces are a later slice.** They are a different way
  of naming several roots and need their own answer for which root is "the"
  workspace.
- **Repo names and roles are arbitrary; nothing may depend on them.** No code,
  prompt or default may assume a repo called `api`, `web` or `infra`, or that one
  repo is the "main" one. A group is a set of paths.

### Task workspace

Every task gets `.ordewell/worktrees/<run-id>/<order>-<slug>/`. It contains one
worktree per isolated repo, at the **same relative path** as in the real
workspace, so the agent sees the real layout and relative paths between repos
keep working. All of a task's worktrees share one branch name,
`ordewell/<run-id>/<order>-<slug>`, in each repo, so a task is one name to look
up across the group. The Runner's `cwd` is the task workspace, or the matching
place inside it when the real workspace root is a subdirectory of a repo
(ADR-0007: it is handed a `cwd` and nothing more).

- **Rejected: a per-task `repos` field chosen by the planner.** It changes the
  plan schema, which is the source of truth and would then have to be migrated
  and validated, and it makes a mis-scoped task fail in the worst way: the agent
  cannot read code in a repo the planner left out, so it guesses or gives up.
  Giving every task the whole group costs disk for worktrees that are never
  edited, which is the cheaper failure.

### Atomic integration

A passing task is merged only into the repos it changed. If any of those repos
conflicts or fails, the merges already made for that task on the other repos'
integration branches are rolled back, and the task becomes `conflict` as a whole.
`merged` always means the whole task landed.

The integration branches are Ordewell-owned, which is what makes a reset safe:
nothing but Ordewell commits to `ordewell/<run-id>/integration`, and the rollback
returns each to the commit it had before this task's merge. The resolver-task
mechanism (`resolvers`) works unchanged: a resolver merges the conflicted task's
branch in its own task workspace, and the conflicted task is re-integrated
through the same queue once it lands.

- **Rejected: partial landing.** A task that changed an API and its client would
  land in one repo and not the other, leaving the integration branches
  inconsistent with each other and `merged` meaning "some of it". A dependent
  would start from a tree that is neither before nor after the task.

### Every task is isolated

There is no per-task opt-out. Effects outside the repos — cloud resources, files
elsewhere on the machine — are the planner's and the user's responsibility;
isolation makes edits to repositories safe, and nothing in git can make a
deployment safe.

- **Rejected: an "external effects" task marker.** It adds a plan field, a
  scheduling rule (such tasks must not run in parallel, or must run in the shared
  root) and a decision the planner would have to get right about what touches the
  outside world. The user accepts the risk.

### Shared paths

Loose files and folders in the workspace root that are not in any repo of the
group are linked live into every task workspace, so edits to them are live and
unreviewed. The same applies to any repo that cannot be isolated — no commits, or
git refuses a worktree; that repo is named in a notice. `.ordewell/` is never
linked.

- **POSIX** links with symlinks.
- **Windows** needs no privilege (ADR-0010): junctions for directories and hard
  links for files. If a hard link is impossible (a different volume), it falls
  back to a copy and shows a notice, because a copy is not live.
- **The planner prompt lists the shared paths**, so it does not run parallel tasks
  that edit the same one. A shared path is the one place isolation does not
  protect against overlap, and the planner is the only thing that can.

### Bootstrap

The default linked artifacts (the `LINKED_ARTIFACTS` list and `.env*`) apply per
repo. A new `worktreeLinks` setting adds extra paths or globs, relative to each
repo root (for example `*.tfstate`, `.terraform/`), which are linked where they
exist. `worktreeSetupCommand` runs once per repo, with its cwd set to that repo's
worktree and the environment `ORDEWELL_REPO=<relative path>` and
`ORDEWELL_MAIN_REPO=<absolute path of the real repo>`. As in ADR-0013, it
replaces the default linking for that repo.

### Dirty trees

If any repo in the group has uncommitted changes to tracked files, the whole run
is held (`dirty`) and the notice names those repos. "Stash" stashes every dirty
repo. "Run without isolation" turns isolation off for the whole group.

- **Rejected: isolating per repo.** Isolating the clean repos and running in the
  dirty ones brings back exactly the collision isolation exists to prevent, in a
  group where tasks span repos.
- **Rejected: isolating from HEAD anyway.** Tasks would start from a tree that
  omits the user's uncommitted work, so the agents would build on code the user
  is no longer looking at, and the handoff would land against edits it never saw.

### Handoff

There is one "Merge all". Before touching any user tree, it preflights every
repo:

- no merge is already in progress;
- `git merge-tree --write-tree` against the checked-out HEAD shows no conflict;
- no uncommitted user changes overlap the incoming files.

It merges all repos only if every repo passes; otherwise it merges none and
reports the blocking repo and files. On git older than 2.38, which has no
`merge-tree --write-tree`, it merges repo by repo, stops at the first failure and
reports which repos landed. Ordewell never resets a user branch — the rollback
under *Atomic integration* is only ever applied to branches Ordewell created.

"Review diff" shows one section per repo. Discard, clean-up and crash pruning
cover every repo. The integration branches are plain branches
(`ordewell/<run-id>/integration` in each repo) that the user can merge by hand.

- **Rejected: per-repo merge buttons.** They put the atomicity ADR-0014 keeps for
  integration back in the user's hands at the one step where a mistake is
  hardest to undo. They stay available as a later option if the all-or-nothing
  handoff proves too coarse.

### One model

A single-repo workspace is a group of one, with the repo at path `.`. The run
record, the task record, the handoff and every git operation are defined over a
group; a group of one is not a special case. Runs persisted in the ADR-0013
format are converted when a session loads.

### Surfaces

Version 1 covers core, daemon, TUI, CLI and VS Code.

### As implemented: the nested-repos refusal

- `IsolationInactiveReason` gains `nested-repos`, and an inactive
  `IsolationAvailability` may carry `repos`, the paths behind the reason.
- `isActive` refuses a repo that contains nested non-submodule repos, and the
  orchestrator's fallback notice names them and says how to get isolation
  back: ignore them in git, or make them submodules.
- This slice also had a `not-git` folder name the repos directly inside it,
  while such a folder still ran in the workspace root. The next slice made
  those folders isolate, and the naming went with it (below).

### As implemented: detection, shared paths and bootstrap

The slice that made groups real sharpened four points and deviated on one.

- **Deviation: `workspaceRepos` replaces auto-detection rather than adding to
  it.** When the setting is non-empty, the group is exactly the listed paths that
  hold a `.git`; the repos directly inside the folder join only if listed. That
  lets a user leave a directly-inside repo out, which "plus the listed ones"
  could not. Unlisted repos are then ordinary shared paths.
- **A repo git refuses a worktree for is found at run start.** `startRun` tries
  a `--no-checkout` worktree for each repo and removes it again; a refusal
  shares that repo for the whole run, so a run's group never changes mid-run. If
  git refuses every repo, `startRun` throws and the orchestrator runs in the
  workspace root with a notice.
- **A directory holding a deeper repo is not itself shared.** The task workspace
  recreates it as a real directory, so the repo's worktree sits at its real
  path, and links the directory's other entries one by one.
- **`worktreeLinks` still applies when `worktreeSetupCommand` is set**, and is
  linked before the command runs so the command can rely on it; the command
  replaces only the default artifacts. Its globs match `*` and `?` within one
  path segment; there is no `**`, so a pattern never walks a whole tree. The
  command's environment keeps ADR-0013's `ORDEWELL_MAIN_WORKTREE` beside
  `ORDEWELL_REPO` and `ORDEWELL_MAIN_REPO`.
- **Copies are reported once per run**, naming the paths, since every task of
  the run gets the same ones.
- **`not-git` no longer names repos.** A folder with repos inside now isolates
  them, so the slice-1 notice listing them is gone; a group whose repos all lack
  commits reports `no-commits` naming them, and a dirty group names its dirty
  repos in `repos`.

### As implemented: atomic landing, Merge all and the planner prompt

The slice that made integration and the handoff atomic sharpened these points
and deviated on two.

- **The tips are recorded on the run, not the task.** Before a task's first
  merge, `IsolationRun.landing` holds the task id and each changed repo's
  integration tip, and the orchestrator saves the run — `integrate` takes a
  `persist` callback for exactly that moment. On the run because a retry drops
  and recreates the task's record, and the tips must outlive it until every
  repo is back at its tip. Cleared, with the task marked `merged`, in one
  synchronous step, so a saved run never shows one without the other.
- **A rollback resets only what it can prove is the landing's.** An integration
  branch goes back to its recorded tip only when what sits on it is one merge
  whose first parent is that tip, and only through Ordewell's own integration
  worktree or a bare ref update with the old value checked; never while the
  branch is checked out anywhere else. `pruneOrphans` applies the same rule
  after a crash, which also rolls back a task that had merged everywhere but was
  not yet saved as landed: the saved run is the truth. A landing it cannot
  settle stays recorded and blocks further landings and Merge all
  (`partial-landing`), rather than letting either build on part of a task.
- **`failed` names its repo too**, in `conflictRepo`, and a merge a hook refuses
  (a merge in progress with nothing unmerged) is `failed` rather than
  `conflict`. That also corrects a group of one, which called it a conflict.
- **A resolver merges the branch in every repo the task changed.** A conflict
  in one repo rolled the task back in all of them, so the resolver prompt names
  the repos and the one that conflicted. When the resolver lands, the conflicted
  task's re-landing finds its branch already merged wherever the resolver
  merged it, and merges the rest.
- **Deviation: a group of one gets no preflight.** Its one merge lands or is
  aborted whole, which is already all-or-nothing, so Merge all merges it the way
  it always has and it answers `merged`, `conflict` or `failed`, never
  `blocked`. The preflight exists for atomicity across repos. Git older than
  2.38 takes the same path for every group, as decided above.
- **Only repos with work are preflighted and merged**: those whose integration
  branch has commits its base ref does not. A merge of the user's in progress
  in a repo the run never touched is none of Merge all's business.
- **Merge all's answer** is `merged`; `blocked` with each repo, its reason
  (`merge-in-progress`, `conflict`, `uncommitted-changes`, `partial-landing`,
  `git-error`) and its files; or `conflict` / `failed` naming the repo a merge
  stopped in and the repos already `landed`, which stay merged. Session
  broadcasts it as `isolation_merge`, so every surface can show it.
- **The review diff is one patch over the workspace**: each repo's section is
  headed by its path, and its file paths are prefixed with it. A repo that is
  the workspace needs neither, so a group of one reads as before.
- **Deviation: the planner is told about any group but a lone repo at `.`**,
  not only groups of more than one. A folder holding a single repo still has
  its files under that repo's path, and may have shared paths, which is what
  the section exists to say. `isActive` names the repos and shared paths when
  it answers yes for a folder, so the planner can be told before a run is
  minted; a run in force or being continued describes its own group.

### As implemented: daemon, TUI and CLI

- **The daemon needed no new route.** `POST /isolation/merge` already answers
  the per-repo result whole, and the handoff travels in the run record and the
  `isolation_handoff` message. What it lacked was a way to say how a run
  isolates: the pool's notification channel is silent, so the fallback to the
  workspace root, shared paths, copies and the stash were told to nobody.
  `Session` now takes an `onNotice` dependency, fed by the orchestrator's
  `onIsolationNotice`, and the pool sends each as a `notice` frame beside the
  session stream. It is deliberately not a `SessionMessage`: that union has
  exhaustive switches on every surface, and a host that already shows these as
  toasts has no use for a second copy.
- **Merge all is worded once, in core** (`describeMergeResult`), for the
  orchestrator's notification, the TUI and the CLI. A group of one keeps its
  earlier wording for a conflict or a refusal; a group names the repo, the
  files, the repos that stay merged, and says each repo's integration branch
  can be merged by hand.
- **A group is drawn only when it is one**: a handoff with a repo not at `.`.
  A lone repo at the root reads exactly as before, in the overlay, the plan
  pane, `ordewell run` and `ordewell handoff`.
- **The stash names the repos it acts on**, and stashes all of them through the
  one call; there is no per-repo stash.

### As implemented: the integration review

Reviewing the branches together, end to end against real repositories,
changed one thing and confirmed two.

- **A loose link that leads nowhere is not shared.** An editor's lock file
  (`.#NOTES.md`) is a symlink to nothing, and linking it into a task workspace
  threw, so every task of the run failed to start. A shared path must resolve
  now; one that does not is left out of the task workspaces, the notice and the
  planner prompt.
- **The planner's envelope (ADR-0008) is not widened.** Every link in a task
  workspace points at the same path in the real workspace — a shared path at
  itself, a bootstrap link at its repo — never further, so a path through a
  task workspace reaches only what the same path in the workspace does. A user's
  own link out of the workspace is shared as a link to that link, not to where
  it leads. The planner's searches skip `.ordewell/` and follow no links, so
  they neither enter a task workspace nor leave the workspace through one.
- **Fork, rewind and compaction leave a group's run alone**, as they do a
  group of one's: a fork carries no run, and the other two change the
  conversation only. The planner's read of a running task's output (#3) and
  the transcript lookup work in a group's task workspace, which is not itself
  a repository, as they do in a worktree.

## Considered options

- **Treating the parent folder as the unit and initializing it as a repo.**
  Rejected: it writes a `.git` into the user's folder, and the repos inside it
  would become nested repos of it — the case this ADR refuses.
- **Isolating only the repo a task is "about".** Rejected with the per-task
  `repos` field: the plan would carry a scoping decision the planner cannot make
  reliably.
- **Auto-including repos at any depth.** Rejected: see *Supported layouts*. The
  setting is the explicit way in.

## Consequences

- A repository with a nested clone that used to isolate (and silently left the
  clone out of every worktree) now falls back to the workspace root with a
  notice naming it. That is a visible change in behavior for those workspaces,
  and deliberate: what it replaces was isolation that did not cover the code the
  tasks edited. Ignoring the directory, or making it a submodule, restores
  isolation.
- Every task pays for one worktree per repo in the group, including repos it
  never touches.
- Shared paths and repos that cannot be isolated are live and unreviewed. That is
  visible in the notice and the planner prompt, but it is a real gap in what
  isolation guarantees.
- `git merge-tree --write-tree` needs git 2.38; older git gets a handoff that
  can land some repos and not others, and says which.
- VS Code multi-root workspaces remain a later slice: the first folder is the
  workspace, as it always was, and the other roots are neither isolated nor
  shared.
