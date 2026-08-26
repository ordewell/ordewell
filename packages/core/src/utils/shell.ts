// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\r/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function posixShellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a command for execution inside a POSIX login shell, which is what
 * resolves runner binaries managed by nvm/volta/asdf.
 *
 * Deliberately POSIX-only. This used to take a `platform` and emit
 * `powershell.exe -Command "'claude' '-p' '…'"` for Windows, which PowerShell
 * cannot run at all: a quoted string in leading position is parsed in
 * expression mode, so the invocation died with a parse error before the runner
 * started — a task that failed instantly, every time, on that platform. Windows
 * has no login-shell equivalent to emulate (its PATH comes from the registry
 * and is already inherited), so {@link planShellLaunch} starts the runner
 * directly there instead of routing it through a shell. Platform choice belongs
 * to that function; this one only knows how to phrase the POSIX half.
 */
export function buildShellInvocation(
  command: string,
  args: string[],
): { shellPath: string; shellArgs: string[] } {
  const inner = [command, ...args].map(posixShellQuote).join(' ');
  return { shellPath: '/bin/bash', shellArgs: ['-lc', inner] };
}

/** A terminal size in cells. */
export interface PtySize {
  cols: number;
  rows: number;
}

/**
 * Options for {@link wrapWithPty}. `size` sets the PTY's window size before the
 * wrapped command starts. `controlChannel` makes the wrapper listen on its fd 3
 * for `"<cols> <rows>"` lines and resize the PTY live — the caller spawns the
 * child with an extra pipe there and writes resize requests into it.
 */
export interface PtyWrapOptions {
  size?: PtySize;
  controlChannel?: boolean;
}

/**
 * Wrap a command in `script` to allocate the PTY some runners require when
 * headless; `-e` propagates the child's exit code so verification still works.
 *
 * POSIX-only by nature — there is no `script` on Windows, which
 * `HeadlessRunner`'s `hasScriptCmd` probe already discovers, so this is never
 * reached there.
 *
 * `script` sizes its PTY off the terminal it is attached to; spawned off a pipe
 * (every transport here) it allocates 0x0, which a runner TUI renders as
 * garbage. `stty` fixes the size on the PTY slave before the command starts, so
 * the TUI reads its true dimensions via ioctl.
 *
 * The control channel can only live on a *separate* fd from the agent's stdin,
 * so the wrapper saves the PTY on fd 4 first: POSIX sends an asynchronous
 * command's stdin to `/dev/null`, so the watcher's own stdin cannot be the PTY.
 * A background job also inherits an fd 0 that is not the terminal; `stty` names
 * fd 4 explicitly for that reason.
 */
export function wrapWithPty(command: string, args: string[], opts: PtyWrapOptions = {}): { command: string; args: string[] } {
  const inner = [command, ...args].map(posixShellQuote).join(' ');
  const watcher = opts.controlChannel
    ? 'exec 4<&0; ( while read -r C R <&3; do stty cols "$C" rows "$R" <&4; done ) & '
    : '';
  const setup = opts.size ? `stty cols ${opts.size.cols} rows ${opts.size.rows}; ` : '';
  return { command: 'script', args: ['-q', '-e', '-f', '-c', `${watcher}${setup}${inner}`, '/dev/null'] };
}
