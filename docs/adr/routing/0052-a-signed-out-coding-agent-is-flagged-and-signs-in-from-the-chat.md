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
environment; a signed-out agent stays listed and enabled but is flagged
to the user, is not offered to a planner as a runner until its check reads
signed in, cannot be newly picked as the planner, switched on or given a task
until it can run, and a planner turn is refused before it is sent with the way in kept in the message;
the user signs in from the chat by Ordewell handing the terminal to the login
command the runner declares, then asks again. Wherever Ordewell says an agent is
signed out, it names the way in, from one core function.**

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

Only `signed-out`, and only with a way in to name, flags or blocks an agent.
`unknown` neither flags nor blocks: an older or offline CLI, an API-key or
custom-provider setup Codex can use without its stored login, or an answer no
reader can judge must not cost the user work that will succeed.

The built-in runner is no signed-out agent. Each of its runners runs on one
provider and is installed exactly while that provider is configured
([ADR-0070](../runners/0070-the-built-in-ordewell-runner-runs-in-process.md)),
so a listed one is signed in and declares no sign-in route, and a provider with
no key has no row to flag. A key is set with `/key-set` like any other, never
through a Log in.

### Where the verdict lives

`RunnerInstallation.plannerUsability` returns the verdict as `auth` beside
`usable`, never inside it: a signed-out agent is installed and choosable, and the
verdict is a flag on its row, not a reason to remove the row. It is recorded per
runner and workspace (`recordRunnerAuth`, `recordedRunnerAuth`) because the
planner gate is synchronous and one daemon may serve workspaces whose accounts
differ (ADR-0016), and every reader (the runner list, the gate, the catalog)
reads that one record.

A recorded verdict keeps what it rests on (`recordedRunnerEvidence`): `status`,
the runner's own status command, or none, which answers `unknown`; `turn`, a
planner turn, a task, or an ACP session the agent refused or opened as it
started; `discovery`, model discovery's own ACP handshake or credential hook.
Each check is stamped as it begins (`runnerAuthClock`), and the record takes an
answer only when it is newer than the one held and than the user's last
recheck, login or saved key, so a probe or discovery that overlapped a refusal,
or a recovery, is dropped rather than written over it. A status probe's
`unknown` never replaces what a turn or discovery said: an agent with no status
command (Cursor, Copilot CLI, Cline, Gemini CLI, Qwen Code) can only ever answer
`unknown`, which is no evidence. A newer definitive answer replaces any verdict,
so a runner with a status command still answers for itself.

The status probe is cached for 30 seconds and forgotten by `refresh()`, the
runner-list refresh that also re-probes installs and the Codex sandbox
([ADR-0038](0038-runner-install-verdicts-expire.md)). That refresh is periodic:
every list, every surface after a turn, and the send recheck call it, so it asks
again and keeps what a turn or discovery recorded. Forgetting that evidence is
the user's explicit recovery's alone (*When the verdict is stale*).

### Not offered to the planner

An enabled agent whose recorded verdict for the session's workspace is
`signed-out` is not offered to a planner: `SessionCatalog.offeredRunners` leaves
it out of `list_runners`, `list_models`, the per-turn `<available_models>` block,
the runners a first turn plans for and what a plan or edit may assign
(`runnersFor('plan' | 'edit')`), so the supervisor moving work never picks it
either. The planner is told why, once per agent, as `Codex: signed out, not
offered until signed in`: `list_runners`' `notOffered`, `list_models`' refusal,
a refused plan's reply beside its `enabledRunners`, and a `<not_offered>` line in
the per-turn block. The user's `enabledRunners` setting is never rewritten: the
catalog reads the record at each call, so the agent is offered again by itself
once a runner-list probe, a turn or discovery's handshake records it signed in,
or the user's recheck forgets the refusal, and the assignment scope the user's
flags read keeps it, so a task already on it is not called switched off; it
fails at its start with the sign-in hint, as above. An `unknown` verdict
(OpenCode and Pi, which declare no status command and are not ACP agents; an
ACP agent with none until it is asked) leaves the agent offered. A goal with every enabled agent signed out is refused
with the reasons and `Sign in to one and send the goal again`.

### Picking a runner

Every picker of a planner, of the runners switched on and of a task's runner
reads one rule, `runnerChoice(runnerReadiness(...))` in core, from the
`readiness` each runner row of the daemon's list carries (`runnerEntryChoice`
for a row from an older daemon, read from its sign-in alone). It gives one short
status in words, the recovery a row offers as a kind a surface binds to its own
control, and whether a new pick is refused:

| Readiness | Status | Recovery | New pick |
|---|---|---|---|
| signed out | Signed out | Sign in (`sign-in`) | refused |
| no credential | API key needed | Add key (`add-key`) | refused |
| a finished catalog with no model and no agent default | No usable model | Refresh models (`refresh-models`) | refused |
| the ask got no answer | Couldn't load models | Retry (`retry`) | allowed |
| discovery still asking | Checking models… | — | allowed |
| no evidence of the sign-in | Sign-in not checked | — | allowed |
| the agent offers no model and runs on its own | Uses agent default | — | allowed |
| signed in, models listed | — | — | allowed |

Only evidence blocks: a confirmed sign-out, a credential hook with no key, or a
discovery that finished and established there is nothing to run the agent on.
A failed or pending ask, an unknown sign-in and an agent default are each told
apart and never refuse, so a runner with a usable model or default and no
confirmed blocker stays choosable. The colour a surface gives a status
(`tone`) only reinforces its words.

A list shows every choosable row first, then the blocked, then the unusable,
each group in its own order (`orderByChoice`). A blocked agent stays visible
with its status and its way back. Only a *new* choice is refused: the planner in
effect, a runner already switched on and a task's own runner stay as they are,
are never dropped or replaced for it, and stay choosable there; a runner
switched on can always be switched off. Settings written another way (an
environment variable, a migration, a settings file) are read as before; only a
pick that activates a known-blocked runner is refused.

A picker's list can be stale, so the daemon judges each new pick again at its
write: a planner switch (`settings.update` with a different `AI_PROVIDER`), a
runner switched on (`runners.setEnabled`), and a task moved onto another runner
(a task `PUT` or `card-edit`). It reads the same record and discovery answer
the list does, asking a recorded sign-out again first as the send gate does
(`verifyRunnerSignIn`), so a sign-in done since lets the pick through. A refusal
is a 409 `runner_not_ready` whose `runnerNotReady` carries the runner and its
readiness, and whose message is `runnerChoiceRefusal`'s: the way in and `Then
pick it again.`, or `Run /refresh to load its models again, then pick it.` An
unusable runner is no new refusal here: it is refused at its start, as before.

The TUI words each blocked row as the status and the usual command:
`Signed out · /login cursor-agent`, `API key needed · /key-set`,
`No usable model · /refresh`, `Couldn't load models · /refresh`, with no other
ornament; its label is red. Enter on a blocked row, ticking it on in `/runners`,
`/runners <id> on` and `/task-runner <task> <id>` say the refusal with its way in
and change nothing. A pick the daemon refuses reads the planner and the runner
rows again, so the stepper's early display of it is undone.

### The way in, worded once

A verdict carries its agent's ways in as data, `RunnerSignIn`, built by
`signInOf` from the manifest and, for an ACP agent, its connector's
`signInRoute`: the `login` argv Ordewell can run, the `key` vendor it can be
handed through the key entry (with the others that also work), and `byHand`, the
manifest's `signIn` clause for an agent whose login only it can run. One function,
`describeSignIn`, words them, and each surface passes its own `SignInSyntax`:

| Surface | A login | A key |
|---|---|---|
| TUI, VS Code chat, daemon | `Sign in with /login cursor-agent, or run cursor-agent login.` | `Run /key-set and choose OpenRouter (or any OpenAI-compatible provider) to hand it a key` |
| Headless CLI | `Run cursor-agent login to sign in.` | `Run ordewell key set openrouter <key> …` |
| Desktop welcome window | `Sign in with the Log in button, or run cursor-agent login.` | `Use the Set API key… button and choose OpenRouter … to hand it a key` |

The desktop app's welcome window has no composer, so its runner cards name
their own buttons rather than `/login` and `/key-set`; a syntax's `keyVerb`
("run" unless it says otherwise) lets it say "use" a button.

So `Cursor is not signed in. Sign in with /login cursor-agent, or run
cursor-agent login.`, `Qwen Code is not signed in. Run /key-set and choose OpenRouter
(or any OpenAI-compatible provider) to hand it a key, or run qwen and sign in
there.`, and `Gemini CLI is not signed in. Run /key-set and choose Google Gemini to
hand it a key, or run gemini and choose how it signs in.` The daemon words for
the terminal, since it cannot know who reads, and
`rewordSignIn` re-spells a shipped runner's hint for the headless CLI. VS Code's
chat takes the same `/login <runner>` and `/key-set` (`/key` is its old
spelling and still opens it), so it uses the terminal's
words. A runner row (`describeRunnerSignIn`) carries the hint when its agent is
signed out and only its login when the verdict is `unknown`, since a key or a
by-hand route is no news to someone who may be signed in already.

### The flag, before the goal

| Surface | The flag | Signing in |
|---|---|---|
| TUI | a red welcome line per signed-out agent, the active planner first, and the red name of every signed-out runner its Runners row shows; the selected planner's value in the Setup block is red, and so is the confirmation notice of a pick, while its agent is signed out; the planner, `/runners` and task-runner pickers list it below the choosable rows as `Signed out · /login <runner>`, choosable only where it is already the user's choice (*Picking a runner*) | `/login` for the active planner, `/login <runner>` by id or display label, `/key-set` for a key-based agent |
| VS Code | a red dot and a **Log in** segment on every signed-out pill, planner or runner, titled with the hint; the empty state lists one row per signed-out agent, the active planner first, each with the hint and its own action; a task that failed on a signed-out agent has **Log in** beside Retry | that pill's, row's or card's button: the agent's login, or the key entry for a key-based agent |
| Headless CLI | `ordewell runners` prints the hint under a signed-out row, and the login under an unknown one | the agent's own command, or `ordewell key set` |

The welcome's line is the hint, the planner's first, then one for every other
signed-out agent in the runner list's order, each naming its own `/login
<runner>`. VS Code renders the login as the second segment of the pill's own
capsule, beside the name, and as a button on the empty-state row, so one agent's
fix never reads as a second control. Its Log in runs the agent's login when
Ordewell can run one and opens the key entry (`/key-set <provider>`) for a key-based
agent; one whose only way in is by hand gets the hint and no button. An agent
with no way in at all gets no line and no button, since there is nothing to
name.

Both surfaces flag every agent whose own status says signed out, not only the
one planning, because any of them can be signed in without moving the planner.
The TUI keeps the row in the picker, below the choosable ones and refused as a
new pick, and flags the agent in the welcome: a red line per signed-out agent, that agent's name in
red in the Runners row whenever the row lists it, and the Setup block's planner
value red while it is the planner in hand. VS
Code keeps the pill beside the others and marks it: the same action sits in the
Settings panel's Planner and Runners blocks and as a row in the empty state, and
none of those depends on the empty state being gone or on the pill being the
active planner.

### The refusal

`plannerNotReady` returns a `signed_out` reason carrying the provider, label,
runner and its `RunnerSignIn`; `plannerNotReadyFor` reads the recorded verdict for the
session's workspace. Every planner turn passes `Session.assertPlannerReady`
before it opens — a conversation turn, a plan generation, a compaction retry —
and a host may call it first to refuse before it builds on the session. Nothing
is sent to the agent.

The message keeps the way in: the hint, then `Then try again.` The terminal UI
and the chat say `Claude Code is not signed in. Sign in with /login claude-code,
or run claude auth login. Then try again.` The headless CLI, which has no
`/login`, says `Claude Code is not signed in. Run claude auth login to sign in.
Then try again.`

The refusal also names its agent as data, so the Desktop and VS Code chat's
error offers that agent's own Sign in, never the planner picked since: a
`signed_out` reason carries its `RunnerSignIn`, and an agent that refused to
start (`RunnerSignedOutError`, below) reaches a daemon client as
`runner_signed_out` (409) with the same `signIn` (`DaemonRefusal.signIn`). The
button runs the agent's login as its Log in does, waits while any login of that
agent runs, and says how it ended; it opens the key entry for a key-based
agent, and an agent with neither keeps the words alone. Nothing is sent again:
the refused message waits in the composer.

A planner turn that failed mid-session because its agent signed out (words the
manifest declares, read by `explainSignedOut` below, or an ACP agent's
auth-required answer to `session/prompt`, which arrives as the hint) is not a
refusal: the turn was admitted and its failure is its reply, kept once in the
transcript as before and replayed to the planner as before. That reply carries
the agent's `RunnerSignIn` as data (`ConversationTurn.signIn`, then the
transcript entry's and the `planner_message`'s `signIn`), and every surface
draws its failure as the conversation's error, live and on reload, with the
same Sign in under it; the narration before it stays the planner's. No banner
repeats it, nothing is resent after a sign-in, and an ordinary reply that only
talks about signing in carries none, since nothing reads a reply's words for it.

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
record still calls signed-in. A task's turn or start that fails the same way is
read the same way by `Attempts`: the verdict is recorded under the workspace, the
failure notice ends with the hint, and a start it refused is held with the hint
and `Then start it again.` The flag and its Log in show at once, and VS Code
redraws the planner list when a task fails. Only a phrase the manifest declares
can do this, so an unrelated failure is never turned into a login wall.

An ACP agent that answers `initialize`, `session/new` or a resume with the
protocol's auth-required error refuses as a start, before any turn has words to
read: `AcpAdapter` throws `RunnerSignedOutError`, carrying the agent's
`RunnerSignIn` and the hint as its message, and the planner's start
(`CliAgentAiService`) and a task's (`Attempts`) record it by its type, so the
first refusal already blocks the next send. Discovery asks the same handshake
for the model list and records what it hears under the workspace whose
environment it asked (`ModelResolverDeps.workspace`): auth-required, or a
credential hook that found no key (`RunnerCredentialRefusal`, whose own words
are kept as the reason the list is empty), is signed out; a session the agent
opened, with models or none, is signed in; an ask that got no answer says
nothing. Why a runner lists nothing is told apart (`UnlistedReason`): `pending`,
`signed-out`, `no-credential`, `no-choice` (an agent that offers no model and
plans on its own default), `no-answer` (an ask, or a degraded fallback, that
said nothing), and `no-models` (a discovery that finished, cacheably, and listed
no model for a runner with no default of its own). Only `signed-out` and
`no-credential` are worded as discovery errors, and `runnerReadiness` classifies
a runner from the record and that reason, so a picker reads the blocker the
gate and the catalog read (*Picking a runner*).

Before a send to a planner recorded signed out, both hosts ask again
(`verifyRunnerSignIn`): a runner with a status command answers by it, and a
status-less ACP agent by its own handshake (one session/new, asked only while
the record says signed out, never on a list), so a sign-in done in another
terminal is seen without a recheck. An ask that gets no answer keeps the
blocker. The user's explicit recovery (`recheckRunnerSignIn`) forgets the
record for that runner and workspace first and then asks the same way: a login
that finished (the TUI's `/login` when its child exits 0, the desktop's login
terminal when its process exits 0, VS Code's when its terminal closes, since its
login runs inside a shell whose exit is not the login's), and the TUI's explicit
`/refresh`, which rechecks every agent it shows signed out. The daemon takes it
as `runners.list?recheck=<runner>[,<runner>]`. Where nothing can say, the agent
reads `unknown`, never signed in on a terminal's exit alone; the user can send
again, and a new refusal records the blocker again. Nothing is resent for them,
and a login that failed or was cancelled is not a recheck, so its blocker
stays.

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
not confirm, or whose terminal closes, ends as a visible failure; for an agent
with no status command, whose poll can never confirm, the closed terminal is
rechecked once as above and its answer is the outcome. On Windows that
terminal is cmd.exe whatever the user's default: Windows PowerShell prefers an
npm-installed agent's `.ps1` shim to the `.cmd` beside it, and its default
Restricted execution policy refuses to run it, so the login died before the
agent started.

Neither path writes the planner choice: signing a named agent in leaves
`aiProvider` alone, so "Claude plans while Codex signs in" works. Success is
not taken from the child's exit status: a login that exits 0 is reported as
signed in only when the fresh verdict says so, because a login can print success
and persist nothing. An agent with no login Ordewell may run, OpenCode or Qwen
Code, gets `<Label> has no login Ordewell can run.` and its other ways in, on
both surfaces.

## Key properties

- **The runner is the only judge of its login.** No surface infers signed-out
  from an exit code, a string it did not parse or a timeout; only the manifest's
  declared answer does, for the status command and for a failed turn alike.
- **Only evidence blocks.** A sign-out, a missing credential or a finished
  catalog with nothing to run on refuses a new pick; a sign-out refuses a turn
  only with a way in to name. `unknown`, a pending or failed ask and an agent
  default never refuse anything.
- **A choice already made is kept.** Only a new pick is refused; the planner
  in effect, a runner switched on and a task's runner are never dropped for it.
- **Signed out is never said without the way in.** Every surface words it with
  `describeSignIn` and its own syntax: Ordewell's way first, then the agent's.
- **A signed-out agent is flagged to the user, never hidden from them, and not
  offered to the planner.** Usability stays about the binary and the connector;
  the login is a flag with the action that fixes it beside it, for every flagged
  agent and not only the planner. A planner is told why it is missing, and
  offered it again once its check reads signed in.
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
- Preflighting a task's agent for its login: the task's own failure is its
  report, worded with the way in.
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
- **Keep offering a signed-out agent to the planner, flagged.** Chosen first,
  then dropped: the planner assigned tasks to it, and each failed once it
  started, with the sign-in hint, after the plan was approved.
- **Keep a signed-out agent choosable in the pickers, flagged.** The design
  until 2026-11-25: the TUI's planner row stayed selectable with the hint as its
  detail, and a pick landed an agent the next send refused. Dropped: the pick
  is the moment to say it cannot run, and a planner that is picked and then
  refused reads as settled when it is not. Refusing only a new pick keeps the
  user's earlier choices whole.
- **Switch a signed-out agent off in `enabledRunners`.** Rejected: the setting
  is the user's choice, and rewriting it would keep the agent off after the
  login that fixes it.
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
- **Name only the login command, and only where Ordewell can run one.** The
  design until 2026-11-05: the hint was `not logged in · /login`, and an agent
  with no declared login (Cursor's failed turn reached the user before its
  manifest declared one; Qwen Code and Gemini CLI never have one) was said to be
  signed out with nowhere to go. Dropped: the key entry and the agent's own route
  are ways in too, and each surface wording its own sentence let them drift.
- **Let every runner-list refresh and the TTL ask again from nothing.** The
  design until 2026-11-25: `refresh()` and the 30-second expiry dropped the
  record with the probe, and a status-less agent's probe can only answer
  `unknown`, so a refusal its turn recorded was gone by the list every surface
  loads after that turn. The picker, the gate and the catalog read harmless
  again, and the agent was spawned and refused on every send. Dropped: no
  evidence must not replace evidence; only a newer answer or the user's own
  recovery does.
- **Claim a status-less agent signed in when its login exits 0.** Rejected: a
  login can print success and persist nothing, and the runner is the only judge
  of its login. Its exit is the user's word that they are done, which earns a
  recheck, not a verdict.
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
- An agent whose CLI declares no status command reads `unknown` until it is
  asked in work: its refused turn or start, or discovery's handshake, marks it,
  and that mark holds through every refresh until a newer answer, a saved key,
  a finished login or the user's recheck. Its refusal now blocks the next send
  for real, so its recovery has to be one click or command on every surface.
- A send to a status-less ACP agent recorded signed out spawns one handshake
  first, bounded by discovery's timeout; one that times out keeps the send
  refused until the user rechecks.

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
- 2026-11-05 — every surface words a signed-out agent from one `RunnerSignIn`
  and names the way in (`/login <runner>`, `/key`, or the agent's own route); a
  failed task records the verdict and offers Log in, and `ordewell runners`
  prints the hint.
- 2026-11-05 — a provider key saved through the daemon forgets the recorded
  and cached `signed-out` verdicts, since it can sign an agent in.
- 2026-11-05 — Gemini CLI names Ordewell's Google key route in its signed-out
  hint, beside its own sign-in, now that a saved Google key signs it in.
- 2026-11-16 — the key entry is `/key-set` (`/key` still opens it); the built-in runner is no key-based signed-out agent: a provider runner is listed only with its key, signed in, with no sign-in route ([ADR-0070](../runners/0070-the-built-in-ordewell-runner-runs-in-process.md)).
- 2026-11-21 — the desktop welcome window words its runner cards with a syntax of
  its own that names the card's buttons; `SignInSyntax` gains `keyVerb`.
- 2026-11-24 — a signed-out agent is no longer offered to the planner: left out
  of what it may list and assign, with the reason, and offered again once signed
  in; the user's `enabledRunners` is untouched.
- 2026-11-25 — a recorded verdict keeps its evidence: a status-less probe's `unknown` no longer erases a turn's or discovery's refusal on refresh or expiry; an ACP start refusal and discovery's handshake are recorded by type; the send recheck asks the handshake, and a finished login or explicit recheck (`runners.list?recheck=`) is the only reset.
- 2026-11-25 — a refusal that names a signed-out agent offers that agent's Sign in on the Desktop and VS Code chat's error; a refused start reaches daemon clients as `runner_signed_out` with its `signIn`.
- 2026-11-25 — one choice rule for every picker (`runnerChoice`): ready choices first, blocked ones kept visible with one status and their recovery; a new planner pick, runner switched on or task assignment of a signed-out, keyless or modelless runner is refused, and judged again at the daemon's write (`runner_not_ready`); choices already made are kept.
- 2026-11-25 — a planner turn its agent ended signed out mid-session keeps its failure once as the conversation's error, carrying that agent's `signIn`, and the Desktop and VS Code chat offer its Sign in there.
