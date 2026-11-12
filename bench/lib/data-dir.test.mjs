import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { benchDir, benchRoot, checkedBenchDir, outsideRepo, REPO_ROOT } from './data-dir.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bench-data-dir-'));

describe('the bench data directory', () => {
  const home = path.join(os.tmpdir(), 'home');

  it('is under XDG_DATA_HOME on POSIX, or ~/.local/share without one', () => {
    const xdg = path.join(os.tmpdir(), 'xdg');
    assert.equal(benchRoot({ env: { XDG_DATA_HOME: xdg }, platform: 'linux', home }), path.join(xdg, 'ordewell-bench'));
    assert.equal(benchRoot({ env: {}, platform: 'linux', home }), path.join(home, '.local', 'share', 'ordewell-bench'));
    assert.equal(benchRoot({ env: { XDG_DATA_HOME: 'relative' }, platform: 'darwin', home }), path.join(home, '.local', 'share', 'ordewell-bench'), 'a relative XDG_DATA_HOME is ignored');
  });

  it('is under LOCALAPPDATA on Windows', () => {
    assert.equal(benchRoot({ env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\a' }), 'C:\\Users\\a\\AppData\\Local\\ordewell-bench');
    assert.equal(benchRoot({ env: {}, platform: 'win32', home: 'C:\\Users\\a' }), 'C:\\Users\\a\\AppData\\Local\\ordewell-bench');
  });

  it('is ORDEWELL_BENCH_DIR when set, whatever the platform', () => {
    const own = path.join(os.tmpdir(), 'own');
    for (const platform of ['linux', 'win32']) {
      assert.equal(benchRoot({ env: { ORDEWELL_BENCH_DIR: own, XDG_DATA_HOME: '/x', LOCALAPPDATA: 'C:\\L' }, platform, home }), own);
    }
    assert.equal(benchDir('planner-eval', 'builds', { env: { ORDEWELL_BENCH_DIR: own } }), path.join(own, 'planner-eval', 'builds'));
    assert.equal(benchDir('live', undefined, { env: { ORDEWELL_BENCH_DIR: own } }), path.join(own, 'live'));
  });
});

describe('the repository guard', () => {
  it('refuses the repository, a path in it that does not exist yet, and one reached through a link', (t) => {
    const message = /ORDEWELL_BENCH_DIR/;
    assert.throws(() => outsideRepo(REPO_ROOT), message);
    assert.throws(() => outsideRepo(path.join(REPO_ROOT, 'bench', 'planner-eval', '.results', 'not-yet', 'deeper')), message);
    const outside = tmp();
    const link = path.join(outside, 'link');
    try {
      fs.symlinkSync(REPO_ROOT, link, 'junction');
    } catch {
      t.diagnostic('no symlinks here');
      return;
    }
    assert.throws(() => outsideRepo(path.join(link, 'bench')), message);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("lets a test's own temporary directory through, and a sibling that shares the repository's name as a prefix", () => {
    const dir = tmp();
    assert.equal(outsideRepo(dir), path.resolve(dir));
    assert.equal(outsideRepo(path.join(dir, 'a', 'b')), path.join(dir, 'a', 'b'));
    assert.equal(outsideRepo(`${REPO_ROOT}-sibling`), `${REPO_ROOT}-sibling`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a default that resolves inside the repository, and names the way out', () => {
    const env = { ORDEWELL_BENCH_DIR: path.join(REPO_ROOT, 'out') };
    assert.throws(() => checkedBenchDir('planner-eval', 'builds', { env }), /ORDEWELL_BENCH_DIR/);
    const dir = tmp();
    assert.equal(checkedBenchDir('planner-eval', 'builds', { env: { ORDEWELL_BENCH_DIR: dir } }), path.join(dir, 'planner-eval', 'builds'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
