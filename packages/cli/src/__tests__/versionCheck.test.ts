import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import type { PingFetch } from '@ordewell/core';
import { fakeSea } from '@ordewell/core/testing';
import { startCliVersionCheck, startHeadlessVersionCheck } from '../versionCheck';
import { cliVersion } from '../version';

describe('the CLI version check (ADR-0048)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'ordewell-cli-version-check-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const npmCopy = { sea: { sea: null, realpath: (p: string) => p }, entry: join(sep, 'usr', 'lib', 'node_modules', 'ordewell', 'bin', 'ordewell.js') };
  const answering = (latest: string, urls: string[] = []): PingFetch => async (url) => {
    urls.push(url);
    return { status: 200, text: async () => JSON.stringify({ latest }) };
  };

  it('writes the notice on the first start and the update line on a later one, and sends the CLI version', async () => {
    const urls: string[] = [];
    const fetch = answering('999.0.0', urls);
    const stderr: string[] = [];
    const write = { onNotice: (line: string) => stderr.push(line), onUpdate: (line: string) => stderr.push(line) };

    await startCliVersionCheck(write, { stateDir, env: {}, fetch }, npmCopy).settled();
    expect(stderr).toEqual([expect.stringMatching(/^Ordewell checks for a new version once a day/)]);
    expect(urls).toEqual([]);

    const check = startCliVersionCheck(write, { stateDir, env: {}, fetch }, npmCopy);
    await check.settled();
    check.stop();
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get('v')).toBe(cliVersion());
    expect(stderr[1]).toBe(`Ordewell 999.0.0 is out (you have ${cliVersion()}) — run \`ordewell update\``);
  });

  it.each([
    ['a Homebrew binary', { sea: { sea: fakeSea('1.0.0'), execPath: '/opt/homebrew/Cellar/ordewell/1.0.0/bin/ordewell', realpath: (p: string) => p } }, 'run `ordewell update`'],
    ['an installer binary', { sea: { sea: fakeSea('1.0.0'), execPath: '/home/me/.local/bin/ordewell', realpath: (p: string) => p } }, 'run `ordewell update`'],
    ['an npx run', { sea: { sea: null, realpath: (p: string) => p }, entry: join(sep, 'home', 'me', '.npm', '_npx', '0a1b', 'node_modules', 'ordewell', 'bin', 'ordewell.js') }, '`npx ordewell@latest` runs it'],
    ['a source checkout', { sea: { sea: null, realpath: (p: string) => p }, entry: join(sep, 'home', 'me', 'ordewell', 'packages', 'cli', 'dist', 'main.js') }, 'pull and rebuild this checkout'],
  ])('tells %s how to update', async (_, copy, how) => {
    const lines: string[] = [];
    const write = { onNotice: (line: string) => lines.push(line), onUpdate: (line: string) => lines.push(line) };

    await startCliVersionCheck(write, { stateDir, env: {}, fetch: answering('999.0.0') }, copy).settled();
    const check = startCliVersionCheck(write, { stateDir, env: {}, fetch: answering('999.0.0') }, copy);
    await check.settled();
    check.stop();

    expect(lines[1]).toMatch(new RegExp(`^Ordewell 999\\.0\\.0 is out \\(you have [^)]+\\) — ${how.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  });

  describe('for a headless command', () => {
    function terminal(isTTY: boolean) {
      const written: string[] = [];
      return { stderr: { isTTY, write: (text: string) => written.push(text) }, written };
    }

    async function start(stderr: { isTTY: boolean; write: (text: string) => unknown }, now = Date.now()) {
      const check = startHeadlessVersionCheck(stderr, { stateDir, env: {}, fetch: answering('999.0.0'), now: () => now }, npmCopy);
      await check.settled();
      check.stop();
    }

    it('writes the update line to a terminal at most once a day', async () => {
      const { stderr, written } = terminal(true);
      const now = Date.now();

      await start(stderr, now);
      await start(stderr, now + 60_000);
      await start(stderr, now + 2 * 60_000);
      await start(stderr, now + 25 * 60 * 60_000);

      expect(written).toEqual([
        expect.stringMatching(/^Ordewell checks for a new version once a day/),
        `Ordewell 999.0.0 is out (you have ${cliVersion()}) — run \`ordewell update\`\n`,
        `Ordewell 999.0.0 is out (you have ${cliVersion()}) — run \`ordewell update\`\n`,
      ]);
    });

    it('writes no update line to stderr that is not a terminal, and keeps the day for one that is', async () => {
      const piped = terminal(false);
      const now = Date.now();
      await start(piped.stderr, now);
      await start(piped.stderr, now + 60_000);

      expect(piped.written).toEqual([expect.stringMatching(/^Ordewell checks for a new version once a day/)]);

      const tty = terminal(true);
      await start(tty.stderr, now + 2 * 60_000);
      expect(tty.written).toEqual([`Ordewell 999.0.0 is out (you have ${cliVersion()}) — run \`ordewell update\`\n`]);
    });

    it('never writes to stdout', async () => {
      const stdout = vi.spyOn(process.stdout, 'write');
      try {
        const now = Date.now();
        await start(terminal(true).stderr, now);
        await start(terminal(true).stderr, now + 60_000);
        expect(stdout).not.toHaveBeenCalled();
      } finally {
        stdout.mockRestore();
      }
    });
  });

  it('is off under the test environment, which must never reach the network', () => {
    expect(process.env.ORDEWELL_NO_VERSION_CHECK).toBe('1');
    const stderr: string[] = [];
    startCliVersionCheck({ onNotice: (line) => stderr.push(line), onUpdate: (line) => stderr.push(line) }, { stateDir }).stop();
    expect(stderr).toEqual([]);
  });
});
