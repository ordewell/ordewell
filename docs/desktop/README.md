# The Ordewell desktop app

The desktop app is the Ordewell you already know, in a window: the planner on
the right, the plan and its tasks in the middle, and your own repository —
files, diffs, git and a terminal — beside it. It runs the same plan with the
same runners and models as the terminal UI and the VS Code extension, because
it is a client of the same local daemon.

The design is [design.md](design.md). The decisions behind it are
[ADR-0060](../adr/surfaces/0060-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)
(the app is an Electron client of the shared daemon),
[ADR-0061](../adr/surfaces/0061-a-host-reads-files-and-git-for-the-user-confined-to-the-workspace.md)
(a host reads files and git for you) and
[ADR-0062](../adr/isolation/0062-user-git-actions-are-confirmed-at-a-host-and-a-live-run-holds-only-its-landing-branch.md)
(git actions are confirmed at a host). This page is how to install it, what the
window holds, and what to do when it will not start.

## Install

Each [release](https://github.com/ordewell/ordewell/releases) attaches the
installers, named `Ordewell-<version>-<os>-<arch>.<ext>`:

| OS | Files | Architectures |
|---|---|---|
| macOS | `.dmg`, `.zip` | arm64, x64 |
| Windows | `.exe` (NSIS installer) | x64 |
| Linux | `.AppImage`, `.deb` | x64 |

The builds are **unsigned**. They are not notarized by Apple and carry no
Windows code-signing certificate, so macOS and Windows ask you to allow the app
on first launch; that is expected, and nothing is wrong with the download.

### macOS

Open the `.dmg` and drag Ordewell to Applications. Then, in Finder, right-click
(or Control-click) Ordewell and choose **Open**, and **Open** again in the
dialog. Double-clicking the first time only offers *Move to Bin*.

If you already double-clicked and Gatekeeper refused it, the same app is allowed
from **System Settings › Privacy & Security › Open Anyway**, or with:

```bash
xattr -d com.apple.quarantine /Applications/Ordewell.app
```

The app is signed ad hoc, which macOS applies when a build flips Electron's
fuses, so an Apple-silicon Mac can run it; there is no developer identity behind
that signature.

### Windows

Run the `.exe`. SmartScreen says **Windows protected your PC**: choose **More
info**, then **Run anyway**. The installer is per-user, needs no administrator
and lets you choose its folder.

### Linux

The AppImage runs without installing:

```bash
chmod +x Ordewell-<version>-linux-x64.AppImage
./Ordewell-<version>-linux-x64.AppImage
```

On a distribution without FUSE 2 (Ubuntu 24.04, for one), install `libfuse2`
first, or run the AppImage with `--appimage-extract-and-run`.

The `.deb` installs with your package manager, for example:

```bash
sudo apt install ./Ordewell-<version>-linux-x64.deb
```

It adds `ordewell-desktop` to your applications menu and to `PATH`. That name is
deliberate: the CLI's `ordewell` binary keeps its own name.

### What the app needs

A desktop build carries Electron and its own copy of the daemon, so it needs no
Node.js. It uses the runners already on your machine — at least one of Claude
Code, Codex or OpenCode, installed and signed in — and git 2.38 or newer for
task isolation. The welcome window says which runners it found.

## Run it from source

From a checkout of this repository:

```bash
npm install
npm run build          # core first: every other package compiles against its dist/
npm run desktop:dev
```

`desktop:dev` builds main and the preload once, serves the renderer from Vite
with hot reload, and opens an unpackaged Electron app pointed at that server. A
change to `src/main` or `src/preload` needs the command restarted; a change to
the renderer reloads in place.

To run the built app without a dev server, build everything and start Electron
on the package:

```bash
npm run build
npx electron packages/desktop
```

## Package it

```bash
npm run desktop:package
```

This builds the app and runs electron-builder for the OS you are on, writing its
output to `packages/desktop/release/`. `--dir` builds only the unpacked app,
which is the quick way to look at what a package holds:

```bash
npm run desktop:package -- --dir
```

Anything else after `--` goes to electron-builder, so
`npm run desktop:package -- --arch x64` cross-builds the other macOS
architecture. Building `@ordewell/core` and `@ordewell/web` first is not
optional: the packaged daemon is web's `dist/`.

The terminal's PTY is `node-pty`, a native addon. electron-builder rebuilds it
for the app's Electron, once per target architecture, which is why a packaged
build differs from the copy in `node_modules`. On Linux that rebuild needs
`make`, `g++` and `python`; on Windows it compiles with the Visual Studio
"Spectre-mitigated libraries" component.

## First run

The welcome window offers **Open folder…** — a workspace is a folder, usually a
git repository or a folder of them — and lists the ones you opened before; one
whose folder has gone missing says so. If the runners list flags one as signed
out, sign in from its own CLI first, or in Settings.

With a workspace open:

1. Type a goal to the planner on the right.
2. Read the plan as it streams. Edit a task's prompt, dependencies, runner,
   model or mode inline; the note above the approval button lists any script or
   effect you should read first.
3. **Approve plan**, then **Run**. Independent tasks run in parallel and
   dependent ones wait.
4. Follow a task in its tab, answer what **Needs you** asks, and read each diff
   in Changes.
5. **Review & Merge all** when the run has settled with landings, or discard the
   run.

Autorun and automatic merging are off by default; Settings has the same
planner, runner and run settings as every other surface.

## The daemon

The app never runs a `Session` itself. It is a client of the local daemon on
`127.0.0.1:3742`, so a run started here is the run `ordewell status` reports and
the CLI can follow ([ADR-0060](../adr/surfaces/0060-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)).

- **Attach or own.** At launch the app asks `GET /api/server` who is there. A
  daemon that answers, with a token file it can read, is attached to. With none
  running, the app starts the daemon it bundles and owns it: it stops when the
  app quits. A daemon you started with the CLI is yours, and keeps running.
- **One version at a time.** The app compares the daemon's contract number with
  the one it was built against, and shows both versions when they differ. It
  offers to restart the daemon with its own, and refuses while that daemon has a
  live run, naming the run. Another port is picked with `ORDEWELL_PORT`.
- **The tray, and quitting.** Closing a workspace's window during a run keeps
  the app running in the menu bar or tray, with the run and its Needs you count
  there; **Keep running in the tray** in Settings does the same with no run.
  Quitting asks first while a run is live, and says whether the run stops (the
  app owns the daemon) or goes on (it attached to yours). A terminal running a
  process is asked about in the same dialog.
- **Reconnecting.** If the daemon goes away, the window dims to its last known
  state and a bar counts the attempts. Coming back redraws from a fresh
  snapshot; nothing is inferred from the time apart.
- **One window per workspace.** Opening a folder that is already open focuses
  its window. A session another host holds — a VS Code window, a CLI daemon —
  opens read-only, with that host named, and **Take over…** asks before it
  moves the session.

## A tour of the window

### Title bar

The breadcrumb names the workspace, the repository and the branch, and the
**scope switcher** beside it chooses which tree the Explorer, Changes and the
terminal look at: *Your checkout*, the run's *Integration branch*, or a task's
*worktree*. The **Needs you** badge counts what waits on you. One primary action
sits at the right — *Approve plan*, *Run*, *Stop* or *Review & Merge all*,
whichever the session is at — and everything else is in the `⋯` menu.

### Plan

The Plan tab is pinned and switches between **List** and **Graph** (`V`). List
is the run as rows, each with its status, runner and model, dependencies,
isolation and elapsed time. Graph is the live DAG: colour-coded edges are
dependencies, a heavier path is the critical path, and subtasks and child plans
fold into their parent with a count. Clicking a task opens its tab:
**Details** (verdict and its evidence, prompt, assignment, dependencies, the
handoff with its findings and artifacts, attempts) and **Chat** (its output,
approvals, checkpoints and composer).

The sidebar under Plan holds **Needs you** at its head, then **Sessions** and
**Tasks**; a task row there opens the same tab as the list.

### Planner

The planner panel on the right is the conversation, always the planner's and
never a task's chat. The row above it picks the planner, its model and its
thinking effort, and the usage line beneath the conversation shows the account
limits. `⌘L`/`Ctrl+L` opens it and puts the cursor in the composer.

### Explorer

One directory at a time, with git status letters, ignored files marked, and
`.ordewell/skills/` shown like any committed directory. A file opens in Monaco.
In *Your checkout* it is editable and `⌘S`/`Ctrl+S` saves it, refusing to
overwrite a file that changed on disk since you read it. Worktrees and the
integration branch are read-only; the banner offers to open the same path in
your checkout. Quick open is `⌘P`/`Ctrl+P`; **Open in editor** hands the file to
your own editor.

### Changes

In a run scope, Changes lists the changed files of a task or of the whole run,
with Monaco's diff beside it, side by side or inline. A line comment is sent to
the task as a message quoting the file and line. *Review & Merge all* opens the
preflight described below.

On *Your checkout*, Changes is your own working tree: staged, unstaged,
untracked and conflicted files, the commit box (`⌘⏎`/`Ctrl+Enter` commits),
amend and discard. A note says when the branch is a live run's landing branch,
because actions there are recorded in its timeline.

### Git

Branches (yours, Ordewell's read-only, and remote-tracking as of the last
fetch), stashes, worktrees and remotes. A lock marks a live run's landing
branch and names the run. Create, switch and delete a branch; stash, pop or drop
a stash; fetch, pull and push the current branch to its tracking remote; and
open the commit graph: commits page in by cursor, with their message, files and
patches.

### Terminal

``Ctrl+` `` opens a terminal panel at the bottom. It is your own shell, started
by the app rather than the daemon, in the checkout by default or in a task's
worktree while that task is not running. It keeps its tabs hidden, and a task
that starts under an open shell shows a banner rather than killing it. Copy and
paste are `⌘C`/`⌘V` on macOS and `Ctrl+Shift+C`/`Ctrl+Shift+V` elsewhere, so
`Ctrl+C` stays an interrupt; `⌘`/`Ctrl`-click opens a web address the terminal
printed.

### Settings

`⌘,`/`Ctrl+,` opens Settings: the planner and its model, the enabled runners and
their model allowlists, the run rules (autonomy, supervisor, autorun, parallel
tasks, merge at gates), and this app's own preferences — theme, desktop
notifications, and keeping the app in the tray. The run rules are the shared
ones; the app's preferences stay on this machine.

The app starts dark. The Theme control sits under Appearance at the top of
Settings (Dark, Light, System); System follows your computer's light or dark
setting. The command palette has the same choice as `Theme: Dark`,
`Theme: Light` and `Theme: System`. A choice applies at once and is kept; a
theme you saved earlier, including System, is never rewritten.

### Command palette and status bar

`⌘K`/`Ctrl+K` lists every enabled command by name, with its shortcut. The
status bar names the daemon and whether the app attached to it or started it,
the session's lease holder, the enabled runners, and the account usage limits
the daemon has read.

## Keyboard

`⌘` is Command on macOS; elsewhere the same row uses Ctrl.

| Keys | Does |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette |
| `⌘P` / `Ctrl+P` | Quick open a file in the current scope |
| `⌘1`–`⌘4` / `Ctrl+1`–`Ctrl+4` | Plan, Explorer, Changes, Git |
| `⌘,` / `Ctrl+,` | Settings |
| `⌘B` / `Ctrl+B` | Show or hide the sidebar |
| `⌘L` / `Ctrl+L` | Show the planner panel and focus its composer |
| ``Ctrl+` `` | Show or hide the terminal panel |
| `⌘⇧A` / `Ctrl+Shift+A` | Open Needs you |
| `⌘⇧⏎` / `Ctrl+Shift+Enter` | The primary action, with its confirm |
| `V` | Switch List and Graph, with the Plan focused |
| `⌘W` / `Ctrl+W` | Close the tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next or previous tab |
| `⌘\` / `Ctrl+\` | Split the editor |
| `⌘S` / `Ctrl+S` | Save, in your checkout |
| `⌘⏎` / `Ctrl+Enter` | Commit, in the commit box |
| `F7` / `Shift+F7` | Next or previous change, in a diff |
| `Esc` | Close a popover, peek or dialog |
| `⌘⇧W` / `Ctrl+Shift+W` | Close the window, from the File menu |

In the graph, the arrow keys move along the edges: left to a dependency, right
to a dependent, up and down between the nodes of one layer. Every control is
reachable with `Tab` in visual order and names its state; the app announces its
own messages — a reconnection, a sent comment, a refused action — in one polite
live region, and streaming output is never announced as it arrives.

## Git actions and the run interlock

The daemon performs a fixed set of actions on *your* checkout, at your request
([ADR-0062](../adr/isolation/0062-user-git-actions-are-confirmed-at-a-host-and-a-live-run-holds-only-its-landing-branch.md)).
A task's worktree, the integration branch and any branch Ordewell created are a
run's, and the app only reads them.

- **Confirmed against what you saw.** A destructive or remote action echoes what
  the confirm showed: discard names the files, delete names the branch and its
  unmerged commits, pull and push name the remote and branch, amend echoes
  `HEAD`. If the state moved meanwhile, the action is refused as stale and the
  confirm redraws with the new state. Amend is offered only while the commit is
  unpushed.
- **Your git.** Actions run the `git` on your `PATH` with your configuration,
  hooks, signing and credential helpers, so a commit is the commit you would
  have made in a terminal. Git's own message is what you see when one fails.
- **A live run holds only its landing branch.** While a run has an attempt in
  progress, a start pending, or a landing or Merge all under way, switching a
  repository away from its landing branch, detaching it, and deleting that
  branch are refused, naming the session, the run and the branch. Everything
  else — committing on it, pulling into it, stashing, discarding, other branches
  and repositories — is allowed, and an action on the landing branch is added to
  the run's timeline. Runs in workspaces that enclose this checkout count too.
  A terminal or another git client is outside this check; Merge all catches its
  effects.
- **Merge all asks first.** Before merging, the preflight names each
  repository's branch and the uncommitted files of yours that the merge also
  changes. With an overlap you can **Commit them…** (the commit box opens with
  those files staged), **Stash them** (only the overlapping paths, restored
  afterwards by a button on the banner), or **Cancel**. A repository that has
  moved off the branch the run started on is named there, before anything
  merges.

A terminal is your own shell and sits outside all of this, exactly like one you
open yourself: what you type there is not recorded in a run's timeline.

## Troubleshooting

- [The desktop app will not open](../troubleshooting.md#the-desktop-app-will-not-open)
  — Gatekeeper, SmartScreen and the AppImage.
- [The desktop app cannot reach its daemon](../troubleshooting.md#the-desktop-app-cannot-reach-its-daemon)
  — a port already taken, a token it cannot read, or a daemon that would not start.
- [The desktop app says the daemon is another version](../troubleshooting.md#the-desktop-app-says-the-daemon-is-another-version)
  — the version handshake, and when a restart is refused.
- [The desktop app's terminal does not open](../troubleshooting.md#the-desktop-apps-terminal-does-not-open)
  — the native addon behind the panel.

The daemon's own log is `~/.ordewell/server.log`, and the app's preferences and
recent workspaces are in its user-data folder — `~/Library/Application
Support/Ordewell` on macOS, `%APPDATA%\Ordewell` on Windows and
`~/.config/Ordewell` on Linux.

If a build from this repository misbehaves, `npm run ci` runs what CI runs,
including the offline end-to-end walk of the app, and says which step failed.
