---
status: accepted
amends: ["0009"]
folds:
  - "0039 — The detected planner is derived again on a runner-list refresh"
---

# 0038 — A runner install verdict is not permanent, and a refresh derives the detected planner again

## Problem

`RunnerInstallation` decides which runners are on this machine by running
`<command> --version` ([ADR-0009](../planner/0009-coding-agents-as-planners.md)). The
verdict was cached per process and never revisited, and nothing could revisit
it: the daemon and the VS Code extension injected only `filterInstalled` and
`plannerUsability`, `RunnerInstallation.clear()` was never called, and the one
refresh surface — the runner list — asked only the Codex sandbox again.

So a CLI installed while a host was running stayed invisible until a restart.
Both the pool and `InstalledPlanner` carried comments promising the opposite
("the cached answer is asked afresh", "an agent installed later joins on the
next probe"); the sandbox probe already honoured that policy
([ADR-0033](../planner-envelope/0033-codex-planner-without-its-sandbox.md)), and the install probe
did not.

The detected planner had the same flaw. ADR-0009's keyless first run picks the
first installed coding agent as the planner when the user has chosen no planner
and holds no vendor key. The probe ran once per host — daemon start
(`packages/web/server/main.ts`) or extension activation
(`ExtensionHost.start`) — and its answer lived in two module globals
(`recorded`, `installedAgents`).

The runner-list refresh already asked the host again for the Codex sandbox
([ADR-0033](../planner-envelope/0033-codex-planner-without-its-sandbox.md)) and,
once install verdicts expire (below), for the install verdicts — but not for the
agent detection. So a CLI installed while a host ran became *selectable* yet
never became the *default*: the planner pills still said "no key", and the
auto-enabled runner set stayed the startup one, until a restart or a window
reload. It bit the long-lived hosts — a VS Code window left open, or a shared
daemon — and not the TUI, which starts a fresh daemon each launch.

## Decision

### Install verdicts expire (ADR-0038)

**No install verdict is permanent. A "not installed" verdict expires after a
short window, and a runner-list refresh forgets every verdict at once so the
next probe re-runs it.**

- **The miss expires on its own.** A missing CLI is the verdict that changes
  while a host runs — the user installs it and expects the next look to see it.
- **The refresh re-asks about every runner.** A present binary can change too:
  an upgrade moves an ACP agent above or below its profile's `minVersion`, and
  an uninstall or a replaced shim changes whether Ordewell can start it at all.
  `RunnerInstallation.refresh()` therefore clears the positive and the negative
  verdicts, and a refresh costs one probe per installed runner. It is triggered
  by the same two places that already refresh the sandbox probe:
  `getInstalledRunners` (daemon) and `ModelDiscovery.push` (VS Code), so
  `ordewell runners` and a webview refresh see an upgrade without a restart.
- **The TTL is the backstop.** Between refreshes a positive is trusted, and
  only the miss expires, so opening a picker does not spawn every present CLI.

### The detected planner is derived again on a refresh (ADR-0039)

**A runner-list refresh derives the detected planner again, the same trigger
that already re-probes the Codex sandbox and the install verdicts.**

- **Both refresh paths do it.** The daemon's `getInstalledRunners` (GET
  `/api/runners`) and the extension's `ModelDiscovery.push` re-run
  `detectInstalledPlanner` before they read the enabled set.
- **It follows the fresh probe.** A refresh re-probes every runner, so a
  newly installed agent can join and a removed or now-too-old one can leave;
  re-deriving uses that answer, so the fallback never points at an agent the
  latest look refused.
- **Only the fallback moves.** A saved runner choice or a vendor key still wins,
  exactly as before; nothing else is derived here.
- **Still not per turn.** A planning turn reads the derived answer; it does not
  re-probe. The property ADR-0009 guards — one probe, not one per turn — holds.

## Key properties

- A runner installed while the daemon or the extension host runs is offered
  after a refresh, without a restart.
- The install probe and the Codex sandbox probe now answer to the same policy:
  asked again on a runner-list refresh.
- A refresh costs one probe per installed runner, so an upgrade, a removal and
  a new install are all seen; between refreshes a positive costs nothing.
- Installing an agent while a daemon or a VS Code window runs makes it the
  planner default after a refresh, with no restart.
- Removing or downgrading an agent below its ACP minimum takes it off the
  planner's usable list, and off the fallback, after a refresh.
- The refresh surfaces are the ones a user already has: the runner list
  (`ordewell runners`, the webview toggle panel) and a webview opening.
- The probe stays cheap on the paths with no refresh: a positive costs no
  spawn until a refresh asks again, and only a miss goes stale on its own.

## Considered options

- **Leave it; restart to see a new install.** Rejected: a user who installs a
  runner and clicks refresh expects to see it, and the code already said so.
- **Expire installed verdicts on a timer too.** Rejected: a refresh is the
  moment the user looks, and a TTL would spawn every present CLI on every
  picker opening for a fact that changes only when they act.
- **Trust a present binary until it fails.** Rejected: an ACP agent below its
  profile's minimum version only fails after a goal is typed, and an upgraded
  one would keep being refused; the refresh is cheap enough to ask.
- **Watch the filesystem for new binaries.** Rejected: over-engineered for this;
  the refresh the surfaces already have is the trigger.
- **Leave it; restart to pick up a new default.** Rejected: the refresh
  re-probes the sandbox and the installs but not the planner, so it re-asks the
  host everything except the one answer the keyless path depends on.
- **Re-probe on every planning turn.** Rejected, as before: spawns per turn,
  and it could move the planner under a live conversation. The refresh is the
  trigger.
- **Re-probe only while no agent was found.** Rejected: a needless special
  case. Re-deriving is safe because the set only grows and a saved choice or a
  key wins.

## History

- 2026-10-17 — accepted and implemented: a "not installed" verdict expires and a
  runner-list refresh forgets it.
- 2026-10-17 — accepted and implemented: a refresh derives the detected planner
  again (ADR-0039, folded into this ADR).
- 2026-11-05 — a refresh forgets the positive install verdicts too, so an
  upgraded or removed binary is re-checked and an ACP agent's minimum version
  is judged again; only the negative still expires on its own.
