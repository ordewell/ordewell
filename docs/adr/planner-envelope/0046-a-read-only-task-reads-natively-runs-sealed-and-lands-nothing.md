---
status: accepted
implemented: full
amends: ["0001", "0013", "0022", "0027", "0028", "0033", "0036", "0037"]
---

# 0046 — A read-only task is Ordewell's: its runner's reads, a sealed shell, and nothing lands

## Problem

A read-only task ran in its runner's own read-only mode
([ADR-0001](../routing/0001-autonomous-mode-resolution.md)), and those modes
differ. Claude Code's plan mode writes its plan to a file under the runner's
own config folder, outside the workspace; Codex's read-only sandbox and
OpenCode's plan agent each draw the line somewhere else; none of them runs a
test. So a read-only task could still write, what it might touch depended on
the runner it was given, and a review that needed to run the suite, or try a
fix to see whether it held, could not be read-only.

Research tasks
([ADR-0037](../supervision/0037-research-tasks-wake-the-planner.md)) are
read-only tasks whose report is all that comes back (#103), and they start
without approval only once read-only means one thing on every runner (R4).

## Decision

**A read-only task is defined by Ordewell, the same on every runner. It keeps
its runner's native read tools; its only shell is Ordewell's `run_command`,
which runs sealed whatever the planner's envelope would ask about or refuse,
and every command once one has run sealed, with the task's own worktree
writable and nobody asked; its only web reads are Ordewell's `fetch` and
`web_search`, which the host carries under the planner's web-read policy
without asking anyone; and it lands nothing:
its worktree is thrown away when it ends, and its `task_complete` handoff is
its result ([ADR-0047](../supervision/0047-structured-task-handoffs.md)), with
the patch it saved of its worktree, if it saved one
([ADR-0050](0050-a-read-only-task-can-hand-off-its-prototype-as-a-patch.md)).**
The plan flag stays `readOnly`, and means a task that lands nothing.

### Its shell

- **Only a read-only task has it.** `run_command` is among the tools of a
  read-only task's MCP token and no other task's
  ([ADR-0022](../runners/0022-ordewell-mcp-server.md)). It answers from the
  attempt's task shell (`BaseFileSystem.taskShell`), which is the planner's own
  command gate moved to the task's working directory: the same classifier,
  path confinement, `!` exclusions and allowlist
  ([ADR-0026](0026-one-envelope-for-every-planner.md)).
- **Nobody is asked.** Until the attempt's first sealed run, a command the
  classifier reads as read-only, naming nothing outside the task's working
  directory, and one the allowlist covers, run as the planner's would, in the
  planner's sandbox ([ADR-0011](0011-sandboxing-the-planners-shell.md)) with
  the network its tier gives. Everything else — what would ask, what the
  classifier refuses, a path outside the working directory — runs sealed
  ([ADR-0036](0036-the-planners-shell-sealed-runs-and-native-opt-in.md)), as
  a research subagent's does (S5). An exclusion, and a denial the user gave on
  the card, still refuse (S3), a denied command inside a wrapper included. A
  grant the user gave the planner on the card, and the `allow` approval mode,
  stay the planner's: they were given to its commands.
- **Sealed from its first sealed run on.** Once a sealed run has started in an
  attempt's task shell, every later command of that shell runs sealed, the
  read-only tier and the allowlist included, so none has the network. A sealed
  run may have written what a later command runs or reads as config: the
  worktree's `package.json` `test` script, which an allowlisted `npm test`
  runs, a Makefile, a `conftest.py`, a tool's dotfile, a cache in the scratch
  directory. Run as the planner's would, that command reads the whole host,
  and an allowlisted one has the network, so the user's credentials could
  leave the machine with nobody asked. Until then the worktree holds only what
  Ordewell checked out, since native writes and the native shell are
  withheld, so an allowlisted command there is as safe as the planner's own,
  and a task that only reads keeps allowlisted network commands such as `gh`.
  The switch is one piece of the task shell's state, set when a sealed run
  starts rather than when it succeeds, since one that fails, times out or is
  aborted may have written. It is set with or without a worktree, since a
  sealed run still writes the attempt's scratch directory. Every command after
  it goes through the sealed run's checks, so S3 holds. The result of the run
  that sets it says once why later commands are sealed, and each later sealed
  result names it. Where no sandbox can seal, no sealed run starts and nothing
  switches. A continue has a fresh worktree and shell and starts unsealed; the
  planner's own shell is unaffected.
- **Its sealed runs** have ADR-0036's profile with the task's own worktree
  writable: the workspace readable, the worktree writable, no network, no home
  directory, and a scratch directory of the attempt's own as `TMPDIR` and
  `HOME`, removed when the attempt ends. In a repo group every worktree is
  writable and the group's task workspace root is not persistently writable,
  since the root holds no worktree's `.git` and is where the group's runner
  starts its git; one repository keeps its worktree whole. Where the sandbox
  binds the root read-only a write there is refused, and under bubblewrap's
  throwaway overlay a write may succeed into the layer discarded with the run,
  so no `.git` at the root reaches a process outside the sandbox either way.
  Commands start at the task's working directory, which stays readable. So the
  task can try a fix, or add a failing test and run the suite. The
  repository's `.git` stays read-only, since a worktree's `.git` is a file
  pointing into it: git reads the history and
  records nothing, and each sealed result says so. The worktree's own `.git`
  file is kept the repository's too: a sealed run may not write, replace,
  rename or remove it, nor create a `.git` anywhere it may write, so git run
  later there outside the sandbox, as the user (Ordewell's, below, or the
  runner's own), loads no repository the run planted with a `core.fsmonitor`,
  `core.hooksPath`, filter driver or `include.path` of its own. The worktree
  root itself is held still for the same reason: a run that renamed it could
  plant a `.git` where the profile does not reach and move the directory back.
  The root and its `.git` are one field of the sealed profile
  (`SandboxProfile.gitWorktrees`), set by `sealedShellProfile` with the repo
  worktree roots — one per repo in a group — on every platform; Seatbelt
  denies writes to the root's inode and to the `.git` file by their paths, the
  root's contents staying writable, and bubblewrap's bind mount refuses
  renaming or removing the root itself (EBUSY) and binds the `.git` file
  read-only after the writable bind. `git log`, `git diff` and `git status`
  still work inside the run, and its contents stay writable. Every other
  `.git` entry the checkout brought — a submodule's `.git` file, a vendored
  repository — is protected the same way and recorded with its identity before
  the task's first sealed run (`snapshotGitEntries`,
  `SandboxProfile.gitEntries`): a Seatbelt deny by literal path for a file and
  by subpath for a directory, a read-only bind for each under bubblewrap. Creating a `.git` is `SandboxProfile.gitless`, set
  with the writable directory on macOS only, as `linkless` is; Seatbelt denies
  creation by a regex, which matches `.GIT` too, after the writable allow (the
  last matching rule wins). Bubblewrap cannot refuse creating one and refuses
  a `gitless` profile; so on every platform `runSealed` calls
  `removePlantedGit` at the task workspace root, as defence in depth. One link
  walk after every run (`removeOutwardLinks`) removes any `.git` that was not
  in that record. A worktree root's own `.git` and a repository the checkout
  brought are in the record and stay. The record is also checked after every
  run — identity and type, a file's content, a directory's `config` and the
  entry names under its `hooks/` — and a changed entry stops the task's shell,
  in case the backend did not hold. What the walk removed is named in the
  result; a `.git` it could not remove stops the task's shell too, and every
  later command of the task is refused.
- **No link out of the worktree.** A sealed run may leave no link leading out
  of its worktree and the workspace. The runner's native reads run as the
  user, outside the sealed profile, and would follow it. On macOS the profile
  is `linkless` for the writable directory (`sealedShellProfile`, only on
  darwin), and Seatbelt denies creating a symlink there, or moving one in, by
  the file's type; it does not see a directory moved in that holds one.
  Bubblewrap cannot refuse a link by type and refuses a `linkless` profile. So
  on every platform `runSealed` calls `removeOutwardLinks` after each run,
  which reads the writable directory's directories concurrently, and names
  what it removed in the result. A directory the run left closed to its owner — one
  that may be traversed but not listed, which a read naming a path through it
  still crosses — is opened to the user, who owns it, and walked, not
  skipped. The task shell runs one command at a time, so no
  unsealed command runs alongside the first sealed one.
- **Ten minutes.** A sealed command of a task has ten minutes
  (`TASK_SEALED_LIMITS`, the script task's default); the planner's own sealed
  runs keep one minute. A run ended at its limit says so, and does not blame
  the network (`sealedTimeLimitNote`). The task can run the suite because of
  it. Memory is the same for both, ADR-0036's real-memory limit, and a run
  ended at it says so as well (`sealedMemoryLimitNote`).
- **Without a worktree**, where the run does not isolate, the working
  directory is the workspace root and a sealed run has nothing of it writable.
- **Without a sandbox** (ADR-0036 S6), what would run sealed is refused, and
  the result says why.

### Its runner's own tools

- **Native reads stay.** The runner's own read, search and list tools work as
  they do for any task, each runner being built around them.
- **Native writes and the native shell are withheld, on every runner.** They
  run as the user, outside any sandbox, and a sealed command can make a
  symlink in the worktree: a native write tool would write through it wherever
  the user can, and confining it by path cannot see that. Withholding them
  keeps every write a read-only task makes inside the OS sandbox.

- **Claude Code** uses `default`, its stdio permission prompt, user setting
  sources only and hooks disabled, as the planner does (ADR-0028). `Read`,
  `Grep`, `Glob` and `LS` are decided automatically by Ordewell against the
  task worktree and session workspace, with symlinks resolved. A read outside
  both is refused, never asked. Edit, write, notebook, shell and plan-mode
  transition tools are withheld. Ordewell's task tools, including `read_task`,
  are pre-allowed.
  The assigned model runs directly; native plan mode's model pin is gone.
- **OpenCode 1.x and 2.x** use the `build` agent under Ordewell's read-only
  permission profile. Native reads are allowed, external directories denied
  except the task worktree and session workspace, and writes, shells,
  delegation, browser, LSP and code-mode execution denied. Project config is
  disabled and LSP startup off, as for the planner (ADR-0028). Ordewell's
  task tools, including `read_task`, are allowed by exact name. 2.x must
  expose MCP tools outside code mode or the task cannot start. A read-only attempt never
  resumes a session with old permissions.
- **Codex** keeps its read-only sandbox setting and declines native file
  changes, with `features.shell_tool = false` and `features.unified_exec =
  false` (ADR-0033). Its code-mode tool discovery remains. Of its MCP servers
  only Ordewell's own stays, as for Claude Code and OpenCode:
  `CodexAdapter.openThread` reads Codex's effective configuration
  (`config/read`) and disables every other configured server for the thread,
  and a task whose servers Codex cannot report does not start. File reads and
  repository searches that would use its shell instead go through
  `run_command`. The profile needs no native sandbox probe, so it
  stays available on hosts where Guarded is unavailable. Project config is
  untrusted, as for the planner. No model is replaced.
- **Native web tools are refused.** A runner's own fetch and search run
  outside Ordewell's pinned transport, and a provider-side search outside its
  secret check and budget too, with nobody there to approve one. Claude's
  `WebFetch` and `WebSearch` are denied at the permission gate, OpenCode's
  fetch and searches in its policy, and Codex's `web_search` is disabled; the
  denial names Ordewell's `fetch` and `web_search` instead. A task may still
  run an allowlisted network command through its task shell under the
  existing command rules, until its first sealed run.

### Its web reads

- **Ordewell's `fetch` and `web_search`, on its token alone.** A read-only
  task's token lists them beside `run_command`
  ([ADR-0022](../runners/0022-ordewell-mcp-server.md)), and every runner
  pre-allows them by exact name, as it does the other task tools: Claude Code
  as `mcp__ordewell__fetch` and `mcp__ordewell__web_search`, Codex under the
  same names through its tool discovery, OpenCode as `ordewell_fetch` and
  `ordewell_web_search`. A change or ops task's token lists neither.
- **Decided by the planner's web-read policy, never by a person.** Each read
  goes through the session's one `WebReadPolicy` and `HttpWebFetcher`
  ([ADR-0027](0027-web-reads-in-the-planner-envelope.md)): the outbound-secret
  check against the credentials the session holds at that moment (the
  config's provider keys, every live MCP token, the planner service's own)
  and credential-named environment values, before any lookup; the planner
  allowlist's `!` exclusions; the scheme and SSRF guard, every DNS answer
  vetted and the connection pinned; a cross-origin redirect decided again;
  the body, content and time bounds; and the process-wide response cache and
  search provider, a cache hit decided as a live read is. It reads as a
  research subagent does (`prompting: false`): only what already stands — an
  allowlist entry, a grant the user gave in this session, or a mode that
  allows without asking — lets a read through. One that would ask is refused
  at once, before any lookup or request, and the refusal tells the task to
  report the gap in its handoff. The task asks nobody and adds no grant. The
  policy is read from the user's settings and the session, never from
  anything in the task's worktree.
- **A budget per attempt.** Each attempt counts its reads against the
  configured web-read budget on a count of its own
  (`WebReadPolicy.forTask`, one per attempt): no planner turn resets or
  spends it and no other attempt shares it. A read is counted before it is
  decided, so reads made in parallel cannot overspend it. A retry and a
  continue are new attempts with a fresh count; a respawn of the runner
  within an attempt (ADR-0025) keeps it. A cross-origin redirect hop counts,
  as the planner's does, and so does a read its caller cancels once it was
  allowed: by then its host may already have been looked up.
- **Carried by the host, apart from the shell.** The reads leave from
  Ordewell's process, not the task shell: they work before and after the
  shell's first sealed run, and they neither unseal it nor give its commands
  the network.
- **Ended with the attempt.** The attempt's reader (`TaskWebReader`) ends
  when the attempt ends or its spawn is abandoned: a read in flight is
  aborted through to its connection, none starts after, and one whose
  transport answers anyway hands the runner nothing. The token is
  revoked with the attempt (ADR-0022, A2), and a call its caller cancels is
  aborted too.
- **Recorded in the attempt's log, not the planner's conversation.** Each
  decision is the call's own result: a refusal's reason, or, for an allowed
  read, a closing line naming each origin or search provider decided and what
  allowed it (the approval mode, the planner allowlist or a grant given in
  this session), a cross-origin redirect hop's included, and how many reads
  the attempt has left. The attempt's log keeps it as the tool's result. None
  becomes an approval card in the planner's conversation, as a task runner's
  approval request does not (ADR-0018, A1): the reads are the task's, and a
  budget's worth of them per attempt would bury the planner's own. A refused
  credential is recorded without the URL or query.

### Nothing lands

- **A pass lands nothing.** A read-only attempt (`AttemptKind` `readOnly`, and
  a continue of one) never integrates: a pass completes the task with nothing
  to land, and its worktree is released whatever it changed (`Landing`). So
  does Mark complete.
- **Its worktree is kept for nothing.** Its record is marked read-only
  (`IsolationTaskRecord.readOnly`): `integrate` refuses it, and every release —
  a pass, a failure, a stop, a cancel, a crash-recovery prune — removes it
  whole, with nothing kept on a branch. Ordewell runs no git inside it outside
  the task's seal once the task has run there: keeping its changes would mean
  committing, as the user, in a tree its sealed commands wrote, `.git` file
  included. What the task changed is kept only as the patch it asks for with
  `save_patch`, which Ordewell captures as the task's own sealed runs, never
  outside them (ADR-0050). Removing it
  follows no link the task put on the way. `task_diff` refuses a read-only task
  for the same reason — a live read-only worktree's `.git` could be one a
  sealed run planted — and the release and crash-recovery prune of its record
  run git only in the repository, with the worktree as an argument, never from
  inside it.
- **A continue starts clean.** Its worktree is fresh, and it is told that
  nothing its earlier attempt changed was kept.

## Testing decisions

- The task shell is tested through `BaseFileSystem.taskShell` with a sandbox
  backend that records each profile, as `taskShell.test.ts` does: which
  commands ran sealed, from where, with what writable, and that nobody was
  asked. The `.git` sweep is tested the same way: a planted one in a subfolder
  is gone, a submodule's and a vendored repository's stay, and one that cannot
  be removed refuses the next command. The record's identity check is driven
  the same way, by changing a protected entry behind the backend's back.
  `backends.test.ts` asserts the rules and binds each backend builds for it.
  `sealedRuns.e2e.test.ts` runs it in the host's real sandbox against a git
  worktree, a repo group's root and its worktrees included, and replays the
  move-and-plant sequence and a nested `.git` rewrite there. A macOS run
  proves the Seatbelt side; the bind mount's refusal to rename or remove a
  worktree root, the throwaway overlay at a group's root and the read-only
  binds of `.git` entries are proven by the Linux CI job that runs the same
  suite under real bubblewrap.
- Web reads are tested end to end in `taskWebReads.test.ts`: a session built
  by `createSession` with a structured runner, the attempt's token used by an
  MCP client, and a fake transport and DNS. It covers what the token lists,
  refusals before any lookup or request, the per-attempt budget under
  parallel calls, the cache, a sealed shell, and the read's end at a stop, a
  caller's cancellation and a retry. `readOnlyRunners.test.ts` and the
  OpenCode task tests check each runner's pre-allowed names.
- Landing and release go through `FakeWorktreeIsolation` for the scheduler's
  side, and real git in `GitWorktreeIsolation.test.ts` for what is removed, what
  is never preserved, and where git runs.

## Out of scope

- A container's read-only mount of the workspace with a scratch folder (#99).
  It is the same definition on another sandbox.
- What a research task adds to a read-only one: its report waking the planner
  and its start without approval (ADR-0037).

## Considered options

- **Each runner's own read-only mode.** The design until 2026-10-21.
  Rejected: the modes differ, Claude Code's plan mode writes a plan file
  outside the workspace, none runs a test, and what a read-only task could
  touch depended on the runner it was given.
- **Ordewell's planner tools only, without the runner's native read tools.**
  Rejected by the user: every runner is built around its own reads, which
  change nothing.
- **The repository read-only to the task, with only scratch writable.**
  ADR-0036's suggestion for #104. Rejected by the user: a research task could
  not try a fix or add a failing test and run the suite.
- **Native writes confined to the worktree by path.** Rejected: a sealed
  command can make a symlink in the worktree, and a native write tool, which
  runs outside the sandbox as the user, follows it.
- **Keeping a read-only task's changes on a branch, as a removal keeps a
  change task's.** Rejected: nothing in it is work to keep, and keeping it means
  running git, as the user, in a tree its sealed commands wrote.
- **Every command of a read-only task sealed, from its first.** Rejected: a
  task that never writes, such as a research task reading issues with `gh`,
  would lose the allowlist's network commands, though until a sealed run its
  worktree holds only what Ordewell checked out.
- **Sealing only the allowlisted and read-only commands that run or read
  worktree content.** Rejected: which those are cannot be decided from a
  command line. `npm test`, `make`, `pytest`, `cargo` and `npx` run what the
  worktree says, and many tools read a config file they find there.
- **Skipping the link walk where the profile is `linkless` (macOS).**
  Rejected: Seatbelt refuses a link made or moved into the worktree, but not a
  directory moved in that holds one, which only the walk finds.
- **Unsealed commands in the planner's sandbox after a sealed run, with links
  removed first.** The design until 2026-10-22. Rejected: a sealed run could
  rewrite a script an allowlisted command then ran with the network and the
  host readable.
- **Passing `task_diff` the recorded git dir and work tree, so it could read a
  live read-only worktree without discovering its `.git`.** Rejected: the
  worktree's admin directory name (`.git/worktrees/<name>`) is not recorded,
  and finding it means either trusting the worktree's `.git` file, which a
  sealed run controls, or running more git in the repository; a read-only task
  lands nothing, so its diff is not work to inspect, and refusing it is the
  smaller change that holds.
- **No web reads.** The design until 2026-10-25, when native web tools were
  refused for want of a task web-policy channel. Rejected: a research task
  could not read the public documentation it was sent to check.
- **The runner's native web tools under the web-read policy, as a planner's
  are.** Rejected: a provider-side search runs where neither the secret
  check nor the budget reaches it, Claude's `WebFetch` resolves the host
  itself, and nobody is there to approve one; one host-carried route keeps
  every read under the same guards on every runner.
- **The network for the shell after a sealed run, for `curl` and the like.**
  Rejected for the reason every later command runs sealed: a sealed run may
  have rewritten what a networked command runs or reads.
- **Spending the open planner turn's web-read budget.** Rejected: a task
  outlives planner turns, so a new turn would reset what it had spent, and
  parallel tasks and the planner would drain one count.
- **Pinning `GIT_DIR`/`GIT_WORK_TREE` in the read-only runner's environment, so
  its own git ignores a planted `.git`.** Rejected: one pair cannot serve a
  repo group's several worktrees, the admin directory name is not recorded, and
  on macOS the sealed profile already refuses a planted `.git` outright; the
  structural fix binds a group's worktrees instead of its root and sweeps a
  planted `.git` after every run, on every platform.

## Consequences

- A read-only task can run the project's tests, try a fix and add a failing
  test, and none of it reaches the plan's branches; its handoff is the result.
- Native read tools still run as the user, outside the sandbox, as far as each
  runner's own read rules let them, with Claude's resolved-path gate and
  OpenCode's native directory permission checks. These reads are not an OS
  sandbox; what a runner's read finds reaches the model and its report.
- On macOS a read-only task's sealed runs keep the three residuals ADR-0036
  records (other processes' command lines and environments, existing launchd
  jobs, the shared here-document files), and a process that leaves a sealed
  run's process group outlives it, still sealed, and can still be writing the
  worktree while it is removed.
- Once a task has run anything sealed, it has no network command left for the
  rest of its attempt: an allowlisted `gh` it runs after that fails, and an
  allowlisted `npm test` runs under the sealed profile's limits, without the
  user's home directory. A task that needs both runs the network command
  first. Its `fetch` and `web_search` are unaffected.
- A read-only task reads only the web the user's settings already allow
  without asking. Under `ask` or an explicit `allowlist` mode, an origin
  nobody granted is a gap the task reports, and the planner, which can ask,
  reads it.
- A sealed `python -m venv` in the worktree fails on macOS, because a venv's
  links point outside it. A native read at the same moment as a sealed run
  could follow a link in the instant before it is removed: any link on Linux,
  and on macOS one inside a directory the run moved in. Closing that on Linux
  needs a seccomp filter in the bubblewrap backend.
- No unsealed git runs below a read-only task's working directory: Ordewell's
  git runs only at repo roots, its patch capture only inside the task's seal
  (ADR-0050), each runner's own only at the task's working
  directory, and a repo group's root is not persistently writable to its
  sealed runs: a write there is refused where the root is bound read-only, and
  under bubblewrap's throwaway overlay one may succeed only into the layer
  discarded with the run. A `.git` the checkout did not bring is removed after
  every run, one it brought cannot be changed, and a removal that fails stops
  that task's shell. So none of them loads a repository a sealed run planted or
  armed, on macOS or Linux, without a seccomp filter. The native read that
  races a sealed run, above, is unchanged.
- A failed or stopped read-only attempt leaves its log and its report to look
  at, and no worktree, even one a sealed run left with a macOS immutable flag.
- Where no sandbox runs, a read-only task runs only the classifier's read-only
  commands and what the allowlist covers.
- Research tasks can build on this profile for their start without approval
  (ADR-0037 R4); their lifecycle is separate. The planner is told a read-only
  task can run commands.

## History

- 2026-10-21 — accepted; implemented in core, the per-runner part pending.

- 2026-10-21 — implemented on every built-in runner; native plan modes replaced, native web tools refused without a task web-policy channel, and the planner told commands can run.

- 2026-10-22 — a sealed run leaves no link out of its worktree (refused on macOS, removed after the run on every platform); a task's sealed commands have ten minutes; a Codex read-only task keeps only Ordewell's MCP server.

- 2026-10-22 — every command of a read-only task's shell runs sealed after its first sealed run; the link walk stays on macOS, where Seatbelt misses a directory moved in that holds a link.

- 2026-10-22 — a sealed run cannot write, replace, rename or remove its worktree's own `.git`, nor (on macOS) create one beneath the worktree, so no git outside the sandbox loads a planted repository (`SandboxProfile.gitWorktrees`); `task_diff` refuses a read-only task; the runner's own git keeps a Linux-only residual.

- 2026-10-22 — no `.git` may be created at a repo group's task workspace root, where its runner's git starts (`SandboxProfile.gitless` on macOS, removed after the run under bubblewrap); the link walk opens a directory the run left closed to its owner instead of skipping it.

- 2026-10-22 — a repo group's task workspace root is no longer writable to a sealed run, only its worktrees are; a `.git` below the writable directory that was not there before the task's first sealed run is swept by the link walk, and one that cannot be removed stops the task's shell.

- 2026-10-22 — a sealed run can no longer rename or remove its worktree root, and every `.git` entry the checkout brought is held by the profile and checked for identity, content and hooks after every run; a repo group's root is described as not persistently writable where bubblewrap overlays it.

- 2026-10-22 — the group-root consequence names the refusal where the root is bound read-only, and the testing decisions say which host proves which rule: macOS for Seatbelt, Linux CI for the bind mount, the group-root overlay and the read-only binds.
- 2026-10-22 — handoffs carry read-only results and `read_task` joins the allowed task tools (ADR-0047, #120).
- 2026-10-24 — a task's saved patch comes back with its handoff, captured by Ordewell's git only inside the task's seal (ADR-0050).
- 2026-10-25 — a read-only task reads the web through Ordewell's `fetch` and `web_search`, under the planner's web-read policy without prompting and with a budget per attempt; native web tools stay refused.
- 2026-10-25 — a task's web-read decisions are recorded in its attempt's log, an allowed read's naming what allowed it, and never in the planner's conversation; a read answered after its attempt ended hands the runner nothing; a cancelled allowed read keeps its count.
- 2026-10-31 — a sealed run's memory limit is real memory, and a run ended at it says so (ADR-0036).
