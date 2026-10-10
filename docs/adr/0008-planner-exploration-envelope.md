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
| `refuse` | writes, privilege escalation, output redirection, piping or redirecting code into an interpreter, inline code in any spelling the interpreter accepts — never runs, never prompts |

`refuse` is deliberately **not promptable**. A planner that can `rm` is a planner that can silently break the workspace it was asked to reason about, and this repo's thesis already puts mutation in the runners.

Path confinement moved into `BaseFileSystem` as template methods: every public method resolves and authorizes before delegating to an adapter `*Impl`, which therefore only ever receives an absolute, approved path. Out-of-workspace access is an `ask`, scoped to the containing directory.

Both halves have to agree on what the shell will actually do with a string, or the confinement leaks. Three ways it did:

- **Quoting is the shell's, not ours.** Splitting on a bare `/[|;&]/` made `rg "error|warn" src` two segments — so the planner's commonest search asked for approval, scoped to the nonsense binary `warn"` — while leaving quotes on argument tokens hid `cat "/etc/passwd"` from the path check entirely (`looksLikePath('"/etc/passwd"')` is false). One lexer now owns both answers.
- **`~` is expanded because the shell expands it.** `path.resolve(root, '~/.ssh/id_rsa')` yields `<root>/~/.ssh/id_rsa`, which reads as *inside* the workspace, so an auto-tier `cat ~/.ssh/id_rsa` passed confinement unprompted and then read the real file. `resolveWithin` expands `~` before resolving.
- **A path is anything that climbs, not only what starts with `../`.** `looksLikePath` recognised a relative path by its first characters, so `cat src/../../etc/passwd` — which the shell resolves through a directory that exists — was a plain name to the check and read the file unprompted. An argument with a `..` segment anywhere is now a path.

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

## Words the shell computes

The classifier must judge the command the shell will run, not a different one
it reads. The rule, as for `eval` and assignments: what the classifier cannot
read is refused, and an argument it cannot see into prompts.

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

## Reading the line the way the shell does

Each of these reached `ask` or `auto` while the shell ran a refused command.
The fix in every case fails closed:

- **`!` is a keyword.** `! rm -rf src` negates the pipeline's status and still
  runs it; it is refused with the other keywords.
- **Substitution bodies are matched quote- and escape-aware.** A quoted or
  escaped `)` no longer closes `$(…)`, and `` \` `` inside backticks is a nested
  substitution. A here-document, a comment, or a `${…}` holding a quote, paren,
  escape or nested expansion inside `$(…)` refuses the line, since only a
  parser could find its end: `"$(ls ${x%)}; rm -rf ~)"` closed at the `)` of
  the pattern. Past 32 bodies the line is refused rather than judged on the
  bodies read so far.
- **`$'…'` is its own quoting.** A backslash escapes inside it, `\'` included,
  so `echo $'\''; rm -rf ~ #'` is an `echo` and an `rm`, not one `echo`. One
  left open refuses the line.
- **A here-document body is data.** Lexed as commands, a quote in the body hid
  the lines after the delimiter. The body is skipped to its delimiter line
  (`<<-` strips tabs) only when the `<<` is provably a here-document operator:
  an unquoted top-level word position, not inside a comment, a `${…}` or `$[…]`
  expansion, or `(( ))` arithmetic — where a `<<` is a shift the top-level lexer
  does not otherwise model. Where it is not provable, the following lines are
  lexed as commands instead; `(( ))` and an unreadable `${…}` refuse. An
  unquoted delimiter still expands the body, so its substitutions are
  classified. A here-document never closed, or a delimiter holding `$` or a
  backtick, refuses the line.
- **Stdin is a pipe for an interpreter.** `bash <<< '…'`, a here-document, and
  `sh < x.sh` hand the interpreter code exactly as `… | sh` does.
- **Inline-code flags are read in every spelling.** Clusters and glued code
  (`bash -lc`, `perl -lne`, `perl -e'…'`), `node -p`/`--print`, `php -r`,
  PowerShell's `-EncodedCommand` and any prefix of its code parameters, and
  `cmd /q/c`.
- **Inline code has more spellings than flags.** Interpreters are matched by
  family, so a versioned or suffixed name (`python3.12`, `node22`, `php8.2`,
  `python3.12m`, `python3.12-dbg`, `pwsh-preview`) or alias (`nodejs`) is one
  too; the suffix must start with a digit or `-`, so `nodemon` is not `node`.
  `deno eval`, a `data:` URL handed to `node`, `deno` or
  `bun` (`--import`, `--require`, `--loader`, a script operand), and
  PowerShell's positional command (`powershell Remove-Item x`) are refused.
  PowerShell's first argument passes only as a plain `.ps1` path — under
  `powershell`, only as the last argument, since the rest join its command —
  and a parameter it cannot place refuses.
- **cmd.exe ends a command name where it reads one.** `cmd/c del x` is `cmd
  /c`, `,del x` is `del`, and a command word starting with `/` (`cmd;/c del x`,
  where `;` is a space to cmd.exe) refuses. A command word that still holds a
  `/` or `=` is refused rather than read wrong: a drive-absolute path
  (`C:/Git/usr/bin/rm.exe`) or a quoted switch (`cmd"/c"`) would otherwise
  basename to the wrong name or collapse to the bare drive `C:`, and `del=x` is
  not a `NAME=value` assignment cmd.exe has no syntax for. `call` is unwrapped
  to the command it runs; `start` is refused, since its optional title and
  switches cannot be reliably told from the command.
- **Refusal reads names case-insensitively.** `DEL`, `Rd`, `CMD /c` and `RM`
  run on cmd.exe and on case-insensitive filesystems. The permitted tier stays
  exact-case, so a re-cased name never gains `auto`.
- **`NAME+=value` is an assignment**, so the command behind it is classified;
  `env` takes any word holding `=` as one.

## Command runners, and programs inside filters

The refusal tier rests on one premise: a destructive verb never reaches `ask`,
because `ask` is remembered at `scope` granularity and one approval would
cover every later use. Wrappers (`env`, `nice`, `timeout`, `command`, `builtin`, …) are unwrapped for
that reason, and so are commands that *run* another command and the filters
that carry a program. Before they were, the premise had four holes, each
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
- `enable -f lib.so name`, which loads a shared object into the shell and runs
  its code, as `source` runs a script. Refused; plain `enable` still asks.

How they are read, under the file's rule: when unsure, refuse.

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

## The seam also carries runner tool requests

The approval seam (`IApproval` / `PendingApprovals` / `resolveApproval`) also
carries a task runner's tool requests under the structured transport, as
kind `runner_tool` ([ADR-0018](0018-structured-runner-transport.md)). They have
no timeout: T5's five-minute auto-deny is the planner's, where an unanswered
prompt would hang a research loop; a task's request waits for a person. The
planner's envelope is unchanged.

`resolveApproval` takes the whole decision — allow,
allow for this task, or deny with a note — and a boolean still answers a
planner prompt exactly as before. A turn's abort and a plan change deny only
the planner's own prompts; a runner's is denied when its attempt's runner
stops.

## Patterns are not paths, and one command is one prompt

Path confinement must not read every `/`-leading argument as a file. When it
did, a search pattern (`grep "/api/users" src`), a `find -name`/`-path`/`-regex` value, a
`git log --grep`/`-S`/`-G` value, or a sed script or awk program prompted to
leave the workspace, and `curl -o /dev/null` asked for `/dev/*`. Each was a
prompt about nothing, and teaching people to approve `/dev/*` or `/api/*` to
get past them wears down the prompts that matter.

- **Patterns.** `pathLikeArgs` skips the arguments that are patterns or
  programs: the leading pattern of `grep`/`rg`/`git grep` unless a flag
  supplied one, the values of their pattern flags, `find`'s name tests, and the
  script or program `sedRefusal`/`awkRefusal` already locate. It fails closed:
  past a flag the binary's set does not declare, nothing is called a pattern,
  and a sed operand counts as a script only when no `-e` appears anywhere,
  because GNU sed then reads it as a file.
- **Inert devices.** `/dev/null`, `/dev/stdin`, `/dev/stdout` and
  `/dev/stderr` are not outside the workspace. The rest of `/dev` still asks.
- **One prompt per command.** A command's own approval and every outside
  directory it touches are one `ApprovalRequest`, with `scopes` listing each.
  The policy asks only about the scopes not already granted and grants each one
  separately, so a later command naming another directory still asks. A denial
  is remembered for that set of scopes together, not for each scope, since the
  answer may have been about any one of them.

None of this changes what is reachable. Every path argument is still confined,
and every grant still covers only its own scope.

## `cd` is followed where the shell's directory is certain

`cd api && git log && cd ../web && git log` stays inside the workspace, so it
must not prompt. Judging every path from the workspace root would read `../web`
as a sibling of the workspace, so confinement follows the `cd`s it can be sure
of.

- **A literal `cd` is `auto`** where nothing else on the line can steer it.
  One operand the command line spells out: no variable, substitution, glob,
  flag (`-P`, `-`), `~`, or second operand. Bare `cd`, `cd -` and `pushd` still
  ask. A line with a segment that runs no command — a bare `CDPATH=…`, a
  redirect alone — or a builtin that changes shell state (`export`, `set`,
  `shopt`, `source`, `eval`, the directory stack) can send a bare-name `cd`
  somewhere no argument names, so on such a line `cd` asks. With `CDPATH` set
  in the environment none of this applies.
- **A chain is followed only where it is certain.** Confinement resolves a path
  from the `cd` targets that must have run before it, and only when the command
  is commands joined by `&&` and `|`, each with a command name: a failed `cd`
  ends the list, so everything after it ran in the new directory. The lexer
  decides this as it reads each operator, not from the segments it keeps — a
  segment that never becomes a command can still carry the `||` or `;` that
  makes the shell's directory depend on what ran. Any `;`, `||`, `&`, newline,
  subshell, substitution, state-changing builtin or `cd` it cannot read stops
  following for the whole command. A `cd` inside a multi-stage pipeline runs in
  a subshell and is not counted.
- **The fallback never relaxes.** When nothing is followed, paths are judged
  from the root. That is never more permissive than the truth while every `cd`
  stays inside the workspace: a path with no net climb stays inside from any
  deeper directory, and a `cd` that climbs is itself a path argument and asks.
  Where a followed chain leaves the workspace, later paths are judged from there
  and ask under their own scopes.
- **A `cd` that asks is granted for its line only.** Its grant is the exact
  command, not `cd`, and so is the grant of a builtin that can move the shell
  (`pushd`, `popd`, `builtin`, the other state-changing builtins). Confinement
  did not follow it, so the paths after it were judged from the root; under a
  binary-name grant, approving `cd "$HOME"` would have approved
  `cd "$HOME" && cat .ssh/id_rsa`.
- **Symlinks stay lexical,** as in `pathScope.ts`: `cd link && cat ../x` is
  judged by name, not by where `link` points.

Research subagents use the same resolution, so a chain that stays inside the
workspace works for them and one that leaves it is refused, named by where it
resolves rather than as written.

## Harness planners and native plan files

Harness planners research inside this envelope too
([ADR-0026](0026-one-envelope-for-every-planner.md)): their commands run
through the Ordewell server's `run_command`, which is this file's `bash`, and
the Claude planner's own tool requests reach `IApproval`. Their native
permission controls must still preserve the no-mutation invariant; a native
plan file has no exception to it, inside or outside the workspace. Ordewell's
plan is submitted through its validated plan tools or reply envelope
(ADR-0022), not a runner-owned Markdown file.

Claude Code planners run in `default` mode with `--permission-prompt-tool
stdio`, with `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `KillShell`, `Bash`,
`PowerShell`, `EnterPlanMode` and `ExitPlanMode` disallowed. Direct file
research through `Read`, `Grep` and `Glob` remains available. The native shell
is withheld entirely: command-pattern denials cannot cover every spelling of a
write, and saved permission allow rules run commands without asking. Bare tool
denials take precedence over allow rules ([Claude Code permissions](https://code.claude.com/docs/en/permissions)).
The same fixed flags apply to fresh and
resumed planners, regardless of any task mode fields passed to the adapter.
Task runners retain their manifest-selected modes.

Native Claude plan mode is unsuitable for this boundary. Claude Code 2.1.295
blocks a disallowed `Write` but permits a Bash heredoc to its native plan file,
including under `CLAUDE_CONFIG_DIR` outside the workspace. `plansDirectory`
changes where that file goes; moving it into the workspace still violates the
no-mutation invariant. Denying the shell tools and the plan-mode transitions
closes that route independently of the native plan-file exception.

Codex planner threads use `sandbox: read-only` and `approvalPolicy: never`;
permission requests are declined. This is OS-level enforcement for agent
commands on supported hosts. Claude's tool denials are native CLI enforcement,
not an OS sandbox or a prohibition on the CLI persisting its own session data.

OpenCode's planner shell gap is closed by ADR-0026: its `bash` and `task`
tools are withheld, and its server runs under Ordewell's own permission
policy, which denies every write and shell tool. The plan agent's name and a
model's refusal to write were never security evidence.

## Considered options

- **Native Claude plan mode plus direct write-tool denials.** Rejected: its
  native plan-file exception reaches Bash even when `Write` is disallowed.
- **`dontAsk` alone, or a denylist of shell write patterns.** Rejected: saved
  allow rules still authorize commands, and command text has too many ways to
  express a write. Withholding shell tools is the accepted narrowing.
- **Redirect native plans with `plansDirectory`.** Rejected: relocation still
  grants the planner a filesystem write; Ordewell already owns the plan.
- **Widen the `bash` allowlist (M1).** Rejected: it fixes the too-strict half and leaves the substring matching, the invisible `$(…)`, and the ungated path escape untouched.
- **opencode-style LSP for structural lookups (M2).** Rejected. Its `packages/opencode/src/lsp/` is ~98 KB across 6 files, and `server.ts` is a toolchain installer — `go install gopls`, `gem install rubocop`, `dotnet tool install`, GitHub release downloads for zls/clangd/rust-analyzer — plus per-server initialize handshakes and index waits. `@ordewell/core` has three dependencies and is pinned as "pure TypeScript, zero UI deps"; making *planning*, the deliberately cheap half of the architecture, slower to start is the wrong trade. A planner needs to scope tasks ("defined here, used across ~14 files in 3 packages"), not prove rename-safety — that is the runner's job, and runners have their own tools.
- **tree-sitter in-process (M3).** Rejected: per-language WASM grammars plus hand-written queries, a real dependency in a three-dep core, to get definitions that regex or optional `universal-ctags` already provide adequately.
- **TypeScript compiler API only (M4).** Rejected despite `typescript` already being a devDependency and giving genuinely precise results: it covers TS/JS only. A planner that is sharp on TS repos and blunt everywhere else is worse than one that is consistent.
- **Answer approvals over the WebSocket (M5).** Rejected: the CLI and TUI already speak HTTP to the daemon, a prompt can outlive the socket that announced it, and a plain POST is answerable from any surface — including `curl` when debugging.
- **Prompt per exact command rather than per scope (M6).** Rejected as the default (T1). opencode parses commands with tree-sitter and asks per command pattern; that precision costs a grammar dependency, and for a read-mostly planner whose destructive verbs are already hard-refused, binary-plus-leading-arguments is the useful granularity.

## History

- 2026-07-31 — accepted.
- 2026-09-27 — computed command names refused, computed arguments prompt, `|&`, glued short-flag values.
- 2026-09-28 — command runners unwrapped or refused, `xargs` allowlist, sed and awk programs read, `<` targets confined.
- 2026-09-29 — the seam carries runner tool requests (ADR-0018, #56).
- 2026-10-01 — patterns are not paths, inert devices, one prompt per command.
- 2026-10-01 — `cd` followed through `&&` chains where the shell's directory is certain.
- 2026-10-04 — `cd` following decided by the lexer; a line that can steer `cd` keeps it asking.
- 2026-10-04 — a `cd` or shell-moving builtin that asks is granted for its exact line.
- 2026-10-04 — `builtin` unwrapped; `enable -f` refused.
- 2026-10-07 — `!`, quote-aware substitution matching, stdin-fed interpreters, inline-code spellings, case-insensitive refusal, `+=` assignments.
- 2026-10-07 — `${…}` in substitutions, `$'…'` escapes, here-document bodies, interpreter families, `deno eval`, `data:` URLs, PowerShell's positional command, cmd.exe command names.
- 2026-10-07 — here-document skipping fails closed outside a provable `<<` (comment, `${…}`/`$[…]`, `(( ))`); cmd.exe command words holding `/` or `=` refuse and never scope to a bare drive, `call` unwrapped and `start` refused; interpreter families match a version or suffix.
- 2026-10-09 — Claude harness planners deny shell tools and native plan-mode transitions; the OpenCode shell enforcement gap is recorded.
- 2026-10-10 — harness planners research inside this envelope through `run_command`, every planner's own requests reach `IApproval`, and pre-approved entries become allowlist rules with a mode tied to autonomy (ADR-0026).
