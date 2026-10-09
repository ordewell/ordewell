import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Where Ordewell keeps machine-global data (settings, daemon tokens, caches,
 * credentials). A single home for everything not tied to a project directory,
 * so per-project state in `.ordewell/` and global state never collide.
 */
export function globalDataDir(): string {
  return path.join(os.homedir(), '.ordewell');
}

let migrated = false;

/**
 * One-time lift of a pre-`.ordewell` install's files into the new location.
 * Each file/dir is checked independently — old exists, new doesn't — rather
 * than gating the whole thing on "new dir doesn't exist yet". A machine that
 * migrated `settings.json` under an earlier release already has `globalDataDir()`
 * on disk, which would otherwise permanently skip lifting anything added to
 * this list later (`.env` did exactly that: real API keys stranded in the old
 * dir because the settings.json move had already made the new dir exist).
 */
export function migrateOldConfigDir(): void {
  if (migrated) return;
  migrated = true;

  const oldDir = path.join(os.homedir(), '.config', 'ordewell');
  if (!fs.existsSync(oldDir)) return;
  const newDir = globalDataDir();

  const liftFile = (name: string): void => {
    const oldFile = path.join(oldDir, name);
    const newFile = path.join(newDir, name);
    if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
      fs.mkdirSync(newDir, { recursive: true });
      fs.copyFileSync(oldFile, newFile);
    }
  };

  liftFile('settings.json');
  liftFile('.env');
}
