---
status: accepted
amends: ["0009", "0038"]
---

# 0075 — An installed coding agent outranks a found API key unless the user chose the key's vendor

## Problem

When the user names no planner, `BaseConfig.detectProvider` decides who plans.
Until this decision it read, in order: `AI_PROVIDER`, a vendor key in the
environment, a key a host keeps outside it (VS Code's secret storage,
`~/.ordewell/.env`), and only then the installed coding agent
([ADR-0009](0009-coding-agents-as-planners.md)). An API planner has no default
model on purpose, so a key alone produced a planner that refused the first goal:
"No planner model selected for OpenAI".

The first-run audit found this the most likely loss on every surface. A Claude
Code or Codex user with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or
`GEMINI_API_KEY` in their shell, which is common among developers, met that
refusal on their first goal. So did anyone who added a key in VS Code or
through the desktop welcome's *Set API key…*, which offers a key for the
built-in runner, not for planning. The product promises that no API key is
needed. A key sitting in a shell is not a decision to plan with it, and
Ordewell must not spend a user's API credit unasked.

## Decision

**A usable installed coding agent plans ahead of a found vendor key, unless the
user chose that key's vendor: by naming a planner, or by saving a model for
it.** With no surface setting naming a planner, `detectProvider` answers, in
order:

1. `AI_PROVIDER`, which is also how a `/planner` pick or `ordewell planner <id>`
   persists (the daemon and the CLI read it from `~/.ordewell/.env`). VS Code's
   `aiProvider` setting is read before routing, as before.
2. A vendor whose key or endpoint is found and for which a model is saved: the
   configured planner model (`ORCHESTRATOR_MODEL`, VS Code's
   `orchestratorModel`) when it names that vendor (its catalog lists it, it
   carries the vendor's prefix such as `openai:`, or it is an `org/model` slug
   with an OpenRouter key), or a bare id that is not the agent's own, which
   keeps the vendor the found key selects; or Gemini's own model setting
   (`GEMINI_MODEL`, VS Code's `geminiModel`) beside a Gemini key.
3. The installed coding agent detection found (ADR-0009, ADR-0038), unless its
   own status command last said the user is signed out.
4. A vendor whose key or endpoint is found, environment first.
5. `openrouter`, so the preflight names what is missing.

A model is the agent's own when it is one of its stable aliases, its remembered
pick or listed in its discovered catalog; such a model never chooses a vendor.
A vendor model whose vendor has no key never hands planning to another
vendor's key.

Every host reads this one rule, so the daemon, the CLI, the terminal UI, the
desktop app and VS Code agree. When a found key is passed over this way,
`BaseConfig.unusedPlanningKey` names its vendor, the daemon's settings answer
carries it (`unusedPlanningKey`), and each surface's first screen says once who
plans, why, and where to change it, in core's one wording
(`describeUnusedPlanningKey`): "Planning with Claude Code. An OpenAI key was
found and is not used for planning; /planner changes that."

An API planner still has no default model. When one plans with none, because
no agent is installed or the user chose it, the goal is still refused, and the
refusal names the exact step on each surface: `/planner` and a model for that
vendor in the terminal UI, the desktop app and VS Code; `ordewell models`, then
`ordewell model set <id>`, from the command line.

## Key properties

- **No change for a user who already plans with a vendor.** A persisted pick is
  `AI_PROVIDER` or the VS Code setting, which come first; a saved model for the
  key's vendor keeps that vendor. Only a key with nothing chosen beside it,
  which could not plan before because it had no model, moves to the agent.
- **A signed-out agent does not take planning from a key.** The same verdict
  the preflight refuses on (ADR-0052) lets the key's vendor plan; an unknown
  verdict says nothing.
- **Routing stays memoized on what it reads.** `routedProvider`'s basis adds
  the agent's sign-in verdict, whether the configured model is the agent's own
  and Gemini's model setting, so a long-lived config answers what a fresh one
  would.

## Testing decisions

The rule is tested where hosts read it: `EnvConfig` and the protected
`detectProvider` in core, `WebConfig` and `OrchestratorPool.getSettings` for the
daemon, `VsCodeConfig` and `PlannerSelection` for VS Code. Each migration case
is a test of its own: a persisted `AI_PROVIDER`, a prefixed model, an OpenRouter
slug before its catalog is discovered, a bare id, `GEMINI_MODEL` and VS Code's
`geminiModel`. The surfaces' notices are tested through their own seams: the
terminal UI's rendered welcome, the chat webview fed `setPlannerBackends`, and
the desktop host's messages.

## Out of scope

- What a user with no agent installed sees, and a key flow that ends in a model
  pick: the no-agent first run is its own change.
- A default model for any vendor.

## Considered options

- **A vendor key wins over an installed agent.** The design until 2026-11-21
  (ADR-0009). Dropped: a key is often in a developer's shell for other tools,
  and a vendor with no model refused the first goal, the failure a first run
  must not have.
- **A default planner model for each vendor.** Rejected: it would plan, and
  spend the user's credit, on a vendor they never chose, and a default goes
  stale as vendors retire models.
- **Ask on the first goal which planner to use.** Rejected: a question before
  the first plan is the friction this decision removes, and the answer is
  already known when an agent is installed.
- **Treat only a prefixed or catalog-listed model as a choice.** Rejected: a
  bare id written beside a key (`ORCHESTRATOR_MODEL=gpt-4o`) planned with that
  vendor before, and an upgrade must not move it.

## Consequences

- A Claude Code or Codex user with a vendor key in their shell plans on their
  first goal with no setup.
- A user who wants an API planner while an agent is installed picks it with
  `/planner`, or saves a model for it; adding a key alone no longer switches.
- The welcome's line is the one place a passed-over key is mentioned; a surface
  that drops it leaves a user wondering why their key is idle.

## History

- 2026-11-21 — accepted and implemented.
