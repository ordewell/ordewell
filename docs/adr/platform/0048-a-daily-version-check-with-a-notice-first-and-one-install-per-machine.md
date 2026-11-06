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
  line: `Ordewell <latest> is out — npm i -g ordewell`, where the command names
  how this copy was installed: `brew upgrade ordewell` for a Homebrew install,
  running the installer again for another standalone binary
  ([ADR-0065](../surfaces/0065-the-cli-also-ships-as-a-standalone-node-binary.md)
  C9), `npm i -g ordewell` otherwise. Any other answer, a
  status that is not 200, a body that is not that JSON, a network failure or no
  answer within three seconds is ignored. The check never throws and never
  holds up a start.
- **One install per machine.** The state is `version-check.json` in
  `globalDataDir()` (`~/.ordewell/`), next to the global `settings.json`:
  `installId`, `installIdAt`, `noticeShownAt` and `lastCheckAt`. The CLI and the
  VS Code extension read and write the same file. It is written atomically and
  owner only. A field of the wrong type counts as absent, and a file without an
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
  no notice, no install ID, no file written, no request.

## Where it runs

In the CLI process the user started, never in the daemon. A headless command
writes the notice and the update line to stderr, so stdout stays its own; the
TUI shows the notice in its welcome and the update line as a line in its
transcript, since a write to the terminal would tear its frame. `main` starts
the check for every command but `tui`, and the TUI starts its own once its
daemon is up, so each start checks exactly once. `--help` and `--version`
start none.

The daemon has no terminal, outlives the command that spawned it and is shared
by every client on its port: it could not show the notice before its first
ping, nor tell which client should see the update line. A detached daemon left
running with no client attached therefore never pings; a foreground
`ordewell web` does, through the CLI process that holds it open.

## Testing decisions

`startVersionCheck` is the seam. Its tests inject the clock, `fetch`, the
environment and the state directory, so they need no network and no real home
directory, and assert on the URL and `init` handed to the fake `fetch`, the
callbacks and the state file. The hourly re-check runs under fake timers.
`vitest.setup.ts`, `scripts/ci.mjs` and the CI job set
`ORDEWELL_NO_VERSION_CHECK=1`, so code that starts a check as a side effect
never reaches ordewell.ai from a test or a CI run. The TUI's notice is asserted
in the rendered welcome, like the rest of the welcome.

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

## History

- 2026-10-23 — accepted.
- 2026-10-23 — a file without an install ID starts over; a notice that cannot be recorded is not shown.
- 2026-10-25: the install ID is replaced every 30 days, and the notice names the IP address.
- 2026-11-06 — the update line names the install method: Homebrew, the installer for another binary install, or npm.
