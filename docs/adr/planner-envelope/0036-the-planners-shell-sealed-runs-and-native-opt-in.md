---
status: accepted
amends: ["0008", "0011", "0026"]
---

# 0036 — The planner's shell: sealed runs instead of refusals, and the harness's own shell as an opt-in

*Pending:* [ADR-0056](../supervision/0056-a-mandate-narrows-down-the-tree.md) — S5 holds for a subplanner, whose requests run sealed as a research subagent's do.
*Pending:* [ADR-0059](../isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md) — the broker and the lease this ADR defers to; stage 3 stays open, and native tools inside a lease do not arise while planners stay on the host.

## Problem

The classifier refuses what it cannot read: a shell keyword (`for`, `while`,
`if`), inline code for an interpreter, code piped into one, output
redirection, a computed command name (ADR-0008). Each refusal tells the planner
to run the inner command directly or describe it as a task. So a planner
cannot loop over files, reshape an output with a few lines of Python, or keep
an intermediate result in a file, all of which are ordinary steps in
research, and "describe it as a task" turns a read into a runner session.

Teaching the classifier these constructs would have it read more of a language
it already misreads. ADR-0008's history is mostly cases where it judged a
different command from the one the shell ran, and ADR-0011 expects more of
them. The classifier is the right gate for commands that need the user's
environment (the network, credentials, files outside the workspace). It is the
wrong tool for making arbitrary local computation safe.

ADR-0011 runs every planner command in an OS sandbox where the platform has
one, and (B7) leaves relaxing the classifier because of it to an ADR of its
own. With nothing writable but a scratch folder, no network and no home
directory, a command can compute anything and change nothing (on Linux
without exception; macOS keeps three residuals, below), and whether the
classifier can read it stops mattering.

Separately, harness planners' own shells are withheld (ADR-0026): every
command goes through `run_command`. Each harness is built around its own shell
tool, and some users want their planner to use it.

## Decision

**Where the planner's sandbox runs, a command the envelope would refuse
without asking runs sealed instead: with the workspace read-only, a scratch
folder writable, no home directory and no network. What the classifier allows
or asks about is unchanged, and where no sandbox runs a refusal is still a
refusal. Separately, a user may let a harness planner use its own shell, held
to the same limit on writes and with none of the user's credential stores in
reach.**

On Linux the profile below is the whole guarantee. On macOS it holds for files,
home directory, environment and network, and three things no Seatbelt rule
closes stay open to a sealed run ([What holds on Linux and on
macOS](#what-holds-on-linux-and-on-macos)).

### Sealed runs

- **The profile (S1).** On ADR-0011's backend (bubblewrap on Linux, Seatbelt
  on macOS): the workspace mounted read-only; the session's scratch folder
  writable and set as `TMPDIR` and `HOME`; outside the workspace, only what
  programs need to start (the system's executables, libraries and a minimal
  set of configuration files), and nothing of the user's home or any other
  repository; none of the environment Ordewell runs with beyond what programs
  need to find themselves and print (`PATH`, the locale), since credentials
  live there too; no network; a fresh `/dev`, `/proc` and `/tmp`; limits on
  processes, real memory, address space and wall time
  ([below](#the-limits-of-a-sealed-run)); and it dies with its parent. What it can
  read outside the workspace is fixed by the profile, the same for every
  command, and holds no user data (on macOS but for the here-document files
below), so no path is asked about. Where the
  platform offers a throwaway overlay, the workspace may be mounted with one
  instead of read-only, so a tool that writes a cache beside the code still
  runs; nothing written reaches the workspace either way. The profile takes
  one more writable directory as a parameter, none by default: a read-only
  task's sealed commands get its own throwaway worktree
  ([ADR-0046](0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)).
- **What runs sealed (S2).** A command runs sealed when the planner asks for
  it (`run_command` with `sealed: true`), or when the envelope would refuse it
  without asking: the classifier's `refuse`, or a command the approval mode
  refuses without asking (`allowlist`, which Full uses by default). In the
  sealed profile a write outside scratch fails and a network call fails, so a
  destructive command only reports an error. Everything else keeps ADR-0008
  and ADR-0026 as they are:
  the classifier, path confinement, the allowlist, the approval card under
  Guarded, and ADR-0011's sandbox with the network its tier gives.
- **What still refuses (S3).** A command a `!` exclusion names, sealed or not:
  an exclusion is the user's never. A command the user denied on the card: a
  denial is an answer, not a classification to route around.
- **The planner is told (S4).** The result says the command ran sealed and
  what that means (no network, the workspace read-only, no home), so a loop of
  `az` calls that fails on the network is understood rather than retried. The
  research timeline marks the step as sealed.
- **Research subagents get it too (S5).** A sealed run never asks anything,
  which is what a subagent needs (ADR-0008, T6): what would have asked runs
  sealed for them. So does a read-only task's `run_command`, from its own
  worktree (ADR-0046).
- **Where no sandbox runs (S6)**, on Windows or a Linux host without
  unprivileged user namespaces, a refusal is a refusal as today, and the
  planner surface's one notice (ADR-0011, B5) also says that loops and scripts
  are unavailable for that reason.
- **The classifier is not widened for convenience (S7).** A construct it
  cannot read is not taught to it to save a refusal; where a sandbox runs, it
  runs sealed. Fixes for commands it misreads go on as before.

### The limits of a sealed run

Part of S1. `SandboxLimits` holds four numbers, and only numbers from it enter
the script that runs before the sandbox, outside it.

- **Processes** are the kernel's limit, 256 beyond what the user runs now.
  macOS, and older Linux kernels, count them per user rather than per run, so a
  run's fork bomb can make the forks of another sealed run beside it fail until
  it ends. Processes of the user's that run outside a sealed run hold no such
  limit and go on.
- **Real memory** (`memoryBytes`, 4 GiB) is what the run actually holds. A
  watcher beside the launcher, outside the sandbox, sums resident memory about
  once a second: across the run's process group on macOS, and on Linux across
  its PID namespace, which no process can leave. Past the limit it ends the
  launcher by a signal, then the run. A signal rather than an exit status,
  which could be any command's own: only what runs outside the sandbox can
  send it, since Seatbelt lets a command signal its own sandbox alone and
  bubblewrap's namespace hides the launcher from it. The result then carries
  a note of its own (`sealedMemoryLimitNote`), as the wall-time limit does, in
  place of a note about reach. The watcher starts free of the kernel's limits,
  so a fork bomb at its process limit cannot stop it starting `ps` or `sleep`,
  and on Linux it finds `sleep` on a fixed path, since a PATH entry could name
  a directory the sandbox may write. Where it cannot run, the run does not.
- **Address space** (`addressSpaceBytes`, 256 GiB per process) is the kernel's
  limit too, a backstop against a runaway allocator and no measure of memory:
  on macOS it is added to what the shell already maps, as the process limit is
  to what the user runs. It is set far above what V8 reserves, by the
  measurements below.
- **Wall time** is the caller's clock: `SEALED_LIMITS` one minute,
  `TASK_SEALED_LIMITS` ten (ADR-0046).

The memory limit is a bound on what a run holds, not a guarantee to the byte.
A run can pass it by what it touches in the second between polls. A page
shared between processes counts once for each, which errs toward ending a run
early. On macOS a compressed page is not resident, and a process that left the
group with `setsid` is not counted; the address-space ceiling still holds it.
On Linux the pages of the run's own `/tmp` and overlay are held by a tmpfs and
by no process, so they are not counted either.

Measured on 2026-10-31 on macOS 26 (arm64, 10 cores, 32 GiB), Node 26.10.0,
under the real sealed profile with the address limit raised out of the way,
sampling the run's processes every 250 ms. A shell maps 421.4 GiB as it starts
there, and Node 1.5 GiB more; each `WebAssembly.Memory` adds 8 GiB of reservation
for a page of memory.

| Sealed command | Most address space in one process, over the shell's | Peak resident memory, summed | Processes |
| --- | --- | --- | --- |
| `vitest run` over one test file | 18.7 GiB | 0.8 GiB | 16 |
| `npm run build` (four packages, tsup with its DTS step) | 11.7 GiB | 1.8 GiB | 10 |
| `vitest run` over `packages/core` (9,598 tests, 164 s) | 18.9 GiB | 1.9 GiB | 23 |
| Node with 16 Wasm memories and 8 workers holding one each | 196 GiB | not sampled | 1 |

The 4 GiB limit this replaced as an address limit stopped the first two
outright. The ceiling is thirteen times what a test run reserves, and clears a
program built to reserve far more. Resident memory grows with a test runner's
workers, so a machine with many more cores than this one can pass 4 GiB where
this one held 1.9; the note tells the task to run fewer. Bubblewrap's limit
had the same shape, with no base added and the same reservations to fail on.
Linux was not measured: `scripts/linux-sandbox-e2e.sh` runs the same tests
under real bubblewrap.

What still fails is what S1 keeps out. On macOS a run cannot listen on a socket,
loopback included: 379 of those 9,598 tests failed sealed, nearly all because a
local server could not `listen`, and a few on writing the host's `/tmp`.

### What holds on Linux and on macOS

Linux's PID namespace leaves a sealed run no other process to look at, and its
mount namespace leaves it no file of the user's but the workspace, so S1 holds
as written. On macOS, Seatbelt enforces S1's files, home directory,
environment and network. Three things it promises are not held there, because
no Seatbelt rule gates them (checked on macOS 26). They are open to every
command in the planner's sandbox, sealed or not.

1. **Other processes' command lines and environments.** A command can read the
   command line of the user's other processes, and the environment of those
   that are not Apple platform binaries, through `sysctl` `kern.procargs2`
   (the numeric MIB `{1, 49, pid}`). Node, Homebrew's Python and dev servers
   are exposed, and their environments often hold API keys and tokens. Neither
   the profile's `sysctl-read` rule nor its `process-info*` rules reach it,
   and macOS has no seccomp to filter the call.
2. **The user's existing launchd jobs.** A command inherits the bootstrap port
   to launchd, and through it can read the definition of a loaded job,
   environment variables included (`launchctl print`); start one, which then
   runs outside the sandbox, as the user (`launchctl kickstart`; with `-k` the
   call fails); unload one (`launchctl bootout`, `launchctl remove`); and
   enable or disable one persistently (`launchctl enable`, `disable`). It
   cannot load or submit a new job: the profile's `(deny job-creation)`
   closes that.
3. **The shared here-document files.** macOS's `/bin/sh` (bash 3.2) writes a
   here-document to `/private/tmp/sh-thd-N` whatever `TMPDIR` says, so the
   profile allows reads and writes of names of that pattern, and `/tmp` is
   otherwise out of reach. A command can read or overwrite such a file while
   another process of the user is using it, which makes them a channel at
   names it can guess. Removing the allowance breaks here-documents.

So on macOS the promises that none of the user's credentials is in reach and
that a sealed run changes nothing hold as follows: nothing of the user's
files, home directory or Ordewell's own environment is readable and nothing is
written outside scratch, but for the here-document files; and what a process of
the user holds in its environment or command line, and the state of the user's
launchd jobs, are not out of reach. A value read this way is returned to the
planner like any command's output. To leave the machine it needs a later step
that has the network, since a sealed run has none:

- a web read (a fetch or a search, ADR-0027) is checked for an `!` exclusion,
  the web-read budget, private and loopback addresses, and a secret check on
  its URL or query, which looks for Ordewell's own secrets, the values of
  sensitive variables in Ordewell's environment and well-known token formats.
  That check narrows what a URL carries and does not close it: an encoded or
  split value passes, and so does a value from another process's environment
  that has none of those shapes. Under `auto`, in Guarded and in Full, a web
  read is not asked about;
- `curl` and `wget` through `run_command` go through the same checks on their
  URLs and are approved per origin; in Full and under `allowlist` they are
  refused whatever the allowlist says, and then run sealed, with no network
  (ADR-0027);
- any other command that reaches the network (`gh`, `git ls-remote`, a cloud
  CLI) asks, and the card shows the command, or the user's allowlist rule
  admits it without asking; in Full it runs only if allowlisted, and
  otherwise runs sealed, with no network.

Mitigations to come: the egress proxy (#88), through which the sandbox's
network is planned to go, and a container or VM backend (#99), where other
processes are not visible, which closes the first two for good. Stage 2 below
gives a sealed run a network of its own, so on macOS the secret check would be
what stands between a value read this way and a URL; the proxy's ADR decides
that with this in view.

### Network, in stages

1. **Now: none.** A sealed run has no network. A loop of cloud reads runs as
   allowlisted commands one call at a time, or as a script task the user
   approves ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)).
2. **With the egress proxy (#88):** a sealed run reaches the network only
   through the proxy, under the web-read policy (ADR-0027): exclusions, the
   budget, and private addresses refused on every connection. It still has no
   home directory, so no credentials of its own: public reads only.
3. **In a lease with a credential broker (#93, #97, #99):** read-scoped
   credentials attached by the broker. Decided with the lease's ADR.

### The harness's own shell, as a user's opt-in

- **What it is (N1).** A user setting, VS Code `ordewell.plannerNativeShell` and
  elsewhere `ORDEWELL_PLANNER_NATIVE_SHELL`, lets a harness planner use its own
  shell (Claude Code's `Bash`, OpenCode's `bash` or `shell`) beside
  `run_command`. A Codex planner already keeps its own shell, inside its
  read-only sandbox with no network (ADR-0026), so for Codex the setting
  changes nothing. It is off by default and never comes from the repository:
  it is refused from a workspace's environment files and is never a workspace
  setting (ADR-0016, ADR-0026, #92).
- **Its contract (N2).** The opt-in is offered for a harness only once each of
  these holds on the installed version, checked live:
  1. No file writes outside a scratch folder, enforced by an OS sandbox around
     the shell: the harness's own where it can be held to this, Ordewell's
     otherwise.
  2. None of the user's credential stores is readable from the shell: cloud
     CLI configuration, git credentials, SSH keys, package-registry tokens. The
     shell can read the workspace and run local tools, but cannot act on the
     user's accounts. So it is a second way to read and never a second route
     to effects, which stay script tasks and ops tasks (ADR-0035). The planner
     process itself is started without the user's credential variables, a
     curated list of names and patterns covering cloud, registry, git and
     service tokens, keeping only what the harness needs for its own login
     (N3): on macOS a sandboxed command can read its parent's environment, so a
     value left there is in reach however the profile confines files. What a
     process of the user holds in its environment or command line is not a
     store: on macOS it is the residual above, which Ordewell's Seatbelt
     does not close for a native shell either.
  3. Every command it runs reaches the research timeline from the harness's
     own event stream, as `run_command`'s commands do.
  4. The repository's config still runs nothing (ADR-0028).
- **Network (N3)** is whatever the harness gives its shell. An injected
  instruction could then send workspace contents to an address it chose. That
  is the residual the opt-in accepts, and the egress proxy (#88) is its guard
  once it exists. The harness's own login stays readable from its shell, as it
  is for every runner task today (#93), and is the one credential family the
  process scrub above keeps.
- **A harness that cannot be held to N2 (N4)** is not offered the opt-in, and
  the setting says why. Cloud reads that need the user's credentials stay on
  `run_command`, classified and allowlisted, whether or not the opt-in is on.
- **What is offered now (N5).** The opt-in is offered for Claude Code 2.1.304
  through 2.1.x and OpenCode 2.0.32 through 2.0.x, on macOS. OpenCode 1.x was
  not checked live, so it keeps `run_command` alone. Linux was not checked live
  either, so the opt-in is not offered there yet, even where the bubblewrap
  probe would pass: that probe says the sandbox can start, not that either
  harness's shell was held to N2 there.
- **Monitor (N6).** Claude Code's second shell tool, `Monitor`, runs through
  the same launcher and asks before it runs, so it is offered and withheld
  with `Bash`. With the opt-in off both are disallowed, since otherwise
  `Monitor` would be a shell the envelope never sees; with it on, each of its
  commands is a `bash` step on the timeline (N2.3).

## Live checks

Checked live on 2026-10-21 on macOS 26 (Seatbelt), against Claude Code 2.1.304
and OpenCode 2.0.32. Each harness was launched as Ordewell launches its planner
(Claude: `-p` stream-json, `default` mode, `--permission-prompt-tool stdio`,
`--setting-sources user`, `--settings` with `disableAllHooks` and the ask
rules; OpenCode: `opencode serve` with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, the
planner policy in `OPENCODE_CONFIG_CONTENT` and as session rules), with its
shell let through: Claude's `Bash` not withheld, OpenCode's `shell` asked
rather than denied, every ask answered allow. Fixtures: a throwaway repository
whose config carries hooks, an `.mcp.json`, an `opencode.json` server and an
OpenCode plugin, each writing a marker; canary credential files (`~/.aws`,
`~/.config/gcloud`, `~/.azure`, `~/.ssh`, `~/.npmrc`, `~/.git-credentials`,
`~/.netrc`, `~/.config/gh`, `~/.docker`, `~/.kube`) in a temporary folder
standing for the home directory; two canary credential variables
(`GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`) in the launch environment. The user's
real `~/.ssh`, `~/.azure` and `~/.config/gh` were read into `/dev/null`, the
keychain through `security find-generic-password -w` (exit code only) and
`git credential-osxkeychain` (byte count only), and `ssh-add -l` tried the
agent. Unsandboxed, every one of them was readable. Two routes were tried for
each harness: its own sandbox, and Ordewell's backend built on this branch:
the sealed profile (S1) with the network on (N3), wrapped around the harness's
shell.

| N2 check | Claude Code, its own sandbox | Claude Code, Ordewell's sandbox | OpenCode 2.0.32, Ordewell's sandbox |
| --- | --- | --- | --- |
| 1. writes only to scratch | holds, until a user setting widens it | holds | holds |
| 2. credential files, keychain, ssh-agent | unreadable | unreadable | unreadable |
| 2. credentials in the environment | readable | dropped; the harness's own environment still readable | dropped; the harness's own environment still readable |
| 3. no saved setting bypasses it | fails: three user settings widen writes | holds with the prefix in `--settings` `env` | holds with `shell` in `OPENCODE_CONFIG_CONTENT` |
| 4. every command in the event stream | holds | holds, and each asks first | holds, and each asks first |
| 5. repository config runs nothing | holds | holds | holds |

- **Claude Code's own sandbox.** `--settings` set `sandbox.enabled`,
  `failIfUnavailable`, `allowUnsandboxedCommands: false`,
  `autoAllowBashIfSandboxed`, `filesystem.allowWrite` (scratch),
  `filesystem.denyWrite` (the workspace) and `filesystem.denyRead` (`~/` and
  the canary folder). Writes reached scratch and Claude's temporary directory,
  `/tmp/claude-<uid>`, which every Claude Code session of the user shares and
  whose other sessions' task outputs stay readable; with `CLAUDE_CODE_TMPDIR`
  the session gets its own instead. A background command, a subagent's `Bash`,
  `Monitor` and `dangerouslyDisableSandbox: true` were all held. Credential
  files under a denied path, the keychain (`security` exit 44) and the agent
  were out of reach, but both canary variables were in the shell's
  environment, and `sysctl kern.procargs2` on `$PPID` returned the Claude
  process's own environment with them. Each new network host reached
  `can_use_tool` as `SandboxNetworkAccess`. Other layers' `enabled: false`,
  `allowUnsandboxedCommands: true` and `excludedCommands` did not loosen it.
  Each of three user settings, added in turn to `~/.claude/settings.json`,
  made a folder outside scratch writable: `sandbox.filesystem.allowWrite`, an
  `Edit(…)` allow rule, and `permissions.additionalDirectories`. A setting
  the user saved for interactive work therefore widens the planner's shell,
  and `--settings` cannot take an entry back. 2.1.304 ignores an untrusted
  project's allow rules and `additionalDirectories`; its sandbox keys apply
  and did not widen the sandbox either.
- **Claude Code under Ordewell's sandbox.** Claude's sandbox off;
  `CLAUDE_CODE_SHELL_PREFIX` names a launcher, which receives the whole
  command string as one argument and runs it with `/bin/zsh -c` under the
  profile; `CLAUDE_CODE_TMPDIR` names a short per-session folder (Claude warns
  above about 30 bytes) that the profile makes writable, since Claude writes
  the shell's working directory there after every command. N2.1 and the files,
  keychain and agent of N2.2 held on the same paths as above, and the canary
  variables were gone. A settings `env` block in a lower layer replaced a
  prefix set only in the process environment, which took the command out of
  the sandbox; set in `--settings` `env`, the prefix won. With Claude's own
  sandbox off, every `Bash` and `Monitor` call reached `can_use_tool` before it
  ran. Claude's start-up shell snapshot runs the user's shell profile outside
  both sandboxes. It is not a tool call and reads none of the repository's
  config.
- **OpenCode 2.0.32** has no OS sandbox of its own. Its shell is the `shell`
  of the last config layer that sets one, or else `SHELL`. With `SHELL`
  naming the launcher in the server's environment, N2.1 and N2.2 held as for
  Claude, including `background: true`, a subagent's child session and a
  `workdir` outside the workspace. A `shell` key in a config layer beat
  `SHELL`: the command ran unsandboxed and wrote outside. Ordewell's
  `OPENCODE_CONFIG_CONTENT` setting `shell` beat one in an `OPENCODE_CONFIG`
  file standing for the user's global config. Each `shell.created` event names
  the shell the call ran in. A saved `always` permission skips the question
  but not the shell. A user's global plugin can still choose the shell, as
  code that already runs in the server as the user (by source). OpenCode 1.x
  is not installed here and was not checked.
- **The event stream (N2.3).** Claude: every command was a `tool_use` in
  stream-json, a subagent's carrying `parent_tool_use_id`, and the launcher
  logged one invocation per `tool_use` (`Bash`, background `Bash`, a
  subagent's `Bash`, `Monitor`). OpenCode: each was a `session.tool.called`, a
  `permission.asked` and a `shell.created` on `/api/event`, child sessions'
  included, again one launcher invocation each.
- **The repository's config (N2.4).** No marker was written in any run made
  with the planner's launch, on either route.
- **Environment credentials, either route.** A sandboxed command on macOS can
  read the argv and environment of any non-platform process of the user,
  the harness's own included, through `sysctl kern.procargs2`. This was shown
  from inside the sealed profile against a `node` process holding a canary.
  N2.2 for variables therefore needs the harness itself started without the
  user's credential variables, beyond its own login (N3).
- **Codex** was not checked: N1 changes nothing for it.

## Considered options

- **The address limit as the memory bound.** `ulimit -v` at 4 GiB, on top of
  what the shell maps on macOS. The design until 2026-10-31. Rejected: it
  limits what a process reserves, not what it uses. V8 reserves 8 GiB for a
  page of WebAssembly memory, so ordinary programs died (`mmap error: 12`, exit
  134; vitest in es-module-lexer's Wasm, the build's DTS step by SIGTRAP) while
  a run of many small processes could hold many times the limit.
- **A cgroup's `memory.max` on Linux.** Rejected: it needs a delegated cgroup,
  which an unprivileged process does not have on every host a sealed run must
  work on, and macOS has no counterpart, so the watcher would still be needed.
- **Teach the classifier loops** (unroll a literal `for` list, parse compound
  commands). Rejected: every construct it learns is another place to read a
  different command from the one the shell runs (ADR-0008's history), for a
  guarantee the sandbox gives outright where it runs.
- **Run every planner command sealed, and drop the classifier where a sandbox
  runs.** Rejected: cloud CLIs and `gh` need the network and the user's
  credentials, and sealing them breaks the reads ADR-0026 exists for.
- **Sealed runs off by default on macOS until the egress proxy (#88).**
  Rejected by the maintainer on 2026-10-21, with the three residuals above
  known. A value read through them still needs a later step with the network
  to leave the machine, and that step goes through the envelope's checks
  (above). And sealed runs are what lets the planner loop and run a script on
  macOS: without them every refusal there is a refusal again, which is the
  problem this ADR starts from. The residuals are stated instead, in
  SECURITY.md with advice for macOS users, and closed where they can be by
  the proxy and a container or VM backend.
- **Give sealed runs the network now.** Rejected until #88: an unclassified
  command with a network can carry anything it read to any address.
- **Seal with the home directory mounted read-only**, as ADR-0011's profile for
  classified commands does. Rejected: an unclassified command would read
  `~/.ssh` with none of the path checks that ask about it today.
- **Seal also what the user denied on the card.** Rejected: a denial is the
  user's answer about that command, sandbox or not.
- **The harness's own shell by default on the local backend.** Rejected: the
  planner runs as the user, with every credential on disk, before anything is
  approved, and Ordewell cannot see every native command before it runs
  (ADR-0026). Inside a lease that holds the boundary itself, native tools can
  be the default; that belongs to the lease's ADR (#97, #101).
- **The native shell with the user's credentials in reach.** Rejected: it would
  be a second route to effects, around ADR-0035's consent.
- **A user setting that turns the classifier off for `run_command`.** Rejected:
  without a sandbox, nothing would stand between an unread command and the
  user's files and credentials.

## Consequences

- Where a sandbox runs, the planner can loop, pipe into an interpreter and keep
  scratch files, and the refusals that said "describe it as a task" become
  sealed runs.
- Hosts without a sandbox keep today's refusals, and the notice says so.
- ADR-0011's B7 is amended: a verified sandbox turns a refusal into a sealed
  run, and changes nothing else about the tiers.
- Research subagents can run what the planner can, sealed.
- The opt-in needs live checks per harness before it is offered. Until a
  harness passes them, its planner has `run_command` alone.
- Seatbelt has no PID namespace, so on macOS a sealed run's processes are
  killed as one process group, at its end, at its wall-time limit and when
  Ordewell dies. A process that leaves the group with `setsid` outlives the
  run, still sealed, and its memory is not counted. Its process limit and
  address-space ceiling are counted on top of what the user already runs and
  what every macOS program maps as it starts. A sealed run there still has the three residuals above: what the user's other
  processes hold in their command lines and environments, their launchd jobs,
  and the shared here-document files. No Seatbelt rule closes them; Linux's
  PID and mount namespaces leave a sealed run none of them. SECURITY.md says
  so to macOS users.
- Homebrew's data directories are hidden from a sealed run on macOS; its
  configuration stays readable, since git and OpenSSL stop on a file the
  sandbox denies rather than one that is missing.
- SECURITY.md's envelope description and "What each part can touch" name
  sealed runs and the opt-in, CONTEXT.md has *Sealed run* and *Native shell*,
  and ADR-0008, ADR-0011 and ADR-0026 are rewritten where they said a refused
  command never runs and a harness's shell is withheld.

## History

- 2026-10-15 — accepted. Not yet implemented; sealed runs need #64 first.
- 2026-10-21 — sealed runs implemented (#109) on Seatbelt and bubblewrap, for `bash`, `run_command` and research subagents; the native-shell opt-in waits for #110.
- 2026-10-21 — the three macOS residuals recorded (other processes' command lines and environments, existing launchd jobs, the shared here-document files), and sealed runs kept on by default there.
- 2026-10-21 — a read-only task's `run_command` runs sealed with its worktree writable (ADR-0046).
- 2026-10-21 — live checks of N2 on Claude Code 2.1.304 and OpenCode 2.0.32 (#110), recorded under Live checks.
- 2026-10-21 — the native-shell setting and its eligibility table implemented (#110): Claude Code 2.1.304–2.1.x and OpenCode 2.0.32–2.0.x on macOS; OpenCode 1.x and Linux stay on `run_command` until checked live.
- 2026-10-21 — Claude Code's native shell wired (#110): `CLAUDE_CODE_SHELL_PREFIX` names a launcher built on the sealed profile, with the network (N3), the workspace read-only, the session scratch and a short `CLAUDE_CODE_TMPDIR` writable; both variables go in the `--settings` `env` block, Claude Code's own sandbox is off, `Bash` and `Monitor` are asked and allowed through the `native-shell` kind, and the planner process starts without the user's credential variables (N2.2), the keychain included. `Monitor` is withheld whenever the opt-in is off (N6), and its commands are `bash` steps on the timeline.
- 2026-10-21 — OpenCode 2.x's native shell wired (#110): the launch environment and `OPENCODE_CONFIG_CONTENT` both name the same launcher, so a config layer cannot choose another shell; `bash` and `shell` ask instead of denying, the request becomes the `native-shell` kind, every `shell.created` is checked against the launcher and an escaped shell fails its call and the turn, the server starts without the user's credential variables (N2.2) but keeps its own login (N3), and its commands reach the timeline as `bash` steps. OpenCode 1.x keeps `run_command` alone. The setting is implemented in full.
- 2026-10-21 — the native shell's network stops at the machine (N2.2): its profile refuses loopback addresses and local Unix sockets (but name resolution and syslog), since a command that read the harness server's password from its environment could otherwise have that server run a command outside the sandbox; bubblewrap, which cannot keep one without the other, refuses the profile. The planner is told of its own shell only in a process that was given one.
- 2026-10-31 — `memoryBytes` is real memory, held by a watcher that sums the run's resident memory about once a second and ends it with a note of its own; the address limit stops being the memory bound and becomes a 256 GiB ceiling (`addressSpaceBytes`), measured under The limits of a sealed run, so Node, vitest and the build run sealed.
