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

/**
 * Wrap a command in `script` to allocate the PTY some runners require when
 * headless; `-e` propagates the child's exit code so verification still works.
 *
 * POSIX-only by nature — there is no `script` on Windows, which
 * `HeadlessRunner`'s `hasScriptCmd` probe already discovers, so this is never
 * reached there.
 */
export function wrapWithPty(command: string, args: string[]): { command: string; args: string[] } {
  const inner = [command, ...args].map(posixShellQuote).join(' ');
  return { command: 'script', args: ['-q', '-e', '-f', '-c', inner, '/dev/null'] };
}
