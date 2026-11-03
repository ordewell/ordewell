---
status: accepted
implemented: partial
note: "Settles the host half of #129 and #136; the design is docs/desktop/design.md. packages/desktop holds the shell: the daemon manager, the token-holding proxy, the hardened windows, the tray and quit rules. It is packaged for macOS, Windows and Linux (electron-builder.yml) and built in CI and attached to each release. The workspace view beyond its session list, signing, notarization and enabled updates wait on the later slices that design lists."
---

# 0060 — The desktop app is an Electron client of the shared daemon, and its renderer never holds the token

## Problem

Issue #129 asks for an orchestration-first desktop app: a window that shows the
plan, its tasks and their diffs, the planner beside them, and the user's own
repository, for people who do not live in VS Code or a terminal. Ordewell has
three *surfaces* today and they reach a `Session` two ways
([ADR-0006](0006-tui-pure-core-thin-driver.md)): the VS Code extension runs
core in-process and is itself a *host*; the CLI and the TUI drive the *local
daemon* (`packages/web`), which is the host. A desktop app has to pick one of
these, or a third, and the choice is hard to reverse: it fixes which process
holds the *session lease*
([ADR-0049](../isolation/0049-a-session-has-one-live-host.md)), which process
holds the daemon's bearer token, and whether a session started from the app is
visible to `ordewell status` and the CLI.

Three facts constrain it. The daemon's admission (`decideAdmission`) refuses
any request that carries an `Origin`, so a page in a browser engine cannot
reach it directly, by design. The token in `~/.ordewell/server-<port>.token`
is the whole of the daemon's authentication: whatever holds it can start runs
with the user's runners. And the CLI starts a daemon by spawning
`process.execPath` (`startDaemon` in `packages/cli/src/daemon.ts`), which in a
packaged Electron app is the app binary, not Node.

## Decision

**The desktop app (`packages/desktop`, Electron with electron-builder) is a
surface, not a host: its main process attaches to the shared local daemon on
`127.0.0.1:3742` after a version handshake, or starts and owns one, and its
renderer reaches that daemon only through a narrow IPC proxy in main and never
holds the token.**

- The daemon is the host. No core `Session` runs in the Electron process; every
  session the app shows is held by the daemon under its own lease (`kind:
  'daemon'`), so a run started in the app is the same run `ordewell status`
  reports.
- The app and the VS Code extension share one UI package, `packages/ui`, and one
  host-neutral view-assembly layer; only the transport under them differs.
- Light and dark follow the OS, chrome is native (inset traffic lights on
  macOS, a title-bar overlay on Windows), and one window shows one workspace.
- Installers are built unsigned in CI and attached to the GitHub Release.
  Auto-update is wired but disabled.

## Key properties

- **A client of the shared daemon (H1).** The desktop app holds no session and
  no lease. It talks to the daemon the CLI uses, on the port `resolvePort`
  picks (`--port`, then `ORDEWELL_PORT`, then 3742), with the `workspace`
  parameter every route already takes. The VS Code extension stays in-process
  and is unchanged by this decision.
- **Attach or own (H2).** At launch main probes `GET /api/server` on that port.
  A daemon that answers, with a token file main can read, is attached to. With
  none running, main starts one with `utilityProcess.fork` of the bundled web
  server entry and owns it: it is the app's child and stops when the app quits.
  The probe, token and PID-file helpers are factored out of
  `packages/cli/src/daemon.ts` so the CLI and the app read the same files the
  same way; the app never spawns `process.execPath`, and keeps Electron's
  `runAsNode` fuse off.
- **A version handshake before anything else (H3).** `GET /api/server` answers
  the daemon's package `version` and a `contract` number, raised whenever the
  daemon contract or the socket frames change incompatibly. Main compares the
  contract with the one it was built against before it relays a single request.
  The same contract attaches, whatever the patch version, and the status bar
  shows the daemon's version. A different contract, or a daemon too old to
  answer one, is not driven: the app names both versions and offers to restart
  the daemon with its own (see [Attaching and owning](#attaching-and-owning)).
- **The token stays in main (H4).** The renderer runs with context isolation,
  the sandbox on and Node integration off, loads only the app's own bundle under
  a content security policy that allows no remote origin, and may not navigate
  or open windows. Its one way out is the preload's `window.ordewell` bridge,
  whose daemon calls name a route from a fixed table, never a URL. Main adds the
  bearer, sends no `Origin`, opens each session socket itself with the token in
  `Sec-WebSocket-Protocol`, and relays frames over IPC. Admission is unchanged:
  it still refuses any request that carries an `Origin`.
- **Lifetime follows the run (H5).** Closing a workspace's window while a run in
  that workspace is active keeps the app running in the menu bar or tray, with
  the run's state and its *inbox* count in the tray menu. Quitting while a run is
  active asks first and says what happens to the run: with an owned daemon the
  run stops with it, and with an attached one it goes on in that daemon.
- **One window per workspace (H6).** Opening a workspace that is already open
  focuses its window. A window shows one session at a time, chosen from that
  workspace's sessions.
- **One UI, two transports (H7).** `packages/ui` holds the components, the view
  state, the styles as semantic design tokens, the webview protocol and
  `HostBridge`. The view assembly that `RunViewHost` and `ConversationViewHost`
  do inside the VS Code extension today moves behind a host-neutral layer fed
  either by in-process `SessionMessage`s (VS Code) or by the daemon's frames
  (`run_snapshot`, then stamped `SessionMessage`s folded by `reduceRun`). A
  component never knows which host it runs in. A confirm that VS Code draws
  with `vscode.window` is asked through the bridge, so each host draws its own
  modal.

## Attaching and owning

| Probe of `GET /api/server` | Contract | What main does |
|---|---|---|
| No answer (connection refused) | — | Starts the bundled daemon with `utilityProcess.fork` and owns it. |
| Answers, token file readable | Same | Attaches. |
| Answers, token file readable | Different, or none | Shows the mismatch. If the app owns that daemon it restarts it. If it does not, it offers *Restart daemon*: refused while any session in it has a live run, which it names, and otherwise stopping it as `ordewell stop --server` does and starting the bundled one, which the app then owns. |
| Answers, token file unreadable | — | Shows that a daemon on that port belongs to another user or install and does not attach. |
| Something else on the port | — | Shows that the port is taken and how to pick another (`ORDEWELL_PORT`). |

An attached daemon that goes away is not restarted silently. Main shows
*Reconnecting* and probes again. If the port is then free and the app did not
own the daemon, it offers to start one, which it then owns. This is the same
rule the TUI's *daemon revive* keeps for `ECONNREFUSED`: a request is replayed
only when the refusal proves it was never delivered. An owned daemon that
exits unasked is restarted once, and the sessions it held come back as
restored sessions, not as running ones.

## The IPC proxy

The bridge is narrow on purpose, because the renderer draws text that runners
and models wrote (handoffs, diffs, markdown), and a bug there must not reach
the token or the network. The bridge is a fixed set of named functions, listed
in [docs/desktop/design.md](../../desktop/design.md#ipc-bridge). Main checks
every call's arguments, and the daemon routes are named by id from a table that
main maps to a method and a path. Main refuses a route id it does not know and
never forwards one built by the renderer. Frames stream from main to the
renderer per subscription. The terminal, native dialogs, the folder picker and
handing a file to the user's editor live in main and are reached through the
same bridge.

## Testing decisions

- The attach-or-own choice is a pure function of the probe, the token read and
  the bundled contract (the table above). It is tested as a table, with no
  Electron and no network, as the TUI's daemon revive is.
- The proxy's route table is tested on its own: an unknown id, a parameter that
  would escape its path segment, and a body on a read route are refused before
  any request is made.
- The acceptance test is an offline end-to-end run of the real packaged app,
  launched through Playwright's Electron support, against the mock provider
  (`bench/live/mock-provider.mjs`) and fake runners, with no API key: it opens
  a workspace, plans, approves, runs, follows a task, answers an approval and
  runs Merge all. It runs twice, once owning the daemon and once attached to one
  started by the CLI.

## Out of scope

- Code signing, notarization, and turning auto-update on.
- Moving the TUI's private daemon onto the shared one.
- A mobile app, or a browser preview of the app's UI.
- Running core in the Electron process for any purpose.
- More than one workspace in one window.

## Considered options

- **Core in-process, as VS Code does.** Rejected: the app would be another host
  kind for ADR-0049, holding leases itself. Every daemon capability (the
  routes, the pool, the child-plan sockets) would need a second, in-process
  path. A session run from the app would also be invisible to `ordewell status`
  and the CLI, which talk to the daemon.
- **Tauri with a Node sidecar.** Rejected: the sidecar would be the daemon
  anyway, so this adds a Rust shell and a second runtime to own and package. It
  gains nothing over Electron for the parts the app needs from Node in its own
  process: the PTY, native dialogs, and Monaco and React shared with the VS
  Code webview.
- **A private daemon per app, as each TUI has.** Rejected: the app's sessions
  would be invisible to the CLI and to a second window, and two daemons in one
  checkout contend for the same session leases.
- **A detached daemon that outlives the app.** Rejected: runs would go on with
  no window and nothing on screen to stop them, and after an upgrade the old
  daemon would go on serving a newer app until something restarted it. An owned
  daemon stops with the app; a daemon someone else started is theirs.
- **The renderer holds the token and calls the daemon itself.** Rejected: the
  daemon would have to admit an `Origin`, widening admission for every client.
  Any script injected into the renderer through rendered model output would
  then hold a credential that can start runs.

## Consequences

- `GET /api/server` and `ServerInfoResponse` gain `version` and `contract`, and
  the contract number becomes something a change to the daemon contract or the
  frames must remember to raise.
- The probe, token and PID helpers move out of the CLI into a module both can
  import; the CLI's behaviour is unchanged.
- Quitting the app stops runs only in a daemon the app owns. A CLI command
  attached to that daemon loses it when the app quits. The quit confirm names
  the runs that would stop, and the CLI's own daemon revive starts a fresh one.
- `packages/ui` becomes a dependency of both the VS Code extension and the
  desktop app, so a UI change is checked in both. The extension's build order
  gains a step.

## History

- 2026-11-03 — accepted.
- 2026-11-03 — partly implemented: the Electron shell in packages/desktop.
- 2026-11-03 — partly implemented: packaging and CI (electron-builder.yml, the desktop job in release.yml, updates wired and held off by `AUTO_UPDATE_ENABLED`).
