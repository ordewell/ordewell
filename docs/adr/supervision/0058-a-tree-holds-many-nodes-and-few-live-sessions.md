---
status: accepted
implemented: none
note: "States the scale goal behind ADR-0055. The EventStore (S3) is built as trees need it; the AIMD window (S4) is later."
---

# 0058 — A tree holds many nodes and few live sessions

## Problem

The owner's starting position was tens of thousands of sessions. Whether that is reachable, and what
it means for one person's tool, decides what is built for scale and what is not.
[ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) delegates, and needs an
honest answer to how large a tree may grow, where its state lives, and what stops it.

The research measured one daemon and read the limits above it, on 2026-10-31:

- **In one plan, costs grow with its square.** With fake runners, a status view and a scheduler tick each
  grow as *n*² and run per event; a plan's save is its whole file, on every usage event. A flat plan of a
  thousand tasks saturated long before a thousand sessions. These are costs of one plan, not of the host.
- **Saved plans have walls.** One JSON file per plan stops saving past the size of a V8 string.
- **Provider limits come first.** Claude Opus 5.5's Scale tier allows 2,000,000 output tokens a minute; at
  the output rate one repository's logs show per live session, that is about 680 live sessions (a derived
  figure on mixed models, for sizing). OpenAI's Grow tier is 40,000,000 tokens a minute on its Astra, Sol
  and Terra rows and 180,000,000 on Luna. Cache writes count towards ITPM too, so only reads are free.
- **Memory per harness binds a host,** and the process limit did at about 260 runners on the machine
  measured.
- **Merge verification and review are serial,** and money is what remains.
- **Scale in public is a forest.** About 2,000 concurrent agents is one interview's claim, for a run split
  by hand into harnesses; Cursor's posts say several hundred
  ([vendor](https://cursor.com/blog/self-driving-codebases)).

## Decision

**A node is a row and a live session is a slot. What limits scale is provider limits, memory per harness,
merge verification and money, not the control plane. One machine runs tens of live sessions; a tree may hold
thousands of nodes over its life. Tens of thousands live is not a goal for a tool one person runs. Large trees
need API or cloud-provider credentials: a subscription login is for ordinary individual use.**

This is a design target and no promise to a user, and nothing here is a performance figure for one.

## Key properties

- **The scale goal (S1).** A parked node, between its turns or waiting on its children, holds no process
  (ADR-0055 D18) and costs a few rows. So node count is bounded by money and shape, and live sessions by the
  root's Parallel limit, which the user sets knowing their machine and account. Anthropic's page says its Pro,
  Max and Ultra limits "assume ordinary, individual usage"
  ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), read 2026-10-31), so a large
  tree belongs on an API key or a cloud provider, and Ordewell says so where delegation is turned on.
- **Small plans are the shards (S2).** The *n*² costs belong to one plan, so bounded fan-out and a cap on a
  child plan's tasks (ADR-0055 D19) keep each plan where those costs do not matter. A tree needs no sharded
  store for that. The fixes the daemon measurement found stay worth making for a large flat plan, and are ordinary
  work rather than a decision.
- **An EventStore port (S3).** One append-only log per root, behind a port in core, so a tree's history
  survives without being a save of everything.

  ```ts
  interface EventStore {
    append(events: readonly TreeEvent[]): Promise<void>; // ordered; a batch lands whole
    read(after: number, path?: NodePath): AsyncIterable<TreeEvent>;
    close(): Promise<void>;
  }
  ```

  - Its first backend is append-only JSONL per root, under the root's state directory, with no new dependency:
    the VS Code extension allows 1.90, and `node:sqlite` is not in its Node. SQLite can back the port later on a
    daemon host.
  - It holds node lifecycle, budget events, reports and board entries. A report's event carries its digest
    and its reference; the whole handoff stays in the attempt's log
    ([ADR-0047](0047-structured-task-handoffs.md)), which a reference reads.
  - Deltas stay in the per-attempt logs, and most events are deltas. Session files stay as they are until a
    later migration.
  - Node ids are immutable, and the path, `root/3/2`, is derived from them: a move in a plan rewrites no
    history. State is a fold of the log, read at load.
- **Admission (S4).** Live sessions are admitted, not requests: the pool of ADR-0055 D18 is the admission, at
  `reserve` ([ADR-0059](../isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md) L1).
  Later, an AIMD window per credential and model shrinks admission on a rate limit. It needs a signal
  Ordewell does not yet get: runners report no 429 to their adapters today.
- **Only one layer retries (S5).** A provider's error is retried inside the runner, and Ordewell adds no retry of
  its own around a rate limit: stacked retries multiply. A task's failed work is a different thing, retried by a
  planner under its guards and its budget ([ADR-0056](0056-a-mandate-narrows-down-the-tree.md) M10).
- **Verification goes by level (S6).** A leaf runs its own checks, an interior node runs affected checks on the
  merged result, and the root runs everything. A clean merge proves little, and these are tasks: the check of a
  delegated task (ADR-0055 D8), and the root's final check, which the planner prompt teaches. Ordewell cannot
  derive what "affected" means in a repository, so only D8 is enforced.

## Testing decisions

The port is tested through an in-memory fake and the JSONL backend against the same suite: order, a batch whole,
a torn last line dropped on read, a read after a cursor. The fold is a pure function, tested by replaying a log
into the state a live tree held. The scale harness is an offline bench, and no CI test asserts a rate.

## Out of scope

Several hosts, worker agents, a database, archiving a closed subtree, and pacing resumes after a restart. Each
stays possible behind the port or the lease.

## Considered options

- **Tens of thousands live, as first proposed.** Rejected as a goal. At the rate limits above, that many active
  sessions needs a custom tier or several organisations, a cluster and a review capacity no person has. Sessions
  over time is the reachable reading, and it is what a parked node allows.
- **A workflow engine.** Rejected: one adds a server or a database against zero setup, and recovers by re-running
  deterministic code, which a model session is not. A session is an external activity, and only the scheduler's
  state is a fold.
- **SQLite first.** Rejected for now: core runs in-process in VS Code, and a native module would cost the zero
  setup it protects. The port keeps it open.
- **Hosting the log in each child.** Rejected: a tree's order is one order, and a child's state already lives
  under the root (ADR-0055 D11).
- **Putting deltas in the log.** Rejected: they are most of the volume, and a surface reads them from the attempt
  log.
- **Copying whole reports into the log.** Rejected: two stores of one handoff drift.
- **Tuning one plan until it holds thousands.** Rejected as the route to trees: the save and reload walls need
  sharded state anyway, and a tree is that shard.

## Consequences

- The scale story is a set of small plans, and it depends on the caps staying caps.
- Two stores hold run state until the migration: session files for plans, the log for what crosses a level.
- The Parallel limit becomes a tree's, and Ordewell still sets no ceiling on it: that stays the user's to judge.
- Nothing here sizes for several hosts, and the port and lease are what is kept open.

## History

- 2026-10-31 — accepted. Not yet implemented.
