<!--
Thanks for the pull request. Keep the diff to one concern — a PR doing two
things takes more than twice as long to review.
-->

## What this changes

<!-- One or two sentences. If it fixes an issue, write "Fixes #123". -->

## Why

<!-- The problem, not the patch. If it contradicts an ADR in docs/adr/, say
     which one and why the trade-off should change. -->

## How it was verified

<!-- What you actually ran. "Tests pass" is less useful than "added a failing
     test for X, confirmed it fails before and passes after". -->

## Checklist

- [ ] `npm run lint && npm run typecheck && npm test` passes
- [ ] Comments explain *why*, not *what*, and match the density of the surrounding file
- [ ] No new `any`
- [ ] User-visible changes are noted in `CHANGELOG.md` under Unreleased
- [ ] No quantified performance or cost claims added to user-facing text
