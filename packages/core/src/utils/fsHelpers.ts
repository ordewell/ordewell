import * as fs from 'fs';
import * as path from 'path';

export const STATE_DIR = '.ordewell';

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getStateDir(baseDir?: string): string {
  return path.join(baseDir ?? process.cwd(), STATE_DIR);
}

const IGNORE_FILE = '.gitignore';

/**
 * Ignores the state directory's contents except this file and `skills/`, so a
 * project's skills are committed and reach every task worktree through git —
 * the bootstrap never links `.ordewell/` (ADR-0013). Plans and sessions stay
 * uncommittable without touching a file the developer wrote; editing their
 * root `.gitignore` would be the intrusive version of this.
 */
export const STATE_DIR_IGNORE = '*\n!.gitignore\n!skills/\n!skills/**\n';

/** What older builds wrote: everything ignored, the rules file included. */
const LEGACY_IGNORES = new Set(['*', '*\n']);

/**
 * Idempotent, and never overwrites a file the developer customised (to commit
 * their plans deliberately, say). Only the exact legacy rule is upgraded.
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
  if (LEGACY_IGNORES.has(fs.readFileSync(file, 'utf8'))) fs.writeFileSync(file, STATE_DIR_IGNORE);
}
