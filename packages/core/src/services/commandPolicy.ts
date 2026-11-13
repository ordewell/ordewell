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
 * `timeout 10 env nice rm -rf x` is an `rm`. See {@link WRAPPER_FAMILY}. A
 * runner that feeds its command arguments nobody can see is unwrapped the same
 * way but never runs unprompted ({@link XARGS_TARGETS}), and one that hands its
 * command to a shell is refused ({@link REFUSED_RUNNERS}).
 *
 * A permitted binary is permitted with the flags it is known to be read-only
 * with, not with any flag at all: several of them will run a helper program or
 * write a file when asked to, so `auto` is a per-binary flag allowlist and an
 * unrecognised flag is refused. See {@link FLAG_POLICY}.
 *
 * The lexer is dialect-aware, because the interpreter that will actually run
 * the command decides what the tokens are, and getting that wrong is not a
 * cosmetic error here — it is the difference between classifying what runs and
 * classifying something else. See {@link Dialect}.
 */

import { ParsedLine, type LineShell } from './parsedLine';
import { SHELL_STATE_COMMANDS, literalCdTarget, mayBecomeFlag, mayBeginWith, mayExpandTo, shellRewrites, type Segment } from './shellLexer';
import { REFUSED_RUNNERS, XARGS_TARGETS, unwrap } from './commandRunners';
import { FLAG_POLICY, UNIVERSAL_FLAGS, flagLabel, matchFlag, scanFlags, subcommandOf, subcommandShifter, takesNextToken, valueFlagIn } from './flagPolicy';
import { AWK_FAMILY, JQ_FAMILY, SED_FAMILY, awkProgramArgs, awkRefusal, jqProgramEnd, jqRefusal, sedOnlyPrints, sedProgramArgs, sedRefusal } from './filterPrograms';
import { commandAllowedBy, commandExcludedBy, scopeExcluded, type PlannerAllowlist } from './plannerAllowlist';
import { EFFECT_REFUSAL_HINT, READ_REFUSAL_HINT, webCommand, wgetVersionCommands } from './webCommands';
import { EFFECT_ROUTE } from './effectRoute';

export type { Dialect } from './shellLexer';

/**
 * `env` is deliberately absent. Given a command it is a wrapper, classified by
 * what it actually runs (see {@link WRAPPER_FAMILY}); given none it prints the
 * whole process environment — provider credentials included — into the research
 * log, which is a disclosure the developer should get to see coming.
 *
 * Membership here is necessary but not sufficient: every name in this list also
 * declares the flags it is read-only with in {@link FLAG_POLICY}.
 */
export const AUTO_COMMANDS = [
  'ls', 'tree', 'git', 'wc', 'du', 'df', 'file', 'head', 'tail', 'cat', 'sort', 'uniq',
  'echo', 'printf', 'date', 'stat', 'basename', 'dirname', 'realpath', 'pwd',
  'which', 'type', 'uname', 'whoami', 'cut', 'nl', 'rg', 'grep', 'find', 'jq', 'yq',
];


/**
 * `ls-remote` is deliberately absent, and it is the one entry here that is
 * read-only against the repository. It reaches the network: it contacts
 * whatever host the named remote or URL resolves to, which routes around the
 * web fetcher's per-origin approval and its request-forgery guard. So it
 * prompts rather than running silently, and only for a remote the repository
 * configures: a destination the line spells out is refused
 * ({@link namesConfiguredRemote}), and the grant is the whole line
 * ({@link gitScope}), so no approval of one remote covers another.
 */
export const GIT_READONLY_SUBCOMMANDS = [
  'log', 'status', 'diff', 'show', 'ls-files', 'ls-tree', 'branch', 'tag',
  'rev-parse', 'rev-list', 'describe', 'blame', 'grep', 'shortlog', 'whatchanged', 'cat-file',
];

const onlyAction = (...reads: string[]) => (after: string[]): boolean =>
  after[0] === undefined || reads.includes(after[0]);

/**
 * The git subcommands outside {@link GIT_READONLY_SUBCOMMANDS} that may run once
 * approved, each with a test of the arguments after it under which it only
 * reads. Every other subcommand is refused.
 *
 * An allowlist because a list of git's writers was never complete: with
 * `rm`, `mv` and the rest refused, `git symbolic-ref HEAD refs/heads/x`,
 * `git hash-object -w`, `git update-server-info` and `git commit-graph write`
 * still asked, and the first two share a scope with their read, so one
 * approval of the read ran the write with no second prompt. An alias the
 * repository defines is refused with them: it can run a shell command.
 *
 * The test reads positionally: a subcommand's action is the word right after
 * it, and `symbolic-ref` with a second name writes, so a flag value counted as
 * a name refuses rather than asks.
 */
const GIT_PROMPTABLE: Record<string, (after: string[], seg: Segment) => boolean> = {
  'ls-remote': () => true,
  'for-each-ref': () => true,
  'show-ref': () => true,
  'name-rev': () => true,
  'merge-base': () => true,
  'count-objects': () => true,
  'cherry': () => true,
  'range-diff': () => true,
  'diff-tree': () => true,
  'diff-files': () => true,
  'diff-index': () => true,
  'show-branch': () => true,
  'annotate': () => true,
  'check-ignore': () => true,
  'check-attr': () => true,
  'check-ref-format': () => true,
  'check-mailmap': () => true,
  'var': () => true,
  'version': () => true,
  'worktree': onlyAction('list'),
  'notes': onlyAction('list', 'show'),
  'bisect': onlyAction('log'),
  'sparse-checkout': onlyAction('list'),
  'reflog': onlyAction('show', 'exists'),
  // A second operand writes the ref, and a word the shell may split may be one.
  'symbolic-ref': (after, seg) => after.filter((a) => !a.startsWith('-')).length <= 1
    && !after.some((a) => shellRewrites(seg, a)),
  // `-w` writes the object; git's shared flag set keeps it for `git diff -w`.
  'hash-object': (after) => !after.some((a) => /^-[^-]*w/.test(a)),
};

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

/**
 * Destructive or outward-facing subcommands of otherwise-permitted multiplexers.
 *
 * git's list names its commonest writers so the refusal says so; any other
 * subcommand not known to read is refused by {@link GIT_PROMPTABLE}.
 */
const REFUSED_SUBCOMMANDS: Record<string, string[]> = {
  git: ['push', 'reset', 'clean', 'checkout', 'switch', 'restore', 'rebase', 'merge', 'commit',
    'am', 'apply', 'cherry-pick', 'revert', 'stash', 'gc', 'prune', 'filter-branch',
    'update-ref', 'remote', 'config', 'init', 'clone', 'fetch', 'pull', 'submodule',
    'add', 'rm', 'mv', 'format-patch', 'replace', 'mergetool',
    'repack', 'update-index', 'read-tree', 'checkout-index', 'merge-file', 'bundle',
    'commit-tree', 'write-tree', 'mktree', 'mktag', 'unpack-objects', 'fast-import',
    'pack-refs', 'prune-packed', 'maintenance'],
  npm: ['publish', 'unpublish', 'deprecate', 'owner', 'access', 'token', 'login', 'logout'],
  yarn: ['publish', 'npm'],
  pnpm: ['publish'],
  docker: ['push', 'rm', 'rmi', 'kill', 'stop', 'prune', 'system'],
  kubectl: ['delete', 'apply', 'create', 'patch', 'replace', 'edit', 'drain', 'cordon', 'scale'],
  gh: ['release', 'secret', 'auth'],
  az: ['login', 'logout'],
  terraform: ['apply', 'destroy'],
};

/**
 * Shell reserved words and compound-command openers. `toSegment` takes the
 * first token as `seg.binary` with no keyword awareness, so any of these
 * leading a segment hides the command it introduces as an unrecognized
 * argument instead of exposing it to classification. `(`/`)` are absent
 * because the lexer already strips subshell grouping before tokenizing. `!`
 * negates a pipeline's status and still runs it.
 */
const SHELL_KEYWORDS = ['{', '}', 'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until',
  'do', 'done', 'case', 'esac', 'select', 'function', 'time', 'export', '!'];

/**
 * Binaries that execute whatever they are handed — refused when given inline code or fed from a pipe.
 * `xargs` is not here: it is unwrapped to the command it runs, see {@link XARGS_TARGETS}.
 * Matched by family, see {@link interpreterFamily}.
 */
const INTERPRETERS = ['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell',
  'python', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'eval', 'exec',
  // Windows interpreters. `cmd /c "…"` is the platform's spelling of `sh -c`.
  'cmd', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32'];

/** Other names an interpreter family is installed under. */
const INTERPRETER_ALIASES: Record<string, string> = { nodejs: 'node', pypy: 'python' };

/**
 * The interpreter family a binary belongs to, or undefined. Distributions
 * install the plain name with a version and often a build or channel suffix
 * beside it (`python3.12`, `node22`, `php8.2`, `python3.12m`, `python3.12-dbg`,
 * `pwsh-preview`), and an exact-name list let every one of them run inline code
 * at the prompt tier. The suffix must start with a digit or a `-`, so a
 * different tool whose name merely begins with a family name (`nodemon`,
 * `bundle`) is not swept in.
 */
function interpreterFamily(binary: string): string | undefined {
  const direct = INTERPRETER_ALIASES[binary] ?? binary;
  if (INTERPRETERS.includes(direct)) return direct;
  for (const base of [...INTERPRETERS, ...Object.keys(INTERPRETER_ALIASES)]) {
    if (new RegExp(`^${base}(?=[0-9-])[0-9.]*(?:-?[A-Za-z][A-Za-z0-9]*)?$`).test(binary)) {
      return INTERPRETER_ALIASES[base] ?? base;
    }
  }
  return undefined;
}

/** Runtimes that import a module from a `data:` URL, which is code written inline. */
const DATA_URL_RUNTIMES = ['node', 'deno', 'bun'];

/**
 * Flags that hand an interpreter code to run. Compared case-insensitively:
 * cmd.exe and PowerShell both accept their switches in any casing, so a
 * case-sensitive list refused `-Command` and waved `-command` through.
 */
const INLINE_CODE_FLAGS = ['-c', '-e', '--eval', '--command', '-Command', '--exec', '/c', '/k', '/r',
  '--print', '--run', '--process-begin', '--process-code', '--process-end'];

/**
 * Short code flags, per interpreter, matched anywhere in a single-dash token.
 * Exact matching missed the spellings these binaries actually accept: a cluster
 * (`bash -lc`, `perl -lne`, `node -pe`) and code glued on (`perl -e'…'`,
 * `python -c'…'`). A letter that is really part of a glued value (`perl
 * -MData::Dumper`) refuses too — when unsure, refuse.
 */
const INLINE_CODE_LETTERS: Record<string, string> = {
  sh: 'c', bash: 'c', zsh: 'c', fish: 'c', dash: 'c', ksh: 'c', csh: 'c', tcsh: 'c',
  python: 'c', py: 'c',
  node: 'ep', bun: 'ep', ruby: 'e', perl: 'e', php: 'rbe',
};

/**
 * PowerShell binds any unambiguous prefix of a parameter name, in any casing,
 * after `-`, `--` or `/` — so `-enc` and `-EncodedC` are `-EncodedCommand`.
 * Ambiguous prefixes (`-co`) are refused with the rest.
 */
const PWSH_CODE_PARAMS = ['command', 'encodedcommand', 'commandwithargs'];
const PWSH_CODE_ALIASES = ['ec', 'cwa'];

function isInlineCodeFlag(binary: string, arg: string): boolean {
  const lower = flagLabel(arg).toLowerCase();
  if (INLINE_CODE_FLAGS.some((f) => f.toLowerCase() === lower)) return true;
  if (binary === 'pwsh' || binary === 'powershell') {
    const name = /^(?:--?|\/)([a-z]+)(?::|$)/.exec(arg.toLowerCase())?.[1];
    return name !== undefined && (PWSH_CODE_ALIASES.includes(name) || PWSH_CODE_PARAMS.some((p) => p.startsWith(name)));
  }
  // cmd.exe reads `/c` wherever it sits in a run of switches, with the command
  // glued straight on, and after the `,` it reads as a space: `cmd /q/c del x`,
  // `cmd /cdel x`, `cmd ,/c del x`.
  if (binary === 'cmd') return /\/[ckr]/i.test(arg);
  const letters = INLINE_CODE_LETTERS[binary];
  return letters !== undefined && /^-[^-]/.test(arg) && [...lower.slice(1)].some((ch) => letters.includes(ch));
}

/**
 * PowerShell's parameters that take a value, and the switches that take none,
 * as {@link pwshPositional} reads them. Matched by prefix like the code
 * parameters above.
 */
const PWSH_VALUE_PARAMS = ['configurationname', 'configurationfile', 'custompipename', 'executionpolicy',
  'inputformat', 'outputformat', 'psconsolefile', 'settingsfile', 'version', 'windowstyle', 'workingdirectory'];
const PWSH_VALUE_ALIASES = ['ep', 'if', 'of', 'wd'];
const PWSH_SWITCH_PARAMS = ['help', 'interactive', 'login', 'mta', 'noexit', 'nologo', 'noninteractive',
  'noprofile', 'noprofileloadtime', 'sshservermode', 'sta'];

/**
 * The argument PowerShell runs as code because no parameter named it, if any.
 *
 * The first argument that is not a parameter is `-Command` to Windows
 * PowerShell, and `-File` to `pwsh`, so `powershell Remove-Item x` runs
 * `Remove-Item` with no code flag in sight. Only a plain `.ps1` path passes:
 * under `powershell`, only as the last argument, since every later one is
 * joined into the command. A parameter it cannot place — unknown, or a
 * prefix of both a switch and a value parameter — fails closed.
 */
function pwshPositional(binary: string, args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const param = /^(?:--?|\/)([a-z?]+)(:.*)?$/i.exec(arg);
    if (!param) {
      const script = /^[^\s;&|(){}$`'"]+\.ps1$/i.test(arg);
      return script && (binary === 'pwsh' || i === args.length - 1) ? undefined : arg;
    }
    const name = param[1].toLowerCase();
    if ('file'.startsWith(name)) return undefined;
    const takesValue = PWSH_VALUE_ALIASES.includes(name) || PWSH_VALUE_PARAMS.some((p) => p.startsWith(name));
    const isSwitch = name === '?' || PWSH_SWITCH_PARAMS.some((p) => p.startsWith(name));
    if (takesValue === isSwitch) return arg;
    if (takesValue && param[2] === undefined) i++;
  }
  return undefined;
}

/** Binaries whose leading arguments name the operation, and so belong in a grant's scope. */
const MULTIPLEXERS = ['git', 'npm', 'yarn', 'pnpm', 'npx', 'cargo', 'go', 'dotnet', 'docker', 'podman',
  'kubectl', 'helm', 'az', 'aws', 'gcloud', 'gh', 'glab', 'terraform', 'make', 'mvn', 'gradle',
  'composer', 'pip', 'pip3', 'poetry', 'uv', 'bundle', 'rake', 'swift', 'flutter', 'dart'];


/**
 * What classification weighs beyond the line itself. The shell the line runs
 * in is not here: it is read once into the {@link ParsedLine}.
 */
export interface PolicyInputs {
  /** Only flags generated from vetted DNS answers by BaseFileSystem, never caller input. */
  trustedWebResolves?: ReadonlySet<string>;
  autonomous?: boolean;
  approvalMode?: 'ask' | 'allow' | 'deny';
  /** The planner's standing approvals (ADR-0026); an `ask` command they cover carries {@link CommandClassification.allowedBy}. */
  allow?: PlannerAllowlist;
}

/** A string line's shell with the policy inputs, for a caller that classifies one line once. */
export type CommandPolicyOptions = PolicyInputs & LineShell;

function lineOf(line: string | ParsedLine, shell: LineShell): ParsedLine {
  return typeof line === 'string' ? ParsedLine.parse(line, shell) : line;
}

export type CommandTier = 'auto' | 'ask' | 'refuse';

export interface CommandClassification {
  tier: CommandTier;
  /** A human must approve this invocation even when its origin was already granted. */
  perInvocation?: boolean;
  /** Separate grants for commands that name several origins. */
  scopes?: string[];
  webUrls?: URL[];
  /** What a network-reaching command sends, for the outbound secret check (ADR-0027): a web command's URLs and values, a remote listing's remote and patterns. */
  outboundTexts?: string[];
  /** What a grant covers, for `ask`. Derived from the non-auto segments only. */
  scope: string;
  /** Populated for `refuse`: why, in a sentence the model can act on. */
  reason?: string;
  /** For `ask`: the allowlist rule that pre-approves every part of the command that needed asking. */
  allowedBy?: string;
}


export interface PathRef {
  path: string;
  /** The `cd` targets, in order, the path is relative to — empty for the workspace root. */
  cwd: string[];
}

/**
 * A path glued straight onto a short flag, the short form of `--flag=value`:
 * `-C/etc`, or `-xf/tmp/a.tar` after a run of boolean letters. Which letters
 * take a value differs by binary, so every suffix past the first letter is
 * tried; reading one too many costs a prompt, one too few costs confinement.
 */
function gluedValue(arg: string): string | undefined {
  if (arg.startsWith('--')) return undefined;
  for (let i = 2; i < arg.length; i++) if (looksLikePath(arg.slice(i))) return arg.slice(i);
  return undefined;
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
    || arg.startsWith('.\\')
    // A `..` segment anywhere, not only in front: `src/../../etc/passwd` climbs
    // out through a directory that exists, and read as a plain relative name
    // it skipped confinement entirely.
    || /(^|[\\/])\.\.([\\/]|$)/.test(arg);
}

/**
 * Every path-shaped argument across every segment (including inside `$(…)`),
 * for the workspace-confinement check `bash()` runs before an `auto`-tier
 * command reaches the shell. `auto` classification only ever looked at the
 * binary — `cat`, `find`, `rg` and friends are auto because *reading* is
 * read-only, but their arguments can still point anywhere on disk, which is
 * exactly the escape path confinement closes for `readFile`/`glob`/`grep`.
 */
export function pathRefs(line: ParsedLine): PathRef[];
export function pathRefs(command: string, shell?: LineShell): PathRef[];
export function pathRefs(line: string | ParsedLine, shell: LineShell = {}): PathRef[] {
  return lineOf(line, shell).segments.flatMap((seg) => {
    const { patterns } = patternArgs(seg);
    const cwd = seg.cwd ?? [];
    return [...seg.args.filter((_, i) => !patterns.has(i)), ...seg.inputs]
      .flatMap(pathIn)
      .map((path) => ({ path, cwd }));
  });
}

/**
 * The `!` allowlist entry naming a command on this line, read from every word
 * of every segment the lexer finds, or undefined (ADR-0036 S3). Not a
 * classification: a line the classifier refuses unread can still run sealed,
 * and the user's exclusion holds for it all the same.
 */
export function excludedBy(line: ParsedLine, allow: PlannerAllowlist): string | undefined;
export function excludedBy(command: string, allow: PlannerAllowlist, shell?: LineShell): string | undefined;
export function excludedBy(line: string | ParsedLine, allow: PlannerAllowlist, shell: LineShell = {}): string | undefined {
  for (const seg of lineOf(line, shell).segments) {
    const rule = commandExcludedBy(allow, [seg.binary, ...seg.args]);
    if (rule) return rule;
  }
  return undefined;
}

/**
 * The command scope each segment the lexer finds would be remembered under,
 * one per distinct non-auto segment (ADR-0036 S3). A denial on the card is
 * keyed on these scopes, so a sealed run must check them, not only the whole
 * command string: `npm test` denied once also refuses `for f in *; do npm
 * test; done`, which the classifier refuses unread and which would otherwise
 * run sealed under a request that names the whole loop. Read-only segments
 * carry no scope and are left out, as they are never asked about.
 */
export function innerCommandScopes(line: ParsedLine): string[];
export function innerCommandScopes(command: string, shell?: LineShell): string[];
export function innerCommandScopes(input: string | ParsedLine, shell: LineShell = {}): string[] {
  const line = lineOf(input, shell);
  const scopes = new Set<string>();
  for (const seg of line.segments) {
    // The lexer keeps a compound-command opener as the segment's first word and
    // the command it heads among the words after it (`do npm test` is one
    // segment). Step past the openers, then unwrap any runner, so the command a
    // loop body runs is scoped under the same name a denial on the card is
    // remembered as — the scope its own classification produced.
    let binary = seg.binary;
    let args = seg.args;
    while (SHELL_KEYWORDS.includes(binary) && args.length > 0) [binary, ...args] = args;
    if (SHELL_KEYWORDS.includes(binary)) continue;
    const { seg: inner, runner } = unwrap({ ...seg, binary, args, binaryPath: undefined }, line.dialect);
    if (runner !== undefined || !isAuto(inner, line)) scopes.add(scopeFor(inner));
  }
  return [...scopes];
}

/**
 * A literal `cd` that `followCd` left unfollowed, so the paths after it were
 * judged from the workspace root: worth saying in a refusal, since the model
 * otherwise sees a path it never meant.
 */
export function cdUnfollowed(line: ParsedLine): boolean {
  const { segments } = line;
  return segments.some((seg, i) => !seg.nested && literalCdTarget(seg) !== undefined
    && segments.slice(i + 1).some((later) => !later.nested && !later.cwd?.length));
}

export function pathLikeArgs(command: string, shell: LineShell = {}): string[] {
  return pathRefs(command, shell).map((r) => r.path);
}

function pathIn(a: string): string[] {
  // `--flag=value` is excluded by the leading-dash filter but its value can
  // still name an external path, so split it and check the value.
  if (a.startsWith('--') && a.includes('=')) {
    const v = a.slice(a.indexOf('=') + 1);
    return looksLikePath(v) ? [v] : [];
  }
  if (a.startsWith('-')) {
    const glued = gluedValue(a);
    return glued ? [glued] : [];
  }
  return looksLikePath(a) ? [a] : [];
}

/**
 * Where a search binary takes a pattern rather than a file. A pattern is
 * matched against text or names and never opened, so it is no reason to ask
 * about leaving the workspace — `grep "/api/users" src` used to.
 */
interface PatternSpec {
  /** Flags whose value is a pattern. */
  flags: string[];
  /** The first operand is the pattern, unless one of these flags was given. */
  leadingUnless?: string[];
  /** The leading-operand rule applies only under this subcommand. */
  subcommand?: string;
  /**
   * Flags the binary's shared flag set reads as taking a value but which take
   * none under {@link subcommand}: `git log -n 5`, but `git grep -n PATTERN`.
   */
  subcommandBooleans?: string[];
}

const PATTERN_ARGS: Record<string, PatternSpec> = {
  grep: { flags: ['-e', '--regexp'], leadingUnless: ['-e', '--regexp', '-f', '--file'] },
  rg: {
    flags: ['-e', '--regexp', '-g', '--glob', '--iglob', '-r', '--replace'],
    leadingUnless: ['-e', '--regexp', '-f', '--file', '--files', '--type-list'],
  },
  git: {
    flags: ['-e', '-S', '-G', '--grep', '--author', '--committer'],
    leadingUnless: ['-e', '-f'],
    subcommand: 'grep',
    subcommandBooleans: ['-n', '-W', '-L', '-x', '-G'],
  },
  find: {
    flags: ['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex',
      '-lname', '-ilname'],
  },
};

/** Which of `seg.args` stand where a pattern or filter program does. */
interface PatternWords {
  /** Never opened as files: kept out of confinement and the climb check. */
  patterns: Set<number>;
  /**
   * In a pattern's place, but the shell may make the word several: the first
   * is the pattern and the rest are opened, so `grep -e /etc/p* src` searches
   * /etc/profile. Such a word is confined like a path.
   */
  split: Set<number>;
}

/**
 * Where `seg.args` holds patterns or filter programs, not paths.
 *
 * Fails closed: a flag outside the binary's declared set might take the next
 * token or not, so past one nothing is called a pattern. Mistaking a path for a
 * pattern would skip confinement; the reverse costs one prompt.
 */
function patternArgs(seg: Segment): PatternWords {
  const none: PatternWords = { patterns: new Set(), split: new Set() };
  if (SED_FAMILY.includes(seg.binary)) return { ...none, patterns: new Set(sedProgramArgs(seg.binary, seg.args)) };
  if (AWK_FAMILY.includes(seg.binary)) return { ...none, patterns: new Set(awkProgramArgs(seg.binary, seg.args)) };
  const rule = PATTERN_ARGS[seg.binary];
  const spec = FLAG_POLICY[seg.binary];
  if (!rule || !spec) return none;

  const booleans = new Set([...(spec.booleans ?? []), ...UNIVERSAL_FLAGS]);
  const values = new Set(spec.values ?? []);
  const { patterns, split } = { patterns: new Set<number>(), split: new Set<number>() };
  // An expression binary is left out: there a shifted or split pattern lands
  // as a stray word after the expression, which find rejects.
  const splits = (at: number) => !spec.expressionArgs && shellRewrites(seg, seg.args[at]);
  const operands: number[] = [];
  let patternGiven = false;
  // From the first operand or flag value the shell may split, which operand is
  // the leading pattern is the shell's to decide: `grep -v --exclude src/*
  // /etc/passwd` makes `src/b.ts` the pattern and reads /etc/passwd. A flag's
  // own value is not moved by it, since a split word that may become a flag or
  // `--` is refused (scanFlags).
  let spreadAt = Infinity;
  const counts = (at: number) => { if (at < spreadAt && splits(at)) spreadAt = at; };

  for (let i = 0; i < seg.args.length; i++) {
    const token = seg.args[i];
    if (token === '--' && !spec.expressionArgs) {
      for (let j = i + 1; j < seg.args.length; j++) { counts(j); operands.push(j); }
      break;
    }
    if (!/^-./.test(token)) { counts(i); operands.push(i); continue; }

    const inSubcommand = rule.subcommand !== undefined && seg.args[operands[0]] === rule.subcommand;
    if (inSubcommand && rule.subcommandBooleans?.includes(token)) continue;
    const shape = matchFlag(spec, booleans, values, token);
    if (shape === undefined) return none;
    const flag = valueFlagIn(token, booleans, values) ?? flagLabel(token);
    if (rule.leadingUnless?.includes(flag)) patternGiven = true;
    const consumes = shape === 'value' && takesNextToken(seg.args[i + 1]);
    if (consumes) counts(i + 1);
    if (rule.flags.includes(flag) && values.has(flag)) {
      // A glob after `--name=` stays that one flag's value, however many words it becomes.
      if (consumes) (splits(i + 1) ? split : patterns).add(i + 1);
      else patterns.add(i);
    }
    if (consumes) i++;
  }

  if (rule.leadingUnless && !patternGiven) {
    const leading = rule.subcommand
      ? seg.args[operands[0]] === rule.subcommand ? operands[1] : undefined
      : operands[0];
    if (leading !== undefined && leading <= spreadAt) (leading === spreadAt ? split : patterns).add(leading);
  }
  return { patterns, split };
}


/**
 * How many leading arguments a scope carries past the binary.
 *
 * Two rather than one because multiplexers nest: `uv pip list` needs both
 * before the verb is even visible, and one would have scoped it to the inner
 * multiplexer with every verb sharing that grant.
 */
const SCOPE_LEAD_ARGS = 2;

/**
 * What a remembered approval covers.
 *
 * Scope used to be the binary plus its *first* non-flag argument, which
 * collapsed distinct operations onto one grant — approving a read authorised
 * the matching write. Three of those were confirmed by probing:
 *
 *   - `npm run <script>` scoped to `npm run`, so approving the project's test
 *     script pre-authorised every other script in the workspace manifest. This
 *     is the sharpest of the three: on an untrusted repository the attacker
 *     wrote those scripts, and approving a test run is the single most
 *     reasonable approval a developer is ever asked for.
 *   - `az group list` and `az group delete` shared `az group`.
 *   - `aws s3 ls` and `aws s3 rm` shared `aws s3`.
 *
 * So the scope takes the leading non-flag arguments, capped at
 * {@link SCOPE_LEAD_ARGS}. Walking stops at the **first flag**, which is what
 * keeps flag values out of the scope: `docker logs -n 5 web` and
 * `docker logs -n 100 web` are one stable grant rather than a fresh prompt per
 * limit. The cost of stopping there is that a leading flag empties the lead
 * entirely — `mvn -q test` scopes to `mvn` — and that is accepted deliberately,
 * because a scope that varies with a flag value is a scope that prompts forever.
 *
 * Positional rather than flag-aware on purpose. {@link subcommandOf} walks the
 * declared flag sets to find a subcommand, and that is right for deciding a
 * tier; here it would mean the scope depends on how completely a binary's flags
 * happen to be declared, so the same command line could widen its own grant as
 * the flag tables change. git, whose flags are all declared, is the exception:
 * see {@link gitScope}.
 */
function scopeFor(seg: Segment): string {
  // A program named by its path keeps the path: a grant for `gh` is not one for the repository's `./bin/gh`.
  const name = seg.binaryPath ?? seg.binary;
  const program = programName(seg.binary);
  if (!MULTIPLEXERS.includes(program)) return name;
  if (program === 'git') return gitScope(seg, name);
  const lead: string[] = [];
  for (const arg of seg.args) {
    if (arg.startsWith('-')) break;
    lead.push(arg);
    if (lead.length === SCOPE_LEAD_ARGS) break;
  }
  return [name, ...lead].join(' ');
}

/**
 * git's scope, read from its operands rather than its leading words.
 *
 * git is the one multiplexer whose every flag is declared ({@link FLAG_POLICY}),
 * and one it does not know is refused, so a git command that asks has had each
 * flag and its value read: the walk cannot widen a grant the way the note on
 * {@link scopeFor} fears. Stopping at the first flag here emptied the lead for
 * the commonest spelling of all, `git -C <dir> …`, and one approval of a
 * worktree listing became a grant for bare `git`.
 *
 * `ls-remote` is scoped to its whole command line. It reaches whichever
 * address the repository `-C` chooses configures for the remote it names, so
 * the directory, the remote and the patterns it sends all belong in what was
 * approved, and a flag before them must not drop them from the scope.
 */
function gitScope(seg: Segment, name: string): string {
  const scan = scanFlags({ ...seg, binary: 'git' });
  if (!scan || scan.unknown || scan.operands[0] === 'ls-remote') return [name, ...seg.args].map(scopeWord).join(' ');
  return [name, ...scan.operands.slice(0, SCOPE_LEAD_ARGS)].join(' ');
}

/** A word as an exact scope shows it: quoted where a space or quote would make two spellings read alike. */
function scopeWord(word: string): string {
  return word === '' || /[\s"'\\]/.test(word) ? JSON.stringify(word) : word;
}

/**
 * A file name word the shell may expand through `..`. bash 3.2 (macOS
 * `/bin/sh`) and dash let a name segment that starts with a dot match `..`,
 * so `.?`, `.*` and `.[.]` climb out of the workspace under a spelling that
 * {@link looksLikePath} and lexical confinement both read as inside it. The
 * lexer only says some word in the segment is an unquoted glob, so a quoted
 * look-alike beside one asks too; patterns are skipped, since they are never
 * opened (ADR-0008).
 */
function climbsByGlob(seg: Segment): boolean {
  if (!seg.globbed) return false;
  const { patterns, split } = patternArgs(seg);
  // A split pattern is checked by what it may become: read with the rough test
  // below, a quoted regex beside a glob (`grep -E ".*TODO" src/*.ts`) would ask.
  if ([...split].some((i) => seg.args[i].split(/[\\/]/).some((part) => part.startsWith('.') && mayExpandTo(seg, part, '..')))) return true;
  return [...seg.args.filter((_, i) => !patterns.has(i) && !split.has(i)), ...seg.inputs]
    .some((a) => /(^|[\\/])\.[*?[]/.test(a));
}

function isAuto(seg: Segment, line: ParsedLine): boolean {
  // Navigation is read-only, but only a target the command line spells out, on
  // a line where nothing else can steer it. Its effect on later commands is
  // followed by `followCd`, or ignored in the fallback, where a path judged
  // from the workspace root is never more permissive than from a deeper
  // directory the root contains.
  if (seg.binary === 'cd') return !line.cdpathSet && !seg.cdSteered && literalCdTarget(seg) !== undefined;
  const printsLines = SED_FAMILY.includes(seg.binary) && sedOnlyPrints(seg.args);
  if (!AUTO_COMMANDS.includes(seg.binary) && !printsLines) return false;
  // `./cat` is whatever file the repository ships under that name, not `cat`.
  if (seg.binaryPath !== undefined) return false;
  // `x=/etc/passwd; cat $x` gives `cat` the lone argument `$x`, which
  // `pathLikeArgs`/`looksLikePath` cannot see is a path at all — the shell
  // resolves it to whatever the variable holds. An auto-tier command whose
  // arguments are not fully visible at classification time is exactly the
  // confinement escape this file exists to close, so treat any variable
  // reference as disqualifying the fast path rather than trying to resolve it.
  if (seg.expandable) return false;
  if (climbsByGlob(seg)) return false;
  if (seg.binary !== 'git') return true;
  const sub = subcommandOf(seg);
  return sub !== undefined && GIT_READONLY_SUBCOMMANDS.includes(sub);
}

/**
 * A short flag, alone or inside a cluster, that git's shared flag set reads as
 * taking a value (for `git log`) but that under `git branch`/`git tag` is a
 * force, move or copy whose operand is the ref it writes: `git tag -f v1`,
 * `git branch -qC copied`. Read that way it swallowed the ref name, so the
 * positional check never saw one. `-n` is spared: `git tag -n` lists.
 */
function swallowsRefName(arg: string): boolean {
  if (!/^-[^-]/.test(arg)) return false;
  const values = FLAG_POLICY.git.values ?? [];
  return [...arg.slice(1)].some((c) => c !== 'n' && values.includes(`-${c}`));
}

/**
 * The arguments after git's subcommand, located by walking git's flags. The
 * first word spelled like the subcommand is not it: in `git -C worktree
 * worktree list` that word is the directory.
 */
function gitArgsAfterSubcommand(seg: Segment): string[] {
  const at = scanFlags(seg)?.operandAt[0];
  return at === undefined ? [] : seg.args.slice(at + 1);
}

/** A word git can only read as the name of a configured remote: no scheme, host separator, path or expansion. */
const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Whether `git ls-remote` lists a remote the repository configures, or its
 * default one, rather than a destination the command line spells out. A URL,
 * an scp-style `host:path`, a `transport::address` or a path is refused, not
 * asked: git connects to it with its own resolver and follows a redirect, so
 * no approval of the text can say where the request lands.
 */
function namesConfiguredRemote(seg: Segment, after: string[]): boolean {
  const destination = scanFlags({ ...seg, args: after })?.operands[0];
  return destination === undefined || REMOTE_NAME.test(destination);
}

/**
 * The program a binary name runs, as refusal and scope read it. Git Bash, the
 * Windows research shell, lexes as posix, so `git.exe` reaches the tiers with
 * its suffix where the cmd dialect strips it, and it missed every git refusal.
 * Only refusal and scope read it: the silent tier stays exact.
 */
function programName(binary: string): string {
  return binary.toLowerCase().replace(/\.exe$/, '');
}

function isRemoteListing(seg: Segment): boolean {
  const git = { ...seg, binary: programName(seg.binary) };
  return git.binary === 'git' && subcommandOf(git) === 'ls-remote';
}

/** The words `git ls-remote` sends its remote: the remote's name and the patterns, which protocol v2 passes on as ref prefixes. */
function remoteListingTexts(seg: Segment): string[] {
  if (!isRemoteListing(seg)) return [];
  const git = { ...seg, binary: 'git' };
  return scanFlags({ ...git, args: gitArgsAfterSubcommand(git) })?.operands ?? [];
}

/** find's actions that run a command, delete, or write a file: each a single word the shell may assemble. */
const FIND_ACTIONS = ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'];

/** The arguments up to and including the first one the shell passes as written. */
function leadingWords(seg: Segment): string[] {
  const end = seg.args.findIndex((a) => !shellRewrites(seg, a));
  return end < 0 ? seg.args : seg.args.slice(0, end + 1);
}

/**
 * Every flag check here compares the words as written, and the shell expands a
 * glob, a brace list or a variable before the program sees it: `sort -k *`
 * becomes `sort -k -oout …` once the repository holds a file named `-oout`
 * (ADR-0008). Such a word is read as possibly any flag, so it is refused.
 */
function expandedFlagReason(binary: string, word: string): string {
  return `The shell may expand "${word}" into a flag for "${binary}" (a file named "-…" matches a glob, and a variable or substitution can hold one), and flags are only read-only as written. Start a file glob with "./" or put it after "--", write variables out literally, and re-run.`;
}

function refusalFor(seg: Segment, trustedResolves?: ReadonlySet<string>): string | undefined {
  const web = webCommand(seg, trustedResolves);
  if (web?.reason) return web.reason;
  // Nothing else about the segment means anything when the name of what runs
  // is only known once the shell has run the substitution or read the variable.
  if (seg.computedBinary !== undefined) {
    return `"${seg.computedBinary}" is a command name the shell computes as it runs, so this classifier cannot tell what would run. Name the program directly.`;
  }
  // A cmd.exe command word cmd reads a delimiter inside of: a `/` (cmd ends the
  // name there, so a drive-absolute path like `C:/…/rm.exe` is the drive `C:`
  // plus a `/switch`, not a path) or a `=` (cmd has no `NAME=value cmd`). Either
  // way the name is not what a basename would make it, so it is refused rather
  // than classified — and never scoped to a bare drive.
  if (seg.ambiguousCmdName !== undefined) {
    return `cmd.exe reads a "/" or "=" inside "${seg.ambiguousCmdName}" as ending the command name, so this classifier cannot tell which program would run. Name the program as a plain command, or describe the work as a task.`;
  }
  if (REFUSED_COMMANDS.includes(seg.binary)) {
    return `"${seg.binary}" modifies state. You are a read-only planner: ${EFFECT_ROUTE}`;
  }
  const runs = REFUSED_RUNNERS[seg.binary];
  if (runs) {
    return `"${seg.binary}" ${runs}, which this classifier cannot inspect. Run the inner command directly, or describe it as a task.`;
  }
  // `eval`/`exec` exist only to run a string as a command — the whole point of
  // this classifier is to inspect those strings, so they are never promptable.
  if (seg.binary === 'eval' || seg.binary === 'exec') {
    return `"${seg.binary}" runs a string as a command, which this classifier cannot inspect. Use the read-only research tools, or describe it as a task.`;
  }
  // `source`/`.` run a file's contents as commands the same way `eval` runs a
  // string — refused outright rather than left at `ask`, where an unclassified
  // binary's grant scope collapses to the bare name and one approved script
  // covers every other script sourced in the session.
  if (seg.binary === 'source' || seg.binary === '.') {
    return `"${seg.binary}" runs a file's contents as commands, which this classifier cannot inspect. Use the read-only research tools, or describe it as a task.`;
  }
  // `enable -f lib.so name` loads a shared object into the shell, which runs
  // its code on load — a program from the repository, as `source` would run a
  // script. Plain `enable` only lists or toggles builtins.
  if (seg.binary === 'enable' && seg.args.some((a) => /^-[a-zA-Z]*f/.test(a) || mayBecomeFlag(seg, a))) {
    return `"enable -f" loads a shared library into the shell, which runs its code. Use the read-only research tools, or describe it as a task.`;
  }
  // A shell keyword or compound-command opener (`{`, `if`, `time`, `for`, ...)
  // becomes `seg.binary` the same way an ordinary program name would, which
  // leaves the command it actually introduces sitting as an unclassified
  // argument — `if rm -rf src; then :; fi` really does run `rm -rf src`,
  // because the clause's command list executes regardless of the condition.
  // `(`/`)` are not in this list: subshell grouping is stripped at lex time,
  // so `(rm -rf /)` already lexes straight to `rm`.
  if (SHELL_KEYWORDS.includes(seg.binary)) {
    return `"${seg.binary}" is a shell keyword or compound-command opener. This classifier only inspects the command that runs first, and a keyword hides the real one from it. Run the inner command directly, or describe it as a task.`;
  }
  const subs = REFUSED_SUBCOMMANDS[seg.binary];
  if (subs) {
    const shifter = subcommandShifter(seg);
    if (shifter !== undefined) {
      const written = [seg.binary, scanFlags(seg)?.operands[0]].filter((w) => w !== undefined).join(' ');
      return `The shell may expand "${shifter}" into several words or none, so "${written}" may run another subcommand than the one written. Spell the words before the subcommand literally, in single quotes where they hold a "*", and re-run.`;
    }
    const sub = subcommandOf(seg);
    // `npm p*` runs `npm publish` once a file of that name exists.
    const refused = sub === undefined ? undefined : subs.find((s) => mayExpandTo(seg, sub, s));
    if (refused) {
      return `"${seg.binary} ${refused}" changes state or reaches outward. You are a read-only planner: ${EFFECT_ROUTE}`;
    }
  }
  // `git branch`/`git tag` are read-only subcommands, but their delete/move
  // flag forms mutate refs. The readonly-subcommand allowlist only inspects
  // the subcommand, so these have to be caught here.
  // bash's `printf -v NAME` assigns a shell variable, `PATH` and `CDPATH`
  // included, which steers every later bare command and `cd` on the line to
  // where no word names. It is the one option printf has, so it is leading:
  // the first word, or a later one should the shell expand those before it to
  // nothing.
  if (seg.binary === 'printf' && leadingWords(seg).some((a) => mayBeginWith(seg, a, '-v'))) {
    return `"printf -v" assigns a shell variable, which can change what a later command or "cd" resolves to. You are a read-only planner: print the text instead.`;
  }
  if (seg.binary === 'git') {
    const sub = subcommandOf(seg);
    const after = gitArgsAfterSubcommand(seg);
    if (sub !== undefined && !GIT_READONLY_SUBCOMMANDS.includes(sub)) {
      const reads = GIT_PROMPTABLE[sub];
      if (!reads) {
        return `"git ${sub}" is not a git subcommand known only to read, so it may write the repository. You are a read-only planner: ${EFFECT_ROUTE}`;
      }
      if (!reads(after, seg)) {
        return `"git ${[sub, ...after].join(' ')}" is not a read-only form of "git ${sub}". You are a read-only planner: ${EFFECT_ROUTE}`;
      }
    }
    if (sub === 'ls-remote' && !namesConfiguredRemote(seg, after)) {
      return `"git ls-remote" given a URL, an address or a path reaches it through git's own transport, which resolves the host itself and follows a redirect, so the origin approval, address guard and pinned connection a web read gets (ADR-0027) cannot hold for it. Name a remote the repository configures, such as "git ls-remote origin", or fetch the page with your web fetch tool.`;
    }
    // The secret check and the grant read the words as written, and the shell
    // sends what they expand to: `$TOKEN` passed as text and left as its value.
    // No ref name holds a `~`, so one is only ever the home directory.
    if (sub === 'ls-remote' && (seg.expandable || seg.globbed || after.some((a) => a.includes('~')))) {
      return `The shell rewrites part of this "git ls-remote" before git sees it (a variable, substitution, glob or "~"), so what it sends the remote, and which repository it lists, cannot be checked for a secret or approved. Write the remote and patterns literally, in single quotes where they hold a "*", and re-run.`;
    }
    if (sub === 'branch' || sub === 'tag') {
      const flag = seg.args.find((a) => ['-D', '-d', '-m', '-M', '--delete', '--move'].includes(a))
        ?? after.find(swallowsRefName)
        ?? after.find((a) => mayBecomeFlag(seg, a));
      if (flag) {
        return `"git ${sub} ${flag}" mutates refs. You are a read-only planner: ${EFFECT_ROUTE}`;
      }
      // The flag forms above are not the only way to write a ref: a bare
      // positional (`git branch foo`, `git tag v1`) creates or moves one with
      // no flag involved at all, which the flag-only check above cannot see.
      // `-l`/`--list` is the one shape where a positional is a filter pattern
      // rather than a ref name, so it stays read-only.
      const listing = seg.args.includes('-l') || seg.args.includes('--list');
      const scan = scanFlags(seg);
      // A word the shell may split may put a ref name where none is written.
      const target = scan?.operands[1] ?? (scan?.spreadAt !== undefined ? seg.args[scan.spreadAt] : undefined);
      if (!listing && target) {
        return `"git ${sub} ${target}" creates or moves a ref. You are a read-only planner: ${EFFECT_ROUTE}`;
      }
    }
  }
  // `find` is auto because listing is read-only, but `-exec`/`-delete` make it
  // run an arbitrary inner command — the exact bypass this classifier exists
  // to close. Refuse rather than prompt: the inner command is unauditable.
  if (seg.binary === 'find') {
    const flag = seg.args.find((a) => FIND_ACTIONS.some((action) => mayExpandTo(seg, a, action)));
    if (flag) {
      return `find with "${flag}" runs an inner command this classifier cannot inspect. Use the read-only research tools on find's output, or describe the change as a task.`;
    }
  }
  // sed and awk carry a program that can run a command or write a file with no
  // flag involved, and jq and yq one that can read the environment or load a
  // file no argument names (see filterPrograms.ts), so the program itself is
  // read. One the shell rewrites first cannot be: a `$` that survives lexing
  // may be an expansion, and which token holds it is not tracked.
  if (SED_FAMILY.includes(seg.binary) || AWK_FAMILY.includes(seg.binary) || JQ_FAMILY.includes(seg.binary)) {
    if (AWK_FAMILY.includes(seg.binary) && seg.args.some((a) => mayExpandTo(seg, a, 'inplace'))) {
      return `"${seg.binary} -i inplace" edits files in place. You are a read-only planner — describe the change as a task instead.`;
    }
    // Their flags are read as written by the program checks below (`sed -i`
    // edits in place), so a word the shell may turn into one is refused first.
    // Not stopped at `--`: `sed -e -- …` hands `-e` the `--`.
    const flag = seg.args.find((a) => mayBecomeFlag(seg, a));
    if (flag !== undefined) return expandedFlagReason(seg.binary, flag);
    const program = SED_FAMILY.includes(seg.binary) ? sedRefusal(seg.binary, seg.args)
      : AWK_FAMILY.includes(seg.binary) ? awkRefusal(seg.binary, seg.args)
        : jqRefusal(seg.binary, seg.args);
    if (program) return program;
    // `seg.expandable` below misses a glob, brace list or bracket, and the
    // program was read as written: with a file named `env`, `jq -n e*` runs
    // `jq -n env`. A rewritten word before it moves it (`-L e*` beside a
    // directory `e` becomes `-L e env`), so every word up to it counts; files
    // after it stay confinement's to judge (ADR-0008).
    if (JQ_FAMILY.includes(seg.binary)) {
      const rewritten = seg.args.slice(0, jqProgramEnd(seg.binary, seg.args) + 1).find((a) => shellRewrites(seg, a));
      if (rewritten !== undefined) {
        return `The shell may rewrite "${rewritten}" before "${seg.binary}" sees it, which can change its program. Put the program in single quotes, name every word before it literally, and re-run.`;
      }
    }
    if (seg.expandable) {
      return `The shell rewrites part of this "${seg.binary}" command before "${seg.binary}" sees it, so its program cannot be inspected. Put the program in single quotes, name files literally, and re-run.`;
    }
  }
  const family = interpreterFamily(seg.binary);
  if (family !== undefined) {
    if (seg.piped) {
      return `Piping into "${seg.binary}" would run code this classifier cannot inspect. Run the producing command on its own and read its output.`;
    }
    if (seg.stdinRedirected) {
      return `Feeding "${seg.binary}" from a redirect, here-document or here-string would run code this classifier cannot inspect. Read the file instead, or describe it as a task.`;
    }
    const inline = seg.args.find((a) => isInlineCodeFlag(family, a) || mayBecomeFlag(seg, a)
      || (shellRewrites(seg, a) && mayBeginWith(seg, a, '/') && ['pwsh', 'powershell', 'cmd'].includes(family)))
      ?? (family === 'deno' ? seg.args.find((a) => a === 'eval') : undefined);
    if (inline !== undefined) {
      return `Inline code via "${seg.binary} ${inline}" is not available to the planner. Use the read-only research tools, or describe it as a task.`;
    }
    // `--import`, `--require`, `--loader` and a script operand all accept one,
    // so any argument holding a `data:` URL is read as code.
    const dataUrl = DATA_URL_RUNTIMES.includes(family) ? seg.args.find((a) => /data:/i.test(a)) : undefined;
    if (dataUrl !== undefined) {
      return `"${seg.binary}" runs the code inside a data: URL, which is inline code this classifier cannot inspect. Use the read-only research tools, or describe it as a task.`;
    }
    const positional = family === 'pwsh' || family === 'powershell' ? pwshPositional(family, seg.args) : undefined;
    if (positional !== undefined) {
      return `"${seg.binary}" runs "${positional}" as PowerShell code, which this classifier cannot inspect. Run a script with -File, or describe it as a task.`;
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
  // The flag allowlist, checked last so a binary refused on its own terms still
  // answers for itself. See {@link FLAG_POLICY}: a permitted binary given a flag
  // that is not known to be read-only is refused rather than prompted, so the
  // flags that run helper programs or write files are closed as a class instead
  // of one at a time.
  const scan = scanFlags(seg);
  if (scan?.rewritten !== undefined) return expandedFlagReason(seg.binary, scan.rewritten);
  if (scan?.unknown) {
    return `"${scan.unknown}" is not a flag this classifier knows to be read-only on "${seg.binary}", and flags on otherwise read-only binaries can run a helper program or write a file. Re-run with read-only flags only, or describe the work as a task.`;
  }
  // `uniq INPUT OUTPUT` writes its second operand. The allowlist cannot see this
  // one, because no flag is involved at all — the write is spelled as a
  // positional argument. Read from the scan rather than filtering the raw
  // arguments, so `uniq -f 1 names.txt` is one operand and not two, and a word
  // the shell may split counts as possibly two: `uniq notes*.txt`.
  if (seg.binary === 'uniq' && scan && (scan.operands.length > 1 || scan.spreadAt !== undefined)) {
    const output = scan.operands.length > 1 ? `its second file argument ("${scan.operands[1]}")` : `a second file the shell may expand "${seg.args[scan.spreadAt ?? 0]}" into`;
    return `"uniq" writes to ${output}. You are a read-only planner — pipe the output instead of naming an output file, or describe the write as a task.`;
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
export function classifyCommand(line: ParsedLine, opts?: PolicyInputs): CommandClassification;
export function classifyCommand(command: string, opts?: CommandPolicyOptions): CommandClassification;
export function classifyCommand(input: string | ParsedLine, opts: CommandPolicyOptions = {}): CommandClassification {
  const line = lineOf(input, opts);
  const { text: trimmed, dialect } = line;
  if (!trimmed) return { tier: 'refuse', scope: '', reason: 'Empty command.' };

  const { segments, unsafeRedirect, processSubstitution, unbalanced, unreadable, arithmetic, switchName, truncated } = line.lexed;

  if (arithmetic) {
    return {
      tier: 'refuse',
      scope: '',
      reason: 'An arithmetic command "(( … ))" is not something this classifier reads — a "<<" inside it is a shift, not a here-document. Run the inner commands directly, or describe the work as a task.',
    };
  }

  if (unreadable) {
    return {
      tier: 'refuse',
      scope: '',
      reason: 'A here-document, comment or ${…} expansion inside a command substitution, or a here-document delimiter holding a $ or backtick, hides where it ends, so this classifier cannot tell what would actually run. Run the inner command on its own.',
    };
  }

  if (switchName !== undefined) {
    return {
      tier: 'refuse',
      scope: '',
      reason: `cmd.exe reads "${switchName}" as a switch, not a command name, and after a ";" or "," as a switch to the command before it. Put a space between a command and its switches, and separate commands with "&".`,
    };
  }

  if (unbalanced) {
    return {
      tier: 'refuse',
      scope: '',
      reason: 'Unterminated quote, command substitution or here-document — this classifier cannot tell what would actually run. Rewrite the command with balanced quotes and every here-document closed.',
    };
  }

  if (truncated) {
    return {
      tier: 'refuse',
      scope: '',
      reason: 'Too many command substitutions for this classifier to read them all. Run fewer at once.',
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
  const nestedWeb = segments.flatMap((seg, i) => seg.nested ? [webCommand(unwrapped[i].seg, opts.trustedWebResolves)] : []).find((web) => web);
  if (nestedWeb) {
    return {
      tier: 'refuse',
      scope: '',
      reason: `A curl or wget command inside a substitution cannot have its startup files disabled safely. ${nestedWeb.effect ? EFFECT_REFUSAL_HINT : `Run it directly, or ${READ_REFUSAL_HINT.charAt(0).toLowerCase()}${READ_REFUSAL_HINT.slice(1)}`}`,
    };
  }

  for (const { seg, wrappers, runner, reason: wrapperReason } of unwrapped) {
    if (wrapperReason) return { tier: 'refuse', scope: '', reason: wrapperReason };
    const web = webCommand(seg, opts.trustedWebResolves);
    if (web && (opts.autonomous || opts.approvalMode === 'deny')) {
      return { tier: 'refuse', scope: '', reason: `curl and wget are refused in Full and allowlist mode. ${web.effect ? EFFECT_REFUSAL_HINT : READ_REFUSAL_HINT}` };
    }
    const allow = opts.allow;
    if (web && allow && web.urls.some((url) => scopeExcluded(allow, `${programName(seg.binary)} ${url.origin}/*`))) {
      return { tier: 'refuse', scope: '', reason: `The web origin is excluded by the planner allowlist. ${READ_REFUSAL_HINT}` };
    }
    // Matched case-insensitively: cmd.exe builtins and the default macOS and
    // Windows filesystems all take `RM` or `Del` for the refused name.
    const reason = refusalFor({ ...seg, binary: programName(seg.binary) }, opts.trustedWebResolves);
    if (reason) return { tier: 'refuse', scope: '', reason: withWrapperNote(reason, wrappers) };
    if (runner && !XARGS_TARGETS.includes(seg.binary)) {
      return {
        tier: 'refuse',
        scope: '',
        reason: `"${runner}" appends arguments to "${seg.binary}" that it reads at run time and this classifier never sees, and an argument can make "${seg.binary}" run a program or write a file. Run it on named files directly, or describe it as a task.`,
      };
    }
  }

  if (unwrapped.some(({ seg }) => programName(seg.binary) === 'wget')
    && wgetVersionCommands(line).includes(undefined)) {
    return { tier: 'refuse', scope: '', reason: `The wget executable cannot be checked safely in this working directory. ${READ_REFUSAL_HINT}` };
  }

  // A runner is never auto: the arguments it appends are the ones the flag
  // allowlist and path confinement would have had to check.
  // The permitted tier stays exact-case, and a re-cased wrapper (`NICE git log`)
  // is not let through to it either: refusal reads names case-insensitively so
  // that it can only grow, and the silent tier must not grow with it.
  const nonAuto = unwrapped.filter((u) => u.runner !== undefined
    || u.wrappers.some((w) => w !== w.toLowerCase())
    || !isAuto(u.seg, line));
  if (nonAuto.length === 0) return { tier: 'auto', scope: '' };

  // A `cd` that asks, or a builtin that can move the shell, is one confinement
  // could not follow, so every path after it on the line was judged from the
  // root, not from wherever the shell went. Under the binary-name scope,
  // approving `cd "$HOME"` once would wave through `cd "$HOME" && cat
  // .ssh/id_rsa` later. Its grant is the line the human read. `command` is
  // left out: `command cd` is unwrapped to `cd`, so what remains is a lookup.
  // A glob that can climb through `..` is held to the line for the same
  // reason: under `cat`, one approval would cover every later file it names.
  // A `cd` that runs silently still picks the repository a remote listing
  // reaches, as `-C` does, so that listing is held to the line too: under its
  // own words, approving `origin` in one repository covered `origin` in every
  // other (ADR-0027). So does a wrapper (`env -C`, `nice`), whose own
  // words never reach a scope, and anything else on the line that asks: it may
  // be a name that moves the shell no list here holds (a cmd.exe drive switch,
  // `cd..`), and its scope keeps only its name.
  const changesDirectory = unwrapped.some(({ seg }) => seg.binary.toLowerCase() === 'cd');
  const lineScoped = nonAuto.some((u) => {
    const name = u.seg.binary.toLowerCase();
    return name === 'cd' || (name !== 'command' && SHELL_STATE_COMMANDS.has(name)) || climbsByGlob(u.seg)
      || (isRemoteListing(u.seg) && (changesDirectory || u.wrappers.length > 0 || nonAuto.length > 1));
  });
  const webUrls = nonAuto.flatMap((u) => webCommand(u.seg, opts.trustedWebResolves)?.urls ?? []);
  const outboundTexts = nonAuto.flatMap((u) => webCommand(u.seg, opts.trustedWebResolves)?.outboundTexts ?? remoteListingTexts(u.seg));
  if (lineScoped && webUrls.length === 0) {
    return { tier: 'ask', scope: trimmed, ...(outboundTexts.length ? { outboundTexts } : {}) };
  }

  // A grant covers only the parts that actually needed one, so
  // `az group list | head` is remembered as `az group`, not the whole line —
  // and under a runner it names the command run, so approving `xargs grep`
  // never covers `xargs cat`.
  const scopes = [...new Set(nonAuto.flatMap((u) => {
    const web = webCommand(u.seg, opts.trustedWebResolves);
    return web ? web.urls.map((url) => `${programName(u.seg.binary)} ${url.origin}/*`)
      : [lineScoped ? trimmed : u.runner ? `${u.runner} ${scopeFor(u.seg)}` : scopeFor(u.seg)];
  }))].sort();
  const scope = scopes.join(' + ');
  const perInvocation = nonAuto.some((u) => webCommand(u.seg, opts.trustedWebResolves)?.perInvocation);
  const allowedBy = opts.allow && !perInvocation && !lineScoped ? allowlistRule(nonAuto, opts.allow, opts.trustedWebResolves) : undefined;
  return {
    tier: 'ask', scope,
    ...(webUrls.length ? { webUrls } : {}),
    ...(outboundTexts.length ? { outboundTexts } : {}),
    ...(scopes.length > 1 && webUrls.length ? { scopes } : {}),
    ...(perInvocation ? { perInvocation } : {}),
    ...(allowedBy ? { allowedBy } : {}),
  };
}

/**
 * The rule covering every part of a command that asks, or undefined. A part
 * is never covered when the words a rule is matched against are not what
 * would run: a runner appends words, the shell computes or globs them, a
 * leading assignment redirects the program (`GH_HOST=… gh issue list` sends
 * the token elsewhere), or a path names a file in place of the program.
 */
function allowlistRule(parts: { seg: Segment; runner?: string }[], allow: PlannerAllowlist, trustedResolves?: ReadonlySet<string>): string | undefined {
  const rules: string[] = [];
  for (const { seg, runner } of parts) {
    if (runner || seg.expandable || seg.globbed || seg.binaryPath !== undefined || seg.assignments.length > 0) return undefined;
    const web = webCommand(seg, trustedResolves);
    if (web) {
      for (const url of web.urls) {
        const rule = commandAllowedBy(allow, { binary: seg.binary, args: [`${url.origin}/*`], scopeWords: 1 });
        if (!rule) return undefined;
        rules.push(rule);
      }
      continue;
    }
    const rule = commandAllowedBy(allow, { binary: seg.binary, args: seg.args, scopeWords: scopeFor(seg).split(' ').length - 1 });
    if (!rule) return undefined;
    rules.push(rule);
  }
  return [...new Set(rules)].join(' + ');
}
