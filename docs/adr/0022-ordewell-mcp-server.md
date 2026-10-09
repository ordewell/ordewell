# 0022 — The Ordewell MCP server: task and planner tools behind per-caller tokens

**Status:** accepted, implemented

Task completion and checkpoints need signals bound to the current attempt,
independent of text meant for people. Coding-agent planners also need access
to the live catalog and validated plan operations. An injected MCP server
provides both without user registration. API planners retain JSON envelopes.

## Decision

**Ordewell runs one MCP server. Each caller gets a token, and the token decides
which tools the caller sees and what they act on.** Task runners complete and
ask checkpoints through it; coding-agent planners read the live catalog and
submit plans through it. Attachment is required before any coding-agent prompt:
check after spawn, respawn once with a fresh token, then fail if it still cannot
connect (ADR-0025). API planners keep JSON envelopes; completion and checkpoint
text markers have no role.

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
  MCP configuration, as an HTTP header the runner sends. Prompt and transcript
  text must not expose the credential.
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
  which hosts sessions for the CLI and TUI through `OrchestratorPool` →
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

- **Task runners and the three coding-agent planners (S1).** Claude Code,
  Codex and OpenCode use the required server. API planners (`OpenAiService`,
  `GeminiService`) keep envelopes and their existing query read loop.
- **Tools or nothing (S2).** Neither a task nor a coding-agent planner runs
  without its tools. One automatic respawn is allowed; a second attach failure
  fails the task or planner turn. There is no marker fallback.
- **Pre-authorized, in every mode (S3).** Calling an Ordewell tool never
  triggers a permission prompt: Claude Code `--allowedTools mcp__ordewell__*`,
  Codex's per-server approval configuration, OpenCode's permission rules.
  Otherwise the done signal, or the plan itself, would wait on a person. The
  grant names the `ordewell` server only and loosens nothing else: a harness
  planner stays in its read-only mode for every other tool.
- **Prompts teach the connected tools (S4).** The connector checks the runner's
  own MCP attach state before sending the prompt. A failed attach receives no
  task or planning prompt.

### Tasks: evidence, not opinion

- **`VerdictEngine` stays the only producer of verdicts (V1).** The handler
  for `task_complete` passes the call, with its generation, to
  `VerdictEngine`; it decides nothing itself. A tool call bound to the
  attempt's token is the runner's own explicit signal. No model is asked to
  judge; verdicts come from evidence.
- **Only the completion call settles the attempt (V2).** `VerdictEngine` checks
  the generation and invalidates it when the verdict is published. A stale call
  cannot complete another attempt. Evidence held behind an undelivered message
  is superseded when the runner reads that message (ADR-0023).
- **Only `done` passes (V3).** `blocked` and `failed` end the attempt without
  a pass and carry their `reason` on the verdict, so the user — and later the
  supervisor (#28) — sees why the runner stopped instead of a generic
  "no completion call".
- **The summary is delivered (V4).** `summary` becomes the durable output
  handed to dependent tasks, ahead of the plain output tail, and is
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

- **The tools read Ordewell state and planner skills (P1).** No arbitrary
  filesystem, shell or network access. `load_skill` reads a model-invocable
  planner skill from the resolved catalog (ADR-0024). `list_runners` and `list_models` read settings and the discovery
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
- **Retain text markers when tools cannot connect.** Previously adopted;
  rejected because a broken attach silently downgrades the session's contract.
  ADR-0025 requires attachment and removes both terminal and plugin runners.
- **Remove API planner envelopes with the markers.** Rejected: API planners
  do not use the injected server and still need their validated plan/read path.
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
- ADR-0003, ADR-0012 and ADR-0009 describe the implemented planner tools;
  text envelopes remain the API planner path.
- `CLAUDE.md` and `AGENTS.md` require `task_complete` bound to the attempt's
  token, with no marker fallback.
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
- 2026-10-09 — aligned with [ADR-0025](0025-structured-only-runners.md).
