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

## Build and run

```bash
npm install                                   # from the repository root
npm run build                                 # core first: the daemon and the UI come from dist/
npm run desktop:dev                           # Vite + Electron, renderer hot reload
```

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
