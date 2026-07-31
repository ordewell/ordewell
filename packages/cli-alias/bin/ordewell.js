#!/usr/bin/env node
// `ordewell` is an alias for `@ordewell/cli`, which holds all of the code. It
// exists so `npm i -g ordewell` and `npx ordewell` work. Requiring the entry
// point runs it in this process, so argv, stdio and the exit code all pass
// straight through — a spawn would break the TUI's raw-mode terminal.
//
// The dependency is pinned exact, so the two versions never drift.
require('@ordewell/cli');
