---
status: accepted
amends: ["0008", "0009"]
---

# 0026 — One envelope for every planner

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
refused in every mode.** Mutation of files belongs to the runners. An effect
the plan needs is a script task when the planner can state its exact commands
([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)), and an
ops task when it needs judgment
([ADR-0020](../isolation/0020-ops-tasks-and-merge-gates.md)).

### Commands go through Ordewell, not the harness shell

- The Ordewell MCP server's planner tools gain **`run_command`**. It runs the
  command through the session's `IFileSystem.bash`: ADR-0008's classifier,
  path confinement and approval seam, and, once it lands,
  [ADR-0011](0011-sandboxing-the-planners-shell.md)'s sandbox. The harness
  never classifies a planner's command.
- Harness shells are withheld: Claude's `Bash` and `Monitor`, OpenCode's
  `bash` and `shell` (and its `task` subagents, which would run with whatever
  permission their agent has). Codex's shell stays, inside its read-only,
  network-less sandbox; its instructions point it at `run_command`, as a
  task's point it at its tools. Where that sandbox cannot start, Codex's shell
  is switched off and `run_command` is its only one
  ([ADR-0033](0033-codex-planner-without-its-sandbox.md)).
- A user may let a harness planner use its own shell instead
  ([ADR-0036](0036-the-planners-shell-sealed-runs-and-native-opt-in.md), N1–N6).
  The opt-in is off by default, user-level only, and offered only for the
  harness versions checked live: Claude Code's `Bash` and `Monitor`, and
  OpenCode 2.x's `bash` and `shell`. Each command then runs through Ordewell's
  launcher in the sealed profile, with the workspace read-only, a scratch
  folder writable, no home directory and no credential stores, and reaches the
  research timeline as a `bash` step. The harness keeps whatever network it
  gives its shell (N3); the planner's process starts without the user's
  credential variables (N2.2). Codex is unchanged, and OpenCode 1.x and Linux
  are not offered the opt-in.
- Every harness pre-authorizes the Ordewell server's tools (ADR-0022), so all
  three planners have `run_command`. It runs in Ordewell's process, so a
  network command works once it is approved.

### The harness's own requests reach the approval seam

Each adapter reads its runner's permission request into one shape — an MCP
tool, a fetch, a read outside the workspace, or anything else — and hands it
to one permission ledger (`permissionLedger.ts`), shared by planners and
tasks on every runner. The ledger holds it open, and cancels any request
still open when the turn ends. `CliAgentAiService` decides it against the
session's approval policy and web fetcher, and answers through the adapter;
the adapter only turns the answer into its runner's reply. An HTTP answer
keeps its request open until delivery succeeds. A failed reply is logged and
the request remains answerable, including one that was allowed automatically.

| request | decision |
| --- | --- |
| an Ordewell tool, by its exact name | allowed by the ledger at once and logged as decided (ADR-0022, S3) |
| another MCP tool | kind `mcp_tool`, scoped to the tool's full name |
| a fetch or a search | the web-read policy ([ADR-0027](0027-web-reads-in-the-planner-envelope.md)): exclusion, budget, approval, then the SSRF guard |
| a read outside the workspace | kind `external_path`, scoped as ADR-0008 scopes a path |
| a harness's own shell, when the opt-in is on | kind `native-shell`, allowed by the opt-in (ADR-0036 N1) |
| anything else | denied |

How each runner raises them, checked live (Claude Code 2.1.296, codex-cli
0.162.0, OpenCode 1.18.35 and 2.0.26):

- **Claude Code** runs in `default` mode with `--permission-prompt-tool
  stdio`. `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash`, `Monitor`,
  `PowerShell`, `KillShell` and the plan-mode transitions stay disallowed; a
  disallowed tool is gone for subagents too. With the native-shell opt-in,
  `Bash` and `Monitor` are asked and run through Ordewell's launcher instead
  (ADR-0036 N2, N6). An MCP tool, `WebFetch` and an out-of-workspace `Read`
  each arrive as `can_use_tool`, a subagent's on the same channel.
- **Codex** runs with `approvalPolicy: on-request`. A user's MCP tool arrives
  as an `mcpServer/elicitation/request` with `codex_approval_kind:
  mcp_tool_call`; the server is named, the tool is in the question or the
  latest call Codex started on that server and has not finished. Command, file-change and permission
  requests are still declined at once.
- **OpenCode** gets Ordewell's whole permission policy for the planner's
  server, replacing any it inherited: a catch-all `ask`, its own read tools
  allowed, every write, subagent and question tool denied, and its shell
  denied too unless the native-shell opt-in is on, when `bash` and `shell`
  ask and run through Ordewell's launcher (ADR-0036 N2). Then a user's MCP
  tool, `webfetch` and `external_directory` each arrive as
  `permission.asked`. A request counts as an MCP tool only when its name
  starts with a server OpenCode listed, so a built-in added later is never
  taken for one a person could approve. 2.x layers rules the same way, last
  match winning, and its session is created with the same rules; it renamed
  `bash` to `shell` and `task` to `subagent` and added `browser`, so the
  policy covers both spellings. 2.x can call MCP tools from code inside its
  `execute` tool, which raises no request of its own, so a planner's session
  denies `execute`; Ordewell's own server is replaced at start with
  `codemode: false`, so `run_command` and the completion tools are tools of
  their own, and a 2.x that cannot do that is refused as a planner.
- **An ACP runner** plans only when its profile claims the planner role on
  evidence ([ADR-0060](../runners/0060-acp-runners-are-data-on-one-connector.md)
  R3), as GitHub Copilot CLI 1.0.105 and Qwen Code 0.26.6 do. Its start is
  restricted by the profile's spawn controls, which take the agent's own
  write and shell tools away or make it ask before every use of them:
  arguments and variables for an agent with a deny list or such a mode, and
  for an agent whose controls are a hook or a settings file, owner-only files
  in the process's private directory, outside the worktree and holding no
  secret, with empty config homes there so the user's global rules, hooks,
  plugins and skills do not load. An agent that loads configuration from the
  directory it starts in starts in that private directory (ADR-0028).
  Whatever those controls let through, `AcpAdapter` refuses every edit,
  delete, move, command and mode switch by the kind the request or the turn's
  report names. Ordewell's own tools are allowed by exact name before any
  kind is read, and every other request, a read, a fetch or another MCP
  tool, reaches the ledger and is decided here.

### Standing approvals: the allowlist

An allowlist entry is a command rule (`gh issue list`, `gcloud * * list`), an
MCP tool rule (`mcp:find-*`), or a scope pattern (`/opt/data/*`,
`https://docs.example.com/*`); a leading `!` excludes, and an exclusion wins.
The grammar is in `plannerAllowlist.ts`.

- **A rule names the operation, never less.** A command rule must spell out at
  least the words its approval scope holds (ADR-0008, T1),
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
| `allowlist` | refused without asking, with a pointer to `run_script` for an exact effect and to an ops task for one that needs judgment |
| `allow` | runs, file writes still refused |

In Full, `run_command` never waits on a person and never acts outside its
standing approvals; whatever else the plan needs to change is a script task or
an ops task, which leave a record. A script task runs under ADR-0035's consent
rule, not this one, and an ops task runs at Full without asking. The allowlist
applies in every mode, so a Guarded planner asks only about what it does not
cover.

Settings: VS Code `ordewell.plannerApprovals`, `ordewell.plannerAllowlist`,
`ordewell.plannerAllowlistDefaults`; elsewhere `ORDEWELL_APPROVAL_MODE`,
`ORDEWELL_APPROVAL_ALLOW`, `ORDEWELL_APPROVAL_DEFAULTS`. Both are read on every
request, so a change of autonomy level applies to the next call. Neither can
come from the repository: the VS Code settings are user settings only, which a
workspace's `.vscode/settings.json` cannot override, and the variables are
refused from a workspace's environment files (ADR-0016). The effect allowlist
(ADR-0035) is a separate list with the same two rules, and it never widens what
`run_command` runs.

## Key properties

- **One rule for every planner.** What a planner may run through Ordewell no
  longer depends on which CLI is planning. The native-shell opt-in is the one
  user-level addition: it lets the harness's own shell read beside
  `run_command`, under the same sealed limit, and never widens what
  `run_command` runs.
- **External effects are approved or allowlisted; file writes are refused.**
  The allowlist and the approval card are the guard against an instruction
  injected into what the planner read, which is why rules are narrow and
  approvals session-scoped (ADR-0008, T1, T7).
- **Absent is denial (T5).** A request with no approval channel, a dismissed
  card or a five-minute timeout denies. A turn's abort denies its open
  requests.
- **Two guards against file writes.** The classifier refuses them, and
  ADR-0011's OS sandbox runs every planner command beneath it, `run_command`'s
  included, where the host has one. Without one (Windows, a Linux host where
  bubblewrap cannot start) the classifier is the only guard, and the planner
  surface says so once per session.
- **A read can still reach an address in a provider the user trusts.**
  `aws s3 ls s3://<bucket>/<prefix>` names a bucket that may belong to
  someone else, who can log the request; and a cloud read can return
  environment values held in a service's configuration. The allowlist keeps
  credentials from leaving for an address the command chose, not every read
  from carrying data. A project that cares excludes those families.
- **The user's saved allow rules still apply** to the Claude planner, for the
  tools it is allowed to have, except `WebFetch`, `WebSearch`, MCP tools and
  the path tools, which always ask, and a repository's rules do not load at
  all ([ADR-0028](0028-planners-never-run-repository-config.md)); the edit
  tools are disallowed outright, and a disallowed tool wins over an allow
  rule. The shell tools are disallowed outright too unless the native-shell
  opt-in is on, in which case `Bash` and `Monitor` ask and run under
  Ordewell's sealed profile (ADR-0036 N2, N6); a saved allow rule cannot skip
  that ask. An OpenCode planner's policy is Ordewell's alone.
- **A command's output is research.** `run_command` renders as the planner's
  `bash` step in every surface, and so does a command the opt-in lets through
  the harness's own shell (ADR-0036 N2.3).

## Considered options

- **Revert to plan mode.** Rejected: it ran only what Claude judged read-only
  and denied everything else silently, reopened the plan-file write, and left
  MCP tools denied.
- **Turn `Bash` back on and classify Claude's requests.** Rejected: Claude
  decides some commands itself, and saved `Bash(…)` rules run without a
  request, so Ordewell would see only part of what runs.
- **Make Full autonomy `allow`.** Rejected as the default: a session's
  approvals cost a handful of answers, while one injected `gh repo delete` or
  `npm publish` is unrecoverable. An effect belongs in a script task or an ops
  task, with a record and a verdict.
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
- 2026-10-10 — web reads join the envelope under one web-read policy; Full
  allows them without asking, every other command stays on the allowlist
  ([ADR-0027](0027-web-reads-in-the-planner-envelope.md)).
- 2026-10-11 — an allow rule, the user's or one a repository commits to
  `.claude/settings.json`, ran a Claude planner's `WebFetch`, `WebSearch` or
  MCP tool with no `can_use_tool`, past the envelope. The planner is now
  launched with `--settings` ask rules for `WebFetch`, `WebSearch` and
  `mcp__*`; checked live on Claude Code 2.1.296 in a trusted workspace, ask
  wins over a project allow rule and over `--allowedTools`, so Ordewell's
  own tools now arrive as requests the adapter allows at once.
  `--setting-sources user` was tried and not taken: it also drops local- and
  project-scope MCP servers, which the MCP-tool path serves, and the
  project's CLAUDE.md. Project settings still load, so a repository's
  hooks, settings `env`, helper commands and `.mcp.json` servers still apply
  to the planner — trusted or not, since `-p` skips the trust dialog.
- 2026-10-11 — planners stop loading the repository's config: Claude with
  user-only settings, no hooks, ask rules for its path tools and the
  project's instructions given as text; project MCP servers only once
  approved, remembered per definition; OpenCode without project config and
  Codex with the repository untrusted
  ([ADR-0028](0028-planners-never-run-repository-config.md)).
- 2026-10-11 — OpenCode 2.x's `execute` ran a planner's code unasked: it
  raises no permission. Planner sessions now deny it, an OpenCode 2.x that
  can list Ordewell's tools only inside code mode is refused as a planner,
  and a planner session created without the deny is not resumed
  ([ADR-0028](0028-planners-never-run-repository-config.md)).
- 2026-10-13 — a planner with no approval channel still has its reads of the
  workspace and of its session's saved output decided: allowed, where it
  used to be refused before the path was looked at
  ([ADR-0032](0032-runner-state-outside-the-workspace.md)).
- 2026-10-13 — Codex's own shell is off for a planner on a host where its sandbox cannot start ([ADR-0033](0033-codex-planner-without-its-sandbox.md)).
- 2026-10-13 — a server named `ordewell_x` had its tools allowed at once as Ordewell's, past the `mcp_tool` approval: Claude Code's and OpenCode's adapters matched a prefix, and OpenCode's rule was `ordewell_*`. Ordewell's tools are now told apart by exact name (ADR-0022, S3).
- 2026-10-13 — the three adapters' copies of the permission table disagreed: Codex allowed an Ordewell tool without logging it, only OpenCode cancelled a request left open at a turn's end, and Codex named an approval's tool from a call that had already finished. One permission ledger now holds the table for every runner.
- 2026-10-18 — the permission ledger waits for HTTP reply delivery and retains failed answers for retry.
- 2026-10-20 — every planner command, `run_command`'s included, runs in ADR-0011's OS sandbox where the host has one.
- 2026-10-21 — the planner performs an exact effect itself as a script task, so the `allowlist` mode's refusal points at `run_script` and an ops task, and the effect allowlist is a separate list ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)).
- 2026-10-21 — a user may opt in to Claude Code's or OpenCode 2.x's own shell, held in Ordewell's sealed profile, while both stay withheld by default (ADR-0036 N1–N6).
- 2026-11-04 — an ACP runner plans on its profile's evidence: its restricted start's controls, flags or owner-only files and config homes outside the worktree, then Ordewell's refusal by kind, with every other request decided here (ADR-0060 R3).
- 2026-11-04 — an ACP runner's spawn controls may make it ask before every write and command, Ordewell's refusal by kind deciding each; Qwen Code plans so (ADR-0060).
