---
status: accepted
amends: ["0013"]
---

# 0049 — A session has one live host: the session lease

*Pending:* [ADR-0055](../supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) — the root's lease covers its tree, and a child session holds none of its own.

## Problem

Nothing stopped two Ordewell processes from running one session at once.
Every TUI launch gets a private daemon on a free port, so two TUIs, or a TUI
and a daemon started by `ordewell run`, are two **hosts** in one checkout.
Each adopts a saved session when asked — the daemon's `POST
/api/sessions/:id/load`, the client's automatic re-adoption on
`session_not_found`, VS Code's session load and restore — and none of them
asked whether another live process was already running it.

On 2026-10-24 two hosts ran one session for about a quarter of an hour. Both
continued its isolation run, so a task whose order had not changed got the same
worktree path and branch in both: the second host's `prepare` removed the
"previous" worktree, which was the first host's live attempt, and re-created it,
leaving two runners in one directory; where the first still had the branch
checked out, `git worktree add -B` failed. Both wrote the session file, and the
last writer dropped the other's isolation records, orphaning its worktrees.
Both wrote the same task logs. The first host's task logs then stopped at one
instant while at least one of its Claude Code runners went on editing its
worktree for another ten minutes: a host that goes away can leave its runners
alive and writing.

## Decision

**A host holds a session's lease while it has the session open; another host
is refused that session while the holder lives, and takes the lease over once
the holder and every runner it started are gone.**

The lease is `lease.json` in the session's own directory under
`.ordewell/sessions/` (beside its task logs). It records the holder's pid, a
host id minted once per process, what kind of host it is when known (a daemon
and its port, the TUI a private daemon serves, a VS Code window), when it took
the lease, a heartbeat, and the process groups of the runners it has started.

The **Session** holds its own lease through a `SessionLease`, built by
`createSession` from the process's `LeaseHost`, so every host that runs a
Session — the daemon, the VS Code extension host — is covered at one seam.

## Key properties

- **Claim before adopting (L1).** `Session.loadPlan` of a different plan claims
  the lease of the session it adopts before it drops anything it holds, so a
  refusal leaves the plan held now as it was. A new session's lease is claimed
  at its first save, a host-assigned id's as its planning starts. The pool
  destroys a Session whose adoption was refused; the live one keeps running.
- **A refusal names the holder (L2).** `SessionHeldError` carries the holder as
  data (`SessionHeld`) and says it in plain words: who, by pid and kind, and
  since when. The daemon answers it with `409` and the code `session_held`,
  with `sessionHeld` in the body. The client's automatic re-adoption hands that
  refusal to the caller instead of the `404` before it, and the TUI, `ordewell
  sessions load` and VS Code show its words.
- **Takeover needs the holder gone, and its runners (L3).** A lease may be
  taken over when its holder's pid answers no signal, or its heartbeat is older
  than `LEASE_STALE_MS` (a pid that answers may have been handed to another
  process). Even then it is refused while any process group the holder recorded
  still has members: a host killed outright never ran the teardown that stops
  its runners, and they go on writing in the worktrees a new holder would
  prepare. The refusal names those groups and how to stop them.
- **Every write holds the lock (L4).** Taking the lease, its heartbeat and
  letting it go each run holding `lease.json.lock` (`withFileLock`, the settings
  file's lock), and write by rename. A takeover and the old holder's heartbeat
  therefore cannot both write, and no reader sees half a lease.
- **No lease, no save and no run (L5).** `Session.persist` saves nothing while
  another host holds the session, and says so once. The orchestrator's
  isolation is wrapped (`leasedIsolation`) so that every change to the run —
  start, prepare, reopen, land, release, prune, merge, discard, sweep — is
  refused without the lease; reads of git go through. VS Code's own direct
  save checks too.
- **A lost lease stays lost (L6).** A holder whose heartbeat finds another host
  in its lease file has lost the session: it is told so, stops its run, and
  saves nothing more. What it holds is older than what the new holder has saved,
  so it never claims the lease back on its own; opening the session again is
  the user's.
- **Released on close and shutdown (L7).** `Session.destroy` lets the lease go
  and the Session never takes it again: a save that settles afterwards is
  dropped, not a reason to hold the session from every other host. A new plan
  under a fresh id lets it go too; the daemon's shutdown destroys its sessions,
  VS Code's deactivation its Session, and the process lease host lets every
  lease go on exit. A host in one process holds a lease once for all its
  Sessions of that session, so a daemon replacing a live Session under its id
  keeps it.

## The lease file

| Field | What it is |
| --- | --- |
| `hostId` | Minted per process, so a restarted process at a reused pid is not the holder. |
| `pid` | Probed with signal 0; `EPERM` counts as alive. |
| `host` | `{ kind: 'daemon', port, ownerPid? }` or `{ kind: 'vscode' }`; absent when unknown. |
| `since` | When this host took the lease. |
| `heartbeatAt` | Refreshed every `LEASE_HEARTBEAT_MS` by a timer that never keeps the host up. |
| `runnerGroups` | `runnerGroups()` from `processTree`: the groups this host leads that still have members, refreshed with every heartbeat and as each runner starts. |

A record naming this very pid under another host id is a host that died and
whose pid this process was given, unless that id is another `LeaseHost` alive
in this process, as a test makes.

## Testing decisions

Two hosts are two `LeaseHost`s with different ids in one test process, over
one real temporary workspace: two Sessions built with `makeSession({ leaseHost
})`, or two `OrchestratorPool({ leaseHost })`s. Liveness (`alive`,
`groupAlive`), the clock (`now`) and the recorded runner groups are injected,
so a dead holder, a stale heartbeat and orphaned runners need no process. A
session given its own `saveSession` holds no lease unless given a host, so the
suites that never touch disk are unaffected. The surfaces are tested at their
own seams: the daemon route's code and body, the client's re-adoption against a
throwaway HTTP server, the TUI effect and the CLI command against a refusal.

## Out of scope

- Locking across machines or over network filesystems.
- The private daemon per TUI, which stays as it is.
- Cleaning up the worktrees the incident orphaned.
- Read-only viewing of a held session beyond what `GET /api/sessions/:id`
  already serves from the file.
- Refusing `DELETE /api/sessions/:id` for a session another host holds.

## Considered options

- **Build on the daemon's port ownership (`ensureDaemonOwned`).** Rejected: it
  answers whether a daemon listens on a port, and every TUI's private daemon is
  on its own port; VS Code is no daemon at all.
- **One daemon per workspace.** Rejected here: it changes the private daemon per
  TUI, and still leaves VS Code as a second host.
- **The in-process isolation locks (`IsolationLocks`).** Rejected: promise
  chains in one process; the hosts are two processes.
- **A pid file with no heartbeat.** Rejected: a dead holder's pid can be handed
  to another process, which would hold the session for ever.
- **An OS lock held by an open descriptor (`flock`).** Rejected: Node has none
  without a native addon, and it would not carry the holder's words.
- **Exclusive create of the lease file alone, no lock.** Rejected: taking over
  a dead lease means removing it first, and two takers, or a taker and an old
  holder waking to beat, can each remove the other's.
- **Kill the dead holder's runners on takeover.** Rejected: a recorded group id
  is recyclable once the group empties, and signalling a stranger's group is
  what `killTree` refuses to do. The refusal names the groups instead.
- **End a runner from its Ordewell binding when its host is gone.** Rejected:
  the binding is a server the runner calls; a runner whose calls fail goes on
  editing.
- **Record only the session's own runners.** Rejected for now: the spawn is
  several layers below the Session. A host records all its groups in every
  lease it holds, which can refuse a takeover over a runner of another of its
  sessions, and never lets one through beside a live runner.

## Consequences

- A second TUI, CLI daemon or VS Code window opening a running session is told
  who runs it instead of running it again.
- A crashed host's sessions reopen once its pid is gone, or a minute after its
  last heartbeat, and only once its runners are stopped.
- A host suspended past the stale age (a debugger, `SIGSTOP`) can be taken over
  if its runners have ended; when it resumes it finds itself lost and stops.
- On Windows a runner has no process group of its own, so no groups are
  recorded and a killed host's runners are not detected there.
- Every save reads the small lease file first.

## History

- 2026-10-24 — accepted.
- 2026-10-24 — L7 states that a destroyed Session never takes its lease again: a late save claimed it back and held the session from every other host.
