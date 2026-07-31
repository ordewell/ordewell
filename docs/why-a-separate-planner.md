# Why I run a cheap, separate planner LLM — and route a different model per task

*Design notes from building [Ordewell](../README.md), an orchestrator that turns a goal into a
reviewed, dependency-ordered plan and then runs each task through whichever coding CLI you already use.*

---

## The default everyone reaches for (and why I didn't)

The obvious way to build a multi-step coding agent is to let one expensive model do everything:
it reads the codebase, decides what to do, writes the code, and checks its own work, all in one
long context. That's what most "give it a goal, watch it work" tools do, and it's what the
platforms now ship natively.

I split the problem in two instead:

1. **A planner** — a cheap, fast model that *only* researches the repo (read-only) and emits a
   structured plan: an ordered list of tasks, a dependency graph, and a per-task assignment of
   *which model*, *how much thinking effort*, and *build-vs-plan mode* each task should run with.
2. **Executors** — the actual coding agents (Claude Code, OpenCode, or any CLI via a plugin) that
   each run *one* task, in their own session, with the model the planner picked for that task.

The planner never writes code. The executors never plan the whole job. This note is about why that
seam is worth having.

## Planning and coding are different workloads

Decomposition is a *reading-and-reasoning* task over a bounded context: skim the README, grep for
the seams, decide the order, spot what can run in parallel. It does not need the strongest coding
model — it needs a model that is cheap enough to run speculatively and good enough at structure.

Code generation is the opposite: narrow scope, high stakes per token, and it benefits from the
strongest model *for that specific change* — but only for that change. A migration step and a
"fix the lint" step do not deserve the same model.

If one expensive model does both, you pay top-tier inference for the cheap half (planning) and you
pay it *again* for every trivial task, because there's no mechanism to dial the model down once the
context is hot. Coupling planning to execution throws away the cheapest optimization available:
**spend reasoning where it changes the outcome, and nowhere else.**

In Ordewell the planner defaults to a cheap model (`deepseek/deepseek-v4-flash` via OpenRouter, or
Gemini Flash-class) while individual tasks can be assigned Opus, Sonnet, DeepSeek V4 Pro, Kimi,
etc. The expensive model only shows up where a task actually warrants it.

## The plan is a typed artifact, not a transcript

Because the planner's only job is to emit structure, its output is a small, inspectable object —
roughly:

```jsonc
{
  "tasks": [{
    "id": "…", "order": 1, "title": "…", "dependencies": ["…"],
    "type": "ai",                                   // or "user" — a manual checklist
    "prompt": "Detailed instructions for the coding agent",
    "assignedModel": { "modelId": "…", "thinkingEffort": "low|medium|high" },
    "assignedRunner": "claude-code",                // drawn from plan.runners
    "taskMode": "build|plan",                        // edits files, or read-only
    "testingStrategy": "inline|separate_task|user_verify|none"
  }]
}
```

That artifact is the whole interface between "decide what to do" and "do it." A few things fall out
of treating the plan as data rather than as a running agent's internal state:

- **You can edit it before spending a cent on execution.** Rewrite a prompt, downgrade a model,
  flip a task to read-only — no round-trip to the planner.
- **You can diff it, persist it, and re-run it.** Plans serialize to JSON and execute headlessly in
  CI. The plan you reviewed is the plan that runs.
- **Dependencies are explicit**, so independent tasks fan out in parallel and dependent ones wait —
  the schedule is a property of the data, not an emergent behavior you hope for.

The prompt-construction lives in
[`packages/core/src/services/PlanPrompts.ts`](../packages/core/src/services/PlanPrompts.ts) and the
parsing in [`packages/core/src/parsing.ts`](../packages/core/src/parsing.ts); dispatch
by `assignedRunner` lives in the `TaskOrchestrator`.

## The cost of the seam: structured output is a contract, and contracts break

The price of making the plan a typed artifact is that you now depend on a model emitting *valid,
parseable JSON* at the boundary. This is the single most load-bearing line in the whole system, and
it is exactly where these designs quietly fail: a model wraps the JSON in prose ("Here's your
plan:"), or in a ```json fence, or the stream truncates, and a naive `JSON.parse` throws an
uncaught exception straight through the orchestrator.

So the boundary is hardened rather than trusted:

- **Brace-aware extraction.** `extractJsonObject()` strips fences and then scans for the outermost
  balanced `{ … }`, ignoring braces inside strings — so a prose preamble or trailing chatter
  doesn't matter.
- **Typed, recoverable errors.** A parse failure throws a `PlanParseError`/`ReviewParseError`
  carrying the raw text, never a bare `SyntaxError`.
- **Re-emit-on-invalid retry.** `generatePlanWithRepair()` wraps generation: if parsing fails, it
  re-prompts the *same* model with a terse instruction to resend strict JSON, and only surfaces the
  error if the retry also fails. The review path degrades to a safe *failing* verdict rather than
  throwing — so a flaky reviewer response can never silently mark a task as passed.

This is mundane plumbing, but it's the difference between a demo and something you'd point at your
own repo. The structured seam is what makes everything else possible; it's also what you have to
defend.

## Per-task routing changes what "thinking effort" means

Once the planner assigns a model *and* a thinking-effort tier *and* a mode per task, "effort" stops
being a global dial and becomes a scheduling decision:

- A docs or config task → cheap model, low effort, and `testingStrategy: none`.
- A security-sensitive refactor → strong model, high effort, with an inline verification command
  appended to its own prompt.
- An analysis-only task → `taskMode: plan`, which passes the runner's read-only flag
  (`--permission-mode plan` for Claude, `--agent plan` for OpenCode) so it physically cannot edit.

The planner is making a portfolio decision across the whole job, not a single global setting. That's
only expressible because the plan is a list of independently-parameterized tasks instead of one
monolithic agent run.

## The honest part: this is an optimization, not a moat

I'll be blunt, because pretending otherwise wastes everyone's time: the *orchestration loop itself*
— goal → plan → DAG → spawn → review — is being absorbed into the coding platforms as a native,
free feature, and a separate-planner pattern is something any of them can replicate. If you're
evaluating this as a startup, the orchestration mechanics are not where a defensible business lives.

What I think *is* durably interesting, and is what I'd actually defend in an interview:

- **Decoupling the planning workload from the execution workload** is what makes per-task routing
  possible at all, and it generalizes — the planner doesn't care which executor runs the task, so
  you route across *vendors*, not just models. Whether that nets out cheaper depends entirely on
  the work: on a task one cheap agent finishes in one context, orchestration is overhead you are
  paying for nothing.
- **The verification seam** — "did the agent actually do what the task said?" — is the genuinely
  unsolved part. Grading terminal output is the naive version; running the task's tests, inspecting
  the diff, and checking exit codes against a per-task success criterion is where the real product
  is. The plan already carries a `testingStrategy` per task, which is the hook for exactly that.
- **Treating the plan as an editable, diffable, re-runnable artifact** is the thing that makes the
  whole pipeline auditable — which is what matters the moment more than one model, or more than one
  person, is in the loop.

The separate planner isn't a clever trick to beat the platforms. It's a cleaner way to think about
the problem: planning is a reasoning task, execution is a coding task, verification is a
*different* reasoning task — and each becomes inspectable, and separately tunable, once you stop
forcing one model in one context to be all three at once.

---

*Code: [`PlanPrompts.ts`](../packages/core/src/services/PlanPrompts.ts) (plan prompt),
[`parsing.ts`](../packages/core/src/parsing.ts) and
[`PlanRepair.ts`](../packages/core/src/services/PlanRepair.ts) (parsing + repair),
[`OpenAiService.ts`](../packages/core/src/services/OpenAiService.ts) /
[`GeminiService.ts`](../packages/core/src/services/GeminiService.ts) (provider-agnostic planning +
review), and the `TaskOrchestrator` (per-task dispatch and the dependency-aware schedule).*
