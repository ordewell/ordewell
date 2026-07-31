import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureDir } from '../utils/fsHelpers';
import type { RunnerPluginManifest, IPluginStore } from './types';

function userPluginsDir(): string {
  return path.join(os.homedir(), '.config', 'ordewell', 'plugins');
}

function isValidManifest(obj: unknown): obj is RunnerPluginManifest {
  if (!obj || typeof obj !== 'object') return false;
  const m = obj as Record<string, unknown>;
  return (
    typeof m.name === 'string' &&
    typeof m.displayName === 'string' &&
    typeof m.description === 'string' &&
    typeof m.version === 'string' &&
    typeof m.runner === 'object' && m.runner !== null &&
    typeof (m.runner as Record<string, unknown>).command === 'string' &&
    Array.isArray((m.runner as Record<string, unknown>).argsTemplate) &&
    typeof m.features === 'object' && m.features !== null &&
    typeof m.modelDiscovery === 'object' && m.modelDiscovery !== null
  );
}

function loadManifestFromDir(dir: string): RunnerPluginManifest | null {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isValidManifest(parsed)) return null;
    return parsed as RunnerPluginManifest;
  } catch {
    return null;
  }
}

function copyDirSync(src: string, dest: string): void {
  ensureDir(dest);
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

function rmDirSync(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rmDirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  }
  fs.rmdirSync(dir);
}

export class FsPluginStore implements IPluginStore {
  getUserPluginsDir(): string {
    return userPluginsDir();
  }

  listUserPluginDirs(): string[] {
    const dir = userPluginsDir();
    if (!fs.existsSync(dir)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  loadManifest(pluginDir: string): RunnerPluginManifest | null {
    return loadManifestFromDir(pluginDir);
  }

  copyDir(sourceDir: string, destDir: string): void {
    copyDirSync(sourceDir, destDir);
  }

  removeDir(dir: string): void {
    rmDirSync(dir);
  }

  ensureDir(dir: string): void {
    ensureDir(dir);
  }

  writeFile(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content);
  }

  readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  dirExists(path: string): boolean {
    return fs.existsSync(path) && fs.statSync(path).isDirectory();
  }

  exists(path: string): boolean {
    return fs.existsSync(path);
  }
}
