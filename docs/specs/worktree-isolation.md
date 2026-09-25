# Worktree isolation for parallel task execution

> What was built from this spec is recorded in
> [ADR-0013](../adr/0013-worktree-isolation.md), and
> [ADR-0014](../adr/0014-multi-repo-workspaces.md) widens it from one repository
> to a repo group: a folder of repositories isolates them together, with the
> `workspaceRepos` (`ORDEWELL_WORKSPACE_REPOS`) and `worktreeLinks`
> (`ORDEWELL_WORKTREE_LINKS`) settings. Where they differ from this spec, the
> ADRs are current.

## Problem Statement

When an Ordewell plan runs, every task is executed by its **Runner** in the
same working directory — the workspace root. `maxParallelSessions` (default 3)
means several runners can be editing that one tree at once. The planner is
instructed to keep parallel tasks on different files, but that is advice to a
model, not an enforced boundary, and it costs parallelism: two genuinely
useful tasks are serialized with a dependency purely because they touch the
same file.

When two tasks do overlap, the failure is silent and bad. Runner B rewrites a
file Runner A just changed; A's completion marker still appears, so A verifies
`pass` on a tree that no longer contains A's work. There is no per-task record
of what a task changed, no way to review one task's result on its own, and no
way to undo a single task without untangling the whole run. And because the
runners write directly into the user's tree, a run can trample uncommitted work
in progress.

## Solution

When the workspace is a git repository, Ordewell gives every AI task its own
**worktree** — a linked checkout on its own branch — instead of the shared
workspace root, and passes that worktree to the Runner as its working
directory. As each task passes its evidence-based **Verdict**, the
orchestrator commits the worktree and merges its branch into a
per-run **integration branch**, in plan order, never touching the branch the
user has checked out. When the run finishes, the user has one reviewable
branch and chooses to review the diff, merge it, or discard it.

The workspace stops being a shared mutable resource during execution and
becomes a set of isolated checkouts that are integrated deterministically
afterwards. Non-git workspaces behave exactly as today. Git workspaces can
opt out.

## User Stories

1. As a developer running a multi-task plan, I want each task to execute in its own worktree, so that two parallel runners can never overwrite each other's files.
2. As a developer, I want the planner's parallel tasks to actually run in parallel even when they touch the same file, so that I get the throughput I asked for.
3. As a developer, I want a task to be verified against the tree it actually produced, so that a `pass` verdict cannot be won by work that was later overwritten.
4. As a developer, I want my uncommitted work to be untouched by a run, so that an autonomous plan cannot lose changes I have not committed yet.
5. As a developer with a dirty working tree, I want to be told to commit or stash before isolated execution, so that I know why the run is waiting rather than being surprised later.
6. As a developer who cannot stash right now, I want an explicit "run without isolation" option, so that I can still run a plan and accept the old shared-workspace behavior knowingly.
7. As a developer in a workspace that is not a git repository, I want everything to keep working exactly as before, so that Ordewell is not git-only.
8. As a developer who prefers the old behavior in a git repo, I want a configuration switch to turn isolation off, so that I am never trapped by it.
9. As a developer, I want all task work integrated into a single per-run branch, so that I review one artifact instead of reconciling N branches.
10. As a developer, I want integration to happen in plan order, so that the resulting history is reproducible rather than dependent on which model finished first.
11. As a developer, I want dependent tasks to start from a tree that already contains their dependencies' work, so that task dependencies mean what they say.
12. As a developer, I want a task that depends on another to wait until the predecessor is integrated, so that I never see a dependent run against a stale base.
13. As a developer, I want a merge conflict to stop the task and surface it, so that no model silently rewrites a merge I did not review.
14. As a developer, I want a conflicted task's worktree and branches preserved, so that I can resolve it myself.
15. As a developer, I want an explicit "resolve as a task" action for a conflict, so that an autonomous run can continue without inventing truth.
16. As a developer, I want a failed task's worktree kept for inspection, so that I can see exactly what the runner did.
17. As a developer, I want a retry to start fresh from the current integration tip, so that a retried task sees everything its predecessors have already integrated.
18. As a developer, I want cancelling a task to remove its worktree and branch, so that abandoned work does not accumulate on disk.
19. As a developer, I want removing a task from the plan to clean up its isolation, so that the plan and the filesystem stay in agreement.
20. As a developer using "Run task" or "Force start" on a single task, I want the same isolation guarantees, so that manual execution is not a second-class path.
21. As a developer, I want the plan's end-of-run handoff to show me the integration branch and what landed on it, so that I know exactly what to review.
22. As a developer, I want one-click Review / Merge / Discard actions at the end of a run, so that landing the work is one step.
23. As a developer, I want Ordewell to never merge into my checked-out branch automatically, so that the irreversible step stays mine.
24. As a developer, I want to discard an entire run's isolation in one action, so that a plan I do not want leaves no trace.
25. As a developer, I want each worktree to be immediately runnable — dependencies, local env, and agent config present — so that test and build tasks do not fail for want of a missing `node_modules`.
26. As a developer, I want secrets and local env files treated the same in a worktree as in my tree, so that behavior does not silently diverge.
27. As a developer with a repo whose setup is not a plain symlink, I want to configure a setup command, so that worktrees bootstrap correctly.
28. As a developer, I want Ordewell's own session and skills state to stay out of task worktrees, so that runners cannot corrupt Ordewell's state.
29. As a developer, I want the planner to stop manufacturing dependencies purely because two tasks touch the same file when isolation is active, so that the dependency graph reflects real ordering.
30. As a developer, I want the planner to still sequence tasks that genuinely depend on each other, so that isolation does not break logical ordering.
31. As a developer, I want the planner's behavior to revert to today's overlap-avoidance rule when isolation is off or the workspace is not a git repo, so that non-isolated runs stay safe.
32. As a developer, I want to see, per task, the branch and worktree it ran in, so that I can inspect the isolated work directly.
33. As a developer, I want a visible conflict indicator on a task, so that a stopped integration is not a hidden failure.
34. As a developer, I want the rest of the run to stay quiet about isolation, so that worktrees are an implementation detail unless something needs my attention.
35. As a TUI user, I want the end-of-run handoff and conflict states rendered in the terminal, so that I never have to drop to a shell.
36. As a VS Code user, I want the same handoff, conflict, and review affordances in the extension, so that the surfaces agree.
37. As a user of the local daemon, I want the isolation state delivered over the existing session stream, so that any surface can present it without new transport.
38. As a developer resuming after a crash, I want orphaned worktrees detected and pruned, so that a killed run does not leave git in a confusing state.
39. As a developer, I want the run's integration branch and base ref to be recorded, so that a resumed session knows where its work belongs.
40. As a developer on Windows, I want worktree creation to work without requiring administrator symlink privileges, so that the feature is not Linux/macOS-only.
41. As a developer whose repo uses git hooks or submodules, I want an opt-out that is not "make my repo not a git repo", so that I can fall back to shared-workspace execution.
42. As a maintainer, I want every git operation owned by Ordewell's deterministic core, so that Claude Code, Codex and OpenCode cannot produce three different git behaviors.
43. As a maintainer, I want the isolation logic behind one module with a narrow interface, so that scheduling tests use a fake while git behavior is tested against real repositories.
44. As a maintainer, I want the planner's research envelope unchanged, so that read-only planning keeps its existing security boundary.

## Implementation Decisions

**One new deep module owns isolation.** A `WorktreeIsolation` module in core owns
every git and filesystem operation for the feature: worktree creation, the
ignored-artifact symlink/bootstrap step, commit, integration merge, conflict
detection, release/cleanup, orphan pruning, and the end-of-run handoff. It is
injected into `TaskOrchestrator` the way `ITerminalRunner` and `PlanStore`
already are, and it is the only new seam. Git never enters `ITerminalRunner`,
`RunnerRegistry`, or any runner adapter — consistent with ADR-0007, where a
Runner is handed a `cwd` and nothing more.

The interface, in shape (the exact names are the implementer's, but this is the
decision-rich surface):

```ts
type IsolationOutcome = 'merged' | 'conflict' | 'failed';

interface WorktreeIsolation {
  // git repo + clean tree + config enabled
  isActive(workspaceRoot: string): Promise<boolean>;
  // create the task worktree from the integration tip; returns the cwd to spawn into
  prepare(task: Task, run: IsolationRun): Promise<{ cwd: string; branch: string }>;
  // commit the worktree's contents, then merge --no-ff into the integration branch
  integrate(task: Task, run: IsolationRun): Promise<IsolationOutcome>;
  // remove the worktree and (unless kept) the task branch
  release(taskId: string, opts: { keep: boolean }): Promise<void>;
  // end-of-run summary: integration branch + captured base ref
  handoff(run: IsolationRun): Promise<{ branch: string; baseRef: string }>;
  // drop stale worktrees for a run after a crash
  pruneOrphans(run: IsolationRun): Promise<void>;
}
```

**Isolation is run-scoped.** A run is one Execute-Plan click or one manual task
run. When a run begins, an isolation record is minted (id, base ref resolved to
a commit, integration branch name, per-task branch/worktree/status) and
persisted with the plan state so a resumed session can recover it. A new run
mints a new record. The base ref is the branch checked out in the main worktree
at run start, resolved to a commit then — switching branches mid-run does not
retarget the merge.

**Naming and location.** Worktrees live at
`.ordewell/worktrees/<run-id>/<order>-<slug>` and branches are
`ordewell/<run-id>/<order>-<slug>`, with the integration branch at
`ordewell/<run-id>/integration`. `.ordewell` is already git-ignored and skipped
by every workspace scan, and its own `.gitignore` of `*` keeps the worktrees
out of git's view; cleanup is directory removal plus `git worktree prune`.

**Integration is a serialized merge queue.** Verdicts can land concurrently, so
the module serializes integration internally and merges in plan `order` using
`git merge --no-ff` — one merge commit per task. That preserves any commits a
Runner made on its own, makes per-task attribution visible, and makes the task
branch an ancestor of the integration branch so it can be deleted safely.

**Conflicts are surfaced, never resolved by a model.** If the mechanical merge
conflicts, the task becomes `awaiting_user`; the worktree and both refs are
kept; the surface shows a conflict indicator with an explicit "resolve" action.
Running that action as a task is opt-in. No automatic model merge is ever
performed.

**Dirty trees block isolated execution.** If tracked files are modified,
isolated execution is unavailable for that run: the user is offered a stash, or
an explicit "run without isolation" fallback that uses the shared workspace root
for that run. Untracked and ignored files do not block when the bootstrap below
accounts for them.

**Worktree bootstrap.** On creation, ignored artifacts are symlinked from the
main worktree — `node_modules`, `vendor`, `.venv`, `.env*`, `.envrc`,
`.claude`, `.opencode`, `.codegraph` — so the worktree is runnable and Runner
config/trust is present. A per-repo setup command may override the symlink step
for repos where sharing is wrong. `.ordewell/` is never linked: Ordewell's
session and skills state stays at the main root.

**Config.** A `worktreeIsolation` setting (default on) plus an
`ORDEWELL_WORKTREE_ISOLATION` environment override, following the existing
`BaseConfig`/`EnvConfig` pattern. Non-git workspaces, a missing git binary, or
isolation disabled all fall back to today's shared-root execution with a
one-line notice. The `fakeConfig` test helper gains the field.

**Lifecycle.** Worktrees are created lazily when a task actually starts.
Successful integration removes the worktree and deletes the task branch.
Verification failure keeps both for inspection; a retry recreates fresh from the
current integration tip. Cancel, release, and task removal destroy them.
Orphans are pruned when a session is adopted. "Discard run" removes all of a
run's worktrees and task branches but keeps the integration branch until it is
explicitly discarded.

**End of run is a handoff.** Ordewell never merges into the user's branch
automatically. When the plan settles it reports the integration branch and
offers Review diff / Merge / Discard / Clean up. Merge is a normal `git merge`
reported back to the surface.

**Planner prompt is conditioned on isolation.** When isolation is active, the
planner keeps dependency edges for genuine logical ordering but stops
manufacturing them for file overlap (`PlanPrompts.ts`); the old overlap-avoidance
rule remains the instruction when isolation is off or the workspace is not a
git repo. The planner and its research subagents never execute in a worktree —
read-only planning keeps its existing envelope (ADR-0008).

**Persistence and transport.** The isolation record is part of the persisted
plan state so it survives reload. The end-of-run handoff and per-task isolation
status travel over the existing `SessionMessage`/`broadcast` seam (a new
handoff message plus isolation fields on the task snapshot), so the TUI, VS Code
extension, and web daemon present the same state without new transport.

**Docs.** An ADR records the decision and its rejected alternatives (full
clones, shared-batch worktrees, auto-merge, model-resolved conflicts). CONTEXT.md
gains *worktree*, *integration branch*, *base ref*, and *isolated execution* in
the planning-and-execution vocabulary.

## Testing Decisions

A good test here observes externally visible behavior: git state at the
porcelain level (worktrees listed, branch contents, whether a merge is reported
as conflicted, whether artifacts and cleanup exist), the `cwd` a Runner was
spawned with, and the task statuses the orchestrator settles on — never the
literal git command lines or private fields.

**`WorktreeIsolation` against real temporary repositories.** Prior art:
`TmuxRunner.test.ts`, `sessionStore.test.ts`, and `workspace.test.ts` all build
real temp directories with `mkdtempSync` and assert on real filesystem/git
outcomes; `TmuxRunner` also shows the injectable-exec seam if any single command
needs to be simulated. Tests cover: worktree creation from a base ref, symlink
bootstrap, commit-and-merge of a passed task, `--no-ff` attribution, conflict
detection, cleanup, retry-from-tip, orphan pruning, and the non-git/disabled
returns. Assertions read `git worktree list`, branch tips and file contents, not
strings.

**`TaskOrchestrator` against a fake isolation collaborator.** The existing suite
(`TaskOrchestrator.test.ts`) already fakes `ITerminalRunner` and builds config
via `fakeConfig` (`packages/core/src/testing.ts`) with the shared test kit; the
fake isolation module is added the same way. Tests assert the seam: the spawn
`cwd` is the worktree path, a dependent does not spawn until its predecessor is
integrated, integration order follows plan order, a conflict lands the task
`awaiting_user` and does not unblock dependents, cancel/remove call release,
retry recreates from the tip, and a non-git or disabled workspace passes the
workspace root unchanged.

**Config resolution.** The `worktreeIsolation` default and the environment
override are covered alongside the existing config tests.

**Planner prompt.** The overlap rule is asserted to be present or absent
depending on whether isolation is active, next to the existing prompt tests.

**Verification commands.** `npm run test`, `npm run typecheck`, and
`npm run lint` from the repo root, with core built first per AGENTS.md. The
offline planner drive (`bench/live/drive-conversation.mjs`) is extended to
exercise the git path.

## Out of Scope

- Isolation for non-git version control (Mercurial, SVN). The fallback is
  shared-root execution; only `.git` worktrees are in scope.
- Overlap-aware scheduling from a declared per-task file scope. The concurrency
  policy trusts the dependency graph; conflicts are handled, not predicted.
- Automatic merging into the user's checked-out branch.
- Automatic, model-driven conflict resolution.
- OS-level sandboxing of runners (separate effort; see ADR-0011).
- Pushing, pull requests, or any remote operation.
- Redefining how Runners themselves use git; they continue to receive a `cwd`.

## Further Notes

- The change is consistent with ADR-0007 (a Runner is handed a working
  directory), ADR-0008 (the planner's read-only envelope is untouched), and
  ADR-0002 (the planner remains a conversation). ADR-0010 governs the Windows
  path, where symlink creation may require privilege; the bootstrap step must
  degrade to a junction or copy there.
- `codex.manifest.ts` already passes `--skip-git-repo-check` because task
  workspaces are not always git repos — that remains true and unaffected.
- Open risks to resolve during implementation: symlinked `node_modules` under
  concurrent installs; repositories with git hooks or submodules that assume a
  single worktree; Windows symlink privileges; and ensuring the runner sandbox
  scope (see `codexSandbox.ts`) includes the worktree path.
- The concurrency posture is deliberately conservative: isolation makes overlap
  safe, but integration still serializes, so the throughput gain is capped by
  the dependency graph the planner emits. File-scope-gated scheduling is the
  obvious follow-up if conflicts prove frequent.
