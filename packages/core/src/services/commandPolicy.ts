/**
 * Tiered classification for the planner's `bash` tool.
 *
 * The planner is a read-only researcher: it never edits files, and the runners
 * do the real work. But research legitimately means running things — querying a
 * cloud control plane (`az`, `gh`), reproducing a failure (`npm test`), or
 * shaping output (`jq`). The old allowlist refused all of that, so the model's
 * only escape was to guess.
 *
 * Three tiers replace the flat allowlist:
 *
 *   auto    read-only inspection — runs with no prompt (the historical list)
 *   ask     anything else that is not obviously destructive — one approval,
 *           remembered for the rest of the session at `scope` granularity
 *   refuse  writes, privilege escalation, and anything that would smuggle
 *           arbitrary code past this classifier — never runs, never prompts
 *
 * `refuse` is deliberately not promptable. A planner that can `rm` is a planner
 * that can silently break the workspace it was asked to reason about, and the
 * architecture already says mutation belongs to the runners.
 *
 * Classification walks every segment of the command line (pipes, `&&`, `;`, and
 * command substitution) rather than matching substrings against the raw string.
 * The old substring denylist both over-matched (`ls docs/removed` tripped `rm`)
 * and under-matched (`$(rm -rf /)` was invisible once chaining was allowed).
 *
 * A segment is classified by the command that will actually execute, not by the
 * name at the front of it: wrappers are unwrapped first, recursively, so
 * `timeout 10 env nice rm -rf x` is an `rm`. See {@link WRAPPER_FAMILY}.
 *
 * The lexer is dialect-aware, because the interpreter that will actually run
 * the command decides what the tokens are, and getting that wrong is not a
 * cosmetic error here — it is the difference between classifying what runs and
 * classifying something else. See {@link Dialect}.
 */

import type { ShellDialect } from './researchShell';

/**
 * `env` is deliberately absent. Given a command it is a wrapper, classified by
 * what it actually runs (see {@link WRAPPER_FAMILY}); given none it prints the
 * whole process environment — provider credentials included — into the research
 * log, which is a disclosure the developer should get to see coming.
 */
export const AUTO_COMMANDS = [
  'ls', 'tree', 'git', 'wc', 'du', 'df', 'file', 'head', 'tail', 'cat', 'sort', 'uniq',
  'echo', 'printf', 'date', 'stat', 'basename', 'dirname', 'realpath', 'pwd',
  'which', 'type', 'uname', 'whoami', 'cut', 'nl', 'rg', 'grep', 'find', 'jq', 'yq',
];

export const GIT_READONLY_SUBCOMMANDS = [
  'log', 'status', 'diff', 'show', 'ls-files', 'ls-remote', 'ls-tree', 'branch', 'tag',
  'rev-parse', 'rev-list', 'describe', 'blame', 'grep', 'shortlog', 'whatchanged', 'cat-file',
];

/**
 * Never runs, with or without approval.
 *
 * The `cmd.exe` builtins at the end matter as much as the POSIX names above
 * them. `del`, `rd`, `move`, and friends mutate exactly what `rm` and `mv` do,
 * and on Windows they are what a model reaches for — so without them the whole
 * refusal tier was bypassable on that platform by writing the command the way
 * the platform spells it. Listed unconditionally rather than per-platform: a
 * POSIX box has no `del` to refuse, so the extra names cost nothing there.
 */
export const REFUSED_COMMANDS = [
  'rm', 'rmdir', 'unlink', 'shred', 'truncate', 'dd', 'mkfs', 'fdisk', 'parted',
  'mv', 'cp', 'install', 'ln', 'chmod', 'chown', 'chgrp', 'chattr',
  'mount', 'umount', 'sudo', 'doas', 'su', 'passwd',
  'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'halt', 'poweroff',
  'systemctl', 'service', 'crontab', 'tee', 'dput', 'mkdir', 'touch',
  // Windows: destructive cmd.exe builtins and their utility equivalents.
  'del', 'erase', 'rd', 'md', 'move', 'copy', 'xcopy', 'robocopy', 'ren', 'rename',
  'mklink', 'attrib', 'icacls', 'cacls', 'takeown', 'format', 'diskpart',
  'taskkill', 'tskill', 'reg', 'regedit', 'sc', 'net', 'runas', 'schtasks',
];

/** Destructive or outward-facing subcommands of otherwise-permitted multiplexers. */
const REFUSED_SUBCOMMANDS: Record<string, string[]> = {
  git: ['push', 'reset', 'clean', 'checkout', 'switch', 'restore', 'rebase', 'merge', 'commit',
    'am', 'apply', 'cherry-pick', 'revert', 'stash', 'gc', 'prune', 'filter-branch',
    'update-ref', 'remote', 'config', 'init', 'clone', 'fetch', 'pull', 'submodule'],
  npm: ['publish', 'unpublish', 'deprecate', 'owner', 'access', 'token', 'login', 'logout'],
  yarn: ['publish', 'npm'],
  pnpm: ['publish'],
  docker: ['push', 'rm', 'rmi', 'kill', 'stop', 'prune', 'system'],
  kubectl: ['delete', 'apply', 'create', 'patch', 'replace', 'edit', 'drain', 'cordon', 'scale'],
  gh: ['release', 'secret', 'auth'],
  az: ['login', 'logout'],
  terraform: ['apply', 'destroy'],
};

/** Binaries that execute whatever they are handed — refused when given inline code or fed from a pipe. */
const INTERPRETERS = ['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell',
  'python', 'python2', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'eval', 'exec', 'xargs',
  // Windows interpreters. `cmd /c "…"` is the platform's spelling of `sh -c`.
  'cmd', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32'];

/**
 * Flags that hand an interpreter code to run. Compared case-insensitively:
 * cmd.exe and PowerShell both accept their switches in any casing, so a
 * case-sensitive list refused `-Command` and waved `-command` through.
 */
const INLINE_CODE_FLAGS = ['-c', '-e', '--eval', '--command', '-Command', '--exec', '/c', '/k', '/r'];

function isInlineCodeFlag(arg: string): boolean {
  const lower = arg.toLowerCase();
  return INLINE_CODE_FLAGS.some((f) => f.toLowerCase() === lower);
}

/** Multiplexers whose first non-flag argument is meaningful enough to scope a grant. */
const MULTIPLEXERS = ['git', 'npm', 'yarn', 'pnpm', 'npx', 'cargo', 'go', 'dotnet', 'docker', 'podman',
  'kubectl', 'helm', 'az', 'aws', 'gcloud', 'gh', 'glab', 'terraform', 'make', 'mvn', 'gradle',
  'composer', 'pip', 'pip3', 'poetry', 'uv', 'bundle', 'rake', 'swift', 'flutter', 'dart'];

/**
 * How a wrapper's own arguments are skipped to reach the command it will run.
 *
 * Getting an arity wrong here does not merely mis-parse: the token after the
 * flag is what gets classified, so a value-taking flag mistaken for a boolean
 * makes its *value* look like the command and the real command look like an
 * argument. That is why {@link scanWrapperArgs} refuses a flag it does not
 * recognize instead of guessing at its arity.
 */
interface WrapperSpec {
  /**
   * Consume the following token as their value — unless it is already glued on
   * (`-o0`, `-uPATH`) or spelled `--flag=value`, both of which are
   * self-contained.
   */
  valueFlags?: string[];
  /**
   * Consume nothing. Long flags whose value is *optional*
   * (`--block-signal[=SIG]`) belong here rather than in `valueFlags`: treating
   * them as value-taking would swallow the wrapped command whenever the value
   * is omitted, and the `--flag=value` spelling needs no declaration.
   */
  booleanFlags?: string[];
  /** Boolean flags whose spelling is open-ended — `nice -10`. */
  booleanPattern?: RegExp;
  /**
   * Take a whole command line as a string (`env -S 'rm -rf /'`). Refused for
   * the same reason `sh -c` is: the string is not tokens this classifier lexed.
   */
  stringFlags?: string[];
  /**
   * Flags under which the wrapper executes nothing at all — `command -v rm`
   * prints where `rm` lives without running it — so there is nothing to unwrap
   * to and the wrapper is classified on its own name.
   */
  noExecFlags?: string[];
  /** Non-flag arguments consumed before the command begins. `timeout`'s duration. */
  positionals?: number;
  /**
   * `NAME=value` tokens are the wrapper's own arguments rather than the start
   * of the command. Only `env`; they are carried onto the unwrapped segment so
   * the assignment refusal answers for them.
   */
  acceptsAssignments?: boolean;
}

const HELP_FLAGS = ['--help', '--version'];

/**
 * Commands that exist to run another command.
 *
 * `env rm -rf build` is an `rm`, and classification only ever looks at a
 * segment's first binary — so with `env` in the permitted set, four characters
 * walked around the entire refusal list *and* the entire interpreter list, with
 * no prompt at all.
 *
 * The other eight are here for a different reason, and extending to them is a
 * deliberate departure from how the case was reported. None of them was
 * permitted, so a wrapped `rm` fell through to `ask` — which is not "merely
 * inconvenient but safe". The refusal tier is documented as never promptable,
 * and a prefix that turns `rm -rf` into a prompt a developer can approve
 * defeats the guarantee the tier exists to provide. Unwrapping all nine costs
 * one declaration table over unwrapping `env` alone.
 *
 * Flag sets are drawn from what the tools actually accept, not from what they
 * are commonly written with: `stdbuf -o0` and `ionice -c3` glue the value on,
 * `nice -10` spells the adjustment as the flag, and `timeout` consumes a
 * positional duration before the command starts.
 */
const WRAPPER_FAMILY: Record<string, WrapperSpec> = {
  env: {
    valueFlags: ['-u', '--unset', '-C', '--chdir'],
    booleanFlags: ['-i', '--ignore-environment', '-0', '--null', '-v', '--debug',
      // Optional-value flags: see WrapperSpec.booleanFlags.
      '--block-signal', '--default-signal', '--ignore-signal', '--list-signal-handling',
      ...HELP_FLAGS],
    stringFlags: ['-S', '--split-string'],
    acceptsAssignments: true,
  },
  nice: {
    valueFlags: ['-n', '--adjustment'],
    booleanFlags: HELP_FLAGS,
    booleanPattern: /^-\d+$/,
  },
  timeout: {
    valueFlags: ['-s', '--signal', '-k', '--kill-after'],
    booleanFlags: ['--preserve-status', '--foreground', '-v', '--verbose', ...HELP_FLAGS],
    positionals: 1,
  },
  nohup: { booleanFlags: HELP_FLAGS },
  setsid: { booleanFlags: ['-c', '--ctty', '-f', '--fork', '-w', '--wait', '-h', '-V', ...HELP_FLAGS] },
  stdbuf: {
    valueFlags: ['-i', '--input', '-o', '--output', '-e', '--error'],
    booleanFlags: HELP_FLAGS,
  },
  ionice: {
    valueFlags: ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid'],
    booleanFlags: ['-t', '--ignore', '-h', '-V', ...HELP_FLAGS],
  },
  // The multi-call binary ships its own `rm`, `mv` and `sh`, so the refused
  // name arrives as its first argument.
  busybox: { booleanFlags: ['--list', '--install', ...HELP_FLAGS] },
  command: { booleanFlags: ['-p'], noExecFlags: ['-v', '-V'] },
};

/**
 * What the interpreter that will run this command treats as syntax.
 *
 * `BaseFileSystem.execBashImpl` runs the command through `shell: true`, which
 * means `/bin/sh` on POSIX and `cmd.exe` on Windows — two different languages.
 * Lexing cmd.exe input with POSIX rules is not a near-miss, it inverts specific
 * answers: `\` is an escape in sh and an ordinary path separator in cmd, so
 * `rg pattern C:\repo\src` tokenized to `C:reposrc`, which then failed
 * containment against the very workspace it named. And `'` is a quote in sh and
 * a literal character in cmd, so `echo it's & del x` hid the `del` inside what
 * the lexer believed was a quoted string.
 *
 * Only the four rules that actually diverge are modeled. Constructs cmd.exe
 * lacks (`$(…)`, backticks) are still recognized on Windows: over-splitting
 * costs a needless approval prompt, under-splitting costs the gate.
 */
export interface Dialect {
  /** The character that escapes the next one outside quotes. */
  escape: string;
  /**
   * Whether {@link escape} still escapes inside a double-quoted run.
   *
   * POSIX `\` does; cmd.exe `^` does not. Getting this wrong is not cosmetic:
   * with `^` honoured inside quotes, `echo "a^"& del b` lexed as one `echo`
   * segment — the escape swallowed the closing quote, so the `&` looked quoted
   * and the `del` cmd.exe would actually run became an argument nobody
   * classified.
   */
  escapeInQuotes: boolean;
  /** Characters that open a quoted run. */
  quotes: string[];
  /** Matches a variable reference the interpreter will expand. */
  expansion: RegExp;
  /** Executable extensions stripped before a binary is matched against the tiers. */
  strippedExtensions: string[];
}

const POSIX_DIALECT: Dialect = {
  escape: '\\',
  escapeInQuotes: true,
  quotes: ["'", '"'],
  expansion: /^\$[A-Za-z_{]/,
  strippedExtensions: [],
};

const CMD_DIALECT: Dialect = {
  escape: '^',
  escapeInQuotes: false,
  quotes: ['"'],
  // `%VAR%` and delayed-expansion `!VAR!`.
  expansion: /^[%!][A-Za-z_]/,
  // Without this, `del.exe` and `C:\bin\del.exe` both missed the refusal list.
  strippedExtensions: ['.exe', '.cmd', '.bat', '.com', '.ps1', '.msc'],
};

function dialectFor(dialect: ShellDialect | undefined): Dialect {
  const resolved = dialect ?? (process.platform === 'win32' ? 'cmd' : 'posix');
  return resolved === 'cmd' ? CMD_DIALECT : POSIX_DIALECT;
}

/**
 * Options threaded through classification.
 *
 * `dialect` is keyed to the interpreter rather than the OS on purpose: a Windows
 * host that has Git Bash runs the planner's commands in a POSIX shell (see
 * {@link resolveResearchShell}), and classifying those under cmd.exe rules
 * would be the same mismatch in the other direction. Callers pass the dialect of
 * the shell they are actually going to use; omitting it falls back to the host
 * default.
 */
export interface CommandPolicyOptions {
  dialect?: ShellDialect;
}

export type CommandTier = 'auto' | 'ask' | 'refuse';

export interface CommandClassification {
  tier: CommandTier;
  /** What a grant covers, for `ask`. Derived from the non-auto segments only. */
  scope: string;
  /** Populated for `refuse`: why, in a sentence the model can act on. */
  reason?: string;
}

interface Segment {
  binary: string;
  args: string[];
  /**
   * Leading `VAR=value` tokens, as written.
   *
   * Retained rather than discarded: the assignment is what decides what the
   * binary does — `LD_PRELOAD` loads attacker code into it, `PATH` changes
   * which executable is even reached — so classifying the binary alone answers
   * the wrong question. See {@link refusalFor}.
   */
  assignments: string[];
  /** True when this segment consumes another command's output (`… | seg`). */
  piped: boolean;
  /**
   * A token contains a `$var` the shell will expand. Tracked at lex time
   * because only the lexer knows a `$` inside single quotes is literal.
   */
  expandable: boolean;
}

/** An output redirect whose target is not provably a no-op (`/dev/null`, an fd duplication). */
interface UnsafeRedirect {
  /** The operator as written, fd prefix included: `>`, `2>`, `>>`, `&>`. */
  operator: string;
  /** The target text as the shell would see it, or `''` if the redirect had none. */
  target: string;
}

interface Lexed {
  segments: Segment[];
  /** Set for the first output redirect that isn't `/dev/null` or an fd duplication. */
  unsafeRedirect?: UnsafeRedirect;
  /** An unquoted `<(…)`/`>(…)` spawns a process this classifier never tokenizes. */
  processSubstitution: boolean;
  /** Lexing ran off the end inside a quote or a substitution — nothing here is trustworthy. */
  unbalanced: boolean;
}

/**
 * Whether a redirect target resolves to `/dev/null` — the one write target that
 * writes nothing. Resolved by segment, not by substring match: `/dev/null/../x`
 * must not slip through as a no-op just because it starts with the right prefix.
 */
function isDevNullTarget(target: string): boolean {
  if (!target.startsWith('/')) return false;
  const resolved: string[] = [];
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') resolved.pop();
    else resolved.push(seg);
  }
  return `/${resolved.join('/')}` === '/dev/null';
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Tokenize one command line the way a shell would: quotes and backslashes are
 * consumed, and only *unquoted* metacharacters are operators.
 *
 * This is the whole difference between the classifier seeing what will run and
 * seeing the raw string. Splitting on a bare `/[|;&]/` made `rg "error|warn"`
 * two segments (so the planner's commonest search asked for approval, scoped to
 * the nonsense binary `warn"`), while leaving quotes on argument tokens hid
 * `cat "/etc/passwd"` from the path-confinement check entirely.
 *
 * Substitution bodies are lifted out into `nested` and classified as their own
 * command lines, so `$(rm -rf /)` cannot hide inside an `echo`.
 */
function lex(command: string, nested: string[], dialect: Dialect): Lexed {
  const segments: Segment[] = [];
  let unsafeRedirect: UnsafeRedirect | undefined;
  let processSubstitution = false;
  let unbalanced = false;

  let tokens: string[] = [];
  let expandable = false;
  let current = '';
  let started = false;
  let piped = false;
  let quote = '';

  // Set while lexing the text after a write-redirect operator, so that text is
  // captured as the redirect's target instead of pushed onto the segment as an
  // ordinary argument.
  let redirectTargetMode = false;
  let redirectOperator = '';

  const endToken = (hardBoundary = true) => {
    if (redirectTargetMode) {
      // Whitespace right after the operator (`2> /dev/null`) is not the end of
      // the target — keep waiting rather than concluding there is none.
      if (!started && !hardBoundary) return;
      if (!unsafeRedirect && !isDevNullTarget(current)) {
        unsafeRedirect = { operator: redirectOperator, target: current };
      }
      redirectTargetMode = false;
      current = '';
      started = false;
      return;
    }
    if (started) tokens.push(current);
    current = '';
    started = false;
  };
  const endSegment = (nextPiped: boolean) => {
    endToken();
    if (tokens.length > 0) segments.push({ ...toSegment(tokens, piped, dialect), expandable });
    tokens = [];
    expandable = false;
    piped = nextPiped;
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i];

    // A single-quoted run is literal end to end — no escapes, no expansion.
    // Only POSIX has one; `CMD_DIALECT.quotes` omits `'` so this never fires
    // there, and an apostrophe stays an ordinary character.
    if (quote === "'") {
      if (c === "'") { quote = ''; i++; continue; }
      current += c; started = true; i++; continue;
    }

    // `quote` is '' or '"' here — the single-quote run returned above.
    if (c === dialect.escape && (quote === '' || dialect.escapeInQuotes)) {
      const next = command[i + 1];
      if (next !== undefined) { current += next; started = true; }
      i += 2; continue;
    }

    // Substitutions expand inside double quotes too, so these precede the
    // double-quote passthrough below.
    if (c === '$' && command[i + 1] === '(') {
      const close = matchParen(command, i + 1);
      if (close < 0) { unbalanced = true; break; }
      nested.push(command.slice(i + 2, close));
      started = true;
      i = close + 1; continue;
    }
    if (c === '`') {
      const close = command.indexOf('`', i + 1);
      if (close < 0) { unbalanced = true; break; }
      nested.push(command.slice(i + 1, close));
      started = true;
      i = close + 1; continue;
    }
    if (dialect.expansion.test(command.slice(i, i + 2))) {
      expandable = true;
      current += c; started = true; i++; continue;
    }

    if (quote === '"') {
      if (c === '"') { quote = ''; started = true; i++; continue; }
      current += c; started = true; i++; continue;
    }

    if (dialect.quotes.includes(c)) { quote = c; started = true; i++; continue; }

    if (c === '<' || c === '>') {
      if (command[i + 1] === '(') { processSubstitution = true; i += 2; continue; }

      // `2>err.log`: the fd is glued to the operator with no space, so it
      // accumulated in `current` as a plain-looking token — pull it back out
      // rather than let it fall through to `endToken` as a spurious argument.
      let fd = '';
      if (started && /^[0-9]+$/.test(current)) {
        fd = current;
        current = '';
        started = false;
      } else {
        endToken();
      }

      const doubled = command[i + 1] === c;
      const opLen = doubled ? 2 : 1;

      if (c === '>') {
        // `2>&1` / `>&2`: duplicates a stream, writes no file — safe.
        const dup = /^&([0-9]+)(?![0-9])/.exec(command.slice(i + opLen));
        if (dup) {
          i += opLen + dup[0].length;
          continue;
        }
        redirectTargetMode = true;
        redirectOperator = fd + c.repeat(opLen);
      }
      i += opLen;
      continue;
    }

    // `&>file` / `&>>file`: bash shorthand for redirecting stdout+stderr to a
    // file. Must be checked before the `&`-as-operator branch below.
    if (c === '&' && command[i + 1] === '>') {
      endToken();
      const doubled = command[i + 2] === '>';
      redirectTargetMode = true;
      redirectOperator = doubled ? '&>>' : '&>';
      i += doubled ? 3 : 2;
      continue;
    }

    // Subshell grouping is not part of any token: `(rm -rf /)` must lex to `rm`.
    if (c === '(' || c === ')') { endToken(); i++; continue; }

    if (c === '|') {
      const double = command[i + 1] === '|';
      endSegment(!double);
      i += double ? 2 : 1;
      continue;
    }
    if (c === '&' || c === ';' || c === '\n') {
      endSegment(false);
      i += command[i + 1] === c ? 2 : 1;
      continue;
    }

    if (/\s/.test(c)) { endToken(false); i++; continue; }

    current += c; started = true; i++;
  }

  if (quote !== '') unbalanced = true;
  endSegment(false);

  return { segments, unsafeRedirect, processSubstitution, unbalanced };
}

/**
 * The name a segment's binary is matched against the tiers under.
 *
 * `path.basename` alone is not enough: Node's POSIX `path` does not split on
 * `\`, so `C:\Windows\System32\del.exe` came back whole and matched nothing in
 * `REFUSED_COMMANDS`. Both separators are stripped regardless of host, and the
 * dialect decides whether an executable extension comes off too.
 */
function binaryName(token: string, dialect: Dialect): string {
  const base = token.split(/[/\\]/).pop() ?? '';
  // `dot > 0`, not `>= 0`: `lastIndexOf` returns -1 for a name with no dot, and
  // `slice(-1)` would then make the last character look like the extension.
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base;
  return dialect.strippedExtensions.includes(base.slice(dot).toLowerCase()) ? base.slice(0, dot) : base;
}

/** A `NAME=value` token, in the one position a shell treats as an assignment. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function toSegment(tokens: string[], piped: boolean, dialect: Dialect): Segment {
  const rest = [...tokens];
  const assignments: string[] = [];
  // `FOO=bar cmd` — assignments precede the binary. Kept on the segment, not
  // dropped: they are refused, and the message has to name the one it saw.
  while (rest.length > 0 && ASSIGNMENT.test(rest[0])) assignments.push(rest.shift()!);
  return {
    binary: rest.length > 0 ? binaryName(rest[0], dialect) : '',
    args: rest.slice(1),
    assignments,
    piped,
    expandable: false,
  };
}

/**
 * Where a wrapper's own arguments end, or why they cannot be read.
 *
 * `no-exec` means the flags say the wrapper runs nothing, so there is no inner
 * command to find.
 */
type WrapperScan =
  | { kind: 'command'; tokens: string[]; assignments: string[] }
  | { kind: 'no-exec' }
  | { kind: 'refuse'; reason: string };

/** The short flag in `list` that `token` glues its value onto, if any. */
function joinedShortFlag(list: string[], token: string): string | undefined {
  if (token.length <= 2) return undefined;
  return list.find((f) => f.length === 2 && token.startsWith(f));
}

/**
 * Walk a wrapper's arguments up to the command it will run.
 *
 * An unrecognized flag is refused rather than assumed to be a boolean. The
 * alternative loses the whole point of the table: a flag that in fact takes a
 * separate value would leave that value classified as the command and the
 * refused binary sitting harmlessly in its argument list — a wrapped `rm` back
 * on the prompt tier, which is exactly what unwrapping exists to prevent.
 */
function scanWrapperArgs(binary: string, spec: WrapperSpec, args: string[]): WrapperScan {
  const valueFlags = spec.valueFlags ?? [];
  const stringFlags = spec.stringFlags ?? [];
  const assignments: string[] = [];
  let positionals = spec.positionals ?? 0;
  let i = 0;

  while (i < args.length) {
    const token = args[i];
    // `--` ends the wrapper's options; whatever follows is the command.
    if (token === '--') { i++; break; }

    if (/^-./.test(token)) {
      const eq = token.startsWith('--') ? token.indexOf('=') : -1;
      const name = eq > 0 ? token.slice(0, eq) : token;
      // `--flag=value` carries its value in the same token.
      const selfContained = eq > 0;

      if ((spec.noExecFlags ?? []).includes(name)) return { kind: 'no-exec' };
      if (stringFlags.includes(name) || joinedShortFlag(stringFlags, token)) {
        return {
          kind: 'refuse',
          reason: `"${binary} ${name}" splits a string into a command, which this classifier cannot inspect. Use the read-only research tools, or describe it as a task.`,
        };
      }
      if ((spec.booleanFlags ?? []).includes(name) || spec.booleanPattern?.test(token)) { i++; continue; }
      if (valueFlags.includes(name)) { i += selfContained ? 1 : 2; continue; }
      if (joinedShortFlag(valueFlags, token)) { i++; continue; }
      return {
        kind: 'refuse',
        reason: `"${token}" is not a flag this classifier knows on the wrapper "${binary}", so it cannot tell which command "${binary}" would actually run. Re-run without it.`,
      };
    }

    if (spec.acceptsAssignments && ASSIGNMENT.test(token)) { assignments.push(token); i++; continue; }
    if (positionals > 0) { positionals--; i++; continue; }
    break;
  }

  return { kind: 'command', tokens: args.slice(i), assignments };
}

/** A segment reduced to the command that will actually execute. */
interface Unwrapped {
  seg: Segment;
  /** Wrapper names peeled off, outermost first. Empty when nothing was wrapped. */
  wrappers: string[];
  /** Set when the wrapper's own arguments are what makes the segment refusable. */
  reason?: string;
}

/**
 * Peel wrappers until the segment names something that is not one.
 *
 * Recursive rather than one-shot because wrappers nest — `timeout 10 env nice
 * rm -rf x` is an `rm` — and peeling a single layer would answer for `env`.
 * Termination is structural: every peel consumes at least the wrapper's own
 * binary token.
 *
 * `piped` and `expandable` carry through, so piping into a wrapped interpreter
 * is still a pipe into an interpreter, and a wrapped command whose arguments
 * are not fully visible still cannot take the silent fast path.
 */
function unwrap(seg: Segment, dialect: Dialect): Unwrapped {
  const wrappers: string[] = [];
  // Assignments accumulate across layers instead of staying on the layer that
  // carried them: `env FOO=bar rm -rf x` has to reach `refusalFor` as an `rm`
  // that carries an assignment, which is the shape ticket 06's refusal reads.
  const assignments = [...seg.assignments];
  let current: Segment = seg;

  while (WRAPPER_FAMILY[current.binary]) {
    const scan = scanWrapperArgs(current.binary, WRAPPER_FAMILY[current.binary], current.args);
    if (scan.kind === 'refuse') return { seg: { ...current, assignments }, wrappers, reason: scan.reason };
    // No residual command: the wrapper is the whole invocation (`env` on its
    // own prints the environment), so it is classified under its own name.
    if (scan.kind === 'no-exec' || scan.tokens.length === 0) break;

    assignments.push(...scan.assignments);
    wrappers.push(current.binary);
    const inner = toSegment(scan.tokens, current.piped, dialect);
    assignments.push(...inner.assignments);
    current = { ...inner, assignments: [], expandable: current.expandable };
  }

  return { seg: { ...current, assignments }, wrappers };
}

/** Lex a command line and every substitution body nested inside it. */
function lexAll(command: string, dialect: Dialect): Lexed {
  const queue: string[] = [];
  const top = lex(command, queue, dialect);
  const all: Lexed = { ...top, segments: top.segments.filter((s) => s.binary) };

  // Bounded: a pathological `$($($(…)))` must not spin here.
  for (let depth = 0; depth < 32 && queue.length > 0; depth++) {
    const inner = lex(queue.shift()!, queue, dialect);
    all.segments.push(...inner.segments.filter((s) => s.binary));
    all.unsafeRedirect ??= inner.unsafeRedirect;
    all.processSubstitution ||= inner.processSubstitution;
    all.unbalanced ||= inner.unbalanced;
  }
  return all;
}

/**
 * Path-shaped arguments, in every spelling a host might use.
 *
 * The Windows forms are not cosmetic. `pathLikeArgs` feeds
 * `BaseFileSystem.authorizeCommandPaths`, so an argument this function fails to
 * recognize is one the workspace-confinement prompt never sees. With only the
 * POSIX forms, `cat C:\Users\me\.ssh\id_rsa` matched nothing and ran
 * unprompted — ADR-0008's escape gate silently absent on that platform rather
 * than merely weaker.
 */
function looksLikePath(arg: string): boolean {
  if (arg.startsWith('--') && arg.includes('=')) return looksLikePath(arg.slice(arg.indexOf('=') + 1));
  return arg.startsWith('/')
    || arg.startsWith('~')
    || arg.startsWith('../')
    || arg === '..'
    || arg.startsWith('./')
    // Windows: drive-absolute (`C:\x`, `C:/x`), drive-relative (`C:x`), UNC
    // (`\\server\share`), and root-relative (`\x`).
    || /^[A-Za-z]:/.test(arg)
    || arg.startsWith('\\')
    || arg.startsWith('..\\')
    || arg.startsWith('.\\');
}

/**
 * Every path-shaped argument across every segment (including inside `$(…)`),
 * for the workspace-confinement check `bash()` runs before an `auto`-tier
 * command reaches the shell. `auto` classification only ever looked at the
 * binary — `cat`, `find`, `rg` and friends are auto because *reading* is
 * read-only, but their arguments can still point anywhere on disk, which is
 * exactly the escape path confinement closes for `readFile`/`glob`/`grep`.
 */
export function pathLikeArgs(command: string, opts: CommandPolicyOptions = {}): string[] {
  const dialect = dialectFor(opts.dialect);
  return lexAll(command, dialect).segments.flatMap((seg) => seg.args.flatMap((a) => {
    // `--flag=value` is excluded by the leading-dash filter but its value can
    // still name an external path, so split it and check the value.
    if (a.startsWith('--') && a.includes('=')) {
      const v = a.slice(a.indexOf('=') + 1);
      return looksLikePath(v) ? [v] : [];
    }
    return (!a.startsWith('-') && looksLikePath(a)) ? [a] : [];
  }));
}

function scopeFor(seg: Segment): string {
  if (!MULTIPLEXERS.includes(seg.binary)) return seg.binary;
  const sub = seg.args.find((a) => !a.startsWith('-'));
  return sub ? `${seg.binary} ${sub}` : seg.binary;
}

function isAuto(seg: Segment): boolean {
  if (!AUTO_COMMANDS.includes(seg.binary)) return false;
  // `x=/etc/passwd; cat $x` gives `cat` the lone argument `$x`, which
  // `pathLikeArgs`/`looksLikePath` cannot see is a path at all — the shell
  // resolves it to whatever the variable holds. An auto-tier command whose
  // arguments are not fully visible at classification time is exactly the
  // confinement escape this file exists to close, so treat any variable
  // reference as disqualifying the fast path rather than trying to resolve it.
  if (seg.expandable) return false;
  if (seg.binary !== 'git') return true;
  const sub = seg.args.find((a) => !a.startsWith('-'));
  return sub !== undefined && GIT_READONLY_SUBCOMMANDS.includes(sub);
}

function refusalFor(seg: Segment): string | undefined {
  if (REFUSED_COMMANDS.includes(seg.binary)) {
    return `"${seg.binary}" modifies state. You are a read-only planner — describe the change as a task instead, and the runner executing the plan will make it.`;
  }
  // `eval`/`exec` exist only to run a string as a command — the whole point of
  // this classifier is to inspect those strings, so they are never promptable.
  if (seg.binary === 'eval' || seg.binary === 'exec') {
    return `"${seg.binary}" runs a string as a command, which this classifier cannot inspect. Use the read-only research tools, or describe it as a task.`;
  }
  const subs = REFUSED_SUBCOMMANDS[seg.binary];
  if (subs) {
    const sub = seg.args.find((a) => !a.startsWith('-'));
    if (sub && subs.includes(sub)) {
      return `"${seg.binary} ${sub}" changes state or reaches outward. You are a read-only planner — put it in the plan and let the runner do it.`;
    }
  }
  // `git branch`/`git tag` are read-only subcommands, but their delete/move
  // flag forms mutate refs. The readonly-subcommand allowlist only inspects
  // the first non-flag argument, so these have to be caught here.
  if (seg.binary === 'git') {
    const sub = seg.args.find((a) => !a.startsWith('-'));
    if (sub === 'branch' || sub === 'tag') {
      const flag = seg.args.find((a) => ['-D', '-d', '-m', '-M', '--delete', '--move'].includes(a));
      if (flag) {
        return `"git ${sub} ${flag}" mutates refs. You are a read-only planner — describe the change as a task instead.`;
      }
    }
  }
  // `find` is auto because listing is read-only, but `-exec`/`-delete` make it
  // run an arbitrary inner command — the exact bypass this classifier exists
  // to close. Refuse rather than prompt: the inner command is unauditable.
  if (seg.binary === 'find') {
    const flag = seg.args.find((a) => ['-exec', '-execdir', '-ok', '-okdir', '-delete'].includes(a));
    if (flag) {
      return `find with "${flag}" runs an inner command this classifier cannot inspect. Use the read-only research tools on find's output, or describe the change as a task.`;
    }
  }
  // `sed -i`/`awk -i inplace` rewrite files in place — mutation, not research.
  const sedInPlace = seg.binary === 'sed'
    ? seg.args.find((a) => a === '-i' || a === '--in-place' || /^-i./.test(a))
    : undefined;
  if (sedInPlace) {
    return `"sed ${sedInPlace}" edits files in place. You are a read-only planner — describe the change as a task instead.`;
  }
  if (seg.binary === 'awk' && seg.args.some((a) => a === 'inplace')) {
    return `"awk -i inplace" edits files in place. You are a read-only planner — describe the change as a task instead.`;
  }
  if (INTERPRETERS.includes(seg.binary)) {
    if (seg.piped) {
      return `Piping into "${seg.binary}" would run code this classifier cannot inspect. Run the producing command on its own and read its output.`;
    }
    if (seg.args.some(isInlineCodeFlag)) {
      return `Inline code via "${seg.binary} ${seg.args.find(isInlineCodeFlag)}" is not available to the planner. Use the read-only research tools, or describe it as a task.`;
    }
  }
  // Checked last, so a segment whose binary or subcommand is refused on its own
  // terms still says so: `FOO=1 rm -rf x` is answered with `rm`, not with the
  // assignment, and the model does not have to strip the prefix only to be
  // refused a second time.
  //
  // Refused with no name list and no value inspection. A denylist of variable
  // names cannot stay complete, and an allowlist does not help either, because
  // the same name is benign or hostile depending on the value. Prompting was
  // rejected because grants are remembered at `scope` granularity and the scope
  // does not distinguish assignments, so one benign approval would cover a
  // hostile variant. This is the same treatment `eval`, `exec` and process
  // substitution already get: constructs whose effect this classifier cannot
  // read are refused, not asked.
  if (seg.assignments.length > 0) {
    return `The environment assignment "${seg.assignments[0]}" decides what "${seg.binary}" actually does, and this classifier cannot judge the value. Re-run the command without the assignment.`;
  }
  return undefined;
}

/**
 * Say the wrapper was seen through, so the model does not spend a turn trying
 * the next one. The refusal itself still names the wrapped command, per the same
 * rule that makes `FOO=1 rm -rf x` answer about `rm`: the answer has to be the
 * one the model can act on.
 */
function withWrapperNote(reason: string, wrappers: string[]): string {
  if (wrappers.length === 0) return reason;
  const quoted = wrappers.map((w) => `"${w}"`);
  const names = quoted.length > 1
    ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
    : quoted[0];
  return `${reason} Wrapping it in ${names} does not change what runs.`;
}

/**
 * Classify one command line. Output redirection is refused outright unless the
 * target provably writes nothing — `/dev/null`, or an fd duplication like
 * `2>&1` — since a planner that writes files has stopped being a planner.
 */
export function classifyCommand(command: string, opts: CommandPolicyOptions = {}): CommandClassification {
  const trimmed = command.trim();
  if (!trimmed) return { tier: 'refuse', scope: '', reason: 'Empty command.' };

  const dialect = dialectFor(opts.dialect);
  const { segments, unsafeRedirect, processSubstitution, unbalanced } = lexAll(trimmed, dialect);

  if (unbalanced) {
    return {
      tier: 'refuse',
      scope: '',
      reason: 'Unterminated quote or command substitution — this classifier cannot tell what would actually run. Rewrite the command with balanced quotes.',
    };
  }

  // Process substitution `<(…)`/`>(…)` spawns a process this classifier never
  // tokenizes — `cat <(rm -rf /)` would otherwise run `rm` with no prompt.
  if (processSubstitution) {
    return {
      tier: 'refuse',
      scope: '',
      reason: 'Process substitution runs another command this classifier cannot inspect. Run the command on its own and read its output, or describe it as a task.',
    };
  }

  if (unsafeRedirect) {
    const written = unsafeRedirect.target
      ? `"${unsafeRedirect.operator} ${unsafeRedirect.target}"`
      : `"${unsafeRedirect.operator}"`;
    return {
      tier: 'refuse',
      scope: '',
      reason: `${written} writes to a file. You are a read-only planner — read the output instead, or describe the write as a task.`,
    };
  }

  if (segments.length === 0) return { tier: 'refuse', scope: '', reason: 'No command found.' };

  // Every segment is reduced to the command that will actually execute first,
  // so `env`, `nice`, `timeout` and friends decide nothing about the answer.
  const unwrapped = segments.map((seg) => unwrap(seg, dialect));

  for (const { seg, wrappers, reason: wrapperReason } of unwrapped) {
    if (wrapperReason) return { tier: 'refuse', scope: '', reason: wrapperReason };
    const reason = refusalFor(seg);
    if (reason) return { tier: 'refuse', scope: '', reason: withWrapperNote(reason, wrappers) };
  }

  const nonAuto = unwrapped.map((u) => u.seg).filter((s) => !isAuto(s));
  if (nonAuto.length === 0) return { tier: 'auto', scope: '' };

  // A grant covers only the parts that actually needed one, so
  // `az group list | head` is remembered as `az group`, not the whole line.
  const scope = [...new Set(nonAuto.map(scopeFor))].sort().join(' + ');
  return { tier: 'ask', scope };
}
