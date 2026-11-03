# The Ordewell desktop app — design

This spec fulfils [#136](https://github.com/ordewell/ordewell/issues/136), the
design for the orchestration-first desktop app asked for in
[#129](https://github.com/ordewell/ordewell/issues/129). Every implementation
task for the app reads it. The decisions behind it are recorded in three ADRs:

| ADR | Title | Rules |
|---|---|---|
| [ADR-0060](../adr/surfaces/0060-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md) | The desktop app is an Electron client of the shared daemon, and its renderer never holds the token | H1–H7 |
| [ADR-0061](../adr/surfaces/0061-a-host-reads-files-and-git-for-the-user-confined-to-the-workspace.md) | A host reads files and git for the user, confined to the workspace and needing no lease | R1–R6 |
| [ADR-0062](../adr/isolation/0062-user-git-actions-are-confirmed-at-a-host-and-a-live-run-holds-only-its-landing-branch.md) | User git actions are confirmed at a host, and a live run holds only its landing branch | G1–G11 |

The vocabulary is [CONTEXT.md](../../CONTEXT.md)'s. The terms this design adds
there are *Desktop app*, *Daemon bridge*, *Version handshake*, *Needs you*,
*View scope*, *User principal*, *User's checkout*, *Landing branch*, *Live run*,
*Merge all preflight* and *User git action*. A word this spec uses in a
different sense from CONTEXT.md is a bug in this spec.

## Contents

- [Shape of the app](#shape-of-the-app)
- [Wireframes](#wireframes)
- [Task row and node contents](#task-row-and-node-contents)
- [Status vocabulary](#status-vocabulary)
- [Design tokens](#design-tokens)
- [Icons](#icons)
- [Keyboard and screen readers](#keyboard-and-screen-readers)
- [The scope model](#the-scope-model)
- [IPC bridge](#ipc-bridge)
- [Daemon routes](#daemon-routes)
- [The terminal rule](#the-terminal-rule)
- [Out of scope](#out-of-scope)
- [Slices](#slices)

## Shape of the app

The app is `packages/desktop`: Electron 45.x, built with electron-builder. Its
main process is a client of the shared local daemon (`packages/web`) on
`127.0.0.1:3742`. It attaches to a daemon that is already running, or starts and
owns one (ADR-0060 H1, H2), after a version handshake (H3). The renderer holds
no token. It reaches the daemon only through the daemon bridge (H4). The
renderer's UI is `packages/ui`, which the VS Code webview also draws (H7).

```
 ┌─ Electron main ───────────────────────────┐        ┌─ daemon (packages/web) ─┐
 │ attach-or-own · handshake · token          │  HTTP  │ Sessions (lease holder) │
 │ route table → bearer request, no Origin    │◀──────▶│ /api/* · /ws/session/*  │
 │ WS per session → frames over IPC           │   WS   │ workspace reader (0061) │
 │ node-pty terminals · dialogs · tray        │        │ user git actions (0062) │
 └──────────────┬────────────────────────────┘        └─────────────────────────┘
                │ contextBridge: window.ordewell (fixed, named calls)
 ┌─ renderer (sandboxed, CSP 'self') ────────┐
 │ packages/ui: components · view state ·     │
 │ tokens · protocol · HostBridge             │
 │ host-neutral view assembly ← daemon frames │
 └────────────────────────────────────────────┘
```

### Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  acme-app › web › main ▾   [Scope: Your checkout ▾]          (◆ 2 Needs you)  [ Run ▶ ][⋯]│ title bar
├──┬────────────────────┬──────────────────────────────────────────────────┬────────────────────┤
│▣ │ SIDEBAR            │ [📌 Plan ✕] [#3 Add login ✕] [auth.ts ✕] [Δ #3]  │ PLANNER          ⇥ │
│  │ (contextual: Plan, │ ┌──────────────────────────────────────────────┐ │                    │
│⎘ │  Explorer, Changes │ │                                              │ │ conversation with  │
│  │  or Git)           │ │              MAIN AREA (tabs, split)         │ │ the planner        │
│⑂ │                    │ │                                              │ │                    │
│  │                    │ └──────────────────────────────────────────────┘ │ ┌────────────────┐ │
│⑃ │                    ├──────────────────────────────────────────────────┤ │ Message planner│ │
│  │                    │ TERMINAL (hidden by default, Ctrl+`)             │ └────────────────┘ │
│⚙ │                    │                                                  │                    │
├──┴────────────────────┴──────────────────────────────────────────────────┴────────────────────┤
│ ● daemon :3742 (attached, 0.13.0)   lease: this daemon   runners: claude-code ✓ codex ✓   5h: 40%│ status bar
└──────────────────────────────────────────────────────────────────────────────────────────────┘
  ▣ Plan  ⎘ Explorer  ⑂ Changes  ⑃ Git  ⚙ Settings (bottom)          — activity bar glyphs
```

- **Activity bar.** Plan, Explorer, Changes and Git, with Settings at the bottom.
  The active item is a teal stroke on a tinted pill. A count badge on Changes
  shows the checkout's changed files. The Plan item shows a dot while a run is
  live.
- **Sidebar.** Its content follows the activity bar. *Plan* shows Needs you at
  its head, then the session picker and the task outline. *Explorer* shows the
  scope's tree. *Changes* shows the checkout's changes and the commit box, or a
  run's or task's changed files in a run scope. *Git* shows branches, stashes
  and remotes. It collapses with Cmd/Ctrl+B.
- **Main area.** Tabs. The *Plan* tab is pinned and switches between List and
  Graph. Task, file, diff and commit-graph tabs open beside it. A single click
  opens a preview tab, shown in italics, which the next preview replaces; a
  double click, or an edit, keeps it. Tabs split side by side.
- **Title bar.** The breadcrumb workspace › repository › branch, with the
  repository and branch as menus. Then the scope switcher, the Needs you badge,
  and one primary action with the rest in a `⋯` menu. On macOS the traffic
  lights are inset in the bar; on Windows and Linux the bar is a title-bar
  overlay with native window controls.
- **Primary action.** Exactly one, chosen by the session's state, in this order:
  *Approve plan* when a draft waits for approval; *Run* when an approved plan is
  not running; *Stop* while a run is live; *Review & Merge all* once a run has
  settled with unmerged landings. Everything else is in `⋯`: Retry failed,
  Clean up, Discard run, New session, Close session, Open in editor, Reveal in
  Finder or Explorer.
- **Planner panel.** On the right, collapsible with Cmd/Ctrl+L, which also
  focuses its composer. It is always the planner conversation, never a task's
  chat, which opens as a task tab.
- **Terminal panel.** At the bottom, hidden by default and toggled with Ctrl+\`
  ([The terminal rule](#the-terminal-rule)).
- **Status bar.** The daemon (attached or owned, its version, connection state),
  the lease holder of the open session, the runners and whether each is signed
  in, and the account usage limits (`AccountLimitRows`). Each item opens its
  detail.
- **Command palette.** Cmd/Ctrl+K: every command, with its shortcut, plus quick
  open of tasks (`#3`), files and branches.

## Wireframes

Every wireframe states what it shows, its actions, and its loading, empty and
error states. Where a state is the shared one below, it says so.

**Shared states.** *Loading* is a skeleton of the final layout, with grey bars
in place of text and no spinner for loads that finish quickly. A load still
pending after a moment shows a muted "Loading …" line naming what loads.
*Error* is an inline banner in the region that failed, with the daemon's message
as given, a Retry, and a *Details* disclosure with the route and status. A
disconnect replaces every region's error with the [Reconnecting](#w15-daemon-disconnected-reconnecting)
bar, so no region claims a failure of its own.

### W1. Welcome and open project

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●                                Ordewell                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                        ⟡  Ordewell                                           │
│                        Turn one goal into an ordered plan of agent tasks.     │
│                                                                              │
│      [ Open folder… ]   [ Clone… (later) ]                                   │
│                                                                              │
│      Recent                                                                  │
│      ┌────────────────────────────────────────────────────────────────────┐ │
│      │ ⟡ acme-app        ~/code/acme-app        ● run live · 2 Needs you  │ │
│      │ ⟡ billing         ~/code/billing         last session yesterday    │ │
│      │ ⟡ infra           ~/code/infra           ⚠ folder missing    [✕]   │ │
│      └────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│      Runners   claude-code ✓ signed in   codex ✓   opencode ✕ not installed  │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ ● daemon :3742 (owned, 0.13.0)                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Shows.** Recent workspaces with their live state from the daemon (a live run,
  a Needs you count), the runners and whether each is signed in, and the daemon.
- **Actions.** *Open folder* is a native picker (`dialog.pickFolder`). Opening
  a workspace already open in a window focuses that window (H6). A recent entry
  opens on click. A missing folder can be removed from the list. A runner that
  is not signed in links to its sign-in, as the chat does (ADR-0052).
- **Loading.** The recent list draws from the app's own store at once; the live
  state fills in after the handshake.
- **Empty.** No recent workspaces: only *Open folder*, with one line on what a
  workspace is (a folder, usually a git repository).
- **Error.** A folder that is not a git repository still opens, and the
  isolation preview later says it runs without isolation. A handshake failure
  shows the [mismatch](#w15-daemon-disconnected-reconnecting) card here in place
  of the list.

### W2. Session while planning

```
┌ acme-app › web › main ▾   [Scope: Your checkout ▾]                    [Approve plan ✓][⋯] ┐
├──┬──────────────────┬───────────────────────────────────────────────┬─────────────────────┤
│▣ │ NEEDS YOU (0)    │ [📌 Plan]                    List | Graph      │ PLANNER   claude ▾  │
│  │ SESSION          │ ┌────────────────────────────────────────────┐ │                     │
│⎘ │ Add SSO login ▾  │ │ Draft plan · 4 tasks · still drafting …    │ │ You: Add SSO login  │
│  │                  │ │                                            │ │ with Okta to web    │
│⑂ │ OUTLINE          │ │ ○ #1 Read the auth module   Research       │ │                     │
│  │ #1 Read the auth │ │      claude-code · sonnet · low            │ │ Planner: I'll start │
│⑃ │ #2 Add SAML …    │ │ ○ #2 Add SAML callback route               │ │ by reading …        │
│  │ #3 Add login btn │ │      codex · gpt-5 · medium   ⇠ #1         │ │ ▸ read src/auth/*   │
│  │ #4 ░░░░░░░░░░░   │ │ ○ #3 Add login button       ⇠ #2           │ │ ▸ 3 research steps  │
│  │                  │ │ ░ #4 ░░░░░░░░░░░░░░░░░░ (streaming)         │ │                     │
│⚙ │                  │ └────────────────────────────────────────────┘ │ ┌─────────────────┐ │
│  │                  │                                                │ │Message planner …│ │
│  │                  │                                                │ └──[Stop planning]┘ │
├──┴──────────────────┴───────────────────────────────────────────────┴─────────────────────┤
│ ● daemon :3742   lease: this daemon   planner: claude-code · sonnet   5h: 40%             │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Shows.** The planner conversation on the right, with its research steps
  folded, and the draft plan in the Plan tab as it streams, a partial task drawn
  as a skeleton row. The planner, its model, its context fill and its usage
  (`UsageLine`) sit in the panel header.
- **Actions.** Message the planner; send now; stop planning; switch planner and
  model; fork, rewind or compact the conversation (panel `⋯`); edit a task
  inline in the draft; *Approve plan* once drafting ends. A planner question
  with options draws as buttons in the conversation.
- **Loading.** A turn in flight shows the planner's live step ("reading
  src/auth …") and Stop; the draft fills in row by row.
- **Empty.** A new session: the panel shows the composer with the
  `composerTips` line and the planner picker; the Plan tab shows "No plan yet —
  describe a goal to the planner" and the run settings block.
- **Error.** A planner turn that fails shows the failure in the conversation,
  with Resend; a usage limit shows the `PlannerPauseBar` (ADR-0044); a signed-out
  planner shows `PlannerLogin` (ADR-0052).

### W3. Plan approval

```
┌ acme-app › web › main ▾   [Scope: Your checkout ▾]           (◆ 1)  [Approve plan ✓][⋯] ┐
│ [📌 Plan]                                                    List | Graph              │
│ ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Plan ready for approval · 4 tasks · 2 runners                                        │ │
│ │ Isolation: worktree per task in web, api (2 repos) · lands on main in each           │ │
│ │ Run settings: 2 at a time · supervisor Observe · merge automatically off  [Edit]     │ │
│ ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ ○ #1 Read the auth module        Research   claude-code · sonnet · low      [✎]      │ │
│ │ ○ #2 Add SAML callback route                codex · gpt-5 · medium  ⇠#1  [✎]        │ │
│ │ ○ #3 Add login button                       claude-code · sonnet    ⇠#2  [✎]        │ │
│ │ ○ #4 Run the e2e suite           Script     npm run test:e2e        ⇠#2 #3 [✎]      │ │
│ ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ ⚠ #4 is a script: it runs `npm run test:e2e` in its worktree.  ☐ I have read it      │ │
│ │                                         [Ask planner to change…]  [Approve plan ✓]   │ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘ │
```

- **Shows.** The whole plan, the isolation preview (`GET
  /api/workspaces/isolation-preview`: repositories, the branch each lands on, or
  why it runs without isolation), the run settings, and the
  `PlanApprovalNote`, including any script or effect that needs reading
  (ADR-0035).
- **Actions.** Approve (`POST review/approve`); edit any task inline; edit run
  settings; ask the planner for a change, which focuses the composer.
  *Approve plan* stays disabled until each effect the note lists is ticked.
- **Loading.** The isolation preview line shows "Checking repositories …".
- **Empty.** Not reachable: a plan with no tasks shows W2's empty state.
- **Error.** A plan that fails validation lists each problem against its task,
  and approval stays disabled.

### W4. Run in progress — List

```
┌ acme-app › web › main ▾ [Scope: Your checkout ▾]               (◆ 1 Needs you) [■ Stop][⋯] ┐
├──┬────────────────────┬───────────────────────────────────────────────────────────────────┤
│▣ │ NEEDS YOU (1)      │ [📌 Plan]          List | Graph        2 running · 1 passed · 1 ○  │
│  │ ◆ #2 approval:     │ ┌───────────────────────────────────────────────────────────────┐ │
│⎘ │   run `npm i saml` │ │ ✓ #1 Read the auth module   Research  claude-code·sonnet      │ │
│  │   [Allow][Deny]    │ │      Passed · handoff: 3 findings                    2m 10s   │ │
│⑂ │                    │ │ ◆ #2 Add SAML callback route        codex·gpt-5·medium  ⇠#1   │ │
│  │ OUTLINE            │ │      Needs you · approval: npm i saml    [Allow][Deny][Open]  │ │
│⑃ │ ✓ #1               │ │ ◐ #3 Add login button               claude-code·sonnet  ⇠#2   │ │
│  │ ◆ #2               │ │      Running · editing src/Login.tsx           ▸ peek  1m 02s │ │
│  │ ◐ #3               │ │ ○ #4 Run the e2e suite    Script     ⇠#2 #3                    │ │
│  │ ○ #4               │ │      Not started · waits on #2, #3                            │ │
│⚙ │                    │ └───────────────────────────────────────────────────────────────┘ │
```

- **Shows.** One row per task with the [row contents](#task-row-and-node-contents),
  a run summary in the tab header, Needs you at the head of the sidebar, and the
  outline mirroring the list's selection.
- **Actions.** Every row action of the parity list; select a row (↑/↓); Enter
  opens the task tab; Space toggles the output peek; Stop in the title bar (asks
  first, naming the running tasks).
- **Loading.** On opening a session with a live run the list draws from
  `run_snapshot` at once; nothing is shown as running until the snapshot says
  so.
- **Empty.** Not reachable while a run is live.
- **Error.** A row's command that is refused shows the refusal under that row
  for a few seconds and in the row's history, never as a toast elsewhere.

### W5. Run in progress — Graph

```
│ [📌 Plan]          List | Graph            ⌖ fit  ◇ critical path  ▤ minimap               │
│ ┌──────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │                                                                                          │ │
│ │  ┌──────────────────┐      ┌────────────────────┐      ┌──────────────────────┐         │ │
│ │  │✓ #1 Read the auth│━━━━━▶│◆ #2 Add SAML route │━━━━━▶│◐ #3 Add login button │━━┓      │ │
│ │  │ Research · sonnet│      │ codex · gpt-5      │      │ claude-code · sonnet │  ┃      │ │
│ │  └──────────────────┘      │ Needs you          │      └──────────────────────┘  ┃      │ │
│ │                            └────────────────────┘ ───────────────────────┐       ▼      │ │
│ │                                                                     ┌────────────────────┐│ │
│ │  ┌─────────────────────────┐                                        │○ #4 Run e2e suite  ││ │
│ │  │▸ #5 Billing (child plan)│  3 tasks · 1 running                   │ Script · ⟲ 1/3     ││ │
│ │  └─────────────────────────┘                                        └────────────────────┘│ │
│ └──────────────────────────────────────────────────────────────────────────────────────────┘ │
│   ━ critical path   ─ dependency   ⟲ n/max loop rounds on the check                          │
```

- **Shows.** A live DAG, left to right (React Flow with dagre). Each node carries
  the row's header ([nodes](#task-row-and-node-contents)). Subtasks and child
  plans fold into their parent with a count, and expand in place. A loop is a
  `⟲ n/max` badge on its check, with no back-edge. The critical path (the
  longest chain of unfinished work by dependency) is drawn heavier.
- **Actions.** Hover peeks a node's output; click selects, and the selection is
  shared with List; double click or Enter opens the task tab; arrow keys move
  along edges; fit, zoom and the minimap. The canvas cannot add, remove or
  connect tasks: structure is edited in List or the task tab.
- **Loading.** The layout is computed once per plan shape; status changes
  restyle nodes without moving them.
- **Empty.** As W2.
- **Error.** A plan the layout cannot draw (a cycle a validation missed) falls
  back to List with a banner saying why.

### W6. The task tab — Details and Chat

```
│ [📌 Plan] [#2 Add SAML callback route ✕]                                                 │
│ ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ◆ #2 Add SAML callback route         Needs you · approval        Details | Chat      │ │
│ │ codex · gpt-5 · medium · Build    ⇠ #1  ⇢ #3 #4    branch ordewell/r7/2  [Δ Diff]    │ │
│ ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ VERDICT   — not yet (attempt 2 running)                                              │ │
│ │ PROMPT    Add a POST /auth/saml/callback route that …                         [✎]   │ │
│ │ ASSIGNMENT runner codex ▾  model gpt-5 ▾  effort medium ▾  mode Build ▾       [✎]   │ │
│ │ DEPENDS ON #1 Read the auth module ✓                                         [✎]   │ │
│ │ HANDOFF   (from attempt 1) Failed: tests missing SAML_CERT …   F1 F2  [open]          │ │
│ │ ATTEMPTS  #2 running 1m 12s · #1 failed (verdict: tests failed — evidence ▸)          │ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘ │

│ │ ◆ #2 Add SAML callback route                                     Details | Chat      │ │
│ │ ┌──────────────────────────────────────────────────────────────────────────────────┐ │ │
│ │ │ codex: Reading src/auth/routes.ts …                                              │ │ │
│ │ │ ▸ ran `npm test -- auth` (exit 1)                                                │ │ │
│ │ │ ◆ Approval: run `npm i saml2-js`           [Allow once] [Allow always] [Deny]     │ │ │
│ │ └──────────────────────────────────────────────────────────────────────────────────┘ │ │
│ │ ┌──────────────────────────────────────────────────────────────── Message #2 · codex┐ │ │
│ │ │                                                                                  │ │ │
│ │ └──────────────────────────────────────────────────────────── [Interrupt] [Send ⏎]─┘ │ │
```

- **Shows.** *Details*: the verdict first, with its evidence (the
  `task_complete` call, a script's exit status, a check's result); then the
  prompt, assignment, dependencies in and out, the handoff with its findings
  and artifacts (`TaskHandoff`, `HandoffCard`), and the attempts. *Chat*: the
  task's output as the VS Code chat draws it, with its approvals and checkpoints
  inline. The tab header holds the row header and a *Diff* button.
- **Actions.** Edit prompt, assignment and dependencies (a running task's edits
  apply to its next attempt, and the editor says so); run, retry, revert, skip,
  remove, mark complete or not done (`execute-command`); answer an approval or
  checkpoint; message the task (`message_task`, with *send now* and queued
  messages); interrupt; open the diff.
- **Loading.** Chat loads the attempt's log (`GET
  /api/sessions/:id/tasks/:taskId/log`) and then follows frames.
- **Empty.** A task never started: Chat says "No attempts yet" and its composer
  is disabled with the reason.
- **Error.** A log that cannot be read shows its error in Chat; Details still
  draws from the plan.

### W7. Needs you popover with an approval waiting

```
                                                     (◆ 2 Needs you) ◀ badge, amber
                                    ┌────────────────────────────────────────────┐
                                    │ NEEDS YOU                         2 items  │
                                    ├────────────────────────────────────────────┤
                                    │ ◆ #2 Add SAML callback route   approval    │
                                    │   codex wants to run: npm i saml2-js       │
                                    │   in ordewell/r7/2 worktree                │
                                    │   [Allow once] [Allow always] [Deny] [Open]│
                                    ├────────────────────────────────────────────┤
                                    │ ⧉ Run r7                     merge-all     │
                                    │   3 tasks landed, nothing left to move it  │
                                    │   [Review & Merge all]              [Open] │
                                    └────────────────────────────────────────────┘
```

- **Shows.** The escalations of the open session (`GET escalations`), one card
  each with its reason, its task and the options it offers (ADR-0053). The
  badge counts them and turns amber when any wait. The same list heads the Plan
  sidebar.
- **Actions.** Each option answers through `POST escalations/answer`; an option
  whose card asks a question first asks it here. *Open* goes to the task tab.
- **Loading.** The popover opens on the last list and refreshes; an answer in
  flight disables that card's options.
- **Empty.** "Nothing needs you." The badge shows no count.
- **Error.** An answer refused because the wait moved on (its id is gone)
  replaces the card with what it became.

### W8. Explorer with the scope switcher

```
┌ acme-app › web › main ▾   [Scope: Task #3 worktree ▾]                       ┐
│                           ┌─────────────────────────────────────┐            │
│                           │ web                                 │            │
│                           │  ● Your checkout          main      │            │
│                           │  ○ Integration branch     run r7    │            │
│                           │  ○ Task #1 worktree       ✓ landed  │            │
│                           │  ○ Task #3 worktree       ◐ running │            │
│                           │ api                                 │            │
│                           │  ○ Your checkout          main      │            │
│                           └─────────────────────────────────────┘            │
├──┬─────────────────────────┬────────────────────────────────────────────────┤
│⎘ │ EXPLORER   web · #3 🔒  │ [Login.tsx — #3 (read-only) ✕]                 │
│  │ ▾ src                   │  1  import { useState } from 'react';          │
│  │   ▾ components          │  2  export function Login() {                  │
│  │     Login.tsx      M    │  3    const [busy, setBusy] = useState(false); │
│  │     Button.tsx          │  … Monaco, read-only                           │
│  │ ▸ .ordewell/skills      │                                                │
│  │   dist/          ignored│  Read-only: task #3's worktree. Edit in your   │
│  │                         │  checkout.            [Open Your checkout]      │
```

- **Shows.** The tree of the current [view scope](#the-scope-model), one
  directory at a time (`GET /api/files/tree`), with git status letters and
  ignored entries marked. `.ordewell/skills/` is shown; the rest of `.ordewell`
  and `.git` never are (ADR-0061 R3). A file opens in Monaco, editable only in
  the checkout. The sidebar header names the scope, with a lock when it is
  read-only.
- **Actions.** Switch scope; open, preview, split; quick open (Cmd/Ctrl+P, by
  name via `GET /api/files/find`); in the checkout, edit and save (Cmd/Ctrl+S) and
  *Open in editor*; copy path. New file and rename are later.
- **Loading.** A directory expands with a one-line skeleton.
- **Empty.** An empty directory says so; a scope with no files says why.
- **Error.** A `binary` or `too-large` file shows its size and *Open in editor*
  (checkout only); a `gone` scope (worktree and branch removed) says so and
  offers the checkout; a symlink out of the workspace is listed but not
  followed.

### W9. Changes review — a diff with a line comment

```
│ [📌 Plan] [Δ #3 Add login button ✕]                                                       │
│ ┌──────────────────┬───────────────────────────────────────────────────────────────────┐ │
│ │ CHANGED (3)      │ src/components/Login.tsx            Side by side | Inline   [⤢]    │ │
│ │ M Login.tsx +24-3│  12   const [busy, setBusy]          12   const [busy, setBusy]   │ │
│ │ A saml.ts   +40  │  13 - return <button>Log in</button> 13 + return <SsoButton       │ │
│ │ M routes.ts +6-1 │                                      14 +   provider="okta" />    │ │
│ │                  │      ┌──────────────────────────────────────────────────────────┐ │ │
│ │ web · #3 vs main │      │ 💬 Line 14: use the provider from config, not a literal. │ │ │
│ │ base 4f2a91c     │      │ Sends to #3 as a message.          [Cancel] [Send to #3] │ │ │
│ │                  │      └──────────────────────────────────────────────────────────┘ │ │
│ └──────────────────┴───────────────────────────────────────────────────────────────────┘ │
```

- **Shows.** A task's diff (`GET /api/plans/:sessionId/tasks/:taskId/diff`) or
  the whole run's (`GET isolation/diff`, one section per repository), the file
  list first and each file's patch on demand, in Monaco's diff editor. The
  header names the repository, the task and the base it is compared with.
- **Actions.** Side by side or inline; next and previous change; a line comment,
  which is sent to the task as a `message_task` quoting file and line (a running
  task gets it now, a finished one on its next attempt, as ADR-0023 says);
  *Review & Merge all* from the run diff; revert a task from its diff (with
  `revert-preview`).
- **Loading.** The file list first, then the selected patch.
- **Empty.** "No changes in this task" (a research or read-only task lands
  nothing, ADR-0046).
- **Error.** A diff whose task branch is gone says so; a binary file shows its
  sizes only.

### W10. The user's checkout changes and the commit box

```
├──┬──────────────────────────────┬─────────────────────────────────────────────────────────┤
│⑂ │ CHANGES   web · main ▾       │ [Δ README.md (working tree) ✕]                          │
│  │ ┌──────────────────────────┐ │   3  ## Setup                     3  ## Setup           │
│  │ │ Message (⌘⏎ to commit)   │ │   4 -Run npm i                    4 +Run npm ci         │
│  │ │ Fix setup instructions   │ │                                                         │
│  │ └──────────────────────────┘ │  [Stage hunk] [Discard hunk]                            │
│  │ [Commit ▾]  ☐ Amend          │                                                         │
│  │ STAGED (1)                   │                                                         │
│  │  M README.md          [−]    │                                                         │
│  │ CHANGES (2)                  │                                                         │
│  │  M src/app.ts      [+][↶]    │                                                         │
│  │  ? notes.txt       [+][↶]    │                                                         │
│  │ ⓘ main is run r7's landing   │                                                         │
│  │   branch: actions here are   │                                                         │
│  │   noted in its timeline.     │                                                         │
│  │ ↓ 0 ↑ 2  [Fetch][Pull][Push] │                                                         │
```

- **Shows.** The checkout's staged, unstaged, untracked and conflicted files per
  repository (`GET /api/git/status`), the commit box, ahead and behind its
  upstream, and a note when the branch is a live run's landing branch (ADR-0062
  G6). Selecting a file opens its working-tree diff in Monaco.
- **Actions.** Stage, unstage and discard by file or hunk; commit (Cmd/Ctrl+Enter);
  *Amend*, shown only while HEAD is unpushed (G4); stash and pop from the
  `Commit ▾` menu; fetch, pull and push to the tracking remote. Discard asks
  first, listing the files; pull and push ask first, naming the remote and
  branch (G3).
- **Loading.** Status refreshes on focus and on a run's landing frames; actions
  in flight disable their buttons.
- **Empty.** "No changes in web." Ahead and behind still show.
- **Error.** A refused action shows git's own text (a hook that failed, a
  rejected push, a missing credential) in the box, with the route's refusal
  name: `confirm_stale` reopens the confirm with the new state; `pushed`
  explains why amend is gone.

### W11. The Git view — commit graph and branches

```
├──┬──────────────────────────────┬─────────────────────────────────────────────────────────┤
│⑃ │ BRANCHES   web               │ [⑃ Commit graph — web ✕]                                │
│  │ ▾ Local                      │  ● 9c1e2d0  Fix setup instructions      you    2m      │
│  │   ● main  ↑2   🔒 run r7     │  │ ● 77ab310 ordewell: land #1 Read …   ordewell 1h   │
│  │     feature/sso              │  │╱  (ordewell/r7/integration)                         │
│  │ ▾ Ordewell (read-only)       │  ● 4f2a91c  Bump deps                  you    1d      │
│  │     ordewell/r7/integration  │  ● e81f004  Merge branch 'feature/x'   you    2d      │
│  │     ordewell/r7/1 ✓          │  ├─╮                                                   │
│  │ ▾ Remote origin              │  │ ● 3d0a9b2 Add x                     ana    2d      │
│  │     origin/main              │  ● │ …                                                 │
│  │ ▾ Stashes                    │  Load more ↓                                           │
│  │     ordewell: before Merge … │                                                        │
│  │ [+ Branch]                   │                                                        │
```

- **Shows.** Local branches with ahead and behind; Ordewell's branches in their
  own read-only group; remote-tracking branches as of the last fetch; stashes
  (`GET /api/git/branches`). A lock marks a live run's landing branch, naming
  the run. The commit graph is a tab, paged by cursor (`GET /api/git/log`); a
  commit opens its message and files (`GET /api/git/commit`), and a file its
  patch.
- **Actions.** Create, switch and delete a branch; pop or drop a stash (drop is
  later); fetch. Switching away from, or deleting, a locked branch is refused
  with the run named (W12). An Ordewell branch can be viewed and diffed, never
  switched to or deleted here.
- **Loading.** The first page of the graph, then more on scroll.
- **Empty.** A repository with no commits says so.
- **Error.** A `git_failed` action shows git's text in place.

### W12. Branch action confirm

```
┌──────────────────────────────────────────────────────────────┐
│ Delete branch feature/sso?                                   │
│                                                              │
│ Repository   web  (~/code/acme-app/web)                      │
│ Branch       feature/sso  — 3 commits not merged into main   │
│ Worktree     your checkout (not checked out here)            │
│                                                              │
│ The 3 unmerged commits stay reachable only through the       │
│ reflog after this.                                           │
│                                   [Cancel]  [Delete branch]  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ Can't switch away from main                                  │
│                                                              │
│ Repository   web                                             │
│ Branch       main — run r7 of "Add SSO login" lands here     │
│ Worktree     your checkout                                   │
│                                                              │
│ Run r7 is live (2 tasks running). Switching now would leave  │
│ Merge all with nowhere to land. Stop the run, or wait for it │
│ to settle.                          [Open run]  [Close]      │
└──────────────────────────────────────────────────────────────┘
```

- **Shows.** Every branch action's confirm names the repository, the branch and
  the worktree it touches. A delete names unmerged commits (G3's `unmerged`). A
  refusal names the session, the run and why (`landing_branch_held`, G7). A
  switch with uncommitted changes says git will carry or refuse them, as git
  decides. A switch away from a settled run's unmerged landing branch is
  allowed, with a warning that Merge all will refuse until the branch is back.
- **Actions.** Confirm sends the echoed `confirm`; *Open run* goes to the
  session.
- **Loading.** The confirm reads the branch's state before it opens.
- **Empty.** Not applicable.
- **Error.** `confirm_stale` redraws the confirm with the new state.

### W13. Merge all preflight with overlapping files

```
┌───────────────────────────────────────────────────────────────────────┐
│ Merge all — run r7 "Add SSO login"                                    │
│                                                                       │
│ web   → main      3 tasks landed                                      │
│   ⚠ You have uncommitted changes to files this merge changes:         │
│       M src/components/Login.tsx                                      │
│       M src/auth/routes.ts                                            │
│     Other uncommitted files: 1 (not touched by the merge)             │
│ api   → main      1 task landed   ✓ clean                             │
│                                                                       │
│ Set your changes aside first:                                         │
│   [Commit them…]  [Stash them]                          [Cancel]      │
│   Stash keeps only the 2 overlapping files, as                        │
│   "ordewell: before Merge all of r7", and offers to restore them      │
│   after the merge.                                                    │
└───────────────────────────────────────────────────────────────────────┘
```

- **Shows.** Per repository, the branch it lands on, how much landed, the
  overlapping uncommitted files, and whether other uncommitted files exist
  (`GET isolation/merge-preflight`, G8). A repository off its base branch shows
  ADR-0042's `wrong-branch` here, before anything merges.
- **Actions.** *Commit them* opens the commit box with the overlapping files
  staged, then returns here; *Stash them* stashes only those paths, then merges
  and offers *Restore my changes*; *Cancel*. With no overlap the dialog is the
  plain Merge all confirm.
- **Loading.** "Checking web, api …" per repository.
- **Empty.** Nothing landed: Merge all is not offered.
- **Error.** Merge all's own answer (`blocked`, `conflict`, `failed`) shows per
  repository, with ADR-0013's abort leaving the tree as it was.

### W14. A failed task

```
│ ✕ #2 Add SAML callback route        codex · gpt-5 · medium   ⇠#1                       │
│      Failed · tests failed (exit 1) · attempt 2 of 2           [Retry][Open][⋯]        │
│      ⊘ blocks #3, #4                                                                   │
│ ⊘ #3 Add login button                Blocked · waits on #2 (failed)                    │
```

- **Shows.** The failure's reason in plain words with its evidence one click
  away (the verdict in Details); the dependents it blocks (ADR-0034); the
  failed escalation in Needs you.
- **Actions.** Retry (with an edited prompt or assignment first, if wanted);
  skip; mark complete (asks first, since it overrides the verdict); message the
  planner about it.
- **Loading.** —
- **Empty.** —
- **Error.** A retry refused (the run is stopping) says so on the row.

### W15. Daemon disconnected (Reconnecting)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⟳ Reconnecting to the daemon on :3742 …  (attempt 3)       [Retry now] [Details]     │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ [📌 Plan]   ← last known state, dimmed; every action disabled                        │
│ │ ◐ #3 Add login button   Running (last seen 0:42 ago)                               │
│ ...                                                                                  │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ○ daemon :3742 — disconnected                                                        │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ The daemon on :3742 is a different version                   │
│ Daemon 0.12.3 (contract 4) · this app 0.13.0 (contract 5)    │
│ Run r7 in acme-app is live there, so it can't restart now.   │
│                       [Open with the CLI…]  [Quit]  [Retry]  │
└──────────────────────────────────────────────────────────────┘
```

- **Shows.** A bar over the window while main probes; the last known state
  dimmed, with each running task's "last seen" age, never shown as passed or
  stopped. When the daemon is back the bar says *Reconnected* briefly and the
  view redraws from a fresh `run_snapshot`. The mismatch card (H3) names both
  versions and contracts.
- **Actions.** Retry now; *Start a daemon* when the port is free and the app
  did not own the old one; *Restart daemon* on a mismatch when no run is live
  there.
- **Loading.** The bar is itself the loading state.
- **Empty.** Not applicable.
- **Error.** A port held by something else, or a token the app cannot read,
  shows as a card with the fix (`ORDEWELL_PORT`).

### W16. Session held by another host

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ 🔒 This session is open in VS Code (pid 51234, since 10:02). Showing its saved state. │
│                                             [Refresh] [Open a copy…] [Take over…]   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ [📌 Plan]  List | Graph                                    read-only                 │
│ │ ◐ #3 Add login button    Running in VS Code (as of last save)                      │
```

- **Shows.** What `GET /api/sessions/:id` serves from the file, with the
  holder from the lease; files, diffs and branches still read, needing no lease
  (ADR-0061 R4). Every write is disabled, with the holder named in its tooltip.
- **Actions.** Refresh; *Take over*, which asks first and follows ADR-0049's
  takeover rules (the other host stops its run); *Open a copy* forks the
  conversation into a new session (later).
- **Loading.** As W4.
- **Empty.** Not applicable.
- **Error.** A lease that lapses mid-view turns the banner into *The other host
  has let go* with *Open here*.

### W17. A restored session

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⟲ Restored from disk — the run was not running when this daemon opened it.          │
│ #3 was running when it stopped; it has not been verified.      [Resume run] [Dismiss]│
├──────────────────────────────────────────────────────────────────────────────────────┤
│ │ ✓ #1 Read the auth module     Passed · verified (task_complete, attempt 1)          │
│ │ ○ #3 Add login button         Not started · interrupted, not verified               │
│ │ ○ #4 Run the e2e suite        Not started                                           │
```

- **Shows.** A session adopted from disk (`POST /api/sessions/:id/load`) whose
  run was not live: tasks that passed say *verified*, with their evidence; a
  task that was running says it was interrupted and is not verified, never
  passed.
- **Actions.** Resume the run (`POST execute`); retry a task; dismiss the banner.
- **Loading.** "Opening session …" until the adoption answers.
- **Empty.** Not applicable.
- **Error.** A session file that cannot be read says so and offers to remove it
  from the list only.

## Task row and node contents

The List row is parity with VS Code's `TaskCard`. The Graph node carries the
header line and the status line; everything else is in its hover peek and its
task tab. The row view is decided once in core (`taskRowView`) and drawn by both
hosts; the desktop adds no rule of its own.

| Content | List row | Graph node |
|---|---|---|
| Status: shape, colour and label ([vocabulary](#status-vocabulary)) | ✓ | ✓ |
| Order label and title (`#2`, `#2.1`) | ✓ | ✓ |
| Harness/runner, model, effort, mode (Build / Read-only) | ✓ | runner and model |
| Badges: Research, Ops, Script, Manual, Delegated (child plan) | ✓ | ✓ |
| Approval waiting, with Allow / Deny inline | ✓ | badge, actions in peek |
| Checkpoint waiting, with its question | ✓ | badge |
| Conflict and *Resolve* (resolve-conflict), Repair rounds | ✓ | badge |
| Merge gate ("not merged into your branch yet") with *Merge all* | ✓ | badge |
| Usage limit with *Resume now* / *Cancel resume* | ✓ | badge |
| Loop rounds `n/max` on a check | ✓ | ✓ |
| Dependencies in (⇠) and out (⇢), each a link | ✓ | edges |
| Isolation: branch, worktree, repositories, files changed | ✓ | peek |
| Elapsed time, quiet-for time | ✓ | ✓ |
| *Open chat*, output peek | ✓ | double click, hover |
| Inline edit of prompt, dependencies and assignment | ✓ | task tab only |
| Run, retry, revert (with preview), skip, remove, force start, mark complete / not done, stop, interrupt | ✓ (`⋯` past the first two) | context menu |
| Subtasks and child plans | indented, folding | folded into the parent |

## Status vocabulary

Every status is a shape, a colour and a word, so none depends on colour alone.
The mapping from core's `TaskStatusKind` is fixed here and lives in
`packages/ui`.

| Word | Shape | Colour token | From core |
|---|---|---|---|
| Not started | ○ hollow circle | `state.idle` | `todo` |
| Running | ◐ half-filled circle, turning | `state.running` | `running`; `quiet` adds "quiet for 4m" (core's *Stalled*) |
| Needs you | ◆ the *Needs you* glyph | `state.attention` | `awaiting`, or any task with an escalation |
| Passed | ✓ filled circle with check | `state.passed` | `done` with its verdict |
| Failed | ✕ filled circle with cross | `state.failed` | `failed` |
| Blocked | ⊘ circle with bar | `state.blocked` | `blocked` |
| Skipped | ◌ dashed circle | `state.idle` | `skipped` |
| Waiting for merge | ⧉ merge mark | `state.merge` | `done` with a landing not yet merged, or at a merge gate |

Three qualifiers keep "done" honest:

- **Verified** is said only of a task whose verdict came from evidence (a
  `task_complete` bound to the attempt, a script's exit status). *Mark complete*
  shows "Marked complete by you", not "verified".
- **Reconnected** redraws from a fresh snapshot; it never infers progress made
  while disconnected, and an idle runner is never shown as complete.
- **Restored** marks a session adopted from disk: a task that was running is
  drawn as *Not started* with "interrupted, not verified" until it runs
  again.

## Design tokens

Semantic names only: a component never names a hex value. Tokens are CSS custom
properties in `packages/ui`. VS Code maps them onto its theme variables, the
desktop app onto the values below. Light and dark follow the OS
(`nativeTheme`). Greys are neutral; colour is for states, the accent and diffs.
Each text and state colour must reach WCAG AA contrast on the backgrounds it is
drawn on; the design-system slice checks the pairs in a test.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg.canvas` | `#FFFFFF` | `#1B1D21` | main area, editors |
| `bg.surface` | `#F6F7F8` | `#202328` | sidebar, panels, status bar |
| `bg.raised` | `#FFFFFF` | `#272A30` | popovers, menus, dialogs |
| `bg.inset` | `#F1F2F4` | `#16181B` | code, peeks, inputs |
| `bg.hover` | `#EEF0F2` | `#2A2E34` | hovered row |
| `bg.selected` | `#E7F4F8` | `#173540` | selected row, active pill |
| `border.subtle` | `#E4E6EA` | `#2E3238` | dividers |
| `border.strong` | `#CDD1D6` | `#3D424A` | inputs, cards |
| `text.primary` | `#1A1C1F` | `#E6E8EB` | body |
| `text.secondary` | `#5B616B` | `#A3A9B3` | metadata |
| `text.muted` | `#7A818B` | `#7F8690` | placeholders, disabled |
| `accent` | `#1393B3` | `#3BB3D1` | active stroke, links, focus |
| `accent.tint` | `#E7F4F8` | `#173540` | active pill fill |
| `accent.on` | `#FFFFFF` | `#0E1A1F` | text on an accent button |
| `focus.ring` | `#1393B3` | `#3BB3D1` | 2px ring, 2px offset |
| `state.idle` | `#7A818B` | `#8C939D` | not started, skipped |
| `state.running` | `#2F6FEB` | `#5B9CFF` | running |
| `state.attention` | `#B26B00` | `#E3A64A` | needs you |
| `state.passed` | `#1F8A4C` | `#4CC07A` | passed |
| `state.failed` | `#C93C37` | `#F0726C` | failed |
| `state.blocked` | `#9A4F1A` | `#D9894A` | blocked |
| `state.merge` | `#6E56CF` | `#9D8CF0` | waiting for merge |
| `diff.added.bg` | `#E6F4EA` | `#16301F` | added lines |
| `diff.removed.bg` | `#FBE9E8` | `#3A1B1A` | removed lines |
| `diff.added.word` | `#B7E1C1` | `#1F5A33` | changed words |
| `diff.removed.word` | `#F4C2BF` | `#6B2522` | changed words |

**Type.** Inter for UI, JetBrains Mono for code, paths, branches and commands,
both bundled (no network font). Base 13px.

| Step | Size / line height | Weight | Use |
|---|---|---|---|
| `type.caption` | 11 / 16 | 500 | badges, status bar |
| `type.small` | 12 / 18 | 400 | metadata, row second line |
| `type.body` | 13 / 20 | 400 | body, rows, inputs |
| `type.body.strong` | 13 / 20 | 600 | titles in rows |
| `type.heading` | 15 / 22 | 600 | section heads, dialogs |
| `type.title` | 20 / 28 | 600 | welcome, empty states |
| `type.code` | 12.5 / 19 | 400 | Monaco, terminal, peeks |

**Spacing.** A 4px grid: `space.1`=2, `space.2`=4, `space.3`=6, `space.4`=8,
`space.5`=12, `space.6`=16, `space.7`=24, `space.8`=32. A row is 28px (one
line) or 44px (two). Hit targets are at least 24×24.

**Radii.** `radius.sm`=4 (inputs, buttons), `radius.md`=6 (rows, cards, nodes),
`radius.lg`=8 (popovers, dialogs), `radius.pill`=999 (badges, the active pill).

**Motion.** `motion.fast`=120ms (hover, press, badge change), `motion.base`=160ms
(panels, popovers, tab switch), easing `cubic-bezier(0.2, 0, 0, 1)`. Under
`prefers-reduced-motion` every duration is 0, the running shape stops turning,
and the graph does not animate its layout. Nothing moves to celebrate.

**Elevation.** Popovers and dialogs only: `shadow.raised` = `0 4px 16px
rgb(0 0 0 / 0.12)` light, `0 4px 16px rgb(0 0 0 / 0.5)` dark.

## Icons

Lucide (`lucide-react`) at 1.5px stroke, 16px in rows and 20px in the activity
bar, coloured by `text.secondary` and by the accent when active.

| Concept | Lucide | Concept | Lucide |
|---|---|---|---|
| Explorer | `files` | Changes | `file-diff` |
| Git | `git-branch` | Commit graph | `git-graph` |
| Settings | `settings` | Command palette | `command` |
| Search / quick open | `search` | Terminal | `square-terminal` |
| Run | `play` | Stop | `square` |
| Approve | `check` | Retry | `rotate-ccw` |
| Revert | `undo-2` | Remove | `trash-2` |
| Skip | `skip-forward` | Edit | `pencil` |
| Chat / message | `message-square` | Output peek | `scroll-text` |
| Research | `telescope` | Ops | `wrench` |
| Script | `file-code` | Manual | `hand` |
| Conflict | `triangle-alert` | Usage limit | `hourglass` |
| Dependency in / out | `arrow-left-to-line` / `arrow-right-from-line` | Interrupt | `octagon-x` |
| Commit | `git-commit-horizontal` | Branch create | `git-branch-plus` |
| Fetch | `refresh-cw` | Pull / push | `arrow-down-to-line` / `arrow-up-from-line` |
| Stash / pop | `archive` / `archive-restore` | Discard | `undo` |
| Stage / unstage | `plus` / `minus` | Open in editor | `external-link` |
| Folder / file | `folder` / `file` | Ignored | `eye-off` |
| Read-only, held | `lock` | Daemon | `server` |
| Disconnected | `unplug` | Restored | `history` |
| Verified | `badge-check` | Model / effort | `cpu` / `gauge` |
| List / Graph | `list` / `workflow` | Split | `columns-2` |
| Planner panel | `panel-right` | Terminal panel | `panel-bottom` |
| Status: not started, passed, failed, blocked | `circle`, `circle-check`, `circle-x`, `ban` | Status: running | `loader-circle` |
| Status: skipped | `circle-dashed` | Status: waiting for merge | `git-merge` |

**Custom glyphs.** Eight, drawn on the logo's motif
(`assets/readme/logo-dark.png`): round-capped strokes converging on a teal dot.
24px grid, 1.5px round-capped stroke in `currentColor`, the dot in `accent`
(or the state's colour where it marks a state).

| Glyph | Description |
|---|---|
| **Plan** | Three horizontal strokes of falling length converging from the left on a dot at the right: an ordered list arriving at one goal. The activity bar's Plan. |
| **Loop** | A round-capped stroke curving back on itself around the dot, open at one end: a check repeating with its fix. Carries `n/max` beside it. |
| **Checkpoint** | A vertical stroke crossed by a short one, the dot at the crossing: a gate held for a person. |
| **Runner** | Two strokes converging on the dot from the upper and lower left, with a third leaving to the right: an agent taking a task and acting. Used where a runner, not a model, is meant. |
| **Merge all** | Three strokes from the left converging into one that continues to the dot: every repository's work landing at once. The primary action's icon at that stage. |
| **Needs you** | The dot inside an open diamond of four strokes that do not meet: something waits on a person. The badge's and the status's glyph. |
| **Child plan** | The Plan glyph small, inside a rounded bracket: a delegated task's own plan. |
| **View scope** | Two nested open corners framing the dot: which tree the view is looking at. The scope switcher's icon. |

## Keyboard and screen readers

| Keys (macOS / Windows, Linux) | Does |
|---|---|
| ⌘K / Ctrl+K | Command palette (tasks with `#`, files, branches, commands) |
| ⌘P / Ctrl+P | Quick open a file in the current scope |
| ⌘1–4 / Ctrl+1–4 | Plan, Explorer, Changes, Git |
| ⌘, / Ctrl+, | Settings |
| ⌘B / Ctrl+B | Toggle the sidebar |
| ⌘L / Ctrl+L | Toggle the planner panel and focus its composer |
| Ctrl+\` | Toggle the terminal panel |
| ⌘⇧A / Ctrl+Shift+A | Open Needs you |
| ⌘⇧⏎ / Ctrl+Shift+Enter | The primary action, always through its confirm |
| V (Plan focused) | Switch List and Graph |
| ↑ ↓ (List) | Previous, next task; → and ← expand and fold subtasks |
| ← → ↑ ↓ (Graph) | Along edges: ← to a dependency, → to a dependent, ↑↓ between siblings |
| ⏎ / Space | Open the task tab / toggle the output peek |
| ⌘W / Ctrl+W, ⌃Tab / Ctrl+Tab | Close tab, next tab |
| ⌘\\ / Ctrl+\\ | Split the editor |
| ⌘S / Ctrl+S | Save (checkout only) |
| ⌘⏎ / Ctrl+Enter | Send in a composer; commit in the commit box |
| Esc | Close a popover, peek or dialog; return focus where it was |
| F7 / Shift+F7 (diff) | Monaco's accessible diff viewer, next and previous change |

- Every interactive element is reachable by Tab in visual order, with a visible
  `focus.ring`.
- The List is a `treegrid`; each row's accessible name is its order, title and
  status word ("#2 Add SAML callback route, needs you: approval").
- The Graph's nodes are focusable buttons with the same name, plus a
  description of their edges ("depends on #1; #3 and #4 depend on it"). Edges
  are hidden from the accessibility tree. The List is the full equivalent, and
  the Graph's toolbar says so.
- The Explorer is a `tree`; Changes lists are `listbox`es whose items name the
  file and its change.
- One polite live region announces a task's change of status, a new Needs you
  item and a reconnection. Output is never announced as it streams.
- Dialogs trap focus and name their primary action. A destructive confirm
  starts focus on Cancel.
- Monaco runs with its accessibility support on when the OS reports a screen
  reader; xterm.js runs with `screenReaderMode` then.

## The scope model

A [view scope](../../CONTEXT.md) is per repository, chosen in the title bar's
scope switcher (ADR-0061 R2). The Explorer, file tabs, Changes and the terminal
follow it; the Plan does not.

| Action | Your checkout | Integration branch | Task #N worktree |
|---|---|---|---|
| Browse, open, quick open | ✓ | ✓ (git objects) | ✓ (disk; branch once pruned) |
| Edit and save | ✓ (G10) | — view-only | — view-only |
| Stage, commit, discard, stash, branch, fetch/pull/push | ✓ (G1) | — | — |
| Changes view shows | working tree vs HEAD | the run's diff vs base | the task's diff vs its base |
| Line comment on a diff | — | — (no task to send to; comment per task) | ✓ sent to #N |
| Open in editor | ✓ | — (no files on disk) | — (would race or be lost) |
| Terminal | ✓ default | — (no worktree) | ✓ only while #N is not running (G11) |
| Review & Merge all | ✓ | ✓ | ✓ |

*Review & Merge all* is the session's action, not the scope's: it is offered
from any scope while the run has unmerged landings.

A scope that no longer exists (`gone`) drops back to the checkout with a line
saying why. The breadcrumb names the scope's branch: the checkout's own branch,
`ordewell/<run>/integration`, or the task's branch.

## IPC bridge

The preload exposes `window.ordewell`, and nothing else (ADR-0060 H4). Each
call's arguments are checked in main. Daemon calls name a route id from a fixed
table; the renderer never gives a URL, a header or a method.

| Name | Does |
|---|---|
| `app.info()` | App version, contract, platform, theme |
| `app.onThemeChange(cb)` | OS light/dark changes |
| `app.openWorkspace()` / `app.recentWorkspaces()` / `app.forgetWorkspace(path)` | Folder picker, recent list (focuses an already-open window, H6) |
| `app.setTitleBarOverlay(colors)` | Windows/Linux overlay colours on theme change |
| `daemon.status()` / `daemon.onStatus(cb)` | Attached or owned, version, contract, connection state |
| `daemon.retry()` / `daemon.start()` / `daemon.restart()` | The actions of W15, each refused as H3 says |
| `daemon.call(routeId, params, body?)` | One request from the route table, bearer added in main |
| `daemon.subscribe(sessionId, cb)` → `unsubscribe` | Frames of `/ws/session/:sessionId` |
| `daemon.subscribeChild(rootId, childId, cb)` → `unsubscribe` | Frames of a child plan's socket |
| `dialog.confirm(spec)` | A native confirm for quit and other app-level asks; in-app confirms are drawn by the UI |
| `shell.openInEditor(workspace, repo, path, line?)` | Hands a checkout file to the user's editor (G10) |
| `shell.reveal(workspace, repo, path?)` | Reveal in Finder / Explorer |
| `shell.openExternal(url)` | `https:` only |
| `terminal.open({ workspace, repo, scope })` → `id` | Starts a PTY ([terminal rule](#the-terminal-rule)) |
| `terminal.write(id, data)` / `terminal.resize(id, cols, rows)` / `terminal.close(id)` | PTY input and size |
| `terminal.onData(id, cb)` / `terminal.onExit(id, cb)` / `terminal.onBanner(id, cb)` | PTY output, exit, "task #N started" banner |
| `prefs.get()` / `prefs.set(key, value)` | App-local preferences: window bounds, panel sizes, List or Graph |
| `update.state()` | Always "disabled" until signing (out of scope) |

The route ids are the rows of [Daemon routes](#daemon-routes), named
`area.verb` (`sessions.list`, `plans.executeCommand`, `files.tree`,
`git.push`). Main refuses an unknown id, a path parameter that is not one
segment, and a body on a GET.

## Daemon routes

Every route takes `workspace`. **New** marks a capability the daemon does not
have today, with the ADR that governs it; the rest exist.

| Method | Path | Main fields | New? |
|---|---|---|---|
| GET | `/api/server` | `pid`, `port`, **`version`, `contract`** | changed — ADR-0060 H3 |
| GET | `/api/workspaces`, `/api/workspaces/isolation-preview` | repositories, branch each lands on, or why not isolated | |
| GET | `/api/sessions` | id, goal, updated, lease holder | |
| GET | `/api/sessions/:id` | plan, conversation, isolation view | |
| POST | `/api/sessions/:id/load`, `/:id/close`; DELETE `/:id` | adopt, close, delete | |
| GET | `/api/sessions/:id/tasks/:taskId/log[/:attempt]` | a task's log | |
| GET, POST | `/api/sessions/:id/children[/:childId]`, their task logs, `message`, task `message` and `checkpoint/approve` or `reject` | child plans | |
| POST | `/api/plans/:sessionId/converse/start`, `converse/message`, `converse/message/now`, `converse/resend/cancel` | `message` | |
| GET/POST | `/api/plans/:sessionId/conversation/rewind-targets`, `/rewind`, `/fork`, `/compact` | | |
| POST | `/api/plans/:sessionId/generate`, `planning/stop`, `review/approve`, `execute`, `stop` | | |
| POST | `/api/plans/:sessionId/execute-command` | an `ExecutionCommand` (`run_task`, `retry_task`, `revert_task` with `confirmed` and `seen`, `message_task`, `merge_all`, …) | |
| GET/POST | `/api/plans/:sessionId/escalations`, `escalations/answer` | `id`, `option`, `note?`, `confirmed?` | |
| POST, PUT, DELETE | `/api/plans/:sessionId/tasks[/:taskId]` | task edits | |
| GET | `/api/plans/:sessionId/tasks/:taskId/merge-gate`, `revert-preview` | | |
| POST | `/api/plans/:sessionId/tasks/:taskId/commands`, `resolve-conflict` | | |
| GET, POST | `/api/plans/:sessionId/isolation/diff`, `isolation/merge` | | |
| GET | `/api/runners`, `/api/models`, `/api/settings`, `/api/settings/containers` | | |
| GET, POST | `/api/approvals/:sessionId`, `/api/approvals/:sessionId/:approvalId` | pending approvals; the decision | |
| WS | `/ws/session/:sessionId`, `/ws/session/:rootId/child/:childId` | `run_snapshot`, then stamped `SessionMessage`s | |
| GET | `/api/plans/:sessionId/tasks/:taskId/diff` | `names?`, `repo?`, `path?` → `TaskDiffResult` | **new** — ADR-0061 R2, R3 |
| GET | `/api/files/tree` | `repo`, `scope`, `sessionId?`, `taskId?`, `dir` → entries with kind, ignored, git status | **new** — ADR-0061 |
| GET | `/api/files/content` | `repo`, `scope`, `path` → `text` + `hash`, or `binary` / `too-large` / `gone` | **new** — ADR-0061 R5 |
| GET | `/api/files/find` | `repo`, `scope`, `query`, `text?`, `limit?` → paths, or matching lines; capped | **new** — ADR-0061 |
| GET | `/api/git/repos` | branch, upstream, ahead/behind, detached | **new** — ADR-0061 |
| GET | `/api/git/status` | staged, unstaged, untracked, conflicted | **new** — ADR-0061 R6 |
| GET | `/api/git/diff` | `staged` / `unstaged` / `from`,`to`; `path?` | **new** — ADR-0061 R5 |
| GET | `/api/git/log` | `ref?`, `cursor?` → commits with parents and refs | **new** — ADR-0061 R5 |
| GET | `/api/git/commit` | `sha`, `path?` → message, author, files, patch | **new** — ADR-0061 |
| GET | `/api/git/branches` | local, Ordewell's, remote-tracking, stashes, landing-branch marks | **new** — ADR-0061, ADR-0062 G7 |
| PUT | `/api/files/content` | `repo`, `path`, `text`, `baseHash` | **new** — ADR-0062 G10 |
| POST | `/api/git/stage`, `/api/git/unstage` | `paths` or `hunks` | **new** — ADR-0062 |
| POST | `/api/git/commit` | `message`, `amend?`, `confirm { head }` when amending | **new** — ADR-0062 G3, G4 |
| POST | `/api/git/discard` | `paths` or `hunks`, `confirm { files }` | **new** — ADR-0062 G3 |
| POST | `/api/git/branch`, `/api/git/switch` | `name`, `from?` / `branch` | **new** — ADR-0062 G1, G7 |
| POST | `/api/git/branch-delete` | `branch`, `confirm { branch, unmerged }` | **new** — ADR-0062 G3, G7 |
| POST | `/api/git/stash`, `/api/git/stash-pop`, `/api/git/stash-drop` | `paths?`, `message?` / `stash` | **new** — ADR-0062 |
| POST | `/api/git/fetch`, `/api/git/pull`, `/api/git/push` | `confirm { remote, branch }` for pull and push | **new** — ADR-0062 G3, G5 |
| GET | `/api/plans/:sessionId/isolation/merge-preflight` | per repo: `repo`, `branch`, `overlap[]`, `otherDirty` | **new** — ADR-0062 G8 |

Refusals the UI must name: `landing_branch_held` (session, run, branch),
`confirm_stale` (the difference), `stale` (the file changed on disk),
`not_checkout`, `ordewell_branch`, `pushed`, `git_failed` (git's text), and
`gone` on a read.

## The terminal rule

ADR-0062 G11. The terminal is xterm.js in the renderer over a node-pty process
that Electron main owns; the daemon never starts a shell.

- It opens in the user's checkout of the current repository by default, with
  the user's login shell and environment.
- It opens in a task's worktree only while that task is not running. The
  option is disabled with the reason while it runs.
- A task that starts later in a worktree with a terminal open does not kill the
  shell; the terminal shows a banner naming the task.
- What is typed is the person's own: outside the interlock and the timeline.
  ADR-0042's `wrong-branch` and ADR-0013's dirty-overlap abort are the
  backstop at Merge all.
- Terminals close with their window. Quitting with a terminal running a
  process asks first, alongside the run question (H5).

## Out of scope

- Code signing, notarization, and enabled auto-update.
- Drag-to-connect, or any structural editing, on the graph.
- Arbitrary branch merge, rebase, pull requests, force push, a push target
  other than the tracking remote.
- Moving the TUI onto the shared daemon.
- A mobile app; a browser preview of the UI.
- File create, rename and delete in the Explorer.
- Holding a landing branch against the terminal or other git clients.

## Slices

In this order. Each slice lands on its own, with its tests, and leaves every
existing surface working. "Done" means what the slice's own task proves.

1. **packages/ui extraction.** Move the webview's components
   (`packages/vscode/src/views/chat/components/*`), view state, styles and the
   webview protocol (`packages/vscode/src/shared/protocol.ts`) into
   `packages/ui`, and introduce `HostBridge`, the one seam that today is
   `acquireVsCodeApi`. Styles become the [semantic tokens](#design-tokens),
   mapped onto VS Code's theme variables. Add the package to the build order
   and `scripts/change-scope.mjs`. Done: the VS Code extension behaves as
   before, its integration test passes.
2. **Host-neutral view layer.** Move the view assembly in `RunViewHost` and
   `ConversationViewHost` behind one layer in `packages/ui` (or core where it is
   pure) fed by either in-process `SessionMessage`s or daemon frames (H7). Done:
   VS Code drives it in-process; a test drives it from recorded daemon frames to
   the same view.
3. **Daemon read routes.** The workspace reader in core and the routes of
   ADR-0061, plus `GET /api/plans/:sessionId/tasks/:taskId/diff`, and
   `version` and `contract` on `GET /api/server` (H3). Done: ADR-0061's testing
   decisions.
4. **Daemon git-action routes and interlock.** The routes and refusals of
   ADR-0062 G1–G8 and G10's save, the interlock function, `user-actions.jsonl`
   and the holder folding it in, the merge preflight. Done: ADR-0062's testing
   decisions.
5. **Electron shell tracer.** `packages/desktop` with main, preload and a
   renderer that shows the session list. Attach-or-own with
   `utilityProcess.fork` (H2), the factored daemon helpers shared with the CLI,
   the handshake (H3), the route table and the bridge (H4), CSP and navigation
   locks. Done: the attach table and the route table tested; the app attaches to
   a CLI daemon and owns one when none runs.
6. **Design system and app frame.** Tokens, type, icons and custom glyphs,
   the activity bar, sidebar, tabs (preview, pin, split), title bar with native
   chrome, planner panel, status bar, command palette, light and dark. Done:
   the frame with empty views; token contrast pairs tested.
7. **Packaging and CI.** electron-builder for dmg (arm64, x64), NSIS (x64),
   AppImage and deb (x64), unsigned; a desktop job in `release.yml` attaching
   them to the GitHub Release; auto-update wired and disabled; the build in
   `scripts/ci.mjs` and `change-scope.mjs`. Done: a tag build produces the five
   installers.
8. **Session view.** W2, W3, W4, W6, W14, W17: planning, approval, the List
   with full row parity, the task tab, restored and failed states, one window
   per workspace (H6), welcome (W1).
9. **Attention, connection and settings.** Needs you (W7), Reconnecting and the
   mismatch card (W15), the held-session banner (W16), tray and quit (H5), the
   Settings view over `/api/settings`.
10. **Graph view.** W5: React Flow with dagre, folding, loop badges, critical
    path, synced selection, keyboard along edges.
11. **Explorer and Monaco.** W8: the scope switcher, the tree, Monaco viewer
    and checkout editor with `baseHash` saves, quick open, Open in editor.
12. **Review of task and run diffs.** W9: Monaco diff over the task and run
    diff routes, line comments as `message_task`, revert with preview.
13. **The user's checkout changes.** W10, W13: status, stage and unstage by
    file and hunk, commit and amend, discard, stash, fetch, pull, push, the
    landing-branch note, and the Merge all preflight dialog.
14. **Git view.** W11, W12: branches, the commit graph, commit detail, branch
    create, switch and delete with their confirms and refusals.
15. **Terminal.** xterm.js over node-pty in main, the [terminal rule](#the-terminal-rule).
16. **Offline e2e.** Playwright's Electron driver against the packaged app, the
    mock provider (`bench/live/mock-provider.mjs`) and fake runners, no API key:
    open, plan, approve, run, follow a task, answer an approval, review a diff,
    commit in the checkout, Merge all through the preflight; run once owning the
    daemon and once attached to a CLI one. Added to `npm run ci`.
