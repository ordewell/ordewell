---
status: accepted
---

# 0048 — A daily version check, with a notice first and one install per machine

## Problem

Ordewell has no way to know how many installs are in use or which versions
they run, and a user has no way to hear that a newer version is out short of
checking npm or the Marketplace themselves. Both need Ordewell to send
something off the machine, which it has never done on its own: every request it
makes is one the user, the planner or a task asked for. What is sent, when,
and how to stop it has to be decided once and kept, since users and packagers
read it as a promise.

## Decision

**Once a day, Ordewell sends `GET https://ordewell.ai/api/v1/ping?v=<version>&id=<installId>`
and nothing else, never before a one-time notice has been shown, and never
when any off switch is set.**

`startVersionCheck` in core owns the whole behaviour behind one call; a
surface passes its version and two callbacks, one for the notice and one for
the update line, and decides only where they appear.

- **What is sent.** The running version and a random install ID
  (`crypto.randomUUID()`), as the only two query parameters. No body, no
  cookies, no custom headers. Redirects are not followed, so the install ID
  goes to that one URL and nowhere a redirect points. The ID is replaced every
  30 days, so no row belongs to more than a month of a machine's history. An ID
  whose minting time is missing or in the future counts as due for replacement,
  since its age cannot be shown to be short.
- **The answer.** 204, or 200 with `{"latest":"x.y.z"}`, `latest` optional.
  When `latest` is a newer version by semver precedence, the surface shows one
  line: `Ordewell <latest> is out (you have <version>) — <how to update>`. How
  to update depends on the surface and on how this copy was installed
  ([ADR-0065](../surfaces/0065-the-cli-also-ships-as-a-standalone-node-binary.md)
  C9): "run `ordewell update`" for a headless command, "type /update" in the
  TUI, "update it from the Extensions view" in VS Code; a copy no command
  updates in place is told what would instead: "`npx ordewell@latest` runs it"
  for an npx run, "pull and rebuild this checkout" for a source checkout or a
  development build. A 204, or a 200 whose JSON object names nothing newer, is
  no news. Any other answer, a status that is neither, a body that is not a
  JSON object, a network failure or no answer within three seconds is no
  answer at all. The check never throws and never holds up a start.
- **The answer is remembered.** A newer `latest` is written to the state file
  as `latest`, with `latestAt`, the time it was learned. A start whose version
  is older than the remembered `latest` can show the line straight away, from
  the file, without a request, as often as its surface shows it (see
  [Where it runs](#where-it-runs)); a start already at that version or past it
  shows nothing. The next answer replaces it, no news clears it, and no answer
  leaves it as it was. The ping itself is unchanged: once a day, with only
  `v` and `id`.
- **One install per machine.** The state is `version-check.json` in
  `globalDataDir()` (`~/.ordewell/`), next to the global `settings.json`:
  `installId`, `installIdAt`, `noticeShownAt`, `lastCheckAt`, `latest`,
  `latestAt` and `updateShownAt`. The CLI and the VS Code extension read and
  write the same file. It is written atomically and owner only. A field of the
  wrong type counts as absent, as does a `latest` that is not a version, so a
  file an earlier release wrote loads as it is; an earlier release that
  rewrites the file drops the fields it does not know, which only costs the
  line until the next ping names the version again. A file without an
  `installId` or a `noticeShownAt` (missing, not JSON, or that field absent) is
  recreated as on a first start, notice included and `lastCheckAt` dropped, so
  the next start pings: with no install ID nothing
  would ever be sent, so keeping the old notice would leave the check off for
  good.
- **Once a day.** A start pings only when `lastCheckAt` is a day or more ago,
  or absent, or in the future (a clock that went back). `lastCheckAt` is
  written before the request goes out, and a start that cannot write it does
  not ping, so a read-only home directory never turns into a ping per start.
  A process that keeps running asks the same question every hour on an
  unref'd timer, so a TUI or an extension host left open still checks daily,
  and a check another surface made in the shared file counts.
- **The notice first.** On a machine with no `noticeShownAt`, the start shows
  the notice, records `noticeShownAt` and the new install ID, and sends nothing,
  then or later from that process: the off switches are read once at start, so
  only a later start could honour one the notice just told the user about. A
  start that cannot record the notice does not show it, since it would show
  again on every start, and a machine with no install ID on disk sends nothing
  to tell the user about. The notice reads: "Ordewell checks for a new version
  once a day, sending its version and a random install ID that is replaced every
  30 days. Like any server, ordewell.ai sees your IP address. Set
  ORDEWELL_NO_VERSION_CHECK=1 to turn this off. Details:
  https://ordewell.ai/docs#version-check". It names the IP address because that
  request is the only thing a user is not already choosing to send.
- **Off switches.** `ORDEWELL_NO_VERSION_CHECK` or `DO_NOT_TRACK` set to `1`,
  `true` or `yes`, or a caller passing `telemetryEnabled: false` (the VS Code
  extension, from VS Code's telemetry setting). Any one turns everything off:
  no notice, no install ID, no file written, no request, and no update line,
  even from a version a file written earlier remembers.

## Where it runs

In the CLI process the user started, never in the daemon. Each surface shows
the line where its user looks, as often as they can bear it:

- **The TUI** shows the notice in its welcome and the update line as a notice
  in its transcript, on every start while the remembered version is newer,
  since a write to the terminal would tear its frame and a TUI start is a
  person at the keyboard.
- **A headless command** writes the notice to stderr, so stdout stays its own,
  and the update line to stderr only when stderr is a terminal, at most once a
  day across the machine (`updateShownAt`): a script's log is no place for it,
  and a command run many times a day would repeat it.
- **The VS Code extension** shows the line as an information message pointing
  at the Extensions view, since the Marketplace updates the extension, at most
  once a day, since every window starts an extension host and a message
  interrupts each one.

A once-a-day line that cannot record `updateShownAt` is not shown, as a notice
that cannot be recorded is not. `main` starts the check for every command but
`tui` and `update`, and the TUI starts its own as it opens, so each start
checks exactly once. `--help` and `--version` start none.

The daemon has no terminal, outlives the command that spawned it and is shared
by every client on its port: it could not show the notice before its first
ping, nor tell which client should see the update line. A detached daemon left
running with no client attached therefore never pings; a foreground
`ordewell web` does, through the CLI process that holds it open.

## `ordewell update`

`ordewell update` and the TUI's `/update` update this copy the way it was
installed, by running the one command that install's own tool would, on this
terminal, with inherited stdio. It prints the command first, exits with its
status, and afterwards names the version before and the one the new copy
answers to `--version`. `--dry-run` prints the command and runs nothing. It
never pings: the tool it runs knows which version is the latest.

| This copy | What runs |
| --- | --- |
| A binary the installer put there | The release's `install.sh`, downloaded whole first, run with `sh` and `ORDEWELL_INSTALL_DIR` set to the folder the binary really is in (a link is followed). A folder it cannot write runs nothing, exits 1 and names the `sudo` command that would. |
| A Homebrew binary | `brew upgrade ordewell`. |
| A global npm install of `ordewell` or `@ordewell/cli` | `npm install -g <that package>@latest`; on Windows `npm.cmd`, through a shell. |
| An npx run | Nothing: it says `npx ordewell@latest` runs the latest. |
| A project's own npm install | Nothing: it names the project and `npm install ordewell@latest` there. |
| A source checkout or a development build | Nothing: it says to pull and rebuild. |

The installer is fetched before anything runs rather than piped from `curl`
into `sh`, because a pipe hides a failed download, and `sh` given nothing exits
0. In the TUI, `/update` is refused while a run is live or the planner is
answering, since exiting stops the daemon that work runs on; otherwise it asks
first, naming the command, then restores the terminal, stops the daemon it
started, runs the update, and exits with its status and a line saying to start
`ordewell` again.

## An older daemon after an update

An update replaces the CLI, not a detached daemon an earlier one left on the
port, so the next command may meet a daemon it cannot drive. A CLI that finds a
daemon on its port compares its contract with its own first
([ADR-0063](../surfaces/0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)
H3), and never drives one with another contract or none:

- **The same contract** is driven, whatever its version.
- **Another contract, idle.** `GET /api/server` answers `live`, true while a
  session the daemon holds has a run not yet settled or a planner turn
  answering. A daemon that says `live: false` is stopped as
  `ordewell stop --server` stops one, and once its port is free a daemon of
  this version starts on it.
- **Another contract, live or unable to say.** A daemon with work under way, or
  one too old to answer `live` or a contract, is left running: nothing is
  signalled, and the command exits 1 naming the port, both versions, why it was
  left, and `ordewell stop --server` to run once nothing runs there.

A refused token says nothing of the version, so it is driven as before and the
next request names the token file.

## Testing decisions

`startVersionCheck` is the seam. Its tests inject the clock, `fetch`, the
environment and the state directory, so they need no network and no real home
directory, and assert on the URL and `init` handed to the fake `fetch`, the
callbacks and the state file. The hourly re-check runs under fake timers.
`vitest.setup.ts`, `scripts/ci.mjs` and the CI job set
`ORDEWELL_NO_VERSION_CHECK=1`, so code that starts a check as a side effect
never reaches ordewell.ai from a test or a CI run. The TUI's notice is asserted
in the rendered welcome, like the rest of the welcome, and its update line in
the transcript of a launched TUI. The remembered version is asserted through
the state file across starts: shown, replaced, cleared, a start at or past it,
fields of the wrong type, a file an earlier release wrote, and nothing written
with an off switch set.

`runUpdate` takes its effects as dependencies (what runs, what it prints, the
download, whether a folder is writable, the copy's paths and platform), so each
install method, `--dry-run` and the Windows npm path are asserted on what would
have run, without updating anything. The old-daemon rule runs against real
processes standing in for an earlier daemon, which answer the routes a client
reads and exit on SIGTERM: one idle is replaced, one live or unable to say is
still running afterwards, and one with the same contract is driven.

## Considered options

- **Ping only, with no answer.** A bare count, with nothing shown to the user.
  Rejected: the user would pay for a request and get nothing back. The update
  line is what the check gives in return, and since the server may still answer
  204, a count-only server costs the contract nothing.
- **Ask npm directly.** Read the latest version from the npm registry, as
  update notifiers do. Rejected: it counts nothing, the extension is not
  installed from npm, and it still hands the IP address to a third party. One
  request to ordewell.ai does both jobs.
- **Opt-in consent.** Send nothing until the user says yes. Rejected: almost
  nobody answers a prompt like that, so the count would measure the prompt, not
  the installs. The one-time notice before the first ping, the off switches and
  respecting `DO_NOT_TRACK` and VS Code's telemetry setting give the user the
  same control without asking at every first start.
- **One ID per surface.** The CLI and the extension each keep their own ID and
  their own day. Rejected: one person with both counts twice and the machine
  pings twice a day. One shared file makes the machine the install and the day
  shared.
- **An install ID that never changes.** One UUID for the life of the install.
  Rejected: it is the one field that makes a row about a machine rather than
  about a version, and an ID that never changes outlives the three months the
  dataset keeps, so it joins every row that machine ever wrote, and a copy of
  `version-check.json` in a backup would link the machine across them. A
  30 day ID does the counting job just as well: a daily count is exact, and a
  window that spans a rotation can count one machine twice, which makes a
  monthly figure a close estimate rather than an exact count.
- **Lock the state file.** Take a lock, or compare-and-swap `lastCheckAt`, so
  two surfaces starting together cannot both ping. Rejected: the race spans
  one synchronous read and write of a small file, and a lock left by a process
  that died would need staleness rules to stop it silencing the check. An
  occasional second ping costs the count less.
- **Ping at every start.** Ask the server on each start, so the line is never
  older than the start. Rejected: it turns one request a day into one per
  start, which the notice does not promise. Remembering the answer gives every
  start the line for the price of the daily ping.
- **The update line on every headless start.** Rejected: a command run in a
  loop or a script would print it each time, into a log nobody reads for it.
  A terminal, once a day, is where a person sees it.
- **Replace an older daemon whatever it is doing.** Rejected: stopping a daemon
  with a run under way cuts that run off, and the user asked for an update, not
  a stop. An idle one costs nothing to replace; a live one is the user's to stop.
- **Drive an older daemon until it stops on its own.** Rejected: a CLI that
  sends requests in a contract the daemon does not speak fails in ways that
  describe the wrong problem, or acts on a misread answer.
- **Ping from the daemon.** One long-lived process, which would check daily on
  its own. Rejected for the reasons under Where it runs: it cannot show the
  notice or the update line where the user sees them.

## Consequences

- A headless command that finishes before the day's ping answers stays alive
  until the answer or the three-second abort, once a day at most.
- Two surfaces starting in the same instant on a day that is due can both ping;
  the file is shared, not locked. The count tolerates that more easily than
  every start would tolerate a lock.
- The README's "What Ordewell sends" and the notice are promises: a new query
  parameter, header or trigger is a change to this decision, not a tweak.
- The endpoint must answer at that URL without a redirect, or no check counts.
- A newer version an older surface showed can be cleared by a newer one: a
  start that already runs it gets no news and clears the remembered version,
  so the older surface shows nothing until its own next ping.
- A daemon from before `live` cannot say whether work is under way, so the
  first command after updating from such a release refuses rather than replaces
  it until the user runs `ordewell stop --server`.
- A daemon with the same contract and an earlier version keeps running its own
  code until it stops.

## History

- 2026-10-23 — accepted.
- 2026-10-23 — a file without an install ID starts over; a notice that cannot be recorded is not shown.
- 2026-10-25: the install ID is replaced every 30 days, and the notice names the IP address.
- 2026-11-06 — the update line names the install method: Homebrew, the installer for another binary install, or npm.
- 2026-11-06 — the newer version is remembered and named on every TUI start, a terminal's stderr once a day and VS Code once a day; `ordewell update` and `/update`; an idle daemon a CLI cannot drive is replaced, a live one left running.
