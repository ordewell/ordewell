import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

export const STATE_DIR = '.ordewell';

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Replace `filePath` with `content` in one step. Writing in place truncates
 * the old bytes first, so a crash, power loss or a full disk mid-write leaves
 * an empty or half-written file where the last good one was — silent loss of
 * the only copy, for a session or a saved plan. The bytes go to a fresh temp
 * file beside the target and a rename swaps it in; within one directory that
 * is atomic, so a reader sees the old file or the new one.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  // Same directory, so the rename stays on one filesystem; random, so the name
  // can never collide with another process writing the same file.
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  fs.writeFileSync(tempPath, content, { flag: 'wx' });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Already gone; the rename error is the one worth reporting.
    }
    throw err;
  }
}

export function getStateDir(baseDir?: string): string {
  return path.join(baseDir ?? process.cwd(), STATE_DIR);
}

const IGNORE_FILE = '.gitignore';

/**
 * Ignores the state directory's contents except `skills/`, so a project's
 * skills are committed and reach every task worktree through git — the
 * bootstrap never links `.ordewell/` (ADR-0013). Plans and sessions stay
 * uncommittable without touching a file the developer wrote; editing their
 * root `.gitignore` would be the intrusive version of this. The file does not
 * un-ignore itself: git still applies an ignored `.gitignore`, and each
 * machine's Ordewell writes its own, so `git status` lists nothing here until
 * a skill exists.
 */
export const STATE_DIR_IGNORE = '*\n!skills/\n!skills/**\n';

/** What 0.14.11 wrote: the rules file carved out, so git listed `.ordewell/`. */
const PREVIOUS_IGNORE = '*\n!.gitignore\n!skills/\n!skills/**\n';

/** What older builds wrote: everything ignored, the rules file included. */
const LEGACY_IGNORES = new Set(['*', '*\n']);

/** True when git tracks the file; false outside a repository or when git is missing. */
function isTrackedByGit(file: string): boolean {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path.basename(file)], {
      cwd: path.dirname(file), env, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent, and never overwrites a file the developer customised (to commit
 * their plans deliberately, say). Only text a build generated is upgraded, and the
 * previous text only while git does not track it (rewriting a tracked file
 * would show as a modification).
 */
export function ensureStateDirIgnored(baseDir?: string): void {
  const dir = getStateDir(baseDir);
  ensureDir(dir);
  const file = path.join(dir, IGNORE_FILE);
  try {
    // `wx` rather than an existsSync check: two surfaces can save concurrently,
    // and the loser of that race must not clobber the winner's file.
    fs.writeFileSync(file, STATE_DIR_IGNORE, { flag: 'wx' });
    return;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const current = fs.readFileSync(file, 'utf8');
  if (LEGACY_IGNORES.has(current) || (current === PREVIOUS_IGNORE && !isTrackedByGit(file))) {
    fs.writeFileSync(file, STATE_DIR_IGNORE);
  }
}
