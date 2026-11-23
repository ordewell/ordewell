---
status: accepted
---

# 0075 — The first run that passes asks for feedback, once per machine, and sends nothing

## Problem

Someone who has just watched their first plan's every task pass is the person
most likely ever to give feedback or star the repository, and at that moment
Ordewell said nothing: the link to the feedback discussion was in the READMEs
alone. A prompt for it must not become the thing users complain about: it must
come once, never in a script's log or a CI job, never in the way of a run, and
never send anything. What counts as a passed run, and what "once" means when
the TUI, the desktop app and VS Code share one machine, have to be decided
once, since a notice that comes back is the failure people remember.

## Decision

**The first time on a machine that a run's end stands with every task passed,
the surface the person is at shows one notice asking how it went; the notice is
recorded before it shows, so no surface on that machine shows it again, and
nothing is sent.**

- **What counts.** A `run_concluded` whose `ExecutionSummary` has every task of
  the plan completed (`everyTaskPassed`: `total > 0` and `completed === total`),
  the end the orchestrator words "All tasks completed"
  (`TaskOrchestrator.sayFinished`, `PlanStore.isAllComplete`). A failed, blocked
  or skipped task is not a pass, nor is a plan with no task. It is
  `run_concluded` and not `execution_complete`: at Act the supervisor's closing
  turn follows the first end and may continue the run (ADR-0029), and the
  notice never appears during a run.
- **Once per machine.** `claimFirstRunFeedback` in core creates
  `first-run-feedback.json`, holding `shownAt`, in `globalDataDir()`
  (`~/.ordewell/`, beside the version check's file), owner only, and creates it
  exclusively: the claim is the record. Any file already there, readable or
  not, counts as shown; a record that cannot be created is not shown, since
  nothing would then stop it at every passed run. The TUI, the desktop's main
  process and the VS Code extension host claim through the same file, so the
  surface that claims first is the only one to show it, and what the person
  then does (an action, the dismiss, nothing) changes nothing.
- **Only where a person is.** The surface says whether one is: the TUI from its
  terminal (stdin and stdout both a TTY), the desktop app unless its windows
  are hidden for a test run, VS Code unless the extension host runs under test.
  `CI` set to anything but empty, `0`, `false` or `no` counts as no one there. A
  headless command (`ordewell run`, `ordewell plan`) never shows it.
- **The off switch.** `ORDEWELL_NO_FEEDBACK_NOTICE` set to `1`, `true` or
  `yes`, read as the version check reads `ORDEWELL_NO_VERSION_CHECK`
  (ADR-0048): nothing is shown and nothing written.
- **The words.** One table in core (`FIRST_RUN_FEEDBACK`), so every surface
  says the same: "How did it go?" and "Ordewell is open source and built in the
  open, and feedback from a first run is what it needs most.", with two
  actions, "Tell us how it went", which opens
  https://github.com/ordewell/ordewell/discussions/115, and "Star on GitHub",
  which opens https://github.com/ordewell/ordewell. No exclamation, no claim.
- **Nothing is sent.** Showing and recording it make no request; a browser
  opens only when the person picks an action.

## Where it shows

Each surface shows it where it shows the version check's notice (ADR-0048), in
a form that takes no focus and holds nothing up:

- **The TUI** adds a line to the conversation, held in place so a scrolled
  transcript does not move: "How did it go? Ordewell is open source and built
  in the open, and feedback from a first run is what it needs most. Tell us how
  it went: /feedback · Star on GitHub: /star". `/feedback` and `/star` open the
  pages with the platform's own opener (`open`, the Windows URL handler,
  `xdg-open`) and say which page opened; where none can start, as on a Linux
  terminal with no display over SSH, they name the page to open by hand. The
  commands stay after the notice. A line needs no dismiss: anything that took a
  key would take it from the composer.
- **The desktop app** shows a banner, "How did it go?", with Tell us how it
  went, Star on GitHub and Dismiss; an action closes it too. Its title is said
  once by the window's polite live region. The window asks main when ui's
  `SessionView` cues `passed`; main checks the summary again and holds the
  claim (`feedback.claim`), as it holds the version check.
- **VS Code** shows an information message with the two actions, from the same
  `passed` cue; VS Code's own close is the dismiss.

## Testing decisions

`claimFirstRunFeedback` is the seam: its tests inject the state directory, the
environment and the clock, and assert on its answer and on what the directory
holds, so a test never touches a real home. Each surface is driven from a
`run_concluded` as its stream delivers one: the TUI through its inbound router,
reducer and effects with the real claim on a temporary directory (the pattern
of `executionAction.test.ts`), the desktop through the frame with every view
registered and a fake daemon pushing frames (as the update notice's tests do),
with main's `claimForWindow` asserted on its own against a temporary directory,
and VS Code through `handleSessionMessage` and a fake `vscode`. The desktop
e2e environment sets `ORDEWELL_NO_FEEDBACK_NOTICE=1` beside
`ORDEWELL_NO_VERSION_CHECK=1`, since its plans pass on a fresh home; CI's own
`CI` keeps it off there.

## Considered options

- **A field in `version-check.json`.** That file is already per machine and
  shared by every surface. Rejected: a release that rewrites it keeps only the
  fields it knows (ADR-0048), so an older copy beside a newer one would drop the
  record and the notice would show again; the version check's off switches
  promise no file at all, which a field written here would break; and a file
  the version check recreates, as it does one with no install ID, would lose it.
- **At `execution_complete`.** Sooner, by a closing turn. Rejected: at Act that
  turn may continue the run, and the notice would then show during it.
- **Record it when the person acts or dismisses it.** Rejected: a notice
  ignored, or a window closed under it, would come back at the next passed run.
  Recording before showing is what makes it never twice.
- **A modal, or a prompt that takes the keyboard.** Rejected: it takes focus
  from whatever the person turned to next, and in the TUI an overlay takes the
  composer's keys.
- **The version check's off switches turn it off too.** Rejected:
  `ORDEWELL_NO_VERSION_CHECK` and `DO_NOT_TRACK` are about what leaves the
  machine, and this sends nothing; a switch of its own keeps both meanings
  plain.

## Consequences

- Deleting `~/.ordewell/first-run-feedback.json` makes the next passed run show
  it once more.
- Two surfaces ending runs together cannot both show it: an exclusive create
  has one winner, and needs no lock that a dead process could leave behind.
- A machine whose home cannot be written never shows it.
- The TUI keeps `/feedback` and `/star` as commands; the CLI has no headless
  counterpart, since a headless command opens no browser.

## History

- 2026-11-21 — accepted.
