import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathAssumptions } from './test-path-portability.mjs';

describe('host path comparisons in tests', () => {
  it('rejects a native resolved path compared with its original POSIX spelling (#66 F7)', () => {
    const problems = pathAssumptions("import path from 'node:path'; const ws = path.resolve('/tmp/ws'); expect(ws).toBe('/tmp/ws');");
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Windows/);
  });

  it('allows a comparison in a test explicitly skipped on Windows', () => {
    assert.deepEqual(pathAssumptions("import { resolve } from 'path'; it.skipIf(process.platform === 'win32')('POSIX path', () => { expect(resolve('/tmp/ws')).toBe('/tmp/ws'); });"), []);
  });

  it('recognizes named imports, joined paths and URL-encoded resolved constants', () => {
    for (const source of [
      "import { join as j } from 'path'; expect(j('/repo', 'api')).toEqual('/repo/api');",
      "import * as p from 'node:path'; const ws = p.resolve('/tmp/ws'); expect(encodeURIComponent(ws)).toBe('%2Ftmp%2Fws');",
      "import { resolve } from 'path'; expect('/elsewhere').toStrictEqual(resolve('/elsewhere'));",
    ]) {
      for (const filename of [
        'fixture.test.ts', 'fixture.test.tsx', join('fixtures', 'fixture.test.mjs'),
        'D:\\a\\ordewell\\fixture.test.ts', 'D:\\a\\ordewell\\fixture.test.tsx', 'fixtures\\fixture.test.mjs',
      ]) {
        assert.equal(pathAssumptions(source, filename).length, 1, filename);
      }
    }
  });

  it('allows normalized expectations, explicit POSIX behavior, unrelated names and shadowed constants', () => {
    for (const source of [
      "import path from 'path'; const ws = path.resolve('/tmp/ws'); expect(ws).toBe(path.resolve('/tmp/ws'));",
      "import path from 'path'; expect(path.posix.join('/repo', 'api')).toEqual('/repo/api');",
      "function resolve(s) { return s; } expect(resolve('/tmp/ws')).toBe('/tmp/ws');",
      "import path from 'path'; const ws = path.resolve('/tmp/ws'); function check(ws) { expect(ws).toBe('/tmp/ws'); }",
      "import path from 'path'; expect(path.resolve('/tmp/ws')).not.toBe('/tmp/ws');",
    ]) assert.deepEqual(pathAssumptions(source), [], source);
  });

  it('reports a finding under the caller\'s Windows-form filename (#74)', () => {
    const filename = 'D:\\a\\ordewell\\fixture.test.ts';
    const [problem] = pathAssumptions("import path from 'node:path'; expect(path.resolve('/tmp/ws')).toBe('/tmp/ws');", filename);
    assert.ok(problem.startsWith(`${filename}:1:`), problem);
  });

  it('has no host path comparison assumptions in the repository tests', () => {
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (['node_modules', 'dist', 'dist-test', 'coverage', 'out', '.vscode-test', 'test-results'].includes(entry.name)) return [];
      const file = join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : /\.test\.(ts|tsx|mjs)$/.test(file) ? [file] : [];
    });
    const files = ['packages', 'scripts', 'bench'].flatMap(walk);
    // Windows hands the guard backslash names; the host's own form must not matter.
    for (const form of [(file) => file, (file) => file.replaceAll('/', '\\')]) {
      const problems = files.flatMap((file) => pathAssumptions(readFileSync(file, 'utf8'), form(file)));
      assert.deepEqual(problems, []);
    }
  });
});
