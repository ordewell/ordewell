import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateTempDir } from '../privateTempDir';
import { ownerOnlyConfigFile } from '../../services/mcp';

/**
 * The directories a runner is handed its files in (ADR-0022 A5, ADR-0010 §1),
 * each kind sweeping its own leftovers; `acpPrivateDir.test.ts` covers a
 * removal Windows refuses.
 */

let temp = '';
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'private-temp-test-'));
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, temp);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temp, { recursive: true, force: true });
});

describe('privateTempDir', () => {
  it('names its directory by kind and maker, holds what it is given, and removes all of it', () => {
    const dir = privateTempDir('claude');
    const file = dir.write('system-prompt.md', 'say "hi"\r\nat %PATH%');

    expect(basename(dir.path)).toMatch(new RegExp(`^ordewell-claude-${process.pid}-[A-Za-z0-9]{6}$`));
    expect(dirname(dir.path)).toBe(temp);
    expect(readFileSync(file, 'utf8')).toBe('say "hi"\r\nat %PATH%');
    dir.remove();
    dir.remove();
    expect(existsSync(dir.path)).toBe(false);
  });

  it('sweeps what a dead Ordewell left of its own kind, and nothing of another kind', () => {
    // A process that has exited, so its id is one no running Ordewell holds.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const leftover = join(temp, `ordewell-mcp-${dead}-AbC123`);
    const other = join(temp, `ordewell-claude-${dead}-AbC123`);
    for (const dir of [leftover, other]) {
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, 'mcp.json'), 'Bearer an-old-token', { mode: 0o600 });
    }

    const config = ownerOnlyConfigFile('mcp.json', '{}');

    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(readdirSync(temp).sort()).toEqual([basename(dirname(config.path)), basename(other)].sort());
    config.remove();
    expect(existsSync(dirname(config.path))).toBe(false);
  });
});
