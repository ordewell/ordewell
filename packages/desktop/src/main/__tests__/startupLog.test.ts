import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StartupLog } from '../startupLog';

describe('startup timings', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ordewell-startup-log-'));
    file = join(dir, 'profile', 'startup.log');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('keeps the start of a stalled read and the duration when it finishes, in order', async () => {
    const log = new StartupLog(file);
    log.record('launch', { version: '0.13.1', arch: 'arm64' });
    const finish = log.request('runners.list');
    await log.flush();
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2);
    finish?.(true);
    await log.flush();
    const entries: unknown[] = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(entries).toEqual([
      expect.objectContaining({ stage: 'launch', version: '0.13.1', arch: 'arm64' }),
      expect.objectContaining({ stage: 'request.started', route: 'runners.list' }),
      expect.objectContaining({ stage: 'request.finished', route: 'runners.list', ok: true, durationMs: expect.any(Number) }),
    ]);
  });

  it('does not trace turns or writes', async () => {
    const log = new StartupLog(file);
    expect(log.request('plans.generate')).toBeUndefined();
    expect(log.request('settings.update')).toBeUndefined();
    log.request('sessions.list')?.(false);
    await log.flush();
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('plans.generate');
    expect(text).not.toContain('settings.update');
    expect(text).toContain('"ok":false');
  });

  it('bounds a long-running app and rotates an earlier full log on launch', async () => {
    await mkdir(join(dir, 'profile'));
    const previous = 'x'.repeat(1024 * 1024);
    await writeFile(file, previous);
    const log = new StartupLog(file);
    for (let i = 0; i < 1010; i++) log.record('window.created');
    await log.flush();
    expect(await readFile(`${file}.previous`, 'utf8')).toBe(previous);
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1000);
  });

  it('leaves startup and shutdown usable if the log cannot be written', async () => {
    await mkdir(file, { recursive: true });
    const log = new StartupLog(file);
    log.record('launch');
    log.request('models.list')?.(false);
    await expect(log.flush()).resolves.toBeUndefined();
  });
});
