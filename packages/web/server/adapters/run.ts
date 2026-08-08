import { execFile } from 'child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Cap on a single child's buffered output. Above this, Node kills the child
 * and invokes the callback with `err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`
 * — a string, so the coercion below maps it to `1` (see `run`).
 */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * The single primitive every search/inspection adapter in this package is
 * built on: spawn a child, never reject. Kept in its own module so the
 * contract that the planner depends on — synchronous spawn failures degrade
 * to a failed tool call, never a rejected promise that aborts the whole
 * planner turn — can be pinned by a focused test rather than exercised only
 * incidentally through the public adapter API.
 *
 * Node hands only ENOENT/EAGAIN/EMFILE/ENFILE from spawn(2) to the
 * callback; every other errno — ENOTDIR for a `cwd` that is a file, EACCES
 * for one it cannot enter — is thrown synchronously. Thrown in here that
 * rejects the promise, and no caller of `run` catches, so a single bad
 * search argument aborted the entire planner turn as "Plan generation
 * failed: spawn ENOTDIR". A failed spawn is a failed tool call, never a
 * failed plan.
 */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; timeout: number; shell?: boolean; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, {
        cwd: opts.cwd,
        timeout: opts.timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        shell: opts.shell,
        env: opts.env,
        // Node kills the child when this aborts, and calls back with an
        // ABORT_ERR — which lands on the `code: 1` branch below, i.e. a
        // failed tool call, exactly like any other command that did not
        // finish. Stopping the planner must not leave a research `bash`
        // running out its own timeout on the server.
        signal: opts.signal,
      }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      });
    } catch (err) {
      // `code: null` rather than 1 on purpose: the search adapters read 0 and 1
      // as "ran, possibly no matches", so a 1 here would report a confident
      // "No matches found." for a search that never executed.
      resolve({ stdout: '', stderr: (err as Error).message, code: null });
    }
  });
}