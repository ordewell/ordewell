# The Ordewell desktop app — design

This spec fulfils [#136](https://github.com/ordewell/ordewell/issues/136), the
design for the orchestration-first desktop app asked for in
[#129](https://github.com/ordewell/ordewell/issues/129). Every implementation
task for the app reads it. This is its second version. The first build put the
plan in the middle and the planner in a side panel. People found that layout
disorienting, so this version puts the planner conversation in the centre, the
plan in a panel on the right, and the plan graph in stage columns. It also
gives the app a visual system with defined sizes, so nothing overlaps or
disappears as the window narrows. The decisions behind the app are recorded in
these ADRs:

| ADR | Title | Rules |
|---|---|---|
| [ADR-0063](../adr/surfaces/0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md) | The desktop app is an Electron client of the shared daemon, and its renderer never holds the token | H1–H10 |
| [ADR-0064](../adr/surfaces/0064-a-host-reads-files-and-git-for-the-user-confined-to-the-workspace.md) | A host reads files and git for the user, confined to the workspace and needing no lease | R1–R6 |
| [ADR-0062](../adr/isolation/0062-user-git-actions-are-confirmed-at-a-host-and-a-live-run-holds-only-its-landing-branch.md) | User git actions are confirmed at a host, and a live run holds only its landing branch | G1–G11 |

[W16](#w16-a-session-another-host-holds)'s joined session also depends on the
session lease of ADR-0049, and on ADR-0063 H8, which says how main joins a
holder's daemon. This spec gives only the user experience of a joined session.

The vocabulary is [CONTEXT.md](../../CONTEXT.md)'s. The terms this design adds
there are *Desktop app*, *Daemon bridge*, *Version handshake*, *Needs you*,
*View scope*, *User principal*, *User's checkout*, *Landing branch*, *Live run*,
*Merge all preflight* and *User git action*. One word here is not yet in
CONTEXT.md: a **stage** is a column of the plan graph (see
[W5](#w5-the-plan-graph-tab)). It has nothing to do with git's staging area,
which this spec always calls *stage a file* or *Staged*. A word this spec uses
in a different sense from CONTEXT.md is a bug in this spec. For how to install
the app, run it from source and find your way around it, see
[the user guide](README.md).

## Contents

- [Shape of the app](#shape-of-the-app)
- [Layout](#layout)
- [Sizing and responsive rules](#sizing-and-responsive-rules)
- [Wireframes](#wireframes)
- [Task row, card and header contents](#task-row-card-and-header-contents)
- [Status vocabulary](#status-vocabulary)
- [Visual language](#visual-language)
- [Design tokens](#design-tokens)
- [Icons](#icons)
- [Keyboard and screen readers](#keyboard-and-screen-readers)
- [Design review checklist](#design-review-checklist)
- [The scope model](#the-scope-model)
- [IPC bridge](#ipc-bridge)
- [Daemon routes](#daemon-routes)
- [The terminal rule](#the-terminal-rule)
- [Out of scope](#out-of-scope)
- [Slices](#slices)

## Shape of the app

The app is `packages/desktop`, built on Electron 45.x with electron-builder.
Its main process is a client of the shared local daemon (`packages/web`) on
`127.0.0.1:3742`. After a version handshake (H3), it attaches to a daemon that
is already running, or starts and owns one (ADR-0063 H1, H2). The renderer
holds no token. It reaches the daemon only through the daemon bridge (H4). The
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

## Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  acme-app › web › main ▾   ◫ Your checkout ▾                 ◆ 2 Needs you   [■ Stop]  ⋯   │ title bar
├────┬──────────────────┬───────────────────────────────────────────────────┬────────────────────────┤
│▌☰  │ ☰ SESSIONS     + │ ▔▔▔▔▔▔▔▔▔                                         │ PLAN  ◐ 2/4    ⑃Graph ⇥│
│    │ NEEDS YOU (2)  ▾ │ Planner │ #3 Add login ✕ │ auth.ts ✕ │ ⑃ Graph ✕  │ ✓ #1 Read the auth mod…│
│ ⎘  │ ◆ #2 approval    │ ┌───────────────────────────────────────────────┐ │   Claude · sonnet · low│
│    │ ◆ #4 checkpoint  │ │                                               │ │ ◆ #2 Add SAML callback…│
│ ⑂  │ SESSIONS         │ │   CENTRE: tabs, split                         │ │   Codex · gpt-5 · med  │
│    │ ◐ Add SSO login  │ │   the first tab is the planner conversation,  │ │ ◐ #3 Add login button  │
│ ⑃  │ ✓ Fix flaky CI   │ │   pinned and never closed                     │ │   Claude · sonnet      │
│    │                  │ └───────────────────────────────────────────────┘ │ ○ #4 Run the e2e suite │
│    │                  ├───────────────────────────────────────────────────┤ │   Script               │
│ ⚙  │                  │ TERMINAL (hidden by default, Ctrl+`)              │                        │
├────┴──────────────────┴───────────────────────────────────────────────────┴────────────────────────┤
│ ● daemon :3742 (owned, 0.13.0)   lease: this daemon   Claude Code ✓  Codex ✓   5h: 40%   7d: 12%  │ status bar
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
  ☰ Sessions  ⎘ Explorer  ⑂ Changes  ⑃ Git  ⚙ Settings (bottom)   ▌ active indicator   ▔ tab marker
```

The planner conversation is what a person spends most of their time in, so it
gets the centre and the most width. The plan is the thing they watch while they
talk to the planner, so it sits beside the conversation as a narrow,
always-visible list, as it does in the TUI's plan pane. Navigation sits on the
left, where VS Code users look for it.

- **Activity bar.** Sessions, Explorer, Changes and Git, with Settings at the
  bottom. The icons are 22 px in a 52 px bar. Each item is a 44 × 44 button
  with a tooltip giving its name and shortcut. The active item is drawn in its
  [area hue](#visual-language): its icon takes the hue, and a 2 px bar 24 px
  tall marks the bar's left edge beside it. Inactive icons are
  `--ow-fg-secondary` and turn `--ow-fg` on hover. A count badge on Changes
  shows the checkout's changed files. Sessions shows the Needs you count while
  anything waits, and a dot while a run is live. Clicking the active item hides
  the sidebar, as in VS Code.
- **Sidebar.** Its content follows the activity bar. Its header shows the
  activity's icon in the area hue and the name in `type.overline`.
  - *Sessions* replaces the first build's Plan activity. It shows the Needs you
    inbox at its head, then this workspace's sessions, with **+** in the header
    for a new session.
  - *Explorer* shows the current scope's tree.
  - *Changes* shows the checkout's changes and the commit box, or, in a run
    scope, the changed files of a run or a task.
  - *Git* shows branches, stashes, worktrees and remotes.

  Cmd/Ctrl+B toggles the sidebar.
- **Centre.** A tab area that can split side by side.
  - The **Planner** tab always comes first. It is pinned and has no close
    button. It holds the open session's planner conversation, with the session
    header at its top and the composer at its foot.
  - **Task**, **file**, **diff**, **commit** and **plan graph** tabs open
    beside it. A single click opens a preview tab, shown in italics, and the
    next preview replaces it. A double click, an edit, or a message typed in it
    keeps the tab.
  - Task, diff and graph tabs belong to the session that opened them. Switching
    session swaps them out and brings that session's own tabs back. File and
    commit tabs belong to the workspace and stay put.
  - Each tab shows its icon in its area hue. The active tab has a 2 px marker
    along its top edge in the same hue: teal for the planner, task and plan
    graph tabs, indigo for files, mint for diffs (a commit's file too),
    slate for commit tabs.
  - A single centre tab is never wider than its content needs. The Details
    view sits in a column at most 800 px wide, centred, with 24 px of padding
    on each side. A chat, once it has a message, uses its tab's full width.
- **Plan panel.** On the right. It shows the open session's plan as a List, in
  [`TaskSummary`](#task-row-card-and-header-contents) rows. Its header shows
  *Plan*, the run's progress (status shape plus `done/total`), a **Graph**
  button and a collapse button. Cmd/Ctrl+Alt+B toggles it. Collapsed, it is a
  44 px rail with status counts ([Sizing](#sizing-and-responsive-rules)).
  - The panel only ever shows the List. *Graph* opens the plan graph as a
    centre tab, because stage columns read across, and they need the width only
    the centre has. A graph squeezed into 360 px would show one stage at a
    time, which is the List again with worse reading order.
  - Selection is shared between the List and the graph. Clicking a row opens
    the task tab as a preview; a double click keeps it.
- **Terminal panel.** At the bottom of the centre column, under the centre
  only. It is hidden by default and toggled with Ctrl+\`
  ([The terminal rule](#the-terminal-rule)).
- **Title bar.** One row, laid out on its own, with nothing that depends on
  the panels' widths.
  - The breadcrumb names the workspace, the repository and the branch, with
    each as a menu: the workspace's is the project switcher (the other recent
    folders, Open Folder… and Open in new window). Then come the scope switcher, the Needs
    you button and the primary action, with the rest in a `⋯` menu.
  - On macOS the traffic lights are inset in the bar. On Windows and Linux the
    bar is a title-bar overlay, with the native window controls on the right.
  - What gives way first as the bar narrows is in
    [Title bar priority](#title-bar-priority).
- **Primary action.** There is exactly one, chosen by the session's state, in
  this order:
  1. *Approve plan*, when a draft waits for approval;
  2. *Run*, when an approved plan is not running;
  3. *Stop*, while a run is live;
  4. *Review & Merge all*, once a run has settled with unmerged landings.

  Everything else is in `⋯`: Retry failed, Clean up, Discard run, New session,
  Close session, Take over…, Open in editor, Reveal in Finder or Explorer,
  Reset layout.

  The same action may also appear where the decision is made: Approve plan at
  the foot of the plan's approval card, Review & Merge all on the run diff.
  There it is the same action with the same label. A view never shows a second,
  different filled button.
- **Status bar.** As in the first build, at 24 px. It shows:
  - the daemon: attached or owned, its version, its connection state, and
    *joined :port* while a session is joined ([W16](#w16-a-session-another-host-holds));
  - the lease holder of the open session;
  - the runners, each with its name and whether it is signed in;
  - the account usage limits (`AccountLimitRows`).

  Each item opens its detail.
- **Command palette.** Cmd/Ctrl+K lists every command with its shortcut. It
  also quick-opens tasks (`#3`), files, branches and sessions.

## Sizing and responsive rules

### Defaults and bounds

The first time a workspace window opens, its panel widths come from the
window's width band. After that they are the user's, persisted per workspace.

| Element | 1280 px window | 1512 px window | 1920 px window | Min | Max |
|---|---|---|---|---|---|
| Activity bar | 52 | 52 | 52 | fixed | fixed |
| Sidebar | 240 | 260 | 280 | 200 | 480 |
| Plan panel | 340 | 360 | 380 | 300 (rail: 44) | 560 |
| Centre | 648 | 840 | 1208 | **560** | rest |
| Terminal (height) | 240 | 240 | 280 | 120 | 60 % of window height |
| Title bar (height) | 40 | 40 | 40 | fixed | fixed |
| Status bar (height) | 24 | 24 | 24 | fixed | fixed |

- **Bands.** A window up to 1400 px wide uses the 1280 column, up to 1700 px
  the 1512 column, and anything wider the 1920 column.
- **Windows.**
  - The workspace window opens at 1280 × 820 and its minimum becomes
    720 × 520 (it is 640 × 480 today). At 720 the centre still gets 624 px
    beside the rail.
  - The Welcome window opens at 1000 × 720, with the same minimum.
  - The title bar grows from 38 to 40 px. `TITLE_BAR_HEIGHT` in
    `packages/desktop/src/main/chrome.ts` and the overlay height follow it, and
    the traffic lights' `y` moves so they stay centred.
- **Sashes.** A 1 px divider has a 6 px hit area and shows `--ow-sash-hover`
  while dragged. A drag clamps at the panel's min and max, and at the centre's
  minimum, so a sash can never push the centre below 560.
- **The centre's height.** The tab content keeps at least 240 px. The terminal
  gives way first.

### Collapse order

As the window narrows, panels give way in a fixed order, so the centre never
drops below 560 px:

1. **The sidebar hides** when keeping it would leave the centre under 560 px.
   With the 1280 defaults that happens below about 1192 px. The activity bar
   stays, and clicking an activity opens the sidebar as an overlay drawer over
   the centre (elevation 2). The drawer closes on Esc, on a click outside, or
   on picking an item.
2. **The plan panel becomes a rail** when, with the sidebar hidden, it would
   still leave the centre under 560 px. With the defaults that happens below
   about 952 px.
   - The rail is 44 px wide. From the top it shows the Plan glyph, then one
     stacked count per status that has tasks (◆ 1, ◐ 2, ✓ 1, ✕ 0 hidden), each
     a 28 px button with an accessible name ("2 running").
   - Clicking the rail, or a count, opens the panel as an overlay over the
     centre's right edge, filtered to that status when a count was clicked.
3. **The centre** keeps 560 px or more down to the 720 px minimum window.

An automatic collapse is temporary. The user's own sizes and open or closed
choices come back when the window widens again, with 24 px of hysteresis, so a
window resized across a threshold does not flicker. A panel the user closed
themselves stays closed, at any width.

### Title bar priority

The title bar is one flex row, independent of the panel widths. This fixes the
first build's bug, where buttons vanished when a panel was resized.

- **The row, left to right:**
  1. a reserved area for the window controls: 78 px for the macOS traffic
     lights, or, on Windows and Linux, the area the overlay leaves, read from
     `env(titlebar-area-x)` and `env(titlebar-area-width)`;
  2. the breadcrumb, `flex: 1 1 auto; min-width: 0`;
  3. the scope switcher, `flex: 0 1 auto`;
  4. a flexible drag spacer;
  5. Needs you, `flex: none`;
  6. the primary action, `flex: none`;
  7. `⋯`, `flex: none`.

  Every button sets `-webkit-app-region: no-drag`, and the spacer and the bare
  bar set `drag`.
- **Give-way order.** As the bar narrows, things give way in this order, and
  nothing ever overlaps:
  1. The branch name in the breadcrumb shortens with an ellipsis in the middle,
     down to 12 characters.
  2. The project switcher drops its name and keeps its folder icon and
     chevron, then the repository segment drops. The workspace stays named in
     the switcher's tooltip and its accessible name, and each dropped segment is
     reachable from `⋯ › Go to`.
  3. The scope switcher shortens its label (*Checkout*, *Integration*, *#3*),
     then shrinks to its icon, then moves into `⋯`.
  4. Needs you drops its word and keeps its glyph and count (accessible name
     "Needs you, 2").
- **Never hidden.** The primary action always keeps its full label. Needs you
  is never hidden or clipped. `⋯` is always present. At the 720 px minimum
  these three, the window controls and the gaps fit, with room to spare.

### Persistence and Reset layout

The app keeps the layout in its own preferences (`prefs`), per workspace:

- the sidebar's width, whether it is open, and its activity;
- the plan panel's width and whether it is collapsed;
- the terminal's height and whether it is open;
- the graph's density and its critical path toggle.

For each session, the app keeps its kept tabs, their order, the split and the
active tab. Restoring drops preview tabs, and tabs whose target is gone.

*Reset layout*, in the command palette, the View menu and `⋯`, goes back to
the defaults for the window's current band. It keeps the open tabs.

## Wireframes

Every wireframe states what it shows, its actions, and its loading, empty and
error states. Where a state is one of the shared states below, it says so. The
wireframes are drawn at about a 1512 px window. The sizes are the ones in
[Sizing](#sizing-and-responsive-rules), not the character widths here.

**Shared states.**

- *Loading* is a skeleton of the final layout, with `--ow-bg-hover` bars in
  place of text, at the final heights, so nothing moves when the content
  arrives. A load that finishes quickly shows no spinner. A load still pending
  after a moment shows a muted "Loading …" line naming what it loads.
- *Error* is an inline banner in the region that failed. It gives the daemon's
  message as given, a Retry button, and a *Details* disclosure with the route
  and the status.
- A disconnect replaces every region's error with the
  [Reconnecting](#w15-daemon-disconnected-reconnecting) bar, so no region
  claims a failure of its own.
- *Empty* is one line on what would be here and one action that fills it,
  centred in the region, with the region's icon at 40 px in `--ow-fg-muted`
  above it.

### W1. Welcome and open project

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●                                                                                      │
│                                                                                            │
│                             ⟋⟋⟋●  ordewell        ← wordmark, 200 px                       │
│                   Turn one goal into an ordered plan of agent tasks.                       │
│                                                                                            │
│                 [ ▣ Open folder…  ⌘O ]     or drop a folder on this window                 │
│                                                                                            │
│   RECENT PROJECTS                                                                          │
│   ┌────────────────────────────┐  ┌────────────────────────────┐  ┌────────────────────────┐│
│   │ acme-app           ◆ 2   ✕ │  │ billing                  ✕ │  │ infra                ✕ ││
│   │ ~/code/acme-app            │  │ ~/code/billing             │  │ ~/code/infra           ││
│   │ ⑂ main                     │  │ ⑂ feature/tax-split        │  │ ⚠ Folder not found     ││
│   │ ◐ Add SSO login · Running  │  │ ✓ Split invoices · Settled │  │ Moved or deleted?      ││
│   │ 4 minutes ago              │  │ yesterday                  │  │ 3 weeks ago   [Forget] ││
│   └────────────────────────────┘  └────────────────────────────┘  └────────────────────────┘│
│                                                                                            │
│   RUNNERS                                                                                  │
│   ┌────────────────────────────┐  ┌────────────────────────────┐  ┌────────────────────────┐│
│   │ [Claude Code]              │  │ [Codex]                    │  │ [OpenCode]             ││
│   │ ✓ Signed in                │  │ ⚠ Signed out               │  │ ✕ Not installed        ││
│   │ version 1.4.2              │  │ version 0.9.1              │  │ Install OpenCode,      ││
│   │                            │  │ Sign in from its CLI       │  │ then Retry.            ││
│   │                            │  │ [Retry]                    │  │ [Retry]  [Docs ↗]      ││
│   └────────────────────────────┘  └────────────────────────────┘  └────────────────────────┘│
│                                                                                            │
│              ⌘O Open folder     ⌘K Command palette     ⌘, Settings     ⌘Q Quit             │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Ordewell 0.13.0                                          ● daemon :3742 · owned · 0.13.0   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Shows.**
  - *Logo.* The wordmark: `assets/readme/logo-dark.png` on dark and
    `logo-light.png` on light. Both are 880 × 289 and drawn 200 px wide.
    - The two files are copied into the renderer's bundle at
      `packages/desktop/src/renderer/assets/brand/`, so they load under the
      CSP's `'self'` with no network. A `<picture>` element switches them, with
      a `(prefers-color-scheme: dark)` source, so the logo follows the theme
      the way every other surface does.
    - The bare mark (`packages/vscode/media/icon.svg`) is drawn as an inline
      SVG component wherever a small logo is needed (the About dialog, the
      tray menu header, an empty state). Its strokes use `currentColor` and its
      dot uses `--ow-area-planner`. The file's own strokes are near-black, and
      would vanish on dark.
  - *Tagline.* "Turn one goal into an ordered plan of agent tasks", in
    `type.heading` at `--ow-fg-secondary`.
  - *Open folder.* The primary action and the only filled button on the
    screen. Beside it, a muted hint: "or drop a folder on this window".
  - *Recent projects,* as cards in a grid (`repeat(auto-fill, minmax(260px,
    1fr))`, at most 880 px across, at most 9 cards, then *Show all*). Each card
    shows:
    - the folder's name, in `type.body-strong`;
    - its path, with `~` for home and a middle ellipsis, in `type.code-small`;
    - its branch, from the app's store and refreshed from `GET /api/git/repos`
      once the daemon answers. A folder of repositories says "3 repositories";
    - its last session's goal and status (shape plus word), from the daemon's
      `GET /api/sessions` for that workspace;
    - its Needs you count, when one of its sessions is live and waiting;
    - a relative time ("4 minutes ago"), with the full date in the tooltip;
    - a Forget button (`✕`), which appears on hover and focus.
  - *Runners,* one card for each coding agent core ships: Claude Code, Codex,
    OpenCode, GitHub Copilot CLI, Qwen Code, Cline, Gemini CLI and Cursor. Each
    card shows:
    - the runner's badge, in its [runner colour](#visual-language);
    - its state: *Signed in*, *Signed out*, *Not checked* (unknown) or *Not
      installed* (missing), as a status shape plus a word;
    - its version, when `GET /api/runners` reports one;
    - an install or sign-in hint, when needed;
    - Retry.

    A runner that is off in Settings says "Off in Settings", with a link to
    Settings.
  - *Keyboard hints:* one muted line of the four shortcuts.
  - *Footer:* the app version on the left, and the daemon on the right
    (attached or owned, its port, its version, its connection state). The
    footer is 24 px high and drawn like the status bar.
- **Actions.**
  - *Open folder* (⌘O / Ctrl+O) is a native picker (`dialog.pickFolder`).
  - *Dropping a folder* anywhere on the window opens it. While a drag is over
    the window, its content dims and a dashed `--ow-accent` outline is drawn 12
    px inside the edges, reading "Drop a folder to open it". Dropping a file,
    or more than one item, says "Drop one folder" and opens nothing.
  - A card opens its workspace on click or Enter. Opening a workspace already
    open in a window focuses that window (H6).
  - *Forget* removes a card from the list without asking: the folder itself is
    untouched, and the toast offers Undo.
  - For a runner that is signed out, the hint names its own CLI sign-in, as the
    chat does (ADR-0052), and the card offers that agent's own way in: *Log
    in*, which runs the manifest's login in a terminal, or *Set API key…*,
    which opens the key entry for a key-based agent.
  - For a runner that is missing, the hint reads "Install <runner>, then
    Retry". *Docs ↗* opens the runner's own install page through
    `shell.openExternal`.
  - *Retry* asks `GET /api/runners` again and redraws that card.
- **Loading.**
  - *Cards* draw at once from the app's own store (name, path, the last known
    branch and goal). The live lines (status, Needs you) are skeleton bars
    until the handshake.
  - *Runner cards* are skeletons with the runner's name until
    `GET /api/runners` answers.
  - *Footer* reads "daemon: connecting …".
- **Empty.**
  - *Recent projects:* no workspaces opened yet. In place of the grid is one
    wide card with a dashed `--ow-border-control` border, reading "Open a
    folder to start. A workspace is a folder, usually a git repository or a
    folder of them." It is itself a drop target.
  - *Runners:* none enabled. "No runners are on. Turn one on in Settings."
- **Error.**
  - *A recent folder that is missing:* its card is drawn at `--ow-fg-muted`
    with "⚠ Folder not found" and *Forget*, and it does not open.
  - *A folder that is not a git repository* still opens. The isolation preview
    later says it runs without isolation.
  - *No live state:* the cards keep their stored lines and add "Live state
    unavailable", and the footer shows the daemon's state with Retry.
  - *A handshake failure* shows the [mismatch](#w15-daemon-disconnected-reconnecting)
    card in place of the runner cards. The recent cards still open, and each
    one shows the same card.
  - *`GET /api/runners` failing* shows the shared error banner across the runner
    row.

### W2. Session while planning

```
┌ ● ● ●  acme-app › web › main ▾   ◫ Your checkout ▾                         [✓ Approve plan]  ⋯ ┐
├────┬──────────────────┬────────────────────────────────────────────────────┬─────────────────────┤
│▌☰  │ ☰ SESSIONS     + │ Planner │                                          │ PLAN  Draft · 4  ⑃ ⇥│
│    │ NEEDS YOU (0)    │ ┌──────────────────────────────────────────────────┐│ ○ #1 Read the auth  │
│ ⎘  │ SESSIONS         │ │ Add SSO login                         ● Planning ││   Research          │
│    │▌◐ Add SSO login  │ │ [Claude Code] sonnet ▾  low ▾  ctx 18%  5h 40% ⋯ ││   Claude · sonnet   │
│ ⑂  │  Planning · now  │ ├──────────────────────────────────────────────────┤│ ○ #2 Add SAML call… │
│    │ ✓ Fix flaky CI   │ │        You                                       ││   Codex · gpt-5 · md│
│ ⑃  │  Settled · 2d    │ │        Add SSO login with Okta to web.           ││   ⇠ #1              │
│    │                  │ │                                                  ││ ○ #3 Add login butt…│
│    │                  │ │        Planner                                   ││   Claude · sonnet   │
│    │                  │ │        I'll start by reading the auth module …   ││ ░ #4 ░░░░░░░░░░░░   │
│    │                  │ │        ▸ read src/auth/* · 3 research steps      ││                     │
│    │                  │ │        ● reading src/auth/session.ts …           ││                     │
│    │                  │ │                                                  ││                     │
│    │                  │ │        ┌──────────────────────────────────────┐  ││                     │
│ ⚙  │                  │ │        │ Message the planner …                │  ││                     │
│    │                  │ │        └──────────────────[Stop planning]─────┘  ││                     │
├────┴──────────────────┴─┴──────────────────────────────────────────────────┴┴─────────────────────┤
│ ● daemon :3742 (owned)   lease: this daemon   planner: Claude Code · sonnet   5h: 40%            │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Shows.**
  - *The planner tab.* At its top, the **session header**:
    - the goal, in `type.heading`, with a middle ellipsis and the full goal in
      the tooltip;
    - the session's status chip;
    - a holder or joined chip, when there is one ([W16](#w16-a-session-another-host-holds));
    - the planner as its runner badge, then the model, effort, context fill and
      usage (`UsageLine`), with `⋯` for fork, rewind and compact.

    When the centre is narrower than 720 px, the planner, model and effort fold
    into one button ("Claude Code · sonnet ▾").
  - *The conversation,* across the tab's full width, with research steps folded and
    the planner's live step as a line with a running shape.
  - *The plan panel* fills in row by row as the draft streams. A partial task is
    drawn as a skeleton row.
- **Actions.**
  - Message the planner. While a turn runs, ⏎ queues a message and ⌘⏎ /
    Ctrl+Enter sends now: every queued message, in the order typed, with what
    is in the composer last, as one message. Esc takes back the newest queued
    message, into the composer only when it is empty. Stop planning.
  - Switch the planner, model and effort.
  - Fork, rewind or compact the conversation (header `⋯`).
  - A planner question with options draws as buttons in the conversation.
  - Click a draft row to open its task tab, where its prompt, assignment and
    dependencies are edited (the panel itself edits nothing).
  - *Approve plan* in the title bar once drafting ends; the approval card
    appears at the foot of the conversation ([W3](#w3-plan-approval)).
- **Loading.** A turn in flight shows the planner's live step ("reading
  src/auth …") and Stop planning. The draft fills in row by row.
- **Empty.**
  - *A new session:* the conversation area shows the planner picker and a
    larger composer, centred vertically, with the `composerTips` line under it.
  - *The plan panel* reads "No plan yet. Describe a goal to the planner." with
    no action, since the composer is already focused.
- **Error.**
  - A planner turn that fails shows the failure in the conversation, with
    Resend.
  - A usage limit shows the `PlannerPauseBar` above the composer (ADR-0044).
  - A signed-out planner shows `PlannerLogin` in place of the composer
    (ADR-0052).

### W3. Plan approval

```
│ Planner │                                                            │ PLAN  Ready · 4    ⑃ ⇥│
│ ┌───────────────────────────────────────────────────────────────────┐ │ ○ #1 Read the auth mo…│
│ │        Planner                                                    │ │   Research            │
│ │        Here is the plan: four tasks over two repositories …       │ │   Claude · sonnet · lo│
│ │                                                                   │ │ ○ #2 Add SAML callbac…│
│ │        ┌───────────────────────────────────────────────────────┐  │ │   Codex · gpt-5 · med │
│ │        │ Plan ready for approval · 4 tasks · 2 runners         │  │ │   ⇠ #1                │
│ │        │ Isolation  worktree per task in web, api (2 repos)    │  │ │ ○ #3 Add login button │
│ │        │            lands on main in each                      │  │ │   Claude · sonnet     │
│ │        │ Run        2 at a time · supervisor Observe ·         │  │ │   ⇠ #2                │
│ │        │            merge automatically off          [Edit]    │  │ │ ○ #4 Run the e2e suite│
│ │        │ ─────────────────────────────────────────────────────  │  │ │   Script  ⇠ #2 #3     │
│ │        │ ⚠ #4 is a script. It runs `npm run test:e2e`          │  │ │                       │
│ │        │   in its worktree.            ☐ I have read it        │  │ │                       │
│ │        │                                                       │  │ │                       │
│ │        │              [Ask for changes]   [✓ Approve plan]     │  │ │                       │
│ │        └───────────────────────────────────────────────────────┘  │ │                       │
│ │        ┌───────────────────────────────────────────────────────┐  │ │                       │
│ │        │ Message the planner …                                 │  │ │                       │
```

- **Shows.**
  - *The approval card,* at the foot of the conversation, where the person is
    already reading. It holds:
    - the plan's size;
    - the isolation preview (`GET /api/workspaces/isolation-preview`): the
      repositories, the branch each one lands on, or why the plan runs without
      isolation;
    - the run settings;
    - the `PlanApprovalNote`, including any script or effect that needs reading
      (ADR-0035).
  - *The plan panel* shows the whole plan, as rows.
  - The title bar's primary is *Approve plan*. It is the same action as the
    card's button, so the view still has one primary ([checklist A2](#design-review-checklist)).
- **Actions.**
  - Approve (`POST review/approve`), from the card or the title bar.
  - Tick each effect.
  - Edit the run settings.
  - *Ask for changes* focuses the composer.
  - Open a task from the panel to edit it in its tab.

  *Approve plan* stays disabled in both places until each effect the note
  lists is ticked. Its tooltip names what is left.
- **Loading.** The isolation line shows "Checking repositories …".
- **Empty.** Not reachable: a plan with no tasks shows W2's empty state.
- **Error.** A plan that fails validation lists each problem in the card, each
  one linking to its task, and marks those rows with `✕`. Approval stays
  disabled.

### W4. Run in progress — the plan panel

```
┌ ● ● ●  acme-app › web › main ▾   ◫ Your checkout ▾                ◆ 1 Needs you   [■ Stop]  ⋯ ┐
├────┬──────────────────┬────────────────────────────────────────────────────┬─────────────────────┤
│▌☰  │ ☰ SESSIONS     + │ Planner │ #3 Add login button ✕ │                  │ PLAN  ◐ 1/4    ⑃ ⇥  │
│ 1  │ NEEDS YOU (1)  ▾ │                                                    │ 2 running · 1 passed│
│ ⎘  │ ◆ #2 Add SAML …  │   (the planner conversation, or the open           │ ✓ #1 Read the auth …│
│    │   approval:      │    task tab: W6)                                   │   Claude · sonnet   │
│ ⑂  │   npm i saml2-js │                                                    │   Passed  2m 10s    │
│    │   [Allow][Deny]  │                                                    │▌◆ #2 Add SAML call… │
│ ⑃  │ SESSIONS         │                                                    │   Codex · gpt-5 · md│
│    │▌◐ Add SSO login  │                                                    │   ◆ approval        │
│    │  Running 1/4 · now│                                                   │   [Allow] [Deny]  ⋯ │
│    │ ✓ Fix flaky CI   │                                                    │ ◐ #3 Add login butt…│
│    │  Settled · 2d    │                                                    │   Claude · sonnet   │
│    │                  │                                                    │   Running  1m 02s   │
│    │                  │                                                    │ ○ #4 Run the e2e su…│
│ ⚙  │                  │                                                    │   Script · waits #2 │
```

- **Shows.**
  - *The plan panel:* one [`TaskSummary` row](#task-row-card-and-header-contents)
    per task. The header gives a run summary ("2 running · 1 passed"), and the
    selected row has a `--ow-accent` bar on its left edge.
  - *A row with a waiting approval or checkpoint* grows a third line with its
    options, so the commonest answer is one click from the plan.
  - *Needs you* heads the Sessions sidebar, and the Sessions activity shows its
    count.
- **Actions.**
  - Select a row (↑ and ↓ with the panel focused). Its header is a toggle:
    a click, Enter or Space opens the card in place, and again closes it. A
    click inside the open card (a button, the prompt editor, a link, selecting
    text) never closes it.
  - An open card starts with its prompt and handoff folded to one line each:
    the prompt's first line, and the handoff summary's first line with its
    findings count. Each unfolds to the whole; the prompt is edited there,
    where editing is allowed, and the handoff only reads.
  - Every card fits the panel at any width: a row wraps, or cuts to an ellipsis
    with the whole in a tooltip, and the actions wrap onto a new line.
  - An open running card shows the output tail: a 6-line `type.code` box.
  - Hovering or focusing a row shows its first action and `⋯`; the rest of the
    row actions are in `⋯` and the context menu.
  - *Stop* in the title bar asks first, naming the running tasks.
  - `G`, with the panel focused, opens the graph tab.
- **Loading.** On opening a session with a live run, the panel draws from
  `run_snapshot` at once. Nothing is shown as running until the snapshot says
  so.
- **Empty.** Not reachable while a run is live.
- **Error.** A command that is refused shows the refusal under that row for a
  few seconds, and in the row's history. It is never a toast elsewhere.

### W5. The plan graph tab

```
│ Planner │ ⑃ Graph · Add SSO login ✕ │                                                                │
│ ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ‹  [Stage 1 ✓ 1/1] [Stage 2 ◆ 0/2] [Stage 3 ◐ 0/1] [Stage 4 ○ 0/1]  ›   ◇ Critical path  Comfortable│Compact │
│ │    └──────────── in view ────────────┘                                                          │ │
│ ├──────────────────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ STAGE 1                       STAGE 2                       STAGE 3                     │ STAGE 4│ │
│ │ ┌───────────────────────┐     ┌───────────────────────┐     ┌───────────────────────┐   │ ┌──────│ │
│ │ │ ✓ #1 Read the auth    │━━┳━▶│ ◆ #2 Add SAML callback│━━━━▶│ ◐ #3 Add login button │━━━│▶│○ #4 R│ │
│ │ │      module           │  ┃  │      route            │     │                       │   │ │      │ │
│ │ │ ●Claude ▣ sonnet ◔ low│  ┃  │ ●Codex ▣ gpt-5 ◔ med  │     │ ●Claude Code ▣ sonnet │   │ │⎘ Scri│ │
│ │ │ ⌕ Research Pa… 2m 10s │  ┃  │ ◆ Approval Needs you ▭│     │ Running      1m 02s ▭ │   │ │⟲ 1/3 │ │
│ │ └───────────────────────┘  ┃  └───────────────────────┘     └───────────────────────┘   │ └──────│ │
│ │                            ┃  ┌───────────────────────┐                                 │        │ │
│ │                            ┗━▶│ ○ #5 Billing          │╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌▶│        │ │
│ │                               │ ⑃ Child plan 3 tasks… │                                 │        │ │
│ │                               │ ⑃ Delegated  Running  │                                 │        │ │
│ │                               └───────────────────────┘                                 │        │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│   ━ edges of the selected task   ╌ other edges, faint   ⟲ n/max loop rounds on the check             │
│   ● runner colour   ▣ model   ◔ thinking effort   ▭ Open chat                                        │
```

- **Stages.** A *stage* is a column of the graph. Stage 1 holds the tasks with
  no dependencies. Every other task sits in the stage after its latest
  dependency: stage(t) = 1 + the largest stage among t's dependencies. So
  every edge points right, and a task's dependencies are all in earlier
  stages. Within a stage, tasks keep the plan's order. A loop is a `⟲ n/max`
  badge on its check, with no back-edge.
- **Shows.**
  - *The stage strip,* at the top, 32 px high. It shows one chip per stage:
    "Stage n", the stage's aggregate status shape and `done/total`.
    - The aggregate is the first that applies, in this order: Needs you,
      Failed, Running, Blocked, Waiting for merge, Not started, then Passed
      when every task passed or was skipped.
    - A bracket under the chips marks the stages in view.
    - ‹ and › sit at the ends, and the density and critical path toggles at the
      right.
  - *Columns,* each headed "STAGE n" in `type.overline`, stacked top to bottom.
    - Comfortable cards are 264 px wide and 104 px high (three rows, the
      title's taking two lines). Compact cards are 216 px wide and 60 px
      high (two rows). Every card of a density has the same height, so the
      cards of a column line up and an edge always meets a card at the same
      point, however long its title or model.
    - Columns are 56 px apart, which leaves room for the edges' lanes. Cards in
      a column are 12 px apart (Comfortable) or 8 px apart (Compact).
    - Each column is a quiet lane: the `panel` step of the
      [ladder](#surfaces) behind its head and its cards, rounded at the foot,
      with no border. It paints under the edges, so an edge that skips a stage
      crosses the lane, never a card.
  - *Cards* show what the List row shows, laid out for a card, as
    [the card](#task-row-card-and-header-contents) has it. Subtasks and child plans fold
    into their parent card with a count ("▸ 3 tasks · 1 running") and expand
    in place, below it.
    - A card is a ladder card: `card` fill, `card-border` hairline,
      `--ow-radius-lg` and `--ow-elevation-card`. Hover deepens it to
      `card-hover` and tints its edge toward the accent.
    - The selected card is `card-selected` inside a 2 px `--ow-accent` ring,
      so the selection reads as teal in both themes and both densities, and its
      edges carry the same accent.
  - *Edges* are SVG paths drawn under the cards. Each runs from the right edge
    of a dependency's card to the left edge of its dependent, through the gap
    between columns, with rounded corners and no diagonal lines.
    - With a task selected, its incoming and outgoing edges are drawn in
      `--ow-accent` at 2 px, and the others fade to 35 % opacity.
    - With no task selected, every edge is `--ow-border-control` at 1.5 px.
  - *Critical path.* The longest chain of unfinished work by dependency. When
    toggled on, its edges are drawn 2 px in `--ow-fg-secondary`, and its cards
    get a 2 px left border.
- **Actions.**
  - *Click a card*, or Enter on it, to reveal it in the List: it is selected,
    the plan panel opens (the drawer, when the window is too narrow to dock
    it), and its card opens there, scrolled into view. No tab opens.
    Selection is shared with the List.
  - *Open chat* on a card opens the task tab on Chat. It is the only part of
    a card that opens a tab; the context menu keeps its chat and diff items.
  - The card's attention badge (an approval, say) opens the task tab on Chat at
    that approval.
  - *Scrolling.* The wheel scrolls vertically, and every column moves
    together. Shift and the wheel, a horizontal trackpad swipe, or ‹ and ›
    move by one stage and snap to a stage's left edge. Clicking a stage chip
    scrolls that stage to the left edge.
  - *Keys.*
    - ← moves to a dependency and → to a dependent. When a task has several,
      a small menu lists them.
    - ↑ and ↓ move within a stage.
    - Home and End go to the first and last stage.
    - Space toggles the output peek, drawn as a popover beside the card.

  The graph has no drag, no pan by dragging, no free zoom and no minimap.
  Density replaces zoom. The graph cannot add, remove or connect tasks:
  structure is edited in the task tab.
- **How it is built.**
  - The scroller is a native overflow container with
    `scroll-snap-type: x mandatory`. Each column has
    `scroll-snap-align: start`, so a trackpad, a mouse and the keyboard all
    land on a stage edge without a scroll library.
  - Layout is a pure function of the plan's shape: stages, then order within a
    stage, then edge lanes. It is computed again only when the shape changes. A
    status change restyles a card without moving it.
  - Cards are DOM elements (buttons inside a `grid` role), never pixels on a
    canvas.
- **Loading.** The stages and cards draw from the same snapshot as the List.
  A plan still streaming adds cards at the bottom of their stage.
- **Empty.** As W2's plan panel, with *Back to the planner*.
- **Error.** A plan the layout cannot place (a cycle a validation missed) says
  so in the tab, names the tasks in the cycle, and offers *Show the List*,
  which focuses the plan panel.

### W6. The task tab — Details and Chat

```
│ Planner │ #2 Add SAML callback route ✕ │                                                         │
│ ┌────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ◆ #2 Add SAML callback route                        Needs you · approval     Details │ Chat   │ │
│ │ [Codex] gpt-5 · medium · Build    ⇠ #1  ⇢ #3 #4    ⑂ ordewell/r7/2    [Δ Diff]  [Retry]  ⋯     │ │
│ ├────────────────────────────────────────────────────────────────────────────────────────────────┤ │
│ │          VERDICT     Not yet: attempt 2 is running                                             │ │
│ │          PROMPT      Add a POST /auth/saml/callback route that …                       [Edit]  │ │
│ │          ASSIGNMENT  runner Codex ▾  model gpt-5 ▾  effort medium ▾  mode Build ▾      [Edit]  │ │
│ │          DEPENDS ON  #1 Read the auth module ✓                                         [Edit]  │ │
│ │          HANDOFF     From attempt 1. Failed: tests missing SAML_CERT …  F1 F2       [Open]   │ │
│ │          ATTEMPTS    #2 running 1m 12s · #1 failed (tests failed, evidence ▸)                  │ │
│ └────────────────────────────────────────────────────────────────────────────────────────────────┘ │

│ │ ◆ #2 Add SAML callback route                        Needs you · approval     Details │ Chat   │ │
│ │          ┌────────────────────────────────────────────────────────────────────────┐           │ │
│ │          │ Codex  Reading src/auth/routes.ts …                                   │           │ │
│ │          │ ▸ ran `npm test -- auth` (exit 1)                                      │           │ │
│ │          │ ◆ Approval: run `npm i saml2-js`   [Allow once] [Allow always] [Deny]  │           │ │
│ │          └────────────────────────────────────────────────────────────────────────┘           │ │
│ │          ┌──────────────────────────────────────────────────────── Message #2 · Codex┐        │ │
│ │          │                                                                           │        │ │
│ │          └────────────────────────────────────────────────── [Interrupt] [Send ⏎]────┘        │ │
```

- **Shows.**
  - *The tab header* is the [`TaskSummary` header](#task-row-card-and-header-contents):
    - on its first line, the status, order and title, the status word with its
      reason, and the Details and Chat switch;
    - on its second line, the runner badge, model, effort and mode, the
      dependencies in and out as links, the branch, *Diff*, the task's first
      action, and `⋯`.
  - *Details,* in the 800 px column: the verdict first, with its evidence (the
    `task_complete` call, a script's exit status, a check's result). Then the
    prompt, the assignment, the dependencies in and out, the handoff with its
    findings and artifacts (`TaskHandoff`, `HandoffCard`), and the attempts.
  - *Chat:* the task's output as the VS Code chat draws it, with its approvals
    and checkpoints inline.
- **Actions.**
  - Edit the prompt, assignment and dependencies. A running task's edits apply
    to its next attempt, and the editor says so. Editing keeps a preview tab.
  - Run, retry, revert, skip, remove, or mark complete or not done
    (`execute-command`).
  - Answer an approval or checkpoint.
  - Message the task (`message_task`), with *send now* and queued messages.
  - Interrupt.
  - Open the diff (a diff tab).
- **Loading.** Chat loads the attempt's log (`GET
  /api/sessions/:id/tasks/:taskId/log`), then follows frames.
- **Empty.** A task never started: Chat says "No attempts yet", and its
  composer is disabled with the reason.
- **Error.** A log that cannot be read shows its error in Chat. Details still
  draws from the plan.

### W7. Needs you, in the title bar and the Sessions sidebar

```
                                                       ◆ 2 Needs you  ◀ button, amber when any wait
                                    ┌────────────────────────────────────────────┐
                                    │ NEEDS YOU                         2 items  │
                                    ├────────────────────────────────────────────┤
                                    │ Add SSO login                              │
                                    │ ◆ #2 Add SAML callback route   approval    │
                                    │   Codex wants to run: npm i saml2-js       │
                                    │   in the ordewell/r7/2 worktree            │
                                    │   [Allow once] [Allow always] [Deny] [Open]│
                                    ├────────────────────────────────────────────┤
                                    │ Fix flaky CI                               │
                                    │ ⧉ Run r6                     merge-all     │
                                    │   3 tasks landed, nothing left to move it  │
                                    │   [Review & Merge all]              [Open] │
                                    └────────────────────────────────────────────┘
```

- **Shows.**
  - *The escalations* of every session of this workspace that is live on a
    daemon the app can reach: its own, or a joined one. The list comes from one
    `GET escalations` per live session. There is one card per escalation, with
    its reason, its task and the options it offers (ADR-0053), grouped under
    the session's goal when more than one session has items.
  - *The title bar button* counts the cards and turns `--ow-status-attention`
    when any wait.
  - *The Sessions sidebar* shows the same list at its head, as a collapsible
    *Needs you* section, with compact cards: the first option inline, the rest
    behind Open.
- **Actions.**
  - Each option answers through `POST escalations/answer`. An option whose card
    asks a question first asks it here.
  - *Open* switches to the card's session, if needed. An answer or a question
    opens the task tab on Chat; any other wait reveals the task in the List,
    as a graph click does.
  - Cmd/Ctrl+Shift+A opens the popover.
- **Loading.** The popover opens on the last list and refreshes. An answer in
  flight disables that card's options.
- **Empty.**
  - *The popover* reads "Nothing needs you."
  - *The title bar button* keeps its place, showing the glyph alone in
    `--ow-fg-secondary`, so the title bar does not shift.
  - *The sidebar section* collapses to its header, with count 0.
- **Error.** An answer refused because the wait moved on (its id is gone)
  replaces the card with what it became.

### W8. Explorer with the scope switcher

```
┌ acme-app › web › main ▾   ◫ Task #3 worktree ▾                            ┐
│                           ┌─────────────────────────────────────┐            │
│                           │ web                                 │            │
│                           │  ● Your checkout          main      │            │
│                           │  ○ Integration branch     run r7    │            │
│                           │  ○ Task #1 worktree       ✓ landed  │            │
│                           │  ○ Task #3 worktree       ◐ running │            │
│                           │ api                                 │            │
│                           │  ○ Your checkout          main      │            │
│                           └─────────────────────────────────────┘            │
├────┬─────────────────────────┬──────────────────────────────────────────────┤
│▌⎘  │ ⎘ EXPLORER  web · #3 ⊡  │ Planner │ Login.tsx · #3 (read-only) ✕       │
│    │ ▾ src                   │  1  import { useState } from 'react';        │
│    │   ▾ components          │  2  export function Login() {                │
│    │     Login.tsx      M    │  3    const [busy, setBusy] = useState(false);│
│    │     Button.tsx          │  … Monaco, read-only                         │
│    │ ▸ .ordewell/skills      │                                              │
│    │   dist/          ignored│  Read-only: task #3's worktree. Edit in your │
│    │                         │  checkout.            [Open Your checkout]    │
```

- **Shows.**
  - *The tree* of the current [view scope](#the-scope-model), one directory at
    a time (`GET /api/files/tree`), with git status letters and ignored entries
    marked. `.ordewell/skills/` is shown; the rest of `.ordewell` and `.git`
    never are (ADR-0064 R3).
  - *A file* opens in Monaco as a file tab (indigo marker), editable only in
    the checkout.
  - *The sidebar header* names the scope, with a lock (⊡) when it is
    read-only.
- **Actions.**
  - Switch the scope.
  - Open, preview or split a file.
  - Quick open (Cmd/Ctrl+P, by name, via `GET /api/files/find`).
  - In the checkout: edit and save (Cmd/Ctrl+S), and *Open in editor*.
  - Copy a path.

  New file and rename are later.
- **Loading.** A directory expands with a one-line skeleton.
- **Empty.** An empty directory says so. A scope with no files says why.
- **Error.**
  - A `binary` or `too-large` file shows its size, and *Open in editor* in the
    checkout only.
  - A `gone` scope (its worktree and branch removed) says so and offers the
    checkout.
  - A symlink out of the workspace is listed but not followed.

### W9. Changes review — a diff with a line comment

```
│ Planner │ Δ #3 Add login button ✕ │                                                          │
│ ┌──────────────────┬───────────────────────────────────────────────────────────────────┐ │
│ │ CHANGED (3)      │ src/components/Login.tsx            Side by side │ Inline   [⤢]   │ │
│ │ M Login.tsx +24-3│  12   const [busy, setBusy]          12   const [busy, setBusy]   │ │
│ │ A saml.ts   +40  │  13 - return <button>Log in</button> 13 + return <SsoButton       │ │
│ │ M routes.ts +6-1 │                                      14 +   provider="okta" />    │ │
│ │                  │      ┌──────────────────────────────────────────────────────────┐ │ │
│ │ web · #3 vs main │      │ Comment on line 14: use the provider from config.        │ │ │
│ │ base 4f2a91c     │      │ Sends to #3 as a message.          [Cancel] [Send to #3] │ │ │
│ │                  │      └──────────────────────────────────────────────────────────┘ │ │
│ └──────────────────┴───────────────────────────────────────────────────────────────────┘ │
```

- **Shows.**
  - *The diff,* in a diff tab (mint marker): a task's diff
    (`GET /api/plans/:sessionId/tasks/:taskId/diff`) or the whole run's
    (`GET isolation/diff`, one section per repository).
  - *The layout:* the file list first, then each file's patch on demand, in
    Monaco's diff editor.
  - *The header* names the repository, the task, and the base the diff is
    compared with.
  - *The Changes sidebar in a run scope* lists the run's tasks under a
    collapsible *Review* heading, each task a card of its changed files, then
    *Whole run vs base*, the conflicts, the merge gates and Merge all. Review
    folds the task list alone: the whole run, the waits and Merge all are never
    folded away. Folded under a filter, Review says to open it to see the
    tasks that match, and a folded task card shows how many of its files match
    (`2/7`, read as "2 of 7 files match").
- **Actions.**
  - Side by side or inline. Next and previous change.
  - A task card turns over by a click anywhere on its head, title and chevron
    alike, or by Enter or Space. Revert… and Show in plan stay buttons of their
    own and never turn it. Review's fold is the window's; each task card's and
    Whole run's are kept per session. Every one outlives an activity switch.
  - A line comment, sent to the task as a `message_task` quoting the file and
    the line. A running task gets it now, a finished one on its next attempt,
    as ADR-0023 says.
  - *Review & Merge all* from the run diff, which is the title bar's primary
    when the run has settled.
  - Revert a task from its diff (with `revert-preview`).
- **Loading.** The file list first, then the selected patch.
- **Empty.** "No changes in this task." A research or read-only task lands
  nothing (ADR-0046). The daemon names why a task has no diff
  (`cause` on the task-diff answer), and the view reads that with the live
  task, since the saved run it answers from trails the live one:
  - *Quiet,* in `--ow-fg-secondary`: "No changes yet." for a task that has not
    started, or whose worktree record has not reached the saved run. A running
    task's quiet answer is read again a few times, backing off from 1 s to
    16 s, once the window is shown and the daemon connected; past that,
    Refresh reads it again. A settled task is never polled.
  - *Unavailable,* minimal amber with an info glyph and no alert: a read-only
    task, an ops or writing script task, a run that shares the checkout, or a
    task that ended with no worktree record.
- **Error.** A diff whose task branch is gone says so. A binary file shows its
  sizes only. A read that truly failed (git, the file system, an artifact, or
  an answer with no cause this app knows) stays red, as an alert.

### W10. The user's checkout changes and the commit box

```
├────┬──────────────────────────────┬─────────────────────────────────────────────────────────┤
│▌⑂  │ ⑂ CHANGES   web · main ▾     │ Planner │ Δ README.md (working tree) ✕                  │
│    │ ┌──────────────────────────┐ │   3  ## Setup                     3  ## Setup           │
│    │ │ Message (⌘⏎ to commit)   │ │   4 -Run npm i                    4 +Run npm ci         │
│    │ │ Fix setup instructions   │ │                                                         │
│    │ └──────────────────────────┘ │  [Stage hunk] [Discard hunk]                            │
│    │ [Commit ▾]  ☐ Amend          │                                                         │
│    │ STAGED (1)                   │                                                         │
│    │  M README.md          [−]    │                                                         │
│    │ CHANGES (2)                  │                                                         │
│    │  M src/app.ts      [+][↶]    │                                                         │
│    │  ? notes.txt       [+][↶]    │                                                         │
│    │ ⓘ main is run r7's landing   │                                                         │
│    │   branch: actions here are   │                                                         │
│    │   noted in its timeline.     │                                                         │
│    │ ↓ 0 ↑ 2  [Fetch][Pull][Push] │                                                         │
```

- **Shows.**
  - *Per repository, the checkout's files:* staged, unstaged, untracked and
    conflicted (`GET /api/git/status`).
  - *The commit box,* and the branch's ahead and behind against its upstream.
  - *A note* when the branch is a live run's landing branch (ADR-0062 G6).

  Selecting a file opens its working-tree diff in Monaco.
- **Actions.**
  - Stage, unstage and discard, by file or by hunk.
  - Commit (Cmd/Ctrl+Enter). *Commit* is this sidebar's own filled button; the
    title bar's primary stays the session's.
  - *Amend*, shown only while HEAD is unpushed (G4).
  - Stash and pop, from the `Commit ▾` menu.
  - Fetch, pull and push to the tracking remote.

  Discard asks first, listing the files. Pull and push ask first, naming the
  remote and the branch (G3).
- **Loading.** Status refreshes on focus and on a run's landing frames. An
  action in flight disables its buttons.
  - *Fetch, pull and push* run one at a time per repository, whichever
    surface started them: this sidebar, the Git sidebar's Fetch or the
    palette's *Git: Fetch*. The one running is `busy`: its icon moves, it is
    `aria-busy`, and it stays at full strength while the other two are
    disabled. Fetch's circling arrows turn. Pull's and Push's arrows never
    turn, since a turned arrow points the wrong way half the time: the arrow
    glides down into its line for Pull, or up out of it for Push, while the
    line stays still (`busyMotion="glide"`). Pull and push are busy only once
    their confirm is accepted. The icon moves only while the action is
    pending, and holds still under reduced motion. A second start while one
    runs is refused, and announced as "web is already syncing."; the
    palette's Fetch is disabled meanwhile.
- **Empty.** "No changes in web." Ahead and behind still show.
- **Error.**
  - A refused action shows git's own text in the box: a hook that failed, a
    rejected push, a missing credential. It also shows the route's refusal
    name.
  - `confirm_stale` reopens the confirm with the new state.
  - `pushed` explains why amend is gone.

### W11. The Git view — branches and history, in the sidebar

```
├────┬──────────────────────────────┬─────────────────────────────────────────────────────────┤
│▌⑃  │ web                        ⟳ │ Planner │ Commit 9c1e2d0 │ setup.md @ 9c1e2d0 ✕        │
│    │ ⑃ main                       │                                                        │
│    │ [Fetch] [Pull ↓1] [Push ↑2]  │  Fix setup instructions                                │
│    │ [⑂ Branches] [◷ History]     │  9c1e2d0 · you · 2 minutes ago                         │
│    │ ▾ Local                    + │  …message…                                             │
│    │   ✓ main  ↑2   ⊡ run r7      │  M docs/setup.md                                       │
│    │   ▾ feature              2   │                                                        │
│    │       sso                    │                                                        │
│    │       x                      │                                                        │
│    │ ▾ Ordewell                   │                                                        │
│    │   ▸ ordewell/r7          3   │                                                        │
│    │ ▾ Remote                     │                                                        │
│    │     origin/main              │                                                        │
│    │ ▾ Stashes                    │                                                        │
│    │     ordewell: before Merge … │                                                        │
```

Pressing `feature/sso` turns the same sidebar to its History; the centre is
left as it was:

```
│    │ ⑃ main                       │
│    │ [⑂ Branches] [◷ History]     │
│    │ [History of: feature/sso ▾] ↶│
│    │ Browsing only: your checkout │
│    │ stays on main.               │
│    │ ● Add SSO callback           │
│    │ │ a41c09e · ana · 1d         │
│    │ ●╱ Bump deps                 │
│    │    4f2a91c · you · 2d  v1.2  │
│    │ [Load more]                  │
```

- **Shows.**
  - *The repository's name* at the head, with Refresh, and a Repository
    picker when the workspace holds several.
  - *Your checkout:* the checked-out branch (or "Detached HEAD") in
    `body-strong`, and Fetch, Pull and Push under it. They act on the
    checkout whatever the list below shows, and its tooltip says so.
  - *A Branches/History switch:* two `aria-pressed` buttons in a group named
    "Git sidebar view". The choice is the window's and outlives an activity
    switch and a change of repository.
  - *Branches* (`GET /api/git/branches`):
    - local branches, with ahead and behind;
    - Ordewell's branches, in their own read-only group;
    - worktrees, and the integration branch of a live run;
    - remote-tracking branches, as of the last fetch;
    - stashes.

    A lock marks a live run's landing branch, naming the run. A branch name
    with slashes is folded under its prefixes (`feature/` holds `sso` and
    `x`), each folder showing its branch count; a row still names its branch
    in full to a screen reader and in its tooltip. The checked-out branch is
    told by its tick and weight, not by a colour: green is a status's. The
    branch History is showing keeps the selected background on Branches.
  - *History:* commits down the sidebar, two lines a row: the subject, then
    its branch and tag chips and the short sha, author and age, with the
    commit graph's lanes drawn small beside them. The HEAD chip is left out,
    since the checkout's own chip says it. The full sha and the chips are in
    the row's tooltip. Its head names whose history it is: a "History of"
    picker (your checkout, or any local, Ordewell or remote branch), and,
    while a branch is browsed, a ↶ "Show your checkout’s history" button and
    a line saying the checkout stays where it is ("Browsing only: your
    checkout stays on main.", or that an Ordewell or remote branch is
    read-only here).
  - *A commit tab* (slate marker, the `git-commit-horizontal` icon, titled
    `Commit <short sha>`): the subject as its heading, the sha, author,
    date, message and files. Each file is named by its status and path, the
    path whole in its tooltip.
  - *A commit-diff tab* (mint marker, as a diff's, titled
    `<file name> @ <short sha>`): one file's patch in that commit.

  The Git view opens no centre tab of its own. Branches and History replace
  each other in the sidebar; only a commit, and a file in it, open tabs.
- **Actions.**
  - *A branch row* (local, Ordewell or remote): a click browses its history.
    The sidebar turns to History with that branch picked; nothing is checked
    out and no tab opens, so the centre keeps what was open. A browsed branch
    the next read no longer lists falls back to the checkout's history.
  - Create, switch and delete a branch: the + on Local, and a row's own
    Switch and Delete buttons.
  - Pop or drop a stash, each asking first.
  - Fetch, Pull and Push, on the checkout.
  - *Git: Show history* (`git.showGraph`, kept under its old id so a binding
    to it still works) shows the Git sidebar on History with the checkout's
    own history, whatever was browsed before.
  - *A folder* turns over by a click anywhere on its row, chevron and name
    alike, by Enter or Space, and by Right to open and Left to close. Until the
    person chooses, a folder is open when its group is short enough to start
    open, or when it holds the checked-out branch. The choice is kept per
    repository, group and folder, and outlives an activity switch.
  - *A History row:* a click opens the commit as a preview tab, so stepping
    through the history leaves one tab behind; a double click keeps it. The
    last commit opened is marked (`aria-current`) and is kept per repository
    and branch. ↑ and ↓ step between rows, Home and End go to the first and
    the last.
  - *A file in a commit tab* opens its patch as a preview commit-diff tab,
    and keeps the commit tab, so the commit stays open beside its file.
  - *Load more* reads the next 50 commits. It waits while the history is
    read again, and after that read failed, since the page it would ask for
    follows rows about to be replaced.
  - *Refresh* (⟳) reads the branches again, and the history with them.

  Switching away from, or deleting, a locked branch is refused with the run
  named (W12). An Ordewell branch can be viewed and diffed, but never switched
  to or deleted here.
- **Loading.**
  - *History* is read only once it is first shown, 50 commits at a time. It
    is read again only when a branch tip moves (a fetch, a switch, a commit),
    or a detached checkout's head does, or on Refresh. A read again keeps the
    rows on screen and as many commits as were shown, up to the daemon's
    ceiling of 500, so the person's place stands. Each repository keeps its own history and its own pick, and an
    answer for a read that a later one overtook, or for a repository no longer
    shown, is dropped. A browsed branch keeps its own history beside the
    checkout's.
  - A fetch that brings only tags moves no branch tip, so History keeps its
    chips until Refresh.
- **Empty.** A repository with no commits says so in History.
- **Error.** A `git_failed` action shows git's text in place. A history that
  cannot be read says so, with Try again; a Load more that fails says so under
  the rows and keeps them.

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

- **Shows.**
  - *Every branch action's confirm* names the repository, the branch and the
    worktree it touches.
  - *A delete* names the unmerged commits (G3's `unmerged`).
  - *A refusal* names the session, the run and why (`landing_branch_held`,
    G7).
  - *A switch with uncommitted changes* says git will carry or refuse them, as
    git decides.
  - *A switch away from a settled run's unmerged landing branch* is allowed,
    with a warning that Merge all will refuse until the branch is back.

  A destructive confirm's button is `--ow-status-failed` filled, with focus
  starting on Cancel.
- **Actions.** Confirm sends the echoed `confirm`. *Open run* switches to the
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

- **Shows.** Per repository (`GET isolation/merge-preflight`, G8):
  - the branch it lands on, and how much landed;
  - the overlapping uncommitted files;
  - whether other uncommitted files exist.

  A repository off its base branch shows ADR-0042's `wrong-branch` here,
  before anything merges.
- **Actions.**
  - *Commit them* opens the Changes sidebar with the overlapping files staged,
    then returns here.
  - *Stash them* stashes only those paths, then merges and offers *Restore my
    changes*.
  - *Cancel*.

  With no overlap, the dialog is the plain Merge all confirm.
- **Loading.** "Checking web, api …" per repository.
- **Empty.** Nothing landed: Merge all is not offered.
- **Error.** Merge all's own answer (`blocked`, `conflict`, `failed`) shows per
  repository. ADR-0013's abort leaves the tree as it was.

### W14. A failed task

```
│ ✕ #2 Add SAML callback route │
│   [Codex] gpt-5 · medium      │
│   Failed · tests failed       │
│   attempt 2 of 2  [Retry]  ⋯  │
│ ⊘ #3 Add login button         │
│   Blocked · waits on #2       │
│ ⊘ #4 Run the e2e suite        │
│   Blocked · waits on #2       │
```

- **Shows.**
  - *The failure's reason,* in plain words on the row, the card and the tab
    header. Its evidence is one click away (the verdict, in Details).
  - *The dependents it blocks* (ADR-0034), each drawn Blocked, naming the
    failed task.
  - *The failed escalation,* in Needs you.
- **Actions.**
  - Retry, with an edited prompt or assignment first if wanted.
  - Skip.
  - Mark complete, which asks first, since it overrides the verdict.
  - Message the planner about it, which focuses the planner tab's composer
    with "#2" quoted.
- **Loading.** —
- **Empty.** —
- **Error.** A retry refused (because the run is stopping) says so on the row.

### W15. Daemon disconnected (Reconnecting)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⟳ Reconnecting to the daemon on :3742 …  (attempt 3)       [Retry now] [Details]     │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Planner │ …   ← last known state, dimmed; every action disabled   │ PLAN             │
│                                                                    │ ◐ #3 Add login … │
│                                                                    │   last seen 0:42 │
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

- **Shows.**
  - *A bar* across the window, under the title bar, while main probes.
  - *The last known state,* dimmed, with each running task's "last seen" age.
    It is never shown as passed or stopped.
  - *When the daemon is back,* the bar says *Reconnected* briefly and the view
    redraws from a fresh `run_snapshot`.
  - *The mismatch card* (H3) names both versions and contracts.

  The title bar keeps its place: its primary is disabled, not hidden.
- **Actions.**
  - Retry now.
  - *Start a daemon*, when the port is free and the app did not own the old
    one.
  - *Restart daemon*, on a mismatch when no run is live there.
- **Loading.** The bar is itself the loading state.
- **Empty.** Not applicable.
- **Error.** A port held by something else, or a token the app cannot read,
  shows as a card with the fix (`ORDEWELL_PORT`).

### W16. A session another host holds

What happens depends on the session lease's host kind (ADR-0049,
`LeaseHostKind` in `packages/core/src/services/sessionLease.ts`):

- **Another Ordewell daemon** (`kind: 'daemon'`): for example the private
  daemon a TUI runs, or a CLI daemon on another port. The app *joins* it.
- **A VS Code window** (`kind: 'vscode'`): the session runs inside the
  extension host, so there is no daemon to join. The app offers to start a new
  session here, or to watch the session read-only.

The connection itself, the token and the route table are ADR-0063 H8's. This
section specifies only what the person sees.

```
Joined — the session is driven live through the holder's daemon
┌ ● ● ●  acme-app › web › main ▾   ◫ Your checkout ▾                ◆ 1 Needs you   [■ Stop]  ⋯ ┐
│ ... │ Planner │                                                    │ PLAN  ◐ 1/4    ⑃ ⇥   │
│     │ ┌───────────────────────────────────────────────────────────┐│ ...                  │
│     │ │ Add SSO login           ◐ Running   ⇄ Joined · TUI pid 48120 ││                      │
│     │ │ [Claude Code] sonnet ▾  low ▾  ctx 31%                    ⋯ ││                      │
│     │ ├───────────────────────────────────────────────────────────┤│                      │
├─────┴─┴───────────────────────────────────────────────────────────┴┴──────────────────────┤
│ ● daemon :3742 (owned) · joined :49213   held by TUI (pid 48120) · joined   Claude Code ✓  │
└───────────────────────────────────────────────────────────────────────────────────────────┘

The holder has gone
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ ⓘ The TUI that held this session has exited. Nothing is running it now.  [Continue here]  │
└───────────────────────────────────────────────────────────────────────────────────────────┘

A VS Code holder
│ ┌───────────────────────────────────────────────────────────────────────┐ │
│ │ ⊡ This session is open in a VS Code window                             │ │
│ │   (extension host pid 51234, since 10:02).                            │ │
│ │   VS Code runs it inside its own window, so the app can't join it.    │ │
│ │                                                                       │ │
│ │          [Start a new session here]    [Watch read-only]              │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
```

- **Shows.**
  - **Joined.** The session is drawn and driven as if it were the app's own:
    the planner tab, the plan panel, task tabs, Needs you and the primary
    action all work, through the holder's daemon, while the TUI (or other
    client) shows the same session. The holder is named in four places:
    - *The session header* shows a chip, "⇄ Joined · TUI pid 48120". It names
      the holder by what the lease records: *TUI* when the daemon has an
      `ownerPid` (a TUI's private daemon), otherwise "daemon :49213". Its
      tooltip gives the holder's port, its version and the time it took the
      lease.
    - *The status bar's daemon item* reads "daemon :3742 (owned) · joined
      :49213". Its detail lists both daemons, with their versions.
    - *The status bar's lease item* reads "held by TUI (pid 48120) · joined".
    - *The session's row* in the Sessions sidebar carries the same ⇄ glyph.

    Files, diffs, branches and the terminal still come from the app's own
    daemon and Electron main, since reads need no lease (ADR-0064 R4).
  - **Watch read-only** (a VS Code holder, or a join that was refused).
    - The saved state, from `GET /api/sessions/:id`, with a ⊡ *Read-only ·
      held by VS Code (pid 51234)* chip in the session header and "· read-only"
      in the status bar's lease item.
    - Every write is disabled, with the holder named in its tooltip. The
      primary action is disabled, not hidden.
    - A *Refresh* button sits in the chip's menu.
  - **Holder gone.** When the holder exits, closes the session, or its daemon
    stops answering for good, a banner over the planner tab says so, naming
    the holder. It offers *Continue here*.
- **Actions.**
  - *Opening a session another daemon holds* joins it, without asking: joining
    takes nothing away from the other client. The first time in a window, a
    one-line notice under the session header explains the chip.
  - *Continue here* adopts the session into the app's own daemon
    (`POST /api/sessions/:id/load`). If a run was live when the holder went,
    [W17](#w17-a-restored-session) follows: what was running is drawn as
    interrupted, not verified.
  - *Start a new session here* opens a new session in this workspace, with the
    held session's goal offered as the first message, not sent.
  - *Watch read-only* shows the saved state as above.
  - *Take over…* stays in `⋯`. It asks first, naming the holder, and follows
    ADR-0049's takeover rules.
    - A refusal always says why, naming the live holder: "The TUI (pid 48120)
      is still running and holds this session. Quit it, or close the session
      there, then choose Continue here."
    - A holder whose pid is gone, or whose heartbeat is stale with no runner
      groups running, is taken over without a refusal.
- **Loading.** "Joining the TUI's daemon on :49213 …" in the session header's
  chip, over the skeleton of W4. A join that takes a while keeps the saved
  state on screen, dimmed.
- **Empty.** Not applicable.
- **Error.** Each refusal names its cause and offers *Watch read-only*:
  - *The holder's daemon is another version:* "The TUI's daemon is 0.12.3
    (contract 4); this app speaks contract 5, so it can't join." This is the
    same comparison as H3.
  - *Its token cannot be read:* "Can't read the token of the daemon on :49213."
  - *A lease with no host kind* (written by an older Ordewell): "Held by an
    older Ordewell process (pid 50122) that doesn't say how to reach it." Take
    over follows ADR-0049 as usual.
  - *The holder's daemon drops while its pid lives:* the
    [Reconnecting](#w15-daemon-disconnected-reconnecting) bar names the
    holder's port, not :3742. *Continue here* is offered only once the holder
    is gone.

### W17. A restored session

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⟲ Restored from disk — the run was not running when this daemon opened it.          │
│ #3 was running when it stopped; it has not been verified.      [Resume run] [Dismiss]│
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Planner │                                            │ PLAN                           │
│                                                      │ ✓ #1 Read the auth module      │
│                                                      │   Passed · verified            │
│                                                      │ ○ #3 Add login button          │
│                                                      │   Not started · interrupted,   │
│                                                      │   not verified                 │
│                                                      │ ○ #4 Run the e2e suite         │
```

- **Shows.**
  - *A session adopted from disk* (`POST /api/sessions/:id/load`) whose run was
    not live.
  - *Tasks that passed* say *verified*, with their evidence.
  - *A task that was running* says it was interrupted and is not verified. It
    is never drawn as passed.

  The banner sits at the top of the planner tab.
- **Actions.** Resume the run (`POST execute`). Retry a task. Dismiss the
  banner.
- **Loading.** "Opening session …" until the adoption answers.
- **Empty.** Not applicable.
- **Error.** A session file that cannot be read says so, and offers to remove
  it from the list only.

### The Sessions sidebar

```
│ ☰ SESSIONS          + │
│ NEEDS YOU (2)       ▾ │
│ ◆ #2 Add SAML …  [Allow] │
│ ◆ #4 checkpoint   [Open] │
│ ─────────────────────── │
│ SESSIONS              │
│▌◐ Add SSO login       │
│  Running 1/4 · now    │
│ ✓ Fix flaky CI    ⇄   │
│  Settled · 2 days ago │
│ ○ Split invoices  ⊡   │
│  Draft · last week    │
```

- **Shows.**
  - *Needs you,* as W7, collapsible, with its count.
  - *This workspace's sessions,* newest first (`GET /api/sessions`), under a
    *Sessions* heading that folds on its own: folding one of the two sections
    never folds the other, and each choice outlives an activity switch. Each
    is a two-line row:
    - the goal, with an ellipsis;
    - the session's status as a shape plus a word (*Planning*, *Draft*,
      *Approved*, *Running n/m*, *Settled*, *Failed*), and its relative time;
    - a ⇄ when the session is joined, or a ⊡ when it is held read-only, with
      the holder in the tooltip.

    The open session has the selected row's accent bar.
  - *A session not open here,* or open read-only (its holder's run sends this
    window nothing), reads its run from the session list's `run` entry, not
    its saved status: *Running n/m* while its run is live in this
    daemon, and *Running* without counts while another host holds it, which
    can trail that host by a heartbeat. The list is read again every 5 s while such a row is
    live and every 15 s otherwise, never while the window is hidden or the
    daemon away. A read that fails keeps the rows, but drops the Running it can
    no longer vouch for.
- **Actions.**
  - Click a row to switch session: the planner tab, the plan panel and the
    session's tabs swap.
  - **+** starts a new session.
  - The context menu holds Close and Delete. Delete asks first, naming the
    goal.
  - Cmd/Ctrl+K finds a session by its goal.
- **Loading.** Rows as skeletons, at their final height.
- **Empty.** "No sessions yet. Describe a goal to the planner." The planner
  tab is already a new session.
- **Error.** The shared banner, over the list.

## Task row, card and header contents

The plan panel's row and the task tab's header are one component,
`TaskSummary`, in `packages/ui`, with its `row` and `header` variants. The
graph's card is the desktop's `TaskCard`, which draws the same row view in a
fixed height. The row view is decided once in core (`taskRowView`), and the
words for a runner, a model and an effort come from the shared helpers in
`@ordewell/ui/design` (`runnerName`, `modelLabel`, `modelShortLabel`,
`effortLabel`), so the List, the graph and the tab can never disagree about a
task. The desktop adds no rule of its own.

The layout of each variant:

- **Row,** in the plan panel, about 360 px wide.
  - *Line 1:* the status shape, the order, a kind badge (Research, Ops,
    Script, Manual, Delegated), and the title with an ellipsis.
  - *Line 2:* the runner badge, model and effort, or for a script its command
    in `type.code-small`.
  - *Line 3, when it applies:* the status word with its reason, and the
    elapsed time; or a waiting approval's options.
  - A row is 44 px with two lines and 64 px with three. A subtask row is
    indented 16 px under its parent, which folds.
- **Card,** in the graph. Every card of a density has the same height
  (Comfortable 104 px, Compact 60 px), so a long title, model or badge row
  shortens inside the card and never moves its neighbours or the edges.
  - *Row 1:* the status shape, the order and the title. The title runs to two
    lines in Comfortable and one in Compact, ending in an ellipsis, with the
    whole title in its tooltip.
  - *Row 2:* who does the task. For an AI task, the runner badge (its colour
    beside its name), then the model and the thinking effort, each behind its
    own icon, so no separator character is needed. A script task shows a
    *Script* badge and its first command in `type.code-small`; a manual task a
    *You* badge; a delegated task a *Child plan* badge and its counts.
    - When the row runs short it shortens one part at a time, and only at a
      word: first the effort ("extra high" → "xhigh"), then the model (its
      provider prefix, then its trailing words, ending in "…"), and the runner's
      name ("Claude Code" → "Claude"). A row still too long keeps the
      effort's icon alone, shorter than any word. Each part keeps its whole name in
      its tooltip. The row is measured, not guessed, since a model id has no
      width a rule could know.
  - *Row 3, Comfortable only:* the badges (Read-only, Research, Ops, the loop's
    round, HITL, Delegated, and any attention flag), then the status word with
    the verdict's reason in its tooltip, then the elapsed time. The status word
    shortens first. Compact puts all of row 3 in the card's accessible
    description.
  - Every icon on a card is drawn at one size from the spacing scale, inside a
    box that keeps text clear of it. *Open chat* is a 28 px button at the end
    of the last row, which leaves room for it so it covers no text.
- **Header,** in the task tab. Two lines: the row's first line with the status
  word, and the second line with everything else, plus the actions.

| Content | Row (plan panel) | Card (graph) | Header (task tab) |
|---|---|---|---|
| Status: shape, colour and word ([vocabulary](#status-vocabulary)) | shape; word on line 3 | shape; word on row 3 (Compact: in the accessible name) | ✓ |
| Order label and title (`#2`, `#2.1`) | ✓ | ✓ | ✓ |
| Runner badge, model, effort | ✓ | ✓ row 2, shortening effort, then model, then runner | ✓ |
| Mode (Build / Read-only) | tooltip | tooltip | ✓ |
| Badges: Research, Ops, Script, Manual, Delegated (child plan) | ✓ | ✓ | ✓ |
| Approval waiting, with Allow / Deny | ✓ line 3 | badge; opens Chat at it | ✓ in Chat |
| Checkpoint waiting, with its question | badge, question in tooltip | badge | ✓ in Chat |
| Conflict and *Resolve* (resolve-conflict), Repair rounds | badge | badge | ✓ |
| Merge gate ("not merged into your branch yet") with *Merge all* | badge | badge | ✓ |
| Usage limit with *Resume now* / *Cancel resume* | badge, actions in `⋯` | badge | ✓ |
| Loop rounds `n/max` on a check | ✓ | ✓ | ✓ |
| Dependencies in (⇠) and out (⇢), each a link | in (⇠) on line 2 when waiting | edges | ✓ |
| Isolation: branch, worktree, repositories, files changed | tooltip | peek | ✓ |
| Elapsed time, quiet-for time | ✓ | ✓ | ✓ |
| *Open chat*, output peek | *Open chat* button, tail in the open card | *Open chat* button, Space | Chat |
| Edit of prompt, dependencies and assignment | — (task tab) | — (task tab) | ✓ |
| Run, retry, revert (with preview), skip, remove, force start, mark complete / not done, stop, interrupt | first action on hover, the rest in `⋯` | context menu | first action, the rest in `⋯` |
| Subtasks and child plans | indented, folding | folded into the parent, expanding below | links |

## Status vocabulary

Every status is a shape, a colour and a word, so none depends on colour alone.
The mapping from core's `TaskStatusKind` is fixed here and lives in
`packages/ui`. A shape drawn without its word (the rail, the stage strip, a
Compact card) carries the word in its accessible name and its tooltip.

| Word | Shape | Colour token | From core |
|---|---|---|---|
| Not started | ○ hollow circle | `--ow-status-idle` | `todo` |
| Running | ◐ half-filled circle, turning | `--ow-status-running` | `running`; `quiet` adds "quiet for 4m" (core's *Stalled*) |
| Needs you | ◆ the *Needs you* glyph | `--ow-status-attention` | `awaiting`, or any task with an escalation |
| Passed | ✓ filled circle with check | `--ow-status-passed` | `done` with its verdict |
| Failed | ✕ filled circle with cross | `--ow-status-failed` | `failed` |
| Blocked | ⊘ circle with bar | `--ow-status-blocked` | `blocked` |
| Skipped | ◌ dashed circle | `--ow-status-idle` | `skipped` |
| Waiting for merge | ⧉ merge mark | `--ow-status-merge` | `done` with a landing not yet merged, or at a merge gate |

Three qualifiers keep "done" honest:

- **Verified** is said only of a task whose verdict came from evidence: a
  `task_complete` bound to the attempt, or a script's exit status. *Mark
  complete* shows "Marked complete by you", not "verified".
- **Reconnected** redraws from a fresh snapshot. It never infers progress made
  while disconnected, and an idle runner is never shown as complete.
- **Restored** marks a session adopted from disk. A task that was running is
  drawn as *Not started*, with "interrupted, not verified", until it runs
  again.

## Visual language

Calm, and premium. Lucide icons at 1.5 px, Inter and JetBrains Mono, neutral
greys for structure, and generous but regular spacing.

The first build used one accent colour for everything. That made every area
look alike, and people lost their place. This version gives each kind of
colour a single job, so a colour always answers one question:

| Family | Answers | Where it may appear | Where it never appears |
|---|---|---|---|
| **Brand teal** (`--ow-accent`, `--ow-area-planner`) | "Where is focus? What is the planner?" | focus ring, links, selection bar, primary button fill, the planner's area hue | status shapes |
| **Area hues** (`--ow-area-*`) | "Which part of the app am I in?" | the activity bar's active icon and indicator, the sidebar header's icon, a tab's icon and active marker | rows, cards, badges, statuses, text |
| **Runner colours** (`--ow-runner-*`) | "Which runner is this?" | the runner badge only, always with the runner's name in it | anything that is not a runner badge |
| **Status colours** (`--ow-status-*`) | "What state is this in?" | status shapes and words, Needs you, attention badges, banners | areas, runners |
| **Diff colours** (`--ow-diff-*`) | "Added or removed?" | diff editors | anywhere else |

The rules:

1. An area hue is quiet. It colours a 22 px icon and a 2 px marker, never a
   fill bigger than an icon, and never text.
2. Area hues and runner colours sit in the part of the colour wheel farthest
   from the status colours they appear near. Runners sit on rows next to
   status shapes, so the first three take clay, ice and lime, which no status
   uses, and the five added later (orchid, mint, rose, sky and sand) are each
   kept a measured distance from every status and from one another, which the
   token test checks. Areas
   only appear in the frame, where no status sits beside them.
3. A runner badge is the runner's colour as text on a tint of that colour (14 %
   on dark, 10 % on light), with the runner's name: *Claude Code*, *Codex*,
   *OpenCode*, *GitHub Copilot CLI*, *Qwen Code*, *Cline*, *Gemini CLI* and
   *Cursor*. In a narrow row the name may shorten to *Claude*, but it is
   never dropped.
4. Settings is neutral: it has no area hue, and its marker is `--ow-fg`.
5. Status colours keep their meaning everywhere. Amber means Needs you, red
   means failed, and no decoration borrows them.
6. Dark is the default theme. Light is its equal, with every pair below
   checked in both.
7. A runner's state is a word and a shape, never a new colour. *Signed out* is
   an attention badge and *Unavailable* or *too old* a failed one, each with the
   reason beside it: one line that ends in an ellipsis with the whole reason in
   its tooltip, or two lines on a Welcome card, where the reason is the thing
   to act on. The action (*Log in*, *Set API key…*) sits at the card's end, in
   the same place on Welcome cards, Settings rows and graph cards, and an
   unavailable runner has none. The key dialog is an overlay: it takes the
   overlay surface and raised elevation, and names the vendor in its title.
   A runner whose models could not be listed shows the error in the allowlist
   as an alert icon and text on the panel, not as an empty list. The tour
   (`packages/desktop/e2e/tour.spec.ts`) shows each of these in light and dark.

## Design tokens

Semantic names only: a component never names a hex value. Tokens are CSS
custom properties with the `--ow-` prefix:

- colours in `packages/ui/src/tokens.css`;
- scales in `packages/ui/src/scale.css`;
- the desktop's values in `packages/desktop/src/renderer/theme.css`;
- VS Code's mapping in `vscode-tokens.css`, which must give every token a
  value, so the area and runner tokens need a VS Code mapping too. Areas map
  onto VS Code's own `activityBar` and `charts` colours; runners keep this
  table's values.

The app starts dark. The user's theme preference (Dark, Light or System) sets
`nativeTheme.themeSource`, and the page's `prefers-color-scheme` follows it,
so a change repaints every surface without a reload. Only System follows the
OS.

### Colour roles

Every text colour reaches WCAG AA, 4.5:1, on every background of its theme
that it is drawn on. Every graphic that carries meaning (an icon, a status
shape, a control's border, the focus ring) reaches 3:1. Dividers are
decorative and exempt. The design-system slice checks every pair in a test.
The ratios given are the lowest against that theme's backgrounds, counting
the hover and selected grounds a row can sit on.

**Backgrounds and borders**

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ow-bg-chrome` (new) | `#141619` | `#F1F2F4` | title bar, activity bar, status bar |
| `--ow-bg-sidebar` (surface) | `#181A1E` | `#F9FAFB` | sidebar, plan panel, panel headers |
| `--ow-bg` (canvas) | `#1C1F23` | `#FFFFFF` | centre tabs, editors, chat |
| `--ow-bg-widget` (raised) | `#23262B` | `#FFFFFF` | widgets, the graph's cards |
| `--ow-bg-overlay` (overlay) | `#2A2E35` | `#FFFFFF` | popovers, menus, dialogs |
| `--ow-bg-input`, `--ow-bg-code` (inset) | `#121417` | `#F1F2F4` | inputs, composers, code, peeks |
| `--ow-bg-hover` | `#272B31` | `#EBEDF0` | hovered row or button, skeleton bars |
| `--ow-bg-selected` | `#1A3640` | `#E1F1F5` | selected row, the active tab's ground |
| `--ow-border` (subtle) | `#2A2E34` | `#E3E5E9` | dividers, sashes (decorative) |
| `--ow-border-widget` (strong) | `#3A3F47` | `#C9CDD3` | cards, popovers, raised surfaces on dark |
| `--ow-border-control` (new) | `#767D88` (3.07) | `#7D848E` (3.22) | input, checkbox and secondary button borders |

**Text, accent and focus**

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ow-fg` | `#E6E8EB` | `#1A1C1F` | body, titles |
| `--ow-fg-secondary` | `#A3A9B3` (5.40) | `#525963` | metadata, inactive icons |
| `--ow-fg-muted` (new; `--ow-fg-placeholder` aliases it) | `#969DA7` (4.67) | `#646B75` (4.59) | placeholders, disabled, hints |
| `--ow-fg-link` | `#4FC0DC` | `#0B6F89` | links |
| `--ow-accent` | `#3BB3D1` | `#1393B3` (3.06 as a graphic) | selection bar, active strokes |
| `--ow-accent-emphasis` | `#5CC4DE` | `#0E7C99` | primary button fill (light), its hover (dark) |
| `--ow-accent-tint` | `#1A3640` | `#E1F1F5` | the selected pill |
| `--ow-accent-on` | `#0E1A1F` (7.21 on `#3BB3D1`) | `#FFFFFF` (4.81 on `#0E7C99`) | text on a primary button |
| `--ow-focus-ring` | `#4FC0DC` | `#1393B3` | 2 px ring, 2 px offset |

The primary button is `--ow-accent` filled on dark and `--ow-accent-emphasis`
filled on light, so its label reaches 4.5:1 in both.

**Status**

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ow-status-idle` | `#969DA7` | `#646B75` | not started, skipped |
| `--ow-status-running` | `#6AA6FF` | `#1F62D6` | running |
| `--ow-status-attention` | `#E8AE55` | `#995C00` | needs you; `--ow-status-warning` and `-warning-text` alias it |
| `--ow-status-passed` | `#55C784` | `#18793F` | passed |
| `--ow-status-failed` | `#F27C76` | `#BA322D` | failed; `--ow-status-error` aliases it |
| `--ow-status-blocked` | `#E09358` | `#8E4716` | blocked |
| `--ow-status-merge` | `#A898F3` | `#5F47C2` | waiting for merge |

Every status colour is also a text colour (the status word), so each one
reaches 4.5:1 on every background of its theme, hover and selected included.

**Areas** (new)

| Token | Dark | Light | Area |
|---|---|---|---|
| `--ow-area-planner` | `#4FC0DC` teal | `#0B6F89` | the planner tab, task tabs, the plan graph tab, the Plan panel's glyph |
| `--ow-area-sessions` | `#EE93B0` rose | `#A8325C` | Sessions |
| `--ow-area-explorer` | `#9DA8FA` indigo | `#4650BF` | Explorer, file tabs |
| `--ow-area-changes` | `#5ECDB0` mint | `#0D7258` | Changes, diff tabs |
| `--ow-area-git` | `#9DB3CF` slate | `#4F6683` | Git, and commit tabs |

Each area hue reaches 4.5:1 on chrome and surface in its theme, beyond the 3:1
an icon needs, so it can stay legible if a later design uses it for a
heading.

**Runners** (new)

| Token | Dark | Light |
|---|---|---|
| `--ow-runner-claude-code` | `#E3967A` clay | `#A24A2A` |
| `--ow-runner-claude-code-tint` | `#38302F` | `#F6EDEA` |
| `--ow-runner-codex` | `#AEBCD0` ice | `#4A5A70` |
| `--ow-runner-codex-tint` | `#30353B` | `#EDEFF1` |
| `--ow-runner-opencode` | `#BCD05E` lime | `#56670F` |
| `--ow-runner-opencode-tint` | `#32382B` | `#EEF0E7` |
| `--ow-runner-copilot-cli` | `#D68BE3` orchid | `#8F2FA6` |
| `--ow-runner-copilot-cli-tint` | `#362E3E` | `#F4EAF6` |
| `--ow-runner-qwen-code` | `#6FD6C4` mint | `#096D5D` |
| `--ow-runner-qwen-code-tint` | `#28393A` | `#E6F0EF` |
| `--ow-runner-cline` | `#F08AB8` rose | `#B0276A` |
| `--ow-runner-cline-tint` | `#3A2E38` | `#F7E9F0` |
| `--ow-runner-gemini-cli` | `#6FD0E6` sky | `#0B6A85` |
| `--ow-runner-gemini-cli-tint` | `#28383E` | `#E7F0F3` |
| `--ow-runner-cursor-agent` | `#D4C3A0` sand | `#6B5A35` |
| `--ow-runner-cursor-agent-tint` | `#363635` | `#F0EFEB` |

The five added later keep clear of the status colours and of each other (the
test measures the distance in OKLab and fails under 5). A badge is a name on a
tint, so none of them is read as a status shape. Their text against their tint, dark then light:
Copilot 5.36 and 5.74, Qwen Code 6.96 and 5.38, Cline 5.55 and 5.34, Gemini
6.86 and 5.32, Cursor 6.98 and 5.81. The mark (the colour as a graphic) reaches
3:1 on every surface it sits on.

Badge text against its tint, at its lowest of the first three (drawn on raised
on dark, on surface on light): 4.99 on dark and 4.85 on light. A runner Ordewell does not
know draws a neutral badge (`--ow-fg-secondary` on `--ow-bg-hover`) with its
name.

**Diffs** (unchanged)

| Token | Dark | Light |
|---|---|---|
| `--ow-diff-inserted` | `#16301F` | `#E6F4EA` |
| `--ow-diff-removed` | `#3A1B1A` | `#FBE9E8` |
| `--ow-diff-inserted-word` | `#1F5A33` | `#B7E1C1` |
| `--ow-diff-removed-word` | `#6B2522` | `#F4C2BF` |

`chrome.ts`'s `canvasColour` and title-bar overlay colours follow the new
chrome and canvas values.

### Surfaces

A discrete object is drawn as a card: a task card, the planner chat's cards
(plan approval, an approval, the isolation notice and handoff, a subagent),
the add-task form. In the desktop app also the Welcome project and runner
cards and banners, the graph cards, the Needs you items, the Settings groups,
a Changes task's summary, a Merge all repository, the sidebars' notices and the
session banners. A card is seen by its fill, not only by its hairline, so
the fill lifts off whatever is drawn behind it. The ladder is in
`tokens.css`, as `--ow-surface-*`:

| Role | Dark | Light | Use |
|---|---|---|---|
| `canvas` | `--ow-bg` `#1C1F23` | `--ow-bg` `#FFFFFF` | the centre: tabs, editors, the planner chat |
| `panel` | `--ow-bg-sidebar` `#181A1E` | `--ow-bg-sidebar` `#F9FAFB` | sidebars and the plan panel |
| `card` | `#23272D` | `#F2F4F6` | a card at rest |
| `card-hover` | `#292E35` | `#ECEFF2` | a hovered card, one step deeper |
| `card-selected` | `#1D2E35` | `#E6F2F6` | the selected or open card: a faint teal tint |
| `card-border` | `#2F343C` | `#DFE3E8` | the card's hairline, a step past its fill |
| `card-selected-border` | `#346D7F` | `#8DC3D3` | the selected card's accent-tinted edge |
| `card-shadow` | `rgb(0 0 0 / 0.3)` | `rgb(16 24 40 / 0.06)` | the card's two shadow layers |
| `card-highlight` | `rgb(255 255 255 / 0.04)` | transparent | a dark card's top edge |
| `inset` | `#15181C` | `#FFFFFF` | output, a read-only prompt, a script body, a subtask, inside a card |
| `overlay` | `--ow-bg-overlay` `#2A2E35` | `--ow-bg-overlay` `#FFFFFF` | menus, popovers, dialogs: the top of the ladder |

Every step lifts off what it sits on by at least 1.05:1, in both themes:

| Pair | Dark | Light |
|---|---|---|
| card on canvas | 1.10 | 1.10 |
| card on panel | 1.16 | 1.06 |
| hover on card | 1.10 | 1.05 |
| selected on canvas | 1.18 | 1.14 |
| selected on panel | 1.24 | 1.09 |
| inset in a card | 1.19 | 1.10 |
| inset in a selected card | 1.27 | 1.14 |
| overlay over a card | 1.10 | 1.10 |

- **One rule for light: the card is tinted, its ground is not.** A light card
  is a cool neutral a step below white, so it reads on the white canvas and on
  the near-white panel alike, and an inset inside it goes back to white with a
  hairline. Regions are never tinted to carry white cards.
- **Dark cards are one step lighter** than what they sit on, in the same cool
  hue, never a flat grey, with the faint highlight on their top edge.
- **An inset steps back** from its card: white on light, a step below the
  panel on dark.
- **Cards against rows.** A card has a fill, a hairline and
  `--ow-elevation-card`. A list row (a Sessions row, a file, a collapsed plan
  row) stays flat and shows only hover and selection. A plan row that opens
  becomes the selected card. In the desktop app a commit, a branch, a
  worktree, a session and a Changes file are rows; a Changes task group is a
  card for its summary with its files as flat rows under it.
- **Fields in a card step back.** Light's input and code fills are the card's
  own step, so a field, a select, a pill or a code line inside a card takes
  `inset` instead (Settings, the Welcome cards).
- **A runner's model allowlist is a collapsed picker.** Settings shows one line,
  "All models" or "3 of 14 models: Opus, Sonnet, +1", and an Edit button that
  opens a card in place: a search field (label or id), a count with Allow all
  models, and a listbox of every model the runner lists, each row a checkbox,
  its label and its id in the code font, ending in an ellipsis when long. A
  model that is allowed but no longer listed shows first, marked "Not listed by
  this runner", so it can be unticked. An empty selection means all models, and
  the hint says so. Ticking writes after a pause, or when the picker closes;
  Allow all models writes at once. A refused write shows its error and the
  picker falls back to the host's allowlist. The list takes one tab stop, with
  Up, Down, Home and End moving through it, Space or Enter ticking, Up from the
  first row back to the search field, and Esc closing and returning focus to
  Edit. The ticking order is the allowlist's order, which is its priority
  ([ADR-0003](../adr/routing/0003-per-runner-model-allowlist.md)). A runner turned off keeps its
  picker visible and disabled. The list is the unfiltered catalog
  (`modelsByRunner`), never the allowlist's view of it.
- **Graph stages are lanes.** A column is `panel` with no hairline and no
  shadow, under the edges: the ground the cards lift off, not a card itself.
- **Overlays are the top step.** Title-bar menus and popovers, the command
  palette, the graph's menu and peek, confirms and dialogs, and toasts fill
  with `overlay` and cast `--ow-elevation-raised`.
- **Muted text on a card.** The shared stylesheet's muted text is secondary at
  partial alpha, which a tint pulls under 4.5:1. On a card it takes the
  stylesheet's hint mix instead, which reads on every step.
- **What does not change.** Status, runner and area colours keep their values
  on cards. No step adds a gradient.

`packages/desktop/src/renderer/__tests__/contrast.test.ts` checks every pair
above and the text on every card step. The tour's check `i`
(`e2e/surfaces.ts`) measures the cards as the app paints them: each fill
composited over its nearest opaque ancestor, at 1.05:1, and the text on it at
4.5:1. Text on a fill of its own inside the card, such as a status chip, is
not on the ladder, so the check leaves it out. A surface that starts drawing
a card adds its selector to `CARD_SELECTORS` there.

**In VS Code** no theme has a card colour, so `vscode-tokens.css` mixes the
ladder from the theme's own variables, never a hex value:

| Role | Every theme | Dark themes |
|---|---|---|
| `canvas` | `editor-background` | |
| `panel` | `sideBar-background` | |
| `card` | 6% `foreground` in `sideBar-background` | 8% |
| `card-hover` | 10% `foreground` in `sideBar-background` | 12% |
| `card-selected` | 8% `focusBorder` in `sideBar-background` | |
| `card-border` | 14% `foreground` | |
| `card-selected-border` | 55% `focusBorder` | |
| `card-shadow` | 45% `widget-shadow` | |
| `card-highlight` | 5% `foreground` (transparent on light) | |
| `inset` | `editor-background` | `sideBar-background` |
| `overlay` | `quickInput-background` | |

The plan dock sits on the side bar, so the ladder mixes into it. Dark themes
take a larger share and a different inset because a dark editor can be
lighter than its side bar (Dark Modern): the planner's cards sit on the
editor, and an editor-coloured inset would match a selected card. High
contrast draws edges, not tints: every fill, the shadow and the highlight are
transparent, a card's border is `contrastBorder`, and a selected one's is
`contrastActiveBorder`. The overrides are keyed on `:root:has(> body.vscode-…)`
because the stylesheets read the tokens on `:root`, where an override on
`body` would never reach them. `bench/live/webview-screenshot.mjs --only cards`
checks the lift in Light Modern, Dark Modern, Light+, Dark+ and both high
contrast themes.

**Refinements to the palette.** The ladder came with these changes to values
that were already set:

| Value | Was | Now | Why |
|---|---|---|---|
| Light `--ow-bg-sidebar` | `#F7F8F9` | `#F9FAFB` | A light card has to lift off the panel as well as the canvas. A panel a shade nearer white allows that without darkening the card past a soft tint. |
| Dark `--ow-bg-overlay` | `#23262B` | `#2A2E35` | An overlay is the top of the ladder. At the old value a menu opened over a card was the card's own colour. |
| Light `--ow-shadow-color` | `rgb(0 0 0 / 0.12)` | `rgb(16 24 40 / 0.12)` | A cool shadow matches the cool neutrals; a pure black one read as grey dirt on them. |
| Light `--ow-shadow-color-overlay` | `rgb(0 0 0 / 0.16)` | `rgb(16 24 40 / 0.16)` | The same reason. |
| Light `--bg-card-page`, `--card-border` overrides in `theme.css` | a 7% and a 16% mix | removed | The ladder sets them. |
| A Changes comment's fill (`changes.css`) | `--ow-bg-overlay` | `--ow-surface-card` | A comment is a card on the diff. In light the overlay step is the editor's own white, so the comment did not stand off it. |
| A Changes comment's field | `--ow-bg-input` | `--ow-surface-inset` | Light's input fill is the card's own step, so the field would vanish into the card. It goes back to white, like every inset. |
| Welcome project and runner cards, banners (`welcome.css`) | `--ow-bg-widget`, `--ow-border` | `--ow-surface-card`, `card-border`, card elevation | The light widget fill is the canvas's white, so the cards were held apart only by a hairline. |
| A Welcome card's hover | `--ow-bg-hover` | `--ow-surface-card-hover` | One step deeper than the card, as every card's hover. |
| A Welcome card's code line | `--ow-bg-code` | `--ow-surface-inset` with a `card-border` ring | The code fill is the light card's own step. |
| Graph cards (`graph.css`) | `--ow-bg-widget`, `--ow-border`, `--ow-radius-md` | `--ow-surface-card`, `card-border`, `--ow-radius-lg`, card elevation | They lift off the lanes; lg is the scale's radius for a card. |
| The selected graph card | `--ow-bg-selected` | `--ow-surface-card-selected` | The ladder's selected step, which lifts off the lane in both themes. |
| Graph columns | transparent, head on `--ow-bg` | `--ow-surface-panel` lane | A stage reads as a quiet lane the cards stand on. |
| Needs you items (`needsYou.css`) | flat, a rule between them | `--ow-surface-card` cards, 8 px apart | Each escalation is a discrete object; its hairline does the separating. |
| Settings groups (`settings.css`) | `--ow-bg-widget`, `--ow-border` | `--ow-surface-card`, `card-border`, card elevation | The same reason as the Welcome cards. |
| Settings fields, pills and runner rows | `--ow-bg-input`, `--ow-bg` | `--ow-surface-inset` | A field in a card steps back. |
| A runner's open model picker (`allowlist.css`) | the old textarea's `--ow-bg-input` | `--ow-surface-card`, `card-border`, card elevation; its search field `--ow-surface-inset`; rows flat | The picker is an object opened on the runner's inset row, so it lifts off it; its rows are a list and stay flat, with a hover step and no card each. |
| Session and sidebar banners (`frame.css`, `sidebarKit.css`) | `--ow-bg-widget`, `--ow-bg-overlay` | `--ow-surface-card` | The light overlay and widget fills are white, too faint a step off the panel. |
| A Changes task summary (`changes.css`) | flat, a rule above | `--ow-surface-card` | The task is the object; its files stay rows under it. |
| A Merge all repository | `--ow-bg`, `--ow-border` | `--ow-surface-card`, `card-border` | On the confirm's white overlay a white box did not stand off. |
| A Git ref chip (`git.css`) | `--ow-bg-overlay`, `--ow-border-widget` | `--ow-surface-card`, `card-border` | A white chip on a white commit row showed only its outline. |
| Menus, palette, peek, confirms, toasts | `--ow-bg-overlay`, `--ow-bg-widget` | `--ow-surface-overlay` | One role for the top of the ladder. |

### Spacing

A 4 px scale. A token's number is its multiple of 4, so `--ow-space-3` is
12 px. The first build's 2 and 6 px steps go. A 2 px half step is kept for
the two places below, and nothing else uses a value off the scale.

| Token | px | Used for |
|---|---|---|
| `--ow-space-half` | 2 | a badge's vertical padding; the gap between a status shape and its count |
| `--ow-space-1` | 4 | the gap inside a badge or chip between its icon and its text; between a row's lines |
| `--ow-space-2` | 8 | the gap between an icon and its label in a button, row or tab; between buttons in a group; a compact card's padding |
| `--ow-space-3` | 12 | a row's and a panel header's horizontal padding; between the sidebar's sections; a dialog's button row gap |
| `--ow-space-4` | 16 | a comfortable card's padding; a subtask's indent; between Details sections; a popover's padding |
| `--ow-space-5` | 20 | between chat messages |
| `--ow-space-6` | 24 | the chat column's side padding; a dialog's padding; between Welcome cards and their heading |
| `--ow-space-8` | 32 | between Welcome sections; an empty state's padding |
| `--ow-space-12` | 48 | Welcome's top margin, above the wordmark |

Migrating from the first build's tokens: 2 becomes `space-half`, 4 becomes
`space-1`, 8 becomes `space-2`, 12 becomes `space-3`, 16 becomes `space-4`,
24 becomes `space-6` and 32 becomes `space-8`. A use of 6 px rounds to 4 or 8
by what it separates: 4 within one control, 8 between controls.

### Type

Inter for UI, and JetBrains Mono for code, paths, SHAs, ref chips and commands. A
branch's name in a row is Inter, because it fits about a tenth more at the
sidebar's narrow widths and the name leads. Both
are bundled, with no network font. The weights are 400, 500 and 600 only.
Tabular numbers (`font-variant-numeric: tabular-nums`) are used wherever a
number updates in place: elapsed times, counts and usage.

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `--ow-type-caption` | 11 / 16 | 500 | badges, the status bar, stage chips, tab counts |
| `--ow-type-overline` | 11 / 16, `letter-spacing: 0.06em`, uppercase | 600 | sidebar and section headers (SESSIONS, STAGE 2) |
| `--ow-type-small` | 12 / 18 | 400 | metadata, a row's second and third lines, tooltips |
| `--ow-type-body` | 13 / 20 | 400 | UI body, rows' first lines, inputs, menus |
| `--ow-type-label` | 13 / 20 | 500 | a button's label, a link that acts as one |
| `--ow-type-body-strong` | 13 / 20 | 600 | the name a row or card is about: a task, session, project or commit title; the checked-out branch's name (a branch row's label is `body` in Inter, and weight 600 only for the current one) |
| `--ow-type-chat` | 14 / 22 | 400 | planner and task conversations, Details' prose |
| `--ow-type-heading` | 15 / 22 | 600 | session header goal, dialog titles, a commit tab's subject; the Welcome tagline at 400 |
| `--ow-type-title` | 20 / 28 | 600 | empty states, Settings' page title |
| `--ow-type-code` | 12.5 / 19 | 400 | Monaco, the terminal, peeks, code in chat |
| `--ow-type-code-small` | 12 / 18 | 400 | paths, SHAs, ref chips, metadata and commands inside rows and cards (not a branch row's own label) |

The roles rank what a surface says, and colour follows the rank:

- **The name leads.** What a row, card, menu item or dialog is about (its
  task, session, project, branch, commit or model) is the first thing on it,
  in `body-strong` or `heading` and `--ow-fg` (a branch's name in a row is
  `body`, and `body-strong` when it is the checked-out one). Metadata under or beside it (a
  path, a sha, an author, an age, a count, a status line) is `small`,
  `caption` or `code-small` in `--ow-fg-secondary`, never the reverse.
- **Nothing reads under 11 px.** `caption` and `overline` are the floor, in
  the shared chat styles too.
- **Emphasis is earned.** A required action or a warning keeps its weight
  and its status colour (amber is Needs you's alone; red is a failure), and a
  kind badge that is not a status is neutral. A model's or runner's name is
  text, not a colour: a hue per family would read as a status.
- **Selection is teal and weight, never a status colour.** The selected row
  takes `--ow-bg-selected`; the checked-out branch its tick and weight.

### Icon sizes

| Context | Size | Stroke |
|---|---|---|
| The activity bar | 22 | 1.5 |
| Empty states | 40 | 1.5 |
| Panel and sidebar headers, the title bar, dialog titles | 16 | 1.5 |
| Buttons, tabs, menus, rows' first line, a group's or folder's chevron, a view switch's icons | 16 | 1.5 |
| A mark on a row's or card's second line, the status bar, chips (never a first-line icon) | 14 | 1.5 |
| Inside a badge, a stage chip, beside `type.caption` | 12 | 1.75 (so it doesn't thin out) |
| Status shapes | 14 in rows and cards, 16 in the tab header, 12 in chips and the rail | — |

An icon sits in a box exactly its size, `flex: none`, centred on the line's
cap height with `align-items: center`, never with a baseline nudge.

### Control heights

| Control | Height | Notes |
|---|---|---|
| Title bar | 40 | traffic lights centred |
| Status bar, Welcome footer | 24 | |
| Tab strip, sidebar header, plan panel header | 36 | the three line up into one band |
| Stage strip | 32 | |
| Activity bar item | 44 × 44 | in the 52 px bar |
| Button: small / default / large | 24 / 28 / 36 | large on Welcome and in dialogs |
| Input, select, title bar chip (scope, Needs you) | 28 | |
| Composer | 64 to 40 % of the tab | grows with its text |
| List row: one line / two / three | 28 / 44 / 64 | |
| Graph card: Comfortable / Compact | 104 / 60 | |
| Welcome card | 112 | |
| Hit target, minimum | 24 × 24 | an icon-only button is 28 × 28 |

### Settings fields

Settings is a column of section cards: Appearance, Planner, Runners, Run,
This app, then Advanced. Every field in a card takes the `inset` surface.

- **Select.** Every `<select>`, in the desktop and in `@ordewell/ui`, carries
  `ow-select` (`design.css`). The native arrow is dropped for a chevron of two
  1.5 px strokes, in `--ow-fg-secondary` at rest, `--ow-fg` on hover and focus,
  and the muted colour when disabled. It sits `--ow-space-2` from the right
  edge, and the text's right padding clears it, so a long value is cut with an
  ellipsis and never runs under the arrow. The chevron is drawn from tokens, so
  VS Code's mapping colours it too. A select keeps its own fill, border and
  focus ring (`--vscode-dropdown-*` in VS Code). The planner tab's compact
  settings take only the chevron.
- **Count.** A whole number is a text field with a numeric keypad
  (`inputMode="numeric"`), never `type=number`: it takes digits only, draws no
  spin buttons, and shows 10,000 and over with digit grouping while it is not
  focused. On Enter or blur an empty field or one below its minimum commits the
  minimum (0 for Supervisor retries, 1 for Parallel tasks, Wake-up reads and
  Subplanners' fields) and shows it. A field with a ceiling commits the ceiling
  for anything above it. WebKit spin buttons are hidden for any `type=number` left in the
  renderer.
- **Restore defaults.** At the right of the Run heading. It asks inline,
  "Restore Run settings to their defaults?" with Restore and Cancel, then writes
  every setting Run shows (autonomy, supervisor, retries, merge at gates,
  autorun, parallel tasks) in one request, so there is
  one Saving state and one refusal to report. It is disabled while all of them
  already equal their defaults. The values are core's own
  (`RUN_SETTINGS_DEFAULTS`, `DEFAULT_AUTONOMOUS_MODE`, `DEFAULT_MAX_PARALLEL`,
  read through `@ordewell/core/plan-utils`); the desktop keeps no copy. It
  never touches Subplanners, which live in Advanced.
- **Advanced.** A disclosure, collapsed by default and last in the tab, with no
  Restore defaults. Whether it is open is a desktop preference
  (`settingsAdvancedOpen`), so it comes back as it was left. It holds
  "Planned-with line in commits", "Wake-up reads" (only while the supervisor is
  on) and the Experimental group, for settings that are not ready for everyone.
  The desktop never runs the daily version check (it runs in the CLI and VS
  Code), so there is no toggle for it.
- **Subplanners.** The Experimental group's one switch, its label followed by a
  neutral `Badge` reading "Experimental" (amber is Needs you's), and a one-line
  hint. It is on while the tree budget is above 0. Turning it on asks inline, in a
  bordered `inset` box under the label: "Turn Subplanners on?", what a
  subplanner may do with no person reading its plan, and how the budget is
  counted, then Turn on and Cancel. With no budget kept, the box holds a Tree
  budget field and Turn on stays disabled until it holds a number above 0;
  Cancel saves nothing. Turning off writes only the budget's 0, so the daemon
  keeps the budget and the shape for next time. While it is on, four Count fields
  sit indented under it, each with a hint that names its value: Tree budget
  (tokens, at least 1), Maximum depth (1 to 4), Delegated tasks per plan (1 to
  30) and Tasks per child plan (1 to 100); the ceilings are core's
  `SHAPE_LIMITS`.

### Radii, elevation and motion

- **Radii.**
  - `--ow-radius-sm`, 4: inputs, buttons, badges, chips.
  - `--ow-radius-md`, 6: rows, menus' items, the selected pill.
  - `--ow-radius-lg`, 8: cards, graph cards, Welcome cards, popovers, dialogs.
  - `--ow-radius-pill`, 999: counts.
- **Elevation.**
  - *Level 0:* flat. Panels and list rows use it, with a border, not a
    shadow.
  - *Card:* `--ow-elevation-card`, for a card in flow
    ([Surfaces](#surfaces)). It has two quiet layers, a 1 px contact shadow
    and a 2 px by 6 px ambient one, both in `--ow-surface-card-shadow`. On
    dark it adds an inset 1 px top highlight.
  - *Level 1:* `--ow-elevation-raised`, for popovers, menus, tooltips and
    dialogs. It is `0 4px 16px rgb(16 24 40 / 0.12)` on light and
    `0 4px 16px rgb(0 0 0 / 0.5)` on dark, plus a 1 px `--ow-border-widget`
    on dark, where shadows barely show.
  - *Level 2* (new): `--ow-elevation-overlay`, for the sidebar and plan panel
    as overlay drawers. It is `0 8px 32px rgb(16 24 40 / 0.16)` on light and
    `0 8px 32px rgb(0 0 0 / 0.6)` on dark.
- **Motion.**
  - The durations:
    - `--ow-motion-fast`, 120 ms: hover, press, a badge change;
    - `--ow-motion-base`, 160 ms: panels, popovers, a tab switch;
    - `--ow-motion-slow` (new), 240 ms: an overlay drawer, a stage snap.
  - The easing is `cubic-bezier(0.2, 0, 0, 1)`.
  - A busy button's icon moves for as long as its action is pending. An
    icon that reads the same at any angle, such as Fetch's, turns once every
    1.2 s, linear. A directional arrow, Pull's or Push's, is never turned. It
    glides along its own direction instead, translate only so its strokes
    stay crisp, over 1.4 s on the standard easing. It eases in from behind
    its resting place, rests where the idle icon draws it, then speeds on and
    fades, clipped where it meets its line, which never moves.
  - Under `prefers-reduced-motion`, every duration is 0, the running shape
    stops turning, a busy button's icon holds still at rest, and stage snaps
    jump. The busy button still reads as working: it keeps full strength and
    the progress cursor.
  - Nothing moves to celebrate.

### Layout rules that prevent overlap

The first build drew text over icons and lost buttons off the edge of the
title bar. These rules exist so that cannot happen. The checklist checks them.

1. **Flex, not position.** Rows, headers, tabs, chips and the title bar are
   flex rows. Nothing is absolutely positioned over text. The only absolutely
   positioned elements are popovers, tooltips, overlay drawers, the drop
   outline, and the graph's edge layer, which sits *under* the cards.
2. **Icons are fixed boxes.** An icon is `flex: none` at its size, and is
   separated from its text by a `gap` (`--ow-space-2` in controls,
   `--ow-space-1` in badges), never by a margin on one side or a text indent.
3. **Labels shrink, icons and actions don't.** The text in a row, tab, chip
   or breadcrumb is the one `flex: 1 1 auto; min-width: 0` element, with
   `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`. Paths and
   branches use a middle ellipsis. Truncated text has its full value in a
   tooltip. Where a row holds a name and its metadata, the name shrinks last
   and the metadata keeps a share: a project menu item keeps at least a third
   of its row for its folder, which is what tells two same-named projects
   apart. A model line on a graph card steps through shorter forms (effort,
   then provider, then trailing words, then the runner's name) before it cuts
   a word.
4. **Actions reserve their space.** A row's hover actions take their width
   all the time (`visibility: hidden` until shown), so the title never
   reflows under the pointer.
5. **Heights are fixed.** Rows, tabs, headers and chips have the heights
   above. Their text is one line, or the variant's fixed number of lines.
   Nothing grows a row except the defined third line. Two kinds of text wrap
   instead, since cutting them would cut what the person must act on: a Needs
   you title, clamped at two lines with the rest in its tooltip, and a
   banner's or a notice's message, which wraps anywhere.
6. **Counts are tabular** and sit in a box sized for three digits, so a count
   ticking from 9 to 10 moves nothing.
7. **Scroll containers clip their own content.** A focus ring inside one is
   drawn inset (`outline-offset: -2px`), so it is never cut off.
8. **Min widths are real.** Every panel has the min width above, and its
   content is designed to fit at that width.

## Icons

Lucide (`lucide-react`) at 1.5 px stroke and the [sizes above](#icon-sizes).
Icons are coloured `--ow-fg-secondary`, `--ow-fg` on hover, the area hue when
they are an active area's or a tab's icon, and the status colour when they are
a status.

| Concept | Lucide | Concept | Lucide |
|---|---|---|---|
| Sessions | `layers` | Planner tab | `message-square-text` |
| Explorer | `files` | Changes | `file-diff` |
| Git | `git-branch` | Commit | `git-commit-horizontal` |
| Settings | `settings` | Command palette | `command` |
| Plan graph (button and tab) | `workflow` | Critical path | `route` |
| Previous / next stage | `chevron-left` / `chevron-right` | New session | `plus` |
| Open folder | `folder-open` | Drop a folder | `folder-down` |
| Forget | `x` | Docs | `external-link` |
| Joined | `link-2` | Watch read-only | `eye` |
| Sidebar | `panel-left` | Plan panel | `panel-right-close` / `panel-right-open` |
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
| Fetch | `refresh-cw` | Pull / push | `arrow-down-to-line` / `arrow-up-from-line`, drawn as `PullIcon` / `PushIcon` |
| Stash / pop | `archive` / `archive-restore` | Discard | `undo` |
| Switch branch | `arrow-right-left` | Refresh (re-read from disk) | `rotate-cw` |
| Remote branch | `cloud` | | |
| Stage / unstage a file | `plus` / `minus` | Open in editor | `external-link` |
| Folder / file | `folder` / `file` | Ignored | `eye-off` |
| Read-only, held | `lock` | Daemon | `server` |
| Disconnected | `unplug` | Restored | `history` |
| Verified | `badge-check` | Model / effort | `cpu` / `gauge` |
| Split | `columns-2` | Terminal panel | `panel-bottom` |
| Status: not started, passed, failed, blocked | `circle`, `circle-check`, `circle-x`, `ban` | Status: running | `loader-circle` |
| Status: skipped | `circle-dashed` | Status: waiting for merge | `git-merge` |

**Pull and push** are drawn by the design kit as `PullIcon` and `PushIcon`:
Lucide's `arrow-down-to-line` and `arrow-up-from-line`, stroke for stroke,
with the arrow its own group so a busy button can glide it while the line
stays still.

**Custom glyphs.** There are eight, drawn on the logo's motif: round-capped
strokes converging on a teal dot. They are drawn on a 24 px grid, with a
1.5 px round-capped stroke in `currentColor`, and the dot in
`--ow-area-planner`, or in the state's colour where the glyph marks a state.

| Glyph | Description |
|---|---|
| **Plan** | Three horizontal strokes of falling length converging from the left on a dot at the right: an ordered list arriving at one goal. The Plan panel's header and its collapsed rail. |
| **Loop** | A round-capped stroke curving back on itself around the dot, open at one end: a check repeating with its fix. Carries `n/max` beside it. |
| **Checkpoint** | A vertical stroke crossed by a short one, the dot at the crossing: a gate held for a person. |
| **Runner** | Two strokes converging on the dot from the upper and lower left, with a third leaving to the right: an agent taking a task and acting. Used where a runner, not a model, is meant, such as the Welcome runners heading. |
| **Merge all** | Three strokes from the left converging into one that continues to the dot: every repository's work landing at once. The primary action's icon at that stage. |
| **Needs you** | The dot inside an open diamond of four strokes that do not meet: something waits on a person. The title bar button's, the inbox's and the status's glyph. |
| **Child plan** | The Plan glyph small, inside a rounded bracket: a delegated task's own plan. |
| **View scope** | Two nested open corners framing the dot: which tree the view is looking at. The scope switcher's icon. |

## Keyboard and screen readers

| Keys (macOS / Windows, Linux) | Does |
|---|---|
| ⌘K / Ctrl+K | Command palette (tasks with `#`, files, branches, sessions, commands) |
| ⌘P / Ctrl+P | Quick open a file in the current scope |
| ⌘1–4 / Ctrl+1–4 | Sessions, Explorer, Changes, Git (again: hide the sidebar) |
| ⌘, / Ctrl+, | Settings |
| ⌘B / Ctrl+B | Toggle the sidebar |
| ⌘⌥B / Ctrl+Alt+B | Toggle the plan panel (rail when collapsed) |
| ⌘L / Ctrl+L | Go to the planner tab and focus its composer |
| ⌘⇧G / Ctrl+Shift+G | Open the plan graph tab |
| Ctrl+\` | Toggle the terminal panel |
| ⌘⇧A / Ctrl+Shift+A | Open Needs you |
| ⌘⇧⏎ / Ctrl+Shift+Enter | The primary action, always through its confirm |
| ⌘O / Ctrl+O | Open folder (Welcome, and the File menu) |
| G (plan panel focused) | Open the plan graph tab |
| ↑ ↓ (plan panel) | Previous, next task; → and ← expand and fold subtasks |
| ← → (graph) | To a dependency, to a dependent (a menu when there are several) |
| ↑ ↓ (graph) | Previous, next task in the stage |
| Home / End (graph) | First, last stage |
| Shift+wheel, ‹ › (graph) | One stage left or right, snapping |
| ⏎ / Space (plan panel) | Open or close the selected card |
| ⌘W / Ctrl+W, ⌃Tab / Ctrl+Tab | Close tab (never the planner tab), next tab |
| ⌘\\ / Ctrl+\\ | Split the editor |
| ⌘S / Ctrl+S | Save (checkout only) |
| ⌘⏎ / Ctrl+Enter | Send now while a turn runs: in the planner chat, the queued messages and the composer's text as one; commit in the commit box |
| Esc | Close a popover, peek, drawer or dialog; return focus where it was |
| F6 / Shift+F6 | Move focus between regions: title bar, sidebar, centre, plan panel, terminal, status bar |
| F7 / Shift+F7 (diff) | Monaco's accessible diff viewer, next and previous change |

The first build's `V` (switch List and Graph) is gone: the List is always in
the panel, and the graph is a tab.

- **Focus.** Every interactive element is reachable by Tab in visual order,
  with a visible `--ow-focus-ring`. Each region is a landmark (`banner`,
  `navigation` for the activity bar and sidebar, `main` for the centre,
  `complementary` for the plan panel, `contentinfo` for the status bar).
- **The plan panel** is a `treegrid`. Each row's accessible name is its order,
  title and status word ("#2 Add SAML callback route, needs you: approval").
- **The graph** is a `grid` of stages, whose cards are buttons with the same
  name as the row, plus a description of their edges ("stage 2; depends on
  #1; #3 and #4 depend on it"). The edges are hidden from the accessibility
  tree. The stage strip is a `tablist`-like row of buttons ("Stage 2, needs
  you, 0 of 2 done"). The plan panel is the full equivalent.
- **The activity bar** is a `tablist` with vertical orientation. Each item
  names its area and its count.
- **The tab strip** is a `tablist`. The planner tab says "pinned".
- **The Explorer** is a `tree`. Changes lists are `listbox`es whose items name
  the file and its change.
- **Announcements.** One polite live region announces a task's change of
  status, a new Needs you item, a join or a holder leaving, and a
  reconnection. Output is never announced as it streams.
- **Dialogs** trap focus and name their primary action. A destructive confirm
  starts focus on Cancel.
- **Screen readers.** When the OS reports a screen reader, Monaco runs with its
  accessibility support on, and xterm.js runs with `screenReaderMode`.

## Design review checklist

The screenshot QA (its tour harness and the visual quality check) checks each
rule against both themes and the three default window widths, plus 960 and
720 px. Each rule is pass or fail from a screenshot or the DOM, and the IDs
are permanent, so findings can cite them.

**Layout**

- **L1.** At 1280, 1512 and 1920 px, a new workspace window's sidebar, plan
  panel and centre widths are those in [the table](#defaults-and-bounds),
  within 1 px.
- **L2.** At every width down to 720 px, the centre is at least 560 px wide.
- **L3.** At 1100 px the sidebar is hidden and the activity bar shown. At
  900 px the plan panel is a 44 px rail with counts. Widening restores the
  user's sizes.
- **L4.** The planner tab is first, has no close button, and survives ⌘W.
- **L5.** A preview tab is in italics, and a second single click replaces it.
- **L6.** The tab strip, sidebar header and plan panel header share one 36 px
  band, with their bottom borders on one line.
- **L7.** The Details column is at most 800 px wide and centred, with 24 px of
  side padding. A chat with messages (the planner's, a task's) uses its tab's
  full width at every size, with side padding from the spacing scale; a code
  block or a table scrolls inside its message. The empty first screen keeps its
  centred column.

**Title bar**

- **T1.** At every width down to 720 px, Needs you and the primary action are
  fully visible and unclipped, and the primary's label is whole.
- **T2.** `⋯` is always visible. Whatever has left the bar (the scope
  switcher, breadcrumb segments) is reachable from it.
- **T3.** No title bar item overlaps the traffic lights or the window
  controls.
- **T4.** Resizing a panel's sash moves nothing in the title bar.

**Overlap and truncation**

- **O1.** No text overlaps an icon, and no element overlaps another, in any
  screenshot.
- **O2.** Every truncated text ends in an ellipsis (a middle one for paths
  and branches) and shows its full value in a tooltip.
- **O3.** Every icon is the size [its context](#icon-sizes) gives, and sits
  in a fixed box with a gap to its text.
- **O4.** A row's height is 28, 44 or 64 px. A tab is 36 px. The title bar is
  40 px and the status bar 24 px.
- **O5.** Hovering a row does not move its title.
- **O6.** A count changing from 9 to 10 moves nothing beside it.
- **O7.** A name a row, card, menu item or tab is about (a branch, commit,
  path, project, task or model) shows at least 64 px of its text, or all of
  it, and each part of it at least half that, so a long neighbour never
  squeezes it to nothing. Where it is cut, it has a tooltip, and it reads at
  4.5:1. The tour's check `k` (`labelChecks` in `e2e/surfaces.ts`) measures
  this on long branch, commit, path, project, task and model names, as the
  app paints them, in both themes and every size.

**Actions**

- **A1.** Every icon-only button has a tooltip with its name and, if it has
  one, its shortcut.
- **A2.** One filled primary button per view. A repeat of the title bar's
  action at the point of decision has the same label. No view shows two
  different filled buttons, apart from the commit box's Commit in the Changes
  sidebar and a dialog's own button.
- **A3.** Every hit target is at least 24 × 24, and icon-only buttons are
  28 × 28.
- **A4.** A destructive action asks first, names what it touches, and starts
  focus on Cancel.

**Colour**

- **C1.** An area hue appears only on the activity bar's active item, a
  sidebar header icon, and a tab's icon and active marker. It never appears on
  a row, card, badge, status or text.
- **C2.** A runner colour appears only on a runner badge, and the badge always
  contains the runner's name.
- **C3.** Every status is drawn as a shape plus a word, or as a shape whose
  accessible name and tooltip give the word.
- **C4.** The token contrast test passes: text at 4.5:1 or more, and meaningful
  graphics at 3:1 or more, in both themes.
- **C5.** No hex value appears in a component's CSS. Only `--ow-` tokens do.

**Type and spacing**

- **Y1.** Every font size and line height is a step of [the type scale](#type).
- **Y2.** Every margin, padding and gap is a step of [the spacing scale](#spacing).
- **Y3.** Code, paths, SHAs, ref chips, metadata and commands are in JetBrains
  Mono. Everything else is in Inter, a branch row's name included, in weight
  600 for the checked-out branch.

**Focus and screen readers**

- **F1.** Tab reaches every control in visual order, with a visible focus ring
  that is never clipped.
- **F2.** Esc closes the topmost popover, drawer or dialog, and focus returns
  where it was.
- **F3.** Every graph card and plan panel row has the accessible name the
  [Keyboard section](#keyboard-and-screen-readers) gives.

**States**

- **S1.** Every region shows the loading, empty and error look its wireframe
  gives. A skeleton has the final layout's heights, so nothing jumps when data
  arrives.
- **S2.** An empty state has one line and at most one action.
- **S3.** Dark and light screenshots exist for W1 to W17 and the Sessions
  sidebar, and both read as the same design.
- **S4.** Under reduced motion, nothing animates.

**Graph**

- **G1.** Dragging the graph does nothing. There is no zoom control and no
  minimap.
- **G2.** Shift and the wheel, or ‹ and ›, leave a stage's left edge aligned
  with the scroller's left edge.
- **G3.** No edge passes under or over a card. Edges run only in the gaps
  between columns and cards.
- **G4.** With a task selected, its edges are highlighted and every other edge
  is faint.
- **G5.** Every task in the plan panel is a card in the graph, and vice versa,
  apart from folded subtasks, which their parent's count includes.

## The scope model

A [view scope](../../CONTEXT.md) is per repository, chosen in the title bar's
scope switcher (ADR-0064 R2). The Explorer, file tabs, Changes and the
terminal follow it. The planner tab, task tabs, the plan panel and the graph do
not.

| Action | Your checkout | Integration branch | Task #N worktree |
|---|---|---|---|
| Browse, open, quick open | ✓ | ✓ (git objects) | ✓ (disk; the branch once pruned) |
| Edit and save | ✓ (G10) | — view-only | — view-only |
| Stage, commit, discard, stash, branch, fetch/pull/push | ✓ (G1) | — | — |
| Changes view shows | working tree vs HEAD | the run's diff vs base | the task's diff vs its base |
| Line comment on a diff | — | — (no task to send to; comment per task) | ✓ sent to #N |
| Open in editor | ✓ | — (no files on disk) | — (would race or be lost) |
| Terminal | ✓ default | — (no worktree) | ✓ only while #N is not running (G11) |
| Review & Merge all | ✓ | ✓ | ✓ |

*Review & Merge all* is the session's action, not the scope's. It is offered
from any scope while the run has unmerged landings.

A scope that no longer exists (`gone`) drops back to the checkout, with a line
saying why. The breadcrumb names the scope's branch: the checkout's own branch,
`ordewell/<run>/integration`, or the task's branch.

## IPC bridge

The preload exposes `window.ordewell`, and nothing else (ADR-0063 H4). Each
call's arguments are checked in main. Daemon calls name a route id from a fixed
table; the renderer never gives a URL, a header or a method.

| Name | Does |
|---|---|
| `app.info()` | App version, contract, platform, theme |
| `app.onThemeChange(cb)` | The effective light or dark scheme changes (a preference change, or the OS under System) |
| `app.openWorkspace()` / `app.recentWorkspaces()` / `app.forgetWorkspace(path)` | Folder picker; the recent list with each entry's last known branch, goal, status and time; forget (focuses an already-open window, H6) |
| `app.openDroppedFolder(file)` (new) | Opens a folder dropped on Welcome. The preload turns the `File` into a path with `webUtils.getPathForFile`, and main checks it is a directory before opening it, as Open folder does |
| `app.setTitleBarOverlay(colors)` | Windows and Linux overlay colours on theme change |
| `daemon.status()` / `daemon.onStatus(cb)` | Attached or owned, version, contract, connection state |
| `daemon.retry()` / `daemon.start()` / `daemon.restart()` | The actions of W15, each refused as H3 says |
| `daemon.call(routeId, params, body?)` | One request from the route table, with the bearer token added in main |
| `daemon.subscribe(sessionId, cb)` → `unsubscribe` | Frames of `/ws/session/:sessionId` |
| `daemon.join(sessionId)` / `daemon.leave(sessionId)` | Joins the daemon the session's lease names, or says why not; until `leave`, that session's live routes and socket go there (ADR-0063 H8) |
| `daemon.subscribeChild(rootId, childId, cb)` → `unsubscribe` | Frames of a child plan's socket |
| `dialog.confirm(spec)` | A native confirm for quit and other app-level asks; in-app confirms are drawn by the UI |
| `shell.openInEditor(workspace, repo, path, line?)` | Hands a checkout file to the user's editor (G10) |
| `shell.reveal(workspace, repo, path?)` | Reveal in Finder or Explorer |
| `shell.openExternal(url)` | `https:` only; the runner cards' *Docs* links |
| `terminal.open({ repo, scope, cols, rows }, onEvent)` → `{ id, shell, cwd }` | Starts a PTY ([terminal rule](#the-terminal-rule)). The window's workspace is implied, and `onEvent` receives the PTY's output and exit |
| `terminal.write(id, data)` / `terminal.resize(id, cols, rows)` / `terminal.close(id)` | PTY input and size |
| `terminal.openLink(url)` | Opens an `http:` or `https:` address the terminal printed; any other scheme is refused in main |
| `prefs.get()` / `prefs.set(key, value)` | App-local preferences: window bounds, theme, and the [layout](#persistence-and-reset-layout) per workspace |
| `update.state()` | "disabled" in a build that is not signed (macOS: and notarized); see ADR-0063 H9 |

Joining a session another daemon holds ([W16](#w16-a-session-another-host-holds))
means main reads that daemon's token and sends that session's calls and frames
to its port, after checking its pid and contract (ADR-0063 H8). The page names
only the session, through `daemon.join`. The renderer still never sees a token,
or a port it could call.

The route ids are the rows of [Daemon routes](#daemon-routes), named
`area.verb` (`sessions.list`, `plans.executeCommand`, `files.tree`,
`git.push`). Main refuses an unknown id, a path parameter that is not one
segment, and a body on a GET.

## Daemon routes

Every route takes `workspace`. **New** marks a capability the daemon does not
have today, with the ADR that governs it; the rest exist. **Changed** marks an
existing route that gains a field.

| Method | Path | Main fields | New? |
|---|---|---|---|
| GET | `/api/server` | `pid`, `port`, **`version`, `contract`** | changed — ADR-0063 H3 |
| GET | `/api/workspaces`, `/api/workspaces/isolation-preview` | repositories, the branch each lands on, or why not isolated | |
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
| GET | `/api/runners` | `id`, `name`, `enabled`, `auth?`, **`version?`** | changed — the Welcome runner cards (W1) |
| GET | `/api/models`, `/api/settings`, `/api/settings/containers` | | |
| GET, POST | `/api/approvals/:sessionId`, `/api/approvals/:sessionId/:approvalId` | pending approvals; the decision | |
| WS | `/ws/session/:sessionId`, `/ws/session/:rootId/child/:childId` | `run_snapshot`, then stamped `SessionMessage`s | |
| GET | `/api/plans/:sessionId/tasks/:taskId/diff` | `names?`, `repo?`, `path?` → `TaskDiffResult` | **new** — ADR-0064 R2, R3 |
| GET | `/api/files/tree` | `repo`, `scope`, `sessionId?`, `taskId?`, `dir` → entries with kind, ignored, git status | **new** — ADR-0064 |
| GET | `/api/files/content` | `repo`, `scope`, `path` → `text` + `hash`, or `binary` / `too-large` / `gone` | **new** — ADR-0064 R5 |
| GET | `/api/files/find` | `repo`, `scope`, `query`, `text?`, `limit?` → paths, or matching lines; capped | **new** — ADR-0064 |
| GET | `/api/git/repos` | branch, upstream, ahead/behind, detached | **new** — ADR-0064 |
| GET | `/api/git/status` | staged, unstaged, untracked, conflicted | **new** — ADR-0064 R6 |
| GET | `/api/git/diff` | `staged` / `unstaged` / `from`,`to`; `path?` | **new** — ADR-0064 R5 |
| GET | `/api/git/log` | `ref?`, `cursor?` → commits with parents and refs | **new** — ADR-0064 R5 |
| GET | `/api/git/commit` | `sha`, `path?` → message, author, files, patch | **new** — ADR-0064 |
| GET | `/api/git/branches` | local, Ordewell's, remote-tracking, stashes, landing-branch marks | **new** — ADR-0064, ADR-0062 G7 |
| PUT | `/api/files/content` | `repo`, `path`, `text`, `baseHash` | **new** — ADR-0062 G10 |
| POST | `/api/git/stage`, `/api/git/unstage` | `paths` or `hunks` | **new** — ADR-0062 |
| POST | `/api/git/commit` | `message`, `amend?`, `confirm { head }` when amending | **new** — ADR-0062 G3, G4 |
| POST | `/api/git/discard` | `paths` or `hunks`, `confirm { files }` | **new** — ADR-0062 G3 |
| POST | `/api/git/branch`, `/api/git/switch` | `name`, `from?` / `branch` | **new** — ADR-0062 G1, G7 |
| POST | `/api/git/branch-delete` | `branch`, `confirm { branch, unmerged }` | **new** — ADR-0062 G3, G7 |
| POST | `/api/git/stash`, `/api/git/stash-pop`, `/api/git/stash-drop` | `paths?`, `message?` / `stash` | **new** — ADR-0062 |
| POST | `/api/git/fetch`, `/api/git/pull`, `/api/git/push` | `confirm { remote, branch }` for pull and push | **new** — ADR-0062 G3, G5 |
| GET | `/api/plans/:sessionId/isolation/merge-preflight` | per repo: `repo`, `branch`, `overlap[]`, `otherDirty` | **new** — ADR-0062 G8 |

The "new" routes above shipped with the first build. The rows still name the
ADR that governs each one. A runner's `version` is read the way its sign-in
state is. A runner whose version cannot be read leaves it out, and its card
shows no version line.

Refusals the UI must name:

- `landing_branch_held`, with the session, the run and the branch;
- `confirm_stale`, with the difference;
- `stale`, when the file changed on disk;
- `not_checkout`;
- `ordewell_branch`;
- `pushed`;
- `git_failed`, with git's text;
- `gone`, on a read.

## The terminal rule

ADR-0062 G11. The terminal is xterm.js in the renderer, over a node-pty
process that Electron main owns. The daemon never starts a shell.

- It opens in the user's checkout of the current repository by default, with
  the user's login shell and environment.
- It opens in a task's worktree only while that task is not running. The
  option is disabled, with the reason, while it runs.
- A task that starts later in a worktree with a terminal open does not kill
  the shell. The terminal shows a banner naming the task.
- What is typed is the person's own, outside the interlock and the timeline.
  ADR-0042's `wrong-branch` and ADR-0013's dirty-overlap abort are the
  backstop at Merge all.
- Terminals close with their window. Quitting with a terminal running a
  process asks first, alongside the run question (H5).

How it is built:

- **Main owns the PTY.** `src/main/terminal/` spawns the shell (`SHELL`, or
  PowerShell on Windows), with the `PATH` that
  `packages/core/src/utils/shellPath.ts` repairs.
  - Main works out the working directory itself, from the scope and the
    repository, and applies the scope rule again. The renderer's menu only
    previews it (`src/shared/terminalScope.ts`).
  - A PTY is closed with its window, on quit, and when its shell exits.
  - The renderer gets bytes over four narrow channels and one event stream,
    never a handle.
- **The panel keeps its terminals while hidden.** The frame unmounts a hidden
  bottom panel, so the xterm instances and their tabs live in a store outside
  React, and are re-parented when the panel opens again. Ctrl+\` is passed
  through xterm to the frame's shortcut.
- **Tabs** are new, close and rename. Each is labelled with its scope: *Your
  checkout*, *Task #N worktree*, or the repository. The banner for a task that
  starts under an open shell is derived from the scope store, which follows
  the session stream. It is also announced to screen readers.
- **Copy and paste** use Cmd+C and Cmd+V on macOS, and Ctrl+Shift+C and
  Ctrl+Shift+V elsewhere, so Ctrl+C stays an interrupt. The context menu
  copies a selection, and otherwise pastes. A web address on a line opens with
  Cmd (macOS) or Ctrl and a click, through `terminal.openLink`.
- **Packaging.** node-pty is a native addon.
  - electron-builder rebuilds it for the app's Electron once per target
    architecture (`npmRebuild`), and it is unpacked from the archive.
  - `scripts/desktop-package-check.mjs` loads the unpacked copy and runs a
    shell through it.
  - Linux has no prebuilt binary, so its build needs make, g++ and python.

## Out of scope

- A cloud-HSM signing integration, and signing the Linux packages
  (ADR-0063 H9).
- On the graph:
  - dragging, panning by drag, free zoom and a minimap;
  - drag-to-connect, and any structural editing.
- Moving the plan panel or the planner to another side. User-chosen colours
  for areas or runners.
- Cloning a repository from Welcome.
- Arbitrary branch merges, rebase, pull requests, force push, and pushing to
  any target other than the tracking remote.
- Moving the TUI onto the shared daemon. A TUI's private daemon is joined
  ([W16](#w16-a-session-another-host-holds)), not replaced.
- Joining a session a VS Code window holds.
- A mobile app, and a browser preview of the UI.
- Creating, renaming and deleting files in the Explorer.
- Holding a landing branch against the terminal or other git clients.

## Slices

### The second version

In this order. Each slice lands on its own, with its tests, and leaves every
surface working. "Done" means what the slice's own task proves. These slices
change the first build. They are not a rewrite: the daemon, the bridge, the
routes and the views' data stay as they are.

1. **Joining a held session.** [W16](#w16-a-session-another-host-holds): join a
   session another daemon holds, Continue here, and, for a VS Code holder,
   Start a new session here or Watch read-only. A refused take-over always
   says why. The amendment to ADR-0063, and to ADR-0049 if it needs one. Done:
   the app drives a session that a TUI's private daemon holds, and continues
   it after the TUI quits.
2. **Design tokens v2, shared primitives and `TaskSummary`.** The
   [tokens](#design-tokens): the colour roles with the new area and runner
   tokens, in `theme.css` and `vscode-tokens.css`; the spacing migration; the
   new type steps; the icon sizes; the control heights; and the second
   elevation level. Also the shared primitives that carry the
   [overlap rules](#layout-rules-that-prevent-overlap) (icon box, button,
   badge, runner badge, chip, row, tab), and `TaskSummary` with its three
   variants. Done: the token contrast test covers every pair in both themes,
   and VS Code still renders through its mapping.
3. **Frame v2.** The [layout](#layout): the activity bar with Sessions, the
   Sessions sidebar, the centre with the pinned planner tab, the plan panel
   and its rail, and the terminal under the centre. Also the
   [sizing and collapse rules](#sizing-and-responsive-rules), the title bar's
   priority order, the new window minimum and the 40 px bar, layout
   persistence, Reset layout, and the keys. Done: checklist L1 to L6 and T1 to
   T4 pass in a test at the five widths.
4. **Welcome v2.** [W1](#w1-welcome-and-open-project): the wordmark, project
   cards, runner cards, a folder drop, the footer, and `version?` on
   `GET /api/runners`. Done: W1's states, each drawn from a test fixture.
5. **The plan panel, task tab and planner tab.** W2, W3, W4, W6, W7, W14 and
   W17 in the new frame, all built on `TaskSummary`. Done: row parity with the
   table above, and the approval card's effects gating Approve in both places.
6. **The plan graph.** [W5](#w5-the-plan-graph-tab): the stage layout
   function, stage strip, snapping scroller, cards, edge lanes, highlight,
   folding, the critical path, density and keys. Done: the layout function is
   tested over plan shapes, and checklist G1 to G5 pass.
7. **The user's review.** The user reviews the redesigned core, and the next
   slices take their changes.
8. **Explorer and Changes** in the new frame: W8, W9, W13.
9. **Checkout, Git, terminal and Settings** in the new frame: W10, W11, W12,
   the terminal panel and Settings.
10. **Visual quality check.** The [checklist](#design-review-checklist), run
    over screenshots of every wireframe in both themes at the five widths.
    Then its findings are fixed.

### The first build

These slices are all done. They are kept here because tasks and commits cite
them.

1. **packages/ui extraction.**
   - Move the webview's components
     (`packages/vscode/src/views/chat/components/*`), view state, styles and
     webview protocol (`packages/vscode/src/shared/protocol.ts`) into
     `packages/ui`.
   - Introduce `HostBridge`, the one seam that today is `acquireVsCodeApi`.
   - Styles become the semantic tokens, mapped onto VS Code's theme variables.
   - Add the package to the build order and `scripts/change-scope.mjs`.

   Done: the VS Code extension behaves as before, and its integration test
   passes.
2. **Host-neutral view layer.** Move the view assembly in `RunViewHost` and
   `ConversationViewHost` behind one layer in `packages/ui` (or core, where it
   is pure), fed by either in-process `SessionMessage`s or daemon frames (H7).
   Done: VS Code drives it in-process, and a test drives it from recorded
   daemon frames to the same view.
3. **Daemon read routes.** The workspace reader in core and the routes of
   ADR-0064, plus `GET /api/plans/:sessionId/tasks/:taskId/diff`, and
   `version` and `contract` on `GET /api/server` (H3). Done: ADR-0064's
   testing decisions.
4. **Daemon git-action routes and interlock.** The routes and refusals of
   ADR-0062 G1–G8 and G10's save, the interlock function,
   `user-actions.jsonl` with the holder folding it in, and the merge
   preflight. Done: ADR-0062's testing decisions.
5. **Electron shell tracer.** `packages/desktop`, with main, preload and a
   renderer that shows the session list.
   - Attach-or-own with `utilityProcess.fork` (H2), with the daemon helpers
     factored out and shared with the CLI.
   - The handshake (H3), the route table and the bridge (H4).
   - CSP and navigation locks.

   Done: the attach table and the route table are tested; the app attaches to
   a CLI daemon, and owns one when none runs.
6. **Design system and app frame.** Tokens, type, icons and custom glyphs;
   the activity bar, sidebar, tabs (preview, pin, split), title bar with
   native chrome, planner panel, status bar and command palette; light and
   dark. Done: the frame with empty views, and the token contrast pairs
   tested.
7. **Packaging and CI.**
   - electron-builder for dmg and zip (arm64, x64), NSIS (x64), and AppImage
     and deb (x64), unsigned at first. Unsigned macOS is signed ad hoc: the
     fuses rewrite the executable, and an arm64 Mac refuses one whose seal is
     broken. Signing and notarization when a release has the credentials came
     later (ADR-0063 H9).
   - `desktop-build.yml` builds them on macOS, Windows and Linux for a pull
     request, by hand and for a release; `release.yml` calls it to attach them
     to the GitHub Release.
   - Auto-update is wired, and baked on only for a signed build (ADR-0063 H9).
   - The build is in `scripts/ci.mjs` and `change-scope.mjs`.

   Done: a tag build produces the seven installers. node-pty's native rebuild
   was left to the slice that needed a terminal (the `REBUILD NODE-PTY` marker
   in `packages/desktop/scripts/package.mjs`).
8. **Session view.** W2, W3, W4, W6, W14 and W17: planning, approval, the List
   with full row parity, the task tab, and the restored and failed states. One
   window per workspace (H6), and Welcome (W1).
9. **Attention, connection and settings.** Needs you (W7), Reconnecting and
   the mismatch card (W15), the held-session banner (W16), the tray and
   quitting (H5), and the Settings view over `/api/settings`.
10. **Graph view.** A first graph with React Flow and dagre. The second
    version replaces it with stage columns.
11. **Explorer and Monaco.** W8: the scope switcher, the tree, the Monaco
    viewer, the checkout editor with `baseHash` saves, quick open, and Open in
    editor.
12. **Review of task and run diffs.** W9: Monaco's diff over the task and run
    diff routes, line comments as `message_task`, and revert with a preview.
13. **The user's checkout changes.** W10 and W13: status; stage and unstage by
    file and hunk; commit and amend; discard; stash; fetch, pull and push; the
    landing-branch note; and the Merge all preflight dialog.
14. **Git view.** W11 and W12: branches, the commit graph, commit detail, and
    branch create, switch and delete, with their confirms and refusals.
15. **Terminal.** xterm.js over node-pty in main, under
    [the terminal rule](#the-terminal-rule).
16. **Offline e2e.** Playwright's Electron driver, against the packaged app,
    the mock provider (`bench/live/mock-provider.mjs`) and fake runners, with
    no API key. It opens, plans, approves, runs, follows a task, answers an
    approval, reviews a diff, commits in the checkout, and runs Merge all
    through the preflight. It runs once owning the daemon and once attached to
    a CLI one. It is part of `npm run ci`.
