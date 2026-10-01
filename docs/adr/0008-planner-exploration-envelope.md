# 0008 — The planner's exploration envelope: tiered commands, confined paths, one approval seam

**Status:** accepted

See also [ADR-0011](0011-sandboxing-the-planners-shell.md): the classifier
below is a denylist over a real shell, not an OS-level sandbox for it. That
ADR runs the planner's shell under the same kind of OS sandbox Codex already
requires for itself, beneath the classifier, where the platform has one.

Planner research was tightly boxed by a `bash` denylist (`BaseFileSystem`) that matched **substrings** against the raw command string: allowlisted binaries only, no pipes, no `&&`, and a forbidden-pattern list containing `rm`, `cp`, `kill`, `>`, `|`. It was simultaneously too strict and too loose.

Too strict: `az`, `gh`, `npm test`, `pytest`, `kubectl`, `jq` — everything a planner might legitimately run to *diagnose before planning* — were refused outright, so the model's only recourse was to guess. Too loose in the other direction: `ls docs/removed` tripped `rm`, `git show HEAD:src/kill.ts` tripped `kill`, and substring matching cannot see `$(rm -rf /)` at all.

Meanwhile paths were not confined at all. `PoolFileSystem.resolve()` was `path.isAbsolute(p) ? p : path.resolve(root, p)`, so `read_file("/etc/passwd")` worked with no prompt and no record, while `glob`/`grep` were pinned to the workspace `cwd` and could not be pointed outside even when the user explicitly named an external file. The dangerous capability was ungated and the useful one was unavailable.

`IWebFetcher` had no implementation in any surface, so the `fetch` tool was declared to every planner and always answered "not available in this environment."

## Decision

**One approval seam** (`IApproval`), with three capability tiers layered on top of it.

`bash` classification moved to `commandPolicy.ts`, which lexes the command the way a shell would — consuming quotes and backslashes, so only *unquoted* metacharacters are operators — splits it into segments (pipes, `&&`, `;`, and `$(…)`/backtick substitution) and classifies **per segment**:

| tier | behavior |
|---|---|
| `auto` | read-only inspection — runs with no prompt (the historical allowlist, widened with `rg`, `find`, `jq`, `tail`, …) |
| `ask` | anything else not obviously destructive — one approval, remembered at `scope` granularity for the session |
| `refuse` | writes, privilege escalation, output redirection, piping into an interpreter, inline `-c`/`-e` code — never runs, never prompts |

`refuse` is deliberately **not promptable**. A planner that can `rm` is a planner that can silently break the workspace it was asked to reason about, and this repo's thesis already puts mutation in the runners.

Path confinement moved into `BaseFileSystem` as template methods: every public method resolves and authorizes before delegating to an adapter `*Impl`, which therefore only ever receives an absolute, approved path. Out-of-workspace access is an `ask`, scoped to the containing directory.

Both halves have to agree on what the shell will actually do with a string, or the confinement leaks. Three ways it did:

- **Quoting is the shell's, not ours.** Splitting on a bare `/[|;&]/` made `rg "error|warn" src` two segments — so the planner's commonest search asked for approval, scoped to the nonsense binary `warn"` — while leaving quotes on argument tokens hid `cat "/etc/passwd"` from the path check entirely (`looksLikePath('"/etc/passwd"')` is false). One lexer now owns both answers.
- **`~` is expanded because the shell expands it.** `path.resolve(root, '~/.ssh/id_rsa')` yields `<root>/~/.ssh/id_rsa`, which reads as *inside* the workspace, so an auto-tier `cat ~/.ssh/id_rsa` passed confinement unprompted and then read the real file. `resolveWithin` expands `~` before resolving.
- **A path is anything that climbs, not only what starts with `../`.** `looksLikePath` recognised a relative path by its first characters, so `cat src/../../etc/passwd` — which the shell resolves through a directory that exists — was a plain name to the check and read the file unprompted. An argument with a `..` segment anywhere is now a path (2026-09-27).

`ApprovalPolicy` decides and remembers; `PendingApprovals` parks the promise; `Session` announces on the **existing broadcast seam** and exposes `resolveApproval(id, granted)`. Every surface answers through that one call.

## Key properties

- **Grants are scoped, not per-call (T1).** Approving `/tmp/dump/a.log` grants `/tmp/dump/*`; approving `az group list` grants `az group list`, derived for known multiplexers from the binary plus the leading non-flag arguments before the first flag, capped at two. Per-call prompting would make real research unusable, and users would reflexively approve.

  *Amended 2026-08-11 (0.4.9).* The scope was originally the binary plus its **first** non-flag argument, which collapsed distinct operations onto one grant: `npm run <script>` scoped to `npm run`, so approving the project's test script pre-authorised every other script in the workspace manifest — attacker-authored on an untrusted repository — and `az group list`/`az group delete` and `aws s3 ls`/`aws s3 rm` each shared a grant across a read and its destructive sibling. Walking stops at the first flag so a flag's value never enters the scope, which keeps a log-style invocation one stable grant rather than a fresh prompt per limit; the cost is that a leading flag empties the lead (`mvn -q test` scopes to `mvn`), accepted deliberately.
- **Denials are remembered too (T2).** A model that retries a blocked lookup burns one tool round instead of re-prompting the user each time.
- **One in-flight ask per scope (T3).** Parallel tool rounds cannot raise two prompts for the same thing.
- **Nothing in core knows which UI is listening (T4).** Requests ride the same `SessionMessage` broadcast as every other planner event. VS Code answers in-process via `INotification.confirm`; the CLI and TUI answer over `POST /api/approvals/:sessionId/:approvalId`. A prompt outlives the socket that announced it, which is why answers are HTTP rather than a socket reply.
- **Absent is denial, everywhere (T5).** No approval channel wired, a dismissed modal, an empty CLI answer, a malformed request body, a five-minute timeout — all deny. The timeout is load-bearing, not defensive: an unanswered prompt would otherwise hang the research loop with no visible cause.
- **Research subagents can never prompt (T6).** They run in the background with nobody watching, so `nonPromptingFs` refuses at the capability boundary — auto-tier commands still work, anything that *would* ask is refused with a message telling the agent to report the gap in its digest. Enforced by wrapper, not by prompt instruction.
- **Session boundaries are hard (T7).** `Session.reset()` clears granted scopes. A path approved for one goal is not approved for the next, consistent with the rest of the session-isolation rules.

## Visibility: the outcome is data, not a string to re-parse

An envelope only works if the user can see it working. The original render path
flipped a `✓` for every settled call, so a refused `rm`, a denied out-of-workspace
read, and a successful `grep` were indistinguishable in all three UIs — and a
whole round dropped at the tool-budget boundary appeared never to have happened
at all.

`ResearchStep` therefore carries `success`, an `outcome`
(`success | failure | refused | denied | not_executed`), and the model's
`toolCallId`. `classifyOutcome` in `researchStepSummary.ts` owns the refusal and
denial signatures, next to the human summary the same surfaces already share, so
no UI pattern-matches refusal text of its own. Over-budget calls are reported as
`not_executed` steps rather than dropped.

- **The tool_call id is load-bearing, not decorative.** Read-only tools now run
  as a parallel round (`executeToolCalls`), so several calls to the same tool are
  in flight at once and results return in any order. Matching a result to its
  pending line by tool *name* — what every surface did — put one file's body on
  another file's row. Matching is by id, with the name scan surviving only for
  calls that announced no id.
- **Each surface renders it in its own idiom, from the same fields.** VS Code
  gives each call an icon plus a chevron to its output; the TUI appends one
  transcript line per call and settles it in place, counting the rest of a
  parallel round on the spinner; `ordewell plan` — the only audit log a piped or
  CI run leaves — prints the issued call and then the outcome line. Reasoning is
  behind `--verbose` there, and on the TUI status row, because it is the noisiest
  part of the stream.
- **Runner output reaches the VS Code task card.** `task_output` was dropped by
  `handleSessionMessage`, so a task that failed mid-run showed a red card and
  nothing else. The webview keeps a per-task tail and clears it on every session
  boundary, like the rest of the webview state.

## Search quality, fixed alongside

Three defects were structural rather than incidental, so they are recorded here:

- **`--max-count` is per file, not global.** `rg --max-count 100` over 300 matching files returned ~30 000 rows, exceeded the 1 MB exec buffer, threw `ENOBUFS`, and surfaced as `{ success: false, output: '' }` — a silent empty result on exactly the broad searches where the model most needed a signal. The cap now applies at the row level after the fact (`applyHeadLimit`), and truncation is stated in the output rather than implied.
- **Arguments are a list, never an interpolated string.** The old `"${pattern.replace(/"/g,'\\"')}"` escaped only double quotes, so a pattern containing a backtick or `$(` was command injection through the planner's own search box. Everything now goes through `execFile` with an argv array.
- **`glob` excluded `node_modules`/`dist`/`.ordewell`; `grep` excluded nothing.** Both now share `SEARCH_EXCLUSIONS`, and both sort by recency (`--sortr modified`) — with a hard result cap, *what gets dropped* is the result quality.

`find_symbol` was added rather than extending `grep`: searching for a named symbol returns every import and call site, so with a 100-row cap the definition frequently fell outside the returned page. It runs two bounded searches (definitions, then per-file reference counts) using language-aware declaration patterns.

## Considered options

- **Widen the `bash` allowlist (M1).** Rejected: it fixes the too-strict half and leaves the substring matching, the invisible `$(…)`, and the ungated path escape untouched.
- **opencode-style LSP for structural lookups (M2).** Rejected. Its `packages/opencode/src/lsp/` is ~98 KB across 6 files, and `server.ts` is a toolchain installer — `go install gopls`, `gem install rubocop`, `dotnet tool install`, GitHub release downloads for zls/clangd/rust-analyzer — plus per-server initialize handshakes and index waits. `@ordewell/core` has three dependencies and is pinned as "pure TypeScript, zero UI deps"; making *planning*, the deliberately cheap half of the architecture, slower to start is the wrong trade. A planner needs to scope tasks ("defined here, used across ~14 files in 3 packages"), not prove rename-safety — that is the runner's job, and runners have their own tools.
- **tree-sitter in-process (M3).** Rejected: per-language WASM grammars plus hand-written queries, a real dependency in a three-dep core, to get definitions that regex or optional `universal-ctags` already provide adequately.
- **TypeScript compiler API only (M4).** Rejected despite `typescript` already being a devDependency and giving genuinely precise results: it covers TS/JS only. A planner that is sharp on TS repos and blunt everywhere else is worse than one that is consistent.
- **Answer approvals over the WebSocket (M5).** Rejected: the CLI and TUI already speak HTTP to the daemon, a prompt can outlive the socket that announced it, and a plain POST is answerable from any surface — including `curl` when debugging.
- **Prompt per exact command rather than per scope (M6).** Rejected as the default (T1). opencode parses commands with tree-sitter and asks per command pattern; that precision costs a grammar dependency, and for a read-mostly planner whose destructive verbs are already hard-refused, binary-plus-leading-arguments is the useful granularity.

## Amendment (2026-09-27) — words the shell computes

A review of `commandPolicy.ts` found five more places where the classifier read
a different command from the one the shell runs. Each is closed by narrowing,
under the rule the file already applied to `eval` and assignments: what the
classifier cannot read is refused, and an argument it cannot see into prompts.

- **A computed command name is refused.** `$(printf rm) -rf build` lexed to an
  empty first word, and a segment without a binary was dropped before
  classification, so only the inner `printf` was judged — `rm` ran as `auto`.
  Substitutions now stay in their word as written, and a command name holding a
  substitution, a `$` expansion or a brace list is refused.
- **A computed argument prompts.** `cat $(printf /etc/passwd)`, bash's
  `$'…'`/`$"…"` quoting, special parameters (`$0`, `$@`) and brace lists
  (`cat {,/etc/passwd}`) hid a path from confinement the way `cat $x` did, and
  now take the same prompt path. Brace expansion is read even though Linux's
  `/bin/sh` is dash: on macOS, Fedora and Git for Windows it is bash.
- **`|&` is a pipe.** Read as `|` and a separate `&`, it dropped the next
  stage's pipe, so piping into an interpreter was only asked about.
- **A value glued onto a short flag is confined.** `grep -f/etc/passwd` skipped
  the path check that `grep -f /etc/passwd` gets.

## Amendment (2026-09-28) — command runners, and programs inside filters

The refusal tier rests on one premise: a destructive verb never reaches `ask`,
because `ask` is remembered at `scope` granularity and one approval would
cover every later use. Wrappers (`env`, `nice`, `timeout`, …) were already
unwrapped for that reason. Commands that *run* another command were not, and
nor were the filters that carry a program, so the premise had four holes, each
classified as `ask` with a binary-wide scope:

- `xargs rm < list`, `xargs -a list rm` — `xargs` was refused only when piped
  or given `-c`/`-e`.
- `parallel`, `watch`, `flock`, `script`, `chroot`, `unshare`, `strace` and
  their kind were unknown binaries, so the command they run was an unexamined
  argument.
- `awk 'BEGIN{system("rm -rf x")}'`, `print | "sh"`, `"cmd" | getline`,
  `print > file`.
- `sed '1e rm x'`, `sed 's/x/y/e'`, and the `w`/`W` commands and `w` flag that
  write a file.

Closed as follows, under the file's existing rule: when unsure, refuse.

- **A runner whose command is a plain argv is unwrapped; one that hands it to a
  shell is refused.** `xargs` is the one runner unwrapped: its flags are walked
  like a wrapper's (an unknown flag refuses) and the command it runs is
  classified by the same machinery. `parallel` (a shell-evaluated template),
  `watch` (joins its arguments for `sh -c`), `script`, `sg`, `flock` (creates
  its lock file when missing — the write `touch` is refused for — and runs a
  string under `-c`), `chroot`, `unshare`, `nsenter`, `setpriv`, `runuser`,
  `pkexec`, the tracers and debuggers, and the scheduling and sandbox runners
  (`taskset`, `systemd-run`, `bwrap`, …) are refused.
- **A runner is never `auto`, and its scope includes the inner command.**
  `xargs grep foo < list` prompts as `xargs grep`, so an approval never covers
  `xargs cat`, let alone `xargs rm`.
- **What `xargs` may run is an allowlist.** `xargs` appends arguments it reads
  at run time, after everything the classifier sees, so the inner command is
  only as safe as the worst argument it could be handed: `xargs sh < list`
  runs `sh -c …` if the list says so, `xargs env < list` runs whatever the list
  names, `xargs rg foo < list` takes `--pre`. Only read-only binaries with no
  argument that runs a program or writes a file (`grep`, `cat`, `head`, `wc`,
  `ls`, …) may run under it. Piping into `xargs` stays refused.
- **sed and awk programs are read.** A small parser for each finds the
  commands above, and refuses a program it cannot read — including one loaded
  from a file (`-f`), one the shell rewrites first, and a construct GNU and BSD
  sed, or gawk and the one-true-awk, would end in different places. Plain
  printing, substitution and field work stay on the prompt tier.
- **The word after `<` is a file, not an argument.** It was lexed as an
  argument, and it can come first, so `< cat rm x` classified as an auto-tier
  `cat` while the shell ran `rm x`. Input redirect targets are now kept apart
  from the arguments and still handed to path confinement.

The residual is the one `ask` always had: an approved `xargs grep` reads
whatever files its input lists, outside the workspace included, because the
arguments are not visible to confinement. That is why it prompts.

## Amendment (2026-09-29) — the seam also carries runner tool requests

The approval seam (`IApproval` / `PendingApprovals` / `resolveApproval`) now
also carries a task runner's tool requests under the structured transport, as
kind `runner_tool` ([ADR-0018](0018-structured-runner-transport.md)). They have
no timeout: T5's five-minute auto-deny is the planner's, where an unanswered
prompt would hang a research loop; a task's request waits for a person. The
planner's envelope is unchanged.

*Added 2026-09-29 (#56).* `resolveApproval` takes the whole decision — allow,
allow for this task, or deny with a note — and a boolean still answers a
planner prompt exactly as before. A turn's abort and a plan change deny only
the planner's own prompts; a runner's is denied when its attempt's runner
stops.
