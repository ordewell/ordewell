import type { RunnerPluginManifest, IPluginStore } from '../types';
import { isValidManifest } from '../manifestValidation';

export class InMemoryPluginStore implements IPluginStore {
  private files = new Map<string, string>();
  private dirs = new Set<string>();
  private userPluginsDir_ = '/test/plugins';
  private pluginDirs: string[] = [];

  getUserPluginsDir(): string {
    return this.userPluginsDir_;
  }

  setUserPluginsDir(dir: string): void {
    this.userPluginsDir_ = dir;
  }

  /** Register a subdirectory as a "plugin" that listUserPluginDirs will return. */
  addPluginDir(name: string): void {
    if (!this.pluginDirs.includes(name)) this.pluginDirs.push(name);
  }

  /** Directly set a file in the in-memory store. */
  setFile(p: string, content: string): void {
    this.files.set(p, content);
    // ensure parent dir exists
    const parts = p.replace(/\\/g, '/').split('/');
    for (let i = 1; i < parts.length; i++) {
      this.dirs.add(parts.slice(0, i).join('/'));
    }
  }

  listUserPluginDirs(): string[] {
    return [...this.pluginDirs];
  }

  listDir(dir: string): string[] {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest === '') continue;
      names.add(rest.split('/')[0]);
    }
    return [...names];
  }

  loadManifest(pluginDir: string): RunnerPluginManifest | null {
    const manifestPath = `${pluginDir}/manifest.json`;
    const raw = this.files.get(manifestPath);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return isValidManifest(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  copyDir(sourceDir: string, destDir: string): void {
    for (const [p, content] of this.files) {
      if (p.startsWith(sourceDir + '/') || p === sourceDir) {
        const relative = p.slice(sourceDir.length);
        const destPath = destDir + relative;
        this.files.set(destPath, content);
        // ensure parent dirs exist
        const parts = destPath.replace(/\\/g, '/').split('/');
        for (let i = 1; i < parts.length; i++) {
          this.dirs.add(parts.slice(0, i).join('/'));
        }
      }
    }
  }

  removeDir(dir: string): void {
    for (const p of [...this.files.keys()]) {
      if (p.startsWith(dir + '/') || p === dir) {
        this.files.delete(p);
      }
    }
    this.dirs.delete(dir);
  }

  ensureDir(dir: string): void {
    this.dirs.add(dir);
  }

  writeFile(filePath: string, content: string): void {
    this.files.set(filePath, content);
    const parts = filePath.replace(/\\/g, '/').split('/');
    for (let i = 1; i < parts.length; i++) {
      this.dirs.add(parts.slice(0, i).join('/'));
    }
  }

  readFile(filePath: string): string | null {
    return this.files.get(filePath) ?? null;
  }

  dirExists(p: string): boolean {
    // A "directory" exists if it's in dirs set or if any files are under it
    if (this.dirs.has(p)) return true;
    for (const key of this.files.keys()) {
      if (key.startsWith(p + '/') || key === p) return true;
    }
    return false;
  }

  exists(p: string): boolean {
    if (this.files.has(p)) return true;
    if (this.dirs.has(p)) return true;
    for (const key of this.files.keys()) {
      if (key.startsWith(p + '/') || key === p) return true;
    }
    return false;
  }
}
