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
