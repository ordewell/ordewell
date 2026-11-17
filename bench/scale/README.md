# Scale benchmark (`bench/scale/`)

Where one Ordewell daemon breaks, by measurement. Offline and free: no model, no
API key, and no dist, since `build.mjs` bundles core's source, internals
included, with esbuild. The results these were written for are in the handoff
of the task that wrote them; rerun them rather than trusting old numbers.

```bash
node bench/scale/target.mjs --out after.json        # the whole laptop-scale target of ADR-0058, repeated
node bench/scale/target.mjs --checkout ../base --out before.json   # the same, measured on another checkout
node bench/scale/target.mjs --compare before.json after.json       # two runs side by side
node bench/scale/build.mjs                          # after any change to core
node bench/scale/ops.mjs                            # one operation against plan size
node --expose-gc bench/scale/live.mjs --sessions 100 --rate 1.6 --events 180 --heap
node --expose-gc bench/scale/live.mjs --sessions 30 --tasks 2000 --rate 200 --events 8 --budget 400 --heap  # a tree's lifetime
node bench/scale/mcpload.mjs                        # the MCP server alone
node --expose-gc bench/scale/memory.mjs             # heap per task and Session, lease heartbeat
node bench/scale/logs.mjs                           # task log writes and reads
node bench/scale/procs.mjs                          # real fake-claude processes
node bench/scale/real.mjs .ordewell/sessions        # what real runs left, as aggregates
```

| File | What it measures |
| --- | --- |
| `target.mjs` | ADR-0058's target as one command: `live.mjs` at tens of sessions and thousands of tasks, repeated and taken by the median, then `ops.mjs`. It exits non-zero if a repeat left tasks unfinished or `ops.mjs` broke, keeping what it measured, and runs a checkout's own scripts, so a before and an after come from one command. |
| `compare.mjs` | What `target.mjs --compare` says: figures and a ratio, and a warning where two runs had another machine or target. It gives no verdict, since no test asserts a rate. |
| `ops.mjs` | The tick, a mutation, a save, the view, a wake-up, a tree's ledger and log, and a start's prompt at each plan size. `--only` picks sections; past 5,000 tasks each runs once. |
| `live.mjs` | N sessions live in one Session through the whole pipeline but for the processes. One JSON line out. |
| `swarm.mjs` | The fake processes: `Swarm.spawn` stands where `spawn` does in `StructuredRunnerDeps.process`, so the real Claude adapter and everything above it run. |
| `mcp.mjs`, `loadgen.mjs` | The real `OrdewellMcpServer` with connections held by other processes. |
| `mcpload.mjs` | Closed-loop MCP calls on a no-op tool. |
| `memory.mjs` | Heap per plan task, per idle Session, and a lease heartbeat. |
| `logs.mjs` | `openTaskLog`, appends and whole-file reads. |
| `procs.mjs` | Real child processes, for the spawn, the pipes and the attach. |
| `real.mjs` | Sizes and rates from a sessions folder, the calibration for the rest. |
| `scale.test.mjs` | Runs `ops.mjs`, `live.mjs` and `target.mjs` small under `npm run test:bench`, since a change to core's internals breaks them with no type error. |
| `compare.test.mjs` | `compare.mjs`, with no run at all. |

## Reading the numbers

A figure from here belongs in a handoff or a review, not in anything a user reads:
it describes one machine on one day, and ADR-0058 calls its target a design target
and no promise.

- **Calibration.** Task sizes and the event mix come from this repository's saved
  sessions: `real.mjs` prints them. `--rate 1.6` makes 0.09 usage events a second
  per session, their median, since one event in 18 here is a usage report.
- **Timing.** `timed` reports the fastest repeat, or the lesser of wall and CPU
  time for a run that happened once or twice, so other work on the machine does
  not read as cost. `live.mjs` reports wall clock: look at `loadavg` and `cpuS`.
- **No listening port.** A sealed run may not `listen`, even on loopback, so
  `mcp.mjs` builds the server's HTTP listener by hand and hands it connections
  through `emit('connection')`, over socketpairs a child holds as stdio. Past the
  socket it is the real path, but these are Unix socketpairs, not TCP, and they
  are opened ahead, so the cost of accepting a connection is not in the numbers.
- **The clients use `http`, not `fetch`.** `fetch` needs WebAssembly, which a
  sealed run's address-space limit aborts, so `bench/pipeline/fake-claude`
  cannot call `task_complete` there: `procs.mjs` ends each turn with `noComplete`.
- **A lifetime.** `--tasks` ends a run at that many tasks with `--sessions` of them
  live at a time, so `saves`, `status` and the heap show what a long tree pays
  rather than a burst. The saves write whole plans to disk: thousands of tasks
  write gigabytes, so mind the volume before raising it.
- **`ORDEWELL_DIRENV=false`** leaves direnv out of each spawn. A workspace with
  direnv evaluates it per spawn by design, and that shows in a CPU profile.
- **Sessions move in step.** The swarm paces every session alike, so a thousand
  usage events can land together. A rate over a run means what it says; a single
  stall (`lag.max`) past a few hundred sessions is worse than real runners, whose
  events are spread out, would give.
- **`--counterfactual no-view`** stubs the status broadcast and `persist` out. It
  shows what the event path alone carries, and is no measure of any fix.
- **Isolation** needs `--isolate`: it puts a counting `git` first on PATH and runs
  real worktrees in a throwaway repository. The fake writes one file per task.
- **`fake-claude` is a Node script and the swarm has no process at all.** Nothing
  here says what a real runner costs in memory or CPU.

## Long session

`long.mjs` holds one long session as the daemon would and measures what it costs
as it loads, streams, saves, is edited and is talked to: hundreds of tasks, most
of them settled and landed, a planner conversation of hundreds of turns, and a
few tasks live beside them. Each point of its grid runs in a process of its own,
under a throwaway home, and the session it opens is written by another process
first, so the heap it reads holds nothing of the generator.

```bash
node --expose-gc bench/scale/long.mjs --out after.json                   # the grid at the default size, as a table and a file
node --expose-gc bench/scale/long.mjs --checkout ../base --out before.json   # the same, with another checkout's scripts and core
node bench/scale/long.mjs --compare before.json after.json               # two runs side by side (target.mjs --compare reads them too)
node --expose-gc bench/scale/long.mjs --point --settled 280 --turns 400  # one point, one JSON line
node --expose-gc bench/scale/long.mjs --from ~/project/.ordewell/sessions   # the sizes of a real saved session
```

**The grid.** Settled tasks at 0, a third and all of `--settled`, with the whole
conversation; then all of them with no conversation. The last two columns of
the table are the slopes: a figure's change per 100 settled tasks (over the
first three points) and per 100 turns (over the last two). A slope is what a fix
to growth should move; one point says little.

**Sizes**, each the median of this repository's longest saved session unless
given: `--tasks 300 --settled 280 --turns 400`; per task `--prompt-chars 2400`,
`--handoff-chars 1200` (the digest's summary) with `--findings 4`,
`--attempts 1.5` (their mean, each with its usage ledger and its log on disk of
`--log-kb 178`), `--skill-share 0.33` of them carrying the skill text their
attempt was given (`--skill-chars 1100`); per turn `--research-per-turn 3.7`
research log entries; `--decisions 150` decision record entries; and an
isolation run with every settled task's landing and `--isolated 8` task records.
A turn is an input (the user's message, or a wake-up two times in three) and its
reply, a call at the command seam in two of five, a host notice in one of ten,
and a compaction checkpoint every 130. `--from <folder>` takes every size from
the largest session in a `.ordewell/sessions` folder (or `--from-session <id>`'s),
by count and median length; a flag given beside it still wins. It reads that
folder and never writes there, prints no word of it, and hands the points only
the numbers. The words themselves are generated: what it reproduces is the
shape and size of the session, not its content.

**The run.** `--live 6` tasks are started by hand (`run_task`) and stream
`--events 120` events each at `--rate 6` a second through the swarm, the real
runner adapter and the MCP server (as `live.mjs` has them). Over that time,
`--mutations 8` edits (a task's words, a task added, the same removed, a
dependency changed, in turn) and `--planner-turns 4` turns of a fake planner
that streams thinking, one research step and its reply. `--host pool` (the
default) opens the session through packages/web's `OrchestratorPool`
(`adoptSavedSession`, as a reopened session is) and subscribes one client: a
socket object that counts what it is sent, so no port is opened. `--host core`
opens it through `hostSession` instead, and has no wire rows. `--level off`
keeps the supervisor from waking on its own.

What each figure says (times in ms, sizes in KB or MB):

| Figure | Means |
| --- | --- |
| `heap.heldMb` | Heap held once the session is open, past the process's heap before it: what the open session costs. |
| `heap.growthMb` | Heap the run added and kept, past garbage collection: what the session grows by while it streams, saves and is edited. |
| `rss.afterLoadMb`, `rss.endMb`, `rss.peakMb` | The process's resident memory then, and its peak. |
| `load.parseMs`, `load.parsedHeapMb` | `loadSession` alone: reading and settling the files, and the heap the plan it returns takes. |
| `load.openMs` | Opening the session as the host does (`adoptSavedSession`, or `loadPlan`), the load included. |
| `status.*` | Each status update while the run streams: how many and how often, the time to build and send one (`msP50`, `msP99`, `msMax`) and its bytes on the wire. |
| `join.statusMs`, `join.statusKb`, `join.planKb` | What a surface joining now is first sent: every task's status, whole, and the whole plan. |
| `saves.*` | Each save while the run streams: how many and how many a minute, its time, and the session file it wrote. |
| `mutations.*` | Each edit: its time and what it put on the wire; and of them, the whole-plan broadcasts (`plan_generated`) with the time to build and send one and its bytes. |
| `planner.*` | A planner turn from the message to its end, the fake's own pauses included. |
| `lag.p50`, `lag.p99`, `lag.max` | Event-loop delay while the run streams, past the 10 ms the histogram samples at. |
| `wire.*` | Every frame the one client was sent while the run streamed, by message type: frames and KB. |
| `disk.*` | The session file and research log as written, and as the run left the file; the attempt logs. |

Fewer than `--live` tasks finished, or a failed MCP call, is a problem: the
point's figures describe a shorter run, and `long.mjs` exits non-zero keeping
them. The isolation run names branches no repository holds, so opening the
session warns once per task record, as a real load whose branches were deleted
would; those are the `notice` frames.
