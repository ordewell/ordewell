import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LINKED_ARTIFACTS } from '../worktreeBootstrap';
import { removeDir } from '../../testing';

const REPO_ROOT = join(__dirname, '../../../../..');
const GITIGNORE = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await removeDir(roots.pop()!);
});

describe('the repository .gitignore', () => {
  // A task worktree gets each artifact bootstrap shares as a symlink to the
  // main checkout. A pattern with a trailing slash matches a directory only,
  // so the link reads as untracked there and `git add -A` stages a link into
  // the main tree. `.envrc` is already written without one for this reason.
  it('ignores every artifact a task worktree links in, as a symlink too', () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-ignore-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, '.gitignore'), GITIGNORE);
    for (const name of LINKED_ARTIFACTS) symlinkSync(REPO_ROOT, join(root, name));

    const notIgnored = [...LINKED_ARTIFACTS].filter((name) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--', name], { cwd: root, stdio: 'ignore' });
        return false;
      } catch {
        return true;
      }
    });

    expect(notIgnored, 'a symlink of this name would show as untracked in a task worktree').toEqual([]);
  });
});
