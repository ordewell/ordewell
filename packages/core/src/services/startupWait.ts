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
