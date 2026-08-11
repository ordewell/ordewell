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
 * A match-everything ignore rule, written *inside* the state directory. A
 * `.gitignore` containing `*` inside a directory excludes that directory's
 * whole contents, itself included, so plans and sessions stop being
 * accidentally committable — without ever touching a file the developer wrote.
 * Editing their root `.gitignore` would be the intrusive version of this.
 *
 * Idempotent, and never overwrites an existing file: a developer who has
 * customised these rules (to commit their plans deliberately, say) keeps them.
 */
export function ensureStateDirIgnored(baseDir?: string): void {
  const dir = getStateDir(baseDir);
  ensureDir(dir);
  try {
    // `wx` rather than an existsSync check: two surfaces can save concurrently,
    // and the loser of that race must not clobber the winner's file.
    fs.writeFileSync(path.join(dir, IGNORE_FILE), '*\n', { flag: 'wx' });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}
