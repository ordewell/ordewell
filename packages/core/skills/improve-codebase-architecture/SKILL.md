---
name: improve-codebase-architecture
description: Scan the codebase for deepening opportunities, prioritize them, then turn as many as the user wants into ordered plan tasks.
disable-model-invocation: true
---

Surface architectural friction and propose **deepening opportunities**: refactors that turn shallow modules into deep ones, aimed at testability and AI-navigability. This skill never edits code itself — it never could, the planner is read-only — so the outcome is plan tasks, not a live refactor. Each candidate the user picks becomes one task for a runner to execute later, out of this conversation's sight.

## Vocabulary

- **Module / interface / depth** — a module is deep when its interface is much simpler than what it hides; shallow when the interface is nearly as complex as the implementation.
- **Seam** — a boundary a test double or adapter swap crosses. **Locality** — how close the code that causes a bug sits to the code that shows it; extracting a pure function for testability without moving where the real logic runs loses locality.
- **Leverage** — how much simpler calling code gets once a module is deepened.
- **Deletion test** — would deleting this module concentrate complexity elsewhere (worth deepening), or just move it (not worth it)?

If the project keeps its own domain glossary (a `CONTEXT.md` or similar) or an ADR log (`docs/adr/` or similar), use its terms in place of these where they overlap, and read the ADRs that touch the area you're exploring before proposing anything that contradicts one.

## Process

### 1. Explore

Scope before you scan — put weight on what changes often, not everywhere:

- User named a direction (a module, a subsystem, a pain point)? Take it, skip the inference below.
- Otherwise walk `git log --oneline` for hot spots and let those pull your attention first. Scattered history with no clear hot spot → widen the net.

Explore read-only, delegating to a research subagent where one is available to you instead of reading everything inline. Don't follow rigid heuristics; explore organically and note where you experience friction — where understanding one concept means bouncing between many small modules, where an interface is nearly as complex as its implementation, where a pure function was extracted for testability but the real bug lives in how it's called, where modules leak across their seam, what's untested or hard to test through its current interface. Apply the deletion test to anything you suspect is shallow.

### 2. Present candidates, prioritized

List every candidate directly in the conversation — no report file; nothing in this step touches disk. For each:

- **Title** — names the deepening (e.g. "Collapse the Order intake pipeline")
- **Files**
- **Problem** / **Solution** — one sentence each, in the project's own vocabulary where it has one
- **Benefits** — explained in terms of locality and leverage, and how tests would improve; this is what the recommendation strength below has to be earned by, not asserted
- **Recommendation**: `Strong`, `Worth exploring`, or `Speculative`
- **Overlaps** — which other candidates touch the same files; this drives task ordering in step 4
- If it contradicts an existing ADR, a one-line callout naming it (e.g. _"contradicts ADR-0007, but worth reopening because…"_) — only when the friction is real enough to warrant reopening the decision, not for every refactor an ADR happens to forbid

Order the list `Strong` → `Worth exploring` → `Speculative`, and close with which one you'd tackle first and why. Do not propose interfaces yet.

Ask: **how many of these should become tasks?** Default, unless told otherwise: every `Strong` candidate, none of the rest. The user may instead name specific candidates, a count ("top 3"), or "all" — whatever they say overrides the default.

### 3. Resolve open questions per selected candidate

For each candidate going into the plan, settle whatever a runner would otherwise have to guess: the target seam, what sits behind it, what's explicitly out of scope, which tests survive. Interview only where the answer is genuinely unclear for that candidate — number the open questions, give your recommended answer, wait for the user before the next round. Don't grill a candidate that's already unambiguous.

If the user rejects a candidate with a load-bearing reason ("not now, that would break the plugin API"), offer: _"Want a one-line ADR task recording this, so a future run of this skill doesn't re-suggest it?"_ Only offer when the reason would actually be needed by a future run to avoid re-suggesting the same thing; skip ephemeral reasons ("not worth it right now") and self-evident ones.

### 4. Convert to tasks

One task per selected candidate, unless a candidate is large enough that a runner would reasonably split it into a short dependent sequence itself — say so rather than forcing it into one prompt.

Write each task's prompt as self-contained: the runner executing it won't see this conversation. Include the problem, the solution, the files/seam involved, what "done" looks like, and — if the project keeps a glossary or ADR log — an instruction to update it when the task introduces or sharpens a term.

Order tasks `Strong` → `Worth exploring` → `Speculative`. Two selected candidates that touch overlapping files must not run concurrently: make the later one depend on the earlier one even when nothing else connects them, since two runners editing the same file in parallel is a conflict, not a coincidence.

Propose the task outline in prose and get the user's confirmation — the same convergence point any planning conversation reaches. Do not emit the task plan JSON until they've confirmed it.
