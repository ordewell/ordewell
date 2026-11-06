---
status: accepted
amends: ["0013"]
folds:
  - "0019 — Nested repositories are shared live, not refused"
---

# 0014 — Multi-repo workspaces: isolate a repo group, land it atomically

## Problem

Worktree isolation (ADR-0013) assumed the workspace is one git repository. Many
users open a plain folder that holds several independent repositories — any
number of them, under any names — and for them isolation reported `not-git` and
every task ran in the shared root, with all the overlap problems ADR-0013 was
written to remove. Making the workspace's parent a repository is not an answer:
the repositories are independent, with their own history and remotes.

## Decision

**A workspace is a repo group, and isolation runs over the group.** A repo group
is the set of git repositories isolated together for one workspace. A workspace
that is one repository is a group of one, with the repo at path `.`; there is one
code path, not a single-repo path and a multi-repo one.

### Supported layouts

- **A folder that is not itself a git repo, with git repos directly inside it.**
  One level down, auto-detected. Together they form the group.
- **`workspaceRepos` names the group exactly.** When the setting is non-empty,
  the group is exactly the listed paths (relative to the workspace, at any depth)
  that hold a `.git`; a repo directly inside the folder joins only if listed, so
  a user can leave one out. Unlisted repos are ordinary shared paths.
  Auto-detection does not look past one level: a scan of the whole tree would
  visit every dependency folder, and a repo that deep is as likely to be a
  vendored clone as a project.
- **A workspace that is itself a repo is a group of one**, whatever it contains.
  Repositories nested inside it that are not submodules are shared live into
  every task at their real relative paths (see *Nested repositories*).
- **Git submodules are out of scope.** A submodule is owned by its outer repo,
  which already decides what commit it is at; it is neither refused nor
  isolated separately.
- **VS Code multi-root workspaces are a later slice.** They are a different way
  of naming several roots and need their own answer for which root is "the"
  workspace. Until then the first folder is the workspace, and the other roots
  are neither isolated nor shared.
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
(ADR-0025 D1: it is handed a `cwd` and nothing more). A directory that holds a
deeper repo of the group is recreated as a real directory, so the repo's
worktree sits at its real path, and the directory's other entries are linked one
by one.

A repo git refuses a worktree for is found at run start: `startRun` tries a
`--no-checkout` worktree for each repo and removes it again, and a refusal
shares that repo for the whole run, so a run's group never changes mid-run. If
git refuses every repo, `startRun` throws and the run goes to the workspace root
with a notice.

### Atomic integration

A passing task is merged only into the repos it changed — those where the task
branch has commits ahead of the integration tip. If any of them conflicts or
fails, the merges already made for that task on the other repos' integration
branches are rolled back, and the task is `conflict` (or `failed`) as a whole,
with `conflictRepo` naming the repo that stopped it. `merged` always means the
whole task landed. A merge a hook refuses (a merge in progress with nothing
unmerged) is `failed`, not `conflict`, in a group of one too, and the task's
`landingError` carries the first line git said. A task workspace is cut from
the group's integration tips only between landings: one cut after a landing
merged into some repos would keep that merge when the rollback undoes it.

- **The tips are recorded on the run, before the first merge.**
  `IsolationRun.landing` holds the task id and each changed repo's integration
  tip, and the orchestrator saves the run then — `integrate` takes a `persist`
  callback for exactly that moment. On the run, not the task, because a retry
  drops and recreates the task's record and the tips must outlive it. The landing
  is cleared, with the task marked `merged`, in one synchronous step, so a saved
  run never shows one without the other.
- **A rollback resets only what it can prove is the landing's.** An integration
  branch goes back to its recorded tip only when what sits on it is one merge
  whose first parent is that tip, and only through Ordewell's own integration
  worktree or a bare ref update with the old value checked; never while the
  branch is checked out anywhere else. The integration branches are
  Ordewell-owned — nothing but Ordewell commits to `ordewell/<run-id>/integration`
  — which is what makes the reset safe. `pruneOrphans` applies the same rule
  after a crash, which also rolls back a task that had merged everywhere but was
  not yet saved as landed: the saved run is the truth. A landing it cannot settle
  stays recorded and blocks further landings and Merge all (`partial-landing`),
  rather than letting either build on part of a task.
- **A resolver merges the branch in every repo the task changed.** A conflict
  in one repo rolled the task back in all of them, so the resolver prompt names
  the repos and the one that conflicted. When the resolver lands, the conflicted
  task's re-landing finds its branch already merged wherever the resolver merged
  it, and merges the rest.

### Every change task is isolated

A change task gets one worktree per repo of the group; there is no per-repo
opt-out. A task that changes no repository files — an ops task, acting on
outside systems or on the refs of the user's branch — runs at the workspace root
instead, once the change tasks it depends on are merged into the user's branch
in every repo of the group (ADR-0020). Isolation makes edits to repositories
safe; nothing in git can make a deployment safe, which is why an ops task waits
for the user's merge rather than for a landing.

### Shared paths

Loose files and folders in the workspace root that are not in any repo of the
group are linked live into every task workspace, so edits to them are live and
unreviewed. The same applies to any repo that cannot be isolated — no commits,
or git refuses a worktree — and to nested repositories (see *Nested
repositories*); each is named in a notice. `.ordewell/` is never linked. A link that leads nowhere (an editor's
lock file, `.#NOTES.md`) is not shared — linking it would fail every task — and
is left out of the notice and the planner prompt.

- **POSIX** links with symlinks.
- **Windows** needs no privilege (ADR-0010): junctions for directories and hard
  links for files. If a hard link is impossible (a different volume), it falls
  back to a copy, reported once per run naming the paths, because a copy is not
  live.
- **The planner prompt lists the shared paths**, so it does not run parallel tasks
  that edit the same one. A shared path is the one place isolation does not
  protect against overlap, and the planner is the only thing that can.
- **The planner's envelope (ADR-0008) is not widened.** Every link in a task
  workspace points at the same path in the real workspace — a shared path at
  itself, a bootstrap link at its repo — never further, so a path through a task
  workspace reaches only what the same path in the workspace does. A user's own
  link out of the workspace is shared as a link to that link, not to where it
  leads. The planner's searches skip `.ordewell/` and follow no links.

### Nested repositories (ADR-0019)

**The outer repository isolates; the repositories nested in it are shared live.**

- A workspace that is a repository is a *group of one* whether or not it holds
  nested repositories. There is no `nested-repos` refusal: `IsolationInactiveReason`
  has no such reason, and the orchestrator has no fallback notice for one.
- A nested repository is a repository below the workspace that the outer
  repository does not own as a submodule: a directory with its own `.git`
  (directory or file), not a staged gitlink and not declared in `.gitmodules`,
  found within two levels, skipping `.git`, `.ordewell` and `node_modules`.
- Each is linked live into every task at the same relative path it has in the
  workspace, exactly like a shared path of a group. It is recorded as `shared`
  in the run, so the group's existing disclosure carries it: the one-line
  notice to the user, and the planner prompt, which tells the planner not to run
  two tasks that edit the same one at once. It points at the same path in the
  real workspace, so the planner's envelope (ADR-0008) is unchanged.
- **An ignored nested repository is shared too.** No linked artifact stands in
  for it, and the whole point is that it must not vanish. Only if the bootstrap
  has already linked an artifact that contains it (`vendor/`, `.venv/`) is it
  left alone, so the artifact stays linked whole rather than being replaced by a
  link to one repository inside it.
- The links are made **after** the bootstrap and recorded on the lone repo's
  worktree like its bootstrapped artifacts, so they are kept out of the task's
  commit and never walked into on cleanup.

### Bootstrap

The default linked artifacts (the `LINKED_ARTIFACTS` list and `.env*`) apply per
repo. `worktreeLinks` adds paths or globs, relative to each repo root (for
example `*.tfstate`, `.terraform/`), which are linked where they exist. Its globs
match `*` and `?` within one path segment; there is no `**`, so a pattern never
walks a whole tree. `worktreeSetupCommand` runs once per repo, with its cwd set
to that repo's worktree and `ORDEWELL_REPO=<relative path>`,
`ORDEWELL_MAIN_REPO=<absolute path of the real repo>` and ADR-0013's
`ORDEWELL_MAIN_WORKTREE` in its environment. It replaces only the default
artifacts: `worktreeLinks` still applies, linked before the command runs so the
command can rely on it.

The setting is not scoped to a repo: a User-level VS Code setting or an
exported variable follows the user into every workspace, and here it runs in
every repo of the group, including ones it was never written for. So a command
that fails does not fail the task. That repo's worktree is reset and cleaned of
whatever the command left half-done, gets the default artifacts instead, and
the user is warned once per run, naming the repo and the first line of the
error. A per-repo setup command would be the structural fix.

### Dirty trees

If any repo in the group has uncommitted changes to tracked files, the run's
first change task is held (`dirty`) and the notice names those repos; ops tasks
are not held (ADR-0020). "Stash" stashes every dirty
repo through one call; there is no per-repo stash. "Run without isolation" turns
isolation off for the whole group. A group whose repos all lack commits reports
`no-commits` naming them; `not-git` is left for a folder with no repository in
it.

### Handoff

There is one "Merge all". Before touching any user tree, it preflights every
repo with work (commits its base ref does not have) — a merge of the user's in
progress in a repo the run never touched is none of its business:

- no merge is already in progress;
- `git merge-tree --write-tree` against the checked-out HEAD shows no conflict;
- nothing of the user's stands in the way of the incoming files: no uncommitted
  edit to one, no untracked file where the merge would write one and, when the
  merge needs a merge commit rather than a fast-forward, nothing staged at all,
  which git refuses to merge over.

Before any of that, every repo of the group, with work or not, must be on the
branch the run started on, or the answer is `blocked` with `wrong-branch`
([ADR-0042](0042-merge-all-lands-only-on-the-branch-the-run-started-on.md)).

It merges all repos only if every repo passes; otherwise it merges none and
answers `blocked` with each repo, its reason (`merge-in-progress`, `conflict`,
`uncommitted-changes`, `partial-landing`, `wrong-branch`, `git-error`) and its files. A merge
that still fails part-way answers `conflict` or `failed`, naming the repo it
stopped in and the repos already `landed`, which stay merged; a `failed` one
carries the first line git said, which the notice quotes, and none only for the
user's own merge in progress. On git older than
2.38, which has no `merge-tree --write-tree`, it merges repo by repo and stops at
the first failure. A group of one needs no preflight — its one merge lands or is
aborted whole — so it answers `merged`, `conflict` or `failed`, and is `blocked`
only by a partial landing or by being on the wrong branch.
Session broadcasts the answer as `isolation_merge`, so every surface can show
it. During a run, the same Merge all merges what has landed so far and the run
goes on (ADR-0020). Ordewell never resets a user branch — the rollback under *Atomic
integration* is only ever applied to branches Ordewell created. A person
switching, committing on or discarding in their own branch, at their own request
through a host, is [ADR-0062](0062-user-git-actions-are-confirmed-at-a-host-and-a-live-run-holds-only-its-landing-branch.md)'s
and is not Ordewell acting on its own account.

Whether an integration branch is deleted once merged is decided per repo,
against that repo's checked-out HEAD (ADR-0013). A full Merge all merges every
repo with work, so all of them go; a run the user merged by hand in one repo of
three loses its branch in that one only, at the next run's sweep or when a new
run replaces it. Nothing is deleted after a `blocked`, `conflict` or `failed`
Merge all, even in the repos a part-way merge landed.

"Review diff" is one patch over the workspace: each repo's section is headed by
its path, and its file paths are prefixed with it; a repo that is the workspace
needs neither, so a group of one reads as a single repo does. Discard, clean-up
and crash pruning cover every repo. The integration branches are plain branches
(`ordewell/<run-id>/integration` in each repo) that the user can merge by hand.

### The planner is told

The planner prompt describes the group — its repos and shared paths — for any
group but a lone repo at `.`, which gets a section only when nested repositories
are linked into it (above): a folder holding a single repo still has its files
under that repo's path, and may have shared paths. `isActive` names the repos
and shared paths when it answers yes for a folder, so the planner can be told
before a run is minted; a run in force or being continued describes its own
group.

### One model

A single-repo workspace is a group of one, with the repo at path `.`. The run
record, the task record, the handoff and every git operation are defined over a
group; a group of one is not a special case. Runs persisted in the single-repo
format are converted when a session loads. Fork, rewind and compaction leave a
group's run alone, as they do a group of one's; a running task's output (#3) and
the transcript lookup work in a group's task workspace, which is not itself a
repository, as they do in a worktree.

### Surfaces

Core, daemon, TUI, CLI and VS Code.

- **How a run isolates is told as a notice.** `Session` takes an `onNotice`
  dependency, fed by the orchestrator's `onIsolationNotice`, and the daemon sends
  each as a `notice` frame beside the session stream: the fallback to the
  workspace root, shared paths, copies and the stash.
- **Merge all is worded once, in core** (`describeMergeResult`), for the
  orchestrator's notification, the TUI and the CLI. A group names the repo, the
  files, the repos that stay merged, and says each repo's integration branch can
  be merged by hand; a group of one is worded as a single repo.
- **A group is drawn only when it is one** — a handoff with a repo not at `.`. A
  lone repo at the root reads as a single repo in the overlay, the plan pane,
  `ordewell run` and `ordewell handoff`.
- The daemon needed no new route: `POST /isolation/merge` answers the per-repo
  result whole, and the handoff travels in the run record and the
  `isolation_handoff` message.

## Considered options

- **Treating the parent folder as the unit and initializing it as a repo.**
  Rejected: it writes a `.git` into the user's folder, and the repos inside it
  would become nested repos of it.
- **A per-task `repos` field chosen by the planner.** Rejected: it changes the
  plan schema, which is the source of truth and would then have to be migrated
  and validated, and it makes a mis-scoped task fail in the worst way: the agent
  cannot read code in a repo the planner left out, so it guesses or gives up.
  Giving every task the whole group costs disk for worktrees that are never
  edited, which is the cheaper failure.
- **Auto-including repos at any depth.** Rejected: see *Supported layouts*. The
  setting is the explicit way in.
- **`workspaceRepos` added to auto-detection** rather than replacing it. It was
  the first design. Rejected: a user could not leave a directly-inside repo out.
- **Refusing a repository that contains nested non-submodule repos**
  (`nested-repos`). It was the first answer: `isActive` answered
  `{ active: false, reason: 'nested-repos' }` and every task of the run fell
  back to the shared workspace root with a notice. It replaced an outer-only
  isolation that silently left the nested repos out of every worktree. Rejected,
  because the refusal is too coarse in three ways and has a hole:
  - It is all-or-nothing. One nested clone — a scratch checkout, a vendored
    repository, a test fixture — turned off isolation for the **whole**
    workspace, including the outer repository that could be isolated perfectly
    well. That brought back the overlap ADR-0013 and this ADR exist to remove.
  - The only remedies the notice offered were to ignore the nested repositories
    in git or make them submodules, both changes to the user's real repository.
    `workspaceRepos`, whose whole job is to name the group, could not help: when
    the workspace is itself a repository, `scanGroup` never reads it.
  - The case it treated as safe was the leaky one. A nested repository the outer
    repository *ignores* was exempt from the refusal, so isolation proceeded —
    but `sharedPaths` returns nothing for a group of one, and a worktree only
    holds tracked files, so the ignored nested repository was simply absent from
    every task worktree, with no notice. The unignored case was refused loudly;
    the ignored case disappeared in silence.

  Half-isolating the outer repository is the failure the refusal was right to
  name, but refusing the whole group is a bigger failure: it protects nothing.
  The nested repositories are books the tasks may legitimately need to read, and
  a live link discloses its own risk.
- **Composing the outer repository and the nested ones into one group.**
  Rejected: it reads well — the outer at `.`, the nested at their paths — but a git worktree
  cannot cleanly hold another worktree inside its working directory, and the
  nested repository is *owned* by the outer one in no way that would let its
  history be integrated atomically with it.
- **Sharing only the unignored nested repositories.** Rejected: it leaves the
  silent, invisible case exactly as it is, which is the one the shared-live rule
  exists to remove.
- **Partial landing.** Rejected: a task that changed an API and its client would
  land in one repo and not the other, leaving the integration branches
  inconsistent with each other and `merged` meaning "some of it". A dependent
  would start from a tree that is neither before nor after the task.
- **Every task isolated, with no "external effects" task marker.** It was the
  rule until ADR-0020, which rejected it: a plan field, a scheduling rule and a
  decision the planner has to get right cost less than operations run in
  worktrees on unmerged code, in the wrong order, or not at all. ADR-0020's ops
  task is that marker.
- **Isolating per repo.** Rejected: isolating the clean repos and running in the
  dirty ones brings back exactly the collision isolation exists to prevent, in a
  group where tasks span repos.
- **Isolating from HEAD anyway.** Rejected: tasks would start from a tree that
  omits the user's uncommitted work, so the agents would build on code the user
  is no longer looking at, and the handoff would land against edits it never saw.
- **Per-repo merge buttons.** Rejected: they put the atomicity this ADR keeps for
  integration back in the user's hands at the one step where a mistake is
  hardest to undo. They stay available as a later option if the all-or-nothing
  handoff proves too coarse.
- **Telling the planner only about groups of more than one.** Rejected: a folder
  holding a single repo has its files under that repo's path and may have shared
  paths.
- **Isolation notices as a `SessionMessage`.** Rejected: that union has
  exhaustive switches on every surface, and a host that already shows these as
  toasts has no use for a second copy.

## Consequences

- Every task pays for one worktree per repo in the group, including repos it
  never touches.
- Shared paths and repos that cannot be isolated are live and unreviewed. That is
  visible in the notice and the planner prompt, but it is a real gap in what
  isolation guarantees.
- `git merge-tree --write-tree` needs git 2.38; older git gets a handoff that
  can land some repos and not others, and says which.
- A repository with a nested clone isolates: the outer repository in a
  worktree, the nested ones live and named. Edits to the nested ones are not
  isolated and not reviewed — visible in the notice and the planner prompt, as
  for any shared path. That is the trade: the outer repository keeps isolation
  instead of the whole workspace losing it.
- Detection of nested repositories stops two levels below the root, while a
  folder's own repositories are found one level down (*Supported layouts*); both
  bounds keep the scan off dependency trees. A nested repository deeper than
  that is not found, and so is not shared.
- A nested repository inside a linked artifact (`vendor/`, `.venv/`) is live
  through the whole artifact link rather than linked a second time; the notice
  still names it, because a live path it is.

## History

- 2026-09-25 — accepted and built in slices: the nested-repos refusal; detection,
  shared paths and bootstrap; atomic landing, Merge all and the planner prompt;
  daemon, TUI and CLI; an end-to-end review against real repositories (dangling
  links not shared, the envelope confirmed unwidened).
- 2026-09-30 — nested repositories shared live instead of refused (ADR-0019).
- 2026-10-02 — only change tasks are isolated; ops tasks run at the workspace
  root behind a merge gate, and the dirty-tree hold moves to the first change
  task (ADR-0020).
- 2026-10-17 — ADR-0019 folded in as *Nested repositories*.
- 2026-10-17 — Merge all refuses unless every repo is on the branch the run started on ([ADR-0042](0042-merge-all-lands-only-on-the-branch-the-run-started-on.md)).
- 2026-10-24 — Merge all's preflight also refuses over untracked collisions and staged changes, a failed merge says what git said, and a task workspace is cut between landings.
- 2026-11-03 — *never resets a user branch* is about Ordewell's own account: a person's switch, commit or discard in their own branch through a host is ADR-0062's.
