# 0011 — Sandboxing the planner's shell

**Status:** accepted (2026-10-01; first proposed as a tracked deferral)

`commandPolicy.ts` decides which commands the planner's `bash` tool may run,
lexing the string and classifying it per segment as `auto` (runs silently),
`ask` (needs approval) or `refuse` (never runs). [ADR-0008](0008-planner-exploration-envelope.md)
covers that design and its properties in full.

A classifier is a denylist over a real shell. It can be wrong about a specific
command — a flag it didn't anticipate, a wrapper it doesn't recognize, a
multiplexer subcommand that writes where its siblings read — and every such
gap is a real bug, tracked and fixed like any other. But no amount of fixing
changes what the mechanism fundamentally is: every binary the classifier
permits keeps its own, unmediated ability to open files for writing and to
execute further programs. `auto` and `ask` are judgments about a command
string, not sandboxing of the process that string becomes. The classifier is
the only thing standing between the planner and the filesystem, which means
its failure mode — a gap discovered after the fact, by us or by a report — is
also unmediated.

This repo's planner already spawns coding-agent *runners* (Claude Code, Codex,
OpenCode) to do the actual mutation, on the thesis that mutation belongs to a
sandboxed, supervised process rather than to the planner itself. One of those
runners already lives up to that thesis for its own shell: Codex requires an
OS-level sandbox to start at all. `codexSandbox.ts` probes for bubblewrap
(Linux) or Landlock as a fallback, refuses to run with neither, and the reason
that check exists is exactly this document's problem — a classifier or
approval policy that is merely correct is not the same guarantee as a kernel
that will not allow the write in the first place ([ADR-0009](0009-coding-agents-as-planners.md),
`codexSandbox.ts`). The planner's own shell has no equivalent. This ADR gives it one: not instead
of the classifier, but underneath it, so that a classification gap degrades to
"an unapproved command ran" instead of "an unapproved command wrote."

The first version of this ADR deferred the work as three platforms' worth of
plumbing. Two things changed. The classifier needed two amendments to ADR-0008
on consecutive days (2026-09-27 and 2026-09-28), each a case where it read a
different command from the one the shell ran, which is the failure this ADR
predicted and which will keep recurring. And the work is smaller than the
deferral assumed: the planner only ever reads, so one fixed policy covers every
command, with no per-command sandbox rules to derive.

## Decision

**Run every command the planner's `bash` tool starts inside an OS sandbox
where one is available, under one fixed policy: nothing outside a scratch
directory can be written.** The classifier, its tiers and everything in
ADR-0008 stay as they are.

## Key properties

- **Underneath the classifier, never instead of it (B1).** `auto` commands, and
  `ask` commands once approved, run sandboxed. `refuse` still refuses. A
  sandboxed command is not trusted any more than before. The sandbox only
  bounds what a misclassified one can do.
- **One policy, not one per command (B2).** The whole filesystem is mounted
  read-only. One scratch directory per session is writable and set as
  `TMPDIR`. Tools that write caches or locks as a side effect of reading are
  pointed at it or told not to write (`GIT_OPTIONAL_LOCKS=0`, and the build
  caches the implementation finds are needed, such as `GOCACHE`). The sandbox
  does not narrow *reads*: read confinement stays ADR-0008's path check and
  prompt, because an approved read outside the workspace has to work.
- **Network follows the tier (B3).** An `auto` command gets no network. An
  approved `ask` command keeps the network, still without writes. The
  classifier already sends network-reaching commands (`git ls-remote`, `gh`,
  `curl`) to `ask`, and the user approved that one. Research subagents never
  prompt (ADR-0008 T6), so all their commands run without network. The web
  fetch tool is not a shell command and is unaffected.
- **Per platform (B4).** Linux: bubblewrap (`--ro-bind / /`, a fresh `/dev`
  and `/proc`, the scratch directory bound writable, `--unshare-net` for
  `auto`, `--die-with-parent`). macOS: `sandbox-exec` with a profile that
  denies `file-write*` outside the scratch directory, and `network*` for
  `auto`. Windows: no sandbox (see B5).
- **Probed once, visible when absent (B5).** The first command probes the
  sandbox with a trivial command, the way `codexSandbox.ts` probes Codex's.
  Where it cannot start (no `bwrap`, Ubuntu 24.04's
  `kernel.apparmor_restrict_unprivileged_userns=1`, Windows), commands run on
  the classifier alone, and the planner surface says so once, the way
  `researchShellWarning` reports a degraded shell. Planning is not blocked:
  the classifier alone is what every platform has today.
- **The seam is `ResearchShell` (B6).** The sandbox wraps the shell
  `resolveResearchShell` returns: the launcher and its policy become the
  `file` and leading `args`, followed by the POSIX shell. `commandPolicy` keeps
  reading `dialect` and classifies exactly the string that runs.
- **It does not widen anything (B7).** A sandboxed shell is not a reason for
  fewer prompts or more `auto` commands. Relaxing the classifier because a
  sandbox exists would widen ADR-0008's envelope, and that needs its own ADR,
  which would also have to account for the platforms where B5 applies.
- **Scope (B8).** This covers the shell behind the API planner's `bash` tool and
  its research subagents. Harness planners keep their own read-only modes
  (ADR-0009), and runners are scoped by their mode (ADR-0001).

## Considered options

- **Keep it deferred until all three platforms have a backend.** That is how
  this ADR was first written. Rejected: it leaves Linux and macOS users without
  a guarantee their OS can give, waiting on a primitive Windows does not have.
- **Weaken the guarantee uniformly instead of per platform (N2).** Rejected:
  matching every platform down to Windows's ceiling throws away a real,
  available guarantee on Linux and macOS for a consistency that doesn't serve
  the user. ADR-0010 applied the same reasoning to Codex's read-only guarantee
  rather than pretending it was uniform across platforms.
- **Refuse to plan with an API model when no sandbox is available.** Rejected:
  it would make the API planner unusable on Windows and on stock Ubuntu 24.04
  while protecting nothing that today's classifier doesn't already cover there.
  The visible notice (B5) says what's missing instead.
- **Landlock on Linux.** It needs no user namespace, so it would survive
  Ubuntu 24.04's restriction. But Node cannot apply it to a child process
  without a helper binary, and shipping a native helper is a packaging cost
  this change doesn't justify. Worth revisiting if B5 turns out to hit most
  Linux users.
- **A per-command policy derived from the classifier.** Rejected: the planner
  never needs to write, so a command-specific policy adds a second classifier
  to keep correct and buys nothing over B2.
- **A third-party sandbox wrapper library.** It would cover bubblewrap and
  Seatbelt, but adds a dependency to a core that deliberately keeps few, for
  something that is two command lines and a probe.
- **Replace `bash` with in-process read tools only.** Rejected for the reasons
  ADR-0008 gives for keeping a real shell: the planner's research needs the
  project's own tooling (`git log`, `npm ls`, `cargo metadata`), which no fixed
  tool set reproduces.
