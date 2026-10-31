# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub's
[Security Advisories](https://github.com/ordewell/ordewell/security/advisories/new)
for this repository. That gives us a private thread and a CVE if one is warranted.

You can expect:

- An acknowledgement within **3 working days**.
- An assessment, with a fix or a rejection and the reasoning, within **14 days**.
- Credit in the advisory and the release notes, unless you'd rather not be named.

Please give us a reasonable window to ship a fix before disclosing publicly.

## Supported versions

Ordewell is pre-1.0 and moves quickly. Only the latest released version is
supported; fixes ship forward rather than being backported.

## What is in scope

Ordewell runs on a developer's own machine and drives coding agents against
their own repositories. The parts most worth your attention:

- **The read-only exploration envelope.** The planner researches your workspace
  but must not write to it, and must not read outside it without asking. Any way
  to make the planner mutate the workspace, or silently reach outside it, is a
  vulnerability. The design is in
  [ADR-0008](docs/adr/planner-envelope/0008-planner-exploration-envelope.md) and the classifier
  is `packages/core/src/services/commandPolicy.ts`. Where the planner's sandbox
  runs, a command the envelope would refuse without asking anyone runs sealed
  instead
  ([ADR-0036](docs/adr/planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md)),
  so for those the sandbox, not the classifier, is the barrier.
- **Command policy bypass.** Prompt content that gets a would-be-refused command
  classified as safe.

  The classifier is a denylist over a real shell, not a substitute for an
  OS-level sandbox: it decides which commands the planner's shell may run, but
  it cannot make that shell incapable of harm, because every binary it permits
  keeps its own ability to execute programs and write files. `git`, `find` and
  `jq` are all Turing-complete enough to be misused by an argument the
  classifier didn't anticipate. Widening the auto-run set or fixing a
  classification gap therefore changes *which* commands are trusted, never
  *whether* trust in the classifier is well-founded — that second question is
  [ADR-0011](docs/adr/planner-envelope/0011-sandboxing-the-planners-shell.md). On Linux
  (bubblewrap) and macOS (Seatbelt), every command the planner's shell starts
  runs in an OS sandbox beneath the classifier, where nothing outside a
  per-session scratch directory can be written. On Windows, and on a Linux
  host where bubblewrap cannot start, the classifier is the only barrier, and
  the planner surface says so once per session. Bypasses of the classifier
  remain in scope here and will be fixed as they're found; the sandbox bounds
  what a misclassified command can do, it does not make the classifier's
  mistakes acceptable. Don't rely on this classifier as the only barrier
  between the planner and untrusted content in a repository — a hostile
  `README.md` or commit message the planner reads during research should not
  be assumed contained by it alone.
- **The planner's sandbox.** A way for a planner command to write outside its
  scratch directory where the sandbox runs, or to reach the network when it
  ran without asking, is in scope. A command the user approved keeps the
  network and the local services it reaches through it (ADR-0011 lists them);
  that is what the approval grants. On macOS, Seatbelt leaves three things open
  to every command in the sandbox, sealed or not (see Sealed runs); Linux's
  namespaces close them.
- **Sealed runs.** A sealed run executes a command no classifier vouched for,
  so its profile is the whole guarantee: the workspace read-only (or under a
  throwaway overlay), the session's scratch directory its only writable place
  and its home, no network, nothing of yours outside the workspace readable,
  none of the credentials in Ordewell's environment, and limits on processes,
  memory and time. A way for one to change the workspace, read your home
  directory or another repository, reach the network or a local service, see
  a credential, or outlive its limits is in scope, as is a way to run a
  command sealed that a `!` allowlist exclusion names or that you denied. A
  read-only task's sealed runs may also write its own worktree, and in a repo
  group each worktree, while the group's task workspace root is not
  persistently writable
  ([ADR-0046](docs/adr/planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)),
  but not a worktree's `.git` or the worktree root itself: a sealed run cannot
  rename or remove the root, nor write, replace, rename or remove its `.git`,
  nor any `.git` entry the checkout brought — a submodule's file, a vendored
  repository — and each of those is checked after every run for a changed
  identity, content or hook set, which stops that task's shell. Nor may it (on
  macOS) create a `.git` anywhere it may write. The group's root is not
  persistently writable: a write there is refused where the root is bound
  read-only, and under bubblewrap's throwaway overlay one may succeed only
  into the layer discarded with the run, so no `.git` at the root is visible
  outside the sandbox. A `.git` that was not there before the task's first
  sealed run is removed after every run, and a removal that fails stops that
  task's shell. So git run later there outside the sandbox, at a repo root or
  the task's working directory, loads no repository the run planted or armed.
  Nor may it leave a link leading out of the worktree and the workspace, a link
  in a directory it closed to you included. A way for one to write anywhere
  else, for anything a read-only task changed to land, for a command of the
  task to run outside the sealed profile once one of its commands has run
  sealed, or for a sealed run to make git outside the sandbox load a repository
  it planted, is in scope. On Linux, a native read or the runner's git racing a
  sealed run still in progress is a known residual (ADR-0046).

  On Linux that profile is the whole guarantee: the PID namespace leaves a
  sealed run no other process to look at. **On macOS, three things no Seatbelt
  rule closes are known and recorded in
  [ADR-0036](docs/adr/planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md),
  and stay open to a command in the sandbox, sealed or not. Reporting one of
  these as new is not needed; a way to close one without breaking the shell is
  welcome, and so is any further route like them:**

  - *Your other processes' command lines and environments.* A command can read
    the command line of your other processes, and the environment of those
    that are not Apple platform binaries, through `sysctl`
    (`kern.procargs2`). Node, Homebrew's Python and dev servers are exposed,
    and their environments often hold API keys and tokens.
  - *Your existing launchd jobs.* Through the bootstrap port it inherits, a
    command can read the definition of a loaded job, environment variables
    included (`launchctl print`), start one, which then runs outside the
    sandbox (`launchctl kickstart`), unload one, and enable or disable one
    persistently. It cannot load or submit a new job.
  - *The shared here-document files.* macOS's `/bin/sh` (bash 3.2) writes
    here-documents to `/private/tmp/sh-thd-N`, so the profile allows reads
    and writes of names of that pattern, and a command can read or overwrite
    one while another of your processes is using it.

  A sealed run has no network, so a value read this way leaves the machine
  only through a later step that has one: a web read, a `curl` or `wget` you
  approved, or a networked command you approved or allowlisted. Those pass the
  envelope's checks, which narrow what a URL or query carries and do not
  close it ([ADR-0027](docs/adr/planner-envelope/0027-web-reads-in-the-planner-envelope.md)).
  A web read is not asked about under `auto`. The native shell, when you opt
  in (next item), is different: it has the network in the same command, so a
  value it reads this way can leave at once, with no check in between. The egress proxy
  ([#88](https://github.com/ordewell/ordewell/issues/88)) and a container or VM
  backend, where other processes are not visible
  ([#99](https://github.com/ordewell/ordewell/issues/99)), are planned
  mitigations.

  On macOS, a process that leaves the run's process group (`setsid`) is also
  not killed with it, though it keeps the sealed profile. If you use a planner
  on macOS to read repositories you do not trust, do not keep long-lived
  secrets in the environment or on the command line of processes that run
  beside it (a dev server started with a token, a shell that exports a key):
  keep them in a file only you can read, the keychain or a credential helper,
  prefer tokens that are short-lived or narrowly scoped, and use Guarded.
- **The native shell, when you opt in.** By default a harness planner's own
  shell is withheld and its commands go through `run_command`. A user setting
  (`ordewell.plannerNativeShell`, or `ORDEWELL_PLANNER_NATIVE_SHELL`) lets
  Claude Code's `Bash` and `Monitor`, or OpenCode 2.x's `bash` and `shell`, run
  too. Ordewell puts its own launcher in front of each command and holds it to
  the sealed profile with the network: the workspace is read-only, one scratch
  directory is writable, there is no home directory, the keychain is withheld,
  and the planner process starts without your credential variables, keeping
  only the harness's own login (ADR-0036 N1–N6). Its network stops at this
  machine: loopback addresses and local Unix sockets are refused, because the
  harness's own server and Ordewell's daemon listen there, and on macOS a
  command can read their passwords from their environments and would then
  have them run what it asked, outside the sandbox. A way for such a command to
  write outside scratch, read a credential store, reach the keychain, reach a
  service on this machine, or run in a shell other than Ordewell's launcher is
  in scope; so is a way to make the setting come from a workspace or a
  repository. The opt-in is off by default
  and offered only for the versions checked live. Its commands are not
  classified — the opt-in is the consent — so it is a second way to read,
  never a second route to an effect. **Residual:** the shell keeps the
  internet, so an injected instruction can send to an address it chose, in
  the same command, the workspace's contents and anything it read through the
  three macOS gaps under Sealed runs, which apply to it too: the command lines
  and environments of your other processes, including the harness's own
  environment with its login and the token for Ordewell's tools. That stays
  open until the egress proxy
  ([#88](https://github.com/ordewell/ordewell/issues/88)) lands.
- **The local API server.** `@ordewell/web` binds `127.0.0.1` and, since
  `0.4.8`, authenticates every request against a bearer token minted at daemon
  startup and written to an owner-readable file; browser `Origin` headers are
  rejected outright and `Host` must name loopback at the daemon's own port.
  Local access is explicitly *not* assumed to be trusted. Anything that makes
  the daemon reachable off-host, that lets a web page in a browser reach it
  (DNS rebinding, permissive CORS), or that gets a route to serve a request
  without a valid token — on the HTTP routes or the WebSocket upgrade — is in
  scope.
- **Credential handling.** API keys are read from the environment and `.env`.
  Any path that writes a key to a log, an error message, a session file under
  `.ordewell/`, or a runner's argv is in scope.
- **Built-in runner manifests and connectors.** Injection through launch,
  mode, environment or discovery configuration is in scope. External plugin
  manifests are ignored and are not loaded or executed.

## What each part can touch

What is true today, without containers. Nothing here is an OS-level sandbox
except where [ADR-0011](docs/adr/planner-envelope/0011-sandboxing-the-planners-shell.md) says so.

- **Planners, research subagents and the supervisor read, and write no file.** They read the
  workspace and the output their own runner saved for them this session, inside
  the exploration envelope. Web reads go through the web-read policy; anything
  else outside the envelope is asked about in Guarded and refused in Full. They
  never write, and they never run the repository's own configuration (hooks,
  project MCP servers, plugins)
  ([ADR-0008](docs/adr/planner-envelope/0008-planner-exploration-envelope.md),
  [ADR-0026](docs/adr/planner-envelope/0026-one-envelope-for-every-planner.md),
  [ADR-0027](docs/adr/planner-envelope/0027-web-reads-in-the-planner-envelope.md),
  [ADR-0028](docs/adr/planner-envelope/0028-planners-never-run-repository-config.md),
  [ADR-0032](docs/adr/planner-envelope/0032-runner-state-outside-the-workspace.md)).
  Their shell commands run in ADR-0011's OS sandbox where the host has one:
  nothing outside a scratch directory can be written, and a command that runs
  without asking has no network. There, a command the envelope would refuse
  without asking runs sealed instead: no network, no home directory, nothing
  readable outside the workspace but the system's own files, and nothing
  written reaching the workspace, and on macOS but for the residuals under
  Sealed runs above. A `!` exclusion and a command you denied are still refused
  ([ADR-0036](docs/adr/planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md)).
  With the native-shell opt-in, a Claude Code or OpenCode 2.x planner may also
  run commands through its harness's own shell, under the same sealed profile
  with the network (see the native-shell item above). The one effect a planner
  performs itself is a script task (next item).
- **Script tasks run as you, with no model.** A script task is a list of
  commands, or a script, that the planner writes into the plan and Ordewell runs
  in your checkout with your workspace's environment. It is outside the
  planner's sandbox and nothing at the OS or network layer bounds it. You
  consent to the body as written: the approval card shows it verbatim, and a
  body that changes needs consent again. A card you do not answer is a denial.
  Autorun in Full, and an Act supervisor, run one without asking; autorun in
  Full does so on a first plan too, so a script can run that no person read,
  from an instruction injected into something the planner read. So does your
  **effect allowlist** (`ordewell.effectAllowlist`, or `ORDEWELL_EFFECT_ALLOW`),
  which covers a script task only when every command in it matches a rule
  exactly, flags included. It is a user-level setting only: a workspace's
  settings and environment files cannot set it, it has no built-in entries, and
  it never covers a shell script or a program named by its path
  ([ADR-0035](docs/adr/supervision/0035-effects-are-consented-and-recorded.md)).
- **Your notify command runs as you, with no approval**, once for each new
  escalation (`ordewell.notifyCommand`, or `ORDEWELL_NOTIFY_COMMAND`). It is a
  user-level setting only: a workspace's settings and environment files cannot
  set it. It runs with no shell, and the escalation reaches it only in sanitized
  environment variables, because part of that text comes from runners. Treat
  those values as untrusted in anything you write around them
  ([ADR-0053](docs/adr/supervision/0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).
- **Change and ops tasks run as you**, with the runner's own native tools, in
  the mode their plan assigned
  ([ADR-0020](docs/adr/isolation/0020-ops-tasks-and-merge-gates.md)). They can read and
  write outside the workspace (caches, temporary folders, your home directory)
  and reach the network; nothing at the OS or network layer bounds them yet. A
  change task works in its own git worktree. An ops task runs in your checkout,
  after a merge gate has put what it depends on there.
- **Read-only tasks land nothing**
  ([ADR-0046](docs/adr/planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)).
  One works in a worktree of its own, which is thrown away when it ends with
  whatever it changed, and its result is its `task_complete` report, which
  Ordewell stores with the verdict. Its shell is Ordewell's `run_command`,
  under the planner's command rules and asking nobody: a read-only command,
  or one your allowlist covers, runs as the planner's would until the task's
  first sealed run, and anything else runs sealed. After that run every
  command runs sealed, allowlisted ones included, since the run may have
  rewritten a script or config file a later command uses. Sealed, the
  workspace is readable, nothing is persistently writable but the task's
  worktree — in a repo group, each of its worktrees, while the group's task
  workspace root is not persistently writable — and a scratch directory of its
  own, the repository's `.git` and the worktree's own `.git` file stay
  read-only, and there is no network and no home directory, so none of your
  credentials. Because a worktree's `.git` cannot be rewritten or replaced, a
  repo group's root is not persistently writable, and a `.git` that was not
  there before the task's first sealed run is removed after every run (one
  that cannot be removed stops the task's shell), git run later there —
  Ordewell's at a repo root or the runner's own at the task's working
  directory — loads no repository a sealed run planted; `task_diff` refuses a
  read-only task outright. On macOS the three gaps listed under Sealed runs
  stay open to these runs too. On Linux a native read or the runner's git
  racing a sealed run still in progress is a residual. Where no sandbox runs,
  what would run sealed is refused.
  Native writes and the native shell are withheld on every runner. Claude
  Code decides native reads against the real paths of the task worktree and
  workspace, refusing outside reads without asking. OpenCode denies external
  directories except those roots; Codex reads through `run_command` with its
  native shell off. Project config is disabled as for planners, and Claude's
  hooks are off. Native web tools are refused: tasks have no planner web-policy
  channel to check them. Ordewell's task tools remain available.

In practice:

- Use **Guarded** for repositories you do not trust.
- Review the plan before it runs. Approving it is the consent point; the
  tasks then do what it says.
- Ops tasks and script tasks are where effects on the outside world happen:
  pushes, deploys, cloud commands.
- Write effect allowlist rules narrowly, and leave out any that run the
  repository's own code (`npm run deploy`, `make release`): such a rule runs
  whatever the repository holds when it runs.

Planned, not yet built:

- A network egress guard for runners
  ([#90](https://github.com/ordewell/ordewell/issues/90)).
- An opt-in container setup with a credential broker and egress proxy
  ([#93](https://github.com/ordewell/ordewell/issues/93),
  [#99](https://github.com/ordewell/ordewell/issues/99)).

## What is out of scope

- The behaviour of the coding agents Ordewell spawns (Claude Code, Codex,
  OpenCode). Report those to their maintainers.
- Ordewell executing a task you asked it to execute. Running agents against your
  code is the product, not a flaw — the boundary that matters is the *planner's*
  read-only envelope.
- Vulnerabilities in dependencies with no exploitable path through Ordewell.
  Send a PR bumping the dependency instead.

Task autonomy is a related but separate boundary, and it's a user setting, not
a security control this policy governs. Some autonomy levels let a task run
without per-step confirmation; the consent gate for that is plan review —
approving a plan is the decision that authorizes what it goes on to do. Once a
plan is approved, executing it is out of scope here for the same reason the
bullet above is: a runner doing what an approved plan says is the product
working, not a boundary failing. Report a way to get a plan approved, or
autonomy granted, without the user actually doing so; don't report an approved
plan's runner behaving as planned.
