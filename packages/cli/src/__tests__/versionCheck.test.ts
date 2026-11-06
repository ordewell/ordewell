import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import type { PingFetch } from '@ordewell/core';
import { fakeSea } from '@ordewell/core/testing';
import { startCliVersionCheck } from '../versionCheck';
import { cliVersion } from '../version';

describe('the CLI version check (ADR-0048)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'ordewell-cli-version-check-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('writes the notice on the first start and the update line on a later one, and sends the CLI version', async () => {
    const urls: string[] = [];
    const fetch: PingFetch = async (url) => {
      urls.push(url);
      return { status: 200, text: async () => '{"latest":"999.0.0"}' };
    };
    const stderr: string[] = [];
    const write = { onNotice: (line: string) => stderr.push(line), onUpdate: (line: string) => stderr.push(line) };

    await startCliVersionCheck(write, { stateDir, env: {}, fetch }).settled();
    expect(stderr).toEqual([expect.stringMatching(/^Ordewell checks for a new version once a day/)]);
    expect(urls).toEqual([]);

    const check = startCliVersionCheck(write, { stateDir, env: {}, fetch });
    await check.settled();
    check.stop();
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get('v')).toBe(cliVersion());
    expect(stderr[1]).toBe('Ordewell 999.0.0 is out — npm i -g ordewell');
  });

  it.each([
    ['a Homebrew install', join(sep, 'opt', 'homebrew', 'Cellar', 'ordewell', '1.0.0', 'bin', 'ordewell'), 'brew upgrade ordewell'],
    ['an installer one', join(sep, 'home', 'me', '.local', 'bin', 'ordewell'), 'curl -fsSL https://ordewell.ai/install.sh | sh'],
  ])('tells the standalone binary from %s to upgrade the way it was installed', async (_, execPath, command) => {
    const urls: string[] = [];
    const fetch: PingFetch = async (url) => {
      urls.push(url);
      return { status: 200, text: async () => '{"latest":"999.0.0"}' };
    };
    const lines: string[] = [];
    const write = { onNotice: (line: string) => lines.push(line), onUpdate: (line: string) => lines.push(line) };
    const sea = { sea: fakeSea('1.0.0'), execPath, realpath: (p: string) => p };

    await startCliVersionCheck(write, { stateDir, env: {}, fetch }, sea).settled();
    const check = startCliVersionCheck(write, { stateDir, env: {}, fetch }, sea);
    await check.settled();
    check.stop();
    expect(new URL(urls[0]).searchParams.get('v')).toBe('1.0.0');
    expect(lines[1]).toBe(`Ordewell 999.0.0 is out — ${command}`);
  });

  it('is off under the test environment, which must never reach the network', () => {
    expect(process.env.ORDEWELL_NO_VERSION_CHECK).toBe('1');
    const stderr: string[] = [];
    startCliVersionCheck({ onNotice: (line) => stderr.push(line), onUpdate: (line) => stderr.push(line) }, { stateDir }).stop();
    expect(stderr).toEqual([]);
  });
});
