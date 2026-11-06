---
status: accepted
amends: ["0063", "0048"]
note: "scripts/sea/build.mjs builds the binary; scripts/install/cli.sh installs it; the release workflow builds it on four native runners and attaches it. Windows stays on npm."
---

# 0065 — The CLI and TUI also ship as a standalone Node binary, installed by one command

## Problem

Ordewell's CLI and TUI are an npm package. A Linux or macOS user who wants to
try it needs Node.js first, at a version new enough for `node:sqlite` and the
TUI's mouse and paste handling, and then `npm install -g`. That is a step the
desktop app ([ADR-0063](0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md))
already spares its users: it ships its own runtime and a one-line install. The
people who install the CLI are the ones least likely to have the right Node, and
the first thing they meet is a runtime error or a version lecture.

A binary is hard to reverse. It fixes the runtime Ordewell embeds, how the
daemon is started when there is no `node` to run, where the files the daemon
reads from disk live, and which names a release publishes and a package manager
points at. It is surprising without context: the CLI spawns *itself* as the
daemon, and the release's one `SHA256SUMS` is written by a job that waits for
two builds.

## Decision

**The CLI and TUI also ship as a Node single executable application (SEA) for
darwin-arm64, darwin-x64, linux-x64 and linux-arm64, installed with `curl -fsSL
https://ordewell.ai/install.sh | sh` or `brew install ordewell/tap/ordewell`,
and needing no Node.js; `npm install -g ordewell` and `npx ordewell` are
unchanged.**

The binary is the same program as the npm package, not a second product. The
daemon, the TUI, the version check and every command behave as they do under
Node. The npm packages' tsup builds are not touched. Windows stays on npm for
now: the SEA matrix, the installer and the formula are macOS and Linux, and the
Windows host of the raw-mode TUI ([ADR-0010](../platform/0010-windows-support.md))
is already served by `npm`.

## Key properties

- **One embedded Node, 22.17 or newer, a separate build, a native runner per
  target (C1).** `scripts/sea/build.mjs` bundles the CLI, the TUI and the web
  server into one self-contained CommonJS file and injects it, with the assets
  of C3, into a copy of the Node executable of the build host. The embedded Node
  is a 22.x at 22.17 or newer, matching `.nvmrc` and CI: it carries `node:sqlite`,
  which OpenCode Go's store needs (22.16 and up), and the TUI's mouse and paste
  fix. Each target is built on a runner of its own OS and architecture, because
  the injected executable is that runner's Node. The npm packages' builds and
  their `engines` are unchanged, so the npm path still runs on the Node range it
  declares.

- **The daemon is the binary itself (C2).** A hidden `__daemon` subcommand runs
  the web server in the calling process (`runDaemon` in
  `packages/web/server/daemon.ts`). Where the CLI used to spawn `node <server
  file>`, it spawns its own executable with `__daemon` whenever `isSea()` from
  `node:sea` is true. Port, token, pid file and the version handshake
  ([ADR-0063](0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)
  H3) are unchanged. The subcommand is
  not listed in help and is not a supported interface.

- **Runtime files are embedded and extracted once per version (C3).** Core
  reads `skills/` and `docker/` from disk, and a SEA has no package directory.
  The build embeds them as assets: a `runtime/manifest.json` and
  `runtime/<path>` for each file. On first use the binary extracts them to
  `~/.ordewell/runtime/<version>/` and the paths core reads point there. The
  version is read from the manifest, not from a `package.json`, which the binary
  does not have, so an upgrade extracts a new directory beside the old one and a
  running older binary keeps its own.

- **macOS binaries are signed again after injection (C4).** Injecting the
  bundle (postject) invalidates the signature the Node executable carried, and
  an arm64 macOS binary that is unsigned will not run. The build therefore
  re-signs every macOS binary: with the Developer ID, the hardened runtime and
  notarization when the signing and notarization credentials of
  [ADR-0063 H9](0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)
  exist for the release, and ad hoc otherwise. Linux binaries are not signed.
  The credentials are the desktop app's, read the same way and only on the
  release path.

- **Assets named for the OS and architecture, all in the one `SHA256SUMS`
  (C5).** The release attaches `ordewell-<version>-<os>-<arch>.tar.gz` and a
  fixed-name copy `ordewell-<os>-<arch>.tar.gz` for each target, so
  `releases/latest/download/<name>` always resolves, and attaches
  `scripts/install/cli.sh` as `install.sh`. The archive holds the executable and
  keeps its mode bit. A job in `release.yml` writes the single `SHA256SUMS`
  over the desktop installers, the CLI archives and `install.sh` after both the
  desktop and the CLI builds have attached their files, and uploads it last, so
  a release that has the file has everything it lists. Whoever installs checks
  the SHA-256 against that file from the same release; as in
  [ADR-0063 H10](0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)
  it proves the download is whole, and signing is what proves who made it.

- **`https://ordewell.ai/install.sh` is a redirect to the release's own
  installer (C6).** The ordewell.ai Worker answers with a redirect to
  `https://github.com/ordewell/ordewell/releases/latest/download/install.sh`.
  The script is the one in the product repository, attached to the release it
  installs, so the URL a user pipes into `sh` and the archives it fetches come
  from one release and one repository.

- **The installer does one thing, in the user's directory (C7).**
  `scripts/install/cli.sh` downloads the fixed-name archive over https, checks
  it against `SHA256SUMS`, stops on a mismatch before anything is written, and
  installs `~/.local/bin/ordewell` (`ORDEWELL_INSTALL_DIR` moves it), with no
  sudo. It reports whether `git` is present (recommended, not required) and
  which coding agents it finds, and installs neither. It lowers no OS protection, as the
  desktop installers do (ADR-0063 H10).

- **A Homebrew formula, and the desktop cask under its own name (C8).** A
  formula `ordewell` (`Formula/ordewell.rb` in `ordewell/homebrew-tap`) installs
  the CLI archive on macOS and on Linux, since Homebrew on Linux installs
  formulae and casks are for macOS apps. It is rendered from the release's
  version and `SHA256SUMS` like the other manifests and published whenever
  `HOMEBREW_TAP_TOKEN` exists. Unlike the cask it does not wait for a notarized
  build: the macOS binary is signed either way (C4), and the formula installs a
  command-line tool, not an app bundle Gatekeeper checks on launch. The
  desktop cask is named `ordewell-desktop` (`Casks/ordewell-desktop.rb`, the
  `BIN_NAME` of the desktop installer), and still publishes only from a
  notarized build, as
  [ADR-0063 H11](0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)
  says.

- **The update notice names how this copy was installed (C9).** The line
  [ADR-0048](../platform/0048-a-daily-version-check-with-a-notice-first-and-one-install-per-machine.md)
  prints says `brew upgrade ordewell` for a Homebrew install, to run the
  installer again for another binary install, and `npm i -g ordewell` otherwise.
  The request, the notice, the off switches and the state file are unchanged.

## Testing decisions

The build and the installer are tested at their seams: `scripts/sea/build.mjs`
on a real target is the proof that the binary starts, and the offline end-to-end
driver runs the built binary through its own daemon with no Node on `PATH`.
`scripts/install/cli.sh` is tested offline against files standing in for the
release, with a wrong checksum as the case that must stop. The daemon launch and
the asset extraction take `isSea()` and the runtime directory as inputs, so
their unit tests run under plain Node.

## Out of scope

- A Windows binary, a Linux package repository, `scoop` and winget for the CLI.
  Windows installs from npm.
- Self-update of the binary. The notice tells the user which command updates it.
- Running the binary as the desktop app's daemon. The app keeps spawning its
  own Electron-hosted one (ADR-0063).

## Considered options

- **Bun's compiled executables.** Rejected: core loads `node:sqlite` for
  OpenCode Go's store (`openCodeCredentials.ts`) and the TUI's raw-mode and
  mouse handling ([ADR-0010](../platform/0010-windows-support.md)) are measured
  on Node. A different runtime would be a second place for both to differ.
- **Reusing the desktop app's Electron as Node.** Rejected: it needs the
  `runAsNode` fuse on, which ADR-0063 turns off on purpose, and it would make a
  terminal tool carry a browser.
- **A `pkg`-style packager.** Rejected: `vercel/pkg` is deprecated and its
  repository archived (last release 5.8.1; its README points to Node's SEA),
  and any packager that patches Node itself is one more thing to rebuild for each
  Node release. The SEA mechanism is Node's own and rides the pinned release.
- **One build that cross-injects every target.** Rejected: a SEA is a copy of
  the Node executable of the host, so it would embed the wrong binary or need
  each target's Node downloaded and trusted separately. A native runner per
  target needs neither, at the cost of four jobs.
- **A raw binary as the release asset instead of a tar.gz.** Rejected: the
  archive keeps the executable bit and is the shape a formula expects.
- **A second sums file for the CLI.** Rejected: two files would each cover part
  of a release, and the installers, the formulae and the manifests would have to
  know which to read. One `SHA256SUMS` over everything is one thing to verify.
- **Writing `SHA256SUMS` in each build.** Rejected: a desktop or CLI build can
  only list what it made. The file is written once, by a job that runs after
  both have attached their files.
- **A copy of the install script in the website.** Rejected: it would drift from
  the product repository, and the script would not be the one the release's
  archives were made for. The Worker redirects instead.
- **Keeping the cask named `ordewell`.** Rejected: it would clash with the
  formula's name in the same tap. `ordewell-desktop` matches the installer's
  `BIN_NAME`.
- **The binary for Windows too.** Deferred, not rejected: the TUI's Windows
  behaviour has its own measured quirks (ADR-0010), and npm works there today.

## Consequences

- Four more jobs build every release, each on its own runner, and a failure in
  one leaves the release without `SHA256SUMS` until the job is re-run, since
  that file is written last.
- The npm package and the binary can run different Node versions: the npm
  `engines` range stays as it was, and the binary carries a 22.x of its own.
  Code may not assume the Node a user installed is the Node it runs on.
- A new file core reads from the package directory must be added to the
  embedded assets, or the binary fails where `npm` does not.
- `~/.ordewell/runtime/<version>/` grows by one directory per version a user
  runs; nothing removes the old ones.
- A macOS binary re-signed ad hoc is not notarized: notarization is what
  settles Gatekeeper, as it does for the app.
- The desktop cask's name changes, so a Homebrew user of the app reinstalls it
  under `ordewell-desktop`.

## History

- 2026-11-06 — accepted.
