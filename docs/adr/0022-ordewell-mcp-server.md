# 0022 — The Ordewell MCP server: task and planner tools behind per-caller tokens

**Status:** proposed

Two structured signals still travel through text meant for people.

A task completes when `VerdictEngine` finds `<<<ORDEWELL_DONE_<uuid>>>>` in
the runner's output, and asks a question with `<<<ORDEWELL_CHECKPOINT: …>>>`.
Around that sit workarounds that exist only because the signal is text: the
prompt asks the model to assemble the token from two halves so an echoed
prompt cannot complete the task, `defuseMarkers` rewrites a predecessor's
marker out of a dependent's prompt, a carry buffer catches markers split across
chunks, and the summary handed to dependents is scraped separately (#14, #16).
The structured transport (ADR-0018) delivers the marker as clean text, but it
is still a token found in prose (#46).

The planner has the same shape of problem. Plans, `taskOps` and `taskQuery`
are JSON envelopes parsed out of the reply (ADR-0009, ADR-0012), and the
runner/model catalog is pushed into the prompt. Enabled runners are snapshotted
when the session is built (`createSession.ts`, `config.enabledRunners`) and
`plan.runners` is fixed at `startPlanning`, so a runner enabled mid-planning
never reaches the planner and the plan cannot contain it (#69). The allowlist
is already read live (ADR-0003, C1); runner enablement is not.

Earlier ADRs deferred an MCP server for exactly these jobs — ADR-0009 for plan
submission, ADR-0012 (M2) for task reads — and ADR-0003 rejected a planner tool
for models, all for one reason: there was no MCP code in the repo, and a
registered tool would not reach a harness planner. Injecting the server into
the runner's configuration when Ordewell spawns it removes that objection. The
tools only mean something inside an Ordewell-spawned session, so Ordewell can
inject them itself, with no user setup (#37).

## Decision

**Ordewell runs one MCP server. Each caller gets a token, and the token decides
which tools the caller sees and what they act on.** Task runners on the
structured transport complete and ask checkpoints through it; the three harness
planners read the live catalog and submit plans through it. The text marker and
the JSON envelopes stay as fallbacks wherever the server is not injected or
did not attach.

### Tools per token

| token | bound to | tools |
|---|---|---|
| **Task token** | one session, one task, one attempt generation | `task_complete({status: 'done' \| 'blocked' \| 'failed', summary, reason?})`, `checkpoint({question})` |
| **Planner token** | one session's planner conversation | `list_runners()`, `list_models({runner})`, `submit_plan({tasks})`, `edit_plan({ops})`, `task_query({...})`, `task_output({task, ...})`, `load_skill({name})` (a model-invocable planner skill's instructions; [ADR-0024](0024-unified-skills.md)) |

#37's runner-facing tools (`board_post`, `report`, …) join the task side later,
on the same mechanism.

## Key properties

### Access

- **One server, access per token (A1).** `tools/list` returns only the
  caller's tools. A call with an unknown, revoked or wrong-role token is
  rejected — a task token cannot call `submit_plan`, a planner token cannot
  call `task_complete`. There is no separate task server and planner server;
  the token is the boundary.
- **A task token is one attempt (A2).** It carries the attempt generation
  `VerdictEngine` already tracks (`generations`, `bumpGeneration`). It is
  revoked when the attempt ends — verdict, retry, cancel, stop or process exit
  — so a late call from an earlier attempt is refused, the same rule that
  makes a stale `onOutput` callback a no-op today.
- **A planner token is one planner conversation (A3).** Issued when the
  harness planner is spawned, revoked when that process is disposed
  (`Session.reset()`, a new session, a respawn). A respawned planner gets a
  new token.
- **The token never enters a prompt (A4).** It travels only in the injected
  MCP configuration, as an HTTP header the runner sends. A prompt is quoted
  into dependents, echoed by TUIs and saved in transcripts; a token there would
  repeat every problem `defuseMarkers` exists to solve. The prompt keeps the
  completion marker's UUID, because transcript binding (`TranscriptReader`,
  #16) finds a task's transcript by it.
- **Not on a command line either (A5).** The configuration reaches the
  runner as a file with owner-only permissions or an environment variable the
  runner reads, never as a process argument, where `ps` shows it to every
  user on the host.
- **What the token does not defend against (A6).** A same-user process can
  read another process's environment and the session files under
  `.ordewell/`. A task in a write-capable mode can already do anything the user
  can, so the token is not a sandbox against a hostile local process. It
  separates roles and attempts, keeps stale and misdirected calls out, and
  keeps the planner's one write path (`submit_plan`, `edit_plan`) out of a task
  runner's tool list.

### Transport

- **Streamable HTTP on `127.0.0.1`, random port (T1).** Started on first use
  by the process that owns the session: the web daemon (`packages/web/server`,
  which hosts sessions for the CLI, TUI and web through `OrchestratorPool` →
  `createSession`) or the VS Code extension host (in-process `createSession`).
  One listener per process, shared by every session in it.
- **Loopback only, no browser access (T2).** The listener binds loopback, sets
  no CORS headers, and rejects a request whose `Host` is not the loopback
  address it bound or that carries an `Origin`, so a web page cannot reach it
  through DNS rebinding. The token is required on every request regardless.
- **The library is `@modelcontextprotocol/sdk` (T3)**, a dependency of
  `@ordewell/core`. npm installs it with the package, and the VS Code `.vsix`
  bundles it (`packages/vscode/tsup.config.ts` `noExternal`, checked by
  `packages/vscode/scripts/verify-bundle.mjs`), so users download nothing extra.

### Scope

- **Structured task runners and the three harness planners (S1).** Claude
  Code, Codex and OpenCode, as task runners on the structured transport
  (ADR-0018) and as harness planners (ADR-0009). The terminal transport
  (tmux, headless) gets nothing new: ADR-0018 made it fallback-only, and the
  marker serves it. API planners (`OpenAiService`, `GeminiService`) keep the
  envelopes; exposing the same handlers to them as in-process function tools
  is possible later and is not part of this decision.
- **The fallbacks are permanent (S2).** The text marker stays wherever the
  completion tool is not available: the terminal transport, plugin runners
  without a structured connector, and any session where injection failed or
  the server did not attach. The plan, `taskOps` and `taskQuery` envelopes stay
  for the same cases on the planner side. Neither goes away once every
  built-in runner supports the tools; #46 asked for this to be recorded.
- **Pre-authorized, in every mode (S3).** Calling an Ordewell tool never
  triggers a permission prompt: Claude Code `--allowedTools mcp__ordewell__*`,
  Codex's per-server approval configuration, OpenCode's permission rules.
  Otherwise the done signal, or the plan itself, would wait on a person. The
  grant names the `ordewell` server only and loosens nothing else: a harness
  planner stays in its read-only mode for every other tool.
- **Prompts teach the tools only where the server attached (S4).** A
  connector knows whether the runner connected — from the runner's own
  startup report, or from a `tools/list` on that token. Where it did, the
  prompt teaches the tools; where it did not, the prompt teaches the marker and
  the envelopes, as today.

### Tasks: evidence, not opinion

- **`VerdictEngine` stays the only producer of verdicts (V1).** The handler
  for `task_complete` passes the call, with its generation, to
  `VerdictEngine`; it decides nothing itself. A tool call bound to the
  attempt's token is the runner's own explicit signal, the same kind of
  evidence as the marker. No model is asked to judge, so the hard constraint
  ("verdicts come from evidence") holds; its wording grows a second channel.
- **The first signal settles the attempt (V2).** Marker or tool call,
  whichever arrives first produces the verdict and bumps the generation; the
  other is then stale. The verdict records which channel it came in on, and
  the task detail can say so.
- **Only `done` passes (V3).** `blocked` and `failed` end the attempt without
  a pass and carry their `reason` on the verdict, so the user — and later the
  supervisor (#28) — sees why the runner stopped instead of a generic
  "no marker".
- **The summary is delivered (V4).** `summary` becomes the durable output
  handed to dependent tasks, ahead of transcript and screen scraping, and is
  the seed of upward reports (#34).
- **`checkpoint` waits for the answer (V5).** The call stays open until the
  checkpoint is answered through the existing checkpoint path, and the answer
  is its result. The task is `awaiting_user` with reason `checkpoint` while it
  waits, with the idle timer paused as for any other wait (ADR-0018, W1). A
  waiting call sends MCP progress notifications, so a runner that aborts a
  silent call (Claude Code, 300s by default) does not end a checkpoint that
  waits for a person; no runner setting is raised. Cancel, stop and retry end
  the call with a refusal, as they deny a pending runner approval.

### Planner: the envelope's security boundary holds

ADR-0008 makes the planner's exploration envelope a security boundary, and
ADR-0009 keeps harness planners read-only with absent meaning denial. The
planner tools are recorded here as an explicit entry against both:

- **The tools read only Ordewell state (P1).** No filesystem, no shell, no
  network. `list_runners` and `list_models` read settings and the discovery
  cache; `task_query` and `task_output` read the plan and the output Ordewell
  itself captured — the same answer the `taskQuery` envelope gives (ADR-0012,
  including its `output` field), not a path into `.ordewell/`.
- **The only writes are `submit_plan` and `edit_plan` (P2).** They go through
  the same validation and commit path as the envelopes they replace: the live
  catalog, `coerceAssignments` (ADR-0003: a stray model id is coerced to
  `allowlist[0]` with its effort cleared, and the result reports the
  coercion), and `applyTaskOps` with `TaskEditValidator` (ADR-0012). The same
  tasks produce the same plan by either route, and the plan stays the source
  of truth (ADR-0001). A structural edit during a live run is queued as a
  pending plan edit, exactly as an envelope edit is.
- **Reads keep today's caps (P3).** `task_query` and `task_output` share the
  per-user-turn read budget the envelope has (`MAX_TASK_QUERIES`,
  `MAX_TASK_QUERIES_HARD` in `PlannerConversation`) and the same escalation:
  a nudge to land the turn past the soft cap, a forced landing at the hard
  one. A read through the tool costs what the same read through the envelope
  costs.
- **Waking the planner during a run is out of scope (P4).** So is any write it
  makes then. Both stay with #27 and #29.

### Planner: the catalog is read when the plan is submitted

- **Live enabled runners (L1).** `enabledRunners` joins the live
  `SessionRuntimeSettings`, read like the allowlist (ADR-0003, C1). This fixes
  #69 for both routes.
- **`submit_plan` validates against what is live at the call (L2).** A runner
  enabled a minute ago is valid; one switched off is rejected, by name. The
  runner set is derived from the submitted tasks and checked against live
  enablement, so `plan.runners` stops being the gate. Errors are structured
  and name what is wrong — the task, the field, the value, and what would be
  accepted — so the planner fixes the call instead of guessing.
- **Pull, not push (L3).** The prompt tells the planner to call `list_runners`
  and `list_models` just before `submit_plan`, so the catalog it plans against
  is the one the submission is checked against.

## Considered options

- **Two servers, one for tasks and one for the planner.** Two listeners, two
  lifecycles and two injection paths, for an isolation the token already
  gives. #37's tools would add a third or join one of the two anyway.
- **A stdio helper per runner (`ordewell mcp`).** Each runner spawns the
  helper, which forwards calls to the owning process. Rejected: the helper
  still needs a channel back to the owning process, so it adds a process to
  start and keep alive per runner and keeps the listener, for the same result.
- **A listener per session.** A port per session, and nothing gained: the
  token, not the port, decides what a caller reaches.
- **A listener in the daemon only.** VS Code creates sessions in its own
  extension host, not through the daemon, so its runners would have no server.
- **A fixed port.** The daemon and a VS Code window can run side by side, and
  a fixed port collides with them, with another user, or with an unrelated
  program.
- **A Unix domain socket or named pipe.** Not every runner's MCP client
  accepts one, and the two differ across platforms (ADR-0010). A loopback URL
  is what all three runners take.
- **A hand-written JSON-RPC server.** The protocol has version negotiation,
  session handling and a transport that still moves; the SDK is its reference
  implementation. The cost — a fourth dependency in a deliberately small core,
  with its transitive dependencies — is accepted, and the bundle check covers
  the `.vsix`.
- **The token in the prompt.** Quoted into dependents, echoed by TUIs, kept in
  transcripts, and readable by any model that sees another task's prompt.
- **The completion tool on the terminal transport too.** #46 first proposed
  it, since MCP does not depend on the transport. ADR-0018 made the terminal
  transport fallback-only, and the marker already serves it.
- **Drop the marker and the envelopes once the tools ship.** Strands plugin
  runners, the terminal transport, API planners, and every session where
  injection failed.
- **Let `task_complete` produce the verdict itself.** A second producer of
  verdicts beside `VerdictEngine`, with two places to get attempt generations
  right.
- **Reject an out-of-allowlist model id in `submit_plan` instead of coercing
  it.** #46 left this open, since a tool result makes a retry cheap. Rejected
  for now: ADR-0003 keeps the allowlist as advice, not a contract (P1, B1), and
  `submit_plan` matching the envelope's result is what keeps the two routes
  producing the same plan. The coercion is no longer silent: the result names
  it.
- **Interim fix for #69 in `catalog()` only.** Reading live enabled runners in
  the catalog block alone leaves `plan.runners` gating the plan, and is a
  second path to throw away (#69).
- **A planner-session token with broader rights.** Read access to settings or
  the workspace through the server would widen ADR-0008's envelope for no
  planner need the six tools leave open.

## Consequences

- `@ordewell/core` gains `@modelcontextprotocol/sdk`; `verify-bundle.mjs` must
  pass with it bundled.
- ADR-0003, ADR-0012 and ADR-0009 each carry a *Pending* line naming this ADR
  until it is implemented, then have the affected parts rewritten: ADR-0003's
  rejection of a planner tool for models, ADR-0012's M2 (adopted as the path
  for MCP-capable planners, the text envelope remaining the fallback), and
  ADR-0009's deferred "Ordewell as an MCP server" (adopted).
- `CLAUDE.md` and `AGENTS.md` state that a task completes when its marker
  appears in the output. Once this lands, the wording names both channels: the
  marker, or a `task_complete` call bound to the attempt's token.
- The structured connectors (`AgentAdapter` task mode, ADR-0018) and the
  harness planner adapters (ADR-0009) each inject the configuration and the
  pre-authorization at spawn, verified against the installed binary — the
  config flag or variable, how the approval policy treats MCP calls, and the
  tool-call timeout.
- `SessionRuntimeSettings` gains `enabledRunners`, and both hosts supply it
  live.

## History

- 2026-10-05 — proposed.
- 2026-10-05 — V5 amended: checked against Claude Code 2.1.289, its hard cap on a tool call is 1e8 ms, but an HTTP call silent for 300s is aborted. Progress notifications reset that, so the server heartbeats instead of the configuration raising a timeout.
- 2026-10-05 — Codex checked against 0.160.0: the server is injected per thread (`mcp_servers.ordewell` in the thread config, token read from the environment), pre-authorized with `default_tools_approval_mode = "approve"`; a 200s `checkpoint` call survives on the heartbeat with no timeout raised. Codex keeps MCP tools out of the model's tool list, so a task thread's instructions say where to find them.
- 2026-10-05 — OpenCode checked against 1.18.34: the server and an allow rule for `ordewell_*` go in `OPENCODE_CONFIG_CONTENT`, deep-merged over what is already there. A tool is named `ordewell_<tool>`. A `checkpoint` call held for 130s returned its answer, past the 5s `timeout` a remote entry defaults to and the MCP client's 60s request timeout, so no timeout is configured.
- 2026-10-09 — `load_skill` added to the planner tools (ADR-0024).
