import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SpawnedDockerCli } from '../dockerCli';

describe('SpawnedDockerCli', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  const cliRunning = (script: string): SpawnedDockerCli => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-docker-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'docker'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, 'docker'), 0o755);
    return new SpawnedDockerCli(async () => [dir, process.env.PATH].join(delimiter));
  };

  it('keeps -1 for a CLI that could not start: one it killed for taking too long is not a missing one', async () => {
    const hung = await cliRunning('exec sleep 30').call(['version'], { timeoutMs: 50 });
    const absent = await new SpawnedDockerCli(async () => join(tmpdir(), 'ordewell-no-such-dir')).call(['version']);

    expect(hung.code).not.toBe(-1);
    expect(hung.code).not.toBe(0);
    expect(absent.code).toBe(-1);
  });
});
