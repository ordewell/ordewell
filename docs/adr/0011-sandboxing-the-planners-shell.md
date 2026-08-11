# 0011 — Sandboxing the planner's shell

**Status:** proposed

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
`codexSandbox.ts`). The planner's own shell has no equivalent. This ADR tracks
giving it one: not instead of the classifier, but underneath it, so that a
classification gap degrades to "an unapproved command ran" instead of "an
unapproved command wrote."

## The problem

Wrap every process the planner's `bash` tool starts — `auto` and `ask` tier
alike, once approved — in an OS-enforced sandbox that denies filesystem writes
and outbound execution outside what the tool call itself needs, independent of
what `commandPolicy.ts` classified the command as. This makes the classifier
defense in depth rather than the only line: a bypass becomes a contained
failure instead of an unmediated one.

## Options across supported platforms

Ordewell supports Linux, macOS and Windows ([ADR-0010](0010-windows-support.md)).
The primitives are per-OS, the same way Codex's own sandbox selection already is:

- **Linux — bubblewrap or Landlock.** The same two backends `codexSandbox.ts`
  already probes for Codex's benefit. Landlock is an LSM and needs no user
  namespace, which matters because the exact namespace restriction that
  motivated `codexSandbox.ts` (`kernel.apparmor_restrict_unprivileged_userns=1`
  on Ubuntu 24.04) would otherwise disable this for the planner too. Reusing
  the probe rather than assuming bubblewrap is available is the one piece of
  prior art this ADR takes as settled rather than open.
- **macOS — Seatbelt (`sandbox-exec`).** What Codex's own sandbox uses on this
  platform. Deprecated-but-present, no replacement API ships as a stable
  public alternative for this use case.
- **Windows — no equivalent primitive.** There is no OS-enforced, unprivileged,
  per-process filesystem/exec sandbox on Windows comparable to Landlock or
  Seatbelt. `codexSandbox.ts` and ADR-0010 already document this as an open
  gap for Codex's own guarantee (`sandbox: 'read-only'` there may be enforced
  by Codex's tool layer rather than by the kernel, and nobody has verified
  it). AppContainer and Windows containers exist but need elevated setup,
  packaging, or both — not the "spawn a subprocess" cost this feature has
  everywhere else. Whatever ships here has to either accept a materially
  weaker Windows guarantee (documented as such, the way Codex's is) or block
  the feature on Windows entirely; both are real options and neither is
  free.

## Why tracked, not shipped now

This is a substantial piece of cross-platform work — three different
enforcement primitives, one of which doesn't exist on a supported platform —
for a control this repo can currently only get today by reusing an existing
probe, not by building new plumbing. Recorded here explicitly so it doesn't
read as an oversight next to `codexSandbox.ts`'s Codex-only guarantee. It is
out of scope for the current release; see the security policy's [command
policy bypass](../../SECURITY.md) note for how this ADR relates to what the
classifier does and doesn't guarantee in the meantime.

## Considered options

- **Ship Linux-only, block on macOS/Windows until their backends land (N1).**
  Rejected for now, not permanently: it's the shape a real implementation
  would likely take, but it's still a shipped feature with a partial
  guarantee, and this ADR is tracking the decision to defer building any of
  it, not choosing between rollout shapes for a build that hasn't started.
- **Weaken the guarantee uniformly instead of per-platform (N2).** Rejected:
  matching every platform down to Windows's ceiling throws away a real,
  available guarantee on Linux and macOS for a consistency that doesn't
  serve the user — the same reasoning ADR-0010 already applied to Codex's
  read-only guarantee rather than pretending it were uniform across
  platforms.
