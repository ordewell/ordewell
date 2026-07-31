import * as fsSync from 'fs';
import * as path from 'path';
import { buildShellInvocation } from './shell';
import { augmentedPath } from './shellPath';

/**
 * How a runner or planner CLI is started on this operating system.
 *
 * Every surface that starts an external agent — the VS Code terminal, the
 * headless runner, each harness-planner adapter, Codex model discovery — asks
 * this module rather than deciding for itself. Before it existed, four call
 * sites each did `spawn('claude', args)`, which is correct on POSIX (execvp
 * searches PATH) and broken on Windows, where CreateProcess performs no PATHEXT
 * lookup: an npm-installed `claude` is `claude.cmd`, so the spawn failed with
 * ENOENT while `RunnerInstallation`'s `exec` probe — which does go through
 * cmd.exe — reported the runner installed and healthy.
 *
 * Every path operation in the Windows branch goes through `path.win32`
 * explicitly rather than the host-flavoured `path`. On a real Windows host they
 * are the same object, so production is unaffected — but it makes the Windows
 * logic independent of where the process runs, which is the only way the
 * behavior can be pinned by a test on a Linux CI box. Host `path` is used for
 * nothing here.
 *
 * There are three Windows routes, tried in this order because it is the order
 * that gets to a directly-spawnable file soonest: a native `.exe`, a `.cmd`
 * shim through cmd.exe, a `.ps1` shim through `powershell.exe -File`. The
 * ordering is what keeps the common case off an interpreter, and off the
 * 8191-character buffer cmd.exe brings with it.
 *
 * The batch route is skipped outright for a multi-line argument: cmd.exe stops
 * reading at the first line break and discards the rest without an error — see
 * {@link EmbeddedNewlineError}.
 *
 * `-File` is chosen over `-Command` for the PowerShell tier because it evaluates
 * nothing: the script path and the arguments after it are strings, so a prompt
 * containing `$(…)` is data rather than PowerShell source. Argument fidelity
 * there — embedded newlines, backticks, `%VAR%` — is verified on a Windows host.
 *
 * POSIX behavior is deliberately identity. `planDirectLaunch` hands back the
 * command and args untouched, and `planShellLaunch` produces exactly the
 * `bash -lc` invocation it always did, so nothing about macOS or Linux changes.
 * All of the machinery below is reached only when `platform === 'win32'`.
 */

/** Extensions CreateProcess can start on its own, in preference order. */
const DIRECT_EXTENSIONS = ['.exe', '.com'];

/**
 * Extensions only a command interpreter can start. Node refuses to spawn these
 * without `shell: true` (CVE-2024-27980), so they route through cmd.exe.
 */
const BATCH_EXTENSIONS = ['.cmd', '.bat'];

/**
 * Extensions only PowerShell can start. Reached last, and only when neither a
 * native executable nor a batch shim exists.
 *
 * Every Node package manager that writes a `.ps1` shim writes a `.cmd` beside
 * it, so on those installs this tier is never selected — it is here for the
 * install shapes that do not: a PowerShell installer that dropped a script
 * rather than a binary, a hand-rolled shim, a tool distributed as a module.
 * The alternative for those is a bare `spawn ENOENT` naming a command the user
 * can plainly see is installed.
 *
 * `.ps1` is deliberately not filtered against PATHEXT. Windows' default
 * PATHEXT does not list it — PowerShell resolves scripts itself rather than
 * through CreateProcess — so honouring PATHEXT here would exclude the tier on
 * exactly the machines it exists for.
 */
const POWERSHELL_EXTENSIONS = ['.ps1'];

/**
 * cmd.exe's command-line buffer. A longer line is truncated rather than
 * rejected, which would corrupt a planner's system prompt or a task's prompt
 * mid-sentence and produce a confident answer to half a question — so the
 * batch route refuses instead. See {@link CommandLineTooLongError}.
 */
export const CMD_EXE_MAX_COMMAND_LINE = 8191;

/**
 * CreateProcess's own ceiling, which the native and PowerShell routes are
 * bounded by instead. Windows truncates here too, so the same refusal applies —
 * it is simply four times further away.
 */
export const WINDOWS_MAX_COMMAND_LINE = 32767;

export interface LaunchPlan {
  /** The executable handed to `spawn()` or `vscode.window.createTerminal`. */
  file: string;
  /** Arguments for `file`. Pass verbatim when {@link verbatim} is set. */
  args: string[];
  /**
   * Windows batch route only: `args` is already a quoted command line and must
   * not be re-quoted. Maps to `windowsVerbatimArguments` for `spawn`, and to
   * the string form of `shellArgs` for a VS Code terminal.
   */
  verbatim?: boolean;
}

/** Test seam: every OS touchpoint is injectable, and production uses the defaults. */
export interface LaunchDeps {
  platform?: NodeJS.Platform;
  /** The PATH executables are looked up on. Defaults to the augmented PATH. */
  resolvePath?: () => Promise<string>;
  /** True when `candidate` names an existing file. */
  exists?: (candidate: string) => boolean;
  /** Absolute path to the Windows command interpreter. */
  comSpec?: () => string;
  /** Absolute path to Windows PowerShell. */
  powerShell?: () => string;
  /** PATHEXT, as the environment reports it. */
  pathExt?: () => string;
}

/**
 * Windows PowerShell's fixed location. Resolved absolutely rather than by name
 * because this is a fallback route reached when PATH lookup has already
 * disappointed us once; `powershell.exe` remains as a last resort for a host
 * that does not export SystemRoot.
 */
function defaultPowerShell(): string {
  const root = process.env.SystemRoot || process.env.windir;
  return root
    ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

/**
 * The flags every PowerShell shim invocation carries.
 *
 * `-NoProfile` is not a nicety: a user profile can print a banner into stdout,
 * which for the harness planners is a JSON-RPC stream. `-ExecutionPolicy
 * Bypass` applies to this process only and is what lets a shim run on the
 * default `Restricted` policy at all. `-File` must stay last — everything
 * after it is the script and its arguments.
 */
const POWERSHELL_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

/**
 * Thrown when a command's arguments do not fit the buffer of the only
 * interpreter that can start it. Windows truncates rather than rejecting, and a
 * system prompt cut off mid-sentence makes the planner answer half a question
 * confidently — the silent success this repo refuses — so this is raised
 * instead. `TaskOrchestrator.startTask` catches it and holds the task, so the
 * message is what the user reads: it names the fix, because they cannot infer
 * it from a truncated prompt.
 */
export class CommandLineTooLongError extends Error {
  constructor(readonly command: string, readonly length: number, readonly limit: number = CMD_EXE_MAX_COMMAND_LINE) {
    super(
      limit === CMD_EXE_MAX_COMMAND_LINE
        ? `Cannot start "${command}" on Windows: its arguments are ${length} characters, over cmd.exe's ${limit}-character limit.\n\n` +
          `Only a batch shim (${command}.cmd) was found on PATH, and a shim has to be started through cmd.exe. ` +
          `Install the native executable — Claude Code's Windows installer, Codex's release binary, or OpenCode's install script all provide one — ` +
          `and Ordewell will launch it directly, with no buffer in the way.`
        : `Cannot start "${command}" on Windows: its arguments are ${length} characters, over the ${limit}-character limit Windows places on any command line.\n\n` +
          `This is the OS ceiling rather than a shim's, so no reinstall avoids it. ` +
          `Shorten the task prompt, or turn off some planner mode toggles — each one appends to the system prompt the runner is started with.`,
    );
    this.name = 'CommandLineTooLongError';
  }
}

/**
 * Thrown when only a batch shim resolved for a multi-line argument. cmd.exe
 * reads up to the first CR/LF and discards the rest with no error and exit code
 * 0 — quoting does not help — so the agent would get the first paragraph of its
 * prompt without the completion marker instruction, then exit looking successful.
 */
export class EmbeddedNewlineError extends Error {
  constructor(readonly command: string) {
    super(
      `Cannot start "${command}" on Windows: its prompt spans multiple lines, and the only launcher found on PATH was a batch shim (${command}.cmd).\n\n` +
      `cmd.exe stops reading a command line at the first line break and silently discards the rest, so the agent would be handed a prompt cut off at its first blank line — no plan map, no prior task output, and no completion marker, which is what Ordewell watches for to know the task finished.\n\n` +
      `Install the native executable — Claude Code's Windows installer, Codex's release binary, or OpenCode's install script all provide one — and Ordewell will launch it directly, with no interpreter in the way. A PowerShell shim (${command}.ps1) beside the batch one is also enough.`,
    );
    this.name = 'EmbeddedNewlineError';
  }
}

function hasLineBreak(parts: string[]): boolean {
  return parts.some((part) => /[\r\n]/.test(part));
}

function defaultExists(candidate: string): boolean {
  try {
    return fsSync.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Quote one argument for cmd.exe.
 *
 * The backslash rule is the documented CommandLineToArgvW inverse: a run of
 * backslashes is only doubled when it precedes a quote we are adding or
 * escaping, which is why a trailing `C:\repo\` has to be handled separately
 * from one in the middle of an argument.
 *
 * `%` is NOT escaped, because in a `cmd /c` context it cannot be: `%%` is a
 * batch-file construct, and `^%` still expands. An argument naming a defined
 * environment variable (`%PATH%`) is therefore expanded by cmd.exe on the batch
 * route. Preferring a native executable — which this module always does — skips
 * cmd.exe and the hazard with it.
 */
function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;

  let quoted = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/** The verbatim command line cmd.exe receives after `/d /s /c`, before wrapping. */
export function windowsCommandLine(file: string, args: string[]): string {
  return [file, ...args].map(quoteForCmd).join(' ');
}

/**
 * The `/d /s /c` argument list for a command line, wrapped the one way cmd.exe
 * can be relied on to unwrap.
 *
 * The outer quote pair is not decoration. With `/s`, cmd's documented rule is:
 * if the first character after `/c` is a quote, strip that quote and the *last*
 * quote on the whole line, then take everything between them verbatim. Handing
 * it a bare line whose first token is a quoted path — `"C:\Program
 * Files\nodejs\claude.cmd" -p "go"` — therefore strips the opening quote of the
 * executable and the closing quote of the final argument, leaving cmd to run
 * `C:\Program`. Any user whose name has a space in it hits this on the first
 * task. Wrapping the whole line makes the two quotes cmd removes the two we
 * added, which is what Node's own `shell: true` does for the same reason.
 */
function cmdArgs(line: string): string[] {
  return ['/d', '/s', '/c', `"${line}"`];
}

/**
 * The extensions to try for `command`, in the order that gets us to a
 * directly-spawnable file soonest.
 *
 * Windows itself resolves per-directory (every PATHEXT tried in dir 1 before
 * dir 2), so a `claude.cmd` early on PATH would shadow a `claude.exe` later.
 * This searches by extension class instead — every directory for a `.exe`,
 * then every directory for a `.cmd`. Two installs of the same CLI are the same
 * program, so the global preference never selects a different tool, and it is
 * what keeps the common case off the batch route.
 */
function candidateExtensions(command: string, pathExt: string): Record<Route, string[]> {
  const declared = pathExt.split(path.win32.delimiter).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const known = new Set([...DIRECT_EXTENSIONS, ...BATCH_EXTENSIONS, ...POWERSHELL_EXTENSIONS, ...declared]);
  const ext = path.win32.extname(command).toLowerCase();

  // An explicit extension is a request, not a hint: honour it and search no other.
  if (ext && known.has(ext)) {
    const route: Route = BATCH_EXTENSIONS.includes(ext) ? 'cmd'
      : POWERSHELL_EXTENSIONS.includes(ext) ? 'powershell'
        : 'direct';
    return { direct: [], cmd: [], powershell: [], [route]: [''] };
  }

  const declaredOr = (extensions: string[]) => {
    const filtered = extensions.filter((e) => declared.length === 0 || declared.includes(e));
    return filtered.length > 0 ? filtered : extensions;
  };
  return {
    direct: declaredOr(DIRECT_EXTENSIONS),
    cmd: declaredOr(BATCH_EXTENSIONS),
    // Not filtered: `.ps1` is absent from Windows' default PATHEXT by design.
    powershell: POWERSHELL_EXTENSIONS,
  };
}

/** How a resolved file has to be started. */
type Route = 'direct' | 'cmd' | 'powershell';

/** Tried in this order — soonest to a directly-spawnable file wins. */
const ROUTES: Route[] = ['direct', 'cmd', 'powershell'];

interface FoundExecutable {
  file: string;
  route: Route;
}

/**
 * Every route `command` can be reached by on this host, best first.
 *
 * All of them rather than just the first, because the best route is not only a
 * function of preference: a batch shim that would overflow cmd.exe's buffer is
 * no route at all, and knowing a PowerShell shim sits beside it is what
 * separates a held task from a running one.
 */
async function findWindowsExecutables(command: string, deps: LaunchDeps): Promise<FoundExecutable[]> {
  const exists = deps.exists ?? defaultExists;
  const pathExt = (deps.pathExt ?? (() => process.env.PATHEXT ?? ''))();
  const byRoute = candidateExtensions(command, pathExt);

  // A command that already names a location is not a PATH lookup.
  const dirs = path.win32.basename(command) !== command
    ? [path.win32.dirname(path.win32.resolve(command))]
    : ((await (deps.resolvePath ?? augmentedPath)()) || '')
      .split(path.win32.delimiter)
      .map((d) => d.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);

  const base = path.win32.basename(command);
  const found: FoundExecutable[] = [];
  for (const route of ROUTES) {
    outer: for (const ext of byRoute[route]) {
      for (const dir of dirs) {
        const candidate = path.win32.join(dir, `${base}${ext}`);
        if (exists(candidate)) {
          found.push({ file: candidate, route });
          break outer;
        }
      }
    }
  }
  return found;
}

/** Why a candidate was rejected: `tooLong` is fatal, `lineBreak` falls through to the next route. */
type Disqualified = { tooLong: number; limit: number } | { lineBreak: true };

function planFor(found: FoundExecutable, args: string[], deps: LaunchDeps): LaunchPlan | Disqualified {
  if (found.route === 'direct') {
    const length = windowsCommandLine(found.file, args).length;
    return length > WINDOWS_MAX_COMMAND_LINE
      ? { tooLong: length, limit: WINDOWS_MAX_COMMAND_LINE }
      : { file: found.file, args };
  }

  if (found.route === 'cmd') {
    if (hasLineBreak([found.file, ...args])) return { lineBreak: true };

    const comSpec = (deps.comSpec ?? (() => process.env.ComSpec || 'cmd.exe'))();
    const cmdLine = cmdArgs(windowsCommandLine(found.file, args));
    // The budget is the line cmd.exe receives, so it is measured after wrapping
    // and with the interpreter's own path in it — not just the inner command.
    const length = [comSpec, ...cmdLine].join(' ').length;
    return length > CMD_EXE_MAX_COMMAND_LINE
      ? { tooLong: length, limit: CMD_EXE_MAX_COMMAND_LINE }
      : { file: comSpec, args: cmdLine, verbatim: true };
  }

  // PowerShell takes an ordinary argument vector, so Node's own quoting applies
  // and nothing here is verbatim. `-File` is the mode with no expression
  // evaluation: the script path and the arguments after it are strings, never
  // PowerShell source, so a prompt containing `$(…)` or a backtick is data.
  const shell = (deps.powerShell ?? defaultPowerShell)();
  const psArgs = [...POWERSHELL_FLAGS, found.file, ...args];
  const length = windowsCommandLine(shell, psArgs).length;
  return length > WINDOWS_MAX_COMMAND_LINE
    ? { tooLong: length, limit: WINDOWS_MAX_COMMAND_LINE }
    : { file: shell, args: psArgs };
}

/**
 * How to start `command` with `args` through `spawn()`, with no shell.
 *
 * POSIX returns its input unchanged — execvp already searches PATH, and adding
 * a resolution step there would be a new way for a working setup to break.
 *
 * Windows resolves the command against PATH × PATHEXT, preferring a native
 * executable (spawned directly) over a batch shim (through cmd.exe) over a
 * PowerShell script shim (through `powershell.exe -File`). A command that
 * resolves to nothing is returned unchanged, so the caller's existing ENOENT —
 * which names what the user typed — is what surfaces rather than a second,
 * vaguer error from here.
 *
 * The tiers are tried in preference order and the first that *fits* wins, with
 * one deliberate exception: an overflowing batch shim does not fall through to
 * PowerShell. Overflow means a very large prompt, which is precisely where
 * `-File` argument fidelity is least worth betting on, and where a clear held
 * task beats a plausibly-mangled one. So capacity does not reorder the tiers —
 * a `.ps1` beside a too-long `.cmd` still raises.
 *
 * A line break does reorder them: cmd.exe cannot carry one at any length, so a
 * `.ps1` beside a `.cmd` wins, and a lone `.cmd` raises.
 *
 * @throws {CommandLineTooLongError} when the selected route's buffer cannot
 * carry the arguments.
 * @throws {EmbeddedNewlineError} when the arguments span lines and only the
 * batch route resolved.
 */
export async function planDirectLaunch(
  command: string,
  args: string[],
  deps: LaunchDeps = {},
): Promise<LaunchPlan> {
  if ((deps.platform ?? process.platform) !== 'win32') return { file: command, args };

  const found = await findWindowsExecutables(command, deps);
  if (found.length === 0) return { file: command, args };

  for (const candidate of found) {
    const plan = planFor(candidate, args, deps);
    if ('lineBreak' in plan) continue;
    if ('tooLong' in plan) throw new CommandLineTooLongError(command, plan.tooLong, plan.limit);
    return plan;
  }
  // Only the batch route declines for a line break, so exhausting the loop means
  // every candidate was that route.
  throw new EmbeddedNewlineError(command);
}

/**
 * How to start `command` for a surface that hands an executable and arguments
 * to a terminal — the VS Code runner today, a Windows TUI later.
 *
 * On POSIX this is the login shell, unchanged: `bash -lc` runs the user's
 * profile, which is how nvm/volta/asdf-managed runner binaries resolve at all.
 * Windows has no login-shell equivalent (its PATH comes from the registry and
 * is already inherited), so it takes the direct route instead. That is not just
 * a simplification: it means the runner's own exit code is the terminal's exit
 * code, rather than a `$LASTEXITCODE` that PowerShell propagates unreliably —
 * and the exit code is half of what {@link VerdictEngine} judges a task on.
 */
export async function planShellLaunch(
  command: string,
  args: string[],
  deps: LaunchDeps = {},
): Promise<LaunchPlan> {
  if ((deps.platform ?? process.platform) === 'win32') return planDirectLaunch(command, args, deps);
  const { shellPath, shellArgs } = buildShellInvocation(command, args);
  return { file: shellPath, args: shellArgs };
}
