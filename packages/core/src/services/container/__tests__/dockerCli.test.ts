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

  // Windows is refused before any docker call (containerPreflight), and its
  // spawn starts no shell script in docker's place.
  it.skipIf(process.platform === 'win32')('keeps -1 for a CLI that could not start: one it killed for taking too long is not a missing one', async () => {
    const hung = await cliRunning('exec sleep 30').call(['version'], { timeoutMs: 50 });
    const absent = await new SpawnedDockerCli(async () => join(tmpdir(), 'ordewell-no-such-dir')).call(['version']);

    expect(hung.code).not.toBe(-1);
    expect(hung.code).not.toBe(0);
    expect(absent.code).toBe(-1);
  });

  // Windows is refused before any docker call (containerPreflight), and starts
  // no script as `docker`: only a native `docker.exe`. How a handed name beats a
  // host variable in another case there is withPath's, and its test's.
  it.skipIf(process.platform === 'win32')('hands what `-e NAME` names to the CLI in its environment, for a call and an entry alike (ADR-0022 A5)', async () => {
    const cli = cliRunning('printf "%s|%s" "$ORDEWELL_HANDED" "$*"');

    const called = await cli.call(['exec', '-e', 'ORDEWELL_HANDED', 'box'], { env: { ORDEWELL_HANDED: 'by-call' } });
    const entry = await cli.entry(['run', '-e', 'ORDEWELL_HANDED', 'image'], { env: { ORDEWELL_HANDED: 'by-entry' } });
    const said = await new Promise<string>((resolve) => {
      let out = '';
      entry.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      entry.once('close', () => resolve(out));
    });

    expect(called.stdout).toBe('by-call|exec -e ORDEWELL_HANDED box');
    expect(said).toBe('by-entry|run -e ORDEWELL_HANDED image');
  });
});
