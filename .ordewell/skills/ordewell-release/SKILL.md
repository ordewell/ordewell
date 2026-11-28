---
name: ordewell-release
description: Attach to tasks that prepare, tag, publish or verify an Ordewell release; not to feature, fix or docs tasks.
applies-to: task
---

# Releasing Ordewell

Read [CONTRIBUTING.md](../../../CONTRIBUTING.md#releasing) first: it is the
source of truth, and it wins over this checklist. `.github/workflows/release.yml`
says what each publish job does. Do only the stages your brief asks for.

## Safety rules

- Never publish, push a tag, merge, or bump minor or major unless your brief asks.
  The default bump is a patch.
- npm versions are immutable. A bad version is never overwritten or reused.
- Never delete, move, force-push or re-push a pushed tag.
- On any failure, stop and report the step, the run URL and what is already
  published. Do not improvise a recovery.

## Prepare

1. `git fetch origin --tags`, then work on a `release/X.Y.Z` branch in a separate
   worktree from `origin/main`. Never use the user's checkout.
2. Confirm that tag `vX.Y.Z` and that version on npm do not exist yet.
3. Set every `package.json` to X.Y.Z, `packages/cli-alias` included. Internal
   `@ordewell/*` ranges are `^X.Y.Z`; `cli-alias` pins `@ordewell/cli` exactly.
   Update `package-lock.json` and the old version's mentions in READMEs and
   `SECURITY.md`; the previous `release:` commit shows which files changed.
4. Move the `[Unreleased]` entries under the new version and its date in
   `CHANGELOG.md` and in `packages/vscode/CHANGELOG.md`, which keeps only what a
   VS Code user sees.
5. Run `node .github/workflows/verify-release-tag.mjs vX.Y.Z` and the checks in
   AGENTS.md, then commit as `release: X.Y.Z`.
6. If this release signs the macOS CLI binaries, rehearse the signing as
   CONTRIBUTING.md describes.

## Merge and tag

1. Open the PR. Required checks must pass on its exact head SHA.
2. Merge it, then wait for main's push CI to pass on the merge SHA.
3. Check that the secrets CONTRIBUTING.md lists exist, by name only
   (`gh secret list`). A missing `OVSX_PAT` fails the run after npm and the
   Marketplace have published.
4. Create an annotated tag `vX.Y.Z` on that merge SHA, as prior releases did
   (`git cat-file -p <previous tag>`). Its message is the version's changelog
   notes, which become the GitHub Release notes. Pass `--cleanup=verbatim` so
   Markdown headings survive. Push only that tag.
5. Watch the `release.yml` run to its end. Read the job notices too: a skipped
   publish can leave the run green.

## Verify each channel

- **npm**: `npm view <name>@X.Y.Z version` for `@ordewell/core`,
  `@ordewell/web`, `@ordewell/cli` and `ordewell`.
- **GitHub Release** (`gh release view vX.Y.Z`): CLI archives, `install.sh` and
  `SHA256SUMS` are attached; desktop installers too when the repository variable
  `ORDEWELL_RELEASE_DESKTOP` is `true`. The highest version is marked latest.
- **VS Code Marketplace** and **Open VSX**: both list X.Y.Z for
  `ordewell.ordewell`. Listings can lag the job; say so if one does.
- **Homebrew**: `ordewell/homebrew-tap` carries X.Y.Z and the `homebrew-verify`
  jobs passed. Without a tap credential nothing is published. If only the tap
  publish failed, report it and name the `homebrew-publish.yml` workflow.
- **winget**: only with the desktop app and `WINGET_TOKEN`. Report the pull
  request on `microsoft/winget-pkgs` and its state. Submitted is not approved.

Report every channel as verified, pending, skipped (with the job's reason) or
failed. Never report one as published from a green job alone.
