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

  it('never overwrites a file that already exists at the new location, checked per file', async () => {
    vi.resetModules();
    const { migrateOldConfigDir, globalDataDir } = await import('../globalDataDir');
    const newDir = globalDataDir();
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'settings.json'), '{"already":"here"}');
    const oldDir = path.join(home, '.config', 'ordewell');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'settings.json'), '{"old":1}');
    fs.writeFileSync(path.join(oldDir, '.env'), 'KEY=old\n');

    migrateOldConfigDir();

    // settings.json already existed at the new location — untouched.
    expect(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8')).toBe('{"already":"here"}');
    // .env did not exist at the new location yet — lifted independently,
    // even though the directory-level "new dir exists" gate has already
    // been tripped by settings.json.
    expect(fs.readFileSync(path.join(newDir, '.env'), 'utf8')).toBe('KEY=old\n');
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
