import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { annotation } from './node-test-annotations.mjs';

const reporter = new URL('node-test-annotations.mjs', import.meta.url).href;

const failure = (failureType, cause) => Object.assign(new Error('test failed'), { failureType, cause });

describe('node-test-annotations', () => {
  it('names the failing test, its file relative to the root and its line, with the cause as the message', () => {
    const root = join(tmpdir(), 'repo');
    const line = annotation({ name: 'pulls again, after a pause', file: join(root, 'scripts', 'a.test.mjs'), line: 12, details: { error: failure('testCodeFailure', new Error('expected 2\nreceived 1')) } }, root);
    assert.equal(line, '::error file=scripts/a.test.mjs,line=12,title=pulls again%2C after a pause::expected 2%0Areceived 1\n');
  });

  it('skips a failure that only echoes a subtest\'s', () => {
    assert.equal(annotation({ name: 'suite', details: { error: failure('subtestsFailed', new Error('1 subtest failed')) } }), undefined);
    assert.equal(annotation({ name: 'sibling', details: { error: failure('cancelledByParent', new Error('cancelled')) } }), undefined);
  });

  it('escapes what would end a property or the command early', () => {
    assert.equal(annotation({ name: 'a: b, 100%', details: { error: failure('testCodeFailure', 'plain 50%') } }), '::error title=a%3A b%2C 100%25::plain 50%25\n');
  });

  describe('as a reporter beside spec', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-annotations-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('writes one annotation per failing test and leaves the spec output whole', async () => {
      writeFileSync(join(dir, 'sample.test.mjs'), [
        "import { describe, it } from 'node:test';",
        "describe('outer', () => {",
        "  it('passes', () => {});",
        "  it('breaks', () => { throw new Error('boom'); });",
        '});',
      ].join('\n'));
      const args = ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', 'sample.test.mjs'];
      const { stdout } = await promisify(execFile)(process.execPath, args, { cwd: dir, env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: '' } }).catch((error) => error);
      const annotations = stdout.split('\n').filter((line) => line.startsWith('::error'));
      assert.deepEqual(annotations, ['::error file=sample.test.mjs,line=4,title=breaks::boom']);
      assert.match(stdout, /✖ breaks/);
      assert.match(stdout, /✔ passes/);
    });
  });
});
