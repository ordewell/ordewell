---
status: accepted
amends: ["0018", "0029"]
---

# 0044 — A planner's usage limit waits and resends, and a limit counts only in a turn Ordewell started


## Problem

A task that hits its runner's usage limit pauses and resumes at the reset
(ADR-0018, U1). The planner is a runner too (ADR-0009), and the same limit can
end one of its turns. Then the user's message, or the supervisor's wake-up, had
been taken and nothing answered it; and a run supervised by that planner went
unsupervised for good (ADR-0029).

Reading a limit also went wrong in both directions. Words that look like a
limit in a turn that had already ended counted as one, and Codex's
provider-throttle error (`rateLimitExceeded`), which it retries itself, read
like an account limit.

## Decision

**A planner turn that ends on its usage limit shows as a failure, keeps every
input it took, and sends them again at the reset. A limit counts only when it
ended a turn Ordewell started.**

### The planner's wait

- The turn ends as a failure line in the transcript (✗, with the reset time
  when one is known). The inputs it took, and any that arrive meanwhile, stay
  pending on the plan (`pendingTurns`), and a wait is saved with it
  (`plannerResend`: the runner and the time).
- At the reset plus a short margin they are **sent again as one turn**. A
  user's message sent during the wait is saved and answered at once, since its
  turn is hours off; it goes with the rest.
- The wait is saved with the plan. Loading a session clears its scheduled
  resend time and holds the inputs for a new message, whether that time is
  still ahead or already passed. Loading alone never calls the planner.
- **Nothing is sent that no one asked for since** when no time is known: the
  reset could not be read, the resend hit the limit again within five minutes,
  the user cancelled, or the planner moved to another runner, whose account the
  limit is not. What waits is then **held** for the next input, the user's
  message or a wake-up.
- The user cancels with `/resend cancel` in the terminal UI, `ordewell resend
  cancel`, or **Don't resend** above the VS Code composer.
- **The supervisor's wake-ups wait with the rest** and go in the resend. The
  supervisor keeps no wait of its own; with no reset to wait for, the run
  carries on without its supervisor and says so (ADR-0029).
- **A turn whose change took its inputs as answered** (ADR-0022 P2) has
  nothing to send again, and sends nothing again. With its reset known the
  wait is armed all the same, empty: what arrives meanwhile, the user's message
  or a wake-up, waits for the reset and goes then, and the run stays
  supervised. With none known nothing waits.

### The in-flight rule

- **A limit is acted on only when it ended a turn Ordewell started** (a task's
  or the planner's). A runner process that exits holding limit words from a
  turn that had already ended did not stop on the limit. A turn Ordewell was
  starting that the limit refuses is a pause, as one cut off mid-turn is, and
  its saved session stays for the resume.
- **A runner's structured word outranks its words.** Codex's
  `codexErrorInfo` names `usageLimitExceeded` as the limit, with the reset from
  `account/rateLimits` (the latest among the windows used up); an error naming
  another cause is not the limit, and its words do not overrule that. Claude Code
  and others that report only words are read by their words, as before. This
  holds for tasks, planner turns and supervisor wake-ups alike.
- **An API planner's client states the limit as a field.** Its usage-limit
  error carries the reset (`resetsAt`), which the wait reads; a rate limit or
  transient failure is retried by the client on the provider's Retry-After and
  is never the limit.

## Key properties

- A planner limit loses no message and no wake-up.
- The user is never made to wait on a reset they could answer for themselves:
  their message is acknowledged at once and goes with the resend.
- A planner that has moved to another runner never resends on the old runner's
  clock.
- A provider's throttle is never taken for an account limit.

## Considered options

- **Fail the turn and drop its inputs.** The earlier behaviour: the message was
  lost, and a supervised run lost its supervisor.
- **Resend at once, or on a timer shorter than the reset.** Rejected: it spends
  the exhausted limit again, and a relapse within five minutes holds instead.
- **Resend without being told when no reset is known.** Rejected: an unattended
  guess could resend into the limit repeatedly; the next input is a signal that
  someone is there.
- **Re-arm saved timers on load.** Rejected: opening an old session is not
  consent to spend tokens. The inputs survive, but wait for a new message.
- **Keep the user's message pending without answering it.** Rejected: the send
  would not settle for hours.
- **Treat any limit words as a limit.** The earlier behaviour; it paused work
  that had not stopped, and a throttle as a limit.

## History

- 2026-10-17 — accepted and implemented: the planner's wait and resend, `/resend cancel`, the in-flight rule, and Codex's structured limit signals.
- 2026-10-18 — loading a session holds saved inputs for a new message instead of rearming its resend timer.
- 2026-11-14 — an API planner's turn ends on a usage-limit error from its `ModelClient` and waits for the reset that error states. Before it, an API planner's limit stated no reset to wait for.
- 2026-11-22 — a limit after the turn's change, with its reset known, arms an empty wait, so what arrives meanwhile goes at the reset and supervision goes on (ADR-0029); before, the run went unsupervised.
