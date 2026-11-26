import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { augmentedPath, ExecutableNotFoundError, isExecutableResolved, planDirectLaunch, windowsCommandLine, type LaunchDeps } from '@ordewell/core';

/**
 * How a VS Code login terminal is opened so a failed login's output survives.
 *
 * VS Code disposes a transient integrated terminal the moment its own process
 * ends, and a stable terminal API has no stream for its output (ADR-0052, #71):
 * a login that prints an error and exits 3 disappears along with the error. So
 * the login is run as the child of a wrapper shell that, on a nonzero exit,
 * stays alive until the person has read the output and pressed Enter. The
 * wrapper also writes the login's real exit code to a status file, which is the
 * completion signal: while the shell is held open, VS Code sets no exitStatus,
 * so the process's end cannot be read from the terminal alone.
 *
 * The agent is handed to the wrapper as positional parameters (POSIX `"$@"`)
 * or a quoted command line (Windows `windowsCommandLine`), never as text in the
 * script, so an argument holding a shell metacharacter is passed to the agent
 * and never run, and no credential from the workspace environment is echoed or
 * written to disk. The status file holds only a number.
 */

/** What the login would run as, were it the terminal's own process: the resolved file and its argv. */
export interface LoginLaunch {
  shellPath: string;
  shellArgs: string[] | string;
  /** The PATH the file was found on, which the terminal must keep. */
  PATH: string;
}

/** The first file on `PATH` named `command`, as execvp picks it when the probe spawns the agent. */
function onPosixPath(command: string, PATH: string, runnable: (candidate: string) => boolean): string | undefined {
  if (command.includes('/')) return runnable(command) ? command : undefined;
  return PATH.split(path.posix.delimiter).map((d) => d.trim()).filter(Boolean)
    .map((dir) => path.posix.join(dir, command))
    .find(runnable);
}

/** A file execvp would start: there, and executable by this user. */
function runnableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent's own file and arguments, with no shell between (ADR-0010): a shell
 * would find the name again after its startup files ran and could start a
 * different binary than the probe did. On POSIX the first runnable file on the
 * probe's augmented PATH is resolved to an absolute path; on Windows the same
 * routes a spawn takes resolve a native exe, an npm `.cmd` shim's target, or a
 * lone `.cmd` handed to cmd.exe verbatim.
 */
export async function resolveLoginLaunch(
  argv: readonly string[],
  platform: NodeJS.Platform,
  launch: Omit<LaunchDeps, 'platform'>,
): Promise<LoginLaunch> {
  const [command, ...args] = argv;
  const PATH = await (launch.resolvePath ?? augmentedPath)();
  const deps: LaunchDeps = { ...launch, platform, resolvePath: async () => PATH };
  if (platform !== 'win32') {
    const file = onPosixPath(command, PATH, deps.exists ?? runnableFile);
    if (!file) throw new ExecutableNotFoundError(command, PATH);
    return { shellPath: file, shellArgs: args, PATH };
  }
  const plan = await planDirectLaunch(command, args, deps);
  if (!isExecutableResolved(command, plan, PATH, deps)) throw new ExecutableNotFoundError(command, PATH);
  // VS Code takes a string of arguments on Windows as one command line, as is.
  return { shellPath: plan.file, shellArgs: plan.verbatim ? plan.args.join(' ') : plan.args, PATH };
}

export interface LoginTerminalContext {
  runner: string;
  label: string;
  name: string;
  cwd: string;
  /** The workspace environment with its PATH already set by `withPath`. */
  env: Record<string, string>;
  platform: NodeJS.Platform;
  /** Absolute path to cmd.exe; a Windows test pins it from any host. */
  comSpec?: () => string;
  /** Where the status dir is made; a test pins it to observe cleanup. Defaults to os.tmpdir(). */
  tempRoot?: () => string;
  log?: (msg: string) => void;
}

export interface TerminalOptions {
  name: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[] | string;
  env: Record<string, string>;
  isTransient: boolean;
}

/** The terminal options and the status-file lifecycle of one login attempt. */
export interface LoginTerminal {
  readonly options: TerminalOptions;
  readonly statusDir: string;
  readonly statusFile: string;
  /** The exit code the wrapper wrote, cached once read; undefined until the login ends. */
  exitCode(): number | undefined;
  /** Remove the temp resources, once, after the host has read the verdict. */
  cleanup(): boolean;
}

/**
 * A POSIX wrapper, as one `sh -c` script. `$1`/`$2` are the label and runner
 * id (used only in a `printf '%s'` argument, never as shell source); `shift 2`
 * leaves exactly the agent's file and argv in `"$@"`, so a metacharacter in an
 * argument is passed through, not interpreted. The status write is best-effort:
 * a login confirmed by a status poll while it is still running ends the wait
 * before the wrapper exits, and its later write must not print to the terminal.
 */
const POSIX_SCRIPT = [
  'label=$1',
  'runner=$2',
  'shift 2',
  '"$@"',
  'code=$?',
  '{ printf \'%s\\n\' "$code" > "$ORDEWELL_LOGIN_STATUS"; } 2>/dev/null || :',
  'if [ "$code" -ne 0 ]; then',
  '  printf \'\\n%s login failed - exit %s. Read the error above, then press Enter to close this terminal.\\n\' "$label" "$code"',
  '  printf \'Retry with /login %s to recheck sign-in.\\n\' "$runner"',
  '  read -r _ || :',
  'fi',
  'exit "$code"',
].join('\n');

/** A message with no cmd.exe metacharacter, so it can be echoed from a batch block verbatim. */
function failMessage(runner: string): string {
  const safe = runner.replace(/[^A-Za-z0-9_-]/g, '');
  return `Login failed. Read the error above, then press Enter to close this terminal. Retry with /login ${safe} to recheck sign-in.`;
}

/** The command line the Windows wrapper runs: already-quoted argv, or a verbatim cmd.exe line. */
function windowsInnerCommand(launch: LoginLaunch): string {
  return typeof launch.shellArgs === 'string'
    ? `${launch.shellPath} ${launch.shellArgs}`
    : windowsCommandLine(launch.shellPath, launch.shellArgs);
}

/**
 * A Windows wrapper batch file. `goto :done` skips the pause on a zero exit;
 * on failure `pause` holds the terminal (and its output) open. `%ERRORLEVEL%`
 * is read on its own line, so its expansion sees the login's exit, not the
 * batch's parse time.
 */
function windowsBatch(launch: LoginLaunch): string {
  return [
    '@echo off',
    windowsInnerCommand(launch),
    'set "ORDEWELL_LOGIN_CODE=%ERRORLEVEL%"',
    '> "%ORDEWELL_LOGIN_STATUS%" echo %ORDEWELL_LOGIN_CODE%',
    'if "%ORDEWELL_LOGIN_CODE%"=="0" goto :done',
    'echo.',
    'echo %ORDEWELL_LOGIN_FAIL%',
    'pause >nul',
    ':done',
    'exit /b %ORDEWELL_LOGIN_CODE%',
    '',
  ].join('\r\n');
}

function posixOptions(launch: LoginLaunch, ctx: LoginTerminalContext, env: Record<string, string>): TerminalOptions {
  return {
    name: ctx.name,
    cwd: ctx.cwd,
    shellPath: '/bin/sh',
    shellArgs: ['-c', POSIX_SCRIPT, 'ordewell-login', ctx.label, ctx.runner, launch.shellPath, ...(launch.shellArgs as string[])],
    env,
    isTransient: true,
  };
}

function windowsOptions(launch: LoginLaunch, ctx: LoginTerminalContext, statusDir: string, env: Record<string, string>): TerminalOptions {
  const comSpec = ctx.comSpec?.() || process.env.ComSpec || 'cmd.exe';
  const wrapperPath = path.join(statusDir, 'login.cmd');
  fs.writeFileSync(wrapperPath, windowsBatch(launch), { mode: 0o600 });
  // /s unwraps the two outer quotes, leaving the batch file's path quoted for cmd.exe.
  const wrapperLine = windowsCommandLine(wrapperPath, []);
  return {
    name: ctx.name,
    cwd: ctx.cwd,
    shellPath: comSpec,
    shellArgs: ['/d', '/s', '/c', `"${wrapperLine}"`].join(' '),
    env,
    isTransient: true,
  };
}

/** Build the terminal options and allocate the status file one login attempt needs. */
export function buildLoginTerminal(launch: LoginLaunch, ctx: LoginTerminalContext): LoginTerminal {
  const tempRoot = ctx.tempRoot?.() ?? os.tmpdir();
  const statusDir = fs.mkdtempSync(path.join(tempRoot, 'ordewell-login-'));
  const statusFile = path.join(statusDir, 'status');
  const env: Record<string, string> = {
    ...ctx.env,
    ORDEWELL_LOGIN_STATUS: statusFile,
    ...(ctx.platform === 'win32' ? { ORDEWELL_LOGIN_FAIL: failMessage(ctx.runner) } : {}),
  };
  let options: TerminalOptions;
  try {
    options = ctx.platform === 'win32'
      ? windowsOptions(launch, ctx, statusDir, env)
      : posixOptions(launch, ctx, env);
  } catch (err) {
    // A batch file that could not be written leaves a half-made status dir;
    // nothing started, so no close listener will ever remove it.
    fs.rmSync(statusDir, { recursive: true, force: true });
    throw err;
  }

  let cached: number | undefined;
  let cleaned = false;
  return {
    options,
    statusDir,
    statusFile,
    exitCode() {
      if (cached !== undefined) return cached;
      try {
        const raw = fs.readFileSync(statusFile, 'utf8').trim();
        if (/^\d+$/.test(raw)) cached = Number(raw);
      } catch { /* The login has not written its status yet. */ }
      return cached;
    },
    cleanup() {
      if (cleaned) return true;
      try {
        // Windows cmd.exe may hold the batch file open while the terminal is
        // still showing a failed login; the close listener retries when it ends.
        fs.rmSync(statusDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        cleaned = true;
        return true;
      } catch (err) {
        ctx.log?.(`Login status cleanup deferred: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },
  };
}

/**
 * The agent command a POSIX wrapper will run, read back from the options a test
 * captured from `createTerminal`. Windows keeps it in the status dir's batch
 * file, which its own cases read.
 */
export function wrappedCommand(options: { shellPath?: string; shellArgs?: string[] | string }): readonly string[] | undefined {
  if (options.shellPath !== '/bin/sh' || !Array.isArray(options.shellArgs)) return undefined;
  return options.shellArgs.slice(5);
}
