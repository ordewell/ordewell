import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removedPluginNotice } from '../removedPluginNotice';
import { RunnerRegistry } from '../RunnerRegistry';

const directories: string[] = [];
function dataDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-removed-runners-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('removedPluginNotice', () => {
  it('is silent without a manifest', () => {
    const directory = dataDir();
    expect(removedPluginNotice(directory)).toBeUndefined();
    fs.mkdirSync(path.join(directory, 'plugins', 'empty'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'plugins', 'notes.txt'), 'keep this');
    expect(removedPluginNotice(directory)).toBeUndefined();
  });

  it('reports multiple leftover manifests as one notice without loading or changing them', () => {
    const directory = dataDir();
    const files = ['custom-runner', 'claude-code'].map((name) => {
      const folder = path.join(directory, 'plugins', name);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, 'manifest.json');
      fs.writeFileSync(file, '{invalid manifest');
      return file;
    });
    expect(removedPluginNotice(directory)).toMatch(/^Plugin runners were removed;.*CHANGELOG\.$/);
    expect(new RunnerRegistry().list().map((entry) => entry.manifest.name)).toEqual(['claude-code', 'codex', 'opencode']);
    for (const file of files) expect(fs.readFileSync(file, 'utf8')).toBe('{invalid manifest');
  });

  it('also detects a manifest directly in the old directory', () => {
    const directory = dataDir();
    fs.mkdirSync(path.join(directory, 'plugins'));
    fs.writeFileSync(path.join(directory, 'plugins', 'manifest.json'), '{}');
    expect(removedPluginNotice(directory)).toBeDefined();
  });

  it('is silent if the old path is unreadable as a directory', () => {
    const directory = dataDir();
    fs.writeFileSync(path.join(directory, 'plugins'), 'not a directory');
    expect(removedPluginNotice(directory)).toBeUndefined();
  });
});
