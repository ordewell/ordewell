// Which release takes GitHub's "latest" mark (ADR-0065 C11). The workflow step
// that runs this script is driven against a fake gh in desktop-release.test.mjs;
// this pins the version order itself.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { compareTags, highestTag, parseTag } from './release-latest.mjs';

describe('compareTags', () => {
  it('orders by semantic version, numerically, not as text', () => {
    const ordered = ['v0.9.0', 'v0.10.0-alpha', 'v0.10.0-alpha.1', 'v0.10.0-alpha.beta', 'v0.10.0-beta', 'v0.10.0-beta.2', 'v0.10.0-beta.11', 'v0.10.0-rc.1', 'v0.10.0', 'v0.10.1', 'v1.0.0', 'v10.0.0'];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        assert.equal(Math.sign(compareTags(ordered[i], ordered[j])), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
      }
    }
  });

  it('ignores the v and build metadata', () => {
    assert.equal(compareTags('v1.2.3', '1.2.3'), 0);
    assert.equal(compareTags('v1.2.3+build.5', 'v1.2.3'), 0);
  });

  it('reads only semantic versions', () => {
    for (const tag of ['latest', 'v1.2', 'v01.2.3', 'v1.2.3-', 'release-1.2.3', '']) assert.equal(parseTag(tag), null, tag);
    assert.throws(() => compareTags('v1.2.3', 'nightly'), /not a version: nightly/);
  });
});

describe('highestTag', () => {
  it('is the tag itself when nothing published is higher', () => {
    assert.equal(highestTag('v0.13.0', ['v0.12.0', 'v0.13.0', 'v0.9.9', '']), 'v0.13.0');
    assert.equal(highestTag('v0.13.0', ['v0.13.0', 'v0.13.0-rc.1']), 'v0.13.0');
  });

  it('is the higher release when an older tag is re-run', () => {
    assert.equal(highestTag('v0.12.1', ['v0.13.0', 'v0.12.1', 'v0.12.0']), 'v0.13.0');
    assert.equal(highestTag('v0.13.0-rc.1', ['v0.13.0-rc.1', 'v0.12.0']), 'v0.13.0-rc.1');
  });

  it('skips a release that is not a version', () => {
    assert.equal(highestTag('v0.13.0', ['nightly', 'v0.13.0', 'desktop-preview']), 'v0.13.0');
  });

  it('refuses a list without the tag, so a short read never makes any tag look the highest', () => {
    assert.throws(() => highestTag('v0.13.0', []), /do not include v0\.13\.0/);
    assert.throws(() => highestTag('v0.13.0', ['v0.12.0']), /do not include v0\.13\.0/);
    assert.throws(() => highestTag('nightly', ['nightly']), /nightly is not a version/);
  });
});

describe('the command line', () => {
  const run = (args, input) => spawnSync(process.execPath, ['scripts/release-latest.mjs', ...args], { input, encoding: 'utf8' });

  it('prints the highest tag read from stdin', () => {
    const out = run(['v0.12.1'], 'v0.12.0\nv0.12.1\nv0.13.0\n');
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, 'v0.13.0\n');
  });

  it('exits 1 on an empty or partial list, and 2 without a tag', () => {
    const empty = run(['v0.13.0'], '');
    assert.equal(empty.status, 1);
    assert.equal(empty.stdout, '');
    assert.match(empty.stderr, /the list is incomplete/);
    assert.equal(run([], 'v0.13.0\n').status, 2);
  });
});
