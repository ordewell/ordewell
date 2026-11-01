---
status: accepted
implemented: partial
amends: ["0013", "0022", "0036"]
note: "Settles #97, #98, #99 and #93 as direction. Built: L1 to L6, in `services/executionLease.ts`, `LocalWorktreeLease` and `services/container/`, and L7's broker. L7's egress sidecar and model gateway are the next change: until they land, a container lease is no network guarantee."
---

# 0059 — An execution lease reserves in the claim, opens after it, and proves what it guarantees

## Problem

Where a session runs is spread out: `RunnerProcess` starts every agent, `IWorktreeIsolation`
makes a workspace, the Parallel limit is a number read in several places, and nothing says what
a session can reach. A task in a write-capable mode can do whatever the user can
([ADR-0022](../runners/0022-ordewell-mcp-server.md) A6), so a check is hidden from a runner only
by which tools it holds, and a child's runner keeps the network
([ADR-0056](../supervision/0056-a-mandate-narrows-down-the-tree.md) M9). #97 asks for one seam,
#98 for workspaces behind it, #99 for an opt-in container backend, and #93 for a credential
broker and an egress proxy.

Two facts shape that seam. [ADR-0029](../supervision/0029-the-supervisor.md)'s claim checks approval,
Stop and a free slot in one synchronous step, and a lease that awaits there reopens the race the
claim closed: two starts on one slot. And provider terms decide what a broker may hold.

This is the *execution lease*. It is not the
[session lease](0049-a-session-has-one-live-host.md), which says which host holds a session.

## Decision

**A session runs under an execution lease, taken in two steps: a synchronous reserve inside the claim,
and an asynchronous open where an attempt's workspace is made today. A backend proves what it guarantees
by probe at open and never declares it. Local worktrees stay the default, with no setup and no change in
behaviour. The first container backend is the Docker API through the docker CLI, and what it cannot be, it refuses to
be. A broker holds API keys and cloud-provider credentials only, never a Claude subscription's.**

## Key properties

- **Reserve, then open (L1).** `reserve` is synchronous, and answers from what the host holds.
  `claimRefusal` reads `refusal`, in the claim's one step, and `claim()` takes the reservation in that same
  step: `claimRefusal` is also asked with no claim to follow. This count is the tree's pool
  ([ADR-0055](../supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) D18): the
  `child-plan` role reserves a node and no slot. Since `refusal` changes nothing, a claim
  turned down for a slot, or a resume at a limit's reset, still calls `reserve`: its `refused`
  keeps the Session that asked, and each `release` ticks the Sessions kept, oldest first, as a
  scheduler ticks only on its own Session's events. `open` runs where an attempt's workspace is made in `Attempts`,
  and around `CliAgentAiService.startAdapter` for a planner. Once aborted it makes nothing, and one aborted while it
  worked is undone by `letGo`, since only the attempt knows what became of the task since. A later remote backend
  answers `reserve` from a local allocation, or claims become asynchronous, which would be a change to ADR-0029.

  What ends with an attempt is its lease; its worktree need not. A repair reopens it and a continue restores it, and a
  task with no attempt can still have one, so `release` gives the slot back, synchronously since a repair claims the
  slot its attempt freed in the same step, and `letGo` decides the workspace, with no lease needed. `Landing`'s own
  release stays beneath the seam: it comes while the attempt is live, and its slot is held. A merge starts no session
  and passes no claim, so it reserves a `merge` lease, which holds no slot: every route to a checkout, an automatic
  merge's included, is one a backend hears of and can refuse.

  This is the interface as built, in `services/executionLease.ts`. L7 adds what only it needs, `setNetwork` and the
  gateway's credential modes. A lease spec holds no network, caches, credentials or limits of its own: a role is resolved
  before a backend sees it, and those are the backend's settings.

  ```ts
  interface ExecutionBackend {
    probe(): Promise<GuaranteeReport>;
    refusal(request: LeaseRequest): string | null;         // synchronous, and changes nothing
    reserve(request: LeaseRequest): { lease: ReservedLease } | { refused: string }; // synchronous
    letGo(taskId: string, how: { keep: boolean; landing?: Promise<unknown> | null; reason: string }): Promise<void>;
    list(): Promise<readonly LeaseRecord[]>;               // what a restart finds; starts nothing
    collect?(taskId: string): Promise<void>;               // brings work kept elsewhere to its worktree; rejects with why it must not land
  }

  interface LeaseRequest {
    node: { sessionId: string; taskId?: string };
    role: 'planner' | 'task' | 'script' | 'child-plan' | 'merge';
    runner?: RunnerId;
  }

  interface ReservedLease {
    readonly id: string;
    readonly holdsSlot: boolean;
    open(spec: LeaseSpec, signal: AbortSignal): Promise<OpenLease>;
    release(reason: string): void;                         // idempotent and synchronous
  }

  interface LeaseSpec {
    task?: Task;
    workspace: { kind: 'checkout' } | { kind: 'worktree'; intent: AttemptIntent };
    required: readonly Guarantee[];                        // open fails if one cannot be proven
  }

  interface OpenLease {
    workspace: { cwd: string; writable?: string; worktree: boolean; previousWork?: PreviousWork; repos?: readonly LeaseRepo[] };
    guarantees: Record<Guarantee, { proven: boolean; by: string; at: string }>;
    exportResult(session: LeaseSessionState): { refs: Record<string, string>; sessionState: LeaseSessionState };
    placement?: RunnerPlacement;                           // set where the runner does not run on this host
    ended?(): Promise<LeaseExit | null>;                   // 'oom' | 'killed'
  }

  interface RunnerPlacement {
    place(launch: RunnerLaunch): Promise<PlacedLaunch>;    // what this host launches instead, and how to stop it where it runs
    reach(url: string): Promise<string>;                   // `endpoints.mcp`: a listener on this host's loopback, from there
  }
  ```

  `IWorktreeIsolation` and `RunnerProcess` stay beneath it, and a runner is still handed a cwd and
  nothing more ([ADR-0013](0013-worktree-isolation.md)). `leasedIsolation` is the wrapper shape to copy.
  A role is policy input, resolved to a `LeaseSpec` before a backend sees it.
- **Results include session state (L2).** A branch is not the whole result. A saved runner session is what a Continue
  resumes, so a container keeps it in a per-task volume that outlives the container, and `exportResult` stays the
  synchronous read it was: an attempt's end saves the session's id before anything can read it, and a container has no
  files to copy for that. The work is the half that takes time and can be refused, so it is a backend's `collect(taskId)`,
  by task since a landing can come after its attempt, as a Mark complete does. It runs after the runner has gone and
  before Landing, whichever start it; a next attempt of the task waits for it too, since a Continue restores what the
  worktree holds. A backend with none has its work there already, and nothing about a flat run moves. Work it will not
  bring back lands nothing and waits on the user, as a merge git refused does. Repositories are plural, as a repo group's
  are ([ADR-0014](0014-multi-repo-workspaces.md)): all of them come through or none, and caches are named, so nothing in a
  spec assumes one host's paths.
- **Guarantees are proven (L3).** `fs.hostHidden`, `fs.writeScope`, `net.allowlist`, `net.noMetadata`,
  `cred.unreadable`, `kernel.separate`, `limits.memory`. Each is proven by a probe at open, run where the runner will run
  and with what it will hold, and reported with how and when: a canary of this host and the task's own path looked for,
  every mount accounted for, writes tried, the cgroup read, a connection tried. The host judges what the probe found. A
  backend declares none. A spec's `required`, and the backend's own, fail the open, and an in-process check relaxes only
  on a proven entry. An exit reports `oom` or `killed` as a typed reason; `expired` comes with the first backend that has a
  time limit.
- **Local worktrees stay the default (L4).** `LocalWorktreeLease` wraps today's code with no setup and no change
  in behaviour: `reserve` is the Parallel limit, `open` is `attemptWorkspace`'s answer to the run, and `list` reads the session's records.
  It proves what it can, which is little: its report is that a local runner reaches what the user reaches.
- **The first container backend (L5).** The Docker API through the docker CLI, so one code path serves any engine
  that speaks it, in `DockerExecutionBackend`, around the local backend, which keeps the slots and the worktrees. It is
  opt-in, by the `containers` setting, in the file only; one it cannot use refuses every container, where the rest of that
  file falls back to a default, since a typing mistake must not mean the host. The host's worktree stays where a task's
  result lives, so Landing, a repair and a Continue are what they were. A runner is launched by exec into one container
  per attempt, non-root, capabilities dropped, a read-only root filesystem, `--init --pids-limit 8192 --memory <limit>`
  with swap held to the same limit, on every container a helper's included, and no Docker socket inside.
  - The container's one process is an idle relay, and its stdin is its lease: when the host goes, by any death, the pipe
    closes, the relay exits and `--rm` takes the container with everything in it. Nothing needs a time limit to renew. A
    killed `docker exec` leaves its process running, so a runner is stopped by its pid inside.
  - A change task of a runner proven in a container runs there: Claude Code, today. Read-only and planner roles stay out,
    as does a script's literal body and a subplanner, which stays on the host under its envelope. Work in the user's
    checkout cannot run there, so an ops task, or a task of a run that shares its workspace, is refused rather than run
    weaker. That is the laptop's unit. At scale the unit is the trust domain: tasks that share a repository and a
    credential scope may share one.
  - Measured on Colima with Docker 29.5, 2026-11-01: a container's start, `docker run` to its entry ready, took 179 to 224
    ms over eleven; a lease's whole open, with mirror, seed and probe, 303 to 909 ms over thirty, by how busy the machine
    was. Claude Code 2.1.316 at rest, attached to its tools and past a turn refused for want of a login, held 150 to 152
    MiB of its cgroup at its peak, with an RSS near 227 MB. No credential was available, so no memory of a harness at work
    has been measured.

  Ordewell ships a Dockerfile the user builds, and no published image holding Claude Code. Anthropic's page says
  preinstalling or running Claude Code in a product or service needs its Commercial Terms and an unmodified binary
  ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), read 2026-10-31). A user's own build
  is their own install: that is a reading, and needs counsel before it is relied on.
- **Workspace, mirror and caches (L6).** Inside a Mac they live in the VM, in named volumes: a host path, a host socket
  and an APFS clone do not cross it, so no mount reaches this host. A repository's mirror is seeded by git over a helper
  with no network, so only what it lacks crosses. It pins each task's refs for as long as that task's clone leans on it,
  with `gc.pruneExpire=never` and `gc.auto=0`, and never prunes under one: on git 2.56 a pruned mirror broke a `--shared`
  clone with `bad object HEAD` (measured 2026-10-31). An attempt only ever mounts it read-only: a writable bare repository
  lets an agent plant hooks and config that later run on the host. Its volume holds the task's clone, put back on what the
  host holds at each attempt, and the runner's home.
  - Work leaves through a ref-scoped gate on the host (`pushGate.ts`), with the attempt's container already gone, so no
    process of it can change what is read. A helper bundles a snapshot of the workspace on one ref. The gate takes that
    ref alone, named for the attempt, under git's object checks, only on the attempt's base, moving no ref of the
    repository, and never believes what the bundle says of itself. There is no listener: the bundle comes over the helper's
    stdout. The snapshot then goes into the host's worktree as a local attempt would have left it, its commits on the
    branch and the rest uncommitted, for Landing to commit under the handoff's message.
  - Nothing a container wrote runs on this host on its way there. So a lease refuses a repository with a hook a landing
    fires, and a worktree setup command, which would run what was last landed in the next worktree. A script task still
    runs on the host over what landed; that is a person's or a planner's stated command, and the seam does not hide it.
  - The Ordewell MCP server is reached with no network at all: the relay listens on the same port of the container's own
    loopback and carries each connection over its stdio, so the URL is unchanged and
    [ADR-0022](../runners/0022-ordewell-mcp-server.md) T2's Host check still holds, on any engine and under any egress. It
    connects only to what was forwarded, whatever a frame says, since a process in the container can write the relay's
    stdout. `apply_patch` is refused in a container: it merges into a worktree the runner does not work in.
- **Credentials (L7).** An egress sidecar per lease, and a base-URL gateway for model traffic. The sidecar is on an
  internal network with no other way out, so a client that ignores it fails rather than leaks. TLS is terminated only
  for a host that needs a credential injected. These two are not built: `EgressPath` is the seam they plug into, and its
  one path today is the engine's default network, which reaches the internet and this host's loopback. So a container
  lease alone is no network guarantee: `net.allowlist` is always reported unproven, a setting that requires it refuses
  every lease, and the user is told as the first one opens.
  - A person chooses the login, and it has no default: `broker`, API keys or cloud credentials from this host's
    environment, or `own-sign-in`, made inside a container and kept in a volume Ordewell mounts and never reads.
  - A broker holds API keys and cloud-provider credentials only (`CredentialBroker`). It never holds Claude subscription
    tokens, and refuses one under any name it can recognise. Until the gateway lands, a lease hands a key over by name, so
    a runner can read it and the lease reports `cred.unreadable` unproven. Anthropic's
    page says "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to
    a Claude account must complete through Anthropic's own flow". It keeps open an end user signing in to the unmodified
    binary. So a subscription stays with the user's own sign-in inside the lease, and that lease reports
    `cred.unreadable` as not proven.
  - One Codex `auth.json` never serves concurrent attempts. OpenAI: "Do not share the same file across concurrent jobs
    or multiple machines", and not on public or open-source repositories
    ([CI/CD auth](https://developers.openai.com/codex/auth/ci-cd-auth)). A copy per container is that shape.
  - Passing a user's own OAuth token through Ordewell, into a lease or a gateway, is treated as not allowed until
    Anthropic says otherwise. A runner on the local backend inherits the user's own environment as it does today (L4):
    Ordewell carries nothing there.
  - A proxied lease sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`: behind a proxy, Claude Code's memory grew
    until killed in user reports, open at [#67433](https://github.com/anthropics/claude-code/issues/67433). The
    diagnosis is theirs, and no fix is documented, so a probe watches for it.

## Testing decisions

- The interface is tested through a fake backend, `FakeExecutionBackend`, as `FakeWorktreeIsolation` fakes isolation: a
  claim with no free slot and the release that ticks it, a Stop between reserve and open, an open that fails, a release
  that runs twice.
- `LocalWorktreeLease` passes the suites the code passes today, unchanged, and `executionLease.flatRun.test.ts` is a table
  over Parallel limits that passed on the scheduler before the lease went in. That is what "no change in behaviour" means.
- `dockerLease.e2e.test.ts` runs against a real engine, off CI's default path, as the sandbox's end-to-end runs do: it
  skips where no engine answers and on CI unless `ORDEWELL_REQUIRE_DOCKER=1`, and is one suite, so one at a time. A fake
  harness runs in a real container through the real adapter, MCP server and Landing. `ORDEWELL_E2E_HARNESS_IMAGE` adds
  the real binary, from an image built as `docker/task.Dockerfile` says.
- A guarantee's probe is tested by a backend built to fail it: an open that requires it refuses. The relay and the gate
  need no engine: the relay runs as itself on this host's node, and the gate takes real bundles built as a hostile
  container would build them.

## Out of scope

Warm pools, several hosts, Kubernetes, gVisor, microVMs, TLS interception for arbitrary hosts, and checkpoints of a
running container. Native tools as a planner's default inside a lease, which
[ADR-0036](../planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md) left here, do not arise while
planners stay on the host. Its third network stage, read-scoped credentials for a sealed run, stays open: this broker is
for model traffic first. The interface is kept free of anything that blocks these.

## Considered options

- **One asynchronous `acquire` in the claim.** Rejected: it reopens the race ADR-0029 closed, or makes every claim
  asynchronous.
- **`release(how)` deciding the worktree too.** Dropped once it met the code. A slot goes back as an attempt ends, before
  the scheduler has decided what becomes of its worktree, and many of those decisions have no attempt in hand: a cancel of
  a task with none live, a skip, a retry.
- **Declared guarantees.** Rejected: a guarantee nobody tested is a label, and an in-process check would relax on it.
- **One repository and host mounts in the spec.** Rejected: it leaks a local assumption into every backend.
- **Static network at acquire.** Rejected: installing dependencies and running an agent want different networks.
- **A branch as the whole result.** Rejected: Continue would break when a container went.
- **A broker holding every credential, subscriptions included.** Rejected: Anthropic's page forbids it. The honest lease
  reports a weaker guarantee.
- **A general TLS-intercepting broker.** Rejected: it needs a CA per lease and breaks pinned clients, and model traffic
  needs only a base URL.
- **`ttlMs`, `renew` and `revoked` on a lease.** Dropped once it met the engine. They were what keeps a container from
  outliving a dead host, and its stdin does that with nothing to renew. A remote backend, whose lease has no such pipe, is
  where they return.
- **`prepare(env)`, an environment keyed by content.** Not built: the image is the user's own, and nothing here builds one.
- **An asynchronous `exportResult`, or a `collect` on the open lease.** Dropped: the session's id is a synchronous read, and
  a Mark complete lands after its attempt, with no open lease in hand.
- **The host's loopback by `host.docker.internal`.** Rejected: it fails [ADR-0022](../runners/0022-ordewell-mcp-server.md)
  T2's Host check, differs by engine, and asks the network path for what a pipe already gives.
- **A gate that listens on the host for a real `git push`.** Rejected: it opens a port a container can reach, for what a
  bundle over a helper's stdout does with none.
- **Landing a container's work with hooks off.** Rejected: it would silently drop a check the user set up, such as a secret
  scan. Refusing says so, and leaves the choice with them.
- **Falling back to the host when a container cannot start.** Rejected: that is running weaker with nobody told.
- **One container per attempt as the unit at scale.** Rejected: a container per attempt pays setup every time. It is
  right for one laptop, where the unit and the trust domain coincide.
- **A published image.** Rejected: see L5.
- **A warm pool first.** Rejected: nothing measures that container start needs one, and a per-task environment defeats it.
- **gVisor or microVMs first.** Rejected for now: file-heavy agents and hardware virtualisation are questions for a later
  backend, and the interface does not preclude either.
- **A container tool reached through MCP, with the harness left on the host.** Rejected: its native tools stay unconfined.

## Consequences

- The Parallel limit gets one owner, and the tree's pool a home.
- `Attempts` and `CliAgentAiService` open a lease where they make a workspace and start an adapter.
- A task's reach can be stated, and only a proven entry relaxes anything. On the local backend that is nothing.
- A repository with git hooks, a worktree setup command, and an ops task do not run under containers yet, and each says so.
  A project's dependencies are the runner's to install, in a volume cache, since a host's setup does not reach a container.
- A check held out of a child's reach (ADR-0055 D8) becomes a boundary only on a backend that proves `fs.hostHidden`.
- A subscription user in a container has a weaker guarantee, and is told so.
- Provider terms need a person, or counsel, before a subscription path through a lease ships.

## History

- 2026-10-31 — accepted. Not yet implemented.
- 2026-10-31 — checked against the code: a refusal for a slot keeps the Session, and a release ticks it.
- 2026-10-31 — a resume at a limit's reset refused for a slot is kept the same way.
- 2026-10-31 — L1 to L4 implemented for the local backend: `release` frees the slot and `letGo` decides the worktree, a merge reserves a lease with no slot, and a result is read synchronously.
- 2026-11-01 — L5, L6 and L7's broker implemented: a Docker backend, a mirror and task volumes in the engine, a push gate, `collect` on a backend, and the relay as the container's entry and its route to the MCP server. `ttlMs`, `renew`, `revoked` and `prepare` dropped.
