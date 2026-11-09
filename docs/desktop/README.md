# The Ordewell desktop app

The desktop app is the Ordewell you already know, in a window: the planner
conversation in the middle, the plan beside it on the right, and your own
repository — files, diffs, git and a terminal — a click away on the left. It runs the same plan with the
same runners and models as the terminal UI and the VS Code extension, because
it is a client of the same local daemon.

The design is [design.md](design.md). The decisions behind it are
[ADR-0063](../adr/surfaces/0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)
(the app is an Electron client of the shared daemon),
[ADR-0064](../adr/surfaces/0064-a-host-reads-files-and-git-for-the-user-confined-to-the-workspace.md)
(a host reads files and git for you) and
[ADR-0062](../adr/isolation/0062-user-git-actions-are-confirmed-at-a-host-and-a-live-run-holds-only-its-landing-branch.md)
(git actions are confirmed at a host). This page is how to install it, what the
window holds, and what to do when it will not start.

## Install

> **Not in a release yet.** Releases do not carry the desktop installers yet:
> they are made with the app left out until it is ready (ADR-0065 C10). Until
> then, [run it from source](#run-it-from-source). The instructions below are
> how it installs once a release carries it.

Each [release](https://github.com/ordewell/ordewell/releases) attaches the
installers, named `Ordewell-<version>-<os>-<arch>.<ext>`:

| OS | Files | Architectures |
|---|---|---|
| macOS | `.dmg`, `.zip` | arm64, x64 |
| Windows | `.exe` (NSIS installer) | x64 |
| Linux | `.AppImage`, `.deb` | x64 |

A release is signed, and on macOS notarized by Apple, once the project's
signing credentials are configured ([Signed releases](#signed-releases));
until then its builds are **unsigned**. An unsigned build carries no Developer
ID and no Windows code-signing certificate, so macOS and Windows ask you to
allow the app on first launch. That is expected, and nothing is wrong with the
download. A signed build opens without asking, and it is the only kind that
updates itself; an unsigned one, and every Linux build, is updated by
downloading the next release.

### One line

Instead of downloading an installer by hand, one command installs the app for
your user: it downloads the right file for your OS and architecture, checks it
against the release's checksums, and installs it. It stops, and installs
nothing, if the checksum does not match.

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/ordewell/ordewell/main/scripts/install/desktop.sh | sh
```

Windows (PowerShell 5.1 or 7):

```powershell
irm https://raw.githubusercontent.com/ordewell/ordewell/main/scripts/install/desktop.ps1 | iex
```

Run the same command again to upgrade. Both scripts are short and readable;
read one before you pipe it into a shell, as you would any other. To pass an
option through the pipe:

```bash
curl -fsSL https://raw.githubusercontent.com/ordewell/ordewell/main/scripts/install/desktop.sh | sh -s -- --version 0.12.3
curl -fsSL https://raw.githubusercontent.com/ordewell/ordewell/main/scripts/install/desktop.sh | sh -s -- --uninstall
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ordewell/ordewell/main/scripts/install/desktop.ps1))) -Version 0.12.3
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ordewell/ordewell/main/scripts/install/desktop.ps1))) -Uninstall
```

| | `desktop.sh` (macOS, Linux) | `desktop.ps1` (Windows) |
|---|---|---|
| Installs | macOS: `Ordewell.app` into `/Applications`, or `~/Applications` when that is not writable. Linux: the AppImage as `~/.local/bin/ordewell-desktop`, with a launcher entry and icon under `~/.local/share` | The NSIS installer, run silently for the current user: no administrator, no prompt |
| Version | `--version X.Y.Z` or `ORDEWELL_VERSION` (the latest release by default) | `-Version X.Y.Z` or `ORDEWELL_VERSION` |
| Remove | `--uninstall` | `-Uninstall` |
| Other | `--deb` (Linux): install the `.deb` with `apt` or `dpkg`, using `sudo`. `--dry-run`: say what would happen | `-DryRun` |
| From a directory | `ORDEWELL_DESKTOP_FROM=<dir>`: the installers and a `SHA256SUMS` there instead of the network (for `packages/desktop/release`, run `node scripts/desktop-release-assets.mjs packages/desktop/release --partial` first) | the same |
| Where | `ORDEWELL_INSTALL_DIR=<dir>`: macOS, the folder `Ordewell.app` goes in; Linux, the prefix that replaces `~/.local` | `ORDEWELL_INSTALL_DIR=<dir>`: the install folder |

Uninstalling removes the app and, on Linux, the launcher entry and icon. It
leaves your sessions and settings, in `~/.ordewell` and the app's own folder,
where they are. The scripts never remove an `Ordewell.app` whose bundle
identifier is not Ordewell's, and ask you to quit a running app first.

**What the scripts do not do.** They never remove a quarantine attribute, call
`Unblock-File` or change a SmartScreen setting. One consequence to know:
macOS marks a file a *browser* downloads as quarantined and runs its
first-launch Gatekeeper check on it, and Windows marks it with a mark of the
web, which is what SmartScreen reads. A file `curl` or `Invoke-WebRequest`
downloads carries neither mark, so the first launch can differ from the
browser path described below, in an unsigned build as in a signed one. What is
protected instead is that the file matches the checksum the release published.

### Homebrew and winget

Two package managers install the same release, once it has published there:

```bash
brew install --cask ordewell/tap/ordewell-desktop
```

```powershell
winget install Ordewell.Ordewell
```

`brew upgrade --cask ordewell-desktop` and `winget upgrade Ordewell.Ordewell` move to a
later release, and a signed, notarized build also updates itself. Neither is
published yet: the release renders the cask and the manifests and pushes them
only when the maintainers have configured the tokens for it ([Signed
releases](#signed-releases)). A cask is published only for a
notarized macOS build, because Homebrew will not install an app that Gatekeeper
stops; the winget manifests are published for every release.

### Stable links and checksums

Each release also carries copies of the installers with no version in their
name, so a link that never changes always gets the latest release:

| File | Link |
|---|---|
| macOS, Apple silicon | <https://github.com/ordewell/ordewell/releases/latest/download/Ordewell-mac-arm64.dmg> |
| macOS, Intel | <https://github.com/ordewell/ordewell/releases/latest/download/Ordewell-mac-x64.dmg> |
| Windows | <https://github.com/ordewell/ordewell/releases/latest/download/Ordewell-win-x64.exe> |
| Linux AppImage | <https://github.com/ordewell/ordewell/releases/latest/download/Ordewell-linux-x64.AppImage> |
| Linux `.deb` | <https://github.com/ordewell/ordewell/releases/latest/download/Ordewell-linux-x64.deb> |
| Checksums | <https://github.com/ordewell/ordewell/releases/latest/download/SHA256SUMS> |

For one release, replace `latest/download` with `download/v<version>`.
`SHA256SUMS` lists every installer in that release, by its versioned name and
its fixed name; a release that has a `SHA256SUMS` has all of them.

To check a download by hand, put the file and `SHA256SUMS` in one folder and
run:

```bash
sha256sum --ignore-missing -c SHA256SUMS          # Linux
shasum -a 256 --ignore-missing -c SHA256SUMS      # macOS
```

```powershell
(Get-FileHash .\Ordewell-win-x64.exe -Algorithm SHA256).Hash.ToLower()
Select-String 'Ordewell-win-x64.exe' .\SHA256SUMS   # the two hashes must be the same
```

A checksum that comes from the same release as the file shows the download is
complete and unaltered in transit. It does not show who built it; that is what
a signed build is for.

The steps below are for installing by hand, from an unsigned build.

### macOS

Open the `.dmg` and drag Ordewell to Applications. Then, in Finder, right-click
(or Control-click) Ordewell and choose **Open**, and **Open** again in the
dialog. Double-clicking the first time only offers *Move to Bin*.

If you already double-clicked and Gatekeeper refused it, the same app is allowed
from **System Settings › Privacy & Security › Open Anyway**, or with:

```bash
xattr -d com.apple.quarantine /Applications/Ordewell.app
```

An unsigned build is signed ad hoc, which macOS applies when a build flips
Electron's fuses, so an Apple-silicon Mac can run it; there is no developer
identity behind that signature.

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
Code, Codex or OpenCode, installed and signed in. git is optional; 2.38 or
newer gives isolated worktrees, delegated tasks and Merge all. The welcome window says which runners it found.

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

Every pull request to `main` that touches the app, the packages bundled into it
or the packaging builds the installers on macOS, Windows and Linux, so a
packaging break shows up before a release (`.github/workflows/desktop-build.yml`).
Run it by hand from the Actions tab (**Desktop build**, Run workflow); the
installers are kept as workflow artifacts for a week. A release tag runs the
same workflow and attaches the installers to the Release.

## Signed releases

A release signs the installers, and on macOS has Apple notarize them, only when
the maintainers have configured the signing credentials in the repository.
Without them it builds unsigned installers, and updates stay off
([ADR-0063 H9](../adr/surfaces/0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)).
Linux builds are never signed and never update themselves. The credentials
reach only a release build: a pull request, a manual run or a fork always
builds unsigned. Each build writes `release/signing.json`, which says what it
signed, and `node scripts/desktop-package-check.mjs` verifies every signature
it lists.

The same holds for the package managers. A release renders the Homebrew cask
and the winget manifests from its own installers and checksums
(`scripts/render-package-manifests.mjs`, `packaging/`) and publishes them only
when the maintainers have configured the tokens for it; without them the
release still succeeds. The cask is published only for a notarized macOS
build, because Homebrew will not install an app Gatekeeper stops.

## First run

The welcome window offers **Open folder…** (`⌘O`/`Ctrl+O`), or you can drop a
folder on the window. A workspace is a folder, usually a git repository or a
folder of them. Under **Recent projects**, the ones you opened before are
cards with their branch, their last session's goal and status, and what needs
you there; one whose folder has gone missing says so, and **Forget** takes it
off the list. A card
per runner says whether it is installed and signed in. If one is signed out,
sign in from its own CLI first, or in Settings; if one is missing, install it
and press **Retry**.

With a workspace open:

1. Type a goal to the planner, in the middle of the window.
2. Read the plan as it streams into the Plan panel on the right. Click a task
   to edit its prompt, dependencies, runner, model or mode in its tab; the
   approval card at the foot of the conversation lists any script or effect you
   should read first.
3. **Approve plan**, then **Run**. Independent tasks run in parallel and
   dependent ones wait.
4. Follow a task in its tab, answer what **Needs you** asks, and read each diff
   in Changes.
5. **Review & Merge all** when the run has settled with landings, or discard the
   run.

Autorun and automatic merging are off by default; Settings has the same
planner, runner and run settings as every other surface.

Another workspace opens from any window, not only the welcome one: the
**File** menu has **Open Folder…** (`⌘O`/`Ctrl+O`), **Open Recent**, newest
first, with **Clear Recently Opened** at its foot, and **New Window**
(`⌘⇧N`/`Ctrl+Shift+N`), which brings up the welcome window beside the ones
open. The project name at the head of the title bar does the same: see
[Title bar](#title-bar). Dropping a folder on a workspace's window opens it too.
On macOS the folders also go to the Dock's recents.

## The daemon

The app never runs a `Session` itself. It is a client of the local daemon on
`127.0.0.1:3742`, so a run started here is the run `ordewell status` reports and
the CLI can follow ([ADR-0063](../adr/surfaces/0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)).

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
  its window, whichever window it was chosen in. Otherwise a workspace's window
  with nothing live switches to the folder in place. One with a live run, a
  question waiting in Needs you or a checkpoint, a planner turn under way or a
  terminal running a process is never switched away: the app asks whether to
  open the folder in a new window, and **Cancel** leaves everything as it was.
  The folder goes to the top of the recents either way it opens.
- **A session another host holds.** A session the terminal UI or another
  Ordewell daemon holds is *joined*: you drive it live from the app while the
  other client shows the same session, and the session header and status bar
  say *Joined* and name the holder. When that holder exits, **Continue here**
  carries the session on in the app. A session a VS Code window holds runs
  inside VS Code, so the app offers **Start a new session here** or **Watch
  read-only** instead. **Take over…**, in the `⋯` menu, asks before it moves a
  session, and a refusal always says which process still holds it.

## A tour of the window

```
┌ title bar: project ▾ › repo › branch · scope · Needs you · primary action · ⋯ ┐
├────┬───────────┬──────────────────────────────────────────┬─────────────────┤
│ ☰  │ sidebar   │ Planner │ #3 Add login │ auth.ts │ Graph  │ Plan            │
│ ⎘  │ (Sessions,│                                          │ the task list,  │
│ ⑂  │ Explorer, │ the centre: the planner conversation     │ with a Graph    │
│ ⑃  │ Changes,  │ first, then tasks, files, diffs, graphs  │ button          │
│    │ Git)      ├──────────────────────────────────────────┤                 │
│ ⚙  │           │ terminal (Ctrl+`)                        │                 │
├────┴───────────┴──────────────────────────────────────────┴─────────────────┤
│ status bar: daemon · lease holder · runners · usage limits                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Title bar

The breadcrumb starts with the workspace's name as a **project switcher**: its
tooltip is the folder's full path, and it opens a menu of the other recent
folders, **Open Folder…**, and **Open in new window**, which, while ticked,
gives what you choose a window of its own instead of switching this one. The
arrow keys open and move through the menu, and `Esc` closes it; **Switch
Project…** in the command palette opens it too. Then come the repository and
the branch, and the **scope switcher** beside it chooses which tree the Explorer, Changes and the
terminal look at: *Your checkout*, the run's *Integration branch*, or a task's
*worktree*. The **Needs you** button counts what waits on you. One primary
action sits at the right — *Approve plan*, *Run*, *Stop* or *Review & Merge
all*, whichever the session is at — and everything else is in the `⋯` menu.
As the window narrows the breadcrumb shortens first, and the project switcher
keeps its folder icon and chevron after its name drops; Needs you and the
primary action always stay in view.

### Planner

The first tab in the middle is always the planner conversation. It is pinned
and cannot be closed. Its header names the session's goal and status, and
picks the planner, its model and its thinking effort, with the context fill
and account limits beside them; `⋯` there forks, rewinds or compacts the
conversation. When a plan is ready, its approval card appears at the foot of
the conversation. `⌘L`/`Ctrl+L` brings the planner tab forward and puts the
cursor in the composer.

### Tabs

Tasks, files, diffs, commits and the plan graph open as tabs beside
the planner. A single click opens a preview tab, in italics, which the next
preview replaces; a double click, or editing in it, keeps it. A task's tab has
**Details** (the verdict and its evidence, the prompt, assignment,
dependencies, the handoff with its findings and artifacts, and the attempts)
and **Chat** (its output, approvals, checkpoints and composer). Task, diff and
graph tabs belong to their session and come back when you return to it.
`⌘\`/`Ctrl+\` splits the area in two.

### Plan

The Plan panel on the right is the run as a list, one row per task, with its
status, runner, model and effort, and anything waiting on you; an approval's
**Allow** and **Deny** are on the row itself. Clicking a row opens the task's
tab. `⌘⌥B`/`Ctrl+Alt+B` shows or hides the panel, and in a narrow window it
folds to a rail of status counts.

**Graph**, in the panel's header, opens the plan graph as a tab, since its
columns need the width of the middle. Each column is a *stage*: the tasks
whose dependencies all sit in earlier columns, so work reads left to right. The
strip above the columns shows each stage's status and jumps to it. The wheel
scrolls up and down; `Shift` and the wheel, a sideways swipe, or the ‹ and ›
buttons move one stage at a time. There is nothing to drag. Click a card to
open its task and light up its dependencies; **Compact** fits more on screen,
and **Critical path** marks the longest chain of unfinished work. Subtasks
and child plans fold into their parent with a count.

### Sessions

The first activity on the left. **Needs you** is at its head, across every
live session in this workspace, with each item's first answer one click away.
Below it are this workspace's sessions, newest first, each with its goal and
status, and a mark when another host holds it. **+** starts a new session.

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
a stash; and fetch, pull and push the current branch to its tracking remote.
Branches and History share the sidebar: pressing a branch shows its history
there in place of the list, leaving your checkout and the open tabs as they
were, and a commit opens in a tab with its message and files, each file's patch
a tab beside it.

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
| `⌘O` / `Ctrl+O` | Open a folder |
| `⌘⇧N` / `Ctrl+Shift+N` | New window, from the File menu: the welcome window |
| `⌘1`–`⌘4` / `Ctrl+1`–`Ctrl+4` | Sessions, Explorer, Changes, Git |
| `⌘,` / `Ctrl+,` | Settings |
| `⌘B` / `Ctrl+B` | Show or hide the sidebar |
| `⌘⌥B` / `Ctrl+Alt+B` | Show or hide the Plan panel |
| `⌘L` / `Ctrl+L` | Bring the planner tab forward and focus its composer |
| `⌘⇧G` / `Ctrl+Shift+G` | Open the plan graph |
| ``Ctrl+` `` | Show or hide the terminal panel |
| `⌘⇧A` / `Ctrl+Shift+A` | Open Needs you |
| `⌘⇧⏎` / `Ctrl+Shift+Enter` | The primary action, with its confirm |
| `⌘W` / `Ctrl+W` | Close the tab (never the planner's) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next or previous tab |
| `⌘\` / `Ctrl+\` | Split the editor |
| `⌘S` / `Ctrl+S` | Save, in your checkout |
| `⌘⏎` / `Ctrl+Enter` | Commit, in the commit box |
| `F7` / `Shift+F7` | Next or previous change, in a diff |
| `Esc` | Close a popover, peek, drawer or dialog |
| `F6` / `Shift+F6` | Move focus to the next or previous part of the window |
| `⌘⇧W` / `Ctrl+Shift+W` | Close the window, from the File menu |

In the graph, the arrow keys move along the edges: left to a dependency, right
to a dependent, up and down within a stage; `Home` and `End` go to the first
and last stage, and `Enter` opens the task. Every control is
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
recent workspaces are in its user-data folder, which Electron names after the
package rather than the product: `~/Library/Application Support/@ordewell/desktop`
on macOS, `%APPDATA%\@ordewell\desktop` on Windows and
`~/.config/@ordewell/desktop` on Linux.

If a build from this repository misbehaves, `npm run ci` runs what CI runs,
including the offline end-to-end walk of the app, and says which step failed.
