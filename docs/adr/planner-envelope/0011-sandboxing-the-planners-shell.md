---
status: accepted
---

# 0011 — Sandboxing the planner's shell

## Problem

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
OS-level sandbox for its own shell. `codexSandbox.ts` probes for bubblewrap
(Linux) or Landlock as a fallback, switches Codex's shell off with neither
([ADR-0033](0033-codex-planner-without-its-sandbox.md)), and the reason
that check exists is exactly this document's problem — a classifier or
approval policy that is merely correct is not the same guarantee as a kernel
that will not allow the write in the first place ([ADR-0009](../planner/0009-coding-agents-as-planners.md),
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
ADR-0008 stay as they are, but for one change a verified sandbox makes:
a command the envelope would refuse without asking runs sealed instead
([ADR-0036](0036-the-planners-shell-sealed-runs-and-native-opt-in.md)).
On macOS two things escape that policy, because no Seatbelt rule gates them:
a command's reach through the bootstrap port into the user's existing launchd
jobs, and its reading of other processes' command lines and environments (B4).

- **Underneath the classifier, never instead of it (B1).** `auto` commands, and
  `ask` commands once approved, run sandboxed under this policy. A `refuse`
  command, and one the approval mode refuses without asking, does not run
  under it: it runs sealed, under ADR-0036's stricter profile of the same
  backend (the workspace read-only, no home directory, no network), or, where
  no sealed run can start, is refused. A sandboxed command is not trusted any
  more than before. The sandbox only bounds what a misclassified one can do.
- **One policy, not one per command (B2).** The whole filesystem is mounted
  read-only. One scratch directory per session is writable and set as
  `TMPDIR`: made under the OS temporary directory, private to the user, on
  the session's first command, and removed when the session ends or resets,
  or by the next Ordewell process when the one that made it was killed.
  Tools that write caches or locks as a side effect of reading are pointed at
  it or told not to write: `GIT_OPTIONAL_LOCKS=0`, npm's cache (where it logs
  every command) and update check, `GOCACHE`, `XDG_CACHE_HOME`, Python's
  bytecode, and on macOS the lookup cache of Apple's `/usr/bin` shims
  (`xcrun_db`). The sandbox does not narrow *reads*: read confinement stays
  ADR-0008's path check and prompt, because an approved read outside the
  workspace has to work.
- **Network follows the tier (B3).** An `auto` command gets no network. An
  approved `ask` command keeps the network, still without writes. The
  classifier already sends network-reaching commands (`git ls-remote`, `gh`,
  `curl`) to `ask`, and the user approved that one, or the allowlist or the
  approval mode did. An `auto` command approved only for an outside path it
  names is still `auto`. Research subagents never prompt (ADR-0008 T6), so
  all their commands run without network. Without the network a command also
  cannot reach the local services that would write on its behalf, but for
  launchd on macOS (B4): the profile denies unix sockets with the rest of the
  network, and on Linux, where a socket that is a file survives
  `--unshare-net`, the user's runtime directory (its session bus), the system
  bus, the X server's socket directory and the Docker socket are hidden. An approved command keeps them,
  since its credentials may live behind the session bus. The web fetch tool
  is not a shell command and is unaffected.
- **Per platform (B4).** Linux: bubblewrap (`--ro-bind / /`, a fresh `/dev`
  and `/proc`, the scratch directory bound writable, `--unshare-net` for
  `auto`, `--die-with-parent`), in a PID namespace of its own, which an
  unprivileged `--proc` needs and which keeps out the host's
  `/proc/<pid>/root` links into a writable mount namespace; in a session of
  its own, with no terminal to type into; and with the host's System V IPC
  out of reach. Bubblewrap arms `--die-with-parent` only after setting the
  sandbox up, so a Stop in those milliseconds would leave the command running
  with no caller. Every command therefore starts behind `/bin/sh` and a small
  watcher outside the sandbox, which then becomes bubblewrap; the watcher looks
  once a second, and when the launcher has gone it kills what carries the
  launcher's mark (ADR-0036 S1). A host with no `sleep` runs the command without
  the watcher, since this is a window of milliseconds and losing the sandbox
  over it would be the worse failure. The `bwrap` used is the distribution's
  before one found on PATH. macOS: `sandbox-exec` with a profile that denies everything by
  default and allows every read, writes to the scratch directory and the
  device files a shell needs, the network for an approved command, and of the
  system services only those a read needs, with name resolution, TLS trust
  and the keychain added for an approved command; `defaults write`, for one,
  is refused, because cfprefsd checks the caller's sandbox. Loading a launchd
  job is denied (`job-creation`), since launchd would run it outside the
  sandbox, as the user. Two things no Seatbelt rule gates stay open: launchd's
  existing jobs, which a command can read, start, unload and enable or disable
  through the bootstrap port it inherits, and `sysctl`'s reading of other
  processes' command lines and environments (ADR-0036 lists them, and the
  here-document files). Every path
  reaches the launcher as an argument of its own (a `-D` parameter to
  Seatbelt), never as policy text. Windows: no sandbox (see B5).
- **Probed once, visible when absent (B5).** The first command probes the
  sandbox with a trivial command under the stricter of the two profiles, the
  way `codexSandbox.ts` probes Codex's, and the answer is kept for the
  process. Where it cannot start (no `bwrap`, Ubuntu 24.04's
  `kernel.apparmor_restrict_unprivileged_userns=1`, Windows), commands run on
  the classifier alone, refusals stay refusals, and the planner surface says
  so once per session, through the session's notice, with the cause, the fix
  and that loops and scripts are refused for that reason. Planning is not
  blocked: the classifier alone is what every platform had before this. The
  sealed profile is probed next, with a throwaway overlay over the workspace
  and then without; where neither starts, the sandbox still runs and the same
  one notice says sealed runs are unavailable. Where the sandbox runs but one
  command cannot be put in it, that command does not run.
- **The seam is `ResearchShell` (B6).** The sandbox wraps the shell
  `resolveResearchShell` returns: the launcher and its policy become the
  `file` and leading `args`, followed by the POSIX shell. `commandPolicy` keeps
  reading `dialect` and classifies exactly the string that runs. Behind it
  sits one `SandboxBackend` (`services/sandbox/`), which turns a shell and a
  `SandboxProfile` (what may be written and read, a throwaway overlay, the
  network, the environment and what is kept of the host's, resource limits)
  into what to spawn. A backend refuses a
  profile it cannot enforce rather than run under less. A sandbox shares no
  state with another and needs no daemon, so a container, microVM or hosted
  backend is another implementation of the interface.
- **It widens one thing, and nothing about the tiers (B7).** A sandboxed
  shell is not a reason for fewer prompts or more `auto` commands: what the
  classifier allows or asks about runs under this policy, asked about as it
  would be without a sandbox. The one change a verified sandbox makes is
  ADR-0036's: a command the envelope would refuse without asking runs sealed
  rather than refused, and a `!` exclusion or a person's denial still
  refuses. Where B5 applies, a refusal is a refusal.
- **Scope (B8).** This covers the shell behind the API planner's `bash` tool,
  its research subagents, and the harness planners' `run_command`, which is the
  same shell ([ADR-0026](0026-one-envelope-for-every-planner.md)). Runners are
  scoped by their mode (ADR-0001).

## Testing decisions

Each backend's arguments are built by `wrap`, which starts nothing, tested per
platform with the platform and the probe injected, the way
`resolveResearchShell`'s tests inject `ResearchShellDeps`. The sandbox itself
is tested on the host: on macOS, and on Linux where bubblewrap starts, the
tests write outside the scratch directory, reach a local socket with and
without the network, and run the read commands; elsewhere they skip, naming the
probe's reason. CI installs bubblewrap on its Linux runner and lifts Ubuntu's
user-namespace restriction the way
[troubleshooting](../../troubleshooting.md#planner-shell-not-sandboxed) tells a
user to, then runs those suites with `ORDEWELL_REQUIRE_SANDBOX=1`, so a host
that still cannot start the sandbox fails the build instead of skipping.

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
- **A Seatbelt profile that allows by default and denies writes.** Rejected:
  checked on macOS 26, a command under it could not write a file but ran
  `defaults write`, which cfprefsd carried out, and every other service that
  writes on request (LaunchServices, Apple events) stays reachable.
- **A seccomp filter against unix sockets on Linux.** It would close every
  socket that is a file for a command without the network, where hiding the
  known services closes those alone. Not taken now: bubblewrap takes it as a
  compiled program on a file descriptor, which needs a filter per
  architecture and a spawn that passes extra descriptors. Worth revisiting if
  another local service turns out to act for its callers.
- **Replace `bash` with in-process read tools only.** Rejected for the reasons
  ADR-0008 gives for keeping a real shell: the planner's research needs the
  project's own tooling (`git log`, `npm ls`, `cargo metadata`), which no fixed
  tool set reproduces.

## Consequences

- A misclassified command can no longer write outside the scratch directory
  where a sandbox runs; on hosts without one, nothing changes and the notice
  says so.
- On macOS, setuid programs such as `ps` and `top` cannot start, since the
  kernel will not run one in a sandbox, and macOS's `/bin/sh` (bash 3.2) writes
  a here-document to `/tmp` whatever `TMPDIR` says, so its own temporary file
  names there are the one file write allowed outside the scratch directory,
  and a channel to the user's other processes that use them. On Linux, a
  process listing shows only the sandbox's own processes.
- On macOS a command can also read what the user's other processes hold in
  their command lines and environments, and read, start, unload, enable and
  disable the user's existing launchd jobs, in the sandbox sealed or not.
  Neither is gated by a Seatbelt operation, and macOS has no seccomp to
  filter the call. Linux's PID namespace hides other processes, and launchd
  is macOS's alone. ADR-0036 states what that does to a
  sealed run's guarantees; a container or VM backend (#99) and the egress
  proxy (#88) are what is planned to close or bound them.
- A tool that has to write to read fails: `cargo metadata` on a crate without
  a committed `Cargo.lock` writes one beside the manifest.
- An approved command keeps the network, and with it every local service:
  the keychain service on macOS, which also takes writes, and a local daemon
  such as Docker. That is what approving a networked command trusts it with,
  until the egress proxy (#88).

## History

- 2026-10-01 — accepted.
- 2026-10-10 — `curl`/`wget` approved per origin and refused in Full; an
  egress filtering proxy through this sandbox's network namespace planned as
  phase 2 ([ADR-0027](0027-web-reads-in-the-planner-envelope.md)).
- 2026-10-13 — a Codex planner whose own sandbox cannot start has its shell switched off, leaving `run_command` as its only shell ([ADR-0033](0033-codex-planner-without-its-sandbox.md)).
- 2026-10-20 — implemented (#64): bubblewrap on Linux and Seatbelt, closed by default, on macOS, behind one `SandboxBackend`; a scratch directory per session; local service sockets hidden from commands without the network.
- 2026-10-21 — a command the envelope would refuse without asking runs sealed under a stricter profile of the same backend, and the notice says loops and scripts are refused where none starts ([ADR-0036](0036-the-planners-shell-sealed-runs-and-native-opt-in.md), #109).
- 2026-10-21 — the macOS backend's residuals recorded: job creation denied, existing launchd jobs and other processes' command lines and environments not gated ([ADR-0036](0036-the-planners-shell-sealed-runs-and-native-opt-in.md)).
- 2026-10-21 — CI runs the real-sandbox suites on Linux with bubblewrap installed and Ubuntu's user-namespace restriction lifted, failing rather than skipping where the probe cannot start.
- 2026-10-31 — every command on Linux starts behind the launcher's watcher, so one a Stop catches while bubblewrap sets up dies with its launcher, as a sealed run does (ADR-0036 S1).
