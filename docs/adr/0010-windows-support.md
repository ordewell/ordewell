# 0010 — Windows support: one launch seam, one shell seam, one dialect

**Status:** accepted

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

`planDirectLaunch` for `spawn` callers, `planShellLaunch` for surfaces that hand
an executable to a terminal. Both are **identity on POSIX**: `planDirectLaunch`
returns its input untouched (execvp already searches PATH, and a resolution step
there is only a new way for a working install to break), and `planShellLaunch`
produces the same `bash -lc` it always did.

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
`--append-system-prompt` (measured: 12,363 characters with every mode toggle on,
plus up to ~11 KB of collected context) does not fit, and Windows truncates
rather than rejecting. A truncated system prompt makes the planner answer half a
question confidently, which is exactly the silent success this repo refuses — so
`CommandLineTooLongError` names the fix instead. `TaskOrchestrator.startTask`
already catches a spawn throw and holds the task, so it degrades to a visible
held task with an actionable message.

The native and PowerShell routes are bounded by CreateProcess's own 32767-character
ceiling rather than cmd.exe's, which is four times further away but truncates
the same way — so it raises the same error, with a different message. The shim
version says "install the native executable"; the OS-ceiling version says so
explicitly *not*, because no reinstall moves that limit, and points at the task
prompt and the mode toggles that append to the system prompt instead. Advice
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
  had stopped. `taskkill /T` walks the tree; POSIX keeps its SIGTERM → SIGKILL
  escalation unchanged. Every dispose path means `ModelDiscovery`'s too: its
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

The **VS Code extension and the web surface work on native Windows**: harness
planners (Claude Code, Codex, OpenCode), API-key planners, runner execution,
model discovery, and the exploration envelope with its gate intact.

The **TUI does not**, and this ADR does not change that. It is tmux-backed
(ADR-0007), and `hasTmux` already feature-detects, so the requirement is
declared rather than assumed. WSL remains the answer there. The launch and kill
seams are platform-general, so a future non-tmux Windows TUI inherits them
without new work — which is why they live in `core` and not in the VS Code
adapter.

Three things are **explicitly not claimed**:

1. **Codex's read-only guarantee on Windows is unverified.** `codexSandbox`
   correctly short-circuits its bubblewrap probe off Linux, and the approvals
   half of the invariant holds by construction (`approvalPolicy: 'never'`, the
   whole server→client request surface refused). But Codex's OS-level sandboxing
   on Windows is not the equivalent of Seatbelt or Landlock, so
   `sandbox: 'read-only'` may be enforced by Codex's tool layer rather than by
   the kernel. "Read-only by construction" is a Linux/macOS guarantee until
   someone tests it there. The comment in `codexSandbox.ts` says so rather than
   asserting the stronger claim it used to.
2. **`%VAR%` expansion on the cmd.exe shim route.** In a `cmd /c` context `%`
   cannot be escaped — `%%` is a batch-file construct and `^%` still expands — so
   an argument naming a *defined* environment variable is expanded. Preferring a
   native executable skips cmd.exe and the hazard with it, which is the main
   reason the preference is global.
3. **Argument fidelity on the PowerShell shim route.** `-File` receives an
   ordinary argument vector and Node quotes it by the CommandLineToArgvW
   inverse, which is what `powershell.exe` parses when it is started as a
   process rather than from a shell — so this should be exact. "Should be" is
   the claim: it is the one route with no Windows host behind it. It is also
   the one route whose alternative is a hard `spawn ENOENT`, so it can only
   improve on a failure, never regress a working install — and it is kept away
   from the large-prompt case, where a mangled argument would cost most, by
   refusing to rescue an overflowing `.cmd`.

Everything here was verified by test on Linux (1221 core, 317 VS Code, 152 web,
773 CLI, all passing) with the Windows branches driven through injected seams.
It has not been run on a Windows host.

## Amendment — the batch route cannot carry a line break

First run on a real Windows host, against an npm-installed OpenCode
(`opencode.cmd`, `opencode.ps1`, no `.exe`): tasks started with only the first
paragraph of their prompt. **cmd.exe reads its command line up to the first
CR/LF and discards the rest — no error, exit code 0.** Quoting does not help;
the line ends at the break whether or not it falls inside quotes.

Every prompt Ordewell builds spans lines. `composeAugmentedPrompt` appends the
completion-marker instruction after a blank line and prepends the plan map and
prior task outputs, so the batch route delivered the task's opening paragraph
and nothing else — including no completion marker, which is the token
`VerdictEngine` watches for. The same seam carries the harness planners' system
prompts, so those were truncated too.

So `planFor` disqualifies the batch route outright for a multi-line argument,
and — unlike overflow — that disqualification **falls through to the next
route**. The two are different in kind: overflow is a capacity judgement about a
line cmd.exe would at least read, while a line break means it cannot carry the
argument at any length. A `.ps1` beside a `.cmd` is therefore taken when the
arguments span lines; a `.cmd` standing alone raises `EmbeddedNewlineError`,
which `TaskOrchestrator.startTask` turns into a held task naming the fix.

This also settles claim 3 above. Argument fidelity on `powershell.exe -File` was
measured on a Windows host: a multi-line argument containing `$(…)`, a backtick
and `%PATH%` arrived byte-exact, with no expansion — so the tier is no longer
the one route with nothing behind it, and `%VAR%` expansion (claim 2) is another
hazard it avoids.
