/**
 * Unwrapping the commands that exist to run another command.
 *
 * A segment is classified by what will actually execute, so `timeout 10 env
 * nice rm -rf x` has to be reduced to the `rm` before any tier is consulted.
 */

import { toSegment, type Dialect, type Segment } from './shellLexer';

/**
 * How a wrapper's own arguments are skipped to reach the command it will run.
 *
 * Getting an arity wrong here does not merely mis-parse: the token after the
 * flag is what gets classified, so a value-taking flag mistaken for a boolean
 * makes its *value* look like the command and the real command look like an
 * argument. That is why {@link scanWrapperArgs} refuses a flag it does not
 * recognize instead of guessing at its arity.
 */
export interface WrapperSpec {
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
export const WRAPPER_FAMILY: Record<string, WrapperSpec> = {
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
  // Runs the named shell builtin, so `builtin eval …` is an `eval`. Classified
  // on its own name it only asked, and a grant for `builtin echo` covered it.
  builtin: {},
};

/**
 * cmd.exe wrappers, consulted only under the cmd dialect. `call del x` runs
 * `del`, so classified on `call` it merely asked and the grant was `call`;
 * unwrapped, the real command is judged. `call` takes no options of its own, so
 * like `builtin` its whole tail is the command.
 */
const CMD_WRAPPER_FAMILY: Record<string, WrapperSpec> = {
  call: {},
};

/**
 * cmd.exe's `start` launches a program, optionally behind a quoted window title
 * and its own `/`-switches. Reading that argument grammar wrongly would classify
 * the wrong token as the command, so `start` is refused outright — the inner
 * command can be run directly.
 */
const CMD_REFUSED_RUNNERS: Record<string, string> = {
  start: 'launches a program behind an optional window title and its own switches, which this classifier cannot reliably separate from the command',
};

/**
 * `xargs`'s own flags, walked like a wrapper's. `-e`, `-i` and `-l` take an
 * optional value glued on, so every spelling of them consumes one token. Absent
 * on purpose: `--process-slot-var` sets an environment variable in the command
 * it runs, and `-p`/`-o` hand it the terminal.
 */
const XARGS_SPEC: WrapperSpec = {
  valueFlags: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args',
    '-P', '--max-procs', '-s', '--max-chars'],
  booleanFlags: ['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-x', '--exit',
    '--show-limits', '--eof', '--replace', '--max-lines', ...HELP_FLAGS],
  booleanPattern: /^-[eil]/,
};

/**
 * What `xargs` may run.
 *
 * `xargs` is a wrapper with one difference that decides everything: it appends
 * arguments it reads at run time, after everything this classifier can see. So
 * the command it runs is only as safe as the worst argument it could be handed.
 * `xargs sh < list` runs `sh -c …` if the list says so, `xargs env < list` runs
 * whatever command the list names, `xargs rg foo < list` takes `--pre`, and
 * `xargs uniq < list` writes its second operand.
 *
 * These take no argument that runs a program, writes a file or picks an
 * operation — whatever `xargs` appends is only more to read. Everything else
 * under `xargs` is refused, and what is allowed never runs unprompted: the
 * arguments are still unseen, so neither the flag allowlist nor path
 * confinement has anything to check. The grant's scope names the command,
 * `xargs grep`, so approving one never covers another.
 */
export const XARGS_TARGETS = ['cat', 'head', 'tail', 'wc', 'grep', 'ls', 'stat', 'du', 'basename', 'dirname',
  'realpath', 'echo', 'printf', 'cut', 'nl'];

/**
 * Runners that are refused rather than unwrapped, each for what it does beyond
 * running the command: it hands the command to a shell as a string, or changes
 * what the command runs as, or where, or writes while it runs.
 *
 * Unwrapping is only sound for a runner whose command is a plain argv this
 * classifier lexed. A shell-evaluated template is not, and the rest either
 * change the conditions a command runs under in ways the tiers do not model or
 * can be pointed at a file to write — so each of these, left unlisted, sat on
 * the prompt tier with the command it runs as an unexamined argument, and one
 * approval of the runner covered every later command under it.
 */
export const REFUSED_RUNNERS: Record<string, string> = {
  parallel: 'evaluates its command template in a shell',
  watch: 'joins its arguments into a command line for a shell and reruns it',
  script: 'runs its command through a shell and records the session to a file',
  // A lock file that does not exist yet is created — the same write `touch` is
  // refused for — and `-c` runs a string.
  flock: 'creates its lock file when it is missing and runs a command string under -c',
  sg: 'runs its command through a shell under another group',
  newgrp: 'starts a shell under another group',
  chroot: 'runs a command under another root directory',
  unshare: 'runs a command in new namespaces',
  nsenter: 'runs a command inside another process\'s namespaces',
  setpriv: 'runs a command with changed privileges',
  runuser: 'runs a command as another user',
  pkexec: 'runs a command as another user',
  strace: 'runs a command under a tracer that can write its trace to a file',
  ltrace: 'runs a command under a tracer that can write its trace to a file',
  gdb: 'runs a command under a debugger that can execute arbitrary commands',
  valgrind: 'runs a command under an instrumenter that can write its log to a file',
  taskset: 'runs a command it is handed as arguments',
  chrt: 'runs a command it is handed as arguments',
  numactl: 'runs a command it is handed as arguments',
  prlimit: 'runs a command it is handed as arguments',
  cgexec: 'runs a command it is handed as arguments',
  'systemd-run': 'runs a command as a system service',
  fakeroot: 'runs a command it is handed as arguments',
  firejail: 'runs a command it is handed as arguments',
  bwrap: 'runs a command it is handed as arguments',
  unbuffer: 'runs a command it is handed as arguments',
  caffeinate: 'runs a command it is handed as arguments',
  'sandbox-exec': 'runs a command it is handed as arguments',
};

/**
 * Where a wrapper's own arguments end, or why they cannot be read.
 *
 * `no-exec` means the flags say the wrapper runs nothing, so there is no inner
 * command to find.
 */
export type WrapperScan =
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
export function scanWrapperArgs(binary: string, spec: WrapperSpec, args: string[]): WrapperScan {
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

    // `env` takes any word holding a `=` as an assignment, not only a shell-valid name.
    if (spec.acceptsAssignments && token.includes('=')) { assignments.push(token); i++; continue; }
    if (positionals > 0) { positionals--; i++; continue; }
    break;
  }

  return { kind: 'command', tokens: args.slice(i), assignments };
}

/** A segment reduced to the command that will actually execute. */
export interface Unwrapped {
  seg: Segment;
  /** Wrapper and runner names peeled off, outermost first. Empty when nothing was wrapped. */
  wrappers: string[];
  /**
   * The runner among them that appends arguments this classifier never sees.
   * Its presence caps the tier at `ask` and puts its name in the scope.
   */
  runner?: string;
  /** Set when the wrapper's own arguments are what makes the segment refusable. */
  reason?: string;
}

/**
 * The string `xargs -I`/`-i`/`--replace` substitutes input into, if one was set.
 * `-i` and `--replace` alone mean `{}`.
 */
function xargsReplaceString(flags: string[]): string | undefined {
  let replace: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    const token = flags[i];
    if (token === '-I') replace = flags[++i];
    else if (token.startsWith('-I')) replace = token.slice(2);
    else if (token === '-i' || token === '--replace') replace = '{}';
    else if (token.startsWith('--replace=')) replace = token.slice('--replace='.length);
    else if (/^-i./.test(token)) replace = token.slice(2);
  }
  return replace;
}

/**
 * Peel `xargs` to the command it will run.
 *
 * Piping into it stays refused, as it was when `xargs` was listed among the
 * interpreters: the arguments are another command's output, produced in the
 * same line this classifier is judging.
 */
function unwrapXargs(seg: Segment, dialect: Dialect): { seg: Segment } | { reason: string } {
  if (seg.piped) {
    return { reason: 'Piping into "xargs" turns another command\'s output into arguments this classifier cannot see. Run the producing command on its own and read its output.' };
  }
  const scan = scanWrapperArgs('xargs', XARGS_SPEC, seg.args);
  if (scan.kind === 'refuse') return { reason: scan.reason };
  const command = scan.kind === 'command' ? scan.tokens : [];
  const replace = xargsReplaceString(seg.args.slice(0, seg.args.length - command.length));
  // With no command of its own, xargs runs `echo`.
  const tokens = command.length > 0 ? command : ['echo'];
  if (replace && tokens[0].includes(replace)) {
    return { reason: `"xargs" substitutes its input into "${tokens[0]}", so the input decides which program runs. Name the program directly.` };
  }
  return { seg: { ...toSegment(tokens, false, dialect), expandable: seg.expandable, globbed: seg.globbed } };
}

/**
 * Peel wrappers until the segment names something that is not one.
 *
 * Recursive rather than one-shot because wrappers nest — `timeout 10 env nice
 * rm -rf x` is an `rm` — and peeling a single layer would answer for `env`.
 * Termination is structural: every peel consumes at least the wrapper's own
 * binary token.
 *
 * `piped`, `stdinRedirected`, `expandable` and `globbed` carry through, so piping into a wrapped interpreter
 * is still a pipe into an interpreter, and a wrapped command whose arguments
 * are not fully visible still cannot take the silent fast path.
 */
export function unwrap(seg: Segment, dialect: Dialect): Unwrapped {
  const wrappers: string[] = [];
  // Assignments accumulate across layers instead of staying on the layer that
  // carried them: `env FOO=bar rm -rf x` has to reach `refusalFor` as an `rm`
  // that carries an assignment, which is the shape ticket 06's refusal reads.
  const assignments = [...seg.assignments];
  let current: Segment = seg;
  let runner: string | undefined;
  // cmd.exe is the one dialect whose escape is `^`; its `call`/`start` are
  // builtins, not programs a POSIX shell would run.
  const isCmd = dialect.escape === '^';

  for (;;) {
    if (isCmd) {
      const refused = CMD_REFUSED_RUNNERS[current.binary.toLowerCase()];
      if (refused) return { seg: { ...current, assignments }, wrappers, runner, reason:
        `"${current.binary}" ${refused}. Run the inner command directly, or describe it as a task.` };
    }

    // Once only: `xargs xargs < list` hands the inner one its command from the
    // input, so a second `xargs` is left for XARGS_TARGETS to refuse.
    if (current.binary.toLowerCase() === 'xargs' && runner === undefined) {
      const peeled = unwrapXargs(current, dialect);
      if ('reason' in peeled) return { seg: { ...current, assignments }, wrappers, reason: peeled.reason };
      wrappers.push('xargs');
      runner = 'xargs';
      assignments.push(...peeled.seg.assignments);
      current = { ...peeled.seg, assignments: [] };
      continue;
    }

    const spec = (isCmd ? CMD_WRAPPER_FAMILY[current.binary.toLowerCase()] : undefined)
      ?? WRAPPER_FAMILY[current.binary.toLowerCase()];
    if (!spec) break;
    const scan = scanWrapperArgs(current.binary, spec, current.args);
    if (scan.kind === 'refuse') return { seg: { ...current, assignments }, wrappers, runner, reason: scan.reason };
    // No residual command: the wrapper is the whole invocation (`env` on its
    // own prints the environment), so it is classified under its own name.
    if (scan.kind === 'no-exec' || scan.tokens.length === 0) break;

    assignments.push(...scan.assignments);
    wrappers.push(current.binary);
    const inner = toSegment(scan.tokens, current.piped, dialect);
    assignments.push(...inner.assignments);
    current = { ...inner, assignments: [], expandable: current.expandable, globbed: current.globbed, stdinRedirected: current.stdinRedirected };
  }

  return { seg: { ...current, assignments }, wrappers, runner };
}
