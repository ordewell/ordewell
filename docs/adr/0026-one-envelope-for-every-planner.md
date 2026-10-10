# 0026 — One envelope for every planner

**Status:** accepted — amends [ADR-0008](0008-planner-exploration-envelope.md) and [ADR-0009](0009-coding-agents-as-planners.md)

## Problem

ADR-0008 gave the API planner a research envelope: read-only commands run,
anything else asks the user once per scope, and writes are refused. `gh`,
`az`, `kubectl` and `npm test` are named there as research the planner should
be able to do. ADR-0009 then dropped that envelope for harness planners, which
kept only the invariant and whatever read-only switch each CLI offered.

Those switches do not agree, and none of them asks the user anything:

- **Claude Code** ran under `dontAsk` with `Bash` withheld (2026-10-09), to
  close the native plan-file write path. A Claude planner could not run a
  single command, and every MCP tool the user configured — an issue tracker, a
  todo list — was denied without a prompt. Before that change it ran in plan
  mode, where only commands Claude judged read-only ran; the rest were denied
  silently.
- **Codex** ran in an OS read-only sandbox with approvals off: its shell has no
  network, and under `never` it fails a user's MCP tool call without asking.
- **OpenCode** ran its plan agent, which on 1.18.35 runs any shell command,
  MCP tool or fetch the user's own configuration allows — with
  `"bash": {"*": "allow"}` in that configuration, a shell that can write
  anywhere. Only the model's restraint kept it read-only.

A planner that cannot read the issues it is asked to plan from guesses, which
ADR-0008 already rejected. And full autonomy needs a planner that never waits
on a person, without one that acts outside a record.

## Decision

**Every planner, API or harness, researches inside the same envelope, decided
by Ordewell. Read-only commands run. Anything else runs if a standing
allowlist covers it, and otherwise follows the approval mode. File writes are
refused in every mode.** Mutation belongs to the runners; an effect the plan
needs is an ops task ([ADR-0020](0020-ops-tasks-and-merge-gates.md)).

### Commands go through Ordewell, not the harness shell

- The Ordewell MCP server's planner tools gain **`run_command`**. It runs the
  command through the session's `IFileSystem.bash`: ADR-0008's classifier,
  path confinement and approval seam, and, once it lands,
  [ADR-0011](0011-sandboxing-the-planners-shell.md)'s sandbox. The harness
  never classifies a planner's command.
- Harness shells are withheld: Claude's `Bash`, OpenCode's `bash` (and its
  `task` subagents, which would run with whatever permission their agent
  has). Codex's shell stays, inside its read-only, network-less sandbox; its
  instructions point it at `run_command`, as a task's point it at its tools.
- Every harness pre-authorizes the Ordewell server's tools (ADR-0022), so all
  three planners have `run_command`. It runs in Ordewell's process, so a
  network command works once it is approved.

### The harness's own requests reach the approval seam

Each adapter reads its runner's permission request into one shape — an MCP
tool, a fetch, a read outside the workspace, or anything else — and holds it
open. `CliAgentAiService` decides it against the session's approval policy and
web fetcher, and answers through the adapter.

| request | decision |
| --- | --- |
| an Ordewell tool | allowed by the adapter at once (ADR-0022, S3) |
| another MCP tool | kind `mcp_tool`, scoped to the tool's full name |
| a fetch | the web fetcher's check: SSRF guard, then per origin |
| a read outside the workspace | kind `external_path`, scoped as ADR-0008 scopes a path |
| anything else | denied |

How each runner raises them, checked live (Claude Code 2.1.296, codex-cli
0.162.0, OpenCode 1.18.35 and 2.0.26):

- **Claude Code** runs in `default` mode with `--permission-prompt-tool
  stdio`. `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash`, `PowerShell`,
  `KillShell` and the plan-mode transitions stay disallowed; a disallowed tool
  is gone for subagents too. An MCP tool, `WebFetch` and an out-of-workspace
  `Read` each arrive as `can_use_tool`, a subagent's on the same channel.
- **Codex** runs with `approvalPolicy: on-request`. A user's MCP tool arrives
  as an `mcpServer/elicitation/request` with `codex_approval_kind:
  mcp_tool_call`; the server is named, the tool is in the question or the call
  Codex last started on that server. Command, file-change and permission
  requests are still declined at once.
- **OpenCode** gets Ordewell's whole permission policy for the planner's
  server, replacing any it inherited: a catch-all `ask`, its own read tools
  allowed, every write, shell, subagent and question tool denied. Then a
  user's MCP tool, `webfetch` and `external_directory` each arrive as
  `permission.asked`. A request counts as an MCP tool only when its name
  starts with a server OpenCode listed, so a built-in added later is never
  taken for one a person could approve. 2.x layers rules the same way, last
  match winning, and its session is created with the same rules; it renamed
  `bash` to `shell` and `task` to `subagent` and added `browser`, so the
  policy denies both spellings. 2.x calls a user's MCP tools from code inside
  its `execute` tool, as Codex does, and each call still raises its own
  request; Ordewell's own server is replaced at start with `codemode: false`,
  so `run_command` and the completion tools are tools of their own.

### Standing approvals: the allowlist

An allowlist entry is a command rule (`gh issue list`, `gcloud * * list`), an
MCP tool rule (`mcp:find-*`), or a scope pattern (`/opt/data/*`,
`https://docs.example.com/*`); a leading `!` excludes, and an exclusion wins.
The grammar is in `plannerAllowlist.ts`.

- **A rule names the operation, never less.** A command rule must spell out at
  least the words its approval scope holds (ADR-0008, T1, amended 2026-08-11),
  so the entry `az group` never covers `az group delete`, and a one-word read
  of a multi-level CLI takes a `*` for its argument (`kubectl get *`).
- **A wildcard is never a write.** A `*` slot does not match a mutating verb
  (`delete`, `create`, `set-*`, …). Without that, `gcloud * * * list` covers
  `gcloud compute instances delete list`, which deletes the instance named
  `list`.
- **Only what the rule reads is covered.** Every part of the command line that
  would ask must be covered. A part is never covered when its words are not
  what would run: run by `xargs`, computed by the shell, globbed (a
  repository file named `--server=…` joins the arguments), prefixed by a
  `VAR=value` (`GH_HOST=…` sends the token elsewhere), or a program named by
  its path (`./bin/gh` is a file the repository ships, not `gh`).
- **An exclusion looks everywhere.** Its words are found anywhere among the
  arguments, flags included and case ignored: `!kubectl *secret*` holds for
  `kubectl get pods,SECRETS`, and `!* --output-file*` for every command. A
  lone short flag holds inside a bundle, so `!kubectl -s` holds for
  `-As host`.
- **An allowlisted command still asks for an outside directory it names**, and
  a refused command is refused whatever the allowlist says.
- **The allowlist is checked before a remembered "no"**, so an entry added
  mid-session is honoured; a denial by the mode is not remembered, since the
  mode can change.

The built-in allowlist (`DEFAULT_PLANNER_ALLOWLIST`) covers read-only families
of GitHub, GitLab and Jira; Azure, Google Cloud and AWS; DigitalOcean,
Hetzner, Linode, Oracle Cloud, Fly, Heroku, Vercel, Netlify, Firebase,
Cloudflare and Supabase; Kubernetes, OpenShift, Helm and the cluster tools
around them; Docker and Podman; installed npm, pip and Go packages; and local
process listings. MCP tools whose own name leads with a read verb (`get`,
`list`, `find`, `search`, `read`, `view`, `describe`, `show`) are covered too,
unless the name mentions a secret, a key, a URL or a fetch. Left out on
purpose, because on an untrusted repository someone else wrote them:

- anything that runs the repository's own code — test runners, builds,
  package scripts, and a package manager the repository pins or extends
  (Yarn's `yarnPath`, pnpm hooks, Poetry plugins, a `.venv` interpreter);
- anything the repository's own config can point at another endpoint with
  the user's credentials — npm's registry (`.npmrc` expands environment
  variables), `.sentryclirc`, a Terraform or Pulumi backend, a compose file's
  remote includes;
- any argument naming an address — a URL, `--server`, `--endpoint`,
  `-address`, a kubeconfig, which can run a credential plugin — and any read
  whose usual output is a secret.

### Approval modes, tied to autonomy

| mode | not on the allowlist |
| --- | --- |
| `auto` (default) | follows the autonomy level: Guarded is `ask`, Full is `allowlist` |
| `ask` | asks the user once per scope |
| `allowlist` | refused without asking, with a pointer to an ops task |
| `allow` | runs, file writes still refused |

In Full, a planner never waits on a person and never acts outside its
standing approvals; whatever else the plan needs to change is an ops task,
which runs at Full without asking and leaves a record. The allowlist applies
in every mode, so a Guarded planner asks only about what it does not cover.

Settings: VS Code `ordewell.plannerApprovals`, `ordewell.plannerAllowlist`,
`ordewell.plannerAllowlistDefaults`; elsewhere `ORDEWELL_APPROVAL_MODE`,
`ORDEWELL_APPROVAL_ALLOW`, `ORDEWELL_APPROVAL_DEFAULTS`. Both are read on every
request, so a change of autonomy level applies to the next call. Neither can
come from the repository: the VS Code settings are user settings only, which a
workspace's `.vscode/settings.json` cannot override, and the variables are
refused from a workspace's environment files (ADR-0016).

## Key properties

- **One rule for every planner.** What a planner may run no longer depends on
  which CLI is planning.
- **External effects are approved or allowlisted; file writes are refused.**
  The allowlist and the approval card are the guard against an instruction
  injected into what the planner read, which is why rules are narrow and
  approvals session-scoped (ADR-0008, T1, T7).
- **Absent is denial (T5).** A request with no approval channel, a dismissed
  card or a five-minute timeout denies. A turn's abort denies its open
  requests.
- **The classifier is the file-write guard until ADR-0011 lands.** No planner
  command runs in an OS sandbox yet.
- **A read can still reach an address in a provider the user trusts.**
  `aws s3 ls s3://<bucket>/<prefix>` names a bucket that may belong to
  someone else, who can log the request; and a cloud read can return
  environment values held in a service's configuration. The allowlist keeps
  credentials from leaving for an address the command chose, not every read
  from carrying data. A project that cares excludes those families.
- **The user's saved allow rules still apply** to the Claude planner, for the
  tools it is allowed to have; the shell and edit tools are disallowed
  outright, and a disallowed tool wins over an allow rule. An OpenCode
  planner's policy is Ordewell's alone.
- **A command's output is research.** `run_command` renders as the planner's
  `bash` step in every surface.

## Considered options

- **Revert to plan mode.** Rejected: it ran only what Claude judged read-only
  and denied everything else silently, reopened the plan-file write, and left
  MCP tools denied.
- **Turn `Bash` back on and classify Claude's requests.** Rejected: Claude
  decides some commands itself, and saved `Bash(…)` rules run without a
  request, so Ordewell would see only part of what runs.
- **Make Full autonomy `allow`.** Rejected as the default: a session's
  approvals cost a handful of answers, while one injected `gh repo delete` or
  `npm publish` is unrecoverable. An effect belongs in an ops task, with a
  record and a verdict.
- **Match the allowlist against approval scopes.** Rejected: a scope keeps two
  words past the binary, so `gcloud compute instances list` and
  `gcloud compute instances delete` share one, and no scope pattern can tell
  them apart.
- **Refuse MCP tools that do not declare `readOnlyHint`.** Rejected: the hint
  is not on any runner's permission request, and servers set it unevenly. The
  tool's own name, behind the user's exclusions, is what the allowlist reads.
- **Let the planner write files.** Rejected: every effect needs a record, a
  verdict and a place in the plan, which only a task has.

## History

- 2026-10-10 — accepted: `run_command`, Claude's requests to the seam,
  allowlist and approval modes tied to autonomy, Codex `on-request` and
  OpenCode's policy, all three checked live in Full.
- 2026-10-10 — review: globbed arguments and path-named programs are never
  covered, and `./cat` no longer runs unasked; exclusions ignore case and find
  bundled short flags; defaults a repository's config can redirect are gone;
  the settings are user-only. OpenCode 2.0.26 checked live: its MCP status
  moved to `/api/mcp`, which the attach check now reads, and code mode hid
  `task_complete` from tasks until Ordewell's server was listed outside it.
