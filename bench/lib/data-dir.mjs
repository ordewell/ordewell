/**
 * Where a bench harness keeps what a real run produces: transcripts, plans,
 * reports, and the builds of Ordewell it measures. Never inside a repository,
 * ignored or not: a checkout is cloned, archived, worktree'd and deleted, and
 * a real session's text does not belong in any of those.
 *
 *   $ORDEWELL_BENCH_DIR                      when set
 *   $XDG_DATA_HOME/ordewell-bench            else, on POSIX (~/.local/share when unset)
 *   %LOCALAPPDATA%\ordewell-bench            else, on Windows
 *
 * and one subdirectory per harness under it. Offline fixtures, fakes and
 * bundles built from source are not run data and do not come through here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The checkout this module lives in: the working tree no run data may land in. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** The per-user directory for every harness's run data, resolved from `env`. */
export function benchRoot({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.ORDEWELL_BENCH_DIR) return path.resolve(env.ORDEWELL_BENCH_DIR);
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'ordewell-bench');
  // The XDG spec ignores a relative XDG_DATA_HOME.
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return path.join(data, 'ordewell-bench');
}

/** A harness's own directory: `benchDir('planner-eval', 'results')`. */
export const benchDir = (harness, sub, opts) => path.join(benchRoot(opts), harness, ...(sub ? [sub] : []));

/** The real path of `p`, or of its deepest existing ancestor with the rest appended: it may not exist yet. */
function realish(p) {
  const rest = [];
  let at = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(at), ...rest);
    } catch (error) {
      const parent = path.dirname(at);
      if (parent === at) throw error;
      rest.unshift(path.basename(at));
      at = parent;
    }
  }
}

export function isInside(dir, root) {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(fold(realish(root)), fold(realish(dir)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Throws unless `dir` is outside the repository, naming ORDEWELL_BENCH_DIR as the fix.
 * Returns `dir` resolved, so a caller writes `const out = outsideRepo(...)`.
 */
export function outsideRepo(dir, { repo = REPO_ROOT, what = 'output directory' } = {}) {
  const resolved = path.resolve(dir);
  if (isInside(resolved, repo)) {
    throw new Error(
      `refusing to write the ${what} ${resolved} inside the repository ${repo}: a real run's data must not live in a working tree. `
      + `Set ORDEWELL_BENCH_DIR to a directory outside it (default: ${benchRoot({ env: {} })}).`,
    );
  }
  return resolved;
}

/** `benchDir`, refused when it falls inside the repository. */
export const checkedBenchDir = (harness, sub, opts = {}) => outsideRepo(benchDir(harness, sub, opts), { repo: opts.repo, what: `${harness} ${sub ?? 'data'} directory` });
