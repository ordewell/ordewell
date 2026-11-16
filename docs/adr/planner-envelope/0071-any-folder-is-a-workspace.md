---
status: accepted
---

# 0071 — Any folder is a workspace; git decides only how its tasks are isolated

## Problem

The daemon refused to plan in a folder that carried no project marker: no
`.ordewell/`, no version-control directory (`.git`, `.hg`, `.svn`, `.bzr`) and no
manifest from a fixed list (`package.json`, `pyproject.toml`, `requirements.txt`,
…). It answered `workspace_not_a_project`, "Workspace … is not a project
directory". The check was added so that a request naming the filesystem root or a
system directory could not make it the boundary every planner read, search and
permitted command is confined to (ADR-0008).

A folder of notes, papers, data or loose scripts is a reasonable workspace, and
the surfaces disagreed about it. VS Code plans in its own process and never
applied the check, so such a folder opened there straight away. The TUI asked
"Initialize new workspace?" and retried with `allowInit`, which created
`.ordewell/`. The desktop app showed the refusal as an error, with no way in.
Git was never the question: [ADR-0013](../isolation/0013-worktree-isolation.md)
already runs every task in the workspace itself when there is no repository.

## Decision

**Any folder that exists is a workspace: it needs no git, no manifest and no
`.ordewell/`, and whether it holds git repositories decides only how its tasks
are isolated (ADR-0013).** The folder the user opens, or the TUI starts in, is the
workspace on every surface, with nothing to confirm first.

## Key properties

- **Existence is the whole admission check (W1).** `assertWorkspaceExists` refuses
  a path that is not a directory, as `workspace_not_found`, because a missing
  folder otherwise reaches a runner's spawn as an ENOENT that reads as a missing
  binary. Nothing else is asked of a folder, on any surface, so the daemon and
  VS Code's in-process session admit the same folders.
- **Without git, tasks run in the workspace itself (W2).** A workspace with no
  repo group runs every task in its root, as ADR-0013's fallback does: no
  worktrees, no run branch, no landing, Merge all or revert, and the planner keeps
  the rule that parallel tasks stay off each other's files. The isolation notice
  every surface shows says so before work starts.
- **The state folder comes with the first save (W3).** `.ordewell/` and its
  `.gitignore` are written when a session is first saved, as in any workspace;
  opening a folder writes nothing.
- **The user's choice is the boundary (W4).** The workspace stays what the
  planner's paths are confined to (ADR-0008): inside it reads are free, outside it
  is an ask. Opening `/` or a home folder makes that the boundary, as opening it
  in VS Code always did; the person who chose the folder is the authority on it.

## Testing decisions

- `assertWorkspaceExists` is tested on a temp folder holding only a PDF, beside
  its missing-path and not-a-directory cases.
- `OrchestratorPool` opens a planning session in such a folder with the planner
  stubbed, as its other session tests do, and still refuses a missing folder.
- The CLI's daemon contract test plans through a real in-process daemon in a bare
  directory, the way it drives its other routes.

## Considered options

- **Require a project marker (the design until 2026-11-16).** Rejected: it
  refused folders people reasonably plan in, VS Code never applied it, and the
  marker list was an ever-incomplete guess at what a project looks like.
- **Keep the marker check and ask to initialize on every surface, as the TUI
  did.** Rejected: the user already chose the folder by opening it, so the
  question guarded nothing, and it stood between the user and every first plan in
  a new folder.
- **Admit any folder but refuse the filesystem root and the home folder, or ask
  for those two.** Rejected: a list of dangerous folders still admits every
  system directory it does not name, the reason this project turns down
  denylists elsewhere, and a home folder can be a deliberate workspace.

## Consequences

- The desktop app and the TUI open any folder straight away, as VS Code did.
- A task in a folder without git writes straight into the user's files, with no
  per-task branch to undo it from; that is ADR-0013's fallback, and the isolation
  notice is where a user learns it.
- A workspace of `/` or a home folder gives the planner free reads across it.
  Watch for surfaces that start in such a folder by accident, such as a TUI run
  from the home directory.
- Removing a refusal code is an incompatible daemon change: `DAEMON_CONTRACT` is
  4, so a client replaces a contract-3 daemon that would still refuse the folder.

## History

- 2026-11-16 — accepted.
