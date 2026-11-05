---
status: accepted
amends: ["0009"]
---

# 0052 — A signed-out coding agent is flagged before it plans and signs in from the chat

## Problem

`RunnerInstallation` decides whether a coding agent can plan by running its
binary with `--version` ([ADR-0009](../planner/0009-coding-agents-as-planners.md),
T9). That answers "is it installed", not "is this user signed in", so an agent
whose login expired or was never done is usable, listed and picked, and the
first sign of trouble is its own failure after a goal was typed: Claude Code's
"Not logged in · Please run /login", Codex's "Not logged in". The message names
a command for another shell, arrives after the user has committed to a goal, and
on a surface that shows only a stderr tail reads as an opaque failure.

Three facts make this a decision rather than a bug fix. The login belongs to a
runner, not to Ordewell: each CLI has its own account, its own status command and
its own interactive way to sign in, and a user may be signed into one agent and
not another. The account is per workspace: a `.envrc` can select a different
Claude Code account ([ADR-0016](../platform/0016-per-workspace-environment.md)),
so a verdict is not a machine fact. And every login is interactive — a browser,
a device code, a pasted code — so it cannot run as a piped child of the daemon
or the extension host.

## Decision

**The preflight asks each runner's own status command with the workspace
environment; a signed-out agent stays listed and usable but is flagged, and a
planner turn is refused before it is sent with the way in kept in the message;
the user signs in from the chat by Ordewell handing the terminal to the login
command the runner declares, then asks again.**

### Asking the runner

`RunnerManifest.auth` is a `RunnerAuthSpec`: the `statusArgs` that asks, the
`loginArgs` that signs in, an optional `signedOut` line for a failed turn's
words, and an optional `read` that can parse a structured answer. The built-ins
declare:

| Runner | Status | Login | Signed-out answer |
|---|---|---|---|
| Claude Code | `claude auth status` | `claude auth login` | its JSON `authMethod: none`; an older CLI's prose stays unknown |
| Codex | `codex login status` | `codex login` | "Not logged in" and exit 1, unless `OPENAI_API_KEY` is set or the selected provider does not sign in through Codex itself |
| OpenCode | — | — | none declared, so always unknown |

`readRunnerAuth` runs the status args over the same augmented PATH and the
workspace's own variables a spawn would use (ADR-0016), started the way a spawn
starts the runner (`planDirectLaunch`,
[ADR-0010](../platform/0010-windows-support.md)) so an npm-installed agent's
`.cmd` shim answers on Windows, within a budget, and a hard timer kills a status
command that ignores SIGTERM. A non-zero exit is an
answer, not an exception. The probe reads no credential and reports only the
runner's short wording, never its output. The verdict is `signed-in`,
`signed-out` or `unknown`; a timeout, a failed spawn, an unparseable answer, a
throwing reader or a manifest with no spec is `unknown`.

Only `signed-out`, and only with a login command available, flags or blocks an
agent. `unknown` neither flags nor blocks: an older or offline CLI, an API-key or
custom-provider setup Codex can use without its stored login, or an answer no
reader can judge must not cost the user work that will succeed.

### Where the verdict lives

`RunnerInstallation.plannerUsability` returns the verdict as `auth` beside
`usable`, never inside it: a signed-out agent is installed and choosable, and the
verdict is a flag on its row, not a reason to remove the row. The verdict is
cached for 30 seconds and cleared by `refresh()`, the runner-list refresh that
also re-probes installs and the Codex sandbox
([ADR-0038](0038-runner-install-verdicts-expire.md)). It is recorded per runner
and workspace (`recordRunnerAuth`, `recordedRunnerAuth`) because the planner gate
is synchronous and one daemon may serve workspaces whose accounts differ
(ADR-0016).

### The flag, before the goal

| Surface | The flag | Signing in |
|---|---|---|
| TUI | a red welcome line per signed-out agent, the active planner first, and the red name of every signed-out runner its Runners row shows; the selected planner's value in the Setup block is red, and so is the confirmation notice of a pick, while its agent is signed out; the planner picker row reads `not logged in · /login claude-code` and stays selectable | `/login` for the active planner, `/login <runner>` by id or display label |
| VS Code | a red dot and a **Log in** segment on every signed-out pill, planner or runner; the empty state lists one row per signed-out agent, the active planner first, each with its own action | that pill's or row's button, for the active planner or for another installed agent |

The welcome's line names the command that fixes the agent in hand: `Claude Code
not logged in. /login to sign in.` for the planner, then one more for every
other signed-out agent in the runner list's order, `Codex not logged in. /login
codex to sign in.` VS Code renders the login as the second segment of the pill's
own capsule, beside the name, and as a button on the empty-state row, so one
agent's fix never reads as a second control. An agent whose verdict has no login
command gets no line and no button, since there is no way in to name.

Both surfaces flag every agent whose own status says signed out, not only the
one planning, because any of them can be signed in without moving the planner.
The TUI keeps the row in the picker — auth never gates usability — and flags
the agent in the welcome: a red line per signed-out agent, that agent's name in
red in the Runners row whenever the row lists it, and the Setup block's planner
value red while it is the planner in hand. VS
Code keeps the pill beside the others and marks it: the same action sits in the
Settings panel's Planner and Runners blocks and as a row in the empty state, and
none of those depends on the empty state being gone or on the pill being the
active planner.

### The refusal

`plannerNotReady` returns a `signed_out` reason carrying the provider, label,
runner and login command; `plannerNotReadyFor` reads the recorded verdict for the
session's workspace. Every planner turn passes `Session.assertPlannerReady`
before it opens — a conversation turn, a plan generation, a compaction retry —
and a host may call it first to refuse before it builds on the session. Nothing
is sent to the agent.

The message keeps the way in. The terminal UI and the chat say `Claude Code not
logged in. Sign in with /login, or run claude auth login and try again.` The
headless CLI, which has no `/login`, says `Claude Code not logged in. Run
claude auth login to sign in, then try again.`

### When the verdict is stale

A login can change while a host runs, and the gate reads a recording rather than
spawning under a turn. Three paths close the gap. A provider key saved through
the daemon can be an agent's sign-in
([ADR-0060](../runners/0060-acp-runners-are-data-on-one-connector.md) R9), so
saving one forgets every recorded `signed-out` verdict and clears the
installations' cached ones (`forgetSignedOutRunnerAuth`). When the recorded verdict is
`signed-out`, both hosts ask again just before a turn (`recheckSignedOutPlanner`
in the daemon and in VS Code), so a login done with the agent's own command is
seen without a refresh. When a turn fails with words the manifest declares
signed-out, `CliAgentAiService.explainSignedOut` reads them through the same
`signedOut`/`read` (kind `turn`), records `signed-out` and leads with the login
sentence once, then gives the runner's own message. That catches a logout the
record still calls signed-in. Only a phrase the manifest declares can do this,
so an unrelated failure is never turned into a login wall.

### Signing in

A login is always one runner's. The TUI's `/login` resolves the active planner;
`/login <runner>` resolves an installed agent by id or display label. It runs
the manifest's login args in this terminal: the alt screen and raw mode are
suspended, the child inherits stdio, cwd, PATH and the workspace environment,
and the TUI resumes in a `finally` so a failed spawn cannot leave the terminal
behind. Ctrl-C belongs to the child while it runs. VS Code's Log in, on any pill
or empty-state row, opens an integrated terminal named `<Label> login` with the
workspace's cwd and environment, sends the argv once, and polls the runner's
status verdict every two seconds for up to five minutes; a login the probe does
not confirm, or whose terminal closes, ends as a visible failure. On Windows that
terminal is cmd.exe whatever the user's default: Windows PowerShell prefers an
npm-installed agent's `.ps1` shim to the `.cmd` beside it, and its default
Restricted execution policy refuses to run it, so the login died before the
agent started.

Neither path writes the planner choice: signing a named agent in leaves
`aiProvider` alone, so "Claude plans while Codex signs in" works. Success is
not taken from the child's exit status: a login that exits 0 is reported as
signed in only when the fresh verdict says so, because a login can print success
and persist nothing. OpenCode has no login Ordewell may run, and both surfaces
say so.

## Key properties

- **The runner is the only judge of its login.** No surface infers signed-out
  from an exit code, a string it did not parse or a timeout; only the manifest's
  declared answer does, for the status command and for a failed turn alike.
- **Only signed out blocks, and only with a way in.** A signed-out verdict
  without a login command is not a refusal; `unknown` never is one.
- **A signed-out agent is flagged, never hidden.** Usability stays about the
  binary and the connector; the login is a flag with the action that fixes it
  beside it, for every flagged agent and not only the planner.
- **A login names one runner and never moves the planner.** The command comes
  from that runner's manifest, and no path writes the planner choice.
- **The probe reads no credential.** It runs the runner's status command and
  keeps only its short verdict.

## Testing decisions

The status command is the seam: `RunnerAuthExec` is injected into
`RunnerInstallation` (with a clock and a workspace env), so a case answers with
recorded output shapes and never runs an agent binary. The record is
process-wide, so a case that exercises the planner gate resets it between tests.
The TUI injects `spawn` and drives a fake daemon, which is how suspend/resume
and the post-login re-probe are asserted. VS Code injects `createTerminal`,
`onDidCloseTerminal`, `sleep`, `now` and the usability probe into
`PlannerLoginDeps`, so a poll ends without real seconds and "signed in" is
asserted to come from the probe rather than the child's exit. The fixtures are
the CLIs' published answer shapes, never credentials; a real login stays a
manual check. [ADR-0038](0038-runner-install-verdicts-expire.md) is the prior
art for the TTL and the refresh trigger.

## Out of scope

- OpenCode's login and status: its manifest declares neither, so it stays
  `unknown`. Adding them is a manifest change with its own evidence.
- A Stop action for a running login: closing its terminal is the escape, and the
  poll ends on close. A later control that adds one must end the attempt itself.
- Task runners: a task's agent is not preflighted for its login; the task's own
  failure is its report.
- A machine-wide account manager, or signing several agents in from one action.
- Recording a login's output: the terminal belongs to the user, and the
  transcript keeps only the verdict.

## Considered options

- **Run the login as a streamed child and render it in the chat.** Rejected:
  every one of these logins prompts on a TTY — a browser OAuth, a device code, a
  pasted code — which a piped child cannot show, and the user would still have
  to type into something that is not the terminal.
- **Copy the command into the message and stop there.** Rejected: the command is
  already in the message, and the request was to sign in from the chat. Copying
  it still sends the user to another shell and says nothing about whether it
  worked.
- **Hide a signed-out agent, or make it unusable.** Rejected: it is installed
  and can plan once signed in, so the failure is fixable in place. Hiding it
  would remove the row where the user wants to act and make the planner vanish
  and reappear as they log in. ADR-0009 dropped greyed-out rows for agents that
  cannot plan at all; a signed-out one is a different case.
- **Treat `unknown` as signed-out.** Rejected: an older or offline CLI, an
  unparseable answer or a custom provider with its own key would be refused work
  it can do.
- **Flag and sign in only the agent that plans.** The design until 2026-10-27:
  the TUI printed one welcome line for the active planner, and VS Code's empty
  state carried that planner's action while a pill's login appeared only once
  the empty state was gone. Dropped: a signed-out agent that is not the planner
  still has no way in, and it is one click from planning; and a login that shows
  up only after the chat fills, or only on the selected pill, reads as a
  different control from the one the empty state offered. Each runner owns its
  login anyway, so every flagged agent carries its own.
- **Block every turn on a fresh probe.** Rejected: the gate is synchronous and
  cannot await a spawn, and one spawn per turn would change the planner's
  latency for a fact that rarely changes. A stale signed-in verdict is caught by
  the turn's own failure and reworded.
- **One global "log in" chooser.** Rejected: each runner owns its own command
  and its own account, so a login is always attributable. Naming the runner is
  also what lets a non-planner agent sign in.
- **Run the login as a script task, consented and recorded.** Rejected: a script
  task has no TTY, so none of these logins can run in it
  ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)). The
  user's `/login` or Log in is the consent, and the login is not a planner
  effect.
- **Probe with the daemon's environment rather than the workspace's.**
  Rejected: a `.envrc` can select the account (ADR-0016), so the probe could
  flag the wrong login and the login terminal would fix the wrong one.
- **Keep the verdict in the session config or the plan.** Rejected: a login is a
  host fact that changes while a session lives. It belongs beside the runner
  install verdict, not in the plan that the plan-is-source-of-truth rule
  protects.

## Consequences

- Each probe spawns the runner's own status command once per installed agent —
  two spawns with Claude Code and Codex both installed — measured at 50–80 ms
  here (`claude auth status`, Claude Code 2.1.310; `codex login status`,
  codex-cli 0.164.0), and the verdict is cached for 30 seconds. The first
  screen's runner list pays it once, and a refresh asks again.
- A logout in a live session is caught on the next turn: within the cache the
  turn's own failure is reworded and recorded; after it, the turn is refused
  before it is sent.
- Signing into another agent leaves the planner untouched, and the runner list
  shows both verdicts afterwards.
- The status command's wording is load-bearing. A runner that renames its "Not
  logged in" line needs its regex or reader changed with it; the same spec
  judges a failed turn, so one change covers both paths.
- The TUI ignores Ctrl-C while a login child runs so the child owns the signal.
  A login that traps SIGINT and never exits keeps the TUI's own quit inert until
  it does; SIGTERM and SIGHUP still quit.
- A running login has no Stop action; closing its terminal ends the attempt as a
  failure rather than a silent success.
- An agent whose CLI declares no status command stays unmarked forever; its own
  failure is the only signal, which is the same fallback as before.

## History

- 2026-10-27 — accepted and implemented.
- 2026-10-27 — every signed-out agent is flagged on a line of its own and signs
  in with its own login, not only the planner: the welcome lists one line per
  agent and paints its Runners names red, VS Code's login is an always-present
  segment of every signed-out pill and one row per agent in the empty state, and
  the refusal drops "is".
- 2026-10-27 — the TUI paints the selected planner's Setup value red while its
  agent is signed out, and confirms a signed-out pick at error level instead of
  as a plain notice.
- 2026-10-27 — Codex's status answer is only the user's when the setup signs in
  through Codex itself: `OPENAI_API_KEY` or a custom provider that does not
  delegate to that login leaves it unknown.
- 2026-11-03 — the status probe starts the runner through `planDirectLaunch`,
  and VS Code's login terminal is cmd.exe on Windows: an npm `.cmd` shim read
  unknown, and Windows PowerShell refused its `.ps1` sibling.
- 2026-11-05 — a provider key saved through the daemon forgets the recorded
  and cached `signed-out` verdicts, since it can sign an agent in.
