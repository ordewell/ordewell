/**
 * What a surface says while it waits at startup, so the wait has a name
 * rather than a blank skeleton. One source, so the desktop app, VS Code and
 * the terminal UI word each wait alike.
 */

/** The short label a row or a status line carries while the daemon probes for coding agents. */
export const DETECTING_AGENTS = 'Detecting coding agents…';

/**
 * What that probe is doing, for the place that has room for a sentence. The
 * PATH is the login shell's where there is one (`shellPath.ts`), which is
 * the slow part of a first probe.
 */
export const DETECTING_AGENTS_DETAIL = 'Looking for coding agents on your PATH, then asking each one whether it is signed in.';

/** The daemon a window waits for: one this app is starting, or one it is looking for on the port. */
export function daemonWaitLine(port: number, starting: boolean): string {
  return starting
    ? `Starting Ordewell's daemon on port ${port}…`
    : `Connecting to Ordewell's daemon on port ${port}…`;
}

/**
 * How long a daemon start goes unanswered before the wait names the log:
 * the terminal's tenth poll of 500 ms, about five seconds in.
 */
export const DAEMON_STILL_WAITING_MS = 5_000;

/** Said once a start has waited `DAEMON_STILL_WAITING_MS`: what the wait is and where to look. */
export function daemonStillWaitingLine(port: number, logPath: string): string {
  return `Still waiting for the daemon on port ${port} to answer. Its log: ${logPath}`;
}
