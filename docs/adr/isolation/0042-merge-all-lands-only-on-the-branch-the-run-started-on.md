---
status: accepted
amends: ["0013", "0014"]
---

# 0042 — Merge all lands only on the branch the run started on


## Problem

Merge all merges each repo's integration branch into whatever that repo has
checked out. A run forks from the branch the user was on and a handoff says
"landed on top of `<commit>`", so the user reads the merge as going back where
it came from. If they switched branch during the run, or a rebase left HEAD
detached, the work landed on a branch they never meant, in one repo or in some
of a group, and the surfaces named only a commit, not the branch the merge
would change.

## Decision

**Merge all refuses unless every repo of the run is on the branch it started on,
and every surface names that branch.**

- The run record keeps, per repo, the branch it started on (`baseBranch`) or
  that it started on a detached HEAD (`startedDetached`). A record saved before
  the branch was noted has neither and is not checked.
- The check runs first, for **every repo of the group, not only those with
  work**, because the confirmation promises each is on its starting branch. A
  repo on another branch answers `blocked` with the reason `wrong-branch`, the
  branch expected and the one checked out, and nothing is merged anywhere. A
  group of one is blocked by this and by a partial landing alone.
- A repo in the middle of a rebase is told apart from one the user detached on
  purpose (`rebasing`): the notice says to finish or abort the rebase. A run
  that started detached names no branch, so any checkout is as good as it was;
  its merge is always a merge commit, the only thing that tells it from a review
  of the integration tip (ADR-0054).
- The handoff, the Merge confirmation, `ordewell status` and the VS Code card
  say where the run forked as `<branch> @ <commit>` (or `detached at <commit>`)
  and which branch the merge will change.
- The refusal's notice says how to fix it ("Check out `main` and press Merge
  all again"), for a group naming every repo.

## Key properties

- A merge never lands on a branch the run did not fork from.
- A group is all or nothing here as everywhere else (ADR-0014): one repo on the
  wrong branch keeps the others from merging.
- The base ref is still the commit the review diff is taken against; the branch
  is only where the merge goes.

## Considered options

- **Merge into whatever is checked out.** The earlier behaviour; it silently
  changed a branch the user had moved to.
- **Check out the base branch for the user.** Rejected: Ordewell never moves a
  user's checkout or resets their branch (ADR-0014), and they may have
  uncommitted work there.
- **Check only repos with work.** Rejected: the confirmation says every
  repository is on its branch, so a repo with no work still has to be.
- **Warn and merge anyway.** Rejected: a merge is hard to take back, and the
  user may not see the warning before pressing.

## History

- 2026-10-17 — accepted and implemented: the `wrong-branch` block, the rebase case, and the branch named in the handoff, the confirmations, `ordewell status` and VS Code.
- 2026-10-31 — a run with no base branch merges with a merge commit, never a fast-forward (ADR-0054).
