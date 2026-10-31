# Scale benchmark (`bench/scale/`)

Where one Ordewell daemon breaks, by measurement. Offline and free: no model, no
API key, and no dist, since `build.mjs` bundles core's source, internals
included, with esbuild. The results these were written for are in the handoff
of the task that wrote them; rerun them rather than trusting old numbers.

```bash
node bench/scale/build.mjs                          # after any change to core
node bench/scale/ops.mjs                            # one operation against plan size
node --expose-gc bench/scale/live.mjs --sessions 100 --rate 1.6 --events 180 --heap
node bench/scale/mcpload.mjs                        # the MCP server alone
node --expose-gc bench/scale/memory.mjs             # heap per task and Session, lease heartbeat
node bench/scale/logs.mjs                           # task log writes and reads
node bench/scale/procs.mjs                          # real fake-claude processes
node bench/scale/real.mjs .ordewell/sessions        # what real runs left, as aggregates
```

| File | What it measures |
| --- | --- |
| `ops.mjs` | The tick, a mutation, a save, the view, a wake-up and a start's prompt at each plan size. `--only` picks sections; past 5,000 tasks each runs once. |
| `live.mjs` | N sessions live in one Session through the whole pipeline but for the processes. One JSON line out. |
| `swarm.mjs` | The fake processes: `Swarm.spawn` stands where `spawn` does in `StructuredRunnerDeps.process`, so the real Claude adapter and everything above it run. |
| `mcp.mjs`, `loadgen.mjs` | The real `OrdewellMcpServer` with connections held by other processes. |
| `mcpload.mjs` | Closed-loop MCP calls on a no-op tool. |
| `memory.mjs` | Heap per plan task, per idle Session, and a lease heartbeat. |
| `logs.mjs` | `openTaskLog`, appends and whole-file reads. |
| `procs.mjs` | Real child processes, for the spawn, the pipes and the attach. |
| `real.mjs` | Sizes and rates from a sessions folder, the calibration for the rest. |

## Reading the numbers

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
