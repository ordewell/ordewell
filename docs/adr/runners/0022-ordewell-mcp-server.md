---
status: accepted
---

# 0022 — The Ordewell MCP server: task and planner tools behind per-caller tokens

*Pending:* [ADR-0055](../supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) — a subplanner's token is a planner token that also serves `task_complete` and `checkpoint` (A1 to A3).
*Pending:* [ADR-0056](../supervision/0056-a-mandate-narrows-down-the-tree.md) — below the root the tool list is filtered by grants and fixed at session start; a subplanner's `checkpoint` parks instead of waiting (V5).
*Pending:* [ADR-0057](../supervision/0057-information-moves-by-reference.md) — the task tools gain `read` and `post`, `task_complete` gains `promote` and `open`, and references pin an attempt.
*Pending:* [ADR-0059](../isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md) — a container reaches this server through the lease's endpoint, not loopback (T1, T2).

## Problem

Task completion and checkpoints need signals bound to the current attempt,
independent of text meant for people. Coding-agent planners also need access
to the live catalog and validated plan operations. An injected MCP server
provides both without user registration. API planners retain JSON envelopes
and call the same task read handlers directly from their tool loop.

## Decision

**Ordewell runs one MCP server. Each caller gets a token, and the token decides
which tools the caller sees and what they act on.** Task runners complete and
ask checkpoints through it; coding-agent planners read the live catalog and
submit plans through it. Attachment is required before any coding-agent prompt:
check after spawn, respawn once with a fresh token, then hold a task whose
runner never connected, or fail it when the runner reports the server failed
(ADR-0025). API planners keep JSON envelopes and the same task read tools; completion and checkpoint
text markers have no role.

### Tools per token

| token | bound to | tools |
|---|---|---|
| **Task token** | one session, one task, one attempt generation | `task_complete({status: 'done' \| 'blocked' \| 'failed', summary, findings?, artifacts?, report?, reason?})`, `checkpoint({question})`, `read_task({task, attempt?, include_report?})`, and for a change task `apply_patch({task, attempt?})`, which merges a saved patch into its worktree ([ADR-0050](../planner-envelope/0050-a-read-only-task-can-hand-off-its-prototype-as-a-patch.md)); a read-only task's also `run_command({command})`, its only shell ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)), `save_patch({})`, which keeps what that shell changed as a patch ([ADR-0050](../planner-envelope/0050-a-read-only-task-can-hand-off-its-prototype-as-a-patch.md)), and `fetch({url})` and `web_search({query})`, its only web reads, decided by the web-read policy without asking anyone ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md), [ADR-0027](../planner-envelope/0027-web-reads-in-the-planner-envelope.md)) |
| **Planner token** | one session's planner conversation | `list_runners()`, `list_models({runner})`, `submit_plan({tasks})`, `edit_plan({ops})`, `task_query({...})`, `task_output({task, attempt?, kinds?, ...})`, `task_diff({task, repo?, path?, ...})`, `load_skill({name})` (a model-invocable planner skill's instructions; [ADR-0024](../planner/0024-unified-skills.md)) |

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
  makes a stale `onOutput` callback a no-op today. Revoking it aborts the
  calls it has in flight, and so does the caller's own cancellation: each
  request is served on its own, so the server finds the call a
  `notifications/cancelled` names among the token's calls in flight.
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
  `GeminiService`) keep envelopes and their existing query read loop, alongside direct task read tool calls.
- **Tools or nothing (S2).** Neither a task nor a coding-agent planner runs
  without its tools. One automatic respawn is allowed. A task runner that stays
  alive but never reports the server connected is held out of the scheduler
  with that reason, its dependents left on the plan rather than blocked, and a
  later start runs it again; a runner that reports the server `failed` — a
  configuration problem — still fails the task. A coding-agent planner turn
  fails on either outcome, since a turn has no task to hold. There is no
  marker fallback.
- **Pre-authorized, in every mode (S3).** Calling an Ordewell tool never
  triggers a permission prompt: Claude Code `--allowedTools` with each tool's
  full name, Codex's per-server approval configuration, OpenCode's permission
  rule per tool. Otherwise the done signal, or the plan itself, would wait on
  a person. The grant names the `ordewell` server only and loosens nothing
  else: a harness planner stays in its read-only mode for every other tool.
  A request is taken for an Ordewell tool's by its exact name (Claude Code,
  OpenCode) or server name (Codex), never by a prefix: a server named
  `ordewell_x` or `ordewell__x` names its tools under Ordewell's prefix.
  OpenCode joins server and tool with `_`, so a server named `ordewell_task`
  would have its `complete` named `ordewell_task_complete`; a project server
  whose name could do that is not offered to a planner
  ([ADR-0028](../planner-envelope/0028-planners-never-run-repository-config.md)).
- **Prompts teach the connected tools (S4).** The connector checks the runner's
  own MCP attach state before sending the prompt. A failed attach receives no
  task or planning prompt. Attached means the model is offered the tools, for
  as long as the runner lives: OpenCode 2.x, which rebuilds its services from
  the launch configuration and so drops the runtime setting that lists them
  outside code mode, is launched never to evict those services and has the
  setting made again before every turn.

### Tasks: evidence, not opinion

- **`VerdictEngine` stays the only producer of verdicts (V1).** The handler
  for `task_complete` passes the call, with its generation, to
  `VerdictEngine`; it decides nothing itself. A tool call bound to the
  attempt's token is the runner's own explicit signal. No model is asked to
  judge; verdicts come from evidence. A script task
  ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)) has
  no runner to make the call: its exit status is handed to `VerdictEngine` as
  the attempt's evidence, the one completion that is not a `task_complete`
  call.
- **Only the completion call settles the attempt (V2).** `VerdictEngine` checks
  the generation and invalidates it when the verdict is published. A stale call
  cannot complete another attempt. Evidence held behind an undelivered message
  is superseded when the runner reads that message (ADR-0023).
- **Only `done` passes (V3).** `blocked` and `failed` end the attempt without
  a pass and carry their `reason` on the verdict, so the user — and later the
  supervisor (#28) — sees why the runner stopped instead of a generic
  "no completion call".
- **The handoff is delivered (V4).** `task_complete` carries a summary of
  at most 1,500 characters, optional findings and artifacts, and an optional
  report of at most 20,000 ([ADR-0047](../supervision/0047-structured-task-handoffs.md)).
  The plan keeps a bounded digest; the attempt log keeps the full handoff.
  Dependents get the summary and whole findings within 4,000 characters per
  dependency. `read_task` pulls the rest for the task itself, its transitive
  dependencies and its loop's other end; it exposes no transcript or diff.
  The planner reads the digest with `task_query` and the full handoff with
  `task_output`, under its existing read budget.
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
  cache; `task_query` and `task_output` read the plan and captured output or
  saved attempt logs; `task_diff` reads task-owned git changes against the
  recorded starting commit. These are bounded answers, not a path into
  `.ordewell/` or an arbitrary git ref (ADR-0012).
- **The only writes are `submit_plan` and `edit_plan` (P2).** They go through
  the same check and commit path as the envelopes they replace. One module,
  `PlanChangeCheck`, holds every planner change to its rules, a whole plan or a
  batch of task ops, as it commits — a tool call as it answers, an envelope as
  its reply settles — and a whole plan's JSON as it is submitted too, against
  one live scope: the runners enabled now, for a plan and an edit alike
  (ADR-0003, V1: a task an edit leaves on a runner switched off since stands,
  and nothing new goes there), their modes and those of the runners the plan's
  tasks are on, the assignment resolver (ADR-0003: a stray model id
  in a submitted plan is replaced by the allowlist's, its effort carried to
  the nearest level, and the result reports the adjustment), `applyTaskOps`
  with `TaskEditValidator` (ADR-0012), the attached skills (ADR-0024) and, for
  the supervisor, its oscillation guard (ADR-0029). An envelope plan is parsed
  against the same intake. **A successful call commits before it answers:**
  its change is checked, adopted, saved and broadcast in one step while the
  planner's turn is still open, so `task_query`, the next call, every surface
  and the saved session read the changed plan, and the answer names the tasks
  it produced by id and reference — a plan's tasks, an edit's added tasks and
  the task each of its handles names. Each `edit_plan` call is a batch of its
  own, applied whole or not at all, its references resolved against the plan
  as it stands when it commits; a later call, `run_task` or `retry_task` of the
  same turn may name a task an earlier call added by the handle it gave, and
  no call may give that handle again. Calls commit one at a time, in the tick
  their check passes, so none commits against a plan another has changed
  since. A call still waiting on its check when its turn is stopped,
  superseded or abandoned, or its plan replaced, is refused and changes
  nothing. What committed stays: the reply that ends the turn lands beside it,
  never over it — a plan or edit envelope in that reply is not read — and a
  turn that later stops, fails or hits a usage limit keeps it, together with
  the input that asked for it, which the first commit takes as answered, so it
  is never sent again to be made twice. Committing grants nothing else: what
  it adds is approved only as ADR-0029 and ADR-0030 say, and the turn's start
  hold lasts until the turn ends. Refusals are structured, naming the task and
  field or the op, and no caller reads them back out of their wording. The
  same tasks produce the same plan by either route, and the plan stays the
  source of truth (ADR-0001). A structural edit during a live run applies at
  once to tasks not yet started and is refused, with a note, for a running or
  finished task, exactly as an envelope edit is (ADR-0029); a whole plan is
  refused while tasks run.
- **Execution tools are a further explicit entry (P5).** `run_plan`, `run_task`,
  `stop_task`, `stop_run`, `retry_task`, `message_task`, `answer_approval` (deny
  or escalate, never allow), `answer_checkpoint` (the supervisor at Act's, or the
  user's), `merge_all`, `skip_task` (lands nothing, never
  marks work complete) and `run_script` change what runs, not files
  ([ADR-0029](../supervision/0029-the-supervisor.md)). `run_script` adds a
  script task to the plan and starts it in one step, and answers with its
  verdict and the end of its output; it is offered to the API planner too, and
  the user's consent to it is ADR-0035's rule. They
  all reach the scheduler only through one core command seam, which checks the
  supervisor level, who started the turn and the plan's approval; `task_diff`
  joins the reads. Absent a grant at the seam, the call is refused.
- **Reads keep today's caps (P3).** `task_query`, `task_output` and `task_diff` share the
  per-user-turn read budget the envelope has (`MAX_TASK_QUERIES`,
  `MAX_TASK_QUERIES_HARD` in `PlannerConversation`) and the same escalation:
  a nudge to land the turn past the soft cap, a forced landing at the hard
  one. A read through the tool costs what the same read through the envelope
  costs. A wake-up turn, which no user message bounds, spends the wake-up read
  budget instead (ADR-0029).
- **Waking the planner during a run is not this server's (P4).** Wake-up turns,
  live planner turns and a per-turn read budget for wake-ups are decided in
  [ADR-0029](../supervision/0029-the-supervisor.md); this server serves them
  the same tools, except that in a wake-up turn `submit_plan` (a whole new plan)
  is refused and `edit_plan` is refused at Watch.

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
- **Hold a tool's change until the reply ends.** Previously adopted: an
  accepted `submit_plan` or `edit_plan` was kept by the open turn, joined into
  one batch per reply and committed as the reply settled. Rejected because
  every reader in between saw a plan that was not the one the planner had been
  told it changed: `task_query` and the next call read the old plan, a start
  after an edit had to be judged against a preview and deferred until the
  reply ended, surfaces drew a separate preview, and a reply that failed or was
  stopped after an accepted call dropped the change the call had confirmed.
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
- 2026-10-11 — execution tools and `task_diff`, live planner turns, wake-up turns ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-11 — live planner turns implemented: `edit_plan` checks a mid-run edit at the call, with no queued outcome.
- 2026-10-11 — wake-up turns implemented: their reads spend the plan's wake-up read budget, and `submit_plan` and `edit_plan` are refused in them at Watch.
- 2026-10-11 — saved attempt log reads and task diffs share the existing read cap; API planners use the same read handlers without MCP.
- 2026-10-13 — S3 by exact name: OpenCode's `ordewell_*` rule and the Claude Code and OpenCode prefix matches pre-approved a repository server named `ordewell_x`'s tools; checked against OpenCode 2.0.27's tool naming.
- 2026-10-14 — `skip_task` joins the execution tools ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-17 — the live enabled runners (L1) are read from one settings file shared with VS Code, and the planner is told on its next turn what changed ([ADR-0043](../routing/0043-a-change-of-scope-reaches-the-planner-and-flags-tasks.md)).
- 2026-10-18 — `submit_plan` and `edit_plan` report what the assignment resolver adjusted, an edit's own ops included (P2, [ADR-0003](../routing/0003-per-runner-model-allowlist.md)).
- 2026-10-21 — `run_script` joins the execution tools, and a script task's exit status is its completion evidence, handed to `VerdictEngine` ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)).
- 2026-10-21 — S2: a task runner the server never reaches while its process runs is held with a reason instead of failing and blocking its dependents; a `failed` report still fails it, and a planner turn still fails either way.
- 2026-10-21 — a read-only task's token serves `run_command`, and says so in the runner's configuration (ADR-0046).
- 2026-10-22 — decided, not built: `task_complete` carries a handoff and the task token gains `read_task` ([ADR-0047](../supervision/0047-structured-task-handoffs.md), #120).
- 2026-10-22 — implemented the handoff envelope and task-scoped `read_task` (V4; ADR-0047, #120).
- 2026-10-24 — P2: one check (`PlanChangeCheck`) for every planner change, at submit and at landing, with structured refusals; a whole plan is re-held to the plan's rules as it lands.
- 2026-10-24 — `answer_checkpoint` joins the execution tools, for the supervisor at Act ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-24 — S4 holds for the runner's whole life: OpenCode 2.1.4 evicted an idle planner's services after an hour and rebuilt them with Ordewell's tools inside code mode, out of the planner's reach.
- 2026-10-24 — a read-only task's token serves `save_patch` (ADR-0050).
- 2026-10-24 — a change task's token serves `apply_patch` (ADR-0050).
- 2026-10-25 — a read-only task's token serves `fetch` and `web_search` (ADR-0046); a caller's cancellation aborts the token's call it names.
- 2026-10-26 — P2: an edit's scope is the enabled runners alone, not the plan's own as well (ADR-0003, V1).
- 2026-10-26 — P2: a successful `submit_plan` or `edit_plan` commits, saves and broadcasts before it answers, each `edit_plan` call a batch of its own; the turn's held edit, its preview and the starts deferred behind it are gone.
