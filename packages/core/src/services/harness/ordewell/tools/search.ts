import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { envValue } from '../../../../utils/shellPath';

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Null when the program could not be started (not installed). */
  code: number | null;
}

const SEARCH_TIMEOUT_MS = 30_000;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;

/** Runs a search program without a shell, so a pattern is never parsed as a command (the reason ripgrepArgs.ts returns arrays). */
export function runSearch(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Node throws some spawn errnos (a cwd that is a file) instead of calling back; one tool call must not take the loop down.
    try {
      execFile(file, args, { cwd: opts.cwd, env: opts.env, timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_SEARCH_BYTES, encoding: 'utf8', signal: opts.signal, windowsHide: true }, (err, stdout, stderr) => {
        const errno = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        if (errno && (errno.code === 'ENOENT' || errno.code === 'EACCES')) return resolve({ stdout: '', stderr: errno.message, code: null });
        const code = errno ? (typeof errno.code === 'number' ? errno.code : 1) : 0;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      });
    } catch (err) {
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null });
    }
  });
}

const rgProbes = new Map<string, Promise<boolean>>();

/** Whether `rg` runs under this PATH. The answer is kept per PATH: installing ripgrep mid-run is rare, and each call would otherwise pay a spawn. */
export function hasRipgrep(env: NodeJS.ProcessEnv, cwd: string): Promise<boolean> {
  const key = envValue(env, 'PATH') ?? '';
  let probe = rgProbes.get(key);
  if (!probe) {
    probe = runSearch('rg', ['--version'], { cwd, env, signal: new AbortController().signal }).then((r) => r.code === 0);
    rgProbes.set(key, probe);
  }
  return probe;
}

/**
 * The search path and a directory to anchor it in. ripgrep resolves a `--glob`
 * containing `/` against its cwd, not the search path, and a cwd that is a file
 * is rejected, so a file is anchored at its parent. The root is realpath'd
 * because ripgrep matches an anchored glob against the path as written
 * (ripgrepArgs.ts, VsCodeFileSystem.searchTarget).
 */
export async function searchTarget(abs: string): Promise<{ root: string; anchor: string }> {
  const root = await realpath(abs);
  return { root, anchor: (await stat(root)).isDirectory() ? root : path.dirname(root) };
}
