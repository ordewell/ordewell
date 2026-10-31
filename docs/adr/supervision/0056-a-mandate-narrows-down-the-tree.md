---
status: accepted
implemented: partial
amends: ["0001", "0008", "0022", "0029", "0030", "0035", "0036", "0037", "0053"]
note: "Settles #23, #92 and #112 as far as subplanners need. Built: M1 to M4, the seam and the paths around it in M6. M5 and M7 to M10 wait on ADR-0055, as do `delegate` and a subplanner's harness subagents in M6. A flat run does not change."
---

# 0056 — A mandate says what a node may do without a person, and what it can hand on only narrows down the tree

## Problem

[ADR-0029](0029-the-supervisor.md) gave the supervisor three levels as "a slim
precursor of the mandate", and left grants, limits, inheritance and revocation to
#23. [ADR-0035](0035-effects-are-consented-and-recorded.md) said the mandate takes
over its consent table and the effect allowlist when it lands. #92 asks that
security settings only get stricter down the tree, and #112 that there be one kind
of node, told apart by roles and grants.

A delegated task ([ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md))
makes this necessary. A subplanner has no person at it. The consent rules are
written around one user behind every approval, one actor table, one global
autonomy level read live. And several starts and approvals never pass the seam
where a grant would be checked. The research's case against deep autonomy applies
in full: a node with a repository, untrusted reports and a network is not made safe
by its prompt.

## Decision

**A mandate is a typed object: what a node may do without a person, and within what
limits. The root's is derived from today's settings, so a flat run does not change.
A child's is one pure function of its parent's and its request, which can only
narrow what the parent may hand on. Authority stays at `consent()`, spending at the claim, and capability at the
boundary a session runs in. Deeper nodes decide how to work without asking, and hold
less authority over anything shared.**

ADR-0035's three questions stay apart. Capability is what a session can technically
do, and a mandate gives none: M9 says what it holds back. Authority is this ADR.
Judgment stays the planner's.

## Key properties

- **A typed object (M1).**

  ```ts
  type Grant = 'observe' | 'steer' | 'control' | 'replan' | 'approve'
             | 'delegate' | 'effect' | 'research' | 'merge';

  interface Mandate {
    grants: ReadonlySet<Grant>;      // what this node may do
    grantable: ReadonlySet<Grant>;   // what it may hand a child
    autonomy: 'full' | 'guarded';    // read in place of the global level
    limits: MandateLimits;           // M3
    exclusions: MandateExclusions;   // accumulate: protected paths
    effectRules: readonly EffectRules[]; // one per level, each with its own `!` rules (M4)
  }
  ```

  A child's is saved with its plan, as it was given. The root's is derived on each
  read by `rootMandate` and never saved. It reads each value where it lives today: the
  supervisor's level from the plan's `runSettings`, the run's own copy
  ([ADR-0030](0030-global-run-settings.md)), where a guard or a failure lowers it and
  the user's change lands, and the rest where they are read now. A saved mandate could
  only disagree with those: an Act that a guard lowered to Watch reads Watch at the
  next check, and a continued run keeps its level. What holds at a node is its saved
  mandate narrowed by every ancestor's as it stands now, its grants against each
  ancestor's `grantable`, read at each check, so a change at the root reaches the
  subtree at once (M10). That reading intersects and refuses nothing.
- **Grants (M2).** Each grant is a set of things a node may do unasked:

  | grant | what it allows |
  |---|---|
  | `observe` | being woken by attention events, and the reads of a wake-up turn |
  | `steer` | `message_task`, `answer_checkpoint`, `answer_approval` (deny or escalate, never allow) |
  | `control` | `run_plan`, `run_task`, `run_script`, `retry_task`, `stop_task`, `stop_run`, `skip_task` |
  | `replan` | `edit_plan` in a wake-up turn; a child's `submit_plan` for its own plan |
  | `approve` | what this node's planner writes is approved as it lands |
  | `delegate` | writing a delegated task |
  | `effect` | a script task that runs unsealed (M9) |
  | `research` | research tasks, and a harness's own subagents |
  | `merge` | merging its own subtree: `merge_all` and the automatic merges |

  `merge` at the root is the user's branch, as ever. Below the root it is the
  delegated task's branch, and merging into the user's branch is never grantable
  there: a child's checkout is not theirs (ADR-0055 D12).

  Today's settings map onto them:

  | setting | in the root's mandate |
  |---|---|
  | supervisor Off | `research` |
  | supervisor Watch | `observe`, `research` |
  | supervisor Act | `observe`, `steer`, `control`, `replan`, `research`, `merge` |
  | autorun | `approve`, read with `autonomy` as ADR-0030 reads the two together |
  | Full, Guarded | `autonomy` |
  | the effect allowlist | `effect`, its rules in `effectRules` |
  | delegation on (ADR-0055 D21) | `delegate`, the tree's token budget, and fills `grantable` |

  The mandate replaces `SUPERVISOR_LEVELS` at the seam, as ADR-0029 said it would.
  A turn the user opened keeps ADR-0029's table: the user is present, and a person
  needs no mandate.

  `grantable` is what keeps M4 and M7 both true. The default level is Watch, whose
  `control` is absent, and a subplanner is Act with autorun. So delegation on fills
  the root's `grantable` with `observe`, `steer`, `control`, `replan`, `approve`,
  `research`, `merge` and `delegate`, and `effect` while the root holds it, whatever
  the supervisor's level: the level says what the root planner does in its own wake-up
  turns, and the setting says what a subplanner may. `observe`, `steer`, `control`,
  `replan`, `approve` and `merge` are the floor: a mandate without one of them could
  not finish, so a child holds them without asking and `narrow` refuses a mandate that
  would lack one. So a child can hold a grant the root does not: what narrows is
  `grantable`, and turning delegation on is the user's consent to that. A delegated
  task's `grants` names what it asks for past the floor, and absent asks for nothing.
  `research`, `delegate` and `effect` are grantable only by name: a child holds one
  only where its delegated task's `grants` names it, so a subtree fans out, grows
  deeper, or reaches out, only where its parent wrote that down.
- **Limits (M3).**

  | limit | root | child |
  |---|---|---|
  | token budget | the tree's, from the delegation setting | carved (M5) |
  | wall-clock time | none | carved; a day when the task states none |
  | depth, delegated tasks per plan, tasks per plan | ADR-0055 D19 | the same or lower |
  | allowed runners and models | what `SessionCatalog` allows | a subset |

  Wall-clock time stops while the tree is held on a usage limit, up to that limit's
  reset: a resume waiting on a slot past it (ADR-0055 D18) is on the clock. When it
  runs out the node stops as a Stop does and ends `blocked`, so nothing waits for ever
  (M8).
- **Narrowing is one pure function (M4).** `narrow(parent, request)` returns a mandate
  or a refusal naming the level that refused, the field, what was asked and what is
  there. A mandate does not say where in the tree it stands, so the request names the
  level narrowing. `parent` carries what it has left in its limits, which the caller
  reads from the ledger (M5):

  | field | rule |
  |---|---|
  | `grants` | `(floor ∪ request) ∩ parent.grantable`, refused if that loses a floor grant |
  | `grantable` | the same set: a child hands on what it holds |
  | `autonomy` | the lower |
  | tokens, wall-clock time | carved from what the parent has left |
  | depth | the parent's less one, refused at 0 |
  | delegated tasks, tasks per plan | the lesser |
  | runners, models | intersect |
  | exclusions | accumulate |
  | `effectRules` | append: a command must match at every level, so no rule is widened by a wildcard, a `!` rule holds below its level, and no rules are intersected as text |

  The table is a `Record` over `keyof Mandate` and, for `limits`, `keyof MandateLimits`,
  so a new field or limit fails to compile until it has a rule, and a property test
  proves for each that no result is wider than its parent: `grants` and `grantable`
  against the parent's `grantable`, and every other field against the same field. It
  runs as a delegated task's fields are written (`PlanChangeCheck`, through its
  `PlanChangeScope`) and again in `ChildPlanRunner` as the child is built. Every
  refusal, at any check, names the level that refused.
- **Budgets are in tokens (M5).** Tokens work where dollars cannot: a subscription has
  no per-token price. Spend is what `UsageTotals` counts, input and output, cache
  reads included, the same number a surface shows. A long context is what burns them,
  and measured cost is mostly cache reads.
  - A delegated task must carry one. Each node keeps `limit`, `committed` (what its
    children hold), `spent` and `reserve`, with `spent + committed + reserve ≤ limit`.
  - Spend is checked in `claimRefusal`, the one point every attempt passes: `tick`,
    `startRound`, `resumeTask` and `startOwedRepairs` never reach the command seam. The
    seam may check early for a better refusal, and a subplanner's turn is checked as it
    starts.
  - Nothing can recall a request already sent, so overshoot is bounded instead. The
    reserve is an allowance per live session for what is in flight. A claim that would
    breach it is refused; when `spent` reaches `limit` the node stops
    (ADR-0055 D16) and ends `blocked`. A runner's own subagents add requests nobody
    sees until their usage arrives, so the reserve is an estimate and not a guarantee.
  - When a child ends, on confirmed close, what it did not spend returns to its parent,
    and goes no further: a sibling gets it only by its parent's next carve.
  - A child that needs more asks with a checkpoint. A raise is `answer_checkpoint` with
    `raiseTokens`, or the same on the inbox's Approve, carved at the call from what the
    parent has left, and recorded as a budget event ([ADR-0058](0058-a-tree-holds-many-nodes-and-few-live-sessions.md) S3)
    and in the timeline.
  - A subplanner's own turns come before what it carved. A node's room is `limit`
    less the other three. A carve or a raise takes only room, and a subplanner keeps
    one session's `reserve` for its next turn while it is parked ([ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) D18), so a carve of
    everything leaves it a turn to answer a `checkpoint` or call `task_complete`. That
    share is the turn's own allowance, not a second one. The turn spends it first,
    `reserve` falling as `spent` rises, so nothing carved or claimed meanwhile can take
    it. Past it the turn spends room, then its children's room, the child that woke it
    first: that child's `limit` and the parent's `committed` fall together, as a budget
    event. As it parks it keeps one session's `reserve` again, from the same two. So a
    child pays for answers its parent cannot, and only a raise needs the parent's own
    room. A turn starts only if that share, room and its children's room come to one
    session's `reserve`. One they cannot cover is not started: the node stops
    (ADR-0055 D16) and ends `blocked` with a derived report, as at its limit, since a
    node with no turn left cannot say so itself.
  - The root's budget bounds what is carved for delegated tasks, and only the user
    raises it. The root's own tasks and planner are charged nothing: a flat run has no
    budget.
- **Authority stays at the seam (M6).** `consent()` in `ExecutionCommands` stays the one
  place. `ExecutionActor` gains `subplanner`, at its depth: every turn of a child acts as
  it, and consent is its grants alone, allow or refuse, never `ask`. `USERS_ONLY` is
  refused to it as to any model. These paths reach around the seam and are closed:

  | path | what goes wrong | closed by |
  |---|---|---|
  | `adoptPlannerTasks`, `autorunApproves` | a commit approves with no command | `PlanChangeCheck` reads `replan`, `delegate`, and `research` for a research task the change brings, and the approval reads `approve` |
  | `adoptResearch`, `startAtGate` | research is approved and queued as it lands | reads `research`, which every root holds |
  | `mergeLanded`, from `tick` and the run's end | an automatic merge passes no command | below the root, reads `merge`; ADR-0055 D9. At the root the user's setting is the consent, at any level (ADR-0029) |
  | `{ kind: 'autorun' }` | allowed all but the user's controls | below the root, narrowed by `approve` and `control`. At the root it is the user's standing instruction, which no level holds back (ADR-0030) |
  | `ModeResolver` | a runner's mode reads global autonomy | a child's reads `autonomy` |
  | `spawn_research_agent`, harness subagents | uncounted fan-out | spend counts usage events with a subagent id; without `research` a subplanner's harness subagents are withheld |

  `PlanChangeCheck` refuses a research task without `research`, as well as the landing
  leaving it unapproved: a child's `approve` and `run_plan` approve what its plan holds, so
  a task left in the plan would start with no grant. A child's `replan` is read by the check
  and not at `run_script`, which `control` allows.

  **The tool list is filtered by grants and fixed at session start**, in a stable order,
  through `PlannerTokenScope.hidden`, because a changed list breaks the prompt cache. MCP
  2026-07-28 allows a list to vary by the authorization on the request, and forbids only
  per-connection variation, so one endpoint stands. The list is a courtesy: what stops a
  call is the seam, so a grant lost mid-session is refused at once with the list
  unchanged. The root's list is not filtered.
- **Autonomy, the owner's view made safe (M7).** Deeper nodes decide how to work without
  asking. A subplanner is Act with autorun inside its mandate: it approves its own plan,
  starts and retries its tasks, answers its runners within its grants and merges its
  subtree. It holds less authority over what is shared. These go up:

  | goes up | held by |
  |---|---|
  | changing an interface outside its scope | detected: the paths its branch changed outside `scope` are derived at its verdict and put in its report's `open` ([ADR-0057](0057-information-moves-by-reference.md) R2), since scopes are advisory (R6) |
  | widening its scope | `scope` is on the parent's plan, which the child cannot edit |
  | spending more | refused at the claim (M5) |
  | any outward effect | sealed (M9) |

  A subplanner is told to ask before the first of these; the code catches it afterwards,
  and the parent decides.
- **Questions go up one level at a time (M8).** A subplanner's `checkpoint` wakes its
  parent, which answers it (`steer`) or asks its own parent. The call answers at once
  that the question is asked, its turn ends and it parks, and the answer opens its next
  turn: a blocking call would hold a process and a slot for as long as a person takes
  (ADR-0055 D18), where a runner's `checkpoint` waits as
  [ADR-0022](../runners/0022-ordewell-mcp-server.md) V5 says.
  - Only the root reaches the user, through the inbox
    ([ADR-0053](0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)): a
    depth-1 subplanner's question there is the delegated task's `checkpoint`, already
    derived at every level, its reason naming the path. A supervisor at Act answers as
    it does any checkpoint. At Watch the root's planner is woken and holds no `steer`,
    and at Off it is not woken, so the user answers. Deeper, a question is its parent
    subplanner's to handle, and is never a list item for the user unless that parent
    asks it as its own.
  - Whether a question concerns an outward effect stays judgment: a question is free
    text, so ADR-0029's rule that one on an irreversible or outward effect goes to the
    user stays in the brief. What code holds is where an effect can run (M9).
  - A subplanner never prompts. Anything that would ask a person is refused, as a
    research subagent's is
    ([ADR-0008](../planner-envelope/0008-planner-exploration-envelope.md) T6): its
    approval mode is `allowlist`, so what would ask runs sealed
    ([ADR-0036](../planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md)
    S5), and is refused where nothing can seal. A runner's approval below the root is
    denied at once with a note and told in the next run update: nobody there may allow
    it (ADR-0029), and absent is denial (T5).
  - A stuck subtree ends `failed` or `blocked` with a report, so its parent can decide.
    Nothing waits for ever: a question nobody answers ends with the child's wall-clock
    time, which answers nothing on the user's behalf and leaves ADR-0053's rule of no
    deadline and no default answer as it is.
  - ADR-0029's "the run never depends on the supervisor" holds at the root, where a person
    remains. A child has nobody else. A loop guard that would lower a root to Watch ends a
    subplanner `blocked`, and one whose planner fails its restart ends the child `failed`,
    its tasks stopped first. A Continue picks either up.
- **Outward effects (M9).** No ops task runs below the root (ADR-0055 D2). A child's
  script task runs by this rule whether its plan holds it or `run_script` added it.
  Without the `effect` grant it runs sealed, as a sealed check does (ADR-0055 D8):
  capability is held at the boundary, so a script can test and cannot reach out, and
  where nothing can seal it is refused as a script check is (ADR-0055 D8). With it
  they run in the child's checkout, a worktree, and only a body covered at every level
  of `effectRules`; a script body is covered by nothing (ADR-0035). So an effect in a
  child is a list of commands the user wrote rules for, and anything else goes up, where
  the root runs it as a script task under ADR-0035.

  The known limit, plainly: a change-task runner in a child keeps the network it has in
  a flat run until the container backend exists
  ([ADR-0059](../isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md)).
  Deep autonomy adds no capability today. It does remove a person from plan approval, so
  an instruction injected into something a subplanner read can become a plan nobody read
  and run with that network. ADR-0029 and ADR-0030 accept that risk at the root under
  Act and autorun; turning delegation on accepts it below, and its confirmation says so.
- **Retries and revocation (M10).** Retries multiply across levels: three at each of three
  levels is twenty-seven times the work. Budgets bound that, and each node keeps its own
  loop guards (ADR-0029), so a parent's retry of a delegated task, a Continue
  (ADR-0055 D17) or a fresh retry (D15), spends what is left, and no retry mints
  budget. A provider's error is another thing, and only one layer retries it
  ([ADR-0058](0058-a-tree-holds-many-nodes-and-few-live-sessions.md) S5). The user can
  narrow or revoke at the root, and that holds for the subtree at once, by M1: a start
  under a lost grant is refused at its next check, which for a child's attempt is
  `claimRefusal` reading `control`, since a scheduler's start passes no command. Turning
  delegation off empties the root's `grantable`, so a saved child loses its grants,
  the floor with them: the floor binds `narrow`, which writes a new child, and not
  M1's reading. Nothing in the subtree starts, no new turn included, its work in flight
  finishes, and code then ends each child `blocked` with a derived report.

## Testing decisions

- A table test holds `rootMandate` to today: for each level, each actor and each
  `ExecutionCommandName`, the answer is what `SUPERVISOR_LEVELS` and `consent()` answered.
  It is what "a flat run does not change" means, and it stays.
- `narrow` is a property test over generated mandates and requests, for every field and
  limit, with the type's exhaustiveness behind it.
- M10 is tested on a live child: with delegation turned off nothing starts, its work in flight
  finishes, and it ends `blocked`. M1 is tested with a guard lowering an Act run.
- The ledger runs on `FakeRunnerSession` usage: carve, reserve, a claim refused, a stop at
  the limit, a return on close, a raise, across a tree. A carve of all the room leaves a
  parked subplanner its next turn, which spends its reserve first and keeps it again as
  it parks, questions go on being answered from the child's room, and a turn nothing can
  cover ends the node `blocked`. A start path added past
  `claimRefusal` fails it.
- Each leak in M6 gets a test through its own path, not through the seam.

## Out of scope

- Whether tasks a supervisor adds at Act should wait for the user, which ADR-0029 left for
  #23: the root keeps its rule, since a flat run does not change.
- Budgets on a flat run, and a dollar budget.
- Scoped credentials per node (ADR-0059), and a grant that widens a runner's mode.

## Considered options

- **More autonomy deeper down (the owner's position).** Split. Freedom in how to do the work
  grows with depth; authority over what subtrees share does not, and no node gains
  capability. A deep node with a goal and little oversight is where a failure is hardest
  to see, and its report is the only thing anyone reads of it.
- **Delegation only under Act and autorun at the root.** Rejected. It would hold M4 with no
  `grantable`, at the cost of a Guarded, Watch user being unable to delegate, and of tying
  two consents ADR-0030 keeps apart: what the root planner does and what a subplanner may.
- **A person approving each child plan.** Rejected. It is Watch with extra steps, and the
  user who wanted a tree has a queue. They approve the goal and its limits at the root.
- **A second kind of node, with its own consent table.** Rejected (#112).
- **Enforcing the mandate in the prompt.** Rejected: ADR-0029's reason. A prompt is advice.
- **Budgets at the command seam.** Rejected: the scheduler's starts never reach it.
- **Dollars.** Rejected: no price table is kept in Ordewell, and a subscription has none.
- **A carve that leaves a fixed number of the parent's turns, alone.** Rejected: any number
  runs out while the child that asks still holds budget it has not spent.
- **Charging a child for every turn it wakes.** Rejected: a child that asks for a raise has
  no room to pay with.
- **Releasing a parked reserve into room as its turn starts.** Rejected: a carve, a raise or
  a claim in that turn could take it, and nothing would be left to keep as it parks.
- **Excluding cache reads from spend.** Rejected: they are most of a long session's cost, and
  a budget that ignores them would let context grow unbounded.
- **What a child leaves flows to its siblings.** Rejected: a return would wake them all, and
  replay would depend on the order children ended.
- **`research` by default on a delegated task.** Dropped: a harness's subagents pass no
  claim and their usage arrives afterwards, so a task that left `grants` out would have
  turned on fan-out that nothing refuses.
- **Letting a parent allow a child's runner approval.** Rejected: it widens the mode the plan
  set (ADR-0001, ADR-0029).
- **A separate URL per role's tool list.** Dropped: the MCP specification allows lists to vary
  by authorization.
- **A list that changes as a grant changes.** Rejected: it rebuilds the prompt cache to say what
  the seam says.
- **A deadline or a default answer to a child's question.** Rejected: ADR-0053's reason.

## Consequences

- A flat run does not change, and a test says so.
- A person leaves plan approval below the root. That is the trade delegation asks for, and the
  gain in autonomy is exactly that and no more.
- A child's verdict is judged by evidence and a check, and its plan by nobody: a parent reads a
  report.
- Every actor switch in the seam gains a case, and 36 prompt lines that name the user need a
  parent's wording. Refusals name a level.
- Budget numbers are planners' guesses at first. A too-small budget ends a child `blocked`, which
  costs a question.
- The reserve estimates, so overshoot is bounded only as well as a harness reports.

## History

- 2026-10-31 — accepted. Not yet implemented.
- 2026-10-31 — checked against the code: what the root may hand down, where the root's mandate reads its level, what the floor binds and what a revocation does to a saved child, `run_script`'s grant, a fresh retry, and the names of the types.
- 2026-10-31 — checked against the code again: what narrows is `grantable`, a delegated task's absent `grants` ask for nothing, the clock past a reset, who answers a depth-1 question at each level, and a sealed script where nothing can seal.
- 2026-10-31 — a subplanner's turns come before its carves: a parked subplanner keeps its reserve, a turn past its room takes from its children's, and a turn nothing covers ends the node `blocked`.
- 2026-10-31 — a parked subplanner's reserve funds its next turn, which spends it before room, and is kept again as it parks; what covers a turn is said.
- 2026-10-31 — implemented in part: `Mandate`, `rootMandate`, `narrow`, the seam, the paths around it and a child's tool list, on a faked child, and the delegation setting (ADR-0055 D21). Built closest to the text where it could not hold: an automatic merge and `{ kind: 'autorun' }` read their grants below the root only, since Off and Watch hold neither and a flat run does not change; `PlanChangeCheck` reads `research` too; a request names the level narrowing.
