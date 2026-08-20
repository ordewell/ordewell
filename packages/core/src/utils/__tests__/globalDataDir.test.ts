import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let home = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

describe('global data directory', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-global-'));
  });

  it('points at ~/.ordewell', async () => {
    vi.resetModules();
    const { globalDataDir } = await import('../globalDataDir');
    expect(globalDataDir()).toBe(path.join(home, '.ordewell'));
  });

  it('does nothing when there is no legacy config to migrate', async () => {
    vi.resetModules();
    const { migrateOldConfigDir, globalDataDir } = await import('../globalDataDir');
    migrateOldConfigDir();
    expect(fs.existsSync(globalDataDir())).toBe(false);
  });

  it('does nothing when the new directory already exists', async () => {
    vi.resetModules();
    const { migrateOldConfigDir, globalDataDir } = await import('../globalDataDir');
    const newDir = globalDataDir();
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'fresh.json'), '{}');
    fs.mkdirSync(path.join(home, '.config', 'ordewell'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'ordewell', 'settings.json'), '{"old":1}');

    migrateOldConfigDir();
    expect(fs.existsSync(path.join(newDir, 'fresh.json'))).toBe(true);
    expect(fs.existsSync(path.join(newDir, 'settings.json'))).toBe(false);
  });

  it('copies settings.json and the plugins dir from the legacy config dir', async () => {
    vi.resetModules();
    const { migrateOldConfigDir, globalDataDir } = await import('../globalDataDir');
    const oldDir = path.join(home, '.config', 'ordewell');
    fs.mkdirSync(path.join(oldDir, 'plugins', 'my-runner'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'settings.json'), '{"someFeature":{"enabled":true}}');
    fs.writeFileSync(path.join(oldDir, 'plugins', 'my-runner', 'manifest.json'), '{"name":"x"}');

    migrateOldConfigDir();

    const newDir = globalDataDir();
    expect(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8')).toBe('{"someFeature":{"enabled":true}}');
    expect(fs.readFileSync(path.join(newDir, 'plugins', 'my-runner', 'manifest.json'), 'utf8')).toBe('{"name":"x"}');
  });
});
