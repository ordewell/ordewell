# Architecture decision records

These record how Ordewell is built and why, including the options that were
rejected. Read the ones that touch what you're changing; the index at the bottom
groups them by area. [CONTEXT.md](../../CONTEXT.md) defines the vocabulary they
are written in.

An ADR here is a **living document**: it reads as what is true now, not as a log
of edits. When a decision changes, the ADR is rewritten once the change is
implemented and gets one dated line in its History. It never grows an Update or
Amendment section. [AGENTS.md](../../AGENTS.md) has the conventions that apply to
all work in this repository.

**Recording a decision?** Go in this order: [Should this be an
ADR?](#should-this-be-an-adr), [Where it goes](#where-it-goes), [Writing
one](#writing-one), [Changing an existing one](#changing-an-existing-one),
[Checks](#checks). Most changes are not new ADRs.

## Should this be an ADR?

First find out what is already decided. Grep `docs/adr` for the module, type,
setting or command you are changing (`grep -rln PlannerConversation docs/adr`)
and scan the titles in the index below. If an ADR owns the area, the question is
usually which part of it changes, not whether to write a new one.

Write a new one only when **all three** are true (the test Matt Pocock's skills
use, which this project follows):

1. **Hard to reverse.** Changing your mind later costs something real: a
   persisted shape, a public command, setting or flag, the protocol between
   Ordewell and a runner, a trust boundary, where a module seam sits.
2. **Surprising without context.** A later reader, human or agent, would look at
   the code and ask why it is this way, or would "fix" it.
3. **A real trade-off.** There were credible alternatives and this one was
   picked for stated reasons. The rejected options are the most useful part of
   an ADR; if you cannot name one, there is nothing to record.

If one is missing, skip the ADR: an easy decision will just be reversed, an
unsurprising one needs no explanation, and a decision with no alternative is
"we did the obvious thing".

**What usually qualifies**

- A rule about what counts as evidence, what the plan is the source of, or who
  decides (the conventions in [AGENTS.md](../../AGENTS.md#conventions)).
- Anything that widens or narrows a security boundary. The planner's
  exploration envelope ([ADR-0008](planner-envelope/0008-planner-exploration-envelope.md))
  may not be widened without one.
- How Ordewell drives a runner or hands it tools, and what a runner may do.
- What is persisted, where a setting lives and what survives a restart.
- A deliberate "no": something a reasonable contributor would add, and why it
  was left out.
- A constraint the code cannot show: a limit of a runner's CLI the design works
  around, a platform quirk.

**What does not**

- A bug fix, or a refactor that keeps the design. The commit message and a
  comment that says *why* are the record.
- A tuning value, a timeout, a label, layout or copy. An ADR that quotes one is
  edited in place so the quote stays true, with no History line unless the
  behaviour changed.
- A command, setting or tool that follows a decision already recorded. Rewrite
  the part of that ADR it changes and add a History line.
- A term or its meaning: that is [CONTEXT.md](../../CONTEXT.md). How a user does
  something: that is `docs/`. What shipped: that is `CHANGELOG.md`.
- A plan, a to-do list or "how we will build this". Ordewell splits work into
  tasks; an ADR records the decision that shaped the work, not the steps.

| The change | Where it goes |
|---|---|
| A failed task blocks only its dependents, where the run used to halt | A new ADR ([0034](supervision/0034-a-failed-task-blocks-only-its-dependents.md)): it decides what a failure stops, and storing a `blocked` status was rejected. |
| `skip_task` joins the planner's execution tools | No new ADR: a History line in [0029](supervision/0029-the-supervisor.md), [0022](runners/0022-ordewell-mcp-server.md) and [0009](planner/0009-coding-agents-as-planners.md). |
| The TUI status row speaks only for the chat on screen | No new ADR: [0030](supervision/0030-global-run-settings.md)'s "Seeing them" is rewritten and gets a History line. |

Unsure? Prefer, in this order: rewriting the ADR that owns the area with a
History line, a code comment that says why, a new ADR. A one-paragraph ADR that
passes the test is better than a long one that does not.

## Where it goes

`docs/adr/<folder>/NNNN-slug.md`.

- **Number.** `node scripts/verify-adr.mjs --next` prints the next free one.
  Numbers are global and permanent: never reused, never renumbered, and not tied
  to the folder, so a citation such as `ADR-0018` in a source comment stays valid
  when a document moves or is folded into another.
- **Slug.** Lower-case words joined by hyphens that state the decision
  (`a-failed-task-blocks-only-its-dependents`), not the topic (`task-failures`).
- **Folder.** The one whose line in the index below covers the decision. If two
  fit, take the one whose invariant the decision defines: what a planner may
  touch is `planner-envelope` even when a runner is involved. If you still
  cannot choose, take the folder of the ADR you would amend or cite most, and
  link the other. A folder is added by editing `FOLDERS` in
  `scripts/verify-adr.mjs` (the check and the index are generated from it), not
  by creating a directory.

## Writing one

Start from the template. Only Problem and Decision are required and the sections
that are there must come in this order, but an ADR that passes the test above has
at least one rejected option, so Considered options is nearly always there.

```markdown
---
status: accepted          # proposed | accepted | superseded
implemented: partial      # full (leave the line out) | partial | none
amends: ["0013"]          # ADRs whose decision this one changes
note: "One line, only for what the fields above cannot say."
---

# NNNN — A title that states the decision

*Pending:* [ADR-NNNN](../folder/NNNN-slug.md) — what it will change here.

## Problem
What is wrong or undecided, and what prompted it, in CONTEXT.md's words.

## Decision
**The decision, in one bold sentence.** Then the detail, in the present tense, as
if it had always been the design.

## Key properties
- **A rule others cite (K1).** What it requires, and why.

## A topic section
Design detail too long for a bullet: a protocol, a state machine, a table. Any
number of these, between Key properties and Testing decisions.

## Testing decisions
The seams tests use, the prior art to copy, what a good test is here.

## Out of scope
What the decision deliberately leaves for later.

## Considered options
- **An alternative.** Rejected: why.

## Consequences
- What gets easier, what gets harder, what to watch.

## History
- YYYY-MM-DD — accepted.
```

The `*Pending:*` line goes only on an ADR that another, not yet implemented ADR
will change; drop it from a new ADR. `amended by` is never written down: the
index below computes it from the other ADRs' `amends`.

**Front matter.** `status` is `proposed` when you are recording a decision the
maintainer has not made yet, and `accepted` once it is made, which includes a
change they asked for and review in the same pull request. `implemented` is
`partial` or `none` for an accepted decision that is not fully built; say what it
waits on in `note` (`implemented: none`, `note: "sealed runs need #64 first"`).
`superseded` marks an ADR replaced as a whole whose file is kept, which is rare
because the replacement normally folds it (see below). `amends` and `supersedes`
list four-digit numbers as strings.

**Sections.**

- *Decision* states the decision as fact: no "we considered", no dates, no "now"
  or "no longer". The reasoning that was cut goes to Considered options.
- *Considered options* keeps an option that was once chosen and later dropped
  ("The design until 2026-10-14"), with why it went. Record the alternatives that
  were actually weighed and the reasons actually given; do not invent options to
  fill the section.
- *Testing decisions* names seams and prior art, not a list of test files.
- *History* has one dated line per change and restates nothing. Use the date the
  change was made.

**Style.**

- Use the terms in [CONTEXT.md](../../CONTEXT.md) (grep it; it is long); its
  *avoid* lists name the synonyms that blur a distinction the project keeps. A
  term the ADR introduces
  goes there in the change that implements it, since CONTEXT.md describes what
  is.
- Name code by module, type or function (`blockingFailures`), with a path only
  when it is hard to find. Do not cite line numbers; they rot.
- No quantified performance or cost claims ([AGENTS.md](../../AGENTS.md)). A fact
  about an external tool is fine when it carries the version it was checked
  against.
- Keep it short enough to read in one pass. Past about 35 KB it is probably two
  decisions.
- Wrap prose at about 80 columns. Link an ADR with its relative path on first
  mention in a section (`[ADR-0029](../supervision/0029-the-supervisor.md)`) and
  write `ADR-0029` after that.

**In order.**

1. Decide it qualifies. If it changes a decision an ADR already records, edit
   that ADR instead (next section).
2. Take the next number, pick the folder and create the file from the template.
3. If it changes another ADR, list that ADR in `amends`, and add a *Pending* line
   under the title of each ADR whose text states the rule you are changing, until
   this one is implemented.
4. Write it. History starts with today's date and `accepted` (`proposed` if
   that is its status). Check each fact you state (names, defaults, paths,
   limits) against the code, and do not state a guess as fact: say in your message
   to the maintainer what you inferred. If the request misdescribes what the code
   does, say so there and record what is true.
5. Label a rule `(K1)` only once code or another ADR cites it (see Rule IDs).
6. Cite the ADR in a comment where the code embodies it, saying why:
   `// … (ADR-0018)`. The check fails a citation that does not resolve.
7. Run `node scripts/verify-adr.mjs --write`, then `node scripts/verify-adr.mjs`
   must end with 0 failures.
8. Commit it with the code that implements it. A decision recorded ahead of its
   code is `implemented: none`.

## Changing an existing one

- **Rewrite in place,** in the same change as the code that makes it true.
  Change the part that is no longer true so the ADR reads as what is true now. An
  option that was chosen and is now dropped moves to Considered options with why.
  Add one dated History line. Do not add an Update or Amendment section or an
  "*Amended…*" paragraph; the check warns about them.
- **A small change is not a new ADR.** A corrected detail, a new case under an
  existing rule or a renamed control is a rewrite and a History line in the ADR
  that owns the area. A change that is a decision in its own right (it passes the
  test above) gets its own ADR with `amends`.
- **Decided but not built yet.** The body keeps saying what is true now, and one
  *Pending* line under the title says what will change. For a change that has its
  own ADR the line names that ADR; for a small change it says what will change and
  what it waits on (an issue number). A Pending line names no ADR except the one
  that will change this one: the check reads every ADR number in it that way, and
  fails one that names a fully implemented ADR, or the ADR itself. When the code
  lands, rewrite the body, add the History line and delete the Pending line.
- **Never renumber or delete a number.** A folded ADR keeps its number in the
  host's `folds`.

### Folding one ADR into another

An ADR may be folded into the one it amends when all of these hold:

- it is implemented, and no *Pending* line in another ADR names it;
- it is fully overtaken or about 8 KB or smaller;
- it defines no rule IDs that code or other docs cite;
- the host stays under about 35 KB, since an agent has to read the whole host
  before changing the code it describes.

Merge section by section (its Problem into the host's Problem, and so on), keep
every rule ID and rejected option that still applies, list
`folds: ["0031 — Its title"]` in the host's front matter so the old number still
resolves, and retarget the links. A design that was fully superseded may be
summarized as a Considered option instead of copied, with its full text left in
git history; any rule of it that other docs still rely on moves to the host under
a new ID. Anything else stays a separate ADR, however closely related.

## Rule IDs

Label a rule `(K1)` in its bold lead (`- **Talking to a task (M1).**`) once code
or another ADR cites it, and cite it with the ADR number: `ADR-0018 M1`. IDs are
namespaced by ADR, so two ADRs may both have an `S1`, and they are never reused
or renumbered. A citation of an ID the ADR does not define fails the check.

## Checks

`node scripts/verify-adr.mjs` runs in CI with the other `scripts/verify-*.mjs`.
It fails when an `ADR-NNNN` mention or a rule citation anywhere in the repository
does not resolve, when a link into or out of this folder is broken, when an ADR
is outside a known folder or has bad front matter or out-of-order sections or an
Update or Amendment section, when a *Pending* line names an ADR that is fully
implemented, and when the index below is stale (`--write` regenerates it). It only warns about an inline `*Amended…*`
marker; `--strict` makes that a failure too.

<!-- adr-index:start (generated by scripts/verify-adr.mjs --write; do not edit by hand) -->

### planner/

The planner conversation, its harness backends, its research and its skills.

| ADR | Title | Status | Amends | Amended by |
|---|---|---|---|---|
| [0002](planner/0002-planner-as-conversation-loop.md) | Planner as a conversation loop (messages only) | accepted | — | — |
| [0005](planner/0005-parallel-research-subagents.md) | Parallel read-only research subagents for the planner | accepted | — | — |
| [0009](planner/0009-coding-agents-as-planners.md) | Coding agents as planners: the harness planner backend | accepted | — | [0026](planner-envelope/0026-one-envelope-for-every-planner.md), [0029](supervision/0029-the-supervisor.md), [0033](planner-envelope/0033-codex-planner-without-its-sandbox.md), [0035](supervision/0035-effects-are-consented-and-recorded.md), [0037](supervision/0037-research-tasks-wake-the-planner.md), [0038](routing/0038-runner-install-verdicts-expire.md), [0040](routing/0040-a-slow-model-discovery-never-gates-the-planner-pick.md), [0052](routing/0052-a-signed-out-coding-agent-is-flagged-and-signs-in-from-the-chat.md), [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) |
| [0012](planner/0012-the-task-query-read-channel.md) | The task-query read channel: reading a task before rewriting it | accepted | — | [0057](supervision/0057-information-moves-by-reference.md) |
| [0024](planner/0024-unified-skills.md) | Unified skills: one format, one loader, two audiences | accepted | — | — |
| [0044](planner/0044-the-planners-usage-limit-waits-and-resends.md) | A planner's usage limit waits and resends, and a limit counts only in a turn Ordewell started | accepted | [0018](runners/0018-structured-runner-transport.md), [0029](supervision/0029-the-supervisor.md) | — |

### planner-envelope/

What the planner may run, read and reach, and the sandbox under it.

| ADR | Title | Status | Amends | Amended by |
|---|---|---|---|---|
| [0008](planner-envelope/0008-planner-exploration-envelope.md) | The planner's exploration envelope: tiered commands, confined paths, one approval seam | accepted | — | [0026](planner-envelope/0026-one-envelope-for-every-planner.md), [0027](planner-envelope/0027-web-reads-in-the-planner-envelope.md), [0028](planner-envelope/0028-planners-never-run-repository-config.md), [0032](planner-envelope/0032-runner-state-outside-the-workspace.md), [0035](supervision/0035-effects-are-consented-and-recorded.md), [0036](planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md), [0056](supervision/0056-a-mandate-narrows-down-the-tree.md) |
| [0011](planner-envelope/0011-sandboxing-the-planners-shell.md) | Sandboxing the planner's shell | accepted | — | [0027](planner-envelope/0027-web-reads-in-the-planner-envelope.md), [0033](planner-envelope/0033-codex-planner-without-its-sandbox.md), [0036](planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md) |
| [0026](planner-envelope/0026-one-envelope-for-every-planner.md) | One envelope for every planner | accepted | [0008](planner-envelope/0008-planner-exploration-envelope.md), [0009](planner/0009-coding-agents-as-planners.md) | [0027](planner-envelope/0027-web-reads-in-the-planner-envelope.md), [0028](planner-envelope/0028-planners-never-run-repository-config.md), [0032](planner-envelope/0032-runner-state-outside-the-workspace.md), [0033](planner-envelope/0033-codex-planner-without-its-sandbox.md), [0035](supervision/0035-effects-are-consented-and-recorded.md), [0036](planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md) |
| [0027](planner-envelope/0027-web-reads-in-the-planner-envelope.md) | Web reads in the planner envelope | accepted | [0008](planner-envelope/0008-planner-exploration-envelope.md), [0011](planner-envelope/0011-sandboxing-the-planners-shell.md), [0026](planner-envelope/0026-one-envelope-for-every-planner.md) | [0028](planner-envelope/0028-planners-never-run-repository-config.md), [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md) |
| [0028](planner-envelope/0028-planners-never-run-repository-config.md) | Planners never run the repository's config | accepted | [0008](planner-envelope/0008-planner-exploration-envelope.md), [0026](planner-envelope/0026-one-envelope-for-every-planner.md), [0027](planner-envelope/0027-web-reads-in-the-planner-envelope.md) | [0032](planner-envelope/0032-runner-state-outside-the-workspace.md), [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md) |
| [0032](planner-envelope/0032-runner-state-outside-the-workspace.md) | Runner state outside the workspace | accepted | [0008](planner-envelope/0008-planner-exploration-envelope.md), [0026](planner-envelope/0026-one-envelope-for-every-planner.md), [0028](planner-envelope/0028-planners-never-run-repository-config.md) | — |
| [0033](planner-envelope/0033-codex-planner-without-its-sandbox.md) | A Codex planner without its sandbox | accepted | [0009](planner/0009-coding-agents-as-planners.md), [0011](planner-envelope/0011-sandboxing-the-planners-shell.md), [0026](planner-envelope/0026-one-envelope-for-every-planner.md) | [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md) |
| [0036](planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md) | The planner's shell: sealed runs instead of refusals, and the harness's own shell as an opt-in | accepted | [0008](planner-envelope/0008-planner-exploration-envelope.md), [0011](planner-envelope/0011-sandboxing-the-planners-shell.md), [0026](planner-envelope/0026-one-envelope-for-every-planner.md) | [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md), [0056](supervision/0056-a-mandate-narrows-down-the-tree.md), [0059](isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md) |
| [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md) | A read-only task is Ordewell's: its runner's reads, a sealed shell, and nothing lands | accepted | [0001](routing/0001-autonomous-mode-resolution.md), [0013](isolation/0013-worktree-isolation.md), [0022](runners/0022-ordewell-mcp-server.md), [0027](planner-envelope/0027-web-reads-in-the-planner-envelope.md), [0028](planner-envelope/0028-planners-never-run-repository-config.md), [0033](planner-envelope/0033-codex-planner-without-its-sandbox.md), [0036](planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md), [0037](supervision/0037-research-tasks-wake-the-planner.md) | [0050](planner-envelope/0050-a-read-only-task-can-hand-off-its-prototype-as-a-patch.md), [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) |
| [0050](planner-envelope/0050-a-read-only-task-can-hand-off-its-prototype-as-a-patch.md) | A read-only task can hand off its prototype as a patch | accepted | [0022](runners/0022-ordewell-mcp-server.md), [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md), [0047](supervision/0047-structured-task-handoffs.md) | — |

### routing/

Modes, models and runner discovery.

| ADR | Title | Status | Amends | Amended by |
|---|---|---|---|---|
| [0001](routing/0001-autonomous-mode-resolution.md) | Autonomous mode resolution: the level picks the mode, the planner says only read-only | accepted | — | [0030](supervision/0030-global-run-settings.md), [0041](routing/0041-a-tasks-model-follows-the-runners-own-switch.md), [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md), [0056](supervision/0056-a-mandate-narrows-down-the-tree.md) |
| [0003](routing/0003-per-runner-model-allowlist.md) | Per-runner model allowlist for the planner | accepted | — | [0041](routing/0041-a-tasks-model-follows-the-runners-own-switch.md), [0043](routing/0043-a-change-of-scope-reaches-the-planner-and-flags-tasks.md) |
| [0004](routing/0004-codex-builtin-runner-discovery.md) | Codex as a built-in runner; model discovery via `codex app-server` | accepted | — | — |
| [0038](routing/0038-runner-install-verdicts-expire.md) | A runner install verdict is not permanent, and a refresh derives the detected planner again | accepted | [0009](planner/0009-coding-agents-as-planners.md) | — |
| [0040](routing/0040-a-slow-model-discovery-never-gates-the-planner-pick.md) | A slow model discovery never gates the planner pick | accepted | [0009](planner/0009-coding-agents-as-planners.md) | — |
| [0041](routing/0041-a-tasks-model-follows-the-runners-own-switch.md) | A task's model follows the runner's own switch | accepted | [0001](routing/0001-autonomous-mode-resolution.md), [0003](routing/0003-per-runner-model-allowlist.md), [0018](runners/0018-structured-runner-transport.md) | — |
| [0043](routing/0043-a-change-of-scope-reaches-the-planner-and-flags-tasks.md) | A change of scope reaches the planner and flags tasks, and the enabled runners have one store | accepted | [0003](routing/0003-per-runner-model-allowlist.md), [0022](runners/0022-ordewell-mcp-server.md) | — |
| [0052](routing/0052-a-signed-out-coding-agent-is-flagged-and-signs-in-from-the-chat.md) | A signed-out coding agent is flagged before it plans and signs in from the chat | accepted | [0009](planner/0009-coding-agents-as-planners.md) | — |

### runners/

How runners are driven, messaged and given Ordewell tools.

| ADR | Title | Status | Amends | Amended by |
|---|---|---|---|---|
| [0018](runners/0018-structured-runner-transport.md) | Structured runner transport: drive task runners through their programmatic protocol | accepted | — | [0023](runners/0023-messages-reach-a-running-task.md), [0041](routing/0041-a-tasks-model-follows-the-runners-own-switch.md), [0044](planner/0044-the-planners-usage-limit-waits-and-resends.md), [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) |
| [0022](runners/0022-ordewell-mcp-server.md) | The Ordewell MCP server: task and planner tools behind per-caller tokens | accepted | — | [0029](supervision/0029-the-supervisor.md), [0035](supervision/0035-effects-are-consented-and-recorded.md), [0043](routing/0043-a-change-of-scope-reaches-the-planner-and-flags-tasks.md), [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md), [0047](supervision/0047-structured-task-handoffs.md), [0050](planner-envelope/0050-a-read-only-task-can-hand-off-its-prototype-as-a-patch.md), [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md), [0056](supervision/0056-a-mandate-narrows-down-the-tree.md), [0057](supervision/0057-information-moves-by-reference.md), [0059](isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md) |
| [0023](runners/0023-messages-reach-a-running-task.md) | Messages reach a running task between tool calls | accepted | [0018](runners/0018-structured-runner-transport.md) | — |
| [0025](runners/0025-structured-only-runners.md) | Structured-only runners | accepted | supersedes [0007](runners/0025-structured-only-runners.md) | — |

### isolation/

Worktrees, repo groups, conflicts, ops tasks and merge gates.

| ADR | Title | Status | Amends | Amended by |
|---|---|---|---|---|
| [0013](isolation/0013-worktree-isolation.md) | Worktree isolation: one checkout per task, one branch per run | accepted | — | [0014](isolation/0014-multi-repo-workspaces.md), [0015](isolation/0015-conflict-repair.md), [0020](isolation/0020-ops-tasks-and-merge-gates.md), [0029](supervision/0029-the-supervisor.md), [0030](supervision/0030-global-run-settings.md), [0034](supervision/0034-a-failed-task-blocks-only-its-dependents.md), [0042](isolation/0042-merge-all-lands-only-on-the-branch-the-run-started-on.md), [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md), [0049](isolation/0049-a-session-has-one-live-host.md), [0054](isolation/0054-a-landed-task-reverts-on-the-integration-branch-before-merge-all.md), [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md), [0057](supervision/0057-information-moves-by-reference.md), [0059](isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md) |
| [0014](isolation/0014-multi-repo-workspaces.md) | Multi-repo workspaces: isolate a repo group, land it atomically | accepted | [0013](isolation/0013-worktree-isolation.md) | [0020](isolation/0020-ops-tasks-and-merge-gates.md), [0042](isolation/0042-merge-all-lands-only-on-the-branch-the-run-started-on.md) |
| [0015](isolation/0015-conflict-repair.md) | Conflict repair: the task repairs its own conflict, bounded and evidenced | accepted | [0013](isolation/0013-worktree-isolation.md) | [0034](supervision/0034-a-failed-task-blocks-only-its-dependents.md), [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) |
| [0020](isolation/0020-ops-tasks-and-merge-gates.md) | Ops tasks run in the workspace, behind a merge gate | accepted | [0013](isolation/0013-worktree-isolation.md), [0014](isolation/0014-multi-repo-workspaces.md) | [0029](supervision/0029-the-supervisor.md), [0030](supervision/0030-global-run-settings.md), [0035](supervision/0035-effects-are-consented-and-recorded.md), [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) |
| [0042](isolation/0042-merge-all-lands-only-on-the-branch-the-run-started-on.md) | Merge all lands only on the branch the run started on | accepted | [0013](isolation/0013-worktree-isolation.md), [0014](isolation/0014-multi-repo-workspaces.md) | — |
| [0049](isolation/0049-a-session-has-one-live-host.md) | A session has one live host: the session lease | accepted | [0013](isolation/0013-worktree-isolation.md) | [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) |
| [0054](isolation/0054-a-landed-task-reverts-on-the-integration-branch-before-merge-all.md) | A landed task reverts on the integration branch, before Merge all | accepted | [0013](isolation/0013-worktree-isolation.md) | [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) |
| [0059](isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md) | An execution lease reserves in the claim, opens after it, and proves what it guarantees | accepted, not yet implemented | [0013](isolation/0013-worktree-isolation.md), [0022](runners/0022-ordewell-mcp-server.md), [0036](planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md) | — |

### supervision/

The supervisor, run settings, failure policy, consent and research tasks.

| ADR | Title | Status | Amends | Amended by |
|---|---|---|---|---|
| [0029](supervision/0029-the-supervisor.md) | The supervisor: levels, live planner turns, execution tools and auto-merge | accepted | [0009](planner/0009-coding-agents-as-planners.md), [0013](isolation/0013-worktree-isolation.md), [0020](isolation/0020-ops-tasks-and-merge-gates.md), [0022](runners/0022-ordewell-mcp-server.md) | [0030](supervision/0030-global-run-settings.md), [0034](supervision/0034-a-failed-task-blocks-only-its-dependents.md), [0035](supervision/0035-effects-are-consented-and-recorded.md), [0037](supervision/0037-research-tasks-wake-the-planner.md), [0044](planner/0044-the-planners-usage-limit-waits-and-resends.md), [0045](supervision/0045-a-check-repeats-with-its-fix-until-it-passes.md), [0047](supervision/0047-structured-task-handoffs.md), [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md), [0056](supervision/0056-a-mandate-narrows-down-the-tree.md), [0057](supervision/0057-information-moves-by-reference.md) |
| [0030](supervision/0030-global-run-settings.md) | Run settings are saved once and live per session; autorun | accepted | [0001](routing/0001-autonomous-mode-resolution.md), [0013](isolation/0013-worktree-isolation.md), [0020](isolation/0020-ops-tasks-and-merge-gates.md), [0029](supervision/0029-the-supervisor.md) | [0035](supervision/0035-effects-are-consented-and-recorded.md), [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md), [0056](supervision/0056-a-mandate-narrows-down-the-tree.md) |
| [0034](supervision/0034-a-failed-task-blocks-only-its-dependents.md) | A failed task blocks only its dependents | accepted | [0013](isolation/0013-worktree-isolation.md), [0015](isolation/0015-conflict-repair.md), [0029](supervision/0029-the-supervisor.md) | [0045](supervision/0045-a-check-repeats-with-its-fix-until-it-passes.md) |
| [0035](supervision/0035-effects-are-consented-and-recorded.md) | Every effect is consented to and recorded, whoever performs it | accepted | [0008](planner-envelope/0008-planner-exploration-envelope.md), [0009](planner/0009-coding-agents-as-planners.md), [0020](isolation/0020-ops-tasks-and-merge-gates.md), [0022](runners/0022-ordewell-mcp-server.md), [0026](planner-envelope/0026-one-envelope-for-every-planner.md), [0029](supervision/0029-the-supervisor.md), [0030](supervision/0030-global-run-settings.md) | [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md), [0056](supervision/0056-a-mandate-narrows-down-the-tree.md) |
| [0037](supervision/0037-research-tasks-wake-the-planner.md) | Evidence the planner decides on is a research task, and its report wakes the planner | accepted | [0009](planner/0009-coding-agents-as-planners.md), [0029](supervision/0029-the-supervisor.md) | [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md), [0047](supervision/0047-structured-task-handoffs.md), [0056](supervision/0056-a-mandate-narrows-down-the-tree.md) |
| [0045](supervision/0045-a-check-repeats-with-its-fix-until-it-passes.md) | A check repeats with its fix until it passes | accepted | [0029](supervision/0029-the-supervisor.md), [0034](supervision/0034-a-failed-task-blocks-only-its-dependents.md) | [0047](supervision/0047-structured-task-handoffs.md), [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) |
| [0047](supervision/0047-structured-task-handoffs.md) | Every task ends with a handoff: a short summary, atomic findings and a way to pull the rest | accepted | [0022](runners/0022-ordewell-mcp-server.md), [0029](supervision/0029-the-supervisor.md), [0037](supervision/0037-research-tasks-wake-the-planner.md), [0045](supervision/0045-a-check-repeats-with-its-fix-until-it-passes.md) | [0050](planner-envelope/0050-a-read-only-task-can-hand-off-its-prototype-as-a-patch.md), [0057](supervision/0057-information-moves-by-reference.md) |
| [0053](supervision/0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md) | What waits on a person is derived, listed once and answered in one call | accepted | — | [0056](supervision/0056-a-mandate-narrows-down-the-tree.md) |
| [0055](supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) | A delegated task is a child plan behind the runner seam | accepted, not yet implemented | [0009](planner/0009-coding-agents-as-planners.md), [0013](isolation/0013-worktree-isolation.md), [0015](isolation/0015-conflict-repair.md), [0018](runners/0018-structured-runner-transport.md), [0020](isolation/0020-ops-tasks-and-merge-gates.md), [0022](runners/0022-ordewell-mcp-server.md), [0029](supervision/0029-the-supervisor.md), [0030](supervision/0030-global-run-settings.md), [0035](supervision/0035-effects-are-consented-and-recorded.md), [0045](supervision/0045-a-check-repeats-with-its-fix-until-it-passes.md), [0046](planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md), [0049](isolation/0049-a-session-has-one-live-host.md), [0054](isolation/0054-a-landed-task-reverts-on-the-integration-branch-before-merge-all.md) | — |
| [0056](supervision/0056-a-mandate-narrows-down-the-tree.md) | A mandate says what a node may do without a person, and what it can hand on only narrows down the tree | accepted, not yet implemented | [0001](routing/0001-autonomous-mode-resolution.md), [0008](planner-envelope/0008-planner-exploration-envelope.md), [0022](runners/0022-ordewell-mcp-server.md), [0029](supervision/0029-the-supervisor.md), [0030](supervision/0030-global-run-settings.md), [0035](supervision/0035-effects-are-consented-and-recorded.md), [0036](planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md), [0037](supervision/0037-research-tasks-wake-the-planner.md), [0053](supervision/0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md) | — |
| [0057](supervision/0057-information-moves-by-reference.md) | Information moves by reference: reports stay one size at every level, and code decides when a planner wakes | accepted, partly implemented | [0012](planner/0012-the-task-query-read-channel.md), [0013](isolation/0013-worktree-isolation.md), [0022](runners/0022-ordewell-mcp-server.md), [0029](supervision/0029-the-supervisor.md), [0047](supervision/0047-structured-task-handoffs.md) | — |
| [0058](supervision/0058-a-tree-holds-many-nodes-and-few-live-sessions.md) | A tree holds many nodes and few live sessions | accepted, not yet implemented | — | — |

### surfaces/

The TUI and the shared conversation view.

| ADR | Title | Status | Amends | Amended by |
|---|---|---|---|---|
| [0006](surfaces/0006-tui-pure-core-thin-driver.md) | Terminal UI as a pure core behind a thin driver | accepted | — | — |
| [0017](surfaces/0017-shared-conversation-view.md) | The shared conversation view, drawn once in core | accepted | — | — |

### platform/

Windows, the per-workspace environment and what Ordewell sends from the machine.

| ADR | Title | Status | Amends | Amended by |
|---|---|---|---|---|
| [0010](platform/0010-windows-support.md) | Windows support: one launch seam, one shell seam, one dialect | accepted | — | — |
| [0016](platform/0016-per-workspace-environment.md) | Per-workspace environment for the planner and agents | accepted | — | — |
| [0048](platform/0048-a-daily-version-check-with-a-notice-first-and-one-install-per-machine.md) | A daily version check, with a notice first and one install per machine | accepted | — | — |
| [0051](platform/0051-opencode-go-limits-from-the-selected-login-read-in-place.md) | OpenCode Go limits come from the selected login, read in place | accepted | — | — |

### Retired numbers

Folded into another ADR. The number still resolves, and code that cites it stays valid.

| ADR | Was | Now in |
|---|---|---|
| 0007 | Runners execute inside tmux, terminals open on demand | [0025](runners/0025-structured-only-runners.md) |
| 0019 | Nested repositories are shared live, not refused | [0014](isolation/0014-multi-repo-workspaces.md) |
| 0021 | Unedited built-in skill seeds refresh with the package | [0024](planner/0024-unified-skills.md) |
| 0031 | The planner says read-only, not a mode | [0001](routing/0001-autonomous-mode-resolution.md) |
| 0039 | The detected planner is derived again on a runner-list refresh | [0038](routing/0038-runner-install-verdicts-expire.md) |

<!-- adr-index:end -->
