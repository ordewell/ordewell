---
status: accepted
---

# 0010 — Windows support: one launch seam, one shell seam, one dialect

## Problem

Ordewell ran on POSIX only, and not by design — by accretion. Nothing declared a
platform requirement; every OS touchpoint simply assumed the one the authors
were on. The result was not a surface that degraded on Windows, it was a surface
that reported itself healthy and then failed, in four places at once:

- **`buildShellInvocation` emitted PowerShell that PowerShell cannot parse.**
  `powershell.exe -Command "'claude' '-p' '…'"` puts a quoted string in leading
  position, which is parsed in *expression* mode — so the invocation died with
  `Unexpected token` before the runner started. Every VS Code task failed
  instantly, and a test pinned the broken form as correct.

- **Every `spawn` of an agent CLI was ENOENT.** Four call sites (two harness
  adapters, the headless runner, Codex's app-server discovery) spawned bare
  `claude`/`codex`/`opencode` with `shell: false`. On Windows that is
  CreateProcess, which performs no PATHEXT lookup, and an npm-installed agent is
  `claude.cmd`. Worse, `RunnerInstallation` probes with `exec` — which *does* go
  through cmd.exe — so the picker reported the runner installed and healthy
  before the session died.

- **The planner's read-only research tier was POSIX vocabulary.** `AUTO_COMMANDS`
  is `ls`, `cat`, `wc`, `head`, `grep`, `find`. Handed to `shell: true` on
  Windows that is cmd.exe, where most of those do not exist — and `find` is an
  unrelated program that returns plausible wrong output rather than an error.

- **The `bash` gate was lexing a different language than it was running.** The
  classifier is a POSIX shell lexer. `\` is an escape in `sh` and a path
  separator in cmd, so `rg pattern C:\repo\src` tokenized to `C:reposrc` and
  failed containment against the workspace it named; `'` is a quote in `sh` and a
  literal in cmd, so `echo it's & del x` hid the `del` inside what the lexer
  believed was a quoted string. `looksLikePath` recognized no Windows spelling at
  all, so `pathLikeArgs` returned nothing and ADR-0008's escape prompt was not
  weaker on Windows — it was absent. And `REFUSED_COMMANDS` listed `rm` but not
  `del`, so the refusal tier was bypassable by writing the command the way the
  platform spells it.

## Decision

**Three seams own the platform differences, and no call site decides for itself.**

### 1. `utils/launch.ts` — how a CLI is started

`planDirectLaunch` serves every `spawn` caller. It is **identity on POSIX**:
its input is returned untouched because execvp already searches PATH. There
is no terminal launch helper or runner terminal.

The Windows branch resolves the command against PATH × PATHEXT across three
routes, in the order that reaches a directly-spawnable file soonest: a native
`.exe`, a `.cmd` shim through `cmd.exe /d /s /c` with
`windowsVerbatimArguments`, a `.ps1` shim through `powershell.exe -File`. The
preference is global — every directory searched for `.exe` before any is
searched for `.cmd` — which is not how Windows itself resolves, and is
deliberate: two installs of the same CLI are the same program, and taking the
`.exe` is what keeps the common case off an interpreter and off cmd.exe's
8191-character buffer. An unresolvable command is handed back untouched so the
caller's own ENOENT — which names what the user typed — is what surfaces.

**A batch shim npm wrote is not run through cmd.exe.** npm's shims (its
`cmd-shim`) are two fixed templates: one runs a Node script with the `node.exe`
beside the shim, or else the `node` on PATH, and one starts a program in the
package itself, as OpenCode's does its `.exe`. Either only finds a file and
hands it `%*`, so `planDirectLaunch` reads the shim and starts that file
directly, which is what the shim does without cmd.exe's 8191-character buffer,
its cut at a line break, its `%VAR%` expansion and a `"` it cannot carry. That
matters most for Claude Code installed by npm: its system prompt spans lines
and its `--settings` and `--mcp-config` are JSON, so on either shim route it
started with a prompt or a setting it could not read. Only a shim that is
npm's template byte for byte, but for a target holding no quote, `%` or line
break, is read so. A `.cmd` with a line of its own may set a variable or do
more than find a file, which only cmd.exe would do, so it keeps the batch
route; so does a shim whose file, or a `node` to run it, is not there. pnpm's
shims also set `NODE_PATH` and are not read.

**The PowerShell tier is availability-ordered, not capacity-ordered.** It is
reached only when neither of the others resolved: an installer that dropped a
script rather than a binary, a hand-rolled shim. Every Node package manager
that writes a `.ps1` writes a `.cmd` beside it, so on those installs the tier is
never selected — it exists so that the shapes which *don't* fail with a bare
`spawn ENOENT` naming a CLI the user can see is installed. `-File` is chosen
over `-Command` because it evaluates nothing: the script path and the arguments
after it are strings, so a prompt containing `$(…)` or a backtick is data rather
than PowerShell source. `.ps1` is deliberately **not** filtered against PATHEXT,
which does not list it by default — PowerShell resolves scripts itself — so
honouring PATHEXT there would disable the tier on exactly the machines it exists
for.

What the tier explicitly does *not* do is rescue an overflowing `.cmd`.
Overflow means a very large prompt, which is where `-File` argument fidelity is
least worth betting on, and a visible held task beats a plausibly mangled one.
So a `.ps1` sitting beside a too-long `.cmd` still raises.

**A line break is different: the batch route cannot carry one at all.** cmd.exe
reads its command line up to the first CR/LF and discards the rest — no error,
exit code 0 — and quoting does not help. Every prompt Ordewell builds spans
lines (`composeAugmentedPrompt` appends the `task_complete` instruction after
a blank line, and the harness planners' system prompts share the seam), so a
task would start with its opening paragraph only and no instruction to call
`task_complete`. So `planFor` disqualifies the batch route for a
multi-line argument, and — unlike overflow, a capacity judgement about a line
cmd.exe would at least read — that disqualification **falls through to the next
route**: a `.ps1` beside a `.cmd` is taken when the arguments span lines, and a
`.cmd` standing alone raises `EmbeddedNewlineError`, which the start's one
spawn-failure path (`Attempts` reports it, the scheduler applies it) turns into
a held task naming the fix.

The batch route wraps its whole command line in one more pair of quotes, which
is load-bearing rather than cosmetic. Under `/s`, cmd's rule is to strip the
first quote on the line and the *last* one and take the rest verbatim — so a
line whose first token is a quoted path (`"C:\Program Files\npm\claude.cmd" -p
"go"`) loses the executable's opening quote and the final argument's closing
one, and cmd runs `C:\Program`. Every user whose account name contains a space
hits that on their first task. Wrapping makes the two quotes cmd removes the two
we added, which is what Node's own `shell: true` does for the same reason.

Windows paths are built with `path.win32` explicitly, not the host-flavoured
`path`. On a Windows host they are the same object, so production is unaffected;
off-platform it is what makes the behavior testable at all.

**The cmd.exe buffer is a refusal, not a truncation.** A 12 KB
`--append-system-prompt` (the planner prompt plus collected
context) does not fit, and Windows truncates
rather than rejecting. A truncated system prompt makes the planner answer half a
question confidently, which is exactly the silent success this repo refuses — so
`CommandLineTooLongError` names the fix instead. A spawn throw already holds
the task, so it degrades to a visible held task with an actionable message.

The native and PowerShell routes are bounded by CreateProcess's own 32767-character
ceiling rather than cmd.exe's, which is four times further away but truncates
the same way — so it raises the same error, with a different message. The shim
version says "install the native executable"; the OS-ceiling version says so
explicitly *not*, because no reinstall moves that limit, and points at the task
prompt and the task skills, whose text is added to the prompt
([ADR-0024](../planner/0024-unified-skills.md)), instead. Advice
that cannot work is worse than none.

### 2. `services/researchShell.ts` — which interpreter runs the planner's `bash`

Rather than write a Windows dialect of every research command — a second
behavior to keep in step forever — Ordewell finds a POSIX shell to run the
existing ones in. Git for Windows ships one, and git is already a prerequisite
for everything Ordewell does. `C:\Windows\System32\bash.exe` is excluded and must
stay excluded: that is the WSL launcher, which sees `/mnt/c/...`, so every
workspace path would mean a different file than the one confinement is checking.

Failing that, cmd.exe is used and the classifier is **told so**. The shell also
reports its `utilsDir`, prepended to PATH for the search subprocesses `execFile`
starts without a shell — without it, `grep` (the fallback when ripgrep is absent)
is unresolvable even with a working `grep.exe` on the box. A cmd.exe fallback
appends `researchShellWarning` to any failed command, so a degraded research
surface reads as degraded rather than as a repository with no answer.

POSIX resolves to `{ file: null }`, meaning "use `shell: true`" — byte for byte
the call the adapters made before.

### 3. `commandPolicy.Dialect` — what counts as syntax

The classifier is keyed to the **interpreter**, not the OS. `BaseFileSystem`
resolves the research shell once and passes its `dialect` to both
`classifyCommand` and `pathLikeArgs`, so classifying under one language and
executing under another is not a bug to avoid but a state the types do not
permit. A Windows box with Git Bash classifies as POSIX, correctly.

**A path is judged where the shell reads it to be.** Git Bash keeps a mount
table of its own: `/` is its install, `/tmp` the user's temp folder, `/c` the
`C:` drive, and `/dev/null` its null device. Read by the host, `/etc/passwd`
was `<drive>:\etc\passwd` and `/c/Users/me` was `<drive>:\c\Users\me`, so the
folder a user approved was not the one the command reached, `/dev/null` asked
to reach a folder that is not there, and a workspace at `<drive>:\c` held paths
that were not in it. So the research shell carries a `hostPath`, read from Git
Bash's own `mount` the first time a command names a path that needs it, with
Git for Windows' default table in its place when `mount` cannot run, and path
confinement resolves every path a command names, and every `cd` it follows,
through it: a backslash read as a separator, `/proc/cygdrive` as the drive
prefix, and a mount point matched in any case only where Git Bash does, on a
`posix=0` mount. What it cannot follow for certain is refused rather than
guessed at: Git Bash climbs `/tmp/..` on disk and `/bin/..` by name, reads
`../../c/Users` from a workspace on `F:` as `C:\Users` by way of its own root,
and keeps a `/proc` and a `/dev` of its own (`/dev/clipboard` is the
clipboard), so a POSIX path holding a `..`, a relative one that climbs off its
drive, and the rest of `/proc` and `/dev` name no folder an approval could
name, and a command naming one is refused with that reason. This is not a
wider envelope ([ADR-0008](../planner-envelope/0008-planner-exploration-envelope.md)):
the same paths are judged, each as the folder the command will reach, and
those that reach none certainly are refused. Under cmd.exe there is no table
and no device, so `/dev/null` is the folder it names there.

Only the rules that actually diverge are modeled: escape character, whether that
escape survives inside quotes, quote characters, expansion syntax, and stripped
executable extensions. The second one is not a detail — cmd.exe reads `^` inside
a quoted run as an ordinary character, and treating it as an escape let a pair of
`^"` consume both the closing and the reopening quote, leaving the lexer inside a
string cmd.exe had already left. `echo "a^"b^" & del x"` then classified `auto`
and ran with no prompt, and because the quote count is even, the
unbalanced-quote refusal did not catch it either. Constructs cmd.exe
lacks — `$(…)`, backticks — are still recognized on Windows, because
over-splitting costs a needless approval prompt and under-splitting costs the
gate. `REFUSED_COMMANDS` gains the destructive cmd.exe builtins
unconditionally: a POSIX box has no `del` to refuse, so the extra names cost
nothing there.

### Also

- **`killTree`** (`utils/processTree.ts`) replaces `kill('SIGTERM')` at every
  dispose path. Windows has no signals, and the direct child may be the cmd.exe
  shim rather than the agent — so terminating it left the agent running, holding
  the workspace and the subscription, invisible to the surface that thought it
  had stopped. `taskkill /T` walks the tree, and is forced (`/F`) at once when
  the unforced pass is refused: that pass only asks a window to close, which a
  console agent does not have, so it went on writing to the worktree it was
  stopped in for the whole grace. POSIX keeps its SIGTERM → SIGKILL
  escalation, sent to the runner's process group (see CONTEXT.md, *Kill
  tree*). A leader's exit does not end that group — a crashed runner leaves its
  shells and dev servers running — so the group is signalled after the leader
  is gone and kept on the host's books until it is empty. Once the leader has
  exited, by a code or a signal, every signal to the group is preceded by
  asking whether it still has members: an empty group's id can be recycled,
  and a group Ordewell cannot vouch for is never signalled. Every dispose path
  means `ModelDiscovery`'s too: its
  Codex app-server probe held the one remaining bare `kill()`, so a discovery
  call against a shim install left the app-server holding its port after the
  call that started it had returned.
- **`withPath`** (`utils/shellPath.ts`) is now the only way a child gets a PATH.
  `{ ...process.env, PATH }` is the obvious spelling and is wrong on Windows:
  spreading `process.env` yields the OS's casing (`Path`), so adding `PATH`
  hands the child both and the loser is silently discarded. Every site passed
  the same value under both keys, so this was latent rather than live —
  `withPath` makes it impossible rather than unlikely.
- **`augmentedPath`** gains a Windows arm. There is no login shell to query, so
  the well-known-directory list is the whole safety net — and a directory
  missing from it is a runner the picker greys out while the user is looking at
  the install that just succeeded. It therefore has to cover every route the
  three built-in runners actually arrive by: the PowerShell one-liner
  installers (`%USERPROFILE%\.local\bin` for Claude Code,
  `%USERPROFILE%\.opencode\bin` for OpenCode), the Node package managers (npm's
  global prefix, and pnpm's and Yarn's, which are not under it), the Windows
  package managers (Scoop and Chocolatey shims, WinGet's `Links` folder for
  portable packages — distinct from `WindowsApps`, which is MSIX only), and
  Volta, which spells its home `%LOCALAPPDATA%\Volta` here rather than
  `~/.volta`. `.local\bin` is the one worth naming: it was already in the POSIX
  list, where the *same* installer puts the *same* binary, so its absence here
  meant the documented Windows install of the flagship runner was the one
  install Ordewell could not find. The list is a pure function of environment
  and home directory (`wellKnownBinDirs`) so a Linux CI box can pin it.
- **`formatSearchOutput`** uses `path.sep`. The prefix was `root + '/'`, so
  `C:\repo` produced `C:\repo/`, matched nothing, and left every search result
  absolute — full path length paid on every row of every search.
- **`RunnerInstallation.plannerUsability`** now checks the CLI is spawnable the
  way the planner actually spawns it, closing the gap where `exec` said healthy
  and `spawn` said ENOENT. POSIX always agrees, since `execvp` and `exec` search
  PATH identically.

## Consequences

The **VS Code extension and the daemon work on native Windows**: harness
planners (Claude Code, Codex, OpenCode), API-key planners, runner execution,
model discovery, and the exploration envelope with its gate intact.

The **TUI runs on native Windows**: driven in a Windows pseudo console, it drew
on the alternate screen, took keys, redrew on a resize, planned, ran and
merged a plan, and gave the screen back on exit. Mouse scrolling and bracketed
paste were not exercised there. Runner execution uses structured connectors and no longer needs
tmux or per-task terminal windows (ADR-0025). The launch and kill seams are
shared in core.

Three things are **explicitly not claimed**:

1. **Codex's read-only guarantee on Windows is unverified.** `codexSandbox`
   correctly short-circuits its bubblewrap probe off Linux, and the approvals
   half of the invariant holds by construction (`approvalPolicy: 'on-request'`:
   what Codex asks to run or change is declined at once, a user's MCP tool is
   decided by Ordewell, and every other request is refused, ADR-0026). But
   Codex's OS-level sandboxing
   on Windows is not the equivalent of Seatbelt or Landlock, so
   `sandbox: 'read-only'` may be enforced by Codex's tool layer rather than by
   the kernel. "Read-only by construction" is a Linux/macOS guarantee until
   someone tests it there. The comment in `codexSandbox.ts` says so rather than
   asserting the stronger claim it used to.
2. **`%VAR%` expansion on the cmd.exe shim route,** for a shim npm did not
   write. In a `cmd /c` context `%` cannot be escaped — `%%` is a batch-file
   construct and `^%` still expands — so an argument naming a *defined*
   environment variable is expanded. Preferring a native executable skips
   cmd.exe and the hazard with it, which is the main reason the preference is
   global, and an npm shim's file is started as one.
3. **A `"` on the PowerShell shim route,** for a shim npm did not write. A shim
   hands `$args` on to its program, and Windows PowerShell 5.1 re-quotes each
   argument by its own reckoning and escapes nothing: a `"` inside one is lost
   or splits it, an empty argument is dropped, and a trailing `\` in one with
   whitespace escapes the quote it is closed with. Escaping the arguments for
   the program behind the shim was tried and taken back. A subplanner's system
   prompt, near Windows' command-line ceiling already, went over it once its
   quotes were escaped, and 5.1's quoting decisions are not ones an escape can
   always satisfy: a space between two quotes still splits. npm writes a `.cmd`
   beside every `.ps1`, and its shim's file is started directly, so the route
   is left to installs that wrote a script alone.

**Argument fidelity through an npm shim is measured** on every Windows CI run:
a shim as npm writes it hands its script a `"`, a line break, `%PATH%`, an
empty argument and cmd.exe's metacharacters as they were given.

**Argument fidelity on the PowerShell shim route is measured** for what it does
carry. `-File` receives an ordinary argument vector that Node quotes by the
CommandLineToArgvW inverse. On a Windows host, a multi-line argument containing
`$(…)`, a backtick and `%PATH%` arrived byte-exact through a shim as npm writes
it, with no expansion, so `%VAR%` expansion is a hazard this route avoids too.

The Windows branches are tested on Linux through injected seams, and **CI runs
every suite again on a Windows runner**: each package's vitest suites, the
bench harnesses, the offline planner loop and the VS Code integration test. A
test whose subject is POSIX-only (bubblewrap, Seatbelt, signals, file modes,
containers) skips there and says why. The batch route's line-break failure and
the PowerShell route's fidelity were found and measured on a Windows host. So
was the VS Code extension's first run: activation, runner detection, the login
probe and Log in, with Claude Code as its native `.exe` and Codex and OpenCode
as npm `.cmd` shims. Real plans have run there through the CLI's headless
commands, each built-in agent as planner and as runner, with worktree isolation
under an 8.3 short path, through to a merged handoff. A worktree's path is
compared with git's name for it by `realpathSync.native`: git prints the long
name with forward slashes, and a recorded path can carry a short name or a
lower-case drive letter.

## History

- 2026-07-31 — accepted, with an amendment from the first run on a Windows host (OpenCode installed by npm): the batch route's line-break truncation found and routed around, PowerShell `-File` fidelity measured.
- 2026-10-07 — POSIX stop signals the runner's process group rather than the direct child.
- 2026-10-09 — the system-prompt advice names task skills, the mode toggles being gone (ADR-0024).
- 2026-10-09 — aligned with [ADR-0025](../runners/0025-structured-only-runners.md).
- 2026-10-13 — a returned exit code no longer skips a group leader: the group is signalled and tracked until it is empty.
- 2026-10-13 — a group whose leader has exited is asked for members before each signal, and dropped once empty.
- 2026-10-17 — Codex's approvals on Windows read `on-request`, as ADR-0026 made them on 2026-10-10; the text still said `never`.
- 2026-10-24 — a spawn throw is held through the one spawn-failure path in `Attempts`; the text named a `TaskOrchestrator.startTask` that no longer exists.
- 2026-11-03 — the VS Code extension's activation, runner detection and login run on a Windows host.
- 2026-11-03 — CI runs the suites on Windows, real plans ran there through to a merged handoff, a refused unforced `taskkill` is forced at once, and a `"` on the PowerShell shim route is recorded as unclaimed.
- 2026-11-04 — a batch shim npm wrote starts the file it names directly, so a `"`, a line break and `%VAR%` reach the program whole.
- 2026-11-04 — path confinement reads a path through Git Bash's mount table, as the shell running the command does.
