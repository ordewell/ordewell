/**
 * Whether this process is the standalone `ordewell` binary, a Node single
 * executable application (ADR-0065), rather than the npm package run by a Node
 * on PATH. `node:sea` exists only from Node 20.12/21.7, and the npm package
 * still runs on older ones, so its absence means "not the binary".
 *
 * Kept private to the CLI until core's `isSea()` lands; the two must agree.
 */
export function runningAsSea(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a built-in that older Nodes lack
    const sea = require('node:sea') as { isSea(): boolean };
    return sea.isSea();
  } catch {
    return false;
  }
}
