# @ordewell/desktop

Ordewell's desktop app for **[Ordewell](https://ordewell.ai)**: an Electron
window that shows a plan, its tasks and their diffs, the planner beside them,
and your own repository — files, diffs, git and a terminal.

It is a **client of the local daemon**, not a host. The daemon
([`@ordewell/web`](../web/README.md)) runs the session and holds its lease, so a
run started here is the one `ordewell status` reports
([ADR-0063](../../docs/adr/surfaces/0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)).
Main attaches to a daemon that is already running or starts and owns the one it
bundles. The renderer never holds the bearer token: it reaches the daemon only
through the preload's fixed bridge, and daemon calls name a route id rather than
a URL.

You almost certainly do not need to build this package: each release attaches
the installers. To use the app, see the
[desktop guide](../../docs/desktop/README.md); the design is
[design.md](../../docs/desktop/design.md).

## Opening projects from a terminal

Launched with a folder, the app opens it as `code <folder>` does: in a window of
its own, or by focusing the window it is already open in. A relative folder is
read against the directory you launched from, and `--new-window` opens the
welcome window instead. When the app is already running, the launch hands its
folder over to it. A launch that names neither reopens the projects that were
open when the app last quit (Settings → This app → *Reopen projects on
launch*), or the welcome window.

- **Linux.** The deb links `ordewell-desktop` into `/usr/bin`, and the install
  script puts the AppImage at `~/.local/bin/ordewell-desktop`:
  `ordewell-desktop ~/code/acme`.
- **macOS.** `open -na Ordewell --args ~/code/acme`, or `--args --new-window`.
  `-n` starts a launch even when the app is running, which hands its arguments
  over and exits. Give the folder as an absolute path: `open` starts the app in
  `/`, not in your directory.
- **Windows.** The installer adds nothing to `PATH`; run the executable from
  where it was installed, by default
  `& "$env:LOCALAPPDATA\Programs\Ordewell\Ordewell.exe" C:\code\acme`.

The app icon's menu offers *New Window* too: the Dock menu on macOS, the jump
list on Windows (installed app only), and the launcher entry's right-click on
Linux, which runs the app with `--new-window`.

## Build and run

```bash
npm install                                   # from the repository root
npm run desktop:dev                           # Vite + Electron, renderer hot reload
```

`desktop:dev` and `desktop:package` first rebuild `@ordewell/core`, `ui` and
`web` ([`scripts/workspace-builds.mjs`](scripts/workspace-builds.mjs)): the
daemon and the UI come from their `dist/`, and one left from an older checkout
would run under a current app with nothing to tell them apart.

A change to `src/main` or `src/preload` needs `desktop:dev` restarted; a change
to `src/renderer` reloads in place. To run the built app instead:

```bash
npm run build
npx electron packages/desktop
```

`ORDEWELL_DESKTOP_DEV_URL` points an unpackaged app at a dev server. A packaged
app ignores it: a build that read it could be pointed at any page with the
bridge on.

## Package

```bash
npm run desktop:package                 # installers for the current OS, in release/
npm run desktop:package -- --dir        # the unpacked app only
```

[`electron-builder.yml`](electron-builder.yml) holds the targets: dmg and zip
(arm64 and x64), an NSIS installer (x64), an AppImage and a deb (x64). Builds
are unsigned; macOS gets an ad-hoc signature so the fuses rewrite does not leave
an arm64 binary the OS kills on launch. Auto-update is wired and disabled
(`AUTO_UPDATE_ENABLED` in `src/main/updater.ts`) until signing exists.

`node-pty` is a native addon and is rebuilt by electron-builder for the app's
Electron, once per architecture. On Linux that needs `make`, `g++` and `python`.

## Tests

```bash
npm test                 # unit tests: main, renderer, both stores and the bridge
npm run test:desktop-e2e # the offline end-to-end walk, against bench/live's mock and fake runners
```

The end-to-end test launches the built app with Playwright's Electron support,
against `bench/live/mock-provider.mjs` and `bench/pipeline`'s fake runner, with
no API key and no network: it opens a workspace, plans, approves, runs, follows a
task into its worktree, sends a line comment, answers a checkpoint and merges
through the preflight. It runs once owning the daemon and once attached to a
daemon the CLI started. It needs a display; on a headless Linux box use
`xvfb-run`.

`node ../../scripts/desktop-package-check.mjs` runs after packaging in CI and
checks what a user actually installs: the installers by name, the daemon closure
unpacked beside `app.asar`, the fuses, and one shell through the packaged
`node-pty`.

## Marketing captures

Scripted stills and videos of the real app, for the site and store listings.
They are made by hand and never run in CI.

```bash
npm run build                                      # from the repository root, once
npm run marketing:capture -w packages/desktop
```

Prerequisites:

- Linux.
- Xvfb, from either:
  - the `xvfb` package, or
  - `ORDEWELL_X_RUNTIME`, set to a directory that the `xvfb` and `x11-xkb-utils`
    Debian packages were unpacked into. No root is needed. The comment at the
    top of `e2e/marketing/xrun.sh` explains how.

`xrun.sh` starts a private display (`:140` up, or `MARKETING_DISPLAY`) and stops
it by its PID. On any other OS it says so and stops.

The first run fetches a pinned static ffmpeg into the repository's `.tools/`,
pinned by `e2e/marketing/ffmpeg.json` and checksum-verified, as
`scripts/shellcheck.mjs` does. `ORDEWELL_FFMPEG` names another ffmpeg to use
instead. After that a run needs no API key and no network.

`e2e/marketing/harbor.capture.ts` is the shot list. Every shot is of Harbor
(`e2e/marketing/harbor.ts`), an invented TypeScript service:

- Its git history is real. Five invented people commit over three weeks, with
  a merged feature branch, a release branch and tag, a fix and a feature in
  flight, two stashes, and an origin two commits ahead of the local main.
- Its home holds three sibling projects and three earlier sessions.
- `e2e/marketing/mock-planner.mjs` answers the goal "Add rate limiting to
  sign-in, with tests and docs" with six tasks:
  - three parallel slices on Claude Code, Codex and GitHub Copilot CLI over ACP;
  - a script check whose failure OpenCode fixes in a check-and-fix loop;
  - a read-only review;
  - one checkpoint.
- The fake runners in `e2e/marketing/fakes/` do each task's work in its
  worktree and finish through `task_complete`, as the real runners do. They
  hold at named gates until the spec releases them, so a shot is taken at the
  moment it shows. Nothing outside this folder changes for them.

Harbor runs on the real clock, since a task's elapsed time is the daemon's.
The app is launched in a fixed-offset time zone where the capture's moment is
mid-afternoon, and everything seeded is dated back from that moment.

Everything lands in `marketing-out/`, which is gitignored:

| Path | What it holds |
| --- | --- |
| `stills/<view>[.<region>]--<theme>--<w>x<h>@2x.png` | The whole window, title bar controls included, or one region of it. Drawn at device scale factor 2, at 1440×900 and 1920×1080, in dark and light. |
| `videos/<name>--<theme>--<w>x<h>.mp4`, `.webm`, `.poster.png` | 30 fps. The MP4 is H.264 yuv420p BT.709 with `+faststart`; the WebM is VP9. The git take also has an optimised 960-wide GIF (palettegen/paletteuse). |
| `web/` | The website's set, under the names its pages use: `<view>.webp` and `<view>-light.webp` at 2560×1600, made from the 1440×900 stills; `hero.mp4`, `hero.webm` and `hero-poster.webp`, from a 1440×900 take; and `og.png` at 1200×630. |
| `web/masters/` | The lossless PNGs the web set was encoded from, for a later pass that fits the site's budget. |
| `manifest.json` | Every file with its view, theme, size, scale, pixels, bytes and duration. |

Every capture is pinned:

- The locale is en-US.
- A scenario on the page's own clock reads `MARKETING_CLOCK` as now, in UTC,
  so ages such as "2 hours ago" read the same on every run. Harbor takes the
  real clock instead, as above.
- A still has no caret, pointer or tooltip, its animations are settled, and it
  is grabbed until two grabs in a row match.

A video is recorded with a visible pointer and human-paced typing. It is then
cut, sped up, and faded in and out (`e2e/marketing/edit.ts`). A stretch played
faster always carries its speed badge.

Environment variables:

| Variable | Effect |
| --- | --- |
| `MARKETING_ONLY` | A comma list of the captures to run: `stills`, `hero` (its three takes), `hero-wide`, `hero-web`, `hero-square`, `git` and `queue`. |
| `MARKETING_OUT` | Writes somewhere other than `marketing-out/`. |
| `MARKETING_KEEP_MASTERS=1` | Keeps each take's lossless master, its cut and the speed badges. |
| `MARKETING_CLOCK` | The instant a page-clock scenario reads as now (an ISO date; `2026-03-17T14:30:00Z` by default). |
| `MARKETING_DISPLAY` | The X display number, in place of the first free one from `:140`. |
| `ORDEWELL_FFMPEG` | An ffmpeg to use in place of the pinned one. |
| `ORDEWELL_X_RUNTIME` | The unpacked Xvfb, where none is installed. |

## Layout

| Path | What lives there |
|---|---|
| `src/main` | Attach-or-own, the version handshake, the route table and token-holding proxy, windows, the tray and quit rules, terminals, updater |
| `src/preload` | The `window.ordewell` bridge, and nothing else |
| `src/renderer` | The frame (activity bar, tabs, panels, command palette), the views, and Monaco |
| `src/shared` | The bridge's types, the route table and the CSP |
| `e2e` | The offline acceptance test |

The components, view state, design tokens and host-neutral view assembly are
`@ordewell/ui`, shared with the VS Code webview; a component never knows which
host it draws in. The styles are semantic tokens only — a component never names
a colour.

## Licence and notices

Licensed under the [Apache License 2.0](./LICENSE). The copies of `NOTICE` and
`AUTHORS.md` here must match the repository root's, as every package's do
(`scripts/verify-notice.mjs`). `THIRD-PARTY-NOTICES.md` is generated from the
installed tree by `scripts/generate-third-party-notices.mjs desktop` on each
build, and the installer carries it beside Electron's and Chromium's own licence
files.

The name and logos are not covered by the licence; see [NOTICE](./NOTICE).
