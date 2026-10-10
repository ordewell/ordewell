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

import type { ShellDialect } from './researchShell';
import { SHELL_STATE_COMMANDS, dialectFor, lexAll, literalCdTarget, type Segment } from './shellLexer';
import { REFUSED_RUNNERS, XARGS_TARGETS, unwrap } from './commandRunners';
import { FLAG_POLICY, UNIVERSAL_FLAGS, flagLabel, matchFlag, scanFlags, subcommandOf, takesNextToken, valueFlagIn } from './flagPolicy';
import { AWK_FAMILY, SED_FAMILY, awkProgramArgs, awkRefusal, sedProgramArgs, sedRefusal } from './filterPrograms';
import { commandAllowedBy, type PlannerAllowlist } from './plannerAllowlist';

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
 * prompts rather than running silently.
 *
 * Prompting only became the right answer once {@link scopeFor} widened. Under
 * the old scope it would have been remembered as `git ls-remote`, so one
 * approval of the workspace's own remote would have authorised a listing
 * against any host at all — which is the same hole with an approval dialog in
 * front of it. The scope now carries the destination.
 */
export const GIT_READONLY_SUBCOMMANDS = [
  'log', 'status', 'diff', 'show', 'ls-files', 'ls-tree', 'branch', 'tag',
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
  /**
   * `CDPATH` is set in the environment the command will run in. A relative
   * `cd` may then land in a directory the command line never names, so `cd`
   * stops being navigation the classifier can follow.
   */
  cdpathSet?: boolean;
  /** The planner's standing approvals (ADR-0026); an `ask` command they cover carries {@link CommandClassification.allowedBy}. */
  allow?: PlannerAllowlist;
}

export type CommandTier = 'auto' | 'ask' | 'refuse';

export interface CommandClassification {
  tier: CommandTier;
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
export function pathRefs(command: string, opts: CommandPolicyOptions = {}): PathRef[] {
  const dialect = dialectFor(opts.dialect);
  // Lexed exactly as `classifyCommand` lexes it, so a leading newline cannot change what is followed.
  return lexAll(command.trim(), dialect, opts.cdpathSet).segments.flatMap((seg) => {
    const patterns = patternArgs(seg);
    const cwd = seg.cwd ?? [];
    return [...seg.args.filter((_, i) => !patterns.has(i)), ...seg.inputs]
      .flatMap(pathIn)
      .map((path) => ({ path, cwd }));
  });
}

export function pathLikeArgs(command: string, opts: CommandPolicyOptions = {}): string[] {
  return pathRefs(command, opts).map((r) => r.path);
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

/**
 * Indices of `seg.args` that are patterns or filter programs, not paths.
 *
 * Fails closed: a flag outside the binary's declared set might take the next
 * token or not, so past one nothing is called a pattern. Mistaking a path for a
 * pattern would skip confinement; the reverse costs one prompt.
 */
function patternArgs(seg: Segment): Set<number> {
  if (SED_FAMILY.includes(seg.binary)) return new Set(sedProgramArgs(seg.binary, seg.args));
  if (AWK_FAMILY.includes(seg.binary)) return new Set(awkProgramArgs(seg.binary, seg.args));
  const rule = PATTERN_ARGS[seg.binary];
  const spec = FLAG_POLICY[seg.binary];
  if (!rule || !spec) return new Set();

  const booleans = new Set([...(spec.booleans ?? []), ...UNIVERSAL_FLAGS]);
  const values = new Set(spec.values ?? []);
  const found = new Set<number>();
  const operands: number[] = [];
  let patternGiven = false;

  for (let i = 0; i < seg.args.length; i++) {
    const token = seg.args[i];
    if (token === '--' && !spec.expressionArgs) {
      for (let j = i + 1; j < seg.args.length; j++) operands.push(j);
      break;
    }
    if (!/^-./.test(token)) { operands.push(i); continue; }

    const inSubcommand = rule.subcommand !== undefined && seg.args[operands[0]] === rule.subcommand;
    if (inSubcommand && rule.subcommandBooleans?.includes(token)) continue;
    const shape = matchFlag(spec, booleans, values, token);
    if (shape === undefined) return new Set();
    const flag = valueFlagIn(token, booleans, values) ?? flagLabel(token);
    if (rule.leadingUnless?.includes(flag)) patternGiven = true;
    const consumes = shape === 'value' && takesNextToken(seg.args[i + 1]);
    if (rule.flags.includes(flag) && values.has(flag)) found.add(consumes ? i + 1 : i);
    if (consumes) i++;
  }

  if (rule.leadingUnless && !patternGiven) {
    const leading = rule.subcommand
      ? seg.args[operands[0]] === rule.subcommand ? operands[1] : undefined
      : operands[0];
    if (leading !== undefined) found.add(leading);
  }
  return found;
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
 * the flag tables change.
 */
function scopeFor(seg: Segment): string {
  // A program named by its path keeps the path: a grant for `gh` is not one for the repository's `./bin/gh`.
  const name = seg.binaryPath ?? seg.binary;
  if (!MULTIPLEXERS.includes(seg.binary.toLowerCase())) return name;
  const lead: string[] = [];
  for (const arg of seg.args) {
    if (arg.startsWith('-')) break;
    lead.push(arg);
    if (lead.length === SCOPE_LEAD_ARGS) break;
  }
  return [name, ...lead].join(' ');
}

function isAuto(seg: Segment, opts: CommandPolicyOptions): boolean {
  // Navigation is read-only, but only a target the command line spells out, on
  // a line where nothing else can steer it. Its effect on later commands is
  // followed by `followCd`, or ignored in the fallback, where a path judged
  // from the workspace root is never more permissive than from a deeper
  // directory the root contains.
  if (seg.binary === 'cd') return !opts.cdpathSet && !seg.cdSteered && literalCdTarget(seg) !== undefined;
  if (!AUTO_COMMANDS.includes(seg.binary)) return false;
  // `./cat` is whatever file the repository ships under that name, not `cat`.
  if (seg.binaryPath !== undefined) return false;
  // `x=/etc/passwd; cat $x` gives `cat` the lone argument `$x`, which
  // `pathLikeArgs`/`looksLikePath` cannot see is a path at all — the shell
  // resolves it to whatever the variable holds. An auto-tier command whose
  // arguments are not fully visible at classification time is exactly the
  // confinement escape this file exists to close, so treat any variable
  // reference as disqualifying the fast path rather than trying to resolve it.
  if (seg.expandable) return false;
  if (seg.binary !== 'git') return true;
  const sub = subcommandOf(seg);
  return sub !== undefined && GIT_READONLY_SUBCOMMANDS.includes(sub);
}

function refusalFor(seg: Segment): string | undefined {
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
    return `"${seg.binary}" modifies state. You are a read-only planner — describe the change as a task instead, and the runner executing the plan will make it.`;
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
  if (seg.binary === 'enable' && seg.args.some((a) => /^-[a-zA-Z]*f/.test(a))) {
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
    const sub = subcommandOf(seg);
    if (sub && subs.includes(sub)) {
      return `"${seg.binary} ${sub}" changes state or reaches outward. You are a read-only planner — put it in the plan and let the runner do it.`;
    }
  }
  // `git branch`/`git tag` are read-only subcommands, but their delete/move
  // flag forms mutate refs. The readonly-subcommand allowlist only inspects
  // the subcommand, so these have to be caught here.
  if (seg.binary === 'git') {
    const sub = subcommandOf(seg);
    if (sub === 'branch' || sub === 'tag') {
      const flag = seg.args.find((a) => ['-D', '-d', '-m', '-M', '--delete', '--move'].includes(a));
      if (flag) {
        return `"git ${sub} ${flag}" mutates refs. You are a read-only planner — describe the change as a task instead.`;
      }
      // The flag forms above are not the only way to write a ref: a bare
      // positional (`git branch foo`, `git tag v1`) creates or moves one with
      // no flag involved at all, which the flag-only check above cannot see.
      // `-l`/`--list` is the one shape where a positional is a filter pattern
      // rather than a ref name, so it stays read-only.
      const listing = seg.args.includes('-l') || seg.args.includes('--list');
      const scan = scanFlags(seg);
      const target = scan?.operands[1];
      if (!listing && target) {
        return `"git ${sub} ${target}" creates or moves a ref. You are a read-only planner — describe the change as a task instead.`;
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
  // sed and awk carry a program that can run a command or write a file with no
  // flag involved (see filterPrograms.ts), so the program itself is read. One
  // the shell rewrites first cannot be: a `$` that survives lexing may be an
  // expansion, and which token holds it is not tracked.
  if (SED_FAMILY.includes(seg.binary) || AWK_FAMILY.includes(seg.binary)) {
    if (AWK_FAMILY.includes(seg.binary) && seg.args.some((a) => a === 'inplace')) {
      return `"${seg.binary} -i inplace" edits files in place. You are a read-only planner — describe the change as a task instead.`;
    }
    const program = SED_FAMILY.includes(seg.binary) ? sedRefusal(seg.binary, seg.args) : awkRefusal(seg.binary, seg.args);
    if (program) return program;
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
    const inline = seg.args.find((a) => isInlineCodeFlag(family, a))
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
  if (scan?.unknown) {
    return `"${scan.unknown}" is not a flag this classifier knows to be read-only on "${seg.binary}", and flags on otherwise read-only binaries can run a helper program or write a file. Re-run with read-only flags only, or describe the work as a task.`;
  }
  // `uniq INPUT OUTPUT` writes its second operand. The allowlist cannot see this
  // one, because no flag is involved at all — the write is spelled as a
  // positional argument. Read from the scan rather than filtering the raw
  // arguments, so `uniq -f 1 names.txt` is one operand and not two.
  if (seg.binary === 'uniq' && scan && scan.operands.length > 1) {
    return `"uniq" writes to its second file argument ("${scan.operands[1]}"). You are a read-only planner — pipe the output instead of naming an output file, or describe the write as a task.`;
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
  const { segments, unsafeRedirect, processSubstitution, unbalanced, unreadable, arithmetic, switchName, truncated } = lexAll(trimmed, dialect, opts.cdpathSet);

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

  for (const { seg, wrappers, runner, reason: wrapperReason } of unwrapped) {
    if (wrapperReason) return { tier: 'refuse', scope: '', reason: wrapperReason };
    // Matched case-insensitively: cmd.exe builtins and the default macOS and
    // Windows filesystems all take `RM` or `Del` for the refused name.
    const reason = refusalFor({ ...seg, binary: seg.binary.toLowerCase() });
    if (reason) return { tier: 'refuse', scope: '', reason: withWrapperNote(reason, wrappers) };
    if (runner && !XARGS_TARGETS.includes(seg.binary)) {
      return {
        tier: 'refuse',
        scope: '',
        reason: `"${runner}" appends arguments to "${seg.binary}" that it reads at run time and this classifier never sees, and an argument can make "${seg.binary}" run a program or write a file. Run it on named files directly, or describe it as a task.`,
      };
    }
  }

  // A runner is never auto: the arguments it appends are the ones the flag
  // allowlist and path confinement would have had to check.
  // The permitted tier stays exact-case, and a re-cased wrapper (`NICE git log`)
  // is not let through to it either: refusal reads names case-insensitively so
  // that it can only grow, and the silent tier must not grow with it.
  const nonAuto = unwrapped.filter((u) => u.runner !== undefined
    || u.wrappers.some((w) => w !== w.toLowerCase())
    || !isAuto(u.seg, opts));
  if (nonAuto.length === 0) return { tier: 'auto', scope: '' };

  // A `cd` that asks, or a builtin that can move the shell, is one confinement
  // could not follow, so every path after it on the line was judged from the
  // root, not from wherever the shell went. Under the binary-name scope,
  // approving `cd "$HOME"` once would wave through `cd "$HOME" && cat
  // .ssh/id_rsa` later. Its grant is the line the human read. `command` is
  // left out: `command cd` is unwrapped to `cd`, so what remains is a lookup.
  if (nonAuto.some((u) => {
    const name = u.seg.binary.toLowerCase();
    return name === 'cd' || (name !== 'command' && SHELL_STATE_COMMANDS.has(name));
  })) {
    return { tier: 'ask', scope: trimmed };
  }

  // A grant covers only the parts that actually needed one, so
  // `az group list | head` is remembered as `az group`, not the whole line —
  // and under a runner it names the command run, so approving `xargs grep`
  // never covers `xargs cat`.
  const scope = [...new Set(nonAuto.map((u) => (u.runner ? `${u.runner} ${scopeFor(u.seg)}` : scopeFor(u.seg))))]
    .sort().join(' + ');
  const allowedBy = opts.allow ? allowlistRule(nonAuto, opts.allow) : undefined;
  return { tier: 'ask', scope, ...(allowedBy ? { allowedBy } : {}) };
}

/**
 * The rule covering every part of a command that asks, or undefined. A part
 * is never covered when the words a rule is matched against are not what
 * would run: a runner appends words, the shell computes or globs them, a
 * leading assignment redirects the program (`GH_HOST=… gh issue list` sends
 * the token elsewhere), or a path names a file in place of the program.
 */
function allowlistRule(parts: { seg: Segment; runner?: string }[], allow: PlannerAllowlist): string | undefined {
  const rules: string[] = [];
  for (const { seg, runner } of parts) {
    if (runner || seg.expandable || seg.globbed || seg.binaryPath !== undefined || seg.assignments.length > 0) return undefined;
    const rule = commandAllowedBy(allow, { binary: seg.binary, args: seg.args, scopeWords: scopeFor(seg).split(' ').length - 1 });
    if (!rule) return undefined;
    rules.push(rule);
  }
  return [...new Set(rules)].join(' + ');
}
