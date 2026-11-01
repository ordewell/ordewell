---
status: accepted
amends: ["0022", "0046", "0047"]
---

# 0050 — A read-only task can hand off its prototype as a patch

## Problem

A read-only task can try a fix in its own worktree
([ADR-0046](0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)),
and that worktree is thrown away whole when the attempt ends: its *Handoff*
([ADR-0047](../supervision/0047-structured-task-handoffs.md)) is all that comes
back. So a plan of explorers, then a judge, then a builder loses the one thing
worth judging. An explorer's prototype survives only as prose, and the builder
rebuilds it from a description.

An explorer cannot keep it on its own. With git 2.56.0, a plain
`git diff --binary HEAD` silently leaves out new files, and `git add` fails in a
sealed run because the repository's `.git` is read-only there. The recipe that
works (a private index and object store, with the repository's objects as
alternates) still breaks on a case-only rename on a case-insensitive file
system. It also sweeps in the links Ordewell put in the worktree, and stops on
an unreadable file.

## Decision

**A read-only task keeps its prototype by calling `save_patch`. Ordewell
captures every change in the task's worktree as a patch, inside the task's own
seal, and checks that the patch replays to the same tree. It keeps the patch
beside the attempt's log and names it in the attempt's handoff as a `patch`
artifact. The patch lands nothing. A change task brings it into its own
worktree with `apply_patch`, and is told exactly what merged and what did
not. Choosing among several explorers' patches
needs no new mechanism: a shared check eliminates, a judge recommends among
those that pass, and the pick is approving the build task the planner adds.**

### The tool

- **`save_patch({})`** is on a read-only task's token alone, beside
  `run_command` ([ADR-0022](../runners/0022-ordewell-mcp-server.md)).
- **Its answer** says what it saved and what it left out, or why it saved
  nothing. What it saved is the files, the lines added and removed, the size
  and the base commit.
- **Saving again** replaces the attempt's patch. A save that finds nothing to
  save leaves an earlier patch in place.
- **Before the shell's first sealed run** there is nothing to save. Native
  writes are withheld and an unsealed command writes only scratch, so the
  worktree is still what Ordewell checked out. The call says so and runs
  nothing, so a save never seals a shell that was not sealed.
- **Refused** for a task with no worktree, and for one across a *Repo group*'s
  several repositories: a saved patch is one repository's changes.

### The capture runs inside the seal

`PatchCapture` owns the recipe. The task shell runs its two scripts as
Ordewell's own sealed runs (`TaskShell.hold`):

- No command rule judges them, since the task did not write them.
- They run under the task's sealed profile, from the worktree root.
- They are checked after each run as every sealed run is: the link walk and
  the `.git` record.
- The shell is held for them, so no command of the task runs in between.
- Where no sandbox can seal, nothing runs and the call says why.

**The first script** stages every change into a private index. The index is
seeded from a copy of the worktree's own, so git rehashes only what changed.
The object store is private too, in scratch, with the repository's object
directory as its alternate. The script then lists four things:

- the changes;
- every path the index holds;
- the size of each change's part of a patch, and of each rename's;
- the base commit.

**Between the scripts**, Ordewell decides what is refused and what is left out.

**The second script** takes what is left out back out of the private index and
writes the patch with `git diff --cached --binary --full-index -M HEAD`. It then
replays the patch onto a fresh index at the same base. The patch is kept only
when that gives the very tree that was staged.

**Git's configuration is pinned** wherever it would change the patch or write
the repository:

- fsmonitor, the split index and the untracked cache off;
- `core.ignoreCase` off, so a case-only rename shows as two paths;
- ctime trusted;
- prefixes `a/` and `b/`;
- no external diff, textconv or order file;
- no system or global configuration, since the seal's home is the task's
  scratch directory, and no replace objects.

**What the scripts wrote** is read from unguessable names in the attempt's
scratch, with no link followed and every size bounded.

**What Ordewell keeps is judged on the bytes it reads**, not on what git listed
beside them. A process a sealed command left running outlives its run, and
scratch is the task's to write, so it can rewrite any file the scripts leave
there. Ordewell therefore checks the patch itself, in TypeScript and with no
git:

- It refuses a patch whose headers would create a symbolic link or a
  submodule, or turn a file into one. A mode counts as a regular file's only
  when it is `100644` or `100755`, since git reads `0120000` and `120755` as
  links too. Deleting a link or a submodule is the one place a header may name
  another mode.
- It counts the files, the lines added and removed and the binary files from
  the patch, so the artifact says what a reader of the file finds.
- It records the SHA-256 of the patch in the artifact.

The per-file cap is the one limit not read from the patch: the size of each
part comes from listings in scratch, which a process left behind can rewrite.
The cap on the whole patch is read from the patch, so what is kept is bounded
whatever the listings say.

### Applying it

- **`apply_patch({task, attempt?})`** is on a change task's token, and a
  read-only task's does not list it. The patch is the artifact of a task the
  caller may read, the set `read` reads (`readableTaskIds`), found as
  `read` finds a handoff: the named attempt's, else the latest's.
- **It merges into the caller's own worktree**, from the worktree's root, with
  `git apply --3way --whitespace=nowarn`, which stages what it applies. At the
  commit the patch was taken against it reproduces the explorer's tree, mode
  for mode. At a later commit it merges with what has landed since. Ordewell
  runs this git as the user, like its other git in a change task's worktree,
  with fsmonitor off. It is not sealed: the worktree is the caller's own,
  which can already run anything.
- **Before the real apply, Ordewell checks what it would write:**
  - *Its headers.* The patch names no link or submodule, as at the capture,
    since git creates whichever a header names.
  - *The index it would leave.* That is only the first look: a section with
    no mode line takes its path's mode from the index, so it can edit or
    rename a link the repository tracks, and keep it a link, without naming
    one; and git patches the path a section's `---` and `+++` lines name,
    which its first line need not. So Ordewell runs the same apply against a
    copy of the index, which writes no file, and refuses if the copy holds a
    link or a submodule the index does not, whichever path or header said so.
    A trial git stops, short of a conflict, refuses the apply in git's words:
    it leaves the copy as it was, so it says nothing of what the real apply
    would write, and the real apply writes the patch's earlier files before it
    stops at the same place. Git older than 2.32 takes no `--cached` with
    `--3way`, so there every apply is refused this way.
  - *Each path, on disk.* Git checks a path's leading directories for a link
    in the index alone, and the links the bootstrap puts in a task's worktree
    are in no index: `.claude` and each mirrored `node_modules` entry lead into
    the user's own checkout, where a `.claude/settings.local.json` carries
    hooks. So every path whose entry the copy changed, new, renamed, copied,
    deleted or merged, and every path git parses from the patch, on either side
    of a rename or a copy, is walked under the worktree with no link followed.
    It is refused under a link; under a submodule the index holds, which on
    disk is a directory like any other; or under something that is not a
    directory, except a file the patch itself removes to put a directory in
    its place.
  - *Each path, by name.* A path at or under a name Ordewell linked in
    (`IsolationTaskRepo.linked`) is refused whatever is on disk there, compared
    without case, since a case-insensitive file system finds a link by any
    spelling of its name and landing would drop it.
- **What came of it is read from the index, never predicted.**
  `git apply --check --3way` returns 0 for a patch that then conflicts. After
  the apply, the paths the index holds unmerged are the conflicts:
  - *Applied*: nothing is unmerged. The answer says the changes are staged,
    whether the worktree is at the patch's base, and, past it, that the
    author's checks ran at the other commit.
  - *Conflicted*: the answer names each path, and a binary one as binary,
    which holds no conflict markers. The other files are applied and staged;
    the conflicted ones hold their markers for the task to settle and
    `git add`. The apply is not an error.
  - *Refused*: git applied none of it. That is what git does for a patch that
    deletes or adds a file the worktree has changed, and for a patch to a file
    the task has changed and not yet staged. The answer gives git's errors,
    and the file the patch is in, to apply by hand.
  - *Stopped*: git wrote some of the patch's files and then stopped at one it
    could not write, such as a file where the task has a directory of its
    own. Git stages only at the end, so nothing is staged. Ordewell reads
    the patch's paths on disk before and after, so the answer names each one
    git changed, left as git wrote it, and says how to put it back. A failed
    apply is called *Refused* only when none changed.
- **It refuses, applying nothing,** a task outside the readable set, a task or
  attempt that saved no patch, a patch whose file is gone or whose size or
  SHA-256 is not the artifact's (cut short, or changed since), a patch that
  would create or change a link or a submodule, a patch that would write a
  path under a link, a submodule or something that is not a directory, or at
  or under a name Ordewell linked in, a patch git will not apply to a copy of
  the index short of a conflict, a call from a read-only task,
  a caller with no worktree of its own or one across several repositories, a
  base commit this repository does not have, and a worktree that still holds
  an earlier conflict.
- **A patch is another task's work.** The answer says to read what it changed
  and to run the checks, since the author ran its own at its base. Git itself
  refuses a path into `.git`, in any spelling, and one under a link the index
  holds; the links on disk are Ordewell's to check. Nothing applies on its
  own: a call is the caller's.
- **Nothing is committed.** The staged changes land with the task's own work,
  as everything in its worktree does.

### What is carried, refused and flagged

| The worktree has | The patch |
|---|---|
| new, changed, deleted, renamed or binary files, or a changed mode | carries them |
| a path Ordewell linked in (`IsolationTaskRepo.linked`: `.env*`, `node_modules`, `.claude`, a user's `worktreeLinks`) | leaves it out by name, as the landing commit does, whatever it is on disk |
| any other symbolic link, or a submodule | leaves it out, flagged `excluded` |
| a file whose part of the patch is over 1 MiB, or the largest files once the whole would pass 8 MiB | drops it, flagged `dropped` with its size |
| a file git converts on the way in (its `text`, `eol`, `filter` or encoding attributes) | carries it as git stores it, flagged `normalized`: those bytes differ from the worktree's |
| a new path that differs from another only in case, such as a case-only rename | refuses the save |
| a file git cannot read | refuses the save, in git's words |
| ignored files and empty directories | leaves them out, as any commit would |

A patch that holds a link or a submodule anyway is refused, at the save and at
the apply. The apply refuses more: a patch that would change a link the
repository tracks, though a capture never carries a change to one, only its
deletion; a path under a submodule, which git stages nowhere; and a path under
a link in the worktree, or at or under a name Ordewell linked in, which a
capture leaves out by name.

A file's part is measured in the patch that is saved, not on disk. A small edit
to a large file counts as small, and so does a large file that only moved,
which the patch holds as a rename. A removal and an addition the patch pairs as
a rename are kept or dropped together, as the one file the patch holds.

### Where it is kept, and who reads it

- **The file** is `<attempt>.patch` beside the attempt's *Task log*, in
  `.ordewell/sessions/<session>/tasks/<task>/`. It is written whole under
  another name first, and it goes with the session.
- **The artifact** is a fifth kind, `patch`, that only Ordewell adds:
  `{kind: 'patch', path, attempt, base, files, added, removed, binary, bytes,
  sha256, flags?}`. A file whose type changes is one file there, as the
  patch's file list has it.
  - It comes after the author's own artifacts and outside their limit.
  - It is added whatever the verdict, and an attempt that ended without a
    *Completion call* still hands it on.
  - It is in the plan's digest, so `read`, `task_query` and every surface
    name it. A row says it and its lines added and removed; the attempt's log
    block adds the base commit, the file to open and every flagged path. One
    view in core words those facts for the TUI, the VS Code webview and the
    CLI, and each surface offers its own way to open the file.
- **The planner's `task_diff`** reads the patch for a task whose handoff names
  one: the file list with line counts, or one file's part. It still runs no
  git in a read-only worktree. It shows the file only while its size and
  SHA-256 are the artifact's, as `apply_patch` checks them, since a change
  task's commands can write the session's directory.

### Choosing among explorers

Evidence eliminates, judgment picks among those left, and core is bound by no
pick.

- **The check.** Before the explorers start, the planner fixes one check, the
  same for each. An explorer that fails it is out. Exactly one that passes
  needs no pick; none that passes means the round failed.
- **The judge.** Two or more that pass are a tie on evidence. A read-only judge
  task that depends on every explorer reads their handoffs with `read`,
  and the patch files they name with its runner's own reads, which reach the
  workspace. It recommends one in a finding, and a finding is advice
  (ADR-0047).
- **The pick.** The planner proposes the build task on the recommended patch,
  and approving that task is the pick:
  - in the user's own turn, the user's, since a task added after the plan's
    approval is not approved to run;
  - at Act, the supervisor's, whose added tasks count as approved
    ([ADR-0029](../supervision/0029-the-supervisor.md));
  - at Watch, nobody's: the supervisor only suggests.

No field records the pick, and core reads nothing from the judge.

## Key properties

- **Git reads a tree a sealed run wrote only inside the seal.** Outside it, git
  would run as the user with the tree's own `.gitattributes`, filters and
  untracked files. It would also freshen the repository's existing object
  files.
- **A patch is not a verdict, and lands nothing.** It records what the task
  changed. A task passes or fails on its completion call alone.
- **The artifact is Ordewell's, not the author's.** A completion call's
  artifacts stay the four kinds of evidence. A `patch` artifact is written only
  from a capture that replayed.

## Testing decisions

- **The rules.** `PatchCapture` is tested through `capturePatch` with real git
  in throwaway repositories, a plain shell standing in for the sealed runs.
  Each rule is shown on git's own output: carried, excluded, dropped,
  normalized and refused. So is a refusal when a sealed run swaps one of the
  capture's files for a link, when a replay differs, and when the patch is
  rewritten in scratch to hold a link or a submodule; the counts are then those
  of the bytes read.
- **End to end.** `PatchCapture.e2e.test.ts` runs the capture through a real
  task shell in the host's sandbox. It applies the patch outside the sandbox,
  in a fresh worktree at the same base, and compares every file and mode. CI's
  Linux sandbox job runs it under bubblewrap with `ORDEWELL_REQUIRE_SANDBOX`.
- **Applying.** `PatchApply.e2e.test.ts` captures a patch with the real
  capture and applies it with real git: at the same base, to an identical
  tree; at a base that moved, merging cleanly, with a rename carrying the
  other work's edit; and at a base with conflicting work, where the conflicts
  are named, a binary one as binary, and the worktree holds the markers.
  It also shows a hand-written patch refused, applying nothing, when it edits,
  renames or copies a link the repository tracks with no mode line to say so,
  or names another file in its first line than in its `---` and `+++` lines,
  and the capture's own deletion of that link applied. And it shows one
  refused, with nothing changed in the worktree, its index or the directory a
  link leads to, when it creates or renames a file under an untracked link
  out of the worktree (`.claude`, a mirrored `node_modules` entry), under a
  case variant of a linked name, under a linked name with nothing on disk
  yet, or under a file; when it makes a directory a link and writes beneath
  it; under a submodule; when a path holds `.git` in any spelling; when a
  write under `.claude` comes before a path git refuses only as it stages it;
  and when a git older than 2.32 cannot run the trial, simulated. A patch
  that removes a file and puts a directory in its place still applies, and
  one that git stops part way is answered with the files it wrote.
  `PatchApply.test.ts` shows what is refused before git runs, a patch with a
  link or a different hash among it, and how each outcome is worded.
- **The seams around it.** `taskShell.test.ts` covers `TaskShell.hold` with the
  recording backend. The orchestrator's side, the artifact in the handoff
  whatever the verdict, uses `FakeWorktreeIsolation`, and so does the apply's
  refusal of a path under a name the attempt's record says was linked in.
  Which token is offered the tool is asserted at the MCP server test seam.

## Out of scope

- A repo group's several repositories.
- Candidate change tasks: see below.

## Considered options

- **Candidate change tasks, held unlanded until one is chosen.** Several change
  tasks whose passes stop at `Landing.landPassed`: a new `held` landing outcome
  and isolation status, a `choice` waiting reason, and a choose command that
  lands the winner and keeps the losers on preserved branches. Deferred:
  - it touches about fifteen core files and every surface;
  - loops, Mark complete, retries and crash recovery each need a rule of
    their own;
  - what is judged can differ from what lands, once the winner's merge needs
    a repair.

  A patch carries the same prototype as one file and one artifact, and the
  builder applies and retests it at the current base. Candidates remain the
  way for a prototype that needs services the seal withholds, or one that
  other tasks must build on before the choice.
- **A recipe the explorer writes and runs itself, with no tool.** Rejected: the
  plain diff silently drops new files, and `git add` fails in the seal. The
  recipe that works needs a private index and object store, and a case-only
  rename, a link into the main checkout and an unreadable file each break it
  in its own way. A model told to follow it gets one of those wrong silently,
  and Ordewell would keep whatever file it named.
- **Ordewell running git in the worktree outside the seal.** Rejected: that is
  git as the user in a tree a sealed run wrote, with its `.gitattributes`,
  filters and untracked files, which ADR-0046 refuses `task_diff` and release
  for. Outside the seal, git also freshens the repository's existing object
  files.

## Consequences

- An explorer's prototype outlives its worktree. A judge reads it, and a
  builder that depends on the explorer finds it named in its handoff.
- A save costs two sealed runs, and each walks the worktree for links, as
  every sealed run does.
- A patch is taken against the commit the explorer's worktree was cut from. One
  applied after other work has landed may conflict, and the test results it
  was saved with were for that base.
- What a patch holds is the task's doing. Whoever applies it treats it as
  untrusted content, as they treat a report.
- A file ignored only by the user's global gitignore is not ignored inside the
  seal, whose home is the task's scratch directory, and the capture reads no
  global git configuration.
- The apply runs unsealed, so its checks are all that keep a patch inside the
  worktree. Running it sealed, writing only the worktree and the repository's
  git directory, would make a write outside impossible by construction, and
  is the follow-up. It is not done here: every sealed profile withholds the
  repository's git directory by design (ADR-0046), where the apply writes the
  index and the merge's objects; a change task holds no sandbox to run it in;
  and a host with none (Windows, Linux without bubblewrap) would still rely on
  the checks.

## History

- 2026-10-24 — accepted; the capture, the kept patch, its artifact and `task_diff` implemented.
- 2026-10-24 — a change task's `apply_patch` implemented.
- 2026-10-24 — the TUI, VS Code and CLI show a saved patch: its changes, the file to open and the paths it left out.
- 2026-10-24 — the planner's guidance implemented: the explore skill, `WHO EXPLORES` and the read-only task's own prompt teach `save_patch`, the shared check and `apply_patch`.
- 2026-10-24 — a review's fixes: Ordewell judges the saved patch on the bytes it reads (no link or submodule, counts and a SHA-256 taken from them, checked again at the apply), measures a rename as one section, and reads no global git configuration.
- 2026-10-24 — the apply asks git, against a copy of the index, what the patch would leave, so a patch with no mode line cannot retarget a link the repository tracks.
- 2026-10-24 — the apply refuses a path that would leave the worktree: under a link on disk, which git's check misses since it reads only the index, or at or under a name Ordewell linked in, in any case; sealing the apply is the follow-up.
- 2026-10-24 — a second review's fixes: the apply refuses a patch whose trial git stops, walks every path git parses from the patch, refuses a path under a submodule, and answers *Stopped* with what git changed on disk; `task_diff` checks the patch's size and hash.
- 2026-11-01 — the task tool is `read` ([ADR-0057](../supervision/0057-information-moves-by-reference.md) R11).
