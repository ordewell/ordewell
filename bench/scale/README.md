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

## Terminal UI

What the TUI costs a long session, with no terminal and no daemon: the messages a
daemon sends a client go through the TUI's own inbound stream, reducer and
`render`, and `createApp` coalesces the frames as it does for a user. For judging a
fix to its lag or memory growth by figures taken before and after it.

```bash
node bench/scale/build-tui.mjs                      # after any change to packages/cli or packages/core (core's source is bundled, no dist)
node bench/scale/tui.mjs --profile --out tui.json   # the default size, swept over settled tasks and conversation entries
node bench/scale/tui.mjs --no-sweep --minutes 2     # one configuration, a quicker look
node bench/scale/tui.mjs --session path/to/saved-session.json --profile
```

It starts itself again with `--expose-gc`, which the heap figures need. The default
run takes tens of minutes at full size, since a stream the TUI cannot keep up with
costs what it costs: `--minutes` and `--sweep-minutes` shorten it.

| Option | Default | |
| --- | --- | --- |
| `--tasks`, `--settled` | 300, 280 | Plan size, and how many of its tasks are settled (completed, with a usage ledger and a handoff digest). |
| `--entries` | 400 | Conversation entries in the saved transcript: user messages, replies, and research steps with their output. |
| `--minutes` | 10 | Virtual minutes of stream at the full size. |
| `--sweep-minutes` | 3 | Virtual minutes for the other configurations. |
| `--no-sweep` | off | One configuration only. Otherwise five run: D = 0, a third of `--settled`, and `--settled`, each with the default entries; `--settled` with no entries; and a plan a fifth of `--tasks`, settled in proportion. |
| `--cols`, `--rows` | 200, 50 | The wide terminal. |
| `--narrow-cols`, `--narrow-rows` | 60, 40 | A terminal too narrow for the panes side by side, so the plan stacks under the chat. |
| `--keys` | 20 | Keypresses timed per scrolling pane. |
| `--running`, `--log-tasks` | 2, 2 | Tasks running at once, and how many of them send a task-log batch each second. |
| `--turn-every`, `--turn-len`, `--delta` | 40, 20, 30 | A planner turn every so many seconds, lasting so many, with so many text or thinking pieces a second. |
| `--rotate`, `--mutate-every` | 60, 30 | Seconds a task runs before the next starts, and between plan mutations (a task update, and every fourth time the whole plan). |
| `--task-view` | off | Open the first running task's view before the stream, so its log is folded rather than dropped. |
| `--session` | none | A saved session file (`{ meta, plan }` or a plan), read and never printed: its tasks, transcript and research log replace the generated ones, and `--tasks`, `--settled` and `--entries` are ignored, with no sweep. |
| `--profile`, `--profile-out` | off | Self time by function for a frame, for one status update folded and for the reducer on a key that scrolls the plan, at the full size; the second writes the frame's `.cpuprofile`. |
| `--out` | none | Write the JSON there instead of printing it as the last line. |
| `--seed` | 1 | The generated text. |

The feed (`tui-feed.mjs`) is the shapes the client folds: the saved transcript
(`chatRestored`) and plan (`planRefreshed`) a load reads, then the socket's
`run_snapshot` and whole-plan `plan_generated` frames, then a stream of
`status_update` (every task, every second), `task_log` batches, a planner turn's
thinking, research steps and text deltas and its settled reply, `task_updated`,
`task_started`, and now and then the whole plan again. Frames are JSON strings and
are parsed before they are folded, as a socket's are.

What the figures are, per configuration (`D` settled tasks, `T` entries):

- **load**: the cost of each message that opens a session, as one dispatch.
  `planRefreshed` and the whole-plan frame carry every task.
- **heap after load**: `heapUsed` after a collection, with the harness's own copy
  of the feed's task text in it (a few MB). Quote the difference between runs.
- **frame wide / narrow**: `render(state)` for the loaded state, median and 95th of
  repeats. This is what each repaint costs, whatever caused it.
- **key scrolling the plan / the chat**: a page key through `createApp.dispatch`:
  the reducer, then the paint a key asks for at once. The reducer's own share is
  the line below it.
- **stream: frames a second**: paints caused by the stream, by virtual seconds.
- **stream: event-loop ms a second**: the folds, JSON parsing and paints the stream
  costs per second of stream. Past 1000 the TUI cannot keep up.
- **stream: behind the daemon at the end**: how late the last second of the stream
  was folded.
- **stream: heap slope**: the least-squares slope of `heapUsed` after a collection at
  each virtual minute, in MB a minute. The conversation grows by the turns the
  stream holds, so compare a slope with the same stream, not with zero.
- **Folding by message type**: per message, the inbound frame through the reducer.
  `(deltas flushed)` is the debounced burst of text deltas going out; its cost is
  not in `planner_text_delta`, which only holds it.
- **Growth**: the slope of each figure over D (with T at its default), over T (with D
  at its default) and over the plan's size N (settled in proportion), per hundred.
  The frames use their fastest repeat. Two or three points make these lines rough:
  they say which way and how steeply, and a figure whose repeats differ by more than
  its slope says nothing. D moves no row in the plan pane, so a slope over D is
  mostly the cost of what a settled task carries.

How it keeps time: `setTimeout`, `setInterval` and `Date.now` run on a clock that
moves only when the harness moves it, so ten minutes of stream need no ten
minutes of waiting, and the app's 33 ms frame budget, the 75 ms delta debounce and
the spinner interval behave as they do live. What a callback takes in `hrtime` is
added to that clock, so a TUI that cannot keep up falls behind (and coalesces
paints) as the real one does. A frame that arrives while it is behind is read
together with the others that have, after one round of timers.

What it leaves out: the terminal's output (`draw` only keeps the frame), the
WebSocket and its framing, the effects the reducer asks for (`perform` does
nothing), and the runner side of a session. Its numbers are one machine's on one
day; rerun them rather than trusting old ones, and see "Reading the numbers"
below for what they may be quoted in.

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
