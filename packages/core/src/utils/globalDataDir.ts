import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Where Ordewell keeps machine-global data (settings, daemon tokens, caches,
 * user plugins). A single home for everything not tied to a project directory,
 * so per-project state in `.ordewell/` and global state never collide.
 */
export function globalDataDir(): string {
  return path.join(os.homedir(), '.ordewell');
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

let migrated = false;

/**
 * One-time lift of a pre-`.ordewell` install's settings into the new location.
 * Runs only when the legacy `~/.config/ordewell/settings.json` exists and the
 * new dir does not, so a fresh install (or a machine already on the new layout)
 * is a no-op — never overwriting anything the user made after the move.
 */
export function migrateOldConfigDir(): void {
  if (migrated) return;
  migrated = true;

  const oldDir = path.join(os.homedir(), '.config', 'ordewell');
  const oldSettings = path.join(oldDir, 'settings.json');
  if (!fs.existsSync(oldSettings) || fs.existsSync(globalDataDir())) return;

  const newDir = globalDataDir();
  fs.mkdirSync(newDir, { recursive: true });
  fs.copyFileSync(oldSettings, path.join(newDir, 'settings.json'));

  const oldPlugins = path.join(oldDir, 'plugins');
  if (fs.existsSync(oldPlugins)) {
    copyDirSync(oldPlugins, path.join(newDir, 'plugins'));
  }
}