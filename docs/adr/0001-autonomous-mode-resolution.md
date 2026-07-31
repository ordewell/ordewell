# 0001 — Autonomous mode resolution

**Status:** accepted

When generating plans, Ordewell must pick a runner mode (Claude's `default`/`acceptEdits`/`bypassPermissions`, OpenCode's `build`/`plan`, etc.) per task. Mode names are runner-specific, conventions vary (OpenCode has no safer-than-build option; Codex will differ again), and the planner was observed defaulting to the least autonomous mode (`default`/"ask before edits") because the prompt anchored on the first-listed mode and the autonomous mode's description scared it off.

We decided that mode resolution is **planner-nudged, parser-validated, never runtime-overridden**, driven by **symmetric manifest tags** (`autonomous` / `safe`) and a **global user toggle** (`ordewell.autonomousMode`, default ON, surfaced via `/auto`).

Key properties:
- **The plan is the source of truth.** The toggle is read *only at generation*; the orchestrator never replaces `task.taskMode` at spawn. What the plan says is what runs.
- **Manifests declare what autonomy means for that runner.** Core never hardcodes mode IDs. Each manifest tags one mode `autonomous: true` and one `safe: true` (OpenCode's `build` wears both hats — an honest no-op, not a mystery).
- **The planner is steered, not coerced.** `buildModeGuide` names the resolved default per runner explicitly, lists the autonomous mode first, and instructs: "default to this unless the task specifically needs more caution." The parser only intervenes on *invalid* emissions; it picks the `autonomous`/`safe`-tagged mode per the toggle as fallback. The planner keeps portfolio judgment — it may still emit a more conservative mode for a task it judges risky.
- **`plan` mode is valid but guide-steered-away.** The parser respects `plan` (no rewrite); the guide simply doesn't direct the planner toward it for build-style tasks. Manual per-task override via the UI remains sacred under both toggle states.

## Considered options

- **Runtime override (β at Q4).** Toggle rewrites modes at spawn for all tasks, including already-generated plans. Rejected: diverges "what the plan says" from "what runs" — the silent state the project deliberately avoids. Also destroys the planner's per-task judgment.
- **Hard parser override (β at Q4).** Toggle forces all non-plan AI tasks to the autonomous mode at parse time, ignoring planner emissions. Rejected: discards portfolio judgment; plan JSON shows a mode the planner didn't emit with no signal why.
- **Per-runner toggle (Q2).** `ordewell.autonomousByRunner: Record`. Rejected: runner heterogeneity is already absorbed by the manifest tags; a per-runner map adds state and UI complexity for a marginal case. One-off overrides use the existing per-task dropdown.
- **Positional safe fallback (A at Q3).** OFF resolves to the first-listed manifest mode. Rejected: reordering the manifest silently flips OFF behavior.
- **Parser rewrites `plan` (α/γ at Q6).** Rejected: under OFF, `plan`→`build` for OpenCode makes the task *more* permissive — the opposite of what OFF means. Removing `plan` from manifests entirely (γ) breaks existing saved plans.
- **`plan` is sacrosanct (A at Q5).** Rejected by product: plan mode complicates things; analysis can be done in the other modes. Settled as (β): guide steers away, parser stays clean.

## Consequences

- A user who toggles autonomous OFF after generating a plan sees no change until they regenerate — the plan retains its modes. This is deliberate (plan as artifact) and consistent with `/model set` only affecting future generations.
- Manifest authors must tag at least one mode `autonomous` and one `safe` or generation degrades to the pre-fix ad-hoc prompt. Builtin manifests (`claude-code`, `opencode`) will tag both.
- OpenCode under ON and OFF both resolve to `build` (it wears both tags). Correct: OpenCode has no safer-than-build mode. The toggle is effectively a no-op for OpenCode-only plans.
- `bypassPermissions`'s manifest description should drop the "use only in sandboxed/CI environments" caveat, since Ordewell's purpose is autonomous runs — that caveat caused the original cautious-LLM bug. Manifest copy is manifestation-specific, not core logic, so editing it is not a violation of the "no hardcoded modes" rule.
- A future runner whose `plan` mode isn't read-only must still be respected if a user manually selects it via the UI. The toggle steers the planner; it never overrides manual choice.