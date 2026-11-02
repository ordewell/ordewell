---
status: accepted
implemented: partial
amends: ["0013", "0022", "0035", "0036", "0056"]
note: "Settles #97, #98, #99 and #93 as direction. Built: L1 to L7, in `services/executionLease.ts`, `LocalWorktreeLease` and `services/container/`. Open: ADR-0036's third network stage, for which this broker holds nothing yet."
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

  This is the interface as built, in `services/executionLease.ts`. L7 adds nothing to it: a lease's way out, its gateway
  and its credentials are the backend's own. A lease spec holds no network, caches, credentials or limits of its own: a
  role is resolved before a backend sees it, and those are the backend's settings.

  ```ts
  interface ExecutionBackend {
    probe(): Promise<GuaranteeReport>;
    refusal(request: LeaseRequest): string | null;         // synchronous, and changes nothing
    reserve(request: LeaseRequest): { lease: ReservedLease } | { refused: string }; // synchronous
    letGo(taskId: string, how: { keep: boolean; landing?: Promise<unknown> | null; reason: string }): Promise<void>;
    list(): Promise<readonly LeaseRecord[]>;               // what a restart finds; starts nothing
    collect?(taskId: string): Promise<void>;               // brings work kept elsewhere to its worktree; rejects with why it must not land
    settle?(): Promise<void>;                              // all it has running has gone, as its Session closes; keeps what a next attempt comes back to; never rejects
    checkoutRepos?(): readonly LeaseRepo[];                // the workspace root's repositories, where a run knows them
    reclaim?(): Promise<void>;                             // lets go of what its tree left where only it can reach; never rejects
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
    blob(file: string): Promise<string | undefined>;       // a file of the attempt as it stands there, as git would name it
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
  bring back lands nothing and waits on the user, as a merge git refused does: it stays in the task's volume, a next
  attempt fails rather than seed over it (`KeptWorkError`, which lets nothing go), and a Retry is what gives it up.
  What says so is an empty volume of the engine's, by the task's name, so it outlives this Session and no process in a
  container can lift it. Repositories are plural, as a repo group's
  are ([ADR-0014](0014-multi-repo-workspaces.md)): all of them come through or none, and caches are named, so nothing in a
  spec assumes one host's paths.
- **Guarantees are proven (L3).** `fs.hostHidden`, `fs.writeScope`, `net.allowlist`, `net.noMetadata`,
  `cred.unreadable`, `kernel.separate`, `limits.memory`. Each is proven by a probe at open, run where the runner will run
  and with what it will hold, and reported with how and when: a canary of this host and the task's own path looked for,
  every mount accounted for, writes tried, the cgroup read, the ways out tried. The host judges what the probe found. A
  backend declares none. `net.allowlist` is what was tried and stopped, never how the lease was built: an address outside
  and this host's loopback by every name an engine has for it, each tried straight out as a client that ignores the
  proxy, a route out, a name only the world's DNS answers, and each of those again through the lease's own proxy, where a
  403 is the only answer that counts. Those are the ways out a bridge container was measured to reach. The loopback is
  tried at a listener on this host, whose count a process in the container cannot lie about, and a target the probe says
  nothing of counts against it. `cred.unreadable` looks for a key held back by a salted digest, in every environment the
  container can read. A probe with no lease behind it holds no login, so it reports `cred.unreadable` unproven, as it
  tried nothing a lease would hold. A spec's `required`, and the backend's own, fail the open, and an in-process check
  relaxes only on a proven entry. An exit reports `oom` or `killed` as a typed reason; `expired` comes with the first backend that has a
  time limit.
- **Local worktrees stay the default (L4).** `LocalWorktreeLease` wraps today's code with no setup and no change
  in behaviour: `reserve` is the Parallel limit, `open` is `attemptWorkspace`'s answer to the run, and `list` reads the session's records.
  It proves what it can, which is little: its report is that a local runner reaches what the user reaches.
- **The first container backend (L5).** The Docker API through the docker CLI, so one code path serves any engine
  that speaks it, in `DockerExecutionBackend`, around the local backend, which keeps the slots and the worktrees. It is
  opt-in, by the `containers` setting, in the file only, and held out of a published build as delegation is
  (ADR-0055 D21): the setting is read only with `ORDEWELL_CONTAINERS=1` in a build run from a git checkout
  (`containersOffered`), and elsewhere it is ignored with one warning that the build offers no containers, since the
  review's findings are not all closed and nobody may believe they are isolated when they are not; one it cannot use refuses every container, where the rest of that
  file falls back to a default, since a typing mistake must not mean the host. The host's worktree stays where a task's
  result lives, so Landing, a repair and a Continue are what they were. A runner is launched by exec into one container
  per attempt, non-root, capabilities dropped, a read-only root filesystem, `--init --pids-limit 8192 --memory <limit>`
  with swap held to the same limit, on every container a helper's included, and no Docker socket inside.
  - The container's one process is an idle relay, and its stdin is its lease: when the host goes, by any death, the pipe
    closes, the relay exits and `--rm` takes the container with everything in it. Nothing needs a time limit to renew. A
    killed `docker exec` leaves its process running, so a runner is stopped by its pid inside. A Session that closes
    stops its run, and is `gone` once its runners have and `settle` has taken its containers, relays and gateways: what a
    close waits on, so a session adopted next finds nothing of it at work. A task's volume stays for a Continue.
  - A change task of a runner proven in a container runs there: Claude Code, Codex at Full access, and OpenCode, which
    `containerRunners.ts` lists with what a lease needs of each. So does every script, whatever its
    runner: a body is a person's or a planner's, but what it runs over is what containers wrote, so `npm test` on the host
    would run that code outside the boundary. Read-only tasks and planners stay out, under their envelope and their seal,
    as does a subplanner ([ADR-0055](../supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md)). A
    child Session has a backend of its own around its own local lease, built from what its root read of the setting once:
    the setting is session-wide, so a change to it cannot put a child on this host, or a child alone in a container. So
    its tasks and scripts and a delegated task's repair, which is role `task`, take the same path. A runner's work in the user's checkout cannot run there, so an ops
    task of a runner, or a task of a run that shares its workspace, is refused rather than run weaker. That is the laptop's
    unit. At scale the unit is the trust domain: tasks that share a repository and a credential scope may share one.
  - A script of the workspace root ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)) runs on a copy
    of what that root has committed, which its merge gate has brought what landed to first, and its exit status is its
    evidence as ever. Nothing of it comes back: only a landing brings container-written work to a checkout. It holds no
    login, and the workspace's variables stay here. So a script that needs this host's credentials fails, saying why, and
    uncommitted changes do not reach it; the user is told once. A read-only script runs likewise on its throwaway worktree
    with no network at all, which is what ADR-0056 M9's seal holds a child's script to, and needs no sandbox on this host.
  - Turning containers on asks one thing, a Docker this product can use (`inspectEngine`): a local engine, by a `unix://`
    endpoint from `docker context inspect`, that answers, runs Linux containers on cgroup v2, on a Linux or Mac host. An
    engine elsewhere is refused and never warned of, since this host's paths and loopback, which the proofs try, are not
    its own. The image and login can follow: `{}` is on, and refuses every task, never the host (`changeContainers`, the
    one way a surface changes the setting). `inspectReadiness` is what a surface and a lease both ask, so what one reports
    the other refuses, and a lease asks it again from the raw setting at each start, as a Docker that stopped or a
    sign-in that went is only found there. A surface's check (`containerStatus`, `proveEngine`) proves what a throwaway
    container can, and holds no login, so it never answers for `cred.unreadable`, and a lease proves its own in any case.
    What was measured and what is taken on trust are shown apart (`CONTAINER_ASSUMPTIONS`): a forwarded socket looks like a
    local one, `kernel.separate` means separate from this host and never from another task, as one engine has one kernel
    (one VM, on a Mac), and a task has no limit on CPU or disk. A `containers.memory` above what the engine has is refused,
    as Docker accepts it and it limits nothing. Rootless Docker is not refused: the proofs decide.
  - Measured on Colima with Docker 29.5, 2026-11-01: a container's start, `docker run` to its entry ready, took 179 to 224
    ms over eleven; a lease's whole open, with mirror, seed and probe, 303 to 909 ms over thirty, by how busy the machine
    was, and 441 to 489 ms over ten once it opened a sidecar. Claude Code 2.1.316 at rest, attached to its tools and past a
    turn refused for want of a login, held 150 to 152 MiB of its cgroup at its peak, with an RSS near 227 MB, and 150 MiB
    through one turn of a scripted model behind the gateway, a file written and `task_complete`. No credential was
    available, so no memory of a harness at real work has been measured.

  Ordewell ships a Dockerfile the user builds, and no published image holding Claude Code. Anthropic's page says
  preinstalling or running Claude Code in a product or service needs its Commercial Terms and an unmodified binary
  ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), read 2026-10-31). A user's own build
  is their own install: that is a reading, and needs counsel before it is relied on.

  Codex's Guarded mode does not run in a container, and a task at it is refused, not moved. `codex sandbox` was run in
  this lease's container on codex 0.166.0: bubblewrap fails, `use_legacy_landlock` panics with `filesystem-restricted
  execution requires bubblewrap`, and with seccomp and AppArmor off bubblewrap still fails at `Failed RTM_NEWADDR`. So
  what it lacks is past those two profiles, in what this hardening withholds, and the adapter's probe, put to the
  container's own binary, is what refuses, at the handshake and before a model turn. The task is held with the reason, nothing lands,
  and its mode stays as planned
  ([ADR-0001](../routing/0001-autonomous-mode-resolution.md)). At Full access the container is what holds the runner,
  which is the point of a lease: Codex's sandbox is off, and the guarantees here are not. A level left at Guarded, the
  default, plans such tasks, and each waits for a person to change it.
- **Workspace, mirror and caches (L6).** Inside a Mac they live in the VM, in named volumes: a host path, a host socket
  and an APFS clone do not cross it, so no mount reaches this host. A repository's mirror is seeded by git over a helper
  with no network, so only what it lacks crosses. It pins each task's refs for as long as that task's clone leans on it,
  with `gc.pruneExpire=never` and `gc.auto=0`, and never prunes under one: on git 2.56 a pruned mirror broke a `--shared`
  clone with `bad object HEAD` (measured 2026-10-31). Its pins sit under their tree's name. An attempt only ever mounts it read-only: a writable bare repository
  lets an agent plant hooks and config that later run on the host. Its volume holds the task's clone, put back on what the
  host holds at each attempt, the runner's home, and its package caches: a cache tasks share lets one task's code run in
  the next, so a task's stay its own, and a retry keeps them.
  - Work leaves through a ref-scoped gate on the host (`pushGate.ts`), with the attempt's container already gone, so no
    process of it can change what is read. A helper bundles a snapshot of the workspace on one ref. The gate takes that
    ref alone, named for the attempt, under git's object checks, which it runs itself over a pack of what the ref brings,
    since a fetch from a bundle skips them on an older git (2.40 skips them, 2.47 does not), only on the attempt's base, moving no ref of the
    repository, and never believes what the bundle says of itself. There is no listener: the bundle comes over the helper's
    stdout. The snapshot then goes into the host's worktree as a local attempt would have left it, its commits on the
    branch and the rest uncommitted, for Landing to commit under the handoff's message.
  - Nothing a container wrote runs on this host on its way there. So a session on such a backend runs every git call of
    its isolation with hooks off (`withoutHooks`): a commit, a merge, a worktree cut, a Continue's preserve and merge, and
    Merge all, by `core.hooksPath`, so it names no hook and misses none, one git adds later included. The gate takes
    nothing where git looks for the repository's hooks, as a folder it tracks is a task's to write: landed there, a hook
    would be armed in the user's checkout for their next commit. A check the user set up must not go silently, so a lease
    still refuses a repository with a hook a landing would have fired. That list is what is said, never the boundary. It
    refuses a worktree setup command too, which would run what was last landed in the next worktree. What still can run
    is a sealed command, a read-only task's or a planner's, over what landed: inside its seal (ADR-0036), not outside it.
  - What a tree leaves in the engine goes with it (`reclaim.ts`), by the label every container, network and task volume
    carries, since a session delete has no Session left to ask: `ExecutionBackend.reclaim` for a Clean up and a Discard,
    `reclaimContainers` for a delete, once the session has gone: a helper of a closing attempt that names a volume already
    taken makes it again, with no label. Every mirror is read, since a landed task's pin outlives its volume. One it took
    the last pin from goes whole, with any cache volume an earlier build left for its project, the one time nothing leans
    on either. Every clean-up mounts every mirror, so one that overlaps holds it for a moment: the removal outlasts that,
    reading the pins again between rounds and giving up the moment one appears, since what held it may be a new session's
    first push. One still refused after that is told, and stays for a person to remove. One it held none in is another
    project's, and stays, unless it holds nothing at all: that is what a helper made by naming a mirror another clean-up had
    just taken. A person's sign-in volume is theirs. Without the setting, Docker is not asked.
  - A pin on the board (ADR-0057 R9) reads its file through the lease, since until `collect` the worktree here holds what
    the attempt was seeded with.
  - The Ordewell MCP server is reached with no network at all: the relay listens on the same port of the container's own
    loopback and carries each connection over its stdio, so the URL is unchanged and
    [ADR-0022](../runners/0022-ordewell-mcp-server.md) T2's Host check still holds, on any engine and under any egress. It
    connects only to what was forwarded, whatever a frame says, since a process in the container can write the relay's
    stdout. The same pipe carries the other way for a runner whose own server the host must speak to, as OpenCode's is: the
    host listens on its own loopback and the relay dials the container's, so no port is published and no network is used.
    `apply_patch` is refused in a container: it merges into a worktree the runner does not work in.
- **Credentials and egress (L7).** An egress sidecar per lease, and a base-URL gateway for model traffic, behind
  `EgressPath`. A bridge container was measured to reach 1.1.1.1:443 and this host's loopback through
  `host.docker.internal`; on an `--internal` network neither answers, no name outside resolves, and there is no route.
  - The sidecar (`egressSidecar.ts`) is on that network and the bridge, so a client that ignores it fails rather than
    leaks. It runs the task's image, needing only node, under the limits of any container, goes with its pipe as the relay
    does, and listens on the lease's network alone: the bridge joins after it has. It opens a CONNECT to port 443 of a host on the lease's list and nothing else, and reads none of what
    passes. A name is resolved there and its answer checked and dialed as it stands, so one that answers with a private
    address is turned down however it is listed: this sidecar's other network reaches the engine's host. The list is
    `containers.allow`, or the registries of the caches named, and an `own-sign-in` lease adds where its runner talks to
    its service. A broker's lease lists no model host: under a key of its own, the model API would be a way out. Any host on a list is a
    way out for what can use it, and a client can name a listed host and be served another by a shared CDN: a list says
    where a connection goes, and no more.
  - The gateway (`modelGateway.ts`) runs on this host and is reached through the relay, with no network. An API key
    stays here, and the runner holds a token that means nothing past that listener, so `cred.unreadable` is provable for a
    broker's lease. A lease has a token of its own, so concurrent tasks on one key hold nothing in common. It carries model
    traffic alone, to the one upstream, under the real key whatever a client sent: a
    process in the container can spend the key and cannot read it, send it elsewhere or use the API under its own. TLS
    ends there, for that one host, which is the only interception a lease does. Each runner names its `ModelApi`: Codex's
    is the Responses API, under a bearer key. Claude Code reads the address from its environment; OpenCode is given a
    provider block in its own configuration, pointing `anthropic` at the gateway with the stand-in, since it does not read
    `ANTHROPIC_BASE_URL` for a provider's base. `app-server` reads neither `OPENAI_API_KEY` nor `OPENAI_BASE_URL`, so it is
    pointed at the gateway by a provider of its own in `-c`, over HTTP alone, which the gateway carries. A task's key is
    its own runner's, and a login's other keys stay here, so a two-key login does not hand one over in the clear. A model
    of another provider, or a person's own sign-in, is handed its key or its login and reaches its provider's hosts
    through the sidecar instead.
  - A person chooses the login, and it has no default: `broker`, API keys or cloud credentials from this host's
    environment, or `own-sign-in`, made inside a container and kept in a volume no task mounts. Each runner keeps its own
    sign-in volume and its own place the runner reads it from: Claude Code's config directory, OpenCode's data directory.
    A helper in the engine, with that volume read-only, copies it into the task's own volume as the task first starts, so
    nothing a task writes reaches the original or another task, and this host never reads it. That stops writing and
    nothing else: the runner can read its copy. Which login someone uses is up to them, API usage or their own
    subscription, and so are its terms: the maintainer decided so on 2026-11-01. Ordewell's part is what it holds, which
    is below.
  - The sign-in itself is `claude auth login`, the person's own, under `docker run -it`: the unmodified binary prints
    Anthropic's address and takes back the code the person's browser is given, so Ordewell sees neither. Whether a login
    is held is `claude auth status`'s to say (`ASK_SIGN_IN`), in readiness and at the hand-off: an abandoned sign-in
    leaves files and no login. It answers from those files, with no network, and an expired login reads as held, so a
    start proves a login is there and never that it works. A Claude Console sign-in with no API key is kept outside the
    configuration directory, by Anthropic's page, so it does not survive into the volume. A runner with no such question
    (`ContainerSignIn.ask`) has its volume found by readiness, and what the volume holds judged by its copy.
  - Every copy is one login, and the task's copy is the task's to keep. A token it refreshes stays there, and a copy is
    replaced only by a new sign-in (`COPY_SIGN_IN`), which keeps its sessions. Measured on Claude Code 2.1.316, 2026-11-02,
    against a controlled provider whose refresh tokens work once: the refresh reached `platform.claude.com` through
    `HTTPS_PROXY`, went into the task's copy and left the original byte for byte, and the next copy of the same token was
    refused, failed `OAuth session expired and could not be refreshed`, and was cleared by the binary. So where a provider
    rotates, the first refresh kills the original and every other copy. Anthropic does not document rotation; user reports
    say it does ([#54443](https://github.com/anthropics/claude-code/issues/54443),
    [#77130](https://github.com/anthropics/claude-code/issues/77130)). No real account has been run. A person who signs in
    again gets the new login to a task at its next attempt, and this is told as the login's limit on a surface.
  - A broker holds API keys and cloud-provider credentials only (`CredentialBroker`). It never holds Claude subscription
    tokens, and refuses one under any name it can recognise. Beside a key it refuses what that key's runner ranks over it
    (`ModelApi.outranksKey`), since the task would not run on the login the person meant, and a task of another runner
    is handed none of those. What a cloud provider's client signs with has to reach it, so
    those go by name, a runner can read them, and the lease reports `cred.unreadable` unproven. Anthropic's
    page says "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to
    a Claude account must complete through Anthropic's own flow". It keeps open an end user signing in to the unmodified
    binary. So a subscription stays with the user's own sign-in inside the lease, its traffic passing the sidecar
    unread, and that lease reports `cred.unreadable` as not proven.
  - One Codex `auth.json` never serves concurrent attempts. OpenAI: "Do not share the same file across concurrent jobs
    or multiple machines", and not on public or open-source repositories
    ([CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)). A plain copy per task is not that shape, since
    refresh tokens rotate and each copy would spend the same one. So a task's copy (`COPY_CODEX_SIGN_IN`) holds the access
    token and the account, with no refresh token and a fresh `last_refresh`, and a helper refuses a kept file that is an
    API key, has expired, or holds no tokens. `auth.openai.com` stays off the list: nothing in a task can refresh, so the
    kept sign-in is not spent, and it lasts as long as its access token. A person signs in again when it ends. With a
    refresh token empty and `exp` valid, codex 0.166.0 starts and calls with the access token, and past `exp` it fails
    cleanly, by fake tokens over HTTP. A turn on a ChatGPT account is not measured: its backend takes HTTPS alone, and no
    account is spent here. OpenAI's guide does not describe this copy, and which login someone uses stays up to them.
  - Passing a user's own OAuth token through Ordewell, into a lease or a gateway, is treated as not allowed until
    Anthropic says otherwise. A runner on the local backend inherits the user's own environment as it does today (L4):
    Ordewell carries nothing there.
  - A proxied lease sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`: behind a proxy, Claude Code's memory grew
    until killed in user reports, open at [#67433](https://github.com/anthropics/claude-code/issues/67433). The
    diagnosis is theirs, and no fix is documented, so the memory limit and its `oom` report are what stand for it.

## Testing decisions

- The interface is tested through a fake backend, `FakeExecutionBackend`, as `FakeWorktreeIsolation` fakes isolation: a
  claim with no free slot and the release that ticks it, a Stop between reserve and open, an open that fails, a release
  that runs twice.
- `LocalWorktreeLease` passes the suites the code passes today, unchanged, and `executionLease.flatRun.test.ts` is a table
  over Parallel limits that passed on the scheduler before the lease went in. That is what "no change in behaviour" means.
- `dockerLease.e2e.test.ts` runs against a real engine, off CI's default path, as the sandbox's end-to-end runs do: it
  skips where no engine answers and on CI unless `ORDEWELL_REQUIRE_DOCKER=1`, and is one suite, so one at a time. CI's
  `real-engine` job, and `npm run test:containers` on a Mac, run these suites against every real binary through
  `scripts/container-e2e.mjs`, whose verdict (`bench/containers/verdict.mjs`) counts a skip as unverified, never as a pass.
  A fake
  harness runs in a real container through the real adapter, MCP server and Landing, a delegated child plan and its
  repair included. `ORDEWELL_E2E_HARNESS_IMAGE` adds the real binary, from an image built as `docker/task.Dockerfile` says,
  through a turn of a scripted model behind the gateway. `ORDEWELL_E2E_OPENCODE_IMAGE` does the same for OpenCode: the
  real `opencode serve` in a container, its own server reached through the relay, and a controlled Anthropic model on this
  host behind the lease gateway that writes a file and calls `task_complete`. `codexContainer.e2e.test.ts` does the same for
  Codex under `ORDEWELL_E2E_CODEX_IMAGE`: two tasks at once through the gateway, the relay's MCP and the gate, and the real
  sandbox refusing Guarded.
- A guarantee's probe is tested by a backend built to fail it: an open that requires it refuses, and the engine's default
  network is what `net.allowlist` must catch. The relay, the sidecar and the gate need no engine: the relay and the sidecar
  run as themselves on this host's node, a preload standing in for the world's DNS and sockets, and the gate takes real
  bundles built as a hostile container would build them.

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
- **`setNetwork`, a network that changes during a lease.** Dropped once it met the code: there is no moment to change it
  at. Dependencies are the runner's to install as it works, so a lease's one list holds its registries throughout.
- **A branch as the whole result.** Rejected: Continue would break when a container went.
- **A broker holding every credential, subscriptions included.** Rejected: Anthropic's page forbids it. The honest lease
  reports a weaker guarantee.
- **A general TLS-intercepting broker.** Rejected: it needs a CA per lease and breaks pinned clients, and model traffic
  needs only a base URL.
- **The gateway in the sidecar.** Rejected: the key would live in the engine, in a process on the runner's own network,
  for what the relay reaches with no network at all.
- **`--network none` and the proxy on this host, through the relay.** Rejected: the probe's proof would be simpler, but a
  bug in the proxy would then reach this host's loopback, where a sidecar's worst reach is the engine's.
- **One writable sign-in volume mounted into every task.** Dropped: a task could rewrite what the next task signs in
  with, and concurrent tasks would share one refreshing credentials file.
- **Copying a sign-in again at every attempt.** Dropped once measured: a Continue overwrote the token the task had
  refreshed with one the refresh had killed.
- **Writing a refreshed token back to the kept sign-in.** Rejected: it is a way for one task to write what the next signs
  in with, which is why no task mounts that volume, and concurrent writers would race over one credentials file.
- **Copying again when a task's copy no longer reads as a login.** Rejected: it would run the harness over config a task
  wrote, in a helper that holds the kept sign-in.
- **Refreshing in a helper before a hand-off, or leaving the token host off a task's list.** Not built. The binary has no
  refresh command, and the second only moves the failure to the token's expiry; neither can be proven without a real
  account.
- **A package cache every task of a project shares.** Dropped: it is a way for one task's code to run in the next.
  Keeping the speed would take a cache no task can write, which nothing fills yet.
- **Refusing containers until the image and login are set.** Rejected: an image is built after a person learns their
  Docker works, and being on with nothing chosen refuses every task.
- **Warning of a remote engine and going on.** Rejected: a probe on another machine proves nothing of this one.
- **`api.anthropic.com` on a broker lease's list.** Rejected: a process in the container could then send anything there
  under a key of its own. It stays on an `own-sign-in` list, which cannot avoid it, and that lease proves less.
- **An empty list unless `allow` names hosts.** Rejected: naming a cache says a task installs from there, and nothing
  would install. `"allow": []` is one word away, and the docs say what a registry on the list costs.
- **A script left on the host as a person's stated command.** Dropped: a stated command over what a container wrote runs
  that code outside the boundary, whoever stated it.
- **Refusing a script of the workspace root, as a runner's ops task is.** Rejected: that is every script of a plan that
  is not read-only, and a script has no work to bring back, so a copy loses nothing a landing needs.
- **Bringing a checkout script's writes back.** Rejected: only a landing brings container-written work to a checkout, and
  this would be one nobody reads, past the gate.
- **Dropping any mirror with no pin.** Rejected: a project of another session may have made one a moment ago. A clean-up
  takes only what it emptied, and a volume with nothing in it, which has nothing to lose and which a push makes again.
- **Retrying a refused mirror for longer, without reading it again.** Rejected: what holds it may be a new session's first
  push, and the removal that follows takes that session's pin.
- **A person or counsel checking provider terms before a subscription path ships.** Dropped on 2026-11-01: which login
  someone uses is theirs to choose. What Ordewell holds stays as L7 says.
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
- **Refusing a repository's hooks at the lease, and landing with them on.** Dropped: a check at open sees only the hooks
  there then, so a task could write one into a tracked folder, and a list of the hooks a landing fires is never whole:
  it missed `post-index-change`. Hooks off closes it as a kind, and the refusal stays so that no check goes silently.
- **Hooks off with no refusal.** Rejected: it would silently drop a check the user set up, such as a secret scan.
- **Falling back to the host when a container cannot start.** Rejected: that is running weaker with nobody told.
- **Codex's Guarded mode in a container, by loosening it.** Rejected: its sandbox fails with seccomp and AppArmor off as
  well, which leaves the hardening L3 proves, given up for a boundary inside one that already holds.
- **A Guarded Codex task moved to Full access at spawn.** Rejected: modes are never silently rewritten (ADR-0001).
- **A plain copy of Codex's `auth.json` per task, or refreshing it for them.** Rejected: rotation makes every copy but one
  stale, and refreshing would put a person's tokens through this host, which never reads them.
- **`chatgptAuthTokens`, or a gateway for a ChatGPT token.** Rejected: Ordewell would hold and pass a person's sign-in,
  which L7 keeps it from for a subscription, and such a gateway would stand in front of a private backend.
- **Codex access tokens now.** Not built: they are for ChatGPT Enterprise workspaces and nothing here can prove one. It
  would reach the runner by name, as a cloud credential does, with `chatgpt.com` on the list.
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
- A repository with git hooks, a worktree setup command, and a runner's ops task do not run under containers yet, and each
  says so. A project's dependencies are the runner's to install, in its task volume's cache, since a host's setup does not
  reach a container, and a script's to install too, since it has a task volume of its own. Each task downloads them
  for itself.
- A script that needs this host's credentials or writes to the checkout does not do so under containers: a `git push` fails,
  and a script's writes stay in its container. The setting is session-wide, so such a step runs in a session without it.
- A lease takes a network of the engine, whose address pools are finite, and one a dead host left stays until a clean-up.
- A sealed command over what landed still runs on this host, inside its seal.
- A check held out of a child's reach (ADR-0055 D8) becomes a boundary only on a backend that proves `fs.hostHidden`.
- A subscription user in a container has a weaker guarantee, and is told so: a runner can read its copy, and where the
  provider rotates, tasks side by side can end each other's login.
- A login a task lost is found only by that task failing: a start proves it held, and nothing can sign in for the person.
- A Codex change task runs in a container at Full access alone. Under the default Guarded level a planned Codex task
  waits at its start until a person changes it. The runner catalog still offers Guarded, since its marks are host-wide
  and a lease is a session's.
- A ChatGPT sign-in for Codex ends with its access token, and a person renews it by hand.

## History

- 2026-10-31 — accepted. Not yet implemented.
- 2026-10-31 — checked against the code: a refusal for a slot keeps the Session, and a release ticks it.
- 2026-10-31 — a resume at a limit's reset refused for a slot is kept the same way.
- 2026-10-31 — L1 to L4 implemented for the local backend: `release` frees the slot and `letGo` decides the worktree, a merge reserves a lease with no slot, and a result is read synchronously.
- 2026-11-01 — L5, L6 and L7's broker implemented: a Docker backend, a mirror and task volumes in the engine, a push gate, `collect` on a backend, and the relay as the container's entry and its route to the MCP server. `ttlMs`, `renew`, `revoked` and `prepare` dropped.
- 2026-11-01 — L7 implemented: the egress sidecar and the model gateway behind `EgressPath`, and `net.allowlist` proven by probe and required by default. `setNetwork` dropped. Scripts run in containers, a child's tasks and repairs are proven there, a pin reads through the lease, and `reclaim` clears what a tree leaves. The terms check before a subscription path ships dropped: which login someone uses is up to them.
- 2026-11-01 — A container session's git runs with hooks off and the gate takes nothing in a tracked hooks folder; work not brought back stops a next attempt; a close waits on `settle`; a child takes its root's backend; a probe reports `cred.unreadable` unproven. Refusing hooks alone dropped.
- 2026-11-01 — the gate runs git's object checks itself, since a fetch from a bundle does not on an older git.
- 2026-11-01 — containers are experimental and off in published builds: `containersOffered` reads the `containers` setting only with `ORDEWELL_CONTAINERS=1` from a git checkout, as delegation is held.
- 2026-11-02 — `changeContainers`, `inspectEngine` and `inspectReadiness`: on asks for a local Docker alone, and a task's start rechecks the raw setting. A task works from its own copy of a sign-in, and keeps its caches in its own volume. Shared caches and a sign-in volume mounted into tasks dropped.
- 2026-11-02 — Codex change tasks run in containers at Full access: `containerRunners.ts`, a gateway per model API, a task's sign-in copy without a refresh token, and Guarded refused at start by the sandbox probe in the container.
- 2026-11-02 — The sign-in is `claude auth login` and `claude auth status` says whether one is held; a task's copy is replaced only by a new sign-in, with refresh measured against a controlled provider; a broker refuses a variable that outranks the key. Copying at every attempt dropped.
- 2026-11-02 — L6: overlapping clean-ups no longer strand a mirror, and a session delete waits for the session to have gone before it clears the engine.
- 2026-11-02 — OpenCode runs a change task in a container: a per-runner sign-in volume and copy, the relay's reverse direction for its own server, and its Anthropic provider pointed at the lease gateway. A runner's binary is asked of the image before a worktree is made, and a model's provider hosts are opened where nothing gates its traffic.
- 2026-11-02 — The real-engine suites run in CI as the `real-engine` job and by hand as `npm run test:containers`, where a skip fails the run rather than passing it.
