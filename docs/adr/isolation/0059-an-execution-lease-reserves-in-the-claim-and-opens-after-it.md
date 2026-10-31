---
status: accepted
implemented: none
amends: ["0013", "0022", "0036"]
note: "Settles #97, #98, #99 and #93 as direction. Local worktrees stay the default; the container backend is opt-in and later."
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
behaviour. The first container backend is the Docker API through the docker CLI. A broker holds API keys and
cloud-provider credentials only, never a Claude subscription's.**

## Key properties

- **Reserve, then open (L1).** `reserve` is synchronous, and answers from what the host holds.
  `claimRefusal` reads `refusal`, in the claim's one step, and `claim()` takes the reservation in that same
  step: `claimRefusal` is also asked with no claim to follow. This count is the tree's pool
  ([ADR-0055](../supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) D18): the
  `child-plan` role reserves a node and no slot. Since `refusal` changes nothing, a claim
  turned down for a slot still calls `reserve`: its `refused` keeps the Session that asked,
  and each `release` ticks the Sessions kept, oldest first, as a scheduler ticks only on its
  own Session's events. `open` runs where `attemptCwd` runs in `Attempts`, and around
  `CliAgentAiService.startAdapter` for a planner, and undoes itself on abort. A later remote backend answers
  `reserve` from a local allocation, or claims become asynchronous, which would be a change to ADR-0029.

  ```ts
  interface ExecutionBackend {
    probe(): Promise<BackendCapabilities>;
    prepare(env: EnvSpec): Promise<EnvHandle>;             // image, repos, dependencies; keyed by content
    refusal(request: LeaseRequest): string | null;         // synchronous, and changes nothing
    reserve(request: LeaseRequest): { lease: ReservedLease } | { refused: string }; // synchronous
    list(): Promise<readonly LeaseRecord[]>;               // what a restart finds; starts nothing
    renew(ids: readonly string[], ttlMs: number): Promise<void>;
  }

  interface LeaseRequest {
    node: { sessionId: string; taskId?: string; attempt?: number; parent?: string };
    role: 'planner' | 'task' | 'script' | 'child-plan';
    runner?: RunnerId;
  }

  interface ReservedLease {
    readonly id: string;
    readonly revoked: AbortSignal;
    open(spec: LeaseSpec, signal: AbortSignal): Promise<OpenLease>;
    release(how: { keep: boolean; landing?: Promise<unknown> | null; reason: string }): Promise<void>; // idempotent
  }

  interface LeaseSpec {
    workspace: { kind: 'checkout' } | { kind: 'none' } | { kind: 'worktree'; intent: AttemptIntent };
    repos: readonly { name: string; baseCommit: string; resultRef: string }[];
    env?: EnvHandle;
    network: NetworkProfile;
    caches: readonly CacheName[];                          // names, never host paths
    credentials: readonly { scope: string; mode: 'gateway' | 'proxy-inject' | 'runner-login' }[];
    limits: LeaseLimits;
    required: readonly Guarantee[];                        // open fails if one cannot be proven
    ttlMs: number;
  }

  interface OpenLease {
    workspace: { cwd: string; writable?: string };
    env: Record<string, string>;
    endpoints: { mcp: string; models: Record<string, string> };
    guarantees: Record<Guarantee, { proven: boolean; by: string; at: string }>;
    spawn(command: RunnerCommand): Promise<RunnerHandle>;
    setNetwork(profile: NetworkProfile): Promise<void>;    // setup and agent phases differ
    exportResult(): Promise<{ refs: Record<string, string>; sessionState: ArtifactRef }>;
  }
  ```

  `IWorktreeIsolation` and `RunnerProcess` stay beneath it, and a runner is still handed a cwd and
  nothing more ([ADR-0013](0013-worktree-isolation.md)). `leasedIsolation` is the wrapper shape to copy.
  A role is policy input, resolved to a `LeaseSpec` before a backend sees it.
- **Results include session state (L2).** A branch is not the whole result. A saved runner session is what a
  Continue resumes, and in a container it dies with the container unless `exportResult` brings it back or a
  per-task volume keeps it. Repositories are plural, as a repo group's are
  ([ADR-0014](0014-multi-repo-workspaces.md)), and caches are named, so nothing in a spec assumes one host's
  paths.
- **Guarantees are proven (L3).** `fs.hostHidden`, `fs.writeScope`, `net.allowlist`, `net.noMetadata`,
  `cred.unreadable`, `kernel.separate`, `limits.memory`. Each is proven by a probe at open, such as reading a
  canary outside the workspace or connecting to a denied host, and reported with how and when. A backend
  declares none. A spec's `required` fails the open, and an in-process check relaxes only on a proven entry. An
  exit reports `oom`, `expired` or `killed` as a typed reason.
- **Local worktrees stay the default (L4).** `LocalWorktreeLease` wraps today's code with no setup and no change
  in behaviour: `reserve` is the Parallel limit, `open` is `attemptCwd`, and `list` reads the session's records.
  It proves what it can, which is little: its report is that a local runner reaches what the user reaches.
- **The first container backend (L5).** The Docker API through the docker CLI, so one code path serves any engine
  that speaks it. It is opt-in. On a laptop it is one container per attempt, started idle with the runner launched
  by exec, non-root, capabilities dropped, a read-only root filesystem, and process, memory and swap limits, with
  no Docker socket inside. That is the laptop's unit. At scale the unit is the trust domain: read-only and planner
  roles stay out of containers, and tasks that share a repository and a credential scope may share one. A
  subplanner stays on the host, under its envelope.

  Ordewell ships a Dockerfile the user builds, and no published image holding Claude Code. Anthropic's page says
  preinstalling or running Claude Code in a product or service needs its Commercial Terms and an unmodified binary
  ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), read 2026-10-31). A user's own build
  is their own install: that is a reading, and needs counsel before it is relied on.
- **Workspace, mirror and caches (L6).** Inside a Mac they live in the VM: a host path, a host socket and an APFS
  clone do not cross it. The mirror pins refs under a lease, with `gc.pruneExpire=never` and `gc.auto=0`, and never
  prunes under one: on git 2.56 a pruned mirror broke a `--shared` clone with `bad object HEAD` (measured
  2026-10-31). A container pushes only through a ref-scoped gate on the host, which takes only that attempt's ref,
  and never gets a writable mirror: a writable bare repository lets an agent plant hooks and config that later run
  on the host. The Ordewell MCP server is reached through `endpoints.mcp`, a route the egress path allows, since a
  container is not on the host's loopback.
- **Credentials (L7).** An egress sidecar per lease, and a base-URL gateway for model traffic. The sidecar is on an
  internal network with no other way out, so a client that ignores it fails rather than leaks. TLS is terminated only
  for a host that needs a credential injected.
  - A broker holds API keys and cloud-provider credentials only. It never holds Claude subscription tokens. Anthropic's
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

- The interface is tested through a fake backend, as `FakeWorktreeIsolation` fakes isolation: a claim with no free
  slot and the release that ticks it, a Stop between reserve and open, an open that fails, a release that runs twice.
- `LocalWorktreeLease` passes the suites the code passes today, unchanged. That is what "no change in behaviour" means.
- The Docker backend's probes run against a real engine, off CI's default path, as the sandbox's Linux end-to-end runs do.
- A guarantee's probe is tested by a backend built to fail it: an open that requires it refuses.

## Out of scope

Warm pools, several hosts, Kubernetes, gVisor, microVMs, TLS interception for arbitrary hosts, and checkpoints of a
running container. Native tools as a planner's default inside a lease, which
[ADR-0036](../planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md) left here, do not arise while
planners stay on the host. Its third network stage, read-scoped credentials for a sealed run, stays open: this broker is
for model traffic first. The interface is kept free of anything that blocks these.

## Considered options

- **One asynchronous `acquire` in the claim.** Rejected: it reopens the race ADR-0029 closed, or makes every claim
  asynchronous.
- **Declared guarantees.** Rejected: a guarantee nobody tested is a label, and an in-process check would relax on it.
- **One repository and host mounts in the spec.** Rejected: it leaks a local assumption into every backend.
- **Static network at acquire.** Rejected: installing dependencies and running an agent want different networks.
- **A branch as the whole result.** Rejected: Continue would break when a container went.
- **A broker holding every credential, subscriptions included.** Rejected: Anthropic's page forbids it. The honest lease
  reports a weaker guarantee.
- **A general TLS-intercepting broker.** Rejected: it needs a CA per lease and breaks pinned clients, and model traffic
  needs only a base URL.
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
- A check held out of a child's reach (ADR-0055 D8) becomes a boundary only on a backend that proves `fs.hostHidden`.
- A subscription user in a container has a weaker guarantee, and is told so.
- Provider terms need a person, or counsel, before a subscription path through a lease ships.

## History

- 2026-10-31 — accepted. Not yet implemented.
- 2026-10-31 — checked against the code: a refusal for a slot keeps the Session, and a release ticks it.
