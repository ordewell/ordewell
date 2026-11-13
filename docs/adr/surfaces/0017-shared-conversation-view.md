---
status: accepted
---

# 0017 — The shared conversation view, drawn once in core

## Problem

The planner conversation existed for a long time (ADR-0002), but what a surface
showed of it was each surface's own business. The TUI and the VS Code webview
each accumulated their own presentation state out of the `SessionMessage`
stream — and that accumulation diverged: one surface rendered a research step
the other dropped, a retransmit on reconnect showed blocks one surface had
already settled, and every new message type had to be taught to both
renderers. Replies were opaque to boot: before #48, a harness planner's
prose arrived only when the turn settled, and before #49 nothing on screen said
what a session had consumed, even where the runner reported it honestly.

## Decision

**Build the view once in core and draw it per surface.** Core owns
`reduceConversation` (ADR terms: the [conversation view](../../../CONTEXT.md)) which
folds every `SessionMessage` — plus a surface's own local entries — into an
ordered list of **display blocks** (`core/src/conversation/blocks.ts`):
messages, thinking, tool rows, subagent blocks with their children, approvals,
plan markers, and the one usage line. A surface adapts the block list to its
own presentation; it never re-derives the conversation from raw messages.

- **Turns, segments, retractions (E1).** A planner turn
  (`planner_turn_started` … `planner_turn_ended` under one `turnId`) is the
  unit of streaming. Reply text arrives as `segmentId`-keyed segments whose
  accumulated text a settled `planner_message` settles in place; a turn can
  retract streamed text (`planner_text_retracted`) without ending. The stream
  stays provisional and the settled messages authoritative.
- **One message per meaning (M1).** Thinking is `planner_thinking_delta` from
  every backend — `segmentId` where the backend streams it in segments (the API
  loops), none where it does not (harness planners) — and the view folds a run
  of it into one block either way. `plan_token` means only the "building plan"
  display (J1); prose streamed outside a turn is not sent at all, since no
  surface draws it. A second name for the same thing made every consumer
  handle both, and the one that forgot (`plan --verbose`) dropped a backend's
  thinking silently.
- **`planner_message` stays authoritative (A1).** When a turn settles, the
  message carries the reply's runs: every run of reply text the turn's
  surviving calls streamed, in order, each with its segment and the time it
  began — for an API planner the text before its tool calls and the final
  segment, for a harness planner every run, text from turns continued while it
  waited for background agents included. Each run's text settles its own
  segment in place, wherever in the turn it streamed; only a run that never
  streamed (a note the conversation wrote in the planner's place) goes last,
  and a segment the reply no longer contains goes. `content` stays the whole
  reply as the planner is told it, so whatever prints, replays or compacts the
  reply is unchanged. Settling never takes a run back. A corrective retry takes
  back only what it answers in place of — the discarded attempt's reply and the
  plan display it streamed — never the narration before that attempt's tool
  calls, which stays and is saved with the turn's reply. The settled runs are
  saved where they streamed: the reply's transcript entry keeps each run's text
  and start time beside its content. Streamed text that was retracted or that
  the turn's classification overruled is never written, so a reloaded session
  cannot resurrect it. A message without runs (a note, an older daemon)
  replaces the turn's final segment.
- **JSON envelopes stream as `plan_token` (J1).** A reply that is a plan or
  task-ops envelope never decays into visible prose; it is the "building plan"
  display, and becomes a plan marker block when it settles.
- **Usage only from reports (U1).** Usage records carry only what a provider or
  runner itself reported — tokens, cached tokens, a stated context window,
  a stated cost. A source's own estimate is shown as stated, marked `≈`; a
  billed amount has no mark. A cost whose every contribution ran on a
  subscription reads `≈$7.89 API-equivalent`. The ledger keeps the reported
  cost's provenance per currency (any estimate marks the sum), and the runner's
  session billing fact with the source and the planner or attempt it belongs
  to, saved and broadcast even without a cost, so a backend switched to before
  its first cost is not shown as the old one's subscription. No price table or
  estimate made by Ordewell: prices go stale, and a subscription runner has no
  per-token price at all. Absent means "not reported", never zero. A turn's
  `result` states its own token sum: a call whose usage did not stream is taken
  from it once, as a turn total that never moves the meter. The usage line is one `usage` block, always last. Every
  count stays in the ledger, the saved session and the broadcast, but surfaces
  draw none of them: they draw the main model's context (`ctx 61k (6%)`, the
  share only when the window is known, nothing before a call was measured) and
  the cost its runner reported, worded once in core (`usageText`) so the TUI,
  `ordewell status` and VS Code cannot disagree. The meter is derived only from
  the main model's own calls, never a subagent's or a session breakdown's. It
  counts what a call left in the context the way that runner's own UI counts
  it, shows what a compaction left or nothing until the next call, and reads a
  window any stream of the Ordewell session was told for that model, saved with
  the plan. The plan's Tasks total is the cost summed per currency, followed by the runners
  that reported none (`codex reports no cost`) once an attempt of theirs has
  ended having reported usage; a price table stays forbidden.
- **The saved subset for reload (R1).** `fromTranscript` rebuilds the view a
  session reopens with from its persisted transcript, research log and pending
  turns: settled messages — a reply run by run, each at the time it began among
  the tool rows, and an entry saved without runs as one message after the
  research it settled — tool rows, subagent blocks and digests, then inputs
  still waiting for a turn to land, and the usage line. Pending user messages
  keep their skill-load notices; wake-up digests keep their run-update role.
  The live view adopts these inputs when their turn starts or its transcript
  lands, so each input is drawn once. It
  deliberately leaves out thinking and everything that streamed and never settled —
  no `transcriptAt` beyond what the transcript itself records, and no reliance
  on the in-flight view. What reload shows is what was saved, not what was seen.
- **Expansion is surface state, collapsed by default (X1).** A command row
  reads `Name(keyArg)` with a short preview, and a subagent is one line and its
  digest. The TUI keeps one detail toggle, ctrl+o, that shows every block's
  arguments, full output, subagent children and digests at once. VS Code folds
  each run of activity between two messages — thinking, calls, subagents,
  setup notices, a runner's compaction notices, answered approvals — into one line that
  says what it did (`Ran 4 commands, fetched 2 pages (2 failed)`), counted
  from the blocks' own facts: a call by its kind and how it ended, and never
  as run when it was refused, denied or not executed (`1 command denied`,
  `Ran a command (1 more not run)`); an Ordewell tool the same whichever
  planner called it; a subagent once, never its steps; a `load_skill` call
  and its notice once; a granted approval only when no call stands beside it,
  and a denial once: on the call it stopped when that call stands beside it
  (a runner's call its denied request names reads `1 command denied`, though
  its result came back failed), and as the approval otherwise; and work still
  running as running. A line with a
  failure, denial or interruption in it is coloured as one. Opening the line
  draws its rows as the TUI's collapsed previews; each row, each of a
  subagent's steps and each long report opens on its own. A waiting approval,
  an error, other notices, the skills a user's own message loaded and every
  message stay outside any fold. A script task's log folds nothing and opens
  nothing: it is commands, their output and their exits (ADR-0035), with no
  prose for a fold to keep in view, so each row is drawn whole, its command
  once, in its head, with no arguments block repeating it. What is open
  is surface state, keyed on block ids that stay stable for as long as the
  block exists — a run by the ids of the blocks it holds — never stored in
  core, and dropped when the conversation is replaced (a new session or a
  reload, whose blocks are numbered afresh) or another attempt is shown. A
  compaction replaces nothing (C1), so what was open stays open.
- **A compaction is one quiet block where it happened (C1).** The planner's
  compaction reaches a surface as `planner_compaction`, one phase at a time
  under one stable id. Ordewell's own announces `started`, then `ended` with
  its outcome (condensed, pruned, unchanged, stopped, failed or paused), and
  the checkpoint a condensed one writes carries the same id (ADR-0002); an API
  planner's automatic one is announced in the turn it happens in, and a
  pruning, over as it begins, reports only its end. A
  harness planner's native compaction is reported only as `ended`, with the
  sizes it stated, because that is all its protocol says: no start, summary or
  size is invented, and a subagent's never reaches the planner's view. The
  view folds both phases and the transcript entry into one `compaction` block
  by that id, so a phase heard twice, or the transcript first, draws one
  block; an end that changed nothing draws nothing in a view that never saw it
  start, one that had nothing to do takes its block back, and a turn cut short
  closes one still running. A turn let go while it compacts announces that
  compaction's end, as stopped, before its own, so a surface joining later is
  not told it still runs. While it runs a surface says so (`Compacting
  context…`) where it says a turn is working, and the planner is held as in a
  turn: Stop stops it and a message waits for it. Once over it is a quiet line
  of its own, outside any fold (`Context compacted`, with sizes only when both
  were reported), worded once in core (`compactionText`); its summary opens
  from it and is never shown whole, and no notification announces a routine
  success. The transcript keeps every message (ADR-0002), so nothing is
  rebuilt: the draft, the scroll position, task output and what was open stay.
  A reload draws the same block from the transcript, a legacy summary first as
  before. A native or pruning compaction, and one that condensed only a
  turn's own rounds, is display-only: never written, so it never touches what
  the planner replays. A surface that joins while one runs
  is owed its start, which `Session.plannerCompaction()` holds until its end,
  as announced approvals are held. The daemon hands it on three ways, all the
  start as announced: beside `plannerTurnId` in the answers to a session's
  read and adoption, and as the frame after the run snapshot when a socket
  joins, unstamped so the fold, idempotent by id, never counts it as a
  broadcast it already holds. The TUI folds the events as the view does, with
  no redraw: its status is `compacting` for one it did not ask for (its end
  frees the planner and sends what was typed meanwhile) and `condensing` for
  its own `/compact`, which the call's answer settles, carrying the plan whose
  transcript holds the summary should a frame have been lost. A call that
  fails closes the block it left running. Reconnecting during one, or reading
  a lost reply back, adopts the running one without a redraw; when the daemon
  holds none and the transcript has no checkpoint for it, the block goes, since
  nothing is known to have happened. In the terminal the line is quiet and
  its summary opens with the detail key (ctrl+o).

### Queued prompts

A prompt typed while a planner turn is in flight is held, the same way on both
surfaces. (It used to be the TUI's alone, its reducer taking from both ends of
an array by hand, while VS Code locked the input for the whole turn and showed
"queued" only for the Session's run-time edit queue — a different thing under
the same word.)

- **One hold, in core (Q1).** `conversation/promptHold.ts` owns the queue as a
  plain immutable list with its operations: hold, unsend the newest, and take
  everything at once, glued in the order typed. It is pure, so the TUI keeps
  it in reducer state and the chat views' host keeps it in a field; neither
  re-implements the ordering, and both join through its one `glued`.
- **The host holds it in the chat views (Q2).** In VS Code and the desktop app,
  which draw the same chat, `ConversationViewHost` holds the prompts the chat
  sends with `holdPrompt` and draws them through `heldPrompts`. The TUI holds
  the same list in its reducer, for the planner chat and for a subplanner's.
  On every surface what is held goes as one message, the prompts glued in the
  order typed: when the host's
  handling of the turn has returned — not on `planner_turn_ended`, which
  arrives while the turn is still unwinding — and on Send now, which glues the
  composer's text, possibly empty, last and stops the turn in flight to answer
  it (`sendMessageNow`; with no turn in flight it is a plain send). A stop
  gives everything held back to the composer instead. A Send now that is
  refused or fails gives what it took back to the composer too; one whose turn
  was stopped by another, or discarded because its session was left, does
  not, since there is nothing left to answer it. Core's `sendNowGivesBack`
  is that one rule, read by the TUI's reducer and by ui's `ChatSessionHost`,
  which runs the hold, Send now and release for both chat views over their
  own session (the in-process Session, or the daemon). The same host answers
  the plan cards' system commands, Mark complete / Mark not done, Revert and
  Force start included, asking their confirmations through the surface's own
  dialog and sending each as one command at the seam, so VS Code and the
  desktop app keep only the transport. Merge all is the host's as well: its
  opening question, then whichever question the seam holds the merge for (past
  unpassed checks, beside a running ops task), asked once each in the order the
  seam raises them, and a no at any of them leaves the run untouched. Each
  surface answers only the call itself, and a hold that comes back after its
  yes is the seam's refusal, thrown for the surface to say. The host,
  not the chat, decides what goes and what comes back, so a prompt already sent
  cannot also reappear in the input. A new or reloaded session drops the hold
  with the view.
- **The same keys on every surface (Q3).** The input stays live during a turn.
  Esc takes back only the newest queued prompt while one is waiting; otherwise
  the first Esc warns and a second within about two seconds stops the turn.
  Outside a turn Esc clears the input, as before. The taken-back prompt fills
  the composer only when the composer is empty, and is discarded over a draft
  (`unsendPrompt`'s `toComposer` in the chat views), so it never buries what is
  being typed; the × on the newest held row does the same. Send now is
  Ctrl+Enter, or Cmd+Enter on macOS, and ctrl-s in the TUI; it is offered
  whenever a turn runs and there is text typed or something held, and sends
  everything held, then the draft, as one message. The held list carries one
  control that does it ("Send all now"). In a task chat or a subplanner's, the
  TUI's Esc empties the queue first, then clears the draft, then goes back.
- **No list for mid-run edits (Q4).** A message sent during a run is a live
  planner turn (ADR-0029), taken at once, so nothing waits for a batch
  boundary and no surface lists edits above the input. The prompt hold above
  is the only thing a surface draws as queued.

## Considered options

- **Per-surface views, one per client.** That was the status quo: two
  accumulators drifting, and every new message type rendered differently in
  each. The view is also what lets a reloaded session and a live one draw the
  same way — two implementations would have to re-prove *that* separately.
- **A price table for cost estimates.** A model id does not fix what it costs
  (routing, caching and subscriptions all change it), so any table's answer
  would be fiction presented as a number. Cost shows only where a source
  reported its own.
- **Persisting the full event log** so reload could replay it. It would save
  every streamed semi-state (deltas, retractions, thinking) at persist time
  forever, and freeze the message stream into an interface a transcript format
  change could never shed. The transcript is the record; the view over it is
  derived.
- **A component-tree TUI** (see [ADR-0006](0006-tui-pure-core-thin-driver.md)).
  Rejected there per D1; the conversational view strengthens the point — a
  block list is renderable as strings, and that is all the renderer has ever
  needed from a state.
- **Per-block focus and expansion in the TUI** — one expanded flag per
  block, navigated with keys, remembered per block. It is more keys and more
  state than a terminal needs: there a user wants *all* the detail or *none*,
  and the user chose a single toggle, as in Claude Code. A terminal has no
  pointer to open one row with, so ctrl+o stays.
- **One expand-all toggle in VS Code** (the design until 2026-10-25: a header
  button, the TUI's ctrl+o by another spelling). A long turn drew every row
  of every call, so the planner's and the agent's words were lost among them;
  and the toggle could only show everything, which buried the one row a
  reader opened it for under every other row's full output. A pointer can
  open one row, so the webview folds each run of activity into a sentence and
  opens one level at a time. The open choices live in the webview, keyed on
  block ids, and are dropped with the conversation they belong to.
- **Every run of activity open, its rows collapsed.** It keeps each call one
  line, but a fifty-call turn is still fifty lines between two sentences of
  prose.
- **Counting what a call ran** (`curl` three times in one script as three
  pages fetched). A script's contents are free text; a summary that guessed
  at them would claim work nobody saw done. A call is counted by its tool's
  kind, as its row is named.
- **One settled message per reply, replacing its final segment** (the design
  until 2026-10-18). A harness planner's reply joins the text on both sides of
  its tool calls, so one message could not replace one segment: the turn's
  other segments were taken back first, and the joined reply landed after the
  last tool row — live, and again on reload, since the transcript stamped it
  at commit time. It read as said after the calls it announced. A corrective
  retry took back every segment the turn still showed, an API planner's
  narration between its tool calls included. Settling run by run keeps
  `content` whole for everything that keys on it.
- **Holding queued prompts in the webview.** It cannot tell whether the turn has already
  ended on the host, and the host is where a held prompt has to be sent from.
- **One held prompt per turn, and a Send now on each row.** That was the
  design until 2026-11-10, in the chat views, and in the TUI until the same
  day's integration, whose ctrl-s sent only the newest: a turn's end drained
  only the oldest, and a row's Send now force sent that one prompt, leaving the
  rest held. Prompts
  typed during one turn are usually one thought said in pieces, so the planner
  answered the first piece in a whole turn before reading the rest, and a row
  sent ahead of the ones typed before it. Ctrl/Cmd+Enter also needed text in
  the composer, so with only held prompts it did nothing at all.
- **A mutable queue object in core.** The TUI reducer would have had to copy it
  on every action to stay pure; a list with functions over it suits both
  surfaces as is.

## History

- 2026-09-27 — accepted; queued prompts moved into core the same day.
- 2026-10-11 — the pending plan edit list removed with the queue behind it ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-11 — reload includes pending turn inputs and adopts them on replay or settlement.
- 2026-10-16 — a surface that (re)joins a session is given its live state as well as its transcript. The session socket greets with the planner's approval requests still waiting beside the run (its held edit's preview included), and numbers every broadcast per session; the TUI tells one broadcast's copies apart by that number rather than by content, and reconciles its cards and approval prompt with the greeting on every load. A reloaded VS Code webview replays the waiting requests after the transcript, and drops a card answered while it was away. Seen live: a TUI that reconnected kept the preview of a proposed task the session had already dropped, and a webview reload erased a waiting card nothing could then answer.
- 2026-10-18 — a reply settles run by run where each streamed, and its transcript entry keeps its runs beside its content (A1, R1); a corrective retry keeps the narration before a discarded attempt's tool calls. Seen live: a coding-agent planner's "I'll read README.md now" sat below the Read row it announced, joined with the rest of the turn, live and after a reload.
- 2026-10-19 — surfaces draw the main model's context and the reported cost only, no token count (U1). Seen live: a task whose context grew from 28k to 61k over 24 calls showed 1.19M in / 1.13M cached, because every call's full prompt, cache reads included, was added up.
- 2026-10-19 — stated costs distinguish a source's estimate from billing, and subscription equivalents from per-call spend; the ledgers retain runner-session billing facts (U1).
- 2026-10-19 — the meter counts a call's context as its runner does and resets on a compaction, and a window reported anywhere in the session is known to every later stream (U1). Claude Code states a window only on a turn's last line, so a task, often one long turn, showed no share for its whole run even with the planner on the same model.
- 2026-10-19 — a turn whose calls did not stream has their tokens taken once from its result (U1). A session billing fact is kept with the source that stated it, so a planner switched before its first cost is not shown as the old one's subscription.
- 2026-10-19 — the Tasks total names a runner as reporting no cost only once an attempt of it has ended having reported usage (U1). Claude Code states a cost only at a turn's end, so a first Claude Code task read as `claude-code reports no cost` for as long as its turn ran.
- 2026-10-25 — VS Code folds each run of activity into one summarised line, opened a level at a time, in place of its expand-all button; the TUI keeps ctrl+o (X1). A long turn's rows buried the prose between them, and showing everything was the only way to see one row in full.
- 2026-10-25 — a script task's log is drawn whole, unfolded; a summary never counts a call that did not run as run and keeps a denied approval; a failed line is coloured; a compaction drops what was open (X1). Found in review: a failing script's output was hidden behind one closed line, and a denied command read `Ran a command`.
- 2026-10-25 — a denial is counted once, on the call it stopped when that call is in the line, and a script row draws its command once (X1). Found in review: a runner's denied command read `Ran a command (1 failed)` beside its denied approval, and a planner's denial was counted twice.
- 2026-10-25 — a planner compaction is one quiet block folded in by id where it happened, with its start and end announced, Stop and queued messages as in a turn, and nothing rebuilt (C1). Before it, `/compact` rebuilt the whole VS Code conversation, collapsing what was open, behind a progress notification and a success popup, and a harness planner's own compaction was not shown at all.
- 2026-10-25 — the daemon carries a running planner compaction in its read, adoption and socket-join answers, and the TUI folds the lifecycle without a redraw, holding the planner and its queue until the end (C1). Before it, `/compact` redrew the TUI conversation and reset its scroll, a surface that joined mid-compaction saw a silent planner, and a lost reply was read back as a lost turn.
- 2026-10-25 — C1: an API planner's automatic compaction is announced in its turn, a pruning by its end alone, and one that condensed only the turn's own rounds is never written ([ADR-0002](../planner/0002-planner-as-conversation-loop.md)).
- 2026-10-25 — C1, found in review: a turn let go mid-compaction ends it as stopped, and the TUI keeps a session loaded mid-turn held until that turn ends, whatever compacts inside it. Before it, the session reported the compaction running for good, and an in-turn compaction's end freed the TUI's planner and sent a held prompt while the turn ran.
- 2026-11-10 — Q1-Q3: the chat views send everything held as one message, glued in the order typed, at a turn's end and on Send now, which needs no composer text; Esc and the newest row's × refill only an empty composer. Seen live: Cmd+Enter did nothing in VS Code's planner chat with prompts held and the composer empty.
- 2026-11-10 — Q1-Q3: the TUI follows the same rule, in the planner chat and a subplanner's: a turn's end and ctrl-s send everything held as one message (ctrl-s with or without a draft), Esc takes back only the newest, and the held rows and the task chat's queue draw one "Send all now" control with the same wording. Before it the docs kept a carve-out: one prompt per turn, ctrl-s on the newest.
- 2026-11-13 — the notice a run message earns (a task started, the plan awaiting sign-off or approved, a run finished or stopped) is worded once in core's `runNotice`, which the TUI and `SessionView` both call, and a task already shown at work is not announced a second time. Before it the TUI alone deduped a start and worded the other three, so VS Code and the desktop app said a start on every message and nothing for the rest.
- 2026-11-13 — Q2: one give-back rule for Send now on every surface (core's `sendNowGivesBack`) and one `ChatSessionHost` in ui for both chat views; the TUI no longer gives back a forced send whose turn was discarded, as the desktop already did.
- 2026-11-13 — Q2: the plan cards' system commands and Mark complete / Mark not done, Revert and Force start are `ChatSessionHost`'s too, one copy for VS Code and the desktop app; a refusal is said by the surface, and a failed command no longer skips the release on the desktop.
- 2026-11-13 — Q2: Merge all, its opening question and the questions it is held for (unpassed checks, beside a running ops task) are `ChatSessionHost`'s too, through ui's `MergeAll`; VS Code and the desktop app answer only the merge call. A hold repeated after its yes now throws the seam's words on both, where the desktop rethrew the daemon's refusal and VS Code fell through to its failed-outcome error.
