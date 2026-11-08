// The pinned shellcheck's fetch, against archives the system tar builds and a
// fetcher the test hands in: nothing here reaches the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { fetchShellcheck } from './shellcheck.mjs';

const scratch = [];
const tempDir = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `o67-${label}-`));
  scratch.push(dir);
  return dir;
};
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const VERSION = 'v9.9.9';
const FILE = `shellcheck-${VERSION}.linux.x86_64.tar.gz`;
const BINARY = '#!/bin/sh\necho pinned\n';

// The archive the release ships: shellcheck-<version>/shellcheck beside its notices.
const archive = () => {
  const dir = tempDir('archive');
  mkdirSync(join(dir, `shellcheck-${VERSION}`));
  writeFileSync(join(dir, `shellcheck-${VERSION}`, 'LICENSE.txt'), 'license\n');
  writeFileSync(join(dir, `shellcheck-${VERSION}`, 'shellcheck'), BINARY);
  const made = spawnSync('tar', ['-czf', FILE, `shellcheck-${VERSION}`], { cwd: dir, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return readFileSync(join(dir, FILE));
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pinFor = (bytes) => ({ version: VERSION, archives: { 'linux-x64': { file: FILE, sha256: sha256(bytes) } } });
const noSleep = async () => {};

describe('fetchShellcheck', () => {
  it('refuses an archive whose sha256 is not the pinned one, and caches nothing', async () => {
    const bytes = archive();
    const pin = { version: VERSION, archives: { 'linux-x64': { file: FILE, sha256: '0'.repeat(64) } } };
    const dir = tempDir('tools');
    await assert.rejects(
      fetchShellcheck({ dir, pin, key: 'linux-x64', fetcher: async () => bytes, sleep: noSleep }),
      /sha256/,
    );
    assert.equal(existsSync(join(dir, VERSION, 'linux-x64', 'shellcheck')), false);
  });

  it('fetches, checks and caches the binary, then takes it from the cache without fetching again', async () => {
    const bytes = archive();
    const dir = tempDir('tools');
    let fetches = 0;
    const fetcher = async (url) => {
      fetches++;
      assert.equal(url, `https://github.com/koalaman/shellcheck/releases/download/${VERSION}/${FILE}`);
      return bytes;
    };
    const first = await fetchShellcheck({ dir, pin: pinFor(bytes), key: 'linux-x64', fetcher, sleep: noSleep });
    assert.equal(first, join(dir, VERSION, 'linux-x64', 'shellcheck'));
    assert.equal(readFileSync(first, 'utf8'), BINARY);
    const again = await fetchShellcheck({ dir, pin: pinFor(bytes), key: 'linux-x64', fetcher: async () => assert.fail('a cache hit must not fetch'), sleep: noSleep });
    assert.equal(again, first);
    assert.equal(fetches, 1);
  });

  it('fetches afresh over a cached binary the verified archive does not hold (#71 F6)', async () => {
    const bytes = archive();
    const dir = tempDir('tools');
    const target = join(dir, VERSION, 'linux-x64', 'shellcheck');
    let fetches = 0;
    const fetcher = async () => { fetches++; return bytes; };
    // Substituted bytes, with no archive beside them, as a cache from before the archive was kept.
    mkdirSync(join(dir, VERSION, 'linux-x64'), { recursive: true });
    writeFileSync(target, 'substituted\n');
    assert.equal(await fetchShellcheck({ dir, pin: pinFor(bytes), key: 'linux-x64', fetcher, sleep: noSleep }), target);
    assert.equal(readFileSync(target, 'utf8'), BINARY);
    // Substituted again beside the verified archive.
    writeFileSync(target, 'substituted\n');
    await fetchShellcheck({ dir, pin: pinFor(bytes), key: 'linux-x64', fetcher, sleep: noSleep });
    assert.equal(readFileSync(target, 'utf8'), BINARY);
    // An archive that no longer matches the pin is no proof either.
    writeFileSync(join(dir, VERSION, 'linux-x64', FILE), 'corrupt');
    await fetchShellcheck({ dir, pin: pinFor(bytes), key: 'linux-x64', fetcher, sleep: noSleep });
    assert.equal(fetches, 3);
    // And a pin the cached archive is not refuses it rather than trusting the cache.
    await assert.rejects(
      fetchShellcheck({ dir, pin: { version: VERSION, archives: { 'linux-x64': { file: FILE, sha256: '0'.repeat(64) } } }, key: 'linux-x64', fetcher, sleep: noSleep }),
      /sha256/,
    );
  });

  it('tries a failed download again after a growing wait, and gives up after the last try', async () => {
    const bytes = archive();
    const waits = [];
    let calls = 0;
    const flaky = async () => {
      if (++calls < 3) throw new Error('ECONNRESET');
      return bytes;
    };
    const path = await fetchShellcheck({ dir: tempDir('tools'), pin: pinFor(bytes), key: 'linux-x64', fetcher: flaky, sleep: async (ms) => waits.push(ms) });
    assert.equal(readFileSync(path, 'utf8'), BINARY);
    assert.deepEqual(waits, [1000, 2000]);

    waits.length = 0;
    await assert.rejects(
      fetchShellcheck({ dir: tempDir('tools'), pin: pinFor(bytes), key: 'linux-x64', tries: 3, fetcher: async () => { throw new Error('ECONNRESET'); }, sleep: async (ms) => waits.push(ms) }),
      /after 3 tries: ECONNRESET/,
    );
    assert.deepEqual(waits, [1000, 2000]);
  });

  it('names the platforms it is pinned for when this one is not among them', async () => {
    await assert.rejects(
      fetchShellcheck({ dir: tempDir('tools'), key: 'win32-x64', fetcher: async () => assert.fail('nothing to fetch'), sleep: noSleep }),
      /pinned for linux-x64, linux-arm64, darwin-x64, darwin-arm64, not win32-x64/,
    );
  });
});
