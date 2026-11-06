---
status: accepted
note: "Settles the host half of #129 and #136; the design is docs/desktop/design.md. packages/desktop holds the app: the daemon manager, the token-holding proxy, the hardened windows, the tray and quit rules, and every view the design lists. It is packaged for macOS, Windows and Linux (electron-builder.yml), built in CI and attached to a release when the repository variable ORDEWELL_RELEASE_DESKTOP is true (ADR-0065 C10), signed and notarized when the release has the credentials, with updates on only for a signed build (H9). Such a release also carries fixed-name copies of the installers and one SHA256SUMS, shared with the CLI binaries of ADR-0065, which one-line install scripts read (H10). A Homebrew formula and cask (ordewell-desktop) and winget manifests are rendered from that version and SHA256SUMS, and published when their credentials exist (H11)."
---

# 0063 — The desktop app is an Electron client of the shared daemon, and its renderer never holds the token

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
- A session another Ordewell daemon holds, such as a TUI's private one, is
  joined, not taken. Main connects to that daemon as well, after checking that
  it is the lease's own process and speaks the app's contract. It then routes
  that session's live calls and its socket there. The holder stays the
  session's one live host, and the app is one more of its clients.
- The app and the VS Code extension share one UI package, `packages/ui`, and one
  host-neutral view-assembly layer; only the transport under them differs.
- The app starts dark and the user picks Dark, Light or System (which follows the OS), chrome is native (inset traffic lights on
  macOS, a title-bar overlay on Windows), and one window shows one workspace.
- Installers are built in CI and attached to the GitHub Release, when the
  repository variable `ORDEWELL_RELEASE_DESKTOP` is `true`
  ([ADR-0065](0065-the-cli-also-ships-as-a-standalone-node-binary.md) C10); a
  release made with it off leaves the app out. A release signs them (and on macOS notarizes them) when the repository holds the
  credentials, and builds them unsigned when it does not. Whether the app
  updates itself is decided when it is packaged and baked into it: on only for
  a signed build (H9). A release that carries the app also carries fixed-name
  copies and a `SHA256SUMS`, which the one-line install scripts read (H10), and
  publishes to Homebrew and winget, from that same `SHA256SUMS` (H11).

## Key properties

- **A client of the shared daemon (H1).** The desktop app holds no session and
  no lease. It talks to the daemon the CLI uses, on the port `resolvePort`
  picks (`--port`, then `ORDEWELL_PORT`, then 3742), with the `workspace`
  parameter every route already takes. For a session another daemon holds, it
  also talks to that daemon (H8). The VS Code extension stays in-process and is
  unchanged by this decision.
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
- **A held session is joined in its holder's daemon (H8).** Opening a session
  whose lease names another Ordewell daemon (`host: { kind: 'daemon', port }`
  on a port that is not the app's own) joins that daemon, and never adopts the
  session. The holder keeps the lease, so ADR-0049's one live host per session
  holds as it does for the TUI that started it. The app drives the session as
  that daemon's client, beside the TUI, and both see the same frames.
  - **Main decides what to join.** Main reads the lease file itself, through
    core's `readLiveHolder`. The renderer names only a session id, and gets back
    who the holder is (port, pid, version, the time it took the lease) or a
    refusal and its reason. It never receives a port to call, a URL or a token.
  - **Joined only after a check.** Main reads the holder's per-port token file
    and probes `GET /api/server` with it. It joins only when the answering
    process has the lease's pid and the same contract as the app (H3). See
    [Joining a held session](#joining-a-held-session).
  - **Routed per session.** The route table marks which routes are a
    session's live ones: its read, the planner, the plan, approvals, task logs
    and child plans. For a session the window joined, main sends those, and its
    `/ws/session` socket, to the holder. Everything else stays on the app's own
    daemon: adopting a session (`sessions.load`), the session list, settings,
    runners and models, and files and git, since a read needs no lease
    (ADR-0064 R4). A user git action is confirmed there too. ADR-0062's
    landing interlock still applies, because it reads the holder's `runLive`
    from the lease.
  - **A connection per holder.** A connection to one holder serves every window
    and session it holds. It closes, with its sockets, when the last of them
    leaves: on switching session, on the holder exiting, or on the window
    closing.
  - **No daemon to join.** A VS Code window holds its session in its own
    process, with no daemon to join. The app shows the saved state read-only,
    redrawn as the holder saves it, or starts a new session in the workspace.
    Taking over follows ADR-0049.

- **Signed where credentials exist; updates only where signed (H9).**
  `scripts/package.mjs` reads the signing variables, picks one route per OS
  (below), refuses a half-configured one before anything is built, and bakes
  the outcome into main's bundle as `AUTO_UPDATE_ENABLED`. No environment
  variable or setting turns updates on at run time. Updates are on for a macOS
  build that is signed with a Developer ID and notarized, and for a Windows
  build that is signed; never on Linux. With no credentials the build is
  exactly the unsigned one (ad hoc on macOS, without the hardened runtime), with
  updates off. The feed stays GitHub Releases with prereleases ignored.
  The secrets reach the build only on the release path, so a pull request, a
  manual run or a fork never signs or notarizes.

- **A stable download link and a one-line install per OS, both verified
  against one `SHA256SUMS` (H10).** `release.yml`'s `release-assets` job
  runs once both the desktop and the CLI builds have attached their files, the
  only point where one place holds every installer (on a release that leaves the
  app out it runs on the CLI build alone and lists only the CLI's files,
  ADR-0065 C10), and with
  `scripts/desktop-release-assets.mjs` makes the fixed-name copies
  (`Ordewell-mac-arm64.dmg`, `Ordewell-mac-x64.dmg`, `Ordewell-win-x64.exe`,
  `Ordewell-linux-x64.AppImage`, `Ordewell-linux-x64.deb`, and the CLI's of
  [ADR-0065](0065-the-cli-also-ships-as-a-standalone-node-binary.md) C5), so
  `releases/latest/download/<name>` always resolves. The one `SHA256SUMS`, in
  `sha256sum -c` format, covers every installer (versioned and fixed name), the
  CLI archives and `install.sh`; the job uploads it last, so a release that has
  it has everything it lists, and only then marks the Release latest, as
  ADR-0065 C11 says: GitHub's latest is always a complete release. electron-updater
  (H9) takes the tag of `releases/latest` and reads that Release's
  `latest*.yml`, so an installed app is offered a version only once its
  release is complete; desktop-build.yml attaches `latest*.yml` with the
  installers, before the mark. The script refuses a release that lacks a fixed asset or mixes versions. `latest*.yml`
  and the blockmaps keep their own names and are not listed: electron-updater
  reads them by those names. `scripts/install/desktop.sh` (macOS and Linux) and
  `scripts/install/desktop.ps1` (Windows, PowerShell 5.1 and 7) download by
  the fixed name over https, check the file against `SHA256SUMS` from the same
  release, stop on any mismatch before anything is installed, and install for
  the current user without elevation (a `.deb` is the exception, and takes
  sudo). Running one again upgrades; `--uninstall` / `-Uninstall` removes only
  what it put there. The script's own contract is `ORDEWELL_VERSION` or
  `--version`/`-Version` to pin a release, `ORDEWELL_DESKTOP_FROM` to read a
  directory instead of the network and `ORDEWELL_INSTALL_DIR` to move the
  install. Neither script touches an OS protection: they add and remove no
  quarantine attribute, never call `Unblock-File` and change no SmartScreen
  setting. A file `curl` or `Invoke-WebRequest` saves carries no
  quarantine attribute or mark of the web, so the OS's first-launch prompt
  differs from a browser download's; the docs say so. The checksum comes from
  the release the files do, so it proves the download is intact and complete,
  not who made it: signing (H9) is what proves that.

- **A formula, a cask and winget manifests rendered from the release itself
  (H11).** Two jobs in `release.yml` run after `SHA256SUMS` is written:
  `homebrew` and `winget`. On a release that leaves the app out
  ([ADR-0065](0065-the-cli-also-ships-as-a-standalone-node-binary.md) C10),
  `homebrew` publishes the formula and no cask, and `winget` does not run. `scripts/render-package-manifests.mjs` fills the
  formula template, the cask template and the three `packaging/winget/`
  templates from the version and that `SHA256SUMS`, refusing a missing asset or
  a fixed-name copy whose hash disagrees with the versioned file it duplicates,
  so a package manager installs the release's own bytes and checks them against
  the release's own hash; each is rendered apart (`--only formula`, `cask`,
  `winget`). The `homebrew` job writes `ordewell/homebrew-tap` in one commit
  with `scripts/publish-tap.sh`, only when it holds a credential for the tap,
  and either one serves: the
  secret `HOMEBREW_TAP_TOKEN`, a token cloned and pushed over HTTPS, or else
  the secret `HOMEBREW_TAP_DEPLOY_KEY`, the private half of a write deploy key
  on the tap, pushed over SSH. The token wins when both are set, and the
  publish step receives only the one it uses. The deploy key is the narrower
  credential: it is bound to the tap repository alone, cannot call GitHub's API
  and belongs to no person's account, and it can be made from the command line
  where a fine-grained token cannot. Its private key is written to a 0600 file
  under `$RUNNER_TEMP`, never echoed or put on a command line, and deleted when
  the step exits, failed or not; ssh trusts only GitHub's published host keys,
  pinned in the script, and never a key scanned at run time. The token reaches
  git as an `http.<tap URL>.extraheader` in the environment of the clone and
  of the push alone, so it is on no command line and the clone's
  `.git/config` never holds it; a token in the clone URL, which v0.13.0's
  release run then reset out of the config, left that run's push with no
  credential. The script commits as `github-actions[bot]` and, for a version
  the tap already carries, commits and pushes nothing. To rotate the key,
  generate a new ed25519 pair, add the public half to the tap as a deploy key
  with write access, replace the secret with the private half, and delete the
  old deploy key from the tap. The formula `ordewell`
  (`Formula/ordewell.rb`) installs the CLI archive on macOS and Linux and is
  published whenever a tap credential exists
  ([ADR-0065](0065-the-cli-also-ships-as-a-standalone-node-binary.md) C8). The
  cask `ordewell-desktop` (`Casks/ordewell-desktop.rb`, the installer's
  `BIN_NAME`, so it does not clash with the formula) is published only when the macOS build's `signing.json` says it was notarized: Homebrew
  will not install a cask Gatekeeper stops, so an unnotarized release publishes
  no cask and says so in a notice. The `winget`
  job submits the rendered manifests to `microsoft/winget-pkgs` with
  Microsoft's `wingetcreate`, pinned to a version and checked against the
  SHA256 that version publishes, and only when `WINGET_TOKEN` exists. A missing
  credential is a notice, not a failure: a release is complete without either
  package manager. Once the formula is in the tap, `homebrew-verify` installs
  it as a user does, on one runner per archive it names (`macos-latest`,
  `macos-15-intel`, `ubuntu-latest`, `ubuntu-24.04-arm`), with
  `scripts/verify-brew-install.sh`: `brew install ordewell/tap/ordewell`, then
  `ordewell --version` must print the release's version and `brew test
  ordewell` must pass. It also runs `brew audit --formula` and prints what that
  reports as a warning, which fails nothing, since the audit judges how the
  formula is written and not what a user installs. It holds no credential. A
  release whose formula did not reach the tap is published again by hand with
  `homebrew-publish.yml` (`gh workflow run homebrew-publish.yml --ref main -f
  tag=vX.Y.Z`): it renders the formula alone from that Release's
  `SHA256SUMS`, writes it with the same script and secrets, one writer to the
  tap at a time with `homebrew`, and runs the same brew install. A cask needs
  the release run's notarized build, so that re-publish leaves the tap's cask
  as it is. Both
  jobs are read-only on this repository and pin every action they use to a
  commit SHA, because they hold the only tokens that reach outside it. The
  first submission of a package to winget-pkgs is reviewed by hand.

## Signing and updates

| OS | Route, chosen in this order | Variables | Updates |
|---|---|---|---|
| macOS | A Developer ID Application certificate, under the hardened runtime with `build/entitlements.mac.plist`; notarized by electron-builder, which staples the ticket | `CSC_LINK`, `CSC_KEY_PASSWORD`; then an App Store Connect API key (`APPLE_API_KEY`, the .p8's contents, written to a 0600 temp file for the build; `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or else an Apple ID (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) | On when signed and notarized |
| Windows | Azure Artifact Signing (`win.azureSignOptions`), else SSL.com eSigner (`win.signtoolOptions.sign`, `scripts/esigner-sign.mjs`), else a certificate file | Secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_CERTIFICATE_PROFILE`, `WIN_PUBLISHER_NAME`; else secrets `ES_USERNAME`, `ES_PASSWORD`, `ES_CREDENTIAL_ID`, `ES_TOTP_SECRET` and variable `WIN_PUBLISHER_NAME`; else `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | On when signed |
| Linux | None: the AppImage and the deb are unsigned | — | Off |

A signed install accepts only an update signed the same way. On macOS
Squirrel.Mac installs an update only if it satisfies the running app's
designated requirement, which names the Developer ID team. On Windows the
signed build writes its `publisherName` to `app-update.yml`
(`verifyUpdateCodeSignature: true`), and electron-updater installs only an
installer whose Authenticode signature names that publisher. `WIN_PUBLISHER_NAME`
may list several names separated by `|`, and `app-update.yml` then lists them
all: a bridge release signed by today's identity that names both it and the
next is how installs move from one signer to another. A later release
that went out unsigned is therefore refused by every signed install, not taken.

The AppImage could update itself, but nothing would check who built the update:
electron-updater verifies only the sha512 that `latest-linux.yml` lists, and
that file is fetched from the same release as the AppImage. Linux updates stay
off, and the deb never updates itself; the system's package manager owns it.

The entitlements grant only what V8 needs to JIT, in main, the renderer
helpers and the daemon's utility process; node-pty's `spawn-helper` needs
none. The same file serves the app and every nested binary. Notarization is off
in `electron-builder.yml` and turned on only by `scripts/package.mjs` when the
credentials are present, so a local build with a signing identity signs
without trying to notarize. `scripts/desktop-package-check.mjs` checks every
build's baked gate against `release/signing.json`, which the packaging writes,
and verifies a signed build's signatures.

Since 1 June 2023 a publicly trusted code-signing key must be generated and
kept in a hardware module, so a certificate a maintainer can download as a
`.pfx` is no longer issued; the certificate-file route stays for one bought
before then. Azure Artifact Signing does not validate every publisher, so
SSL.com eSigner is a second cloud route: an IV or OV certificate whose key
stays in SSL.com's cloud HSM, signed with SSL.com's CodeSignTool, which signs
unattended because it is given the account's TOTP secret.
`desktop-build.yml` downloads CodeSignTool only on a Windows release whose
`ES_USERNAME` is set, from a pinned GitHub release asset whose SHA-256 it
checks before unpacking, and names it in `CODE_SIGN_TOOL_PATH`.
electron-builder calls `scripts/esigner-sign.mjs` once for each file it signs
(the app, node-pty's helpers, the installer and its uninstaller), with SHA-256
only (the hook skips electron-builder's SHA-1 round). CodeSignTool takes its
credentials only as arguments, so the hook starts it with no shell, prints its
output with every credential cut out, removes its log folder, and fails the
build when the run reports an error even with exit 0. A route through the hook
gives electron-builder no certificate to read a publisher from, so this route
requires `WIN_PUBLISHER_NAME`: without it `app-update.yml` would carry no
`publisherName` and electron-updater would check no update's signature.

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

## Joining a held session

| What main finds | What happens |
|---|---|
| No live holder in the lease | Refused as `free`. A joined view says the holder has exited, and *Continue here* adopts the session into the app's own daemon (ADR-0049 L1). |
| `host.kind` is `vscode` | Refused as `vscode`: there is no daemon to join. |
| No `host` (an older Ordewell) | Refused as `no-host`: nothing says how to reach it. |
| The app's own port | Refused as `own`: the session is already the app's. |
| No token file for the port, or the token refused | Refused as `token`. |
| A daemon that cannot name itself (`unverifiable`) | Refused as `mismatch`: a daemon too old to answer a contract is not driven, as in H3. |
| An answer from another pid, or none | Refused as `unreachable`. A joined view keeps its state and asks again after a pause, because the holder may be restarting while its pid still holds the lease. |
| The lease's pid, another contract | Refused as `mismatch`, naming both versions. |
| The lease's pid, the same contract | Joined. |

Each refusal shows the saved state read-only, with its reason and the
holder's name.

**The token boundary.** The token main reads is the holder's own, from the
same `~/.ordewell/server-<port>.token` that `ordewell` reads to talk to that
daemon. It belongs to the same user, and stays in main as H4's does. Main
re-reads it at each call, so a daemon that restarts and mints a new one is
followed. Main presents a token only to the port it was written for, and it
joins only after the probe shows the lease's own process answering there. A
process that took over a freed port gets back only the token of a daemon that
is no longer there.

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

What the bridge keeps out of the page is the token and arbitrary URLs: a page
cannot reach another origin, or the daemon in a way the table does not name.
It does not make a page that runs script harmless. The bridge exists to act for
the user, so such a page can do what the user can: run a script task through
the plan routes, or type into a terminal. The boundary that keeps model text
from becoming script is therefore the rendering itself: markdown is rendered
with raw HTML off and only safe link schemes, and the content security policy
allows script only from the app's own bundle, with no inline script.

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
- Joining is tested in main as a table over the lease, the token read and the
  probe, with fakes for each. The table checks the refusals above, one
  connection per port shared and closed with its sockets when its last user
  leaves, and the route a session takes. An end-to-end test starts a second
  daemon that holds a session. The app opens the workspace and sends a planner
  message, and the test checks that the holder's session received it.

## Out of scope

- A cloud HSM other than SSL.com eSigner (DigiCert KeyLocker, Certum,
  Google Cloud KMS and the like); see H9.
- Signing the Linux packages.
- Moving the TUI's private daemon onto the shared one.
- A mobile app, or a browser preview of the app's UI.
- Running core in the Electron process for any purpose.
- More than one workspace in one window.
- Joining a session a VS Code window holds: it runs inside the extension
  host, which serves no daemon.

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
- **Show a held session read-only, and nothing more.** This was the first
  design, and it was dropped. A session a TUI is running was a dead end in the
  app: the person could watch the run but not answer the planner, approve or
  merge without quitting the TUI.
- **Take the session over into the app's daemon.** Rejected: ADR-0049 refuses
  a takeover while the holder lives. Forcing one would stop the TUI's run
  mid-task and its runners with it.
- **Have the holder hand the session to the shared daemon.** Rejected: a
  handover is a new lease transfer protocol between hosts. It would interrupt
  the run at the hand-off, and the TUI would lose the session it is showing.
- **Relay through the app's own daemon.** Rejected: that daemon would have to
  read and present other daemons' tokens, a credential the daemon never holds
  today. Main already holds tokens and opens sockets for the renderer (H4).
- **Join the port the renderer names, or the lease's port without checking
  the pid.** Rejected: the page draws model text and must not choose where a
  token goes. A freed port can be taken by any process. Main joins only the
  port the lease records, after the probe shows the lease's own process there.

- **Updates always on, signed or not.** Rejected: an unsigned build cannot
  tell its own update from anyone else's that reaches the feed, and on macOS
  Squirrel.Mac cannot update an ad hoc build anyway.
- **Updates decided at run time, by an environment variable or a setting.**
  Rejected: a user or a script could turn updates on in an unsigned install,
  the case this decision exists to rule out. The packaging knows whether it
  signed; the running app can only trust what it was built with. Updates
  were first held off by a constant in `updater.ts` until signing existed;
  the baked decision replaces it.
- **Updates for the AppImage.** Rejected: the only check is a hash from the
  same release, so it proves the download is intact, not who made it.
- **No cloud-HSM route, with Azure Artifact Signing and a certificate file
  alone.** First chosen, then dropped: since the HSM rule a new certificate
  cannot be a file, and Azure does not validate every publisher, so a
  publisher it does not validate could not sign at all.
- **SignPath Foundation.** Rejected: it signs with a certificate in
  SignPath's own name, after a manual approval of each release, so the release
  workflow could not sign unattended and the install prompt would not name the
  publisher.
- **Another cloud HSM (DigiCert KeyLocker, Certum).** Rejected for now:
  Certum's cloud signing needs its desktop app and a phone for each session,
  so it cannot sign in CI. One HSM route is enough to cover the case; each
  extra one is another tool downloaded into the release job.
- **Failing a release that has no credentials.** Rejected: releases ship
  unsigned today and must keep shipping until the credentials are configured. A release
  with some of a route's variables but not all is refused instead, since that
  is a mistake rather than a choice.

- **A SHA256SUMS per OS job, or the scripts joining one per OS.** Rejected: the
  three runners upload on their own, so each sums file would cover a third of
  the release, and a re-run of one runner would race the others over a shared
  name. One job that sees every asset writes one file; the desktop `attach` job
  wrote it until the CLI binaries joined the release, which it cannot see.
- **Fixed-name copies made by each OS's build.** Rejected for the same reason:
  a job can only name the installers it built, and the two macOS builds and the
  Linux pair would need the same upload order the single job gives for free.
- **Resolving the latest version through the GitHub API in the scripts.**
  Rejected: an unauthenticated API call is rate limited per address, where
  `releases/latest/download/` is a redirect with no such limit and carries
  the same "latest" notion GitHub already keeps.
- **Stripping the quarantine attribute, or unblocking the file, so the app opens
  without a prompt.** Rejected: that is the OS's protection, and a script that
  fetches and runs code is the last place to lower it. A signed and notarized
  build (H9) passes the check without help.
- **`brew`, `winget`, `scoop`, a Linux repository.** `brew` and `winget` are
  published from a release (H11), each behind a token in the repository's secrets.
  `scoop` and a Linux repository stay deferred: another account and another
  manifest to keep current, where the one-line scripts need only the Release.
  An unsigned release publishes no cask at all, because Homebrew would install
  an app Gatekeeper then stops.
- **Letting `brew` or `winget` tooling fill the manifests from the download
  URL.** Rejected: a tool fills only what it can read from the installer, so
  the publisher, licence and homepage would drift from the ones every other
  surface states, and the checksum would be whatever it read at submit time
  rather than the release's `SHA256SUMS`. The templates are the one place those
  values live, and `wingetcreate submit` takes the rendered files as they are.

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
- The route table has to say which routes follow a joined session. A new
  session-scoped route that is not marked `live` goes to the app's own daemon,
  which does not hold the session and refuses it.
- A joined window never adopts the session at the holder: a load there would
  replace the holder's live session. It reads the saved state with
  `GET /api/sessions/:id` instead, which also answers the planner's turn id.
- A signed release depends on certificates that expire and accounts that
  lapse. A release made after they do builds unsigned with updates off, and
  installs that were signed refuse it; users then update by downloading it.
- Main's bundle is built with the decision baked in, off unless the packaging
  says on, so a build made without `scripts/package.mjs` (`npm run build`,
  electron-builder run by hand) has updates off.
- A Homebrew install depends on the tap repository and a token or deploy key
  that can write to it; the cask also depends on a notarized macOS build. A release without
  either publishes no cask, and its users install from the Release as before.
- The first winget submission of the package is reviewed by hand by Microsoft,
  so `winget install Ordewell.Ordewell` works only once that pull request is
  merged; every later version is a pull request like any other.

## History

- 2026-11-03 — accepted.
- 2026-11-03 — partly implemented: the Electron shell in packages/desktop.
- 2026-11-03 — partly implemented: packaging and CI (electron-builder.yml, the desktop job in release.yml, updates wired and held off by `AUTO_UPDATE_ENABLED`).
- 2026-11-03 — the IPC proxy names what the bridge does not guard: a page that runs script acts as the user, so rendering is the boundary.
- 2026-11-03 — implemented: every view in docs/desktop/design.md, from the welcome window to Merge all through the preflight; signing, notarization and enabled updates remain out of scope.
- 2026-11-03 — the app starts dark rather than following the OS; System stays a choice.
- 2026-11-04 — H8: a session another Ordewell daemon holds is joined in that daemon, after a token, pid and contract check, rather than shown read-only.
- 2026-11-04 — H9: releases sign and notarize when the credentials exist, and updates are baked on only for a signed build.
- 2026-11-04 — H10: each release carries fixed-name installer copies and a SHA256SUMS, written by the attach job, and one-line install scripts for macOS, Linux and Windows read them.
- 2026-11-04 — H11: a notarized release publishes a Homebrew cask to ordewell/homebrew-tap, and every release submits winget manifests, both rendered from its version and SHA256SUMS and only when their token exists.
- 2026-11-04 — H9: SSL.com eSigner is a third Windows route, between Azure and the certificate file, for a publisher Azure does not validate; it requires `WIN_PUBLISHER_NAME`.
- 2026-11-04 — H9: `WIN_PUBLISHER_NAME` may list several publisher names separated by `|`, so a bridge release lets installs move to a new signer.
- 2026-11-04 — H9: the maintainers' credential setup and the publisher-eligibility reasoning moved out of the public docs; the routes and their gates are unchanged.

- 2026-11-05 — renumbered before publication to avoid a collision with main.
- 2026-11-06 — H10, H11: ADR-0065 puts the CLI archives and `install.sh` in the release; one `SHA256SUMS` over all of it and the fixed-name copies are written by `release.yml`'s `release-assets` job after both builds, and the cask is renamed `ordewell-desktop` beside a new `ordewell` formula.
- 2026-11-06 — H10, H11: a release carries the app only when `ORDEWELL_RELEASE_DESKTOP` is `true` (ADR-0065 C10); without it there are no installers, no cask and no winget submission.
- 2026-11-06 — H10: the Release becomes latest only once `SHA256SUMS` is attached (ADR-0065 C11), so the updater and the fixed-name links never see an incomplete release.
- 2026-11-06 — H11: the `homebrew` job publishes with the `HOMEBREW_TAP_DEPLOY_KEY` deploy key over SSH when `HOMEBREW_TAP_TOKEN` is not set.
- 2026-11-06 — H11: `scripts/publish-tap.sh` writes the tap for `homebrew` and the manual re-publish `homebrew-publish.yml`, the token by an extraheader, and `homebrew-verify` installs the formula with brew on four runners.
