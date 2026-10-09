# 0001 — Autonomous mode resolution

**Status:** accepted

## Problem

Generating a plan means picking a runner mode per task — Claude's
`default`/`acceptEdits`/`auto`/`bypassPermissions`, OpenCode's `build`/`plan`, Codex's
own set. Three things made that hard to just ask the planner to do:

- Mode names are runner-specific, and the conventions disagree. OpenCode has no
  mode safer than `build`; Codex differs again.
- The planner was observed defaulting to the least autonomous mode
  (`default`/"ask before edits"). Reading the prompt afterwards, the cause was
  plain: the mode list anchored on whatever came first, and the autonomous
  mode's own description ("use only when you don't need supervision") was
  scaring it off.
- We did not want a global toggle that silently rewrites plans after the fact.
  What the plan says is what runs, or the plan stops being worth reviewing.

## Decision

Mode resolution is **planner-nudged, parser-validated, never runtime-overridden**, driven by **symmetric manifest tags** (`autonomous` / `safe`) and a **global user setting with two named levels**, *Full* and *Guarded*.

Concretely:

- **The plan is the source of truth.** The level is read only at generation
  time; the orchestrator never replaces `task.taskMode` at spawn. A user who
  changes the level after generating sees no change until they regenerate. That
  is deliberate — it is the same rule `/model set` follows.
- **Two levels, one boolean.** The setting is a boolean (`autonomousMode`,
  `autonomousDefault`, TUI `autonomous`, VS Code `ordewell.autonomousMode`,
  default on). **Full** is on: each runner's `autonomous`-tagged mode.
  **Guarded** is off: each runner's `safe`-tagged mode. `/auto full` and
  `/auto guarded` select them (`ordewell auto full|guarded` likewise); `on`, `off`
  and `auto` stay as aliases, and a bare `/auto` in the TUI reports the current level
  instead of flipping it.
- **Manifests declare what autonomy means for that runner.** Core never
  hardcodes mode IDs. Each manifest tags one mode `autonomous: true` and one
  `safe: true`:
  - **Claude Code:** `bypassPermissions` ("Bypass permissions") is
    `autonomous`; `auto` (`--permission-mode auto`, where Claude's own
    classifier approves or blocks each action) is `safe`. `default` ("Ask
    before edits") stays selectable with no level tag, so it is offered under
    both. Claude Code still accepts `--permission-mode default` although it no
    longer lists it.
  - **Codex:** `fullAccess` (`danger-full-access`, approvals `never`) is
    `autonomous`; `agent` (the workspace-write sandbox, approval policy
    `on-request`, `approvals_reviewer=auto_review` — Codex's risk-assessing
    subagent) is `safe`. The manifest expresses both per mode in
    `features.modeSettings` (`approvalPolicy`, `approvalsReviewer`). The
    Codex connector supplies these to `thread/start` and `thread/resume`;
    terminal invocation flags are not part of the manifest.
  - **OpenCode:** `build` wears both tags — an honest no-op, since OpenCode has
    nothing safer than build, rather than a mystery.
- **The planner is steered, not coerced.** `buildModeGuide` names the resolved
  default per runner explicitly, lists the level's mode first, and says
  "default to this unless the task specifically needs more caution." The parser
  only intervenes on invalid emissions; its fallback picks the
  `autonomous`/`safe`-tagged mode per the level. The planner keeps portfolio
  judgment — it may still pick a more conservative mode for a task it judges
  risky.
- **`plan` mode stays valid but is steered away from** for build-style tasks.
  The parser never rewrites it; the guide simply does not point the planner at
  it. Manual per-task override in the UI wins at every level.

## Alternatives considered

- **Runtime override** — the setting rewrites modes at spawn, including on
  already-generated plans. Rejected: it makes "what the plan says" differ from
  "what runs", which is the exact silent state this project refuses to create.
  It also erases the planner's per-task judgment.
- **Hard parser override** — the setting forces every non-plan AI task to the
  autonomous mode at parse time, ignoring what the planner emitted. Rejected
  for the same reason plus a concrete artifact: the plan JSON would show a mode
  the planner did not emit, with no signal why.
- **Per-runner toggle** (`ordewell.autonomousByRunner`). Rejected: manifest
  tags already absorb runner heterogeneity; a per-runner map adds state and UI
  for a marginal case, and one-off overrides already exist as the per-task
  dropdown.
- **Positional safe fallback** — with the setting off, resolve to the
  first-listed manifest mode. Rejected: reordering a manifest would silently
  change that behavior.
- **Parser rewrites `plan`** — when off, map `plan`→`build` for OpenCode.
  Rejected twice over: it makes the task *more* permissive, the opposite of
  what off means; and dropping `plan` from manifests entirely would break
  saved plans.
- **Remove `plan` mode as a product decision** — analysis can happen in the
  other modes. Rejected: it complicates the common case to simplify a rare
  one. The guide-steers-but-parser-respects settlement keeps it available
  without pushing anyone toward it.
- **Claude's `default` as the `safe` mode.** It was, until the two levels were
  named. Rejected then: a level whose every action waits for a person is not
  "auto"; Claude's `auto` mode trades the prompt for its own classifier, which
  is what the level means. `default` stays one pick away.
- **"Auto mode" as the label of `bypassPermissions`.** It was. Rejected: it
  collided with Claude's real `auto` mode.

## Consequences

- The level is generation-time only. Already stated above; worth repeating
  because it is the property users ask about.
- Manifest authors must tag at least one mode `autonomous` and one `safe`, or
  generation degrades to the pre-fix ad-hoc prompt. The builtin manifests tag
  both.
- OpenCode resolves to `build` at either level. The setting is effectively a
  no-op for OpenCode-only plans. Correct, not a bug: there is nothing for it to
  switch between.
- "Guarded" is not the least-privileged choice on every runner: it trades a prompt
  for a reviewer's judgement. A person who wants every action to wait for them
  picks `default` (Claude) by hand, which no level selects.
- `bypassPermissions`' manifest description no longer carries the "use only in
  sandboxed/CI environments" caveat. That caveat is what anchored the planner
  away from autonomous modes in the first place — a self-inflicted bug caused
  by our own copy. Manifest descriptions are prompt material, not core logic;
  editing them does not violate the no-hardcoded-modes rule.
- A future runner whose `plan` mode is not read-only must still be reachable
  by manual selection in the UI. The level steers the planner; it never
  overrides a human's explicit choice.

## History

- 2026-07-31 — accepted: one on/off toggle, `/auto`.
- 2026-10-01 — the two states named *Full auto* and *Auto*; Claude's `safe` mode
  moved from `default` to `auto`, Codex's `safe` mode gained the auto reviewer.
- 2026-10-05 — the levels renamed *Full* and *Guarded*: *Auto* collided with Claude
  Code's own `auto` permission mode (`/auto auto`), and *Guarded* holds on every
  runner, where a classifier does not. `auto` stays an alias of Guarded.
- 2026-10-09 — aligned with [ADR-0025](0025-structured-only-runners.md).
