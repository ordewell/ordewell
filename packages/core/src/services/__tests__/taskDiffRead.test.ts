import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { patchFiles, readSavedPatch } from '../taskDiffRead';

/**
 * `task_diff` on a read-only task that saved a patch (ADR-0050): its worktree
 * is gone, so the patch is what it changed, read in the shape a change task's
 * diff has. The patch here is git's own, as the capture writes it.
 */

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout;

/** What the patch's artifact records of it, as the capture writes one. */
const vouching = (patch: Buffer, attempt: number) => ({ attempt, base: 'c'.repeat(40), bytes: patch.length, sha256: createHash('sha256').update(patch).digest('hex') });

describe.skipIf(process.platform === 'win32')('readSavedPatch', () => {
  let repo: string;
  let patch: Buffer;
  let saved: ReturnType<typeof vouching>;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-saved-patch-')));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, 'old name.md'), 'a\nb\nc\nd\ne\n');
    writeFileSync(join(repo, 'gone.txt'), 'bye\n');
    writeFileSync(join(repo, 'run.sh'), 'echo\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    writeFileSync(join(repo, 'a.ts'), 'one\n2\nthree\nfour\n');
    git(repo, 'mv', 'old name.md', 'new\tname.md');
    rmSync(join(repo, 'gone.txt'));
    chmodSync(join(repo, 'run.sh'), 0o755);
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(repo, 'café.md'), 'new\n');
    git(repo, 'add', '-A');
    patch = spawnSync('git', ['diff', '--cached', '--binary', '--full-index', '-M', 'HEAD'], { cwd: repo }).stdout;
    saved = vouching(patch, 2);
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('lists each file the patch changes with its line counts, under where the patch came from', () => {
    const read = readSavedPatch(patch, saved, {});
    expect(read).toEqual({
      available: true,
      text: [
        'The patch attempt 2 saved, against commit cccccccccccc; the task\'s worktree is gone.',
        '[repo .] a.ts: +2 -1',
        '[repo .] blob.bin: binary change',
        '[repo .] café.md: +1 -0',
        '[repo .] gone.txt: +0 -1',
        '[repo .] new\tname.md: +0 -0',
        '[repo .] run.sh: +0 -0',
        '',
      ].join('\n'),
    });
  });

  it("reads one file's part, by the path it ends at", () => {
    const read = readSavedPatch(patch, saved, { path: 'new\tname.md' });
    expect(read.available && read.text).toContain('[repo .] new\tname.md\ndiff --git a/old name.md "b/new\\tname.md"\nsimilarity index 100%\nrename from old name.md\nrename to "new\\tname.md"');
    expect(readSavedPatch(patch, saved, { path: 'café.md' })).toMatchObject({ available: true, text: expect.stringContaining('diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"\nnew file mode 100644') });
    const mode = readSavedPatch(patch, saved, { path: 'run.sh' });
    expect(mode.available && mode.text).toContain('old mode 100644\nnew mode 100755');
  });

  it('says which file it cannot find, which repository it does not have, and a patch no longer kept', () => {
    expect(readSavedPatch(patch, saved, { path: 'nope.ts' })).toEqual({ available: false, reason: expect.stringContaining('No changed file matches "nope.ts"'), cause: 'error' });
    expect(readSavedPatch(patch, saved, { repo: 'web' })).toEqual({ available: false, reason: expect.stringContaining('No repository matches "web"'), cause: 'error' });
    expect(readSavedPatch(undefined, saved, {})).toEqual({ available: false, reason: expect.stringContaining('the patch attempt 2 saved is no longer'), cause: 'error' });
  });

  // The session's directory is one a change task's commands can write, so the file is the task's work only while it is the bytes its artifact records.
  it('shows none of a file that is not the patch that was saved, by its size or its hash', () => {
    const flipped = Buffer.from(patch);
    flipped[flipped.length - 2] ^= 1;

    for (const changed of [flipped, patch.subarray(0, -1)]) {
      expect(readSavedPatch(changed, saved, {})).toEqual({ available: false, reason: expect.stringContaining('has changed since attempt 2 saved it'), cause: 'error' });
      expect(readSavedPatch(changed, saved, { path: 'a.ts' })).toEqual({ available: false, reason: expect.stringContaining('has changed since attempt 2 saved it'), cause: 'error' });
    }
  });
});

describe.skipIf(process.platform === 'win32')('patchFiles', () => {
  let repo: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-patch-files-')));
    git(repo, 'init', '-q');
    symlinkSync('target', join(repo, 'l'));
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const patchOf = () => spawnSync('git', ['diff', '--cached', '--binary', '--full-index', '-M', 'HEAD'], { cwd: repo }).stdout;

  it('lists a file once when the patch changes its type, as git counts it, with both parts under it', () => {
    rmSync(join(repo, 'l'));
    writeFileSync(join(repo, 'l'), 'now a file\n');
    git(repo, 'add', '-A');
    const patch = patchOf();
    expect(patch.toString('utf8').match(/^diff --git /gm)).toHaveLength(2);

    const files = patchFiles(patch);

    expect(files.map(({ path, added, removed }) => ({ path, added, removed }))).toEqual([{ path: 'l', added: '1', removed: '1' }]);
    expect(files[0].section).toContain('deleted file mode 120000');
    expect(files[0].section).toContain('new file mode 100644');
    const read = readSavedPatch(patch, vouching(patch, 1), {});
    expect(read.available && read.text).toContain('[repo .] l: +1 -1\n');
    expect(read.available && read.text.match(/\[repo \.\] l:/g)).toHaveLength(1);
  });

  it('starts a file at a line that begins "diff --git", not at one that has a carriage return before it', () => {
    const patch = Buffer.from('diff --git a/a.ts b/a.ts\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+text\rdiff --git a/b.ts b/b.ts\n');

    expect(patchFiles(patch).map((f) => f.path)).toEqual(['a.ts']);
  });
});
