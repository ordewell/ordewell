---
status: accepted
amends: ["0012", "0013", "0022", "0029", "0047"]
note: "Settles #34, and #36 and #38 as far as this goes. Built behind ADR-0055 D21's switch, so a flat run has no scope and no board. An API planner reads a board through `task_output` and leaves entries with `post` (R11)."
---

# 0057 — Information moves by reference: reports stay one size at every level, and code decides when a planner wakes

## Problem

[ADR-0047](0047-structured-task-handoffs.md) settled what one task tells the next in a
flat plan and left hierarchy to #34, the board to #36 and cohorts to #38. A tree breaks
what a flat plan gets away with:

- **A finding has no stable name.** `checkHandoff` stores `{task, finding}` and checks
  the finding against the latest handoff, and F numbers restart per attempt, so "F3 of
  task 12" can mean something else after a retry or a loop round.
- **A planner above a subtree would re-word it.** Nothing lets a subplanner pass a child's
  finding up except typing it again.
- **Waking is per event.** [ADR-0029](0029-the-supervisor.md) merges events within five
  seconds and wakes. A wake is a model turn over a whole context, and one on an expired
  prompt cache is the expensive kind: on Claude Opus 5.5 a cache write is $5 per MTok
  against $0.20 for a hit, and on most models only cache reads stay outside ITPM, so a cold
  wake charges its whole prefix against the rate limit too (Anthropic's rate-limit and prompt-caching
  pages, read 2026-10-31).
- **What a wake carries has no cap.** A failure lists every task it blocks, a batch every
  pass, and the plan block every task. The level brief, about 2,300 characters at Act, is
  repeated on every wake, in a history a harness keeps.
- **Siblings know nothing of each other,** except what a planner re-types or a merge
  conflict says.

## Decision

**A finding moves by a reference pinned to its attempt. A pushed handoff is the same size at
every level, and a subplanner promotes child findings by reference, for Ordewell to render
verbatim. Everything that crosses a level is untrusted data with its provenance. Code
decides when a planner wakes. Between siblings the medium is the plan and git: tasks declare
scopes, the affected task gets one addressed line, and a board holds what is worth pulling. There
is no sibling chat, lock tool, wait tool or broadcast.**

## Key properties

### Up the tree

- **References are pinned (R1).** A reference is `{ node, task, attempt, finding }`, made
  of immutable ids, pinned by Ordewell as the call is accepted: an author writes `#4/F3` and
  `checkHandoff` stores the attempt that finding belongs to, as it does for the `{ task, finding }`
  an author may also send, and `#4@1/F3` names an attempt outright. It renders as `#4@2/F3`, and
  that text is what `read` and `task_output` take back. A reference with no attempt reads the
  latest, from the logs where a retry has cleared the task's digest. Across plans it carries the derived
  path, `3/2:#4@2/F3`: `TaskRefs`' grammar is not overloaded, and the separator is one a task label
  cannot hold. The path is the node's in the tree's log
  ([ADR-0058](0058-a-tree-holds-many-nodes-and-few-live-sessions.md) S3), each id a child's place
  among its parent's, so a fresh retry, a new child, leaves a reference to the old one meaning what
  it meant. A reader writes the path a report showed it. Reports show it from the root and an author
  may write it from its own plan, so a path that starts at the reader's node and goes on is read as
  shown, and any other from the reader's plan.

  A subplanner's `task_complete` is checked against its own plan, the child plan, not the
  parent's, whose attempt handles the call
  ([ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) D4). Its readable
  set for `promote`, `open` and `findings[].evidence` is its whole subtree: every task of that
  plan and of each plan below it. So `#4` is the child plan's task 4, whether or not the
  parent's plan has one, a task further down is written with its path from that plan, `2:#4/F3`,
  and a refusal names the child plan's task. The producer, the delegated task, is in none of
  those plans, so `checkHandoff` is handed that set: `readableTaskIds` cannot derive it. A pinned
  reference holds the child task's immutable id and the attempt, under the `node` of its plan,
  and renders with the node path, so a later read reaches that attempt whatever the reader's
  plan holds. One that has crossed a level also keeps `label`, the name its own plan gave the task:
  ids can repeat between plans, so no other plan may name it.

  A planner reads its whole subtree. A task reads below only through a delegated task in its
  readable set, so a check reads what its delegated task did, and reading goes down and never up
  or across: a child's tools reach nothing of the plan that holds its check
  ([ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) D8).

  The digest on a task says which attempt it is from, and a digest saved before it did takes the
  newest attempt the logs hold. A reference stays valid for the life of the root plan,
  since attempt logs live as long as their session and a child's sit under the root's
  ([ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) D11); a task
  removed from the plan keeps its log, so a reference pinned to one of its attempts reads that
  log by the id and attempt it holds. A task's `read` takes that read, and its
  `task_complete` the citation, only when a handoff in its readable set cites the attempt: the
  graph no longer reaches a removed task, and a task still cannot read work it was never given
  ([ADR-0047](0047-structured-task-handoffs.md)). A saved reference with no attempt reads the
  latest, as it does today, a removed task's included; a reference naming no attempt reads the
  newest one cited, so it never reaches past what the reader was given.
- **What is pushed is one size (R2).** A handoff is pushed at most 4,000 characters at every
  level (`HANDOFF_PUSH_CHARS`, its artifacts apart), so a node's inbound context depends on its
  fan-out and not on its subtree. Its Report, the long form of at most 20,000, stays pulled
  ([ADR-0047](0047-structured-task-handoffs.md)). A delegated task's report stands through a repair
  of its conflict, which reports in its own attempt's log (ADR-0055 D14), and a read that names no
  attempt reads the report. A subplanner's `task_complete` adds two fields, refused on any other token:
  `promote`, up to 8 references to findings in its subtree, and `open`, references its parent
  must decide, both pinned and scoped as R1 says. Rendered, by ADR-0047's rule, whole items until
  the ceiling and then a count:

  ```text
  counts       done, failed, blocked, skipped, commits, tokens: derived by Ordewell
               findings in the subtree by severity, and how many of each show below
  commit, summary
  open         what the parent must decide
  promoted     each verbatim, with its author's path and its evidence
  findings     the subplanner's own
  +N more; read #4
  ```

  The finding counts read the latest attempt of each task in the subtree as it stands: a child a
  fresh retry or a removal discarded no longer counts, and a Continue's two nodes count once. `+N more`
  counts what the ceiling cut, promoted items included. So what a subplanner leaves out
  shows without a pull, and `read` on the delegated task lists it, each by its reference. The list
  reads what stood on that report, a discarded child's too, so a reference to it means what it meant.
  A child's finding moves up only by reference. A subplanner adds its judgement as a finding of
  its own; it cannot edit a child's, and no model summarises one. `open` may also name one of its
  own findings, `F2`, which moves there. Paths its branch changed
  outside its `scope` join `open`, from code ([ADR-0056](0056-a-mandate-narrows-down-the-tree.md)
  M7). The attempt logs keep the rest, to pull.

  Each item is read once, as the report is taken, and kept in the handoff: its reference is pinned,
  so its words cannot have moved, and the renderer stays a pure function of the digest. A child that
  ends with no call gets the same counts in a derived report. `blocked` counts every task that did
  not end, `commits` the tasks that passed with a commit message. A listing `read` gives holds 100
  findings a page, counts the rest, and names the next page, `#4@2/from:101`, which is no citation: a
  page is read and passed on by the findings it lists. An API planner reads one through `task_output`,
  which says where the list starts. The fields are written as text, `"#4/F3"`, since a reference is
  what a report shows, and `open` has the limit `findings` has.
- **What crosses a level is untrusted (R3).** Reports, boards and handoffs are data, shown with
  their provenance and never as instructions: the block says whose words they are, by path, in one
  short label on each dependency and each report (`wordsFrom`), and the planner's prompt says what
  that means once. A reason a runner gave for failing is its words too, and says so where a report
  opens with it; a script's is its exit status, and is not. ADR-0037 R3 and ADR-0047 say this for one
  level. A tree makes
  each report a way into every node above it, and into each task that reads it, so a report
  never becomes a plan's text unless a planner writes it, and that planner is then answerable
  for it. A promoted finding is its author's and not the subplanner's, so it carries that author's
  reference; a detail is indented under it, a run update's report under its line, and every line a
  delegated task wrote of its report, its commit, summary, reason and tail included, so none can
  pass for a line of Ordewell's. That holds with no report to say whose they are, a repair's words
  among them, by a mark the handoff carries wherever it is rendered. A line break is every one git
  or a terminal would honour (`models/lineBreaks.ts`), not only `\n`. A path, a title or a
  reference goes on Ordewell's line whole, a filename a branch chose as much as what an author
  wrote: `task_complete` and `post` refuse a break in one, and what reaches a line anyway is
  quoted there.

### Waking

- **Waking is decided in code (R4).** In `WakePolicy`, a pure function with no model. ADR-0029's
  five-second merge stays as what "at once" means.

  | wakes at once | events |
  |---|---|
  | a child plan ended | a delegated task's verdict, or its Stop |
  | a person is needed | `waiting_input`, `waiting_approval`, `landing_conflict` left waiting, `auto_merge_stopped`, `usage_limit`, `run_held`, `failure_standing` |
  | something is open | a question from a child, or a report with `open` |
  | a report arrived | `task_report` ([ADR-0037](0037-research-tasks-wake-the-planner.md)) |
  | the run ended | `run_finished`, with no merge window |

  Any other event but a pass, `task_failed`, `task_idle`, `running_long` and `landed_blocker` among them, is held until the first
  of these, each of which is read from the plan:
  - **nothing can start** on this node without a decision;
  - **the cohort is done**: every task that became ready with this one has ended, read as every
    task with its dependencies;
  - **a failure blocks work** that would otherwise be ready;
  - **a supervisor at Act can retry it**: at Act, a `task_failed` for a task any other task
    depends on, however far back and ready or not, is due at its own merge window, as an event
    that wakes at once is. A retry then runs beside the rest instead of after it. A failure
    nothing depends on, `task_idle`, `running_long`, `landed_blocker`, and every event at Watch stay held, since a Watch
    supervisor cannot retry;
  - **a maximum age**: 80% of the planner's cache TTL once anything is held, so a wake finds its
    prefix warm. Each connector states its TTL, the shortest it may be since that is the one a wake
    can count on, an unknown one reads as five minutes, and time is counted as the provider counts
    it, from the start of the request: the turn's opening stands for that, which can only make a
    wake early. A prefix already cold has nothing to save, so the age then runs from the event.

  `run_held` is the run idle behind its holds: nothing is running, nothing can start, tasks remain,
  and what holds them is a task on hold or a task waiting on a person (a usage limit apart, which
  its reset lifts). `RunSupervision` raises it on the orchestrator's idle tick and when a wake's turn
  ends, once for each distinct set of holds, keyed by each holding task with how it is held and why;
  a later `run_held` replaces an earlier one still queued. Its line names each holding task, why it
  is held, who put a task on hold (the last stop, revert or mark-not-done recorded for it), and how
  many tasks not yet done it holds back, and says that a task on hold starts again only once it is
  retried, force started or skipped. Any wake delivered while the run is idle records the set it
  stood behind, so a turn that leaves that set in place is not woken for it again; a different set,
  or a start the user asks for, a join of the open run included, wakes afresh. It is counted
  against the rate guard as any wake is. A supervisor that stopped a task waiting for input and
  ended its turn, the stop alone moving nothing, had left a run idle with no wake to come.

  `failure_standing` is a blocking failure a supervisor's own turn left standing while the run is
  not idle, or once it has ended. When a wake-up turn at Act ends and a task it was woken for is still failed, on hold
  or waiting on a person (a usage limit apart), was not stopped by the user, and tasks not yet
  done need it, `RunSupervision` raises it for that task as the turn ends, without waiting for the
  run to go idle, which another task still running can put off for good. A loop's check between
  rounds is stored as failed but is no failure ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md) L3), so it raises
  none. It goes with no merge window, as `run_finished` does: the turn that left it standing is its
  context, and `ordewell run --unattended` judges a person's wait still standing shortly after a
  turn, so a wake that waited out the window came after the follower had left. Its line says the task
  still stands that way after the turn, how many tasks wait on it, and the calls that release it.
  It is raised once per task for each failure or hold, keyed by the task with how it stands and
  why: a turn that leaves it standing again is not woken a third time, and a turn woken for
  another task is not woken for it; the task settling again, a new hold, or a start the user asks
  for makes it new. It is counted against the rate guard as any wake is. A run idle behind its
  holds is `run_held`'s, which stays the backstop. An Act supervisor refused an identical retry
  had edited the prompt and ended its turn while another task ran: twelve tasks stayed held with
  no wake to come.

  The closing turn, the one on `run_finished`, is held to the same rule, with no idle backstop
  behind it: once the run has ended nothing else wakes the supervisor. Its turn was on the whole
  run, so every task still failed or held with work waiting on it raises `failure_standing` as it
  ends, under the same once-per-failure key, and the line adds that the run has ended and an edit
  starts nothing until the task is released. That wake holds the run's end as the closing turn did
  ([ADR-0029](0029-the-supervisor.md)): `run_concluded` waits for its turn too. A closing turn that
  failed is judged once its retry is over, whether that retry is the supervisor's turn or a user's
  turn that carried it, and one the user stopped, or whose retry they stopped, raises none. Below
  Act none is raised. An Act supervisor on a small model edited the one failed task's prompt in its closing
  turn and never retried it: thirty tasks behind it never ran, and `ordewell run` returned.

  `failure_standing` also catches the supervisor up on a task failed or held with work waiting
  that no event it gathered was about since the task last settled: it failed while the run was
  Off, or the plan was loaded with it. A hold a call left (a Stop, a revert, a mark not done,
  whoever made it) is not caught up: it is the caller's own, and `run_held` names who put it
  there once the run is idle, unless a start follows (a retry, a run, a force start), whoever
  starts it: a hold that start then leaves is Ordewell's, and is caught up. At Act it is raised as the user's level becomes Act during
  a run, as a run starts or continues (once the start's merge window has passed, so a task the
  start retries is not named), as the user sets a level after a run that ended with its supervisor
  stopped (then as the closing turn's, holding nothing a follower waits on, since that end was
  told), and as the run goes idle, the fallback for a failure `run_held` leaves out. Its line says
  the supervisor was not told, why the task failed, and names what waits on it. Every task the
  catch-up finds goes in the one wake, each is named once, a task the user stopped is left out,
  and the wake counts against the rate guard; a turn that leaves the task standing is woken for it
  once more, under the key above. After a network outage stopped supervision, a loop's check failed
  its last round with four tasks waiting, and the user's Act reached nobody.

  A `running_long` event is raised by a task's running time, by an automatic compaction of its own
  runner session, or by its context growing large; which compactions count as routine, and where a
  large context starts, is one rule for every harness
  ([ADR-0018](../runners/0018-structured-runner-transport.md) C4). A flagged context comes before
  a compaction, so the supervisor can have the runner commit and report, or split the task, while
  its context is still sound. All three are held, batched and counted against the rate guard alike;
  their line says which raised it. One still held when its task passes or fails is dropped from
  the batch: it advised on an attempt that has ended, and three flags of a recorded run reached the
  supervisor after their task had passed.

  A `landed_blocker` event is raised by the handoffs that report a blocker in a landed task's work
  as their count reaches a power of two
  ([ADR-0073](0073-a-blocker-found-in-landed-work-reaches-the-supervisor-while-the-run-can-still-land-a-fix.md)).
  One task's reports are one fact: a later count replaces the one still queued, keeping its stamp.

  A pass is not held: it wakes nothing and starts no clock, and rides along in the next wake, as it
  does today, so a plan that only passes opens no turn. A delegated task's pass is a child plan
  ending, in the table: its end reads as a `task_report`, so its report is what wakes the planner,
  and one with `open` needs nothing more. Not waiting on the cohort alone is deliberate: it would be bound to its
  slowest task. There are no keep-warm pings: they are model turns that grow the context.
- **Bounded wakes (R5).** A wake has a size cap, 24,000 characters, with one line per ride-along
  event of at most 120: a pass, or a held event that holds no work back. A digest names a task in at
  most 80, so a long title is cut and the line still says what happened. A `running_long` line
  is the exception: it carries its facts whole, up to 360 characters, with the context measured against the window the task
  compacts at where Ordewell sets one and the model's window beside it ("context 16k of a 400k compaction
  window (model window 1000k)"), or, for one its context raised, the size it passed ("context 412k
  of a 1000k window, past 400k"), then, as a failure's line does, the tasks it blocks, by the same
  rule read as though it had failed, subtasks included, and none when it blocks nothing. A
  `landed_blocker` line is whole too, never a ride-along: the work it names is what its reporters
  build on. The digest says once, after the attention lines, what the supervisor can do about
  either, so the planner's system prompt does not grow. What woke the planner goes
  first, whole items only. Overflow becomes counts and a pointer: `task_query` reads the rest. The
  cap is on what the turn sends, so updates that waited for one turn are bounded together, and the
  transcript keeps them all. The newest is what opened the turn, so it stays whole and the oldest
  are left out first, each of their events named in a line up to a count, since a turn settles what
  it was sent and nothing raises them again. A failure blocking many tasks names the first few and the count, as a
  usage limit does. The level brief is sent once and then one line on a change, through
  `PlannerBriefing`, and again whole only when a context no longer holds it, as ADR-0012 T10 sends
  the plan block; ADR-0029's "each turn" goes. Each level has its brief, and a context that never
  held the one a change reaches gets it whole: a line cannot carry a level's rules, the escalation
  rule among them, to a model that was never told them. The plan
  block is bounded too: past its cap it shows live and waiting tasks, a count of the rest and a
  `task_query` pointer. The 24,000 is a tuning value.

  A subplanner is told less again. Its prompt names its own runner and that runner's models, so a
  plan takes no call to read them and no wake reminds it to ([ADR-0022](../runners/0022-ordewell-mcp-server.md)
  L3): `submit_plan` refuses what has gone stale, and `list_runners` and `list_models` stay for another
  runner. Its prompt has no outline, which nobody reads, and no section on ops tasks, which do not exist below the
  root. `submit_plan`'s answer asks it for one line, and for none would open the nudge an empty reply is owed. Its plan block,
  once every task has passed or been skipped, is the task rows alone: what is left is its report.
  Its wake brief is its own, which asks for that report first and names no user
  ([ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) D4).

### Between siblings

- **Tasks declare a scope (R6).** `scope: { paths, provides, consumes }` is an optional field of a
  delegated task, written by the planner on the plan the child cannot edit, and on no other kind of
  task: a flat plan has none. Overlap is checked as the plan commits and answered in the tool's
  result, for an edit what that edit brought: paths that can name one file, one name two tasks
  provide, and a consumer nothing puts after its producer, between tasks no edge orders. The planner
  orders the tasks or names an owner. Producers go first, which is an edge in the plan and costs
  nothing new. A scope's items are one line each, since they reach a line Ordewell writes.

  When a landing touches a path or interface a running task declared, that task gets one addressed
  line, marked `from: 'ordewell'`, at most one per task per ten minutes and coalesced past that. A
  running task with a scope is a delegated task, so its step boundary
  ([ADR-0023](../runners/0023-messages-reach-a-running-task.md)) is its subplanner's next turn: the
  line waits for that turn and opens none, since a landing is not in R4's table. What the landing
  changed comes from git, and not from what it declared, so a landing past its own scope still
  reaches whoever declared those paths. Each path and interface is a quoted string on that one line,
  as a sibling's branch chose them (R3). An index from path to task makes this cost the tasks that
  overlap, not the plan.

  As a delegated task lands, each `contract` on its board keyed by a name it `provides` rises to its
  parent's board, keeping its author and read again against the branch it landed on. That is how a
  sibling reads one: a node reads its ancestors' boards and never another's, so nothing posted reaches
  sideways before its work has landed, and only what the plan above declared rises. It is a copy
  of the entry at most once, and the entries of a fresh retry's old child stay behind with it.

  **Scopes are advisory, and widen nothing.** Worktrees already isolate writes, and a miss costs a
  merge conflict, which has a repair ([ADR-0015](../isolation/0015-conflict-repair.md)). So scopes
  neither gate scheduling nor refuse a change; [ADR-0013](../isolation/0013-worktree-isolation.md)'s
  "conflicts are handled, not predicted" stands for what a planner did not declare. A scope grants
  nothing either: it is no part of a mandate ([ADR-0056](0056-a-mandate-narrows-down-the-tree.md)), a
  protected path it covers stays protected, and a `scope_change` entry changes nothing but the board.
- **No sibling chat, lock, wait or broadcast (R7).** Sibling messages (#38) stay out. They come back
  only if replays of real trees show both of these: conflicts or duplicated work between siblings
  that scope lines and the board do not lower; and, on the same goals, messages on costing fewer
  tokens per landed task than messages off, not just fewer conflicts. A task that needs a sibling's
  unlanded work waits only through an edge of the plan: `wait_for` ends its attempt and adds the
  dependency, and the start rule continues it once that work lands
  ([ADR-0074](0074-a-task-that-needs-a-siblings-unlanded-work-parks-and-continues-once-it-lands.md)).
  It holds no lock on the sibling and hears nothing from it.

### The board

- **A board per delegated task (R8).** Typed entries go in through `post`, and are read by pull through
  `read`. Entries are one-way: a `post` wakes nobody and tells nobody. Types: `finding`, `claim`,
  `attempt` (tried and failed, so others skip it), `artifact`, `contract`, `assume`, `scope_change`,
  and for planners `decision` and `pin`, which a runner's `post` does not take. A node reads its own
  board and its ancestors', through `read` with `board` for the map and an entry's reference,
  `board:root/1:E3`, for that entry: a word `read` takes only where there is a board, so a runner's
  `read` does not change by a byte. A map, one line per entry, is kept by code from the entries'
  typed fields, not by a model. A root gains a board with its first delegated task, which is where
  its pins live. A flat plan has none, opens no log and has no tool for one.

  A board is a fold of `board_posted` facts in the tree's log
  ([ADR-0058](0058-a-tree-holds-many-nodes-and-few-live-sessions.md) S3), so a restart reads it back.
  A Continue's new node keeps its child's one board, and a fresh retry, a new child, starts another.
  A board stops at 200 entries and a map at 100 a page, the rest counted with the page that holds
  them, `board:101`: tuning values. Entries are only added, so a page that moves repeats one and loses
  none.

  Every word on a board is its author's, untrusted data (R3). Whose it is comes from the token that
  posted it, never from the entry. The map says so in one label, and each one-line field reaches a
  reader as a quoted string on a line of Ordewell's, indented, so no entry can pass for a line of
  Ordewell's or make a second line. A detail is indented under it, on every line break a reader honours.
- **Stale and contested are computed (R9).** A board's `file` evidence holds blobs Ordewell reads as the
  entry is posted, never an author's claim: `sha`, the file as its author had it, hashed with no git
  since a read-only task's worktree may hold a planted repository
  ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)),
  and read through its lease where one runs the author elsewhere
  ([ADR-0059](../isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md) L6),
  and `tip`, what the plan's integration branch held then. At read the branch is compared with both, so
  a claim shows `stale` once the branch holds neither: a file its author changed and has not landed
  reads as it should, and so does one that landed as claimed. A branch merged and gone with its run
  reads as what the workspace has checked out, which is where it merged. Entries with one `key` and
  different values show `contested`, across the boards a reader reads. Both are flags in the map, in
  code; a semantic contradiction needs a model, so it is a review task's.
- **Pins (R10).** A planner's `pin` is a decision every descendant must know. It reaches each new
  descendant at spawn, a subplanner in its opening message and a task in its prompt, nearest ancestor
  first, within 2,000 characters in all, whole items, then a count. It is the one push down a tree, and
  it is data as the rest of a board is: it says what was decided, labelled with whose decision it is.
  Each descendant is told once, at its start, so a pin reaches no one already running. A check never
  goes in one: `post` refuses a pin that holds whole what this plan's checks read or run, which is the
  part code can see, and the prompt teaches the rest. A check's title and prompt count from twelve
  characters, shorter prose being too common to say; a command it runs counts at any length, whole
  and at the edges of its words, a script's one by one.

### Tools

- **A small, fixed set per role (R11).** A runner has `task_complete`, `checkpoint`, `read`, `post` and
  `apply_patch`; a read-only task keeps ADR-0046's tools beside the first four, and `post` declares
  itself read-only, since it writes nothing of the workspace. A task with no board has
  no `post`, so a flat run's tool list grows by nothing. `read` extends `read_task`, whose name stays an
  alias at the call and leaves the list. That rename is the one change to a flat list: a session resumed
  across the build that ships it misses its prompt cache once. A planner holding delegated tasks gains `read` and `post`.
  It holds them from the moment its mandate lets it write one, since a list that grew with its first
  delegated task would break its cache, and `post` before there is a board says so. A subplanner holds
  them whether or not it may delegate, since it has a board from its first turn. An API planner has no
  server list: `task_output` takes the same references for it, `board` and a listing's pages among them, on the
  read budget of any read, and `post` comes last
  in its list where delegation reaches it, so a flat API list does not move by a byte. A role is one list, whichever attempt asks. Each
  role's set is fixed at session start, in a stable order
  ([ADR-0056](0056-a-mandate-narrows-down-the-tree.md) M6), with a CI test on its serialised size.
  Turning delegation on reaches a planner at its next process.

  A subplanner's process holds that list and little else of its harness, since each of its calls is
  charged all of it, and nobody is there for the rest. Where its tasks' `taskRunnerConfig` is `minimal`,
  as it is below the root unless the settings file names one, Claude Code starts with the native tools a
  planner reads with (`--tools`: `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `ToolSearch`, with `Agent`
  under `research` and the shell tools under ADR-0036's opt-in), no setting source, `--strict-mcp-config`, connectors
  off, and Ordewell's server alone. These go together and never apart: with a connector left on, its tools come along.
  `ToolSearch` stays though it finds little here: without it a model reopened on a Continue read Ordewell's tools as
  missing and ended saying it had no `task_complete`. `user` leaves the spawn as a planner's. Ordewell's own list for the role is not cut: it is what the role does. Codex and OpenCode
  are started as they were.
- **Plain `tools/call` (R12).** No MCP Tasks, subscriptions, sampling or internal A2A. MCP 2026-07-28 is
  stateless, and references passed as arguments fit it. Delivery goes over each runner's own message path
  (ADR-0023).

## Testing decisions

- The renderer stays a pure function of a digest, tested for the order, the whole-item cut and the
  counts, as ADR-0047's is. R1 is tested across a retry and a loop round: a reference still reads what
  it named. A finding promoted from a child's task 4 renders and reads that task's attempt, with and
  without a task 4 in the parent's plan, and a refusal names the child plan's task.
- `WakePolicy` stays pure: a table of event streams against a fake clock asserts when a batch is due,
  including each flush reason, a pass that flushes nothing, and a flat run's events.
- The tool sets are held by a test that serialises each role's list and fails past a stated size, and
  by one that a role's list does not change across a session.
- Scope overlap goes through `validatePlanTasks` and the tool's answer; the addressed line through
  `FakeRunnerSession`, with its rate limit on a fake clock.
- A board is tested on a real ledger and log, for who reads what, the flags and what a reader is told.
  Two siblings coordinate on real git through a contract and a line, with a fake `claude` over the real
  adapter and MCP server, so `post` and `read` are real tool calls. A flat run is asked for a board and
  a tool and has neither, and the size test holds each new role's list.

## Out of scope

- A fresh start from the plan for a subplanner with a large cold context, which needs a measurement.
- Embedding search over a board, and a board across roots.
- Whether API planners' wakes miss the cache for other reasons. The brief is no cause: traced through
  `PlannerConversation.sendTurn` and `BudgetedChat`, a live chat keeps each message whole, brief included,
  and sends it unchanged ahead of the next (`OpenAiService.test.ts`). Only the transcript leaves it out,
  which a replay reads, and a replay opens a new prefix anyway, as it does after each plan an API planner
  commits. Ordewell sets no cache markers, so a provider that needs them caches nothing. No request was
  made to a real provider: #34's token task should log cached tokens per wake.

## Considered options

- **Reading a sibling's board.** Rejected: a contract is what a consumer wants, and reaching across would break
  R1's "down and never up or across". It rises to the parent's board at its landing instead, which R8's
  reach already covers, and a child that failed leaves nothing there.
- **Letting a child post to its parent's board.** Rejected: that is a broadcast to every sibling, with nothing
  to bound what it holds. A rise is typed, keyed by what the plan above declared, and comes with a landing.
- **A line that wakes the subplanner.** Rejected: R4 keeps waking in one table, and a landing that moves a
  sibling's interface does not need a model now. It would buy a turn over the whole context per landing.
- **Holding every failure at Act until it blocks ready work.** Dropped: it traded the run's wall-clock for
  fewer wake-up turns. A failure early in a wide run woke nobody until its dependents were otherwise ready, so
  the retry started only after every sibling ended and added its whole duration to the critical path, while a
  retry is what an Act supervisor is for.
- **An author's own blob sha.** Rejected: R9's flags are computed, and a sha a model sends is a claim.

- **Narrowing a subplanner's native tools alone.** Rejected, by a real run of the flags: with connectors left on
  and `ToolSearch` gone, every connector's tools were sent whole, far past what the list saved.
- **Leaving `ToolSearch` out of that list.** Dropped after real runs and a replay of the failing call: the tool list
  was the one thing whose return stopped reopened children saying they had no `task_complete`. A list that named every
  tool it held was not enough for the model to believe it.
- **A pass with no subplanner turn, for a run that ended clean, or a report filed with the plan.** Rejected: a wake
  costs one call now, and `task_complete` is the only way to a pass
  ([ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) D6). A report written before the work can
  say nothing of it.
- **Fewer of Ordewell's tools for a subplanner.** Not done: they are the largest part left of its context, but each
  is one the role can need, and a list that grew when a run failed would break the prompt cache.
- **Ending a subplanner's turn before its last reply.** Tried, at an accepted `submit_plan` and an accepted
  `task_complete`, and dropped after real runs: each such reply is a call over the whole context, nearly all of it
  cache reads. A process killed there takes its reported money with it, since Claude Code reports cost in the `result`
  that ends a turn, and an interrupt instead leaves an empty reply, whose nudge is the call saved. Stopped at a plan, the
  call stays in a history a wake resumes in its harness's words, the user refused this, stop and wait: one subplanner in
  fourteen took that as an order and reported blocked with its work passed and merged, naming a user who was never there.
  Stopped at a report, the turn lands nothing, and that closing line is how a Continue's replay knows it reported: reopened
  children said they had no `task_complete`, and failed. A hook that ends a turn after a clean tool result might do this
  without a stop, and would mean a hook in a planner's envelope (ADR-0028).
- **A model summarising each level.** Rejected. In three open-source deep-research systems, 84.7% of
  AI-Q's final-report errors arose at the orchestrator, while agents summarising a single document were
  nearly clean ([arXiv 2608.24306](https://arxiv.org/abs/2608.24306), EMNLP 2026). That measures AI-Q and
  citations, not code: the transfer to a planner is an analogy, and the safer side of one. ADR-0047
  already holds that the author writes it.
- **A subplanner's references checked against the parent's plan.** Rejected: it is the plan on hand
  where the call is handled, but `#4` would resolve to the parent's task 4, a wrong handoff stored
  silently whenever that task is readable, and a child's finding could never be cited.
- **A report that grows with its subtree.** Rejected: the root's context would depend on the tree's size.
- **Waking per event, or on the debounce alone.** Rejected: it is the cost in the Problem, at each level.
- **Waking only when a cohort ends.** Rejected: one slow task holds everything.
- **A pass among the held events.** Dropped: run one at a time, each task is a cohort of its own, so
  every pass would open a turn over the whole plan, where today none does.
- **Free messages between siblings.** Rejected. CooperBench found two agents succeeding about 30% less
  working together than on each task alone, and blames communication ("channels become jammed"), though
  it has no silent arm to compare ([arXiv 2601.13295](https://arxiv.org/abs/2601.13295)). On one set of
  message-heavy work at eight agents, shared files cut output tokens about 42%, and naming a coordinator
  did nothing ([arXiv 2608.16801](https://arxiv.org/abs/2608.16801), whose agents also went looking for
  grading material in four fifths of runs). A third found executable rules beat the same rules as text
  ([arXiv 2609.32965](https://arxiv.org/abs/2609.32965)), which is why these are in code.
- **Only reacting to conflicts, with no declared scope.** Rejected. One single-author benchmark of nine
  scenarios went from 1/9 to 9/9 clean integrations by declaring scopes and merge order
  ([arXiv 2610.07261](https://arxiv.org/abs/2610.07261)): a designed result, no field rate.
- **Chat instead of a line after a landing.** Rejected. A message describing a finished concurrent change
  recovered 82% of failures on constructed tasks, whose interference the authors say does not estimate
  practice: mined Django pairs showed it once in 834 runs
  ([arXiv 2609.25396](https://arxiv.org/abs/2609.25396)). So one cheap line is worth having, and no more.
- **Enforced scopes, or a lock tool.** Rejected: isolation makes a miss cheap, so a refusal would stop work
  to save a conflict.
- **A wait tool.** Rejected: a tool call times out by default at 60 seconds on Codex and 30 on OpenCode, and
  a blocked runner keeps a process and a slot.
- **MCP Tasks.** Rejected. Of the three harnesses only Claude Code has a mark in the client matrix, and Codex
  and OpenCode have no row. Ordewell already owns the task lifecycle.
- **A global board, or one every task reads.** Rejected: it brings back the cost it replaces.

## Consequences

- Flat runs change here, on purpose: ADR-0056's "no change" is the mandate's. A failed task with nothing
  blocked may wake the supervisor minutes later, in a batch. Anything that needs a person still wakes it
  at once, and a pass still wakes nothing.
- A subplanner's parent reads less than it could, and pulls by reference when a decision rests on detail.
  If replays show planners pulling most references, the push is too small.
- The completion call gains two fields, and evidence a pinned attempt.
- A scope a planner gets wrong warns about nothing. That is the cost of its being advisory.
- A line waits for a turn, so a subplanner parked on a long task hears it when that task ends or something
  else wakes it. A consumer that cannot go on without an interface needs an edge, not a line.
- A file a clean filter rewrites hashes as it stands, so it can read `stale` once landed: a false flag, and
  never a refusal.

## History

- 2026-10-31 — accepted. Not yet implemented.
- 2026-10-31 — checked against the code: R2 names the push ceiling and not the Report's limit, and R11 states what its rename does to a flat run's list.
- 2026-10-31 — checked against the code again: a pass stays a ride-along, and R2's counts show what a subplanner left out of its subtree.
- 2026-10-31 — checked against the code a third time: a subplanner's references resolve in its own plan, and it may cite its whole subtree.
- 2026-10-31 — R1, R3, R4 and R5 built for a flat plan: references pinned under the root, reports and handoffs labelled as data, `wakeDue` deciding each wake, and a wake's cap, with a brief per level sent once a context.
- 2026-10-31 — a removed task's pinned attempt reads from its log, within the readable set by citation; a turn's cap keeps the newest update and names what it leaves out; a digest cuts a title, not what happened.
- 2026-10-31 — a removed task's attempt can be cited as it can be read, and a saved reference with no attempt reads the latest; a digest line leads with what happened and a task name is short enough to leave it, so a turn's cap keeps it.
- 2026-11-01 — R1 across plans, R2, R3's checks at every level, R11 and R12 implemented, in `Subtree.ts`, `models/Handoff.ts` and `mcp/tools.ts`: a path is a node's in the tree's log, a report reads what it names once, a child plan's end is a `task_report`, and `read` is listed where a planner may delegate. Built closest to the text where it could not hold: `promote` and `open` are written as text, `open` may name a subplanner's own finding, and a runner's reason says whose words it is. `post` waits for the board.
- 2026-11-01 — R3 holds for a delegated task's commit, summary, reason, report and output tail: every line is indented in every reading, so none can pass for a line of Ordewell's.
- 2026-11-01 — R6 to R10 implemented, in `models/Board.ts`, `Board.ts`, `ScopeLines.ts` and `TreeLedger`, behind ADR-0055 D21's switch: a scope stays on a delegated task, its line waits for a subplanner's next turn, a `contract` rises to the parent's board as its task lands, `read` takes `board` so a runner's `read` does not move, `file` evidence holds a branch's blob beside its author's, and a pin goes in a subplanner's opening and a task's prompt.
- 2026-11-01 — a pin reads its author's file through the lease where one runs the author elsewhere (R9).
- 2026-11-01 — R11: an API planner holds `post` where a harness planner does, as the last entry of its list, so an API root can pin.
- 2026-11-01 — from real runs of where a subplanner's tokens go: R5 tells it less and R11 narrows its process, in `ClaudeCodeAdapter`, `PlanPrompts`, `PlannerConversation` and `Supervisor`.
- 2026-11-01 — from review: a report outlasts a repair (R2), a line break is one set everywhere and no path or title can make one (R3), and a check's command counts in a pin at any length (R10).
- 2026-11-01 — from review: VS Code's handoff panel holds what an author wrote, every line indented on the one set of breaks, as the TUI does for every handoff (R3).
- 2026-11-02 — from an audit of the flow: R2's counts read the tree as it stands while a report's list reads what stood on it, a listing and a board's map page on rather than stop, a board and a page spend a read through `task_output`, and a reference with no attempt reads the logs where a retry cleared the digest.
- 2026-11-10 — R4: at Act, a failure another task depends on wakes at its merge window, so a retry runs beside the rest.
- 2026-11-14 — R4, R5: `running_long` ([ADR-0018](../runners/0018-structured-runner-transport.md) W1) is held as `task_idle` is, a later one for the same task replaces the first, and its line carries its facts whole with the advice once.
- 2026-11-15 — R4, R5: where Ordewell sets the window a task compacts at, a compaction raises `running_long` from the attempt's third, then at the 6th, 12th and so on, and its line names that window beside the model's; with no window set it still fires from the first.
- 2026-11-17 — R4, R5: a compaction is routine only under a window below 200k tokens; with none set, as `auto` sets none but Haiku's, or any window from 200k, `running_long` fires from the first, and R5's example names a 400k window.
- 2026-11-17 — R4, R5: a task's context reaching 40% of its effective window, never below 150k, and each doubling of that below the window, raises `running_long`, held as the others are; its line names the size it passed against the window.
- 2026-11-17 — R4: `run_held`, the run idle behind a task on hold or one waiting on a person, wakes as a person needed does, once per distinct set of holds, naming each hold, who put it there and what it holds back.
- 2026-11-17 — R4: `failure_standing`, a task a wake-up turn at Act left failed or held with work waiting on it, wakes the supervisor once more as the turn ends, once per task for each failure or hold, while `run_held` stays the backstop for an idle run.
- 2026-11-17 — R4: `failure_standing` goes with no merge window, and a loop's check between rounds raises none.
- 2026-11-18 — R4: the closing turn raises `failure_standing` too, for every task it left failed or held with work waiting, once per failure, and that wake holds `run_concluded` until its turn is over.
- 2026-11-18 — R4: the closing turn's `failure_standing` is judged once its retry is over, and none is raised after the user's Stop of the closing turn or its retry.
- 2026-11-18 — R5: a `running_long` line names the tasks it blocks, by the rule a failure's line uses as though it had failed, subtasks included, and nothing when it blocks nothing.
- 2026-11-21 — R4: a running-long flag still held when its task passes or fails is dropped from the batch.
- 2026-11-21 — R4 holds `landed_blocker`, one per landed task, the latest count replacing a queued one; R5: its line is whole, never a ride-along (ADR-0073).
- 2026-11-21 — R7: a task waits for a sibling's unlanded work only through a plan edge, by `wait_for` (ADR-0074).
- 2026-11-22 — R4: `failure_standing` catches the supervisor up on a failure or hold with work waiting that it was never told of, at Act, as the level becomes Act, a run starts or continues, a level is set after a stopped run, or the run goes idle; one wake, each task once.
- 2026-11-22 — R4: the catch-up leaves out a hold a call left (Stop, revert, mark not done), which is `run_held`'s.
- 2026-11-22 — R4: a call that starts a task again ends the catch-up's leaving out of its hold, so a hold its failed start leaves is caught up.
